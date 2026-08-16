// 渲染进程·公共模块：全局状态、工具函数、侧边栏、设置、视图协调、分隔条拖拽
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
  graph: { nodes: [], edges: [], updatedAt: 0 }, // 知识图谱（本体层）
  graphScope: 'all',                  // 图谱抽取范围：all | wiki | notes
  noteListHidden: false,              // 笔记列表栏是否被用户收起
  aiSources: { notes: true, wiki: true, graph: true }, // AI 问答数据源（多选）
  kg: { tab: 'overview', onto: null, ontoTab: 'classes', entitySel: null, focus: null }, // 知识图谱模块子视图状态；focus = 邻居视图中心节点
  templates: [],                      // 领域模版列表
  raws: [],                           // raw/ 原始来源列表
};

let saveTimer = null;
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

// 相对日期：今天只显时分，昨天/前天标注，一周内显星期几，更早显月日（跨年带年份）
function formatRelDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dDay0 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((day0 - dDay0) / 86400000);
  if (diffDays <= 0) return hm;
  if (diffDays === 1) return `昨天 ${hm}`;
  if (diffDays === 2) return `前天 ${hm}`;
  if (diffDays < 7) return `周${'日一二三四五六'[d.getDay()]} ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 字数统计：中文字符按字计，英文/数字按词计（用于列表卡片与编辑区 meta 行）
function wordCount(text) {
  const s = String(text || '').trim();
  if (!s) return 0;
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (s.replace(/[\u4e00-\u9fff]/g, ' ').match(/[A-Za-z0-9_'-]+/g) || []).length;
  return cjk + latin;
}

// 列表摘要：剔除代码块/图片/HTML/Markdown 标记，折叠空白后截断
function noteSnippet(content, max = 120) {
  let s = String(content || '');
  s = s.replace(/```[\s\S]*?(```|$)/g, ' [代码] ');
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, ' [图片] ');
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, ' '); // 表格分隔行 | --- | --- |
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  s = s.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, '');
  s = s.replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '');
  s = s.replace(/^\s*>\s?/gm, '');
  s = s.replace(/[*_~`#|]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, max);
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
    let html = marked.parse(text || '', { breaks: true });
    // 网页模式无自定义协议，把 kb-asset://file<path> 改写为服务端 /api/asset 路由
    if (window.__KB_WEB__) {
      html = html.replace(/src="kb-asset:\/\/file([^"]*)"/g, (_m, p) => `src="/api/asset?path=${encodeURIComponent(decodeURIComponent(p))}"`);
    }
    return html;
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
// ================= 渲染：侧边栏 =================
function renderSidebar() {
  $('count-all').textContent = state.notes.length;
  $('count-graph').textContent = state.graph.nodes.length;
  $('nav-jobs').classList.toggle('active', !$('jobs-view').hidden);
  $('nav-templates').classList.toggle('active', !$('tpl-view').hidden);
  $('nav-raws').classList.toggle('active', !$('raw-view').hidden);
  // 知识图谱：只高亮当前选中的子菜单项
  document.querySelectorAll('#kg-submenu .nav-sub-item').forEach((el) => {
    el.classList.toggle('active', !$('graph-view').hidden && state.kg.tab === el.dataset.tab);
  });
  // 整页视图（作业/模版/原始文件/图谱/设置）打开时，笔记列表类导航不保留高亮
  const navDimmed = !$('settings-view').hidden || !$('jobs-view').hidden || !$('tpl-view').hidden || !$('raw-view').hidden || !$('graph-view').hidden;

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
        <button class="icon-btn" data-act="add" title="在该目录下新建笔记">＋</button>
        <button class="icon-btn" data-act="rename" title="重命名">✏</button>
        <button class="icon-btn" data-act="del" title="删除">✕</button>
      </span>
      <span class="nav-count">${count}</span>`;
    // 右键菜单：该目录笔记提取 Wiki / 知识图谱（按钮入口已统一为右键）
    div.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const notes = folderDescendantNotes(folder.id);
      openCtxMenu(e.clientX, e.clientY, [
        { label: `📝 提取 Wiki（${notes.length} 篇笔记）`, action: () => notesToWiki(notes, '目录·' + folder.name, '笔记目录') },
        { label: `🕸 提取知识图谱（${notes.length} 篇笔记）`, action: () => notesToGraph(notes, '目录·' + folder.name) },
      ]);
    });
    div.addEventListener('click', (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'add') {
        e.stopPropagation();
        promptCreateNote(folder.id);
        return;
      }
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
      if (state.noteListHidden) setNoteListHidden(false);
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
        if (state.noteListHidden) setNoteListHidden(false);
        renderAll();
      });
      tagList.appendChild(span);
    });
  }

  $('nav-all-notes').classList.toggle('active', !navDimmed && (state.view.type === 'all' || state.view.type === 'search'));
  $('wiki-header').classList.toggle('active', !navDimmed && state.view.type === 'wiki');
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
  // 未配置时默认显示阿里云通义千问（DashScope 兼容接口）设置，与 llm.js 的兜底默认保持一致
  $('set-baseurl').value = s.apiBaseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  $('set-apikey').value = s.apiKey || '';
  $('set-model').value = s.model || 'qianwen3.8-max';
  const fillDec = (id, v) => { $(id).value = Number.isFinite(v) ? String(v) : ''; };
  fillDec('set-temperature', s.temperature);
  fillDec('set-topp', s.topP);
  fillDec('set-maxtokens', s.maxTokens);
  $('set-wikiroot').value = s.wikiRoot || '';
  window.kb.dataRoot().then((p) => {
    state.currentRoot = p;
    $('set-dataroot').value = p;
  });
  const fillNum = (id, v) => { $(id).value = Number.isFinite(v) ? String(v) : ''; };
  for (const [key, [id]] of Object.entries(NUM_SETTING_FIELDS)) fillNum(id, s[key]);
  $('set-editormode').value = EDITOR_MODES.includes(s.defaultEditorMode) ? s.defaultEditorMode : 'split';
  $('set-aiassist').value = s.aiAssistPrompt || '';
  window.kb.wikiDefaultRoot().then((p) => { $('set-wikiroot').placeholder = '留空则自动探测：' + p; });
  window.kb.getDataPath().then((p) => {
    state.currentDbPath = p;
    $('set-dbpath').value = p;
    $('data-path').textContent = '数据文件：' + p;
  });
  switchSettingsTab(state.settingsTab || 'ai');
  $('wiki-viewer').hidden = true;
  $('jobs-view').hidden = true;
  $('graph-view').hidden = true;
  $('tpl-view').hidden = true;
  $('raw-view').hidden = true;
  $('prompts-view').hidden = true;
  $('settings-view').hidden = false;
  renderEditor();
  renderSidebar();
  syncNoteListVisibility();
}

function hideSettingsView() {
  $('settings-view').hidden = true;
  renderEditor();
  renderSidebar();
  syncNoteListVisibility();
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
  // 数据根目录先行：仅写配置指针，重启后生效
  const newRoot = $('set-dataroot').value.trim();
  if (newRoot !== (state.currentRoot || '')) {
    const res = await window.kb.setDataRoot(newRoot);
    if (!res.ok) { toast('数据根目录修改失败：' + res.error, 4000); return; }
    state.currentRoot = res.root;
    $('set-dataroot').value = res.root;
    toast('数据根目录已设为 ' + res.root + '，重启应用后生效', 5000);
  }
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
  // 模型参数（允许小数）：留空/非法则删除键，回退接口默认值
  const readDec = (id, min, max) => {
    const raw = $(id).value.trim();
    if (!raw) return null;
    const v = Number(raw);
    if (!Number.isFinite(v)) return null;
    return Math.min(max, Math.max(min, v));
  };
  const tempV = readDec('set-temperature', 0, 2);
  if (tempV === null) delete s.temperature; else s.temperature = tempV;
  const topPV = readDec('set-topp', 0, 1);
  if (topPV === null) delete s.topP; else s.topP = topPV;
  const maxTV = readDec('set-maxtokens', 1, 1000000);
  if (maxTV === null) delete s.maxTokens; else s.maxTokens = Math.round(maxTV);
  s.wikiRoot = $('set-wikiroot').value.trim();
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
  s.aiAssistPrompt = $('set-aiassist').value.trim();
  state.settings = s;
  persist();
  toast('设置已保存');
  loadWiki();
}

// 生成 Wiki/图谱前的「已生成过则确认重新生成」守卫
function confirmRegen(kind) {
  const generated = kind === 'wiki'
    ? ((state.wiki && state.wiki.pages) || []).length > 0
    : ((state.graph && state.graph.nodes) || []).length > 0;
  if (!generated) return true;
  return confirm(kind === 'wiki'
    ? 'Wiki 已生成过，是否重新生成？（将更新现有页面）'
    : '知识图谱已生成过，是否重新生成？（将更新现有图谱）');
}

// ================= 提示词管理（主区域页） =================
// 提示词注册表由主进程 prompts.js 提供（prompts:defs），此处动态渲染全部可配置项
async function renderPromptCards() {
  const box = $('prompt-cards');
  let defs = [];
  try { defs = (await window.kb.promptsDefs()) || []; } catch (_) { defs = []; }
  box.innerHTML = '';
  defs.forEach((d) => {
    const card = document.createElement('div');
    card.className = 'prompt-card';
    card.innerHTML = `
      <div class="prompt-card-head"><b>${escapeHtml(d.name)}</b></div>
      <p class="prompt-card-desc">${escapeHtml(d.desc || '')}</p>
      <textarea class="prompt-card-input" rows="4" placeholder="${d.def ? '默认：' + escapeHtml(d.def) : '（使用内置默认）'}"></textarea>
      <div class="prompt-card-actions">
        <button class="btn btn-primary" data-act="save">保存</button>
        <button class="btn btn-ghost" data-act="reset">恢复默认</button>
      </div>`;
    const ta = card.querySelector('textarea');
    ta.value = state.settings[d.key] || '';
    card.querySelector('[data-act="save"]').addEventListener('click', () => {
      state.settings[d.key] = ta.value.trim();
      persist();
      toast('已保存「' + d.name + '」提示词');
    });
    card.querySelector('[data-act="reset"]').addEventListener('click', () => {
      delete state.settings[d.key];
      ta.value = '';
      persist();
      toast('「' + d.name + '」已恢复默认');
    });
    box.appendChild(card);
  });
}

function showPromptsView() {
  $('wiki-viewer').hidden = true;
  $('settings-view').hidden = true;
  $('jobs-view').hidden = true;
  $('tpl-view').hidden = true;
  $('raw-view').hidden = true;
  $('graph-view').hidden = true;
  $('prompts-view').hidden = false;
  renderPromptCards();
  renderEditor();
  renderSidebar();
}
function hidePromptsView() {
  $('prompts-view').hidden = true;
  renderEditor();
  renderSidebar();
}

// ================= 汇总渲染 =================
function renderAll() {
  renderSidebar();
  renderNoteList();
  renderEditor();
  syncNoteListVisibility();
}

// 主内容区专题页（设置/作业/图谱/模版/原始文件/Wiki 阅读器）统一让位，避免切换导航时旧页残留
// keepWikiViewer：点 LLM Wiki 标题只回到索引列表，正在阅读的页面不强制关闭
function hideMainViews({ keepWikiViewer = false } = {}) {
  ['settings-view', 'jobs-view', 'graph-view', 'tpl-view', 'raw-view', 'prompts-view'].forEach((id) => { $(id).hidden = true; });
  if (!keepWikiViewer) $('wiki-viewer').hidden = true;
}

// 设置页打开或用户主动收起时，笔记列表与其分隔条让位
function syncNoteListVisibility() {
  const hidden = !$('settings-view').hidden || state.noteListHidden;
  document.querySelector('.note-list-pane').style.display = hidden ? 'none' : '';
  $('notelist-resizer').style.display = hidden ? 'none' : '';
  $('btn-notelist-show').hidden = !state.noteListHidden;
}

// 收起/展开笔记列表栏（偏好持久化在 localStorage）
function setNoteListHidden(hiddenFlag) {
  state.noteListHidden = hiddenFlag;
  if (hiddenFlag) localStorage.setItem('kb.noteListHidden', '1');
  else localStorage.removeItem('kb.noteListHidden');
  syncNoteListVisibility();
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

