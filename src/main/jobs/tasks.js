// 作业子任务管理：独立维护 job.tasks 的创建、状态推进与输出记录
// 任务模型：{ no, label, status: 'pending'|'running'|'done', output }
// 通过注入的 persist 回调把变更落库/推送，调用方（ingest/graph）只负责在合适时机调用。

// 由来源标签列表构建任务列表（1 起始编号）
function buildTasks(labels) {
  return (labels || []).map((label, i) => ({ no: i + 1, label, status: 'pending', output: '' }));
}

// 绑定到某个 job 的任务跟踪器；persist 用于落库+推送。
// 对 persist 做 tick 级合并：密集状态变更（如逐条修复动作 setRunning/setOutput/setDone）
// 会在同一事件循环 tick 里多次触发，合并为一次落库+广播，避免同步循环中堆内存与 I/O 爆炸。
function makeTaskTracker(job, persist) {
  let pending = false;
  let hasFinal = false;
  const push = () => {
    if (!persist) return;
    if (pending) { hasFinal = true; return; }
    pending = true;
    setImmediate(() => {
      pending = false;
      const need = hasFinal;
      hasFinal = false;
      try { persist(); } catch (_) {}
      if (need) push();
    });
  };
  return {
    // 初始化任务列表
    init(labels) { job.tasks = buildTasks(labels); push(); return job.tasks; },
    // 全部重置为 pending（编译开始前）
    reset() { (job.tasks || []).forEach((t) => { t.status = 'pending'; t.output = ''; }); push(); },
    setRunning(idx) { if (job.tasks && job.tasks[idx]) { job.tasks[idx].status = 'running'; push(); } },
    setDone(idx) { if (job.tasks && job.tasks[idx]) { job.tasks[idx].status = 'done'; push(); } },
    // 失败任务：与 done 区分开，前端据此显示 ✗ 并（图谱类作业）提供单任务重跑
    setFailed(idx) { if (job.tasks && job.tasks[idx]) { job.tasks[idx].status = 'failed'; push(); } },
    setOutput(idx, out) { if (job.tasks && job.tasks[idx]) { job.tasks[idx].output = out; push(); } },
    // 按来源下标（_i）操作
    runAt(i) { this.setRunning(i); },
    doneAt(i) { this.setDone(i); },
    list() { return job.tasks || []; },
    doneCount() { return (job.tasks || []).filter((t) => t.status === 'done').length; },
  };
}

module.exports = { buildTasks, makeTaskTracker };
