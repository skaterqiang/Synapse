// 语料流水线·装饰器基类（设计 §3.4）
// 类比 java.io.FilterInputStream：持有 this.inner 并逐方法转发，子类只覆写关心的环节。
//
// close() 的编排顺序是刻意的（§3.3）：
//   ① 先跑自己的 finish()（如 GraphMergeDecorator 在此 saveGraph）
//   ② 再 await inner.close()
//   ③ mergeResults 合并为 5 字段 StageResult
// 且 close() 幂等（C2 / 不变量 P2）：drive() 的 finally 与外层装饰器的 close() 会各触发一次，
// 不幂等就会重复落库、图谱边数翻倍。
'use strict';

const { CorpusStream, mergeResults } = require('./stream');

class CorpusDecorator extends CorpusStream {
  /** @param {CorpusStream} inner 被装饰的流（= Java 的 FilterInputStream.in） */
  constructor(inner) {
    super();
    if (!inner || typeof inner.next !== 'function') throw new TypeError('装饰器需要一个 CorpusStream 作为内层');
    this.inner = inner;
    this._closed = false;
    this._result = null;
  }

  /** 层名，用于日志与 stats 键前缀。默认取类名 */
  get layer() { return this.constructor.name; }

  /** 能力声明默认透传内层；需要增强/降级的子类覆写（如解析层把 bytes → text） */
  get caps() { return this.inner.caps; }

  async open(ctx) { await this.inner.open(ctx); }

  async next(ctx) { return this.inner.next(ctx); }

  async close(ctx) {
    if (this._closed) return this._result;
    this._closed = true;
    const own = (await this.finish(ctx)) || { ok: true, count: 0, stats: {}, warnings: [] };
    const innerRes = await this.inner.close(ctx);
    this._result = mergeResults({ ...own, layer: this.layer }, innerRes);
    return this._result;
  }

  /** 子类实现自己的收尾（如 GraphMergeDecorator 在此 saveGraph）。默认无操作 */
  async finish(ctx) { return null; }

  estimate(ctx) { return this.inner.estimate(ctx); }

  /** 向内层追加一条降级/跳过记录（不抛错，符合 §12.3 降级矩阵口径） */
  pushWarning(ctx, text) {
    if (!ctx) return;
    if (!Array.isArray(ctx.warnings)) ctx.warnings = [];
    ctx.warnings.push(String(text || ''));
  }
}

module.exports = { CorpusDecorator };
