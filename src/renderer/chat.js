// 渲染进程·问答模块：AI 面板、笔记检索、Wiki 问答与回填
let aiHistory = []; // {role, content}
let aiListeners = [];

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
    else if (m.role === 'assistant') addAiMessage('assistant', renderMarkdown(m.content || ''));
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
const MAX_ATTACH = 5;

function renderAttachBar() {
  const bar = $('ai-attach-bar');
  if (!bar) return;
  bar.innerHTML = '';
  bar.hidden = !aiAttachments.length;
  if (!aiAttachments.length) return;
  aiAttachments.forEach((a, i) => {
    const chip = document.createElement('span');
    chip.className = 'ai-attach-chip';
    chip.innerHTML = '📄 <span class="n">' + escapeHtml(a.name) + '</span>'
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
  const res = await window.kb.wikiPickFiles();
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
  const r = await window.kb.readAttachments({ paths: aiAttachments.map((a) => a.path) })
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
  row.textContent = '📎 ' + names.join('、');
  box.appendChild(row);
}

// ================= AI 主框架页（会话历史 + 欢迎 + 大输入框） =================
function addViewMessage(role, html) {
  const box = $('ai-view-messages');
  const div = document.createElement('div');
  div.className = `ai-msg ${role}`;
  const roleName = role === 'user' ? '我' : role === 'error' ? '提示' : 'AI 助手';
  div.innerHTML = `<div class="role">${roleName}</div><div class="bubble">${html}</div>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}
async function loadAiSessions() {
  try { state.aiSessions = (await window.kb.chatGetSessions()) || []; } catch (_) { state.aiSessions = []; }
  renderAiSessionList();
}
function saveAiSessions() { try { window.kb.chatSaveSessions(state.aiSessions || []); } catch (_) {} }
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
function showAiView() {
  hideMainViews();
  setAiPanelVisible(false);
  $('ai-view').hidden = false;
  loadAiSessions();
  refreshAiExtTitles();
  if (state.activeSessionId) openAiSession(state.activeSessionId); else aiNewTask();
  renderEditor();
  renderSidebar();
}
function aiNewTask() {
  state.activeSessionId = null;
  $('ai-view-welcome').hidden = false;
  const box = $('ai-view-messages'); box.hidden = true; box.innerHTML = '';
  $('ai-view-input').value = '';
  aiAttachments = [];
  renderAttachBar();
  renderAiSessionList();
}
function openAiSession(id) {
  const s = (state.aiSessions || []).find((x) => x.id === id);
  if (!s) return;
  state.activeSessionId = id;
  $('ai-view-welcome').hidden = true;
  const box = $('ai-view-messages'); box.hidden = false; box.innerHTML = '';
  (s.messages || []).forEach((m) => {
    if (m.role === 'assistant' && Array.isArray(m.steps) && m.steps.length) {
      const g = createStepsGroup();
      m.steps.forEach((x) => g.addStep(x));
      g.finish();
      if (g.el.parentNode !== box) box.appendChild(g.el);
    }
    const el = addViewMessage(m.role, m.role === 'user' ? escapeHtml(m.content || '') : renderMarkdown(m.content || ''));
    if (m.role === 'user') renderMsgAttachments(el, m.attachments);
    if (m.role === 'assistant') {
      renderArtifacts(el, m.artifacts || collectArtifacts(m.steps));
      renderCitations(el, m.citations || { pages: [], notes: [], hits: [], sources: collectSources(m.steps) });
      addAnswerMeta(el, { answer: m.content || '', ms: m.ms, record: m });
    }
  });
  renderAiSessionList();
}
async function sendAiViewQuestion(presetText) {
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
  const userEl = addViewMessage('user', escapeHtml(q));
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
  if (autoHit.length) group.addStep({ kind: 'thought', text: '⚡ 与问题格式匹配的技能：' + autoHit.join('、') });
  const msgEl = addViewMessage('assistant', loadingHtml('思考中'));
  const bubble = msgEl.querySelector('.bubble');
  const status = startStatusbar();
  let answer = '';
  let thinkText = '';
  let wikiCites = null;
  let noteCites = [];
  let rawCites = [];
  cleanupAiListeners();
  const offChunk = window.kb.onAiChunk((c) => { answer += c; bubble.innerHTML = renderMarkdown(answer); status.set('生成回答'); $('ai-view-messages').scrollTop = 9e9; });
  // Wiki 选页/图谱命中事件：收集引用，结束随答案一并展示
  let offRefs = () => {};
  try {
    offRefs = window.kb.onWikiRefs((refs) => {
      const pages = Array.isArray(refs) ? refs : (refs && refs.pages) || [];
      const graphHits = (!Array.isArray(refs) && refs && refs.graph) || [];
      if (pages.length || graphHits.length) wikiCites = { pages, hits: graphHits };
    });
  } catch (e) { console.warn('引用事件注册失败：', e); }
  // 桥接层缺陷不应中断问答：注册失败时降级为不展示步骤
  let offStep = () => {};
  try {
    offStep = window.kb.onAiStep((step) => {
      // 思考内容只在答案气泡里实时打印一处；不再同时入步骤组，
      // 否则“💭 思考过程”折叠块与气泡实时思考两处重复展示（正文开始后气泡思考自然被答案覆盖）
      if (step.kind !== 'thinking') group.addStep(step);
      if (step.kind === 'thinking') {
        thinkText += step.text || '';
        if (!answer) {
          bubble.innerHTML = '<div class="ai-think-live">💭 思考中（实时输出）</div>' +
            '<pre class="ai-think-live-body">' + escapeHtml(thinkText) + '</pre>';
          const tb = bubble.querySelector('.ai-think-live-body');
          if (tb) tb.scrollTop = tb.scrollHeight;
        }
      }
      // 状态条直接用阶段文案（如“正在筛选…”），比统一的“思考”更能看出进展
      if (step.kind === 'tool') status.set('调用工具：' + step.name);
      else if (step.kind === 'tool-result') status.set('工具返回');
      else if (step.kind === 'thought' && step.text) {
        status.set(String(step.text).slice(0, 28));
        // 正文/思考还未开始时，气泡占位也跟着显示当前阶段，不再写死“思考中”
        if (!answer && !thinkText) bubble.innerHTML = loadingHtml(String(step.text).slice(0, 40));
      } else status.set('思考');
    });
  } catch (e) { console.warn('步骤事件注册失败：', e); }
  const offDone = window.kb.onAiDone(() => finishView(true));
  const offError = window.kb.onAiError((msg) => { bubble.innerHTML = renderMarkdown((answer ? answer + '\n\n' : '') + `> ⚠ ${msg}`); finishView(false); });
  aiListeners = [offChunk, offStep, offRefs, offDone, offError];
  function finishView(ok) {
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
          pages: (wikiCites && wikiCites.pages) || [],
          notes: noteCites,
          raws: rawCites,
          hits: (wikiCites && wikiCites.hits) || [],
          sources: collectSources(group.steps),
        };
        const rec = { role: 'assistant', content: answer, steps: group.steps, ms: Date.now() - t0, rating: 0, citations: cites, artifacts: collectArtifacts(group.steps) };
        s.messages.push(rec);
        bubble.innerHTML = renderMarkdown(answer);
        renderArtifacts(msgEl, rec.artifacts);
        renderCitations(msgEl, cites);
        if (answer.length > 800) addFileAnswerButton(msgEl, q, answer);
        addAnswerMeta(msgEl, { answer, ms: rec.ms, record: rec });
      }
    }
    saveAiSessions();
    renderAiSessionList();
  }
  // 笔记知识源（受知识源开关控制）
  const { context, refs } = state.aiSources.notes ? buildNotesContext(q) : { context: '', refs: [] };
  // 笔记检索命中作为引用展示（仅保留跳转所需的 id/标题）
  noteCites = (refs || []).map((n) => ({ id: n.id, title: n.title || '无标题笔记' }));
  // 原始文件知识源：grep 式关键字检索（主进程纯 Node 实现，跳 Windows/macOS 差异）
  let rawsContext = '';
  if (state.aiSources.raws) {
    group.addStep({ kind: 'thought', text: '正在关键字检索已引入的原始文件…' });
    const rs = await window.kb.rawSearch({ settings: state.settings, question: q, topN: 5 })
      .catch(() => ({ ok: false, hits: [] }));
    const hits = (rs && rs.hits) || [];
    if (hits.length) {
      rawsContext = hits
        .map((h, i) => `【文件${i + 1}】${h.name}（命中：${(h.matched || []).slice(0, 6).join('、')}）\n${(h.snippets || []).join('\n…\n')}`)
        .join('\n\n');
      rawCites = hits.map((h) => ({ path: h.path, name: h.name, strong: !!h.strong, matched: h.matched || [] }));
      group.addStep({ kind: 'thought', text: `原始文件命中 ${hits.length} 个（已扫 ${rs.scanned || 0}/${rs.candidates || 0}）：${hits.map((h) => h.name).join('、')}` });
    } else {
      group.addStep({ kind: 'thought', text: `原始文件无关键字命中（已扫 ${(rs && rs.scanned) || 0}/${(rs && rs.candidates) || 0}）` });
    }
  }
  // 上传附件：本次提问的主要依据，读完即清空，不累积到下一轮
  const attach = await buildAttachContext(group);
  if (attach.names.length) {
    userMsg.attachments = attach.names;   // 存进会话，重开时仍能看到附了什么
    renderMsgAttachments(userEl, attach.names);
  }
  aiAttachments = [];
  renderAttachBar();
  await window.kb.wikiAsk({ settings: aiSettings(), question: q, notesContext: context, rawsContext, attachContext: attach.context, includeGraph: state.aiSources.graph, extHint: extHint(q), history: s.messages.slice(-8), extMcp: selectedMcpCfgs() });
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
    src.textContent = '📎 参考笔记：' + sources.map((n) => n.title || '无标题').join('、');
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

  // Wiki 问答路径：勾选了 Wiki 且 Wiki 存在时走 wikiAsk（可附带笔记/图谱上下文）
  const src = state.aiSources;
  if (src.wiki && state.wiki.exists) {
    const nc = src.notes ? buildNotesContext(question) : { context: '', refs: [] };
    await sendWikiQuestion(question, { notesContext: nc.context, noteRefs: nc.refs, includeGraph: src.graph });
    return;
  }

  const refs = src.notes ? retrieveNotes(question) : [];
  const context = refs
    .map((n, i) => `【笔记${i + 1}】标题：${n.title || '无标题'}\n${(n.content || '').slice(0, 1500)}`)
    .join('\n\n');

  const ext = extHint(question);
  let systemPrompt = refs.length
    ? `你是个人知识库助手。以下是用户知识库中与问题相关的笔记内容：\n\n${context}\n\n请主要依据上述笔记内容回答用户问题。回答使用 Markdown 格式；如笔记中没有相关内容，请如实说明。`
    : `你是个人知识库助手。用户知识库中没有检索到与问题直接相关的内容。请用你自己的知识简要回答，并提示用户知识库中暂无相关笔记。回答使用 Markdown 格式。`;
  if (ext) systemPrompt += '\n\n' + ext;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...aiHistory.slice(-8),
    { role: 'user', content: question },
  ];

  const msgEl = addAiMessage('assistant', 'loading', refs);
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

  function finish(ok) {
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

  await window.kb.askAI({ settings: aiSettings(), messages, useGraph: state.aiSources.graph, extMcp: selectedMcpCfgs() });
}

// ---------- Wiki 问答与回填 ----------
function setAiMode(mode) {
  // 兼容旧调用：切换为勾选对应数据源
  if (mode === 'wiki') state.aiSources.wiki = true;
  if (mode === 'notes') state.aiSources.notes = true;
  localStorage.setItem('kb.aiSources', JSON.stringify(state.aiSources));
  applyAiSources();
}

// 笔记检索上下文（供 Wiki 问答路径附带使用）：返回拼好的上下文与引用笔记列表
function buildNotesContext(question) {
  const refs = retrieveNotes(question);
  const context = refs.map((n, i) => `【笔记${i + 1}】标题：${n.title || '无标题'}\n${(n.content || '').slice(0, 1500)}`).join('\n\n');
  return { context, refs };
}

// AI 问答数据源多选：加载/应用/绑定
function loadAiSources() {
  try {
    const s = JSON.parse(localStorage.getItem('kb.aiSources') || 'null');
    if (s && typeof s === 'object') {
      // raws 为后加数据源：旧偏好里没有该键时默认开启，与其余三项一致
      state.aiSources = { notes: !!s.notes, wiki: !!s.wiki, graph: !!s.graph, raws: s.raws !== false };
    }
  } catch (_) {}
}

function applyAiSources() {
  $('ai-src-notes').checked = state.aiSources.notes;
  $('ai-src-wiki').checked = state.aiSources.wiki;
  $('ai-src-graph').checked = state.aiSources.graph;
  if ($('ai-src-raws')) $('ai-src-raws').checked = state.aiSources.raws;
  const names = [];
  if (state.aiSources.notes) names.push('笔记');
  if (state.aiSources.wiki) names.push('LLM Wiki');
  if (state.aiSources.graph) names.push('知识图谱');
  if (state.aiSources.raws) names.push('原始文件');
  $('ai-hint').textContent = names.length
    ? `基于所选数据源回答：${names.join(' + ')}；Wiki 路径先查索引选页，图谱作为本体层上下文注入。`
    : '未选择数据源，模型将用自身知识回答。';
  renderAiExt();
}

function bindAiSources() {
  ['notes', 'wiki', 'graph'].forEach((k) => {
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
  mcps.forEach((m) => mk('mcp', '🧩', m));
  skills.forEach((k) => mk('skill', '⚡', k));
}
// 本次问答生效的 MCP 服务器配置（供后端列出/调用工具）；全部被去除时为空数组
function selectedMcpCfgs() {
  return effectiveMcps();
}

// ---------- 模型选择（两级：provider → 具体模型；默认主模型） ----------
// 选中项仅作用于 AI 问答 / Wiki 问答请求：按条目自带的 baseUrl / apiKey / model 覆盖 settings；
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
  tip.textContent = '➕ 到 设置→模型配置 添加更多模型';
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
    [['notes', '📝', '笔记'], ['wiki', '📖', 'Wiki'], ['graph', '🕸', '知识图谱'], ['raws', '🗄', '原始文件']].forEach(([k, icon, label]) => {
      const on = !!(state.aiSources && state.aiSources[k]);
      const d = document.createElement('div');
      d.className = 'ext-item';
      d.innerHTML = `<span>${icon} ${label}</span>${on ? '<span class="chk">✓</span>' : ''}`;
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
    if (skills.length) skills.forEach((k) => item('skill', '⚡', k.name));
    else { const h = document.createElement('div'); h.className = 'ext-item'; h.style.opacity = '.55'; h.textContent = '⚡ 到 设置→技能 添加'; menu.appendChild(h); }
  }
  if (want('mcp')) {
    if (mcps.length) { const g = document.createElement('div'); g.className = 'ext-group'; g.textContent = 'MCP'; menu.appendChild(g); mcps.forEach((m) => item('mcp', '🧩', m.name)); }
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
    '<button type="button" class="ai-steps-head"><span class="ai-steps-ico">👁</span>' +
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
          d.innerHTML = '<summary>💭 思考过程（实时输出，点击可收起）</summary><div class="ai-step-detail"></div>';
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
      const lab = s.kind === 'tool' ? '🖥 调用工具：' + (s.name || '') : '💭 ' + String(s.text || '').slice(0, 60);
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
  const tick = () => { el.textContent = `● ${text}中… ${((Date.now() - t0) / 1000).toFixed(1)}s`; };
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
// 刷新三个分类菜单（知识源/MCP/技能）
function refreshAllExtMenus() {
  renderAiExtMenu($('ai-menu-src'), ['sources']);
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

async function sendWikiQuestion(question, opts = {}) {
  const { notesContext = '', noteRefs = [], includeGraph = false } = opts;
  // 参考笔记随消息展示，让用户看到笔记数据源确实被查询
  const msgEl = addAiMessage('assistant', '', noteRefs);
  msgEl.querySelector('.bubble').classList.add('is-loading');
  msgEl.querySelector('.bubble').innerHTML = loadingHtml('正在查阅 Wiki');
  const bubble = msgEl.querySelector('.bubble');

  state.aiBusy = true;
  setAiSendBusy(true);
  cleanupAiListeners();

  let answer = '';
  const offRefs = window.kb.onWikiRefs((refs) => {
    // 兼容新旧结构：旧版为页面路径数组，新版为 { pages, graph }
    const pages = Array.isArray(refs) ? refs : (refs && refs.pages) || [];
    const graphHits = (!Array.isArray(refs) && refs && refs.graph) || [];
    if (!pages.length && !graphHits.length) return;
    const box = document.createElement('div');
    box.className = 'ai-refs';
    const addLabel = (text) => {
      const label = document.createElement('span');
      label.style.cssText = 'font-size:11px;color:var(--text-sub)';
      label.textContent = text;
      box.appendChild(label);
    };
    if (pages.length) {
      addLabel('📖 引用页面：');
      pages.forEach((p) => {
        const chip = document.createElement('span');
        chip.className = 'ai-ref-chip';
        chip.textContent = p;
        chip.onclick = () => openWikiPage(p);
        box.appendChild(chip);
      });
    }
    if (graphHits.length) {
      addLabel('🕸 图谱实体：');
      graphHits.forEach((name) => {
        const chip = document.createElement('span');
        chip.className = 'ai-ref-chip';
        chip.textContent = name;
        box.appendChild(chip);
      });
    }
    msgEl.appendChild(box);
    $('ai-messages').scrollTop = $('ai-messages').scrollHeight;
  });
  const offChunk = window.kb.onAiChunk((chunk) => {
    answer += chunk;
    bubble.innerHTML = renderMarkdown(answer);
    $('ai-messages').scrollTop = $('ai-messages').scrollHeight;
  });
  const offDone = window.kb.onAiDone(() => finish(true));
  const offError = window.kb.onAiError((message) => {
    if (!answer) {
      msgEl.remove();
      addAiMessage('error', escapeHtml(message));
    } else {
      bubble.innerHTML = renderMarkdown(answer + `\n\n> ⚠ ${message}`);
    }
    finish(false);
  });
  aiListeners = [offRefs, offChunk, offDone, offError];

  function finish(ok) {
    state.aiBusy = false;
    setAiSendBusy(false);
    cleanupAiListeners();
    if (answer) {
      aiHistory.push({ role: 'user', content: question });
      aiHistory.push({ role: 'assistant', content: answer });
      saveAiHistory();
      bubble.innerHTML = renderMarkdown(answer);
      if (ok) addFileAnswerButton(msgEl, question, answer);
    }
  }

  await window.kb.wikiAsk({ settings: state.settings, question, notesContext, includeGraph, extHint: extHint(question), history: aiHistory.slice(-8), extMcp: selectedMcpCfgs() });
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
      '<span class="ai-artifact-ico">📄</span>' +
      '<div class="ai-artifact-info"><div class="t"></div><div class="p"></div></div>' +
      '<button type="button" class="btn btn-ghost ai-artifact-btn" data-open>打开</button>' +
      '<button type="button" class="btn btn-ghost ai-artifact-btn" data-reveal title="在文件夹中定位">📂 所在文件夹</button>' +
      '<button type="button" class="btn btn-ghost ai-artifact-btn" data-copy title="复制完整路径">⏘ 路径</button>';
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
// 统一引用展示：Wiki 页面 + 笔记 + 图谱实体 + 外部来源（竖排 bullet 列表）
// 点击各自跳转对应主展示框架：Wiki 阅读器 / 笔记编辑器 / 知识图谱实体浏览
function renderCitations(msgEl, cit) {
  const pages = (cit && cit.pages) || [];
  const notes = (cit && cit.notes) || [];
  const hits = (cit && cit.hits) || [];
  const sources = (cit && cit.sources) || [];
  const raws = (cit && cit.raws) || [];
  if (!pages.length && !notes.length && !hits.length && !sources.length && !raws.length) return;
  const box = document.createElement('div');
  box.className = 'ai-refs';
  const label = document.createElement('span');
  label.className = 'ai-refs-label';
  label.textContent = '🔗 引用';
  box.appendChild(label);
  const addRow = (node) => {
    const row = document.createElement('div');
    row.className = 'ai-refs-row';
    row.appendChild(node);
    box.appendChild(row);
  };
  // Wiki 知识源 → Wiki 阅读器
  pages.forEach((p) => {
    const a = document.createElement('a');
    a.className = 'ai-ref-chip';
    a.href = '/' + String(p).replace(/^\//, '');
    a.textContent = '📖 ' + String(p).split('/').pop().replace(/\.md$/, '');
    a.title = p;
    addRow(a);
  });
  // 笔记知识源 → 笔记编辑器
  notes.forEach((n) => {
    const a = document.createElement('a');
    a.className = 'ai-ref-chip';
    a.href = '#note';
    a.textContent = '📝 ' + (n.title || '无标题笔记');
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
    a.textContent = '🗄 ' + (r.name || r.path);
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
    a.textContent = '🕸 ' + name;
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
    '<button type="button" class="ai-src-pop-copy">🔗 复制链接</button></div>';
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
// 答案操作行：复制 / 有帮助 / 待改进 / 耗时（评级随会话持久化）
function addAnswerMeta(msgEl, opts) {
  const { answer = '', ms, record = null } = opts || {};
  const bar = document.createElement('div');
  bar.className = 'ai-meta';
  bar.innerHTML =
    '<button type="button" class="ai-meta-btn" data-act="copy" title="复制回答">📋</button>' +
    '<button type="button" class="ai-meta-btn" data-act="up" title="有帮助">👍</button>' +
    '<button type="button" class="ai-meta-btn" data-act="down" title="待改进">👎</button>' +
    (ms ? `<span class="ai-meta-time">${fmtElapsed(ms)}</span>` : '');
  const apply = () => {
    bar.querySelector('[data-act="up"]').classList.toggle('on', !!(record && record.rating === 1));
    bar.querySelector('[data-act="down"]').classList.toggle('on', !!(record && record.rating === -1));
  };
  bar.querySelector('[data-act="copy"]').addEventListener('click', async (e) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(answer); toast('已复制回答'); }
    catch (_) { toast('复制失败', 2500); }
  });
  const rate = (v) => { if (record) { record.rating = record.rating === v ? 0 : v; saveAiSessions(); } apply(); };
  bar.querySelector('[data-act="up"]').addEventListener('click', (e) => { e.stopPropagation(); rate(1); });
  bar.querySelector('[data-act="down"]').addEventListener('click', (e) => { e.stopPropagation(); rate(-1); });
  apply();
  msgEl.appendChild(bar);
}
// 产物卡片：把长回答归档为 Wiki 页（参考产品产物文件卡片样式）
function addFileAnswerButton(msgEl, question, answer) {
  const card = document.createElement('div');
  card.className = 'ai-artifact';
  card.innerHTML =
    '<span class="ai-artifact-ico">📄</span>' +
    '<div class="ai-artifact-info"><div class="t">将回答归档为 Wiki 页面</div><div class="d">Markdown · 存入 LLM Wiki</div></div>' +
    '<button type="button" class="btn btn-ghost ai-artifact-btn">↩ 回填</button>';
  const btn = card.querySelector('button');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '归档中…';
    const res = await window.kb.wikiFileAnswer({ settings: state.settings, question, answer });
    if (res.ok) {
      card.querySelector('.t').textContent = res.path;
      card.querySelector('.d').textContent = '已归档 · 点击打开页面';
      card.classList.add('done');
      btn.remove();
      card.addEventListener('click', () => openWikiPage(res.path));
      toast('回答已回填：' + res.path);
      await loadWiki();
    } else {
      toast('回填失败：' + res.error, 4000);
      btn.disabled = false;
      btn.textContent = '↩ 回填';
    }
  });
  msgEl.appendChild(card);
}

