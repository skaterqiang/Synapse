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
    return { id: res.matched.id, name: res.matched.name, reason: res.matched.reason || res.reason || '', similarity: (typeof res.matched.similarity === 'number' ? res.matched.similarity : null), tpl: await findTpl(res.matched.id) };
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

// ---------- 提取前的领域判定（知识图谱抽取用 · AI 全自动） ----------
// 点击「提取知识图谱」即 AI 自主完成：按内容匹配已有领域 → 未命中则归纳并新建领域；
// 体系按来源内容实时匹配最贴合者（不读模版绑定）。全程进度流展示，用户确认后提交，「取消」放弃。

// 进度流：向弹窗追加一条判定步骤（返回该步骤元素，便于后续追加下拉等子控件）
function domainStep(text, cls) {
  const box = $('domain-progress');
  if (!box) return null;
  const div = document.createElement('div');
  div.className = 'domain-step' + (cls ? ' ' + cls : '');
  if (text) div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

// AI 判定领域并提交：进度展示 → 填充可编辑下拉 → 用户点「确认提取」才提交作业；「取消」放弃本次提取
// texts 为字符串数组（领域预匹配用）；inlineSources 为 {label,text} 数组（笔记图谱的作业来源）
async function autoDomainAndExtract({ label, rawPaths = [], texts = [], inlineSources = [] }) {
  const n = rawPaths.length || inlineSources.length || texts.length;
  $('domain-modal-title').textContent = '提取知识图谱';
  $('domain-modal-sub').textContent = `来源：${label || '当前选择'}${n ? `（${n} 个）` : ''}。AI 正判定领域与本体体系…`;
  $('domain-progress').innerHTML = '';
  $('domain-modal').hidden = false;
  const confirmBtn = $('btn-domain-confirm');
  confirmBtn.hidden = true;

  // 判定完成后持有的当前选择（可经下拉修改）：{ domainId, tpl, profileId }
  const sel = { domainId: 'general', tpl: null, profileId: 'bfo-lite' };
  let decided = false; // 是否已提交（避免重复提交）
  let cancelled = false; // 是否已点「取消」（取消后不再展示可确认的下拉/按钮）

  // 判定思考过程流：当前活动步骤的思考容器（reasoning 增量逐字追加；正文增量也显示，属最终 JSON 判定）
  let curThink = null;
  const mkThink = () => {
    const el = document.createElement('div');
    el.className = 'domain-think';
    const box = $('domain-progress');
    if (box) { box.appendChild(el); box.scrollTop = box.scrollHeight; }
    curThink = el;
    return el;
  };
  const feedThink = (chunk) => {
    if (!curThink || !chunk || !chunk.text) {
      return;
    }
    // 思考增量（reasoning）直接显示；正文增量也显示但加上前缀区分
    const text = chunk.reasoning ? chunk.text : `　[输出] ${chunk.text}`;
    curThink.textContent += text;
    const box = $('domain-progress');
    if (box) box.scrollTop = box.scrollHeight;
  };
  // 订阅三个判定步骤的思考流（领域匹配 / 体系匹配 / 领域归纳），函数结束时解绑
  const unbindMatch = (window.kb.onTplMatchChunk ? window.kb.onTplMatchChunk(feedThink) : null);
  const unbindProfile = (window.kb.onTplSuggestProfileChunk ? window.kb.onTplSuggestProfileChunk(feedThink) : null);
  const unbindName = (window.kb.onTplSuggestNameChunk ? window.kb.onTplSuggestNameChunk(feedThink) : null);
  const unbindThink = () => { if (unbindMatch) unbindMatch(); if (unbindProfile) unbindProfile(); if (unbindName) unbindName(); };

  const submitJob = async (extras) => {
    const payload = { settings: state.settings, ...extras };
    if (inlineSources.length) payload.inlineSources = inlineSources;
    else payload.rawPaths = rawPaths;
    const res = await window.kb.jobsSubmit({ type: 'graph', payload });
    if (!res.ok) { domainStep('✖ 提交作业失败：' + res.error, 'err'); toast('提交作业失败：' + res.error, 4000); return false; }
    return true;
  };

  // 以当前 sel 构造提交参数并提交（autoDomain=false：领域/体系均已确定，作业不再重复判定）
  const doSubmit = async () => {
    const extras = graphDomainExtras({ id: sel.domainId, name: sel.tpl ? sel.tpl.name : '通用', tpl: sel.tpl });
    extras.autoDomain = false;
    if (sel.profileId) extras.ontologyProfile = sel.profileId;
    return await submitJob(extras);
  };

  // 判定完成后：把「命中领域」「选定体系」两行替换为可编辑下拉，并显示「确认提取」
  const finalizeDecision = async () => {
    if (cancelled) return; // 用户已取消：不再渲染下拉与确认按钮
    // 确保下拉数据就绪
    if (!state.templates || !state.templates.length) state.templates = (await window.kb.tplList()) || [];
    const profiles = await getProfiles();
    // 领域下拉
    const dSel = document.createElement('select');
    dSel.className = 'domain-pick';
    for (const t of state.templates) {
      const o = document.createElement('option');
      o.value = t.id; o.textContent = t.name + (t.id === 'general' ? '（通用）' : '');
      dSel.appendChild(o);
    }
    dSel.value = sel.domainId;
    // 体系下拉
    const pSel = document.createElement('select');
    pSel.className = 'domain-pick';
    for (const p of profiles) {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = p.name || p.id;
      pSel.appendChild(o);
    }
    pSel.value = sel.profileId;
    const dRow = domainStep('', null); if (dRow) dRow.append('领域：', dSel);
    const pRow = domainStep('', null); if (pRow) pRow.append('体系：', pSel);
    // 说明体系来源：按来源内容从全部可用体系（内置三体系+导入 OWL）实时匹配最贴合者，可下拉更换（如改用 ISO 15926）
    const pNote = domainStep('　体系按内容实时匹配最贴合者（可在上方下拉更换，如改用 ISO 15926）', 'dim');
    // 切换领域仅改领域，不再联动改体系（体系按内容匹配，与所选领域无关）；体系仍可手动下拉更改
    dSel.addEventListener('change', () => {
      sel.domainId = dSel.value;
      sel.tpl = state.templates.find((t) => t.id === dSel.value) || null;
    });
    pSel.addEventListener('change', () => { sel.profileId = pSel.value; });
    $('domain-modal-sub').textContent = `来源：${label || '当前选择'}${n ? `（${n} 个）` : ''}。请确认领域与体系后开始提取。`;
    $('domain-progress-hint').textContent = '可下拉更改领域与体系；点「确认提取」开始，或「取消」放弃本次提取';
    confirmBtn.hidden = false;
    sel.ready = true;
  };

  // 确认提取：按当前下拉选择提交，随后关闭弹窗
  confirmBtn.onclick = async () => {
    if (decided || cancelled) return; decided = true;
    confirmBtn.disabled = true;
    domainStep(`③ 已确认：领域「${sel.tpl ? sel.tpl.name : '通用'}」/ 体系「${profileNameOf(sel.profileId)}」，提交作业…`, 'ok');
    const ok = await doSubmit();
    confirmBtn.disabled = false;
    if (ok) { $('domain-modal').hidden = true; confirmBtn.hidden = true; }
  };
  // 取消：关闭弹窗并放弃本次提取（不提交作业）；已提交则不动
  $('btn-domain-close').onclick = async () => {
    cancelled = true;
    unbindThink(); // 取消后不再接收思考增量
    $('domain-modal').hidden = true; confirmBtn.hidden = true;
  };

  // 前置建域：未命中已有领域时，直接在本流程内归纳并新建（不回退通用、不人工确认），随后纳入下拉供用户复核
  const autoCreateDomainNow = async () => {
    domainStep('② 未命中已有领域，按内容归纳并新建领域…', 'run');
    mkThink(); // 换领域归纳的思考流容器
    const sug = await window.kb.tplSuggestName({ settings: state.settings, rawPaths, texts });
    if (!sug.ok || !sug.name) { domainStep('✖ 领域归纳失败：' + (sug.error || '未归纳出名称'), 'err'); return null; }
    state.templates = (await window.kb.tplList()) || [];
    const exist = state.templates.find((t) => t.id !== 'general' && t.name === sug.name);
    if (exist) {
      domainStep(`✔ 归纳为「${sug.name}」，命中已有领域模版，直接复用`, 'ok');
      return { id: exist.id, name: exist.name, tpl: exist, reason: '同名已有领域，复用' };
    }
    domainStep(`✔ 归纳出新领域「${sug.name}」，AI 正在生成领域类并从 bfo-lite / bfo / iso15926 中选定本体体系…`, 'run');
    const gen = await window.kb.tplGenerate({ settings: state.settings, name: sug.name, desc: sug.desc || '' });
    if (!gen.ok || !gen.template) { domainStep('✖ 生成领域类失败：' + (gen.error || '未知错误'), 'err'); return null; }
    let g = gen.template;
    if (state.templates.some((t) => t.id === g.id && t.name !== sug.name)) g = { ...g, id: g.id + '_' + Date.now().toString(36) };
    const save = await window.kb.tplSave({ ...g, name: sug.name, desc: sug.desc || g.desc || '' });
    if (!save.ok || !save.template) { domainStep('✖ 领域保存失败：' + (save.error || '未知错误'), 'err'); return null; }
    const tpl = save.template;
    state.templates = (await window.kb.tplList()) || [];
    const clsN = Array.isArray(tpl.domainClasses) ? tpl.domainClasses.length : 0;
    domainStep(`✔ 已创建领域「${tpl.name}」（${tpl.id}）：${clsN} 个领域类`, 'ok');
    return { id: tpl.id, name: tpl.name, tpl, reason: '按内容自动新建' };
  };

  try {
    domainStep('① 按内容匹配已有领域…', 'run');
    mkThink(); // 挂领域匹配的思考流容器（reasoning 逐字追加）
    const domain = await checkDomainBeforeIngest({ rawPaths, texts, allowCreate: false, timeoutMs: GRAPH_MATCH_TIMEOUT });
    let finalDomain = null;
    if (domain && domain !== 'skip' && domain.id && domain.id !== 'general') {
      finalDomain = domain; // 命中已有领域
    } else if (domain === null || domain === 'skip') {
      domainStep('↷ 预匹配不可用，尝试直接建域', 'dim');
      finalDomain = await autoCreateDomainNow();
    } else {
      finalDomain = await autoCreateDomainNow(); // 未命中 → 自动新建（不回退通用）
    }

    if (finalDomain && finalDomain.id) {
      const tpl = finalDomain.tpl || {};
      sel.domainId = finalDomain.id;
      sel.tpl = tpl.id ? tpl : (state.templates.find((t) => t.id === finalDomain.id) || null);
      // 领域匹配结果 + 匹配度
      const dSim = (typeof finalDomain.similarity === 'number') ? `（匹配度 ${finalDomain.similarity}%）` : '';
      domainStep(`✔ 领域匹配「${finalDomain.name}」${dSim}`, 'ok');
      if (finalDomain.reason) {
        domainStep(`　判定理由：${finalDomain.reason}`, 'dim');
      }
      // 体系：优先使用模版绑定的体系；未绑定时才按内容实时匹配
      const tplProfile = sel.tpl && sel.tpl.ontologyProfile ? String(sel.tpl.ontologyProfile).trim() : '';
      if (tplProfile) {
        sel.profileId = tplProfile;
        const profName = profileNameOf(tplProfile);
        domainStep(`② 体系「${profName}」（复用领域模版绑定）`, 'ok');
      } else {
        // 模版未绑定体系：按来源内容实时匹配最贴合者
        domainStep('② 按内容匹配本体体系…', 'run');
        mkThink(); // 换体系匹配的思考流容器（后续 chunk 追加到新容器）
        try {
          const prof = await window.kb.tplSuggestProfile({ settings: state.settings, rawPaths, texts });
          if (prof && prof.ok && prof.id) {
            sel.profileId = prof.id;
            const simTxt = (typeof prof.similarity === 'number' && prof.similarity > 0) ? `（匹配度 ${prof.similarity}%）` : '';
            domainStep(`✔ 体系匹配「${prof.name || prof.id}」${simTxt}${prof.reason ? '：' + prof.reason : ''}`, 'ok');
          } else {
            sel.profileId = (state.settings && state.settings.ontologyProfile) || 'bfo-lite';
            domainStep('↷ 体系匹配不可用，回退默认体系（可下拉更改）', 'dim');
          }
        } catch (_) {
          sel.profileId = (state.settings && state.settings.ontologyProfile) || 'bfo-lite';
          domainStep('↷ 体系匹配失败，回退默认体系（可下拉更改）', 'dim');
        }
      }
      if (cancelled) return false; // 等待体系匹配期间用户已取消
      unbindThink(); // 判定完成，解绑思考订阅（弹窗仍开着等用户确认，但不再接收增量）
      await finalizeDecision();
      return true; // 已就绪，等待用户确认（不return提交结果）
    }
    // 建域也失败：仍给通用选项让用户确认后提取，而非静默跑
    domainStep('✖ 未能确定领域，已回退「通用」，可下拉更改或确认提取', 'err');
    sel.domainId = 'general'; sel.tpl = null;
    sel.profileId = (state.settings && state.settings.ontologyProfile) || 'bfo-lite';
    unbindThink();
    await finalizeDecision();
    return true;
  } catch (err) {
    unbindThink();
    domainStep('✖ 领域判定异常：' + err.message + '，改由作业内自动处理', 'err');
    return await submitJob({ autoDomain: true });
  }
}


// 图谱作业的领域信息：命中特定领域时按模板实体/概念类型组织节点（通用模板不加类型约束）
// domainId/domainLabel 无论是否命中都回传，作业卡片据此展示“本次按哪个领域抽取”
function graphDomainExtras(domain) {
  if (!domain || domain === 'skip') return { domainId: '', domainLabel: '通用（未做领域预检查）' };
  const base = { domainId: domain.id, domainLabel: domain.name };
  if (domain.id === 'general' || !domain.tpl) return base;
  const tpl = domain.tpl;
  // v2：优先从 domainClasses 派生（parent!==information→实体，=information→概念）；v1 回退 entityTypes/conceptTypes
  const classes = Array.isArray(tpl.domainClasses) ? tpl.domainClasses : [];
  const typeHints = classes.length
    ? {
        entity: classes.filter((c) => c.parent !== 'information').map((c) => c.label || c.key).filter(Boolean),
        concept: classes.filter((c) => c.parent === 'information').map((c) => c.label || c.key).filter(Boolean),
      }
    : {
        entity: (tpl.entityTypes || []).map((t) => t.name),
        concept: (tpl.conceptTypes || []).map((t) => t.name),
      };
  return { ...base, typeHints };
}

// ---------- 领域模版 ----------
// 本体体系清单缓存（供卡片徽章 / 编辑器下拉共用）
let tplProfileCache = null;
async function getProfiles() {
  if (!tplProfileCache) tplProfileCache = (await window.kb.graphProfiles()) || [];
  return tplProfileCache;
}
function profileNameOf(id) {
  const p = (tplProfileCache || []).find((x) => x.id === id);
  return p ? p.name : id;
}

let tplEditingId = null; // 当前编辑的模版 id（null = 新建）
let tplTouched = false; // 新建弹窗打开时不立即标红空必填项，用户输入或尝试创建后才显示
// 模版 v2 编辑器状态：当前绑定的 profile 树 + 已选领域类
let tplProfileTree = null;   // { classes[], predicates[], fallbackType }
let tplSelClasses = [];      // [{key,label,parent,desc,examples,from}]

// 加载并渲染指定 profile 的类树复选框
async function loadTplProfileTree(profileId) {
  const res = await window.kb.tplProfileTree(profileId || 'bfo-lite');
  if (!res || !res.ok) { tplProfileTree = null; return; }
  tplProfileTree = res;
  const pd = $('tpl-ontology-profile-desc');
  if (pd) pd.textContent = `${res.profileName} · ${res.classes.length} 个体系类`;
  renderTplClassTree();
}

// 类树复选框：按 parent 分层缩进展示。勾选体系类=纳入领域类（from:'base'）；
// 每个体系类行尾有「+子类」按钮，点击在该类下内联新建领域子类（父类自动确定，无需手填 key）；
// 已建领域子类（from:'custom'）内联缩进显示在其父类下方，直观展现「挂在哪个体系类下」的层级关系。
function renderTplClassTree() {
  const box = $('tpl-classtree');
  if (!box) return;
  if (!tplProfileTree) { box.innerHTML = '<div class="list-empty">体系加载失败</div>'; return; }
  const classes = tplProfileTree.classes || [];
  const selKeys = new Set(tplSelClasses.filter((c) => c.from === 'base').map((c) => c.key));
  const childrenOf = (p) => classes.filter((c) => (c.parent || '') === p);
  // 已建领域子类按 parent 分组，便于内联挂到对应节点下（父类可以是体系类或另一个领域子类）
  const customUnder = (p) => tplSelClasses.filter((c) => c.from === 'custom' && (c.parent || '') === p);
  const roots = classes.filter((c) => !c.parent || !classes.some((x) => x.key === c.parent));
  box.innerHTML = '';

  // 渲染一个「领域子类」节点（可含下级领域子类），indent 为像素缩进
  const renderCustom = (cc, indent) => {
    const row = document.createElement('div');
    row.className = 'tpl-classtree-row tpl-classtree-custom';
    row.style.paddingLeft = indent + 'px';
    // 名称优先显示（不收缩）；描述收缩省略，hover 名称时 tooltip 展示完整描述
    row.innerHTML = `<span class="tpl-sub-badge">子类</span><span class="tpl-sub-label" title="${escapeHtml(cc.desc || '')}">${escapeHtml(cc.label || cc.key)}</span>${cc.desc ? `<code class="tpl-sub-desc-text">${escapeHtml(cc.desc)}</code>` : ''}`;
    const addSub = document.createElement('button');
    addSub.className = 'tpl-addsub';
    addSub.title = '在该子类下再新建领域子类';
    addSub.innerHTML = icoSvg('add', 11) + '子类';
    addSub.addEventListener('click', () => openTplSubclassForm(cc.key, row, indent + 18));
    const del = document.createElement('button');
    del.className = 'icon-btn danger tpl-sub-del';
    del.title = '移除该领域子类';
    del.innerHTML = icoSvg('close', 11);
    del.addEventListener('click', () => {
      // 连同其所有后代领域子类一并移除
      const rmKeys = new Set([cc.key]);
      let grew = true;
      while (grew) { grew = false; tplSelClasses.forEach((x) => { if (x.from === 'custom' && rmKeys.has(x.parent) && !rmKeys.has(x.key)) { rmKeys.add(x.key); grew = true; } }); }
      tplSelClasses = tplSelClasses.filter((x) => !(x.from === 'custom' && rmKeys.has(x.key)));
      renderTplClassTree();
      updateTplValidation();
    });
    row.appendChild(addSub);
    row.appendChild(del);
    box.appendChild(row);
    // 正在该子类下新建 → 紧贴其下渲染输入行
    if (tplSubForm && tplSubForm.parent === cc.key) renderSubForm(row, indent + 18, cc);
    customUnder(cc.key).forEach((sub) => renderCustom(sub, indent + 18));
  };

  // 渲染一个「体系类」节点（复选框 + 「+子类」按钮），随后内联其领域子类与体系子类
  const walk = (c, depth) => {
    const indent = depth * 18 + 6;
    const row = document.createElement('label');
    row.className = 'tpl-classtree-row';
    row.style.paddingLeft = indent + 'px';
    row.title = `${c.key}：${c.desc || c.label || c.key}`;
    row.innerHTML = `<input type="checkbox" data-ck="${escapeHtml(c.key)}" ${selKeys.has(c.key) ? 'checked' : ''} />
      <code>${escapeHtml(c.key)}</code>${c.label && c.label !== c.key ? `<span>${escapeHtml(c.label)}</span>` : ''}`;
    const addSub = document.createElement('button');
    addSub.className = 'tpl-addsub';
    addSub.title = `在「${c.label || c.key}」下新建领域子类`;
    addSub.innerHTML = icoSvg('add', 11) + '子类';
    addSub.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openTplSubclassForm(c.key, row, indent + 18); });
    row.appendChild(addSub);
    box.appendChild(row);
    // 正在该体系类下新建 → 紧贴其下渲染输入行
    if (tplSubForm && tplSubForm.parent === c.key) renderSubForm(row, indent + 18, c);
    // 该体系类下已建的领域子类（内联缩进展示挂载关系）
    customUnder(c.key).forEach((sub) => renderCustom(sub, indent + 18));
    // 体系子类（继续递归）
    childrenOf(c.key).forEach((ch) => walk(ch, depth + 1));
  };
  roots.forEach((r) => walk(r, 0));

  // 父类已被删除的「孤儿」领域子类（体系切换后可能失配）：兜底显示在末尾，避免丢失
  const validParents = new Set([...classes.map((c) => c.key), ...tplSelClasses.filter((c) => c.from === 'custom').map((c) => c.key)]);
  const orphans = tplSelClasses.filter((c) => c.from === 'custom' && !validParents.has(c.parent || ''));
  orphans.forEach((cc) => {
    const row = document.createElement('div');
    row.className = 'tpl-classtree-row tpl-classtree-custom tpl-classtree-orphan';
    row.style.paddingLeft = '6px';
    row.title = `父类「${cc.parent}」不在当前体系，保存时将挂到兜底类 ${tplProfileTree.fallbackType}`;
    row.innerHTML = `<span class="tpl-sub-badge orphan">失配</span><span class="tpl-sub-label">${escapeHtml(cc.label || cc.key)}</span><code>⊂ ${escapeHtml(cc.parent)}</code>`;
    const del = document.createElement('button');
    del.className = 'icon-btn danger tpl-sub-del';
    del.innerHTML = icoSvg('close', 11);
    del.addEventListener('click', () => { tplSelClasses = tplSelClasses.filter((x) => x !== cc); renderTplClassTree(); updateTplValidation(); });
    row.appendChild(del);
    box.appendChild(row);
  });

  box.querySelectorAll('input[type=checkbox]').forEach((cb) => cb.addEventListener('change', () => {
    const key = cb.dataset.ck;
    const cls = classes.find((c) => c.key === key);
    if (cb.checked && cls) {
      if (!tplSelClasses.some((x) => x.key === key && x.from === 'base')) {
        tplSelClasses.push({ key: cls.key, label: cls.label || cls.key, parent: cls.parent || '', desc: cls.desc || '', examples: cls.examples || [], from: 'base' });
      }
    } else {
      tplSelClasses = tplSelClasses.filter((x) => !(x.key === key && x.from === 'base'));
    }
    renderTplSelClasses();
    updateTplValidation();
  }));
  renderTplSelClasses();
}

// 领域子类内联输入表单状态：{ parent, anchorEl, indent }；同时只允许一个
let tplSubForm = null;
// 在 anchorEl 后插入「新建领域子类」输入行：名称 + 说明，确定/取消。父类已确定为 parent，无需手填
function openTplSubclassForm(parent, anchorEl, indent) {
  tplSubForm = { parent };
  renderTplClassTree(); // 重渲后由 renderSubForm 在对应父节点下渲染输入行（indent 由 renderSubForm 依据父类重算）
}
// renderTplClassTree 内部调用：在父节点行后渲染输入行并聚焦
function renderSubForm(parentRow, indent, parentCls) {
  const form = document.createElement('div');
  form.className = 'tpl-classtree-row tpl-subform';
  form.style.paddingLeft = indent + 'px';
  form.innerHTML = `
    <span class="tpl-sub-badge new">新建子类</span>
    <input type="text" class="tpl-sub-name" placeholder="子类名称（中文），如：报批流程" maxlength="30" />
    <input type="text" class="tpl-sub-desc" placeholder="一句话说明（可选）" maxlength="100" />
    <button class="btn btn-primary tpl-sub-ok">确定</button>
    <button class="btn btn-ghost tpl-sub-cancel">取消</button>`;
  parentRow.after(form);
  const nameI = form.querySelector('.tpl-sub-name');
  const descI = form.querySelector('.tpl-sub-desc');
  nameI.focus();
  const parentLabel = parentCls ? (parentCls.label || parentCls.key) : tplSubForm.parent;
  nameI.title = `将在「${parentLabel}」下新建领域子类`;
  const cancel = () => { tplSubForm = null; renderTplClassTree(); };
  const commit = () => {
    const label = nameI.value.trim();
    if (!label) { toast('请填写子类名称'); nameI.focus(); return; }
    if (tplSelClasses.some((c) => c.key === label)) { toast('已存在同名领域类：' + label); nameI.focus(); return; }
    tplSelClasses.push({ key: label, label, parent: tplSubForm.parent, desc: descI.value.trim(), examples: [], from: 'custom' });
    tplSubForm = null;
    renderTplClassTree();
    updateTplValidation();
  };
  form.querySelector('.tpl-sub-ok').addEventListener('click', commit);
  form.querySelector('.tpl-sub-cancel').addEventListener('click', cancel);
  nameI.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') cancel(); });
  descI.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') cancel(); });
}

// 右侧已选领域类列表（含 base 勾选 + custom 子类），custom 可删除
function renderTplSelClasses() {
  const box = $('tpl-classtree-sel');
  if (!box) return;
  const cnt = $('tpl-class-count');
  if (cnt) cnt.textContent = tplSelClasses.length;
  box.innerHTML = tplSelClasses.map((c, i) => `
    <div class="tpl-sel-row" title="${escapeHtml(c.key)}">
      <div class="sel-main">
        <span>${escapeHtml(c.label || c.key)}</span>
        <code>${escapeHtml(c.key)}</code><em>${c.from === 'base' ? '体系类' : '领域子类' + (c.parent ? ' ⊂ ' + c.parent : '')}</em>
      </div>
      ${c.from === 'base' ? '' : `<button class="icon-btn danger" data-i="${i}" title="移除">${icoSvg('close', 11)}</button>`}
    </div>`).join('') || '<div class="list-empty">尚未选择，左侧勾选体系类或添加领域子类</div>';
  box.querySelectorAll('button[data-i]').forEach((b) => b.addEventListener('click', () => {
    tplSelClasses.splice(Number(b.dataset.i), 1);
    renderTplClassTree(); // 重渲以同步复选态（custom 删除不影响 base 勾选，但保持一致）
    updateTplValidation();
  }));
}

// 添加领域子类（入口按钮）：默认挂到体系兜底类下，等价于在该类点「+子类」。
// 类树中每个体系类/领域子类行尾的「+子类」按钮才是主入口（父类自动确定，所见即所得）；此按钮作为无体系树时的兜底。
function addTplSubclass() {
  if (!tplProfileTree) return;
  openTplSubclassForm(tplProfileTree.fallbackType, null, 0);
}

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
        <span class="tpl-badge-profile">${escapeHtml(profileNameOf(t.ontologyProfile || 'bfo-lite'))}</span>
        <span>领域类: ${(t.domainClasses || t.entityTypes || []).length}</span>
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

// 填充体系绑定下拉（内置三体系 + OWL），并初始化领域类编辑器状态
async function fillTplProfilePicker(tpl) {
  const profiles = await getProfiles();
  const sel = $('tpl-ontology-profile');
  sel.innerHTML = profiles.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}${p.owl ? '（OWL）' : ''}</option>`).join('');
  const pid = (tpl && tpl.ontologyProfile) || 'bfo-lite';
  sel.value = pid;
  // 初始化已选领域类：v2 直读；v1 旧模版由后端迁移为 domainClasses（兼容兜底）
  tplSelClasses = (tpl && Array.isArray(tpl.domainClasses) ? tpl.domainClasses : []).map((c) => ({ key: c.key, label: c.label || c.key, parent: c.parent || '', desc: c.desc || '', examples: c.examples || [], from: c.from === 'base' ? 'base' : 'custom' }));
  await loadTplProfileTree(pid);
}

async function openTplModal(tpl, forceNew) {
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
  await fillTplProfilePicker(tpl);
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
  // 领域类非空校验（勾选或添加任意一个即可）
  const classBad = tplSelClasses.length === 0;
  $('tpl-class-warn').hidden = !classBad;
  if (classBad) ok = false;
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
    ontologyProfile: $('tpl-ontology-profile').value || 'bfo-lite',
    domainClasses: tplSelClasses,
  });
  if (!res.ok) { toast('保存失败：' + res.error, 4000); return; }
  if (res.template && Array.isArray(res.template._warnings) && res.template._warnings.length) {
    toast('已保存，但存在体系告警：' + res.template._warnings[0], 5000);
  }
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
  setTplGenStatus('生成阶段：AI 正在按名称补全模版 ID、关键词、体系绑定与领域类…', 'running');
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
    // v2 生成：回填体系绑定 + 领域类
    if (t.ontologyProfile) {
      $('tpl-ontology-profile').value = t.ontologyProfile;
      await loadTplProfileTree(t.ontologyProfile);
    }
    if (Array.isArray(t.domainClasses)) {
      tplSelClasses = t.domainClasses.map((c) => ({ key: c.key, label: c.label || c.key, parent: c.parent || '', desc: c.desc || '', examples: c.examples || [], from: c.from === 'base' ? 'base' : 'custom' }));
      renderTplClassTree();
    }
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
  // 领域判定弹窗：「取消」「确认提取」的点击行为在 autoDomainAndExtract 内按需绑定（含提交作业）
  $('btn-tpl-save').addEventListener('click', saveTplForm);
  $('btn-tpl-ai').addEventListener('click', runTplGenerate);
  $('btn-tpl-add-subclass').addEventListener('click', addTplSubclass);
  $('tpl-ontology-profile').addEventListener('change', () => {
    // 切换体系：base 勾选仅保留仍存在于新体系的 key，custom 保留（保存时后端再校验重挂）
    const keep = (tplProfileTree ? tplProfileTree.classes.map((c) => c.key) : []);
    loadTplProfileTree($('tpl-ontology-profile').value).then(() => {
      const now = new Set((tplProfileTree ? tplProfileTree.classes.map((c) => c.key) : keep));
      tplSelClasses = tplSelClasses.filter((c) => c.from === 'custom' || now.has(c.key));
      renderTplClassTree();
      updateTplValidation();
    });
  });
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

// 目录级批量提取知识图谱（AI 自主判定领域与体系，进度流展示）
async function graphRawPaths(paths, label) {
  if (!paths.length) { toast('该目录下暂无可提取的文件', 2500); return; }
  const ok = await autoDomainAndExtract({ label, rawPaths: paths });
  if (!ok) return;
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

// 仅从该原始来源抽取知识图谱（AI 自主判定领域与体系）
async function graphRaw(relPath) {
  const ok = await autoDomainAndExtract({ label: pathBasename(relPath), rawPaths: [relPath] });
  if (!ok) return;
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
  const ok = await autoDomainAndExtract({ label: '全部原始来源', rawPaths: paths });
  if (!ok) return;
  toast(`已提交「全部原始来源」生成图谱作业（${paths.length} 个来源）`);
  showJobsView();
}

