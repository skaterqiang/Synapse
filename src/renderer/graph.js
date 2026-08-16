// 渲染进程·图谱模块：图谱视图、力导向布局、KG 子视图与 KG 问答
// ================= 知识图谱 =================
const GRAPH_COLORS = { concept: '#3370ff', entity: '#ff9f43', topic: '#2ecc71', source: '#9b59b6', note: '#f54a45' };
const GRAPH_TYPE_NAMES = { concept: '概念', entity: '实体', topic: '主题', source: '来源', note: '笔记' };
// 画布模拟运行时状态（坐标/缩放/拖拽），与持久化数据分离
const graphSim = { nodes: [], edges: [], zoom: 1, ox: 0, oy: 0, drag: null, selected: null, raf: 0, running: false, alpha: 1 };

function showGraphView() {
  $('wiki-viewer').hidden = true;
  $('settings-view').hidden = true;
  $('jobs-view').hidden = true;
  $('tpl-view').hidden = true;
  $('raw-view').hidden = true;
  $('prompts-view').hidden = true;
  $('prompt-editor-view').hidden = true;
  promptEditing = null;
  $('graph-view').hidden = false;
  renderEditor();
  renderSidebar();
  loadGraph();
  switchKgTab(state.kg.tab || 'overview');
  // 布局落定后再校正一次居中，消除打开后的偏移
  requestAnimationFrame(() => recenterGraph());
}

function hideGraphView() {
  $('graph-view').hidden = true;
  stopGraphSim();
  renderEditor();
  renderSidebar();
}

async function loadGraph() {
  const g = await window.kb.graphGet();
  state.graph = g || { nodes: [], edges: [], updatedAt: 0 };
  $('count-graph').textContent = state.graph.nodes.length;
  renderGraphDomainFilter();
  renderGraphStats();
  if (!$('graph-view').hidden) renderKgTab();
}

// 领域筛选下拉：节点实际出现的领域 ∪ 模版列表，名称优先取模版中文名
function renderGraphDomainFilter() {
  const sel = $('kg-g-domain');
  if (!sel) return;
  const cur = sel.value;
  const name = (id) => {
    const t = (state.templates || []).find((x) => x.id === id);
    return t ? t.name : id;
  };
  const domains = [...new Set(state.graph.nodes.map((n) => n.domain || 'general'))];
  sel.innerHTML = '<option value="">全部领域</option>' + domains.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(name(d))}</option>`).join('');
  sel.value = domains.includes(cur) ? cur : '';
}

function renderGraphStats() {
  const g = state.graph;
  $('graph-stats').textContent = g.nodes.length
    ? `${g.nodes.length} 节点 · ${g.edges.length} 关系 · 更新 ${formatDate(g.updatedAt)}`
    : '尚未抽取';
}

function renderGraphLegend() {
  const box = $('graph-legend');
  box.innerHTML = '';
  Object.entries(GRAPH_TYPE_NAMES).forEach(([k, name]) => {
    const s = document.createElement('span');
    s.className = 'lg-item';
    s.innerHTML = `<span class="lg-dot" style="background:${GRAPH_COLORS[k]}"></span>${name}`;
    box.appendChild(s);
  });
  const tip = document.createElement('span');
  tip.style.marginLeft = 'auto';
  tip.textContent = '拖拽节点 · 滚轮缩放 · 点击节点查看关系';
  box.appendChild(tip);
}

function renderGraphEmpty() {
  let em = $('graph-empty');
  if (state.graph.nodes.length) { if (em) em.remove(); return; }
  if (!em) {
    em = document.createElement('div');
    em.id = 'graph-empty';
    em.className = 'graph-empty';
    em.innerHTML = '<div class="empty-icon">🕸</div><p>暂无知识图谱：选择上方范围后点击「抽取本体层」，<br>AI 将自动从 LLM Wiki 与笔记中提取实体与关系。</p>';
    $('graph-view').querySelector('.graph-body').appendChild(em);
  }
}

// 邻居视图提示按钮：显示中心节点名，点击退出邻居视图
function updateGraphFocusChip() {
  const btn = $('btn-graph-focus');
  if (!btn) return;
  const node = state.kg.focus && state.graph.nodes.find((n) => n.id === state.kg.focus);
  if (node) {
    btn.hidden = false;
    btn.textContent = `🕸 邻居视图：${node.name} ✕`;
  } else {
    state.kg.focus = null;
    btn.hidden = true;
  }
}

// ---------- 力导向布局与绘制 ----------
function startGraphSim() {
  const canvas = $('graph-canvas');
  updateGraphFocusChip();
  const g = kgFilteredGraph();
  $('graph-stats').textContent = `实体 ${g.nodes.length} · 边 ${g.edges.length}` + (g.truncated ? '（已截断到上限）' : '') + (state.graph.updatedAt ? ` · 更新 ${formatDate(state.graph.updatedAt)}` : '');
  const old = new Map(graphSim.nodes.map((n) => [n.id, n]));
  const W = canvas.clientWidth || 800;
  const H = canvas.clientHeight || 600;
  graphSim.nodes = g.nodes.map((n, i) => {
    const o = old.get(n.id);
    const angle = (i / Math.max(1, g.nodes.length)) * Math.PI * 2;
    return {
      ...n,
      x: o ? o.x : W / 2 + Math.cos(angle) * (120 + (i % 5) * 30),
      y: o ? o.y : H / 2 + Math.sin(angle) * (120 + (i % 5) * 30),
      vx: 0, vy: 0,
      r: 6 + Math.min(10, (n.sources || []).length * 2 + (n.desc ? 2 : 0)),
    };
  });
  const ids = new Set(graphSim.nodes.map((n) => n.id));
  graphSim.edges = g.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  graphSim.zoom = 1; graphSim.ox = 0; graphSim.oy = 0; graphSim.selected = null;
  // 同步预计算布局至收敛：首帧直接绘制静止结果，完全避免初始晃动
  let a = 1;
  for (let i = 0; i < 600 && a > 0.02; i++) {
    physicsStep(W, H, a);
    a = Math.max(0, a * 0.99 - 0.0004);
  }
  // 包围盒居中+自适应缩放，默认完整居中显示
  recenterGraph();
  graphSim.alpha = 0;
  $('graph-detail').hidden = true;
  renderGraphEmpty();
  if (!graphSim.running) {
    graphSim.running = true;
    graphSim.raf = requestAnimationFrame(graphTick);
  }
}

function stopGraphSim() {
  graphSim.running = false;
  cancelAnimationFrame(graphSim.raf);
}

function graphTick() {
  if (!graphSim.running) return;
  const canvas = $('graph-canvas');
  const W = canvas.clientWidth || 800;
  const H = canvas.clientHeight || 600;
  // 物理仅在“温度”未冷却时运行（初始布局已同步预计算，首帧即静止）；拖拽节点时重新加热
  const active = graphSim.alpha > 0.02 || (graphSim.drag && graphSim.drag.node);
  if (active) {
    physicsStep(W, H, graphSim.alpha);
    graphSim.alpha = Math.max(0, graphSim.alpha * 0.99 - 0.0004);
  }
  drawGraph();
  graphSim.raf = requestAnimationFrame(graphTick);
}

// 单步物理：斥力 + 弹簧 + 向心，力幅乘以温度 a0
function physicsStep(W, H, a0) {
  const nodes = graphSim.nodes;
  // 节点间斥力（距离过远时忽略，控制 O(n²) 开销）
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      const dx = a.x - b.x, dy = a.y - b.y;
      const d2 = dx * dx + dy * dy || 1;
      if (d2 < 40000) {
        const f = (900 / d2) * a0;
        a.vx += dx * f; a.vy += dy * f;
        b.vx -= dx * f; b.vy -= dy * f;
      }
    }
  }
  // 边弹簧力（归一化方向 + 力幅钳制，避免远距离二次发散）
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const e of graphSim.edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const m = Math.max(-4, Math.min(4, (d - 110) * 0.02)) * a0;
    const ux = dx / d, uy = dy / d;
    a.vx += ux * m; a.vy += uy * m;
    b.vx -= ux * m; b.vy -= uy * m;
  }
  // 向心力 + 阻尼 + 限幅（NaN 防护：异常时重置回中心）
  for (const n of nodes) {
    n.vx += (W / 2 - n.x) * 0.0015 * a0;
    n.vy += (H / 2 - n.y) * 0.0015 * a0;
    if (graphSim.drag && graphSim.drag.node === n) { n.vx = 0; n.vy = 0; continue; }
    n.vx = Math.max(-6, Math.min(6, n.vx * 0.85));
    n.vy = Math.max(-6, Math.min(6, n.vy * 0.85));
    n.x += n.vx; n.y += n.vy;
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) {
      n.x = W / 2; n.y = H / 2; n.vx = 0; n.vy = 0;
    }
    n.x = Math.max(-80, Math.min(W + 80, n.x));
    n.y = Math.max(-80, Math.min(H + 80, n.y));
  }
}

// ---------- KG 模块子视图 ----------
// 整体图谱过滤：领域/类型/最多节点/排序（按边数优先保留高连接节点）
function kgFilteredGraph() {
  const typeEl = $('kg-g-type');
  const type = typeEl ? typeEl.value : '';
  const domain = ($('kg-g-domain') || {}).value || '';
  const maxRaw = parseInt(($('kg-g-max') || {}).value || '100', 10);
  const max = Number.isFinite(maxRaw) ? maxRaw : 100; // 0 = 全部
  const sort = ($('kg-g-sort') || {}).value || 'deg';
  let nodes = state.graph.nodes.slice();
  // 邻居视图：仅保留中心节点及其直接邻居
  if (state.kg.focus) {
    const f = state.kg.focus;
    const nb = new Set([f]);
    for (const e of state.graph.edges) {
      if (e.from === f) nb.add(e.to);
      if (e.to === f) nb.add(e.from);
    }
    nodes = nodes.filter((n) => nb.has(n.id));
  }
  if (domain) nodes = nodes.filter((n) => (n.domain || 'general') === domain);
  if (type) nodes = nodes.filter((n) => n.type === type);
  const ids0 = new Set(nodes.map((n) => n.id));
  let edges = state.graph.edges.filter((e) => ids0.has(e.from) && ids0.has(e.to));
  const deg = {};
  edges.forEach((e) => { deg[e.from] = (deg[e.from] || 0) + 1; deg[e.to] = (deg[e.to] || 0) + 1; });
  nodes.sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name, 'zh') : (deg[b.id] || 0) - (deg[a.id] || 0)));
  const truncated = max > 0 && nodes.length > max;
  if (truncated) nodes = nodes.slice(0, max);
  const ids = new Set(nodes.map((n) => n.id));
  edges = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  return { nodes, edges, truncated };
}

const KG_TAB_NAMES = { overview: '概览', entities: '实体浏览', graph: '整体图谱', ontology: '本体定义', ask: '自然语言问答' };

function switchKgTab(tab) {
  state.kg.tab = tab;
  document.querySelectorAll('.kg-pane').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
  $('kg-crumb-sub').textContent = KG_TAB_NAMES[tab] || tab;
  renderSidebar();
  renderKgTab();
}

function renderKgTab() {
  const tab = state.kg.tab;
  if (tab === 'overview') renderKgOverview();
  else if (tab === 'entities') renderKgEntities();
  else if (tab === 'graph') startGraphSim();
  else if (tab === 'ontology') renderKgOntology();
}

function kgCard(icon, num, label) {
  return `<div class="kg-card"><span class="kg-card-icon">${icon}</span><div><b>${num}</b><span>${label}</span></div></div>`;
}

function renderKgOverview() {
  const g = state.graph;
  const onto = (g.nodes.length && state.kg.onto) || null;
  const preds = onto ? onto.stats.predicateCount : 8;
  $('kg-overview-cards').innerHTML =
    kgCard('🏷', onto ? onto.stats.classCount : 5, '实体类') +
    kgCard('🔗', preds, '谓词') +
    kgCard('📍', g.nodes.length, '实例总数') +
    kgCard('🔗', g.edges.length, '关系总数') +
    kgCard('🕒', g.updatedAt ? formatDate(g.updatedAt) : '—', '更新时间');
  const countBy = {};
  g.nodes.forEach((n) => { countBy[n.type] = (countBy[n.type] || 0) + 1; });
  const rows = Object.entries(GRAPH_TYPE_NAMES).map(([k, name]) => {
    const c = countBy[k] || 0;
    const pct = g.nodes.length ? Math.round((c / g.nodes.length) * 100) : 0;
    return `<div class="kg-bar-row"><span class="lg-dot" style="background:${GRAPH_COLORS[k]}"></span><span class="kg-bar-name">${name}</span><div class="kg-bar"><i style="width:${pct}%;background:${GRAPH_COLORS[k]}"></i></div><span>${c}</span></div>`;
  }).join('');
  $('kg-overview-types').innerHTML = `<h4>类型分布</h4>${rows || '<p class="modal-tip">暂无数据，先运行「抽取本体层」。</p>'}`;
}

function kgEntitySources(n) { return (n.sources || []).map((s) => (s.startsWith('Wiki') ? 'wiki' : 'notes')); }

function renderKgEntities() {
  const typeSel = $('kg-f-type');
  if (typeSel && !typeSel.options.length) {
    typeSel.innerHTML = '<option value="">全部一级分类</option>' + Object.entries(GRAPH_TYPE_NAMES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  }
  // 类型颜色图例（一次性填充）
  const legend = $('kg-legend');
  if (legend && !legend.childElementCount) {
    legend.innerHTML = Object.entries(GRAPH_TYPE_NAMES).map(([k, name]) =>
      `<span class="lg-item"><i class="lg-dot" style="background:${GRAPH_COLORS[k] || '#3370ff'}"></i>${escapeHtml(name)}</span>`).join('');
  }
  const q = ($('kg-f-q').value || '').trim().toLowerCase();
  const type = typeSel.value;
  const src = $('kg-f-src').value;
  let list = state.graph.nodes.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  if (type) list = list.filter((n) => n.type === type);
  if (src) list = list.filter((n) => kgEntitySources(n).includes(src));
  if (q) list = list.filter((n) => n.name.toLowerCase().includes(q) || (n.desc || '').toLowerCase().includes(q));
  const el = $('kg-elist');
  el.innerHTML = `<div class="kg-ecount">共 ${list.length} 条</div>` + list.map((n) => {
    const srcs = n.sources || [];
    const srcLabel = srcs[0] ? escapeHtml(srcs[0]) + (srcs.length > 1 ? ` +${srcs.length - 1}` : '') : '—';
    return `
    <div class="kg-eitem${state.kg.entitySel === n.id ? ' active' : ''}" data-id="${n.id}" title="${escapeHtml(n.name)}">
      <i class="lg-dot" style="background:${GRAPH_COLORS[n.type] || '#3370ff'}"></i>
      <div class="kg-eitem-main"><b>${escapeHtml(n.name)}</b>${n.id !== n.name ? `<code>${escapeHtml(n.id)}</code>` : ''}</div>
      <span class="mini-tag" title="${escapeHtml(srcs.join('\n'))}">${srcLabel}</span>
    </div>`;
  }).join('');
  el.querySelectorAll('.kg-eitem').forEach((item) => {
    item.addEventListener('click', () => { state.kg.entitySel = item.dataset.id; renderKgEntities(); renderKgEntityDetail(item.dataset.id); });
  });
  if (state.kg.entitySel && !list.some((n) => n.id === state.kg.entitySel)) state.kg.entitySel = null;
  const detail = $('kg-edetail');
  if (state.kg.entitySel) {
    detail.hidden = false;
    renderKgEntityDetail(state.kg.entitySel);
  } else {
    // 未选中实体时隐藏详情面板，让列表占满整宽
    detail.hidden = true;
    detail.innerHTML = '';
  }
}

function renderKgEntityDetail(id) {
  const n = state.graph.nodes.find((x) => x.id === id);
  const box = $('kg-edetail');
  if (!n) { box.innerHTML = ''; return; }
  const byId = new Map(state.graph.nodes.map((x) => [x.id, x]));
  const out = state.graph.edges.filter((e) => e.from === id);
  const inn = state.graph.edges.filter((e) => e.to === id);
  const edgeRow = (e) => {
    const other = e.from === id ? byId.get(e.to) : byId.get(e.from);
    const otherId = other ? other.id : '';
    return `<div class="gd-rel" data-other="${escapeHtml(otherId)}" title="点击查看「${escapeHtml(other ? other.name : '')}」">${escapeHtml(byId.get(e.from).name)} <span class="rel-tag">→ ${escapeHtml(e.rel)} →</span> ${escapeHtml(byId.get(e.to).name)}</div>`;
  };
  box.innerHTML = `
    <div class="kg-edetail-head"><h4><span class="gd-type" style="background:${GRAPH_COLORS[n.type] || '#3370ff'}">${GRAPH_TYPE_NAMES[n.type] || '概念'}</span>${escapeHtml(n.name)}</h4><button class="icon-btn" id="btn-kg-edetail-close" title="关闭详情">✕</button></div>
    <div class="kg-kv"><span>id</span><code>${escapeHtml(n.id)}</code></div>
    <div class="kg-kv"><span>来源数</span><b>${(n.sources || []).length}</b></div>
    <div class="gd-desc">${escapeHtml(n.desc || '')}</div>
    <div class="gd-sec">出边（${out.length}）</div>${out.map(edgeRow).join('') || '<div class="gd-desc">（无）</div>'}
    <div class="gd-sec">入边（${inn.length}）</div>${inn.map(edgeRow).join('') || '<div class="gd-desc">（无）</div>'}
    <button class="btn btn-primary" id="btn-kg-neighbor">🕸 看邻居图 →</button>`;
  $('btn-kg-neighbor').addEventListener('click', () => {
    state.kg.focus = id; // 邻居视图：画布只看该节点的邻居
    switchKgTab('graph');
    graphSim.selected = id;
    renderGraphDetail(graphSim.nodes.find((x) => x.id === id) || null);
    recenterGraph();
  });
  $('btn-kg-edetail-close').addEventListener('click', () => {
    state.kg.entitySel = null;
    renderKgEntities();
  });
  // 关系行点击跳转到对端实体
  box.querySelectorAll('.gd-rel[data-other]').forEach((row) => {
    row.addEventListener('click', () => {
      if (!row.dataset.other) return;
      state.kg.entitySel = row.dataset.other;
      renderKgEntities();
    });
  });
}

async function renderKgOntology() {
  if (!state.kg.onto) state.kg.onto = await window.kb.graphOntology();
  const o = state.kg.onto;
  $('kg-onto-cards').innerHTML =
    kgCard('🏷', o.stats.classCount, '实体类') +
    kgCard('🔗', o.stats.predicateCount, '谓词') +
    kgCard('📏', o.stats.constraintCount, '校验约束') +
    kgCard('📍', o.stats.instanceCount, '实例总数') +
    kgCard('🔗', o.stats.edgeCount, '关系总数');
  const acts = (attr) => `<span class="kg-class-acts"><button class="icon-btn" data-act="edit" ${attr} title="编辑">✏</button><button class="icon-btn danger" data-act="del" ${attr} title="删除">✕</button></span>`;
  const body = $('kg-onto-body');
  if (state.kg.ontoTab === 'classes') {
    body.innerHTML = o.classes.map((c) => `
      <div class="kg-class">
        <div class="kg-class-head"><code>${escapeHtml(c.key)}</code><b>${escapeHtml(c.label)}</b><span>${escapeHtml(c.desc)}</span><em>${c.instances} 实例</em>${acts(`data-key="${escapeHtml(c.key)}"`)}</div>
        <div class="kg-class-ex">示例：${(c.examples || []).map((s) => `<span class="mini-tag">${escapeHtml(s)}</span>`).join(' ') || '—'}</div>
      </div>`).join('');
  } else if (state.kg.ontoTab === 'preds') {
    body.innerHTML = o.predicates.map((p) => `<div class="kg-class"><div class="kg-class-head"><code>${escapeHtml(p.key)}</code><span>${escapeHtml(p.desc)}</span>${acts(`data-key="${escapeHtml(p.key)}"`)}</div></div>`).join('');
  } else {
    body.innerHTML = (o.constraints || []).map((c, i) => `<div class="kg-class"><div class="kg-class-head"><code>${i + 1}</code><span>${escapeHtml(c)}</span>${acts(`data-idx="${i}"`)}</div></div>`).join('');
  }
}

// ---------- 本体增删改查 ----------
let ontoEdit = null; // {kind, key?, index?}

function openOntoModal(kind, existing) {
  ontoEdit = { kind, key: existing && existing.key, index: existing && existing.index };
  const names = { classes: '实体类', preds: '谓词', cons: '约束' };
  $('onto-modal-title').textContent = (existing ? '编辑' : '新增') + names[kind];
  $('onto-f-key').hidden = kind === 'cons';
  $('onto-f-label').hidden = kind !== 'classes';
  $('onto-f-ex').hidden = kind !== 'classes';
  $('onto-key-label').innerHTML = (kind === 'preds' ? '谓词名称' : '标识键（英文标识符）') + ' <i class="tpl-req">*</i>';
  $('onto-desc-label').innerHTML = (kind === 'cons' ? '约束内容' : '描述') + (kind === 'cons' ? ' <i class="tpl-req">*</i>' : '');
  $('onto-key').value = existing ? existing.key || '' : '';
  $('onto-key').disabled = !!existing; // 编辑时标识不可改
  $('onto-label').value = existing ? existing.label || '' : '';
  $('onto-desc').value = existing ? (kind === 'cons' ? existing.text : existing.desc || '') : '';
  $('onto-ex').value = existing ? (existing.examples || []).join(', ') : '';
  $('onto-modal').hidden = false;
}

async function saveOntoItem() {
  const kind = ontoEdit.kind;
  const item = { index: ontoEdit.index };
  if (kind === 'classes') {
    item.key = ontoEdit.key || $('onto-key').value;
    item.label = $('onto-label').value;
    item.desc = $('onto-desc').value;
    item.examples = $('onto-ex').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  } else if (kind === 'preds') {
    item.key = $('onto-key').value;
    item.desc = $('onto-desc').value;
  } else {
    item.desc = $('onto-desc').value;
  }
  const res = await window.kb.ontoSave({ kind, item });
  if (!res.ok) { toast('保存失败：' + res.error, 4000); return; }
  state.kg.onto = res.ontology;
  $('onto-modal').hidden = true;
  toast('本体已更新，下次「抽取本体层」时生效');
  renderKgOntology();
}

async function removeOntoItem(kind, keyOrIndex) {
  const label = kind === 'cons' ? `约束 #${Number(keyOrIndex) + 1}` : keyOrIndex;
  if (!confirm(`确定删除「${label}」？`)) return;
  const res = await window.kb.ontoRemove({ kind, key: keyOrIndex });
  if (!res.ok) { toast('删除失败：' + res.error, 4000); return; }
  state.kg.onto = res.ontology;
  toast('已删除');
  renderKgOntology();
}

// KG 自然语言问答：抽取实体 → 邻居事实 → 事实约束回答
let kgListeners = [];
function cleanupKgListeners() { kgListeners.forEach((off) => off()); kgListeners = []; }
let kgBusy = false; // KG 问答独立忙标记：不被 AI 面板残留的 aiBusy 静默阻断

async function kgAskFlow() {
  const question = $('kg-ask-input').value.trim();
  if (!question || kgBusy) return;
  kgBusy = true;
  state.aiBusy = true; // 流式事件共用，期间阻止 AI 面板并发提问
  $('btn-kg-ask').disabled = true;
  $('kg-ask-out').hidden = false;
  $('kg-facts').innerHTML = '<p class="modal-tip">解析问题并抽取实体…</p>';
  $('kg-answer').innerHTML = '';
  cleanupKgListeners();
  let answer = '';
  kgListeners = [
    window.kb.onKgStage((t) => { $('kg-facts').innerHTML = `<p class="modal-tip">${escapeHtml(t)}</p>`; }),
    window.kb.onKgFacts(({ matched, facts, refs }) => {
      const refItems = (refs || []).map((r) =>
        `<div class="kg-fact kg-ref" data-kind="${r.kind}" data-path="${escapeHtml(r.path)}" title="点击打开原文">📄 ${r.kind === 'wiki' ? 'Wiki' : '笔记'}·${escapeHtml(r.label)}</div>`).join('');
      $('kg-facts').innerHTML =
        `<div class="gd-sec">匹配实体（${matched.length}）</div>` + (matched.map((m) => `<span class="mini-tag">${escapeHtml(m)}</span>`).join(' ') || '（无）') +
        `<div class="gd-sec">引用资料（${(refs || []).length}）</div>` + (refItems || '<div class="gd-desc">（无）</div>') +
        `<div class="gd-sec">事实清单（${facts.length}）</div>` + (facts.map((f) => `<div class="kg-fact">${escapeHtml(f)}</div>`).join('') || '<div class="gd-desc">（无）</div>');
    }),
    window.kb.onAiChunk((c) => { answer += c; $('kg-answer').innerHTML = renderMarkdown(answer); }),
    window.kb.onAiDone(() => finishKg()),
    window.kb.onAiError((m) => { $('kg-answer').innerHTML = renderMarkdown(answer + `\n\n> ⚠ ${m}`); finishKg(); }),
  ];
  function finishKg() {
    kgBusy = false;
    state.aiBusy = false;
    $('btn-kg-ask').disabled = false;
    cleanupKgListeners();
  }
  await window.kb.graphAsk({
    settings: state.settings,
    question,
    hops: parseInt($('kg-ask-hops').value, 10) || 3,
    withFacts: $('kg-ask-facts').checked,
  });
}

// 自适应：重置缩放/平移，包围盒居中适配画布
function fitGraphView() {
  graphSim.zoom = 1;
  graphSim.ox = 0;
  graphSim.oy = 0;
  recenterGraph();
}

// 画布尺寸变化（AI 面板开关/列表收起/窗口缩放）时包围盒居中+自适应缩放，保证图谱默认完整居中可见
function recenterGraph() {
  const canvas = $('graph-canvas');
  const W = canvas.clientWidth || 800;
  const H = canvas.clientHeight || 600;
  const nodes = graphSim.nodes;
  if (!nodes.length) return;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
  }
  const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
  const pad = 80;
  // 缩放限制在 0.6–1.6，避免过小/过大；包围盒中心对齐画布中心
  const s = Math.min(1.6, Math.max(0.6, Math.min((W - pad * 2) / bw, (H - pad * 2) / bh)));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  for (const n of nodes) {
    n.x = W / 2 + (n.x - cx) * s;
    n.y = H / 2 + (n.y - cy) * s;
    n.vx = 0; n.vy = 0;
  }
  drawGraph();
}

function drawGraph() {
  const canvas = $('graph-canvas');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.translate(W / 2 + graphSim.ox, H / 2 + graphSim.oy);
  ctx.scale(graphSim.zoom, graphSim.zoom);
  ctx.translate(-W / 2, -H / 2);
  const byId = new Map(graphSim.nodes.map((n) => [n.id, n]));
  // 边（带方向箭头：from → to，代表归属/关系指向）
  ctx.strokeStyle = 'rgba(138,145,159,0.5)';
  ctx.lineWidth = 1;
  for (const e of graphSim.edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    // 两端按节点半径裁剪，避免线/箭头被节点圆盖住
    if (len <= a.r + b.r + 8) continue;
    const ux = dx / len, uy = dy / len;
    const sx = a.x + ux * (a.r + 2), sy = a.y + uy * (a.r + 2);
    const tipX = b.x - ux * (b.r + 3), tipY = b.y - uy * (b.r + 3);
    const al = 7; // 箭头长度
    const bx = tipX - ux * al, by = tipY - uy * al; // 箭头底边中心（线段终点）
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(bx, by); ctx.stroke();
    // 箭头三角
    const px = -uy, py = ux, hw = al * 0.45;
    ctx.fillStyle = 'rgba(138,145,159,0.7)';
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(bx + px * hw, by + py * hw);
    ctx.lineTo(bx - px * hw, by - py * hw);
    ctx.closePath();
    ctx.fill();
  }
  // 关系谓词标签：始终显示在边中点，白色描边保证压线可读
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(245,246,248,0.9)';
  ctx.fillStyle = '#8a919f';
  for (const e of graphSim.edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 - 3;
    ctx.strokeText(e.rel, mx, my);
    ctx.fillText(e.rel, mx, my);
  }
  // 节点
  for (const n of graphSim.nodes) {
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    ctx.fillStyle = GRAPH_COLORS[n.type] || '#3370ff';
    ctx.fill();
    ctx.strokeStyle = graphSim.selected === n.id ? '#1f2329' : '#ffffff';
    ctx.lineWidth = graphSim.selected === n.id ? 2.5 : 1.5;
    ctx.stroke();
  }
  // 节点名（大节点/放大/选中时显示）
  ctx.fillStyle = '#1f2329';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  for (const n of graphSim.nodes) {
    if (n.r >= 10 || graphSim.zoom > 1.3 || graphSim.selected === n.id) {
      ctx.fillText(n.name, n.x, n.y + n.r + 12);
    }
  }
}

// 屏幕坐标 → 模拟坐标（逆变换）
function graphPoint(ev) {
  const rect = ev.target.getBoundingClientRect();
  const W = rect.width, H = rect.height;
  return {
    x: (ev.clientX - rect.left - W / 2 - graphSim.ox) / graphSim.zoom + W / 2,
    y: (ev.clientY - rect.top - H / 2 - graphSim.oy) / graphSim.zoom + H / 2,
  };
}

function graphHit(p) {
  for (let i = graphSim.nodes.length - 1; i >= 0; i--) {
    const n = graphSim.nodes[i];
    const dx = p.x - n.x, dy = p.y - n.y;
    if (dx * dx + dy * dy <= (n.r + 3) * (n.r + 3)) return n;
  }
  return null;
}

// ---------- 节点详情 ----------
function renderGraphDetail(node) {
  const box = $('graph-detail');
  if (!node) { box.hidden = true; return; }
  box.hidden = false;
  const byId = new Map(state.graph.nodes.map((n) => [n.id, n]));
  const rels = state.graph.edges.filter((e) => e.from === node.id || e.to === node.id);
  const relHtml = rels.map((e) => {
    const otherId = e.from === node.id ? e.to : e.from;
    const other = byId.get(otherId);
    if (!other) return '';
    return `<div class="gd-rel" data-node="${otherId}">${escapeHtml(e.from === node.id ? node.name : other.name)}<span class="rel-tag">—${escapeHtml(e.rel)}→</span>${escapeHtml(e.from === node.id ? other.name : node.name)}</div>`;
  }).join('');
  box.innerHTML = `
    <h4><span class="gd-type" style="background:${GRAPH_COLORS[node.type] || '#3370ff'}">${GRAPH_TYPE_NAMES[node.type] || '概念'}</span>${escapeHtml(node.name)}</h4>
    <div class="gd-desc">${escapeHtml(node.desc || '（无描述）')}</div>
    <div class="gd-sec">关系（${rels.length}）</div>
    ${relHtml || '<div class="gd-desc">无</div>'}
    <div class="gd-sec">来源</div>
    ${(node.sources || []).map((s) => `<div class="gd-src">${escapeHtml(s)}</div>`).join('') || '<div class="gd-desc">无</div>'}
  `;
  box.querySelectorAll('.gd-rel').forEach((el) => {
    el.addEventListener('click', () => {
      const target = graphSim.nodes.find((n) => n.id === el.dataset.node);
      if (target) {
        graphSim.selected = target.id;
        renderGraphDetail(target);
      }
    });
  });
}

// ---------- 图谱操作 ----------
async function clearGraphData() {
  if (!state.graph.nodes.length) { toast('图谱已为空'); return; }
  if (!confirm('确定清空知识图谱？')) return;
  await window.kb.graphClear();
  await loadGraph();
  renderGraphEmpty();
  renderSidebar();
  toast('图谱已清空');
}

function bindGraphEvents() {
  renderGraphLegend();
  $('btn-graph-close').addEventListener('click', hideGraphView);
  $('btn-graph-clear').addEventListener('click', clearGraphData);
  $('btn-graph-fit').addEventListener('click', fitGraphView);
  $('btn-graph-focus').addEventListener('click', () => {
    state.kg.focus = null;
    startGraphSim();
    recenterGraph();
  });

  // KG 子视图与过滤
  $('kg-g-type').innerHTML = '<option value="">全部</option>' + Object.entries(GRAPH_TYPE_NAMES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  // 侧边栏知识图谱子菜单：点击子项打开图谱页并切换到对应子视图
  $('kg-submenu').addEventListener('click', (e) => {
    const item = e.target.closest('.nav-sub-item');
    if (!item) return;
    showGraphView();
    switchKgTab(item.dataset.tab);
  });
  ['kg-f-type', 'kg-f-src'].forEach((id) => $(id).addEventListener('change', renderKgEntities));
  $('kg-f-q').addEventListener('input', renderKgEntities);
  $('kg-f-refresh').addEventListener('click', () => { state.kg.onto = null; loadGraph(); });
  ['kg-g-type', 'kg-g-max', 'kg-g-sort', 'kg-g-domain'].forEach((id) => $(id).addEventListener('change', () => startGraphSim()));
  $('kg-onto-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-ot]');
    if (!b) return;
    state.kg.ontoTab = b.dataset.ot;
    document.querySelectorAll('#kg-onto-tabs button').forEach((x) => x.classList.toggle('active', x === b));
    renderKgOntology();
  });
  // 本体增删改查
  $('btn-onto-add').addEventListener('click', () => openOntoModal(state.kg.ontoTab, null));
  $('btn-onto-cancel').addEventListener('click', () => { $('onto-modal').hidden = true; });
  $('btn-onto-save').addEventListener('click', saveOntoItem);
  $('kg-onto-body').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const kind = state.kg.ontoTab === 'classes' ? 'classes' : state.kg.ontoTab === 'preds' ? 'preds' : 'cons';
    if (btn.dataset.act === 'edit') {
      const o = state.kg.onto;
      if (kind === 'classes') openOntoModal(kind, o.classes.find((c) => c.key === btn.dataset.key));
      else if (kind === 'preds') openOntoModal(kind, o.predicates.find((p) => p.key === btn.dataset.key));
      else openOntoModal(kind, { index: Number(btn.dataset.idx), text: o.constraints[Number(btn.dataset.idx)] });
    } else {
      removeOntoItem(kind, kind === 'cons' ? btn.dataset.idx : btn.dataset.key);
    }
  });
  $('btn-kg-ask').addEventListener('click', kgAskFlow);
  // 引用资料点击跳转：Wiki 页打开阅读器，笔记定位到编辑器
  $('kg-facts').addEventListener('click', (e) => {
    const el = e.target.closest('.kg-ref');
    if (!el) return;
    if (el.dataset.kind === 'wiki') openWikiPage(el.dataset.path);
    else if (state.notes.some((n) => n.id === el.dataset.path)) selectNote(el.dataset.path);
  });

  const canvas = $('graph-canvas');
  canvas.addEventListener('mousedown', (ev) => {
    const p = graphPoint(ev);
    const node = graphHit(p);
    graphSim.drag = { node, startX: ev.clientX, startY: ev.clientY, ox: graphSim.ox, oy: graphSim.oy, moved: false };
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('mousemove', (ev) => {
    if (!graphSim.drag) return;
    const d = graphSim.drag;
    if (Math.abs(ev.clientX - d.startX) + Math.abs(ev.clientY - d.startY) > 4) d.moved = true;
    if (d.node) {
      const p = graphPoint(ev);
      d.node.x = p.x; d.node.y = p.y;
      d.node.vx = 0; d.node.vy = 0;
      graphSim.alpha = Math.max(graphSim.alpha, 0.3); // 拖拽时加热，让相邻节点跟随调整
    } else {
      graphSim.ox = d.ox + (ev.clientX - d.startX);
      graphSim.oy = d.oy + (ev.clientY - d.startY);
    }
  });
  canvas.addEventListener('mouseup', (ev) => {
    const d = graphSim.drag;
    graphSim.drag = null;
    canvas.classList.remove('dragging');
    if (d && !d.moved) {
      const node = graphHit(graphPoint(ev));
      graphSim.selected = node ? node.id : null;
      renderGraphDetail(node || null);
    }
  });
  canvas.addEventListener('mouseleave', () => { graphSim.drag = null; canvas.classList.remove('dragging'); });
  canvas.addEventListener('dblclick', fitGraphView);
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const next = graphSim.zoom * (ev.deltaY < 0 ? 1.1 : 0.9);
    graphSim.zoom = Math.min(3, Math.max(0.4, next));
  }, { passive: false });
  // 布局空间变化时自动重新居中，避免图谱偏出可视区（尺寸未变时跳过，防止多余位移）
  if (window.ResizeObserver) {
    let lastW = 0, lastH = 0;
    new ResizeObserver(() => {
      const c = $('graph-canvas');
      if (!$('graph-view').hidden && (c.clientWidth !== lastW || c.clientHeight !== lastH)) {
        lastW = c.clientWidth; lastH = c.clientHeight;
        recenterGraph();
      }
    }).observe(canvas);
  }
}

