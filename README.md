# Synapse

Synapse 是一款基于 Electron 的本地个人知识库助手，围绕四大能力构建：

- **本地 Markdown 记事本** —— Markdown 笔记的编辑、全文搜索、目录与标签管理，支持分屏实时预览，附件随笔记自身目录存放
- **领域模板** —— 为不同知识领域定义实体/概念类型与抽取规则，图谱抽取时自动匹配领域，未命中可由 AI 自动建模
- **知识图谱** —— LLM 从笔记与原始文件中抽取实体与概念，提供图谱视图、本体定义与 KG 问答，让知识连接可见
- **AI 智能问答** —— 笔记 / 原始文件 / 知识图谱三类知识源统一检索，流式输出与思考过程展示；可接入 🧩 MCP 外部工具与 ⚡ 可执行技能（docx/pptx/xlsx 生成）；支持澄清问题卡片、⭐ 收藏、📝 一键把回答存入笔记

所有数据保存在本地（SQLite + Markdown 文件），隐私可控。

## 功能一览

| 模块 | 能力 |
|---|---|
| 笔记 | Markdown 编辑（编辑/分屏/预览）、全文搜索、目录树、标签、置顶、打开所在文件夹；右键笔记卡片/目录提取知识图谱 |
| 原始文件 | 本机文件/目录引用式管理、网页链接登记、右键提取笔记与知识图谱、MinerU 文档解析 |
| 领域模板 | 模板管理（实体/概念类型、提取规则、页面骨架）、AI 一键生成、**本体体系绑定**（BFO-Lite / BFO 2020 / ISO 15926 / OWL 导入）、图谱抽取时领域选择与自动建模 |
| 知识图谱 | LLM 实体/概念抽取、整体图谱、实体浏览、本体定义、KG 问答 |
| AI 问答 | 兼容 OpenAI 接口格式的任意大模型，多模型切换，流式输出 + 思考过程展示；笔记 / 原始文件 / 知识图谱三类知识源；🧩 MCP 工具调用（stdio / sse / http，支持 Cline JSON 导入）、⚡ 技能（docx/pptx/xlsx 文件生成）；澄清问题卡片、⭐ 收藏、📝 回答一键回填笔记；提示词管理可定制各类系统提示词 |
| 作业 | 并发作业队列、阶段状态机、中断/恢复/重试、**警告状态**（部分任务失败）、**失败任务单独重跑**，作业管理页实时查看进度与子任务输出 |
| 存储 | SQLite（sql.js）持久化，统一数据根目录可配置迁移；笔记为 Markdown 文件，git 友好 |
| 设置 | 主框架 Tab 分类设置页：模型配置 / 存储 / 作业 / 文档解析 / 问答 / 编辑器 / MCP / 技能 |

> 操作约定：所有「提取笔记 / 提取知识图谱」入口统一为**右键菜单**——原始文件、目录、笔记卡片、侧边栏入口均可右键触发。

## 环境要求

- [Node.js](https://nodejs.org/) 18 及以上（推荐 20+）
- npm 随 Node.js 一并安装
- Git（用于版本管理与协作）

## 系统初始化

### 1. 克隆仓库

```bash
git clone https://github.com/skaterqiang/Synapse.git
cd Synapse
```

### 2. 安装依赖

```bash
npm install
```

### 3. 配置 API Key

启动应用后，点击左下角「⚙」打开设置，在「模型配置」页点「＋ 添加模型」填入：

| 配置项 | 说明 |
|---|---|
| API Base URL | 兼容 OpenAI 格式的接口地址（如 `https://api.openai.com/v1`） |
| API Key | 你的密钥（保存在本地 SQLite，不会上传） |
| Model | 模型名称（如 `gpt-4o-mini`） |

### 4. 安全说明

项目已配置 `.gitignore`，以下敏感文件**不会**被提交到仓库：

- `data/` — 统一数据根目录（`knowledge.db` 含 API Key 等设置；笔记、Wiki、附件等用户数据也在此目录）
- `*.db` / `*.db.bak` — SQLite 数据库文件
- `.env` / `*.key` / `*.pem` — 环境变量与密钥文件
- `root-path.json` / `db-path.json` — 数据根目录指针
- `release/` / `dist/` — 构建产物
- `node_modules/` — 依赖目录

> **重要：** 切勿将 API Key 硬编码到源码中，所有密钥通过应用设置界面存入本地数据库。

## 启动方式

### Windows

**方式一：开发模式启动**

在 PowerShell 或 CMD 中进入项目目录：

```powershell
cd D:\个人助手\Synapse
npm install
npm start
```

**方式二：打包为安装包**

```powershell
npm run dist:win
```

由 `build-win.ps1` 驱动 electron-builder 生成 NSIS 安装包，产物位于 `release/` 目录（`Synapse Setup x.y.z.exe`），双击按向导安装，可自定义安装目录。未签名安装包首次运行若被 SmartScreen 拦截，点「更多信息 → 仍要运行」。

也可直接执行 `npm run dist`（等价于 `electron-builder --win`）。

### macOS

**方式一：开发模式启动**

在终端进入项目目录：

```bash
npm install
npm start
```

**方式二：打包为安装包**（需在 macOS 上执行）

```bash
npm run dist:mac
```

由 `build-mac.sh` 驱动：先构建未签名 `.app`，再做 ad-hoc 重签名（绕过 XProtect 误报），最终产出 `.pkg` 安装包与 `.dmg` 拖拽镜像，位于 `release/` 目录。未经 Developer ID 签名的应用首次打开可能被 Gatekeeper 拦截，右键选择「打开」即可。

> 注意：跨平台限制，Windows 上无法直接打包 macOS 应用，请在 Mac 上克隆本项目后执行上述命令。

### Web 模式（实验性）

```bash
npm run serve   # 检查依赖 + 启动服务 + 自动打开浏览器（默认端口 8787）
# 或
npm run web     # 直接启动 web/server.js
```

在浏览器中访问知识库（默认 `http://localhost:8787`，可用 `PORT` 环境变量或 `--port` 参数改端口）；也可双击根目录 `start-web.command` / `start-web.bat` 启动。功能以桌面版为准。

## 数据存储

应用使用**统一数据根目录**存放所有本地数据，默认为项目目录下 `data/`（打包版为安装目录下 `data/`），可在「设置 → 存储」中迁移；旧版 appData 目录的数据首次启动时自动迁移。

| 数据 | 位置 |
|---|---|
| 数据库（目录 / 设置 / 领域模板 / 作业历史 / 问答会话与收藏） | `<数据根目录>/knowledge.db` |
| 笔记（Markdown 文件，图片附件存于笔记自身目录） | `<数据根目录>/note/` |
| 技能生成产物（docx/pptx/xlsx） | `<数据根目录>/artifacts/` |
| 在线安装的技能 | `<数据根目录>/skills/` |

## 项目结构

```
Synapse/
├── main.js                # 应用入口（生命周期与模块装配）
├── preload.js             # 渲染层安全桥接
├── build-win.ps1          # Windows 打包脚本（npm run dist:win）
├── build-mac.sh           # macOS 打包脚本（npm run dist:mac）
├── build/                 # 打包资源（应用图标）
├── src/
│   ├── index.html         # 界面结构
│   ├── styles.css         # 样式
│   ├── lib/               # 渲染层第三方库（marked 等）
│   ├── renderer/          # 渲染层逻辑（按模块拆分）
│   │   ├── app.js         #   主框架 / 导航 / 设置
│   │   ├── notes.js       #   笔记编辑与目录
│   │   ├── wiki.js        #   原始文件 / 领域模板 / 右键提取
│   │   ├── graph.js       #   知识图谱视图
│   │   ├── jobs.js        #   作业管理页
│   │   ├── chat.js        #   AI 问答
│   │   └── common.js      #   共享组件（目录选择器等）
│   └── main/              # 主进程业务模块
│       ├── ipc.js         #   IPC 注册中心
│       ├── ai/            #   AI 问答（LLM 调用 / 默认提示词）
│       ├── common/        #   基础设施（db / settings / paths / llm / prompts）
│       ├── knowledge/     #   知识访问层（笔记/原始文件/图谱 统一检索与上下文打包）
│       ├── mcp/           #   MCP 服务器配置与客户端调用
│       ├── skills/        #   可执行技能（docx/pptx/xlsx 脚本执行）
│       ├── notes/         #   笔记存取（Markdown 文件）
│       ├── wiki/          #   Wiki 领域层（模板 / 原始文件 / 吸收管线）
│       ├── graph/         #   知识图谱抽取
│       └── jobs/          #   作业队列与任务实现
├── web/                   # 浏览器访问模式（实验性）
├── scripts/               #   启动/打包辅助脚本（start-web.js 等）
├── docs/                  #   用户使用文档（按功能章节）
└── data/                  # 统一数据根目录（本地用户数据，不入库）
```

## 首次使用

1. 启动后点击左下角「⚙」打开设置，在「模型配置」页添加模型（兼容 OpenAI 接口格式，可添加多个，第一张为默认模型）；需要时在「MCP」「技能」页配置 MCP 服务器与技能
2. 在「存储」页确认数据根目录（默认项目下 `data/`）
3. 加工知识：「原始文件」页导入文件后，**右键**文件/目录选择「提取笔记」或「提取知识图谱」；笔记卡片同样右键触发图谱抽取
4. 图谱抽取前选择领域：🤖 自动匹配已有领域（未命中会在作业内自动归纳新建）、📚 指定已有领域、✨ 自动创建新领域或 ✍️ 手动新建领域；**领域判定全流程支持流式思考输出**（匹配领域→归纳新建→体系匹配→生成领域类）
5. 处理进度在「作业管理」页查看，图谱在「知识图谱管理」区块查看；作业状态支持**警告**（部分任务失败）与**失败任务单独重跑**
6. AI 问答页可勾选知识源、🧩 选 MCP / ⚡ 选技能；回答完成后可 ⭐ 收藏，或经 📝 / 回填卡片一键存入笔记
