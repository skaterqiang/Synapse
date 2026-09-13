'use strict';

// ---------------------------------------------------------------------------
// reason/impact.js — 影响面分析（设计文档 §4.4）
//
// 职责：给定起点节点，沿传递谓词（及其逆谓词）BFS 计算下游受影响节点。
//
// ⚠️ 现实约束（已核实 constants.js）：设计文档原文用
//    `predicates.filter(p => p.features.includes('transitive'))` 取传递谓词，
//    但 bfo-lite 的谓词**没有 features 字段**，其传递性只写在
//    `axioms: [{type:'TransitiveProperty', subject:'包含'}]` 里；
//    iso15926 的 composedOf 也只在公理里声明、谓词上没挂 features。
//    只读 features 会让默认体系的影响面分析恒为空。
//    因此这里一律走 bridge.normalizeProfile 的双源合并视图。
// ---------------------------------------------------------------------------

const { normalizeProfile } = require('./bridge');

const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_NODES = 500;

/** kgAsk 的触发词（设计文档 §4.4「问答集成」）。 */
const IMPACT_KEYWORDS = ['影响', '下游', '依赖', '故障', '波及', '牵连', '连带', '传导', '上游', 'impact'];

/**
 * 问题里是否含影响面触发词。
 * @returns {{hit:boolean, keywords:string[]}}
 */
function detectImpactIntent(question) {
  const q = String(question || '');
  const low = q.toLowerCase();
  const hits = IMPACT_KEYWORDS.filter((k) => (/[a-z]/i.test(k) ? low.includes(k.toLowerCase()) : q.includes(k)));
  return { hit: hits.length > 0, keywords: hits };
}

/**
 * 当前体系下可用于影响面分析的谓词集合。
 * @returns {{transitive:string[], symmetric:string[], inverseOf:Object<string,string[]>, usable:boolean}}
 */
function impactRelations(profile) {
  const m = normalizeProfile(profile);
  const transitive = [...m.transitive];
  const symmetric = [...m.symmetric];
  const inverseOf = {};
  for (const [k, v] of m.inverseOf) inverseOf[k] = [...v];
  return { transitive, symmetric, inverseOf, usable: transitive.length > 0 };
}

/**
 * 影响面闭包。
 *
 * 遍历方向（opts.direction）：
 *   - 'downstream'（默认）：沿 from→to 正向，找「我坏了会波及谁」
 *   - 'upstream'          ：沿 to→from 反向，找「谁出问题会波及我」
 *   - 'both'              ：两个方向都走
 * 互逆谓词（part_of ⇄ has_part）按体系声明自动纳入，无需调用方关心方向。
 *
 * @param {{nodes:Array, edges:Array}} graph
 * @param {object} profile
 * @param {string} seedId
 * @param {object} [opts]
 * @param {number}  [opts.maxDepth=5]
 * @param {number}  [opts.maxNodes=500]   结果上限，防止枢纽节点炸出全图
 * @param {string}  [opts.direction='downstream']
 * @param {string[]} [opts.rels]          显式指定谓词（覆盖体系推导）
 * @param {boolean} [opts.includeInferred=true] 是否走推理边
 * @param {boolean} [opts.followSymmetric=false] 对称谓词是否纳入（默认否：
 *        「相关」这类兜底对称谓词会把全图连成一片，影响面失去意义）
 * @returns {Array<{id:string, name:string, type:string, via:string, depth:number,
 *                  path:string[], inferred:boolean}>}
 */
function impactClosure(graph, profile, seedId, opts = {}) {
  const m = normalizeProfile(profile);
  const nodes = Array.isArray(graph && graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph && graph.edges) ? graph.edges : [];
  if (!seedId || !nodes.length || !edges.length) return [];

  const maxDepth = intOpt(opts.maxDepth, DEFAULT_MAX_DEPTH, 1, 20);
  const maxNodes = intOpt(opts.maxNodes, DEFAULT_MAX_NODES, 1, 5000);
  const direction = ['downstream', 'upstream', 'both'].includes(opts.direction) ? opts.direction : 'downstream';
  const includeInferred = opts.includeInferred !== false;
  const followSymmetric = opts.followSymmetric === true;

  // 参与遍历的谓词集合
  const relSet = new Set();
  if (Array.isArray(opts.rels) && opts.rels.length) {
    for (const r of opts.rels) relSet.add(r);
  } else {
    for (const r of m.transitive) relSet.add(r);
    if (followSymmetric) for (const r of m.symmetric) relSet.add(r);
  }
  if (!relSet.size) return [];

  // 邻接表：正向 from→[to]，反向 to→[from]
  const fwd = new Map();
  const bwd = new Map();
  const push = (map, a, b, rel, inferred) => {
    if (!map.has(a)) map.set(a, []);
    map.get(a).push({ to: b, rel, inferred });
  };
  for (const e of edges) {
    if (!e || !e.from || !e.to) continue;
    if (e.inferred && !includeInferred) continue;
    const rel = e.rel;
    if (!relSet.has(rel)) continue;
    push(fwd, e.from, e.to, rel, !!e.inferred);
    push(bwd, e.to, e.from, rel, !!e.inferred);
    // 互逆谓词：part_of 的边同时是 has_part 的边（反向）
    for (const inv of (m.inverseOf.get(rel) || [])) {
      if (!relSet.has(inv) && !m.transitive.has(inv)) continue;
      push(fwd, e.to, e.from, inv, !!e.inferred);
      push(bwd, e.from, e.to, inv, !!e.inferred);
    }
  }

  const nodeById = new Map();
  for (const n of nodes) if (n && n.id) nodeById.set(n.id, n);
  if (!nodeById.has(seedId)) return [];

  const visited = new Set([seedId]);
  const queue = [{ id: seedId, depth: 0, path: [] }];
  const out = [];

  while (queue.length && out.length < maxNodes) {
    const cur = queue.shift();
    if (cur.depth >= maxDepth) continue;
    const steps = [];
    if (direction !== 'upstream') for (const s of (fwd.get(cur.id) || [])) steps.push(s);
    if (direction !== 'downstream') for (const s of (bwd.get(cur.id) || [])) steps.push(s);
    for (const s of steps) {
      if (visited.has(s.to)) continue;
      visited.add(s.to);
      const n = nodeById.get(s.to);
      const path = cur.path.concat(s.rel);
      out.push({
        id: s.to,
        name: (n && n.name) || s.to,
        type: (n && n.type) || '',
        profile: (n && n.profile) || '',
        domain: (n && n.domain) || '',
        via: s.rel,
        depth: cur.depth + 1,
        path,
        inferred: !!s.inferred,
      });
      if (out.length >= maxNodes) break;
      queue.push({ id: s.to, depth: cur.depth + 1, path });
    }
  }

  return out;
}

/**
 * 把影响面结果转成 kgAsk 用的事实串（与 graph.js 既有 facts 格式一致：
 * `[profile·type]名称 —rel→ [profile·type]名称`）。
 */
function impactToFacts(graph, seedNode, impacted, opts = {}) {
  const limit = intOpt(opts.limit, 40, 1, 200);
  const nodes = Array.isArray(graph && graph.nodes) ? graph.nodes : [];
  const byId = new Map();
  for (const n of nodes) if (n && n.id) byId.set(n.id, n);
  const tag = (n) => `[${(n && n.profile) || 'bfo-lite'}·${(n && n.type) || '?'}]`;
  const facts = [];
  const seedName = (seedNode && seedNode.name) || (seedNode && seedNode.id) || '?';
  for (const it of impacted.slice(0, limit)) {
    const chain = (it.path || []).join(' → ');
    facts.push(`${tag(seedNode)}${seedName} —${chain} → ${tag(byId.get(it.id))}${it.name}（${it.depth} 跳${it.inferred ? '，⚡推理' : ''}）`);
  }
  return facts;
}

/** 影响面摘要行（供 kgAsk stage 与 UI 区块标题）。 */
function impactSummary(profile, impacted, opts = {}) {
  const m = normalizeProfile(profile);
  const rels = (Array.isArray(opts.rels) && opts.rels.length) ? opts.rels : [...m.transitive];
  const maxDepth = impacted.reduce((a, b) => Math.max(a, b.depth || 0), 0);
  return `影响面扩展完成（沿传递谓词 ${rels.join('/') || '无'}，共 ${impacted.length} 个下游节点，最深 ${maxDepth} 跳）`;
}

function intOpt(v, dflt, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

module.exports = {
  IMPACT_KEYWORDS,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_NODES,
  detectImpactIntent,
  impactRelations,
  impactClosure,
  impactToFacts,
  impactSummary,
};
