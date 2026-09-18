// 语料流水线·构建器（设计 §8.2）
//
// buildPipeline(recipe, ctx)：把声明式配方（recipes.js）从内向外折叠成一条装饰器链，交给 drive()。
//   · LAYERS       18 个注册键（15 默认层 + 3 可选层 group/corpusReuse/dedup）
//   · makeSource   按 payload 决定 Source 类型（raw/note/url/corpus/inline/array/group）
//   · resolveEnabled / resolveOpts  对配方里的字符串表达式求值（G7 条件层跳过）
//   · validateCaps 层序约束 O1–O5 的**构建期静态检查**（§4.4 / P9）
//
// ⚠️ 表达式求值**不用 new Function / eval**：corpus:pipelinePreview 通道允许渲染层传 recipe（§11.1），
//    字符串表达式因此可能来自进程外，编译执行等于代码注入。改用受限的 tokenizer + 递归下降解析器
//    （evalExpr）：只支持 属性访问 / 字面量 / 白名单函数调用（reasonEnabled、num）/ 逻辑与比较运算符，
//    不支持赋值、成员写入、任意标识符调用。配方是代码内常量时行为与直觉一致，外部输入时无法越权。
'use strict';

const {
  MineruDecorator, SkillMarkdownDecorator, BuiltinParseDecorator, FallbackDecorator,
  CorpusReuseDecorator,
  CacheDecorator, FilterDecorator, CorpusWriteDecorator,
  ChunkDecorator, TruncateDecorator, LimitDecorator,
  EnrichDecorator, ExtractDecorator, GuardDecorator, GraphMergeDecorator, NoteImportDecorator,
  LogDecorator, TeeDecorator, NullSink, CapsDecorator,
} = require('./decorators');
const {
  RawFileSource, NoteSource, UrlSource, CorpusFileSource, InlineSource, ArraySource, GroupSource,
} = require('./sources');

// 解析候选名 → 变换器类（FallbackDecorator 的 candidates）
const PARSE_CANDIDATES = {
  mineru: MineruDecorator,
  skill: SkillMarkdownDecorator,
  builtin: BuiltinParseDecorator,
};

// 18 个注册键（§8.2）。source 由 makeSource 专门处理，不在此表。
const LAYERS = {
  log: LogDecorator,
  filter: FilterDecorator,
  fallback: FallbackDecorator,
  cache: CacheDecorator,
  corpusWrite: CorpusWriteDecorator,
  enrich: EnrichDecorator,
  chunk: ChunkDecorator,
  truncate: TruncateDecorator,
  extract: ExtractDecorator,
  guard: GuardDecorator,
  mergeGraph: GraphMergeDecorator,
  noteImport: NoteImportDecorator,
  tee: TeeDecorator,
  limit: LimitDecorator,
  nullSink: NullSink,
  caps: CapsDecorator,
  /* 可选层（五期，§4.1–§4.3）*/
  group: GroupSource,
  corpusReuse: CorpusReuseDecorator,
  // dedup 寄宿在 filter.js（FilterDecorator.opts.dedup），启用时由 opts 开关驱动（§1.4 / O5，默认关）
};

// ---------- 受限表达式求值（无 new Function / eval）----------

// 白名单函数：只读判定，参数已在作用域内求值后传入
const EXPR_FUNCS = {
  reasonEnabled: (scope, args) => {
    const graph = require('../graph/graph');
    return graph.reasonEnabled(args.length ? args[0] : (scope.settings || {}));
  },
  num: (scope, args) => {
    const { num } = require('../common/config');
    return num(args[0] || {}, args[1], args[2], args[3], args[4]);
  },
};

/** 受限作用域：只读 settings/payload/ctx + 常量（函数调用走 EXPR_FUNCS 白名单，不入作用域） */
function makeScope(ctx) {
  const c = ctx || {};
  const graph = require('../graph/graph');
  return {
    settings: c.settings || {},
    payload: c.payload || c,
    ctx: c,
    BATCH_CHARS: graph.BATCH_CHARS,
    SOURCE_CHARS: graph.SOURCE_CHARS,
    // 透传常用运行期字段，便于配方直接引用（forceMineru/autoReason/…）
    forceMineru: c.forceMineru,
    autoReason: c.autoReason,
  };
}

// 词法：标识符/属性路径、数字、字符串、运算符
function tokenize(src) {
  const s = String(src);
  const tokens = [];
  let i = 0;
  const isIdentStart = (ch) => /[A-Za-z_$\u0080-\uFFFF]/.test(ch);
  const isIdentPart = (ch) => /[A-Za-z0-9_$\u0080-\uFFFF]/.test(ch);
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (isIdentStart(ch)) {
      let j = i;
      while (j < s.length && isIdentPart(s[j])) j++;
      tokens.push({ t: 'ident', v: s.slice(i, j) });
      i = j; continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      tokens.push({ t: 'num', v: parseFloat(s.slice(i, j)) });
      i = j; continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1; let str = '';
      while (j < s.length && s[j] !== ch) { if (s[j] === '\\') { str += s[j + 1]; j += 2; } else { str += s[j]; j++; } }
      tokens.push({ t: 'str', v: str });
      i = j + 1; continue;
    }
    // 多字符运算符优先
    const three = s.slice(i, i + 3);
    const two = s.slice(i, i + 2);
    if (three === '!==' || three === '===') { tokens.push({ t: 'op', v: three }); i += 3; continue; }
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) { tokens.push({ t: 'op', v: two }); i += 2; continue; }
    if (['!', '<', '>', '(', ')', ',', '.'].includes(ch)) { tokens.push({ t: 'op', v: ch }); i += 1; continue; }
    throw new Error('表达式含非法字符：' + ch);
  }
  return tokens;
}

// 语法：or → and → eq → rel → unary → primary（属性路径 / 字面量 / 白名单调用 / 括号）
function parseExpr(tokens, scope) {
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (v) => { const tk = tokens[pos]; if (tk && tk.t === 'op' && tk.v === v) { pos++; return true; } return false; };
  const truthy = (v) => !!v;

  function primary() {
    const tk = peek();
    if (!tk) throw new Error('表达式意外结束');
    if (tk.t === 'num') { pos++; return tk.v; }
    if (tk.t === 'str') { pos++; return tk.v; }
    if (tk.t === 'op' && tk.v === '(') { pos++; const v = orExpr(); if (!eat(')')) throw new Error('缺少右括号'); return v; }
    if (tk.t === 'ident') {
      pos++;
      const name = tk.v;
      // 字面量关键字
      if (name === 'true') return true;
      if (name === 'false') return false;
      if (name === 'null') return null;
      if (name === 'undefined') return undefined;
      // 白名单函数调用（标识符紧跟 '('）——先于作用域查找，函数名不必在 scope 里
      if (peek() && peek().t === 'op' && peek().v === '(') {
        pos++;
        const fn = EXPR_FUNCS[name];
        if (!fn) throw new Error('不允许调用的函数：' + name);
        const args = [];
        if (!eat(')')) {
          for (;;) { args.push(orExpr()); if (eat(',')) continue; if (eat(')')) break; throw new Error('参数列表语法错误'); }
        }
        return fn(scope, args);
      }
      // 属性路径 a.b.c（屏蔽 constructor/__proto__/prototype 等原型链键，杜绝顺藤摸瓜拿到可调用对象）
      let base;
      if (Object.prototype.hasOwnProperty.call(scope, name)) base = scope[name];
      else throw new Error('表达式引用了作用域外的标识符：' + name);
      while (eat('.')) {
        const nt = peek();
        if (!nt || nt.t !== 'ident') throw new Error('属性访问后缺少字段名');
        if (['constructor', '__proto__', 'prototype'].includes(nt.v)) throw new Error('禁止访问原型链属性：' + nt.v);
        pos++;
        base = base == null ? undefined : base[nt.v];
      }
      return base;
    }
    throw new Error('无法解析的 token：' + JSON.stringify(tk));
  }
  function unary() {
    if (eat('!')) return !truthy(unary());
    return primary();
  }
  function relExpr() {
    let left = unary();
    for (;;) {
      const tk = peek();
      if (tk && tk.t === 'op' && ['<', '>', '<=', '>='].includes(tk.v)) {
        pos++; const right = unary();
        left = tk.v === '<' ? left < right : tk.v === '>' ? left > right : tk.v === '<=' ? left <= right : left >= right;
      } else break;
    }
    return left;
  }
  function eqExpr() {
    let left = relExpr();
    for (;;) {
      const tk = peek();
      if (tk && tk.t === 'op' && ['===', '!==', '==', '!='].includes(tk.v)) {
        pos++; const right = relExpr();
        left = tk.v === '===' ? left === right : tk.v === '!==' ? left !== right : tk.v === '==' ? left === right : left !== right;
      } else break;
    }
    return left;
  }
  function andExpr() {
    let left = eqExpr();
    while (peek() && peek().t === 'op' && peek().v === '&&') { pos++; left = truthy(left) && truthy(eqExpr()); }
    return left;
  }
  function orExpr() {
    let left = andExpr();
    while (peek() && peek().t === 'op' && peek().v === '||') { pos++; const right = andExpr(); left = left || right; }
    return left;
  }
  const result = orExpr();
  if (pos !== tokens.length) throw new Error('表达式尾部有多余内容');
  return result;
}

/** 对字符串表达式求值；非字符串原样返回。求值失败按 undefined 处理（条件层据此跳过，不抛） */
function evalExpr(value, scope) {
  if (typeof value !== 'string') return value;
  const s = value.trim();
  if (!s) return value;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  try {
    return parseExpr(tokenize(s), scope);
  } catch (_) { return undefined; }
}

/** 层是否启用：step.enabled 缺省 = true；字符串表达式求值为 false 才跳过 */
function resolveEnabled(step, scope) {
  if (!step || step.enabled === undefined) return true;
  const v = evalExpr(step.enabled, scope);
  return v === false ? false : true;
}

/** 构造某层的 opts：逐键求值字符串表达式，剔除配方元字段（layer/enabled/kind/candidates） */
function resolveOpts(step, scope, ctx) {
  const opts = {};
  for (const [k, v] of Object.entries(step || {})) {
    if (['layer', 'enabled', 'kind', 'candidates'].includes(k)) continue;
    opts[k] = evalExpr(v, scope);
  }
  return opts;
}

// ---------- Source 构造 ----------

/**
 * 按 payload 决定 Source 类型（step.kind='raw'/'auto' 时自动判别；显式 kind 时按 kind）。
 * 判别优先级（与 graph.js:272-289 三分支同口径）：corpus > inline > url > raw > note。
 */
function makeSource(step, ctx) {
  const c = ctx || {};
  const kind = (step && step.kind) || 'auto';
  const opts = resolveOpts(step, makeScope(c), c);
  if (kind === 'array') return new ArraySource(c.shared && c.shared.collectedItems ? c.shared.collectedItems : (c.items || []), opts);
  if (kind === 'group') return new GroupSource(c.group || {}, opts);
  if (kind === 'note') return new NoteSource(opts);
  if (kind === 'url') return new UrlSource(c.urls || (c.payload && c.payload.urls) || [], opts);
  if (kind === 'corpus') return new CorpusFileSource(c.corpusRels || (c.payload && c.payload.corpusRels) || [], opts);
  if (kind === 'inline') return new InlineSource(c.inlineSources || (c.payload && c.payload.inlineSources) || []);
  // kind === 'raw' / 'auto'：按 payload 内容判别
  const corpusRels = c.corpusRels || (c.payload && c.payload.corpusRels);
  if (Array.isArray(corpusRels) && corpusRels.length) return new CorpusFileSource(corpusRels, opts);
  const inlineSources = c.inlineSources || (c.payload && c.payload.inlineSources);
  if (Array.isArray(inlineSources) && inlineSources.length) return new InlineSource(inlineSources);
  const urls = c.urls || (c.payload && c.payload.urls);
  if (Array.isArray(urls) && urls.length) return new UrlSource(urls, opts);
  const rawPaths = c.rawPaths || (c.payload && c.payload.rawPaths);
  if (Array.isArray(rawPaths) && rawPaths.length) return new RawFileSource(rawPaths, opts);
  // 兜底：全部笔记（≡ graph.js:288 collectSources）
  return new NoteSource(opts);
}

// ---------- 层序静态校验（O1–O5，§4.4 / P9）----------

/** 从最外层向内层遍历，返回层名数组（outer → inner） */
function chainLayers(stream) {
  const out = [];
  let s = stream;
  const guard = new Set();
  while (s && typeof s.next === 'function' && !guard.has(s)) {
    guard.add(s);
    out.push(s.layer || s.constructor.name);
    s = s.inner;
  }
  return out;
}

/** 找到链上某个层节点（按类名）；找不到返回 null */
function findLayer(stream, name) {
  let s = stream;
  const guard = new Set();
  while (s && typeof s.next === 'function' && !guard.has(s)) {
    guard.add(s);
    if ((s.layer || s.constructor.name) === name) return s;
    s = s.inner;
  }
  return null;
}

/**
 * 构建期层序校验。抛错 = 配方写错（开发期 bug）；降级 = 运行期能力缺失（记 warning，不抛）。
 * @returns {string[]} 降级 warning 列表
 */
function validateCaps(stream, ctx) {
  const warnings = [];
  const layers = chainLayers(stream);
  const idx = (name) => layers.indexOf(name);
  const outerOf = (a, b) => { // a 在 b 外层（数组下标更小 = 更外）
    const ia = idx(a); const ib = idx(b);
    return ia !== -1 && ib !== -1 && ia < ib;
  };

  // O1：Cache 必须在 Fallback 外层
  if (idx('CacheDecorator') !== -1 && idx('FallbackDecorator') !== -1 && !outerOf('CacheDecorator', 'FallbackDecorator')) {
    throw new Error('流水线层序错误（O1）：CacheDecorator 必须在 FallbackDecorator 外层（缓存最终解析产物）');
  }
  // O2：CorpusWrite 必须在 Chunk 内层（先落盘完整语料，再分块）
  if (idx('CorpusWriteDecorator') !== -1 && idx('ChunkDecorator') !== -1 && !outerOf('ChunkDecorator', 'CorpusWriteDecorator')) {
    throw new Error('流水线层序错误（O2）：CorpusWriteDecorator 必须在 ChunkDecorator 内层（落盘完整语料而非碎片）');
  }
  // O3：Guard 在 Extract 外、MergeGraph 内
  if (idx('GuardDecorator') !== -1 && idx('ExtractDecorator') !== -1 && !outerOf('GuardDecorator', 'ExtractDecorator')) {
    throw new Error('流水线层序错误（O3）：GuardDecorator 必须在 ExtractDecorator 外层');
  }
  if (idx('GraphMergeDecorator') !== -1 && idx('GuardDecorator') !== -1 && !outerOf('GraphMergeDecorator', 'GuardDecorator')) {
    throw new Error('流水线层序错误（O3）：GraphMergeDecorator 必须在 GuardDecorator 外层');
  }

  // O4：CorpusReuse（若启用）必须在 Cache 内层、Fallback 外层（语料复用比解析缓存更上游）
  if (idx('CorpusReuseDecorator') !== -1) {
    if (idx('CacheDecorator') !== -1 && !outerOf('CacheDecorator', 'CorpusReuseDecorator')) {
      throw new Error('流水线层序错误（O4）：CorpusReuseDecorator 必须在 CacheDecorator 内层');
    }
    if (idx('FallbackDecorator') !== -1 && !outerOf('CorpusReuseDecorator', 'FallbackDecorator')) {
      throw new Error('流水线层序错误（O4）：CorpusReuseDecorator 必须在 FallbackDecorator 外层');
    }
  }

  // Extract 的内层 caps.text 必须为真（否则「抽取层之前没有解析层」）
  const extract = findLayer(stream, 'ExtractDecorator');
  if (extract && extract.inner && extract.inner.caps && !extract.inner.caps.text) {
    throw new Error('流水线能力错误：ExtractDecorator 之前必须有解析层（内层 caps.text 为假）');
  }
  // Guard 内层 caps.graph 为假 → 降级（推理层可能缺失，P8/I5），不抛
  const guardLayer = findLayer(stream, 'GuardDecorator');
  if (guardLayer && guardLayer.inner && guardLayer.inner.caps && !guardLayer.inner.caps.graph) {
    warnings.push('护栏层内层无 graph 能力，本次跳过写入护栏');
  }
  return warnings;
}

// ---------- 主构建器 ----------

/**
 * 从内向外折叠配方 → 一条装饰器链。
 * @param {Array} recipe  配方（recipes.js，自内向外书写）
 * @param {Object} ctx    PipelineContext（drive.js makeContext 的产物）
 * @returns {import('./stream').CorpusStream} 最外层流，交给 drive()
 */
function buildPipeline(recipe, ctx) {
  if (!Array.isArray(recipe) || !recipe.length) throw new Error('流水线为空：至少需要一个 source 层');
  const scope = makeScope(ctx);
  let stream = null;
  for (const step of recipe) {
    if (!step || !step.layer) throw new Error('配方项缺少 layer 字段');
    if (!resolveEnabled(step, scope)) continue;             // 条件层：不满足则整层跳过（G7）
    if (step.layer === 'source') { stream = makeSource(step, ctx); continue; }
    const Ctor = LAYERS[step.layer];
    if (!Ctor) throw new Error('未知流水线层：' + step.layer);
    const opts = resolveOpts(step, scope, ctx);
    // FallbackDecorator 的 candidates 是「变换器名数组」→ 实例化（inner=null，纯变换器形态）
    if (step.layer === 'fallback') {
      const names = Array.isArray(step.candidates) ? step.candidates : ['mineru', 'skill', 'builtin'];
      opts.candidates = names.map((n) => {
        const C = PARSE_CANDIDATES[n];
        if (!C) throw new Error('未知解析候选：' + n);
        return new C(null, {});
      });
    }
    if (!stream) throw new Error(`流水线层「${step.layer}」缺少内层：source 必须是配方第一项`);
    stream = new Ctor(stream, opts);
  }
  if (!stream) throw new Error('流水线为空：至少需要一个 source 层');
  const warnings = validateCaps(stream, ctx);
  if (warnings.length && ctx && Array.isArray(ctx.warnings)) ctx.warnings.push(...warnings);
  return stream;
}

/**
 * 只读的「当前解析链」预览（§11.1 corpus:pipelinePreview / §16.3 设置页）。
 * 不执行任何解析，只按 settings 逐层判断启用/跳过与原因。
 * @returns {Array<{name:string, enabled:boolean, reason:string}>}
 */
function previewPipeline(recipe, ctx) {
  const scope = makeScope(ctx);
  const out = [];
  for (const step of (recipe || [])) {
    if (!step || !step.layer) continue;
    const enabled = resolveEnabled(step, scope);
    let reason = '';
    if (step.layer === 'source') reason = 'Source（' + (step.kind || 'auto') + '）';
    else if (!enabled) reason = '跳过（条件不满足：' + String(step.enabled || '') + '）';
    else if (step.layer === 'fallback') reason = '候选：' + (step.candidates || []).join('→');
    else if (step.layer === 'guard') reason = '推理层可用时启用';
    else if (step.layer === 'chunk') reason = '分块 ' + String(evalExpr(step.size, scope) || scope.BATCH_CHARS) + ' 字';
    out.push({ name: step.layer, enabled, reason });
  }
  return out;
}

module.exports = {
  LAYERS,
  PARSE_CANDIDATES,
  buildPipeline,
  makeSource,
  resolveEnabled,
  resolveOpts,
  evalExpr,
  validateCaps,
  chainLayers,
  findLayer,
  previewPipeline,
};
