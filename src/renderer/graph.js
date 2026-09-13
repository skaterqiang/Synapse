// 渲染进程·图谱模块：图谱视图、力导向布局、KG 子视图与 KG 问答
// ================= 知识图谱 =================
// 类型配色（蓝-青-紫-橙-灰）：图例/画布/详情徽标共用同一套，保证各子视图颜色一致
// GRAPH_PALETTE / GRAPH_COLORS / GRAPH_TYPE_NAMES 统一定义于 renderer/constants.js
// 画布模拟运行时状态（坐标/缩放/拖拽），与持久化数据分离
// hover：融合设计 §6.2 的悬停边（{edge, x, y}），用于高亮 + 推导链 tooltip
const graphSim = { nodes: [], edges: [], zoom: 1, ox: 0, oy: 0, drag: null, selected: null, hover: null, raf: 0, running: false, alpha: 1 };

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
  state.kg.graphProfiles = (await window.kb.graphProfiles()) || [];
  state.kg.graphScopes = window.kb.graphScopes ? ((await window.kb.graphScopes()) || []) : [];
  $('count-graph').textContent = state.graph.nodes.length;
  renderGraphProfileFilter();
  // 体系下拉重建后，按当前选中的 profile 重拉一次本体（初始渲染图例需与体系一致）
  const curPid = ($('kg-g-profile') || {}).value;
  if (curPid && (!state.kg.onto || state.kg.onto.profileId !== curPid)) {
    try { state.kg.onto = await window.kb.graphOntology(curPid); } catch (_) { /* 保留旧缓存 */ }
  }
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
  // 融合设计 §6.4：画布内推理边数一并显示，与图例的「推理边 N」保持一致
  const infN = countInferredEdges(g.edges);
  $('graph-stats').textContent = `实体 ${g.nodes.length} · 边 ${g.edges.length}`
    + (infN ? `（其中 ${infN} 条推理得出）` : '')
    + (g.truncated ? '（已截断到上限）' : '')
    + (state.graph.updatedAt ? ` · 更新 ${formatDate(state.graph.updatedAt)}` : '');
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
  // 重排后旧边对象已被替换，悬停高亮/tooltip 必须一并清掉（否则指向失效对象）
  graphSim.hover = null;
  hideEdgeTooltip();
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
  // 悬停状态随画布一起失效，避免关掉图谱页后 tooltip 残留在页面上
  graphSim.hover = null;
  hideEdgeTooltip();
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

function kgCard(icon, num, label, sub) {
  return `<div class="kg-card"><span class="kg-card-icon">${icoSvg(icon, 16)}</span><div><b>${num}</b><span>${label}</span>${sub ? `<em class="kg-card-sub">${escapeHtml(sub)}</em>` : ''}</div></div>`;
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
  // 带原始下标：删除走后端 deleteEdgeWithCascade(edgeIdx)（§5.3）
  const out = state.graph.edges.map((e, idx) => ({ e, idx })).filter((x) => x.e && x.e.from === id);
  const inn = state.graph.edges.map((e, idx) => ({ e, idx })).filter((x) => x.e && x.e.to === id);
  const edgeRow = ({ e, idx }) => {
    const other = e.from === id ? byId.get(e.to) : byId.get(e.from);
    const otherId = other ? other.id : '';
    const inf = e.inferred ? '<span class="kg-fact-inferred" title="该关系由 OWL 2 RL 推理得出">⚡推理</span>' : '';
    return `<div class="gd-rel" data-other="${escapeHtml(otherId)}" title="点击查看「${escapeHtml(other ? other.name : '')}」">${inf}${escapeHtml((byId.get(e.from) || {}).name || e.from)} <span class="rel-tag">→ ${escapeHtml(e.rel)} →</span> ${escapeHtml((byId.get(e.to) || {}).name || e.to)}<button class="icon-btn danger gd-rel-del" data-del="${idx}" title="删除该关系（连带级联清理派生推理边）">${icoSvg('close', 11)}</button></div>`;
  };
  const infOut = out.filter((x) => x.e.inferred).length;
  const infIn = inn.filter((x) => x.e.inferred).length;
  box.innerHTML = `
    <div class="kg-edetail-head"><h4><span class="gd-type" style="background:${graphTypeColor(n.type)}">${escapeHtml(graphTypeName(n.type))}</span>${escapeHtml(n.name)}</h4><span class="kg-edetail-acts"><button class="icon-btn danger" id="btn-kg-edetail-del" title="删除该实体及其全部关系">${icoSvg('close', 12)}</button><button class="icon-btn" id="btn-kg-edetail-close" title="关闭详情">${icoSvg('close', 12)}</button></span></div>
    <div class="kg-kv"><span>id</span><code>${escapeHtml(n.id)}</code></div>
    <div class="gd-desc">${escapeHtml(n.desc || '')}</div>
    <div class="gd-sec">来源（${(n.sources || []).length}）· 点击打开原文</div>
    <div data-sec-sources></div>
    <div class="gd-sec">出边（${out.length}${infOut ? ` · ${infOut} 条推理` : ''}）</div>${out.map(edgeRow).join('') || '<div class="gd-desc">（无）</div>'}
    <div class="gd-sec">入边（${inn.length}${infIn ? ` · ${infIn} 条推理` : ''}）</div>${inn.map(edgeRow).join('') || '<div class="gd-desc">（无）</div>'}
    <div class="gd-sec" data-sec-impact-head>影响面（沿传递谓词下游）</div>
    <div class="kg-impact-list" data-sec-impact><div class="gd-desc">计算中…</div></div>
    <button class="btn btn-primary" id="btn-kg-neighbor">${icoSvg('kg', 13)}看邻居图 →</button>`;
  renderGdSources(box, n);
  renderKgImpact(box, id);
  const neighborBtn = $('btn-kg-neighbor');
  if (neighborBtn) neighborBtn.addEventListener('click', () => {
    state.kg.focus = id; // 邻居视图：画布只看该节点的邻居
    switchKgTab('graph');
    graphSim.selected = id;
    renderGraphDetail(graphSim.nodes.find((x) => x.id === id) || null);
    recenterGraph();
  });
  const detailCloseBtn = $('btn-kg-edetail-close');
  if (detailCloseBtn) detailCloseBtn.addEventListener('click', () => {
    state.kg.entitySel = null;
    renderKgEntities();
  });
  const detailDelBtn = $('btn-kg-edetail-del');
  if (detailDelBtn) detailDelBtn.addEventListener('click', () => deleteGraphNodeAt(id));
  // 关系行点击跳转到对端实体；删除按钮单独处理（阻止冒泡）
  box.querySelectorAll('.gd-rel[data-other]').forEach((row) => {
    row.addEventListener('click', (ev) => {
      if (ev.target.closest('.gd-rel-del')) return;
      if (!row.dataset.other) return;
      state.kg.entitySel = row.dataset.other;
      renderKgEntities();
    });
  });
  box.querySelectorAll('.gd-rel-del').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      deleteGraphEdgeAt(Number(btn.dataset.del));
    });
  });
}

// ---------- 影响面区块（融合设计 §6.5）----------
// 走 IPC graph:impactClosure → reason/impact.js 沿传递谓词做闭包，
// 让用户在实体详情里直接看到「变压器 → 低压配电柜 → 充电桩群 → 20 个车位」这条影响链。
//
// 后端返回两种形态，必须都处理（实测）：
//   usable:true  → 9 字段（含 seed / inferredCount），nodes 为闭包结果
//   usable:false → 8 字段（无 seed / inferredCount，多一个 hint），体系未声明传递谓词
//   ok:false     → { error }，推理模块不可用或节点不存在
// 另外 summary 的措辞对 upstream/both 方向仍写「下游节点」，故此处自建方向感知的摘要。
// 影响面请求序号：用户快速切换实体时，只认最后一次请求的结果
let kgImpactSeq = 0;
async function renderKgImpact(box, id) {
  const list = box.querySelector('[data-sec-impact]');
  const head = box.querySelector('[data-sec-impact-head]');
  if (!list) return;
  if (!window.kb.graphImpactClosure) {
    list.innerHTML = '<div class="gd-desc">（当前环境不支持影响面计算）</div>';
    return;
  }
  const seq = ++kgImpactSeq;
  let r = null;
  try {
    r = await window.kb.graphImpactClosure(id, { direction: 'downstream', maxDepth: 4, maxNodes: 60 });
  } catch (err) {
    if (seq !== kgImpactSeq) return;
    list.innerHTML = `<div class="gd-desc">影响面计算失败：${escapeHtml(String((err && err.message) || err))}</div>`;
    return;
  }
  if (seq !== kgImpactSeq) return;   // 已切到别的实体，丢弃过期结果
  if (!r || r.ok === false) {
    const why = (r && r.error) || '未知原因';
    if (head) head.textContent = '影响面（沿传递谓词下游）';
    list.innerHTML = `<div class="gd-desc">（不可用：${escapeHtml(why)}）</div>`;
    return;
  }
  if (r.usable === false) {
    // 体系没有传递/互逆谓词 → 无法闭包，如实说明而不是显示「无下游影响」
    if (head) head.textContent = '影响面';
    list.innerHTML = `<div class="gd-desc">${escapeHtml(r.hint || '该体系未声明传递谓词，无法做影响面闭包')}</div>`
      + `<div class="kg-impact-hint">体系：${escapeHtml(r.profileName || r.profileId || '')}</div>`;
    return;
  }
  const items = Array.isArray(r.nodes) ? r.nodes : [];
  const infN = Number(r.inferredCount) || 0;
  const maxD = items.reduce((m, x) => Math.max(m, Number(x.depth) || 0), 0);
  if (head) {
    head.innerHTML = `影响面（沿传递谓词下游）<span class="mini-tag">${items.length} 个节点</span>`
      + (infN ? `<span class="mini-tag kg-fact-inferred">⚡${infN} 条经推理</span>` : '')
      + (maxD ? `<span class="mini-tag">最深 L${maxD}</span>` : '');
  }
  if (!items.length) {
    list.innerHTML = '<div class="gd-desc">（无下游影响）</div>';
    return;
  }
  list.innerHTML = items.map((it) => {
    const nm = it.name || graphNodeLabel(it.id);
    const via = it.via ? `经 ${escapeHtml(it.via)}` : '';
    const inf = it.inferred ? '<span class="kg-impact-inf" title="该节点仅通过推理边可达">⚡</span>' : '';
    const pathLen = Array.isArray(it.path) ? it.path.length : 0;
    const tip = pathLen ? `推理深度 L${it.depth} · 路径 ${pathLen} 跳 · 点击下钻` : `推理深度 L${it.depth} · 点击下钻`;
    return `<div class="kg-impact-row" data-id="${escapeHtml(it.id)}" title="${escapeHtml(tip)}">
      <span class="kg-impact-depth">L${Number(it.depth) || 0}</span>
      <span class="kg-impact-name">${inf}${escapeHtml(nm)}</span>
      <span class="kg-impact-via">${via}</span>
    </div>`;
  }).join('');
  // 点击行 → 逐级下钻（复用同一渲染函数）
  list.querySelectorAll('.kg-impact-row[data-id]').forEach((row) => {
    row.addEventListener('click', () => {
      const tid = row.dataset.id;
      if (!tid) return;
      state.kg.entitySel = tid;
      renderKgEntities();
    });
  });
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

  // 视图切换：结构树 / 列表
  const view = state.kg.ontoView || 'tree';
  const treeWrap = $('onto-tree-wrap');
  const listBar = $('onto-list-bar');
  const listBody = $('kg-onto-body');
  document.querySelectorAll('#onto-view-tabs button').forEach((x) => x.classList.toggle('active', x.dataset.ov === view));
  if (treeWrap) treeWrap.hidden = view !== 'tree';
  if (listBar) listBar.hidden = view !== 'list';
  if (listBody) listBody.hidden = view !== 'list';
  // 公理 tab 只读：隐藏「新增」按钮；推理 tab 是观测面板，同样无「新增」
  const btnOntoAdd = $('btn-onto-add');
  if (btnOntoAdd) btnOntoAdd.hidden = view === 'list' && (state.kg.ontoTab === 'axioms' || state.kg.ontoTab === 'reason');
  // 列表视图时同步 Tab 高亮（外部代码直接改 state.kg.ontoTab 后 render 也要生效）
  if (view === 'list') {
    document.querySelectorAll('#kg-onto-tabs button').forEach((x) => x.classList.toggle('active', x.dataset.ot === state.kg.ontoTab));
  }

  // 顶层本体结构树（设计 §7.1）
  if (view === 'tree' && treeWrap && window.renderOntologyTree) {
    treeWrap.innerHTML = '<svg id="onto-tree-svg" role="img" aria-label="本体结构树"></svg>';
    const svg = $('onto-tree-svg');
    const ontoForTree = {
      classes: (o.classes || []).map((c) => ({ key: c.key, label: c.label, desc: c.desc, parent: c.parent || null, custom: !!c.custom })),
    };
    window.renderOntologyTree(svg, ontoForTree, {
      onSelect: (cls) => {
        // 切到列表视图并高亮对应类卡片
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
      },
    });
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
    body.innerHTML = o.predicates.map((p) => `<div class="kg-class"><div class="kg-class-head"><code>${escapeHtml(p.key)}</code><span>${escapeHtml(p.desc)}</span>${acts({ custom: p.custom, data: `data-key="${escapeHtml(p.key)}"` }, p.builtin && !p.custom)}</div></div>`).join('');
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
  } else if (state.kg.ontoTab === 'reason') {
    // 融合设计 §6.6：推理是「可观测子系统」——统计 / 冲突 / 护栏日志 / 谓词特性四区块
    body.innerHTML = '<div class="gd-desc">加载推理状态…</div>';
    await renderKgReasonTab(body, o.profileId);
  }
  renderOntoPrompts(o);
}

// ---------- 「推理」Tab（融合设计 §6.6）----------
// 数据源：IPC graph:reasonState → getReasonState(profileId)，一次拿齐四区块所需的全部字段。
// 注意 lastStats.inconsistencies 是「条数」，明细在 lastStats.inconsistencyDetails.items。
async function renderKgReasonTab(body, profileId) {
  // 静默降级：桥接层没有这个绑定（旧版 preload / web shim 未同步）时如实说明，不抛错
  if (typeof window.kb.graphReasonState !== 'function') {
    body.innerHTML = '<div class="gd-desc">当前环境不支持推理状态查询（缺少 graphReasonState 桥接）。</div>';
    return;
  }
  let rs = null;
  try { rs = await window.kb.graphReasonState(profileId); } catch (err) {
    body.innerHTML = `<div class="gd-desc">推理状态读取失败：${escapeHtml(String((err && err.message) || err))}</div>`;
    return;
  }
  if (!rs || rs.ok === false) {
    body.innerHTML = `<div class="gd-desc">推理状态读取失败：${escapeHtml((rs && rs.error) || '未知错误')}</div>`;
    return;
  }
  const meta = rs.meta || {};
  const ls = meta.lastStats || null;
  const lg = meta.lastGuard || null;
  const counts = rs.counts || { total: 0, inferred: 0, raw: 0, byVia: {} };
  const badge = $('kg-reason-badge');

  // ---- 区块 1：上次推理 ----
  const pct = counts.total ? Math.round((counts.inferred / counts.total) * 100) : 0;
  let runHtml;
  if (!ls) {
    runHtml = '<div class="gd-desc">尚未运行过推理。点击下方「重新推理」对当前图谱做一次 OWL 2 RL 物化。</div>';
  } else if (ls.skipped) {
    runHtml = `<div class="kg-reason-row"><span>上次运行</span><b>${escapeHtml(reasonTimeText(ls.at || meta.lastInferredAt))}</b></div>
      <div class="kg-reason-row"><span>结果</span><b class="kg-reason-warn">已跳过：${escapeHtml(reasonSkipText(ls.skipReason))}</b></div>`;
  } else {
    runHtml = `
      <div class="kg-reason-row"><span>时间</span><b>${escapeHtml(reasonTimeText(ls.at || meta.lastInferredAt))}</b></div>
      <div class="kg-reason-row"><span>推理边</span><b>+${Number(ls.inferredEdges) || 0} 条（占全图 ${pct}%）</b></div>
      <div class="kg-reason-row"><span>轮数</span><b>${Number(ls.rounds) || 0} 轮收敛 · 耗时 ${((Number(ls.elapsedMs) || 0) / 1000).toFixed(1)}s</b></div>
      ${ls.profiles ? `<div class="kg-reason-row"><span>体系</span><b>${Number(ls.profiles) || 0} 个参与推理${ls.skippedProfiles ? ` · ${ls.skippedProfiles} 个跳过` : ''}</b></div>` : ''}
      ${ls.profileId ? `<div class="kg-reason-row"><span>来源</span><b>${escapeHtml(ls.profileId)}</b></div>` : ''}`;
  }
  const staleHtml = meta.inferredStale
    ? '<div class="kg-reason-stale">⚠ 图谱已变更（删除过节点/边），推理结果已过期 —— 下次问答会自动重跑，也可立即手动重推。</div>'
    : '';
  const offHtml = rs.available === false
    ? `<div class="kg-reason-off">推理模块不可用：${escapeHtml(rs.unavailableReason || '未知原因')}（图谱功能不受影响，仅推理相关能力静默降级）</div>`
    : (rs.enabled === false ? '<div class="kg-reason-off">推理已在「设置」中关闭</div>' : '');

  // ---- 区块 2：不一致冲突 ----
  const det = (ls && ls.inconsistencyDetails) || null;
  const conTotal = det ? (Number(det.total) || 0) : (Number(rs.lastInconsistencies) || 0);
  let conHtml;
  if (!conTotal) {
    conHtml = '<div class="gd-desc">未检出语义冲突（不相交类同时归属、非对称谓词双向断言等）。</div>';
  } else if (!det || !det.items || !det.items.length) {
    conHtml = `<div class="gd-desc">检出 ${conTotal} 处冲突，但明细未落库（旧版本推理结果）。点击「重新推理」即可看到明细。</div>`;
  } else {
    conHtml = det.items.map((c, ci) => {
      // 归属：体系「profileName」· 知识图谱「scope.label」（scopes 缺失时退回仅体系，兼容旧数据）
      const scopeText = (c.scopes && c.scopes.length)
        ? c.scopes.map((s) => s.label || s.domain || '通用').join('、')
        : '';
      const owner = `体系「${escapeHtml(c.profileName || c.profileId || '未知')}」${scopeText ? ` · 图谱「${escapeHtml(scopeText)}」` : ''}`;
      // 中文原因：新数据带 messageZh/reasonZh；旧数据只有英文 message → 降级显示原文
      const zh = c.messageZh
        ? `<span class="kg-conflict-zh">${escapeHtml(c.messageZh)}</span>${c.reasonZh ? `<span class="kg-conflict-why">${escapeHtml(c.reasonZh)}</span>` : ''}`
        : `<span class="kg-conflict-zh">${escapeHtml(c.message || '（无描述）')}</span>`;
      // 「修复」按钮：先 dry-run 规划该条冲突的动作，弹窗预览后再落库（冲突自动处理方案2）
      const fixBtn = `<button class="btn btn-ghost kg-conflict-fix" data-cidx="${ci}" title="规划并预览该冲突的修复动作（先预览、确认后才改图）">修复</button>`;
      return `<div class="kg-conflict"><div class="kg-conflict-head"><code class="kg-conflict-rule" title="规则代码">${escapeHtml(c.rule || 'conflict')}</code><span class="kg-conflict-owner">${owner}</span>${fixBtn}</div>${zh}</div>`;
    }).join('')
      + (det.truncated ? `<div class="gd-desc">（仅显示前 ${det.items.length} 条，共 ${conTotal} 处）</div>` : '');
  }
  // 冲突区块头部操作：一键修复（规划全部冲突）+ 撤销上次修复（有快照才可用）
  const conActs = conTotal
    ? `<div class="kg-reason-acts kg-conflict-acts">
        <button class="btn btn-primary" id="btn-reason-repair" title="对全部冲突规划修复动作（降级谓词/删边/改类型），弹窗预览确认后才改图，并自动重推理验证">一键修复</button>
        <button class="btn btn-ghost" id="btn-reason-repair-undo"${rs.repairUndoAvailable ? '' : ' disabled title="没有可撤销的修复记录"'}>撤销上次修复</button>
        ${rs.repairLlm ? '<span class="form-hint" title="设置 → 知识图谱 → 修复时允许 LLM 语义仲裁">LLM 仲裁已开启</span>' : ''}
      </div>`
    : '';

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

  body.innerHTML = `
    ${offHtml}
    <div class="kg-reason-block">
      <div class="kg-reason-head">上次推理</div>
      <div class="kg-reason-row"><span>推理边总数</span><b>${counts.inferred} / ${counts.total} 条（${pct}%）</b></div>
      ${viaHtml ? `<div class="kg-reason-row"><span>推导方式</span><b class="kg-reason-vias">${viaHtml}</b></div>` : ''}
      ${runHtml}
      ${staleHtml}
      <div class="kg-reason-acts">
        <button class="btn btn-primary" id="btn-reason-run"${rs.available === false ? ' disabled title="推理模块不可用"' : ''}>重新推理</button>
        <button class="btn btn-ghost danger" id="btn-reason-clear"${counts.inferred ? '' : ' disabled title="当前没有推理边"'}>清除所有推理边</button>
        <button class="btn btn-ghost" id="btn-reason-validate" title="对已落库的整张图按当前体系重跑约束/公理检查（只读，不改图）">全图校验</button>
        <span class="form-hint" id="reason-run-hint"></span>
      </div>
    </div>
    <div class="kg-reason-block">
      <div class="kg-reason-head">不一致冲突（${conTotal}）</div>
      ${conHtml}
      ${conActs}
    </div>
    <div class="kg-reason-block">
      <div class="kg-reason-head">护栏拦截日志（§4.3 domain/range 越界降级）</div>
      ${guardHtml}
    </div>
    <div class="kg-reason-block">
      <div class="kg-reason-head">谓词特性一览</div>
      ${covHtml}
      ${featHtml}
    </div>
    <div class="kg-reason-block">
      <div class="kg-reason-head">全图校验（通道 C · 只读体检）</div>
      <div id="kg-validate-body"><div class="gd-desc">点击上方「全图校验」对已落库图谱按当前体系做一次只读体检（未知谓词 / domain / range / 不相交归属）。</div></div>
    </div>`;

  // 徽标：冲突数优先（红色告警），否则显示推理边数
  if (badge) {
    if (conTotal) { badge.hidden = false; badge.textContent = String(conTotal); badge.className = 'kg-badge kg-badge-warn'; }
    else if (counts.inferred) { badge.hidden = false; badge.textContent = String(counts.inferred); badge.className = 'kg-badge'; }
    else { badge.hidden = true; badge.textContent = ''; }
  }

  const runBtn = $('btn-reason-run');
  if (runBtn) runBtn.addEventListener('click', async () => {
    await runGraphInference();
    renderKgOntology();
  });
  const clearBtn = $('btn-reason-clear');
  if (clearBtn) clearBtn.addEventListener('click', async () => {
    await clearAllInferredEdges();
    renderKgOntology();
  });
  const valBtn = $('btn-reason-validate');
  if (valBtn) valBtn.addEventListener('click', async () => {
    const box = $('kg-validate-body');
    if (!box) return;
    valBtn.disabled = true;
    box.innerHTML = '<div class="gd-desc">校验中…</div>';
    const v = await runFullGraphValidate(profileId);
    valBtn.disabled = false;
    box.innerHTML = renderValidateReport(v);
    bindValidateFilters(box);
  });
  // 冲突自动修复（方案2/3）：一键修复 = 重推理取最新冲突 → 规划全部 → 预览 → 确认落库
  const repBtn = $('btn-reason-repair');
  if (repBtn) repBtn.addEventListener('click', () => planAndPreviewRepairs({ refresh: true }));
  const undoBtn = $('btn-reason-repair-undo');
  if (undoBtn) undoBtn.addEventListener('click', () => undoLastRepair());
  // 单条冲突的「修复」按钮：只规划该条（data-cidx 是明细列表中的下标）
  document.querySelectorAll('.kg-conflict-fix').forEach((b) => {
    b.addEventListener('click', () => planAndPreviewRepairs({ conflictIdxs: [Number(b.dataset.cidx)] }));
  });
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
  } finally {
    if (btn) btn.disabled = false;
  }
}

// 通道 C 体检报告 → HTML（复用既有 .kg-reason-row / .kg-conflict / .kg-guard-item 样式，不新增 CSS）
function renderValidateReport(v) {
  if (!v || v.ok === false) {
    return `<div class="gd-desc">全图校验不可用：${escapeHtml((v && v.error) || '未知错误')}（图谱数据不受影响）</div>`;
  }
  const cov = v.coverage;
  const covHtml = cov
    ? `<div class="kg-reason-row"><span>体系声明</span><b>${cov.predicates} 个谓词中 ${cov.withAny} 个带 domain/range（覆盖 ${cov.coveragePct}%）· ${cov.disjointPairs.length} 对不相交类</b></div>`
    : '';
  // 计数用全量 totals（按 reason 累加、不受明细上限 VIOLATION_CAP=50 影响）：
  // violations / disjointConflicts 明细数组封顶 50，直接取其长度会在截断时少报
  // （「摘要条 50 条越界边、实际 195」事故，v1.2.2）；旧后端无 totals 时回退明细长度。
  const nV = Number.isFinite(v.totalViolations) ? v.totalViolations : (v.violations || []).length;
  const nD = Number.isFinite(v.totalDisjointConflicts) ? v.totalDisjointConflicts : (v.disjointConflicts || []).length;
  const shownV = (v.violations || []).length;
  const shownD = (v.disjointConflicts || []).length;
  const headHtml = `
    <div class="kg-reason-row"><span>校验范围</span><b>体系「${escapeHtml(v.profileName || v.profileId)}」· 检查 ${v.checked} 条边</b></div>
    <div class="kg-reason-row"><span>结果</span><b class="${(nV || nD) ? 'kg-reason-warn' : ''}">${(nV || nD) ? `发现 ${nV} 条越界边、${nD} 处不相交归属冲突` : '未发现约束违规'}${v.truncated ? `（明细各最多列 ${shownV}/${shownD} 条）` : ''}</b></div>
    ${covHtml}`;
  // v1.2.2：越界边 + 不相交归属**汇成一张问题表**，列含「违反的约束或公理 /
  // 所属体系 / 知识图谱」，并带知识图谱与问题类型两个筛选下拉（客户端过滤）。
  lastValidateReport = v;
  const rows = validateIssueRows(v);
  const scopes = [...new Set(rows.map((r) => r.scope))];
  const nViolationRows = rows.filter((r) => r.kind === 'violation').length;
  const nConflictRows = rows.filter((r) => r.kind === 'conflict').length;
  const tableHtml = rows.length
    ? `<div class="kg-vr-filters">
        <label>知识图谱 <select id="kg-vr-scope"><option value="">全部（${rows.length}）</option>${scopes.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}（${rows.filter((r) => r.scope === s).length}）</option>`).join('')}</select></label>
        <label>问题类型 <select id="kg-vr-kind"><option value="">全部</option><option value="violation">越界边（${nViolationRows}）</option><option value="conflict">不相交归属（${nConflictRows}）</option></select></label>
        <span class="form-hint">${v.truncated ? `明细最多列 ${shownV} 条越界边 / ${shownD} 条不相交；计数为全量` : '问题已全部列出'}</span>
      </div>
      <div class="kg-vr-wrap"><table class="kg-vr-table">
        <thead><tr><th>#</th><th>问题类型</th><th>违规边 / 节点</th><th>违反的约束或公理</th><th>所属体系</th><th>知识图谱</th><th>操作</th></tr></thead>
        <tbody id="kg-vr-tbody">${validateRowsHtml(rows, '', '')}</tbody>
      </table></div>`
    : '<div class="gd-desc">所有边均通过谓词白名单与 domain/range 检查，且未检出不相交归属冲突（覆盖率为 0% 的体系越界项恒通过，属预期）。</div>';
  return `${headHtml}
    <div class="kg-reason-head" style="margin-top:8px">问题汇总（${nV + nD}${rows.length < nV + nD ? `，列出前 ${rows.length} 条` : ''}）</div>
    ${tableHtml}
    <div class="gd-desc">体检为只读：不改写任何边、不删除数据；修复请调整体系公理或删除违规边。校验时间 ${escapeHtml(reasonTimeText(v.at))}。</div>`;
}

// v1.2.2 问题汇总表：把「越界边」与「不相交归属」两类问题归一成同构行数据，
// 每行带 问题类型 / 违规对象 / 违反的约束或公理 / 所属体系 / 知识图谱 五要素。
let lastValidateReport = null;
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
    return `
    <tr>
      <td>${r.idx + 1}</td>
      <td class="kg-vr-kind"><span class="mini-tag ${r.kind === 'conflict' ? 'kg-vr-conflict' : 'kg-vr-violation'}">${escapeHtml(r.kindZh)}</span>${r.inferred ? ' <span class="mini-tag">推理边</span>' : ''}</td>
      <td class="kg-vr-obj">${escapeHtml(r.object)}</td>
      <td>${escapeHtml(r.constraint)}${sub}</td>
      <td>${escapeHtml(r.profile || '—')}</td>
      <td>${escapeHtml(r.scope || '—')}</td>
      <td><button class="btn btn-ghost kg-vr-fix" data-ri="${r.idx}" title="仅针对这一行规划修复动作：预览确认后才改图">修复</button></td>
    </tr>`;
  }).join('');
}

// 筛选下拉 → 重渲染 tbody（数据取最近一次报告，客户端过滤不重跑校验）；
// 行级「修复」按钮用事件委托绑在 box 上（box 跨渲染复用，只绑一次，靠 dataset 标记防重复）
function bindValidateFilters(box) {
  if (!box) return;
  const scopeSel = box.querySelector('#kg-vr-scope');
  const kindSel = box.querySelector('#kg-vr-kind');
  const tbody = box.querySelector('#kg-vr-tbody');
  if (!scopeSel || !kindSel || !tbody || !lastValidateReport) return;
  const rows = validateIssueRows(lastValidateReport);
  const apply = () => { tbody.innerHTML = validateRowsHtml(rows, scopeSel.value, kindSel.value); };
  scopeSel.addEventListener('change', apply);
  kindSel.addEventListener('change', apply);
  if (box.dataset.vrBound) return;
  box.dataset.vrBound = '1';
  box.addEventListener('click', (e) => {
    const b = e.target.closest ? e.target.closest('.kg-vr-fix') : null;
    if (!b || !box.contains(b)) return;
    const all = validateIssueRows(lastValidateReport);
    const row = all[Number(b.dataset.ri)];
    if (!row || !row.src) return;
    // 行级修复：只把这一行的原始问题条目送去规划（dry-run 预览后才落库）
    planAndPreviewRepairs({ issues: [row.src] });
  });
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
  state.kg.ontoView = 'tree'; // 切换体系后回到结构树视图，直观看到层级
  state.kg.ontoCollapsed = {}; // 新体系重置子树折叠状态
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
  // 融合设计 §6.1：推理边用紫色虚线（INFERRED_EDGE），原始边保持灰色实线，
  // 让「哪些关系是 OWL 2 RL 推出来的」在画布上一眼可辨。
  for (const e of graphSim.edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    // 两端按节点半径裁剪，避免线/箭头被节点圆盖住
    if (len <= a.r + b.r + 8) continue;
    const isInferred = !!e.inferred;
    const isHover = graphSim.hover && graphSim.hover.edge === e;
    ctx.strokeStyle = isInferred ? INFERRED_EDGE.stroke : RAW_EDGE.stroke;
    ctx.lineWidth = (isInferred ? INFERRED_EDGE.width : RAW_EDGE.width) + (isHover ? 1.2 : 0);
    if (isInferred) ctx.setLineDash(INFERRED_EDGE.dash);
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
    ctx.setLineDash([]);   // 虚线只作用于连线，箭头必须实心
    // 箭头三角
    const px = -uy, py = ux, hw = al * 0.45;
    ctx.fillStyle = isInferred ? INFERRED_EDGE.arrow : RAW_EDGE.arrow;
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
    // 融合设计 §6.1：推理边的谓词标签加 ⚡ 前缀并染紫色，与画布虚线呼应
    const label = e.inferred ? `${e.rel} ⚡` : e.rel;
    const span = Math.hypot(b.x - a.x, b.y - a.y) - a.r - b.r;
    const w = ctx.measureText(label).width;
    if (span < w + 14) continue; // 两圆之间的空隙装不下这个词，就不画
    // 谓词跟着弧线走：落在弧线中点（而不是直线中点），否则会脱离连线
    const g = edgeBow({ id: a.n.id, x: a.x, y: a.y }, { id: b.n.id, x: b.x, y: b.y }, z);
    const mx = g.mx, my = g.my - 3;
    const rect = rectOf(mx, my, w, 'center');
    if (blocked(rect)) continue;
    placed.push(rect);
    ctx.strokeStyle = 'rgba(245,246,248,0.92)';
    ctx.lineWidth = 3;
    ctx.strokeText(label, mx, my);
    ctx.fillStyle = e.inferred ? INFERRED_EDGE.color : RAW_EDGE.color;
    ctx.fillText(label, mx, my);
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
      const target = graphSim.nodes.find((n) => n.id === el.dataset.node);
      if (target) {
        graphSim.selected = target.id;
        renderGraphDetail(target);
      }
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
  if (state.kg.entitySel === id) state.kg.entitySel = null;
  if (graphSim.selected === id) graphSim.selected = null;
  await refreshGraphAfterMutation();
}

// 删除后统一刷新：重拉图谱（后端已标 inferredStale=true）→ 重绘各视图
async function refreshGraphAfterMutation() {
  await loadGraph();
  renderGraphEmpty();
  renderSidebar();
  if (!state.kg.entitySel) {
    const d = $('kg-edetail');
    if (d) { d.hidden = true; d.innerHTML = ''; }
  } else {
    renderKgEntities();
  }
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
async function runFullGraphValidate(profileId) {
  if (typeof window.kb.graphValidate !== 'function') {
    return { ok: false, error: '当前环境不支持全图校验（缺少 graphValidate 桥接）' };
  }
  try {
    return await window.kb.graphValidate(profileId, {});
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

// 校验结果摘要条：与推理条共用 .graph-reason-bar 容器（同时只显示一条，后写覆盖先写）。
// 展示受检边数、越界边/不相交冲突计数与公理覆盖率；「查看明细」跳本体定义·推理 Tab 并就地展开同一份报告。
function showGraphValidateBar(v, profileId, inferred) {
  const bar = $('graph-reason-bar');
  if (!bar) return;
  const closeBtn = `<button class="icon-btn" id="btn-graph-reasonbar-x" title="关闭">${icoSvg('close', 12)}</button>`;
  const bindClose = () => { const x = $('btn-graph-reasonbar-x'); if (x) x.addEventListener('click', () => { bar.hidden = true; }); };
  if (!v || v.ok === false) {
    bar.innerHTML = `<span class="kg-badge kg-badge-warn">校验失败</span><span>${escapeHtml((v && v.error) || '未知错误')}（图谱数据不受影响）</span>${closeBtn}`;
    bar.hidden = false;
    bindClose();
    return;
  }
  // 全量计数口径同 renderValidateReport：明细数组封顶 50，计数必须用 totals（v1.2.2）
  const nV = Number.isFinite(v.totalViolations) ? v.totalViolations : (v.violations || []).length;
  const nD = Number.isFinite(v.totalDisjointConflicts) ? v.totalDisjointConflicts : (v.disjointConflicts || []).length;
  const cov = v.coverage || {};
  const infHint = inferred && inferred.ok && !inferred.skipped ? `本轮推理 +${inferred.inferredEdges} 边 · ` : '';
  bar.innerHTML = `
    <span class="kg-badge" title="校验只读：用本体约束与公理体检，不改写任何边、不删除数据">✓ 校验（全图·只读）</span>
    <span>体系「${escapeHtml(v.profileName || profileId || v.profileId || '')}」· 检查 <b>${v.checked}</b> 条边</span>
    ${(nV || nD) ? `<span class="kg-reason-conflict">⚠ ${nV} 条越界边 · ${nD} 处不相交冲突</span>` : '<span class="kg-reason-ok">✓ 未发现约束违规</span>'}
    <span class="form-hint">${infHint}公理覆盖 ${cov.coveragePct != null ? cov.coveragePct + '%' : '—'}（${cov.withAny || 0}/${cov.predicates || 0} 谓词声明 domain/range）</span>
    <button class="btn btn-ghost" id="btn-graph-goto-validate">查看明细 →</button>
    ${closeBtn}`;
  bar.hidden = false;
  bindClose();
  const gotoBtn = $('btn-graph-goto-validate');
  if (gotoBtn) gotoBtn.addEventListener('click', async () => {
    // 冲突/校验明细在本体定义·列表视图·推理 Tab；跳转后就地展开同一份报告，省一次点击
    state.kg.ontoView = 'list';
    state.kg.ontoTab = 'reason';
    switchKgTab('ontology');
    for (let i = 0; i < 20 && !$('btn-reason-validate'); i++) await new Promise((r) => setTimeout(r, 100));
    const box = $('kg-validate-body');
    if (box) {
      box.innerHTML = renderValidateReport(v);
      bindValidateFilters(box);
    }
  });
}

// 推理结果摘要条：全图结果 + 当前筛选范围内的命中数（筛选只是视图过滤，推理始终跑全图）
function showGraphReasonBar(r) {
  const bar = $('graph-reason-bar');
  if (!bar) return;
  // 当前筛选范围内的推理边：kgFilteredGraph 已按体系/知识图谱/边类型等条件裁好
  const { edges } = kgFilteredGraph();
  const scopeInferred = countInferredEdges(edges);
  const conN = (r.inconsistencies || []).length;
  const secs = ((r.elapsedMs || 0) / 1000).toFixed(1);
  bar.innerHTML = `
    <span class="kg-badge" title="推理对整个知识库的全局图谱运行，与当前筛选无关">⚡ 上次推理（全图）</span>
    <span>新增推理边 <b>${r.inferredEdges}</b> 条 · ${r.rounds} 轮 · ${secs}s</span>
    ${conN ? `<span class="kg-reason-conflict">⚠ ${conN} 处不一致冲突</span>` : '<span class="kg-reason-ok">✓ 无冲突</span>'}
    <span class="form-hint">当前筛选范围内命中推理边 <b>${scopeInferred}</b> 条</span>
    ${conN ? '<button class="btn btn-ghost" id="btn-graph-goto-conflict">查看冲突 →</button>' : ''}
    <button class="icon-btn" id="btn-graph-reasonbar-x" title="关闭">${icoSvg('close', 12)}</button>`;
  bar.hidden = false;
  $('btn-graph-reasonbar-x').addEventListener('click', () => { bar.hidden = true; });
  const gotoBtn = $('btn-graph-goto-conflict');
  if (gotoBtn) gotoBtn.addEventListener('click', () => {
    // 冲突明细在本体定义·列表视图·推理 Tab
    state.kg.ontoView = 'list';
    state.kg.ontoTab = 'reason';
    switchKgTab('ontology');
  });
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
  // 校验（通道 C 只读体检）：先跑一轮 OWL 2 RL 物化（推理边同样受检），再按当前所选体系的
  // 约束（谓词白名单、domain/range）与公理（不相交等）对整张图谱体检；结果以摘要条持久展示。
  $('btn-graph-validate').addEventListener('click', async () => {
    const profileId = ($('kg-g-profile') || {}).value || '';
    const btn = $('btn-graph-validate');
    btn.disabled = true;
    toast('校验中：先物化推理，再按体系约束与公理体检…', 2500);
    const inferred = await runGraphInference({ noToast: true, noBar: true });
    const v = await runFullGraphValidate(profileId);
    btn.disabled = false;
    showGraphValidateBar(v, profileId, inferred);
    startGraphSim();
    renderGraphLegend();
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
  const profileFilter = $('kg-g-profile');
  if (profileFilter) profileFilter.addEventListener('change', async () => {
    profileFilter.dataset.userSelected = '1';
    // 切换体系后：同步刷新本体缓存（图例/类型下拉/节点配色都读它），避免图例始终停留在旧体系
    try {
      state.kg.onto = await window.kb.graphOntology(profileFilter.value);
    } catch (_) { /* 拉取失败时保留旧本体，图例/下拉维持原状 */ }
    renderGraphTypeFilters();
    renderGraphLegend();
    renderGraphDomainFilter();
    startGraphSim();
  });
  ['kg-g-type', 'kg-g-max', 'kg-g-sort', 'kg-g-domain', 'kg-g-edgekind'].forEach((id) => {
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
        const r = await window.kb.graphImportOwl(body);
        await handleImportResult(r);
      },
    });
  };
  if (btnImportOwl) btnImportOwl.addEventListener('click', async () => {
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
    setHoverEdge(null, 0, 0);   // 开始拖拽/平移时收起 tooltip，避免遮挡
  });
  canvas.addEventListener('mousemove', (ev) => {
    if (!graphSim.drag) {
      // 未按住鼠标：做推理边悬停检测（融合设计 §6.2）。节点优先于边。
      const p = graphPoint(ev);
      if (graphHit(p)) setHoverEdge(null, ev.clientX, ev.clientY);
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
      graphSim.selected = node ? node.id : null;
      renderGraphDetail(node || null);
    }
  });
  canvas.addEventListener('mouseleave', () => { graphSim.drag = null; canvas.classList.remove('dragging'); setHoverEdge(null, 0, 0); });
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

