// 作业管理模块测试（jobs/tasks.js + jobs/jobs.js）
// 覆盖：子任务模型与跟踪器、提交/标题生成/范围留档、并发队列与阶段推进、
//      失败与部分失败语义、停止（排队中 vs 执行中）、重试与单任务重跑的范围恢复回退链、
//      历史裁剪与持久化（payload 不入库）、重启中断恢复、吸收状态回填。
// 运行：node test/jobs-tasks.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { bootEnv, mkCheck, startFakeLlm, sseText, writeFile } = require('./helpers/harness');

const { check, section, summary } = mkCheck('作业管理模块');
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const json = (obj) => ({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, sse: sseText(JSON.stringify(obj)) });

(async () => {
  const env = await bootEnv({ prefix: 'synapse-jobs-' });
  const dir = env.dir;
  const settingsMod = require('../src/main/common/settings');
  const { buildTasks, makeTaskTracker } = require('../src/main/jobs/tasks');
  const filesMod = require('../src/main/raws/files');
  const raws = require('../src/main/raws/raws');
  const graph = require('../src/main/graph/graph');
  const notesStore = require('../src/main/notes/store');
  const jobs = require('../src/main/jobs/jobs');

  // 窗口注入：捕获 jobs:update / jobs:log 推送
  const pushed = [];
  jobs.init(() => ({ isDestroyed: () => false, webContents: { send: (ch, payload) => pushed.push({ ch, payload }) } }));

  // ---------- 1. 任务模型 ----------
  section('jobs/tasks.js — 子任务模型');
  const t0 = buildTasks(['a.md', 'b.md', 'c.md']);
  check('buildTasks 编号从 1 起', t0.map((t) => t.no).join(',') === '1,2,3', JSON.stringify(t0.map((t) => t.no)));
  check('buildTasks 初始 status=pending、output 空', t0.every((t) => t.status === 'pending' && t.output === ''));
  check('buildTasks 保留标签原文', t0[1].label === 'b.md');
  check('buildTasks 空/非法入参 → 空数组', buildTasks([]).length === 0 && buildTasks(null).length === 0 && buildTasks(undefined).length === 0);

  const host = { tasks: null };
  let persists = 0;
  const tr = makeTaskTracker(host, () => { persists++; });
  tr.init(['x', 'y']);
  check('tracker.init 写入 job.tasks 并落库一次', host.tasks.length === 2 && persists === 1, String(persists));
  host.tasks[0].status = 'running'; host.tasks[0].output = '中途';
  tr.reset();
  check('tracker.reset 全部回到 pending 且清空输出', host.tasks.every((t) => t.status === 'pending' && t.output === '') && persists === 2);
  tr.setRunning(0);
  check('setRunning 只改目标项', host.tasks[0].status === 'running' && host.tasks[1].status === 'pending');
  tr.setOutput(0, '产出');
  check('setOutput 写入输出', host.tasks[0].output === '产出');
  tr.doneAt(0);
  check('doneAt(下标) 标完成', host.tasks[0].status === 'done');
  check('doneCount 统计完成数', tr.doneCount() === 1, String(tr.doneCount()));
  check('list 返回同一引用', tr.list() === host.tasks);
  const before = persists;
  tr.setRunning(99); tr.setDone(-1); tr.setOutput(7, 'x');
  check('越界下标安全忽略且不落库', persists === before && host.tasks.length === 2);
  check('未传 persist 时不抛错', (() => { const h2 = {}; makeTaskTracker(h2).init(['a']); makeTaskTracker(h2).setDone(0); return h2.tasks[0].status === 'done'; })());

  // ---------- 2. 提交与标题 ----------
  section('jobs.submit — 类型校验与标题生成');
  check('未知作业类型被拒', jobs.submit({ type: 'nope', payload: {} }).error === '未知作业类型：nope');
  check('extract-note 无来源被拒', jobs.submit({ type: 'extract-note', payload: { rawPaths: [] } }).error === '没有可提取的原始来源');
  check('extract-note 来源全为空值被拒', jobs.submit({ type: 'extract-note', payload: { rawPaths: [null, '', undefined] } }).error === '没有可提取的原始来源');

  // 准备原始来源（供 extract-note 真实跑通）
  const wiki = path.join(dir, 'wiki');
  writeFile(path.join(wiki, 'raw', '充电桩扩容方案.md'), '# 充电桩扩容\n\n变压器容量不足，需要扩容配电房并新增充电桩。');
  writeFile(path.join(wiki, 'raw', '资金安全制度.md'), '# 资金安全\n\n对账、复核、双人操作是资金安全的基本要求。');
  writeFile(path.join(wiki, 'raw', '不支持.xyz'), '二进制内容');
  const settings = { ...settingsMod.getSettings(), wikiRoot: wiki, apiKey: 'test-key', apiBaseUrl: 'about:blank', model: 'test-model', apiProvider: 'openai', maxConcurrentJobs: 2, graphConcurrency: 2, chatRetries: 0 };
  settingsMod.saveSettings(settings);

  const sub1 = jobs.submit({ type: 'extract-note', payload: { settings, rawPaths: ['raw/充电桩扩容方案.md'] } });
  check('单来源标题带文件名', sub1.ok === true && jobs.list().find((j) => j.id === sub1.id).title === '提取笔记·raw/充电桩扩容方案.md', jobs.list().find((j) => j.id === sub1.id).title);
  check('extract-note 阶段定义为 解析来源/写入笔记', jobs.list().find((j) => j.id === sub1.id).stages.map((s) => s.key).join(',') === 'extract,save');
  check('rawPaths 随作业持久化（重启可恢复范围）', jobs.list().find((j) => j.id === sub1.id).rawPaths.join(',') === 'raw/充电桩扩容方案.md');

  await tick(1500);
  const j1 = jobs.list().find((j) => j.id === sub1.id);
  check('extract-note 作业跑成功', j1.status === 'success', j1.status + ' / ' + j1.error);
  check('子任务全部完成并带落盘位置', j1.tasks.length === 1 && j1.tasks[0].status === 'done' && /已新建笔记/.test(j1.tasks[0].output), j1.tasks && j1.tasks[0].output);
  check('笔记确实写入笔记库', notesStore.getNotes().some((n) => n.title === '充电桩扩容方案'));
  check('阶段摘要说明解析方式与启用类型', /内置解析/.test(j1.stages[0].detail) && /启用类型：/.test(j1.stages[0].detail), j1.stages[0].detail);
  check('写入阶段摘要给出笔记根路径', j1.stages[1].status === 'success' && j1.stages[1].detail.includes(notesStore.notesRoot()), j1.stages[1].detail);
  check('作业进度经 jobs:update 推送', pushed.some((p) => p.ch === 'jobs:update'));
  check('提取笔记不写吸收徽标（该徽标仅由历史 ingest 作业回填）', raws.isIngestedFresh('raw/充电桩扩容方案.md') === false);

  // 多来源标题 + 类型跳过
  const sub2 = jobs.submit({ type: 'extract-note', payload: { settings, rawPaths: ['raw/资金安全制度.md', 'raw/不支持.xyz'] } });
  const j2 = jobs.list().find((j) => j.id === sub2.id);
  check('多来源标题写数量', j2.title === '提取笔记·2 个来源', j2.title);
  await tick(1500);
  check('白名单外类型被跳过而非失败', j2.status === 'success' && j2.result.skipped.length === 1 && j2.result.skipped[0].name === '不支持.xyz', JSON.stringify(j2.result && j2.result.skipped));
  check('跳过的子任务输出说明原因', /已跳过：\.xyz 不在笔记导入类型内/.test(j2.tasks[1].output), j2.tasks[1].output);
  check('阶段摘要带「按类型跳过 N 个」', /按类型跳过 1 个/.test(j2.stages[0].detail), j2.stages[0].detail);

  // 强制 MinerU 重跑标题
  const sub3 = jobs.submit({ type: 'extract-note', payload: { settings, rawPaths: ['raw/资金安全制度.md'], forceMineru: true } });
  check('forceMineru 标题带前缀', jobs.list().find((j) => j.id === sub3.id).title.startsWith('用 MinerU 重跑·'), jobs.list().find((j) => j.id === sub3.id).title);
  await tick(1200);

  // 来源不存在 → 作业失败
  const sub4 = jobs.submit({ type: 'extract-note', payload: { settings, rawPaths: ['raw/不存在.md'] } });
  await tick(800);
  const j4 = jobs.list().find((j) => j.id === sub4.id);
  check('来源不存在时作业失败并给出原因', j4.status === 'failed' && /原始来源不存在：raw\/不存在\.md/.test(j4.error), j4.error);
  check('失败阶段被标记', j4.stages.some((s) => s.status === 'failed'));

  // ---------- 3. 图谱作业 ----------
  section('jobs.submit(graph) — 范围留档与领域信息');
  const fake = await startFakeLlm(({ url, body, n }) => {
    if (url.endsWith('/chat/completions')) {
      const txt = (body.messages || []).map((m) => m.content).join('\n');
      if (/归纳领域|领域名称/.test(txt)) return json({ domains: [{ name: '电力设备', desc: '充电桩与配电' }] });
      if (/归类|分配领域/.test(txt)) return json({ assignments: [] });
      return json({ nodes: [{ name: '充电桩', type: 'object', desc: '终端充电设施' }, { name: '变压器', type: 'object', desc: '电压变换设备' }], edges: [{ from: '变压器', to: '充电桩', rel: '相关' }] });
    }
    return { status: 404, text: 'no' };
  });
  const gsettings = { ...settings, ...fake.settings(), chatRetries: 0 };

  const g1 = jobs.submit({ type: 'graph', payload: { settings: gsettings, rawPaths: ['raw/充电桩扩容方案.md'], autoDomain: false, domainId: 'general', domainLabel: '通用', ontologyProfile: 'bfo-lite' } });
  const gj1 = jobs.list().find((j) => j.id === g1.id);
  check('图谱作业标题带范围', gj1.title === '知识图谱抽取·充电桩扩容方案.md', gj1.title);
  check('图谱阶段定义为 收集/抽取/存图', gj1.stages.map((s) => s.key).join(',') === 'collect,extract,save');
  check('source.kind=原始文件 且 items 留档范围', gj1.source.kind === '原始文件' && gj1.source.items.join(',') === 'raw/充电桩扩容方案.md', JSON.stringify(gj1.source));
  check('source.domain 留档领域与类型约束', gj1.source.domain.id === 'general' && gj1.source.domain.label === '通用' && Array.isArray(gj1.source.domain.entity));
  await tick(2000);
  check('图谱作业跑成功', gj1.status === 'success', gj1.status + ' / ' + gj1.error);
  check('结果带回节点/边计数与体系名', gj1.result.nodeCount === 2 && gj1.result.edgeCount === 1 && gj1.result.profileName, JSON.stringify(gj1.result));
  check('节点确实入图', graph.getGraph().nodes.some((x) => x.name === '充电桩'));
  check('抽取阶段摘要含节点数与体系', /抽取完成：2 节点 \/ 1 关系/.test(gj1.stages[1].detail), gj1.stages[1].detail);
  check('存图阶段摘要说明已持久化', gj1.stages[2].status === 'success' && /已持久化/.test(gj1.stages[2].detail));
  check('作业 source 回写体系徽标', gj1.source.ontologyProfile === 'bfo-lite' && !!gj1.source.ontologyProfileName, JSON.stringify(gj1.source.ontologyProfile));
  check('子任务按来源建立并全部完成', gj1.tasks.length === 1 && gj1.tasks[0].status === 'done' && /【输出】/.test(gj1.tasks[0].output), gj1.tasks[0].output.slice(0, 60));
  check('livePreview 在终态前被清除', gj1.livePreview === undefined);

  // 笔记来源（inlineSources）
  const g2 = jobs.submit({ type: 'graph', payload: { settings: gsettings, inlineSources: [{ label: '笔记·充电桩扩容方案', text: '充电桩与变压器的容量匹配关系。' }], autoDomain: false } });
  const gj2 = jobs.list().find((j) => j.id === g2.id);
  check('笔记来源标题为 笔记·X', gj2.title === '知识图谱抽取·笔记·充电桩扩容方案', gj2.title);
  check('source.kind=单个笔记 且去掉「笔记·」前缀', gj2.source.kind === '单个笔记' && gj2.source.label === '充电桩扩容方案', JSON.stringify(gj2.source));
  await tick(2000);
  check('笔记来源作业跑成功', gj2.status === 'success', gj2.error);

  // 全部笔记
  const g3 = jobs.submit({ type: 'graph', payload: { settings: gsettings, autoDomain: false } });
  const gj3 = jobs.list().find((j) => j.id === g3.id);
  check('无范围时按「全部笔记」提交', gj3.title === '知识图谱抽取·全部笔记' && gj3.source.kind === '全部笔记', gj3.title);
  check('全部笔记的 items 逐条列出', gj3.source.items.length === notesStore.getNotes().length && gj3.source.items[0].startsWith('笔记·'), JSON.stringify(gj3.source.items));
  check('source.label 带来源数', new RegExp('全部笔记（' + gj3.source.items.length + ' 个来源）').test(gj3.source.label), gj3.source.label);
  await tick(2500);
  check('全部笔记作业跑成功', gj3.status === 'success', gj3.error);

  // 范围丢失守卫：占满并发槽让目标作业停在排队中，篡改其范围信息后再放行
  const hangG = await startFakeLlm(() => ({ hang: true }));
  settingsMod.saveSettings({ ...settingsMod.getSettings(), maxConcurrentJobs: 1 });
  const blocker = jobs.submit({ type: 'graph', payload: { settings: { ...gsettings, ...hangG.settings(), llmRequestTimeout: 3000 }, rawPaths: ['raw/资金安全制度.md'], autoDomain: false } });
  const lost = jobs.submit({ type: 'graph', payload: { settings: gsettings, rawPaths: ['raw/充电桩扩容方案.md'] } });
  const lj = jobs.list().find((j) => j.id === lost.id);
  await tick(300);
  check('并发槽占满时后提交的作业停在排队', lj.status === 'queued', lj.status);
  lj.payload = { settings: gsettings };   // 模拟重启：payload 与 raw_paths 列都丢了，只剩 source
  lj.rawPaths = null;
  jobs.cancel(blocker.id);
  hangG.close();
  await tick(900);
  check('范围信息全丢时明确失败而非静默扩大到全部笔记', lj.status === 'failed' && /提取范围信息丢失/.test(lj.error), lj.status + ' / ' + lj.error);
  check('前置校验失败时阶段也被标失败', lj.stages.some((s) => s.status === 'failed'), JSON.stringify(lj.stages.map((s) => s.status)));
  settingsMod.saveSettings({ ...settingsMod.getSettings(), maxConcurrentJobs: 2 });

  // 模型全批失败 → 作业失败
  const bad = await startFakeLlm(() => ({ status: 500, text: 'boom' }));
  const g4 = jobs.submit({ type: 'graph', payload: { settings: { ...settings, ...bad.settings(), chatRetries: 0 }, rawPaths: ['raw/充电桩扩容方案.md'], autoDomain: false } });
  const gj4 = jobs.list().find((j) => j.id === g4.id);
  await tick(1500);
  check('全部批次失败时作业失败', gj4.status === 'failed' && /全部 1 个来源抽取失败/.test(gj4.error), gj4.error);
  check('失败子任务标 failed 并带原因', gj4.tasks[0].status === 'failed' && /\[失败\]/.test(gj4.tasks[0].output), gj4.tasks[0].output);
  bad.close();

  // 部分失败 → warning + failedTasks
  const part = await startFakeLlm(({ n }) => (n === 1 ? { status: 500, text: 'boom' } : json({ nodes: [{ name: '配电房', type: 'object', desc: '配电场所' }], edges: [] })));
  const g5 = jobs.submit({ type: 'graph', payload: { settings: { ...settings, ...part.settings(), chatRetries: 0, graphConcurrency: 1 }, rawPaths: ['raw/充电桩扩容方案.md', 'raw/资金安全制度.md'], autoDomain: false } });
  const gj5 = jobs.list().find((j) => j.id === g5.id);
  await tick(2500);
  check('部分失败时作业为 warning', gj5.status === 'warning', gj5.status + ' / ' + gj5.error);
  check('结果携带 failedTasks（taskNo/label/error）', Array.isArray(gj5.result.failedTasks) && gj5.result.failedTasks.length === 1 && gj5.result.failedTasks[0].taskNo === 1, JSON.stringify(gj5.result && gj5.result.failedTasks));
  check('阶段摘要警示失败来源数', /⚠ 1 个来源失败/.test(gj5.stages[1].detail), gj5.stages[1].detail);
  check('成功批次仍入图', graph.getGraph().nodes.some((x) => x.name === '配电房'));
  part.close();

  // ---------- 4. 停止 ----------
  section('jobs.cancel — 停止语义');
  check('停止不存在的作业', jobs.cancel('job-nope').error === '作业不存在');
  check('停止终态作业被拒', /仅执行中\/排队中的作业可停止/.test(jobs.cancel(gj1.id).error));
  const hang = await startFakeLlm(() => ({ hang: true }));
  const h1 = jobs.submit({ type: 'graph', payload: { settings: { ...settings, ...hang.settings(), chatRetries: 0, llmRequestTimeout: 600 }, rawPaths: ['raw/充电桩扩容方案.md'], autoDomain: false } });
  const hj1 = jobs.list().find((j) => j.id === h1.id);
  await tick(400);
  check('挂起作业处于执行中', hj1.status === 'running', hj1.status);
  check('停止执行中作业返回 ok', jobs.cancel(h1.id).ok === true);
  await tick(600);
  check('停止后作业标失败且原因为手动停止', hj1.status === 'failed' && hj1.error === '用户手动停止作业', hj1.status + ' / ' + hj1.error);
  check('停止后运行中阶段被标失败', hj1.stages.some((s) => s.status === 'failed'));
  hang.close();

  // 排队中作业直接移出队列
  settingsMod.saveSettings({ ...settingsMod.getSettings(), maxConcurrentJobs: 1 });
  const hang2 = await startFakeLlm(() => ({ hang: true }));
  const s = { ...settings, ...hang2.settings(), chatRetries: 0, llmRequestTimeout: 600 };
  const q1 = jobs.submit({ type: 'graph', payload: { settings: s, rawPaths: ['raw/充电桩扩容方案.md'], autoDomain: false } });
  const q2 = jobs.submit({ type: 'graph', payload: { settings: s, rawPaths: ['raw/资金安全制度.md'], autoDomain: false } });
  await tick(300);
  const jq1 = jobs.list().find((j) => j.id === q1.id);
  const jq2 = jobs.list().find((j) => j.id === q2.id);
  check('并发上限 1 时第二个作业排队', jq1.status === 'running' && jq2.status === 'queued', jq1.status + '/' + jq2.status);
  check('停止排队中作业立即标失败', jobs.cancel(q2.id).ok === true && jq2.status === 'failed' && jq2.error === '用户手动停止作业', jq2.status);
  check('排队作业被停止后阶段标「已停止」', jq2.stages.some((st) => st.status === 'failed' && st.detail === '已停止'), JSON.stringify(jq2.stages));
  jobs.cancel(q1.id);
  await tick(600);
  hang2.close();
  settingsMod.saveSettings({ ...settingsMod.getSettings(), maxConcurrentJobs: 2 });

  // ---------- 5. 重试 ----------
  section('jobs.retry / retryTask — 范围恢复回退链');
  check('重试不存在的作业', jobs.retry({ id: 'nope', settings }).error === '作业不存在');
  check('重试非失败作业被拒', jobs.retry({ id: gj1.id, settings }).error === '只能重试失败的作业');
  check('单任务重跑：非图谱作业被拒', jobs.retryTask({ id: j4.id, taskNo: 1, settings }).error === '仅知识图谱作业支持单任务重跑');
  const hang3 = await startFakeLlm(() => ({ hang: true }));
  const busy = jobs.submit({ type: 'graph', payload: { settings: { ...settings, ...hang3.settings(), llmRequestTimeout: 600 }, rawPaths: ['raw/充电桩扩容方案.md'], autoDomain: false } });
  await tick(300);
  check('单任务重跑：作业进行中被拒', jobs.retryTask({ id: busy.id, taskNo: 1, settings }).error === '作业进行中，无法重跑单个任务');
  jobs.cancel(busy.id);
  await tick(400);
  hang3.close();
  check('单任务重跑：无任务列表被拒', (() => { const x = jobs.list().find((j) => j.type === 'graph' && j.status === 'failed' && !Array.isArray(j.tasks)); return x ? jobs.retryTask({ id: x.id, taskNo: 1, settings }).error === '该作业没有任务列表' : true; })());
  check('单任务重跑：任务号不存在被拒', jobs.retryTask({ id: gj5.id, taskNo: 99, settings }).error === '任务不存在');
  check('单任务重跑：只能重跑失败任务', jobs.retryTask({ id: gj5.id, taskNo: 2, settings }).error === '只能重跑失败的任务');

  // payload 丢失但 raw_paths 列在 → 可重试（先占满并发槽，才能观察到重置后的排队态）
  const hangR = await startFakeLlm(() => ({ hang: true }));
  settingsMod.saveSettings({ ...settingsMod.getSettings(), maxConcurrentJobs: 1 });
  const rBlocker = jobs.submit({ type: 'graph', payload: { settings: { ...gsettings, ...hangR.settings(), llmRequestTimeout: 5000 }, rawPaths: ['raw/资金安全制度.md'], autoDomain: false } });
  await tick(200);
  gj4.payload = null;
  const rt = jobs.retry({ id: gj4.id, settings: gsettings });
  check('payload 丢失时从 raw_paths 列恢复范围并重试', rt.ok === true && rt.id === gj4.id, JSON.stringify(rt));
  check('重试在原作业上重置（不新建）', jobs.list().filter((j) => j.id === gj4.id).length === 1 && gj4.status === 'queued', gj4.status);
  check('重试清空上一轮错误/结果/任务', gj4.error === '' && gj4.result === null && gj4.tasks === null, JSON.stringify([gj4.error, gj4.result, gj4.tasks]));
  check('重试后阶段全部回到 pending', gj4.stages.every((s) => s.status === 'pending' && s.detail === ''), JSON.stringify(gj4.stages.map((s) => s.status)));
  check('重试从 raw_paths 列恢复了提取范围', (gj4.payload.rawPaths || []).join(',') === 'raw/充电桩扩容方案.md', JSON.stringify(gj4.payload && gj4.payload.rawPaths));
  jobs.cancel(rBlocker.id);
  hangR.close();
  settingsMod.saveSettings({ ...settingsMod.getSettings(), maxConcurrentJobs: 2 });
  await tick(2500);
  check('重试后作业跑成功（fake LLM 仍在）', gj4.status === 'success', gj4.status + ' / ' + gj4.error);

  // payload 与 raw_paths 都丢，但 source.items 在 → 仍可恢复
  gj4.payload = null; gj4.rawPaths = null; gj4.status = 'failed'; gj4.error = 'x';
  const rt2 = jobs.retry({ id: gj4.id, settings: gsettings });
  check('再退化到 source.items 恢复范围', rt2.ok === true, JSON.stringify(rt2));
  await tick(1500);

  // 三者全丢且原本声明了范围 → 拒绝重试
  gj4.payload = null; gj4.rawPaths = null; gj4.status = 'failed';
  gj4.source = { kind: '原始文件', label: 'x', items: null };
  const rt3 = jobs.retry({ id: gj4.id, settings: gsettings });
  check('范围彻底丢失时拒绝重试而非静默全量', rt3.ok === false && /提取范围信息丢失/.test(rt3.error), JSON.stringify(rt3));
  gj4.source = { kind: '原始文件', label: 'x', items: ['raw/充电桩扩容方案.md'] };
  gj4.status = 'failed';

  // 单任务重跑
  const one = await startFakeLlm(({ n }) => json({ nodes: [{ name: '单任务重跑节点' + n, type: 'object', desc: '重跑产物' }], edges: [] }));
  gj5.tasks[0].status = 'failed';
  gj5.tasks[0].output = '旧输出';
  gj5.status = 'warning';
  const rt4 = jobs.retryTask({ id: gj5.id, taskNo: 1, settings: { ...settings, ...one.settings(), chatRetries: 0, graphConcurrency: 1 } });
  check('单任务重跑受理', rt4.ok === true && rt4.id === gj5.id, JSON.stringify(rt4));
  check('目标任务回到 pending 并追加重跑标记', gj5.tasks[0].status === 'pending' && /\[重跑\] 等待重新执行/.test(gj5.tasks[0].output), gj5.tasks[0].output);
  check('非目标任务输出被保留', /\[跳过\]|旧|【输出】/.test(gj5.tasks[1].output) || gj5.tasks[1].output.length > 0);
  check('单任务重跑携带 _retryTaskNo', gj5.payload._retryTaskNo === 1, JSON.stringify(gj5.payload._retryTaskNo));
  await tick(2500);
  check('单任务重跑后作业回到成功', gj5.status === 'success' || gj5.status === 'warning', gj5.status + ' / ' + gj5.error);
  check('重跑产物入图', graph.getGraph().nodes.some((x) => /^单任务重跑节点/.test(x.name)));
  one.close();
  fake.close();

  // ---------- 6. 删除/清空/历史 ----------
  section('jobs.remove / clear / 历史上限');
  check('删除不存在的作业', jobs.remove('nope').error === '作业不存在');
  const running = jobs.list().find((j) => j.status === 'running' || j.status === 'queued');
  check('进行中作业不可删除', running ? jobs.remove(running.id).error === '进行中的作业不能删除' : true);
  const done = jobs.list().find((j) => j.status === 'success');
  check('终态作业可删除', jobs.remove(done.id).ok === true && !jobs.list().some((j) => j.id === done.id));
  const keep = jobs.list().filter((j) => j.status === 'running' || j.status === 'queued').length;
  check('clear 只清终态作业', jobs.clear().ok === true && jobs.list().length === keep, jobs.list().length + '/' + keep);
  await tick(800);

  settingsMod.saveSettings({ ...settingsMod.getSettings(), maxJobsHistory: 3 });
  for (let i = 0; i < 5; i++) jobs.submit({ type: 'graph', payload: { settings: gsettings, inlineSources: [{ label: '笔记·裁剪' + i, text: '裁剪测试内容 ' + i }], autoDomain: false } });
  await tick(2500);
  check('历史按 maxJobsHistory 裁剪', jobs.list().length <= 3, String(jobs.list().length));
  check('裁剪保留最新作业', jobs.list()[0].title.includes('裁剪4'), jobs.list()[0].title);
  settingsMod.saveSettings({ ...settingsMod.getSettings(), maxJobsHistory: 50 });

  // ---------- 7. 持久化与重启恢复 ----------
  section('持久化与重启恢复');
  const pj = jobs.submit({ type: 'graph', payload: { settings: gsettings, rawPaths: ['raw/充电桩扩容方案.md'], autoDomain: false } });
  await tick(1500);
  const rows = env.db.all('SELECT id, type, status, stages, raw_paths, result, source, tasks, error FROM jobs ORDER BY rowid DESC');
  check('作业落库条数与内存一致', rows.length === jobs.list().length, rows.length + '/' + jobs.list().length);
  check('入库按新→旧展示序还原（表内 rowid 升序存储）', rows[0].id === jobs.list()[0].id, rows[0].id + ' vs ' + jobs.list()[0].id);
  check('payload 不入库（含 API 配置与全文）', !rows.some((r) => Object.keys(r).some((k) => /payload/i.test(k))) && !env.db.all('SELECT * FROM jobs').some((r) => JSON.stringify(r).includes('apiKey')));
  const prow = rows.find((x) => x.id === pj.id);
  check('stages/raw_paths/source 均以 JSON 存列', !!prow && Array.isArray(JSON.parse(prow.stages)) && JSON.parse(prow.raw_paths).join(',') === 'raw/充电桩扩容方案.md' && JSON.parse(prow.source).kind === '原始文件', prow && String(prow.raw_paths) + ' | ' + String(prow.source).slice(0, 60));
  check('tasks 列为 JSON 数组或 NULL', !prow || prow.tasks == null || Array.isArray(JSON.parse(prow.tasks)), String(prow && prow.tasks).slice(0, 60));
  check('脏 JSON 容错（不抛错）', (() => { env.db.run('UPDATE jobs SET stages = ?, result = ?, source = ?, tasks = ?, raw_paths = ? WHERE id = ?', ['{坏', '{坏', '{坏', '{坏', '{坏', rows[0].id]); env.db.flush(); jobs.loadJobs(); return jobs.list().length === rows.length && Array.isArray(jobs.list()[0].stages); })());

  // 重启：running/queued → failed
  env.db.run('UPDATE jobs SET status = ? WHERE id = ?', ['running', jobs.list()[0].id]);
  env.db.run('UPDATE jobs SET status = ? WHERE id = ?', ['queued', jobs.list()[1] ? jobs.list()[1].id : jobs.list()[0].id]);
  env.db.flush();
  jobs.loadJobs();
  check('重启后遗留 running 标为中断失败', jobs.list().every((j) => j.status !== 'running' && j.status !== 'queued'));
  check('中断原因写明「应用重启导致作业中断」', jobs.list().some((j) => j.error === '应用重启导致作业中断'));
  check('中断作业补 finishedAt', jobs.list().filter((j) => j.error === '应用重启导致作业中断').every((j) => j.finishedAt > 0));
  check('中断状态已回写库', env.db.all('SELECT status FROM jobs').every((r) => r.status !== 'running' && r.status !== 'queued'));
  check('loadJobs 后 payload 为 null（仅运行期持有）', jobs.list().every((j) => j.payload === null));

  // 吸收状态回填
  env.db.setKv('raw_ingested', JSON.stringify({}));
  env.db.flush();
  env.db.run('DELETE FROM jobs');
  env.db.run("INSERT INTO jobs (id, type, title, status, created_at, finished_at, stages, raw_paths, result, error) VALUES ('j-bf', 'ingest', '吸收', 'success', 1, 999, '[]', ?, NULL, '')", [JSON.stringify(['raw/充电桩扩容方案.md'])]);
  env.db.flush();
  jobs.loadJobs();
  check('从历史成功吸收作业回填吸收状态', raws.isIngestedFresh('raw/充电桩扩容方案.md') === true);
  check('回填记录带 jobId 与时间', (() => { const rec = JSON.parse(env.db.getKv('raw_ingested')); const k = Object.keys(rec).find((x) => x.endsWith('充电桩扩容方案.md')); return !!k && rec[k].jobId === 'j-bf' && rec[k].at === 999; })());

  // 日志
  section('作业实时日志');
  check('getJobLogs 未知作业返回空数组', Array.isArray(jobs.getJobLogs('nope')) && jobs.getJobLogs('nope').length === 0);
  check('日志经 jobs:log 事件推送而非并入 jobs:update', pushed.every((p) => p.ch === 'jobs:update' || p.ch === 'jobs:log'));

  summary();
})().catch((err) => {
  console.error('测试执行异常：', err);
  process.exitCode = 1;
});
