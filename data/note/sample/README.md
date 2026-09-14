# 样例案例集：顶层本体体系三步实操

本目录收录 10 个业务案例。每个案例**一个目录**，严格按下面三步组织资料与产物，用来演示 Synapse 的「顶层本体体系 → 图谱 → 校验 → 问答」完整闭环：

```
① 客户上传资料，根据顶层本体体系构建图谱
② 使用顶层本体体系的约束、公理校验图谱
③ 用户输入具体问题，根据图谱进行推理作答
```

底层推理引擎为 [protege-js](https://github.com/skaterqiang/protege-js)（`@skaterqiang/protege-js`，已作为真实 npm 依赖装入 Synapse），提供 OWL 2 RL 前向链物化、护栏（domain/range）校验与不相交冲突检测。

## 案例一览

| 案例目录 | 顶层本体体系 | 内容摘要 |
|---|---|---|
| [case1-ecommerce-risk](case1-ecommerce-risk/案例说明.md) | `bfo-lite` | 电商订单风控：黑名单买家订单自动归类为高风险，可信订单不相交冲突检测 |
| [case2-family-swrl](case2-family-swrl/案例说明.md) | `bfo-lite` | 家庭关系推理：亲属关系前向链推导与成年判定 |
| [case3-pharma-safety](case3-pharma-safety/案例说明.md) | `bfo` | 医疗用药安全：药物相互作用与禁忌配伍冲突检测 |
| [case4-knowledge-publishing](case4-knowledge-publishing/案例说明.md) | `bfo-lite` | 知识库内容发布：课程知识图谱多格式流转与发布前校验 |
| [case5-obda-profiles](case5-obda-profiles/案例说明.md) | `iso15926` | 企业数据集成（OBDA）：多源设备数据统一访问与影响面分析 |
| [case6-medical-ontology](case6-medical-ontology/案例说明.md) | `bfo` | 医疗本体层：疾病-症状-药物-检查知识图谱 |
| [case7-manufacturing-ppr](case7-manufacturing-ppr/案例说明.md) | `iso15926` | 制造业本体层：产品-工艺-资源（PPR）与 BOM 建模 |
| [case8-real-medical-bfo-ogms](case8-real-medical-bfo-ogms/案例说明.md) | `bfo` | 感冒临床诊疗路径：症状-检查-诊断-治疗闭环（BFO/OGMS 对齐） |
| [case9-real-manufacturing-iao](case9-real-manufacturing-iao/案例说明.md) | `iso15926` | 发动机缸体生产：工艺执行与质量追溯（IAO 信息工件本体） |
| [case10-ecommerce-customer-service](case10-ecommerce-customer-service/案例说明.md) | `bfo-lite` | 电商客服：智能工单分派、技能路由与紧急升级 |

## 每个案例目录的结构

```
caseN-<slug>/
├── 案例说明.md      # 业务背景 + protege-js 原始示例代码 + 「三步实操」章节
├── manifest.json    # 机器可读的案例契约：资料清单、绑定体系、第三步提问、预期结果
├── 资料/            # 第①步「客户上传的资料」（2 份 .md，建图语料）
│   ├── 01-….md
│   └── 02-….md
└── 报告.md          # 第①②③步的真实运行产物（由 runner 自动生成）
```

`manifest.json` 的 `steps` 字段逐步声明了入口 API 与 UI 等价操作，`expect` 字段写明每步的预期结果，`steps.step3.questions` 就是第三步要问的具体问题。

## 三步分别对应什么

**第①步 · 建图** — 把 `资料/` 下的文档作为「客户上传资料」，在提取弹窗**显式指定顶层本体体系**（即五级优先级链的第 ① 级），由 `graph.extractGraph()` 调 LLM 抽取节点/边并按体系归类。体系绑定见上表：`bfo` 案例走 `inheres_in`/`participates_in` 的定义域-值域护栏，`iso15926` 案例走 `classifiedBy`/`hasSuperclass` 护栏与 `composedOf`/`startsBefore` 传递性，`bfo-lite` 案例护栏覆盖率为 0%（该体系未声明 domain/range），第②步会如实呈现「不拦截」。

**第②步 · 校验** — `graph.validateGraph(profileId, {})`（IPC `graph:validate`，融合设计 §12.2.3 通道 C，**只读体检**）逐边检查谓词、定义域、值域与不相交公理，返回 `checked / violations / byReason / disjointConflicts / coverage` 等 11 个字段。UI 等价操作：本体定义 → 列表 → 推理 Tab → 全图校验。

**第③步 · 问答** — `graph.kgAsk()`（IPC `graph:ask`）：从问题识别图谱实体 → BFS 召回事实与影响面 → 带「知识图谱事实 + 原文材料」上下文作答，回答可回溯到 `资料/` 原文。UI 等价操作：AI 问答页输入问题。

## 运行方式

### 方式 A：在 Synapse 界面里手动走三步

1. 启动 Synapse：桌面模式 `npm start`，或浏览器模式 `npm run web`（http://localhost:8787）。
2. 侧边栏「笔记」→ `sample` 目录 → 打开某案例的 `资料/` 下两份文档（即客户上传资料）。
3. **第①步**：选中资料 →「生成图谱」→ 在弹窗里**显式选择该案例绑定的体系**（见上表）→ 开始提取。
4. **第②步**：「本体定义」→「列表」→「推理」Tab →「全图校验」，查看违规/不相交冲突/护栏覆盖率。
5. **第③步**：「AI 问答」页输入 `manifest.json → steps.step3.questions` 里的问题，查看带事实与原文引用的回答。

### 方式 B：headless 一键跑通（推荐用于批量验证）

```bash
cd d:/个人助手/Synapse/Synapse

node scripts/run-sample-cases.js --list                      # 列出全部案例 slug
node scripts/run-sample-cases.js case1-ecommerce-risk        # 只跑一个案例
node scripts/run-sample-cases.js                             # 跑全部 10 个案例
node scripts/run-sample-cases.js case3-pharma-safety --log run.log   # 附带实时日志文件
```

前置条件：本机 Ollama 已启动（`ollama serve`）且已拉取模型（默认 `qwen3.8:27b`）。可用环境变量覆盖：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `SYNAPSE_PROVIDER` | `ollama` | 服务商（回环地址免 API Key） |
| `SYNAPSE_BASE_URL` | `http://127.0.0.1:11434/v1` | OpenAI 兼容端点 |
| `SYNAPSE_MODEL` | `qwen3.8:27b` | 模型名 |

runner 会：读 `manifest.json` → 把 `资料/` 落成沙箱笔记 → ①`extractGraph`（显式指定体系）→ ②`validateGraph` + `runInference` → ③对每个问题跑 `kgAsk` → 把三步真实结果写成该案例目录下的 `报告.md`。

> **安全说明**：runner 运行在 `os.tmpdir()` 下的临时沙箱中（复用 `test/helpers/harness.js` 的 `bootEnv`），**不会污染仓库内真实的 `data/` 图谱与笔记**；唯一的仓库内写入是每个案例目录下的 `报告.md`。

## 相关文档

- [docs.md](docs.md) — 每个案例在 Synapse 界面中的逐步操作说明与 protege-js 命令行运行结果
- 各案例目录下的 `案例说明.md` — 业务背景、protege-js 原始示例源码、「三步实操」章节
- `docs/design/Synapse×protege-js融合设计.md` §12 — 三步闭环、五级体系优先级链、通道 C 全图校验的设计依据
