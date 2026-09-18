// 语料流水线·解析类装饰器（设计 §4.2）— 4 个 + FallbackDecorator 编排器
//
//   MineruDecorator          PDF → 高质量 Markdown（files.js:272 convertWithMineru）
//   SkillMarkdownDecorator   抽取技能：SKILL.md 指令 + 模型直读 / node 子进程 → Markdown（§5，本设计核心）
//   BuiltinParseDecorator    按扩展名内置解析（files.js:699 parseBuiltin）
//   FallbackDecorator        依次尝试上述候选；不适用/失败则透传给下一个（≡ files.js:591-697 的编排）
//
// 三个候选**同时实现两个接口**（§4.2「接口数量说明」）：
//   · CorpusStream     —— 单独包一条流时用（next() 内部调 apply()）
//   · CorpusTransform  —— 被 FallbackDecorator 编排时用（accepts() / apply()）
// 故这里不继承 CorpusDecorator（它强制要求非空 inner），而是自定义 ParseLayer 基类：
// inner 允许为 null（纯变换器形态，即设计文档示例里的 `new MineruDecorator(null)`）。
//
// ⚠️ 解析实现一律**转发到 raws/files.js**，不在本文件复制一份：
//    两处口径一旦漂移，§14.1 二期验收的「产物与现状 extractFileContent 逐字节等价」就无法成立。
'use strict';

const fs = require('fs');
const path = require('path');
const { CorpusStream } = require('../stream');
const { CorpusDecorator } = require('../decorator');
const { mergeResults } = require('../stream');
const { addProvenance, addWarning, extOfItem } = require('../item');
const { mkAbortErr, isAbort } = require('../drive');
const { num } = require('../../common/config');
const { MINERU_IMAGE_EXTS } = require('../../common/constants');
const { absOf } = require('../sources');

// 内置解析器覆盖的扩展名（与 files.js:699 parseBuiltin 的 switch 一一对应）
const BUILTIN_EXTS = new Set([
  '.md', '.markdown', '.txt', '.csv', '.json', '.log',
  '.html', '.htm', '.pdf', '.docx', '.xlsx', '.xls', '.pptx',
]);

// 脚本抽取技能的正文交接文件名（§5.3 / 不变量 P12）
const SCRIPT_MD_NAME = 'corpus-out.md';

/** 取 item 的本地绝对路径；非 local 来源（url/note/inline/corpus）返回 '' */
function localAbsOf(item, ctx) {
  const o = (item && item.origin) || {};
  if (o.type !== 'local') return '';
  try { return absOf(o, ctx && ctx.settings); } catch (_) { return ''; }
}

/** 确保拿到字节：RawFileSource 已带 bytes；缓存/复用路径可能只有 origin */
function ensureBytes(item, ctx) {
  if (item.bytes && item.bytes.length) return item.bytes;
  const abs = localAbsOf(item, ctx);
  if (!abs) return null;
  try { return fs.readFileSync(abs); } catch (_) { return null; }
}

/**
 * 取 item 的扩展名，**小写带前导点**（'.pdf'）。
 *
 * ⚠ 必须归一：raws.js:75 listRaws 的两个分支给的是不带点的 'pdf'，而本文件的 BUILTIN_EXTS、
 *   constants.js 的 MINERU_IMAGE_EXTS、files.js:48 isMineruRoutable 全都按带点比对。
 *   不归一时每个候选的 accepts() 都返回 false，最终抛出一句误导人的「不支持的文件格式」。
 *   实现住在 item.js（与 FilterDecorator 共用同一口径）。
 */
function extOf(item) {
  return extOfItem(item);
}

// ============ 解析层基类（双接口宿主） ============

/**
 * 解析层基类：既能当流装饰器（有 inner），也能当纯变换器（inner = null）。
 * 子类只覆写 accepts() / apply()。
 */
class ParseLayer extends CorpusStream {
  /** @param {CorpusStream|null} inner 被装饰的流；null = 纯变换器形态 */
  constructor(inner, opts = {}) {
    super();
    this.inner = inner && typeof inner.next === 'function' ? inner : null;
    this.opts = opts || {};
    this._closed = false;
    this._result = null;
  }

  get layer() { return this.constructor.name; }

  /** 解析层的职责就是把 bytes 变成 text，故 caps.text 恒为真、caps.bytes 恒为假 */
  get caps() {
    const base = this.inner ? this.inner.caps : { bytes: true, text: false, graph: false, countable: true, replayable: true };
    return { ...base, bytes: false, text: true };
  }

  // ---- CorpusTransform 接口 ----

  /** 我是否适用于这一条（不实际执行）。默认：有本地字节可读即适用 */
  accepts(item, ctx) {
    if (typeof item.text === 'string' && item.text.trim()) return false; // 已是文本，无需解析
    return !!localAbsOf(item, ctx) || !!(item.bytes && item.bytes.length);
  }

  /** 加工一条。返回 null = 处理不了（触发回退）；抛异常 = 失败（触发回退并记 warning） */
  async apply(item, ctx) { return item; }

  // ---- CorpusStream 接口 ----

  async open(ctx) { if (this.inner) await this.inner.open(ctx); }

  async next(ctx) {
    if (!this.inner) return null;
    const item = await this.inner.next(ctx);
    if (!item) return null;
    if (!this.accepts(item, ctx)) return item;
    const t0 = Date.now();
    try {
      const out = await this.apply(item, ctx);
      if (out) addProvenance(out, { layer: this.layer, at: Date.now(), ms: Date.now() - t0 });
      return out || item;
    } catch (err) {
      if (isAbort(err)) throw err;
      addWarning(item, `${this.layer} 解析失败：${err.message}`);
      return item; // 单独使用时不抛，交给外层决定
    }
  }

  async close(ctx) {
    if (this._closed) return this._result;
    this._closed = true;
    const own = (await this.finish(ctx)) || { ok: true, count: 0, stats: {}, warnings: [] };
    const innerRes = this.inner ? await this.inner.close(ctx) : { ok: true, count: 0, stats: {}, warnings: [], error: '' };
    this._result = mergeResults({ ...own, layer: this.layer }, innerRes);
    return this._result;
  }

  async finish(ctx) { return null; }

  estimate(ctx) {
    if (this.inner) return this.inner.estimate(ctx);
    return { total: -1, labels: [] };
  }
}

// ============ MineruDecorator ============

/**
 * PDF → 高质量 Markdown（含图片暂存目录）。
 * 生效条件（§4.2）：isMineruRoutable(ext)（仅 .pdf）且 mineruCmdParts(settings) 非空
 * （mineruCmdParts 内部已判 mineruMode !== 'builtin'，files.js:113-115）。
 */
class MineruDecorator extends ParseLayer {
  accepts(item, ctx) {
    if (!super.accepts(item, ctx)) return false;
    const ext = extOf(item);
    const files = require('../../raws/files');
    // 与 files.js:604 preferExternal 同口径
    return files.isMineruRoutable(ext) && !files.TEXTUAL_EXTS.includes(ext) && !!localAbsOf(item, ctx);
  }

  async apply(item, ctx) {
    const c = ctx || {};
    const settings = c.settings || {};
    const files = require('../../raws/files');
    const abs = localAbsOf(item, c);
    const external = files.mineruCmdParts(settings);
    if (!external || !external.length) {
      // 未配置：非强制模式下静默让位给下一个候选（≡ files.js:605 的 if 不成立分支）
      const err = new Error('未配置 MinerU 转换命令（设置→文档解析），无法强制 MinerU 解析');
      err.skipSilently = true;
      throw err;
    }
    const info = {};
    let md = '';
    try {
      md = await files.convertWithMineru(settings, abs, { info, onLog: c.onLog, signal: c.signal });
    } catch (err) {
      if (isAbort(err)) throw err;
      const reason = `MinerU 转换失败：${err.message}`;
      files.appendMineruFallbackLog(abs, reason);
      throw new Error(reason);
    }
    if (!md || !md.trim()) {
      const reason = 'MinerU 转换输出为空';
      files.appendMineruFallbackLog(abs, reason);
      throw new Error(reason);
    }

    // 图片副产物：convertWithMineru 把抽取图片暂存到 info.imagesDir（files.js:340-342）。
    // 语料库不用 kb-asset 绝对引用（语料是可迁移的纯文本资产），改为把图片登记到 meta.assets，
    // 由 CorpusWriteDecorator → store.attachAssets 归位到 <同名>.assets/ 并改写为相对引用。
    const assets = collectImages(info.imagesDir);
    let text = String(md);
    if (assets.length) text = flattenImageRefs(text, assets);

    const out = { ...item, text };
    delete out.bytes; // 解析完成即释放原始字节（12 个 PDF 常驻内存会到几百 MB）
    out.meta = { ...(item.meta || {}) };
    out.meta.parseMethod = 'mineru';
    if (assets.length) out.meta.assets = assets;
    if (info.imagesDir) out.meta.cleanupDirs = [info.imagesDir];
    return out;
  }
}

/** 列出暂存目录下的图片（绝对路径，最多下探 3 层） */
function collectImages(dir) {
  if (!dir) return [];
  try {
    if (!fs.statSync(dir).isDirectory()) return [];
    const IMG = /\.(png|jpe?g|gif|svg|webp|bmp|avif|ico)$/i;
    const walk = (d, depth) => {
      if (depth > 3) return [];
      const out = [];
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) out.push(...walk(p, depth + 1));
        else if (IMG.test(e.name)) out.push(p);
      }
      return out;
    };
    return walk(dir, 0);
  } catch (_) { return []; }
}

/**
 * 把 MinerU 产出的 `](images/xxx.jpg)` / `](任意目录/xxx.jpg)` 统一压成 `](xxx.jpg)`，
 * 以便 store.attachAssets 的 `](name)` → `](<语料名>.assets/name)` 改写能命中（store.js:322）。
 */
function flattenImageRefs(text, assets) {
  let out = String(text || '');
  for (const abs of assets) {
    const name = path.basename(abs);
    out = out.split(`](images/${name})`).join(`](${name})`);
  }
  // 兜底：MinerU 不同版本可能用别的子目录名，按「任意一级目录 + 已知图片名」再扫一遍
  return out.replace(/\]\(([^()\s]*\/)([^()\s/]+)\)/g, (m, dir, name) => (
    assets.some((a) => path.basename(a) === name) ? `](${name})` : m
  ));
}

// ============ SkillMarkdownDecorator ============

/**
 * 抽取技能（§5，本设计核心）。与现状 parse.js:parseWithSkills 的差别只有**一处**：
 * 注入的技能从「全部已启用」收窄为 selectExtractSkills(settings, ext)（§5.3 对照表）。
 *
 * mode: llm    → AI 直读（parse.js:parseWithSkills，传 opts.skills）
 * mode: script → node 子进程沙盒（skills/runner.js:runNodeScript）
 *                ⚠️ 正文**必须走文件交接**，不能走 stdout（不变量 P12）：
 *                   runner.js 把 stdout 截到 4000、返回体再截到 1500 字，
 *                   一份 3 万字语料经 stdout 回传会被截成末尾 1500 字——静默数据损坏。
 */
class SkillMarkdownDecorator extends ParseLayer {
  constructor(inner, opts = {}) {
    super(inner, opts);
    this.lastSkills = [];
  }

  accepts(item, ctx) {
    if (!super.accepts(item, ctx)) return false;
    const settings = (ctx && ctx.settings) || {};
    const parse = require('../../skills/parse');
    if (!parse.skillParseReady(settings)) return false;
    const { selectExtractSkills, findExtractSkill } = require('../../skills/select');
    const ext = extOf(item);
    if (ctx && ctx.skillName) {
      return !!findExtractSkill(settings, ctx.skillName, ext);
    }
    return selectExtractSkills(settings, ext).length > 0;
  }

  async apply(item, ctx) {
    const c = ctx || {};
    const settings = c.settings || {};
    const ext = extOf(item);
    const abs = localAbsOf(item, c);
    const parse = require('../../skills/parse');
    const { selectExtractSkills, findExtractSkill } = require('../../skills/select');
    let skills = null;
    if (c.skillName) {
      const forced = findExtractSkill(settings, c.skillName, ext);
      if (forced) skills = [forced];
    }
    if (!skills) skills = selectExtractSkills(settings, ext);
    this.lastSkills = skills;
    if (!skills.length) return null; // 让位给下一个候选（不算失败）

    // 图片类型：技能解析是唯一途径（≡ files.js:648-661），失败即抛长提示，不回退内置
    const isImage = MINERU_IMAGE_EXTS.has(ext);
    const top = skills[0];
    if (String(top.mode || 'llm') === 'script') return this.runScript(item, c, top, abs, ext);

    // ---- mode: llm ----
    const buffer = ensureBytes(item, c);
    const r = await parse.parseWithSkills(abs || (item.origin && item.origin.name) || '', settings, {
      buffer: buffer || undefined,
      builtinExtract: require('../../raws/files').parseBuiltin,
      onLog: c.onLog,
      skills,
    });
    if (!r || !r.ok) {
      if (isImage) throw new Error(`不支持的文件格式：${ext || '无扩展名'}（技能解析失败：${(r && r.error) || '未知错误'}）`);
      throw new Error((r && r.error) || '技能解析失败');
    }
    const out = { ...item, text: parse.cleanOutput(r.text) };
    delete out.bytes;
    out.meta = { ...(item.meta || {}) };
    out.meta.parseMethod = 'skill';
    out.meta.skill = { name: top.name, mode: 'llm', version: top.version || '0.0.0' };
    return out;
  }

  /**
   * mode: script —— 子进程沙盒抽取（§5.3）。
   * 脚本契约：module.exports.run = async ({inputPath, ext, instructions, outputDir})
   *              => ({ markdown: string, assets?: string[] })
   */
  async runScript(item, ctx, skill, absPath, ext) {
    const settings = ctx.settings || {};
    const runner = require('../../skills/runner');
    const parse = require('../../skills/parse');
    const entry = String(skill.entry || 'scripts/main.js');
    const entryAbs = path.join(String(skill.dir || ''), entry);
    if (!skill.dir || !fs.existsSync(entryAbs)) {
      throw new Error(`抽取技能「${skill.name}」的脚本入口不存在：${entry}`);
    }
    const instructions = parse.skillInstructions(skill) || '';
    // 超时（秒）：技能声明的 timeoutSec 优先，留 0/缺省则回退全局 extractSkillTimeoutSec；主进程 ×1000
    const tSec = Number(skill.timeoutSec) > 0
      ? Math.min(600, Math.max(5, Math.round(Number(skill.timeoutSec))))
      : num(settings, 'extractSkillTimeoutSec', 120, 5, 600);
    const timeoutMs = tSec * 1000;
    // 产物文件名：技能声明的 output 优先（basename 防目录穿越），缺省用 SCRIPT_MD_NAME
    const mdRel = path.basename(String(skill.output || '').trim() || SCRIPT_MD_NAME);

    const code = [
      "const fs = require('fs'), path = require('path');",
      `const mod = require(${JSON.stringify(entryAbs)});`,
      'const outDir = process.env.AGENT_OUTPUT_DIR;',
      '(async () => {',
      '  const out = await mod.run({',
      `    inputPath: ${JSON.stringify(absPath || '')},`,
      `    ext: ${JSON.stringify(ext || '')},`,
      `    instructions: ${JSON.stringify(instructions)},`,
      '    outputDir: outDir,',
      '  });',
      '  const mdRel = ' + JSON.stringify(mdRel) + ';',
      "  fs.writeFileSync(path.join(outDir, mdRel), String((out && out.markdown) || ''), 'utf8');",
      '  const assets = ((out && out.assets) || []).map((a) => String(a));',
      '  process.stdout.write(JSON.stringify({ ok: true, mdRel, assets }));',
      "})().catch((e) => { process.stdout.write(JSON.stringify({ ok: false, error: String((e && e.message) || e) })); process.exit(1); });",
    ].join('\n');

    let res;
    try {
      // runNodeScript 返回的是 JSON **字符串**（runner.js:56-65），需自行 parse
      res = JSON.parse(await runner.runNodeScript({ code, timeoutMs, allowLongTimeout: true }));
    } catch (err) {
      throw new Error(`脚本抽取技能「${skill.name}」返回体无法解析：${err.message}`);
    }
    if (res && res.timedOut) {
      throw new Error(`脚本抽取技能「${skill.name}」超时（${Math.round((res.timeoutMs || timeoutMs) / 1000)} 秒，可在 设置→语料流水线 调大）`);
    }
    if (!res || !res.ok) {
      const detail = (res && (res.error || res.stderr)) || `退出码 ${res && res.exitCode}`;
      throw new Error(`脚本抽取技能「${skill.name}」执行失败：${String(detail).trim().slice(-400)}`);
    }

    const mdAbs = path.join(String(res.outputDir || ''), String(res.mdRel || mdRel));
    let markdown = '';
    try {
      markdown = fs.readFileSync(mdAbs, 'utf8');
    } catch (err) {
      throw new Error(`脚本抽取技能「${skill.name}」未产出 Markdown 文件：${err.message}`);
    }
    // ⚠️ 读完立即删除自己写入的交接文件：artifacts/ 是与 skill__run_script（生成 office 文件）
    //    共享的目录，留着会与用户产物混淆（§5.3「artifacts/ 目录污染」）
    try { fs.unlinkSync(mdAbs); } catch (_) { /* 删不掉不影响本次结果 */ }

    // res.files = outputDir 前后差集（runner.js:55-58），即脚本写出的全部副产物。
    // 图片交给 CorpusWriteDecorator 归位到 .assets/；其余（含脚本自己的中间文件）登记待清理。
    const produced = Array.isArray(res.files) ? res.files.map((f) => String(f)) : [];
    const scriptAssets = produced.filter((f) => path.resolve(f) !== path.resolve(mdAbs));
    const declared = (Array.isArray(res.assets) ? res.assets : []).map((a) => String(a));
    // 脚本可以只返回文件名（相对 outputDir），此处补成绝对路径
    const assets = [];
    for (const a of declared) {
      const abs2 = path.isAbsolute(a) ? a : path.join(String(res.outputDir || ''), a);
      if (scriptAssets.some((f) => path.resolve(f) === path.resolve(abs2))) assets.push(abs2);
    }
    // 脚本没显式声明 assets 时，退化为「差集里的全部图片」
    const IMG = /\.(png|jpe?g|gif|svg|webp|bmp|avif|ico)$/i;
    const finalAssets = assets.length ? assets : scriptAssets.filter((f) => IMG.test(f));
    const cleanup = scriptAssets.filter((f) => !finalAssets.some((a) => path.resolve(a) === path.resolve(f)));

    if (!markdown.trim()) throw new Error(`脚本抽取技能「${skill.name}」返回的 Markdown 为空`);

    const out = { ...item, text: markdown };
    delete out.bytes;
    out.meta = { ...(item.meta || {}) };
    out.meta.parseMethod = 'skill';
    out.meta.skill = { name: skill.name, mode: 'script', version: skill.version || '0.0.0' };
    if (finalAssets.length) out.meta.assets = finalAssets;
    if (cleanup.length) out.meta.cleanupFiles = cleanup;
    return out;
  }
}

// ============ BuiltinParseDecorator ============

/** 按扩展名内置解析（files.js:699 parseBuiltin）。链条最后一环，兜底。 */
class BuiltinParseDecorator extends ParseLayer {
  accepts(item, ctx) {
    if (!super.accepts(item, ctx)) return false;
    return BUILTIN_EXTS.has(extOf(item));
  }

  async apply(item, ctx) {
    const c = ctx || {};
    const ext = extOf(item);
    const buffer = ensureBytes(item, c);
    if (!buffer) return null; // 读不到字节：让位（不算失败）
    const files = require('../../raws/files');
    let text = '';
    try {
      text = String((await files.parseBuiltin(ext, buffer)) || '');
    } catch (err) {
      if (isAbort(err)) throw err;
      throw new Error(err.message);
    }
    const out = { ...item, text };
    delete out.bytes;
    out.meta = { ...(item.meta || {}) };
    // 内置解析出空串是合法情形（如空 PDF，files.js:691），照实透传，由上层决定要不要跳过
    out.meta.parseMethod = 'builtin';
    return out;
  }
}

// ============ CorpusReuseDecorator（可选，§4.2 / O4，默认不在配方中） ============

/**
 * 语料复用：若该来源已有**未过期**的语料文件，直接读回 text，跳过整条解析链（零 LLM 成本）。
 *
 * 位置（O4）：在 CacheDecorator **内层**、FallbackDecorator **外层**，即链序 cache > corpusReuse > fallback。
 * 短路机制与 CacheDecorator 同构——都靠内层 FallbackDecorator 的 preParse 钩子「在解析之前插手」：
 *   · 本层构造时把自己的 tryReuse 装到 inner(Fallback) 的 preParse 上；
 *   · 外层 Cache 构造时调本层 setPreParse(tryHit)，本层不覆盖 Fallback 的钩子，而是**链式转交**；
 *   · 于是每条 item 的 preParse 顺序为：先试语料复用，命中即返回（不再查缓存）；未命中再走缓存钩子；都未命中则交给 Fallback 解析。
 * 这正是 §4.4「语料复用比解析缓存更上游」的可执行表达。语料命中来自 readCorpus 的纯文本，不带 parse 副作用，
 * 故 Fallback 命中短路（parse.js:481）不会触发 postParse，不会把复用文本回写解析缓存。
 */
class CorpusReuseDecorator extends CorpusDecorator {
  constructor(inner, opts = {}) {
    super(inner);
    this.opts = opts || {};
    this.hits = 0;
    this.misses = 0;
    this._downPre = null;   // 外层（Cache）注册的钩子，语料未命中时链式转交
    this._downPost = null;
    this.attached = false;
    if (inner && typeof inner.setPreParse === 'function') {
      inner.setPreParse((item, ctx) => this.tryReuse(item, ctx));
      if (typeof inner.setPostParse === 'function') {
        inner.setPostParse((item, ctx) => { if (this._downPost) return this._downPost(item, ctx); });
      }
      this.attached = true;
    }
  }

  get caps() { return this.inner.caps; }

  // 供外层 CacheDecorator 注册（Cache 把本层当作「支持钩子的内层」）
  setPreParse(fn) { this._downPre = typeof fn === 'function' ? fn : null; return this; }
  setPostParse(fn) { this._downPost = typeof fn === 'function' ? fn : null; return this; }

  /** 命中 → 返回带 text 的 item；未命中 → 转交外层钩子（无则返回 null，交给 Fallback 解析） */
  tryReuse(item, ctx) {
    const c = ctx || {};
    const store = require('../store');
    let hit = null;
    try { hit = store.findReusableCorpus(item.origin, c.settings || {}); } catch (_) { hit = null; }
    if (hit) {
      this.hits++;
      const out = { ...item, text: String(hit.text) };
      delete out.bytes;
      out.meta = { ...(item.meta || {}) };
      out.meta.parseMethod = 'corpus';
      out.meta.reusedCorpus = hit.rel;
      addProvenance(out, { layer: this.layer, at: Date.now(), ms: 0, hit: true, rel: hit.rel });
      return out;
    }
    this.misses++;
    return this._downPre ? this._downPre(item, c) : null;
  }

  async finish(ctx) {
    const warnings = [];
    if (!this.attached) warnings.push('语料复用层未能挂到解析链上（内层不支持 preParse 钩子），本次不复用语料');
    return {
      ok: true,
      count: 0,
      stats: { corpusReuseHits: this.hits, corpusReuseMisses: this.misses },
      warnings,
    };
  }
}

// ============ FallbackDecorator ============

/**
 * 回退编排器：把今天硬编码在 files.js:591-697 的 if/else 回退链变成**可组合的候选数组**（G4）。
 *
 * 它包装的不是「一条流」而是「一组变换器」——因为 next() 的拉取语义无法回退，
 * 回退必须发生在**条目级**（§4.2）。这是装饰模式在「同一条目多路重试」场景下的必要变形。
 *
 * opts:
 *   candidates       CorpusTransform[]（按尝试顺序）
 *   forceFirst       true = 首个候选失败即抛（≡ files.js:627 的 forceMineru 语义）
 *   forceFirstError  首候选「不适用」且 forceFirst 为真时抛的文案（≡ files.js:606）
 *
 * 两个钩子（setPreParse / setPostParse）是给**外层** CacheDecorator 用的：
 *   缓存必须在解析**之前**查（否则白跑一遍 LLM）、在解析**之后**写，而 O1 又要求缓存层在外层。
 *   外层装饰器无法在内层取数前插手，故由内层主动回调外层。钩子抛错一律吞掉（缓存坏了不能拖垮解析）。
 */
class FallbackDecorator extends CorpusDecorator {
  constructor(inner, opts = {}) {
    super(inner);
    this.opts = opts || {};
    this.candidates = (Array.isArray(this.opts.candidates) ? this.opts.candidates : [])
      .filter((c) => c && typeof c.apply === 'function');
    this.forceFirst = !!this.opts.forceFirst;
    this.forceFirstError = this.opts.forceFirstError
      || '未配置 MinerU 转换命令（设置→文档解析），无法强制 MinerU 解析';
    this.count = 0;
    this.skipped = 0;
    this.byMethod = {};
    this._preParse = null;
    this._postParse = null;
  }

  get caps() { return { ...this.inner.caps, bytes: false, text: true }; }

  /** 注册「解析前」钩子：返回带 text 的 item 即视为命中，本层不再尝试任何候选 */
  setPreParse(fn) { this._preParse = typeof fn === 'function' ? fn : null; return this; }

  /** 注册「解析后」钩子：拿到最终产物（用于写缓存等副作用） */
  setPostParse(fn) { this._postParse = typeof fn === 'function' ? fn : null; return this; }

  async next(ctx) {
    const c = ctx || {};
    for (;;) {
      const item = await this.inner.next(c);
      if (!item) return null;
      // 已有文本（笔记 / 内联 / 语料）：解析链整层透传
      if (typeof item.text === 'string' && item.text.trim()) {
        this.count++;
        return item;
      }
      if (c.signal && c.signal.aborted) throw mkAbortErr();
      // 缓存命中短路（钩子由外层 CacheDecorator 注册；失败静默忽略，继续走解析）
      if (this._preParse) {
        let hit = null;
        try { hit = await this._preParse(item, c); } catch (err) { if (isAbort(err)) throw err; hit = null; }
        if (hit && typeof hit.text === 'string') {
          this.count++;
          this.tally(hit);
          return hit;
        }
      }
      try {
        const out = await this.parseOne(item, c);
        this.count++;
        this.tally(out);
        if (this._postParse) {
          try { await this._postParse(out, c); } catch (err) { if (isAbort(err)) throw err; /* 写缓存失败不影响解析 */ }
        }
        return out;
      } catch (err) {
        if (isAbort(err)) throw err;
        if (this.forceFirst) throw err; // 强制模式：整条作业失败，不静默降级
        // P10：单条失败绝不中断整条流——记 errors + 日志，继续下一条
        this.skipped++;
        if (!Array.isArray(c.errors)) c.errors = [];
        c.errors.push({ label: item.label || (item.origin && item.origin.name) || '未知来源', error: err.message });
        if (c.onLog) { try { c.onLog(`跳过 ${item.label || ''}：${err.message}`); } catch (_) { /* 忽略 */ } }
      }
    }
  }

  /** 按解析方式计数（作业详情与 stats 里展示「内置 ×8 / 技能 ×3 / 缓存 ×1」） */
  tally(item) {
    const m = String((item && item.meta && item.meta.parseMethod) || 'unknown');
    this.byMethod[m] = (this.byMethod[m] || 0) + 1;
  }

  /** 对一条 item 依次尝试候选；全部不适用/失败则抛错 */
  async parseOne(item, ctx) {
    const fallbacks = [];
    let accepted = 0;
    let lastError = '';
    for (let i = 0; i < this.candidates.length; i++) {
      const cand = this.candidates[i];
      if (ctx.signal && ctx.signal.aborted) throw mkAbortErr();
      let ok = false;
      try { ok = !!cand.accepts(item, ctx); } catch (_) { ok = false; }
      if (!ok) continue;
      accepted++;
      const t0 = Date.now();
      try {
        const out = await cand.apply(item, ctx);
        if (out && typeof out.text === 'string') {
          if (!Array.isArray(out.meta.fallbacks) || !out.meta.fallbacks.length) out.meta.fallbacks = fallbacks;
          addProvenance(out, { layer: cand.layer, at: Date.now(), ms: Date.now() - t0, skill: out.meta.skill ? `${out.meta.skill.name}@${out.meta.skill.version}` : undefined });
          return out;
        }
        // apply 返回 null = 「我处理不了」，不算失败，静默让位
      } catch (err) {
        if (isAbort(err)) throw err;
        lastError = err.message;
        // 强制模式下首候选的任何失败都直接上抛（≡ files.js:606 未配置 / :627 转换失败）
        if (this.forceFirst && i === 0) throw err;
        if (!err.skipSilently) {
          fallbacks.push({ from: cand.layer, error: err.message });
          if (ctx.onLog) { try { ctx.onLog(`${cand.layer} 失败，已回退（${err.message}）`); } catch (_) { /* 忽略 */ } }
        }
      }
    }
    if (!accepted && this.forceFirst) throw new Error(this.forceFirstError);
    const label = (item.origin && item.origin.name) || item.label || '';
    const ext = extOf(item);
    // 报错口径与 files.js:687-696 对齐：把上游失败原因一并带出，便于在作业里定位
    const hint = MINERU_IMAGE_EXTS.has(ext)
      ? '（图片无内置解析器，MinerU 严格只接 PDF；技能解析未生效：请在 设置→文档解析 开启「技能解析」并确认已启用技能且模型可用）'
      : '（可在 设置→文档解析 配置本地 MinerU 转换命令处理该格式）';
    const extra = lastError && !lastError.startsWith('不支持的文件格式') ? `：${lastError}` : '';
    throw new Error(`不支持的文件格式：${ext || '无扩展名'}${hint}${extra}`);
  }

  async finish(ctx) {
    return {
      ok: true,
      count: this.count,
      stats: { parsed: this.count, skipped: this.skipped, ...this.byMethod },
      warnings: [],
    };
  }
}

module.exports = {
  ParseLayer,
  MineruDecorator,
  SkillMarkdownDecorator,
  BuiltinParseDecorator,
  CorpusReuseDecorator,
  FallbackDecorator,
  BUILTIN_EXTS,
  SCRIPT_MD_NAME,
  collectImages,
  flattenImageRefs,
};
