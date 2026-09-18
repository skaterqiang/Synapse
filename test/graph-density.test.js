'use strict';

const { mkCheck } = require('./helpers/harness');
const { MODE, detailPolicy, communityZone, layoutMetrics } = require('../src/renderer/graphDensity');

const { check, section, summary } = mkCheck('整体图谱密度策略');

section('细节层次');
const small = detailPolicy({ mode: MODE.SMART, nodeCount: 80, zoom: 1 });
check('少量节点智能模式使用详细展示', small.level === 'detail' && small.labelMode === 'all' && small.showEdgeLabels);

const dense = detailPolicy({ mode: MODE.SMART, nodeCount: 382, zoom: 1 });
check('382 节点智能模式进入概览但保留标签预算', dense.level === 'overview' && dense.labelMode === 'hubs' && dense.labelBudget > 0 && !dense.showEdgeLabels);

const zoomed = detailPolicy({ mode: MODE.SMART, nodeCount: 382, zoom: 1.35 });
check('大图放大后自动恢复紧凑细节', zoomed.level === 'compact' && zoomed.labelMode === 'ranked' && zoomed.showEdgeLabels);

const overview = detailPolicy({ mode: MODE.OVERVIEW, nodeCount: 50, zoom: 3 });
check('用户指定概览始终收起普通边细节', overview.level === 'overview' && !overview.showArrows && !overview.showEdgeLabels);

const detail = detailPolicy({ mode: MODE.DETAIL, nodeCount: 500, zoom: 0.5 });
check('用户指定详细模式允许尝试全部标签', detail.level === 'detail' && detail.labelMode === 'all' && detail.labelBudget === Infinity);

section('宽屏布局');
const zone0 = communityZone(0, 4, 1600, 600);
const zone3 = communityZone(3, 4, 1600, 600);
check('社区区域按宽屏比例分栏', zone0.columns === 4 && zone0.rows === 1 && zone3.cx > zone0.cx);
check('不同社区区域不重叠', zone0.x + zone0.width <= zone3.x || zone3.x + zone3.width <= zone0.x || zone0.y + zone0.height <= zone3.y || zone3.y + zone3.height <= zone0.y);

const wide = layoutMetrics({ width: 1600, height: 600, nodeCount: 382 });
const square = layoutMetrics({ width: 600, height: 600, nodeCount: 382 });
check('宽屏布局使用更大的有效横向半径', wide.rx > square.rx && wide.spacing > square.spacing);
check('高密度图谱提高碰撞间隙和预收敛次数', wide.gap === 14 && wide.iterations === 960);

summary();
