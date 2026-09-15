// 语料流水线·数据单元与身份键（设计 §3.2 / §3.6 / §6.2）
//
// CorpusItem 是流水线上流动的**唯一**数据类型。所有装饰器只做两件事：读它、改它（或换成几条新的它）。
// 设计约束：
//   · text 是唯一必需的内容字段——下游（抽取、写笔记、落盘）只依赖 text，不依赖 bytes，
//     这让「从已存语料文件重新入图」（CorpusFileSource）与「从 PDF 现场解析入图」走完全相同的下游代码。
//   · origin **不可变**（C3 / P3）：它是身份与出处的唯一真相源，改它会破坏去重与缓存键。
//   · meta 追加式：已有键要改时写 meta.<layer>.xxx 子对象，不要原地覆盖。
'use strict';

const crypto = require('crypto');
const path = require('path');

/**
 * @typedef {Object} CorpusItem
 * @property {string}  id        稳定身份键 = 语料指纹（corpusId）。去重、缓存、子任务编号都用它
 * @property {string}  label     显示名，与现状口径一致：'原始·供电容量说明.pdf' / '笔记·xxx' / '内联'
 * @property {string}  kind      'raw' | 'note' | 'url' | 'inline' | 'corpus' | 'chunk'
 * @property {string}  [text]    Markdown 正文。解析类装饰器负责填充；未解析时为 undefined
 * @property {Buffer}  [bytes]   原始字节。仅当 caps.bytes 为真时存在（供技能解析/MinerU 用）
 * @property {Object}  origin    出处（不可变，任何装饰器都不得修改）
 * @property {Object}  meta      加工痕迹（每层只增不改）
 * @property {Object}  [graph]   AI 本体抽取产物 { nodes:[], edges:[], guardLog:[] }
 * @property {Object}  [chunks]  分块产物
 */

// origin 的 7 个字段（§12.1 硬契约；rel 仅 type='local' 时有）
const ORIGIN_KEYS = ['type', 'path', 'rel', 'name', 'ext', 'size', 'mtime'];

/**
 * 扩展名归一：'PDF' / 'pdf' / '.pdf' / '.PDF' → '.pdf'（小写、带前导点）；空值 → ''。
 *
 * 为什么必须集中在这里：本仓库存着**三套**扩展名口径——
 *   · raws.js:75 listRaws 的 `<rawsRoot>/raw` 扫描与目录引用扫描两个分支给的是**不带点**（'pdf'）
 *   · 同函数的单文件引用分支给的是 path.extname 的结果（**带点**，'.pdf'）
 *   · files.js 的 TEXTUAL_EXTS / BUILTIN_EXTS / isMineruRoutable 全都按**带点**比对
 * 任何拿 ext 去查 Set 的地方不先归一，就会静默失配（表现为一句误导人的「不支持的文件格式」）。
 */
function normExtDot(ext) {
  const e = String(ext == null ? '' : ext).trim().toLowerCase();
  if (!e) return '';
  return e.startsWith('.') ? e : '.' + e;
}

/**
 * 从 CorpusItem 推扩展名（带点、小写）：优先 origin.ext，其次 origin.name / label 的后缀。
 * 解析链与过滤链都用它，保证两处口径一致。
 */
function extOfItem(item) {
  const o = (item && item.origin) || {};
  if (o.ext) return normExtDot(o.ext);
  const base = String(o.name || (item && item.label) || '');
  return normExtDot(path.extname(base));
}

/**
 * 由 raws.listRaws 的记录（raws.js:106）构造 origin。
 * 记录形态：{ path:'local:D:/…' | 'raw/子目录/a.pdf', name, ext, size, mtime, root, rel, ingested }
 */
function originOf(record) {
  const r = record || {};
  const p = String(r.path || '');
  const isLocal = p.startsWith('local:');
  const isUrl = p.startsWith('url:');
  const name = String(r.name || (isLocal ? path.basename(p.slice('local:'.length)) : p));
  const ext = r.ext != null
    ? normExtDot(r.ext)
    : path.extname(name).toLowerCase();
  const origin = {
    type: isUrl ? 'url' : (isLocal ? 'local' : 'local'),
    path: p,
    name,
    ext,
    size: Number(r.size) || 0,
    mtime: Math.round(Number(r.mtime) || 0),
  };
  // rel 只在 type='local' 时有：raw/ 下副本用 listRaws 给的 path，本机引用用 root 相对路径
  const rel = String(r.rel || (isLocal ? '' : p));
  if (origin.type === 'local' && rel) origin.rel = rel.replace(/\\/g, '/');
  return origin;
}

/** 由笔记构造 origin（NoteSource 用；与 graph.js:248 collectSources 的口径一致） */
function noteOrigin(note) {
  const n = note || {};
  return {
    type: 'note',
    path: 'note:' + String(n.id || n.title || ''),
    name: String(n.title || n.id || '未命名笔记'),
    ext: '.md',
    size: Buffer.byteLength(String(n.content || ''), 'utf8'),
    mtime: Number(n.updatedAt || n.createdAt || 0),
  };
}

/** 由内联文本构造 origin（InlineSource 用；graph.js:274-278 inlineSources 分支） */
function inlineOrigin(label, text) {
  const body = String(text || '');
  return {
    type: 'inline',
    path: 'inline:' + String(label || '内联'),
    name: String(label || '内联'),
    ext: '.md',
    size: Buffer.byteLength(body, 'utf8'),
    mtime: Date.now(),
  };
}

/** 由语料文件构造 origin（CorpusFileSource 用） */
function corpusOrigin(rel, text, frontmatter) {
  const fm = frontmatter || {};
  const src = fm.source || {};
  const body = String(text || '');
  return {
    type: 'local',
    path: String(src.path || 'corpus:' + rel),
    rel: String(rel || '').replace(/\\/g, '/'),
    name: String(src.name || path.basename(String(rel || 'corpus.md'))),
    ext: String(src.ext || path.extname(String(src.name || rel || '')) || '.md'),
    size: Number(src.size) || Buffer.byteLength(body, 'utf8'),
    mtime: Math.round(Number(src.mtime) || 0),
  };
}

/**
 * 语料指纹（身份键）：sha1(type|path|size|mtime|skillName@version).slice(0, 16)
 * 与现状 files.js:769 extractCacheKey（sha1(absPath) + size + mtime）同构，但多一个技能维度：
 * 同一份 PDF 被不同抽取技能处理会产出不同语料。
 */
function corpusId(origin, skill) {
  const o = origin || {};
  const s = skill || {};
  const skillPart = s.name ? `${s.name}@${s.version || '0.0.0'}` : '';
  const raw = [o.type || '', o.path || '', o.size || 0, o.mtime || 0, skillPart].join('|');
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

/** 分块项 id：`${parentId}#${index}`（§3.6） */
function chunkId(parentId, index) {
  return `${parentId || ''}#${index}`;
}

/**
 * 造一条 CorpusItem。origin 会被冻结（C3 / P3：任何层改它都会破坏去重与缓存键）。
 * @param {Object} spec { kind, label, origin, text?, bytes?, meta?, id? }
 */
function makeItem(spec) {
  const s = spec || {};
  const origin = Object.freeze({ ...(s.origin || {}) });
  const item = {
    id: s.id || corpusId(origin, s.meta && s.meta.skill),
    label: String(s.label || origin.name || '未命名'),
    kind: String(s.kind || 'raw'),
    origin,
    meta: Object.assign({ provenance: [], warnings: [] }, s.meta || {}),
  };
  if (s.text !== undefined) item.text = String(s.text);
  if (s.bytes !== undefined) item.bytes = s.bytes;
  if (s.graph !== undefined) item.graph = s.graph;
  if (s.chunks !== undefined) item.chunks = s.chunks;
  return item;
}

/** 派生一条新 item（分块用）：origin 原样继承（仍不可变），meta 追加 */
function deriveItem(parent, patch) {
  const p = parent || {};
  const meta = Object.assign({}, p.meta || {}, (patch && patch.meta) || {});
  if (!Array.isArray(meta.provenance)) meta.provenance = [];
  if (!Array.isArray(meta.warnings)) meta.warnings = [];
  const item = {
    id: (patch && patch.id) || p.id,
    label: (patch && patch.label) || p.label,
    kind: (patch && patch.kind) || p.kind,
    origin: p.origin, // 直接复用同一个冻结对象，绝不重建
    meta,
  };
  const text = patch && patch.text !== undefined ? patch.text : p.text;
  if (text !== undefined) item.text = String(text);
  if (patch && patch.bytes !== undefined) item.bytes = patch.bytes;
  if (patch && patch.graph !== undefined) item.graph = patch.graph;
  if (patch && patch.chunks !== undefined) item.chunks = patch.chunks;
  return item;
}

/** 往 meta.provenance 追加一条加工痕迹（追加式，不覆盖） */
function addProvenance(item, entry) {
  if (!item || !item.meta) return item;
  if (!Array.isArray(item.meta.provenance)) item.meta.provenance = [];
  item.meta.provenance.push(Object.assign({ at: Date.now() }, entry || {}));
  return item;
}

/** 往 meta.warnings 追加一条降级记录 */
function addWarning(item, text) {
  if (!item || !item.meta) return item;
  if (!Array.isArray(item.meta.warnings)) item.meta.warnings = [];
  const s = String(text || '');
  if (s) item.meta.warnings.push(s);
  return item;
}

// ============ frontmatter 序列化 / 解析（§6.2） ============
// 语料文件头是「出处契约」：不引入 yaml 依赖，自己写够用的两层级子集
//（标量、行内对象 { a: 1 }、缩进块、短横线列表）。损坏时可从文件全量重建索引（§12.3）。

function yamlScalar(v) {
  if (v === null || v === undefined) return '""';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '0';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = String(v);
  // 含特殊字符或前后空白时加引号（内部引号转义）
  if (s === '' || /^[\s]|[\s]$|[:#\n\r"'{}[\],&*?|<>=!%@`]/.test(s)) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
  }
  return s;
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 行内对象：{ a: 1, b: x }（frontmatter 里嵌套一层时优先用行内形式，保持文件可读） */
function inlineObject(obj) {
  const parts = Object.entries(obj).map(([k, v]) => `${k}: ${yamlScalar(v)}`);
  return '{ ' + parts.join(', ') + ' }';
}

/**
 * 把 frontmatter 对象序列化为 YAML 子集文本（不含 --- 围栏）。
 * 规则：标量直出；一层对象走行内 { }；更深对象/数组走缩进块。
 */
function stringifyFrontmatter(obj) {
  const lines = [];
  const emit = (o, indent) => {
    const pad = '  '.repeat(indent);
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        if (!v.length) { lines.push(`${pad}${k}: []`); continue; }
        lines.push(`${pad}${k}:`);
        for (const el of v) {
          if (isPlainObject(el)) lines.push(`${pad}  - ${inlineObject(el)}`);
          else lines.push(`${pad}  - ${yamlScalar(el)}`);
        }
      } else if (isPlainObject(v)) {
        const nested = Object.values(v).some((x) => isPlainObject(x) || Array.isArray(x));
        if (nested) { lines.push(`${pad}${k}:`); emit(v, indent + 1); }
        else lines.push(`${pad}${k}: ${inlineObject(v)}`);
      } else {
        lines.push(`${pad}${k}: ${yamlScalar(v)}`);
      }
    }
  };
  emit(obj || {}, 0);
  return lines.join('\n');
}

function parseScalar(s) {
  const t = String(s == null ? '' : s).trim();
  if (t === '' ) return '';
  if (t === 'null' || t === '~') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^"[\s\S]*"$/.test(t)) {
    return t.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (/^'[\s\S]*'$/.test(t)) return t.slice(1, -1);
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d*\.\d+$/.test(t)) return parseFloat(t);
  return t;
}

/** 解析行内对象 / 行内数组：{ a: 1, b: "x" } 或 [1, 2] */
function parseInline(t) {
  const s = String(t || '').trim();
  if (s.startsWith('{') && s.endsWith('}')) {
    const body = s.slice(1, -1).trim();
    const out = {};
    if (!body) return out;
    // 只在引号外、且不在嵌套括号内的逗号处切分
    const parts = splitTop(body, ',');
    for (const p of parts) {
      const i = p.indexOf(':');
      if (i === -1) continue;
      out[p.slice(0, i).trim()] = parseInline(p.slice(i + 1));
    }
    return out;
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    const body = s.slice(1, -1).trim();
    if (!body) return [];
    return splitTop(body, ',').map((x) => parseInline(x));
  }
  return parseScalar(s);
}

function splitTop(s, sep) {
  const out = [];
  let depth = 0, quote = '', cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === '\\' && i + 1 < s.length) { cur += s[++i]; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '{' || c === '[') depth++;
    if (c === '}' || c === ']') depth--;
    if (c === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '' || out.length) out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x !== '');
}

/**
 * 解析 Markdown 文件开头的 frontmatter。
 * @returns {{ frontmatter: Object, body: string }} 无围栏时 frontmatter 为 {}、body 为全文
 */
function parseFrontmatter(text) {
  const src = String(text == null ? '' : text);
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: src };
  const fm = {};
  // 栈式解析缩进块：stack[i] = { obj, indent }
  const stack = [{ obj: fm, indent: -1 }];
  // 待定的列表头：`key:` 后跟缩进的 `- ` 项。必须记住**拥有该键的对象**（owner），
  // 因为此时栈顶已经是 key 对应的子对象，往栈顶写会变成 key.key 的自嵌套。
  let pendingList = null; // { owner, key, indent }
  for (const rawLine of m[1].split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const indent = (rawLine.match(/^ */) || [''])[0].length;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const line = rawLine.trim();
    if (line.startsWith('- ') || line === '-') {
      const val = line.slice(1).trim();
      if (pendingList && indent > pendingList.indent) {
        const { owner, key } = pendingList;
        if (!Array.isArray(owner[key])) owner[key] = [];   // 由空对象转为数组
        owner[key].push(parseInline(val));
      }
      continue;
    }
    const kv = line.match(/^([^:]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    const rest = kv[2].trim();
    const holder = stack[stack.length - 1].obj;
    if (rest === '') {
      // 可能是嵌套块，也可能是列表头；先建对象，遇到 '- ' 再转数组
      holder[key] = {};
      stack.push({ obj: holder[key], indent });
      pendingList = { owner: holder, key, indent };
      continue;
    }
    holder[key] = parseInline(rest);
    pendingList = null;
  }
  // 声明了块但实际是空列表（key: [] 之外的空块）→ 归一为空对象即可，保持字段存在
  return { frontmatter: fm, body: m[2] };
}

/** 组装完整语料文件内容：frontmatter 围栏 + 正文 */
function renderCorpusFile(frontmatter, body) {
  const fm = stringifyFrontmatter(frontmatter || {});
  return `---\n${fm}\n---\n\n${String(body == null ? '' : body)}`;
}

module.exports = {
  ORIGIN_KEYS,
  normExtDot,
  extOfItem,
  originOf,
  noteOrigin,
  inlineOrigin,
  corpusOrigin,
  corpusId,
  chunkId,
  makeItem,
  deriveItem,
  addProvenance,
  addWarning,
  stringifyFrontmatter,
  parseFrontmatter,
  renderCorpusFile,
};
