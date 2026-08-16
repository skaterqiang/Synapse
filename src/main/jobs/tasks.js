// 作业子任务管理：独立维护 job.tasks 的创建、状态推进与输出记录
// 任务模型：{ no, label, status: 'pending'|'running'|'done', output }
// 通过注入的 persist 回调把变更落库/推送，调用方（ingest/graph）只负责在合适时机调用。

// 由来源标签列表构建任务列表（1 起始编号）
function buildTasks(labels) {
  return (labels || []).map((label, i) => ({ no: i + 1, label, status: 'pending', output: '' }));
}

// 绑定到某个 job 的任务跟踪器；persist 用于落库+推送
function makeTaskTracker(job, persist) {
  const push = () => { if (persist) persist(); };
  return {
    // 初始化任务列表
    init(labels) { job.tasks = buildTasks(labels); push(); return job.tasks; },
    // 全部重置为 pending（编译开始前）
    reset() { (job.tasks || []).forEach((t) => { t.status = 'pending'; t.output = ''; }); push(); },
    setRunning(idx) { if (job.tasks && job.tasks[idx]) { job.tasks[idx].status = 'running'; push(); } },
    setDone(idx) { if (job.tasks && job.tasks[idx]) { job.tasks[idx].status = 'done'; push(); } },
    setOutput(idx, out) { if (job.tasks && job.tasks[idx]) { job.tasks[idx].output = out; push(); } },
    // 按来源下标（_i）操作
    runAt(i) { this.setRunning(i); },
    doneAt(i) { this.setDone(i); },
    list() { return job.tasks || []; },
    doneCount() { return (job.tasks || []).filter((t) => t.status === 'done').length; },
  };
}

module.exports = { buildTasks, makeTaskTracker };
