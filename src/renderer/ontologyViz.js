/**
 * 本体 OWLViz 风格可视化（仿 Protégé OWLViz 插件）— 纯内联 SVG，无第三方依赖。
 *
 * renderOntologyViz(svgEl, ontology, opts)
 *   svgEl    <svg> 元素
 *   ontology { classes:[{key,label,desc,parent,custom,instances}] }
 *   opts     { onSelect(cls) }
 *
 * 布局算法（横向 is-a 层级，与 OWLViz 一致）：
 *   1. 按 classes[].parent 建树（parent 为 class key；无 parent / parent 不在集合 → 根层）
 *   2. 根在最左，子类向右逐列展开；每列内兄弟节点垂直均匀分布
 *   3. 父节点垂直居中于其直接子节点的跨度之上
 *   4. is-a 边：父右缘 → 子左缘，平滑曲线 + 空心三角箭头指向父（OWL 惯例，读作「子 is-a 父」）
 * 视觉（贴合 Synapse 浅色主题）：
 *   - 节点为圆角椭圆（OWLViz 标志性椭圆），填充随深度取色（GRAPH_PALETTE 同色系柔和梯度）
 *   - 内置类实线边框、自定义类虚线边框；根类加粗高亮
 *   - 双行标签：中文 label + 英文 key；末行小字实例计数
 * 交互：
 *   - 滚轮缩放 viewBox、拖拽平移、双击复位
 *   - 悬停节点：高亮祖先链 + 子树，其余淡出
 *   - 点击节点：onSelect(cls)
 */
'use strict';

(function () {
  // 节点尺寸（椭圆包围盒）。宽度自适应最长文本，超出截断
  const NODE_H = 52, MIN_W = 120, MAX_W = 210, PAD_X = 22;
  const H_GAP = 78, V_GAP = 16, PAD = 30; // 列间距要容纳 is-a 曲线 + 箭头
  const RX = 16;

  // 深度配色（柔和糖果系，与 Synapse 浅色面板协调；同源于知识图谱调色板的色相）
  const DEPTH_FILLS = ['#e8effe', '#e6f7f2', '#f3eefe', '#fdf3e3', '#eef1f4', '#e9f6ec'];
  const DEPTH_STROKES = ['#3370ff', '#0fbfa1', '#7a5af8', '#f5a623', '#8a919f', '#10b981'];

  function buildTree(classes) {
    const byKey = new Map(classes.map((c) => [c.key, c]));
    const roots = [];
    const childrenOf = new Map(); // parentKey -> cls[]
    for (const c of classes) {
      const p = c.parent && byKey.has(c.parent) ? c.parent : null;
      if (!p) { roots.push(c); continue; }
      if (!childrenOf.has(p)) childrenOf.set(p, []);
      childrenOf.get(p).push(c);
    }
    // 兄弟按子树规模升序，视觉上更紧凑；规模相同按 label 稳定排序
    const sizeCache = new Map();
    function size(k) {
      if (sizeCache.has(k.key)) return sizeCache.get(k.key);
      const s = 1 + (childrenOf.get(k.key) || []).reduce((a, x) => a + size(x), 0);
      sizeCache.set(k.key, s);
      return s;
    }
    for (const kids of childrenOf.values()) {
      kids.sort((a, b) => size(a) - size(b) || String(a.label || a.key).localeCompare(String(b.label || b.key)));
    }
    roots.sort((a, b) => size(a) - size(b) || String(a.label || a.key).localeCompare(String(b.label || b.key)));
    return { roots, childrenOf, byKey };
  }

  // 文本宽度估算：中文按 1em、ASCII 按 0.56em；不含真实测量（无 canvas 依赖，够用）
  function estW(s, fontPx) {
    let w = 0;
    for (const ch of String(s)) w += (ch.charCodeAt(0) > 0xff ? 1 : 0.56);
    return w * fontPx;
  }
  function nodeWidth(c) {
    const w1 = estW(c.label || c.key, 12.5);
    const w2 = estW(c.key, 9.5);
    const w3 = c.instances ? estW(`${c.instances} 实例`, 8.5) : 0;
    const w = Math.max(w1, w2, w3) + PAD_X * 2;
    return Math.max(MIN_W, Math.min(MAX_W, w));
  }

  // 横向树布局：列 = 深度；每列内子树块纵向堆叠，父垂直居中于其直接子块
  function layout(classes) {
    const { roots, childrenOf } = buildTree(classes);
    const pos = new Map(); // key -> {x, y, w, depth, cls}
    let maxX = 0, maxDepth = 0;

    function span(cls) { // 子树占用的总高度（含 V_GAP）
      const kids = childrenOf.get(cls.key) || [];
      if (!kids.length) return NODE_H;
      const inner = kids.reduce((s, k) => s + span(k), 0) + V_GAP * (kids.length - 1);
      return Math.max(NODE_H, inner);
    }
    function place(cls, depth, topY) {
      maxDepth = Math.max(maxDepth, depth);
      const kids = childrenOf.get(cls.key) || [];
      const w = nodeWidth(cls);
      const x = PAD + depth * (MAX_W + H_GAP);
      const blockH = span(cls);
      const cy = topY + blockH / 2; // 节点中心 = 其直接子块（或自身）的中点
      pos.set(cls.key, { x, y: cy - NODE_H / 2, w, depth, cls });
      maxX = Math.max(maxX, x + w);
      let off = topY;
      for (const k of kids) { place(k, depth + 1, off); off += span(k) + V_GAP; }
      return blockH;
    }
    let off = PAD;
    for (const r of roots) { const h = place(r, 0, off); off += h + V_GAP; }

    const totalW = maxX + PAD;
    const totalH = off - V_GAP + PAD;
    return { pos, childrenOf, byKey: buildTree(classes).byKey, totalW, totalH, roots };
  }

  // is-a 边：子左缘中点 → 父右缘中点的平滑三次贝塞尔；箭头（空心三角）画在父端，指向父
  function edgePath(parent, child) {
    const x1 = child.x, y1 = child.y + NODE_H / 2;            // 子左缘中点
    const x2 = parent.x + parent.w, y2 = parent.y + NODE_H / 2; // 父右缘中点
    const mx = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
  }

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
  function trunc(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  // 深度聚焦过滤：大本体（如 ogms 187 类）一次全渲会挤成一团，默认只画前 N 级；
  // 有选中时画「选中节点的前 N 级祖先 + 后 N 级子孙」子图。
  //   无 focusKey：保留每个 root 向下 depth ≤ maxDepth 的节点
  //   有 focusKey：保留 focus 向上 up 级祖先（含途经）+ 向下 down 级子孙，并补全祖先的父链到 root 使图连通
  function filterByDepth(classes, focusKey, maxDepth, up, down) {
    const byKey = new Map(classes.map((c) => [c.key, c]));
    const childrenOf = new Map();
    for (const c of classes) {
      const p = c.parent && byKey.has(c.parent) ? c.parent : null;
      if (!p) continue;
      if (!childrenOf.has(p)) childrenOf.set(p, []);
      childrenOf.get(p).push(c);
    }
    const keep = new Set();
    if (focusKey && byKey.has(focusKey)) {
      // 选中：向上收祖先、向下收子孙
      let cur = byKey.get(focusKey), d = 0;
      while (cur && d <= up) { keep.add(cur.key); cur = cur.parent && byKey.get(cur.parent); d++; }
      (function descend(key, dd) {
        if (dd > down) return;
        for (const kid of (childrenOf.get(key) || [])) { keep.add(kid.key); descend(kid.key, dd + 1); }
      })(focusKey, 1);
    } else {
      // 默认：从各 root 向下 maxDepth 级（root 自身 depth 0）
      const roots = classes.filter((c) => !(c.parent && byKey.has(c.parent)));
      for (const r of roots) {
        (function w(c, d) {
          if (d > maxDepth) return;
          keep.add(c.key);
          for (const k of (childrenOf.get(c.key) || [])) w(k, d + 1);
        })(r, 0);
      }
    }
    const out = classes.filter((c) => keep.has(c.key));
    return { classes: out, truncated: out.length < classes.length, total: classes.length, shown: out.length };
  }

  function renderOntologyViz(svgEl, ontology, opts) {
    opts = opts || {};
    const allClasses = (ontology && ontology.classes) || [];
    const MAXD = opts.maxDepth != null ? opts.maxDepth : 3;   // 默认渲染前 3 级
    const UPD = opts.upDepth != null ? opts.upDepth : 3;      // 选中时向上 3 级
    const DOWND = opts.downDepth != null ? opts.downDepth : 3; // 选中时向下 3 级
    const focusKey = opts.focusKey || null;
    const filt = filterByDepth(allClasses, focusKey, MAXD, UPD, DOWND);
    const classes = filt.classes;
    svgEl.innerHTML = '';
    if (!classes.length) {
      svgEl.setAttribute('viewBox', '0 0 400 80');
      svgEl.innerHTML = '<text x="200" y="44" text-anchor="middle" fill="#9ca3af" font-size="13">该体系暂无类定义</text>';
      return;
    }
    const { pos, childrenOf, byKey, totalW, totalH } = layout(classes);
    svgEl.setAttribute('viewBox', `0 0 ${totalW} ${totalH}`);
    svgEl.dataset.vb = `0 0 ${totalW} ${totalH}`;

    const NS = 'http://www.w3.org/2000/svg';
    // 可复用的空心三角箭头 marker（沿路径方向自动旋转，OWLViz 标志性）
    const defs = document.createElementNS(NS, 'defs');
    defs.innerHTML =
      '<marker id="ovz-arrow" markerWidth="10" markerHeight="10" refX="8.4" refY="5" orient="auto" markerUnits="userSpaceOnUse">' +
      '<path d="M 0 0.4 L 9 5 L 0 9.6 Z" class="ovz-arrow-head"/></marker>';
    svgEl.appendChild(defs);
    const gEdges = document.createElementNS(NS, 'g');
    const gLabels = document.createElementNS(NS, 'g');
    const gNodes = document.createElementNS(NS, 'g');
    svgEl.appendChild(gEdges); svgEl.appendChild(gLabels); svgEl.appendChild(gNodes);

    // 边 + is-a 文字标签
    for (const [, c] of pos) {
      const pKey = c.cls.parent;
      if (!pKey || !pos.has(pKey)) continue;
      const p = pos.get(pKey);
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', edgePath(p, c));
      path.setAttribute('class', 'ovz-edge');
      path.setAttribute('marker-end', 'url(#ovz-arrow)');
      path.dataset.from = c.cls.key; path.dataset.to = pKey; // from=子 to=父
      gEdges.appendChild(path);

      // 「is-a」标签放在边中点，跟随列间空隙
      const mx = (c.x + p.x + p.w) / 2, my = (c.y + p.y) / 2 + NODE_H / 2 - 4;
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', mx); t.setAttribute('y', (c.y + NODE_H / 2 + p.y + NODE_H / 2) / 2 - 4);
      t.setAttribute('class', 'ovz-edge-lbl');
      t.textContent = 'is-a';
      t.dataset.from = c.cls.key; t.dataset.to = pKey;
      gLabels.appendChild(t);
    }

    // 节点（椭圆）
    for (const [, n] of pos) {
      const c = n.cls;
      const g = document.createElementNS(NS, 'g');
      const isRoot = !c.parent || !byKey.get(c.parent);
      g.setAttribute('class', 'ovz-node' + (isRoot ? ' is-root' : '') + (c.custom ? ' is-custom' : ''));
      g.dataset.key = c.key;
      g.setAttribute('transform', `translate(${n.x},${n.y})`);

      const cx = n.w / 2, cy = NODE_H / 2;
      const el = document.createElementNS(NS, 'ellipse');
      el.setAttribute('cx', cx); el.setAttribute('cy', cy);
      el.setAttribute('rx', n.w / 2 - 1); el.setAttribute('ry', NODE_H / 2 - 1);
      const di = Math.min(n.depth, DEPTH_FILLS.length - 1);
      el.setAttribute('fill', DEPTH_FILLS[di]);
      el.setAttribute('stroke', DEPTH_STROKES[di]);
      if (c.custom) el.setAttribute('stroke-dasharray', '5 4'); // 自定义类：虚线描边
      g.appendChild(el);

      const textCx = cx;
      const t1 = document.createElementNS(NS, 'text');
      t1.setAttribute('x', textCx); t1.setAttribute('y', cy - (c.instances ? 9 : 6));
      t1.setAttribute('class', 'ovz-lbl');
      t1.textContent = trunc(c.label || c.key, 16);
      g.appendChild(t1);

      const t2 = document.createElementNS(NS, 'text');
      t2.setAttribute('x', textCx); t2.setAttribute('y', cy + (c.instances ? 3 : 8));
      t2.setAttribute('class', 'ovz-lbl-en');
      t2.textContent = trunc(c.key, 24);
      g.appendChild(t2);

      if (c.instances) {
        const t3 = document.createElementNS(NS, 'text');
        t3.setAttribute('x', textCx); t3.setAttribute('y', cy + 15);
        t3.setAttribute('class', 'ovz-lbl-cnt');
        t3.textContent = `${c.instances} 实例`;
        g.appendChild(t3);
      }

      if (c.desc) { const tt = document.createElementNS(NS, 'title'); tt.textContent = c.desc; g.appendChild(tt); }

      g.addEventListener('mouseenter', () => highlight(c.key, true));
      g.addEventListener('mouseleave', () => highlight(c.key, false));
      g.addEventListener('click', () => {
        setSelected(c.key);
        if (opts.onSelect) opts.onSelect(c);
      });
      gNodes.appendChild(g);
    }

    // 选中态：单个节点高亮（其余不淡出，仅描边强调），供左侧 class hierarchy 联动
    let selectedKey = null;
    function setSelected(key) {
      selectedKey = key;
      gNodes.querySelectorAll('.ovz-node').forEach((el) => {
        el.classList.toggle('is-selected', el.dataset.key === key);
      });
    }
    // 截断角标：有节点被深度过滤时，右上角提示「显示 shown/total · 点击节点聚焦」
    if (filt.truncated) {
      const badge = document.createElementNS(NS, 'text');
      badge.setAttribute('x', totalW - PAD); badge.setAttribute('y', 22);
      badge.setAttribute('class', 'ovz-trunc-badge');
      badge.textContent = `深度过滤：显示 ${filt.shown}/${filt.total} 类 · 点击节点聚焦其上下 3 级`;
      gLabels.appendChild(badge);
    }

    // 将某节点平移居中到可视区（不改变缩放级别；若仍在初始全览则就近缩放一档便于聚焦）
    function centerOn(key) {
      const n = pos.get(key);
      if (!n) return;
      const nodeCx = n.x + n.w / 2, nodeCy = n.y + NODE_H / 2;
      vb.x = nodeCx - vb.w / 2;
      vb.y = nodeCy - vb.h / 2;
      applyVb();
    }
    svgEl.__selectNode = (key) => { setSelected(key); centerOn(key); highlight(key, true); };
    svgEl.__clearSelect = () => { selectedKey = null; setSelected(null); highlight(null, false); };
    // 悬停联动（供左侧 class hierarchy 树悬停）：仅高亮，不选中不居中
    svgEl.__hoverNode = (key) => highlight(key, true);
    svgEl.__clearHover = () => highlight(null, false);

    function relatedKeys(key) {
      const set = new Set([key]);
      let cur = byKey.get(key);
      while (cur && cur.parent && byKey.has(cur.parent)) { set.add(cur.parent); cur = byKey.get(cur.parent); }
      const stack = [key];
      while (stack.length) {
        const k = stack.pop();
        for (const kid of (childrenOf.get(k) || [])) { set.add(kid.key); stack.push(kid.key); }
      }
      return set;
    }
    function highlight(key, on) {
      const keep = on ? relatedKeys(key) : null;
      gNodes.querySelectorAll('.ovz-node').forEach((el) => {
        el.style.opacity = !on ? '' : (keep.has(el.dataset.key) ? '1' : '0.16');
      });
      gEdges.querySelectorAll('.ovz-edge').forEach((el) => {
        const rel = keep && keep.has(el.dataset.from) && keep.has(el.dataset.to);
        el.style.opacity = !on ? '' : (rel ? '1' : '0.08');
        el.classList.toggle('is-hl', !!(on && rel));
      });
      gLabels.querySelectorAll('.ovz-edge-lbl').forEach((el) => {
        const rel = keep && keep.has(el.dataset.from) && keep.has(el.dataset.to);
        el.style.opacity = !on ? '' : (rel ? '1' : '0.06');
      });
    }

    // 缩放 / 平移 / 双击复位
    let vb = { x: 0, y: 0, w: totalW, h: totalH };    function applyVb() { svgEl.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`); }
    svgEl.addEventListener('wheel', (e) => {
      e.preventDefault();
      const f = e.deltaY > 0 ? 1.12 : 0.89;
      const pt = svgEl.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
      const m = svgEl.getScreenCTM(); if (!m) return;
      const sp = pt.matrixTransform(m.inverse());
      vb.x = sp.x - (sp.x - vb.x) * f; vb.y = sp.y - (sp.y - vb.y) * f;
      vb.w *= f; vb.h *= f;
      applyVb();
    }, { passive: false });
    let drag = null;
    svgEl.addEventListener('mousedown', (e) => { drag = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y }; });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const rect = svgEl.getBoundingClientRect();
      const sx = vb.w / rect.width, sy = vb.h / rect.height;
      vb.x = drag.vx - (e.clientX - drag.x) * sx;
      vb.y = drag.vy - (e.clientY - drag.y) * sy;
      applyVb();
    });
    window.addEventListener('mouseup', () => { drag = null; });
    svgEl.addEventListener('dblclick', (e) => {
      vb = { x: 0, y: 0, w: totalW, h: totalH }; applyVb();
      // 双击空白处（非节点）→ 通知外部退出聚焦，回到默认前 3 级全览
      if (opts.onBackgroundDblClick && !(e.target && e.target.closest && e.target.closest('.ovz-node'))) opts.onBackgroundDblClick();
    });
    svgEl.__resetView = () => { vb = { x: 0, y: 0, w: totalW, h: totalH }; applyVb(); };
  }

  window.renderOntologyViz = renderOntologyViz;
})();
