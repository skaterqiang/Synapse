'use strict';

// ---------------------------------------------------------------------------
// reason/repair.js — 语义冲突的**修复规划器**（纯函数，不碰数据库）
//
// 定位：推理器（infer.js）只负责「发现矛盾」，validate.js 只负责「只读体检」，
//       本模块负责回答「要消除这条矛盾，具体该动哪条边/哪个节点」。
//
// 设计约束（与既有实现保持一致，勿破坏）：
//  1. **纯函数**：输入 (conflicts, graph, profile) → 输出动作列表；不落库、不调 LLM。
//     落库由 graph.js applyRepairs 负责，LLM 仲裁由 graph.js 注入 opts.arbitrate 回调。
//  2. **不臆造约束**：所有判定都走 guard.constraintOf / guard.checkDisjoint，
//     体系没声明 domain/range/disjoint 时一律不产生动作（与 validate.js 同口径）。
//  3. **最小破坏优先**：能降级谓词就不删边，能删一条边就不改节点类型。
//     降级到 fallbackRel 与抽取阶段护栏（graph.js extractGraph）的处置完全一致，
//     用户不会看到「同一类问题两处修法不同」。
//  4. **可解释**：每个动作都带 actionZh（中文说明），UI 直接展示，不需要二次翻译。
//
// ⚠️ 现实前提（已核实 bridge.graphToTriples）：Synapse 节点只有**一个** type 字段，
//    个体层面不可能「同时声明两个类」。因此 cax-dw / cax-adc / cls-com 这类
//    「同属互斥类」的冲突，真正的诱因**永远是某条边**——prp-dom / prp-rng 会把
//    端点强制归入 domain(rel) / range(rel)，与节点声明类型撞上不相交公理。
//    所以修复的第一动作是「找到那条诱导边」，而不是「改节点类型」。
// ---------------------------------------------------------------------------

const guard = require('./guard');
const { PREFIX_REL, dec } = require('./bridge');

// 边身份键：与 graph.js / bridge.edgeKey 完全一致（from|to|rel）
const keyOf = (from, to, rel) => `${from}|${to}|${rel}`;

/**
 * 从冲突的 raw 消息里提取谓词 key（IRI 形如 https://synapse.local/rel/<enc>）。
 * bridge.conflictNodeIds 只提节点，这里补提谓词，供 prp-* 类规则定位具体边。
 * 解析不到时返回空数组——调用方必须能退化到「按端点枚举候选边」。
 */
function conflictRelKeys(c) {
  const raw = String((c && c.raw) || (c && c.message) || '');
  if (!raw) return [];
  const out = [];
  // ⚠️ 字符串里的 \\s / \\] 必须是双反斜杠（与 bridge.conflictNodeIds 同款写法），
  //    单反斜杠会被 JS 字符串字面量吞掉，正则将永远匹配不到。
  const re = new RegExp(PREFIX_REL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^\\s&"\'`,;)\\]]+)', 'g');
  let m;
  while ((m = re.exec(raw))) {
    const k = dec(m[1]);
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

/** 该谓词在本体系下是否**完全无约束**（无 domain/range）——降级到它才能真正消除冲突。 */
function isUnconstrained(profile, rel) {
  if (!rel) return false;
  try { return !guard.constraintOf(profile, rel).hasAny; } catch (_) { return false; }
}

/**
 * 找「诱导边」：node 参与的边里，哪条边的 domain/range 会把 node 强制归入
 * 与其声明类型互斥的类。逻辑与 validate.js 的 disjointConflicts 完全同源，
 * 保证「校验报出来的」与「修复能定位到的」是同一批边。
 *
 * @returns {Array<{edge:object, via:'domain'|'range', forcedType:string, detail:string}>}
 */
function findInducingEdges(node, edges, profile) {
  const out = [];
  if (!node || !node.type) return out;
  for (const e of edges || []) {
    if (!e || !e.from || !e.to) continue;
    const asFrom = e.from === node.id;
    const asTo = e.to === node.id;
    if (!asFrom && !asTo) continue;
    // 与推理器同口径：强制类型既来自 rel 自身的 domain/range，也来自其逆谓词
    // 物化出的反向边（见 guard.forcingProbes）。只看直连约束会漏掉
    // 「bearer_of 无约束、但其逆 inheres_in 的 domain 强制终点类型」这类真实冲突，
    // 导致误判为「没有边在强制它 → 需人工」。
    let probes = [];
    try { probes = guard.forcingProbes(profile, e.rel); } catch (_) { probes = []; }
    for (const p of probes) {
      if (p.node === 'from' && !asFrom) continue;
      if (p.node === 'to' && !asTo) continue;
      for (const f of p.forced) {
        let d = null;
        try { d = guard.checkDisjoint(profile, node.type, f); } catch (_) { d = null; }
        if (!d || !d.conflict) continue;
        out.push({ edge: e, via: p.via, forcedType: f, detail: d.detail || '', inverseRel: p.inverse ? p.rel : '' });
      }
    }
  }
  return out;
}

/** 两个类型的最近公共祖先（沿 profile.classes[].parent + SubClassOf 公理上溯）。找不到返回 ''。 */
function lca(profile, typeA, typeB) {
  if (!typeA || !typeB) return '';
  if (typeA === typeB) return typeA;
  let ancA = null, ancB = null;
  try {
    // guard 未直接导出 ancestorsOf，用 isSubClassOf 反查候选祖先：
    // 遍历体系类表，取「同时是 A 与 B 的祖先」中层级最深的那个。
    const m = guard.constraintOf(profile, '__probe__'); // 触发 modelOf 缓存（无副作用）
    void m;
  } catch (_) { /* 忽略 */ }
  const classes = (profile && profile.classes) || [];
  // 收集 A/B 的祖先集合（含自身）
  const ancOf = (t) => {
    const s = new Set([t]);
    let changed = true;
    let guardLoop = 0;
    while (changed && guardLoop++ < 64) {
      changed = false;
      for (const c of classes) {
        if (!c || !c.key || !c.parent) continue;
        if (s.has(c.key) && !s.has(c.parent)) { s.add(c.parent); changed = true; }
      }
      for (const ax of (profile && profile.axioms) || []) {
        if (!ax || ax.type !== 'SubClassOf' || !ax.subject || !ax.object) continue;
        if (s.has(ax.subject) && !s.has(ax.object)) { s.add(ax.object); changed = true; }
      }
    }
    return s;
  };
  ancA = ancOf(typeA); ancB = ancOf(typeB);
  let best = '', bestDepth = -1;
  const depthOf = (t) => {
    let d = 0, cur = t, seen = new Set([cur]);
    let changed = true;
    while (changed && d < 64) {
      changed = false;
      for (const c of classes) {
        if (c && c.key === cur && c.parent && !seen.has(c.parent)) { seen.add(c.parent); cur = c.parent; d++; changed = true; break; }
      }
    }
    return d;
  };
  for (const t of ancA) {
    if (!ancB.has(t)) continue;
    const d = depthOf(t);
    if (d > bestDepth) { bestDepth = d; best = t; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 单条冲突 → 动作
// ---------------------------------------------------------------------------

/**
 * @param {object} c        enrichConflicts 产出的冲突（含 rule/message/raw/nodeIds/nodeNames）
 * @param {object} graph    { nodes, edges }（edges 只需原始边，推理边由调用方过滤）
 * @param {object} profile  已 resolveOntology 的体系
 * @param {object} [opts]
 * @param {(q:object)=>Promise<string>} [opts.arbitrate]  LLM 语义仲裁回调（方案3）；
 *        传入时对「改类型 vs 降级谓词」这类有多解的冲突征询模型，失败自动退回确定性规则。
 * @returns {Promise<Array<object>>} 动作列表（可能为空 = 无可自动修复方案）
 */
async function planOne(c, graph, profile, opts = {}) {
  const rule = String((c && c.rule) || '');
  const ids = Array.isArray(c && c.nodeIds) ? c.nodeIds : [];
  const rels = conflictRelKeys(c);
  const nodes = (graph && graph.nodes) || [];
  const edges = ((graph && graph.edges) || []).filter((e) => e && !e.inferred);
  const byId = new Map(nodes.map((n) => [n && n.id, n]));
  const nameOf = (id) => (byId.get(id) || {}).name || id;
  const labelOfRel = (rel) => guard.labelOfRel(profile, rel) || rel;
  const fbRel = (profile && profile.fallbackRel) || '';
  const fbRelZh = labelOfRel(fbRel);
  const out = [];
  const push = (a) => out.push(Object.assign({ rule, auto: true, viaLlm: false }, a));

  // 找边：优先按 (from,to,rel) 精确匹配，其次按端点 + 谓词集合，最后按端点枚举
  const findEdges = (a, b, relList) => {
    const hit = [];
    for (const e of edges) {
      const ends = (e.from === a && e.to === b);
      if (!ends) continue;
      if (relList && relList.length && !relList.includes(e.rel)) continue;
      hit.push(e);
    }
    return hit;
  };

  switch (rule) {
    // ---- A 类：类型归属矛盾（诱因永远是边的 domain/range 强制） ----
    case 'cax-dw':
    case 'cax-adc':
    case 'cls-com':
    case 'cls-nothing2': {
      for (const id of ids) {
        const node = byId.get(id);
        if (!node) continue;
        const inducing = findInducingEdges(node, edges, profile);
        if (!inducing.length) {
          // 找不到诱导边 = 声明类型本身就落在互斥类里（体系公理层面的问题），
          // 改数据无法修复，必须人工裁定或放宽本体。
          push({
            kind: 'manual', auto: false, nodeId: id, nodeName: node.name || id,
            actionZh: `「${node.name || id}」的类型「${node.type}」本身落入互斥类，且没有边在强制它——需人工改类型或放宽本体公理`,
          });
          continue;
        }
        for (const ind of inducing) {
          const e = ind.edge;
          const ek = keyOf(e.from, e.to, e.rel);
          // 强制来源描述：直连约束 or 逆谓词物化（推理会补出反向边，降级/删除本边即可消除）
          const viaZh = ind.via === 'domain' ? '定义域' : '值域';
          const srcZh = ind.inverseRel ? `其逆谓词「${ind.inverseRel}」的${viaZh}` : `该谓词的${viaZh}`;
          // 首选：把谓词降级为无约束的回退谓词（保住这条联系，与抽取护栏同口径）
          if (fbRel && fbRel !== e.rel && isUnconstrained(profile, fbRel)) {
            push({
              kind: 'change-rel', edgeKey: ek, from: e.from, to: e.to, rel: e.rel, newRel: fbRel,
              fromName: nameOf(e.from), toName: nameOf(e.to),
              nodeId: id, nodeName: node.name || id, declaredType: node.type,
              forcedType: ind.forcedType, via: ind.via, inverseRel: ind.inverseRel || '',
              actionZh: `把「${nameOf(e.from)}」—${e.rel}→「${nameOf(e.to)}」的关系降级为「${fbRelZh}」`
                + `（${srcZh}会把「${node.name || id}」强制归入「${ind.forcedType}」，与其声明类型「${node.type}」互斥${ind.inverseRel ? '；该强制来自推理物化的逆边' : ''}）`,
              altActionZh: `或删除这条边`,
            });
          } else {
            // 回退谓词也带约束（少见）→ 只能删边
            push({
              kind: 'delete-edge', edgeKey: ek, from: e.from, to: e.to, rel: e.rel,
              fromName: nameOf(e.from), toName: nameOf(e.to),
              nodeId: id, nodeName: node.name || id, declaredType: node.type,
              forcedType: ind.forcedType, via: ind.via, inverseRel: ind.inverseRel || '',
              actionZh: `删除「${nameOf(e.from)}」—${e.rel}→「${nameOf(e.to)}」这条边`
                + `（${srcZh}约束把「${node.name || id}」强制归入互斥类「${ind.forcedType}」，且本体系没有可降级的无约束谓词）`,
            });
          }
        }
      }
      break;
    }

    // ---- B 类：边结构矛盾 ----
    case 'prp-irp': {
      // 反自反谓词出现自环：删除该自环边
      const id = ids[0];
      const cands = edges.filter((e) => e.from === e.to && (!rels.length || rels.includes(e.rel)) && (!id || e.from === id));
      if (!cands.length) {
        push({ kind: 'manual', auto: false, actionZh: '未能在图谱中定位这条自环边（可能已被删除），请重新推理' });
        break;
      }
      for (const e of cands) {
        push({
          kind: 'delete-edge', edgeKey: keyOf(e.from, e.to, e.rel), from: e.from, to: e.to, rel: e.rel,
          fromName: nameOf(e.from), toName: nameOf(e.to),
          actionZh: `删除自环边「${nameOf(e.from)}」—${e.rel}→ 自身（「${e.rel}」被声明为反自反谓词，任何个体都不能与自身建立该关系）`,
        });
      }
      break;
    }

    case 'prp-asyp': {
      // 非对称谓词双向断言：保留先出现的一条，删除反向
      const [a, b] = ids;
      if (!a || !b) { push({ kind: 'manual', auto: false, actionZh: '冲突消息未解析出两端节点，无法自动定位边' }); break; }
      const fwd = findEdges(a, b, rels);
      const rev = findEdges(b, a, rels);
      if (!fwd.length || !rev.length) {
        push({ kind: 'manual', auto: false, actionZh: `未能在「${nameOf(a)}」与「${nameOf(b)}」之间同时找到正反两条边（可能已被删除），请重新推理` });
        break;
      }
      const drop = rev[0];
      push({
        kind: 'delete-edge', edgeKey: keyOf(drop.from, drop.to, drop.rel), from: drop.from, to: drop.to, rel: drop.rel,
        fromName: nameOf(drop.from), toName: nameOf(drop.to),
        actionZh: `删除反向边「${nameOf(drop.from)}」—${drop.rel}→「${nameOf(drop.to)}」，保留「${nameOf(fwd[0].from)}」—${fwd[0].rel}→「${nameOf(fwd[0].to)}」`
          + `（「${drop.rel}」是非对称谓词，A→B 成立则 B→A 必不成立）`,
      });
      break;
    }

    case 'prp-pdw':
    case 'prp-adp': {
      // 互斥谓词连同一对个体：保留第一条，删除其余
      const [a, b] = ids;
      if (!a || !b) { push({ kind: 'manual', auto: false, actionZh: '冲突消息未解析出两端节点，无法自动定位边' }); break; }
      const hit = findEdges(a, b, rels.length ? rels : null);
      if (hit.length < 2) {
        push({ kind: 'manual', auto: false, actionZh: `「${nameOf(a)}」→「${nameOf(b)}」之间未找到 2 条以上互斥谓词边（可能已被删除），请重新推理` });
        break;
      }
      for (const e of hit.slice(1)) {
        push({
          kind: 'delete-edge', edgeKey: keyOf(e.from, e.to, e.rel), from: e.from, to: e.to, rel: e.rel,
          fromName: nameOf(e.from), toName: nameOf(e.to),
          actionZh: `删除多余边「${nameOf(e.from)}」—${e.rel}→「${nameOf(e.to)}」，保留「${hit[0].rel}」（这两个谓词被声明为互斥，同一对个体之间只能出现其中之一）`,
        });
      }
      break;
    }

    case 'prp-npa1': {
      // 负断言：删除被明确禁止的那条边
      const [a, b] = [ids[0], ids[ids.length - 1]];
      const hit = findEdges(a, b, rels.length ? rels : null);
      if (!hit.length) { push({ kind: 'manual', auto: false, actionZh: '未能定位违反负断言的边（可能是推理边，重新推理即可消失）' }); break; }
      for (const e of hit) {
        push({
          kind: 'delete-edge', edgeKey: keyOf(e.from, e.to, e.rel), from: e.from, to: e.to, rel: e.rel,
          fromName: nameOf(e.from), toName: nameOf(e.to),
          actionZh: `删除「${nameOf(e.from)}」—${e.rel}→「${nameOf(e.to)}」（本体明确声明这两个个体之间不得建立该关系）`,
        });
      }
      break;
    }

    case 'cls-maxc1':
    case 'cls-maxqc1':
    case 'cls-maxqc2': {
      // 最大基数 0：删除该节点上触发基数违规的出边
      const id = ids[0];
      if (!id) { push({ kind: 'manual', auto: false, actionZh: '冲突消息未解析出节点，无法自动定位边' }); break; }
      const hit = edges.filter((e) => e.from === id && (!rels.length || rels.includes(e.rel)));
      if (!hit.length) { push({ kind: 'manual', auto: false, nodeId: id, actionZh: `未能定位「${nameOf(id)}」上违反基数限制的边（可能是推理边）` }); break; }
      for (const e of hit) {
        push({
          kind: 'delete-edge', edgeKey: keyOf(e.from, e.to, e.rel), from: e.from, to: e.to, rel: e.rel,
          fromName: nameOf(e.from), toName: nameOf(e.to),
          actionZh: `删除「${nameOf(e.from)}」—${e.rel}→「${nameOf(e.to)}」（本体声明该类个体在此谓词上最多 0 条出边）`,
        });
      }
      break;
    }

    // ---- C 类：字面量 / 个体等价（无安全的自动修法） ----
    case 'prp-npa2':
    case 'dt-not-type':
      push({
        kind: 'manual', auto: false,
        actionZh: '数据值类型不合法或违反负数据断言——需人工修正原始数值（自动改数会静默篡改事实，故不提供一键修复）',
      });
      break;

    case 'eq-diff1':
    case 'eq-diff2':
    case 'eq-diff3':
      push({
        kind: 'manual', auto: false,
        actionZh: '个体等价（sameAs）与互异（DifferentFrom/AllDifferent）声明相互矛盾——需人工确认二者是否真是同一个体，自动删任一侧都可能抹掉正确事实',
      });
      break;

    default:
      push({ kind: 'manual', auto: false, actionZh: `规则 ${rule || '未知'} 暂无自动修复策略，请按中文原因人工处理` });
      break;
  }

  // ---- 方案3：LLM 语义仲裁（可选） ----
  // 只在「有多解」的 A 类冲突上启用：降级谓词 vs 改节点类型 vs 删边。
  // 仲裁失败/超时/返回不可解析 → 静默退回上面的确定性动作，绝不阻断修复。
  if (typeof opts.arbitrate === 'function' && out.some((a) => a.kind === 'change-rel')) {
    try {
      const targets = out.filter((a) => a.kind === 'change-rel');
      const node = byId.get(targets[0].nodeId) || {};
      const forced = [...new Set(targets.map((a) => a.forcedType).filter(Boolean))];
      const answer = await opts.arbitrate({
        nodeName: node.name || '', nodeType: node.type || '', nodeDesc: node.desc || '',
        candidates: forced,
        rule,
        reasonZh: (c && c.reasonZh) || '',
      });
      const picked = String(answer || '').trim();
      if (picked && forced.includes(picked)) {
        // 模型判定「节点其实应该属于 forced 类」→ 改类型，保住所有边
        for (const a of targets) {
          a.kind = 'retype-node';
          a.nodeId = a.nodeId || node.id;
          a.newType = picked;
          a.viaLlm = true;
          a.actionZh = `把节点「${a.nodeName || node.name}」的类型由「${a.declaredType || node.type}」改为「${picked}」（LLM 语义仲裁判定后者更贴合该节点的含义，从而保住相关边不被降级）`;
          delete a.edgeKey; delete a.newRel;
        }
      }
    } catch (_) { /* 仲裁是增强项，失败退回确定性动作 */ }
  }

  return out;
}

/**
 * 从问题汇总表的单行（validate.js 的 violation / disjointConflict 条目）规划修复动作。
 * 与 planOne 同口径的最小破坏策略：
 *   · unknown-predicate / domain-violation / range-violation → 把该边降级为体系兜底谓词
 *     （与抽取护栏 extractGraph、A 类冲突修复完全同口径）；兜底谓词也带约束或谓词已是
 *     兜底 → 只能删边；
 *   · unknown-type → 端点类型不在体系类表：改类型为「与另一端点约束相容的最近公共祖先」，
 *     找不到相容祖先 → manual（不能瞎改成互斥类制造新冲突）；
 *   · 不相交归属（cax-dw 只读等价）→ 复用 planOne 的 A 类逻辑（找诱导边降级/删边/人工）。
 * 行级修复的意义：问题表一行 = 一条边/一个节点的问题，用户点「修复」只规划这一行，
 * 不必对全图 195 条越界边一键全修。
 *
 * @param {object} issue    validate.js 产出的 violation / disjointConflicts 条目
 * @param {{nodes:Array, edges:Array}} graph
 * @param {object} profile  已 resolveOntology 的体系
 * @returns {Promise<Array<object>>} 动作列表（可能为空 = 无可自动修复方案）
 */
async function planOneIssue(issue, graph, profile) {
  const it = issue || {};
  const nodes = (graph && graph.nodes) || [];
  const edgesAll = ((graph && graph.edges) || []).filter((e) => e && !e.inferred);
  const byId = new Map(nodes.map((n) => [n && n.id, n]));
  const nameOf = (id) => (byId.get(id) || {}).name || id;
  const fbRel = (profile && profile.fallbackRel) || '';
  const fbRelZh = guard.labelOfRel(profile, fbRel) || fbRel;
  const out = [];
  const push = (a) => out.push(Object.assign({ rule: it.reason || 'validate-issue', auto: true, viaLlm: false, source: 'issue' }, a));

  // 不相交归属行：转成 planOne 的 A 类入参（nodeIds + rule=cax-dw），复用诱导边定位
  if (it.nodeId) {
    return planOne({
      rule: 'cax-dw',
      nodeIds: [it.nodeId],
      raw: '',
      profileId: it.profileId || (profile && profile.id) || '',
    }, graph, profile, {});
  }

  const fromId = it.fromId || '';
  const toId = it.toId || '';
  const rel = it.rel || '';
  const ek = it.edgeKey || keyOf(fromId, toId, rel);
  const edge = edgesAll.find((e) => keyOf(e.from, e.to, e.rel) === ek);
  const base = {
    edgeKey: ek, from: fromId, to: toId, rel,
    fromName: nameOf(fromId), toName: nameOf(toId),
  };

  const downgradeOrDelete = (whyZh) => {
    if (fbRel && fbRel !== rel && isUnconstrained(profile, fbRel)) {
      push(Object.assign({}, base, {
        kind: 'change-rel', newRel: fbRel,
        actionZh: `把「${nameOf(fromId)}」—${rel}→「${nameOf(toId)}」的关系降级为「${fbRelZh}」（${whyZh}）`,
        altActionZh: '或删除这条边',
      }));
    } else {
      push(Object.assign({}, base, {
        kind: 'delete-edge',
        actionZh: `删除「${nameOf(fromId)}」—${rel}→「${nameOf(toId)}」这条边（${whyZh}；本体系没有可降级的无约束谓词）`,
      }));
    }
  };

  switch (it.reason) {
    case 'unknown-predicate':
      downgradeOrDelete(`谓词「${rel}」不在体系受控词表中`);
      break;
    case 'domain-violation':
      downgradeOrDelete(`起点「${nameOf(fromId)}」的类型 ${it.actual || (byId.get(fromId) || {}).type || '?'} 不满足该谓词的定义域约束`);
      break;
    case 'range-violation':
      downgradeOrDelete(`终点「${nameOf(toId)}」的类型 ${it.actual || (byId.get(toId) || {}).type || '?'} 不满足该谓词的值域约束`);
      break;
    case 'unknown-type': {
      // 端点类型不在体系类表：把该端点改为「满足这条边约束的类」——
      // 起点越界取 domain(rel) 首个类、终点越界取 range(rel) 首个类；
      // 该侧无约束时退回体系兜底类型（fallbackType，必为类表成员）。
      // actual 是 guard 报出的越界类型 key：与 fromType/toType 比对定位越界端
      // （guard 先查起点后查终点，actual 与两端都相等时按起点处理）。
      const isFrom = !(it.actual && it.actual === it.toType && it.actual !== it.fromType);
      const badId = isFrom ? fromId : toId;
      const badNode = byId.get(badId);
      if (!badNode) { push({ kind: 'manual', auto: false, nodeId: badId, actionZh: `未能在图谱中定位类型越界的节点（${badId || '?'}），请重新校验` }); break; }
      let need = [];
      if (rel) {
        try {
          const c = guard.constraintOf(profile, rel);
          need = isFrom ? (c.domain || []) : (c.range || []);
        } catch (_) { need = []; }
      }
      const newType = need.length ? need[0] : ((profile && profile.fallbackType) || '');
      if (!newType || newType === badNode.type || !guard.isKnownClass(profile, newType)) {
        push({ kind: 'manual', auto: false, nodeId: badId, nodeName: badNode.name || badId, actionZh: `「${badNode.name || badId}」的类型「${badNode.type}」不在体系类表中，且该边在此侧无约束、体系也无兜底类型可改——需人工改类型或扩充本体` });
        break;
      }
      push({
        kind: 'retype-node', nodeId: badId, nodeName: badNode.name || badId,
        declaredType: badNode.type || '', newType,
        actionZh: `把节点「${badNode.name || badId}」的类型由「${badNode.type}」改为「${newType}」`
          + `（原类型不在体系类表中；${need.length ? `取该边${isFrom ? '定义域' : '值域'}约束要求的类` : '取体系兜底类型'}，保住这条边）`,
        altActionZh: '或删除这条边',
      });
      break;
    }
    default:
      push({ kind: 'manual', auto: false, actionZh: `问题类型「${it.reason || '未知'}」暂无自动修复策略，请按「违反的约束或公理」列人工处理` });
      break;
  }
  return out;
}

/**
 * 从问题汇总表的行集合批量规划（行级「修复」按钮的入口）。
 * @param {Array} issues   validate.js 的 violations / disjointConflicts 条目子集
 * @param {{nodes:Array, edges:Array}} graph
 * @param {(profileId:string)=>object|null} resolveProfile
 * @returns {Promise<{actions:Array, byKind:object, autoCount:number, manualCount:number, conflictCount:number}>}
 */
async function planIssues(issues, graph, resolveProfile) {
  const list = Array.isArray(issues) ? issues : [];
  const actions = [];
  const byKind = {};
  const seen = new Set();
  let idx = 0;
  for (const it of list) {
    const pid = String((it && it.profileId) || '');
    let profile = null;
    try { profile = typeof resolveProfile === 'function' ? resolveProfile(pid) : null; } catch (_) { profile = null; }
    if (!profile) {
      actions.push({ rule: (it && it.reason) || '', conflictIdx: idx++, kind: 'manual', auto: false, source: 'issue', actionZh: `体系「${pid || '未知'}」无法解析，跳过该问题的自动修复` });
      continue;
    }
    let acts = [];
    try { acts = await planOneIssue(it, graph, profile); } catch (_) { acts = []; }
    for (const a of acts || []) {
      a.conflictIdx = idx;
      const sig = `${a.kind}\u0001${a.edgeKey || ''}\u0001${a.nodeId || ''}\u0001${a.newRel || a.newType || ''}\u0001${a.actionZh || ''}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      byKind[a.kind] = (byKind[a.kind] || 0) + 1;
      actions.push(a);
    }
    idx++;
  }
  return {
    actions,
    byKind,
    autoCount: actions.filter((a) => a.auto && a.kind !== 'manual').length,
    manualCount: actions.filter((a) => !a.auto || a.kind === 'manual').length,
    conflictCount: list.length,
  };
}

/**
 * 规划整批冲突的修复动作。
 *
 * @param {Array} conflicts  enrichConflicts 产出（需带 nodeIds；raw 可选）
 * @param {{nodes:Array, edges:Array}} graph
 * @param {(profileId:string)=>object|null} resolveProfile  体系 id → 已解析体系
 * @param {object} [opts]  透传给 planOne（arbitrate 等）
 * @returns {Promise<{actions:Array, byKind:object, autoCount:number, manualCount:number, conflictCount:number}>}
 */
async function planRepairs(conflicts, graph, resolveProfile, opts = {}) {
  const list = Array.isArray(conflicts) ? conflicts : [];
  const actions = [];
  const byKind = {};
  let idx = 0;
  for (const c of list) {
    const pid = String((c && c.profileId) || '');
    let profile = null;
    try { profile = typeof resolveProfile === 'function' ? resolveProfile(pid) : null; } catch (_) { profile = null; }
    if (!profile) {
      actions.push({
        rule: (c && c.rule) || '', conflictIdx: idx++, kind: 'manual', auto: false,
        actionZh: `体系「${pid || '未知'}」无法解析，跳过该冲突的自动修复`,
      });
      continue;
    }
    let acts = [];
    try { acts = await planOne(c, graph, profile, opts); } catch (_) { acts = []; }
    for (const a of acts || []) {
      a.conflictIdx = idx;
      byKind[a.kind] = (byKind[a.kind] || 0) + 1;
      actions.push(a);
    }
    idx++;
  }
  // 去重：同一 edgeKey + kind 只保留一条（多条冲突常指向同一条边）
  const seen = new Set();
  const uniq = [];
  for (const a of actions) {
    let sig;
    if (a.kind === 'manual') {
      sig = `manual\u0001${a.rule}\u0001${a.actionZh}`;
    } else if (a.rule === 'prp-asyp' && a.kind === 'delete-edge') {
      // 非对称谓词双向断言会同时报出 (a,b) 与 (b,a) 两条冲突，各自规划
      // 「删除反向边」——按无序节点对合并为一条，否则一键修复会把正反两条边都删光。
      sig = `prp-asyp\u0001${[a.from, a.to].sort().join('\u0002')}\u0001${a.rel}`;
    } else {
      sig = `${a.kind}\u0001${a.edgeKey || ''}\u0001${a.nodeId || ''}\u0001${a.newRel || a.newType || ''}`;
    }
    if (seen.has(sig)) continue;
    seen.add(sig);
    uniq.push(a);
  }
  const byKind2 = {};
  for (const a of uniq) byKind2[a.kind] = (byKind2[a.kind] || 0) + 1;
  return {
    actions: uniq,
    byKind: byKind2,
    autoCount: uniq.filter((a) => a.auto && a.kind !== 'manual').length,
    manualCount: uniq.filter((a) => !a.auto || a.kind === 'manual').length,
    conflictCount: list.length,
  };
}

// ---------------------------------------------------------------------------
// applyActions — 把动作施加到图谱副本上（纯函数，返回新 nodes/edges）
// ---------------------------------------------------------------------------
/**
 * @param {{nodes:Array, edges:Array}} graph
 * @param {Array} actions  planRepairs 产出的动作
 * @returns {{nodes:Array, edges:Array, applied:number, skipped:Array<{actionZh:string, reason:string}>}}
 */
function applyActions(graph, actions) {
  const nodes = ((graph && graph.nodes) || []).map((n) => (n ? Object.assign({}, n) : n));
  // 推理边一律丢弃：修复后必须重算（§5.4），留着会与新的原始边自相矛盾
  const edges = ((graph && graph.edges) || []).filter((e) => e && !e.inferred).map((e) => Object.assign({}, e));
  const byId = new Map(nodes.map((n) => [n && n.id, n]));
  const edgeIdx = new Map();
  edges.forEach((e, i) => { const k = keyOf(e.from, e.to, e.rel); if (!edgeIdx.has(k)) edgeIdx.set(k, i); });

  const applied = [];
  const skipped = [];
  const removed = new Set();   // 待删边在 edges 里的下标
  for (const a of actions || []) {
    if (!a || a.kind === 'manual' || a.auto === false) {
      if (a && a.kind === 'manual') skipped.push({ actionZh: a.actionZh || '', reason: '需人工处理' });
      continue;
    }
    if (a.kind === 'delete-edge') {
      const i = edgeIdx.get(a.edgeKey);
      if (i === undefined || removed.has(i)) { skipped.push({ actionZh: a.actionZh || '', reason: '目标边不存在（可能已删除）' }); continue; }
      removed.add(i);
      applied.push(a);
    } else if (a.kind === 'change-rel') {
      const i = edgeIdx.get(a.edgeKey);
      if (i === undefined || removed.has(i)) { skipped.push({ actionZh: a.actionZh || '', reason: '目标边不存在（可能已删除）' }); continue; }
      const e = edges[i];
      const nk = keyOf(e.from, e.to, a.newRel);
      if (edgeIdx.has(nk)) {
        // 降级后与已有边撞键 → 等价于删掉这条边（图谱里同键边只保留一条）
        removed.add(i);
      } else {
        e.rel = a.newRel;
        edgeIdx.set(nk, i);
      }
      applied.push(a);
    } else if (a.kind === 'retype-node') {
      const n = byId.get(a.nodeId);
      if (!n) { skipped.push({ actionZh: a.actionZh || '', reason: '目标节点不存在' }); continue; }
      if (!a.newType) { skipped.push({ actionZh: a.actionZh || '', reason: '未指定新类型' }); continue; }
      n.type = a.newType;
      applied.push(a);
    } else {
      skipped.push({ actionZh: a.actionZh || '', reason: `未知动作类型 ${a.kind}` });
    }
  }
  const keptEdges = edges.filter((_, i) => !removed.has(i));
  return { nodes, edges: keptEdges, applied, skipped };
}

module.exports = {
  keyOf,
  conflictRelKeys,
  findInducingEdges,
  isUnconstrained,
  lca,
  planOne,
  planOneIssue,
  planIssues,
  planRepairs,
  applyActions,
};
