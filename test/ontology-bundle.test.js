// 体系化导入（bundle）测试：reason/ontologyBundle.js + graph.importBundle/previewBundleImport + IPC 通道
// 覆盖：依赖发现（本地/下载/缺失）、下载主机安全、合并（主本体优先/去重/完整性回校/跨文件 domain-range）、
//      端到端合并、落库与 resolveOntology、IPC 注册与往返。
// 全程离线：依赖要么本地预置，要么用注入的 _downloadImpl 桩，绝不触网。
// 运行：node test/ontology-bundle.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { bootEnv, mkCheck, writeFile, REPO_ROOT } = require('./helpers/harness');

const { check, section, summary } = mkCheck('体系化导入（bundle）');

// --- 合成夹具：主本体（仿 OGMS，只含类、内联引用 BFO/RO 的完整 IRI） ---
// ⚠ 用完整 IRI（非 obo: 前缀）：真实的 OBO 发布文件是 RDF/XML，IRI 内联出现，
//   collectExternalRefs 正是按正文里的 purl.obolibrary.org/obo/<PREFIX>_ 子串统计依赖。
const MAIN_OGMS = `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

<http://purl.obolibrary.org/obo/OGMS_0000031> a owl:Class ; rdfs:label "疾病" ; rdfs:subClassOf <http://purl.obolibrary.org/obo/BFO_0000016> ; rdfs:seeAlso <http://purl.obolibrary.org/obo/RO_0002131> .
<http://purl.obolibrary.org/obo/OGMS_0000020> a owl:Class ; rdfs:label "症状" ; rdfs:subClassOf <http://purl.obolibrary.org/obo/BFO_0000015> .
`;

// --- 依赖 BFO：3 个类（被主本体与 RO 引用） ---
const DEP_BFO = `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

<http://purl.obolibrary.org/obo/BFO_0000016> a owl:Class ; rdfs:label "disposition" .
<http://purl.obolibrary.org/obo/BFO_0000040> a owl:Class ; rdfs:label "material entity" .
<http://purl.obolibrary.org/obo/BFO_0000015> a owl:Class ; rdfs:label "process" .
`;

// --- 依赖 RO：1 个类 + 2 个对象属性（domain/range 指向 BFO 类，验证跨文件保留） ---
const DEP_RO = `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

<http://purl.obolibrary.org/obo/RO_0000000> a owl:Class ; rdfs:label "relation" .
<http://purl.obolibrary.org/obo/RO_0002131> a owl:ObjectProperty ; rdfs:label "overlaps" ; rdfs:domain <http://purl.obolibrary.org/obo/BFO_0000040> ; rdfs:range <http://purl.obolibrary.org/obo/BFO_0000040> .
<http://purl.obolibrary.org/obo/BFO_0000050> a owl:ObjectProperty , owl:TransitiveProperty ; rdfs:label "part of" ; rdfs:domain <http://purl.obolibrary.org/obo/BFO_0000040> ; rdfs:range <http://purl.obolibrary.org/obo/BFO_0000040> .
`;

// --- 下载桩写入的依赖 IDO：1 个类 ---
const DEP_IDO = `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

<http://purl.obolibrary.org/obo/IDO_0000001> a owl:Class ; rdfs:label "传染病" .
`;

// --- 第二个主本体：引用 IDO（本地不存在，用于下载/缺失分支） ---
const MAIN_MED2 = `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

<http://purl.obolibrary.org/obo/MED2_0000001> a owl:Class ; rdfs:label "感染" ; rdfs:seeAlso <http://purl.obolibrary.org/obo/IDO_0000001> .
`;

// --- 模块化本体夹具（仿 LKIF）：聚合入口 0 类、仅 owl:imports，依赖模块逐层展开 ---
// 主本体（聚合入口）：norm + legal-role；norm 再传递引入 action。
const LKIF_CORE = `@prefix owl: <http://www.w3.org/2002/07/owl#> .

<http://www.estrellaproject.org/lkif-core/lkif-core.owl> a owl:Ontology ;
  owl:imports <http://www.estrellaproject.org/lkif-core/norm.owl> ,
              <http://www.estrellaproject.org/lkif-core/legal-role.owl> .
`;
const LKIF_NORM = `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

<http://www.estrellaproject.org/lkif-core/norm.owl> a owl:Ontology ;
  owl:imports <http://www.estrellaproject.org/lkif-core/action.owl> .
<http://www.estrellaproject.org/lkif-core/norm.owl#Norm> a owl:Class ; rdfs:label "规范" .
<http://www.estrellaproject.org/lkif-core/norm.owl#prescribes> a owl:ObjectProperty ; rdfs:label "规定" .
`;
const LKIF_ACTION = `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

<http://www.estrellaproject.org/lkif-core/action.owl#Action> a owl:Class ; rdfs:label "行为" .
`;
const LKIF_LEGALROLE = `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

<http://www.estrellaproject.org/lkif-core/legal-role.owl#LegalRole> a owl:Class ; rdfs:label "法律角色" .
`;

(async () => {
  const env = await bootEnv({ prefix: 'synapse-bundle-' });
  const dir = env.dir;
  const ontoDir = path.join(env.dataRoot, 'ontology');
  const bundle = require(path.join(REPO_ROOT, 'src/main/graph/reason/ontologyBundle'));
  const graph = require(path.join(REPO_ROOT, 'src/main/graph/graph'));

  // 预置本地依赖（bfo.owl / ro.owl），主本体放沙箱根（不在 ontoDir，避免被当作自身依赖）
  writeFile(path.join(ontoDir, 'bfo.owl'), DEP_BFO);
  writeFile(path.join(ontoDir, 'ro.owl'), DEP_RO);
  const mainPath = writeFile(path.join(dir, 'ogms.ttl'), MAIN_OGMS);

  // ---------- 1. 依赖发现 ----------
  section('discoverDependencies — 本地依赖解析');
  const deps = await bundle.discoverDependencies(mainPath, { download: false });
  check('推断出 BFO 与 RO 两个依赖', deps.length === 2 && deps.some((d) => d.prefix === 'BFO') && deps.some((d) => d.prefix === 'RO'), JSON.stringify(deps.map((d) => d.prefix)));
  check('本地存在的依赖 source=local', deps.length === 2 && deps.every((d) => d.source === 'local'), JSON.stringify(deps.map((d) => [d.prefix, d.source])));
  check('每个依赖带 purl 与引用计数', deps.every((d) => /^http:\/\/purl\.obolibrary\.org\/obo\//.test(d.purl) && d.count > 0));
  check('排除自身前缀 OGMS', !deps.some((d) => d.prefix === 'OGMS'));
  check('引用计数：BFO×2 > RO×1', (deps.find((d) => d.prefix === 'BFO') || {}).count === 2 && (deps.find((d) => d.prefix === 'RO') || {}).count === 1, JSON.stringify(deps.map((d) => [d.prefix, d.count])));

  // ---------- 2. mergeProfiles 单元 ----------
  section('mergeProfiles — 主本体优先 / 去重 / 完整性回校');
  const mainP = {
    ok: true,
    profile: {
      name: 'ogms', sourceFile: 'ogms.ttl',
      classes: [{ key: 'disease', label: '疾病', parent: '', desc: '' }, { key: 'shared', label: '主版本', parent: '', desc: '' }],
      predicates: [], axioms: [], constraints: [],
    },
  };
  const depP = {
    ok: true, prefix: 'DEP',
    profile: {
      name: 'dep',
      classes: [{ key: 'shared', label: '依赖版本', parent: '', desc: '' }, { key: 'extra', label: '额外', parent: '', desc: '' }],
      predicates: [{ key: 'part_of', label: '部分', domain: '', range: '', features: [] }],
      axioms: [{ type: 'TransitiveProperty', subject: 'part_of', desc: '' }, { type: 'SubClassOf', subject: 'ghost', object: 'disease', desc: '' }],
      constraints: [{ desc: 'c1' }],
    },
  };
  const m = bundle.mergeProfiles(mainP, [depP], { displayName: 'merged', baseName: 'merged' });
  check('同 key 类保留主本体版本', (m.profile.classes.find((c) => c.key === 'shared') || {}).label === '主版本');
  check('依赖独有类被并入', m.profile.classes.some((c) => c.key === 'extra'));
  check('类去重（shared 只一个）', m.profile.classes.filter((c) => c.key === 'shared').length === 1);
  check('依赖谓词被并入', m.profile.predicates.some((p) => p.key === 'part_of'));
  check('依赖有效公理被并入', m.profile.axioms.some((a) => a.type === 'TransitiveProperty' && a.subject === 'part_of'));
  check('悬挂公理（ghost）被完整性回校丢弃', !m.profile.axioms.some((a) => a.subject === 'ghost') && m.report.droppedAxioms >= 1, String(m.report.droppedAxioms));
  check('依赖约束被并入', m.profile.constraints.some((c) => c.desc === 'c1'));
  check('bundle/owl 标记', m.profile.bundle === true && m.profile.owl === true);
  check('id 前缀 owl: 且取 baseName', m.profile.id === 'owl:merged', m.profile.id);
  check('sources 记录 main + dep', m.profile.sources.length === 2 && m.profile.sources[0].role === 'main' && m.profile.sources[1].role === 'dep');
  check('report.mergedSources=2', m.report.mergedSources === 2);
  const po = m.profile.predicates.find((p) => p.key === 'part_of');
  check('中文 label 谓词写入 aliases', po && Array.isArray(po.aliases) && po.aliases.includes('部分'), JSON.stringify(po && po.aliases));
  check('desc 说明合并来源数与计数', /2 个本体合并/.test(m.profile.desc) && /3类\/1谓词/.test(m.profile.desc), m.profile.desc);

  // ---------- 3. downloadFile 主机安全 ----------
  section('downloadFile — 主机/协议安全校验（不触网）');
  const badHost = await bundle.downloadFile('http://evil.com/x.owl', path.join(dir, 'x.owl'));
  check('非 purl 主机被拒', badHost.ok === false && /仅允许/.test(badHost.error), badHost.error);
  const badProto = await bundle.downloadFile('ftp://purl.obolibrary.org/obo/x.owl', path.join(dir, 'y.owl'));
  check('非 http(s) 协议被拒', badProto.ok === false && /http/.test(badProto.error), badProto.error);
  const badUrl = await bundle.downloadFile('not-a-url', path.join(dir, 'z.owl'));
  check('非法 URL 被拒', badUrl.ok === false && /URL/.test(badUrl.error), badUrl.error);

  // ---------- 4. download=false 时缺失依赖标 missing（先跑，避免下载桩写入本地文件干扰） ----------
  section('importBundle — download=false 缺失依赖标 missing');
  const mainMed = writeFile(path.join(dir, 'med2.ttl'), MAIN_MED2);
  const res3 = await bundle.importBundle({ mainPath: mainMed, download: false }, {});
  check('缺失依赖 source=missing', res3.dependencies.some((d) => d.prefix === 'IDO' && d.source === 'missing'), JSON.stringify(res3.dependencies.map((d) => [d.prefix, d.source])));
  check('缺失依赖未并入', !res3.profile.classes.some((c) => c.key === 'IDO_0000001'));
  check('preview 给出未获取警告', res3.preview.warnings.some((w) => /未能获取/.test(w)), JSON.stringify(res3.preview.warnings));

  // ---------- 5. download=true 自动下载缺失依赖（注入桩） ----------
  section('importBundle — 自动下载缺失依赖（fake impl）');
  const downloaded = [];
  const fakeDl = (url, dest) => {
    downloaded.push({ url, dest });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, DEP_IDO, 'utf8');
    return { ok: true, path: dest, bytes: fs.statSync(dest).size };
  };
  const res2 = await bundle.importBundle({ mainPath: mainMed, download: true }, { _downloadImpl: fakeDl });
  check('触发一次下载且目标为 ido.owl', downloaded.length === 1 && /ido\.owl$/.test(downloaded[0].dest), JSON.stringify(downloaded));
  check('下载 URL 为 IDO 的 purl', /\/obo\/ido\.owl$/.test(downloaded[0].url || ''), downloaded[0].url);
  check('下载依赖 source=downloaded', res2.dependencies.some((d) => d.prefix === 'IDO' && d.source === 'downloaded'), JSON.stringify(res2.dependencies.map((d) => [d.prefix, d.source])));
  check('下载的 IDO 类被并入', res2.profile.classes.some((c) => c.key === 'IDO_0000001' || c.label === '传染病'), JSON.stringify(res2.profile.classes.map((c) => c.key)));

  // ---------- 6. 端到端：本地依赖合并（ogms + bfo + ro） ----------
  section('importBundle — 本地依赖端到端合并');
  const res = await bundle.importBundle({ mainPath, download: false }, {});
  check('合并出主本体类（疾病/症状）', res.profile.classes.some((c) => c.label === '疾病') && res.profile.classes.some((c) => c.label === '症状'), JSON.stringify(res.profile.classes.map((c) => c.label)));
  check('合并出 BFO 类', res.profile.classes.some((c) => c.key === 'BFO_0000040'));
  check('合并出 RO 谓词（2 个）', res.profile.predicates.length === 2, String(res.profile.predicates.length));
  check('依赖清单全为 local', res.dependencies.length === 2 && res.dependencies.every((d) => d.source === 'local'));
  check('preview.counts.sources=3（主+BFO+RO）', res.preview.counts.sources === 3, String(res.preview.counts.sources));
  check('preview 带中英对照说明', res.preview.notes.some((n) => /中英对照/.test(n)));
  // 跨文件保留：主本体类的父类解析到 BFO；RO 谓词 domain/range 指向 BFO 类
  const diseaseCls = res.profile.classes.find((c) => c.label === '疾病');
  check('主本体类父类跨文件解析到 BFO_0000016', diseaseCls && diseaseCls.parent === 'BFO_0000016', JSON.stringify(diseaseCls));
  const partOf = res.profile.predicates.find((p) => p.key === 'BFO_0000050');
  check('RO 谓词 domain/range 合并后保留并解析到 BFO 类', partOf && partOf.domain === 'BFO_0000040' && res.profile.classes.some((c) => c.key === 'BFO_0000040'), JSON.stringify(partOf));
  check('传递性公理随 RO 并入', res.profile.axioms.some((a) => a.type === 'TransitiveProperty' && a.subject === 'BFO_0000050'));
  check('profile.id=owl:ogms、bundle=true', res.profile.id === 'owl:ogms' && res.profile.bundle === true, res.profile.id);

  // ---------- 7. graph 层：预览不落库 / 导入落库 / resolveOntology ----------
  section('graph.previewBundleImport / importBundle — 落库');
  const pv = await graph.previewBundleImport({ mainPath, download: false });
  check('previewBundleImport ok 且带 profile', pv.ok === true && pv.profile && pv.profile.classes.length > 0, JSON.stringify(pv.ok || pv.error));
  check('preview 不落库（listProfiles 无该体系）', !graph.listProfiles().some((p) => p.id === pv.profile.id));
  const imp = await graph.importBundle({ mainPath, download: false });
  check('importBundle 返回同一 id 的 profile', imp && imp.profile && imp.profile.id === pv.profile.id, JSON.stringify(imp && imp.profile && imp.profile.id));
  check('落库后 listProfiles 含该 owl 体系', graph.listProfiles().some((p) => p.id === imp.profile.id && p.owl === true));
  const resolved = graph.resolveOntology(imp.profile.id);
  check('resolveOntology 返回合并体系（有类有谓词）', resolved.classes.some((c) => c.label === '疾病') && resolved.predicates.length === 2, String(resolved.predicates.length));
  check('主本体源文件已复制到 data/ontology', fs.existsSync(path.join(ontoDir, 'ogms.ttl')));

  // ---------- 8. IPC 通道 ----------
  section('IPC 通道注册与往返');
  const { registerIpc } = require(path.join(REPO_ROOT, 'src/main/ipc'));
  registerIpc(() => ({ isDestroyed: () => false, webContents: { send: () => {} } }));
  check('graph:previewBundle 已注册', env.el.handlers.has('graph:previewBundle'));
  check('graph:importBundle 已注册', env.el.handlers.has('graph:importBundle'));
  const ipcPv = await env.el.invoke('graph:previewBundle', { mainPath, download: false });
  check('IPC previewBundle 往返 ok 且 sources=3', ipcPv.ok === true && ipcPv.preview && ipcPv.preview.counts.sources === 3, JSON.stringify({ ok: ipcPv.ok, err: ipcPv.error }));
  const ipcImp = await env.el.invoke('graph:importBundle', { mainPath, download: false });
  check('IPC importBundle 往返 ok 且 bundle=true', ipcImp.ok === true && ipcImp.profile && ipcImp.profile.bundle === true, JSON.stringify({ ok: ipcImp.ok, err: ipcImp.error }));
  const ipcNoMain = await env.el.invoke('graph:importBundle', {});
  check('IPC importBundle 无 mainPath 报错', ipcNoMain.ok === false && /未指定主本体/.test(ipcNoMain.error), ipcNoMain.error);

  // ---------- 9. owl:imports 传递闭包发现（模块化本体，仿 LKIF） ----------
  section('discoverDependencies — owl:imports 传递闭包');
  // 模块文件写入 ontoDir（名字与 import IRI 末段一致），聚合入口主本体放沙箱根
  writeFile(path.join(ontoDir, 'norm.owl'), LKIF_NORM);
  writeFile(path.join(ontoDir, 'action.owl'), LKIF_ACTION);
  writeFile(path.join(ontoDir, 'legal-role.owl'), LKIF_LEGALROLE);
  const corePath = writeFile(path.join(dir, 'lkif-core.ttl'), LKIF_CORE);

  // 单元：collectOwlImports / importBasename / resolveImportLocal
  check('collectOwlImports 抽取 Turtle owl:imports 目标', bundle.collectOwlImports(LKIF_CORE).length === 2, JSON.stringify(bundle.collectOwlImports(LKIF_CORE)));
  check('collectOwlImports 抽取 RDF/XML owl:imports', bundle.collectOwlImports('<owl:imports rdf:resource="http://x/a.owl"/>').includes('http://x/a.owl'));
  check('collectOwlImports 抽取 Functional Imports()', bundle.collectOwlImports('Ontology(<http://o> Imports(<http://x/b.owl>))').includes('http://x/b.owl'));
  check('importBasename 取末段并去 query/hash', bundle.importBasename('http://a/b/norm.owl?v=1#x') === 'norm.owl', bundle.importBasename('http://a/b/norm.owl?v=1#x'));
  check('resolveImportLocal 按 IRI 末段命中本地文件', /norm\.owl$/.test(bundle.resolveImportLocal('http://www.estrellaproject.org/lkif-core/norm.owl') || ''), String(bundle.resolveImportLocal('http://www.estrellaproject.org/lkif-core/norm.owl')));
  check('resolveImportLocal 词干换扩展名也可命中', !!bundle.resolveImportLocal('http://x/legal-role.rdf'));

  const ideps = await bundle.discoverDependencies(corePath, { download: false });
  check('owl:imports 发现 norm/legal-role 直接依赖', ideps.some((d) => d.prefix === 'norm') && ideps.some((d) => d.prefix === 'legal-role'), JSON.stringify(ideps.map((d) => d.prefix)));
  check('传递闭包展开到二级 action', ideps.some((d) => d.prefix === 'action'), JSON.stringify(ideps.map((d) => d.prefix)));
  check('三个依赖均 via=owl-import 且 source=local', ideps.length === 3 && ideps.every((d) => d.via === 'owl-import' && d.source === 'local'), JSON.stringify(ideps.map((d) => [d.prefix, d.via, d.source])));
  check('聚合入口自身不在依赖里', !ideps.some((d) => /lkif-core/.test(d.prefix)));
  check('无 OBO 内联引用（不误报 obo-ref）', !ideps.some((d) => d.via === 'obo-ref'));
  check('followImports=false 时不展开 imports', (await bundle.discoverDependencies(corePath, { download: false, followImports: false })).length === 0);

  // 端到端：聚合入口（0 类）作主本体 → 由模块提供全部内容
  const lres = await bundle.importBundle({ mainPath: corePath, download: false }, {});
  check('聚合入口解析为空主本体不报错', !!lres.profile, JSON.stringify(lres.profile && lres.profile.id));
  check('合并出 norm/action/legal-role 的类', ['规范', '行为', '法律角色'].every((l) => lres.profile.classes.some((c) => c.label === l)), JSON.stringify(lres.profile.classes.map((c) => c.label)));
  check('合并出 norm 的谓词（规定）', lres.profile.predicates.some((p) => p.label === '规定'), JSON.stringify(lres.profile.predicates.map((p) => p.key)));
  check('preview.counts.sources=4（空主+3模块）', lres.preview.counts.sources === 4, String(lres.preview.counts.sources));
  check('preview 依赖标 owl:imports', lres.preview.dependencies.some((d) => d.via === 'owl-import'));
  check('profile.id 取聚合入口名 owl:lkif-core', lres.profile.id === 'owl:lkif-core', lres.profile.id);

  summary();
})().catch((err) => {
  console.error('测试执行异常：', err);
  process.exitCode = 1;
});
