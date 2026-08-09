---
kind: configuration_system
name: Electron 桌面应用配置系统：SQLite KV + 指针文件 + 运行时参数校验
category: configuration_system
scope:
    - '**'
source_files:
    - main.js
    - src/main/db.js
    - src/main/store.js
    - src/main/config.js
    - preload.js
    - package.json
---

## 1. 采用的系统与方案

本仓库是一个基于 Electron 的本地个人知识库桌面应用，其配置系统由三部分协作构成：
- **持久化配置**：使用 `sql.js`（WASM 版 SQLite）作为单一数据源，所有笔记、目录、作业历史与用户设置统一写入 `knowledge.db`。
- **数据库路径配置**：通过一个独立的 JSON 指针文件 `db-path.json` 记录自定义数据库位置；若不存在或指向无效路径则回退到默认 `userData/knowledge.db`。
- **运行时数值/枚举参数解析**：`src/main/config.js` 提供 `num()` 与 `pick()` 两个轻量解析器，用于从渲染层经 IPC 传入的 `settings` 对象中安全读取数值与枚举值，缺失或非法时回退默认值。

没有使用 `.env`、`.yaml`、`.toml` 等外部配置文件；也没有环境变量注入机制。所有可配置项均由渲染层设置弹窗维护并通过 IPC payload 传入主进程。

## 2. 关键文件

| 文件 | 作用 |
|---|---|
| `main.js` | Electron 入口，设置 `app.setPath('userData', ...)` 固定数据目录为 `appData/个人知识库助手`，并初始化 DB、Jobs、IPC |
| `src/main/db.js` | SQLite 存储层：schema 定义、KV 存取、数据库路径切换、旧 JSON 迁移、原子落盘 |
| `src/main/store.js` | 对 `db.js` 的薄封装，暴露 `loadStore/saveStore/getDataFile` |
| `src/main/config.js` | 运行时参数解析工具：`num(settings, key, def, min, max)`、`pick(settings, key, def, allowed)` |
| `preload.js` | 向渲染层暴露 `kb.*` 桥接，包括 `saveData(store)`、`setDbPath(p)`、`getDataPath()` 等配置相关 API |
| `package.json` | 声明 `electron-builder` 打包配置（appId、productName、files），属于构建期配置 |

## 3. 架构与设计约定

### 3.1 数据存储布局
- 应用数据根目录：`app.getPath('userData')`，在 Windows/macOS/Linux 上分别映射到系统用户数据目录下的 `个人知识库助手`。
- 默认数据库：`knowledge.db`。
- 指针文件：`db-path.json`，格式 `{ "dbPath": "绝对路径" }`，独立于数据库存放，避免“先有鸡还是先有蛋”问题。
- 旧数据兼容：启动时检测 `knowledge-data.json` 与 `wiki-jobs.json`，一次性迁移至 SQLite 后改名为 `.bak` 留底。

### 3.2 数据库路径切换流程
1. 渲染层调用 `kb.setDbPath(path)` → IPC → `db.setDbPath(newPath)`。
2. 空字符串表示恢复默认；非空必须为绝对路径，且目标文件不能已存在（防覆盖）。
3. 恢复默认时若默认位置已有残留文件，自动追加 `.bak` / `.bak2` … 编号重命名留底。
4. 通过 `db.export()` 整体导出到临时文件 `.tmp`，再 `fs.renameSync` 原子替换目标文件。
5. 更新指针文件 `db-path.json`；离开默认位置时旧库也改名留底。
6. 调用 `flush()` 确保内存状态落盘。

### 3.3 设置（settings）模型
- 设置以 JSON 字符串形式存储在 SQLite 的 `kv` 表中，key 固定为 `'settings'`。
- `getSettings()` 返回 `{}` 作为空集合默认值；`getStore()` 将 `folders`、`notes`、`settings` 组装成完整 store 返回给渲染层。
- 渲染层每次提交全量 store，主进程在事务内清空并重插 `folders`、`notes`，同时 `setKv('settings', JSON.stringify(store.settings))`。

### 3.4 运行时参数校验
`config.js` 中的两个工具函数是业务模块读取设置的唯一入口：
- `num(settings, key, def, min=0, max=Infinity)`：强制转为 Number，非有限数回退 `def`，然后钳制到 `[min, max]` 并四舍五入取整。
- `pick(settings, key, def, allowed)`：仅当值存在于 `allowed` 数组时才采用，否则回退 `def`。
注释明确说明：“所有配置项由渲染层设置弹窗维护并经 IPC payload 传入，主进程不硬编码业务参数”。

### 3.5 构建期配置
`package.json` 的 `build` 字段定义 `electron-builder` 行为：`appId: com.personal.knowledge-assistant`、`productName: Synapse`、Windows NSIS 安装包、允许自定义安装目录。这些属于打包产物配置，不影响运行期行为。

## 4. 约定与约束

- **无外部配置文件**：应用不读取任何 `.env`、`.yaml`、`.json` 形式的配置文件来驱动运行逻辑；所有配置均通过 UI 设置后持久化到 SQLite。
- **数据目录固定**：`userData` 被硬编码为 `appData/个人知识库助手`，即使产品改名仍保持该目录以避免已有数据失联。
- **数据库路径必须绝对**：`setDbPath` 显式拒绝相对路径（`!path.isAbsolute(raw) => error`）。
- **禁止覆盖现有文件**：切换目标路径若已存在同名文件直接拒绝，防止误覆盖。
- **原子落盘**：所有写操作都通过 `.tmp` + `renameSync` 完成，避免写入中断损坏数据库。
- **向后兼容**：启动时自动检测并迁移旧 JSON 文件，迁移成功后原文件改名 `.bak` 保留。
- **指针文件与数据库分离**：指针文件 `db-path.json` 独立于数据库，避免循环依赖。
- **设置结构由渲染层维护**：主进程只负责序列化/反序列化和落盘，不关心 settings 内部字段含义，具体字段校验由 `config.num` / `config.pick` 在业务处按需执行。
- **调试开关通过命令行参数**：`--kb-debug` 启动参数会打开 DevTools，这是唯一的启动期 CLI 配置点。

## 5. 总结

该配置系统的核心思想是：**单文件 SQLite + KV 表存设置 + 独立指针文件管理数据库位置 + 轻量运行时参数校验**。它避免了多配置文件分散管理的复杂性，适合本地桌面应用的规模；通过迁移逻辑和指针文件实现了数据库位置的灵活切换，同时保证数据安全和向后兼容。