'use strict';

// 图谱层级树适配：将“本体类层级 + 当前图谱实体”转换为 Class hierarchy 组件的数据形态。
(function exposeGraphHierarchy(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GraphHierarchy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const ROOT_KEY = 'graph:root';
  const UNKNOWN_TYPE = '__unknown__';
  const typeKey = (key) => `graph:type:${key}`;
  const entityKey = (id) => `graph:entity:${id}`;

  function asText(value, fallback = '') {
    const text = String(value == null ? '' : value).trim();
    return text || fallback;
  }

  // 默认只展示三层：第三层只要存在任意子节点（子类型或实体叶子）即收起。
  function defaultCollapsedKeys(classes = [], { rootKey = ROOT_KEY, collapseFromTypeDepth = 2 } = {}) {
    const items = Array.isArray(classes) ? classes.filter((item) => item && item.key) : [];
    const byKey = new Map(items.map((item) => [item.key, item]));
    const childCount = new Map();
    for (const item of items) {
      if (!item.parent) continue;
      childCount.set(item.parent, (childCount.get(item.parent) || 0) + 1);
    }
    const depthCache = new Map([[rootKey, -1]]);
    const depthOf = (key, seen = new Set()) => {
      if (depthCache.has(key)) return depthCache.get(key);
      if (seen.has(key)) return 0;
      const item = byKey.get(key);
      if (!item || !item.parent || !byKey.has(item.parent)) return 0;
      const nextSeen = new Set(seen);
      nextSeen.add(key);
      const depth = depthOf(item.parent, nextSeen) + 1;
      depthCache.set(key, depth);
      return depth;
    };
    const collapsed = new Set();
    for (const item of items) {
      if ((item.meta || {}).kind !== 'type') continue;
      if (depthOf(item.key) >= collapseFromTypeDepth && childCount.get(item.key)) collapsed.add(item.key);
    }
    return collapsed;
  }

  function buildGraphHierarchy({ nodes = [], ontologyClasses = [], typeDefs = [] } = {}) {
    const sourceNodes = Array.isArray(nodes) ? nodes.filter((node) => node && node.id != null) : [];
    const classByKey = new Map((Array.isArray(ontologyClasses) ? ontologyClasses : [])
      .filter((cls) => cls && cls.key)
      .map((cls) => [String(cls.key), cls]));
    const typeDefByKey = new Map((Array.isArray(typeDefs) ? typeDefs : [])
      .filter((type) => type && type.key)
      .map((type) => [String(type.key), type]));
    const nodeType = (node) => {
      const key = asText(node.type);
      return key && (classByKey.has(key) || typeDefByKey.has(key)) ? key : UNKNOWN_TYPE;
    };
    const directCount = new Map();
    for (const node of sourceNodes) {
      const key = nodeType(node);
      directCount.set(key, (directCount.get(key) || 0) + 1);
    }

    // 为每个有实体的类型补齐祖先；父级循环时安全切断到根，绝不构造环形树。
    const includedTypes = new Set([UNKNOWN_TYPE]);
    const includeAncestors = (start) => {
      let key = start;
      const seen = new Set();
      while (key && key !== UNKNOWN_TYPE && !seen.has(key)) {
        seen.add(key);
        includedTypes.add(key);
        const cls = classByKey.get(key);
        const parent = cls && asText(cls.parent);
        key = parent && classByKey.has(parent) ? parent : '';
      }
    };
    for (const key of directCount.keys()) if (key !== UNKNOWN_TYPE) includeAncestors(key);

    const safeParent = (key) => {
      if (key === UNKNOWN_TYPE) return ROOT_KEY;
      const cls = classByKey.get(key);
      const parent = cls && asText(cls.parent);
      if (!parent || !includedTypes.has(parent)) return ROOT_KEY;
      const seen = new Set([key]);
      let current = parent;
      while (current) {
        if (seen.has(current)) return ROOT_KEY;
        seen.add(current);
        const currentCls = classByKey.get(current);
        const next = currentCls && asText(currentCls.parent);
        current = next && classByKey.has(next) ? next : '';
      }
      return typeKey(parent);
    };

    const classes = [{
      key: ROOT_KEY,
      label: '当前图谱',
      desc: `当前范围共 ${sourceNodes.length} 个实体`,
      instances: sourceNodes.length,
      meta: { kind: 'root' },
    }];
    const typeItems = [...includedTypes]
      .filter((key) => key !== UNKNOWN_TYPE || directCount.has(UNKNOWN_TYPE))
      .map((key) => {
        const cls = classByKey.get(key);
        const type = typeDefByKey.get(key);
        return {
          key: typeKey(key),
          label: key === UNKNOWN_TYPE ? '未分类' : asText((cls || type || {}).label || (type || {}).name, key),
          desc: key === UNKNOWN_TYPE ? '未在当前本体体系中定义的实体类型' : asText((cls || {}).desc),
          parent: safeParent(key),
          instances: directCount.get(key) || 0,
          dotColor: key === UNKNOWN_TYPE ? '#8a919f' : (type || {}).color,
          meta: { kind: 'type', type: key },
        };
      });
    classes.push(...typeItems);

    const entityToKey = new Map();
    const parentByKey = new Map(classes.map((item) => [item.key, item.parent || null]));
    for (const node of sourceNodes) {
      const type = nodeType(node);
      const key = entityKey(node.id);
      entityToKey.set(String(node.id), key);
      parentByKey.set(key, typeKey(type));
      classes.push({
        key,
        label: asText(node.name, String(node.id)),
        desc: asText(node.desc),
        parent: typeKey(type),
        dotColor: type === UNKNOWN_TYPE ? '#8a919f' : (typeDefByKey.get(type) || {}).color,
        meta: { kind: 'entity', entityId: String(node.id), type },
      });
    }
    return { classes, rootKey: ROOT_KEY, entityToKey, parentByKey };
  }

  return { ROOT_KEY, UNKNOWN_TYPE, typeKey, entityKey, defaultCollapsedKeys, buildGraphHierarchy };
});
