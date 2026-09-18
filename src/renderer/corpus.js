// 渲染层·语料库子页签（语料流水线设计 §16.2）
// 落点：#raw-view 的子页签，不做新主视图（两个咽喉点数组 hideMainViews / syncNoteListVisibility 零改动）。
// 加载顺序：raws.js 之后、app.js 之前——复用 raws.js 的 openCtxMenu / renderRawPreview / rawAssetUrl，
// 且在 app.js 绑定之前把函数与 bindCorpusEvents 定义好。全部为全局函数（无框架、无打包）。

// ---------- 子页签切换 ----------
// 原始文件态显示的按钮；语料态显示的按钮
const RAW_TAB_BTNS = ['btn-raw-add-dir', 'btn-raw-add-url', 'btn-raw-refresh', 'btn-raw-extract-corpus'];
const CORPUS_TAB_BTNS = ['btn-corpus-graph', 'btn-corpus-refresh'];

// 统一按 state.corpusTab 切换两个列表容器、两组工具栏按钮、分段控件选中态与统计文案。
// 幂等：可安全重复调用（showRawView 末尾也会调它，保证从别处进入时子页签状态一致）。
function applyCorpusTab() {
  const isCorpus = state.corpusTab === 'corpus';
  const rawList = $('raw-list');
  const corpusPane = $('corpus-pane');
  if (rawList) rawList.hidden = isCorpus;
  if (corpusPane) corpusPane.hidden = !isCorpus;
  // 工具栏按钮组：语料态隐藏原始文件按钮，反之隐藏语料按钮（btn-raw-extract-corpus 仅 pipeline 开启时再叠加可见性）
  RAW_TAB_BTNS.forEach((id) => { const el = $(id); if (el) el.style.display = isCorpus ? 'none' : ''; });
  CORPUS_TAB_BTNS.forEach((id) => { const el = $(id); if (el) el.style.display = isCorpus ? '' : 'none'; });
  // 「抽取为语料」按钮：即便处于原始文件态，也要在 pipeline 关闭时隐藏（避免给了个点了没反应的按钮）
  syncExtractCorpusBtn();
  // 分段控件选中态 + aria
  document.querySelectorAll('#raw-subtabs button').forEach((b) => {
    const on = b.dataset.subtab === (isCorpus ? 'corpus' : 'raw');
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  // 计数徽标（解耦于侧边栏 #count-raws）
  const rawTabCount = $('count-raws-tab');
  if (rawTabCount) rawTabCount.textContent = (state.raws || []).length || '';
  if (isCorpus) {
    loadCorpus();
  } else {
    updateRawStats();
  }
}

function showRawPane() {
  state.corpusTab = 'raw';
  applyCorpusTab();
}

function showCorpusPane() {
  state.corpusTab = 'corpus';
  applyCorpusTab();
}

// 原始文件态的统计文案（从 loadRaws 抽出来，供切回原始文件态时复用）
function updateRawStats() {
  const el = $('raw-stats');
  if (!el) return;
  el.textContent = (state.raws || []).length ? `共 ${state.raws.length} 个原始来源` : '';
}

// 「抽取为语料」按钮可见性：仅 pipeline 开启 + 原始文件态时可见
function syncExtractCorpusBtn() {
  const el = $('btn-raw-extract-corpus');
  if (!el) return;
  const on = !!state.settings && state.settings.pipeline === true;
  const show = on && state.corpusTab !== 'corpus';
  el.hidden = !show;
}

// ---------- 列表加载与渲染 ----------
async function loadCorpus() {
  const box = $('corpus-pane');
  if (box && !Array.isArray(state.corpus)) box.innerHTML = '<div class="raw-empty">加载中…</div>';
  let res;
  try {
    res = await window.kb.corpusList({ settings: state.settings });
  } catch (e) {
    if (box) box.innerHTML = `<div class="raw-empty">读取语料库失败：${escapeHtml((e && e.message) || String(e))}</div>`;
    return;
  }
  if (!res || !res.ok) {
    if (box) box.innerHTML = `<div class="raw-empty">读取语料库失败：${escapeHtml((res && res.error) || '未知错误')}</div>`;
    state.corpus = [];
    return;
  }
  state.corpus = Array.isArray(res.items) ? res.items : [];
  state.corpusStaleCount = res.staleCount || 0;
  renderCorpusList();
}

// 三态徽标：源已修改（stale·橙）> 已入图（graphedAt·绿）> 待处理（无）
// 后端扫描条目暂不携带 graphedAt，故多数情况只有「源已修改」或「无徽标」两态（设计 §16.2 允许）。
function corpusBadge(c) {
  if (c && c.stale) {
    const when = c.generatedAt ? formatDate(Date.parse(c.generatedAt)) : '';
    return `<span class="raw-badge stale" title="语料生成于 ${escapeHtml(when)}，但源文件之后又被修改过，建议重新抽取">源已修改</span>`;
  }
  if (c && c.graphedAt) {
    return `<span class="raw-badge ok" title="已于 ${escapeHtml(formatDate(Date.parse(c.graphedAt)))} 抽取知识图谱">已抽取图谱</span>`;
  }
  return '';
}

function renderCorpusList() {
  const box = $('corpus-pane');
  if (!box) return;
  box.innerHTML = '';
  const items = state.corpus || [];
  // 计数徽标 + 统计文案（语料态下 #raw-stats 展示语料统计）
  const tabCount = $('count-corpus-tab');
  if (tabCount) tabCount.textContent = items.length || '';
  const stats = $('raw-stats');
  if (stats && state.corpusTab === 'corpus') {
    const staleN = state.corpusStaleCount || 0;
    stats.textContent = items.length
      ? `共 ${items.length} 篇语料${staleN ? ` · ${staleN} 篇待更新` : ''}`
      : '';
  }
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'raw-empty';
    empty.innerHTML = '暂无语料。到「原始文件」子页签选中文件后点「抽取为语料」，流水线会把它们解析成 Markdown 语料，存到 <code>corpus/原文档名/</code>。<br>'
      + '<span class="corpus-empty-note">· 语料不参与全局搜索与 AI 问答，只能在本页查看</span><br>'
      + '<span class="corpus-empty-note">· 语料库可重生成，不含在备份内，换机后需重新抽取</span>';
    box.appendChild(empty);
    return;
  }
  items.forEach((c) => box.appendChild(makeCorpusRow(c)));
  // 常驻提示行：语料态下固定一句，避免用户误以为语料会跟着 note/ 走
  const hint = document.createElement('div');
  hint.className = 'corpus-foot-hint';
  hint.textContent = '语料可重生成 · 不入备份 · 不参与搜索';
  box.appendChild(hint);
}

function makeCorpusRow(c) {
  const row = document.createElement('div');
  row.className = 'raw-row corpus-row';
  const parseTag = c.parseMethod ? `<span class="corpus-chip" title="解析方式">${escapeHtml(c.parseMethod)}</span>` : '';
  const skillTag = c.skill && c.skill.name ? `<span class="corpus-chip" title="抽取技能">🛠 ${escapeHtml(c.skill.name)}</span>` : '';
  const domainTag = c.domainLabel ? `<span class="corpus-chip" title="领域">◆ ${escapeHtml(c.domainLabel)}</span>` : '';
  const charsTxt = Number.isFinite(c.chars) ? `${c.chars.toLocaleString()} 字` : '';
  const when = c.generatedAt ? formatDate(Date.parse(c.generatedAt)) : '';
  row.innerHTML = `
    <span class="raw-ext" title="Markdown 语料">MD</span>
    <span class="raw-main">
      <span class="raw-name" title="${escapeHtml(c.rel || '')}">${escapeHtml(stripMd(c.name))}</span>
      <span class="raw-meta">${escapeHtml(c.rel || '')}${charsTxt ? ' · ' + escapeHtml(charsTxt) : ''}${when ? ' · ' + escapeHtml(when) : ''} ${domainTag}${parseTag}${skillTag}</span>
    </span>
    ${corpusBadge(c)}
    <span class="raw-actions">
      <button class="btn btn-ghost" data-act="preview" title="在应用内预览该语料">预览</button>
      <button class="btn btn-primary" data-act="promote" title="把该语料提升为笔记（写入 note/）">提升为笔记</button>
      <button class="btn btn-ghost" data-act="reextract" title="按当前来源重新抽取该语料">重新抽取</button>
      <button class="btn btn-ghost danger" data-act="del" title="删除该语料（含同名图片目录）">删除</button>
    </span>`;
  row.addEventListener('click', (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (!act) return;
    if (act === 'preview') openCorpusPreview(c.rel);
    if (act === 'promote') promoteCorpusToNote(c.rel);
    if (act === 'reextract') reExtractCorpus(c);
    if (act === 'del') removeCorpus([c.rel]);
  });
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const menu = [
      { label: '预览', action: () => openCorpusPreview(c.rel) },
      { label: '提升为笔记', action: () => promoteCorpusToNote(c.rel) },
      { label: '重新抽取', action: () => reExtractCorpus(c) },
      { label: '抽取知识图谱（仅本篇）', action: () => graphFromCorpus([c.rel]) },
      { sep: true },
    ];
    // 「在文件管理器中打开」桌面端才有意义；网页模式给友好 stub（见 kb-shim.js）
    if (!window.__KB_WEB__) menu.push({ label: '在文件管理器中打开', action: () => openCorpusDir(c.rel) });
    menu.push({ label: '删除', danger: true, action: () => removeCorpus([c.rel]) });
    openCtxMenu(e.clientX, e.clientY, menu);
  });
  return row;
}

// 去掉 .md 后缀做展示名
function stripMd(name) {
  return String(name || '').replace(/\.(md|markdown)$/i, '');
}

// ---------- 预览（复用 #raw-preview-view + renderRawPreview）----------
async function openCorpusPreview(rel) {
  const res = await window.kb.corpusRead({ rel });
  if (!res || !res.ok) { toast('预览失败：' + ((res && res.error) || '未知错误'), 3500); return; }
  hideMainViews();
  if (typeof setAiPanelVisible === 'function') setAiPanelVisible(false);
  $('raw-preview-view').hidden = false;
  const title = $('raw-preview-title');
  title.textContent = stripMd((res.frontmatter && res.frontmatter.source && res.frontmatter.source.name) || res.rel);
  title.title = String(res.rel || '');
  // 语料内图片落在 <同名>.assets/，相对引用解析到语料文件所在目录
  const dir = String(res.path || '').replace(/[\\/][^\\/]*$/, '').replace(/\\/g, '/');
  renderRawPreview(res.text || '', dir);
  renderEditor();
  renderSidebar();
  syncNoteListVisibility();
}

// ---------- 提升为笔记 ----------
async function promoteCorpusToNote(rel) {
  const folderRel = ((await askInput('提升为笔记：目标目录名（留空=根目录）：', '')) || '').trim();
  const res = await window.kb.corpusPromote({ rel, folderRel });
  if (!res || !res.ok) { toast('提升失败：' + ((res && res.error) || '未知错误'), 4000); return; }
  toast(res.updated ? '已更新对应笔记' : '已提升为笔记', 3000);
  reloadNotesFromDisk();
  loadCorpus();
}

function reloadNotesFromDisk() {
  window.kb.loadData().then((data) => {
    state.folders = data.folders || [];
    state.notes = data.notes || [];
    state.trashedFolders = data.trashedFolders || [];
    renderAll();
  }).catch(() => { /* 刷新失败不打断操作 */ });
}

// ---------- 重新抽取（按来源路径提交 extract-corpus 作业，force 绕缓存，可换技能）----------
async function reExtractCorpus(c) {
  const res = await window.kb.corpusRead({ rel: c.rel });
  const srcPath = res && res.ok && res.frontmatter && res.frontmatter.source && res.frontmatter.source.path;
  if (!srcPath) { toast('该语料缺少来源路径，无法重新抽取', 3500); return; }
  const skillName = await pickExtractSkill(extOfPath(srcPath));
  if (skillName === null) return;
  const r = await window.kb.jobsSubmit({ type: 'extract-corpus', payload: { settings: state.settings, rawPaths: [srcPath], force: true, skillName } });
  if (!r.ok) { toast('提交语料抽取作业失败：' + (r.error || '未知错误'), 4000); return; }
  toast('重新抽取作业已提交');
  showJobsView();
}

// ---------- 删除 ----------
async function removeCorpus(rels) {
  const list = Array.isArray(rels) ? rels : [rels];
  if (!list.length) return;
  const tip = list.length === 1 ? `删除语料“${list[0]}”？\n仅删除 corpus/ 内产物，原始文件与已入图谱不受影响。` : `删除 ${list.length} 篇语料？原始文件与已入图谱不受影响。`;
  if (!confirm(tip)) return;
  const res = await window.kb.corpusRemove({ rels: list });
  if (!res || !res.ok) { toast('删除失败：' + ((res && res.error) || '未知错误'), 4000); return; }
  toast(`已删除 ${res.removed != null ? res.removed : list.length} 篇语料`, 2600);
  loadCorpus();
}

// ---------- 在文件管理器中打开（桌面端）----------
async function openCorpusDir(rel) {
  const res = await window.kb.corpusOpenDir({ rel });
  if (res && !res.ok) toast(res.error || '无法打开目录', 3000);
}

// ---------- 批量抽取知识图谱（走 CorpusFileSource，需 pipeline 开启）----------
// 复用原始文件「提取知识图谱」的领域判定弹窗（autoDomainAndExtract）：把语料正文当作内联来源
// 参与多领域识别/逐条归类/模版与体系准备，用户确认后以 corpusRels 提交（后端跳过解析）
async function graphFromCorpus(rels) {
  const list = (Array.isArray(rels) ? rels : [rels]).filter(Boolean);
  if (!list.length) { toast('请先勾选要抽取知识图谱的语料', 2500); return; }
  if (!state.settings || state.settings.pipeline !== true) { toast('请先在「设置 → 语料流水线」开启流水线', 3500); return; }
  const inlineSources = [];
  for (const rel of list) {
    let text = '';
    try {
      const r = await window.kb.corpusRead({ rel });
      text = (r && r.ok && r.text) || '';
    } catch (_) { text = ''; }
    inlineSources.push({ label: rel, text });
  }
  const label = list.length === 1 ? String(list[0]).split('/').pop() : `${list.length} 篇语料`;
  const ok = await autoDomainAndExtract({ label, inlineSources, corpusMode: true });
  if (!ok) return;
  toast(`已提交「${list.length} 篇语料」生成图谱作业`, 3000);
  showJobsView();
}

// 语料态工具栏「入图」：把当前全部（未过期）语料提交图谱作业
async function graphAllCorpus() {
  const items = (state.corpus || []).filter((c) => !c.stale);
  if (!items.length) { toast('暂无可抽取知识图谱的语料', 2500); return; }
  if (!confirmRegen('graph')) return;
  graphFromCorpus(items.map((c) => c.rel));
}

// ---------- 事件绑定（在 app.js 的 init 中调用；委托写法照抄 bindRawEvents）----------
function bindCorpusEvents() {
  const subtabs = $('raw-subtabs');
  if (subtabs) {
    subtabs.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-subtab]');
      if (!btn) return;
      if (btn.dataset.subtab === 'corpus') showCorpusPane(); else showRawPane();
    });
  }
  const btnRefresh = $('btn-corpus-refresh');
  if (btnRefresh) btnRefresh.addEventListener('click', loadCorpus);
  const btnGraph = $('btn-corpus-graph');
  if (btnGraph) btnGraph.addEventListener('click', graphAllCorpus);
  const btnExtract = $('btn-raw-extract-corpus');
  if (btnExtract) btnExtract.addEventListener('click', () => extractRawCorpusAll());
  // 初始态：语料按钮组默认隐藏（进入语料子页签时才显示）
  CORPUS_TAB_BTNS.forEach((id) => { const el = $(id); if (el) el.style.display = 'none'; });
}
