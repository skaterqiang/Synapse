// 渲染进程·笔记模块：过滤、列表、编辑器、笔记操作、仿备忘录工具栏
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

// ================= 渲染：笔记列表 =================
function renderNoteList() {
  if (state.view.type === 'wiki') { renderWikiList(); return; }
  if (state.view.type === 'search') { renderSearchResults(); return; }
  const list = getFilteredNotes();
  $('note-list-title').textContent = getViewTitle();
  $('note-list-count').textContent = list.length ? `${list.length} 篇` : '';

  const container = $('note-list');
  container.innerHTML = '';
  if (list.length === 0) {
    container.innerHTML = '<div class="list-empty">暂无笔记<br>点击「全部笔记」或目录旁的 ＋ 开始记录</div>';
    return;
  }

  const q = state.view.type === 'search' ? state.view.query : '';
  list.forEach((note) => {
    const card = document.createElement('div');
    card.className = 'note-card' + (note.id === state.selectedNoteId ? ' active' : '');
    const snippet = noteSnippet(note.content);
    const words = wordCount(note.content);
    const tagsHtml = (note.tags || []).slice(0, 3)
      .map((t) => `<span class="mini-tag">${highlight(t, q)}</span>`).join('');
    card.innerHTML = `
      <div class="note-card-title">${note.pinned ? '📌 ' : ''}${highlight(note.title || '无标题笔记', q)}</div>
      <div class="note-card-snippet">${highlight(snippet, q) || '<span style="opacity:.5">（空笔记）</span>'}</div>
      <div class="note-card-footer"><span class="nc-time" title="${formatDate(note.updatedAt)}">${formatRelDate(note.updatedAt)}</span><span class="nc-words">${words} 字</span>${tagsHtml}</div>`;
    card.addEventListener('click', () => selectNote(note.id));
    // 右键菜单：提取 Wiki / 知识图谱（按钮入口已统一为右键）
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openCtxMenu(e.clientX, e.clientY, [
        { label: '📝 提取 Wiki', action: () => { selectNote(note.id); noteToWiki(); } },
        { label: '🕸 提取知识图谱', action: () => { selectNote(note.id); noteToGraph(); } },
      ]);
    });
    container.appendChild(card);
  });
}

// 全局搜索：跨 笔记/原始文件/Wiki/知识图谱 分类展示结果
function renderSearchResults() {
  const q = (state.view.query || '').trim().toLowerCase();
  $('note-list-title').textContent = getViewTitle();
  const container = $('note-list');
  container.innerHTML = '';
  if (!q) {
    $('note-list-count').textContent = '';
    container.innerHTML = '<div class="list-empty">输入关键词搜索<br>笔记 / 原始文件 / Wiki / 知识图谱</div>';
    return;
  }
  const has = (s) => String(s || '').toLowerCase().includes(q);
  const notes = state.notes.filter((n) => has(n.title) || has(n.content) || (n.tags || []).some(has));
  const raws = (state.raws || []).filter((r) => has(r.name) || has(r.path));
  const wikis = ((state.wiki && state.wiki.pages) || []).filter((p) => has(p.title) || has(p.path) || has(p.description));
  const graphs = ((state.graph && state.graph.nodes) || []).filter((n) => has(n.name) || has(n.desc));
  const total = notes.length + raws.length + wikis.length + graphs.length;
  $('note-list-count').textContent = total ? `${total} 条结果` : '';
  if (!total) {
    container.innerHTML = `<div class="list-empty">未找到与「${escapeHtml(state.view.query)}」相关的内容</div>`;
    return;
  }
  const secHead = (icon, name, count) => {
    const h = document.createElement('div');
    h.className = 'search-sec';
    h.innerHTML = `${icon} ${name} <span class="wiki-group-count">${count}</span>`;
    container.appendChild(h);
  };
  const row = (icon, title, meta, onClick) => {
    const item = document.createElement('div');
    item.className = 'wiki-tree-item';
    item.innerHTML = `<span class="wiki-ico">${icon}</span><span class="wiki-title">${highlight(title, q)}</span>`;
    if (meta) item.title = meta;
    item.addEventListener('click', onClick);
    container.appendChild(item);
  };
  if (notes.length) { secHead('📝', '笔记', notes.length); notes.forEach((n) => row('📝', n.title || '无标题笔记', '', () => selectNote(n.id))); }
  if (raws.length) { secHead('📄', '原始文件', raws.length); raws.forEach((r) => row('📄', r.name, r.path, () => showRawView())); }
  if (wikis.length) { secHead('📚', 'Wiki', wikis.length); wikis.forEach((p) => row(typeIcon(p.type), p.title || p.path, p.path, () => openWikiPage(p.path))); }
  if (graphs.length) { secHead('🕸', '知识图谱', graphs.length); graphs.forEach((n) => row('🕸', n.name, n.type, () => { state.kg.tab = 'entities'; state.kg.entitySel = n.id; showGraphView(); })); }
}

// 中间列表 Wiki 分组折叠状态（会话内记忆）
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
  syncNoteListVisibility();
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
  // 知识图谱页打开时，编辑区让位
  if (!$('graph-view').hidden) {
    empty.hidden = true;
    content.hidden = true;
    return;
  }
  // 领域模版页打开时，编辑区让位
  if (!$('tpl-view').hidden) {
    empty.hidden = true;
    content.hidden = true;
    return;
  }
  // 原始文件页打开时，编辑区让位
  if (!$('raw-view').hidden) {
    empty.hidden = true;
    content.hidden = true;
    return;
  }
  // 提示词管理页打开时，编辑区让位
  if (!$('prompts-view').hidden) {
    empty.hidden = true;
    content.hidden = true;
    return;
  }
  // 提示词全屏编辑页打开时，编辑区让位
  if (!$('prompt-editor-view').hidden) {
    empty.hidden = true;
    content.hidden = true;
    return;
  }
  // AI 问答主页打开时，编辑区让位
  if ($('ai-view') && !$('ai-view').hidden) {
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
  $('note-time').textContent = `更新于 ${formatRelDate(note.updatedAt)}`;
  $('note-time').title = formatDate(note.updatedAt);
  const words = wordCount(note.content);
  $('note-date').textContent = note.updatedAt ? `${words} 字` : '';
  $('btn-pin').style.opacity = note.pinned ? '1' : '0.45';

  applyEditorMode();
  updatePreview();
  syncNoteListVisibility();
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
  // 标题唯一（附件目录按标题组织）：重名自动加数字后缀
  let title = $('note-title').value;
  const uniq = uniqueNoteTitle(title, note.id);
  if (uniq !== title) {
    title = uniq;
    $('note-title').value = title;
    toast('笔记标题重复，已自动命名为：' + title, 3000);
  }
  note.title = title;
  note.content = $('note-content').value;
  note.tags = $('note-tags').value
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean);
  note.updatedAt = Date.now();
  $('note-time').textContent = `更新于 ${formatRelDate(note.updatedAt)}`;
  $('note-time').title = formatDate(note.updatedAt);
  $('note-date').textContent = `${wordCount(note.content)} 字`;
  persist();
}

function selectNote(id) {
  state.selectedNoteId = id;
  hideMainViews();
  renderNoteList();
  renderEditor();
  renderSidebar();
}

// ================= 笔记操作 =================
function createNote(folderId, title) {
  const note = {
    id: uid(),
    title: title || uniqueNoteTitle('新建笔记', null),
    content: '',
    tags: [],
    folderId: folderId !== undefined ? folderId : (state.view.type === 'folder' ? state.view.id : null),
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

// ＋ 新建笔记：弹窗输入标题，标题必填且不可重复
async function promptCreateNote(folderId) {
  const t = await askInput('笔记标题：');
  const title = (t || '').trim();
  if (!title) return;
  if (state.notes.some((n) => (n.title || '').trim() === title)) {
    toast('标题已存在，不能重复', 3000);
    return;
  }
  createNote(folderId, title);
}

// 笔记标题唯一性：空标题归一为「无标题笔记」，冲突时追加数字后缀（附件目录按标题组织，须避免重名混目录）
function uniqueNoteTitle(base, exceptId) {
  const taken = new Set(state.notes.filter((n) => n.id !== exceptId).map((n) => (n.title || '').trim()));
  const b = String(base || '').trim() || '无标题笔记';
  if (!taken.has(b)) return b;
  let i = 2;
  while (taken.has(`${b} ${i}`)) i++;
  return `${b} ${i}`;
}

function deleteNote() {
  const note = currentNote();
  if (!note) return;
  if (!confirm(`确定删除笔记"${note.title || '无标题'}"？`)) return;
  state.notes = state.notes.filter((n) => n.id !== note.id);
  window.kb.noteDeleteVersions({ noteId: note.id });
  state.selectedNoteId = null;
  persist();
  renderAll();
}

// ================= 编辑工具栏（仿备忘录） =================
// 弹出菜单定位到按钮下方，点击外部自动关闭
function toggleMenu(menu, btn) {
  const other = menu.id === 'format-menu' ? $('attach-menu') : $('format-menu');
  other.hidden = true;
  if (!menu.hidden) { menu.hidden = true; return; }
  menu.hidden = false;
  const r = btn.getBoundingClientRect();
  const w = menu.offsetWidth || 200;
  menu.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left)) + 'px';
  menu.style.top = r.bottom + 6 + 'px';
  const cleanup = () => {
    document.removeEventListener('mousedown', onClose);
    document.removeEventListener('keydown', onKey);
  };
  const onClose = (ev) => {
    if (menu.hidden) { cleanup(); return; }
    if (!menu.contains(ev.target) && !btn.contains(ev.target)) {
      menu.hidden = true;
      cleanup();
    }
  };
  const onKey = (ev) => {
    if (ev.key === 'Escape') { menu.hidden = true; cleanup(); }
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onClose);
    document.addEventListener('keydown', onKey);
  }, 0);
}

// 在选区两侧包裹 Markdown 标记（无选区时插入占位文字）
function wrapSelection(before, after) {
  const ta = $('note-content');
  const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
  const sel = v.slice(s, e) || '文字';
  ta.value = v.slice(0, s) + before + sel + after + v.slice(e);
  ta.selectionStart = s + before.length;
  ta.selectionEnd = s + before.length + sel.length;
  ta.focus();
  updateNoteFromEditor();
}

// 对选区覆盖的行逐行变换（标题/列表/引用等）
function transformLines(fn) {
  const ta = $('note-content');
  const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
  const start = v.lastIndexOf('\n', s - 1) + 1;
  let end = v.indexOf('\n', e);
  if (end === -1) end = v.length;
  const out = v.slice(start, end).split('\n').map(fn).join('\n');
  ta.value = v.slice(0, start) + out + v.slice(end);
  ta.selectionStart = start;
  ta.selectionEnd = start + out.length;
  ta.focus();
  updateNoteFromEditor();
}

function applyFormat(fmt) {
  const stripLine = (l) => l.replace(/^(\s*)(#{1,6}\s+|>\s+|[-*]\s+(\[[ x]\]\s+)?|\d+\.\s+)/, '$1');
  switch (fmt) {
    case 'bold': return wrapSelection('**', '**');
    case 'italic': return wrapSelection('*', '*');
    case 'underline': return wrapSelection('<u>', '</u>');
    case 'strike': return wrapSelection('~~', '~~');
    case 'code': return wrapSelection('`', '`');
    case 'mono': return wrapSelection('\n```\n', '\n```\n');
    case 'h1': return transformLines((l) => '# ' + stripLine(l));
    case 'h2': return transformLines((l) => '## ' + stripLine(l));
    case 'h3': return transformLines((l) => '### ' + stripLine(l));
    case 'p': return transformLines(stripLine);
    case 'ul': return transformLines((l) => '- ' + stripLine(l));
    case 'ol': { let i = 0; return transformLines((l) => `${++i}. ` + stripLine(l)); }
    case 'quote': return transformLines((l) => '> ' + stripLine(l));
    case 'checklist':
      return transformLines((l) => (/^- \[[ x]\] /.test(l) ? stripLine(l) : '- [ ] ' + stripLine(l)));
  }
}

function insertAtCursor(text) {
  const ta = $('note-content');
  const s = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
  const e = ta.selectionEnd == null ? s : ta.selectionEnd;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + text.length;
  ta.focus();
  updateNoteFromEditor();
}

function insertTable() {
  insertAtCursor('\n| 列 1 | 列 2 |\n| --- | --- |\n|  |  |\n|  |  |\n');
}

// 图片存储方式选择弹窗：返回 'local' | 'embed' | null(取消)
function askImageStorage() {
  return new Promise((resolve) => {
    const mask = $('image-storage-modal');
    mask.hidden = false;
    const done = (v) => {
      mask.hidden = true;
      $('btn-imgstore-ok').removeEventListener('click', onOk);
      $('btn-imgstore-cancel').removeEventListener('click', onCancel);
      mask.removeEventListener('click', onMask);
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onOk = () => done((document.querySelector('input[name="img-store"]:checked') || {}).value || 'local');
    const onCancel = () => done(null);
    const onMask = (e) => { if (e.target === mask) done(null); };
    const onKey = (e) => { if (e.key === 'Escape') done(null); };
    $('btn-imgstore-ok').addEventListener('click', onOk);
    $('btn-imgstore-cancel').addEventListener('click', onCancel);
    mask.addEventListener('click', onMask);
    document.addEventListener('keydown', onKey);
  });
}

// 附加文件/照片：图片以 dataUrl 内嵌 Markdown；扫描文稿：图片送大模型视觉识别后插入
async function attachAction(act) {
  if (act === 'scan') {
    const pick = await window.kb.notePickImage({ imagesOnly: true });
    if (!pick.ok) { toast('选择失败：' + pick.error, 4000); return; }
    if (pick.canceled || !pick.dataUrl) return;
    toast('AI 正在识别文稿…');
    const res = await window.kb.noteScan({ settings: state.settings, dataUrl: pick.dataUrl });
    if (!res.ok) { toast('扫描失败：' + res.error, 5000); return; }
    insertAtCursor('\n' + res.text + '\n');
    toast('扫描结果已插入');
    return;
  }
  const pick = await window.kb.notePickImage({ imagesOnly: act === 'photo' });
  if (!pick.ok) { toast('选择失败：' + pick.error, 4000); return; }
  if (pick.canceled) return;
  if (pick.dataUrl) {
    // 图片存储二选一：本地文件引用（默认）或 base64 内嵌
    const choice = await askImageStorage();
    if (!choice) return;
    if (choice === 'embed') {
      insertAtCursor(`\n![${pick.name}](${pick.dataUrl})\n`);
    } else {
      const res = await window.kb.noteSaveImage({ dataUrl: pick.dataUrl, name: pick.name, title: (currentNote() && currentNote().title) || '', folderId: (currentNote() && currentNote().folderId) || null });
      if (!res.ok) { toast('保存图片失败：' + res.error, 4000); return; }
      insertAtCursor(`\n![${pick.name}](kb-asset://file${encodeURI(res.path)})\n`);
    }
    return;
  }
  else if (pick.path) insertAtCursor(`\n[${pick.name}](file://${pick.path})\n`);
  else toast('Web 模式仅支持插入图片', 3000);
}

// AI 辅助：有选区润色选区，无选区润色全文；结果替换目标范围
async function aiAssistNote() {
  const note = currentNote();
  if (!note) { toast('请先选择一篇笔记', 2500); return; }
  const ta = $('note-content');
  const s = ta.selectionStart == null ? 0 : ta.selectionStart;
  const e = ta.selectionEnd == null ? 0 : ta.selectionEnd;
  const v = ta.value;
  const hasSel = e > s;
  const target = hasSel ? v.slice(s, e) : v;
  if (!target.trim()) { toast('没有可处理的内容', 2500); return; }
  const btn = $('btn-ai-assist');
  btn.disabled = true;
  toast('AI 正在处理…');
  try {
    // 历史版本：AI 改动前先存一版（版本号 = 日期+时间精确到秒）
    await window.kb.noteSaveVersion({ noteId: note.id, content: v, label: 'AI 改动前' });
    const res = await window.kb.noteAiAssist({ settings: state.settings, text: target, prompt: state.settings.aiAssistPrompt || '' });
    if (!res.ok) { toast('AI 辅助失败：' + res.error, 4000); return; }
    ta.value = hasSel ? v.slice(0, s) + res.text + v.slice(e) : res.text;
    updateNoteFromEditor();
    updatePreview();
    renderNoteList();
    // 历史版本：AI 改动成功后再存一版
    await window.kb.noteSaveVersion({ noteId: note.id, content: ta.value, label: 'AI 改动后' });
    toast(hasSel ? 'AI 已处理所选内容（已存历史版本）' : 'AI 已润色全文（已存历史版本）');
  } finally {
    btn.disabled = false;
  }
}

// ================= 历史版本（右侧抽屉） =================
let versionView = null; // 当前查看的版本号；null = 列表视图
let versionDiff = null; // 当前对比的 [旧, 新] 版本号；null = 非对比视图
let versionSel = [];    // 勾选待对比的版本号（最多 2 个）

function closeVersionsDrawer() {
  $('versions-drawer').hidden = true;
  versionView = null;
  versionDiff = null;
}

// 列表 / 只读查看 / 对比 三种视图切换
function syncVersionDrawerView() {
  const viewing = versionView != null;
  const diffing = versionDiff != null;
  $('versions-drawer-title').textContent = diffing ? '🔀 版本对比' : (viewing ? `版本内容 · ${versionView}` : '🕘 历史版本');
  $('btn-versions-back').hidden = !viewing && !diffing;
  $('versions-tip').hidden = viewing || diffing;
  $('version-list').hidden = viewing || diffing;
  $('versions-compare-bar').hidden = viewing || diffing;
  $('version-view-body').hidden = !viewing;
  $('version-diff-body').hidden = !diffing;
}

async function backToVersionList() {
  const n = currentNote();
  versionView = null;
  versionDiff = null;
  if (n) await loadVersionList(n.id); else syncVersionDrawerView();
}

async function openVersionsDrawer() {
  const note = currentNote();
  if (!note) { toast('请先选择一篇笔记', 2500); return; }
  $('versions-drawer').hidden = false;
  await loadVersionList(note.id);
}

async function loadVersionList(noteId) {
  versionView = null;
  versionDiff = null;
  syncVersionDrawerView();
  updateCompareBar();
  const res = await window.kb.noteListVersions({ noteId });
  if (!res.ok) { toast('加载版本列表失败：' + res.error, 4000); return; }
  const list = $('version-list');
  list.innerHTML = '';
  if (!res.versions.length) {
    list.innerHTML = '<div class="list-empty">暂无历史版本<br>AI 改动前/后会自动各存一版</div>';
    return;
  }
  res.versions.forEach((ver) => {
    const row = document.createElement('div');
    row.className = 'version-row';
    // 勾选框：选两个版本做 diff 对比
    const sel = document.createElement('label');
    sel.className = 'version-sel';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = versionSel.includes(ver.version);
    cb.addEventListener('change', () => toggleVersionSel(ver.version, cb.checked));
    sel.appendChild(cb);
    const info = document.createElement('div');
    info.className = 'version-info';
    info.innerHTML = `<span class="version-no">🕘 ${escapeHtml(ver.version)}</span><span class="version-label">${escapeHtml(ver.label || '')}</span>`;
    const acts = document.createElement('div');
    acts.className = 'version-actions';
    const bView = document.createElement('button');
    bView.className = 'btn btn-ghost';
    bView.textContent = '查看';
    bView.addEventListener('click', () => viewVersion(noteId, ver.version));
    const bRestore = document.createElement('button');
    bRestore.className = 'btn btn-ghost';
    bRestore.textContent = '恢复';
    bRestore.addEventListener('click', () => restoreVersion(noteId, ver.version));
    acts.appendChild(bView);
    acts.appendChild(bRestore);
    row.appendChild(sel);
    row.appendChild(info);
    row.appendChild(acts);
    list.appendChild(row);
  });
}

// 勾选待对比版本（最多保留最近勾选的 2 个）
function toggleVersionSel(version, on) {
  if (on) { if (!versionSel.includes(version)) versionSel.push(version); }
  else versionSel = versionSel.filter((v) => v !== version);
  if (versionSel.length > 2) versionSel = versionSel.slice(-2);
  updateCompareBar();
}

function updateCompareBar() {
  const n = versionSel.length;
  $('versions-compare-hint').textContent = n === 2 ? '已选择 2 个版本，可对比' : `勾选两个版本进行对比（已选 ${n}）`;
  $('btn-versions-compare').disabled = n !== 2;
}

// 行级 diff（LCS）：返回 [{t:'ctx'|'del'|'add', s}]，a→b
function diffLines(a, b) {
  const al = String(a || '').split('\n'), bl = String(b || '').split('\n');
  const n = al.length, m = bl.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = al[i] === bl[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (al[i] === bl[j]) { out.push({ t: 'ctx', s: al[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: 'del', s: al[i] }); i++; }
    else { out.push({ t: 'add', s: bl[j] }); j++; }
  }
  while (i < n) out.push({ t: 'del', s: al[i++] });
  while (j < m) out.push({ t: 'add', s: bl[j++] });
  return out;
}

// 对比勾选的两个版本：旧→新，抽屉内展示增/删/上下文三色 diff
async function showVersionDiff() {
  if (versionSel.length !== 2) return;
  const note = currentNote();
  if (!note) return;
  const [va, vb] = versionSel;
  const ra = await window.kb.noteGetVersion({ noteId: note.id, version: va });
  const rb = await window.kb.noteGetVersion({ noteId: note.id, version: vb });
  if (!ra.ok || !rb.ok) { toast('加载版本内容失败', 4000); return; }
  // 版本号格式为 YYYY-MM-DD HH:MM:SS，字典序即时间序
  const older = va <= vb ? { v: va, c: ra.content } : { v: vb, c: rb.content };
  const newer = va <= vb ? { v: vb, c: rb.content } : { v: va, c: ra.content };
  const lines = diffLines(older.c, newer.c);
  const cDel = lines.filter((l) => l.t === 'del').length;
  const cAdd = lines.filter((l) => l.t === 'add').length;
  const cCtx = lines.length - cDel - cAdd;
  const identical = cDel === 0 && cAdd === 0;
  const mark = { add: '+', del: '−', ctx: ' ' };
  const box = $('version-diff-body');
  box.innerHTML =
    `<div class="diff-head" title="${escapeHtml(older.v)} → ${escapeHtml(newer.v)}">− ${escapeHtml(older.v)} → + ${escapeHtml(newer.v)}</div>` +
    `<div class="diff-meta">${identical ? '两个版本内容完全一致，无增删（下方为共同内容）' : `删除 ${cDel} 行 · 新增 ${cAdd} 行 · 相同 ${cCtx} 行`}<span class="diff-legend"><i class="lg del">− 删除</i><i class="lg add">+ 新增</i><i class="lg ctx">相同</i></span></div>` +
    lines.map((l) => `<div class="diff-line ${l.t}"><span class="diff-mark">${mark[l.t]}</span>${escapeHtml(l.s)}</div>`).join('');
  versionDiff = [older.v, newer.v];
  syncVersionDrawerView();
}

// 查看某版本内容（抽屉内切到只读视图）
async function viewVersion(noteId, version) {
  const res = await window.kb.noteGetVersion({ noteId, version });
  if (!res.ok) { toast('加载版本内容失败：' + res.error, 4000); return; }
  versionView = version;
  $('version-view-body').value = res.content;
  syncVersionDrawerView();
}

// 恢复到指定版本：先自动备份当前内容一版防丢失，恢复后回到列表
async function restoreVersion(noteId, version) {
  const note = currentNote();
  if (!note || note.id !== noteId) return;
  if (!confirm(`恢复到版本“${version}”？`)) return;
  await window.kb.noteSaveVersion({ noteId, content: $('note-content').value, label: '恢复前（自动备份）' });
  const res = await window.kb.noteGetVersion({ noteId, version });
  if (!res.ok) { toast('加载版本内容失败：' + res.error, 4000); return; }
  $('note-content').value = res.content;
  updateNoteFromEditor();
  updatePreview();
  renderNoteList();
  toast('已恢复到版本 ' + version);
  await loadVersionList(noteId);
}

// 将当前笔记吸收生成 LLM Wiki 页面（复用吸收作业 text 模式，提交前领域模板预检查）
async function noteToWiki() {
  const note = currentNote();
  if (!note) { toast('请先选择一篇笔记', 2500); return; }
  if (!(note.content || '').trim()) { toast('笔记内容为空，无法生成 Wiki', 2500); return; }
  toast('正在匹配领域模板…', 2500);
  const domain = await checkDomainBeforeIngest({ texts: [`# ${note.title || ''}\n${note.content || ''}`] });
  if (domain === null) return;
  const res = await window.kb.jobsSubmit({ type: 'ingest', payload: finishIngestPayload({ settings: state.settings, text: note.content, title: note.title }, domain) });
  if (!res.ok) { toast('提交失败：' + res.error, 4000); return; }
  toast('已提交「生成 Wiki」作业');
  showJobsView();
}

// 从当前笔记抽取知识图谱（内联语料模式，提交前领域模板预检查）
async function noteToGraph() {
  const note = currentNote();
  if (!note) { toast('请先选择一篇笔记', 2500); return; }
  if (!(note.content || '').trim()) { toast('笔记内容为空，无法生成图谱', 2500); return; }
  toast('正在匹配领域模板…', 2500);
  const domain = await checkDomainBeforeIngest({ texts: [`# ${note.title || ''}\n${note.content || ''}`] });
  if (domain === null) return;
  const res = await window.kb.jobsSubmit({ type: 'graph', payload: { settings: state.settings, inlineSources: [{ label: '笔记·' + (note.title || note.id), text: `# ${note.title || ''}\n${note.content || ''}` }], ...graphDomainExtras(domain) } });
  if (!res.ok) { toast('提交失败：' + res.error, 4000); return; }
  toast('已提交「生成图谱」作业');
  showJobsView();
}

// 目录（含子目录）下的全部笔记
function folderDescendantNotes(folderId) {
  const ids = new Set([folderId]);
  let added = true;
  while (added) {
    added = false;
    for (const f of state.folders) {
      if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) { ids.add(f.id); added = true; }
    }
  }
  return state.notes.filter((n) => ids.has(n.folderId));
}

// 集合级（全部笔记/目录）生成 Wiki：多篇笔记作为来源提交吸收作业（过滤空内容，提交前领域预检查）
async function notesToWiki(notes, label, kind) {
  const list = notes.filter((n) => (n.content || '').trim());
  if (!list.length) { toast('该范围内没有可吸收的笔记内容', 2500); return; }
  if (!confirmRegen('wiki')) return;
  toast('正在匹配领域模板…', 2500);
  const domain = await checkDomainBeforeIngest({ texts: list.map((n) => `# ${n.title || ''}\n${n.content || ''}`) });
  if (domain === null) return;
  const res = await window.kb.jobsSubmit({ type: 'ingest', payload: finishIngestPayload({ settings: state.settings, collectionLabel: label, collectionKind: kind, noteSources: list.map((n) => ({ title: n.title, content: n.content || '' })) }, domain) });
  if (!res.ok) { toast('提交失败：' + res.error, 4000); return; }
  toast(`已提交「${label}」生成 Wiki 作业`);
  showJobsView();
}

// 集合级（全部笔记/目录）生成图谱：内联语料模式（过滤空内容，提交前领域预检查）
async function notesToGraph(notes, label) {
  const list = notes.filter((n) => (n.content || '').trim());
  if (!list.length) { toast('该范围内没有可抽取的笔记内容', 2500); return; }
  if (!confirmRegen('graph')) return;
  toast('正在匹配领域模板…', 2500);
  const domain = await checkDomainBeforeIngest({ texts: list.map((n) => `# ${n.title || ''}\n${n.content || ''}`) });
  if (domain === null) return;
  const res = await window.kb.jobsSubmit({ type: 'graph', payload: { settings: state.settings, inlineSources: list.map((n) => ({ label: '笔记·' + (n.title || n.id), text: `# ${n.title || ''}\n${n.content || ''}` })), ...graphDomainExtras(domain) } });
  if (!res.ok) { toast('提交失败：' + res.error, 4000); return; }
  toast(`已提交「${label}」生成图谱作业`);
  showJobsView();
}

function bindEditorToolbar() {
  $('btn-ai-assist').addEventListener('click', aiAssistNote);
  // 生成 Wiki / 图谱按钮已统一为笔记卡片右键菜单（noteToWiki / noteToGraph）
  $('btn-versions').addEventListener('click', openVersionsDrawer);
  $('btn-versions-close').addEventListener('click', closeVersionsDrawer);
  $('btn-versions-back').addEventListener('click', backToVersionList);
  $('btn-versions-compare').addEventListener('click', showVersionDiff);
  $('btn-format').addEventListener('click', (e) => toggleMenu($('format-menu'), e.currentTarget));
  $('btn-attach').addEventListener('click', (e) => toggleMenu($('attach-menu'), e.currentTarget));
  $('format-menu').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-fmt]');
    if (!btn) return;
    applyFormat(btn.dataset.fmt);
    $('format-menu').hidden = true;
  });
  $('attach-menu').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    $('attach-menu').hidden = true;
    attachAction(btn.dataset.act);
  });
  $('btn-checklist').addEventListener('click', () => applyFormat('checklist'));
  $('btn-table').addEventListener('click', insertTable);
}

