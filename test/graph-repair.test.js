'use strict';
// 冲突自动修复测试（方案1/2/3）：
//   reason/repair.js 纯函数规划器（keyOf/conflictRelKeys/findInducingEdges/isUnconstrained/lca/planOne/planRepairs/applyActions）
//   + graph.js 修复三接口（planRepairs/applyRepairs/undoRepair/repairUndoAvailable）
//   + IPC 三通道（graph:planRepairs / graph:applyRepairs / graph:undoRepair，含 web-shim 单 body 形态）
//   + 方案1 写侧互斥护栏（extractGraph 的 disjoint-type-forcing 降级）
//   + 方案3 LLM 语义仲裁（settings.graphRepairLlm 开关 + getReasonState.repairLlm）
//
// 设计约束（与实现一致）：
//   · 最小破坏：能降级谓词就不删边，能删一条边就不改节点类型。
//   · 不臆造约束：体系没声明 domain/range/disjoint 时不产生动作。
//   · 一步撤销：applyRepairs 前把整图 nodes/edges 快照进 kv（graph.repairUndo），undoRepair 恢复。
//   · 修复后重推理：applyActions 丢弃全部推理边，applyRepairs 落库后重跑物化（§5.4）。
//
// ⚠️ 性能红线同其他推理测试：所有图谱 ≤ 6 节点。
const path = require('path');
const { bootEnv, mkCheck, startFakeLlm, sseText } = require('./helpers/harness');

const { check, section, summary } = mkCheck('冲突自动修复（reason/repair.js + graph.js 修复三接口 + IPC）');
const J = (v) => JSON.stringify(v);
const json = (obj) => ({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, sse: sseText(JSON.stringify(obj)) });
const text = (s) => ({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, sse: sseText(s) });

// ---------- 夹具 ----------
const N = (key, name, type, profile = 'bfo') => ({
  id: `${profile}:${key}`, name: name || key, type, desc: '', sources: [], domain: '', profile,
});
const edgeTag = (e) => `${e.from}->${e.to}|${e.rel}|inf=${!!e.inferred}`;

(async () => {
  const env = await bootEnv({ prefix: 'synapse-repair-' });
  const repair = require('../src/main/graph/reason/repair');
  const bridge = require('../src/main/graph/reason/bridge');
  const graph = require('../src/main/graph/graph');
  const settingsMod = require('../src/main/common/settings');
  const db = require('../src/main/common/db');
  const { ONTOLOGY_PROFILES, ONTOLOGY_KEY } = require('../src/main/common/constants');
  const BL = ONTOLOGY_PROFILES['bfo-lite'];
  const BFO = ONTOLOGY_PROFILES['bfo'];

  // ======================================================================
  section('repair.js 单元：keyOf / conflictRelKeys / isUnconstrained / findInducingEdges / lca');
  // ======================================================================
  check('模块导出恰好 10 个符号（v1.2.2 增 planOneIssue/planIssues）', J(Object.keys(repair).sort()) === '["applyActions","conflictRelKeys","findInducingEdges","isUnconstrained","keyOf","lca","planIssues","planOne","planOneIssue","planRepairs"]', J(Object.keys(repair).sort()));
  check('keyOf = from|to|rel', repair.keyOf('a', 'b', '相关') === 'a|b|相关');

  // conflictRelKeys：从 raw 的谓词 IRI 反解 key（bridge.conflictNodeIds 只提节点，这里补提谓词）
  const rawRel = `${bridge.iriId('bfo:p')} ${bridge.iriRel('inheres_in')} ${bridge.iriId('bfo:m')} and reverse`;
  check('conflictRelKeys 提取英文谓词 key', J(repair.conflictRelKeys({ raw: rawRel })) === '["inheres_in"]', J(repair.conflictRelKeys({ raw: rawRel })));
  const rawZh = `${bridge.iriId('bfo-lite:a')} ${bridge.iriRel('矛盾于')} ${bridge.iriId('bfo-lite:b')}`;
  check('conflictRelKeys 提取中文谓词 key（URL 编码往返）', J(repair.conflictRelKeys({ raw: rawZh })) === '["矛盾于"]', J(repair.conflictRelKeys({ raw: rawZh })));
  check('conflictRelKeys 无谓词 IRI → 空数组', J(repair.conflictRelKeys({ raw: 'no iri here' })) === '[]');
  check('conflictRelKeys 空 raw → 空数组', J(repair.conflictRelKeys({})) === '[]');
  check('conflictRelKeys 去重（同一谓词出现两次）', J(repair.conflictRelKeys({ raw: `${bridge.iriRel('包含')} x ${bridge.iriRel('包含')}` })) === '["包含"]');

  // isUnconstrained：bfo related_to 无 domain/range（可安全降级），inheres_in 有约束
  check('isUnconstrained(bfo, related_to)=true（兜底谓词无约束）', repair.isUnconstrained(BFO, 'related_to') === true);
  check('isUnconstrained(bfo, inheres_in)=false（带 domain/range）', repair.isUnconstrained(BFO, 'inheres_in') === false);
  check('isUnconstrained(bfo-lite, 相关)=true（bfo-lite 全无约束）', repair.isUnconstrained(BL, '相关') === true);
  check('isUnconstrained 空谓词 → false', repair.isUnconstrained(BFO, '') === false);

  // findInducingEdges：process —inheres_in→ material_entity，domain 强制 specifically_dependent_continuant ⊑ continuant，与 process ⊑ occurrent 互斥
  const pNode = N('p', '过程', 'process');
  const inducing = repair.findInducingEdges(pNode, [{ from: 'bfo:p', to: 'bfo:m', rel: 'inheres_in' }], BFO);
  check('findInducingEdges 命中 1 条诱导边', inducing.length === 1, J(inducing.length));
  check('诱导边 via=domain / forcedType=specifically_dependent_continuant', inducing[0] && inducing[0].via === 'domain' && inducing[0].forcedType === 'specifically_dependent_continuant', J(inducing[0] && { via: inducing[0].via, f: inducing[0].forcedType }));
  check('findInducingEdges 无 type 的节点 → 空', J(repair.findInducingEdges({ id: 'x' }, [{ from: 'x', to: 'y', rel: 'inheres_in' }], BFO)) === '[]');
  check('findInducingEdges 无关边 → 空', J(repair.findInducingEdges(pNode, [{ from: 'bfo:z', to: 'bfo:w', rel: 'inheres_in' }], BFO)) === '[]');
  // range 侧探针：m 作为边的**终点**时只查 range（=independent_continuant），
  // material_entity ⊑ independent_continuant 与 range 一致 → 不命中。
  // （注意：m 作为起点时查的是 domain=specifically_dependent_continuant，那会命中——见上一条。）
  const mNode = N('m', '物质', 'material_entity');
  const inducingR = repair.findInducingEdges(mNode, [{ from: 'bfo:p', to: 'bfo:m', rel: 'inheres_in' }], BFO);
  check('findInducingEdges range 侧不命中（material_entity ⊑ independent_continuant 与 range 一致）', inducingR.length === 0, J(inducingR.length));

  // 逆谓词物化（真实事故回归）：bearer_of 自身无 domain/range，但其逆 inheres_in 的
  // domain=specifically_dependent_continuant。推理按 prp-inv 物化出 (to, inheres_in, from)，
  // 于是 (mitochondrion —bearer_of→ atp_synthase) 会把 atp_synthase（声明 object）
  // 强制归入特依存持续体 → cax-dw。旧版只看直连约束，误判「没有边在强制它 → 需人工」。
  const atpNode = N('atp', 'ATP合成酶', 'object');
  const mitoNode = N('mito', '线粒体', 'material_entity');
  const invEdge = [{ from: 'bfo:mito', to: 'bfo:atp', rel: 'bearer_of' }];
  const inducingInv = repair.findInducingEdges(atpNode, invEdge, BFO);
  check('findInducingEdges 命中逆谓词诱导边（bearer_of ⇐ inheres_in domain）', inducingInv.length === 1, J(inducingInv.map((x) => ({ via: x.via, f: x.forcedType, inv: x.inverseRel }))));
  check('逆谓词诱导边 via=domain / forcedType=specifically_dependent_continuant / inverseRel=inheres_in', inducingInv[0] && inducingInv[0].via === 'domain' && inducingInv[0].forcedType === 'specifically_dependent_continuant' && inducingInv[0].inverseRel === 'inheres_in', J(inducingInv[0] && { via: inducingInv[0].via, f: inducingInv[0].forcedType, inv: inducingInv[0].inverseRel }));
  check('逆谓词诱导边不命中起点（mito 声明 material_entity 与 range=independent_continuant 相容）', repair.findInducingEdges(mitoNode, invEdge, BFO).length === 0, J(repair.findInducingEdges(mitoNode, invEdge, BFO).length));
  const invActs = await repair.planOne({ rule: 'cax-dw', nodeIds: ['bfo:atp'], raw: `${bridge.iriId('bfo:atp')} in disjoint ${bridge.iriType('independent_continuant')} & ${bridge.iriType('specifically_dependent_continuant')}` }, { nodes: [atpNode, mitoNode], edges: invEdge }, BFO, {});
  check('逆谓词诱导的 cax-dw → change-rel（不再误判 manual）', invActs.length === 1 && invActs[0].kind === 'change-rel' && invActs[0].newRel === 'related_to', J(invActs.map((a) => ({ k: a.kind, nr: a.newRel }))));
  check('逆谓词动作中文说明点明逆谓词来源', invActs[0] && invActs[0].actionZh.includes('inheres_in') && invActs[0].actionZh.includes('逆'), J(invActs[0] && invActs[0].actionZh));
  // guard.forcingProbes 口径自检：直连 + 逆边共 4 个探针位（bearer_of 直连无约束 → 仅逆边 2 个）
  const guardMod = require('../src/main/graph/reason/guard');
  const fp = guardMod.forcingProbes(BFO, 'bearer_of');
  check('forcingProbes(bearer_of) = 逆边 2 探针（to/domain + from/range）', J(fp.map((p) => `${p.node}/${p.via}/${p.rel}`)) === '["to/domain/inheres_in","from/range/inheres_in"]', J(fp.map((p) => `${p.node}/${p.via}/${p.rel}`)));
  const fp2 = guardMod.forcingProbes(BFO, 'inheres_in');
  check('forcingProbes(inheres_in) = 直连 2 探针（逆 bearer_of 无约束不贡献）', J(fp2.map((p) => `${p.node}/${p.via}/${p.rel}/inv=${p.inverse}`)) === '["from/domain/inheres_in/inv=false","to/range/inheres_in/inv=false"]', J(fp2.map((p) => `${p.node}/${p.via}/${p.rel}/inv=${p.inverse}`)));

  // lca：最近公共祖先（沿 classes[].parent + SubClassOf 公理）
  check('lca(bfo-lite object, quality)=continuant', repair.lca(BL, 'object', 'quality') === 'continuant', J(repair.lca(BL, 'object', 'quality')));
  check('lca(bfo-lite role, function)=realizable', repair.lca(BL, 'role', 'function') === 'realizable', J(repair.lca(BL, 'role', 'function')));
  check('lca(bfo-lite object, process)=thing', repair.lca(BL, 'object', 'process') === 'thing', J(repair.lca(BL, 'object', 'process')));
  check('lca 同类型返回自身', repair.lca(BL, 'object', 'object') === 'object');
  check('lca 空入参 → 空串', repair.lca(BL, '', 'object') === '');

  // ======================================================================
  section('planOne：A 类（cax-dw）→ 降级谓词 / 删边 / 人工');
  // ======================================================================
  // A 类首选：bfo 兜底谓词 related_to 无约束 → change-rel（保住联系，与抽取护栏同口径）
  const gA = { nodes: [N('p', '过程', 'process'), N('m', '物质', 'material_entity')], edges: [{ from: 'bfo:p', to: 'bfo:m', rel: 'inheres_in' }] };
  const caxDw = { rule: 'cax-dw', nodeIds: ['bfo:p'], raw: `${bridge.iriId('bfo:p')} in disjoint ${bridge.iriType('continuant')} & ${bridge.iriType('occurrent')}` };
  const aActs = await repair.planOne(caxDw, gA, BFO, {});
  check('cax-dw → 1 个 change-rel 动作', aActs.length === 1 && aActs[0].kind === 'change-rel', J(aActs.map((a) => a.kind)));
  check('change-rel 降级到 related_to / auto=true / viaLlm=false', aActs[0].newRel === 'related_to' && aActs[0].auto === true && aActs[0].viaLlm === false, J({ nr: aActs[0].newRel, auto: aActs[0].auto, llm: aActs[0].viaLlm }));
  check('change-rel 带 edgeKey/from/to/rel/nodeId/forcedType/via', aActs[0].edgeKey === 'bfo:p|bfo:m|inheres_in' && aActs[0].from === 'bfo:p' && aActs[0].to === 'bfo:m' && aActs[0].rel === 'inheres_in' && aActs[0].nodeId === 'bfo:p' && aActs[0].forcedType === 'specifically_dependent_continuant' && aActs[0].via === 'domain', J(aActs[0]));
  check('change-rel 带中文说明 + 备选（或删除这条边）', typeof aActs[0].actionZh === 'string' && aActs[0].actionZh.includes('降级') && aActs[0].altActionZh === '或删除这条边', J({ zh: aActs[0].actionZh, alt: aActs[0].altActionZh }));
  check('change-rel 带 declaredType=process', aActs[0].declaredType === 'process', J(aActs[0].declaredType));

  // A 类人工：节点类型本身落互斥类，但没有边在强制 → 改数据无法修复
  const aManual = await repair.planOne({ rule: 'cax-dw', nodeIds: ['bfo-lite:a'], raw: 'x' }, { nodes: [N('a', '甲', 'object', 'bfo-lite')], edges: [] }, BL, {});
  check('cax-dw 无诱导边 → manual（auto=false）', aManual.length === 1 && aManual[0].kind === 'manual' && aManual[0].auto === false, J(aManual.map((a) => ({ k: a.kind, auto: a.auto }))));
  check('manual 动作带中文说明（需人工改类型或放宽本体）', aManual[0].actionZh.includes('人工'), J(aManual[0].actionZh));

  // A 类删边：体系兜底谓词也带约束时（构造一个 fallbackRel 有 domain 的体系）→ 只能删边
  const constrainedFb = JSON.parse(J(BFO));
  constrainedFb.fallbackRel = 'inheres_in'; // 兜底谓词本身带约束
  const aDel = await repair.planOne(caxDw, gA, constrainedFb, {});
  check('兜底谓词带约束 → delete-edge（无可降级目标）', aDel.length === 1 && aDel[0].kind === 'delete-edge', J(aDel.map((a) => a.kind)));
  check('delete-edge 带 edgeKey + 中文说明', aDel[0].edgeKey === 'bfo:p|bfo:m|inheres_in' && aDel[0].actionZh.includes('删除'), J({ ek: aDel[0].edgeKey, zh: aDel[0].actionZh }));

  // ======================================================================
  section('planOne：B 类（prp-asyp / prp-irp / prp-pdw / prp-npa1 / cls-maxc1）');
  // ======================================================================
  // prp-asyp：非对称谓词双向断言 → 删反向保正向
  const gAsym = { nodes: [N('a', '甲', 'object', 'bfo-lite'), N('b', '乙', 'object', 'bfo-lite')], edges: [{ from: 'bfo-lite:a', to: 'bfo-lite:b', rel: '矛盾于' }, { from: 'bfo-lite:b', to: 'bfo-lite:a', rel: '矛盾于' }] };
  const asypActs = await repair.planOne({ rule: 'prp-asyp', nodeIds: ['bfo-lite:a', 'bfo-lite:b'], raw: rawZh }, gAsym, BL, {});
  check('prp-asyp → 1 个 delete-edge（删反向）', asypActs.length === 1 && asypActs[0].kind === 'delete-edge', J(asypActs.map((a) => a.kind)));
  check('prp-asyp 删除的是反向边 b→a', asypActs[0].edgeKey === 'bfo-lite:b|bfo-lite:a|矛盾于', J(asypActs[0].edgeKey));
  check('prp-asyp 中文说明含「非对称」', asypActs[0].actionZh.includes('非对称'), J(asypActs[0].actionZh));
  const asypNoFwd = await repair.planOne({ rule: 'prp-asyp', nodeIds: ['bfo-lite:a', 'bfo-lite:b'], raw: rawZh }, { nodes: gAsym.nodes, edges: [gAsym.edges[0]] }, BL, {});
  check('prp-asyp 只有单向边 → manual（无法定位反向）', asypNoFwd.length === 1 && asypNoFwd[0].kind === 'manual', J(asypNoFwd.map((a) => a.kind)));
  const asypNoIds = await repair.planOne({ rule: 'prp-asyp', nodeIds: [], raw: '' }, gAsym, BL, {});
  check('prp-asyp 未解析出端点 → manual', asypNoIds.length === 1 && asypNoIds[0].kind === 'manual', J(asypNoIds.map((a) => a.kind)));

  // prp-irp：反自反谓词自环 → 删自环
  const gIrp = { nodes: [N('a', '甲', 'object', 'bfo-lite')], edges: [{ from: 'bfo-lite:a', to: 'bfo-lite:a', rel: '矛盾于' }] };
  const irpActs = await repair.planOne({ rule: 'prp-irp', nodeIds: ['bfo-lite:a'], raw: `${bridge.iriId('bfo-lite:a')} ${bridge.iriRel('矛盾于')} itself` }, gIrp, BL, {});
  check('prp-irp → delete-edge（自环）', irpActs.length === 1 && irpActs[0].kind === 'delete-edge' && irpActs[0].edgeKey === 'bfo-lite:a|bfo-lite:a|矛盾于', J(irpActs.map((a) => ({ k: a.kind, ek: a.edgeKey }))));
  check('prp-irp 中文说明含「自环」「反自反」', irpActs[0].actionZh.includes('自环') && irpActs[0].actionZh.includes('反自反'), J(irpActs[0].actionZh));
  const irpNone = await repair.planOne({ rule: 'prp-irp', nodeIds: ['bfo-lite:a'], raw: 'x' }, { nodes: gIrp.nodes, edges: [] }, BL, {});
  check('prp-irp 无自环边 → manual', irpNone.length === 1 && irpNone[0].kind === 'manual', J(irpNone.map((a) => a.kind)));

  // prp-pdw：互斥谓词连同一对个体 → 保第一条删其余
  const gPdw = { nodes: [N('a', '甲', 'object', 'bfo-lite'), N('b', '乙', 'object', 'bfo-lite')], edges: [{ from: 'bfo-lite:a', to: 'bfo-lite:b', rel: '包含' }, { from: 'bfo-lite:a', to: 'bfo-lite:b', rel: '依赖' }] };
  const pdwActs = await repair.planOne({ rule: 'prp-pdw', nodeIds: ['bfo-lite:a', 'bfo-lite:b'], raw: '' }, gPdw, BL, {});
  check('prp-pdw → 1 个 delete-edge（删第二条）', pdwActs.length === 1 && pdwActs[0].kind === 'delete-edge' && pdwActs[0].edgeKey === 'bfo-lite:a|bfo-lite:b|依赖', J(pdwActs.map((a) => ({ k: a.kind, ek: a.edgeKey }))));
  const pdwFew = await repair.planOne({ rule: 'prp-pdw', nodeIds: ['bfo-lite:a', 'bfo-lite:b'], raw: '' }, { nodes: gPdw.nodes, edges: [gPdw.edges[0]] }, BL, {});
  check('prp-pdw 不足 2 条边 → manual', pdwFew.length === 1 && pdwFew[0].kind === 'manual', J(pdwFew.map((a) => a.kind)));

  // prp-npa1：负断言 → 删被禁止的边
  const npaActs = await repair.planOne({ rule: 'prp-npa1', nodeIds: ['bfo-lite:a', 'bfo-lite:b'], raw: '' }, gPdw, BL, {});
  check('prp-npa1 → delete-edge（命中 2 条都删）', npaActs.length === 2 && npaActs.every((a) => a.kind === 'delete-edge'), J(npaActs.map((a) => a.kind)));
  const npaNone = await repair.planOne({ rule: 'prp-npa1', nodeIds: ['bfo-lite:a', 'bfo-lite:b'], raw: '' }, { nodes: gPdw.nodes, edges: [] }, BL, {});
  check('prp-npa1 无边 → manual', npaNone.length === 1 && npaNone[0].kind === 'manual', J(npaNone.map((a) => a.kind)));

  // cls-maxc1：最大基数 0 → 删该节点出边
  const maxActs = await repair.planOne({ rule: 'cls-maxc1', nodeIds: ['bfo-lite:a'], raw: '' }, gPdw, BL, {});
  check('cls-maxc1 → 2 个 delete-edge（删 a 的全部出边）', maxActs.length === 2 && maxActs.every((a) => a.kind === 'delete-edge'), J(maxActs.map((a) => a.kind)));
  const maxNone = await repair.planOne({ rule: 'cls-maxc1', nodeIds: ['bfo-lite:a'], raw: '' }, { nodes: gPdw.nodes, edges: [] }, BL, {});
  check('cls-maxc1 无出边 → manual', maxNone.length === 1 && maxNone[0].kind === 'manual', J(maxNone.map((a) => a.kind)));

  // ======================================================================
  section('planOne：C 类（prp-npa2 / dt-not-type / eq-diff*）与未知规则 → 一律 manual');
  // ======================================================================
  for (const rule of ['prp-npa2', 'dt-not-type', 'eq-diff1', 'eq-diff2', 'eq-diff3']) {
    const acts = await repair.planOne({ rule, nodeIds: ['bfo-lite:a', 'bfo-lite:b'], raw: 'x' }, gPdw, BL, {});
    check(`${rule} → manual（auto=false，无安全自动修法）`, acts.length === 1 && acts[0].kind === 'manual' && acts[0].auto === false, J(acts.map((a) => ({ k: a.kind, auto: a.auto }))));
  }
  const defActs = await repair.planOne({ rule: 'scm-sco', nodeIds: [], raw: 'x' }, gPdw, BL, {});
  check('未知规则 → manual（中文说明含规则名）', defActs.length === 1 && defActs[0].kind === 'manual' && defActs[0].actionZh.includes('scm-sco'), J(defActs.map((a) => ({ k: a.kind, zh: a.actionZh }))));

  // ======================================================================
  section('planOne：方案3 LLM 语义仲裁（opts.arbitrate）');
  // ======================================================================
  // 仲裁返回 forced 候选 → change-rel 转 retype-node（viaLlm=true，保住边）
  const arbPick = await repair.planOne(caxDw, gA, BFO, { arbitrate: async () => 'specifically_dependent_continuant' });
  check('仲裁选中 forced 类 → retype-node', arbPick.length === 1 && arbPick[0].kind === 'retype-node', J(arbPick.map((a) => a.kind)));
  check('retype-node viaLlm=true / newType=specifically_dependent_continuant', arbPick[0].viaLlm === true && arbPick[0].newType === 'specifically_dependent_continuant', J({ llm: arbPick[0].viaLlm, nt: arbPick[0].newType }));
  check('retype-node 去掉 edgeKey/newRel（不再动边）', arbPick[0].edgeKey === undefined && arbPick[0].newRel === undefined, J({ ek: arbPick[0].edgeKey, nr: arbPick[0].newRel }));
  check('retype-node 中文说明含「LLM 语义仲裁」', arbPick[0].actionZh.includes('LLM'), J(arbPick[0].actionZh));
  // 仲裁返回声明类型（非候选）→ 保持 change-rel
  const arbKeep = await repair.planOne(caxDw, gA, BFO, { arbitrate: async () => 'process' });
  check('仲裁返回声明类型 → 保持 change-rel', arbKeep.length === 1 && arbKeep[0].kind === 'change-rel', J(arbKeep.map((a) => a.kind)));
  // 仲裁返回垃圾 → 保持 change-rel
  const arbJunk = await repair.planOne(caxDw, gA, BFO, { arbitrate: async () => '随便说点什么' });
  check('仲裁返回非候选 → 保持 change-rel', arbJunk.length === 1 && arbJunk[0].kind === 'change-rel', J(arbJunk.map((a) => a.kind)));
  // 仲裁抛错 → 静默退回 change-rel
  const arbThrow = await repair.planOne(caxDw, gA, BFO, { arbitrate: async () => { throw new Error('boom'); } });
  check('仲裁抛错 → 静默退回 change-rel', arbThrow.length === 1 && arbThrow[0].kind === 'change-rel', J(arbThrow.map((a) => a.kind)));
  // 仲裁回调收到完整问题上下文
  let arbQ = null;
  await repair.planOne(caxDw, gA, BFO, { arbitrate: async (q) => { arbQ = q; return 'process'; } });
  check('仲裁回调收到 nodeName/nodeType/candidates/rule', arbQ && arbQ.nodeName === '过程' && arbQ.nodeType === 'process' && J(arbQ.candidates) === '["specifically_dependent_continuant"]' && arbQ.rule === 'cax-dw', J(arbQ));
  // 无 change-rel（纯 manual）时不触发仲裁
  let arbCalled = false;
  await repair.planOne({ rule: 'eq-diff1', nodeIds: ['a', 'b'], raw: 'x' }, gPdw, BL, { arbitrate: async () => { arbCalled = true; return 'x'; } });
  check('C 类冲突不触发仲裁（无多解）', arbCalled === false);

  // ======================================================================
  section('planRepairs：批量规划 + 体系解析 + 去重 + 计数');
  // ======================================================================
  const resolveBfo = (pid) => (pid === 'bfo' ? BFO : pid === 'bfo-lite' ? BL : null);
  const planBatch = await repair.planRepairs(
    [{ ...caxDw, profileId: 'bfo' }, { rule: 'eq-diff1', profileId: 'bfo', nodeIds: ['bfo:p'], raw: 'x' }],
    gA, resolveBfo, {}
  );
  check('planRepairs 返回 5 字段', J(Object.keys(planBatch).sort()) === '["actions","autoCount","byKind","conflictCount","manualCount"]', J(Object.keys(planBatch)));
  check('planRepairs conflictCount=2', planBatch.conflictCount === 2, J(planBatch.conflictCount));
  check('planRepairs autoCount=1 / manualCount=1', planBatch.autoCount === 1 && planBatch.manualCount === 1, J({ a: planBatch.autoCount, m: planBatch.manualCount }));
  check('planRepairs byKind 计数', J(planBatch.byKind) === '{"change-rel":1,"manual":1}', J(planBatch.byKind));
  check('每个动作带 conflictIdx', planBatch.actions.every((a) => typeof a.conflictIdx === 'number'), J(planBatch.actions.map((a) => a.conflictIdx)));

  // 体系无法解析 → manual
  const planBadProfile = await repair.planRepairs([{ ...caxDw, profileId: 'owl:nope' }], gA, resolveBfo, {});
  check('体系无法解析 → manual（中文说明含体系名）', planBadProfile.actions.length === 1 && planBadProfile.actions[0].kind === 'manual' && planBadProfile.actions[0].actionZh.includes('owl:nope'), J(planBadProfile.actions.map((a) => ({ k: a.kind, zh: a.actionZh }))));

  // 去重：两条相同 cax-dw 冲突 → 只保留 1 个 change-rel
  const planDedup = await repair.planRepairs([{ ...caxDw, profileId: 'bfo' }, { ...caxDw, profileId: 'bfo' }], gA, resolveBfo, {});
  check('相同冲突去重（2 条 → 1 个动作）', planDedup.actions.length === 1 && planDedup.conflictCount === 2, J({ n: planDedup.actions.length, cc: planDedup.conflictCount }));

  // prp-asyp 双向冲突去重：(a,b) 与 (b,a) 两条冲突 → 只删 1 条反向边（否则会把正反都删光）
  const asypConflicts = [
    { rule: 'prp-asyp', profileId: 'bfo-lite', nodeIds: ['bfo-lite:a', 'bfo-lite:b'], raw: rawZh },
    { rule: 'prp-asyp', profileId: 'bfo-lite', nodeIds: ['bfo-lite:b', 'bfo-lite:a'], raw: `${bridge.iriId('bfo-lite:b')} ${bridge.iriRel('矛盾于')} ${bridge.iriId('bfo-lite:a')} and reverse` },
  ];
  const planAsym = await repair.planRepairs(asypConflicts, gAsym, resolveBfo, {});
  check('prp-asyp 双向冲突去重 → 只 1 个 delete-edge', planAsym.actions.length === 1 && planAsym.actions[0].kind === 'delete-edge', J(planAsym.actions.map((a) => ({ k: a.kind, ek: a.edgeKey }))));

  // 空冲突列表
  const planEmpty = await repair.planRepairs([], gA, resolveBfo, {});
  check('空冲突 → actions=[] / conflictCount=0', planEmpty.actions.length === 0 && planEmpty.conflictCount === 0, J({ n: planEmpty.actions.length, cc: planEmpty.conflictCount }));

  // ======================================================================
  section('applyActions：纯函数 + 推理边丢弃 + 各动作类型 + 跳过原因');
  // ======================================================================
  const gApply = {
    nodes: [N('a', '甲', 'object', 'bfo-lite'), N('b', '乙', 'object', 'bfo-lite')],
    edges: [
      { from: 'bfo-lite:a', to: 'bfo-lite:b', rel: '包含' },
      { from: 'bfo-lite:a', to: 'bfo-lite:b', rel: '相关', inferred: true, inferredVia: 'symmetric' },
    ],
  };
  const gSnapshot = J(gApply);
  const rDel = repair.applyActions(gApply, [{ kind: 'delete-edge', edgeKey: 'bfo-lite:a|bfo-lite:b|包含', auto: true, actionZh: '删' }]);
  check('applyActions 返回 4 字段', J(Object.keys(rDel).sort()) === '["applied","edges","nodes","skipped"]', J(Object.keys(rDel)));
  check('delete-edge：原始边被删', rDel.edges.length === 0 && rDel.applied.length === 1, J({ e: rDel.edges.length, a: rDel.applied.length }));
  check('applyActions 丢弃全部推理边（修复后必须重算）', rDel.edges.every((e) => !e.inferred), J(rDel.edges.map((e) => !!e.inferred)));
  check('applyActions 纯函数：入参图未被改动', J(gApply) === gSnapshot, '入参被污染');

  // change-rel
  const rChange = repair.applyActions(gApply, [{ kind: 'change-rel', edgeKey: 'bfo-lite:a|bfo-lite:b|包含', newRel: '依赖', auto: true, actionZh: '降级' }]);
  check('change-rel：谓词被改写', rChange.edges.length === 1 && rChange.edges[0].rel === '依赖' && rChange.applied.length === 1, J(rChange.edges.map((e) => e.rel)));
  // change-rel 撞键（降级目标已存在**原始边**）→ 等价删边。
  // 注意 applyActions 先丢弃推理边再建索引，所以撞键必须用两条原始边来构造。
  const gCollide = {
    nodes: gApply.nodes,
    edges: [
      { from: 'bfo-lite:a', to: 'bfo-lite:b', rel: '包含' },
      { from: 'bfo-lite:a', to: 'bfo-lite:b', rel: '相关' },
    ],
  };
  const rCollide = repair.applyActions(gCollide, [{ kind: 'change-rel', edgeKey: 'bfo-lite:a|bfo-lite:b|包含', newRel: '相关', auto: true, actionZh: '降级' }]);
  check('change-rel 撞已有原始边键 → 等价删除该边', rCollide.edges.length === 1 && rCollide.edges[0].rel === '相关' && rCollide.applied.length === 1, J({ e: rCollide.edges.map((e) => e.rel), a: rCollide.applied.length }));
  // retype-node
  const rRetype = repair.applyActions(gApply, [{ kind: 'retype-node', nodeId: 'bfo-lite:a', newType: 'quality', auto: true, actionZh: '改类型' }]);
  check('retype-node：节点类型被改', rRetype.nodes.find((n) => n.id === 'bfo-lite:a').type === 'quality' && rRetype.applied.length === 1, J(rRetype.nodes.find((n) => n.id === 'bfo-lite:a').type));
  // manual 跳过
  const rManual = repair.applyActions(gApply, [{ kind: 'manual', auto: false, actionZh: '需人工' }]);
  check('manual 动作被跳过（reason=需人工处理）', rManual.applied.length === 0 && rManual.skipped.length === 1 && rManual.skipped[0].reason === '需人工处理', J(rManual.skipped));
  // 边不存在
  const rMissing = repair.applyActions(gApply, [{ kind: 'delete-edge', edgeKey: 'nope|nope|nope', auto: true, actionZh: '删' }]);
  check('目标边不存在 → skipped（reason 含「目标边不存在」）', rMissing.applied.length === 0 && rMissing.skipped[0].reason.includes('目标边不存在'), J(rMissing.skipped));
  // 节点不存在
  const rNoNode = repair.applyActions(gApply, [{ kind: 'retype-node', nodeId: 'nope', newType: 'quality', auto: true, actionZh: '改' }]);
  check('目标节点不存在 → skipped', rNoNode.applied.length === 0 && rNoNode.skipped[0].reason === '目标节点不存在', J(rNoNode.skipped));
  // 未指定新类型
  const rNoType = repair.applyActions(gApply, [{ kind: 'retype-node', nodeId: 'bfo-lite:a', auto: true, actionZh: '改' }]);
  check('retype-node 未指定 newType → skipped', rNoType.applied.length === 0 && rNoType.skipped[0].reason === '未指定新类型', J(rNoType.skipped));
  // 未知动作类型
  const rUnknown = repair.applyActions(gApply, [{ kind: 'frobnicate', auto: true, actionZh: '?' }]);
  check('未知动作类型 → skipped（reason 含类型名）', rUnknown.applied.length === 0 && rUnknown.skipped[0].reason.includes('frobnicate'), J(rUnknown.skipped));
  // 空动作
  const rNone = repair.applyActions(gApply, []);
  check('空动作列表 → applied=0 / 边原样（仍丢推理边）', rNone.applied.length === 0 && rNone.edges.length === 1, J({ a: rNone.applied.length, e: rNone.edges.length }));

  // ======================================================================
  section('graph.js 集成：planRepairs / applyRepairs / undoRepair / repairUndoAvailable');
  // ======================================================================
  graph.clearGraph();
  check('clearGraph 后 repairUndoAvailable=false', graph.repairUndoAvailable() === false);
  // 空图（无冲突明细）→ planRepairs 返回 hint
  const planHint = await graph.planRepairs({});
  check('无冲突 → planRepairs ok + hint', planHint.ok === true && planHint.actions.length === 0 && typeof planHint.hint === 'string' && planHint.hint.includes('没有待修复'), J({ ok: planHint.ok, hint: planHint.hint }));

  // 造一个真实冲突：bfo process —inheres_in→ material_entity（domain 强制 specifically_dependent_continuant ⊑ continuant，与 process ⊑ occurrent 互斥）
  graph.saveGraph([N('p', '过程', 'process'), N('m', '物质', 'material_entity')], [{ from: 'bfo:p', to: 'bfo:m', rel: 'inheres_in' }]);
  const runRes = await graph.runInference({}, {});
  check('runInference 报 1 条 cax-dw 冲突', runRes.ok === true && (runRes.inconsistencies || []).length === 1 && runRes.inconsistencies[0].rule === 'cax-dw', J({ ok: runRes.ok, n: (runRes.inconsistencies || []).length }));
  const det = (graph.getGraphMeta().lastStats || {}).inconsistencyDetails;
  check('冲突明细落库（items 带 nodeIds/raw 供修复定位）', det && det.items.length === 1 && J(det.items[0].nodeIds) === '["bfo:p"]' && typeof det.items[0].raw === 'string' && det.items[0].raw.length > 0, J(det && det.items[0] && { n: det.items[0].nodeIds, raw: !!det.items[0].raw }));

  // planRepairs（dry-run，不改图）
  const plan = await graph.planRepairs({});
  check('planRepairs ok + 1 个 change-rel 动作', plan.ok === true && plan.actions.length === 1 && plan.actions[0].kind === 'change-rel' && plan.actions[0].newRel === 'related_to', J({ ok: plan.ok, k: plan.actions[0] && plan.actions[0].kind }));
  check('planRepairs 默认不开 LLM 仲裁（llmArbitrate=false）', plan.llmArbitrate === false, J(plan.llmArbitrate));
  check('planRepairs 带 at 时间戳', typeof plan.at === 'number' && plan.at > 1700000000000, J(plan.at));
  check('planRepairs 是 dry-run：图未被改动', graph.getGraph().edges.some((e) => e.rel === 'inheres_in'), J(graph.getGraph().edges.map((e) => e.rel)));

  // conflictIdxs 过滤
  const planIdx = await graph.planRepairs({ conflictIdxs: [0] });
  check('conflictIdxs=[0] → 仍规划该冲突', planIdx.ok === true && planIdx.actions.length === 1, J(planIdx.actions.length));
  const planIdxNone = await graph.planRepairs({ conflictIdxs: [99] });
  check('conflictIdxs=[99]（越界）→ 无冲突可规划（hint）', planIdxNone.ok === true && planIdxNone.actions.length === 0 && !!planIdxNone.hint, J({ ok: planIdxNone.ok, n: planIdxNone.actions.length }));

  // 推理总开关关闭 → planRepairs 报错
  settingsMod.saveSettings({ reasonEnabled: false });
  const planOff = await graph.planRepairs({});
  check('推理关闭 → planRepairs ok=false（中文报错）', planOff.ok === false && planOff.error.includes('推理功能已在设置中关闭'), J(planOff));
  settingsMod.saveSettings({});

  // 旧版本落库的明细没有 nodeIds/raw → 规划出 0 动作时必须给出可操作提示（而非死胡同）
  graph.setGraphMeta({ lastStats: { skipped: false, inconsistencies: 1, inconsistencyDetails: { total: 1, truncated: false, items: [{ rule: 'cax-dw', message: 'legacy', messageZh: '', reasonZh: '', profileId: 'bfo', profileName: 'BFO', nodeNames: [], scopes: [] }] }, at: Date.now() } });
  const planLegacy = await graph.planRepairs({});
  check('旧版明细（无 nodeIds/raw）→ 0 动作 + 提示先重推理', planLegacy.ok === true && planLegacy.actions.length === 0 && typeof planLegacy.hint === 'string' && planLegacy.hint.includes('旧版本'), J({ n: planLegacy.actions.length, hint: planLegacy.hint }));
  // refresh:true 重推理刷新明细后恢复正常规划
  const planRefresh = await graph.planRepairs({ refresh: true });
  check('refresh:true 重推理后 → 正常规划出 change-rel', planRefresh.ok === true && planRefresh.actions.length === 1 && planRefresh.actions[0].kind === 'change-rel' && !planRefresh.hint, J({ n: planRefresh.actions.length, hint: planRefresh.hint || null }));

  // applyRepairs：快照 → 施加 → 落库 → 重推理
  const before = graph.getGraph();
  const applyRes = await graph.applyRepairs(plan.actions, {});
  check('applyRepairs ok + applied=1', applyRes.ok === true && applyRes.applied === 1, J({ ok: applyRes.ok, a: applyRes.applied }));
  check('applyRepairs 返回 appliedZh/skipped/nodes/edges/rerun', J(Object.keys(applyRes).sort()) === '["applied","appliedZh","edges","nodes","ok","rerun","skipped"]', J(Object.keys(applyRes)));
  check('applyRepairs 后边降级为 related_to', graph.getGraph().edges.some((e) => e.rel === 'related_to' && !e.inferred), J(graph.getGraph().edges.map(edgeTag)));
  check('applyRepairs 重推理：冲突归零', applyRes.rerun && applyRes.rerun.inconsistencies === 0, J(applyRes.rerun));
  check('applyRepairs 后 repairUndoAvailable=true', graph.repairUndoAvailable() === true);
  check('applyRepairs 落库后重推理把 inferredStale 刷回 false', graph.getGraphMeta().inferredStale === false, J(graph.getGraphMeta().inferredStale));

  // applyRepairs 过滤 manual / 空动作
  const applyManual = await graph.applyRepairs([{ kind: 'manual', auto: false, actionZh: 'x' }], {});
  check('applyRepairs 只有 manual → ok=false（没有可自动应用的动作）', applyManual.ok === false && applyManual.error === '没有可自动应用的动作', J(applyManual));
  const applyEmpty = await graph.applyRepairs([], {});
  check('applyRepairs 空数组 → ok=false', applyEmpty.ok === false && applyEmpty.error === '没有可自动应用的动作', J(applyEmpty));

  // undoRepair：恢复快照
  const undoRes = await graph.undoRepair({});
  check('undoRepair ok + 恢复 2 节点 2 边', undoRes.ok === true && undoRes.nodes === 2 && undoRes.edges === 2, J({ ok: undoRes.ok, n: undoRes.nodes, e: undoRes.edges }));
  check('undoRepair 后 inheres_in 边恢复', graph.getGraph().edges.some((e) => e.rel === 'inheres_in'), J(graph.getGraph().edges.map(edgeTag)));
  check('undoRepair 重推理：冲突复现（1 条）', undoRes.rerun && undoRes.rerun.inconsistencies === 1, J(undoRes.rerun));
  check('undoRepair 后 repairUndoAvailable=false（撤销点已清）', graph.repairUndoAvailable() === false);
  const undoAgain = await graph.undoRepair({});
  check('重复撤销 → ok=false（只保留最近一次）', undoAgain.ok === false && undoAgain.error.includes('没有可撤销的修复记录'), J(undoAgain));

  // clearGraph 清掉撤销点（防止空图被「复活」）
  graph.saveGraph([N('p', '过程', 'process'), N('m', '物质', 'material_entity')], [{ from: 'bfo:p', to: 'bfo:m', rel: 'inheres_in' }]);
  await graph.runInference({}, {});
  const plan2 = await graph.planRepairs({});
  await graph.applyRepairs(plan2.actions, {});
  check('再次修复后 repairUndoAvailable=true', graph.repairUndoAvailable() === true);
  graph.clearGraph();
  check('clearGraph 清掉撤销点 → repairUndoAvailable=false', graph.repairUndoAvailable() === false);

  // ======================================================================
  section('方案1：extractGraph 写侧互斥护栏（disjoint-type-forcing 降级）');
  // ======================================================================
  // 构造一个「自身不一致」的导入体系：red ⊑ blue 且 red/blue 互斥，触发谓词 domain=blue。
  // 节点声明 red，边用「触发」（domain=blue）→ domain 把 red 强制归入 blue，与 red 互斥。
  // checkEdge 的 domain 校验会通过（red ⊑ blue），但写侧互斥预检会拦下并降级为兜底谓词。
  db.setKv(ONTOLOGY_KEY, JSON.stringify({
    profileId: 'bfo-lite', userClasses: [], userPredicates: [], userConstraints: [],
    owlProfiles: [{
      id: 'owl:test', name: '测试体系', desc: '故意不一致', promptMode: 'flat',
      fallbackType: 'thing', fallbackRel: '关联',
      classes: [
        { key: 'thing', label: '事物', parent: '' },
        { key: 'red', label: '红', parent: 'thing' },
        { key: 'blue', label: '蓝', parent: 'thing' },
      ],
      predicates: [{ key: '关联', label: '关联' }, { key: '触发', label: '触发' }],
      constraints: [],
      axioms: [
        { type: 'SubClassOf', subject: 'red', object: 'blue', desc: '故意：红⊑蓝' },
        { type: 'DisjointClasses', subject: 'red', object: 'blue', desc: '故意：红蓝不相交' },
        { type: 'PropertyDomain', subject: '触发', object: 'blue', desc: '触发定义域=蓝' },
      ],
    }],
  }));
  const fakeGuard = await startFakeLlm(({ url, body }) => {
    if (!url.endsWith('/chat/completions')) return { status: 404, text: 'no' };
    const txt = (body.messages || []).map((m) => m.content).join('\n');
    if (/抽取可能在知识图谱中存在的实体名/.test(txt)) return json({ names: ['甲'] });
    return json({ nodes: [{ name: '甲', type: 'red', desc: '' }, { name: '乙', type: 'thing', desc: '' }], edges: [{ from: '甲', to: '乙', rel: '触发' }] });
  });
  const settingsGuard = { ...settingsMod.getSettings(), ...fakeGuard.settings() };
  graph.clearGraph();
  const exG = await graph.extractGraph(settingsGuard, { inlineSources: [{ label: '笔记·测试', text: '甲触发乙' }], ontologyProfile: 'owl:test', autoReason: false }, () => {}, null, null);
  check('写侧护栏拦下 1 条 disjoint-type-forcing', J(exG.guard) === '{"total":1,"byReason":{"disjoint-type-forcing":1},"byRel":{"触发":1}}', J(exG.guard));
  check('越界边被降级为兜底谓词「关联」', J(graph.getGraph().edges.map((e) => e.rel)) === '["关联"]', J(graph.getGraph().edges.map((e) => e.rel)));
  const gEntry = graph.getGraphMeta().lastGuard;
  check('meta.lastGuard 留痕 reason=disjoint-type-forcing', gEntry && gEntry.entries[0] && gEntry.entries[0].reason === 'disjoint-type-forcing', J(gEntry && gEntry.entries[0] && gEntry.entries[0].reason));
  check('留痕 detail 是人话（声明类型/强制互斥类）', gEntry.entries[0].detail.includes('red') && gEntry.entries[0].detail.includes('blue') && gEntry.entries[0].detail.includes('互斥'), J(gEntry.entries[0].detail));
  check('留痕 downgradedTo=关联', gEntry.entries[0].downgradedTo === '关联', J(gEntry.entries[0].downgradedTo));
  await fakeGuard.close();
  // 还原体系 kv
  db.setKv(ONTOLOGY_KEY, JSON.stringify({ profileId: 'bfo', userClasses: [], userPredicates: [], userConstraints: [], owlProfiles: [] }));

  // ======================================================================
  section('方案3：LLM 语义仲裁端到端（settings.graphRepairLlm + getReasonState.repairLlm）');
  // ======================================================================
  check('getReasonState().repairLlm 默认 false', graph.getReasonState('bfo').repairLlm === false, J(graph.getReasonState('bfo').repairLlm));
  const fakeArb = await startFakeLlm(({ url }) => (url.endsWith('/chat/completions') ? text('specifically_dependent_continuant') : { status: 404, text: 'no' }));
  settingsMod.saveSettings({ graphRepairLlm: true, ...fakeArb.settings() });
  check('开启 graphRepairLlm 后 getReasonState().repairLlm=true', graph.getReasonState('bfo').repairLlm === true, J(graph.getReasonState('bfo').repairLlm));
  graph.clearGraph();
  graph.saveGraph([N('p', '过程', 'process'), N('m', '物质', 'material_entity')], [{ from: 'bfo:p', to: 'bfo:m', rel: 'inheres_in' }]);
  await graph.runInference(settingsMod.getSettings(), {});
  const planArb = await graph.planRepairs({});
  check('LLM 仲裁生效：change-rel 转 retype-node（viaLlm=true）', planArb.ok === true && planArb.llmArbitrate === true && planArb.actions.length === 1 && planArb.actions[0].kind === 'retype-node' && planArb.actions[0].viaLlm === true && planArb.actions[0].newType === 'specifically_dependent_continuant', J({ ok: planArb.ok, llm: planArb.llmArbitrate, k: planArb.actions[0] && planArb.actions[0].kind }));
  check('仲裁确实调用了 LLM（≥1 次请求）', fakeArb.requests.length >= 1, J(fakeArb.requests.length));
  await fakeArb.close();
  settingsMod.saveSettings({});
  check('关闭 graphRepairLlm 后 getReasonState().repairLlm=false', graph.getReasonState('bfo').repairLlm === false, J(graph.getReasonState('bfo').repairLlm));
  // 关闭后 planRepairs 不再仲裁（回到 change-rel）
  const planNoArb = await graph.planRepairs({});
  check('关闭仲裁后回到确定性 change-rel', planNoArb.ok === true && planNoArb.llmArbitrate === false && planNoArb.actions[0].kind === 'change-rel', J({ llm: planNoArb.llmArbitrate, k: planNoArb.actions[0] && planNoArb.actions[0].kind }));

  // ======================================================================
  section('修复作业（graph-repair）：applyRepairsStepwise + jobs 集成');
  // ======================================================================
  const jobs = require('../src/main/jobs/jobs');
  const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
  jobs.init(() => ({ isDestroyed: () => false, webContents: { send: () => {} } }));

  // ---- applyRepairsStepwise 单元语义 ----
  graph.clearGraph();
  graph.saveGraph([N('p', '过程', 'process'), N('m', '物质', 'material_entity')], [{ from: 'bfo:p', to: 'bfo:m', rel: 'inheres_in' }]);
  await graph.runInference({}, {});
  const planS = await graph.planRepairs({});
  check('夹具：规划出 1 个 change-rel', planS.ok === true && planS.actions.length === 1, J(planS.actions.length));
  const events = [];
  const stepRes = await graph.applyRepairsStepwise(planS.actions, { onTask: (i, st, out) => events.push([i, st, out || '']), onProgress: (d, t) => events.push(['p', d, t]) });
  check('stepwise ok + applied=1', stepRes.ok === true && stepRes.applied === 1, J({ ok: stepRes.ok, a: stepRes.applied }));
  check('stepwise 回调序列 running→done→progress', J(events) === J([[0, 'running', ''], [0, 'done', '已应用：' + planS.actions[0].actionZh], ['p', 1, 1]]), J(events));
  check('stepwise 落库：边已降级', graph.getGraph().edges.some((e) => e.rel === 'related_to' && !e.inferred), J(graph.getGraph().edges.map(edgeTag)));
  check('stepwise 存撤销快照', graph.repairUndoAvailable() === true);
  check('stepwise 重推理：冲突归零', stepRes.rerun && stepRes.rerun.inconsistencies === 0, J(stepRes.rerun));
  check('stepwise 返回 failedTasks 空数组', Array.isArray(stepRes.failedTasks) && stepRes.failedTasks.length === 0);

  // 目标已不存在 → skipped（不 failed）
  const stepSkip = await graph.applyRepairsStepwise([{ kind: 'change-rel', edgeKey: 'bfo:p|bfo:m|inheres_in', newRel: 'related_to', actionZh: '降级' }], { rerun: false, snapshot: false });
  check('目标边已不存在 → applied=0 + skipped 说明', stepSkip.ok === true && stepSkip.applied === 0 && stepSkip.skipped.length === 1 && stepSkip.skipped[0].reason.includes('目标边不存在'), J(stepSkip.skipped));
  check('snapshot:false 不覆盖既有撤销点', graph.repairUndoAvailable() === true);

  // 空/全 manual → ok=false
  const stepEmpty = await graph.applyRepairsStepwise([{ kind: 'manual', actionZh: 'x' }], {});
  check('只有 manual → ok=false', stepEmpty.ok === false && stepEmpty.error === '没有可自动应用的动作', J(stepEmpty));

  // 中止：signal 已 aborted → 抛 AbortError（作业侧标「用户手动停止」）
  const ac = new AbortController(); ac.abort();
  let abortErr = null;
  try { await graph.applyRepairsStepwise(planS.actions, { signal: ac.signal }); } catch (e) { abortErr = e; }
  check('已中止 signal → 抛 AbortError', abortErr && abortErr.name === 'AbortError', J(abortErr && abortErr.name));

  // ---- jobs 集成：提交 graph-repair 作业 ----
  graph.clearGraph();
  graph.saveGraph([N('p', '过程', 'process'), N('m', '物质', 'material_entity')], [{ from: 'bfo:p', to: 'bfo:m', rel: 'inheres_in' }]);
  await graph.runInference({}, {});
  const planJ = await graph.planRepairs({});
  const sub = jobs.submit({ type: 'graph-repair', payload: { settings: settingsMod.getSettings(), actions: planJ.actions, conflictCount: 1 } });
  check('submit graph-repair 受理', sub.ok === true && !!sub.id, J(sub));
  const rjob = jobs.list().find((j) => j.id === sub.id);
  check('作业标题含冲突数与动作数', /图谱冲突修复·1 处冲突 1 个动作/.test(rjob.title), rjob.title);
  check('作业阶段为 plan/apply/verify', J(rjob.stages.map((s) => s.key)) === '["plan","apply","verify"]', J(rjob.stages.map((s) => s.key)));
  check('动作清单随 source 持久化', rjob.source && rjob.source.kind === '冲突修复' && Array.isArray(rjob.source.actions) && rjob.source.actions.length === 1, J(rjob.source && rjob.source.kind));
  await tick(1500);
  check('作业跑成功', rjob.status === 'success', rjob.status + ' / ' + rjob.error);
  check('任务列表 1 条且 done', Array.isArray(rjob.tasks) && rjob.tasks.length === 1 && rjob.tasks[0].status === 'done' && /已应用/.test(rjob.tasks[0].output), J(rjob.tasks));
  check('三阶段全部 success', rjob.stages.every((s) => s.status === 'success'), J(rjob.stages.map((s) => s.status)));
  check('verify 阶段报告剩余冲突 0', /剩余冲突 0/.test(rjob.stages[2].detail || ''), rjob.stages[2].detail);
  check('图谱实际被修复（边降级）', graph.getGraph().edges.some((e) => e.rel === 'related_to' && !e.inferred), J(graph.getGraph().edges.map(edgeTag)));
  check('作业施加前存了撤销点', graph.repairUndoAvailable() === true);
  check('result.applied=1 + failedTasks 空', rjob.result && rjob.result.applied === 1 && (rjob.result.failedTasks || []).length === 0, J(rjob.result && { a: rjob.result.applied, f: rjob.result.failedTasks }));

  // 空动作 → 拒绝提交
  check('无动作 → submit 拒绝', jobs.submit({ type: 'graph-repair', payload: { actions: [] } }).ok === false);
  check('全 manual → submit 拒绝', jobs.submit({ type: 'graph-repair', payload: { actions: [{ kind: 'manual' }] } }).ok === false);

  // 单任务重跑（graph-repair）：把 done 任务标 failed 后 retryTask 应受理并在原作业上重跑
  rjob.tasks[0].status = 'failed';
  rjob.status = 'warning';
  rjob.result = { ...(rjob.result || {}), failedTasks: [{ taskNo: 1, label: rjob.tasks[0].label, error: '模拟失败' }] };
  const rt = jobs.retryTask({ id: rjob.id, taskNo: 1, settings: settingsMod.getSettings() });
  check('graph-repair 单任务重跑受理', rt.ok === true && rt.id === rjob.id, J(rt));
  // 注：runner 在首个 await 前是同步执行的，此处任务可能已跑完，故只断言重跑标记
  check('重跑携带 _retryTaskNo=1', rjob.payload && rjob.payload._retryTaskNo === 1, J(rjob.payload && rjob.payload._retryTaskNo));
  await tick(1200);
  check('重跑后作业终态（目标边已修复 → 该动作跳过但作业成功）', rjob.status === 'success' || rjob.status === 'warning', rjob.status + ' / ' + rjob.error);
  check('重跑任务有输出（跳过或应用说明）', /已跳过|已应用/.test(rjob.tasks[0].output || ''), rjob.tasks[0].output);
  check('单任务重跑不覆盖撤销点（仍可整体撤销）', graph.repairUndoAvailable() === true);

  // 动作清单丢失（模拟重启后 payload 不入库且 source.actions 缺失）→ retry/retryTask 明确拒绝而非静默重规划
  rjob.payload = null;
  rjob.source = { kind: '冲突修复', label: 'x' };
  rjob.status = 'failed';
  rjob.tasks[0].status = 'failed';
  check('清单丢失时 retry 被拒并提示重新规划', (() => { const r = jobs.retry({ id: rjob.id, settings: settingsMod.getSettings() }); return r.ok === false && /修复动作清单丢失/.test(r.error); })());
  check('清单丢失时 retryTask 也被拒', (() => { const r = jobs.retryTask({ id: rjob.id, taskNo: 1, settings: settingsMod.getSettings() }); return r.ok === false && /修复动作清单丢失/.test(r.error); })());

  // 非 graph/graph-repair 作业仍拒绝单任务重跑
  check('未知类型单任务重跑被拒', jobs.retryTask({ id: 'nope', taskNo: 1 }).error === '作业不存在');

  // ======================================================================
  section('v1.2.2 行级修复：planOneIssue / planIssues / graph.planRepairsForIssues');
  // ======================================================================
  // 问题汇总表的行 = validate.js 的条目；行级「修复」只规划这一行。
  const issUnk = { edgeKey: 'bfo-lite:a|bfo-lite:b|notarel', fromId: 'bfo-lite:a', toId: 'bfo-lite:b', inferred: false, from: '甲', fromType: 'object', rel: 'notarel', to: '乙', toType: 'object', reason: 'unknown-predicate', detail: '', expected: null, actual: 'notarel', profileId: 'bfo-lite', profileName: 'BFO-Lite', domain: 'general', scopeLabel: '通用（未匹配领域）' };
  const gIss = { nodes: [N('a', '甲', 'object', 'bfo-lite'), N('b', '乙', 'object', 'bfo-lite')], edges: [{ from: 'bfo-lite:a', to: 'bfo-lite:b', rel: 'notarel' }] };
  const iu = await repair.planOneIssue(issUnk, gIss, BL);
  check('unknown-predicate 行 → change-rel 降级到兜底谓词', iu.length === 1 && iu[0].kind === 'change-rel' && iu[0].newRel === '相关', J(iu.map((a) => ({ k: a.kind, nr: a.newRel }))));
  check('行级动作带 source=issue + edgeKey + 中文说明', iu[0].source === 'issue' && iu[0].edgeKey === 'bfo-lite:a|bfo-lite:b|notarel' && iu[0].actionZh.includes('降级'), J({ s: iu[0].source, ek: iu[0].edgeKey }));
  // domain-violation 行（bfo inheres_in：起点 process 不满足 domain）
  const issDom = { edgeKey: 'bfo:p|bfo:m|inheres_in', fromId: 'bfo:p', toId: 'bfo:m', rel: 'inheres_in', reason: 'domain-violation', actual: 'process', expected: ['specifically_dependent_continuant'], profileId: 'bfo' };
  const gIssB = { nodes: [N('p', '过程', 'process'), N('m', '物质', 'material_entity')], edges: [{ from: 'bfo:p', to: 'bfo:m', rel: 'inheres_in' }] };
  const idm = await repair.planOneIssue(issDom, gIssB, BFO);
  check('domain-violation 行 → change-rel 降级到 related_to', idm.length === 1 && idm[0].kind === 'change-rel' && idm[0].newRel === 'related_to', J(idm.map((a) => ({ k: a.kind, nr: a.newRel }))));
  // range-violation 行同口径
  const issRng = { edgeKey: 'bfo:q|bfo:p|inheres_in', fromId: 'bfo:q', toId: 'bfo:p', rel: 'inheres_in', reason: 'range-violation', actual: 'process', expected: ['independent_continuant'], profileId: 'bfo' };
  const gIssR = { nodes: [N('q', '性质', 'quality'), N('p', '过程', 'process')], edges: [{ from: 'bfo:q', to: 'bfo:p', rel: 'inheres_in' }] };
  const irg = await repair.planOneIssue(issRng, gIssR, BFO);
  check('range-violation 行 → change-rel', irg.length === 1 && irg[0].kind === 'change-rel', J(irg.map((a) => a.kind)));
  // 不相交归属行（带 nodeId）→ 复用 planOne 的 A 类诱导边定位
  const issCon = { nodeId: 'bfo:p', node: '过程', domain: 'general', scopeLabel: '通用（未匹配领域）', profileId: 'bfo', declaredType: 'process', forcedType: 'specifically_dependent_continuant', via: 'domain', rel: 'inheres_in', pairs: [], detail: '' };
  const icf = await repair.planOneIssue(issCon, gIssB, BFO);
  check('不相交归属行 → change-rel（复用 planOne A 类）', icf.length === 1 && icf[0].kind === 'change-rel', J(icf.map((a) => a.kind)));
  // unknown-type 行：该侧无约束 → 改体系兜底类型
  const issType = { edgeKey: 'bfo-lite:a|bfo-lite:b|相关', fromId: 'bfo-lite:a', toId: 'bfo-lite:b', rel: '相关', fromType: 'ghosttype', toType: 'object', reason: 'unknown-type', actual: 'ghosttype', detail: '起点类型 ghosttype 不在体系类表中', profileId: 'bfo-lite' };
  const gIssT = { nodes: [Object.assign(N('a', '甲', 'object', 'bfo-lite'), { type: 'ghosttype' }), N('b', '乙', 'object', 'bfo-lite')], edges: [{ from: 'bfo-lite:a', to: 'bfo-lite:b', rel: '相关' }] };
  const ity = await repair.planOneIssue(issType, gIssT, BL);
  check('unknown-type 行（无约束侧）→ retype-node 到体系兜底类型 object', ity.length === 1 && ity[0].kind === 'retype-node' && ity[0].newType === 'object', J(ity.map((a) => ({ k: a.kind, nt: a.newType }))));
  // unknown-type 行 + 定义域约束 → 改为 domain 类
  const issType2 = { edgeKey: 'bfo:x|bfo:m|inheres_in', fromId: 'bfo:x', toId: 'bfo:m', rel: 'inheres_in', fromType: 'ghosttype', toType: 'material_entity', reason: 'unknown-type', actual: 'ghosttype', detail: '起点类型 ghosttype 不在体系类表中', profileId: 'bfo' };
  const gIssT2 = { nodes: [Object.assign(N('x', '幽', 'object'), { type: 'ghosttype' }), N('m', '物质', 'material_entity')], edges: [{ from: 'bfo:x', to: 'bfo:m', rel: 'inheres_in' }] };
  const ity2 = await repair.planOneIssue(issType2, gIssT2, BFO);
  check('unknown-type 行（定义域约束侧）→ retype 到 specifically_dependent_continuant', ity2.length === 1 && ity2[0].kind === 'retype-node' && ity2[0].newType === 'specifically_dependent_continuant', J(ity2.map((a) => ({ k: a.kind, nt: a.newType }))));
  // planIssues 批量：去重 + 5 字段契约 + 体系解析失败 → manual
  const batch = await repair.planIssues([issUnk, issUnk, issDom], gIss, (pid) => (pid === 'bfo' ? BFO : BL));
  check('planIssues 去重：两条相同 unknown-predicate 行 → 1 个动作', batch.actions.filter((a) => a.edgeKey === 'bfo-lite:a|bfo-lite:b|notarel').length === 1, J(batch.actions.map((a) => a.edgeKey)));
  check('planIssues 返回 5 字段契约', J(Object.keys(batch).sort()) === '["actions","autoCount","byKind","conflictCount","manualCount"]', J(Object.keys(batch).sort()));
  const batchBad = await repair.planIssues([{ ...issUnk, profileId: 'owl:nope' }], gIss, (pid) => (pid === 'bfo' ? BFO : pid === 'bfo-lite' ? BL : null));
  check('体系无法解析 → manual 动作（不抛）', batchBad.actions.length === 1 && batchBad.actions[0].kind === 'manual' && batchBad.actions[0].actionZh.includes('无法解析'), J(batchBad.actions));
  // graph 包装层
  graph.clearGraph();
  graph.saveGraph(gIss.nodes, gIss.edges);
  const gp = await graph.planRepairsForIssues([issUnk]);
  check('graph.planRepairsForIssues ok + 1 个 change-rel', gp.ok === true && gp.actions.length === 1 && gp.actions[0].kind === 'change-rel', J({ ok: gp.ok, n: gp.actions.length }));
  check('graph.planRepairsForIssues 是 dry-run：图未改', graph.getGraph().edges.some((e) => e.rel === 'notarel'), J(graph.getGraph().edges.map(edgeTag)));
  const gpEmpty = await graph.planRepairsForIssues([]);
  check('空 issues → ok + hint', gpEmpty.ok === true && gpEmpty.actions.length === 0 && !!gpEmpty.hint, J(gpEmpty));
  settingsMod.saveSettings({ reasonEnabled: false });
  const gpOff = await graph.planRepairsForIssues([issUnk]);
  check('推理关闭 → planRepairsForIssues ok=false', gpOff.ok === false && gpOff.error.includes('推理功能已在设置中关闭'), J(gpOff));
  settingsMod.saveSettings({});

  // ======================================================================
  section('IPC 通道：graph:planRepairs / graph:planRepairsForIssues / graph:applyRepairs / graph:undoRepair');
  // ======================================================================
  const { registerIpc } = require('../src/main/ipc');
  registerIpc(() => ({ isDestroyed: () => false, webContents: { send: () => {} } }));
  const invoke = env.el.invoke;
  check('4 个修复通道全部注册', ['graph:planRepairs', 'graph:planRepairsForIssues', 'graph:applyRepairs', 'graph:undoRepair'].every((c) => env.el.handlers.has(c)), J(['graph:planRepairs', 'graph:planRepairsForIssues', 'graph:applyRepairs', 'graph:undoRepair'].filter((c) => !env.el.handlers.has(c))));

  graph.clearGraph();
  const iPlanEmpty = await invoke('graph:planRepairs', {});
  check('graph:planRepairs 空图 → ok + hint', iPlanEmpty.ok === true && iPlanEmpty.actions.length === 0 && !!iPlanEmpty.hint, J({ ok: iPlanEmpty.ok, n: iPlanEmpty.actions.length }));
  const iApplyEmpty = await invoke('graph:applyRepairs', [], {});
  check('graph:applyRepairs 空动作 → ok=false（不抛）', iApplyEmpty.ok === false && iApplyEmpty.error === '没有可自动应用的动作', J(iApplyEmpty));
  const iApplyObj = await invoke('graph:applyRepairs', { actions: [], opts: {} });
  check('graph:applyRepairs 兼容 web-shim 单 body 形态', iApplyObj.ok === false && iApplyObj.error === '没有可自动应用的动作', J(iApplyObj));
  const iUndoNone = await invoke('graph:undoRepair', {});
  check('graph:undoRepair 无快照 → ok=false（不抛）', iUndoNone.ok === false && iUndoNone.error.includes('没有可撤销的修复记录'), J(iUndoNone));
  // 行级修复通道（两种形态：数组 / web-shim 单 body {issues}）
  const iIss = await invoke('graph:planRepairsForIssues', [issUnk]);
  check('graph:planRepairsForIssues 数组形态 → ok + 1 动作', iIss.ok === true && iIss.actions.length === 1, J({ ok: iIss.ok, n: iIss.actions.length }));
  const iIssObj = await invoke('graph:planRepairsForIssues', { issues: [issUnk] });
  check('graph:planRepairsForIssues 单 body 形态 → 同样命中', iIssObj.ok === true && iIssObj.actions.length === 1, J({ ok: iIssObj.ok, n: iIssObj.actions.length }));

  // 真实修复走 IPC：造冲突 → plan → apply（两种形态）→ undo
  graph.saveGraph([N('p', '过程', 'process'), N('m', '物质', 'material_entity')], [{ from: 'bfo:p', to: 'bfo:m', rel: 'inheres_in' }]);
  await invoke('graph:runInference', {});
  const iPlan = await invoke('graph:planRepairs', {});
  check('graph:planRepairs 有冲突 → 1 个 change-rel', iPlan.ok === true && iPlan.actions.length === 1 && iPlan.actions[0].kind === 'change-rel', J({ ok: iPlan.ok, n: iPlan.actions.length }));
  const iApply = await invoke('graph:applyRepairs', iPlan.actions, {});
  check('graph:applyRepairs（数组+opts 形态）→ ok + applied=1', iApply.ok === true && iApply.applied === 1, J({ ok: iApply.ok, a: iApply.applied }));
  check('graph:applyRepairs 后 repairUndoAvailable=true（经 IPC）', graph.repairUndoAvailable() === true);
  const iUndo = await invoke('graph:undoRepair', {});
  check('graph:undoRepair → ok + 恢复 2 边', iUndo.ok === true && iUndo.edges === 2, J({ ok: iUndo.ok, e: iUndo.edges }));

  // web-shim 单 body 形态应用修复
  await invoke('graph:runInference', {});
  const iPlan2 = await invoke('graph:planRepairs', {});
  const iApply2 = await invoke('graph:applyRepairs', { actions: iPlan2.actions, opts: {} });
  check('graph:applyRepairs（单 body 形态）→ ok + applied=1', iApply2.ok === true && iApply2.applied === 1, J({ ok: iApply2.ok, a: iApply2.applied }));

  const ok = summary();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
