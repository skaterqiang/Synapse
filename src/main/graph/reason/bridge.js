'use strict';

// ---------------------------------------------------------------------------
// reason/bridge.js — Synapse 图谱 ↔ protege-js TripleStore 双向桥接
//
// 设计依据：docs/design/Synapse×protege-js融合设计.md §3.1 / §3.2 / §4.1
//
// ⚠️ 关键约束：protege-js 的 TripleStore 与全部 78 条 OWL 2 RL 规则都按
//    **IRI 字符串全等**匹配，不做任何前缀展开。写 'rdfs:subClassOf' 这种
//    缩写不会报错、materialize() 照样跑完、store 照样变大，但 entails()
//    永远返回 false。因此本文件所有谓词一律由 NS/P/C 常量拼接。
// ---------------------------------------------------------------------------

const { TripleStore } = require('@skaterqiang/protege-js/src/inference/TripleStore');
const { NS, P, C } = require('@skaterqiang/protege-js/src/inference/rdf');
const { RELATION_ALIASES } = require('../../common/constants');

// ---------- IRI 命名空间 ----------
const SYN_BASE = 'https://synapse.local/';
const PREFIX_ID = SYN_BASE + 'id/';      // 节点个体
const PREFIX_TYPE = SYN_BASE + 'type/';  // 体系类
const PREFIX_REL = SYN_BASE + 'rel/';    // 体系谓词
const SYN_PROFILE = SYN_BASE + 'profile';
const RDFS_LABEL = NS.RDFS + 'label';
const XSD_STRING = NS.XSD + 'string';

const enc = (s) => encodeURIComponent(String(s == null ? '' : s));
const dec = (s) => { try { return decodeURIComponent(String(s)); } catch (_) { return String(s); } };

const iriId = (nodeId) => PREFIX_ID + enc(nodeId);
const iriType = (typeKey) => PREFIX_TYPE + enc(typeKey);
const iriRel = (relKey) => PREFIX_REL + enc(relKey);

/** 边的身份键。顺序必须与 graph.js 的 `${from}|${to}|${rel}` 完全一致。 */
const edgeKey = (from, to, rel) => `${from}|${to}|${rel}`;

/** 转义后的 XSD string 字面量（节点名可能含引号/换行）。 */
function safeLiteral(lex) {
  const s = String(lex == null ? '' : lex)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n\t]/g, ' ');
  return `"${s}"^^<${XSD_STRING}>`;
}

// ---------- 谓词特性 → OWL 特性类 ----------
// profile.predicates[].features 用小写驼峰；profile.axioms[].type 用 OWL 类名。
// 两个来源都要认，因为内置体系里 bfo-lite 只有公理没有 features，
// 而 OWL 导入产生的体系只有 features 没有公理。
const FEATURE_IRI = {
  transitive: C.TransitiveProperty,
  symmetric: C.SymmetricProperty,
  asymmetric: C.AsymmetricProperty,
  functional: C.FunctionalProperty,
  inverseFunctional: C.InverseFunctionalProperty,
  irreflexive: C.IrreflexiveProperty,
};

const AXIOM_TO_FEATURE = {
  TransitiveProperty: 'transitive',
  SymmetricProperty: 'symmetric',
  AsymmetricProperty: 'asymmetric',
  FunctionalProperty: 'functional',
  InverseFunctionalProperty: 'inverseFunctional',
  IrreflexiveProperty: 'irreflexive',
  // ReflexiveProperty：protege-js 的 C 表与 78 条规则都没有对应项，显式忽略
  ReflexiveProperty: null,
};

// ---------------------------------------------------------------------------
// normalizeProfile — 把「体系定义」摊平成推理/护栏/影响面共用的逻辑视图
//
// 为什么需要：内置 ONTOLOGY_PROFILES 的谓词**没有** domain/range 字段，
// domain/range 只以 PropertyDomain/PropertyRange 公理的形式存在；
// 而 owl.js 导入的体系恰好相反——domain/range/features 挂在谓词上、公理表为空。
// 只读其中一处都会让护栏或影响面在另一半体系上静默失效。
// ---------------------------------------------------------------------------
function normalizeProfile(profile) {
  const p = profile || {};
  const classes = Array.isArray(p.classes) ? p.classes : [];
  const predicates = Array.isArray(p.predicates) ? p.predicates : [];
  const axioms = Array.isArray(p.axioms) ? p.axioms : [];

  const classLabel = new Map();   // key -> label
  const relLabel = new Map();     // key -> label
  for (const c of classes) if (c && c.key) classLabel.set(c.key, c.label || c.key);
  for (const r of predicates) if (r && r.key) relLabel.set(r.key, r.label || r.key);

  // 谓词别名：canonical key 自身优先，再收 predicate.aliases 与全局 RELATION_ALIASES。
  // canonical key 不会被其它谓词的别名覆盖。
  const relAlias = new Map();
  for (const r of predicates) {
    if (r && r.key) relAlias.set(r.key, r.key);
  }
  for (const r of predicates) {
    if (!r || !r.key) continue;
    const list = new Set([
      ...(Array.isArray(r.aliases) ? r.aliases : []),
      ...(RELATION_ALIASES[r.key] || []),
    ]);
    for (const a of list) {
      if (a && a !== r.key && !relAlias.has(a)) relAlias.set(a, r.key);
    }
  }

  // --- 类层级：classes[].parent 与 SubClassOf 公理合并（支持多继承） ---
  const parentsOf = new Map();    // childKey -> Set<parentKey>
  const addParent = (child, parent) => {
    if (!child || !parent || child === parent) return;
    if (!parentsOf.has(child)) parentsOf.set(child, new Set());
    parentsOf.get(child).add(parent);
  };
  for (const c of classes) if (c && c.key && c.parent) addParent(c.key, c.parent);

  // --- 谓词逻辑特征 ---
  const features = new Map();     // relKey -> Set<feature>
  const addFeature = (relKey, feat) => {
    if (!relKey || !feat) return;
    if (!features.has(relKey)) features.set(relKey, new Set());
    features.get(relKey).add(feat);
  };
  for (const r of predicates) {
    if (!r || !r.key) continue;
    for (const f of (Array.isArray(r.features) ? r.features : [])) addFeature(r.key, f);
  }

  const inverseOf = new Map();    // relKey -> Set<relKey>（对称闭包）
  const addInverse = (a, b) => {
    if (!a || !b || a === b) return;
    if (!inverseOf.has(a)) inverseOf.set(a, new Set());
    if (!inverseOf.has(b)) inverseOf.set(b, new Set());
    inverseOf.get(a).add(b);
    inverseOf.get(b).add(a);
  };

  const domain = new Map();       // relKey -> Set<typeKey>（OWL 语义：多个 domain = 合取）
  const range = new Map();
  // typeKey 允许是数组：owl.js / owlImport.js 目前产出的是**字符串**（`domain: 'Thing'`），
  // 但设计文档 §4.3 的伪码与用户自定义体系都可能写成 `domain: ['Thing']`。
  // 不摊平的话，Set 里会存进一个数组对象，护栏拿它跟 `anc`（字符串集合）比对必然失配，
  // 表现为「expected: [["Thing"]]」且**所有**边都被误判 domain-violation（实测复现）。
  const addDR = (map, relKey, typeKey) => {
    if (!relKey || !typeKey) return;
    const list = Array.isArray(typeKey) ? typeKey : [typeKey];
    for (const t of list) {
      if (!t || typeof t !== 'string') continue;
      if (!map.has(relKey)) map.set(relKey, new Set());
      map.get(relKey).add(t);
    }
  };

  // 谓词上直接挂的 domain/range（owl.js 导入路径）
  for (const r of predicates) {
    if (!r || !r.key) continue;
    if (r.domain) addDR(domain, r.key, r.domain);
    if (r.range) addDR(range, r.key, r.range);
  }

  const disjoint = [];            // [typeKeyA, typeKeyB]
  const subClassOf = [];          // [childKey, parentKey]（来自公理，可能超出 classes 树）
  const equivalentClasses = [];

  for (const ax of axioms) {
    if (!ax || !ax.type) continue;
    const s = ax.subject, o = ax.object;
    switch (ax.type) {
      case 'SubClassOf':
        addParent(s, o); subClassOf.push([s, o]); break;
      case 'DisjointClasses':
        if (s && o) disjoint.push([s, o]); break;
      case 'EquivalentClasses':
        if (s && o) { equivalentClasses.push([s, o]); addParent(s, o); addParent(o, s); } break;
      case 'InverseProperties':
        addInverse(s, o); break;
      case 'PropertyDomain':
        addDR(domain, s, o); break;
      case 'PropertyRange':
        addDR(range, s, o); break;
      case 'SubPropertyOf':
      case 'EquivalentProperties':
        // 仅记录，桥接时写三元组；护栏/影响面暂不使用
        break;
      default: {
        const feat = AXIOM_TO_FEATURE[ax.type];
        if (feat) addFeature(s, feat);
      }
    }
  }

  const transitive = new Set();
  const symmetric = new Set();
  for (const [k, set] of features) {
    if (set.has('transitive')) transitive.add(k);
    if (set.has('symmetric')) symmetric.add(k);
  }

  // --- 祖先闭包（含自身），带环保护：导入的体系可能有 A⊑B、B⊑A ---
  const ancestorsOf = new Map();  // key -> Set<key>
  const ancestors = (key) => {
    if (ancestorsOf.has(key)) return ancestorsOf.get(key);
    const out = new Set();
    ancestorsOf.set(key, out);            // 先占位，防环
    const stack = [key];
    const seen = new Set([key]);
    while (stack.length) {
      const cur = stack.pop();
      out.add(cur);
      for (const par of (parentsOf.get(cur) || [])) {
        if (seen.has(par)) continue;
        seen.add(par);
        stack.push(par);
      }
    }
    return out;
  };
  for (const c of classes) if (c && c.key) ancestors(c.key);
  for (const [k] of parentsOf) ancestors(k);

  return {
    profile: p,
    id: p.id || '',
    classes, predicates, axioms,
    classLabel, relLabel, relAlias,
    parentsOf, ancestorsOf: ancestors,
    features, transitive, symmetric, inverseOf,
    domain, range,
    disjoint, subClassOf, equivalentClasses,
    fallbackType: p.fallbackType || '',
    fallbackRel: p.fallbackRel || '',
  };
}

// ---------------------------------------------------------------------------
// graphToTriples — Synapse 图谱 + 体系 → TripleStore
// ---------------------------------------------------------------------------
/**
 * @param {{nodes:Array, edges:Array}} graph
 * @param {object} profile  已 resolveOntology 的体系对象
 * @param {object} [opts]
 * @param {boolean} [opts.annotations=true]  是否写入 rdfs:label / syn:profile 字面量
 *        （仅供调试与 ReasonerQueries 使用，不参与任何推理规则；
 *          万级节点图谱可关掉以省 2N 条三元组）
 * @returns {{store:TripleStore, model:object, ctx:object, stats:object}}
 */
function graphToTriples(graph, profile, opts = {}) {
  const model = normalizeProfile(profile);
  const store = new TripleStore();
  const annotations = opts.annotations !== false;

  const nodes = Array.isArray(graph && graph.nodes) ? graph.nodes : [];
  const rawEdges = Array.isArray(graph && graph.edges) ? graph.edges : [];

  // --- 1. 类声明 + 类层级 ---
  // 声明为 owl:Class 才会触发 scm-cls（补 subClassOf 自反 + ⊑Thing），
  // 进而让 scm-sco 把类树传递闭包出来——prp-dom/prp-rng 配合 scm-dom1/scm-rng1
  // 需要这个闭包才能沿类树正确传播定义域/值域。
  const declaredTypes = new Set();
  const declareType = (key) => {
    if (!key || declaredTypes.has(key)) return;
    declaredTypes.add(key);
    store.add(iriType(key), P.type, C.Class);
  };
  for (const c of model.classes) declareType(c.key);
  for (const [child, parent] of model.subClassOf) { declareType(child); declareType(parent); }
  for (const [a, b] of model.disjoint) { declareType(a); declareType(b); }
  for (const set of model.domain.values()) for (const t of set) declareType(t);
  for (const set of model.range.values()) for (const t of set) declareType(t);

  for (const [child, parents] of model.parentsOf) {
    for (const parent of parents) {
      declareType(child); declareType(parent);
      store.add(iriType(child), P.subClassOf, iriType(parent));
    }
  }
  for (const [a, b] of model.disjoint) store.add(iriType(a), P.disjointWith, iriType(b));
  for (const [a, b] of model.equivalentClasses) store.add(iriType(a), P.equivalentClass, iriType(b));

  // --- 2. 谓词声明 + 特性 + domain/range + 互逆 ---
  const declaredRels = new Set();
  const declareRel = (key) => {
    if (!key || declaredRels.has(key)) return;
    declaredRels.add(key);
    store.add(iriRel(key), P.type, C.ObjectProperty);
  };
  for (const r of model.predicates) declareRel(r.key);

  for (const [relKey, feats] of model.features) {
    declareRel(relKey);
    for (const f of feats) {
      const iri = FEATURE_IRI[f];
      if (iri) store.add(iriRel(relKey), P.type, iri);
    }
  }
  for (const [relKey, invs] of model.inverseOf) {
    declareRel(relKey);
    for (const inv of invs) { declareRel(inv); store.add(iriRel(relKey), P.inverseOf, iriRel(inv)); }
  }
  for (const [relKey, set] of model.domain) {
    declareRel(relKey);
    for (const t of set) { declareType(t); store.add(iriRel(relKey), P.domain, iriType(t)); }
  }
  for (const [relKey, set] of model.range) {
    declareRel(relKey);
    for (const t of set) { declareType(t); store.add(iriRel(relKey), P.range, iriType(t)); }
  }
  // 公理里出现的 SubPropertyOf / EquivalentProperties
  for (const ax of model.axioms) {
    if (!ax || !ax.subject || !ax.object) continue;
    if (ax.type === 'SubPropertyOf') {
      declareRel(ax.subject); declareRel(ax.object);
      store.add(iriRel(ax.subject), P.subPropertyOf, iriRel(ax.object));
    } else if (ax.type === 'EquivalentProperties') {
      declareRel(ax.subject); declareRel(ax.object);
      store.add(iriRel(ax.subject), P.equivalentProperty, iriRel(ax.object));
    }
  }

  // --- 3. 节点 ---
  const fbType = model.fallbackType || 'thing';
  const nodeNameById = new Map();
  const nodeTypeById = new Map();
  const validIds = new Set();
  let typedNodes = 0;
  for (const n of nodes) {
    if (!n || !n.id) continue;
    validIds.add(n.id);
    nodeNameById.set(n.id, n.name || n.id);
    const t = n.type || fbType;
    nodeTypeById.set(n.id, t);
    declareType(t);
    store.add(iriId(n.id), P.type, iriType(t));
    typedNodes++;
    if (annotations) {
      store.add(iriId(n.id), RDFS_LABEL, safeLiteral(n.name || n.id));
      if (n.profile) store.add(iriId(n.id), SYN_PROFILE, safeLiteral(n.profile));
    }
  }

  // --- 4. 边（只收原始边；推理边不得作为输入，否则会自我循环论证） ---
  //    edgeIndex：身份键 → graph.edges 下标，用于反推 inferredFrom
  const edgeIndex = new Map();
  const originals = new Set();          // 身份键集合，供 justify 快速判定
  const adjByRel = new Map();           // relKey -> Map<fromId, Set<toId>>（仅原始边）
  const relIris = new Set();
  let skippedEdges = 0, inputEdges = 0, staleInferred = 0;

  rawEdges.forEach((e, idx) => {
    if (!e || !e.from || !e.to) return;
    if (e.inferred) { staleInferred++; return; }   // 上一轮的推理产物，本轮重算
    const rel = model.relAlias.get(e.rel) || e.rel || model.fallbackRel || 'related';
    // 端点必须存在，否则会给不存在的节点造 IRI（删点后残留的悬空边）
    if (!validIds.has(e.from) || !validIds.has(e.to)) { skippedEdges++; return; }
    const k = edgeKey(e.from, e.to, rel);
    if (!edgeIndex.has(k)) edgeIndex.set(k, idx);
    originals.add(k);
    const ri = iriRel(rel);
    relIris.add(ri);
    store.add(iriId(e.from), ri, iriId(e.to));
    inputEdges++;
    if (!adjByRel.has(rel)) adjByRel.set(rel, new Map());
    const adj = adjByRel.get(rel);
    if (!adj.has(e.from)) adj.set(e.from, new Set());
    adj.get(e.from).add(e.to);
  });

  // 体系里声明过、但图中没出现的谓词也要纳入扫描范围（推理可能凭空造不出边，
  // 但传递/对称/互逆规则只在已有边上触发，故这里以「体系谓词 ∪ 图中谓词」为准）
  for (const r of model.predicates) if (r && r.key) relIris.add(iriRel(r.key));

  const ctx = {
    model,
    edgeIndex,
    originals,
    adjByRel,
    relIris,
    nodeNameById,
    nodeTypeById,
    validIds,
    annotations,
  };

  return {
    store,
    model,
    ctx,
    stats: {
      nodes: typedNodes,
      edges: inputEdges,
      skippedEdges,
      staleInferred,
      classes: declaredTypes.size,
      predicates: declaredRels.size,
      triples: store.size(),
    },
  };
}

// ---------------------------------------------------------------------------
// 传递路径回溯 — 为 inferred 边找出「由哪些原始边推出」
// ---------------------------------------------------------------------------
/**
 * 在 adj（fromId -> Set<toId>）里 BFS 找 from→to 的一条最短路径，
 * 返回路径上每条边的身份键（from|to|rel 顺序，与 graph.js 一致）。
 * @returns {string[]|null}
 */
function findPath(adj, fromId, toId, rel) {
  if (!adj || !fromId || !toId || fromId === toId) return null;
  if (!adj.has(fromId)) return null;
  const prev = new Map();
  const seen = new Set([fromId]);
  const queue = [fromId];
  while (queue.length) {
    const cur = queue.shift();
    for (const nxt of (adj.get(cur) || [])) {
      if (seen.has(nxt)) continue;
      seen.add(nxt);
      prev.set(nxt, cur);
      if (nxt === toId) {
        const keys = [];
        let a = toId;
        while (a !== fromId) {
          const b = prev.get(a);
          keys.unshift(edgeKey(b, a, rel));
          a = b;
        }
        return keys;
      }
      queue.push(nxt);
    }
  }
  return null;
}

/**
 * 为一条推理边给出前提边身份键 + 推理途径。
 * protege-js 的 _inferred 只是「哪些三元组是新的」，不带溯源，
 * 所以这里按规则语义反推（覆盖传递/对称/互逆三类，即本体系实际会产生的全部推理边）。
 */
function justify(fromId, toId, rel, ctx, materializedAdj) {
  const k = edgeKey(fromId, toId, rel);
  const rev = edgeKey(toId, fromId, rel);

  // prp-symp：R 对称，原始有 (to, R, from) → 推出 (from, R, to)
  if (ctx.model.symmetric.has(rel) && ctx.originals.has(rev)) {
    return { keys: [rev], via: 'symmetric' };
  }
  // prp-inv1/inv2：R' inverseOf R，原始有 (to, R', from) → 推出 (from, R, to)
  for (const inv of (ctx.model.inverseOf.get(rel) || [])) {
    const ik = edgeKey(toId, fromId, inv);
    if (ctx.originals.has(ik)) return { keys: [ik], via: 'inverse' };
  }
  // prp-trp：R 传递，原始边里存在 from→…→to 的路径
  if (ctx.model.transitive.has(rel)) {
    const path = findPath(ctx.adjByRel.get(rel), fromId, toId, rel);
    if (path && path.length) return { keys: path, via: 'transitive' };
    // 退一步：在物化后的邻接表里找（路径可能经过对称/互逆推出的中间边）。
    // 级联清理是不动点循环，前提里含其它推理边也能正确连锁删除。
    const path2 = findPath(materializedAdj, fromId, toId, rel);
    if (path2 && path2.length) return { keys: path2, via: 'transitive+' };
  }
  // prp-spo1 / prp-eqp1：子谓词或等价谓词上有原始边
  for (const ax of ctx.model.axioms) {
    if (!ax || !ax.subject || !ax.object) continue;
    const isSub = ax.type === 'SubPropertyOf' && ax.object === rel;
    const isEq = ax.type === 'EquivalentProperties' && (ax.subject === rel || ax.object === rel);
    if (!isSub && !isEq) continue;
    const other = isSub ? ax.subject : (ax.subject === rel ? ax.object : ax.subject);
    const ok = edgeKey(fromId, toId, other);
    if (ctx.originals.has(ok)) return { keys: [ok], via: isSub ? 'subproperty' : 'equivalent-property' };
  }
  return { keys: [], via: 'unknown' };
}

// ---------------------------------------------------------------------------
// triplesToInferredEdges — 物化后的 TripleStore → Synapse 推理边
// ---------------------------------------------------------------------------
/**
 * 判定规则（§3.1 反向映射）：主语与宾语都是 syn:id/ 个体、谓词是 syn:rel/、
 * 且该三元组在 reasoner._inferred 中（即不在原始输入里）。
 *
 * 只扫描「体系谓词 ∪ 图中谓词」这些谓词桶——TripleStore 按谓词建了索引，
 * 这样避开遍历整个物化后的 store（万级节点时含 eq-ref 产生的大量 sameAs）。
 *
 * @returns {{edges:Array, stats:object}}
 */
function triplesToInferredEdges(store, reasoner, ctx, opts = {}) {
  const inferredSet = reasoner && reasoner._inferred;
  const out = [];
  if (!inferredSet || !inferredSet.size) return { edges: out, stats: { scanned: 0, inferredEdges: 0, unjustified: 0 } };

  // 物化后的邻接表（仅 Synapse 关系谓词），供 transitive+ 回溯
  const materializedAdjByRel = new Map();
  const relIriToKey = new Map();
  for (const relKey of [...ctx.model.transitive]) relIriToKey.set(iriRel(relKey), relKey);
  for (const r of ctx.model.predicates) if (r && r.key) relIriToKey.set(iriRel(r.key), r.key);
  for (const ri of ctx.relIris) if (!relIriToKey.has(ri)) relIriToKey.set(ri, dec(ri.slice(PREFIX_REL.length)));

  let scanned = 0, unjustified = 0;
  const now = Date.now();
  const seenOut = new Set();

  for (const relIri of ctx.relIris) {
    const triples = store.match(null, relIri, null);
    if (!triples.length) continue;
    const relKey = relIriToKey.get(relIri) || dec(relIri.slice(PREFIX_REL.length));
    let madj = null;

    for (const [s, p, o] of triples) {
      if (!s.startsWith(PREFIX_ID) || !o.startsWith(PREFIX_ID)) continue;
      scanned++;
      if (!inferredSet.has(TripleStore.key(s, p, o))) continue;   // 原始输入，不是推理产物
      const fromId = dec(s.slice(PREFIX_ID.length));
      const toId = dec(o.slice(PREFIX_ID.length));
      if (!fromId || !toId || fromId === toId) continue;          // 自环不入图（体系约束禁止）
      const k = edgeKey(fromId, toId, relKey);
      if (ctx.originals.has(k) || seenOut.has(k)) continue;       // 已有同身份原始边 → 不算新边
      seenOut.add(k);

      if (ctx.model.transitive.has(relKey) && !madj) {
        madj = new Map();
        for (const [ss, , oo] of triples) {
          if (!ss.startsWith(PREFIX_ID) || !oo.startsWith(PREFIX_ID)) continue;
          const f = dec(ss.slice(PREFIX_ID.length)), t = dec(oo.slice(PREFIX_ID.length));
          if (f === fromId && t === toId) continue;               // 排除待证边自身
          if (!madj.has(f)) madj.set(f, new Set());
          madj.get(f).add(t);
        }
      }
      const j = justify(fromId, toId, relKey, ctx, madj);
      if (!j.keys.length) unjustified++;
      out.push({
        from: fromId,
        to: toId,
        rel: relKey,
        inferred: true,
        inferredFromKeys: j.keys,   // 身份键；由 bindProvenance 换成最终数组下标
        inferredVia: j.via,
        inferredAt: now,
        inferredBy: opts.reasonerId || 'owl2rl',
      });
    }
  }

  return { edges: out, stats: { scanned, inferredEdges: out.length, unjustified } };
}

// ---------------------------------------------------------------------------
// humanizeIris — 把冲突消息里的 IRI 换回人话
// protege-js 的 conflict 消息形如 "https://synapse.local/id/bfo-lite%3Axxx in
// disjoint https://synapse.local/type/continuant & .../type/occurrent"，
// 直接进 UI 不可读。
// ---------------------------------------------------------------------------
const IRI_RE = /https:\/\/synapse\.local\/(id|type|rel)\/([^\s&"'`,;)\]]+)/g;

function humanizeIris(text, ctx) {
  const m = ctx && ctx.model;
  return String(text == null ? '' : text).replace(IRI_RE, (full, kind, encoded) => {
    const v = dec(encoded);
    if (kind === 'id') return (ctx && ctx.nodeNameById && ctx.nodeNameById.get(v)) || v;
    if (kind === 'type') return (m && m.classLabel.get(v)) || v;
    return (m && m.relLabel.get(v)) || v;
  });
}

// ---------------------------------------------------------------------------
// enrichConflict — 给一条不一致冲突补「归属 + 中文说明」
//   归属：该冲突涉及哪些节点 → 节点属于哪个知识图谱（scope，即 体系|领域 分组）
//   中文：把 protege-js 规则引擎的英文消息按规则逐条翻译成中文原因
// 输入 c = { rule, message(已人话化), raw(原始 IRI 消息) }，ctx 来自 graphToTriples，
// nodes 为参与本次物化的图谱节点（带 domain 字段）。
// 返回 { ...c, nodeIds, nodeNames, scopeKeys, messageZh, reasonZh }。
// ---------------------------------------------------------------------------

/** 从 raw 消息提取涉及的节点 id（IRI 形如 https://synapse.local/id/<enc>）。 */
function conflictNodeIds(c) {
  const raw = String((c && c.raw) || '');
  const ids = [];
  const re = new RegExp(PREFIX_ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^\\s&"\'`,;)\\]]+)', 'g');
  let m;
  while ((m = re.exec(raw))) {
    const id = dec(m[1]);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * 按规则把英文冲突消息翻译成中文。
 * 消息模板与 protege-js owl2rl.js 的 conflict() 调用一一对应；
 * 解析失败时退回通用句式，保证永远有中文可读。
 * @param {string} rule  规则 id（cax-dw / prp-asyp / …）
 * @param {string} message  已人话化的消息（节点名/类标签/谓词标签）
 * @param {object} ctx  graphToTriples 的 ctx（用 relLabel 反查谓词 key）
 * @returns {{ messageZh: string, reasonZh: string }}
 */
function conflictChinese(rule, message, ctx) {
  const msg = String(message == null ? '' : message);
  const m = ctx && ctx.model;
  // 谓词标签 → key 反查表（消息里出现的是标签，如「矛盾于」，需换回 key 才能对上 domain/range）
  const relKeyByLabel = new Map();
  if (m && m.relLabel) for (const [k, lab] of m.relLabel) if (!relKeyByLabel.has(lab)) relKeyByLabel.set(lab, k);
  const relKeyOf = (label) => relKeyByLabel.get(label) || label;
  const domOf = (label) => {
    const set = m && m.domain && m.domain.get(relKeyOf(label));
    return set && set.size ? [...set].map((t) => (m.classLabel && m.classLabel.get(t)) || t) : null;
  };
  const rngOf = (label) => {
    const set = m && m.range && m.range.get(relKeyOf(label));
    return set && set.size ? [...set].map((t) => (m.classLabel && m.classLabel.get(t)) || t) : null;
  };
  const clsList = (arr) => (arr && arr.length ? `「${arr.join('」「')}」` : '');

  let mm;
  switch (rule) {
    case 'cax-dw':
      // `${x} in disjoint ${c1} & ${c2}`
      mm = msg.match(/^(.+) in disjoint (.+) & (.+)$/);
      if (mm) return {
        messageZh: `「${mm[1]}」同时被归入互斥的类「${mm[2]}」与「${mm[3]}」`,
        reasonZh: `本体公理声明「${mm[2]}」与「${mm[3]}」不相交（DisjointClasses），同一个体不能同时属于两者；请检查该节点的类型标注或相关边的 domain/range 是否用错。`,
      };
      break;
    case 'cax-adc':
      // `${z} in multiple disjoint classes`
      mm = msg.match(/^(.+) in multiple disjoint classes$/);
      if (mm) return {
        messageZh: `「${mm[1]}」同时落入多个互斥的类`,
        reasonZh: '该个体被推理归入了一组两两不相交（DisjointClasses）的类，违反互斥公理；请检查其类型标注与相关边的 domain/range。',
      };
      break;
    case 'prp-asyp': {
      // `${x} ${p} ${y} and reverse`
      mm = msg.match(/^(.+?) (.+?) (.+) and reverse$/);
      if (mm) {
        const d = domOf(mm[2]); const r = rngOf(mm[2]);
        return {
          messageZh: `「${mm[1]}」与「${mm[3]}」之间同时存在「${mm[2]}」及其反向的边`,
          reasonZh: `「${mm[2]}」被声明为非对称谓词（AsymmetricObjectProperty），若 A→B 成立则 B→A 必不成立，二者同时断言即矛盾${d && r ? `；且其定义域${clsList(d)}与值域${clsList(r)}不相交，双向断言还会迫使两端节点同时落入互斥类` : ''}。请删去其中一条边。`,
        };
      }
      break;
    }
    case 'prp-irp':
      // `${x} ${p} itself`
      mm = msg.match(/^(.+?) (.+) itself$/);
      if (mm) return {
        messageZh: `「${mm[1]}」对自身断言了「${mm[2]}」`,
        reasonZh: `「${mm[2]}」被声明为反自反谓词（IrreflexiveObjectProperty），任何个体都不能与自身建立该关系。请删除这条自环边。`,
      };
      break;
    case 'eq-diff1':
      // `${x} sameAs and differentFrom ${y}`
      mm = msg.match(/^(.+?) sameAs and differentFrom (.+)$/);
      if (mm) return {
        messageZh: `「${mm[1]}」与「${mm[2]}」既被判定为同一个体，又被声明为不同个体`,
        reasonZh: '等价个体（sameAs）与互异声明（DifferentFrom/AllDifferent）相互矛盾；请检查实体合并（sameAs）规则或互异公理是否配置错误。',
      };
      break;
    case 'eq-diff2':
    case 'eq-diff3':
      // `${a} sameAs ${b} in AllDifferent[ distinctMembers]`
      mm = msg.match(/^(.+?) sameAs (.+?) in AllDifferent/);
      if (mm) return {
        messageZh: `「${mm[1]}」与「${mm[2]}」被推理为同一个体，但二者出现在同一条 AllDifferent（互异）声明中`,
        reasonZh: '互异公理要求声明中的个体两两不同，与 sameAs 推理结果冲突；请检查实体合并规则或互异声明的成员。',
      };
      break;
    case 'prp-pdw':
      // `${x} ${p1}/${p2} ${y}`
      mm = msg.match(/^(.+?) (.+?)\/(.+?) (.+)$/);
      if (mm) return {
        messageZh: `「${mm[1]}」与「${mm[4]}」之间同时存在互斥谓词「${mm[2]}」与「${mm[3]}」的边`,
        reasonZh: `「${mm[2]}」与「${mm[3]}」被声明为互斥谓词（DisjointObjectProperties），同一对个体不能同时以这两个谓词相连。请删去其中一条边。`,
      };
      break;
    case 'prp-adp':
      // `${u} disjoint props on ${v}`
      mm = msg.match(/^(.+?) disjoint props on (.+)$/);
      if (mm) return {
        messageZh: `「${mm[1]}」对「${mm[2]}」同时使用了多个互斥谓词`,
        reasonZh: '这些谓词被声明为两两互斥（DisjointObjectProperties），同一对个体之间只能出现其中之一。请删去多余的边。',
      };
      break;
    case 'prp-npa1':
      // `negative assertion violated: ${i1} ${p} ${i2}`
      mm = msg.match(/^negative assertion violated: (.+?) (.+?) (.+)$/);
      if (mm) return {
        messageZh: `「${mm[1]}」→「${mm[3]}」的「${mm[2]}」边违反了负断言`,
        reasonZh: '本体中存在 NegativeObjectPropertyAssertion（明确声明这两个个体之间不得建立该关系），而图谱里却存在（或被推理出）这条边。请删除该边或修正负断言。',
      };
      break;
    case 'prp-npa2':
      // `negative data assertion violated: ${i} ${p} ${lt}`
      mm = msg.match(/^negative data assertion violated: (.+?) (.+?) (.+)$/);
      if (mm) return {
        messageZh: `「${mm[1]}」的数据属性「${mm[2]}」取值 ${mm[3]} 违反了负断言`,
        reasonZh: '本体中存在 NegativeDataPropertyAssertion（明确声明该个体不得取此数据值），而图谱里却存在该断言。请修正数据或删除负断言。',
      };
      break;
    case 'cls-nothing2':
      // `${x} typed owl:Nothing`
      mm = msg.match(/^(.+) typed owl:Nothing$/);
      if (mm) return {
        messageZh: `「${mm[1]}」被归入 owl:Nothing（空类）`,
        reasonZh: 'Nothing 是空类，任何个体都不属于它；个体被推入 Nothing 说明其类型断言与本体公理矛盾。请检查该节点的类型标注。',
      };
      break;
    case 'cls-com':
      // `${x} in ${c1} and complement ${c2}`
      mm = msg.match(/^(.+?) in (.+?) and complement (.+)$/);
      if (mm) return {
        messageZh: `「${mm[1]}」既属于类「${mm[2]}」，又属于其补类「${mm[3]}」`,
        reasonZh: '一个类与其补类（complementOf）互斥，个体不能同时属于两者。请检查该节点的类型标注。',
      };
      break;
    case 'cls-maxc1':
      // `${u} violates maxCardinality 0 on ${p}`
      mm = msg.match(/^(.+?) violates maxCardinality 0 on (.+)$/);
      if (mm) return {
        messageZh: `「${mm[1]}」在谓词「${mm[2]}」上违反了最大基数 0 的限制`,
        reasonZh: `本体声明该类个体在「${mm[2]}」上最多 0 条出边（即不得有此类关系），而图谱中却存在。请删除相关边或修正基数公理。`,
      };
      break;
    case 'cls-maxqc1':
      // `${u} violates maxQualifiedCardinality 0`
      mm = msg.match(/^(.+?) violates maxQualifiedCardinality 0$/);
      if (mm) return {
        messageZh: `「${mm[1]}」违反了限定最大基数 0 的限制`,
        reasonZh: '本体声明该类个体对某个特定类最多 0 条限定关系，而图谱中却存在。请删除相关边或修正基数公理。',
      };
      break;
    case 'cls-maxqc2':
      // `${u} violates maxQC 0 on Thing`
      mm = msg.match(/^(.+?) violates maxQC 0 on Thing$/);
      if (mm) return {
        messageZh: `「${mm[1]}」违反了「对 Thing 最多 0 条关系」的限定基数限制`,
        reasonZh: '本体声明该类个体不得有任何此类出边，而图谱中却存在。请删除相关边或修正基数公理。',
      };
      break;
    case 'dt-not-type': {
      // `"${lex}" not in value space of nonNegativeInteger` / `not an integer` / `not a boolean`
      mm = msg.match(/^"(.*)" not in value space of nonNegativeInteger$/);
      if (mm) return {
        messageZh: `数据值「${mm[1]}」不在 nonNegativeInteger（非负整数）的取值空间内`,
        reasonZh: '该字面量被声明为非负整数类型，但取值不合法（如负数或非数字）。请修正数据。',
      };
      mm = msg.match(/^"(.*)" not an integer$/);
      if (mm) return {
        messageZh: `数据值「${mm[1]}」不是合法整数`,
        reasonZh: '该字面量被声明为整数类型，但取值无法解析为整数。请修正数据。',
      };
      mm = msg.match(/^"(.*)" not a boolean$/);
      if (mm) return {
        messageZh: `数据值「${mm[1]}」不是合法布尔值`,
        reasonZh: '该字面量被声明为布尔类型，但取值不是 true/false。请修正数据。',
      };
      break;
    }
    default:
      break;
  }
  // 兜底：未知规则或消息格式变化时，仍给出中文句式 + 原始消息
  return { messageZh: msg || '（无描述）', reasonZh: `触发规则 ${rule || '未知'}（消息格式未能解析，已保留原文供排查）。` };
}

/**
 * 给一组冲突补归属与中文说明。
 * @param {Array<{rule:string,message:string,raw?:string}>} inconsistencies
 * @param {object} ctx  graphToTriples 返回的 ctx
 * @param {Array} nodes  参与物化的图谱节点（带 domain）
 * @param {(domain:string)=>string} [scopeLabelOf]  domain → 知识图谱显示名（缺省用 domain 原值）
 */
function enrichConflicts(inconsistencies, ctx, nodes, scopeLabelOf) {
  const list = Array.isArray(inconsistencies) ? inconsistencies : [];
  if (!list.length) return list;
  const labelOf = typeof scopeLabelOf === 'function' ? scopeLabelOf : (d) => d;
  const nodeById = new Map();
  for (const n of nodes || []) if (n && n.id) nodeById.set(n.id, n);
  return list.map((c) => {
    const ids = conflictNodeIds(c);
    const nodeNames = [];
    const scopes = new Map(); // scopeKey -> { profile, domain, label }
    for (const id of ids) {
      const n = nodeById.get(id);
      if (n && n.name && !nodeNames.includes(n.name)) nodeNames.push(n.name);
      if (n) {
        // 与 graph.js runInference 的分组逻辑保持一致：profile 缺省时从 id 前缀推导
        const profile = n.profile || String(n.id).split(':')[0] || 'bfo-lite';
        const domain = (n.domain && String(n.domain).trim()) || 'general';
        const key = `${profile}|${domain}`;
        if (!scopes.has(key)) {
          scopes.set(key, {
            profile, domain,
            label: domain === 'general' ? '通用（未匹配领域）' : labelOf(domain),
          });
        }
      }
    }
    const zh = conflictChinese(c.rule, c.message, ctx);
    return {
      ...c,
      nodeIds: ids,
      nodeNames,
      scopeKeys: [...scopes.keys()],
      scopes: [...scopes.values()],
      messageZh: zh.messageZh,
      reasonZh: zh.reasonZh,
    };
  });
}

module.exports = {
  // 常量
  SYN_BASE, PREFIX_ID, PREFIX_TYPE, PREFIX_REL, SYN_PROFILE, RDFS_LABEL,
  FEATURE_IRI, AXIOM_TO_FEATURE,
  // IRI 工具
  enc, dec, iriId, iriType, iriRel, edgeKey, safeLiteral,
  // 主流程
  normalizeProfile, graphToTriples, triplesToInferredEdges,
  findPath, justify, humanizeIris,
  // 冲突富化（归属知识图谱 + 中文原因）
  conflictNodeIds, conflictChinese, enrichConflicts,
  // 透传，便于下游模块与测试统一从 bridge 取
  TripleStore, NS, P, C,
};
