// 渲染进程·公共模块：全局状态、工具函数、侧边栏、设置、视图协调、分隔条拖拽
/* global marked */

// ================= 状态 =================
const state = {
  folders: [],   // {id, name, parentId}
  notes: [],     // {id, title, content, tags[], folderId, pinned, favorited, createdAt, updatedAt}
  settings: {},  // {apiBaseUrl, apiKey, model, maxJobsHistory, chatRetries, urlFetchTimeout, sourceMaxChars, logTailLines, defaultEditorMode}
  view: { type: 'all', id: null, query: '' }, // type: all | folder | tag | fav | search
  selectedNoteId: null,
  editorMode: 'preview',
  settingsTab: 'ai',                // 设置页当前 Tab 分类
  currentDbPath: '',                // 当前 SQLite 数据文件路径（设置页回填用）
  aiBusy: false,
  aiBusySessionId: null,              // 正在回答的会话 id（仅内存，用于列表“回答中”标识）
  jobs: [],                           // 后台作业列表
  jobsFilter: 'all',                  // 作业页筛选：all | active | success | failed
  jobsExpanded: {},                   // 作业页展开状态 { jobId: true }
  graph: { nodes: [], edges: [], updatedAt: 0 }, // 知识图谱（本体层）
  noteListHidden: false,              // 笔记列表栏是否被用户收起
  aiSources: { notes: false, graph: false, raws: false }, // AI 问答数据源
  aiGraphProfile: 'all', // 知识图谱源的体系范围：'all'=全部体系，或具体体系 id（多体系共存时按体系隔离召回）
  kg: { tab: 'overview', onto: null, ontoTab: 'classes', entitySel: null, focus: null }, // 知识图谱模块子视图状态；focus = 邻居视图中心节点
  templates: [],                      // 领域模版列表
  raws: [],                           // raw/ 原始来源列表
  folderCollapsed: {},                // 目录树折叠状态
  trashedFolders: [],                 // 已删除目录的快照 [{id,name,parentId}]，垃圾桶内分组展示/整目录还原用
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

// 统一线性图标：渲染 index.html 顶部 SVG sprite 中的 symbol
function icoSvg(name, size) {
  const s = size || 14;
  return '<svg class="ico" width="' + s + '" height="' + s + '"><use href="#i-' + name + '"/></svg>';
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
    // 消毒：剥离 script/事件属性等（AI 回答与外部内容不可信）；
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

// ---------- 工具返回的图片预览（MCP 生图 / 文件类结果） ----------
// 匹配 http(s) 图片链接，允许带查询串（OSS 签名链接形如 .png?Expires=…&Signature=…）
const IMAGE_URL_RE = /https?:\/\/[^\s"'<>]+?\.(?:png|jpe?g|gif|webp|bmp)(?:\?[^\s"'<>]*)?/gi;
function extractImageUrls(text) {
  const s = String(text || '');
  const out = [];
  let m;
  IMAGE_URL_RE.lastIndex = 0;
  while ((m = IMAGE_URL_RE.exec(s))) {
    let u = m[0].replace(/[),.;，。；]+$/, ''); // 去掉尾部标点
    if (u && !out.includes(u)) out.push(u);
    if (out.length >= 8) break;
  }
  return out;
}
// 生成可点击的图片预览条；点击用系统浏览器打开，不跳转应用内窗口
function buildImagePreview(urls, label) {
  if (!urls || !urls.length) return null;
  const box = document.createElement('div');
  box.className = 'img-preview';
  const head = document.createElement('div');
  head.className = 'img-preview-head';
  head.textContent = `${label || '🖼 生成的图片'}（${urls.length}，点击打开原图）`;
  box.appendChild(head);
  urls.forEach((u) => {
    const a = document.createElement('a');
    a.className = 'img-preview-item';
    a.href = u; a.title = u;
    a.addEventListener('click', (e) => { e.preventDefault(); try { window.kb.openExternal(u); } catch (_) {} });
    const img = document.createElement('img');
    img.src = u; img.alt = '生成图片'; img.loading = 'lazy';
    img.addEventListener('error', () => a.classList.add('broken'));
    a.appendChild(img);
    box.appendChild(a);
  });
  return box;
}
// 在容器内追加图片预览（先清旧的，避免流式重渲染重复插入）
function appendImagePreview(containerEl, text, label) {
  if (!containerEl) return;
  containerEl.querySelectorAll(':scope > .img-preview').forEach((x) => x.remove());
  const pv = buildImagePreview(extractImageUrls(text), label);
  if (pv) containerEl.appendChild(pv);
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

// 多字段表单弹窗：一次收集多项输入（如添加链接时的 URL + 用户名 + 密码）。
// fields: [{ key, label, placeholder, type('text'|'password'), value, required }]
// 返回 { key: value, ... }；取消/点遮罩返回 null。回车提交（最后一个字段回车 = 确定）。
function askForm(title, fields, opts = {}) {
  return new Promise((resolve) => {
    $('form-title').textContent = title;
    const tip = $('form-tip');
    if (opts.tip) { tip.textContent = opts.tip; tip.hidden = false; } else { tip.hidden = true; }
    const wrap = $('form-fields');
    wrap.innerHTML = '';
    const inputs = [];
    for (const f of fields || []) {
      const label = document.createElement('label');
      label.textContent = f.label || f.key;
      const input = document.createElement('input');
      input.type = f.type === 'password' ? 'password' : 'text';
      input.placeholder = f.placeholder || '';
      input.value = f.value || '';
      input.dataset.key = f.key;
      label.appendChild(input);
      wrap.appendChild(label);
      inputs.push(input);
    }
    $('form-modal').hidden = false;
    if (inputs[0]) { inputs[0].focus(); inputs[0].select(); }

    const close = (val) => {
      $('form-modal').hidden = true;
      $('btn-form-ok').removeEventListener('click', onOk);
      $('btn-form-cancel').removeEventListener('click', onCancel);
      $('form-modal').removeEventListener('click', onMask);
      inputs.forEach((i) => i.removeEventListener('keydown', onKey));
      resolve(val);
    };
    const collect = () => {
      const out = {};
      for (const f of fields || []) {
        const el = wrap.querySelector(`input[data-key="${f.key}"]`);
        out[f.key] = el ? el.value : '';
      }
      return out;
    };
    const onOk = () => {
      // 必填校验：留空的必填项聚焦提示，不提交
      for (const f of fields || []) {
        if (f.required) {
          const el = wrap.querySelector(`input[data-key="${f.key}"]`);
          if (el && !el.value.trim()) { el.focus(); return; }
        }
      }
      close(collect());
    };
    const onCancel = () => close(null);
    const onMask = (e) => { if (e.target === $('form-modal')) close(null); };
    const onKey = (e) => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); onOk(); }
      if (e.key === 'Escape') close(null);
    };
    $('btn-form-ok').addEventListener('click', onOk);
    $('btn-form-cancel').addEventListener('click', onCancel);
    $('form-modal').addEventListener('click', onMask);
    inputs.forEach((i) => i.addEventListener('keydown', onKey));
  });
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    window.kb.saveData({
      folders: state.folders,
      notes: state.notes,
      settings: state.settings,
      trashedFolders: state.trashedFolders,
    }).then((res) => {
      if (res && !res.ok) toast('保存失败：' + (res.error || '未知错误'));
    });
  }, 400);
}

// ================= 垃圾桶·被删目录分组 =================
// 被删目录快照（trashedFolders）构成一棵小森林，parentId 仍指向快照内父目录；
// 笔记的 trashFrom 是其原目录的相对路径（如 "Synapse/子目录"），据此把笔记归到对应被删目录节点。
// 被删目录的相对路径（与 folderRelPath 同规则：safeName 后按 / 拼接）
function trashedFolderRel(tf) {
  const byId = new Map((state.trashedFolders || []).map((f) => [f.id, f]));
  const safe = (s) => String(s || '').trim().replace(/[\\/:*?"<>|]/g, '-').slice(0, 80) || 'untitled';
  const chain = [];
  let cur = tf;
  while (cur) { chain.unshift(safe(cur.name)); cur = cur.parentId ? byId.get(cur.parentId) : null; }
  return chain.join('/');
}

// 笔记归属的被删目录根节点 id（其 trashFrom 前缀匹配某个被删目录链时返回该链的根快照 id，否则 null）
function trashGroupRootOf(note) {
  const rel = String(note.trashFrom || '');
  if (!rel) return null;
  const list = state.trashedFolders || [];
  if (!list.length) return null;
  const byId = new Map(list.map((f) => [f.id, f]));
  // 找 trashFrom 命中的最深层被删目录（完整相对路径相等），再回溯到链根
  let hit = null;
  for (const tf of list) {
    if (trashedFolderRel(tf) === rel) { hit = tf; break; }
  }
  if (!hit) return null;
  let root = hit;
  while (root.parentId && byId.has(root.parentId)) root = byId.get(root.parentId);
  return root.id;
}

// 垃圾桶内渲染被删目录节点（递归子目录），叶子挂该目录自己的笔记
function renderTrashedFolderNodes(tree, depth) {
  const list = state.trashedFolders || [];
  if (!list.length) return;
  const byId = new Map(list.map((f) => [f.id, f]));
  const kids = (id) => list.filter((f) => f.parentId === id);
  const roots = list.filter((f) => !f.parentId || !byId.has(f.parentId));
  const renderTf = (tf, d) => {
    const myNotes = state.notes
      .filter((n) => !!n.trashed && String(n.trashFrom || '') === trashedFolderRel(tf))
      .sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh'));
    const sub = kids(tf.id);
    const count = myNotes.length + sub.length;
    const key = 'tf:' + tf.id;
    const collapsed = !!state.folderCollapsed[key];
    const div = document.createElement('div');
    div.className = 'folder-item tf-node';
    div.style.paddingLeft = 10 + (d + 1) * 16 + 'px';
    div.innerHTML = `
      <span class="folder-toggle${count ? '' : ' empty'}" data-act="tf-toggle" title="${collapsed ? '展开目录' : '收起目录'}">${count && !collapsed ? '▾' : '▸'}</span>
      <span class="folder-name" title="已删除的目录，可右键还原">${escapeHtml(tf.name)}</span>
      <span class="nav-count">${count}</span>`;
    div.addEventListener('click', (e) => {
      const actEl = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
      const act = actEl ? actEl.dataset.act : (e.target.dataset && e.target.dataset.act);
      if (act === 'tf-toggle') {
        e.stopPropagation();
        state.folderCollapsed[key] = !collapsed;
        try { localStorage.setItem('kb.folderCollapsed', JSON.stringify(state.folderCollapsed)); } catch (_) {}
        try { localStorage.setItem('kb.folderCollapsedCustom', '1'); } catch (_) {}
        renderSidebar();
      }
    });
    div.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openCtxMenu(e.clientX, e.clientY, [
        { label: `还原目录「${tf.name}」（含子目录与笔记）`, action: () => restoreTrashedFolder(tf.id) },
        { label: `永久删除目录「${tf.name}」（含笔记，不可恢复）`, action: () => purgeTrashedFolder(tf.id) },
      ]);
    });
    tree.appendChild(div);
    if (!collapsed) {
      sub.forEach((c) => renderTf(c, d + 1));
      myNotes.forEach((n) => {
        const nd = document.createElement('div');
        nd.className = 'folder-item note-leaf' + (n.id === state.selectedNoteId ? ' active' : '');
        nd.style.paddingLeft = 10 + (d + 2) * 16 + 'px';
        nd.innerHTML = `<span class="folder-toggle">${icoSvg('notes', 12)}</span><span class="folder-name" title="${escapeHtml(n.title || '无标题笔记')}">${escapeHtml(n.title || '无标题笔记')}</span>`;
        nd.addEventListener('click', () => selectNote(n.id));
        nd.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openCtxMenu(e.clientX, e.clientY, [{ label: '还原到原来的位置', action: () => restoreNoteFromTrash(n) }]);
        });
        tree.appendChild(nd);
      });
    }
  };
  roots.forEach((r) => renderTf(r, depth));
}

// 还原被删目录：按快照逐级重建目录链（同名复用），把其下 trashed 笔记还原回对应目录，清掉该目录快照
function restoreTrashedFolder(rootId) {
  const list = state.trashedFolders || [];
  const byId = new Map(list.map((f) => [f.id, f]));
  if (!byId.has(rootId)) return;
  // 收集该目录链的全部快照 id（含子目录）
  const ids = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of list) {
      if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) { ids.add(f.id); grew = true; }
    }
  }
  // 自根向下逐级还原：父目录先就位（复用同名或新建），子目录再挂上去
  const snapToLive = new Map(); // 快照 id → 还原后的真实目录 id
  function kidsOfSnap(id) { return list.filter((f) => f.parentId === id); }
  function restoreOne(tf) {
    const parentLiveId = tf.parentId && snapToLive.has(tf.parentId) ? snapToLive.get(tf.parentId) : null;
    // 同级同名目录存在则复用，否则新建
    let live = state.folders.find((f) => (f.parentId || null) === (parentLiveId || null) && f.id !== '__trash__' && f.name === tf.name);
    if (!live) {
      live = { id: uid(), name: tf.name, parentId: parentLiveId || null };
      state.folders.push(live);
    }
    snapToLive.set(tf.id, live.id);
    kidsOfSnap(tf.id).forEach(restoreOne);
  }
  restoreOne(byId.get(rootId));
  // 还原笔记：trashFrom 命中该目录链任意层级的，folderId 指向还原后的对应目录
  const relToLive = new Map();
  for (const tf of list) {
    if (ids.has(tf.id)) relToLive.set(trashedFolderRel(tf), snapToLive.get(tf.id));
  }
  state.notes.forEach((n) => {
    if (!n.trashed) return;
    const liveId = relToLive.get(String(n.trashFrom || ''));
    if (liveId) {
      delete n.trashFrom;
      delete n.trashed;
      n.folderId = liveId;
      n.updatedAt = Date.now();
    }
  });
  state.trashedFolders = list.filter((f) => !ids.has(f.id));
  persist();
  renderAll();
  toast(`已还原目录「${byId.get(rootId).name}」`, 2500);
}

// 永久删除被删目录：该目录链快照 + 其下全部 trashed 笔记一并删除（不可恢复）
function purgeTrashedFolder(rootId) {
  const list = state.trashedFolders || [];
  const byId = new Map(list.map((f) => [f.id, f]));
  if (!byId.has(rootId)) return;
  const ids = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of list) {
      if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) { ids.add(f.id); grew = true; }
    }
  }
  const rels = new Set(list.filter((f) => ids.has(f.id)).map((f) => trashedFolderRel(f)));
  const noteCount = state.notes.filter((n) => !!n.trashed && rels.has(String(n.trashFrom || ''))).length;
  if (!confirm(`永久删除目录「${byId.get(rootId).name}」及其下 ${noteCount} 篇笔记？不可恢复。`)) return;
  state.notes = state.notes.filter((n) => !(n.trashed && rels.has(String(n.trashFrom || ''))));
  if (state.selectedNoteId && !state.notes.some((n) => n.id === state.selectedNoteId)) state.selectedNoteId = null;
  state.trashedFolders = list.filter((f) => !ids.has(f.id));
  persist();
  renderAll();
  toast('已永久删除目录', 2500);
}

// ================= 渲染：侧边栏 =================
function renderSidebar() {
  $('count-all').textContent = state.notes.length;
  $('count-graph').textContent = state.graph.nodes.length;
  $('nav-jobs').classList.toggle('active', !$('jobs-view').hidden);
  $('nav-templates').classList.toggle('active', !$('tpl-view').hidden);
  $('nav-raws').classList.toggle('active', !$('raw-view').hidden);
  // 知识图谱：只高亮当前选中的子菜单项（领域模版入口 .nav-tpl 的高亮由 nav-templates 行单独控制）
  document.querySelectorAll('#kg-submenu .nav-sub-item:not(.nav-tpl)').forEach((el) => {
    el.classList.toggle('active', !$('graph-view').hidden && state.kg.tab === el.dataset.tab);
  });
  // 整页视图（AI 问答/作业/模版/原始文件/图谱/设置）打开时，笔记列表类导航不保留高亮
  const navDimmed = !$('settings-view').hidden || !$('jobs-view').hidden || !$('tpl-view').hidden || !$('raw-view').hidden || !$('graph-view').hidden || !$('ai-view').hidden;
  // AI 问答是首页，入口同样给出选中态，避免当前页面在侧边栏无对应高亮
  $('btn-ai-toggle').classList.toggle('active', !$('ai-view').hidden);

  // 目录树（支持一级展示全部，子目录缩进）
  const tree = $('folder-tree');
  tree.innerHTML = '';
  const roots = state.folders.filter((f) => !f.parentId);
  const childrenOf = (id) => state.folders.filter((f) => f.parentId === id);
  const descendantIds = (id) => {
    const ids = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      state.folders.forEach((f) => {
        if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) { ids.add(f.id); changed = true; }
      });
    }
    return ids;
  };

  const renderFolder = (folder, depth) => {
    const children = childrenOf(folder.id);
    const collapsed = !!state.folderCollapsed[folder.id];
    // 🗑 垃圾桶是虚拟目录：真正被删除（trashed）的笔记计入它；根目录未分类笔记不再混入
    const count = folder.id === '__trash__'
      ? state.notes.filter((n) => !!n.trashed).length
      : state.notes.filter((n) => descendantIds(folder.id).has(n.folderId)).length;
    // 直属笔记（叶子节点）：参与“可展开”判定，展开符号统一为小三角（▾/▸）
    // 🗑 垃圾桶是虚拟目录：它的“直属”笔记即被删除（trashed）的，展开可查看
    const ownNotes = state.notes
      .filter((n) => (folder.id === '__trash__' ? !!n.trashed : n.folderId === folder.id))
      .sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh'));
    const hasKids = children.length + ownNotes.length > 0;
    const isTrash = folder.id === '__trash__';
    const div = document.createElement('div');
    div.className = 'folder-item' + (!navDimmed && state.view.type === 'folder' && state.view.id === folder.id ? ' active' : '');
    div.style.paddingLeft = 10 + depth * 16 + 'px';
    div.innerHTML = `
      <span class="folder-toggle${hasKids ? '' : ' empty'}" data-act="toggle" title="${collapsed ? '展开目录' : '收起目录'}">${hasKids && !collapsed ? '▾' : '▸'}</span>
      <span class="folder-name">${escapeHtml(folder.name)}</span>
      ${isTrash ? '' : `<span class="folder-actions">
        <button class="icon-btn" data-act="add" title="在该目录下新建笔记">${icoSvg('add', 12)}</button>
        <button class="icon-btn" data-act="rename" title="重命名">${icoSvg('edit', 12)}</button>
        <button class="icon-btn" data-act="del" title="删除">${icoSvg('close', 12)}</button>
      </span>`}
      <span class="nav-count">${count}</span>`;
    // 右键菜单：普通目录提取知识图谱；垃圾桶只提供「清空垃圾桶」
    div.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (folder.id === '__trash__') {
        const n = state.notes.filter((x) => !!x.trashed).length;
        openCtxMenu(e.clientX, e.clientY, [{ label: `清空垃圾桶（${n} 篇，不可恢复）`, action: emptyTrash }]);
        return;
      }
      const notes = folderDescendantNotes(folder.id);
      openCtxMenu(e.clientX, e.clientY, [
        { label: `提取知识图谱（${notes.length} 篇笔记）`, action: () => notesToGraph(notes, '目录·' + folder.name) },
      ]);
    });
    div.addEventListener('click', (e) => {
      // e.target 可能命中按钮内部的 <svg> 子节点（无 dataset），向上找最近带 data-act 的祖先
      const actEl = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
      const act = actEl ? actEl.dataset.act : (e.target.dataset && e.target.dataset.act);
      if (act === 'toggle') {
        e.stopPropagation();
        state.folderCollapsed[folder.id] = !collapsed;
        try { localStorage.setItem('kb.folderCollapsed', JSON.stringify(state.folderCollapsed)); } catch (_) {}
        // 用户手动调整过展开状态后，持久化自定义标记，后续不再套用默认策略
        try { localStorage.setItem('kb.folderCollapsedCustom', '1'); } catch (_) {}
        renderSidebar();
        return;
      }
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
        // 删除整个目录树：收集全部后代子目录，其下所有笔记移至"垃圾桶"（trash/），目录整体移除
        const descIds = new Set([folder.id]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const f of state.folders) {
            if (f.parentId && descIds.has(f.parentId) && !descIds.has(f.id)) { descIds.add(f.id); grew = true; }
          }
        }
        const noteCount = state.notes.filter((n) => descIds.has(n.folderId)).length;
        const subCount = descIds.size - 1;
        if (!confirm(`删除目录"${folder.name}"？${subCount ? `含 ${subCount} 个子目录，` : ''}目录与目录下共 ${noteCount} 篇笔记将移至"垃圾桶"，可在垃圾桶内右键还原目录。`)) return;
        // 目录本身也进垃圾桶：快照整条目录链（含父子关系），供垃圾桶内分组展示与整目录还原
        const byId = new Map(state.folders.map((f) => [f.id, f]));
        const snap = [];
        const pushSnap = (fid) => {
          const f = byId.get(fid);
          if (!f) return;
          snap.push({ id: f.id, name: f.name, parentId: f.parentId && descIds.has(f.parentId) ? f.parentId : null });
          childrenOf(fid).forEach((c) => pushSnap(c.id));
        };
        pushSnap(folder.id);
        state.trashedFolders = (state.trashedFolders || []).concat(snap);
        // 记录各笔记移入垃圾桶前的目录相对路径，供「还原到原来的位置」使用
        // （目录记录随后被移除，须先按当前目录树计算）
        state.notes.forEach((n) => {
          if (descIds.has(n.folderId)) {
            n.trashFrom = folderRelPath(n.folderId);
            n.folderId = null;
            n.trashed = true;
          }
        });
        state.folders = state.folders.filter((f) => !descIds.has(f.id));
        if (state.view.type === 'folder' && descIds.has(state.view.id)) state.view = { type: 'all', id: null, query: '' };
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
    if (!collapsed) {
      children.forEach((c) => renderFolder(c, depth + 1));
      // 垃圾桶内：先渲染被删目录节点（含其子目录与笔记，可整目录还原），再渲染散落的被删笔记
      if (isTrash) {
        renderTrashedFolderNodes(tree, depth);
      }
      // 直属笔记叶子节点：目录树此前只展示子目录，导入目录下的笔记文件不可见（如「技术风险」）
      // 垃圾桶下：已被某个被删目录收纳的笔记不再重复平铺
      const visibleOwn = isTrash ? ownNotes.filter((n) => !trashGroupRootOf(n)) : ownNotes;
      visibleOwn.forEach((n) => {
        const nd = document.createElement('div');
        nd.className = 'folder-item note-leaf' + (n.id === state.selectedNoteId ? ' active' : '');
        nd.style.paddingLeft = 10 + (depth + 1) * 16 + 'px';
        nd.innerHTML = `<span class="folder-toggle">${icoSvg('notes', 12)}</span><span class="folder-name" title="${escapeHtml(n.title || '无标题笔记')}">${escapeHtml(n.title || '无标题笔记')}</span>`;
        nd.addEventListener('click', () => selectNote(n.id));
        // 垃圾桶叶节点右键：还原到原来的位置
        if (folder.id === '__trash__') {
          nd.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openCtxMenu(e.clientX, e.clientY, [{ label: '还原到原来的位置', action: () => restoreNoteFromTrash(n) }]);
          });
        }
        tree.appendChild(nd);
      });
    }
  };
  // 默认展开策略：一级、二级目录收起，三级及更深层级全部展开；用户手动调整过后以持久化状态为准
  let customCollapsed = false;
  try { customCollapsed = localStorage.getItem('kb.folderCollapsedCustom') === '1'; } catch (_) {}
  if (!customCollapsed) {
    const depthOf = (f) => {
      let d = 0, cur = f;
      while (cur && cur.parentId) { d++; cur = state.folders.find((x) => x.id === cur.parentId); }
      return d;
    };
    const def = {};
    state.folders.forEach((f) => { def[f.id] = depthOf(f) <= 1; });
    state.folderCollapsed = def;
  }
  // 垃圾桶固定渲染在目录树最下方：从 roots 中抽出，最后单独渲染
  const trashRoot = roots.find((f) => f.id === '__trash__');
  const normalRoots = roots.filter((f) => f.id !== '__trash__');
  normalRoots.forEach((f) => renderFolder(f, 0));
  if (trashRoot) renderFolder(trashRoot, 0);

  if (state.folders.length === 0) {
    tree.innerHTML = '<div style="padding:4px 10px;font-size:12px;color:#b0b6bf">暂无目录，点上方 + 创建</div>';
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
}

// ================= 设置 =================
// EDITOR_MODES / NUM_SETTING_FIELDS / PROVIDER_PRESETS / DEFAULT_PROVIDER 统一定义于 renderer/constants.js

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
  // 模型列表变化时同步刷新 MinerU 模型选择器
  renderMineruModelOptions();
}

// entry: modelEntryList() 的一项（primary 为 true 时为默认模型）
function modelCard(entry, primaryFields) {
  const isPrimary = !!entry.primary;
  const key = isPrimary ? '__primary__' : entry.id;
  const open = !!modelExpanded[key];
  const needKey = providerNeedsKey(entry.provider);
  const keyTag = entry.apiKey
    ? '<span class="model-badge ok" data-keybadge>已配 Key</span>'
    : (needKey ? '<span class="model-badge warn" data-keybadge title="该 provider 通常需要 API Key">无 Key</span>' : '<span class="model-badge" data-keybadge>无需 Key</span>');
  const wrap = document.createElement('div');
  wrap.className = 'mcp-card' + (open ? ' open' : '');
  wrap.innerHTML =
    '<div class="mcp-card-head">'
    + '<span class="mcp-caret">▾</span>'
    + '<span class="model-badge alt" data-provbadge>' + escapeHtml(providerLabel(entry.provider)) + '</span>'
    + '<span class="mcp-test-name" data-modelname>' + escapeHtml(entry.model || '(未填模型名)') + '</span>'
    + (isPrimary ? '<span class="model-badge cur">默认</span>' : '')
    + keyTag
    + '<span class="mcp-test-target" data-baseurl title="' + escapeHtml(entry.baseUrl || '') + '">' + escapeHtml(entry.baseUrl || '') + '</span>'
    + '<span class="mcp-head-acts">'
    + (isPrimary
      ? '<button type="button" class="skill-act" data-edit title="展开卡片编辑配置（底部「保存修改」写入）">编辑</button>'
        + '<button type="button" class="skill-act danger" data-del title="删除后由下一个模型接任默认">删除</button>'
      : '<button type="button" class="skill-act" data-edit title="展开卡片编辑配置（字段改动即存）">编辑</button>'
        + '<button type="button" class="skill-act" data-primary title="设为默认模型（与当前默认互换）">设为默认</button>'
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

  // 卡头「编辑」：展开/收起卡片进入内联编辑（保存由表单底部「保存修改」/字段即存负责）
  wrap.querySelector('[data-edit]').addEventListener('click', (e) => {
    e.stopPropagation();
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
      if (!rest.length) { toast('至少需保留一个模型。先「添加模型」再删除当前默认', 4000); return; }
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
    + '<p class="modal-tip" data-fetchtip></p>'
    + '<div class="model-save-row">'
    + '<button type="button" class="btn btn-primary" data-saveform>保存修改</button>'
    + '<span class="modal-tip">修改上方配置后点「保存修改」写入，保存后立即生效</span>'
    + '</div>';

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
  // 就地刷新卡头徽章：字段改动后不整卡重建。
  // 桌面端原生 select 打开期间若 renderModelList() 重建 DOM 会销毁该 select，
  // 表现为「下拉点不动/选了没反应」，因此这里只更新卡头对应节点
  const syncCardHead = () => {
    const card = box.closest('.mcp-card');
    if (!card) return;
    const e = extraModels().find((x) => x.id === m.id) || {};
    const p = normalizeProvider(e.provider);
    const provBadge = card.querySelector('[data-provbadge]');
    if (provBadge) provBadge.textContent = providerLabel(p);
    const nameBadge = card.querySelector('[data-modelname]');
    if (nameBadge) nameBadge.textContent = (e.model || '').trim() || '(未填模型名)';
    const urlBadge = card.querySelector('[data-baseurl]');
    if (urlBadge) { urlBadge.textContent = e.baseUrl || ''; urlBadge.title = e.baseUrl || ''; }
    const keyBadge = card.querySelector('[data-keybadge]');
    if (keyBadge) {
      if (e.apiKey) { keyBadge.className = 'model-badge ok'; keyBadge.textContent = '已配 Key'; keyBadge.removeAttribute('title'); }
      else if (providerNeedsKey(p)) { keyBadge.className = 'model-badge warn'; keyBadge.textContent = '无 Key'; keyBadge.title = '该 provider 通常需要 API Key'; }
      else { keyBadge.className = 'model-badge'; keyBadge.textContent = '无需 Key'; keyBadge.removeAttribute('title'); }
    }
  };
  prov.addEventListener('change', () => {
    const preset = PROVIDER_PRESETS[prov.value] || PROVIDER_PRESETS[DEFAULT_PROVIDER];
    if (preset.url) url.value = preset.url;
    if (!providerNeedsKey(prov.value)) keyEl.value = '';
    syncKeyTip();
    clearModelOptions(ddId);
    save({ provider: prov.value, baseUrl: url.value.trim(), apiKey: keyEl.value.trim() });
    syncCardHead();
  });
  url.addEventListener('change', () => { save({ baseUrl: url.value.trim() }); syncCardHead(); });
  keyEl.addEventListener('change', () => { save({ apiKey: keyEl.value.trim() }); syncCardHead(); });
  nameEl.addEventListener('change', () => { save({ model: nameEl.value.trim() }); syncCardHead(); });
  // 显式「保存修改」：把当前表单全部字段一次写回（与失焦自动保存互为兜底）
  box.querySelector('[data-saveform]').addEventListener('click', () => {
    save({
      provider: normalizeProvider(prov.value),
      baseUrl: url.value.trim(),
      apiKey: keyEl.value.trim(),
      model: nameEl.value.trim(),
    }, { rerender: true });
    toast('已保存模型修改', 2500);
  });

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
    if (n && !nameEl.value.trim()) { nameEl.value = res.models[0]; save({ model: res.models[0] }); syncCardHead(); }
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
          save({ model: name });
          syncCardHead();
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

// 展开状态（按服务器名）：默认全部收起，与多级列表的默认折叠约定一致
const mcpExpanded = {};

// 每个 MCP 服务器一张可折叠卡片：卡头常驻（名称/类型/状态），展开后含其只读配置与独立测试
function renderMcpCards() {
  const box = $('mcp-list');
  if (!box) return;
  box.innerHTML = '';
  const list = (state.settings && state.settings.mcpServers) || [];
  if (!list.length) {
    box.innerHTML = '<div class="mcp-empty">暂无 MCP 服务器。点上方「添加」或「Configure MCP Servers」写入配置</div>';
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
    + '<select class="mcp-tool-sel" title="测试时实际调用哪个工具。自动选择 = 填了测试内容时自动挑一个搜索类工具；首次测试后可在此显式指定（多工具服务建议显式指定，避免猜错）"><option value="">工具：自动选择</option></select>'
    + '<input type="text" class="mcp-args" placeholder="参数 JSON（可选），例：{&quot;city&quot;:&quot;西安&quot;}" />'
    + '</div>'
    + '<div class="mcp-tool-hint" hidden></div>'
    + '<div class="mcp-tool-explain">「工具」下拉：测试时实际调用该服务器的哪个工具。默认「自动选择」——填了测试内容时自动挑一个搜索类工具并猜测入参；首次测试后下拉会列出该服务器的全部工具，可显式指定（多工具服务建议指定，避免猜错工具或参数）。选中工具后会显示其必填/全部参数，并预填参数骨架。</div>'
    + '<div class="mcp-test-bar">'
    + '<input type="text" class="mcp-test-query" placeholder="测试内容（可选），留空只测连接与列工具" />'
    + '<button type="button" class="btn btn-ghost mcp-test-btn" data-test>' + icoSvg('search', 12) + '测试</button>'
    + '<button type="button" class="btn btn-ghost mcp-copy-btn" data-copy hidden>⎘ 复制</button>'
    + '</div>'
    + '<pre class="mcp-test-out" hidden></pre>'
    + '</div>';
  // 该服务器自身的配置片段（仍为只读 JSON，编辑一律走 JSON 弹窗）
  wrap.querySelector('.mcp-json-view').textContent = JSON.stringify(mcpArrayToObject([m], true), null, 2);

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
  for (const c of String(name || 'skill')) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
function renderSkillGrid() {
  const box = $('skill-grid'); if (!box) return;
  const q = (($('skill-search') && $('skill-search').value) || '').trim().toLowerCase();
  box.innerHTML = '';
  const list = (state.settings.skills || []).filter((k) => !q || (k.name || '').toLowerCase().includes(q) || (k.desc || k.description || '').toLowerCase().includes(q));
  if (!list.length) { box.innerHTML = '<div style="grid-column:1/-1;color:var(--text-sub);font-size:12.5px;padding:12px 0">暂无技能，点「创建技能」选择含 SKILL.md 的目录</div>'; return; }
  list.forEach((k) => {
    const card = document.createElement('div');
    card.className = 'skill-card' + (k.enabled ? '' : ' off');
    const dirTag = k.dir ? String(k.dir).split('/').filter(Boolean).slice(-1)[0] : '';
    const hue = skillHue(k.name);
    card.innerHTML =
      '<div class="skill-card-head"><span class="skill-card-ico" style="background:hsl(' + hue + ' 70% 94%);color:hsl(' + hue + ' 60% 42%)">' + icoSvg('skill', 14) + '</span>' +
      '<span class="skill-card-name" title="' + escapeHtml(k.name || '') + '">' + escapeHtml(k.name || '') + '</span>' +
      '<label class="skill-switch" title="' + (k.enabled ? '已启用，点击停用' : '已停用，点击启用') + '"><input type="checkbox" data-en ' + (k.enabled ? 'checked' : '') + '><span class="skill-switch-slider"></span></label></div>' +
      '<div class="skill-card-desc">' + escapeHtml(k.desc || k.description || '（无描述）') + '</div>' +
      '<div class="skill-card-foot">' + (dirTag ? '<span class="skill-card-tag" title="' + escapeHtml(k.dir || '') + '">' + icoSvg('folder-open', 12) + escapeHtml(dirTag) + '</span>' : '<span class="skill-card-tag skill-card-tag-empty">未关联目录</span>') +
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
// 编辑弹窗「📂 打开」：用系统文件管理器打开技能目录（Web 模式由服务端本机打开）
async function openSkillEditDir() {
  const dir = ($('skill-edit-dir').value || '').trim();
  if (!dir) { toast('该技能未关联目录', 2500); return; }
  try {
    const r = await window.kb.openPath({ path: dir });
    if (r && !r.ok) toast('无法打开目录：' + (r.error || dir), 3000);
  } catch (err) {
    toast('无法打开目录：' + (err.message || err), 3000);
  }
}
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
// ---------- 技能在线安装：兼容 npx skills add / skills.sh / GitHub 仓库 ----------
// DEFAULT_SKILL_INSTALL_CMD 定义于 renderer/constants.js
let skillInstalling = false;
// 安装完成后锁定弹窗（安装按钮禁用、来源不可改），重新打开弹窗才允许再次安装
let skillInstallDone = false;
const skillInstallBtnInitHTML = (() => { const b = $('btn-skill-install-go'); return b ? b.innerHTML : ''; })();
function openSkillInstall() {
  const logBox = $('skill-install-log');
  logBox.hidden = true; logBox.textContent = '';
  $('skill-install-status').textContent = '';
  // 重置完成态：重新打开弹窗后可编辑来源并再次安装
  skillInstallDone = false;
  const goBtn = $('btn-skill-install-go');
  goBtn.disabled = false;
  if (skillInstallBtnInitHTML) goBtn.innerHTML = skillInstallBtnInitHTML;
  $('skill-install-input').disabled = false;
  // 默认安装命令：预填上次保存的修改值（允许直接修改，安装后自动记住）
  const input = $('skill-install-input');
  input.value = (state.settings && state.settings.skillInstallCmd) || input.value || DEFAULT_SKILL_INSTALL_CMD;
  $('skill-install-modal').hidden = false;
  setTimeout(() => { const i = $('skill-install-input'); if (i && !i.disabled) { i.focus(); i.select(); } }, 50);
}
function appendSkillInstallLog(line) {
  const box = $('skill-install-log');
  if (!box) return;
  box.hidden = false;
  const text = String(line || '');
  // 进度行（⏳）原地刷新，避免刷屏
  if (text.startsWith('⏳')) {
    let el = box.querySelector('[data-progress]');
    if (!el) {
      el = document.createElement('div');
      el.setAttribute('data-progress', '1');
      box.appendChild(el);
    }
    el.textContent = text;
  } else {
    const div = document.createElement('div');
    div.textContent = text;
    box.appendChild(div);
  }
  box.scrollTop = box.scrollHeight;
}
async function runSkillInstall() {
  if (skillInstalling) return;
  const input = ($('skill-install-input').value || '').trim();
  if (!input) { toast('请输入安装来源（npx 命令 / skills.sh 链接 / GitHub 仓库 / owner/repo）', 3500); return; }
  // 记住修改后的默认安装命令，下次打开弹窗自动预填
  state.settings = state.settings || {};
  if (state.settings.skillInstallCmd !== input) { state.settings.skillInstallCmd = input; persist(); }
  skillInstalling = true;
  const btn = $('btn-skill-install-go');
  const status = $('skill-install-status');
  const oldText = btn.textContent;
  btn.disabled = true; btn.textContent = '安装中…';
  const logBox = $('skill-install-log');
  logBox.textContent = ''; logBox.hidden = false;
  status.textContent = '⏳ 下载并安装中…';
  // 状态栏显示已耗时，下载期间有持续反馈
  const t0 = Date.now();
  const tick = setInterval(() => {
    if (status.textContent.startsWith('⏳')) status.textContent = `⏳ 下载并安装中… 已耗时 ${Math.round((Date.now() - t0) / 1000)}s`;
  }, 1000);
  const off = window.kb.onSkillInstallLog ? window.kb.onSkillInstallLog((d) => appendSkillInstallLog((d && d.line) || '')) : null;
  try {
    const res = await window.kb.skillInstall({ input });
    if (res && res.ok) {
      // 与「＋ 创建技能」一致：以目录引用方式登记到设置.skills
      state.settings.skills = state.settings.skills || [];
      const have = new Set(state.settings.skills.map((k) => k.name));
      let added = 0;
      for (const it of res.installed || []) {
        if (have.has(it.name)) { appendSkillInstallLog('⏭ 已存在同名技能，跳过登记：' + it.name); continue; }
        state.settings.skills.push({ name: it.name, dir: it.dir, desc: it.description || '', description: it.description || '', instructions: '', enabled: true });
        have.add(it.name); added++;
      }
      persist(); renderExtEditors(); refreshAllExtMenus();
      status.textContent = `✅ 完成：新装 ${added} 个技能`;
      // 安装完毕：禁用安装按钮与来源输入，防止重复点击；重新打开弹窗才恢复
      skillInstallDone = true;
      btn.disabled = true;
      btn.innerHTML = '✅ 已安装';
      $('skill-install-input').disabled = true;
      toast(added ? `已安装 ${added} 个技能` : '技能均已存在，未重复登记', 3000);
    } else {
      status.textContent = '❌ ' + ((res && res.error) || '安装失败');
      toast('技能安装失败：' + ((res && res.error) || '未知错误'), 4000);
    }
  } catch (err) {
    status.textContent = '❌ ' + (err.message || err);
    toast('技能安装异常：' + (err.message || err), 4000);
  } finally {
    clearInterval(tick);
    if (off) off();
    // 成功安装后保持禁用；失败/异常才恢复按钮允许重试
    if (!skillInstallDone) {
      btn.disabled = false;
      if (skillInstallBtnInitHTML) btn.innerHTML = skillInstallBtnInitHTML; else btn.textContent = oldText;
    }
    skillInstalling = false;
  }
}
// ---------- MCP JSON 配置（Cline 风格） ----------
function mcpArrayToObject(arr, keepRaw) {
  const o = {};
  (arr || []).forEach((m) => {
    if (!m || !m.name) return;
    // keepRaw：卡片/编辑弹窗回显用户保存时的原始 JSON，不做归一化改写
    if (keepRaw && m.raw && typeof m.raw === 'object') { o[m.name] = m.raw; return; }
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
      // ${XXX} 占位符：标记 useModelKey，同时保留 env.Authorization 原文，
      // 调用端按「进程环境变量 → 模型 Key」解析；展示仍回显原文
      if (/\$\{/.test(auth)) { e.useModelKey = true; e.env = Object.assign({}, e.env, { Authorization: auth }); }
      else e.env = Object.assign({}, e.env, { Authorization: auth });
    } else if (v.useModelKey) e.useModelKey = true;
    if (v.description) e.desc = String(v.description);
    // 原样保留用户输入的 JSON 对象：展示/再编辑时优先回显原文，连接仍用归一化字段
    e.raw = v;
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
  // 生图/文件类工具返回的图片链接，渲染为可点击预览（而不是裸 URL 文本）
  if (wrap) wrap.querySelectorAll('.img-preview').forEach((x) => x.remove());
  const pv = buildImagePreview(extractImageUrls(ok ? (res && res.result) || '' : ''), '🖼 返回的图片');
  if (pv) out.insertAdjacentElement('afterend', pv);
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
  $('mcp-json-text').value = JSON.stringify(mcpArrayToObject([one], true), null, 2);
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
    window.kb.dataRoot().then((p) => { state.currentRoot = p; $('set-dataroot').value = p; });
    const fillNum = (id, v) => { $(id).value = Number.isFinite(v) ? String(v) : ''; };
    for (const [key, [id]] of Object.entries(NUM_SETTING_FIELDS)) fillNum(id, s[key]);
    $('set-minerucmd').value = typeof s.mineruConvertCmd === 'string' ? s.mineruConvertCmd : '';
    // 解析方式：显式设置优先；旧数据无该键时按是否已配置命令推断
    const mineruMode = s.mineruMode === 'mineru' || s.mineruMode === 'builtin'
      ? s.mineruMode
      : (s.mineruConvertCmd ? 'mineru' : 'builtin');
    $('set-minerumode-builtin').checked = mineruMode !== 'mineru';
    $('set-minerumode-mineru').checked = mineruMode === 'mineru';
    // 技能解析开关：未显式保存过的旧数据按默认开启（与主进程 skillParseReady 口径一致）
    $('set-skillparse').checked = s.skillParse !== false;
    applyMineruModeUI();
    renderMineruModelOptions();
    $('set-editormode').value = EDITOR_MODES.includes(s.defaultEditorMode) ? s.defaultEditorMode : 'preview';
    $('set-aiassist').value = s.aiAssistPrompt || '';
    // 知识图谱：全局默认本体体系（独立异步，不阻塞其余字段填充）
    window.kb.graphProfiles().then((profiles) => {
      const sel = $('set-ontologyprofile');
      if (!sel) return;
      sel.innerHTML = (profiles || []).map((p) => `<option value="${p.id}">${p.name}${p.owl ? '（OWL）' : ''}</option>`).join('');
      sel.value = s.ontologyProfile || 'bfo-lite';
      const showDesc = () => {
        const p = (profiles || []).find((x) => x.id === sel.value);
        $('set-ontologyprofile-desc').textContent = p ? `${p.name} — ${p.desc || ''}` : '';
      };
      sel.onchange = () => { showDesc(); saveSettings(); };
      showDesc();
    }).catch(() => {});
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

// 解析方式切换的即时视觉反馈：选 MinerU 时高亮命令输入区，选内置时弱化
function applyMineruModeUI() {
  const isMineru = $('set-minerumode-mineru').checked;
  const cmd = $('set-minerucmd');
  const btn = $('btn-test-mineru');
  const card = $('mineru-config-card');
  if (cmd) cmd.closest('.setting-row').classList.toggle('mineru-active', isMineru);
  if (btn) btn.disabled = false;
  if (card) card.style.display = isMineru ? '' : 'none';
  // MinerU 专属输出（安装提示/测试结论/解析日志）只在 MinerU 模式下展示，
  // 避免切回内置解析后页面仍残留大段 pip 安装日志
  for (const id of ['mineru-install-tip', 'mineru-result', 'mineru-test-log', 'mineru-test-fileinfo']) {
    const el = $(id);
    if (el) el.hidden = !isMineru;
  }
  if (!isMineru) updateOpenTestDirBtn(); // 内置模式下隐藏「打开目录/产物路径」行
}

// MinerU 视觉模型选择器：列出「模型配置」中的全部模型（主模型 + 更多模型）。
// 当前生效项按 settings.mineruVlmModel + mineruOllamaUrl 匹配选中；
// 未匹配到（如还没应用过）时不选中，提示用户显式应用
function renderMineruModelOptions() {
  const sel = $('set-mineru-model');
  if (!sel) return;
  const s = state.settings || {};
  const curModel = String(s.mineruVlmModel || '').trim();
  const curUrl = String(s.mineruOllamaUrl || '').trim().replace(/\/+$/, '');
  const list = modelEntryList();
  sel.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = '（未选择：从下方列表选择并应用）';
  sel.appendChild(ph);
  list.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.id;
    const label = providerLabel(m.provider);
    opt.textContent = `${label} · ${m.model || '（未填模型名）'}`;
    // 匹配规则：模型名相同，且端点（剥 /v1 后）相同或该条目未填 baseUrl
    const mUrl = String(m.baseUrl || '').trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
    if (curModel && m.model === curModel && (!curUrl || !mUrl || mUrl === curUrl)) opt.selected = true;
    sel.appendChild(opt);
  });
  if (!curModel) sel.value = '';
}

// 应用所选模型到 MinerU：主进程重写包装脚本（模型名/端点/Key），成功后回写设置并持久化。
// 不自动切换解析方式（用户可能只想换模型），但会提示当前为内置解析
async function applyMineruModelSelection() {
  const sel = $('set-mineru-model');
  if (!sel) return;
  const id = sel.value;
  if (!id) { toast('请先选择一个模型', 3000); return; }
  const entry = findModelEntry(id);
  if (!entry) { toast('所选模型不存在', 3000); return; }
  if (!entry.model || !entry.baseUrl) { toast('该模型缺少模型名或 Base URL，请先在「模型配置」补全', 4000); return; }
  const btn = $('btn-mineru-apply-model');
  const oldText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '应用中…'; }
  try {
    const res = await window.kb.mineruApplyModel({ settings: state.settings, entry });
    if (res && res.ok) {
      state.settings.mineruVlmModel = res.vlmModel;
      state.settings.mineruOllamaUrl = res.ollamaUrl;
      persist();
      markSettingsSaved();
      renderMineruModelOptions();
      toast(`MinerU 已切换模型：${res.vlmModel}`, 3000);
      if (!$('set-minerumode-mineru').checked) toast('提示：当前解析方式仍为「内置解析」，如需 MinerU 解析 PDF 请切换上方开关', 5000);
    } else {
      toast('应用失败：' + ((res && res.error) || '未知错误'), 5000);
    }
  } catch (err) {
    toast('应用异常：' + (err.message || err), 5000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = oldText; }
  }
}

// MinerU 配置测试：用内置样本或上传的 PDF 实跑一次转换，验证命令/依赖/模型链路；
// 中间解析日志经 mineru:test-log 流式推送实时展示；产物保存在 <数据根>/test/<日期-时间>/
let mineruTestPdf = null; // { base64, name, size } 已上传的测试文件（可选）
let mineruTestOutDir = null; // 最近一次测试的产物目录（📂 打开目录按钮用）

function pickMineruTestPdf() {
  $('mineru-test-file').click();
}

function onMineruTestFilePicked() {
  const input = $('mineru-test-file');
  const info = $('mineru-test-fileinfo');
  const f = input.files && input.files[0];
  if (!f) return;
  if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') {
    toast('仅支持上传 PDF 文件', 3000);
    input.value = '';
    return;
  }
  if (f.size > 50 * 1024 * 1024) {
    toast('文件过大（超过 50MB），请换小一点的', 3000);
    input.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    mineruTestPdf = { base64: String(reader.result).split(',')[1] || '', name: f.name, size: f.size };
    info.hidden = false;
    info.textContent = `已上传：${f.name}（${(f.size / 1024).toFixed(1)} KB），「测试配置」将使用该文件`;
  };
  reader.readAsDataURL(f);
}

// 普通日志追加新行；进度行覆盖上一条进度行（tqdm 高频刷新不再堆成刷屏墙，接近终端原位更新效果）。
// replace 标记来自主进程对 \r 的切分；兼容未带标记的旧进程，退化为 tqdm 进度模式识别；
// 旧主进程只按 \n 切行，单条事件可能含多段 \r 进度碎片，这里再切一次保证展示干净
const MINERU_PROGRESS_RE = /\d+%\|.*\|\s*\d+\/\d+\s*\[/;
function appendMineruTestLog(line, replace) {
  const box = $('mineru-test-log');
  if (!box) return;
  box.hidden = false;
  const segs = String(line || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\r').map((s) => s.trim()).filter(Boolean);
  if (!segs.length) return;
  const pushLine = (text, rep) => {
    let last = box.lastElementChild;
    if (rep || MINERU_PROGRESS_RE.test(text)) {
      if (!last || !last.classList.contains('mineru-progress')) {
        last = document.createElement('div');
        last.className = 'mineru-progress';
        box.appendChild(last);
      }
      last.textContent = text;
    } else {
      const div = document.createElement('div');
      div.textContent = text;
      box.appendChild(div);
    }
  };
  segs.forEach((seg, i) => pushLine(seg, i < segs.length - 1 ? true : !!replace));
  box.scrollTop = box.scrollHeight;
}

// 📂 打开目录：用系统文件管理器直接打开最近一次测试的产物目录
// 桌面端走 shell.openPath；Web 模式由服务端在本机执行 open/explorer/xdg-open
function updateOpenTestDirBtn() {
  const b = $('btn-open-testdir');
  const p = $('mineru-test-outdir');
  const row = p && p.parentElement;
  if (b) b.hidden = !mineruTestOutDir;
  if (p) {
    p.hidden = !mineruTestOutDir;
    p.textContent = mineruTestOutDir || '';
    p.title = mineruTestOutDir || ''; // 路径过长被省略号截断时，悬停可看全
  }
  if (row && row.classList.contains('mineru-result-row')) row.hidden = !mineruTestOutDir;
}

async function openMineruTestDir() {
  if (!mineruTestOutDir) return;
  try {
    const r = await window.kb.openPath({ path: mineruTestOutDir });
    if (!r || !r.ok) toast('无法打开目录：' + ((r && r.error) || mineruTestOutDir), 5000);
  } catch (err) {
    toast('无法打开目录：' + (err.message || err), 3000);
  }
}

// 清空垃圾桶：永久删除全部被删除（trashed）的笔记与被删目录快照（磁盘文件由 persist→saveStore 同步清理）
function emptyTrash() {
  const count = state.notes.filter((n) => !!n.trashed).length;
  const folderCount = (state.trashedFolders || []).length;
  if (!count && !folderCount) { toast('垃圾桶已经是空的', 2500); return; }
  if (!confirm(`清空垃圾桶？${count} 篇笔记${folderCount ? `与 ${folderCount} 个已删目录` : ''}将被永久删除，不可恢复。`)) return;
  state.notes = state.notes.filter((n) => !n.trashed);
  state.trashedFolders = [];
  if (state.selectedNoteId && !state.notes.some((n) => n.id === state.selectedNoteId)) state.selectedNoteId = null;
  persist();
  renderAll();
  toast(`已清空垃圾桶，删除 ${count} 篇笔记`, 3000);
}

// 一键自动安装 MinerU：无环境时在 <安装目录>/plugins/mineru/ 下建 venv、装 mineru、生成包装脚本，
// 完成后自动回填「文档转换命令」并切到 MinerU 解析，一步完成配置；日志复用测试日志展示组件
let mineruInstalling = false;
async function installMineruAuto() {
  if (mineruInstalling) return;
  if (!window.kb.mineruInstall) { toast('当前环境不支持一键安装', 3000); return; }
  if (!confirm('将在 Synapse 安装目录下新建 plugins/mineru 目录，自动创建 Python 虚拟环境并安装 mineru（依赖较多，可能 5–20 分钟）。安装完成后自动回填转换命令并切换到 MinerU 解析。继续？')) return;
  mineruInstalling = true;
  const btn = $('btn-install-mineru');
  const tip = $('mineru-install-tip');
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '安装中…';
  tip.hidden = false;
  tip.textContent = '⏳ 正在安装 MinerU 环境，日志见下方…';
  const logBox = $('mineru-test-log');
  logBox.textContent = '';
  logBox.hidden = false;
  startMineruElapsed();
  const off = window.kb.onMineruInstallLog ? window.kb.onMineruInstallLog((d) => appendMineruTestLog((d && d.line) || '', d && d.replace)) : null;
  try {
    const res = await window.kb.mineruInstall({ settings: state.settings });
    if (res && res.ok) {
      tip.textContent = `✅ 安装完成：${res.runner}。已自动回填转换命令并切换为 MinerU 解析，可点「测试配置」验证`;
      $('set-minerucmd').value = `${res.runner} -p {input} -o {output}`;
      $('set-minerumode-mineru').checked = true;
      $('set-minerumode-builtin').checked = false;
      applyMineruModeUI();
      saveSettingsFields();
      toast('MinerU 一键安装完成，配置已就绪', 4000);
    } else {
      tip.textContent = `❌ 安装失败：${(res && res.error) || '未知错误'}（日志见下方）`;
      toast('MinerU 安装失败', 3000);
    }
  } catch (err) {
    tip.textContent = `❌ 安装异常：${err.message || err}`;
    toast('MinerU 安装异常', 3000);
  } finally {
    if (off) off();
    stopMineruElapsed();
    btn.disabled = false;
    btn.textContent = oldText;
    mineruInstalling = false;
  }
}

// 测试运行期间在状态行实时显示已耗时秒数（用户要求测试时一直有时间计秒）
let mineruElapsedTimer = null;
function startMineruElapsed() {
  stopMineruElapsed();
  const status = $('mineru-test-status');
  const t0 = Date.now();
  const tick = () => { if (status) status.textContent = `⏳ 正在转换，已耗时 ${Math.floor((Date.now() - t0) / 1000)}s，中间解析日志见下方…`; };
  tick();
  mineruElapsedTimer = setInterval(tick, 500);
}
function stopMineruElapsed() {
  if (mineruElapsedTimer) { clearInterval(mineruElapsedTimer); mineruElapsedTimer = null; }
}

async function testMineruConfig() {
  const btn = $('btn-test-mineru');
  const status = $('mineru-test-status');
  const cmd = ($('set-minerucmd').value || '').trim();
  if (!cmd) { toast('请先填写文档转换命令再测试', 3000); return; }
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = '测试中…';
  const resultBox = $('mineru-result');
  if (resultBox) resultBox.hidden = false;
  const sampleReset = $('mineru-test-sample');
  if (sampleReset) { sampleReset.hidden = true; sampleReset.textContent = ''; }
  startMineruElapsed(); // 实时计秒直到测试结束（成功/失败均停表）
  const logBox = $('mineru-test-log');
  logBox.textContent = '';
  logBox.hidden = false;
  mineruTestOutDir = null;
  updateOpenTestDirBtn();
  const off = window.kb.onMineruTestLog ? window.kb.onMineruTestLog((d) => appendMineruTestLog((d && d.line) || '', d && d.replace)) : null;
  try {
    // 以当前表单值为准（未保存也可测试）
    const overrides = { mineruConvertCmd: cmd, mineruMode: 'mineru' };
    const payload = { settings: state.settings, overrides };
    if (mineruTestPdf) { payload.pdfBase64 = mineruTestPdf.base64; payload.fileName = mineruTestPdf.name; }
    const res = await window.kb.mineruTest(payload);
    const box = $('mineru-result');
    const sampleEl = $('mineru-test-sample');
    if (res && res.ok) {
      status.textContent = `✅ 测试通过：转换成功（${res.elapsedSec}s，产出 ${res.mdLength} 字符）`;
      // 样本内容独立成块展示（主进程已压缩为前 3 行、限 200 字符），不再挤进状态行
      if (sampleEl) {
        sampleEl.hidden = !res.sample;
        sampleEl.textContent = res.sample ? '样本内容：' + res.sample : '';
      }
      mineruTestOutDir = res.outDir || null;
      updateOpenTestDirBtn();
      if (box) box.hidden = false;
      toast('MinerU 配置测试通过', 3000);
    } else {
      status.textContent = `❌ 测试失败：${(res && res.error) || '未知错误'}`;
      if (sampleEl) { sampleEl.hidden = true; sampleEl.textContent = ''; }
      mineruTestOutDir = (res && res.outDir) || null;
      updateOpenTestDirBtn();
      if (box) box.hidden = false;
      toast('MinerU 配置测试失败', 3000);
    }
  } catch (err) {
    status.textContent = `❌ 测试异常：${err.message || err}`;
    const box2 = $('mineru-result');
    if (box2) box2.hidden = false;
    toast('MinerU 配置测试异常', 3000);
  } finally {
    if (off) off();
    stopMineruElapsed();
    btn.disabled = false;
    btn.textContent = oldText;
  }
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
  // 数值项：留空/非法则删除，由主进程回退默认值
  for (const [key, [id, min, max]] of Object.entries(NUM_SETTING_FIELDS)) {
    const v = readNumInput(id, min, max);
    if (v === null) delete s[key]; else s[key] = v;
  }
  // 笔记导入文件类型输入框已移除：始终使用默认名单，并清理历史保存值
  delete s.noteImportExts;
  // MinerU 解析方式与转换命令：方式决定开关语义；命令留空删除
  const mineruMode = $('set-minerumode-mineru').checked ? 'mineru' : 'builtin';
  s.mineruMode = mineruMode;
  const mineruCmd = ($('set-minerucmd').value || '').trim();
  if (!mineruCmd) delete s.mineruConvertCmd; else s.mineruConvertCmd = mineruCmd;
  // 技能解析开关：勾选即默认态，删除键（主进程按「未显式关闭」处理），仅取消勾选时落 false
  if ($('set-skillparse').checked) delete s.skillParse; else s.skillParse = false;
  const mode = $('set-editormode').value;
  if (EDITOR_MODES.includes(mode)) {
    s.defaultEditorMode = mode;
    state.editorMode = mode;
    applyEditorMode();
    updatePreview();
  }
  s.aiAssistPrompt = $('set-aiassist').value.trim();
  // 本体体系全局默认已移至「本体定义」页管理（onto-profile-sel），设置页不再读/写 ontologyProfile，避免误删
  state.settings = s;
  persist();
  markSettingsSaved();
  renderAiExt(); // 扩展（MCP/Skills）变更后即时刷新 AI 面板选择行
  if (typeof refreshSetupChecklist === 'function') refreshSetupChecklist();
}

// 自动保存反馈：不用 toast，避免频繁改动时弹窗打扰；
// 指示器位于「文档解析方式」卡片右上角，只在改动字段所属 Tab 正展示时闪现，
// 避免在别的分类页看到与当前页无关的保存提示
let autosaveTimer = null;
function markSettingsSaved() {
  const el = $('settings-autosave');
  if (!el) return;
  const ae = document.activeElement;
  const pane = ae && ae.closest ? ae.closest('.settings-pane') : null;
  if (pane && pane.hidden) return;
  el.textContent = '✓ 已自动保存';
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => { el.textContent = ''; }, 2000);
}

// 生成图谱前的「已生成过则确认重新生成」守卫
function confirmRegen(kind) {
  const generated = ((state.graph && state.graph.nodes) || []).length > 0;
  if (!generated) return true;
  return confirm('知识图谱已生成过，是否重新生成？（将更新现有图谱）');
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

// 主内容区专题页（设置/作业/图谱/模版/原始文件）统一让位，避免切换导航时旧页残留
function hideMainViews() {
  ['settings-view', 'jobs-view', 'graph-view', 'tpl-view', 'tpl-editor-view', 'raw-view', 'prompts-view', 'prompt-editor-view', 'ai-view', 'docs-view'].forEach((id) => { $(id).hidden = true; });
}

// 设置页/任一主框架专题页打开或用户主动收起时，笔记列表与其分隔条让位（专题页全屏）
function syncNoteListVisibility() {
  const mainOpen = ['ai-view', 'jobs-view', 'graph-view', 'raw-view', 'tpl-view', 'tpl-editor-view', 'prompts-view', 'settings-view', 'docs-view'].some((id) => !$(id).hidden);
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

