// 语料库存储（Corpus Store）——设计文档 §6
//
// 语料是「机器产物、可重生成」，与 note/（人工资产）语义完全不同，故单独一个目录：
//   ① 不进笔记列表与全局搜索（§15 问题 6 拍板；knowledge.js:28 register 不新增 corpus 源）
//   ② 不随备份/迁移搬迁（§15 问题 7 拍板；paths.js:85 ensureUnifiedRoot 的迁移清单刻意不含 corpus/）
//   ③ 按语料指纹 upsert（覆盖是预期行为），而 note 的 importNote 按 source upsert 会覆盖用户编辑
//   ④ 支持一键「提升为笔记」（promoteToNote → notes/store.js:444 importNote）
//
// 目录布局（§6.1）：
//   <数据根>/corpus/index.json
//   <数据根>/corpus/<领域>/<名称>.md
//   <数据根>/corpus/<领域>/<名称>.assets/img-1.png
//   <数据根>/corpus/general/未归类文档.md
//
// index.json 单条固定 11 字段（§6.3 / §12.1 硬契约）：
//   { corpusId, rel, name, domain, domainLabel, profileId, parseMethod, skill, chars, generatedAt, sourceMtime }
// 索引损坏时可从 corpus/**\/*.md 的 frontmatter 全量重建（rebuildIndex，§12.3）。
'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('../common/paths');
const settingsMod = require('../common/settings');
const { num } = require('../common/config');
const { parseFrontmatter, renderCorpusFile } = require('./item');

const INDEX_NAME = 'index.json';
const GENERAL_DIR = 'general';
const GENERATOR = 'Synapse-Corpus/1.0';
const IMG_EXT_RE = /\.(png|jpe?g|gif|svg|webp|bmp|avif|ico)$/i;
/** frontmatter 只读文件头这么多字节即可（语料头很小）；解析不出围栏时回退整文件读 */
const HEAD_BYTES = 16384;

/** index.json 单条的 11 个字段（§12.1 硬契约，增删都会让测试变红） */
const INDEX_FIELDS = [
  'corpusId', 'rel', 'name', 'domain', 'domainLabel',
  'profileId', 'parseMethod', 'skill', 'chars', 'generatedAt', 'sourceMtime',
];

// ============ 路径工具 ============

function corpusRoot() {
  return paths.corpusRoot();
}

/** 与 notes/store.js:13 safeName 同口径：Windows 非法字符换 '-'，限长 80 */
function safeName(s, dft) {
  return String(s == null ? '' : s).trim().replace(/[\\/:*?"<>|]/g, '-').slice(0, 80) || dft;
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

// ============ 索引读写 ============

let _index = null;
const _srcPathCache = new Map(); // `${rel}@${sourceMtime}` → 源文件 path（避免每次 list 都读盘）

/** 只保留 11 个契约字段，多余键一律丢弃（防止 index.json 悄悄长胖） */
function pickIndexFields(rec) {
  const r = rec || {};
  const out = {};
  for (const k of INDEX_FIELDS) out[k] = r[k] === undefined ? null : r[k];
  out.corpusId = String(out.corpusId || '');
  out.rel = normRel(out.rel);
  out.name = String(out.name || '');
  out.domain = String(out.domain || '');
  out.domainLabel = String(out.domainLabel || '');
  out.profileId = String(out.profileId || '');
  out.parseMethod = String(out.parseMethod || '');
  out.chars = Number(out.chars) || 0;
  out.generatedAt = String(out.generatedAt || '');
  out.sourceMtime = Number(out.sourceMtime) || 0;
  if (out.skill !== null && typeof out.skill !== 'object') out.skill = null;
  return out;
}

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

/** 从 corpus/**\.md 的 frontmatter 全量重建索引（索引缺失/损坏时的兜底，§12.3） */
function rebuildIndex() {
  const root = corpusRoot();
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (/\.assets$/i.test(e.name)) continue; // 图片副产物目录不是语料
        walk(abs);
      } else if (/\.md$/i.test(e.name)) {
        const rec = recordFromFile(abs, path.relative(root, abs).split(path.sep).join('/'));
        if (rec) out.push(rec);
      }
    }
  };
  walk(root);
  out.sort((a, b) => Date.parse(b.generatedAt || 0) - Date.parse(a.generatedAt || 0));
  return out;
}

/** 由一个 .md 文件还原索引条目（重建与写入共用同一套映射，保证形态一致） */
function recordFromFile(abs, rel) {
  try {
    // 重建是低频兜底路径，直接整文件读，保证 chars 精确（readHead 会截断正文）
    const parsed = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
    const fm = parsed.frontmatter || {};
    const body = String(parsed.body || '').replace(/^\n+/, '');
    const src = fm.source || {};
    const parse = fm.parse || {};
    const dom = fm.domain || {};
    return pickIndexFields({
      corpusId: fm.corpusId ? String(fm.corpusId) : '',
      rel,
      name: path.basename(rel),
      domain: dom.id || '',
      domainLabel: dom.label || (path.dirname(rel) === '.' ? GENERAL_DIR : path.dirname(rel).split('/')[0]),
      profileId: fm.profileId || '',
      parseMethod: parse.method || '',
      skill: parse.skill && typeof parse.skill === 'object' ? parse.skill : null,
      chars: body.length,
      generatedAt: fm.generatedAt || '',
      sourceMtime: Number(src.mtime) || 0,
    });
  } catch (_) { return null; }
}

/** 载入索引（内存缓存）；文件缺失或 JSON 损坏 → 从语料文件全量重建 */
function loadIndex() {
  if (_index) return _index;
  const abs = path.join(corpusRoot(), INDEX_NAME);
  let arr = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
    if (Array.isArray(parsed)) arr = parsed.map(pickIndexFields).filter((r) => r.rel);
  } catch (_) { arr = null; }
  _index = arr || rebuildIndex();
  _srcPathCache.clear();
  return _index;
}

/** 落盘索引（写前统一裁到 11 字段） */
function saveIndex(list) {
  const arr = (Array.isArray(list) ? list : (_index || [])).map(pickIndexFields).filter((r) => r.rel);
  _index = arr;
  try {
    fs.mkdirSync(corpusRoot(), { recursive: true });
    fs.writeFileSync(path.join(corpusRoot(), INDEX_NAME), JSON.stringify(arr, null, 2), 'utf8');
    return true;
  } catch (_) { return false; }
}

/** 测试/切换数据根后调用：丢弃内存索引与源路径缓存 */
function invalidateIndex() {
  _index = null;
  _srcPathCache.clear();
}

// ============ 陈旧判定（§6.3 staleOf） ============

/** 索引条目里没有源文件 path（11 字段契约所限），需要时从语料文件头补一次并缓存 */
function sourcePathOf(rec) {
  const r = rec || {};
  const key = `${r.rel}@${r.sourceMtime}`;
  if (_srcPathCache.has(key)) return _srcPathCache.get(key);
  let p = '';
  try {
    const abs = absOfRel(r.rel);
    if (abs && fs.existsSync(abs)) {
      const fm = readHead(abs).frontmatter || {};
      p = String((fm.source && fm.source.path) || '');
    }
  } catch (_) { /* 读不到就当不陈旧 */ }
  _srcPathCache.set(key, p);
  return p;
}

/**
 * 源文件 mtime 变了 → true。判据口径复用 raws.js:59 isIngestedFresh：
 * 记录里没有 mtime、或源不是本地文件（url:/note:/inline:）→ 一律 false（无从判断即不报陈旧）。
 * @param {Object} rec 索引条目（sourceMtime/rel）或 frontmatter（source.{path,mtime}）
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
  let items = loadIndex().slice();
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
  const raw = String((origin || {}).name || '').replace(/\.(md|markdown)$/i, '');
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
  const index = loadIndex();
  const max = num(settings, 'corpusMaxFiles', 2000, 100, 20000);
  if (index.length <= max) return 0;
  const sorted = index
    .filter((r) => r.rel !== protectRel)
    .sort((a, b) => (Date.parse(a.generatedAt || 0) - Date.parse(b.generatedAt || 0))
      || (String(a.rel) < String(b.rel) ? -1 : 1));
  const over = index.length - max;
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

  const index = loadIndex();
  const prev = index.find((r) => r.corpusId === corpusId) || null;

  // ---- 目标 rel：优先沿用旧记录（upsert），否则 <领域>/<名称>.md ----
  const dom = (meta.domain && typeof meta.domain === 'object') ? meta.domain : null;
  const domainLabel = String((dom && dom.label) || c.domainLabel || meta.domainLabel || '');
  const dirName = safeName(domainLabel, GENERAL_DIR);
  const baseName = baseNameOf(origin, corpusId);
  let rel;
  if (prev && prev.rel) {
    rel = prev.rel;
  } else {
    rel = `${dirName}/${baseName}.md`;
    if (index.some((r) => r.rel === rel) || fs.existsSync(absOfRel(rel))) {
      rel = `${dirName}/${baseName}-${corpusId.slice(0, 6)}.md`; // 撞名（不同来源同名文件）→ 加指纹后缀
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
    domain: dom ? { id: dom.id || '', label: dom.label || '', confidence: Number(dom.confidence) || 0 } : null,
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

  // ---- 更新索引 ----
  const rec = pickIndexFields({
    corpusId,
    rel,
    name: path.basename(rel),
    domain: (dom && dom.id) || '',
    domainLabel: (dom && dom.label) || domainLabel || (dirName === GENERAL_DIR ? '' : dirName),
    profileId: fm.profileId,
    parseMethod: fm.parse.method,
    skill: fm.parse.skill,
    chars: text.length,
    generatedAt: fm.generatedAt,
    sourceMtime: Number(origin.mtime) || 0,
  });
  const next = index.filter((r) => r.rel !== rel && r.corpusId !== corpusId);
  next.unshift(rec);
  saveIndex(next);
  _srcPathCache.delete(`${rel}@${rec.sourceMtime}`);
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
    } catch (_) { /* 图片目录删不掉不影响索引更新 */ }
    for (const k of [..._srcPathCache.keys()]) if (k.startsWith(r + '@')) _srcPathCache.delete(k);
  }
  const set = new Set(list);
  saveIndex(loadIndex().filter((x) => !set.has(x.rel)));
  pruneEmptyDirs();
  return { ok: true, removed };
}

/** 删完文件后清掉空的领域目录（保留 corpus/ 根与 index.json） */
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
  writeCorpus,
  removeCorpus,
  promoteToNote,
  loadIndex,
  saveIndex,
  rebuildIndex,
  invalidateIndex,
  staleOf,
  INDEX_FIELDS,
  INDEX_NAME,
  GENERAL_DIR,
  GENERATOR,
};
