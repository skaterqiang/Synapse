// 渲染进程·笔记模块：过滤、列表、编辑器、笔记操作、仿备忘录工具栏
// ================= 笔记过滤 =================
function getFilteredNotes() {
  const { type, id, query } = state.view;
  let list = state.notes.slice();

  if (type === 'all') {
    // 目录浏览模式：只看根目录直属笔记（未分类/垃圾桶），子目录笔记进入目录后逐层浏览
    list = list.filter((n) => !n.folderId);
  } else if (type === 'folder') {
    if (id === '__trash__') {
      // 🗑 垃圾桶是虚拟目录：未分类（folderId=null）的笔记都归它
      list = list.filter((n) => !n.folderId);
    } else {
      // 含子目录：侧边栏计数本来就是递归的，列表只看直属会出现
      // “目录显示有 N 篇、点开却是空”（层级深的导入目录尤其明显）
      list = folderDescendantNotes(id);
    }
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
    if (!f) return '目录';
    return f.id === '__trash__' ? f.name : f.name; // 垃圾桶名称由主进程给定
  }
  if (type === 'tag') return `标签：${id}`;
  if (type === 'search') return `搜索"${query}"`;
  return '笔记';
}

// ================= 渲染：笔记列表 =================
function renderNoteList() {
  if (state.view.type === 'search') { renderSearchResults(); return; }
  const list = getFilteredNotes();
  $('note-list-title').textContent = getViewTitle();
  $('note-list-count').textContent = list.length ? `${list.length} 篇` : '';

  const container = $('note-list');
  container.innerHTML = '';

  // 全部笔记：目录浏览模式（根目录 = 子目录 + 直属笔记，目录可点击进入）
  if (state.view.type === 'all') { renderBrowseList(); return; }

  if (list.length === 0) {
    container.innerHTML = '<div class="list-empty">暂无笔记<br>点击「笔记」或目录旁的 ＋ 开始记录</div>';
    return;
  }

  list.forEach((note) => container.appendChild(buildNoteCard(note, '', subPathOf(note))));
}

// 笔记卡片：全部笔记/目录/标签视图共用（q 为高亮词，sub 为目录归属徽标）
function buildNoteCard(note, q, sub) {
  const card = document.createElement('div');
  card.className = 'note-card' + (note.id === state.selectedNoteId ? ' active' : '');
  const snippet = noteSnippet(note.content);
  const words = wordCount(note.content);
  const tagsHtml = (note.tags || []).slice(0, 3)
    .map((t) => `<span class="mini-tag">${highlight(t, q)}</span>`).join('');
  card.innerHTML = `
    <div class="note-card-title">${note.pinned ? icoSvg('pin', 12) : ''}${highlight(note.title || '无标题笔记', q)}</div>
    <div class="note-card-snippet">${highlight(snippet, q) || '<span style="opacity:.5">（空笔记）</span>'}</div>
    <div class="note-card-footer">${sub ? `<span class="nc-sub" title="位于目录 ${escapeHtml(sub)}">${icoSvg('folder-open', 11)} ${escapeHtml(sub)}</span>` : ''}<span class="nc-time" title="${formatDate(note.updatedAt)}">${formatRelDate(note.updatedAt)}</span><span class="nc-words">${words} 字</span>${tagsHtml}</div>`;
  card.addEventListener('click', () => selectNote(note.id));
  // 右键菜单：垃圾桶内优先「还原到原来的位置」，其余视图提取知识图谱/移动目录
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const inTrash = state.view.type === 'folder' && state.view.id === '__trash__';
    const items = [];
    // 垃圾桶视图内所有笔记可还原；其他视图中带 trashFrom 标记（曾被移入垃圾桶）的也可还原
    if (inTrash || note.trashFrom != null) items.push({ label: '还原到原来的位置', action: () => restoreNoteFromTrash(note) }, { sep: true });
    items.push(
      { label: '提取知识图谱', action: () => { selectNote(note.id); noteToGraph(); } },
      { label: '移动到目录…', action: () => openMoveFolderMenu(note, e.clientX, e.clientY) },
    );
    openCtxMenu(e.clientX, e.clientY, items);
  });
  return card;
}

// 目录 id → 相对笔记根目录路径（与主进程 folderDirMap 同规则：safeName 后按 / 拼接）
function folderRelPath(folderId) {
  if (!folderId) return '';
  const byId = new Map(state.folders.map((f) => [f.id, f]));
  const safe = (s) => String(s || '').trim().replace(/[\\/:*?"<>|]/g, '-').slice(0, 80) || 'untitled';
  const chain = [];
  let cur = byId.get(folderId);
  while (cur) { chain.unshift(safe(cur.name)); cur = cur.parentId ? byId.get(cur.parentId) : null; }
  return chain.join('/');
}

// 相对路径反查目录 id（用于还原时定位原目录）
function folderIdByRel(rel) {
  if (!rel) return null;
  for (const f of state.folders) if (f.id !== '__trash__' && folderRelPath(f.id) === rel) return f.id;
  return null;
}

// 还原垃圾桶内笔记到原来的位置：trashFrom 记录移入垃圾桶前的目录相对路径（''=根目录）；
// 原目录已被删除时按原路径逐级重建目录链（同名目录复用），确保「还原到原来的位置」始终成立
function restoreNoteFromTrash(note) {
  const rel = String(note.trashFrom || '');
  let folderId = folderIdByRel(rel);
  if (!folderId && rel) {
    const byRel = new Map(state.folders.filter((f) => f.id !== '__trash__').map((f) => [folderRelPath(f.id), f]));
    let parent = null;
    let acc = '';
    for (const seg of rel.split('/')) {
      if (!seg) continue;
      acc = acc ? `${acc}/${seg}` : seg;
      let f = byRel.get(acc);
      if (!f) {
        f = { id: uid(), name: seg, parentId: parent };
        state.folders.push(f);
        byRel.set(acc, f);
      }
      parent = f.id;
    }
    folderId = parent;
  }
  delete note.trashFrom;
  note.folderId = folderId;
  note.updatedAt = Date.now();
  persist();
  renderAll();
  toast(folderId ? `已还原到「${folderPathOf(note)}」` : '已还原到根目录', 2500);
}

// 右键「移动到目录」：先选顶级目录，含子目录则弹二级菜单；🗑 垃圾桶=未分类
function openMoveFolderMenu(note, x, y) {
  const byId = new Map(state.folders.map((f) => [f.id, f]));
  const fullPath = (f) => {
    const chain = [];
    let cur = f;
    while (cur) { chain.unshift(cur.name); cur = cur.parentId ? byId.get(cur.parentId) : null; }
    return chain.join(' / ');
  };
  const doMove = (folderId) => {
    if ((note.folderId || null) === (folderId || null)) return;
    if (!folderId && note.folderId) note.trashFrom = folderRelPath(note.folderId); // 移入垃圾桶：记录原位置
    if (folderId) delete note.trashFrom; // 移出垃圾桶：还原标记不再需要
    note.folderId = folderId || null;
    note.updatedAt = Date.now();
    persist();
    renderNoteList();
    renderSidebar();
    renderEditor();
    toast(`已移动到「${folderId ? fullPath(byId.get(folderId)) : '垃圾桶'}」`, 2500);
  };
  function pickWithin(parent) {
    const desc = [];
    const walk = (pid) => state.folders.filter((f) => f.parentId === pid).forEach((s) => { desc.push(s); walk(s.id); });
    walk(parent.id);
    if (!desc.length) { doMove(parent.id); return; }
    const items = [{ label: `${parent.name}（本级）`, action: () => doMove(parent.id) }, { sep: true }];
    desc.forEach((s) => items.push({ label: `↳ ${fullPath(s)}`, action: () => doMove(s.id) }));
    openCtxMenu(x, y, items);
  }
  const topItems = [{ label: '垃圾桶（未分类）', action: () => doMove(null) }];
  const tops = state.folders.filter((f) => !f.parentId);
  if (tops.length) topItems.push({ sep: true });
  tops.forEach((f) => topItems.push({ label: f.name, action: () => pickWithin(f) }));
  openCtxMenu(x, y, topItems);
}

// 目录视图含子目录笔记：非直属的只显示相对当前目录的子路径，否则分不清来历
function subPathOf(note) {
  if (state.view.type !== 'folder' || !note.folderId || note.folderId === state.view.id) return '';
  const byId = new Map(state.folders.map((f) => [f.id, f]));
  const chain = [];
  let cur = byId.get(note.folderId);
  while (cur && cur.id !== state.view.id) {
    chain.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  return chain.join(' / ');
}

// 全部笔记视图的目录归属徽标：完整目录路径（如 技术风险 / 子目录），未分类为空
function folderPathOf(note) {
  if (!note.folderId) return '';
  const byId = new Map(state.folders.map((f) => [f.id, f]));
  const chain = [];
  let cur = byId.get(note.folderId);
  while (cur) {
    chain.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  return chain.join(' / ');
}

// 目录行：与侧边栏目录节点类似，点击进入该目录（列表展示含子目录的递归笔记）
function buildFolderRow(folder) {
  const count = folderDescendantNotes(folder.id).length;
  const row = document.createElement('div');
  row.className = 'nl-folder-row';
  row.title = `进入目录「${folder.name}」`;
  row.innerHTML = `<span class="nl-folder-ico">${icoSvg('folder-open', 14)}</span><span class="nl-folder-name">${escapeHtml(folder.name)}</span><span class="nl-group-count">${count}</span><span class="nl-folder-enter">›</span>`;
  row.addEventListener('click', () => {
    state.view = { type: 'folder', id: folder.id, query: '' };
    renderAll();
  });
  return row;
}

// 全部笔记：目录浏览模式——根目录展示「子目录 + 直属笔记（未分类）」，
// 目录可点击逐层进入，与侧边栏目录树的浏览体验一致
function renderBrowseList() {
  const container = $('note-list');
  // 🗑 垃圾桶是虚拟目录（内容=未分类笔记），根目录笔记组已展示，避免重复
  const roots = state.folders.filter((f) => !f.parentId && f.id !== '__trash__');
  const rootNotes = state.notes
    .filter((n) => !n.folderId)
    .sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
      return b.updatedAt - a.updatedAt;
    });
  $('note-list-count').textContent = `${roots.length} 个目录 / ${rootNotes.length} 篇根目录笔记`;
  if (roots.length) {
    const head = document.createElement('div');
    head.className = 'nl-group';
    head.innerHTML = `<span>${icoSvg('folder-open', 13)} 目录</span><span class="nl-group-count">${roots.length}</span>`;
    container.appendChild(head);
    roots.forEach((f) => container.appendChild(buildFolderRow(f)));
  }
  if (rootNotes.length) {
    const head = document.createElement('div');
    head.className = 'nl-group';
    head.innerHTML = `<span>${icoSvg('notes', 13)} 根目录笔记</span><span class="nl-group-count">${rootNotes.length}</span>`;
    container.appendChild(head);
    rootNotes.forEach((n) => container.appendChild(buildNoteCard(n, '', '')));
  }
  if (!roots.length && !rootNotes.length) {
    container.innerHTML = '<div class="list-empty">根目录为空<br>点击「笔记」或目录旁的 ＋ 开始记录</div>';
  }
}

// 全局搜索：跨笔记/原始文件/知识图谱分类展示结果
function renderSearchResults() {
  const q = (state.view.query || '').trim().toLowerCase();
  $('note-list-title').textContent = getViewTitle();
  const container = $('note-list');
  container.innerHTML = '';
  if (!q) {
    $('note-list-count').textContent = '';
    container.innerHTML = '<div class="list-empty">输入关键词搜索<br>笔记 / 原始文件 / 知识图谱</div>';
    return;
  }
  const has = (s) => String(s || '').toLowerCase().includes(q);
  const notes = state.notes.filter((n) => has(n.title) || has(n.content) || (n.tags || []).some(has));
  const raws = (state.raws || []).filter((r) => has(r.name) || has(r.path));
  const graphs = ((state.graph && state.graph.nodes) || []).filter((n) => has(n.name) || has(n.desc));
  const total = notes.length + raws.length + graphs.length;
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
  if (notes.length) { secHead(icoSvg('notes', 13), '笔记', notes.length); notes.forEach((n) => row(icoSvg('notes', 13), n.title || '无标题笔记', '', () => selectNote(n.id))); }
  if (raws.length) { secHead(icoSvg('folder-open', 13), '原始文件', raws.length); raws.forEach((r) => row(icoSvg('folder-open', 13), r.name, r.path, () => showRawView())); }
  if (graphs.length) { secHead(icoSvg('kg', 13), '知识图谱', graphs.length); graphs.forEach((n) => row(icoSvg('kg', 13), n.name, n.type, () => { state.kg.tab = 'entities'; state.kg.entitySel = n.id; showGraphView(); })); }
}

// ================= 渲染：编辑器 =================
function currentNote() {
  return state.notes.find((n) => n.id === state.selectedNoteId) || null;
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
  // 领域模版编辑页打开时，编辑区让位
  if (!$('tpl-editor-view').hidden) {
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
    const box = $('note-preview');
    box.innerHTML = renderMarkdown(note.content);
    // 预览里的任务清单可直接勾选：marked 默认输出 disabled 的复选框，
    // 这里解除禁用并按出现顺序编号，点击后由 toggleTaskInContent 回写正文
    box.querySelectorAll('input[type="checkbox"]').forEach((cb, i) => {
      cb.disabled = false;
      cb.dataset.task = String(i);
      cb.title = '点击勾选/取消，会同步写回正文';
    });
  }
}

// 预览中勾选任务：把正文里第 index 个任务标记翻转（GFM 任务清单，兼容 - * + 与有序列表）
// 计数时跳过围栅代码块，否则代码里的 “- [ ]” 会把序号错开导致改错行
function toggleTaskInContent(index, checked) {
  const note = currentNote();
  if (!note) return;
  const taskRe = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/;
  const lines = String(note.content || '').split('\n');
  let inFence = false;
  let seen = -1;
  let hit = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence || !taskRe.test(lines[i])) continue;
    seen++;
    if (seen === index) { hit = i; break; }
  }
  if (hit < 0) { updatePreview(); return; } // 序号对不上（正文已变）时不动，重渲染恢复真实状态
  lines[hit] = lines[hit].replace(taskRe, `$1${checked ? 'x' : ' '}$3`);
  const next = lines.join('\n');
  if (next === note.content) return;
  // 经正文文本框回写，复用同一条保存链路（含字数/时间/持久化）
  $('note-content').value = next;
  updateNoteFromEditor();
  updatePreview();
  renderNoteList();
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
  // 标签输入框已按用户要求移除；笔记已有 tags 数据保留不动
  note.updatedAt = Date.now();
  $('note-time').textContent = `更新于 ${formatRelDate(note.updatedAt)}`;
  $('note-time').title = formatDate(note.updatedAt);
  $('note-date').textContent = `${wordCount(note.content)} 字`;
  persist();
  // 工具栏插入（表格/格式/图片等）是程序改 value，不触发 input 事件，
  // 防抖的预览刷新不会跑，这里正文落库后立即同步预览
  updatePreview();
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
  let fid = folderId !== undefined ? folderId : (state.view.type === 'folder' ? state.view.id : null);
  if (fid === '__trash__') fid = null; // 垃圾桶是虚拟目录，笔记以 folderId=null 归属它
  const note = {
    id: uid(),
    title: title || uniqueNoteTitle('新建笔记', null),
    content: '',
    tags: [],
    folderId: fid,
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

// 删除：普通目录下的笔记移入垃圾桶（记录原位置 trashFrom，可右键还原）；
// 垃圾桶内的笔记删除即永久删除（不可恢复）
function deleteNote() {
  const note = currentNote();
  if (!note) return;
  if (!note.folderId) {
    if (!confirm(`永久删除笔记"${note.title || '无标题'}"？此操作不可恢复。`)) return;
    delete note.trashFrom;
    state.notes = state.notes.filter((n) => n.id !== note.id);
    window.kb.noteDeleteVersions({ noteId: note.id });
    toast('已永久删除', 2500);
  } else {
    if (!confirm(`确定删除笔记"${note.title || '无标题'}"？将移入"垃圾桶"，可在垃圾桶内右键还原。`)) return;
    note.trashFrom = folderRelPath(note.folderId);
    note.folderId = null;
    toast('已移入垃圾桶，可在垃圾桶内右键还原', 2500);
  }
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
  commitEditorText();
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
  commitEditorText();
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
  commitEditorText();
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

function commitEditorText() {
  updateNoteFromEditor();
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
  $('versions-drawer-title').textContent = diffing ? '版本对比' : (viewing ? `版本内容 · ${versionView}` : '历史版本');
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
    info.innerHTML = `<span class="version-no">${icoSvg('history', 12)} ${escapeHtml(ver.version)}</span><span class="version-label">${escapeHtml(ver.label || '')}</span>`;
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

// 从当前笔记抽取知识图谱（内联语料模式，提交前选领域）
async function noteToGraph() {
  const note = currentNote();
  if (!note) { toast('请先选择一篇笔记', 2500); return; }
  if (!(note.content || '').trim()) { toast('笔记内容为空，无法生成图谱', 2500); return; }
  const extras = await pickDomainForExtract({ kind: 'graph', label: '笔记·' + (note.title || note.id), texts: [`# ${note.title || ''}\n${note.content || ''}`] });
  if (!extras) return;
  const res = await window.kb.jobsSubmit({ type: 'graph', payload: { settings: state.settings, inlineSources: [{ label: '笔记·' + (note.title || note.id), text: `# ${note.title || ''}\n${note.content || ''}` }], ...extras } });
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

// 集合级（全部笔记/目录）生成图谱：内联语料模式（过滤空内容，提交前选领域）
async function notesToGraph(notes, label) {
  const list = notes.filter((n) => (n.content || '').trim());
  if (!list.length) { toast('该范围内没有可抽取的笔记内容', 2500); return; }
  if (!confirmRegen('graph')) return;
  const extras = await pickDomainForExtract({ kind: 'graph', label, texts: list.map((n) => `# ${n.title || ''}\n${n.content || ''}`) });
  if (!extras) return;
  const res = await window.kb.jobsSubmit({ type: 'graph', payload: { settings: state.settings, inlineSources: list.map((n) => ({ label: '笔记·' + (n.title || n.id), text: `# ${n.title || ''}\n${n.content || ''}` })), ...extras } });
  if (!res.ok) { toast('提交失败：' + res.error, 4000); return; }
  toast(`已提交「${label}」生成图谱作业`);
  showJobsView();
}

function bindEditorToolbar() {
  // btn-ai-assist / btn-versions 的绑定在 app.js
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

