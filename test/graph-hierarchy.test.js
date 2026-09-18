'use strict';

const { mkCheck } = require('./helpers/harness');
const {
  ROOT_KEY, UNKNOWN_TYPE, typeKey, entityKey, defaultCollapsedKeys, buildGraphHierarchy,
} = require('../src/renderer/graphHierarchy');

const { check, section, summary } = mkCheck('整体图谱层级树适配');

const ontologyClasses = [
  { key: 'Entity', label: '实体' },
  { key: 'Equipment', label: '设备', parent: 'Entity' },
  { key: 'Transformer', label: '变压器', parent: 'Equipment', desc: '配电设备' },
  { key: 'Process', label: '流程', parent: 'Entity' },
];
const typeDefs = [
  { key: 'Entity', name: '实体', color: '#1d4ed8' },
  { key: 'Equipment', name: '设备', color: '#0891b2' },
  { key: 'Transformer', name: '变压器', color: '#7c3aed' },
  { key: 'Process', name: '流程', color: '#d97706' },
];
const classByKey = (hierarchy) => new Map(hierarchy.classes.map((item) => [item.key, item]));

section('本体类祖先与筛选范围');
const filtered = buildGraphHierarchy({
  nodes: [{ id: 't-1', name: '主变压器', type: 'Transformer', desc: '110kV' }],
  ontologyClasses,
  typeDefs,
});
const filteredByKey = classByKey(filtered);
check('根节点统计当前过滤实体数', filteredByKey.get(ROOT_KEY).instances === 1);
check('有实体的类型保留直接父级与祖先',
  filteredByKey.has(typeKey('Transformer')) && filteredByKey.has(typeKey('Equipment')) && filteredByKey.has(typeKey('Entity')));
check('祖先按本体 parent 链连接到图谱根',
  filteredByKey.get(typeKey('Transformer')).parent === typeKey('Equipment')
  && filteredByKey.get(typeKey('Equipment')).parent === typeKey('Entity')
  && filteredByKey.get(typeKey('Entity')).parent === ROOT_KEY);
check('实体作为所属类型的叶子且保留类型颜色',
  filteredByKey.get(entityKey('t-1')).parent === typeKey('Transformer')
  && filteredByKey.get(entityKey('t-1')).dotColor === '#7c3aed');
check('当前过滤范围不混入未命中的类型', !filteredByKey.has(typeKey('Process')));

section('未知类型与实体标识');
const unknown = buildGraphHierarchy({
  nodes: [
    { id: 'external-1', name: '外部实体', type: 'External' },
    { id: 'named-a', name: '同名实体', type: 'Transformer' },
    { id: 'named-b', name: '同名实体', type: 'Transformer' },
  ],
  ontologyClasses,
  typeDefs,
});
const unknownByKey = classByKey(unknown);
check('未知类型回退到未分类根类',
  unknownByKey.get(typeKey(UNKNOWN_TYPE)).label === '未分类'
  && unknownByKey.get(typeKey(UNKNOWN_TYPE)).parent === ROOT_KEY
  && unknownByKey.get(entityKey('external-1')).parent === typeKey(UNKNOWN_TYPE));
check('同名实体根据 id 生成唯一树 key',
  unknown.entityToKey.get('named-a') !== unknown.entityToKey.get('named-b')
  && unknown.entityToKey.get('named-a') === entityKey('named-a'));

section('异常本体父级容错');
const cyclic = buildGraphHierarchy({
  nodes: [{ id: 'a-1', name: '循环类实体', type: 'A' }],
  ontologyClasses: [
    { key: 'A', label: 'A', parent: 'B' },
    { key: 'B', label: 'B', parent: 'A' },
  ],
  typeDefs: [{ key: 'A', name: 'A', color: '#2563eb' }, { key: 'B', name: 'B', color: '#16a34a' }],
});
const cyclicByKey = classByKey(cyclic);
check('循环父级安全回退到根节点',
  cyclicByKey.get(typeKey('A')).parent === ROOT_KEY && cyclicByKey.get(typeKey('B')).parent === ROOT_KEY);
check('循环本体仍能定位实体与祖先映射',
  cyclic.entityToKey.get('a-1') === entityKey('a-1')
  && cyclic.parentByKey.get(entityKey('a-1')) === typeKey('A'));

section('默认展开层级');
const expandable = buildGraphHierarchy({
  nodes: [
    { id: 'leaf-1', name: '深层实体', type: 'Leaf' },
    { id: 'terminal-1', name: '终端实体', type: 'Terminal' },
  ],
  ontologyClasses: [
    { key: 'Top', label: '顶层' },
    { key: 'Middle', label: '第二层', parent: 'Top' },
    { key: 'Branch', label: '第三层分支', parent: 'Middle' },
    { key: 'Leaf', label: '第四层', parent: 'Branch' },
    { key: 'Terminal', label: '第三层叶类', parent: 'Middle' },
  ],
});
const defaultCollapsed = defaultCollapsedKeys(expandable.classes);
check('第三层仍含子类型时默认收起', defaultCollapsed.has(typeKey('Branch')));
check('第三层仅含实体叶子时也默认收起', defaultCollapsed.has(typeKey('Terminal')));
check('前两层类型保持默认展开',
  !defaultCollapsed.has(typeKey('Top')) && !defaultCollapsed.has(typeKey('Middle')));

summary();
