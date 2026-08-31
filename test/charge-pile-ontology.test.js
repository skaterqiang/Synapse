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
  const profs = graph.listProfiles();
  ok('listProfiles 含三内置', profs.some(p=>p.id==='bfo-lite') && profs.some(p=>p.id==='bfo') && profs.some(p=>p.id==='iso15926'));
  ok('listProfiles 带 counts', profs.every(p => p.counts && typeof p.counts.classes === 'number'));
  const scopes = graph.listGraphScopes();
  ok('listGraphScopes 返回分组', scopes.length >= 1);
  const evScope = scopes.find(s => s.domain === 'ev_charger_application');
  ok('ev_charger_application 图谱 45节点', evScope && evScope.nodeCount === 45);
  const generalScope = scopes.find(s => s.domain === 'general');
  ok('general 图谱 12节点', generalScope && generalScope.nodeCount === 12);
  ok('scopeFilter all null', graph.scopeFilter('all') === null);
  const evNode = g.nodes.find(n => n.domain === 'ev_charger_application');
  const genNode = g.nodes.find(n => !n.domain);
  ok('scopeFilter ev 收留 ev 节点', graph.scopeFilter('bfo-lite|ev_charger_application')(evNode) === true);
  ok('scopeFilter ev 排除 general 节点', graph.scopeFilter('bfo-lite|ev_charger_application')(genNode) === false);
  ok('scopeFilter general 收留无domain', graph.scopeFilter('bfo-lite|general')(genNode) === true);
  ok('scopeFilter 多选收留两类', graph.scopeFilter('bfo-lite|ev_charger_application,bfo-lite|general')(genNode) === true);
  const r = graph.recallFor('变压器', 8, '', 'all');
  ok('recall 命中变压器', r.hits.some(h => h.includes('变压器')));
  ok('标签含体系名', r.context.includes('[BFO-Lite 轻量体系·'));
  ok('标签含类型', /·\w+\]/.test(r.context));
  ok('scope=ev 命中变压器', graph.recallFor('变压器', 8, '', 'bfo-lite|ev_charger_application').hits.length > 0);
  ok('scope=general 不命中变压器', graph.recallFor('变压器', 8, '', 'bfo-lite|general').hits.length === 0);
  const fails = out.filter(l => l.startsWith('✗')).length;
  console.log(out.join('\n'));
  console.log(`\n${out.length - fails}/${out.length} 通过${fails ? `，${fails} 失败` : ''}`);
  process.exit(fails ? 1 : 0);
})();
