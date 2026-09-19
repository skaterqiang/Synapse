// 充电桩扩容例子的非 LLM 测试（本体体系 + 图谱结合，docs/design/多本体体系选择总体设计.md §0.0）
// 运行：node test/charge-pile-ontology.test.js
const path = require('path');
const Module = require('module');
const origRequire = Module.prototype.require;
const fakeApp = {
  getPath: () => path.join(__dirname, '..', 'data'),
  getAppPath: () => path.join(__dirname, '..'),
  isPackaged: false,
};
Module.prototype.require = function (id) {
  if (id === 'electron') return { app: fakeApp };
  return origRequire.apply(this, arguments);
};

(async () => {
  const out = [];
  const ok = (name, cond) => out.push(`${cond ? '✓' : '✗'} ${name}`);
  const graph = origRequire(path.join(__dirname, '..', 'src/main/graph/graph.js'));
  const db = origRequire(path.join(__dirname, '..', 'src/main/common/db.js'));
  await db.init();
  const g = graph.getGraph();
  ok('图谱有节点(>50)', g.nodes.length > 50);
  ok('节点带 profile 字段', g.nodes.every(n => n.profile));
  ok('节点带 type 字段', g.nodes.every(n => n.type));
  ok('节点带 sources 数组', g.nodes.every(n => Array.isArray(n.sources)));
  const lite = graph.resolveOntology('bfo-lite');
  const bfo = graph.resolveOntology('bfo');
  const iso = graph.resolveOntology('iso15926');
  ok('bfo-lite 11类', lite.classes.length === 11);
  ok('bfo 21类', bfo.classes.length === 21);
  ok('iso15926 14类', iso.classes.length === 14);
  ok('iso15926 含 physical_object', iso.classes.some(c => c.key === 'physical_object'));
  ok('iso15926 含 composedOf', iso.predicates.some(p => p.key === 'composedOf'));
  const legal = graph.resolveOntology('legal');
  ok('legal 43类', legal.classes.length === 43);
  ok('legal 含 Norm 规范根类', legal.classes.some(c => c.key === 'Norm'));
  ok('legal 含 qualifies 定性谓词', legal.predicates.some(p => p.key === 'qualifies'));
  const auto = graph.resolveOntology('automotive');
  ok('automotive 50类', auto.classes.length === 50);
  ok('automotive 含 ManufacturingProcess 制造过程', auto.classes.some(c => c.key === 'ManufacturingProcess'));
  ok('automotive 含 hasComponentPart 有零部件谓词', auto.predicates.some(p => p.key === 'hasComponentPart'));
  const profs = graph.listProfiles();
  ok('listProfiles 含内置体系', profs.some(p=>p.id==='bfo-lite') && profs.some(p=>p.id==='bfo') && profs.some(p=>p.id==='iso15926') && profs.some(p=>p.id==='legal') && profs.some(p=>p.id==='automotive'));
  ok('listProfiles 带 counts', profs.every(p => p.counts && typeof p.counts.classes === 'number'));
  const scopes = graph.listGraphScopes();
  ok('listGraphScopes 返回分组', scopes.length >= 2);
  ok('scopeFilter all null', graph.scopeFilter('all') === null);
  // 域 id/节点数随实时库变化（历史快照 ev_charger_application/general 已漂移），
  // 改为动态取当前两个 scope 断言自洽性，避免数据一变测试就红
  const sA = scopes[0];
  const sB = scopes[1];
  ok('scope 计数与库内节点自洽', sA.nodeCount === g.nodes.filter((n) => (n.profile || 'bfo-lite') === sA.profile && ((n.domain && String(n.domain).trim()) || 'general') === sA.domain).length && sB.nodeCount > 0);
  const nA = g.nodes.find((n) => ((n.domain && String(n.domain).trim()) || 'general') === sA.domain && (n.profile || 'bfo-lite') === sA.profile);
  const nB = g.nodes.find((n) => ((n.domain && String(n.domain).trim()) || 'general') === sB.domain && (n.profile || 'bfo-lite') === sB.profile);
  ok('scopeFilter A 收留 A 节点', graph.scopeFilter(sA.id)(nA) === true);
  ok('scopeFilter A 排除 B 节点', graph.scopeFilter(sA.id)(nB) === false);
  ok('scopeFilter B 收留 B 节点', graph.scopeFilter(sB.id)(nB) === true);
  ok('scopeFilter 多选收留两类', graph.scopeFilter(`${sA.id},${sB.id}`)(nB) === true);
  const r = graph.recallFor('变压器', 8, '', 'all');
  ok('recall 命中变压器', r.hits.some((h) => h.includes('变压器')));
  ok('标签含体系名', /\[.+体系·/.test(r.context));
  ok('标签含类型', /·\w+\]/.test(r.context));
  const hitScope = scopes.find((s) => graph.recallFor('变压器', 8, '', s.id).hits.length > 0);
  const missScope = scopes.find((s) => s.id !== (hitScope || {}).id);
  ok('存在命中变压器的 scope', !!hitScope);
  ok('其余 scope 不命中变压器', !!missScope && graph.recallFor('变压器', 8, '', missScope.id).hits.length === 0);
  const fails = out.filter(l => l.startsWith('✗')).length;
  console.log(out.join('\n'));
  console.log(`\n${out.length - fails}/${out.length} 通过${fails ? `，${fails} 失败` : ''}`);
  process.exit(fails ? 1 : 0);
})();
