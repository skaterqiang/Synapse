// 渲染进程·Wiki 模块：Wiki 列表/阅读器、吸收、体检、领域模版、原始文件管理
const wikiListExpanded = { nav: true }; // 导航默认展开；领域/类型分组默认收起
const rawTreeCollapsed = {}; // 原始文件目录树折叠状态（会话内）

// 中间列表区展示 LLM Wiki 全部页面：第一级按领域（领域模版）分组，领域内再按 OKF 类型分组，点击打开内容
function renderWikiList() {
  const pages = state.wiki.pages || [];
  $('note-list-title').textContent = 'LLM Wiki';
  $('note-list-count').textContent = pages.length ? `${pages.length} 页` : '';
  const container = $('note-list');
  container.innerHTML = '';
  if (!state.wiki.exists) {
    container.innerHTML = '<div class="list-empty">未找到 Wiki（AGENTS.md）<br>可在设置中指定 Wiki 根目录</div>';
    return;
  }
  const labels = { '': '导航', concepts: '概念 Concepts', sources: '来源 Sources', topics: '主题 Topics', entities: '实体 Entities' };
  // 新路径语义：wiki/<领域>/<类型>/xxx.md；index.md/log.md 为导航
  const segsOf = (p) => p.path.split('/');
  const isNav = (p) => !p.path.includes('/');
  // 领域名称映射：模版 ID → 中文名；无 domain 的存量页归入通用
  const tplName = (id) => {
    const t = (state.templates || []).find((x) => x.id === id);
    return t ? t.name : id;
  };
  const domainOf = (p) => p.domain || segsOf(p)[0] || 'general';
  const typeOf = (p) => {
    const s = segsOf(p);
    if (s.length >= 3) return s[1];
    return s.length === 2 && labels[s[0]] ? s[0] : ''; // 兼容未迁移的 <类型>/xxx.md
  };

  // 导航置顶展示，不受领域分组影响
  const renderCards = (list, indent) => {
    for (const p of list) {
      const item = document.createElement('div');
      item.className = 'wiki-tree-item' + (state.wikiPage === p.path ? ' active' : '');
      item.style.paddingLeft = indent + 'px';
      item.title = p.path; // 悬浮显示路径，行内只留标题
      const icon = isNav(p) ? (p.path === 'index.md' ? '🗺️' : '🕒') : typeIcon(p.type);
      item.innerHTML = `<span class="wiki-ico">${icon}</span><span class="wiki-title">${escapeHtml(p.title || p.path)}</span>`;
      item.addEventListener('click', () => openWikiPage(p.path));
      container.appendChild(item);
    }
  };
  const addToggle = (key, html, cls) => {
    const collapsed = !wikiListExpanded[key];
    const g = document.createElement('div');
    g.className = cls + ' wiki-group-toggle';
    g.innerHTML = `<span class="chevron${collapsed ? ' collapsed' : ''}">▾</span> ${html}`;
    g.addEventListener('click', () => { wikiListExpanded[key] = !wikiListExpanded[key]; renderNoteList(); });
    container.appendChild(g);
    return collapsed;
  };

  const nav = pages.filter(isNav);
  if (nav.length && !addToggle('nav', '导航', 'wiki-group-title')) renderCards(nav, 10);

  // 领域分组：按模版列表顺序优先，未知领域排后
  const domainPages = pages.filter((p) => !isNav(p));
  const domains = [...new Set([...(state.templates || []).map((t) => t.id), ...domainPages.map(domainOf)])]
    .filter((d) => domainPages.some((p) => domainOf(p) === d));
  for (const d of domains) {
    const list = domainPages.filter((p) => domainOf(p) === d);
    const dKey = 'domain:' + d;
    const collapsed = addToggle(dKey, `📐 ${escapeHtml(tplName(d))} <span class="wiki-group-count">${list.length}</span>`, 'wiki-domain-title');
    if (collapsed) continue;
    // 领域内按 OKF 类型二级分组
    for (const key of Object.keys(labels)) {
      if (key === '') continue;
      const sub = list.filter((p) => typeOf(p) === key);
      if (!sub.length) continue;
      if (!addToggle(dKey + ':' + key, labels[key], 'wiki-group-title wiki-group-sub')) renderCards(sub, 34);
    }
  }
}

// ================= LLM Wiki =================
async function loadWiki() {
  try {
    state.wiki = await window.kb.wikiDescribe(state.settings);
  } catch (_) {
    state.wiki = { exists: false, pages: [] };
  }
  if (state.view.type === 'wiki') renderNoteList();
}

function typeIcon(type) {
  return { Concept: '💡', Source: '📄', Topic: '📚', Entity: '🧩', Answer: '💬' }[type] || '📄';
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
  $('wiki-title').textContent = pageTitle || relPath;
  $('wiki-viewer').title = pageTitle;
  renderWikiFm(fm);
  $('wiki-body').innerHTML = renderMarkdown(body);
  $('wiki-raw-text').value = res.content;
  $('wiki-body').hidden = false;
  $('wiki-raw-text').hidden = true;
  $('jobs-view').hidden = true;
  $('settings-view').hidden = true;
  $('graph-view').hidden = true;
  $('tpl-view').hidden = true;
  $('raw-view').hidden = true;
  $('wiki-viewer').hidden = false;
  renderEditor();
  renderNoteList();
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
  renderNoteList();
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

// ---------- 吸收前领域模板预检查 ----------
// 规则：所有 Wiki/图谱提取前先检查是否有合适的领域模板；未命中时询问是否自动生成，
// 不生成则使用通用模板。
// 返回值：{ id, name, tpl }（具体模板或 general）；'skip' → 预检查不可用，回退作业内匹配；null → 用户取消
let tplPendingIngest = null; // { resolve } — 手工新建模板后继续吸收的待办回调

async function checkDomainBeforeIngest({ rawPaths = [], texts = [] }) {
  const res = await window.kb.tplMatchFor({ settings: state.settings, rawPaths, texts });
  if (!res.ok) { toast('领域模板预检查失败：' + res.error + '，将改用作业内匹配', 4000); return 'skip'; }
  if (res.noText) return 'skip'; // 无可提取文本（预匹配读不到内容），交由作业内处理
  const findTpl = async (id) => {
    if (!state.templates || !state.templates.length) state.templates = (await window.kb.tplList()) || [];
    return state.templates.find((t) => t.id === id) || null;
  };
  if (res.matched) {
    toast(`已匹配领域模板：${res.matched.name}`);
    return { id: res.matched.id, name: res.matched.name, tpl: await findTpl(res.matched.id) };
  }
  const createNew = confirm(
    '未匹配到合适的领域模板。\n\n点「确定」打开新建领域模板并自动生成（审阅后点创建即可继续提取）；\n点「取消」直接使用通用模板。'
  );
  if (!createNew) return { id: 'general', name: '通用', tpl: await findTpl('general') };
  // 打开新建模板弹窗：AI 归纳名称/描述自动填入 → 自动点击「✨ AI 自动生成模板」补全其余字段，
  // 用户审阅后点「创建」即自动继续提取（取消则中止）
  return new Promise((resolve) => {
    tplPendingIngest = {
      resolve: async (id) => {
        if (!id) return resolve(null);
        state.templates = (await window.kb.tplList()) || [];
        const tpl = state.templates.find((t) => t.id === id) || null;
        resolve({ id, name: tpl ? tpl.name : id, tpl });
      },
    };
    openTplModal(null);
    (async () => {
      // 准备阶段：按钮与状态行同步给出运行中动画反馈
      const btn = $('btn-tpl-ai');
      btn.disabled = true;
      btn.textContent = '⏳ AI 准备中…';
      setTplGenStatus('🔍 准备阶段：AI 正在从来源内容归纳领域名称与描述…', 'running');
      const s = await window.kb.tplSuggestName({ settings: state.settings, rawPaths, texts });
      if ($('tpl-modal').hidden) return; // 等待期间用户已取消，不再自动填充
      if (s.ok && s.name) {
        $('tpl-name').value = s.name;
        if (s.desc) $('tpl-desc').value = s.desc;
        btn.disabled = false;
        btn.textContent = '✨ AI 自动生成模版';
        setTplGenStatus(`✔ 准备阶段完成：领域归纳为「${s.name}」，即将进入生成阶段…`, 'ok');
        await runTplGenerate(); // 等价于自动点击「✨ AI 自动生成模版」（含生成阶段动画状态展示）
      } else {
        btn.disabled = false;
        btn.textContent = '✨ AI 自动生成模版';
        setTplGenStatus('✖ 准备阶段失败：' + (s.error || '未知错误') + '，请手工填写名称后点 AI 生成', 'err');
        toast('领域名称归纳失败：' + (s.error || '未知错误'), 4000);
      }
    })();
  });
}

// 预检查后拼装吸收 payload：domain 为 null 表示用户取消；'skip' 表示不附加 domainId
function finishIngestPayload(payload, domain) {
  return domain !== 'skip' ? { ...payload, domainId: domain.id } : payload;
}

// 图谱作业的领域约束：命中特定领域时按模板实体/概念类型组织节点（通用模板不加约束）
function graphDomainExtras(domain) {
  if (!domain || domain === 'skip' || domain.id === 'general' || !domain.tpl) return {};
  return {
    typeHints: {
      entity: (domain.tpl.entityTypes || []).map((t) => t.name),
      concept: (domain.tpl.conceptTypes || []).map((t) => t.name),
    },
    domainLabel: domain.name,
  };
}

async function runIngest() {
  const title = $('ingest-title').value.trim();
  const url = $('ingest-url').value.trim();
  const text = $('ingest-text').value;
  if (state.ingestTab === 'url' && !url) { setIngestStatus('请填写 URL', 'err'); return; }
  if (state.ingestTab === 'text' && !text.trim()) { setIngestStatus('请粘贴文本内容', 'err'); return; }
  if (state.ingestTab === 'files' && state.ingestFiles.length === 0) { setIngestStatus('请先选择或拖入至少一个文件', 'err'); return; }

  // 领域模板预检查：文件用 local: 路径读内容，URL/文本直接参与匹配
  setIngestStatus('正在匹配领域模板…');
  const domain = await checkDomainBeforeIngest({
    rawPaths: state.ingestTab === 'files' ? state.ingestFiles.map((f) => 'local:' + f.path) : [],
    texts: state.ingestTab === 'text' ? [text] : (state.ingestTab === 'url' ? [url] : []),
  });
  if (domain === null) { setIngestStatus('已取消：未选择领域模板', 'err'); return; }

  const payload = finishIngestPayload({
    settings: state.settings,
    files: state.ingestTab === 'files' ? state.ingestFiles.slice() : [],
    url: state.ingestTab === 'url' ? url : '',
    text: state.ingestTab === 'text' ? text : '',
    title,
  }, domain);
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

// ---------- 领域模版 ----------
let tplEditingId = null; // 当前编辑的模版 id（null = 新建）

function showTplView() {
  $('wiki-viewer').hidden = true;
  $('settings-view').hidden = true;
  $('jobs-view').hidden = true;
  $('graph-view').hidden = true;
  $('raw-view').hidden = true;
  $('prompts-view').hidden = true;
  $('tpl-view').hidden = false;
  renderEditor();
  renderSidebar();
  loadTemplates();
}

function hideTplView() {
  $('tpl-view').hidden = true;
  renderEditor();
  renderSidebar();
}

async function loadTemplates() {
  state.templates = (await window.kb.tplList()) || [];
  $('count-tpl').textContent = state.templates.length || '';
  renderTplCards();
}

function renderTplCards() {
  const box = $('tpl-cards');
  box.innerHTML = '';
  state.templates.forEach((t) => {
    const card = document.createElement('div');
    card.className = 'tpl-card' + (t.builtin ? '' : ' custom');
    const kws = (t.keywords || []).map((k) => `<span class="tpl-kw">${escapeHtml(k)}</span>`).join('');
    card.innerHTML = `
      <div class="tpl-card-head"><b>${escapeHtml(t.name)}</b><code>${escapeHtml(t.id)}</code></div>
      <p class="tpl-card-desc">${escapeHtml(t.desc || '')}</p>
      <div class="tpl-counts">
        <span>实体类型: ${(t.entityTypes || []).length}</span>
        <span>概念类型: ${(t.conceptTypes || []).length}</span>
      </div>
      ${kws ? `<div class="tpl-kws">${kws}</div>` : ''}
      <div class="tpl-card-foot">
        <span>更新: ${t.updatedAt ? formatDate(t.updatedAt).slice(0, 10) : '—'}</span>
        <span class="tpl-card-btns">
          <button class="btn btn-ghost" data-act="edit">编辑</button>
          ${t.builtin ? '' : '<button class="btn btn-ghost danger" data-act="del">删除</button>'}
        </span>
      </div>`;
    card.addEventListener('click', (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'edit') openTplModal(t);
      if (act === 'del') deleteTpl(t);
    });
    // 右键菜单：从该领域 Wiki 页面抽取知识图谱（按钮入口已统一为右键）
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openCtxMenu(e.clientX, e.clientY, [
        { label: '🕸 生成图谱（从该领域 Wiki 页面）', action: () => graphTpl(t) },
        { label: '✏ 编辑模板', action: () => openTplModal(t) },
      ]);
    });
    box.appendChild(card);
  });
}

// 动态行：实体/概念类型（名称+说明）与骨架页面（标题+说明）共用同一结构
function addTplRow(boxId, namePh, descPh, val = {}) {
  const row = document.createElement('div');
  row.className = 'tpl-row';
  row.innerHTML = `
    <input type="text" class="tpl-row-name" placeholder="${namePh}" />
    <input type="text" class="tpl-row-desc" placeholder="${descPh}" />
    <button class="icon-btn" title="移除">✕</button>`;
  row.querySelector('.tpl-row-name').value = val.name || val.title || '';
  row.querySelector('.tpl-row-desc').value = val.desc || '';
  row.querySelector('.icon-btn').addEventListener('click', () => { row.remove(); updateTplValidation(); });
  $(boxId).appendChild(row);
}

function tplRows(boxId, nameKey) {
  return [...$(boxId).querySelectorAll('.tpl-row')]
    .map((r) => ({ [nameKey]: r.querySelector('.tpl-row-name').value.trim(), desc: r.querySelector('.tpl-row-desc').value.trim() }))
    .filter((it) => it[nameKey]);
}

function fillTplRows(tpl) {
  ['tpl-entity-rows', 'tpl-concept-rows', 'tpl-skel-rows'].forEach((id) => { $(id).innerHTML = ''; });
  (tpl.entityTypes || []).forEach((v) => addTplRow('tpl-entity-rows', '类型名称', '一句话说明（可选）', v));
  (tpl.conceptTypes || []).forEach((v) => addTplRow('tpl-concept-rows', '类型名称', '一句话说明（可选）', v));
  (tpl.skeleton || []).forEach((v) => addTplRow('tpl-skel-rows', '页面标题', '页面职责说明（可选）', v));
}

function openTplModal(tpl, forceNew) {
  const editing = tpl && !forceNew ? tpl.id : null;
  tplEditingId = editing;
  setTplGenStatus('', '');
  $('tpl-modal-title').textContent = editing ? '编辑领域模版' : '新建领域模版';
  $('btn-tpl-save').textContent = editing ? '保存' : '创建';
  $('tpl-id').value = tpl ? tpl.id : '';
  $('tpl-id').disabled = !!editing; // 编辑时 ID 不可改
  $('tpl-name').value = tpl ? tpl.name : '';
  $('tpl-desc').value = tpl ? (tpl.desc || '') : '';
  $('tpl-keywords').value = tpl ? (tpl.keywords || []).join(', ') : '';
  $('tpl-must').value = tpl ? (tpl.mustExtract || []).join(', ') : '';
  $('tpl-ignore').value = tpl ? (tpl.ignoreContent || []).join(', ') : '';
  $('tpl-quality').value = tpl ? (tpl.quality || '') : '';
  fillTplRows(tpl || {});
  updateTplValidation();
  $('tpl-modal').hidden = false;
  $('tpl-modal-body').scrollTop = 0;
}

// 智能生成：分析全部笔记+原始文件，产出候选领域模版列表供采纳
async function openTplSuggest() {
  toast('AI 正在分析笔记与原始文件…');
  const res = await window.kb.tplSuggest({ settings: state.settings });
  if (!res.ok) { toast('生成失败：' + res.error, 4000); return; }
  const list = res.templates || [];
  const box = $('tpl-suggest-list');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div class="list-empty">未生成候选模版</div>';
  } else {
    list.forEach((c) => {
      const card = document.createElement('div');
      card.className = 'tpl-card custom';
      card.innerHTML = `
        <div class="tpl-card-head"><b>${escapeHtml(c.name || c.id)}</b><code>${escapeHtml(c.id || '')}</code></div>
        <p class="tpl-card-desc">${escapeHtml(c.desc || '')}</p>
        <div class="tpl-kws">${(c.keywords || []).slice(0, 6).map((k) => `<span class="tpl-kw">${escapeHtml(k)}</span>`).join('')}</div>
        <div class="tpl-card-foot"><span>实体 ${(c.entityTypes || []).length} · 概念 ${(c.conceptTypes || []).length}</span>
          <span class="tpl-card-btns"><button class="btn btn-primary" data-act="adopt">采纳并编辑</button></span></div>`;
      card.querySelector('[data-act="adopt"]').addEventListener('click', () => {
        $('tpl-suggest-modal').hidden = true;
        openTplModal(c, true); // 作为新模版预填，ID 可改
      });
      box.appendChild(card);
    });
  }
  $('tpl-suggest-modal').hidden = false;
}

// 必填校验：空字段标红、列表区显示警告，保存按钮随之禁用
function updateTplValidation() {
  let ok = true;
  document.querySelectorAll('#tpl-modal-body [data-req]').forEach((el) => {
    const bad = !el.value.trim() || (el.id === 'tpl-id' && !/^[A-Za-z][A-Za-z0-9_]*$/.test(el.value.trim()));
    el.classList.toggle('invalid', bad);
    if (bad) ok = false;
  });
  const lists = [
    ['tpl-entity-rows', 'tpl-entity-warn'],
    ['tpl-concept-rows', 'tpl-concept-warn'],
    ['tpl-skel-rows', 'tpl-skel-warn'],
  ];
  for (const [boxId, warnId] of lists) {
    const bad = ![...$(boxId).querySelectorAll('.tpl-row-name')].some((i) => i.value.trim());
    $(warnId).hidden = !bad;
    if (bad) ok = false;
  }
  $('btn-tpl-save').disabled = !ok;
  return ok;
}

async function saveTplForm() {
  if (!updateTplValidation()) { toast('请补全带 * 的必填项'); return; }
  const id = $('tpl-id').value.trim();
  if (!tplEditingId && state.templates.some((t) => t.id === id)) { toast('模版 ID 已存在：' + id); return; }
  const res = await window.kb.tplSave({
    id,
    name: $('tpl-name').value.trim(),
    desc: $('tpl-desc').value.trim(),
    keywords: $('tpl-keywords').value,
    entityTypes: tplRows('tpl-entity-rows', 'name'),
    conceptTypes: tplRows('tpl-concept-rows', 'name'),
    mustExtract: $('tpl-must').value,
    ignoreContent: $('tpl-ignore').value,
    quality: $('tpl-quality').value.trim(),
    skeleton: tplRows('tpl-skel-rows', 'title'),
  });
  if (!res.ok) { toast('保存失败：' + res.error, 4000); return; }
  const wasNew = !tplEditingId;
  $('tpl-modal').hidden = true;
  toast(wasNew ? '模版已创建' : '模版已更新');
  loadTemplates();
  // 吸收前预检查走「新建模板」分支时，创建成功后用新模板继续吸收
  if (wasNew && tplPendingIngest) {
    const p = tplPendingIngest;
    tplPendingIngest = null;
    p.resolve(id);
  }
}

async function deleteTpl(tpl) {
  if (!confirm(`确定删除领域模版“${tpl.name}”？`)) return;
  const res = await window.kb.tplRemove(tpl.id);
  if (!res.ok) { toast('删除失败：' + res.error, 4000); return; }
  toast('模版已删除');
  loadTemplates();
}

// AI 自动生成模版的准备/生成阶段状态展示（弹窗内 banner 下方）
function setTplGenStatus(text, cls) {
  const el = $('tpl-gen-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'tpl-gen-status' + (cls ? ' ' + cls : '');
  el.hidden = !text;
}

// AI 自动生成：按名称与描述补全其余字段（已填内容会被覆盖）
async function runTplGenerate() {
  const name = $('tpl-name').value.trim();
  const desc = $('tpl-desc').value.trim();
  if (!name) { toast('请先填写名称'); setTplGenStatus('✖ 生成阶段未开始：请先填写名称', 'err'); return; }
  const btn = $('btn-tpl-ai');
  btn.disabled = true;
  btn.textContent = '⏳ AI 生成中…';
  setTplGenStatus('⚙ 生成阶段：AI 正在按名称补全模版 ID、关键词、实体/概念类型与提取规则…', 'running');
  try {
    const res = await window.kb.tplGenerate({ settings: state.settings, name, desc });
    if (!res.ok) { setTplGenStatus('✖ 生成阶段失败：' + res.error + '，可重试或手工填写', 'err'); toast('生成失败：' + res.error, 4000); return; }
    const t = res.template;
    if (!$('tpl-id').disabled && t.id) $('tpl-id').value = t.id;
    $('tpl-keywords').value = (t.keywords || []).join(', ');
    $('tpl-must').value = (t.mustExtract || []).join(', ');
    $('tpl-ignore').value = (t.ignoreContent || []).join(', ');
    $('tpl-quality').value = t.quality || '';
    fillTplRows(t);
    updateTplValidation();
    setTplGenStatus('✔ 生成阶段完成：各字段已补全，请审阅并按需调整，确认后点「创建」', 'ok');
    toast('已生成，请检查并按需调整');
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ AI 自动生成模版';
  }
}

async function openTplPromptModal() {
  $('tpl-prompt-pre').textContent = await window.kb.tplMatchPrompt();
  $('tpl-prompt-modal').hidden = false;
}

function bindTplEvents() {
  $('nav-templates').addEventListener('click', showTplView);
  $('btn-tpl-close').addEventListener('click', hideTplView);
  $('btn-tpl-new').addEventListener('click', () => openTplModal(null));
  $('btn-tpl-suggest').addEventListener('click', openTplSuggest);
  $('btn-tpl-suggest-close').addEventListener('click', () => { $('tpl-suggest-modal').hidden = true; });
  $('btn-tpl-suggest-done').addEventListener('click', () => { $('tpl-suggest-modal').hidden = true; });
  $('btn-tpl-prompt').addEventListener('click', openTplPromptModal);
  $('btn-tpl-prompt-close').addEventListener('click', () => { $('tpl-prompt-modal').hidden = true; });
  // 取消新建模板 → 若存在待办吸收则一并中止
  const cancelTplModal = () => {
    $('tpl-modal').hidden = true;
    if (tplPendingIngest) {
      const p = tplPendingIngest;
      tplPendingIngest = null;
      toast('已取消吸收：未选择领域模板');
      p.resolve(null);
    }
  };
  $('btn-tpl-cancel').addEventListener('click', cancelTplModal);
  $('btn-tpl-modal-close').addEventListener('click', cancelTplModal);
  $('btn-tpl-save').addEventListener('click', saveTplForm);
  $('btn-tpl-ai').addEventListener('click', runTplGenerate);
  $('btn-tpl-add-entity').addEventListener('click', () => { addTplRow('tpl-entity-rows', '类型名称', '一句话说明（可选）'); updateTplValidation(); });
  $('btn-tpl-add-concept').addEventListener('click', () => { addTplRow('tpl-concept-rows', '类型名称', '一句话说明（可选）'); updateTplValidation(); });
  $('btn-tpl-add-skel').addEventListener('click', () => { addTplRow('tpl-skel-rows', '页面标题', '页面职责说明（可选）'); updateTplValidation(); });
  // 输入即时校验（事件委托覆盖动态行）
  $('tpl-modal-body').addEventListener('input', updateTplValidation);
}

// ---------- 原始文件管理 ----------
function showRawView() {
  $('wiki-viewer').hidden = true;
  $('settings-view').hidden = true;
  $('jobs-view').hidden = true;
  $('graph-view').hidden = true;
  $('tpl-view').hidden = true;
  $('prompts-view').hidden = true;
  $('raw-view').hidden = false;
  renderEditor();
  renderSidebar();
  loadRaws();
}

function hideRawView() {
  $('raw-view').hidden = true;
  renderEditor();
  renderSidebar();
}

async function loadRaws() {
  state.raws = (await window.kb.rawList(state.settings)) || [];
  $('count-raws').textContent = state.raws.length || '';
  $('raw-stats').textContent = state.raws.length ? `共 ${state.raws.length} 个原始来源` : '';
  renderRawList();
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function renderRawList() {
  const box = $('raw-list');
  box.innerHTML = '';
  if (!state.raws.length) {
    box.innerHTML = '<div class="raw-empty">暂无原始来源。点右上「＋ 添加文件 / ＋ 添加目录」导入本地数据，或在「📖 LLM Wiki」点 ＋ 吸收网页/文本。</div>';
    return;
  }
  const makeRow = (r, indent) => {
    const row = document.createElement('div');
    row.className = 'raw-row';
    row.style.paddingLeft = indent + 'px';
    // 吸收状态徽标：已吸收（绿）/ 吸收后文件已修改（橙，建议重新吸收）
    const badge = r.ingested
      ? (r.ingested.stale
        ? `<span class="raw-badge stale" title="已于 ${formatDate(r.ingested.at)} 吸收，之后文件被修改过，建议重新吸收">已修改</span>`
        : `<span class="raw-badge ok" title="已于 ${formatDate(r.ingested.at)} 吸收进 Wiki">已吸收</span>`)
      : '';
    row.innerHTML = `
      <span class="raw-ext">${escapeHtml((r.ext || 'md').toUpperCase().slice(0, 4))}</span>
      <span class="raw-main">
        <span class="raw-name" title="${escapeHtml(r.path)}">${escapeHtml(r.name)}</span>
        <span class="raw-meta">${escapeHtml(r.path)} · ${fmtBytes(r.size)} · ${formatDate(r.mtime)}</span>
      </span>
      ${badge}
      <span class="raw-actions">
        <button class="btn btn-ghost" data-act="view" title="用本机默认软件打开该文件">查看</button>
        <button class="btn btn-ghost danger" data-act="del" title="删除该原始文件">删除</button>
      </span>`;
    row.addEventListener('click', (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'view') openRawNative(r.path);
      if (act === 'del') deleteRaw(r.path);
    });
    // 右键菜单：提取 Wiki / 知识图谱等快捷操作
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openCtxMenu(e.clientX, e.clientY, [
        { label: '📝 提取 Wiki', action: () => ingestRaw(r.path) },
        { label: '🕸 提取知识图谱', action: () => graphRaw(r.path) },
        { sep: true },
        { label: '📂 查看（本机打开）', action: () => openRawNative(r.path) },
        { label: '🗑 删除', danger: true, action: () => deleteRaw(r.path) },
      ]);
    });
    return row;
  };
  const rawFiles = state.raws.filter((r) => !String(r.path).startsWith('local:'));
  const localRefs = state.raws.filter((r) => String(r.path).startsWith('local:'));
  // 自动生成来源（raw/）平铺
  rawFiles.forEach((r) => box.appendChild(makeRow(r, 0)));
  // 本机引用：按原始目录（root）分组展示目录结构
  const byRoot = new Map();
  localRefs.forEach((r) => {
    const key = r.root || '';
    if (!byRoot.has(key)) byRoot.set(key, []);
    byRoot.get(key).push(r);
  });
  for (const [root, refs] of byRoot) {
    if (!root) { refs.forEach((r) => box.appendChild(makeRow(r, 0))); continue; }
    // 按 rel 构建嵌套目录树，原样保留多级目录结构
    const tree = { dirs: new Map(), files: [] };
    for (const r of refs) {
      const parts = String(r.rel || r.name).split('/').filter(Boolean);
      let cur = tree;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!cur.dirs.has(parts[i])) cur.dirs.set(parts[i], { dirs: new Map(), files: [] });
        cur = cur.dirs.get(parts[i]);
      }
      cur.files.push(r);
    }
    const countAll = (node) => node.files.length + [...node.dirs.values()].reduce((s, c) => s + countAll(c), 0);
    // 收集目录节点（含子目录）下的全部文件，供右键批量提取使用
    const collectFiles = (node) => node.files.slice().concat([...node.dirs.values()].flatMap(collectFiles));
    // 折叠状态：根目录默认展开，子目录默认折叠（保留多级结构、逐级展开）
    const folderHeader = (name, count, key, depth, files) => {
      const collapsed = (key in rawTreeCollapsed) ? rawTreeCollapsed[key] : (depth > 0);
      const fh = document.createElement('div');
      fh.className = 'wiki-domain-title wiki-group-toggle';
      fh.style.paddingLeft = (10 + depth * 14) + 'px';
      fh.title = '右键：对该目录提取 Wiki / 知识图谱';
      fh.innerHTML = `<span class="chevron${collapsed ? ' collapsed' : ''}">▾</span> 📁 ${escapeHtml(name)} <span class="wiki-group-count">${count}</span>`;
      fh.addEventListener('click', () => { rawTreeCollapsed[key] = !collapsed; renderRawList(); });
      // 右键菜单：对整个目录提取 Wiki / 知识图谱
      fh.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const paths = files.map((f) => f.path);
        openCtxMenu(e.clientX, e.clientY, [
          { label: `📝 提取 Wiki（${paths.length} 个文件）`, action: () => ingestRawPaths(paths, name) },
          { label: `🕸 提取知识图谱（${paths.length} 个文件）`, action: () => graphRawPaths(paths, name) },
        ]);
      });
      return fh;
    };
    const renderNode = (node, depth, prefix) => {
      for (const [name, child] of [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const key = 'rawdir:' + prefix + '/' + name;
        box.appendChild(folderHeader(name, countAll(child), key, depth, collectFiles(child)));
        if (!((key in rawTreeCollapsed) ? rawTreeCollapsed[key] : true)) renderNode(child, depth + 1, prefix + '/' + name);
      }
      node.files.slice().sort((a, b) => String(a.name).localeCompare(String(b.name))).forEach((f) => {
        box.appendChild(makeRow(f, 12 + depth * 14));
      });
    };
    const rootKey = 'rawdir:' + root;
    box.appendChild(folderHeader(pathBasename(root), refs.length, rootKey, 0, refs));
    if (!((rootKey in rawTreeCollapsed) ? rawTreeCollapsed[rootKey] : false)) renderNode(tree, 1, root);
  }
}

function pathBasename(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

// ---------- 右键菜单（原始文件/目录提取 Wiki 与知识图谱） ----------
let ctxMenuEl = null;
let ctxBound = false;

function closeCtxMenu() {
  if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; }
}

function openCtxMenu(x, y, items) {
  closeCtxMenu();
  if (!ctxBound) {
    ctxBound = true;
    document.addEventListener('click', closeCtxMenu);
    document.addEventListener('contextmenu', closeCtxMenu); // 行内 handler 已 stopPropagation，不会误关自身
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtxMenu(); });
    window.addEventListener('resize', closeCtxMenu);
  }
  ctxMenuEl = document.createElement('div');
  ctxMenuEl.className = 'ctx-menu';
  items.forEach((it) => {
    if (it.sep) {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      ctxMenuEl.appendChild(sep);
      return;
    }
    const b = document.createElement('button');
    b.className = 'ctx-item' + (it.danger ? ' danger' : '');
    b.textContent = it.label;
    b.addEventListener('click', (e) => { e.stopPropagation(); closeCtxMenu(); it.action(); });
    ctxMenuEl.appendChild(b);
  });
  document.body.appendChild(ctxMenuEl);
  // 定位：超出视窗时收回边界内
  ctxMenuEl.style.left = x + 'px';
  ctxMenuEl.style.top = y + 'px';
  const rect = ctxMenuEl.getBoundingClientRect();
  if (rect.right > window.innerWidth) ctxMenuEl.style.left = Math.max(4, window.innerWidth - rect.width - 4) + 'px';
  if (rect.bottom > window.innerHeight) ctxMenuEl.style.top = Math.max(4, window.innerHeight - rect.height - 4) + 'px';
}

// 目录级批量提取 Wiki：已吸收过滤 + 领域模板预检查（与全量吸收逻辑一致）
async function ingestRawPaths(paths, label) {
  if (!paths.length) { toast('该目录下暂无可提取的文件', 2500); return; }
  const isFresh = (p) => {
    const r = (state.raws || []).find((x) => x.path === p);
    return !!(r && r.ingested && !r.ingested.stale);
  };
  const fresh = paths.filter(isFresh);
  const todo = paths.filter((p) => !isFresh(p));
  let usePaths = todo;
  let force = false;
  if (!todo.length) {
    if (!confirm(`「${label}」下 ${paths.length} 个文件均已吸收过。确定要重新提取全部吗？（将更新现有 Wiki 页面）`)) return;
    usePaths = paths;
    force = true;
  } else if (fresh.length && !confirm(`「${label}」下 ${fresh.length} 个文件已吸收过且未变化，将只提取其余 ${todo.length} 个。继续？`)) return;
  toast('正在匹配领域模板…', 2500);
  const domain = await checkDomainBeforeIngest({ rawPaths: usePaths });
  if (domain === null) return;
  const res = await window.kb.jobsSubmit({ type: 'ingest', payload: finishIngestPayload({ settings: state.settings, rawPaths: usePaths, fromRaws: true, force }, domain) });
  if (!res.ok) { toast('提交作业失败：' + res.error, 4000); return; }
  toast(`已提交「${label}」生成 Wiki 作业（${usePaths.length} 个文件${force ? '，重新吸收' : ''}）`);
  showJobsView();
}

// 目录级批量提取知识图谱（提交前领域预检查）
async function graphRawPaths(paths, label) {
  if (!paths.length) { toast('该目录下暂无可提取的文件', 2500); return; }
  toast('正在匹配领域模板…', 2500);
  const domain = await checkDomainBeforeIngest({ rawPaths: paths });
  if (domain === null) return;
  const res = await window.kb.jobsSubmit({ type: 'graph', payload: { settings: state.settings, rawPaths: paths, ...graphDomainExtras(domain) } });
  if (!res.ok) { toast('提交作业失败：' + res.error, 4000); return; }
  toast(`已提交「${label}」生成图谱作业（${paths.length} 个文件）`);
  showJobsView();
}

// 查看原始文件：调用本机默认软件打开（桌面端 shell.openPath）
async function openRawNative(relPath) {
  const res = await window.kb.rawOpen({ settings: state.settings, relPath });
  if (!res.ok) toast(res.error || '打开失败', 3000);
}

// 复用作业管线的 rawPaths 机制：跳过保存阶段，直接编译已有来源
async function ingestRaw(relPath) {
  // 重复吸收校验：已吸收且未修改 → 二次确认（确认后 force 强制重新吸收）
  const rec = (state.raws || []).find((r) => r.path === relPath);
  let force = false;
  if (rec && rec.ingested && !rec.ingested.stale) {
    if (!confirm(`该来源已于 ${formatDate(rec.ingested.at)} 吸收过且文件未变化，再次吸收将更新现有 Wiki 页面。确定继续？`)) return;
    force = true;
  }
  // 领域模板预检查
  toast('正在匹配领域模板…', 2500);
  const domain = await checkDomainBeforeIngest({ rawPaths: [relPath] });
  if (domain === null) return;
  const res = await window.kb.jobsSubmit({ type: 'ingest', payload: finishIngestPayload({ settings: state.settings, rawPaths: [relPath], fromRaws: true, force }, domain) });
  if (!res.ok) { toast('提交作业失败：' + res.error, 4000); return; }
  toast('生成 Wiki 作业已提交');
  showJobsView();
}

// 仅从该原始来源抽取知识图谱（作业管线 rawPaths 模式，提交前领域预检查）
async function graphRaw(relPath) {
  toast('正在匹配领域模板…', 2500);
  const domain = await checkDomainBeforeIngest({ rawPaths: [relPath] });
  if (domain === null) return;
  const res = await window.kb.jobsSubmit({ type: 'graph', payload: { settings: state.settings, rawPaths: [relPath], ...graphDomainExtras(domain) } });
  if (!res.ok) { toast('提交作业失败：' + res.error, 4000); return; }
  toast('生成图谱作业已提交');
  showJobsView();
}

// 从某领域模版的 Wiki 页面抽取知识图谱（domain 范围，类型受模版实体/概念约束）
async function graphTpl(t) {
  const res = await window.kb.jobsSubmit({
    type: 'graph',
    payload: {
      settings: state.settings,
      scope: 'wiki',
      domain: t.id,
      templateName: t.name,
      typeHints: {
        entity: (t.entityTypes || []).map((x) => x.name).filter(Boolean),
        concept: (t.conceptTypes || []).map((x) => x.name).filter(Boolean),
      },
    },
  });
  if (!res.ok) { toast('提交作业失败：' + res.error, 4000); return; }
  toast(`已提交「${t.name}」领域图谱生成作业`);
  showJobsView();
}

async function deleteRaw(relPath) {
  if (!confirm(`删除原始来源“${relPath}”？已编译的 Wiki 页面不受影响。`)) return;
  const res = await window.kb.rawRemove({ settings: state.settings, relPath });
  if (!res.ok) { toast('删除失败：' + res.error, 4000); return; }
  toast('已删除');
  loadRaws();
}

async function addRawFiles() {
  const res = await window.kb.wikiPickFiles();
  if (!res || !res.ok || !res.paths || !res.paths.length) return;
  toast(`正在解析导入 ${res.paths.length} 个文件…`, 3000);
  const r = await window.kb.rawAddFiles({ settings: state.settings, paths: res.paths });
  if (!r.ok) { toast('导入失败：' + r.error, 4000); return; }
  toast(`已导入 ${r.added.length} 个文件${r.failed.length ? `，${r.failed.length} 个失败` : ''}`, 3200);
  loadRaws();
}

// ---------- 本地文件/目录导入选择器（自定义浏览：能看到目录内具体文件） ----------
let pickdirState = null; // { dir, parent, supported, selected:Set, resolve }

function fmtSize(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

function openPickDir() {
  return new Promise((resolve) => {
    pickdirState = { dir: '', parent: null, supported: [], selected: new Set(), resolve };
    $('pickdir-modal').hidden = false;
    browseTo(state.lastBrowseDir || '');
  });
}

function closePickDir(result) {
  if (!pickdirState) return;
  const r = pickdirState.resolve;
  pickdirState = null;
  $('pickdir-modal').hidden = true;
  r(result);
}

async function browseTo(dir) {
  const box = $('pickdir-list');
  box.innerHTML = '<div class="pickdir-empty">加载中…</div>';
  const res = await window.kb.browseDir({ dir });
  if (!pickdirState) return;
  if (!res.ok) {
    toast('无法打开目录：' + res.error, 3000);
    box.innerHTML = '<div class="pickdir-empty">无法打开该目录</div>';
    return;
  }
  pickdirState.dir = res.dir;
  pickdirState.parent = res.parent;
  pickdirState.supported = res.supported || [];
  pickdirState.selected = new Set();
  state.lastBrowseDir = res.dir || '';
  renderPickdirPath(res.dir, res.parent);
  renderPickdirList(res);
  updatePickdirActions();
}

// 路径面包屑：逐段可点击回跳
function renderPickdirPath(dir) {
  const el = $('pickdir-path');
  el.innerHTML = '';
  const root = document.createElement('span');
  root.className = 'seg';
  root.textContent = '💻 此电脑';
  root.addEventListener('click', () => browseTo(''));
  el.appendChild(root);
  if (!dir) return;
  const segs = dir.split(/[\\/]/).filter(Boolean);
  let acc = '';
  for (const s of segs) {
    acc = acc ? acc + '\\' + s : (s.endsWith(':') ? s + '\\' : s);
    const target = acc;
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '›';
    el.appendChild(sep);
    const seg = document.createElement('span');
    seg.className = 'seg';
    seg.textContent = s;
    seg.addEventListener('click', () => browseTo(target));
    el.appendChild(seg);
  }
}

function renderPickdirList(res) {
  const box = $('pickdir-list');
  box.innerHTML = '';
  if (!res.dirs.length && !res.files.length) {
    box.innerHTML = '<div class="pickdir-empty">此目录为空</div>';
    return;
  }
  for (const d of res.dirs) {
    const row = document.createElement('div');
    row.className = 'pickdir-row';
    row.innerHTML = `<span>📁</span><span class="pd-name">${escapeHtml(d.name)}</span><span class="pd-meta">文件夹</span>`;
    row.addEventListener('click', () => browseTo(d.path));
    box.appendChild(row);
  }
  for (const f of res.files) {
    const supported = pickdirState.supported.includes(f.ext);
    const row = document.createElement('div');
    row.className = 'pickdir-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      if (cb.checked) pickdirState.selected.add(f.path);
      else pickdirState.selected.delete(f.path);
      updatePickdirActions();
    });
    row.appendChild(cb);
    const name = document.createElement('span');
    name.className = 'pd-name';
    name.textContent = f.name;
    row.appendChild(name);
    const ext = document.createElement('span');
    ext.className = 'pd-ext' + (supported ? '' : ' unsupported');
    ext.textContent = f.ext || '文件';
    ext.title = supported ? '支持格式' : '非支持格式，吸收时将跳过';
    row.appendChild(ext);
    const meta = document.createElement('span');
    meta.className = 'pd-meta';
    meta.textContent = fmtSize(f.size);
    row.appendChild(meta);
    row.addEventListener('click', () => { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); });
    box.appendChild(row);
  }
}

function updatePickdirActions() {
  const n = pickdirState.selected.size;
  $('pickdir-info').textContent = pickdirState.dir ? '当前目录：' + pickdirState.dir : '请选择磁盘';
  $('btn-pickdir-files').disabled = !n;
  $('btn-pickdir-files').textContent = n ? `导入所选文件（${n}）` : '导入所选文件';
  $('btn-pickdir-dir').disabled = !pickdirState.dir;
}

async function addRawDir() {
  if (window.__KB_WEB__) { toast('网页模式不支持导入本地文件，请用「＋ 添加文件」上传', 3200); return; }
  const paths = await openPickDir();
  if (!paths || !paths.length) return;
  toast('正在导入所选文件/目录，请稍候…', 3000);
  const r = await window.kb.rawAddDir({ settings: state.settings, paths });
  if (!r.ok) { toast('导入失败：' + r.error, 4000); return; }
  toast(`已导入 ${r.added} 个文件${r.skipped ? `，超上限跳过 ${r.skipped} 个` : ''}${r.failed.length ? `，${r.failed.length} 个失败` : ''}`, 3600);
  loadRaws();
}

function bindRawEvents() {
  $('nav-raws').addEventListener('click', showRawView);
  // 侧边栏「原始文件」右键：全部原始来源生成 Wiki / 知识图谱（按钮入口已统一为右键）
  $('nav-raws').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openCtxMenu(e.clientX, e.clientY, [
      { label: '📝 全部来源提取 Wiki', action: () => rawsToWiki() },
      { label: '🕸 全部来源提取知识图谱', action: () => rawsToGraph() },
    ]);
  });
  // 侧边栏 ＋：直接选择文档上传到 raw/，并打开原始文件页
  $('btn-raws-add').addEventListener('click', (e) => {
    e.stopPropagation();
    addRawFiles();
    showRawView();
  });
  $('btn-raw-close').addEventListener('click', hideRawView);
  $('btn-raw-refresh').addEventListener('click', loadRaws);
  $('btn-raw-add-files').addEventListener('click', addRawFiles);
  $('btn-raw-add-dir').addEventListener('click', addRawDir);
  // 导入选择器弹窗：导入所选文件 / 导入当前目录 / 取消（点遮罩关闭）
  $('btn-pickdir-cancel').addEventListener('click', () => closePickDir(null));
  $('btn-pickdir-files').addEventListener('click', () => closePickDir([...pickdirState.selected]));
  $('btn-pickdir-dir').addEventListener('click', () => closePickDir([pickdirState.dir]));
  $('pickdir-modal').addEventListener('click', (e) => { if (e.target === $('pickdir-modal')) closePickDir(null); });
}

// 全部原始来源生成 Wiki（复用作业管线 rawPaths，跳过保存阶段；已吸收且未变化的默认跳过）
async function rawsToWiki() {
  const all = state.raws || [];
  if (!all.length) { toast('暂无原始来源', 2500); return; }
  const fresh = all.filter((r) => r.ingested && !r.ingested.stale);
  const todo = all.filter((r) => !(r.ingested && !r.ingested.stale));
  if (!todo.length) {
    // 全部已吸收：用户明确确认后才强制重吸
    if (!confirm(`全部 ${all.length} 个来源均已吸收过。确定要重新吸收全部吗？（将更新现有 Wiki 页面）`)) return;
    toast('正在匹配领域模板…', 2500);
    const domain = await checkDomainBeforeIngest({ rawPaths: all.map((r) => r.path) });
    if (domain === null) return;
    const res = await window.kb.jobsSubmit({ type: 'ingest', payload: finishIngestPayload({ settings: state.settings, rawPaths: all.map((r) => r.path), fromRaws: true, force: true }, domain) });
    if (!res.ok) { toast('提交作业失败：' + res.error, 4000); return; }
    toast(`已提交「全部原始来源」重新吸收作业（${all.length} 个来源）`);
    showJobsView();
    return;
  }
  if (fresh.length && !confirm(`${fresh.length} 个来源已吸收过且未变化，将只吸收其余 ${todo.length} 个。继续？（如需重新吸收已吸收来源，请逐条操作）`)) return;
  if (!fresh.length && !confirmRegen('wiki')) return;
  toast('正在匹配领域模板…', 2500);
  const domain = await checkDomainBeforeIngest({ rawPaths: todo.map((r) => r.path) });
  if (domain === null) return;
  const res = await window.kb.jobsSubmit({ type: 'ingest', payload: finishIngestPayload({ settings: state.settings, rawPaths: todo.map((r) => r.path), fromRaws: true }, domain) });
  if (!res.ok) { toast('提交作业失败：' + res.error, 4000); return; }
  toast(`已提交生成 Wiki 作业（${todo.length} 个来源${fresh.length ? `，已跳过 ${fresh.length} 个已吸收` : ''}）`);
  showJobsView();
}

// 全部原始来源生成知识图谱
async function rawsToGraph() {
  const paths = (state.raws || []).map((r) => r.path);
  if (!paths.length) { toast('暂无原始来源', 2500); return; }
  if (!confirmRegen('graph')) return;
  const res = await window.kb.jobsSubmit({ type: 'graph', payload: { settings: state.settings, rawPaths: paths } });
  if (!res.ok) { toast('提交作业失败：' + res.error, 4000); return; }
  toast(`已提交「全部原始来源」生成图谱作业（${paths.length} 个来源）`);
  showJobsView();
}

