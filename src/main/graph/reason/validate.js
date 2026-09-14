'use strict';

// ---------------------------------------------------------------------------
// reason/validate.js — 全图约束 + 公理校验（融合设计 §12.2.3 通道 C）
//
// 动机：通道 A（写前护栏）只在「写入那一刻」校验一次；换了体系绑定、改了公理、
//      或从旧版本升级后，历史边从未被护栏看过一眼。本模块对**已落库的整张图**
//      重跑 A 的三类检查（未知谓词 / domain / range）+ 节点不相交归属检查，
//      产出只读体检报告。
//
// 边界（设计文档 §12.2.3）：
//   - 只读、只报告：**不修改图谱**（不改 rel、不删边、不写 inferredStale）；
//   - 不依赖 protege-js / 推理器：纯 guard 逻辑，reasonReady() 为假时仍可跑；
//   - 修复动作留给用户（改体系 / 改公理 / 删边），避免「一键体检」把数据改花。
//
// 返回形态（13 字段，测试硬契约见 §12.5）：
//   { ok, profileId, profileName, checked, violations, byReason, byRel,
//     disjointConflicts, coverage, truncated, at,
//     totalViolations, totalDisjointConflicts }
//   后两个为**全量计数**（按 reason 累加，不受明细上限影响）：violations /
//   disjointConflicts 明细数组封顶 VIOLATION_CAP，UI 计数必须用 totals，
//   否则截断时少报（「摘要条 50 条越界边、实际 195」事故，v1.2.2）。
// ---------------------------------------------------------------------------

const guard = require('./guard');

// 明细上限：与 graph.js 的 INCONSISTENCY_DETAIL_CAP 同量级，防止万级越界撑爆 IPC
const VIOLATION_CAP = 50;

// 问题归属「知识图谱」：取边任一端点的 domain（空 → general），
// 与 runInference / listGraphScopes 的 scope 口径一致（`${profile}|${domain}`）。
function edgeDomainOf(from, to) {
  const d = (from && from.domain && String(from.domain).trim())
    || (to && to.domain && String(to.domain).trim()) || '';
  return d || 'general';
}

// 纯版本 scope 标签（不依赖 templates 模块，保证 reason/ 可独立测试）；
// graph.js 的 validateGraph 包装层会用 domainLabelOf（模版名）覆写。
function scopeLabelOf(domain) {
  const d = (domain && String(domain).trim()) || 'general';
  return d === 'general' ? '通用（未匹配领域）' : d;
}

/**
 * 对整张图按指定体系做只读校验。
 *
 * @param {object} graph        {nodes:[{id,name,type,profile?}], edges:[{from,to,rel,inferred?}]}
 * @param {object} profile      已 resolveOntology 的体系对象
 * @param {object} [opts]
 * @param {boolean} [opts.includeInferred=true] 是否把推理边也纳入校验
 *        （默认 true：推理边同样要受体系约束审视，但违规单列 reason 前缀不影响 byReason 口径）
 * @param {boolean} [opts.strictUnknownType=false] 透传 guard.checkEdge 的同名开关
 * @returns {{ok:boolean, profileId:string, profileName:string, checked:number,
 *            violations:Array, byReason:object, byRel:object, disjointConflicts:Array,
 *            coverage:object, truncated:boolean, at:number}}
 */
function validateGraph(graph, profile, opts = {}) {
  const at = Date.now();
  const prof = profile || null;
  const profileId = (prof && prof.id) || '';
  const profileName = (prof && prof.name) || profileId || '';
  const empty = {
    ok: true, profileId, profileName,
    checked: 0, violations: [], byReason: {}, byRel: {},
    disjointConflicts: [], coverage: null, truncated: false, at,
    totalViolations: 0, totalDisjointConflicts: 0,
  };
  if (!prof) return Object.assign(empty, { ok: false, error: '未指定体系' });

  const nodes = Array.isArray(graph && graph.nodes) ? graph.nodes : [];
  const allEdges = Array.isArray(graph && graph.edges) ? graph.edges : [];
  const includeInferred = opts.includeInferred !== false;
  const edges = includeInferred ? allEdges : allEdges.filter((e) => e && !e.inferred);

  const byId = new Map();
  for (const n of nodes) if (n && n.id) byId.set(n.id, n);

  // 覆盖率：与「推理」Tab 第 ④ 区块同源，让体检报告自带体系声明基数
  let coverage = null;
  try { coverage = guard.coverage(prof); } catch (_) { coverage = null; }

  const full = opts.full === true; // 一键修复用：返回全量明细（不封顶 VIOLATION_CAP）
  const violations = [];
  const byReason = {};
  const byRel = {};
  const push = (v) => {
    byReason[v.reason] = (byReason[v.reason] || 0) + 1;
    byRel[v.rel] = (byRel[v.rel] || 0) + 1;
    if (full || violations.length < VIOLATION_CAP) violations.push(v);
  };

  let checked = 0;
  for (const e of edges) {
    if (!e || !e.from || !e.to) continue;
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    // 端点缺失（孤儿边）不归护栏管，跳过而非误报
    if (!from || !to) continue;
    checked++;
    let verdict = null;
    try {
      verdict = guard.checkEdge(prof, from, e.rel, to, { strictUnknownType: !!opts.strictUnknownType });
    } catch (_) { verdict = null; }
    if (verdict && verdict.ok === false) {
      const dom = edgeDomainOf(from, to);
      push({
        edgeKey: `${e.from}|${e.to}|${e.rel}`,
        // 端点 ID 与 actual：供问题表行级「修复」按钮回传定位（名称字段 from/to 仅供展示）
        fromId: e.from, toId: e.to,
        inferred: !!e.inferred,
        from: from.name || from.id, fromType: from.type || '',
        rel: e.rel || '', to: to.name || to.id, toType: to.type || '',
        reason: verdict.reason || 'constraint-violation',
        detail: verdict.detail || '',
        expected: verdict.expected || null,
        actual: verdict.actual || '',
        // v1.2.2 问题汇总表归属字段：所属体系 + 发现问题的知识图谱（domain）
        profileId, profileName,
        domain: dom,
        scopeLabel: scopeLabelOf(dom),
      });
    }
  }

  // 节点不相交归属（cax-dw 的只读等价检查）：
  // Synapse 节点只有一个 type 字段，个体层面不可能「同属两个类」；真正会触发
  // cax-dw 的情形是——边 (from, rel, to) 会让推理器给 from 补一条 rdf:type domain(rel)、
  // 给 to 补 rdf:type range(rel)（prp-dom / prp-rng）。若节点**声明的类型**与该强制类型
  // 落入体系声明的不相交类对，物化时必报冲突。这里不跑推理器就能提前点名。
  // 注意：不能按「类型对」报冲突——图谱同时存在 object 型与 process 型节点是合法的，
  // 不相交约束的是同一个个体，不是类的共存。
  const disjointConflicts = [];
  const byDisjointReason = {}; // 全量计数（不受明细 cap 影响）→ totalDisjointConflicts
  const seenConflict = new Set();
  // 强制类型探针与推理器同口径（含逆谓词物化）：见 guard.forcingProbes。
  // 只看 rel 直连 domain/range 会漏报「逆谓词 domain 强制端点类型」的冲突，
  // 与修复规划（repair.findInducingEdges）必须保持同一口径。
  const probeCache = new Map();
  const probesOf = (rel) => {
    if (!probeCache.has(rel)) {
      let ps = [];
      try { ps = guard.forcingProbes(prof, rel); } catch (_) { ps = []; }
      probeCache.set(rel, ps);
    }
    return probeCache.get(rel);
  };
  for (const e of edges) {
    if (!e || !e.from || !e.to) continue;
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to) continue;
    const probes = probesOf(e.rel).map((p) => ({ node: p.node === 'from' ? from : to, forced: p.forced, via: p.via }));
    for (const { node, forced, via } of probes) {
      const t = node.type || '';
      if (!t) continue;
      for (const f of forced) {
        let d = null;
        try { d = guard.checkDisjoint(prof, t, f); } catch (_) { d = null; }
        if (!d || !d.conflict) continue;
        const sig = `${node.id}|${t}|${f}|${via}`;
        if (seenConflict.has(sig)) continue;
        seenConflict.add(sig);
        // 全量计数先累加：明细数组封顶 VIOLATION_CAP，但计数不能跟着截断
        byDisjointReason['cax-dw'] = (byDisjointReason['cax-dw'] || 0) + 1;
        if (!full && disjointConflicts.length >= VIOLATION_CAP) continue; // 明细封顶，扫描继续
        const cDom = (node.domain && String(node.domain).trim()) || 'general';
        disjointConflicts.push({
          nodeId: node.id,
          node: node.name || node.id,
          domain: cDom,
          scopeLabel: scopeLabelOf(cDom),
          profileId,
          profileName,
          declaredType: t,
          forcedType: f,
          via,
          rel: e.rel || '',
          pairs: d.pairs || [],
          detail: d.detail || '',
        });
      }
    }
  }

  // 全量计数：byReason / byDisjointReason 在 push 时即累加，不受明细 cap 影响
  const totalViolations = Object.values(byReason).reduce((a, b) => a + b, 0);
  const totalDisjointConflicts = Object.values(byDisjointReason).reduce((a, b) => a + b, 0);
  return {
    ok: true,
    profileId,
    profileName,
    checked,
    violations,
    byReason,
    byRel,
    disjointConflicts,
    coverage,
    truncated: violations.length >= VIOLATION_CAP || disjointConflicts.length >= VIOLATION_CAP,
    at,
    totalViolations,
    totalDisjointConflicts,
  };
}

module.exports = { validateGraph, VIOLATION_CAP };
