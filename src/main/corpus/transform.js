// 条目级变换器接口（语料流水线设计 §4.2）
//
// 全文只有 2 个接口：
//   · CorpusStream（stream.js）——流级，G1 要求的统一接口，next() 拉取语义
//   · CorpusTransform（本文件）——条目级，**仅解析回退链需要**
//
// 为什么必须有第二个接口：next() 的拉取语义无法回退（取出去就取出去了），
// 而「MinerU 失败 → 技能解析 → 内置解析」的回退必须发生在**同一条目**上。
// 因此 FallbackDecorator 不包装一条流，而是包装**一组变换器**。
//
// MineruDecorator / SkillMarkdownDecorator / BuiltinParseDecorator 同时实现两者：
//   单独用时是流装饰器（next() 内部调 apply()）；被 FallbackDecorator 编排时是变换器。
'use strict';

/**
 * @typedef {import('./item').CorpusItem} CorpusItem
 */

class CorpusTransform {
  /** 层名，用于 meta.provenance / 日志 / 错误定位 */
  get layer() { return this.constructor.name; }

  /**
   * 我是否适用于这一条（**不实际执行**，只判断）。
   * 返回 false ⇒ FallbackDecorator 直接跳到下一个候选，不计入 fallbacks[]（这不是失败）。
   * @param {CorpusItem} item
   * @param {Object} ctx PipelineContext
   * @returns {boolean}
   */
  accepts(item, ctx) { return true; }

  /**
   * 加工一条。
   * @returns {Promise<CorpusItem|null>} 返回 item = 加工完成；返回 null = 我处理不了（触发回退，不算失败）；
   *   抛异常 = 我失败了（触发回退，并记入 meta.fallbacks[] 与 warnings）
   */
  async apply(item, ctx) { return item; }
}

module.exports = { CorpusTransform };
