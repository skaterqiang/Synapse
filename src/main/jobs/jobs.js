// 作业模块：串行队列 + 阶段状态机 + 历史持久化 + 中断恢复/重试
// 说明：作业串行执行，避免多个作业并发写文件产生冲突；历史持久化在 SQLite（common/db.js 统一引擎层）
const path = require('path');
const { extractFileContent, canImportAsNote, noteImportExts } = require('../raws/files');
const { rawsRoot } = require('../raws/root');
const templates = require('../graph/templates');
const graph = require('../graph/graph');
const db = require('../common/db');
const settings = require('../common/settings');
const notesStore = require('../notes/store');
const filesMod = require('../raws/files');
const raws = require('../raws/raws');
const { makeTaskTracker } = require('./tasks');
const { num } = require('../common/config');
const settingsMod = require('../common/settings');

let jobs = [];
let jobSeq = 0;
// 并发执行池：runningIds 记录运行中作业，上限由设置 maxConcurrentJobs 控制
const runningIds = new Set();
const jobQueue = [];
const maxConcurrent = () => num(settingsMod.getSettings(), 'maxConcurrentJobs', 3, 1, 8);

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

// ---------- 作业实时解析日志（MinerU 子进程输出等） ----------
// 不落库、不并入 jobs:update 全量载荷：经 jobs:log 事件逐行推送，前端按作业追加渲染；
// 内存仅保留每个作业最近 300 行，作业终态后主进程侧清空（前端会话内缓存仍可查看）。
const jobLogs = new Map();
let lastLogFlush = 0;
function jobLog(job, line, replace) {
  if (!job || !line) return;
  let arr = jobLogs.get(job.id);
  if (!arr) { arr = []; jobLogs.set(job.id, arr); }
  if (replace) arr[arr.length - 1] = line; else arr.push(line);
  if (arr.length > 300) arr.splice(0, arr.length - 300);
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send('jobs:log', { id: job.id, line, replace: !!replace });
  // 低频落库：日志本身不入库，但顺带把阶段/任务状态刷盘，避免异常退出丢失进度
  const now = Date.now();
  if (now - lastLogFlush > 2000) { lastLogFlush = now; persistJobs(); }
}
function clearJobLogs(job) {
  if (job) jobLogs.delete(job.id);
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

// ---------- 作业停止 ----------
// cancel(id)：排队中 → 直接移出队列标失败；执行中 → 触发 AbortController，
// 正在进行的模型请求/MinerU 子进程被中断，runner 抛 AbortError 由 runJob 标失败（合并存图不会执行，不污染产物）
const jobCancel = new Map();
const mkAbortErr = () => Object.assign(new Error('用户手动停止作业'), { name: 'AbortError' });
function cancel(id) {
  const job = jobs.find((j) => j.id === id);
  if (!job) return { ok: false, error: '作业不存在' };
  if (job.status !== 'running' && job.status !== 'queued') return { ok: false, error: '仅执行中/排队中的作业可停止' };
  if (job.status === 'queued') {
    for (let i = jobQueue.length - 1; i >= 0; i--) if (jobQueue[i] === id) jobQueue.splice(i, 1);
    job.status = 'failed';
    job.error = '用户手动停止作业';
    job.finishedAt = Date.now();
    const st = job.stages.find((s) => s.status === 'running' || s.status === 'pending');
    if (st) { st.status = 'failed'; st.detail = '已停止'; }
    persistJobs();
    emitJobs();
    return { ok: true };
  }
  let ctrl = jobCancel.get(id);
  if (!ctrl) { ctrl = new AbortController(); jobCancel.set(id, ctrl); }
  // abort() 会同步触发在途 fetch/流的 abort 监听，个别监听器可能抛错；
  // 停止操作本身不应因下游异常而失败，更不能让异常逃进 IPC/HTTP 层打崩 Web 服务
  try { ctrl.abort(); } catch (err) { console.error('[jobs] cancel abort 异常（已忽略）:', err && err.message); }
  return { ok: true };
}

// ---------- 队列执行（可配置并发） ----------
function pumpJobQueue() {
  while (runningIds.size < maxConcurrent() && jobQueue.length) {
    const id = jobQueue.shift();
    const job = jobs.find((j) => j.id === id);
    if (!job) continue;
    runningIds.add(id);
    job.status = 'running';
    job.startedAt = Date.now();
    // 启动时预建中止控制器：runner 在启动瞬间取 signal 传给模型请求/子进程，
    // 若等 cancel() 懒建则 runner 已持有 null，停止将无法中断在途请求
    jobCancel.set(id, new AbortController());
    // 防御：runJob 内部虽有 try-catch，但异步边界（如 AbortError 在 await 链空隙触发）仍可能逃逸，
    // 这里兜底防止 UnhandledPromiseRejection 打爆日志
    runJob(job).catch((err) => console.error('[jobs] runJob 未捕获异常:', err));
  }
  persistJobs();
  emitJobs();
}

async function runJob(job) {
  try {
    job.result = await JOB_RUNNERS[job.type](job);
    // 部分任务失败：作业整体视为警告（有产出但非全量），便于用户发现并补跑失败任务
    job.status = (job.result && Array.isArray(job.result.failedTasks) && job.result.failedTasks.length) ? 'warning' : 'success';
  } catch (err) {
    job.status = 'failed';
    job.error = (err && err.name === 'AbortError') ? '用户手动停止作业' : err.message;
    // 失败阶段定位：优先标正在跑的阶段；若失败发生在任何阶段推进之前
    // （如「原始来源不存在」「提取范围信息丢失」这类前置校验），阶段全是 pending，
    // 只标作业状态会让卡片上看不出哪一步失败——此时把第一个待执行阶段标为失败
    const st = job.stages.find((s) => s.status === 'running') || job.stages.find((s) => s.status === 'pending');
    if (st) { st.status = 'failed'; st.detail = job.error; }
  }
  jobCancel.delete(job.id);
  job.finishedAt = Date.now();
  clearJobLogs(job);
  runningIds.delete(job.id);
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
    // 提取范围（raw 路径）随 raw_paths 列持久化：payload 不入库（含敏感配置），
    // 重启后重试需据此恢复范围，避免静默回退「全部笔记」
    rawPaths: Array.isArray(payload && payload.rawPaths) ? payload.rawPaths.filter(Boolean) : null,
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
const GRAPH_STAGES = [
  { key: 'collect', name: '收集语料' },
  { key: 'extract', name: 'AI 本体抽取' },
  { key: 'guard', name: '写入护栏' },
  { key: 'reason', name: '本体推理' },
  { key: 'save', name: '合并存图' },
];
const EXTRACT_NOTE_STAGES = [
  { key: 'extract', name: '解析来源' },
  { key: 'save', name: '写入笔记' },
];
// 图谱冲突修复作业：规划（dry-run 预览已在渲染层完成，这里复核）→ 逐动作施加 → 重推理验证
const GRAPH_REPAIR_STAGES = [
  { key: 'plan', name: '复核修复规划' },
  { key: 'apply', name: '施加修复动作' },
  { key: 'verify', name: '重推理验证' },
];
// 语料抽取作业（设计 §7.5）：只抽取、不入图、不写笔记——扫描来源 → 解析为 Markdown → 写入语料库
const EXTRACT_CORPUS_STAGES = [
  { key: 'scan', name: '扫描来源' },
  { key: 'parse', name: '抽取为 Markdown' },
  { key: 'write', name: '写入语料库' },
];

// 护栏拦截原因 → 中文（与 reason/guard.js 的 checkEdge verdict.reason 对齐）
const GUARD_REASON_TEXT = {
  'unknown-predicate': '谓词越界',
  'domain-violation': '定义域越界',
  'range-violation': '值域越界',
  'unknown-type': '类型越界',
};

const JOB_RUNNERS = {
  async 'extract-note'(job) {
    const { settings, rawPaths = [], forceMineru } = job.payload;
    const cancelCtrl = jobCancel.get(job.id);
    const cancelSignal = cancelCtrl ? cancelCtrl.signal : null;
    const tracker = makeTaskTracker(job, () => { persistJobs(); emitJobs(); });
    tracker.init(rawPaths.map((p) => String(p).replace(/^raw\//, '')));
    const records = raws.listRaws(settings);
    const byPath = new Map(records.map((r) => [r.path, r]));
    for (const relPath of rawPaths) {
      if (!byPath.has(String(relPath))) throw new Error('原始来源不存在：' + relPath);
    }
    const notes = [];
    const failed = [];
    const writtenPaths = []; // 每篇笔记的落盘路径（相对笔记根），用于展示写入位置
    const relNotePath = (p) => path.relative(notesStore.notesRoot(), p).split(path.sep).join('/');
    const skipped = [];   // 因类型未启用而跳过（不算失败，否则一次全目录提取会刷出几百条“失败”干扰判断）
    const allowed = noteImportExts(settings);
    // 子任务并发数按配置文件（设置→作业）里的「单作业内并发抽取数」执行（graphConcurrency，1–8，默认 3）
    const CONC = num(settings, 'graphConcurrency', 3, 1, 8);
    // 解析方式说明（设置→文档解析）：mineruMode 非 builtin 且配置了转换命令时启用 MinerU，失败自动回退内置
    const mineruOn = String((settings && settings.mineruMode) || 'auto') !== 'builtin'
      && !!String((settings && settings.mineruConvertCmd) || '').trim();
    // 该来源是否会实际尝试 MinerU：MinerU 严格只接 PDF，文本型（含 html）与其它二进制类型按设计固定走内置解析，
    // 不会调用 MinerU，也不存在「回退」一说；文案须如实区分，避免用户误以为 MinerU 失败
    const usesMineru = (name) => mineruOn && path.extname(String(name)).toLowerCase() === '.pdf';
    // 解析方式如实标注：缓存命中时带上「缓存」字样，避免用户以为本次重新跑了 MinerU
    const parseLabel = (name, used, fromCache) => {
      const suffix = fromCache ? '（缓存命中，未重跑）' : '';
      if (used === 'mineru') return `MinerU 解析${suffix}`;
      if (used === 'skill') return `技能解析${suffix}`;
      return usesMineru(name) ? `内置解析（MinerU 失败回退）${suffix}` : '内置解析';
    };
    // 回退记录：MinerU 失败静默回退内置是「笔记质量与 MinerU 测试不一致」的根因，
    // 这里逐文件收集回退原因，写入子任务输出与作业结果，前端据此展示警示与「用 MinerU 重跑」
    const fallbacks = [];
    // 解析方式计数：阶段摘要如实说明哪些来源走了 MinerU、哪些按设计走内置（文本型含 html），
    // 避免「解析方式：MinerU 解析」这类笼统表述让用户误以为文本型来源也该经 MinerU
    let mineruFiles = 0;
    let builtinOnlyFiles = 0;
    let skillFiles = 0; // 技能解析（内置解析的技能扩展层）成功产出的来源数
    // 技能解析是否就绪（设置→文档解析开关，默认开启 + 已启用技能 + 模型可用）：仅用于执行中提示
    const skillsOn = require('../skills/parse').skillParseReady(settings);
    let cursor = 0;
    let started = 0;
    const processOne = async (i) => {
      const relPath = String(rawPaths[i]);
      const record = byPath.get(relPath);
      const abs = relPath.startsWith('local:') ? relPath.slice('local:'.length) : path.join(rawsRoot(settings), relPath.replace(/^\//, ''));
      // 类型不在白名单（设置→笔记导入文件类型）：直接跳过，不去读文件也不计失败
      if (!canImportAsNote(settings, record.name)) {
        skipped.push({ path: relPath, name: record.name });
        tracker.setRunning(i);
        tracker.setOutput(i, `已跳过：${path.extname(record.name) || '无扩展名'} 不在笔记导入类型内`);
        tracker.setDone(i);
        return;
      }
      tracker.setRunning(i);
      const no = ++started;
      // 执行中需说明采用的解析方式（内置 / MinerU / 技能），便于用户判断进度与质量预期；
      // 文本型扩展（含 html）按设计固定内置解析，文案如实标注，避免误以为 MinerU 失败
      const fileMethod = forceMineru
        ? '强制 MinerU 解析（不回退）'
        : (usesMineru(record.name) ? 'MinerU 解析' : (skillsOn ? '内置解析 + 技能解析' : '内置解析（该类型不走 MinerU）'));
      setStage(job, 'extract', 'running', `解析 ${record.name}（${no}/${rawPaths.length}，并发 ${CONC}，${fileMethod}）`);
      try {
        const info = {}; // extractFileContent 经此交还本次 MinerU 转换暂存的图片目录与解析方式（并发安全，不用全局静态字段）
        // MinerU 子进程输出（含进度条 \r 刷新）经 onLog 流式接入作业「解析过程」，前端实时展示
        // noCache：提取笔记每次重新生成，不读提取缓存（缓存仅供问答扫描提速，新结果仍会落盘刷新缓存）
        const text = await extractFileContent(abs, settings, {
          forceMineru: !!forceMineru,
          noCache: true,
          info,
          signal: cancelSignal,
          onLog: (line, replace) => jobLog(job, `[${record.name}] ${line}`, replace),
        });
        const used = info.parseMethod || 'builtin';
        // 按来源类型计数（阶段摘要用）：二进制/图片型会经 MinerU（含缓存命中的 MinerU 产物），文本型（含 html）按设计固定内置
        if (!forceMineru) {
          if (used === 'skill') skillFiles++;
          else if (used === 'mineru' || usesMineru(record.name)) mineruFiles++;
          else builtinOnlyFiles++;
        }
        if (!String(text || '').trim()) throw new Error('来源内容为空');
        setStage(job, 'save', 'running', `写入笔记 ${record.name}（${no}/${rawPaths.length}）`);
        // 目录归属：仅「按目录添加」（record.root 非空）保留来源目录结构（根目录名 + 子目录）；
        // 单文件（local:）添加不再套父目录名——否则文件恰好在「Synapse」这类目录下时，笔记会多套一层
        // 以父目录命名的目录（如 D:\个人助手\Synapse\test.pdf → Synapse/ 目录），与用户「根目录添加即未分类」的直觉相悖
        const rootName = record.root ? path.basename(String(record.root).replace(/[\\/]+$/, '')) : '';
        const childDir = record.root && record.rel ? path.dirname(record.rel) : '';
        const folderRel = [rootName, childDir].filter((v) => v && v !== '.').join(path.sep);
        // 标题取文件名并解码 URL 编码（%E7%9F%A5… → 知识图谱…），与 MinerU 测试展示的文件名一致；
        // 传 relPath 作为 source：同一来源重复提取时原地更新而不新增重名笔记
        const res = notesStore.importNote(filesMod.titleFromFileName(record.name), text, folderRel, relPath);
        // MinerU 抽取的图片并入笔记附件目录，正文 images/xxx 改写为 kb-asset 绝对引用；
        // 不做这步正文图片全是坏图，与 MinerU 测试产物（自带 images/）观感差异明显
        const imgCount = filesMod.attachMineruImages(res.path, info.imagesDir);
        notes.push(res);
        writtenPaths.push(relNotePath(res.path));
        // MinerU 失败回退内置：记录原因并在子任务输出中明确警示（产物质量低于 MinerU 解析）；
        // 技能解析成功（used=skill）不算「回退内置」——它本身就是编排后的正式产物
        const fbReason = used !== 'mineru' && used !== 'skill' && mineruOn && path.extname(record.name).toLowerCase() === '.pdf'
          ? (info.externalError || 'MinerU 转换失败')
          : '';
        if (fbReason) fallbacks.push({ path: relPath, name: record.name, reason: fbReason, note: relNotePath(res.path) });
        // 子任务输出带上笔记落盘的具体位置，便于用户直接定位文件；回退时附原因警示
        tracker.setOutput(i, `${res.updated ? '已更新已有笔记' : '已新建笔记'} · ${parseLabel(record.name, used, info.fromCache)} → ${relNotePath(res.path)}${imgCount ? `（含 ${imgCount} 张图）` : ''}${fbReason ? `\n⚠ MinerU 失败已回退内置解析（${fbReason}），笔记质量可能低于 MinerU 解析，可在作业上「用 MinerU 重跑」` : ''}${used === 'skill' && info.externalError ? `\n（MinerU 失败：${info.externalError}，已改用技能解析产出）` : ''}`);
        tracker.setDone(i);
      } catch (err) {
        // AbortError（用户手动停止）必须向上传播让 runJob 捕获标记作业为已停止，
        // 吞掉会导致 worker 正常退出、Promise.all resolve，AbortError 从未被 await 的 promise 链逃逸为 UnhandledPromiseRejection
        if (err && err.name === 'AbortError') throw err;
        failed.push({ path: relPath, name: record.name, error: err.message });
        tracker.setOutput(i, '失败：' + err.message);
        tracker.setDone(i);
      }
    };
    // 并发 worker 池：单线程内 await 切换，cursor 自增同步无竞态
    const workers = Array.from({ length: Math.max(1, Math.min(CONC, rawPaths.length)) }, async () => {
      while (cursor < rawPaths.length) {
        if (cancelSignal && cancelSignal.aborted) throw mkAbortErr();
        const i = cursor++;
        await processOne(i);
      }
    });
    await Promise.all(workers);
    // 中止兜底：processOne 会吞掉单文件错误（含被停止触发的），若最后一个文件恰被中止，
    // worker 池会正常退出——这里统一判定，确保停止的作业不会误标成功
    if (cancelSignal && cancelSignal.aborted) throw mkAbortErr();
    // 没有任何来源成功写入笔记、且存在失败来源时，作业整体应记为失败（status=failed），
    // 否则 runJob 见 runner 正常返回就标 success，出现「作业成功、子任务失败」的矛盾展示
    // （强制 MinerU 重跑失败不回退内置时尤其明显）
    if (!notes.length && failed.length) {
      throw new Error(`全部 ${failed.length} 个来源解析失败：${failed[0].error}${forceMineru ? '（强制 MinerU 模式，不回退内置）' : ''}`);
    }
    const skipNote = skipped.length ? `，按类型跳过 ${skipped.length} 个` : '';
    // 解析方式如实汇总：文本型来源（md/txt/csv/html 等）按设计固定内置解析，不属于「MinerU 失败回退」；
    // 只有二进制型（pdf/docx/pptx/xlsx/图片）才经 MinerU，失败才回退。笼统写「MinerU 解析」会误导；
    // 技能解析（内置解析的技能扩展层）单独计数，用户可看出哪些来源由技能产出
    const skillNote = skillFiles ? `，技能解析 ${skillFiles} 个（技能指令 + 模型直读）` : '';
    const methodNote = forceMineru
      ? '解析方式：强制 MinerU 解析（不回退内置）'
      : (mineruOn
        ? `解析方式：MinerU 解析 ${mineruFiles} 个（仅 PDF），内置解析 ${builtinOnlyFiles} 个（非 PDF 类型按设计不走 MinerU），MinerU 失败自动回退内置${skillNote}`
        : `解析方式：内置解析${skillFiles || builtinOnlyFiles ? ` ${builtinOnlyFiles} 个${skillNote}` : ''}`);
    // 回退警示：有来源因 MinerU 失败回退内置时，阶段摘要明确提示，避免用户误以为产物与 MinerU 测试一致
    const fbNote = fallbacks.length ? `，⚠ ${fallbacks.length} 个来源 MinerU 失败回退内置` : '';
    setStage(job, 'extract', 'success', `已解析 ${notes.length} 个来源${skipNote}（${methodNote}${fbNote}，启用类型：${[...allowed].join('/')}，并发 ${CONC}）`);
    const upd = notes.filter((n) => n.updated).length;
    // 写入位置说明：单篇直接给完整路径，多篇给笔记根 + 相对路径列表（截断防刷屏）
    let locNote = '';
    if (writtenPaths.length === 1) locNote = ` → ${path.join(notesStore.notesRoot(), writtenPaths[0])}`;
    else if (writtenPaths.length > 1) locNote = ` → ${notesStore.notesRoot()} 下：${writtenPaths.slice(0, 5).join('、')}${writtenPaths.length > 5 ? ` 等 ${writtenPaths.length} 篇` : ''}`;
    setStage(job, 'save', 'success', `已写入 ${notes.length} 篇笔记${upd ? `（其中更新已有 ${upd} 篇）` : ''}${locNote}`);
    return { notes, failed, skipped, fallbacks };
  },
  // 知识图谱作业：收集语料 → AI 本体抽取 → 合并存图
  async graph(job) {
    const p = job.payload || {};
    // 重启/重试后 payload 不入库：从持久化的 raw_paths 列恢复提取范围，防止静默回退「全部笔记」
    if (!Array.isArray(p.inlineSources) && !(Array.isArray(p.rawPaths) && p.rawPaths.length) && Array.isArray(job.rawPaths) && job.rawPaths.length) {
      p.rawPaths = job.rawPaths;
      job.payload = p;
    }
    const { settings, rawPaths, inlineSources, typeHints, domainId, domainLabel, ontologyProfile, corpusRels } = p;
    // 守卫：卡片声明了原始文件/语料库范围但 payload/raw_paths 均无（历史数据异常）→ 明确失败，绝不静默扩大到全部笔记
    if (!rawPaths && !inlineSources && !corpusRels && job.source && (job.source.kind === '原始文件' || job.source.kind === '语料库')) {
      throw new Error('提取范围信息丢失（应用重启所致），请从「原始文件」/「语料库」页重新选择范围提取');
    }
    setStage(job, 'collect', 'running', corpusRels && corpusRels.length
      ? `读取 ${corpusRels.length} 篇 Markdown 语料（不重新解析原始文件）…`
      : (inlineSources && inlineSources.length ? `读取 ${inlineSources.length} 个笔记来源…` : (rawPaths && rawPaths.length ? `读取 ${rawPaths.length} 个原始来源…` : '读取全部笔记…')));
    // 单任务重跑：payload 携带 _retryTaskNo，extractGraph 仅执行该批次
    const taskFilter = typeof p._retryTaskNo === 'number' && p._retryTaskNo >= 1 ? p._retryTaskNo : undefined;
    const res = await graph.extractGraph(settings, {
      rawPaths,
      inlineSources,
      corpusRels,
      typeHints,
      domainId,
      domainLabel,
      ontologyProfile,
      signal: (jobCancel.get(job.id) || {}).signal || null,
      // 领域：只有选了"自动"时才在作业内找/建领域；用户显式指定领域（含通用）时 autoDomain=false，按其选择执行
      resolveDomain: job.payload.autoDomain === false ? undefined : (raws) => resolveAutoDomain(job, raws, 'collect'),
      readRaw: (rel) => filesMod.readRawText(settings, rel).catch(() => ''),
      taskFilter,
      // §6.7「抽取后自动推理」复选框：默认勾选，仅当用户显式取消时传 false
      autoReason: p.autoReason === false ? false : undefined,
    }, (key, detail) => {
      setStage(job, key, 'running', detail);
    }, (detail, preview) => {
      // 抽取阶段的思考/输出实时预览，随作业持久化
      if (preview !== undefined) job.livePreview = preview;
      setStage(job, 'extract', 'running', detail);
    }, (tasks) => {
      // 任务列表（每个来源一个 task）实时持久化，供作业内展示
      // 单任务重跑时：extractGraph 返回全量 tasks（非目标已标 done），
      // 但需保留原任务中成功项的历史输出，避免被「跳过」覆盖
      if (taskFilter !== undefined && Array.isArray(job.tasks) && job.tasks.length === tasks.length) {
        for (let i = 0; i < tasks.length; i++) {
          if (tasks[i].no === taskFilter) {
            // 目标任务：用新输出替换
            job.tasks[i] = { ...tasks[i] };
          }
          // 非目标任务：保留原有状态与输出（不做修改）
        }
      } else {
        job.tasks = tasks.map((t) => ({ ...t }));
      }
      persistJobs();
      emitJobs();
    });
    delete job.livePreview;
    // 体系徽标写入作业 source，供作业项展示
    job.source = { ...(job.source || {}), ontologyProfile: res.profileId, ontologyProfileName: res.profileName };
    persistJobs();
    emitJobs();
    const failNote = res.failedTasks && res.failedTasks.length
      ? `，⚠ ${res.failedTasks.length} 个来源失败（可在作业详情中单独重跑）`
      : '';
    setStage(job, 'extract', 'success', `抽取完成：${res.nodeCount} 节点 / ${res.rawEdgeCount != null ? res.rawEdgeCount : res.edgeCount} 关系（体系「${res.profileName}」）${failNote}`);
    // 护栏阶段收尾（§6.10 作业摘要行）：无拦截时也要给出「已校验」的确定态，
    // 否则用户看不出这一步是跑过了还是被跳过了
    if (res.guard && res.guard.total) {
      const why = Object.entries(res.guard.byReason || {}).map(([k, v]) => `${GUARD_REASON_TEXT[k] || k} ${v}`).join('、');
      setStage(job, 'guard', 'success', `护栏拦截 ${res.guard.total} 条越界连线（${why}），已降级为回退谓词`);
    } else {
      setStage(job, 'guard', 'success', '护栏校验通过：无越界连线');
    }
    // 推理阶段收尾
    const rr = res.reason;
    if (!rr) {
      setStage(job, 'reason', 'success', '未启用自动推理（推理层不可用或用户已关闭）');
    } else if (rr.skipped) {
      setStage(job, 'reason', 'success', `推理已跳过：${rr.error || rr.skipReason || '未知原因'}`);
    } else {
      const con = (rr.inconsistencies || []).length;
      setStage(job, 'reason', 'success', `推理完成：新增 ${rr.inferredEdges} 条推理边（${(rr.stats && rr.stats.rounds) || 0} 轮 / ${(rr.stats && rr.stats.elapsedMs) || 0} ms）${con ? `，⚠ 检出 ${con} 处语义冲突` : ''}`);
    }
    setStage(job, 'save', 'success', `图谱已持久化到 SQLite（共 ${res.edgeCount} 条边${rr && !rr.skipped && rr.inferredEdges ? `，其中 ${rr.inferredEdges} 条为推理边` : ''}）`);
    return res;
  },
  // 图谱冲突修复作业：每个修复动作一条子任务，逐条施加、逐条落库、逐条回报状态。
  // 动作清单来自渲染层「修复预览」的勾选结果（planRepairs 是 dry-run，确认后才提交作业）。
  async 'graph-repair'(job) {
    const p = job.payload || {};
    // payload 不入库：重启/重试后从持久化的 source.actions 恢复同一批动作，
    // 恢复不了就明确失败，绝不静默重新规划（用户勾选的子集会被悄悄换成全量）
    const actions = (Array.isArray(p.actions) && p.actions.length)
      ? p.actions
      : (job.source && Array.isArray(job.source.actions) ? job.source.actions : null);
    if (!actions || !actions.length) {
      throw new Error('修复动作清单丢失（应用重启所致），请在「知识图谱 → 推理」页重新规划修复');
    }
    const tracker = makeTaskTracker(job, () => { persistJobs(); emitJobs(); });
    // 单任务重跑：payload 携带 _retryTaskNo 时只重跑该动作，其余任务保留原状态与输出
    const taskFilter = typeof p._retryTaskNo === 'number' && p._retryTaskNo >= 1 ? p._retryTaskNo : undefined;
    const runIdxs = taskFilter === undefined
      ? actions.map((_, i) => i)
      : [taskFilter - 1].filter((i) => i >= 0 && i < actions.length);
    if (taskFilter === undefined) {
      tracker.init(actions.map((a) => `${a.actionZh || a.kind || '修复动作'}`));
    } else {
      if (!runIdxs.length) throw new Error('任务编号超出动作清单范围，请重新规划修复');
      const t = (job.tasks || [])[runIdxs[0]];
      if (t) { t.status = 'pending'; t.output = (t.output || '') + '\n[重跑] 等待重新执行…'; persistJobs(); emitJobs(); }
    }
    const cancelCtrl = jobCancel.get(job.id);
    const signal = cancelCtrl ? cancelCtrl.signal : null;
    // 复核阶段：按动作类型汇总，让用户在施加前看清这批动作会做什么
    const byKind = {};
    for (const i of runIdxs) { const k = actions[i].kind; byKind[k] = (byKind[k] || 0) + 1; }
    const KIND_ZH = { 'change-rel': '降级谓词', 'delete-edge': '删除边', 'delete-edges': '删除边', 'retype-node': '改节点类型' };
    const kindNote = Object.entries(byKind).map(([k, v]) => `${KIND_ZH[k] || k} ${v}`).join('、');
    setStage(job, 'plan', 'success', taskFilter === undefined
      ? `已复核 ${actions.length} 个修复动作（${kindNote}）；撤销快照将在施加前保存`
      : `单任务重跑：仅重跑动作 ${taskFilter}（${kindNote}）；其余任务产物保留`);
    setStage(job, 'apply', 'running', `施加修复动作（0/${runIdxs.length}）…`);
    let res;
    try {
      res = await graph.applyRepairsStepwise(runIdxs.map((i) => actions[i]), {
        signal,
        // 单任务重跑不覆盖撤销快照：撤销点仍指向整批修复前的原图
        snapshot: taskFilter === undefined,
        // 回调下标是本次执行批次的序号，需映射回作业任务清单里的原始下标
        onTask: (k, status, output) => {
          const i = runIdxs[k];
          if (status === 'running') { tracker.setRunning(i); return; }
          if (output !== undefined) tracker.setOutput(i, output);
          // 跳过（目标边/节点已不存在）按 extract-note 的既有约定记为 done + 输出说明，
          // 只有真正抛错的动作为 failed（前端 ✗ + 可单条重跑）
          if (status === 'failed') tracker.setFailed(i); else tracker.setDone(i);
        },
        onProgress: (done, total) => setStage(job, 'apply', 'running', `施加修复动作（${done}/${total}）…`),
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        // 用户停止：已施加的动作每步都已落库，如实告知并给出撤销入口；后续阶段不再执行
        const pt = err.partial || {};
        setStage(job, 'apply', 'failed', `已停止：${pt.applied || 0} 个动作已应用并落库（可在「推理」页「撤销上次修复」整体回退）`);
        setStage(job, 'verify', 'failed', '已停止，未重推理验证');
      }
      throw err;
    }
    const failNote = (res.failedTasks || []).length ? `，⚠ ${res.failedTasks.length} 个动作失败` : '';
    const skipNote = (res.skipped || []).length ? `，${res.skipped.length} 个跳过（目标已不存在）` : '';
    setStage(job, 'apply', 'success', `已应用 ${res.applied}/${runIdxs.length} 个动作${skipNote}${failNote}；图谱现为 ${res.nodes} 节点 / ${res.edges} 边`);
    const rr = res.rerun;
    if (!rr) {
      setStage(job, 'verify', 'success', '未重推理验证');
    } else if (rr.skipped) {
      setStage(job, 'verify', 'success', `重推理已跳过：${rr.error || '未知原因'}（剩余冲突数未验证）`);
    } else {
      setStage(job, 'verify', 'success', `重推理完成：剩余冲突 ${rr.inconsistencies != null ? rr.inconsistencies : '?'} 处，推理边 ${rr.inferredEdges || 0} 条`);
    }
    // 施加结果回写作业卡片（source 持久化），历史里能看到这批动作实际打了多少
    job.source = { ...(job.source || {}), applied: res.applied, skippedCount: (res.skipped || []).length };
    persistJobs();
    emitJobs();
    return res;
  },
  // 语料抽取作业（设计 §7.5）：走 CORPUS_RECIPE 流水线，只解析落盘为 corpus/**/*.md，不入图、不写笔记。
  // 产物是可人工审阅的 Markdown 中间件，审阅后可单独提交 graph 作业（此时 Source 用 CorpusFileSource，零解析开销）。
  async 'extract-corpus'(job) {
    const p = job.payload || {};
    // payload 不入库：重启/重试后从持久化的 raw_paths 列恢复抽取范围
    if (!(Array.isArray(p.rawPaths) && p.rawPaths.length) && Array.isArray(job.rawPaths) && job.rawPaths.length) {
      p.rawPaths = job.rawPaths; job.payload = p;
    }
    const { settings, rawPaths = [], force } = p;
    if (!rawPaths.length) throw new Error('没有可抽取的原始来源');
    const signal = (jobCancel.get(job.id) || {}).signal || null;
    // 子任务（P13：以来源为单位）：标签取 rawPath 去掉 raw/ 前缀，与 extract-note 同口径
    const tracker = makeTaskTracker(job, () => { persistJobs(); emitJobs(); });
    tracker.init(rawPaths.map((pp) => String(pp).replace(/^raw\//, '')));
    // origin.path → 任务下标（RawFileSource 产出的 item.origin.path 与 rawPath 同形）
    const taskByPath = new Map(rawPaths.map((pp, i) => [String(pp), i]));
    const single = typeof p._retryTaskNo === 'number' && p._retryTaskNo >= 1 ? p._retryTaskNo : null;
    let runPaths = rawPaths;
    if (single !== null) {
      for (let i = 0; i < (job.tasks || []).length; i++) {
        if (i !== single - 1) { job.tasks[i].status = 'done'; job.tasks[i].output = (job.tasks[i].output || '') + '\n[跳过] 本次为单任务重跑'; }
      }
      runPaths = rawPaths.filter((pp) => taskByPath.get(String(pp)) === single - 1);
    }
    setStage(job, 'scan', 'success', `共 ${runPaths.length} 个来源待抽取为语料${force ? '（强制重新解析）' : ''}`);
    setStage(job, 'parse', 'running', '解析来源为 Markdown…');

    const { drive, makeContext } = require('../corpus/drive');
    const { buildPipeline } = require('../corpus/build');
    const { CORPUS_RECIPE } = require('../corpus/recipes');
    let done = 0;
    const ctx = makeContext({
      settings, signal, rawPaths: runPaths, forceMineru: !!force,
      payload: p, skillName: p.skillName || '',
      onLog: (line, replace) => jobLog(job, line, replace),
      onStage: (key, status, detail) => { if (key === 'parse' || key === 'write') setStage(job, key, 'running', detail); },
      onItem: (item) => {
        done++;
        setStage(job, 'parse', 'running', `已抽取 ${item.label}（${done}/${runPaths.length}）`);
        const idx = taskByPath.get(String((item.origin && item.origin.path) || ''));
        if (idx != null) {
          const rel = (item.meta && item.meta.corpusFile) || '';
          tracker.setOutput(idx, rel ? `已写入语料库 → ${rel}` : '已解析（未落盘）');
          tracker.setDone(idx);
        }
      },
      shared: {},
    });
    const res = await drive(buildPipeline(CORPUS_RECIPE, ctx), ctx);
    if (signal && signal.aborted) throw mkAbortErr();

    // 对账：未到达 onItem 的任务 = 被过滤（白名单）或解析失败
    const errByPath = new Map();
    for (const e of (ctx.errors || [])) errByPath.set(String(e.label || ''), String(e.error || ''));
    const stats = (res && res.stats) || {};
    let failedCount = 0;
    for (let i = 0; i < (job.tasks || []).length; i++) {
      const t = job.tasks[i];
      if (t.status === 'done' || t.status === 'failed') continue;
      if (single !== null && i !== single - 1) continue;   // 单任务重跑：非目标已标跳过
      const rp = String(runPaths[i] != null ? runPaths[i] : rawPaths[i] || '');
      const name = rp.replace(/^raw\//, '').split(/[\\/]/).pop();
      const err = errByPath.get(name) || errByPath.get(rp);
      if (err) { t.status = 'failed'; t.output = (t.output || '') + `\n[失败] ${err}`; failedCount++; }
      else { t.status = 'done'; t.output = (t.output || '') + '\n已跳过（无可用解析器或内容为空）'; }
    }
    persistJobs(); emitJobs();

    const written = Number(stats.corpusWritten) || 0;
    const created = Number(stats.corpusCreated) || 0;
    const updated = Number(stats.corpusUpdated) || 0;
    const skipped = Number(stats.corpusSkipped) || 0;
    const failed = Number(stats.corpusFailed) || failedCount;
    if (!written && (failed || skipped === runPaths.length)) {
      throw new Error(`全部 ${runPaths.length} 个来源抽取失败或无可解析内容${(ctx.errors && ctx.errors[0]) ? '：' + ctx.errors[0].error : ''}`);
    }
    setStage(job, 'parse', 'success', `已解析 ${written + skipped} 个来源（跳过 ${skipped} 个空内容/不支持格式${failed ? `，失败 ${failed} 个` : ''}）`);
    setStage(job, 'write', 'success', `已写入 ${written} 篇语料${created ? `（新建 ${created}` : ''}${created && updated ? '、' : ''}${updated ? `更新 ${updated}` : ''}${(created || updated) ? '）' : ''} → corpus/`);
    const failedTasks = failedCount || (ctx.errors && ctx.errors.length)
      ? (ctx.errors || []).map((e, i) => ({ taskNo: i + 1, label: e.label, error: e.error }))
      : undefined;
    return { written, created, updated, skipped, failed, rels: (ctx.shared && ctx.shared.corpusRels) || [], failedTasks, llmCalls: Number(stats.llmCalls) || 0, warnings: (res && res.warnings) || [] };
  },
};

// ---------- 对外操作 ----------
function list() {
  return jobs;
}

// 作业内的领域归属（知识图谱抽取用）：已命中特定领域则直接用；
// 否则按来源内容归纳一个更贴合的领域（同名已有则复用，否则 AI 自动生成整套模版并保存），
// 让产物挂在有实体/概念类型约束的领域下而不是通用。失败一律回退通用，绝不拖垮作业。
// stageKey：进度文案写到哪个阶段（图谱 collect）
async function resolveAutoDomain(job, raws, stageKey) {
  const p = job.payload || {};
  const hints = p.typeHints || {};
  if ((hints.entity || []).length || (hints.concept || []).length) {
    return { domainId: p.domainId || p.domain, domainLabel: p.domainLabel || p.templateName, typeHints: p.typeHints };
  }
  // 重试场景：job.source.domain 已存有上一轮归纳好的领域（对象含 id/label/typeHints，或旧版字符串 id），
  // 直接复用，不再向慢模型发 suggestTemplateName 重复归纳（此前重试一直卡「寻找领域模版」即此因）
  const sd = job.source && job.source.domain;
  const prevId = typeof sd === 'string' ? sd : (sd && sd.id);
  if (prevId) {
    const tpl = templates.listTemplates().find((t) => t.id === prevId);
    if (tpl) {
      const classes = Array.isArray(tpl.domainClasses) ? tpl.domainClasses : [];
      const th = classes.length
        ? { entity: classes.filter((c) => c.parent !== 'information').map((c) => c.label || c.key).filter(Boolean),
            concept: classes.filter((c) => c.parent === 'information').map((c) => c.label || c.key).filter(Boolean) }
        : { entity: (tpl.entityTypes || []).map((x) => x.name).filter(Boolean),
            concept: (tpl.conceptTypes || []).map((x) => x.name).filter(Boolean) };
      const label = tpl.name || (typeof sd === 'object' && sd.label) || prevId;
      p.typeHints = th; p.domainId = tpl.id; p.domainLabel = label;
      if (tpl.ontologyProfile) p.ontologyProfile = tpl.ontologyProfile;
      persistJobs();
      setStage(job, stageKey, 'running', `复用上次归纳的领域「${label}」（${tpl.id}），直接开始抽取`);
      return { domainId: tpl.id, domainLabel: label, typeHints: th, ontologyProfile: tpl.ontologyProfile || undefined };
    }
  }
  // 领域信息回写作业卡片（source.domain），使徽标展示最终生效的领域而不是提交时的“通用”
  const writeBack = (domainId, domainLabel, typeHints, tplProfile) => {
    job.source = { ...(job.source || {}), domain: domainId, domainLabel, typeHints, ...(tplProfile ? { tplProfile } : {}) };
    persistJobs();
    emitJobs();
  };
  try {
    // 第一步：在已有领域模版中找最相似的（带相似度评分），命中阈值即复用，避免重复建模版
    setStage(job, stageKey, 'running', '正在已有领域模版中匹配最相似的一个…');
    let pickReason = '';
    let similarity = 0;
    let tpl = await templates.matchTemplate(p.settings, raws, { onPick: (r, s) => { pickReason = r || ''; similarity = s || 0; } });
    if (tpl && tpl.id === 'general') tpl = null; // general 不算命中特定领域
    let exist = !!tpl;
    if (tpl) {
      setStage(job, stageKey, 'running', `命中领域模版「${tpl.name}」（相似度 ${similarity}%）：${pickReason || '内容主题吻合'}`);
    } else {
      setStage(job, stageKey, 'running', '已有模版均不贴合，正按来源内容归纳新领域…');
      const sug = await templates.suggestTemplateName(p.settings, raws);
      // 归纳出的新名与已有模版精确重名时直接复用
      tpl = templates.listTemplates().find((t) => t.id !== 'general' && t.name === sug.name);
      exist = !!tpl;
      if (tpl) {
        setStage(job, stageKey, 'running', `归纳为领域「${sug.name}」，与已有模版重名，直接复用…`);
      } else {
        setStage(job, stageKey, 'running', `归纳为领域「${sug.name}」，正在生成该领域的领域类…`);
        const gen = await templates.generateTemplate(p.settings, { name: sug.name, desc: sug.desc });
        // 模型可能给出与已有模版重名的 id：同名不同领域时加后缀，避免覆盖别人的模版
        let id = gen.id;
        if (templates.listTemplates().some((t) => t.id === id && t.name !== sug.name)) id = `${id}_${Date.now().toString(36)}`;
        tpl = templates.saveTemplate({ ...gen, id, name: sug.name, desc: sug.desc });
      }
    }
    // v2：typeHints 从 domainClasses 派生（parent!==information→entity，=information→concept）
    const classes = Array.isArray(tpl.domainClasses) ? tpl.domainClasses : [];
    const typeHints = classes.length
      ? {
          entity: classes.filter((c) => c.parent !== 'information').map((c) => c.label || c.key).filter(Boolean),
          concept: classes.filter((c) => c.parent === 'information').map((c) => c.label || c.key).filter(Boolean),
        }
      : {
          entity: (tpl.entityTypes || []).map((x) => x.name).filter(Boolean),
          concept: (tpl.conceptTypes || []).map((x) => x.name).filter(Boolean),
        };
    // 第二步：体系解析（融合设计 §12.1.1 五级链）——模版绑定存在时**沿用绑定、不调模型**，
    // 与渲染层入口 raws.js「模版绑定优先，否则按该领域子集内容匹配」保持两入口一致；
    // 仅当绑定为空时才从已有本体定义中按来源内容动态选择（带相似度与理由）。
    let tplProfile = tpl.ontologyProfile || '';
    let prof = null;
    if (tplProfile) {
      setStage(job, stageKey, 'running', `体系沿用领域模版「${tpl.name}」的绑定「${tplProfile}」（不再调用模型选择）`);
    } else {
      setStage(job, stageKey, 'running', '模版未绑定体系，正在从本体定义中选择最贴合的体系…');
      prof = await templates.suggestOntologyProfile(p.settings, raws);
      tplProfile = prof.id;
      setStage(job, stageKey, 'running', `体系选「${prof.name}」（相似度 ${prof.similarity}%）：${prof.reason}`);
    }
    writeBack(tpl.id, tpl.name, typeHints, tplProfile);
    // 同步写回 payload：重试（retry 用 {...base} 重排）直接携带已归纳的领域与类型约束，
    // 不再重复走 suggestTemplateName 的 LLM 归纳（避免重试又卡在「寻找领域模版」等本地慢模型响应）
    p.typeHints = typeHints;
    p.domainId = tpl.id;
    p.domainLabel = tpl.name;
    if (tplProfile) p.ontologyProfile = tplProfile;
    persistJobs();
    setStage(job, stageKey, 'running', `${exist ? '复用' : '已新建'}领域「${tpl.name}」（相似度 ${similarity}%）；体系「${tplProfile}」${prof ? `（相似度 ${prof.similarity}%）：${prof.reason}` : '（模版绑定）'}，本次产物将挂到该领域下`);
    return { domainId: tpl.id, domainLabel: tpl.name, typeHints, ontologyProfile: tplProfile || undefined, profileReason: prof ? prof.reason : '', profileSimilarity: prof ? prof.similarity : 0, domainSimilarity: similarity, domainReason: pickReason };
  } catch (err) {
    setStage(job, stageKey, 'running', `自动建域未完成（${err.message}），本次按通用模版处理`);
    return null;
  }
}

// 图谱作业标题：从 raw 来源抽取时展示文件名
function rawPathsLabel(payload) {
  const list = (payload && payload.rawPaths) || [];
  if (!list.length) return '';
  return list.map((p) => String(p).replace(/^raw\//, '')).join('、').slice(0, 40);
}

// 提交作业（含标题生成与参数校验）
function submit({ type, payload }) {
  if (type === 'extract-note') {
    const rawPaths = Array.isArray(payload && payload.rawPaths) ? payload.rawPaths.filter(Boolean) : [];
    if (!rawPaths.length) return { ok: false, error: '没有可提取的原始来源' };
    // 强制 MinerU 重跑（回退警示后的「↻ 用 MinerU 重跑」）：标题标注，便于与普通提取区分
    const prefix = payload && payload.forceMineru ? '用 MinerU 重跑·' : '提取笔记·';
    const title = rawPaths.length === 1 ? `${prefix}${rawPaths[0]}` : `${prefix}${rawPaths.length} 个来源`;
    const job = submitJob('extract-note', title.slice(0, 60), EXTRACT_NOTE_STAGES, { ...payload, rawPaths });
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
    } else if (payload.corpusRels && payload.corpusRels.length) {
      // 语料库入图（§7.5 CorpusFileSource）：从已落盘 .md 语料再抽取，不重跑解析
      scopeLabel = `语料·${payload.corpusRels.length} 篇`;
      source = { kind: '语料库', label: payload.corpusRels.join('、'), items: payload.corpusRels };
    } else {
      // 集合类：全部笔记作为来源（每个笔记一个子任务）
      scopeLabel = '全部笔记';
      const items = [];
      for (const n of notesStore.getNotes()) items.push('笔记·' + (n.title || n.id));
      source = { kind: scopeLabel, label: `${scopeLabel}（${items.length} 个来源）`, items };
    }
    const job = submitJob('graph', `知识图谱抽取·${scopeLabel}`, GRAPH_STAGES, payload);
    // 领域信息随作业留档（携在 source 里一并持久化，无需改表结构）：
    // 卡片上直接看得到“本次按哪个领域模版抽取、有无实体/概念类型约束”
    const hints = payload.typeHints || {};
    source.domain = {
      id: payload.domainId || '',
      label: payload.domainLabel || '通用',
      entity: hints.entity || [],
      concept: hints.concept || [],
    };
    job.source = source;
    persistJobs();
    return { ok: true, id: job.id };
  }
  if (type === 'graph-repair') {
    // 修复作业：动作清单来自渲染层「修复预览」勾选结果（planRepairs dry-run 产物）
    const actions = (Array.isArray(payload && payload.actions) ? payload.actions : []).filter((a) => a && a.kind && a.kind !== 'manual');
    if (!actions.length) return { ok: false, error: '没有可自动应用的修复动作' };
    const conflictN = Number(payload && payload.conflictCount) || 0;
    const title = conflictN ? `图谱冲突修复·${conflictN} 处冲突 ${actions.length} 个动作` : `图谱冲突修复·${actions.length} 个动作`;
    const job = submitJob('graph-repair', title.slice(0, 60), GRAPH_REPAIR_STAGES, payload);
    // 动作清单随 source 持久化（payload 不入库）：重启后重试仍能恢复同一批动作
    job.source = { kind: '冲突修复', label: `${actions.length} 个修复动作`, items: actions.map((a) => a.actionZh || a.kind), actions };
    persistJobs();
    return { ok: true, id: job.id };
  }
  if (type === 'extract-corpus') {
    // 语料抽取作业（设计 §7.5）：从原始文件抽取为 Markdown 语料，不入图、不写笔记
    const rawPaths = Array.isArray(payload && payload.rawPaths) ? payload.rawPaths.filter(Boolean) : [];
    if (!rawPaths.length) return { ok: false, error: '没有可抽取的原始来源' };
    const title = rawPaths.length === 1 ? `抽取语料·${String(rawPaths[0]).replace(/^raw\//, '')}` : `抽取语料·${rawPaths.length} 个来源`;
    const job = submitJob('extract-corpus', title.slice(0, 60), EXTRACT_CORPUS_STAGES, { ...payload, rawPaths });
    job.source = { kind: '原始文件', label: rawPaths.join('、'), items: rawPaths };
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

// 重试失败作业：在原作业上重置重跑（不新建）
function retry({ id, settings }) {
  const src = jobs.find((j) => j.id === id);
  if (!src) return { ok: false, error: '作业不存在' };
  if (src.status !== 'failed') return { ok: false, error: '只能重试失败的作业' };
  const base = src.payload || {};
  if (src.type === 'extract-note') {
    const rawPaths = Array.isArray(base.rawPaths) ? base.rawPaths
      : (Array.isArray(src.rawPaths) ? src.rawPaths
      : (src.source && Array.isArray(src.source.items) ? src.source.items : []));
    if (!rawPaths.length) return { ok: false, error: '来源信息丢失，无法重试，请从原始文件页重新提取' };
    return { ok: true, id: requeueJob(src, EXTRACT_NOTE_STAGES, { ...base, settings, rawPaths }).id };
  }
  if (src.type === 'graph') {
    // 恢复提取范围：payload 不入库，重启后 base 为空；
    // 回退链：payload.rawPaths → raw_paths 列 → source.items（存量作业仅 source 列持久化了范围）；
    // 恢复不了且作业原本声明了范围 → 拒绝重试，绝不静默回退「全部笔记」
    const baseRaw = Array.isArray(base.rawPaths) ? base.rawPaths
      : (Array.isArray(src.rawPaths) ? src.rawPaths
      : (src.source && src.source.kind === '原始文件' && Array.isArray(src.source.items) ? src.source.items : []));
    const hadScope = (src.source && src.source.kind === '原始文件') || (Array.isArray(src.rawPaths) && src.rawPaths.length);
    if (!baseRaw.length && hadScope) {
      return { ok: false, error: '提取范围信息丢失（应用重启所致），请从「原始文件」页重新选择范围提取' };
    }
    const gpayload = { ...base, settings };
    if (baseRaw.length) gpayload.rawPaths = baseRaw;
    return { ok: true, id: requeueJob(src, GRAPH_STAGES, gpayload).id };
  }
  if (src.type === 'graph-repair') {
    // 动作清单恢复链：payload.actions → source.actions（持久化列）
    const acts = Array.isArray(base.actions) && base.actions.length
      ? base.actions
      : (src.source && Array.isArray(src.source.actions) ? src.source.actions : []);
    if (!acts.length) return { ok: false, error: '修复动作清单丢失（应用重启所致），请在「知识图谱 → 推理」页重新规划修复' };
    return { ok: true, id: requeueJob(src, GRAPH_REPAIR_STAGES, { ...base, settings, actions: acts }).id };
  }
  if (src.type === 'extract-corpus') {
    // 恢复抽取范围（与 extract-note 同回退链：payload.rawPaths → raw_paths 列 → source.items）
    const rawPaths = Array.isArray(base.rawPaths) && base.rawPaths.length
      ? base.rawPaths
      : (Array.isArray(src.rawPaths) && src.rawPaths.length ? src.rawPaths
      : (src.source && Array.isArray(src.source.items) ? src.source.items : []));
    if (!rawPaths.length) return { ok: false, error: '来源信息丢失，无法重试，请从原始文件页重新抽取' };
    return { ok: true, id: requeueJob(src, EXTRACT_CORPUS_STAGES, { ...base, settings, rawPaths }).id };
  }
  return { ok: false, error: '未知作业类型：' + src.type };
}

// 单任务重跑：仅对作业中标记为 failed 的图谱任务重新执行抽取，其余任务跳过
// 不重置作业状态，不清空已有任务输出，仅重跑失败项并合并结果
function retryTask({ id, taskNo, settings }) {
  const src = jobs.find((j) => j.id === id);
  if (!src) return { ok: false, error: '作业不存在' };
  if (src.type !== 'graph' && src.type !== 'graph-repair' && src.type !== 'extract-corpus') return { ok: false, error: '仅知识图谱/冲突修复/语料抽取作业支持单任务重跑' };
  if (src.status === 'running' || src.status === 'queued') return { ok: false, error: '作业进行中，无法重跑单个任务' };
  if (!Array.isArray(src.tasks) || !src.tasks.length) return { ok: false, error: '该作业没有任务列表' };
  const task = src.tasks.find((t) => t.no === taskNo);
  if (!task) return { ok: false, error: '任务不存在' };
  if (task.status !== 'failed') return { ok: false, error: '只能重跑失败的任务' };
  // 修复作业：动作清单恢复链 payload.actions → source.actions，仅重跑目标动作（不覆盖撤销快照）
  if (src.type === 'graph-repair') {
    const base = src.payload || {};
    const acts = Array.isArray(base.actions) && base.actions.length
      ? base.actions
      : (src.source && Array.isArray(src.source.actions) ? src.source.actions : []);
    if (!acts.length) return { ok: false, error: '修复动作清单丢失（应用重启所致），请在「知识图谱 → 推理」页重新规划修复' };
    const rpayload = { ...base, settings, actions: acts, _retryTaskNo: taskNo };
    src.status = 'queued';
    src.startedAt = 0;
    src.finishedAt = 0;
    src.error = '';
    task.status = 'pending';
    task.output = (task.output || '') + '\n[重跑] 等待重新执行…';
    src.stages = GRAPH_REPAIR_STAGES.map((s) => ({ key: s.key, name: s.name, status: 'pending', detail: '' }));
    src.payload = rpayload;
    jobQueue.push(src.id);
    persistJobs();
    emitJobs();
    pumpJobQueue();
    return { ok: true, id: src.id };
  }
  // 恢复提取范围（与 retry 相同回退链）
  const base = src.payload || {};
  const baseRaw = Array.isArray(base.rawPaths) ? base.rawPaths
    : (Array.isArray(src.rawPaths) ? src.rawPaths
    : (src.source && src.source.kind === '原始文件' && Array.isArray(src.source.items) ? src.source.items : []));
  const hadScope = (src.source && src.source.kind === '原始文件') || (Array.isArray(src.rawPaths) && src.rawPaths.length);
  if (!baseRaw.length && hadScope) {
    return { ok: false, error: '提取范围信息丢失（应用重启所致），请从「原始文件」页重新选择范围提取' };
  }
  // 在原作业上重跑：状态改回 queued，仅对失败任务重抽取
  // payload 中携带 _retryTaskNo 标记，extractGraph 据此只执行该批次
  const gpayload = { ...base, settings, _retryTaskNo: taskNo };
  if (baseRaw.length) gpayload.rawPaths = baseRaw;
  src.status = 'queued';
  src.startedAt = 0;
  src.finishedAt = 0;
  src.error = '';
  // 保留已有任务列表，仅重置目标任务为 pending
  task.status = 'pending';
  task.output = (task.output || '') + '\n[重跑] 等待重新执行…';
  // 重置阶段为 pending，重新走一遍流程（但仅目标批次真正执行）
  // graph 与 extract-corpus 共用这段重跑逻辑（都按 rawPaths 恢复范围），仅阶段定义不同
  const stageDefs = src.type === 'extract-corpus' ? EXTRACT_CORPUS_STAGES : GRAPH_STAGES;
  src.stages = stageDefs.map((s) => ({ key: s.key, name: s.name, status: 'pending', detail: '' }));
  src.payload = gpayload;
  jobQueue.push(src.id);
  persistJobs();
  emitJobs();
  pumpJobQueue();
  return { ok: true, id: src.id };
}

function getJobLogs(id) {
  return jobLogs.get(id) || [];
}

module.exports = { init, loadJobs, list, submit, remove, clear, retry, retryTask, cancel, importLegacyJobs, getJobLogs };
