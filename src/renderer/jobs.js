// 渲染进程·作业模块：作业管理页与作业事件刷新
// 任务输出折叠状态（会话内）：key = jobId:taskNo
const taskCollapsed = {};
// ---------- 作业管理（专属页面） ----------
function showJobsView() {
  $('wiki-viewer').hidden = true;
  $('settings-view').hidden = true;
  $('graph-view').hidden = true;
  $('tpl-view').hidden = true;
  $('raw-view').hidden = true;
  $('prompts-view').hidden = true;
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

// 作业类型图标：按类型定制的渐变 SVG（与作业管理页标题图标同风格）
// ingest=蓝·汇入箭头，graph=青·网状节点，lint=绿·对勾体检
const JOB_TYPE_ICONS = {
  ingest: '<svg class="job-type-icon" width="16" height="16" viewBox="0 0 24 24" fill="none"><defs><linearGradient id="jobIconIngest" x1="3" y1="3" x2="21" y2="21"><stop stop-color="#5b8cff"/><stop offset="1" stop-color="#3370ff"/></linearGradient></defs><rect x="3" y="3" width="18" height="18" rx="5" fill="url(#jobIconIngest)"/><path d="M12 6.8v6.4m0 0l-2.7-2.7M12 13.2l2.7-2.7" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.6 16.8h8.8" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>',
  graph: '<svg class="job-type-icon" width="16" height="16" viewBox="0 0 24 24" fill="none"><defs><linearGradient id="jobIconGraph" x1="3" y1="3" x2="21" y2="21"><stop stop-color="#3fd6d0"/><stop offset="1" stop-color="#0da6a0"/></linearGradient></defs><rect x="3" y="3" width="18" height="18" rx="5" fill="url(#jobIconGraph)"/><circle cx="9.2" cy="9.4" r="1.7" fill="#fff"/><circle cx="15.2" cy="9.4" r="1.7" fill="#fff"/><circle cx="12.2" cy="15" r="1.7" fill="#fff"/><path d="M10.1 10.9l1.3 2.5M14.3 10.9l-1.3 2.5M10.9 9.4h2.6" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/></svg>',
  lint: '<svg class="job-type-icon" width="16" height="16" viewBox="0 0 24 24" fill="none"><defs><linearGradient id="jobIconLint" x1="3" y1="3" x2="21" y2="21"><stop stop-color="#5ad184"/><stop offset="1" stop-color="#16a34a"/></linearGradient></defs><rect x="3" y="3" width="18" height="18" rx="5" fill="url(#jobIconLint)"/><path d="M7.6 12.4l3 3 5.8-6.2" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
function jobTypeIcon(type) {
  return JOB_TYPE_ICONS[type] || JOB_TYPE_ICONS.ingest;
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

function renderJobsView() {
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
  let dur = '';
  if (job.finishedAt && job.startedAt) dur = fmtDuration(job.finishedAt - job.startedAt);
  else if (job.status === 'running' && job.startedAt) dur = fmtDuration(Date.now() - job.startedAt) + '（进行中）';

  const head = document.createElement('div');
  head.className = 'job-row';
  head.innerHTML = `
    <span class="job-chevron">${expanded ? '▾' : '▸'}</span>
    <span class="job-icon">${icon}</span>
    <span class="job-title" title="${escapeHtml(job.title)}">${escapeHtml(job.title)}</span>
    ${srcCount != null ? `<span class="job-src-count" title="抽取的来源/文件数">📄 ${srcCount}</span>` : ''}
    <span class="job-progress" title="阶段进度：已完成 ${doneCount}/${stages.length} 个阶段">${doneCount}/${stages.length}</span>
    <span class="job-status ${statusCls}">${statusText}</span>
    <span class="job-time">${formatDate(job.createdAt)}</span>
    <span class="job-dur">${dur}</span>`;

  const actions = document.createElement('span');
  actions.className = 'job-actions';
  if (job.type === 'lint' && job.status === 'success' && job.result && job.result.report) {
    actions.appendChild(jobActionBtn('📄 报告', '', () => {
      $('lint-report').innerHTML = renderMarkdown(job.result.report);
      $('lint-modal').hidden = false;
    }, '查看体检报告'));
  }
  if (job.status === 'failed' && (job.type === 'lint' || (job.rawPaths && job.rawPaths.length))) {
    actions.appendChild(jobActionBtn('🔄 重试', '', () => retryJob(job), '重新提交该作业'));
  }
  if (job.status === 'success' || job.status === 'failed') {
    actions.appendChild(jobActionBtn('🗑', 'danger', () => removeJob(job), '删除该条作业'));
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
      (hasArtifact ? `<div class="job-artifact">🕸 产物：${job.result.nodeCount} 节点 / ${job.result.edgeCount} 关系，已持久化到 SQLite</div>` : '');
    detail.appendChild(src);
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
      if (t.output) row.addEventListener('click', () => { taskCollapsed[key] = !taskCollapsed[key]; renderJobsView(); });
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

function jobActionBtn(text, cls, onclick, title) {
  const b = document.createElement('button');
  b.className = 'btn btn-ghost job-act-btn' + (cls ? ' ' + cls : '');
  b.textContent = text;
  if (title) b.title = title;
  b.addEventListener('click', (e) => { e.stopPropagation(); onclick(); });
  return b;
}

async function retryJob(job) {
    const res = await window.kb.jobsRetry({ id: job.id, settings: state.settings });
  if (res.ok) { toast('已在原作业上重试'); return; }
  toast('重试失败：' + res.error, 4000);
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

// 作业列表实时更新：渲染 + 吸收成功后刷新 Wiki 树
let prevJobStatuses = {};
function handleJobsUpdate(list) {
  const prev = prevJobStatuses;
  prevJobStatuses = {};
  let needWikiRefresh = false;
  for (const j of list) {
    prevJobStatuses[j.id] = j.status;
    if (j.type === 'ingest' && j.status === 'success' && prev[j.id] && prev[j.id] !== 'success') {
      needWikiRefresh = true;
      loadRaws(); // 吸收会新增 raw/ 来源，同步计数与列表
    }
    if (j.type === 'graph' && j.status === 'success' && prev[j.id] && prev[j.id] !== 'success') {
      loadGraph();
      toast('知识图谱抽取完成');
    }
  }
  state.jobs = list;
  renderJobs();
  if (needWikiRefresh) loadWiki();
}

