// 语料流水线·合并存图层（设计 §7.3 GraphMergeDecorator）——终端层
//
// 把 graph.js:600-720 整体搬迁到这里：
//   next(item)  逐条累加 nodes/edges（按 nodeKey/边键去重、合并 sources[]≤8）  graph.js:625-645
//   finish()    ① 原始图先落库（P5/I2）                                        graph.js:650
//               ② 推理物化（reasonEnabled 为假时整段跳过，P8/I5）              graph.js:660-698
//               ③ setGraphMeta（键集与合并语义不变，§12.1）                    graph.js:699-719
//               ④ 返回与现状 extractGraph 完全同构的 10 字段（§12.1）          graph.js:722-734
//
// 不变量：
//   P4  边身份键统一 `${from}|${to}|${rel}`
//   P5  原始图先落库，推理后追加（推理超时也不丢抽取结果）
//   P6  旧推理边（e.inferred）不参与新一轮合并（否则自我循环论证）
//   P7  saveGraph 是图谱唯一写入口
//   P2  finish() 幂等（CorpusDecorator.close 已保证只跑一次）
'use strict';

const { CorpusDecorator } = require('../decorator');

class GraphMergeDecorator extends CorpusDecorator {
  constructor(inner, opts = {}) {
    super(inner);
    this.opts = opts || {};
    this.autoReason = this.opts.autoReason !== false;   // §6.7「抽取后自动推理」，默认勾选
    this.items = 0;
    this.result10 = null;
    this.warnings = [];
    this._sourceLabels = null;
  }

  get caps() { return { ...this.inner.caps, graph: true }; }

  async open(ctx) {
    await this.inner.open(ctx);
    const c = ctx || {};
    if (!c.shared) c.shared = {};
    const graph = require('../../graph/graph');
    const g = graph.getGraph();
    // 累加器：先放已有图谱（跨体系保留），旧推理边不参与合并（P6/I3）
    this.mergedNodes = new Map();   // nodeId -> node
    this.mergedEdges = new Map();   // edgeKey -> edge
    for (const n of g.nodes || []) if (n && n.id) this.putNode(n);
    for (const e of g.edges || []) if (e && e.from && e.to && !e.inferred) this.putEdge(e);
    this.existingNodeCount = this.mergedNodes.size;
    // 来源标签：适配层预填（P13：以来源为单位，不随分块变化）；缺省时逐条累积
    this._sourceLabels = Array.isArray(c.shared.sourceLabels) ? c.shared.sourceLabels.slice() : null;
    this._seenParent = new Map();   // parentId -> label（累积兜底用）
  }

  /** 合并节点（≡ graph.js:630-637）：同 id 合并 sources（≤8）/desc/domain，保留既有 type */
  putNode(n) {
    if (!n || !n.id) return;
    const ex = this.mergedNodes.get(n.id);
    if (!ex) { this.mergedNodes.set(n.id, { ...n }); return; }
    for (const s of n.sources || []) if (!ex.sources.includes(s) && ex.sources.length < 8) ex.sources.push(s);
    if (!ex.desc && n.desc) ex.desc = n.desc;
    if (!ex.domain && n.domain) ex.domain = n.domain;
  }

  /** 合并边（≡ graph.js:638）：按边键去重（P4） */
  putEdge(e) {
    if (!e || !e.from || !e.to) return;
    const k = `${e.from}|${e.to}|${e.rel}`;
    if (!this.mergedEdges.has(k)) this.mergedEdges.set(k, { from: e.from, to: e.to, rel: e.rel });
  }

  async next(ctx) {
    const c = ctx || {};
    const item = await this.inner.next(c);
    if (!item) return null;
    this.items++;
    // 累积来源标签（兜底：适配层未预填时，按 parentId 去重，label 去掉分块后缀）
    if (!this._sourceLabels) {
      const parentId = String(item.id || '').split('#')[0];
      if (!this._seenParent.has(parentId)) {
        this._seenParent.set(parentId, String(item.label || '').replace(/（\d+\/\d+）$/, ''));
      }
    }
    const g = item.graph;
    if (g && Array.isArray(g.nodes)) for (const n of g.nodes) this.putNode(n);
    if (g && Array.isArray(g.edges)) for (const e of g.edges) this.putEdge(e);
    return item;   // 透传 → 下游（TeeDecorator / NullSink）还能继续消费
  }

  async finish(ctx) {
    const c = ctx || {};
    const graph = require('../../graph/graph');
    const settings = c.settings || {};
    const profileId = c.profileId || (c.onto && c.onto.id) || 'bfo-lite';
    const onto = c.onto || graph.resolveOntology(profileId);
    const profileName = onto.name;

    const mergedNodeList = [...this.mergedNodes.values()];
    const rawEdgeList = [...this.mergedEdges.values()];
    // ① 先落原始图（P5/I2：推理失败/超时/被关闭都不能让用户丢掉抽取结果）—— graph.js:650
    graph.saveGraph(mergedNodeList, rawEdgeList);

    // 护栏汇总（GuardDecorator 已把留痕写进 ctx.shared.guardLog）—— graph.js:653-658
    const guardLog = Array.isArray(c.shared.guardLog) ? c.shared.guardLog : [];
    const R = graph.reasonLayer();
    const guardSummary = guardLog.length
      ? ((R && R.guard) ? R.guard.summarizeGuardLog(guardLog) : { total: guardLog.length, byReason: {}, byRel: {}, entries: guardLog.slice(0, 200), truncated: false })
      : null;

    // ② 自动推理（≡ graph.js:660-720）
    // 若本次没有任何新节点/边产出（例如全部来源抽取失败），跳过推理，
    // 避免 runJob 失败定位时被误导到「本体推理」阶段。
    const newNodes = this.mergedNodes.size - this.existingNodeCount;
    const hasNewContent = newNodes > 0 || rawEdgeList.length > 0;
    const guardOn = graph.reasonEnabled(settings);
    const doReason = guardOn && this.autoReason && c.autoReason !== false && hasNewContent;
    let reasonResult = null;
    if (doReason) {
      if (c.onStage) { try { c.onStage('reason', 'running', '本地物化推理中（OWL 2 RL 前向链）…'); } catch (_) {} }
      try {
        const mat = await R.infer.materializeGraph(
          { nodes: mergedNodeList, edges: rawEdgeList },
          onto,
          {
            timeoutMs: graph.reasonTimeoutSec(settings) * 1000,
            signal: c.signal,
            onProgress: (info) => { if (c.onStage && info && info.phase) { try { c.onStage('reason', 'running', info.phase); } catch (_) {} } },
          }
        );
        if (mat.skipped) {
          reasonResult = { skipped: true, skipReason: mat.skipReason || 'unknown', stats: mat.stats || null };
          if (c.onStage) { try { c.onStage('reason', 'running', `推理已跳过：${graph.SKIP_REASON_TEXT[mat.skipReason] || mat.skipReason || '未知原因'}`); } catch (_) {} }
        } else {
          const merged = R.infer.mergeInferredEdges(rawEdgeList, mat.inferredEdges);
          graph.saveGraph(mergedNodeList, merged.edges);
          reasonResult = {
            skipped: false,
            stats: mat.stats,
            inferredEdges: merged.edges.length - rawEdgeList.length,
            bound: merged.bound,
            dropped: merged.dropped,
            inconsistencies: mat.inconsistencies || [],
          };
          if (c.onStage) {
            const nInf = reasonResult.inferredEdges;
            const nCon = (mat.inconsistencies || []).length;
            try {
              c.onStage('reason', 'running', `推理完成：新增 ${nInf} 条推理边（${mat.stats.rounds} 轮 / ${mat.stats.elapsedMs} ms）`
                + (nCon ? `，检出 ${nCon} 处语义冲突` : ''));
            } catch (_) {}
          }
        }
      } catch (err) {
        // 推理异常绝不影响抽取作业的成功判定：原始图已落库（≡ graph.js:694-698）
        reasonResult = { skipped: true, skipReason: 'exception', error: String((err && err.message) || err) };
        if (c.onStage) { try { c.onStage('reason', 'running', `推理失败（已保留原始图谱）：${reasonResult.error.slice(0, 160)}`); } catch (_) {} }
      }
      // ③ 元信息（≡ graph.js:699-717；键集与合并语义不变，§12.1）
      graph.setGraphMeta({
        lastInferredAt: reasonResult && !reasonResult.skipped ? Date.now() : graph.getGraphMeta().lastInferredAt,
        inferredStale: false,
        lastStats: reasonResult ? {
          skipped: !!reasonResult.skipped,
          skipReason: reasonResult.skipReason || '',
          inferredEdges: reasonResult.inferredEdges || 0,
          inconsistencies: (reasonResult.inconsistencies || []).length,
          inconsistencyDetails: graph.capInconsistencies(reasonResult.inconsistencies || []),
          elapsedMs: (reasonResult.stats && reasonResult.stats.elapsedMs) || 0,
          rounds: (reasonResult.stats && reasonResult.stats.rounds) || 0,
          profileId,
          at: Date.now(),
        } : null,
        lastGuard: guardSummary ? {
          total: guardSummary.total, byReason: guardSummary.byReason, byRel: guardSummary.byRel,
          entries: (guardSummary.entries || []).slice(0, 50), profileId, at: Date.now(),
        } : graph.getGraphMeta().lastGuard,
      });
    } else if (guardSummary) {
      graph.setGraphMeta({ lastGuard: { total: guardSummary.total, byReason: guardSummary.byReason, byRel: guardSummary.byRel, entries: (guardSummary.entries || []).slice(0, 50), profileId, at: Date.now() } });
    }

    const finalGraph = graph.getGraph();
    const sourceLabels = this._sourceLabels || [...this._seenParent.values()];
    const failedTasks = this.collectFailedTasks(c);

    // ④ 与现状 extractGraph 完全同构的 10 字段（§12.1 硬契约，字段名与顺序逐字一致）
    this.result10 = {
      nodeCount: this.mergedNodes.size,
      edgeCount: finalGraph.edges.length,
      rawEdgeCount: rawEdgeList.length,
      sourceCount: sourceLabels.length,
      sourceLabels,
      profileId,
      profileName,
      failedTasks,
      guard: guardSummary ? { total: guardSummary.total, byReason: guardSummary.byReason, byRel: guardSummary.byRel } : null,
      reason: reasonResult,
    };

    // 全失败 / 无节点：与 extractGraph 同口径置 fatalError，由适配层抛出（≡ graph.js:613-623）
    if (failedTasks && failedTasks.length && failedTasks.length >= sourceLabels.length && sourceLabels.length > 0 && newNodes <= 0) {
      c.shared.fatalError = `全部 ${failedTasks.length} 个来源抽取失败：${failedTasks[0].error}`;
    } else if (newNodes <= 0 && rawEdgeList.length === 0 && this.existingNodeCount === 0) {
      c.shared.fatalError = '模型未抽取到任何节点，请检查 API 配置或缩小范围重试';
    }

    // 把 10 字段结果挂到 ctx，供 graph.js 适配层原样返回
    c.shared.result10 = this.result10;
    return {
      ok: true,
      count: this.items,
      stats: { ...this.result10, mergedItems: this.items },
      warnings: this.warnings,
    };
  }

  /** 失败任务清单（≡ graph.js:617-620）：优先按 task 状态，回退 ctx.errors */
  collectFailedTasks(ctx) {
    const c = ctx || {};
    const tasks = (c.shared && Array.isArray(c.shared.tasks)) ? c.shared.tasks : null;
    const errByLabel = new Map(((c.errors) || []).map((e) => [String(e.label || ''), String(e.error || '')]));
    let out = [];
    if (tasks) {
      out = tasks.filter((t) => t.status === 'failed')
        .map((t) => ({ taskNo: t.no, label: t.label, error: errByLabel.get(String(t.label).replace(/（\d+\/\d+）$/, '')) || this.errFromOutput(t.output) || '抽取失败' }));
    }
    if (!out.length && Array.isArray(c.errors) && c.errors.length) {
      out = c.errors.map((e, i) => ({ taskNo: i + 1, label: e.label || `来源 ${i + 1}`, error: e.error || '处理失败' }));
    }
    return out.length ? out : undefined;
  }

  errFromOutput(output) {
    const m = String(output || '').match(/\[失败\]\s*([^\n]+)/);
    return m ? m[1].trim() : '';
  }
}

module.exports = { GraphMergeDecorator };
