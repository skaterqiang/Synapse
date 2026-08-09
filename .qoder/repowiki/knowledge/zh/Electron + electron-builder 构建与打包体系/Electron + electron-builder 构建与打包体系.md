---
kind: build_system
name: Electron + electron-builder 构建与打包体系
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - main.js
    - preload.js
---

## 1. 使用的系统/工具

本项目采用 **Electron** 作为桌面应用框架，使用 **electron-builder** 进行产物打包与分发。所有构建配置集中在根目录的 `package.json` 中，没有独立的 Makefile、Dockerfile 或 CI 流水线文件。

- 运行时依赖：`electron ^31.0.0`
- 打包工具：`electron-builder ^24.13.3`（devDependencies）
- 开发脚本：`npm start` → `electron .`；`npm run dist` → `electron-builder --win`

## 2. 关键文件

- `package.json`：唯一构建入口，定义 `scripts`、`build`（electron-builder 配置）、`dependencies` / `devDependencies`。
- `main.js`：Electron 主进程入口（由 `package.json.main` 指定）。
- `preload.js`：预加载脚本，通过 IPC 向渲染层暴露安全桥接。
- `src/`：应用源码（`src/main/` 为业务模块，`src/index.html`、`src/styles.css` 为渲染层）。
- `node_modules/`：依赖安装目录（由 npm 管理）。

## 3. 架构与约定

### 3.1 开发流程
开发者执行 `npm start` 启动 Electron 开发模式，直接运行未打包的源码，便于调试。

### 3.2 打包流程
执行 `npm run dist` 触发 `electron-builder --win`，按 `package.json.build` 中的配置生成 Windows NSIS 安装包：
- `appId`: `com.personal.knowledge-assistant`
- `productName`: `Synapse`（与 package.json 顶层同名）
- `target`: `nsis`（NSIS 安装程序）
- `nsis.oneClick: false`、`allowToChangeInstallationDirectory: true`：允许用户自定义安装路径且非一键安装
- `files` 白名单：仅打包 `main.js`、`preload.js`、`src/**/*`、`node_modules/**/*`，其余目录（如 `llmwiki/`、`shots/`）默认被排除

### 3.3 依赖管理
- 生产运行时依赖声明在 `dependencies`（jszip、mammoth、pdf-parse、sql.js、turndown、xlsx）。
- 构建期依赖声明在 `devDependencies`（electron、electron-builder、marked、pdfkit）。
- 版本锁定由 `package-lock.json` 保证。

### 3.4 平台限制
当前 `dist` 脚本显式限定 `--win`，仅产出 Windows 安装包；未配置 macOS/Linux 目标，也未见跨编译脚本。

## 4. 约定与约束

- **单一构建入口**：所有构建逻辑通过 `package.json.scripts` 和 `package.json.build` 表达，仓库内无额外 shell/Makefile。
- **源码目录隔离**：应用代码统一放在 `src/` 下，主进程入口 `main.js` 位于仓库根目录，符合 Electron 常见布局。
- **打包白名单策略**：通过 `build.files` 精确控制产物内容，避免将文档、截图等非必要文件打入安装包。
- **版本号来源**：应用版本由 `package.json.version`（当前 `1.0.0`）驱动，electron-builder 会将其写入安装包元数据。
- **无 CI/CD**：仓库中未发现 `.github/workflows`、`.gitlab-ci.yml`、Jenkinsfile 等持续集成配置，发布需本地手动执行 `npm run dist`。
- **无 Docker 化**：仓库中不存在 Dockerfile 或 docker-compose 配置，应用以原生桌面安装包形式分发。
- **无自动化测试脚本**：`package.json.scripts` 中未定义 test/lint/build 以外的命令，未见 Jest/Mocha 等测试框架配置。

综上，该项目的构建系统非常轻量：以 `package.json` 为中心，使用 electron-builder 完成 Windows 平台的 NSIS 安装包打包，适合个人维护的小型 Electron 桌面应用。