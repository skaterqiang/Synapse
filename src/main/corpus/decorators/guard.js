// 语料流水线·写入护栏层（设计 §4.3 GuardDecorator）
//
// 把 graph.js:506-556 的护栏整体搬迁到这里：在「抽取已产出、尚未合并」的时机逐条检查每个边（O3）。
//   ① domain/range/谓词越界（R.guard.checkEdge）           graph.js:506-524
//   ② 写侧互斥预检（forcingProbes + checkDisjoint）         graph.js:525-557
// 命中则把 rel **就地降级**为回退谓词 fbRel，并往 ctx.shared.guardLog 追加一条留痕。
//
// 降级（P8 / §12.3）：推理层不可用（reasonReady 假）或内层无 graph 能力时，整层跳过并记 warning，
//   抽取照常——护栏是增强项，不是前置依赖。bfo-lite 无 domain/range 声明时 coverage 0%，自然不拦截（属预期）。
//
// ⚠️ 边对象是 ExtractDecorator 产出的**同一引用**（item.graph.edges[i]），就地改 rel 即可；
//    GraphMergeDecorator 随后按改后的 rel 计算边键 `${from}|${to}|${rel}` 去重（P4）。
'use strict';

const { CorpusDecorator } = require('../decorator');

class GuardDecorator extends CorpusDecorator {
  constructor(inner, opts = {}) {
    super(inner);
    this.opts = opts || {};
    this.checked = 0;
    this.blocked = 0;
    this.skippedNoReason = false;
    this._ready = null;
  }

  get caps() { return this.inner.caps; }

  /** 护栏是否生效：reasonEnabled（含 reasonReady）且内层确有 graph 能力（≡ graph.js:369-372） */
  guardReady(ctx) {
    if (this._ready !== null) return this._ready;
    const c = ctx || {};
    const graph = require('../../graph/graph');
    const enabled = this.opts.enabled !== undefined ? !!this.opts.enabled : graph.reasonEnabled(c.settings || {});
    const R = enabled ? graph.reasonLayer() : null;
    this._R = R;
    this._guardProfile = (R && R.guard && c.onto) ? c.onto : null;
    this._fbRel = c.fallbackRel || graph.fallbackRel(c.profileId);
    this._ready = !!(R && R.guard && this._guardProfile);
    return this._ready;
  }

  async open(ctx) {
    await this.inner.open(ctx);
    const c = ctx || {};
    if (!c.shared) c.shared = {};
    if (!Array.isArray(c.shared.guardLog)) c.shared.guardLog = [];
    this.guardLog = c.shared.guardLog;
    if (!this.guardReady(c)) {
      this.skippedNoReason = true;
      this.pushWarning(c, '护栏未启用（推理层不可用或体系无 domain/range 声明）');
    }
  }

  async next(ctx) {
    const c = ctx || {};
    const item = await this.inner.next(c);
    if (!item) return null;
    const edges = (item.graph && Array.isArray(item.graph.edges)) ? item.graph.edges : null;
    if (!edges || !edges.length) return item;
    if (!this._ready && !this.guardReady(c)) return item;      // 降级：不过护栏，原样透传
    const guard = this._guardProfile;
    const R = this._R;
    const fbRel = this._fbRel;
    const taskNo = this.taskNoOf(item, c);

    for (const e of edges) {
      const from = e._from; const to = e._to;
      if (!from || !to) continue;
      let rel = e.rel;
      this.checked++;
      // ① domain/range/谓词越界（≡ graph.js:508-524）
      let guardBlocked = null;
      try {
        const verdict = R.guard.checkEdge(guard, from, rel, to);
        if (verdict && !verdict.ok) {
          guardBlocked = verdict;
          this.guardLog.push({
            taskNo,
            from: from.name, fromType: from.type,
            rel, to: to.name, toType: to.type,
            reason: verdict.reason || 'constraint-violation',
            detail: verdict.detail || '',
            downgradedTo: fbRel,
          });
          rel = fbRel;
          this.blocked++;
        }
      } catch (_) { /* 护栏自身异常绝不能拖死抽取主链路（≡ graph.js:523） */ }
      // ② 写侧互斥预检（≡ graph.js:531-557）
      if (rel !== fbRel) {
        try {
          const probes = R.guard.forcingProbes(guard, rel)
            .map((p) => ({ node: p.node === 'from' ? from : to, type: (p.node === 'from' ? from : to).type, forced: p.forced, via: p.via, inverseRel: p.inverse ? p.rel : '' }));
          for (const p of probes) {
            if (!p.type || !p.forced.length) continue;
            let hit = null;
            for (const f of p.forced) {
              const d = R.guard.checkDisjoint(guard, p.type, f);
              if (d && d.conflict) { hit = { f, d }; break; }
            }
            if (!hit) continue;
            this.guardLog.push({
              taskNo,
              from: from.name, fromType: from.type,
              rel, to: to.name, toType: to.type,
              reason: 'disjoint-type-forcing',
              detail: `「${p.node.name}」声明类型 ${p.type}，但谓词 ${p.inverseRel ? `${rel} 的逆谓词 ${p.inverseRel}` : rel} 的${p.via === 'domain' ? '定义域' : '值域'}会把它强制归入互斥类 ${hit.f}${hit.d.detail ? `（${hit.d.detail}）` : ''}`,
              downgradedTo: fbRel,
            });
            rel = fbRel;
            this.blocked++;
            break;
          }
        } catch (_) { /* 同上 */ }
      }
      e.rel = rel;                 // 就地降级（GraphMergeDecorator 按改后 rel 计边键）
      if (guardBlocked) e.guardBlocked = guardBlocked.reason || 'constraint-violation';
    }
    return item;
  }

  taskNoOf(item, ctx) {
    const c = ctx || {};
    const tasks = c.shared && c.shared.tasks;
    const indexOf = c.shared && c.shared.taskIndexOf;
    if (!Array.isArray(tasks) || !(indexOf instanceof Map)) return 0;
    const parentId = String(item.id || '').split('#')[0];
    const idx = indexOf.has(parentId) ? indexOf.get(parentId) : indexOf.get(item.id);
    return (idx != null && tasks[idx]) ? tasks[idx].no : 0;
  }

  async finish(ctx) {
    const c = ctx || {};
    // 'guard' 阶段文案（≡ graph.js:653-658；无拦截时 jobs.js 会给「校验通过」的确定态）
    if (this.guardLog && this.guardLog.length && c.onStage) {
      const graph = require('../../graph/graph');
      const R = graph.reasonLayer();
      const summary = (R && R.guard) ? R.guard.summarizeGuardLog(this.guardLog) : { total: this.guardLog.length };
      try { c.onStage('guard', 'running', `护栏拦截 ${summary.total} 条越界连线（已降级为「${this._fbRel}」）`); } catch (_) {}
    }
    return {
      ok: true,
      count: this.checked,
      stats: { guardChecked: this.checked, guardBlocked: this.blocked, guardSkipped: this.skippedNoReason },
      warnings: [],
    };
  }
}

module.exports = { GuardDecorator };
