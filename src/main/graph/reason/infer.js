'use strict';

// ---------------------------------------------------------------------------
// reason/infer.js — 推理调度（设计文档 §4.2）
//
// 职责：把 Synapse 图谱 + 体系桥接成 TripleStore，跑 OWL 2 RL 物化，
//       把推理产物转回 Synapse 边。
//
// D3：本模块**不写 kv**，只返回结果，由 graph.js 决定持久化。
// D4：批处理，不做实时推理。
// ---------------------------------------------------------------------------

const { OWL2RLReasoner } = require('@skaterqiang/protege-js/src/inference/OWL2RLReasoner');
const { ReasonerQueries } = require('@skaterqiang/protege-js/src/inference/ReasonerQueries');
const bridge = require('./bridge');

/**
 * 规则集本体（用于重扫取回完整冲突消息，见 recoverInconsistencyMessages）。
 * 取不到时降级为 reasoner 自带的残缺记录，不影响主流程。
 */
let RL_RULES = null;
try {
  ({ rules: RL_RULES } = require('@skaterqiang/protege-js/src/inference/rules/owl2rl'));
  if (!RL_RULES || typeof RL_RULES !== 'object') RL_RULES = null;
} catch (_) { RL_RULES = null; }

const DEFAULT_MAX_ROUNDS = 1000;
/** 超过该规模时在 UI 提示进度（设计文档 §4.2 性能预算）。 */
const PROGRESS_HINT_EDGES = 20000;

/** protege-js 是否可用（打包/依赖缺失时整体降级，不阻断提取）。 */
function reasonerAvailable() {
  try {
    require('@skaterqiang/protege-js/src/inference/OWL2RLReasoner');
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 取回完整的冲突消息。
 *
 * ⚠️ 上游缺陷（已实测复现，protege-js@0.1.0 OWL2RLReasoner.materialize）：
 * ```js
 * const conflict = (rule, msg) => this._conflict(rule, msg);
 * for (const [id, fn] of Object.entries(rules)) {
 *   fn(this.store, add, (msg) => conflict(id, msg));   // ← 只转发 1 个实参
 * }
 * ```
 * 规则内部一律按 `conflict('prp-asyp', `${x} ${p} ${y} and reverse`)` 两参调用，
 * 但包装箭头函数只声明了 `(msg)`，于是 **第一个实参（规则名字面量）被当成 message，
 * 真正的描述被丢弃**。实测结果：`inconsistencies === [{rule:'prp-asyp', message:'prp-asyp'}]`。
 * 后果：UI 只能显示规则代号，用户看不到「谁和谁冲突」，§4.2 的一致性告警形同虚设；
 * 且 `_conflict` 按 (rule,message) 去重，同一规则的 N 处冲突会被压成 1 条。
 *
 * 修法：物化到定点后，只重跑「报过冲突的那几条规则」，自己传一个两参 conflict 收集器。
 * 定点后 add 一律返回 false（不再新增三元组），冲突检测规则都是对 store 的纯查询，
 * 因此重扫是幂等的，且能把被去重压掉的其余冲突一并捞回来。
 *
 * @returns {Array<{rule:string, message:string}>}
 */
function recoverInconsistencyMessages(store, reasoner) {
  const found = (reasoner && reasoner.inconsistencies) || [];
  const fallback = found.map((c) => ({ rule: c && c.rule, message: c && c.message }));
  if (!found.length || !RL_RULES || !store) return fallback;

  const wanted = [...new Set(found.map((c) => c && c.rule).filter(Boolean))];
  const seen = new Set();
  const recovered = [];
  const noopAdd = () => false;
  const conflict = (rule, msg) => {
    const message = String(msg == null ? '' : msg);
    const key = `${rule}\u0001${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    recovered.push({ rule: String(rule || ''), message });
  };

  for (const id of wanted) {
    const fn = RL_RULES[id];
    if (typeof fn !== 'function') continue;
    try { fn(store, noopAdd, conflict); } catch (_) { /* 单条规则失败不影响其余 */ }
  }

  // 重扫一条都没捞到（规则名对不上等异常情况）→ 退回上游的残缺记录，至少保留 rule
  return recovered.length ? recovered : fallback;
}

/**
 * 对图谱跑一次 OWL 2 RL 物化。
 *
 * @param {{nodes:Array, edges:Array}} graph
 * @param {object} profile  已 resolveOntology 的体系
 * @param {object} [opts]
 * @param {number}  [opts.maxRounds=1000]  物化最大轮数（SWRL/传递闭包防死循环）
 * @param {number}  [opts.timeoutMs=30000] 超时后放弃推理、保留原始边（§9 风险 2）
 * @param {boolean} [opts.annotations=true] 是否写入 rdfs:label 等字面量
 * @param {(info:{phase:string, pct?:number})=>void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{
 *   inferredEdges:Array, inconsistencies:Array, stats:object,
 *   queries:object|null, ctx:object|null, skipped:boolean, skipReason?:string }>}
 */
async function materializeGraph(graph, profile, opts = {}) {
  const t0 = Date.now();
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const report = (phase, pct) => { if (onProgress) { try { onProgress({ phase, pct }); } catch (_) {} } };

  const empty = {
    inferredEdges: [], inconsistencies: [], queries: null, ctx: null, skipped: true,
    stats: { inputTriples: 0, inferredCount: 0, rounds: 0, elapsedMs: 0 },
  };

  if (!reasonerAvailable()) return Object.assign(empty, { skipReason: 'reasoner-unavailable' });
  if (!graph || !Array.isArray(graph.nodes) || !graph.nodes.length) {
    return Object.assign(empty, { skipReason: 'empty-graph' });
  }

  const maxRounds = num(opts.maxRounds, DEFAULT_MAX_ROUNDS, 1, 100000);
  const timeoutMs = num(opts.timeoutMs, 30000, 100, 600000);

  report('桥接图谱为三元组…');
  let bridged;
  try {
    bridged = bridge.graphToTriples(graph, profile, { annotations: opts.annotations !== false });
  } catch (err) {
    return Object.assign(empty, { skipReason: 'bridge-failed', error: String(err && err.message || err) });
  }
  const { store, ctx, stats } = bridged;

  // 没有任何可触发规则的公理（无传递/对称/互逆/domain/range/子类层级）时，
  // 物化只会产出 eq-ref 的 sameAs 噪声，直接跳过省时间。
  const m = ctx.model;
  const hasRuleFuel = m.transitive.size || m.symmetric.size || m.inverseOf.size
    || m.domain.size || m.range.size || m.parentsOf.size || m.disjoint.length
    || (m.axioms || []).some((a) => /SubPropertyOf|EquivalentProperties/.test(a && a.type));
  if (!hasRuleFuel) {
    return Object.assign(empty, {
      skipReason: 'no-rule-fuel', ctx,
      stats: Object.assign(stats, { elapsedMs: Date.now() - t0 }),
    });
  }

  const reasoner = new OWL2RLReasoner(store);
  const bigGraph = stats.edges >= PROGRESS_HINT_EDGES;
  report(bigGraph ? `物化推理中（${stats.edges} 条边，可能需要数秒）…` : '物化推理中…');

  // protege-js 的 materialize 是同步的，无法从内部中断。
  // 用「先检查 → 再跑 → 跑完检查」的方式实现超时/中止：
  // 超时后丢弃推理结果、保留原始边（§9 风险 2 的既定降级策略）。
  if (opts.signal && opts.signal.aborted) {
    return Object.assign(empty, { skipReason: 'aborted', ctx, stats: Object.assign(stats, { elapsedMs: Date.now() - t0 }) });
  }

  let rounds = 0, inferredCount = 0;
  try {
    inferredCount = reasoner.materialize(maxRounds);
    rounds = reasoner.getRounds();
  } catch (err) {
    return Object.assign(empty, {
      skipReason: 'materialize-failed', ctx,
      error: String(err && err.message || err),
      stats: Object.assign(stats, { elapsedMs: Date.now() - t0 }),
    });
  }

  const elapsedMs = Date.now() - t0;
  if (elapsedMs > timeoutMs || (opts.signal && opts.signal.aborted)) {
    return Object.assign(empty, {
      skipReason: elapsedMs > timeoutMs ? 'timeout' : 'aborted', ctx,
      stats: Object.assign(stats, { inferredCount, rounds, elapsedMs }),
    });
  }

  report('回收推理边…');
  const { edges: inferredEdges, stats: revStats } =
    bridge.triplesToInferredEdges(store, reasoner, ctx, { reasonerId: opts.reasonerId || 'owl2rl' });

  // 冲突消息里的 IRI 换成人话（节点名/类标签/谓词标签）。
  // 先用 recoverInconsistencyMessages 绕过上游「message 丢失」缺陷取回完整描述。
  // 再经 enrichConflicts 补「归属知识图谱（scope）+ 中文原因」，
  // scopeLabelOf 由调用方注入（infer 不依赖 templates，缺省用 domain 原值）。
  const inconsistencies = bridge.enrichConflicts(
    recoverInconsistencyMessages(store, reasoner).map((c) => ({
      rule: c.rule,
      message: bridge.humanizeIris(c.message, ctx),
      raw: c.message,
    })),
    ctx, graph.nodes, opts.scopeLabelOf,
  );

  let queries = null;
  try { queries = new ReasonerQueries(reasoner); } catch (_) { /* 查询层可选 */ }

  return {
    inferredEdges,
    inconsistencies,
    queries,
    ctx,
    skipped: false,
    stats: {
      inputTriples: stats.edges,
      inputNodes: stats.nodes,
      skippedEdges: stats.skippedEdges,
      staleInferred: stats.staleInferred,
      classes: stats.classes,
      predicates: stats.predicates,
      triplesBefore: stats.triples,
      triplesAfter: store.size(),
      inferredCount,
      inferredEdges: revStats.inferredEdges,
      unjustified: revStats.unjustified,
      rounds,
      elapsedMs,
    },
  };
}

/**
 * 把推理边并入原始边数组，并把 inferredFromKeys 换成最终数组下标。
 *
 * 为什么按下标：设计文档 §5.1 规定 `inferredFrom: [edgeIdx,...]` 存的是
 * 原 edges 数组下标，级联清理（§5.3）靠下标集合做不动点传播。
 * 但下标只在「最终数组」确定后才有意义，所以桥接期先存身份键，
 * 合并后再一次性绑定 —— 见 bindProvenance。
 *
 * @param {Array} rawEdges     原始边（不含 inferred）
 * @param {Array} inferredEdges materializeGraph 产出的推理边
 * @returns {{edges:Array, bound:number, dropped:number}}
 */
function mergeInferredEdges(rawEdges, inferredEdges) {
  const base = Array.isArray(rawEdges) ? rawEdges.filter((e) => e && !e.inferred) : [];
  const out = base.slice();
  const keyToIdx = new Map();
  out.forEach((e, i) => {
    const k = bridge.edgeKey(e.from, e.to, e.rel || '');
    if (!keyToIdx.has(k)) keyToIdx.set(k, i);
  });

  let bound = 0, dropped = 0;
  for (const ie of (inferredEdges || [])) {
    if (!ie || !ie.from || !ie.to) { dropped++; continue; }
    const k = bridge.edgeKey(ie.from, ie.to, ie.rel || '');
    if (keyToIdx.has(k)) { dropped++; continue; }   // 已有同身份原始边
    const keys = Array.isArray(ie.inferredFromKeys) ? ie.inferredFromKeys : [];
    const idxs = [];
    for (const pk of keys) {
      const at = keyToIdx.get(pk);
      if (at !== undefined && !idxs.includes(at)) idxs.push(at);
    }
    const edge = {
      from: ie.from, to: ie.to, rel: ie.rel,
      inferred: true,
      inferredFrom: idxs,
      inferredVia: ie.inferredVia || 'unknown',
      inferredAt: ie.inferredAt || Date.now(),
      inferredBy: ie.inferredBy || 'owl2rl',
    };
    keyToIdx.set(k, out.length);
    out.push(edge);
    if (idxs.length) bound++;
  }
  return { edges: out, bound, dropped };
}

/**
 * 级联清理（设计文档 §5.3）。
 * 删除某条边时，把所有（直接或间接）依赖它的推理边一并删除，迭代到不动点。
 *
 * 兼容两种溯源表示：
 *   - inferredFrom: [下标]      （mergeInferredEdges 绑定后的正常形态）
 *   - inferredFromKeys: [身份键] （未经绑定时的兜底，按 from|to|rel 匹配）
 *
 * @param {{edges:Array}} graph  会被就地修改（graph.edges 被替换）
 * @param {number|number[]} edgeIdxOrList  要删除的下标（可多个）
 * @returns {{removed:number, cascaded:number, edges:Array}}
 */
function removeEdgeWithCascade(graph, edgeIdxOrList) {
  const edges = (graph && Array.isArray(graph.edges)) ? graph.edges : [];
  const seeds = (Array.isArray(edgeIdxOrList) ? edgeIdxOrList : [edgeIdxOrList])
    .map((i) => Number(i)).filter((i) => Number.isInteger(i) && i >= 0 && i < edges.length);
  if (!seeds.length) return { removed: 0, cascaded: 0, edges };

  const removed = new Set(seeds);
  // 身份键 → 下标，供 inferredFromKeys 兜底匹配
  const keyToIdx = new Map();
  edges.forEach((e, i) => {
    if (!e) return;
    const k = bridge.edgeKey(e.from, e.to, e.rel || '');
    if (!keyToIdx.has(k)) keyToIdx.set(k, i);
  });

  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < edges.length; i++) {
      if (removed.has(i)) continue;
      const e = edges[i];
      if (!e || !e.inferred) continue;
      let hit = false;
      if (Array.isArray(e.inferredFrom)) {
        hit = e.inferredFrom.some((idx) => removed.has(Number(idx)));
      }
      if (!hit && Array.isArray(e.inferredFromKeys)) {
        hit = e.inferredFromKeys.some((k) => { const at = keyToIdx.get(k); return at !== undefined && removed.has(at); });
      }
      if (hit) { removed.add(i); changed = true; }
    }
  }

  const kept = edges.filter((_, i) => !removed.has(i));
  if (graph) graph.edges = kept;
  return { removed: removed.size, cascaded: removed.size - seeds.length, edges: kept };
}

/**
 * 删除节点时的级联清理：先删所有触及该节点的边，再沿溯源链传播。
 * @returns {{removed:number, cascaded:number}}
 */
function removeNodeWithCascade(graph, nodeId) {
  const edges = (graph && Array.isArray(graph.edges)) ? graph.edges : [];
  const seeds = [];
  edges.forEach((e, i) => { if (e && (e.from === nodeId || e.to === nodeId)) seeds.push(i); });
  if (!seeds.length) return { removed: 0, cascaded: 0 };
  const r = removeEdgeWithCascade(graph, seeds);
  return { removed: r.removed, cascaded: r.cascaded };
}

/** 统计图谱里的推理边数量（供 UI 图例/统计行）。 */
function countInferred(graph) {
  const edges = (graph && Array.isArray(graph.edges)) ? graph.edges : [];
  let inferred = 0;
  const byVia = {};
  for (const e of edges) {
    if (e && e.inferred) { inferred++; const v = e.inferredVia || 'unknown'; byVia[v] = (byVia[v] || 0) + 1; }
  }
  return { total: edges.length, inferred, raw: edges.length - inferred, byVia };
}

/** 清除图谱中全部推理边（§9 风险 3 的「清除所有推理边」按钮）。 */
function stripInferred(graph) {
  const edges = (graph && Array.isArray(graph.edges)) ? graph.edges : [];
  const kept = edges.filter((e) => e && !e.inferred);
  if (graph) graph.edges = kept;
  return { removed: edges.length - kept.length, edges: kept };
}

function num(v, dflt, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

module.exports = {
  reasonerAvailable,
  recoverInconsistencyMessages,
  materializeGraph,
  mergeInferredEdges,
  removeEdgeWithCascade,
  removeNodeWithCascade,
  countInferred,
  stripInferred,
  DEFAULT_MAX_ROUNDS,
  PROGRESS_HINT_EDGES,
};
