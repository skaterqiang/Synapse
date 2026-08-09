---
kind: dependency_management
name: 基于 npm + Electron Builder 的依赖管理
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - package-lock.json
    - src/lib/marked.min.js
---

## 1. 使用的系统/方法

本项目采用 **npm** 作为包管理器，通过根目录的 `package.json` 声明运行时与开发时依赖，并使用 `package-lock.json` 锁定依赖树版本。应用基于 **Electron**（主进程 + 渲染进程）构建桌面端个人知识库，打包工具为 **electron-builder**。

- 运行时代码直接 `require()` / `import` 第三方库（如 `jszip`、`mammoth`、`pdf-parse`、`sql.js`、`turndown`、`xlsx`），这些均声明在 `dependencies` 中。
- 构建期工具（`electron`、`electron-builder`、`marked`、`pdfkit`）声明在 `devDependencies` 中，仅用于本地开发与打包。
- 前端渲染层额外内联了一个静态文件 `src/lib/marked.min.js`（Marked 的压缩版），未走 npm 引入，属于手工维护的第三方脚本。

## 2. 关键文件

- `package.json`：唯一依赖清单，声明 `name`、`productName`、`version`、`main`、`scripts`、`build`（electron-builder 配置）、`dependencies`、`devDependencies`。
- `package-lock.json`：由 npm 生成的锁文件，确保跨环境可重复安装。
- `node_modules/`：实际安装的依赖目录（由 npm 自动管理）。
- `src/lib/marked.min.js`：手动放入的 Marked 浏览器端压缩脚本，绕过 npm 引入。

## 3. 架构与约定

- **单一来源声明**：所有 Node.js 依赖集中在 `package.json` 的 `dependencies` 与 `devDependencies` 两个字段，无分散的配置文件。
- **语义化版本范围**：所有依赖使用 `^` 前缀的 caret 范围（如 `^31.0.0`、`^24.13.3`、`^12.0.2`），允许小版本升级，但不固定到精确补丁版本；具体锁定由 `package-lock.json` 保证。
- **Electron 打包集成**：`electron-builder` 的 `build.files` 显式包含 `node_modules/**/*`，将依赖随应用一起打包进 Windows NSIS 安装包。
- **前后端依赖分离**：Node.js 侧依赖通过 npm 管理；浏览器侧仅需一个内联的 `marked.min.js`，不再单独引入其他前端库。
- **无私有仓库/代理配置**：未发现 `.npmrc`、`.yarnrc`、`pnpm-workspace.yaml` 等私有源或镜像配置，默认使用 npm 官方注册表。
- **无 vendoring 策略**：除 `src/lib/marked.min.js` 这一处手工拷贝外，没有对任何 npm 包进行源码级 vendoring。

## 4. 约定与约束

- **依赖分类约定**：仅在运行时被 `require()`/`import` 的库放入 `dependencies`；仅用于构建/打包/测试的工具放入 `devDependencies`，遵循 npm 常规约定。
- **版本更新方式**：通过 `npm install <pkg>@latest` 或 `npm update` 更新后重新生成 `package-lock.json`；项目未提供自动化更新脚本或 CI 中的依赖升级任务。
- **打包产物约束**：`electron-builder` 配置要求最终安装包必须包含 `node_modules`，因此依赖必须能在目标平台正确编译/安装。
- **前端脚本例外**：`src/lib/marked.min.js` 是手动放置的第三方压缩脚本，不受 npm 版本管理约束，升级需人工替换文件。
- **许可证**：项目自身使用 MIT 许可证，但第三方依赖的许可证由其各自声明，项目未集中收集或校验。

总体而言，这是一个小型 Electron 桌面应用的典型 npm 依赖管理模式：以 `package.json` 为单一事实源，配合 `package-lock.json` 保证可重现安装，并通过 electron-builder 将依赖一并打包分发。