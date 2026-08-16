// 渲染进程·问答模块：AI 面板、笔记检索、Wiki 问答与回填
let aiHistory = []; // {role, content}
let aiListeners = [];
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
  const tokens = tokenize(question);
  if (tokens.length === 0) return [];
  const scored = state.notes
    .map((note) => {
      const title = (note.title || '').toLowerCase();
      const tags = (note.tags || []).join(' ').toLowerCase();
      const content = (note.content || '').toLowerCase();
      let score = 0;
      tokens.forEach((t) => {
        if (title.includes(t)) score += 5;
        if (tags.includes(t)) score += 3;
        let idx = 0;
        let count = 0;
        while ((idx = content.indexOf(t, idx)) !== -1 && count < 10) {
          count++;
          idx += t.length;
        }
        score += count;
      });
      return { note, score };
    })
    .filter((x) => x.score > 0)
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

async function sendAiQuestion() {
  if (state.aiBusy) return;
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

  const systemPrompt = refs.length
    ? `你是个人知识库助手。以下是用户知识库中与问题相关的笔记内容：\n\n${context}\n\n请主要依据上述笔记内容回答用户问题。回答使用 Markdown 格式；如笔记中没有相关内容，请如实说明。`
    : `你是个人知识库助手。用户知识库中没有检索到与问题直接相关的内容。请用你自己的知识简要回答，并提示用户知识库中暂无相关笔记。回答使用 Markdown 格式。`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...aiHistory.slice(-8),
    { role: 'user', content: question },
  ];

  const msgEl = addAiMessage('assistant', 'loading', refs);
  const bubble = msgEl.querySelector('.bubble');

  state.aiBusy = true;
  $('btn-ai-send').disabled = true;
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
    $('btn-ai-send').disabled = false;
    cleanupAiListeners();
    if (answer) {
      // 仅完全成功才写入历史，避免残缺回答污染后续上下文
      if (ok) aiHistory.push({ role: 'user', content: question });
      if (ok) aiHistory.push({ role: 'assistant', content: answer });
      bubble.classList.remove('is-loading');
      bubble.innerHTML = renderMarkdown(answer);
    }
  }

  await window.kb.askAI({ settings: state.settings, messages, useGraph: state.aiSources.graph });
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
      state.aiSources = { notes: !!s.notes, wiki: !!s.wiki, graph: !!s.graph };
    }
  } catch (_) {}
}

function applyAiSources() {
  $('ai-src-notes').checked = state.aiSources.notes;
  $('ai-src-wiki').checked = state.aiSources.wiki;
  $('ai-src-graph').checked = state.aiSources.graph;
  const names = [];
  if (state.aiSources.notes) names.push('笔记');
  if (state.aiSources.wiki) names.push('LLM Wiki');
  if (state.aiSources.graph) names.push('知识图谱');
  $('ai-hint').textContent = names.length
    ? `基于所选数据源回答：${names.join(' + ')}；Wiki 路径先查索引选页，图谱作为本体层上下文注入。`
    : '未选择数据源，模型将用自身知识回答。';
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

async function sendWikiQuestion(question, opts = {}) {
  const { notesContext = '', noteRefs = [], includeGraph = false } = opts;
  // 参考笔记随消息展示，让用户看到笔记数据源确实被查询
  const msgEl = addAiMessage('assistant', '', noteRefs);
  msgEl.querySelector('.bubble').classList.add('is-loading');
  msgEl.querySelector('.bubble').innerHTML = loadingHtml('正在查阅 Wiki');
  const bubble = msgEl.querySelector('.bubble');

  state.aiBusy = true;
  $('btn-ai-send').disabled = true;
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
    $('btn-ai-send').disabled = false;
    cleanupAiListeners();
    if (answer) {
      aiHistory.push({ role: 'user', content: question });
      aiHistory.push({ role: 'assistant', content: answer });
      bubble.innerHTML = renderMarkdown(answer);
      if (ok) addFileAnswerButton(msgEl, question, answer);
    }
  }

  await window.kb.wikiAsk({ settings: state.settings, question, notesContext, includeGraph });
}

function addFileAnswerButton(msgEl, question, answer) {
  const btn = document.createElement('button');
  btn.className = 'file-answer-btn';
  btn.textContent = '↩ 回填到 Wiki';
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = '归档中…';
    const res = await window.kb.wikiFileAnswer({ settings: state.settings, question, answer });
    if (res.ok) {
      btn.textContent = '✔ 已归档：' + res.path;
      toast('回答已回填：' + res.path);
      await loadWiki();
    } else {
      toast('回填失败：' + res.error, 4000);
      btn.disabled = false;
      btn.textContent = '↩ 回填到 Wiki';
    }
  };
  msgEl.appendChild(btn);
}

