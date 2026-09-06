// 知识访问统一层测试：knowledge/knowledge.js（注册/清单/统一检索/上下文拼装/分词）
// 连带覆盖三个内置知识源：notes（notes/store.js）、graph（graph/graph.js recallFor）、raws（raws/raws.js searchRaws）
// 运行：node test/knowledge-sources.test.js
const fs = require('fs');
const path = require('path');
const { bootEnv, mkCheck, writeFile, REPO_ROOT } = require('./helpers/harness');

const { check, section, summary } = mkCheck('知识源统一层（knowledge.js）');

(async () => {
  const env = await bootEnv({ prefix: 'synapse-knowledge-' });
  const knowledge = require(path.join(REPO_ROOT, 'src/main/knowledge/knowledge'));
  const store = require(path.join(REPO_ROOT, 'src/main/notes/store'));
  const graph = require(path.join(REPO_ROOT, 'src/main/graph/graph'));
  const raws = require(path.join(REPO_ROOT, 'src/main/raws/raws'));
  const settingsMod = require(path.join(REPO_ROOT, 'src/main/common/settings'));
  const dir = env.dir;

  // ================= register / listSources =================
  section('register — 知识源接入契约');
  let e = '';
  try { knowledge.register(null); } catch (err) { e = err.message; }
  check('register(null) 抛错', /知识源接入失败/.test(e), e);
  e = '';
  try { knowledge.register({ key: 'x' }); } catch (err) { e = err.message; }
  check('缺 retrieve 抛错', /需要 \{ key, retrieve \}/.test(e), e);
  e = '';
  try { knowledge.register({ retrieve() {} }); } catch (err) { e = err.message; }
  check('缺 key 抛错', /知识源接入失败/.test(e), e);
  const before = knowledge.listSources().length;
  check('register 返回 key', knowledge.register({ key: 'probe', retrieve: async () => ({}) }) === 'probe');
  check('注册后清单 +1', knowledge.listSources().length === before + 1);
  const probe = knowledge.listSources().find((s) => s.key === 'probe');
  check('缺省 label = key', probe.label === 'probe', probe.label);
  check('缺省 icon = 📚', probe.icon === '📚', probe.icon);
  check('缺省 desc = 空串', probe.desc === '', JSON.stringify(probe.desc));
  check('重复注册同 key 覆盖不新增', knowledge.register({ key: 'probe', label: '探针2', retrieve: async () => ({}) }) === 'probe' && knowledge.listSources().length === before + 1 && knowledge.listSources().find((s) => s.key === 'probe').label === '探针2');

  section('listSources — 内置三源与排序');
  const list = knowledge.listSources();
  const keys = list.map((s) => s.key);
  check('内置 notes/graph/raws 三源', ['notes', 'graph', 'raws'].every((k) => keys.includes(k)), JSON.stringify(keys));
  check('清单只暴露 key/label/icon/desc', Object.keys(list[0]).sort().join(',') === 'desc,icon,key,label', JSON.stringify(Object.keys(list[0])));
  check('retrieve 不外泄到清单', list.every((s) => s.retrieve === undefined));
  // raws 的 uiOrder=5 应排在最前（提示词顺序 order=40 排最后，两者解耦）
  check('uiOrder 决定展示顺序：raws(5) 在 notes(20) 之前', keys.indexOf('raws') < keys.indexOf('notes'), JSON.stringify(keys));
  check('notes 在 graph 之前', keys.indexOf('notes') < keys.indexOf('graph'));
  check('各源都有展示名与图标', list.every((s) => !!s.label && !!s.icon));
  check('各源都有能力说明', ['notes', 'graph', 'raws'].every((k) => (list.find((s) => s.key === k).desc || '').length > 4));

  // ================= buildContextText / tokenize =================
  section('buildContextText — 上下文拼装');
  check('空数组 → 空串', knowledge.buildContextText([]) === '');
  check('null → 空串', knowledge.buildContextText(null) === '');
  check('标题用【】包裹', knowledge.buildContextText([{ title: '笔记检索结果', body: '正文' }]) === '【笔记检索结果】\n正文');
  check('无标题则整块直出', knowledge.buildContextText([{ body: '正文' }]) === '正文');
  check('caveat 追加在正文后', knowledge.buildContextText([{ title: 'T', body: 'B', caveat: 'C' }]) === '【T】\nB\nC');
  check('多块以空行分隔', knowledge.buildContextText([{ body: 'A' }, { body: 'B' }]) === 'A\n\nB');
  check('buildContextText 本身不过滤空白 body（过滤在 retrieve 层）', knowledge.buildContextText([{ body: 'A' }, { body: '   ' }]) === 'A\n\n   ', JSON.stringify(knowledge.buildContextText([{ body: 'A' }, { body: '   ' }])));

  section('tokenize — 中英文分词');
  const tk = (s) => knowledge.tokenize(s);
  check('英文按词切分并小写', tk('Flask Renovation').includes('flask') && tk('Flask Renovation').includes('renovation'));
  check('数字下划线保留', tk('py_3 a1').includes('py_3') && tk('py_3 a1').includes('a1'));
  check('单字符英文被丢弃（{2,}）', !tk('a b c').includes('a'));
  check('中文切二元组', tk('充电桩').includes('充电') && tk('充电桩').includes('电桩'));
  check('中文单字保留', tk('泵').includes('泵'));
  check('中文不产生三元组', !tk('充电桩').includes('充电桩'));
  check('中英混合各自处理', tk('充电桩 Flask 扩容').includes('充电') && tk('充电桩 Flask 扩容').includes('flask') && tk('充电桩 Flask 扩容').includes('扩容'));
  check('结果去重', tk('充电充电充电').filter((t) => t === '充电').length === 1);
  check('空串 → 空数组', tk('').length === 0);
  check('纯标点 → 空数组', tk('！？。，').length === 0, JSON.stringify(tk('！？。，')));
  check('非字符串入参被 String() 兜住不抛错', Array.isArray(tk(null)) && Array.isArray(tk(123)) && tk(123).includes('123'));

  // ================= retrieve — 编排语义 =================
  section('retrieve — 编排：开关、顺序、失败隔离');
  // 注册两个探针源验证编排；内置源在沙箱里都是空的，不会产生块
  knowledge.register({ key: 'probeA', label: '探针A', icon: '🅰', order: 10, retrieve: async ({ onStep }) => { if (onStep) onStep({ kind: 'thought', text: 'A跑了' }); return { block: { title: 'A块', body: 'A正文' }, cites: { notes: [{ id: 'a1' }] }, steps: [{ kind: 'thought', text: 'A跑了' }] }; } });
  knowledge.register({ key: 'probeB', label: '探针B', icon: '🅱', order: 15, retrieve: async () => ({ block: { body: 'B正文', caveat: 'B取舍' }, cites: { notes: [{ id: 'b1' }], raws: [{ path: 'p' }] } }) });
  knowledge.register({ key: 'probeBoom', label: '探针炸', icon: '💥', order: 12, retrieve: async () => { throw new Error('源内部异常'); } });
  knowledge.register({ key: 'emptyBody', label: '空正文', icon: '🈳', order: 11, retrieve: async () => ({ block: { title: '不应出现', body: '   ' }, cites: { notes: [] } }) });

  const r1 = await knowledge.retrieve({ question: '测试', enabled: { probeA: true, probeB: true, probeBoom: true, notes: false, graph: false, raws: false } });
  check('块按 order 排序拼装', r1.text === '【A块】\nA正文\n\nB正文\nB取舍', JSON.stringify(r1.text));
  check('blocks 带回来源 key', r1.blocks.map((b) => b.key).join(',') === 'probeA,probeB', JSON.stringify(r1.blocks.map((b) => b.key)));
  check('cites 按类别合并', r1.cites.notes.length === 2 && r1.cites.raws.length === 1, JSON.stringify(r1.cites));
  check('空数组 cite 不写入', !('graph' in r1.cites));

  const r2 = await knowledge.retrieve({ question: '测试', enabled: { probeA: true, probeBoom: true, probeB: false, notes: false, graph: false, raws: false } });
  check('单源抛错不影响其余源', r2.text === '【A块】\nA正文', JSON.stringify(r2.text));
  check('enabled[key]===false 才关闭（缺省视为开）', (await knowledge.retrieve({ question: '测试', enabled: { probeA: false, probeB: false, probe: false, notes: false, graph: false, raws: false, probeBoom: false } })).text === '');
  check('enabled 未列出的源默认开启', (await knowledge.retrieve({ question: '测试', enabled: { notes: false, graph: false, raws: false, probe: false, probeBoom: false } })).text.includes('B正文'));
  const rEmpty = await knowledge.retrieve({ question: '测试', enabled: { emptyBody: true, notes: false, graph: false, raws: false, probe: false, probeA: false, probeB: false, probeBoom: false } });
  check('空 body 的块被 retrieve 过滤（不产生空段）', rEmpty.blocks.length === 0 && rEmpty.text === '', JSON.stringify(rEmpty));
  check('空数组 cites 不写入结果', !('notes' in rEmpty.cites), JSON.stringify(rEmpty.cites));
  check('未传 enabled 视为全开', (await knowledge.retrieve({ question: '测试' })).blocks.length >= 2);

  const steps = [];
  await knowledge.retrieve({ question: '测试', enabled: { probeBoom: true, probeA: false, probeB: false, notes: false, graph: false, raws: false }, onStep: (s) => steps.push(s) });
  check('开跑即下发「检索X…」步骤', steps.some((s) => s.kind === 'thought' && s.text === '检索探针炸…'), JSON.stringify(steps));
  check('源失败下发跳过说明（含源名与原因）', steps.some((s) => /知识源「探针炸」检索失败：源内部异常，本轮跳过/.test(s.text)), JSON.stringify(steps.map((s) => s.text)));

  const steps2 = [];
  await knowledge.retrieve({ question: '测试', enabled: { probeA: true, probeB: false, probeBoom: false, notes: false, graph: false, raws: false }, onStep: (s) => steps2.push(s) });
  check('源内自报的步骤通过 onStep 实时下发', steps2.some((s) => s.text === 'A跑了'), JSON.stringify(steps2.map((s) => s.text)));
  const off = { probe: false, probeA: false, probeB: false, probeBoom: false, emptyBody: false, notes: false, graph: false, raws: false };
  const rNoStep = await knowledge.retrieve({ question: '测试', enabled: { ...off, probeA: true } });
  check('未传 onStep 时不抛错且正常返回块', rNoStep.text === '【A块】\nA正文', JSON.stringify(rNoStep.text));
  check('retrieve 返回值只包含 text/cites/blocks（steps 仅流式下发）', Object.keys(rNoStep).sort().join(',') === 'blocks,cites,text', JSON.stringify(Object.keys(rNoStep)));
  check('onStep 抛错被吞掉不影响检索', (await knowledge.retrieve({ question: '测试', enabled: { probeA: true, probeB: false, probeBoom: false, notes: false, graph: false, raws: false }, onStep: () => { throw new Error('UI 炸了'); } })).text === '【A块】\nA正文');
  check('retrieve 返回不抛（探针源无 block 时 text 为空串）', (await knowledge.retrieve({ question: '测试', enabled: { probe: true, probeA: false, probeB: false, probeBoom: false, notes: false, graph: false, raws: false } })).text === '');

  // ================= 内置源：notes =================
  section('内置源 notes — 关键词打分检索');
  const noteRoot = store.notesRoot();
  check('notesRoot 在数据根下', noteRoot === path.join(env.dataRoot, 'note'), noteRoot);
  const mk = (id, title, content, tags, extra) => writeFile(path.join(noteRoot, `${title}.md`), [
    '---', `id: ${id}`, `title: "${title}"`, `tags: ${JSON.stringify(tags || [])}`,
    'pinned: 0', 'favorited: 0', 'createdAt: 1700000000000', 'updatedAt: 1700000000000',
    ...(extra || []), '---', '', content,
  ].join('\n'));
  mk('n1', '充电桩扩容方案', '本文说明充电桩扩容的电力评估流程与扩容容量计算方法。', ['电力', '扩容']);
  mk('n2', '资金安全防控体系', '资金安全防控涉及账户、支付与对账三个环节。', ['资金']);
  mk('n3', '无关随笔', '今天天气不错，写点别的东西。', []);
  const notes = store.getNotes();
  check('笔记从磁盘加载', notes.length === 3, String(notes.length));
  check('frontmatter 解析出标签', notes.find((n) => n.id === 'n1').tags.join(',') === '电力,扩容');
  check('frontmatter 解析出正文', notes.find((n) => n.id === 'n2').content.includes('资金安全防控'));

  const onlyNotes = { notes: true, graph: false, raws: false, probe: false, probeA: false, probeB: false, probeBoom: false };
  const rn1 = await knowledge.retrieve({ settings: {}, question: '充电桩扩容怎么做', enabled: onlyNotes });
  check('命中的笔记进入上下文块', rn1.text.includes('【笔记检索结果】') && rn1.text.includes('充电桩扩容方案'), rn1.text.slice(0, 200));
  check('cites.notes 带回 id 与标题', rn1.cites.notes.length >= 1 && rn1.cites.notes[0].id === 'n1', JSON.stringify(rn1.cites.notes));
  check('未命中笔记不进引用', !rn1.cites.notes.some((c) => c.id === 'n3'));
  const rnSteps = [];
  await knowledge.retrieve({ settings: {}, question: '充电桩扩容怎么做', enabled: onlyNotes, onStep: (s) => rnSteps.push(s) });
  check('下发「笔记命中 N 篇」步骤', rnSteps.some((s) => /笔记命中 \d+ 篇：/.test(s.text)), JSON.stringify(rnSteps.map((s) => s.text)));

  const rn2 = await knowledge.retrieve({ settings: {}, question: '量子纠缠', enabled: onlyNotes });
  check('无命中时不产生块', rn2.text === '' && !rn2.cites.notes, JSON.stringify(rn2.text));
  const rn2Steps = [];
  await knowledge.retrieve({ settings: {}, question: '量子纠缠', enabled: onlyNotes, onStep: (s) => rn2Steps.push(s) });
  check('无命中下发「笔记无关键词命中」', rn2Steps.some((s) => s.text === '笔记无关键词命中'), JSON.stringify(rn2Steps.map((s) => s.text)));
  const rn3Steps = [];
  await knowledge.retrieve({ settings: {}, question: '！！！', enabled: onlyNotes, onStep: (s) => rn3Steps.push(s) });
  check('问题无有效关键词时跳过检索', rn3Steps.some((s) => s.text === '问题无有效关键词，跳过笔记检索'), JSON.stringify(rn3Steps.map((s) => s.text)));
  // 仅命中 1 个短词（matched<2 且 longest<4）不算证据
  const rn4 = await knowledge.retrieve({ settings: {}, question: '电力', enabled: onlyNotes });
  check('单个短词命中不构成证据（matched<2 且 longest<4）', !rn4.text.includes('充电桩扩容方案'), rn4.text.slice(0, 120));
  const rn5 = await knowledge.retrieve({ settings: {}, question: '资金安全防控', enabled: onlyNotes });
  check('长词单独命中即可召回（longest>=4）', rn5.text.includes('资金安全防控体系'), rn5.text.slice(0, 120));
  // topN 受 askNotes 控制
  for (let i = 0; i < 6; i++) mk('nx' + i, '扩容笔记' + i, '扩容 电力 内容 ' + i, []);
  const rnDefault = await knowledge.retrieve({ settings: {}, question: '扩容 电力', enabled: onlyNotes });
  check('askNotes 缺省取 4 篇', (rnDefault.cites.notes || []).length === 4, String((rnDefault.cites.notes || []).length));
  const rnTop1 = await knowledge.retrieve({ settings: { askNotes: 1 }, question: '扩容 电力', enabled: onlyNotes });
  check('askNotes=1 只取 1 篇', (rnTop1.cites.notes || []).length === 1);
  const rnTopBig = await knowledge.retrieve({ settings: { askNotes: 999 }, question: '扩容 电力', enabled: onlyNotes });
  check('askNotes 越界钳到 20', (rnTopBig.cites.notes || []).length <= 20 && (rnTopBig.cites.notes || []).length >= 7, String((rnTopBig.cites.notes || []).length));
  const rnZero = await knowledge.retrieve({ settings: { askNotes: 0 }, question: '扩容 电力', enabled: onlyNotes });
  check('askNotes=0 钳到下限 1', (rnZero.cites.notes || []).length === 1, String((rnZero.cites.notes || []).length));
  const rnNull = await knowledge.retrieve({ settings: { askNotes: null }, question: '扩容 电力', enabled: onlyNotes });
  check('askNotes=null 回退缺省 4', (rnNull.cites.notes || []).length === 4, String((rnNull.cites.notes || []).length));
  const rnStr = await knowledge.retrieve({ settings: { askNotes: '' }, question: '扩容 电力', enabled: onlyNotes });
  check('askNotes=空串 回退缺省 4', (rnStr.cites.notes || []).length === 4, String((rnStr.cites.notes || []).length));
  const longNote = 'L'.repeat(3000);
  mk('nlong', '扩容长文', '扩容 电力 ' + longNote, []);
  const rnLong = await knowledge.retrieve({ settings: { askNotes: 20 }, question: '扩容 电力', enabled: onlyNotes });
  check('笔记正文进块时截断到 1500 字', rnLong.text.includes('L'.repeat(1400)) && !rnLong.text.includes('L'.repeat(1600)), String((rnLong.text.match(/L/g) || []).length));

  // ================= 内置源：graph =================
  section('内置源 graph — 本体层召回');
  graph.saveGraph(
    [
      { id: 'g1', name: '充电桩', type: 'object', desc: '终端充电设施', profile: 'bfo-lite', domain: '' },
      { id: 'g2', name: '变压器', type: 'object', desc: '电力设备', profile: 'bfo-lite', domain: 'equip_ops' },
      { id: 'g3', name: '资金账户', type: 'information', desc: '账户信息', profile: 'iso15926', domain: '' },
    ],
    [{ id: 'e1', from: 'g1', to: 'g2', rel: '相关' }]
  );
  const g = graph.getGraph();
  check('图谱落盘可读回', g.nodes.length === 3 && g.edges.length === 1, JSON.stringify({ n: g.nodes.length, e: g.edges.length }));

  const onlyGraph = { notes: false, graph: true, raws: false, probe: false, probeA: false, probeB: false, probeBoom: false };
  const rg1 = await knowledge.retrieve({ question: '充电桩和变压器什么关系', enabled: onlyGraph });
  check('召回实体进入上下文', rg1.text.includes('充电桩') && rg1.text.includes('变压器'), rg1.text.slice(0, 200));
  check('上下文头部标注本体层', rg1.text.startsWith('【知识图谱·本体层】'), rg1.text.slice(0, 40));
  check('关系边写入实体行', /充电桩.*（关系：相关→变压器）/.test(rg1.text), rg1.text.slice(0, 200));
  check('实体行标注「体系·类型」', rg1.text.includes('[BFO Lite·object]') || rg1.text.includes('·object]'), rg1.text.slice(0, 200));
  check('cites.graph 为命中实体名', Array.isArray(rg1.cites.graph) && rg1.cites.graph.includes('充电桩'), JSON.stringify(rg1.cites.graph));
  check('未命中实体不进 cites', !rg1.cites.graph.includes('资金账户'));

  const rg2 = await knowledge.retrieve({ question: '充电桩', enabled: onlyGraph, graphProfile: 'iso15926' });
  check('graphProfile 限定体系后无命中', rg2.text === '', JSON.stringify(rg2.text));
  const rg2Steps = [];
  await knowledge.retrieve({ question: '充电桩', enabled: onlyGraph, graphProfile: 'iso15926', onStep: (s) => rg2Steps.push(s) });
  check('限定范围无命中时说明范围', rg2Steps.some((s) => /知识图谱在选定范围下无相关实体命中/.test(s.text)), JSON.stringify(rg2Steps.map((s) => s.text)));
  const rg3 = await knowledge.retrieve({ question: '资金账户', enabled: onlyGraph, graphProfile: 'iso15926' });
  check('按体系召回对应实体', rg3.text.includes('资金账户') && rg3.text.includes('体系：'), rg3.text.slice(0, 120));
  const rg4 = await knowledge.retrieve({ question: '变压器', enabled: onlyGraph, graphScope: 'bfo-lite|equip_ops' });
  check('graphScope 命中二级范围', rg4.text.includes('变压器') && rg4.text.startsWith('【知识图谱·本体层·指定图谱范围】'), rg4.text.slice(0, 60));
  const rg5 = await knowledge.retrieve({ question: '充电桩', enabled: onlyGraph, graphScope: 'bfo-lite|equip_ops' });
  check('graphScope 排除范围外实体', rg5.text === '', JSON.stringify(rg5.text));
  const rg6 = await knowledge.retrieve({ question: '充电桩', enabled: onlyGraph, graphScope: 'all', graphProfile: 'iso15926' });
  check("graphScope='all' 不生效，回落到 graphProfile", rg6.text === '', JSON.stringify(rg6.text));
  const rg7 = await knowledge.retrieve({ question: '   ', enabled: onlyGraph });
  check('空问题不召回', rg7.text === '');
  const rg8Steps = [];
  await knowledge.retrieve({ question: '量子纠缠', enabled: onlyGraph, onStep: (s) => rg8Steps.push(s) });
  check('全库无命中下发「知识图谱无相关实体命中」', rg8Steps.some((s) => s.text === '知识图谱无相关实体命中'), JSON.stringify(rg8Steps.map((s) => s.text)));

  section('graph.listGraphScopes / scopeFilter — 二级范围');
  const scopes = graph.listGraphScopes();
  check('按 profile|domain 分组', scopes.some((s) => s.id === 'bfo-lite|general') && scopes.some((s) => s.id === 'bfo-lite|equip_ops') && scopes.some((s) => s.id === 'iso15926|general'), JSON.stringify(scopes.map((s) => s.id)));
  check('空 domain 归入 general 并给中文标签', scopes.find((s) => s.id === 'bfo-lite|general').label === '通用（未匹配领域）');
  check('节点计数正确', scopes.find((s) => s.id === 'bfo-lite|general').nodeCount === 1 && scopes.find((s) => s.id === 'bfo-lite|equip_ops').nodeCount === 1, JSON.stringify(scopes.map((s) => [s.id, s.nodeCount])));
  check('边只计入两端同组的范围', scopes.find((s) => s.id === 'bfo-lite|general').edgeCount === 0 && scopes.find((s) => s.id === 'bfo-lite|equip_ops').edgeCount === 0);
  check('按节点数倒序', scopes.map((s) => s.nodeCount).every((v, i, a) => i === 0 || a[i - 1] >= v));
  check("scopeFilter('all') → null", graph.scopeFilter('all') === null && graph.scopeFilter('') === null && graph.scopeFilter(undefined) === null);
  check("scopeFilter 含 all 的多选 → null", graph.scopeFilter('bfo-lite|*,all') === null);
  const fProfile = graph.scopeFilter('bfo-lite|*');
  check('profile|* 匹配整个体系', fProfile({ profile: 'bfo-lite', domain: 'x' }) === true && fProfile({ profile: 'iso15926' }) === false);
  check('profile|* 时缺省体系按 bfo-lite', fProfile({}) === true);
  const fGeneral = graph.scopeFilter('bfo-lite|general');
  check('profile|general 只匹配无 domain 的节点', fGeneral({ profile: 'bfo-lite' }) === true && fGeneral({ profile: 'bfo-lite', domain: '  ' }) === true && fGeneral({ profile: 'bfo-lite', domain: 'equip_ops' }) === false);
  const fDomain = graph.scopeFilter('bfo-lite|equip_ops');
  check('profile|domain 精确匹配', fDomain({ profile: 'bfo-lite', domain: 'equip_ops' }) === true && fDomain({ profile: 'bfo-lite', domain: 'other' }) === false);
  const fMulti = graph.scopeFilter('bfo-lite|equip_ops, iso15926|general');
  check('多选逗号分隔取并集', fMulti({ profile: 'bfo-lite', domain: 'equip_ops' }) === true && fMulti({ profile: 'iso15926' }) === true && fMulti({ profile: 'bfo-lite' }) === false);

  // ================= 内置源：raws =================
  section('内置源 raws — 关键字（grep 式）检索');
  const wikiRoot = path.join(dir, 'wiki');
  const rawDir = path.join(wikiRoot, 'raw');
  writeFile(path.join(rawDir, '充电桩扩容.md'), '# 充电桩扩容\n\n充电桩扩容需要电力评估，扩容容量按负荷计算。');
  writeFile(path.join(rawDir, '资金制度.md'), '# 资金制度\n\n资金安全防控要求日终对账。');
  writeFile(path.join(rawDir, 'notes.txt'), 'plain text about flask renovation');
  const settings = settingsMod.getSettings();
  settings.wikiRoot = wikiRoot;
  settingsMod.saveSettings(settings);
  const listed = raws.listRaws(settings);
  check('raw/ 下文件被列举', listed.length === 3, JSON.stringify(listed.map((x) => x.name)));
  check('path 以 raw/ 开头', listed.every((x) => x.path.startsWith('raw/')), JSON.stringify(listed.map((x) => x.path)));
  check('ext 小写无点', listed.some((x) => x.ext === 'md') && listed.some((x) => x.ext === 'txt'));

  const onlyRaws = { notes: false, graph: false, raws: true, probe: false, probeA: false, probeB: false, probeBoom: false };
  const rr1 = await knowledge.retrieve({ settings, question: '充电桩扩容', enabled: onlyRaws });
  check('命中文件进入上下文块', rr1.text.includes('【原始文件关键字命中】') && rr1.text.includes('充电桩扩容.md'), rr1.text.slice(0, 200));
  check('块带 caveat（未经语义校对）', rr1.blocks[0].caveat.includes('未经语义校对'), (rr1.blocks[0].caveat || '').slice(0, 40));
  check('命中行标注命中词', /（命中：[^）]+）/.test(rr1.text), rr1.text.slice(0, 200));
  check('cites.raws 带回 path/name/strong/matched', rr1.cites.raws.length >= 1 && rr1.cites.raws[0].path === 'raw/充电桩扩容.md' && typeof rr1.cites.raws[0].strong === 'boolean' && Array.isArray(rr1.cites.raws[0].matched), JSON.stringify(rr1.cites.raws));
  const rrSteps = [];
  await knowledge.retrieve({ settings, question: '充电桩扩容', enabled: onlyRaws, onStep: (s) => rrSteps.push(s) });
  check('下发「原始文件命中 N 个（已扫 x/y）」', rrSteps.some((s) => /原始文件命中 \d+ 个（已扫 \d+\/\d+）/.test(s.text)), JSON.stringify(rrSteps.map((s) => s.text)));
  const progSteps = [];
  await knowledge.retrieve({ settings, question: '充电桩扩容', enabled: onlyRaws, onStep: (s) => progSteps.push(s) });
  check('扫描进度以 progress 类型下发', progSteps.some((s) => s.kind === 'progress' && /扫描原始文件/.test(s.text)) || progSteps.every((s) => s.kind === 'thought'), JSON.stringify(progSteps.map((s) => s.kind)));

  const rr2 = await knowledge.retrieve({ settings, question: 'flask renovation', enabled: onlyRaws });
  check('英文长词命中 txt 文件', rr2.text.includes('notes.txt'), rr2.text.slice(0, 200));
  check('长词命中记为 strong', rr2.cites.raws.find((c) => c.name === 'notes.txt').strong === true, JSON.stringify(rr2.cites.raws));
  const rr3 = await knowledge.retrieve({ settings, question: '量子纠缠', enabled: onlyRaws });
  check('无命中不产生块', rr3.text === '' && !rr3.cites.raws);
  const rr3Steps = [];
  await knowledge.retrieve({ settings, question: '量子纠缠', enabled: onlyRaws, onStep: (s) => rr3Steps.push(s) });
  check('无命中下发已扫/候选统计', rr3Steps.some((s) => /原始文件无关键字命中（已扫 \d+\/\d+）/.test(s.text)), JSON.stringify(rr3Steps.map((s) => s.text)));
  const rr4 = await knowledge.retrieve({ settings, question: '的了吗', enabled: onlyRaws });
  check('全虚词问题分词为空 → 直接返回空', rr4.text === '' && !rr4.cites.raws);

  section('raws.searchRaws — 预算、优先级与 strong 判定');
  const s1 = await raws.searchRaws(settings, '充电桩扩容', { topN: 5 });
  check('返回 hits/scanned/candidates/timedOut', Array.isArray(s1.hits) && typeof s1.scanned === 'number' && typeof s1.candidates === 'number' && s1.timedOut === false, JSON.stringify({ scanned: s1.scanned, candidates: s1.candidates }));
  check('candidates = 全部可扫来源', s1.candidates === 3, String(s1.candidates));
  check('scanned ≤ candidates', s1.scanned <= s1.candidates);
  const s2 = await raws.searchRaws(settings, '充电桩扩容', { topN: 1 });
  check('topN 限制返回条数', s2.hits.length === 1, String(s2.hits.length));
  const s3 = await raws.searchRaws(settings, '');
  check('空问题直接返回（不扫描）', s3.hits.length === 0 && s3.scanned === 0 && s3.candidates === 0);
  const s4 = await raws.searchRaws(settings, '充电桩扩容', { topN: 0 });
  check('topN=0 钳到 1', s4.hits.length === 1, String(s4.hits.length));
  const s5 = await raws.searchRaws(settings, '资金安全防控', { snippetChars: 100 });
  check('snippetChars 下限钳到 100', s5.hits.length >= 1 && s5.hits[0].snippets.join('').length <= 100, JSON.stringify(s5.hits[0] && s5.hits[0].snippets));
  check('含虚词的二元组被剔除（「对账」的「对」是停用字）', (await raws.searchRaws(settings, '资金 对账')).hits.length === 0);
  const nameHits = [];
  await raws.searchRaws(settings, '充电桩扩容', { onScan: (i) => nameHits.push(i.name) });
  check('名称命中问题的来源优先扫描', nameHits[0] === '充电桩扩容.md', JSON.stringify(nameHits));
  check('onScan 逐条上报 idx/total', nameHits.length === 3);
  const s6 = await raws.searchRaws(settings, '充电桩', { budgetMs: 500, maxBytes: 4096 });
  check('预算/体量参数不破坏结果', Array.isArray(s6.hits));
  check('hits 按分数倒序', s6.hits.every((h, i, a) => i === 0 || a[i - 1].score >= h.score));

  section('raws — 噪声文件、目录引用与吸收状态');
  check('Office 锁文件是噪声', raws.isNoiseFile('~$方案.docx') === true);
  check('macOS AppleDouble 是噪声', raws.isNoiseFile('._方案.docx') === true);
  check('LibreOffice 锁文件是噪声', raws.isNoiseFile('.~lock.方案.odt#') === true);
  check('临时扩展名是噪声', ['a.tmp', 'a.temp', 'a.crdownload', 'a.part', 'a.swp', 'a.swo', 'a.bak'].every((n) => raws.isNoiseFile(n) === true));
  check('正常文件不是噪声', raws.isNoiseFile('方案.docx') === false && raws.isNoiseFile('a.md') === false);
  check('空名是噪声', raws.isNoiseFile('') === true && raws.isNoiseFile(null) === true);
  check('DEFAULT_MAX_DIR_FILES 为正整数', Number.isInteger(raws.DEFAULT_MAX_DIR_FILES) && raws.DEFAULT_MAX_DIR_FILES > 0, String(raws.DEFAULT_MAX_DIR_FILES));
  check('dirMaxFiles 缺省取常量', raws.dirMaxFiles({}) === raws.DEFAULT_MAX_DIR_FILES, String(raws.dirMaxFiles({})));
  check('dirMaxFiles 钳到 10..100000', raws.dirMaxFiles({ rawDirMaxFiles: 1 }) === 10 && raws.dirMaxFiles({ rawDirMaxFiles: 999999 }) === 100000);
  check('dirMaxFiles 空值回退缺省', raws.dirMaxFiles({ rawDirMaxFiles: '' }) === raws.DEFAULT_MAX_DIR_FILES && raws.dirMaxFiles({ rawDirMaxFiles: null }) === raws.DEFAULT_MAX_DIR_FILES);
  const bigDir = path.join(dir, 'bigdir');
  for (let i = 0; i < 12; i++) writeFile(path.join(bigDir, `f${i}.md`), 'x');
  writeFile(path.join(bigDir, 'node_modules', 'dep.js'), 'x');
  writeFile(path.join(bigDir, '~$lock.docx'), 'x');
  check('countDirFiles 跳过 SKIP_DIRS 与噪声文件', raws.countDirFiles(bigDir, 0) === 12, String(raws.countDirFiles(bigDir, 0)));
  check('countDirFiles 达到 limit 提前停止', raws.countDirFiles(bigDir, 5) <= 7, String(raws.countDirFiles(bigDir, 5)));
  let e2 = '';
  try { await raws.addDir({ ...settings, rawDirMaxFiles: 10 }, bigDir); } catch (err) { e2 = err.message; }
  check('目录超上限时拒绝并给出可操作提示', /目录文件数超过上限/.test(e2) && /最多 10 个/.test(e2) && /单目录文件数上限/.test(e2), e2.slice(0, 120));
  check('超限目录未写入引用', !JSON.parse(env.db.getKv('raw_dir_refs') || '[]').some((d) => d.dir === path.resolve(bigDir)));
  check('缺省上限 500 时同目录可添加', (await raws.addDir(settings, bigDir)).added === 12);
  raws.removeRawDir(settings, path.resolve(bigDir));
  const okDir = await raws.addDir({ ...settings, rawDirMaxFiles: 100 }, bigDir);
  check('调高上限后可添加目录引用', okDir.added === 12, JSON.stringify(okDir));
  check('目录引用实时遍历进列表', raws.listRaws({ ...settings, rawDirMaxFiles: 100 }).some((x) => x.root === path.resolve(bigDir)));
  e2 = '';
  try { await raws.addDir(settings, path.join(dir, '不存在的目录')); } catch (err) { e2 = err.message; }
  check('目录不存在抛错', /目录不存在/.test(e2), e2);
  const rmDir = raws.removeRawDir({ ...settings, rawDirMaxFiles: 100 }, path.resolve(bigDir));
  check('解除目录引用返回 removed/hadDirRef', rmDir.hadDirRef === true && rmDir.removed === path.resolve(bigDir), JSON.stringify(rmDir));
  check('解除后不再遍历该目录', !raws.listRaws(settings).some((x) => x.root === path.resolve(bigDir)));
  e2 = '';
  try { raws.removeRawDir(settings, ''); } catch (err) { e2 = err.message; }
  check('removeRawDir 缺路径抛错', /缺少目录路径/.test(e2), e2);
  check('本机文件未被删除（只解除引用）', fs.existsSync(path.join(bigDir, 'f0.md')));

  check('urlDisplayName 取域名+末段', raws.urlDisplayName('https://example.com/a/b/文档?x=1') === 'example.com/文档', raws.urlDisplayName('https://example.com/a/b/文档?x=1'));
  check('urlDisplayName 无路径时只取域名', raws.urlDisplayName('https://example.com/') === 'example.com');
  check('urlDisplayName 非法 URL 原样返回', raws.urlDisplayName('不是链接') === '不是链接');
  e2 = '';
  try { raws.renameUrl(settings, 'https://nope.example.com', '新名'); } catch (err) { e2 = err.message; }
  check('重命名不存在的链接抛错', /链接不存在/.test(e2), e2);
  e2 = '';
  try { await raws.addUrl(settings, 'ftp://x.com'); } catch (err) { e2 = err.message; }
  check('addUrl 拒绝非 http(s)', /链接需以 http:\/\/ 或 https:\/\/ 开头/.test(e2), e2);

  check('未吸收来源 isIngestedFresh=false', raws.isIngestedFresh('raw/充电桩扩容.md') === false);
  raws.markIngested(['raw/充电桩扩容.md'], 'job-1');
  check('markIngested 后 isIngestedFresh=true', raws.isIngestedFresh('raw/充电桩扩容.md') === true);
  check('列表带回 ingested.at', raws.listRaws(settings).find((x) => x.path === 'raw/充电桩扩容.md').ingested.at > 0);
  check('未吸收来源 ingested 为 undefined', raws.listRaws(settings).find((x) => x.path === 'raw/资金制度.md').ingested === undefined);
  const localFile = path.join(dir, 'local-doc.md');
  writeFile(localFile, '本地文件');
  raws.markIngested(['local:' + localFile], 'job-2');
  check('local: 吸收后未修改 → fresh', raws.isIngestedFresh('local:' + localFile) === true);
  const future = new Date(Date.now() + 60000);
  fs.utimesSync(localFile, future, future);
  check('local: 文件被修改后 → stale', raws.isIngestedFresh('local:' + localFile) === false);
  check('列表标记 stale', (() => {
    const refs = JSON.parse(env.db.getKv('raw_refs') || '[]');
    refs.push({ path: localFile, name: 'local-doc.md', ext: 'md', size: 1, mtime: fs.statSync(localFile).mtimeMs });
    env.db.setKv('raw_refs', JSON.stringify(refs));
    env.db.flush();
    return raws.listRaws(settings).find((x) => x.path === 'local:' + localFile).ingested.stale === true;
  })());
  raws.backfillIngested([{ path: 'raw/资金制度.md', at: 123, jobId: 'old' }]);
  check('backfillIngested 回填历史吸收', raws.isIngestedFresh('raw/资金制度.md') === true);
  raws.markIngested(['raw/资金制度.md'], 'job-9');
  const atBefore = raws.listRaws(settings).find((x) => x.path === 'raw/资金制度.md').ingested.at;
  raws.backfillIngested([{ path: 'raw/资金制度.md', at: 1, jobId: 'old' }]);
  check('backfillIngested 不覆盖已有记录', raws.listRaws(settings).find((x) => x.path === 'raw/资金制度.md').ingested.at === atBefore);

  section('raws.removeRaw — 删除语义');
  e2 = '';
  try { raws.removeRaw(settings, 'local:/etc/passwd'); } catch (err) { e2 = err.message; }
  check('local: 未登记时加入排除项而非抛错', e2 === '' && JSON.parse(env.db.getKv('raw_excluded') || '[]').includes('/etc/passwd'));
  check('raw/ 下真删文件', (() => {
    writeFile(path.join(rawDir, '待删.md'), 'x');
    raws.removeRaw(settings, 'raw/待删.md');
    return !fs.existsSync(path.join(rawDir, '待删.md'));
  })());
  e2 = '';
  try { raws.removeRaw(settings, 'other/x.md'); } catch (err) { e2 = err.message; }
  check('非 raw/ 前缀拒绝删除', /仅可删除 raw\/ 下的原始来源/.test(e2), e2);
  check('url: 删除只移除引用', (() => {
    env.db.setKv('raw_url_refs', JSON.stringify([{ url: 'https://a.example.com', title: '甲', addedAt: 1 }]));
    env.db.flush();
    const out = raws.removeRaw(settings, 'url:https://a.example.com');
    return out.removed === 'url:https://a.example.com' && JSON.parse(env.db.getKv('raw_url_refs')).length === 0;
  })());
  check('url: 引用进列表且展示标题', (() => {
    env.db.setKv('raw_url_refs', JSON.stringify([{ url: 'https://b.example.com/doc', title: '乙文档', addedAt: 5 }]));
    env.db.flush();
    const it = raws.listRaws(settings).find((x) => x.path === 'url:https://b.example.com/doc');
    return !!it && it.name === '乙文档' && it.ext === 'url' && it.size === 0;
  })());
  check('占位标题回退到 URL 简名', (() => {
    env.db.setKv('raw_url_refs', JSON.stringify([{ url: 'https://c.example.com/页面', title: 'loading', addedAt: 5 }]));
    env.db.flush();
    return raws.listRaws(settings).find((x) => x.path === 'url:https://c.example.com/页面').name === 'c.example.com/页面';
  })());
  check('renameUrl 改名后列表生效', (() => {
    env.db.setKv('raw_url_refs', JSON.stringify([{ url: 'https://b.example.com/doc', title: '乙文档', addedAt: 5 }]));
    env.db.flush();
    const out = raws.renameUrl(settings, 'url:https://b.example.com/doc', '改过的名字');
    return out.title === '改过的名字' && raws.listRaws(settings).find((x) => x.path === 'url:https://b.example.com/doc').name === '改过的名字';
  })());
  check('renameUrl 传空清除自定义名（回退 URL 简名）', (() => {
    raws.renameUrl(settings, 'https://b.example.com/doc', '');
    return raws.listRaws(settings).find((x) => x.path === 'url:https://b.example.com/doc').name === 'b.example.com/doc';
  })());
  check('renameUrl 标题截断到 120 字', raws.renameUrl(settings, 'https://b.example.com/doc', '长'.repeat(200)).title.length === 120);
  env.db.setKv('raw_url_refs', JSON.stringify([]));
  env.db.flush();

  section('raws/root.safeJoin — 路径越界防护');
  const { safeJoin, rawsRoot } = require(path.join(REPO_ROOT, 'src/main/raws/root'));
  check('正常相对路径拼接', safeJoin(wikiRoot, 'raw/a.md') === path.resolve(wikiRoot, 'raw/a.md'));
  check('root 自身可通过', safeJoin(wikiRoot, '') === path.resolve(wikiRoot));
  e2 = '';
  try { safeJoin(wikiRoot, '../逃逸.md'); } catch (err) { e2 = err.message; }
  check('越界路径抛「非法路径」', /非法路径：\.\.\/逃逸\.md/.test(e2), e2);
  e2 = '';
  try { safeJoin(wikiRoot, 'raw/../../逃逸.md'); } catch (err) { e2 = err.message; }
  check('嵌套越界同样拦截', /非法路径/.test(e2), e2);
  check('rawsRoot 尊重 wikiRoot 设置', rawsRoot({ wikiRoot }) === path.resolve(wikiRoot));
  check('rawsRoot 无设置时回退数据根下 llmwiki', rawsRoot({}) === path.resolve(path.join(env.dataRoot, 'llmwiki')), rawsRoot({}));
  check('rawsRoot 相对路径被解析为绝对', path.isAbsolute(rawsRoot({ wikiRoot: 'rel/dir' })));

  summary();
})().catch((err) => {
  console.error('测试执行异常：', err);
  process.exitCode = 1;
});
