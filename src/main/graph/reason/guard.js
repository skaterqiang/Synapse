'use strict';

// ---------------------------------------------------------------------------
// reason/guard.js — domain/range 写入护栏（设计文档 §4.3）
//
// 职责：写边前校验 (fromNode.type, rel, toNode.type) 是否符合谓词的
//       定义域/值域约束，不符合则降级为 fallbackRel 并**记日志**。
//
// ⚠️ 现实约束（已核实 constants.js）：三个内置体系的谓词**都没有**
//    domain/range 字段，定义域/值域只以 PropertyDomain/PropertyRange 公理
//    的形式存在于 bfo（2 对）与 iso15926（2 对）；bfo-lite 一条都没有。
//    而 owl.js 导入的体系恰好相反——domain/range 挂在谓词上、公理表为空。
//    因此本模块一律走 bridge.normalizeProfile 的**双源合并视图**，
//    两处都没有约束时 checkEdge 返回 ok:true（不拦截），绝不臆造约束。
// ---------------------------------------------------------------------------

const { normalizeProfile } = require('./bridge');

// normalizeProfile 有点开销（要算祖先闭包），同一体系在一次提取里会被
// 调用成千上万次，按体系 id + 规模做一层 memo。
const modelCache = new Map();
const CACHE_MAX = 8;

function modelOf(profile) {
  if (!profile) return normalizeProfile(null);
  const sig = (profile.id || '?') + '|' + (profile.classes || []).length
    + '|' + (profile.predicates || []).length + '|' + (profile.axioms || []).length
    + '|' + (profile._userRev || '');
  const hit = modelCache.get(sig);
  if (hit) return hit;
  const m = normalizeProfile(profile);
  if (modelCache.size >= CACHE_MAX) modelCache.clear();
  modelCache.set(sig, m);
  return m;
}

/** 测试或体系被编辑后调用，避免 memo 命中过期视图。 */
function clearCache() { modelCache.clear(); }

/**
 * child 是否为 ancestor 的子类（含自身）。沿 profile.classes[].parent 上溯，
 * 并合并 SubClassOf 公理。带环保护（导入的体系可能有 A⊑B、B⊑A）。
 *
 * 未知类（不在体系类表里，例如 LLM 幻觉出的类型或已回退的类型）：
 * 返回 false —— 但调用方应注意，checkEdge 对「类型未知」单独给理由，
 * 不与真正的 domain 冲突混为一谈。
 */
function isSubClassOf(profile, child, ancestor) {
  if (!child || !ancestor) return false;
  if (child === ancestor) return true;
  const m = modelOf(profile);
  return m.ancestorsOf(child).has(ancestor);
}

/** 体系里是否声明了该类。 */
function isKnownClass(profile, typeKey) {
  if (!typeKey) return false;
  const m = modelOf(profile);
  return m.classLabel.has(typeKey);
}

/** 体系里是否声明了该谓词。 */
function isKnownPredicate(profile, relKey) {
  if (!relKey) return false;
  const m = modelOf(profile);
  return m.relLabel.has(relKey);
}

/**
 * 该谓词在本体系下是否有 domain/range 约束（用于 UI 展示护栏覆盖度）。
 * @returns {{domain:string[], range:string[], hasAny:boolean}}
 */
function constraintOf(profile, relKey) {
  const m = modelOf(profile);
  const domain = [...(m.domain.get(relKey) || [])];
  const range = [...(m.range.get(relKey) || [])];
  return { domain, range, hasAny: !!(domain.length || range.length) };
}

/**
 * 一条边 (from, rel, to) 会把哪些端点强制归入哪些类 —— **含逆谓词物化**。
 *
 * 推理器按 prp-inv1/inv2 会把 (from, rel, to) 物化成 (to, rel', from)
 * （rel' ∈ inverseOf(rel)），因此强制类型不止来自 rel 自身的 domain/range：
 *   - 直连：from 受 domain(rel) 强制、to 受 range(rel) 强制（prp-dom / prp-rng）
 *   - 逆边：to 作为逆边起点受 domain(rel') 强制、from 作为逆边终点受 range(rel') 强制
 * 典型场景：bfo 的 bearer_of 自身无约束，但其逆 inheres_in 的 domain=
 * specifically_dependent_continuant，于是 (mitochondrion, bearer_of, atp_synthase)
 * 会把 atp_synthase 强制归入特依存持续体，与其声明类型 object 互斥（cax-dw）。
 * 修复规划 / 全图校验 / 写侧预检三处必须用同一口径，否则会出现「推理报冲突、
 * 修复却定位不到诱导边 → 误判需人工」。
 *
 * @returns {Array<{node:'from'|'to', via:'domain'|'range', forced:string[], rel:string, inverse:boolean}>}
 */
function forcingProbes(profile, rel) {
  const m = modelOf(profile);
  const out = [];
  const push = (node, via, forced, r, inverse) => {
    if (forced && forced.length) out.push({ node, via, forced: [...forced], rel: r, inverse });
  };
  const c0 = constraintOf(profile, rel);
  push('from', 'domain', c0.domain, rel, false);
  push('to', 'range', c0.range, rel, false);
  for (const inv of (m.inverseOf.get(rel) || [])) {
    const c = constraintOf(profile, inv);
    push('to', 'domain', c.domain, inv, true);
    push('from', 'range', c.range, inv, true);
  }
  return out;
}

/**
 * 校验一条待写入的边。
 *
 * @param {object} profile   已 resolveOntology 的体系
 * @param {{id?:string,name?:string,type?:string}} fromNode
 * @param {string} rel
 * @param {{id?:string,name?:string,type?:string}} toNode
 * @param {object} [opts]
 * @param {boolean} [opts.strictUnknownType=false]  类型不在体系类表里时是否也算违规
 *        （默认 false：提取阶段类型已回退到 fallbackType，未知类型多为体系外自定义类，
 *          拦下来只会把大量正常边降级，噪声大于收益）
 * @returns {{ok:true}|{ok:false, reason:string, expected?:string[], actual?:string,
 *            fallback?:string, rel?:string, detail?:string}}
 */
function checkEdge(profile, fromNode, rel, toNode, opts = {}) {
  const m = modelOf(profile);
  const fallback = m.fallbackRel || '';
  const fromType = (fromNode && fromNode.type) || '';
  const toType = (toNode && toNode.type) || '';

  // 1) 未知谓词：LLM 造了体系外的关系词
  if (!m.relLabel.has(rel)) {
    return {
      ok: false, reason: 'unknown-predicate', rel,
      expected: [...m.relLabel.keys()], actual: rel, fallback,
      detail: `谓词「${rel}」不在体系受控词表中`,
    };
  }

  const dom = m.domain.get(rel);
  const rng = m.range.get(rel);

  // 2) 定义域校验：fromNode.type 必须 ⊑ pred.domain 之一
  //    OWL 语义下多个 rdfs:domain 是**合取**（主体须同时属于所有 domain），
  //    但 Synapse 的体系里每个谓词至多一个 domain 公理，这里按「任一满足即通过」
  //    处理会放宽语义；按「全部满足」处理才与 prp-dom + scm-dom1 的物化结果一致。
  //    取严格解：所有声明的 domain 都必须是 fromType 的祖先（含自身）。
  if (dom && dom.size) {
    if (!fromType) {
      return { ok: false, reason: 'domain-violation', rel, expected: [...dom], actual: '(无类型)', fallback };
    }
    const anc = m.ancestorsOf(fromType);
    const missing = [...dom].filter((d) => !anc.has(d));
    if (missing.length) {
      return {
        ok: false, reason: 'domain-violation', rel,
        expected: [...dom], actual: fromType, fallback,
        detail: `「${(fromNode && fromNode.name) || fromType}」的类型 ${fromType} 不属于 ${missing.join('/')} 及其子类`,
      };
    }
  }

  // 3) 值域校验：同理
  if (rng && rng.size) {
    if (!toType) {
      return { ok: false, reason: 'range-violation', rel, expected: [...rng], actual: '(无类型)', fallback };
    }
    const anc = m.ancestorsOf(toType);
    const missing = [...rng].filter((r) => !anc.has(r));
    if (missing.length) {
      return {
        ok: false, reason: 'range-violation', rel,
        expected: [...rng], actual: toType, fallback,
        detail: `「${(toNode && toNode.name) || toType}」的类型 ${toType} 不属于 ${missing.join('/')} 及其子类`,
      };
    }
  }

  // 4) 可选：类型必须在体系类表内
  if (opts.strictUnknownType) {
    if (fromType && !m.classLabel.has(fromType)) {
      return { ok: false, reason: 'unknown-type', rel, actual: fromType, fallback, detail: `起点类型 ${fromType} 不在体系类表中` };
    }
    if (toType && !m.classLabel.has(toType)) {
      return { ok: false, reason: 'unknown-type', rel, actual: toType, fallback, detail: `终点类型 ${toType} 不在体系类表中` };
    }
  }

  return { ok: true };
}

/**
 * 不相交类冲突检测（cax-dw 的写前版本）。
 * 推理器会在物化时报 conflict，但那时边已入库；这里供提取阶段提前拦截，
 * 也供「推理」Tab 展示体系声明了哪些不相交约束。
 *
 * @returns {{conflict:boolean, pairs:Array<[string,string]>, detail?:string}}
 */
function checkDisjoint(profile, typeA, typeB) {
  const m = modelOf(profile);
  if (!typeA || !typeB || !m.disjoint.length) return { conflict: false, pairs: [] };
  const ancA = m.ancestorsOf(typeA);
  const ancB = m.ancestorsOf(typeB);
  const pairs = [];
  for (const [x, y] of m.disjoint) {
    if ((ancA.has(x) && ancB.has(y)) || (ancA.has(y) && ancB.has(x))) pairs.push([x, y]);
  }
  return {
    conflict: pairs.length > 0,
    pairs,
    detail: pairs.length
      ? `${typeA} 与 ${typeB} 分别落入不相交类 ${pairs.map((p) => p.join(' / ')).join('；')}`
      : undefined,
  };
}

/**
 * 护栏覆盖度统计 —— 供「推理」Tab 告诉用户当前体系有多少谓词受护栏保护。
 * 这是回应「内置体系没有 domain/range」这一现实的显式呈现，而不是静默失效。
 */
function coverage(profile) {
  const m = modelOf(profile);
  const total = m.predicates.length;
  let withDomain = 0, withRange = 0, withAny = 0;
  const detail = [];
  for (const p of m.predicates) {
    const d = (m.domain.get(p.key) || new Set()).size;
    const r = (m.range.get(p.key) || new Set()).size;
    if (d) withDomain++;
    if (r) withRange++;
    if (d || r) { withAny++; detail.push({ key: p.key, label: p.label || p.key, domain: [...(m.domain.get(p.key) || [])], range: [...(m.range.get(p.key) || [])] }); }
  }
  return {
    profileId: m.id,
    predicates: total,
    withDomain, withRange, withAny,
    coveragePct: total ? Math.round((withAny / total) * 100) : 0,
    detail,
    transitive: [...m.transitive],
    symmetric: [...m.symmetric],
    inversePairs: [...m.inverseOf.entries()].map(([k, v]) => [k, [...v]]),
    disjointPairs: m.disjoint,
    classCount: m.classes.length,
    axiomCount: m.axioms.length,
  };
}

/**
 * 护栏日志汇总（供作业摘要「护栏拦截 N 条越界连线」与「推理」Tab 明细）。
 * @param {Array} logEntries  checkEdge 返回的 verdict + 上下文
 */
function summarizeGuardLog(logEntries) {
  const entries = Array.isArray(logEntries) ? logEntries : [];
  const byReason = {};
  const byRel = {};
  for (const e of entries) {
    const r = (e && e.reason) || 'unknown';
    byReason[r] = (byReason[r] || 0) + 1;
    const rel = (e && e.rel) || '?';
    byRel[rel] = (byRel[rel] || 0) + 1;
  }
  return {
    total: entries.length,
    byReason,
    byRel,
    // 明细最多留 200 条，防止一次提取产生上万条越界把 kv 撑爆
    entries: entries.slice(0, 200),
    truncated: entries.length > 200,
  };
}

module.exports = {
  checkEdge,
  isSubClassOf,
  isKnownClass,
  isKnownPredicate,
  constraintOf,
  forcingProbes,
  checkDisjoint,
  coverage,
  summarizeGuardLog,
  clearCache,
};
