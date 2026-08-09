# Synapse

Synapse 是一款基于 Electron 的本地个人知识库助手，围绕三大能力构建：

- **本地 Markdown 记事本** —— Markdown 笔记的编辑、全文搜索、目录与标签管理，支持分屏实时预览
- **LLM Wiki** —— 参考 Karpathy 的 llm-wiki 思想与 Google OKF 协议，把网页、PDF、DOCX、Excel、PPTX、Markdown 等多种来源吸收为结构化 Wiki，支持 AI 问答与 Wiki 体检
- **知识图谱** —— 在当前所管理数据（笔记、标签、Wiki 主题互链与来源引用）的基础上提供知识图谱视图，让知识连接可见（规划中）

所有数据保存在本地（SQLite + Markdown 文件），隐私可控。

## 功能一览

| 模块 | 能力 |
|---|---|
| 笔记 | Markdown 编辑（编辑/分屏/预览）、全文搜索、目录树、标签、置顶、导出 |
| LLM Wiki | 多格式来源吸收（URL / 文本 / 文件批量）、作业队列（阶段状态机、中断恢复、重试）、Wiki 问答、Wiki 体检 |
| AI | 兼容 OpenAI 接口格式的任意大模型服务，流式输出 |
| 存储 | SQLite（sql.js）持久化，数据文件位置可在设置中迁移；Wiki 内容为 Markdown 文件，git 友好 |
| 设置 | 主框架 Tab 分类设置页：AI 服务 / 存储 / 作业 / 问答 / 编辑器 |

## 环境要求

- [Node.js](https://nodejs.org/) 18 及以上（推荐 20+）
- npm 随 Node.js 一并安装

## 启动方式

### Windows

**方式一：开发模式启动**

在 PowerShell 或 CMD 中进入项目目录：

```powershell
cd D:\个人助手
npm install
npm start
```

**方式二：打包为安装包**

```powershell
npm run dist
```

生成 NSIS 安装包于 `dist/` 目录，双击安装后可从开始菜单启动。

### macOS

**方式一：开发模式启动**

在终端进入项目目录：

```bash
npm install
npm start
```

**方式二：打包为应用**（需在 macOS 上执行）

```bash
npx electron-builder --mac
```

生成的 `.app` / `.dmg` 位于 `dist/` 目录。未经签名的应用首次打开会被 Gatekeeper 拦截，可右键选择「打开」，或执行：

```bash
xattr -cr dist/mac*/Synapse.app
```

> 注意：跨平台限制，Windows 上无法直接打包 macOS 应用，请在 Mac 上克隆本项目后执行上述命令。

## 数据存储

| 数据 | 位置 |
|---|---|
| 笔记 / 目录 / 设置 / 作业历史（SQLite） | Windows：`%APPDATA%\个人知识库助手\knowledge.db`<br>macOS：`~/Library/Application Support/个人知识库助手/knowledge.db`（可在「设置 → 存储」中迁移到其他位置） |
| LLM Wiki（Markdown 文件） | 默认取项目下 `llmwiki/`，可在「设置 → 存储」中指定根目录 |

## 项目结构

```
Synapse/
├── main.js              # 应用入口（生命周期与模块装配）
├── preload.js           # 渲染层安全桥接
├── src/
│   ├── index.html       # 界面结构
│   ├── styles.css       # 样式
│   ├── app.js           # 渲染层逻辑
│   └── main/            # 主进程业务模块
│       ├── db.js        #   SQLite 存储层
│       ├── store.js     #   笔记/目录/设置存取
│       ├── config.js    #   设置解析助手
│       ├── llm.js       #   LLM 请求层
│       ├── wiki.js      #   Wiki 领域层
│       ├── files.js     #   多格式文件解析
│       ├── ingest.js    #   吸收编排
│       ├── jobs.js      #   作业管理（串行队列+阶段状态机）
│       └── ipc.js       #   IPC 注册中心
└── llmwiki/             # LLM Wiki 内容（AGENTS.md / bundles / sources / topics）
```

## 首次使用

1. 启动后点击左下角「⚙」打开设置，在「AI 服务」页填入大模型接口地址、API Key 与模型名称（兼容 OpenAI 格式）
2. 在「存储」页确认 Wiki 根目录（留空自动探测项目下 `llmwiki/`）
3. 侧边栏「LLM Wiki」区块点击「＋」即可吸收网页 / 文本 / 文件，处理进度在「作业」页查看
