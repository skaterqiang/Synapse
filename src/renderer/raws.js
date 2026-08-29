// 渲染进程·原始文件模块：原始文件管理、领域模版、提取作业入口
const rawTreeCollapsed = {}; // 原始文件目录树折叠状态（会话内）

// ---------- 提取前领域模板预检查 ----------
// 规则：图谱提取前先检查是否有合适的领域模板；未命中时询问是否自动生成，
// 不生成则使用通用模板。
// allowCreate=false：未命中时不弹确认、直接用通用模板（图谱提取不依赖严格领域模板，不能阻断作业提交）
// timeoutMs：主进程侧 LLM 判定的限时，超时后自动降级为关键词兜底，不会永远卡在“正在匹配领域模板…”
// 返回值：{ id, name, tpl }（具体模板或 general）；'skip' → 预检查不可用，回退作业内匹配；null → 用户取消
// 图谱的领域预匹配只用于附加类型约束，模型慢时宁可放弃约束也要尽快把作业排上去
// GRAPH_MATCH_TIMEOUT 定义于 renderer/constants.js
let tplPendingIngest = null; // { resolve } — 手工新建模板后继续提取的待办回调

async function checkDomainBeforeIngest({ rawPaths = [], texts = [], allowCreate = true, timeoutMs }) {
  const res = await window.kb.tplMatchFor({ settings: state.settings, rawPaths, texts, timeoutMs });
  if (!res.ok) { toast('领域模板预检查失败：' + res.error + '，将改用作业内匹配', 4000); return 'skip'; }
  if (res.noText) return 'skip'; // 无可提取文本（预匹配读不到内容），交由作业内处理
  if (res.degraded) toast('模型未能完成领域判定（' + (res.degradeError || '超时') + '），已改用关键词匹配', 4000);
  const findTpl = async (id) => {
    if (!state.templates || !state.templates.length) state.templates = (await window.kb.tplList()) || [];
    return state.templates.find((t) => t.id === id) || null;
  };
  if (res.matched) {
    toast(`已匹配领域模板：${res.matched.name}`);
    return { id: res.matched.id, name: res.matched.name, tpl: await findTpl(res.matched.id) };
  }
  if (!allowCreate) return { id: 'general', name: '通用', tpl: await findTpl('general') };
  const createNew = confirm(
    '未匹配到合适的领域模板。\n\n点「确定」打开新建领域模板并自动生成（审阅后点创建即可继续提取）；\n点「取消」直接使用通用模板。'
  );
  if (!createNew) return { id: 'general', name: '通用', tpl: await findTpl('general') };
  return createDomainInteractively({ rawPaths, texts });
}

// 手动新建领域：打开「新建领域模版」弹窗，AI 归纳名称/描述自动填入 → 自动点击「✨ AI 自动生成模版」补全其余字段，
// 用户审阅后点「创建」即返回该模版；关闭弹窗返回 null（调用方据此中止提取）
function createDomainInteractively({ rawPaths = [], texts = [] }) {
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
      btn.textContent = 'AI 准备中…';
      setTplGenStatus('准备阶段：AI 正在从来源内容归纳领域名称与描述…', 'running');
      const s = await window.kb.tplSuggestName({ settings: state.settings, rawPaths, texts });
      if ($('tpl-editor-view').hidden) return; // 等待期间用户已取消，不再自动填充
      if (s.ok && s.name) {
        $('tpl-name').value = s.name;
        if (s.desc) $('tpl-desc').value = s.desc;
      }
      if (s.ok && s.name && s.desc) {
        btn.innerHTML = icoSvg('sparkles', 13) + ' AI 自动生成模版';
        syncTplAiBtn();
        setTplGenStatus(`✔ 准备阶段完成：领域归纳为「${s.name}」，即将进入生成阶段…`, 'ok');
        await runTplGenerate(); // 等价于自动点击「AI 自动生成模版」（含生成阶段动画状态展示）
      } else {
        btn.innerHTML = icoSvg('sparkles', 13) + ' AI 自动生成模版';
        syncTplAiBtn();
        setTplGenStatus('✖ 准备阶段失败：' + (s.ok ? '未归纳出领域描述' : (s.error || '未知错误')) + '，请手工填写名称和描述后点 AI 生成', 'err');
        toast('领域归纳不完整：请手工填写名称和描述后点 AI 生成', 4000);
      }
    })();
  });
}

// ---------- 提取前的领域选择（知识图谱抽取用） ----------
// 四种方式：自动匹配 / 指定已有领域 / 自动创建新领域 / 手动新建领域
let domainPicker = null; // { resolve } — 领域选择弹窗的待办回调

function syncDomainPickState() {
  const mode = (document.querySelector('input[name="domain-mode"]:checked') || {}).value;
  $('domain-pick-sel').disabled = mode !== 'pick';
}

// 返回可直接展开进作业 payload 的领域字段；null 表示用户取消（已给 toast）
async function pickDomainForExtract({ label, rawPaths = [], texts = [] }) {
  state.templates = (await window.kb.tplList()) || [];
  const n = rawPaths.length || texts.length;
  $('domain-modal-title').textContent = '提取知识图谱：选择领域';
  $('domain-modal-sub').textContent = `来源：${label || '当前选择'}${n ? `（${n} 个）` : ''}。领域决定本次抽取的实体/概念类型约束。`;
  const sel = $('domain-pick-sel');
  sel.innerHTML = (state.templates || [])
    .map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}${t.id === 'general' ? '（无类型约束）' : ''}</option>`).join('');
  // 每次打开都回到默认项，避免沿用上一次的选择造成误操作
  document.querySelectorAll('input[name="domain-mode"]').forEach((r) => { r.checked = r.value === 'auto'; });
  syncDomainPickState();
  $('domain-modal').hidden = false;
  const mode = await new Promise((resolve) => { domainPicker = { resolve }; });
  $('domain-modal').hidden = true;
  if (!mode) { toast('已取消提取', 2000); return null; }
  // 领域 → payload 字段：图谱需要 typeHints/domainLabel
  const extras = (domain, autoDomain) => ({ ...graphDomainExtras(domain), autoDomain });
  if (mode === 'pick') {
    const tpl = (state.templates || []).find((t) => t.id === sel.value);
    if (!tpl) { toast('未找到所选领域模版', 3000); return null; }
    toast(`使用领域「${tpl.name}」`);
    return extras({ id: tpl.id, name: tpl.name, tpl }, false);
  }
  if (mode === 'manual') {
    const created = await createDomainInteractively({ rawPaths, texts });
    if (!created) return null; // 取消时 cancelTplModal 已给提示
    return extras(created, false);
  }
  if (mode === 'create') return { autoDomain: true }; // 跳过匹配，交由作业内归纳并新建
  // auto：带超时的领域预匹配，命中特定领域就用它，否则交由作业内自动建域
  toast('正在匹配领域模版，随后自动提交作业…', 6000);
  const domain = await checkDomainBeforeIngest({
    rawPaths, texts, allowCreate: false, timeoutMs: GRAPH_MATCH_TIMEOUT,
  });
  if (domain === null) return null;
  const specific = domain !== 'skip' && domain.id !== 'general';
  return specific ? extras(domain, false) : { autoDomain: true };
}

// 图谱作业的领域信息：命中特定领域时按模板实体/概念类型组织节点（通用模板不加类型约束）
// domainId/domainLabel 无论是否命中都回传，作业卡片据此展示“本次按哪个领域抽取”
function graphDomainExtras(domain) {
  if (!domain || domain === 'skip') return { domainId: '', domainLabel: '通用（未做领域预检查）' };
  const base = { domainId: domain.id, domainLabel: domain.name };
  if (domain.id === 'general' || !domain.tpl) return base;
  return {
    ...base,
    typeHints: {
      entity: (domain.tpl.entityTypes || []).map((t) => t.name),
      concept: (domain.tpl.conceptTypes || []).map((t) => t.name),
    },
  };
}

// ---------- 领域模版 ----------
let tplEditingId = null; // 当前编辑的模版 id（null = 新建）
let tplTouched = false; // 新建弹窗打开时不立即标红空必填项，用户输入或尝试创建后才显示

function showTplView() {
  hideMainViews();
  promptEditing = null;
  $('tpl-view').hidden = false;
  $('tpl-editor-view').hidden = true;
  renderEditor();
  renderSidebar();
  loadTemplates();
}

function hideTplView() {
  $('tpl-view').hidden = true;
  $('tpl-editor-view').hidden = true;
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
    // 右键菜单：编辑模板
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openCtxMenu(e.clientX, e.clientY, [
        { label: '编辑模板', action: () => openTplModal(t) },
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
    <button class="icon-btn" title="移除">${icoSvg('close', 11)}</button>`;
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
  tplTouched = !!editing;
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
  // 在主框架内全屏展示编辑页（不再使用右侧抽屉）
  $('tpl-view').hidden = true;
  $('tpl-editor-view').hidden = false;
  renderEditor();
  $('tpl-modal-body').scrollTop = 0;
}

// 返回模版卡片列表（与抽屉时代一致：未保存修改不保留）
function closeTplEditor() {
  $('tpl-editor-view').hidden = true;
  $('tpl-view').hidden = false;
  renderEditor();
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
    const bad = !el.value.trim();
    // 新建且未交互时不标红（AI 会自动填充），避免一打开就满屏红框
    el.classList.toggle('invalid', tplTouched && bad);
    if (bad) ok = false;
  });
  // 模版 ID 非必填（创建时留空自动生成）；但一旦填写须符合英文标识符格式
  const idEl = $('tpl-id');
  const idBad = !!idEl.value.trim() && !/^[A-Za-z][A-Za-z0-9_]*$/.test(idEl.value.trim());
  idEl.classList.toggle('invalid', idBad);
  if (idBad) ok = false;
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
  syncTplAiBtn();
  return ok;
}

// 「✨ AI 自动生成模版」仅在名称与描述都填写后可用；未齐时禁用并在 title 提示原因
function syncTplAiBtn() {
  const btn = $('btn-tpl-ai');
  if (!btn) return;
  const ready = !!$('tpl-name').value.trim() && !!$('tpl-desc').value.trim();
  btn.disabled = !ready;
  btn.title = ready ? '' : '请先填写名称和描述，再使用 AI 自动生成';
}

async function saveTplForm() {
  tplTouched = true; // 尝试创建时揭示所有未填必填项
  if (!updateTplValidation()) { toast('请补全带 * 的必填项'); return; }
  let id = $('tpl-id').value.trim();
  if (!tplEditingId) {
    // ID 无需用户填写：填写了则校验格式与唯一性，留空则自动生成
    if (id && !/^[A-Za-z][A-Za-z0-9_]*$/.test(id)) { toast('模版 ID 须为英文标识符（字母开头，仅字母/数字/下划线）'); return; }
    if (id && state.templates.some((t) => t.id === id)) { toast('模版 ID 已存在：' + id); return; }
    if (!id) id = 'tpl_' + Date.now().toString(36);
  }
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
  closeTplEditor();
  toast(wasNew ? '模版已创建' : '模版已更新');
  loadTemplates();
  // 提取前预检查走「新建模板」分支时，创建成功后用新模板继续提取
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

// 生成过程实时输出：同一类别（正文/思考）的增量追加到尾部同类 span，避免碎片化增量产生大量节点
function appendTplGenLog(text, reasoning) {
  const log = $('tpl-gen-log');
  if (!log || !text) return;
  log.hidden = false;
  const cls = reasoning ? 'reasoning' : 'body';
  let tail = log.lastElementChild;
  if (!tail || tail.className !== cls) {
    tail = document.createElement('span');
    tail.className = cls;
    log.appendChild(tail);
  }
  tail.textContent += text;
  log.scrollTop = log.scrollHeight;
}

// AI 自动生成：按名称与描述补全其余字段（已填内容会被覆盖）
async function runTplGenerate() {
  const name = $('tpl-name').value.trim();
  const desc = $('tpl-desc').value.trim();
  // 名称与描述均必填才允许 AI 生成，保证生成质量
  if (!name || !desc) { toast('请先填写名称和描述，再使用 AI 自动生成'); setTplGenStatus('✖ 生成阶段未开始：请先填写名称和描述', 'err'); return; }
  const btn = $('btn-tpl-ai');
  btn.disabled = true;
  btn.textContent = 'AI 生成中…';
  setTplGenStatus('生成阶段：AI 正在按名称补全模版 ID、关键词、实体/概念类型与提取规则…', 'running');
  // 清空上次输出并订阅流式增量，实时打印生成过程（思考/正文）
  const log = $('tpl-gen-log');
  if (log) { log.innerHTML = ''; log.hidden = true; }
  const unsub = window.kb.onTplGenChunk ? window.kb.onTplGenChunk((c) => appendTplGenLog(c && c.text, c && c.reasoning)) : null;
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
    if (unsub) unsub();
    btn.innerHTML = icoSvg('sparkles', 13) + ' AI 自动生成模版';
    syncTplAiBtn();
  }
}

async function openTplPromptModal() {
  $('tpl-prompt-pre').textContent = await window.kb.tplMatchPrompt();
  $('tpl-prompt-modal').hidden = false;
}

function bindTplEvents() {
  // 领域模版入口在「知识图谱管理」子菜单内：经容器委派绑定，点击不触发图谱子视图切换
  $('kg-submenu').addEventListener('click', (e) => {
    if (e.target.closest('#nav-templates')) showTplView();
  });
  $('btn-tpl-close').addEventListener('click', hideTplView);
  $('btn-tpl-new').addEventListener('click', () => openTplModal(null));
  // 用户一旦手动输入，即开启必填校验标红
  $('tpl-modal-body').addEventListener('input', () => { if (!tplTouched) { tplTouched = true; updateTplValidation(); } });
  $('btn-tpl-suggest').addEventListener('click', openTplSuggest);
  $('btn-tpl-suggest-close').addEventListener('click', () => { $('tpl-suggest-modal').hidden = true; });
  $('btn-tpl-suggest-done').addEventListener('click', () => { $('tpl-suggest-modal').hidden = true; });
  $('btn-tpl-prompt').addEventListener('click', openTplPromptModal);
  $('btn-tpl-prompt-close').addEventListener('click', () => { $('tpl-prompt-modal').hidden = true; });
  // 取消新建模板 → 若存在待办提取则一并中止
  const cancelTplModal = () => {
    closeTplEditor();
    if (tplPendingIngest) {
      const p = tplPendingIngest;
      tplPendingIngest = null;
      toast('已取消提取：未选择领域模板');
      p.resolve(null);
    }
  };
  $('btn-tpl-cancel').addEventListener('click', cancelTplModal);
  $('btn-tpl-modal-close').addEventListener('click', cancelTplModal);
  // 领域选择弹窗（知识图谱提取用）
  const settleDomain = (mode) => {
    const p = domainPicker;
    domainPicker = null;
    if (p) p.resolve(mode);
  };
  $('btn-domain-cancel').addEventListener('click', () => settleDomain(null));
  $('btn-domain-ok').addEventListener('click', () => {
    const el = document.querySelector('input[name="domain-mode"]:checked');
    settleDomain(el ? el.value : 'auto');
  });
  document.querySelectorAll('input[name="domain-mode"]').forEach((r) => r.addEventListener('change', syncDomainPickState));
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
  hideMainViews();
  promptEditing = null;
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
  // 兼容旧形状（直接返回数组）与新形状 {list, truncated}
  const res = await window.kb.rawList(state.settings);
  const list = Array.isArray(res) ? res : ((res && res.list) || []);
  state.raws = list;
  state.rawTruncated = (!Array.isArray(res) && res && res.truncated) || [];
  state.rawMaxDirFiles = (!Array.isArray(res) && res && res.maxDirFiles) || 500;
  $('count-raws').textContent = state.raws.length || '';
  $('raw-stats').textContent = state.raws.length ? `共 ${state.raws.length} 个原始来源` : '';
  renderRawList();
  if (typeof refreshSetupChecklist === 'function') refreshSetupChecklist();
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

// URL 类来源的副标题简显：去掉 url: 前缀与协议，超长截断（完整地址见悬浮提示）
function shortUrlPath(p) {
  let s = String(p || '');
  if (s.startsWith('url:')) s = s.slice(4);
  try {
    const u = new URL(s);
    s = (u.hostname + u.pathname + u.search).replace(/\/+$/, '') || s;
  } catch (_) { /* 非标准 URL 原样处理 */ }
  return s.length > 48 ? s.slice(0, 45) + '…' : s;
}

function renderRawList() {
  const box = $('raw-list');
  box.innerHTML = '';
  // 已存在的超限目录引用：置顶告警并给一键解除（仅列出了前 N 个，且每次刷新都要遍历）
  for (const t of (state.rawTruncated || [])) {
    const limit = state.rawMaxDirFiles || 500;
    const warn = document.createElement('div');
    warn.className = 'raw-warn';
    const totalTxt = t.total && t.total > t.shown ? `约 ${t.total}${t.total >= limit * 20 ? '+' : ''} 个` : '过多';
    warn.innerHTML = `<span class="raw-warn-ico">${icoSvg('warn', 15)}</span>
      <span class="raw-warn-txt">目录 <b>${escapeHtml(t.dir)}</b> 含文件${totalTxt}，超过上限 ${limit}，当前仅列出前 ${t.shown} 个。
      它会在每次刷新时被遍历，建议解除后改选具体子目录；或在设置→作业中调高上限。</span>`;
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost raw-warn-act';
    btn.textContent = '解除该目录';
    btn.addEventListener('click', () => removeRawDir(t.dir, t.dir, t.shown));
    warn.appendChild(btn);
    box.appendChild(warn);
  }
  if (!state.raws.length) {
    const empty = document.createElement('div');
    empty.className = 'raw-empty';
    empty.textContent = '暂无原始来源。点右上「添加文件/目录」导入本地数据（可勾选单个文件，也可整目录导入），或点 ＋ 添加网页链接。';
    box.appendChild(empty);
    return;
  }
  const makeRow = (r, indent) => {
    const row = document.createElement('div');
    row.className = 'raw-row';
    row.style.paddingLeft = indent + 'px';
    // 本机引用（local:）/网页链接（url:）仅解除引用不删本机文件/不删网页；raw/ 下副本才是真删除
    const isLocal = String(r.path).startsWith('local:');
    const isUrl = String(r.path).startsWith('url:');
    const isRef = isLocal || isUrl;
    const delLabel = isRef ? '解除' : '删除';
    const delTitle = isUrl ? '解除该链接的引用' : (isLocal ? '解除该来源的引用（不删除本机文件）' : '删除该原始文件（raw/ 内副本）');
    const viewTitle = isUrl ? '在浏览器打开该链接' : '用本机默认软件打开该文件';
    // 历史吸收状态徽标（旧版吸收功能的存量标记）：已吸收（绿）/ 吸收后文件已修改（橙）
    const badge = r.ingested
      ? (r.ingested.stale
        ? `<span class="raw-badge stale" title="已于 ${formatDate(r.ingested.at)} 吸收，之后文件被修改过">已修改</span>`
        : `<span class="raw-badge ok" title="已于 ${formatDate(r.ingested.at)} 吸收">已吸收</span>`)
      : '';
    row.innerHTML = `
      ${isUrl
        ? `<span class="raw-ext raw-ext-url" title="网页链接引用">${icoSvg('link', 12)}</span>`
        : `<span class="raw-ext">${escapeHtml((r.ext || 'md').toUpperCase().slice(0, 4))}</span>`}
      <span class="raw-main">
        <span class="raw-name" title="${escapeHtml(r.path)}">${escapeHtml(r.name)}</span>
        <span class="raw-meta" title="${escapeHtml(r.path)}">${escapeHtml(isUrl ? shortUrlPath(r.path) : r.path)}${isUrl ? '' : ` · ${fmtBytes(r.size)}`} · ${formatDate(r.mtime)}</span>
      </span>
      ${badge}
      <span class="raw-actions">
        ${isUrl ? '<button class="btn btn-ghost" data-act="rename" title="改写该链接的展示名">改名</button>' : ''}
        <button class="btn btn-ghost" data-act="view" title="${viewTitle}">查看</button>
        <button class="btn btn-ghost danger" data-act="del" title="${delTitle}">${delLabel}</button>
      </span>`;
    row.addEventListener('click', (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'view') openRawNative(r.path);
      if (act === 'del') deleteRaw(r.path);
      if (act === 'rename') renameRawUrl(r);
    });
    // 右键菜单：提取笔记 / 知识图谱等快捷操作
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openCtxMenu(e.clientX, e.clientY, [
        { label: '提取笔记', action: () => extractRawNote(r.path) },
        { label: '提取知识图谱', action: () => graphRaw(r.path) },
        { sep: true },
        { label: isUrl ? '查看（浏览器打开）' : '查看（本机打开）', action: () => openRawNative(r.path) },
        ...(isUrl ? [{ label: '改名', action: () => renameRawUrl(r) }] : []),
        { label: isRef ? '解除引用' : '删除', danger: true, action: () => deleteRaw(r.path) },
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
    // 折叠状态：一级、二级默认收起，三级及更深默认展开（与笔记目录树策略一致；展开二级后其下全部可见）
    const defaultCollapsed = (d) => d <= 1;
    const isCollapsed = (key, d) => (key in rawTreeCollapsed) ? rawTreeCollapsed[key] : defaultCollapsed(d);
    const folderHeader = (name, count, key, depth, files, rootDir) => {
      const collapsed = isCollapsed(key, depth);
      const fh = document.createElement('div');
      fh.className = 'wiki-domain-title wiki-group-toggle';
      fh.style.paddingLeft = (10 + depth * 14) + 'px';
      fh.title = '右键：对该目录提取笔记 / 知识图谱';
      fh.innerHTML = `<span class="chevron${collapsed ? ' collapsed' : ''}">▾</span> ${icoSvg('folder-open', 13)} ${escapeHtml(name)} <span class="wiki-group-count">${count}</span>`;
      // 根目录行提供可见的「解除」按钮（仅移除引用，不删本机文件）
      if (rootDir) {
        const btn = document.createElement('button');
        btn.className = 'btn btn-ghost danger raw-dir-del';
        btn.textContent = '解除';
        btn.title = '解除整个目录引用（不删除本机文件）';
        btn.addEventListener('click', (e) => { e.stopPropagation(); removeRawDir(rootDir, name, count); });
        fh.appendChild(btn);
      }
      fh.addEventListener('click', () => { rawTreeCollapsed[key] = !collapsed; renderRawList(); });
      // 右键菜单：对整个目录提取笔记 / 知识图谱；根目录额外支持整个目录解除引用
      fh.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const paths = files.map((f) => f.path);
        // 右键菜单只管提取；解除引用走目录行右侧的可见「解除」按钮，避免两处重复
        const items = [
          { label: `提取笔记（${paths.length} 个文件）`, action: () => extractRawNotes(paths, name) },
          { label: `提取知识图谱（${paths.length} 个文件）`, action: () => graphRawPaths(paths, name) },
        ];
        openCtxMenu(e.clientX, e.clientY, items);
      });
      return fh;
    };
    const renderNode = (node, depth, prefix) => {
      for (const [name, child] of [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const key = 'rawdir:' + prefix + '/' + name;
        box.appendChild(folderHeader(name, countAll(child), key, depth, collectFiles(child)));
        if (!isCollapsed(key, depth)) renderNode(child, depth + 1, prefix + '/' + name);
      }
      node.files.slice().sort((a, b) => String(a.name).localeCompare(String(b.name))).forEach((f) => {
        box.appendChild(makeRow(f, 12 + depth * 14));
      });
    };
    const rootKey = 'rawdir:' + root;
    box.appendChild(folderHeader(pathBasename(root), refs.length, rootKey, 0, refs, root));
    if (!isCollapsed(rootKey, 0)) renderNode(tree, 1, root);
  }
}

function pathBasename(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

// ---------- 右键菜单（原始文件/目录提取笔记与知识图谱） ----------
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

// 目录级批量提取知识图谱（提交前选领域：自动/指定/自动新建/手动新建）
async function graphRawPaths(paths, label) {
  if (!paths.length) { toast('该目录下暂无可提取的文件', 2500); return; }
  const extras = await pickDomainForExtract({ label, rawPaths: paths });
  if (!extras) return;
  const res = await window.kb.jobsSubmit({ type: 'graph', payload: { settings: state.settings, rawPaths: paths, ...extras } });
  if (!res.ok) { toast('提交作业失败：' + res.error, 4000); return; }
  toast(`已提交「${label}」生成图谱作业（${paths.length} 个文件）`);
  showJobsView();
}

// 查看原始文件：调用本机默认软件打开（桌面端 shell.openPath）
async function openRawNative(relPath) {
  const res = await window.kb.rawOpen({ settings: state.settings, relPath });
  if (!res.ok) toast(res.error || '打开失败', 3000);
}

async function extractRawNote(relPath) {
  const res = await window.kb.jobsSubmit({ type: 'extract-note', payload: { settings: state.settings, rawPaths: [relPath] } });
  if (!res.ok) { toast('提交提取笔记作业失败：' + (res.error || '未知错误'), 4000); return; }
  toast('提取笔记作业已提交');
  showJobsView();
}

async function extractRawNotes(paths, label) {
  if (!paths.length) { toast('该目录下暂无可提取的文件', 2500); return; }
  if (!confirm(`将「${label}」下 ${paths.length} 个来源提交为提取笔记作业，继续吗？`)) return;
  const res = await window.kb.jobsSubmit({ type: 'extract-note', payload: { settings: state.settings, rawPaths: paths } });
  if (!res.ok) { toast('提交提取笔记作业失败：' + (res.error || '未知错误'), 4000); return; }
  toast(`已提交「${label}」提取笔记作业（${paths.length} 个来源）`);
  showJobsView();
}

// 仅从该原始来源抽取知识图谱（作业管线 rawPaths 模式，提交前选领域）
async function graphRaw(relPath) {
  const extras = await pickDomainForExtract({ label: pathBasename(relPath), rawPaths: [relPath] });
  if (!extras) return;
  const res = await window.kb.jobsSubmit({ type: 'graph', payload: { settings: state.settings, rawPaths: [relPath], ...extras } });
  if (!res.ok) { toast('提交作业失败：' + res.error, 4000); return; }
  toast('生成图谱作业已提交');
  showJobsView();
}

async function deleteRaw(relPath) {
  const isLocal = String(relPath).startsWith('local:');
  const isUrl = String(relPath).startsWith('url:');
  if (isLocal || isUrl) {
    if (!confirm(`解除来源“${relPath}”的引用？\n仅移除引用，${isUrl ? '不会删除网页' : '本机文件不受影响'}；已提取的笔记与图谱不受影响。`)) return;
  } else if (!confirm(`删除原始来源“${relPath}”？已提取的笔记与图谱不受影响。`)) return;
  const res = await window.kb.rawRemove({ settings: state.settings, relPath });
  if (!res.ok) { toast('操作失败：' + res.error, 4000); return; }
  toast(isLocal || isUrl ? '已解除引用' : '已删除');
  loadRaws();
}

// 整个目录解除引用（仅移除知识库引用，不删除本机文件）
async function removeRawDir(dir, name, count) {
  if (!confirm(`解除目录“${name}”的整个引用（共 ${count} 个来源）？\n仅移除引用，本机文件不受影响；已提取的笔记与图谱不受影响。`)) return;
  const res = await window.kb.rawRemoveDir({ settings: state.settings, dir });
  if (!res.ok) { toast('解除失败：' + res.error, 4000); return; }
  toast(`已解除目录“${name}”的引用`);
  loadRaws();
}

async function addRawFiles() {
  const res = await window.kb.rawPickFiles();
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
  renderPickdirPath(res.dir);
  renderPickdirList(res);
  updatePickdirActions();
}

// 路径面包屑：逐段可点击回跳。
// 路径形式按当前目录自身判定（盘符/UNC 为 Windows，否则 POSIX）：
// 写死反斜杠会在 macOS/Linux 把 /Users/x 拼成相对路径 Users\x 而 ENOENT
function renderPickdirPath(dir) {
  const el = $('pickdir-path');
  el.innerHTML = '';
  const root = document.createElement('span');
  root.className = 'seg';
  root.innerHTML = icoSvg('storage', 13) + ' 此电脑';
  root.addEventListener('click', () => browseTo(''));
  el.appendChild(root);
  if (!dir) return;
  const isUnc = dir.startsWith('\\\\');
  const isWin = isUnc || /^[a-zA-Z]:[\\/]/.test(dir);
  const sepChar = isWin ? '\\' : '/';
  const segs = dir.split(/[\\/]/).filter(Boolean);
  let acc = '';
  for (const s of segs) {
    if (!acc) {
      if (isUnc) acc = '\\\\' + s;
      else if (isWin) acc = s.endsWith(':') ? s + '\\' : s;
      else acc = '/' + s;
    } else {
      acc = acc.endsWith(sepChar) ? acc + s : acc + sepChar + s;
    }
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
    row.innerHTML = `<span>${icoSvg('folder-open', 14)}</span><span class="pd-name">${escapeHtml(d.name)}</span><span class="pd-meta">文件夹</span>`;
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
    ext.title = supported ? '支持格式' : '非支持格式，导入时将跳过';
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
  const info = $('pickdir-info');
  // 长路径从头部省略，保留更关键的尾部（当前文件夹名）；完整路径放 tooltip
  const shortPath = (p, max = 52) => (p.length > max ? '…' + p.slice(-max) : p);
  info.textContent = pickdirState.dir ? '当前目录：' + shortPath(pickdirState.dir) : '请选择一个入口目录';
  info.title = pickdirState.dir || '';
  const bf = $('btn-pickdir-files');
  const bd = $('btn-pickdir-dir');
  bf.disabled = !n;
  bf.textContent = n ? `导入所选文件（${n}）` : '导入所选文件';
  bd.disabled = !pickdirState.dir;
  // 主按钮跟随当前选择：已勾选文件时以「导入所选文件」为主，
  // 避免勾了文件却误点最显眼的蓝色按钮把整个目录导了进来
  bf.className = 'btn ' + (n ? 'btn-primary' : 'btn-ghost');
  bd.className = 'btn ' + (n ? 'btn-ghost' : 'btn-primary');
}

// 本地导入的统一入口：桌面端走浏览弹窗（文件与目录都能选）；
// 网页模式拿不到本机路径，退回浏览器文件上传
async function addRawLocal() {
  if (window.__KB_WEB__) return addRawFiles();
  return addRawDir();
}

async function addRawDir() {
  if (window.__KB_WEB__) { toast('网页模式无法浏览本机目录，已改为文件上传', 3200); return addRawFiles(); }
  const paths = await openPickDir();
  if (!paths || !paths.length) return;
  toast('正在导入所选文件/目录，请稍候…', 3000);
  const r = await window.kb.rawAddDir({ settings: state.settings, paths });
  if (!r.ok) { toast('导入失败：' + r.error, 4000); return; }
  const failed = r.failed || [];
  // 超上限等拒绝原因需直接告知，否则只看到“N 个失败”无法得知为何
  if (failed.length) {
    const first = failed[0];
    toast(`${r.added ? `已导入 ${r.added} 个文件；` : ''}${failed.length} 项未导入：${first.error || ''}${failed.length > 1 ? `（共 ${failed.length} 项）` : ''}`, 7000);
  } else {
    toast(`已导入 ${r.added} 个文件${r.skipped ? `，超上限跳过 ${r.skipped} 个` : ''}`, 3600);
  }
  loadRaws();
}

// 判断返回的标题是否为 URL 兜底名（与主进程 urlDisplayName 规则一致）：
// 是则说明服务端没读到真标题（需登录/超时等），需要让用户补填
function isUrlFallbackTitle(title, url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop() || '';
    const fallback = decodeURIComponent(seg ? `${u.hostname}/${seg}` : u.hostname);
    return !title || title === fallback || title === u.hostname;
  } catch (_) {
    return !title;
  }
}

// 添加链接：只保存链接信息（不下载正文/不转存 md），只取一次网页标题做展示名。
// 需登录的站点可填用户名/密码：弹出应用内登录窗时自动填充，登录态（Cookie）会被持久化保留，
// 之后问答/提取读取该链接正文时自动带上登录态。
async function addRawUrl() {
  const form = await askForm('添加网页链接', [
    { key: 'url', label: '网页链接（http/https）', placeholder: 'https://example.com/article', required: true },
    { key: 'username', label: '用户名（可选，需登录的站点填写）', placeholder: '留空表示无需登录' },
    { key: 'password', label: '密码（可选）', placeholder: '留空表示无需登录', type: 'password' },
  ], { tip: '需登录的站点（如语雀/飞书）填上账号密码，登录窗会自动填充；登录成功后登录态会被保留，读取正文时自动带上。' });
  if (!form) return;
  const url = (form.url || '').trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) { toast('链接需以 http:// 或 https:// 开头', 3000); return; }
  const credentials = (form.username || '').trim() || (form.password || '')
    ? { username: (form.username || '').trim(), password: form.password || '' }
    : undefined;
  // 仅保存链接信息（不下载正文/不转存 md）；主进程先匿名取标题，失败再隐藏窗真实渲染，
  // 需登录的站点会弹出应用内登录窗（登录一次后同站点后续链接自动带登录态）
  toast('正在读取网页标题…（需登录的页面会弹出登录窗）', 8000);
  const r = await window.kb.rawAddUrl({ settings: state.settings, url, credentials });
  if (!r.ok) { toast('添加失败：' + r.error, 4000); return; }
  loadRaws();
  if (!isUrlFallbackTitle(r.title, url)) { toast(`已添加：${r.title}`, 3000); return; }
  // 匿名/渲染/登录都取不到标题时：添加后立即让用户补填展示名，
  // 避免列表里一直显示 URL 兜底名；留空则维持域名/路径简名，之后仍可行内「改名」
  const name = await askInput(r.login ? '登录后仍未读到网页标题，请输入显示名称：' : '未能读到网页标题（页面可能需登录），请输入显示名称：', '', { placeholder: '留空用域名/路径简名' });
  if (!name || !name.trim()) { toast('已添加，可点行内「改名」补填显示名称', 4000); return; }
  const res = await window.kb.rawRenameUrl({ settings: state.settings, url: r.relPath, title: name.trim() });
  if (res.ok) toast(`已添加：${res.title}`, 3000);
  else toast('已添加，但命名失败：' + res.error, 4000);
  loadRaws();
}

// 改写链接的展示名：语雀/飞书这类登录后才渲染正文的页面，服务端取不到真标题，靠手改最省事
async function renameRawUrl(r) {
  const cur = String(r.name || '');
  const name = await askInput('链接显示名称：', cur, { placeholder: '留空则回退为域名/路径简名' });
  if (name === null || name === undefined) return;
  const res = await window.kb.rawRenameUrl({ settings: state.settings, url: r.path, title: name.trim() });
  if (!res.ok) { toast('改名失败：' + res.error, 4000); return; }
  toast(`已改名：${res.title}`);
  loadRaws();
}

function bindRawEvents() {
  $('nav-raws').addEventListener('click', showRawView);
  // 侧边栏「原始文件」右键：批量提取笔记 / 知识图谱
  $('nav-raws').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openCtxMenu(e.clientX, e.clientY, [
      { label: '全部来源提取笔记', action: () => extractRawNotes((state.raws || []).map((r) => r.path), '全部原始来源') },
      { label: '全部来源提取知识图谱', action: () => rawsToGraph() },
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
  $('btn-raw-add-dir').addEventListener('click', addRawLocal);
  $('btn-raw-add-url').addEventListener('click', addRawUrl);
  // 导入选择器弹窗：导入所选文件 / 导入当前目录 / 取消（点遮罩关闭）
  $('btn-pickdir-cancel').addEventListener('click', () => closePickDir(null));
  $('btn-pickdir-files').addEventListener('click', () => closePickDir([...pickdirState.selected]));
  $('btn-pickdir-dir').addEventListener('click', () => closePickDir([pickdirState.dir]));
  $('pickdir-modal').addEventListener('click', (e) => { if (e.target === $('pickdir-modal')) closePickDir(null); });
}

// 全部原始来源生成知识图谱
async function rawsToGraph() {
  const paths = (state.raws || []).map((r) => r.path);
  if (!paths.length) { toast('暂无原始来源', 2500); return; }
  if (!confirmRegen('graph')) return;
  const extras = await pickDomainForExtract({ label: '全部原始来源', rawPaths: paths });
  if (!extras) return;
  const res = await window.kb.jobsSubmit({ type: 'graph', payload: { settings: state.settings, rawPaths: paths, ...extras } });
  if (!res.ok) { toast('提交作业失败：' + res.error, 4000); return; }
  toast(`已提交「全部原始来源」生成图谱作业（${paths.length} 个来源）`);
  showJobsView();
}

