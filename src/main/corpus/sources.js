// 语料流水线·Source 族（设计 §4.1）— 6 个 + 1 可选
// Source 只负责「产生」，不负责「加工」：读文件、读笔记、拉网页、读语料，产出 CorpusItem。
// 加工是装饰器的事（解析链、分块、抽取、合并）。
//
//   RawFileSource     原始文件引用 → kind:'raw'，带 bytes（复用 raws.js:75 listRaws 的记录形态）
//   NoteSource        笔记         → kind:'note'，带 text（等价 graph.js:248 collectSources）
//   UrlSource         网页链接     → kind:'url'，带 text（复用 files.js:882 fetchUrlMarkdown）
//   CorpusFileSource  已落盘语料   → kind:'corpus'，带 text（§6 语料库）
//   InlineSource      渲染层直传   → kind:'inline'，带 text（graph.js:274-278 分支）
//   ArraySource       程序化注入   → 测试专用，也是 CapsDecorator 的宿主
//   GroupSource       多领域一组   → 可选（§14.1 五期），默认不在配方中
'use strict';

const fs = require('fs');
const path = require('path');
const { CorpusStream } = require('./stream');
const { makeItem, originOf, noteOrigin, inlineOrigin, corpusOrigin, parseFrontmatter } = require('./item');
const { mkAbortErr } = require('./drive');

// ============ 公共工具 ============

/**
 * 把 listRaws 的记录（或渲染层传来的 relPath）解析为绝对路径。
 * 与 jobs.js:363 / ipc.js raw:open 同口径：
 *   local:<绝对路径> → 本机引用（不转存）
 *   raw/…            → <rawsRoot>/<relPath>
 */
function absOf(record, settings) {
  const r = record || {};
  const p = String(r.path || '');
  if (p.startsWith('local:')) return p.slice('local:'.length);
  if (p.startsWith('url:')) return p.slice('url:'.length);
  const { rawsRoot, safeJoin } = require('../raws/root');
  return safeJoin(rawsRoot(settings), p.replace(/^\//, ''));
}

/**
 * 把用户选中的 rawPaths 解析为 listRaws 记录（含 root/rel/size/mtime）。
 * 未在列表中的路径按「裸路径」兜底构造记录（statSync 取 size/mtime），
 * 与 jobs.js:353 的「原始来源不存在」硬失败口径不同——Source 层不抛，交给 next() 记 errors 跳过（P10）。
 */
function resolveRecords(settings, rawPaths) {
  const wanted = (rawPaths || []).map((p) => String(p));
  if (!wanted.length) return [];
  let records = [];
  try {
    const raws = require('../raws/raws');
    records = raws.listRaws(settings) || [];
  } catch (_) { records = []; }
  const byPath = new Map(records.map((r) => [String(r.path), r]));
  const out = [];
  for (const p of wanted) {
    const hit = byPath.get(p);
    if (hit) { out.push(hit); continue; }
    // 兜底：路径不在列表里（可能刚被移除/是临时路径），按本机引用形态构造
    const abs = p.startsWith('local:') ? p.slice('local:'.length) : p;
    let st = null;
    try { st = fs.statSync(abs); } catch (_) { st = null; }
    out.push({
      path: p.startsWith('local:') || p.startsWith('url:') || p.startsWith('raw/') ? p : 'local:' + abs,
      name: path.basename(abs),
      ext: path.extname(abs).replace(/^\./, '').toLowerCase(),
      size: st ? st.size : 0,
      mtime: st ? st.mtimeMs : 0,
      root: '',
      rel: '',
    });
  }
  return out;
}

// ============ RawFileSource ============

/** 原始文件引用 → kind:'raw'，带 bytes */
class RawFileSource extends CorpusStream {
  constructor(rawPaths, opts = {}) {
    super();
    this.paths = Array.isArray(rawPaths) ? rawPaths.filter(Boolean) : [];
    this.opts = opts || {};
    this.records = this.opts.records || null;
    this.i = 0;
    this._opened = false;
  }

  get caps() { return { bytes: true, text: false, graph: false, countable: true, replayable: true }; }

  async open(ctx) {
    // 复用 listRaws 的记录形态（含 root/rel/mtime），但只保留本次选中的路径
    if (!this.records) this.records = this.opts.records || resolveRecords(ctx && ctx.settings, this.paths);
    this.i = 0;
    this._opened = true;
  }

  async next(ctx) {
    if (!this._opened) await this.open(ctx);
    const c = ctx || {};
    while (this.i < this.records.length) {
      const r = this.records[this.i++];
      if (c.signal && c.signal.aborted) throw mkAbortErr();
      try {
        const bytes = fs.readFileSync(absOf(r, c.settings));
        return makeItem({ kind: 'raw', label: '原始·' + String(r.name || path.basename(absOf(r, c.settings))), origin: originOf(r), bytes });
      } catch (err) {
        // 单条失败不中断整条流（P10）
        if (!Array.isArray(c.errors)) c.errors = [];
        c.errors.push({ label: r.name, error: err.message });
        if (c.onLog) { try { c.onLog(`跳过 ${r.name}：${err.message}`); } catch (_) { /* 日志失败不影响流 */ } }
      }
    }
    return null;
  }

  estimate() {
    return {
      total: this.records ? this.records.length : this.paths.length,
      labels: (this.records || []).map((r) => String(r.name || '')),
    };
  }
}

// ============ NoteSource ============

/** 笔记 → kind:'note'，带 text（等价 graph.js:248 collectSources 的口径） */
class NoteSource extends CorpusStream {
  constructor(opts = {}) {
    super();
    this.opts = opts || {};
    this.notes = this.opts.notes || null;
    this.i = 0;
    this._opened = false;
  }

  get caps() { return { bytes: false, text: true, graph: false, countable: true, replayable: true }; }

  async open(ctx) {
    if (!this.notes) {
      const notesStore = require('../notes/store');
      this.notes = notesStore.getNotes() || [];
    }
    this.i = 0;
    this._opened = true;
  }

  async next(ctx) {
    if (!this._opened) await this.open(ctx);
    const c = ctx || {};
    while (this.i < this.notes.length) {
      const n = this.notes[this.i++];
      if (c.signal && c.signal.aborted) throw mkAbortErr();
      // 与 graph.js:248 一致：标题 + 正文，空内容的笔记跳过
      const text = '# ' + (n.title || '') + '\n' + (n.content || '');
      if (!text.trim()) continue;
      return makeItem({ kind: 'note', label: '笔记·' + (n.title || n.id), origin: noteOrigin(n), text });
    }
    return null;
  }

  estimate() {
    return { total: this.notes ? this.notes.length : -1, labels: (this.notes || []).map((n) => String(n.title || n.id || '')) };
  }
}

// ============ UrlSource ============

/** 网页链接 → kind:'url'，带 text（复用 files.js:882 fetchUrlMarkdown） */
class UrlSource extends CorpusStream {
  constructor(urls, opts = {}) {
    super();
    this.urls = (Array.isArray(urls) ? urls : []).map((u) => String(u)).filter(Boolean);
    this.opts = opts || {};
    this.i = 0;
    this._opened = false;
  }

  get caps() { return { bytes: false, text: true, graph: false, countable: true, replayable: false }; }

  async open(ctx) { this.i = 0; this._opened = true; }

  async next(ctx) {
    if (!this._opened) await this.open(ctx);
    const c = ctx || {};
    const { num } = require('../common/config');
    const timeout = num(c.settings, 'urlFetchTimeout', 30, 1, 600);
    while (this.i < this.urls.length) {
      const raw = this.urls[this.i++];
      if (c.signal && c.signal.aborted) throw mkAbortErr();
      const url = raw.startsWith('url:') ? raw.slice('url:'.length) : raw;
      try {
        const files = require('../raws/files');
        const md = await files.fetchUrlMarkdown(url, timeout);
        if (!String(md || '').trim()) {
          if (!Array.isArray(c.errors)) c.errors = [];
          c.errors.push({ label: url, error: '网页正文为空' });
          continue;
        }
        return makeItem({
          kind: 'url',
          label: '链接·' + (this.opts.titles && this.opts.titles[url] ? this.opts.titles[url] : url),
          origin: { type: 'url', path: 'url:' + url, name: url, ext: '.html', size: Buffer.byteLength(String(md), 'utf8'), mtime: Date.now() },
          text: String(md),
        });
      } catch (err) {
        if (!Array.isArray(c.errors)) c.errors = [];
        c.errors.push({ label: url, error: err.message });
        if (c.onLog) { try { c.onLog(`跳过链接 ${url}：${err.message}`); } catch (_) {} }
      }
    }
    return null;
  }

  estimate() { return { total: this.urls.length, labels: this.urls.slice() }; }
}

// ============ CorpusFileSource ============

/**
 * 已落盘语料 .md → kind:'corpus'，带 text（§6）。
 * 用途：「从语料库重新入图」——跳过全部解析，零 LLM 解析成本（§13 性能预算的重跑口径）。
 */
class CorpusFileSource extends CorpusStream {
  constructor(rels, opts = {}) {
    super();
    this.rels = (Array.isArray(rels) ? rels : []).map((r) => String(r)).filter(Boolean);
    this.opts = opts || {};
    this.items = null;
    this.i = 0;
    this._opened = false;
  }

  get caps() { return { bytes: false, text: true, graph: false, countable: true, replayable: true }; }

  async open(ctx) {
    const store = require('./store');
    const list = [];
    for (const rel of this.rels) {
      if (ctx && ctx.signal && ctx.signal.aborted) throw mkAbortErr();
      try {
        const r = store.readCorpus(rel);
        if (!r || !r.ok) {
          if (ctx && Array.isArray(ctx.errors)) ctx.errors.push({ label: rel, error: (r && r.error) || '语料读取失败' });
          continue;
        }
        const origin = corpusOrigin(r.rel, r.text, r.frontmatter);
        const fm = r.frontmatter || {};
        list.push(makeItem({
          kind: 'corpus',
          label: '语料·' + String(r.rel).replace(/\\/g, '/'),
          origin,
          text: String(r.text || ''),
          meta: {
            parseMethod: 'corpus',
            corpusFile: 'corpus/' + String(r.rel).replace(/\\/g, '/'),
            profileId: fm.profileId || '',
            domain: fm.domain || null,
            skill: (fm.parse && fm.parse.skill) || null,
            // 语料指纹沿用文件里记录的那个（同一来源重入图不应换身份）
            corpusId: fm.corpusId || '',
          },
          id: fm.corpusId || undefined,
        }));
      } catch (err) {
        if (ctx && Array.isArray(ctx.errors)) ctx.errors.push({ label: rel, error: err.message });
      }
    }
    this.items = list;
    this.i = 0;
    this._opened = true;
  }

  async next(ctx) {
    if (!this._opened) await this.open(ctx);
    const c = ctx || {};
    while (this.i < this.items.length) {
      if (c.signal && c.signal.aborted) throw mkAbortErr();
      return this.items[this.i++];
    }
    return null;
  }

  estimate() {
    return {
      total: this.items ? this.items.length : this.rels.length,
      labels: (this.items || []).map((it) => it.label),
    };
  }
}

// ============ InlineSource ============

/** 渲染层直传的 {label,text} → kind:'inline'（graph.js:274-278 的 inlineSources 分支） */
class InlineSource extends CorpusStream {
  constructor(sources) {
    super();
    this.list = (Array.isArray(sources) ? sources : [])
      .map((s) => ({ label: String((s && s.label) || '内联'), text: String((s && s.text) || ''), domain: (s && s.domain) || '' }))
      .filter((s) => s.text.trim());
    this.i = 0;
    this._opened = false;
  }

  get caps() { return { bytes: false, text: true, graph: false, countable: true, replayable: true }; }

  async open(ctx) { this.i = 0; this._opened = true; }

  async next(ctx) {
    if (!this._opened) await this.open(ctx);
    const c = ctx || {};
    while (this.i < this.list.length) {
      const s = this.list[this.i++];
      if (c.signal && c.signal.aborted) throw mkAbortErr();
      return makeItem({
        kind: 'inline',
        label: s.label,
        origin: inlineOrigin(s.label, s.text),
        text: s.text,
        meta: s.domain ? { domain: { id: s.domain, label: s.domain } } : undefined,
      });
    }
    return null;
  }

  estimate() { return { total: this.list.length, labels: this.list.map((s) => s.label) }; }
}

// ============ ArraySource（测试专用） ============

/**
 * 程序化注入。测试专用，也是 CapsDecorator 的宿主。
 * @param {Array<Object|string>} items CorpusItem 或 { label, text, kind, origin, meta } 或纯字符串
 */
class ArraySource extends CorpusStream {
  constructor(items, opts = {}) {
    super();
    this.raw = Array.isArray(items) ? items : [];
    this.opts = opts || {};
    this.items = null;
    this.i = 0;
    this._opened = false;
  }

  get caps() {
    const o = this.opts || {};
    return {
      bytes: !!o.bytes,
      text: o.text !== undefined ? !!o.text : true,
      graph: !!o.graph,
      countable: o.countable !== undefined ? !!o.countable : true,
      replayable: o.replayable !== undefined ? !!o.replayable : true,
    };
  }

  async open(ctx) {
    this.items = this.raw.map((x, idx) => {
      if (x && typeof x === 'object' && x.origin && x.meta) return x; // 已是 CorpusItem
      if (typeof x === 'string') {
        return makeItem({ kind: 'inline', label: '内联·' + (idx + 1), origin: inlineOrigin('内联·' + (idx + 1), x), text: x });
      }
      const label = String((x && x.label) || '内联·' + (idx + 1));
      return makeItem({
        kind: (x && x.kind) || 'inline',
        label,
        origin: (x && x.origin) || inlineOrigin(label, (x && x.text) || ''),
        text: x && x.text !== undefined ? String(x.text) : undefined,
        bytes: x && x.bytes,
        meta: (x && x.meta) || undefined,
        id: x && x.id,
      });
    });
    this.i = 0;
    this._opened = true;
  }

  async next(ctx) {
    if (!this._opened) await this.open(ctx);
    const c = ctx || {};
    while (this.i < this.items.length) {
      if (c.signal && c.signal.aborted) throw mkAbortErr();
      const it = this.items[this.i++];
      // opts.failOn：模拟单条读取失败（验证 P10 单条失败不断流）
      if (this.opts.failOn && this.opts.failOn.includes(it.label)) {
        if (!Array.isArray(c.errors)) c.errors = [];
        c.errors.push({ label: it.label, error: '模拟失败' });
        continue;
      }
      return it;
    }
    return null;
  }

  estimate() { return { total: this.items ? this.items.length : this.raw.length, labels: (this.items || this.raw).map((x) => String((x && x.label) || x)) }; }
}

// ============ GroupSource（可选，§14.1 五期） ============

/**
 * 多领域自动拆分后的**一组**来源 → 逐条产出，并把 meta.domain 预填为该组领域。
 * 现状「多领域自动拆分」是渲染层按组分别提交 N 个 graph 作业；有了它，N 组可在一个作业内串成一条流。
 * 默认不在配方中（子任务归属与失败重跑语义会变复杂）。
 */
class GroupSource extends CorpusStream {
  constructor(group, opts = {}) {
    super();
    this.group = group || {};
    this.inner = new RawFileSource((this.group.rawPaths) || [], opts);
    this.i = 0;
    this._opened = false;
  }

  get caps() { return this.inner.caps; }

  async open(ctx) { await this.inner.open(ctx); this._opened = true; }

  async next(ctx) {
    if (!this._opened) await this.open(ctx);
    const item = await this.inner.next(ctx);
    if (!item) return null;
    const g = this.group || {};
    if (g.domain || g.domainLabel) {
      item.meta.domain = { id: g.domainId || g.domain || '', label: g.domainLabel || g.domain || '', confidence: g.confidence || 0 };
    }
    if (g.label) item.label = g.label + '·' + item.label;
    return item;
  }

  estimate(ctx) { return this.inner.estimate(ctx); }
}

module.exports = {
  RawFileSource,
  NoteSource,
  UrlSource,
  CorpusFileSource,
  InlineSource,
  ArraySource,
  GroupSource,
  absOf,
  resolveRecords,
};
