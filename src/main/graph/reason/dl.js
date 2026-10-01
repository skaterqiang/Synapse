'use strict';

// ---------------------------------------------------------------------------
// reason/dl.js — dl-js-reasoner（OWL 2 DL hypertableau）适配层
//
// 设计依据：docs/design/Synapse×dl-js-reasoner融合设计.md §3.2–§3.4 / §4.1
//
// 职责：可用性探测、DL 公理合成（profile+图谱 → {getAxioms()} shim）、
//       推理驱动（TBox/ABox/CQ/蕴含）、结果映射、规模门控与静默降级。
//
// 契约（与 infer.js 同构，上游设计 D3）：
//   - 本模块**不写 kv**，只返回结果，由 graph.js 决定持久化（I4）。
//   - dl-js-reasoner 缺失/抛错时静默降级，绝不阻断 RL 主链路（I5/D6）。
//   - IRI 一律走 bridge 的 iriId/iriType/iriRel 常量，与 RL 路径、edgeKey
//     三者口径一致（I6/I1）。
//   - 推理边形态遵守 mergeInferredEdges 的 7 键契约，先以 inferredFromKeys
//     （身份键）给出溯源，由 mergeInferredEdges 统一换成数组下标。
//
// ⚠️ 实测注意事项（设计附录 B，均已本机核实）：
//   R7：不一致本体上 getUnsatisfiableClasses 返回**全部**类（含 owl:Thing），
//       必须先 isConsistent()，不一致时跳过不可满足类查询。
//   R8：DL 返回的 IRI 含 owl:Thing / owl:Nothing（getSubClasses(direct=true)
//       带出 Nothing、getTypes 带出 Thing），必须按 synapse.local 前缀白名单过滤。
//   R3：循环属性层级在 reasonerFor 构造期抛 IllegalArgumentException
//       （"The given property hierarchy is not regular"），try/catch 降级为
//       skipReason:'dl-irregular'。
//   R4：非 Horn 本体 query() 抛 "disjunctive heads"，用 getDLOntology().isHorn 预检。
//   Q-DL-5：getInstances(C, direct=true) 的 direct 语义存疑，一律 direct=false。
// ---------------------------------------------------------------------------

const bridge = require('./bridge');

// ---------- 惰性装载（模仿 owlImport.js 的 PJ 模块袋模式） ----------
let DL = null;      // require('dl-js-reasoner') 主入口
let E = null;       // OWLExpressions（E 工厂 + AxiomType + 内置 IRI 常量）
let AT = null;      // E.AxiomType
let dlError = '';

function dlAvailable() {
  if (DL) return true;
  if (dlError) return false;
  try {
    DL = require('dl-js-reasoner');
    E = require('dl-js-reasoner/src/owl/OWLExpressions.js');
    AT = E.AxiomType;
    if (typeof DL.reasonerFor !== 'function' || !E || !AT) {
      DL = null; E = null; AT = null;
      dlError = 'dl-js-reasoner 导出形态不符（缺 reasonerFor / OWLExpressions）';
      return false;
    }
    return true;
  } catch (err) {
    DL = null; E = null; AT = null;
    dlError = String((err && err.message) || err);
    return false;
  }
}

/** dl-js-reasoner 不可用的原因（供 UI 显示，而不是静默失效）。 */
function dlError_() { return dlError; }

// ---------- 规模门控阈值（§4.1.1，可经 settings/opts.limits 覆盖） ----------
const DL_LIMITS = {
  /** TBox 级：类数上限（实测 500 类纯 TBox 一致性 0ms，2000 留足余量） */
  maxClasses: 2000,
  /** ABox 级：个体数 × 类数 预算（对应实测 50×100≈517ms 的安全区） */
  aboxBudget: 20000,
  /** 传递属性/属性链 + 大 ABox 是最坏情况（实测 100×200 → 8s）：个体数上限 */
  transitiveIndividualCap: 80,
  /** profile.dlAxioms 参与合成的条数上限（与 owlImport 的 MAX_DL_AXIOMS 对齐） */
  maxDlAxioms: 600,
  /** 单次 ABox 推理回收的推理边上限（防 kv 撑爆） */
  maxInferredEdges: 5000,
};

// ---------- IRI 工具（I6：全部走 bridge 常量） ----------
const C_ = (key) => E.owlClass(bridge.iriType(key));
const P_ = (key) => E.objectProperty(bridge.iriRel(key));
const I_ = (id) => E.namedIndividual(bridge.iriId(id));

/**
 * 是否 Synapse 命名空间 IRI（白名单式过滤，R8）。
 * DL 结果里混有 owl:Thing / owl:Nothing / 内部定义类（internal:def#…），
 * 只认 synapse.local 三个前缀，其余一律丢弃。
 */
function isSynIri(iri) {
  const s = String(iri == null ? '' : iri);
  return s.startsWith(bridge.PREFIX_ID) || s.startsWith(bridge.PREFIX_TYPE) || s.startsWith(bridge.PREFIX_REL);
}
const typeKeyOf = (iri) => bridge.dec(String(iri).slice(bridge.PREFIX_TYPE.length));
const idOf = (iri) => bridge.dec(String(iri).slice(bridge.PREFIX_ID.length));
const relKeyOf = (iri) => bridge.dec(String(iri).slice(bridge.PREFIX_REL.length));

/** 过滤 DL 返回的 IRI 数组：只留指定前缀的 Synapse IRI，并反解为 key。 */
function pickKeys(iris, prefix, keyOf) {
  const out = [];
  for (const x of (Array.isArray(iris) ? iris : [])) {
    const s = String(x == null ? '' : x);
    if (!s.startsWith(prefix)) continue;   // 白名单：owl:Thing/Nothing/internal:* 全部落选
    const k = keyOf(s);
    if (k && !out.includes(k)) out.push(k);
  }
  return out.sort();
}

// ---------- Configuration（附录 A：Synapse 必须关不一致异常） ----------
function makeConfig(opts = {}) {
  const timeoutMs = Number(opts.timeoutMs);
  return {
    // 默认 true 会让不一致本体直接抛异常；Synapse 要拿到 isConsistent()===false 走冲突面板
    throwInconsistentOntologyException: false,
    // 复用既有 reasonTimeout 设置（graph.js reasonTimeoutSec × 1000）；<=0 视为不限时
    individualTaskTimeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.round(timeoutMs) : -1,
    bufferChanges: true,
    freshEntityPolicy: 'ALLOW',
  };
}

// ---------------------------------------------------------------------------
// 属性层级正则性轻检（R3 的前置门控）
//
// dl-js-reasoner 的 ObjectPropertyInclusionManager.checkForRegularity 对循环
// 属性层级抛 IllegalArgumentException。完整的正则性判定（含属性链展开）代价高，
// 这里只做**保守近似**：沿「严格子属性」边找环（等价属性对不构成严格边）。
// 近似漏判的残余情况由 reasonerFor 外层 try/catch 兜底（→ 'dl-irregular'）。
// ---------------------------------------------------------------------------
function propertyHierarchyRegular(model, dlAxioms) {
  const strict = new Map();   // prop key -> Set<super key>（严格 ⊑ 边）
  const addEdge = (sub, sup) => {
    if (!sub || !sup || sub === sup) return;
    if (!strict.has(sub)) strict.set(sub, new Set());
    strict.get(sub).add(sup);
  };
  for (const ax of (model && model.axioms) || []) {
    if (ax && ax.type === 'SubPropertyOf') addEdge(ax.subject, ax.object);
  }
  for (const d of (Array.isArray(dlAxioms) ? dlAxioms : [])) {
    if (!d) continue;
    if (d.type === 'SubObjectPropertyOf') addEdge(d.subProperty, d.superProperty);
    if (d.type === 'SubPropertyChainOf' && Array.isArray(d.propertyChain)) {
      // 链 R1∘…∘Rn ⊑ R 蕴含每个 Ri ⊑ R（正则性检查按此展开）
      for (const ri of d.propertyChain) addEdge(ri, d.superProperty);
    }
  }
  // DFS 找环
  const state = new Map();    // key -> 0  visiting | 1 done
  const visit = (k) => {
    const st = state.get(k);
    if (st === 0) return false;      // 环
    if (st === 1) return true;
    state.set(k, 0);
    for (const sup of (strict.get(k) || [])) if (!visit(sup)) return false;
    state.set(k, 1);
    return true;
  };
  for (const k of strict.keys()) if (!visit(k)) return false;
  return true;
}

/**
 * DL 推理对某体系是否可用（profile.js 的裁决入口，§4.2 改动点 2）。
 * 接受两种形态：protege-js OWLOntology（导入预览期）或 Synapse profile（推理期）。
 * 判定 = 模块可加载 && 类数 ≤ maxClasses && 属性层级近似正则。
 *
 * ⚠️ 没有本体也没有显式 classCount → **false**。旧实现会一路走到 `classCount = 0`
 *    然后返回 true，把「压根没东西可推」误报成「DL 可用」；调用方（profile.js /
 *    owlImport.js / ontologyBundle.js）拿到 true 就会去 buildDLOntology，纯属埋雷。
 */
function dlAvailableFor(ontologyOrProfile, opts = {}) {
  if (!dlAvailable()) return false;
  const limits = { ...DL_LIMITS, ...(opts.limits || {}) };
  let classCount = Number(opts.classCount);
  let model = null;
  let dlAxioms = [];
  if (!Number.isFinite(classCount)) {
    if (ontologyOrProfile && Array.isArray(ontologyOrProfile.classes)) {
      // Synapse profile
      classCount = ontologyOrProfile.classes.length;
      dlAxioms = Array.isArray(ontologyOrProfile.dlAxioms) ? ontologyOrProfile.dlAxioms : [];
      try { model = bridge.normalizeProfile(ontologyOrProfile); } catch (_) { model = null; }
    } else if (ontologyOrProfile && typeof ontologyOrProfile.getClassesInSignature === 'function') {
      // protege-js OWLOntology
      try { classCount = (ontologyOrProfile.getClassesInSignature() || []).length; } catch (_) { classCount = 0; }
    } else {
      return false;   // 既不是 profile 也不是 OWLOntology：无从判定，按不可用处理
    }
  }
  if (classCount > limits.maxClasses) return false;
  if (model && !propertyHierarchyRegular(model, dlAxioms)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 匿名类表达式树 → DL 表达式（§3.4 最后一行；树格式与 owlImport.js P3 约定一致）
//
// 树节点形态（中立存储，全部 key 为 Synapse 本地名）：
//   {kind:'class', key}                          → C(key)
//   {kind:'and'|'or', operands:[tree…]}          → 交/并
//   {kind:'not', operand:tree}                   → 补
//   {kind:'some'|'only', property:key, filler:tree}
//   {kind:'value', property:key, individual:id}
//   {kind:'self', property:key}
//   {kind:'oneOf', individuals:[id…]}
//   {kind:'min'|'max'|'exact', n, property:key, filler?:tree}
// 字符串视为具名类 key 的简写。
//
// ⚠️ 本函数被 owlImport.js 的序列化器与本模块的 buildDLOntology 共用，且是导出成员：
// 调用方可能在**任何**触发惰性装载的 API（buildDLOntology/reasonTBox/…）之前就用它，
// 所以开头必须自己 dlAvailable()，否则 E 为 null → `Cannot read properties of null`。
// ---------------------------------------------------------------------------
function exprFromTree(t) {
  if (t == null) return null;
  if (!dlAvailable()) return null;   // 未装载时退化为 null（调用方按「无法转换」计入 skipped）
  if (typeof t === 'string') return t ? C_(t) : null;
  if (typeof t !== 'object') return null;
  switch (t.kind) {
    case 'class': return t.key ? C_(t.key) : null;
    case 'and': {
      const ops = (Array.isArray(t.operands) ? t.operands : []).map(exprFromTree).filter(Boolean);
      return ops.length >= 2 ? E.objectIntersectionOf(ops) : (ops[0] || null);
    }
    case 'or': {
      const ops = (Array.isArray(t.operands) ? t.operands : []).map(exprFromTree).filter(Boolean);
      return ops.length >= 2 ? E.objectUnionOf(ops) : (ops[0] || null);
    }
    case 'not': {
      const op = exprFromTree(t.operand);
      return op ? E.objectComplementOf(op) : null;
    }
    case 'some': {
      const f = exprFromTree(t.filler);
      return (t.property && f) ? E.objectSomeValuesFrom(P_(t.property), f) : null;
    }
    case 'only': {
      const f = exprFromTree(t.filler);
      return (t.property && f) ? E.objectAllValuesFrom(P_(t.property), f) : null;
    }
    case 'value':
      return (t.property && t.individual) ? E.objectHasValue(P_(t.property), I_(t.individual)) : null;
    case 'self':
      return t.property ? E.objectHasSelf(P_(t.property)) : null;
    case 'oneOf': {
      const inds = (Array.isArray(t.individuals) ? t.individuals : []).filter(Boolean).map(I_);
      return inds.length ? E.objectOneOf(inds) : null;
    }
    case 'min': case 'max': case 'exact': {
      const n = Math.max(0, Math.round(Number(t.n) || 0));
      if (!t.property) return null;
      const p = P_(t.property);
      const f = exprFromTree(t.filler);
      if (t.kind === 'min') return f ? E.objectMinCardinality(n, p, f) : E.objectMinCardinality(n, p);
      if (t.kind === 'max') return f ? E.objectMaxCardinality(n, p, f) : E.objectMaxCardinality(n, p);
      return f ? E.objectExactCardinality(n, p, f) : E.objectExactCardinality(n, p);
    }
    default: return null;
  }
}

/** 数据范围树 → DL 数据范围（DatatypeDefinition 用；仅支持具名 datatype，其余跳过）。 */
function dataRangeFromTree(t) {
  if (!dlAvailable()) return null;   // 同 exprFromTree：导出成员必须自守
  if (typeof t === 'string' && t) return E.datatype(t);   // 已是完整 IRI 或本地名
  if (t && typeof t === 'object' && t.kind === 'datatype' && t.iri) return E.datatype(t.iri);
  return null;
}

// ---------------------------------------------------------------------------
// buildDLOntology — profile + 图谱 → { getAxioms() } shim（§3.3 / §3.4）
//
// D3：从**归一化 profile** 合成（bridge.normalizeProfile 已合并
// classes[].parent / axioms[] / predicates[].features 两个来源），
// 而非透传 protege-js OWLOntology —— 规避空前缀 IRI 陷阱（R5）且遵守 I6。
//
// @param {object} profile  已 resolveOntology 的体系
// @param {{nodes:Array, edges:Array}} [graph]  ABox 来源；opts.abox 为真时才合成
// @param {object} [opts] {abox:boolean, limits?:object}
//   limits 与 gateScale 同口径（{...DL_LIMITS, ...limits}），当前只消费 maxDlAxioms；
//   不传时完全等价于 DL_LIMITS 默认值（既有调用方零感知）。
// @returns {object} shim：除 getAxioms() 外携带合成期上下文
//   （classKeys/propertyKeys/individualKeys/originals/adjByRel/model/stats），
//   供 reasonTBox/reasonABox 的结果映射与溯源使用。
// ---------------------------------------------------------------------------
function buildDLOntology(profile, graph, opts = {}) {
  if (!dlAvailable()) throw new Error(dlError || 'dl-js-reasoner 不可用');
  const m = bridge.normalizeProfile(profile);
  // 规模上限可被 settings 覆盖（融合设计 §12）：与 gateScale 用同一份合并口径，
  // 否则「设置里调大了 maxDlAxioms，门控放行但合成仍按 600 条截断」会自相矛盾。
  const L = { ...DL_LIMITS, ...((opts && opts.limits) || {}) };
  const maxDlAxioms = (Number.isFinite(Number(L.maxDlAxioms)) && Number(L.maxDlAxioms) >= 0)
    ? Math.round(Number(L.maxDlAxioms)) : DL_LIMITS.maxDlAxioms;
  const axioms = [];
  const declaredClasses = new Set();
  const declaredProps = new Set();
  const declaredInds = new Set();
  const declClass = (k) => {
    if (!k || declaredClasses.has(k)) return;
    declaredClasses.add(k);
    axioms.push({ axiomType: AT.DECLARATION, entity: C_(k) });
  };
  const declProp = (k) => {
    if (!k || declaredProps.has(k)) return;
    declaredProps.add(k);
    axioms.push({ axiomType: AT.DECLARATION, entity: P_(k) });
  };
  const declInd = (id) => {
    if (!id || declaredInds.has(id)) return;
    declaredInds.add(id);
    axioms.push({ axiomType: AT.DECLARATION, entity: I_(id) });
  };

  // --- TBox 1：类声明 + 类层级（parentsOf 已合并 parent 字段/SubClassOf/EquivalentClasses 公理） ---
  for (const c of m.classes) declClass(c.key);
  for (const [child, parents] of m.parentsOf) {
    declClass(child);
    for (const p of parents) { declClass(p); axioms.push(E.subclassOf(C_(child), C_(p))); }
  }
  for (const [a, b] of m.disjoint) {
    declClass(a); declClass(b);
    axioms.push(E.disjointClasses([C_(a), C_(b)]));
  }

  // --- TBox 2：谓词声明 + 特性 + domain/range + 互逆 ---
  for (const p of m.predicates) declProp(p.key);
  // 特性公理（normalizeProfile 的 features 合并了 predicates[].features 与 axioms[]；
  // ⚠️ reflexive 在 AXIOM_TO_FEATURE 里被 RL 路径显式忽略（映射为 null），
  //    DL 路径支持，故额外扫一遍原始公理把 ReflexiveProperty 捞回来）
  const FEATURE_AX = {
    transitive: () => AT.TRANSITIVE_OBJECT_PROPERTY,
    symmetric: () => AT.SYMMETRIC_OBJECT_PROPERTY,
    asymmetric: () => AT.ASYMMETRIC_OBJECT_PROPERTY,
    functional: () => AT.FUNCTIONAL_OBJECT_PROPERTY,
    inverseFunctional: () => AT.INVERSE_FUNCTIONAL_OBJECT_PROPERTY,
    irreflexive: () => AT.IRREFLEXIVE_OBJECT_PROPERTY,
    reflexive: () => AT.REFLEXIVE_OBJECT_PROPERTY,
  };
  for (const [relKey, feats] of m.features) {
    declProp(relKey);
    for (const f of feats) {
      const t = FEATURE_AX[f] && FEATURE_AX[f]();
      if (t) axioms.push({ axiomType: t, property: P_(relKey) });
    }
  }
  for (const ax of m.axioms) {
    if (ax && ax.type === 'ReflexiveProperty' && ax.subject && !m.features.get(ax.subject)?.has('reflexive')) {
      declProp(ax.subject);
      axioms.push({ axiomType: AT.REFLEXIVE_OBJECT_PROPERTY, property: P_(ax.subject) });
    }
  }
  const inverseSeen = new Set();
  for (const [relKey, invs] of m.inverseOf) {
    declProp(relKey);
    for (const inv of invs) {
      declProp(inv);
      const pk = [relKey, inv].sort().join('\u0001');
      if (inverseSeen.has(pk)) continue;   // inverseOf 是对称闭包，每对只发一条
      inverseSeen.add(pk);
      axioms.push({ axiomType: AT.INVERSE_OBJECT_PROPERTIES, firstProperty: P_(relKey), secondProperty: P_(inv) });
    }
  }
  for (const [relKey, set] of m.domain) {
    declProp(relKey);
    for (const t of set) { declClass(t); axioms.push({ axiomType: AT.OBJECT_PROPERTY_DOMAIN, property: P_(relKey), domain: C_(t) }); }
  }
  for (const [relKey, set] of m.range) {
    declProp(relKey);
    for (const t of set) { declClass(t); axioms.push({ axiomType: AT.OBJECT_PROPERTY_RANGE, property: P_(relKey), range: C_(t) }); }
  }
  // 公理表里的 SubPropertyOf / EquivalentProperties
  for (const ax of m.axioms) {
    if (!ax || !ax.subject || !ax.object) continue;
    if (ax.type === 'SubPropertyOf') {
      declProp(ax.subject); declProp(ax.object);
      axioms.push({ axiomType: AT.SUB_OBJECT_PROPERTY_OF, subProperty: P_(ax.subject), superProperty: P_(ax.object) });
    } else if (ax.type === 'EquivalentProperties') {
      declProp(ax.subject); declProp(ax.object);
      axioms.push({ axiomType: AT.EQUIVALENT_OBJECT_PROPERTIES, properties: [P_(ax.subject), P_(ax.object)] });
    }
  }

  // --- TBox 3：profile.dlAxioms（§3.4 的 12 类 + 匿名类表达式；P3 由 owlImport 产出） ---
  const dlAxioms = Array.isArray(profile && profile.dlAxioms) ? profile.dlAxioms : [];
  let dlAxiomsConverted = 0, dlAxiomsSkipped = 0;
  const pushDl = (a) => { if (a) { axioms.push(a); dlAxiomsConverted++; } else dlAxiomsSkipped++; };
  for (const d of dlAxioms.slice(0, maxDlAxioms)) {
    if (!d || !d.type) { dlAxiomsSkipped++; continue; }
    switch (d.type) {
      case 'EquivalentClasses': {
        const ces = (Array.isArray(d.classExpressions) ? d.classExpressions : []).map(exprFromTree).filter(Boolean);
        for (const x of (d.classExpressions || [])) if (typeof x === 'string') declClass(x);
        pushDl(ces.length >= 2 ? E.equivalentClasses(ces) : null);
        break;
      }
      case 'DisjointUnion': {
        const ces = (Array.isArray(d.classExpressions) ? d.classExpressions : []).map(exprFromTree).filter(Boolean);
        if (!d.owlClass || ces.length < 2) { pushDl(null); break; }
        declClass(d.owlClass);
        for (const x of d.classExpressions) if (typeof x === 'string') declClass(x);
        pushDl(E.disjointUnion(C_(d.owlClass), ces));
        break;
      }
      case 'SubClassOfExpression': {
        // 匿名类表达式承载的 SubClassOf（sub/super 为树或类 key 字符串）
        const sub = exprFromTree(d.sub), sup = exprFromTree(d.super);
        if (typeof d.sub === 'string') declClass(d.sub);
        if (typeof d.super === 'string') declClass(d.super);
        pushDl((sub && sup) ? E.subclassOf(sub, sup) : null);
        break;
      }
      case 'SubObjectPropertyOf': {
        if (!d.subProperty || !d.superProperty) { pushDl(null); break; }
        declProp(d.subProperty); declProp(d.superProperty);
        pushDl({ axiomType: AT.SUB_OBJECT_PROPERTY_OF, subProperty: P_(d.subProperty), superProperty: P_(d.superProperty) });
        break;
      }
      case 'SubPropertyChainOf': {
        const chain = (Array.isArray(d.propertyChain) ? d.propertyChain : []).filter(Boolean);
        if (chain.length < 2 || !d.superProperty) { pushDl(null); break; }
        for (const p of chain) declProp(p);
        declProp(d.superProperty);
        pushDl({ axiomType: AT.SUB_PROPERTY_CHAIN_OF, propertyChain: chain.map(P_), superProperty: P_(d.superProperty) });
        break;
      }
      case 'EquivalentObjectProperties': {
        const props = (Array.isArray(d.properties) ? d.properties : []).filter(Boolean);
        if (props.length < 2) { pushDl(null); break; }
        for (const p of props) declProp(p);
        pushDl({ axiomType: AT.EQUIVALENT_OBJECT_PROPERTIES, properties: props.map(P_) });
        break;
      }
      case 'DisjointObjectProperties': {
        const props = (Array.isArray(d.properties) ? d.properties : []).filter(Boolean);
        if (props.length < 2) { pushDl(null); break; }
        for (const p of props) declProp(p);
        pushDl({ axiomType: AT.DISJOINT_OBJECT_PROPERTIES, properties: props.map(P_) });
        break;
      }
      case 'HasKey': {
        const ce = exprFromTree(d.classExpression);
        const props = (Array.isArray(d.propertyExpressions) ? d.propertyExpressions : []).filter(Boolean);
        if (!ce || !props.length) { pushDl(null); break; }
        if (typeof d.classExpression === 'string') declClass(d.classExpression);
        for (const p of props) declProp(p);
        pushDl(E.hasKey(ce, props.map(P_)));
        break;
      }
      case 'SameIndividual': {
        const inds = (Array.isArray(d.individuals) ? d.individuals : []).filter(Boolean);
        if (inds.length < 2) { pushDl(null); break; }
        for (const x of inds) declInd(x);
        pushDl(E.sameIndividual(inds.map(I_)));
        break;
      }
      case 'DifferentIndividuals': {
        const inds = (Array.isArray(d.individuals) ? d.individuals : []).filter(Boolean);
        if (inds.length < 2) { pushDl(null); break; }
        for (const x of inds) declInd(x);
        pushDl(E.differentIndividuals(inds.map(I_)));
        break;
      }
      case 'DatatypeDefinition': {
        const dr = dataRangeFromTree(d.dataRange);
        pushDl((d.datatype && dr) ? { axiomType: AT.DATATYPE_DEFINITION, datatype: E.datatype(d.datatype), dataRange: dr } : null);
        break;
      }
      case 'NegativeObjectPropertyAssertion': {
        if (!d.subject || !d.property || !d.object) { pushDl(null); break; }
        declProp(d.property); declInd(d.subject); declInd(d.object);
        pushDl(E.negativeObjectPropertyAssertion(P_(d.property), I_(d.subject), I_(d.object)));
        break;
      }
      case 'SubDataPropertyOf': {
        if (!d.subProperty || !d.superProperty) { pushDl(null); break; }
        pushDl({ axiomType: AT.SUB_DATA_PROPERTY_OF, subProperty: E.dataProperty(bridge.iriRel(d.subProperty)), superProperty: E.dataProperty(bridge.iriRel(d.superProperty)) });
        break;
      }
      default:
        dlAxiomsSkipped++;
    }
  }

  // --- ABox（仅 opts.abox；受 gateScale 门控，D4） ---
  const nodes = (opts.abox && graph && Array.isArray(graph.nodes)) ? graph.nodes : [];
  const rawEdges = (opts.abox && graph && Array.isArray(graph.edges)) ? graph.edges : [];
  const originals = new Set();          // 原始边身份键（推理边去重 + 溯源）
  const adjByRel = new Map();           // relKey -> Map<from, Set<to>>（传递溯源用）
  const validIds = new Set();
  const fbType = m.fallbackType || '';
  for (const n of nodes) {
    if (!n || !n.id) continue;
    validIds.add(n.id);
    declInd(n.id);
    const t = n.type || fbType;
    if (t) { declClass(t); axioms.push(E.classAssertion(C_(t), I_(n.id))); }
  }
  const fbRel = m.fallbackRel || '';
  for (const e of rawEdges) {
    if (!e || !e.from || !e.to || e.inferred) continue;   // I3：旧推理边不回喂
    if (!validIds.has(e.from) || !validIds.has(e.to)) continue;
    const rel = m.relAlias.get(e.rel) || e.rel || fbRel;
    if (!rel) continue;
    declProp(rel);
    const k = bridge.edgeKey(e.from, e.to, rel);
    if (originals.has(k)) continue;
    originals.add(k);
    axioms.push(E.objectPropertyAssertion(P_(rel), I_(e.from), I_(e.to)));
    if (!adjByRel.has(rel)) adjByRel.set(rel, new Map());
    const adj = adjByRel.get(rel);
    if (!adj.has(e.from)) adj.set(e.from, new Set());
    adj.get(e.from).add(e.to);
  }

  return {
    getAxioms: () => axioms,
    axioms,
    model: m,
    classKeys: [...declaredClasses].sort(),
    propertyKeys: [...declaredProps].sort(),
    individualKeys: [...declaredInds],
    originals, adjByRel,
    transitive: m.transitive, symmetric: m.symmetric, inverseOf: m.inverseOf,
    abox: !!opts.abox,
    stats: {
      axioms: axioms.length,
      classes: declaredClasses.size,
      properties: declaredProps.size,
      individuals: declaredInds.size,
      dlAxiomsConverted,
      dlAxiomsSkipped,
    },
  };
}

// ---------------------------------------------------------------------------
// gateScale — 规模门控（§4.1.1，D4）
// @returns {{allowTBox:boolean, allowABox:boolean, reason:string,
//            classCount:number, individualCount:number, budgetUsed:number}}
// ---------------------------------------------------------------------------
function gateScale(profile, graph, limits) {
  const L = { ...DL_LIMITS, ...(limits || {}) };
  const classCount = (profile && Array.isArray(profile.classes)) ? profile.classes.length : 0;
  const individualCount = (graph && Array.isArray(graph.nodes))
    ? graph.nodes.filter((n) => n && n.id && !n.inferred).length : 0;
  const base = { classCount, individualCount, budgetUsed: individualCount * Math.max(1, classCount) };
  if (classCount > L.maxClasses) {
    return { ...base, allowTBox: false, allowABox: false, reason: 'dl-too-large' };
  }
  let allowABox = base.budgetUsed <= L.aboxBudget;
  let reason = allowABox ? '' : 'dl-abox-budget';
  // 传递属性/属性链 + 大 ABox 是最坏情况（实测 100 类×200 个体 → 8s/10.7s）
  if (allowABox && individualCount > L.transitiveIndividualCap && hasTransitiveFuel(profile)) {
    allowABox = false;
    reason = 'dl-abox-budget';
  }
  return { ...base, allowTBox: true, allowABox, reason };
}

/** 体系是否含传递属性/属性链（ABox 最坏情况的燃料）。 */
function hasTransitiveFuel(profile) {
  const p = profile || {};
  for (const r of (Array.isArray(p.predicates) ? p.predicates : [])) {
    if (r && Array.isArray(r.features) && r.features.includes('transitive')) return true;
  }
  for (const ax of (Array.isArray(p.axioms) ? p.axioms : [])) {
    if (ax && ax.type === 'TransitiveProperty') return true;
  }
  for (const d of (Array.isArray(p.dlAxioms) ? p.dlAxioms : [])) {
    if (d && d.type === 'SubPropertyChainOf') return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 推理驱动
// ---------------------------------------------------------------------------

/** 错误消息 → skipReason 归类。 */
function classifyError(err) {
  const msg = String((err && err.message) || err || '');
  if (/not regular/i.test(msg)) return 'dl-irregular';
  if (/exceeded the time limit|InterruptedException/i.test(msg)) return 'dl-timeout';
  if (/disjunctive heads/i.test(msg)) return 'dl-non-horn';
  // QuerySpec.toTerm 对 null/undefined 显式抛错 —— 这是**调用方的 spec 写错了**，
  // 不是推理引擎出问题，归到 dl-bad-spec（与 answerCQ 自己的空 where 守卫同码）。
  // ⚠️ dl-bad-spec 只在交互式探针路径（answerCQ/answerCQs/entail）出现，
  //    infer.js 只调 reasonTBox/reasonABox，故它无需进 SKIP_REASON_TEXT。
  if (/cannot be null or undefined/i.test(msg)) return 'dl-bad-spec';
  return 'dl-error';
}

/**
 * TBox 级推理（一致性 / 不可满足类 / 分类）。始终允许（过 gateScale 后）。
 *
 * ⚠️ R7：必须先 isConsistent()；不一致时 getUnsatisfiableClasses 返回全部类
 * （含 owl:Thing），结果无意义 —— 不一致时跳过该查询，只报 inconsistent。
 *
 * @param {object} ont  buildDLOntology 的返回
 * @param {object} [config]  makeConfig 的返回（或含 timeoutMs 的 opts）
 * @returns {{skipped:boolean, skipReason?:string, error?:string, consistent:boolean|null,
 *            unsatClasses:string[], hierarchy:object|null, topClasses:string[],
 *            elapsedMs:number, stats:object|null}}
 */
function reasonTBox(ont, config) {
  const t0 = Date.now();
  const empty = { skipped: true, consistent: null, unsatClasses: [], hierarchy: null, topClasses: [], elapsedMs: 0, stats: null };
  if (!dlAvailable()) return { ...empty, skipReason: 'dl-unavailable', error: dlError, elapsedMs: Date.now() - t0 };
  let r = null;
  try {
    r = DL.reasonerFor(ont, config && config.throwInconsistentOntologyException !== undefined ? config : makeConfig(config || {}));
    const consistent = !!r.isConsistent();
    let unsatClasses = [];
    if (consistent) {
      unsatClasses = pickKeys(r.getUnsatisfiableClasses(), bridge.PREFIX_TYPE, typeKeyOf);
    }
    // 分类：每个具名类的直接父/子（过滤 owl:Thing/Nothing/internal:*，R8）
    const hierarchy = {};
    for (const key of ont.classKeys) {
      const ce = C_(key);
      const supers = pickKeys(r.getSuperClasses(ce, true), bridge.PREFIX_TYPE, typeKeyOf).filter((k) => k !== key);
      const subs = pickKeys(r.getSubClasses(ce, true), bridge.PREFIX_TYPE, typeKeyOf).filter((k) => k !== key);
      if (supers.length || subs.length) hierarchy[key] = { supers, subs };
    }
    const topClasses = pickKeys(r.getTopClasses(), bridge.PREFIX_TYPE, typeKeyOf);
    let stats = null;
    try { stats = r.getTableauStatistics(); } catch (_) { /* 可选 */ }
    return { skipped: false, consistent, unsatClasses, hierarchy, topClasses, elapsedMs: Date.now() - t0, stats };
  } catch (err) {
    return { ...empty, skipReason: classifyError(err), error: String((err && err.message) || err), elapsedMs: Date.now() - t0 };
  } finally {
    if (r) { try { r.dispose(); } catch (_) { /* 忽略 */ } }
  }
}

/**
 * DL 推理边的溯源（与 bridge.justify 同思路的简化版）：
 * 对称 → 反向原始边；互逆 → 反向逆谓词原始边；传递 → 原始边最短路径。
 * 找不到前提时给空数组（mergeInferredEdges 允许 bound=0）。
 */
function justifyDl(fromId, toId, rel, ont) {
  const rev = bridge.edgeKey(toId, fromId, rel);
  if (ont.symmetric && ont.symmetric.has(rel) && ont.originals.has(rev)) return [rev];
  for (const inv of ((ont.inverseOf && ont.inverseOf.get(rel)) || [])) {
    const ik = bridge.edgeKey(toId, fromId, inv);
    if (ont.originals.has(ik)) return [ik];
  }
  if (ont.transitive && ont.transitive.has(rel)) {
    const path = bridge.findPath(ont.adjByRel.get(rel), fromId, toId, rel);
    if (path && path.length) return path;
  }
  return [];
}

/**
 * ABox 级推理（realisation / 属性值 → 推理边）。受 gateScale + 显式触发门控（D4）。
 *
 * 结果映射（§4.1.2）：
 *   - 不一致 → inconsistencies 一条 {rule:'dl-inconsistent'}，其余查询全部跳过（R7）
 *   - getObjectPropertyValues 的新增对 → 推理边 inferredVia:'dl-tableau'
 *   - getTypes → types（nodeId → [classKey]，数据形态，不落边——节点类型是 n.type 字段不是边）
 *   - getSameIndividuals → sameAs（数据形态，供 UI/修复参考）
 *
 * Q-DL-3 决议：DL 分类产生的类层级**不落图边**——Synapse 图边连接实例节点，
 * 类不是节点，落边会产生渲染端不可见的僵尸边（renderer 按 ids.has(e.from) 过滤）。
 * 类层级经 reasonTBox.hierarchy → dlHierarchy IPC / meta.lastStats.dl 暴露。
 *
 * @returns {{skipped:boolean, skipReason?:string, error?:string, consistent:boolean|null,
 *            inferredEdges:Array, inconsistencies:Array, types:object, sameAs:Array,
 *            elapsedMs:number, stats:object|null}}
 */
function reasonABox(ont, config, opts = {}) {
  const t0 = Date.now();
  const empty = { skipped: true, consistent: null, inferredEdges: [], inconsistencies: [], types: {}, sameAs: [], elapsedMs: 0, stats: null };
  if (!dlAvailable()) return { ...empty, skipReason: 'dl-unavailable', error: dlError, elapsedMs: Date.now() - t0 };
  if (!ont || !ont.abox) return { ...empty, skipReason: 'dl-no-abox', error: '本体未含 ABox（buildDLOntology 需 opts.abox=true）', elapsedMs: Date.now() - t0 };
  // ⚠️ 上限语义：调用方**显式**给了非负有限数就照办（含 0 = 一条都不出），
  //    只有「没给 / 负数 / NaN / Infinity」才回落默认值。
  //    旧写法 `Number(x) > 0 ? … : 默认` 把 0 当 falsy 吞掉 → 请求 0 条却拿到 5000 条，
  //    而这个上限是保护 kv 存储的硬约束，必须能被调用方真正压到 0。
  const capReq = Number(opts.maxInferredEdges);
  const maxEdges = (Number.isFinite(capReq) && capReq >= 0) ? Math.round(capReq) : DL_LIMITS.maxInferredEdges;
  let r = null;
  try {
    r = DL.reasonerFor(ont, config && config.throwInconsistentOntologyException !== undefined ? config : makeConfig(config || {}));
    const consistent = !!r.isConsistent();
    if (!consistent) {
      // R7：不一致本体上其余查询无意义（unsat 会返回全部类）
      return {
        skipped: false, consistent: false, inferredEdges: [],
        inconsistencies: [{
          rule: 'dl-inconsistent',
          message: 'DL tableau detected ontology inconsistency',
          messageZh: '本体不一致（DL tableau 检出）',
          reasonZh: '体系公理与图谱断言经完整 OWL 2 DL 推理后矛盾（如互斥类同时实例化、函数属性多值、负断言被违反等）。请检查「语义冲突」与不可满足类清单。',
          raw: '',
        }],
        types: {}, sameAs: [], elapsedMs: Date.now() - t0, stats: safeStats(r),
      };
    }

    const now = Date.now();
    const inferredEdges = [];
    const seen = new Set();
    // --- 属性值推理（dl-tableau 边）：个体 × 谓词 ---
    for (const ind of ont.individualKeys) {
      if (inferredEdges.length >= maxEdges) break;
      for (const rel of ont.propertyKeys) {
        if (inferredEdges.length >= maxEdges) break;
        let values;
        try { values = r.getObjectPropertyValues(I_(ind), P_(rel)); } catch (_) { continue; }
        for (const vIri of pickKeys(values, bridge.PREFIX_ID, idOf)) {
          // ⚠️ 上限检查必须在**最内层**：外层两处 break 只在「换个体/换谓词」时生效，
          // 单个 (个体, 谓词) 对可能一次返回多个值（如传递闭包），会把 maxInferredEdges
          // 顶穿（实测 cap=1 → 2 条边）。这个上限是用来保护 kv 存储的硬约束，不能超发。
          if (inferredEdges.length >= maxEdges) break;
          if (vIri === ind) continue;                       // 自环不入图（与 bridge 同口径）
          const k = bridge.edgeKey(ind, vIri, rel);
          if (ont.originals.has(k) || seen.has(k)) continue; // 已有原始边/已收 → 不算新边
          seen.add(k);
          inferredEdges.push({
            from: ind, to: vIri, rel,
            inferred: true,
            inferredFromKeys: justifyDl(ind, vIri, rel, ont),
            inferredVia: 'dl-tableau',
            inferredAt: now,
            inferredBy: 'dl-js-reasoner',
          });
        }
      }
    }

    // --- realisation：个体类型（数据形态；Q-DL-5 → getTypes 不带 direct，取全集后过滤内置类） ---
    const types = {};
    const declared = new Set(ont.classKeys);
    for (const ind of ont.individualKeys) {
      let ts;
      try { ts = r.getTypes(I_(ind)); } catch (_) { continue; }
      const keys = pickKeys(ts, bridge.PREFIX_TYPE, typeKeyOf).filter((k) => declared.has(k));
      if (keys.length) types[ind] = keys;
    }

    // --- sameAs 组（数据形态） ---
    const sameAs = [];
    const sameSeen = new Set();
    for (const ind of ont.individualKeys) {
      if (sameSeen.has(ind)) continue;
      let group;
      try { group = r.getSameIndividuals(I_(ind)); } catch (_) { continue; }
      const members = pickKeys(group, bridge.PREFIX_ID, idOf);
      const all = [ind, ...members.filter((x) => x !== ind)].sort();
      if (all.length < 2) continue;
      for (const x of all) sameSeen.add(x);
      sameAs.push(all);
    }

    return {
      skipped: false, consistent: true,
      inferredEdges,
      inconsistencies: [],
      types, sameAs,
      elapsedMs: Date.now() - t0,
      stats: safeStats(r),
    };
  } catch (err) {
    return { ...empty, skipReason: classifyError(err), error: String((err && err.message) || err), elapsedMs: Date.now() - t0 };
  } finally {
    if (r) { try { r.dispose(); } catch (_) { /* 忽略 */ } }
  }
}

function safeStats(r) {
  try { return r.getTableauStatistics(); } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// 合取查询（CQ）与蕴含探针（IPC 交互式，不落库，§4.1.2）
// ---------------------------------------------------------------------------

/** spec 里的项 → IRI：已是 synapse.local IRI 则原样，否则按类别当 key 编码。 */
function termToIri(x, kind) {
  if (x && typeof x === 'object') return x;   // {variable|individual|literal} 包装原样透传
  const s = String(x == null ? '' : x);
  if (!s) return s;
  if (s.startsWith('?') || s.startsWith('https://synapse.local/')) return s;
  if (kind === 'class') return bridge.iriType(s);
  if (kind === 'rel') return bridge.iriRel(s);
  return bridge.iriId(s);   // individual
}

/**
 * 合取查询（仅 Horn 本体，R4 预检）。
 * @param {object} ont  buildDLOntology 返回（须含 ABox 才有实例答案）
 * @param {object} spec  {select?:['?X',…], where:[atom…]}；atom 的 class/objectProperty/
 *                       individual 可用 Synapse key（自动转 IRI）或完整 IRI
 * @returns {{ok:boolean, reason?:string, error?:string, answers:Array, columns:Array,
 *            isHorn:boolean|null, elapsedMs:number}}
 */
function answerCQ(ont, spec, config) {
  const t0 = Date.now();
  const fail = (reason, error) => ({ ok: false, reason, error: error || '', answers: [], columns: [], isHorn: null, elapsedMs: Date.now() - t0 });
  if (!dlAvailable()) return fail('dl-unavailable', dlError);
  if (!spec || !Array.isArray(spec.where) || !spec.where.length) return fail('dl-bad-spec', 'CQ 需要非空 where 原子列表');
  let r = null;
  try {
    r = DL.reasonerFor(ont, config && config.throwInconsistentOntologyException !== undefined ? config : makeConfig(config || {}));
    let isHorn = null;
    try { isHorn = !!(r.getDLOntology() || {}).isHorn; } catch (_) { /* 取不到则放行，靠 query 抛错兜底 */ }
    if (isHorn === false) return { ...fail('dl-non-horn', '本体非 Horn，合取查询不可用（一致性/分类仍可用）'), isHorn: false };
    const select = Array.isArray(spec.select) ? spec.select : [];
    const rows = r.query({ select, where: cqWhereToIri(spec.where) });
    const answers = (Array.isArray(rows) ? rows : []).map((row) => (Array.isArray(row) ? row : [row]).map(normTerm));
    return { ok: true, answers, columns: select.slice(), isHorn, elapsedMs: Date.now() - t0 };
  } catch (err) {
    return fail(classifyError(err), String((err && err.message) || err));
  } finally {
    if (r) { try { r.dispose(); } catch (_) { /* 忽略 */ } }
  }
}

/** 答案项 → 可序列化形态：Synapse IRI 反解为 {kind,value}，其余转字符串。 */
function normTerm(t) {
  if (t == null) return { kind: 'null', value: '' };
  if (typeof t === 'object') {
    if (t.variable) return { kind: 'variable', value: String(t.variable) };
    if (t.individual) return normTerm(t.individual);
    if (t.literal !== undefined) return { kind: 'literal', value: String(t.literal) };
    if (typeof t.toString === 'function') return normTerm(t.toString());
    return { kind: 'unknown', value: JSON.stringify(t).slice(0, 200) };
  }
  const s = String(t);
  if (s.startsWith(bridge.PREFIX_ID)) return { kind: 'individual', value: idOf(s) };
  if (s.startsWith(bridge.PREFIX_TYPE)) return { kind: 'class', value: typeKeyOf(s) };
  if (s.startsWith(bridge.PREFIX_REL)) return { kind: 'rel', value: relKeyOf(s) };
  if (isSynIri(s)) return { kind: 'iri', value: s };
  return { kind: 'term', value: s };
}

/**
 * spec.where 的原子 → IRI 形态（answerCQ / answerCQs 共用）。
 *
 * ⚠️ **每个 term 位都要过 termToIri**：QuerySpec.toTerm 把「不以 ? 开头的字符串」
 * 一律当 Individual IRI 原样用，所以 Synapse 的节点 id（`owl:foo:d1`）若不先编码成
 * `https://synapse.local/id/...`，查询会静默返回 0 行（不报错，最难查的一类 bug）。
 * 变量（`?x`）、`{individual|variable|literal}` 包装、已是 synapse.local 的 IRI
 * 都由 termToIri 原样透传，故这里可以无条件套用。
 */
function cqWhereToIri(where) {
  // null/undefined 必须原样传下去：QuerySpec.toTerm 对它们**显式抛错**，
  // 而 termToIri 会把 undefined 变成空串 → createIndividual('')，把「缺参数」
  // 这种真错误伪装成「查了个空 IRI 的个体、0 行答案」。
  const t = (v, kind) => (v == null ? v : termToIri(v, kind));
  return (Array.isArray(where) ? where : []).map((a) => {
    if (!a || typeof a !== 'object') return a;
    if (a.class !== undefined) return { class: t(a.class, 'class'), arg: t(a.arg, 'individual') };
    if (a.objectProperty !== undefined) {
      return { objectProperty: t(a.objectProperty, 'rel'), subject: t(a.subject, 'individual'), object: t(a.object, 'individual') };
    }
    if (a.inverseObjectProperty !== undefined) {
      return { inverseObjectProperty: t(a.inverseObjectProperty, 'rel'), subject: t(a.subject, 'individual'), object: t(a.object, 'individual') };
    }
    if (a.dataProperty !== undefined) {
      // value 是字面量：裸字符串保持原样（QuerySpec 按 Constant 处理），
      // 只有 {literal|lexicalValue} 包装才透传；绝不能当个体 IRI 编码。
      const v = typeof a.value === 'string' ? a.value : t(a.value, 'individual');
      return { dataProperty: t(a.dataProperty, 'rel'), subject: t(a.subject, 'individual'), value: v };
    }
    if (a.datatype !== undefined) return { datatype: t(a.datatype, 'class'), arg: t(a.arg, 'individual') };
    if (Array.isArray(a.differentFrom)) return { differentFrom: a.differentFrom.map((x) => t(x, 'individual')) };
    return a;
  });
}

/**
 * 批量合取查询（§6.2 kgAsk CQ 召回）。
 *
 * 与逐条调用 {@link answerCQ} 的区别：**只构造一次推理机**。
 * 单次 `reasonerFor` 会做完整的 clausification + ABox 物化（个体×类规模下是主要开销），
 * kgAsk 一次问答要跑「种子 × 谓词」量级的查询，逐条构造会把毫秒级查询放大成秒级。
 * 这里复用同一个 reasoner 的 datalog engine 评估全部 spec。
 *
 * 语义与 answerCQ 完全一致：非 Horn 整体失败（R4）；单条 spec 出错只标记该条，
 * 不影响其余（问答是增强项，宁可少召回也不能整段失败）。
 *
 * @param {object} ont  buildDLOntology 返回（须含 ABox 才有实例答案）
 * @param {Array<object>} specs  与 answerCQ 的 spec 同形态
 * @param {object} [config]
 * @returns {{ok:boolean, reason?:string, error?:string, isHorn:boolean|null,
 *            results:Array<{ok:boolean, reason?:string, error?:string, answers:Array,
 *            columns:Array, elapsedMs:number}>, elapsedMs:number}}
 */
function answerCQs(ont, specs, config) {
  const t0 = Date.now();
  const list = Array.isArray(specs) ? specs : [];
  const fail = (reason, error) => ({ ok: false, reason, error: error || '', isHorn: null, results: [], elapsedMs: Date.now() - t0 });
  if (!dlAvailable()) return fail('dl-unavailable', dlError);
  if (!list.length) return fail('dl-bad-spec', 'CQ 批量查询需要至少一条 spec');
  let r = null;
  try {
    r = DL.reasonerFor(ont, config && config.throwInconsistentOntologyException !== undefined ? config : makeConfig(config || {}));
    let isHorn = null;
    try { isHorn = !!(r.getDLOntology() || {}).isHorn; } catch (_) { /* 取不到则放行，靠 query 抛错兜底 */ }
    if (isHorn === false) return { ...fail('dl-non-horn', '本体非 Horn，合取查询不可用（一致性/分类仍可用）'), isHorn: false };
    const results = list.map((spec) => {
      const s0 = Date.now();
      if (!spec || !Array.isArray(spec.where) || !spec.where.length) {
        return { ok: false, reason: 'dl-bad-spec', error: 'CQ 需要非空 where 原子列表', answers: [], columns: [], elapsedMs: Date.now() - s0 };
      }
      try {
        const select = Array.isArray(spec.select) ? spec.select : [];
        const rows = r.query({ select, where: cqWhereToIri(spec.where) });
        const answers = (Array.isArray(rows) ? rows : []).map((row) => (Array.isArray(row) ? row : [row]).map(normTerm));
        return { ok: true, answers, columns: select.slice(), elapsedMs: Date.now() - s0 };
      } catch (err) {
        return { ok: false, reason: classifyError(err), error: String((err && err.message) || err), answers: [], columns: [], elapsedMs: Date.now() - s0 };
      }
    });
    return { ok: true, isHorn, results, elapsedMs: Date.now() - t0 };
  } catch (err) {
    return fail(classifyError(err), String((err && err.message) || err));
  } finally {
    if (r) { try { r.dispose(); } catch (_) { /* 忽略 */ } }
  }
}

/**
 * 蕴含探针（UI 交互式，不落库）。
 * @param {object} ont
 * @param {object} axSpec  中立公理形态：
 *   {kind:'subclassOf', sub:key, super:key}
 *   {kind:'classAssertion', class:key, individual:id}
 *   {kind:'objectPropertyAssertion', property:key, subject:id, object:id}
 *   {kind:'sameIndividual'|'differentIndividuals', individuals:[id…]}
 * @returns {{ok:boolean, entailed:boolean|null, explain:string, reason?:string, error?:string, elapsedMs:number}}
 */
function entail(ont, axSpec, config) {
  const t0 = Date.now();
  const fail = (reason, error) => ({ ok: false, entailed: null, explain: '', reason, error: error || '', elapsedMs: Date.now() - t0 });
  if (!dlAvailable()) return fail('dl-unavailable', dlError);
  if (!axSpec || !axSpec.kind) return fail('dl-bad-spec', '缺少公理形态 kind');
  let ax = null, desc = '';
  switch (axSpec.kind) {
    case 'subclassOf':
      if (!axSpec.sub || !axSpec.super) return fail('dl-bad-spec', 'subclassOf 需要 sub/super');
      ax = E.subclassOf(C_(axSpec.sub), C_(axSpec.super));
      desc = `${axSpec.sub} ⊑ ${axSpec.super}`;
      break;
    case 'classAssertion':
      if (!axSpec.class || !axSpec.individual) return fail('dl-bad-spec', 'classAssertion 需要 class/individual');
      ax = E.classAssertion(C_(axSpec.class), I_(axSpec.individual));
      desc = `${axSpec.class}(${axSpec.individual})`;
      break;
    case 'objectPropertyAssertion':
      if (!axSpec.property || !axSpec.subject || !axSpec.object) return fail('dl-bad-spec', 'objectPropertyAssertion 需要 property/subject/object');
      ax = E.objectPropertyAssertion(P_(axSpec.property), I_(axSpec.subject), I_(axSpec.object));
      desc = `${axSpec.property}(${axSpec.subject}, ${axSpec.object})`;
      break;
    case 'sameIndividual':
    case 'differentIndividuals': {
      const inds = (Array.isArray(axSpec.individuals) ? axSpec.individuals : []).filter(Boolean);
      if (inds.length < 2) return fail('dl-bad-spec', '需要至少 2 个个体');
      ax = axSpec.kind === 'sameIndividual' ? E.sameIndividual(inds.map(I_)) : E.differentIndividuals(inds.map(I_));
      desc = `${axSpec.kind}[${inds.join(', ')}]`;
      break;
    }
    default:
      return fail('dl-bad-spec', `不支持的公理形态：${axSpec.kind}`);
  }
  let r = null;
  try {
    r = DL.reasonerFor(ont, config && config.throwInconsistentOntologyException !== undefined ? config : makeConfig(config || {}));
    const entailed = !!r.isEntailed(ax);
    // 简明解释：子类蕴含给出直接父类；类断言给出个体类型
    let explain = '';
    try {
      if (axSpec.kind === 'subclassOf') {
        const supers = pickKeys(r.getSuperClasses(C_(axSpec.sub), true), bridge.PREFIX_TYPE, typeKeyOf);
        explain = entailed
          ? `「${axSpec.sub}」的直接超类包含「${axSpec.super}」（${supers.join('、') || '—'}）`
          : `「${axSpec.sub}」的直接超类为：${supers.join('、') || '（无）'}，不含「${axSpec.super}」`;
      } else if (axSpec.kind === 'classAssertion') {
        const ts = pickKeys(r.getTypes(I_(axSpec.individual)), bridge.PREFIX_TYPE, typeKeyOf);
        explain = entailed
          ? `个体「${axSpec.individual}」的推理类型包含「${axSpec.class}」（全部：${ts.join('、') || '—'}）`
          : `个体「${axSpec.individual}」的推理类型为：${ts.join('、') || '（无）'}，不含「${axSpec.class}」`;
      } else {
        explain = entailed ? `公理「${desc}」被本体蕴含` : `公理「${desc}」不被本体蕴含`;
      }
    } catch (_) { explain = entailed ? `公理「${desc}」被本体蕴含` : `公理「${desc}」不被本体蕴含`; }
    return { ok: true, entailed, explain, elapsedMs: Date.now() - t0 };
  } catch (err) {
    return fail(classifyError(err), String((err && err.message) || err));
  } finally {
    if (r) { try { r.dispose(); } catch (_) { /* 忽略 */ } }
  }
}

module.exports = {
  // 可用性
  dlAvailable,
  dlError: dlError_,
  dlAvailableFor,
  propertyHierarchyRegular,
  // 合成与门控
  buildDLOntology,
  gateScale,
  hasTransitiveFuel,
  DL_LIMITS,
  makeConfig,
  // 推理驱动
  reasonTBox,
  reasonABox,
  answerCQ,
  answerCQs,
  entail,
  // 工具（测试与 graph.js 编排复用）
  exprFromTree,
  isSynIri,
};
