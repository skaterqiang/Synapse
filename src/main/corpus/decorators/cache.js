// 语料流水线·缓存层（设计 §4.3）
//
// CacheDecorator：读写 <数据根>/extract-cache（files.js:761），命中即**跳过内层整条解析链**。
//
// 位置约束 O1：必须在 FallbackDecorator **外层**——缓存的是「最终解析产物」，不是某一路的产物。
// 放内层会导致每路各存一份、命中率暴跌（§4.4 排序约束）。
//
// 短路机制（本文件唯一的「不透明」之处，故写清）：
//   缓存必须在解析**之前**查（否则白跑一遍 LLM）、在解析**之后**写，而 O1 又要求缓存层在外层。
//   外层装饰器无法在内层取数前插手，故由内层 FallbackDecorator 主动回调外层：
//     · setPreParse(fn)  → 命中则返回已解析 item，内层直接返回、不再尝试任何候选
//     · setPostParse(fn) → 未命中且解析成功后按 files.js:858-870 的策略落盘
//   内层不支持钩子时（attached=false）自动退化为「不读不写」并给一条 warning，不报错（G7 降级）。
//
// 实现口径完全转发 files.js 的三个函数（extractCacheKey / readExtractCache / writeExtractCache），
// 含 5MB 单条上限、10 分钟 fallback TTL、>60MB 时按 mtime 保留最新 200 条的裁剪策略。
// ⚠️ 缓存键是 sha1(absPath)+size+mtime，**不含技能维度**（语料指纹 corpusId 才含）。
//    这是现状口径，刻意不改：改了会让老缓存全部失效，且「产物与现状逐字节等价」（§14.1 二期验收）无法对拍。
//    代价：换了抽取技能后需勾「强制重新解析」或等 TTL 过期。
'use strict';

const path = require('path');
const { CorpusDecorator } = require('../decorator');
const { addProvenance } = require('../item');
const { absOf } = require('../sources');

/** 取 item 的本地绝对路径；非 local 来源返回 ''（网页/笔记/内联/语料都不进解析缓存） */
function localAbsOf(item, ctx) {
  const o = (item && item.origin) || {};
  if (o.type !== 'local') return '';
  try { return absOf(o, ctx && ctx.settings); } catch (_) { return ''; }
}

class CacheDecorator extends CorpusDecorator {
  /**
   * @param {CorpusStream} inner 内层（配方里是 FallbackDecorator）
   * @param {Object} opts { noCache, forceMineru }——与 files.js:840 extractFileContent 的 opts 同名同义
   */
  constructor(inner, opts = {}) {
    super(inner);
    this.opts = opts || {};
    this.hits = 0;
    this.misses = 0;
    this.writes = 0;
    this.attached = false;
    if (inner && typeof inner.setPreParse === 'function') {
      inner.setPreParse((item, ctx) => this.tryHit(item, ctx));
      if (typeof inner.setPostParse === 'function') inner.setPostParse((item, ctx) => this.afterParse(item, ctx));
      this.attached = true;
    }
  }

  get caps() { return { ...this.inner.caps, text: true }; }

  /** 解析前：查缓存。命中 → 返回已解析 item（内层直接返回，不再尝试任何候选） */
  tryHit(item, ctx) {
    if (this.opts.forceMineru || this.opts.noCache) return null; // ≡ files.js:841
    const c = ctx || {};
    const abs = localAbsOf(item, c);
    if (!abs) return null;
    let hit = null;
    try { hit = require('../../raws/files').readExtractCache(abs, c.settings || {}); } catch (_) { hit = null; }
    if (!hit) { this.misses++; return null; }
    this.hits++;
    const out = { ...item, text: String(hit.text || '') };
    delete out.bytes; // 命中缓存就不必再持有原始字节
    out.meta = { ...(item.meta || {}) };
    out.meta.parseMethod = hit.method;
    out.meta.fromCache = true;
    if (hit.reason) out.meta.cacheReason = hit.reason;
    addProvenance(out, { layer: this.layer, at: Date.now(), ms: 0, hit: true, method: hit.method });
    return out;
  }

  /** 解析后：落盘（缓存命中来的不再回写） */
  afterParse(item, ctx) {
    if (!item || this.opts.noCache || this.opts.forceMineru) return;
    if (item.meta && item.meta.fromCache) return;
    const abs = localAbsOf(item, ctx || {});
    if (!abs) return;
    if (this.writeCache(abs, item, (ctx && ctx.settings) || {})) this.writes++;
  }

  /** 写盘策略与 files.js:858-870 逐条对齐（含 fallback 的 TTL 语义） */
  writeCache(abs, item, settings) {
    try {
      const files = require('../../raws/files');
      const text = String(item.text || '');
      if (!text) return false;
      const method = String((item.meta && item.meta.parseMethod) || 'builtin');
      const extNow = path.extname(abs).toLowerCase();
      const textual = files.TEXTUAL_EXTS.includes(extNow);
      const mineruOn = !!(files.mineruCmdParts(settings) || []).length;
      const fbReason = ((item.meta && item.meta.fallbacks) || [])
        .map((f) => f && f.error).filter(Boolean).join('；') || 'MinerU 转换失败';
      if (method === 'mineru' && files.isMineruRoutable(extNow)) {
        files.writeExtractCache(abs, text, 'mineru');
      } else if (method === 'skill') {
        // 技能解析产物长期复用；但 PDF 且 MinerU 开启时按回退口径落盘（TTL），过期重试 MinerU
        if (mineruOn && files.isMineruRoutable(extNow)) files.writeExtractCache(abs, text, 'fallback', fbReason);
        else files.writeExtractCache(abs, text, 'skill');
      } else if (!mineruOn || textual || !files.isMineruRoutable(extNow)) {
        files.writeExtractCache(abs, text, 'builtin');
      } else {
        files.writeExtractCache(abs, text, 'fallback', fbReason);
      }
      return true;
    } catch (_) { return false; } // 缓存写失败不影响主流程（files.js:834 同口径）
  }

  async finish(ctx) {
    const warnings = [];
    if (!this.attached) warnings.push('缓存层未能挂到解析链上（内层不支持 preParse 钩子），本次不读写解析缓存');
    return {
      ok: true,
      count: 0,
      stats: { cacheHits: this.hits, cacheMisses: this.misses, cacheWrites: this.writes },
      warnings,
    };
  }
}

module.exports = { CacheDecorator, localAbsOf };
