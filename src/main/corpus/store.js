// 语料库存储（Corpus Store）——设计文档 §6
//
// 语料是「机器产物、可重生成」，与 note/（人工资产）语义完全不同，故单独一个目录：
//   ① 不进笔记列表与全局搜索（§15 问题 6 拍板；knowledge.js:28 register 不新增 corpus 源）
//   ② 不随备份/迁移搬迁（§15 问题 7 拍板；paths.js:85 ensureUnifiedRoot 的迁移清单刻意不含 corpus/）
//   ③ 按语料指纹 upsert（覆盖是预期行为），而 note 的 importNote 按 source upsert 会覆盖用户编辑
//   ④ 支持一键「提升为笔记」（promoteToNote → notes/store.js:444 importNote）
//
// 目录布局：以原文档名（去扩展名）建目录，正文与图片都放在该目录内。
//   <数据根>/corpus/<原文档名>/<原文档名>.md
//   <数据根>/corpus/<原文档名>/<原文档名>.assets/img-1.png
// 不维护独立索引或列表缓存；目录中的 Markdown 文件及其 frontmatter 是唯一数据源。
// 旧的按领域存放的语料仍可扫描读取，保留原路径以兼容作业与笔记引用。
'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('../common/paths');
const settingsMod = require('../common/settings');
const { num } = require('../common/config');
const { parseFrontmatter, renderCorpusFile } = require('./item');

const GENERATOR = 'Synapse-Corpus/1.0';
const IMG_EXT_RE = /\.(png|jpe?g|gif|svg|webp|bmp|avif|ico)$/i;
/** frontmatter 只读文件头这么多字节即可（语料头很小）；解析不出围栏时回退整文件读 */
const HEAD_BYTES = 16384;

// ============ 路径工具 ============

function corpusRoot() {
  return paths.corpusRoot();
}

/** 与 notes/store.js:13 safeName 同口径：Windows 非法字符换 '-'，限长 80 */
function safeName(s, dft) {
  const name = String(s == null ? '' : s).trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')
    .replace(/^\.+/, '').slice(0, 80).replace(/[. ]+$/, '');
  return name && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name) ? name : dft;
}

/** 归一化相对路径：统一正斜杠、去掉前导斜杠、拒绝越界（..） */
function normRel(rel) {
  const s = String(rel == null ? '' : rel).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!s) return '';
  if (s.split('/').some((p) => p === '..')) return '';
  return s.replace(/^\.\/+/, '');
}

/** rel → 绝对路径；越界或非法返回 ''（绝不抛，Source/装饰器层按 P10 记 errors 后继续） */
function absOfRel(rel) {
  const r = normRel(rel);
  if (!r) return '';
  const root = path.resolve(corpusRoot());
  const abs = path.resolve(root, r);
  if (abs !== root && !abs.startsWith(root + path.sep)) return '';
  return abs;
}

/** 某篇语料的图片副产物目录：<同名>.assets/（与 note 的附件目录同构，§6.1） */
function assetsDirFor(rel) {
  const abs = absOfRel(rel);
  if (!abs) return '';
  return path.join(path.dirname(abs), path.basename(abs, '.md') + '.assets');
}

// ============ 目录扫描 ============

/** 只读文件头解析 frontmatter；头部截断导致解析不出围栏时回退整文件读 */
function readHead(abs) {
  let raw = '';
  try {
    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
      raw = buf.slice(0, Math.max(0, n)).toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (_) { return { frontmatter: {}, body: '' }; }
  let parsed = parseFrontmatter(raw);
  if (!parsed.frontmatter || !Object.keys(parsed.frontmatter).length) {
    try { parsed = parseFrontmatter(fs.readFileSync(abs, 'utf8')); } catch (_) { /* 保持空 */ }
  }
  return parsed;
}

/** 每次从语料目录扫描文件，忽略旧索引、临时文件、附件目录和符号链接。 */
function scanCorpusFiles() {
  const root = corpusRoot();
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (/\.assets$/i.test(e.name)) {
          // 原文档可能名为 manual.assets.pdf；一级同名语料目录不能当成图片目录跳过。
          let hasOwnCorpus = false;
          if (dir === root) {
            try {
              hasOwnCorpus = fs.readdirSync(abs, { withFileTypes: true }).some((child) => child.isFile()
                && (child.name === e.name + '.md' || (child.name.startsWith(e.name + '-') && /\.md$/i.test(child.name))));
            } catch (_) { /* 目录不可读时跳过 */ }
          }
          if (!hasOwnCorpus) continue;
        }
        walk(abs);
      } else if (e.isFile() && /\.md$/i.test(e.name)) {
        const rec = recordFromFile(abs, path.relative(root, abs).split(path.sep).join('/'));
        if (rec) out.push(rec);
      }
    }
  };
  walk(root);
  out.sort((a, b) => Date.parse(b.generatedAt || 0) - Date.parse(a.generatedAt || 0));
  return out;
}

/** 从语料正文与 frontmatter 生成列表条目，保持原有接口字段。 */
function recordFromFile(abs, rel) {
  try {
    // 直接读正文以得到实际字数，外部编辑后也不依赖旧的 parse.chars。
    const parsed = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
    const fm = parsed.frontmatter || {};
    const body = String(parsed.body || '').replace(/^\n+/, '');
    const src = fm.source || {};
    const parse = fm.parse || {};
    const dom = fm.domain || {};
    return {
      corpusId: String(fm.corpusId || ''),
      rel,
      name: path.basename(rel),
      domain: String(dom.id || ''),
      domainLabel: String(dom.label || ''),
      profileId: String(fm.profileId || ''),
      parseMethod: String(parse.method || ''),
      skill: parse.skill && typeof parse.skill === 'object' ? parse.skill : null,
      chars: body.length,
      generatedAt: String(fm.generatedAt || fs.statSync(abs).mtime.toISOString()),
      sourceMtime: Number(src.mtime) || 0,
    };
  } catch (_) { return null; }
}

// ============ 陈旧判定（§6.3 staleOf） ============

/** 来源路径直接取自语料文件头，不维护独立缓存。 */
function sourcePathOf(rec) {
  const r = rec || {};
  let p = '';
  try {
    const abs = absOfRel(r.rel);
    if (abs && fs.existsSync(abs)) {
      const fm = readHead(abs).frontmatter || {};
      p = String((fm.source && fm.source.path) || '');
    }
  } catch (_) { /* 读不到就当不陈旧 */ }
  return p;
}

/**
 * 源文件 mtime 变了 → true。判据口径复用 raws.js:59 isIngestedFresh：
 * 记录里没有 mtime、或源不是本地文件（url:/note:/inline:）→ 一律 false（无从判断即不报陈旧）。
 * @param {Object} rec 扫描条目（sourceMtime/rel）或 frontmatter（source.{path,mtime}）
 */
function staleOf(rec, settings) {
  const r = rec || {};
  const mtime = Number(r.sourceMtime != null ? r.sourceMtime : ((r.source || {}).mtime)) || 0;
  if (mtime <= 0) return false;
  let p = String(r.sourcePath || (r.source || {}).path || '');
  if (!p && r.rel) p = sourcePathOf(r);
  if (!p) return false;
  if (p.startsWith('url:') || p.startsWith('note:') || p.startsWith('inline:')) return false;
  let abs = p.startsWith('local:') ? p.slice(6) : p;
  if (!path.isAbsolute(abs)) {
    // 仓库内相对路径（raw/xxx）→ 相对 rawsRoot 解析
    try {
      const { rawsRoot } = require('../raws/root');
      abs = path.resolve(rawsRoot(settings || settingsMod.getSettings() || {}), abs);
    } catch (_) { return false; }
  }
  try {
    return Math.round(fs.statSync(abs).mtimeMs) > mtime;
  } catch (_) { return false; } // 源已删除：不算「待更新」，删除由原始文件页负责提示
}

/**
 * 语料复用查找（§4.2 CorpusReuseDecorator 的数据源，可选、默认关）。
 * 按**来源路径**命中一条已有语料，且源文件 mtime 未变（未过期）→ 返回其正文，供上层跳过整条解析链（零 LLM）。
 * 命中多条（同来源被不同技能产出）时取 generatedAt 最新的一条；过期则返回 null（让位给解析链重抽）。
 * 非本地来源（note:/url:/inline:/corpus:）一律不复用。
 * @param {Object} origin CorpusItem.origin（用 .path 匹配）
 * @param {Object} [settings]
 * @returns {{ok:true, rel:string, text:string, record:Object}|null}
 */
function findReusableCorpus(origin, settings) {
  const o = origin || {};
  const p = String(o.path || '');
  if (!p || /^(note|inline|url|corpus):/.test(p)) return null;
  const s = settings || settingsMod.getSettings() || {};
  let best = null;
  for (const rec of scanCorpusFiles()) {
    if (sourcePathOf(rec) !== p) continue;
    if (!best || Date.parse(rec.generatedAt || 0) > Date.parse(best.generatedAt || 0)) best = rec;
  }
  if (!best) return null;
  if (staleOf(best, s)) return null; // 源文件已变更 → 不复用
  const r = readCorpus(best.rel);
  if (!r || !r.ok || !String(r.text || '').trim()) return null;
  return { ok: true, rel: best.rel, text: r.text, record: best };
}

// ============ 列表 / 读取 ============

/**
 * 列出语料（§11.1 corpus:list 的数据源）。
 * @param {Object} settings
 * @param {Object} filter { domain?: 领域 id 或标签, q?: 名称/领域模糊过滤 }
 * @returns {Array} [{ corpusId, name, rel, domain, domainLabel, profileId, parseMethod, skill,
 *                     chars, generatedAt, sourceMtime, stale }]
 */
function listCorpus(settings, filter) {
  const f = filter || {};
  const s = settings || settingsMod.getSettings() || {};
  const q = String(f.q || '').trim().toLowerCase();
  const domain = String(f.domain || '').trim();
  let items = scanCorpusFiles().slice();
  if (domain) items = items.filter((r) => r.domain === domain || r.domainLabel === domain);
  if (q) {
    items = items.filter((r) => String(r.name || '').toLowerCase().includes(q)
      || String(r.domainLabel || '').toLowerCase().includes(q)
      || String(r.profileId || '').toLowerCase().includes(q));
  }
  items = items.map((r) => Object.assign({}, r, { stale: staleOf(r, s) }));
  items.sort((a, b) => Date.parse(b.generatedAt || 0) - Date.parse(a.generatedAt || 0));
  return items;
}

/**
 * 读一篇语料。text 是**去掉 frontmatter 的正文**（CorpusFileSource 直接把它当 item.text）。
 * @returns {{ ok:boolean, text:string, frontmatter:Object, rel:string, path?:string, error?:string }}
 */
function readCorpus(rel) {
  const r = normRel(rel);
  const abs = absOfRel(r);
  const fail = (error) => ({ ok: false, text: '', frontmatter: {}, rel: r, error });
  if (!abs) return fail('非法语料路径：' + String(rel || ''));
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return fail('语料文件不存在：' + r);
    const parsed = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
    return {
      ok: true,
      text: String(parsed.body || '').replace(/^\n+/, ''),
      frontmatter: parsed.frontmatter || {},
      rel: r,
      path: abs,
    };
  } catch (err) {
    return fail(err && err.message ? err.message : String(err));
  }
}

// ============ 写入 ============

/** 由 origin.name 派生语料文件名（去扩展名；URL 编码名交给 files.titleFromFileName 还原） */
function baseNameOf(origin, corpusId) {
  const o = origin || {};
  const raw = path.posix.basename(String(o.name || o.path || '').replace(/\\/g, '/'));
  let title = raw;
  try { title = require('../raws/files').titleFromFileName(raw) || raw; } catch (_) { /* 保持原值 */ }
  return safeName(title, String(corpusId || '').slice(0, 8) || 'corpus');
}

/**
 * 把脚本技能的图片副产物归位到 <同名>.assets/，并把正文里的裸文件名引用改写为相对路径。
 * 跨目录用 copy 而非 rename（防 EXDEV），与 files.js:244 attachMineruImages 同口径。
 */
function attachAssets(absMd, text, assets) {
  const list = (Array.isArray(assets) ? assets : [])
    .map((p) => String(p || ''))
    .filter((p) => p && IMG_EXT_RE.test(p));
  if (!list.length) return { text: String(text || ''), moved: 0 };
  const dir = path.join(path.dirname(absMd), path.basename(absMd, '.md') + '.assets');
  let out = String(text || '');
  let moved = 0;
  for (const src of list) {
    try {
      if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
      fs.mkdirSync(dir, { recursive: true });
      const name = path.basename(src);
      const dst = path.join(dir, name);
      if (path.resolve(src) !== path.resolve(dst)) fs.copyFileSync(src, dst);
      const relRef = path.basename(dir) + '/' + name;
      // 只改写标准 Markdown 引用语法，避免误伤正文里恰好同名的普通词
      out = out.split('](' + name + ')').join('](' + relRef + ')');
      moved++;
    } catch (_) { /* 单张图失败不影响语料本体 */ }
  }
  return { text: out, moved };
}

/**
 * 超出 corpusMaxFiles 时按 generatedAt 淘汰最旧（§10.1）。
 * protectRel：刚写入的那一篇永不参与淘汰——否则同一毫秒内的并列时间戳会让「新写的先被删」。
 */
function evictIfNeeded(settings, protectRel) {
  const records = scanCorpusFiles();
  const max = num(settings, 'corpusMaxFiles', 2000, 100, 20000);
  if (records.length <= max) return 0;
  const sorted = records
    .filter((r) => r.rel !== protectRel)
    .sort((a, b) => (Date.parse(a.generatedAt || 0) - Date.parse(b.generatedAt || 0))
      || (String(a.rel) < String(b.rel) ? -1 : 1));
  const over = records.length - max;
  const drop = sorted.slice(0, over);
  for (const r of drop) removeCorpus(r.rel);
  return drop.length;
}

/**
 * 落盘一篇语料（CorpusWriteDecorator 调用）。按 corpusId upsert：同一来源+同一技能重跑 → 覆盖同一文件、version+1。
 * @param {Object} item CorpusItem（必须有 text 与 origin）
 * @param {Object} ctx  PipelineContext（用 settings / jobId / domainLabel）
 * @returns {{ ok:boolean, rel?:string, corpusId?:string, created?:boolean, assets?:number, error?:string }}
 */
function writeCorpus(item, ctx) {
  const c = ctx || {};
  const settings = c.settings || settingsMod.getSettings() || {};
  const it = item || {};
  const origin = it.origin || {};
  const meta = it.meta || {};
  const corpusId = String(meta.corpusId || it.id || '');
  if (!corpusId) return { ok: false, error: '缺少语料指纹（corpusId），无法落盘' };
  const text0 = String(it.text == null ? '' : it.text);
  if (!text0.trim()) return { ok: false, error: '语料正文为空，跳过落盘' };

  const records = scanCorpusFiles();
  const prev = records.find((r) => r.corpusId === corpusId) || null;

  // ---- 目标 rel：保留已有引用路径；新语料按原文档名建目录，领域只记在 frontmatter ----
  const dom = (meta.domain && typeof meta.domain === 'object') ? meta.domain : null;
  const domainLabel = String((dom && dom.label) || c.domainLabel || meta.domainLabel || '');
  const baseName = baseNameOf(origin, corpusId);
  const dirName = baseName;
  let rel;
  if (prev && prev.rel) {
    rel = prev.rel;
  } else {
    rel = `${dirName}/${baseName}.md`;
    if (fs.existsSync(absOfRel(rel))) {
      const suffix = safeName(corpusId.slice(0, 6), 'corpus');
      rel = `${dirName}/${baseName}-${suffix}.md`;
      let n = 2;
      while (fs.existsSync(absOfRel(rel))) rel = `${dirName}/${baseName}-${suffix}-${n++}.md`;
    }
  }
  const abs = absOfRel(rel);
  if (!abs) return { ok: false, error: '非法语料路径：' + rel };

  // ---- version：读旧文件头拿上一版号 ----
  let version = 1;
  try {
    if (fs.existsSync(abs)) {
      const oldFm = readHead(abs).frontmatter || {};
      if (Number(oldFm.version) > 0) version = Number(oldFm.version) + 1;
    }
  } catch (_) { /* 读不到旧版本号就从 1 开始 */ }

  // ---- 图片副产物归位（§5.3 mode:script 的 res.files）----
  const attached = attachAssets(abs, text0, meta.assets);
  const text = attached.text;

  // ---- frontmatter（§6.2 出处契约）----
  const graph = it.graph && typeof it.graph === 'object' ? it.graph : null;
  const fm = {
    corpusId,
    version,
    generatedAt: new Date().toISOString(),
    generator: GENERATOR,
    source: {
      type: origin.type || 'local',
      path: origin.path || '',
      name: origin.name || path.basename(rel),
      ext: origin.ext || '',
      size: Number(origin.size) || 0,
      mtime: Number(origin.mtime) || 0,
    },
    parse: {
      method: meta.parseMethod || 'builtin',
      skill: (meta.skill && typeof meta.skill === 'object')
        ? { name: meta.skill.name || '', mode: meta.skill.mode || 'llm', version: meta.skill.version || '0.0.0' }
        : null,
      fallbacks: Array.isArray(meta.fallbacks) ? meta.fallbacks : [],
      truncated: !!meta.truncated,
      chars: text.length,
    },
    domain: dom || domainLabel ? { id: (dom && dom.id) || '', label: domainLabel, confidence: Number(dom && dom.confidence) || 0 } : null,
    profileId: meta.profileId || c.profileId || '',
    graph: graph ? {
      extractedAt: new Date().toISOString(),
      jobId: c.jobId || '',
      nodes: Array.isArray(graph.nodes) ? graph.nodes.length : 0,
      edges: Array.isArray(graph.edges) ? graph.edges.length : 0,
    } : null,
    provenance: Array.isArray(meta.provenance) ? meta.provenance : [],
  };
  // null 键直接不写，保持文件干净（parse 侧读不到即为「无」）
  for (const k of Object.keys(fm)) if (fm[k] === null) delete fm[k];

  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, renderCorpusFile(fm, text), 'utf8');
  } catch (err) {
    return { ok: false, error: '语料落盘失败：' + (err && err.message ? err.message : String(err)) };
  }

  const evicted = evictIfNeeded(settings, rel);

  return { ok: true, rel, corpusId, created: !prev, version, assets: attached.moved, evicted };
}

// ============ 删除 / 提升为笔记 ============

/**
 * 删除语料（连带 <同名>.assets/ 图片目录）。
 * @param {string|Array<string>} rels 单个 rel 或 rel 数组
 */
function removeCorpus(rels) {
  const list = (Array.isArray(rels) ? rels : [rels]).map(normRel).filter(Boolean);
  let removed = 0;
  for (const r of list) {
    const abs = absOfRel(r);
    if (!abs) continue;
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) { fs.unlinkSync(abs); removed++; }
    } catch (_) { /* 单个失败继续删其余 */ }
    const ad = path.join(path.dirname(abs), path.basename(abs, '.md') + '.assets');
    try {
      if (fs.existsSync(ad)) fs.rmSync(ad, { recursive: true, force: true });
    } catch (_) { /* 图片目录删不掉不影响其余语料 */ }
  }
  pruneEmptyDirs();
  return { ok: true, removed };
}

/** 删完文件后只清理空目录，保留 corpus/ 根及其他文件。 */
function pruneEmptyDirs() {
  const root = corpusRoot();
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    try {
      if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
    } catch (_) { /* 非空或占用，跳过 */ }
  }
}

/**
 * 提升为笔记（§6.4）：直接复用 notes/store.js:444 importNote。
 * source 传 `corpus:<rel>` ⇒ **重复提升会 upsert 同一篇笔记**（importNote 已按 source 去重、
 * 保留 id/tags/pinned/位置），不会产生副本。
 * @returns {{ ok:boolean, noteId?:string, path?:string, updated?:boolean, title?:string, error?:string }}
 */
function promoteToNote(rel, opts) {
  const o = opts || {};
  const r = readCorpus(rel);
  if (!r.ok) return { ok: false, error: r.error || '语料读取失败' };
  const fm = r.frontmatter || {};
  const srcName = String((fm.source && fm.source.name) || path.basename(r.rel)).replace(/\.(md|markdown)$/i, '');
  let title = srcName;
  try { title = require('../raws/files').titleFromFileName(srcName) || srcName; } catch (_) { /* 保持原值 */ }
  const source = 'corpus:' + r.rel;
  try {
    const notesStore = require('../notes/store');
    const res = notesStore.importNote(title || '未命名语料', r.text, String(o.folderRel || ''), source);
    return { ok: true, noteId: res.id, path: res.path, updated: !!res.updated, title: res.title || title };
  } catch (err) {
    return { ok: false, error: '提升为笔记失败：' + (err && err.message ? err.message : String(err)) };
  }
}

module.exports = {
  corpusRoot,
  absOfRel,
  normRel,
  assetsDirFor,
  listCorpus,
  readCorpus,
  findReusableCorpus,
  writeCorpus,
  removeCorpus,
  promoteToNote,
  scanCorpusFiles,
  staleOf,
  GENERATOR,
};
