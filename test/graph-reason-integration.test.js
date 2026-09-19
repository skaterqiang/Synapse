'use strict';
// 推理层集成测试：src/main/graph/graph.js 的推理对外接口 + src/main/ipc.js 的 14 个通道
// （v1 起含全图校验 validateGraph / graph:validate，专属套件见 test/graph-validate.test.js；
//   冲突修复 planRepairs/applyRepairs/undoRepair 专属套件见 test/graph-repair.test.js）
// 对照《Synapse×protege-js 融合设计》：
//   §3  数据流（推理结果一律返回 graph.js，由 saveGraph 单点落库 —— 约束 D3）
//   §4.3 写入护栏（抽取阶段拦截 domain/range 越界并降级）
//   §5.1 批量物化（约束 D4：批处理而非实时）
//   §5.2 抽取作业接入（autoReason / guard / stage 上报）
//   §5.3 级联清理（删边/删节点时回收依赖它的推理边）
//   §5.4 graphMeta（lastInferredAt / inferredStale / lastStats / lastGuard）
//   §6.5–§6.11 前端各面板所需的数据形状（本文件只验后端契约，前端渲染见 §6 待实现）
//   §9  风险 1/2：protege-js 缺失时主链路照常工作
//
// 与 test/graph-reason.test.js 的分工：那份直接测 reason/ 子模块的算法；
// 本文件测 graph.js 这层「包装 + 落库 + 元数据」的契约，以及 IPC 序列化安全性。
//
// ⚠️ 性能红线同 graph-reason.test.js：所有图谱 ≤ 6 节点，避免传递闭包超线性爆炸。
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');
const { bootEnv, mkCheck, startFakeLlm, sseText, writeFile } = require('./helpers/harness');

const { check, section, summary } = mkCheck('推理层集成（graph.js 包装层 + IPC）');
const J = (v) => JSON.stringify(v);
const json = (obj) => ({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, sse: sseText(JSON.stringify(obj)) });

// ---------- 夹具 ----------
const N = (key, name, profile = 'bfo-lite', type = 'object') => ({
  id: `${profile}:${key}`, name: name || key, type, desc: '', sources: [], domain: '', profile,
});
/** 3 节点 bfo-lite 传递链：a 包含 b 包含 c */
function chain3(profile = 'bfo-lite', rel = '包含') {
  return {
    nodes: [N('a', 'A', profile), N('b', 'B', profile), N('c', 'C', profile)],
    edges: [
      { from: `${profile}:a`, to: `${profile}:b`, rel },
      { from: `${profile}:b`, to: `${profile}:c`, rel },
    ],
  };
}
const edgeTag = (e) => `${e.from}->${e.to}|${e.rel}|inf=${!!e.inferred}|via=${e.inferredVia || ''}`;

// OWL 预览夹具：2 类 1 传递属性（与 makeTurtle 不同，手工控制类名/标签便于断言）
const TTL_PREVIEW = `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ex: <http://example.org/ex#> .
ex:Device a owl:Class ; rdfs:label "设备" .
ex:Charger a owl:Class ; rdfs:subClassOf ex:Device ; rdfs:label "充电桩" .
ex:partOf a owl:ObjectProperty , owl:TransitiveProperty ; rdfs:label "属于" ; rdfs:domain ex:Device ; rdfs:range ex:Device .
`;

(async () => {
  const env = await bootEnv({ prefix: 'synapse-greason-int-' });
  const graph = require('../src/main/graph/graph');
  const settingsMod = require('../src/main/common/settings');

  // ======================================================================
  section('§3/§9 推理层就绪状态与总开关');
  // ======================================================================
  check('reasonReady() 为真（protege-js 已安装）', graph.reasonReady() === true);
  check('reasonUnavailableReason() 为空串', graph.reasonUnavailableReason() === '', J(graph.reasonUnavailableReason()));
  check('reasonEnabled({}) 默认开（§6.11 / §11 开放问题 2）', graph.reasonEnabled({}) === true);
  check('reasonEnabled(null) 默认开', graph.reasonEnabled(null) === true);
  check('reasonEnabled({reasonEnabled:false}) 关', graph.reasonEnabled({ reasonEnabled: false }) === false);
  check('reasonEnabled({reasonEnabled:true}) 开', graph.reasonEnabled({ reasonEnabled: true }) === true);
  check('SKIP_REASON_TEXT 覆盖 7 种 skipReason', J(Object.keys(graph.SKIP_REASON_TEXT)) === '["reasoner-unavailable","empty-graph","bridge-failed","no-rule-fuel","aborted","materialize-failed","timeout"]', J(Object.keys(graph.SKIP_REASON_TEXT)));
  check('SKIP_REASON_TEXT 每项都是非空中文说明', Object.values(graph.SKIP_REASON_TEXT).every((v) => typeof v === 'string' && v.length > 3));

  const st0 = graph.reasonStatus();
  check('reasonStatus() 恰好 5 个字段', J(Object.keys(st0)) === '["available","enabled","reason","timeoutSec","coverage"]', J(Object.keys(st0)));
  check('reasonStatus().available=true / enabled=true / reason=""', st0.available === true && st0.enabled === true && st0.reason === '');
  check('reasonStatus().timeoutSec 默认 30', st0.timeoutSec === 30, J(st0.timeoutSec));
  check('reasonStatus().coverage 取当前体系（bfo-lite）', st0.coverage && st0.coverage.profileId === 'bfo-lite', J(st0.coverage && st0.coverage.profileId));
  check('bfo-lite 护栏覆盖率 0%（无任何 domain/range 声明，属预期）', st0.coverage.coveragePct === 0 && st0.coverage.withDomain === 0 && st0.coverage.withRange === 0, J(st0.coverage));
  check('bfo-lite 声明 8 个谓词 / 11 个类 / 8 条公理', st0.coverage.predicates === 8 && st0.coverage.classCount === 11 && st0.coverage.axiomCount === 8, J({ p: st0.coverage.predicates, c: st0.coverage.classCount, a: st0.coverage.axiomCount }));
  check('bfo-lite 传递谓词只有「包含」', J(st0.coverage.transitive) === '["包含"]', J(st0.coverage.transitive));
  check('bfo-lite 对称谓词只有「相关」', J(st0.coverage.symmetric) === '["相关"]', J(st0.coverage.symmetric));
  check('bfo-lite 互逆对为空', J(st0.coverage.inversePairs) === '[]', J(st0.coverage.inversePairs));
  check('bfo-lite 不相交对 3 组', J(st0.coverage.disjointPairs) === '[["continuant","occurrent"],["object","quality"],["role","function"]]', J(st0.coverage.disjointPairs));

  // reasonTimeout 夹取（§6.11：默认 30，范围 5–120）
  settingsMod.saveSettings({ reasonTimeout: 77 });
  check('reasonTimeout=77 原样生效', graph.reasonStatus().timeoutSec === 77, J(graph.reasonStatus().timeoutSec));
  settingsMod.saveSettings({ reasonTimeout: 1 });
  check('reasonTimeout=1 下夹到 5', graph.reasonStatus().timeoutSec === 5, J(graph.reasonStatus().timeoutSec));
  settingsMod.saveSettings({ reasonTimeout: 9999 });
  check('reasonTimeout=9999 上夹到 120', graph.reasonStatus().timeoutSec === 120, J(graph.reasonStatus().timeoutSec));
  settingsMod.saveSettings({ reasonTimeout: 'abc' });
  check('reasonTimeout 非数字回退默认 30', graph.reasonStatus().timeoutSec === 30, J(graph.reasonStatus().timeoutSec));
  settingsMod.saveSettings({});
  check('清空设置后 reasonTimeout 回到默认 30', graph.reasonStatus().timeoutSec === 30);

  // ======================================================================
  section('§5.4 graphMeta：kv "graph.meta" 的形状与重置');
  // ======================================================================
  graph.clearGraph();
  const meta0 = graph.getGraphMeta();
  check('getGraphMeta() 恰好 4 个字段', J(Object.keys(meta0)) === '["lastInferredAt","inferredStale","lastStats","lastGuard"]', J(Object.keys(meta0)));
  check('空图 meta 全为初值', meta0.lastInferredAt === 0 && meta0.inferredStale === false && meta0.lastStats === null && meta0.lastGuard === null, J(meta0));
  check('getGraph() 空图形状为 {nodes,edges,updatedAt}', J(Object.keys(graph.getGraph())) === '["nodes","edges","updatedAt"]', J(Object.keys(graph.getGraph())));

  graph.setGraphMeta({ inferredStale: true });
  check('setGraphMeta 是合并而非替换（lastStats 未被抹掉）', graph.getGraphMeta().inferredStale === true && graph.getGraphMeta().lastStats === null);
  graph.setGraphMeta({ lastStats: { probe: 1 } });
  check('setGraphMeta 可写入 lastStats', J(graph.getGraphMeta().lastStats) === '{"probe":1}', J(graph.getGraphMeta().lastStats));
  check('setGraphMeta 保留先前 inferredStale=true', graph.getGraphMeta().inferredStale === true);
  graph.clearGraph();
  check('clearGraph() 把 meta 一并重置（避免「图已空但显示上次推理时间」）', J(graph.getGraphMeta()) === '{"lastInferredAt":0,"inferredStale":false,"lastStats":null,"lastGuard":null}', J(graph.getGraphMeta()));

  // ======================================================================
  section('§5.1 runInference：空图与单体系传递闭包');
  // ======================================================================
  const empty = await graph.runInference({}, {});
  check('空图 runInference → skipped + empty-graph', empty.ok === false && empty.skipped === true && empty.skipReason === 'empty-graph' && empty.error === '图谱为空', J(empty));

  graph.saveGraph(chain3().nodes, chain3().edges);
  check('saveGraph 落库 3 节点 2 边', graph.getGraph().nodes.length === 3 && graph.getGraph().edges.length === 2);
  const r1 = await graph.runInference({}, {});
  check('runInference 返回恰好 12 个字段', J(Object.keys(r1)) === '["ok","skipped","inferredEdges","bound","dropped","inconsistencies","rounds","elapsedMs","profiles","skippedProfiles","perProfile","total"]', J(Object.keys(r1)));
  check('runInference ok=true / skipped=false', r1.ok === true && r1.skipped === false);
  check('传递闭包新增 1 条推理边（a→c）', r1.inferredEdges === 1, J(r1.inferredEdges));
  check('回收时 bound=1 / dropped=0', r1.bound === 1 && r1.dropped === 0, J({ b: r1.bound, d: r1.dropped }));
  // ⚠️ inconsistencies 在四处形状不同，前端接入时别混用：
  //   runInference().inconsistencies               → 数组（明细，每项带 profileId/profileName）
  //   runInference().perProfile[i].inconsistencies → 数字（该体系条数）
  //   meta.lastStats.inconsistencies               → 数字（落库只存条数）
  //   extractGraph().reason.inconsistencies        → 数组（原样透传物化明细）
  check('runInference 顶层 inconsistencies 是数组且为空', Array.isArray(r1.inconsistencies) && r1.inconsistencies.length === 0, J(r1.inconsistencies));
  check('perProfile[i].inconsistencies 是数字（条数）', typeof r1.perProfile[0].inconsistencies === 'number' && r1.perProfile[0].inconsistencies === 0, J(r1.perProfile[0].inconsistencies));
  check('rounds=3（前向链跑到不动点）', r1.rounds === 3, J(r1.rounds));
  check('elapsedMs 为正数', typeof r1.elapsedMs === 'number' && r1.elapsedMs > 0, J(r1.elapsedMs));
  check('profiles=1 / skippedProfiles=0', r1.profiles === 1 && r1.skippedProfiles === 0);
  check('perProfile 只有 bfo-lite 一项', r1.perProfile.length === 1 && r1.perProfile[0].profileId === 'bfo-lite' && r1.perProfile[0].profileName === 'BFO-Lite 轻量体系', J(r1.perProfile.map((p) => p.profileId)));
  check('perProfile[0].stats 带桥接统计（inputTriples=2 / inputNodes=3）', r1.perProfile[0].stats.inputTriples === 2 && r1.perProfile[0].stats.inputNodes === 3, J(r1.perProfile[0].stats));
  check('total = {total:3, inferred:1, raw:2, byVia:{transitive:1}}', J(r1.total) === '{"total":3,"inferred":1,"raw":2,"byVia":{"transitive":1}}', J(r1.total));

  const g1 = graph.getGraph();
  check('D3：推理边由 saveGraph 单点落库（图里共 3 条边）', g1.edges.length === 3, J(g1.edges.length));
  check('推理边带 inferred=true / inferredVia=transitive / inferredFrom=[0,1]', (() => {
    const inf = g1.edges.find((e) => e.inferred);
    return !!inf && inf.inferredVia === 'transitive' && J(inf.inferredFrom) === '[0,1]';
  })(), J(g1.edges.map((e) => ({ inf: !!e.inferred, via: e.inferredVia, from: e.inferredFrom }))));
  check('原始边未被标记 inferred', g1.edges.filter((e) => !e.inferred).length === 2);

  const meta1 = graph.getGraphMeta();
  check('推理后 meta.lastInferredAt > 0', meta1.lastInferredAt > 0, J(meta1.lastInferredAt));
  check('推理后 meta.inferredStale=false', meta1.inferredStale === false);
  check('meta.lastStats 记录 skipped/inferredEdges/rounds/profiles', meta1.lastStats && meta1.lastStats.skipped === false && meta1.lastStats.inferredEdges === 1 && meta1.lastStats.rounds === 3 && meta1.lastStats.profiles === 1, J(meta1.lastStats));
  check('meta.lastStats.inconsistencies 是数字（落库只存条数，与顶层数组不同）', typeof meta1.lastStats.inconsistencies === 'number' && meta1.lastStats.inconsistencies === 0, J(meta1.lastStats.inconsistencies));
  check('meta.lastStats 带 at 时间戳（供推理 Tab 显示「上次运行」）', typeof meta1.lastStats.at === 'number' && meta1.lastStats.at > 0, J(meta1.lastStats.at));
  check('meta.lastGuard 仍为 null（runInference 不跑护栏）', meta1.lastGuard === null);

  // 幂等：再跑一次不应产生新边
  const r2 = await graph.runInference({}, {});
  check('幂等：第二次 runInference 仍报 inferredEdges=1', r2.inferredEdges === 1, J(r2.inferredEdges));
  check('幂等：边总数仍为 3（不累积）', graph.getGraph().edges.length === 3, J(graph.getGraph().edges.length));

  // 进度上报
  graph.saveGraph(chain3().nodes, chain3().edges);
  const prog = [];
  await graph.runInference({}, { onProgress: (p) => prog.push(p) });
  check('onProgress 上报 4 个阶段（体系头 + 桥接 + 物化 + 回收）', J(prog.map((p) => p.phase)) === '["推理体系「BFO-Lite 轻量体系」（1/1）…","[BFO-Lite 轻量体系] 桥接图谱为三元组…","[BFO-Lite 轻量体系] 物化推理中…","[BFO-Lite 轻量体系] 回收推理边…"]', J(prog.map((p) => p.phase)));
  check('仅体系头带 pct=100，子阶段 pct 为 null', J(prog.map((p) => p.pct)) === '[100,null,null,null]', J(prog.map((p) => p.pct)));

  // ======================================================================
  section('§5.1 runInference：多体系分组（谓词特性按体系声明，不可混跑）');
  // ======================================================================
  graph.saveGraph(
    [N('a', 'A'), N('b', 'B'), N('c', 'C'), N('x', 'X', 'bfo'), N('y', 'Y', 'bfo'), N('z', 'Z', 'bfo')],
    [
      { from: 'bfo-lite:a', to: 'bfo-lite:b', rel: '包含' },
      { from: 'bfo-lite:b', to: 'bfo-lite:c', rel: '包含' },
      { from: 'bfo:x', to: 'bfo:y', rel: 'part_of' },
      { from: 'bfo:y', to: 'bfo:z', rel: 'part_of' },
    ]
  );
  const rm = await graph.runInference({}, {});
  check('多体系：perProfile 两项，bfo-lite 1 条 / bfo 4 条', J(rm.perProfile.map((p) => [p.profileId, p.inferredEdges])) === '[["bfo-lite",1],["bfo",4]]', J(rm.perProfile.map((p) => [p.profileId, p.inferredEdges])));
  check('多体系：合计 inferredEdges=5 / profiles=2 / rounds=6', rm.inferredEdges === 5 && rm.profiles === 2 && rm.rounds === 6, J({ i: rm.inferredEdges, p: rm.profiles, r: rm.rounds }));
  check('多体系：byVia 含 transitive/inverse/transitive+', J(rm.total.byVia) === '{"transitive":2,"inverse":2,"transitive+":1}', J(rm.total.byVia));
  check('多体系：bfo 侧生成 has_part 互逆边与传递叠加边', (() => {
    const tags = graph.getGraph().edges.map(edgeTag);
    return tags.includes('bfo:z->bfo:x|has_part|inf=true|via=transitive+')
      && tags.includes('bfo:y->bfo:x|has_part|inf=true|via=inverse');
  })(), J(graph.getGraph().edges.map(edgeTag)));

  const progM = [];
  graph.saveGraph(
    [N('a', 'A'), N('b', 'B'), N('c', 'C'), N('x', 'X', 'bfo'), N('y', 'Y', 'bfo'), N('z', 'Z', 'bfo')],
    [
      { from: 'bfo-lite:a', to: 'bfo-lite:b', rel: '包含' },
      { from: 'bfo-lite:b', to: 'bfo-lite:c', rel: '包含' },
      { from: 'bfo:x', to: 'bfo:y', rel: 'part_of' },
      { from: 'bfo:y', to: 'bfo:z', rel: 'part_of' },
    ]
  );
  await graph.runInference({}, { onProgress: (p) => progM.push(p.phase) });
  check('多体系进度：8 个阶段，按体系串行（体系1 头+3 子阶段 → 体系2 头+3 子阶段）', J(progM) === '["推理体系「BFO-Lite 轻量体系」（1/2）…","[BFO-Lite 轻量体系] 桥接图谱为三元组…","[BFO-Lite 轻量体系] 物化推理中…","[BFO-Lite 轻量体系] 回收推理边…","推理体系「BFO 2020 标准体系」（2/2）…","[BFO 2020 标准体系] 桥接图谱为三元组…","[BFO 2020 标准体系] 物化推理中…","[BFO 2020 标准体系] 回收推理边…"]', J(progM));

  const rOnly = await graph.runInference({}, { profileId: 'bfo' });
  check('opts.profileId="bfo" 只跑该体系', J(rOnly.perProfile.map((p) => p.profileId)) === '["bfo"]', J(rOnly.perProfile.map((p) => p.profileId)));
  const rNope = await graph.runInference({}, { profileId: 'nope-xyz' });
  check('opts.profileId 不存在 → skipped + no-rule-fuel + perProfile 空', rNope.ok === true && rNope.skipped === true && rNope.skipReason === 'no-rule-fuel' && J(rNope.perProfile) === '[]', J({ s: rNope.skipReason, p: rNope.perProfile }));

  // 节点缺 profile 字段：从 id 前缀恢复
  graph.saveGraph(
    [{ id: 'bfo-lite:a', name: 'A', type: 'object' }, { id: 'bfo-lite:b', name: 'B', type: 'object' }, { id: 'bfo-lite:c', name: 'C', type: 'object' }],
    [{ from: 'bfo-lite:a', to: 'bfo-lite:b', rel: '包含' }, { from: 'bfo-lite:b', to: 'bfo-lite:c', rel: '包含' }]
  );
  const rNoField = await graph.runInference({}, {});
  check('节点无 profile 字段时按 id 前缀分组', J(rNoField.perProfile.map((p) => p.profileId)) === '["bfo-lite"]', J(rNoField.perProfile.map((p) => p.profileId)));
  check('节点无 profile 字段仍能推出 1 条边', rNoField.inferredEdges === 1, J(rNoField.inferredEdges));

  // 未知 profile 值：resolveOntology 回退 bfo-lite
  graph.saveGraph([N('q', 'Q', 'nope-xyz')], []);
  const rUnknown = await graph.runInference({}, {});
  check('未知 profile 回退到 bfo-lite（profileName 为 BFO-Lite）', rUnknown.perProfile[0].profileId === 'nope-xyz' && rUnknown.perProfile[0].profileName === 'BFO-Lite 轻量体系', J(rUnknown.perProfile[0] && { id: rUnknown.perProfile[0].profileId, n: rUnknown.perProfile[0].profileName }));
  check('未知 profile 孤立节点推不出边', rUnknown.perProfile[0].inferredEdges === 0);

  // 跨体系边：两端不同 profile → 任一子图都不含它，但边必须保留
  graph.saveGraph([N('a', 'A'), N('x', 'X', 'bfo')], [{ from: 'bfo-lite:a', to: 'bfo:x', rel: '相关' }]);
  const rCross = await graph.runInference({}, {});
  check('跨体系边：两个体系都跑但都推不出边', J(rCross.perProfile.map((p) => [p.profileId, p.inferredEdges])) === '[["bfo-lite",0],["bfo",0]]', J(rCross.perProfile.map((p) => [p.profileId, p.inferredEdges])));
  check('跨体系边不会被丢弃（仍保留 1 条）', graph.getGraph().edges.length === 1, J(graph.getGraph().edges.map(edgeTag)));

  // ======================================================================
  section('§5.4 runInference：脏数据与旧推理边的处理');
  // ======================================================================
  const c3 = chain3();
  graph.saveGraph(c3.nodes, [c3.edges[0], c3.edges[1], null, { from: '', to: 'bfo-lite:c', rel: '包含' }, { from: 'bfo-lite:a', to: 'bfo-lite:c' }]);
  check('saveGraph 不做边校验：null / 空 from / 缺 rel 都原样落库', J(graph.getGraph().edges.map((e) => (e ? `${e.from || ''}>${e.to || ''}>${J(e.rel)}` : 'NULL'))) === J(['bfo-lite:a>bfo-lite:b>"包含"', 'bfo-lite:b>bfo-lite:c>"包含"', 'NULL', '>bfo-lite:c>"包含"', 'bfo-lite:a>bfo-lite:c>undefined']), J(graph.getGraph().edges.map((e) => (e ? `${e.from || ''}>${e.to || ''}>${J(e.rel)}` : 'NULL'))));
  const rDirty = await graph.runInference({}, {});
  check('脏边不致崩：null 与空 from 在推理入口被过滤（inputTriples 只算 3 条）', rDirty.ok === true && rDirty.perProfile[0].stats.inputTriples === 3, J({ ok: rDirty.ok, t: rDirty.perProfile[0].stats.inputTriples }));
  // 缺 rel 的边：bridge.js:332 刻意 `const rel = e.rel || model.fallbackRel || 'related'`，
  //   bfo-lite 的 fallbackRel 是「相关」（对称谓词）→ 于是桥接成对称边并推出 c→a。
  //   这是**设计内的降级**（未知/缺失谓词一律归到 fallbackRel，同 §4.3 护栏的降级策略），不是缺陷。
  //   且 §5.1 明文「saveGraph/getGraph 无需改」，故不在写入口加校验。
  //   正常写入路径（extractGraph.putEdge 走 rels.includes 判定、渲染层手工加边）都会补 rel，仅直调 saveGraph 可触发。
  check('缺 rel 的边按 bridge.js 降级为 fallbackRel「相关」→ 推出 2 条（含对称边 c→a）', rDirty.inferredEdges === 2, J(rDirty.inferredEdges));
  check('降级后的对称推理边 via=symmetric（可被 §6.2 推导链 tooltip 解释）', graph.getGraph().edges.some((e) => e.inferred && e.inferredVia === 'symmetric'), J(graph.getGraph().edges.map(edgeTag)));
  check('脏边本身原样留在图里（共 5 条，saveGraph 不做校验 —— §5.1 明示无需改）', graph.getGraph().edges.length === 5 && graph.getGraph().edges.some((e) => e.rel === undefined), J(graph.getGraph().edges.map(edgeTag)));
  check('脏边场景下正常的传递推理仍然正确（a→c 包含 inferred）', graph.getGraph().edges.some((e) => e.rel === '包含' && e.inferred && e.inferredVia === 'transitive'), J(graph.getGraph().edges.map(edgeTag)));

  graph.saveGraph(c3.nodes, [
    c3.edges[0], c3.edges[1],
    { from: 'bfo-lite:a', to: 'bfo-lite:c', rel: '包含', inferred: true, inferredVia: 'transitive', inferredFrom: [0, 1] },
  ]);
  const rStale = await graph.runInference({}, {});
  check('§5.4：输入里的旧推理边被过滤后重算（不作为原始边喂回推理器）', rStale.inferredEdges === 1 && graph.getGraph().edges.length === 3, J({ i: rStale.inferredEdges, n: graph.getGraph().edges.length }));
  check('旧推理边不计入 staleInferred 统计（已在入口过滤）', rStale.perProfile[0].stats.staleInferred === 0, J(rStale.perProfile[0].stats.staleInferred));

  // ======================================================================
  section('§9 runInference：中止、进度回调异常、总开关');
  // ======================================================================
  graph.saveGraph(chain3().nodes, chain3().edges);
  const ac = new AbortController();
  ac.abort();
  const rAbort = await graph.runInference({}, { signal: ac.signal });
  check('预先中止 → skipped + aborted（不抛异常）', rAbort.ok === true && rAbort.skipped === true && rAbort.skipReason === 'aborted', J({ ok: rAbort.ok, s: rAbort.skipReason }));
  check('中止时 perProfile 记录该体系被跳过', J(rAbort.perProfile.map((p) => [p.profileId, p.skipped, p.skipReason])) === '[["bfo-lite",true,"aborted"]]', J(rAbort.perProfile));
  check('中止时图谱未被改动（仍 2 条原始边）', graph.getGraph().edges.length === 2, J(graph.getGraph().edges.map(edgeTag)));
  check('中止时 meta.lastStats 记 skipped+skipReason', graph.getGraphMeta().lastStats && graph.getGraphMeta().lastStats.skipped === true && graph.getGraphMeta().lastStats.skipReason === 'aborted', J(graph.getGraphMeta().lastStats));

  graph.saveGraph(chain3().nodes, chain3().edges);
  const rThrow = await graph.runInference({}, { onProgress: () => { throw new Error('进度回调炸了'); } });
  check('onProgress 抛异常被吞掉，推理照常完成', rThrow.ok === true && rThrow.inferredEdges === 1, J({ ok: rThrow.ok, i: rThrow.inferredEdges }));

  graph.saveGraph(chain3().nodes, chain3().edges);
  settingsMod.saveSettings({ reasonEnabled: false });
  check('设置落库后 reasonEnabled=false', settingsMod.getSettings().reasonEnabled === false);
  const rOff = await graph.runInference(settingsMod.getSettings(), {});
  check('§6.11 总开关关闭 → skipped + disabled + 中文原因', rOff.ok === false && rOff.skipped === true && rOff.skipReason === 'disabled' && rOff.error === '推理功能已在设置中关闭', J(rOff));
  check('总开关关闭时 reasonStatus().enabled=false（available 仍为 true）', graph.reasonStatus().enabled === false && graph.reasonStatus().available === true, J({ e: graph.reasonStatus().enabled, a: graph.reasonStatus().available }));
  check('总开关关闭时 getReasonState().enabled=false', graph.getReasonState('bfo-lite').enabled === false);
  settingsMod.saveSettings({ reasonEnabled: true });
  check('重新打开后 runInference 恢复', (await graph.runInference(settingsMod.getSettings(), {})).ok === true);
  settingsMod.saveSettings({});

  // ======================================================================
  section('§6.6 getReasonState / predicateFeatures：推理 Tab 的数据契约');
  // ======================================================================
  graph.saveGraph(chain3().nodes, chain3().edges);
  await graph.runInference({}, {});
  const rs = graph.getReasonState('bfo-lite');
  check('getReasonState() 恰好 11 个字段', J(Object.keys(rs)) === '["available","enabled","unavailableReason","timeoutSec","meta","counts","coverage","features","lastInconsistencies","repairLlm","repairUndoAvailable"]', J(Object.keys(rs)));
  check('getReasonState().repairLlm 默认 false（LLM 仲裁默认关）', rs.repairLlm === false, J(rs.repairLlm));
  check('getReasonState().repairUndoAvailable 默认 false（尚无撤销点）', rs.repairUndoAvailable === false, J(rs.repairUndoAvailable));
  check('getReasonState().meta 恰好 4 个字段', J(Object.keys(rs.meta)) === '["lastInferredAt","inferredStale","lastStats","lastGuard"]', J(Object.keys(rs.meta)));
  check('getReasonState().counts = {total:3,inferred:1,raw:2,byVia:{transitive:1}}', J(rs.counts) === '{"total":3,"inferred":1,"raw":2,"byVia":{"transitive":1}}', J(rs.counts));
  check('getReasonState().lastInconsistencies=0', rs.lastInconsistencies === 0, J(rs.lastInconsistencies));
  check('getReasonState().features 有 3 项（bfo-lite 3 个带特性谓词）', rs.features.length === 3, J(rs.features.length));
  check('getReasonState().unavailableReason 为空', rs.unavailableReason === '');

  const pf = graph.predicateFeatures('bfo-lite');
  check('predicateFeatures(bfo-lite) 3 项', pf.length === 3, J(pf.length));
  check('predicateFeatures 每项恰好 8 个字段', J(Object.keys(pf[0])) === '["key","label","features","inverseOf","domain","range","domainLabels","rangeLabels"]', J(Object.keys(pf[0])));
  check('bfo-lite「包含」= transitive，无 domain/range/inverse', J(pf.find((f) => f.key === '包含')) === '{"key":"包含","label":"包含","features":["transitive"],"inverseOf":[],"domain":[],"range":[],"domainLabels":[],"rangeLabels":[]}', J(pf.find((f) => f.key === '包含')));
  check('bfo-lite「相关」= symmetric', J(pf.find((f) => f.key === '相关').features) === '["symmetric"]', J(pf.find((f) => f.key === '相关')));
  check('bfo-lite「矛盾于」= asymmetric', J(pf.find((f) => f.key === '矛盾于').features) === '["asymmetric"]', J(pf.find((f) => f.key === '矛盾于')));
  check('predicateFeatures(bfo) 8 项', graph.predicateFeatures('bfo').length === 8, J(graph.predicateFeatures('bfo').length));
  check('predicateFeatures(iso15926) 10 项', graph.predicateFeatures('iso15926').length === 10, J(graph.predicateFeatures('iso15926').length));
  check('predicateFeatures(未知体系) 回退 bfo-lite（3 项）', graph.predicateFeatures('nope-xyz').length === 3, J(graph.predicateFeatures('nope-xyz').length));
  // IPC 走 JSON 序列化：Set 必须已展开成数组，否则渲染进程拿到 {}
  check('IPC 安全：domain/range/inverseOf/features 序列化后不出现空对象（Set 已展开）', !/"(domain|range|inverseOf|features)":\{\}/.test(J(pf)), J(pf).slice(0, 200));

  const rsBfo = graph.getReasonState('bfo');
  check('bfo 护栏覆盖率 13%（15 谓词中 2 个有 domain/range）', rsBfo.coverage.predicates === 15 && rsBfo.coverage.withAny === 2 && rsBfo.coverage.coveragePct === 13, J({ p: rsBfo.coverage.predicates, a: rsBfo.coverage.withAny, pct: rsBfo.coverage.coveragePct }));
  const rsIso = graph.getReasonState('iso15926');
  check('iso15926 护栏覆盖率 14%（14 谓词中 2 个有 domain/range）', rsIso.coverage.predicates === 14 && rsIso.coverage.withAny === 2 && rsIso.coverage.coveragePct === 14, J({ p: rsIso.coverage.predicates, pct: rsIso.coverage.coveragePct }));
  const fInh = rsBfo.features.find((f) => f.key === 'inheres_in');
  check('§4.3 bfo「inheres_in」带 domain/range（护栏据此拦截）', J(fInh.domain) === '["specifically_dependent_continuant"]' && J(fInh.range) === '["independent_continuant"]', J({ d: fInh.domain, r: fInh.range }));
  check('bfo「inheres_in」的互逆来自公理（inverseOf=bearer_of）', J(fInh.inverseOf) === '["bearer_of"]', J(fInh.inverseOf));
  check('bfo「inheres_in」带中文 domainLabels/rangeLabels（供 UI 展示）', J(fInh.domainLabels) === '["特依存持续体"]' && J(fInh.rangeLabels) === '["独立持续体"]', J({ d: fInh.domainLabels, r: fInh.rangeLabels }));

  // ======================================================================
  section('§6.5 impactClosureFor：实体详情面板「影响面」区块');
  // ======================================================================
  graph.saveGraph(chain3().nodes, chain3().edges);
  await graph.runInference({}, {});
  const im = graph.impactClosureFor('bfo-lite:a', {});
  check('impactClosureFor 恰好 9 个字段', J(Object.keys(im)) === '["ok","usable","profileId","profileName","seed","nodes","facts","summary","inferredCount"]', J(Object.keys(im)));
  check('ok=true / usable=true / profileId=bfo-lite', im.ok === true && im.usable === true && im.profileId === 'bfo-lite' && im.profileName === 'BFO-Lite 轻量体系', J({ ok: im.ok, u: im.usable, p: im.profileId }));
  check('seed 带 {id,name,type}', J(im.seed) === '{"id":"bfo-lite:a","name":"A","type":"object"}', J(im.seed));
  check('下游闭包命中 B、C 两个节点', J(im.nodes.map((n) => n.name)) === '["B","C"]', J(im.nodes.map((n) => n.name)));
  check('其中 1 个来自推理边（inferredCount=1）', im.inferredCount === 1, J(im.inferredCount));
  check('生成 2 条传导事实', im.facts.length === 2, J(im.facts.length));
  check('summary 为人话（含谓词名/节点数/跳数）', im.summary === '影响面扩展完成（沿传递谓词 包含，共 2 个下游节点，最深 1 跳）', J(im.summary));
  check('节点不存在 → {ok:false,error:"节点不存在：nope"}', J(graph.impactClosureFor('nope', {})) === '{"ok":false,"error":"节点不存在：nope"}', J(graph.impactClosureFor('nope', {})));
  check('空 id → {ok:false,error:"节点不存在："}', J(graph.impactClosureFor('', {})) === '{"ok":false,"error":"节点不存在："}', J(graph.impactClosureFor('', {})));

  // 体系声明了传递谓词、但图里没有对应连线 → usable=true 且闭包为空（不是报错）
  graph.saveGraph([N('a', 'A'), N('b', 'B')], [{ from: 'bfo-lite:a', to: 'bfo-lite:b', rel: '相关' }]);
  const imNone = graph.impactClosureFor('bfo-lite:a', {});
  check('只有对称边时 ok=true / usable=true / nodes 空（不是报错）', imNone.ok === true && imNone.usable === true && J(imNone.nodes) === '[]', J({ ok: imNone.ok, u: imNone.usable, n: imNone.nodes }));
  check('闭包为空时 summary 仍给出人话（0 个下游节点 / 0 跳）', imNone.summary === '影响面扩展完成（沿传递谓词 包含，共 0 个下游节点，最深 0 跳）', J(imNone.summary));
  check('闭包为空时 facts 也为空', J(imNone.facts) === '[]', J(imNone.facts));
  check('默认不跟随对称谓词（否则「相关」会把全图连成一片，影响面失去意义）', imNone.nodes.length === 0 && imNone.inferredCount === 0, J({ n: imNone.nodes.length, i: imNone.inferredCount }));
  const imSym = graph.impactClosureFor('bfo-lite:a', { followSymmetric: true });
  check('followSymmetric:true → 对称边纳入闭包（命中 B）', J(imSym.nodes.map((n) => n.name)) === '["B"]', J(imSym.nodes.map((n) => n.name)));

  graph.saveGraph(chain3().nodes, chain3().edges);
  await graph.runInference({}, {});
  const imD1 = graph.impactClosureFor('bfo-lite:a', { maxDepth: 1 });
  check('maxDepth=1 时推理捷径 a→c 让 C 仍落在 1 跳内', J(imD1.nodes.map((n) => n.name)) === '["B","C"]', J(imD1.nodes.map((n) => n.name)));
  check('闭包节点带 via/depth/path/inferred（供 §6.5 面板展示推导链）', imD1.nodes.every((n) => 'via' in n && 'depth' in n && Array.isArray(n.path) && 'inferred' in n), J(imD1.nodes));
  check('其中 C 标记为来自推理边', imD1.nodes.find((n) => n.name === 'C').inferred === true, J(imD1.nodes.find((n) => n.name === 'C')));
  const imNoInf = graph.impactClosureFor('bfo-lite:a', { includeInferred: false });
  check('includeInferred:false → 只走原始边，C 不在 1 跳内（depth=2）', J(imNoInf.nodes.map((n) => `${n.name}@${n.depth}`)) === '["B@1","C@2"]', J(imNoInf.nodes.map((n) => `${n.name}@${n.depth}`)));
  check('includeInferred:false → inferredCount=0', imNoInf.inferredCount === 0, J(imNoInf.inferredCount));
  const imUp = graph.impactClosureFor('bfo-lite:c', { direction: 'upstream' });
  check('direction=upstream → 反向找出 A、B（谁出问题会波及我）', J(imUp.nodes.map((n) => n.name).sort()) === '["A","B"]', J(imUp.nodes.map((n) => n.name)));
  // ⚠️ 文案瑕疵：upstream/both 的 summary 仍写「下游节点」，前端若要区分方向得自己拼串或改 impact.js
  check('⚠️ summary 文案未随 direction 变化（始终说「下游节点」）', imUp.summary === '影响面扩展完成（沿传递谓词 包含，共 2 个下游节点，最深 1 跳）', J(imUp.summary));
  const imBoth = graph.impactClosureFor('bfo-lite:b', { direction: 'both' });
  check('direction=both → 上下游都收（B 命中 A 与 C）', J(imBoth.nodes.map((n) => n.name).sort()) === '["A","C"]', J(imBoth.nodes.map((n) => n.name)));

  // 导入一个「无传递/互逆声明」的 OWL 体系 → §6.5 面板要显示 hint 而不是空白
  const ttlNoTrans = writeFile(path.join(env.dir, 'notrans.ttl'), `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ex: <http://example.org/nt#> .
ex:Thing a owl:Class ; rdfs:label "事物" .
ex:Part a owl:Class ; rdfs:subClassOf ex:Thing ; rdfs:label "部件" .
ex:knows a owl:ObjectProperty ; rdfs:label "认识" ; rdfs:domain ex:Thing ; rdfs:range ex:Thing .
`);
  const impNoTrans = await graph.importOwl(ttlNoTrans, {});
  const pidNT = impNoTrans.profile.id;
  check('importOwl 注册出 owl:notrans 体系', pidNT === 'owl:notrans' && graph.listProfiles().some((p) => p.id === 'owl:notrans'), J(graph.listProfiles().map((p) => p.id)));
  check('该体系 coverage.transitive 为空', J(graph.getReasonState(pidNT).coverage.transitive) === '[]', J(graph.getReasonState(pidNT).coverage.transitive));
  check('该体系谓词仍带 domain/range（护栏可用，只是没有传递性）', J(graph.predicateFeatures(pidNT)[0]) === '{"key":"knows","label":"认识","features":[],"inverseOf":[],"domain":["Thing"],"range":["Thing"],"domainLabels":["事物"],"rangeLabels":["事物"]}', J(graph.predicateFeatures(pidNT)[0]));
  graph.saveGraph(
    [{ id: `${pidNT}:a`, name: 'A', type: 'Thing', profile: pidNT }, { id: `${pidNT}:b`, name: 'B', type: 'Part', profile: pidNT }],
    [{ from: `${pidNT}:a`, to: `${pidNT}:b`, rel: 'knows' }]
  );
  const imNT = graph.impactClosureFor(`${pidNT}:a`, {});
  check('§6.5 无传递谓词的体系 → ok=true / usable=false（不是报错）', imNT.ok === true && imNT.usable === false, J({ ok: imNT.ok, u: imNT.usable }));
  check('usable=false 时返回 8 个字段（无 seed/inferredCount，多一个 hint）', J(Object.keys(imNT)) === '["ok","usable","profileId","profileName","nodes","facts","summary","hint"]', J(Object.keys(imNT)));
  check('hint 是人话，供面板直接展示', imNT.hint === '该体系未声明传递/互逆谓词，无法做影响面闭包', J(imNT.hint));
  check('usable=false 时 nodes/facts 空、summary 空串', J(imNT.nodes) === '[]' && J(imNT.facts) === '[]' && imNT.summary === '', J({ n: imNT.nodes, f: imNT.facts, s: imNT.summary }));
  const rNT = await graph.runInference({}, {});
  check('该体系跑推理不报错，只是推不出新边（inferredEdges=0）', rNT.ok === true && rNT.skipped === false && rNT.inferredEdges === 0, J({ ok: rNT.ok, s: rNT.skipped, i: rNT.inferredEdges }));
  graph.removeOwlProfile(pidNT);
  check('removeOwlProfile 后体系列表回到内置 6 个', J(graph.listProfiles().map((p) => p.id)) === '["bfo-lite","bfo","iso15926","ogms","legal","automotive"]', J(graph.listProfiles().map((p) => p.id)));

  // ======================================================================
  section('§5.3 deleteEdgeWithCascade：删边并回收依赖它的推理边');
  // ======================================================================
  graph.saveGraph(chain3().nodes, chain3().edges);
  await graph.runInference({}, {});
  check('级联前 3 条边（2 原始 + 1 推理）', J(graph.getGraph().edges.map((e) => `${e.rel}|inf=${!!e.inferred}`)) === '["包含|inf=false","包含|inf=false","包含|inf=true"]', J(graph.getGraph().edges.map((e) => `${e.rel}|inf=${!!e.inferred}`)));
  const de = graph.deleteEdgeWithCascade(0);
  check('deleteEdgeWithCascade 恰好 5 个字段', J(Object.keys(de)) === '["ok","removed","cascaded","total","edge"]', J(Object.keys(de)));
  check('删 a→b 连带回收 a→c 推理边（removed=2 / cascaded=1）', de.ok === true && de.removed === 2 && de.cascaded === 1 && de.total === 1, J(de));
  check('返回被删边本体 {from,to,rel}（供 UI toast）', J(de.edge) === '{"from":"bfo-lite:a","to":"bfo-lite:b","rel":"包含"}', J(de.edge));
  check('图里只剩 b→c 原始边', J(graph.getGraph().edges.map((e) => `${e.from}->${e.to}|inf=${!!e.inferred}`)) === '["bfo-lite:b->bfo-lite:c|inf=false"]', J(graph.getGraph().edges.map(edgeTag)));
  check('§5.4 删边后 meta.inferredStale=true', graph.getGraphMeta().inferredStale === true);
  for (const bad of [-1, 999, 1.5, 'x']) {
    check(`下标 ${J(bad)} → {ok:false,error:"边下标越界"}`, J(graph.deleteEdgeWithCascade(bad)) === '{"ok":false,"error":"边下标越界"}', J(graph.deleteEdgeWithCascade(bad)));
  }

  // ======================================================================
  section('§5.3 deleteNodeWithCascade：删节点并回收相关边');
  // ======================================================================
  graph.saveGraph(chain3().nodes, chain3().edges);
  await graph.runInference({}, {});
  const dn = graph.deleteNodeWithCascade('bfo-lite:b');
  check('deleteNodeWithCascade 恰好 6 个字段', J(Object.keys(dn)) === '["ok","nodeId","removedEdges","cascaded","nodeCount","edgeCount"]', J(Object.keys(dn)));
  check('删中间节点 b：3 条边全清（含级联 1 条），剩 2 节点 0 边', dn.ok === true && dn.removedEdges === 3 && dn.cascaded === 1 && dn.nodeCount === 2 && dn.edgeCount === 0, J(dn));
  check('剩余节点为 a、c', J(graph.getGraph().nodes.map((n) => n.id)) === '["bfo-lite:a","bfo-lite:c"]', J(graph.getGraph().nodes.map((n) => n.id)));
  check('剩余边为空', graph.getGraph().edges.length === 0);
  check('§5.4 删节点后 meta.inferredStale=true', graph.getGraphMeta().inferredStale === true);
  check('节点不存在 → {ok:false,error:"节点不存在：nope"}', J(graph.deleteNodeWithCascade('nope')) === '{"ok":false,"error":"节点不存在：nope"}', J(graph.deleteNodeWithCascade('nope')));
  check('空 id → {ok:false,error:"未指定节点"}', J(graph.deleteNodeWithCascade('')) === '{"ok":false,"error":"未指定节点"}', J(graph.deleteNodeWithCascade('')));

  // ======================================================================
  section('§6.6 clearInferredEdges：只清推理边，保留原始图与统计');
  // ======================================================================
  graph.saveGraph(chain3().nodes, chain3().edges);
  await graph.runInference({}, {});
  const ce = graph.clearInferredEdges();
  check('clearInferredEdges → {ok:true,removed:1,total:2}', J(ce) === '{"ok":true,"removed":1,"total":2}', J(ce));
  check('只剩 2 条原始边', J(graph.getGraph().edges.map((e) => `${e.rel}|inf=${!!e.inferred}`)) === '["包含|inf=false","包含|inf=false"]', J(graph.getGraph().edges.map((e) => `${e.rel}|inf=${!!e.inferred}`)));
  const metaCe = graph.getGraphMeta();
  check('清空后 lastInferredAt 归零 / inferredStale 归 false', metaCe.lastInferredAt === 0 && metaCe.inferredStale === false, J({ t: metaCe.lastInferredAt, s: metaCe.inferredStale }));
  check('清空后 lastStats 仍保留（推理 Tab 要显示「上次运行」）', metaCe.lastStats && metaCe.lastStats.inferredEdges === 1, J(metaCe.lastStats));
  check('clearInferredEdges 幂等（第二次 removed=0）', J(graph.clearInferredEdges()) === '{"ok":true,"removed":0,"total":2}', J(graph.clearInferredEdges()));

  // ======================================================================
  section('§5.2 extractGraph：原始图先落库，推理是增强项');
  // ======================================================================
  const fake = await startFakeLlm(({ url, body }) => {
    if (!url.endsWith('/chat/completions')) return { status: 404, text: 'no' };
    const txt = (body.messages || []).map((m) => m.content).join('\n');
    if (/抽取可能在知识图谱中存在的实体名/.test(txt)) return json({ names: ['变压器'] });
    return json({
      nodes: [
        { name: '变压器', type: 'object', desc: '变电设备' },
        { name: '配电柜', type: 'object', desc: '配电' },
        { name: '充电桩', type: 'object', desc: '终端' },
      ],
      edges: [
        { from: '变压器', to: '配电柜', rel: '包含' },
        { from: '配电柜', to: '充电桩', rel: '包含' },
      ],
    });
  });
  const settings = { ...settingsMod.getSettings(), ...fake.settings() };

  graph.clearGraph();
  const stages = [];
  const ex = await graph.extractGraph(settings, { inlineSources: [{ label: '笔记·电力', text: '变压器包含配电柜，配电柜包含充电桩。' }] }, (kind, text) => stages.push({ kind, text }), null, null);
  check('extractGraph 返回恰好 10 个字段', J(Object.keys(ex)) === '["nodeCount","edgeCount","rawEdgeCount","sourceCount","sourceLabels","profileId","profileName","failedTasks","guard","reason"]', J(Object.keys(ex)));
  check('抽取 3 节点 / 2 原始边 / 推理后共 3 边', ex.nodeCount === 3 && ex.rawEdgeCount === 2 && ex.edgeCount === 3, J({ n: ex.nodeCount, raw: ex.rawEdgeCount, e: ex.edgeCount }));
  check('默认体系为 bfo-lite', ex.profileId === 'bfo-lite' && ex.profileName === 'BFO-Lite 轻量体系', J({ id: ex.profileId, name: ex.profileName }));
  check('sourceLabels 回传来源标签', J(ex.sourceLabels) === '["笔记·电力"]', J(ex.sourceLabels));
  check('bfo-lite 无 domain/range → guard 为 null（覆盖率 0%，属预期而非失效）', ex.guard === null, J(ex.guard));
  check('reason 汇总：新增 1 条推理边 / bound=1 / dropped=0', ex.reason && ex.reason.skipped === false && ex.reason.inferredEdges === 1 && ex.reason.bound === 1 && ex.reason.dropped === 0, J(ex.reason && { s: ex.reason.skipped, i: ex.reason.inferredEdges, b: ex.reason.bound, d: ex.reason.dropped }));
  check('extractGraph 的 reason.inconsistencies 是数组（原样透传物化明细）', Array.isArray(ex.reason.inconsistencies) && ex.reason.inconsistencies.length === 0, J(ex.reason.inconsistencies));
  check('reason.stats.rounds=3', ex.reason.stats.rounds === 3, J(ex.reason.stats.rounds));
  check('§6.7 stage 顺序：collect → extract → reason×5', J(stages.map((s) => s.kind)) === '["collect","extract","reason","reason","reason","reason","reason"]', J(stages.map((s) => s.kind)));
  check('首个 reason stage 说明用的是 OWL 2 RL 前向链', stages[2].text === '本地物化推理中（OWL 2 RL 前向链）…', J(stages[2].text));
  check('末个 reason stage 汇报新增边数/轮数/耗时', /^推理完成：新增 1 条推理边（3 轮 \/ \d+ ms）$/.test(stages[6].text), J(stages[6].text));
  check('推理边带 inferredFrom=[0,1] / inferredVia=transitive', (() => {
    const inf = graph.getGraph().edges.find((e) => e.inferred);
    return !!inf && J(inf.inferredFrom) === '[0,1]' && inf.inferredVia === 'transitive';
  })(), J(graph.getGraph().edges.map((e) => ({ inf: !!e.inferred, via: e.inferredVia, from: e.inferredFrom }))));
  const metaEx = graph.getGraphMeta();
  check('抽取后 meta.lastStats 带 profileId=bfo-lite', metaEx.lastStats && metaEx.lastStats.profileId === 'bfo-lite' && metaEx.lastStats.skipReason === '', J(metaEx.lastStats));
  check('抽取后 meta.inferredStale=false / lastInferredAt>0', metaEx.inferredStale === false && metaEx.lastInferredAt > 0, J({ s: metaEx.inferredStale, t: metaEx.lastInferredAt }));

  // autoReason:false（§6.7 复选框未勾选）
  graph.clearGraph();
  const stages2 = [];
  const ex2 = await graph.extractGraph(settings, { inlineSources: [{ label: '笔记·电力', text: 'x' }], autoReason: false }, (k, t) => stages2.push({ k, t }), null, null);
  check('autoReason:false → reason 为 null', ex2.reason === null, J(ex2.reason));
  check('autoReason:false → 所有边都是原始边', graph.getGraph().edges.every((e) => !e.inferred) && graph.getGraph().edges.length === 2, J(graph.getGraph().edges.map(edgeTag)));
  check('autoReason:false → 无 reason stage', J([...new Set(stages2.map((s) => s.k))]) === '["collect","extract"]', J([...new Set(stages2.map((s) => s.k))]));
  check('autoReason:false → meta.lastStats 为 null（没跑过推理）', graph.getGraphMeta().lastStats === null, J(graph.getGraphMeta().lastStats));

  // 总开关关闭：护栏与推理一起静默降级
  graph.clearGraph();
  const stages3 = [];
  const ex3 = await graph.extractGraph({ ...settings, reasonEnabled: false }, { inlineSources: [{ label: '笔记·电力', text: 'x' }] }, (k, t) => stages3.push({ k, t }), null, null);
  check('§6.11 reasonEnabled:false → reason 与 guard 都为 null', ex3.reason === null && ex3.guard === null, J({ r: ex3.reason, g: ex3.guard }));
  check('reasonEnabled:false → 无 guard/reason stage', J([...new Set(stages3.map((s) => s.k))]) === '["collect","extract"]', J([...new Set(stages3.map((s) => s.k))]));
  check('reasonEnabled:false → 抽取本身照常（3 节点 2 边）', ex3.nodeCount === 3 && ex3.edgeCount === 2, J({ n: ex3.nodeCount, e: ex3.edgeCount }));

  // ======================================================================
  section('§4.3 extractGraph 护栏：越界连线降级为回退谓词并留痕');
  // ======================================================================
  graph.clearGraph();
  const fakeBfo = await startFakeLlm(({ url, body }) => {
    if (!url.endsWith('/chat/completions')) return { status: 404, text: 'no' };
    const txt = (body.messages || []).map((m) => m.content).join('\n');
    if (/抽取可能在知识图谱中存在的实体名/.test(txt)) return json({ names: ['甲'] });
    return json({
      nodes: [{ name: '甲', type: 'quality', desc: '' }, { name: '乙', type: 'process', desc: '' }],
      edges: [{ from: '甲', to: '乙', rel: 'inheres_in' }],
    });
  });
  const settingsBfo = { ...settingsMod.getSettings(), ...fakeBfo.settings() };
  const stagesG = [];
  const exG = await graph.extractGraph(settingsBfo, { inlineSources: [{ label: '笔记·测试', text: '甲乙' }], ontologyProfile: 'bfo' }, (k, t) => stagesG.push({ k, t }), null, null);
  check('显式 ontologyProfile="bfo" 生效（体系名 BFO 2020 标准体系）', exG.profileId === 'bfo' && exG.profileName === 'BFO 2020 标准体系', J({ id: exG.profileId, n: exG.profileName }));
  check('护栏拦下 1 条 range 越界连线', J(exG.guard) === '{"total":1,"byReason":{"range-violation":1},"byRel":{"inheres_in":1}}', J(exG.guard));
  check('护栏 stage 说明降级目标谓词', J(stagesG.filter((s) => s.k === 'guard').map((s) => s.t)) === '["护栏拦截 1 条越界连线（已降级为「related_to」）"]', J(stagesG.filter((s) => s.k === 'guard')));
  check('越界边被改写为 related_to（原始边，非推理边）', J(graph.getGraph().edges.map(edgeTag).filter((t) => !/inf=true/.test(t))) === '["bfo:甲->bfo:乙|related_to|inf=false|via="]', J(graph.getGraph().edges.map(edgeTag)));
  check('降级后 related_to 的对称性又推出 1 条推理边', graph.getGraph().edges.some((e) => e.inferred && e.rel === 'related_to' && e.inferredVia === 'symmetric'), J(graph.getGraph().edges.map(edgeTag)));
  const gEntry = graph.getGraphMeta().lastGuard;
  check('meta.lastGuard 留痕：taskNo/from/fromType/rel/to/toType/reason/detail/downgradedTo', gEntry && gEntry.total === 1 && J(Object.keys(gEntry.entries[0])) === '["taskNo","from","fromType","rel","to","toType","reason","detail","downgradedTo"]', J(gEntry && gEntry.entries[0]));
  check('留痕 detail 是人话（说明值域归属）', gEntry.entries[0].detail === '「乙」的类型 process 不属于 independent_continuant 及其子类', J(gEntry.entries[0].detail));
  check('留痕带 profileId=bfo', gEntry.profileId === 'bfo', J(gEntry.profileId));
  check('meta.lastStats.profileId=bfo', graph.getGraphMeta().lastStats.profileId === 'bfo', J(graph.getGraphMeta().lastStats));
  await fakeBfo.close();

  // ======================================================================
  section('§6.8 kgAsk：影响面提问走闭包扩展，推理边事实打 ⚡ 标记');
  // ======================================================================
  graph.clearGraph();
  await graph.extractGraph(settings, { inlineSources: [{ label: '笔记·电力', text: '变压器包含配电柜，配电柜包含充电桩。' }] }, () => {}, null, null);
  check('kgAsk 前置：图里 3 条边（含 1 条推理边）', graph.getGraph().edges.length === 3 && graph.getGraph().edges.filter((e) => e.inferred).length === 1, J(graph.getGraph().edges.map(edgeTag)));

  const ask = async (question, extraSettings) => {
    const sent = [];
    const ev = { sender: { send: (ch, d) => sent.push({ ch, d }) } };
    await graph.kgAsk(ev, { settings: { ...settings, ...(extraSettings || {}) }, question, hops: 2, withFacts: true });
    return {
      stages: sent.filter((s) => s.ch === 'kg:stage').map((s) => (typeof s.d === 'string' ? s.d : s.d && s.d.text)),
      facts: (sent.find((s) => s.ch === 'kg:facts') || { d: null }).d,
      done: sent.some((s) => s.ch === 'ai:done'),
    };
  };

  const a1 = await ask('变压器故障会影响什么');
  check('影响面提问触发闭包 stage（含命中关键词）', a1.stages.some((t) => /^检测到影响面提问（影响、故障），沿传递谓词做闭包扩展…$/.test(t || '')), J(a1.stages));
  check('闭包 stage 汇报下游节点数/推理边数/事实数', a1.stages.some((t) => t === '影响面扩展完成：2 个下游节点（其中 1 个来自推理边），生成 2 条传导事实'), J(a1.stages));
  check('kg:facts 载荷恰好 4 个字段', J(Object.keys(a1.facts)) === '["matched","facts","refs","impact"]', J(Object.keys(a1.facts || {})));
  check('impact 汇总：keywords/nodeCount/factCount/inferredCount/summaries', J(a1.facts.impact) === '{"keywords":["影响","故障"],"nodeCount":2,"factCount":2,"inferredCount":1,"summaries":["影响面扩展完成（沿传递谓词 包含，共 2 个下游节点，最深 1 跳）"]}', J(a1.facts.impact));
  check('推理得出的事实带 ⚡推理 标记（§6.1 视觉语言的文字对应）', a1.facts.facts.some((f) => f === '[bfo-lite·object]变压器 —包含 → [bfo-lite·object]充电桩（1 跳，⚡推理）'), J(a1.facts.facts));
  check('原始事实不带 ⚡ 标记', a1.facts.facts.some((f) => f === '[bfo-lite·object]变压器 —包含 → [bfo-lite·object]配电柜（1 跳）'), J(a1.facts.facts));
  check('问答主链路照常完成（ai:done）', a1.done === true);

  const a2 = await ask('变压器是什么');
  check('非影响面提问不触发闭包 stage', !a2.stages.some((t) => /影响面/.test(t || '')), J(a2.stages));
  check('非影响面提问 impact 为 null', a2.facts.impact === null, J(a2.facts.impact));

  const a3 = await ask('变压器故障会影响什么', { reasonEnabled: false });
  check('§6.11 总开关关闭 → 影响面不跑（impact=null）', a3.facts.impact === null, J(a3.facts.impact));
  check('总开关关闭 → 无影响面 stage，但问答照常', !a3.stages.some((t) => /影响面/.test(t || '')) && a3.done === true, J(a3.stages));

  // ---------- §5.4 惰性重推理（删除 → 标记 stale → 下次 kgAsk 前重跑） ----------
  // 设计文档 §5.4：「节点/边删除：先做级联清理（§5.3），再标记 graphMeta.inferredStale = true，
  // 下次 kgAsk 前重跑」。与约束 D4 一致：「问答时若图未变直接读缓存的 inferred 边，变了才重跑」。
  graph.deleteEdgeWithCascade(0);
  check('§5.3 删边后 inferredStale=true（写入侧）', graph.getGraphMeta().inferredStale === true);
  const a4 = await ask('变压器故障会影响什么');
  check('§5.4 kgAsk 检测到 stale → 首个 stage 提示重新物化', a4.stages[0] === '检测到图谱已变更，重新物化推理…', J(a4.stages[0]));
  check('§5.4 重跑完成后汇报新增推理边数（删掉前提边后推不出新边 → 0 条）', a4.stages.some((t) => t === '推理已刷新：新增 0 条推理边'), J(a4.stages));
  check('§5.4 kgAsk 之后 inferredStale 复位为 false', graph.getGraphMeta().inferredStale === false, J(graph.getGraphMeta()));
  check('§5.4 级联清理的推理边没有被重推理复活（前提边已删）', graph.getGraph().edges.filter((e) => e.inferred).length === 0, J(graph.getGraph().edges.map(edgeTag)));
  const a5 = await ask('变压器故障会影响什么');
  check('图未再变 → 第二次 kgAsk 不重跑（D4：未变直接读缓存）', !a5.stages.some((t) => /重新物化推理/.test(t || '')), J(a5.stages));
  // 总开关关闭时不重跑，stale 保留（下次开启后仍会补跑）
  graph.deleteEdgeWithCascade(0);
  check('再次删边 → stale=true', graph.getGraphMeta().inferredStale === true);
  const a6 = await ask('变压器是什么', { reasonEnabled: false });
  check('§6.11 总开关关闭 → kgAsk 不重跑推理（无 stale stage）', !a6.stages.some((t) => /重新物化推理/.test(t || '')), J(a6.stages));
  check('总开关关闭时 stale 保留为 true（开启后仍会补跑）', graph.getGraphMeta().inferredStale === true, J(graph.getGraphMeta()));
  check('问答照常完成（ai:done）', a6.done === true);
  await fake.close();

  // ======================================================================
  section('§6.9 previewOwlImport：只解析不落库');
  // ======================================================================
  graph.clearGraph();
  const ttlPath = writeFile(path.join(env.dir, 'prev.ttl'), TTL_PREVIEW);
  const pv = await graph.previewOwlImport(ttlPath, {});
  check('previewOwlImport 恰好 7 个字段（新增 filePath 供前端确认导入复用）', J(Object.keys(pv)) === '["ok","profile","report","profileCheck","preview","via","filePath"]', J(Object.keys(pv)));
  check('previewOwlImport 透传 filePath', pv.filePath === ttlPath, J(pv.filePath));
  check('走 protege-js 解析器（via="protege-js"）', pv.ok === true && pv.via === 'protege-js', J({ ok: pv.ok, via: pv.via }));
  check('preview 恰好 18 个字段', pv.preview && Object.keys(pv.preview).length === 18, J(pv.preview && Object.keys(pv.preview)));
  check('preview.counts = 2 类 / 1 谓词 / 4 公理 / 4 约束 / 0 个体 / 1 根', J(pv.preview.counts) === '{"classes":2,"predicates":1,"axioms":4,"constraints":4,"individuals":0,"roots":1}', J(pv.preview.counts));
  check('preview.rootClasses 识别出唯一根类 Device（设备）', J(pv.preview.rootClasses) === '[{"key":"Device","label":"设备"}]', J(pv.preview.rootClasses));
  check('preview.sampleClasses 还原类层级（Charger ⊑ Device）', J(pv.preview.sampleClasses) === '[{"key":"Device","label":"设备","parent":"","desc":""},{"key":"Charger","label":"充电桩","parent":"Device","desc":""}]', J(pv.preview.sampleClasses));
  check('§4.5 子语言判定：推荐 RL，符合 RL+EL，QL 有 1 处不符', J(pv.preview.profileCheck) === '{"recommend":"RL","profiles":["RL","EL"],"reasonerAvailable":true,"rl":{"ok":true,"total":0,"sample":[]},"ql":{"ok":false,"total":1},"el":{"ok":true,"total":0}}', J(pv.preview.profileCheck));
  check('格式探测：Turtle / 按扩展名 / protege-js 解析', pv.preview.detectedFormat === 'Turtle' && pv.preview.detectedBy === 'ext' && pv.preview.parser === 'protege-js' && pv.preview.format === 'Turtle (.ttl)' && pv.preview.formatId === 'Turtle', J({ f: pv.preview.detectedFormat, by: pv.preview.detectedBy, p: pv.preview.parser }));
  check('preview 体系 id 为占位 owl:prev / name 取文件基名（不占用真实 id）', pv.profile.id === 'owl:prev' && pv.profile.name === 'prev', J({ id: pv.profile.id, name: pv.profile.name }));
  check('preview 体系带 2 类 / 1 谓词 / owl=true 标记', pv.profile.classes.length === 2 && pv.profile.predicates.length === 1 && pv.profile.owl === true, J({ c: pv.profile.classes.length, p: pv.profile.predicates.length, owl: pv.profile.owl }));
  check('report 恰好 18 个字段（含依赖推断 externalRefs/hasImportsDecl）', Object.keys(pv.report).length === 18 && Array.isArray(pv.report.externalRefs) && pv.report.hasImportsDecl === false, J(Object.keys(pv.report)));
  check('report.parser=protege-js / sourceFile 为基名（非全路径）', pv.report.parser === 'protege-js' && pv.report.sourceFile === 'prev.ttl', J({ p: pv.report.parser, f: pv.report.sourceFile }));
  check('report 计数与 preview.counts 一致（2 类 / 1 谓词 / 4 公理 / 4 约束 / 0 个体）', pv.report.classCount === 2 && pv.report.predicateCount === 1 && pv.report.axiomCount === 4 && pv.report.constraintCount === 4 && pv.report.individualCount === 0, J({ c: pv.report.classCount, p: pv.report.predicateCount, a: pv.report.axiomCount }));
  check('report.truncated=false / originalClassCount=2（未触发截断）', pv.report.truncated === false && pv.report.originalClassCount === 2, J({ t: pv.report.truncated, o: pv.report.originalClassCount }));
  check('§6.9 预览不写图谱（nodes 仍为 0）', graph.getGraph().nodes.length === 0, J(graph.getGraph().nodes.length));
  check('§6.9 预览不注册体系（listProfiles 仍为内置 6 个）', J(graph.listProfiles().map((p) => p.id)) === '["bfo-lite","bfo","iso15926","ogms","legal","automotive"]', J(graph.listProfiles().map((p) => p.id)));
  const pvBad = await graph.previewOwlImport(path.join(env.dir, 'nope.ttl'), {}).then((r) => ({ resolved: r.ok })).catch((e) => ({ rejected: e.message }));
  check('文件不存在 → reject（错误信息含路径）', !!pvBad.rejected && pvBad.rejected.startsWith('文件不存在：'), J(pvBad));

  // ======================================================================
  section('§6 IPC 通道层：14 个通道全部注册且异常被兜住');
  // ======================================================================
  const { registerIpc } = require('../src/main/ipc');
  registerIpc(() => ({ isDestroyed: () => false, webContents: { send: () => {} } }));
  const invoke = env.el.invoke;
  const CHANNELS = ['graph:reasonStatus', 'graph:reasonState', 'graph:predicateFeatures', 'graph:runInference', 'graph:clearInferred', 'graph:deleteEdge', 'graph:deleteNode', 'graph:impactClosure', 'graph:previewOwl', 'graph:validate', 'graph:planRepairs', 'graph:planRepairsForIssues', 'graph:applyRepairs', 'graph:undoRepair'];
  check('14 个推理通道全部注册（v1.2.2 增 graph:planRepairsForIssues 行级修复）', CHANNELS.every((c) => env.el.handlers.has(c)), J(CHANNELS.filter((c) => !env.el.handlers.has(c))));

  graph.clearGraph();
  const iStatus = await invoke('graph:reasonStatus');
  check('graph:reasonStatus → ok + 5 字段', iStatus.ok === true && J(Object.keys(iStatus).filter((k) => k !== 'ok')) === '["available","enabled","reason","timeoutSec","coverage"]', J(Object.keys(iStatus)));
  const iState = await invoke('graph:reasonState', 'bfo-lite');
  check('graph:reasonState → 12 个字段（11 + ok）', J(Object.keys(iState)) === '["ok","available","enabled","unavailableReason","timeoutSec","meta","counts","coverage","features","lastInconsistencies","repairLlm","repairUndoAvailable"]', J(Object.keys(iState)));
  check('graph:reasonState 空图 counts 全零', J(iState.counts) === '{"total":0,"inferred":0,"raw":0,"byVia":{}}', J(iState.counts));
  const iFeat = await invoke('graph:predicateFeatures', 'bfo-lite');
  check('graph:predicateFeatures → {ok,features}，3 项', iFeat.ok === true && iFeat.features.length === 3, J({ ok: iFeat.ok, n: iFeat.features.length }));
  const iEmpty = await invoke('graph:runInference', {});
  check('graph:runInference 空图 → empty-graph（不抛）', J(iEmpty) === '{"ok":false,"skipped":true,"skipReason":"empty-graph","error":"图谱为空"}', J(iEmpty));
  check('graph:clearInferred 空图 → {ok:true,removed:0,total:0}', J(await invoke('graph:clearInferred')) === '{"ok":true,"removed":0,"total":0}', J(await invoke('graph:clearInferred')));
  check('graph:deleteEdge 越界 → {ok:false,error}（不抛）', J(await invoke('graph:deleteEdge', 0)) === '{"ok":false,"error":"边下标越界"}', J(await invoke('graph:deleteEdge', 0)));
  check('graph:deleteNode 不存在 → {ok:false,error}（不抛）', J(await invoke('graph:deleteNode', 'nope')) === '{"ok":false,"error":"节点不存在：nope"}', J(await invoke('graph:deleteNode', 'nope')));
  check('graph:impactClosure 不存在 → {ok:false,error}（不抛）', J(await invoke('graph:impactClosure', 'nope', {})) === '{"ok":false,"error":"节点不存在：nope"}', J(await invoke('graph:impactClosure', 'nope', {})));
  check('graph:impactClosure 兼容 web-shim 单 body 形态', J(await invoke('graph:impactClosure', { nodeId: 'nope', opts: {} })) === '{"ok":false,"error":"节点不存在：nope"}', J(await invoke('graph:impactClosure', { nodeId: 'nope', opts: {} })));
  const iVal = await invoke('graph:validate', 'bfo-lite');
  check('graph:validate 空图 → ok:true + checked=0（只读体检，详见 graph-validate.test.js）', iVal.ok === true && iVal.checked === 0 && iVal.profileId === 'bfo-lite', J({ ok: iVal.ok, c: iVal.checked }));

  graph.saveGraph(chain3().nodes, chain3().edges);
  const iRun = await invoke('graph:runInference', {});
  check('graph:runInference 有图 → ok + inferredEdges=1 + bound=1', iRun.ok === true && iRun.skipped === false && iRun.inferredEdges === 1 && iRun.bound === 1, J({ ok: iRun.ok, i: iRun.inferredEdges, b: iRun.bound }));
  check('graph:runInference 回传 total 统计', J(iRun.total) === '{"total":3,"inferred":1,"raw":2,"byVia":{"transitive":1}}', J(iRun.total));
  const iImp = await invoke('graph:impactClosure', 'bfo-lite:a', {});
  check('graph:impactClosure（双参形态）→ 闭包 B、C', iImp.ok === true && iImp.usable === true && J(iImp.nodes.map((n) => n.name)) === '["B","C"]' && iImp.inferredCount === 1, J({ ok: iImp.ok, n: iImp.nodes.map((n) => n.name) }));
  const iImp2 = await invoke('graph:impactClosure', { nodeId: 'bfo-lite:a', opts: { maxDepth: 1 } });
  check('graph:impactClosure（body 形态 + opts 透传）→ 同样命中 B、C', J(iImp2.nodes.map((n) => n.name)) === '["B","C"]', J(iImp2.nodes.map((n) => n.name)));
  const iPv = await invoke('graph:previewOwl', { filePath: ttlPath });
  check('graph:previewOwl → ok + via=protege-js', iPv.ok === true && iPv.via === 'protege-js', J({ ok: iPv.ok, via: iPv.via }));
  const iDe = await invoke('graph:deleteEdge', 0);
  check('graph:deleteEdge(0) → 级联删 2 条', J(iDe) === '{"ok":true,"removed":2,"cascaded":1,"total":1,"edge":{"from":"bfo-lite:a","to":"bfo-lite:b","rel":"包含"}}', J(iDe));
  check('graph:deleteEdge 后图里剩 1 条原始边', J(graph.getGraph().edges.map((e) => `${e.rel}|inf=${!!e.inferred}`)) === '["包含|inf=false"]', J(graph.getGraph().edges.map(edgeTag)));
  const iDn = await invoke('graph:deleteNode', 'bfo-lite:c');
  check('graph:deleteNode(c) → 删 1 条边，剩 2 节点 0 边', J(iDn) === '{"ok":true,"nodeId":"bfo-lite:c","removedEdges":1,"cascaded":0,"nodeCount":2,"edgeCount":0}', J(iDn));
  check('graph:reasonState 清后 counts 归零', J((await invoke('graph:reasonState', 'bfo-lite')).counts) === '{"total":0,"inferred":0,"raw":0,"byVia":{}}', J((await invoke('graph:reasonState', 'bfo-lite')).counts));

  // ======================================================================
  section('§9 风险 1/2 protege-js 缺失：主链路照常，推理入口静默降级');
  // ======================================================================
  // 必须在 require graph.js 之前拦截 reason/*，所以只能开子进程跑
  const degradeScript = path.join(env.dir, 'degrade-probe.js');
  fs.writeFileSync(degradeScript, `
    'use strict';
    const Module = require('module');
    const path = require('path');
    const REPO = ${J(env.repoRoot)};
    const { bootEnv, startFakeLlm, sseText } = require(path.join(REPO, 'test/helpers/harness'));
    const json = (o) => ({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, sse: sseText(JSON.stringify(o)) });
    const out = [];
    const P = (k, v) => out.push(k + '=' + JSON.stringify(v));
    (async () => {
      const env = await bootEnv({ prefix: 'synapse-degrade-' });
      const origLoad = Module._load;
      Module._load = function (request) {
        if (/reason[\\\\/](infer|guard|impact|bridge|owlImport|profile)$/.test(request)) throw new Error('模拟 protege-js 缺失');
        return origLoad.apply(this, arguments);
      };
      const graph = require(path.join(REPO, 'src/main/graph/graph'));
      const settingsMod = require(path.join(REPO, 'src/main/common/settings'));
      P('reasonReady', graph.reasonReady());
      P('reasonUnavailableReason', graph.reasonUnavailableReason());
      P('reasonEnabled', graph.reasonEnabled({}));
      const st = graph.reasonStatus();
      P('reasonStatus', { available: st.available, enabled: st.enabled, reason: st.reason, timeoutSec: st.timeoutSec, coverage: st.coverage });
      const rs = graph.getReasonState('bfo-lite');
      P('getReasonState', { available: rs.available, enabled: rs.enabled, unavailableReason: rs.unavailableReason, coverage: rs.coverage, features: rs.features, counts: rs.counts, lastInconsistencies: rs.lastInconsistencies });
      P('predicateFeatures', graph.predicateFeatures('bfo-lite'));
      P('runInference', await graph.runInference({}, {}));
      P('impactClosureFor', graph.impactClosureFor('x', {}));
      P('validateGraph', graph.validateGraph('bfo-lite'));
      P('previewOwlImport', await graph.previewOwlImport(path.join(env.dir, 'nope.ttl'), {}).then((r) => ({ ok: r.ok, via: r.via })).catch((e) => ({ rejected: String(e.message).slice(0, 20) })));
      const N = (id, name) => ({ id: 'bfo-lite:' + id, name, type: 'object', profile: 'bfo-lite', desc: '', sources: [], domain: '' });
      const G = () => [N('a', 'A'), N('b', 'B'), N('c', 'C')];
      const E3 = () => [{ from: 'bfo-lite:a', to: 'bfo-lite:b', rel: '包含' }, { from: 'bfo-lite:b', to: 'bfo-lite:c', rel: '包含' }, { from: 'bfo-lite:a', to: 'bfo-lite:c', rel: '包含', inferred: true, inferredVia: 'transitive', inferredFrom: [0, 1] }];
      graph.saveGraph(G(), E3());
      P('clearInferredEdges', graph.clearInferredEdges());
      P('edgesAfterClear', graph.getGraph().edges.map((e) => e.rel + '|inf=' + !!e.inferred));
      graph.saveGraph(G(), E3());
      P('deleteEdgeWithCascade', graph.deleteEdgeWithCascade(0));
      P('edgesAfterDeleteEdge', graph.getGraph().edges.map((e) => e.from + '->' + e.to + '|inf=' + !!e.inferred));
      P('inferredStale', graph.getGraphMeta().inferredStale);
      graph.saveGraph(G(), [{ from: 'bfo-lite:a', to: 'bfo-lite:b', rel: '包含' }, { from: 'bfo-lite:b', to: 'bfo-lite:c', rel: '包含' }]);
      P('deleteNodeWithCascade', graph.deleteNodeWithCascade('bfo-lite:b'));
      P('graphAfterDeleteNode', { nodes: graph.getGraph().nodes.map((n) => n.id), edges: graph.getGraph().edges.length });
      const fake = await startFakeLlm(({ url }) => url.endsWith('/chat/completions')
        ? json({ nodes: [{ name: '甲', type: 'object', desc: '' }, { name: '乙', type: 'object', desc: '' }], edges: [{ from: '甲', to: '乙', rel: '包含' }] })
        : { status: 404, text: 'no' });
      const settings = { ...settingsMod.getSettings(), ...fake.settings() };
      graph.clearGraph();
      const stages = [];
      const res = await graph.extractGraph(settings, { inlineSources: [{ label: '笔记·x', text: '甲乙' }] }, (k, t) => stages.push(k), null, null);
      P('extractGuard', res.guard);
      P('extractReason', res.reason);
      P('extractStageKinds', [...new Set(stages)]);
      P('extractCounts', { nodeCount: res.nodeCount, edgeCount: res.edgeCount, rawEdgeCount: res.rawEdgeCount });
      P('extractAllRaw', graph.getGraph().edges.every((e) => !e.inferred));
      const sent = [];
      // §5.4 的惰性重推理在降级下必须整体跳过：显式置 stale，验证 kgAsk 不尝试重跑也不崩
      graph.setGraphMeta({ inferredStale: true });
      await graph.kgAsk({ sender: { send: (ch, d) => sent.push({ ch, d }) } }, { settings, question: '甲故障会影响什么', hops: 2, withFacts: true });
      P('kgAskImpact', (sent.find((s) => s.ch === 'kg:facts') || { d: {} }).d.impact);
      P('kgAskDone', sent.some((s) => s.ch === 'ai:done'));
      P('kgAskStages', sent.filter((s) => s.ch === 'kg:stage').map((s) => (typeof s.d === 'string' ? s.d : s.d && s.d.text)));
      P('inferredStaleAfterAsk', graph.getGraphMeta().inferredStale);
      await fake.close();
      Module._load = origLoad;
      require('fs').writeFileSync(process.env.DEGRADE_OUT, out.join('\\n'), 'utf-8');
    })().catch((e) => { require('fs').writeFileSync(process.env.DEGRADE_OUT, 'DEGRADE_ERROR ' + (e && e.stack || e), 'utf-8'); process.exitCode = 1; });
  `, 'utf-8');
  const degradeOut = path.join(env.dir, 'degrade-out.txt');
  const child = spawnSync(process.execPath, [degradeScript], {
    cwd: env.repoRoot, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, timeout: 180000,
    env: { ...process.env, DEGRADE_OUT: degradeOut },
  });
  const degrade = {};
  for (const line of String(fs.readFileSync(degradeOut, 'utf-8')).split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) { try { degrade[line.slice(0, i)] = JSON.parse(line.slice(i + 1)); } catch (_) { degrade[line.slice(0, i)] = line.slice(i + 1); } }
  }
  check('降级子进程正常结束（无未捕获异常）', child.status === 0 && !degrade.DEGRADE_ERROR, J({ status: child.status, err: (child.stderr || '').slice(0, 300), de: degrade.DEGRADE_ERROR }));
  check('reasonReady()=false', degrade.reasonReady === false, J(degrade.reasonReady));
  check('reasonUnavailableReason() 说明加载失败原因', String(degrade.reasonUnavailableReason).startsWith('推理模块加载失败：'), J(degrade.reasonUnavailableReason));
  check('reasonEnabled({}) 连带为 false（不可用即视为关）', degrade.reasonEnabled === false, J(degrade.reasonEnabled));
  check('reasonStatus → available=false / enabled=false / coverage=null / reason 非空', degrade.reasonStatus && degrade.reasonStatus.available === false && degrade.reasonStatus.enabled === false && degrade.reasonStatus.coverage === null && !!degrade.reasonStatus.reason, J(degrade.reasonStatus));
  check('reasonStatus.timeoutSec 仍可读（30）', degrade.reasonStatus && degrade.reasonStatus.timeoutSec === 30, J(degrade.reasonStatus && degrade.reasonStatus.timeoutSec));
  check('getReasonState → available=false / coverage=null / features=[] / counts 全零', degrade.getReasonState && degrade.getReasonState.available === false && degrade.getReasonState.coverage === null && J(degrade.getReasonState.features) === '[]' && J(degrade.getReasonState.counts) === '{"total":0,"inferred":0,"raw":0,"byVia":{}}', J(degrade.getReasonState));
  check('getReasonState.unavailableReason 透出原因（供 UI 显示而非静默失效）', String(degrade.getReasonState && degrade.getReasonState.unavailableReason).includes('模拟 protege-js 缺失'), J(degrade.getReasonState && degrade.getReasonState.unavailableReason));
  check('predicateFeatures → 空数组（不抛）', J(degrade.predicateFeatures) === '[]', J(degrade.predicateFeatures));
  check('runInference → skipped + reasoner-unavailable', J(degrade.runInference) === '{"ok":false,"skipped":true,"skipReason":"reasoner-unavailable","error":"推理模块加载失败：模拟 protege-js 缺失"}', J(degrade.runInference));
  check('impactClosureFor → {ok:false,error:原因}（不抛）', degrade.impactClosureFor && degrade.impactClosureFor.ok === false && String(degrade.impactClosureFor.error).includes('模拟 protege-js 缺失'), J(degrade.impactClosureFor));
  check('validateGraph → {ok:false,error:原因}（不抛；通道 C 随 reason/* 整体降级）', degrade.validateGraph && degrade.validateGraph.ok === false && String(degrade.validateGraph.error).includes('模拟 protege-js 缺失'), J(degrade.validateGraph));
  check('previewOwlImport 不抛（缺文件时按 reject 处理）', degrade.previewOwlImport && (degrade.previewOwlImport.via === 'owl.js' || !!degrade.previewOwlImport.rejected), J(degrade.previewOwlImport));
  check('clearInferredEdges 仍可用（纯数组过滤，不依赖推理器）', J(degrade.clearInferredEdges) === '{"ok":true,"removed":1,"total":2}', J(degrade.clearInferredEdges));
  check('clearInferredEdges 后只剩 2 条原始边', J(degrade.edgesAfterClear) === '["包含|inf=false","包含|inf=false"]', J(degrade.edgesAfterClear));
  check('deleteEdgeWithCascade 降级为「只删这一条」（cascaded=0）', J(degrade.deleteEdgeWithCascade) === '{"ok":true,"removed":1,"cascaded":0,"total":2,"edge":{"from":"bfo-lite:a","to":"bfo-lite:b","rel":"包含"}}', J(degrade.deleteEdgeWithCascade));
  check('降级删边后旧推理边仍在（无级联能力，符合降级预期）', J(degrade.edgesAfterDeleteEdge) === '["bfo-lite:b->bfo-lite:c|inf=false","bfo-lite:a->bfo-lite:c|inf=true"]', J(degrade.edgesAfterDeleteEdge));
  check('降级时仍写 inferredStale=true', degrade.inferredStale === true, J(degrade.inferredStale));
  check('deleteNodeWithCascade 降级为「删节点 + 删相邻边」', J(degrade.deleteNodeWithCascade) === '{"ok":true,"nodeId":"bfo-lite:b","removedEdges":2,"cascaded":0,"nodeCount":2,"edgeCount":0}', J(degrade.deleteNodeWithCascade));
  check('降级删节点后剩 a、c 两节点 0 边', J(degrade.graphAfterDeleteNode) === '{"nodes":["bfo-lite:a","bfo-lite:c"],"edges":0}', J(degrade.graphAfterDeleteNode));
  check('extractGraph 降级：guard=null / reason=null', degrade.extractGuard === null && degrade.extractReason === null, J({ g: degrade.extractGuard, r: degrade.extractReason }));
  check('extractGraph 降级：stage 只有 collect/extract', J(degrade.extractStageKinds) === '["collect","extract"]', J(degrade.extractStageKinds));
  check('extractGraph 降级：抽取本身照常（2 节点 1 边，全为原始边）', J(degrade.extractCounts) === '{"nodeCount":2,"edgeCount":1,"rawEdgeCount":1}' && degrade.extractAllRaw === true, J({ c: degrade.extractCounts, raw: degrade.extractAllRaw }));
  check('kgAsk 降级：影响面不跑（impact=null）', degrade.kgAskImpact === null, J(degrade.kgAskImpact));
  check('kgAsk 降级：§5.4 惰性重推理整体跳过（无「重新物化」stage）', !String(J(degrade.kgAskStages)).includes('重新物化推理'), J(degrade.kgAskStages));
  check('kgAsk 降级：stale 标志保留为 true（推理恢复后下次问答会补跑）', degrade.inferredStaleAfterAsk === true, J(degrade.inferredStaleAfterAsk));
  check('kgAsk 降级：问答主链路照常完成', degrade.kgAskDone === true, J(degrade.kgAskDone));

  summary();
})().catch((err) => { console.error('测试执行异常：', err); process.exitCode = 1; });
