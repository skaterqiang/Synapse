// OWL 导入层测试：graph/owl.js（slugify / parseOwlFile：Turtle、RDF/XML、格式自动判定、截断、孤儿类、promptMode、fallback）
// 运行：node test/owl-import.test.js
const fs = require('fs');
const path = require('path');
const { bootEnv, mkCheck, writeFile, makeTurtle, REPO_ROOT } = require('./helpers/harness');

const { check, section, summary } = mkCheck('OWL 导入（owl.js）');

// RDF/XML 样例：简写式 + Description 式 + 多语言标签 + deprecated + Restriction + NamedIndividual
const RDF_XML = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#"
         xmlns:owl="http://www.w3.org/2002/07/owl#"
         xmlns:xsd="http://www.w3.org/2001/XMLSchema#">
  <owl:Class rdf:about="http://example.org/o#Thing">
    <rdfs:label xml:lang="en">Thing</rdfs:label>
    <rdfs:label xml:lang="zh">事物</rdfs:label>
    <rdfs:comment>顶层类</rdfs:comment>
  </owl:Class>
  <owl:Class rdf:about="http://example.org/o#Device">
    <rdfs:label>设备 &amp; 装置</rdfs:label>
    <rdfs:subClassOf rdf:resource="http://example.org/o#Thing"/>
  </owl:Class>
  <owl:Class rdf:about="http://example.org/o#Obsolete">
    <rdfs:label>已废弃</rdfs:label>
    <owl:deprecated rdf:datatype="http://www.w3.org/2001/XMLSchema#boolean">true</owl:deprecated>
  </owl:Class>
  <owl:ObjectProperty rdf:about="http://example.org/o#hasPart">
    <rdfs:label>包含</rdfs:label>
    <rdfs:comment>部件关系</rdfs:comment>
    <rdfs:domain rdf:resource="http://example.org/o#Device"/>
    <rdfs:range rdf:resource="http://example.org/o#Device"/>
  </owl:ObjectProperty>
  <rdf:Description rdf:about="http://example.org/o#partOf">
    <rdf:type rdf:resource="http://www.w3.org/2002/07/owl#ObjectProperty"/>
    <rdf:type rdf:resource="http://www.w3.org/2002/07/owl#TransitiveProperty"/>
    <rdfs:label xml:lang="zh">属于</rdfs:label>
    <rdfs:label xml:lang="en">part of</rdfs:label>
  </rdf:Description>
  <rdf:Description rdf:nodeID="A1">
    <rdf:type rdf:resource="http://www.w3.org/2002/07/owl#Restriction"/>
    <owl:onProperty rdf:resource="http://example.org/o#hasPart"/>
    <owl:minCardinality rdf:datatype="http://www.w3.org/2001/XMLSchema#nonNegativeInteger">1</owl:minCardinality>
  </rdf:Description>
  <rdf:Description rdf:nodeID="A2">
    <rdf:type rdf:resource="http://www.w3.org/2002/07/owl#Restriction"/>
    <owl:onProperty rdf:resource="http://example.org/o#partOf"/>
    <owl:someValuesFrom rdf:resource="http://example.org/o#Device"/>
  </rdf:Description>
  <rdf:Description rdf:about="http://example.org/o#pump1">
    <rdf:type rdf:resource="http://www.w3.org/2002/07/owl#NamedIndividual"/>
    <rdf:type rdf:resource="http://example.org/o#Pump"/>
  </rdf:Description>
</rdf:RDF>
`;

// 无 <?xml / <rdf:RDF 声明的片段：格式无法判定，走 auto 回退
const RDF_XML_BARE = `<owl:Class rdf:about="http://example.org/x#Alpha">
  <rdfs:label xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#">阿尔法</rdfs:label>
</owl:Class>
`;

const TURTLE_EXTRA = `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix ex: <http://example.org/t#> .

<http://example.org/t#FullUriClass> a owl:Class ; rdfs:label "完整URI类" .

ex:Orphan a owl:Class ; skos:prefLabel "孤儿类" ; rdfs:subClassOf ex:Missing .

ex:Card a owl:Class ; rdfs:label "卡片" ;
  rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ex:hasSlot ; owl:cardinality 2 ] .

ex:hasSlot a owl:ObjectProperty ; rdfs:label "有槽位" ; a owl:FunctionalProperty .

ex:Deprecated a owl:Class ; rdfs:label "废弃类" ; owl:deprecated true .
`;

(async () => {
  const env = await bootEnv({ prefix: 'synapse-owl-', db: false });
  const owl = require(path.join(REPO_ROOT, 'src/main/graph/owl'));
  const dir = env.dir;

  // ================= slugify =================
  section('slugify — 体系 ID 归一化');
  check('空格/大写 → 小写连字符', owl.slugify('My Ontology.owl') === 'my-ontology', owl.slugify('My Ontology.owl'));
  check('中文保留', owl.slugify('设备本体.ttl') === '设备本体', owl.slugify('设备本体.ttl'));
  check('中英混合保留中文', owl.slugify('Equip 设备_v2.rdf') === 'equip-设备-v2', owl.slugify('Equip 设备_v2.rdf'));
  check('仅剥离末尾扩展名', owl.slugify('a.b.c.owl') === 'a-b-c', owl.slugify('a.b.c.owl'));
  check('大写扩展名也可剥离', owl.slugify('onto.RDF') === 'onto', owl.slugify('onto.RDF'));
  check('首尾连字符被裁掉', owl.slugify('---x---') === 'x', owl.slugify('---x---'));
  check('全非法字符回退 custom', owl.slugify('！！！') === 'custom', owl.slugify('！！！'));
  check('空值回退 custom', owl.slugify('') === 'custom' && owl.slugify(null) === 'custom' && owl.slugify(undefined) === 'custom');
  check('超长截断到 40 字符', owl.slugify('a'.repeat(80)).length === 40, String(owl.slugify('a'.repeat(80)).length));

  // ================= Turtle 解析 =================
  section('parseOwlFile — Turtle');
  const ttlPath = writeFile(path.join(dir, 'equip.ttl'), fs.readFileSync(path.join(REPO_ROOT, 'test/fixtures/mini-equip.ttl'), 'utf-8'));
  const r1 = owl.parseOwlFile(ttlPath);
  const p1 = r1.profile;
  check('识别为 Turtle 格式', r1.report.format === 'Turtle', r1.report.format);
  check('类数量正确（6 个）', r1.report.classCount === 6, String(r1.report.classCount));
  check('谓词数量正确（3 个）', r1.report.predicateCount === 3, String(r1.report.predicateCount));
  check('id 前缀 owl:', p1.id === 'owl:equip', p1.id);
  check('name 去掉扩展名', p1.name === 'equip', p1.name);
  check('sourceFile 保留原名', p1.sourceFile === 'equip.ttl', p1.sourceFile);
  check('标记 owl:true', p1.owl === true);
  check('desc 含类/谓词统计与格式', /6类\/3谓词/.test(p1.desc) && p1.desc.includes('Turtle'), p1.desc);
  const cls = (k) => p1.classes.find((c) => c.key === k);
  check('rdfs:label 作为展示名', cls('Transformer').label === '变压器', cls('Transformer').label);
  check('rdfs:comment 作为描述', cls('Equipment').desc === '任何物理设备', cls('Equipment').desc);
  check('rdfs:subClassOf 作为父类', cls('Transformer').parent === 'PowerEquipment', cls('Transformer').parent);
  check('根类 parent 为空串', cls('Equipment').parent === '');
  check('code 保留完整 URI', cls('Equipment').code === 'http://example.org/equip#Equipment', cls('Equipment').code);
  check('examples 归一为空数组', Array.isArray(cls('Equipment').examples) && cls('Equipment').examples.length === 0);
  const pred = (k) => p1.predicates.find((x) => x.key === k);
  check('谓词 label/domain/range 解析', pred('supplies').label === '供电' && pred('supplies').domain === 'PowerEquipment' && pred('supplies').range === 'Equipment', JSON.stringify(pred('supplies')));
  check('SymmetricProperty → features', pred('connectsTo').features.includes('symmetric'), JSON.stringify(pred('connectsTo').features));
  check('无特征谓词 features 为空数组', Array.isArray(pred('maintains').features) && pred('maintains').features.length === 0);
  check('fallbackType 取语义最通用的根类', p1.fallbackType === 'Equipment', p1.fallbackType);
  check('fallbackRel 取首个谓词', p1.fallbackRel === 'supplies', p1.fallbackRel);
  check('6 类 ≤12 → promptMode=flat', p1.promptMode === 'flat', p1.promptMode);
  check('无孤儿类', r1.report.orphanClasses.length === 0, JSON.stringify(r1.report.orphanClasses));
  check('未截断', r1.report.truncated === false);

  section('parseOwlFile — Turtle 进阶语法');
  const r2 = owl.parseOwlFile(writeFile(path.join(dir, 'extra.ttl'), TURTLE_EXTRA));
  const p2 = r2.profile;
  check('完整 URI 主语可解析', p2.classes.some((c) => c.key === 'FullUriClass' && c.label === '完整URI类'), JSON.stringify(p2.classes.map((c) => c.key)));
  check('skos:prefLabel 也可作为展示名', p2.classes.find((c) => c.key === 'Orphan').label === '孤儿类');
  check('owl:deprecated true 的类被剔除', !p2.classes.some((c) => c.key === 'Deprecated'));
  check('FunctionalProperty → features', p2.predicates.find((x) => x.key === 'hasSlot').features.includes('functional'));
  check('Restriction 记为约束（含基数）', r2.report.constraintCount >= 1 && p2.constraints.some((c) => /hasSlot 约束/.test(c.desc) && /基数=2/.test(c.desc)), JSON.stringify(p2.constraints));
  check('约束项归一为 {desc} 对象', p2.constraints.every((c) => typeof c === 'object' && typeof c.desc === 'string'));
  check('孤儿类被检出', r2.report.orphanClasses.some((s) => s === 'Orphan (parent: Missing)'), JSON.stringify(r2.report.orphanClasses));
  check('匿名节点（Restriction）不进类表', !p2.classes.some((c) => !c.key));

  // ================= RDF/XML 解析 =================
  section('parseOwlFile — RDF/XML');
  const r3 = owl.parseOwlFile(writeFile(path.join(dir, 'onto.owl'), RDF_XML));
  const p3 = r3.profile;
  check('识别为 RDF/XML 格式', r3.report.format === 'RDF/XML', r3.report.format);
  check('简写式 owl:Class 解析', p3.classes.some((c) => c.key === 'Thing'));
  check('Description 式 owl:ObjectProperty 解析', p3.predicates.some((x) => x.key === 'partOf'));
  check('多语言标签优先取 zh', p3.classes.find((c) => c.key === 'Thing').label === '事物', p3.classes.find((c) => c.key === 'Thing').label);
  check('谓词多语言标签优先取 zh', p3.predicates.find((x) => x.key === 'partOf').label === '属于', p3.predicates.find((x) => x.key === 'partOf').label);
  check('XML 实体反转义', p3.classes.find((c) => c.key === 'Device').label === '设备 & 装置', p3.classes.find((c) => c.key === 'Device').label);
  check('rdfs:comment 解析', p3.classes.find((c) => c.key === 'Thing').desc === '顶层类');
  check('subClassOf rdf:resource 解析', p3.classes.find((c) => c.key === 'Device').parent === 'Thing');
  check('owl:deprecated true 的类被剔除', !p3.classes.some((c) => c.key === 'Obsolete'));
  check('TransitiveProperty → features', p3.predicates.find((x) => x.key === 'partOf').features.includes('transitive'), JSON.stringify(p3.predicates.find((x) => x.key === 'partOf').features));
  check('domain/range 解析', p3.predicates.find((x) => x.key === 'hasPart').domain === 'Device' && p3.predicates.find((x) => x.key === 'hasPart').range === 'Device');
  check('NamedIndividual 不计入实例但补全其类型类', p3.classes.some((c) => c.key === 'Pump') && !p3.classes.some((c) => c.key === 'pump1'), JSON.stringify(p3.classes.map((c) => c.key)));
  check('Restriction 记为约束（基数 + 取值范围）', p3.constraints.some((c) => /hasPart 约束/.test(c.desc) && /基数=1/.test(c.desc)) && p3.constraints.some((c) => /partOf 约束/.test(c.desc) && /取值范围=Device/.test(c.desc)), JSON.stringify(p3.constraints.map((c) => c.desc)));
  check('类计数 = Thing/Device/Pump', r3.report.classCount === 3, String(r3.report.classCount));
  check('谓词计数 = 2', r3.report.predicateCount === 2, String(r3.report.predicateCount));
  check('约束计数 = 2', r3.report.constraintCount === 2, String(r3.report.constraintCount));
  check('fallbackType 命中含 thing 语义的根类', p3.fallbackType === 'Thing', p3.fallbackType);
  check('fallbackRel 取首个谓词', p3.fallbackRel === 'hasPart', p3.fallbackRel);
  check('name 去掉 .owl 扩展名', p3.name === 'onto', p3.name);

  // ================= 格式自动判定 =================
  section('parseOwlFile — 格式自动判定与回退');
  const r4 = owl.parseOwlFile(writeFile(path.join(dir, 'bare.owl'), RDF_XML_BARE));
  check('无 XML 声明时 format=auto', r4.report.format === 'auto', r4.report.format);
  check('auto 模式 Turtle 失败后回退 RDF/XML', r4.report.classCount === 1 && r4.profile.classes[0].label === '阿尔法', JSON.stringify(r4.profile.classes));
  check('auto 模式 id 由文件名派生', r4.profile.id === 'owl:bare', r4.profile.id);
  check('非本体扩展名不剥离（.txt → bare-txt）', owl.parseOwlFile(writeFile(path.join(dir, 'bare2.txt'), RDF_XML_BARE)).profile.id === 'owl:bare2-txt');
  const r5 = owl.parseOwlFile(writeFile(path.join(dir, 'empty.ttl'), '# 只有注释，没有任何三元组\n'));
  check('空本体不抛错', r5.report.classCount === 0 && r5.report.predicateCount === 0, JSON.stringify(r5.report));
  check('空本体 fallbackType 回退 thing', r5.profile.fallbackType === 'thing', r5.profile.fallbackType);
  check('空本体 fallbackRel 回退「相关」', r5.profile.fallbackRel === '相关', r5.profile.fallbackRel);
  check('空本体 promptMode=flat', r5.profile.promptMode === 'flat');
  let e = '';
  try { owl.parseOwlFile(path.join(dir, '不存在.ttl')); } catch (err) { e = err.code || err.message; }
  check('文件不存在抛错', /ENOENT/.test(e), e);

  // ================= displayName =================
  section('parseOwlFile — displayName（web 上传带时间戳前缀）');
  const uploaded = writeFile(path.join(dir, '1712345678901-upload.ttl'), fs.readFileSync(path.join(REPO_ROOT, 'test/fixtures/mini-equip.ttl'), 'utf-8'));
  const r6 = owl.parseOwlFile(uploaded, { displayName: '电力设备体系.ttl' });
  check('id 用原始文件名', r6.profile.id === 'owl:电力设备体系', r6.profile.id);
  check('name 用原始文件名（去扩展名）', r6.profile.name === '电力设备体系', r6.profile.name);
  check('sourceFile 用原始文件名', r6.profile.sourceFile === '电力设备体系.ttl', r6.profile.sourceFile);
  check('desc 引用原始文件名', r6.profile.desc.includes('电力设备体系.ttl'), r6.profile.desc);
  const r7 = owl.parseOwlFile(uploaded, { displayName: 'sub/dir\\嵌套名.owl' });
  check('displayName 取 basename（跨平台分隔符）', r7.profile.name === '嵌套名', r7.profile.name);
  const r8 = owl.parseOwlFile(uploaded);
  check('未传 displayName 时用磁盘文件名', r8.profile.id === 'owl:1712345678901-upload', r8.profile.id);

  // ================= promptMode / 截断 =================
  section('parseOwlFile — promptMode 与超大本体截断');
  const r9 = owl.parseOwlFile(writeFile(path.join(dir, 'mid.ttl'), makeTurtle(20)));
  check('21 类 >12 → promptMode=two-stage', r9.profile.promptMode === 'two-stage', r9.profile.promptMode);
  check('未超 200 类不截断', r9.report.truncated === false && r9.report.classCount === 21, JSON.stringify(r9.report.classCount));
  const r12 = owl.parseOwlFile(writeFile(path.join(dir, 'twelve.ttl'), makeTurtle(11)));
  check('恰好 12 类 → promptMode=flat', r12.profile.promptMode === 'flat', r12.profile.promptMode);
  const r13 = owl.parseOwlFile(writeFile(path.join(dir, 'thirteen.ttl'), makeTurtle(12)));
  check('13 类 → promptMode=two-stage', r13.profile.promptMode === 'two-stage', r13.profile.promptMode);

  const r10 = owl.parseOwlFile(writeFile(path.join(dir, 'big.ttl'), makeTurtle(250)));
  check('251 类触发截断', r10.report.truncated === true);
  check('report 保留原始类数', r10.report.originalClassCount === 251, String(r10.report.originalClassCount));
  check('截断后只保留根类 + 第一层（11 个）', r10.report.classCount === 11 && r10.profile.classes.length === 11, String(r10.profile.classes.length));
  check('截断保留根类', r10.profile.classes.some((c) => c.key === 'Entity'));
  check('截断保留第一层子类', r10.profile.classes.filter((c) => c.parent === 'Entity').length === 10);
  check('截断剔除第二层及更深', !r10.profile.classes.some((c) => c.key === 'C11'), JSON.stringify(r10.profile.classes.map((c) => c.key)));
  check('截断后无孤儿类', r10.report.orphanClasses.length === 0, JSON.stringify(r10.report.orphanClasses));
  check('截断不丢谓词', r10.report.predicateCount === 1 && r10.profile.predicates[0].key === 'rel1');

  // ================= fallbackType 选择规则 =================
  section('parseOwlFile — fallbackType 选择规则');
  const r11 = owl.parseOwlFile(writeFile(path.join(dir, 'odd.ttl'), makeTurtle(3, { root: 'CustomRoot', rootLabel: '自定义根' })));
  check('根类无语义命中时取首个根类', r11.profile.fallbackType === 'CustomRoot', r11.profile.fallbackType);
  const multiRoot = `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ex: <http://example.org/m#> .

ex:Alpha a owl:Class ; rdfs:label "阿尔法" .
ex:Beta a owl:Class ; rdfs:label "贝塔" .
ex:Gamma a owl:Class ; rdfs:label "伽马" .
ex:Root a owl:Class ; rdfs:label "事物根" .
ex:Sub a owl:Class ; rdfs:label "子类" ; rdfs:subClassOf ex:Root .
`;
  const r14 = owl.parseOwlFile(writeFile(path.join(dir, 'multiroot.ttl'), multiRoot));
  check('多根类时优先取语义通用者（非首个）', r14.profile.fallbackType === 'Root', r14.profile.fallbackType);
  check('全部根类都参与统计', r14.report.classCount === 5, String(r14.report.classCount));
  const noRoot = `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ex: <http://example.org/n#> .

ex:A a owl:Class ; rdfs:subClassOf ex:B .
ex:B a owl:Class ; rdfs:subClassOf ex:A .
`;
  const r15 = owl.parseOwlFile(writeFile(path.join(dir, 'noroot.ttl'), noRoot));
  check('无根类（循环父子）时取首个类', r15.profile.fallbackType === 'A', r15.profile.fallbackType);
  check('循环父子双方都记为孤儿类', r15.report.orphanClasses.length === 0, JSON.stringify(r15.report.orphanClasses));

  summary();
})().catch((err) => {
  console.error('测试执行异常：', err);
  process.exitCode = 1;
});
