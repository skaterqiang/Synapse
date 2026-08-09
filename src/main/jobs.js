// 作业管理：串行队列 + 阶段状态机 + 历史持久化 + 中断恢复/重试
// 说明：作业串行执行，避免多个作业并发写 wiki 文件产生冲突；历史持久化在 SQLite（见 db.js）
const { saveFileSource } = require('./files');
const { saveRawSource, bundleContext, lintFromContext } = require('./wiki');
const { loadIngestRaws, compileIngestPlan, applyIngestPlan } = require('./ingest');
const db = require('./db');
const { num } = require('./config');

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
  return num(db.getSettings(), 'maxJobsHistory', 50, 1, 500);
}

function loadJobs() {
  try {
    jobs = db.getJobs();
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
}

function persistJobs() {
  try {
    // 持久化时剥离 payload（含 API 配置与全文，仅运行期内存需要）
    const slim = jobs.slice(0, maxHistory()).map((j) => ({ ...j, payload: null }));
    db.saveJobs(slim);
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
  const stage = job.stages.find((s) => s.key === key);
  if (!stage) return;
  stage.status = status;
  if (detail !== undefined) stage.detail = detail;
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
  } catch (err) {
    job.status = 'failed';
    job.error = err.message;
    const st = job.stages.find((s) => s.status === 'running');
    if (st) { st.status = 'failed'; st.detail = err.message; }
  }
  job.finishedAt = Date.now();
  job.payload = null;
  runningJobId = null;
  persistJobs();
  emitJobs();
  pumpJobQueue();
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

const JOB_RUNNERS = {
  // 吸收作业：保存来源 → AI 编译 → 落盘（重试模式带 rawPaths 时跳过保存阶段）
  async ingest(job) {
    const { settings, files, url, text, title, rawPaths: reusePaths } = job.payload;
    let rawPaths = [];
    if (Array.isArray(reusePaths) && reusePaths.length) {
      rawPaths = reusePaths.slice();
      setStage(job, 'save', 'success', `重试模式：复用已保存的 ${rawPaths.length} 个来源`);
    } else {
      setStage(job, 'save', 'running', '开始…');
      const total = (files ? files.length : 0) + (url || text ? 1 : 0);
      let i = 0;
      for (const f of files || []) {
        i++;
        setStage(job, 'save', 'running', `解析 ${f.name}（${i}/${total}）`);
        const res = await saveFileSource(settings, f.path);
        rawPaths.push(res.relPath);
      }
      if (url || text) {
        i++;
        setStage(job, 'save', 'running', url ? `拉取网页（${i}/${total}）` : `保存文本（${i}/${total}）`);
        const res = await saveRawSource(settings, { title, content: text || '', sourceUrl: url || '' });
        rawPaths.push(res.relPath);
      }
      setStage(job, 'save', 'success', `已保存 ${rawPaths.length} 个来源到 raw/`);
    }
    job.rawPaths = rawPaths;

    setStage(job, 'compile', 'running', '模型正在阅读来源并生成页面计划（约 1–3 分钟）…');
    const ctx = bundleContext(settings, { includeFullPages: true });
    const raws = loadIngestRaws(settings, ctx, rawPaths);
    const plan = await compileIngestPlan(settings, ctx, raws);
    const pageCount = Array.isArray(plan.pages) ? plan.pages.length : 0;
    setStage(job, 'compile', 'success', `计划生成：共 ${pageCount} 个新增/更新页面`);

    setStage(job, 'write', 'running', '写入页面文件、更新索引与日志…');
    const res = applyIngestPlan(ctx, plan, raws);
    setStage(job, 'write', 'success', `触及页面：${res.touched.join('、') || '无'}`);
    return { ...res, rawPaths };
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
};

// ---------- 对外操作 ----------
function list() {
  return jobs;
}

// 提交作业（含标题生成与参数校验）
function submit({ type, payload }) {
  if (type === 'ingest') {
    const names = [
      ...(payload.files || []).map((f) => f.name),
      ...(payload.url ? [payload.url] : []),
      ...(payload.text ? ['粘贴文本'] : []),
    ];
    if (!names.length) return { ok: false, error: '没有可吸收的来源' };
    const title = `吸收 ${names.length > 1 ? names.length + ' 个来源' : names[0]}`;
    const job = submitJob('ingest', title.slice(0, 60), INGEST_STAGES, payload);
    return { ok: true, id: job.id };
  }
  if (type === 'lint') {
    const job = submitJob('lint', 'Wiki 体检', LINT_STAGES, payload);
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

// 重试失败作业：lint 直接重新提交；ingest 复用已保存的 raw/ 来源跳过解析阶段
function retry({ id, settings }) {
  const src = jobs.find((j) => j.id === id);
  if (!src) return { ok: false, error: '作业不存在' };
  if (src.status !== 'failed') return { ok: false, error: '只能重试失败的作业' };
  if (src.type === 'lint') {
    const job = submitJob('lint', src.title + '（重试）', LINT_STAGES, { settings });
    return { ok: true, id: job.id };
  }
  if (src.type === 'ingest') {
    if (!Array.isArray(src.rawPaths) || !src.rawPaths.length) {
      return { ok: false, error: '来源尚未保存成功，无法重试，请重新发起吸收' };
    }
    const job = submitJob('ingest', src.title + '（重试）', INGEST_STAGES, {
      settings,
      rawPaths: src.rawPaths.slice(),
      files: [], url: '', text: '', title: src.title,
    });
    return { ok: true, id: job.id };
  }
  return { ok: false, error: '未知作业类型：' + src.type };
}

module.exports = { init, loadJobs, list, submit, remove, clear, retry };
