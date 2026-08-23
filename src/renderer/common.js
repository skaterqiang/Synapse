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
  aiBusySessionId: null,              // 正在回答的会话 id（仅内存，用于列表“回答中”标识）
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
  aiSources: { notes: true, wiki: true, graph: true, raws: true }, // AI 问答数据源（多选）
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
    // 消毒：剥离 script/事件属性等（AI 回答与 Wiki 内容不可信）；
    // 在默认协议白名单基础上放行 kb-asset:（笔记附件图自定义协议）
    if (window.DOMPurify) {
      html = window.DOMPurify.sanitize(html, {
        ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|kb-asset):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
      });
    }
    // 网页模式无自定义协议，把 kb-asset://file<path> 改写为服务端 /api/asset 路由
    if (window.__KB_WEB__) {
      html = html.replace(/src="kb-asset:\/\/file([^"]*)"/g, (_m, p) => `src="/api/asset?path=${encodeURIComponent(decodeURIComponent(p))}"`);
    }
    // 代码块高亮：在 template 内完成，不触碰活 DOM
    if (window.hljs) {
      const tpl = document.createElement('template');
      tpl.innerHTML = html;
      tpl.content.querySelectorAll('pre code').forEach((el) => { try { window.hljs.highlightElement(el); } catch (_) {} });
      html = tpl.innerHTML;
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

// 自定义输入弹窗（Electron 中 window.prompt 不可用，调用会直接抛错）
// opts.multiline：用多行 textarea（粘贴长文本时用，此时回车为换行，靠按钮提交）
function askInput(title, defaultValue = '', opts = {}) {
  return new Promise((resolve) => {
    const multiline = !!opts.multiline;
    $('prompt-title').textContent = title;
    const input = multiline ? $('prompt-textarea') : $('prompt-input');
    const other = multiline ? $('prompt-input') : $('prompt-textarea');
    if (other) other.hidden = true;
    input.hidden = false;
    input.value = defaultValue;
    if (input.placeholder !== undefined) input.placeholder = opts.placeholder || '';
    const box = $('prompt-box');
    if (box) box.style.width = multiline ? '640px' : '360px';
    $('prompt-modal').hidden = false;
    input.focus();
    if (!multiline) input.select();

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
      // IME 候选回车时 keydown 仍会触发（isComposing===true 或 keyCode===229），需跳过
      // 多行模式下回车用于换行，仅 Cmd/Ctrl+Enter 提交
      const submit = multiline ? (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) : (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229);
      if (submit) { e.preventDefault(); close(input.value); }
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
  maxConcurrentJobs: ['set-maxconcurrent', 1, 8],
  urlFetchTimeout: ['set-urltimeout', 1, 600],
  sourceMaxChars: ['set-sourcechars', 1000, 1000000],
  rawDirMaxFiles: ['set-rawdirmax', 10, 100000],
  wikiAskMaxPages: ['set-askpages', 1, 20],
  maxToolRounds: ['set-toolrounds', 1, 12],
  logTailLines: ['set-loglines', 1, 500],
};

// 服务商预设：仅支持阿里云百炼与 Ollama（默认阿里云）
// label 用于模型选择器分组展示；suggest 仅作为「添加模型」时的候选提示，实际可用模型以用户配置为准
const PROVIDER_PRESETS = {
  dashscope: { label: '阿里云百炼', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: ((window.kb && window.kb.defaults) || {}).model || 'qwen3.8-max', suggest: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-long'] },
  ollama: { label: 'Ollama（本地）', url: 'http://localhost:11434/v1', model: '', suggest: ['qwen2.5', 'llama3.1', 'deepseek-r1'] },
};
const DEFAULT_PROVIDER = 'dashscope';
// 归一：遇到已下线或非法的 provider 值（如历史配置）一律回退阿里云
const normalizeProvider = (p) => (PROVIDER_PRESETS[p] ? p : DEFAULT_PROVIDER);
const providerLabel = (p) => ((PROVIDER_PRESETS[p] && PROVIDER_PRESETS[p].label) || p || DEFAULT_PROVIDER);
// 本地部署（Ollama）无需 API Key
const providerNeedsKey = (p) => p !== 'ollama';

// 切换 provider 会覆写主模型的 baseUrl/模型名（且自动保存立即落盘），
// 因此先把原 provider 的可用配置收进「更多模型」，否则旧配置会静默丢失、
// 也就无法在 AI 问答的模型选择器里再选到它
function stashCurrentModelAsExtra(prevProvider) {
  const model = ($('set-model').value || '').trim();
  const baseUrl = ($('set-baseurl').value || '').trim();
  if (!model || !baseUrl) return; // 未填完的配置不值得保留
  const list = extraModels().slice();
  const dup = list.some((m) => m.provider === prevProvider && m.model === model && m.baseUrl === baseUrl);
  if (dup) return;
  list.push({
    id: 'm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    provider: prevProvider,
    model,
    baseUrl,
    apiKey: providerNeedsKey(prevProvider) ? ($('set-apikey').value || '').trim() : '',
  });
  state.settings.extraModels = list;
  renderModelList();
  toast(`已把原模型 ${model} 保留到「更多模型」，仍可在问答时选用`, 4000);
}

function applyProviderPreset() {
  const next = normalizeProvider($('set-provider').value);
  const prev = normalizeProvider((state.settings || {}).apiProvider);
  if (prev !== next) stashCurrentModelAsExtra(prev);
  const p = PROVIDER_PRESETS[next] || PROVIDER_PRESETS[DEFAULT_PROVIDER];
  if (p.url) $('set-baseurl').value = p.url;
  // 无预设默认模型（如 Ollama）时清空，避免留着上一个 provider 的模型名
  $('set-model').value = p.model || '';
  // 切到无需 Key 的本地 provider 时清掉旧 Key，避免把云端密钥留在本地配置上
  if (!providerNeedsKey(next)) $('set-apikey').value = '';
  clearModelOptions('model-options');
  // 本地 provider 无需 Key、拉取很快，直接自动列出可用模型并选上第一个（避免模型名空着）
  if (!providerNeedsKey(next)) fetchMainModels({ autoPick: true });
}

// ---------- 获取接口可用模型（存入内存，供自定义下拉列出全部） ----------
// 原生 <datalist> 会按输入框当前值过滤候选，输入已有模型名时下拉只剩一条；
// 改用自定义下拉菜单，点 ▾ 始终列出全部已获取模型
const fetchedModelStore = {};
function clearModelOptions(listId) {
  fetchedModelStore[listId] = [];
}

function fillModelOptions(listId, models) {
  fetchedModelStore[listId] = (models || []).slice();
}

// 绑定模型输入框右侧 ▾ 下拉：点击列出 fetchedModelStore 中全部模型，选中回填并触发 change
function bindModelDropdown(listId, btnId, menuId, inputId) {
  const btn = $(btnId);
  const menu = $(menuId);
  const input = $(inputId);
  if (!btn || !menu || !input) return;
  const render = () => {
    const models = fetchedModelStore[listId] || [];
    menu.innerHTML = '';
    if (!models.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = '尚未获取模型，先点「获取模型」';
      menu.appendChild(e);
      return;
    }
    models.forEach((m) => {
      const d = document.createElement('div');
      d.className = 'item';
      d.textContent = m;
      d.addEventListener('click', (ev) => {
        ev.stopPropagation();
        input.value = m;
        menu.hidden = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      menu.appendChild(d);
    });
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) { render(); menu.hidden = false; } else menu.hidden = true;
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) menu.hidden = true;
  });
}

// baseUrl/apiKey 取自传入的输入框；tipEl 可选，用于就地展示结果；
// autoPickInto：若该输入框为空，自动选上拉到的第一个模型
async function fetchModelsInto({ urlEl, keyEl, listId, btn, tipEl, autoPickInto }) {
  const baseUrl = ($(urlEl).value || '').trim();
  if (!baseUrl) { toast('请先填写 Base URL', 3000); return; }
  const apiKey = keyEl ? ($(keyEl).value || '').trim() : '';
  const oldText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '获取中…'; }
  const res = await window.kb.listModels({ apiBaseUrl: baseUrl, apiKey })
    .catch((e) => ({ ok: false, error: (e && e.message) || String(e) }));
  if (btn) { btn.disabled = false; btn.textContent = oldText; }
  if (!res || !res.ok) {
    clearModelOptions(listId);
    const msg = (res && res.error) || '获取失败';
    if (tipEl && $(tipEl)) $(tipEl).textContent = '⚠️ ' + msg;
    toast(msg, 4000);
    return;
  }
  fillModelOptions(listId, res.models);
  const n = (res.models || []).length;
  // 自动选上第一个（仅当输入框为空），并落盘，避免切 provider 后模型名为空
  if (autoPickInto && n && !($(autoPickInto).value || '').trim()) {
    $(autoPickInto).value = res.models[0];
    if (autoPickInto === 'set-model' && typeof saveSettingsFields === 'function') saveSettingsFields();
  }
  if (tipEl && $(tipEl)) {
    $(tipEl).textContent = n
      ? `已获取 ${n} 个模型：${res.models.slice(0, 8).join('、')}${n > 8 ? '…' : ''}（可在输入框下拉选择）`
      : '该接口未返回任何模型，请确认 Base URL / API Key 是否正确';
  }
  toast(n ? `已获取 ${n} 个模型` : '未获取到模型', 3000);
}

// 主表单（默认模型卡）：用当前 Base URL / API Key 拉取
function fetchMainModels(opts) {
  return fetchModelsInto({
    urlEl: 'set-baseurl', keyEl: 'set-apikey', listId: 'model-options',
    btn: $('btn-fetch-models'), tipEl: 'model-fetch-tip',
    autoPickInto: opts && opts.autoPick ? 'set-model' : null,
  });
}

// ---------- 模型列表（主模型 = 上方表单；更多模型 = settings.extraModels） ----------
// 每条模型自带 provider / Base URL / 独立 API Key（本地模型可留空），
// 供 AI 问答输入区的两级选择器（provider → 具体模型）使用
function extraModels() {
  const list = state.settings && state.settings.extraModels;
  return Array.isArray(list) ? list : [];
}

// 全部可选模型：首项为主模型（默认，沿用设置页主表单）
function modelEntryList() {
  const s = state.settings || {};
  const D = (window.kb && window.kb.defaults) || {};
  const primary = {
    id: '__primary__',
    primary: true,
    provider: normalizeProvider(s.apiProvider),
    model: (s.model || '').trim() || D.model || '',
    baseUrl: (s.apiBaseUrl || '').trim() || D.apiBaseUrl || '',
    apiKey: s.apiKey || '',
  };
  return [primary, ...extraModels()];
}

function findModelEntry(id) {
  return modelEntryList().find((m) => m.id === id) || null;
}

// 默认模型的固定字段回填（打开设置页与切换默认模型后均需刷新）
function fillPrimaryModelFields() {
  const s = state.settings || {};
  const D = (window.kb && window.kb.defaults) || {};
  $('set-provider').value = normalizeProvider(s.apiProvider);
  $('set-baseurl').value = s.apiBaseUrl || D.apiBaseUrl || '';
  $('set-apikey').value = s.apiKey || '';
  const modelVal = (s.model || '').trim();
  $('set-model').value = window.kb.normalizeModel ? window.kb.normalizeModel(modelVal) : (modelVal || D.model || '');
  $('set-model').placeholder = D.model || '';
  $('set-baseurl').placeholder = D.apiBaseUrl || '';
}

// 把某个“更多模型”提升为默认模型（写入 settings 的标量字段）。
// keepOld=true 时把原默认配置放回它原本的位置，相当于两者互换，不丢配置
function promoteModel(id, opts = {}) {
  const list = extraModels().slice();
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return false;
  const picked = list[i];
  const s = state.settings;
  const old = {
    id: 'm-' + uid(),
    provider: normalizeProvider(s.apiProvider),
    model: (s.model || '').trim(),
    baseUrl: (s.apiBaseUrl || '').trim(),
    apiKey: s.apiKey || '',
  };
  if (opts.keepOld && (old.model || old.baseUrl)) list.splice(i, 1, old); else list.splice(i, 1);
  s.apiProvider = normalizeProvider(picked.provider);
  s.apiBaseUrl = picked.baseUrl || '';
  s.apiKey = picked.apiKey || '';
  s.model = picked.model || '';
  state.settings.extraModels = list;
  // 被提升的条目 id 已不存在，若正被选中则改指默认模型
  if (state.aiModelId === id) setAiModel('__primary__');
  persist();
  fillPrimaryModelFields();
  renderModelList();
  if (typeof refreshAiModelUi === 'function') refreshAiModelUi();
  return true;
}

// ---------- 模型卡片（仿 MCP 配置：一模型一卡、默认收起、展开内联编辑）----------
const modelExpanded = {}; // key: '__primary__' 或 extraModel.id

function renderModelList() {
  const box = $('model-cards');
  if (!box) return;
  // 默认模型字段是固定 id 的真实节点（多处逻辑依赖），
  // 重渲染前先搬回暂存区，否则会被 innerHTML='' 销毁
  const fields = $('primary-model-fields');
  const stash = $('model-fields-stash');
  if (fields && stash) stash.appendChild(fields);
  box.innerHTML = '';
  modelEntryList().forEach((m) => box.appendChild(modelCard(m, fields)));
}

// entry: modelEntryList() 的一项（primary 为 true 时为默认模型）
function modelCard(entry, primaryFields) {
  const isPrimary = !!entry.primary;
  const key = isPrimary ? '__primary__' : entry.id;
  const open = !!modelExpanded[key];
  const needKey = providerNeedsKey(entry.provider);
  const keyTag = entry.apiKey
    ? '<span class="model-badge ok">已配 Key</span>'
    : (needKey ? '<span class="model-badge warn" title="该 provider 通常需要 API Key">无 Key</span>' : '<span class="model-badge">无需 Key</span>');
  const wrap = document.createElement('div');
  wrap.className = 'mcp-card' + (open ? ' open' : '');
  wrap.innerHTML =
    '<div class="mcp-card-head">'
    + '<span class="mcp-caret">▾</span>'
    + '<span class="model-badge alt">' + escapeHtml(providerLabel(entry.provider)) + '</span>'
    + '<span class="mcp-test-name">' + escapeHtml(entry.model || '(未填模型名)') + '</span>'
    + (isPrimary ? '<span class="model-badge cur">默认</span>' : '')
    + keyTag
    + '<span class="mcp-test-target" title="' + escapeHtml(entry.baseUrl || '') + '">' + escapeHtml(entry.baseUrl || '') + '</span>'
    + '<span class="mcp-head-acts">'
    + (isPrimary
      ? '<button type="button" class="skill-act danger" data-del title="删除后由下一个模型接任默认">删除</button>'
      : '<button type="button" class="skill-act" data-primary title="设为默认模型（与当前默认互换）">设为默认</button>'
        + '<button type="button" class="skill-act danger" data-del>删除</button>')
    + '</span>'
    + '</div>'
    + '<div class="mcp-card-body"' + (open ? '' : ' hidden') + '></div>';

  const head = wrap.querySelector('.mcp-card-head');
  const body = wrap.querySelector('.mcp-card-body');
  head.addEventListener('click', (e) => {
    if (e.target.closest('.mcp-head-acts')) return;
    modelExpanded[key] = !modelExpanded[key];
    renderModelList();
  });

  if (isPrimary) {
    // 默认模型：直接复用原有字段节点（保留 id 与已绑定的事件）
    if (primaryFields) body.appendChild(primaryFields);
    wrap.querySelector('[data-del]').addEventListener('click', (e) => {
      e.stopPropagation();
      const rest = extraModels();
      // 默认模型是问答的兜底，至少得留一个模型可用
      if (!rest.length) { toast('至少需保留一个模型。先「＋ 添加模型」再删除当前默认', 4000); return; }
      const next = rest[0];
      const nextName = next.model || '(未填模型名)';
      if (!confirm(`删除默认模型「${entry.model || '(未填模型名)'}」？\n删除后由「${nextName}」接任默认模型。`)) return;
      delete modelExpanded['__primary__'];
      promoteModel(next.id);
      toast(`已删除，现默认模型：${nextName}`, 3000);
    });
  } else {
    body.appendChild(extraModelForm(entry));
    wrap.querySelector('[data-primary]').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!entry.model) { toast('该模型还没填模型名，先展开填完再设为默认', 3500); return; }
      promoteModel(entry.id, { keepOld: true });
      toast(`已设为默认：${entry.model}（原默认保留为普通模型卡）`, 3800);
    });
    wrap.querySelector('[data-del]').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`删除模型「${entry.model || entry.id}」？`)) return;
      state.settings.extraModels = extraModels().filter((x) => x.id !== entry.id);
      // 删掉的模型若正被选中，回退到默认模型
      if (state.aiModelId === entry.id) setAiModel('__primary__');
      delete modelExpanded[entry.id];
      persist();
      renderModelList();
      if (typeof refreshAiModelUi === 'function') refreshAiModelUi();
      toast('模型已删除');
    });
  }
  return wrap;
}

// 非默认模型的内联表单：字段改动即存（与设置页自动保存一致）
function extraModelForm(m) {
  const box = document.createElement('div');
  box.className = 'model-form';
  const provOpts = Object.keys(PROVIDER_PRESETS)
    .map((k) => `<option value="${k}"${normalizeProvider(m.provider) === k ? ' selected' : ''}>${escapeHtml(PROVIDER_PRESETS[k].label)}</option>`).join('');
  const ddId = 'mdd-' + m.id;
  box.innerHTML =
    '<label>服务商 Provider</label>'
    + '<select data-f="provider">' + provOpts + '</select>'
    + '<label>接口地址 (Base URL)</label>'
    + '<input type="text" data-f="baseUrl" placeholder="https://…/v1" />'
    + '<label>API Key</label>'
    + '<input type="password" data-f="apiKey" placeholder="该模型专用 Key（可留空）" />'
    + '<p class="modal-tip" data-keytip></p>'
    + '<label>模型名称</label>'
    + '<div class="setting-row">'
    + '<div class="model-input-wrap">'
    + '<input type="text" data-f="model" placeholder="模型名称" />'
    + '<button type="button" class="model-dd-btn" data-dd>▾</button>'
    + '<div class="model-dd" data-ddmenu hidden></div>'
    + '</div>'
    + '<button type="button" class="btn btn-ghost" data-fetch>获取模型</button>'
    + '</div>'
    + '<p class="modal-tip" data-fetchtip></p>';

  const prov = box.querySelector('[data-f="provider"]');
  const url = box.querySelector('[data-f="baseUrl"]');
  const keyEl = box.querySelector('[data-f="apiKey"]');
  const nameEl = box.querySelector('[data-f="model"]');
  url.value = m.baseUrl || '';
  keyEl.value = m.apiKey || '';
  nameEl.value = m.model || '';
  const keyTip = box.querySelector('[data-keytip]');
  const syncKeyTip = () => {
    keyTip.textContent = providerNeedsKey(prov.value)
      ? '该 provider 需要 API Key；留空则调用时回退使用默认模型的 Key'
      : '本地部署无需 API Key，可留空';
  };
  syncKeyTip();

  // 字段落盘：只改该条，不重渲染（避免输入中卡片被重建）
  const save = (patch, opts = {}) => {
    const list = extraModels().slice();
    const i = list.findIndex((x) => x.id === m.id);
    if (i < 0) return;
    list[i] = { ...list[i], ...patch };
    state.settings.extraModels = list;
    persist();
    if (typeof refreshAiModelUi === 'function') refreshAiModelUi();
    if (opts.rerender) renderModelList();
  };
  prov.addEventListener('change', () => {
    const preset = PROVIDER_PRESETS[prov.value] || PROVIDER_PRESETS[DEFAULT_PROVIDER];
    if (preset.url) url.value = preset.url;
    if (!providerNeedsKey(prov.value)) keyEl.value = '';
    syncKeyTip();
    clearModelOptions(ddId);
    save({ provider: prov.value, baseUrl: url.value.trim(), apiKey: keyEl.value.trim() }, { rerender: true });
  });
  url.addEventListener('change', () => save({ baseUrl: url.value.trim() }, { rerender: true }));
  keyEl.addEventListener('change', () => save({ apiKey: keyEl.value.trim() }, { rerender: true }));
  nameEl.addEventListener('change', () => save({ model: nameEl.value.trim() }, { rerender: true }));

  // 获取模型 + ▾ 下拉（每张卡片独立一份候选）
  const fetchBtn = box.querySelector('[data-fetch]');
  const ddBtn = box.querySelector('[data-dd]');
  const ddMenu = box.querySelector('[data-ddmenu]');
  const fetchTip = box.querySelector('[data-fetchtip]');
  fetchBtn.addEventListener('click', async () => {
    const baseUrl = url.value.trim();
    if (!baseUrl) { toast('请先填写 Base URL', 3000); return; }
    const old = fetchBtn.textContent;
    fetchBtn.disabled = true; fetchBtn.textContent = '获取中…';
    const res = await window.kb.listModels({ apiBaseUrl: baseUrl, apiKey: keyEl.value.trim() })
      .catch((err) => ({ ok: false, error: (err && err.message) || String(err) }));
    fetchBtn.disabled = false; fetchBtn.textContent = old;
    if (!res || !res.ok) {
      clearModelOptions(ddId);
      fetchTip.textContent = '⚠️ ' + ((res && res.error) || '获取失败');
      return;
    }
    fillModelOptions(ddId, res.models);
    const n = (res.models || []).length;
    fetchTip.textContent = n ? `已获取 ${n} 个模型，点 ▾ 选择` : '该接口未返回任何模型';
    if (n && !nameEl.value.trim()) { nameEl.value = res.models[0]; save({ model: res.models[0] }, { rerender: true }); }
  });
  ddBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!ddMenu.hidden) { ddMenu.hidden = true; return; }
    const models = fetchedModelStore[ddId] || [];
    ddMenu.innerHTML = '';
    if (!models.length) {
      const d = document.createElement('div');
      d.className = 'empty';
      d.textContent = '尚未获取模型，先点「获取模型」';
      ddMenu.appendChild(d);
    } else {
      models.forEach((name) => {
        const d = document.createElement('div');
        d.className = 'item';
        d.textContent = name;
        d.addEventListener('click', (ev) => {
          ev.stopPropagation();
          nameEl.value = name;
          ddMenu.hidden = true;
          save({ model: name }, { rerender: true });
        });
        ddMenu.appendChild(d);
      });
    }
    ddMenu.hidden = false;
  });
  document.addEventListener('click', (e) => {
    if (!ddMenu.hidden && !ddMenu.contains(e.target) && e.target !== ddBtn) ddMenu.hidden = true;
  });
  return box;
}

// 新增模型：直接追加一张空卡并展开（与 MCP 的「＋ 添加」一致）
function addModelCard() {
  const preset = PROVIDER_PRESETS[DEFAULT_PROVIDER];
  const id = 'm-' + uid();
  const list = extraModels().slice();
  list.push({ id, provider: DEFAULT_PROVIDER, model: '', baseUrl: preset.url || '', apiKey: '' });
  state.settings.extraModels = list;
  modelExpanded[id] = true;
  persist();
  renderModelList();
  toast('已新增模型卡片，请填写模型名与 Key', 3500);
}




// ---------- MCP / Skills 配置（标准结构，分两个 Tab） ----------
function renderExtEditors() {
  renderMcpCards();
  renderSkillGrid();
}

// 展开状态（按服务器名）：默认全部收起，与 Wiki 多级列表的默认折叠约定一致
const mcpExpanded = {};

// 每个 MCP 服务器一张可折叠卡片：卡头常驻（名称/类型/状态），展开后含其只读配置与独立测试
function renderMcpCards() {
  const box = $('mcp-list');
  if (!box) return;
  box.innerHTML = '';
  const list = (state.settings && state.settings.mcpServers) || [];
  if (!list.length) {
    box.innerHTML = '<div class="mcp-empty">暂无 MCP 服务器。点上方「＋ 添加」或「📝 Configure MCP Servers」写入配置</div>';
    return;
  }
  list.forEach((m) => box.appendChild(mcpCard(m)));
}

function mcpCard(m) {
  const key = m.name || '(未命名)';
  const open = !!mcpExpanded[key];
  const target = m.type === 'stdio'
    ? [m.command || '(未填命令)', ...(m.args || [])].join(' ')
    : (m.url || '(未填 URL)');
  const wrap = document.createElement('div');
  wrap.className = 'mcp-card' + (open ? ' open' : '');
  wrap.dataset.mcpName = key;
  wrap.innerHTML =
    '<div class="mcp-card-head">'
    + '<span class="mcp-caret">▾</span>'
    + '<span class="mcp-test-name">' + escapeHtml(key) + '</span>'
    + '<span class="mcp-test-badge">' + escapeHtml(m.type || 'stdio') + '</span>'
    + (m.useModelKey ? '<span class="mcp-test-badge alt" title="复用模型配置中的 API Key">模型 Key</span>' : '')
    + (m.enabled === false ? '<span class="mcp-test-badge off">已停用</span>' : '')
    + '<span class="mcp-test-target" title="' + escapeHtml(target) + '">' + escapeHtml(target) + '</span>'
    + '<span class="mcp-test-status"></span>'
    + '<span class="mcp-head-acts">'
    + '<button type="button" class="skill-act" data-edit>编辑</button>'
    + '<button type="button" class="skill-act danger" data-del>删除</button>'
    + '</span>'
    + '</div>'
    + '<div class="mcp-card-body"' + (open ? '' : ' hidden') + '>'
    + '<pre class="mcp-json-view"></pre>'
    + '<div class="mcp-tool-bar">'
    + '<select class="mcp-tool-sel"><option value="">工具：自动选择</option></select>'
    + '<input type="text" class="mcp-args" placeholder="参数 JSON（可选），例：{&quot;city&quot;:&quot;西安&quot;}" />'
    + '</div>'
    + '<div class="mcp-tool-hint" hidden></div>'
    + '<div class="mcp-test-bar">'
    + '<input type="text" class="mcp-test-query" placeholder="测试内容（可选），留空只测连接与列工具" />'
    + '<button type="button" class="btn btn-ghost mcp-test-btn" data-test>🔍 测试</button>'
    + '<button type="button" class="btn btn-ghost mcp-copy-btn" data-copy hidden>⎘ 复制</button>'
    + '</div>'
    + '<pre class="mcp-test-out" hidden></pre>'
    + '</div>';
  // 该服务器自身的配置片段（仍为只读 JSON，编辑一律走 JSON 弹窗）
  wrap.querySelector('.mcp-json-view').textContent = JSON.stringify(mcpArrayToObject([m]), null, 2);

  const head = wrap.querySelector('.mcp-card-head');
  const body = wrap.querySelector('.mcp-card-body');
  head.addEventListener('click', () => {
    const nowOpen = body.hidden;
    body.hidden = !nowOpen;
    mcpExpanded[key] = nowOpen;
    wrap.classList.toggle('open', nowOpen);
  });
  // 编辑/删除：阻止冒泡，不连带展开/收起
  wrap.querySelector('[data-edit]').addEventListener('click', (e) => {
    e.stopPropagation();
    openMcpJson(key);
  });
  wrap.querySelector('[data-del]').addEventListener('click', (e) => {
    e.stopPropagation();
    removeMcpServer(key);
  });

  const btn = wrap.querySelector('[data-test]');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    runMcpTest(m, btn, wrap.querySelector('.mcp-test-status'),
      wrap.querySelector('.mcp-test-query'), wrap.querySelector('.mcp-test-out'), wrap);
  });
  // 工具下拉变更：展示该工具的必填/可选参数，并预填一个参数 JSON 骨架
  const sel = wrap.querySelector('.mcp-tool-sel');
  sel.addEventListener('change', () => applyMcpToolHint(wrap));
  // 复制测试输出
  const copyBtn = wrap.querySelector('[data-copy]');
  copyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const text = wrap.querySelector('.mcp-test-out').textContent || '';
    try {
      await navigator.clipboard.writeText(text);
      toast('测试结果已复制');
    } catch (_) {
      // 剪贴板不可用时回退到 execCommand
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('测试结果已复制'); } catch (__) { toast('复制失败，请手动选中', 3000); }
      ta.remove();
    }
  });
  // 输入框回车直接测试（避开 IME 选词回车）
  wrap.querySelector('.mcp-test-query').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    btn.click();
  });
  return wrap;
}
// 技能广场式卡片网格（搜索过滤 + 点击启用/删除）
// 依据技能名生成稳定的柔和配色，让卡片图标有区分度
function skillHue(name) {
  let h = 0;
  for (const c of String(name || '⚡')) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
function renderSkillGrid() {
  const box = $('skill-grid'); if (!box) return;
  const q = (($('skill-search') && $('skill-search').value) || '').trim().toLowerCase();
  box.innerHTML = '';
  const list = (state.settings.skills || []).filter((k) => !q || (k.name || '').toLowerCase().includes(q) || (k.desc || k.description || '').toLowerCase().includes(q));
  if (!list.length) { box.innerHTML = '<div style="grid-column:1/-1;color:var(--text-sub);font-size:12.5px;padding:12px 0">暂无技能，点「＋ 创建技能」选择含 SKILL.md 的目录</div>'; return; }
  list.forEach((k) => {
    const card = document.createElement('div');
    card.className = 'skill-card' + (k.enabled ? '' : ' off');
    const dirTag = k.dir ? String(k.dir).split('/').filter(Boolean).slice(-1)[0] : '';
    const hue = skillHue(k.name);
    card.innerHTML =
      '<div class="skill-card-head"><span class="skill-card-ico" style="background:hsl(' + hue + ' 70% 94%);color:hsl(' + hue + ' 60% 42%)">⚡</span>' +
      '<span class="skill-card-name" title="' + escapeHtml(k.name || '') + '">' + escapeHtml(k.name || '') + '</span>' +
      '<label class="skill-switch" title="' + (k.enabled ? '已启用，点击停用' : '已停用，点击启用') + '"><input type="checkbox" data-en ' + (k.enabled ? 'checked' : '') + '><span class="skill-switch-slider"></span></label></div>' +
      '<div class="skill-card-desc">' + escapeHtml(k.desc || k.description || '（无描述）') + '</div>' +
      '<div class="skill-card-foot">' + (dirTag ? '<span class="skill-card-tag" title="' + escapeHtml(k.dir || '') + '">📁 ' + escapeHtml(dirTag) + '</span>' : '<span class="skill-card-tag skill-card-tag-empty">未关联目录</span>') +
      '<span class="skill-card-actions">' +
      '<button type="button" class="skill-act" data-edit>编辑</button>' +
      '<button type="button" class="skill-act danger" data-del>删除</button></span></div>';
    const en = card.querySelector('[data-en]');
    card.querySelector('.skill-switch').addEventListener('click', (e) => e.stopPropagation());
    en.addEventListener('change', (e) => { k.enabled = e.target.checked; persist(); renderSkillGrid(); refreshAllExtMenus(); });
    card.querySelector('[data-del]').addEventListener('click', (e) => { e.stopPropagation(); state.settings.skills = (state.settings.skills || []).filter((x) => x !== k); persist(); renderExtEditors(); refreshAllExtMenus(); });
    card.querySelector('[data-edit]').addEventListener('click', (e) => { e.stopPropagation(); openSkillEdit(k); });
    card.addEventListener('click', () => { k.enabled = !k.enabled; persist(); renderSkillGrid(); refreshAllExtMenus(); });
    box.appendChild(card);
  });
}
// ---------- 技能编辑 ----------
let editingSkill = null;
function openSkillEdit(k) {
  editingSkill = k;
  $('skill-edit-name').value = k.name || '';
  $('skill-edit-dir').value = k.dir || '';
  $('skill-edit-desc').value = k.desc || k.description || '';
  $('skill-edit-instr').value = k.instructions || '';
  $('skill-edit-modal').hidden = false;
}
function saveSkillEdit() {
  if (!editingSkill) return;
  editingSkill.name = $('skill-edit-name').value.trim() || editingSkill.name;
  editingSkill.desc = $('skill-edit-desc').value.trim();
  editingSkill.description = editingSkill.desc;
  editingSkill.instructions = $('skill-edit-instr').value.trim();
  persist();
  $('skill-edit-modal').hidden = true;
  renderExtEditors(); refreshAllExtMenus();
  toast('技能已保存');
}
// 创建技能：选择含 SKILL.md 的目录并植入
async function addSkillByDir() {
  let dir = '';
  try { const res = await window.kb.rawPickDir(); if (res && res.ok && res.path) dir = res.path; else if (res && res.canceled) return; } catch (_) {}
  if (!dir) dir = ((await askInput('输入 skill 目录（含 SKILL.md）：')) || '').trim();
  if (!dir) return;
  const r = await window.kb.skillRead({ dir });
  if (!r.ok) { toast(r.error || '读取 SKILL.md 失败', 3000); return; }
  state.settings.skills = state.settings.skills || [];
  if (state.settings.skills.some((x) => x.name === r.name)) { toast('该技能已存在', 2500); return; }
  state.settings.skills.push({ name: r.name, dir: r.dir, desc: r.description, description: r.description, instructions: r.instructions, enabled: true });
  persist(); renderExtEditors(); refreshAllExtMenus();
  toast('已添加技能：' + r.name);
}
// ---------- MCP JSON 配置（Cline 风格） ----------
function mcpArrayToObject(arr) {
  const o = {};
  (arr || []).forEach((m) => {
    if (!m || !m.name) return;
    const v = {};
    if (m.type) v.type = m.type;
    if (m.command) v.command = m.command;
    if (m.args && m.args.length) v.args = m.args;
    if (m.env && Object.keys(m.env).length) v.env = m.env;
    if (m.url) v.url = m.url;
    if (m.useModelKey) v.useModelKey = true;
    v.enabled = m.enabled !== false;
    o[m.name] = v;
  });
  return { mcpServers: o };
}
function mcpObjectToArray(obj) {
  // Cline 格式归一化：兼容 baseUrl/headers/isActive/description 等字段写法
  const out = [];
  const servers = (obj && obj.mcpServers) || {};
  for (const [name, raw] of Object.entries(servers)) {
    const v = raw || {};
    const url = v.url || v.baseUrl || v.baseURL || '';
    const type = v.type || (v.command ? 'stdio' : (url ? 'http' : 'stdio'));
    const e = {
      name,
      type,
      enabled: v.enabled !== false && v.isActive !== false && v.disabled !== true,
    };
    if (type === 'stdio') {
      e.command = v.command || '';
      e.args = Array.isArray(v.args) ? v.args : String(v.args || '').split(/\s+/).filter(Boolean);
    }
    if (url) e.url = url;
    if (v.env && typeof v.env === 'object') e.env = v.env;
    const auth = v.headers && (v.headers.Authorization || v.headers.authorization);
    if (auth) {
      // ${XXX} 占位符表示使用模型 Key；否则视为固定 Authorization 头
      if (/\$\{/.test(auth)) e.useModelKey = true;
      else e.env = Object.assign({}, e.env, { Authorization: auth });
    } else if (v.useModelKey) e.useModelKey = true;
    if (v.description) e.desc = String(v.description);
    out.push(e);
  }
  return out;
}
// ---------- MCP 连通性测试（渲染在各服务器卡片内，不涉及配置修改） ----------

// 工具返回内容格式化：有结构化条目时逐条展示「标题 / 链接 / 摘要」，而不是直接丢原始 JSON；
// 无法识别时退回原文。返回 { body, count }，count 为识别到的条目数
function formatMcpResult(text) {
  const raw = String(text || '');
  let j;
  try { j = JSON.parse(raw); } catch (_) { return { body: raw, count: null }; }
  if (!j || typeof j !== 'object') return { body: raw, count: null };
  // 常见搜索类返回的条目数组字段
  const keys = ['pages', 'results', 'items', 'data', 'organic', 'webPages', 'documents'];
  let arr = null;
  for (const k of keys) { if (Array.isArray(j[k])) { arr = j[k]; break; } }
  if (!arr && Array.isArray(j)) arr = j;
  // 兼容未列举的字段名（如高德天气的 forecasts）：取第一个非空数组属性
  if (!arr) {
    for (const k of Object.keys(j)) { if (Array.isArray(j[k]) && j[k].length) { arr = j[k]; break; } }
  }
  if (!arr) return { body: raw, count: null };
  if (!arr.length) return { body: '（服务端返回 0 条结果）', count: 0 };
  const pick = (o, names) => { for (const n of names) { if (o && o[n]) return String(o[n]); } return ''; };
  const lines = arr.slice(0, 10).map((it, i) => {
    if (typeof it === 'string') return `${i + 1}. ${it}`;
    const title = pick(it, ['title', 'name', 'heading']);
    const url = pick(it, ['url', 'link', 'displayLink', 'source']);
    const snip = pick(it, ['snippet', 'summary', 'description', 'content', 'text', 'body']).replace(/\s+/g, ' ').trim();
    // 三者都取不到（如天气预报这类结构）时，直接紧凑展示该条目，比“(无标题)”有用
    if (!title && !url && !snip) return `${i + 1}. ${JSON.stringify(it)}`;
    return `${i + 1}. ${title || '(无标题)'}` + (url ? `\n   ${url}` : '') + (snip ? `\n   ${snip.slice(0, 300)}` : '');
  });
  if (arr.length > 10) lines.push(`… 共 ${arr.length} 条，仅展示前 10 条`);
  return { body: lines.join('\n'), count: arr.length };
}

// 卡片级工具入参缓存（测试一次即获得，供下拉与参数提示使用）
const mcpToolSchemas = {};

// 选中工具后：展示必填/可选参数，并在参数框为空时预填必填项骨架
function applyMcpToolHint(wrap) {
  const sel = wrap.querySelector('.mcp-tool-sel');
  const hint = wrap.querySelector('.mcp-tool-hint');
  const argsEl = wrap.querySelector('.mcp-args');
  const name = sel.value;
  const schemas = mcpToolSchemas[wrap.dataset.mcpName] || [];
  const s = schemas.find((x) => x.name === name);
  if (!name || !s) { hint.hidden = true; hint.textContent = ''; return; }
  hint.hidden = false;
  hint.textContent = '必填：' + ((s.required || []).join('、') || '无')
    + '    全部参数：' + ((s.params || []).join('、') || '无');
  if (!argsEl.value.trim() && (s.required || []).length) {
    const skel = {};
    s.required.forEach((k) => { skel[k] = ''; });
    argsEl.value = JSON.stringify(skel);
  }
}

// 测试后回填工具下拉（保持当前选中项）
function fillMcpToolSelect(wrap, tools, schemas) {
  const sel = wrap.querySelector('.mcp-tool-sel');
  if (!sel) return;
  mcpToolSchemas[wrap.dataset.mcpName] = schemas || [];
  const cur = sel.value;
  sel.innerHTML = '<option value="">工具：自动选择</option>'
    + (tools || []).map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  if (cur && (tools || []).includes(cur)) sel.value = cur;
}

// 单个服务器测试：留空查询只测连通性+列工具；填了查询/参数则在同一会话内真实调用一次工具
// queryEl / outEl / wrap 为该服务器卡片内的元素（各卡片互不干扰）
async function runMcpTest(server, btn, status, queryEl, outEl, wrap) {
  const out = outEl;
  const query = ((queryEl && queryEl.value) || '').trim();
  const toolName = ((wrap && wrap.querySelector('.mcp-tool-sel').value) || '').trim();
  const argsRaw = ((wrap && wrap.querySelector('.mcp-args').value) || '').trim();
  let args = null;
  if (argsRaw) {
    try { args = JSON.parse(argsRaw); }
    catch (e) {
      out.hidden = false;
      out.textContent = '参数 JSON 解析失败：' + e.message + '\n请填写合法 JSON，例：{"city":"西安"}';
      toast('参数 JSON 格式错误', 3000);
      return;
    }
  }
  const label = server.name || 'MCP';
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = '测试中…';
  status.className = 'mcp-test-status running';
  status.textContent = '连接中…';
  const t0 = Date.now();
  let res;
  try {
    res = await window.kb.mcpTest({ ...server, settings: state.settings, query, toolName, args });
  } catch (err) {
    res = { ok: false, error: (err && err.message) || String(err) };
  }
  const cost = Date.now() - t0;
  btn.disabled = false;
  btn.textContent = oldText;
  const ok = !!(res && res.ok);
  status.className = 'mcp-test-status ' + (ok ? 'ok' : 'fail');
  status.textContent = ok ? '✓ 正常' : '✗ 失败';

  const lines = [
    '服务器：' + label + '    类型：' + (server.type || 'stdio'),
    '目标：' + (server.type === 'stdio' ? [server.command || '', ...(server.args || [])].join(' ') : (server.url || '')),
    '查询：' + (query || '（未填）'),
    '指定工具：' + (toolName || '（自动选择）'),
    '耗时：' + cost + ' ms',
    '',
  ];
  if (ok) {
    // 工具列表回填下拉，供下一次精确选工具
    if (wrap && res.tools) fillMcpToolSelect(wrap, res.tools, res.toolSchemas);
    lines.push('结果：成功');
    if (res.message) lines.push(res.message);
    lines.push('工具（' + ((res.tools || []).length) + '）：' + ((res.tools || []).join('、') || '无'));
    if (res.usedTool) lines.push('实际调用：' + res.usedTool + '  入参：' + JSON.stringify(res.usedArgs || {}));
    if (res.result) {
      const f = formatMcpResult(res.result);
      lines.push('', '—— 返回内容' + (f.count === null ? '' : `（${f.count} 条）`) + ' ——', f.body);
      // 工具层报错（如 INVALID_PARAMS）：提示改用显式选工具 + 填参数
      if (/INVALID_PARAM|调用失败|error|invalid/i.test(String(res.result)) && !toolName) {
        const names = (res.tools || []).length;
        lines.push('', `⚠️ 该工具报参数错误。本次是自动猜选工具与入参${names > 1 ? `（该服务共 ${names} 个工具）` : ''}，`
          + '多工具服务建议在上方下拉里**显式选定工具**，再按提示的必填参数填写「参数 JSON」后重试。');
      }
    }
    if (res.hint) lines.push('', res.hint);
    // 原始报文放最后；与格式化内容完全相同时不重复展示
    if (res.result) {
      const f = formatMcpResult(res.result);
      if (f.body.trim() !== String(res.result).trim()) lines.push('', '—— 原始返回 ——', String(res.result));
    }
  } else {
    lines.push('结果：失败', (res && res.error) || '未知错误');
  }
  out.hidden = false;
  out.textContent = lines.join('\n');
  if (wrap) { const cb = wrap.querySelector('[data-copy]'); if (cb) cb.hidden = false; }
  toast(ok ? `「${label}」测试通过（${cost} ms）` : `「${label}」测试失败`, 3000);
}

// 弹窗作用域：无论添加还是编辑，都只动目标条目，从不全量替换 mcpServers
let editingMcpName = null;
let mcpJsonMode = 'add'; // 'add' 只追加新条目 / 'edit' 局部替换已有条目

// 编辑单个服务器：弹窗只装该服务器的 JSON，避开在全量配置里翻找
function openMcpJson(name) {
  const list = state.settings.mcpServers || [];
  const one = list.find((m) => m.name === name);
  if (!one) { toast('服务器不存在：' + name, 3000); return; }
  mcpJsonMode = 'edit';
  editingMcpName = one.name;
  $('mcp-json-text').value = JSON.stringify(mcpArrayToObject([one]), null, 2);
  $('mcp-json-title').textContent = `编辑 MCP：${one.name}`;
  $('mcp-json-tip').textContent = '仅编辑该服务器，保存后合入现有配置（其他服务器不受影响）。改键名即重命名；清空 mcpServers 则删除该条';
  $('mcp-json-err').textContent = '';
  $('mcp-json-modal').hidden = false;
}

function saveMcpJson() {
  try {
    const obj = JSON.parse($('mcp-json-text').value || '{}');
    if (!obj || typeof obj.mcpServers !== 'object' || obj.mcpServers === null) throw new Error('需包含 "mcpServers" 对象');
    const parsed = mcpObjectToArray(obj);
    if (!parsed.length) throw new Error('未解析到任何服务器');
    const list = (state.settings.mcpServers || []).slice();
    if (mcpJsonMode === 'edit') {
      // 局部编辑：用弹窗内容替掉原条目（原位置保留），其余服务器原样不动
      const idx = list.findIndex((m) => m.name === editingMcpName);
      // 重命名后与另一个已存在的服务器重名时拒绝保存，避免静默覆盖
      const dup = parsed.find((p) => p.name !== editingMcpName
        && list.some((m, i) => i !== idx && m.name === p.name));
      if (dup) throw new Error(`已存在名为 ${dup.name} 的服务器，请换个名字`);
      if (idx >= 0) list.splice(idx, 1, ...parsed); else list.push(...parsed);
    } else {
      // 添加：只追加新条目，已有服务器一律不动；同名直接拒绝，不静默覆盖
      const dup = parsed.find((p) => list.some((m) => m.name === p.name));
      if (dup) throw new Error(`已存在名为 ${dup.name} 的服务器，请改名，或先删除原条目`);
      list.push(...parsed);
    }
    state.settings.mcpServers = list;
    persist();
    renderExtEditors();
    refreshAllExtMenus();
    $('mcp-json-modal').hidden = true;
    editingMcpName = null;
    toast('MCP 配置已保存');
  } catch (e) {
    // 区分「JSON 写错」与「校验不通过」，避免把重名等业务错误误报为解析失败
    $('mcp-json-err').textContent = (e instanceof SyntaxError ? 'JSON 解析失败：' : '') + e.message;
  }
}

// 删除单个 MCP 服务器
function removeMcpServer(name) {
  if (!confirm(`删除 MCP 服务器「${name}」？`)) return;
  state.settings.mcpServers = (state.settings.mcpServers || []).filter((m) => m.name !== name);
  persist();
  renderExtEditors();
  refreshAllExtMenus();
  toast('已删除：' + name);
}

function extAddRow(kind) {
  if (kind !== 'mcp') return;
  // 添加：只给出一个新条目模板，不把现有配置摊开（避免误改/误删已有服务器与 Key）
  mcpJsonMode = 'add';
  editingMcpName = null;
  const tpl = {
    mcpServers: {
      'new-server': {
        type: 'streamableHttp',
        url: 'https://example.com/mcp',
        env: { Authorization: 'Bearer sk-...' },
        enabled: true,
      },
    },
  };
  $('mcp-json-text').value = JSON.stringify(tpl, null, 2);
  $('mcp-json-title').textContent = '添加 MCP 服务器';
  $('mcp-json-tip').textContent = '只填这一个新服务器，保存后追加到列表，现有配置不会被改动。可直接粘贴 Cline / Claude 的 mcpServers 片段（stdio 则写 command/args/env）；可一次粘贴多个';
  $('mcp-json-err').textContent = '';
  $('mcp-json-modal').hidden = false;
}
function collectExt() {
  // MCP 与技能均走各自专门入口（JSON 弹窗 / 技能广场）即时 persist；
  // 这里原样返回当前状态，避免保存设置时被空卡片列表冲掉
  return {
    mcpServers: (state.settings.mcpServers || []).slice(),
    skills: (state.settings.skills || []).slice(),
  };
}

function showSettingsView() {
  const s = state.settings;
  const D = window.kb.defaults || {};
  // 先切换视图，确保设置页一定显示（填充逻辑异常也不影响页面出现）
  switchSettingsTab(state.settingsTab || 'ai');
  hideMainViews();
  promptEditing = null;
  $('settings-view').hidden = false;
  try {
    fillPrimaryModelFields();
    renderExtEditors();
    renderModelList();
    const fillDec = (id, v) => { $(id).value = Number.isFinite(v) ? String(v) : ''; };
    fillDec('set-temperature', s.temperature);
    fillDec('set-topp', s.topP);
    fillDec('set-maxtokens', s.maxTokens);
    $('set-wikiroot').value = s.wikiRoot || '';
    window.kb.dataRoot().then((p) => { state.currentRoot = p; $('set-dataroot').value = p; });
    const fillNum = (id, v) => { $(id).value = Number.isFinite(v) ? String(v) : ''; };
    for (const [key, [id]] of Object.entries(NUM_SETTING_FIELDS)) fillNum(id, s[key]);
    $('set-editormode').value = EDITOR_MODES.includes(s.defaultEditorMode) ? s.defaultEditorMode : 'split';
    $('set-aiassist').value = s.aiAssistPrompt || '';
    window.kb.wikiDefaultRoot().then((p) => { $('set-wikiroot').placeholder = '留空则自动探测：' + p; });
    window.kb.getDataPath().then((p) => { state.currentDbPath = p; $('set-dbpath').value = p; $('data-path').textContent = '数据文件：' + p; });
  } catch (e) { console.error('设置填充失败:', e); }
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
  // 若目标 tab 无对应面板（如历史遗留值），回退模型配置
  if (!document.querySelector(`.settings-pane[data-pane="${tab}"]`)) tab = 'ai';
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

// 数据根目录：仅写配置指针，重启后生效。因会改变数据位置，不纳入自动保存，由「应用」显式触发
async function applyDataRoot() {
  const newRoot = $('set-dataroot').value.trim();
  if (newRoot === (state.currentRoot || '')) { toast('数据根目录未变更'); return; }
  const res = await window.kb.setDataRoot(newRoot);
  if (!res.ok) { toast('数据根目录修改失败：' + res.error, 4000); return; }
  state.currentRoot = res.root;
  $('set-dataroot').value = res.root;
  toast('数据根目录已设为 ' + res.root + '，重启应用后生效', 5000);
}

// 数据文件位置：触发整库迁移，同样不自动保存
async function applyDbPath() {
  const newDbPath = $('set-dbpath').value.trim();
  if (newDbPath === state.currentDbPath) { toast('数据文件位置未变更'); return; }
  const res = await window.kb.setDbPath(newDbPath);
  if (!res.ok) { toast('数据文件位置切换失败：' + res.error, 4000); return; }
  state.currentDbPath = res.path;
  $('set-dbpath').value = res.path;
  $('data-path').textContent = '数据文件：' + res.path;
  toast(res.changed ? '数据已迁移至：' + res.path : '数据文件位置已更新', 4000);
}

// 设置表单自动保存（除数据根目录/数据文件位置这两个需显式应用的项）
function saveSettingsFields() {
  // 保留非表单字段，避免保存时丢失
  const s = { ...state.settings };
  s.apiBaseUrl = $('set-baseurl').value.trim();
  s.apiKey = $('set-apikey').value.trim();
  s.model = $('set-model').value.trim();
  s.apiProvider = normalizeProvider($('set-provider').value);
  Object.assign(s, collectExt());
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
  markSettingsSaved();
  renderAiExt(); // 扩展（MCP/Skills）变更后即时刷新 AI 面板选择行
  loadWiki();
}

// 自动保存反馈：不用 toast，避免频繁改动时弹窗打扰
let autosaveTimer = null;
function markSettingsSaved() {
  const el = $('settings-autosave');
  if (!el) return;
  el.textContent = '✓ 已自动保存';
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => { el.textContent = ''; }, 2000);
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
      <textarea class="prompt-card-input" rows="7" placeholder="${d.def ? '默认：' + escapeHtml(d.def) : '（使用内置默认）'}"></textarea>
      <div class="prompt-card-actions">
        <button class="btn btn-primary" data-act="save">保存</button>
        <button class="btn btn-ghost" data-act="fullscreen" title="在主框架内全屏编辑">✎ 全屏编辑</button>
        <button class="btn btn-ghost" data-act="reset">恢复默认</button>
      </div>`;
    const ta = card.querySelector('textarea');
    // 无自定义时预填内置默认，便于在默认基础上修改而非完全重写
    ta.value = state.settings[d.key] || d.def || '';
    card.querySelector('[data-act="save"]').addEventListener('click', () => {
      state.settings[d.key] = ta.value.trim();
      persist();
      toast('已保存「' + d.name + '」提示词');
    });
    card.querySelector('[data-act="fullscreen"]').addEventListener('click', () => openPromptEditor(d, ta));
    card.querySelector('[data-act="reset"]').addEventListener('click', () => {
      delete state.settings[d.key];
      ta.value = d.def || '';
      persist();
      toast('「' + d.name + '」已恢复默认，可在默认基础上修改后保存');
    });
    box.appendChild(card);
  });
}

function showPromptsView() {
  $('wiki-viewer').hidden = true;
  $('settings-view').hidden = true;
  $('jobs-view').hidden = true;
  hideMainViews();
  promptEditing = null;
  $('prompts-view').hidden = false;
  renderPromptCards();
  renderEditor();
  renderSidebar();
}
function hidePromptsView() {
  $('prompts-view').hidden = true;
  $('prompt-editor-view').hidden = true;
  promptEditing = null;
  renderEditor();
  renderSidebar();
}

// ---------- 提示词全屏编辑（主框架视图，从卡片列表进入） ----------
let promptEditing = null; // { key, def, cardTa }：正在全屏编辑的项与列表卡片输入框引用

function openPromptEditor(d, cardTa) {
  promptEditing = { key: d.key, def: d.def, cardTa };
  $('prompt-editor-title').textContent = '✎ ' + d.name;
  $('prompt-editor-desc').textContent = d.desc || '';
  $('prompt-editor-input').placeholder = d.def ? '默认：' + d.def : '（使用内置默认）';
  $('prompt-editor-input').value = cardTa.value;
  $('prompts-view').hidden = true;
  $('prompt-editor-view').hidden = false;
  renderEditor();
  $('prompt-editor-input').focus();
}

// 返回列表；save=true 时先落盘（与卡片「保存」同逻辑），否则未保存变更需确认
function closePromptEditor(save) {
  if (!promptEditing) { $('prompt-editor-view').hidden = true; return; }
  const input = $('prompt-editor-input');
  if (save) {
    state.settings[promptEditing.key] = input.value.trim();
    promptEditing.cardTa.value = input.value;
    persist();
    toast('已保存提示词');
  } else if (input.value !== promptEditing.cardTa.value && !confirm('有未保存的修改，确定返回列表？')) {
    return;
  }
  promptEditing = null;
  $('prompt-editor-view').hidden = true;
  $('prompts-view').hidden = false;
  renderEditor();
}

// 全屏编辑页「恢复默认」：清除自定义值并回填内置默认文本，可在其基础上继续修改
function resetPromptEditor() {
  if (!promptEditing) return;
  delete state.settings[promptEditing.key];
  const v = promptEditing.def || '';
  $('prompt-editor-input').value = v;
  promptEditing.cardTa.value = v;
  persist();
  toast('已恢复默认提示词，可在此基础上修改后保存');
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
  ['settings-view', 'jobs-view', 'graph-view', 'tpl-view', 'raw-view', 'prompts-view', 'prompt-editor-view', 'ai-view'].forEach((id) => { $(id).hidden = true; });
  if (!keepWikiViewer) $('wiki-viewer').hidden = true;
}

// 设置页/任一主框架专题页打开或用户主动收起时，笔记列表与其分隔条让位（专题页全屏）
function syncNoteListVisibility() {
  const mainOpen = ['ai-view', 'jobs-view', 'graph-view', 'raw-view', 'tpl-view', 'prompts-view', 'settings-view'].some((id) => !$(id).hidden);
  const hidden = mainOpen || state.noteListHidden;
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

// 侧边栏显隐：同步其分隔条与收起后的图标栏
function syncSidebarVisibility() {
  const hidden = !!state.sidebarHidden;
  const bar = document.querySelector('.sidebar');
  if (bar) bar.style.display = hidden ? 'none' : '';
  const rz = $('sidebar-resizer');
  if (rz) rz.style.display = hidden ? 'none' : '';
  const rail = $('sidebar-rail');
  if (rail) rail.hidden = !hidden;
}

// 收起/展开侧边菜单栏（偏好持久化在 localStorage）
function setSidebarHidden(hiddenFlag) {
  state.sidebarHidden = hiddenFlag;
  if (hiddenFlag) localStorage.setItem('kb.sidebarHidden', '1');
  else localStorage.removeItem('kb.sidebarHidden');
  syncSidebarVisibility();
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

