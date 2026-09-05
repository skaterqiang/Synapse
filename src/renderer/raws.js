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

// 卡片化步骤：序号圆点 + 标题 + 状态，结果/理由/思考流挂在卡片内
function domainCard(idx, title, state) {
  const box = $('domain-progress');
  if (!box) return null;
  const card = document.createElement('div');
  card.className = 'domain-card' + (state ? ' ' + state : '');
  const head = document.createElement('div');
  head.className = 'domain-card-head';
  const dot = document.createElement('span');
  dot.className = 'domain-card-idx';
  dot.textContent = idx;
  const t = document.createElement('span');
  t.textContent = title;
  const st = document.createElement('span');
  st.className = 'domain-card-status';
  head.append(dot, t, st);
  card.appendChild(head);
  box.appendChild(card);
  box.scrollTop = box.scrollHeight;
  return card;
}

// 向卡片追加一行内容（结果徽章行 / 备注块）
function domainCardRow(card, cls) {
  if (!card) return null;
  const row = document.createElement('div');
  row.className = cls || 'domain-note';
  card.appendChild(row);
  const box = $('domain-progress');
  if (box) box.scrollTop = box.scrollHeight;
  return row;
}

// 结果徽章行：主徽章（如领域名）+ 可选副徽章（如匹配度）
function domainBadgeRow(card, mainText, subText, isErr) {
  const row = domainCardRow(card, 'domain-result');
  if (!row) return;
  const badge = document.createElement('span');
  badge.className = 'domain-badge' + (isErr ? ' err' : '');
  badge.textContent = mainText;
  row.appendChild(badge);
  if (subText) {
    const sub = document.createElement('span');
    sub.className = 'domain-badge sim';
    sub.textContent = subText;
    row.appendChild(sub);
  }
}

// 设置卡片状态（running → done / failed）
function domainCardState(card, state, statusText) {
  if (!card) return;
  card.classList.remove('running', 'done', 'failed');
  if (state) card.classList.add(state);
  const st = card.querySelector('.domain-card-status');
  if (st) st.textContent = statusText || '';
}

// AI 判定领域并提交：进度展示 → 填充可编辑下拉 → 用户点「确认提取」才提交作业；「取消」放弃本次提取
// texts 为字符串数组（领域预匹配用）；inlineSources 为 {label,text} 数组（笔记图谱的作业来源）
// 多领域拆分提取：识别全部内聚领域 → 逐文件分类（多归属+置信度）→ 逐领域准备模版/体系 → 清单确认 → 每领域独立作业
async function autoDomainAndExtract({ label, rawPaths = [], texts = [], inlineSources = [] }) {
  const n = rawPaths.length || inlineSources.length || texts.length;
  $('domain-modal-title').textContent = '提取知识图谱';
  $('domain-modal-sub').textContent = `来源：${label || '当前选择'}${n ? `（${n} 个）` : ''}。AI 正判定领域与本体体系…`;
  $('domain-progress').innerHTML = '';
  $('domain-modal').hidden = false;
  const confirmBtn = $('btn-domain-confirm');
  confirmBtn.hidden = true;

  // 多领域分组清单：每元素对应一个待提交作业。同一文件可出现在多个组的 fileRefs（多归属）
  // { key, domainId, tpl, profileId, fileRefs:[{rawPath,confidence}], inlineKeys:[label], checked }
  let groups = [];
  let decided = false; // 是否已提交（避免重复提交）
  let cancelled = false; // 是否已点「取消」（取消后不再展示可确认的下拉/按钮）

  // 判定思考过程流：当前活动步骤的思考容器（reasoning 增量逐字追加；正文增量也显示，属最终 JSON 判定）
  // 进行中的步骤自动展开并实时滚动到底；该步骤结束后自动折叠为「查看思考过程 ▸」。parent 为宿主卡片
  let curThink = null;
  const setThinkOpen = (el, open) => {
    if (!el) return;
    el.classList.toggle('open', open);
    const toggle = el._toggle;
    if (toggle) {
      toggle.classList.toggle('open', open);
      toggle.querySelector('.tt').textContent = open ? '收起思考过程' : '查看思考过程';
    }
  };
  const mkThink = (parent) => {
    // 切换到新的思考容器前，折叠上一个进行中的思考流（步骤推进时自动收起）
    if (curThink) setThinkOpen(curThink, false);
    const box = $('domain-progress');
    const host = parent || box;
    const toggle = document.createElement('div');
    toggle.className = 'domain-think-toggle';
    toggle.innerHTML = '<span class="chevron">▶</span><span class="tt">收起思考过程</span>';
    const el = document.createElement('div');
    el.className = 'domain-think open';
    toggle.classList.add('open');
    toggle.addEventListener('click', () => setThinkOpen(el, !el.classList.contains('open')));
    if (host) { host.append(toggle, el); box.scrollTop = box.scrollHeight; }
    curThink = el;
    curThink._toggle = toggle;
    return el;
  };
  const collapseThink = () => { if (curThink) setThinkOpen(curThink, false); };
  const feedThink = (chunk) => {
    if (!curThink || !chunk || !chunk.text) {
      return;
    }
    const text = chunk.reasoning ? chunk.text : `　[输出] ${chunk.text}`;
    curThink.textContent += text;
    curThink.scrollTop = curThink.scrollHeight;
    const box = $('domain-progress');
    if (box) box.scrollTop = box.scrollHeight;
  };
  // 订阅思考流：领域匹配/体系匹配/领域归纳/领域类生成/多领域归纳/文件归类，函数结束时解绑
  const unbindMatch = (window.kb.onTplMatchChunk ? window.kb.onTplMatchChunk(feedThink) : null);
  const unbindProfile = (window.kb.onTplSuggestProfileChunk ? window.kb.onTplSuggestProfileChunk(feedThink) : null);
  const unbindName = (window.kb.onTplSuggestNameChunk ? window.kb.onTplSuggestNameChunk(feedThink) : null);
  const unbindGen = (window.kb.onTplGenChunk ? window.kb.onTplGenChunk(feedThink) : null);
  const unbindSugDom = (window.kb.onTplSuggestDomainsChunk ? window.kb.onTplSuggestDomainsChunk(feedThink) : null);
  const unbindAssign = (window.kb.onTplAssignDomainsChunk ? window.kb.onTplAssignDomainsChunk(feedThink) : null);
  const unbindThink = () => { if (unbindMatch) unbindMatch(); if (unbindProfile) unbindProfile(); if (unbindName) unbindName(); if (unbindGen) unbindGen(); if (unbindSugDom) unbindSugDom(); if (unbindAssign) unbindAssign(); collapseThink(); };

  // 提交单个分组的作业（携带该组勾选文件子集；autoDomain=false，领域/体系已定，作业内不再判定）
  const submitGroup = async (g) => {
    const extras = graphDomainExtras({ id: g.domainId, name: g.tpl ? g.tpl.name : '通用', tpl: g.tpl });
    extras.autoDomain = false;
    if (g.profileId) extras.ontologyProfile = g.profileId;
    const payload = { settings: state.settings, ...extras };
    const checkedInline = (g.inlineKeys || []).filter((k) => !g.fileChecked || g.fileChecked['inline:' + k] !== false);
    const checkedRefs = (g.fileRefs || []).filter((f) => !g.fileChecked || g.fileChecked[f.rawPath] !== false);
    if (!checkedRefs.length && !checkedInline.length) { toast(`「${g.tpl ? g.tpl.name : '通用'}」未勾选任何文件`, 2500); return false; }
    if (checkedInline.length) {
      payload.inlineSources = inlineSources.filter((s) => checkedInline.includes(String(s.label || '')));
    } else {
      payload.rawPaths = checkedRefs.map((f) => f.rawPath);
    }
    const res = await window.kb.jobsSubmit({ type: 'graph', payload });
    if (!res.ok) { domainStep('✖ 提交作业失败：' + res.error, 'err'); toast('提交作业失败：' + res.error, 4000); return false; }
    return true;
  };

  // 批量提交：循环勾选的分组，每组一个 graph 作业
  const doSubmitAll = async () => {
    const targets = groups.filter((g) => g.checked && ((g.fileRefs && g.fileRefs.length) || (g.inlineKeys && g.inlineKeys.length)));
    if (!targets.length) { toast('请至少勾选一个领域'); return false; }
    let ok = 0;
    for (const g of targets) { if (await submitGroup(g)) ok++; }
    return ok > 0;
  };

  // 确认清单：每组一行（☑ 领域下拉 | n 个文件 | 体系下拉 | ✕），文件明细带置信度，低置信标「?」
  const finalizeDecisionMulti = async () => {
    if (cancelled) return;
    if (!state.templates || !state.templates.length) state.templates = (await window.kb.tplList()) || [];
    const profiles = await getProfiles();
    const box = $('domain-progress');
    const confirm = document.createElement('div');
    confirm.className = 'domain-confirm';
    const cTitle = document.createElement('div');
    cTitle.className = 'domain-confirm-title';
    cTitle.textContent = '✔ 请确认提取配置（将为每个勾选领域各提交一个作业）';
    confirm.appendChild(cTitle);
    // 统计每个文件出现在几个组（多归属提示用）
    const fileGroupCount = {};
    for (const g of groups) for (const f of (g.fileRefs || [])) fileGroupCount[f.rawPath] = (fileGroupCount[f.rawPath] || 0) + 1;

    for (const g of groups) {
      // 初始化文件勾选状态（默认全选）
      if (!g.fileChecked) {
        g.fileChecked = {};
        for (const f of (g.fileRefs || [])) g.fileChecked[f.rawPath] = true;
        for (const k of (g.inlineKeys || [])) g.fileChecked['inline:' + k] = true;
      }
      // 卡片：标题行=☑+领域名（本体体系）+文件数+✕；二级=文件列表缩进换行
      const card = document.createElement('div');
      card.className = 'dgroup-card';
      // 标题行：☑ + 领域名（本体体系）+ 文件数 + ✕
      const head = document.createElement('div');
      head.className = 'dgroup-head';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = g.checked; cb.className = 'dgroup-cb';
      cb.title = '勾选该组（全选/反选组内文件）';
      const dName = document.createElement('span');
      dName.className = 'dgroup-title';
      const syncName = () => {
        const t = state.templates.find((x) => x.id === g.domainId);
        dName.textContent = `${t ? t.name : g.domainId}（${profileNameOf(g.profileId)}）`;
      };
      syncName();
      const cnt = document.createElement('span');
      cnt.className = 'dgroup-count';
      const updateCount = () => {
        const n = (g.fileRefs || []).filter((f) => g.fileChecked[f.rawPath] !== false).length
          + (g.inlineKeys || []).filter((k) => g.fileChecked['inline:' + k] !== false).length;
        cnt.textContent = `${n} 个文件`;
      };
      updateCount();
      const rm = document.createElement('button');
      rm.type = 'button'; rm.className = 'dgroup-rm'; rm.textContent = '✕'; rm.title = '移除该组';
      rm.addEventListener('click', () => { g.checked = false; card.style.display = 'none'; });
      head.append(cb, dName, cnt, rm);
      card.appendChild(head);
      // 调整行：领域下拉 + 体系下拉
      const adj = document.createElement('div');
      adj.className = 'dgroup-adj';
      const dSel = document.createElement('select');
      dSel.className = 'domain-pick dgroup-chg';
      dSel.title = '更改领域（模版）';
      for (const t of state.templates) {
        const o = document.createElement('option');
        o.value = t.id; o.textContent = '领域：' + t.name + (t.id === 'general' ? '（通用）' : '');
        dSel.appendChild(o);
      }
      dSel.value = g.domainId;
      dSel.addEventListener('change', () => {
        g.domainId = dSel.value;
        g.tpl = state.templates.find((t) => t.id === dSel.value) || null;
        syncName();
      });
      const pSel = document.createElement('select');
      pSel.className = 'domain-pick dgroup-profile';
      pSel.title = '本体体系';
      for (const p of profiles) {
        const o = document.createElement('option');
        o.value = p.id; o.textContent = '体系：' + (p.name || p.id);
        pSel.appendChild(o);
      }
      pSel.value = g.profileId;
      pSel.addEventListener('change', () => { g.profileId = pSel.value; syncName(); });
      adj.append(dSel, pSel);
      card.appendChild(adj);
      // 二级：该领域要抽取的文件列表（换行 + 缩进），每个文件带勾选框
      const fileList = (g.fileRefs || []).map((f) => ({ name: String(f.rawPath).split(/[\\/]/).pop(), conf: f.confidence, key: f.rawPath }))
        .concat((g.inlineKeys || []).map((k) => ({ name: k, conf: 1, key: 'inline:' + k })));
      const fileCbs = [];
      let det = null;
      if (fileList.length) {
        det = document.createElement('div');
        det.className = 'dgroup-files';
        for (const fi of fileList) {
          const chip = document.createElement('label');
          chip.className = 'dgroup-file';
          const fcb = document.createElement('input');
          fcb.type = 'checkbox'; fcb.checked = g.fileChecked[fi.key] !== false; fcb.className = 'dgroup-file-cb';
          fcb.addEventListener('change', () => {
            g.fileChecked[fi.key] = fcb.checked;
            chip.classList.toggle('off', !fcb.checked);
            updateCount();
            // 同步整组勾选状态
            const allOn = Object.values(g.fileChecked).every((v) => v !== false);
            const anyOn = Object.values(g.fileChecked).some((v) => v !== false);
            cb.checked = anyOn; g.checked = anyOn;
            cb.indeterminate = anyOn && !allOn;
            card.classList.toggle('off', !anyOn);
          });
          fileCbs.push(fcb);
          const confTxt = (typeof fi.conf === 'number') ? fi.conf.toFixed(2) : '';
          const low = (typeof fi.conf === 'number' && fi.conf < 0.6);
          const multi = fileGroupCount[fi.key] > 1;
          chip.appendChild(fcb);
          const nm = document.createElement('span');
          nm.className = 'dgroup-file-name';
          nm.textContent = fi.name;
          chip.appendChild(nm);
          if (multi) { const m = document.createElement('span'); m.className = 'dgroup-multi'; m.textContent = '（多归属）'; nm.appendChild(m); }
          if (confTxt) {
            const cf = document.createElement('span');
            cf.className = 'dgroup-file-conf' + (low ? ' low' : '');
            cf.textContent = confTxt + (low ? ' ?' : '');
            cf.title = low ? '归类把握较低，请人工核对' : '归类置信度';
            chip.appendChild(cf);
          }
          if (low) chip.classList.add('low');
          det.appendChild(chip);
        }
        card.appendChild(det);
      }
      // 组级勾选：全选/反选组内文件
      cb.addEventListener('change', () => {
        g.checked = cb.checked;
        for (const key of Object.keys(g.fileChecked)) g.fileChecked[key] = cb.checked;
        for (const fcb of fileCbs) fcb.checked = cb.checked;
        if (det) det.querySelectorAll('.dgroup-file').forEach((el) => el.classList.toggle('off', !cb.checked));
        updateCount();
        card.classList.toggle('off', !cb.checked);
      });
      if (!g.checked) card.classList.add('off');
      confirm.appendChild(card);
    }
    if (box) { box.appendChild(confirm); box.scrollTop = box.scrollHeight; }
    $('domain-modal-sub').textContent = `来源：${label || '当前选择'}${n ? `（${n} 个）` : ''}。勾选要提取的领域，点「确认提取」将为每个领域各提交一个作业。`;
    $('domain-progress-hint').textContent = '可下拉更改领域与体系；点「确认提取」开始，或「取消」放弃本次提取';
    confirmBtn.hidden = false;
  };

  // 确认提取：批量提交勾选分组，随后关闭弹窗
  confirmBtn.onclick = async () => {
    if (decided || cancelled) return; decided = true;
    confirmBtn.disabled = true;
    const c9 = domainCard('④', '已确认，批量提交提取作业', 'done');
    domainCardState(c9, 'done', '提交中');
    const ok = await doSubmitAll();
    domainCardState(c9, ok ? 'done' : 'failed', ok ? '已提交' : '失败');
    confirmBtn.disabled = false;
    if (ok) { $('domain-modal').hidden = true; confirmBtn.hidden = true; }
  };
  // 取消：关闭弹窗并放弃本次提取（不提交作业）；已提交则不动
  $('btn-domain-close').onclick = async () => {
    cancelled = true;
    unbindThink();
    $('domain-modal').hidden = true; confirmBtn.hidden = true;
  };

  // 按领域名准备模版：同名已有 → 复用；否则 AI 生成 + 保存。返回 { id, name, tpl }
  const prepareDomainTpl = async (name, desc) => {
    state.templates = (await window.kb.tplList()) || [];
    const exist = state.templates.find((t) => t.id !== 'general' && t.name === name);
    if (exist) return { id: exist.id, name: exist.name, tpl: exist, reused: true };
    const gen = await window.kb.tplGenerate({ settings: state.settings, name, desc: desc || '' });
    if (!gen.ok || !gen.template) return null;
    let g = gen.template;
    if (state.templates.some((t) => t.id === g.id && t.name !== name)) g = { ...g, id: g.id + '_' + Date.now().toString(36) };
    const save = await window.kb.tplSave({ ...g, name, desc: desc || g.desc || '' });
    if (!save.ok || !save.template) return null;
    state.templates = (await window.kb.tplList()) || [];
    return { id: save.template.id, name: save.template.name, tpl: save.template, reused: false };
  };

  try {
    // 卡片①：多领域识别
    const c1 = domainCard('①', '识别来源包含的领域', 'running');
    domainCardState(c1, 'running', '判定中');
    mkThink(c1);
    const sug = await window.kb.tplSuggestDomains({ settings: state.settings, rawPaths, texts });
    if (cancelled) return false;
    if (!sug.ok || !Array.isArray(sug.domains) || !sug.domains.length) {
      throw new Error(sug.error || '未能识别领域');
    }
    const domNames = sug.domains.map((d) => d.name);
    domainBadgeRow(c1, `${sug.domains.length} 个领域`, domNames.join('、'), false);
    domainCardState(c1, 'done', '已完成');

    // 卡片②：逐文件归类（多归属 + 置信度）
    const c2 = domainCard('②', '逐文件归类到领域', 'running');
    domainCardState(c2, 'running', '归类中');
    mkThink(c2);
    const asn = await window.kb.tplAssignDomains({ settings: state.settings, rawPaths, domains: sug.domains, inlineSources });
    if (cancelled) return false;
    const assignments = (asn && asn.ok && asn.assignments) ? asn.assignments : {};
    const unassigned = (asn && asn.ok && Array.isArray(asn.unassigned)) ? asn.unassigned : [];
    // 覆盖完整性断言：并集 + unassigned 应覆盖全部来源，否则回退单组通用
    const totalKeys = rawPaths.concat(inlineSources.map((s) => 'inline:' + String(s.label || '')));
    const covered = new Set(Object.keys(assignments).concat(unassigned));
    const allCovered = totalKeys.every((k) => covered.has(k));
    if (!asn.ok || !allCovered) {
      domainBadgeRow(c2, '归类不完整', asn.ok ? '覆盖断言失败' : (asn.error || '失败'), true);
      domainCardState(c2, 'failed', '回退单组');
      groups = [{ key: 'general', domainId: 'general', tpl: null, profileId: (state.settings && state.settings.ontologyProfile) || 'bfo-lite', fileRefs: rawPaths.map((p) => ({ rawPath: p, confidence: 1 })), inlineKeys: inlineSources.map((s) => String(s.label || '')), checked: true }];
      unbindThink();
      await finalizeDecisionMulti();
      return true;
    }
    domainCardState(c2, 'done', '已完成');
    // 归类明细 note（每文件一行 → 领域，低置信标 ?）
    const detRow = domainCardRow(c2, 'domain-note');
    const parts = [];
    for (const k of Object.keys(assignments)) {
      const a = assignments[k];
      const nm = String(k).startsWith('inline:') ? String(k).slice(7) : String(k).split(/[\\/]/).pop();
      parts.push(`${nm} → ${a.domains.join('+')}${a.confidence < 0.6 ? '?' : ''}`);
    }
    if (unassigned.length) parts.push(`${unassigned.length} 个未分类 → 通用`);
    detRow.textContent = parts.join('；');

    // 卡片③：逐领域准备模版与体系
    const c3 = domainCard('③', '准备领域模版与体系', 'running');
    domainCardState(c3, 'running', '准备中');
    // 按领域名 → 文件子集（多归属时同一文件进多个领域）
    const byDomain = {};
    for (const d of sug.domains) byDomain[d.name] = { rawPaths: [], inlineKeys: [], fileRefs: [] };
    const generalRefs = { rawPaths: [], inlineKeys: [], fileRefs: [] };
    for (const k of Object.keys(assignments)) {
      const a = assignments[k];
      for (const dn of a.domains) {
        if (!byDomain[dn]) continue;
        if (String(k).startsWith('inline:')) byDomain[dn].inlineKeys.push(String(k).slice(7));
        else { byDomain[dn].rawPaths.push(k); byDomain[dn].fileRefs.push({ rawPath: k, confidence: a.confidence }); }
      }
    }
    for (const k of unassigned) {
      if (String(k).startsWith('inline:')) generalRefs.inlineKeys.push(String(k).slice(7));
      else { generalRefs.rawPaths.push(k); generalRefs.fileRefs.push({ rawPath: k, confidence: 1 }); }
    }
    // 逐领域准备模版（同名复用否则新建）与体系（模版绑定优先，否则按该领域子集内容匹配）
    for (const d of sug.domains) {
      const bucket = byDomain[d.name];
      if (!bucket.fileRefs.length && !bucket.inlineKeys.length) continue; // 0 文件领域不进清单
      mkThink(c3);
      const prep = await prepareDomainTpl(d.name, d.desc);
      if (cancelled) return false;
      let profileId = '';
      if (prep && prep.tpl && prep.tpl.ontologyProfile) {
        profileId = String(prep.tpl.ontologyProfile).trim();
      } else {
        const prof = await window.kb.tplSuggestProfile({ settings: state.settings, rawPaths: bucket.rawPaths, texts: bucket.inlineKeys.length ? inlineSources.filter((s) => bucket.inlineKeys.includes(String(s.label))).map((s) => s.text) : [] });
        profileId = (prof && prof.ok && prof.id) ? prof.id : ((state.settings && state.settings.ontologyProfile) || 'bfo-lite');
      }
      groups.push({ key: d.name, domainId: prep ? prep.id : 'general', tpl: prep ? prep.tpl : null, profileId, fileRefs: bucket.fileRefs, inlineKeys: bucket.inlineKeys, checked: true });
      domainCardRow(c3, 'domain-note').textContent = `✔ ${d.name} → 模版「${prep ? prep.name : '通用'}」/ 体系「${profileNameOf(profileId)}」`;
    }
    // unassigned → 通用组（默认勾选）
    if (generalRefs.fileRefs.length || generalRefs.inlineKeys.length) {
      groups.push({ key: 'general', domainId: 'general', tpl: null, profileId: (state.settings && state.settings.ontologyProfile) || 'bfo-lite', fileRefs: generalRefs.fileRefs, inlineKeys: generalRefs.inlineKeys, checked: true });
      domainCardRow(c3, 'domain-note').textContent = `↷ ${generalRefs.fileRefs.length + generalRefs.inlineKeys.length} 个未分类文件归入「通用」组`;
    }
    if (cancelled) return false;
    domainCardState(c3, 'done', '已完成');
    if (!groups.length) {
      groups = [{ key: 'general', domainId: 'general', tpl: null, profileId: (state.settings && state.settings.ontologyProfile) || 'bfo-lite', fileRefs: rawPaths.map((p) => ({ rawPath: p, confidence: 1 })), inlineKeys: inlineSources.map((s) => String(s.label || '')), checked: true }];
    }
    unbindThink();
    await finalizeDecisionMulti();
    return true;
  } catch (err) {
    unbindThink();
    domainStep('✖ 多领域判定异常：' + err.message + '，回退单组通用', 'err');
    groups = [{ key: 'general', domainId: 'general', tpl: null, profileId: (state.settings && state.settings.ontologyProfile) || 'bfo-lite', fileRefs: rawPaths.map((p) => ({ rawPath: p, confidence: 1 })), inlineKeys: inlineSources.map((s) => String(s.label || '')), checked: true }];
    await finalizeDecisionMulti();
    return true;
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
  // 同步拉取图谱范围，用于判断每个模板是否已有图谱数据（决定可否删除/可点击查看图谱）
  if (window.kb.graphScopes) {
    state.kg = state.kg || {};
    try { state.kg.graphScopes = (await window.kb.graphScopes()) || []; } catch (_) { /* 保留旧缓存 */ }
  }
  renderTplCards();
}

// 模板是否有已抽取的图谱数据：存在 scope（profile|domain）使 domain 等于模板 id 且节点数 > 0
function tplGraphScope(tplId) {
  const scopes = state.kg && Array.isArray(state.kg.graphScopes) ? state.kg.graphScopes : [];
  return scopes.find((s) => s.domain === tplId && (s.nodeCount || 0) > 0) || null;
}

function renderTplCards() {
  const box = $('tpl-cards');
  box.innerHTML = '';
  state.templates.forEach((t) => {
    const card = document.createElement('div');
    card.className = 'tpl-card' + (t.builtin ? '' : ' custom');
    const pid = t.ontologyProfile || 'bfo-lite';
    const kws = (t.keywords || []).map((k) => `<span class="tpl-kw">${escapeHtml(k)}</span>`).join('');
    // 有图谱数据的模板：禁止删除，卡片可点击查看对应知识图谱
    const scope = tplGraphScope(t.id);
    const hasGraph = !!scope;
    if (hasGraph) card.classList.add('has-graph');
    const graphBadge = hasGraph
      ? `<span class="tpl-count-badge tpl-graph-badge" title="已抽取 ${scope.nodeCount} 个节点，点击查看知识图谱">图谱: ${scope.nodeCount} 节点 ▸</span>`
      : '';
    // 删除按钮始终可点；是否有图谱关联在删除确认弹窗内实时判定并展示（避免 scopes 缓存滞后误判）
    const delBtn = t.builtin ? '' : '<button class="btn btn-ghost danger" data-act="del">删除</button>';
    card.innerHTML = `
      <div class="tpl-card-head">
        <b class="tpl-card-name" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</b>
        <code class="tpl-card-id" title="${escapeHtml(t.id)}">${escapeHtml(t.id)}</code>
      </div>
      <p class="tpl-card-desc" title="${escapeHtml(t.desc || '')}">${escapeHtml(t.desc || '')}</p>
      <div class="tpl-counts">
        <span class="tpl-badge-profile tpl-profile-${escapeHtml(pid)}">${escapeHtml(profileNameOf(pid))}</span>
        <span class="tpl-count-badge">领域类: ${(t.domainClasses || t.entityTypes || []).length}</span>
        ${graphBadge}
      </div>
      ${kws ? `<div class="tpl-kws">${kws}</div>` : ''}
      <div class="tpl-card-foot">
        <span>更新: ${t.updatedAt ? formatDate(t.updatedAt).slice(0, 10) : '—'}</span>
        <span class="tpl-card-btns">
          <button class="btn btn-ghost" data-act="edit">编辑</button>
          ${delBtn}
        </span>
      </div>`;
    card.addEventListener('click', (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'edit') { openTplModal(t); return; }
      if (act === 'del') { deleteTpl(t); return; }
      // 有图谱数据的模板：点击卡片（非按钮区）跳转查看对应知识图谱
      if (hasGraph && !e.target.closest('.tpl-card-btns')) viewTplGraph(scope);
    });
    // 右键菜单：编辑模板（有图谱时附「查看知识图谱」）
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const items = [{ label: '编辑模板', action: () => openTplModal(t) }];
      if (hasGraph) items.unshift({ label: '查看知识图谱', action: () => viewTplGraph(scope) });
      openCtxMenu(e.clientX, e.clientY, items);
    });
    box.appendChild(card);
  });
}

// 跳转到「整体图谱」并选中该模板对应的知识图谱（profile + domain）
async function viewTplGraph(scope) {
  if (!scope) return;
  showGraphView();
  switchKgTab('graph');
  await loadGraph(); // 确保过滤下拉已按最新数据重建
  const pSel = $('kg-g-profile');
  if (pSel && scope.profile) { pSel.dataset.userSelected = '1'; pSel.value = scope.profile; }
  renderGraphDomainFilter();
  const dSel = $('kg-g-domain');
  if (dSel) dSel.value = scope.id;
  if (typeof startGraphSim === 'function') startGraphSim();
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

// 实时查询模板是否有关联知识图谱（直接拉最新 scopes，不用可能滞后的缓存）
async function fetchTplGraphScope(tplId) {
  try {
    const scopes = window.kb.graphScopes ? ((await window.kb.graphScopes()) || []) : [];
    // 同步刷新缓存，供卡片徽章/点击查看使用
    state.kg = state.kg || {};
    state.kg.graphScopes = scopes;
    return scopes.find((s) => s.domain === tplId && (s.nodeCount || 0) > 0) || null;
  } catch (_) { return null; }
}

// 删除领域模版：弹窗内实时判定是否关联知识图谱，有关联则禁用删除并在框中明确展示
function deleteTpl(tpl) {
  const modal = $('tpl-del-modal');
  const info = $('tpl-del-info');
  const okBtn = $('btn-tpl-del-ok');
  const cancelBtn = $('btn-tpl-del-cancel');
  $('tpl-del-title').textContent = `删除领域模版「${tpl.name}」`;
  // 初始：检查中
  info.className = 'tpl-del-info';
  info.textContent = '正在检查是否关联知识图谱…';
  okBtn.disabled = true;
  modal.hidden = false;

  // 实时判定图谱关联
  fetchTplGraphScope(tpl.id).then((scope) => {
    if (modal.hidden) return; // 用户已关闭
    if (scope) {
      // 有关联图谱：禁用删除，红色提示
      info.className = 'tpl-del-info has-graph';
      info.innerHTML = `⚠ 该领域模版已关联知识图谱，不能删除。\n\n体系：${escapeHtml(scope.profileName || scope.profile)}\n已抽取节点：${scope.nodeCount} 个\n\n请先到「知识图谱管理 → 整体图谱」清空该领域的图谱节点后，才能删除本模版。`;
      okBtn.disabled = true;
    } else {
      // 无关联图谱：可删除，绿色提示
      info.className = 'tpl-del-info no-graph';
      info.textContent = `✓ 已检查：模版「${tpl.name}」暂无关联的知识图谱数据，可安全删除。`;
      okBtn.disabled = false;
    }
  });

  const close = () => {
    modal.hidden = true;
    okBtn.onclick = null;
    cancelBtn.onclick = null;
    modal.onclick = null;
  };
  okBtn.onclick = async () => {
    okBtn.disabled = true;
    const res = await window.kb.tplRemove(tpl.id);
    if (!res.ok) { close(); toast('删除失败：' + res.error, 4000); return; }
    close();
    toast('模版已删除');
    loadTemplates();
  };
  cancelBtn.onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };
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
    // 注意：后端 rel 是 path.relative 产出，Windows 下为反斜杠，这里统一换成 / 再拆分
    const tree = { dirs: new Map(), files: [] };
    for (const r of refs) {
      const parts = String(r.rel || r.name).replace(/\\/g, '/').split('/').filter(Boolean);
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

