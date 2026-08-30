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

// ---------- 队列执行（可配置并发） ----------
function pumpJobQueue() {
  while (runningIds.size < maxConcurrent() && jobQueue.length) {
    const id = jobQueue.shift();
    const job = jobs.find((j) => j.id === id);
    if (!job) continue;
    runningIds.add(id);
    job.status = 'running';
    job.startedAt = Date.now();
    runJob(job);
  }
  persistJobs();
  emitJobs();
}

async function runJob(job) {
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
  { key: 'save', name: '合并存图' },
];
const EXTRACT_NOTE_STAGES = [
  { key: 'extract', name: '解析来源' },
  { key: 'save', name: '写入笔记' },
];

const JOB_RUNNERS = {
  async 'extract-note'(job) {
    const { settings, rawPaths = [], forceMineru } = job.payload;
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
    const BUILTIN_EXTS = ['.md', '.markdown', '.txt', '.csv', '.json', '.log', '.html', '.htm'];
    // 该来源是否会实际尝试 MinerU：文本型扩展（含 html）按设计固定走内置解析，不会调用 MinerU，
    // 也不存在「回退」一说；文案须如实区分，避免用户误以为 MinerU 失败
    const usesMineru = (name) => mineruOn && !BUILTIN_EXTS.includes(path.extname(String(name)).toLowerCase());
    // 解析方式如实标注：缓存命中时带上「缓存」字样，避免用户以为本次重新跑了 MinerU
    const parseLabel = (name, used, fromCache) => {
      const suffix = fromCache ? '（缓存命中，未重跑）' : '';
      if (used === 'mineru') return `MinerU 解析${suffix}`;
      return usesMineru(name) ? `内置解析（MinerU 失败回退）${suffix}` : '内置解析';
    };
    // 回退记录：MinerU 失败静默回退内置是「笔记质量与 MinerU 测试不一致」的根因，
    // 这里逐文件收集回退原因，写入子任务输出与作业结果，前端据此展示警示与「用 MinerU 重跑」
    const fallbacks = [];
    // 解析方式计数：阶段摘要如实说明哪些来源走了 MinerU、哪些按设计走内置（文本型含 html），
    // 避免「解析方式：MinerU 解析」这类笼统表述让用户误以为文本型来源也该经 MinerU
    let mineruFiles = 0;
    let builtinOnlyFiles = 0;
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
      // 执行中需说明采用的解析方式（内置 / MinerU），便于用户判断进度与质量预期；
      // 文本型扩展（含 html）按设计固定内置解析，文案如实标注，避免误以为 MinerU 失败
      const fileMethod = forceMineru ? '强制 MinerU 解析（不回退）' : (usesMineru(record.name) ? 'MinerU 解析' : '内置解析（该类型不走 MinerU）');
      setStage(job, 'extract', 'running', `解析 ${record.name}（${no}/${rawPaths.length}，并发 ${CONC}，${fileMethod}）`);
      try {
        const info = {}; // extractFileContent 经此交还本次 MinerU 转换暂存的图片目录与解析方式（并发安全，不用全局静态字段）
        // MinerU 子进程输出（含进度条 \r 刷新）经 onLog 流式接入作业「解析过程」，前端实时展示
        // noCache：提取笔记每次重新生成，不读提取缓存（缓存仅供问答扫描提速，新结果仍会落盘刷新缓存）
        const text = await extractFileContent(abs, settings, {
          forceMineru: !!forceMineru,
          noCache: true,
          info,
          onLog: (line, replace) => jobLog(job, `[${record.name}] ${line}`, replace),
        });
        const used = info.parseMethod || 'builtin';
        // 按来源类型计数（阶段摘要用）：二进制/图片型会经 MinerU（含缓存命中的 MinerU 产物），文本型（含 html）按设计固定内置
        if (!forceMineru) { if (used === 'mineru' || usesMineru(record.name)) mineruFiles++; else builtinOnlyFiles++; }
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
        // MinerU 失败回退内置：记录原因并在子任务输出中明确警示（产物质量低于 MinerU 解析）
        const fbReason = used !== 'mineru' && mineruOn && !BUILTIN_EXTS.includes(path.extname(record.name).toLowerCase())
          ? (info.externalError || 'MinerU 转换失败')
          : '';
        if (fbReason) fallbacks.push({ path: relPath, name: record.name, reason: fbReason, note: relNotePath(res.path) });
        // 子任务输出带上笔记落盘的具体位置，便于用户直接定位文件；回退时附原因警示
        tracker.setOutput(i, `${res.updated ? '已更新已有笔记' : '已新建笔记'} · ${parseLabel(record.name, used, info.fromCache)} → ${relNotePath(res.path)}${imgCount ? `（含 ${imgCount} 张图）` : ''}${fbReason ? `\n⚠ MinerU 失败已回退内置解析（${fbReason}），笔记质量可能低于 MinerU 解析，可在作业上「用 MinerU 重跑」` : ''}`);
        tracker.setDone(i);
      } catch (err) {
        failed.push({ path: relPath, name: record.name, error: err.message });
        tracker.setOutput(i, '失败：' + err.message);
        tracker.setDone(i);
      }
    };
    // 并发 worker 池：单线程内 await 切换，cursor 自增同步无竞态
    const workers = Array.from({ length: Math.max(1, Math.min(CONC, rawPaths.length)) }, async () => {
      while (cursor < rawPaths.length) {
        const i = cursor++;
        await processOne(i);
      }
    });
    await Promise.all(workers);
    // 没有任何来源成功写入笔记、且存在失败来源时，作业整体应记为失败（status=failed），
    // 否则 runJob 见 runner 正常返回就标 success，出现「作业成功、子任务失败」的矛盾展示
    // （强制 MinerU 重跑失败不回退内置时尤其明显）
    if (!notes.length && failed.length) {
      throw new Error(`全部 ${failed.length} 个来源解析失败：${failed[0].error}${forceMineru ? '（强制 MinerU 模式，不回退内置）' : ''}`);
    }
    const skipNote = skipped.length ? `，按类型跳过 ${skipped.length} 个` : '';
    // 解析方式如实汇总：文本型来源（md/txt/csv/html 等）按设计固定内置解析，不属于「MinerU 失败回退」；
    // 只有二进制型（pdf/docx/pptx/xlsx/图片）才经 MinerU，失败才回退。笼统写「MinerU 解析」会误导
    const methodNote = forceMineru
      ? '解析方式：强制 MinerU 解析（不回退内置）'
      : (mineruOn
        ? `解析方式：MinerU 解析 ${mineruFiles} 个（二进制/图片型），内置解析 ${builtinOnlyFiles} 个（文本型按设计不走 MinerU），MinerU 失败自动回退内置`
        : '解析方式：内置解析');
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
    const { settings, rawPaths, inlineSources, typeHints, domainId, domainLabel } = job.payload;
    setStage(job, 'collect', 'running', inlineSources && inlineSources.length ? `读取 ${inlineSources.length} 个笔记来源…` : (rawPaths && rawPaths.length ? `读取 ${rawPaths.length} 个原始来源…` : '读取全部笔记…'));
    const res = await graph.extractGraph(settings, {
      rawPaths,
      inlineSources,
      typeHints,
      domainId,
      domainLabel,
      // 领域：只有选了“自动”时才在作业内找/建领域；用户显式指定领域（含通用）时 autoDomain=false，按其选择执行
      resolveDomain: job.payload.autoDomain === false ? undefined : (raws) => resolveAutoDomain(job, raws, 'collect'),
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
  // 领域信息回写作业卡片（source.domain），使徽标展示最终生效的领域而不是提交时的“通用”
  const writeBack = (domainId, domainLabel, typeHints) => {
    job.source = { ...(job.source || {}), domain: domainId, domainLabel, typeHints };
    persistJobs();
    emitJobs();
  };
  try {
    setStage(job, stageKey, 'running', '未命中特定领域模版，正按来源内容归纳更贴合的领域…');
    const sug = await templates.suggestTemplateName(p.settings, raws);
    const exist = templates.listTemplates().find((t) => t.id !== 'general' && t.name === sug.name);
    let tpl = exist;
    if (tpl) {
      setStage(job, stageKey, 'running', `归纳为领域「${sug.name}」，命中已有领域模版，直接复用…`);
    } else {
      setStage(job, stageKey, 'running', `归纳为领域「${sug.name}」，正在生成该领域的实体/概念类型…`);
      const gen = await templates.generateTemplate(p.settings, { name: sug.name, desc: sug.desc });
      // 模型可能给出与已有模版重名的 id：同名不同领域时加后缀，避免覆盖别人的模版
      let id = gen.id;
      if (templates.listTemplates().some((t) => t.id === id && t.name !== sug.name)) id = `${id}_${Date.now().toString(36)}`;
      tpl = templates.saveTemplate({ ...gen, id, name: sug.name, desc: sug.desc });
    }
    const typeHints = {
      entity: (tpl.entityTypes || []).map((x) => x.name).filter(Boolean),
      concept: (tpl.conceptTypes || []).map((x) => x.name).filter(Boolean),
    };
    writeBack(tpl.id, tpl.name, typeHints);
    setStage(job, stageKey, 'running', `${exist ? '复用' : '已新建'}领域「${tpl.name}」（${tpl.id}），本次产物将挂到该领域下`);
    return { domainId: tpl.id, domainLabel: tpl.name, typeHints };
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
    const rawPaths = Array.isArray(base.rawPaths) ? base.rawPaths : [];
    if (!rawPaths.length) return { ok: false, error: '来源信息丢失，无法重试，请从原始文件页重新提取' };
    return { ok: true, id: requeueJob(src, EXTRACT_NOTE_STAGES, { ...base, settings, rawPaths }).id };
  }
  if (src.type === 'graph') {
    return { ok: true, id: requeueJob(src, GRAPH_STAGES, { ...base, settings }).id };
  }
  return { ok: false, error: '未知作业类型：' + src.type };
}

function getJobLogs(id) {
  return jobLogs.get(id) || [];
}

module.exports = { init, loadJobs, list, submit, remove, clear, retry, importLegacyJobs, getJobLogs };
