# NOTICE — 第三方组件许可声明

本文件列出 Synapse 运行时**捆绑或依赖**的、许可条款与本项目主体（GPL-3.0-or-later）不同的组件，
以及其源码获取方式。依据 GPL-3.0 §5 / LGPL-3.0 §0，再分发 Synapse 时必须随附本声明。

## 主体许可

- **Synapse** 本体：`GPL-3.0-or-later`（见仓库根目录 `LICENSE`）。
  - ⚠️ 历史遗留：`package.json` 曾长期声明 `"license": "MIT"`，与 `LICENSE` 文件不一致。
    已于引入 dl-js-reasoner 时一并修正为 `GPL-3.0-or-later`（融合设计 §10 风险 R9）。

## DL 推理引擎

| 项 | 内容 |
| --- | --- |
| 包名 | `dl-js-reasoner` |
| 版本 | `^0.3.0`（`dependencies`，随应用打包分发） |
| 许可 | **LGPL-3.0-or-later** |
| 用途 | 完整 OWL 2 DL 表达力的本地推理（一致性检查、类层级分类、实例类型实现、合取查询）。见 `src/main/graph/reason/dl.js` |
| 源码获取 | npm registry：`npm pack dl-js-reasoner`；或 <https://www.npmjs.com/package/dl-js-reasoner> |
| 兼容性 | LGPL-3.0 §0 明确允许按 GPL-3.0 条款再许可，故 **GPL-3.0-or-later + LGPL-3.0-or-later 兼容**，无需额外授权 |
| 替换权 | LGPL-3.0 §1 要求用户能够替换该库。Synapse 通过 Node 的 `require('dl-js-reasoner')` **动态装载**，且 `dl.js` 对模块缺失做了静默降级（`dlAvailable()` 返回 `false` → 跳过 DL 推理，其余功能不受影响），用户可自行替换 `node_modules/dl-js-reasoner` 下的实现 |

### 降级行为（与许可无关，但影响用户预期）

`dl-js-reasoner` 不可用时，Synapse **不会崩溃也不会报错**，而是：

- 导入预览的「完整 OWL 2 DL」一行显示 ❌，原因码 `dl-unavailable`；
- 推理跳过 DL 深度阶段，`skipReason` 记为 `dl-unavailable`；
- OWL 2 RL 前向链推理（`protege-js` 路径）照常工作。

## 其他运行时依赖

其余 `dependencies` / `devDependencies`（`electron`、`marked`、`dompurify`、`pdfkit`、
`@highlightjs/cdn-assets`、`@skaterqiang/protege-js` 等）均为 MIT / Apache-2.0 / BSD 系宽松许可，
与 GPL-3.0-or-later 兼容，各自许可文本见 `node_modules/<pkg>/LICENSE`。

---

⚠️ **发布前须法务复核**：本文件由工程侧依据公开许可文本整理，不构成法律意见。
