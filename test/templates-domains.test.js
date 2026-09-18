// 领域模版层测试：graph/templates.js
// 覆盖：模版存储与 v1→v2 迁移、体系绑定校验、领域匹配（LLM + 关键词兜底）、
//       多领域归纳 suggestDomains、逐文件归类 assignDomains（分批/多归属/置信度）
// 运行：node test/templates-domains.test.js
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { bootEnv, mkCheck, startFakeLlm, sseText, REPO_ROOT } = require('./helpers/harness');

const { check, section, summary } = mkCheck('领域模版层（templates）');

const json = (obj) => ({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, sse: sseText(JSON.stringify(obj)) });

(async () => {
  const env = await bootEnv({ prefix: 'synapse-tpl-' });
  const tpl = require(path.join(REPO_ROOT, 'src/main/graph/templates'));
  const db = env.db;
  const { DOMAIN_TEMPLATES_KEY } = require(path.join(REPO_ROOT, 'src/main/common/constants'));

  // ================= 内置通用模版 =================
  section('内置通用模版与列表');
  const list0 = tpl.listTemplates();
  check('初始只有内置通用模版', list0.length === 1 && list0[0].id === 'general', JSON.stringify(list0.map((t) => t.id)));
  check('通用模版标记 builtin', list0[0].builtin === true);
  check('通用模版补齐体系名', !!list0[0].profileName, list0[0].profileName);
  check('kv 损坏时兜底为通用模版', (() => {
    db.setKv(DOMAIN_TEMPLATES_KEY, '{不是 JSON');
    const l = tpl.listTemplates();
    db.setKv(DOMAIN_TEMPLATES_KEY, '[]');
    return l.length === 1 && l[0].id === 'general';
  })());
  check('kv 为非数组时兜底', (() => {
    db.setKv(DOMAIN_TEMPLATES_KEY, '{"a":1}');
    const l = tpl.listTemplates();
    db.setKv(DOMAIN_TEMPLATES_KEY, '[]');
    return l.length === 1 && l[0].id === 'general';
  })());

  // ================= v1 → v2 惰性迁移 =================
  section('v1 → v2 惰性迁移');
  db.setKv(DOMAIN_TEMPLATES_KEY, JSON.stringify([
    { id: 'general', name: '通用', keywords: [], builtin: true, entityTypes: [{ name: '人物' }], conceptTypes: [{ name: '方法' }] },
    { id: 'v1_tpl', name: '旧模版', keywords: ['旧'], entityTypes: [{ name: '设备', desc: '物理设备' }], conceptTypes: [{ name: '标准', desc: '规范文档' }] },
  ]));
  const migrated = tpl.listTemplates();
  const v1 = migrated.find((t) => t.id === 'v1_tpl');
  check('v1 模版补 domainClasses', Array.isArray(v1.domainClasses) && v1.domainClasses.length === 2, JSON.stringify(v1.domainClasses));
  check('entityTypes 挂到 object', v1.domainClasses.find((c) => c.key === '设备').parent === 'object');
  check('conceptTypes 挂到 information', v1.domainClasses.find((c) => c.key === '标准').parent === 'information');
  check('迁移标记 migratedFrom=v1', v1.migratedFrom === 'v1');
  check('迁移补默认体系 bfo-lite', v1.ontologyProfile === 'bfo-lite');
  check('通用模版迁移后 domainClasses 留空', JSON.stringify(migrated.find((t) => t.id === 'general').domainClasses) === '[]');
  check('迁移结果已持久化', (() => {
    const raw = JSON.parse(db.getKv(DOMAIN_TEMPLATES_KEY));
    return raw.find((t) => t.id === 'v1_tpl').domainClasses.length === 2;
  })());
  check('二次读取不重复迁移', tpl.listTemplates().find((t) => t.id === 'v1_tpl').migratedFrom === 'v1');

  // ================= saveTemplate =================
  section('saveTemplate 归一化与校验');
  let e = '';
  try { tpl.saveTemplate({ name: '   ' }); } catch (err) { e = err.message; }
  check('名称为空抛错', e === '名称不能为空', e);
  const t1 = tpl.saveTemplate({ name: '樱桃种植', desc: '果树栽培', keywords: '樱桃,种植，栽培', ontologyProfile: 'bfo-lite' });
  check('自动生成合法英文 id', /^[A-Za-z][A-Za-z0-9_]*$/.test(t1.id), t1.id);
  check('关键词按中英文逗号切分去重', JSON.stringify(t1.keywords) === JSON.stringify(['樱桃', '种植', '栽培']), JSON.stringify(t1.keywords));
  check('非法 id 被替换为自动生成', tpl.saveTemplate({ id: '123bad', name: '非法ID' }).id !== '123bad');
  check('中文 id 被替换', tpl.saveTemplate({ id: '中文标识', name: '中文ID' }).id !== '中文标识');
  const t2 = tpl.saveTemplate({
    id: 'equip_ops', name: '设备运维', keywords: ['充电桩', '扩容', '运维'], ontologyProfile: 'bfo-lite',
    domainClasses: [
      { key: 'object', label: '物体', from: 'base' },
      { key: 'ghost', label: '幽灵类', from: 'base' },
      { key: '充电桩', label: '充电桩', parent: 'object', desc: '充电设备', from: 'custom' },
      { key: '运维规程', label: '运维规程', parent: 'not_in_tree', from: 'custom' },
    ],
  });
  check('base 类不在体系中被剔除', !t2.domainClasses.some((c) => c.key === 'ghost'));
  check('base 类在体系中被保留', t2.domainClasses.some((c) => c.key === 'object' && c.from === 'base'));
  check('非法父类被挂到兜底类', t2.domainClasses.find((c) => c.key === '运维规程').parent === 'object');
  check('降级项写入 _warnings', t2._warnings.some((w) => w.includes('ghost') && w.includes('已忽略')) && t2._warnings.some((w) => w.includes('兜底类')), JSON.stringify(t2._warnings));
  check('_warnings 不落库', !JSON.parse(db.getKv(DOMAIN_TEMPLATES_KEY)).some((t) => t._warnings));
  check('parent 指向同批自定义类时不降级', tpl.saveTemplate({
    id: 'nested', name: '嵌套', ontologyProfile: 'bfo-lite',
    domainClasses: [{ key: '父类A', label: '父类A', parent: 'object', from: 'custom' }, { key: '子类B', label: '子类B', parent: '父类A', from: 'custom' }],
  }).domainClasses.find((c) => c.key === '子类B').parent === '父类A');
  check('反推 entityTypes（非 information）', t2.entityTypes.some((x) => x.name === '充电桩'));
  check('反推 conceptTypes（information 父类）', (() => {
    const t = tpl.saveTemplate({ id: 'mix', name: '混合', ontologyProfile: 'bfo-lite', domainClasses: [{ key: 'K1', label: 'K1', parent: 'information', from: 'custom' }] });
    return t.conceptTypes.some((x) => x.name === 'K1') && !t.entityTypes.some((x) => x.name === 'K1');
  })());
  check('同 id upsert 不新增条目', (() => {
    const before = tpl.listTemplates().length;
    tpl.saveTemplate({ id: 'equip_ops', name: '设备运维改', keywords: ['充电桩', '扩容', '运维'] });
    return tpl.listTemplates().length === before && tpl.listTemplates().find((t) => t.id === 'equip_ops').name === '设备运维改';
  })());
  check('builtin 标记不被覆盖', tpl.saveTemplate({ id: 'general', name: '通用' }).builtin === true);
  check('未知体系回退 bfo-lite', tpl.saveTemplate({ id: 'unknown_prof', name: '未知体系', ontologyProfile: 'owl:nope' }).ontologyProfile === 'owl:nope' && !!tpl.listTemplates().find((t) => t.id === 'unknown_prof').profileName);

  // ================= removeTemplate =================
  section('removeTemplate 删除防护');
  let e2 = '';
  try { tpl.removeTemplate('no_such'); } catch (err) { e2 = err.message; }
  check('删除不存在模版抛错', e2 === '模版不存在：no_such', e2);
  let e3 = '';
  try { tpl.removeTemplate('general'); } catch (err) { e3 = err.message; }
  check('内置通用模版不可删除', e3 === '内置通用模版不可删除', e3);
  check('删除自定义模版成功', tpl.removeTemplate('nested').removed === 'nested');
  check('删除后列表不含该模版', !tpl.listTemplates().some((t) => t.id === 'nested'));

  // ================= matchPrompt =================
  section('matchPrompt 提示词构造');
  const mp = tpl.matchPrompt();
  check('含来源摘录占位符', mp.includes('{{SOURCE_EXCERPT}}'));
  check('列出全部模版 id 与关键词', mp.includes('general') && mp.includes('equip_ops'));
  check('要求无法匹配时返回 general', mp.includes('一律返回 general'));
  check('要求输出 JSON 且含 similarity', mp.includes('"template"') && mp.includes('"similarity"'));

  // ================= matchTemplate / preMatchTemplate =================
  section('matchTemplate — LLM 判定');
  {
    const fake = await startFakeLlm(() => json({ template: 'equip_ops', similarity: 88, reason: '内容涉及充电桩运维' }));
    try {
      const picked = await tpl.matchTemplate(fake.settings(), [{ content: '充电桩扩容与运维规程' }]);
      check('按模型返回选中模版', picked && picked.id === 'equip_ops', picked && picked.id);
      check('similarity 透传', picked._similarity === 88, String(picked._similarity));
      check('匹配请求限制 thinking 预算（百炼系）', (await (async () => {
        const f2 = await startFakeLlm(() => json({ template: 'equip_ops', similarity: 10 }));
        try { await tpl.matchTemplate(f2.settings({ apiProvider: 'dashscope' }), [{ content: 'x' }]); return f2.requests[0].body.thinking_budget; } finally { await f2.close(); }
      })()) === 4000);
      check('来源摘录注入 prompt', fake.requests[0].body.messages[1].content.includes('充电桩扩容与运维规程'));
    } finally { await fake.close(); }
  }
  {
    const fake = await startFakeLlm(() => json({ template: 'equip_ops', similarity: 250, reason: 'x' }));
    try {
      const picked = await tpl.matchTemplate(fake.settings(), [{ content: 'a' }]);
      check('similarity 钳制到 ≤100', picked._similarity === 100, String(picked._similarity));
    } finally { await fake.close(); }
  }
  {
    const fake = await startFakeLlm(() => json({ template: 'ghost_id', similarity: 90 }));
    try {
      let reasons = [];
      const picked = await tpl.matchTemplate(fake.settings(), [{ content: '充电桩扩容' }], { onPick: (r) => { reasons.push(r); } });
      check('非法 id 回退关键词匹配', picked && picked.id === 'equip_ops', picked && picked.id);
      check('回退原因带回原始 id', reasons.some((r) => r.includes('ghost_id')), JSON.stringify(reasons));
      check('关键词兜底原因上报', reasons.some((r) => r.includes('关键词命中')), JSON.stringify(reasons));
      check('关键词兜底按命中数计分（每词 20）', picked._similarity === 40, String(picked._similarity));
    } finally { await fake.close(); }
  }
  {
    const fake = await startFakeLlm(() => ({ status: 500, text: 'boom' }));
    try {
      let degraded = null;
      const picked = await tpl.matchTemplate(fake.settings({ chatRetries: 0 }), [{ content: '充电桩扩容运维' }], { onDegrade: (err) => { degraded = err; } });
      check('LLM 失败触发 onDegrade', !!degraded);
      check('LLM 失败仍返回关键词兜底结果', picked && picked.id === 'equip_ops', picked && picked.id);
    } finally { await fake.close(); }
  }
  {
    const fake = await startFakeLlm(() => json({ template: 'general', similarity: 0 }));
    try {
      const picked = await tpl.matchTemplate(fake.settings(), [{ content: '无关内容' }]);
      check('模型判为 general 时返回通用模版', picked && picked.id === 'general', picked && picked.id);
    } finally { await fake.close(); }
  }
  {
    // 只有通用模版时不发请求
    const saved = db.getKv(DOMAIN_TEMPLATES_KEY);
    db.setKv(DOMAIN_TEMPLATES_KEY, JSON.stringify([{ id: 'general', name: '通用', builtin: true, keywords: [], domainClasses: [] }]));
    const fake = await startFakeLlm(() => json({ template: 'general' }));
    try {
      const picked = await tpl.matchTemplate(fake.settings(), [{ content: 'x' }]);
      check('仅通用模版时直接返回、不调模型', picked.id === 'general' && fake.requests.length === 0, String(fake.requests.length));
    } finally { await fake.close(); db.setKv(DOMAIN_TEMPLATES_KEY, saved); }
  }

  section('preMatchTemplate — 预匹配语义');
  {
    const fake = await startFakeLlm(() => json({ template: 'equip_ops', similarity: 77, reason: '命中设备运维' }));
    try {
      const r = await tpl.preMatchTemplate(fake.settings(), [{ content: '充电桩' }]);
      check('命中特定领域返回 matched', r.matched && r.matched.id === 'equip_ops', JSON.stringify(r.matched));
      check('matched 带 reason 与 similarity', r.matched.reason === '命中设备运维' && r.matched.similarity === 77);
      check('hasSpecific=true', r.hasSpecific === true);
      check('未降级', r.degraded === false && r.degradeError === '');
    } finally { await fake.close(); }
  }
  {
    const fake = await startFakeLlm(() => json({ template: 'general', similarity: 0 }));
    try {
      const r = await tpl.preMatchTemplate(fake.settings(), [{ content: 'x' }]);
      check('判为 general 时 matched=null', r.matched === null, JSON.stringify(r.matched));
    } finally { await fake.close(); }
  }
  {
    const fake = await startFakeLlm(() => ({ hang: true }));
    try {
      const r = await tpl.preMatchTemplate(fake.settings({ chatRetries: 0 }), [{ content: '充电桩扩容' }], { timeoutMs: 300 });
      check('超时标记 degraded', r.degraded === true);
      check('超时改写为可读描述', /模型未在 \d+ 秒内响应/.test(r.degradeError), r.degradeError);
      check('超时仍给出关键词兜底结果', r.matched && r.matched.id === 'equip_ops', JSON.stringify(r.matched));
    } finally { await fake.close(); }
  }
  {
    const saved = db.getKv(DOMAIN_TEMPLATES_KEY);
    db.setKv(DOMAIN_TEMPLATES_KEY, JSON.stringify([{ id: 'general', name: '通用', builtin: true, keywords: [], domainClasses: [] }]));
    const fake = await startFakeLlm(() => json({ template: 'general' }));
    try {
      const r = await tpl.preMatchTemplate(fake.settings(), [{ content: 'x' }]);
      check('无特定领域时 hasSpecific=false 且不调模型', r.hasSpecific === false && r.matched === null && fake.requests.length === 0, JSON.stringify(r));
      check('total 反映模版数', r.total === 1, String(r.total));
    } finally { await fake.close(); db.setKv(DOMAIN_TEMPLATES_KEY, saved); }
  }

  // ================= suggestDomains =================
  section('suggestDomains — 多领域归纳');
  {
    const fake = await startFakeLlm(() => json({ domains: [{ name: '充电桩扩容', desc: '电力设施' }, { name: '资金安全', desc: '风控' }] }));
    try {
      const r = await tpl.suggestDomains(fake.settings(), [{ content: '充电桩扩容与资金安全防控' }]);
      check('返回多领域数组', r.domains.length === 2 && r.domains[0].name === '充电桩扩容', JSON.stringify(r.domains));
      check('desc 一并返回', r.domains[1].desc === '风控');
      check('prompt 要求识别全部领域且不设上限', fake.requests[0].body.messages[1].content.includes('不限制数量'));
      check('来源摘录注入 prompt', fake.requests[0].body.messages[1].content.includes('充电桩扩容与资金安全防控'));
    } finally { await fake.close(); }
  }
  {
    // 领域数量不设上限：8 个全部保留
    const many = Array.from({ length: 8 }, (_, i) => ({ name: '领域' + (i + 1), desc: 'd' + i }));
    const fake = await startFakeLlm(() => json({ domains: many }));
    try {
      const r = await tpl.suggestDomains(fake.settings(), [{ content: 'x' }]);
      check('领域数量不截断（8 个全保留）', r.domains.length === 8, String(r.domains.length));
    } finally { await fake.close(); }
  }
  {
    const fake = await startFakeLlm(() => json({ name: '单领域', desc: '兼容旧格式' }));
    try {
      const r = await tpl.suggestDomains(fake.settings(), [{ content: 'x' }]);
      check('兼容单对象返回 {name,desc}', r.domains.length === 1 && r.domains[0].name === '单领域', JSON.stringify(r.domains));
    } finally { await fake.close(); }
  }
  {
    const fake = await startFakeLlm(() => json({ domains: [{ name: '重复' }, { name: '重复' }, { name: '  重复  ' }, { name: '' }, null, { name: '唯一' }] }));
    try {
      const r = await tpl.suggestDomains(fake.settings(), [{ content: 'x' }]);
      check('同名去重 + 空名剔除', JSON.stringify(r.domains.map((d) => d.name)) === JSON.stringify(['重复', '唯一']), JSON.stringify(r.domains));
    } finally { await fake.close(); }
  }
  {
    const fake = await startFakeLlm(() => json({ domains: [] }));
    try {
      let err = '';
      try { await tpl.suggestDomains(fake.settings(), [{ content: 'x' }]); } catch (e) { err = e.message; }
      check('空领域列表抛错', err === '未能从来源内容归纳出领域', err);
    } finally { await fake.close(); }
  }
  {
    const fake = await startFakeLlm(() => json({ domains: [{ name: 'A' }] }));
    try {
      let err = '';
      try { await tpl.suggestDomains(fake.settings(), [{ content: '   ' }, { content: '' }]); } catch (e) { err = e.message; }
      check('来源内容为空抛错且不调模型', err === '来源内容为空，无法归纳领域' && fake.requests.length === 0, err + '/' + fake.requests.length);
      err = '';
      try { await tpl.suggestDomains(fake.settings(), []); } catch (e) { err = e.message; }
      check('raws 为空数组同样抛错', err === '来源内容为空，无法归纳领域', err);
    } finally { await fake.close(); }
  }
  {
    // 超长来源截断到 8000 字
    const fake = await startFakeLlm(() => json({ domains: [{ name: 'A' }] }));
    try {
      await tpl.suggestDomains(fake.settings(), [{ content: 'x'.repeat(20000) }]);
      const sent = fake.requests[0].body.messages[1].content;
      check('来源摘录截断到 8000 字', sent.split('=== 来源内容摘录 ===')[1].trim().length === 8000, String(sent.split('=== 来源内容摘录 ===')[1].trim().length));
    } finally { await fake.close(); }
  }
  {
    // onDelta 流式回调透传
    const fake = await startFakeLlm(() => ({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, sse: sseText(JSON.stringify({ domains: [{ name: 'A' }] }), { reasoning: '思考中' }) }));
    try {
      const seen = [];
      await tpl.suggestDomains(fake.settings(), [{ content: 'x' }], (d, r) => seen.push([d, r]));
      check('onDelta 收到推理与正文增量', seen.some((x) => x[1]) && seen.some((x) => !x[1]), JSON.stringify(seen.length));
    } finally { await fake.close(); }
  }
  {
    // 回归：首轮模型只输出散文（无 JSON）→ 自动追加强约束重试，第二轮给出合法 JSON（复现截图故障）
    const fake = await startFakeLlm(({ n }) => (n === 1
      ? { status: 200, headers: { 'Content-Type': 'text/event-stream' }, sse: sseText('让我想想……这些来源涉及好几个领域，我需要分析一下') }
      : json({ domains: [{ name: '充电桩扩容', desc: '电力' }] })));
    try {
      const r = await tpl.suggestDomains(fake.settings(), [{ content: '充电桩扩容' }]);
      check('首轮散文→自动重试成功', r.domains.length === 1 && r.domains[0].name === '充电桩扩容', JSON.stringify(r.domains));
      check('共发起 2 次请求', fake.requests.length === 2, String(fake.requests.length));
      check('重试追加了强约束指令', fake.requests[1].body.messages.some((m) => /不是合法 JSON/.test(m.content)), JSON.stringify(fake.requests[1].body.messages.length));
    } finally { await fake.close(); }
  }
  {
    // 两轮都非 JSON → 最终抛错（重试不掩盖持续性故障）
    const fake = await startFakeLlm(() => ({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, sse: sseText('只是散文，没有任何 JSON') }));
    try {
      let err = '';
      try { await tpl.suggestDomains(fake.settings(), [{ content: 'x' }]); } catch (e) { err = e.message; }
      check('两轮均无 JSON 最终抛「模型未返回 JSON」', err === '模型未返回 JSON', err);
      check('确实重试过一次', fake.requests.length === 2, String(fake.requests.length));
    } finally { await fake.close(); }
  }

  // ================= suggestTemplateName =================
  section('suggestTemplateName — 领域名归纳');
  {
    const fake = await startFakeLlm(() => json({ name: '  樱桃种植  ', desc: '果树栽培' }));
    try {
      const r = await tpl.suggestTemplateName(fake.settings(), [{ content: '樱桃种植技术' }]);
      check('名称去空白', r.name === '樱桃种植', r.name);
      check('desc 返回', r.desc === '果树栽培');
    } finally { await fake.close(); }
  }
  {
    const fake = await startFakeLlm(() => json({ desc: '没有名字' }));
    try {
      let err = '';
      try { await tpl.suggestTemplateName(fake.settings(), [{ content: 'x' }]); } catch (e) { err = e.message; }
      check('缺名称抛错', err === '未能从来源内容归纳出领域名称', err);
      err = '';
      try { await tpl.suggestTemplateName(fake.settings(), [{ content: ' ' }]); } catch (e) { err = e.message; }
      check('来源为空抛错', err === '来源内容为空，无法归纳领域名称', err);
    } finally { await fake.close(); }
  }

  // ================= suggestOntologyProfile =================
  section('suggestOntologyProfile — 体系实时判定');
  {
    const fake = await startFakeLlm(() => json({ profile: 'iso15926', similarity: 180, reason: '涉及设备与产线' }));
    try {
      const r = await tpl.suggestOntologyProfile(fake.settings(), [{ content: '变压器巡检' }]);
      check('选中模型给出的体系', r.id === 'iso15926', r.id);
      check('返回体系中文名', !!r.name && r.name !== 'iso15926', r.name);
      check('similarity 钳制到 ≤100', r.similarity === 100, String(r.similarity));
      check('reason 透传', r.reason === '涉及设备与产线');
      check('prompt 列出全部可用体系', fake.requests[0].body.messages[1].content.includes('bfo-lite') && fake.requests[0].body.messages[1].content.includes('iso15926'));
    } finally { await fake.close(); }
  }
  {
    const fake = await startFakeLlm(() => json({ profile: 'not_a_profile', similarity: 50 }));
    try {
      const r = await tpl.suggestOntologyProfile(fake.settings(), [{ content: 'x' }]);
      check('非法体系回退 bfo-lite', r.id === 'bfo-lite', r.id);
      check('回退 similarity=0', r.similarity === 0);
      check('回退带说明', /回退默认体系/.test(r.reason), r.reason);
    } finally { await fake.close(); }
  }
  {
    const fake = await startFakeLlm(() => ({ status: 500, text: 'boom' }));
    try {
      const r = await tpl.suggestOntologyProfile(fake.settings({ chatRetries: 0 }), [{ content: 'x' }]);
      check('模型异常也回退默认体系（不抛错）', r.id === 'bfo-lite' && r.similarity === 0, JSON.stringify(r));
    } finally { await fake.close(); }
  }
  {
    const fake = await startFakeLlm(() => json({ profile: 'bfo' }));
    try {
      const r = await tpl.suggestOntologyProfile(fake.settings(), []);
      check('来源为空时 prompt 填「（空）」且不抛错', r.id === 'bfo' && fake.requests[0].body.messages[1].content.includes('（空）'));
    } finally { await fake.close(); }
  }

  // ================= assignDomains =================
  section('assignDomains — 逐文件归类');
  const DOMAINS = [{ name: '充电桩扩容', desc: '电力' }, { name: '资金安全', desc: '风控' }, { name: '系统迁移', desc: 'IT' }];
  {
    const fake = await startFakeLlm(() => json({
      assignments: {
        'raw/a.md': { domains: ['充电桩扩容'], confidence: 0.95 },
        'raw/b.md': { domains: ['充电桩扩容', '资金安全'], confidence: 0.7 },
      },
      unassigned: ['raw/c.md'],
    }));
    try {
      const raws = [{ rawPath: 'raw/a.md', content: '充电桩' }, { rawPath: 'raw/b.md', content: '资金' }, { rawPath: 'raw/c.md', content: '杂项' }];
      const r = await tpl.assignDomains(fake.settings(), raws, DOMAINS);
      check('单归属文件正确归类', JSON.stringify(r.assignments['raw/a.md'].domains) === JSON.stringify(['充电桩扩容']));
      check('多归属文件保留全部领域', r.assignments['raw/b.md'].domains.length === 2);
      check('置信度透传', r.assignments['raw/a.md'].confidence === 0.95);
      check('unassigned 原样返回', JSON.stringify(r.unassigned) === JSON.stringify(['raw/c.md']));
      check('prompt 含领域清单与文件清单', fake.requests[0].body.messages[1].content.includes('充电桩扩容：电力') && fake.requests[0].body.messages[1].content.includes('文件名：a.md'));
      check('prompt 强调文件名是强信号', fake.requests[0].body.messages[1].content.includes('文件名是强信号'));
    } finally { await fake.close(); }
  }
  {
    // 单领域：零请求，全部置信度 1
    const fake = await startFakeLlm(() => json({ assignments: {} }));
    try {
      const raws = [{ rawPath: 'raw/a.md', content: 'x' }, { rawPath: 'raw/b.md', content: 'y' }];
      const r = await tpl.assignDomains(fake.settings(), raws, [{ name: '唯一领域' }]);
      check('单领域不调模型', fake.requests.length === 0, String(fake.requests.length));
      check('单领域全部归该领域', Object.keys(r.assignments).length === 2 && r.assignments['raw/a.md'].domains[0] === '唯一领域');
      check('单领域置信度=1', r.assignments['raw/b.md'].confidence === 1);
      check('单领域无 unassigned', r.unassigned.length === 0);
    } finally { await fake.close(); }
  }
  {
    const fake = await startFakeLlm(() => json({ assignments: {} }));
    try {
      const raws = [{ rawPath: 'raw/a.md', content: 'x' }];
      const r1 = await tpl.assignDomains(fake.settings(), raws, []);
      check('领域清单为空 → 全部 unassigned', r1.unassigned.length === 1 && Object.keys(r1.assignments).length === 0, JSON.stringify(r1));
      const r2 = await tpl.assignDomains(fake.settings(), raws, [{ desc: '无名' }, null]);
      check('领域项缺 name 视为无效', r2.unassigned.length === 1, JSON.stringify(r2));
      check('以上均不调模型', fake.requests.length === 0, String(fake.requests.length));
    } finally { await fake.close(); }
  }
  {
    // 非法领域名剔除；剔除后为空 → unassigned；置信度非法 → 0.5；越界 → 钳制
    const fake = await startFakeLlm(() => json({
      assignments: {
        'raw/a.md': { domains: ['不存在的领域'], confidence: 0.9 },
        'raw/b.md': { domains: ['资金安全', '不存在的领域'], confidence: 'abc' },
        'raw/c.md': { domains: ['系统迁移'], confidence: 5 },
        'raw/d.md': { domains: ['系统迁移'], confidence: -3 },
        'raw/e.md': { domains: 'not-an-array', confidence: 0.9 },
      },
    }));
    try {
      const raws = ['a', 'b', 'c', 'd', 'e'].map((n) => ({ rawPath: `raw/${n}.md`, content: n }));
      const r = await tpl.assignDomains(fake.settings(), raws, DOMAINS);
      check('全非法领域名的文件进 unassigned', r.unassigned.includes('raw/a.md'), JSON.stringify(r.unassigned));
      check('部分非法时只保留合法领域', JSON.stringify(r.assignments['raw/b.md'].domains) === JSON.stringify(['资金安全']));
      check('置信度非数值 → 0.5', r.assignments['raw/b.md'].confidence === 0.5, String(r.assignments['raw/b.md'].confidence));
      check('置信度 >1 钳制到 1', r.assignments['raw/c.md'].confidence === 1);
      check('置信度 <0 钳制到 0', r.assignments['raw/d.md'].confidence === 0);
      check('domains 非数组 → unassigned', r.unassigned.includes('raw/e.md'));
    } finally { await fake.close(); }
  }
  {
    // 模型漏答的文件不能丢：未出现在 assignments/unassigned 中 → unassigned
    const fake = await startFakeLlm(() => json({ assignments: { 'raw/a.md': { domains: ['资金安全'], confidence: 0.8 } } }));
    try {
      const raws = [{ rawPath: 'raw/a.md', content: 'a' }, { rawPath: 'raw/missed.md', content: 'b' }];
      const r = await tpl.assignDomains(fake.settings(), raws, DOMAINS);
      check('模型漏答的文件进 unassigned（不丢文件）', r.unassigned.includes('raw/missed.md'), JSON.stringify(r));
      check('归类 + 未归类覆盖全部文件', Object.keys(r.assignments).length + r.unassigned.length === raws.length);
    } finally { await fake.close(); }
  }
  {
    // >20 文件分批
    const fake = await startFakeLlm(({ body }) => {
      const m = body.messages[1].content;
      const paths = [...m.matchAll(/- 路径：(\S+)/g)].map((x) => x[1]);
      const assignments = {};
      for (const p of paths) assignments[p] = { domains: ['资金安全'], confidence: 0.9 };
      return json({ assignments, unassigned: [] });
    });
    try {
      const raws = Array.from({ length: 45 }, (_, i) => ({ rawPath: `raw/f${i}.md`, content: '内容' + i }));
      const r = await tpl.assignDomains(fake.settings(), raws, DOMAINS);
      check('45 个文件分 3 批调用（BATCH=20）', fake.requests.length === 3, String(fake.requests.length));
      check('分批结果全部合并', Object.keys(r.assignments).length === 45, String(Object.keys(r.assignments).length));
      check('分批无遗漏文件', r.unassigned.length === 0);
      const sizes = fake.requests.map((q) => (q.body.messages[1].content.match(/- 路径：/g) || []).length);
      check('每批不超过 20 个文件', sizes.every((n) => n <= 20) && sizes[0] === 20, JSON.stringify(sizes));
    } finally { await fake.close(); }
  }
  {
    // 某批失败：整批进 unassigned，其余批不受影响
    const fake = await startFakeLlm(({ n, body }) => {
      if (n === 1) return { status: 500, text: 'boom' };
      const paths = [...body.messages[1].content.matchAll(/- 路径：(\S+)/g)].map((x) => x[1]);
      const assignments = {};
      for (const p of paths) assignments[p] = { domains: ['系统迁移'], confidence: 0.8 };
      return json({ assignments });
    });
    try {
      const raws = Array.from({ length: 30 }, (_, i) => ({ rawPath: `raw/g${i}.md`, content: 'c' }));
      const r = await tpl.assignDomains(fake.settings({ chatRetries: 0 }), raws, DOMAINS);
      check('失败批次整批进 unassigned', r.unassigned.length === 20, String(r.unassigned.length));
      check('成功批次正常归类', Object.keys(r.assignments).length === 10, String(Object.keys(r.assignments).length));
      check('失败不丢文件（总数守恒）', r.unassigned.length + Object.keys(r.assignments).length === 30);
      check('进 unassigned 的正是失败批的文件', r.unassigned.every((p) => Number(/g(\d+)\.md/.exec(p)[1]) < 20), r.unassigned.slice(0, 3).join(','));
    } finally { await fake.close(); }
  }
  {
    // 内容摘录截断到 600 字，且压缩空白
    const fake = await startFakeLlm(() => json({ assignments: {} }));
    try {
      await tpl.assignDomains(fake.settings(), [{ rawPath: 'raw/long.md', content: 'A'.repeat(3000) }], DOMAINS);
      const excerpt = fake.requests[0].body.messages[1].content.split('摘录：')[1].split('\n')[0];
      check('单文件摘录截断到 600 字', excerpt.length === 600 && excerpt === 'A'.repeat(600), String(excerpt.length));
      await tpl.assignDomains(fake.settings(), [{ rawPath: 'raw/ws.md', content: '首行\n\n  多行   空白  ' }], DOMAINS);
      const excerpt2 = fake.requests[1].body.messages[1].content.split('摘录：')[1].split('\n')[0];
      check('摘录内空白被压缩为单空格', excerpt2 === '首行 多行 空白', JSON.stringify(excerpt2));
      await tpl.assignDomains(fake.settings(), [{ rawPath: 'raw/e.md', content: '' }], DOMAINS);
      check('空内容标注（空）', fake.requests[2].body.messages[1].content.includes('摘录：（空）'));
    } finally { await fake.close(); }
  }
  {
    // Windows 反斜杠路径也能取到文件名
    const fake = await startFakeLlm(() => json({ assignments: {} }));
    try {
      await tpl.assignDomains(fake.settings(), [{ rawPath: 'raw\\sub\\文件.md', content: 'x' }], DOMAINS);
      check('反斜杠路径提取文件名', fake.requests[0].body.messages[1].content.includes('文件名：文件.md'), fake.requests[0].body.messages[1].content.slice(-200));
    } finally { await fake.close(); }
  }
  {
    // onDelta 透传
    const fake = await startFakeLlm(() => ({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, sse: sseText(JSON.stringify({ assignments: {} }), { reasoning: '分类思考' }) }));
    try {
      const seen = [];
      await tpl.assignDomains(fake.settings(), [{ rawPath: 'a.md', content: 'x' }, { rawPath: 'b.md', content: 'y' }], DOMAINS, (d, r) => seen.push(r));
      check('assignDomains 透传流式增量', seen.some(Boolean) && seen.some((v) => !v), JSON.stringify(seen.length));
    } finally { await fake.close(); }
  }

  // ================= generateTemplate =================
  section('generateTemplate — AI 两段式生成');
  {
    const fake = await startFakeLlm(({ n }) => (n === 1
      ? json({ id: 'charge_pile_expansion', ontologyProfile: 'iso15926', keywords: ['充电桩', '扩容'] })
      : json({ domainClasses: [{ label: '充电桩', parent: 'physical_object', desc: '充电设备' }, { label: '扩容标准', parent: 'class_of_individual', desc: '规范' }, { label: '越界类', parent: 'not_in_tree' }] })));
    try {
      const r = await tpl.generateTemplate(fake.settings(), { name: '充电桩扩容', desc: '电力设施扩容' });
      check('两次调用（先定体系再生成领域类）', fake.requests.length === 2, String(fake.requests.length));
      check('采用模型给出的英文 id', r.id === 'charge_pile_expansion', r.id);
      check('采用模型给出的体系', r.ontologyProfile === 'iso15926', r.ontologyProfile);
      check('关键词归一化', JSON.stringify(r.keywords) === JSON.stringify(['充电桩', '扩容']));
      check('合法 parent 保留', r.domainClasses.find((c) => c.key === '充电桩').parent === 'physical_object');
      check('概念类 parent 保留', r.domainClasses.find((c) => c.key === '扩容标准').parent === 'class_of_individual');
      check('非法 parent 回退到实体挂点', r.domainClasses.find((c) => c.key === '越界类').parent === 'physical_object', r.domainClasses.find((c) => c.key === '越界类').parent);
      check('领域类标记 from=custom', r.domainClasses.every((c) => c.from === 'custom'));
      check('第二次调用注入体系类树', fake.requests[1].body.messages[1].content.includes('physical_object'));
      check('生成结果不自动入库（由调用方决定保存）', !tpl.listTemplates().some((t) => t.id === 'charge_pile_expansion'));
    } finally { await fake.close(); }
  }
  {
    const fake = await startFakeLlm(({ n }) => (n === 1 ? json({ id: 'test', ontologyProfile: 'nope', keywords: '单一,关键词' }) : json({ domainClasses: [] })));
    try {
      const r = await tpl.generateTemplate(fake.settings(), { name: '示例领域' });
      check('保留字 id（test）被替换', /^domain_/.test(r.id), r.id);
      check('非法体系回退 bfo-lite', r.ontologyProfile === 'bfo-lite', r.ontologyProfile);
      check('关键词字符串也可解析', JSON.stringify(r.keywords) === JSON.stringify(['单一', '关键词']));
      check('无领域类时不报错', Array.isArray(r.domainClasses) && r.domainClasses.length === 0);
    } finally { await fake.close(); }
  }
  {
    const fake = await startFakeLlm(() => json({ id: 'x' }));
    try {
      let err = '';
      try { await tpl.generateTemplate(fake.settings(), { name: '  ' }); } catch (e) { err = e.message; }
      check('名称为空抛「请先填写名称」', err === '请先填写名称' && fake.requests.length === 0, err);
    } finally { await fake.close(); }
  }

  section('Web 桥接 → IPC → 领域模型：带名语料与判定方式');
  {
    const files = require('../src/main/raws/files');
    const originalRead = files.readRawText;
    const reads = [];
    files.readRawText = async (settings, rawPath) => {
      reads.push({ settings, rawPath });
      return '原始文件正文标记';
    };
    const domains = [{ name: '知识引擎', desc: '知识管理' }, { name: '资金安全', desc: '风控' }];
    const fake = await startFakeLlm(({ body }) => {
      const assignments = {};
      for (const m of body.messages[1].content.matchAll(/- 路径：([^\n]+)/g)) {
        assignments[m[1]] = { domains: ['知识引擎'], confidence: 0.92 };
      }
      const result = { domains, assignments, unassigned: [], name: '知识引擎', desc: '知识管理',
        profile: 'bfo-lite', template: 'equip_ops', similarity: 88 };
      return { headers: { 'Content-Type': 'text/event-stream' },
        sse: sseText(JSON.stringify(result), { reasoning: '判定思考' }) };
    });
    try {
      require('../src/main/ipc').registerIpc(() => null);
      const calls = [];
      let events;
      const web = vm.createContext({
        window: {},
        EventSource: class { constructor(url) { this.url = url; events = this; } },
        fetch: async (url, options) => {
          const channel = decodeURIComponent(url.slice('/api/call/'.length));
          const payload = JSON.parse(options.body);
          calls.push({ url, options, payload });
          const result = await env.el.invoke(channel, payload);
          return { ok: true, json: async () => ({ result }) };
        },
      });
      vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, 'web/kb-shim.js'), 'utf8'), web);
      const kb = web.window.kb;
      check('Web 暴露多领域识别与分类接口', typeof kb.tplSuggestDomains === 'function' && typeof kb.tplAssignDomains === 'function');
      check('Web 订阅统一 SSE 地址', events.url === '/api/events');
      const streams = [
        ['onTplSuggestNameChunk', 'tpl:suggest-name-chunk'],
        ['onTplSuggestDomainsChunk', 'tpl:suggest-domains-chunk'],
        ['onTplAssignDomainsChunk', 'tpl:assign-domains-chunk'],
      ].map(([method, channel]) => {
        const chunks = [];
        return { channel, chunks, off: kb[method]((chunk) => chunks.push(chunk)) };
      });
      const settings = fake.settings({ skillParse: true });
      const rel = 'AI知识引擎/AI数据知识引擎&AI知识库.md';
      const inlineSources = [{ label: rel, text: '语料正文唯一标记' }, { label: '空正文/空正文.md', text: '' }];
      const payload = { settings, rawPaths: ['raw/尚未解析.pdf'], inlineSources, judgeBy: 'name' };
      const sug = await kb.tplSuggestDomains(payload);
      const namePrompt = fake.requests.at(-1).body.messages[1].content;
      check('Web 识别请求映射正确通道与 POST', calls[0].url === '/api/call/tpl%3AsuggestDomains' && calls[0].options.method === 'POST');
      check('Web 请求完整透传带名来源与判定方式', JSON.stringify(calls[0].payload) === JSON.stringify(payload));
      check('Web 返回实际 IPC 识别结果', sug.ok && sug.domains.length === 2);
      check('仅文件名识别保留语料名与无正文来源', namePrompt.includes('AI数据知识引擎&AI知识库.md') && namePrompt.includes('空正文.md') && namePrompt.includes('尚未解析.pdf'));
      check('仅文件名不向模型发送语料正文或匿名占位名', !namePrompt.includes('语料正文唯一标记') && !namePrompt.includes('inline-text'));
      const asn = await kb.tplAssignDomains({ ...payload, domains: sug.domains });
      check('Web 分类请求映射正确通道', calls.at(-1).url === '/api/call/tpl%3AassignDomains');
      check('分类键保留完整 corpus rel 与 rawPath', asn.ok && asn.assignments['inline:' + rel]?.confidence === 0.92 && !!asn.assignments['raw/尚未解析.pdf']);
      check('仅文件名分类不丢空正文语料', !!asn.assignments['inline:空正文/空正文.md']);
      check('仅文件名识别与分类均不触发原文件解析', reads.length === 0);
      check('仅文件名分类 prompt 不带正文', !fake.requests.at(-1).body.messages[1].content.includes('语料正文唯一标记'));

      const contentPayload = { settings, inlineSources: [inlineSources[0]], judgeBy: 'content' };
      const contentResult = await kb.tplSuggestDomains(contentPayload);
      check('仅 inlineSources 也能完成内容领域识别', contentResult.ok && fake.requests.at(-1).body.messages[1].content.includes('语料正文唯一标记'));
      await kb.tplSuggestDomains({ ...contentPayload, texts: ['语料正文唯一标记', '独立兼容正文'] });
      const contentPrompt = fake.requests.at(-1).body.messages[1].content;
      check('texts 与带名来源重复正文只注入一次', contentPrompt.split('语料正文唯一标记').length === 2);
      check('texts 中独立正文仍参与识别', contentPrompt.includes('独立兼容正文'));
      const contentAsn = await kb.tplAssignDomains({ ...contentPayload, domains });
      const assignPrompt = fake.requests.at(-1).body.messages[1].content;
      check('内容分类同时传递语料名称与正文', contentAsn.ok && assignPrompt.includes('AI数据知识引擎&AI知识库.md') && assignPrompt.includes('摘录：语料正文唯一标记'));
      await kb.tplSuggestDomains({ settings, texts: ['旧调用正文'] });
      check('旧 texts-only 识别调用保持兼容', fake.requests.at(-1).body.messages[1].content.includes('旧调用正文'));

      const oldPayload = { settings, rawPaths: ['raw/旧来源.md'], texts: ['旧内联正文'] };
      const oldName = await kb.tplSuggestName(oldPayload);
      const oldProfile = await kb.tplSuggestProfile(oldPayload);
      const oldMatch = await kb.tplMatchFor(oldPayload);
      check('旧领域名/体系/模版预匹配 IPC 仍可用', oldName.ok && oldName.name === '知识引擎' && oldProfile.ok && oldProfile.id === 'bfo-lite' && oldMatch.ok && oldMatch.matched?.id === 'equip_ops');
      check('旧调用仍读取原文并禁用技能解析', reads.length === 3 && reads.every((r) => r.rawPath === 'raw/旧来源.md' && r.settings.skillParse === false));
      check('旧调用保留原文与内联正文', fake.requests.slice(-3).every((r) => r.body.messages[1].content.includes('原始文件正文标记') && r.body.messages[1].content.includes('旧内联正文')));
      check('调用者设置不被修改', settings.skillParse === true);

      const beforeEmpty = fake.requests.length;
      for (const method of ['tplSuggestDomains', 'tplAssignDomains']) {
        const empty = await kb[method]({ settings, domains, inlineSources: [{ label: rel, text: ' ' }], judgeBy: 'content' });
        check(method + ' 空正文返回结构化错误', empty.ok === false && empty.error.includes('来源内容为空'));
        const noName = await kb[method]({ settings, domains, rawPaths: [' '], inlineSources: [{ label: ' ', text: 'x' }], judgeBy: 'name' });
        check(method + ' 空文件名返回结构化错误', noName.ok === false && noName.error.includes('来源文件名为空'));
      }
      check('无有效来源不发起模型请求', fake.requests.length === beforeEmpty);
      for (const frame of env.el.sent) events.onmessage({ data: JSON.stringify({ channel: frame.channel, data: frame.payload }) });
      for (const stream of streams) {
        check(stream.channel + ' 推理与正文事件正常分发', stream.chunks.some((x) => x.reasoning) && stream.chunks.some((x) => !x.reasoning));
        const count = stream.chunks.length;
        stream.off();
        events.onmessage({ data: JSON.stringify({ channel: stream.channel, data: { text: '不应收到' } }) });
        check(stream.channel + ' 解绑后不再接收', stream.chunks.length === count);
      }
    } finally {
      files.readRawText = originalRead;
      await fake.close();
    }
  }

  summary();
})().catch((err) => {
  console.error('测试执行异常：', err);
  process.exitCode = 1;
});
