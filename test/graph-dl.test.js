'use strict';
/**
 * graph-dl.test.js — dl-js-reasoner 融合（设计文档 P1~P5）的专项回归。
 *
 * 分工：
 *   - graph-reason.test.js            → RL 物化 + profile 检测的硬契约（T2 表）
 *   - graph-reason-integration.test.js → 端到端编排 + IPC 通道数（T1 表）
 *   - owl-import.test.js              → protege-js 导入 + 解析器
 *   - 本文件                          → reason/dl.js 全量 API + graph.js 的 DL 编排
 *
 * 覆盖设计文档章节：§3.1（dl.js 模块契约）、§3.2（规模门控）、§3.3（CQ/蕴含探针）、
 *   §4.1（reasonTBox/reasonABox）、§5（profile 检测 DL）、§6.1（图谱面板）、
 *   §6.2（kgAsk CQ 召回）、§7（IPC 三通道）、§9.2（T1/T2 硬契约）、§10（风险 R1/R3/R4/R7/R8/R9）。
 *
 * ⚠️ 测试夹具（.ofn）必须绕开 protege-js FunctionalSyntaxParser 的三个已知限制：
 *   1. 属性链要写 SubObjectPropertyOf(ObjectPropertyChain(:p :p) :q)，
 *      不能写 SubObjectPropertyChainOf(:p :p :q)（解析器不认这个顶层形态）；
 *   2. HasKey 的属性列表必须是扁平变参 HasKey(:A :hasPart)，不能写 HasKey(:A (:hasPart))；
 *   3. 基数限制不是独立公理，必须包在 SubClassOf 里。
 *
 * ⚠️ 性能红线：本文件全程 ≤6 个图谱节点，DL 推理单次 <100ms，整个文件应在数秒内跑完。
 *   设计 §3.2 的规模门控（DL_LIMITS）就是为了保证这一点，本文件也顺带验证门控本身。
 */

const path = require('path');
const { bootEnv, mkCheck, writeFile } = require('./helpers/harness');

const PID = 'owl:dltest';
const nid = (k) => `${PID}:${k}`;
const N = (key, name, type) => ({ id: nid(key), name, type, profile: PID });

/**
 * 完整 DL 测试本体：4 类 / 4 谓词 / 3 个体，覆盖传递、逆属性、属性链、
 * 域/范围、互斥、子类。刻意保持小规模（设计 §3.2 的性能红线）。
 */
const DL_OFN = `Prefix(:=<http://ex.org/dl#>)
Prefix(owl:=<http://www.w3.org/2002/07/owl#>)
Ontology(<http://ex.org/dl>
Declaration(Class(:Device))
Declaration(Class(:Part))
Declaration(Class(:Battery))
Declaration(Class(:Software))
Declaration(ObjectProperty(:part_of))
Declaration(ObjectProperty(:has_part))
Declaration(ObjectProperty(:located_in))
Declaration(ObjectProperty(:runs_on))
Declaration(NamedIndividual(:d1))
Declaration(NamedIndividual(:p1))
Declaration(NamedIndividual(:p2))
SubClassOf(:Battery :Part)
DisjointClasses(:Device :Software)
TransitiveObjectProperty(:part_of)
InverseObjectProperties(:part_of :has_part)
SubObjectPropertyOf(ObjectPropertyChain(:part_of :part_of) :located_in)
ObjectPropertyDomain(:part_of :Part)
ObjectPropertyRange(:part_of :Device)
ClassAssertion(:Device :d1)
ClassAssertion(:Part :p1)
ClassAssertion(:Battery :p2)
ObjectPropertyAssertion(:part_of :p1 :d1)
ObjectPropertyAssertion(:part_of :p2 :p1)
)`;

/** 非 Horn 本体（DisjointUnion 产生析取头）→ 验证 R4 降级。 */
const NON_HORN_OFN = `Prefix(:=<http://ex.org/nh#>)
Prefix(owl:=<http://www.w3.org/2002/07/owl#>)
Ontology(<http://ex.org/nh>
Declaration(Class(:A))
Declaration(Class(:B))
Declaration(Class(:C))
Declaration(NamedIndividual(:i1))
DisjointUnion(:C :A :B)
ClassAssertion(:C :i1)
)`;

/**
 * TBox 含不可满足类 U ≡ Device ⊓ Software（Device ⊥ Software），但**不含任何个体断言**。
 *
 * ⚠️ 关键：importOwl 会丢弃 ABox（ClassAssertion 不进 profile），所以「本体不一致」
 * 只能由 **TBox 不可满足类 + 图谱节点 type 命中该类** 组合产生 —— buildDLOntology
 * 会从 graph.nodes 合成 ClassAssertion(U, x)，此时才真的矛盾。这也是 R7 的真实触发路径。
 */
const UNSAT_OFN = `Prefix(:=<http://ex.org/unsat#>)
Prefix(owl:=<http://www.w3.org/2002/07/owl#>)
Ontology(<http://ex.org/unsat>
Declaration(Class(:Device))
Declaration(Class(:Software))
Declaration(Class(:U))
DisjointClasses(:Device :Software)
EquivalentClasses(:U ObjectIntersectionOf(:Device :Software))
)`;

/** 3 节点小图：d1(Device) ← p1(Part) ← p2(Battery)，两条 part_of 边。 */
function dlGraph3() {
  return {
    nodes: [N('d1', '设备1', 'Device'), N('p1', '部件1', 'Part'), N('p2', '电池2', 'Battery')],
    edges: [
      { from: nid('p1'), to: nid('d1'), rel: 'part_of' },
      { from: nid('p2'), to: nid('p1'), rel: 'part_of' },
    ],
  };
}

(async () => {
  // ⚠️ 不要再调 installElectronShim()：bootEnv 内部已装过一次，重复调用会新建一份
  //    handlers Map，导致后面 registerIpc 注册进新 shim、而 env.el.invoke 查的是旧 shim。
  const env = await bootEnv({ prefix: 'synapse-graph-dl-' });
  const { check, section, summary } = mkCheck('图谱 DL 推理（dl-js-reasoner）');

  const dl = require('../src/main/graph/reason/dl');
  const bridge = require('../src/main/graph/reason/bridge');
  const graph = require('../src/main/graph/graph');
  const E = require('dl-js-reasoner/src/owl/OWLExpressions.js');
  const J = (v) => JSON.stringify(v);
  const cfg = dl.makeConfig({ timeoutMs: 30000 });

  // ==========================================================================
  section('1. dl.js 模块契约（设计 §3.1）');
  // ==========================================================================
  check('dl-js-reasoner 可用（R1 前提）', dl.dlAvailable() === true, `dlError=${dl.dlError()}`);
  check('dlError 为空串', dl.dlError() === '', J(dl.dlError()));
  check('dl.js 导出 16 个成员', J(Object.keys(dl)) === J([
    'dlAvailable', 'dlError', 'dlAvailableFor', 'propertyHierarchyRegular', 'buildDLOntology',
    'gateScale', 'hasTransitiveFuel', 'DL_LIMITS', 'makeConfig', 'reasonTBox', 'reasonABox',
    'answerCQ', 'answerCQs', 'entail', 'exprFromTree', 'isSynIri',
  ]), J(Object.keys(dl)));
  check('E.AxiomType 存在（AT 别名可用）', !!E.AxiomType && E.AxiomType.SUBCLASS_OF === 'SubClassOf');
  // ⚠️ E.AxiomType 只含**公理**类型，不含类表达式类型；类表达式用 .type 字符串字面量。
  check('E.AxiomType 不含类表达式类型（须用字符串字面量）',
    E.AxiomType.OBJECT_UNION_OF === undefined && E.AxiomType.OWL_CLASS === undefined);

  // ==========================================================================
  section('2. exprFromTree：13 种类表达式树 → DL 表达式（设计 §3.1）');
  // ==========================================================================
  const ex = dl.exprFromTree;
  const tOf = (t) => (t && t.type) || null;
  check('字符串简写 → 具名类', tOf(ex('Device')) === 'OWLClass' && ex('Device').iri === bridge.iriType('Device'));
  check('空串 → null', ex('') === null);
  check('{kind:class} → 具名类', tOf(ex({ kind: 'class', key: 'Part' })) === 'OWLClass');
  check('{kind:class} 缺 key → null', ex({ kind: 'class' }) === null);
  check('and(2) → ObjectIntersectionOf', tOf(ex({ kind: 'and', operands: ['A', 'B'] })) === 'ObjectIntersectionOf');
  check('and(2) 有 2 个操作数', ex({ kind: 'and', operands: ['A', 'B'] }).operands.length === 2);
  check('and(1) → 塌缩为单操作数（不造无意义交集）', tOf(ex({ kind: 'and', operands: ['A'] })) === 'OWLClass');
  check('and(0) → null', ex({ kind: 'and', operands: [] }) === null);
  check('or(2) → ObjectUnionOf', tOf(ex({ kind: 'or', operands: ['A', 'B'] })) === 'ObjectUnionOf');
  check('or(1) → 塌缩为单操作数', tOf(ex({ kind: 'or', operands: ['A'] })) === 'OWLClass');
  check('not → ObjectComplementOf', tOf(ex({ kind: 'not', operand: 'A' })) === 'ObjectComplementOf');
  check('not 缺操作数 → null', ex({ kind: 'not' }) === null);
  check('some → ObjectSomeValuesFrom', tOf(ex({ kind: 'some', property: 'part_of', filler: 'Device' })) === 'ObjectSomeValuesFrom');
  check('some 缺 filler → null', ex({ kind: 'some', property: 'part_of' }) === null);
  check('some 缺 property → null', ex({ kind: 'some', filler: 'Device' }) === null);
  check('only → ObjectAllValuesFrom', tOf(ex({ kind: 'only', property: 'part_of', filler: 'Device' })) === 'ObjectAllValuesFrom');
  check('value → ObjectHasValue', tOf(ex({ kind: 'value', property: 'part_of', individual: 'd1' })) === 'ObjectHasValue');
  check('self → ObjectHasSelf', tOf(ex({ kind: 'self', property: 'part_of' })) === 'ObjectHasSelf');
  check('oneOf → ObjectOneOf', tOf(ex({ kind: 'oneOf', individuals: ['d1', 'p1'] })) === 'ObjectOneOf');
  check('oneOf 空列表 → null', ex({ kind: 'oneOf', individuals: [] }) === null);
  check('min → ObjectMinCardinality', tOf(ex({ kind: 'min', n: 2, property: 'part_of' })) === 'ObjectMinCardinality');
  check('min 带 filler 也可', tOf(ex({ kind: 'min', n: 2, property: 'part_of', filler: 'Device' })) === 'ObjectMinCardinality');
  check('max → ObjectMaxCardinality', tOf(ex({ kind: 'max', n: 1, property: 'part_of' })) === 'ObjectMaxCardinality');
  check('exact → ObjectExactCardinality', tOf(ex({ kind: 'exact', n: 1, property: 'part_of' })) === 'ObjectExactCardinality');
  check('基数缺 property → null', ex({ kind: 'min', n: 2 }) === null);
  check('基数 n 非数字 → 归零不抛', tOf(ex({ kind: 'min', n: 'x', property: 'p' })) === 'ObjectMinCardinality');
  check('未知 kind → null', ex({ kind: 'nope' }) === null);
  check('null/undefined → null', ex(null) === null && ex(undefined) === null);
  check('嵌套树可递归转换', tOf(ex({
    kind: 'and', operands: [{ kind: 'some', property: 'part_of', filler: { kind: 'or', operands: ['A', 'B'] } }, 'C'],
  })) === 'ObjectIntersectionOf');

  // ==========================================================================
  section('3. 规模门控 gateScale（设计 §3.2）');
  // ==========================================================================
  check('DL_LIMITS 五字段齐全', J(Object.keys(dl.DL_LIMITS)) === J(['maxClasses', 'aboxBudget', 'transitiveIndividualCap', 'maxDlAxioms', 'maxInferredEdges']));
  check('DL_LIMITS 默认值', J(dl.DL_LIMITS) === J({ maxClasses: 2000, aboxBudget: 20000, transitiveIndividualCap: 80, maxDlAxioms: 600, maxInferredEdges: 5000 }), J(dl.DL_LIMITS));
  const prof4 = { classes: [{ key: 'A' }, { key: 'B' }], predicates: [{ key: 'r' }], axioms: [], dlAxioms: [] };
  const g3 = { nodes: [N('a', 'a', 'A'), N('b', 'b', 'B'), N('c', 'c', 'A')], edges: [] };
  const gate = dl.gateScale(prof4, g3);
  check('gateScale 六字段齐全且顺序固定（§9.2 契约）',
    J(Object.keys(gate)) === J(['classCount', 'individualCount', 'budgetUsed', 'allowTBox', 'allowABox', 'reason']), J(Object.keys(gate)));
  check('gateScale 小图放行', gate.allowTBox === true && gate.allowABox === true && gate.reason === '');
  check('gateScale 预算 = 个体数 × max(1, 类数)', gate.budgetUsed === 3 * 2, J(gate.budgetUsed));
  check('gateScale 忽略 inferred 节点', dl.gateScale(prof4, { nodes: [...g3.nodes, { ...N('z', 'z', 'A'), inferred: true }] }).individualCount === 3);
  check('gateScale 忽略无 id 节点', dl.gateScale(prof4, { nodes: [{ name: 'x' }, null] }).individualCount === 0);
  check('类数超限 → dl-too-large 且 TBox/ABox 全禁', (() => {
    const r = dl.gateScale(prof4, g3, { maxClasses: 1 });
    return r.allowTBox === false && r.allowABox === false && r.reason === 'dl-too-large';
  })());
  check('ABox 预算超限 → dl-abox-budget 但 TBox 仍放行', (() => {
    const r = dl.gateScale(prof4, g3, { aboxBudget: 5 });
    return r.allowTBox === true && r.allowABox === false && r.reason === 'dl-abox-budget';
  })());
  check('传递属性 + 个体数超 cap → dl-abox-budget', (() => {
    const tp = { classes: [{ key: 'A' }], predicates: [{ key: 'r', features: ['transitive'] }], axioms: [], dlAxioms: [] };
    const many = { nodes: Array.from({ length: 5 }, (_, i) => N(`n${i}`, `n${i}`, 'A')), edges: [] };
    const r = dl.gateScale(tp, many, { transitiveIndividualCap: 3 });
    return r.allowTBox === true && r.allowABox === false && r.reason === 'dl-abox-budget';
  })());
  check('传递属性但个体数在 cap 内 → 放行', (() => {
    const tp = { classes: [{ key: 'A' }], predicates: [{ key: 'r', features: ['transitive'] }], axioms: [], dlAxioms: [] };
    return dl.gateScale(tp, g3, { transitiveIndividualCap: 80 }).allowABox === true;
  })());
  check('无传递燃料时超 cap 也放行（不误伤）', dl.gateScale(prof4, { nodes: Array.from({ length: 200 }, (_, i) => N(`n${i}`, `n`, 'A')), edges: [] }, { transitiveIndividualCap: 3 }).allowABox === true);
  check('hasTransitiveFuel: features 含 transitive', dl.hasTransitiveFuel({ predicates: [{ key: 'r', features: ['transitive'] }] }) === true);
  check('hasTransitiveFuel: axioms 含 TransitiveProperty', dl.hasTransitiveFuel({ axioms: [{ type: 'TransitiveProperty' }] }) === true);
  check('hasTransitiveFuel: dlAxioms 含 SubPropertyChainOf', dl.hasTransitiveFuel({ dlAxioms: [{ type: 'SubPropertyChainOf' }] }) === true);
  check('hasTransitiveFuel: 皆无 → false', dl.hasTransitiveFuel({ predicates: [{ key: 'r' }], axioms: [], dlAxioms: [] }) === false);
  check('hasTransitiveFuel: null profile → false', dl.hasTransitiveFuel(null) === false);
  check('gateScale 容忍 null profile/graph', dl.gateScale(null, null).classCount === 0 && dl.gateScale(null, null).allowTBox === true);

  // ==========================================================================
  section('4. makeConfig / propertyHierarchyRegular / isSynIri');
  // ==========================================================================
  const mc = dl.makeConfig({});
  check('makeConfig 默认四字段', J(Object.keys(mc)) === J(['throwInconsistentOntologyException', 'individualTaskTimeout', 'bufferChanges', 'freshEntityPolicy']), J(Object.keys(mc)));
  check('makeConfig 默认不抛不一致异常（R7 前提）', mc.throwInconsistentOntologyException === false);
  check('makeConfig 默认 freshEntityPolicy=ALLOW', mc.freshEntityPolicy === 'ALLOW');
  check('makeConfig 默认不缓冲变更', mc.bufferChanges === true);
  check('makeConfig timeoutMs=0 → -1（不限时）', dl.makeConfig({ timeoutMs: 0 }).individualTaskTimeout === -1);
  check('makeConfig timeoutMs 原样透传（不做下限钳制）', dl.makeConfig({ timeoutMs: 1 }).individualTaskTimeout === 1);
  check('makeConfig timeoutMs=5000 → 5000', dl.makeConfig({ timeoutMs: 5000 }).individualTaskTimeout === 5000);
  check('makeConfig 无参不抛', typeof dl.makeConfig() === 'object');
  // ⚠️ propertyHierarchyRegular 有**两个输入槽，形态不同**（极易搞错）：
  //    第 1 参 model.axioms 只认 bridge/RL 形态 {type:'SubPropertyOf', subject, object}；
  //    第 2 参 dlAxioms   认 DL 形态 {type:'SubObjectPropertyOf', subProperty, superProperty}
  //                       与 {type:'SubPropertyChainOf', propertyChain[], superProperty}。
  //    把 DL 形态塞进 model.axioms 会被静默忽略 → 环检不出来（返回 true）。
  const sub = (a, b) => ({ type: 'SubObjectPropertyOf', subProperty: a, superProperty: b });
  const subBridge = (a, b) => ({ type: 'SubPropertyOf', subject: a, object: b });
  check('propertyHierarchyRegular 无环 → true', dl.propertyHierarchyRegular({ predicates: [{ key: 'a' }, { key: 'b' }], axioms: [] }, [sub('a', 'b')]) === true);
  check('propertyHierarchyRegular 二元环 → false（不规则，DL 拒收）', dl.propertyHierarchyRegular({ predicates: [{ key: 'a' }, { key: 'b' }], axioms: [] }, [sub('a', 'b'), sub('b', 'a')]) === false);
  check('propertyHierarchyRegular 三元环 → false', dl.propertyHierarchyRegular({ predicates: [{ key: 'a' }, { key: 'b' }, { key: 'c' }], axioms: [] }, [sub('a', 'b'), sub('b', 'c'), sub('c', 'a')]) === false);
  // a ⊑ a 是重言式，addEdge 刻意跳过 sub === sup（等价属性对不构成严格边），故不算环。
  check('propertyHierarchyRegular 自环 → true（a⊑a 是重言式，不构成严格边）', dl.propertyHierarchyRegular({ predicates: [{ key: 'a' }], axioms: [] }, [sub('a', 'a')]) === true);
  check('propertyHierarchyRegular 无 axioms → true', dl.propertyHierarchyRegular({ predicates: [{ key: 'a' }], axioms: [] }, []) === true);
  check('propertyHierarchyRegular null model → true', dl.propertyHierarchyRegular(null, []) === true);
  check('propertyHierarchyRegular 也认 bridge 形态 SubPropertyOf（第 1 参槽）', dl.propertyHierarchyRegular({ predicates: [{ key: 'a' }, { key: 'b' }], axioms: [subBridge('a', 'b'), subBridge('b', 'a')] }, []) === false);
  check('propertyHierarchyRegular 属性链展开：a∘a ⊑ b 且 b ⊑ a → 环', dl.propertyHierarchyRegular({ predicates: [], axioms: [] }, [
    { type: 'SubPropertyChainOf', propertyChain: ['a', 'a'], superProperty: 'b' }, sub('b', 'a'),
  ]) === false);
  check('isSynIri: id 前缀', dl.isSynIri(bridge.iriId('x')) === true);
  check('isSynIri: type 前缀', dl.isSynIri(bridge.iriType('X')) === true);
  check('isSynIri: rel 前缀', dl.isSynIri(bridge.iriRel('r')) === true);
  check('isSynIri: 外部 IRI → false', dl.isSynIri('http://ex.org/dl#Device') === false);
  check('isSynIri: 空/非串 → false', dl.isSynIri('') === false && dl.isSynIri(null) === false);

  // ==========================================================================
  section('5. 导入 DL 本体 + buildDLOntology（设计 §3.1 / §5）');
  // ==========================================================================
  const ofnPath = writeFile(path.join(env.dir, 'dl.ofn'), DL_OFN);
  const imp = await graph.importOwl(ofnPath, { id: PID, displayName: 'DL 测试本体' });
  check('importOwl 五字段齐全（T1 契约不变）', J(Object.keys(imp).sort()) === J(['preview', 'profile', 'profileCheck', 'report', 'via'].sort()), J(Object.keys(imp)));
  check('via = protege-js', imp.via === 'protege-js', J(imp.via));
  check('profile.dlCapable = true', imp.profile.dlCapable === true);
  check('profile 16 字段（含 dlAxioms/dlCapable）', imp.profile.dlAxioms !== undefined && imp.profile.dlCapable !== undefined);
  check('4 个类被导入', imp.profile.classes.length === 4, J(imp.profile.classes.map((c) => c.key)));
  check('4 个谓词被导入', imp.profile.predicates.length === 4, J(imp.profile.predicates.map((p) => p.key)));
  check('part_of 带 transitive 特征', (imp.profile.predicates.find((p) => p.key === 'part_of') || {}).features.includes('transitive'));
  check('属性链进 dlAxioms（SubPropertyChainOf）', J(imp.profile.dlAxioms.filter((a) => a.type === 'SubPropertyChainOf')) === J([{ type: 'SubPropertyChainOf', propertyChain: ['part_of', 'part_of'], superProperty: 'located_in' }]), J(imp.profile.dlAxioms));
  // ⚠️ T1-a：dl 判定挂在 preview.profileCheck 上；顶层 profileCheck 保持 8 键不变。
  check('顶层 profileCheck 8 键（T1 契约不变，无 dl）', J(Object.keys(imp.profileCheck).sort()) === J(['available', 'el', 'meta', 'profiles', 'ql', 'reasonerAvailable', 'recommend', 'rl'].sort()), J(Object.keys(imp.profileCheck)));
  check('preview.profileCheck.dl 存在（T1-a 有意扩展）', !!imp.preview.profileCheck.dl, J(Object.keys(imp.preview.profileCheck)));
  check('preview.profileCheck.dl.available = true', imp.preview.profileCheck.dl.available === true, J(imp.preview.profileCheck.dl));
  check('dlAvailableFor(profile) = true', dl.dlAvailableFor(imp.profile) === true);
  check('dlAvailableFor 受 limits 门控', dl.dlAvailableFor(imp.profile, { limits: { maxClasses: 1 } }) === false);
  check('dlAvailableFor(null) = false（无本体可判 → 不可用，不是「0 类所以可用」）', dl.dlAvailableFor(null) === false && dl.dlAvailableFor(undefined) === false && dl.dlAvailableFor({}) === false);
  check('dlAvailableFor 显式 classCount 可绕过本体推断', dl.dlAvailableFor(null, { classCount: 3 }) === true && dl.dlAvailableFor(null, { classCount: 99999 }) === false);

  const ont = dl.buildDLOntology(imp.profile, dlGraph3(), { abox: true });
  check('合成本体 13 字段齐全', J(Object.keys(ont)) === J([
    'getAxioms', 'axioms', 'model', 'classKeys', 'propertyKeys', 'individualKeys',
    'originals', 'adjByRel', 'transitive', 'symmetric', 'inverseOf', 'abox', 'stats',
  ]), J(Object.keys(ont)));
  check('getAxioms 是函数（reasonerFor 唯一要求）', typeof ont.getAxioms === 'function');
  check('getAxioms() 与 axioms 同一份', ont.getAxioms() === ont.axioms || ont.getAxioms().length === ont.axioms.length);
  check('stats 六字段齐全', J(Object.keys(ont.stats)) === J(['axioms', 'classes', 'properties', 'individuals', 'dlAxiomsConverted', 'dlAxiomsSkipped']), J(Object.keys(ont.stats)));
  check('stats: 4 类 / 4 谓词 / 3 个体', ont.stats.classes === 4 && ont.stats.properties === 4 && ont.stats.individuals === 3, J(ont.stats));
  check('stats: DL 公理全部转换成功、0 跳过', ont.stats.dlAxiomsSkipped === 0 && ont.stats.dlAxiomsConverted >= 1, J(ont.stats));
  check('classKeys 含 4 个类', J([...ont.classKeys].sort()) === J(['Battery', 'Device', 'Part', 'Software']), J([...ont.classKeys]));
  check('propertyKeys 含 4 个谓词', J([...ont.propertyKeys].sort()) === J(['has_part', 'located_in', 'part_of', 'runs_on']), J([...ont.propertyKeys]));
  check('individualKeys 含 3 个个体', ont.individualKeys.length === 3, J([...ont.individualKeys]));
  // ⚠️ E.* 公理工厂不设 .type，判别字段是 .axiomType（实测确认）。
  check('公理对象用 .axiomType 判别（.type 恒为 undefined）',
    ont.axioms.every((a) => a.type === undefined && typeof a.axiomType === 'string'), J(ont.axioms[0] && Object.keys(ont.axioms[0])));
  const atypes = new Set(ont.axioms.map((a) => a.axiomType));
  check('含 Declaration 公理（实体声明）', atypes.has('Declaration'), J([...atypes]));
  check('含 SubClassOf（Battery ⊑ Part）', atypes.has(E.AxiomType.SUBCLASS_OF), J([...atypes]));
  check('含 DisjointClasses（Device ⊥ Software）', atypes.has(E.AxiomType.DISJOINT_CLASSES), J([...atypes]));
  check('含 TransitiveObjectProperty', atypes.has(E.AxiomType.TRANSITIVE_OBJECT_PROPERTY), J([...atypes]));
  check('含 InverseObjectProperties', atypes.has(E.AxiomType.INVERSE_OBJECT_PROPERTIES), J([...atypes]));
  check('含属性链公理（值 = SubObjectPropertyChainOf）', atypes.has(E.AxiomType.SUB_PROPERTY_CHAIN_OF), J([...atypes]));
  check('含 ObjectPropertyDomain', atypes.has(E.AxiomType.OBJECT_PROPERTY_DOMAIN), J([...atypes]));
  check('含 ObjectPropertyRange', atypes.has(E.AxiomType.OBJECT_PROPERTY_RANGE), J([...atypes]));
  check('含 ClassAssertion（ABox 合成）', atypes.has(E.AxiomType.CLASS_ASSERTION), J([...atypes]));
  check('含 ObjectPropertyAssertion（ABox 合成）', atypes.has(E.AxiomType.OBJECT_PROPERTY_ASSERTION), J([...atypes]));
  check('transitive 集合含 part_of', ont.transitive.has('part_of'));
  check('inverseOf 是 Map<string, Set>（part_of ↔ has_part）', J([...ont.inverseOf.get('part_of')]) === J(['has_part']) && J([...ont.inverseOf.get('has_part')]) === J(['part_of']), J([...ont.inverseOf.entries()].map(([k, v]) => [k, [...v]])));
  check('symmetric 集合为空（本体无对称属性）', ont.symmetric.size === 0);
  check('originals 记录 2 条原始边 key', ont.originals.size === 2 && ont.originals.has(bridge.edgeKey(nid('p1'), nid('d1'), 'part_of')), J([...ont.originals]));
  check('adjByRel 为 part_of 建了 2 条邻接', ont.adjByRel.get('part_of').size === 2, J(ont.adjByRel.get('part_of') && [...ont.adjByRel.get('part_of')]));
  check('abox 标记为 true', ont.abox === true);

  const ontNoAbox = dl.buildDLOntology(imp.profile, dlGraph3(), { abox: false });
  check('abox:false 时不合成个体断言', ontNoAbox.abox === false && ontNoAbox.individualKeys.length === 0 && ontNoAbox.originals.size === 0);
  check('abox:false 时公理数更少（纯 TBox）', ontNoAbox.stats.axioms < ont.stats.axioms, `${ontNoAbox.stats.axioms} vs ${ont.stats.axioms}`);
  check('abox:false 时公理数 = 23 - 8（3 Declaration + 3 ClassAssertion + 2 ObjectPropertyAssertion）', ont.stats.axioms - ontNoAbox.stats.axioms === 8, `${ont.stats.axioms}-${ontNoAbox.stats.axioms}`);
  check('inferred 边不进 ABox（避免把推理结果当前提）', (() => {
    const g = dlGraph3();
    g.edges.push({ from: nid('p2'), to: nid('d1'), rel: 'part_of', inferred: true });
    return dl.buildDLOntology(imp.profile, g, { abox: true }).originals.size === 2;
  })());
  check('未知 type 的节点回落到 fallbackType', (() => {
    const o = dl.buildDLOntology({ ...imp.profile, fallbackType: 'Device' }, { nodes: [{ id: nid('q'), name: 'q', type: '不存在', profile: PID }], edges: [] }, { abox: true });
    return o.individualKeys.length === 1;
  })());
  check('profile 为 null 时不抛', (() => { const o = dl.buildDLOntology(null, null, {}); return o.stats.classes === 0 && o.axioms.length === 0; })());

  // ==========================================================================
  section('6. reasonTBox：一致性 / 不可满足类 / 类层次（设计 §4.1、R7、R8）');
  // ==========================================================================
  const tbox = dl.reasonTBox(ont, cfg);
  check('reasonTBox 七字段齐全（§9.2 契约）', J(Object.keys(tbox)) === J(['skipped', 'consistent', 'unsatClasses', 'hierarchy', 'topClasses', 'elapsedMs', 'stats']), J(Object.keys(tbox)));
  check('reasonTBox 未跳过', tbox.skipped === false);
  check('DL 测试本体一致', tbox.consistent === true);
  check('无不可满足类', Array.isArray(tbox.unsatClasses) && tbox.unsatClasses.length === 0, J(tbox.unsatClasses));
  check('hierarchy: Battery 的直接超类是 Part', J((tbox.hierarchy.Battery || {}).supers) === J(['Part']), J(tbox.hierarchy));
  check('hierarchy: Part 的直接子类是 Battery', J((tbox.hierarchy.Part || {}).subs) === J(['Battery']), J(tbox.hierarchy));
  check('hierarchy 只存有内容的条目', !tbox.hierarchy.Device || ((tbox.hierarchy.Device.supers || []).length + (tbox.hierarchy.Device.subs || []).length > 0), J(Object.keys(tbox.hierarchy)));
  check('topClasses 含 Device/Part/Software', tbox.topClasses.includes('Device') && tbox.topClasses.includes('Software'), J(tbox.topClasses));
  check('R8：topClasses 不含 owl:Thing / owl:Nothing', !tbox.topClasses.some((c) => /Thing|Nothing/i.test(c)), J(tbox.topClasses));
  check('R8：hierarchy 键不含内置类', !Object.keys(tbox.hierarchy).some((c) => /Thing|Nothing/i.test(c)), J(Object.keys(tbox.hierarchy)));
  check('R8：unsatClasses 不含内置类', !tbox.unsatClasses.some((c) => /Thing|Nothing/i.test(c)), J(tbox.unsatClasses));
  check('stats 有迭代次数（tableau 真的跑了）', tbox.stats && tbox.stats.iterations > 0, J(tbox.stats));
  check('elapsedMs 是非负数', typeof tbox.elapsedMs === 'number' && tbox.elapsedMs >= 0);
  check('DL 推理性能红线：TBox < 2s', tbox.elapsedMs < 2000, `${tbox.elapsedMs}ms`);

  // 不可满足类：U ≡ Device ⊓ Software，而 Device ⊥ Software
  const impU = await graph.importOwl(writeFile(path.join(env.dir, 'unsat.ofn'), UNSAT_OFN), { id: 'owl:dlunsat', displayName: '不可满足' });
  check('不可满足本体导入成功且 dlCapable', impU.profile.dlCapable === true);
  const ontU = dl.buildDLOntology(impU.profile, { nodes: [], edges: [] }, { abox: false });
  const tboxU = dl.reasonTBox(ontU, cfg);
  check('纯 TBox 下本体仍一致（不可满足 ≠ 不一致）', tboxU.consistent === true);
  check('unsatClasses 检出 U', J(tboxU.unsatClasses) === J(['U']), J(tboxU.unsatClasses));
  check('unsat 类的层次仍给出（U ⊑ Device, Software）', J((tboxU.hierarchy.U || {}).supers) === J(['Device', 'Software']), J(tboxU.hierarchy));

  // R7：不一致本体 → 其余查询全部短路
  const ontBad = dl.buildDLOntology(impU.profile, { nodes: [{ id: 'owl:dlunsat:x1', name: 'x1', type: 'U', profile: 'owl:dlunsat' }], edges: [] }, { abox: true });
  const tboxBad = dl.reasonTBox(ontBad, cfg);
  check('R7：节点 type 命中不可满足类 → 本体不一致', tboxBad.consistent === false, J(tboxBad));
  // ⚠️ 断言里要比的是**值**不是字符串：J([]) 才是 '[]'，J('[]') 是 '"[]"'（多一层引号）。
  check('R7：不一致时 unsatClasses 清空（此时返回全部类，无意义）', J(tboxBad.unsatClasses) === J([]), J(tboxBad.unsatClasses));
  check('R7：不一致时 hierarchy 清空', J(tboxBad.hierarchy) === J({}), J(tboxBad.hierarchy));
  check('R7：不一致时 topClasses 清空', J(tboxBad.topClasses) === J([]), J(tboxBad.topClasses));
  const aboxBad = dl.reasonABox(ontBad, cfg, {});
  check('R7：reasonABox 也检出不一致', aboxBad.consistent === false);
  check('R7：不一致时产出 1 条 dl-inconsistent 冲突', aboxBad.inconsistencies.length === 1 && aboxBad.inconsistencies[0].rule === 'dl-inconsistent', J(aboxBad.inconsistencies));
  check('R7：冲突条目五字段（rule/message/messageZh/reasonZh/raw）', J(Object.keys(aboxBad.inconsistencies[0])) === J(['rule', 'message', 'messageZh', 'reasonZh', 'raw']), J(Object.keys(aboxBad.inconsistencies[0])));
  check('R7：不一致时不产出推理边', aboxBad.inferredEdges.length === 0);
  check('R7：不一致时不产出类型', J(aboxBad.types) === J({}), J(aboxBad.types));
  check('R7：不一致时 CQ 明确失败而非静默空答', (() => {
    const r = dl.answerCQ(ontBad, { select: ['?x'], where: [{ class: 'U', arg: '?x' }] }, cfg);
    return r.ok === false && r.reason === 'dl-error' && /unsatisfiable/i.test(r.error);
  })());

  // ==========================================================================
  section('7. reasonABox：推理边 / realisation / sameAs（设计 §4.1、Q-DL-5）');
  // ==========================================================================
  const abox = dl.reasonABox(ont, cfg, {});
  check('reasonABox 八字段齐全（§9.2 契约）', J(Object.keys(abox)) === J(['skipped', 'consistent', 'inferredEdges', 'inconsistencies', 'types', 'sameAs', 'elapsedMs', 'stats']), J(Object.keys(abox)));
  check('ABox 一致', abox.consistent === true);
  check('无冲突', abox.inconsistencies.length === 0);
  const ek = (e) => bridge.edgeKey(e.from, e.to, e.rel);
  const ekeys = abox.inferredEdges.map(ek);
  check('传递性：p2 →part_of→ d1 被推出', ekeys.includes(bridge.edgeKey(nid('p2'), nid('d1'), 'part_of')), J(ekeys));
  check('逆属性：d1 →has_part→ p1 被推出', ekeys.includes(bridge.edgeKey(nid('d1'), nid('p1'), 'has_part')), J(ekeys));
  check('属性链：p2 →located_in→ d1 被推出', ekeys.includes(bridge.edgeKey(nid('p2'), nid('d1'), 'located_in')), J(ekeys));
  check('不把原始边当推理边（originals 去重）', !ekeys.includes(bridge.edgeKey(nid('p1'), nid('d1'), 'part_of')) && !ekeys.includes(bridge.edgeKey(nid('p2'), nid('p1'), 'part_of')), J(ekeys));
  check('推理边八字段齐全', abox.inferredEdges.every((e) => J(Object.keys(e)) === J(['from', 'to', 'rel', 'inferred', 'inferredFromKeys', 'inferredVia', 'inferredAt', 'inferredBy'])), J(abox.inferredEdges[0] && Object.keys(abox.inferredEdges[0])));
  check('inferredVia = dl-tableau', abox.inferredEdges.every((e) => e.inferredVia === 'dl-tableau'));
  check('inferredBy = dl-js-reasoner（R9 归属标注）', abox.inferredEdges.every((e) => e.inferredBy === 'dl-js-reasoner'));
  check('inferred = true', abox.inferredEdges.every((e) => e.inferred === true));
  check('inferredAt 是时间戳', abox.inferredEdges.every((e) => typeof e.inferredAt === 'number' && e.inferredAt > 0));
  const transEdge = abox.inferredEdges.find((e) => ek(e) === bridge.edgeKey(nid('p2'), nid('d1'), 'part_of'));
  check('传递边的 inferredFromKeys 给出 2 段路径（可解释性）', transEdge && transEdge.inferredFromKeys.length === 2, J(transEdge && transEdge.inferredFromKeys));
  check('Q-DL-5：types 是全集（Battery 个体也知道自己 ⊑ Part）', J((abox.types[nid('p2')] || []).slice().sort()) === J(['Battery', 'Part']), J(abox.types));
  check('Q-DL-5：types 不含 owl:Thing（pickKeys 只收 synapse.local/type/）', Object.values(abox.types).every((arr) => !arr.some((t) => /Thing|Nothing/i.test(t))), J(abox.types));
  check('域公理生效：p1 作为 part_of 的宾语被推为 Device', (abox.types[nid('p1')] || []).includes('Device'), J(abox.types[nid('p1')]));
  check('sameAs 是数组（本例无 sameAs 公理）', Array.isArray(abox.sameAs) && abox.sameAs.length === 0, J(abox.sameAs));
  check('推理边无自环', abox.inferredEdges.every((e) => e.from !== e.to));
  check('推理边无重复 key', new Set(ekeys).size === ekeys.length, J(ekeys));
  check('ABox 推理性能红线：< 3s', abox.elapsedMs < 3000, `${abox.elapsedMs}ms`);

  const capped = dl.reasonABox(ont, cfg, { maxInferredEdges: 1 });
  check('maxInferredEdges=1 时严格只出 1 条边（上限检查在最内层）', capped.inferredEdges.length === 1, J(capped.inferredEdges.map(ek)));
  // ★回归：旧写法 `Number(x) > 0 ? x : 默认` 把 0 当 falsy 吞掉 → 请求 0 条却拿到 5000 条。
  //   这个上限是保护 kv 存储的硬约束，必须能被调用方真正压到 0。
  check('maxInferredEdges=0 时不出边（0 是合法上限，不是 falsy 回落）', dl.reasonABox(ont, cfg, { maxInferredEdges: 0 }).inferredEdges.length === 0);
  check('maxInferredEdges=2 时不超过 2 条', dl.reasonABox(ont, cfg, { maxInferredEdges: 2 }).inferredEdges.length <= 2);
  check('maxInferredEdges 负数/NaN → 回落默认值（仍能出边）', dl.reasonABox(ont, cfg, { maxInferredEdges: -5 }).inferredEdges.length > 0
    && dl.reasonABox(ont, cfg, { maxInferredEdges: NaN }).inferredEdges.length > 0);

  const noAbox = dl.reasonABox(ontNoAbox, cfg, {});
  check('无 ABox 时 reasonABox 走 skipped 分支（十字段）', noAbox.skipped === true && J(Object.keys(noAbox).sort()) === J(['consistent', 'elapsedMs', 'error', 'inconsistencies', 'inferredEdges', 'sameAs', 'skipReason', 'skipped', 'stats', 'types'].sort()), J(Object.keys(noAbox)));
  check('skipped 时 skipReason = dl-no-abox', noAbox.skipReason === 'dl-no-abox', J(noAbox.skipReason));
  check('skipped 时 consistent 为 null（不是 false，避免误报冲突）', noAbox.consistent === null, J(noAbox.consistent));
  check('skipped 时各集合为空', noAbox.inferredEdges.length === 0 && J(noAbox.types) === J({}) && noAbox.sameAs.length === 0);

  // ==========================================================================
  section('8. answerCQ / answerCQs：合取查询（设计 §3.3、R4）');
  // ==========================================================================
  const cq1 = dl.answerCQ(ont, { select: ['?o'], where: [{ objectProperty: 'part_of', subject: nid('p1'), object: '?o' }] }, cfg);
  check('answerCQ 五字段齐全（成功路径）', J(Object.keys(cq1)) === J(['ok', 'answers', 'columns', 'isHorn', 'elapsedMs']), J(Object.keys(cq1)));
  check('CQ ok=true', cq1.ok === true, J(cq1));
  check('CQ isHorn=true（本体是 Horn 的）', cq1.isHorn === true);
  check('CQ columns 回显 select', J(cq1.columns) === J(['?o']), J(cq1.columns));
  check('CQ: part_of(p1, ?o) → d1', J(cq1.answers.map((r) => r.map((c) => c.value))) === J([[nid('d1')]]), J(cq1.answers));
  check('CQ 答案项是 {kind,value} 形态', cq1.answers[0][0].kind === 'individual', J(cq1.answers[0][0]));
  const cqCls = dl.answerCQ(ont, { select: ['?x'], where: [{ class: 'Part', arg: '?x' }] }, cfg);
  check('CQ: 类成员查询（Part 的实例含 p1、p2 —— Battery ⊑ Part）',
    J(cqCls.answers.map((r) => r[0].value).sort()) === J([nid('p1'), nid('p2')].sort()), J(cqCls.answers));
  const cqInv = dl.answerCQ(ont, { select: ['?s'], where: [{ inverseObjectProperty: 'part_of', subject: nid('d1'), object: '?s' }] }, cfg);
  check('CQ: 逆属性原子可用', cqInv.ok === true && cqInv.answers.length === 2, J(cqInv.answers));
  const cqChain = dl.answerCQ(ont, { select: ['?o'], where: [{ objectProperty: 'located_in', subject: nid('p2'), object: '?o' }] }, cfg);
  check('CQ: 属性链推出的 located_in 可查（物化在 tableau 里）', J(cqChain.answers.map((r) => r[0].value)) === J([nid('d1')]), J(cqChain.answers));
  const cqNoSel = dl.answerCQ(ont, { where: [{ objectProperty: 'part_of', subject: nid('p1'), object: '?o' }] }, cfg);
  // ⚠️ answerCQ 显式传 select:[]，覆盖了 QuerySpec 的 SELECT-* 默认 → 退化为存在性判定。
  check('省略 select → 存在性判定（1 行 0 列，不是 SELECT *）', cqNoSel.ok === true && J(cqNoSel.columns) === J([]) && cqNoSel.answers.length === 1 && cqNoSel.answers[0].length === 0, J(cqNoSel));
  const cqEmpty = dl.answerCQ(ont, { select: ['?x'], where: [] }, cfg);
  check('空 where → ok=false + dl-bad-spec（七字段）', cqEmpty.ok === false && cqEmpty.reason === 'dl-bad-spec' && J(Object.keys(cqEmpty)) === J(['ok', 'reason', 'error', 'answers', 'columns', 'isHorn', 'elapsedMs']), J(cqEmpty));
  check('dl-bad-spec 时 answers/columns 为空数组（不返回 undefined）', Array.isArray(cqEmpty.answers) && cqEmpty.answers.length === 0 && Array.isArray(cqEmpty.columns));
  const cqNull = dl.answerCQ(ont, { select: ['?x'], where: [{ objectProperty: 'part_of', subject: null, object: '?x' }] }, cfg);
  check('null 项 → 明确报错而非静默 0 行（cqWhereToIri 的 null 透传）', cqNull.ok === false && cqNull.reason === 'dl-bad-spec', J(cqNull));
  check('answerCQ(null spec) 不抛', dl.answerCQ(ont, null, cfg).ok === false);

  // ★cqWhereToIri 的核心 bug 回归：裸 Synapse id 必须被编码成 synapse.local IRI。
  // 修复前 QuerySpec.toTerm 把 'owl:dltest:p1' 当字面 IRI → 静默返回 0 行（不报错）。
  check('★回归：裸 Synapse 节点 id 作 subject 能查到（IRI 编码生效）', cq1.answers.length === 1, J(cq1.answers));
  // ⚠️ 个体 IRI 是 iriId(**节点 id**)，而节点 id 带体系前缀（`owl:dltest:p1`）——
  //    写成 iriId('p1') 会查一个图里不存在的个体，静默 0 行。
  const cqPreEnc = dl.answerCQ(ont, { select: ['?o'], where: [{ objectProperty: bridge.iriRel('part_of'), subject: bridge.iriId(nid('p1')), object: '?o' }] }, cfg);
  check('已编码 IRI 原样透传，结果一致', cqPreEnc.ok === true && J(cqPreEnc.answers.map((r) => r[0].value)) === J(cq1.answers.map((r) => r[0].value)), J(cqPreEnc.answers));
  const cqLit = dl.answerCQ(ont, { select: ['?o'], where: [{ objectProperty: 'part_of', subject: { individual: bridge.iriId(nid('p1')) }, object: '?o' }] }, cfg);
  // ⚠️ 答案项是 {kind,value} 形态（normTerm 的产物），不是裸字符串 —— 比较时先取 .value。
  check('{individual:...} 包装透传，结果一致', cqLit.ok === true && J(cqLit.answers.map((r) => r[0].value)) === J([nid('d1')]), J(cqLit.answers));

  const batch = dl.answerCQs(ont, [
    { select: ['?o'], where: [{ objectProperty: 'part_of', subject: nid('p1'), object: '?o' }] },
    { select: ['?s'], where: [{ objectProperty: 'part_of', subject: '?s', object: nid('d1') }] },
    { select: ['?x'], where: [{ class: 'Battery', arg: '?x' }] },
    { select: ['?x'], where: [] },
  ], cfg);
  check('answerCQs 四字段齐全（成功路径）', J(Object.keys(batch)) === J(['ok', 'isHorn', 'results', 'elapsedMs']), J(Object.keys(batch)));
  check('answerCQs ok=true（个别 spec 失败不影响整体）', batch.ok === true);
  check('answerCQs results 数量与 specs 一致', batch.results.length === 4);
  check('answerCQs 前 3 条成功', batch.results.slice(0, 3).every((r) => r.ok === true), J(batch.results.map((r) => r.ok)));
  check('answerCQs 第 4 条（空 where）单独失败并带 reason', batch.results[3].ok === false && batch.results[3].reason === 'dl-bad-spec', J(batch.results[3]));
  check('answerCQs 单条结果四字段', J(Object.keys(batch.results[0])) === J(['ok', 'answers', 'columns', 'elapsedMs']), J(Object.keys(batch.results[0])));
  check('answerCQs 与逐条 answerCQ 结果一致', J(batch.results[0].answers) === J(cq1.answers), J(batch.results[0].answers));
  // 空 specs 与 null specs 同口径：都是「没给查询」，属调用方错误 → dl-bad-spec。
  // （dlRecallFacts 自己有 `if (!specs.length) continue` 守卫，不会走到这里。）
  check('answerCQs 空数组 → ok=false + dl-bad-spec（六字段失败形态）', (() => {
    const r = dl.answerCQs(ont, [], cfg);
    return r.ok === false && r.reason === 'dl-bad-spec' && J(r.results) === J([])
      && J(Object.keys(r)) === J(['ok', 'reason', 'error', 'isHorn', 'results', 'elapsedMs']);
  })(), J(dl.answerCQs(ont, [], cfg)));
  check('answerCQs 非数组 → ok=false + dl-bad-spec（六字段）', (() => {
    const r = dl.answerCQs(ont, null, cfg);
    return r.ok === false && r.reason === 'dl-bad-spec' && J(Object.keys(r)) === J(['ok', 'reason', 'error', 'isHorn', 'results', 'elapsedMs']);
  })());

  // R4：非 Horn 本体 → CQ 明确降级，但一致性/分类仍可用
  const impNH = await graph.importOwl(writeFile(path.join(env.dir, 'nonhorn.ofn'), NON_HORN_OFN), { id: 'owl:dlnh', displayName: '非 Horn' });
  check('非 Horn 本体导入成功', impNH.profile.dlCapable === true);
  check('非 Horn 本体含 DisjointUnion', impNH.profile.dlAxioms.some((a) => a.type === 'DisjointUnion'), J(impNH.profile.dlAxioms.map((a) => a.type)));
  const ontNH = dl.buildDLOntology(impNH.profile, { nodes: [{ id: 'owl:dlnh:i1', name: 'i1', type: 'C', profile: 'owl:dlnh' }], edges: [] }, { abox: true });
  const cqNH = dl.answerCQ(ontNH, { select: ['?x'], where: [{ class: 'C', arg: '?x' }] }, cfg);
  check('R4：非 Horn → CQ 返回 dl-non-horn（七字段失败形态）', cqNH.ok === false && cqNH.reason === 'dl-non-horn' && J(Object.keys(cqNH)) === J(['ok', 'reason', 'error', 'answers', 'columns', 'isHorn', 'elapsedMs']), J(cqNH));
  check('R4：isHorn=false 被如实回传', cqNH.isHorn === false);
  check('R4：错误文案说明「一致性/分类仍可用」', /一致性|分类/.test(cqNH.error), J(cqNH.error));
  const batchNH = dl.answerCQs(ontNH, [{ select: ['?x'], where: [{ class: 'C', arg: '?x' }] }], cfg);
  check('R4：answerCQs 同样整体拒绝（六字段失败形态）', batchNH.ok === false && batchNH.reason === 'dl-non-horn' && J(Object.keys(batchNH)) === J(['ok', 'reason', 'error', 'isHorn', 'results', 'elapsedMs']), J(batchNH));
  check('R4：非 Horn 本体的 TBox 分类仍可用', dl.reasonTBox(ontNH, cfg).consistent === true);

  // ==========================================================================
  section('9. entail：蕴含探针五形态（设计 §3.3）');
  // ==========================================================================
  const ent = (spec) => dl.entail(ont, spec, cfg);
  const e1 = ent({ kind: 'subclassOf', sub: 'Battery', super: 'Part' });
  check('entail 四字段齐全（成功路径）', J(Object.keys(e1)) === J(['ok', 'entailed', 'explain', 'elapsedMs']), J(Object.keys(e1)));
  check('subclassOf: Battery ⊑ Part 被蕴含', e1.ok === true && e1.entailed === true, J(e1));
  check('subclassOf 的 explain 是中文可读句', /「Battery」/.test(e1.explain) && /「Part」/.test(e1.explain), J(e1.explain));
  check('subclassOf: Part ⊑ Battery 不被蕴含', ent({ kind: 'subclassOf', sub: 'Part', super: 'Battery' }).entailed === false);
  check('subclassOf: Device ⊑ Software 不被蕴含（互斥类）', ent({ kind: 'subclassOf', sub: 'Device', super: 'Software' }).entailed === false);
  const e2 = ent({ kind: 'classAssertion', class: 'Part', individual: nid('p2') });
  check('classAssertion: p2 是 Part（经 Battery ⊑ Part）', e2.entailed === true, J(e2));
  check('classAssertion 的 explain 列出全部推理类型', /Battery/.test(e2.explain) && /Part/.test(e2.explain), J(e2.explain));
  check('classAssertion: p2 不是 Device（范围公理只作用于宾语）', ent({ kind: 'classAssertion', class: 'Device', individual: nid('p2') }).entailed === false);
  check('classAssertion: p1 是 Device（范围公理作用于 part_of 的宾语）', ent({ kind: 'classAssertion', class: 'Device', individual: nid('p1') }).entailed === true);
  check('objectPropertyAssertion: part_of(p2,d1) 被蕴含（传递）', ent({ kind: 'objectPropertyAssertion', property: 'part_of', subject: nid('p2'), object: nid('d1') }).entailed === true);
  check('objectPropertyAssertion: part_of(d1,p2) 不被蕴含（方向不反）', ent({ kind: 'objectPropertyAssertion', property: 'part_of', subject: nid('d1'), object: nid('p2') }).entailed === false);
  check('objectPropertyAssertion: has_part(d1,p2) 被蕴含（逆属性）', ent({ kind: 'objectPropertyAssertion', property: 'has_part', subject: nid('d1'), object: nid('p2') }).entailed === true);
  check('objectPropertyAssertion: located_in(p2,d1) 被蕴含（属性链）', ent({ kind: 'objectPropertyAssertion', property: 'located_in', subject: nid('p2'), object: nid('d1') }).entailed === true);
  // ⚠️ OWL 无唯一名假设（UNA）：两个不同 IRI 的个体**不**自动 differentFrom。
  check('differentIndividuals 不被蕴含（OWL 无唯一名假设 UNA）', ent({ kind: 'differentIndividuals', individuals: [nid('d1'), nid('p1')] }).entailed === false);
  check('sameIndividual 不被蕴含', ent({ kind: 'sameIndividual', individuals: [nid('d1'), nid('p1')] }).entailed === false);
  const eBad = ent({ kind: 'nope' });
  check('未知 kind → ok=false + dl-bad-spec（六字段失败形态）', eBad.ok === false && eBad.reason === 'dl-bad-spec' && J(Object.keys(eBad)) === J(['ok', 'entailed', 'explain', 'reason', 'error', 'elapsedMs']), J(eBad));
  check('dl-bad-spec 时 entailed 为 null（不是 false，避免误判）', eBad.entailed === null, J(eBad.entailed));
  check('dl-bad-spec 的错误文案含原始 kind', /nope/.test(eBad.error), J(eBad.error));
  check('entail(null) 不抛', dl.entail(ont, null, cfg).ok === false);
  check('entail 缺参数 → dl-bad-spec 而非静默', ent({ kind: 'subclassOf', sub: 'Battery' }).ok === false);

  // ==========================================================================
  section('10. graph.js 的 DL 编排：dlQuery / dlEntail / dlHierarchy（设计 §6.1、§7）');
  // ==========================================================================
  check('graph 导出 6 个 DL 成员', ['dlQuery', 'dlEntail', 'dlHierarchy', 'reasonDlReady', 'reasonDlUnavailableReason', 'dlRecallFacts'].every((k) => typeof graph[k] === 'function'), J(Object.keys(graph).filter((k) => /dl/i.test(k))));
  check('reasonDlReady() = true', graph.reasonDlReady() === true);
  check('reasonDlUnavailableReason() 为空', !graph.reasonDlUnavailableReason(), J(graph.reasonDlUnavailableReason()));
  check('SKIP_REASON_TEXT 含 4 个 dl-* 码（T1-b：7→15）', ['dl-unavailable', 'dl-too-large', 'dl-abox-budget', 'dl-non-horn'].every((c) => typeof graph.SKIP_REASON_TEXT[c] === 'string' && graph.SKIP_REASON_TEXT[c].length > 0), J(Object.keys(graph.SKIP_REASON_TEXT)));
  check('SKIP_REASON_TEXT 共 15 键', Object.keys(graph.SKIP_REASON_TEXT).length === 15, J(Object.keys(graph.SKIP_REASON_TEXT)));
  check('dl-bad-spec 刻意不进 SKIP_REASON_TEXT（它是交互式探针错误，不是跳过原因）', graph.SKIP_REASON_TEXT['dl-bad-spec'] === undefined);

  // ⚠️ saveGraph(nodes, edges) 是**两个位置参数**且**同步**；dlQuery/dlEntail/dlHierarchy
  //    也都是同步函数（每次现合成本体，不落库、不写 kv —— 设计 I4）。
  const gMain = dlGraph3();
  graph.saveGraph(gMain.nodes, gMain.edges);
  graph.setOntologyProfile(PID);

  const h = graph.dlHierarchy(PID);
  check('dlHierarchy 九字段齐全', J(Object.keys(h)) === J(['ok', 'profileId', 'consistent', 'hierarchy', 'topClasses', 'unsatClasses', 'labels', 'elapsedMs', 'stats']), J(Object.keys(h)));
  check('dlHierarchy ok=true 且回显 profileId', h.ok === true && h.profileId === PID);
  check('dlHierarchy 给出类层次', J((h.hierarchy.Battery || {}).supers) === J(['Part']), J(h.hierarchy));
  check('dlHierarchy 带 labels（供 UI 直接渲染）', h.labels && typeof h.labels.Battery === 'string', J(h.labels));
  check('dlHierarchy topClasses 非空', h.topClasses.length > 0, J(h.topClasses));

  const q = graph.dlQuery(PID, { select: ['?o'], where: [{ objectProperty: 'part_of', subject: nid('p1'), object: '?o' }] });
  check('dlQuery 七字段齐全（含 gate，供 UI 显示规模门控）', J(Object.keys(q)) === J(['ok', 'answers', 'columns', 'isHorn', 'elapsedMs', 'profileId', 'gate']), J(Object.keys(q)));
  check('dlQuery ok=true', q.ok === true, J(q));
  check('dlQuery gate 六字段', J(Object.keys(q.gate)) === J(['classCount', 'individualCount', 'budgetUsed', 'allowTBox', 'allowABox', 'reason']), J(q.gate));
  check('dlQuery gate 放行', q.gate.allowABox === true && q.gate.classCount === 4 && q.gate.individualCount === 3, J(q.gate));
  check('dlQuery 查到 d1', J(q.answers.map((r) => r[0].value)) === J([nid('d1')]), J(q.answers));

  const en = graph.dlEntail(PID, { kind: 'subclassOf', sub: 'Battery', super: 'Part' });
  check('dlEntail 五字段齐全', J(Object.keys(en)) === J(['ok', 'entailed', 'explain', 'elapsedMs', 'profileId']), J(Object.keys(en)));
  check('dlEntail 蕴含成立', en.ok === true && en.entailed === true, J(en));

  // 降级路径：非 DL 体系（失败形态是另一组九键：无 labels/stats，多 error）
  const hBfo = graph.dlHierarchy('bfo-lite');
  check('非 DL 体系 → dl-unavailable（九字段降级形态）', hBfo.ok === false && hBfo.reason === 'dl-unavailable'
    && J(Object.keys(hBfo)) === J(['ok', 'reason', 'error', 'profileId', 'consistent', 'hierarchy', 'topClasses', 'unsatClasses', 'elapsedMs']), J(hBfo));
  check('降级时 hierarchy/consistent 为 null（不是空对象，UI 可区分）', hBfo.hierarchy === null && hBfo.consistent === null, J(hBfo));
  check('降级文案指明「仅 OWL 导入的完整 DL 体系支持」', /DL 推理/.test(hBfo.error) && /OWL 导入/.test(hBfo.error), J(hBfo.error));
  const qBfo = graph.dlQuery('bfo-lite', { select: ['?x'], where: [{ class: 'Device', arg: '?x' }] });
  check('dlQuery 非 DL 体系 → dl-unavailable（isHorn=null）', qBfo.ok === false && qBfo.reason === 'dl-unavailable' && qBfo.isHorn === null, J(qBfo));
  const eBfo = graph.dlEntail('bfo-lite', { kind: 'subclassOf', sub: 'A', super: 'B' });
  check('dlEntail 非 DL 体系 → entailed=null + dl-unavailable', eBfo.ok === false && eBfo.entailed === null && eBfo.reason === 'dl-unavailable', J(eBfo));
  // ⚠️ resolveOntology 对未知 id **不抛**、静默回落 bfo-lite，所以 unknown-profile 分支不可达，
  //    最终仍以 dl-unavailable 呈现（这是有意的：不给用户暴露内部体系 id 概念）。
  const qUnknown = graph.dlQuery('不存在的体系', { select: ['?x'], where: [{ class: 'A', arg: '?x' }] });
  check('未知 profileId → 静默回落 bfo-lite → dl-unavailable（不抛）', qUnknown.ok === false && qUnknown.reason === 'dl-unavailable', J(qUnknown));
  const qBadSpec = graph.dlQuery(PID, { select: ['?x'], where: [] });
  check('dlQuery 空 where → dl-bad-spec 透传到 graph 层', qBadSpec.ok === false && qBadSpec.reason === 'dl-bad-spec', J(qBadSpec));

  // ==========================================================================
  section('11. dlRecallFacts：kgAsk 的 CQ 召回（设计 §6.2、Q-DL-4）');
  // ==========================================================================
  // ⚠️ seeds 必须是**节点对象**（函数读 seed.id / n.profile / n.type），不是 id 字符串；
  //    进度回调叫 opts.send（不是 onStage）；函数是**同步**的。
  const seedD1 = gMain.nodes.find((n) => n.id === nid('d1'));
  const rec = graph.dlRecallFacts(gMain, [seedD1], { settings: { reasonEnabled: true }, entityPid: PID });
  check('dlRecallFacts 两字段（facts/info）', J(Object.keys(rec)) === J(['facts', 'info']), J(Object.keys(rec)));
  check('召回出 BFS 未覆盖的 DL 事实（d1 恰好触及 4 条 DL 推理边）', rec.facts.length === 4, J(rec.facts));
  check('事实文案带「⚡DL 推理」标记（UI 可区分来源）', rec.facts.every((f) => f.includes('⚡DL 推理')), J(rec.facts));
  check('事实文案带 [体系·类型] 前缀', /^\[owl:dltest·/.test(rec.facts[0] || ''), J(rec.facts[0]));
  check('info 单条含 profileId/ok/isHorn/specs/facts/elapsedMs', rec.info && rec.info.length === 1 && J(Object.keys(rec.info[0])) === J(['profileId', 'ok', 'isHorn', 'specs', 'facts', 'elapsedMs']), J(rec.info));
  check('info.specs = 1 seed × 4 谓词 × 2 方向 = 8（CQ 模板化，Q-DL-4）', rec.info[0].specs === 8, J(rec.info[0]));
  check('info.facts 与 facts 长度一致', rec.info[0].facts === rec.facts.length, J(rec.info[0]));
  check('召回的事实不含已有原始边（have 去重）', !rec.facts.some((f) => f.includes('部件1 —') && f.includes('→ 设备1')), J(rec.facts));

  const st1 = [];
  const rec2 = graph.dlRecallFacts(gMain, [seedD1], { settings: { reasonEnabled: true }, entityPid: PID, send: (m) => st1.push(m) });
  check('opts.send 回调收到 DL 召回阶段消息', st1.length === 1 && /DL 合取查询召回完成/.test(st1[0]), J(st1));
  check('阶段消息含查询数与事实数', /8 条查询/.test(st1[0]) && /4 条/.test(st1[0]), J(st1[0]));
  check('重复调用结果稳定', J(rec2.facts) === J(rec.facts));

  const EMPTY = { facts: [], info: null };
  check('空 seeds → 静默返回空（不报错）', J(graph.dlRecallFacts(gMain, [], { settings: { reasonEnabled: true }, entityPid: PID })) === J(EMPTY));
  check('seeds 非数组 → 静默返回空', J(graph.dlRecallFacts(gMain, null, { settings: { reasonEnabled: true }, entityPid: PID })) === J(EMPTY));
  check('推理关闭 → 不召回（尊重用户开关）', J(graph.dlRecallFacts(gMain, [seedD1], { settings: { reasonEnabled: false }, entityPid: PID })) === J(EMPTY));
  // MAX_SEEDS_PER_PROFILE=5：50 个 seed 被截断到 5 → 5×4×2=40 条 spec（未截断会是 400，撞 MAX_SPECS=150）
  const many = Array.from({ length: 50 }, (_, i) => ({ id: `${PID}:x${i}`, name: `x${i}`, type: 'Device', profile: PID }));
  const recMany = graph.dlRecallFacts({ nodes: many, edges: [] }, many, { settings: { reasonEnabled: true }, entityPid: PID });
  check('seeds 超上限被截断到 5（specs=40 而非 150）', recMany.info[0].specs === 40, J(recMany.info[0]));
  check('截断不抛、facts 仍是数组', Array.isArray(recMany.facts));
  const bfoNodes = [{ id: 'bfo-lite:a', name: 'a', type: 'X', profile: 'bfo-lite' }];
  check('非 DL 体系 seed → 跳过该 profile', J(graph.dlRecallFacts({ nodes: bfoNodes, edges: [] }, bfoNodes, { settings: { reasonEnabled: true } })) === J(EMPTY));
  const recMixed = graph.dlRecallFacts(gMain, [seedD1, bfoNodes[0]], { settings: { reasonEnabled: true }, entityPid: PID });
  check('混合 profile seeds → 只对 DL 体系召回', recMixed.info.length === 1 && recMixed.info[0].profileId === PID, J(recMixed.info));
  check('ABox 预算被压到 0 → 门控拦截、不召回（不抛）', J(graph.dlRecallFacts(gMain, [seedD1], { settings: { reasonEnabled: true }, entityPid: PID, limits: { aboxBudget: 0 } })) === J(EMPTY));

  // ==========================================================================
  section('12. runInference 合并 + IPC 三通道（设计 §4.2、§7、Q-DL-6、T1-c）');
  // ==========================================================================
  // ⚠️ runInference(settings, opts) 是**两个位置参数**：settings=null 表示从 kv 读。
  const RS = { reasonEnabled: true };
  const ri = await graph.runInference(RS, {});
  check('runInference 12 字段（T1-d 契约不变）', J(Object.keys(ri)) === J(['ok', 'skipped', 'inferredEdges', 'bound', 'dropped', 'inconsistencies', 'rounds', 'elapsedMs', 'profiles', 'skippedProfiles', 'perProfile', 'total']), J(Object.keys(ri)));
  // ⚠️ perProfile[] 的体系字段名是 **profileId**（不是 pid）。
  const findPid = (r) => r.perProfile.find((p) => p.profileId === PID);
  check('perProfile 含本体系条目', !!findPid(ri), J(ri.perProfile.map((p) => p.profileId)));
  check('perProfile[].dl 六字段（嵌进既有自由形态子对象，不新增顶层键）',
    J(Object.keys(findPid(ri).dl)) === J(['ran', 'consistent', 'unsatCount', 'dlInferred', 'elapsedMs', 'skipReason']),
    J(findPid(ri).dl));
  const dlStat = findPid(ri).dl;
  check('浅推理（默认）也跑 DL TBox 一致性', dlStat.ran === true && dlStat.consistent === true, J(dlStat));
  check('浅推理不触发 ABox → dlInferred=0', dlStat.dlInferred === 0, J(dlStat));
  check('dlStat.skipReason 为空串（未跳过）', dlStat.skipReason === '');

  const st = graph.getReasonState(PID);
  check('getReasonState 11 字段（T1-e 契约不变）', J(Object.keys(st)) === J(['available', 'enabled', 'unavailableReason', 'timeoutSec', 'meta', 'counts', 'coverage', 'features', 'lastInconsistencies', 'repairLlm', 'repairUndoAvailable']), J(Object.keys(st)));
  check('meta 四字段（lastStats 只在跑过推理后非 null）', J(Object.keys(st.meta)) === J(['lastInferredAt', 'inferredStale', 'lastStats', 'lastGuard']), J(Object.keys(st.meta)));
  check('meta.lastStats.dl 七字段（summarizeDl）', J(Object.keys(st.meta.lastStats.dl)) === J(['ran', 'consistent', 'unsatCount', 'dlInferred', 'elapsedMs', 'skipReasons', 'profiles']), J(st.meta.lastStats.dl));
  check('lastStats 12 字段（T1 契约不变，dl 是嵌套键）', J(Object.keys(st.meta.lastStats)) === J(['skipped', 'inferredEdges', 'bound', 'dropped', 'inconsistencies', 'rounds', 'elapsedMs', 'profiles', 'skippedProfiles', 'dl', 'inconsistencyDetails', 'at']), J(Object.keys(st.meta.lastStats)));
  check('coverage.dlCapable = true（T1-h：嵌进 coverage，不新增顶层键）', st.coverage.dlCapable === true, J(st.coverage.dlCapable));
  check('coverage 其余字段不变（predicates/classCount/axiomCount 等）', st.coverage.predicates === 4 && st.coverage.classCount === 4, J(Object.keys(st.coverage)));
  check('coverage.transitive 含 part_of', J(st.coverage.transitive) === J(['part_of']), J(st.coverage.transitive));
  check('coverage.inversePairs 含 part_of↔has_part', st.coverage.inversePairs.some((p) => p[0] === 'part_of' && J(p[1]) === J(['has_part'])), J(st.coverage.inversePairs));
  check('coverage.disjointPairs 含 Device⊥Software', st.coverage.disjointPairs.some((p) => J(p.slice().sort()) === J(['Device', 'Software'])), J(st.coverage.disjointPairs));
  check('非 DL 体系的 coverage.dlCapable = false', graph.getReasonState('bfo-lite').coverage.dlCapable === false);

  // Q-DL-6：deep 推理触发 ABox，RL 优先、DL 补差集
  const riDeep = await graph.runInference(RS, { deep: true });
  const dlDeep = findPid(riDeep).dl;
  check('Q-DL-6：deep=true 触发 DL ABox 推理', dlDeep.ran === true && dlDeep.dlInferred >= 1, J(dlDeep));
  check('Q-DL-6：DL 只补 RL 未产出的边（按 edgeKey 去重，实测 5 条里只补 1 条）', dlDeep.dlInferred < 5, `dlInferred=${dlDeep.dlInferred}（DL 单独可产 5 条）`);
  const gAfter = graph.getGraph();
  const dlEdges = (gAfter.edges || []).filter((e) => e.inferredVia === 'dl-tableau');
  check('落库的 dl-tableau 边带 inferredBy 归属', dlEdges.length >= 1 && dlEdges.every((e) => e.inferredBy === 'dl-js-reasoner'), J(dlEdges.map((e) => [e.from, e.to, e.rel])));
  check('落库边数与 dlInferred 一致', dlEdges.length === dlDeep.dlInferred, `${dlEdges.length} vs ${dlDeep.dlInferred}`);
  check('meta.lastStats.dl 反映 deep 结果', graph.getReasonState(PID).meta.lastStats.dl.dlInferred === dlDeep.dlInferred);
  // ⚠️ 上限语义（BUGFIX #4 后）：reasonABox 现在**显式**尊重 0 —— `Number.isFinite(x) && x >= 0`
  //    才回落默认值，旧写法 `Number(x) > 0 ? x : 默认` 会把 0 当 falsy 吞掉（请求 0 条却拿到 5000 条）。
  //    这个上限是保护 kv 存储的硬约束，必须能被调用方真正压到 0，故两个端点都要验。
  const riCap = await graph.runInference(RS, { deep: true, maxDlEdges: 1 });
  check('maxDlEdges=1 限额可透传（保护 kv 存储，≤1）', findPid(riCap).dl.dlInferred <= 1, J(findPid(riCap).dl));
  const riZero = await graph.runInference(RS, { deep: true, maxDlEdges: 0 });
  check('maxDlEdges=0 一条 DL 边都不出（0 是合法上限，不是 falsy 回落）', findPid(riZero).dl.dlInferred === 0, J(findPid(riZero).dl));
  check('maxDlEdges=0 时 DL 阶段仍执行（ran=true，只是产出为空）', findPid(riZero).dl.ran === true, J(findPid(riZero).dl));

  // IPC 三通道（T1-c：14 → 17）
  const { registerIpc } = require('../src/main/ipc');
  registerIpc(() => ({ isDestroyed: () => false, webContents: { send: () => {} } }));
  const invoke = env.el.invoke;
  const CHANNELS = ['graph:reasonStatus', 'graph:reasonState', 'graph:predicateFeatures', 'graph:runInference', 'graph:clearInferred', 'graph:deleteEdge', 'graph:deleteNode', 'graph:impactClosure', 'graph:previewOwl', 'graph:validate', 'graph:planRepairs', 'graph:planRepairsForIssues', 'graph:applyRepairs', 'graph:undoRepair', 'graph:dlQuery', 'graph:dlEntail', 'graph:dlHierarchy'];
  check('T1-c：17 条图谱 IPC 通道全部注册（14 → 17）', CHANNELS.every((c) => env.el.handlers.has(c)), J(CHANNELS.filter((c) => !env.el.handlers.has(c))));
  check('graph:dlQuery 通道已注册', env.el.handlers.has('graph:dlQuery'));
  check('graph:dlEntail 通道已注册', env.el.handlers.has('graph:dlEntail'));
  check('graph:dlHierarchy 通道已注册', env.el.handlers.has('graph:dlHierarchy'));
  const ipcH = await invoke('graph:dlHierarchy', PID);
  check('IPC dlHierarchy 可用', ipcH.ok === true && ipcH.profileId === PID, J(ipcH));
  const ipcH2 = await invoke('graph:dlHierarchy', { profileId: PID });
  check('IPC dlHierarchy 兼容对象形态参数', ipcH2.ok === true && ipcH2.profileId === PID, J(ipcH2));
  const ipcQ = await invoke('graph:dlQuery', PID, { select: ['?o'], where: [{ objectProperty: 'part_of', subject: nid('p1'), object: '?o' }] });
  check('IPC dlQuery 可用', ipcQ.ok === true && ipcQ.answers.length === 1, J(ipcQ));
  const ipcQ2 = await invoke('graph:dlQuery', { profileId: PID, spec: { select: ['?o'], where: [{ objectProperty: 'part_of', subject: nid('p1'), object: '?o' }] } });
  check('IPC dlQuery 兼容 {profileId, spec} 形态', ipcQ2.ok === true && J(ipcQ2.answers) === J(ipcQ.answers), J(ipcQ2));
  const ipcE = await invoke('graph:dlEntail', PID, { kind: 'subclassOf', sub: 'Battery', super: 'Part' });
  check('IPC dlEntail 可用', ipcE.ok === true && ipcE.entailed === true, J(ipcE));
  const ipcE2 = await invoke('graph:dlEntail', { profileId: PID, axiom: { kind: 'classAssertion', class: 'Part', individual: nid('p2') } });
  check('IPC dlEntail 兼容 {profileId, axiom} 形态', ipcE2.ok === true && ipcE2.entailed === true, J(ipcE2));
  const ipcErr = await invoke('graph:dlQuery', PID, { select: ['?x'], where: [] });
  check('IPC 层如实透传 dl-bad-spec（不吞错）', ipcErr.ok === false && ipcErr.reason === 'dl-bad-spec', J(ipcErr));
  // ⚠️ 处理器是 graph.runInference(null, opts)：opts.settings 被忽略，opts.deep 生效。
  const ipcDeep = await invoke('graph:runInference', { deep: true });
  check('graph:runInference 原样转发 opts → deep 生效', ipcDeep.ok === true && findPid(ipcDeep).dl.dlInferred >= 1, J(findPid(ipcDeep) && findPid(ipcDeep).dl));


  // ==========================================================================
  section('13. 风险缓解回归（设计 §10：R1 / R3 / R9）');
  // ==========================================================================
  check('R1：dl-js-reasoner 缺失时 dlAvailable()=false 且给出原因（此处验证正常态）', dl.dlAvailable() === true && dl.dlError() === '');
  // ★回归：exprFromTree 是**导出成员**且被 owlImport.js 的序列化器复用，
  // 调用方可能在任何触发惰性装载的 API 之前就用它。修复前 E 仍为 null →
  // `TypeError: Cannot read properties of null (reading 'owlClass')`。必须在全新进程里验，
  // 因为本进程早已装载过 DL，模块级 E 不再是 null。
  check('R1：exprFromTree 作为首个 API 调用不 NPE（惰性装载自守）', (() => {
    const { execFileSync } = require('child_process');
    const script = "const dl=require('./src/main/graph/reason/dl');"
      + "const a=dl.exprFromTree('Device');"
      + "const b=dl.exprFromTree({kind:'or',operands:['A','B']});"
      + "const c=dl.exprFromTree({kind:'min',n:2,property:'p'});"
      + "process.stdout.write(JSON.stringify([a&&a.type,b&&b.type,c&&c.type]));";
    const out = execFileSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 30000 });
    return out === J(['OWLClass', 'ObjectUnionOf', 'ObjectMinCardinality']);
  })());
  check('R3：非 Horn 本体不会让 CQ 抛异常（已降级为 reason）', cqNH.ok === false && typeof cqNH.error === 'string');
  check('R3：DL 内部异常被 classifyError 归类，不外泄栈', dl.reasonABox(ontBad, cfg, {}).inconsistencies[0].rule === 'dl-inconsistent');
  check('R7：不一致本体的所有查询都短路（TBox/ABox/CQ 三处已验）', tboxBad.consistent === false && aboxBad.consistent === false && cqNH.ok === false);
  check('R9：dl-js-reasoner 是 LGPL-3.0-or-later', require('dl-js-reasoner/package.json').license === 'LGPL-3.0-or-later', J(require('dl-js-reasoner/package.json').license));
  check('R9：推理边标注 inferredBy=dl-js-reasoner（归属可追溯）', abox.inferredEdges.every((e) => e.inferredBy === 'dl-js-reasoner'));
  check('R9：Synapse package.json 已声明 dl-js-reasoner 依赖', !!require('../package.json').dependencies['dl-js-reasoner'], J(require('../package.json').dependencies['dl-js-reasoner']));

  // ==========================================================================
  section('14. DL 设置页配置（融合设计 §12：开关 / 默认深度 / 规模上限）');
  // ==========================================================================
  // 三个纯函数 + 一个快照函数，全部只读 settings，不碰 kv、不碰推理层。
  check('graph 导出 4 个 DL 配置成员', ['dlEnabled', 'dlDeepDefault', 'dlLimitsFromSettings', 'dlConfigSnapshot'].every((k) => typeof graph[k] === 'function'), J(Object.keys(graph).filter((k) => /^dl/.test(k))));

  // --- 开关：口径与 reasonEnabled 一致（未显式关闭即开启） ---
  check('dlEnabled({}) 默认开', graph.dlEnabled({}) === true);
  check('dlEnabled(null) 默认开', graph.dlEnabled(null) === true);
  check('dlEnabled({dlEnabled:true}) 开', graph.dlEnabled({ dlEnabled: true }) === true);
  check('dlEnabled({dlEnabled:false}) 关', graph.dlEnabled({ dlEnabled: false }) === false);
  check('dlEnabled 把空串/undefined/null 都当「未设置」→ 开', [undefined, null, ''].every((v) => graph.dlEnabled({ dlEnabled: v }) === true), J([undefined, null, ''].map((v) => graph.dlEnabled({ dlEnabled: v }))));
  check('dlEnabled 对 0 / "false" 按 truthy 语义处理（与 reasonEnabled 同口径）', graph.dlEnabled({ dlEnabled: 0 }) === false && graph.dlEnabled({ dlEnabled: 'false' }) === true, J([graph.dlEnabled({ dlEnabled: 0 }), graph.dlEnabled({ dlEnabled: 'false' })]));

  // --- 默认深度：默认关（D4 成本控制），勾选才落 true ---
  check('dlDeepDefault({}) 默认关', graph.dlDeepDefault({}) === false);
  check('dlDeepDefault(null) 默认关', graph.dlDeepDefault(null) === false);
  check('dlDeepDefault({dlDeep:true}) 开', graph.dlDeepDefault({ dlDeep: true }) === true);
  check('dlDeepDefault({dlDeep:false}) 关', graph.dlDeepDefault({ dlDeep: false }) === false);

  // --- 规模上限：留空 → 空对象（由 gateScale 的 {...DL_LIMITS,...limits} 回落默认值） ---
  check('dlLimitsFromSettings({}) → 空对象（不钉死默认值，跟随代码演进）', J(graph.dlLimitsFromSettings({})) === '{}', J(graph.dlLimitsFromSettings({})));
  check('dlLimitsFromSettings(null) → 空对象（不抛）', J(graph.dlLimitsFromSettings(null)) === '{}');
  check('dlLimitsFromSettings 只产出 DL_LIMITS 的既有键名（绝不新增键）', (() => {
    const full = graph.dlLimitsFromSettings({ dlMaxClasses: 100, dlAboxBudget: 200, dlTransitiveCap: 3, dlMaxAxioms: 4, dlMaxEdges: 5 });
    return J(Object.keys(full).sort()) === J(Object.keys(dl.DL_LIMITS).sort());
  })(), J(graph.dlLimitsFromSettings({ dlMaxClasses: 100, dlAboxBudget: 200, dlTransitiveCap: 3, dlMaxAxioms: 4, dlMaxEdges: 5 })));
  check('dlLimitsFromSettings 键名映射正确（settings 键 → DL_LIMITS 键）',
    J(graph.dlLimitsFromSettings({ dlMaxClasses: 100, dlAboxBudget: 200, dlTransitiveCap: 3, dlMaxAxioms: 4, dlMaxEdges: 5 }))
    === J({ maxClasses: 100, aboxBudget: 200, transitiveIndividualCap: 3, maxDlAxioms: 4, maxInferredEdges: 5 }),
    J(graph.dlLimitsFromSettings({ dlMaxClasses: 100, dlAboxBudget: 200, dlTransitiveCap: 3, dlMaxAxioms: 4, dlMaxEdges: 5 })));
  check('只改一项 → 只出现一项（其余跟随默认值）', J(graph.dlLimitsFromSettings({ dlMaxClasses: 500 })) === J({ maxClasses: 500 }), J(graph.dlLimitsFromSettings({ dlMaxClasses: 500 })));
  // 钳制范围必须与 src/renderer/constants.js 的 NUM_SETTING_FIELDS 逐字一致
  const CLAMP = [
    ['dlMaxClasses', 'maxClasses', 10, 20000],
    ['dlAboxBudget', 'aboxBudget', 0, 100000000],
    ['dlTransitiveCap', 'transitiveIndividualCap', 0, 100000],
    ['dlMaxAxioms', 'maxDlAxioms', 0, 100000],
    ['dlMaxEdges', 'maxInferredEdges', 0, 1000000],
  ];
  check('五项上限均按 [min,max] 钳制（下界）', CLAMP.every(([sk, lk, min]) => graph.dlLimitsFromSettings({ [sk]: min - 1000 })[lk] === min), J(CLAMP.map(([sk, lk, min]) => [sk, graph.dlLimitsFromSettings({ [sk]: min - 1000 })[lk], min])));
  check('五项上限均按 [min,max] 钳制（上界）', CLAMP.every(([sk, lk, , max]) => graph.dlLimitsFromSettings({ [sk]: max + 1000 })[lk] === max), J(CLAMP.map(([sk, lk, , max]) => [sk, graph.dlLimitsFromSettings({ [sk]: max + 1000 })[lk], max])));
  check('上限 0 是合法值（不是 falsy 回落）', graph.dlLimitsFromSettings({ dlAboxBudget: 0 }).aboxBudget === 0 && graph.dlLimitsFromSettings({ dlMaxEdges: 0 }).maxInferredEdges === 0, J(graph.dlLimitsFromSettings({ dlAboxBudget: 0, dlMaxEdges: 0 })));
  check('小数被四舍五入为整数', graph.dlLimitsFromSettings({ dlMaxClasses: 12.6 }).maxClasses === 13, J(graph.dlLimitsFromSettings({ dlMaxClasses: 12.6 })));
  check('字符串数字可解析（表单值可能未转数字）', graph.dlLimitsFromSettings({ dlMaxClasses: '120' }).maxClasses === 120, J(graph.dlLimitsFromSettings({ dlMaxClasses: '120' })));
  check('非法值（NaN/对象）被丢弃而非钳成 min', graph.dlLimitsFromSettings({ dlMaxClasses: 'abc' }).maxClasses === undefined && graph.dlLimitsFromSettings({ dlMaxClasses: {} }).maxClasses === undefined, J(graph.dlLimitsFromSettings({ dlMaxClasses: 'abc', dlAboxBudget: {} })));
  check('空串视为「未设置」→ 丢弃该键', J(graph.dlLimitsFromSettings({ dlMaxClasses: '  ' })) === '{}', J(graph.dlLimitsFromSettings({ dlMaxClasses: '  ' })));
  check('未知 settings 键被忽略（不污染 limits）', J(graph.dlLimitsFromSettings({ dlNope: 1, reasonTimeout: 99 })) === '{}', J(graph.dlLimitsFromSettings({ dlNope: 1, reasonTimeout: 99 })));

  // --- 快照：供设置页状态行与「推理」Tab 的 DL 区块回显 ---
  const snap0 = graph.dlConfigSnapshot({});
  check('dlConfigSnapshot 七字段', J(Object.keys(snap0)) === J(['ready', 'unavailableReason', 'enabled', 'deepDefault', 'limits', 'customized', 'timeoutSec']), J(Object.keys(snap0)));
  check('快照 ready=true / enabled=true / deepDefault=false', snap0.ready === true && snap0.enabled === true && snap0.deepDefault === false, J(snap0));
  check('快照 limits = DL_LIMITS 全量默认值（前端不必硬编码）', J(snap0.limits) === J(dl.DL_LIMITS), J(snap0.limits));
  check('快照 customized 为空数组（未覆盖任何项）', J(snap0.customized) === '[]', J(snap0.customized));
  check('快照 timeoutSec 默认 30', snap0.timeoutSec === 30, J(snap0.timeoutSec));
  const snap1 = graph.dlConfigSnapshot({ dlEnabled: false, dlDeep: true, dlMaxClasses: 77, reasonTimeout: 90 });
  check('快照反映开关/深度/自定义上限', snap1.enabled === false && snap1.deepDefault === true && snap1.limits.maxClasses === 77 && snap1.timeoutSec === 90, J(snap1));
  check('快照 customized 只列出被覆盖的键', J(snap1.customized) === J(['maxClasses']), J(snap1.customized));
  check('快照 limits 未覆盖项仍回落默认值', snap1.limits.aboxBudget === dl.DL_LIMITS.aboxBudget && snap1.limits.maxInferredEdges === dl.DL_LIMITS.maxInferredEdges, J(snap1.limits));
  check('快照 limits 键集恒等于 DL_LIMITS 键集', J(Object.keys(snap1.limits).sort()) === J(Object.keys(dl.DL_LIMITS).sort()), J(Object.keys(snap1.limits)));

  // --- 快照嵌进 coverage（不新增顶层键：getReasonState 11 / reasonStatus 5 契约不变） ---
  const stCfg = graph.getReasonState(PID);
  check('getReasonState 仍恰好 11 字段（§12 未破坏 T1-e 契约）', J(Object.keys(stCfg)) === J(['available', 'enabled', 'unavailableReason', 'timeoutSec', 'meta', 'counts', 'coverage', 'features', 'lastInconsistencies', 'repairLlm', 'repairUndoAvailable']), J(Object.keys(stCfg)));
  check('coverage.dl 存在且为快照形态', !!stCfg.coverage.dl && J(Object.keys(stCfg.coverage.dl)) === J(['ready', 'unavailableReason', 'enabled', 'deepDefault', 'limits', 'customized', 'timeoutSec']), J(stCfg.coverage.dl));
  check('coverage.dl.limits 给出预算分母（前端此前刻意不显示的那个数）', stCfg.coverage.dl.limits.aboxBudget === dl.DL_LIMITS.aboxBudget, J(stCfg.coverage.dl.limits));
  check('coverage.dlCapable 仍在（未被 dl 子键挤掉）', stCfg.coverage.dlCapable === true);
  check('非 DL 体系也回传 coverage.dl（配置与体系能力无关）', (() => {
    const sb = graph.getReasonState('bfo-lite');
    return !!sb.coverage && !!sb.coverage.dl && sb.coverage.dlCapable === false;
  })(), J(graph.getReasonState('bfo-lite').coverage && graph.getReasonState('bfo-lite').coverage.dl));
  const rsCfg = graph.reasonStatus();
  check('reasonStatus 仍恰好 5 字段（§12 未破坏契约）', J(Object.keys(rsCfg)) === J(['available', 'enabled', 'reason', 'timeoutSec', 'coverage']), J(Object.keys(rsCfg)));
  check('reasonStatus.coverage.dl 同样可用（设置页状态行的数据源）', !!rsCfg.coverage.dl && rsCfg.coverage.dl.enabled === true, J(rsCfg.coverage.dl));

  // --- 设置项真正生效：门控按自定义上限放行/拦截 ---
  const gCfg = dlGraph3();
  graph.saveGraph(gCfg.nodes, gCfg.edges);
  graph.setOntologyProfile(PID);
  const profCfg = graph.resolveOntology(PID);
  // ⚠️ dlMaxClasses 的设置下界是 10，而 PID 只有 4 个类 → 用本体系永远撞不到 dl-too-large。
  //    这里造一个 12 类的同构 profile（gateScale 只读 classes.length / predicates / axioms /
  //    dlAxioms，浅拷贝即可），才能验证「设置项 → 门控」这条链真的通。
  const profBig = { ...profCfg, classes: Array.from({ length: 12 }, (_, i) => ({ key: `C${i}`, label: `C${i}` })) };
  check('自定义 dlMaxClasses=10 + 12 类体系 → 门控拦截（dl-too-large）', dl.gateScale(profBig, gCfg, graph.dlLimitsFromSettings({ dlMaxClasses: 10 })).reason === 'dl-too-large', J(dl.gateScale(profBig, gCfg, graph.dlLimitsFromSettings({ dlMaxClasses: 10 }))));
  check('同一体系不设上限 → 放行（证明拦截来自设置项而非体系本身）', dl.gateScale(profBig, gCfg).allowTBox === true, J(dl.gateScale(profBig, gCfg)));
  check('自定义 dlAboxBudget=0 → ABox 被禁、TBox 仍放行', (() => {
    const g2 = dl.gateScale(profCfg, gCfg, graph.dlLimitsFromSettings({ dlAboxBudget: 0 }));
    return g2.allowTBox === true && g2.allowABox === false && g2.reason === 'dl-abox-budget';
  })(), J(dl.gateScale(profCfg, gCfg, graph.dlLimitsFromSettings({ dlAboxBudget: 0 }))));
  check('自定义 dlTransitiveCap=0 → 含传递属性时 ABox 被禁（本体系 part_of 传递）', (() => {
    const g3 = dl.gateScale(profCfg, gCfg, graph.dlLimitsFromSettings({ dlTransitiveCap: 0 }));
    return g3.allowTBox === true && g3.allowABox === false && g3.reason === 'dl-abox-budget';
  })(), J(dl.gateScale(profCfg, gCfg, graph.dlLimitsFromSettings({ dlTransitiveCap: 0 }))));
  check('自定义 dlTransitiveCap=80（默认值）→ ABox 照常放行', dl.gateScale(profCfg, gCfg, graph.dlLimitsFromSettings({ dlTransitiveCap: 80 })).allowABox === true, J(dl.gateScale(profCfg, gCfg, graph.dlLimitsFromSettings({ dlTransitiveCap: 80 }))));
  check('自定义 dlMaxAxioms 透传到 buildDLOntology（0 → 一条 DL 公理都不合成）', (() => {
    const o0 = dl.buildDLOntology(profCfg, gCfg, { abox: false, limits: graph.dlLimitsFromSettings({ dlMaxAxioms: 0 }) });
    const oD = dl.buildDLOntology(profCfg, gCfg, { abox: false });
    return o0.stats.dlAxiomsConverted === 0 && oD.stats.dlAxiomsConverted >= 1;
  })(), J({ zero: dl.buildDLOntology(profCfg, gCfg, { abox: false, limits: { maxDlAxioms: 0 } }).stats, dflt: dl.buildDLOntology(profCfg, gCfg, { abox: false }).stats }));
  check('buildDLOntology 不传 limits 时行为与既往完全一致（向后兼容）', (() => {
    const a = dl.buildDLOntology(profCfg, gCfg, { abox: true });
    const b = dl.buildDLOntology(profCfg, gCfg, { abox: true, limits: {} });
    return J(a.stats) === J(b.stats) && a.axioms.length === b.axioms.length;
  })());
  check('buildDLOntology 对非法 limits 不抛（回落默认值）', (() => {
    const o = dl.buildDLOntology(profCfg, gCfg, { abox: false, limits: { maxDlAxioms: 'abc' } });
    return o.stats.dlAxiomsConverted >= 1;
  })());

  // --- infer.js：opts.dlEnabled === false 才关闭，undefined 必须视为开启 ---
  const infer = require('../src/main/graph/reason/infer');
  const matOff = await infer.materializeGraph(gCfg, profCfg, { dlEnabled: false });
  check('dlEnabled:false → DL 阶段跳过、原因码 dl-disabled', matOff.stats.dl.ran === false && matOff.stats.dl.skipReason === 'dl-disabled', J(matOff.stats.dl));
  check('dlEnabled:false 时 dlStats 仍恰好 6 字段（契约不变）', J(Object.keys(matOff.stats.dl)) === J(['ran', 'consistent', 'unsatCount', 'dlInferred', 'elapsedMs', 'skipReason']), J(Object.keys(matOff.stats.dl)));
  check('dlEnabled:false 不影响 RL 结论（推理边照常产出）', matOff.stats.inferredCount >= 1, J(matOff.stats));
  const matUndef = await infer.materializeGraph(gCfg, profCfg, {});
  check('⚠️ dlEnabled 省略（undefined）必须视为开启（27 处既有直调依赖此语义）', matUndef.stats.dl.ran === true && matUndef.stats.dl.skipReason === '', J(matUndef.stats.dl));
  const matOn = await infer.materializeGraph(gCfg, profCfg, { dlEnabled: true });
  check('dlEnabled:true 显式开启同样生效', matOn.stats.dl.ran === true, J(matOn.stats.dl));
  const matLimits = await infer.materializeGraph(gCfg, profCfg, { deep: true, limits: graph.dlLimitsFromSettings({ dlAboxBudget: 0 }) });
  check('limits 透传到 infer → ABox 预算 0 时深扫无产出（ran=true 但 dlInferred=0）', matLimits.stats.dl.ran === true && matLimits.stats.dl.dlInferred === 0, J(matLimits.stats.dl));
  const matLimitsCtl = await infer.materializeGraph(gCfg, profCfg, { deep: true });
  check('对照组：不传 limits 时深扫确有产出（证明上面的 0 来自设置项）', matLimitsCtl.stats.dl.dlInferred >= 1, J(matLimitsCtl.stats.dl));
  const matDeepDefault = await infer.materializeGraph(gCfg, profCfg, { deep: true, maxDlEdges: 0 });
  check('deep + maxDlEdges=0 → DL 跑但不落边（设置项组合可用）', matDeepDefault.stats.dl.ran === true && matDeepDefault.stats.dl.dlInferred === 0, J(matDeepDefault.stats.dl));

  // --- runInference：settings 里的 DL 开关/深度/上限端到端生效 ---
  const riOff = await graph.runInference({ reasonEnabled: true, dlEnabled: false }, { deep: true });
  check('runInference(dlEnabled:false) → perProfile[].dl.ran=false', findPid(riOff).dl.ran === false, J(findPid(riOff).dl));
  check('runInference(dlEnabled:false) → skipReason=dl-disabled', findPid(riOff).dl.skipReason === 'dl-disabled', J(findPid(riOff).dl));
  check('runInference(dlEnabled:false) 仍 ok=true（RL 推理照常，不是整体跳过）', riOff.ok === true && riOff.skipped === false, J({ ok: riOff.ok, skipped: riOff.skipped }));
  check('runInference(dlEnabled:false) → 不落任何 dl-tableau 边', graph.getGraph().edges.filter((e) => e.inferredVia === 'dl-tableau').length === 0, J(graph.getGraph().edges.filter((e) => e.inferredVia === 'dl-tableau').length));
  check('runInference(dlEnabled:false) → meta.lastStats.dl.ran=false', graph.getReasonState(PID).meta.lastStats.dl.ran === false, J(graph.getReasonState(PID).meta.lastStats.dl));
  check('runInference(dlEnabled:false) → skipReasons 含 dl-disabled', graph.getReasonState(PID).meta.lastStats.dl.skipReasons.includes('dl-disabled'), J(graph.getReasonState(PID).meta.lastStats.dl.skipReasons));
  check('runInference 顶层仍恰好 12 字段（T1-d 契约不变）', J(Object.keys(riOff)) === J(['ok', 'skipped', 'inferredEdges', 'bound', 'dropped', 'inconsistencies', 'rounds', 'elapsedMs', 'profiles', 'skippedProfiles', 'perProfile', 'total']), J(Object.keys(riOff)));

  // settings.dlDeep=true → 不传 opts.deep 也做 ABox 深扫（这是「默认深度扫描」开关的全部意义）
  const riDeepS = await graph.runInference({ reasonEnabled: true, dlDeep: true }, {});
  check('settings.dlDeep=true → 未传 opts.deep 也触发 ABox 深扫', findPid(riDeepS).dl.dlInferred >= 1, J(findPid(riDeepS).dl));
  const riShallowS = await graph.runInference({ reasonEnabled: true }, {});
  check('settings.dlDeep 缺省 → 仍只做 TBox（dlInferred=0）', findPid(riShallowS).dl.dlInferred === 0 && findPid(riShallowS).dl.ran === true, J(findPid(riShallowS).dl));
  check('opts.deep 显式值优先于 settings.dlDeep（按钮单次覆盖）', (await graph.runInference({ reasonEnabled: true, dlDeep: true }, { deep: false })).perProfile.find((p) => p.profileId === PID).dl.dlInferred === 0);
  // settings.dlMaxEdges → 不传 opts.maxDlEdges 时也限额
  const riEdgeS = await graph.runInference({ reasonEnabled: true, dlDeep: true, dlMaxEdges: 1 }, {});
  check('settings.dlMaxEdges=1 → 未传 opts.maxDlEdges 也限额（≤1）', findPid(riEdgeS).dl.dlInferred <= 1, J(findPid(riEdgeS).dl));
  const riEdge0 = await graph.runInference({ reasonEnabled: true, dlDeep: true, dlMaxEdges: 0 }, {});
  check('settings.dlMaxEdges=0 → 一条 DL 边都不落（0 是合法上限）', findPid(riEdge0).dl.dlInferred === 0 && findPid(riEdge0).dl.ran === true, J(findPid(riEdge0).dl));
  // settings.dlAboxBudget=0 → 门控在 runInference 里也生效（深扫无 ABox 可用）
  const riNoAbox = await graph.runInference({ reasonEnabled: true, dlDeep: true, dlAboxBudget: 0 }, {});
  check('settings.dlAboxBudget=0 → DL 仍做 TBox 判定但深扫无产出', findPid(riNoAbox).dl.ran === true && findPid(riNoAbox).dl.dlInferred === 0, J(findPid(riNoAbox).dl));
  check('settings.dlAboxBudget=0 → 不落任何 dl-tableau 边', graph.getGraph().edges.filter((e) => e.inferredVia === 'dl-tableau').length === 0, J(graph.getGraph().edges.filter((e) => e.inferredVia === 'dl-tableau').length));
  check('opts.limits 优先于 settings（调用方可再覆盖：预算恢复后深扫重新产出）', findPid(await graph.runInference({ reasonEnabled: true, dlDeep: true, dlAboxBudget: 0 }, { limits: { aboxBudget: 20000 } })).dl.dlInferred >= 1, J(findPid(await graph.runInference({ reasonEnabled: true, dlDeep: true, dlAboxBudget: 0 }, { limits: { aboxBudget: 20000 } })).dl));

  // --- 三个交互探针在 DL 关闭时统一返回 dl-disabled ---
  const settingsMod = require('../src/main/common/settings');
  settingsMod.saveSettings({ dlEnabled: false });
  check('kv 落盘后 dlEnabled(readSettingsSafe) 生效', graph.dlEnabled(settingsMod.getSettings()) === false, J(settingsMod.getSettings().dlEnabled));
  const hOff = graph.dlHierarchy(PID);
  check('DL 关闭 → dlHierarchy 返回 dl-disabled', hOff.ok === false && hOff.reason === 'dl-disabled' && hOff.profileId === PID, J(hOff));
  check('DL 关闭 → dlHierarchy 失败形态仍九字段（契约不变）', J(Object.keys(hOff)) === J(['ok', 'reason', 'error', 'profileId', 'consistent', 'hierarchy', 'topClasses', 'unsatClasses', 'elapsedMs']), J(Object.keys(hOff)));
  check('DL 关闭 → dlHierarchy 的 consistent/hierarchy 为 null', hOff.consistent === null && hOff.hierarchy === null, J(hOff));
  const qOff = graph.dlQuery(PID, { select: ['?o'], where: [{ objectProperty: 'part_of', subject: nid('p1'), object: '?o' }] });
  check('DL 关闭 → dlQuery 返回 dl-disabled（七字段降级形态）', qOff.ok === false && qOff.reason === 'dl-disabled' && J(Object.keys(qOff)) === J(['ok', 'reason', 'error', 'profileId', 'answers', 'columns', 'isHorn', 'elapsedMs']), J(qOff));
  const eOff = graph.dlEntail(PID, { kind: 'subclassOf', sub: 'Battery', super: 'Part' });
  check('DL 关闭 → dlEntail 返回 dl-disabled + entailed=null', eOff.ok === false && eOff.reason === 'dl-disabled' && eOff.entailed === null, J(eOff));
  check('DL 关闭 → dlRecallFacts 静默返回空（问答退回 BFS）', J(graph.dlRecallFacts(gCfg, [gCfg.nodes[0]], { settings: settingsMod.getSettings(), entityPid: PID })) === J({ facts: [], info: null }), J(graph.dlRecallFacts(gCfg, [gCfg.nodes[0]], { settings: settingsMod.getSettings(), entityPid: PID })));
  check('DL 关闭 → coverage.dl.enabled=false（前端据此置灰区块）', graph.getReasonState(PID).coverage.dl.enabled === false, J(graph.getReasonState(PID).coverage.dl));
  check('DL 关闭 → reasonStatus.coverage.dl.enabled=false（设置页状态行数据源）', graph.reasonStatus().coverage.dl.enabled === false, J(graph.reasonStatus().coverage.dl));
  check('DL 关闭不影响 RL 总开关 reasonStatus().enabled', graph.reasonStatus().enabled === true, J(graph.reasonStatus().enabled));
  const ipcOff = await invoke('graph:dlHierarchy', PID);
  check('IPC 层如实透传 dl-disabled（不吞错、不改码）', ipcOff.ok === false && ipcOff.reason === 'dl-disabled', J(ipcOff));
  settingsMod.saveSettings({});
  check('恢复默认后 dlHierarchy 重新可用', graph.dlHierarchy(PID).ok === true, J(graph.dlHierarchy(PID).reason));
  check('恢复默认后 coverage.dl.enabled=true', graph.getReasonState(PID).coverage.dl.enabled === true);

  // --- SKIP_REASON_TEXT 硬契约：dl-disabled 刻意不进主进程表（15 键不变） ---
  check('SKIP_REASON_TEXT 仍恰好 15 键（dl-disabled 只在前端解释）', Object.keys(graph.SKIP_REASON_TEXT).length === 15, J(Object.keys(graph.SKIP_REASON_TEXT)));
  check('SKIP_REASON_TEXT 不含 dl-disabled', graph.SKIP_REASON_TEXT['dl-disabled'] === undefined);

  // --- 前端契约：设置页控件 / NUM_SETTING_FIELDS / reasonSkipText 三处必须齐 ---
  const fs = require('fs');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf-8');
  check('index.html 有 data-tab="dl" 页签', /data-tab="dl"/.test(html));
  check('index.html 有 data-pane="dl" 面板（否则 switchSettingsTab 会回落 ai）', /class="settings-pane" data-pane="dl"/.test(html));
  check('index.html 有 DL 自动保存指示器（markSettingsSaved 靠它闪现）', /id="settings-autosave-dl"/.test(html));
  const DL_IDS = ['set-dl-enabled', 'set-dl-deep', 'set-dl-status', 'set-dl-maxclasses', 'set-dl-aboxbudget', 'set-dl-transcap', 'set-dl-maxaxioms', 'set-dl-maxedges'];
  check('index.html 含全部 8 个 DL 控件 id', DL_IDS.every((id) => html.includes(`id="${id}"`)), J(DL_IDS.filter((id) => !html.includes(`id="${id}"`))));
  // constants.js 只有一处 window.* 引用（PROVIDER_PRESETS），打桩即可在 Node 里 require
  global.window = { kb: { defaults: {} } };
  const srcConst = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'constants.js'), 'utf-8');
  const NUM_SETTING_FIELDS = new Function(`${srcConst}; return NUM_SETTING_FIELDS;`)();
  delete global.window;
  const DL_FIELDS = { dlMaxClasses: ['set-dl-maxclasses', 10, 20000], dlAboxBudget: ['set-dl-aboxbudget', 0, 100000000], dlTransitiveCap: ['set-dl-transcap', 0, 100000], dlMaxAxioms: ['set-dl-maxaxioms', 0, 100000], dlMaxEdges: ['set-dl-maxedges', 0, 1000000] };
  check('NUM_SETTING_FIELDS 注册了 5 个 DL 数值项（否则填充/保存循环不会处理它们）', Object.keys(DL_FIELDS).every((k) => J(NUM_SETTING_FIELDS[k]) === J(DL_FIELDS[k])), J(Object.keys(NUM_SETTING_FIELDS).filter((k) => /^dl/.test(k))));
  check('NUM_SETTING_FIELDS 的 min/max 与主进程钳制范围逐字一致（防「能填但被静默钳回」）', CLAMP.every(([sk, , min, max]) => NUM_SETTING_FIELDS[sk][1] === min && NUM_SETTING_FIELDS[sk][2] === max), J(CLAMP.map(([sk, , min, max]) => [sk, NUM_SETTING_FIELDS[sk], [min, max]])));
  check('NUM_SETTING_FIELDS 的 DOM id 与 index.html 一致', CLAMP.every(([sk]) => html.includes(`id="${NUM_SETTING_FIELDS[sk][0]}"`)), J(CLAMP.map(([sk]) => NUM_SETTING_FIELDS[sk][0])));
  check('index.html 的 min/max 属性与 NUM_SETTING_FIELDS 一致', CLAMP.every(([sk, , min, max]) => {
    const id = NUM_SETTING_FIELDS[sk][0];
    const m = html.match(new RegExp(`id="${id}"[^>]*`));
    return !!m && m[0].includes(`min="${min}"`) && m[0].includes(`max="${max}"`);
  }), J(CLAMP.map(([sk]) => (html.match(new RegExp(`id="${NUM_SETTING_FIELDS[sk][0]}"[^>]*`)) || [''])[0])));
  const srcGraphR = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'graph.js'), 'utf-8');
  check('renderer reasonSkipText 含 dl-disabled 文案（前端独立一份，19 码）', /'dl-disabled':\s*'[^']+'/.test(srcGraphR));
  check('renderer 有「修改 DL 配置」深链按钮', srcGraphR.includes('btn-dl-settings') && /switchSettingsTab\('dl'\)/.test(srcGraphR));
  const srcCommon = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'common.js'), 'utf-8');
  check('common.js 填充/保存两处都处理 DL 开关与深度', (srcCommon.match(/set-dl-enabled/g) || []).length >= 2 && (srcCommon.match(/set-dl-deep/g) || []).length >= 2, J({ en: (srcCommon.match(/set-dl-enabled/g) || []).length, deep: (srcCommon.match(/set-dl-deep/g) || []).length }));
  check('common.js 有 fillDlStatusTip 且在 applyReasonAvailability 里重刷', /function fillDlStatusTip/.test(srcCommon) && /fillDlStatusTip\(\);/.test(srcCommon));
  check('保存口径：DL 开关勾选即删键（与 reasonEnabled 同口径）', /if \(dlOn\) delete s\.dlEnabled; else s\.dlEnabled = false;/.test(srcCommon));
  check('保存口径：深度扫描勾选落 true、取消删键', /if \(\$\('set-dl-deep'\)\.checked\) s\.dlDeep = true; else delete s\.dlDeep;/.test(srcCommon));
  // 语料流水线装饰器必须与 extractGraph 同口径，否则「同一批内容走两条路径 DL 结论不一致」
  const srcMerge = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'corpus', 'decorators', 'mergeGraph.js'), 'utf-8');
  check('mergeGraph 装饰器同样透传 DL 配置（三处调用点同口径）', srcMerge.includes('graph.dlLimitsFromSettings(settings)') && srcMerge.includes('graph.dlDeepDefault(settings)') && /dlEnabled: \(settings && settings\.dlEnabled === false\) \? false : undefined/.test(srcMerge));

  summary();
})().catch((e) => { console.error('测试异常终止：', e); process.exit(1); });
