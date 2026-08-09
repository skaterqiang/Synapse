/* global marked */

// ================= 状态 =================
const state = {
  folders: [],   // {id, name, parentId}
  notes: [],     // {id, title, content, tags[], folderId, pinned, createdAt, updatedAt}
  settings: {},  // {apiBaseUrl, apiKey, model, wikiRoot, wikiCollapsed, maxJobsHistory, chatRetries, urlFetchTimeout, sourceMaxChars, wikiAskMaxPages, logTailLines, defaultEditorMode}
  view: { type: 'all', id: null, query: '' }, // type: all | folder | tag | search
  selectedNoteId: null,
  editorMode: 'split',
  settingsTab: 'ai',                // 设置页当前 Tab 分类
  currentDbPath: '',                // 当前 SQLite 数据文件路径（设置页回填用）
  aiBusy: false,
  wiki: { exists: false, pages: [] }, // LLM Wiki 描述信息
  wikiPage: null,                     // 当前打开的 wiki 页面相对路径
  aiMode: 'notes',                    // notes | wiki
  ingestTab: 'url',                   // url | text | files
  ingestFiles: [],                    // 待吸收的本地文件 [{path, name}]
  jobs: [],                           // Wiki 处理作业列表
  jobsFilter: 'all',                  // 作业页筛选：all | active | success | failed
  jobsExpanded: {},                   // 作业页展开状态 { jobId: true }
};

let saveTimer = null;
let aiHistory = []; // {role, content}
let aiListeners = [];

// ================= 工具函数 =================
const $ = (id) => document.getElementById(id);

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toast(msg, ms = 2200) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

function renderMarkdown(text) {
  try {
    return marked.parse(text || '', { breaks: true });
  } catch (_) {
    return escapeHtml(text);
  }
}

// 高亮搜索词（先转义再包裹 mark）
function highlight(text, query) {
  const safe = escapeHtml(text);
  if (!query) return safe;
  const q = query.trim();
  if (!q) return safe;
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return safe.replace(re, (m) => `<mark>${m}</mark>`);
}

// 自定义输入弹窗（Electron 中 window.prompt 不可用）
function askInput(title, defaultValue = '') {
  return new Promise((resolve) => {
    $('prompt-title').textContent = title;
    const input = $('prompt-input');
    input.value = defaultValue;
    $('prompt-modal').hidden = false;
    input.focus();
    input.select();

    const close = (val) => {
      $('prompt-modal').hidden = true;
      $('btn-prompt-ok').removeEventListener('click', onOk);
      $('btn-prompt-cancel').removeEventListener('click', onCancel);
      $('prompt-modal').removeEventListener('click', onMask);
      input.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onOk = () => close(input.value);
    const onCancel = () => close(null);
    const onMask = (e) => { if (e.target === $('prompt-modal')) close(null); };
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); close(input.value); }
      if (e.key === 'Escape') close(null);
    };
    $('btn-prompt-ok').addEventListener('click', onOk);
    $('btn-prompt-cancel').addEventListener('click', onCancel);
    $('prompt-modal').addEventListener('click', onMask);
    input.addEventListener('keydown', onKey);
  });
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    window.kb.saveData({
      folders: state.folders,
      notes: state.notes,
      settings: state.settings,
    }).then((res) => {
      if (res && !res.ok) toast('保存失败：' + (res.error || '未知错误'));
    });
  }, 400);
}

// ================= 笔记过滤 =================
function getFilteredNotes() {
  const { type, id, query } = state.view;
  let list = state.notes.slice();

  if (type === 'folder') {
    list = list.filter((n) => n.folderId === id);
  } else if (type === 'tag') {
    list = list.filter((n) => (n.tags || []).includes(id));
  } else if (type === 'search') {
    const q = query.trim().toLowerCase();
    if (q) {
      list = list
        .map((n) => {
          let score = 0;
          if ((n.title || '').toLowerCase().includes(q)) score += 10;
          if ((n.tags || []).some((t) => t.toLowerCase().includes(q))) score += 6;
          if ((n.content || '').toLowerCase().includes(q)) score += 2;
          return { n, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.n);
      return list; // 搜索模式按相关度排序，不再按时间
    }
  }

  list.sort((a, b) => {
    if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
    return b.updatedAt - a.updatedAt;
  });
  return list;
}

function getViewTitle() {
  const { type, id, query } = state.view;
  if (type === 'folder') {
    const f = state.folders.find((x) => x.id === id);
    return f ? `📁 ${f.name}` : '目录';
  }
  if (type === 'tag') return `🏷 ${id}`;
  if (type === 'search') return `🔍 搜索"${query}"`;
  return '全部笔记';
}

// ================= 渲染：侧边栏 =================
function renderSidebar() {
  $('count-all').textContent = state.notes.length;
  // 设置页打开时，侧边栏导航不保留高亮
  const navDimmed = !$('settings-view').hidden;

  // 目录树（支持一级展示全部，子目录缩进）
  const tree = $('folder-tree');
  tree.innerHTML = '';
  const roots = state.folders.filter((f) => !f.parentId);
  const childrenOf = (id) => state.folders.filter((f) => f.parentId === id);

  const renderFolder = (folder, depth) => {
    const count = state.notes.filter((n) => n.folderId === folder.id).length;
    const div = document.createElement('div');
    div.className = 'folder-item' + (!navDimmed && state.view.type === 'folder' && state.view.id === folder.id ? ' active' : '');
    div.style.paddingLeft = 10 + depth * 16 + 'px';
    div.innerHTML = `
      <span style="margin-right:6px">${depth > 0 ? '↳' : '📁'}</span>
      <span class="folder-name">${escapeHtml(folder.name)}</span>
      <span class="folder-actions">
        <button class="icon-btn" data-act="rename" title="重命名">✏</button>
        <button class="icon-btn" data-act="del" title="删除">✕</button>
      </span>
      <span class="nav-count">${count}</span>`;
    div.addEventListener('click', (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'rename') {
        e.stopPropagation();
        askInput('目录名称：', folder.name).then((name) => {
          if (name && name.trim()) {
            folder.name = name.trim();
            persist();
            renderAll();
          }
        });
        return;
      }
      if (act === 'del') {
        const noteCount = state.notes.filter((n) => n.folderId === folder.id).length;
        if (!confirm(`删除目录"${folder.name}"？目录下 ${noteCount} 篇笔记将移至"未分类"。`)) return;
        state.notes.forEach((n) => { if (n.folderId === folder.id) n.folderId = null; });
        state.folders.forEach((f) => { if (f.parentId === folder.id) f.parentId = folder.parentId || null; });
        state.folders = state.folders.filter((f) => f.id !== folder.id);
        if (state.view.type === 'folder' && state.view.id === folder.id) state.view = { type: 'all', id: null, query: '' };
        persist();
        renderAll();
        e.stopPropagation();
        return;
      }
      state.view = { type: 'folder', id: folder.id, query: '' };
      $('search-input').value = '';
      $('settings-view').hidden = true;
      renderAll();
    });
    tree.appendChild(div);
    childrenOf(folder.id).forEach((c) => renderFolder(c, depth + 1));
  };
  roots.forEach((f) => renderFolder(f, 0));

  if (state.folders.length === 0) {
    tree.innerHTML = '<div style="padding:4px 10px;font-size:12px;color:#b0b6bf">暂无目录，点上方 ＋ 创建</div>';
  }

  // 标签云
  const tagMap = new Map();
  state.notes.forEach((n) => (n.tags || []).forEach((t) => tagMap.set(t, (tagMap.get(t) || 0) + 1)));
  const tagList = $('tag-list');
  tagList.innerHTML = '';
  if (tagMap.size === 0) {
    tagList.innerHTML = '<div style="padding:4px 10px;font-size:12px;color:#b0b6bf">暂无标签</div>';
  } else {
    [...tagMap.entries()].sort((a, b) => b[1] - a[1]).forEach(([tag, count]) => {
      const span = document.createElement('span');
      span.className = 'tag-item' + (!navDimmed && state.view.type === 'tag' && state.view.id === tag ? ' active' : '');
      span.textContent = `${tag} (${count})`;
      span.addEventListener('click', () => {
        state.view = { type: 'tag', id: tag, query: '' };
        $('search-input').value = '';
        $('settings-view').hidden = true;
        renderAll();
      });
      tagList.appendChild(span);
    });
  }

  $('nav-all-notes').classList.toggle('active', !navDimmed && (state.view.type === 'all' || state.view.type === 'search'));
}

// ================= 渲染：笔记列表 =================
function renderNoteList() {
  const list = getFilteredNotes();
  $('note-list-title').textContent = getViewTitle();
  $('note-list-count').textContent = list.length ? `${list.length} 篇` : '';

  const container = $('note-list');
  container.innerHTML = '';
  if (list.length === 0) {
    container.innerHTML = '<div class="list-empty">暂无笔记<br>点击左上角"＋ 新建"开始记录</div>';
    return;
  }

  const q = state.view.type === 'search' ? state.view.query : '';
  list.forEach((note) => {
    const card = document.createElement('div');
    card.className = 'note-card' + (note.id === state.selectedNoteId ? ' active' : '');
    const snippet = (note.content || '').replace(/[#>*`\-\[\]]/g, '').slice(0, 120);
    const tagsHtml = (note.tags || []).slice(0, 3)
      .map((t) => `<span class="mini-tag">${highlight(t, q)}</span>`).join('');
    card.innerHTML = `
      <div class="note-card-title">${note.pinned ? '📌 ' : ''}${highlight(note.title || '无标题笔记', q)}</div>
      <div class="note-card-snippet">${highlight(snippet, q) || '<span style="opacity:.5">（空笔记）</span>'}</div>
      <div class="note-card-footer">${formatDate(note.updatedAt)} ${tagsHtml}</div>`;
    card.addEventListener('click', () => selectNote(note.id));
    container.appendChild(card);
  });
}

// ================= 渲染：编辑器 =================
function currentNote() {
  return state.notes.find((n) => n.id === state.selectedNoteId) || null;
}

function renderFolderSelect() {
  const sel = $('note-folder');
  sel.innerHTML = '<option value="">未分类</option>';
  state.folders.forEach((f) => {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = (f.parentId ? '↳ ' : '') + f.name;
    sel.appendChild(opt);
  });
}

function renderEditor() {
  const empty = $('editor-empty');
  const content = $('editor-content');
  // 作业管理页打开时，编辑区让位
  if (!$('jobs-view').hidden) {
    empty.hidden = true;
    content.hidden = true;
    return;
  }
  // Wiki 阅读器打开时，编辑区让位
  if (!$('wiki-viewer').hidden) {
    empty.hidden = true;
    content.hidden = true;
    return;
  }
  // 设置页打开时，编辑区让位
  if (!$('settings-view').hidden) {
    empty.hidden = true;
    content.hidden = true;
    return;
  }
  const note = currentNote();
  if (!note) {
    empty.hidden = false;
    content.hidden = true;
    return;
  }
  empty.hidden = true;
  content.hidden = false;

  if (document.activeElement !== $('note-title')) $('note-title').value = note.title || '';
  if (document.activeElement !== $('note-content')) $('note-content').value = note.content || '';
  $('note-tags').value = (note.tags || []).join(', ');
  renderFolderSelect();
  $('note-folder').value = note.folderId || '';
  $('note-time').textContent = `更新于 ${formatDate(note.updatedAt)}`;
  $('btn-pin').style.opacity = note.pinned ? '1' : '0.45';

  applyEditorMode();
  updatePreview();
}

function applyEditorMode() {
  const body = $('editor-body');
  body.className = 'editor-body mode-' + state.editorMode;
  ['edit', 'split', 'preview'].forEach((m) => {
    $('mode-' + m).classList.toggle('active', state.editorMode === m);
  });
}

function updatePreview() {
  const note = currentNote();
  if (note && state.editorMode !== 'edit') {
    $('note-preview').innerHTML = renderMarkdown(note.content);
  }
}

function updateNoteFromEditor() {
  const note = currentNote();
  if (!note) return;
  note.title = $('note-title').value;
  note.content = $('note-content').value;
  note.tags = $('note-tags').value
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean);
  note.updatedAt = Date.now();
  $('note-time').textContent = `更新于 ${formatDate(note.updatedAt)}`;
  persist();
}

function selectNote(id) {
  state.selectedNoteId = id;
  $('jobs-view').hidden = true;
  $('settings-view').hidden = true;
  renderNoteList();
  renderEditor();
  renderSidebar();
}

// ================= 笔记操作 =================
function createNote() {
  const note = {
    id: uid(),
    title: '',
    content: '',
    tags: [],
    folderId: state.view.type === 'folder' ? state.view.id : null,
    pinned: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  state.notes.unshift(note);
  persist();
  selectNote(note.id);
  renderSidebar();
  $('note-title').focus();
}

function deleteNote() {
  const note = currentNote();
  if (!note) return;
  if (!confirm(`确定删除笔记"${note.title || '无标题'}"？`)) return;
  state.notes = state.notes.filter((n) => n.id !== note.id);
  state.selectedNoteId = null;
  persist();
  renderAll();
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

  // Wiki 问答模式
  if (state.aiMode === 'wiki') {
    await sendWikiQuestion(question);
    return;
  }

  const refs = retrieveNotes(question);
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

  await window.kb.askAI({ settings: state.settings, messages });
}

// ================= LLM Wiki =================
async function loadWiki() {
  try {
    state.wiki = await window.kb.wikiDescribe(state.settings);
  } catch (_) {
    state.wiki = { exists: false, pages: [] };
  }
  renderWikiTree();
}

// LLM Wiki 区块整体折叠/展开（状态持久化到 settings）
function applyWikiCollapse() {
  const collapsed = !!state.settings.wikiCollapsed;
  $('wiki-collapse').hidden = collapsed;
  $('wiki-chevron').classList.toggle('collapsed', collapsed);
}

function toggleWikiCollapse() {
  state.settings.wikiCollapsed = !state.settings.wikiCollapsed;
  persist();
  applyWikiCollapse();
}

function typeIcon(type) {
  return { Concept: '💡', Source: '📄', Topic: '📚', Entity: '🧩', Answer: '💬' }[type] || '📄';
}

function renderWikiTree() {
  const tree = $('wiki-tree');
  tree.innerHTML = '';
  if (!state.wiki.exists) {
    tree.innerHTML = '<div class="wiki-empty-tip">未找到 Wiki（AGENTS.md）。可在设置中指定 Wiki 根目录，或先在工作目录创建 llmwiki。</div>';
    return;
  }
  const pages = state.wiki.pages || [];
  const labels = { '': '导航', concepts: '概念 Concepts', sources: '来源 Sources', topics: '主题 Topics', entities: '实体 Entities' };
  for (const key of Object.keys(labels)) {
    const list = pages.filter((p) => (p.path.includes('/') ? p.path.split('/')[0] : '') === key);
    if (!list.length) continue;
    const t = document.createElement('div');
    t.className = 'wiki-group-title';
    t.textContent = labels[key];
    tree.appendChild(t);
    for (const p of list) {
      const item = document.createElement('div');
      item.className = 'wiki-tree-item' + (state.wikiPage === p.path ? ' active' : '');
      item.dataset.path = p.path;
      const icon = key === '' ? (p.path === 'index.md' ? '🗺️' : '🕒') : typeIcon(p.type);
      item.innerHTML = `<span>${icon}</span><span class="wiki-title" title="${escapeHtml(p.description || p.path)}">${escapeHtml(p.title || p.path.replace(/^[^/]+\//, ''))}</span>`;
      item.onclick = () => openWikiPage(p.path);
      tree.appendChild(item);
    }
  }
}

function parseWikiFrontmatter(content) {
  const text = String(content).replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return { fm: {}, body: text };
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return { fm: {}, body: text };
  const fm = {};
  for (const line of text.slice(4, end).split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (m) fm[m[1]] = m[2].trim();
  }
  return { fm, body: text.slice(end + 5) };
}

function renderWikiFm(fm) {
  const box = $('wiki-fm');
  box.innerHTML = '';
  const keys = Object.keys(fm);
  if (!keys.length) { box.hidden = true; return; }
  box.hidden = false;
  const chip = (text, cls) => {
    const s = document.createElement('span');
    s.className = 'wiki-chip ' + (cls || '');
    s.textContent = text;
    box.appendChild(s);
  };
  if (fm.type) chip(fm.type, 'type');
  if (fm.status) chip('状态: ' + fm.status, 'status');
  if (fm.generated) chip('🤖 AI 生成');
  (fm.tags || '').replace(/^\[|\]$/g, '').split(',')
    .map((t) => t.trim()).filter(Boolean)
    .forEach((t) => chip('# ' + t, 'tag'));
}

async function openWikiPage(relPath) {
  const res = await window.kb.wikiRead({ settings: state.settings, relPath });
  if (!res.ok) { toast('无法打开：' + res.error); return; }
  state.wikiPage = relPath;
  const { fm, body } = parseWikiFrontmatter(res.content);
  const pageTitle = fm.title || '';
  $('wiki-page-path').textContent = pageTitle ? `${relPath} · ${pageTitle}` : relPath;
  $('wiki-viewer').title = pageTitle;
  renderWikiFm(fm);
  $('wiki-body').innerHTML = renderMarkdown(body);
  $('wiki-raw-text').value = res.content;
  $('wiki-body').hidden = false;
  $('wiki-raw-text').hidden = true;
  $('jobs-view').hidden = true;
  $('settings-view').hidden = true;
  $('wiki-viewer').hidden = false;
  renderEditor();
  renderWikiTree();
}

// 相对链接解析：以当前页面为基准
function resolveWikiPath(basePath, href) {
  if (href.startsWith('/')) return href.slice(1);
  const parts = basePath.split('/');
  parts.pop();
  for (const seg of href.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function closeWikiViewer() {
  $('wiki-viewer').hidden = true;
  $('wiki-viewer').title = '';
  state.wikiPage = null;
  renderEditor();
  renderWikiTree();
}

// ---------- 吸收（Ingest） ----------
const INGEST_EXTENSIONS = ['pdf', 'docx', 'xlsx', 'xls', 'pptx', 'md', 'markdown', 'txt', 'csv'];

function openIngestModal() {
  if (!state.wiki.exists) { toast('未找到 Wiki 目录，请先在设置中指定 Wiki 根目录'); return; }
  $('ingest-title').value = '';
  $('ingest-url').value = '';
  $('ingest-text').value = '';
  state.ingestFiles = [];
  renderFileList();
  setIngestStatus('', '');
  switchIngestTab(state.ingestTab);
  $('btn-ingest-go').disabled = false;
  $('ingest-modal').hidden = false;
}

function switchIngestTab(tab) {
  state.ingestTab = tab;
  $('ingest-tab-url').classList.toggle('active', tab === 'url');
  $('ingest-tab-text').classList.toggle('active', tab === 'text');
  $('ingest-tab-files').classList.toggle('active', tab === 'files');
  $('ingest-url-panel').hidden = tab !== 'url';
  $('ingest-text-panel').hidden = tab !== 'text';
  $('ingest-files-panel').hidden = tab !== 'files';
  // 文件模式标题由文件名决定，隐藏标题输入
  document.querySelectorAll('#ingest-modal > .modal > label')[0].hidden = tab === 'files';
  $('ingest-title').hidden = tab === 'files';
}

function fileExt(name) {
  const m = String(name).match(/\.([^.]+)$/);
  return m ? m[1].toLowerCase() : '';
}

function addIngestFiles(paths) {
  let skipped = 0;
  for (const p of paths) {
    const name = p.replace(/[\\/]/g, '/').split('/').pop();
    if (!INGEST_EXTENSIONS.includes(fileExt(name))) { skipped++; continue; }
    if (state.ingestFiles.some((f) => f.path === p)) continue;
    state.ingestFiles.push({ path: p, name });
  }
  renderFileList();
  if (skipped > 0) toast(`已跳过 ${skipped} 个不支持格式的文件`, 3000);
}

function renderFileList() {
  const box = $('file-list');
  box.innerHTML = '';
  state.ingestFiles.forEach((f, idx) => {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.innerHTML = `<span class="file-ext">${escapeHtml(fileExt(f.name) || '?')}</span><span class="file-name" title="${escapeHtml(f.path)}">${escapeHtml(f.name)}</span>`;
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.textContent = '✕';
    del.title = '移除';
    del.onclick = () => { state.ingestFiles.splice(idx, 1); renderFileList(); };
    item.appendChild(del);
    box.appendChild(item);
  });
}

function setIngestStatus(text, cls) {
  const el = $('ingest-status');
  el.textContent = text;
  const running = !!text && !cls;
  el.className = 'ingest-status' + (cls ? ' ' + cls : '') + (running ? ' running' : '');
}

async function runIngest() {
  const title = $('ingest-title').value.trim();
  const url = $('ingest-url').value.trim();
  const text = $('ingest-text').value;
  if (state.ingestTab === 'url' && !url) { setIngestStatus('请填写 URL', 'err'); return; }
  if (state.ingestTab === 'text' && !text.trim()) { setIngestStatus('请粘贴文本内容', 'err'); return; }
  if (state.ingestTab === 'files' && state.ingestFiles.length === 0) { setIngestStatus('请先选择或拖入至少一个文件', 'err'); return; }

  const payload = {
    settings: state.settings,
    files: state.ingestTab === 'files' ? state.ingestFiles.slice() : [],
    url: state.ingestTab === 'url' ? url : '',
    text: state.ingestTab === 'text' ? text : '',
    title,
  };
  const res = await window.kb.jobsSubmit({ type: 'ingest', payload });
  if (!res.ok) { setIngestStatus('提交作业失败：' + res.error, 'err'); return; }
  state.ingestFiles = [];
  renderFileList();
  $('ingest-modal').hidden = true;
  toast('吸收作业已提交，可在「作业」页查看进度');
  showJobsView();
}

// ---------- 体检（Lint） ----------
async function runLint() {
  if (!state.wiki.exists) { toast('未找到 Wiki 目录'); return; }
  const res = await window.kb.jobsSubmit({ type: 'lint', payload: { settings: state.settings } });
  if (!res.ok) { toast('提交作业失败：' + res.error, 4000); return; }
  toast('体检作业已提交');
  showJobsView();
}

// ---------- 作业管理（专属页面） ----------
function showJobsView() {
  $('wiki-viewer').hidden = true;
  $('settings-view').hidden = true;
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
  $('btn-wiki-jobs').classList.toggle('jobs-active', hasActive);
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
  $('jobs-stats').textContent = `共 ${state.jobs.length} · 运行 ${c.running} · 排队 ${c.queued} · 成功 ${c.success} · 失败 ${c.failed}`;
  document.querySelectorAll('#jobs-filter button').forEach((b) => {
    b.classList.toggle('active', b.dataset.filter === state.jobsFilter);
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
  const expanded = !!state.jobsExpanded[job.id];
  const card = document.createElement('div');
  card.className = 'job-row-card ' + job.status;

  const [statusText, statusCls] = jobStatusMeta(job.status);
  const icon = job.type === 'ingest' ? '📥' : '🩺';
  const stages = job.stages || [];
  const doneCount = stages.filter((s) => s.status === 'success').length;
  let dur = '';
  if (job.finishedAt && job.startedAt) dur = fmtDuration(job.finishedAt - job.startedAt);
  else if (job.status === 'running' && job.startedAt) dur = fmtDuration(Date.now() - job.startedAt) + '（进行中）';

  const head = document.createElement('div');
  head.className = 'job-row';
  head.innerHTML = `
    <span class="job-chevron">${expanded ? '▾' : '▸'}</span>
    <span class="job-icon">${icon}</span>
    <span class="job-title" title="${escapeHtml(job.title)}">${escapeHtml(job.title)}</span>
    <span class="job-progress" title="已完成阶段数">${doneCount}/${stages.length}</span>
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

  const stages = document.createElement('div');
  stages.className = 'job-stages';
  for (const st of job.stages || []) {
    const row = document.createElement('div');
    row.className = 'job-stage ' + st.status;
    const ico = st.status === 'success' ? '✓' : st.status === 'failed' ? '✕' : st.status === 'running' ? '<span class="mini-spinner"></span>' : '○';
    row.innerHTML = `<span class="stage-ico">${ico}</span><span class="stage-name">${escapeHtml(st.name)}</span><span class="stage-detail">${escapeHtml(st.detail || '')}</span>`;
    stages.appendChild(row);
  }
  detail.appendChild(stages);

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
  if (res.ok) { toast('重试作业已提交'); return; }
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
    }
  }
  state.jobs = list;
  renderJobs();
  if (needWikiRefresh) loadWiki();
}

// ---------- Wiki 问答与回填 ----------
function setAiMode(mode) {
  state.aiMode = mode;
  $('ai-mode-notes').classList.toggle('active', mode === 'notes');
  $('ai-mode-wiki').classList.toggle('active', mode === 'wiki');
  $('ai-hint').textContent = mode === 'wiki'
    ? '基于 LLM Wiki 回答：先查索引选页，再综合作答；有价值的回答可回填归档。'
    : '基于你的知识库内容回答问题，发送前会自动检索相关笔记。';
}

async function sendWikiQuestion(question) {
  const msgEl = addAiMessage('assistant', '');
  msgEl.querySelector('.bubble').classList.add('is-loading');
  msgEl.querySelector('.bubble').innerHTML = loadingHtml('正在查阅 Wiki');
  const bubble = msgEl.querySelector('.bubble');

  state.aiBusy = true;
  $('btn-ai-send').disabled = true;
  cleanupAiListeners();

  let answer = '';
  const offRefs = window.kb.onWikiRefs((refs) => {
    if (!refs || !refs.length) return;
    const box = document.createElement('div');
    box.className = 'ai-refs';
    const label = document.createElement('span');
    label.style.cssText = 'font-size:11px;color:var(--text-sub)';
    label.textContent = '📖 引用页面：';
    box.appendChild(label);
    refs.forEach((p) => {
      const chip = document.createElement('span');
      chip.className = 'ai-ref-chip';
      chip.textContent = p;
      chip.onclick = () => openWikiPage(p);
      box.appendChild(chip);
    });
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

  await window.kb.wikiAsk({ settings: state.settings, question });
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

// ================= 设置 =================
const EDITOR_MODES = ['edit', 'split', 'preview'];

// 数值配置项表单：id 与钳制范围（留空时主进程回退默认值）
const NUM_SETTING_FIELDS = {
  maxJobsHistory: ['set-maxhistory', 1, 500],
  chatRetries: ['set-retries', 0, 5],
  urlFetchTimeout: ['set-urltimeout', 1, 600],
  sourceMaxChars: ['set-sourcechars', 1000, 1000000],
  wikiAskMaxPages: ['set-askpages', 1, 20],
  logTailLines: ['set-loglines', 1, 500],
};

function showSettingsView() {
  const s = state.settings;
  $('set-baseurl').value = s.apiBaseUrl || '';
  $('set-apikey').value = s.apiKey || '';
  $('set-model').value = s.model || '';
  $('set-wikiroot').value = s.wikiRoot || '';
  $('set-wikicollapsed').checked = !!s.wikiCollapsed;
  const fillNum = (id, v) => { $(id).value = Number.isFinite(v) ? String(v) : ''; };
  for (const [key, [id]] of Object.entries(NUM_SETTING_FIELDS)) fillNum(id, s[key]);
  $('set-editormode').value = EDITOR_MODES.includes(s.defaultEditorMode) ? s.defaultEditorMode : 'split';
  window.kb.wikiDefaultRoot().then((p) => { $('set-wikiroot').placeholder = '留空则自动探测：' + p; });
  window.kb.getDataPath().then((p) => {
    state.currentDbPath = p;
    $('set-dbpath').value = p;
    $('data-path').textContent = '数据文件：' + p;
  });
  switchSettingsTab(state.settingsTab || 'ai');
  $('wiki-viewer').hidden = true;
  $('jobs-view').hidden = true;
  $('settings-view').hidden = false;
  renderEditor();
  renderSidebar();
}

function hideSettingsView() {
  $('settings-view').hidden = true;
  renderEditor();
  renderSidebar();
}

// Tab 切换：记录当前分类，仅显示对应表单区
function switchSettingsTab(tab) {
  state.settingsTab = tab;
  document.querySelectorAll('#settings-tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('.settings-pane').forEach((p) => {
    p.hidden = p.dataset.pane !== tab;
  });
}

function readNumInput(id, min, max) {
  const raw = $(id).value.trim();
  if (!raw) return null;
  const v = Number(raw);
  if (!Number.isFinite(v)) return null;
  return Math.min(max, Math.max(min, Math.round(v)));
}

async function saveSettings() {
  // 数据文件位置先行：先迁移，随后其他设置保存到新库
  const newDbPath = $('set-dbpath').value.trim();
  if (newDbPath !== state.currentDbPath) {
    const res = await window.kb.setDbPath(newDbPath);
    if (!res.ok) { toast('数据文件位置切换失败：' + res.error, 4000); return; }
    state.currentDbPath = res.path;
    $('set-dbpath').value = res.path;
    $('data-path').textContent = '数据文件：' + res.path;
    if (res.changed) toast('数据已迁移至：' + res.path, 4000);
  }
  // 保留非表单字段，避免保存设置时丢失
  const s = { ...state.settings };
  s.apiBaseUrl = $('set-baseurl').value.trim();
  s.apiKey = $('set-apikey').value.trim();
  s.model = $('set-model').value.trim();
  s.wikiRoot = $('set-wikiroot').value.trim();
  s.wikiCollapsed = $('set-wikicollapsed').checked;
  // 数值项：留空/非法则删除，由主进程回退默认值
  for (const [key, [id, min, max]] of Object.entries(NUM_SETTING_FIELDS)) {
    const v = readNumInput(id, min, max);
    if (v === null) delete s[key]; else s[key] = v;
  }
  const mode = $('set-editormode').value;
  if (EDITOR_MODES.includes(mode)) {
    s.defaultEditorMode = mode;
    state.editorMode = mode;
    applyEditorMode();
    updatePreview();
  }
  state.settings = s;
  persist();
  toast('设置已保存');
  applyWikiCollapse();
  loadWiki();
}

// ================= 汇总渲染 =================
function renderAll() {
  renderSidebar();
  renderNoteList();
  renderEditor();
}

// ================= 事件绑定 =================
function bindEvents() {
  // 新建 / 删除 / 置顶 / 导出
  $('btn-new-note').addEventListener('click', createNote);
  $('btn-delete').addEventListener('click', deleteNote);
  $('btn-pin').addEventListener('click', () => {
    const note = currentNote();
    if (!note) return;
    note.pinned = !note.pinned;
    persist();
    renderAll();
  });
  $('btn-export').addEventListener('click', async () => {
    const note = currentNote();
    if (!note) return;
    const res = await window.kb.exportNote({
      defaultName: (note.title || '未命名笔记') + '.md',
      content: `# ${note.title || '未命名笔记'}\n\n${note.content || ''}`,
    });
    if (res && res.ok) toast('已导出：' + res.path);
  });

  // 全部笔记
  $('nav-all-notes').addEventListener('click', () => {
    state.view = { type: 'all', id: null, query: '' };
    $('search-input').value = '';
    $('settings-view').hidden = true;
    renderAll();
  });

  // 新建目录
  $('btn-add-folder').addEventListener('click', async () => {
    const name = await askInput('新目录名称：');
    if (!name || !name.trim()) return;
    state.folders.push({ id: uid(), name: name.trim(), parentId: null });
    persist();
    renderAll();
  });

  // 搜索
  $('search-input').addEventListener('input', (e) => {
    const q = e.target.value;
    state.view = q.trim()
      ? { type: 'search', id: null, query: q.trim() }
      : { type: 'all', id: null, query: '' };
    renderAll();
  });

  // 编辑区输入（防抖更新）
  let editTimer = null;
  const onEdit = () => {
    clearTimeout(editTimer);
    editTimer = setTimeout(() => {
      updateNoteFromEditor();
      updatePreview();
      renderNoteList();
      renderSidebar();
    }, 300);
  };
  $('note-title').addEventListener('input', onEdit);
  $('note-content').addEventListener('input', onEdit);
  $('note-tags').addEventListener('change', () => {
    updateNoteFromEditor();
    renderAll();
  });
  $('note-folder').addEventListener('change', () => {
    const note = currentNote();
    if (!note) return;
    note.folderId = $('note-folder').value || null;
    note.updatedAt = Date.now();
    persist();
    renderNoteList();
    renderSidebar();
  });

  // 编辑模式切换
  ['edit', 'split', 'preview'].forEach((m) => {
    $('mode-' + m).addEventListener('click', () => {
      state.editorMode = m;
      applyEditorMode();
      updatePreview();
    });
  });

  // AI 面板（分隔条随面板显隐）
  $('btn-ai-toggle').addEventListener('click', () => {
    setAiPanelVisible($('ai-panel').hidden);
    if (!$('ai-panel').hidden) $('ai-input').focus();
  });
  $('btn-ai-close').addEventListener('click', () => { setAiPanelVisible(false); });
  $('btn-ai-clear').addEventListener('click', () => {
    aiHistory = [];
    $('ai-messages').innerHTML = '';
  });
  $('btn-ai-send').addEventListener('click', sendAiQuestion);
  $('ai-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendAiQuestion();
    }
  });

  // 设置（主区域 Tab 页）
  $('btn-settings').addEventListener('click', showSettingsView);
  $('btn-settings-close').addEventListener('click', hideSettingsView);
  $('btn-settings-save').addEventListener('click', saveSettings);
  $('settings-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (btn) switchSettingsTab(btn.dataset.tab);
  });

  // ---------- LLM Wiki ----------
  $('wiki-header').addEventListener('click', (e) => {
    if (e.target.closest('#btn-wiki-ingest')) return; // ＋ 按钮不触发折叠
    toggleWikiCollapse();
  });
  $('btn-wiki-ingest').addEventListener('click', openIngestModal);
  $('btn-wiki-ask').addEventListener('click', () => {
    setAiPanelVisible(true);
    setAiMode('wiki');
    $('ai-input').focus();
  });
  $('btn-wiki-close').addEventListener('click', closeWikiViewer);
  $('btn-wiki-source').addEventListener('click', () => {
    const body = $('wiki-body');
    const raw = $('wiki-raw-text');
    const showRaw = body.hidden === false;
    body.hidden = showRaw;
    raw.hidden = !showRaw;
  });
  // Wiki 页面内部 md 链接导航
  $('wiki-body').addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (!href.endsWith('.md')) return;
    e.preventDefault();
    openWikiPage(resolveWikiPath(state.wikiPage || '', href));
  });

  // 吸收弹窗
  $('ingest-tab-url').addEventListener('click', () => switchIngestTab('url'));
  $('ingest-tab-text').addEventListener('click', () => switchIngestTab('text'));
  $('ingest-tab-files').addEventListener('click', () => switchIngestTab('files'));
  $('btn-pick-files').addEventListener('click', async () => {
    const res = await window.kb.wikiPickFiles();
    if (res && res.ok && res.paths.length) addIngestFiles(res.paths);
  });
  // 拖拽上传：拖到弹窗任意位置均可
  const modal = $('ingest-modal');
  ['dragenter', 'dragover'].forEach((evt) => {
    modal.addEventListener(evt, (e) => {
      e.preventDefault();
      if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files')) {
        if (state.ingestTab !== 'files') switchIngestTab('files');
        $('file-drop').classList.add('dragover');
      }
    });
  });
  modal.addEventListener('dragleave', (e) => {
    if (e.target === modal) $('file-drop').classList.remove('dragover');
  });
  modal.addEventListener('drop', (e) => {
    e.preventDefault();
    $('file-drop').classList.remove('dragover');
    const files = [...(e.dataTransfer?.files || [])];
    const paths = files.map((f) => f.path).filter(Boolean);
    if (paths.length) {
      if (state.ingestTab !== 'files') switchIngestTab('files');
      addIngestFiles(paths);
    }
  });
  $('btn-ingest-go').addEventListener('click', runIngest);
  $('btn-ingest-cancel').addEventListener('click', () => { $('ingest-modal').hidden = true; });
  $('ingest-modal').addEventListener('click', (e) => {
    if (e.target === $('ingest-modal')) $('ingest-modal').hidden = true;
  });

  // Lint 弹窗
  $('btn-lint-close').addEventListener('click', () => { $('lint-modal').hidden = true; });
  $('lint-modal').addEventListener('click', (e) => {
    if (e.target === $('lint-modal')) $('lint-modal').hidden = true;
  });

  // 作业管理页
  $('btn-wiki-jobs').addEventListener('click', showJobsView);
  $('btn-jobs-close').addEventListener('click', hideJobsView);
  $('btn-jobs-new-lint').addEventListener('click', runLint);
  $('btn-jobs-clear').addEventListener('click', clearJobsHistory);
  $('jobs-filter').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-filter]');
    if (!btn) return;
    state.jobsFilter = btn.dataset.filter;
    renderJobsView();
  });

  // AI 模式切换
  $('ai-mode-notes').addEventListener('click', () => setAiMode('notes'));
  $('ai-mode-wiki').addEventListener('click', () => setAiMode('wiki'));

  // 快捷键：Ctrl+N 新建，Ctrl+F 聚焦搜索
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      createNote();
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('search-input').focus();
    }
  });
}

// ================= 面板宽度拖拽 =================
// 显隐 AI 面板，同步其分隔条
function setAiPanelVisible(visible) {
  $('ai-panel').hidden = !visible;
  $('ai-resizer').hidden = !visible;
}

// 分隔条左右拖动调整侧边栏/笔记列表/AI 面板宽度，宽度记忆在 localStorage，双击复位
// invert: 右侧面板拖拽方向相反（向左拖变宽）
function initResizers() {
  const defs = [
    { handle: 'sidebar-resizer', pane: document.querySelector('.sidebar'), key: 'kb.sidebarWidth', def: 230, min: 180, max: 480 },
    { handle: 'notelist-resizer', pane: document.querySelector('.note-list-pane'), key: 'kb.noteListWidth', def: 290, min: 200, max: 520 },
    { handle: 'ai-resizer', pane: $('ai-panel'), key: 'kb.aiPanelWidth', def: 400, min: 280, max: 720, invert: true },
  ];
  for (const d of defs) {
    const handle = $(d.handle);
    const saved = parseInt(localStorage.getItem(d.key), 10);
    if (saved >= d.min && saved <= d.max) d.pane.style.width = saved + 'px';

    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      handle.classList.add('dragging');
      document.body.classList.add('col-resizing');
      const startX = e.clientX;
      const startW = d.pane.getBoundingClientRect().width;
      const move = (ev) => {
        const delta = (ev.clientX - startX) * (d.invert ? -1 : 1);
        const w = Math.min(d.max, Math.max(d.min, startW + delta));
        d.pane.style.width = w + 'px';
      };
      const up = () => {
        handle.classList.remove('dragging');
        document.body.classList.remove('col-resizing');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        localStorage.setItem(d.key, parseInt(d.pane.style.width, 10));
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });

    handle.addEventListener('dblclick', () => {
      d.pane.style.width = d.def + 'px';
      localStorage.removeItem(d.key);
    });
  }
}

// ================= 初始化 =================
async function init() {
  marked.setOptions({ breaks: true, gfm: true });
  const store = await window.kb.loadData();
  state.folders = store.folders || [];
  state.notes = store.notes || [];
  state.settings = store.settings || {};

  // 首次使用生成示例笔记
  if (state.notes.length === 0) {
    state.notes.push({
      id: uid(),
      title: '👋 欢迎使用个人知识库助手',
      content: [
        '## 快速上手',
        '',
        '- **新建笔记**：左上角"＋ 新建"按钮，或快捷键 `Ctrl + N`',
        '- **搜索**：左侧搜索框，或快捷键 `Ctrl + F`，支持标题、内容、标签全文检索',
        '- **目录与标签**：左侧可创建多级目录；标签在笔记元信息栏中用逗号分隔填写',
        '- **编辑模式**：工具栏可切换 编辑 / 分屏 / 预览 三种模式',
        '',
        '## Markdown 语法示例',
        '',
        '1. 有序列表',
        '- 无序列表',
        '',
        '> 引用块效果',
        '',
        '```js',
        'console.log("代码块高亮");',
        '```',
        '',
        '## AI 智能问答',
        '',
        '点击左下角 **🤖 AI 问答** 打开对话面板，在 **⚙ 设置** 中配置任意兼容 OpenAI 格式的接口',
        '（如 DeepSeek、通义千问、Ollama 本地模型等），即可基于你的笔记内容进行问答。',
      ].join('\n'),
      tags: ['指南'],
      folderId: null,
      pinned: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    persist();
  }

  bindEvents();
  initResizers();
  // 默认编辑器模式读设置（缺省分屏）
  state.editorMode = EDITOR_MODES.includes(state.settings.defaultEditorMode) ? state.settings.defaultEditorMode : 'split';
  applyWikiCollapse();
  renderAll();
  loadWiki();
  window.kb.onJobsUpdate(handleJobsUpdate);
  window.kb.jobsList().then((list) => { state.jobs = list || []; renderJobs(); });
  if (state.notes.length) selectNote(getFilteredNotes()[0]?.id || state.notes[0].id);
}

init();
