// 语料流水线·统一接口基类（设计 §3.3）
// 语义与 java.io.InputStream 对齐：open 一次、next 多次、close 一次。
// 所有 Source / Decorator / 终端层都继承它——「互相装饰调用」的唯一契约。
//
// 三条硬约定（§3.4 C1–C3，违反即出 bug，已写进 §12.2 不变量表 P1–P3）：
//   C1 next() 返回 null 后不得复活（否则 drive() 死循环）
//   C2 close() 幂等（否则重复 saveGraph，图谱边数翻倍）
//   C3 不得修改 item.origin；meta 只增不改
'use strict';

/**
 * 每层 close() 的返回体。字段数 = 5，是测试硬契约（§12.1）。
 * @typedef {Object} StageResult
 * @property {boolean} ok        本层是否成功（部分失败仍可为 true，失败明细在 warnings）
 * @property {number}  count     本层实际产出/消费的条数
 * @property {Object}  stats     本层统计（各层自定义键，合并时不覆盖内层同名键）
 * @property {string[]} warnings 降级/跳过记录，最终进作业卡片
 * @property {string}  error     ok=false 时的原因
 */

/** 空结果：各层 finish() 未显式返回时的兜底 */
function emptyResult() {
  return { ok: true, count: 0, stats: {}, warnings: [], error: '' };
}

/**
 * 结果合并：外层统计优先，内层统计保留（键冲突时外层加 `<层名>.` 前缀）。
 * @param {StageResult & {layer?: string}} outer 外层（装饰器自身）结果
 * @param {StageResult} inner 内层结果
 * @returns {StageResult}
 */
function mergeResults(outer, inner) {
  const o = outer || emptyResult();
  const i = inner || emptyResult();
  const stats = { ...(i.stats || {}) };
  for (const [k, v] of Object.entries(o.stats || {})) {
    stats[k in stats ? `${o.layer || 'outer'}.${k}` : k] = v;
  }
  return {
    ok: o.ok !== false && i.ok !== false,
    count: o.count != null ? o.count : (i.count != null ? i.count : 0),
    stats,
    warnings: [...(i.warnings || []), ...(o.warnings || [])],
    error: o.error || i.error || '',
  };
}

class CorpusStream {
  /**
   * 能力声明：外层据此判断内层能否满足自己（类比 markSupported()）。
   * 构造期即固定，不随 next 变化。
   */
  get caps() {
    return {
      bytes: false,      // 能提供 item.bytes（原始字节）
      text: false,       // 能提供 item.text（Markdown 正文）
      graph: false,      // 能提供 item.graph（抽取产物）
      countable: false,  // estimate() 能给出准确条数（用于作业子任务列表）
      replayable: false, // 可重复 open→next→close（FallbackDecorator 需要内层具备此能力）
    };
  }

  /** 层名，用于日志与 stats 键前缀。默认取类名 */
  get layer() { return this.constructor.name; }

  /** 建立资源。约定：先 await inner.open(ctx)，再初始化自己（自内向外）。幂等 */
  async open(ctx) { /* 基类无资源 */ }

  /**
   * 取下一条语料；返回 null 表示流已结束（此后再次调用仍返回 null）。
   * 这是唯一的数据通道——装饰器通过调用 inner.next() 实现「互相装饰调用」。
   * @returns {Promise<import('./item').CorpusItem|null>}
   */
  async next(ctx) { return null; }

  /**
   * 释放资源并返回本层结果。约定：先做自己的收尾，再 await inner.close(ctx)，最后 mergeResults 合并。
   * 必须在 finally 中调用（drive() 保证）。重复调用返回同一结果。
   * @returns {Promise<StageResult>}
   */
  async close(ctx) { return emptyResult(); }

  /** 预估条数（作业子任务列表用）。countable 为假时返回 { total: -1 } */
  estimate(ctx) { return { total: -1, labels: [] }; }
}

module.exports = { CorpusStream, mergeResults, emptyResult };
