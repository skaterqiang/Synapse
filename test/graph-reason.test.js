'use strict';
// 推理层单元测试：src/main/graph/reason/{bridge,infer,guard,impact,profile,owlImport}.js
// 对照《Synapse×protege-js 融合设计》§3（数据流与桥接）、§4（核心模块设计）、§5.2/§5.3（写入策略与级联清理）
// 以及 §9 风险 2/风险 4 的降级策略。
//
// ⚠️ 性能红线：OWL 2 RL 传递闭包是超线性的。实测 400 节点传递链会让 materialize() 跑数分钟不返回，
//    且上游 materialize() 是同步的、无法从内部中断（timeoutMs 只在它返回后才检查）。
//    因此除「超时降级」一例外，本文件所有图谱都 ≤ 5 个节点；超时用例用 80 节点链（实测 ~0.9 s）。
const fs = require('fs');
const path = require('path');
const { bootEnv, mkCheck, writeFile, makeTurtle } = require('./helpers/harness');

const { check, section, summary } = mkCheck('推理层核心模块（reason/）');
const J = (v) => JSON.stringify(v);
const sorted = (it) => [...it].sort();

// ---------- 夹具 ----------
const N = (key, name, type, profile = 'bfo-lite') => ({
  id: `${profile}:${key}`, name, type, desc: '', sources: [], domain: '', profile,
});

/** n 节点的单向传递链：n0 →(rel) n1 →(rel) … */
function chainGraph(n, rel = '包含', profile = 'bfo-lite', type = 'object') {
  const nodes = []; const edges = [];
  for (let i = 0; i < n; i++) nodes.push(N('n' + i, 'n' + i, type, profile));
  for (let i = 0; i < n - 1; i++) edges.push({ from: `${profile}:n${i}`, to: `${profile}:n${i + 1}`, rel });
  return { nodes, edges };
}

const TTL_DEFAULT = `@prefix : <http://ex.org/o#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
:Thing a owl:Class ; rdfs:label "事物" .
:Part a owl:Class ; rdfs:label "部件" ; rdfs:subClassOf :Thing .
:Engine a owl:Class ; rdfs:label "发动机" ; rdfs:subClassOf :Part .
:Wheel a owl:Class ; rdfs:label "轮子" ; rdfs:subClassOf :Part .
:hasPart a owl:ObjectProperty ; rdfs:label "有部件" ; rdfs:domain :Thing ; rdfs:range :Part ; a owl:TransitiveProperty .
:partOf a owl:ObjectProperty ; rdfs:label "属于" ; a owl:SymmetricProperty .
:name a owl:DatatypeProperty ; rdfs:label "名称" ; rdfs:domain :Thing .
`;

const OFN = `Prefix(:=<http://ex.org/f#>)
Prefix(owl:=<http://www.w3.org/2002/07/owl#>)
Prefix(rdfs:=<http://www.w3.org/2000/01/rdf-schema#>)
Ontology(<http://ex.org/f>
Declaration(Class(:Device))
Declaration(Class(:Pump))
Declaration(ObjectProperty(:feeds))
AnnotationAssertion(rdfs:label :Device "设备")
AnnotationAssertion(rdfs:label :Pump "泵")
AnnotationAssertion(rdfs:label :feeds "输送")
SubClassOf(:Pump :Device)
ObjectPropertyDomain(:feeds :Device)
ObjectPropertyRange(:feeds :Device)
TransitiveObjectProperty(:feeds)
)
`;

const OMN = `Prefix: : <http://ex.org/m#>
Ontology: <http://ex.org/m>
Class: Device
    Label: "设备"
Class: Pump
    SubClassOf: Device
ObjectProperty: feeds
    Domain: Device
    Range: Device
    Characteristics: Transitive
`;

/** 触发 RL 违规的 OWL 2 Full 片段（ObjectUnionOf 在 subclass 位、ObjectComplementOf 在 superclass 位） */
const NON_RL_OFN = `Prefix(:=<http://ex.org/nrl#>)
Prefix(owl:=<http://www.w3.org/2002/07/owl#>)
Ontology(<http://ex.org/nrl>
Declaration(Class(:A))
Declaration(Class(:B))
Declaration(Class(:C))
SubClassOf(ObjectUnionOf(:A :B) :C)
SubClassOf(:A ObjectComplementOf(:B))
)
`;

(async () => {
  const env = await bootEnv({ prefix: 'synapse-reason-', db: false });
  const bridge = require('../src/main/graph/reason/bridge');
  const infer = require('../src/main/graph/reason/infer');
  const guard = require('../src/main/graph/reason/guard');
  const impact = require('../src/main/graph/reason/impact');
  const prof = require('../src/main/graph/reason/profile');
  const owlImport = require('../src/main/graph/reason/owlImport');
  const owlLegacy = require('../src/main/graph/owl');
  const { ONTOLOGY_PROFILES } = require('../src/main/common/constants');

  const BL = ONTOLOGY_PROFILES['bfo-lite'];
  const BFO = ONTOLOGY_PROFILES['bfo'];
  const ISO = ONTOLOGY_PROFILES['iso15926'];
  const RO_CORE = path.join(env.repoRoot, 'node_modules', '@skaterqiang', 'protege-js', 'sample', 'ontologies', 'ro-core.owl');

  // ======================================================================
  section('§4.1 bridge：IRI 与字面量工具');
  // ======================================================================
  check('SYN_BASE 为合成命名空间', bridge.SYN_BASE === 'https://synapse.local/');
  check('SYN_PROFILE 为体系标注谓词', bridge.SYN_PROFILE === 'https://synapse.local/profile');
  check('RDFS_LABEL 取自 protege-js 的 NS 常量', bridge.RDFS_LABEL === bridge.NS.RDFS + 'label', bridge.RDFS_LABEL);
  check('iriId 对中文节点 ID 做百分号编码', bridge.iriId('bfo-lite:变压器') === 'https://synapse.local/id/bfo-lite%3A%E5%8F%98%E5%8E%8B%E5%99%A8', bridge.iriId('bfo-lite:变压器'));
  check('iriId/dec 往返无损', bridge.dec(bridge.iriId('bfo-lite:变压器').slice(bridge.PREFIX_ID.length)) === 'bfo-lite:变压器');
  check('iriType 指向 type 命名空间', bridge.iriType('object') === 'https://synapse.local/type/object');
  check('iriRel 指向 rel 命名空间并编码中文', bridge.iriRel('包含') === 'https://synapse.local/rel/%E5%8C%85%E5%90%AB');
  check('dec 对非法百分号序列返回原串而不抛', bridge.dec('%E0%A4%A') === '%E0%A4%A');
  check('enc(null) 归一为空串', bridge.enc(null) === '');
  check('edgeKey 顺序为 from|to|rel（与 graph.js 一致）', bridge.edgeKey('a', 'b', '包含') === 'a|b|包含');
  check('safeLiteral 转义双引号并附 xsd:string', bridge.safeLiteral('a"b') === '"a\\"b"^^<http://www.w3.org/2001/XMLSchema#string>', bridge.safeLiteral('a"b'));
  check('safeLiteral 把换行压成空格（防三元组串裂行）', bridge.safeLiteral('a\nb') === '"a b"^^<http://www.w3.org/2001/XMLSchema#string>');
  check('safeLiteral(null) 不抛', bridge.safeLiteral(null) === '""^^<http://www.w3.org/2001/XMLSchema#string>');
  check('FEATURE_IRI 覆盖 6 种可实现特征', sorted(Object.keys(bridge.FEATURE_IRI)).join(',') === 'asymmetric,functional,inverseFunctional,irreflexive,symmetric,transitive');
  check('FEATURE_IRI 的值为 protege-js 的 C 常量', bridge.FEATURE_IRI.transitive === bridge.C.TransitiveProperty);
  check('AXIOM_TO_FEATURE 覆盖 7 种特性公理', Object.keys(bridge.AXIOM_TO_FEATURE).length === 7);
  check('AXIOM_TO_FEATURE 显式把 ReflexiveProperty 映射为 null（上游无对应规则）', bridge.AXIOM_TO_FEATURE.ReflexiveProperty === null);
  check('bridge 转出 TripleStore/NS/P/C 供调用方复用', !!bridge.TripleStore && !!bridge.NS && !!bridge.P && !!bridge.C);

  // ======================================================================
  section('§3.2/§4.1 normalizeProfile：三个内置体系');
  // ======================================================================
  const mBL = bridge.normalizeProfile(BL);
  check('bfo-lite 的传递谓词来自 axioms 而非 features 字段', sorted(mBL.transitive).join(',') === '包含', J(sorted(mBL.transitive)));
  check('bfo-lite 的对称谓词为「相关」', sorted(mBL.symmetric).join(',') === '相关');
  check('bfo-lite 无互逆谓词', mBL.inverseOf.size === 0);
  check('bfo-lite 无 domain/range 声明（护栏覆盖率 0）', mBL.domain.size === 0 && mBL.range.size === 0);
  check('bfo-lite 收集 3 组不相交类', mBL.disjoint.length === 3 && J(mBL.disjoint[0]) === '["continuant","occurrent"]');
  check('bfo-lite 收集 2 条 SubClassOf 公理', J(mBL.subClassOf) === '[["role","realizable"],["function","realizable"]]');
  check('parentsOf 由 classes[].parent 建立', sorted(mBL.parentsOf.get('object')).join(',') === 'continuant');
  check('ancestorsOf 是函数而非 Map', typeof mBL.ancestorsOf === 'function');
  check('ancestorsOf 含自身并回溯到顶层', sorted(mBL.ancestorsOf('object')).join(',') === 'continuant,object,thing');
  check('ancestorsOf 跨多级（role→realizable→continuant→thing）', sorted(mBL.ancestorsOf('role')).join(',') === 'continuant,realizable,role,thing');
  check('features 合并了 axioms 里的非对称声明', sorted(mBL.features.get('矛盾于')).join(',') === 'asymmetric');
  check('fallbackType/fallbackRel 透传', mBL.fallbackType === 'object' && mBL.fallbackRel === '相关');

  const mBFO = bridge.normalizeProfile(BFO);
  check('bfo 的传递谓词有 4 个（来自 features 字段）', mBFO.transitive.size === 4 && sorted(mBFO.transitive).join(',') === 'has_part,located_in,part_of,precedes');
  check('bfo 的互逆谓词对称闭包（part_of⇄has_part、inheres_in⇄bearer_of）', mBFO.inverseOf.size === 4 && sorted(mBFO.inverseOf.get('part_of')).join(',') === 'has_part' && sorted(mBFO.inverseOf.get('bearer_of')).join(',') === 'inheres_in');
  check('bfo 的 PropertyDomain 公理进入 domain 表', sorted(mBFO.domain.get('inheres_in')).join(',') === 'specifically_dependent_continuant' && sorted(mBFO.domain.get('participates_in')).join(',') === 'continuant');
  check('bfo 的 PropertyRange 公理进入 range 表', sorted(mBFO.range.get('inheres_in')).join(',') === 'independent_continuant' && sorted(mBFO.range.get('participates_in')).join(',') === 'occurrent');
  check('bfo 收集 4 组不相交类', mBFO.disjoint.length === 4);

  const mISO = bridge.normalizeProfile(ISO);
  check('iso15926 的 composedOf 只有公理、无 features 字段，仍被识别为传递', mISO.transitive.has('composedOf'), J(sorted(mISO.transitive)));
  check('iso15926 共 6 个传递谓词', mISO.transitive.size === 6);
  check('iso15926 共 2 个对称谓词', sorted(mISO.symmetric).join(',') === 'connectedTo,relatedTo');
  check('iso15926 的 classifiedBy 有 domain/range', sorted(mISO.domain.get('classifiedBy')).join(',') === 'possible_individual' && sorted(mISO.range.get('classifiedBy')).join(',') === 'class_of_individual');

  // ======================================================================
  section('§4.1 normalizeProfile：owl.js 字段式 domain/range（含 BUG 12 回归）');
  // ======================================================================
  const fieldStr = {
    id: 'owl:s', name: 's',
    classes: [{ key: 'Thing', label: '事物' }, { key: 'Part', label: '部件', parent: 'Thing' }],
    predicates: [{ key: 'hasPart', label: '有部件', domain: 'Thing', range: 'Part', features: ['transitive'] }],
    axioms: [], constraints: [],
  };
  const mStr = bridge.normalizeProfile(fieldStr);
  check('字符串 domain 被包装成 Set', mStr.domain.get('hasPart') instanceof Set && sorted(mStr.domain.get('hasPart')).join(',') === 'Thing');
  check('字符串 range 被包装成 Set', sorted(mStr.range.get('hasPart')).join(',') === 'Part');
  check('字段式 features 数组被采纳', sorted(mStr.features.get('hasPart')).join(',') === 'transitive');

  // ⚠️ BUG 12 回归：数组形式的 domain/range 必须被摊平。
  // 修复前 Set 里存的是数组对象，护栏拿它跟字符串祖先集比对必然失配，
  // 表现为 expected:[["Thing"]] 且所有边都被误判 domain-violation。
  const fieldArr = {
    id: 'owl:a', name: 'a',
    classes: [{ key: 'Thing', label: '事物' }, { key: 'Part', label: '部件', parent: 'Thing' }],
    predicates: [{ key: 'hasPart', label: '有部件', domain: ['Thing'], range: ['Part'] }],
    axioms: [], constraints: [],
  };
  guard.clearCache();
  const mArr = bridge.normalizeProfile(fieldArr);
  check('【BUG 12】数组 domain 被摊平为字符串集合（而非嵌套数组）', J(sorted(mArr.domain.get('hasPart'))) === '["Thing"]', J(sorted(mArr.domain.get('hasPart'))));
  check('【BUG 12】数组 range 被摊平为字符串集合', J(sorted(mArr.range.get('hasPart'))) === '["Part"]');
  check('【BUG 12】coverage 输出的 domain 是扁平字符串数组', J(guard.coverage(fieldArr).detail[0].domain) === '["Thing"]', J(guard.coverage(fieldArr).detail));
  check('【BUG 12】合法连线不再被误判', guard.checkEdge(fieldArr, { name: 'a', type: 'Thing' }, 'hasPart', { name: 'b', type: 'Part' }).ok === true);
  check('【BUG 12】expected 为扁平数组', J(guard.checkEdge(fieldArr, { name: 'a', type: 'Thing' }, 'hasPart', { name: 'b', type: 'Thing' }).expected) === '["Part"]');

  const junk = {
    id: 'owl:j', name: 'j',
    classes: [{ key: 'X', label: 'X' }],
    predicates: [{ key: 'r', label: 'r', domain: ['X', null, 42, ['nested']], range: 'X' }],
    axioms: [], constraints: [],
  };
  guard.clearCache();
  const mJunk = bridge.normalizeProfile(junk);
  check('domain 数组里的 null/数字/嵌套数组被丢弃', J(sorted(mJunk.domain.get('r'))) === '["X"]', J(sorted(mJunk.domain.get('r'))));
  check('脏 domain 不影响合法连线判定', guard.checkEdge(junk, { name: 'a', type: 'X' }, 'r', { name: 'b', type: 'X' }).ok === true);
  check('normalizeProfile(null) 返回空模型而不抛', (() => { const z = bridge.normalizeProfile(null); return z.id === '' && z.classes.length === 0 && z.transitive.size === 0 && z.fallbackRel === ''; })());
  check('normalizeProfile({}) 返回空模型而不抛', bridge.normalizeProfile({}).classes.length === 0);

  // ======================================================================
  section('§3.2 normalizeProfile：公理类型覆盖');
  // ======================================================================
  const axProf = {
    id: 'ax', name: 'ax', fallbackType: 'A', fallbackRel: 'r',
    classes: [{ key: 'A', label: 'A' }, { key: 'B', label: 'B' }],
    predicates: [{ key: 'r', label: 'r' }, { key: 'r2', label: 'r2' }],
    axioms: [
      { type: 'EquivalentClasses', subject: 'A', object: 'B' },
      { type: 'SubPropertyOf', subject: 'r', object: 'r2' },
      { type: 'EquivalentProperties', subject: 'r', object: 'r2' },
      { type: 'ReflexiveProperty', subject: 'r' },
      { type: 'FunctionalProperty', subject: 'r' },
      { type: 'InverseFunctionalProperty', subject: 'r' },
      { type: 'IrreflexiveProperty', subject: 'r' },
      { type: 'Bogus', subject: 'r' },
    ],
    constraints: [],
  };
  const mAx = bridge.normalizeProfile(axProf);
  check('EquivalentClasses 记入 equivalentClasses', J(mAx.equivalentClasses) === '[["A","B"]]');
  check('EquivalentClasses 双向加入 parentsOf', sorted(mAx.parentsOf.get('A')).join(',') === 'B' && sorted(mAx.parentsOf.get('B')).join(',') === 'A');
  check('Functional/InverseFunctional/Irreflexive 转为特征', sorted(mAx.features.get('r')).join(',') === 'functional,inverseFunctional,irreflexive', J(sorted(mAx.features.get('r'))));
  check('ReflexiveProperty 与未知公理类型被安全忽略', !mAx.features.get('r').has('reflexive'));
  check('SubPropertyOf/EquivalentProperties 不进 subClassOf', mAx.subClassOf.length === 0);
  const gtAx = bridge.graphToTriples({ nodes: [{ id: 'ax:x', name: 'x', type: 'A', profile: 'ax' }], edges: [] }, axProf, {});
  check('SubPropertyOf 写成 rdfs:subPropertyOf 三元组', gtAx.store.has(bridge.iriRel('r'), bridge.P.subPropertyOf, bridge.iriRel('r2')));
  check('EquivalentProperties 写成 owl:equivalentProperty 三元组', gtAx.store.has(bridge.iriRel('r'), bridge.P.equivalentProperty, bridge.iriRel('r2')));
  check('EquivalentClasses 写成 owl:equivalentClass 三元组', gtAx.store.has(bridge.iriType('A'), bridge.P.equivalentClass, bridge.iriType('B')));
  check('FunctionalProperty 写成 rdf:type owl:FunctionalProperty', gtAx.store.has(bridge.iriRel('r'), bridge.P.type, bridge.C.FunctionalProperty));
  check('ReflexiveProperty 不产生任何三元组（上游无此概念）', gtAx.store.all().filter((t) => /Reflexive/.test(t[1]) && !/Irreflexive/.test(t[1])).length === 0);

  // ======================================================================
  section('§3.1 graphToTriples：图谱 → TripleStore');
  // ======================================================================
  const g3 = chainGraph(3);
  const gt = bridge.graphToTriples(g3, BL, {});
  check('stats 计数完整（3 节点/2 边/11 类/8 谓词/46 三元组）', J(gt.stats) === '{"nodes":3,"edges":2,"skippedEdges":0,"staleInferred":0,"classes":11,"predicates":8,"triples":46}', J(gt.stats));
  check('每个体系类都声明为 owl:Class（触发 scm-cls→scm-sco 的前提）', gt.store.has(bridge.iriType('object'), bridge.P.type, bridge.C.Class));
  check('每个体系谓词都声明为 owl:ObjectProperty（触发 scm-op 的前提）', gt.store.has(bridge.iriRel('包含'), bridge.P.type, bridge.C.ObjectProperty));
  check('传递特征写成 rdf:type owl:TransitiveProperty', gt.store.has(bridge.iriRel('包含'), bridge.P.type, bridge.C.TransitiveProperty));
  check('对称特征写成 rdf:type owl:SymmetricProperty', gt.store.has(bridge.iriRel('相关'), bridge.P.type, bridge.C.SymmetricProperty));
  check('类层级写成 rdfs:subClassOf', gt.store.has(bridge.iriType('object'), bridge.P.subClassOf, bridge.iriType('continuant')));
  check('不相交类写成 owl:disjointWith', gt.store.has(bridge.iriType('continuant'), bridge.P.disjointWith, bridge.iriType('occurrent')));
  check('节点写成 rdf:type 体系类', J(gt.store.objects(bridge.iriId('bfo-lite:n0'), bridge.P.type)) === J([bridge.iriType('object')]));
  check('节点带 rdfs:label 注解', gt.store.objects(bridge.iriId('bfo-lite:n0'), bridge.RDFS_LABEL)[0].includes('n0'));
  check('节点带 synapse:profile 注解', gt.store.objects(bridge.iriId('bfo-lite:n0'), bridge.SYN_PROFILE)[0].includes('bfo-lite'));
  check('边写成 主体-谓词-客体 三元组', gt.store.has(bridge.iriId('bfo-lite:n0'), bridge.iriRel('包含'), bridge.iriId('bfo-lite:n1')));
  check('ctx 带 edgeIndex/originals/adjByRel/model', !!gt.ctx.edgeIndex && !!gt.ctx.originals && !!gt.ctx.adjByRel && !!gt.ctx.model);
  check('ctx.originals 用 from|to|rel 作键', gt.ctx.originals.has('bfo-lite:n0|bfo-lite:n1|包含'));
  check('ctx.nodeNameById 供 humanizeIris 反查', gt.ctx.nodeNameById.get('bfo-lite:n0') === 'n0');

  check('annotations:false 少 6 条三元组（3 节点 × label+profile）', bridge.graphToTriples(g3, BL, { annotations: false }).stats.triples === 40);
  const gStale = { nodes: g3.nodes, edges: [...g3.edges, { from: 'bfo-lite:n0', to: 'bfo-lite:n2', rel: '包含', inferred: true }] };
  const gtStale = bridge.graphToTriples(gStale, BL, {});
  check('旧推理边不参与桥接（staleInferred 计数）', gtStale.stats.staleInferred === 1 && gtStale.stats.edges === 2);
  const gDangle = { nodes: g3.nodes, edges: [...g3.edges, { from: 'bfo-lite:n0', to: 'bfo-lite:ghost', rel: '包含' }] };
  const gtDangle = bridge.graphToTriples(gDangle, BL, {});
  check('端点缺失的边被跳过（skippedEdges 计数）', gtDangle.stats.skippedEdges === 1 && gtDangle.stats.edges === 2);

  // ======================================================================
  section('§4.1 findPath / justify / humanizeIris');
  // ======================================================================
  check('findPath 返回最短边键路径', J(bridge.findPath(gt.ctx.adjByRel.get('包含'), 'bfo-lite:n0', 'bfo-lite:n2', '包含')) === '["bfo-lite:n0|bfo-lite:n1|包含","bfo-lite:n1|bfo-lite:n2|包含"]');
  check('findPath 自身到自身返回 null', bridge.findPath(gt.ctx.adjByRel.get('包含'), 'bfo-lite:n0', 'bfo-lite:n0', '包含') === null);
  check('findPath 对不存在的起点返回 null', bridge.findPath(gt.ctx.adjByRel.get('包含'), 'bfo-lite:ghost', 'bfo-lite:n2', '包含') === null);
  const jT = bridge.justify('bfo-lite:n0', 'bfo-lite:n2', '包含', gt.ctx, new Map());
  check('justify 把传递闭包归因到 prp-trp', jT.via === 'transitive' && jT.keys.length === 2, J(jT));
  check('justify 对无依据的连线返回 unknown', J(bridge.justify('bfo-lite:n0', 'bfo-lite:n2', '相关', gt.ctx, new Map())) === '{"keys":[],"via":"unknown"}');
  check('humanizeIris 把 id/type/rel 三类 IRI 换成人话', bridge.humanizeIris(`${bridge.iriId('bfo-lite:n0')} ${bridge.iriType('object')} ${bridge.iriRel('包含')}`, gt.ctx) === 'n0 物体 包含', bridge.humanizeIris(`${bridge.iriId('bfo-lite:n0')} ${bridge.iriType('object')} ${bridge.iriRel('包含')}`, gt.ctx));
  check('humanizeIris 对未知节点回退为节点 ID', bridge.humanizeIris(bridge.iriId('bfo-lite:zzz'), gt.ctx) === 'bfo-lite:zzz');
  check('humanizeIris 不动非 synapse 命名空间的 IRI', bridge.humanizeIris('http://example.org/x 保持原样', gt.ctx) === 'http://example.org/x 保持原样');
  check('humanizeIris 容忍 null 文本与 null ctx', bridge.humanizeIris(null, gt.ctx) === '' && bridge.humanizeIris('x', null) === 'x');

  // ======================================================================
  section('§4.2 materializeGraph：传递 / 对称 / 互逆');
  // ======================================================================
  const matT = await infer.materializeGraph(g3, BL, {});
  check('传递链未被跳过', matT.skipped === false);
  check('stats 13 个字段齐全（elapsedMs 除外）', (() => {
    const { elapsedMs, ...rest } = matT.stats;
    return J(rest) === '{"inputTriples":2,"inputNodes":3,"skippedEdges":0,"staleInferred":0,"classes":11,"predicates":8,"triplesBefore":46,"triplesAfter":305,"inferredCount":259,"inferredEdges":1,"unjustified":0,"rounds":3}';
  })(), J(matT.stats));
  check('成功结果的字段名是 inferredEdges（不是 edges）', Array.isArray(matT.inferredEdges) && matT.edges === undefined);
  check('传递闭包只回收 1 条图内新边（n0→n2）', matT.inferredEdges.length === 1 && matT.inferredEdges[0].from === 'bfo-lite:n0' && matT.inferredEdges[0].to === 'bfo-lite:n2');
  check('推理边带完整溯源字段', (() => {
    const e = matT.inferredEdges[0];
    return e.inferred === true && e.inferredVia === 'transitive' && e.inferredBy === 'owl2rl'
      && J(e.inferredFromKeys) === '["bfo-lite:n0|bfo-lite:n1|包含","bfo-lite:n1|bfo-lite:n2|包含"]'
      && Number(e.inferredAt) > 0;
  })(), J(matT.inferredEdges[0]));
  check('无冲突时 inconsistencies 为空数组', J(matT.inconsistencies) === '[]');
  check('返回 ReasonerQueries 与 ctx 供上层查询', !!matT.queries && !!matT.ctx);

  const gSym = { nodes: [N('a', '甲', 'object'), N('b', '乙', 'object')], edges: [{ from: 'bfo-lite:a', to: 'bfo-lite:b', rel: '相关' }] };
  const matS = await infer.materializeGraph(gSym, BL, {});
  check('对称谓词推出反向边', matS.inferredEdges.length === 1 && matS.inferredEdges[0].from === 'bfo-lite:b' && matS.inferredEdges[0].to === 'bfo-lite:a' && matS.inferredEdges[0].inferredVia === 'symmetric', J(matS.inferredEdges));

  const gInv = {
    nodes: [N('轮子', '轮子', 'material_entity', 'bfo'), N('汽车', '汽车', 'material_entity', 'bfo')],
    edges: [{ from: 'bfo:轮子', to: 'bfo:汽车', rel: 'part_of' }],
  };
  const matI = await infer.materializeGraph(gInv, BFO, {});
  check('互逆谓词推出 has_part 反向边', matI.inferredEdges.length === 1 && matI.inferredEdges[0].rel === 'has_part' && matI.inferredEdges[0].inferredVia === 'inverse', J(matI.inferredEdges));
  check('互逆推理的溯源指向原始 part_of 边', J(matI.inferredEdges[0].inferredFromKeys) === '["bfo:轮子|bfo:汽车|part_of"]');

  // §3.1 反向验证：类层级推理（cax-sco）确实把类型向上传播
  const q = matT.queries;
  check('queries.getTypes 反映 cax-sco 的类型传播（object→continuant→thing→owl:Thing）', sorted(q.getTypes(bridge.iriId('bfo-lite:n0')).map((x) => x.split('#').pop().split('/').pop())).join(',') === 'Thing,continuant,object,thing', J(q.getTypes(bridge.iriId('bfo-lite:n0'))));
  check('queries.getInstances 列出该类的所有节点', q.getInstances(bridge.iriType('object')).length === 3);
  check('queries.isSubClassOf 认得类层级', q.isSubClassOf(bridge.iriType('object'), bridge.iriType('continuant')) === true);
  check('queries.getObjectPropertyValues 含推理出的边', q.getObjectPropertyValues(bridge.iriId('bfo-lite:n0'), bridge.iriRel('包含')).length === 2);

  // ======================================================================
  section('§4.2/§9 风险 2 materializeGraph：skipReason 全路径');
  // ======================================================================
  check('reasonerAvailable() 为真', infer.reasonerAvailable() === true);
  check('DEFAULT_MAX_ROUNDS = 1000', infer.DEFAULT_MAX_ROUNDS === 1000);
  check('PROGRESS_HINT_EDGES = 20000', infer.PROGRESS_HINT_EDGES === 20000);
  const sk = async (g, p, o) => (await infer.materializeGraph(g, p, o)).skipReason;
  check('graph 为 null → empty-graph', (await sk(null, BL, {})) === 'empty-graph');
  check('nodes 为空数组 → empty-graph', (await sk({ nodes: [], edges: [] }, BL, {})) === 'empty-graph');
  // 缺 edges 字段：bridge 按 0 条边处理，但 BL 体系自带传递/对称/domain 等「规则燃料」，
  // 所以不会走 no-rule-fuel 分支，而是正常物化（只是推不出新边）。
  const noEdgesRes = await infer.materializeGraph({ nodes: g3.nodes }, BL, {});
  check('缺 edges 字段但有节点 → 不抛、正常完成且无推理边', noEdgesRes.skipped === false && noEdgesRes.skipReason === undefined && noEdgesRes.inferredEdges.length === 0, J({ s: noEdgesRes.skipped, r: noEdgesRes.skipReason, n: noEdgesRes.inferredEdges.length }));
  check('edges 为 null 同样按 0 条边处理（不抛）', (await infer.materializeGraph({ nodes: g3.nodes, edges: null }, BL, {})).skipped === false);
  check('profile 为 null → no-rule-fuel', (await sk(g3, null, {})) === 'no-rule-fuel');
  check('profile 为 undefined → no-rule-fuel', (await sk(g3, undefined, {})) === 'no-rule-fuel');
  const noFuel = { id: 'nf', name: 'nf', classes: [{ key: 'object', label: 'o' }], predicates: [{ key: '包含', label: '包含' }], axioms: [], constraints: [] };
  check('体系无任何可触发规则的公理 → no-rule-fuel', (await sk(g3, noFuel, {})) === 'no-rule-fuel');
  const nfRes = await infer.materializeGraph(g3, noFuel, {});
  check('no-rule-fuel 仍返回 ctx 与 stats（供上层解释）', !!nfRes.ctx && nfRes.stats.triples > 0 && J(nfRes.inferredEdges) === '[]');
  const ac = new AbortController(); ac.abort();
  check('已中止的 signal → aborted', (await sk(g3, BL, { signal: ac.signal })) === 'aborted');
  const abRes = await infer.materializeGraph(g3, BL, { signal: ac.signal });
  check('aborted 时不产生任何推理边', abRes.inferredEdges.length === 0 && abRes.skipped === true);

  // 超时降级：timeoutMs 被夹到 [100, 600000]，所以必须用足够大的图才能真的超时。
  // 80 节点传递链实测 ~0.9 s，对 100 ms 下限有 8 倍余量。
  const gBig = chainGraph(80);
  const matTO = await infer.materializeGraph(gBig, BL, { timeoutMs: 100 });
  check('超时后 skipped=true 且 skipReason=timeout', matTO.skipped === true && matTO.skipReason === 'timeout', J({ s: matTO.skipped, r: matTO.skipReason, ms: matTO.stats && matT.stats.elapsedMs }));
  check('超时后丢弃全部推理边（保留原始图谱，§9 风险 2）', matTO.inferredEdges.length === 0 && matTO.queries === null);
  check('超时结果仍带 stats.inferredCount 供 UI 解释「推了多少但被丢弃」', matTO.stats.inferredCount > 0 && matTO.stats.rounds > 0, J(matTO.stats));
  check('超时结果仍带 ctx（可解释来源）', !!matTO.ctx);
  const matOK = await infer.materializeGraph(gBig, BL, { timeoutMs: 600000 });
  check('同一图谱放大超时后正常完成（证明跳过确由超时触发）', matOK.skipped === false && matOK.inferredEdges.length > 1000, J({ s: matOK.skipped, n: matOK.inferredEdges.length }));

  // ======================================================================
  section('§4.2 materializeGraph：opts 语义');
  // ======================================================================
  check('maxRounds=1 时只跑 1 轮', (await infer.materializeGraph(g3, BL, { maxRounds: 1 })).stats.rounds === 1);
  check('maxRounds=0 被夹到下限 1', (await infer.materializeGraph(g3, BL, { maxRounds: 0 })).stats.rounds === 1);
  check('maxRounds 极大值不影响收敛轮数（3 轮）', (await infer.materializeGraph(g3, BL, { maxRounds: 999999 })).stats.rounds === 3);
  check('timeoutMs=1 被夹到下限 100，小图不会误判超时', (await infer.materializeGraph(g3, BL, { timeoutMs: 1 })).skipped === false);
  const phases = [];
  await infer.materializeGraph(g3, BL, { onProgress: (i) => phases.push(i.phase) });
  check('onProgress 依次报告 桥接/物化/回收 三个阶段', J(phases) === '["桥接图谱为三元组…","物化推理中…","回收推理边…"]', J(phases));
  const phTO = [];
  await infer.materializeGraph(g3, BL, { timeoutMs: 1, onProgress: (i) => phTO.push(i.phase) });
  check('onProgress 回调抛错不会拖死推理', (await infer.materializeGraph(g3, BL, { onProgress: () => { throw new Error('boom'); } })).skipped === false);
  check('reasonerId 透传到推理边的 inferredBy', (await infer.materializeGraph(g3, BL, { reasonerId: 'custom-rl' })).inferredEdges[0].inferredBy === 'custom-rl');
  const matNoAnn = await infer.materializeGraph(g3, BL, { annotations: false });
  check('annotations:false → triplesBefore 40（而非 46），推理结果不变', matNoAnn.stats.triplesBefore === 40 && matNoAnn.inferredEdges.length === 1);
  const phAbort = [];
  await infer.materializeGraph(g3, BL, { signal: ac.signal, onProgress: (i) => phAbort.push(i.phase) });
  check('提前中止时报告到「物化」为止，不进入「回收推理边」阶段', J(phAbort) === '["桥接图谱为三元组…","物化推理中…"]', J(phAbort));
  check('小图（2 条边）不触发大图提示文案', phases.every((p) => !/可能需要数秒/.test(p)), J(phases));
  // 大图提示：stats.edges 按输入边计数（store 会去重相同三元组），
  // 用 20000 条重复边即可越过 PROGRESS_HINT_EDGES 阈值而不拖慢物化。
  const phBig = [];
  const gHint = chainGraph(2);
  for (let i = 0; i < 20000; i++) gHint.edges.push({ from: 'bfo-lite:n0', to: 'bfo-lite:n1', rel: '包含' });
  await infer.materializeGraph(gHint, BL, { onProgress: (i) => phBig.push(i.phase) });
  check('边数 ≥ PROGRESS_HINT_EDGES 时提示「可能需要数秒」并带上边数', phBig[1] === '物化推理中（20001 条边，可能需要数秒）…', J(phBig));

  // ======================================================================
  section('§4.2 不一致检测与消息还原（绕过上游 materialize 只转发 1 个参数的缺陷）');
  // ======================================================================
  const gAsym = {
    nodes: [N('甲', '甲', 'object'), N('乙', '乙', 'object')],
    edges: [{ from: 'bfo-lite:甲', to: 'bfo-lite:乙', rel: '矛盾于' }, { from: 'bfo-lite:乙', to: 'bfo-lite:甲', rel: '矛盾于' }],
  };
  const matA = await infer.materializeGraph(gAsym, BL, {});
  check('非对称谓词双向断言被识别为冲突', matA.inconsistencies.length === 2, J(matA.inconsistencies));
  check('两条冲突都保留（上游按 (rule,message) 去重，还原后不再塌缩）', matA.inconsistencies.filter((c) => c.rule === 'prp-asyp').length === 2);
  check('冲突 message 已人话化（不含 synapse.local IRI）', matA.inconsistencies.every((c) => !/synapse\.local/.test(c.message)) && matA.inconsistencies.some((c) => c.message === '甲 矛盾于 乙 and reverse'), J(matA.inconsistencies.map((c) => c.message)));
  check('冲突 raw 保留原始 IRI 供排查', matA.inconsistencies.every((c) => /synapse\.local/.test(c.raw)));
  // ---- 冲突富化：归属知识图谱 + 中文原因（bridge.enrichConflicts）----
  check('冲突带中文摘要 messageZh（不含英文 and reverse）', matA.inconsistencies.every((c) => c.messageZh && /同时存在/.test(c.messageZh) && !/and reverse/.test(c.messageZh)), J(matA.inconsistencies.map((c) => c.messageZh)));
  check('冲突带中文原因 reasonZh（点名非对称谓词公理）', matA.inconsistencies.every((c) => c.reasonZh && /非对称谓词/.test(c.reasonZh)), J(matA.inconsistencies.map((c) => c.reasonZh)));
  check('冲突归属到知识图谱 scope（domain 空 → general → 通用）', matA.inconsistencies.every((c) => Array.isArray(c.scopes) && c.scopes.length === 1 && c.scopes[0].domain === 'general' && c.scopes[0].label === '通用（未匹配领域）' && c.scopeKeys[0] === 'bfo-lite|general'), J(matA.inconsistencies.map((c) => c.scopes)));
  check('冲突带涉及节点名 nodeNames（甲/乙各出现一次）', J(matA.inconsistencies.map((c) => c.nodeNames).sort()) === '[["乙","甲"],["甲","乙"]]' || matA.inconsistencies.every((c) => c.nodeNames.length === 2 && c.nodeNames.includes('甲') && c.nodeNames.includes('乙')), J(matA.inconsistencies.map((c) => c.nodeNames)));
  // scopeLabelOf 注入：domain → 知识图谱显示名
  const gDom = {
    nodes: [Object.assign(N('甲', '甲', 'object'), { domain: 'ev_charger_application' }), Object.assign(N('乙', '乙', 'object'), { domain: 'ev_charger_application' })],
    edges: [{ from: 'bfo-lite:甲', to: 'bfo-lite:乙', rel: '矛盾于' }, { from: 'bfo-lite:乙', to: 'bfo-lite:甲', rel: '矛盾于' }],
  };
  const matD = await infer.materializeGraph(gDom, BL, { scopeLabelOf: () => '充电桩报装' });
  check('scopeLabelOf 注入后 scope.label 用知识图谱显示名', matD.inconsistencies.every((c) => c.scopes[0].label === '充电桩报装' && c.scopes[0].domain === 'ev_charger_application'), J(matD.inconsistencies.map((c) => c.scopes)));
  // conflictChinese 逐规则翻译（与 protege-js owl2rl.js 的 conflict() 消息模板一一对应）
  const zh = (rule, message) => bridge.conflictChinese(rule, message, null);
  check('cax-dw → 中文点名互斥类', /互斥的类/.test(zh('cax-dw', '施工安全规范承诺 in disjoint 可能个体 & 抽象对象').messageZh), J(zh('cax-dw', 'x in disjoint A & B')));
  check('prp-irp → 中文点名反自反', /反自反/.test(zh('prp-irp', '甲 依赖 自身').reasonZh) || /反自反/.test(zh('prp-irp', '甲 依赖 itself').reasonZh), J(zh('prp-irp', '甲 依赖 itself')));
  check('cls-nothing2 → 中文点名空类', /Nothing/.test(zh('cls-nothing2', '甲 typed owl:Nothing').messageZh), J(zh('cls-nothing2', '甲 typed owl:Nothing')));
  check('未知规则兜底：保留原文 + 中文说明触发规则', (() => { const r = zh('no-such-rule', 'weird message'); return r.messageZh === 'weird message' && /no-such-rule/.test(r.reasonZh); })(), J(zh('no-such-rule', 'weird message')));
  check('冲突不影响推理边回收', Array.isArray(matA.inferredEdges));
  const storeA = bridge.graphToTriples(gAsym, BL, {}).store;
  check('recoverInconsistencyMessages 对空冲突返回空数组', J(infer.recoverInconsistencyMessages(storeA, { inconsistencies: [] })) === '[]');
  check('recoverInconsistencyMessages 在 reasoner 为 null 时不抛', J(infer.recoverInconsistencyMessages(storeA, null)) === '[]');
  check('recoverInconsistencyMessages 对未知规则名容错', J(infer.recoverInconsistencyMessages(storeA, { inconsistencies: [{ rule: 'no-such-rule', message: 'm' }] })) === '[{"rule":"no-such-rule","message":"m"}]');

  // ======================================================================
  section('§5.2 mergeInferredEdges：写入策略');
  // ======================================================================
  const rawEdges = g3.edges.slice();
  const mg = infer.mergeInferredEdges(rawEdges, matT.inferredEdges);
  check('合并后边数 = 原始 2 + 推理 1', mg.edges.length === 3);
  check('bound 计数 = 成功绑定溯源下标的推理边数', mg.bound === 1 && mg.dropped === 0);
  check('inferredFromKeys 被翻译成 inferredFrom 下标数组', J(mg.edges[2].inferredFrom) === '[0,1]', J(mg.edges[2]));
  check('推理边保留 inferred/via/at/by 字段', mg.edges[2].inferred === true && mg.edges[2].inferredVia === 'transitive' && mg.edges[2].inferredBy === 'owl2rl');
  check('原始边不被打上 inferred 标记', mg.edges[0].inferred === undefined && mg.edges[1].inferred === undefined);
  check('空推理边列表 → 原样返回', infer.mergeInferredEdges(rawEdges, []).edges.length === 2);
  check('与已有原始边同身份的推理边被丢弃（dropped）', infer.mergeInferredEdges(rawEdges, [{ from: 'bfo-lite:n0', to: 'bfo-lite:n1', rel: '包含', inferred: true, inferredFromKeys: [] }]).dropped === 1);
  check('base 里已存在的旧推理边被过滤掉（不重复累积）', infer.mergeInferredEdges([...rawEdges, { from: 'bfo-lite:x', to: 'bfo-lite:y', rel: '包含', inferred: true }], []).edges.length === 2);
  check('缺 from/to 的畸形推理边被丢弃', infer.mergeInferredEdges(rawEdges, [{ from: null, to: 'b', rel: '包含' }]).dropped === 1);
  check('inferredEdges 为 null 时不抛', infer.mergeInferredEdges(rawEdges, null).edges.length === 2);
  check('rawEdges 为 null 时不抛', infer.mergeInferredEdges(null, []).edges.length === 0);
  check('溯源下标缺失时 bound 不计数但仍写入边', (() => { const r = infer.mergeInferredEdges(rawEdges, [{ from: 'bfo-lite:n0', to: 'bfo-lite:n2', rel: '相关', inferred: true }]); return r.bound === 0 && r.edges.length === 3 && J(r.edges[2].inferredFrom) === '[]'; })());

  // ======================================================================
  section('§5.3 级联清理');
  // ======================================================================
  const merged3 = infer.mergeInferredEdges(rawEdges, matT.inferredEdges).edges;
  const c1 = infer.removeEdgeWithCascade({ edges: merged3.slice() }, 1);
  check('删掉被依赖的原始边会级联删掉推理边', c1.removed === 2 && c1.cascaded === 1 && c1.edges.length === 1, J({ r: c1.removed, c: c1.cascaded, n: c1.edges.length }));
  check('级联后剩下的边不含任何推理边', c1.edges.every((e) => !e.inferred));
  check('下标越界不删任何东西', (() => { const r = infer.removeEdgeWithCascade({ edges: merged3.slice() }, 999); return r.removed === 0 && r.cascaded === 0 && r.edges.length === 3; })());
  check('负下标不删任何东西', infer.removeEdgeWithCascade({ edges: merged3.slice() }, -1).removed === 0);
  check('支持一次传多个下标', (() => { const r = infer.removeEdgeWithCascade({ edges: merged3.slice() }, [0, 1]); return r.removed === 3 && r.cascaded === 1; })());
  check('级联收敛到不动点（多层依赖也只跑一遍循环）', infer.removeEdgeWithCascade({ edges: merged3.slice() }, [0]).removed === 2);
  check('edges 缺失时不抛', infer.removeEdgeWithCascade({}, 0).removed === 0);
  const handBuilt = [
    { from: 'a', to: 'b', rel: '包含' },
    { from: 'a', to: 'c', rel: '包含', inferred: true, inferredFromKeys: ['a|b|包含'] },
  ];
  check('只有 inferredFromKeys（无 inferredFrom）时也能级联', infer.removeEdgeWithCascade({ edges: handBuilt.slice() }, 0).removed === 2);
  check('removeNodeWithCascade 删掉该节点的所有连边', J(infer.removeNodeWithCascade({ edges: merged3.slice() }, 'bfo-lite:n2')) === '{"removed":2,"cascaded":0}', J(infer.removeNodeWithCascade({ edges: merged3.slice() }, 'bfo-lite:n2')));
  check('removeNodeWithCascade 对孤立节点返回 0/0', J(infer.removeNodeWithCascade({ edges: merged3.slice() }, 'nonexistent')) === '{"removed":0,"cascaded":0}');
  const cnt = infer.countInferred({ edges: merged3 });
  check('countInferred 统计 total/inferred/raw/byVia', J(cnt) === '{"total":3,"inferred":1,"raw":2,"byVia":{"transitive":1}}', J(cnt));
  check('countInferred 对空图不抛', infer.countInferred({ edges: [] }).total === 0 && infer.countInferred({}).total === 0);
  const gStrip = { edges: merged3.slice() };
  const st = infer.stripInferred(gStrip);
  check('stripInferred 只留原始边并就地改写 graph.edges', st.removed === 1 && st.edges.length === 2 && gStrip.edges.length === 2);
  check('stripInferred 对无推理边的图返回 removed 0', infer.stripInferred({ edges: rawEdges.slice() }).removed === 0);

  // ======================================================================
  section('§4.3 guard.checkEdge：四类拦截理由');
  // ======================================================================
  guard.clearCache();
  const vUnk = guard.checkEdge(BFO, { name: 'x', type: 'material_entity' }, 'notarel', { name: 'y', type: 'material_entity' });
  check('未知谓词 → unknown-predicate', vUnk.ok === false && vUnk.reason === 'unknown-predicate');
  check('unknown-predicate 的 expected 列出全部 15 个受控谓词', J(vUnk.expected) === '["is_a","instance_of","part_of","has_part","participates_in","has_participant","inheres_in","bearer_of","located_in","occurs_in","precedes","realizes","has_role","derives_from","related_to"]', J(vUnk.expected));
  check('unknown-predicate 带 fallback 与中文 detail', vUnk.fallback === 'related_to' && vUnk.detail === '谓词「notarel」不在体系受控词表中');

  check('无 domain/range 约束的谓词一律放行', guard.checkEdge(BL, { name: 'a', type: 'object' }, '包含', { name: 'b', type: 'object' }).ok === true);
  const vDom = guard.checkEdge(BFO, { name: '过程', type: 'occurrent' }, 'inheres_in', { name: '物质', type: 'material_entity' });
  check('起点类型不满足 domain → domain-violation', vDom.ok === false && vDom.reason === 'domain-violation');
  check('domain-violation 的 expected/actual/fallback 齐全', J(vDom.expected) === '["specifically_dependent_continuant"]' && vDom.actual === 'occurrent' && vDom.fallback === 'related_to');
  check('domain-violation 的 detail 用中文类名解释', vDom.detail === '「过程」的类型 occurrent 不属于 specifically_dependent_continuant 及其子类', vDom.detail);
  const vRng = guard.checkEdge(BFO, { name: '性质', type: 'quality' }, 'inheres_in', { name: '过程', type: 'occurrent' });
  check('终点类型不满足 range → range-violation', vRng.ok === false && vRng.reason === 'range-violation' && J(vRng.expected) === '["independent_continuant"]');
  check('domain/range 都满足 → 放行', guard.checkEdge(BFO, { name: '性质', type: 'quality' }, 'inheres_in', { name: '物质', type: 'material_entity' }).ok === true);
  check('domain 的子类也算满足（祖先闭包）', guard.checkEdge(BFO, { name: '角色', type: 'role' }, 'inheres_in', { name: '物质', type: 'material_entity' }).ok === true);
  const vNoType = guard.checkEdge(BFO, { name: 'x', type: '' }, 'inheres_in', { name: 'y', type: 'material_entity' });
  check('起点无类型时按 domain-violation 处理，actual 标注「(无类型)」', vNoType.ok === false && vNoType.reason === 'domain-violation' && vNoType.actual === '(无类型)');
  check('无类型分支不带 detail 字段', vNoType.detail === undefined);

  // strictUnknownType 是最后一道检查：有 domain/range 约束的谓词上会被前两道掩盖
  check('strictUnknownType 在有 domain 约束时被 domain-violation 掩盖', guard.checkEdge(BFO, { name: 'x', type: 'weird' }, 'inheres_in', { name: 'y', type: 'material_entity' }, { strictUnknownType: true }).reason === 'domain-violation');
  const vUT1 = guard.checkEdge(BL, { name: 'a', type: 'weird' }, '包含', { name: 'b', type: 'object' }, { strictUnknownType: true });
  check('无约束谓词上 strictUnknownType 能暴露起点类型越界', vUT1.ok === false && vUT1.reason === 'unknown-type' && vUT1.actual === 'weird' && vUT1.detail === '起点类型 weird 不在体系类表中', J(vUT1));
  const vUT2 = guard.checkEdge(BL, { name: 'a', type: 'object' }, '包含', { name: 'b', type: 'weird' }, { strictUnknownType: true });
  check('无约束谓词上 strictUnknownType 能暴露终点类型越界', vUT2.reason === 'unknown-type' && vUT2.detail === '终点类型 weird 不在体系类表中');
  check('strictUnknownType 下两端类型都合法则放行', guard.checkEdge(BL, { name: 'a', type: 'object' }, '包含', { name: 'b', type: 'object' }, { strictUnknownType: true }).ok === true);
  check('strictUnknownType 不惩罚「无类型」（留给抽取后的补全流程）', guard.checkEdge(BL, { name: 'a', type: '' }, '包含', { name: 'b', type: '' }, { strictUnknownType: true }).ok === true);
  check('默认（不传 opts）不做类型白名单校验', guard.checkEdge(BL, { name: 'a', type: 'weird' }, '包含', { name: 'b', type: 'weird' }).ok === true);
  check('节点为 null 时不抛', guard.checkEdge(BL, null, '包含', null).ok === true);
  check('谓词为空串按 unknown-predicate 处理', guard.checkEdge(BL, { type: 'object' }, '', { type: 'object' }).reason === 'unknown-predicate');
  check('profile 为 null 时退化为「一切谓词都未知」', guard.checkEdge(null, { type: 'x' }, 'r', { type: 'y' }).reason === 'unknown-predicate');

  // ======================================================================
  section('§4.3 guard：类层级 / 不相交 / 覆盖率');
  // ======================================================================
  guard.clearCache();
  check('isSubClassOf 认得跨级子类', guard.isSubClassOf(BL, 'role', 'continuant') === true);
  check('isSubClassOf 不反向成立', guard.isSubClassOf(BL, 'continuant', 'role') === false);
  check('isSubClassOf 自身到自身为真', guard.isSubClassOf(BL, 'object', 'object') === true);
  check('isSubClassOf 对空参数为假', guard.isSubClassOf(BL, '', 'object') === false && guard.isSubClassOf(null, 'a', 'b') === false);
  check('isKnownClass / isKnownPredicate 白名单判定', guard.isKnownClass(BL, 'object') === true && guard.isKnownClass(BL, 'nope') === false && guard.isKnownPredicate(BL, '包含') === true && guard.isKnownPredicate(BL, 'nope') === false);
  check('isKnownClass(null) 为假而不抛', guard.isKnownClass(null, 'a') === false && guard.isKnownPredicate(null, 'r') === false);
  check('constraintOf 返回 domain/range 数组与 hasAny', J(guard.constraintOf(BFO, 'inheres_in')) === '{"domain":["specifically_dependent_continuant"],"range":["independent_continuant"],"hasAny":true}');
  check('constraintOf 对无约束谓词 hasAny=false', J(guard.constraintOf(BL, '包含')) === '{"domain":[],"range":[],"hasAny":false}');
  check('constraintOf(null) 不抛', J(guard.constraintOf(null, 'r')) === '{"domain":[],"range":[],"hasAny":false}');

  const cyc = {
    id: 'cyc', name: 'cyc',
    classes: [{ key: 'A', label: 'A', parent: 'B' }, { key: 'B', label: 'B', parent: 'A' }],
    predicates: [], axioms: [], constraints: [],
  };
  guard.clearCache();
  check('类层级成环时 isSubClassOf 不死循环', guard.isSubClassOf(cyc, 'A', 'B') === true);
  check('类层级成环时 coverage 仍可计算', guard.coverage(cyc).classCount === 2);

  const d1 = guard.checkDisjoint(BL, 'continuant', 'occurrent');
  check('checkDisjoint 命中直接不相交对', d1.conflict === true && J(d1.pairs) === '[["continuant","occurrent"]]', J(d1));
  check('checkDisjoint 带中文 detail', d1.detail === 'continuant 与 occurrent 分别落入不相交类 continuant / occurrent');
  check('checkDisjoint 命中子类落入的不相交对（object/process → continuant/occurrent）', J(guard.checkDisjoint(BL, 'object', 'process').pairs) === '[["continuant","occurrent"]]');
  check('checkDisjoint 对同侧类型不报冲突', J(guard.checkDisjoint(BL, 'object', 'object')) === '{"conflict":false,"pairs":[]}');
  check('checkDisjoint 对无不相交声明的体系不报冲突', guard.checkDisjoint(noFuel, 'A', 'B').conflict === false);
  check('checkDisjoint(null) 不抛', guard.checkDisjoint(null, 'a', 'b').conflict === false);
  check('checkDisjoint 对空类型不报冲突', guard.checkDisjoint(BL, '', 'occurrent').conflict === false);

  guard.clearCache();
  const covBL = guard.coverage(BL);
  check('bfo-lite 覆盖率 0%（内置体系不带 domain/range）', J({ p: covBL.predicates, d: covBL.withDomain, r: covBL.withRange, a: covBL.withAny, pct: covBL.coveragePct }) === '{"p":8,"d":0,"r":0,"a":0,"pct":0}', J(covBL));
  check('coverage 附带传递/对称/互逆/不相交清单', J(covBL.transitive) === '["包含"]' && J(covBL.symmetric) === '["相关"]' && J(covBL.inversePairs) === '[]' && covBL.disjointPairs.length === 3);
  check('coverage 附带类数与公理数', covBL.classCount === 11 && covBL.axiomCount === 8);
  const covBFO = guard.coverage(BFO);
  check('bfo 覆盖率 13%（15 谓词中 2 个有约束）', covBFO.predicates === 15 && covBFO.withAny === 2 && covBFO.coveragePct === 13, J({ p: covBFO.predicates, a: covBFO.withAny, pct: covBFO.coveragePct }));
  check('bfo 的互逆对以 [键, 数组] 形式输出（Set 已展开，可过 IPC）', J(covBFO.inversePairs[0]) === '["inheres_in",["bearer_of"]]', J(covBFO.inversePairs));
  check('coverage.detail 只列出有约束的谓词', covBFO.detail.length === 2 && covBFO.detail[0].key === 'participates_in');
  const covISO = guard.coverage(ISO);
  check('iso15926 覆盖率 14%', covISO.predicates === 14 && covISO.coveragePct === 14);
  check('iso15926 的 6 个传递谓词含仅由公理声明的 composedOf', covISO.transitive.includes('composedOf') && covISO.transitive.length === 6);
  check('coverage(null) 返回全零而不抛', J(guard.coverage(null)) === '{"profileId":"","predicates":0,"withDomain":0,"withRange":0,"withAny":0,"coveragePct":0,"detail":[],"transitive":[],"symmetric":[],"inversePairs":[],"disjointPairs":[],"classCount":0,"axiomCount":0}');

  // owl.js 遗留路径产出的字段式 profile 也能被 coverage 正确统计
  const legacyProfile = owlLegacy.parseOwlFile(writeFile(path.join(env.dir, 'def.ttl'), TTL_DEFAULT)).profile;
  guard.clearCache();
  const covLegacy = guard.coverage(legacyProfile);
  check('owl.js 字段式 profile 的覆盖率为 50%（2 谓词中 1 个有约束）', covLegacy.predicates === 2 && covLegacy.withAny === 1 && covLegacy.coveragePct === 50, J(covLegacy));
  check('owl.js 字段式 profile 的 domain/range 是扁平字符串数组', J(covLegacy.detail[0].domain) === '["Thing"]' && J(covLegacy.detail[0].range) === '["Part"]');
  check('owl.js 字段式 profile 的传递/对称特征被识别', J(covLegacy.transitive) === '["hasPart"]' && J(covLegacy.symmetric) === '["partOf"]');
  check('护栏能拦截 owl.js 字段式 profile 的 range 越界', guard.checkEdge(legacyProfile, { name: 'a', type: 'Thing' }, 'hasPart', { name: 'b', type: 'Thing' }).reason === 'range-violation');

  // ======================================================================
  section('§4.3 guard.summarizeGuardLog：护栏日志汇总');
  // ======================================================================
  const bigLog = [];
  for (let i = 0; i < 250; i++) bigLog.push({ reason: i % 2 ? 'range-violation' : 'domain-violation', rel: 'r' + (i % 3) });
  const sum = guard.summarizeGuardLog(bigLog);
  check('total 统计全部条目', sum.total === 250);
  check('entries 截断到 200 条并置 truncated', sum.entries.length === 200 && sum.truncated === true);
  // byReason 用普通对象累加，键序 = 首次出现顺序（i=0 → domain-violation 先入）
  check('byReason 按理由聚合（键序为首次出现顺序）', J(sum.byReason) === '{"domain-violation":125,"range-violation":125}', J(sum.byReason));
  check('byRel 按谓词聚合', J(sum.byRel) === '{"r0":84,"r1":83,"r2":83}', J(sum.byRel));
  check('空日志汇总为全零', J(guard.summarizeGuardLog([])) === '{"total":0,"byReason":{},"byRel":{},"entries":[],"truncated":false}');
  check('null 日志不抛', guard.summarizeGuardLog(null).total === 0);
  check('不传参数不抛', guard.summarizeGuardLog().total === 0);
  check('条目缺 reason/rel 时归入 unknown/?', (() => { const s = guard.summarizeGuardLog([{}]); return s.byReason.unknown === 1 && s.byRel['?'] === 1; })());
  check('恰好 200 条不置 truncated', guard.summarizeGuardLog(new Array(200).fill({ reason: 'x', rel: 'y' })).truncated === false);

  // ======================================================================
  section('§4.3 guard：模型缓存语义');
  // ======================================================================
  guard.clearCache();
  const mut = { id: 'owl:m', name: 'm', classes: [{ key: 'A', label: 'A' }], predicates: [{ key: 'r', label: 'r' }], axioms: [], constraints: [] };
  check('首次 coverage 反映 1 个谓词', guard.coverage(mut).predicates === 1);
  mut.predicates.push({ key: 'r2', label: 'r2' });
  check('谓词数变化会改变签名，缓存自动失效', guard.coverage(mut).predicates === 2);
  const sameSig = { id: 'owl:m', name: 'm', classes: [{ key: 'A', label: 'A' }], predicates: [{ key: 'r', label: 'r' }, { key: 'r2', label: 'r2' }], axioms: [], constraints: [] };
  check('签名相同但内容不同时命中缓存（已知取舍：靠 _userRev 显式失效）', J(guard.coverage(sameSig).transitive) === '[]');
  const rev = { ...sameSig, _userRev: 'v2', axioms: [{ type: 'TransitiveProperty', subject: 'r' }] };
  check('_userRev 变化能强制重算', J(guard.coverage(rev).transitive) === '["r"]', J(guard.coverage(rev).transitive));
  check('clearCache 后重算', (() => { guard.clearCache(); return J(guard.coverage({ ...sameSig, axioms: [{ type: 'TransitiveProperty', subject: 'r' }] }).transitive) === '["r"]'; })());

  // ======================================================================
  section('§4.4 impact：影响面意图识别');
  // ======================================================================
  check('IMPACT_KEYWORDS 共 10 个', impact.IMPACT_KEYWORDS.length === 10 && J(impact.IMPACT_KEYWORDS) === '["影响","下游","依赖","故障","波及","牵连","连带","传导","上游","impact"]');
  check('DEFAULT_MAX_DEPTH = 5', impact.DEFAULT_MAX_DEPTH === 5);
  check('DEFAULT_MAX_NODES = 500', impact.DEFAULT_MAX_NODES === 500);
  const di = (q) => impact.detectImpactIntent(q);
  check('「变压器故障会影响哪些设备？」命中 影响+故障', J(di('变压器故障会影响哪些设备？').keywords) === '["影响","故障"]' && di('变压器故障会影响哪些设备？').hit === true);
  check('10 个关键词逐个可命中', impact.IMPACT_KEYWORDS.every((k) => di(k).hit === true));
  check('英文 impact 大小写不敏感', di('what is the IMPACT').hit === true && di('what is the impact').keywords[0] === 'impact');
  check('非影响面提问不命中', di('变压器是什么？').hit === false && J(di('变压器是什么？').keywords) === '[]');
  check('空问题不命中', di('').hit === false && di(null).hit === false && di(undefined).hit === false);

  // ======================================================================
  section('§4.4 impact：可用谓词与闭包扩展');
  // ======================================================================
  const relBL = impact.impactRelations(BL);
  check('bfo-lite 可用（有传递谓词）', relBL.usable === true && J(relBL.transitive) === '["包含"]' && J(relBL.symmetric) === '["相关"]' && J(relBL.inverseOf) === '{}');
  const relBFO = impact.impactRelations(BFO);
  check('bfo 的 inverseOf 已展开为普通对象（可过 IPC）', relBFO.usable === true && J(relBFO.inverseOf.part_of) === '["has_part"]' && J(relBFO.inverseOf.inheres_in) === '["bearer_of"]', J(relBFO.inverseOf));
  check('无传递谓词的体系 usable=false', impact.impactRelations(noFuel).usable === false && impact.impactRelations(noFuel).transitive.length === 0);
  check('impactRelations(null) 不抛', impact.impactRelations(null).usable === false);

  // A →包含 B →包含 C →包含 D，另有 E →相关 A
  const gImp = {
    nodes: [N('a', 'A', 'object'), N('b', 'B', 'object'), N('c', 'C', 'object'), N('d', 'D', 'object'), N('e', 'E', 'object')],
    edges: [
      { from: 'bfo-lite:a', to: 'bfo-lite:b', rel: '包含' },
      { from: 'bfo-lite:b', to: 'bfo-lite:c', rel: '包含' },
      { from: 'bfo-lite:c', to: 'bfo-lite:d', rel: '包含' },
      { from: 'bfo-lite:e', to: 'bfo-lite:a', rel: '相关' },
    ],
  };
  const down = impact.impactClosure(gImp, BL, 'bfo-lite:a', {});
  check('下游闭包按 BFS 顺序给出深度与路径', J(down.map((x) => [x.name, x.depth, x.via, x.path])) === '[["B",1,"包含",["包含"]],["C",2,"包含",["包含","包含"]],["D",3,"包含",["包含","包含","包含"]]]', J(down.map((x) => [x.name, x.depth])));
  check('非传递谓词（相关）不参与默认下游扩展', down.every((x) => x.name !== 'E'));
  check('闭包结果带节点元信息', down[0].id === 'bfo-lite:b' && down[0].type === 'object' && down[0].profile === 'bfo-lite' && down[0].inferred === false);
  check('maxDepth=1 只留一跳', J(impact.impactClosure(gImp, BL, 'bfo-lite:a', { maxDepth: 1 }).map((x) => x.name)) === '["B"]');
  check('maxDepth=2 留两跳', J(impact.impactClosure(gImp, BL, 'bfo-lite:a', { maxDepth: 2 }).map((x) => x.name)) === '["B","C"]');
  check('maxDepth=0 被夹到下限 1', impact.impactClosure(gImp, BL, 'bfo-lite:a', { maxDepth: 0 }).length === 1);
  check('maxDepth=99 不越界', impact.impactClosure(gImp, BL, 'bfo-lite:a', { maxDepth: 99 }).length === 3);
  check('maxNodes=1 截断结果', impact.impactClosure(gImp, BL, 'bfo-lite:a', { maxNodes: 1 }).length === 1);
  check('upstream 反向遍历', J(impact.impactClosure(gImp, BL, 'bfo-lite:d', { direction: 'upstream' }).map((x) => [x.name, x.depth])) === '[["C",1],["B",2],["A",3]]');
  check('both 双向遍历', J(impact.impactClosure(gImp, BL, 'bfo-lite:b', { direction: 'both' }).map((x) => [x.name, x.depth])) === '[["C",1],["A",1],["D",2]]');
  check('未知 direction 退化为 downstream', J(impact.impactClosure(gImp, BL, 'bfo-lite:a', { direction: 'sideways' }).map((x) => x.name)) === '["B","C","D"]');
  check('followSymmetric 仍不逆流（相关边是 E→A）', J(impact.impactClosure(gImp, BL, 'bfo-lite:a', { followSymmetric: true }).map((x) => x.name)) === '["B","C","D"]');
  check('rels 覆盖可换成非传递谓词', impact.impactClosure(gImp, BL, 'bfo-lite:a', { rels: ['相关'] }).length === 0);
  check('includeInferred=false 排除推理边', impact.impactClosure({ nodes: gImp.nodes, edges: [{ from: 'bfo-lite:a', to: 'bfo-lite:b', rel: '包含', inferred: true }] }, BL, 'bfo-lite:a', { includeInferred: false }).length === 0);
  check('includeInferred=true（默认）纳入推理边并标注', (() => { const r = impact.impactClosure({ nodes: gImp.nodes, edges: [{ from: 'bfo-lite:a', to: 'bfo-lite:b', rel: '包含', inferred: true }] }, BL, 'bfo-lite:a', {}); return r.length === 1 && r[0].inferred === true; })());
  const gCyc = { nodes: [N('a', 'A', 'object'), N('b', 'B', 'object')], edges: [{ from: 'bfo-lite:a', to: 'bfo-lite:b', rel: '包含' }, { from: 'bfo-lite:b', to: 'bfo-lite:a', rel: '包含' }] };
  check('图中有环时不死循环', J(impact.impactClosure(gCyc, BL, 'bfo-lite:a', {}).map((x) => x.name)) === '["B"]');
  check('种子不存在 → 空数组', impact.impactClosure(gImp, BL, 'nope', {}).length === 0);
  check('种子为空串 → 空数组', impact.impactClosure(gImp, BL, '', {}).length === 0);
  check('空图 → 空数组', impact.impactClosure({ nodes: [], edges: [] }, BL, 'a', {}).length === 0);
  check('无传递谓词的体系 → 空数组', impact.impactClosure(gImp, noFuel, 'bfo-lite:a', {}).length === 0);
  const gInv2 = { nodes: [N('轮', '轮', 'material_entity', 'bfo'), N('车', '车', 'material_entity', 'bfo')], edges: [{ from: 'bfo:轮', to: 'bfo:车', rel: 'part_of' }] };
  check('沿互逆谓词也能传导（车 →has_part 轮）', J(impact.impactClosure(gInv2, BFO, 'bfo:车', {}).map((x) => [x.name, x.via])) === '[["轮","has_part"]]', J(impact.impactClosure(gInv2, BFO, 'bfo:车', {})));
  check('反方向沿 part_of 传导', J(impact.impactClosure(gInv2, BFO, 'bfo:轮', {}).map((x) => [x.name, x.via])) === '[["车","part_of"]]');

  // ======================================================================
  section('§4.4 impact：事实串与摘要');
  // ======================================================================
  const seedA = gImp.nodes[0];
  const facts = impact.impactToFacts(gImp, seedA, down, {});
  check('事实串格式为 [体系·类型]名 —链路 → [体系·类型]名（N 跳）', J(facts) === '["[bfo-lite·object]A —包含 → [bfo-lite·object]B（1 跳）","[bfo-lite·object]A —包含 → 包含 → [bfo-lite·object]C（2 跳）","[bfo-lite·object]A —包含 → 包含 → 包含 → [bfo-lite·object]D（3 跳）"]', J(facts));
  check('limit=1 只出一条', impact.impactToFacts(gImp, seedA, down, { limit: 1 }).length === 1);
  check('limit=0 被夹到下限 1', impact.impactToFacts(gImp, seedA, down, { limit: 0 }).length === 1);
  check('空闭包 → 空事实', impact.impactToFacts(gImp, seedA, [], {}).length === 0);
  check('推理边在事实串里标注「⚡推理」', impact.impactToFacts(gImp, seedA, [{ ...down[0], inferred: true }], {})[0].includes('，⚡推理'), impact.impactToFacts(gImp, seedA, [{ ...down[0], inferred: true }], {})[0]);
  check('impactSummary 汇总谓词/节点数/最深跳数', impact.impactSummary(BL, down, {}) === '影响面扩展完成（沿传递谓词 包含，共 3 个下游节点，最深 3 跳）', impact.impactSummary(BL, down, {}));
  check('impactSummary 对空闭包仍给出可读文案', impact.impactSummary(BL, [], {}) === '影响面扩展完成（沿传递谓词 包含，共 0 个下游节点，最深 0 跳）');
  check('impactSummary 的 rels 覆盖生效', impact.impactSummary(BL, down, { rels: ['相关'] }) === '影响面扩展完成（沿传递谓词 相关，共 3 个下游节点，最深 3 跳）');
  check('impactSummary 对无传递谓词的体系写「无」', impact.impactSummary(noFuel, [], {}) === '影响面扩展完成（沿传递谓词 无，共 0 个下游节点，最深 0 跳）');

  // ======================================================================
  section('§4.6 profile：OWL 2 子语言判别');
  // ======================================================================
  check('profileCheckAvailable() 为真', prof.profileCheckAvailable() === true);
  check('PROFILE_META 覆盖 RL/QL/EL', J(Object.keys(prof.PROFILE_META)) === '["RL","QL","EL"]');
  check('只有 RL 标记为可本地推理', prof.PROFILE_META.RL.localReasoning === true && prof.PROFILE_META.QL.localReasoning === false && prof.PROFILE_META.EL.localReasoning === false);
  check('RL 元信息指明使用 OWL2RLReasoner', /OWL2RLReasoner/.test(prof.PROFILE_META.RL.reasoner));
  const pNull = prof.detectProfile(null);
  check('detectProfile(null) → available:false 且给出中文原因', pNull.available === false && pNull.error === '需要 OWLOntology 实例（含 getAxiomsOfType）', J(pNull.error));
  check('detectProfile(null) 的 rl/ql/el 均为空壳', pNull.rl.ok === false && pNull.rl.total === 0 && pNull.recommend === null && J(pNull.profiles) === '[]');
  check('detectProfile(null) 仍带 PROFILE_META 供 UI 渲染', J(Object.keys(pNull.meta)) === '["RL","QL","EL"]');
  check('detectProfile({}) 同样降级而不抛', prof.detectProfile({}).available === false);
  check('explainProfile(null) → 「子语言判定不可用」', J(prof.explainProfile(null)) === '{"headline":"子语言判定不可用","lines":["protege-js 的 OWL2Profiles 模块未能加载"],"canReasonLocally":false,"recommend":null}');
  check('explainProfile(undefined) 同样降级', prof.explainProfile(undefined).canReasonLocally === false);
  check('explainProfile 透传具体错误', prof.explainProfile(pNull).lines[0] === '需要 OWLOntology 实例（含 getAxiomsOfType）');

  const roText = fs.readFileSync(RO_CORE, 'utf-8');
  const roParsed = owlImport.parseWithProtege(roText, 'RDFXML', {});
  check('ro-core.owl 解析出 245 条公理', roParsed.ontology.getAxiomCount() === 245, String(roParsed.ontology.getAxiomCount()));
  const roD1 = prof.detectProfile(roParsed.ontology);
  check('ro-core 判定为 OWL 2 RL（可本地推理）', roD1.available === true && roD1.recommend === 'RL' && roD1.reasonerAvailable === true && J(roD1.profiles) === '["RL"]', J({ r: roD1.recommend, p: roD1.profiles }));
  check('ro-core 的 QL/EL 违规数分别为 5/3', roD1.ql.ok === false && roD1.ql.total === 5 && roD1.el.ok === false && roD1.el.total === 3, J({ ql: roD1.ql.total, el: roD1.el.total }));
  check('RL 违规为 0', roD1.rl.ok === true && roD1.rl.total === 0);
  check('违规条目含 profile/rule/message/axiom 四字段', (() => { const v = roD1.ql.violations[0]; return v.profile === 'QL' && v.rule === 'QL-FunctionalObjectProperty' && /not allowed in OWL 2 QL/.test(v.message) && /FunctionalObjectProperty/.test(v.axiom); })(), J(roD1.ql.violations[0]));
  check('EL 违规首条为 IrreflexiveObjectProperty', roD1.el.violations[0].rule === 'EL-IrreflexiveObjectProperty');
  check('maxViolations 限制 violations 长度但 total 保留全量', (() => { const r = prof.detectProfile(roParsed.ontology, { maxViolations: 1 }); return r.ql.shown === 1 && r.ql.total === 5 && r.ql.violations.length === 1; })());
  check('maxViolations=0 被夹到下限 1', prof.detectProfile(roParsed.ontology, { maxViolations: 0 }).ql.shown === 1);
  check('maxViolations 极大值不超过实际违规数', prof.detectProfile(roParsed.ontology, { maxViolations: 9999 }).ql.shown === 5);
  // ⚠️ 回归：曾怀疑 detectProfile 会改写 OWLOntology 导致二次调用结果漂移，实测幂等。
  const roD2 = prof.detectProfile(roParsed.ontology);
  check('【幂等回归】同一 OWLOntology 上二次调用结果一致', roD2.recommend === roD1.recommend && roD2.ql.total === roD1.ql.total && roD2.el.total === roD1.el.total, J({ ql: roD2.ql.total, el: roD2.el.total }));
  check('【幂等回归】detectProfile 不改写公理集', roParsed.ontology.getAxiomCount() === 245);
  const roExp = prof.explainProfile(roD1);
  check('explainProfile 给出「属于 OWL 2 RL」标题', roExp.headline === '该本体属于 OWL 2 RL' && roExp.canReasonLocally === true && roExp.recommend === 'RL');
  check('explainProfile 逐条列出三个子语言的判定', roExp.lines[0].startsWith('✅ OWL 2 RL：符合') && roExp.lines[1] === '❌ OWL 2 QL：不符合，5 处违规' && roExp.lines[2] === '❌ OWL 2 EL：不符合，3 处违规', J(roExp.lines));
  check('explainProfile 末行说明可本地物化推理', /本地物化推理/.test(roExp.lines[roExp.lines.length - 1]));

  const nrlParsed = owlImport.parseWithProtege(NON_RL_OFN, 'Functional', {});
  const nrlD = prof.detectProfile(nrlParsed.ontology);
  check('含 ObjectUnionOf/ObjectComplementOf 的本体三个子语言全不符合', nrlD.available === true && nrlD.recommend === null && nrlD.reasonerAvailable === false && J(nrlD.profiles) === '[]', J({ r: nrlD.recommend, p: nrlD.profiles, rl: nrlD.rl.total }));
  check('RL 违规命中 RL-subclass 与 RL-superclass 两条规则', J(nrlD.rl.violations.map((v) => v.rule)) === '["RL-subclass","RL-superclass"]', J(nrlD.rl.violations.map((v) => v.rule)));
  check('违规 axiom 字段是可读的功能语法串且被截断到 300 字内', nrlD.rl.violations.every((v) => typeof v.axiom === 'string' && v.axiom.length <= 300 && v.axiom.length > 0));
  const nrlExp = prof.explainProfile(nrlD);
  check('explainProfile 对全不符合的本体给出「OWL 2 Full」标题', nrlExp.headline === '该本体不属于 RL / QL / EL 任一子语言（OWL 2 Full 或 DL 完整表达力）' && nrlExp.canReasonLocally === false, J(nrlExp));
  check('explainProfile 说明需外部推理机但仍可导入词表', nrlExp.lines.some((l) => /HermiT|Pellet|ELK/.test(l)) && nrlExp.lines.some((l) => /受控词表/.test(l)), J(nrlExp.lines));

  // ======================================================================
  section('§4.5 owlImport：格式判定');
  // ======================================================================
  const df = (f, t) => owlImport.detectOwlFormat(f, t);
  check('.ttl → Turtle（按扩展名）', J(df('a.ttl', TTL_DEFAULT)) === '{"format":"Turtle","by":"ext"}');
  check('.ofn → Functional（按扩展名）', J(df('b.ofn', OFN)) === '{"format":"Functional","by":"ext"}');
  check('.omn → Manchester（按扩展名，绕过上游 detectFormat 的误判）', J(df('c.omn', OMN)) === '{"format":"Manchester","by":"ext"}', J(df('c.omn', OMN)));
  check('.owl + XML 内容 → RDFXML（扩展名+内容双证据）', df('d.owl', '<?xml version="1.0"?><rdf:RDF></rdf:RDF>').by === 'ext+xml');
  check('无扩展名 + Turtle 内容 → 内容嗅探', J(df('noext', TTL_DEFAULT)) === '{"format":"Turtle","by":"sniff"}');
  check('扩展名与内容不符时以内容为准（.owl 装 Turtle）', J(df('x.owl', TTL_DEFAULT)) === '{"format":"Turtle","by":"ext+ttl"}');
  check('扩展名与内容不符时以内容为准（.owl 装 Functional）', J(df('y.owl', OFN)) === '{"format":"Functional","by":"ext+ofn"}');
  check('.txt + Manchester 内容 → 内容嗅探', J(df('z.txt', OMN)) === '{"format":"Manchester","by":"sniff"}');
  check('空内容默认按 RDFXML 尝试', J(df('w', '')) === '{"format":"RDFXML","by":"default"}');
  check('KNOWN_FORMATS 列出 5 种格式', J(owlImport.KNOWN_FORMATS) === '["Turtle","RDFXML","Functional","Manchester","OWLXML"]');
  check('FORMAT_LABEL 给出带扩展名的中文可读标签', owlImport.FORMAT_LABEL.Turtle === 'Turtle (.ttl)' && owlImport.FORMAT_LABEL.Manchester === 'Manchester Syntax (.omn)');
  check('SUPPORTED_AXIOM_TYPES 与前端 typeNames 的 12 种一致', owlImport.SUPPORTED_AXIOM_TYPES.size === 12 && ['DisjointClasses', 'SubClassOf', 'TransitiveProperty', 'SymmetricProperty', 'AsymmetricProperty', 'InverseProperties', 'PropertyDomain', 'PropertyRange', 'FunctionalProperty', 'InverseFunctionalProperty', 'ReflexiveProperty', 'IrreflexiveProperty'].every((t) => owlImport.SUPPORTED_AXIOM_TYPES.has(t)));
  check('截断上限：200 类 / 120 谓词 / 400 公理', owlImport.MAX_CLASSES === 200 && owlImport.MAX_PREDICATES === 120 && owlImport.MAX_AXIOMS === 400);
  check('protegeAvailable() 为真且无加载错误', owlImport.protegeAvailable() === true && owlImport.protegeError() === '');

  // ======================================================================
  section('§4.5 owlImport.parseWithProtege：解析与格式回退');
  // ======================================================================
  const pw = owlImport.parseWithProtege(TTL_DEFAULT, 'Turtle', {});
  check('返回 {ontology, format, tried} 三段（不是裸 ontology）', J(Object.keys(pw)) === '["ontology","format","tried"]', J(Object.keys(pw)));
  check('ontology 是 OWLOntology 实例', pw.ontology.constructor.name === 'OWLOntology');
  check('首次即成功时 tried 为空数组', J(pw.tried) === '[]');
  check('format 回显实际成功的格式', pw.format === 'Turtle');
  const pwFallback = owlImport.parseWithProtege(TTL_DEFAULT, 'OWLXML', {});
  check('格式提示错误时自动回退到能解析的格式', pwFallback.format === 'Turtle' && pwFallback.tried.length >= 1 && pwFallback.tried[0].format === 'OWLXML', J(pwFallback.tried.map((t) => t.format)));
  check('tried 记录每次失败的格式与错误摘要', pwFallback.tried.every((t) => typeof t.error === 'string' && t.error.length <= 200));
  check('opts 传 null 不再抛 TypeError（BUG 13 回归）', (() => { try { return owlImport.parseWithProtege(TTL_DEFAULT, 'Turtle', null).format === 'Turtle'; } catch (e) { return 'threw: ' + e.message; } })());
  check('opts 省略时同样可用', owlImport.parseWithProtege(TTL_DEFAULT, 'Turtle').ontology.getAxiomCount() > 0);
  check('ontologyIRI 透传后 Turtle 路径仍解析成功', owlImport.parseWithProtege(TTL_DEFAULT, 'Turtle', { ontologyIRI: 'http://ex.org/o' }).format === 'Turtle');
  check('RDFXML 路径也能解析 ro-core.owl', owlImport.parseWithProtege(roText, 'RDFXML', {}).ontology.getAxiomCount() === 245);
  check('全部解析器都失败时抛出带尝试链的错误', (() => {
    try { owlImport.parseWithProtege('this is not turtle at all !!!', 'Turtle', {}); return false; } catch (e) { return /全部解析器均失败/.test(e.message) && /Turtle → RDFXML → Functional → Manchester → OWLXML/.test(e.message); }
  })());
  // parseOne 内部已做 TripleStore → OWLOntology 的转换，对外只暴露 OWLOntology；
  // 「TripleStore 没有 getAxiomsOfType」是上游 TurtleParser 的坑，由 parseOne 兜住。
  const poTtl = owlImport.parseOne(TTL_DEFAULT, 'Turtle');
  check('parseOne(Turtle) 返回真正的 OWLOntology（已内部完成 TripleStore 转换）', typeof poTtl.getAxiomsOfType === 'function' && poTtl.getAxiomCount() === 22, J({ t: typeof poTtl.getAxiomsOfType, n: poTtl.getAxiomCount && poTtl.getAxiomCount() }));
  check('裸 TurtleParser 返回的 TripleStore 确实没有 getAxiomsOfType（上游坑，parseOne 已兜住）', (() => {
    const raw = new (require('@skaterqiang/protege-js').TurtleParser)().parse(TTL_DEFAULT);
    return typeof raw.getAxiomsOfType !== 'function' && typeof raw.size === 'function';
  })());
  check('parseOne 对未知格式抛错', (() => { try { owlImport.parseOne('x', 'Bogus'); return false; } catch (e) { return /未知格式/.test(e.message); } })());

  // ======================================================================
  section('§4.5 importOwlExtended：Turtle（.ttl）');
  // ======================================================================
  const fTtl = writeFile(path.join(env.dir, 'def2.ttl'), TTL_DEFAULT);
  const rTtl = await owlImport.importOwlExtended(fTtl, { previewOnly: true });
  check('via 标记为 protege-js', rTtl.via === 'protege-js');
  check('report 记录格式与解析器', rTtl.report.format === 'Turtle (.ttl)' && rTtl.report.formatId === 'Turtle' && rTtl.report.parser === 'protege-js');
  check('report 计数：4 类 / 3 谓词 / 8 公理 / 0 个体', J({ c: rTtl.report.classCount, p: rTtl.report.predicateCount, a: rTtl.report.axiomCount, i: rTtl.report.individualCount }) === '{"c":4,"p":3,"a":8,"i":0}', J(rTtl.report));
  check('protege-js 路径保留 owl:DatatypeProperty（owl.js 会丢）', rTtl.profile.predicates.some((p) => p.key === 'name'), J(rTtl.profile.predicates.map((p) => p.key)));
  check('类保留中文 label 与 parent', J(rTtl.profile.classes.map((c) => `${c.key}(${c.label}|${c.parent})`)) === '["Thing(事物|)","Part(部件|Thing)","Engine(发动机|Part)","Wheel(轮子|Part)"]', J(rTtl.profile.classes));
  check('谓词保留 label/domain/range/features', J(rTtl.profile.predicates.map((p) => `${p.key}(${p.label}|d=${p.domain}|r=${p.range}|f=${(p.features || []).join('+')})`)) === '["hasPart(有部件|d=Thing|r=Part|f=transitive)","partOf(属于|d=|r=|f=symmetric)","name(名称|d=Thing|r=|f=)"]', J(rTtl.profile.predicates));
  check('domain/range 是字符串而非数组（与 owl.js 保持一致）', rTtl.profile.predicates.every((p) => typeof p.domain === 'string' && typeof p.range === 'string'));
  check('公理被还原为 8 条二元组', J(rTtl.profile.axioms.map((a) => `${a.type}(${a.subject}${a.object ? '→' + a.object : ''})`)) === '["SubClassOf(Part→Thing)","SubClassOf(Engine→Part)","SubClassOf(Wheel→Part)","TransitiveProperty(hasPart)","SymmetricProperty(partOf)","PropertyDomain(hasPart→Thing)","PropertyDomain(name→Thing)","PropertyRange(hasPart→Part)"]', J(rTtl.profile.axioms));
  check('自动生成 8 条中文约束说明（{desc} 对象形式）', rTtl.profile.constraints.length === 8 && rTtl.profile.constraints.every((c) => typeof c === 'object' && typeof c.desc === 'string'), J(rTtl.profile.constraints.map((c) => c.desc || c)));
  check('约束文案覆盖子类继承/传递性/对称性/定义域/值域', (() => { const d = rTtl.profile.constraints.map((c) => c.desc).join('|'); return /子类/.test(d) && /传递性/.test(d) && /对称性/.test(d) && /起点必须是/.test(d) && /终点必须是/.test(d); })());
  check('体系 id 为 owl: 前缀 + 文件基名', rTtl.profile.id === 'owl:def2' && rTtl.profile.owl === true);
  check('promptMode 按类数选择（≤12 → flat）', rTtl.profile.promptMode === 'flat');
  check('fallbackType 选根类', rTtl.profile.fallbackType === 'Thing');
  check('fallbackRel 选无 domain/range 约束的谓词', rTtl.profile.fallbackRel === 'partOf', rTtl.profile.fallbackRel);
  check('profileCheck 判定为 RL', rTtl.profileCheck.recommend === 'RL' && rTtl.profileCheck.rl.ok === true && rTtl.profileCheck.ql.total === 2 && rTtl.profileCheck.el.ok === true, J({ r: rTtl.profileCheck.recommend, ql: rTtl.profileCheck.ql.total }));
  check('preview 的 18 个字段齐全', J(Object.keys(rTtl.preview)) === '["fileName","format","formatId","detectedFormat","detectedBy","parser","ontologyIri","counts","rootClasses","sampleClasses","samplePredicates","axiomTypes","promptMode","fallbackType","fallbackRel","profileCheck","warnings","notes"]', J(Object.keys(rTtl.preview)));
  check('preview.counts 含 roots', J(rTtl.preview.counts) === '{"classes":4,"predicates":3,"axioms":8,"constraints":8,"individuals":0,"roots":1}', J(rTtl.preview.counts));
  check('preview.rootClasses 列出唯一根类', J(rTtl.preview.rootClasses) === '[{"key":"Thing","label":"事物"}]');
  check('preview.axiomTypes 按数量降序', J(rTtl.preview.axiomTypes) === '[{"type":"SubClassOf","count":3},{"type":"PropertyDomain","count":2},{"type":"TransitiveProperty","count":1},{"type":"SymmetricProperty","count":1},{"type":"PropertyRange","count":1}]', J(rTtl.preview.axiomTypes));
  check('Turtle 路径显式声明「个体断言会丢失」', rTtl.report.unsupportedAxioms.some((u) => u.type === 'ABoxDropped' && /只还原 TBox/.test(u.note)), J(rTtl.report.unsupportedAxioms));
  check('preview.notes 把 ABoxDropped 提示给用户', rTtl.preview.notes.some((n) => /个体断言/.test(n)));
  check('preview.notes 含护栏覆盖率与可推理公理统计', rTtl.preview.notes.some((n) => /护栏覆盖：2\/3/.test(n)) && rTtl.preview.notes.some((n) => /可产生推理边/.test(n)), J(rTtl.preview.notes));
  check('Turtle 无警告', J(rTtl.preview.warnings) === '[]');
  check('axiomHistogram 按数量降序输出', J(owlImport.axiomHistogram(rTtl.profile.axioms).slice(0, 2)) === '[{"type":"SubClassOf","count":3},{"type":"PropertyDomain","count":2}]');

  // ======================================================================
  section('§4.5 importOwlExtended：Functional / Manchester / 无扩展名');
  // ======================================================================
  const rOfn = await owlImport.importOwlExtended(writeFile(path.join(env.dir, 'f.ofn'), OFN), { previewOnly: true });
  check('.ofn 走 Functional 解析器', rOfn.report.formatId === 'Functional' && rOfn.report.format === 'OWL Functional Syntax (.ofn)');
  check('.ofn 能解析出本体 IRI', rOfn.report.ontologyIri === 'http://ex.org/f', rOfn.report.ontologyIri);
  check('.ofn 保留中文 label（Device→设备）', J(rOfn.profile.classes.map((c) => `${c.key}(${c.label}|${c.parent})`)) === '["Device(设备|)","Pump(泵|Device)"]', J(rOfn.profile.classes));
  check('.ofn 的谓词带传递特征与 domain/range', J(rOfn.profile.predicates.map((p) => `${p.key}(${p.label}|d=${p.domain}|r=${p.range}|f=${(p.features || []).join('+')})`)) === '["feeds(输送|d=Device|r=Device|f=transitive)"]');
  check('.ofn 还原 4 条公理', rOfn.profile.axioms.length === 4 && rOfn.profileCheck.recommend === 'RL');
  check('.ofn 不产生 ABoxDropped 提示', J(rOfn.report.unsupportedAxioms) === '[]');
  check('.ofn 的 preview 无警告', J(rOfn.preview.warnings) === '[]');

  const rOmn = await owlImport.importOwlExtended(writeFile(path.join(env.dir, 'm.omn'), OMN), { previewOnly: true });
  check('.omn 走 Manchester 解析器', rOmn.report.formatId === 'Manchester' && rOmn.report.format === 'Manchester Syntax (.omn)');
  check('.omn 的类/谓词 key 与公理都正确还原', J(rOmn.profile.classes.map((c) => `${c.key}(|${c.parent})`)) === '["Device(|)","Pump(|Device)"]' && rOmn.profile.axioms.length === 4, J(rOmn.profile.classes));
  check('.omn 丢失 rdfs:label（上游解析器限制），label 回退为英文本地名', rOmn.profile.classes[0].label === 'Device' && rOmn.profile.predicates[0].label === 'feeds');
  check('.omn 解析不出本体 IRI（上游忽略 Ontology: 头）', rOmn.report.ontologyIri === '', J(rOmn.report.ontologyIri));
  check('.omn 显式警告 label 丢失并建议改用其他格式', rOmn.preview.warnings.length === 1 && /Manchester 语法（\.omn）/.test(rOmn.preview.warnings[0]) && /不还原 rdfs:label/.test(rOmn.preview.warnings[0]) && /Turtle（\.ttl）/.test(rOmn.preview.warnings[0]), J(rOmn.preview.warnings));
  check('.omn 仍能判定子语言', rOmn.profileCheck.recommend === 'RL');

  const rNoExt = await owlImport.importOwlExtended(writeFile(path.join(env.dir, 'noext'), TTL_DEFAULT), { previewOnly: true });
  check('无扩展名文件靠内容嗅探走 Turtle', rNoExt.report.formatId === 'Turtle' && rNoExt.preview.detectedBy === 'sniff', J(rNoExt.preview.detectedBy));
  check('无扩展名的解析结果与 .ttl 完全一致', J(rNoExt.profile.classes) === J(rTtl.profile.classes) && J(rNoExt.profile.axioms) === J(rTtl.profile.axioms));

  // ======================================================================
  section('§4.5/§3.3 importOwlExtended：forceLegacy / previewOnly / 覆盖项');
  // ======================================================================
  const rLegacy = await owlImport.importOwlExtended(fTtl, { previewOnly: true, forceLegacy: true });
  check('forceLegacy → via 标记为 owl.js', rLegacy.via === 'owl.js');
  check('forceLegacy 仍能解析出 4 个类', rLegacy.profile.classes.length === 4);
  check('forceLegacy 只剩 2 个谓词（owl.js 丢弃 owl:DatatypeProperty）', rLegacy.profile.predicates.length === 2 && J(rLegacy.profile.predicates.map((p) => p.key)) === '["hasPart","partOf"]', J(rLegacy.profile.predicates.map((p) => p.key)));
  check('forceLegacy 的 profileCheck 明确说明无法判定子语言', rLegacy.profileCheck.available === false && /owl\.js 路径不产生 OWLOntology/.test(rLegacy.profileCheck.error), J(rLegacy.profileCheck.error));
  check('forceLegacy 的 profileCheck 三个子语言均为空壳', rLegacy.profileCheck.rl.ok === false && rLegacy.profileCheck.ql.total === 0 && rLegacy.profileCheck.recommend === null && J(rLegacy.profileCheck.profiles) === '[]');
  check('forceLegacy 的 preview.notes 说明使用了内置正则解析器', rLegacy.preview.notes.some((n) => /内置正则解析器/.test(n)) && rLegacy.preview.notes.some((n) => /仅类层级/.test(n)), J(rLegacy.preview.notes));
  check('forceLegacy 的 report 无 axiomCount（owl.js 不产公理）', rLegacy.profile.axioms === undefined || rLegacy.profile.axioms.length === 0);

  check('previewOnly 的返回含 6 个键（新增 filePath 供前端确认导入复用）', J(Object.keys(rTtl)) === '["profile","report","profileCheck","preview","via","filePath"]', J(Object.keys(rTtl)));
  check('previewOnly 透传 filePath（值与入参一致）', rTtl.filePath === fTtl, J(rTtl.filePath));
  const rNamed = await owlImport.importOwlExtended(fTtl, { previewOnly: true, displayName: '我的本体', id: 'custom-id' });
  check('displayName 覆盖体系名', rNamed.profile.name === '我的本体');
  // 显式传入的 id 原样使用（不补 owl: 前缀）；只有自动生成时才加 owl: 前缀。
  check('显式 id 原样使用，不补 owl: 前缀', rNamed.profile.id === 'custom-id', rNamed.profile.id);
  check('已带 owl: 前缀的显式 id 不会重复加前缀', (await owlImport.importOwlExtended(fTtl, { previewOnly: true, id: 'owl:already' })).profile.id === 'owl:already');
  check('owlImport 导出 20 个成员', Object.keys(owlImport).length === 20, J(Object.keys(owlImport)));
  check('localName/iriOf/literalOf/isNamed/iriToKey 工具可用', owlImport.localName('http://ex.org/o#Thing') === 'Thing' && typeof owlImport.iriToKey === 'function');

  // ======================================================================
  section('§4.5/§9 风险 4 importOwlExtended：错误路径');
  // ======================================================================
  // ⚠️ 实测：importOwlExtended 是 AsyncFunction，前置校验（文件不存在/为空）以
  //    **rejected promise** 形式返回，不是同步抛。调用方必须 await + try/catch，
  //    漏掉 await 会变成 unhandledRejection 直接崩进程。
  check('文件不存在时 reject「文件不存在：<路径>」', (await (async () => {
    try { await owlImport.importOwlExtended(path.join(env.dir, 'nope.ttl'), {}); return 'no-reject'; } catch (e) { return /^文件不存在：/.test(e.message); }
  })()) === true);
  check('文件不存在时返回的是 Promise（async 语义，非同步抛）', owlImport.importOwlExtended(path.join(env.dir, 'nope2.ttl'), {}).catch(() => {}) instanceof Promise);
  check('importOwlExtended 是 AsyncFunction', owlImport.importOwlExtended.constructor.name === 'AsyncFunction');
  check('文件存在时 importOwlExtended 返回 Promise', owlImport.importOwlExtended(fTtl, { previewOnly: true }) instanceof Promise);
  const badFile = writeFile(path.join(env.dir, 'bad.ttl'), 'this is not turtle at all !!!');
  let badMsg = '';
  try { await owlImport.importOwlExtended(badFile, {}); } catch (e) { badMsg = e.message; }
  check('内容无法解析时抛「无法解析 <文件名>：…」', /无法解析 bad\.ttl：/.test(badMsg), badMsg.slice(0, 120));
  check('错误信息里带上完整的格式尝试链', /Turtle → RDFXML → Functional → Manchester → OWLXML/.test(badMsg), badMsg.slice(0, 200));
  const emptyFile = writeFile(path.join(env.dir, 'empty.ttl'), '');
  let emptyMsg = '';
  try { await owlImport.importOwlExtended(emptyFile, {}); } catch (e) { emptyMsg = e.message; }
  check('空文件也给出明确错误而非静默成功', emptyMsg.length > 0, emptyMsg.slice(0, 120));
  check('buildPreview 对空本体不抛，产出 18 个字段并给出「不可用」警告', (() => {
    const pv = owlImport.buildPreview(
      { id: 'owl:x', name: 'x', classes: [], predicates: [], axioms: [], constraints: [], promptMode: 'flat', fallbackType: '', fallbackRel: '' },
      { sourceFile: 'x.ttl', format: 'Turtle (.ttl)', formatId: 'Turtle', ontologyIri: '', classCount: 0, predicateCount: 0, axiomCount: 0, individualCount: 0, unsupportedAxioms: [], truncated: false },
      null,
      { format: 'Turtle', by: 'sniff' },
    );
    return Object.keys(pv).length === 18
      && pv.counts.classes === 0 && J(pv.rootClasses) === '[]' && J(pv.axiomTypes) === '[]'
      && pv.detectedFormat === 'Turtle' && pv.detectedBy === 'sniff' && pv.profileCheck === null
      && pv.warnings.length === 2 && /未提取到任何类/.test(pv.warnings[0]) && /推理不会产生任何新边/.test(pv.warnings[1]);
  })());

  // ======================================================================
  section('§4.5 importOwlExtended：真实 OBO 本体 ro-core.owl（65 KB）');
  // ======================================================================
  const rRo = await owlImport.importOwlExtended(RO_CORE, { previewOnly: true });
  check('ro-core 走 protege-js 路径', rRo.via === 'protege-js');
  check('ro-core 解析出 14 类 / 30 谓词 / 65 公理', J({ c: rRo.report.classCount, p: rRo.report.predicateCount, a: rRo.report.axiomCount }) === '{"c":14,"p":30,"a":65}', J(rRo.report));
  check('ro-core 未被截断', rRo.report.truncated === false && rRo.report.originalClassCount === 14 && rRo.report.predicatesTruncated === false);
  check('ro-core 解析出真实本体 IRI', rRo.report.ontologyIri === 'http://purl.obolibrary.org/obo/ro/core.owl', rRo.report.ontologyIri);
  check('ro-core 判定为 RL（可本地推理），QL 5 处 / EL 3 处违规', rRo.profileCheck.recommend === 'RL' && rRo.profileCheck.ql.total === 5 && rRo.profileCheck.el.total === 3, J({ r: rRo.profileCheck.recommend, ql: rRo.profileCheck.ql.total, el: rRo.profileCheck.el.total }));
  check('ro-core 跳过 10 条 Synapse 不支持的子属性公理并说明原因', (() => {
    const u = rRo.report.unsupportedAxioms.find((x) => x.type === 'SUB_OBJECT_PROPERTY_OF');
    return !!u && u.count === 10 && /Synapse 体系结构不支持/.test(u.note);
  })(), J(rRo.report.unsupportedAxioms));
  check('ro-core 的 preview.notes 把跳过的子属性告知用户', rRo.preview.notes.some((n) => /跳过 10 条子属性/.test(n)), J(rRo.preview.notes[0]));
  check('ro-core 类数 >12 → promptMode 切到 two-stage', rRo.profile.promptMode === 'two-stage');
  check('ro-core 的类 key 用 IRI 本地名、label 用 rdfs:label', rRo.profile.classes[0].key === 'BFO_0000002' && rRo.profile.classes[0].label === 'continuant', J(rRo.profile.classes[0]));
  check('ro-core 的 part_of/has_part 被识别为传递', J(rRo.profile.predicates.slice(0, 2).map((p) => `${p.key}(${p.label}|f=${(p.features || []).join('+')})`)) === '["BFO_0000050(part of|f=transitive)","BFO_0000051(has part|f=transitive)"]', J(rRo.profile.predicates.slice(0, 2)));
  check('ro-core 的 preview 统计出 2 个根类、60 条约束', rRo.preview.counts.roots === 2 && rRo.preview.counts.constraints === 60, J(rRo.preview.counts));
  check('ro-core 的护栏覆盖率说明为 12/30 定义域、13 值域', rRo.preview.notes.some((n) => /护栏覆盖：12\/30 个谓词有定义域，13 个有值域/.test(n)), J(rRo.preview.notes));
  check('ro-core 的可推理公理统计含 6 种类型', rRo.preview.notes.some((n) => /InverseProperties×14/.test(n) && /TransitiveProperty×4/.test(n)), J(rRo.preview.notes));
  check('ro-core 无警告', J(rRo.preview.warnings) === '[]');
  guard.clearCache();
  const covRo = guard.coverage(rRo.profile);
  check('导入的真实本体能被护栏直接使用（12 个谓词有 domain）', covRo.withDomain === 12 && covRo.withRange === 13 && covRo.predicates === 30, J({ d: covRo.withDomain, r: covRo.withRange, p: covRo.predicates }));
  // 导入的 ro 体系 + 一条 part_of 边 → 应能就地物化出传递/互逆推理边
  const roId = rRo.profile.id;
  const gRo = {
    nodes: [N('x', '甲', 'BFO_0000040', roId), N('y', '乙', 'BFO_0000040', roId), N('z', '丙', 'BFO_0000040', roId)],
    edges: [{ from: `${roId}:x`, to: `${roId}:y`, rel: 'BFO_0000050' }, { from: `${roId}:y`, to: `${roId}:z`, rel: 'BFO_0000050' }],
  };
  const matRo = await infer.materializeGraph(gRo, rRo.profile, { timeoutMs: 60000 });
  check('导入的真实本体能直接物化推理（不抛、不跳过）', matRo.skipped === false && matRo.inferredEdges.length > 0, J({ s: matRo.skipped, r: matRo.skipReason, n: matRo.inferredEdges.length }));
  check('真实本体上推出 part_of 传递闭包与 has_part 互逆边', (() => {
    const vias = matRo.inferredEdges.map((e) => e.inferredVia);
    return vias.includes('transitive') && vias.includes('inverse');
  })(), J(matRo.inferredEdges.map((e) => `${e.rel}|${e.inferredVia}`)));

  // ======================================================================
  section('§3.3 owl.js 遗留解析器：默认前缀 Turtle（BUG 6 回归）');
  // ======================================================================
  check('slugify 保留中文、替换非法字符', owlLegacy.slugify('My Ontology! 中文/测试') === 'my-ontology-中文-测试', owlLegacy.slugify('My Ontology! 中文/测试'));
  const legacy = owlLegacy.parseOwlFile(fTtl);
  check('默认前缀 : 的 Turtle 能解析出 4 个类（修复前为 0）', legacy.report.classCount === 4, J(legacy.report));
  check('owl.js 的 report 只有 6 个字段（无 axiomCount/individualCount/ontologyIri）', J(Object.keys(legacy.report).sort()) === '["classCount","constraintCount","format","orphanClasses","predicateCount","truncated"]', J(Object.keys(legacy.report)));
  check('owl.js 丢弃 owl:DatatypeProperty，只剩 2 个谓词', legacy.report.predicateCount === 2);
  check('owl.js 的 profile 不带 axioms 字段', legacy.profile.axioms === undefined);
  // owl.js 不还原公理（无 axioms 字段），因此也生成不出任何 constraints ——
  // 这是降级路径的已知能力缺口：护栏只能靠 predicates 上的 domain/range 字段生效。
  check('owl.js 的 constraints 恒为空数组（不还原公理 → 生成不出约束文案）', J(legacy.profile.constraints) === '[]', J(legacy.profile.constraints));
  check('owl.js 的 orphanClasses 统计孤立类', Array.isArray(legacy.report.orphanClasses));
  check('owl.js 的 id 为 owl: + slugify(基名)', legacy.profile.id === 'owl:def2' && legacy.profile.owl === true, legacy.profile.id);
  check('owl.js 的 promptMode/fallbackType/fallbackRel', legacy.profile.promptMode === 'flat' && legacy.profile.fallbackType === 'Thing' && legacy.profile.fallbackRel === 'hasPart', J({ p: legacy.profile.promptMode, t: legacy.profile.fallbackType, r: legacy.profile.fallbackRel }));
  check('owl.js 的谓词 domain/range 是字符串', legacy.profile.predicates.every((p) => typeof p.domain === 'string' && typeof p.range === 'string'));
  check('owl.js 的类层级正确（Engine/Wheel ⊑ Part ⊑ Thing）', J(legacy.profile.classes.map((c) => `${c.key}(${c.label}|${c.parent})`)) === '["Thing(事物|)","Part(部件|Thing)","Engine(发动机|Part)","Wheel(轮子|Part)"]');

  // ======================================================================
  section('§4.5 makeTurtle 夹具自洽（供集成测试复用）');
  // ======================================================================
  const mini = await owlImport.importOwlExtended(writeFile(path.join(env.dir, 'mini3.ttl'), makeTurtle(3)), { previewOnly: true });
  check('makeTurtle(3) 产出 4 个类（根 + C1..C3）', mini.report.classCount === 4, J(mini.report.classCount));
  check('makeTurtle(3) 产出 1 个谓词', mini.report.predicateCount === 1);
  check('makeTurtle 的根类可用 opts.root 覆盖', (await owlImport.importOwlExtended(writeFile(path.join(env.dir, 'mini4.ttl'), makeTurtle(2, { root: 'Thing', rootLabel: '事物' })), { previewOnly: true })).profile.classes.some((c) => c.key === 'Thing' && c.label === '事物'));

  summary();
})().catch((err) => { console.error('测试执行异常：', err); process.exitCode = 1; });
