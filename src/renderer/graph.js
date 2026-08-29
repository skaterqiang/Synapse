// 渲染进程·图谱模块：图谱视图、力导向布局、KG 子视图与 KG 问答
// ================= 知识图谱 =================
// 类型配色（蓝-青-紫-橙-灰）：图例/画布/详情徽标共用同一套，保证各子视图颜色一致
// GRAPH_PALETTE / GRAPH_COLORS / GRAPH_TYPE_NAMES 统一定义于 renderer/constants.js
// 画布模拟运行时状态（坐标/缩放/拖拽），与持久化数据分离
const graphSim = { nodes: [], edges: [], zoom: 1, ox: 0, oy: 0, drag: null, selected: null, raf: 0, running: false, alpha: 1 };

// 实体类列表（key/展示名/颜色）：以本体定义为准，用户自定义的实体类也能正确显示名称与配色
function graphTypes() {
  const cls = (state.kg && state.kg.onto && state.kg.onto.classes) || [];
  const list = cls.length ? cls.map((c) => ({ key: c.key, name: c.label || c.key })) : Object.entries(GRAPH_TYPE_NAMES).map(([k, name]) => ({ key: k, name }));
  return list.map((t, i) => ({ ...t, color: GRAPH_COLORS[t.key] || GRAPH_PALETTE[i % GRAPH_PALETTE.length] }));
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
    state.graph = g || { nodes: [], edges: [], updatedAt: Date.now() };
  // 图例/类型下拉的名称与配色以本体定义为准，故先取一次本体（本地 kv 读取，开销可忽略）
  if (!state.kg.onto) state.kg.onto = await window.kb.graphOntology();
  // 领域下拉要显示领域中文名，而图谱作业可能刚自动新建了领域模版，故同步刷一次模版列表
  state.templates = (await window.kb.tplList()) || [];
  $('count-graph').textContent = state.graph.nodes.length;
  renderGraphTypeFilters();
  renderGraphDomainFilter();
  renderGraphStats();
  if (!$('graph-view').hidden) renderKgTab();
}

// 类型下拉（整体图谱 + 实体浏览）与实体浏览图例：随本体定义重建，保留当前选中项
function renderGraphTypeFilters() {
  const types = graphTypes();
    const fill = (id, allLabel) => { 
    const sel = $(id);
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = `<option value="">${allLabel}</option>` + types.map((t) => `<option value="${escapeHtml(t.key)}">${escapeHtml(t.name)}</option>`).join('');
    sel.value = types.some((t) => t.key === cur) ? cur : '';
  };
  fill('kg-g-type', '全部');
  fill('kg-f-type', '全部一级分类');
  const legend = $('kg-legend');
  if (legend) {
    legend.innerHTML = types.map((t) =>
      `<span class="lg-item"><i class="lg-dot" style="background:${t.color}"></i>${escapeHtml(t.name)}</span>`).join('');
  }
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
  const domains = [...new Set([...(state.templates || []).map((t) => t.id), ...state.graph.nodes.map((n) => n.domain || 'general')])];
  sel.innerHTML = '<option value="">全部领域</option>' + domains.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(name(d))}</option>`).join('');
  sel.value = domains.includes(cur) ? cur : '';
}

function renderGraphStats() {
  const g = state.graph;
  $('graph-stats').textContent = g.nodes.length
    ? `${g.nodes.length} 节点 · ${g.edges.length} 关系 · 更新 ${formatDate(g.updatedAt)}`
    : '尚未抽取';
}

// 图例（整体图谱）：“图例”首标 + 各实体类色点/名称/当前画布内节点数（counts 缺省时不带计数）
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
  const tip = document.createElement('span');
  tip.className = 'lg-tip';
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
    em.innerHTML = '<div class="empty-icon">' + icoSvg('kg', 44) + '</div><p>暂无知识图谱：选择上方范围后点击「抽取本体层」，<br>AI 将自动从笔记与原始文件中提取实体与关系。</p>';
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
  updateGraphFocusChip();
  const g = kgFilteredGraph();
  $('graph-stats').textContent = `实体 ${g.nodes.length} · 边 ${g.edges.length}` + (g.truncated ? '（已截断到上限）' : '') + (state.graph.updatedAt ? ` · 更新 ${formatDate(state.graph.updatedAt)}` : '');
  const old = new Map(graphSim.nodes.map((n) => [n.id, n]));
  const W = canvas.clientWidth || 800;
  const H = canvas.clientHeight || 600;
  // 节点半径按度数（连边数）放大：枢纽节点一眼可辨，sqrt 压缩避免超大圆
  const deg = {};
  g.edges.forEach((e) => { deg[e.from] = (deg[e.from] || 0) + 1; deg[e.to] = (deg[e.to] || 0) + 1; });
  // 社区划分 → 每个社区一个初始中心（中心分布在内圈上），同社区节点在其周围小范围播种，
  // 以此起手就形成分区，再由物理收敛成彼此分开的聚集区域
  const comm = detectCommunities(g.nodes, g.edges);
  const commKeys = [...new Set(g.nodes.map((n) => comm.get(n.id)))];
  const commIdx = new Map(commKeys.map((k, i) => [k, i]));
  const R0 = Math.max(120, Math.min(W, H) / 2 - 40);
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  const nc = Math.max(1, commKeys.length);
  const seenInComm = new Map();
  graphSim.nodes = g.nodes.map((n, i) => {
    const o = old.get(n.id);
    const ci = commIdx.get(comm.get(n.id)) || 0;
    const k = seenInComm.get(ci) || 0;
    seenInComm.set(ci, k + 1);
    // 社区中心：沿半径 0.55R 的圆均分；单社区时回退到画布中心
    const ang = (ci / nc) * Math.PI * 2;
    const ccx = W / 2 + (nc > 1 ? Math.cos(ang) * R0 * 0.55 : 0);
    const ccy = H / 2 + (nc > 1 ? Math.sin(ang) * R0 * 0.55 : 0);
    const rr = (nc > 1 ? R0 * 0.3 : R0) * Math.sqrt((k + 0.5) / Math.max(1, g.nodes.length / nc));
    return {
      ...n,
      comm: ci,
      x: o ? o.x : ccx + Math.cos(k * GOLDEN + ci) * rr,
      y: o ? o.y : ccy + Math.sin(k * GOLDEN + ci) * rr,
      vx: 0, vy: 0,
      r: 7 + Math.min(12, Math.sqrt(deg[n.id] || 0) * 3.2),
    };
  });
  // 图例计数只统当前过滤后进入画布的节点，与右侧“实体 n · 边 m”保持一致
  const counts = {};
  g.nodes.forEach((n) => { counts[n.type] = (counts[n.type] || 0) + 1; });
  renderGraphLegend(counts);
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
  // 物理仅在“温度”未冷却时运行（初始布局已同步预计算，首帧即静止）；
  // 拖拽必须真的移动过（moved）才加热：否则一次普通点击也会启动物理，节点白白抖一下
  const active = graphSim.alpha > 0.02 || (graphSim.drag && graphSim.drag.node && graphSim.drag.moved);
  if (active) {
    physicsStep(W, H, graphSim.alpha);
    graphSim.alpha = Math.max(0, graphSim.alpha * 0.99 - 0.0004);
  }
  drawGraph();
  graphSim.raf = requestAnimationFrame(graphTick);
}

// 单步物理：斥力 + 弹簧 + 向心，力幅乘以温度 a0
// 边界用“圆形软边界”而不是矩形硬钳制：矩形钳制会把溢出的节点全部压到上/下边排成直线，
// 因此改为按到圆心距离回拉，并把斥力/弹簧尺度按“n 个节点铺满目标圆”反推，使平衡态就是个圆盘
function physicsStep(W, H, a0) {
  const nodes = graphSim.nodes;
  const cx = W / 2, cy = H / 2;
  // 目标圆半径：画布内切圆留白 40px（软边界，节点可少量溢出）
  const R = Math.max(120, Math.min(W, H) / 2 - 40);
  // 目标间距：按“n 个节点铺满目标圆”反推，系数明显小于理论值 1.68：
  // 自由扩张后的团半径略小于 R，边界就不会“顶住”节点，得到实心圆盘而不是空心环
  const spacing = Math.max(24, Math.min(90, (0.85 * R) / Math.sqrt(Math.max(4, nodes.length))));
  const repK = spacing * spacing * 0.9;      // 斥力系数（与 d² 同尺度）
  const repRange2 = (spacing * 2.2) ** 2;    // 斥力作用半径平方，兼顾 O(n²) 开销
  const springLen = spacing * 1.15;          // 弹簧自然长度
  // 节点间斥力（超出作用半径则忽略）；跳社区的两个节点斥力加倍，以拉开不同聚集区域。
  // 同时做硬分离（collide）：两圆相碰时直接把坐标推开，保证节点不重叠、
  // 这是给标签腾出位置的前提（密集区字看不清的根本原因是节点挤成一团）
  const GAP = 10; // 圆与圆之间至少留的空隙
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      const cross = a.comm !== b.comm;
      const dx = a.x - b.x, dy = a.y - b.y;
      const d2 = dx * dx + dy * dy || 1;
      if (d2 < (cross ? repRange2 * 2.2 : repRange2)) {
        const f = ((cross ? repK * 1.8 : repK) / d2) * a0;
        a.vx += dx * f; a.vy += dy * f;
        b.vx -= dx * f; b.vy -= dy * f;
      }
      const minD = a.r + b.r + GAP;
      if (d2 < minD * minD) {
        const d = Math.sqrt(d2) || 1;
        // 硬分离也乘温度，且单帧推开量封顶 3px：冷却后不再改坐标（否则会与圆形边界来回拉扯而持续抖动），
        // 即使遇到深度重叠也分多帧温和化解，不会一帧弹开
        const push = Math.min(3, ((minD - d) / 2) * Math.min(1, a0 * 3));
        const ux = dx / d, uy = dy / d;
        a.x += ux * push; a.y += uy * push;
        b.x -= ux * push; b.y -= uy * push;
      }
    }
  }
  // 边弹簧力（归一化方向 + 力幅钳制，避免远距离二次发散）；
  // 同社区的边拉得紧一些，跳社区的边给更长的绳子
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const e of graphSim.edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) continue;
    const rest = a.comm === b.comm ? springLen : springLen * 2.2;
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const m = Math.max(-4, Math.min(4, (d - rest) * 0.02)) * a0;
    const ux = dx / d, uy = dy / d;
    a.vx += ux * m; a.vy += uy * m;
    b.vx -= ux * m; b.vy -= uy * m;
  }
  // 社区内聚：向本社区质心轻度汇聚，使同类节点成团（而不是均匀摊开）
  const cen = new Map();
  for (const n of nodes) {
    const c = cen.get(n.comm) || { x: 0, y: 0, n: 0 };
    c.x += n.x; c.y += n.y; c.n++;
    cen.set(n.comm, c);
  }
  for (const c of cen.values()) { c.x /= c.n; c.y /= c.n; }
  // 向心力 + 圆形软边界 + 阻尼 + 限幅（NaN 防护：异常时重置回中心）
  for (const n of nodes) {
    const tx = cx - n.x, ty = cy - n.y;
    const dist = Math.hypot(tx, ty) || 1;
    n.vx += tx * 0.0018 * a0;
    n.vy += ty * 0.0018 * a0;
    // 社区质心引力（只在多社区时生效）：把同社区节点收成一块，形成可识别的分区；
    // 引力不能太大，否则团内被压得没有空隙，标签无处可放
    if (cen.size > 1) {
      const c = cen.get(n.comm);
      if (c) { n.vx += (c.x - n.x) * 0.008 * a0; n.vy += (c.y - n.y) * 0.008 * a0; }
    }
    // 越出目标圆后沿半径方向回拉：回拉力必须与斥力同量级，否则节点会被斥力顶到硬边界上堆成一圈
    if (dist > R) {
      const pull = Math.min(8, spacing * 0.9 + (dist - R) * 0.12) * a0;
      n.vx += (tx / dist) * pull;
      n.vy += (ty / dist) * pull;
    }
    if (graphSim.drag && graphSim.drag.node === n) { n.vx = 0; n.vy = 0; continue; }
    // 单帧限速跟着温度走：初始布局（a0≈1）给足 6px/帧以快速收敛，
    // 拖拽这种低温场景（a0≈0.12）限到约 3px/帧，相邻节点是“温和跟随”而不是“一下弹开”
    const vCap = 6 * Math.min(1, 0.25 + a0 * 2);
    n.vx = Math.max(-vCap, Math.min(vCap, n.vx * 0.85));
    n.vy = Math.max(-vCap, Math.min(vCap, n.vy * 0.85));
    n.x += n.vx; n.y += n.vy;
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) {
      n.x = cx; n.y = cy; n.vx = 0; n.vy = 0;
    }
    // 硬边界也是圆：极端情况下节点落在圆周上而不是排成一条直线
    const hard = R * 1.35;
    const od = Math.hypot(n.x - cx, n.y - cy);
    if (od > hard) {
      n.x = cx + (n.x - cx) * (hard / od);
      n.y = cy + (n.y - cy) * (hard / od);
    }
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
  if (tab === 'overview') renderKgOverview();
  else if (tab === 'entities') renderKgEntities();
  else if (tab === 'graph') startGraphSim();
  else if (tab === 'ontology') renderKgOntology();
}

function kgCard(icon, num, label) {
  return `<div class="kg-card"><span class="kg-card-icon">${icoSvg(icon, 16)}</span><div><b>${num}</b><span>${label}</span></div></div>`;
}

function renderKgOverview() {
  const g = state.graph;
  const onto = (g.nodes.length && state.kg.onto) || null;
  const preds = onto ? onto.stats.predicateCount : 8;
  $('kg-overview-cards').innerHTML =
    kgCard('entities', onto ? onto.stats.classCount : 5, '实体类') +
    kgCard('mcp', preds, '谓词') +
    kgCard('kg', g.nodes.length, '实例总数') +
    kgCard('mcp', g.edges.length, '关系总数') +
    kgCard('history', g.updatedAt ? formatDate(g.updatedAt) : '—', '更新时间');
  const countBy = {};
  g.nodes.forEach((n) => { countBy[n.type] = (countBy[n.type] || 0) + 1; });
  const rows = graphTypes().map((t) => {
    const c = countBy[t.key] || 0;
    const pct = g.nodes.length ? Math.round((c / g.nodes.length) * 100) : 0;
    return `<div class="kg-bar-row"><span class="lg-dot" style="background:${t.color}"></span><span class="kg-bar-name">${escapeHtml(t.name)}</span><div class="kg-bar"><i style="width:${pct}%;background:${t.color}"></i></div><span>${c}</span></div>`;
  }).join('');
  $('kg-overview-types').innerHTML = `<h4>类型分布</h4>${rows || '<p class="modal-tip">暂无数据，先运行「抽取本体层」。</p>'}`;
}

function kgEntitySources(n) { return (n.sources || []).map((s) => (s.startsWith('Wiki') ? 'wiki' : 'notes')); }

function renderKgEntities() {
  const q = ($('kg-f-q').value || '').trim().toLowerCase();
  const type = $('kg-f-type').value;
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
      <i class="lg-dot" style="background:${graphTypeColor(n.type)}"></i>
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
    <div class="kg-edetail-head"><h4><span class="gd-type" style="background:${graphTypeColor(n.type)}">${escapeHtml(graphTypeName(n.type))}</span>${escapeHtml(n.name)}</h4><button class="icon-btn" id="btn-kg-edetail-close" title="关闭详情">${icoSvg('close', 12)}</button></div>
    <div class="kg-kv"><span>id</span><code>${escapeHtml(n.id)}</code></div>
    <div class="gd-desc">${escapeHtml(n.desc || '')}</div>
    <div class="gd-sec">来源（${(n.sources || []).length}）· 点击打开原文</div>
    <div data-sec-sources></div>
    <div class="gd-sec">出边（${out.length}）</div>${out.map(edgeRow).join('') || '<div class="gd-desc">（无）</div>'}
    <div class="gd-sec">入边（${inn.length}）</div>${inn.map(edgeRow).join('') || '<div class="gd-desc">（无）</div>'}
    <button class="btn btn-primary" id="btn-kg-neighbor">${icoSvg('kg', 13)}看邻居图 →</button>`;
  renderGdSources(box, n);
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
    kgCard('entities', o.stats.classCount, '实体类') +
    kgCard('mcp', o.stats.predicateCount, '谓词') +
    kgCard('table', o.stats.constraintCount, '校验约束') +
    kgCard('kg', o.stats.instanceCount, '实例总数') +
    kgCard('mcp', o.stats.edgeCount, '关系总数');
  const acts = (attr) => `<span class="kg-class-acts"><button class="icon-btn" data-act="edit" ${attr} title="编辑">${icoSvg('edit', 12)}</button><button class="icon-btn danger" data-act="del" ${attr} title="删除">${icoSvg('close', 12)}</button></span>`;
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
  kgLogLine('▶ 启动 KG 问答管线…', 'kg-log-run');
  kgListeners = [
    window.kb.onKgStage((t) => { kgLogLine('▸ ' + t); }),
    window.kb.onKgFacts(({ matched, facts, refs }) => {
      const refItems = (refs || []).map((r) =>
        `<div class="kg-fact kg-ref" data-kind="${r.kind}" data-path="${escapeHtml(r.path)}" title="点击打开原文">${r.kind === 'wiki' ? 'Wiki' : '笔记'}·${escapeHtml(r.label)}</div>`).join('');
      // 结果清单写入独立容器，避免覆盖上方执行日志
      const box = document.getElementById('kg-result');
      if (box) box.innerHTML =
        `<div class="gd-sec">匹配实体（${matched.length}）</div>` + (matched.map((m) => `<span class="mini-tag">${escapeHtml(m)}</span>`).join(' ') || '（无）') +
        `<div class="gd-sec">引用资料（${(refs || []).length}）</div>` + (refItems || '<div class="gd-desc">（无）</div>') +
        `<div class="gd-sec">事实清单（${facts.length}）</div>` + (facts.map((f) => `<div class="kg-fact">${escapeHtml(f)}</div>`).join('') || '<div class="gd-desc">（无）</div>');
    }),
    window.kb.onAiChunk((c) => { answer += c; $('kg-answer').innerHTML = renderMarkdown(answer); }),
    // 注意：ai:done/ai:error 是全局广播事件，可能来自其它并发请求，
    // 不能在这里清理监听器，否则会把本次问答的后续阶段日志吞掉；
    // 清理统一放在本次 graphAsk invoke 返回后的 finally 里。
    // 仅当本次问答已有回答内容时才打印完成标记，忽略上一问残留的 done 事件
    window.kb.onAiDone(() => { if (answer) kgLogLine('✔ 回答生成完成', 'kg-log-run'); }),
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
      kgBusy = false;
      state.aiBusy = false;
      $('btn-kg-ask').disabled = false;
      cleanupKgListeners();
    }, 400);
  }
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
  const pad = Math.max(40, Math.min(80, Math.min(W, H) * 0.08));
  // 缩放下限给到 0.25：下限太高（原 0.6）会让大布局“缩不下”而溢出画布，节点全贴在上下边上
  const s = Math.min(1.6, Math.max(0.25, Math.min((W - pad * 2) / bw, (H - pad * 2) / bh)));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  for (const n of nodes) {
    n.x = W / 2 + (n.x - cx) * s;
    n.y = H / 2 + (n.y - cy) * s;
    n.vx = 0; n.vy = 0;
  }
  // 缩放只缩坐标不缩半径，因此 s<1 时会凭空出现重叠；在绘制前一次性分开，
  // 而不依赖每帧物理去推（后者就是点击后持续抖动的根源）
  settleCollisions();
  drawGraph();
}

// 一次性几何分开（不涉速度、不依赖温度）：只在布局/缩放变更后调一次，
// 把相互叠圈的节点推到至少留 GAP 的距离，保证“节点不重叠”而不引入持续动画
function settleCollisions(iters = 6) {
  const nodes = graphSim.nodes;
  const GAP = 10;
  for (let k = 0; k < iters; k++) {
    let moved = 0;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const d2 = dx * dx + dy * dy || 1;
        const minD = a.r + b.r + GAP;
        if (d2 >= minD * minD) continue;
        const d = Math.sqrt(d2);
        const push = (minD - d) / 2;
        const ux = dx / d, uy = dy / d;
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
  ctx.translate(W / 2 + graphSim.ox, H / 2 + graphSim.oy);
  ctx.scale(graphSim.zoom, graphSim.zoom);
  ctx.translate(-W / 2, -H / 2);
  const byId = new Map(graphSim.nodes.map((n) => [n.id, n]));
  // 边（弧线 + 方向箭头：from → to，代表归属/关系指向）
  ctx.strokeStyle = 'rgba(138,145,159,0.5)';
  ctx.lineWidth = 1;
  for (const e of graphSim.edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    // 两端按节点半径裁剪，避免线/箭头被节点圆盖住
    if (len <= a.r + b.r + 8) continue;
    const { cx: qx, cy: qy } = edgeBow(a, b, 1);
    // 起点沿“a→控制点”、终点沿“控制点→b”方向裁切，使弧线两端与圆相切
    const i1 = Math.hypot(qx - a.x, qy - a.y) || 1;
    const sx = a.x + ((qx - a.x) / i1) * (a.r + 2), sy = a.y + ((qy - a.y) / i1) * (a.r + 2);
    const i2 = Math.hypot(b.x - qx, b.y - qy) || 1;
    const ux = (b.x - qx) / i2, uy = (b.y - qy) / i2;   // 终点处切线方向（箭头指向）
    const tipX = b.x - ux * (b.r + 3), tipY = b.y - uy * (b.r + 3);
    const al = 7; // 箭头长度
    const bx = tipX - ux * al, by = tipY - uy * al; // 箭头底边中心（弧线终点）
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.quadraticCurveTo(qx, qy, bx, by); ctx.stroke();
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
  // 节点
  for (const n of graphSim.nodes) {
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    ctx.fillStyle = graphTypeColor(n.type);
    ctx.fill();
    ctx.strokeStyle = graphSim.selected === n.id ? '#1f2329' : '#ffffff';
    ctx.lineWidth = graphSim.selected === n.id ? 2.5 : 2;
    ctx.stroke();
  }
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

// 标签绘制（防重叠）：在屏幕坐标系下画（不随缩放变字号），因此放大后节点间距变大、
// 能自动显示更多标签——密集区看不清时滚轮放大即可逐步读全。
// 遮挡物包括「已画的标签」与「所有节点圆」；位置摆不下就降级文本，再不行才不画。
function drawGraphLabels(ctx, dpr, W, H) {
  const z = graphSim.zoom;
  // 标签固定屏幕字号：重置为设备像素变换，自行把布局坐标换算成屏幕坐标
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const sx = (x) => W / 2 + graphSim.ox + (x - W / 2) * z;
  const sy = (y) => H / 2 + graphSim.oy + (y - H / 2) * z;
  // 只处理视窗内（外扩 40px）的节点：既避免白做活，也避免屏外节点占位
  const view = graphSim.nodes
    .map((n) => ({ n, x: sx(n.x), y: sy(n.y), r: Math.max(2, n.r * z) }))
    .filter((p) => p.x > -40 && p.x < W + 40 && p.y > -40 && p.y < H + 40);
  const LH = 13;
  const PAD = 2;   // 碰撞盒向外的宽余，避免两段文字刚好相贴
  const placed = [];
  const overlaps = (r) => placed.some((p) => !(r.x2 < p.x1 || r.x1 > p.x2 || r.y2 < p.y1 || r.y1 > p.y2));
  // 节点圆作为遮挡物：矩形与圆相交则认为被占（取圆心到矩形的最近点比半径）
  const hitsNode = (r) => view.some((p) => {
    const nx = Math.max(r.x1, Math.min(p.x, r.x2));
    const ny = Math.max(r.y1, Math.min(p.y, r.y2));
    const dx = p.x - nx, dy = p.y - ny;
    return dx * dx + dy * dy < (p.r + 1) * (p.r + 1);
  });
  const blocked = (r) => overlaps(r) || hitsNode(r);
  const rectOf = (x, y, w, align) => {
    const x1 = align === 'center' ? x - w / 2 : (align === 'left' ? x : x - w);
    return { x1: x1 - PAD, x2: x1 + w + PAD, y1: y - LH + 3 - PAD, y2: y + 3 + PAD };
  };
  // 社区质心（屏幕坐标）：把枢纽标签沿“远离团心”方向甩到人群外侧，比在团内硬挤更易成功
  const cenS = new Map();
  for (const p of view) {
    const c = cenS.get(p.n.comm) || { x: 0, y: 0, n: 0 };
    c.x += p.x; c.y += p.y; c.n++;
    cenS.set(p.n.comm, c);
  }
  cenS.forEach((c) => { c.x /= c.n; c.y /= c.n; });
  // 聚类中心：每个社区按半径（=度数）取前 3 个，它们是理解图谱结构的锚点，
  // 名字默认必须可见（摆不下就加白底牌强行显示）
  const hubIds = new Set();
  const byComm = new Map();
  for (const p of view) {
    const arr = byComm.get(p.n.comm) || [];
    arr.push(p);
    byComm.set(p.n.comm, arr);
  }
  byComm.forEach((arr) => {
    arr.slice().sort((a, b) => b.r - a.r).slice(0, 3).forEach((p) => hubIds.add(p.n.id));
  });
  // 白底牌：给强行显示的标签垫一层半透明底，即使压在节点/连线上也读得清
  const drawPlate = (r) => {
    ctx.fillStyle = 'rgba(255,255,255,0.86)';
    const rr = 3;
    ctx.beginPath();
    ctx.moveTo(r.x1 + rr, r.y1);
    ctx.lineTo(r.x2 - rr, r.y1);
    ctx.quadraticCurveTo(r.x2, r.y1, r.x2, r.y1 + rr);
    ctx.lineTo(r.x2, r.y2 - rr);
    ctx.quadraticCurveTo(r.x2, r.y2, r.x2 - rr, r.y2);
    ctx.lineTo(r.x1 + rr, r.y2);
    ctx.quadraticCurveTo(r.x1, r.y2, r.x1, r.y2 - rr);
    ctx.lineTo(r.x1, r.y1 + rr);
    ctx.quadraticCurveTo(r.x1, r.y1, r.x1 + rr, r.y1);
    ctx.closePath();
    ctx.fill();
  };
  // 节点名：先选中节点 → 再聚类中心 → 其余按半径（度数）从大到小，
  // 保证枢纽标签不被叶子节点先挤占位置
  const order = view.slice().sort((a, b) => {
    const rank = (p) => (graphSim.selected === p.n.id ? 2 : (hubIds.has(p.n.id) ? 1 : 0));
    return rank(b) - rank(a) || b.r - a.r;
  });
  for (const p of order) {
    const n = p.n;
    const isSel = graphSim.selected === n.id;
    const isHub = hubIds.has(n.id);
    ctx.font = isHub ? '600 12px sans-serif' : '11px sans-serif';
    // 位置候选：下/上/右/左 + 四个斜角，共 8 处；节点圆也是遮挡物，多给候选才能多保住标签
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
    // 枢纽额外给“往团外甩”的远位候选：沿质心→节点方向依次外推，跳出拥挤的团内
    if (isHub) {
      const c = cenS.get(n.comm) || { x: W / 2, y: H / 2 };
      const dx = p.x - c.x, dy = p.y - c.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      for (const k of [1.6, 2.6, 3.6]) {
        const ox = p.x + ux * (p.r + 10) * k;
        const oy = p.y + uy * (p.r + 10) * k;
        cands.push({ x: ox, y: oy, align: ux >= 0 ? 'left' : 'right' });
      }
    }
    // 文本逐级降级：先试「类型:名称」，摆不下就只留名称（类型已由颜色+图例表达），
    // 这比直接不画更有信息量
    const full = `${n.type}:${n.name}`;
    const variants = [full.length > 22 ? full.slice(0, 21) + '…' : full, String(n.name).length > 16 ? String(n.name).slice(0, 15) + '…' : String(n.name)];
    let spot = null;
    let used = variants[0];
    for (const text of variants) {
      const w = ctx.measureText(text).width;
      for (const c of cands) {
        const rect = rectOf(c.x, c.y, w, c.align);
        if (!blocked(rect)) { spot = { ...c, rect }; used = text; break; }
      }
      if (spot) break;
    }
    // 选中节点与聚类中心：宁可压东西也要显示（配白底牌保证可读）
    let forced = false;
    if (!spot) {
      if (!isSel && !isHub) continue;
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
    ctx.fillStyle = isSel ? '#1f2329' : (isHub ? '#1f2329' : '#3c4048');
    ctx.fillText(used, spot.x, spot.y);
  }
  // 关系谓词：优先级最低。只在“两端节点之间真的装得下文字”且中点无遮挡时才画，
  // 否则短边上的“包含/属于”会盖在节点圆上，正是密集区一片乱的来源
  const byId = new Map(view.map((p) => [p.n.id, p]));
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  for (const e of graphSim.edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) continue;
    const span = Math.hypot(b.x - a.x, b.y - a.y) - a.r - b.r;
    const w = ctx.measureText(e.rel).width;
    if (span < w + 14) continue; // 两圆之间的空隙装不下这个词，就不画
    // 谓词跟着弧线走：落在弧线中点（而不是直线中点），否则会脱离连线
    const g = edgeBow({ id: a.n.id, x: a.x, y: a.y }, { id: b.n.id, x: b.x, y: b.y }, z);
    const mx = g.mx, my = g.my - 3;
    const rect = rectOf(mx, my, w, 'center');
    if (blocked(rect)) continue;
    placed.push(rect);
    ctx.strokeStyle = 'rgba(245,246,248,0.92)';
    ctx.lineWidth = 3;
    ctx.strokeText(e.rel, mx, my);
    ctx.fillStyle = '#8a919f';
    ctx.fillText(e.rel, mx, my);
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
// 来源行点击打开：笔记编辑器或原始文件
function openGraphSourceItem(it) {
  if (it.kind === 'note' && it.id && typeof selectNote === 'function') return selectNote(it.id);
  if (it.kind === 'raw' && it.path && typeof openRawNative === 'function') return openRawNative(it.path);
  toast('该来源对应的原文已不存在或当前环境无法打开', 3000);
}

// 来源列表渲染为可点击行（整体图谱详情 / 实体浏览详情共用）：
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
  const rels = state.graph.edges.filter((e) => e.from === node.id || e.to === node.id);
  const relHtml = rels.map((e) => {
    const otherId = e.from === node.id ? e.to : e.from;
    const other = byId.get(otherId);
    if (!other) return '';
    return `<div class="gd-rel" data-node="${otherId}">${escapeHtml(e.from === node.id ? node.name : other.name)}<span class="rel-tag">—${escapeHtml(e.rel)}→</span>${escapeHtml(e.from === node.id ? other.name : node.name)}</div>`;
  }).join('');
  box.innerHTML = `
    <h4><span class="gd-type" style="background:${graphTypeColor(node.type)}">${escapeHtml(graphTypeName(node.type))}</span>${escapeHtml(node.name)}</h4>
    <div class="gd-desc">${escapeHtml(node.desc || '（无描述）')}</div>
    <div class="gd-sec">关系（${rels.length}）</div>
    ${relHtml || '<div class="gd-desc">无</div>'}
    <div class="gd-sec">来源</div>
    <div data-sec-sources></div>
  `;
  renderGdSources(box, node);
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
  // 重载：重新拉一次图谱与本体（作业刚写入新节点时不用重开页面），并重排布局
  $('btn-graph-reload').addEventListener('click', async () => {
    state.kg.onto = null;
    await loadGraph();
    startGraphSim();
    toast('图谱已重载');
  });
  $('btn-graph-focus').addEventListener('click', () => {
    state.kg.focus = null;
    startGraphSim();
    recenterGraph();
  });

  // KG 子视图与过滤（类型下拉的选项由 renderGraphTypeFilters 按本体定义填充）
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
  });
  canvas.addEventListener('mousemove', (ev) => {
    if (!graphSim.drag) return;
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

