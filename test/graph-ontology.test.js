// 知识图谱本体层模块测试（graph/graph.js）
// 覆盖：kv v3 读取与 v1 迁移、resolveOntology 基座+用户层合并、listProfiles、
//      nodeTypesMap / relationsList / fallbackType / fallbackRel、
//      getOntology 实例统计与 builtin/custom 标记、setOntologyProfile、
//      saveOntologyItem / removeOntologyItem（内置只读保护）、
//      importOwl / removeOwlProfile、extractGraph 抽取与合并、
//      recallFor / contextFor、questionTokens、listGraphScopes / scopeFilter、
//      resolveSources、kgAsk 管线。
// 运行：node test/graph-ontology.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { bootEnv, mkCheck, startFakeLlm, sseText, writeFile, makeTurtle } = require('./helpers/harness');

const { check, section, summary } = mkCheck('知识图谱本体层（graph.js）');
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const json = (obj) => ({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, sse: sseText(JSON.stringify(obj)) });

(async () => {
  const env = await bootEnv({ prefix: 'synapse-graph-' });
  const dir = env.dir;
  const graph = require('../src/main/graph/graph');
  const notesStore = require('../src/main/notes/store');
  const settingsMod = require('../src/main/common/settings');
  const { ONTOLOGY_KEY } = require('../src/main/common/constants');

  const db = env.db;
  const getKv = (k) => JSON.parse(db.getKv(k) || 'null');
  const setKv = (k, v) => { db.setKv(k, JSON.stringify(v)); db.flush(); };

  // ---------- 1. kv 读取与 v1 迁移 ----------
  section('readOntologyKv / v1 迁移');
  check('空 kv → 默认 bfo-lite 空层', (() => {
    setKv(ONTOLOGY_KEY, null);
    const o = graph.resolveOntology();
    return o.id === 'bfo-lite' && o.classes.length > 0;
  })());
  check('v3 结构原样返回', (() => {
    setKv(ONTOLOGY_KEY, { profileId: 'bfo', userClasses: [{ key: 'X1', label: '自定义1', parent: '', desc: '', examples: [], from: 'custom' }], userPredicates: [], userConstraints: [], owlProfiles: [] });
    const o = graph.resolveOntology('bfo');
    return o.classes.some((c) => c.key === 'X1' && c.from === 'custom');
  })());
  check('v1 扁平结构迁移为 bfo-lite 用户层', (() => {
    setKv(ONTOLOGY_KEY, { classes: [{ key: 'OldClass', label: '旧类', desc: '旧' }], predicates: [{ key: '旧谓词', desc: 'x' }], constraints: ['旧约束'] });
    const o = graph.resolveOntology('bfo-lite');
    const migrated = o.classes.some((c) => c.key === 'OldClass' && c.from === 'custom')
      && o.predicates.some((p) => p.key === '旧谓词' && p.from === 'custom')
      && o.constraints.some((c) => c.desc === '旧约束' && c.from === 'custom');
    setKv(ONTOLOGY_KEY, null);
    return migrated;
  })());

  // ---------- 2. resolveOntology 合并 ----------
  section('resolveOntology — 基座+用户层合并');
  check('省略 profileId 用 kv 当前值', (() => {
    setKv(ONTOLOGY_KEY, { profileId: 'bfo', userClasses: [], userPredicates: [], userConstraints: [], owlProfiles: [] });
    return graph.resolveOntology().id === 'bfo';
  })());
  check('owl:* 缺失回退 bfo-lite', (() => {
    setKv(ONTOLOGY_KEY, { profileId: 'bfo-lite', userClasses: [], userPredicates: [], userConstraints: [], owlProfiles: [] });
    return graph.resolveOntology('owl:nonexistent').id === 'bfo-lite';
  })());
  check('同 key 用户类覆盖基座类并标 from:custom', (() => {
    setKv(ONTOLOGY_KEY, { profileId: 'bfo-lite', userClasses: [{ key: 'object', label: '改名的物体', parent: '', desc: '覆盖', examples: [], from: 'custom' }], userPredicates: [], userConstraints: [], owlProfiles: [] });
    const o = graph.resolveOntology('bfo-lite');
    const c = o.classes.find((x) => x.key === 'object');
    return c.label === '改名的物体' && c.from === 'custom';
  })());
  check('新增用户类追加到末尾', (() => {
    setKv(ONTOLOGY_KEY, { profileId: 'bfo-lite', userClasses: [{ key: 'MyNew', label: '新增', parent: 'object', desc: '', examples: [], from: 'custom' }], userPredicates: [], userConstraints: [], owlProfiles: [] });
    const o = graph.resolveOntology('bfo-lite');
    return o.classes[o.classes.length - 1].key === 'MyNew' && o.classes[o.classes.length - 1].from === 'custom';
  })());
  check('同 key 用户谓词覆盖基座谓词', (() => {
    setKv(ONTOLOGY_KEY, { profileId: 'bfo-lite', userClasses: [], userPredicates: [{ key: '属于', label: '改', desc: '覆盖', from: 'custom' }], userConstraints: [], owlProfiles: [] });
    return graph.resolveOntology('bfo-lite').predicates.find((p) => p.key === '属于').from === 'custom';
  })());
  check('基座约束与用户约束合并（字符串→{desc,from}）', (() => {
    setKv(ONTOLOGY_KEY, { profileId: 'bfo-lite', userClasses: [], userPredicates: [], userConstraints: [{ desc: '用户约束', from: 'custom' }], owlProfiles: [] });
    const o = graph.resolveOntology('bfo-lite');
    return o.constraints.some((c) => c.from === 'base') && o.constraints.some((c) => c.desc === '用户约束' && c.from === 'custom');
  })());
  setKv(ONTOLOGY_KEY, null);

  // ---------- 3. listProfiles ----------
  section('listProfiles');
  check('内置三体系齐全且带计数', (() => {
    const list = graph.listProfiles();
    const ids = list.map((p) => p.id);
    return ['bfo-lite', 'bfo', 'iso15926'].every((id) => ids.includes(id)) && list.every((p) => p.counts && p.counts.classes >= 0);
  })());
  check('OWL 体系并入列表', (() => {
    const kv = getKv(ONTOLOGY_KEY) || { profileId: 'bfo-lite', userClasses: [], userPredicates: [], userConstraints: [], owlProfiles: [] };
    kv.owlProfiles = [{ id: 'owl:test', name: '测试OWL', desc: 'd', classes: [{ key: 'A', label: 'A' }], predicates: [], constraints: [] }];
    setKv(ONTOLOGY_KEY, kv);
    const list = graph.listProfiles();
    setKv(ONTOLOGY_KEY, null);
    return list.some((p) => p.id === 'owl:test' && p.owl === true && p.counts.classes === 1);
  })());

  // ---------- 4. nodeTypesMap / relationsList / fallback ----------
  section('nodeTypesMap / relationsList / fallback');
  check('类表 key 集合包含核心类', (() => {
    const keys = graph.getOntology('bfo-lite').classes.map((c) => c.key);
    return ['thing', 'object', 'process', 'information'].every((k) => keys.includes(k));
  })());
  check('relationsList 返回谓词 key 数组', (() => {
    const rels = graph.getOntology('bfo-lite').predicates.map((p) => p.key);
    return rels.includes('属于') && rels.includes('相关');
  })());
  check('fallbackType 用体系 fallbackType 字段', (() => {
    const o = graph.resolveOntology('bfo-lite');
    return o.fallbackType === 'object' && graph.getOntology('bfo-lite').classes.some((c) => c.key === o.fallbackType);
  })());
  check('fallbackRel 用体系 fallbackRel 字段', (() => {
    const o = graph.resolveOntology('bfo-lite');
    return o.fallbackRel === '相关' && graph.getOntology('bfo-lite').predicates.some((p) => p.key === o.fallbackRel);
  })());
  check('bfo 体系 fallbackType=material_entity', graph.resolveOntology('bfo').fallbackType === 'material_entity');

  // ---------- 5. getOntology 实例统计 ----------
  section('getOntology');
  graph.clearGraph();
  graph.saveGraph([
    { id: 'bfo-lite:充电桩', name: '充电桩', type: 'object', desc: '', sources: [], domain: '', profile: 'bfo-lite' },
    { id: 'bfo-lite:变压器', name: '变压器', type: 'object', desc: '', sources: [], domain: '', profile: 'bfo-lite' },
    { id: 'bfo:某物', name: '某物', type: 'material_entity', desc: '', sources: [], domain: '', profile: 'bfo' },
  ], []);
  const onto = graph.getOntology('bfo-lite');
  check('classes 带实例计数', onto.classes.find((c) => c.key === 'object').instances === 2, String(onto.classes.find((c) => c.key === 'object').instances));
  check('classes 带 builtin/custom 标记', onto.classes.some((c) => c.builtin === true) && (() => {
    const kv = getKv(ONTOLOGY_KEY) || { profileId: 'bfo-lite', userClasses: [], userPredicates: [], userConstraints: [], owlProfiles: [] };
    kv.userClasses = [{ key: 'MyCustom', label: '自定义', parent: '', desc: '', examples: [], from: 'custom' }];
    setKv(ONTOLOGY_KEY, kv);
    const o2 = graph.getOntology('bfo-lite');
    setKv(ONTOLOGY_KEY, null);
    return o2.classes.find((c) => c.key === 'MyCustom').custom === true;
  })());
  check('stats 汇总正确', onto.stats.instanceCount === 3 && onto.stats.classCount === onto.classes.length && onto.stats.edgeCount === 0, JSON.stringify(onto.stats));
  check('profiles 列表附带', Array.isArray(onto.profiles) && onto.profiles.length >= 3);
  check('owlProfiles 摘要列表', Array.isArray(onto.owlProfiles));

  // ---------- 6. setOntologyProfile ----------
  section('setOntologyProfile');
  check('切换内置体系', (() => {
    const r = graph.setOntologyProfile('bfo');
    return r.profileId === 'bfo' && getKv(ONTOLOGY_KEY).profileId === 'bfo';
  })());
  check('切换到 OWL 体系', (() => {
    const kv = getKv(ONTOLOGY_KEY);
    kv.owlProfiles = [{ id: 'owl:x', name: 'X', desc: '', classes: [{ key: 'A', label: 'A' }], predicates: [], constraints: [] }];
    setKv(ONTOLOGY_KEY, kv);
    const r = graph.setOntologyProfile('owl:x');
    setKv(ONTOLOGY_KEY, null);
    return r.profileId === 'owl:x';
  })());
  check('未知体系抛错', (() => {
    try { graph.setOntologyProfile('nope'); return false; } catch (e) { return /未知本体体系：nope/.test(e.message); }
  })());
  setKv(ONTOLOGY_KEY, null);

  // ---------- 7. saveOntologyItem / removeOntologyItem ----------
  section('saveOntologyItem / removeOntologyItem');
  check('新增类（合法 key）', (() => {
    const r = graph.saveOntologyItem('classes', { key: 'NewCls', label: '新类', parent: 'object', desc: 'd', examples: ['e1'] }, 'bfo-lite');
    return r.classes.some((c) => c.key === 'NewCls' && c.custom === true);
  })());
  check('非法 key 抛错', (() => {
    try { graph.saveOntologyItem('classes', { key: '1bad', label: 'x' }, 'bfo-lite'); return false; } catch (e) { return /标识键须为英文标识符/.test(e.message); }
  })());
  check('空 label 抛错', (() => {
    try { graph.saveOntologyItem('classes', { key: 'Good', label: ' ' }, 'bfo-lite'); return false; } catch (e) { return /名称不能为空/.test(e.message); }
  })());
  check('同 key 覆盖（更新）', (() => {
    graph.saveOntologyItem('classes', { key: 'NewCls', label: '改名后', parent: '', desc: '', examples: [] }, 'bfo-lite');
    return graph.getOntology('bfo-lite').classes.find((c) => c.key === 'NewCls').label === '改名后';
  })());
  check('examples 截断到 8 个', (() => {
    const r = graph.saveOntologyItem('classes', { key: 'Ex8', label: 'Ex', parent: '', desc: '', examples: ['1','2','3','4','5','6','7','8','9','10'] }, 'bfo-lite');
    return r.classes.find((c) => c.key === 'Ex8').examples.length === 8;
  })());
  check('新增谓词', (() => {
    const r = graph.saveOntologyItem('predicates', { key: '驱动', label: '驱动', desc: '' }, 'bfo-lite');
    return r.predicates.some((p) => p.key === '驱动' && p.custom === true);
  })());
  check('空谓词 key 抛错', (() => {
    try { graph.saveOntologyItem('predicates', { key: ' ' }, 'bfo-lite'); return false; } catch (e) { return /谓词名称不能为空/.test(e.message); }
  })());
  check('新增约束（追加）', (() => {
    const r = graph.saveOntologyItem('constraints', { desc: '新约束' }, 'bfo-lite');
    return r.constraints.some((c) => c.desc === '新约束' && c.from === 'custom');
  })());
  check('约束按 index 覆盖', (() => {
    const kv = getKv(ONTOLOGY_KEY);
    kv.userConstraints = [{ desc: '原约束', from: 'custom' }];
    setKv(ONTOLOGY_KEY, kv);
    graph.saveOntologyItem('constraints', { desc: '覆盖约束', index: 0 }, 'bfo-lite');
    return graph.getOntology('bfo-lite').constraints.find((c) => c.desc === '覆盖约束' && c.from === 'custom') !== undefined;
  })());
  check('空约束抛错', (() => {
    try { graph.saveOntologyItem('constraints', { desc: ' ' }, 'bfo-lite'); return false; } catch (e) { return /约束内容不能为空/.test(e.message); }
  })());
  check('删除自定义类', (() => {
    graph.removeOntologyItem('classes', 'NewCls', 'bfo-lite');
    return !graph.getOntology('bfo-lite').classes.some((c) => c.key === 'NewCls');
  })());
  check('内置基座类只读不可删', (() => {
    try { graph.removeOntologyItem('classes', 'object', 'bfo-lite'); return false; } catch (e) { return e.code === 'BUILTIN_READONLY' && /内置基座类只读，不可删除/.test(e.message); }
  })());
  check('删除不存在的自定义类抛错', (() => {
    try { graph.removeOntologyItem('classes', 'NoSuch', 'bfo-lite'); return false; } catch (e) { return /未找到自定义类：NoSuch/.test(e.message); }
  })());
  check('删除自定义谓词', (() => {
    graph.saveOntologyItem('predicates', { key: '临时', label: '临时' }, 'bfo-lite');
    graph.removeOntologyItem('predicates', '临时', 'bfo-lite');
    return !graph.getOntology('bfo-lite').predicates.some((p) => p.key === '临时');
  })());
  check('内置基座谓词只读不可删', (() => {
    try { graph.removeOntologyItem('predicates', '属于', 'bfo-lite'); return false; } catch (e) { return e.code === 'BUILTIN_READONLY'; }
  })());
  check('删除约束按 index', (() => {
    const kv = getKv(ONTOLOGY_KEY);
    const before = kv.userConstraints.length;
    graph.removeOntologyItem('constraints', 0, 'bfo-lite');
    return getKv(ONTOLOGY_KEY).userConstraints.length === before - 1;
  })());
  setKv(ONTOLOGY_KEY, null);

  // ---------- 8. importOwl / removeOwlProfile ----------
  section('importOwl / removeOwlProfile');
  const owlFile = writeFile(path.join(dir, 'mini.ttl'), makeTurtle(3));
  const imp = graph.importOwl(owlFile);
  check('导入返回 profile 与 report', imp.profile.id === 'owl:mini' && imp.report.classCount === 4, JSON.stringify(imp.report));
  check('源文件复制到 data/ontology', fs.existsSync(path.join(env.dataRoot, 'ontology', 'mini.ttl')));
  check('导入后可切换体系', graph.setOntologyProfile('owl:mini').profileId === 'owl:mini');
  check('removeOwlProfile 删除体系', (() => {
    const r = graph.removeOwlProfile('owl:mini', false);
    return r.ok === true && r.removed.id === 'owl:mini' && !graph.listProfiles().some((p) => p.id === 'owl:mini');
  })());
  check('删除不存在的体系返回错误', graph.removeOwlProfile('owl:nope', false).error === '体系不存在');
  // 连带清节点
  graph.saveGraph([
    { id: 'owl:x:a', name: 'A', type: 'A', desc: '', sources: [], domain: '', profile: 'owl:x' },
    { id: 'bfo-lite:b', name: 'B', type: 'object', desc: '', sources: [], domain: '', profile: 'bfo-lite' },
  ], [{ from: 'owl:x:a', to: 'bfo-lite:b', rel: '相关' }]);
  const kv2 = getKv(ONTOLOGY_KEY);
  kv2.owlProfiles = [{ id: 'owl:x', name: 'X', desc: '', classes: [], predicates: [], constraints: [] }];
  setKv(ONTOLOGY_KEY, kv2);
  const rm2 = graph.removeOwlProfile('owl:x', true);
  check('clearGraphNodes 连带清除该体系节点与边', rm2.clearedNodes === 1 && graph.getGraph().nodes.length === 1 && graph.getGraph().edges.length === 0, JSON.stringify(rm2));
  setKv(ONTOLOGY_KEY, null);
  graph.clearGraph();

  // ---------- 9. extractGraph ----------
  section('extractGraph');
  graph.clearGraph();
  const fake = await startFakeLlm(({ url, body, n }) => {
    if (url.endsWith('/chat/completions')) {
      return json({
        nodes: [
          { name: '充电桩', type: 'object', desc: '终端充电设施' },
          { name: '变压器', type: 'object', desc: '电压变换设备' },
          { name: '配电房', type: 'object', desc: '配电场所' },
        ],
        edges: [
          { from: '变压器', to: '充电桩', rel: '属于' },
          { from: '配电房', to: '变压器', rel: '包含' },
        ],
      });
    }
    return { status: 404, text: 'no' };
  });
  const settings = { ...settingsMod.getSettings(), ...fake.settings(), ontologyProfile: 'bfo-lite', chatRetries: 0, graphConcurrency: 1 };

  // inlineSources
  const r1 = await graph.extractGraph(settings, { inlineSources: [{ label: '笔记·充电桩', text: '充电桩与变压器' }] }, () => {}, () => {}, () => {});
  check('inlineSources 抽取成功（合并后总数）', r1.nodeCount === 3 && r1.edgeCount === 2, JSON.stringify({ n: r1.nodeCount, e: r1.edgeCount }));
  check('节点带 profile 前缀 id', r1.profileId === 'bfo-lite' && graph.getGraph().nodes.every((x) => x.id.startsWith('bfo-lite:')));
  check('节点名去重合并', graph.getGraph().nodes.filter((x) => x.name === '充电桩').length === 1);
  check('体系名回传', r1.profileName === 'BFO-Lite 轻量体系');
  check('来源标签挂到节点', graph.getGraph().nodes.find((x) => x.name === '充电桩').sources.includes('笔记·充电桩'));

  // 非法 type 回退 fallbackType（隔离图：清空后仅跑本例）
  graph.clearGraph();
  const badType = await startFakeLlm(() => json({ nodes: [{ name: 'X', type: 'NotAType', desc: '' }], edges: [] }));
  await graph.extractGraph({ ...settings, ...badType.settings() }, { inlineSources: [{ label: 'l', text: 'X' }] }, () => {}, () => {}, () => {});
  await badType.close();
  check('非法 type 回退 fallbackType', graph.getGraph().nodes.find((x) => x.name === 'X').type === 'object');

  // 非法 rel 回退 fallbackRel
  graph.clearGraph();
  const badRel = await startFakeLlm(() => json({ nodes: [{ name: 'Y1', type: 'object', desc: '' }, { name: 'Y2', type: 'object', desc: '' }], edges: [{ from: 'Y1', to: 'Y2', rel: 'NotARel' }] }));
  await graph.extractGraph({ ...settings, ...badRel.settings() }, { inlineSources: [{ label: 'l', text: 'Y1 Y2' }] }, () => {}, () => {}, () => {});
  await badRel.close();
  check('非法 rel 回退 fallbackRel', (() => {
    const g = graph.getGraph();
    const e = g.edges.find((x) => x.from.includes('y1') && x.to.includes('y2'));
    return !!e && e.rel === '相关';
  })());

  // 自环边被过滤
  graph.clearGraph();
  const selfLoop = await startFakeLlm(() => json({ nodes: [{ name: 'Z', type: 'object', desc: '' }], edges: [{ from: 'Z', to: 'Z', rel: '属于' }] }));
  await graph.extractGraph({ ...settings, ...selfLoop.settings() }, { inlineSources: [{ label: 'l', text: 'Z' }] }, () => {}, () => {}, () => {});
  await selfLoop.close();
  check('自环边被过滤', graph.getGraph().edges.every((e) => e.from !== e.to) && graph.getGraph().nodes.some((x) => x.name === 'Z'));

  // rawPaths（隔离图）
  graph.clearGraph();
  const rawDir = path.join(dir, 'wiki');
  writeFile(path.join(rawDir, 'raw', '电力.md'), '变压器为充电桩供电。');
  const r2 = await graph.extractGraph({ ...settings, wikiRoot: rawDir }, {
    rawPaths: ['raw/电力.md'],
    readRaw: (rel) => require('../src/main/raws/files').readRawText({ ...settings, wikiRoot: rawDir }, rel),
  }, () => {}, () => {}, () => {});
  check('rawPaths 抽取成功', r2.sourceCount === 1 && r2.nodeCount === 3);
  check('rawPaths 来源标签为 原始·文件名', graph.getGraph().nodes.some((x) => x.sources.some((s) => s === '原始·电力.md')), JSON.stringify(graph.getGraph().nodes.map((x) => x.sources)));

  // 空 inlineSources（全空白）→ 抛「笔记内容为空」
  await graph.extractGraph(settings, { inlineSources: [{ label: 'l', text: '   ' }] }, () => {}, () => {}, () => {})
    .then(() => check('空 inlineSources 抛错', false))
    .catch((e) => check('空 inlineSources 抛错', /笔记内容为空，无法抽取/.test(e.message)));

  // 空范围（无笔记无 rawPaths）→ 抛「选定范围内没有」
  await graph.extractGraph({ ...settings, wikiRoot: path.join(dir, 'empty-wiki') }, {}, () => {}, () => {}, () => {})
    .then(() => check('空范围抛错', false))
    .catch((e) => check('空范围抛错', /选定范围内没有可抽取的内容/.test(e.message)));

  // resolveDomain 回填 domain（隔离图）
  graph.clearGraph();
  await graph.extractGraph(settings, {
    inlineSources: [{ label: 'l', text: '充电桩' }],
    resolveDomain: async () => ({ domainId: 'ev', domainLabel: '电力', typeHints: { entity: ['充电桩'], concept: [] } }),
  }, () => {}, () => {}, () => {});
  check('resolveDomain 回填 domain', graph.getGraph().nodes.find((x) => x.name === '充电桩').domain === 'ev');

  // 体系优先级：弹窗显式指定 > settings 默认（不显式传 ontologyProfile 时用 settings.ontologyProfile）
  check('settings.ontologyProfile 作为默认体系', (() => {
    const o = graph.resolveOntology(settings.ontologyProfile || 'bfo-lite');
    return o.id === 'bfo-lite';
  })());

  // two-stage（bfo 体系 promptMode=two-stage）——显式指定体系优先于 settings
  graph.clearGraph();
  const two = await startFakeLlm(({ url, body, n }) => {
    if (url.endsWith('/chat/completions')) {
      const txt = (body.messages || []).map((m) => m.content).join('\n');
      if (/【第一步·粗分类】/.test(txt)) return json({ nodes: [{ name: 'M1', type: 'material_entity', desc: '' }], edges: [] });
      if (/【第二步·细分类】/.test(txt)) return json({ nodes: [{ name: 'M1', type: 'material_entity' }] });
      return json({ nodes: [], edges: [] });
    }
    return { status: 404, text: 'no' };
  });
  const rTwo = await graph.extractGraph({ ...settings, ...two.settings(), ontologyProfile: 'bfo' }, { inlineSources: [{ label: 'l', text: 'M1' }] }, () => {}, () => {}, () => {});
  const twoReqs = two.requests.filter((r) => r.url.endsWith('/chat/completions')).length;
  await two.close();
  check('bfo 体系走 two-stage 抽取（粗分+细分两次调用）', rTwo.profileId === 'bfo' && twoReqs === 2 && graph.getGraph().nodes.every((x) => x.id.startsWith('bfo:')), 'reqs=' + twoReqs);

  // 部分失败（响应内容按来源文本区分，确定性地让第一批失败）
  graph.clearGraph();
  const part = await startFakeLlm(({ body }) => {
    const txt = (body && body.messages || []).map((m) => m.content).join('\n');
    if (/=== 来源: l1 ===/.test(txt)) return { status: 500, text: 'boom' };
    return json({ nodes: [{ name: 'PB', type: 'object', desc: '' }], edges: [] });
  });
  const rPart = await graph.extractGraph({ ...settings, ...part.settings(), graphConcurrency: 1 }, { inlineSources: [{ label: 'l1', text: 'PA' }, { label: 'l2', text: 'PB' }] }, () => {}, () => {}, () => {});
  await part.close();
  check('单批失败不拖死整体，failedTasks 记录', Array.isArray(rPart.failedTasks) && rPart.failedTasks.length === 1 && rPart.failedTasks[0].taskNo === 1 && graph.getGraph().nodes.some((x) => x.name === 'PB'), JSON.stringify(rPart.failedTasks));

  // 全部失败抛错
  const allBad = await startFakeLlm(() => ({ status: 500, text: 'boom' }));
  await graph.extractGraph({ ...settings, ...allBad.settings(), chatRetries: 0 }, { inlineSources: [{ label: 'l', text: 'A' }] }, () => {}, () => {}, () => {})
    .then(() => check('全部失败抛错', false))
    .catch((e) => check('全部失败抛错', /全部 1 个来源抽取失败/.test(e.message)));
  await allBad.close();

  // 跨体系合并共存：bfo-lite 与 bfo 节点同图保留
  graph.clearGraph();
  await graph.extractGraph(settings, { inlineSources: [{ label: 'l', text: '共存物' }] }, () => {}, () => {}, () => {});
  const liteNode = graph.getGraph().nodes.find((x) => x.name === '充电桩');
  await graph.extractGraph({ ...settings, ontologyProfile: 'bfo' }, { inlineSources: [{ label: 'l2', text: '共存物bfo' }] }, () => {}, () => {}, () => {}).catch(() => {});
  check('跨体系节点共存（bfo-lite 与 bfo 前缀并存）', (() => {
    const g = graph.getGraph();
    return g.nodes.some((x) => x.id.startsWith('bfo-lite:')) && g.nodes.some((x) => x.id.startsWith('bfo:'));
  })());

  await fake.close();

  // ---------- 10. questionTokens / recallFor / contextFor ----------
  section('questionTokens / recallFor / contextFor');
  graph.clearGraph();
  graph.saveGraph([
    { id: 'bfo-lite:充电桩', name: '充电桩', type: 'object', desc: '终端充电设施', sources: ['笔记·电力'], domain: '', profile: 'bfo-lite' },
    { id: 'bfo-lite:变压器', name: '变压器', type: 'object', desc: '电压变换设备', sources: [], domain: '', profile: 'bfo-lite' },
    { id: 'bfo-lite:配电房', name: '配电房', type: 'object', desc: '配电场所', sources: [], domain: '', profile: 'bfo-lite' },
    { id: 'bfo:material', name: 'Material', type: 'material_entity', desc: 'material entity', sources: [], domain: '', profile: 'bfo' },
  ], [
    { from: 'bfo-lite:变压器', to: 'bfo-lite:充电桩', rel: '属于' },
    { from: 'bfo-lite:配电房', to: 'bfo-lite:变压器', rel: '包含' },
  ]);
  // 还原本小节标准夹具的辅助（4 节点含 bfo 体系 Material 节点）
  const restoreRecallFixture = () => graph.saveGraph([
    { id: 'bfo-lite:充电桩', name: '充电桩', type: 'object', desc: '终端充电设施', sources: ['笔记·电力'], domain: '', profile: 'bfo-lite' },
    { id: 'bfo-lite:变压器', name: '变压器', type: 'object', desc: '电压变换设备', sources: [], domain: '', profile: 'bfo-lite' },
    { id: 'bfo-lite:配电房', name: '配电房', type: 'object', desc: '配电场所', sources: [], domain: '', profile: 'bfo-lite' },
    { id: 'bfo:material', name: 'Material', type: 'material_entity', desc: 'material entity', sources: [], domain: '', profile: 'bfo' },
  ], [
    { from: 'bfo-lite:变压器', to: 'bfo-lite:充电桩', rel: '属于' },
    { from: 'bfo-lite:配电房', to: 'bfo-lite:变压器', rel: '包含' },
  ]);
  check('中文二元组分词可命中节点名', (() => {
    const r = graph.recallFor('介绍一下变压器设备');
    return r.hits.includes('变压器'); // 「变压」「压器」二元组命中
  })());
  check('recallFor 全名命中 +5 排最前', (() => {
    const r = graph.recallFor('充电桩和变压器的关系');
    return r.hits[0] === '充电桩' && r.context.includes('【知识图谱·本体层】');
  })());
  check('recallFor 返回 hits 名单', graph.recallFor('变压器').hits.includes('变压器'));
  check('recallFor 空问题返回空', graph.recallFor('').context === '' && graph.recallFor('  ').context === '');
  check('recallFor 空图返回空', (() => {
    graph.clearGraph();
    const r = graph.recallFor('任何');
    restoreRecallFixture();
    return r.context === '' && r.hits.length === 0;
  })());
  check('recallFor 仅 desc 命中不算召回', (() => {
    const r = graph.recallFor('设施');
    return r.hits.length === 0; // 「设施」只出现在 desc，名称未命中 → 不召回
  })());
  check('recallFor 关系边带方向（被/→）', (() => {
    const r = graph.recallFor('变压器');
    return r.context.includes('被属于') || r.context.includes('属于→充电桩') || r.context.includes('（关系：');
  })());
  check('recallFor profileId 隔离体系', (() => {
    const r = graph.recallFor('Material', 8, 'bfo');
    return r.hits.includes('Material') && r.context.includes('【知识图谱·本体层·体系：BFO 2020 标准体系】');
  })());
  check('recallFor scope=profile|* 优先于 profileId', (() => {
    const r = graph.recallFor('充电桩', 8, 'bfo', 'bfo-lite|*');
    return r.hits.includes('充电桩') && !r.hits.includes('Material');
  })());
  check('recallFor scope=profile|general 只命中无 domain', (() => {
    graph.saveGraph([
      { id: 'bfo-lite:充电', name: '充电', type: 'object', desc: '', sources: [], domain: 'ev', profile: 'bfo-lite' },
      { id: 'bfo-lite:变压', name: '变压', type: 'object', desc: '', sources: [], domain: '', profile: 'bfo-lite' },
    ], []);
    const r = graph.recallFor('变压', 8, null, 'bfo-lite|general');
    restoreRecallFixture();
    return r.hits.includes('变压') && !r.hits.includes('充电');
  })());
  check('contextFor 兼容旧调用返回字符串', (() => {
    restoreRecallFixture();
    const c = graph.contextFor('充电桩');
    return typeof c === 'string' && c.includes('【知识图谱·本体层】');
  })());

  // ---------- 11. listGraphScopes / scopeFilter ----------
  section('listGraphScopes / scopeFilter');
  graph.saveGraph([
    { id: 'bfo-lite:n1', name: 'N1', type: 'object', desc: '', sources: [], domain: 'ev', profile: 'bfo-lite' },
    { id: 'bfo-lite:n2', name: 'N2', type: 'object', desc: '', sources: [], domain: 'ev', profile: 'bfo-lite' },
    { id: 'bfo-lite:n3', name: 'N3', type: 'object', desc: '', sources: [], domain: '', profile: 'bfo-lite' },
    { id: 'bfo:n4', name: 'N4', type: 'material_entity', desc: '', sources: [], domain: 'mat', profile: 'bfo' },
  ], [
    { from: 'bfo-lite:n1', to: 'bfo-lite:n2', rel: '相关' },   // 同组内边
    { from: 'bfo-lite:n1', to: 'bfo-lite:n3', rel: '相关' },   // 跨组边（不计入任何组）
  ]);
  const scopes = graph.listGraphScopes();
  check('按 profile|domain 分组', scopes.length === 3 && scopes.some((s) => s.id === 'bfo-lite|ev') && scopes.some((s) => s.id === 'bfo-lite|general') && scopes.some((s) => s.id === 'bfo|mat'), JSON.stringify(scopes.map((s) => s.id)));
  check('nodeCount 正确', scopes.find((s) => s.id === 'bfo-lite|ev').nodeCount === 2);
  check('edgeCount 只数两端都在组内的边', scopes.find((s) => s.id === 'bfo-lite|ev').edgeCount === 1 && scopes.find((s) => s.id === 'bfo-lite|general').edgeCount === 0);
  check('按 nodeCount 降序', scopes[0].nodeCount >= scopes[1].nodeCount);
  check('general 组 label 为 通用（未匹配领域）', scopes.find((s) => s.id === 'bfo-lite|general').label === '通用（未匹配领域）');
  check('scopeFilter all/空 → null', graph.scopeFilter('all') === null && graph.scopeFilter('') === null && graph.scopeFilter(undefined) === null);
  check('scopeFilter 含 all 部分 → null', graph.scopeFilter('bfo-lite|*,all') === null);
  check('scopeFilter profile|* 匹配整个体系', graph.scopeFilter('bfo-lite|*')({ profile: 'bfo-lite', domain: 'x' }) === true && graph.scopeFilter('bfo-lite|*')({ profile: 'bfo' }) === false);
  check('scopeFilter profile|general 匹配无 domain', graph.scopeFilter('bfo-lite|general')({ profile: 'bfo-lite', domain: '' }) === true && graph.scopeFilter('bfo-lite|general')({ profile: 'bfo-lite', domain: 'ev' }) === false);
  check('scopeFilter 多选逗号分隔（OR）', graph.scopeFilter('bfo-lite|ev,bfo|mat')({ profile: 'bfo', domain: 'mat' }) === true && graph.scopeFilter('bfo-lite|ev,bfo|mat')({ profile: 'bfo-lite', domain: 'ev' }) === true && graph.scopeFilter('bfo-lite|ev,bfo|mat')({ profile: 'bfo-lite', domain: 'other' }) === false);
  check('scopeFilter 缺省 profile 视为 bfo-lite', graph.scopeFilter('bfo-lite|general')({ domain: '' }) === true);

  // ---------- 12. resolveSources ----------
  section('resolveSources');
  notesStore.importNote('电力笔记', '充电桩内容', '', '');
  // 原始· 查找走 raws 根（默认 <dataRoot>/llmwiki），与 readRawText 的 wikiRoot 夹具目录不同，单独准备
  const defaultRawDir = path.join(env.dataRoot, 'llmwiki');
  writeFile(path.join(defaultRawDir, 'raw', '电力.md'), '变压器为充电桩供电。');
  const srcs = graph.resolveSources(settings, ['笔记·电力笔记', '原始·电力.md', 'Wiki·旧', '不存在·x', '']);
  check('笔记· 命中返回 note+id', srcs[0].kind === 'note' && srcs[0].title === '电力笔记', JSON.stringify(srcs[0]));
  check('原始· 命中返回 raw+path', srcs[1].kind === 'raw' && srcs[1].path === 'raw/电力.md', JSON.stringify(srcs[1]));
  check('Wiki· 归为 missing', srcs[2].kind === 'missing');
  check('未知前缀归为 missing', srcs[3].kind === 'missing');
  check('空标签归为 missing', srcs[4].kind === 'missing');
  check('不存在的笔记归为 missing', graph.resolveSources(settings, ['笔记·不存在'])[0].kind === 'missing');

  // ---------- 13. kgAsk ----------
  section('kgAsk — 问答管线');
  const sent = [];
  const fakeEvent = { sender: { send: (ch, d) => sent.push({ ch, d }) } };
  const kgFake = await startFakeLlm(({ url, body }) => {
    if (url.endsWith('/chat/completions')) {
      const txt = (body.messages || []).map((m) => m.content).join('\n');
      if (/抽取可能在知识图谱中存在的实体名/.test(txt)) return json({ names: ['充电桩'] });
      return json({ answer: '充电桩是终端充电设施。' });
    }
    return { status: 404, text: 'no' };
  });
  const kgSettings = { ...settings, ...kgFake.settings() };
  graph.saveGraph([
    { id: 'bfo-lite:充电桩', name: '充电桩', type: 'object', desc: '终端充电设施', sources: ['笔记·电力笔记'], domain: '', profile: 'bfo-lite' },
    { id: 'bfo-lite:变压器', name: '变压器', type: 'object', desc: '', sources: [], domain: '', profile: 'bfo-lite' },
  ], [{ from: 'bfo-lite:变压器', to: 'bfo-lite:充电桩', rel: '属于' }]);

  await graph.kgAsk(fakeEvent, { settings: kgSettings, question: '充电桩是什么', hops: 2, withFacts: true });
  check('kg:stage 事件流式下发', sent.some((s) => s.ch === 'kg:stage' && /解析问题并抽取实体/.test(s.d)));
  check('实体抽取完成事件', sent.some((s) => s.ch === 'kg:stage' && /实体抽取完成：充电桩/.test(s.d)));
  check('命中图谱节点事件', sent.some((s) => s.ch === 'kg:stage' && /命中图谱节点：充电桩/.test(s.d)));
  check('邻居事实扩展事件', sent.some((s) => s.ch === 'kg:stage' && /邻居事实扩展完成（2 跳内）/.test(s.d)));
  check('kg:facts 携带 matched/facts/refs', sent.some((s) => s.ch === 'kg:facts' && Array.isArray(s.d.matched) && Array.isArray(s.d.facts) && Array.isArray(s.d.refs)));
  check('kg:facts refs 回溯到笔记', (() => {
    const f = sent.find((s) => s.ch === 'kg:facts');
    return f && f.d.refs.some((r) => r.kind === 'note' && r.label === '电力笔记');
  })());
  const sent2 = [];
  const ev2 = { sender: { send: (ch, d) => sent2.push({ ch, d }) } };
  await graph.kgAsk(ev2, { settings: kgSettings, question: '充电桩', hops: 1, withFacts: false });
  check('withFacts=false 时 facts 为空数组', (() => {
    const f = sent2.find((s) => s.ch === 'kg:facts');
    return f && Array.isArray(f.d.facts) && f.d.facts.length === 0;
  })());
  check('ai:chunk / ai:done 流式回答', sent.some((s) => s.ch === 'ai:chunk') && sent.some((s) => s.ch === 'ai:done'));
  graph.clearGraph();
  const sent3 = [];
  const ev3 = { sender: { send: (ch, d) => sent3.push({ ch, d }) } };
  await graph.kgAsk(ev3, { settings: kgSettings, question: 'x', hops: 1, withFacts: false });
  check('空图时直接报错', sent3.some((s) => s.ch === 'ai:error' && /知识图谱为空/.test(s.d)));
  await kgFake.close();

  summary();
})().catch((err) => {
  console.error('测试执行异常：', err);
  process.exitCode = 1;
});
