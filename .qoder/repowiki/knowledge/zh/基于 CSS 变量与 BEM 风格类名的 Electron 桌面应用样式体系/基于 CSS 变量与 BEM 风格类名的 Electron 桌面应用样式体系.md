---
kind: frontend_style
name: 基于 CSS 变量与 BEM 风格类名的 Electron 桌面应用样式体系
category: frontend_style
scope:
    - '**'
source_files:
    - src/styles.css
    - src/index.html
---

## 1. 使用的系统/方法
- 纯原生 CSS（无 Sass/Less、无 Tailwind、无 CSS-in-JS），通过 `src/styles.css` 单文件集中管理全部样式，由 `src/index.html` 以 `<link>` 引入。
- 使用 CSS Custom Properties（`:root` 中的 `--bg`、`--panel`、`--primary`、`--danger`、`--radius` 等）作为设计令牌，统一控制背景、面板、边框、文字色、主色、危险色和圆角。
- 采用类名命名约定接近 BEM：块级容器如 `.sidebar`、`.note-list-pane`、`.editor-pane`、`.ai-panel`、`.modal`；状态修饰符如 `.active`、`.collapsed`、`.running`、`.failed`、`.success`、`.mode-edit`、`.mode-preview`、`.dragover` 等通过 JS 动态切换。
- 字体栈为 `"Segoe UI", "Microsoft YaHei", "PingFang SC", "Helvetica Neue", sans-serif`，代码/编辑器区域使用 `Consolas, monospace`，体现桌面端本地化阅读体验。
- 通过 `box-sizing: border-box` + 全局 reset 保证布局一致性；`user-select: none` 默认禁用文本选择，编辑区/预览区单独恢复 `user-select: text`。

## 2. 关键文件
- `src/styles.css`：唯一样式源，约 900 行，覆盖全局 reset、CSS 变量、侧边栏、笔记列表、编辑器、Markdown 渲染、AI 对话气泡、弹窗、设置页、Wiki 阅读器、作业管理、Toast、滚动条、拖拽分隔条等全部 UI。
- `src/index.html`：页面骨架，仅负责 DOM 结构与语义化 class，不内联任何样式；通过 `hidden` 属性配合 JS 切换视图（编辑器、设置页、Wiki 阅读器、作业管理、AI 面板、各类 modal）。
- `src/lib/marked.min.js`：Markdown 渲染库，配合 `.markdown-body` 类实现统一的 Markdown 输出样式。

## 3. 架构与约定
- **三栏+可伸缩布局**：`.app` 使用 flex 横向排列 `aside.sidebar` → `.pane-resizer` → `.note-list-pane` → `.pane-resizer` → `main.editor-pane` → `.pane-resizer` → `aside.ai-panel`，所有分隔条通过 `.pane-resizer` 统一样式并支持拖拽调整宽度。
- **主题令牌集中**：所有颜色、圆角均从 `:root` 的 CSS 变量读取，新增主题只需替换变量值。
- **组件式 CSS 组织**：按功能区块注释分段（按钮、左侧导航、笔记列表、编辑区、Markdown 渲染、AI 面板、弹窗、设置页、Toast、滚动条、LLM Wiki、作业管理等），每段对应一个 UI 模块。
- **状态驱动样式**：大量样式通过 JS 切换 class 实现，如 `.active`（选中）、`.collapsed`（折叠箭头旋转 -90°）、`.mode-edit` / `.mode-split` / `.mode-preview`（编辑器三种模式）、`.jobs-active`（作业进行中呼吸灯）、`.dragover`（文件拖放高亮）。
- **Markdown 渲染统一**：`.markdown-body` 定义标题、段落、列表、引用框（带 `--primary` 左边框）、行内代码、代码块（深色背景 `#282c34`）、表格、链接、图片、分割线等，被笔记预览、AI 助手回复、Wiki 阅读器复用。
- **弹窗/遮罩统一**：`.modal-mask` + `.modal` 构成通用模态框，配合 `hidden` 属性显示/隐藏；`.toast` 提供底部居中提示，带入场动画。
- **自定义滚动条**：通过 `::-webkit-scrollbar` 系列伪元素统一 WebKit 滚动条外观。

## 4. 约定与约束
- **单一样式入口**：所有视觉样式集中在 `src/styles.css`，禁止在 HTML 中写内联 style（除个别 modal 的 `width` 快速样式外），保持样式可维护性。
- **设计令牌优先**：颜色、圆角等视觉常量必须通过 `--*` 变量引用，避免硬编码十六进制值散落各处。
- **类名即状态**：UI 状态（激活、折叠、运行中、失败等）通过添加/移除 class 表达，而非直接操作 inline style。
- **响应式策略**：当前未实现媒体查询或移动端适配，布局基于固定宽度（sidebar 230px、note-list 290px、ai-panel 400px）加拖拽可调，适合桌面端 Electron 窗口。
- **CSP 限制**：`index.html` 的 Content Security Policy 允许 `style-src 'self' 'unsafe-inline'`，因此内联样式在技术上可行但未被鼓励使用。
- **无构建步骤**：CSS 直接由浏览器加载，无预处理、无 CSS Modules、无 scoped 样式，依赖全局 class 命名约定避免冲突。