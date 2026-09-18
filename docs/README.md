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
| [7. 知识图谱](07-知识图谱.md) | 多本体体系（BFO-Lite / BFO 2020 / ISO 15926 / OWL 导入）、本体结构树、按体系分级筛选图谱、实体浏览、KG 问答、OWL 2 RL 推理、冲突自动修复（一键修复 / 撤销） |
| [8. 作业管理](08-作业管理.md) | 作业队列、阶段状态、子任务、警告状态、失败任务重跑与并发 |
| [9. 提示词管理](09-提示词管理.md) | 7 类系统提示词的查看与自定义 |
| [10. 设置](10-设置.md) | 模型配置、存储、作业、文档解析、**语料流水线**、问答、编辑器、MCP、技能 |
| [11. 常见问题](11-常见问题.md) | 故障排查与使用建议 |
| [12. 语料库](12-语料库.md) | 抽取语料（`kind:extract` 技能）、语料库子页签、提升为笔记、装饰器流水线与可组合抽取 |

---

## 核心概念

理解这 7 个概念，就掌握了 Synapse 的设计思路：

| 概念 | 说明 |
|---|---|
| **笔记（Note）** | 你手写的 Markdown 内容，存为 `<数据根目录>/note/` 下的 `.md` 文件，可直接用其他编辑器打开 |
| **原始文件（Raw）** | 待加工的原始资料（PDF/DOCX/网页等）。本机文件采用**引用式**管理，不复制副本 |
| **语料（Corpus）** | 由抽取技能从原始文件解析出的**结构统一的 Markdown 文本单元**，落盘于 `<数据根目录>/corpus/`（带出处 frontmatter）；是知识图谱抽取的中间产物，可一键提升为笔记（详见 [12. 语料库](12-语料库.md)） |
| **领域模版（Domain Template）** | 告诉 AI「这个领域该抽取什么」的规则集（领域定位、本体体系绑定、领域类），提取知识图谱时作为类型约束注入 |
| **多领域自动拆分** | 一批来源混合多个互不相关领域时，自动识别全部内聚领域 → 逐文件归类（多归属+置信度）→ 每个领域独立提交一个只跑其文件子集的提取作业，避免异领域内容互相干扰（详见 [6.4.1](06-领域模版.md)） |
| **知识图谱（Knowledge Graph）** | AI 从笔记与原始文件中抽取的实体与关系网络；本体层支持多套可切换的顶层体系（内置 BFO-Lite / BFO 2020 / ISO 15926，可导入 OWL 2 自定义本体），可视化展示并支持基于图谱的问答 |
| **作业（Job）** | 所有耗时 AI 任务的后台执行单元，支持队列、并发、状态追踪（成功/失败/警告）、子任务级重试与失败任务单独重跑 |
## 典型工作流

```
① 收集资料                ② 定义领域规则            ③ AI 加工
原始文件页添加文件/目录 →  领域模版（可 AI 生成） →  右键「提取笔记」/「提取知识图谱」
                          ↕ 多领域自动拆分：混合来源自动识别并逐领域独立提取
                                                    ↓
④ 后台执行（作业管理）                    ⑤ 使用知识
队列并发执行，支持警告状态与任务级重试  →      AI 问答 / KG 问答
```

> **重要操作约定**：原始文件和笔记的知识图谱入口统一为**右键菜单**；原始文件还可以直接提取为笔记。

## 数据存放位置

所有数据都在本机的**统一数据根目录**下（默认为项目目录下的 `data/`，可在「设置 → 存储」中修改）：

| 内容 | 位置 |
|---|---|
| 知识库数据库（目录 / 领域模版 / 图谱 / 作业历史 / 笔记版本） | `<数据根目录>/knowledge.db` |
| 应用配置数据库（模型 API Key / MCP / Skills 配置） | `<数据根目录>/app.db` |
| 笔记正文（Markdown 文件 + 同名附件目录） | `<数据根目录>/note/` |
| 抽取语料（Markdown 语料文件 + 同名 `.assets/`，直接扫描文件，无独立索引） | `<数据根目录>/corpus/<原文档名去扩展名>/`（**可重生成，不含在备份内**） |
| 技能脚本产物（生成的 docx/pptx/xlsx） | `<数据根目录>/artifacts/` |
| 在线安装的技能 | `<数据根目录>/skills/` |

> API Key 保存在本地独立的 `app.db` 中，不会上传到除你所配置的模型服务商之外的任何地方。

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

---

## 测试

本项目不引入测试框架，主进程各模块有独立的可执行测试套件，统一由运行器逐一以独立子进程执行：

```bash
npm test                      # 运行全部套件（test/run-all.js）
node test/graph-ontology.test.js   # 单独运行某一套
npm run test:mcp              # MCP 客户端专项
```

每个套件自带隔离沙箱（临时数据目录 + 屏蔽 Electron / 模拟 LLM），运行后打印 `N/M 通过` 汇总。

| 套件 | 覆盖模块 |
|---|---|
| `common-core` | 配置解析、路径、通用工具 |
| `prompts-llm` | 提示词装配、LLM 调用与流式解析 |
| `templates-domains` | 领域模版、多领域识别/归类、体系匹配 |
| `owl-import` | OWL 本体导入 |
| `knowledge-sources` | 知识源收集 |
| `jobs-tasks` | 作业队列、子任务、重试 |
| `notes-store` | 笔记文件存取、版本 |
| `raws-utils` / `raw-preview` | 原始文件工具与应用内预览 |
| `graph-ontology` | 图谱、本体层、KG 问答 |
| `corpus-stream` / `corpus-store` | 语料流水线地基（接口契约、drive、frontmatter）、语料库存储（按文档建目录/无索引扫描/重启读取/淘汰/提升） |
| `corpus-pipeline` | 流水线装配（buildPipeline/makeSource/validateCaps O1–O4/previewPipeline）与可选层 CorpusReuse 端到端复用 |
| `extract-skill` | 抽取技能（`kind:extract`）：frontmatter 8 字段、selectExtractSkills、mode:script 文件交接 |
| `skills-runner` | 技能脚本执行器（docx/pptx/xlsx） |
| `mcp-client` / `db-transaction` / `ask-chain` / `skill-install` | MCP 客户端、数据库事务、问答链、技能安装 |

> **说明**：`mineru-route`、`skill-parse` 依赖外部 MinerU 转换器（Python + mineru 包），未安装时会标记「环境依赖未通过」，属预期、与代码无关；`charge-pile-ontology` 为基线提交即损坏的历史夹具测试（读取提交的 `data/` 图谱，数据已漂移），两者均不阻断 `npm test` 退出码。
