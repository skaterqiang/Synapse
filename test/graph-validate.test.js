'use strict';
// 全图校验（通道 C）测试：src/main/graph/reason/validate.js 单元契约
// + src/main/graph/graph.js 的 validateGraph 包装 + IPC graph:validate 通道。
// 对照《Synapse×protege-js 融合设计》§12.2.3（通道 C：只读体检，不改图）与 §12.5（13 字段硬契约，v1.2.2）。
//
// ⚠️ 性能红线同其他推理测试：所有图谱 ≤ 6 节点（截断用例 51 节点但零推理，纯 guard 循环）。
const path = require('path');
const { bootEnv, mkCheck } = require('./helpers/harness');

const { check, section, summary } = mkCheck('全图校验（reason/validate.js + graph.validateGraph + IPC）');
const J = (v) => JSON.stringify(v);

// ---------- 夹具 ----------
const N = (key, name, type, profile = 'bfo') => ({
  id: `${profile}:${key}`, name: name || key, type, desc: '', sources: [], domain: '', profile,
});

(async () => {
  const env = await bootEnv({ prefix: 'synapse-validate-' });
  const validateMod = require('../src/main/graph/reason/validate');
  const { validateGraph, VIOLATION_CAP } = validateMod;
  const graph = require('../src/main/graph/graph');
  const { ONTOLOGY_PROFILES } = require('../src/main/common/constants');
  const BL = ONTOLOGY_PROFILES['bfo-lite'];
  const BFO = ONTOLOGY_PROFILES['bfo'];

  // ======================================================================
  section('§12.2.3 validate.js：返回体 11 字段硬契约与常量');
  // ======================================================================
  check('VIOLATION_CAP = 50', VIOLATION_CAP === 50, J(VIOLATION_CAP));
  check('模块导出恰好 {validateGraph, VIOLATION_CAP}', J(Object.keys(validateMod).sort()) === '["VIOLATION_CAP","validateGraph"]', J(Object.keys(validateMod)));

  const clean = {
    nodes: [N('q', '性质', 'quality'), N('m', '物质', 'material_entity')],
    edges: [{ from: 'bfo:q', to: 'bfo:m', rel: 'inheres_in' }],
  };
  const r0 = validateGraph(clean, BFO);
  check('返回体恰好 13 个字段（§12.5 硬契约，v1.2.2 起含全量 totals）', J(Object.keys(r0)) === '["ok","profileId","profileName","checked","violations","byReason","byRel","disjointConflicts","coverage","truncated","at","totalViolations","totalDisjointConflicts"]', J(Object.keys(r0)));
  check('零违规时 totals 为 0', r0.totalViolations === 0 && r0.totalDisjointConflicts === 0, J({ tv: r0.totalViolations, td: r0.totalDisjointConflicts }));
  check('ok=true / profileId / profileName 回填', r0.ok === true && r0.profileId === 'bfo' && r0.profileName === 'BFO 2020 标准体系', J({ id: r0.profileId, n: r0.profileName }));
  check('at 为毫秒时间戳', typeof r0.at === 'number' && r0.at > 1700000000000, J(r0.at));
  check('合法边（quality inheres_in material_entity）零违规零冲突', r0.checked === 1 && r0.violations.length === 0 && r0.disjointConflicts.length === 0 && r0.truncated === false, J({ c: r0.checked, v: r0.violations.length, d: r0.disjointConflicts.length }));
  check('coverage 与 guard.coverage 同源（bfo 13% / 15 谓词 / 2 有约束）', r0.coverage && r0.coverage.coveragePct === 13 && r0.coverage.predicates === 15 && r0.coverage.withAny === 2, J(r0.coverage && { p: r0.coverage.predicates, a: r0.coverage.withAny, pct: r0.coverage.coveragePct }));
  check('byReason / byRel 为空对象', J(r0.byReason) === '{}' && J(r0.byRel) === '{}', J({ br: r0.byReason, bl: r0.byRel }));

  const rNull = validateGraph(clean, null);
  check('profile 为 null → ok:false + error「未指定体系」（不抛）', rNull.ok === false && rNull.error === '未指定体系' && rNull.checked === 0, J({ ok: rNull.ok, e: rNull.error }));

  const rEmpty = validateGraph({ nodes: [], edges: [] }, BFO);
  check('空图 → ok:true / checked=0', rEmpty.ok === true && rEmpty.checked === 0 && rEmpty.violations.length === 0, J({ ok: rEmpty.ok, c: rEmpty.checked }));
  const rJunk = validateGraph(null, BFO);
  check('graph 为 null 不抛（按空图处理）', rJunk.ok === true && rJunk.checked === 0, J({ ok: rJunk.ok }));

  // ======================================================================
  section('§12.2.3 validate.js：三类越界 + 不相交归属（cax-dw 只读等价）');
  // ======================================================================
  // bfo-lite 无任何 domain/range 声明 → 覆盖率 0%，合法谓词恒通过
  const blGraph = {
    nodes: [N('a', 'A', 'object', 'bfo-lite'), N('b', 'B', 'object', 'bfo-lite')],
    edges: [{ from: 'bfo-lite:a', to: 'bfo-lite:b', rel: '包含' }],
  };
  const rBL = validateGraph(blGraph, BL);
  check('bfo-lite 合法边零违规（覆盖率 0% 属预期）', rBL.ok === true && rBL.violations.length === 0 && rBL.coverage.coveragePct === 0, J({ v: rBL.violations.length, pct: rBL.coverage.coveragePct }));

  // 未知谓词
  const gUnk = {
    nodes: [N('a', 'A', 'object', 'bfo-lite'), N('b', 'B', 'object', 'bfo-lite')],
    edges: [{ from: 'bfo-lite:a', to: 'bfo-lite:b', rel: 'notarel' }],
  };
  const rUnk = validateGraph(gUnk, BL);
  check('未知谓词 → 1 条 unknown-predicate 违规', rUnk.violations.length === 1 && rUnk.violations[0].reason === 'unknown-predicate', J(rUnk.violations));
  check('违规条目字段齐全（含 v1.2.2 归属字段 profileId/profileName/domain/scopeLabel 与行级修复定位字段 fromId/toId/actual）', J(Object.keys(rUnk.violations[0])) === '["edgeKey","fromId","toId","inferred","from","fromType","rel","to","toType","reason","detail","expected","actual","profileId","profileName","domain","scopeLabel"]', J(Object.keys(rUnk.violations[0])));
  check('edgeKey 为 from|to|rel', rUnk.violations[0].edgeKey === 'bfo-lite:a|bfo-lite:b|notarel', J(rUnk.violations[0].edgeKey));
  check('行级修复定位字段 fromId/toId 为端点 ID', rUnk.violations[0].fromId === 'bfo-lite:a' && rUnk.violations[0].toId === 'bfo-lite:b', J({ f: rUnk.violations[0].fromId, t: rUnk.violations[0].toId }));
  check('违规条目带所属体系（profileId/profileName 回填）', rUnk.violations[0].profileId === 'bfo-lite' && String(rUnk.violations[0].profileName).length > 0, J({ p: rUnk.violations[0].profileId, n: rUnk.violations[0].profileName }));
  check('空 domain 端点 → scope=general / scopeLabel 通用（未匹配领域）', rUnk.violations[0].domain === 'general' && rUnk.violations[0].scopeLabel === '通用（未匹配领域）', J({ d: rUnk.violations[0].domain, s: rUnk.violations[0].scopeLabel }));
  check('byReason / byRel 计数正确', J(rUnk.byReason) === '{"unknown-predicate":1}' && J(rUnk.byRel) === '{"notarel":1}', J({ br: rUnk.byReason, bl: rUnk.byRel }));

  // domain 越界 + 强制类型不相交（process —inheres_in→ material_entity：
  // domain 强制 specifically_dependent_continuant ⊑ continuant，与 process ⊑ occurrent 不相交）
  const gDom = {
    nodes: [N('p', '过程', 'process'), N('m', '物质', 'material_entity')],
    edges: [{ from: 'bfo:p', to: 'bfo:m', rel: 'inheres_in' }],
  };
  const rDom = validateGraph(gDom, BFO);
  check('domain 越界 → domain-violation', rDom.violations.length === 1 && rDom.violations[0].reason === 'domain-violation' && J(rDom.violations[0].expected) === '["specifically_dependent_continuant"]', J(rDom.violations));
  check('domain 越界同时点名不相交归属（via=domain，cax-dw 只读等价）', rDom.disjointConflicts.length === 1 && rDom.disjointConflicts[0].via === 'domain' && rDom.disjointConflicts[0].declaredType === 'process' && rDom.disjointConflicts[0].forcedType === 'specifically_dependent_continuant', J(rDom.disjointConflicts));
  check('不相交冲突条目带 nodeId/node/rel/pairs/detail', (() => { const c = rDom.disjointConflicts[0]; return c.nodeId === 'bfo:p' && c.node === '过程' && c.rel === 'inheres_in' && Array.isArray(c.pairs) && c.pairs.length > 0 && typeof c.detail === 'string' && c.detail.length > 0; })(), J(rDom.disjointConflicts[0]));
  check('不相交冲突带归属字段（profileId/profileName/domain/scopeLabel，v1.2.2）', (() => { const c = rDom.disjointConflicts[0]; return c.profileId === 'bfo' && String(c.profileName).length > 0 && c.domain === 'general' && c.scopeLabel === '通用（未匹配领域）'; })(), J({ p: rDom.disjointConflicts[0].profileId, d: rDom.disjointConflicts[0].domain, s: rDom.disjointConflicts[0].scopeLabel }));

  // range 越界 + 强制类型不相交（quality —inheres_in→ process：range 强制 independent_continuant ⊑ continuant）
  const gRng = {
    nodes: [N('q', '性质', 'quality'), N('p', '过程', 'process')],
    edges: [{ from: 'bfo:q', to: 'bfo:p', rel: 'inheres_in' }],
  };
  const rRng = validateGraph(gRng, BFO);
  check('range 越界 → range-violation', rRng.violations.length === 1 && rRng.violations[0].reason === 'range-violation' && J(rRng.violations[0].expected) === '["independent_continuant"]', J(rRng.violations));
  check('range 越界同时点名不相交归属（via=range）', rRng.disjointConflicts.length === 1 && rRng.disjointConflicts[0].via === 'range' && rRng.disjointConflicts[0].nodeId === 'bfo:p', J(rRng.disjointConflicts));

  // 同一节点被多条边以相同 (类型,强制类型,via) 命中 → 去重只报一次
  const gDup = {
    nodes: [N('p', '过程', 'process'), N('m1', '物质1', 'material_entity'), N('m2', '物质2', 'material_entity')],
    edges: [
      { from: 'bfo:p', to: 'bfo:m1', rel: 'inheres_in' },
      { from: 'bfo:p', to: 'bfo:m2', rel: 'inheres_in' },
    ],
  };
  const rDup = validateGraph(gDup, BFO);
  check('两条边各自计违规（checked=2 / violations=2）', rDup.checked === 2 && rDup.violations.length === 2, J({ c: rDup.checked, v: rDup.violations.length }));
  check('不相交归属按 nodeId|类型|强制类型|via 去重（只报 1 处）', rDup.disjointConflicts.length === 1, J(rDup.disjointConflicts.length));

  // strictUnknownType 透传
  const gWeird = {
    nodes: [N('a', 'A', 'weird', 'bfo-lite'), N('b', 'B', 'object', 'bfo-lite')],
    edges: [{ from: 'bfo-lite:a', to: 'bfo-lite:b', rel: '包含' }],
  };
  check('默认不把未知类型算违规', validateGraph(gWeird, BL).violations.length === 0);
  const rStrict = validateGraph(gWeird, BL, { strictUnknownType: true });
  check('strictUnknownType=true 透传 guard.checkEdge → unknown-type', rStrict.violations.length === 1 && rStrict.violations[0].reason === 'unknown-type' && rStrict.violations[0].fromType === 'weird', J(rStrict.violations));

  // ======================================================================
  section('§12.2.3 validate.js：推理边 / 孤儿边 / 截断 / 只读性');
  // ======================================================================
  const gInf = {
    nodes: [N('a', 'A', 'object', 'bfo-lite'), N('b', 'B', 'object', 'bfo-lite')],
    edges: [
      { from: 'bfo-lite:a', to: 'bfo-lite:b', rel: '包含' },
      { from: 'bfo-lite:a', to: 'bfo-lite:b', rel: 'notarel', inferred: true, inferredVia: 'transitive' },
    ],
  };
  const rInf = validateGraph(gInf, BL);
  check('默认把推理边纳入校验（checked=2）且违规条目标注 inferred', rInf.checked === 2 && rInf.violations.length === 1 && rInf.violations[0].inferred === true, J({ c: rInf.checked, inf: rInf.violations[0] && rInf.violations[0].inferred }));
  const rNoInf = validateGraph(gInf, BL, { includeInferred: false });
  check('includeInferred=false → 推理边不计入（checked=1 / 零违规）', rNoInf.checked === 1 && rNoInf.violations.length === 0, J({ c: rNoInf.checked, v: rNoInf.violations.length }));

  const gOrphan = {
    nodes: [N('a', 'A', 'object', 'bfo-lite')],
    edges: [
      { from: 'bfo-lite:a', to: 'bfo-lite:ghost', rel: '包含' }, // 终点缺失 → 孤儿边，跳过
      { from: 'bfo-lite:ghost2', to: 'bfo-lite:a', rel: '包含' }, // 起点缺失 → 孤儿边，跳过
      null, // 脏数据 → 跳过
      { from: 'bfo-lite:a', to: 'bfo-lite:a', rel: null }, // 自环 + 空谓词：端点齐全 → 计入并按 unknown-predicate 报
    ],
  };
  const rOrphan = validateGraph(gOrphan, BL);
  check('端点缺失/脏数据边跳过而非误报（checked=1）', rOrphan.ok === true && rOrphan.checked === 1, J({ c: rOrphan.checked, v: rOrphan.violations.length }));
  check('空谓词自环按 unknown-predicate 报（rel 归一为空串，与 guard.checkEdge 口径一致）', rOrphan.violations.length === 1 && rOrphan.violations[0].reason === 'unknown-predicate' && rOrphan.violations[0].rel === '', J(rOrphan.violations));

  // 截断：51 条越界边 → violations 封顶 50、truncated=true，但 checked/byReason 仍为全量
  const bigNodes = []; const bigEdges = [];
  for (let i = 0; i < 51; i++) {
    bigNodes.push(N('x' + i, 'X' + i, 'object', 'bfo-lite'));
    bigEdges.push({ from: 'bfo-lite:x' + i, to: 'bfo-lite:x0', rel: 'bad' + (i % 3) });
  }
  const rBig = validateGraph({ nodes: bigNodes, edges: bigEdges }, BL);
  check('violations 封顶 VIOLATION_CAP=50 且 truncated=true', rBig.violations.length === VIOLATION_CAP && rBig.truncated === true, J({ v: rBig.violations.length, t: rBig.truncated }));
  check('带 domain 的端点 → scope 取端点 domain 且 scopeLabel 回退为 domain 原值', (() => {
    const gScoped = {
      nodes: [Object.assign(N('a', 'A', 'object', 'bfo-lite'), { domain: 'charge-pile' }), N('b', 'B', 'object', 'bfo-lite')],
      edges: [{ from: 'bfo-lite:a', to: 'bfo-lite:b', rel: 'badrel' }],
    };
    const rr = validateGraph(gScoped, BL);
    return rr.violations.length === 1 && rr.violations[0].domain === 'charge-pile' && rr.violations[0].scopeLabel === 'charge-pile';
  })(), 'scope 归属');
  check('checked 与 byReason 计数不受截断影响（全量 51）', rBig.checked === 51 && rBig.byReason['unknown-predicate'] === 51, J({ c: rBig.checked, br: rBig.byReason }));
  check('totalViolations 为全量 51（UI 计数口径，v1.2.2）', rBig.totalViolations === 51 && rBig.totalDisjointConflicts === 0, J({ tv: rBig.totalViolations, td: rBig.totalDisjointConflicts }));
  check('byRel 全量分桶（bad0/bad1/bad2 = 17/17/17）', J(rBig.byRel) === '{"bad0":17,"bad1":17,"bad2":17}', J(rBig.byRel));

  // 只读性：入参图谱对象逐字节不变
  const before = J(gInf);
  validateGraph(gInf, BL);
  validateGraph(gInf, BL, { includeInferred: false, strictUnknownType: true });
  check('校验不修改入参图谱（JSON 逐字节一致）', J(gInf) === before);

  // ======================================================================
  section('§12.2.3 graph.validateGraph：包装层（体系解析 + 落库图 + 只读）');
  // ======================================================================
  check('graph.validateGraph 已导出', typeof graph.validateGraph === 'function');
  graph.clearGraph();
  const wEmpty = graph.validateGraph('bfo-lite');
  check('空图 → ok:true / checked=0 / 13 字段', wEmpty.ok === true && wEmpty.checked === 0 && J(Object.keys(wEmpty)) === '["ok","profileId","profileName","checked","violations","byReason","byRel","disjointConflicts","coverage","truncated","at","totalViolations","totalDisjointConflicts"]', J(Object.keys(wEmpty)));

  // 缺省 profileId → 当前绑定体系（新沙箱默认 bfo-lite）
  const wDef = graph.validateGraph();
  check('缺省 profileId 取当前绑定体系（bfo-lite）', wDef.ok === true && wDef.profileId === 'bfo-lite', J(wDef.profileId));
  // 不存在的 owl:* 体系 → resolveOntology 回退 bfo-lite（不抛）
  const wOwl = graph.validateGraph('owl:nope');
  check('未知 owl:* 体系回退 bfo-lite（不抛）', wOwl.ok === true && wOwl.profileId === 'bfo-lite', J({ ok: wOwl.ok, id: wOwl.profileId }));

  // 落库图校验：存一条 bfo 越界边，validateGraph('bfo') 能点名
  graph.saveGraph(
    [N('p', '过程', 'process'), N('m', '物质', 'material_entity')],
    [{ from: 'bfo:p', to: 'bfo:m', rel: 'inheres_in' }],
  );
  const metaBefore = J(graph.getGraphMeta());
  const graphBefore = J(graph.getGraph());
  const wBfo = graph.validateGraph('bfo');
  check('落库图按指定体系校验 → domain-violation + 不相交归属各 1', wBfo.ok === true && wBfo.profileId === 'bfo' && wBfo.checked === 1 && wBfo.violations.length === 1 && wBfo.violations[0].reason === 'domain-violation' && wBfo.disjointConflicts.length === 1, J({ v: wBfo.violations.length, d: wBfo.disjointConflicts.length }));
  check('校验后图谱逐字节不变（只读，不改 rel / 不删边）', J(graph.getGraph()) === graphBefore);
  check('校验后 graphMeta 不变（不写 inferredStale / lastGuard）', J(graph.getGraphMeta()) === metaBefore, J(graph.getGraphMeta()));
  check('opts 透传（includeInferred=false 时原始边仍计入）', graph.validateGraph('bfo', { includeInferred: false }).checked === 1);

  // ======================================================================
  section('§12.2.3 IPC：graph:validate 通道（双调用形态）');
  // ======================================================================
  const { registerIpc } = require('../src/main/ipc');
  registerIpc(() => ({ isDestroyed: () => false, webContents: { send: () => {} } }));
  check('graph:validate 通道已注册', env.el.handlers.has('graph:validate'));
  const i1 = await env.el.invoke('graph:validate', 'bfo');
  check('双参形态 invoke → ok:true + 13 字段', i1.ok === true && i1.profileId === 'bfo' && J(Object.keys(i1)) === '["ok","profileId","profileName","checked","violations","byReason","byRel","disjointConflicts","coverage","truncated","at","totalViolations","totalDisjointConflicts"]', J(Object.keys(i1)));
  const i2 = await env.el.invoke('graph:validate', { profileId: 'bfo', opts: {} });
  check('web-shim 单 body 形态 → 同样命中（checked=1 / violations=1）', i2.ok === true && i2.checked === 1 && i2.violations.length === 1, J({ ok: i2.ok, c: i2.checked, v: i2.violations.length }));
  const i3 = await env.el.invoke('graph:validate');
  check('无参 invoke → 缺省当前绑定体系（不抛）', i3.ok === true && i3.profileId === 'bfo-lite', J({ ok: i3.ok, id: i3.profileId }));

  summary();
})().catch((err) => { console.error('测试执行异常：', err); process.exitCode = 1; });
