// 语料流水线·领域/体系归属层（设计 §4.3 EnrichDecorator）
//
// 职责：在解析之后、抽取之前，为每条语料确定「挂到哪个领域、用哪套本体体系」。
//   ① 体系解析：沿用 graph.js:293-336 的五级优先级链
//        显式(ctx.profileId/ontologyProfile) → 领域模版绑定(tplProfile) → settings.ontologyProfile → bfo-lite
//   ② 领域归属：把 ctx.domainId/domainLabel/typeHints 落到 item.meta.domain / item.meta.profileId
//   ③ 'collect' 阶段文案（§7.4）：来源数 + 领域 + 相似度 + 体系（两阶段），对照 graph.js:334
//
// ⚠️ 领域的「发现」（matchTemplate / suggestTemplateName / generateTemplate / suggestOntologyProfile）
//    是**作业级**的一次性 LLM 归纳，需要全部来源内容，住在 jobs.js:660 resolveAutoDomain。
//    本层通过 ctx.resolveDomain 回调消费其结果（回调由 graph.js 适配层在「收集相」之后注入），
//    不在流内部逐条调用——否则每条语料都会触发一次慢模型归纳。
//    这与设计 §4.3「suggestDomains→assignDomains→suggestOntologyProfile」的差别仅在于
//    「归纳一次、逐条套用」而非「逐条归纳」，产物口径一致。
'use strict';

const { CorpusDecorator } = require('../decorator');
const { addProvenance } = require('../item');

class EnrichDecorator extends CorpusDecorator {
  constructor(inner, opts = {}) {
    super(inner);
    this.opts = opts || {};
    this.count = 0;
    this._resolved = false;
  }

  get caps() { return { ...this.inner.caps, text: true }; }

  async open(ctx) {
    await this.inner.open(ctx);
    const c = ctx || {};
    if (!c.shared) c.shared = {};
    if (!c.stats) c.stats = {};
    await this.resolveDomainAndProfile(c);
  }

  /**
   * 体系 + 领域解析（open 期一次）。等价 graph.js:291-335。
   * 结果写回 ctx，供 ExtractDecorator（读 ctx.onto/ctx.profileId/ctx.typeHints）与本层 next 使用。
   */
  async resolveDomainAndProfile(ctx) {
    if (this._resolved) return;
    this._resolved = true;
    const c = ctx;
    const settings = c.settings || {};

    // ---- ① 领域发现（作业级回调 resolveDomain，可能触发 LLM；失败一律回退通用，绝不拖垮作业）----
    // 回调需要「全部来源内容」，由 graph.js 适配层在收集相之后写入 ctx.shared.sourcePreviews。
    // 与 graph.js:299 同口径：只要传了 resolveDomain 就调（其结果覆盖显式领域）；
    // jobs.js 在 autoDomain===false 时传 undefined，此时不调、直接用显式 domainId/domainLabel。
    const needResolve = typeof c.resolveDomain === 'function'
      && Array.isArray(c.shared.sourcePreviews) && c.shared.sourcePreviews.length;
    if (needResolve) {
      try {
        const r = await c.resolveDomain(c.shared.sourcePreviews);
        if (r) {
          if (r.typeHints) c.typeHints = r.typeHints;
          if (r.domainLabel) c.domainLabel = r.domainLabel;
          if (r.domainId && r.domainId !== 'general') c.domainId = r.domainId;
          if (r.ontologyProfile) c.tplProfile = r.ontologyProfile;
          if (r.profileReason) c.profileReason = r.profileReason;
          if (r.profileSimilarity) c.profileSimilarity = r.profileSimilarity;
          if (r.domainSimilarity) c.domainSimilarity = r.domainSimilarity;
        }
      } catch (_) { /* 归纳失败回退通用，与 jobs.js:754 同口径 */ }
    }

    let hints = c.typeHints || null;
    let domLabel = c.domainLabel || '';
    let domainTag = c.domainId && c.domainId !== 'general' ? c.domainId : '';
    let tplProfile = c.ontologyProfile === '__explicit__' ? '' : (c.tplProfile || '');
    let profileReason = c.profileReason || '';
    let profileSimilarity = Number(c.profileSimilarity) || 0;
    let domainSimilarity = Number(c.domainSimilarity) || 0;

    // 显式体系（弹窗指定 / 模型动态选择，均以 ctx.profileId 或 ctx.ontologyProfile 传入）
    const explicitPid = c.profileId || (typeof c.ontologyProfile === 'string' && c.ontologyProfile !== '__explicit__' ? c.ontologyProfile : '') || '';

    // 指定已有领域（未走 resolveDomain）时，主动读该领域模版绑定的体系（≡ graph.js:312-318）
    if (!tplProfile && domainTag && domainTag !== 'general') {
      try {
        const { listTemplates } = require('../../graph/templates');
        const tpl = listTemplates().find((t) => t.id === domainTag);
        if (tpl && tpl.ontologyProfile) tplProfile = tpl.ontologyProfile;
      } catch (_) { /* 模版层缺失时忽略 */ }
    }

    // 体系五级链（③ 模型动态选择在调用方已折进 explicitPid）
    const graph = require('../../graph/graph');
    const pid = explicitPid || tplProfile || (settings && settings.ontologyProfile) || 'bfo-lite';
    const onto = graph.resolveOntology(pid);
    const profileId = onto.id;
    const twoStage = onto.promptMode === 'two-stage';

    // 写回 ctx（下游 ExtractDecorator / GuardDecorator / GraphMergeDecorator 消费）
    c.onto = onto;
    c.profileId = profileId;
    c.profileName = onto.name;
    c.twoStage = twoStage;
    c.typeHints = hints;
    c.domainLabel = domLabel;
    c.domainId = domainTag;
    c.domainSimilarity = domainSimilarity;
    c.profileReason = profileReason;
    c.profileSimilarity = profileSimilarity;
    c.fallbackRel = graph.fallbackRel(profileId);

    // ---- ③ 'collect' 阶段文案（对照 graph.js:325-334）----
    if (c.onStage) {
      const est = this.estimate(c) || { total: -1 };
      const n = est.total >= 0 ? est.total : (Array.isArray(c.shared.sourcePreviews) ? c.shared.sourcePreviews.length : '?');
      const ent = (hints && hints.entity) || [];
      const con = (hints && hints.concept) || [];
      const domText = ent.length || con.length
        ? `领域「${domLabel || domainTag}」（实体〔${ent.join('、')}〕；概念〔${con.join('、')}〕）`
        : `领域「${domLabel || domainTag || '通用'}」（未附加实体/概念类型约束）`;
      const domSim = domainSimilarity ? `（相似度 ${domainSimilarity}%）` : '';
      const profSim = profileReason ? `（相似度 ${profileSimilarity}%，${profileReason}）` : '';
      try {
        c.onStage('collect', 'running', `共 ${n} 个来源，${domText}${domSim}，体系「${onto.name}」${profSim}${twoStage ? '（两阶段）' : ''}，开始分批抽取…`);
      } catch (_) { /* 阶段回调失败不影响流 */ }
    }
  }

  async next(ctx) {
    const c = ctx || {};
    if (!this._resolved) await this.resolveDomainAndProfile(c);
    const item = await this.inner.next(c);
    if (!item) return null;
    this.count++;
    // 领域归属：Source 已预填（InlineSource/GroupSource）则尊重，否则套作业级领域
    const meta = item.meta || (item.meta = {});
    if (!meta.domain || (!meta.domain.id && !meta.domain.label)) {
      if (c.domainId || c.domainLabel) {
        meta.domain = { id: c.domainId || '', label: c.domainLabel || '', confidence: c.domainSimilarity ? c.domainSimilarity / 100 : 0 };
      }
    }
    if (!meta.profileId) meta.profileId = c.profileId;
    addProvenance(item, { layer: this.layer, at: Date.now(), ms: 0, profileId: c.profileId, domain: (meta.domain && meta.domain.id) || '' });
    return item;
  }

  async finish(ctx) {
    return {
      ok: true,
      count: this.count,
      stats: { enriched: this.count, profileId: (ctx && ctx.profileId) || '' },
      warnings: [],
    };
  }
}

module.exports = { EnrichDecorator };
