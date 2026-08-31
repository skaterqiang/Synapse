# Synapse 使用手册

> Synapse 是一款本地优先的个人知识库助手（Electron 桌面应用）。它把「Markdown 笔记 → 原始资料 → 知识图谱 → AI 问答」串成一条本地知识工作流，所有数据保存在本机。

本手册中的全部截图均来自实际运行的 Synapse 应用界面。

![笔记编辑](images/notes-editor.png)

---

## 目录

| 章节 | 内容 |
|---|---|
| [1. 快速开始](01-快速开始.md) | 安装、启动、配置模型、界面总览 |
| [2. 笔记管理](02-笔记管理.md) | Markdown 编辑、目录与标签、搜索、附件、历史版本、AI 辅助 |
| [3. AI 问答](03-AI问答.md) | 多数据源问答、会话管理、收藏回答、思考过程、澄清问题、技能与 MCP |
| [4. 原始文件管理](04-原始文件管理.md) | 添加本机文件/目录、引用式管理、提取笔记 |
| [6. 领域模版](06-领域模版.md) | 模版结构、本体体系绑定、领域类/谓词、AI 生成与图谱抽取约束 |
| [7. 知识图谱](07-知识图谱.md) | 多本体体系（BFO-Lite / BFO 2020 / ISO 15926 / OWL 导入）、本体结构树、图谱视图、实体浏览、KG 问答 |
| [8. 作业管理](08-作业管理.md) | 作业队列、阶段状态、子任务、重试与并发 |
| [9. 提示词管理](09-提示词管理.md) | 11 类系统提示词的查看与自定义 |
| [10. 设置](10-设置.md) | 模型配置、存储、作业、文档解析、问答、编辑器、MCP、技能 |
| [11. 常见问题](11-常见问题.md) | 故障排查与使用建议 |

---

## 核心概念

理解这 4 个概念，就掌握了 Synapse 的设计思路：

| 概念 | 说明 |
|---|---|
| **笔记（Note）** | 你手写的 Markdown 内容，存为 `<数据根目录>/note/` 下的 `.md` 文件，可直接用其他编辑器打开 |
| **原始文件（Raw）** | 待加工的原始资料（PDF/DOCX/网页等）。本机文件采用**引用式**管理，不复制副本 |
| **领域模版（Domain Template）** | 告诉 AI「这个领域该抽取什么」的规则集（领域定位、本体体系绑定、领域类），提取知识图谱时作为类型约束注入 |
| **知识图谱（Knowledge Graph）** | AI 从笔记与原始文件中抽取的实体与关系网络；本体层支持多套可切换的顶层体系（内置 BFO-Lite / BFO 2020 / ISO 15926，可导入 OWL 2 自定义本体），可视化展示并支持基于图谱的问答 |
## 典型工作流

```
① 收集资料                ② 定义领域规则            ③ AI 加工
原始文件页添加文件/目录 →  领域模版（可 AI 生成） →  右键「提取笔记」/「提取知识图谱」
                                                    ↓
④ 后台执行                              ⑤ 使用知识
作业管理（可重试、看子任务输出）  →      AI 问答 / KG 问答
```

> **重要操作约定**：原始文件和笔记的知识图谱入口统一为**右键菜单**；原始文件还可以直接提取为笔记。

## 数据存放位置

所有数据都在本机的**统一数据根目录**下（默认为项目目录下的 `data/`，可在「设置 → 存储」中修改）：

| 内容 | 位置 |
|---|---|
| 数据库（设置 / 目录 / 领域模版 / 图谱 / 作业历史 / 笔记版本） | `<数据根目录>/knowledge.db` |
| 笔记正文（Markdown 文件 + 同名附件目录） | `<数据根目录>/note/` |
| 技能脚本产物（生成的 docx/pptx/xlsx） | `<数据根目录>/artifacts/` |
| 在线安装的技能 | `<数据根目录>/skills/` |

> API Key 保存在本地数据库中，不会上传到除你所配置的模型服务商之外的任何地方。

---

## 截图索引

本手册的全部截图均由 `scripts/capture-docs.js` 从**实际运行的应用**自动采集（1680×1050 窗口，Retina 3024×1696）。需要更新截图时：

```bash
npm run web                              # 启动服务（复用真实本地数据）
npx electron scripts/capture-docs.js     # 逐视图截图并覆盖 docs/images/
```

| 界面 | 文件 |
|---|---|
| 笔记编辑（分屏） | [notes-editor.png](images/notes-editor.png) |
| AI 问答欢迎页（引导卡 + 知识源条） | [ai-chat.png](images/ai-chat.png) |
| AI 问答会话视图 | [ai-session.png](images/ai-session.png) |
| 领域模版管理 | [domain-templates.png](images/domain-templates.png) |
| 原始文件管理 | [raw-files.png](images/raw-files.png) |
| 整体图谱 | [knowledge-graph.png](images/knowledge-graph.png) |
| 图谱概览 | [graph-overview.png](images/graph-overview.png) |
| 实体浏览 | [graph-entities.png](images/graph-entities.png) |
| 本体定义 | [graph-ontology.png](images/graph-ontology.png) |
| KG 问答 | [graph-ask.png](images/graph-ask.png) |
| 作业管理 | [jobs-manager.png](images/jobs-manager.png) |
| 提示词管理 | [prompts-manager.png](images/prompts-manager.png) |
| 设置 · 模型配置 | [settings-ai.png](images/settings-ai.png) |
| 设置 · MCP | [settings-mcp.png](images/settings-mcp.png) |
