// 语料流水线·可观测性与辅助层（设计 §4.3 辅助层）
//
//   LogDecorator   桥接 jobLog / setStage / task tracker；统计每层耗时；累积 provenance（§6.2）；
//                  LLM 调用数超阈值时提示（§13 红线：>100 次只提示、不阻断、不设硬上限）
//   TeeDecorator   一分二：主链透传，副本交给另一条流抽干（同时写语料文件 + 入图时用）
//   NullSink       终端占位：next() 恒返回 null、什么都不做
//   CapsDecorator  强制覆写能力声明（测试用，宿主是 ArraySource）
//
// 这四个属「工具性质」，不计入 §4.3 的 11 个加工装饰器。
'use strict';

const { CorpusStream } = require('../stream');
const { CorpusDecorator } = require('../decorator');
const { addProvenance } = require('../item');

// LLM 调用数提示阈值（§13 性能预算 / §15 问题 4 拍板：不设硬上限，>100 时提示）
const LLM_CALL_HINT_AT = 100;

/**
 * 透明日志层：不改变数据，只负责把流水线内部事件桥接到作业基础设施。
 * 位置任意（§4.3），默认配方里放在 Source 之外第一层（§8.1 GRAPH_RECIPE）。
 */
class LogDecorator extends CorpusDecorator {
  constructor(inner, opts = {}) {
    super(inner);
    this.opts = opts || {};
    this.count = 0;
    this.startedAt = 0;
    this._llmHinted = false;
  }

  async open(ctx) {
    await super.open(ctx);
    this.startedAt = Date.now();
    this.count = 0;
    if (!ctx) return;
    if (!ctx.shared) ctx.shared = {};
    if (!Array.isArray(ctx.shared.provenance)) ctx.shared.provenance = [];
    const est = this.estimate(ctx);
    // 'collect' 阶段文案（§7.4）：来源数由 estimate 给出，领域/体系文案由 EnrichDecorator 补
    if (this.opts.stageKey && ctx.onStage) {
      ctx.onStage(this.opts.stageKey, 'running', this.opts.detail || `共 ${est.total >= 0 ? est.total : '?'} 个来源，开始处理…`);
    }
    if (ctx.onLog) {
      try { ctx.onLog(`流水线启动：${est.total >= 0 ? est.total + ' 个来源' : '来源数未知'}`); } catch (_) { /* 日志失败不影响流 */ }
    }
  }

  async next(ctx) {
    const item = await super.next(ctx);
    if (!item) return null;
    this.count++;
    // 每条都记一行加工痕迹（§6.2 provenance 审计链）
    addProvenance(item, { layer: this.layer, at: Date.now(), ms: 0, index: this.count });
    if (ctx && ctx.shared && Array.isArray(ctx.shared.provenance)) {
      ctx.shared.provenance.push({ layer: this.layer, id: item.id, label: item.label, at: Date.now(), index: this.count });
    }
    // LLM 调用数红线提示：只在跨过阈值时提示一次，不阻断作业（§15 问题 4）
    if (ctx && ctx.stats && Number(ctx.stats.llmCalls) > LLM_CALL_HINT_AT && !this._llmHinted) {
      this._llmHinted = true;
      const msg = `本次抽取调用较多（${ctx.stats.llmCalls} 次），建议调大分块阈值或缩小来源范围`;
      if (ctx.onLog) { try { ctx.onLog('⚠ ' + msg); } catch (_) {} }
      if (!Array.isArray(ctx.warnings)) ctx.warnings = [];
      ctx.warnings.push(msg);
    }
    return item;
  }

  async finish(ctx) {
    const ms = this.startedAt ? Date.now() - this.startedAt : 0;
    if (ctx && ctx.shared && Array.isArray(ctx.shared.provenance)) {
      ctx.shared.provenance.push({ layer: this.layer, at: Date.now(), ms, count: this.count });
    }
    const warnings = [];
    // 单条失败明细（P10：单条失败不断流，但要如实上报到作业卡片）
    for (const e of (ctx && ctx.errors) || []) {
      warnings.push(`${e.label || '未知来源'}：${e.error || '处理失败'}`);
    }
    for (const w of (ctx && ctx.warnings) || []) warnings.push(String(w));
    return { ok: true, count: this.count, stats: { elapsedMs: ms }, warnings };
  }
}

/**
 * 一分二：主链原样透传，副本交给 side 流（另一条完整流水线或终端装饰器）。
 * 副本失败不影响主链（记 warning），符合 §12.3 降级矩阵口径。
 */
class TeeDecorator extends CorpusDecorator {
  constructor(inner, side, opts = {}) {
    super(inner);
    this.side = side;
    this.opts = opts || {};
    this.sideCount = 0;
  }

  async open(ctx) {
    await super.open(ctx);
    if (this.side && typeof this.side.open === 'function') await this.side.open(ctx);
  }

  async next(ctx) {
    const item = await super.next(ctx);
    if (!item || !this.side) return item;
    try {
      // 副本是「泵」语义：把 item 推给 side 的处理入口（side 需实现 push 或 next）
      if (typeof this.side.push === 'function') await this.side.push(item, ctx);
      this.sideCount++;
    } catch (err) {
      if (!Array.isArray(ctx.warnings)) ctx.warnings = [];
      ctx.warnings.push(`副本流处理失败（不影响主链）：${err.message}`);
    }
    return item;
  }

  async finish(ctx) {
    let sideRes = null;
    if (this.side && typeof this.side.close === 'function') {
      try { sideRes = await this.side.close(ctx); } catch (err) { sideRes = { ok: false, count: 0, stats: {}, warnings: ['副本流收尾失败：' + err.message], error: err.message }; }
    }
    return {
      ok: true,
      count: this.sideCount,
      stats: { sideCount: this.sideCount },
      warnings: (sideRes && sideRes.warnings) || [],
    };
  }
}

/** 终端占位：next() 恒返回 null、什么都不做（§3.5「为什么合并存图不需要独立 Sink」） */
class NullSink extends CorpusStream {
  constructor(opts = {}) { super(); this.opts = opts || {}; this.count = 0; }
  get caps() { return { bytes: false, text: true, graph: true, countable: true, replayable: false }; }
  async open(ctx) { this.count = 0; }
  async next(ctx) { return null; }
  async close(ctx) { return { ok: true, count: this.count, stats: {}, warnings: [], error: '' }; }
  /** 供 TeeDecorator 调用：收下副本并计数 */
  async push(item, ctx) { this.count++; if (this.opts.onItem) await this.opts.onItem(item, this.count); }
  estimate() { return { total: -1, labels: [] }; }
}

/** 强制覆写能力声明（测试用）：验证 validateCaps 的 O1–O5 静态检查（P9） */
class CapsDecorator extends CorpusDecorator {
  constructor(inner, caps) {
    super(inner);
    this._caps = Object.assign({}, inner && inner.caps, caps || {});
  }
  get caps() { return this._caps; }
}

module.exports = { LogDecorator, TeeDecorator, NullSink, CapsDecorator, LLM_CALL_HINT_AT };
