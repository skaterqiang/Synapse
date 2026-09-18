// 语料流水线·分块 / 截断 / 限流层（设计 §4.3）
//
//   ChunkDecorator     长文按 corpusChunkChars（缺省 6000，≡ graph.js:126 BATCH_CHARS）切块，
//                      **一条变多条**（kind:'chunk'，id=`${parentId}#${index}`）。解决 §1.2 的
//                      「1500 字硬截断」：语料先完整落盘（CorpusWriteDecorator 在本层内层，O2），
//                      再分块喂 LLM，一份 3 万字 PDF 因此产生 >1 个抽取任务（G5）。
//   TruncateDecorator  按 SOURCE_CHARS（1500）或 settings.sourceMaxChars 截断，置 meta.truncated。
//                      兼容老行为用（settings.pipeline=false 时 graph.js 仍走 1500 字硬截断）。
//   LimitDecorator     条数上限（drive 的 maxItems 之外的层内兜底）。
//
// ⚠️ P13（§12.2 不变量）：子任务粒度恒等于「来源」，不随分块变化。
//    故 ChunkDecorator.estimate() **只转发内层**（不乘块数）——作业子任务列表由 Source 的
//    estimate 决定，分块只发生在流内部。任何让 job.source.items.length 随分块变化的实现都破坏 P13。
'use strict';

const { CorpusDecorator } = require('../decorator');
const { deriveItem, chunkId, addProvenance } = require('../item');
const { num } = require('../../common/config');

// 缺省分块大小：与 graph.js:126 BATCH_CHARS 一致（设计 §10.1 corpusChunkChars 缺省值）
const DEFAULT_CHUNK_CHARS = 6000;
// 缺省截断长度：与 graph.js:128 SOURCE_CHARS 一致（兼容老行为）
const DEFAULT_SOURCE_CHARS = 1500;

/**
 * 把一段文本切成 ≤size 字的块，尽量在段落 / 句子边界断开，避免把一句话劈成两半。
 * 算法（参考「按语义边界贪心装填」）：
 *   ① 先按空行切段落；
 *   ② 逐段累加，超过 size 就收口成一块；
 *   ③ 单段本身就超 size 时，再按句子（。！？!?\n）细切；
 *   ④ 单句仍超 size 时硬切（保证不丢字）。
 * @returns {string[]} 至少 1 块（空文本返回 ['']，由调用方决定是否跳过）
 */
function splitText(text, size) {
  const body = String(text == null ? '' : text);
  const cap = Math.max(200, Number(size) || DEFAULT_CHUNK_CHARS);
  if (body.length <= cap) return [body];
  const paragraphs = body.split(/\n{2,}/);
  const chunks = [];
  let cur = '';
  const flush = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ''; };
  const pushHard = (seg) => {
    // 单段超长：按句子细切，句子仍超长则硬切
    const sentences = seg.split(/(?<=[。！？!?；;\n])/);
    let piece = '';
    for (const s of sentences) {
      if (!s) continue;
      if ((piece + s).length > cap) {
        if (piece.trim()) chunks.push(piece.trim());
        piece = '';
        if (s.length > cap) {
          for (let i = 0; i < s.length; i += cap) chunks.push(s.slice(i, i + cap));
          continue;
        }
      }
      piece += s;
    }
    if (piece.trim()) chunks.push(piece.trim());
  };
  for (const p of paragraphs) {
    if (!p.trim()) continue;
    if (p.length > cap) { flush(); pushHard(p); continue; }
    if ((cur + '\n\n' + p).length > cap) flush();
    cur += (cur ? '\n\n' : '') + p;
  }
  flush();
  return chunks.length ? chunks : [body.slice(0, cap)];
}

// ============ ChunkDecorator ============

/**
 * 一条变多条：把长语料切成若干 chunk 项。
 * 拉取式流无法「一次返回多条」，故本层维护一个待产出队列：
 *   inner.next() 取到一条 → 切块入队 → 逐次 next() 吐出，队列空了再取下一条。
 */
class ChunkDecorator extends CorpusDecorator {
  constructor(inner, opts = {}) {
    super(inner);
    this.opts = opts || {};
    this.queue = [];        // 待吐出的 chunk 项
    this.sources = 0;       // 消费了多少条「来源」（= 内层条目数）
    this.chunks = 0;        // 产出了多少条「块」
    this._size = null;
  }

  get caps() { return { ...this.inner.caps, text: true }; }

  /** 分块大小：opts.size 显式 > settings.corpusChunkChars > 6000（§10.1） */
  chunkSize(ctx) {
    if (this._size != null) return this._size;
    if (Number(this.opts.size) > 0) this._size = Number(this.opts.size);
    else this._size = num((ctx && ctx.settings) || {}, 'corpusChunkChars', DEFAULT_CHUNK_CHARS, 1000, 40000);
    return this._size;
  }

  async next(ctx) {
    const c = ctx || {};
    for (;;) {
      if (this.queue.length) return this.queue.shift();
      const item = await this.inner.next(c);
      if (!item) return null;
      this.sources++;
      const text = String(item.text == null ? '' : item.text);
      // 空正文 / 已是 chunk 的条目不再切（避免二次分块）
      if (!text.trim() || item.kind === 'chunk') { this.queue.push(item); continue; }
      const size = this.chunkSize(c);
      const parts = text.length <= size ? [text] : splitText(text, size);
      const total = parts.length;
      const t0 = Date.now();
      for (let i = 0; i < total; i++) {
        const chunk = deriveItem(item, {
          id: total > 1 ? chunkId(item.id, i) : item.id,
          kind: total > 1 ? 'chunk' : item.kind,
          label: total > 1 ? `${item.label}（${i + 1}/${total}）` : item.label,
          text: parts[i],
          meta: { chunk: { index: i, total } },
        });
        // origin 原样继承（deriveItem 复用同一冻结对象，C3/P3）
        this.queue.push(chunk);
        this.chunks++;
      }
      if (total > 1) addProvenance(item, { layer: this.layer, at: Date.now(), ms: Date.now() - t0, chunks: total });
    }
  }

  /** P13：子任务粒度 = 来源数，estimate 只转发内层，绝不乘块数 */
  estimate(ctx) { return this.inner.estimate(ctx); }

  async finish(ctx) {
    return {
      ok: true,
      count: this.chunks,
      stats: { chunkSources: this.sources, chunkParts: this.chunks, chunkSize: this.chunkSize(ctx) },
      warnings: [],
    };
  }
}

// ============ TruncateDecorator ============

/**
 * 截断到 SOURCE_CHARS（1500）或 settings.sourceMaxChars，置 meta.truncated。
 * 这是「兼容老行为」的层：settings.pipeline=false 时 graph.js 仍按 1500 字硬截断（§10.3），
 * 需要在新链里复现同一口径时，用它替换 ChunkDecorator 的位置。
 */
class TruncateDecorator extends CorpusDecorator {
  constructor(inner, opts = {}) {
    super(inner);
    this.opts = opts || {};
    this.truncated = 0;
    this.count = 0;
  }

  get caps() { return { ...this.inner.caps, text: true }; }

  limit(ctx) {
    if (Number(this.opts.chars) > 0) return Number(this.opts.chars);
    const s = (ctx && ctx.settings) || {};
    // useSourceChars=true → 用 1500（老图谱口径）；否则用 sourceMaxChars（解析口径，默认 60000）
    if (this.opts.useSourceChars) return num(s, 'corpusSourceChars', DEFAULT_SOURCE_CHARS, 100, 1000000);
    return num(s, 'sourceMaxChars', 60000, 1000, 1000000);
  }

  async next(ctx) {
    const c = ctx || {};
    const item = await this.inner.next(c);
    if (!item) return null;
    this.count++;
    const text = String(item.text == null ? '' : item.text);
    const cap = this.limit(c);
    if (text.length > cap) {
      this.truncated++;
      item.text = text.slice(0, cap);
      item.meta.truncated = true;
      addProvenance(item, { layer: this.layer, at: Date.now(), ms: 0, from: text.length, to: cap });
    }
    return item;
  }

  async finish(ctx) {
    return { ok: true, count: this.count, stats: { truncated: this.truncated }, warnings: [] };
  }
}

// ============ LimitDecorator ============

/** 条数上限：吐够 max 条后返回 null（drive 的 ctx.maxItems 之外的层内兜底，辅助层） */
class LimitDecorator extends CorpusDecorator {
  constructor(inner, opts = {}) {
    super(inner);
    this.opts = opts || {};
    this.max = Number(this.opts.max) > 0 ? Number(this.opts.max) : 0;
    this.n = 0;
  }

  async next(ctx) {
    if (this.max > 0 && this.n >= this.max) return null;
    const item = await this.inner.next(ctx);
    if (!item) return null;
    this.n++;
    return item;
  }

  estimate(ctx) {
    const inner = this.inner.estimate(ctx) || { total: -1, labels: [] };
    if (this.max > 0 && inner.total >= 0) return { total: Math.min(inner.total, this.max), labels: (inner.labels || []).slice(0, this.max) };
    return inner;
  }

  async finish(ctx) {
    return { ok: true, count: this.n, stats: { limited: this.max }, warnings: [] };
  }
}

module.exports = { ChunkDecorator, TruncateDecorator, LimitDecorator, splitText, DEFAULT_CHUNK_CHARS, DEFAULT_SOURCE_CHARS };
