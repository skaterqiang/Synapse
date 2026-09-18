// 语料流水线·AI 本体抽取层（设计 §7.2 ExtractDecorator）
//
// 把 graph.js:395-589 的 runBatch 整体搬迁到这里：item.text →（LLM）→ item.graph{nodes,edges}。
// 与现状逐分支等价，含：
//   · 体系提示（两阶段=仅顶级类粗分类 / 单阶段=全类表）        graph.js:424-432
//   · 已有节点上下文（跨来源建关系，避免重复创建）              graph.js:405-406
//   · 流式思考/输出预览（节流 600ms → task.output）             graph.js:407-423
//   · 节点规范化 ensureNode（id 带 profile 前缀、name≤40、desc≤120、类型回退 fbType）graph.js:376-389
//   · 两阶段第二步细分（顶级类子树内细化到叶子类）              graph.js:467-499
//   · 来源标签粗匹配挂载 + 领域兜底                            graph.js:562-578
//   · 单条失败不中断（P10）/ AbortError 上抛（P11）             graph.js:579-588
//
// 累加器住在 ctx.shared（跨条目共享，≡ 老代码 extractGraph 闭包里的 nodes/edges Map）：
//   ctx.shared.nodeMap  Map<nodeKey, node>   所有已规范化节点（供「已有节点上下文」与来源标签挂载）
//   ctx.shared.guardLog Array                护栏留痕（GuardDecorator 写，GraphMergeDecorator 汇总）
// 护栏**不在本层**：本层只产出「未过护栏」的边（携 _from/_to 节点引用），由 GuardDecorator 逐条降级（O3）。
'use strict';

const { CorpusDecorator } = require('../decorator');
const { addProvenance } = require('../item');
const { isAbort, mkAbortErr } = require('../drive');
const { num } = require('../../common/config');
const { chatOnce, extractJson } = require('../../ai/llm');
const { getPromptForProfile } = require('../../ai/prompts');

class ExtractDecorator extends CorpusDecorator {
  constructor(inner, opts = {}) {
    super(inner);
    this.opts = opts || {};
    this.count = 0;        // 处理了多少条（含空文本透传）
    this.extracted = 0;    // 实际发起抽取的条数
    this.llmCalls = 0;
    this.failed = 0;
  }

  get caps() { return { ...this.inner.caps, graph: true }; }

  async open(ctx) {
    await this.inner.open(ctx);
    const c = ctx || {};
    if (!c.shared) c.shared = {};
    if (!c.stats) c.stats = {};
    // 体系：EnrichDecorator 已在 ctx 上解析好（onto/profileId/twoStage/typeHints/fallback*）
    const graph = require('../../graph/graph');
    this.onto = c.onto || graph.resolveOntology(c.profileId);
    this.profileId = this.onto.id;
    c.profileId = this.profileId;
    this.twoStage = this.onto.promptMode === 'two-stage';
    this.typeMap = graph.nodeTypesMap(this.profileId);
    this.rels = graph.relationsList(this.profileId);
    this.fbType = graph.fallbackType(this.profileId);
    this.fbRel = graph.fallbackRel(this.profileId);
    this.hints = c.typeHints || null;
    this.domLabel = c.domainLabel || '';
    this.domainTag = c.domainId && c.domainId !== 'general' ? c.domainId : '';
    this.sysPrompt = getPromptForProfile(c.settings, 'graphExtractPrompt', this.profileId) + (this.twoStage
      ? `\n当前使用顶层本体体系「${this.onto.name}」的两阶段抽取模式：第一步先按顶级类粗分类，第二步再在用户指定的子树内细分到叶子类。`
      : `\n当前使用顶层本体体系「${this.onto.name}」。`);
    // 跨条目累加器（≡ 老代码闭包里的 nodes Map）
    if (!(c.shared.nodeMap instanceof Map)) c.shared.nodeMap = new Map();
    this.nodeMap = c.shared.nodeMap;
  }

  /** ensureNode（≡ graph.js:376-389）：返回共享 nodeMap 里的节点对象（不存在则建） */
  ensureNode(name, type, desc, srcLabel, srcDomain) {
    const graph = require('../../graph/graph');
    const key = graph.nodeKey(name);
    if (!key) return null;
    let node = this.nodeMap.get(key);
    if (!node) {
      node = {
        id: `${this.profileId}:${key}`,
        name: String(name).trim().slice(0, 40),
        type: this.typeMap[type] ? type : this.fbType,
        desc: '', sources: [], domain: srcDomain || '', profile: this.profileId,
      };
      this.nodeMap.set(key, node);
    }
    if (!node.desc && desc) node.desc = String(desc).slice(0, 120);
    if (srcLabel && !node.sources.includes(srcLabel) && node.sources.length < 5) node.sources.push(srcLabel);
    if (srcDomain && !node.domain) node.domain = srcDomain;
    return node;
  }

  async next(ctx) {
    const c = ctx || {};
    if (!this.onto) await this.open(c);
    const item = await this.inner.next(c);
    if (!item) return null;
    this.count++;

    // 空文本：不抽取，透传（≡ graph.js 空来源跳过；统计入 stats.emptyItems）
    if (!String(item.text || '').trim()) {
      c.stats.emptyItems = (c.stats.emptyItems || 0) + 1;
      item.graph = { nodes: [], edges: [] };
      return item;
    }
    if (c.signal && c.signal.aborted) throw mkAbortErr();

    // 子任务定位（P13：任务粒度=来源；chunk 的 parentId 映射回来源任务）
    const task = this.taskOf(item, c);
    const t0 = Date.now();
    try {
      const graph = await this.runBatch(item, c, task);
      item.graph = graph;
      this.extracted++;
      c.stats.llmCalls = (c.stats.llmCalls || 0) + (this.twoStage ? 2 : 1);
      this.llmCalls += (this.twoStage ? 2 : 1);
      if (task) this.markTaskDone(c, task, item);
    } catch (err) {
      if (isAbort(err)) throw err;                                  // P11：中止必须上抛
      item.graph = { nodes: [], edges: [], error: err.message };
      this.failed++;
      if (!Array.isArray(c.errors)) c.errors = [];
      c.errors.push({ label: item.label, error: err.message });      // P10：单条失败不中断
      if (task) this.markTaskFailed(c, task, err);
    }
    addProvenance(item, {
      layer: this.layer, at: Date.now(), ms: Date.now() - t0,
      nodes: (item.graph.nodes || []).length, edges: (item.graph.edges || []).length,
    });
    return item;                                                      // 透传（装饰模式：不吞条目）
  }

  /**
   * 抽取一条（≡ graph.js:395-589 runBatch 的主体）。
   * @returns {Promise<{nodes:Array, edges:Array}>} nodes=本条触达的节点对象；edges=本条产出的边（携 _from/_to，未过护栏）
   */
  async runBatch(item, ctx, task) {
    const c = ctx;
    const settings = c.settings || {};
    const text = String(item.text || '');
    const label = item.label || (item.origin && item.origin.name) || '来源';

    // 'extract' 阶段文案（≡ graph.js:398-399）
    if (c.onStage) {
      const head = task ? `任务 ${task.no}/${(c.shared.tasks || []).length}「${task.label}」` : `来源「${label}」`;
      try { c.onStage('extract', 'running', `AI 本体抽取（${head}）…`); } catch (_) {}
    }
    if (task) this.markTaskRunning(c, task);

    // 已有节点上下文（跨来源建关系，≡ graph.js:405-406）
    const existing = [...this.nodeMap.values()].slice(0, 60).map((n) => `${n.name}(${n.type})`).join('、');

    // 流式思考/输出预览（节流 600ms，≡ graph.js:407-423）
    let think = ''; let out = ''; let lastReport = 0;
    const report = c.onProgress
      ? (delta, isReasoning) => {
        if (isReasoning) think += delta; else out += delta;
        const now = Date.now();
        if (now - lastReport > 600) {
          lastReport = now;
          const phase = out ? `模型输出中（已 ${out.length} 字）` : `模型思考中（已 ${think.length} 字）`;
          const preview = ((think ? `【思考】\n${think}\n\n` : '') + (out ? `【输出】\n${out}` : '')).slice(-1500);
          if (task) { task.output = preview; this.emitTasks(c); }
          try { c.onProgress(`AI 本体抽取（${task ? `任务 ${task.no}` : label}），${phase}…`, preview); } catch (_) {}
        }
      }
      : null;

    // 体系提示（≡ graph.js:424-432）
    const classLine = (list) => list.map((cl) => `${cl.key}(${cl.label}${cl.desc ? '：' + cl.desc : ''})`).join('、');
    const topClasses = this.onto.classes.filter((cl) => !cl.parent || !this.typeMap[cl.parent]);
    const promptHead = this.twoStage
      ? `【第一步·粗分类】本体系为两阶段抽取。节点的一级类只能从以下顶级类中选择：${classLine(topClasses)}。\n`
      : `节点类型只能从：${classLine(this.onto.classes)} 中选择。\n`;
    const hints = this.hints;

    const answer = await chatOnce(settings, [
      { role: 'system', content: this.sysPrompt },
      {
        role: 'user',
        content:
          `以下是知识库中的一个来源内容。请抽取本体层：节点与关系。\n` +
          promptHead +
          `关系只能从：${this.rels.join('、')} 中选择。\n` +
          (existing ? `已有节点（可为其建立关系，避免重复创建）：${existing}。\n` : '') +
          (hints && ((hints.entity || []).length || (hints.concept || []).length)
            ? `本次为领域「${this.domLabel || this.domainTag || ''}」抽取，请围绕该领域模版的类别组织节点：优先归入〔${(hints.entity || []).concat(hints.concept || []).join('、')}〕相关类别。\n`
            : '') +
          `节点名使用规范简短名词；同一事物只输出一个节点；关系须有明确依据，最多 30 个节点、50 条边。\n` +
          `输出 JSON：{"nodes":[{"name":"","type":"","desc":""}],"edges":[{"from":"","to":"","rel":""}]}\n\n` +
          `=== 来源: ${label} ===\n${text}`,
      },
    ], undefined, report, c.signal);

    // 任务完成：把完整思考+输出写入 output（≡ graph.js:450-458）
    if (task) {
      const full = ((think ? `【思考】\n${think}\n\n` : '') + (out ? `【输出】\n${out}` : '')).trim();
      if (full) task.output = full;
    }

    let parsed;
    try { parsed = extractJson(answer); } catch (_) { return { nodes: [], edges: [] }; } // 解析失败跳过（≡ graph.js:462-464）

    let coarse = parsed.nodes || [];
    // 两阶段第二步：顶级类子树内细分到叶子类（≡ graph.js:467-499）
    if (this.twoStage && coarse.length) {
      const subOf = {};
      for (const n of coarse) {
        const top = this.typeMap[n.type] ? n.type : (this.onto.classes.find((cl) => !cl.parent || !this.typeMap[cl.parent]) || {}).key;
        if (!subOf[top]) subOf[top] = [];
        subOf[top].push(n.name);
      }
      const refined = [];
      for (const [top, names] of Object.entries(subOf)) {
        const subtree = this.onto.classes.filter((cl) => {
          let p = cl;
          while (p) { if (p.key === top) return true; p = this.onto.classes.find((x) => x.key === p.parent); }
          return false;
        });
        try {
          const ans2 = await chatOnce(settings, [
            { role: 'system', content: this.sysPrompt },
            {
              role: 'user',
              content:
                `【第二步·细分类】以下节点已粗分为「${top}」，请在子树内细分为最合适的叶子类。\n` +
                `可选类型：${classLine(subtree)}。\n` +
                `节点：${names.join('、')}。\n` +
                `输出 JSON：{"nodes":[{"name":"","type":""}]}，只输出这些节点的细分结果。`,
            },
          ], undefined, undefined, c.signal);
          const r = extractJson(ans2);
          for (const x of r.nodes || []) refined.push(x);
        } catch (_) { /* 单组细分失败则沿用粗分类（≡ graph.js:495） */ }
      }
      const graph = require('../../graph/graph');
      const refMap = new Map(refined.map((x) => [graph.nodeKey(x.name), x.type]));
      coarse = coarse.map((n) => ({ ...n, type: refMap.get(graph.nodeKey(n.name)) || n.type }));
    }

    // 规范化节点（≡ graph.js:500）
    const touched = new Set();
    for (const n of coarse) { const node = this.ensureNode(n.name, n.type, n.desc, null); if (node) touched.add(node.id); }
    // 边：解析端点 + 谓词回退（≡ graph.js:501-505；护栏留给 GuardDecorator）
    const edges = [];
    for (const e of parsed.edges || []) {
      const from = this.ensureNode(e.from, null, null, null);
      const to = this.ensureNode(e.to, null, null, null);
      if (!from || !to || from.id === to.id) continue;
      const rel = this.rels.includes(e.rel) ? e.rel : this.fbRel;
      if (from) touched.add(from.id);
      if (to) touched.add(to.id);
      edges.push({ from: from.id, to: to.id, rel, _from: from, _to: to });
    }

    // 来源标签粗匹配挂载 + 领域兜底（≡ graph.js:562-578）
    const sDomain = (item.meta && item.meta.domain && item.meta.domain.id) || this.domainTag;
    for (const node of this.nodeMap.values()) {
      if (text.includes(node.name)) {
        if (!node.sources.includes(label) && node.sources.length < 5) { node.sources.push(label); touched.add(node.id); }
        if (sDomain && !node.domain) { node.domain = sDomain; touched.add(node.id); }
      }
    }
    if (this.domainTag && this.domainTag !== 'general') {
      for (const node of this.nodeMap.values()) if (!node.domain) { node.domain = this.domainTag; touched.add(node.id); }
    }

    const nodes = [...touched].map((id) => this.nodeById(id)).filter(Boolean);
    return { nodes, edges };
  }

  nodeById(id) {
    for (const n of this.nodeMap.values()) if (n.id === id) return n;
    return null;
  }

  // ---- 子任务桥接（P13：任务粒度=来源；缺 tasks 时全部 no-op）----

  taskOf(item, ctx) {
    const c = ctx || {};
    const tasks = c.shared && c.shared.tasks;
    const indexOf = c.shared && c.shared.taskIndexOf;
    if (!Array.isArray(tasks) || !(indexOf instanceof Map)) return null;
    const parentId = String(item.id || '').split('#')[0];
    const idx = indexOf.has(parentId) ? indexOf.get(parentId) : indexOf.get(item.id);
    return (idx != null && tasks[idx]) ? tasks[idx] : null;
  }
  emitTasks(ctx) { if (ctx && typeof ctx.onTasks === 'function' && ctx.shared && ctx.shared.tasks) { try { ctx.onTasks(ctx.shared.tasks); } catch (_) {} } }
  markTaskRunning(ctx, task) { if (task) { task.status = 'running'; this.emitTasks(ctx); } }
  markTaskDone(ctx, task) { if (task) { task.status = 'done'; this.emitTasks(ctx); } }
  markTaskFailed(ctx, task, err) {
    if (!task) return;
    task.status = 'failed';
    task.output = (task.output || '') + `\n[失败] ${(err && err.message) || err}`;
    this.emitTasks(ctx);
  }

  async finish(ctx) {
    const c = ctx || {};
    return {
      ok: true,
      count: this.extracted,
      stats: { extractItems: this.count, extracted: this.extracted, extractFailed: this.failed, llmCalls: this.llmCalls, nodesTotal: this.nodeMap ? this.nodeMap.size : 0 },
      warnings: [],
    };
  }
}

module.exports = { ExtractDecorator };
