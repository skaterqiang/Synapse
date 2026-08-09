---
kind: logging_system
name: 基于 console.log 的轻量级日志输出（无结构化日志框架）
category: logging_system
scope:
    - '**'
source_files:
    - main.js
    - src/main/db.js
    - src/main/jobs.js
---

## 1. 使用的系统/方案

本仓库没有引入任何第三方日志库（`package.json` 与 `package-lock.json` 中均无 `winston`、`pino`、`bunyan`、`log4js`、`debug`、`electron-log` 等依赖）。应用完全依赖 Node.js / Electron 内置的 `console.*` API 进行输出，属于最轻量的“裸控制台”日志方式。

## 2. 关键文件

- `main.js`：主进程入口，唯一集中处理渲染层日志的地方——通过 `BrowserWindow.webContents.on('console-message', ...)` 监听渲染进程的 `console.log`，并以 `[renderer]` 前缀转发到主进程控制台。
- `src/main/db.js`：数据库初始化、SQLite 切换、JSON→SQLite 迁移过程中的状态与错误输出。
- `src/main/jobs.js`：作业历史读取/持久化失败时的错误输出。
- 其他 `src/main/*.js`（`config.js`、`files.js`、`ingest.js`、`ipc.js`、`jobs.js`、`llm.js`、`store.js`、`wiki.js`）以及 `preload.js`、`src/app.js` 中未发现显式的 `console.*` 调用。

## 3. 架构与约定

- **无统一 logger 模块**：不存在 `lib/logger.js` 或类似的封装；每个业务文件直接调用 `console.log` / `console.warn` / `console.error`。
- **渲染层日志汇聚**：主进程在窗口创建时注册 `console-message` 事件处理器，将渲染进程的所有 `console.log` 以 `[renderer]` 前缀打印到主进程标准输出，便于在终端中区分来源。
- **调试开关**：启动参数 `--kb-debug` 会打开 DevTools，用于交互式调试；除此之外没有按环境/级别控制日志输出的机制。
- **日志内容**：均为人类可读的字符串消息，未使用结构化字段（如 `timestamp`、`level`、`module`、`traceId` 等），也没有 JSON 序列化输出。

## 4. 约定与约束

- **日志级别**：代码中混用 `console.log`（一般信息）、`console.warn`（警告，如 db.js 中指针文件缺失）、`console.error`（错误，如迁移失败、作业持久化失败），但这是随意选择而非受控策略；没有统一的 level 枚举或配置项。
- **来源标识**：仅渲染层日志通过 `[renderer]` 前缀标注来源；主进程各模块未添加模块名前缀，无法从终端输出快速区分来源。
- **输出目标**：全部输出到标准输出/错误流；没有文件 sink、没有日志轮转、没有远程上报。
- **安全边界**：主进程通过 `contextIsolation: true` + `nodeIntegration: false` + preload 桥接的方式隔离渲染进程，日志也遵循这一边界——渲染进程不能直接写主进程日志，必须经 `console-message` 事件中转。
- **可观测性限制**：由于缺少结构化字段与级别过滤，生产环境下无法按模块/级别筛选日志，也无法聚合到外部日志系统。