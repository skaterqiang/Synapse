// 语料流水线·驱动器（泵）（设计 §3.5）
// 这是唯一驱动数据流动的地方——装饰器之间只通过 inner.next() 互相调用。
// try/finally 是 java try-with-resources 的等价物：保证 close() 必被调用（C2 / P2）。
'use strict';

/** 中止错误：与 jobs.js:195 mkAbortErr 同口径（name='AbortError'，runJob 据此显示「用户手动停止作业」） */
function mkAbortErr(msg) {
  return Object.assign(new Error(msg || '用户手动停止作业'), { name: 'AbortError' });
}

/** 是否中止错误（P11：AbortError 必须一路上抛，任何层都不得吞掉） */
function isAbort(err) {
  return !!(err && (err.name === 'AbortError' || err.code === 'ABORT_ERR'));
}

/**
 * 构造一次流水线运行的上下文（§3.6 PipelineContext）。缺省字段全部补齐，
 * 使各层可以无条件调用 ctx.onLog / ctx.onStage 而不必层层判空。
 */
function makeContext(base) {
  const b = base || {};
  const noop = () => {};
  // 先透传调用方的额外字段（tasks / autoReason / forceMineru / corpusRels …），再归一化已知键
  const ctx = Object.assign({}, b);
  ctx.settings = b.settings || {};
  ctx.signal = b.signal || null;
  ctx.jobId = b.jobId || '';
  ctx.stageKey = b.stageKey || '';
  // ---- 本体 / 领域（由 EnrichDecorator 或调用方预填）----
  ctx.profileId = b.profileId || '';
  ctx.onto = b.onto || null;
  ctx.typeHints = b.typeHints || null;
  ctx.domainId = b.domainId || '';
  ctx.domainLabel = b.domainLabel || '';
  // ---- 回调（桥接现有作业基础设施）----
  ctx.onLog = typeof b.onLog === 'function' ? b.onLog : noop;
  ctx.onStage = typeof b.onStage === 'function' ? b.onStage : noop;
  ctx.onItem = typeof b.onItem === 'function' ? b.onItem : null;
  ctx.onProgress = typeof b.onProgress === 'function' ? b.onProgress : noop;
  ctx.onTasks = typeof b.onTasks === 'function' ? b.onTasks : null;
  // ---- 共享区 ----
  ctx.stats = b.stats || {};
  ctx.shared = b.shared || {};
  ctx.errors = Array.isArray(b.errors) ? b.errors : [];
  ctx.warnings = Array.isArray(b.warnings) ? b.warnings : [];
  // ---- 运行期 ----
  ctx.maxItems = Number(b.maxItems) || 0;
  ctx.itemCount = 0;
  ctx.result = null;
  return ctx;
}

/**
 * 抽干一条流水线。
 * @param {import('./stream').CorpusStream} stream 最外层流
 * @param {Object} ctx PipelineContext（makeContext 的产物或裸对象）
 * @returns {Promise<import('./stream').StageResult>} 最外层 close() 的合并结果
 */
async function drive(stream, ctx) {
  if (!stream || typeof stream.next !== 'function') throw new TypeError('drive 需要一个 CorpusStream');
  const c = ctx || {};
  await stream.open(c);
  try {
    let item; let n = 0;
    while ((item = await stream.next(c)) !== null) {
      n++;
      if (c.signal && c.signal.aborted) throw mkAbortErr();
      if (c.onItem) await c.onItem(item, n);
      if (c.maxItems > 0 && n >= c.maxItems) break; // LimitDecorator 的兜底
    }
    c.itemCount = n;
  } finally {
    // 中止/异常也要收尾：终端层（GraphMergeDecorator）在此把已累加的结果落库
    c.result = await stream.close(c);
  }
  return c.result;
}

module.exports = { drive, makeContext, mkAbortErr, isAbort };
