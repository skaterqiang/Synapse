# Synapse × protege-js 融合设计

> 分支：`Top_Level_Ontology`（延续）｜ 状态：**v1.2.2（一~三期已落地 + 冲突自动修复 + 修复作业化 + 逆谓词强制感知 + 校验全量计数；四/五期未启动）** ｜ 日期：2026-09-14（v0 草案 2026-09-11）
>
> **v1.1 增量**（本文中标 `v1.1` 的段落）：① 写侧互斥预检（护栏第 5 种 reason `disjoint-type-forcing`，把 `cax-dw` 消灭在写库前）；② **通道 D 冲突自动修复**（`reason/repair.js` + 规划/施加/撤销三接口 + 预览弹窗 UI，见 §12.2.8）；③ LLM 语义仲裁（`settings.graphRepairLlm`，默认关）。用户文档见 `docs/07-知识图谱.md` §7.5.8。
>
> **v1.2 增量**：修复改为以 `graph-repair` 作业执行（逐动作子任务，见 §12.2.8）。**v1.2.1 增量**：`guard.forcingProbes` 逆谓词强制感知（修复「徽标有冲突却规划不出动作」的盲区，见 §12.2.8 末段）。**v1.2.2 增量**：通道 C 校验返回全量计数 `totalViolations` / `totalDisjointConflicts`，修复「摘要条/报告计数被明细上限截断而少报」；越界边与不相交归属合并为**一张问题汇总表**（含所属体系/知识图谱归因列 + 两个筛选），每行可点击「修复」走行级规划 `graph:planRepairsForIssues`（见 §12.2.3）。
>
> 需求：将本地 `protege/protege-js`（OWL 2 模型层 Node.js 移植）的推理、解析、profile 校验能力引入 Synapse，在不引入 Java 依赖、不起服务端的前提下，补齐设计文档《多本体体系选择总体设计》§13.1 中的三期 ❌ 项与 OWL 导入体验差距。
>
> **阅读顺序建议**：先看 **§12 端到端三步流水线**（构建 → 校验 → 回答，用户视角的权威全链路），再按需下钻 §3–§6 的模块/界面细节。§0.2 的缺口表是 2026-09-11 的**立项基线**，其中标 ❌ 的行多数已在 v1 落地，落地状态以 §12.5 的实现状态表为准。

---

## 0. 背景与现状对照

### 0.1 protege-js 是什么

`protege/protege-js` 是 Protégé（Java/Swing，~1498 文件）**非 UI 核心**的 Node.js 移植，仅实现 **model 层**（可被 Synapse 这类项目复用），Swing 视图与 OSGi 插件机制刻意不移植。能力清单（以 `README.md` 与源码为准）：

| 模块 | 位置 | 能力 |
|---|---|---|
| OWL 2 RL 推理 | `src/inference/OWL2RLReasoner.js` | 78 条 W3C 规则前向链物化，含 6 大类（eq/prp/cls/cax/dt/scm） |
| OWL 2 QL / EL | `src/inference/OWL2ProfileReasoners.js` | RL 规则子集的最小推理机 |
| SWRL | `src/inference/SWRLReasoner.js` | 前向链规则引擎 + 30+ builtins（math/string/comparison） |
| 查询 | `src/inference/ReasonerQueries.js` | getSubClasses / getInstances / isSubClassOf / isSatisfiable |
| 三元组存储 | `src/inference/TripleStore.js` | 模式匹配 + RDF-list walker |
| profile 校验 | `src/profiles/OWL2Profiles.js` | RL / QL / EL 合规性检查（违规列表） |
| 全局约束 | `src/validation/GlobalRestrictionsValidator.js` | 全局限制校验 |
| 解析器（5 种） | `src/io/` | RDF/XML、Turtle、OWL 2 Functional、Manchester、OWL/XML |
| 序列化器（3 种） | `src/io/` | Turtle、Functional、RDF/XML（round-trip 不丢公理） |
| SWRL 解析 | `src/io/SWRLParser.js` | SWRL 文本规则 |

**API 形态**：CommonJS 类，`require` 即可在 Synapse 主进程使用。例如：

```js
const { OWL2RLReasoner, TripleStore } = require('@skaterqiang/protege-js/src/inference/OWL2RLReasoner');
const { NS } = require('@skaterqiang/protege-js/src/inference/rdf');

const r = new OWL2RLReasoner(new TripleStore());
// ⚠️ 谓词必须是**完整 IRI 字符串**，不能写 'rdfs:subClassOf' 这类前缀简写。
//    规则按 IRI 精确匹配触发，简写会被当成普通字面量，cax-sco 静默不生效。
//    用库导出的 NS 常量拼接最稳妥（NS.RDF / NS.RDFS / NS.OWL / NS.XSD）。
r.store.add('ex:A', NS.RDFS + 'subClassOf', 'ex:B');
r.store.add('ex:x', NS.RDF + 'type', 'ex:A');
r.materialize();              // 跑 78 条规则至不动点
r.entails('ex:x', NS.RDF + 'type', 'ex:B');   // true
r.isConsistent();                          // 是否有冲突
```

> 上面这段已实测可运行。若把 `NS.RDFS + 'subClassOf'` 换成 `'rdfs:subClassOf'`，
> `materialize()` 仍会跑完（`eq-ref` 等规则照常触发，store 也会增长），但
> `entails()` 返回 `false`——**不会报错，只会静默推不出结论**。这是集成时最容易
> 踩的坑，Synapse 侧封装时应统一走 `NS` 常量或先做前缀展开。

测试：`npm test` 281 通过（core + 80 条 OWL 2 RL 规则测试 + OWL 2 全规范 + 10 个业务案例 e2e + exports 映射回归）。

### 0.2 Synapse 当前真实缺口

> ⚠️ **本节是 2026-09-11 的立项基线快照，不是当前状态。** 表中「三期 ❌ reason.js」「二期 ❌ domain/range 护栏」「影响面分析 ❌」等行在 v1 已全部落地（`src/main/graph/reason/` 六个模块 + `graph.js` 的 `runInference`/`getReasonState`/`impactClosureFor`）。当前实现状态见 **§12.5**。

对照《多本体体系选择总体设计》§13.1 状态矩阵与 `src/main/graph/graph.js` 源码核实（2026-09-11）：

| 缺口 | 设计文档状态 | 代码现状 | 能否靠 protege-js 补 |
|---|---|---|---|
| 传递/对称/逆/Functional 推理 | 三期 ❌ `reason.js` 未实现 | `grep inferred/reasoner/forwardChain/materialize` 在 `src/main/**` 零匹配；公理只被声明/持久化/展示，无执行器 | ✅ 直接对接 OWL2RLReasoner |
| 影响面分析（D4 演示的根因定位） | 三期 ❌ | kgAsk 只做 BFS 邻居扩展（`graph.js:739-759`），无沿传递谓词的影响面计算 | ✅ ReasonerQueries + 传递闭包 |
| domain/range 护栏校验（§6.4） | 二期 ❌ | 未知谓词静默降级 `fallbackRel`，无违规日志 | ✅ 推理器在断言时即可判越界 |
| `validateGraphConstraints` 五元组校验 | 三期 ❌ | 后端 schema 预留 constraints，无校验逻辑 | ⚠️ 部分（OWL 构造约束 ≠ 业务数值约束） |
| aliases / status 六态机（术语归一/冲突裁决） | 三期 ❌ | 零实现 | ❌ 数据治理逻辑，protege-js 不涉及 |
| OWL 导入格式 | 二期 ✅（RDF/XML + Turtle） | `graph.js:851 importOwl` 走 `owl.js` 双解析器 | ✅ 扩到 6 种（+OWL/XML、Functional、Manchester、SWRL） |
| OWL profile 自动判别（RL/QL/EL） | 未提及 | 无 | ✅ `OWL2Profiles.js` 内建 |
| OWL 重导入 diff | §13.4 第 3 条 | 整体覆盖，无 diff | ✅ model 层可对比两版本本体 |

### 0.3 关键判断

**simple 自己写，complex 用库**——这是本设计的核心取舍：

| 能力 | 自己写工作量 | 用 protege-js 工作量 | 建议 |
|---|---|---|---|
| 传递/对称/逆/Functional 子集 | ~500 行 | ~50 行胶水 | **用库**（省得维护规则正确性） |
| OWL 2 RL 完整 78 条 | 极大且易错（涉及等价类、链式属性、构造子） | 0（已实现） | **必须用库** |
| SWRL 业务规则 | 需写规则解析器+模式匹配引擎 | 0 | **必须用库** |
| domain/range 写入护栏 | ~200 行（自维护类树） | ~30 行（查 profile） | **用库** |
| 影响面分析（沿传递谓词 BFS） | ~150 行 | ~50 行（ReasonerQueries） | **用库** |
| 五元组数值约束 | ~300 行 | protege-js 不做 | **自己写** |
| aliases 术语归一 / status 六态机 | ~400 行 | protege-js 不做 | **自己写** |
| OWL 导入 diff | ~100 行 | ~50 行 | **用库**（格式多） |

**结论**：推理、profile 校验、多格式解析用 protege-js；业务约束、术语归一、状态机自己写。两者正交互补。

---

## 1. 设计目标

| 编号 | 目标 | 对应设计文档缺口 | v1 状态 |
|---|---|---|---|
| G1 | **推理持久化**：推理产生的 `inferred:true` 边落 kv，前提删除时级联清理 | 三期 ❌ reason.js | ✅ |
| G2 | **提取时自动推理**：图谱提取完成后自动跑 OWL 2 RL 物化 | 三期 ❌ reason.js | ✅ |
| G3 | **domain/range 写入护栏**：写边时校验，违规记日志而非静默兜底 | 二期 ❌ §6.4 | ✅ |
| G4 | **影响面分析**：问答时沿传递谓词计算下游受影响节点 | 三期 ❌（D4 演示依赖） | ✅ |
| G5 | **OWL 导入扩展**：格式从 2 种扩到 6 种，导入前自动判别 profile | 二期 + 新增 | ✅ |
| G6 | **OWL 重导入 diff**：对比新旧版本，提示对既有节点的影响 | §13.4 第 3 条 | ❌ 五期未启动 |
| G7 | **SWRL 业务规则**：用户可在模版中定义可执行规则，提取时自动应用 | 新增 | ❌ 四期未启动 |
| G8 | **保留现有体验**：所有新能力为可选增强，关闭时行为与当前一致 | — | ✅（降级链见 §12.4 I5） |
| **G9** | **全图校验**：对已落库图谱按体系约束/公理做只读体检（v1 新增，源于 §12 步骤②） | §0.2 `validateGraphConstraints` 行的可形式化子集 | ✅ |

**非目标**：

- 不做完整 SPARQL 端点（ReasonerQueries 已覆盖 Synapse 场景）
- 不做术语归一 aliases、status 六态机（属数据治理，见 §7）
- 不做五元组数值约束校验（属业务规则引擎，见 §7）
- 不替换现有 `owl.js` 双解析器（作为兜底保留，新格式走 protege-js）

---

## 2. 总体架构

```
┌─────────────────────────────────────────────────────────────────┐
│  Synapse 主进程（Electron Main）                                 │
│                                                                  │
│  ┌──────────────┐    ┌─────────────────────────────────────┐   │
│  │  graph.js    │    │  graph/reason/  （新增目录）         │   │
│  │  （现状）     │◄───┤   bridge.js       ← 数据格式桥接      │   │
│  │              │    │   infer.js        ← 推理调度           │   │
│  │  - extract   │    │   guard.js        ← domain/range 校验 │   │
│  │  - kgAsk     │    │   impact.js       ← 影响面分析         │   │
│  │  - importOwl │    │   owlImport.js    ← 多格式导入         │   │
│  └──────────────┘    │   profile.js      ← RL/QL/EL 判别    │   │
│                      └──────────┬──────────────────────────┘   │
│                                 │ require                       │
│                      ┌──────────▼──────────────────────────┐   │
│                      │  protege/protege-js（本地路径或 npm） │   │
│                      │   inference/OWL2RLReasoner           │   │
│                      │   inference/SWRLReasoner             │   │
│                      │   inference/ReasonerQueries          │   │
│                      │   io/*Parser (5 种)                  │   │
│                      │   profiles/OWL2Profiles              │   │
│                      └──────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

**关键决策**：

- **D1**：protege-js 以**本地路径依赖**引入（`package.json` 的 `dependencies` 加 `"protege-js": "file:../protege/protege-js"`），不发 npm、不打进 asar。理由：① 本地仓库未 git 化，直接引用最稳；② 打包时 electron-builder 的 `asarUnpack` 已处理过类似场景（见仓库记忆 `synapse-env.md` 第 26 条），protege-js 全 JS 无原生模块，无需 unpack。
- **D2**：**新增 `src/main/graph/reason/` 子目录**，而非单文件 `reason.js`。理由：桥接/推理/护栏/影响面/导入/profile 六个职责各自独立，单文件会膨胀到 2000+ 行，违背 §10.6.4 的轻量定位。
- **D3**：**推理结果不直接写 kv**，而是先返回给 graph.js 由它决定如何持久化。理由：graph.js 是图谱数据的唯一写入口（`saveGraph`），保持单一写路径。
- **D4**：**推理是「批处理」而非「实时」**——提取完成后跑一次物化，把 inferred 边写回；问答时若图未变直接读缓存的 inferred 边，变了才重跑。理由：Synapse 图谱规模小（kv 整存整取），批处理足够；实时推理会拖慢每次写边。

---

## 3. 数据流与桥接

### 3.1 Synapse 图谱 → protege-js TripleStore

Synapse 图谱 schema（kv `'graph'`）：

```js
{ nodes: [{id, name, type, desc, sources[], domain, profile}],
  edges: [{from, to, rel}] }
```

protege-js TripleStore schema：RDF 三元组 `(subject, predicate, object)`，IRI 字符串。

**桥接规则**（`bridge.js`）：

| Synapse | TripleStore | 命名空间 |
|---|---|---|
| node.id | IRI `syn:id/<nodeId>` | `syn:` 自定义 |
| node.type | `syn:id/<nodeId> rdf:type syn:type/<typeKey>` | 类作为 IRI |
| node.name | `syn:id/<nodeId> rdfs:label "<name>"` | 字面量 |
| node.profile | `syn:id/<nodeId> syn:profile "<profileId>"` | 字面量 |
| edge (from, rel, to) | `syn:id/<from> syn:rel/<rel> syn:id/<to>` | 谓词作为 IRI |
| profile 类树 | `syn:type/<child> rdfs:subClassOf syn:type/<parent>` | 类层级 |
| profile 谓词特性 | `syn:rel/<key> rdf:type owl:TransitiveProperty`（等） | 特性标注 |
| profile axioms | 按公理类型映射到对应 OWL 公理 | 见 §3.2 |

**反向映射**（推理结果回写）：凡 TripleStore 中 `(s, p, o)` 三个 IRI 都以 `syn:id/` 开头、`p` 以 `syn:rel/` 开头、且该三元组**不在原始输入中**（由 `OWL2RLReasoner._inferred` 集合给出），则视为一条 inferred 边，转回 `{from, to, rel, inferred:true, inferredFrom:[前提边 ID 列表]}`。

### 3.2 公理映射

Synapse 体系公理 schema（`constants.js ONTOLOGY_PROFILES[*].axioms`）：

```js
{ type: 'DisjointClasses' | 'SubClassOf' | 'TransitiveProperty' |
         'SymmetricProperty' | 'AsymmetricProperty',
  ... 参数 }
```

映射到 OWL 公理（protege-js `model/OWLAxiom`）：

| Synapse axiom.type | OWL 公理 | 对应 RL 规则类别 |
|---|---|---|
| DisjointClasses(c1, c2, ...) | owl:AllDisjointClasses / 两两 owl:disjointWith | cls |
| SubClassOf(sub, sup) | rdfs:subClassOf | scm / cax |
| TransitiveProperty(p) | p rdf:type owl:TransitiveProperty | prp |
| SymmetricProperty(p) | p rdf:type owl:SymmetricProperty | prp |
| AsymmetricProperty(p) | p rdf:type owl:AsymmetricProperty | prp（冲突检测） |

profile predicates 上的 `features:['transitive'|'symmetric'|'functional'|'inverseFunctional']` 同样映射为对应 OWL 特性公理。

### 3.3 与现有 `owl.js` 的关系

`graph.js:851 importOwl` 当前走 `src/main/graph/owl.js`，只支持 RDF/XML + Turtle。本设计：

- **保留** `owl.js` 作为「已验证可工作」的兜底；
- **新增** `reason/owlImport.js`，对**非 RDF/XML/Turtle** 格式（OWL/XML、Functional、Manchester、SWRL）调用 protege-js 对应解析器；
- **判别顺序**：先用 `owl.js` 试解析 → 失败则按文件扩展名/内容特征选 protege-js 解析器；
- **统一输出**：两条路径最终都产出 `TopOntologyProfile`（§2.4 格式），下游 `resolveOntology` 不感知差异。

---

## 4. 核心模块设计

### 4.1 `reason/bridge.js` — 数据桥接

**职责**：Synapse 图谱 ↔ TripleStore 双向转换。

```js
// 伪代码
function graphToTriples(graph, profile) {
  const store = new TripleStore();
  // 1. 写入类层级
  for (const cls of profile.classes) {
    if (cls.parent) store.add(iriType(cls.key), RDFS.subClassOf, iriType(cls.parent));
  }
  // 2. 写入谓词特性
  for (const pred of profile.predicates) {
    for (const feat of pred.features || []) {
      store.add(iriRel(pred.key), RDF.type, OWL[capitalize(feat) + 'Property']);
    }
  }
  // 3. 写入公理
  for (const ax of profile.axioms || []) { /* 按 §3.2 映射 */ }
  // 4. 写入节点
  for (const n of graph.nodes) {
    store.add(iriId(n.id), RDF.type, iriType(n.type));
    store.add(iriId(n.id), RDFS.label, literal(n.name));
    store.add(iriId(n.id), SYN.profile, literal(n.profile));
  }
  // 5. 写入边
  for (const e of graph.edges) {
    store.add(iriId(e.from), iriRel(e.rel), iriId(e.to));
  }
  return { store, edgeIndex };  // edgeIndex 用于反查 inferredFrom
}

function triplesToInferredEdges(store, reasoner, edgeIndex) {
  // 遍历 reasoner._inferred，凡形如 (syn:id/X, syn:rel/R, syn:id/Y)
  // 且不在 edgeIndex 中的，转为 {from:X, rel:R, to:Y, inferred:true, inferredFrom:[...]}
}
```

**关键**：`edgeIndex` 记录每条原始边的 `(from, rel, to)` → 数组下标，反推时能标出每条 inferred 边是由哪些原始边推出的（用于级联清理）。

### 4.2 `reason/infer.js` — 推理调度

**职责**：调用 OWL2RLReasoner 跑物化，返回 inferred 边 + 冲突报告。

```js
async function materializeGraph(graph, profile, opts = {}) {
  const { store, edgeIndex } = graphToTriples(graph, profile);
  const reasoner = new OWL2RLReasoner(store);
  const t0 = Date.now();
  reasoner.materialize(opts.maxRounds || 1000);
  const inferredEdges = triplesToInferredEdges(store, reasoner, edgeIndex);
  return {
    inferredEdges,                    // 待写回的 inferred 边
    inconsistencies: reasoner.inconsistencies,  // false-consequent 规则触发的冲突
    stats: {
      inputTriples: graph.edges.length,
      inferredCount: reasoner.getInferredCount(),
      rounds: reasoner.getRounds(),
      elapsedMs: Date.now() - t0,
    },
  };
}
```

**调用点**：

1. **提取完成后**：`graph.js extractGraph` 尾部，写库前调用，把 inferred 边合入 `edges` 数组（标 `inferred:true`）；
2. **手动触发**：本体页加「重新推理」按钮，对当前图谱重跑；
3. **问答时**：`kgAsk` 前先检查图谱 mtime 是否晚于上次推理时间，是则先重跑（增量场景）。

**性能预算**：个人知识库图谱规模 < 1 万节点 / 5 万边，OWL 2 RL 78 条规则物化在该规模下预期 < 2s（protege-js sample/case* 实测数据可参考）。超过 5s 时在 UI 显示进度。

### 4.3 `reason/guard.js` — domain/range 写入护栏

**职责**：在 graph.js 写边前，校验 `(from.type, rel, to.type)` 是否符合谓词的 domain/range 约束。

```js
function checkEdge(profile, fromNode, rel, toNode) {
  const pred = profile.predicates.find(p => p.key === rel);
  if (!pred) return { ok: false, reason: 'unknown-predicate', fallback: profile.fallbackRel };
  // domain 校验：fromNode.type 是否 ∈ pred.domain 的子类闭包
  if (pred.domain && !isSubClassOf(profile, fromNode.type, pred.domain)) {
    return { ok: false, reason: 'domain-violation', expected: pred.domain, actual: fromNode.type };
  }
  // range 校验同理
  if (pred.range && !isSubClassOf(profile, toNode.type, pred.range)) {
    return { ok: false, reason: 'range-violation', expected: pred.range, actual: toNode.type };
  }
  return { ok: true };
}

function isSubClassOf(profile, child, ancestor) {
  // 沿 profile.classes[].parent 上溯，或用 ReasonerQueries
}
```

**接入点**：`graph.js extractGraph` 写边循环（约 :236-248 附近）改为：

```js
const verdict = checkEdge(profile, fromNode, rel, toNode);
if (!verdict.ok) {
  guardLog.push({ from: fromNode.name, rel, to: toNode.name, ...verdict });
  rel = profile.fallbackRel;  // 仍降级，但记日志
}
edges.push({ from, to, rel });
```

**UI 呈现**：提取作业完成后，作业摘要多一行「护栏拦截 N 条越界连线（已降级为「相关」）」，点击可展开查看明细。这直接回应《多本体体系选择总体设计》§13.4 第 1 条「护栏缺失期的数据污染」。

### 4.4 `reason/impact.js` — 影响面分析

**职责**：给定起点节点，沿指定传递谓词集合计算下游受影响节点。

```js
function impactClosure(graph, profile, seedId, opts = {}) {
  const transitiveRels = profile.predicates
    .filter(p => (p.features || []).includes('transitive'))
    .map(p => p.key);
  const inverseMap = buildInverseMap(profile);  // 处理逆谓词
  // BFS，沿 transitiveRels ∪ 其逆
  const visited = new Set([seedId]);
  const queue = [{ id: seedId, depth: 0, path: [] }];
  const impacted = [];
  while (queue.length) {
    const { id, depth, path } = queue.shift();
    if (depth >= (opts.maxDepth || 5)) continue;
    for (const e of graph.edges) {
      const hit = matchTransitive(e, id, transitiveRels, inverseMap);
      if (!hit) continue;
      if (!visited.has(hit.next)) {
        visited.add(hit.next);
        impacted.push({ id: hit.next, via: hit.rel, depth: depth + 1, path: [...path, hit.rel] });
        queue.push({ id: hit.next, depth: depth + 1, path: [...path, hit.rel] });
      }
    }
  }
  return impacted;
}
```

**问答集成**：`kgAsk` 在 BFS 邻居扩展（`graph.js:739-759`）之外，**可选**追加一步影响面扩展：

- 检测问题中是否含「影响」「下游」「依赖」「故障」等触发词；
- 若有，对每个种子节点跑 `impactClosure`，把结果作为额外 facts 注入 prompt；
- UI 在「邻居事实扩展完成」stage 之后再发一个「影响面扩展完成（沿传递谓词 X/Y/Z，共 N 个下游节点）」stage。

**与 D4 演示的关系**：D4 演示「变压器出问题影响什么」正是此能力的演示场景。实现后 D4 可从「目标态描述」转为「真实可用」。

### 4.5 `reason/owlImport.js` — 多格式 OWL 导入

**职责**：扩展 `importOwl`，支持 6 种格式。

```js
async function importOwlExtended(filePath, opts) {
  const ext = path.extname(filePath).toLowerCase();
  const head = readHead(filePath, 2048);  // 前 2KB 用于嗅探
  // 1. 先走现有 owl.js（RDF/XML、Turtle）
  if (ext === '.owl' || ext === '.rdf' || ext === '.ttl') {
    try { return await importOwlLegacy(filePath, opts); } catch (_) { /* 落到 protege-js */ }
  }
  // 2. 按扩展名/内容特征选 protege-js 解析器
  let parser;
  if (ext === '.ofn' || /Prefix\s*\(/.test(head)) parser = new FunctionalSyntaxParser();
  else if (ext === '.omn' || /Ontology:\s*/.test(head)) parser = new ManchesterSyntaxParser();
  else if (ext === '.owx') parser = new OWLXMLParser();
  else if (ext === '.swrl' || /rule/i.test(head)) parser = new SWRLParser();
  else parser = new RDFXMLParser();  // 兜底
  const ontology = parser.parse(readFile(filePath));
  return ontologyToProfile(ontology, opts);  // 复用现有转换
}
```

**导入前 profile 判别**（新增）：解析完成后调 `OWL2Profiles.js` 的 `checkRL/checkQL/checkEL`，在导入报告里告诉用户：

- 该本体属于哪个 profile（RL/QL/EL/均不满足）；
- 能否在 Synapse 本地跑推理（RL/QL/EL 任一满足即可）；
- 违规列表（若有），提示哪些构造子超出 RL 表达能力。

这直接提升 OWL 导入体验，对应 §13.4 第 3 条「OWL 导入无增量重解析对比」的姊妹需求。

### 4.6 `reason/profile.js` — profile 判别

```js
function detectProfile(ontology) {
  const rl = checkRL(ontology);   // 返回违规数组
  const ql = checkQL(ontology);
  const el = checkEL(ontology);
  return {
    rl: { ok: !rl.length, violations: rl },
    ql: { ok: !ql.length, violations: ql },
    el: { ok: !el.length, violations: el },
    recommend: !rl.length ? 'RL' : (!ql.length ? 'QL' : (!el.length ? 'EL' : null)),
    reasonerAvailable: !rl.length || !ql.length || !el.length,
  };
}
```

---

## 5. 推理结果的持久化与级联清理

### 5.1 kv schema 扩展

图谱 kv `'graph'` 当前结构 `{nodes, edges}`。本设计**不改动**该结构，只在 edge 对象上新增可选字段：

```js
{
  from, to, rel,
  inferred: true,               // 新增：是否推理产物
  inferredFrom: [edgeIdx, ...], // 新增：前提边在原 edges 数组的下标（级联清理的依据）
  inferredVia: 'transitive',    // 新增：推导途径（transitive / symmetric / inverse / subproperty / …），供 §6.2 tooltip 与统计分桶
  inferredAt: 1694400000000,    // 新增：推理时间戳
  inferredBy: 'owl2rl'          // 新增：推理器标识
}
```

**向后兼容**：旧图谱数据无 `inferred` 字段，读取时视为 `false`。`saveGraph`/`getGraph` 无需改。

> 📌 **实现注记（v1）**：`infer.js:mergeInferredEdges` 产出的正是上述 6 字段形态；`countInferred` 按 `inferredVia` 分桶（缺失记为 `'unknown'`）。`inferredVia` 是 v0 草案漏写、v1 补上的字段——§6.2 的推导路径 tooltip 与「推理」Tab 的「来源」统计都依赖它。

### 5.2 写入策略

`extractGraph` 流程尾部新增一步：

```
原始提取 edges → guard 校验（§4.3）→ 写库前先跑推理（§4.2）
  → inferred 边追加到 edges 数组
  → 整图 saveGraph
```

### 5.3 级联清理

**触发点**：用户删除某条边（renderer 图谱页）或某个节点时。

**逻辑**（在 graph.js 删除路径加钩子）：

```js
function removeEdgeWithCascade(graph, edgeIdx) {
  const removed = new Set([edgeIdx]);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < graph.edges.length; i++) {
      if (removed.has(i)) continue;
      const e = graph.edges[i];
      if (e.inferred && e.inferredFrom && e.inferredFrom.some(idx => removed.has(idx))) {
        removed.add(i);
        changed = true;
      }
    }
  }
  // 按 removed 集合重建 edges
  graph.edges = graph.edges.filter((_, i) => !removed.has(i));
  return removed.size - 1;  // 级联清理的 inferred 边数
}
```

**UI 反馈**：删除一条原始边时，若级联清理了 N 条 inferred 边，toast 提示「已删除该边及其 N 条派生推理边」。

> 📌 **实现注记（v1）**：`infer.js:removeEdgeWithCascade(graph, edgeIdxOrList)` 实际返回 **`{ removed, cascaded, edges }`**（对象，非数字），因为 graph.js 需要拿到重建后的边数组自行 `saveGraph`（约束 D3 单一写路径）。它同时兼容两种前提引用：`inferredFrom`（数组下标）与 `inferredFromKeys`（`from|to|rel` 身份键）——下标在合并/过滤后会漂移，身份键更稳。graph.js 的对外封装是 `deleteEdgeWithCascade(edgeIdx)` → `{ok, removed, cascaded, total, edge}`（5 字段）与 `deleteNodeWithCascade(nodeId)` → `{ok, nodeId, removedEdges, cascaded, nodeCount, edgeCount}`（6 字段），两者都会置 `graphMeta.inferredStale = true`。

### 5.4 图谱变更时的重推理

- 节点/边**新增**：不自动重推理（避免拖慢提取），等下次提取完成或手动触发；
- 节点/边**删除**：先做级联清理（§5.3），再标记 `graphMeta.inferredStale = true`，下次 `kgAsk` 前重跑；
- 图谱**清空**：`clearGraph` 同时清 `graphMeta`。

`graphMeta` 存 kv `'graph.meta'`，**恰好 4 个字段**（v1 实测，`graph.js:getGraphMeta`）：

```js
{
  lastInferredAt: 1694400000000, // 上次物化时间；clearGraph 归零
  inferredStale: false,          // 删除节点/边后置 true，kgAsk 前惰性重跑
  lastStats: {                   // 上次推理统计（skipped 时只有 {skipped,skipReason,at}）
    skipped, skipReason, inferredEdges, inconsistencies /* 数量 */,
    inconsistencyDetails,        // {total, truncated, items:[{rule,message,profileId,profileName}]}，明细上限 50
    elapsedMs, rounds, profileId, at
  },
  lastGuard: {                   // 上次提取的护栏拦截汇总（v0 草案漏写，v1 补上）
    total, byReason, byRel,
    entries,                     // 最多 50 条明细（summarizeGuardLog 内部先截 200）
    profileId, at
  }
}
```

> 📌 `lastGuard` 是「推理」Tab 第 ③ 区块（§6.6 护栏拦截日志）的唯一数据源——没有它，护栏日志在应用重启后就丢了。`clearGraph()` 会把 meta 重置为 `{lastInferredAt:0, inferredStale:false, lastStats:null, lastGuard:null}`（测试 `graph-reason-integration.test.js:108` 按精确 JSON 断言，改字段即破坏契约）。

---

## 6. 前端改进与用户体验提升

> 本节把 protege-js 带来的后端能力**翻译为前端可感知的变化**。所有改动落在 `src/renderer/`（Canvas 力导向图 + DOM 面板 + 原生 select/checkbox），无新框架引入；涉及 `index.html` 新增容器 + `renderer/graph.js` 绘图逻辑 + `renderer/raws.js` 提取弹窗 + `renderer/app.js` 事件绑定。

### 6.0 前端改动总览

| 页面/视图 | 当前文件 | 新增能力 | 用户可感知的变化 |
|---|---|---|---|
| 图谱页 · Canvas | [graph.js:943 drawGraph](Synapse/src/renderer/graph.js#L943) | 推理边虚线渲染 + 悬停推导路径 tooltip | 「这条关系是 AI 推出来的」一眼可辨 |
| 图谱页 · 筛选栏 | [index.html:221-224](Synapse/src/index.html#L221) | 新增「推理边」筛选（全部/仅原始/仅推理） | 可单独看 AI 推理贡献了什么 |
| 图谱页 · 节点详情 | [graph.js:521 renderKgEntityDetail](Synapse/src/renderer/graph.js#L521) | 新增「影响面」区块 | 「这个节点出问题会牵连谁」直接列出 |
| 图谱页 · 统计行 | [graph.js:225 renderGraphStats](Synapse/src/renderer/graph.js#L225) | 增加「其中 N 条推理得出」 | 图谱规模里多少来自 AI 一目了然 |
| 本体页 · 新 Tab | [index.html:283 kg-onto-tabs](Synapse/src/index.html#L283) | 新增「推理」Tab（统计 + 冲突 + 护栏日志） | 推理质量与越界拦截集中可见 |
| 提取弹窗 | [raws.js autoDomainAndExtract](Synapse/src/renderer/raws.js) | 新增「自动推理」勾选项 + 进度 stage | 提取过程透明，知道哪一步在跑推理 |
| 问答页 | [index.html:296-306 kg-ask](Synapse/src/index.html#L296) | 影响面 stage + 答案标注「含推理事实」 | 知道答案是否依赖了推理链 |
| OWL 导入弹窗 | 新增模态 | 解析报告 + 类树预览 + profile 判别 | 导入前就知道这个本体能不能跑推理 |
| 作业详情 | [jobs.js](Synapse/src/renderer/jobs.js) | 作业摘要多一行「推理 +N 边 / 护栏拦 N 条」 | 每次提取的推理贡献可回溯 |

### 6.1 图谱页：推理边的视觉区分（最核心的前端变化）

**当前状态**（[graph.js:943-1000](Synapse/src/renderer/graph.js#L943)）：所有边统一 `strokeStyle='rgba(138,145,159,0.5)'` + 实线 + 灰色箭头，**无法区分原始抽取与推理产出**。

**改进**：inferred 边改为**虚线 + 半透明 + 紫色系**，并在弧线中点的谓词标签旁加一个 ⚡ 小标记。

```js
// drawGraph 边绘制循环内（graph.js:962 附近）
for (const e of graphSim.edges) {
  const a = byId.get(e.from), b = byId.get(e.to);
  if (!a || !b) continue;
  // ... 坐标计算不变 ...
  
  // 新增：推理边视觉区分
  const isInferred = !!e.inferred;
  ctx.strokeStyle = isInferred ? 'rgba(139,92,246,0.45)' : 'rgba(138,145,159,0.5)';
  ctx.lineWidth = isInferred ? 1.2 : 1;
  if (isInferred) ctx.setLineDash([5, 4]);   // 虚线
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.quadraticCurveTo(qx, qy, bx, by); ctx.stroke();
  ctx.setLineDash([]);                        // 立即复位，避免污染后续绘制
  
  // 箭头颜色同步
  ctx.fillStyle = isInferred ? 'rgba(139,92,246,0.6)' : 'rgba(138,145,159,0.7)';
  // ... 箭头绘制不变 ...
}
```

**谓词标签层**（[graph.js:1154-1172](Synapse/src/renderer/graph.js#L1154) 附近）：inferred 边的谓词文字后追加 ` ⚡`，颜色同步紫色：

```js
// drawGraphLabels 内的谓词标签绘制
const label = e.inferred ? `${e.rel} ⚡` : e.rel;
ctx.fillStyle = e.inferred ? '#8b5cf6' : '#8a919f';
```

**用户可感知**：「图谱里哪些关系是文档明确说的、哪些是 AI 推出来的」从一片灰变成一眼可分。

### 6.2 图谱页：悬停显示推导路径

**新增 tooltip**：鼠标悬停在 inferred 边上时，浮出小卡片显示「推理自：」+ `inferredFrom` 数组里每条前提边的 `from —rel→ to`。

**实现**：`drawGraph` 已有 `graphSim.drag` 命中检测逻辑，新增 `graphSim.hover`：

```js
// graphTick 内检测鼠标位置是否落在 inferred 边的弧线附近
canvas.addEventListener('mousemove', (ev) => {
  // ... 现有节点 hover 检测 ...
  if (!hoverNode) {
    const hoverEdge = pickEdgeAt(mx, my);  // 新增：按到贝塞尔曲线距离 < 5px 判定
    if (hoverEdge && hoverEdge.inferred) {
      showEdgeTooltip(hoverEdge, mx, my);  // 显示推导路径
    } else hideEdgeTooltip();
  }
});

// tooltip 内容
function edgeTooltipHtml(e) {
  const g = state.graph;
  const lines = (e.inferredFrom || []).map(idx => {
    const p = g.edges[idx];
    return p ? `<div class="tt-row">${esc(p.from)} —${esc(p.rel)}→ ${esc(p.to)}</div>` : '';
  }).join('');
  return `<div class="tt-head">⚡ 推理边 · ${esc(e.rel)}</div>
          <div class="tt-sub">推理自以下 ${(e.inferredFrom||[]).length} 条前提：</div>
          ${lines}
          <div class="tt-foot">推理器：${esc(e.inferredBy||'owl2rl')} · ${formatDate(e.inferredAt)}</div>`;
}
```

**用户可感知**：不再是「黑盒 AI 说这有关系」，而是「因为 A→B 且 B→C 所以 A→C」——推理可解释、可审计、可质疑。

### 6.3 图谱页：筛选栏加「推理边」过滤

**位置**：[index.html:221-224](Synapse/src/index.html#L221) 现有筛选行（体系 / 图谱 / 最多节点 / 排序）后追加一个 select：

```html
<label>边类型 <select id="kg-g-edgekind">
  <option value="all" selected>全部</option>
  <option value="raw">仅原始</option>
  <option value="inferred">仅推理</option>
</select></label>
```

**过滤逻辑**（[graph.js:417 kgFilteredGraph](Synapse/src/renderer/graph.js#L417)）：

```js
// 现有 type/profile/scope 过滤之后追加
const edgeKind = $('kg-g-edgekind')?.value || 'all';
if (edgeKind === 'raw') edges = edges.filter(e => !e.inferred);
if (edgeKind === 'inferred') edges = edges.filter(e => !!e.inferred);
// 注意：仅推理时可能产生「边在但端点节点被过滤掉」的孤立边，
// 需反向保留「至少一条边幸存」的节点，或允许孤立节点显示（倾向后者，看推理产出了什么新连接）
```

**用户可感知**：一键切换「只看文档原文说的」vs「只看 AI 推出来的」——评估推理质量、发现意外连接。

### 6.4 图谱页：统计行加推理计数

**位置**：[graph.js:225](Synapse/src/renderer/graph.js#L225)

```js
// 当前
$('graph-stats').textContent = `实体 ${g.nodes.length} · 边 ${g.edges.length}` + ...;

// 改为
const inferredCount = g.edges.filter(e => e.inferred).length;
const inferredPart = inferredCount ? `（其中 ${inferredCount} 条推理得出）` : '';
$('graph-stats').textContent = `实体 ${g.nodes.length} · 边 ${g.edges.length}${inferredPart}` + ...;
```

**图例行**（[graph.js:133 renderGraphLegend](Synapse/src/renderer/graph.js#L133)）：在类型图例末尾追加一行：

```html
<div class="kg-legend-row">
  <span class="kg-legend-item"><i style="border-top:2px dashed #8b5cf6;width:14px"></i>推理边</span>
  <span class="kg-legend-item"><i style="border-top:1px solid #8a919f;width:14px"></i>原始边</span>
</div>
```

### 6.5 图谱页：节点详情面板加「影响面」区块

**位置**：[graph.js:521 renderKgEntityDetail](Synapse/src/renderer/graph.js#L521)

**当前结构**：头部（类型徽标+名称）→ desc → sources → 出边/入边清单 → 「看邻居图」按钮。

**新增「影响面」区块**（插在「入边」之后、「看邻居图」按钮之前）：

```html
<div class="gd-sec">影响面（沿传递谓词下游）<span class="mini-tag">${impacted.length} 个节点</span></div>
<div class="kg-impact-list">
  ${impacted.map(it => `
    <div class="kg-impact-row" data-id="${it.id}">
      <span class="kg-impact-depth" title="推理深度">L${it.depth}</span>
      <span class="kg-impact-name">${esc(nodeName(it.id))}</span>
      <span class="kg-impact-via">经 ${esc(it.via)}</span>
    </div>`).join('') || '<div class="gd-desc">（无下游影响）</div>'}
</div>
```

**数据来源**：renderer 新增 IPC `graph:impactClosure(nodeId)`，主进程走 `reason/impact.js` 计算并缓存（kv `graph.impactCache[nodeId] = {at, result}`，图变更时失效）。

**点击行**：跳转到该节点详情（复用现有 `renderKgEntityDetail(id)`），支持「沿影响链逐级下钻」。

**用户可感知**：「变压器」详情里直接列出「低压配电柜 → 充电桩群 → 20 个车位」——D4 演示场景在 UI 落地。

### 6.6 本体页：新增「推理」Tab

**位置**：[index.html:283 kg-onto-tabs](Synapse/src/index.html#L283)

当前 Tab 结构（从 [graph.js:566 renderKgOntology](Synapse/src/renderer/graph.js#L566) 看，含类/谓词/约束/公理等），新增第 5 个 Tab：

```html
<button class="kg-tab" data-tab="reason">推理 <span class="kg-badge" id="kg-reason-badge"></span></button>
```

**Tab 内容**（`kg-onto-body` 内渲染）分四区块：

```
┌─ 上次推理 ─────────────────────────┐
│ 时间：2026-09-11 18:52             │
│ 推理边：+127 条（占全图 18%）       │
│ 轮数：4 轮收敛 · 耗时 1.8s          │
│ [重新推理]  [清除所有推理边]         │
└────────────────────────────────────┘
┌─ 不一致冲突（inconsistencies）──────┐
│ ⚠ prp-asymp：边「A 包含 B」与「B   │
│   包含 A」违反 AsymmetricProperty   │
│ ...                                │
└────────────────────────────────────┘
┌─ 护栏拦截日志（按作业分组）─────────┐
│ ▾ 作业 #42（2026-09-11 18:30）     │
│   · 未知谓词「配套」→ 降级为「相关」│
│   · domain 越界：容量 —应用于→ 充电桩│
│     （应用于 的 domain 是 activity）│
└────────────────────────────────────┘
┌─ 谓词特性一览 ──────────────────────┐
│ 传递：composedOf / partOf / ...    │
│ 对称：relatedTo / ...              │
│ 函数：hasCapacity / ...            │
└────────────────────────────────────┘
```

**用户可感知**：推理不再是后台黑盒，而是有统计、有冲突报告、有护栏日志的**可观测子系统**。

### 6.7 提取弹窗：加「自动推理」勾选 + 推理 stage

**位置**：[raws.js autoDomainAndExtract](Synapse/src/renderer/raws.js) 弹窗

**新增勾选**（在「确认提取」按钮上方）：

```html
<label class="checkbox-row">
  <input type="checkbox" id="extract-auto-reason" checked />
  提取完成后自动运行 OWL 2 RL 推理（推荐，耗时约 1-2s）
</label>
```

**作业 stage 流**（[graph.js extractGraph](Synapse/src/main/graph/graph.js#L169) 的 `onStage` 回调）新增两个：

```
... 现有 stage：解析文件 → 抽取实体 → 抽取关系 → 写库 ...
→ 新增 stage「护栏校验中…」（§4.3 guard）
→ 新增 stage「OWL 2 RL 推理中…（第 N 轮）」（§4.2 infer，带轮数进度）
→ 新增 stage「推理完成：+N 条推理边 / 拦 N 条越界」
```

**用户可感知**：提取过程从「黑盒等待」变成「看得见每一步在做什么」，尤其推理阶段的轮数进度让人安心（不会以为卡死）。

### 6.8 问答页：影响面 stage + 推理事实标注

**位置**：[index.html:296-306 kg-ask](Synapse/src/index.html#L296)

**stage 区新增**（在「邻居事实扩展完成」之后）：

```
✓ 实体抽取完成：变压器、充电桩
✓ 邻居事实扩展完成（3 跳内）：共 12 条事实
✓ 影响面扩展完成：沿 composedOf/connectedTo 找到 5 个下游节点   ← 新增
✓ 原文回溯完成：命中 3 份材料
```

**事实清单标注**（`kg:facts` 渲染）：inferred 事实行末尾加 `<span class="kg-fact-inferred">⚡推理</span>` 徽标。

**答案引用标注**：当 LLM 答案引用了 inferred 事实时，答案区底部加一行小字：「本回答包含 N 条由 OWL 2 RL 推理得出的事实（点击查看推导路径）」。

**用户可感知**：知道答案的哪些部分依赖了推理链、能跳回图谱查看推导过程——**推理可解释性在问答闭环中落地**。

### 6.9 OWL 导入弹窗：解析报告 + 类树预览

**新增模态**（`index.html` 新 container）：选择 OWL 文件后、确认导入前弹出。

```
┌─ OWL 导入预览 ─────────────────────────────┐
│ 文件：bfo-2020.owl                          │
│ 检测到格式：OWL 2 Functional Syntax         │
│                                            │
│ Profile 判别：                              │
│   ✅ OWL 2 RL（可本地推理）                 │
│   ✅ OWL 2 QL                              │
│   ❌ OWL 2 EL（3 处违规，见下）             │
│                                            │
│ 内容统计：                                  │
│   类 21 · 谓词 15 · 公理 18 · SWRL 规则 3  │
│                                            │
│ 类树预览：                                  │
│   └─ entity                                │
│      ├─ continuant                         │
│      │  ├─ independent_continuant          │
│      │  └─ ...（复用 renderOntologyTree）  │
│                                            │
│ ⚠ 警告：                                    │
│   · 2 个类无 parent，将挂到根               │
│   · 1 个谓词特性在 RL 中不支持（已忽略）     │
│                                            │
│         [取消]  [确认导入]                  │
└────────────────────────────────────────────┘
```

**用户可感知**：导入前就知道「这个本体能不能跑推理、有多少内容、有什么坑」——避免盲导入后发现「推理跑不动」或「类树乱掉」。

### 6.10 作业详情：推理贡献可回溯

**位置**：[jobs.js](Synapse/src/renderer/jobs.js) 作业卡片

**作业摘要新增一行**（在「解析方式」「文件数」等现有行后）：

```
推理：+24 条推理边（4 轮收敛，1.6s）· 护栏拦 2 条
```

点击展开看 inferred 边清单与 guardLog 明细。

**用户可感知**：每次提取的推理贡献可回溯、可对比——「这次提取比上次多推了 10 条，是因为新增的文档里触发了传递闭包」。

### 6.11 设置页：推理全局开关

**位置**：设置 → 知识图谱（假设存在该分组；若无则新增）

```html
<label class="checkbox-row">
  <input type="checkbox" id="set-reason-enabled" checked />
  启用 OWL 2 RL 推理（关闭后所有推理功能停用，含提取时自动推理、影响面、推理 Tab）
</label>
<label>
  推理超时（秒） <input type="number" id="set-reason-timeout" min="5" max="120" value="30" />
</label>
```

**兜底**：关闭时所有前端入口（提取弹窗勾选、推理 Tab、影响面区块）置灰 + 提示「推理已在设置中关闭」。

### 6.12 前端改动量估算

| 文件 | 改动 | 行数估算 |
|---|---|---|
| `renderer/graph.js` | drawGraph 虚线 + hover tooltip + 筛选 + 影响面区块 + 推理 Tab 渲染 | +400 |
| `renderer/raws.js` | 提取弹窗勾选 + stage 监听 | +50 |
| `renderer/app.js` | IPC 绑定（graph:impactClosure / graph:reasonStats 等） | +80 |
| `renderer/jobs.js` | 作业摘要推理行 | +30 |
| `index.html` | 筛选 select + 推理 Tab 容器 + OWL 导入模态 + 设置项 | +120 |
| `styles.css` | 推理边紫色系 + tooltip 卡片 + 影响面行样式 + 推理 Tab 布局 | +200 |
| **合计** | | **约 +880 行** |

**无新框架引入**：全部基于现有 Canvas + DOM + 原生表单控件，不引入 D3/cytoscape 等。

### 6.13 前端验收清单（每个能力一条用户故事）

| 编号 | 用户故事 | 验收方式 |
|---|---|---|
| F1 | 我在图谱页看到紫色虚线边，知道这是 AI 推的 | 截图对比推理前后图谱 |
| F2 | 我悬停虚线边，看到「因为 A→B 且 B→C 所以 A→C」 | tooltip 截图 |
| F3 | 我切「仅推理」筛选，单独看 AI 贡献了哪些连接 | 筛选前后边数对比 |
| F4 | 我在「变压器」详情里看到「影响面：低压配电柜/充电桩群/20 个车位」 | 详情面板截图 |
| F5 | 我提取时看到「OWL 2 RL 推理中…第 3 轮」进度 | stage 日志截图 |
| F6 | 我在问答「X 出问题影响什么」时看到「影响面扩展完成」stage | stage 日志截图 |
| F7 | 我导入 OWL 前看到「可推理/不可推理 + 违规清单」 | 导入预览截图 |
| F8 | 我在本体页「推理」Tab 看到「护栏拦了 2 条越界连线」 | 推理 Tab 截图 |
| F9 | 我删除一条原始边后看到「级联清理了 3 条推理边」toast | 删除操作录屏 |
| F10 | 我关闭设置的推理开关后，所有推理入口置灰 | 设置页截图 |

---

## 7. 不在本设计范围内（明确边界）

以下能力**与 protege-js 正交**，无论是否引入 protege-js 都需要独立设计：

| 能力 | 归属 | 建议立项 |
|---|---|---|
| 五元组数值约束 `validateGraphConstraints` | 业务规则引擎 | 另立「约束校验」设计，输入为 §0.5 五元组 schema，输出校验报告；可用简单表达式求值器实现，不需 OWL 推理 |
| aliases 术语归一 | 数据治理 | 另立「实体归一」设计，涉及同义词库、embedding 相似度、人工确认工作流 |
| status 六态机（pending/accepted/conflicted/...） | 数据治理 | 与 aliases 同设计，属断言生命周期管理 |
| 跨体系映射表 | 本体对齐 | 《多本体体系选择总体设计》§12 决策 2 已定「默认不自动对齐」，二期做手动对齐提示；protege-js 的 `owl:equivalentClass`/`owl:sameAs` 可作为未来自动对齐的表达基础，但当前不实施 |
| 演示中心（§9） | 产品演示 | 依赖本设计 G1+G4 落地后再启动 D3/D5/D6；D1/D2/D4/D7/D10 可先做 |

---

## 8. 实施分期

| 期 | 内容 | 工作量估算 | 依赖 | v1 状态 |
|---|---|---|---|---|
| **一期**（推理核心） | bridge.js + infer.js + 提取时自动推理 + inferred 边持久化 + 级联清理 + 图谱页虚线渲染 | 3 天 | protege-js 本地路径依赖接入 | ✅ 已交付 |
| **二期**（护栏 + 影响面） | guard.js + 护栏日志 UI + impact.js + 问答集成 | 2 天 | 一期 | ✅ 已交付 |
| **三期**（OWL 导入扩展） | owlImport.js + profile.js + 导入预览 UI + profile 判别 | 2 天 | 独立 | ✅ 已交付 |
| **六期**（端到端贯通，v1 新增） | §12 三步流水线文档化 + 体系优先级两入口对齐 + `validate.js` 全图校验通道 C + 「推理」Tab 第 ⑤ 区块 | 1 天 | 一/二期 | ✅ 已交付 |
| **四期**（SWRL） | 模版中 SWRL 规则编辑 UI + 提取时应用 | 3 天 | 一期（规则作用在图谱上） | ❌ 未启动 |
| **五期**（重导入 diff） | 重导入时新旧版本对比 + 影响提示 | 1 天 | 三期 | ❌ 未启动 |

**一/二/三/六期已交付**（约 8 个工作日）；剩余四/五期约 4 个工作日，可并行。

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| protege-js 本地路径依赖在打包后失效 | 桌面端推理功能不可用 | ① `package.json` 用 `file:` 协议；② electron-builder 打包前把 protege-js 复制到 `node_modules`；③ 打包脚本加验证步骤（参照 `scripts/verify-unpacked.js` 模式） |
| 推理耗时超预期 | 提取流程变慢 | ① 默认开启但在提取弹窗可关；② 图谱规模超阈值（如 5000 节点）时提示「图谱较大，推理可能耗时 N 秒」；③ 超时保护（>30s 自动中断并保留原始边） |
| inferred 边污染图谱 | 用户分不清哪些是原始边 | ① 虚线渲染 + 筛选器；② 删除原始边时级联清理 inferred 边；③ 图谱页提供「清除所有推理边」一键还原 |
| OWL 导入格式判别错误 | 解析失败 | 保留现有 `owl.js` 作为 RDF/XML+Turtle 的兜底；新格式解析失败时回退并提示用户手动指定格式 |
| SWRL 规则写错导致死循环 | 推理卡死 | `materialize(maxRounds=1000)` 有上限；SWRL 规则编辑器加语法校验；提取时规则应用加超时 |
| 与 `owl.js` 双解析器行为不一致 | 同一文件两条路径产出不同 profile | 统一以 protege-js 解析结果为准（其覆盖 OWL 2 全规范更完整）；`owl.js` 仅在 protege-js 不可用时启用 |

---

## 10. 与既有设计文档的关系

- **《多本体体系选择总体设计》**：本设计是其 §10.6.4「reason.js（新文件，三期）」的**具体化与扩展**——从单文件扩为 `reason/` 子目录，从「四个轻量推理器」扩为「OWL 2 RL 完整 + SWRL + 影响面 + 护栏 + 导入扩展」。§13.1 中对应的 ❌ 项（reason.js、validateGraphConstraints、domain/range 护栏、演示中心 D4）在本设计落地后可逐项翻 ✅。
- **《多领域自动拆分提取设计》**：无直接交互，但多领域拆分后每个领域独立跑图谱作业，推理也在每个作业的图谱上独立跑，互不影响。
- **《提取去重判断方案》**：无交互。去重判断在提取提交前，推理在提取完成后。

---

## 11. 开放问题（v1 已裁决 4 条，余 1 条待评审）

1. **protege-js 依赖形式**：`file:../protege/protege-js` 本地路径 vs 把 protege-js 发布为私有 npm 包 vs 直接 vendored 进 `Synapse/src/lib/`？倾向本地路径（最简单），但打包流程需验证。
   → **仍开放**。当前 `package.json` 用 `"@skaterqiang/protege-js": "file:../protege/protege-js"`，打包验证未做（§9 风险 1）。
2. ~~**推理默认开启还是默认关闭**~~ → **已裁决：默认开启**。`graph.js:reasonEnabled(settings)` 在 `settings.reasonEnabled !== false` 且 `reasonReady()` 为真时返回 true；提取弹窗复选框默认勾选，仅当用户**显式取消**才下发 `autoReason:false`（`raws.js:submitGroup`）。
3. ~~**inferred 边是否参与召回**~~ → **已裁决：参与**。`recallFor` 遍历 `g.edges` 不过滤 `inferred`；`kgAsk` 的 BFS 同样不过滤，影响面闭包显式传 `includeInferred:true`。标注方式：影响面事实串带 `（N 跳，⚡推理）` 后缀，前端加 `.kg-fact-inferred` 类（紫色左边框 + `⚡` 前缀）。
4. ~~**影响面分析的触发方式**~~ → **已裁决：关键词触发**。`impact.detectImpactIntent(question)` 命中 10 个关键词之一才跑闭包（清单见 §12.3.4），不命中则 `impact === null` 且不发 stage。
5. **SWRL 规则的作用范围**：规则是绑定到领域模版（每个模版一组规则），还是绑定到体系 profile（每个 profile 一组规则），还是全局一组？倾向**绑定到领域模版**（最贴近业务语义），但需在模版编辑器加 SWRL 文本编辑区。
   → **仍开放**（四期未启动，`src/main/**` 无 `SWRLReasoner` 引用）。

---

## 12. 端到端三步流水线（构建 → 校验 → 回答）

> 本节是**用户视角的权威全链路描述**，把散落在 §3–§6 的模块细节串成一条可验收的流水线。
> 三步的原始表述：
>
> 1. **客户上传资料，根据顶层本体体系构建图谱**
> 2. **使用顶层本体体系的约束、公理校验图谱**
> 3. **用户输入的具体问题，根据图谱来进行推理做回答**
>
> 本节所有代码锚点、字段数、计数均在 2026-09-13 对 `src/main/graph/**`、`src/main/jobs/jobs.js`、`src/renderer/**`、`test/**` 逐项核实（核实依据见 §12.6）。

### 12.0 三步总览

| 步骤 | 输入 | 输出 | 主入口 | 本体体系在此步的作用 | 失败时的降级 |
|---|---|---|---|---|---|
| **① 构建** | 笔记 / 原始文件 / 粘贴文本 | `{nodes, edges}`（**仅原始边**） | `graph.extractGraph()` ← `jobs.graph()` | 决定**类表**（节点 `type` 取值域）、**受控谓词表**（边 `rel` 取值域）、**提示词模式**（flat / two-stage） | 单来源失败 → 记 `failedTasks` 可单独重跑；全部失败 → 抛错；护栏不可用 → 静默按 `fallbackRel` 兜底 |
| **② 校验 + 物化** | 步骤①的原始图 | `inferred:true` 边 + `inconsistencies` 冲突明细 + `graphMeta` | `graph.runInference()`（手动/自动）、`guard.checkEdge()`（写前） | **约束**（domain/range）= 写入护栏；**公理**（传递/对称/互逆/子类/不相交）= 物化燃料 + 冲突来源 | 推理层不可用 / 超时 / 无燃料 → `skipped` + `skipReason`，**原始图已先落库不丢** |
| **③ 回答** | 用户自然语言问题 | 流式回答 + `kg:facts`（匹配实体 / 事实 / 引用 / 影响面） | `graph.kgAsk()` | 主导体系的提示词做实体识别；节点 `[体系·类型]` 标签进事实串；传递谓词驱动影响面闭包 | 图谱空 → 报错引导；LLM 抽不到实体 → 两级兜底召回；无命中 → 仅靠全局材料作答；推理刷新失败 → 按现有图谱继续 |

```
┌── 步骤① 构建 ──────────────────────────────────────────────────────┐
│ 资料（笔记/原始文件/粘贴文本）                                        │
│   │                                                                 │
│   ├─▶ 体系选择（§12.1.1 五级优先级）                                 │
│   │      弹窗显式 > 领域模版绑定 > 模型动态选择 > settings 兜底 > bfo-lite │
│   │                                                                 │
│   ├─▶ 领域判定（matchTemplate / suggestTemplateName / generateTemplate）│
│   │      → typeHints（实体类 + 概念类）                              │
│   │                                                                 │
│   ├─▶ AI 抽取（每来源一批，SOURCE_CHARS=1500；bfo/iso15926 走 two-stage）│
│   │                                                                 │
│   ├─▶ 写前护栏 guard.checkEdge（domain/range，4 种 reason）           │
│   │      + 写侧互斥预检（v1.1，第 5 种 reason disjoint-type-forcing）  │
│   │      违规 → 降级 fallbackRel + guardLog                          │
│   │                                                                 │
│   └─▶ saveGraph(原始图)   ← ⚠️ 先落库，推理是增强项                    │
└─────────────────────────────────────────────────────────────────────┘
                              │
┌── 步骤② 校验 + 物化 ────────▼───────────────────────────────────────┐
│ OWL 2 RL 前向链（78 条规则，≤1000 轮，超时 5–120s 默认 30s）           │
│   ├─ 公理 → 新增 inferred 边（inferredFrom / inferredVia / …）        │
│   ├─ 不相交/非对称 → inconsistencies（明细上限 50）                    │
│   └─ setGraphMeta({lastInferredAt, inferredStale:false, lastStats, lastGuard})│
│                                                                     │
│ 另有三条独立校验/修复通道：                                            │
│   · 写前护栏（已在步骤①执行，日志在此步落 meta.lastGuard）              │
│   · 全图校验 validateGraph（§12.2.3 通道 C，v1 新增）                  │
│   · 冲突修复 planRepairs/applyRepairs（§12.2.8 通道 D，v1.1 新增）      │
└─────────────────────────────────────────────────────────────────────┘
                              │
┌── 步骤③ 回答 ───────────────▼───────────────────────────────────────┐
│ 问题 → [惰性重推理 inferredStale] → LLM 实体识别 → 种子匹配（2 级兜底） │
│      → BFS ≤ maxHops 事实三元组 → [影响面闭包（10 个关键词触发）]       │
│      → factKey 归一化去重 ≤120 → collectRefs 原文回溯 ≤4 → streamChat  │
│                                                                     │
│ ⚠️ 本质是**对已物化图谱的检索**，不是实时逻辑推理（§12.3.1）            │
└─────────────────────────────────────────────────────────────────────┘
```

---

### 12.1 步骤①：资料 → 按顶层本体体系构建图谱

#### 12.1.1 体系选择优先级（权威定义）

**生效体系按以下五级优先级解析，`settings.ontologyProfile` 不是主路径**：

| 级 | 来源 | 代码位置 | 说明 |
|---|---|---|---|
| **1** | **弹窗显式指定** | `raws.js:submitGroup` → `extras.ontologyProfile = g.profileId` → `graph.js:261 explicitPid` | 用户在「提取」弹窗的体系下拉框里选定的值 |
| **2** | **领域模版绑定** | `templates.js:saveTemplate` 持久化 `tpl.ontologyProfile`；`jobs.js:resolveAutoDomain` 回填；`graph.js:285-307` 解包为 `tplProfile` | 模版编辑器 `#tpl-ontology-profile`（`index.html:380`）写入 |
| **3** | **模型动态选择** | `templates.js:suggestOntologyProfile`（1 次 LLM 调用，返回 `{id, name, similarity, reason}`） | 模版未绑定体系时，按**该领域的文件子集**内容从「内置三体系 + 已导入 OWL」中选最贴合者 |
| **4** | `settings.ontologyProfile` | `graph.js:311` | **历史全局默认，v4 起 UI 不再写入**（`index.html` 中 `set-ontologyprofile` 元素已删除，`common.js:1815-1828` 是死代码）→ 实际不可达，仅作向后兼容兜底 |
| **5** | `'bfo-lite'` | `graph.js:311` 末尾 | 硬兜底 |

> 📌 **裁决发生在两层，`graph.js` 只消费**：
> - **renderer 层**（`raws.js:528-547`，多领域弹窗卡片③）：`prep.tpl.ontologyProfile` 存在 → 直接用（**模版绑定优先**）；否则调 `tplSuggestProfile` 让模型选。
> - **jobs 层**（`jobs.js:resolveAutoDomain`，自动建域路径）：命中/新建模版后决定体系。
> - `graph.js` 收到的已经是裁决结果——它**无法区分**「用户在弹窗里选的」和「模型选的」，两者都以 `explicitPid` 形式到达（`raws.js:submitGroup` 无论来源一律写 `extras.ontologyProfile`）；模版绑定则以 `resolveDomain` 回填的 `tplProfile` 到达。
>
> ⚠️ **v1 修正**：`jobs.js:647-649` 原实现为「体系不盲从模版绑定，一律调 `suggestOntologyProfile`」，与上表第 2 级优先于第 3 级相矛盾（也与《多领域自动拆分提取设计》§2「体系：优先 `tpl.ontologyProfile`；为空时 `suggestOntologyProfile`」矛盾）。v1 已改为**模版绑定存在时沿用绑定、不调模型**，与 `raws.js:539-543` 对齐。

#### 12.1.2 体系选定后，它约束什么

`resolveOntology(pid)`（`graph.js:44-72`）= 基座（内置 `ONTOLOGY_PROFILES[pid]`，或 `owl:*` 从 `kv.owlProfiles` 取；缺失 → 回落 `bfo-lite`）+ 用户叠加层（同 key 覆盖），深拷贝后返回。它决定：

| 维度 | 字段 | 在步骤①的作用 |
|---|---|---|
| 节点类型取值域 | `classes[]`（`key/label/parent/desc/examples`） | 抽取提示词列出类表；不在表中的类型 → `fallbackType`（bfo-lite=`object`，bfo=`material_entity`，iso15926=`physical_object`） |
| 关系谓词取值域 | `predicates[]` | 不在受控词表中的谓词 → `fallbackRel`（bfo-lite=`相关`，bfo=`related_to`，iso15926=`relatedTo`） |
| 提示词模式 | `promptMode` | `flat`（bfo-lite，1 次调用）/ `two-stage`（bfo、iso15926，粗分 + 细分 **2 次调用**） |
| 领域类收窄 | `typeHints`（来自模版 `domainClasses`） | 把类表从「整个体系」收窄到「该领域的 5–8 个类」 |
| 节点 id 前缀 | `pid` | `ensureNode` 生成 `${profileId}:${key}`，多体系共存时天然隔离 |

> ⚠️ **测试硬契约**：`graph-ontology.test.js:355-358` 断言 bfo 体系走 two-stage 时 `/chat/completions` **恰好 2 次**。在 `extractGraph` 内新增任何 LLM 调用都会破坏该断言。

#### 12.1.3 抽取执行

- **来源收集**（`graph.js:248-290`）：`inlineSources`（粘贴文本）/ `rawPaths + readRaw`（原始文件）/ `collectSources()`（全部笔记，:248）。三种全空分别抛 `笔记内容为空，无法抽取` / `原始来源内容为空或不存在` / `选定范围内没有可抽取的内容（笔记为空）`。
- **分批**（`graph.js:338`）：**一个来源一批**，单来源文本按 `SOURCE_CHARS = 1500`（:128）截断；`BATCH_CHARS = 6000`（:126）为批内字符预算。
- **并发**（`graph.js:392`、`:595-620`）：`CONC = settings.graphConcurrency`（默认 3，1–8）个 worker；`retryTaskNo`（:346）存在时只跑该任务；全部失败 → 抛 `全部 N 个来源抽取失败：…`；部分失败 → 记 `failedTasks`（:619），作业卡片可单独重跑。
- **节点/边落地**（`graph.js:500-561`）：`ensureNode` 去重（按 name，:376 定义）→ 谓词白名单过滤 → **护栏校验**（:506-524 domain/range；:525-557 v1.1 写侧互斥预检）→ 自环过滤（`from.id === to.id` 跳过）→ 以 `${from.id}|${to.id}|${rel}` 为键去重（:559）。
- **来源标注**（`graph.js:563-579`）：`node.sources` 追加 `笔记·标题` / `原始·文件名`，**每节点最多 5 条**；同时回填 `node.domain`（粗匹配全未命中时按本次领域兜底）。

#### 12.1.4 写前护栏（domain/range）

`guard.checkEdge(profile, fromNode, rel, toNode, opts)`（`guard.js:94-166`）按顺序返回 4 种 `reason`：

| reason | 触发条件 | detail 示例 |
|---|---|---|
| `unknown-predicate` | `rel` 不在体系受控词表 | `谓词「X」不在体系受控词表中` |
| `domain-violation` | `from.type` 不是**所有**声明 domain 的祖先/自身（**合取语义**，与 `prp-dom` + `scm-dom1` 一致） | `「乙」的类型 process 不属于 independent_continuant 及其子类` |
| `range-violation` | 同上，针对 `to.type` | 同形态 |
| `unknown-type` | 端点类型不在类表——**仅当 `opts.strictUnknownType`**（默认 `false`） | — |

> **v1.1 起护栏日志还有第 5 种 `reason`：`disjoint-type-forcing`**，它**不来自 `checkEdge`**，而来自 `graph.js:525-557` 的写侧互斥预检——domain/range 校验通过后，再检查该谓词的定义域/值域会把端点强制归入哪个类，若与端点声明类型互斥（`guard.checkDisjoint`）则同样降级。目的是把推理期必报的 `cax-dw` 冲突消灭在写库前。前端 `guardReasonText` 因此是 **5 码**。

- **默认不拦 `unknown-type`**：抽取阶段已把未知类型降级为 `fallbackType`，剩下的多是体系外自定义类，拦下来只会制造噪声（`guard.js` 内有注释说明）。
- **两处都没有约束时返回 `ok:true`**，绝不臆造约束（`guard.js` 头部注释）：内置体系的谓词**都没有** `domain`/`range` 字段，定义域/值域只以 `PropertyDomain`/`PropertyRange` **公理**形式存在；OWL 导入的体系恰好相反。因此一律走 `bridge.normalizeProfile` 的**双源合并视图**。
- **违规处理**：`rel = fbRel`（降级，边仍然写入）+ `guardLog.push({taskNo, from, fromType, rel, to, toType, reason, detail, downgradedTo})`（**恰好 9 个字段**，测试 `graph-reason-integration.test.js:511` 用 `Object.keys` 精确断言）。v1.1 的写侧互斥预检（`graph.js:525-557`）复用同一份日志结构，仅 `reason` 取第 5 种值 `disjoint-type-forcing`。
- **性能**：`normalizeProfile` 要算祖先闭包，`guard.js` 用 `modelCache`（`CACHE_MAX = 8`，签名 = `id|classes|predicates|axioms|_userRev`）memo；体系被编辑后需 `clearCache()`。

#### 12.1.5 落库顺序（不可颠倒）

```js
// graph.js:644-651
for (const e of existing.edges || []) if (e && e.from && e.to && !e.inferred) putEdge(e);
//                                    ↑ 旧推理边不参与合并：本轮统一重算（§5.4）
//                                      否则上一轮推理产物会被当成「原始边」再喂给推理器 → 自我循环论证
saveGraph(mergedNodeList, rawEdgeList);   // ← 先落原始图
// …之后才跑推理，成功再 saveGraph 一次
```

**先落原始图**是 §9 风险 2 的缓解措施：推理失败/超时/被关闭都不能让用户丢掉抽取结果。

#### 12.1.6 作业 stage 流

`jobs.js:304 GRAPH_STAGES` = **`collect → extract → guard → reason → save`**（5 个，测试 `jobs-tasks.test.js:126` 精确断言）。

| stage | 文案 |
|---|---|
| `collect` | `读取 N 个笔记来源…` / `读取 N 个原始来源…` / `读取全部笔记…` |
| `extract` | `抽取完成：N 节点 / M 关系（体系「X」）[，⚠ K 个来源失败（可在作业详情中单独重跑）]` |
| `guard` | **总是发出**：`护栏拦截 N 条越界连线（…），已降级为回退谓词` 或 `护栏校验通过：无越界连线` |
| `reason` | `未启用自动推理（推理层不可用或用户已关闭）` / `推理已跳过：…` / `推理完成：新增 N 条推理边（R 轮 / M ms）[，⚠ 检出 K 处语义冲突]` |
| `save` | `图谱已持久化到 SQLite（共 N 条边[，其中 M 条为推理边]）` |

> 📌 `graph.extractGraph` 自身的 `onStage` 只在**有拦截时**才发 `guard`（`graph.js:603 if (onStage && guardSummary)`）——所以直接调 `extractGraph` 的测试 `graph-reason-integration.test.js:457` 断言的是 `["collect","extract","reason","reason","reason","reason","reason"]`（bfo-lite 覆盖率 0%，无拦截）。作业层的「总是发出」是 `jobs.js:543-560` 额外补的。

---

### 12.2 步骤②：用体系的约束与公理校验图谱

#### 12.2.1 约束 vs 公理：分工必须分清

这是本步骤**最容易混淆的一点**，也是 §7 把「五元组数值约束」划出范围的原因：

| | **约束（constraints / domain-range）** | **公理（axioms）** |
|---|---|---|
| 语义 | 「这条边**允许不允许**存在」 | 「从已有边**还能推出什么**」 |
| 执行时机 | **写入前**（步骤①的护栏） | **写入后**（物化推理） |
| 执行者 | `guard.checkEdge` | `infer.materializeGraph` → protege-js `OWL2RLReasoner` |
| 违规后果 | 降级为 `fallbackRel` + 记日志（**边仍写入**） | 产出 `inconsistencies`（**边不删，只报告**） |
| 典型条目 | `PropertyDomain` / `PropertyRange`；`constraints[]` 里的自然语言条目（如「禁止自环边」） | `TransitiveProperty` / `SymmetricProperty` / `AsymmetricProperty` / `InverseProperties` / `SubClassOf` / `DisjointClasses` |
| 对应 OWL 2 RL 规则 | `prp-dom` / `prp-rng` / `scm-dom1` / `scm-rng1` | `prp-trp` / `prp-symp` / `prp-asyp` / `prp-inv1/2` / `cax-sco` / `cax-dw` |

> ⚠️ **`DisjointClasses` 横跨两侧**：它既是「约束」（一个节点不该同时属于两个不相交类），又只能通过 `cax-dw` 在**物化时**才暴露为冲突。`guard.checkDisjoint(profile, typeA, typeB)`（`guard.js:168-188`）是它的**写前版本**，返回 `{conflict, pairs, detail}`，detail 形如「object 与 process 分别落入不相交类 continuant / occurrent」。
>
> ⚠️ **`constraints[]` 是自然语言，不可执行**：三个内置体系各有 10/12/12 条 `constraints`（如「节点类型须从体系类表中选取，其余回退为 object」），它们是**给 LLM 看的提示词素材**与**给「约束」Tab 展示的文本**，没有求值器。其中可形式化的部分（类型/谓词白名单、禁自环）已在 `extractGraph` 里硬编码执行；数值型五元组约束属业务规则引擎，见 §7。

#### 12.2.2 三个内置体系的声明基数（2026-09-13 实测）

直接 `require('src/main/common/constants')` 统计，**不抄注释**：

| 体系 | classes | predicates | constraints（文本） | axioms | 其中 domain/range 对 | 传递 | 对称 | 非对称 | 互逆公理 | 不相交 | 子类 | 护栏覆盖率 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `bfo-lite` | 11 | 8 | 10 | 8 | **0 / 0** | 1（`包含`） | 1（`相关`） | 1（`矛盾于`） | 0 | 3 | 2 | **0%** |
| `bfo` | 21 | 15 | 12 | 18 | 2 / 2 | 4 | 1 | 0 | 2 | 4 | 3 | 13%（2/15） |
| `iso15926` | 14 | 14 | 12 | 18 | 2 / 2 | 6 | 2 | 0 | 0 | 2 | 4 | 14%（2/14） |

**推论（务必写进用户预期）**：

- **默认体系 `bfo-lite` 的护栏覆盖率是 0%** —— 提取时「护栏拦截 0 条」是**预期行为，不是失效**。`graph.js:353-360` 有专门注释说明这点，`graph-reason-integration.test.js:454` 也断言 `ex.guard === null`。
- 但 `bfo-lite` 有 1 条传递 + 1 条对称 + 3 条不相交 → **物化推理与冲突检测照常有效**（测试 `:130-135`：3 节点链推出 1 条 `transitive` 边、3 轮收敛）。
- 覆盖率数字来自 `guard.coverage(profile)` → `{profileId, predicates, withDomain, withRange, withAny, coveragePct, detail[], transitive[], symmetric[], inversePairs[], disjointPairs[], classCount, axiomCount}`（**13 个键**，2026-09-13 实测），在「推理」Tab 第 ④ 区块显示为「护栏覆盖 X%」。注意 `inversePairs` 是**双向展开**后的映射项数（bfo 的 2 条 `InverseProperties` 公理 → 4 项），与上表「互逆」列的公理条数口径不同，不要混用。

#### 12.2.3 四条校验/修复通道

| 通道 | 时机 | 入口 | 检查内容 | 产物 |
|---|---|---|---|---|
| **A. 写前护栏** | 步骤①每条边写入前 | `guard.checkEdge` + 写侧互斥预检（v1.1） | 谓词白名单 + domain + range + **强制类型互斥** | 降级 + `guardLog` → `meta.lastGuard` |
| **B. 物化时一致性** | 步骤②前向链跑完 | `infer.materializeGraph` → `recoverInconsistencyMessages` | `cax-dw`（不相交类同时归属）、`prp-asyp`（非对称谓词双向断言）等 | `inconsistencies[{rule, message}]` → `meta.lastStats.inconsistencyDetails`（上限 50） |
| **C. 全图校验** | 用户主动触发（「推理」Tab） | `graph.validateGraph(profileId, opts)` ← IPC `graph:validate` | 对**已落库的整张图**重跑 A 的三类检查 + 节点不相交归属 + 覆盖率报告，**不改图** | `{ok, profileId, profileName, checked, violations, byReason, byRel, disjointConflicts, coverage, truncated, at, totalViolations, totalDisjointConflicts}`（v1.2.2 起末两个为**全量计数**：`violations`/`disjointConflicts` 明细数组封顶 50，UI 计数必须用 totals，否则截断时少报）。**v1.2.2 起 violation 项为 17 键**：`edgeKey, fromId, toId, inferred, from, fromType, rel, to, toType, reason, detail, expected, actual, profileId, profileName, domain, scopeLabel`——`fromId/toId` 供行级修复定位边，`profileId/profileName/domain/scopeLabel` 供统一问题表的「所属体系 / 知识图谱」归因列；不相交项另带 `nodeId,node,declaredType,forcedType,via,rel,pairs` |
| **D. 冲突自动修复**（v1.1） | 用户主动触发（「一键修复」/ 单条「修复」/ **v1.2.2 问题表行级「修复」**） | `graph.planRepairs`（全量）/ `graph.planRepairsForIssues`（**v1.2.2 行级**）→ 预览确认 → 提交 `graph-repair` 作业（v1.2，逐动作子任务）← IPC `graph:planRepairs`/`graph:planRepairsForIssues`/`applyRepairs`/`undoRepair` + `jobs:submit` | 把 B 的冲突明细**或 C 的单行问题**翻译成最小破坏动作（降级谓词 > 删边 > 改类型），规划阶段**不改图** | 规划 `{actions, byKind, autoCount, manualCount, conflictCount}`；作业施加前存撤销快照 kv `graph.repairUndo` 并逐动作落库，完成后重推理验证。详见 §12.2.8 |

> 📌 **通道 C 是 v1 新增，已落地**（`reason/validate.js` + `graph.js:validateGraph` + IPC `graph:validate` + 推理 Tab 第 ⑤ 区块；测试 `test/graph-validate.test.js`）。v0 之前「校验」只有 A（写入时，一次性）与 B（隐式，混在推理里）：用户**无法对既有图谱重新体检**——比如换了体系绑定、改了公理、或从旧版本升级后，历史边从未被护栏看过一眼。`guard.checkDisjoint` 虽早已导出，但其文档注释声称的「供提取阶段提前拦截，也供『推理』Tab 展示体系声明了哪些不相交约束」在 v0 生产代码里从未被调用；通道 C 把这条已声明未接通的意图落地（以 domain/range 强制类型 vs 声明类型的 cax-dw 只读等价检查，而非节点类型两两比对——不相交约束的是同一个个体，不是类的共存）。
>
> **通道 C 的边界**：只读、只报告、**不修改图谱**（不改 `rel`、不删边、不写 `inferredStale`）。体检本身绝不改数据，避免「一键体检」把用户数据改花。
>
> 📌 **v1.1 起新增通道 D（冲突自动修复）**，把「修复」从体检里拆出来做成**独立、显式同意**的一步：`reason/repair.js`（纯规划 + 纯施加）+ `graph.js:planRepairs/applyRepairs/undoRepair/repairUndoAvailable` + IPC 3 通道 + 推理 Tab 冲突区「一键修复 / 修复 / 撤销上次修复」。设计要点：① **规划是 dry-run**，只返回动作清单不落库；② **应用前必存撤销快照**（kv `graph.repairUndo`，一步撤销、只保留最近一次）；③ **最小破坏原则**——优先降级谓词，其次删边，最后才改节点类型；④ 无安全方案的冲突一律标 `manual`（`auto:false`），`applyRepairs` 会过滤掉，绝不猜；⑤ 应用后自动重推理验证冲突数下降。详见 §12.2.8。
>
> 📌 **v1.2.2 起通道 C 与 D 打通（统一问题表 + 行级修复）**：校验报告不再分「越界边」「不相交归属」两张表，而是合并为**一张问题汇总表**（`#kg-vr-tbody`，7 列：`# / 问题类型 / 违规边或节点 / 违反的约束或公理 / 所属体系 / 知识图谱 / 操作`），配两个筛选下拉（`#kg-vr-scope` 按知识图谱、`#kg-vr-kind` 按问题类型 edge/conflict）。每行末尾有「修复」按钮（`.kg-vr-fix[data-ri]`）→ 走 `repair.planOneIssue(issue, graph, profile)` 单行规划 → `graph.planRepairsForIssues([issue])` ← IPC `graph:planRepairsForIssues` → 同一个 `showRepairPreviewModal` 预览 → 提交同一个 `graph-repair` 作业。行级映射规则（`planOneIssue`）：`unknown-predicate`/`domain-violation`/`range-violation` → 降级谓词（`isUnconstrained` 时 change-rel 到兜底谓词，否则 delete-edge）；不相交归属行（带 `nodeId`）→ 委托 `planOne({rule:'cax-dw'})`；`unknown-type` → 按 `detail` 的「起点/终点」标记定位越界端，retype 到 `guard.constraintOf(profile, rel)` 对应侧首个类（无约束则 `profile.fallbackType`），目标类与现类型相同或不在类表 → manual；其余 reason → manual。动作带 `source:'issue'` 与 `edgeKey/from/to/rel` 便于追溯。**注意**：`guard.checkEdge` 的 unknown-type 判决里 `actual` 是越界的**类型 key**（如 `ghosttype`），「起点/终点」标记在 `detail` 里——行级修复据此定位端点，测试夹具必须同时给 `fromType/toType` 才能正确判侧。

#### 12.2.4 物化推理机制

`infer.materializeGraph(graph, profile, opts)`（`infer.js:97+`）：

| 参数 | 默认 | 说明 |
|---|---|---|
| `maxRounds` | `DEFAULT_MAX_ROUNDS = 1000` | 前向链不动点上限，防 SWRL/环状公理死循环 |
| `timeoutMs` | `30000`（来自 `reasonTimeoutSec(settings) * 1000`，`num(settings,'reasonTimeout',30,5,120)`） | 超时 → `skipReason:'timeout'`，原始图保留 |
| `annotations` | `true` | 写入 `RDFS_LABEL` / `SYN_PROFILE` 字面量，供回收时还原名称 |
| `onProgress` | — | 每体系 4 个 phase：`推理体系「X」（i/n）…` / `[…] 桥接图谱为三元组…` / `[…] 物化推理中…` / `[…] 回收推理边…`（测试 `:161-164` 精确断言，pct 只有第一个是 100） |
| `signal` | — | AbortSignal → `skipReason:'aborted'` |

返回 `{skipped, skipReason, stats, inferredEdges, inconsistencies}`；`stats` 含 `{skippedEdges, staleInferred, classes, predicates, triplesBefore, triplesAfter, inferredCount, inferredEdges, unjustified, rounds, elapsedMs}`。

**`skipReason` 共 7 个码**（`graph.js:168-176 SKIP_REASON_TEXT`，测试 `:66` 精确断言键集）：`reasoner-unavailable` / `empty-graph` / `bridge-failed` / `no-rule-fuel` / `aborted` / `materialize-failed` / `timeout`。graph.js 顶层另加 `disabled` / `unknown-profile` / `exception` 三个（`infer.js` 不产），前端 `reasonSkipText` 合并为 **10 个码**。

**桥接细节**（`bridge.js:216+ graphToTriples`）：

1. 所有类声明为 `C.Class` 并写 `P.subClassOf` / `P.disjointWith` / `P.equivalentClass` —— 声明为 `owl:Class` 才会触发 `scm-cls` → `scm-sco` 类树传递闭包，而 `prp-dom`/`prp-rng` + `scm-dom1`/`scm-rng1` 依赖它。
2. 谓词声明为 `C.ObjectProperty`，写特性 IRI（`FEATURE_IRI` 6 项）、`P.inverseOf`（双向）、`P.domain`/`P.range`/`P.subPropertyOf`/`P.equivalentProperty`。
3. 节点 → `iriId(n.id) P.type iriType(n.type || fbType)`。
4. 边 → **跳过 `e.inferred`**（计入 `staleInferred`）、**跳过端点不在 `validIds` 的边**（计入 `skippedEdges`）；同时建 `edgeIndex`（身份键 → 数组下标，供 `inferredFrom`）、`originals` Set、`adjByRel`、`relIris`。

> ⚠️ **IRI 前缀坑**（§0.1 已记）：必须用库导出的 `NS`/`P`/`C` 常量拼完整 IRI。写 `'rdfs:subClassOf'` 这类前缀简写**不会报错**，`materialize()` 照跑、store 照增长，但 `cax-sco` 静默不触发、`entails()` 返回 `false`。

> ⚠️ **上游 bug 已绕过**：`protege-js@0.1.0` 的 `recoverInconsistencyMessages` 只转发 1 个参数，导致规则名字面量变成 message、真实描述被丢（`inconsistencies === [{rule:'prp-asyp', message:'prp-asyp'}]`），且 `_conflict` 按 `(rule,message)` 去重会把 N 处冲突塌成 1 处。`infer.js:40-95` 的绕法：不动点跑完后，**只重跑报过冲突的规则**并改用 2 参收集器（不动点处 `add` 返回 false，故重跑幂等）。

**多体系分组**（`graph.js:runInference`）：节点按 `n.profile || id.split(':')[0]` 分组，**每个体系独立跑一次 `materializeGraph`**（各自的类树/公理不同，混跑会串味）；`opts.profileId` 可只跑单体系。跨体系的边原样保留（测试 `:224`）。

#### 12.2.5 冲突明细与上限

- `INCONSISTENCY_DETAIL_CAP = 50`（`graph.js:1493 capInconsistencies`）：`capInconsistencies(list)` → `{total, truncated, items:[…]}`，单项 **10 个字段**：`rule, message, messageZh, reasonZh, profileId, profileName, nodeIds(≤10), raw(≤400), nodeNames, scopes`。
- ⚠️ **`nodeIds` + `raw` 是通道 D（修复）定位边的唯一依据**（`repair.planOne` 靠 `nodeIds` 找节点、靠 `raw`/`message` 正则抽出涉事谓词）。**v1.1 之前落库的明细没有这两个字段**，对其直接规划会得到「N 处冲突 → 0 个动作」的死胡同；`planRepairs` 因此显式检测 `legacyDetails`（非 refresh 且所有条目都无 `nodeIds`）并返回可操作 `hint`，UI 的「一键修复」也默认带 `refresh:true` 先重推理。
- ⚠️ **`inconsistencies` 有 4 种不同形态**（测试 `:124-127` 专门注释）：`runInference` 顶层 = **数组**；`perProfile[i]` = **数字**；`meta.lastStats.inconsistencies` = **数字**；`extractGraph().reason.inconsistencies` = **数组**。改任一处都要同步四处。

#### 12.2.6 `graphMeta` 生命周期

见 §5.4（4 字段）。状态机：

```
extractGraph 成功推理 → {lastInferredAt: now, inferredStale: false, lastStats: {...}, lastGuard: {...}}
extractGraph 未推理   → 只写 lastGuard（保留旧 lastStats）
deleteEdge/NodeWithCascade → inferredStale: true（级联清理后）
kgAsk 发现 stale && reasonEnabled → 重跑 runInference → stale: false
clearInferredEdges → {lastInferredAt: 0, inferredStale: false}
applyRepairs / undoRepair → inferredStale: true（写图后），随后重推理刷回 false
clearGraph → {lastInferredAt: 0, inferredStale: false, lastStats: null, lastGuard: null} + 清掉撤销点 kv
```

#### 12.2.7 校验/推理结果的可观测面（6 处）

| # | 位置 | 内容 | 代码 |
|---|---|---|---|
| 1 | **作业详情** stage 流 | `guard` + `reason` 两个 stage 的文案（§12.1.6） | `jobs.js:543-560` |
| 2 | **整体图谱工具栏** `graph-reason-bar` | `⚡ 上次推理（全图）｜新增推理边 N 条 · R 轮 · Ss｜⚠ K 处不一致冲突 / ✓ 无冲突｜当前筛选范围内命中推理边 M 条｜查看冲突 →` | `renderer/graph.js:1946-1972` |
| 3 | **本体定义 → 推理 Tab**（仅列表视图渲染） | **5 个区块**：① 上次推理 ② 不一致冲突（v1.1 起每条带「修复」按钮，工具栏加「一键修复 / 撤销上次修复」）③ 护栏拦截日志 ④ 谓词特性一览 ⑤ 全图校验（v1 已交付，按钮 `btn-reason-validate` 触发 `graphValidate`，报告由 `renderValidateReport` 渲染） | `renderer/graph.js renderKgReasonTab` |
| 4 | **画布** | 推理边紫色虚线（`INFERRED_EDGE`）+ 标签 `rel ⚡` + hover 推导链 tooltip（§6.2）+ 边类型筛选（全部/仅原始/仅推理） | `renderer/graph.js:1412-1438 / 1618-1631 / 1655+`；`index.html:214-237` |
| 5 | **问答页** | 事实行 `.kg-fact-inferred`（紫色左边框 + `⚡` 前缀）、脚注「本回答包含 N 条由 OWL 2 RL 推理得出的事实」、执行过程 `kg:stage` 日志 | `renderer/graph.js:1240-1300 askKg` |
| 6 | **修复预览弹窗** `#repair-preview-modal`（v1.1） | 标题「N 处冲突 → M 个动作」；逐条动作可勾选（`manual` 项标「需人工」不可勾）；底部「已选 N 个自动动作」随勾选联动，归零则「提交修复作业」置灰；确认后提交 `graph-repair` 作业并跳转作业管理（v1.2）。⚠️ 动态创建的弹窗必须复用 `.modal-mask`（应用唯一带 CSS 的遮罩类），误用无 CSS 的类名会导致弹窗不可见（「修复点不动」事故根因） | `renderer/graph.js:1072 showRepairPreviewModal` |

#### 12.2.8 通道 D：冲突自动修复（v1.1）

**分层**：`reason/repair.js` 纯函数（不读写 kv、不调 LLM）+ `graph.js` 编排层（读设置、调 LLM、存快照、落库、重推理）。

| 层 | 函数 | 职责 |
|---|---|---|
| 纯 | `conflictRelKeys(c)` | 从 `c.raw \|\| c.message` 正则抽出涉事谓词键（解码后去重） |
| 纯 | `findInducingEdges(node, edges, profile)` | 找出把该节点强制归入互斥类的边：经 `guard.forcingProbes(profile, rel)` 统一口径探测——**直接探针**（节点是 `e.from` 探 domain、是 `e.to` 探 range）+ **逆谓词探针**（对 `inverseOf(rel)` 的每个逆 `inv`：节点是 `e.to` 时探 `domain(inv)`、是 `e.from` 时探 `range(inv)`，因为逆边物化同样强制类型）；命中项带 `inverseRel` 供文案说明强制来源 |
| 纯 | `isUnconstrained(profile, rel)` | 候选降级谓词是否无 domain/range（否则降级仍会再冲突） |
| 纯 | `lca(profile, a, b)` | 沿 `classes[].parent` + SubClassOf 公理求最近公共祖先 |
| 纯 | `planOne(c, graph, profile, opts)` | 单条冲突 → 0..n 个动作（按规则分派，见下表） |
| 纯 | `planRepairs(conflicts, graph, resolveProfile, opts)` | 批量规划 + 体系解析失败降级 manual + **去重** + 计数；可选 LLM 仲裁 |
| 纯 | `applyActions(graph, actions)` | **先丢弃全部推理边**再建 edgeIdx，然后施加 change-rel / delete-edge / retype-node |
| 编排 | `graph.planRepairs(opts)` | `refresh:true` 先重推理；`conflictIdxs` 只规划指定下标；`settings.graphRepairLlm` 决定是否注入 `arbitrate` |
| 编排 | `graph.applyRepairs(actions, opts)` | 过滤 manual → 存快照到 kv `graph.repairUndo` → `saveGraph` → `inferredStale:true` → 重推理（整批语义，供测试/兼容保留） |
| 编排 | `graph.applyRepairsStepwise(actions, opts)` | **逐动作编排**（v1.2，作业 runner 专用）：施加前存快照（`opts.snapshot:false` 可跳过）→ 循环内逐动作 `applyActions` + **逐步 `saveGraph`**（中途停止也一致）→ `onTask(i,status,output)` / `onProgress(done,total)` 回调 → `signal` 中止抛 `AbortError`（带 `partial`）→ 单动作失败记 `failedTasks` 不中断 → 末尾重推理 |
| 编排 | `graph.undoRepair(opts)` / `repairUndoAvailable()` | 恢复快照整图（一步撤销，只保留最近一次）/ UI 置灰依据 |

**v1.2 起修复以「作业」执行**（`jobs.js` 类型 `graph-repair`，阶段 `plan/apply/verify`）：预览弹窗确认后 `jobs:submit` 提交一条作业，**每个动作一条子任务**；runner 调 `applyRepairsStepwise`，把 `onTask` 映射到任务状态（`skipped` 记为 done+说明输出，与 extract-note 约定一致；抛错才 `failed`）。设计要点：① **动作清单随 `job.source.actions` 持久化**（payload 仅内存），重启后重试/单任务重跑不会静默重新规划，清单真丢失时明确报错提示回推理 Tab 重规划；② **单任务重跑传 `snapshot:false`**，撤销点始终指向整批施加前；③ 有 `failedTasks` 时作业标 `warning`，支持失败任务单条重跑；④ 完成回调（`handleJobsUpdate`）自动 `loadGraph()` 刷新图谱与推理页。

**v1.2.1 逆谓词强制感知**（「红色徽标 1 却修不了」事故修复）：`prp-inv1/inv2` 会物化逆边，而 `prp-dom/prp-rng` 又按**逆谓词**的 domain/range 强制节点类型——例如 bfo 的 `bearer_of` 自身无 domain/range，但其逆 `inheres_in` 的 `PropertyDomain(inheres_in, specifically_dependent_continuant)` 会把 `bearer_of` 边的**终点**强制归入 specifically dependent continuant，与 independent continuant 互斥触发 `cax-dw`。旧版只看直接约束（`e.from`→domain、`e.to`→range），这类冲突找不到诱因边 → 误判 `manual` → 预览弹窗 0 个可勾动作、「提交修复作业」置灰，用户看到「徽标有 1 条冲突却一条都修不了」。修复：新增 `guard.forcingProbes(profile, rel)`（`reason/guard.js`）作为**唯一口径**，返回直接+逆谓词两类探针（`{node:'from'|'to', via:'domain'|'range', forced, rel, inverse}`），三处共用——`repair.findInducingEdges`（规划诱因边，动作带 `inverseRel`、文案注明「其逆谓词 X 的定义域/值域…该强制来自推理物化的逆边」）、`validate.disjointConflicts`（冲突明细归因）、`graph.js` 写侧预检（`disjoint-type-forcing` 护栏日志注明强制来自逆谓词）。

**规则 → 动作分派**（`planOne`）：

| 规则类 | 规则 | 动作 |
|---|---|---|
| **A**（类型互斥） | `cax-dw` / `cax-adc` / `cls-com` / `cls-nothing2` | 逐个 `nodeIds` 找诱因边 → 兜底谓词无约束则 `change-rel`，否则 `delete-edge`；都不可行则 `manual`。**`nodeIds` 为空时循环不执行 → 返回 `[]`**（旧版明细的死胡同根源，由编排层 `legacyDetails` hint 兑现） |
| **B**（谓词特性） | `prp-irp` | 删自环 |
| | `prp-asyp` | 删反向边、保留正向（任一侧缺失或无 `nodeIds` → `manual`） |
| | `prp-pdw` / `prp-adp` | 保留第一条，删其余 |
| | `prp-npa1` | 删该边 |
| | `cls-maxc1` / `maxqc1` / `maxqc2` | 删该节点的出边 |
| **C**（无安全方案） | `prp-npa2` / `dt-not-type` / `eq-diff1-3` / 未知规则 | 一律 `manual`（`auto:false`） |

**去重签名**（`planRepairs`）——三类，顺序敏感：

```js
manual            → `manual\u0001${rule}\u0001${actionZh}`
prp-asyp+delete   → `prp-asyp\u0001${[from,to].sort().join('\u0002')}\u0001${rel}`   // ← 镜像冲突合并
其余              → `${kind}\u0001${edgeKey}\u0001${nodeId}\u0001${newRel||newType}`
```

> ⚠️ **`prp-asyp` 镜像陷阱**：非对称谓词同时存在 `(a,b)` 与 `(b,a)` 时，推理器会报**两条**冲突，各自规划「删反向边」——若按通用签名去重，两条边会**都被删掉**。必须按**无序节点对**去重，只保留一个动作。

**LLM 语义仲裁**（方案3，`settings.graphRepairLlm`，默认关）：仅当 `opts.arbitrate` 是函数 **且** 本轮有 `change-rel` 动作时触发。模型选中的类必须∈ `forced` 候选集才采纳，动作转为 `{kind:'retype-node', nodeId, newType, viaLlm:true}` 并 `delete a.edgeKey; delete a.newRel`；调用失败静默退回确定性方案（修复不能因模型不可用而中断）。

**`applyActions` 的跳过原因（5 种固定文案，测试硬契约）**：`需人工处理` / `目标边不存在（可能已删除）` / `目标节点不存在` / `未指定新类型` / `未知动作类型 ${a.kind}`。

> ⚠️ **`applyActions` 先丢弃全部推理边再建索引**：因为修复后必然重推理，旧推理产物一律作废（不变量 I3）。写测试时若想验证「change-rel 撞已有同键边 → 转为删除」，两条边必须都是**原始边**，否则被当作推理边丢掉后索引里根本找不到。

---

### 12.3 步骤③：用户问题 → 按图谱推理做回答

#### 12.3.1 本质声明（避免误解）

> **步骤③的「推理」是对已物化图谱的检索与扩展，不是实时逻辑推理。**
>
> 逻辑推理（前向链）发生在步骤②，产物以 `inferred:true` 边**持久化**在图里。步骤③做的是：识别问题里的实体 → 在图上做 BFS/闭包扩展 → 把边翻译成事实串 → 连同原文喂给 LLM 生成回答。唯一的例外是**惰性重推理**：若 `graphMeta.inferredStale === true`（用户删过节点/边），`kgAsk` 会先补跑一次 `runInference` 再作答。
>
> 这个设计来自约束 **D4**（推理是批处理非实时）：Synapse 图谱规模小、kv 整存整取，批处理足够；实时推理会拖慢每次问答。

#### 12.3.2 `kgAsk` 七阶段管线（`graph.js:889-1100`）

| # | 阶段 | 关键参数 / 兜底 | `kg:stage` 文案 |
|---|---|---|---|
| 0 | **前置** | 图谱空 → `ai:error` `知识图谱为空，请先在「整体图谱」页运行「抽取本体层」。` | — |
| 0.5 | **惰性重推理** | `inferredStale && reasonEnabled(settings)`；失败**不阻断**问答 | `检测到图谱已变更，重新物化推理…` → `推理已刷新：新增 N 条推理边` / `推理刷新跳过：…` / `推理刷新失败（按现有图谱继续作答）：…` |
| 1 | **实体识别** | `maxHops = clamp(hops, 1, 5)`，默认 3；提示词按**主导体系** `entityPid`（图内节点数最多的 profile）取 `getPromptForProfile(settings,'graphEntityPrompt',entityPid)`；LLM 返回 `{names:[…]}` | `解析问题并抽取实体…` → `实体抽取完成：甲、乙…（N 个）` / `LLM 未抽到实体，回退关键词/分词评分召回…` |
| 2 | **种子匹配** | 主路径 `id/name` 双向包含；**兜底 1** 问题含节点名（≥2 字）；**兜底 2** 分词评分（name +2 / desc +1）取 top-3 | `命中图谱节点：…（N 个）` / `未命中任何图谱节点，将仅靠全局材料作答` |
| 3 | **BFS 事实扩展** | ≤ `maxHops` 跳；每跳遍历全边集；事实串去重后 **≤ 80 条** | `邻居事实扩展完成（N 跳内）：共 M 条事实` |
| 4 | **影响面闭包**（可选） | 见 §12.3.4 | `检测到影响面提问（影响、故障），沿传递谓词做闭包扩展…` → `影响面扩展完成：N 个下游节点（其中 M 个来自推理边），生成 K 条传导事实` |
| 5 | **原文回溯** | `collectRefs(settings, visited)`，`maxRefs = 4`，**只认 `笔记·` 前缀**（历史 `Wiki·` 标签不回溯） | `沿本体层回溯笔记原文…` → `原文回溯完成：命中 N 份材料（…）` / `原文回溯完成：无可回溯材料` |
| 6 | **生成回答** | `kg:facts` 先下发，再 `streamChat`；system = `graphAskPrompt` + `【知识图谱事实】` + `【原文材料】` | `基于事实与原文生成回答…` |

**`kg:facts` 载荷恰好 4 个字段**（测试 `:534` 精确断言）：`{matched, facts, refs, impact}`。`withFacts` 为 false 时 `facts` 是空数组（但 `matched`/`refs`/`impact` 照发）。

#### 12.3.3 事实串格式

```
BFS 事实：   [bfo-lite·object]变压器 —包含→ [bfo-lite·object]配电柜
影响面事实： [bfo-lite·object]变压器 —包含 → [bfo-lite·object]充电桩（1 跳，⚡推理）
```

- 标签 `[profile·type]`，`profile` 缺失时回落 `'bfo-lite'`（`impact.js:impactToFacts` 的 `tag()`）。
- 推理边在影响面事实里带 `，⚡推理` 后缀；前端 `askKg` 据此给行加 `.kg-fact-inferred` 类。
- **两种措辞不同**（`—包含→` vs `—包含 →（1 跳，⚡推理）`），按字符串去重会漏掉语义相同的行、白占提示词额度。故用**归一化键**去重：抹平箭头两侧空格 + 去掉尾部括注，**保留信息更丰富的影响面版本**；合并后 **≤ 120 条**。

#### 12.3.4 影响面闭包（§4.4 / §11 开放问题 4 的落地答案）

- **触发**：`impact.detectImpactIntent(question)` 命中 **10 个关键词**之一 —— `影响`/`下游`/`依赖`/`故障`/`波及`/`牵连`/`连带`/`传导`/`上游`/`impact`。不命中就**完全不跑**（避免每次问答都多算一步）。
- **跨体系分组**：种子按 `pidOf(n) = n.profile || id.split(':')[0] || entityPid || 'bfo-lite'` 分组，**每个体系至多取 5 个种子**（防闭包爆炸），各自用自己的 `resolveOntology(pid)` 解析谓词特性。
- **参数**：`maxDepth = Math.max(2, maxHops + 2)`、`direction: 'downstream'`、`includeInferred: true`（**推理边参与传导** —— 这正是 §11 开放问题 3 的答案）。库侧默认 `DEFAULT_MAX_DEPTH = 5`、`DEFAULT_MAX_NODES = 500`。
- **产物**：`impactToFacts(…, {limit: 20})` 每种子 ≤20 条 → 全部去重后 **≤ 40 条**；`impactSummary` 生成 `影响面扩展完成（沿传递谓词 包含，共 N 个下游节点，最深 M 跳）`。
- **`impactInfo` 恰好 5 个字段**：`{keywords, nodeCount, factCount, inferredCount, summaries}`；不触发时 `impact === null`。
- **降级**：体系无传递/互逆谓词 → `impactClosureFor` 返回 `usable:false`（**8 字段**，多一个 `hint`）；`reasonEnabled:false` → 整段跳过、`impact` 为 null、无 stage（测试 `:554-580` 断言）。
- **失败隔离**：闭包抛错只发一行 `影响面扩展失败（已跳过）：…`（截断 120 字），**绝不影响问答主链路**。

#### 12.3.5 `kgAsk` 与 `recallFor` 的分工

两条问答路径**不要混淆**：

| | `kgAsk`（图谱问答页） | `recallFor` / `contextFor`（AI 问答页） |
|---|---|---|
| 触发 | 用户在「知识图谱 → 问答」提问 | 普通 AI 对话时自动注入图谱上下文 |
| 检索方式 | LLM 实体识别 + BFS + 影响面闭包 | 纯词法评分（全名命中 +5 / name token +2 / desc token +1，**必须 `nameScore > 0`**） |
| 输出 | 流式回答 + `kg:facts` | `【知识图谱·本体层】` 上下文文本（每节点 ≤6 条关系） |
| 推理边 | **参与**（BFS 遍历全边集 + 闭包 `includeInferred:true`） | **参与**（`g.edges` 不过滤 `inferred`） |
| 范围隔离 | `hops` 参数 | `profileId` / `scope`（`'all'` / `'profile|*'` / `'profile|domain'`，逗号多选） |
| 原文回溯 | ✅ `collectRefs` ≤4 | ❌ 只给节点摘要 |

---

### 12.4 三步之间的不变量（改动前必读）

| # | 不变量 | 违反后果 |
|---|---|---|
| **I1** | **边身份键统一为 `${from}\|${to}\|${rel}`** —— `graph.js:putEdge`、`bridge.js:35 edgeKey`、`infer.js:mergeInferredEdges` 三处必须一致 | `inferredFrom` 下标错位 → 级联清理删错边；推导链 tooltip 显示错误前提 |
| **I2** | **原始图先落库，推理后追加**（§12.1.5） | 推理超时/异常 → 用户丢掉整批抽取结果 |
| **I3** | **旧推理边不参与新一轮合并**（`!e.inferred` 过滤） | 上一轮推理产物被当原始边再喂推理器 → 自我循环论证、边数虚增 |
| **I4** | **`saveGraph` 是图谱唯一写入口**（约束 D3）；`reason/*` 只返回数据不写 kv | 多写入口 → `inferredStale` 状态与图内容不一致 |
| **I5** | **推理层缺失时全链路静默降级**：`reasonReady()` false → `reasonEnabled()` false → `guard`/`reason`/`impact` 全为 null，抽取与问答照常 | 打包漏带 protege-js 时整个图谱功能不可用（测试 `:640-738` 用子进程 + `Module._load` 拦截专门守这条） |
| **I6** | **IRI 必须走 `NS`/`P`/`C` 常量**，禁止前缀简写 | 规则静默不触发，`materialize()` 照跑但推不出结论（§0.1） |
| **I7** | **各返回体字段数是测试硬契约**（见 §12.5 末行） | `npm test` 直接红 |

---

### 12.5 实现状态（v1.1，2026-09-13 核实）

| 能力 | 状态 | 代码锚点 |
|---|---|---|
| 步骤① 体系五级优先级解析 | ✅ | `graph.js:257-312`、`raws.js:528-547`、`jobs.js:resolveAutoDomain` |
| 步骤① 模版绑定优先于模型选择（两条入口一致） | ✅ v1 修正 | `jobs.js:647-649` 改为沿用 `tpl.ontologyProfile`；`raws.js:539-543` 原本即如此 |
| 步骤① 写前护栏（4 种 reason + 降级 + 日志） | ✅ | `guard.js:94-166`、`graph.js:506-524` |
| 步骤① 写侧互斥预检（第 5 种 reason `disjoint-type-forcing`） | ✅ v1.1 | `graph.js:525-557` |
| 步骤① 原始图先落库 | ✅ | `graph.js:592-600` |
| 步骤② OWL 2 RL 物化（78 规则 / ≤1000 轮 / 超时保护） | ✅ | `infer.js:97+`、`bridge.js:216+` |
| 步骤② 推理边持久化 + 级联清理 | ✅ | `infer.js:227-323`、`graph.js:1545-1581` |
| 步骤② 不一致冲突明细（cap 50） | ✅ | `graph.js:1435-1450`、`infer.js:40-95` |
| 步骤② `graphMeta` 4 字段 | ✅ | `graph.js:189-212` |
| 步骤② **全图校验通道 C** | ✅ v1 新增（v1.2.2 补全量计数 totals） | `reason/validate.js`、`graph.js:validateGraph`、IPC `graph:validate` |
| 步骤② **写侧互斥预检**（护栏第 5 种 reason `disjoint-type-forcing`） | ✅ v1.1 新增 | `graph.js:525-557`（domain/range 通过后再查 `guard.constraintOf` 强制类 vs `guard.checkDisjoint`，命中即降级 `fallbackRel` 并记 `guardLog`） |
| 步骤② **冲突自动修复通道 D**（规划/施加/撤销 + LLM 仲裁） | ✅ v1.1 新增 | `reason/repair.js`（10 导出）、`graph.js:1763-1923`（`REPAIR_UNDO_KEY` :1763、`planRepairs` :1777、`applyRepairs` :1851、`undoRepair` :1894、`repairUndoAvailable` :1918）、IPC `graph:planRepairs`/`applyRepairs`/`undoRepair`（`ipc.js:734-748`）、`renderer/graph.js:1047-1140`、`index.html:693`（`set-repair-llm`） |
| 步骤② **统一问题表 + 行级修复**（通道 C×D 打通） | ✅ v1.2.2 新增 | `reason/validate.js`（violation 17 键含归因/定位字段）、`reason/repair.js:planOneIssue/planIssues`、`graph.js:planRepairsForIssues`、IPC `graph:planRepairsForIssues`、`renderer/graph.js`（`#kg-vr-tbody` 7 列表 + `#kg-vr-scope`/`#kg-vr-kind` 筛选 + `.kg-vr-fix` 行级修复按钮）、测试 `graph-repair.test.js`「行级修复」段 |
| 步骤② 可观测面 6 处 | ✅ | §12.2.7 表 |
| 步骤③ 惰性重推理 | ✅ | `graph.js:898-917` |
| 步骤③ 实体识别 + 两级兜底 | ✅ | `graph.js:919-975` |
| 步骤③ BFS 事实 + 影响面闭包 + 归一化去重 | ✅ | `graph.js:976-1075` |
| 步骤③ 原文回溯 ≤4 | ✅ | `graph.js:collectRefs` |
| OWL 导入 6 格式 + profile 判别 + 预览 | ✅ | `reason/owlImport.js`、`reason/profile.js`、`graph.js:previewOwlImport` |
| **SWRL 业务规则**（G7 / 四期） | ❌ 未启动 | 无 `SWRLReasoner` 引用 |
| **OWL 重导入 diff**（G6 / 五期） | ❌ 未启动 | `importOwl` 仍整体覆盖 |
| 五元组数值约束 / aliases / status 六态机 | 🚫 范围外 | 见 §7 |

**测试硬契约（改字段即红）**：

| 返回体 | 字段数 | 断言位置 |
|---|---|---|
| `extractGraph()` | **10** | `graph-reason-integration.test.js:449` |
| `runInference()` | **12** | `:119` |
| `getGraphMeta()` | **4** | `:98` / `:108`（`clearGraph` 后按精确 JSON） |
| `getReasonState()` | **11**（IPC 层 +`ok` = 12；v1.1 起含 `repairLlm`/`repairUndoAvailable`） | `:283` / `:611` |
| `predicateFeatures()` 单项 | **8** | `:288-300` |
| `impactClosureFor()` | **9**（降级 **8**） | `:317-320` / `:374` |
| `deleteEdgeWithCascade()` / `deleteNodeWithCascade()` | **5** / **6** | `:389` / `:404` |
| `previewOwlImport()` | **6** | `:575` |
| `kg:facts` 载荷 | **4** | `:534` |
| `SKIP_REASON_TEXT` 键集 | **7** | `:66` |
| `GRAPH_STAGES` | **5**（`collect,extract,guard,reason,save`） | `jobs-tasks.test.js:126` |
| `validateGraph()`（通道 C） | **13**（v1.2.2 起含 `totalViolations`/`totalDisjointConflicts` 全量计数；降级 `{ok:false,error,at}` **3**） | `graph-validate.test.js`；降级探针在 `graph-reason-integration.test.js` |
| violation 单项（通道 C，v1.2.2） | **17**（`edgeKey,fromId,toId,inferred,from,fromType,rel,to,toType,reason,detail,expected,actual,profileId,profileName,domain,scopeLabel`） | `graph-validate.test.js:72` |
| `planRepairs()`（通道 D） | **8**（`ok,actions,byKind,autoCount,manualCount,conflictCount,llmArbitrate,at`；无冲突时另有 `hint`；降级 `{ok:false,error,at}` **3**） | `graph-repair.test.js` |
| `planRepairsForIssues()`（通道 D 行级，v1.2.2） | **8**（`ok,actions,byKind,autoCount,manualCount,conflictCount,llmArbitrate:false,at`；llmArbitrate 恒为 false——行级规划不走 LLM 仲裁；空 issues 时另有 `hint`） | `graph-repair.test.js` |
| `repair.planRepairs()` / `repair.planIssues()`（纯函数层） | **5**（`actions,byKind,autoCount,manualCount,conflictCount`） | `graph-repair.test.js` |
| `applyRepairs()` | **7**（`ok,applied,appliedZh,skipped,nodes,edges,rerun`） | `graph-repair.test.js` |
| `applyRepairsStepwise()`（v1.2） | **8**（`ok,applied,appliedZh,skipped,failedTasks,nodes,edges,rerun`）；中止抛 `AbortError`（`partial` 带同构字段） | `graph-repair.test.js`（修复作业段） |
| `repair.applyActions()`（纯函数层） | **4**（`nodes,edges,applied,skipped`）；`skipped[].reason` **5** 种固定文案 | `graph-repair.test.js` |
| `repair.js` 导出 | **10**（`keyOf,conflictRelKeys,findInducingEdges,isUnconstrained,lca,planOne,planOneIssue,planIssues,planRepairs,applyActions`；v1.2.2 增 `planOneIssue/planIssues`） | `graph-repair.test.js:44` |
| 推理 IPC 通道 | **14**（v1 起含 `graph:validate`；v1.1 起含 3 个修复通道；v1.2.2 起含 `graph:planRepairsForIssues`） | `:604-605`；修复 4 通道另在 `graph-repair.test.js:578` |

---

### 12.6 核实依据（文件 → 事实）

| 文件 | 核实到的事实 |
|---|---|
| `src/main/common/constants.js` | 三体系 classes/predicates/constraints/axioms 基数（11/8/10/8、21/15/12/18、14/14/12/18）与各公理类型条数——`node -e` 直接 `require` 统计，非抄注释 |
| `src/main/graph/reason/guard.js` | `checkEdge` 4 种 reason、合取语义、`strictUnknownType` 默认 false、`CACHE_MAX=8`、`coverage` 13 键（`inversePairs` 双向展开）、`checkDisjoint` 自 v1 起被 `reason/validate.js` 调用（cax-dw 只读等价检查）；v1.1 起 `constraintOf`/`checkDisjoint` 也被写侧互斥预检（`graph.js:525-557`）与 `repair.findInducingEdges` 调用 |
| `src/main/graph/reason/impact.js` | `IMPACT_KEYWORDS` 10 项、`DEFAULT_MAX_DEPTH=5`、`DEFAULT_MAX_NODES=500`、`impactToFacts` 的 `tag()` 与 `⚡推理` 后缀 |
| `src/main/graph/reason/infer.js` | `DEFAULT_MAX_ROUNDS=1000`、`PROGRESS_HINT_EDGES=20000`、上游 1 参 bug 与绕法、`mergeInferredEdges` 6 字段边形态、`removeEdgeWithCascade` 返回 `{removed,cascaded,edges}` |
| `src/main/graph/reason/bridge.js` | `edgeKey` 与 graph.js 一致、`FEATURE_IRI` 6 项、`AXIOM_TO_FEATURE` 7 项（ReflexiveProperty → null）、`graphToTriples` 跳过 `inferred`/悬空边；`conflictNodeIds`/`conflictChinese`/`enrichConflicts` 供冲突归因 |
| `src/main/graph/reason/repair.js` | 10 个导出、`planOne` 的 A/B/C 三类规则分派、`planRepairs` 三类去重签名（含 `prp-asyp` 无序节点对）、`applyActions` 先丢推理边再建索引 + 5 种跳过文案、LLM 仲裁仅作用于 `change-rel` 且候选集限定；v1.2.2 增 `planOneIssue`（按 reason 分派：谓词/域/值域 → 降级或删边，unknown-type → 按 detail 起点/终点标记 retype 到约束侧首类或兜底类，不相交行 → 委托 planOne cax-dw，其余 → manual）与 `planIssues`（逐行解析体系 + 去重） |
| `protege-js/src/inference/owl2rl.js` | 冲突 message 模板（`:200-217`、`:570-574`）：prp-irp `${x} ${p} itself`、prp-asyp `${x} ${p} ${y} and reverse`、cax-dw `${x} in disjoint ${c1} & ${c2}` —— `repair.conflictRelKeys` 的正则必须匹配这些模板 |
| `src/main/graph/graph.js` | `SKIP_REASON_TEXT` 7 码、`reasonTimeout` clamp 5–120、`INCONSISTENCY_DETAIL_CAP=50`、`lastGuard.entries` slice(0,50)、原始图先落库、`kgAsk` 全部阈值（80/5/20/40/120/4）、`recallFor` 评分与 `nameScore>0` |
| `src/main/jobs/jobs.js` | `GRAPH_STAGES` 5 键、guard stage 总是发出、`resolveAutoDomain` 重跑路径复用 `job.source.domain`；v1 起新建/命中模版路径也改为「模版绑定优先，绑定为空才调 `suggestOntologyProfile`」，与 `raws.js` 两入口对齐 |
| `src/renderer/raws.js` | `submitGroup` 无条件写 `extras.ontologyProfile`、卡片③ 模版绑定优先、4 处 general 组兜底读已死的 `settings.ontologyProfile` |
| `src/renderer/graph.js` | `renderKgReasonTab` 5 区块（v1 起）、`reasonSkipText` 10 码、`guardReasonText` **5 码**（v1.1 起含 `disjoint-type-forcing`）、`showGraphReasonBar` 文案、`kg-reason-block` 出现 5 次；v1.1 新增 `planAndPreviewRepairs`（:1047）/`showRepairPreviewModal`（:1072）/`undoLastRepair`（:1129） |
| `src/main/ipc.js` / `preload.js` / `web/kb-shim.js` | 推理通道 10 个（v1 起含 `graph:validate`）、`graph:impactClosure` 与 `graph:validate` 均支持双调用形态、preload 与 shim 绑定块一致 |
| `test/graph-reason-integration.test.js` | 上表全部字段数契约、stage 文案精确断言、降级子进程用 `Module._load` 拦截 `reason/*` |
| `test/graph-ontology.test.js` | bfo two-stage 恰好 2 次 `/chat/completions`（`:355-358`） |
| `test/jobs-tasks.test.js` | 13 处图谱作业提交**全部** `autoDomain:false` → `resolveAutoDomain` 未被测试覆盖，改 `jobs.js:647-649` 是测试安全的 |
| `docs/design/多领域自动拆分提取设计.md:140` | 「体系：优先 `tpl.ontologyProfile`；为空时 `suggestOntologyProfile`」——判定 `jobs.js` 为偏离方的文档依据 |
| `git log -S '体系不盲从模版绑定' -- src/main/jobs/jobs.js` | 恰好 1 个 commit `cb7f7cc`，此后从未修订 → 该逻辑是初次引入即偏离，非回归 |

---

## 附录 A：protege-js API 速查（本设计用到的子集）

```js
// 推理
const { OWL2RLReasoner, TripleStore } = require('@skaterqiang/protege-js/src/inference/OWL2RLReasoner');
const r = new OWL2RLReasoner(new TripleStore());
r.store.add(s, p, o);
r.materialize(maxRounds);
r.entails(s, p, o);
r.isConsistent();
r.inconsistencies;             // [{rule, message}]
r.getInferredCount();

// 查询
const { ReasonerQueries } = require('@skaterqiang/protege-js/src/inference/ReasonerQueries');
const q = new ReasonerQueries(r);
q.getSubClasses(clsIRI);
q.getInstances(clsIRI);
q.isSubClassOf(sub, sup);
q.isSatisfiable(clsIRI);

// SWRL
const { SWRLReasoner } = require('@skaterqiang/protege-js/src/inference/SWRLReasoner');
const { SWRLParser } = require('@skaterqiang/protege-js/src/io/SWRLParser');

// profile 校验
const { checkRL, checkQL, checkEL } = require('@skaterqiang/protege-js/src/profiles/OWL2Profiles');

// 解析器（按需）
const { RDFXMLParser } = require('@skaterqiang/protege-js/src/io/RDFXMLParser');
const { TurtleParser } = require('@skaterqiang/protege-js/src/io/TurtleParser');
const { FunctionalSyntaxParser } = require('@skaterqiang/protege-js/src/io/FunctionalSyntaxParser');
const { ManchesterSyntaxParser } = require('@skaterqiang/protege-js/src/io/ManchesterSyntaxParser');
const { OWLXMLParser } = require('@skaterqiang/protege-js/src/io/OWLXMLParser');
```

## 附录 B：与「纯 skill 路线」的对照

本设计选择**内嵌主进程**而非「写 skill 调 protege-js」，理由：

| 维度 | 内嵌（本设计） | skill 路线 |
|---|---|---|
| inferred 边持久化 | ✅ | ❌（沙盒无写权限） |
| 提取时自动推理 | ✅ | ❌（skill 问答时才触发） |
| domain/range 写入护栏 | ✅ | ❌（写边发生在主进程） |
| 级联清理 | ✅ | ❌ |
| 推理耗时 | 无超时限制 | 60s 沙盒上限 |
| 一次性推理问答 | 可（kgAsk 集成） | ✅ 更适合 |
| OWL 导入试解析 | 可（importOwl 集成） | ✅ 更适合 |

**互补关系**：本设计落地后，仍可额外写一个 `protege-js-reasoning` skill 覆盖「一次性推理问答」「本体质量审计」「SWRL 试算」等无需持久化的场景，作为内嵌能力的补充而非替代。
