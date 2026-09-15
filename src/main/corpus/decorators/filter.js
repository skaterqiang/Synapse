// 语料流水线·过滤层（设计 §4.3）
//
// FilterDecorator：紧跟 Source 的第一层，把「注定处理不了 / 不必处理」的条目挡在昂贵的 LLM 层之前。
//
// 三种过滤口径（可叠加）：
//   extWhitelist    只放行解析链真能处理的扩展名（内置解析 ∪ MinerU ∪ 图片 ∪ 笔记导入白名单）。
//                   现状是「不支持的格式在解析时抛错、整条作业失败」；这里改为提前跳过 + 日志，
//                   与 FallbackDecorator 的 P10（单条失败不中断）口径一致。
//   canImportAsNote 只放行 files.js:41 canImportAsNote 认可的扩展名（NOTE_RECIPE 用，≡ jobs.js:344 的 allowed 集合）
//   dedup           跳过「已吸收且来源未变化」的条目（raws.js:59 isIngestedFresh）
//                   ⚠️ **默认关闭**：§15 问题 3 的去重判据尚未拍板（等外部《提取去重判断方案.md》），
//                      且 markIngested/isIngestedFresh 目前在代码里零调用点，贸然启用会让老作业静默少处理文件。
//
// 被过滤的条目**不算失败**：只计数 + 写日志，不进 ctx.errors（与「解析失败」区分开）。
'use strict';

const { CorpusDecorator } = require('../decorator');
// 扩展名归一工具住在 item.js（而非本文件）：解析链（decorators/parse.js）与过滤链都要用同一口径，
// 放在共同的下层模块里可以避免 decorators/ 内部横向 require。本文件仍再导出一份（兼容旧引用）。
const { normExtDot, extOfItem } = require('../item');

class FilterDecorator extends CorpusDecorator {
  /**
   * @param {CorpusStream} inner
   * @param {Object} opts { extWhitelist, canImportAsNote, dedup, predicate, onSkip }
   */
  constructor(inner, opts = {}) {
    super(inner);
    this.opts = opts || {};
    this.passed = 0;
    this.dropped = 0;
    this.byReason = {};
    this._allowed = null;
  }

  /** 解析链能处理的扩展名全集（懒算一次；随 settings 变化时由 build 重新构造本层） */
  allowedExts(ctx) {
    if (this._allowed) return this._allowed;
    const set = new Set();
    try {
      const files = require('../../raws/files');
      const { MINERU_IMAGE_EXTS, MINERU_SUPPORTED_EXTS } = require('../../common/constants');
      const { BUILTIN_EXTS } = require('./parse');
      for (const e of BUILTIN_EXTS) set.add(normExtDot(e));
      for (const e of files.TEXTUAL_EXTS) set.add(normExtDot(e));
      for (const e of (MINERU_IMAGE_EXTS || [])) set.add(normExtDot(e));
      for (const e of (MINERU_SUPPORTED_EXTS || [])) set.add(normExtDot(e));
      for (const e of files.noteImportExts((ctx && ctx.settings) || {})) set.add(normExtDot(e));
    } catch (_) { /* 常量缺失时不做白名单过滤（宁多勿漏） */ }
    this._allowed = set;
    return set;
  }

  /** 返回 '' = 放行；返回非空字符串 = 过滤原因 */
  reason(item, ctx) {
    const c = ctx || {};
    const o = (item && item.origin) || {};
    const ext = extOfItem(item);

    // ① 自定义判据优先（配方构建器可注入任意业务过滤）
    if (typeof this.opts.predicate === 'function') {
      const r = this.opts.predicate(item, c);
      if (r) return String(r);
    }

    // ② 笔记导入白名单（NOTE_RECIPE）：≡ jobs.js:344 canImportAsNote(settings, record.name)
    if (this.opts.canImportAsNote) {
      let ok = false;
      try { ok = require('../../raws/files').canImportAsNote(c.settings || {}, String(o.name || item.label || '')); } catch (_) { ok = false; }
      if (!ok) return `不在笔记导入白名单内（${ext || '无扩展名'}）`;
    }

    // ③ 解析能力白名单（GRAPH_RECIPE / CORPUS_RECIPE）
    //    已有文本的条目（笔记 / 内联 / 语料 / 网页）不需要解析，一律放行
    if (this.opts.extWhitelist && !(typeof item.text === 'string' && item.text.trim())) {
      const allowed = this.allowedExts(c);
      if (allowed.size && !allowed.has(ext)) return `无可用解析器（${ext || '无扩展名'}）`;
    }

    // ④ 去重（默认关闭，§15 问题 3 待拍板）
    if (this.opts.dedup && o.path) {
      let fresh = false;
      try { fresh = require('../../raws/raws').isIngestedFresh(String(o.path)); } catch (_) { fresh = false; }
      if (fresh) return '已吸收且来源未变化';
    }
    return '';
  }

  async next(ctx) {
    const c = ctx || {};
    for (;;) {
      const item = await this.inner.next(c);
      if (!item) return null;
      const why = this.reason(item, c);
      if (!why) { this.passed++; return item; }
      this.dropped++;
      this.byReason[why] = (this.byReason[why] || 0) + 1;
      if (!c.stats || typeof c.stats !== 'object') c.stats = {};
      c.stats.filtered = (c.stats.filtered || 0) + 1;
      const label = item.label || (item.origin && item.origin.name) || '未知来源';
      if (c.onLog) { try { c.onLog(`跳过 ${label}：${why}`); } catch (_) { /* 忽略 */ } }
      if (typeof this.opts.onSkip === 'function') {
        try { this.opts.onSkip(item, why, c); } catch (_) { /* 回调失败不影响过滤 */ }
      }
    }
  }

  async finish(ctx) {
    return {
      ok: true,
      count: 0,
      stats: { filtered: this.dropped, passed: this.passed, ...this.byReason },
      warnings: [],
    };
  }
}

module.exports = { FilterDecorator, normExtDot, extOfItem };
