/**
 * 类层级树面板（仿 Protégé「Class hierarchy」左侧树）— 纯 DOM，无第三方依赖。
 *
 * renderClassHierarchy(container, ontology, opts)
 *   container 容器元素（内部渲染为一棵可展开的树）
 *   ontology  { classes:[{key,label,desc,parent,custom,instances}] }
 *   opts      { onSelect(cls), onHover(cls|null), selectedKey }
 *
 * 与 Protégé 对应关系：
 *   - 左侧树 = Protégé 的 Class hierarchy 面板（owl:Thing 为根的缩进树，节点带圆点图标）
 *   - 内置类 = 实心圆点（●，随体系色）；自定义类 = 空心圆点（○）
 *   - 选中节点高亮（蓝底），与右侧 OWLViz 双向联动
 * 交互：
 *   - 点击行：onSelect(cls)（联动 OWLViz 居中高亮）
 *   - 悬停行：onHover(cls)（联动 OWLViz 祖先链+子树高亮）
 *   - 点击 ▸/▾：展开/收起子树（默认全部展开）
 */
'use strict';

(function () {
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/>/g, '&gt;'); }

  function buildTree(classes) {
    const byKey = new Map(classes.map((c) => [c.key, c]));
    const roots = [];
    const childrenOf = new Map();
    for (const c of classes) {
      const p = c.parent && byKey.has(c.parent) ? c.parent : null;
      if (!p) { roots.push(c); continue; }
      if (!childrenOf.has(p)) childrenOf.set(p, []);
      childrenOf.get(p).push(c);
    }
    // 兄弟按 label 排序（Protégé 默认字母序）
    const sortKids = (arr) => arr.sort((a, b) => String(a.label || a.key).localeCompare(String(b.label || b.key)));
    for (const kids of childrenOf.values()) sortKids(kids);
    sortKids(roots);
    return { roots, childrenOf };
  }

  function renderClassHierarchy(container, ontology, opts) {
    opts = opts || {};
    const classes = (ontology && ontology.classes) || [];
    const collapsed = opts.collapsed || (opts.collapsed = {}); // key -> true（外部传入以持久化折叠态）
    if (!classes.length) {
      container.innerHTML = '<div class="och-empty">该体系暂无类定义</div>';
      return;
    }
    const { roots, childrenOf } = buildTree(classes);

    function nodeHtml(c, depth) {
      const kids = childrenOf.get(c.key) || [];
      const isCollapsed = !!collapsed[c.key];
      const hasKids = kids.length > 0;
      const caret = hasKids
        ? `<span class="och-caret${isCollapsed ? ' is-collapsed' : ''}" data-caret="${esc(c.key)}" title="${isCollapsed ? '展开' : '收起'}"></span>`
        : '<span class="och-caret och-caret-leaf"></span>';
      const dot = `<span class="och-dot${c.custom ? ' is-custom' : ''}"></span>`;
      const cnt = c.instances ? `<span class="och-cnt">${c.instances}</span>` : '';
      const sel = opts.selectedKey === c.key ? ' is-selected' : '';
      let html =
        `<div class="och-row${sel}" style="--d:${depth}" data-key="${esc(c.key)}" title="${esc(c.key)}${c.desc ? '：' + esc(c.desc) : ''}">` +
        caret + dot +
        `<span class="och-lbl">${esc(c.label || c.key)}</span>` + cnt +
        '</div>';
      if (hasKids && !isCollapsed) {
        html += `<div class="och-kids" data-kids-of="${esc(c.key)}">${kids.map((k) => nodeHtml(k, depth + 1)).join('')}</div>`;
      }
      return html;
    }

    container.innerHTML =
      '<div class="och-head"><span class="och-head-title">Class hierarchy</span><span class="och-head-sub">Asserted</span></div>' +
      '<div class="och-tree">' + roots.map((r) => nodeHtml(r, 0)).join('') + '</div>';

    const tree = container.querySelector('.och-tree');
    // 事件委托：展开/收起 + 选中 + 悬停
    tree.addEventListener('click', (e) => {
      const caret = e.target.closest('[data-caret]');
      if (caret) {
        e.stopPropagation();
        const k = caret.dataset.caret;
        collapsed[k] = !collapsed[k];
        renderClassHierarchy(container, ontology, opts); // 重渲（保持折叠态）
        return;
      }
      const row = e.target.closest('.och-row');
      if (row && opts.onSelect) {
        const c = classes.find((x) => x.key === row.dataset.key);
        if (c) opts.onSelect(c);
      }
    });
    tree.addEventListener('mouseover', (e) => {
      const row = e.target.closest('.och-row');
      if (row && opts.onHover) {
        const c = classes.find((x) => x.key === row.dataset.key);
        if (c) opts.onHover(c);
      }
    });
    tree.addEventListener('mouseleave', () => { if (opts.onHover) opts.onHover(null); });
    // 同步选中态高亮
    tree.querySelectorAll('.och-row').forEach((el) => {
      el.classList.toggle('is-selected', el.dataset.key === opts.selectedKey);
    });
  }

  window.renderClassHierarchy = renderClassHierarchy;
})();
