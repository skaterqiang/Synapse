---
kind: error_handling
name: Electron 桌面应用错误处理：IPC 统一包装、流式事件与作业状态机
category: error_handling
scope:
    - '**'
source_files:
    - src/main/ipc.js
    - preload.js
    - src/app.js
    - src/main/jobs.js
---

## 1. 整体方案
本项目为基于 Electron 的本地个人知识库桌面应用，错误处理围绕三层展开：
- **主进程 IPC 层**（`src/main/ipc.js`）：所有 `ipcMain.handle` 入口统一用 try/catch 包裹业务调用，将异常转换为 `{ ok: false, error: err.message }` 形式的结构化响应，避免未捕获异常直接抛给渲染进程。
- **预加载桥接层**（`preload.js`）：通过 `contextBridge.exposeInMainWorld('kb', ...)` 暴露安全 API；对长耗时/流式操作使用 `ipcRenderer.on` 订阅事件通道，其中 `ai:error` 作为 AI 问答失败的专用事件通道。
- **渲染进程 UI 层**（`src/app.js`）：所有调用 `window.kb.*` 的地方检查返回对象的 `ok` 字段，失败时通过内置 `toast()` 或消息气泡显示用户可读的错误信息；AI 流式回答通过 `onAiError` 回调中断并追加警告提示。

此外，**作业系统**（`src/main/jobs.js`）采用“串行队列 + 阶段状态机”模式，每个作业包含 `queued/running/success/failed` 四态和若干 stage，错误被记录到 `job.error` 与当前运行中的 stage 的 `detail` 中，并通过 `jobs:update` 事件推送至前端展示。

## 2. 关键文件与职责
- `src/main/ipc.js`：IPC 注册中心，集中 catch 所有业务模块抛出的异常，统一返回 `{ ok, error }`。
- `preload.js`：定义 `kb` 对象，封装同步 invoke 与异步事件订阅（`onAiChunk/onAiDone/onAiError`、`onWikiRefs`、`onJobsUpdate`）。
- `src/app.js`：UI 逻辑，消费 `kb` API，处理保存失败、打开 Wiki 页面失败、作业提交/重试/删除失败、AI 问答错误等场景。
- `src/main/jobs.js`：作业调度器，维护 `jobs` 数组、`jobQueue` 队列、`runningJobId`，在 `pumpJobQueue` 中 try/catch 执行各 runner，并将错误写入 job 与 stage。
- `src/main/*.js`（db.js、store.js、files.js、wiki.js、ingest.js、llm.js）：具体业务模块，按约定抛出普通 Error，由上层 ipc 或 jobs 捕获。

## 3. 架构与约定
### 3.1 IPC 错误契约
每个 `ipcMain.handle` 处理器遵循同一约定：成功返回 `{ ok: true, ...data }`，失败返回 `{ ok: false, error: err.message }`。例如：
- `data:save`、`wiki:read`、`wiki:fileAnswer`、`jobs:submit`、`jobs:retry` 均如此。
- 非异常分支也显式返回 `{ ok: false }`（如 `dialog:export` 取消时），使调用方无需区分异常与业务拒绝。

### 3.2 流式错误的单向事件通道
AI 问答不是简单的 Promise 返回值，而是通过 `ai:chunk`、`ai:done`、`ai:error` 三个事件驱动。渲染进程在发起 `askAI` 前就注册 `onAiError` 回调，一旦主进程发送 `ai:error`，立即停止渲染并追加错误消息。

### 3.3 作业状态机错误传播
- 提交阶段：`submit()` 做参数校验，无来源时直接返回 `{ ok: false, error: '没有可吸收的来源' }`。
- 执行阶段：`pumpJobQueue` 中 try/catch 捕获 runner 抛出的异常，设置 `job.status = 'failed'`、`job.error = err.message`，并把当前 running stage 标记为 failed 且 detail 设为错误信息。
- 重启恢复：`loadJobs()` 启动时将仍处于 `running/queued` 的作业强制改为 `failed`，error 标注为「应用重启导致作业中断」，体现幂等恢复语义。
- 历史持久化：每次阶段变更都 `persistJobs()`，但会剥离 `payload`（含 API Key 与全文），仅保留元数据与结果，降低敏感信息泄露风险。

### 3.4 渲染进程错误呈现策略
- 短消息：`toast(msg, ms)` 弹出后自动隐藏。
- 对话内错误：AI 回答中途出错时，若已有部分输出则追加 `> ⚠ ${message}`，否则替换为 `role='error'` 的消息气泡。
- 作业页：失败作业展开后可见 `job-error` 行，显示 `错误：${job.error}`。

## 4. 约定与约束
- **所有 IPC 处理器必须返回 `{ ok, ... }` 结构**，禁止直接 throw 未捕获异常——这是 `ipc.js` 中每个 handler 的统一实现模式所体现的约定。
- **流式交互必须提供 onAiError 监听**，渲染进程在 `sendAiQuestion` / `sendWikiQuestion` 中固定注册该监听并在 finish 时清理。
- **作业错误必须落库**：任何失败都会更新 `job.error`、stage.detail 并持久化，保证用户可在「作业」页追溯原因。
- **进行中作业不可删除**：`remove()` 显式拒绝删除 `running/queued` 状态的作业，防止并发写冲突。
- **重试语义受约束**：`retry()` 仅允许对 `failed` 状态作业重试；ingest 类型要求存在 `rawPaths` 才能跳过解析阶段直接重试。
- **无全局错误中间件**：项目未引入第三方错误框架，全部依赖原生 try/catch、Promise reject 与 IPC 事件通道。
- **无 panic/recover**：Node/Electron 侧不使用 `process.on('uncaughtException')` 等全局捕获，错误集中在业务边界处理。
- **用户可见错误文案均为中文**，错误码/键名保持英文（如 `ok`、`error`、`status`、`failed`），便于前后端一致解析。