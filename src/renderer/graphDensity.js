'use strict';

// 整体图谱密度策略：独立于 DOM/Canvas，便于在渲染层复用与单测。
(function exposeGraphDensity(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GraphDensity = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const MODE = Object.freeze({ SMART: 'smart', OVERVIEW: 'overview', DETAIL: 'detail' });

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  // 根据节点量、缩放与用户偏好决定“数据仍全量绘制，但展示多少细节”。
  function detailPolicy({ mode = MODE.SMART, nodeCount = 0, zoom = 1 } = {}) {
    const count = Math.max(0, Number(nodeCount) || 0);
    const z = Math.max(0.1, Number(zoom) || 1);
    const overview = mode === MODE.OVERVIEW || (mode === MODE.SMART && count > 200 && z < 1.28);
    const compact = !overview && mode !== MODE.DETAIL && (count > 100 || z < 0.82);

    if (overview) {
      return {
        level: 'overview',
        labelMode: 'hubs',
        hubPerCommunity: z >= 1.08 ? 3 : 2,
        labelBudget: Math.max(8, Math.min(36, Math.ceil(count * 0.1))),
        showEdgeLabels: false,
        showArrows: false,
        edgeOpacity: 0.3,
        description: '概览显示关键节点标签；放大或点击节点查看详情',
      };
    }
    if (compact) {
      return {
        level: 'compact',
        labelMode: 'ranked',
        hubPerCommunity: 3,
        labelBudget: Math.max(18, Math.min(84, Math.ceil(count * (z >= 1.1 ? 0.46 : 0.28)))),
        showEdgeLabels: z >= 1.16,
        showArrows: z >= 0.92,
        edgeOpacity: 0.56,
        description: '优先显示关键节点；放大可显示更多标签',
      };
    }
    return {
      level: 'detail',
      labelMode: 'all',
      hubPerCommunity: 3,
      labelBudget: Number.POSITIVE_INFINITY,
      showEdgeLabels: z >= 0.78,
      showArrows: true,
      edgeOpacity: 0.82,
      description: '详细显示；标签会自动避让',
    };
  }

  // 依据画布宽高生成社区的网格区域，避免宽屏画布仍被压成中心圆团。
  function communityZone(index, count, width, height, padding = 56) {
    const n = Math.max(1, Number(count) || 1);
    const usableW = Math.max(120, (Number(width) || 800) - padding * 2);
    const usableH = Math.max(120, (Number(height) || 600) - padding * 2);
    const columns = clamp(Math.ceil(Math.sqrt(n * usableW / usableH)), 1, n);
    const rows = Math.ceil(n / columns);
    const col = index % columns;
    const row = Math.floor(index / columns);
    const cellW = usableW / columns;
    const cellH = usableH / rows;
    return {
      x: padding + col * cellW,
      y: padding + row * cellH,
      width: cellW,
      height: cellH,
      cx: padding + (col + 0.5) * cellW,
      cy: padding + (row + 0.5) * cellH,
      columns,
      rows,
    };
  }

  // 椭圆布局的有效面积推导出节点目标间距，宽屏会自然使用更多横向空间。
  function layoutMetrics({ width, height, nodeCount, padding = 56 } = {}) {
    const rx = Math.max(80, ((Number(width) || 800) - padding * 2) / 2);
    const ry = Math.max(80, ((Number(height) || 600) - padding * 2) / 2);
    const n = Math.max(1, Number(nodeCount) || 1);
    const areaPerNode = Math.PI * rx * ry / n;
    const spacing = clamp(Math.sqrt(areaPerNode) * 0.72, 26, 96);
    const gap = n > 200 ? 14 : (n > 100 ? 12 : 10);
    const iterations = n > 300 ? 960 : (n > 150 ? 760 : 600);
    return { rx, ry, spacing, gap, iterations };
  }

  return { MODE, detailPolicy, communityZone, layoutMetrics };
});
