# Synapse

Synapse 是一款基于 Electron 的本地个人知识库助手，围绕四大能力构建：

- **本地 Markdown 记事本** —— Markdown 笔记的编辑、全文搜索、目录与标签管理，支持分屏实时预览
- **LLM Wiki** —— 参考 Karpathy 的 llm-wiki 思想与 Google OKF 协议，把网页、PDF、DOCX、Excel、PPTX、Markdown 等多种来源吸收为结构化 Wiki，支持 AI 问答与 Wiki 体检
- **领域模板** —— 为不同知识领域定义实体/概念类型与抽取规则，吸收前自动匹配领域，未命中可由 AI 自动建模
- **知识图谱** —— LLM 从笔记与 Wiki 中抽取实体与概念，提供图谱视图、本体定义与 KG 问答，让知识连接可见

所有数据保存在本地（SQLite + Markdown 文件），隐私可控。

## 功能一览

| 模块 | 能力 |
|---|---|
| 笔记 | Markdown 编辑（编辑/分屏/预览）、全文搜索、目录树、标签、置顶、导出；右键笔记卡片/目录提取 Wiki 与知识图谱 |
| LLM Wiki | 多格式来源吸收（URL / 粘贴文本 / 文件与目录右键批量）、吸收前领域模板预检查、作业队列（阶段状态机、中断恢复、重试）、Wiki 问答、Wiki 体检 |
| 领域模板 | 模板管理（实体/概念类型、提取规则、页面骨架）、AI 一键生成、吸收前自动匹配与自动建模 |
| 知识图谱 | LLM 实体/概念抽取、单项图谱、整体图谱、实体浏览、本体定义、KG 问答 |
| AI | 兼容 OpenAI 接口格式的任意大模型服务，流式输出；提示词管理页可定制各类系统提示词 |
| 作业 | 串行作业队列、阶段状态机、中断/恢复/重试，作业管理页实时查看进度与体检报告 |
| 存储 | SQLite（sql.js）持久化，统一数据根目录可配置迁移；Wiki 内容为 Markdown 文件，git 友好 |
| 设置 | 主框架 Tab 分类设置页：AI 服务 / 存储 / 作业 / 问答 / 编辑器 |

> 操作约定：所有「提取 Wiki / 提取知识图谱」入口统一为**右键菜单**——原始文件、目录、笔记卡片、侧边栏分区均可右键触发。

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

启动应用后，点击左下角「⚙」打开设置，在「AI 服务」页填入：

| 配置项 | 说明 |
|---|---|
| API Base URL | 兼容 OpenAI 格式的接口地址（如 `https://api.openai.com/v1`） |
| API Key | 你的密钥（保存在本地 SQLite，不会上传） |
| Model | 模型名称（如 `gpt-4o-mini`） |

### 4. 安全说明

项目已配置 `.gitignore`，以下敏感文件**不会**被提交到仓库：

- `data/` — 统一数据根目录（`knowledge.db` 数据库含 API Key、Wiki 内容、笔记附件）
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
npm run web
```

通过 `web/server.js` 在浏览器中访问知识库（功能以桌面版为准）。

## 数据存储

应用使用**统一数据根目录**存放所有本地数据，默认为项目目录下 `data/`（打包版为安装目录下 `data/`），可在「设置 → 存储」中迁移；旧版 appData 目录的数据首次启动时自动迁移。

| 数据 | 位置 |
|---|---|
| 数据库（笔记 / 目录 / 设置 / 领域模板 / 作业历史） | `<数据根目录>/knowledge.db` |
| 笔记附件（图片等） | `<数据根目录>/assets/` |
| LLM Wiki（Markdown 文件） | `<数据根目录>/llmwiki/` |

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
│   │   ├── wiki.js        #   LLM Wiki 与领域模板
│   │   ├── graph.js       #   知识图谱视图
│   │   ├── jobs.js        #   作业管理页
│   │   ├── chat.js        #   AI 问答
│   │   └── common.js      #   共享组件（目录选择器等）
│   └── main/              # 主进程业务模块
│       ├── ipc.js         #   IPC 注册中心
│       ├── common/        #   基础设施（db / llm / config / prompts / paths）
│       ├── notes/         #   笔记存取
│       ├── wiki/          #   Wiki 领域层（吸收 / 模板 / 原始文件管理）
│       ├── graph/         #   知识图谱抽取
│       └── jobs/          #   作业队列与任务实现
├── web/                   # 浏览器访问模式（实验性）
└── data/                  # 统一数据根目录（本地用户数据，不入库）
```

## 首次使用

1. 启动后点击左下角「⚙」打开设置，在「AI 服务」页填入大模型接口地址、API Key 与模型名称（兼容 OpenAI 格式）
2. 在「存储」页确认数据根目录（默认项目下 `data/`）
3. 吸收知识：「原始文件」页导入文件后，**右键**文件/目录选择「提取 Wiki」或「提取知识图谱」；笔记卡片同样右键触发
4. 提取前系统自动预检查领域模板：命中则直接使用；未命中会询问——确定后自动打开「新建领域模板」弹窗，AI 归纳名称并自动生成各字段，审阅后点「创建」即继续提取；取消则使用通用模板
5. 处理进度在「作业管理」页查看，Wiki 内容在「LLM Wiki」页浏览，图谱在「知识图谱」区块查看
