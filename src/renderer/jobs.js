// 渲染进程·作业模块：作业管理页与作业事件刷新
// 任务输出折叠状态（会话内）：key = jobId:taskNo
const taskCollapsed = {};
// 作业实时解析日志（会话级缓存）：主进程经 jobs:log 逐行推送（MinerU 子进程输出等），
// key = jobId，value = 行数组；\r 进度行在主进程侧已按“覆盖上一行”语义合并
const jobLiveLogs = {};

// 复制任务完整输出到剪贴板
async function copyTaskOutput(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制完整输出（' + text.length + ' 字符）');
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制完整输出'); } catch (e) { toast('复制失败', 2500); }
    ta.remove();
  }
}
// ---------- 作业管理（专属页面） ----------
function showJobsView() {
  hideMainViews();
  promptEditing = null;
  $('jobs-view').hidden = false;
  renderEditor();
  renderJobsView();
}

function hideJobsView() {
  $('jobs-view').hidden = true;
  renderEditor();
}

function jobStatusMeta(status) {
  return { queued: ['排队中', ''], running: ['执行中', 'running'], success: ['成功', 'success'], failed: ['失败', 'failed'] }[status] || [status, ''];
}

// 作业类型图标：统一使用 index.html 顶部 SVG sprite 中的线性图标
const JOB_TYPE_ICONS = {
  'extract-note': 'notes',
  ingest: 'download',
  graph: 'kg',
  lint: 'checklist',
};
function jobTypeIcon(type) {
  return icoSvg(JOB_TYPE_ICONS[type] || 'jobs', 15);
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 时 ${m % 60} 分`;
}

function renderJobs() {
  const hasActive = state.jobs.some((j) => j.status === 'running' || j.status === 'queued');
  const activeCount = state.jobs.filter((j) => j.status === 'running' || j.status === 'queued').length;
  $('nav-jobs').classList.toggle('jobs-active', hasActive);
  $('count-jobs').textContent = activeCount || '';
  if (!$('jobs-view').hidden) renderJobsView();
}

function filteredJobs() {
  const f = state.jobsFilter;
  if (f === 'active') return state.jobs.filter((j) => j.status === 'running' || j.status === 'queued');
  if (f === 'success' || f === 'failed') return state.jobs.filter((j) => j.status === f);
  return state.jobs;
}

// 打开作业视图时为运行中作业补拉主进程内存日志缓存（页面刷新后日志不丢）
function hydrateJobLogs() {
  if (!window.kb.jobsLogs) return;
  for (const j of state.jobs) {
    if (j.status !== 'running') continue;
    if ((jobLiveLogs[j.id] || []).length) continue;
    window.kb.jobsLogs(j.id).then((lines) => {
      if (Array.isArray(lines) && lines.length && !(jobLiveLogs[j.id] || []).length) {
        jobLiveLogs[j.id] = lines;
        renderJobs();
      }
    }).catch(() => {});
  }
}

function renderJobsView() {
  hydrateJobLogs();
  const c = { queued: 0, running: 0, success: 0, failed: 0 };
  state.jobs.forEach((j) => { if (c[j.status] !== undefined) c[j.status]++; });
  // 计数徽章直接挂在筛选按钮上：进行中 = 运行 + 排队
  const counts = { all: state.jobs.length, active: c.running + c.queued, success: c.success, failed: c.failed };
  document.querySelectorAll('#jobs-filter button').forEach((b) => {
    b.classList.toggle('active', b.dataset.filter === state.jobsFilter);
    const badge = b.querySelector('.jf-count');
    const n = counts[b.dataset.filter] || 0;
    if (badge) {
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.hidden = n === 0;
    }
  });

  const box = $('jobs-page-list');
  box.innerHTML = '';
  const list = filteredJobs();
  if (!list.length) {
    box.innerHTML = '<div class="list-empty">没有符合条件的作业<br>发起“吸收”或“体检”后可在此统一跟踪各阶段任务进度</div>';
    return;
  }
  for (const job of list) box.appendChild(buildJobCard(job));
}

function buildJobCard(job) {
  // 进行中/排队作业默认展开，执行详情直接可见；手动收起后尊重用户选择
  const active = job.status === 'running' || job.status === 'queued';
  const expanded = active ? state.jobsExpanded[job.id] !== false : !!state.jobsExpanded[job.id];
  const card = document.createElement('div');
  card.className = 'job-row-card ' + job.status;

  const [statusText, statusCls] = jobStatusMeta(job.status);
  const icon = jobTypeIcon(job.type);
  const stages = job.stages || [];
  // 与阶段行图标同一归一规则：作业已终态时残留 running 视为 success/failed，保证徽章与行一致
  const normStage = (st) => (st.status === 'running' && job.status !== 'running' && job.status !== 'queued')
    ? (job.status === 'failed' ? 'failed' : 'success') : st.status;
  const doneCount = stages.filter((s) => normStage(s) === 'success').length;
  // 抽取的来源/文件数（图谱作业 result.sourceCount），体现“抽了多少个具体文件”
  const srcCount = job.result && Number.isFinite(job.result.sourceCount) ? job.result.sourceCount : null;
  // 本次抽取所用领域（图谱作业）：命中特定领域模版时节点按该模版的实体/概念类型组织
  const dom = job.source && job.source.domain;
  const domTypes = dom ? ((dom.entity || []).length + (dom.concept || []).length) : 0;
  const domTitle = dom
    ? (domTypes
      ? `按领域模版「${dom.label}」抽取：实体类型〔${(dom.entity || []).join('、')}〕；概念类型〔${(dom.concept || []).join('、')}〕`
      : `按「${dom.label}」抽取：未附加实体/概念类型约束`)
    : '';
  let dur = '';
  if (job.finishedAt && job.startedAt) dur = fmtDuration(job.finishedAt - job.startedAt);
  else if (job.status === 'running' && job.startedAt) dur = fmtDuration(Date.now() - job.startedAt) + '（进行中）';

  const head = document.createElement('div');
  head.className = 'job-row';
  head.innerHTML = `
    <span class="job-chevron">${expanded ? '▾' : '▸'}</span>
    <span class="job-icon">${icon}</span>
    <span class="job-title" title="${escapeHtml(job.title)}">${escapeHtml(job.title)}</span>
    ${dom ? `<span class="job-domain" title="${escapeHtml(domTitle)}">领域：${escapeHtml(dom.label)}${domTypes ? ` · ${domTypes} 类型` : ''}</span>` : ''}
    ${srcCount != null ? `<span class="job-src-count" title="抽取的来源/文件数">${icoSvg('notes', 12)} ${srcCount}</span>` : ''}
    <span class="job-progress" title="阶段进度：已完成 ${doneCount}/${stages.length} 个阶段">${doneCount}/${stages.length}</span>
    <span class="job-status ${statusCls}">${statusText}</span>
    <span class="job-time">${formatDate(job.createdAt)}</span>
    <span class="job-dur">${dur}</span>`;

  const actions = document.createElement('span');
  actions.className = 'job-actions';
  // 失败可重试：lint / 图谱（payload 带来源即可重跑）/ 已保存来源的吸收作业
  const hasRaw = (job.rawPaths && job.rawPaths.length) || (job.payload && job.payload.rawPaths && job.payload.rawPaths.length);
  if (job.status === 'failed' && (job.type === 'lint' || job.type === 'graph' || job.type === 'extract-note' || hasRaw)) {
    actions.appendChild(jobActionBtn(icoSvg('refresh', 12) + ' 重试', '', () => retryJob(job), '重新提交该作业'));
  }
  // MinerU 失败回退内置：提供「用 MinerU 重跑」，强制 MinerU 解析（不回退），原地更新笔记产物
  const fbList = job.result && Array.isArray(job.result.fallbacks) ? job.result.fallbacks : [];
  if (job.type === 'extract-note' && fbList.length && (job.status === 'success' || job.status === 'failed')) {
    actions.appendChild(jobActionBtn(icoSvg('refresh', 12) + ' 用 MinerU 重跑', 'warn', () => rerunWithMineru(job), '对回退的来源强制 MinerU 解析（失败直接报错，不回退内置），原地更新已有笔记'));
  }
  if (job.status === 'success' || job.status === 'failed') {
    actions.appendChild(jobActionBtn(icoSvg('delete', 12), 'danger', () => removeJob(job), '删除该条作业'));
  }
  head.appendChild(actions);
  head.addEventListener('click', (e) => {
    if (e.target.closest('.job-actions')) return;
    state.jobsExpanded[job.id] = !expanded;
    renderJobsView();
  });
  card.appendChild(head);

  if (expanded) card.appendChild(buildJobDetail(job));
  return card;
}

function buildJobDetail(job) {
  const detail = document.createElement('div');
  detail.className = 'job-detail';

  const tl = document.createElement('div');
  tl.className = 'job-timeline';
  tl.innerHTML = `<span>提交 ${formatDate(job.createdAt)}</span>
    <span>开始 ${job.startedAt ? formatDate(job.startedAt) : '—'}</span>
    <span>结束 ${job.finishedAt ? formatDate(job.finishedAt) : '—'}</span>
    ${job.finishedAt && job.startedAt ? `<span>总耗时 ${fmtDuration(job.finishedAt - job.startedAt)}</span>` : ''}`;
  detail.appendChild(tl);

  // MinerU 回退警示：有来源因 MinerU 失败回退内置时明确提示（产物质量低于 MinerU 解析），
  // 与「设置→MinerU 测试」产物不一致的根因即在此；提供强制 MinerU 重跑入口
  const fbList = job.result && Array.isArray(job.result.fallbacks) ? job.result.fallbacks : [];
  if (job.type === 'extract-note' && fbList.length) {
    const fb = document.createElement('div');
    fb.className = 'job-fallback-warn';
    const items = fbList.slice(0, 10).map((f) =>
      `<div class="fb-item">${icoSvg('notes', 12)} ${escapeHtml(f.name || f.path)}：${escapeHtml(f.reason || 'MinerU 转换失败')}${f.note ? ` → 已按内置解析写入 ${escapeHtml(f.note)}` : ''}</div>`).join('');
    const more = fbList.length > 10 ? `<div class="fb-item">… 共 ${fbList.length} 个</div>` : '';
    fb.innerHTML = `<div class="fb-head">⚠ ${fbList.length} 个来源 MinerU 解析失败，已回退内置解析</div>
      <div class="fb-body">回退产物的质量低于 MinerU 解析（与「设置 → MinerU 测试」的结果不一致）。可点击右上「用 MinerU 重跑」强制使用 MinerU 解析并原地更新笔记；失败将直接报错，不再回退。</div>
      ${items}${more}`;
    detail.appendChild(fb);
  }

  // 作业来源 + 产物信息：来源列表（submit 的 source.items 或抽取返回的 result.sourceLabels）+ 图谱产物（节点/关系）
  const srcItems = (job.source && Array.isArray(job.source.items) && job.source.items.length)
    ? job.source.items
    : (job.result && Array.isArray(job.result.sourceLabels) ? job.result.sourceLabels : []);
  const isGraph = job.type === 'graph';
  const hasArtifact = isGraph && job.result && Number.isFinite(job.result.nodeCount);
  if (srcItems.length || hasArtifact || job.source) {
    const src = document.createElement('div');
    src.className = 'job-source';
    const shown = srcItems.slice(0, 20).map((s) => `<span class="job-source-item">${escapeHtml(s)}</span>`).join('');
    const more = srcItems.length > 20 ? `<span class="job-source-item">… 共 ${srcItems.length} 个</span>` : '';
    const kind = (job.source && job.source.kind) || (isGraph ? '图谱来源' : '来源');
    const label = (job.source && job.source.label) || `共 ${srcItems.length} 个来源`;
    src.innerHTML =
      `<div class="job-source-head"><span class="job-source-kind">${escapeHtml(kind)}</span><span class="job-source-label">${escapeHtml(label)}</span></div>` +
      (srcItems.length ? `<div class="job-source-items">${shown}${more}</div>` : '') +
      (hasArtifact ? `<div class="job-artifact">产物：${job.result.nodeCount} 节点 / ${job.result.edgeCount} 关系，已持久化到 SQLite</div>` : '');
    detail.appendChild(src);
  }

  // 领域信息：本次抽取所用领域模版及其实体/概念类型约束（通用模版时明确告知无类型约束）
  const dom = job.source && job.source.domain;
  if (dom) {
    const ent = dom.entity || [];
    const con = dom.concept || [];
    const box = document.createElement('div');
    box.className = 'job-source job-domain-detail';
    box.innerHTML =
      `<div class="job-source-head"><span class="job-source-kind">领域</span><span class="job-source-label">${escapeHtml(dom.label)}${dom.id ? `（${escapeHtml(dom.id)}）` : ''}</span></div>` +
      (ent.length || con.length
        ? `<div class="job-source-items">${[...ent.map((t) => ['实体', t]), ...con.map((t) => ['概念', t])]
          .map(([k, t]) => `<span class="job-source-item">${k}·${escapeHtml(t)}</span>`).join('')}</div>`
        : '<div class="job-artifact">未命中特定领域模版，本次未附加实体/概念类型约束（节点类型由模型自由归纳）</div>');
    detail.appendChild(box);
  }

  // 任务列表：每个来源一个独立 task，展示处理状态（点击任务行可收起/展开输出）
  if (Array.isArray(job.tasks) && job.tasks.length) {
    const doneN = job.tasks.filter((t) => t.status === 'done').length;
    const box = document.createElement('div');
    box.className = 'job-source job-tasks';
    box.innerHTML = `<div class="job-source-head"><span class="job-source-kind">任务</span><span class="job-source-label">已处理 ${doneN}/${job.tasks.length}</span></div>`;
    const list = document.createElement('div');
    list.className = 'job-task-list';
    job.tasks.forEach((t) => {
      const key = job.id + ':' + t.no;
      const collapsed = !!taskCollapsed[key];
      const ico = t.status === 'done' ? '<span class="task-ico done">✓</span>'
        : t.status === 'running' ? '<span class="task-ico run">◐</span>'
        : '<span class="task-ico pend">○</span>';
      const wrap = document.createElement('div');
      wrap.className = 'job-task-wrap';
      const row = document.createElement('div');
      row.className = 'job-task ' + (t.status || '') + (t.output ? ' has-out' : '');
      const chev = t.output ? `<span class="task-chev">${collapsed ? '▸' : '▾'}</span>` : '';
      row.innerHTML = `${t.no ? `<span class="job-task-no">${t.no}</span>` : ''}${chev}${ico}<span class="job-task-label">${escapeHtml(t.label)}</span>`;
      if (t.output) {
        const cp = document.createElement('button');
        cp.className = 'task-copy';
        cp.textContent = '复制';
        cp.title = '复制该任务的完整输出文本';
        cp.addEventListener('click', (e) => { e.stopPropagation(); copyTaskOutput(String(t.output)); });
        row.appendChild(cp);
        row.addEventListener('click', () => { taskCollapsed[key] = !taskCollapsed[key]; renderJobsView(); });
      }
      wrap.appendChild(row);
      if (t.output && !collapsed) {
        const pre = document.createElement('pre');
        pre.className = 'job-live task-output';
        pre.textContent = String(t.output).slice(-800);
        wrap.appendChild(pre);
      }
      list.appendChild(wrap);
    });
    box.appendChild(list);
    detail.appendChild(box);
  }

  // 实时解析过程（MinerU 子进程输出）：主进程逐行推送、会话内缓存；执行中自动滚到尾部。
  // 主进程在作业终态后清空其内存缓存，但前端会话缓存保留，历史作业仍可查看本次解析输出
  const logs = jobLiveLogs[job.id];
  if (Array.isArray(logs) && logs.length) {
    const lg = document.createElement('div');
    lg.className = 'job-source job-parselog';
    lg.innerHTML = `<div class="job-source-head"><span class="job-source-kind">解析过程</span><span class="job-source-label">MinerU 子进程实时输出</span></div>`;
    const pre = document.createElement('pre');
    pre.className = 'job-live parse-log';
    pre.textContent = logs.join('\n');
    lg.appendChild(pre);
    detail.appendChild(lg);
    if (job.status === 'running' || job.status === 'queued') {
      requestAnimationFrame(() => { pre.scrollTop = pre.scrollHeight; });
    }
  }

  const stages = document.createElement('div');
  stages.className = 'job-stages';
  for (const st of job.stages || []) {
    const row = document.createElement('div');
    // 作业已终态时，残留的 running 阶段不再转圈：失败作业记为失败，成功作业记为成功
    let stStatus = st.status;
    if (stStatus === 'running' && job.status !== 'running' && job.status !== 'queued') {
      stStatus = job.status === 'failed' ? 'failed' : 'success';
    }
    row.className = 'job-stage ' + stStatus;
    const ico = stStatus === 'success' ? '✓' : stStatus === 'failed' ? '✕' : stStatus === 'running' ? '<span class="mini-spinner"></span>' : '○';
    row.innerHTML = `<span class="stage-ico">${ico}</span><span class="stage-name">${escapeHtml(st.name)}</span><span class="stage-detail">${escapeHtml(st.detail || '')}</span>`;
    stages.appendChild(row);
  }
  detail.appendChild(stages);

  // 模型流式输出实时预览（仅执行中/失败时展示，自动滚到尾部）
  if (job.livePreview && (job.status === 'running' || job.status === 'failed')) {
    const live = document.createElement('pre');
    live.className = 'job-live';
    live.textContent = job.livePreview;
    detail.appendChild(live);
    requestAnimationFrame(() => { live.scrollTop = live.scrollHeight; });
  }

  if (job.status === 'failed' && job.error) {
    const err = document.createElement('div');
    err.className = 'job-error';
    err.textContent = '错误：' + job.error;
    detail.appendChild(err);
  }
  if (job.type === 'ingest' && job.status === 'success' && job.result && job.result.summary) {
    const sum = document.createElement('div');
    sum.className = 'job-summary';
    sum.textContent = '摘要：' + job.result.summary;
    detail.appendChild(sum);
  }
  return detail;
}

function jobActionBtn(html, cls, onclick, title) {
  const b = document.createElement('button');
  b.className = 'btn btn-ghost job-act-btn' + (cls ? ' ' + cls : '');
  b.innerHTML = html;
  if (title) b.title = title;
  b.addEventListener('click', (e) => { e.stopPropagation(); onclick(); });
  return b;
}

// 绑定作业实时解析日志通道：jobs:log 逐行追加到会话缓存并触发重渲染（进度行覆盖上一行）
function bindJobsLog() {
  if (!window.kb.onJobsLog) return;
  window.kb.onJobsLog((d) => {
    if (!d || !d.id || !d.line) return;
    const arr = jobLiveLogs[d.id] || (jobLiveLogs[d.id] = []);
    if (d.replace) arr[arr.length - 1] = d.line; else arr.push(d.line);
    if (arr.length > 300) arr.splice(0, arr.length - 300);
    renderJobs();
  });
}

async function retryJob(job) {
    const res = await window.kb.jobsRetry({ id: job.id, settings: state.settings });
  if (res.ok) { toast('已在原作业上重试'); return; }
  toast('重试失败：' + res.error, 4000);
}

// 用 MinerU 重跑：对回退的来源提交新的强制 MinerU 提取作业（不回退内置），原地更新笔记产物
async function rerunWithMineru(job) {
  const fbList = (job.result && Array.isArray(job.result.fallbacks)) ? job.result.fallbacks : [];
  const paths = fbList.map((f) => f.path).filter(Boolean);
  if (!paths.length) { toast('没有可重跑的回退来源', 3000); return; }
  if (!confirm(`将对 ${paths.length} 个回退来源强制使用 MinerU 解析（失败直接报错，不回退内置），并原地更新已有笔记。继续吗？`)) return;
  const res = await window.kb.jobsSubmit({ type: 'extract-note', payload: { settings: state.settings, rawPaths: paths, forceMineru: true } });
  if (!res.ok) { toast('提交失败：' + (res.error || '未知错误'), 4000); return; }
  toast('已提交「用 MinerU 重跑」作业');
}

async function removeJob(job) {
  const res = await window.kb.jobsRemove(job.id);
  if (res.ok) { delete state.jobsExpanded[job.id]; return; }
  toast('删除失败：' + res.error, 4000);
}

async function clearJobsHistory() {
  const terminal = state.jobs.filter((j) => j.status === 'success' || j.status === 'failed').length;
  if (!terminal) { toast('没有可清除的已完成作业'); return; }
  if (!confirm(`确定清除 ${terminal} 条已完成作业？（不影响进行中的作业）`)) return;
  await window.kb.jobsClear();
}

// 作业列表实时更新：渲染 + 原始来源刷新
let prevJobStatuses = {};
function handleJobsUpdate(list) {
  const prev = prevJobStatuses;
  prevJobStatuses = {};
  for (const j of list) {
    prevJobStatuses[j.id] = j.status;
    if (j.type === 'extract-note' && j.status === 'success' && prev[j.id] && prev[j.id] !== 'success') {
      window.kb.loadData().then((data) => {
        state.folders = data.folders || [];
        state.notes = data.notes || [];
        renderAll();
      });
      toast('笔记提取完成');
    }
    if (j.type === 'graph' && j.status === 'success' && prev[j.id] && prev[j.id] !== 'success') {
      loadGraph();
      toast('知识图谱抽取完成');
    }
  }
  state.jobs = list;
  renderJobs();
}

