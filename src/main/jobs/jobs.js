// 作业模块：串行队列 + 阶段状态机 + 历史持久化 + 中断恢复/重试
// 说明：作业串行执行，避免多个作业并发写 wiki 文件产生冲突；历史持久化在 SQLite（common/db.js 统一引擎层）
const { saveFileSource } = require('../wiki/files');
const { saveRawSource, bundleContext, lintFromContext, describeWiki, readPage } = require('../wiki/wiki');
const { loadIngestRaws, compileIngestPlan, applyIngestPlan } = require('../wiki/ingest');
const graph = require('../graph/graph');
const db = require('../common/db');
const settings = require('../common/settings');
const notesStore = require('../notes/store');
const filesMod = require('../wiki/files');
const raws = require('../wiki/raws');
const { makeTaskTracker } = require('./tasks');
const { num } = require('../common/config');

let jobs = [];
let jobSeq = 0;
let runningJobId = null;
const jobQueue = [];

// 主窗口引用由入口注入，避免模块直接依赖窗口全局
let getWindow = () => null;
function init(windowGetter) {
  getWindow = windowGetter;
}

// 作业历史上限（settings.maxJobsHistory 可配），从持久化设置实时读取
function maxHistory() {
  return num(settings.getSettings(), 'maxJobsHistory', 50, 1, 500);
}

// ---------- 作业表数据存取（SQL 由本模块维护，引擎操作走 db 统一接口） ----------
function loadJobsFromDb() {
  return db
    .all('SELECT id, type, title, status, created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt, stages, raw_paths AS rawPaths, result, error, live_preview AS livePreview, source, tasks FROM jobs ORDER BY rowid DESC')
    .map((r) => {
      let stages = [];
      try { stages = JSON.parse(r.stages); } catch (_) {}
      let rawPaths = null;
      try { rawPaths = r.rawPaths ? JSON.parse(r.rawPaths) : null; } catch (_) {}
      let result = null;
      try { result = r.result ? JSON.parse(r.result) : null; } catch (_) {}
      let source = null;
      try { source = r.source ? JSON.parse(r.source) : null; } catch (_) {}
      let tasks = null;
      try { tasks = r.tasks ? JSON.parse(r.tasks) : null; } catch (_) {}
      return {
        id: r.id,
        type: r.type,
        title: r.title,
        status: r.status,
        createdAt: r.createdAt,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        stages,
        rawPaths,
        result,
        error: r.error || '',
        livePreview: r.livePreview || null,
        source,
        tasks,
        payload: null, // payload 仅运行期内存持有，不入库
      };
    });
}

function saveJobsToDb(list) {
  db.transaction(() => {
    db.run('DELETE FROM jobs');
    // 恢复原列表展示序（新→旧），表内按 rowid 升序存储
    for (const j of list.slice().reverse()) {
      db.run(
        'INSERT INTO jobs (id, type, title, status, created_at, started_at, finished_at, stages, raw_paths, result, error, live_preview, source, tasks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          String(j.id),
          String(j.type),
          String(j.title || ''),
          String(j.status),
          j.createdAt || 0,
          j.startedAt || 0,
          j.finishedAt || 0,
          JSON.stringify(Array.isArray(j.stages) ? j.stages : []),
          Array.isArray(j.rawPaths) ? JSON.stringify(j.rawPaths) : null,
          j.result == null ? null : JSON.stringify(j.result),
          String(j.error || ''),
          j.livePreview == null ? null : String(j.livePreview),
          j.source == null ? null : JSON.stringify(j.source),
          j.tasks == null ? null : JSON.stringify(j.tasks),
        ]
      );
    }
  });
  db.flush();
}

// 旧 wiki-jobs.json 一次性导入
function importLegacyJobs(list) {
  saveJobsToDb(list);
}

function loadJobs() {
  try {
    jobs = loadJobsFromDb();
  } catch (err) {
    console.error('作业历史读取失败:', err);
    jobs = [];
  }
  // 上次会话未完成的作业标记为中断
  let dirty = false;
  for (const job of jobs) {
    if (job.status === 'running' || job.status === 'queued') {
      job.status = 'failed';
      job.error = '应用重启导致作业中断';
      job.finishedAt = job.finishedAt || Date.now();
      dirty = true;
    }
  }
  if (dirty) persistJobs();
  // 回填吸收状态：从历史成功吸收作业恢复记录（兼容功能上线前已吸收的来源）
  try {
    const items = [];
    for (const j of jobs) {
      if (j.type === 'ingest' && j.status === 'success' && Array.isArray(j.rawPaths)) {
        for (const p of j.rawPaths) items.push({ path: p, at: j.finishedAt || Date.now(), jobId: j.id });
      }
    }
    if (items.length) raws.backfillIngested(items);
  } catch (err) {
    console.error('吸收状态回填失败:', err);
  }
}

function persistJobs() {
  try {
    // 持久化时剥离 payload（含 API 配置与全文，仅运行期内存需要）
    const slim = jobs.slice(0, maxHistory()).map((j) => ({ ...j, payload: null }));
    saveJobsToDb(slim);
  } catch (err) {
    console.error('作业持久化失败:', err);
  }
}

function emitJobs() {
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('jobs:update', jobs);
  }
}

function setStage(job, key, status, detail) {
  const idx = job.stages.findIndex((s) => s.key === key);
  if (idx === -1) return;
  // 推进到某阶段时，将之前仍处 running 的阶段收尾为 success，
  // 避免失败时只标记第一个 running 而留下后续阶段残留转圈
  if (status === 'running') {
    for (let i = 0; i < idx; i++) {
      if (job.stages[i].status === 'running') job.stages[i].status = 'success';
    }
  }
  job.stages[idx].status = status;
  if (detail !== undefined) job.stages[idx].detail = detail;
  persistJobs();
  emitJobs();
}

// ---------- 队列执行 ----------
async function pumpJobQueue() {
  if (runningJobId) return;
  const id = jobQueue.shift();
  if (!id) return;
  const job = jobs.find((j) => j.id === id);
  if (!job) return pumpJobQueue();
  runningJobId = id;
  job.status = 'running';
  job.startedAt = Date.now();
  persistJobs();
  emitJobs();
  try {
    job.result = await JOB_RUNNERS[job.type](job);
    job.status = 'success';
    // 吸收成功后记录来源，供后续重复吸收校验（local: 同时记录 mtime）
    if (job.type === 'ingest' && Array.isArray(job.rawPaths) && job.rawPaths.length) {
      try { raws.markIngested(job.rawPaths, job.id); } catch (e) { console.error('吸收状态记录失败:', e); }
    }
  } catch (err) {
    job.status = 'failed';
    job.error = err.message;
    const st = job.stages.find((s) => s.status === 'running');
    if (st) { st.status = 'failed'; st.detail = err.message; }
  }
  job.finishedAt = Date.now();
  // 保留 payload 于内存以供「原作业重试」复用（入库时 persistJobs 会剥离）
  runningJobId = null;
  persistJobs();
  emitJobs();
  pumpJobQueue();
}

// 在原作业上重置并重新入队（重试不新建作业）
function requeueJob(job, stageDefs, payload) {
  job.status = 'queued';
  job.startedAt = 0;
  job.finishedAt = 0;
  job.error = '';
  job.result = null;
  job.tasks = null;
  job.stages = stageDefs.map((s) => ({ key: s.key, name: s.name, status: 'pending', detail: '' }));
  job.payload = payload;
  jobQueue.push(job.id);
  persistJobs();
  emitJobs();
  pumpJobQueue();
  return job;
}

function submitJob(type, title, stageDefs, payload) {
  const job = {
    id: 'job-' + Date.now().toString(36) + '-' + (++jobSeq),
    type,
    title,
    status: 'queued',
    createdAt: Date.now(),
    startedAt: 0,
    finishedAt: 0,
    stages: stageDefs.map((s) => ({ key: s.key, name: s.name, status: 'pending', detail: '' })),
    payload,
    result: null,
    error: '',
  };
  jobs.unshift(job);
  if (jobs.length > maxHistory()) jobs.length = maxHistory();
  jobQueue.push(job.id);
  persistJobs();
  emitJobs();
  pumpJobQueue();
  return job;
}

// ---------- 阶段定义与执行器 ----------
// 作业阶段定义（提交与重试共用）
const INGEST_STAGES = [
  { key: 'save', name: '解析保存来源' },
  { key: 'compile', name: 'AI 编译' },
  { key: 'write', name: '落盘' },
];
const LINT_STAGES = [
  { key: 'collect', name: '收集全库' },
  { key: 'analyze', name: 'AI 体检' },
  { key: 'done', name: '报告完成' },
];
const GRAPH_STAGES = [
  { key: 'collect', name: '收集语料' },
  { key: 'extract', name: 'AI 本体抽取' },
  { key: 'save', name: '合并存图' },
];

const JOB_RUNNERS = {
  // 吸收作业：保存来源 → AI 编译 → 落盘（重试模式带 rawPaths 时跳过保存阶段）
  async ingest(job) {
    const { settings, files, url, text, title, rawPaths: reusePaths, noteSources } = job.payload;
    let rawPaths = [];
    if (Array.isArray(reusePaths) && reusePaths.length) {
      rawPaths = reusePaths.slice();
      const note = job.payload && job.payload.fromRaws
        ? `复用已保存的 ${rawPaths.length} 个 raw/ 来源（跳过解析保存）`
        : `重试模式：复用已保存的 ${rawPaths.length} 个来源`;
      setStage(job, 'save', 'success', note);
      // 重试/复用模式也构建任务列表（每个复用来源一个 task），便于展示子任务
      makeTaskTracker(job, () => { persistJobs(); emitJobs(); }).init(rawPaths.map((p) => String(p).replace(/^raw\//, '')));
    } else {
      setStage(job, 'save', 'running', '开始…');
      const total = (files ? files.length : 0) + (url || text ? 1 : 0) + (Array.isArray(noteSources) ? noteSources.length : 0);
      // 任务列表：每个来源一个独立 task，随保存进度更新（与处理顺序一致，空笔记已剔除）
      const tracker = makeTaskTracker(job, () => { persistJobs(); emitJobs(); });
      tracker.init([
        ...(files || []).map((f) => '文件·' + f.name),
        ...(url ? [String(url)] : []),
        ...(text ? ['粘贴文本'] : []),
        ...(noteSources || []).filter((ns) => (ns.content || '').trim()).map((ns) => '笔记·' + (ns.title || '')),
      ]);
      let ti = 0;
      const doneNext = () => { tracker.setDone(ti); ti++; };
      let i = 0;
      for (const f of files || []) {
        i++;
        setStage(job, 'save', 'running', `解析 ${f.name}（${i}/${total}）`);
        const res = await saveFileSource(settings, f.path);
        rawPaths.push(res.relPath);
        doneNext();
      }
      if (url || text) {
        i++;
        setStage(job, 'save', 'running', url ? `拉取网页（${i}/${total}）` : `保存文本（${i}/${total}）`);
        const res = await saveRawSource(settings, { title, content: text || '', sourceUrl: url || '', auto: true });
        rawPaths.push(res.relPath);
        doneNext();
      }
      // 集合级（全部笔记/目录）：逐篇笔记保存为 raw 来源（跳过空内容笔记）
      for (const ns of noteSources || []) {
        if (!(ns.content || '').trim()) continue;
        i++;
        setStage(job, 'save', 'running', `保存笔记「${ns.title || ''}」（${i}/${total}）`);
        const res = await saveRawSource(settings, { title: ns.title || '', content: ns.content || '', sourceUrl: '', auto: true });
        rawPaths.push(res.relPath);
        doneNext();
      }
      setStage(job, 'save', 'success', `已保存 ${rawPaths.length} 个来源到 raw/`);
    }
    job.rawPaths = rawPaths;

    setStage(job, 'compile', 'running', '模型正在阅读来源并生成页面计划（约 1–3 分钟）…');
    const aligned = Array.isArray(job.tasks) && job.tasks.length === rawPaths.length && rawPaths.length > 0;
    let touched = [];
    let pageCount = 0;
    let tplNote = '';
    if (aligned) {
      // 逐任务独立编译：每个来源一个任务，模型输出独立存到 task.output（轻量上下文提速）
      const ctx = bundleContext(settings, { includeFullPages: false });
      const ctrack = makeTaskTracker(job, () => { persistJobs(); emitJobs(); });
      ctrack.reset();
      for (let t = 0; t < job.tasks.length; t++) {
        const task = job.tasks[t];
        const rel = rawPaths[t];
        const raws = await loadIngestRaws(settings, ctx, [rel]);
        ctrack.setRunning(t);
        setStage(job, 'compile', 'running', `任务 ${task.no}/${job.tasks.length}「${task.label}」编译中…`);
        const plan = await compileIngestPlan(settings, ctx, raws, (detail, preview) => {
          if (preview !== undefined) ctrack.setOutput(t, preview);
          setStage(job, 'compile', 'running', `任务 ${task.no}「${task.label}」：${detail}`);
        }, job.payload.domainId);
        const r = applyIngestPlan(ctx, plan, raws);
        touched = touched.concat(r.touched || []);
        pageCount += Array.isArray(plan.pages) ? plan.pages.length : 0;
        if (plan.matchedTemplate) tplNote = `（领域模版：${plan.matchedTemplate}）`;
        ctrack.setDone(t);
      }
    } else {
      const ctx = bundleContext(settings, { includeFullPages: true });
      const raws = await loadIngestRaws(settings, ctx, rawPaths);
      const plan = await compileIngestPlan(settings, ctx, raws, (detail, preview) => {
        if (preview !== undefined) job.livePreview = preview;
        setStage(job, 'compile', 'running', detail);
      }, job.payload.domainId);
      delete job.livePreview;
      const r = applyIngestPlan(ctx, plan, raws);
      touched = r.touched || [];
      pageCount = Array.isArray(plan.pages) ? plan.pages.length : 0;
      if (plan.matchedTemplate) tplNote = `（领域模版：${plan.matchedTemplate}）`;
    }
    setStage(job, 'compile', 'success', `计划生成：共 ${pageCount} 个新增/更新页面${tplNote}`);

    setStage(job, 'write', 'success', `触及页面：${[...new Set(touched)].join('、') || '无'}`);
    return { touched: [...new Set(touched)], rawPaths };
  },
  // 体检作业：收集 → AI 体检 → 报告完成
  async lint(job) {
    const { settings } = job.payload;
    setStage(job, 'collect', 'running', '读取全库页面…');
    const ctx = bundleContext(settings, { includeFullPages: true });
    setStage(job, 'collect', 'success', `共收集 ${ctx.listing.split('\n').length} 个页面`);
    setStage(job, 'analyze', 'running', 'AI 正在通读全部页面（约 1–3 分钟）…');
    const report = await lintFromContext(settings, ctx);
    setStage(job, 'analyze', 'success', '报告已生成');
    setStage(job, 'done', 'success', `报告 ${report.length} 字符`);
    return { report };
  },
  // 知识图谱作业：收集语料 → AI 本体抽取 → 合并存图
  async graph(job) {
    const { settings, scope, rawPaths, domain, inlineSources, typeHints, templateName } = job.payload;
    setStage(job, 'collect', 'running', inlineSources && inlineSources.length ? `读取 ${inlineSources.length} 个笔记来源…` : (rawPaths && rawPaths.length ? `读取 ${rawPaths.length} 个原始来源…` : (domain ? `读取领域「${templateName || domain}」的 Wiki 页面…` : '读取 Wiki 页面与笔记…')));
    // wikiBundle 由 wiki 领域层提供，避免 graph 反向依赖 wiki
    const desc = describeWiki(settings);
    const wikiBundle = {
      listPages: () => (desc.pages || []).map((p) => ({ rel: p.path, title: p.title, domain: p.domain || '' })),
      readPageContent: (rel) => {
        try { return readPage(settings, rel); } catch (_) { return ''; }
      },
    };
    const res = await graph.extractGraph(settings, {
      scope,
      wikiBundle,
      rawPaths,
      domain,
      inlineSources,
      typeHints,
      domainLabel: templateName || domain,
      readRaw: (rel) => filesMod.readRawText(settings, rel).catch(() => ''),
    }, (key, detail) => {
      setStage(job, key, 'running', detail);
    }, (detail, preview) => {
      // 抽取阶段的思考/输出实时预览，随作业持久化
      if (preview !== undefined) job.livePreview = preview;
      setStage(job, 'extract', 'running', detail);
    }, (tasks) => {
      // 任务列表（每个来源一个 task）实时持久化，供作业内展示
      job.tasks = tasks.map((t) => ({ ...t }));
      persistJobs();
      emitJobs();
    });
    delete job.livePreview;
    setStage(job, 'extract', 'success', `抽取完成：${res.nodeCount} 节点 / ${res.edgeCount} 关系`);
    setStage(job, 'save', 'success', '图谱已持久化到 SQLite');
    return res;
  },
};

// ---------- 对外操作 ----------
function list() {
  return jobs;
}

// 图谱作业标题：从 raw 来源抽取时展示文件名
function rawPathsLabel(payload) {
  const list = (payload && payload.rawPaths) || [];
  if (!list.length) return '';
  return list.map((p) => String(p).replace(/^raw\//, '')).join('、').slice(0, 40);
}

// 提交作业（含标题生成与参数校验）
function submit({ type, payload }) {
  if (type === 'ingest') {
    // 重复吸收校验：已吸收且来源未变化的直接跳过（payload.force=true 可强制重新吸收）
    let skipped = [];
    if (Array.isArray(payload.rawPaths) && payload.rawPaths.length && !payload.force) {
      skipped = payload.rawPaths.filter((p) => raws.isIngestedFresh(p));
      payload = { ...payload, rawPaths: payload.rawPaths.filter((p) => !raws.isIngestedFresh(p)) };
      if (!payload.rawPaths.length) {
        return { ok: false, error: `所选 ${skipped.length} 个来源均已吸收过且未检测到修改；如需重新吸收请在确认弹窗中选择继续`, skipped };
      }
    }
    const names = [
      ...(payload.files || []).map((f) => f.name),
      ...(payload.url ? [payload.url] : []),
      ...(payload.text ? ['粘贴文本'] : []),
      // 原始文件页/重试模式直接复用已保存的 raw/ 来源
      ...(payload.rawPaths || []).map((p) => String(p).replace(/^raw\//, '')),
      ...(payload.noteSources || []).map((ns) => '笔记·' + (ns.title || '')),
    ];
    if (!names.length) return { ok: false, error: '没有可吸收的来源' };
    const isNoteColl = Array.isArray(payload.noteSources) && payload.noteSources.length;
    const title = isNoteColl
      ? `吸收·${payload.collectionLabel || '笔记 ' + payload.noteSources.length + ' 篇'}`
      : `吸收 ${names.length > 1 ? names.length + ' 个来源' : names[0]}`;
    const job = submitJob('ingest', title.slice(0, 60), INGEST_STAGES, payload);
    job.source = isNoteColl
      ? { kind: payload.collectionKind || '笔记集合', label: payload.collectionLabel || '', items: payload.noteSources.map((ns) => '笔记·' + (ns.title || '')) }
      : null;
    if (job.source) persistJobs();
    return { ok: true, id: job.id, skipped };
  }
  if (type === 'lint') {
    const job = submitJob('lint', 'Wiki 体检', LINT_STAGES, payload);
    return { ok: true, id: job.id };
  }
  if (type === 'graph') {
    let scopeLabel, source;
    if (payload.inlineSources && payload.inlineSources.length) {
      const names = payload.inlineSources.map((s) => String(s.label || '').replace(/^笔记·/, ''));
      scopeLabel = `笔记·${names[0]}`;
      source = { kind: '单个笔记', label: names[0], items: names };
    } else if (payload.rawPaths && payload.rawPaths.length) {
      scopeLabel = rawPathsLabel(payload);
      source = { kind: '原始文件', label: payload.rawPaths.join('、'), items: payload.rawPaths };
    } else if (payload.domain) {
      const tn = payload.templateName || payload.domain;
      scopeLabel = `领域·${tn}`;
      source = { kind: '领域模版', label: tn, items: [tn] };
    } else {
      // 集合类：大作业，列出成员来源（笔记标题 / Wiki 页面）作为子任务
      scopeLabel = { wiki: 'LLM Wiki', notes: '全部笔记', all: 'Wiki+笔记' }[payload.scope] || 'Wiki+笔记';
      const items = [];
      if (payload.scope !== 'wiki') for (const n of notesStore.getNotes()) items.push('笔记·' + (n.title || n.id));
      if (payload.scope !== 'notes') {
        const desc = describeWiki(settings);
        for (const p of desc.pages || []) {
          if (!p.path.endsWith('index.md') && !p.path.endsWith('log.md')) items.push('Wiki·' + (p.title || p.path));
        }
      }
      source = { kind: scopeLabel, label: `${scopeLabel}（${items.length} 个来源）`, items };
    }
    const job = submitJob('graph', `知识图谱抽取·${scopeLabel}`, GRAPH_STAGES, payload);
    job.source = source;
    persistJobs();
    return { ok: true, id: job.id };
  }
  return { ok: false, error: '未知作业类型：' + type };
}

// 删除单条终态作业
function remove(id) {
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) return { ok: false, error: '作业不存在' };
  if (jobs[idx].status === 'running' || jobs[idx].status === 'queued') {
    return { ok: false, error: '进行中的作业不能删除' };
  }
  jobs.splice(idx, 1);
  persistJobs();
  emitJobs();
  return { ok: true };
}

// 清空全部终态作业历史（保留进行中/排队中）
function clear() {
  jobs = jobs.filter((j) => j.status === 'running' || j.status === 'queued');
  persistJobs();
  emitJobs();
  return { ok: true };
}

// 重试失败作业：在原作业上重置重跑（不新建）；ingest 复用已保存的 raw/ 来源跳过解析阶段
function retry({ id, settings }) {
  const src = jobs.find((j) => j.id === id);
  if (!src) return { ok: false, error: '作业不存在' };
  if (src.status !== 'failed') return { ok: false, error: '只能重试失败的作业' };
  const base = src.payload || {};
  if (src.type === 'lint') {
    return { ok: true, id: requeueJob(src, LINT_STAGES, { settings }).id };
  }
  if (src.type === 'graph') {
    return { ok: true, id: requeueJob(src, GRAPH_STAGES, { ...base, settings }).id };
  }
  if (src.type === 'ingest') {
    if (!Array.isArray(src.rawPaths) || !src.rawPaths.length) {
      return { ok: false, error: '来源尚未保存成功，无法重试，请重新发起吸收' };
    }
    return { ok: true, id: requeueJob(src, INGEST_STAGES, { settings, rawPaths: src.rawPaths.slice(), files: [], url: '', text: '', title: base.title || src.title }).id };
  }
  return { ok: false, error: '未知作业类型：' + src.type };
}

module.exports = { init, loadJobs, list, submit, remove, clear, retry, importLegacyJobs };
