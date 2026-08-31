// 渲染进程·问答模块：AI 面板、笔记/原始文件/图谱检索与回填
let aiHistory = []; // {role, content}
let aiListeners = [];
// 回答中的活 DOM（步骤组/气泡/用户消息）：切走再切回时原位恢复，进行中的过程不丢
let liveView = null;
// 当前交互请求的“立即停止”回调（渲染端先拆解 UI，不依赖主进程是否及时响应）
let stopCurrentAi = null;

// 会话历史持久化（SQLite kv）：跨会话上下文记忆
function saveAiHistory() { try { window.kb.chatSaveHistory(aiHistory.slice(-60)); } catch (_) {} }
async function loadAiHistory() {
  try { aiHistory = (await window.kb.chatGetHistory()) || []; } catch (_) { aiHistory = []; }
  renderAiHistory();
}
function renderAiHistory() {
  const box = $('ai-messages'); box.innerHTML = '';
  aiHistory.forEach((m) => {
    if (m.role === 'user') addAiMessage('user', escapeHtml(m.content || ''));
    else if (m.role === 'assistant') {
      // 恢复执行过程（思考/检索/工具调用等步骤），插在答案气泡之前
      if (Array.isArray(m.steps) && m.steps.length) {
        const g = createStepsGroup();
        m.steps.forEach((x) => g.addStep(x));
        g.finish();
        box.appendChild(g.el);
      }
      addAiMessage('assistant', renderMarkdown(m.content || ''));
    }
  });
}

// AI 面板左缘拖拽调宽（280–720px，宽度存 localStorage）
function initAiPanelResize() {
  const panel = $('ai-panel');
  const handle = $('ai-resize');
  if (!panel || !handle) return;
  const saved = parseInt(localStorage.getItem('kb.aiPanelWidth') || '0', 10);
  if (saved >= 280) panel.style.width = saved + 'px';
  let dragging = false;
  handle.addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = panel.getBoundingClientRect();
    const w = Math.max(280, Math.min(720, rect.right - e.clientX));
    panel.style.width = w + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; localStorage.setItem('kb.aiPanelWidth', String(panel.offsetWidth)); }
  });
}

// ================= 问答附件（仅作用于本次提问，不写入 raw/知识库） =================
let aiAttachments = []; // [{path, name}]
// MAX_ATTACH 定义于 renderer/constants.js

function renderAttachBar() {
  const bar = $('ai-attach-bar');
  if (!bar) return;
  bar.innerHTML = '';
  bar.hidden = !aiAttachments.length;
  if (!aiAttachments.length) return;
  aiAttachments.forEach((a, i) => {
    const chip = document.createElement('span');
    chip.className = 'ai-attach-chip';
    chip.innerHTML = icoSvg('notes', 12) + ' <span class="n">' + escapeHtml(a.name) + '</span>'
      + '<button type="button" class="x" title="移除">✕</button>';
    chip.title = a.path;
    chip.querySelector('.x').addEventListener('click', () => {
      aiAttachments.splice(i, 1);
      renderAttachBar();
    });
    bar.appendChild(chip);
  });
  const tip = document.createElement('span');
  tip.className = 'ai-attach-tip';
  tip.textContent = `仅用于本次提问（${aiAttachments.length}/${MAX_ATTACH}）`;
  bar.appendChild(tip);
}

async function pickAiAttachments() {
  const res = await window.kb.rawPickFiles();
  if (!res || !res.ok || !res.paths || !res.paths.length) return;
  const exist = new Set(aiAttachments.map((a) => a.path));
  let skipped = 0;
  for (const p of res.paths) {
    if (exist.has(p)) { skipped++; continue; }
    if (aiAttachments.length >= MAX_ATTACH) { skipped++; continue; }
    aiAttachments.push({ path: p, name: String(p).split(/[\\/]/).pop() });
    exist.add(p);
  }
  renderAttachBar();
  if (skipped) toast(`已添加，${skipped} 个被跳过（重复或超过 ${MAX_ATTACH} 个上限）`, 3200);
}

// 取附件正文拼成上下文；返回给步骤组的摘要供展示
async function buildAttachContext(group) {
  if (!aiAttachments.length) return { context: '', names: [] };
  group.addStep({ kind: 'thought', text: `正在读取 ${aiAttachments.length} 个上传文件…` });
  const r = await window.kb.readAttachments({ settings: state.settings, paths: aiAttachments.map((a) => a.path) })
    .catch((err) => ({ ok: false, error: (err && err.message) || String(err) }));
  if (!r || !r.ok) {
    group.addStep({ kind: 'thought', text: '附件读取失败：' + ((r && r.error) || '未知错误') });
    return { context: '', names: [] };
  }
  const ok = (r.items || []).filter((x) => !x.error && x.text);
  const bad = (r.items || []).filter((x) => x.error || !x.text);
  bad.forEach((x) => group.addStep({ kind: 'thought', text: `附件无法读取：${x.name}（${x.error || '未提取到文本'}）` }));
  if (!ok.length) return { context: '', names: [] };
  ok.forEach((x) => group.addStep({
    kind: 'thought',
    text: `已读取附件：${x.name}（${x.chars} 字${x.truncated ? '，已截断' : ''}）`,
  }));
  const context = ok.map((x, i) => `【上传文件${i + 1}】${x.name}${x.truncated ? '（内容较长，仅附前部分）' : ''}\n${x.text}`).join('\n\n');
  return { context, names: ok.map((x) => x.name) };
}

// 在用户气泡下标出本轮附上的文件
function renderMsgAttachments(msgEl, names) {
  if (!msgEl || !names || !names.length) return;
  const box = msgEl.querySelector('.bubble');
  if (!box) return;
  const row = document.createElement('div');
  row.className = 'ai-msg-attach';
  row.innerHTML = icoSvg('attach', 12) + escapeHtml(names.join('、'));
  box.appendChild(row);
}

// ================= AI 主框架页（会话历史 + 欢迎 + 大输入框） =================
function addViewMessage(role, html, opts) {
  const box = $('ai-view-messages');
  const div = document.createElement('div');
  div.className = `ai-msg ${role}`;
  const roleName = role === 'user' ? '我' : role === 'error' ? '提示' : 'AI 助手';
  div.innerHTML = `<div class="role">${roleName}</div><div class="bubble">${html}</div>`;
  // 用户消息支持「更改内容再次发送」：悬停显示 ✎，进入内联编辑
  if (role === 'user' && opts && opts.raw !== undefined) {
    div.__raw = opts.raw;
    div.__rec = opts.rec || null;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-msg-edit';
    btn.title = '编辑内容并重新发送';
    btn.innerHTML = icoSvg('edit', 13);
    btn.addEventListener('click', (e) => { e.stopPropagation(); editViewUserMessage(div); });
    div.appendChild(btn);
  }
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}
// 编辑已发送的问题：气泡换成输入框；「重新发送」会截断该问题之后的对话再以新内容提问
function editViewUserMessage(el) {
  if (el.querySelector('.ai-msg-editor-input')) return; // 已在编辑
  const bubble = el.querySelector('.bubble');
  const raw0 = el.__raw !== undefined ? el.__raw : bubble.textContent;
  el.classList.add('editing');
  bubble.innerHTML = '';
  const ta = document.createElement('textarea');
  ta.className = 'ai-msg-editor-input';
  ta.value = raw0;
  ta.rows = Math.min(10, Math.max(2, raw0.split('\n').length));
  const bar = document.createElement('div');
  bar.className = 'ai-msg-editor-bar';
  const send = document.createElement('button');
  send.type = 'button';
  send.className = 'btn btn-primary';
  send.textContent = '重新发送';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-ghost';
  cancel.textContent = '取消';
  bar.appendChild(send);
  bar.appendChild(cancel);
  bubble.appendChild(ta);
  bubble.appendChild(bar);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  cancel.addEventListener('click', (e) => {
    e.stopPropagation();
    el.classList.remove('editing');
    bubble.innerHTML = escapeHtml(raw0);
  });
  send.addEventListener('click', (e) => {
    e.stopPropagation();
    const text = ta.value.trim();
    if (!text) { toast('内容不能为空', 2000); return; }
    if (state.aiBusy) { toast('正在回答中，请先停止再重新发送', 2500); return; }
    const s = (state.aiSessions || []).find((x) => x.id === state.activeSessionId);
    if (!s) return;
    // 定位该问题在会话中的位置：优先用记录引用，兜底按原文匹配
    let idx = el.__rec ? s.messages.indexOf(el.__rec) : -1;
    if (idx < 0) idx = s.messages.findIndex((m) => m.role === 'user' && (m.content || '') === raw0);
    if (idx < 0) return;
    s.messages.splice(idx); // 该问题及其后的问答全部作废，以新内容重问
    if (idx === 0) s.title = text.slice(0, 30);
    s.updatedAt = Date.now();
    saveAiSessions();
    openAiSession(s.id); // 重建视图（清掉编辑器与该问题之后的旧消息）
    sendAiViewQuestion(text);
  });
}
async function loadAiSessions() {
  let disk;
  try { disk = (await window.kb.chatGetSessions()) || []; } catch (_) { disk = []; }
  const mem = state.aiSessions || [];
  // 回答中的会话以内存为准（流式回答尚未落盘，直接用磁盘数据会丢内容）
  const busyId = state.aiBusySessionId;
  const busyMem = busyId ? mem.find((x) => x.id === busyId) : null;
  // 合并：保留磁盘与内存共有的会话（内存版可能更新），加上磁盘独有的，再加上内存独有的
  const merged = [];
  const seen = new Set();
  for (const s of mem) { merged.push(s); seen.add(s.id); }
  for (const s of disk) { if (!seen.has(s.id)) merged.push(s); }
  state.aiSessions = merged;
  renderAiSessionList();
}
function saveAiSessions() {
  try {
    // 净化：step 里的 detailEl 等 DOM 引用不可序列化，落盘前剥离，只留纯数据
    const clean = (state.aiSessions || []).map((s) => ({
      ...s,
      messages: (s.messages || []).map((m) => ({
        ...m,
        steps: Array.isArray(m.steps) ? m.steps.map((x) => ({ kind: x.kind, name: x.name, args: x.args, text: x.text, result: x.result, links: x.links })) : m.steps,
      })),
    }));
    window.kb.chatSaveSessions(clean);
  } catch (_) {}
}
// 没有 updatedAt 的旧会话回退用 id 里的创建时间戳（id 形如 's1699…'）
function sessionTime(s) {
  if (s && s.updatedAt) return s.updatedAt;
  const n = parseInt(String((s && s.id) || '').replace(/^s/, ''), 10);
  return Number.isFinite(n) ? n : 0;
}
function sessionStamp(s) {
  const t = sessionTime(s);
  if (!t) return s.date || '';
  const d = new Date(t);
  const today = new Date().toISOString().slice(0, 10);
  const day = d.toISOString().slice(0, 10);
  // 当天的会话显示时间，否则只显示日期（同一天多个会话光看日期区分不出来）
  if (day === today) return '今天 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return day;
}
function renderAiSessionList() {
  updateFavBtn();
  if (state.favView) { renderFavorites(); return; } // 收藏视图：左列表展示收藏清单
  const box = $('ai-session-list'); if (!box) return;
  box.innerHTML = '';
  // 按最近活动倒序：在旧会话里追问时它也会浮到顶部，不会埋在列表中间
  const list = (state.aiSessions || []).slice().sort((a, b) => sessionTime(b) - sessionTime(a));
  let activeEl = null;
  list.forEach((s) => {
    const busy = s.id === state.aiBusySessionId;
    const d = document.createElement('div');
    d.className = 'ai-session-item'
      + (s.id === state.activeSessionId ? ' active' : '')
      + (busy ? ' busy' : '');
    d.innerHTML = `<div class="t">${escapeHtml(s.title || '新任务')}</div>`
      + `<div class="d">${busy ? '<span class="ai-session-live"><i></i>回答中</span>' : escapeHtml(sessionStamp(s))}</div>`;
    d.addEventListener('click', () => openAiSession(s.id));
    box.appendChild(d);
    if (s.id === state.activeSessionId) activeEl = d;
  });
  // 列表较长时把当前会话滚入可视区，避免高亮项在视口外。
  // 用 rect 而非 offsetTop：容器未设 position 时 offsetTop 是相对更外层的，会算多
  if (activeEl) {
    const boxRect = box.getBoundingClientRect();
    const elRect = activeEl.getBoundingClientRect();
    if (elRect.top < boxRect.top || elRect.bottom > boxRect.bottom) {
      box.scrollTop += elRect.top - boxRect.top - 8;
    }
  }
}
// ---------- 基础配置引导清单 ----------
// 三项完成度实时判定：模型（接口地址+模型名）/ MinerU（命令或 mineru 模式）/ 首份原始文档
function refreshSetupChecklist() {
  const s = state.settings || {};
  const items = [
    ['ai-setup-model', !!((s.apiBaseUrl || '').trim() && (s.model || '').trim())],
    ['ai-setup-mineru', !!((s.mineruConvertCmd || '').trim() || s.mineruMode === 'mineru')],
    ['ai-setup-raw', (state.raws || []).some((r) => r && r.path)],
  ];
  let done = 0;
  items.forEach(([id, ok]) => {
    const el = $(id);
    if (!el) return;
    el.classList.toggle('done', ok);
    if (ok) done++;
  });
  const pg = $('ai-setup-progress');
  if (pg) pg.textContent = `${done}/3`;
  const card = $('ai-setup-card');
  if (card) card.classList.toggle('all-done', done === 3);
  refreshExtChecklist();
}
// 扩展能力引导：MCP 服务器（已启用≥1）/ 技能（已启用≥1）实时判定，配好同显绿色勾
function refreshExtChecklist() {
  const s = state.settings || {};
  const items = [
    ['ext-setup-mcp', (s.mcpServers || []).some((m) => m && m.enabled !== false)],
    ['ext-setup-skill', (s.skills || []).some((k) => k && k.enabled)],
  ];
  let done = 0;
  items.forEach(([id, ok]) => {
    const el = $(id);
    if (!el) return;
    el.classList.toggle('done', ok);
    if (ok) done++;
  });
  const pg = $('ext-setup-progress');
  if (pg) pg.textContent = `${done}/2`;
  const card = $('ext-setup-card');
  if (card) card.classList.toggle('all-done', done === 2);
}
// 「开始配置」跳转：模型→设置·模型配置；MinerU→设置·文档解析；原始文档→原始文件页
function bindSetupChecklist() {
  const go = {
    'ai-setup-model': () => { showSettingsView(); switchSettingsTab('ai'); },
    'ai-setup-mineru': () => { showSettingsView(); switchSettingsTab('parse'); },
    'ai-setup-raw': () => showRawView(),
    'ext-setup-mcp': () => { showSettingsView(); switchSettingsTab('mcp'); },
    'ext-setup-skill': () => { showSettingsView(); switchSettingsTab('skills'); },
  };
  Object.entries(go).forEach(([id, fn]) => {
    const el = $(id);
    if (!el) return;
    el.querySelector('.ai-setup-go').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
  });
}

async function showAiView() {
  hideMainViews();
  setAiPanelVisible(false);
  $('ai-view').hidden = false;
  // 必须先 await loadAiSessions，否则 openAiSession 用旧数组重建后
  // loadAiSessions 异步完成会覆盖 state.aiSessions，导致视图与数据不一致
  await loadAiSessions();
  loadGraphProfiles(); // 刷新可选体系清单（OWL 导入/删除后同步），图谱源子选择用
  refreshAiExtTitles();
  if (state.aiBusy) {
    // 回答中切回：若活 DOM 还在则原位恢复，否则保持当前 DOM 不动
    if (liveView && liveView.sessionId === state.aiBusySessionId) {
      state.activeSessionId = state.aiBusySessionId;
      $('ai-view-welcome').hidden = true;
      const box = $('ai-view-messages');
      box.hidden = false;
      box.innerHTML = '';
      if (liveView.userEl) box.appendChild(liveView.userEl);
      box.appendChild(liveView.groupEl);
      box.appendChild(liveView.msgEl);
      box.scrollTop = box.scrollHeight;
      renderAiSessionList();
    }
  } else if (state.activeSessionId) openAiSession(state.activeSessionId);
  else aiNewTask();
  refreshSetupChecklist();
  renderEditor();
  renderSidebar();
}
function aiNewTask() {
  state.activeSessionId = null;
  state.favView = false; // 新任务回到会话列表视图
  updateFavBtn();
  $('ai-view-welcome').hidden = false;
  const box = $('ai-view-messages'); box.hidden = true; box.innerHTML = '';
  $('ai-view-input').value = '';
  aiAttachments = [];
  renderAttachBar();
  renderAiSessionList();
  refreshSetupChecklist();
}
function openAiSession(id, highlightRec) {
  const s = (state.aiSessions || []).find((x) => x.id === id);
  if (!s) return;
  // 正在回答的会话不重建：活 DOM 里的步骤组/流式气泡尚未存盘，重建即丢失；
  // 切走再切回时把活 DOM 原位恢复，保证进行中的过程与已生成内容可见
  if (state.aiBusy && id === state.aiBusySessionId) {
    state.activeSessionId = id;
    $('ai-view-welcome').hidden = true;
    const box = $('ai-view-messages');
    box.hidden = false;
    box.innerHTML = '';
    if (liveView && liveView.sessionId === id) {
      // 按原始顺序恢复：用户问题 → 步骤组 → 流式气泡
      if (liveView.userEl) box.appendChild(liveView.userEl);
      box.appendChild(liveView.groupEl);
      box.appendChild(liveView.msgEl);
      box.scrollTop = box.scrollHeight;
    }
    renderAiSessionList();
    return;
  }
  state.activeSessionId = id;
  $('ai-view-welcome').hidden = true;
  const box = $('ai-view-messages'); box.hidden = false; box.innerHTML = '';
  let lastUserQ = ''; // 记录最近一条用户消息，供回答的「添加到笔记」使用
  (s.messages || []).forEach((m) => {
    if (m.role === 'user') lastUserQ = m.content || '';
    if (m.role === 'assistant' && Array.isArray(m.steps) && m.steps.length) {
      const g = createStepsGroup();
      m.steps.forEach((x) => g.addStep(x));
      g.finish();
      if (g.el.parentNode !== box) box.appendChild(g.el);
    }
    const el = addViewMessage(m.role, m.role === 'user' ? escapeHtml(m.content || '') : renderMarkdown(m.content || ''),
      m.role === 'user' ? { raw: m.content || '', rec: m } : undefined);
    if (m.role === 'user') renderMsgAttachments(el, m.attachments);
    if (m.role === 'assistant') {
      appendImagePreview(el.querySelector('.bubble'), m.content || '');
      renderArtifacts(el, m.artifacts || collectArtifacts(m.steps));
      renderCitations(el, m.citations || { notes: [], hits: [], sources: collectSources(m.steps) });
      addAnswerMeta(el, { answer: m.content || '', ms: m.ms, record: m, question: lastUserQ });
      // 从收藏列表进入：定位到该回答并短暂高亮
      if (m === highlightRec) {
        el.classList.add('ai-fav-flash');
        el.scrollIntoView({ block: 'center' });
      }
    }
  });
  renderAiSessionList();
}
async function sendAiViewQuestion(presetText) {
  // 按钮 click 事件会把 MouseEvent 当作 presetText 传进来，仅字符串预设有意义；
  // 不规整的话 .trim() 直接抛错，表现为「停止/发送」按钮点不动
  if (typeof presetText !== 'string') presetText = undefined;
  const q = (presetText !== undefined ? presetText : $('ai-view-input').value).trim();
  // 回答中再点发送 = 停止当前回答（避免按钮锁死无法发新问题）
  if (state.aiBusy) { stopAiRequest(); return; }
  if (!q) return;
  const t0 = Date.now();
  let s = (state.aiSessions || []).find((x) => x.id === state.activeSessionId);
  if (!s) {
    s = { id: 's' + Date.now(), title: q.slice(0, 30), date: new Date().toISOString().slice(0, 10), updatedAt: Date.now(), messages: [] };
    state.aiSessions.push(s);
    state.activeSessionId = s.id;
  }
  $('ai-view-welcome').hidden = true;
  $('ai-view-messages').hidden = false;
  if (presetText === undefined) $('ai-view-input').value = '';
  const userMsg = { role: 'user', content: q };
  s.messages.push(userMsg);
  const userEl = addViewMessage('user', escapeHtml(q), { raw: q, rec: userMsg });
  // 记活动时间与“正在回答”归属，让该会话在列表里浮顶并打上回答中标识
  s.updatedAt = Date.now();
  state.aiBusySessionId = s.id;
  // 先落盘：中途退出也不丢用户的问题，且 updatedAt 排序能跨重启生效
  saveAiSessions();
  renderAiSessionList();
  state.aiBusy = true;
  setAiSendBusy(true);
  // 顺序：用户消息 → 执行步骤组（过程）→ 答案气泡，过程永远在答案上方
  const group = createStepsGroup();
  $('ai-view-messages').appendChild(group.el);
  // 与问题格式直接匹配的技能在过程里点名，避免“凭空生效”
  const autoHit = autoSkillNames(q);
  if (autoHit.length) group.addStep({ kind: 'thought', text: '与问题格式匹配的技能：' + autoHit.join('、') });
  const msgEl = addViewMessage('assistant', loadingHtml('思考中'));
  const bubble = msgEl.querySelector('.bubble');
  // 气泡创建后再记录活 DOM 引用：回答中切走再切回时按 问题→过程→答案 顺序恢复
  liveView = { sessionId: s.id, groupEl: group.el, msgEl, userEl };
  const status = startStatusbar();
  let answer = '';
  let thinkText = '';
  let aiCites = null;
  let noteCites = [];
  let rawCites = [];
  cleanupAiListeners();
  const offChunk = window.kb.onAiChunk((c) => { answer += c; bubble.innerHTML = renderMarkdown(answer); status.set('生成回答'); $('ai-view-messages').scrollTop = 9e9; });
  // 引用事件（一次下发全部知识源的命中）：收集后随答案一并展示
  let offRefs = () => {};
  try {
    offRefs = window.kb.onAiRefs((refs) => {
      const graphHits = (refs && refs.graph) || [];
      if (graphHits.length) aiCites = { hits: graphHits };
      if (refs) {
        if (Array.isArray(refs.notes)) noteCites = refs.notes;
        if (Array.isArray(refs.raws)) rawCites = refs.raws;
      }
    });
  } catch (e) { console.warn('引用事件注册失败：', e); }
  // 桥接层缺陷不应中断问答：注册失败时降级为不展示步骤
  let offStep = () => {};
  try {
    offStep = window.kb.onAiStep((step) => {
      // 思考内容同时入步骤组（供历史回看）与气泡实时打印；addStep 内部把增量合并进同一条 thinking 折叠块，
      // 气泡里的实时思考在正文开始后被答案覆盖，步骤组里的思考则随消息持久化
      group.addStep(step);
      if (step.kind === 'thinking') {
        thinkText += step.text || '';
        if (!answer) {
          bubble.innerHTML = '<div class="ai-think-live">思考中（实时输出）</div>' +
            '<pre class="ai-think-live-body">' + escapeHtml(thinkText) + '</pre>';
          const tb = bubble.querySelector('.ai-think-live-body');
          if (tb) tb.scrollTop = tb.scrollHeight;
        }
      }
      // 状态条直接用阶段文案（如“正在筛选…”），比统一的“思考”更能看出进展
      if (step.kind === 'tool') status.set('调用工具：' + step.name);
      else if (step.kind === 'tool-result') status.set('工具返回');
      else if ((step.kind === 'thought' || step.kind === 'progress') && step.text) {
        // ⚠️/ 类提示（如 MCP 装载失败）必须完整展示：状态条不截断、也不覆盖已显示内容
        const warn = /^[⚠❌]/.test(step.text);
        status.set(warn ? step.text : String(step.text).slice(0, 28));
        // 正文/思考还未开始时，气泡占位也跟着显示当前阶段，不再写死“思考中”
        if (!answer && !thinkText && !warn) bubble.innerHTML = loadingHtml(String(step.text).slice(0, 40));
      } else status.set('思考');
    });
  } catch (e) { console.warn('步骤事件注册失败：', e); }
  const offDone = window.kb.onAiDone(() => finishView(true));
  const offError = window.kb.onAiError((msg) => { bubble.innerHTML = renderMarkdown((answer ? answer + '\n\n' : '') + `> ⚠ ${msg}`); finishView(false); });
  aiListeners = [offChunk, offStep, offRefs, offDone, offError];
  // 「停止」的渲染端拆解：不等待主进程，立即恢复可发送并收起过程区
  stopCurrentAi = () => {
    cleanupAiListeners();
    state.aiBusy = false;
    state.aiBusySessionId = null;
    status.stop();
    // 无论是否有内容都补一条 assistant 消息，避免用户消息成为孤儿（无回答）
    const stoppedContent = answer || '> ⚠ 已停止。';
    s.messages.push({ role: 'assistant', content: stoppedContent, steps: group.steps, ms: Date.now() - t0 });
    saveAiSessions();
    bubble.innerHTML = renderMarkdown(stoppedContent);
    group.finish();
    setAiSendBusy(false);
    renderAiSessionList();
    liveView = null;
  };
  function finishView(ok) {
    stopCurrentAi = null;
    state.aiBusy = false;
    state.aiBusySessionId = null;
    setAiSendBusy(false);
    if (s) s.updatedAt = Date.now();
    cleanupAiListeners();
    status.stop();
    group.finish();
    if (ok && answer) {
      const { preamble, questions } = splitAsk(answer);
      if (questions) {
        // 澄清问题工作流：渲染可选卡片，用户确认/跳过后自动续跑
        bubble.innerHTML = renderMarkdown(preamble || '为了让结果更贴合需求，先确认几个问题：');
        renderAskCard(msgEl, questions, (answersText) => {
          s.messages.push({ role: 'assistant', content: preamble || '（澄清问题）' });
          saveAiSessions();
          sendAiViewQuestion(answersText + '\n\n（以上为澄清确认，请直接执行任务，无需再问。）');
        });
      } else {
        const cites = {
          notes: noteCites,
          raws: rawCites,
          hits: (aiCites && aiCites.hits) || [],
          sources: collectSources(group.steps),
        };
        const rec = { role: 'assistant', content: answer, steps: group.steps, ms: Date.now() - t0, rating: 0, citations: cites, artifacts: collectArtifacts(group.steps) };
        s.messages.push(rec);
        bubble.innerHTML = renderMarkdown(answer);
        appendImagePreview(bubble, answer);
        renderArtifacts(msgEl, rec.artifacts);
        renderCitations(msgEl, cites);
        if (answer.length > 800) addFileAnswerButton(msgEl, q, answer);
        addAnswerMeta(msgEl, { answer, ms: rec.ms, record: rec, question: q });
      }
    }
    saveAiSessions();
    renderAiSessionList();
    liveView = null;
  }
  // 知识检索全部交由主进程的知识访问层：前端只传“哪些源被勾选”，
  // 各源的检索、上下文拼装、引用归一都在 knowledge 层完成（新增源无需改此处）
  // 上传附件：本次提问的主要依据，读完即清空，不累积到下一轮
  const attach = await buildAttachContext(group);
  if (attach.names.length) {
    userMsg.attachments = attach.names;   // 存进会话，重开时仍能看到附了什么
    renderMsgAttachments(userEl, attach.names);
  }
  aiAttachments = [];
  renderAttachBar();
  const messages = [
    { role: 'system', content: attach.context ? `请优先依据以下附件内容回答：\n\n${attach.context}` : '你是个人知识库助手，请简洁、准确地回答问题。' },
    ...s.messages.slice(-8),
  ];
  try {
    await window.kb.askAI(buildAskPayload(messages, q));
  } catch (err) {
    // 兜底：发送链路抛异常也必须解除 busy，否则整个问答会被锁死
    try { bubble.innerHTML = renderMarkdown((answer ? answer + '\n\n' : '') + '> ⚠ 发送失败：' + ((err && err.message) || err)); } catch (_) {}
    try { finishView(false); } catch (_) { state.aiBusy = false; state.aiBusySessionId = null; setAiSendBusy(false); liveView = null; }
  }
}
// ================= AI 问答 =================
// 简单检索：对问题分词（英文单词 + 中文二元组），给笔记打分取 Top
function tokenize(text) {
  const tokens = new Set();
  const words = String(text).toLowerCase().match(/[a-z0-9_]{2,}/g) || [];
  words.forEach((w) => tokens.add(w));
  const cjk = String(text).match(/[\u4e00-\u9fa5]+/g) || [];
  cjk.forEach((seg) => {
    if (seg.length === 1) tokens.add(seg);
    for (let i = 0; i < seg.length - 1; i++) tokens.add(seg.slice(i, i + 2));
  });
  return [...tokens];
}

function retrieveNotes(question, topN = 4) {
  // 单字词（如「中」「的」）过于通用，会让无关笔记被当成引用，打分时剔除
  const tokens = tokenize(question).filter((t) => t.length >= 2);
  if (tokens.length === 0) return [];
  const scored = state.notes
    .map((note) => {
      const title = (note.title || '').toLowerCase();
      const tags = (note.tags || []).join(' ').toLowerCase();
      const content = (note.content || '').toLowerCase();
      let score = 0;
      // 命中的不同关键词（不分标题/标签/正文）与其中最长者，用于判定证据强弱
      const matched = new Set();
      tokens.forEach((t) => {
        let hit = false;
        if (title.includes(t)) { score += 5; hit = true; }
        if (tags.includes(t)) { score += 3; hit = true; }
        let idx = 0;
        let count = 0;
        while ((idx = content.indexOf(t, idx)) !== -1 && count < 10) {
          count++;
          idx += t.length;
        }
        if (count) { score += count; hit = true; }
        if (hit) matched.add(t);
      });
      const longest = [...matched].reduce((a, t) => Math.max(a, t.length), 0);
      return { note, score, matched: matched.size, longest };
    })
    // 需命中 ≥2 个不同关键词，或命中一个足够具体的长词（≥4 字符，如 excel/m890）。
    // 仅靠「使用」「文件」这类二字通用词命中（即使在标题里）不构成引用依据
    .filter((x) => x.matched >= 2 || x.longest >= 4)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
  return scored.map((x) => x.note);
}

// 加载中动效（三点跳动）
function loadingHtml(label) {
  return `<span class="ai-loading">${escapeHtml(label)}<span class="dots"><i></i><i></i><i></i></span></span>`;
}

function addAiMessage(role, contentHtml, sources) {
  const box = $('ai-messages');
  const div = document.createElement('div');
  div.className = `ai-msg ${role}`;
  const roleName = role === 'user' ? '我' : role === 'error' ? '提示' : 'AI 助手';
  const isLoading = contentHtml === 'loading';
  div.innerHTML = `<div class="role">${roleName}</div><div class="bubble${isLoading ? ' is-loading' : ''}">${isLoading ? loadingHtml('思考中') : contentHtml}</div>`;
  if (sources && sources.length) {
    const src = document.createElement('div');
    src.className = 'sources';
    src.textContent = '参考笔记：' + sources.map((n) => n.title || '无标题').join('、');
    div.appendChild(src);
  }
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

function cleanupAiListeners() {
  aiListeners.forEach((off) => off());
  aiListeners = [];
}

// 回答中时发送按钮切换为“停止”：不禁用，点击即中断当前回答并恢复可发送；
// 主进程经 ai:error('已停止回答。') 上报后 finish() 会自动调 setAiSendBusy(false)
function setAiSendBusy(busy) {
  ['btn-ai-send', 'btn-ai-view-send'].forEach((id) => {
    const b = $(id);
    if (!b) return;
    b.disabled = false;
    b.classList.toggle('btn-stop', busy);
    b.textContent = busy ? '■ 停止' : '发送';
  });
}
function stopAiRequest() {
  // 渲染端立即拆解（恢复可发送/清状态/收起步骤），再通知主进程中断 fetch
  if (stopCurrentAi) { const f = stopCurrentAi; stopCurrentAi = null; try { f(); } catch (_) {} }
  if (window.kb.aiStop) window.kb.aiStop();
}

async function sendAiQuestion() {
  // 回答中再点发送 = 停止当前回答（避免按钮锁死无法发新问题）
  if (state.aiBusy) { stopAiRequest(); return; }
  const input = $('ai-input');
  const question = input.value.trim();
  if (!question) return;
  input.value = '';

  addAiMessage('user', escapeHtml(question));

  // 笔记/图谱/原始文件检索统一由主进程 knowledge 层完成（随勾选开关），
  // 这里不再本地重复检索；参考引用经 ai:refs 事件回传展示
  const messages = [
    { role: 'system', content: '你是个人知识库助手，请简洁、准确地回答问题。' },
    ...aiHistory.slice(-8),
    { role: 'user', content: question },
  ];

  const msgEl = addAiMessage('assistant', 'loading');
  const bubble = msgEl.querySelector('.bubble');

  state.aiBusy = true;
  setAiSendBusy(true);
  cleanupAiListeners();

  let answer = '';
  const offChunk = window.kb.onAiChunk((chunk) => {
    answer += chunk;
    bubble.innerHTML = renderMarkdown(answer);
    $('ai-messages').scrollTop = $('ai-messages').scrollHeight;
  });
  const offDone = window.kb.onAiDone(() => {
    finish(true);
  });
  const offError = window.kb.onAiError((message) => {
    if (!answer) {
      msgEl.remove();
      addAiMessage('error', escapeHtml(message));
    } else {
      bubble.innerHTML = renderMarkdown(answer + `\n\n> ⚠ ${message}`);
    }
    finish(false);
  });
  aiListeners = [offChunk, offDone, offError];
  stopCurrentAi = () => {
    cleanupAiListeners();
    state.aiBusy = false;
    bubble.classList.remove('is-loading');
    bubble.innerHTML = renderMarkdown((answer ? answer + '\n\n' : '') + '> ⚠ 已停止。');
    setAiSendBusy(false);
  };

  function finish(ok) {
    stopCurrentAi = null;
    state.aiBusy = false;
    setAiSendBusy(false);
    cleanupAiListeners();
    if (answer) {
      // 仅完全成功才写入历史，避免残缺回答污染后续上下文
      if (ok) aiHistory.push({ role: 'user', content: question });
      if (ok) aiHistory.push({ role: 'assistant', content: answer });
      if (ok) saveAiHistory();
      bubble.classList.remove('is-loading');
      bubble.innerHTML = renderMarkdown(answer);
    }
  }

  await window.kb.askAI(buildAskPayload(messages, question));
}

// AI 问答数据源多选：加载/应用/绑定
function loadAiSources() {
  try {
    const s = JSON.parse(localStorage.getItem('kb.aiSources') || 'null');
    if (s && typeof s === 'object') {
      // 知识源默认都不选择：仅当用户明确勾选过（存为 true）才开启，未存过的源保持关闭
      const next = {};
      AI_SOURCE_DEFS.forEach(([k]) => { next[k] = s[k] === true; });
      state.aiSources = next;
    }
  } catch (_) {}
}

// 知识源定义（key/图标/名称）：以主进程 knowledge 层的注册表为准，
// 这里的内置值仅作为 IPC 还未返回前的兜底（新增知识源只需在主进程 register）
// 图标列统一为 SVG sprite 的 symbol 名（渲染时用 icoSvg 展开）
// AI_SRC_ICON_MAP 定义于 renderer/constants.js
let AI_SOURCE_DEFS = [
  ['notes', 'notes', '笔记'],
  ['graph', 'kg', '知识图谱'],
  ['raws', 'folder-open', '原始文件'],
];

// 从主进程拉取知识源清单，并为新源补默认开关（启动时调一次）
async function loadKnowledgeSourceDefs() {
  try {
    const list = await window.kb.knowledgeSources();
    if (Array.isArray(list) && list.length) {
      AI_SOURCE_DEFS = list.map((s) => [s.key, AI_SRC_ICON_MAP[s.key] || 'book', s.label || s.key]);
      // 新接入的知识源默认不勾选，与「默认都不选择」的初始状态一致
      AI_SOURCE_DEFS.forEach(([k]) => { if (state.aiSources[k] === undefined) state.aiSources[k] = false; });
      applyAiSources();
    }
  } catch (e) { console.warn('知识源清单获取失败，暂用内置默认：', e); }
}

// ---------- 知识图谱源的范围（两级：体系 → 具体知识图谱；仅勾选「知识图谱」时生效） ----------
// state.aiGraphScopes: string[] —— 'all' 或若干具体图谱 id（`profile|domain` / `profile|*`）
function loadAiGraphScopes() {
  try {
    const raw = localStorage.getItem('kb.aiGraphScopes');
    if (raw) {
      const arr = JSON.parse(raw);
      state.aiGraphScopes = Array.isArray(arr) && arr.length ? arr : ['all'];
      return;
    }
    // 兼容旧单选 aiGraphProfile
    const old = localStorage.getItem('kb.aiGraphProfile');
    state.aiGraphScopes = old && old !== 'all' ? [`${old}|*`] : ['all'];
  } catch (_) { state.aiGraphScopes = ['all']; }
}
function saveAiGraphScopes() {
  try { localStorage.setItem('kb.aiGraphScopes', JSON.stringify(state.aiGraphScopes || ['all'])); } catch (_) {}
}
// 拉取体系清单 + 具体图谱分组（进入 AI 问答页时刷新）
async function loadGraphProfiles() {
  try {
    const [list, scopes] = await Promise.all([
      window.kb.graphProfiles(),
      window.kb.graphScopes ? window.kb.graphScopes() : Promise.resolve([]),
    ]);
    if (Array.isArray(list)) state.graphProfiles = list;
    state.graphScopes = Array.isArray(scopes) ? scopes : [];
    // 已选范围失效（体系/图谱被删）时清理，留空回退 all
    const valid = new Set(['all']);
    (state.graphProfiles || []).forEach((p) => valid.add(`${p.id}|*`));
    (state.graphScopes || []).forEach((s) => valid.add(s.id));
    state.aiGraphScopes = (state.aiGraphScopes || ['all']).filter((x) => valid.has(x));
    if (!state.aiGraphScopes.length) state.aiGraphScopes = ['all'];
    saveAiGraphScopes();
    renderAiSrcBar();
  } catch (e) { console.warn('图谱范围清单获取失败：', e); }
}
// 范围展示名（按钮文本）
function graphScopeLabel() {
  const sel = state.aiGraphScopes || ['all'];
  if (sel.includes('all')) return '全部';
  const names = sel.map((id) => {
    if (id.endsWith('|*')) {
      const pid = id.slice(0, -2);
      const p = (state.graphProfiles || []).find((x) => x.id === pid);
      return (p ? (p.name || pid) : pid);
    }
    const s = (state.graphScopes || []).find((x) => x.id === id);
    return s ? s.label : id;
  });
  if (names.length <= 2) return names.join('、');
  return `${names[0]} 等${names.length}项`;
}
// 构造传给后端的 graphScope 字符串（all 或多选逗号分隔）
function graphScopeParam() {
  const sel = state.aiGraphScopes || ['all'];
  return sel.includes('all') ? 'all' : sel.join(',');
}

// 级联范围菜单：一级=「全部」+ 各体系；体系有图谱时 hover 右侧飞出二级子菜单（整个体系 + 各具体图谱）
function renderGraphProfileMenu(menu) {
  if (!menu) return;
  menu.innerHTML = '';
  const sel = new Set(state.aiGraphScopes || ['all']);
  // 搜索过滤框（搜到时平铺显示，搜空回到级联结构）
  const search = document.createElement('input');
  search.type = 'text';
  search.className = 'ai-src-sub-search';
  search.placeholder = '搜索体系 / 图谱…';
  search.addEventListener('click', (e) => e.stopPropagation());
  menu.appendChild(search);
  const list = document.createElement('div');
  list.className = 'ai-src-sub-list';
  menu.appendChild(list);

  const apply = () => {
    state.aiGraphScopes = sel.has('all') || !sel.size ? ['all'] : [...sel];
    saveAiGraphScopes();
    // 只更新按钮文本，不重建整条 bar（避免菜单被销毁）
    const btn = menu.closest('.ai-src-sub')?.querySelector('.ai-src-sub-btn');
    if (btn) btn.innerHTML = `${escapeHtml(graphScopeLabel())} ▾`;
  };
  const refreshBoxes = () => {
    [...menu.querySelectorAll('.gp-row')].forEach((row) => {
      const on = sel.has(row.dataset.id) || (sel.has('all') && row.dataset.id === 'all');
      row.classList.toggle('cur', on);
      const box = row.querySelector('.gp-box'); if (box) box.textContent = on ? '✓' : '';
    });
  };
  // 单个可勾选行（一级/二级共用）
  const mkRow = ({ id, label, desc }) => {
    const d = document.createElement('div');
    d.className = 'ext-item gp-row' + (sel.has(id) ? ' cur' : '');
    d.dataset.id = id;
    d.dataset.q = `${label} ${desc || ''}`.toLowerCase();
    d.innerHTML = `<span class="gp-box">${sel.has(id) ? '✓' : ''}</span><span class="gp-txt">${escapeHtml(label)}${desc ? `<i class="gp-desc">${escapeHtml(desc)}</i>` : ''}</span>`;
    d.addEventListener('click', (e) => {
      e.stopPropagation();
      if (id === 'all') { sel.clear(); sel.add('all'); }
      else {
        sel.delete('all');
        if (sel.has(id)) sel.delete(id); else sel.add(id);
      }
      apply();
      refreshBoxes();
    });
    return d;
  };
  // 体系行：本身可勾「整个体系」；有图谱时右侧飞出二级菜单勾具体图谱
  const mkProfileRow = (p, kids) => {
    const cls = (p.counts && p.counts.classes) || 0;
    const total = kids.reduce((a, b) => a + b.nodeCount, 0);
    const wrap = document.createElement('div');
    wrap.className = 'gp-prof';
    const hasKids = kids.length > 0;
    const rowId = `${p.id}|*`;
    const row = document.createElement('div');
    row.className = 'ext-item gp-row gp-prof-row' + (sel.has(rowId) ? ' cur' : '');
    row.dataset.id = rowId;
    row.dataset.q = `${p.name || p.id}`.toLowerCase();
    row.innerHTML =
      `<span class="gp-box">${sel.has(rowId) ? '✓' : ''}</span>` +
      `<span class="gp-txt">${escapeHtml(p.name || p.id)}<i class="gp-desc">${hasKids ? `${total} 节点` : `${cls} 类·无节点`}</i></span>` +
      (hasKids ? '<span class="gp-caret">›</span>' : '');
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      sel.delete('all');
      if (sel.has(rowId)) sel.delete(rowId); else sel.add(rowId);
      apply();
      refreshBoxes();
    });
    wrap.appendChild(row);
    if (hasKids) {
      // 二级飞出菜单：整个体系 + 各具体图谱
      const fly = document.createElement('div');
      fly.className = 'gp-fly';
      fly.appendChild(mkRow({ id: rowId, label: '整个体系', desc: `${total} 节点` }));
      kids.forEach((s) => fly.appendChild(mkRow({ id: s.id, label: s.label, desc: `${s.nodeCount} 节点` })));
      wrap.appendChild(fly);
      // 同步一级行的选中态：勾「整个体系」或任一子图谱都让体系行高亮
      fly.addEventListener('click', () => setTimeout(() => {
        const any = sel.has(rowId) || kids.some((s) => sel.has(s.id));
        row.classList.toggle('cur', any);
      }));
    }
    return wrap;
  };

  // 一级：全部
  list.appendChild(mkRow({ id: 'all', label: '全部知识图谱', desc: '不区分体系/图谱' }));
  const scopesByProfile = {};
  (state.graphScopes || []).forEach((s) => { (scopesByProfile[s.profile] = scopesByProfile[s.profile] || []).push(s); });
  (state.graphProfiles || []).forEach((p) => {
    list.appendChild(mkProfileRow(p, scopesByProfile[p.id] || []));
  });
  // 搜索：匹配的行平铺展示（体系行命中或子图谱命中）；搜空恢复级联
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    [...menu.querySelectorAll('.gp-row')].forEach((row) => {
      row.style.display = !q || (row.dataset.q || '').includes(q) ? '' : 'none';
    });
    menu.classList.toggle('gp-flat', !!q); // 平铺模式：子菜单不再飞出，统一平铺便于过滤
  });
  setTimeout(() => search.focus(), 0);
}

// 知识源选择条（输入框上方平铺）：点一下即勾选/取消，与侧边面板的复选框共用 state.aiSources
function renderAiSrcBar() {
  const bar = $('ai-src-bar');
  if (!bar) return;
  bar.innerHTML = '';
  const head = document.createElement('span');
  head.className = 'ai-src-head';
  head.textContent = '知识源';
  bar.appendChild(head);
  AI_SOURCE_DEFS.forEach(([k, icon, label]) => {
    const on = !!(state.aiSources && state.aiSources[k]);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'ai-src-chip' + (on ? ' on' : '');
    chip.title = on ? `已启用「${label}」作为知识源，点击取消` : `点击启用「${label}」作为知识源`;
    chip.innerHTML = `<span class="chip-box">${on ? '✓' : ''}</span>${icoSvg(icon, 13)} ${escapeHtml(label)}`;
    chip.addEventListener('click', () => {
      state.aiSources[k] = !state.aiSources[k];
      localStorage.setItem('kb.aiSources', JSON.stringify(state.aiSources));
      applyAiSources();
    });
    bar.appendChild(chip);
    // 知识图谱源：勾选后追加体系范围子选择（可选全部知识图谱，也可指定某个体系）
    if (k === 'graph' && on) {
      const pick = document.createElement('div');
      pick.className = 'ai-src-sub';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ai-src-sub-btn';
      btn.title = '选择知识图谱范围：全部，或指定体系 / 具体图谱（可多选）';
      btn.innerHTML = `${escapeHtml(graphScopeLabel())} ▾`;
      const menu = document.createElement('div');
      menu.className = 'ai-ext-menu ai-src-sub-menu';
      menu.hidden = true;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (menu.hidden) { renderGraphProfileMenu(menu); menu.hidden = false; } else menu.hidden = true;
      });
      document.addEventListener('click', (e) => {
        if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) menu.hidden = true;
      });
      pick.appendChild(btn);
      pick.appendChild(menu);
      bar.appendChild(pick);
    }
  });
}

function applyAiSources() {
  if ($('ai-src-notes')) $('ai-src-notes').checked = state.aiSources.notes;
  if ($('ai-src-graph')) $('ai-src-graph').checked = state.aiSources.graph;
  if ($('ai-src-raws')) $('ai-src-raws').checked = state.aiSources.raws;
  renderAiSrcBar();
  const names = [];
  if (state.aiSources.notes) names.push('笔记');
  if (state.aiSources.graph) names.push('知识图谱');
  if (state.aiSources.raws) names.push('原始文件');
  $('ai-hint').textContent = names.length
    ? `基于所选数据源回答：${names.join(' + ')}。`
    : '未选择数据源，模型将用自身知识回答。';
  renderAiExt();
}

function bindAiSources() {
  ['notes', 'graph', 'raws'].forEach((k) => {
    $('ai-src-' + k).addEventListener('change', (e) => {
      state.aiSources[k] = e.target.checked;
      localStorage.setItem('kb.aiSources', JSON.stringify(state.aiSources));
      applyAiSources();
    });
  });
}

// ---------- AI 问答可选 MCP / Skills（来自设置·扩展） ----------
// 语义：已启用的 MCP/技能**默认全部参与**，用户可逐个去除；
// 因此持久化的是「已去除名单」（off）而非「已勾选名单」
function loadAiExt() {
  try {
    const s = JSON.parse(localStorage.getItem('kb.aiExtOff') || 'null');
    if (s && typeof s === 'object') state.aiExt = { mcpOff: s.mcpOff || [], skillsOff: s.skillsOff || [] };
  } catch (_) {}
  if (!state.aiExt) state.aiExt = { mcpOff: [], skillsOff: [] };
}
function saveAiExt() {
  try { localStorage.setItem('kb.aiExtOff', JSON.stringify(state.aiExt)); } catch (_) {}
}
const mcpOffSet = () => new Set((state.aiExt && state.aiExt.mcpOff) || []);
const skillOffSet = () => new Set((state.aiExt && state.aiExt.skillsOff) || []);

// 本次问答实际生效的 MCP / 技能 = 已启用 − 已去除
function effectiveMcps() {
  const off = mcpOffSet();
  return ((state.settings || {}).mcpServers || []).filter((m) => m && m.name && m.enabled !== false && !off.has(m.name));
}
function effectiveSkills() {
  const off = skillOffSet();
  return ((state.settings || {}).skills || []).filter((k) => k && k.name && k.enabled && !off.has(k.name));
}
// 切换参与状态（on ↔ off）
function toggleExtOff(kind, name) {
  const key = kind === 'mcp' ? 'mcpOff' : 'skillsOff';
  const set = new Set(state.aiExt[key] || []);
  if (set.has(name)) set.delete(name); else set.add(name);
  state.aiExt[key] = [...set];
  saveAiExt();
}
function renderAiExt() {
  const box = $('ai-ext-row'); if (!box) return;
  const s = state.settings || {};
  const mcps = (s.mcpServers || []).filter((m) => m.enabled !== false && m.name);
  const skills = (s.skills || []).filter((k) => k.enabled && k.name);
  if (!mcps.length && !skills.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = '';
  const mk = (kind, icon, item) => {
    const lab = document.createElement('label');
    lab.className = 'src-cb';
    const off = (kind === 'mcp' ? mcpOffSet() : skillOffSet()).has(item.name);
    lab.innerHTML = `<input type="checkbox" ${off ? '' : 'checked'}> ${icon} ${escapeHtml(item.name)}`;
    lab.querySelector('input').addEventListener('change', () => {
      toggleExtOff(kind, item.name);
      refreshAiExtTitles();
      refreshAllExtMenus();
    });
    box.appendChild(lab);
  };
  mcps.forEach((m) => mk('mcp', icoSvg('mcp', 12), m));
  skills.forEach((k) => mk('skill', icoSvg('skill', 12), k));
}
// 本次问答生效的 MCP 服务器配置（供后端列出/调用工具）；全部被去除时为空数组
function selectedMcpCfgs() {
  return effectiveMcps();
}

// 统一构造 ai:ask 请求载荷：数据源勾选、生效技能、MCP 名单、扩展提示一次带齐。
// 检索/引用/工具装载全部由主进程 knowledge 层与 MCP 层完成，渲染层只表达「本次选了什么」
function buildAskPayload(messages, question) {
  return {
    settings: aiSettings(),
    messages,
    sources: { ...(state.aiSources || {}) },
    // 知识图谱源的范围（未勾选图谱时主进程不检索，此字段无副作用）
    graphProfile: 'all',
    graphScope: graphScopeParam(),
    skillNames: effectiveSkills().map((k) => k.name),
    extHint: extHint(question),
    extMcp: selectedMcpCfgs(),
  };
}

// ---------- 模型选择（两级：provider → 具体模型；默认主模型） ----------
// 选中项仅作用于 AI 问答请求：按条目自带的 baseUrl / apiKey / model 覆盖 settings；
// 其余流程（作业、模版生成等）仍用设置页的默认主模型
function loadAiModel() {
  try { state.aiModelId = localStorage.getItem('kb.aiModelId') || '__primary__'; }
  catch (_) { state.aiModelId = '__primary__'; }
}

function setAiModel(id) {
  state.aiModelId = id || '__primary__';
  try { localStorage.setItem('kb.aiModelId', state.aiModelId); } catch (_) {}
  refreshAiModelUi();
}

// 当前生效模型；所选条目已被删除时回退主模型
function currentAiModel() {
  const list = modelEntryList();
  return list.find((m) => m.id === state.aiModelId) || list[0];
}

// 本次请求生效的 settings：非主模型时覆盖接口地址/密钥/模型名。
// Ollama（本地）允许无 Key；阿里云条目留空时回退主模型的 Key
function aiSettings() {
  const base = state.settings || {};
  const m = currentAiModel();
  if (!m || m.primary) return base;
  const key = m.apiKey || (providerNeedsKey(m.provider) ? (base.apiKey || '') : '');
  return { ...base, apiProvider: m.provider, apiBaseUrl: m.baseUrl || base.apiBaseUrl, apiKey: key, model: m.model };
}

// 按钮回显当前模型名
function refreshAiModelUi() {
  const lab = $('ai-model-label');
  if (lab) {
    const m = currentAiModel();
    lab.textContent = m && m.model ? m.model : '选择模型';
    const btn = $('btn-ai-model');
    if (btn) btn.title = m ? `当前模型：${providerLabel(m.provider)} / ${m.model || '(未填)'}${m.primary ? '（默认）' : ''}` : '选择模型';
  }
  const menu = $('ai-menu-model');
  if (menu && !menu.hidden) renderAiModelMenu(menu);
}

// 两级菜单：按 provider 分组，组内列出该 provider 下已配置的模型
function renderAiModelMenu(menuEl) {
  const menu = menuEl || $('ai-menu-model');
  if (!menu) return;
  menu.innerHTML = '';
  const cur = currentAiModel();
  const groups = [];
  modelEntryList().forEach((m) => {
    let g = groups.find((x) => x.provider === m.provider);
    if (!g) { g = { provider: m.provider, items: [] }; groups.push(g); }
    g.items.push(m);
  });
  groups.forEach((g) => {
    const head = document.createElement('div');
    head.className = 'ext-group';
    head.textContent = providerLabel(g.provider);
    menu.appendChild(head);
    g.items.forEach((m) => {
      const on = cur && cur.id === m.id;
      const noKey = !m.apiKey && providerNeedsKey(m.provider) && !m.primary;
      const d = document.createElement('div');
      d.className = 'ext-item';
      d.innerHTML = `<span>${escapeHtml(m.model || '(未填模型名)')}`
        + (m.primary ? '<span class="ext-tag">默认</span>' : '')
        + (noKey ? '<span class="ext-tag warn" title="未配专用 Key，调用时回退使用默认模型的 Key">无 Key</span>' : '')
        + '</span>' + (on ? '<span class="chk">✓</span>' : '');
      d.addEventListener('click', (e) => {
        e.stopPropagation();
        setAiModel(m.id);
        menu.hidden = true;
        toast(`已切换模型：${providerLabel(m.provider)} / ${m.model}`);
      });
      menu.appendChild(d);
    });
  });
  // 分组始终可见 + 空状态引导（与技能组一致的交互约定）
  const tip = document.createElement('div');
  tip.className = 'ext-item';
  tip.style.opacity = '.55';
  tip.textContent = '到 设置→模型配置 添加更多模型';
  menu.appendChild(tip);
}

function bindAiModelPicker() {
  const btn = $('btn-ai-model');
  const menu = $('ai-menu-model');
  if (!btn || !menu) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) { renderAiModelMenu(menu); menu.hidden = false; } else menu.hidden = true;
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) menu.hidden = true;
  });
  refreshAiModelUi();
}

// 输入行下拉：显式选择技能 / MCP（与上方 chips 同步）
function renderAiExtMenu(menuEl, groups) {
  const menu = menuEl || $('ai-ext-menu'); if (!menu) return;
  const want = (g) => !groups || groups.includes(g);
  const s = state.settings || {};
  const mcps = (s.mcpServers || []).filter((m) => m.enabled && m.name);
  const skills = (s.skills || []).filter((k) => k.enabled && k.name);
  menu.innerHTML = '';
  // 知识源三类（checkbox 选定）
  if (want('sources')) {
    const sg = document.createElement('div'); sg.className = 'ext-group'; sg.textContent = '知识源'; menu.appendChild(sg);
    AI_SOURCE_DEFS.forEach(([k, icon, label]) => {
      const on = !!(state.aiSources && state.aiSources[k]);
      const d = document.createElement('div');
      d.className = 'ext-item';
      d.innerHTML = `<span>${icoSvg(icon, 12)} ${label}</span>${on ? '<span class="chk">✓</span>' : ''}`;
      d.addEventListener('click', (e) => {
        e.stopPropagation();
        state.aiSources[k] = !state.aiSources[k];
        localStorage.setItem('kb.aiSources', JSON.stringify(state.aiSources));
        applyAiSources();
        renderAiExtMenu(menu, groups);
      });
      menu.appendChild(d);
    });
  }
  const item = (kind, icon, name) => {
    // 默认参与：未被去除则显示✓；点击即去除/恢复
    const off = (kind === 'mcp' ? mcpOffSet() : skillOffSet()).has(name);
    const d = document.createElement('div');
    d.className = 'ext-item' + (off ? ' off' : '');
    d.innerHTML = `<span>${icon} ${escapeHtml(name)}</span>${off ? '' : '<span class="chk">✓</span>'}`;
    d.title = off ? '已去除，点击恢复使用' : '默认参与，点击去除';
    d.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleExtOff(kind, name);
      renderAiExt();
      refreshAiExtTitles();
      renderAiExtMenu(menu, groups);
    });
    menu.appendChild(d);
  };
  if (want('skills')) {
    const g = document.createElement('div'); g.className = 'ext-group'; g.textContent = '技能'; menu.appendChild(g);
    if (skills.length) skills.forEach((k) => item('skill', icoSvg('skill', 12), k.name));
    else { const h = document.createElement('div'); h.className = 'ext-item'; h.style.opacity = '.55'; h.textContent = '到 设置→技能 添加'; menu.appendChild(h); }
  }
  if (want('mcp')) {
    if (mcps.length) { const g = document.createElement('div'); g.className = 'ext-group'; g.textContent = 'MCP'; menu.appendChild(g); mcps.forEach((m) => item('mcp', icoSvg('mcp', 12), m.name)); }
  }
}
// 输入区 🧩/⚡ 按钮的悬停提示：以「参与数/总数」体现当前状态。
// 不再在输入区用 chips 平铺（默认全部参与时会占据两行），去除入口在菜单内
function refreshAiExtTitles() {
  const s = state.settings || {};
  const allM = (s.mcpServers || []).filter((m) => m && m.name && m.enabled !== false).length;
  const allK = (s.skills || []).filter((k) => k && k.name && k.enabled).length;
  const mb = $('btn-ai-mcp');
  if (mb) mb.title = allM ? `MCP 服务器（${effectiveMcps().length}/${allM} 参与，点击可去除）` : '选择 MCP 服务器';
  const kb = $('btn-ai-skill');
  if (kb) kb.title = allK ? `技能（${effectiveSkills().length}/${allK} 参与，点击可去除）` : '选择技能';
}
// ---------- 执行步骤组（过程折叠块，位于答案上方） ----------
// 运行中展开并实时追加；结束后折叠为「查看 N 个步骤」，可展开查看参数与结果
function createStepsGroup() {
  const wrap = document.createElement('div');
  wrap.className = 'ai-steps';
  wrap.innerHTML =
    '<button type="button" class="ai-steps-head"><span class="ai-steps-ico">' + icoSvg('search', 12) + '</span>' +
    '<span class="ai-steps-label">准备中…</span><span class="ai-steps-caret">▾</span></button>' +
    '<div class="ai-steps-body"></div>';
  const head = wrap.querySelector('.ai-steps-head');
  const label = wrap.querySelector('.ai-steps-label');
  const body = wrap.querySelector('.ai-steps-body');
  let open = true;
  const setOpen = (v) => { open = v; body.hidden = !v; wrap.classList.toggle('collapsed', !v); };
  head.addEventListener('click', () => setOpen(!open));
  const steps = [];
  let lastToolRec = null;
  let liveThinking = null;
  return {
    el: wrap,
    steps,
    addStep(s) {
      if (s.kind === 'tool-result') {
        if (lastToolRec) {
          lastToolRec.result = s.text || '';
          // 主进程从完整返回提取的参考链接（result 已被截断，不可再解析）
          if (Array.isArray(s.links) && s.links.length) lastToolRec.links = s.links;
          if (lastToolRec.detailEl) lastToolRec.detailEl.textContent = (lastToolRec.args || '') + '\n—— 返回 ——\n' + (s.text || '');
          // 生图/文件类工具：把返回里的图片链接渲染成可点击预览
          if (lastToolRec.detailEl) appendImagePreview(lastToolRec.detailEl.parentElement, s.text, '工具返回的图片');
        }
        return;
      }
      // thinking 增量：合并进同一条折叠块；流式期间展开实时打印，结束后由 finish() 统一收起
      if (s.kind === 'thinking') {
        if (liveThinking) {
          liveThinking.text += s.text || '';
          if (liveThinking.detailEl) {
            liveThinking.detailEl.textContent = liveThinking.text;
            liveThinking.detailEl.scrollTop = liveThinking.detailEl.scrollHeight;
          }
        } else {
          const rec = { kind: 'thinking', text: s.text || '' };
          steps.push(rec);
          const d = document.createElement('details');
          d.className = 'ai-step-item thought';
          d.open = true;
          d.innerHTML = '<summary>思考过程（实时输出，点击可收起）</summary><div class="ai-step-detail"></div>';
          rec.detailEl = d.querySelector('.ai-step-detail');
          rec.detailEl.textContent = rec.text;
          body.appendChild(d);
          liveThinking = rec;
        }
        label.textContent = '思考中…';
        body.scrollTop = body.scrollHeight;
        return;
      }
      const rec = { kind: s.kind, name: s.name || '', args: s.args || '', text: s.text || '', result: '' };
      steps.push(rec);
      const d = document.createElement('details');
      d.className = 'ai-step-item ' + (s.kind === 'tool' ? 'tool' : 'thought');
      const lab = s.kind === 'tool' ? '调用工具：' + (s.name || '') : String(s.text || '').slice(0, 60);
      d.innerHTML = '<summary>' + escapeHtml(lab) + '</summary><div class="ai-step-detail"></div>';
      rec.detailEl = d.querySelector('.ai-step-detail');
      rec.detailEl.textContent = s.kind === 'tool' ? (s.args || '') : (s.text || '');
      body.appendChild(d);
      if (s.kind === 'tool') { lastToolRec = rec; liveThinking = null; }
      // 折叠头也显示当前阶段，避免长时间停在笼统的“思考中…”
      label.textContent = s.kind === 'tool'
        ? '调用工具：' + (s.name || '')
        : (s.text ? String(s.text).slice(0, 34) : '思考中…');
      body.scrollTop = body.scrollHeight;
    },
    finish() {
      const kept = steps.filter((x) => x.kind !== 'tool-result');
      const n = kept.length;
      if (!n) { wrap.remove(); return; }
      // 结束后收起流式期间展开的思考块
      wrap.querySelectorAll('details[open]').forEach((x) => { x.open = false; });
      // 正文一出现就会覆盖气泡里的实时思考，所以折叠头必须说清里面还留着什么，
      // 否则看上去就像工具调用与思考过程消失了
      const nTool = kept.filter((x) => x.kind === 'tool').length;
      const nThink = kept.filter((x) => x.kind === 'thinking').length;
      const parts = [];
      if (nTool) parts.push(`工具调用 ${nTool} 次`);
      if (nThink) parts.push(`思考 ${nThink} 段`);
      label.textContent = parts.length
        ? `查看执行过程：${parts.join(' · ')}（共 ${n} 步）`
        : `查看执行过程（共 ${n} 步）`;
      wrap.classList.add('done');
      setOpen(false);
    },
  };
}
// 实时状态栏：输入框上方显示当前活动与耗时（参考「考虑中… 2.0s」）
function startStatusbar() {
  const el = $('ai-view-status');
  if (!el) return { set() {}, stop() {} };
  el.hidden = false;
  const t0 = Date.now();
  let text = '思考';
  const tick = () => {
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    el.textContent = /[…。！]$/.test(text) ? `● ${text} ${sec}s` : `● ${text}中… ${sec}s`;
  };
  tick();
  const timer = setInterval(tick, 100);
  return {
    set(t) { text = t; tick(); },
    stop() { clearInterval(timer); el.hidden = true; },
  };
}
// 拆分 ```ask 澄清问题块：返回 { preamble, questions|null }
function splitAsk(text) {
  const m = String(text).match(/```ask\s*\n([\s\S]*?)```/);
  if (!m) return { preamble: text, questions: null };
  let qs = null;
  try { qs = JSON.parse(m[1]); } catch (_) { return { preamble: text, questions: null }; }
  if (!Array.isArray(qs) || !qs.length) return { preamble: text, questions: null };
  qs = qs.filter((x) => x && x.q && Array.isArray(x.options) && x.options.length).slice(0, 3);
  if (!qs.length) return { preamble: text, questions: null };
  const preamble = (String(text).slice(0, m.index) + String(text).slice(m.index + m[0].length)).trim();
  return { preamble, questions: qs };
}
// 澄清问题卡片：单选/多选 + 跳过/继续，提交后回调续跑
function renderAskCard(msgEl, questions, onSubmit) {
  const card = document.createElement('div');
  card.className = 'ai-ask-card';
  const sel = questions.map(() => new Set());
  questions.forEach((q, qi) => {
    const multi = q.type === 'multi';
    const h = document.createElement('div');
    h.className = 'ai-ask-q';
    h.innerHTML = `${qi + 1}. ${escapeHtml(q.q)}<span class="ai-ask-type">${multi ? '多选' : '单选'}</span>`;
    card.appendChild(h);
    (q.options || []).forEach((op, oi) => {
      const row = document.createElement('div');
      row.className = 'ai-ask-opt';
      if (!multi) row.dataset.single = '1';
      row.innerHTML = `<span class="box"></span><span class="txt"><span class="t">${escapeHtml(op.t || '')}</span>${op.d ? `<span class="d">${escapeHtml(op.d)}</span>` : ''}</span>`;
      row.addEventListener('click', () => {
        if (multi) {
          if (sel[qi].has(oi)) sel[qi].delete(oi); else sel[qi].add(oi);
        } else {
          sel[qi].clear(); sel[qi].add(oi);
          card.querySelectorAll(`[data-q="${qi}"]`).forEach((r) => r.classList.remove('sel'));
        }
        row.classList.toggle('sel', sel[qi].has(oi));
      });
      row.dataset.q = String(qi);
      card.appendChild(row);
    });
  });
  const foot = document.createElement('div');
  foot.className = 'ai-ask-foot';
  const mkBtn = (txt, cls, fn) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn ' + cls; b.textContent = txt;
    b.addEventListener('click', fn);
    foot.appendChild(b);
    return b;
  };
  const submit = (skipped) => {
    const lines = questions.map((q, qi) => {
      const chosen = [...sel[qi]].map((oi) => (q.options[oi] || {}).t).filter(Boolean);
      const a = skipped ? '（跳过）' : (chosen.length ? chosen.join('、') : '（由你决定）');
      return `${q.q} → ${a}`;
    });
    card.remove();
    onSubmit(`【澄清回答】\n${lines.join('\n')}`);
  };
  mkBtn('跳过', 'btn-ghost', () => submit(true));
  mkBtn('继续', 'btn-primary', () => submit(false));
  card.appendChild(foot);
  msgEl.appendChild(card);
  $('ai-view-messages').scrollTop = 9e9;
}
function bindAiExtPicker(btnId, menuId, groups) {
  const btn = $(btnId || 'btn-ai-ext'); const menu = $(menuId || 'ai-ext-menu');
  if (!btn || !menu) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) { renderAiExtMenu(menu, groups); menu.hidden = false; } else menu.hidden = true;
  });
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) menu.hidden = true; });
}
// 刷新两个分类菜单（MCP/技能）；知识源已改为输入框上方平铺选择，不再走菜单
function refreshAllExtMenus() {
  renderAiExtMenu($('ai-menu-mcp'), ['mcp']);
  renderAiExtMenu($('ai-menu-skill'), ['skills']);
}
function extHint(question) {
  const mcps = effectiveMcps();
  // 技能 = 默认参与的（已启用且未去除）∩ 不包含被用户显式去除的关键词自动项
  const skills = effectiveSkills();
  const auto = autoSkillNames(question);
  if (!mcps.length && !skills.length) return '';
  const parts = [];
  if (mcps.length) parts.push('可用 MCP 服务器：' + mcps.map((m) => {
    const detail = m.type === 'stdio' ? [m.command, ...(m.args || [])].filter(Boolean).join(' ') : (m.url || '');
    return `${m.name}（${m.type || 'stdio'}${detail ? '：' + detail : ''}${m.useModelKey ? '，使用模型 API Key' : ''}）`;
  }).join('、'));
  if (skills.length) parts.push('启用技能：' + skills.map((k) => `${k.name}${k.desc ? '（' + k.desc + '）' : ''}${k.instructions ? '：' + k.instructions : ''}`).join('、'));
  const autoNote = auto.length ? `其中 ${auto.join('、')} 与用户请求格式直接匹配，须按对应技能指令完成，不得声称无法执行。` : '';
  return '【可用扩展能力】' + parts.join('；') + '。' + autoNote + '请在回答中酌情运用。';
}
// 用户明确提及格式关键词时自动启用对应已启用技能（pptx/docx/xlsx 及常见别名）
function autoSkillNames(question) {
  const q = String(question || '').toLowerCase();
  if (!q) return [];
  const aliases = {
    pptx: ['ppt', '幻灯片', '演示文稿', 'slides'],
    docx: ['word'],
    xlsx: ['excel', '电子表格'],
  };
  return effectiveSkills().filter((k) => {
    const n = String(k.name).toLowerCase();
    if (q.includes(n)) return true;
    return (aliases[n] || []).some((a) => q.includes(a));
  }).map((k) => k.name);
}

// ---------- 答案附属展示：来源条 / 操作行 / 产物卡片 ----------
function fmtElapsed(ms) {
  const s = Math.max(1, Math.round((ms || 0) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}
// 从工具结果中提取引用来源（url + title），渲染为可点击来源条
function collectSources(steps) {
  const out = []; const seen = new Set();
  for (const st of (steps || [])) {
    // 优先用主进程从完整返回提取的 links（下发的 result 被截断，JSON 解不开）
    for (const l of (st.links || [])) {
      if (!l || !l.url || seen.has(l.url)) continue;
      seen.add(l.url);
      out.push({ url: l.url, title: l.title || l.url, snippet: String(l.snippet || '').slice(0, 160) });
    }
    // 旧会话兼容：当时未下发 links，尝试从已存的 result 解析
    const text = st.kind === 'tool-result' ? st.result : (st.kind === 'tool' ? st.result : '');
    if (!text) continue;
    let j = null;
    try { j = JSON.parse(text); } catch (_) {}
    if (!j || typeof j !== 'object') continue;
    for (const key of ['pages', 'results', 'items', 'data']) {
      const arr = j[key];
      if (!Array.isArray(arr)) continue;
      for (const it of arr) {
        const url = it && (it.url || it.link || it.href);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        const snippet = it.snippet || it.description || it.summary || it.abstract || '';
        out.push({ url, title: it.title || it.name || url, snippet: String(snippet).slice(0, 160) });
      }
    }
  }
  return out.slice(0, 8);
}
// 从步骤里收集脚本执行工具生成的文件产物（skill__run_script 返回的 files）
function collectArtifacts(steps) {
  const out = [];
  for (const st of (steps || [])) {
    if (st.kind !== 'tool' || st.name !== 'skill__run_script' || !st.result) continue;
    let j = null;
    try { j = JSON.parse(st.result); } catch (_) {}
    if (!j || !Array.isArray(j.files)) continue;
    j.files.forEach((p) => out.push({ path: p, name: String(p).split(/[\\/]/).pop() }));
  }
  return out;
}
// 产物卡片：📄 文件名 + 打开按钮（系统默认应用）
function renderArtifacts(msgEl, artifacts) {
  (artifacts || []).forEach((a) => {
    const card = document.createElement('div');
    card.className = 'ai-artifact done';   // done 表示可点开（与归档卡区分）
    card.innerHTML =
      '<span class="ai-artifact-ico">' + icoSvg('notes', 14) + '</span>' +
      '<div class="ai-artifact-info"><div class="t"></div><div class="p"></div></div>' +
      '<button type="button" class="btn btn-ghost ai-artifact-btn" data-open>打开</button>' +
      '<button type="button" class="btn btn-ghost ai-artifact-btn" data-reveal title="在文件夹中定位">' + icoSvg('folder-open', 12) + '所在文件夹</button>' +
      '<button type="button" class="btn btn-ghost ai-artifact-btn" data-copy title="复制完整路径">路径</button>';
    card.querySelector('.t').textContent = a.name || a.path;
    // 存储位置直接显示出来（之前只在 tooltip 里，看不到文件到底存哪了）；
    // 行内只显所在目录（文件名上一行已有），完整路径放 tooltip 与「路径」按钮
    const full = String(a.path || '');
    const dir = full.replace(/[\\/][^\\/]*$/, '') || full;
    const pEl = card.querySelector('.p');
    pEl.textContent = dir;
    pEl.title = full;
    card.title = full;

    card.querySelector('[data-open]').addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const r = await window.kb.openPath({ path: full });
        if (r && !r.ok) toast('打开失败：' + r.error, 3000);
      } catch (err) { toast('打开失败：' + err.message, 3000); }
    });
    card.querySelector('[data-reveal]').addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const r = await window.kb.revealPath({ path: full });
        if (r && !r.ok) toast('定位失败：' + r.error, 3500);
      } catch (err) { toast('定位失败：' + err.message, 3000); }
    });
    card.querySelector('[data-copy]').addEventListener('click', async (e) => {
      e.stopPropagation();
      try { await navigator.clipboard.writeText(full); toast('已复制路径', 2000); }
      catch (_) { toast('复制失败，可手动选取：' + full, 4000); }
    });
    // 卡片空白处仍可点开文件
    card.addEventListener('click', async () => {
      try {
        const r = await window.kb.openPath({ path: full });
        if (r && !r.ok) toast('打开失败：' + r.error, 3000);
      } catch (err) { toast('打开失败：' + err.message, 3000); }
    });
    msgEl.appendChild(card);
  });
}
// 统一引用展示：笔记 + 图谱实体 + 原始文件 + 外部来源（竖排 bullet 列表）
// 点击各自跳转对应主展示框架：笔记编辑器 / 知识图谱实体浏览 / 原始文件
function renderCitations(msgEl, cit) {
  const notes = (cit && cit.notes) || [];
  const hits = (cit && cit.hits) || [];
  const sources = (cit && cit.sources) || [];
  const raws = (cit && cit.raws) || [];
  if (!notes.length && !hits.length && !sources.length && !raws.length) return;
  const box = document.createElement('div');
  box.className = 'ai-refs';
  const label = document.createElement('span');
  label.className = 'ai-refs-label';
  label.textContent = '引用';
  box.appendChild(label);
  const addRow = (node) => {
    const row = document.createElement('div');
    row.className = 'ai-refs-row';
    row.appendChild(node);
    box.appendChild(row);
  };
  // 笔记知识源 → 笔记编辑器
  notes.forEach((n) => {
    const a = document.createElement('a');
    a.className = 'ai-ref-chip';
    a.href = '#note';
    a.innerHTML = icoSvg('notes', 12) + escapeHtml(n.title || '无标题笔记');
    a.title = '笔记：' + (n.title || '');
    a.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (typeof selectNote === 'function') selectNote(n.id);
    });
    addRow(a);
  });
  // 原始文件知识源 → 本机打开。标为「关键字命中」而非断言依据：
  // 它未经语义校对，弱命中（非 strong）额外置灰，避免看作已核实的引用
  raws.forEach((r) => {
    const a = document.createElement('a');
    a.className = 'ai-ref-chip' + (r.strong ? '' : ' weak');
    a.href = '#raw';
    // 网页链接引用用链接图标（与原始文件页一致），与本地文件/目录区分
    const isUrlRef = String(r.path).startsWith('url:');
    a.innerHTML = icoSvg(isUrlRef ? 'mcp' : 'folder-open', 12) + escapeHtml(r.name || r.path);
    a.title = `原始文件关键字命中${r.strong ? '' : '（弱命中，可能不相关）'}：${(r.matched || []).join('、')}\n${String(r.path).replace(/^local:/, '')}`;
    a.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (typeof openRawNative === 'function') openRawNative(r.path);
    });
    addRow(a);
  });
  // 图谱知识源 → 知识图谱·实体浏览（定位到该实体）
  hits.forEach((name) => {
    const a = document.createElement('a');
    a.className = 'ai-ref-chip';
    a.href = '#graph';
    a.innerHTML = icoSvg('kg', 12) + escapeHtml(name);
    a.title = '知识图谱实体：' + name;
    a.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      openGraphEntity(name);
    });
    addRow(a);
  });
  sources.forEach((s) => {
    const a = document.createElement('a');
    a.className = 'ai-ref-chip';
    a.href = s.url;
    let host = '';
    try { host = new URL(s.url).hostname; } catch (_) {}
    if (host) {
      const img = document.createElement('img');
      img.className = 'ai-ref-fav';
      img.alt = '';
      img.loading = 'lazy';
      img.src = 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(host) + '&sz=32';
      img.addEventListener('error', () => img.remove());
      a.appendChild(img);
    }
    a.appendChild(document.createTextNode(s.title));
    bindSrcPop(a, s);
    addRow(a);
  });
  msgEl.appendChild(box);
}
// 打开知识图谱主框架并定位到指定实体（名称或 id 均可）
function openGraphEntity(nameOrId) {
  if (typeof showGraphView !== 'function') return;
  const nodes = (state.graph && state.graph.nodes) || [];
  const hit = nodes.find((n) => n.id === nameOrId) || nodes.find((n) => n.name === nameOrId);
  state.kg = state.kg || {};
  state.kg.tab = 'entities';
  if (hit) state.kg.entitySel = hit.id;
  showGraphView();
  // 图谱数据异步加载，加载后再定位一次（首次打开时 nodes 可能为空）
  if (!hit) {
    setTimeout(() => {
      const later = ((state.graph && state.graph.nodes) || []).find((n) => n.id === nameOrId || n.name === nameOrId);
      if (later) { state.kg.entitySel = later.id; if (typeof renderKgEntities === 'function') renderKgEntities(); }
    }, 600);
  }
}
// ---------- 来源悬浮引用卡（标题/摘要/域名 + 复制链接，参考产品 Sources 悬停卡） ----------
let srcPop = null; let srcPopTimer = null;
function ensureSrcPop() {
  if (srcPop) return srcPop;
  srcPop = document.createElement('div');
  srcPop.className = 'ai-src-pop';
  srcPop.innerHTML =
    '<div class="ai-src-pop-t"></div><div class="ai-src-pop-d"></div>' +
    '<div class="ai-src-pop-f"><span class="ai-src-pop-domain"></span>' +
    '<button type="button" class="ai-src-pop-copy">复制链接</button></div>';
  srcPop.addEventListener('mouseenter', () => clearTimeout(srcPopTimer));
  srcPop.addEventListener('mouseleave', hideSrcPop);
  srcPop.querySelector('.ai-src-pop-copy').addEventListener('click', async (e) => {
    e.stopPropagation(); e.preventDefault();
    const url = srcPop.dataset.url || '';
    try { await navigator.clipboard.writeText(url); toast('链接已复制'); }
    catch (_) { toast('复制失败', 2500); }
  });
  document.body.appendChild(srcPop);
  return srcPop;
}
function hideSrcPop() {
  clearTimeout(srcPopTimer);
  srcPopTimer = setTimeout(() => { if (srcPop) srcPop.hidden = true; }, 160);
}
function bindSrcPop(chip, src) {
  chip.addEventListener('mouseenter', () => {
    clearTimeout(srcPopTimer);
    const pop = ensureSrcPop();
    pop.dataset.url = src.url;
    pop.querySelector('.ai-src-pop-t').textContent = src.title || src.url;
    const d = pop.querySelector('.ai-src-pop-d');
    d.textContent = src.snippet || '';
    d.style.display = src.snippet ? '' : 'none';
    let host = '';
    try { host = new URL(src.url).hostname; } catch (_) {}
    pop.querySelector('.ai-src-pop-domain').textContent = host || src.url;
    pop.hidden = false;
    const r = chip.getBoundingClientRect();
    const pw = Math.min(340, window.innerWidth - 16);
    pop.style.width = pw + 'px';
    const left = Math.max(8, Math.min(window.innerWidth - pw - 8, r.left));
    pop.style.left = left + 'px';
    pop.style.top = '0px';
    const ph = pop.offsetHeight;
    let top = r.top - ph - 8;
    if (top < 8) top = r.bottom + 8; // 上方放不下则放下
    pop.style.top = top + 'px';
  });
  chip.addEventListener('mouseleave', hideSrcPop);
}
// 答案操作行：复制 / 收藏 / 添加到笔记 / 耗时（收藏状态随会话持久化）
function addAnswerMeta(msgEl, opts) {
  const { answer = '', ms, record = null, question = '' } = opts || {};
  const bar = document.createElement('div');
  bar.className = 'ai-meta';
  bar.innerHTML =
    '<button type="button" class="ai-meta-btn" data-act="copy" title="复制回答">' + icoSvg('save', 12) + '</button>' +
    '<button type="button" class="ai-meta-btn" data-act="fav" title="收藏">' + icoSvg('star', 12) + '</button>' +
    '<button type="button" class="ai-meta-btn" data-act="note" title="添加到笔记">' + icoSvg('notes', 12) + '</button>' +
    (ms ? `<span class="ai-meta-time">${fmtElapsed(ms)}</span>` : '');
  const apply = () => {
    const b = bar.querySelector('[data-act="fav"]');
    const on = !!(record && record.fav);
    b.classList.toggle('on', on);
    b.title = on ? '取消收藏' : '收藏';
  };
  bar.querySelector('[data-act="copy"]').addEventListener('click', async (e) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(answer); toast('已复制回答'); }
    catch (_) { toast('复制失败', 2500); }
  });
  bar.querySelector('[data-act="fav"]').addEventListener('click', (e) => { e.stopPropagation(); toggleFavorite(record); apply(); });
  // 添加到笔记：与回填卡片共用 saveAnswerToNote；成功后再点直接跳转到该笔记
  const noteBtn = bar.querySelector('[data-act="note"]');
  noteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (record && record.savedNoteId) { selectNote(record.savedNoteId); return; }
    const res = saveAnswerToNote(question, answer);
    if (res.ok && record) record.savedNoteId = res.noteId;
    saveAiSessions();
  });
  apply();
  msgEl.appendChild(bar);
}

// ---------- 收藏 ----------
// 收藏标记直接写在消息记录上（fav/favAt），随会话一起经 chat:saveSessions 存入 kv.aiSessions，无需改主进程
function toggleFavorite(record) {
  if (!record) return;
  record.fav = !record.fav;
  record.favAt = record.fav ? Date.now() : 0;
  saveAiSessions();
  toast(record.fav ? '已收藏' : '已取消收藏', 1500);
  renderAiSessionList(); // 收藏视图下即刷新收藏列表，同时更新按钮计数
}
// 收集全部会话中被收藏的回答，按收藏时间倒序
function collectFavorites() {
  const out = [];
  (state.aiSessions || []).forEach((s) => {
    (s.messages || []).forEach((m) => {
      if (m.role === 'assistant' && m.fav) out.push({ s, m });
    });
  });
  out.sort((a, b) => (b.m.favAt || 0) - (a.m.favAt || 0));
  return out;
}
function updateFavBtn() {
  const b = $('btn-ai-favs'); if (!b) return;
  const n = collectFavorites().length;
  b.innerHTML = icoSvg('star', 13) + (n ? `我的收藏（${n}）` : '我的收藏');
  b.classList.toggle('active', !!state.favView);
}
// 「我的收藏」按钮：把左侧列表切换为收藏视图（再点切回会话列表）
function showFavorites() {
  state.favView = !state.favView;
  renderAiSessionList();
}
function renderFavorites() {
  const box = $('ai-session-list'); if (!box) return;
  box.innerHTML = '';
  const favs = collectFavorites();
  if (!favs.length) {
    const empty = document.createElement('div');
    empty.className = 'ai-fav-empty';
    empty.innerHTML = '暂无收藏<br>点击回答下方的收藏按钮即可收藏';
    box.appendChild(empty);
    return;
  }
  favs.forEach(({ s, m }) => {
    const d = document.createElement('div');
    d.className = 'ai-session-item fav';
    const first = (m.content || '').replace(/[#>*`\-\n]+/g, ' ').trim().slice(0, 26) || '收藏';
    d.innerHTML = `<div class="t">${icoSvg('star', 12)} ${escapeHtml(first)}</div>`
      + `<div class="d">${escapeHtml(s.title || '新任务')}</div>`;
    d.title = '点击定位到原对话';
    d.addEventListener('click', () => { state.favView = false; openAiSession(s.id, m); });
    box.appendChild(d);
  });
}

// ================= 使用手册（应用内查看 docs/ 目录 Markdown） =================
// DOCS_INDEX 定义于 renderer/constants.js
// GitHub 风格标题锚点：小写、去标点、空格换连字符（与文档内 #anchor 链接一致）
function docAnchorSlug(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
}
async function openDocs(file, anchor) {
  const res = await window.kb.readDoc({ file: file || DOCS_INDEX });
  if (!res || !res.ok) { toast('手册加载失败：' + ((res && res.error) || '未知错误'), 3000); return; }
  hideMainViews();
  setAiPanelVisible(false);
  $('docs-view').hidden = false;
  syncNoteListVisibility();
  renderDoc(res.text, res.root || '', file || DOCS_INDEX, anchor);
}
// 手册相对资源（图片等）路由：Web 走 /docs/，桌面走 kb-doc 协议（主进程限定 docs 目录）
function docAssetUrl(rel, root) {
  return window.__KB_WEB__ ? '/docs/' + rel : 'kb-doc://file' + (root + '/' + rel).replace(/\\/g, '/');
}
// DOC_ASSET_IMG_RE 定义于 renderer/constants.js
// 应用内大图预览弹层：点击任意处关闭；加载失败给提示并可新窗口打开，避免黑屏空白
function showDocImageOverlay(url, label) {
  const ov = document.createElement('div');
  ov.className = 'doc-asset-overlay';
  ov.title = '点击任意处关闭';
  let failed = false;
  const img = document.createElement('img');
  img.src = url;
  img.alt = label || url;
  img.addEventListener('error', () => {
    failed = true;
    img.remove();
    const tip = document.createElement('div');
    tip.className = 'doc-asset-tip';
    tip.textContent = '预览加载失败，点击在新窗口打开';
    ov.appendChild(tip);
  });
  ov.addEventListener('click', () => {
    ov.remove();
    if (failed && window.__KB_WEB__) window.open(url, '_blank');
  });
  ov.appendChild(img);
  document.body.appendChild(ov);
}
// 点击手册内相对资源链接：图片应用内大图预览，其它文件新标签/本机打开，避免直接导航相对路径导致空白
function openDocAsset(rel, root) {
  const url = docAssetUrl(rel, root);
  if (!DOC_ASSET_IMG_RE.test(rel)) {
    if (window.__KB_WEB__) { window.open(url, '_blank'); return; }
    if (window.kb.openPath) window.kb.openPath({ path: (root + '/' + rel).replace(/\\/g, '/') });
    return;
  }
  showDocImageOverlay(url, rel);
}
function renderDoc(text, root, file, anchor) {
  const body = $('docs-body');
  body.innerHTML = renderMarkdown(text);
  // 相对图片改写为手册资源路由：Web 走 /docs/，桌面走 kb-doc 协议（主进程限定 docs 目录）
  body.querySelectorAll('img[src]').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (!/^(https?:|kb-asset:|kb-doc:|\/)/i.test(src)) img.src = docAssetUrl(src, root);
    // 内嵌图点击放大预览（用已解析的 img.src，兼容相对/绝对路径）
    img.classList.add('doc-img-zoom');
    img.addEventListener('click', () => showDocImageOverlay(img.src, src));
  });
  // 文档内链接应用内跳转：.md(#anchor) 走手册导航，外链走系统浏览器
  body.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (/^https?:/i.test(href)) {
      a.addEventListener('click', (e) => { e.preventDefault(); if (window.kb.openExternal) window.kb.openExternal(href); });
      return;
    }
    if (/\.md($|#)/i.test(href)) {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const [f, anc] = href.split('#');
        // marked 会把中文文件名 URL 编码（01-%E5%BF%AB…md），readDoc 按真实文件名查找，需解码
        let name = f || file;
        try { name = decodeURIComponent(name); } catch (_) { /* 非法编码保留原样 */ }
        openDocs(name, anc);
      });
      return;
    }
    // 其余相对链接（截图等附件）：拦截点击，应用内预览/打开，避免导航到相对路径出现空白页
    if (href && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('#')) {
      a.addEventListener('click', (e) => { e.preventDefault(); openDocAsset(href, root); });
    }
  });
  if (anchor) {
    const target = Array.from(body.querySelectorAll('h1,h2,h3,h4,h5,h6'))
      .find((h) => docAnchorSlug(h.textContent) === anchor.toLowerCase());
    if (target) setTimeout(() => target.scrollIntoView({ block: 'start' }), 30);
  } else {
    body.scrollTop = 0;
  }
}
// 把一次问答存为新笔记（操作行「添加到笔记」与回填卡片共用）
function saveAnswerToNote(question, answer) {
  try {
    const title = uniqueNoteTitle((question || 'AI 问答').slice(0, 40), null);
    const note = {
      id: uid(),
      title,
      content: `# 问题\n\n${question || ''}\n\n# 回答\n\n${answer}\n\n> 来源：AI 问答 · ${new Date().toLocaleString()}`,
      tags: ['AI问答'],
      folderId: null,
      pinned: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    state.notes.unshift(note);
    persist();
    renderNoteList();
    renderSidebar();
    toast('回答已存入笔记：' + title);
    return { ok: true, noteId: note.id, title };
  } catch (err) {
    toast('存入笔记失败：' + err.message, 4000);
    return { ok: false, error: err.message };
  }
}
// 产物卡片：把长回答回填为笔记（参考产品产物文件卡片样式）
// 成功后按钮移除、卡片变 done，点击卡片跳转到该笔记
function addFileAnswerButton(msgEl, question, answer) {
  const card = document.createElement('div');
  card.className = 'ai-artifact';
  card.innerHTML =
    '<span class="ai-artifact-ico">' + icoSvg('notes', 14) + '</span>' +
    '<div class="ai-artifact-info"><div class="t">将回答回填到笔记</div><div class="d">Markdown · 存入笔记</div></div>' +
    '<button type="button" class="btn btn-ghost ai-artifact-btn">回填</button>';
  let openFn = null; // 成功回填后的跳转目标
  card.addEventListener('click', () => { if (openFn) openFn(); });
  const btn = card.querySelector('button');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    btn.disabled = true;
    btn.textContent = '存入中…';
    const res = saveAnswerToNote(question, answer);
    if (res.ok) {
      btn.remove();
      card.querySelector('.t').textContent = '已存入笔记：' + res.title;
      card.querySelector('.d').textContent = '点击打开';
      card.classList.add('done');
      openFn = () => selectNote(res.noteId);
    } else {
      btn.disabled = false;
      btn.textContent = '↩ 回填';
    }
  });
  msgEl.appendChild(card);
}

