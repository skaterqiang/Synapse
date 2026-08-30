/**
 * 本体树形可视化（设计 §7.1）— 纯内联 SVG 分层树，无第三方依赖。
 *
 * renderOntologyTree(svgEl, ontology, opts)
 *   svgEl    <svg> 元素
 *   ontology TopOntologyProfile（resolveOntology 结果：{ id, name, classes[], predicates[], source }）
 *   opts     { onSelect(cls), compact }
 *
 * 布局算法：
 *   1. 按 classes[].parent 建树（parent 为 class key；无 parent 或 parent 不在集合中 → 根层）
 *   2. BFS 逐层：每层节点水平均匀分布，父节点居中于其子树跨度之上
 *   3. 直角折线连边（父底边中点 → 子顶边中点）
 * 交互：
 *   - 滚轮缩放 viewBox、拖拽平移
 *   - 悬停节点：高亮祖先链 + 子树
 *   - 点击节点：onSelect(cls)
 */
'use strict';

(function () {
  const NODE_W = 180, NODE_H = 56, H_GAP = 16, V_GAP = 48, PAD = 24;

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
    return { roots, childrenOf, byKey };
  }

  // 后序遍历：计算每个节点子树的叶子跨度（单位：节点宽+间距）
  function layout(classes) {
    const { roots, childrenOf } = buildTree(classes);
    const pos = new Map(); // key -> {x, y, depth, cls}
    let maxDepth = 0;

    function span(cls) {
      const kids = childrenOf.get(cls.key) || [];
      if (!kids.length) return 1;
      return kids.reduce((s, k) => s + span(k), 0);
    }
    function place(cls, depth, leftUnit) {
      maxDepth = Math.max(maxDepth, depth);
      const kids = childrenOf.get(cls.key) || [];
      const mySpan = span(cls);
      const cx = (leftUnit + mySpan / 2) * (NODE_W + H_GAP);
      const y = PAD + depth * (NODE_H + V_GAP);
      pos.set(cls.key, { x: cx - NODE_W / 2, y, depth, cls });
      let off = leftUnit;
      for (const k of kids) { place(k, depth + 1, off); off += span(k); }
    }
    let off = 0;
    for (const r of roots) { place(r, 0, off); off += span(r); }

    const totalW = off * (NODE_W + H_GAP) + PAD * 2;
    const totalH = PAD * 2 + (maxDepth + 1) * (NODE_H + V_GAP);
    return { pos, childrenOf, byKey: new Map(classes.map((c) => [c.key, c])), totalW, totalH };
  }

  function edgePath(p, c) {
    const x1 = p.x + NODE_W / 2, y1 = p.y + NODE_H;
    const x2 = c.x + NODE_W / 2, y2 = c.y;
    const my = (y1 + y2) / 2;
    return `M ${x1} ${y1} L ${x1} ${my} L ${x2} ${my} L ${x2} ${y2}`;
  }

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }

  function renderOntologyTree(svgEl, ontology, opts) {
    opts = opts || {};
    const classes = (ontology && ontology.classes) || [];
    svgEl.innerHTML = '';
    if (!classes.length) {
      svgEl.setAttribute('viewBox', '0 0 400 80');
      svgEl.innerHTML = '<text x="200" y="44" text-anchor="middle" fill="#888" font-size="13">该体系暂无类定义</text>';
      return;
    }
    const { pos, childrenOf, byKey, totalW, totalH } = layout(classes);
    svgEl.setAttribute('viewBox', `0 0 ${totalW} ${totalH}`);
    svgEl.dataset.vb = `0 0 ${totalW} ${totalH}`;

    const NS = 'http://www.w3.org/2000/svg';
    const gEdges = document.createElementNS(NS, 'g');
    const gNodes = document.createElementNS(NS, 'g');
    svgEl.appendChild(gEdges); svgEl.appendChild(gNodes);

    // 边
    for (const [, p] of pos) {
      for (const k of (childrenOf.get(p.cls.key) || [])) {
        const c = pos.get(k.key);
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', edgePath(p, c));
        path.setAttribute('class', 'onto-tree-edge');
        path.dataset.from = p.cls.key; path.dataset.to = k.key;
        gEdges.appendChild(path);
      }
    }

    // 节点
    for (const [, n] of pos) {
      const c = n.cls;
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'onto-tree-node' + (n.depth === 0 ? ' is-root' : ''));
      g.dataset.key = c.key;
      g.setAttribute('transform', `translate(${n.x},${n.y})`);

      const rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('width', NODE_W); rect.setAttribute('height', NODE_H);
      rect.setAttribute('rx', 8);
      if (c.custom) rect.setAttribute('stroke-dasharray', '5 4'); // 用户扩展类：虚线边框
      g.appendChild(rect);

      const t1 = document.createElementNS(NS, 'text');
      t1.setAttribute('x', NODE_W / 2); t1.setAttribute('y', 20);
      t1.setAttribute('text-anchor', 'middle');
      t1.setAttribute('class', n.depth === 0 ? 'onto-tree-lbl-root' : 'onto-tree-lbl');
      t1.textContent = c.label || c.key;
      g.appendChild(t1);

      const t2 = document.createElementNS(NS, 'text');
      t2.setAttribute('x', NODE_W / 2); t2.setAttribute('y', 36);
      t2.setAttribute('text-anchor', 'middle');
      t2.setAttribute('class', 'onto-tree-lbl-en');
      t2.textContent = c.key;
      g.appendChild(t2);

      if (c.desc) {
        const t3 = document.createElementNS(NS, 'text');
        t3.setAttribute('x', NODE_W / 2); t3.setAttribute('y', 50);
        t3.setAttribute('text-anchor', 'middle');
        t3.setAttribute('class', 'onto-tree-lbl-desc');
        t3.textContent = c.desc.length > 14 ? c.desc.slice(0, 14) + '…' : c.desc;
        g.appendChild(t3);
      }

      // 悬停高亮祖先链 + 子树
      g.addEventListener('mouseenter', () => highlight(c.key, true));
      g.addEventListener('mouseleave', () => highlight(c.key, false));
      g.addEventListener('click', () => { if (opts.onSelect) opts.onSelect(c); });
      gNodes.appendChild(g);
    }

    function relatedKeys(key) {
      const set = new Set([key]);
      // 祖先
      let cur = byKey.get(key);
      while (cur && cur.parent && byKey.has(cur.parent)) { set.add(cur.parent); cur = byKey.get(cur.parent); }
      // 子树
      const stack = [key];
      while (stack.length) {
        const k = stack.pop();
        for (const kid of (childrenOf.get(k) || [])) { set.add(kid.key); stack.push(kid.key); }
      }
      return set;
    }
    function highlight(key, on) {
      const keep = on ? relatedKeys(key) : null;
      gNodes.querySelectorAll('.onto-tree-node').forEach((el) => {
        el.style.opacity = !on ? '' : (keep.has(el.dataset.key) ? '1' : '0.18');
      });
      gEdges.querySelectorAll('.onto-tree-edge').forEach((el) => {
        const rel = keep && keep.has(el.dataset.from) && keep.has(el.dataset.to);
        el.style.opacity = !on ? '' : (rel ? '1' : '0.08');
        el.classList.toggle('is-hl', !!(on && rel));
      });
    }

    // 缩放 / 平移
    let vb = { x: 0, y: 0, w: totalW, h: totalH };
    function applyVb() { svgEl.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`); }
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
    svgEl.__resetView = () => { vb = { x: 0, y: 0, w: totalW, h: totalH }; applyVb(); };
  }

  window.renderOntologyTree = renderOntologyTree;
})();
