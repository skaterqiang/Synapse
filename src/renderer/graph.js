// 渲染进程·图谱模块：图谱视图、力导向布局、KG 子视图与 KG 问答
// ================= 知识图谱 =================
// 类型配色（蓝-青-紫-橙-灰）：图例/画布/详情徽标共用同一套，保证各子视图颜色一致
// GRAPH_PALETTE / GRAPH_COLORS / GRAPH_TYPE_NAMES 统一定义于 renderer/constants.js
// 画布模拟运行时状态（坐标/缩放/拖拽），与持久化数据分离
// hover：融合设计 §6.2 的悬停边（{edge, x, y}），用于高亮 + 推导链 tooltip
const graphSim = { nodes: [], edges: [], zoom: 1, ox: 0, oy: 0, drag: null, selected: null, hover: null, hoverNode: null, density: null, info: null, raf: 0, running: false, alpha: 1 };

// 高密度图谱仍绘制全量节点，只按“显示密度 + 缩放”收起低优先级文字和边细节。
function graphDensityPolicy(nodeCount = graphSim.nodes.length) {
  const modeEl = $('kg-g-density');
  const mode = modeEl ? modeEl.value : 'smart';
  return GraphDensity.detailPolicy({ mode, nodeCount, zoom: graphSim.zoom });
}

function updateGraphStats() {
  const info = graphSim.info;
  const box = $('graph-stats');
  if (!box || !info) return;
  const policy = graphDensityPolicy(info.nodeCount);
  graphSim.density = policy;
  box.textContent = `实体 ${info.nodeCount} · 边 ${info.edgeCount}`
    + (info.inferredCount ? `（其中 ${info.inferredCount} 条推理得出）` : '')
    + (info.truncated ? '（已截断到上限）' : '')
    + ` · ${policy.description}`
    + (info.updatedAt ? ` · 更新 ${formatDate(info.updatedAt)}` : '');
}

// 选中或悬停节点时，仅突出该节点的一跳邻居与关联边，降低大图中的视觉噪声。
function graphActiveNodeIds() {
  const center = graphSim.hoverNode || graphSim.selected;
  if (!center) return null;
  const ids = new Set([center]);
  for (const edge of graphSim.edges) {
    if (edge.from === center) ids.add(edge.to);
    if (edge.to === center) ids.add(edge.from);
  }
  return ids;
}

// 实体类列表（key/展示名/颜色）：以当前浏览本体体系为准，用户自定义类也能正确显示名称与配色
// 多体系共存时，图例只展示当前体系支持的类，避免把其他体系的类混入当前图例。
function graphTypes() {
  const filter = document.getElementById('kg-g-profile');
  const browsing = (filter && filter.value) || (state.kg && state.kg.onto && state.kg.onto.profileId);
  const seen = new Set();
  const list = [];
  const pushCls = (cls) => (cls || []).forEach((c) => {
    if (!c || !c.key || seen.has(c.key)) return;
    seen.add(c.key);
    list.push({ key: c.key, name: c.label || c.key });
  });
  if (browsing && state.kg.onto && Array.isArray(state.kg.onto.classes)) pushCls(state.kg.onto.classes);
  if (!list.length) Object.entries(GRAPH_TYPE_NAMES).forEach(([key, name]) => list.push({ key, name }));
  // 固定色优先；其余按黄金角生成（索引确定 → 同 key 跨会话同色），确保任意数量类型颜色互不重复
  return list.map((t, i) => ({ ...t, color: GRAPH_COLORS[t.key] || graphGenColor(i) }));
}

function graphTypeColor(key) {
  const t = graphTypes().find((x) => x.key === key);
  return t ? t.color : '#8a919f';
}

function graphTypeName(key) {
  const t = graphTypes().find((x) => x.key === key);
  return t ? t.name : (key || '未分类');
}

function showGraphView() {
  hideMainViews();
  $('graph-view').hidden = false;
  renderEditor();
  renderSidebar();
  loadGraph();
  switchKgTab(state.kg.tab || 'graph');
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
    state.graph = g || { nodes: [], edges: [], updatedAt: Date.now() };
  // 图例/类型下拉的名称与配色以本体定义为准，故先取一次本体（本地 kv 读取，开销可忽略）
  if (!state.kg.onto) state.kg.onto = await window.kb.graphOntology();
  // 领域下拉要显示领域中文名，而图谱作业可能刚自动新建了领域模版，故同步刷一次模版列表
  state.templates = (await window.kb.tplList()) || [];
  state.kg.graphProfiles = (await window.kb.graphProfiles()) || [];
  state.kg.graphScopes = window.kb.graphScopes ? ((await window.kb.graphScopes()) || []) : [];
  $('count-graph').textContent = state.graph.nodes.length;
  renderGraphProfileFilter();
  // 体系下拉重建后，按当前选中的 profile 重拉一次本体（初始渲染图例需与体系一致）
  const curPid = ($('kg-g-profile') || {}).value;
  if (curPid && (!state.kg.onto || state.kg.onto.profileId !== curPid)) {
    try { state.kg.onto = await window.kb.graphOntology(curPid); } catch (_) { /* 保留旧缓存 */ }
  }
  renderGraphDomainFilter();
  renderGraphStats();
  if (!$('graph-view').hidden) {
    renderKgTab();
    // 引用/笔记跳转会预设 focus：层级树在数据加载完成后才建好，故在此补一次选中居中
    if (state.kg.focus) {
      const sel = graphHierarchyEntityNode(state.kg.focus);
      if (sel) selectGraphNode(sel, { center: true });
    }
  }
}

// 一级筛选：本体体系；二级知识图谱筛选会随当前体系联动
function renderGraphProfileFilter() {
  const sel = $('kg-g-profile');
  if (!sel) return;
  // 不提供“全部本体体系”汇总项，但保留系统中的全部体系，包括暂时没有节点的体系
  const profiles = state.kg.graphProfiles || [];
  const cur = sel.dataset.userSelected === '1' ? sel.value : 'bfo-lite';
  sel.innerHTML = profiles.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name || p.id)}</option>`).join('');
  const next = profiles.some((p) => p.id === cur) ? cur : (profiles[0] && profiles[0].id) || '';
  sel.value = next;
}

// 二级筛选：只列出当前本体体系下实际存在的知识图谱/领域分组
function renderGraphDomainFilter() {
  const sel = $('kg-g-domain');
  if (!sel) return;
  const cur = sel.value;
  const name = (id) => {
    const t = (state.templates || []).find((x) => x.id === id);
    return t ? t.name : id;
  };
  const profile = ($('kg-g-profile') || {}).value || '';
  const scopes = (state.kg.graphScopes || []).filter((s) => !profile || s.profile === profile);
  sel.innerHTML = '<option value="">全部知识图谱</option>' + scopes.map((s) => {
    const label = `${s.label || name(s.domain)}（${s.nodeCount || 0} 节点）`;
    return `<option value="${escapeHtml(s.id)}">${escapeHtml(label)}</option>`;
  }).join('');
  sel.value = scopes.some((s) => s.id === cur) ? cur : '';
}

// 推理边计数（融合设计 §6.4）：统计文本与图例共用，避免两处口径漂移
function countInferredEdges(edges) {
  return (edges || []).filter((e) => e && e.inferred).length;
}

function renderGraphStats() {
  const g = state.graph;
  const inf = countInferredEdges(g.edges);
  $('graph-stats').textContent = g.nodes.length
    ? `${g.nodes.length} 节点 · ${g.edges.length} 关系${inf ? `（其中 ${inf} 条推理得出）` : ''} · 更新 ${formatDate(g.updatedAt)}`
    : '尚未抽取';
}

// 图例（整体图谱）：“图例”首标 + 各实体类色点/名称/当前画布内节点数（counts 缺省时不带计数）
// 融合设计 §6.4：末尾追加「边型」两行（推理边=紫色虚线 / 原始边=灰色实线），
// 与 drawGraph 的画法一一对应，用户看图例即可反推画布上的线型含义。
function renderGraphLegend(counts) {
  const box = $('graph-legend');
  box.innerHTML = '';
  const head = document.createElement('span');
  head.className = 'lg-head';
  head.textContent = '图例';
  box.appendChild(head);
  graphTypes().forEach((t) => {
    const c = counts ? (counts[t.key] || 0) : null;
    const s = document.createElement('span');
    s.className = 'lg-item' + (c === 0 ? ' zero' : '');
    s.title = c === null ? t.name : `${t.name}：当前画布 ${c} 个节点`;
    s.innerHTML = `<span class="lg-dot" style="background:${t.color}"></span>${escapeHtml(t.name)}`
      + (c === null ? '' : `<b class="lg-count">${c}</b>`);
    box.appendChild(s);
  });
  // 边型图例：counts 缺省（首屏未布局）时不显示计数，只显示线型说明
  const infN = counts ? countInferredEdges(graphSim.edges) : null;
  const rawN = counts ? (graphSim.edges.length - infN) : null;
  const edgeLegend = [
    { cls: 'lg-edge-inferred', name: '推理边', n: infN, tip: 'OWL 2 RL 推理得出（虚线）· 悬停查看推导链' },
    { cls: 'lg-edge-raw', name: '原始边', n: rawN, tip: '从笔记/原始文件直接抽取（实线）' },
  ];
  edgeLegend.forEach((it) => {
    const s = document.createElement('span');
    s.className = 'lg-item lg-edge' + (it.n === 0 ? ' zero' : '');
    s.title = it.n === null ? it.tip : `${it.tip}：当前画布 ${it.n} 条`;
    s.innerHTML = `<span class="lg-line ${it.cls}"></span>${escapeHtml(it.name)}`
      + (it.n === null ? '' : `<b class="lg-count">${it.n}</b>`);
    box.appendChild(s);
  });
  const tip = document.createElement('span');
  tip.className = 'lg-tip';
  tip.textContent = '拖拽节点 · 滚轮缩放 · 点击节点查看关系 · 悬停虚线看推导链';
  box.appendChild(tip);
}

function renderGraphEmpty() {
  let em = $('graph-empty');
  if (state.graph.nodes.length) { if (em) em.remove(); return; }
  const body = $('graph-view').querySelector('.graph-body');
  if (!em) {
    em = document.createElement('div');
    em.id = 'graph-empty';
    em.className = 'graph-empty';
    em.innerHTML = '<div class="empty-icon">' + icoSvg('kg', 44) + '</div><p>暂无知识图谱：选择上方范围后点击「抽取本体层」，<br>AI 将自动从笔记与原始文件中提取实体与关系。</p>';
    body.appendChild(em);
  }
  // 空态只覆盖画布区域，保留左侧图谱层级根节点可浏览。
  const hierarchy = $('graph-hierarchy');
  const detail = $('graph-detail');
  em.style.left = hierarchy ? `${hierarchy.offsetWidth}px` : '0';
  em.style.right = detail && !detail.hidden ? `${detail.offsetWidth}px` : '0';
}

// 邻居视图提示按钮：显示中心节点名，点击退出邻居视图
function updateGraphFocusChip() {
  const btn = $('btn-graph-focus');
  if (!btn) return;
  const node = state.kg.focus && state.graph.nodes.find((n) => n.id === state.kg.focus);
  if (node) {
    btn.hidden = false;
    btn.innerHTML = icoSvg('kg', 12) + `邻居视图：${escapeHtml(node.name)} ✕`;
  } else {
    state.kg.focus = null;
    btn.hidden = true;
  }
}

// ---------- 社区划分（标签传播）----------
// 目的：让布局出现“不同的聚集区域”而不是一团匀质的点。
// 算法：每个节点反复取“邻居中最多数的社区”，几轮即收敛；有领域标注时优先按领域分组。
function detectCommunities(nodes, edges) {
  const comm = new Map();
  // 节点带领域归属时直接用领域分组（语义上比连通结构更可靠）
  const domains = new Set(nodes.map((n) => n.domain || ''));
  if (domains.size > 1 && !domains.has('')) {
    nodes.forEach((n) => comm.set(n.id, 'd:' + n.domain));
    return comm;
  }
  const nb = new Map(nodes.map((n) => [n.id, []]));
  edges.forEach((e) => {
    if (nb.has(e.from) && nb.has(e.to)) { nb.get(e.from).push(e.to); nb.get(e.to).push(e.from); }
  });
  nodes.forEach((n) => comm.set(n.id, n.id));
  const order = nodes.map((n) => n.id);
  for (let iter = 0; iter < 8; iter++) {
    let moved = 0;
    for (const id of order) {
      const tally = new Map();
      for (const other of nb.get(id) || []) {
        const c = comm.get(other);
        tally.set(c, (tally.get(c) || 0) + 1);
      }
      if (!tally.size) continue;
      // 票数相同时取字典序最小，保证多次运行结果稳定（布局不会每次重排都变）
      let best = null;
      let bestN = -1;
      for (const [c, k] of [...tally.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
        if (k > bestN) { best = c; bestN = k; }
      }
      if (best !== comm.get(id)) { comm.set(id, best); moved++; }
    }
    if (!moved) break;
  }
  return comm;
}

// ---------- 力导向布局与绘制 ----------
function startGraphSim() {
  const canvas = $('graph-canvas');
  const selectedId = graphSim.selected == null ? null : String(graphSim.selected);
  const tree = graphHierarchyState();
  updateGraphFocusChip();
  const g = kgFilteredGraph();
  const old = new Map(graphSim.nodes.map((n) => [n.id, n]));
  const W = canvas.clientWidth || 800;
  const H = canvas.clientHeight || 600;
  // 节点半径按度数（连边数）放大：枢纽节点一眼可辨，sqrt 压缩避免超大圆
  const deg = {};
  g.edges.forEach((e) => { deg[e.from] = (deg[e.from] || 0) + 1; deg[e.to] = (deg[e.to] || 0) + 1; });
  // 社区划分后，将每个社区放到随画布宽高扩展的独立网格区域。
  // 宽屏不再按最短边压成一个中心圆，节点可充分利用横向空间。
  const comm = detectCommunities(g.nodes, g.edges);
  const commKeys = [...new Set(g.nodes.map((n) => comm.get(n.id)))];
  const commIdx = new Map(commKeys.map((k, i) => [k, i]));
  const commSizes = new Map();
  g.nodes.forEach((n) => {
    const ci = commIdx.get(comm.get(n.id)) || 0;
    commSizes.set(ci, (commSizes.get(ci) || 0) + 1);
  });
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  const nc = Math.max(1, commKeys.length);
  const zones = new Map(commKeys.map((_, i) => [i, GraphDensity.communityZone(i, nc, W, H)]));
  const seenInComm = new Map();
  graphSim.nodes = g.nodes.map((n) => {
    const o = old.get(n.id);
    const ci = commIdx.get(comm.get(n.id)) || 0;
    const k = seenInComm.get(ci) || 0;
    const total = commSizes.get(ci) || 1;
    const zone = zones.get(ci);
    seenInComm.set(ci, k + 1);
    const angle = k * GOLDEN + ci * 0.71;
    const spread = Math.sqrt((k + 0.5) / total);
    return {
      ...n,
      comm: ci,
      anchorX: zone.cx,
      anchorY: zone.cy,
      x: o ? o.x : zone.cx + Math.cos(angle) * zone.width * 0.42 * spread,
      y: o ? o.y : zone.cy + Math.sin(angle) * zone.height * 0.42 * spread,
      vx: 0, vy: 0,
      r: 7 + Math.min(12, Math.sqrt(deg[n.id] || 0) * 3.2),
    };
  });
  // 图例计数只统当前过滤后进入画布的节点与边：必须在 graphSim.edges 赋值之后渲染，
  // 否则边型计数（推理边/原始边）会残留上一范围的旧值，与右侧“实体 n · 边 m”口径不一致
  const counts = {};
  g.nodes.forEach((n) => { counts[n.type] = (counts[n.type] || 0) + 1; });
  const ids = new Set(graphSim.nodes.map((n) => n.id));
  graphSim.edges = g.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  renderGraphLegend(counts);
  graphSim.zoom = 1; graphSim.ox = 0; graphSim.oy = 0;
  const selectedNode = selectedId == null ? null : graphSim.nodes.find((node) => String(node.id) === selectedId);
  graphSim.selected = selectedNode ? selectedNode.id : null;
  // 过滤后实体不可见时只清理实体选中；类型/根节点选中仍应在树中保持。
  if (!selectedNode && tree.selectedKey && String(tree.selectedKey).startsWith('graph:entity:')) tree.selectedKey = null;
  graphSim.hoverNode = null;
  // 重排后旧边对象已被替换，悬停高亮/tooltip 必须一并清掉（否则指向失效对象）
  graphSim.hover = null;
  hideEdgeTooltip();
  const metrics = GraphDensity.layoutMetrics({ width: W, height: H, nodeCount: graphSim.nodes.length });
  graphSim.metrics = metrics;
  // 同步预计算布局至收敛：大图增加迭代次数，优先保障节点圆的间隔。
  let a = 1;
  for (let i = 0; i < metrics.iterations && a > 0.02; i++) {
    physicsStep(W, H, a);
    a = Math.max(0, a * 0.99 - 0.0004);
  }
  // 预收敛后一次性清理残余重叠；后续自适应仅更新视口，不再二次压缩布局坐标。
  settleCollisions();
  recenterGraph();
  graphSim.alpha = 0;
  graphSim.info = {
    nodeCount: g.nodes.length,
    edgeCount: graphSim.edges.length,
    inferredCount: countInferredEdges(graphSim.edges),
    truncated: g.truncated,
    updatedAt: state.graph.updatedAt,
  };
  updateGraphStats();
  renderGraphHierarchy(g.nodes);
  renderGraphDetail(selectedNode || null);
  renderGraphEmpty();
  if (!graphSim.running) {
    graphSim.running = true;
    graphSim.raf = requestAnimationFrame(graphTick);
  }
}

function stopGraphSim() {
  graphSim.running = false;
  cancelAnimationFrame(graphSim.raf);
  // 悬停状态随画布一起失效，避免关掉图谱页后 tooltip 残留在页面上
  graphSim.hover = null;
  graphSim.hoverNode = null;
  hideEdgeTooltip();
}

function graphTick() {
  if (!graphSim.running) return;
  const canvas = $('graph-canvas');
  const W = canvas.clientWidth || 800;
  const H = canvas.clientHeight || 600;
  // 布局静止后不再逐帧重画；大图只在拖拽或物理仍在收敛时重绘，降低 Canvas 空转开销。
  const active = graphSim.alpha > 0.02 || (graphSim.drag && graphSim.drag.moved);
  if (active) {
    if (graphSim.alpha > 0.02) {
      physicsStep(W, H, graphSim.alpha);
      graphSim.alpha = Math.max(0, graphSim.alpha * 0.99 - 0.0004);
    }
    drawGraph();
  }
  graphSim.raf = requestAnimationFrame(graphTick);
}

// 单步物理：斥力 + 弹簧 + 社区锚点，所有力均随温度 a0 衰减。
// 使用随画布宽高伸展的椭圆边界，避免宽屏图谱被压缩为最短边决定的中心圆团。
function physicsStep(W, H, a0) {
  const nodes = graphSim.nodes;
  const cx = W / 2, cy = H / 2;
  const metrics = graphSim.metrics || GraphDensity.layoutMetrics({ width: W, height: H, nodeCount: nodes.length });
  const { rx, ry, spacing, gap: GAP } = metrics;
  const repK = spacing * spacing * 1.05;
  const repRange2 = (spacing * 2.45) ** 2;
  const springLen = spacing * 1.22;
  // 节点间斥力与温度缩放的几何分离：冷却后不再持续推挤，避免点击后的物理抖动。
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      const cross = a.comm !== b.comm;
      const dx = a.x - b.x, dy = a.y - b.y;
      const d2 = dx * dx + dy * dy || 1;
      if (d2 < (cross ? repRange2 * 2.4 : repRange2)) {
        const f = ((cross ? repK * 2 : repK) / d2) * a0;
        a.vx += dx * f; a.vy += dy * f;
        b.vx -= dx * f; b.vy -= dy * f;
      }
      const minD = a.r + b.r + GAP;
      if (d2 < minD * minD) {
        const d = Math.sqrt(d2) || 1;
        const push = Math.min(3, ((minD - d) / 2) * Math.min(1, a0 * 3));
        const ux = dx / d, uy = dy / d;
        a.x += ux * push; a.y += uy * push;
        b.x -= ux * push; b.y -= uy * push;
      }
    }
  }
  // 关系弹簧：跨社区边更长，既保留关系又避免把不同区域拽回同一团。
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const e of graphSim.edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) continue;
    const rest = a.comm === b.comm ? springLen : springLen * 2.6;
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const m = Math.max(-4, Math.min(4, (d - rest) * 0.018)) * a0;
    const ux = dx / d, uy = dy / d;
    a.vx += ux * m; a.vy += uy * m;
    b.vx -= ux * m; b.vy -= uy * m;
  }
  const multiCommunity = new Set(nodes.map((n) => n.comm)).size > 1;
  for (const n of nodes) {
    // 社区锚点只做轻度约束：保障分区，又不挤压团内的节点间隔。
    if (multiCommunity && Number.isFinite(n.anchorX) && Number.isFinite(n.anchorY)) {
      n.vx += (n.anchorX - n.x) * 0.0016 * a0;
      n.vy += (n.anchorY - n.y) * 0.0016 * a0;
    }
    // 椭圆软边界：按水平/垂直半径归一化后判定是否越界。
    const ex = (n.x - cx) / rx, ey = (n.y - cy) / ry;
    const norm = Math.hypot(ex, ey) || 1;
    if (norm > 1) {
      const pull = Math.min(7, spacing * 0.55 + (norm - 1) * 7) * a0;
      n.vx -= (ex / norm) * pull;
      n.vy -= (ey / norm) * pull;
    }
    if (graphSim.drag && graphSim.drag.node === n) { n.vx = 0; n.vy = 0; continue; }
    const vCap = 6 * Math.min(1, 0.25 + a0 * 2);
    n.vx = Math.max(-vCap, Math.min(vCap, n.vx * 0.85));
    n.vy = Math.max(-vCap, Math.min(vCap, n.vy * 0.85));
    n.x += n.vx; n.y += n.vy;
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) {
      n.x = cx; n.y = cy; n.vx = 0; n.vy = 0;
    }
    // 极端位置一次性裁到椭圆外沿，防止离群点拉大自适应范围。
    const ox = (n.x - cx) / rx, oy = (n.y - cy) / ry;
    const outer = Math.hypot(ox, oy) || 1;
    if (outer > 1.2) {
      n.x = cx + (n.x - cx) * (1.2 / outer);
      n.y = cy + (n.y - cy) * (1.2 / outer);
    }
  }
}

// ---------- KG 模块子视图 ----------
// 整体图谱过滤：领域/类型/边类型/最多节点/排序（按边数优先保留高连接节点）
function kgFilteredGraph() {
  const typeEl = $('kg-g-type');
  const type = typeEl ? typeEl.value : '';
  const profile = ($('kg-g-profile') || {}).value || '';
  const scope = ($('kg-g-domain') || {}).value || '';
  const maxRaw = parseInt(($('kg-g-max') || {}).value || '100', 10);
  const max = Number.isFinite(maxRaw) ? maxRaw : 100; // 0 = 全部
  const sort = ($('kg-g-sort') || {}).value || 'deg';
  // 融合设计 §6.3：边类型筛选（全部 / 仅原始 / 仅推理）
  const edgeKind = ($('kg-g-edgekind') || {}).value || 'all';
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
  if (profile) nodes = nodes.filter((n) => (n.profile || 'bfo-lite') === profile);
  if (scope) nodes = nodes.filter((n) => `${n.profile || 'bfo-lite'}|${n.domain || 'general'}` === scope);
  if (type) nodes = nodes.filter((n) => n.type === type);
  const ids0 = new Set(nodes.map((n) => n.id));
  let edges = state.graph.edges.filter((e) => ids0.has(e.from) && ids0.has(e.to));
  // 边类型过滤只裁边、不反向裁节点：§6.3 明确「倾向允许孤立节点显示」，
  // 这样切到「仅推理」时能看到推理产出的新连接落在哪些实体上，而不是一片空白。
  if (edgeKind === 'raw') edges = edges.filter((e) => !e.inferred);
  else if (edgeKind === 'inferred') edges = edges.filter((e) => !!e.inferred);
  const deg = {};
  edges.forEach((e) => { deg[e.from] = (deg[e.from] || 0) + 1; deg[e.to] = (deg[e.to] || 0) + 1; });
  nodes.sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name, 'zh') : (deg[b.id] || 0) - (deg[a.id] || 0)));
  const truncated = max > 0 && nodes.length > max;
  if (truncated) nodes = nodes.slice(0, max);
  const ids = new Set(nodes.map((n) => n.id));
  edges = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  return { nodes, edges, truncated, edgeKind };
}

// ---------- 整体图谱 Class hierarchy 联动 ----------
function graphHierarchyState() {
  const kg = state.kg || (state.kg = {});
  if (!kg.graphTree) kg.graphTree = { collapsed: {}, selectedKey: null, hierarchy: null };
  if (!kg.graphTree.collapsed) kg.graphTree.collapsed = {};
  return kg.graphTree;
}

function graphHierarchyEntityNode(entityId) {
  return graphSim.nodes.find((node) => String(node.id) === String(entityId)) || null;
}

function expandGraphHierarchyAncestors(tree, key) {
  const hierarchy = tree && tree.hierarchy;
  if (!hierarchy || !key) return;
  const seen = new Set();
  let current = key;
  while (current && !seen.has(current)) {
    seen.add(current);
    const parent = hierarchy.parentByKey.get(current);
    if (!parent) break;
    tree.collapsed[parent] = false;
    current = parent;
  }
}

function applyGraphHierarchyDefaultCollapse(tree) {
  if (!tree || !tree.hierarchy || !window.GraphHierarchy || !window.GraphHierarchy.defaultCollapsedKeys) return;
  const defaults = window.GraphHierarchy.defaultCollapsedKeys(tree.hierarchy.classes, {
    rootKey: tree.hierarchy.rootKey,
    collapseFromTypeDepth: 2,
  });
  for (const key of defaults) {
    if (!Object.prototype.hasOwnProperty.call(tree.collapsed, key)) tree.collapsed[key] = true;
  }
}

function scrollGraphHierarchySelection() {
  const tree = graphHierarchyState();
  if (!tree.selectedKey) return;
  requestAnimationFrame(() => {
    const pane = $('graph-hierarchy');
    if (!pane) return;
    const row = [...pane.querySelectorAll('.och-row')].find((item) => item.dataset.key === tree.selectedKey);
    if (row) row.scrollIntoView({ block: 'nearest' });
  });
}

function renderGraphHierarchy(nodes) {
  const pane = $('graph-hierarchy');
  if (!pane) return;
  if (!window.GraphHierarchy || !window.renderClassHierarchy) {
    pane.innerHTML = '<div class="och-empty">图谱层级组件未加载</div>';
    return;
  }
  const tree = graphHierarchyState();
  const sourceNodes = Array.isArray(nodes) ? nodes : graphSim.nodes;
  const typeDefs = graphTypes().map((type) => ({ key: type.key, label: type.name, name: type.name, color: type.color }));
  tree.hierarchy = window.GraphHierarchy.buildGraphHierarchy({
    nodes: sourceNodes,
    ontologyClasses: ((state.kg.onto || {}).classes || []),
    typeDefs,
  });
  applyGraphHierarchyDefaultCollapse(tree);
  const selectedNode = graphSim.selected == null ? null : sourceNodes.find((node) => String(node.id) === String(graphSim.selected));
  if (selectedNode) tree.selectedKey = tree.hierarchy.entityToKey.get(String(selectedNode.id)) || null;
  else if (tree.selectedKey && !tree.hierarchy.parentByKey.has(tree.selectedKey)) tree.selectedKey = null;
  if (tree.selectedKey) expandGraphHierarchyAncestors(tree, tree.selectedKey);
  window.renderClassHierarchy(pane, { classes: tree.hierarchy.classes }, {
    title: '图谱层级',
    subtitle: '当前筛选',
    emptyText: '当前筛选范围暂无实体',
    // 虚拟根仅用于计数与类型筛选联动；视觉上直接从第一层类型开始，贴合图谱列表浏览习惯。
    hiddenKeys: [tree.hierarchy.rootKey],
    collapsed: tree.collapsed,
    selectedKey: tree.selectedKey,
    onSelect: selectGraphHierarchyItem,
    onHover: hoverGraphHierarchyItem,
  });
}

function selectGraphHierarchyItem(item) {
  const tree = graphHierarchyState();
  const meta = item.meta || {};
  if (meta.kind === 'entity') {
    const node = graphHierarchyEntityNode(meta.entityId);
    if (node) selectGraphNode(node, { center: true, scrollTree: false });
    return;
  }
  tree.selectedKey = item.key;
  graphSim.selected = null;
  renderGraphDetail(null);
  const typeFilter = $('kg-g-type');
  if (meta.kind === 'type' && typeFilter && typeFilter.value !== meta.type) {
    typeFilter.value = meta.type;
    startGraphSim();
    return;
  }
  if (meta.kind === 'root' && typeFilter && typeFilter.value) {
    typeFilter.value = '';
    startGraphSim();
    return;
  }
  renderGraphHierarchy();
  drawGraph();
}

function hoverGraphHierarchyItem(item) {
  const meta = (item && item.meta) || {};
  setHoverNode(meta.kind === 'entity' ? graphHierarchyEntityNode(meta.entityId) : null);
}

function syncGraphHierarchySelection(opts = {}) {
  const tree = graphHierarchyState();
  if (graphSim.selected != null && tree.hierarchy) {
    const key = tree.hierarchy.entityToKey.get(String(graphSim.selected));
    if (key) {
      tree.selectedKey = key;
      expandGraphHierarchyAncestors(tree, key);
    }
  } else if (tree.selectedKey && String(tree.selectedKey).startsWith('graph:entity:')) {
    tree.selectedKey = null;
  }
  renderGraphHierarchy();
  if (opts.scroll) scrollGraphHierarchySelection();
}

function centerGraphOnNode(node) {
  const canvas = $('graph-canvas');
  if (!node || !canvas) return;
  const W = canvas.clientWidth || 800;
  const H = canvas.clientHeight || 600;
  graphSim.ox = -(node.x - W / 2) * graphSim.zoom;
  graphSim.oy = -(node.y - H / 2) * graphSim.zoom;
  updateGraphStats();
  drawGraph();
}

function selectGraphNode(node, opts = {}) {
  const selected = node || null;
  graphSim.selected = selected ? selected.id : null;
  renderGraphDetail(selected);
  if (selected && opts.center) centerGraphOnNode(selected);
  else drawGraph();
  syncGraphHierarchySelection({ scroll: opts.scrollTree !== false });
}

// KG_TAB_NAMES 定义于 renderer/constants.js

function switchKgTab(tab) {
  state.kg.tab = tab;
  document.querySelectorAll('.kg-pane').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
  $('kg-crumb-sub').textContent = KG_TAB_NAMES[tab] || tab;
  renderSidebar();
  renderKgTab();
}

function renderKgTab() {
  const tab = state.kg.tab;
  if (tab === 'graph') startGraphSim();
  else if (tab === 'ontology') renderKgOntology();
  else if (tab === 'reason') renderKgReasonTab($('kg-reason-body'), state.kg.onto && state.kg.onto.profileId);
}

// 打开整体图谱并定位到指定实体：以 focus 进入邻居视图并选中居中（聊天引用/笔记关联图谱跳转用）
function focusGraphEntity(id) {
  state.kg.focus = id;
  state.kg.tab = 'graph';
  showGraphView();
  const sel = graphHierarchyEntityNode(id);
  if (sel) selectGraphNode(sel, { center: true });
}

function kgCard(icon, num, label, sub) {
  return `<div class="kg-card"><span class="kg-card-icon">${icoSvg(icon, 16)}</span><div><b>${num}</b><span>${label}</span>${sub ? `<em class="kg-card-sub">${escapeHtml(sub)}</em>` : ''}</div></div>`;
}

async function renderKgOntology() {
  if (!state.kg.onto) state.kg.onto = await window.kb.graphOntology();
  const o = state.kg.onto;
  // 体系 tab（内置三体系 + OWL 导入，横排展开，每项带 类/谓词/约束 计数）
  // 仅浏览/编辑入口：抽取与问答时由 AI 按内容自动选择体系（领域模版绑定优先），此处切换不写全局默认
  const tabs = $('onto-profile-tabs');
  if (tabs && o.profiles) {
    const sig = o.profiles.map((p) => p.id + ':' + JSON.stringify(p.counts || {})).join(',');
    if (tabs.dataset.sig !== sig) {
      tabs.dataset.sig = sig;
      tabs.innerHTML = o.profiles.map((p) => {
        const c = p.counts || {};
        const cnt = c.classes !== undefined ? `<span class="onto-prof-count">${c.classes}类·${c.predicates}谓·${c.constraints}约</span>` : '';
        const note = `仅浏览/编辑该体系；抽取与问答时由 AI 自动选择合适体系。${p.desc || ''}`;
        return `<button data-pid="${escapeHtml(p.id)}" class="${p.owl ? 'is-owl' : ''}" title="${escapeHtml(note)}">${escapeHtml(p.name)}${p.owl ? '<span class="mini-tag onto-prof-owl">OWL</span>' : ''}${cnt}</button>`;
      }).join('');
    }
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.pid === o.profileId));
    const pd = $('onto-profile-desc');
    if (pd) pd.textContent = `${o.profileName || ''} · ${o.profileDesc || ''} · ${o.promptMode === 'two-stage' ? '两阶段提取' : '单阶段提取'} · 仅浏览/编辑，抽取与问答时 AI 自动选择体系`;
    const btnRemoveOwl = $('btn-onto-remove-owl');
    if (btnRemoveOwl) btnRemoveOwl.hidden = !String(o.profileId || '').startsWith('owl:');
  }
  // 统计卡：前 3 项属于当前体系（类/谓词/约束），后 2 项是全局图谱实例（跨体系累计）
  $('kg-onto-cards').innerHTML =
    kgCard('entities', o.stats.classCount, '实体类', o.profileName) +
    kgCard('mcp', o.stats.predicateCount, '谓词', o.profileName) +
    kgCard('table', o.stats.constraintCount, '校验约束', o.profileName) +
    kgCard('kg', o.stats.instanceCount, '实例总数', '全部体系') +
    kgCard('mcp', o.stats.edgeCount, '关系总数', '全部体系') +
    kgCard('table', o.stats.axiomCount || 0, '逻辑公理', o.profileName);

  // 视图切换：OWLViz / 列表（'tree' 已废弃，归一为 'viz'）
  let view = state.kg.ontoView || 'viz';
  if (view !== 'viz' && view !== 'list') view = 'viz';
  state.kg.ontoView = view;
  const vizWrap = $('onto-viz-wrap');
  const listBar = $('onto-list-bar');
  const listBody = $('kg-onto-body');
  document.querySelectorAll('#onto-view-tabs button').forEach((x) => x.classList.toggle('active', x.dataset.ov === view));
  if (vizWrap) vizWrap.hidden = view !== 'viz';
  if (listBar) listBar.hidden = view !== 'list';
  if (listBody) listBody.hidden = view !== 'list';
  // 公理 tab 只读：隐藏「新增」按钮
  const btnOntoAdd = $('btn-onto-add');
  if (btnOntoAdd) btnOntoAdd.hidden = view === 'list' && state.kg.ontoTab === 'axioms';
  // 列表视图时同步 Tab 高亮（外部代码直接改 state.kg.ontoTab 后 render 也要生效）
  if (view === 'list') {
    document.querySelectorAll('#kg-onto-tabs button').forEach((x) => x.classList.toggle('active', x.dataset.ot === state.kg.ontoTab));
  }

  // 点击类节点：切到列表视图并高亮对应类卡片
  const jumpToClassCard = (cls) => {
    state.kg.ontoView = 'list';
    state.kg.ontoTab = 'classes';
    document.querySelectorAll('#kg-onto-tabs button').forEach((x) => x.classList.toggle('active', x.dataset.ot === 'classes'));
    renderKgOntology();
    setTimeout(() => {
      const cards = document.querySelectorAll('#kg-onto-body .kg-class');
      for (const card of cards) {
        const code = card.querySelector('code');
        if (code && code.textContent === cls.key) {
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          card.style.outline = '1.5px solid var(--accent)';
          card.style.outlineOffset = '2px';
          setTimeout(() => { card.style.outline = ''; card.style.outlineOffset = ''; }, 1800);
          break;
        }
      }
    }, 30);
  };
  // OWLViz 风格横向 is-a 层级图（默认图形视图）
  if (view === 'viz' && vizWrap && window.renderOntologyViz) {
    // 两栏布局：左 class hierarchy 树 + 右 OWLViz 画布（仿 Protégé），共享 selectedKey 双向联动
    vizWrap.innerHTML = '<div class="och-pane" id="onto-class-hierarchy"></div><div class="ovz-pane" id="onto-viz-canvas"></div>';
    const hierPane = $('onto-class-hierarchy');
    const canvasPane = $('onto-viz-canvas');
    const vizClasses = (o.classes || []).map((c) => ({ key: c.key, label: c.label, desc: c.desc, parent: c.parent || null, custom: !!c.custom, instances: c.instances || 0 }));
    // 共享选中态（跨重渲保持）；focusKey 控制 OWLViz 深度聚焦子图
    if (!state.kg.vizSel) state.kg.vizSel = { key: null, collapsed: {} };
    const sel = state.kg.vizSel;
    const ontoForViz = { classes: vizClasses };

    // 渲染右侧 OWLViz 画布（可重入：聚焦/取消聚焦时重建 SVG）
    // focusKey 有值 → 画该节点前 3 级祖先 + 后 3 级子孙；无值 → 默认前 3 级
    const renderVizCanvas = (focusKey) => {
      canvasPane.innerHTML = '<svg id="onto-viz-svg" role="img" aria-label="本体 OWLViz 层级图"></svg>';
      const svg = $('onto-viz-svg');
      window.renderOntologyViz(svg, ontoForViz, {
        focusKey: focusKey || null,
        maxDepth: 3, upDepth: 3, downDepth: 3,
        onSelect: (cls) => {
          // 反向联动：点 OWLViz 节点 → 选中 + 树定位 + 聚焦该节点子图
          sel.key = cls.key;
          renderVizCanvas(cls.key);
          renderHier();
          const row = hierPane.querySelector(`.och-row[data-key="${CSS.escape(cls.key)}"]`);
          if (row) row.scrollIntoView({ block: 'nearest' });
        },
        onBackgroundDblClick: () => {
          // 双击空白 → 退出聚焦，回默认前 3 级全览并清选中
          sel.key = null;
          renderVizCanvas(null);
          renderHier();
        },
      });
      // 渲染后若已有选中节点，恢复其高亮（重渲会丢 DOM 选中类）
      if (sel.key && svg.__selectNode) {
        // 不居中（避免每次重渲都跳动），仅补高亮描边
        const node = svg.querySelector(`.ovz-node[data-key="${CSS.escape(sel.key)}"]`);
        if (node) node.classList.add('is-selected');
      }
    };

    // 渲染左侧层级树；选中/悬停 → 联动右侧 OWLViz
    const renderHier = () => {
      if (!window.renderClassHierarchy) return;
      window.renderClassHierarchy(hierPane, ontoForViz, {
        collapsed: sel.collapsed,
        selectedKey: sel.key,
        onSelect: (cls) => {
          sel.key = cls.key;
          // 树选中 → 聚焦该节点的前后 3 级子图
          renderVizCanvas(cls.key);
          renderHier(); // 重渲树以更新选中高亮
        },
        onHover: (cls) => {
          const svg = $('onto-viz-svg');
          if (!svg) return;
          if (!cls) { if (svg.__clearHover) svg.__clearHover(); return; }
          if (svg.__hoverNode) svg.__hoverNode(cls.key);
        },
      });
    };
    renderHier();
    renderVizCanvas(sel.key);
  }
  // 内置基座项只读（无操作按钮），用户自定义项可编辑删除并带徽标
  const acts = (attr, readonly) => readonly
    ? '<span class="kg-class-acts"><span class="mini-tag" style="opacity:.55">内置</span></span>'
    : `<span class="kg-class-acts">${attr.custom ? '<span class="mini-tag" style="color:var(--accent)">自定义</span>' : ''}<button class="icon-btn" data-act="edit" ${attr.data} title="编辑">${icoSvg('edit', 12)}</button><button class="icon-btn danger" data-act="del" ${attr.data} title="删除">${icoSvg('close', 12)}</button></span>`;
  const body = $('kg-onto-body');
  if (state.kg.ontoTab === 'classes') {
    const byKey = new Map(o.classes.map((c) => [c.key, c]));
    const childrenOf = new Map();
    for (const c of o.classes) {
      const parentKey = c.parent && byKey.has(c.parent) ? c.parent : null;
      if (!childrenOf.has(parentKey)) childrenOf.set(parentKey, []);
      childrenOf.get(parentKey).push(c);
    }
    // 子树折叠状态（按类 key）：默认全部展开，点击父节点头部箭头切换
    const collapsed = state.kg.ontoCollapsed || (state.kg.ontoCollapsed = {});
    const renderNode = (c) => {
      const kids = childrenOf.get(c.key) || [];
      const isCollapsed = !!collapsed[c.key];
      const toggle = kids.length
        ? `<button class="icon-btn kg-onto-toggle${isCollapsed ? ' collapsed' : ''}" data-toggle="${escapeHtml(c.key)}" title="${isCollapsed ? '展开子类' : '收起子类'}"><svg class="ico" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></button><span class="mini-tag kg-onto-kidcount">${kids.length} 子类</span>`
        : '';
      return `
      <div class="kg-class-node">
        <div class="kg-class">
          <div class="kg-class-head">${toggle}<code>${escapeHtml(c.key)}</code><b>${escapeHtml(c.label)}</b><span>${escapeHtml(c.desc)}</span><em>${c.instances} 实例</em>${acts({ custom: c.custom, data: `data-key="${escapeHtml(c.key)}"` }, c.builtin && !c.custom)}</div>
          <div class="kg-class-ex">示例：${(c.examples || []).map((s) => `<span class="mini-tag">${escapeHtml(s)}</span>`).join(' ') || '—'}</div>
        </div>
        ${kids.length && !isCollapsed ? `<div class="kg-onto-kids">${kids.map(renderNode).join('')}</div>` : ''}
      </div>`;
    };
    const roots = childrenOf.get(null) || [];
    body.innerHTML = roots.length
      ? roots.map(renderNode).join('')
      : '<div class="gd-desc">当前体系下未找到层级关系，已按平铺展示。</div>' + o.classes.map((c) => `
      <div class="kg-class">
        <div class="kg-class-head"><code>${escapeHtml(c.key)}</code><b>${escapeHtml(c.label)}</b><span>${escapeHtml(c.desc)}</span><em>${c.instances} 实例</em>${acts({ custom: c.custom, data: `data-key="${escapeHtml(c.key)}"` }, c.builtin && !c.custom)}</div>
        <div class="kg-class-ex">示例：${(c.examples || []).map((s) => `<span class="mini-tag">${escapeHtml(s)}</span>`).join(' ') || '—'}</div>
      </div>`).join('');
  } else if (state.kg.ontoTab === 'preds') {
    body.innerHTML = o.predicates.map((p) => {
      const aliasStr = Array.isArray(p.aliases) && p.aliases.length
        ? `<div class="kg-class-ex"><span class="mini-tag" style="opacity:.55">别名</span>${p.aliases.map(escapeHtml).join(' <span style="opacity:.35">·</span> ')}</div>`
        : '';
      return `<div class="kg-class"><div class="kg-class-head"><code>${escapeHtml(p.key)}</code><span>${escapeHtml(p.desc)}</span>${acts({ custom: p.custom, data: `data-key="${escapeHtml(p.key)}"` }, p.builtin && !p.custom)}</div>${aliasStr}</div>`;
    }).join('');
  } else if (state.kg.ontoTab === 'cons') {
    // 合并顺序：[...内置(from base), ...自定义(from custom)]；自定义项 data-idx 需映射回 userConstraints 索引（减去内置数）
    const baseCount = (o.constraints || []).filter((c) => typeof c === 'object' && c.from === 'base').length;
    body.innerHTML = (o.constraints || []).map((c, i) => {
      const desc = typeof c === 'string' ? c : c.desc;
      const isBase = typeof c === 'object' && c.from === 'base';
      const userIdx = i - baseCount; // 自定义项在 userConstraints 中的索引
      return `<div class="kg-class"><div class="kg-class-head"><code>${i + 1}</code><span>${escapeHtml(desc)}</span>${isBase ? '<span class="kg-class-acts"><span class="mini-tag" style="opacity:.55">内置</span></span>' : acts({ custom: true, data: `data-idx="${userIdx}"` }, false)}</div></div>`;
    }).join('');
  } else if (state.kg.ontoTab === 'axioms') {
    const typeNames = { DisjointClasses: '不相交类', SubClassOf: '子类于', TransitiveProperty: '传递属性', SymmetricProperty: '对称属性', AsymmetricProperty: '非对称属性', InverseProperties: '互逆属性', PropertyDomain: '属性定义域', PropertyRange: '属性值域', FunctionalProperty: '函数属性', InverseFunctionalProperty: '反函数属性', ReflexiveProperty: '自反属性', IrreflexiveProperty: '反自反属性' };
    body.innerHTML = (o.axioms || []).length ? (o.axioms || []).map((a) => `<div class="kg-class"><div class="kg-class-head"><code class="axiom-type">${escapeHtml(typeNames[a.type] || a.type)}</code><b>${escapeHtml(a.subject || '')}${a.object ? ' ⇄ ' + escapeHtml(a.object) : ''}</b><span>${escapeHtml(a.desc || '')}</span><span class="kg-class-acts"><span class="mini-tag" style="opacity:.55">公理</span></span></div></div>`).join('') : '<div class="gd-desc">当前体系未定义逻辑公理。</div>';
  }
  renderOntoPrompts(o);
}

// ---------- 「推理」Tab（融合设计 §6.6）----------
function reasonValidationCounts(v) {
  return {
    violations: Number.isFinite(v && v.totalViolations) ? v.totalViolations : ((v && v.violations) || []).length,
    disjoint: Number.isFinite(v && v.totalDisjointConflicts) ? v.totalDisjointConflicts : ((v && v.disjointConflicts) || []).length,
  };
}

function reasonRunInfo(ctx) {
  const { rs, meta, ls } = ctx;
  if (rs.available === false) return { tone: 'danger', label: '不可用', detail: rs.unavailableReason || '推理模块不可用' };
  if (rs.enabled === false) return { tone: 'muted', label: '已关闭', detail: '可在设置中重新启用' };
  if (!ls) return { tone: 'info', label: '尚未运行', detail: '运行推理后生成推理边与冲突结果' };
  if (ls.skipped) return { tone: 'warn', label: '已跳过', detail: reasonSkipText(ls.skipReason) };
  if (meta.inferredStale) return { tone: 'warn', label: '结果已过期', detail: '图谱已变更，建议重新推理' };
  return {
    tone: 'ok',
    label: '已完成',
    detail: `${Number(ls.rounds) || 0} 轮 · ${((Number(ls.elapsedMs) || 0) / 1000).toFixed(1)}s · ${reasonTimeText(ls.at || meta.lastInferredAt)}`,
  };
}

function renderReasonMetric(label, value, detail, tone) {
  return `<article class="kg-health-metric is-${tone || 'info'}"><span>${escapeHtml(label)}</span><b>${escapeHtml(String(value))}</b><small>${escapeHtml(detail || '')}</small></article>`;
}

function renderReasonProfilePicker(profileId, profiles) {
  const list = Array.isArray(profiles) && profiles.length
    ? profiles
    : [{ id: profileId || 'bfo-lite', name: profileId || 'bfo-lite' }];
  const options = list.map((p) => `<option value="${escapeHtml(p.id)}"${p.id === profileId ? ' selected' : ''}>${escapeHtml(p.name || p.id)}</option>`).join('');
  return `<label class="kg-reason-profile-picker"><span>当前本体体系</span><select id="kg-reason-profile" title="切换后刷新本页本体诊断与体检；体检只校验该体系的边，不影响抽取和问答的自动体系选择">${options}</select><em>用于本体诊断与体检（体检仅校验该体系的边）</em></label>`;
}

function renderReasonValidationMetric(v) {
  if (v === undefined) return renderReasonMetric('图谱体检', '进行中', '正在检查全图约束与公理', 'info');
  if (!v || v.ok === false) return renderReasonMetric('图谱体检', '未完成', (v && v.error) || '体检失败，可重试', 'danger');
  const counts = reasonValidationCounts(v);
  const total = counts.violations + counts.disjoint;
  return total
    ? renderReasonMetric('图谱体检', `发现 ${total} 项`, `${counts.violations} 条越界边 · ${counts.disjoint} 处不相交归属`, 'warn')
    : renderReasonMetric('图谱体检', '健康', `已检查 ${Number(v.checked) || 0} 条边，未发现约束违规`, 'ok');
}

function renderReasonOverview(ctx) {
  const { rs, meta, ls, counts, profileId, profiles } = ctx;
  const run = reasonRunInfo(ctx);
  const coverage = rs.coverage || {};
  const pct = counts.total ? Math.round((counts.inferred / counts.total) * 100) : 0;
  const unavailable = rs.available === false;
  const notices = [
    unavailable ? `<div class="kg-reason-off">推理模块不可用：${escapeHtml(rs.unavailableReason || '未知原因')}。图谱浏览与只读体检不受影响。</div>` : '',
    !unavailable && rs.enabled === false ? '<div class="kg-reason-off">推理已在“设置”中关闭；可继续执行只读体检。</div>' : '',
    meta.inferredStale ? '<div class="kg-reason-stale">图谱已变更，当前推理结果可能过期。下次问答会自动重跑，也可立即手动重推。</div>' : '',
  ].join('');
  return `<section class="kg-reason-dashboard">
    <div class="kg-reason-dashboard-head">
      <div><div class="kg-reason-kicker">推理与校验</div><h3>图谱健康概览</h3><p>${renderReasonProfilePicker(profileId, profiles)}</p></div>
      <div class="kg-reason-action-groups"><span>更新结果</span><button class="btn btn-primary" id="btn-reason-run"${unavailable ? ' disabled title="推理模块不可用"' : ' title="对全图各体系重新执行物化推理"'}>重新推理</button><button class="btn btn-ghost" id="btn-reason-validate" title="只读体检当前选定体系的边（全部知识图谱），不改写数据；到整体图谱页可再限定单一知识图谱">刷新体检</button>${counts.inferred ? '<span class="kg-reason-action-sep"></span><span>维护推理层</span><button class="btn btn-ghost danger" id="btn-reason-clear" title="只清除推理得出的边，原始图谱不受影响">清除推理边</button>' : ''}</div>
    </div>
    ${notices}
    <div class="kg-health-grid">
      ${renderReasonMetric('推理状态', run.label, run.detail, run.tone)}
      ${renderReasonMetric('推理边', `${Number(counts.inferred) || 0} 条`, `全图 ${Number(counts.total) || 0} 条关系 · 占 ${pct}%`, counts.inferred ? 'info' : 'muted')}
      <div id="kg-reason-validation-metric">${renderReasonValidationMetric()}</div>
      ${renderReasonMetric('护栏覆盖', `${coverage.coveragePct == null ? '—' : coverage.coveragePct + '%'}`, coverage.predicates == null ? '当前体系未返回谓词覆盖信息' : `${coverage.withAny || 0}/${coverage.predicates || 0} 个谓词声明 domain/range`, coverage.coveragePct ? 'ok' : 'muted')}
    </div>
  </section>`;
}

function renderReasonIssues(ctx, v) {
  if (v === undefined) return '<div class="kg-issues-loading">正在汇总推理冲突与全图体检结果…</div>';
  if (!v || v.ok === false) return `<div class="kg-issues-error"><b>体检未完成</b><span>${escapeHtml((v && v.error) || '未知错误')}</span><button class="btn btn-ghost" id="btn-reason-validate-retry">重试体检</button></div>`;
  const { violations, disjoint } = reasonValidationCounts(v);
  const total = ctx.conTotal + violations + disjoint;
  if (!total) return '<div class="kg-issues-clean"><b>未发现待处理问题</b><span>推理未检出语义矛盾，体检也未发现越界边或不相交归属冲突。</span></div>';
  const conflict = ctx.conTotal ? `<article class="kg-issue-group is-danger"><div><span class="kg-issue-source">推理结果</span><b>不一致冲突 ${ctx.conTotal} 处</b><p>${ctx.det && (ctx.det.items || []).length ? '推理规则发现语义矛盾；可在明细中查看规则与涉及对象。' : '旧结果未保存明细；重新推理后可查看并定位具体冲突。'}</p></div></article>` : '';
  const checked = (violations || disjoint) ? `<article class="kg-issue-group is-warn"><div><span class="kg-issue-source">只读体检</span><b>约束问题 ${violations + disjoint} 项</b><p>${violations} 条 domain/range 或词表越界边；${disjoint} 处由约束推导出的不相交归属。</p></div></article>` : '';
  return `<div class="kg-issues-head"><div><div class="kg-reason-kicker">需要关注</div><h3>待处理问题（${total}）</h3><p>推理冲突来自全图结果；只读体检仅校验当前选定体系的边（整体图谱页可再限定知识图谱范围），以下保留来源以便判断处理方式。</p></div><div class="kg-issue-actions"><button class="btn btn-primary" id="btn-reason-fix-all" title="先重新执行全量体检并规划修复动作；预览确认后才会改图">一键规划修复</button><button class="btn btn-ghost" data-reason-show-details>查看明细</button>${ctx.rs.repairUndoAvailable ? '<button class="btn btn-ghost" id="btn-reason-repair-undo">撤销上次修复</button>' : ''}</div></div><div class="kg-issue-groups">${conflict}${checked}</div>`;
}

function renderReasonDiagnostics(ctx) {
  const { lg, guardHtml, featHtml, covHtml, viaHtml } = ctx;
  const guardTotal = Number((lg && lg.total) || 0);
  return `<section class="kg-reason-diagnostics"><div class="kg-reason-section-head"><div><div class="kg-reason-kicker">按需查看</div><h3>诊断详情</h3></div><p>体检明细、护栏记录和本体谓词特性。</p></div>
    <details class="kg-diagnostic" id="kg-diagnostic-validation"><summary><span>全图校验明细</span><em id="kg-validate-summary">体检中…</em></summary><div class="kg-diagnostic-body" id="kg-validate-body"><div class="kg-issues-loading">正在执行只读体检…</div></div></details>
    <details class="kg-diagnostic"${guardTotal ? ' open' : ''}><summary><span>护栏拦截日志</span><em>${guardTotal ? `${guardTotal} 条越界连线已降级` : '最近一次提取未发现越界连线'}</em></summary><div class="kg-diagnostic-body">${guardHtml}</div></details>
    <details class="kg-diagnostic"><summary><span>本体诊断</span><em>谓词特性与护栏覆盖</em></summary><div class="kg-diagnostic-body">${covHtml}${viaHtml ? `<div class="kg-reason-row"><span>推导方式</span><b class="kg-reason-vias">${viaHtml}</b></div>` : ''}${featHtml}</div></details>
  </section>`;
}

function updateReasonValidation(body, ctx, v) {
  if (!body || !document.contains(body) || body.dataset.reasonRenderId !== ctx.renderId) return;
  const metric = body.querySelector('#kg-reason-validation-metric');
  const issues = body.querySelector('#kg-reason-issues');
  const report = body.querySelector('#kg-validate-body');
  const summary = body.querySelector('#kg-validate-summary');
  if (metric) metric.innerHTML = renderReasonValidationMetric(v);
  if (issues) issues.innerHTML = renderReasonIssues(ctx, v);
  if (v === undefined) {
    if (report) report.innerHTML = '<div class="kg-issues-loading">正在执行只读体检…</div>';
    if (summary) summary.textContent = '体检中…';
    return;
  }
  if (report) {
    report.innerHTML = renderValidateReport(v, ctx.det);
    bindValidateFilters(report);
  }
  if (summary) {
    const counts = v && v.ok !== false ? reasonValidationCounts(v) : null;
    summary.textContent = counts ? (counts.violations + counts.disjoint ? `发现 ${counts.violations + counts.disjoint} 项` : '未发现约束违规') : '体检失败';
  }
  const detail = body.querySelector('#kg-diagnostic-validation');
  if (detail && v && v.ok !== false) {
    const counts = reasonValidationCounts(v);
    detail.open = ctx.conTotal + counts.violations + counts.disjoint > 0;
  }
  const badge = $('kg-reason-badge');
  if (badge && v && v.ok !== false) {
    const counts = reasonValidationCounts(v);
    const total = ctx.conTotal + counts.violations + counts.disjoint;
    if (total) { badge.hidden = false; badge.textContent = String(total); badge.className = 'kg-badge kg-badge-warn'; }
  }
  bindReasonIssueActions(body, ctx);
}

function bindReasonIssueActions(body, ctx) {
  const retry = body.querySelector('#btn-reason-validate-retry');
  if (retry) retry.addEventListener('click', () => ctx.refreshValidation());
  const show = body.querySelector('[data-reason-show-details]');
  if (show) show.addEventListener('click', () => { const detail = body.querySelector('#kg-diagnostic-validation'); if (detail) { detail.open = true; detail.scrollIntoView({ behavior: 'smooth', block: 'start' }); } });
  const fix = body.querySelector('#btn-reason-fix-all');
  if (fix) fix.addEventListener('click', () => fixAllIssues(fix));
  const undo = body.querySelector('#btn-reason-repair-undo');
  if (undo) undo.addEventListener('click', () => undoLastRepair());
}

async function refreshReasonValidation(body, ctx, opts) {
  const o = opts || {};
  const seq = (ctx.validationSeq || 0) + 1;
  ctx.validationSeq = seq;
  updateReasonValidation(body, ctx, undefined);
  const v = await runFullGraphValidate(ctx.profileId);
  if (ctx.validationSeq !== seq || !document.contains(body) || body.dataset.reasonRenderId !== ctx.renderId) return v;
  updateReasonValidation(body, ctx, v);
  if (o.showBar) showGraphValidateBar(v, ctx.profileId);
  return v;
}
// 数据源：IPC graph:reasonState → getReasonState(profileId)，一次拿齐四区块所需的全部字段。
// 注意 lastStats.inconsistencies 是「条数」，明细在 lastStats.inconsistencyDetails.items。
async function renderKgReasonTab(body, profileId) {
  if (!body) return;
  const renderId = `${Date.now()}-${Math.random()}`;
  // 先标记请求批次，避免快速切换体系后旧请求覆盖新页面。
  body.dataset.reasonRequestId = renderId;
  // 静默降级：桥接层没有这个绑定（旧版 preload / web shim 未同步）时如实说明，不抛错
  if (typeof window.kb.graphReasonState !== 'function') {
    body.innerHTML = '<div class="gd-desc">当前环境不支持推理状态查询（缺少 graphReasonState 桥接）。</div>';
    return;
  }
  let profiles = state.kg.graphProfiles || [];
  if (!profiles.length && typeof window.kb.graphProfiles === 'function') {
    try {
      profiles = (await window.kb.graphProfiles()) || [];
      state.kg.graphProfiles = profiles;
    } catch (_) { /* 保留当前体系作为唯一可选项 */ }
  }
  if (body.dataset.reasonRequestId !== renderId) return;
  const fallbackProfileId = profileId || (state.kg.onto && state.kg.onto.profileId) || 'bfo-lite';
  const requestedProfileId = state.kg.reasonProfileId || fallbackProfileId;
  const activeProfileId = profiles.some((p) => p.id === requestedProfileId)
    ? requestedProfileId
    : ((profiles[0] && profiles[0].id) || fallbackProfileId);
  state.kg.reasonProfileId = activeProfileId;
  let rs = null;
  try { rs = await window.kb.graphReasonState(activeProfileId); } catch (err) {
    if (body.dataset.reasonRequestId !== renderId) return;
    body.innerHTML = `<div class="gd-desc">推理状态读取失败：${escapeHtml(String((err && err.message) || err))}</div>`;
    return;
  }
  if (body.dataset.reasonRequestId !== renderId) return;
  if (!rs || rs.ok === false) {
    body.innerHTML = `<div class="gd-desc">推理状态读取失败：${escapeHtml((rs && rs.error) || '未知错误')}</div>`;
    return;
  }
  const meta = rs.meta || {};
  const ls = meta.lastStats || null;
  const lg = meta.lastGuard || null;
  const counts = rs.counts || { total: 0, inferred: 0, raw: 0, byVia: {} };
  const badge = $('kg-reason-badge');

  // 推理冲突与体检结果分别保留来源；体检返回后在“待处理问题”中汇总展示。
  const det = (ls && ls.inconsistencyDetails) || null;
  const conTotal = det ? (Number(det.total) || 0) : (Number(rs.lastInconsistencies) || 0);

  // ---- 区块 3：护栏拦截日志 ----
  let guardHtml;
  if (!lg || !lg.total) {
    guardHtml = '<div class="gd-desc">最近一次提取没有越界连线被拦截。</div>';
  } else {
    const byReason = Object.entries(lg.byReason || {}).map(([k, v]) => `<span class="mini-tag">${escapeHtml(guardReasonText(k))} × ${v}</span>`).join(' ');
    const entries = (lg.entries || []).map((en) => `
      <div class="kg-guard-item">
        <span class="kg-guard-rel">${escapeHtml(en.from || '?')} <b>—${escapeHtml(en.rel || '?')}→</b> ${escapeHtml(en.to || '?')}</span>
        <span class="kg-guard-why">${escapeHtml(guardReasonText(en.reason))}${en.detail ? `：${escapeHtml(en.detail)}` : ''}</span>
        ${en.downgradedTo ? `<span class="kg-guard-fix">已降级为「${escapeHtml(en.downgradedTo)}」</span>` : ''}
        ${en.taskNo ? `<span class="kg-guard-task">作业 #${en.taskNo}</span>` : ''}
      </div>`).join('');
    guardHtml = `<div class="kg-reason-row"><span>共拦截</span><b>${lg.total} 条越界连线</b></div>
      <div class="kg-guard-tags">${byReason}</div>
      <div class="kg-guard-list">${entries || '<div class="gd-desc">（明细已过期）</div>'}</div>
      ${lg.total > (lg.entries || []).length ? `<div class="gd-desc">（仅保留前 ${(lg.entries || []).length} 条明细）</div>` : ''}`;
  }

  // ---- 区块 4：谓词特性一览 ----
  const feats = rs.features || [];
  const cov = rs.coverage || null;
  // 取值来自 bridge.js:FEATURE_AXIOM_MAP / owlImport.js:388-394（7 项，注意 inverseFunctional 是驼峰）
  const FEAT_NAMES = { transitive: '传递', symmetric: '对称', asymmetric: '非对称', functional: '函数', inverseFunctional: '反函数', irreflexive: '反自反', reflexive: '自反' };
  let featHtml;
  if (!feats.length) {
    featHtml = `<div class="gd-desc">当前体系未声明任何谓词特性${cov ? `（${cov.predicates} 个谓词均无 domain/range/特性公理）` : ''}，因此不会产生推理边，护栏也不拦截。</div>`;
  } else {
    // 按特性归类：传递/对称/函数 三行速览 + 逐谓词明细表
    const byFeat = {};
    feats.forEach((f) => (f.features || []).forEach((ft) => { (byFeat[ft] = byFeat[ft] || []).push(f.label || f.key); }));
    const summary = Object.entries(byFeat).map(([ft, list]) =>
      `<div class="kg-reason-row"><span>${escapeHtml(FEAT_NAMES[ft] || ft)}</span><b>${list.map(escapeHtml).join(' / ')}</b></div>`).join('');
    const rows = feats.map((f) => {
      const tags = (f.features || []).map((ft) => `<span class="mini-tag kg-feat-${escapeHtml(ft)}">${escapeHtml(FEAT_NAMES[ft] || ft)}</span>`).join(' ');
      const inv = (f.inverseOf || []).length ? `互逆：${f.inverseOf.map(escapeHtml).join('/')}` : '';
      const dr = (f.domainLabels || []).length || (f.rangeLabels || []).length
        ? `domain ${(f.domainLabels || []).map(escapeHtml).join('/') || '—'} · range ${(f.rangeLabels || []).map(escapeHtml).join('/') || '—'}`
        : '';
      return `<div class="kg-class"><div class="kg-class-head"><code>${escapeHtml(f.key)}</code><b>${escapeHtml(f.label || f.key)}</b><span class="kg-class-acts">${tags}</span></div>${inv || dr ? `<div class="kg-class-ex">${inv}${inv && dr ? ' · ' : ''}${dr}</div>` : ''}</div>`;
    }).join('');
    featHtml = summary + `<div class="kg-feat-list">${rows}</div>`;
  }
  const covHtml = cov
    ? `<div class="kg-reason-row"><span>护栏覆盖</span><b>${cov.coveragePct}%（${cov.withAny}/${cov.predicates} 个谓词声明了 domain/range）</b></div>`
    : '';
  // 推理边按推导方式分布（countInferred.byVia）：解释「这些边是怎么推出来的」
  const viaHtml = Object.entries(counts.byVia || {}).map(([k, v]) =>
    `<span class="mini-tag" title="${escapeHtml(inferredViaName(k))}">${escapeHtml(inferredViaName(k) || k)} × ${v}</span>`).join(' ');

  const reasonCtx = {
    rs, meta, ls, lg, counts, det, conTotal, profileId: activeProfileId, profiles,
    guardHtml, featHtml, covHtml, viaHtml,
    renderId,
    validationSeq: 0,
  };
  body.dataset.reasonRenderId = reasonCtx.renderId;
  body.innerHTML = `${renderReasonOverview(reasonCtx)}
    <section class="kg-reason-issues-section"><div id="kg-reason-issues">${renderReasonIssues(reasonCtx, undefined)}</div></section>
    ${renderReasonDiagnostics(reasonCtx)}`;

  // 徽标：冲突数优先（红色告警），否则显示推理边数
  if (badge) {
    if (conTotal) { badge.hidden = false; badge.textContent = String(conTotal); badge.className = 'kg-badge kg-badge-warn'; }
    else if (counts.inferred) { badge.hidden = false; badge.textContent = String(counts.inferred); badge.className = 'kg-badge'; }
    else { badge.hidden = true; badge.textContent = ''; }
  }

  const profileSelect = $('kg-reason-profile');
  if (profileSelect) profileSelect.addEventListener('change', () => {
    state.kg.reasonProfileId = profileSelect.value;
    renderKgReasonTab(body, profileSelect.value);
  });
  const runBtn = $('btn-reason-run');
  if (runBtn) runBtn.addEventListener('click', async () => {
    await runGraphInference();
    renderKgOntology();
    if (state.kg.tab === 'reason') renderKgReasonTab($('kg-reason-body'), reasonCtx.profileId);
  });
  const clearBtn = $('btn-reason-clear');
  if (clearBtn) clearBtn.addEventListener('click', async () => {
    await clearAllInferredEdges();
    renderKgOntology();
    if (state.kg.tab === 'reason') renderKgReasonTab($('kg-reason-body'), reasonCtx.profileId);
  });
  reasonCtx.refreshValidation = (opts) => refreshReasonValidation(body, reasonCtx, opts);
  const valBtn = $('btn-reason-validate');
  if (valBtn) valBtn.addEventListener('click', async () => {
    valBtn.disabled = true;
    try { await reasonCtx.refreshValidation({ showBar: true }); } finally { valBtn.disabled = false; }
  });
  // 打开页面即执行一次只读体检；结果只更新仍处于当前渲染批次的页面。
  reasonCtx.refreshValidation();
}

// ---- 冲突自动修复 UI（方案2/3）----
// 流程：planRepairs（dry-run，不改数据）→ 模态预览动作清单（可勾选子集）
//   → 提交「图谱冲突修复」作业（每个动作一条子任务，主进程逐条施加+落库，
//     施加前存撤销快照，完成后自动重推理验证）→ 作业完成回调刷新图谱/推理页。
// 「撤销上次修复」恢复快照整图（一步撤销，只保留最近一次）。

async function planAndPreviewRepairs(opts) {
  const btn = $('btn-reason-repair');
  if (btn) btn.disabled = true;
  try {
    // 「一键修复」默认 refresh:true：先重跑一轮推理拿最新冲突明细再规划。
    // 原因有二：① 落库的明细可能是旧版本留下的（缺 nodeIds/raw，无法定位边）；
    //          ② 图谱可能在上次推理后被改过，按陈旧明细规划会指向已不存在的边。
    // 单条冲突的「修复」按钮仍走 conflictIdxs（下标必须与落库明细对齐，不能 refresh）。
    const o = opts || {};
    if (o.refresh) toast('正在重推理并规划修复动作…');
    // 问题汇总表行级「修复」：按体检报告的问题条目规划（不重推理、不按冲突明细）
    const plan = o.issues ? await window.kb.graphPlanRepairsForIssues(o.issues) : await window.kb.graphPlanRepairs(o);
    if (!plan || plan.ok === false) {
      toast('修复规划失败：' + ((plan && plan.error) || '未知错误'));
      return;
    }
    if (!(plan.actions || []).length) {
      toast(plan.hint || '没有可规划的修复动作', 4000);
      return;
    }
    showRepairPreviewModal(plan);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function showRepairPreviewModal(plan) {
  const old = document.getElementById('repair-preview-modal');
  if (old) old.remove();
  const overlay = document.createElement('div');
  // 必须用应用统一的 .modal-mask（fixed 全屏遮罩 + 居中，styles.css :835）；
  // 此前误用无任何 CSS 规则的 'modal-overlay'，弹窗被 append 到 body 后不可见，表现为「修复点不动」
  overlay.className = 'modal-mask';
  overlay.id = 'repair-preview-modal';
  const acts = plan.actions || [];
  const autoN = acts.filter((a) => a.kind !== 'manual').length;
  const rows = acts.map((a, i) => {
    const auto = a.kind !== 'manual';
    const box = auto ? `<input type="checkbox" class="repair-act-chk" data-i="${i}" checked />` : '<span class="mini-tag">需人工</span>';
    const kindZh = { 'change-rel': '降级谓词', 'delete-edge': '删除边', 'delete-edges': '删除边', 'retype-node': '改节点类型', 'manual': '人工处理' }[a.kind] || a.kind;
    return `<label class="kg-guard-item repair-act-row${auto ? '' : ' repair-act-manual'}">
      ${box}
      <span class="kg-guard-rel"><span class="mini-tag">${escapeHtml(kindZh)}</span> ${escapeHtml(a.actionZh || '')}${a.viaLlm ? ' <span class="mini-tag" title="由 LLM 语义仲裁选定">LLM</span>' : ''}</span>
      ${a.altActionZh ? `<span class="kg-guard-why">备选：${escapeHtml(a.altActionZh)}</span>` : ''}
    </label>`;
  }).join('');
  // 全部动作都需人工时给出显式提示：否则用户只看到按钮置灰却不知原因，
  // 表现为「提交修复作业点击不生效」
  const manualOnly = autoN === 0 && acts.length > 0;
  const manualNote = manualOnly
    ? `<div class="gd-desc" style="color:var(--danger);background:rgba(217,72,64,.08);border-radius:6px;padding:8px 10px;">本次规划<b>没有可自动执行的动作</b>：剩余冲突属于「需人工」类型（例如节点声明类型本身落入互斥类、且没有边在强制它），改数据无法消除，只能在本体定义/图谱中人工调整节点类型或放宽公理。因此「提交修复作业」保持置灰。</div>`
    : '';
  overlay.innerHTML = `<div class="modal owl-preview-modal">
    <div class="modal-head"><b>修复预览（${plan.conflictCount || 0} 处冲突 → ${acts.length} 个动作）</b><button class="icon-btn" id="repair-preview-x" title="关闭">${icoSvg('close', 12)}</button></div>
    <div class="modal-body"><div class="kg-guard-list">${rows}</div>${manualNote}
      <div class="gd-desc">修复遵循最小破坏原则：优先把越界边降级为「相关」，其次删边，最后才改节点类型；「需人工」项无安全自动方案，不会改图。${plan.llmArbitrate ? '本次规划启用了 LLM 语义仲裁（设置 → 知识图谱可关闭）。' : ''}确认后作为一条<b>修复作业</b>执行（每个动作一条子任务，可在「作业管理」跟踪/停止），施加前自动保存撤销快照，完成后自动重推理验证。</div></div>
    <div class="modal-foot">
      <span class="form-hint">${autoN ? `已选 ${autoN} 个自动动作` : '已选 0 个自动动作（无可自动执行项时按钮置灰）'}</span>
      <button class="btn btn-ghost" id="repair-preview-cancel">取消</button>
      <button class="btn btn-primary" id="repair-preview-ok"${autoN ? '' : ' disabled'}>提交修复作业</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  $('repair-preview-x').addEventListener('click', close);
  $('repair-preview-cancel').addEventListener('click', close);
  // 勾选数联动「提交修复作业」可用态；全为「需人工」时说明置灰原因
  const syncCount = () => {
    const n = overlay.querySelectorAll('.repair-act-chk:checked').length;
    overlay.querySelector('.modal-foot .form-hint').textContent = n
      ? `已选 ${n} 个自动动作`
      : '已选 0 个自动动作（无可自动执行项时按钮置灰）';
    $('repair-preview-ok').disabled = !n;
  };
  overlay.querySelectorAll('.repair-act-chk').forEach((c) => c.addEventListener('change', syncCount));
  $('repair-preview-ok').addEventListener('click', async () => {
    const picked = [...overlay.querySelectorAll('.repair-act-chk:checked')].map((c) => acts[Number(c.dataset.i)]).filter(Boolean);
    close();
    if (!picked.length) return;
    // 修复作为一条作业执行（每个动作一条子任务）：可在「作业管理」跟踪进度、停止、
    // 失败单条重跑；完成后由 handleJobsUpdate 自动刷新图谱与推理页
    const res = await window.kb.jobsSubmit({
      type: 'graph-repair',
      payload: { settings: state.settings, actions: picked, conflictCount: plan.conflictCount || 0 },
    });
    if (!res || !res.ok) {
      toast('提交修复作业失败：' + ((res && res.error) || '未知错误'), 4000);
      return;
    }
    toast(`已提交修复作业（${picked.length} 个动作），可在「作业管理」查看进度`, 4000);
    showJobsView();
  });
}

async function undoLastRepair() {
  const btn = $('btn-reason-repair-undo');
  if (btn) btn.disabled = true;
  try {
    toast('正在撤销上次修复…');
    const r = await window.kb.graphUndoRepair({});
    if (!r || r.ok === false) {
      toast('撤销失败：' + ((r && r.error) || '没有可撤销的修复记录'));
      return;
    }
    const rr = r.rerun || {};
    toast(`已恢复到修复前（${r.nodes} 节点 / ${r.edges} 边）${rr.skipped ? '' : `，剩余冲突 ${rr.inconsistencies != null ? rr.inconsistencies : '?'}`}`, 4000);
    renderKgOntology();
    if (state.kg.tab === 'reason') renderKgReasonTab($('kg-reason-body'), state.kg.onto && state.kg.onto.profileId);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// 通道 C 体检报告 → HTML（复用既有 .kg-reason-row / .kg-conflict / .kg-guard-item 样式，不新增 CSS）
// det = 推理「不一致冲突」明细（ls.inconsistencyDetails），可选；传入则合并进同一张问题表
function renderValidateReport(v, det) {
  // 报告仅负责诊断明细；概览和待处理问题由上层独立呈现。
  lastValidateReport = v || null;
  lastConflictDetails = det || null;
  if (!v || v.ok === false) {
    return `<div class="kg-issues-error"><b>全图体检不可用</b><span>${escapeHtml((v && v.error) || '未知错误')}（图谱数据不受影响）</span></div>`;
  }
  // 计数用全量 totals（按 reason 累加、不受明细上限 VIOLATION_CAP=50 影响）。
  const { violations: nV, disjoint: nD } = reasonValidationCounts(v);
  const shownV = (v.violations || []).length;
  const shownD = (v.disjointConflicts || []).length;
  // 越界边 + 不相交归属 + 推理不一致冲突汇成同一张表，保留来源列与筛选能力。
  const valRows = validateIssueRows(v);
  const conRows = conflictIssueRows(det);
  // 统一重编号（冲突行排在越界/不相交行之前，与「先看推理矛盾、再看体检问题」的阅读顺序一致）
  const rows = conRows.concat(valRows);
  rows.forEach((r, i) => { r.idx = i; });
  const scopes = [...new Set(rows.map((r) => r.scope))];
  const nViolationRows = rows.filter((r) => r.kind === 'violation').length;
  const nConflictRows = rows.filter((r) => r.kind === 'conflict').length;
  const nInconRows = rows.filter((r) => r.kind === 'inconsistency').length;
  const kindOpts = [
    nInconRows ? `<option value="inconsistency">不一致冲突（${nInconRows}）</option>` : '',
    nViolationRows ? `<option value="violation">越界边（${nViolationRows}）</option>` : '',
    nConflictRows ? `<option value="conflict">不相交归属（${nConflictRows}）</option>` : '',
  ].join('');
  const tableHtml = rows.length
    ? `<div class="kg-vr-filters">
        <label>知识图谱 <select id="kg-vr-scope"><option value="">全部（${rows.length}）</option>${scopes.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}（${rows.filter((r) => r.scope === s).length}）</option>`).join('')}</select></label>
        <label>问题类型 <select id="kg-vr-kind"><option value="">全部</option>${kindOpts}</select></label>
        <span class="form-hint">${v.truncated ? `明细最多列 ${shownV} 条越界边 / ${shownD} 条不相交；计数为全量` : '问题已全部列出'}</span>
      </div>
      <div class="kg-vr-wrap"><table class="kg-vr-table">
        <thead><tr><th>#</th><th>问题类型</th><th>违规边 / 节点</th><th>违反的约束或公理</th><th>所属体系</th><th>知识图谱</th><th>操作</th></tr></thead>
        <tbody id="kg-vr-tbody">${validateRowsHtml(rows, '', '')}</tbody>
      </table></div>`
    : '<div class="gd-desc">所有边均通过谓词白名单与 domain/range 检查，且未检出不相交归属冲突（覆盖率为 0% 的体系越界项恒通过，属预期）。</div>';
  const totalShown = nInconRows + nV + nD;
  const resultText = totalShown ? `共发现 ${totalShown} 项问题` : '未发现约束违规';
  return `<div class="kg-validate-report-head"><span>体检体系「${escapeHtml(v.profileName || v.profileId)}」· 仅校验选定体系与知识图谱范围内的边</span><b class="${totalShown ? 'kg-reason-warn' : 'kg-reason-ok'}">${resultText}</b><span>检查 ${Number(v.checked) || 0} 条边</span></div>
    ${tableHtml}
    <div class="gd-desc">体检为只读：不改写任何边、不删除数据；修复动作需先预览并确认。校验时间 ${escapeHtml(reasonTimeText(v.at))}。</div>`;
}

// v1.2.2 问题汇总表：把「越界边」与「不相交归属」两类问题归一成同构行数据，
// 每行带 问题类型 / 违规对象 / 违反的约束或公理 / 所属体系 / 知识图谱 五要素。
let lastValidateReport = null;
let lastConflictDetails = null;
// 推理「不一致冲突」明细 → 同构行（kind=inconsistency），与 validateIssueRows 输出同形，合并进同一张表
function conflictIssueRows(det) {
  const items = (det && det.items) || [];
  return items.map((c, ci) => {
    const scopeText = (c.scopes && c.scopes.length) ? c.scopes.map((s) => s.label || s.domain || '通用').join('、') : '';
    return {
      idx: ci, // 之后会统一重编号；cidx 保留原始下标供修复
      cidx: ci,
      kind: 'inconsistency',
      kindZh: '不一致冲突',
      object: (c.nodeNames && c.nodeNames.length) ? c.nodeNames.join('、') : (c.message || c.rule || '（冲突）'),
      inferred: true,
      constraint: c.messageZh || c.message || '（无描述）',
      detail: c.reasonZh || '',
      profile: c.profileName || c.profileId || '',
      scope: scopeText || '通用（未匹配领域）',
    };
  });
}
function validateIssueRows(v) {
  const rows = [];
  const profFallback = (v && (v.profileName || v.profileId)) || '';
  for (const en of ((v && v.violations) || [])) {
    rows.push({
      idx: rows.length,
      src: en, // 原始问题条目：行级「修复」按钮回传给 planRepairsForIssues
      kind: 'violation',
      kindZh: guardReasonText(en.reason),
      reason: en.reason || '',
      object: `${en.from || '?'} —${en.rel || '?'}→ ${en.to || '?'}`,
      inferred: !!en.inferred,
      constraint: validateConstraintText(en),
      profile: en.profileName || en.profileId || profFallback,
      scope: en.scopeLabel || validateScopeFallback(en.domain),
      detail: en.detail || '',
    });
  }
  for (const c of ((v && v.disjointConflicts) || [])) {
    rows.push({
      idx: rows.length,
      src: c,
      kind: 'conflict',
      kindZh: '不相交归属冲突',
      object: `${c.node || '?'}（声明类型 ${c.declaredType || '?'}）`,
      inferred: false,
      constraint: `DisjointClasses(${c.declaredType || '?'}, ${c.forcedType || '?'}) · 边 —${c.rel || '?'}→ 的${c.via === 'domain' ? '定义域' : '值域'}强制`,
      profile: c.profileName || c.profileId || profFallback,
      scope: c.scopeLabel || validateScopeFallback(c.domain),
      detail: c.detail || '',
    });
  }
  return rows;
}

// 违反的约束或公理 → 可读文案（与 guard.checkEdge 的 4 种 reason 对应）
function validateConstraintText(en) {
  const exp = Array.isArray(en.expected) && en.expected.length ? en.expected.join('/') : '';
  switch (en.reason) {
    case 'unknown-predicate': return `谓词白名单：「${en.rel || '?'}」不在体系受控词表中`;
    case 'domain-violation': return `domain 约束：起点类型应为 ${exp || '?'}${en.actual ? `（实际 ${en.actual}）` : ''}`;
    case 'range-violation': return `range 约束：终点类型应为 ${exp || '?'}${en.actual ? `（实际 ${en.actual}）` : ''}`;
    case 'unknown-type': return `类型白名单：端点类型须在体系类表中`;
    default: return guardReasonText(en.reason);
  }
}

// reason/ 纯版本回退标签（无模版名时）；graph.js 包装层通常已覆写为模版名
function validateScopeFallback(domain) {
  const d = (domain && String(domain).trim()) || 'general';
  return d === 'general' ? '通用（未匹配领域）' : d;
}

// 行 HTML：scope/kind 为空串表示不过滤
function validateRowsHtml(rows, scope, kind) {
  const list = rows.filter((r) => (!scope || r.scope === scope) && (!kind || r.kind === kind));
  if (!list.length) return '<tr><td colspan="7"><span class="kg-vr-sub">当前筛选条件下没有问题。</span></td></tr>';
  return list.map((r) => {
    // detail 子行：仅当它比约束文案提供更多信息时才显示。
    // unknown-predicate 的约束文案（谓词白名单：「X」不在体系受控词表中）与 detail（谓词「X」不在体系受控词表中）同源，
    // 直接抑制；其余 reason 用 includes 去重（domain/range 的 detail 补充节点名、unknown-type 补充起点/终点方位，保留）。
    const suppress = !r.detail || r.reason === 'unknown-predicate' || r.constraint.includes(r.detail);
    const sub = suppress ? '' : `<span class="kg-vr-sub">${escapeHtml(r.detail)}</span>`;
    const kindCls = r.kind === 'inconsistency' ? 'kg-vr-conflict' : (r.kind === 'conflict' ? 'kg-vr-conflict' : 'kg-vr-violation');
    // 操作列：不一致冲突走 graphPlanRepairs({conflictIdxs})；越界/不相交走 graphPlanRepairsForIssues([src])
    const fixBtn = r.kind === 'inconsistency'
      ? `<button class="btn btn-ghost kg-vr-fix-conflict" data-cidx="${r.cidx}" title="规划并预览该冲突的修复动作（先预览、确认后才改图）">修复</button>`
      : `<button class="btn btn-ghost kg-vr-fix" data-ri="${r.idx}" title="仅针对这一行规划修复动作：预览确认后才改图">修复</button>`;
    return `
    <tr>
      <td>${r.idx + 1}</td>
      <td class="kg-vr-kind"><span class="mini-tag ${kindCls}">${escapeHtml(r.kindZh)}</span>${r.inferred ? ' <span class="mini-tag">推理边</span>' : ''}</td>
      <td class="kg-vr-obj">${escapeHtml(r.object)}</td>
      <td>${escapeHtml(r.constraint)}${sub}</td>
      <td>${escapeHtml(r.profile || '—')}</td>
      <td>${escapeHtml(r.scope || '—')}</td>
      <td>${fixBtn}</td>
    </tr>`;
  }).join('');
}

// 合并行：校验行（越界/不相交）+ 推理冲突行（inconsistency），与 renderValidateReport 内部口径一致
function mergedIssueRows() {
  const valRows = lastValidateReport ? validateIssueRows(lastValidateReport) : [];
  const conRows = conflictIssueRows(lastConflictDetails);
  const rows = conRows.concat(valRows);
  rows.forEach((r, i) => { r.idx = i; });
  return rows;
}

// 筛选下拉 → 重渲染 tbody（数据取最近一次报告+冲突明细，客户端过滤不重跑校验）；
// 行级「修复」按钮用事件委托绑在 box 上（box 跨渲染复用，只绑一次，靠 dataset 标记防重复）
function bindValidateFilters(box) {
  if (!box) return;
  const scopeSel = box.querySelector('#kg-vr-scope');
  const kindSel = box.querySelector('#kg-vr-kind');
  const tbody = box.querySelector('#kg-vr-tbody');
  if (!scopeSel || !kindSel || !tbody) return;
  const rows = mergedIssueRows();
  const apply = () => { tbody.innerHTML = validateRowsHtml(rows, scopeSel.value, kindSel.value); };
  scopeSel.addEventListener('change', apply);
  kindSel.addEventListener('change', apply);
  if (box.dataset.vrBound) return;
  box.dataset.vrBound = '1';
  box.addEventListener('click', (e) => {
    // 一键修复所有：重跑一次 full 校验拿全量明细（默认封顶 50，修复必须覆盖全部），
    // 与当前推理冲突明细合并后批量规划，仍走同一个「预览→确认→作业」流程
    const fa = e.target.closest ? e.target.closest('#kg-vr-fix-all') : null;
    if (fa && box.contains(fa)) {
      e.preventDefault();
      fixAllIssues(fa);
      return;
    }
    // 越界/不相交行：data-ri 定位该行原始问题条目
    const b = e.target.closest ? e.target.closest('.kg-vr-fix') : null;
    if (b && box.contains(b)) {
      const all = mergedIssueRows();
      const row = all[Number(b.dataset.ri)];
      if (!row || !row.src) return;
      // 行级修复：只把这一行的原始问题条目送去规划（dry-run 预览后才落库）
      planAndPreviewRepairs({ issues: [row.src] });
      return;
    }
    // 不一致冲突行：data-cidx 走 graphPlanRepairs({conflictIdxs})
    const cb = e.target.closest ? e.target.closest('.kg-vr-fix-conflict') : null;
    if (cb && box.contains(cb)) {
      planAndPreviewRepairs({ conflictIdxs: [Number(cb.dataset.cidx)] });
    }
  });
}

// 一键修复所有：全量校验 + 推理冲突 → 两路规划 → 合并去重 → 一次预览一次提交。
// 校验明细默认封顶 VIOLATION_CAP=50，修复必须拿全量（否则只修前 50 条），
// 故点击时重跑一次 graphValidate(profileId, {full:true}) 而非复用 lastValidateReport。
async function fixAllIssues(btn) {
  if (btn) btn.disabled = true;
  try {
    const profileId = (lastValidateReport && lastValidateReport.profileId) || (state.kg.onto && state.kg.onto.profileId) || '';
    toast('正在全量体检并规划修复动作…');
    const vFull = await runFullGraphValidate(profileId, { full: true });
    if (!vFull || vFull.ok === false) {
      toast('全量体检失败：' + ((vFull && vFull.error) || '未知错误'));
      return;
    }
    const issues = [];
    for (const en of (vFull.violations || [])) issues.push(en);
    for (const c of (vFull.disjointConflicts || [])) issues.push(c);
    const conflictItems = (lastConflictDetails && lastConflictDetails.items) || [];
    const conflictIdxs = conflictItems.map((_, i) => i);
    if (!issues.length && !conflictIdxs.length) {
      toast('当前没有可修复的问题');
      return;
    }
    // 两路独立规划（复用已验证入口）：冲突走 conflictIdxs，校验问题走 issues
    const plans = [];
    if (conflictIdxs.length) {
      const p = await window.kb.graphPlanRepairs({ conflictIdxs });
      if (p && p.ok !== false && (p.actions || []).length) plans.push(p);
    }
    if (issues.length) {
      const p = await window.kb.graphPlanRepairsForIssues(issues);
      if (p && p.ok !== false && (p.actions || []).length) plans.push(p);
    }
    const merged = mergeRepairPlans(plans);
    if (!merged.actions.length) {
      toast('没有可规划的修复动作（可能都是手动项或体系无法解析）', 4000);
      return;
    }
    showRepairPreviewModal(merged);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// 合并多个修复 plan：动作跨源去重（同一 edgeKey+kind 只留一条，与主进程 planRepairs 口径一致），
// 汇总 byKind/autoCount/manualCount，供同一个预览模态一次展示、一次提交。
function mergeRepairPlans(plans) {
  const seen = new Set();
  const actions = [];
  for (const p of plans) {
    for (const a of ((p && p.actions) || [])) {
      let sig;
      if (a.kind === 'manual') {
        sig = `manual\u0001${a.rule || ''}\u0001${a.actionZh || ''}`;
      } else if (a.rule === 'prp-asyp' && a.kind === 'delete-edge') {
        sig = `prp-asyp\u0001${[a.from, a.to].sort().join('\u0002')}\u0001${a.rel || ''}`;
      } else {
        sig = `${a.kind}\u0001${a.edgeKey || ''}\u0001${a.nodeId || ''}\u0001${a.newRel || a.newType || ''}`;
      }
      if (seen.has(sig)) continue;
      seen.add(sig);
      actions.push(a);
    }
  }
  const byKind = {};
  for (const a of actions) byKind[a.kind] = (byKind[a.kind] || 0) + 1;
  return {
    ok: true,
    actions,
    byKind,
    autoCount: actions.filter((a) => a.auto && a.kind !== 'manual').length,
    manualCount: actions.filter((a) => !a.auto || a.kind === 'manual').length,
    conflictCount: actions.length,
    llmArbitrate: plans.some((p) => p && p.llmArbitrate),
    at: Date.now(),
  };
}

// 时间戳 → 文本：0/缺失时不能走 formatDate（会渲染成 1970-01-01），如实说「未记录」
function reasonTimeText(ts) {
  const n = Number(ts) || 0;
  return n > 0 ? formatDate(n) : '（未记录时间）';
}

// 推理跳过原因 → 中文。取值来自 graph.js:SKIP_REASON_TEXT（7 项）+ graph.js 顶层
// 追加的 'disabled' / 'unknown-profile' / 'exception'（infer.js 不产这三项）。
// 前端独立一份而非跨进程引用：renderer 不能 require 主进程模块。
function reasonSkipText(code) {
  const M = {
    'reasoner-unavailable': 'protege-js 不可用，无法本地推理',
    'empty-graph': '图谱为空，无内容可推理',
    'bridge-failed': '图谱桥接为三元组失败',
    'no-rule-fuel': '该体系没有传递/对称/互逆/domain/range/类层级声明，推理不会产生新边',
    aborted: '已被用户中止',
    'materialize-failed': '物化过程出错',
    timeout: '推理超时（已保留原始图谱，可在设置中调大超时）',
    disabled: '推理功能已在设置中关闭',
    'unknown-profile': '体系无法解析',
    exception: '推理过程异常',
  };
  return M[code] || code || '未知原因';
}

// 护栏拦截原因 → 中文。前 4 种来自 guard.js:checkEdge 的 verdict.reason；
// 第 5 种 disjoint-type-forcing 来自 graph.js:extractGraph 的写侧互斥预检（冲突自动处理方案1）。
function guardReasonText(code) {
  const M = {
    'unknown-predicate': '未知谓词',
    'domain-violation': 'domain 越界',
    'range-violation': 'range 越界',
    'unknown-type': '端点类型不在体系类表中',
    // 写侧互斥护栏（冲突自动处理方案1）：抽取时 domain/range 会把端点强制归入与其声明类型互斥的类 → 降级为「相关」
    'disjoint-type-forcing': '互斥类型强制',
  };
  return M[code] || code || '越界';
}

// ---------- §6.9 OWL 导入预览弹窗 ----------
// 导入前让用户看清「这个本体能不能跑推理、有多少内容、有什么坑」——避免盲导入后
// 才发现推理跑不动或类树乱掉。数据来源是 graphPreviewOwl → previewOwlImport 的
// { profile, report, profileCheck, preview, via }（preview 内含 counts/warnings/notes/sampleClasses）。
function showOwlPreviewModal(pv, { onConfirm, onCancel } = {}) {
  const old = document.getElementById('owl-preview-modal');
  if (old) old.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-mask'; // 同 repair-preview：统一用有样式的 .modal-mask
  overlay.id = 'owl-preview-modal';
  overlay.innerHTML = `<div class="modal owl-preview-modal">
    <div class="modal-head"><b>OWL 导入预览</b><button class="icon-btn" id="owl-preview-x" title="取消导入">${icoSvg('close', 12)}</button></div>
    <div class="modal-body" id="owl-preview-body"><div class="gd-desc">解析中…</div></div>
    <div class="modal-foot">
      <span class="form-hint" id="owl-preview-via"></span>
      <button class="btn btn-ghost" id="owl-preview-cancel">取消</button>
      <button class="btn btn-primary" id="owl-preview-ok">确认导入</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const close = (fn) => { overlay.remove(); if (fn) fn(); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(onCancel); });
  $('owl-preview-x').addEventListener('click', () => close(onCancel));
  $('owl-preview-cancel').addEventListener('click', () => close(onCancel));
  $('owl-preview-ok').addEventListener('click', () => close(onConfirm));

  if (!pv || pv.ok === false) {
    $('owl-preview-body').innerHTML = `<div class="gd-desc">预览解析失败：${escapeHtml((pv && pv.error) || '未知错误')}。仍可尝试确认导入（导入端会再解析一次）。</div>`;
    return;
  }
  const rep = pv.report || {};
  const prv = pv.preview || {};
  const pc = pv.profileCheck || prv.profileCheck || null;
  const cnt = prv.counts || {};
  const viaText = pv.via === 'protege-js' ? 'protege-js 解析' : '内置正则解析（owl.js，无子语言判定）';
  $('owl-preview-via').textContent = viaText;

  // Profile 判定（仅 protege-js 路径有；owl.js 兜底路径 profileCheck 为 null）
  const profRow = (ok, label, extra) =>
    `<div class="owl-prof-row ${ok ? 'owl-prof-ok' : 'owl-prof-bad'}">${ok ? '✅' : '❌'} ${escapeHtml(label)}${extra ? `<em>${escapeHtml(extra)}</em>` : ''}</div>`;
  let profHtml;
  if (pc) {
    profHtml =
      profRow(pc.rl && pc.rl.ok, 'OWL 2 RL（可本地推理）', pc.rl && pc.rl.ok ? '' : `${(pc.rl && pc.rl.total) || 0} 处违规`) +
      profRow(pc.ql && pc.ql.ok, 'OWL 2 QL', pc.ql && pc.ql.ok ? '' : `${(pc.ql && pc.ql.total) || 0} 处违规`) +
      profRow(pc.el && pc.el.ok, 'OWL 2 EL', pc.el && pc.el.ok ? '' : `${(pc.el && pc.el.total) || 0} 处违规`) +
      (pc.recommend ? `<div class="gd-desc">推荐使用子语言：<b>${escapeHtml(pc.recommend)}</b></div>` : '');
  } else {
    profHtml = '<div class="gd-desc">当前解析路径无法判定 OWL 2 子语言（不影响导入与推理）。</div>';
  }

  // 类树预览：复用 ontologyTree 的布局；只有根+样本类（≤12），不是全量树
  const treeClasses = (prv.sampleClasses && prv.sampleClasses.length)
    ? prv.sampleClasses
    : ((prv.rootClasses || []).map((c) => ({ key: c.key, label: c.label })));
  const treeOnto = { classes: treeClasses.map((c) => ({ key: c.key, label: c.label, parent: c.parent || null })) };
  const warnHtml = (prv.warnings && prv.warnings.length)
    ? `<div class="owl-warn-list">${prv.warnings.map((w) => `<div class="owl-warn-item">⚠ ${escapeHtml(w)}</div>`).join('')}</div>`
    : '<div class="gd-desc">未发现导入风险。</div>';
  const noteHtml = (prv.notes && prv.notes.length)
    ? prv.notes.map((n) => `<div class="gd-desc">· ${escapeHtml(n)}</div>`).join('') : '';

  $('owl-preview-body').innerHTML = `
    <div class="owl-pv-row"><span>文件</span><b title="${escapeHtml(rep.sourceFile || '')}">${escapeHtml(prv.fileName || rep.sourceFile || '（未知）')}</b></div>
    <div class="owl-pv-row"><span>检测到格式</span><b>${escapeHtml(rep.format || prv.format || '未知')}${prv.ontologyIri ? ` · <code class="owl-pv-iri">${escapeHtml(prv.ontologyIri)}</code>` : ''}</b></div>
    <div class="owl-pv-sec">Profile 判定</div>${profHtml}
    <div class="owl-pv-sec">内容统计</div>
    <div class="owl-pv-counts">
      <span class="mini-tag">类 ${Number(cnt.classes) || 0}</span>
      <span class="mini-tag">谓词 ${Number(cnt.predicates) || 0}</span>
      <span class="mini-tag">公理 ${Number(cnt.axioms) || 0}</span>
      <span class="mini-tag">约束 ${Number(cnt.constraints) || 0}</span>
      <span class="mini-tag">实例 ${Number(cnt.individuals) || 0}</span>
      <span class="mini-tag">根类 ${Number(cnt.roots) || 0}</span>
    </div>
    ${rep.truncated ? '<div class="gd-desc">⚠ 超大本体已截断（仅保留根类与一级子类）。</div>' : ''}
    <div class="owl-pv-sec">类树预览（前 ${treeClasses.length} 个）</div>
    <svg class="owl-pv-tree" id="owl-preview-tree"></svg>
    <div class="owl-pv-sec">⚠ 警告</div>${warnHtml}
    ${noteHtml ? `<div class="owl-pv-sec">说明</div>${noteHtml}` : ''}`;
  // 渲染类树（renderOntologyTree 直接操作传入的 svg）
  try { if (typeof window.renderOntologyTree === 'function') window.renderOntologyTree($('owl-preview-tree'), treeOnto); } catch (_) {}
}

// ---------- 体系化导入（bundle）预览弹窗 ----------
// 展示「主本体 + 依赖清单（本地/已下载/缺失）+ 合并后计数 + 中英对照覆盖 + 样本类/谓词」，
// 让用户在落库前看清体系化导入把哪些本体合并成了一个体系。数据源是 graphPreviewBundle →
// previewBundleImport 的 { profile, report, preview, dependencies, via }。
function showBundleImportModal(pv, { onConfirm, onCancel } = {}) {
  const old = document.getElementById('bundle-preview-modal');
  if (old) old.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-mask';
  overlay.id = 'bundle-preview-modal';
  overlay.innerHTML = `<div class="modal owl-preview-modal">
    <div class="modal-head"><b>体系化导入预览</b><button class="icon-btn" id="bundle-preview-x" title="取消导入">${icoSvg('close', 12)}</button></div>
    <div class="modal-body" id="bundle-preview-body"><div class="gd-desc">解析中…</div></div>
    <div class="modal-foot">
      <span class="form-hint" id="bundle-preview-via"></span>
      <button class="btn btn-ghost" id="bundle-preview-cancel">取消</button>
      <button class="btn btn-primary" id="bundle-preview-ok">确认导入</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const close = (fn) => { overlay.remove(); if (fn) fn(); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(onCancel); });
  $('bundle-preview-x').addEventListener('click', () => close(onCancel));
  $('bundle-preview-cancel').addEventListener('click', () => close(onCancel));
  $('bundle-preview-ok').addEventListener('click', () => close(onConfirm));

  if (!pv || pv.ok === false) {
    $('bundle-preview-body').innerHTML = `<div class="gd-desc">体系化导入解析失败：${escapeHtml((pv && pv.error) || '未知错误')}。</div>`;
    const okBtn = $('bundle-preview-ok'); if (okBtn) okBtn.disabled = true;
    return;
  }
  const prv = pv.preview || {};
  const cnt = prv.counts || {};
  const deps = prv.dependencies || [];
  $('bundle-preview-via').textContent = pv.via === 'protege-js' ? 'protege-js 解析' : '内置正则解析（owl.js）';

  // 依赖清单：本地/已下载 = 已并入；缺失/失败 = 未并入（给出 purl 供手动下载）
  const depBadge = (source) => {
    const M = { local: ['本地', 'dep-ok'], downloaded: ['已下载', 'dep-ok'], missing: ['缺失', 'dep-miss'], failed: ['下载失败', 'dep-miss'] };
    const [txt, cls] = M[source] || [source || '?', 'dep-miss'];
    return `<span class="bundle-dep-badge ${cls}">${escapeHtml(txt)}</span>`;
  };
  const depHtml = deps.length
    ? `<div class="bundle-dep-list">${deps.map((d) =>
        `<div class="bundle-dep-row">${depBadge(d.source)}<b>${escapeHtml(d.prefix)}</b><span class="bundle-dep-cnt">${d.via === 'owl-import' ? 'owl:imports' : `引用×${Number(d.count) || 0}`}</span>`
        + `<code class="owl-pv-iri" title="${escapeHtml(d.purl || '')}">${escapeHtml(d.purl || '')}</code>`
        + (d.error ? `<span class="bundle-dep-err">${escapeHtml(d.error)}</span>` : '') + `</div>`).join('')}</div>`
    : '<div class="gd-desc">主本体既无 OBO 内联引用、也无 owl:imports 声明，将作为单文件体系导入。</div>';

  const warnHtml = (prv.warnings && prv.warnings.length)
    ? `<div class="owl-warn-list">${prv.warnings.map((w) => `<div class="owl-warn-item">⚠ ${escapeHtml(w)}</div>`).join('')}</div>`
    : '<div class="gd-desc">未发现导入风险。</div>';
  const noteHtml = (prv.notes && prv.notes.length)
    ? prv.notes.map((n) => `<div class="gd-desc">· ${escapeHtml(n)}</div>`).join('') : '';

  // 样本类/谓词（中英对照：key 英文 + label 中文/源文件label）
  const sampleRow = (it) => `<div class="bundle-sample-row"><code>${escapeHtml(it.key)}</code><span>${escapeHtml(it.label || '')}</span>${it.parent ? `<em>⊑ ${escapeHtml(it.parent)}</em>` : ''}</div>`;
  const predRow = (p) => `<div class="bundle-sample-row"><code>${escapeHtml(p.key)}</code><span>${escapeHtml(p.label || '')}</span>${(p.domain || p.range) ? `<em>${escapeHtml(p.domain || '?')} → ${escapeHtml(p.range || '?')}</em>` : ''}</div>`;
  const sampleClassesHtml = (prv.sampleClasses && prv.sampleClasses.length)
    ? prv.sampleClasses.map(sampleRow).join('') : '<div class="gd-desc">无</div>';
  const samplePredsHtml = (prv.samplePredicates && prv.samplePredicates.length)
    ? prv.samplePredicates.map(predRow).join('') : '<div class="gd-desc">无（合并后仍无谓词）</div>';

  $('bundle-preview-body').innerHTML = `
    <div class="owl-pv-row"><span>主本体</span><b title="${escapeHtml(prv.fileName || '')}">${escapeHtml(prv.fileName || '（未知）')}${prv.ontologyIri ? ` · <code class="owl-pv-iri">${escapeHtml(prv.ontologyIri)}</code>` : ''}</b></div>
    <div class="owl-pv-row"><span>解析器</span><b>${escapeHtml(prv.parser || '')}</b></div>
    <div class="owl-pv-sec">依赖本体（${deps.length}）</div>${depHtml}
    <div class="owl-pv-sec">合并后统计（${Number(cnt.sources) || 1} 个本体 → 1 个体系）</div>
    <div class="owl-pv-counts">
      <span class="mini-tag">类 ${Number(cnt.classes) || 0}</span>
      <span class="mini-tag">谓词 ${Number(cnt.predicates) || 0}</span>
      <span class="mini-tag">公理 ${Number(cnt.axioms) || 0}</span>
      <span class="mini-tag">约束 ${Number(cnt.constraints) || 0}</span>
      <span class="mini-tag">根类 ${Number(cnt.roots) || 0}</span>
    </div>
    <div class="owl-pv-sec">样本类（前 ${(prv.sampleClasses || []).length}）</div>${sampleClassesHtml}
    <div class="owl-pv-sec">样本谓词（前 ${(prv.samplePredicates || []).length}）</div>${samplePredsHtml}
    <div class="owl-pv-sec">⚠ 警告</div>${warnHtml}
    ${noteHtml ? `<div class="owl-pv-sec">说明</div>${noteHtml}` : ''}`;
}


// ---------- 本体定义页：当前体系的「本体抽取 / 实体识别」提示词 ----------
// 覆盖键 baseKey:profileId 存 settings；留空/恢复默认回退到内置体系专属提示词
async function renderOntoPrompts(o) {
  const wrap = $('onto-prompts');
  if (!wrap) return;
  const pid = o && o.profileId;
  if (!pid) { wrap.hidden = true; return; }
  wrap.hidden = false; // 外层始终显示（折叠条），主体由 onto-prompts-body 的 hidden 控制
  const nameEl = $('onto-prompts-profile');
  if (nameEl) nameEl.textContent = o.profileName || pid;
  let data = null;
  try { data = await window.kb.graphProfilePrompts(pid); } catch (_) { data = null; }
  if (!data || !data.ok) return;
  const fill = (taId, item) => {
    const ta = $(taId);
    if (!ta) return;
    ta.value = (item && item.value) || '';
    ta.placeholder = '（内置默认）' + ((item && item.def) || '');
  };
  fill('onto-prompt-extract', data.extract);
  fill('onto-prompt-entity', data.entity);
}

async function saveOntoPrompt(base, taId) {
  const pid = state.kg.onto && state.kg.onto.profileId;
  if (!pid) return;
  const value = $(taId).value;
  const res = await window.kb.graphSaveProfilePrompt({ profileId: pid, base, value });
  if (!res || !res.ok) { toast('保存失败：' + ((res && res.error) || '未知错误'), 4000); return; }
  toast('已保存当前体系提示词，下次抽取/识别时生效');
}

async function resetOntoPrompt(base, taId) {
  const pid = state.kg.onto && state.kg.onto.profileId;
  if (!pid) return;
  await window.kb.graphSaveProfilePrompt({ profileId: pid, base, value: '' }); // 空值=删除覆盖回退默认
  const data = await window.kb.graphProfilePrompts(pid);
  if (data && data.ok) {
    const item = base === 'graphExtractPrompt' ? data.extract : data.entity;
    $(taId).value = (item && item.value) || '';
    $(taId).placeholder = '（内置默认）' + ((item && item.def) || '');
  }
  toast('已恢复内置体系默认提示词');
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
  const res = await window.kb.ontoSave({ kind, item, profileId: state.kg.onto && state.kg.onto.profileId });
  if (!res.ok) { toast('保存失败：' + res.error, 4000); return; }
  state.kg.onto = res.ontology;
  $('onto-modal').hidden = true;
  toast('本体已更新，下次「抽取本体层」时生效');
  renderKgOntology();
}

async function removeOntoItem(kind, keyOrIndex) {
  let label = keyOrIndex;
  if (kind === 'cons') {
    // keyOrIndex 是 userConstraints 索引；从 onto.constraints 里找对应描述用于确认提示
    const o = state.kg.onto;
    const custom = (o && o.constraints ? o.constraints : []).filter((c) => typeof c === 'object' ? c.from !== 'base' : true);
    const item = custom[Number(keyOrIndex)];
    const desc = item ? (typeof item === 'string' ? item : item.desc) : null;
    label = desc ? (desc.length > 24 ? desc.slice(0, 24) + '…' : desc) : `约束 #${Number(keyOrIndex) + 1}`;
  }
  if (!confirm(`确定删除「${label}」？`)) return;
  const res = await window.kb.ontoRemove({ kind, key: keyOrIndex, profileId: state.kg.onto && state.kg.onto.profileId });
  if (!res.ok) { toast('删除失败：' + res.error, 4000); return; }
  state.kg.onto = res.ontology;
  toast('已删除');
  renderKgOntology();
}

// 体系切换：仅切换本页浏览/编辑的体系（落 kv profileId），不影响抽取/问答——后者由 AI 自动选择体系
async function switchOntoProfile(profileId) {
  const res = await window.kb.ontoSetProfile(profileId);
  if (!res.ok) { toast('切换失败：' + res.error, 4000); return; }
  state.kg.onto = res.ontology;
  state.kg.ontoView = 'viz'; // 切换体系后回到 OWLViz 层级图，直观看到层级
  state.kg.ontoCollapsed = {}; // 新体系重置子树折叠状态
  state.kg.vizSel = null;    // 重置选中态/折叠，避免跨体系残留
  renderKgOntology();
}

// KG 自然语言问答：抽取实体 → 邻居事实 → 事实约束回答
let kgListeners = [];
function cleanupKgListeners() { kgListeners.forEach((off) => off()); kgListeners = []; }
let kgBusy = false; // KG 问答独立忙标记：不被 AI 面板残留的 aiBusy 静默阻断

async function kgAskFlow() {
  const ta = $('kg-ask-input');
  // 空输入时直接用占位示例作为默认问题，可直接点击提问
  let question = ta.value.trim();
  if (!question) question = (ta.placeholder || '').replace(/^例[：:]\s*/, '').trim();
  if (!question || kgBusy) return;
  kgBusy = true;
  state.aiBusy = true; // 流式事件共用，期间阻止 AI 面板并发提问
  $('btn-kg-ask').disabled = true;
  $('kg-ask-out').hidden = false;
  // 执行过程逐行打印：每个阶段追加一行，保留完整轨迹；结果清单渲染在日志下方的独立容器
  $('kg-facts').innerHTML = '<div class="gd-sec">执行过程</div><div class="kg-log" id="kg-log"></div><div id="kg-result"></div>';
  $('kg-answer').innerHTML = '';
  cleanupKgListeners();
  let answer = '';
  const kgLogLine = (t, cls) => {
    const box = document.getElementById('kg-log');
    if (!box) return;
    const div = document.createElement('div');
    div.className = 'kg-log-line' + (cls ? ' ' + cls : '');
    div.textContent = t;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  };
  // §6.8：把「本回答包含 N 条推理得出的事实」脚注挂在回答末尾。
  // 由 onKgFacts 里的 impact.inferredCount 驱动，ai:done / finally 时各尝试挂一次（谁后到谁挂）。
  let kgImpactInfo = null;
  let kgFootnoteDone = false;
  const appendReasonFootnote = () => {
    if (kgFootnoteDone || !kgImpactInfo) return;
    const n = Number(kgImpactInfo.inferredCount) || 0;
    if (n <= 0) return;
    if (!answer || !$('kg-answer').innerHTML.trim()) return;  // 回答还没渲染出来，等 done/finally 再挂
    kgFootnoteDone = true;
    answer += `\n\n---\n\n> ⚡ 本回答包含 ${n} 条由 OWL 2 RL 推理得出的事实（标注「⚡推理」）；推导路径可到「知识图谱 → 本体定义 → 推理」Tab 查看。`;
    $('kg-answer').innerHTML = renderMarkdown(answer);
  };
  kgLogLine('▶ 启动 KG 问答管线…', 'kg-log-run');
  kgListeners = [
    window.kb.onKgStage((t) => { kgLogLine('▸ ' + t); }),
    window.kb.onKgFacts(({ matched, facts, refs, impact }) => {
      // §6.8：impact 是「影响面扩展」的回执（仅命中影响类关键词时非空）
      kgImpactInfo = impact || null;
      const refItems = (refs || []).map((r) =>
        `<div class="kg-fact kg-ref" data-kind="${r.kind}" data-path="${escapeHtml(r.path)}" title="点击打开原文">${r.kind === 'wiki' ? 'Wiki' : '笔记'}·${escapeHtml(r.label)}</div>`).join('');
      // §6.8：后端 impactToFacts 已在推理事实的字符串末尾拼上「⚡推理」标记（infer 标记无法走 IPC 结构体，
      // 只能随文本下发），这里按该后缀识别，给这一行加紫色徽标样式而不是改文本。
      const factHtml = (facts || []).map((f) => {
        const s = String(f);
        return s.includes('⚡推理')
          ? `<div class="kg-fact kg-fact-inferred" title="该事实由 OWL 2 RL 推理得出，非原文抽取">${escapeHtml(s)}</div>`
          : `<div class="kg-fact">${escapeHtml(s)}</div>`;
      }).join('');
      // 影响面概览行：告诉用户这次问答沿传递谓词多找了哪些下游节点
      const impactHtml = (impact && Number(impact.nodeCount) > 0)
        ? `<div class="gd-sec">影响面扩展（${Number(impact.nodeCount) || 0} 个下游节点 · ${Number(impact.inferredCount) || 0} 条推理）</div>` +
          `<div class="gd-desc">${escapeHtml(((impact.summaries || [])[0]) || '')}</div>`
        : '';
      // 结果清单写入独立容器，避免覆盖上方执行日志
      const box = document.getElementById('kg-result');
      if (box) box.innerHTML =
        `<div class="gd-sec">匹配实体（${matched.length}）</div>` + (matched.map((m) => `<span class="mini-tag">${escapeHtml(m)}</span>`).join(' ') || '（无）') +
        impactHtml +
        `<div class="gd-sec">引用资料（${(refs || []).length}）</div>` + (refItems || '<div class="gd-desc">（无）</div>') +
        `<div class="gd-sec">事实清单（${facts.length}）</div>` + (factHtml || '<div class="gd-desc">（无）</div>');
      // 若流式回答已开始渲染，立刻把脚注挂上（不等 done）
      appendReasonFootnote();
    }),
    window.kb.onAiChunk((c) => { answer += c; $('kg-answer').innerHTML = renderMarkdown(answer); }),
    // 注意：ai:done/ai:error 是全局广播事件，可能来自其它并发请求，
    // 不能在这里清理监听器，否则会把本次问答的后续阶段日志吞掉；
    // 清理统一放在本次 graphAsk invoke 返回后的 finally 里。
    // 仅当本次问答已有回答内容时才打印完成标记，忽略上一问残留的 done 事件
    window.kb.onAiDone(() => { if (answer) { kgLogLine('✔ 回答生成完成', 'kg-log-run'); appendReasonFootnote(); } }),
    window.kb.onAiError((m) => { kgLogLine('⚠ ' + m, 'kg-log-run'); $('kg-answer').innerHTML = renderMarkdown(answer + `\n\n> ⚠ ${m}`); }),
  ];
  try {
    await window.kb.graphAsk({
      settings: state.settings,
      question,
      hops: parseInt($('kg-ask-hops').value, 10) || 3,
      withFacts: $('kg-ask-facts').checked,
    });
  } finally {
    // 稍等以确保最后一批流式事件渲染完毕，再恢复按钮并清理本次监听器
    setTimeout(() => {
      appendReasonFootnote();
      kgBusy = false;
      state.aiBusy = false;
      $('btn-kg-ask').disabled = false;
      cleanupKgListeners();
    }, 400);
  }
}

// 自适应：重置视口变换并按包围盒完整适配画布，不再改写布局坐标。
function fitGraphView() {
  recenterGraph();
  updateGraphStats();
}

// 画布尺寸变化时只更新缩放/平移。节点保持其物理布局，避免“缩坐标但不缩半径”产生二次重叠。
function recenterGraph() {
  const canvas = $('graph-canvas');
  const W = canvas.clientWidth || 800;
  const H = canvas.clientHeight || 600;
  const nodes = graphSim.nodes;
  // 空集合也要重绘一次：否则切到无图谱的体系/范围时画布残留上一范围的旧画面
  if (!nodes.length) { drawGraph(); return; }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x - n.r); maxX = Math.max(maxX, n.x + n.r);
    minY = Math.min(minY, n.y - n.r); maxY = Math.max(maxY, n.y + n.r);
  }
  const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
  const pad = Math.max(40, Math.min(80, Math.min(W, H) * 0.08));
  const s = Math.min(1.6, Math.max(0.4, Math.min((W - pad * 2) / bw, (H - pad * 2) / bh)));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  graphSim.zoom = s;
  graphSim.ox = -(cx - W / 2) * s;
  graphSim.oy = -(cy - H / 2) * s;
  graphSim.metrics = GraphDensity.layoutMetrics({ width: W, height: H, nodeCount: nodes.length });
  drawGraph();
}

// 一次性几何分开（不涉速度、不依赖温度）：只在初始布局后调用，避免交互期间持续抖动。
function settleCollisions(iters = graphSim.nodes.length > 200 ? 18 : 8) {
  const nodes = graphSim.nodes;
  const GAP = (graphSim.metrics || {}).gap || 10;
  for (let k = 0; k < iters; k++) {
    let moved = 0;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;
        const minD = a.r + b.r + GAP;
        if (d2 >= minD * minD) continue;
        const d = Math.sqrt(d2);
        const angle = d > 0.001 ? 0 : ((i * 0.73 + j * 1.17) % (Math.PI * 2));
        const ux = d > 0.001 ? dx / d : Math.cos(angle);
        const uy = d > 0.001 ? dy / d : Math.sin(angle);
        const push = (minD - d) / 2;
        a.x += ux * push; a.y += uy * push;
        b.x -= ux * push; b.y -= uy * push;
        moved++;
      }
    }
    if (!moved) break;
  }
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
  // 筛选后空集：清屏后在画布中央给出提示（全图本就为空时由 #graph-empty 覆盖层负责）
  if (!graphSim.nodes.length) {
    if (state.graph.nodes.length) {
      ctx.fillStyle = 'rgba(125, 135, 155, 0.8)';
      ctx.font = '13px system-ui, "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('当前筛选范围暂无实体：该体系/知识图谱下还没有图谱，可切换上方范围', W / 2, H / 2);
    }
    return;
  }
  ctx.translate(W / 2 + graphSim.ox, H / 2 + graphSim.oy);
  ctx.scale(graphSim.zoom, graphSim.zoom);
  ctx.translate(-W / 2, -H / 2);
  const byId = new Map(graphSim.nodes.map((n) => [n.id, n]));
  const policy = graphDensityPolicy();
  graphSim.density = policy;
  const activeIds = graphActiveNodeIds();
  const activeCenter = graphSim.hoverNode || graphSim.selected;
  // 大图概览保留全量边的拓扑，但弱化普通边并收起箭头；聚焦节点的关联边始终完整呈现。
  for (const e of graphSim.edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    if (len <= a.r + b.r + 8) continue;
    const isInferred = !!e.inferred;
    const isHover = graphSim.hover && graphSim.hover.edge === e;
    const isRelated = !!activeCenter && (e.from === activeCenter || e.to === activeCenter);
    ctx.globalAlpha = activeIds && !isRelated ? 0.08 : (isRelated || isHover ? 1 : policy.edgeOpacity);
    ctx.strokeStyle = isInferred ? INFERRED_EDGE.stroke : RAW_EDGE.stroke;
    ctx.lineWidth = (isInferred ? INFERRED_EDGE.width : RAW_EDGE.width) + (isHover || isRelated ? 1.2 : 0);
    if (isInferred) ctx.setLineDash(INFERRED_EDGE.dash);
    const { cx: qx, cy: qy } = edgeBow(a, b, 1);
    const i1 = Math.hypot(qx - a.x, qy - a.y) || 1;
    const sx = a.x + ((qx - a.x) / i1) * (a.r + 2), sy = a.y + ((qy - a.y) / i1) * (a.r + 2);
    const i2 = Math.hypot(b.x - qx, b.y - qy) || 1;
    const ux = (b.x - qx) / i2, uy = (b.y - qy) / i2;
    const tipX = b.x - ux * (b.r + 3), tipY = b.y - uy * (b.r + 3);
    const al = 7;
    const bx = tipX - ux * al, by = tipY - uy * al;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.quadraticCurveTo(qx, qy, bx, by); ctx.stroke();
    ctx.setLineDash([]);
    if (policy.showArrows || isRelated || isHover) {
      const px = -uy, py = ux, hw = al * 0.45;
      ctx.fillStyle = isInferred ? INFERRED_EDGE.arrow : RAW_EDGE.arrow;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(bx + px * hw, by + py * hw);
      ctx.lineTo(bx - px * hw, by - py * hw);
      ctx.closePath();
      ctx.fill();
    }
  }
  // 节点：聚焦时仅突出中心节点和一跳邻居，其余节点降噪但仍保持可见。
  for (const n of graphSim.nodes) {
    const isSelected = graphSim.selected === n.id;
    const isHoverNode = graphSim.hoverNode === n.id;
    ctx.globalAlpha = activeIds && !activeIds.has(n.id) ? 0.18 : 1;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    ctx.fillStyle = graphTypeColor(n.type);
    ctx.fill();
    ctx.strokeStyle = isSelected ? '#1f2329' : (isHoverNode ? '#0f9f6e' : '#ffffff');
    ctx.lineWidth = isSelected || isHoverNode ? 2.8 : 2;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  drawGraphLabels(ctx, dpr, W, H);
}

// 弧线几何（二次贝塞尔的控制点）：控制点 = 直线中点沿法向外推 bow。
// 法向取 (-dy, dx) 且不再额外给符号：交换 from/to 时法向自然翻转，
// 因此同一对节点的正反两条边会往相反方向鼓，不会叠成一条（加符号反而会把翻转抵消）。
// scale 用于屏幕坐标系下复用同一公式（标签层传 zoom），保证谓词正好落在弧线中点。
function edgeBow(a, b, scale) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const bow = Math.min(30 * scale, len * 0.16);
  const nx = -dy / len, ny = dx / len;               // 单位法向
  return {
    len,
    cx: (a.x + b.x) / 2 + nx * bow,                  // 控制点
    cy: (a.y + b.y) / 2 + ny * bow,
    mx: (a.x + b.x) / 2 + nx * bow / 2,              // 弧线中点 B(0.5)
    my: (a.y + b.y) / 2 + ny * bow / 2,
  };
}

// 标签绘制在屏幕坐标系下进行：缩小看结构、放大自动恢复更多细节；所有标签始终避开节点和已放置文字。
function drawGraphLabels(ctx, dpr, W, H) {
  const z = graphSim.zoom;
  const policy = graphSim.density || graphDensityPolicy();
  const focusId = graphSim.hoverNode || graphSim.selected;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const sx = (x) => W / 2 + graphSim.ox + (x - W / 2) * z;
  const sy = (y) => H / 2 + graphSim.oy + (y - H / 2) * z;
  const view = graphSim.nodes
    .map((n) => ({ n, x: sx(n.x), y: sy(n.y), r: Math.max(2, n.r * z) }))
    .filter((p) => p.x > -40 && p.x < W + 40 && p.y > -40 && p.y < H + 40);
  const LH = 13;
  const PAD = 2;
  const placed = [];
  const rectOf = (x, y, w, align) => {
    const x1 = align === 'center' ? x - w / 2 : (align === 'left' ? x : x - w);
    return { x1: x1 - PAD, x2: x1 + w + PAD, y1: y - LH + 3 - PAD, y2: y + 3 + PAD };
  };
  const rectGap = (a, b) => Math.hypot(Math.max(a.x1 - b.x2, b.x1 - a.x2, 0), Math.max(a.y1 - b.y2, b.y1 - a.y2, 0));
  const nodeGap = (r, p) => {
    const nx = Math.max(r.x1, Math.min(p.x, r.x2));
    const ny = Math.max(r.y1, Math.min(p.y, r.y2));
    return Math.hypot(p.x - nx, p.y - ny) - (p.r + 1);
  };
  // 对多个可行候选位评分：优先选择离其他节点/标签更远的位置，而不是机械取第一个位置。
  const scoreSpot = (rect, cand, owner) => {
    let clearance = Infinity;
    for (const p of view) {
      const gap = nodeGap(rect, p);
      if (gap < 0) return -Infinity;
      clearance = Math.min(clearance, gap);
    }
    for (const other of placed) {
      const gap = rectGap(rect, other);
      if (gap <= 0) return -Infinity;
      clearance = Math.min(clearance, gap);
    }
    return Math.min(clearance, 80) - Math.hypot(cand.x - owner.x, cand.y - owner.y) * 0.035;
  };
  const findSpot = (text, cands, owner) => {
    const w = ctx.measureText(text).width;
    let best = null;
    for (const cand of cands) {
      const rect = rectOf(cand.x, cand.y, w, cand.align);
      const score = scoreSpot(rect, cand, owner);
      if (!best || score > best.score) best = { ...cand, rect, score };
    }
    return best && best.score > -Infinity ? best : null;
  };
  const cenS = new Map();
  const byComm = new Map();
  for (const p of view) {
    const c = cenS.get(p.n.comm) || { x: 0, y: 0, n: 0 };
    c.x += p.x; c.y += p.y; c.n++;
    cenS.set(p.n.comm, c);
    const arr = byComm.get(p.n.comm) || [];
    arr.push(p);
    byComm.set(p.n.comm, arr);
  }
  cenS.forEach((c) => { c.x /= c.n; c.y /= c.n; });
  const hubIds = new Set();
  byComm.forEach((arr) => {
    arr.slice().sort((a, b) => b.r - a.r).slice(0, policy.hubPerCommunity).forEach((p) => hubIds.add(p.n.id));
  });
  const drawPlate = (r) => {
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    const rr = 3;
    ctx.beginPath();
    ctx.moveTo(r.x1 + rr, r.y1); ctx.lineTo(r.x2 - rr, r.y1);
    ctx.quadraticCurveTo(r.x2, r.y1, r.x2, r.y1 + rr); ctx.lineTo(r.x2, r.y2 - rr);
    ctx.quadraticCurveTo(r.x2, r.y2, r.x2 - rr, r.y2); ctx.lineTo(r.x1 + rr, r.y2);
    ctx.quadraticCurveTo(r.x1, r.y2, r.x1, r.y2 - rr); ctx.lineTo(r.x1, r.y1 + rr);
    ctx.quadraticCurveTo(r.x1, r.y1, r.x1 + rr, r.y1); ctx.closePath(); ctx.fill();
  };
  // 选中 > 悬停 > 枢纽 > 高连接度；不同密度模式只改变可入选范围，不隐藏任何节点。
  const order = view.slice().sort((a, b) => {
    const rank = (p) => (graphSim.selected === p.n.id ? 3 : (graphSim.hoverNode === p.n.id ? 2 : (hubIds.has(p.n.id) ? 1 : 0)));
    return rank(b) - rank(a) || b.r - a.r;
  });
  let ordinaryPlaced = 0;
  let nodeLabelCount = 0;
  for (const p of order) {
    const n = p.n;
    const isSel = graphSim.selected === n.id;
    const isHover = graphSim.hoverNode === n.id;
    const isPinned = isSel || isHover;
    const isHub = hubIds.has(n.id);
    if (policy.labelMode === 'hubs' && !isPinned && !isHub) continue;
    if (policy.labelMode === 'ranked' && !isPinned && !isHub && ordinaryPlaced >= policy.labelBudget) continue;
    if (policy.labelMode === 'all' && !isPinned && ordinaryPlaced >= policy.labelBudget) continue;
    ctx.font = isHub || isPinned ? '600 12px sans-serif' : '11px sans-serif';
    const cands = [
      { x: p.x, y: p.y + p.r + LH, align: 'center' },
      { x: p.x, y: p.y - p.r - 4, align: 'center' },
      { x: p.x + p.r + 6, y: p.y + 4, align: 'left' },
      { x: p.x - p.r - 6, y: p.y + 4, align: 'right' },
      { x: p.x + p.r + 4, y: p.y + p.r + LH, align: 'left' },
      { x: p.x - p.r - 4, y: p.y + p.r + LH, align: 'right' },
      { x: p.x + p.r + 4, y: p.y - p.r - 2, align: 'left' },
      { x: p.x - p.r - 4, y: p.y - p.r - 2, align: 'right' },
    ];
    if (isHub || isPinned) {
      const c = cenS.get(n.comm) || { x: W / 2, y: H / 2 };
      const dx = p.x - c.x, dy = p.y - c.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      for (const k of [1.6, 2.6, 3.6]) cands.push({ x: p.x + ux * (p.r + 10) * k, y: p.y + uy * (p.r + 10) * k, align: ux >= 0 ? 'left' : 'right' });
    }
    const full = `${n.type}:${n.name}`;
    const variants = [full.length > 22 ? full.slice(0, 21) + '…' : full, String(n.name).length > 16 ? String(n.name).slice(0, 15) + '…' : String(n.name)];
    let spot = null;
    let used = variants[0];
    for (const text of variants) {
      spot = findSpot(text, cands, p);
      if (spot) { used = text; break; }
    }
    // 仅选中/悬停节点允许白底兜底；概览中的普通枢纽绝不强行压在其他标签上。
    let forced = false;
    if (!spot) {
      if (!isPinned) continue;
      forced = true;
      used = variants[1];
      const w = ctx.measureText(used).width;
      spot = { ...cands[0], rect: rectOf(cands[0].x, cands[0].y, w, cands[0].align) };
    }
    placed.push(spot.rect);
    if (forced) drawPlate(spot.rect);
    ctx.textAlign = spot.align;
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = 3;
    ctx.strokeText(used, spot.x, spot.y);
    ctx.fillStyle = isPinned || isHub ? '#1f2329' : '#3c4048';
    ctx.fillText(used, spot.x, spot.y);
    nodeLabelCount++;
    if (!isPinned && !isHub) ordinaryPlaced++;
  }
  // 概览中隐藏普通谓词；聚焦节点或放大后才显示关系名称，防止“关系文字云”。
  let edgeLabelCount = 0;
  if (policy.showEdgeLabels || focusId) {
    const byId = new Map(view.map((p) => [p.n.id, p]));
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    for (const e of graphSim.edges) {
      if (focusId && e.from !== focusId && e.to !== focusId) continue;
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b) continue;
      const label = e.inferred ? `${e.rel} ⚡` : e.rel;
      const span = Math.hypot(b.x - a.x, b.y - a.y) - a.r - b.r;
      const w = ctx.measureText(label).width;
      if (span < w + 14) continue;
      const g = edgeBow({ id: a.n.id, x: a.x, y: a.y }, { id: b.n.id, x: b.x, y: b.y }, z);
      const mx = g.mx, my = g.my - 3;
      const rect = rectOf(mx, my, w, 'center');
      if (scoreSpot(rect, { x: mx, y: my }, { x: mx, y: my }) === -Infinity) continue;
      placed.push(rect);
      ctx.strokeStyle = 'rgba(245,246,248,0.92)';
      ctx.lineWidth = 3;
      ctx.strokeText(label, mx, my);
      ctx.fillStyle = e.inferred ? INFERRED_EDGE.color : RAW_EDGE.color;
      ctx.fillText(label, mx, my);
      edgeLabelCount++;
    }
  }
  graphSim.labelInfo = { nodeLabelCount, edgeLabelCount, level: policy.level };
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

// ---------- 推理边悬停：推导链 tooltip（融合设计 §6.2）----------
// 目标：把「黑盒 AI 说这有关系」变成「因为 A→B 且 B→C 所以 A→C」——可解释、可审计、可质疑。

// 单条边在模拟坐标系下的采样折线（与 drawGraph 的裁切/弧线公式保持一致）。
// 返回 null 表示这条边太短、画布上根本没画出来。
function edgeSamplePoints(e, byId) {
  const a = byId.get(e.from), b = byId.get(e.to);
  if (!a || !b) return null;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  if (len <= a.r + b.r + 8) return null;
  const { cx: qx, cy: qy } = edgeBow(a, b, 1);
  const i1 = Math.hypot(qx - a.x, qy - a.y) || 1;
  const sx = a.x + ((qx - a.x) / i1) * (a.r + 2), sy = a.y + ((qy - a.y) / i1) * (a.r + 2);
  const i2 = Math.hypot(b.x - qx, b.y - qy) || 1;
  const ux = (b.x - qx) / i2, uy = (b.y - qy) / i2;
  const tipX = b.x - ux * (b.r + 3), tipY = b.y - uy * (b.r + 3);
  const al = 7;
  const bx = tipX - ux * al, by = tipY - uy * al;
  const pts = [];
  const N = 14;
  for (let k = 0; k <= N; k++) {
    const t = k / N, mt = 1 - t;
    // 二次贝塞尔 B(t) = (1-t)²P0 + 2(1-t)t P1 + t² P2
    pts.push({
      x: mt * mt * sx + 2 * mt * t * qx + t * t * bx,
      y: mt * mt * sy + 2 * mt * t * qy + t * t * by,
    });
  }
  return pts;
}

// 命中检测：到贝塞尔采样折线的最短距离 < 阈值（模拟坐标，故阈值随缩放反向补偿）
function pickEdgeAt(p) {
  const byId = new Map(graphSim.nodes.map((n) => [n.id, n]));
  const tol = 5 / Math.max(0.4, graphSim.zoom);   // 屏幕上恒定 5px
  const tol2 = tol * tol;
  let best = null, bestD = tol2;
  for (const e of graphSim.edges) {
    if (!e.inferred) continue;   // §6.2 只对推理边给推导链
    const pts = edgeSamplePoints(e, byId);
    if (!pts) continue;
    // 包围盒粗筛：大图谱下避免对每条边都算 14 段距离
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const q of pts) {
      if (q.x < minX) minX = q.x;
      if (q.x > maxX) maxX = q.x;
      if (q.y < minY) minY = q.y;
      if (q.y > maxY) maxY = q.y;
    }
    if (p.x < minX - tol || p.x > maxX + tol || p.y < minY - tol || p.y > maxY + tol) continue;
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i].x, ay = pts[i].y, bxx = pts[i + 1].x, byy = pts[i + 1].y;
      const dx = bxx - ax, dy = byy - ay;
      const l2 = dx * dx + dy * dy || 1;
      let t = ((p.x - ax) * dx + (p.y - ay) * dy) / l2;
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      const cx = ax + dx * t - p.x, cy = ay + dy * t - p.y;
      const d2 = cx * cx + cy * cy;
      if (d2 < bestD) { bestD = d2; best = e; }
    }
  }
  return best;
}

// 节点显示名（tooltip / 影响面共用）：优先实体名，回退到 id
function graphNodeLabel(id) {
  const n = state.graph.nodes.find((x) => x.id === id);
  return n ? n.name : (id || '?');
}

function edgeTooltipHtml(e) {
  const g = state.graph;
  const froms = Array.isArray(e.inferredFrom) ? e.inferredFrom : [];
  const rows = froms.map((idx) => {
    const p = g.edges[Number(idx)];
    if (!p) return '';
    const mark = p.inferred ? '<span class="tt-inferred">⚡</span>' : '';
    return `<div class="tt-row">${mark}${escapeHtml(graphNodeLabel(p.from))} <span class="tt-rel">—${escapeHtml(p.rel || '相关')}→</span> ${escapeHtml(graphNodeLabel(p.to))}</div>`;
  }).join('');
  const via = inferredViaName(e.inferredVia);
  return `<div class="tt-head">⚡ 推理边 · ${escapeHtml(e.rel || '相关')}</div>
    <div class="tt-sub">${escapeHtml(graphNodeLabel(e.from))} → ${escapeHtml(graphNodeLabel(e.to))}${via ? ` · ${escapeHtml(via)}` : ''}</div>
    ${rows ? `<div class="tt-sec">推理自以下 ${froms.length} 条前提：</div>${rows}` : '<div class="tt-sec">（未记录前提边：该边由推理器直接得出）</div>'}
    <div class="tt-foot">推理器：${escapeHtml(e.inferredBy || 'owl2rl')}${e.inferredAt ? ` · ${escapeHtml(formatDate(e.inferredAt))}` : ''}</div>`;
}

function showEdgeTooltip(e, clientX, clientY) {
  let el = document.getElementById('graph-edge-tooltip');
  if (!el) {
    el = document.createElement('div');
    el.id = 'graph-edge-tooltip';
    el.className = 'graph-tooltip';
    // fixed 定位挂 body：不受画布容器 overflow/transform 影响
    document.body.appendChild(el);
  }
  el.innerHTML = edgeTooltipHtml(e);
  el.hidden = false;
  // 先显示再量尺寸，避免超出视窗右/下边缘
  const pad = 14;
  const r = el.getBoundingClientRect();
  let x = clientX + pad, y = clientY + pad;
  if (x + r.width > window.innerWidth - 8) x = clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = clientY - r.height - pad;
  el.style.left = `${Math.max(8, x)}px`;
  el.style.top = `${Math.max(8, y)}px`;
}

function hideEdgeTooltip() {
  const el = document.getElementById('graph-edge-tooltip');
  if (el) el.hidden = true;
}

// 节点悬停优先于边：高亮一跳邻居，并把节点名称纳入标签优先级。
function setHoverNode(node) {
  const id = node ? node.id : null;
  if (graphSim.hoverNode === id) return;
  graphSim.hoverNode = id;
  if (!$('graph-view').hidden) drawGraph();
}

// 悬停状态变更：更新 graphSim.hover 并重绘一次（高亮该边）。
// 只在「悬停目标真的变了」时重绘，避免 mousemove 每帧全量重画。
function setHoverEdge(e, clientX, clientY) {
  const prev = graphSim.hover && graphSim.hover.edge;
  if (prev === e) {
    if (e) showEdgeTooltip(e, clientX, clientY);   // 同一条边：tooltip 跟随鼠标
    return;
  }
  graphSim.hover = e ? { edge: e } : null;
  if (e) showEdgeTooltip(e, clientX, clientY);
  else hideEdgeTooltip();
  if (!$('graph-view').hidden) drawGraph();
}

// ---------- 节点详情 ----------
// 来源行点击打开：笔记编辑器或原始文件
function openGraphSourceItem(it) {
  if (it.kind === 'note' && it.id && typeof selectNote === 'function') return selectNote(it.id);
  if (it.kind === 'raw' && it.path && typeof openRawNative === 'function') return openRawNative(it.path);
  toast('该来源对应的原文已不存在或当前环境无法打开', 3000);
}

// 来源列表渲染为可点击行（整体图谱节点详情）：
// 先占位渲染，再异步解析出可打开目标，补上类型图标与失效置灰，点击即跳转对应文档
function renderGdSources(box, node) {
  const sec = box.querySelector('[data-sec-sources]');
  if (!sec) return;
  const srcs = node.sources || [];
  if (!srcs.length) { sec.innerHTML = '<div class="gd-desc">无</div>'; return; }
  const ICONS = { note: 'notes', raw: 'folder-open' };
  sec.innerHTML = srcs.map((s) =>
    `<div class="gd-src openable" data-src="${escapeHtml(s)}" title="点击打开原文"><span class="gd-src-ico">${icoSvg('notes', 12)}</span><span>${escapeHtml(s)}</span></div>`).join('');
  const bind = (items) => {
    sec.querySelectorAll('.gd-src.openable').forEach((el) => {
      const it = (items || []).find((x) => x.label === el.dataset.src) || { kind: 'missing' };
      el.classList.toggle('missing', it.kind === 'missing');
      el.querySelector('.gd-src-ico').innerHTML = icoSvg(ICONS[it.kind] || 'notes', 12);
      el.title = it.kind === 'missing'
        ? '该来源对应的原文已不存在'
        : `点击打开：${it.title || it.path || el.dataset.src}`;
      el.addEventListener('click', () => openGraphSourceItem(it));
    });
  };
  window.kb.graphResolveSources({ settings: state.settings, labels: srcs })
    .then((r) => bind(r && r.items))
    .catch(() => bind([]));
}

function renderGraphDetail(node) {
  const box = $('graph-detail');
  if (!node) { box.hidden = true; return; }
  box.hidden = false;
  const byId = new Map(state.graph.nodes.map((n) => [n.id, n]));
  // 保留原始数组下标：后端 deleteEdgeWithCascade 按 graph.edges 下标定位（§5.3）
  const rels = state.graph.edges
    .map((e, idx) => ({ e, idx }))
    .filter((x) => x.e && (x.e.from === node.id || x.e.to === node.id));
  const relHtml = rels.map(({ e, idx }) => {
    const otherId = e.from === node.id ? e.to : e.from;
    const other = byId.get(otherId);
    if (!other) return '';
    const inf = e.inferred ? '<span class="kg-fact-inferred" title="该关系由推理得出">⚡</span>' : '';
    return `<div class="gd-rel" data-node="${otherId}" data-idx="${idx}">${inf}${escapeHtml(e.from === node.id ? node.name : other.name)}<span class="rel-tag">—${escapeHtml(e.rel)}→</span>${escapeHtml(e.from === node.id ? other.name : node.name)}<button class="icon-btn danger gd-rel-del" data-del="${idx}" title="删除该关系（连带级联清理派生推理边）">${icoSvg('close', 11)}</button></div>`;
  }).join('');
  const infN = rels.filter((x) => x.e.inferred).length;
  box.innerHTML = `
    <div class="kg-edetail-head"><h4><span class="gd-type" style="background:${graphTypeColor(node.type)}">${escapeHtml(graphTypeName(node.type))}</span>${escapeHtml(node.name)}</h4><button class="icon-btn danger" id="btn-gd-del-node" title="删除该节点及其全部关系">${icoSvg('close', 12)}</button></div>
    <div class="gd-desc">${escapeHtml(node.desc || '（无描述）')}</div>
    <div class="gd-sec">关系（${rels.length}${infN ? ` · 其中 ${infN} 条推理` : ''}）</div>
    ${relHtml || '<div class="gd-desc">无</div>'}
    <div class="gd-sec">来源</div>
    <div data-sec-sources></div>
  `;
  renderGdSources(box, node);
  box.querySelectorAll('.gd-rel').forEach((el) => {
    el.addEventListener('click', (ev) => {
      // 点删除按钮时不触发跳转
      if (ev.target.closest('.gd-rel-del')) return;
      const target = graphHierarchyEntityNode(el.dataset.node);
      if (target) selectGraphNode(target, { center: true });
    });
  });
  box.querySelectorAll('.gd-rel-del').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      deleteGraphEdgeAt(Number(btn.dataset.del));
    });
  });
  const delNodeBtn = $('btn-gd-del-node');
  if (delNodeBtn) delNodeBtn.addEventListener('click', () => deleteGraphNodeAt(node.id));
}

// ---------- 图谱操作 ----------
// 删除一条边（融合设计 §5.3）：后端做级联清理，前端把「连带清掉 N 条派生推理边」如实告知用户。
// 这是 F9 验收点——用户必须能看见推理边不是凭空消失，而是随前提一起被清理。
async function deleteGraphEdgeAt(idx) {
  if (!Number.isInteger(idx) || idx < 0) return;
  const e = (state.graph.edges || [])[idx];
  if (!e) { toast('该边已不存在，请刷新图谱'); return; }
  const label = `${graphNodeLabel(e.from)} —${e.rel || '相关'}→ ${graphNodeLabel(e.to)}`;
  const kind = e.inferred ? '推理边' : '原始边';
  const warn = e.inferred
    ? `删除这条推理边？\n${label}`
    : `删除这条原始边？\n${label}\n\n注意：依赖它推出的推理边会被一并级联清理。`;
  if (!confirm(warn)) return;
  let r = null;
  try { r = await window.kb.graphDeleteEdge(idx); } catch (err) { toast('删除失败：' + ((err && err.message) || err)); return; }
  if (!r || r.ok === false) { toast('删除失败：' + ((r && r.error) || '未知错误')); return; }
  // §5.3 UI 反馈：级联清理了 N 条推理边时明确提示
  const casc = Number(r.cascaded) || 0;
  toast(casc > 0
    ? `已删除该${kind}及其 ${casc} 条派生推理边`
    : `已删除该${kind}`, 3200);
  await refreshGraphAfterMutation();
}

// 删除一个节点（§5.3）：连带清理所有触及它的边，并沿溯源链传播
async function deleteGraphNodeAt(id) {
  if (!id) return;
  const n = state.graph.nodes.find((x) => x.id === id);
  if (!n) { toast('该节点已不存在，请刷新图谱'); return; }
  const touched = (state.graph.edges || []).filter((e) => e.from === id || e.to === id).length;
  if (!confirm(`删除节点「${n.name}」？\n将连带删除其 ${touched} 条关系，以及依赖这些关系推出的推理边。`)) return;
  let r = null;
  try { r = await window.kb.graphDeleteNode(id); } catch (err) { toast('删除失败：' + ((err && err.message) || err)); return; }
  if (!r || r.ok === false) { toast('删除失败：' + ((r && r.error) || '未知错误')); return; }
  const casc = Number(r.cascaded) || 0;
  toast(`已删除节点「${n.name}」及其 ${Number(r.removedEdges) || 0} 条关系`
    + (casc > 0 ? `（含 ${casc} 条派生推理边）` : ''), 3200);
  if (state.kg.focus === id) state.kg.focus = null;
  if (graphSim.selected === id) graphSim.selected = null;
  await refreshGraphAfterMutation();
}

// 删除后统一刷新：重拉图谱（后端已标 inferredStale=true）→ 重绘各视图
async function refreshGraphAfterMutation() {
  await loadGraph();
  renderGraphEmpty();
  renderSidebar();
  if (state.kg.tab === 'graph') startGraphSim();
  else $('graph-detail').hidden = true;
}

// 对全图执行一轮 OWL 2 RL 推理（整体图谱工具栏与本体定义·推理 Tab 共用）。
// 推理对象始终是整个知识库的唯一全局图谱（按体系分组物化后合并），与当前浏览的体系/筛选无关。
// opts.noToast/noBar：调用方（工具栏「校验」）自带措辞与校验摘要条时，抑制本轮推理的 toast 与推理条，避免两条信息打架。
async function runGraphInference(opts) {
  const o = opts || {};
  if (!o.noToast) toast('推理中…', 2000);
  let result = null;
  try {
    // IPC graph:runInference 在主进程侧用 readSettingsSafe() 读设置（ipc.js:720 传 null），
    // 所以这里不需要、也不能靠传 settings 来影响开关/超时。
    const r = await window.kb.graphRunInference({});
    result = r;
    if (!o.noToast) {
      if (r && r.ok && !r.skipped) {
        toast(`推理完成：新增 ${r.inferredEdges} 条推理边（${r.rounds} 轮 / ${((r.elapsedMs || 0) / 1000).toFixed(1)}s）${(r.inconsistencies || []).length ? `，检出 ${r.inconsistencies.length} 处冲突` : ''}`, 4000);
      } else if (r && r.skipped) {
        toast('推理已跳过：' + reasonSkipText(r.skipReason), 3500);
      } else {
        toast('推理失败：' + ((r && r.error) || '未知错误'), 3500);
      }
    }
  } catch (err) {
    if (!o.noToast) toast('推理异常：' + ((err && err.message) || err), 3500);
  }
  // 重推理会重写图谱：刷新缓存并重绘画布
  await loadGraph();
  // 持久化展示推理结果（toast 会消失，摘要条留在工具栏下方供核对）
  if (result && result.ok && !result.skipped && !o.noBar) showGraphReasonBar(result);
  return result;
}

// 通道 C 只读体检（融合设计 §12.2.3）：工具栏「校验」按钮与本体定义·推理 Tab「全图校验」按钮共用。
// 只读：不改写任何边、不删除数据；返回 validateGraph 的原始结果供 renderValidateReport/摘要条渲染。
async function runFullGraphValidate(profileId, opts) {
  if (typeof window.kb.graphValidate !== 'function') {
    return { ok: false, error: '当前环境不支持全图校验（缺少 graphValidate 桥接）' };
  }
  try {
    return await window.kb.graphValidate(profileId, opts || {});
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

// 图谱工具栏中的摘要同时保留最近一次推理与体检结果，避免后到结果覆盖先到结果。
let graphReasonSummaryState = { reason: null, validation: null };
function renderGraphReasonBar() {
  const bar = $('graph-reason-bar');
  if (!bar) return;
  const cards = [];
  const reason = graphReasonSummaryState.reason;
  if (reason) {
    const scopeInferred = countInferredEdges(kgFilteredGraph().edges);
    const conflicts = (reason.inconsistencies || []).length;
    cards.push(`<div class="graph-reason-summary is-reason"><span class="kg-badge" title="推理对全图运行，当前筛选仅影响画布视图">推理</span><span>新增 <b>${Number(reason.inferredEdges) || 0}</b> 条边 · ${Number(reason.rounds) || 0} 轮 · ${((Number(reason.elapsedMs) || 0) / 1000).toFixed(1)}s</span>${conflicts ? `<b class="kg-reason-conflict">${conflicts} 处不一致冲突</b>` : '<b class="kg-reason-ok">无冲突</b>'}<span class="form-hint">当前筛选命中 ${scopeInferred} 条</span><button class="btn btn-ghost" data-graph-summary-goto="reason">查看详情</button></div>`);
  }
  const validation = graphReasonSummaryState.validation;
  if (validation) {
    const { v, profileId, inferred, scope } = validation;
    // 校验范围如实展示：体检只跑「选定体系 ∩ 选定知识图谱」内的边，摘要条标明范围避免误读为全图
    const sc = scope ? (state.kg.graphScopes || []).find((s) => s.id === scope) : null;
    const scopeNote = scope ? `· 知识图谱「${escapeHtml((sc && (sc.label || sc.domain)) || scope)}」` : '· 全部知识图谱';
    if (!v || v.ok === false) {
      cards.push(`<div class="graph-reason-summary is-error"><span class="kg-badge kg-badge-warn">体检失败</span><span>${escapeHtml((v && v.error) || '未知错误')}（图谱数据不受影响）</span><button class="btn btn-ghost" data-graph-summary-goto="reason">查看详情</button></div>`);
    } else {
      const counts = reasonValidationCounts(v);
      const coverage = v.coverage || {};
      const infHint = inferred && inferred.ok && !inferred.skipped ? `本轮推理 +${inferred.inferredEdges} 边 · ` : '';
      cards.push(`<div class="graph-reason-summary is-validate"><span class="kg-badge" title="体检只读：不改写任何边、不删除数据">体检</span><span>体系「${escapeHtml(v.profileName || profileId || v.profileId || '')}」${scopeNote} · 检查 <b>${Number(v.checked) || 0}</b> 条边</span>${counts.violations + counts.disjoint ? `<b class="kg-reason-conflict">${counts.violations} 条越界 · ${counts.disjoint} 处不相交</b>` : '<b class="kg-reason-ok">未发现约束违规</b>'}<span class="form-hint">${infHint}覆盖 ${coverage.coveragePct != null ? coverage.coveragePct + '%' : '—'}</span><button class="btn btn-ghost" data-graph-summary-goto="reason">查看详情</button></div>`);
    }
  }
  if (!cards.length) { bar.hidden = true; return; }
  bar.innerHTML = `${cards.join('')}<button class="icon-btn" id="btn-graph-reasonbar-x" title="关闭">${icoSvg('close', 12)}</button>`;
  bar.hidden = false;
  const close = $('btn-graph-reasonbar-x');
  if (close) close.addEventListener('click', () => { graphReasonSummaryState = { reason: null, validation: null }; bar.hidden = true; });
  bar.querySelectorAll('[data-graph-summary-goto]').forEach((btn) => btn.addEventListener('click', () => switchKgTab('reason')));
}

function showGraphValidateBar(v, profileId, inferred, scope) {
  graphReasonSummaryState.validation = { v, profileId, inferred, scope: scope || '' };
  renderGraphReasonBar();
}

function showGraphReasonBar(r) {
  graphReasonSummaryState.reason = r;
  renderGraphReasonBar();
}

// 清除全部推理边（§9 风险 3 的「一键还原」）：只删 inferred，原始边与节点不动
async function clearAllInferredEdges() {
  const infN = countInferredEdges(state.graph.edges);
  if (!infN) { toast('当前图谱没有推理边'); return; }
  if (!confirm(`清除全部 ${infN} 条推理边？\n原始抽取的边与节点不受影响；下次运行推理会重新生成。`)) return;
  let r = null;
  try { r = await window.kb.graphClearInferred(); } catch (err) { toast('清除失败：' + ((err && err.message) || err)); return; }
  if (!r || r.ok === false) { toast('清除失败：' + ((r && r.error) || '未知错误')); return; }
  toast(`已清除 ${Number(r.removed) || 0} 条推理边，剩余 ${Number(r.total) || 0} 条原始关系`, 3200);
  await refreshGraphAfterMutation();
}

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
  // 重载：重新拉一次图谱与本体（作业刚写入新节点时不用重开页面），并重排布局
  $('btn-graph-reload').addEventListener('click', async () => {
    state.kg.onto = null;
    await loadGraph();
    startGraphSim();
    toast('图谱已重载');
  });
  // 校验（通道 C 只读体检）：先跑一轮 OWL 2 RL 物化（推理边同样受检），再只对本页选定的
  // 体系 ∩ 知识图谱范围内的边按该体系约束（谓词白名单、domain/range）与公理体检；结果以摘要条持久展示。
  $('btn-graph-validate').addEventListener('click', async () => {
    const profileId = ($('kg-g-profile') || {}).value || '';
    const scope = ($('kg-g-domain') || {}).value || '';
    const btn = $('btn-graph-validate');
    btn.disabled = true;
    toast('校验中：先物化推理，再仅对选定体系与知识图谱范围的边体检…', 2500);
    const inferred = await runGraphInference({ noToast: true, noBar: true });
    const v = await runFullGraphValidate(profileId, scope ? { scope } : {});
    btn.disabled = false;
    showGraphValidateBar(v, profileId, inferred, scope);
    startGraphSim();
    renderGraphLegend();
  });
  $('btn-graph-focus').addEventListener('click', () => {
    state.kg.focus = null;
    startGraphSim();
    recenterGraph();
  });

  // KG 子视图与过滤
  // 侧边栏知识图谱子菜单：点击子项打开图谱页并切换到对应子视图
  $('kg-submenu').addEventListener('click', (e) => {
    const item = e.target.closest('.nav-sub-item');
    if (!item) return;
    showGraphView();
    switchKgTab(item.dataset.tab);
  });
  const profileFilter = $('kg-g-profile');
  if (profileFilter) profileFilter.addEventListener('change', async () => {
    profileFilter.dataset.userSelected = '1';
    // 切换体系后：同步刷新本体缓存（图例/类型下拉/节点配色都读它），避免图例始终停留在旧体系
    try {
      state.kg.onto = await window.kb.graphOntology(profileFilter.value);
    } catch (_) { /* 拉取失败时保留旧本体，图例/下拉维持原状 */ }
    renderGraphLegend();
    renderGraphDomainFilter();
    startGraphSim();
  });
  ['kg-g-type', 'kg-g-max', 'kg-g-density', 'kg-g-sort', 'kg-g-domain', 'kg-g-edgekind'].forEach((id) => {
    const filter = $(id);
    if (filter) filter.addEventListener('change', () => startGraphSim());
  });
  $('kg-onto-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-ot]');
    if (!b) return;
    state.kg.ontoTab = b.dataset.ot;
    document.querySelectorAll('#kg-onto-tabs button').forEach((x) => x.classList.toggle('active', x === b));
    renderKgOntology();
  });
  // 体系 tabs（横排展开，点击切换；仅浏览/编辑，不影响抽取/问答的体系选择）
  const profTabs = $('onto-profile-tabs');
  if (profTabs) profTabs.title = '仅浏览/编辑该体系；抽取与问答时由 AI 自动选择合适体系';
  if (profTabs) profTabs.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-pid]');
    if (!b) return;
    if (state.kg.onto && b.dataset.pid === state.kg.onto.profileId) return;
    switchOntoProfile(b.dataset.pid);
  });
  // 结构树 / 列表 视图切换
  const viewTabs = $('onto-view-tabs');
  if (viewTabs) viewTabs.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-ov]');
    if (!b) return;
    state.kg.ontoView = b.dataset.ov;
    renderKgOntology();
  });
  // 当前体系提示词：保存 / 恢复默认
  const bindOntoPrompt = (saveId, resetId, base, taId) => {
    const s = $(saveId), r = $(resetId);
    if (s) s.addEventListener('click', () => saveOntoPrompt(base, taId));
    if (r) r.addEventListener('click', () => resetOntoPrompt(base, taId));
  };
  bindOntoPrompt('btn-onto-prompt-extract-save', 'btn-onto-prompt-extract-reset', 'graphExtractPrompt', 'onto-prompt-extract');
  bindOntoPrompt('btn-onto-prompt-entity-save', 'btn-onto-prompt-entity-reset', 'graphEntityPrompt', 'onto-prompt-entity');
  // 提示词区折叠切换（默认收起，避免挤压结构树）
  const promptToggle = $('onto-prompts-toggle');
  if (promptToggle) promptToggle.addEventListener('click', () => {
    const body = $('onto-prompts-body');
    const caret = promptToggle.querySelector('.onto-prompts-caret');
    const open = body.hidden;
    body.hidden = !open;
    promptToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (caret) caret.textContent = open ? '收起 ▴' : '展开 ▾';
  });
  // 导入 OWL 体系（Electron 走 dialog；Web 走 <input type=file> + /api/upload）
  const btnImportOwl = $('btn-onto-import-owl');
  const doImport = async (filePath) => {
    const r = await window.kb.graphImportOwl(filePath ? { filePath } : {});
    return handleImportResult(r);
  };
  const doImportWeb = async (filePath, fileName) => {
    const r = await window.kb.graphImportOwl({ filePath, fileName });
    return handleImportResult(r);
  };
  const handleImportResult = async (r) => {
    if (r && r.canceled) return;
    if (!r || r.ok === false) { toast('OWL 导入失败：' + ((r && r.error) || '未知错误')); return; }
    const rep = r.report || {};
    toast(`已导入「${r.profile.name}」：${rep.classCount} 类 / ${rep.predicateCount} 谓词${rep.truncated ? '（超大本体已截断）' : ''}${rep.orphanClasses && rep.orphanClasses.length ? '，孤儿类 ' + rep.orphanClasses.length + ' 个' : ''}`);
    state.kg.onto = null; // 清缓存强制重拉
    await renderKgOntology();
    switchOntoProfile(r.profile.id);
  };
  // §6.9：先预览（解析不落库）→ 弹窗确认 → 确认后才真正导入（落库+复制源文件）。
  // body 是 {filePath} / {filePath, fileName} / {}（Electron dialog 由主进程自己弹）。
  const previewThenImport = async (body) => {
    let pv = null;
    try { pv = await window.kb.graphPreviewOwl(body); } catch (e) { pv = { ok: false, error: e.message }; }
    if (pv && pv.canceled) return;  // 用户在系统对话框里取消了选文件
    showOwlPreviewModal(pv, {
      onConfirm: async () => {
        // BUG 修复：原先确认时原样透传 body（Electron 下为 {}），主进程会**二次弹出**
        // 文件选择对话框，用户以为「已经选过文件」而取消 → 导入静默终止、无任何报错。
        // 预览结果现已携带 filePath（owlImport.js 透传），确认时直接复用，不再弹窗。
        const confBody = (pv && pv.filePath) ? { filePath: pv.filePath, fileName: body && body.fileName } : body;
        const r = await window.kb.graphImportOwl(confBody);
        await handleImportResult(r);
      },
    });
  };
  // Electron 原生文件对话框滞留守卫：对话框打开期间主窗口失焦（blur），
  // 用户若不处理对话框又点导入按钮，会再叠一个对话框且按钮一直 disabled，表现为「按钮坏了」。
  let nativeDialogOpen = false;
  window.addEventListener('blur', () => { nativeDialogOpen = true; });
  window.addEventListener('focus', () => { nativeDialogOpen = false; });
  if (btnImportOwl) btnImportOwl.addEventListener('click', async () => {
    if (!window.__KB_WEB__ && nativeDialogOpen) {
      toast('还有未处理的文件选择对话框，请先在系统对话框中选择文件或取消');
      return;
    }
    try {
      btnImportOwl.disabled = true;
      // Web 模式（无 Electron dialog）：隐藏文件选择器 → 上传 → 拿服务端路径
      // 判定必须用 window.__KB_WEB__（kb-shim 注入的唯一标记）：window.kb.isElectron 曾两处桥接均未定义，
      // 导致桌面版误入本分支 fetch('/api/upload') 无服务而报 Failed to fetch
      if (window.__KB_WEB__) {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = '.owl,.rdf,.ttl,.xml';
        inp.onchange = async () => {
          const f = inp.files && inp.files[0];
          if (!f) { btnImportOwl.disabled = false; return; }
          try {
            const buf = await f.arrayBuffer();
            const up = await fetch('/api/upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: buf });
            const uj = await up.json();
            if (!uj || !uj.path) { toast('上传失败'); btnImportOwl.disabled = false; return; }
            await previewThenImport({ filePath: uj.path, fileName: f.name });
          } catch (e2) { toast('上传/导入异常：' + e2.message); }
          btnImportOwl.disabled = false;
        };
        inp.click();
        return;
      }
      // Electron 模式：直接走 dialog
      await previewThenImport({});
      btnImportOwl.disabled = false;
    } catch (e) { btnImportOwl.disabled = false; toast('OWL 导入异常：' + e.message); }
  });
  // 体系化导入（bundle）：选主本体 → 自动推断/下载依赖 → 合并预览 → 确认落库
  const btnImportBundle = $('btn-onto-import-bundle');
  const handleBundleResult = async (r) => {
    if (r && r.canceled) return;
    if (!r || r.ok === false) { toast('体系化导入失败：' + ((r && r.error) || '未知错误')); return; }
    const rep = r.report || {};
    const deps = r.dependencies || [];
    const mergedN = deps.filter((d) => d.source === 'local' || d.source === 'downloaded').length;
    toast(`已导入「${r.profile.name}」：${rep.classCount} 类 / ${rep.predicateCount} 谓词（合并 ${mergedN} 个依赖本体）`, 3600);
    state.kg.onto = null; // 清缓存强制重拉
    await renderKgOntology();
    switchOntoProfile(r.profile.id);
  };
  // 先预览（解析+推断+合并，不落库）→ 弹窗确认 → 确认后才真正导入（落库+复制源文件）。
  const previewThenBundle = async (body) => {
    let pv = null;
    try { pv = await window.kb.graphPreviewBundle(body); } catch (e) { pv = { ok: false, error: e.message }; }
    if (pv && pv.canceled) return;  // 用户在系统对话框里取消了选主本体
    showBundleImportModal(pv, {
      onConfirm: async () => {
        // 复用预览结果里的 mainPath（owlImport 透传），避免确认时二次弹框
        const confBody = { mainPath: (pv && pv.mainPath) || (body && body.mainPath), fileName: body && body.fileName, displayName: body && body.displayName };
        const r = await window.kb.graphImportBundle(confBody);
        await handleBundleResult(r);
      },
    });
  };
  if (btnImportBundle) btnImportBundle.addEventListener('click', async () => {
    if (!window.__KB_WEB__ && nativeDialogOpen) {
      toast('还有未处理的文件选择对话框，请先在系统对话框中选择文件或取消');
      return;
    }
    try {
      btnImportBundle.disabled = true;
      toast('体系化导入：选择主本体后会自动推断并下载依赖，首次可能需几十秒…', 3000);
      // Web 模式：隐藏文件选择器 → 上传主本体 → 拿服务端路径（同 OWL 导入）
      if (window.__KB_WEB__) {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = '.owl,.rdf,.ttl,.xml';
        inp.onchange = async () => {
          const f = inp.files && inp.files[0];
          if (!f) { btnImportBundle.disabled = false; return; }
          try {
            const buf = await f.arrayBuffer();
            const up = await fetch('/api/upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: buf });
            const uj = await up.json();
            if (!uj || !uj.path) { toast('上传失败'); btnImportBundle.disabled = false; return; }
            await previewThenBundle({ mainPath: uj.path, fileName: f.name });
          } catch (e2) { toast('上传/导入异常：' + e2.message); }
          btnImportBundle.disabled = false;
        };
        inp.click();
        return;
      }
      // Electron 模式：直接走 dialog（主进程弹框选主本体）
      await previewThenBundle({});
      btnImportBundle.disabled = false;
    } catch (e) { btnImportBundle.disabled = false; toast('体系化导入异常：' + e.message); }
  });
  // 删除当前 OWL 体系（仅 owl:* 时显示）
  const btnRemoveOwl = $('btn-onto-remove-owl');
  if (btnRemoveOwl) btnRemoveOwl.addEventListener('click', async () => {
    const cur = state.kg.onto && state.kg.onto.profileId ? state.kg.onto.profileId : '';
    if (!cur.startsWith('owl:')) return;
    const reset = async (msg) => { toast(msg); state.kg.onto = null; await switchOntoProfile('bfo-lite'); };
    if (!confirm(`删除体系「${cur}」？\n可选择是否连带清除该体系已提取的图谱节点。\n「确定」= 连带清除节点；「取消」= 仅删体系保留节点。`)) {
      const r0 = await window.kb.graphRemoveOwlProfile({ profileId: cur, clearGraphNodes: false });
      if (r0 && r0.ok) await reset('已删除体系（保留图谱节点）');
      return;
    }
    const r = await window.kb.graphRemoveOwlProfile({ profileId: cur, clearGraphNodes: true });
    if (r && r.ok) await reset(`已删除体系并清除 ${r.clearedNodes} 个节点`);
    else toast('删除失败：' + ((r && r.error) || '未知错误'));
  });
  // 本体增删改查
  $('btn-onto-add').addEventListener('click', () => {
    if (state.kg.ontoTab === 'axioms') { toast('公理为体系内置只读，不可新增', 2500); return; }
    openOntoModal(state.kg.ontoTab, null);
  });
  $('btn-onto-cancel').addEventListener('click', () => { $('onto-modal').hidden = true; });
  $('btn-onto-save').addEventListener('click', saveOntoItem);
  $('kg-onto-body').addEventListener('click', (e) => {
    // 父节点收起/展开子树
    const toggle = e.target.closest('button.kg-onto-toggle');
    if (toggle) {
      const collapsed = state.kg.ontoCollapsed || (state.kg.ontoCollapsed = {});
      collapsed[toggle.dataset.toggle] = !collapsed[toggle.dataset.toggle];
      renderKgOntology();
      return;
    }
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    if (state.kg.ontoTab === 'axioms') return; // 公理只读
    const kind = state.kg.ontoTab === 'classes' ? 'classes' : state.kg.ontoTab === 'preds' ? 'preds' : 'cons';
    if (btn.dataset.act === 'edit') {
      const o = state.kg.onto;
      if (kind === 'classes') openOntoModal(kind, o.classes.find((c) => c.key === btn.dataset.key));
      else if (kind === 'preds') openOntoModal(kind, o.predicates.find((p) => p.key === btn.dataset.key));
      else {
        // data-idx 是 userConstraints 索引；取对应描述文本（constraints 已规范化为 {desc, from} 对象）
        const custom = (o.constraints || []).filter((c) => typeof c === 'object' ? c.from !== 'base' : true);
        const item = custom[Number(btn.dataset.idx)];
        const desc = item ? (typeof item === 'string' ? item : item.desc) : '';
        openOntoModal(kind, { index: Number(btn.dataset.idx), text: desc });
      }
    } else {
      removeOntoItem(kind, kind === 'cons' ? btn.dataset.idx : btn.dataset.key);
    }
  });
  $('btn-kg-ask').addEventListener('click', kgAskFlow);
  // 引用资料点击跳转：笔记定位到编辑器
  $('kg-facts').addEventListener('click', (e) => {
    const el = e.target.closest('.kg-ref');
    if (!el) return;
    if (state.notes.some((n) => n.id === el.dataset.path)) selectNote(el.dataset.path);
  });

  const canvas = $('graph-canvas');
  canvas.addEventListener('mousedown', (ev) => {
    const p = graphPoint(ev);
    const node = graphHit(p);
    graphSim.drag = { node, startX: ev.clientX, startY: ev.clientY, ox: graphSim.ox, oy: graphSim.oy, moved: false };
    canvas.classList.add('dragging');
    setHoverNode(null);
    setHoverEdge(null, 0, 0);   // 开始拖拽/平移时收起 tooltip，避免遮挡
  });
  canvas.addEventListener('mousemove', (ev) => {
    if (!graphSim.drag) {
      // 未按住鼠标：节点悬停优先；没有命中节点时才检测推理边。
      const p = graphPoint(ev);
      const node = graphHit(p);
      setHoverNode(node);
      if (node) setHoverEdge(null, ev.clientX, ev.clientY);
      else setHoverEdge(pickEdgeAt(p), ev.clientX, ev.clientY);
      return;
    }
    const d = graphSim.drag;
    if (Math.abs(ev.clientX - d.startX) + Math.abs(ev.clientY - d.startY) > 4) d.moved = true;
    if (d.node) {
      const p = graphPoint(ev);
      d.node.x = p.x; d.node.y = p.y;
      d.node.vx = 0; d.node.vy = 0;
      graphSim.alpha = Math.max(graphSim.alpha, 0.08); // 拖拽时极轻度加热：邻居温和让位，不产生可见抖动
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
      selectGraphNode(node || null, { scrollTree: true });
    }
  });
  canvas.addEventListener('mouseleave', () => { graphSim.drag = null; canvas.classList.remove('dragging'); setHoverNode(null); setHoverEdge(null, 0, 0); });
  canvas.addEventListener('dblclick', fitGraphView);
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const next = graphSim.zoom * (ev.deltaY < 0 ? 1.1 : 0.9);
    graphSim.zoom = Math.min(3, Math.max(0.4, next));
    updateGraphStats();
    drawGraph();
  }, { passive: false });
  // 布局空间变化时自动重新居中，避免图谱偏出可视区（尺寸未变时跳过，防止多余位移）
  if (window.ResizeObserver) {
    let lastW = 0, lastH = 0;
    new ResizeObserver(() => {
      const c = $('graph-canvas');
      if (!$('graph-view').hidden && (c.clientWidth !== lastW || c.clientHeight !== lastH)) {
        lastW = c.clientWidth; lastH = c.clientHeight;
        recenterGraph();
        updateGraphStats();
      }
    }).observe(canvas);
  }
}

