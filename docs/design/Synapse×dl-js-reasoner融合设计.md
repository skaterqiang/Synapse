# Synapse × dl-js-reasoner 融合设计

> 状态：**v1.1（P1–P7 已全部实施并通过回归）** · 撰写日期 2026-09 · 适用 Synapse v1.0.0 / dl-js-reasoner 0.3.0
>
> 变更记录：v0.1 设计稿 → v1.0 P1–P6 落地（§9.2.1–§9.2.3、§11.1）→ **v1.1 新增 §12 DL 设置页（P7）**。
>
> 本文是 [`Synapse×protege-js融合设计.md`](./Synapse×protege-js融合设计.md)（下称「上游设计」，v1.2.2）的**续篇**。
> 上游设计把 Synapse 的本地推理能力建立在 protege-js 的 `OWL2RLReasoner`（OWL 2 RL 前向链物化）之上，
> 并在 §4.6 / §11 明确留下一句话：**「完整 OWL 2 DL 需要 HermiT / Pellet / ELK 等外部推理机」**。
> 本设计的任务，就是用纯 JavaScript 的 OWL 2 DL  hypertableau 推理机
> [`dl-js-reasoner`](https://www.npmjs.com/package/dl-js-reasoner)（HermiT 的 JS 移植，已发布 npm 0.3.0）
> 把这句话**变成历史**——让 Synapse 在**不引入 Java、不起服务、不联网**的前提下，
> 对导入的完整 OWL 2 DL 本体做一致性检查、不可满足类识别、分类、蕴含判定与合取查询。
>
> ⚠️ 本文所有行号锚点、字段契约、性能数字均经脚本实测核实，核实依据见**附录 B**。
> 凡标注 ⚠️ 的为「需在实施期再次确认」的项。

---

## §0 背景与现状对照

### 0.1 dl-js-reasoner 是什么

`dl-js-reasoner@0.3.0` 是 HermiT 1.4.5 的**纯 JavaScript 移植**，实现完整的 OWL 2 DL hypertableau 算法：

| 维度 | 内容 |
|---|---|
| 包名 / 版本 | `dl-js-reasoner` / `0.3.0`（npm `latest`，GitHub `skaterqiang/dl-js-reasoner` tag `v0.3.0`） |
| 入口 | `main: src/index.js`；`exports` 暴露 `.`、`./cli`、`./src/*.js` |
| 许可 | **LGPL-3.0-or-later** |
| 运行要求 | Node ≥ 18，**零运行时依赖**；`@skaterqiang/protege-js` 为**可选** peerDependency |
| 算法 | 完整 DL tableau：clausification、anywhere/ancestor blocking、backjumping、disjunction learning、nominal introduction、datatype reasoning |
| 适配层 | `src/adapter/protege.js` 的 `ProtegeAdapter` / `reasonerFor(ontology, config)`，**镜像 protege-js `ReasonerQueries` 的方法名** |

**关键事实（实测）**：`reasonerFor` 接受**任何带 `getAxioms()` 的对象**——既可以是 protege-js 解析出的
`OWLOntology`（duck-typing 直接吃 protege-js 公理对象，附录 B.2 已端到端验证），
也可以是**手工拼装的公理数组 shim**（附录 B.3 验证）。这意味着 Synapse **不必依赖 protege-js 也能驱动 DL 推理**。

### 0.2 Synapse 当前真实缺口（逐条对照上游设计）

上游设计 §1 的目标表里，G6（OWL 重导入 diff）与 G7（SWRL 业务规则）标注「未启动」。
但比这两个更根本的缺口，是**表达力天花板**。以下三处代码把天花板写死了：

**缺口 ①：非 RL 本体被判定为「无法本地推理」。**
`src/main/graph/reason/profile.js:188`（`explainProfile` 第三分支）逐字输出：

```
→ 无法本地推理：完整 OWL 2 DL 需要 HermiT / Pellet / ELK 等外部推理机。
  仍可导入类层级与谓词作为受控词表，只是不产生推理边。
```

`profile.js:detectProfile` 的 `reasonerAvailable` 直接等于 `rl.ok`（只有 RL 能在本地物化）。
`owlImport.js:buildPreview` 据此对每个非 RL 本体推送告警：
「该本体不属于 OWL 2 RL，Synapse 内置推理机无法对其做完整本地推理」。
**dl-js-reasoner 的存在使这两句话同时为假。**

**缺口 ②：导入时丢弃 12 类公理 + 全部匿名类表达式 + 整个 ABox。**
`owlImport.js:634-648` 的 `SKIPPED` 清单逐字列出被跳过的公理类型：

| # | 被跳过的公理类型 | dl-js-reasoner 是否支持 |
|---|---|---|
| 1 | `EQUIVALENT_CLASSES 等价类` | ✅ |
| 2 | `DISJOINT_UNION 不相交并` | ✅ |
| 3 | `SUB_OBJECT_PROPERTY_OF 子属性` | ✅ |
| 4 | `SUB_PROPERTY_CHAIN_OF 属性链` | ✅ |
| 5 | `EQUIVALENT_OBJECT_PROPERTIES 等价属性` | ✅ |
| 6 | `DISJOINT_OBJECT_PROPERTIES 不相交属性` | ✅ |
| 7 | `HAS_KEY 键约束` | ✅ |
| 8 | `SAME_INDIVIDUAL 相同个体` | ✅ |
| 9 | `DIFFERENT_INDIVIDUALS 不同个体` | ✅ |
| 10 | `DATATYPE_DEFINITION 自定义数据类型` | ✅ |
| 11 | `NEGATIVE_OBJECT_PROPERTY_ASSERTION 否定属性断言` | ✅ |
| 12 | `SUB_DATA_PROPERTY_OF 子数据属性` | ✅ |
| — | `AnonymousClassExpression 匿名类表达式` | ✅ |
| — | `ABoxDropped 个体断言`（Turtle 路径丢失个体） | ✅ |

每一条的备注都是「Synapse 体系结构不支持，已跳过」。**这 12 类恰恰是 dl-js-reasoner 能消费的表达力。**
导入环节把推理机唯一能利用的语义信息扔掉了。

**缺口 ③：推理只有「物化边」一种产物，没有查询能力。**
protege-js 的前向链推理机只能做三元组物化，**没有任何查询 API**。
`kgAsk` 的事实召回因此只能是 BFS 邻居扩展（`graph.js:1129-1150`，`.slice(0, 80)` 截断在 `:1150`）。
dl-js-reasoner 提供**合取查询（CQ）**：`query(spec)` / `answerQuery(spec)`，
支持 `{class}`（含子类语义）、`{objectProperty}`、`{inverseObjectProperty}`、`{dataProperty}`、`{datatype}`、`{differentFrom}` 原子。

### 0.3 关键判断

1. **DL 不是 RL 的替代品，而是补充。** RL 前向链是多项式时间、可物化、适合 Synapse 原生图谱（bfo-lite 等内置体系 + 抽取产生的 ABox）。DL tableau 最坏情况指数级，适合**导入的、有真实 TBox 表达力的 OWL 本体**。两者应**并存**，按体系特征选择。
2. **DL 的最大价值在 TBox 推理，不在 ABox 物化。** 实测（附录 B.4）：纯 TBox 分类极快（500 类 → 构造 11ms、一致性 0ms、`getSubClasses` 143ms）；但带 ABox 的一致性检查在 100 类 / 200 个体 + 传递属性链的场景下要 **~8 秒**，`getInstances` 要 **~10.7 秒**。因此 DL 应**默认只做 TBox 级推理**（一致性、不可满足类、分类、蕴含），ABox 级推理（realisation、实例查询）必须**按规模门控 + 显式触发**。
3. **`individualTaskTimeout` 可用但粒度粗。** 实测 2000ms 超时确实抛 `InterruptedException`，但 wall-clock 是 7656ms（中断标志只在 tableau 的若干检查点被轮询）。**`interrupt()` 无法从定时器打断同步推理**（JS 单线程，实测 `setTimeout` 回调在推理结束前根本不执行）。真正的「可取消」需要 worker 线程——这是 §9 风险 R1 的核心。
4. **CQ 仅限 Horn 本体。** 实测非 Horn 本体（含 `DisjointUnion`）调用 `query()` 抛
   `The supplied DL ontology contains rules with disjunctive heads.`。
   但 `getDLOntology().isHorn` 提供**廉价预检**，可在调用前判定。
5. **IRI 保真有一个 protege-js 解析器陷阱。** 实测 `FunctionalSyntaxParser` **不展开空前缀** `Prefix(:=<http://ex.org/>)`——`:A` 会被原样保留为字符串 `":A"`（命名前缀 `ex:` 则正常展开为 `http://ex.org/A`）。这影响「直接把解析出的 OWLOntology 喂给 DL」的方案，是 §3 选择「从归一化 profile 合成 DL 公理」而非「透传原始 ontology」的决定性理由之一。

---

## §1 设计目标

| 编号 | 目标 | 验收口径 |
|---|---|---|
| **DG1** | 非 RL 的完整 OWL 2 DL 导入本体可在本地做**一致性 / 不可满足类 / 分类 / 蕴含**推理 | `profile.js` 不再对 DL 本体输出「无法本地推理」；推理 Tab 展示不可满足类清单 |
| **DG2** | 导入环节**保留** 12 类被跳过公理 + 匿名类表达式，供 DL 消费 | `owlImport.js` 的 `SKIPPED` 清单缩短；profile 携带 `dlAxioms` |
| **DG3** | DL 推理结果以**与 RL 同口径**的推理边落库，复用既有级联清理 | 新 `inferredVia:'dl-tableau'` / `inferredBy:'dl-js-reasoner'`；`mergeInferredEdges` / `removeEdgeWithCascade` 不改 |
| **DG4** | 提供**合取查询**能力，升级 `kgAsk` 的事实召回（Horn 本体） | 新 IPC 通道 `graph:dlQuery`；`kgAsk` 在命中 DL 体系时优先用 CQ |
| **DG5** | DL 推理**按规模门控 + 可超时 + 静默降级**，绝不拖垮主链路 | `individualTaskTimeout` 生效；超规模自动跳过并留痕；dl-js-reasoner 缺失时全链路无感降级（I5） |
| **DG6** | 不破坏上游设计 §12.5 的**任何既有硬契约**（除非本文明确列出并同步改测试） | `npm test` 全绿；契约变更集中在 §9 表 T1 |
| **DG7** | 为上游设计 §8 **四期（SWRL）** 铺路：dl-js-reasoner 已实现 SWRL 规则归一化与 clausification | 本文 §10 说明四期可基于本设计落地；SWRL built-ins 与 `isEntailed(swrlRule)` 仍不支持，如实标注 |

### 非目标

- **不替换** protege-js 的 RL 物化路径。RL 仍是 Synapse 原生图谱的默认推理机（D2）。
- **不做** DL 的增量推理（dl-js-reasoner 的 `flush()` 会清空全部推理缓存，等价于重算；Synapse 的批处理模型 D4 本就不需要增量）。
- **不做** SWRL built-ins（`swrlb:`，dl-js-reasoner 的 `RuleNormalizer` 直接抛错）。
- **不做** EL 风格 description graph（dl-js-reasoner 未移植 `DescriptionGraphManager`）。
- **不做** owl:imports 的自动遍历——dl-js-reasoner 明确要求调用方先合并；Synapse 的 `ontologyBundle.js` 已经解决了合并问题（见 §3.5）。
- **不引入** Java / 外部进程 / 网络推理服务。

---

## §2 总体架构

### 2.1 推理层全景（DL 加入后）

```
┌──────────────────────────────────────────────────────────────────────────┐
│  graph.js  （唯一写入口 saveGraph；惰性 reason() 装载 9→10 个模块）          │
│    runInference(settings,opts)   getReasonState(pid)   reasonStatus()       │
│    importOwl / previewOwlImport  kgAsk  validateGraph  planRepairs …        │
└───────────────┬────────────────────────────────────────────────────────────┘
                │ reason() 惰性 require
   ┌────────────┼─────────────────────────────────────────────────────────┐
   │            ▼            reason/ 子目录（上游设计 D2）                   │
   │  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────────┐   │
   │  │  infer.js    │   │  bridge.js   │   │  dl.js  ★本设计新增★      │   │
   │  │ RL 物化主流程 │   │ profile↔三元组│   │ DL tableau 适配 + 结果映射 │   │
   │  │ materialize  │   │ IRI 常量(I6) │   │ reasonerFor / query / …   │   │
   │  │ Graph        │   │ edgeKey(I1)  │   │ 规模门控 / 超时 / 降级     │   │
   │  └──────┬───────┘   └──────┬───────┘   └────────────┬─────────────┘   │
   │         │                  │                        │                  │
   │         │  OWL 2 RL        │  共用 IRI/edgeKey       │  OWL 2 DL        │
   │         ▼                  ▼                        ▼                  │
   │  @skaterqiang/protege-js   bridge.iriType/iriRel   dl-js-reasoner       │
   │  OWL2RLReasoner（78 规则）  /iriId/edgeKey          reasonerFor(ont,cfg) │
   │                                                        │                │
   │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │                │
   │  │ profile.js   │  │ owlImport.js │  │ validate.js  │ │                │
   │  │ 子语言判定    │  │ OWL→profile  │  │ 只读护栏体检  │ │                │
   │  │ +DL 裁决★    │  │ +保留DL公理★ │  │（不依赖推理） │ │                │
   │  └──────────────┘  └──────────────┘  └──────────────┘ │                │
   │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │                │
   │  │ impact.js    │  │ guard.js     │  │ repair.js    │ │                │
   │  │ ontologyBundle│ │（提取时护栏） │  │（冲突修复）   │ │                │
   │  └──────────────┘  └──────────────┘  └──────────────┘ │                │
   └────────────────────────────────────────────────────────┼────────────────┘
                                                             ▼
                                              推理边 / 不可满足类 / CQ 答案
                                              → mergeInferredEdges → saveGraph
```

★ = 本设计改动的既有模块；`dl.js` 为唯一新增文件。

### 2.2 关键决策

| 编号 | 决策 | 理由 |
|---|---|---|
| **D1** | dl-js-reasoner 以 **npm 依赖** `"dl-js-reasoner": "^0.3.0"` 引入，与 `@skaterqiang/protege-js` 并列 | 已发布 npm；其可选 peer `@skaterqiang/protege-js` Synapse 已装。回答上游设计 §11 Q1 的同类问题：不走 `file:` 本地路径 |
| **D2** | **RL 与 DL 并存，按体系选择**：内置体系（bfo-lite 等）与抽取图谱走 RL；`owl:true` 且 TBox 表达力超出 RL 的导入体系走 DL | RL 多项式、可物化、已验证；DL 指数级、适合 TBox 推理。不互相替换 |
| **D3** | **从归一化 profile 合成 DL 公理**，而非透传 protege-js 解析出的 `OWLOntology` | ① 规避 §0.3-5 的空前缀 IRI 陷阱；② 遵守 I6（IRI 走 bridge 常量，与 RL 路径、edgeKey 一致）；③ protege-js 缺失时仍可推理；④ profile 已是持久化通货。代价：需要 §4.3 扩展 profile 携带 DL 公理 |
| **D4** | DL 推理**默认只做 TBox 级**（一致性 / 不可满足类 / 分类 / 蕴含）；ABox 级（realisation / 实例 / CQ）**按规模门控 + 显式触发** | 实测 ABox 推理在百级个体 + 传递属性时达秒级～十秒级（附录 B.4）。TBox 级始终毫秒级 |
| **D5** | DL 结果**复用 RL 的落库与级联通道**：推理边经 `mergeInferredEdges`，冲突经 `inconsistencies`，不新设持久化机制 | 遵守 I1/I3/I4；`inferredVia`/`inferredBy` 取值区分来源即可 |
| **D6** | dl-js-reasoner 缺失或抛错时**静默降级**回 RL-only 行为，`reasonReady()` 语义不变 | 遵守 I5。DL 是增强项，不是前置依赖 |
| **D7** ⚠️ | ABox 级 DL 推理的**真·可取消**需要 worker 线程；本期先用 `individualTaskTimeout`（粗粒度）+ 规模门控，worker 化列为开放问题 Q-DL-1 | 实测 `interrupt()` 无法从定时器打断同步推理（附录 B.5）。worker 化是独立工程，不应阻塞本期 |

---

## §3 数据流与桥接

### 3.1 总数据流

```
导入期（一次性）：
  OWL 文件 ──protege-js解析──▶ OWLOntology ──ontologyToProfile──▶ profile
                                              │（★新增：保留 12 类 DL 公理 + 匿名类表达式）
                                              ▼
                                        profile.dlAxioms[]  ──存 kv.owlProfiles──▶ 持久化

推理期（每次 runInference / kgAsk 惰性重推理）：
  profile + 图谱(nodes,edges)
      │
      ├─[RL 路径]─▶ bridge.graphToTriples ─▶ protege-js OWL2RLReasoner.materialize ─▶ 推理边
      │
      └─[DL 路径★]─▶ dl.buildDLOntology(profile, graph)
                        │  合成 { getAxioms(): [...] } shim（IRI 走 bridge 常量，I6）
                        ▼
                     reasonerFor(shim, config)
                        │  TBox 级：isConsistent / getUnsatisfiableClasses / classify / isEntailed
                        │  ABox 级（门控）：getTypes / getInstances / getObjectPropertyValues / query
                        ▼
                     dl.collectResults() ─▶ { inferredEdges, inconsistencies, unsatClasses, hierarchy, cqAnswers }
                        │
                        ▼
                     mergeInferredEdges(rawEdges, inferredEdges) ─▶ saveGraph
```

### 3.2 IRI 方案（遵守 I6）

DL 路径**完全复用** `bridge.js` 的 IRI 常量与函数，确保与 RL 路径、`edgeKey` 三者口径一致（I1）：

| Synapse 概念 | IRI 构造函数 | 实测样例 |
|---|---|---|
| 节点个体 | `bridge.iriId(nodeId)` = `https://synapse.local/id/` + `encodeURIComponent(nodeId)` | `https://synapse.local/id/c1` |
| 体系类 | `bridge.iriType(typeKey)` = `https://synapse.local/type/` + enc | `https://synapse.local/type/Device` |
| 体系谓词 | `bridge.iriRel(relKey)` = `https://synapse.local/rel/` + enc | `https://synapse.local/rel/hasPart` |

dl-js-reasoner 的 `E.iriString()` 能识别字符串、`{iri}`、protege-js `IRI`（`_iri`）等多种形态（附录 B.1），
因此**用字符串 IRI 即可**，无需构造 protege-js 实体对象。
返回结果（IRI 字符串）经 `bridge.dec()` 反解回 Synapse 的 `nodeId` / `typeKey` / `relKey`。

> ⚠️ 实施注意：DL 返回的 IRI 含 `owl:Thing`（`http://www.w3.org/2002/07/owl#Thing`）与 `owl:Nothing`，
> 以及 `getSubClasses(direct=true)` 会带出 `owl:Nothing`、`getTypes` 会带出 `owl:Thing`（附录 B.3 实测）。
> `dl.js` 必须**过滤这两个内置 IRI**，否则会把它们当成 Synapse 节点写进图谱。

### 3.3 profile + 图谱 → DL 公理（合成映射表）

`dl.buildDLOntology(profile, graph)` 把归一化 profile 与图谱 ABox 合成为 dl-js-reasoner 公理数组。
所有公理用 dl-js-reasoner 的 `E` 工厂或**朴素对象**（`{ axiomType: AT.X, ... }`）构造——
实测两种形态都被接受（附录 B.3）。`AT` = `require('dl-js-reasoner/src/owl/OWLExpressions.js').AxiomType`。

**TBox（来自 profile）：**

| Synapse profile 来源 | DL 公理构造 | 备注 |
|---|---|---|
| `classes[].key` | `E.owlClass(iriType(key))` + `{axiomType:AT.DECLARATION, entity}` | 每个类一条 Declaration |
| `classes[].parent`（非空） | `E.subclassOf(C(child), C(parent))` | 类层级 |
| `predicates[].key` | `E.objectProperty(iriRel(key))` + Declaration | 谓词 |
| `predicates[].domain` | `{axiomType:AT.OBJECT_PROPERTY_DOMAIN, property, domain:C(domain)}` | |
| `predicates[].range` | `{axiomType:AT.OBJECT_PROPERTY_RANGE, property, range:C(range)}` | |
| `predicates[].features` 含 `transitive` | `{axiomType:AT.TRANSITIVE_OBJECT_PROPERTY, property}` | |
| 含 `symmetric` | `{axiomType:AT.SYMMETRIC_OBJECT_PROPERTY, property}` | |
| 含 `asymmetric` | `{axiomType:AT.ASYMMETRIC_OBJECT_PROPERTY, property}` | |
| 含 `functional` | `{axiomType:AT.FUNCTIONAL_OBJECT_PROPERTY, property}` | |
| 含 `inverseFunctional` | `{axiomType:AT.INVERSE_FUNCTIONAL_OBJECT_PROPERTY, property}` | |
| 含 `irreflexive` | `{axiomType:AT.IRREFLEXIVE_OBJECT_PROPERTY, property}` | |
| 含 `reflexive` | `{axiomType:AT.REFLEXIVE_OBJECT_PROPERTY, property}` | ⚠️ RL 路径忽略此项（bridge `AXIOM_TO_FEATURE` 映射为 null），DL 路径**支持** |
| `predicates[].inverseOf` | `{axiomType:AT.INVERSE_OBJECT_PROPERTIES, firstProperty, secondProperty}` | |
| `axioms[]` type=`DisjointClasses` | `E.disjointClasses([C(s), C(o)])` | |
| `axioms[]` type=`SubClassOf` | `E.subclassOf(C(s), C(o))` | |
| `axioms[]` type=`EquivalentProperties` | `{axiomType:AT.EQUIVALENT_OBJECT_PROPERTIES, properties:[...]}` | |
| **`profile.dlAxioms[]`（★§4.3 新增）** | 逐条按 §3.4 表转换 | 12 类被跳过公理 + 匿名类表达式 |

**ABox（来自图谱，仅 ABox 级推理时合成，受 D4 门控）：**

| Synapse 图谱来源 | DL 公理构造 |
|---|---|
| 节点 `n`（`id`, `type`） | `E.classAssertion(C(n.type), I(n.id))` + `{axiomType:AT.DECLARATION, entity:I(n.id)}` |
| 原始边 `e`（`from`,`to`,`rel`，`!e.inferred`） | `E.objectPropertyAssertion(P(e.rel), I(e.from), I(e.to))` |

> 参数顺序实测：`E.classAssertion(classExpr, individual)`、`E.objectPropertyAssertion(property, subject, object)`（附录 B.3 验证通过）。

### 3.4 12 类被跳过公理 → DL 公理（§4.3 保留后的转换）

protege-js 解析出的公理对象字段名已实测（附录 B.2）。`dl.js` 按下表把 `profile.dlAxioms[]` 转为 DL 公理。
**注意**：dl-js-reasoner 能直接 duck-type protege-js 公理对象，但 D3 选择从 profile 合成，
因此 `dlAxioms` 存的是**结构化中立形态**（不绑定 protege-js 对象），转换时再拼 DL 公理：

| dlAxioms.type | 存储字段（中立形态） | DL 公理 |
|---|---|---|
| `EquivalentClasses` | `classExpressions:[iriKey...]` | `E.equivalentClasses(classExpressions.map(C))` |
| `DisjointUnion` | `owlClass:key, classExpressions:[...]` | `{axiomType:AT.DISJOINT_UNION, owlClass:C(owlClass), classExpressions:classExpressions.map(C)}` |
| `SubObjectPropertyOf` | `subProperty, superProperty` | `{axiomType:AT.SUB_OBJECT_PROPERTY_OF, subProperty:P(s), superProperty:P(o)}` |
| `SubPropertyChainOf` | `propertyChain:[...], superProperty` | `{axiomType:AT.SUB_PROPERTY_CHAIN_OF, propertyChain:chain.map(P), superProperty:P(sp)}` |
| `EquivalentObjectProperties` | `properties:[...]` | `{axiomType:AT.EQUIVALENT_OBJECT_PROPERTIES, properties:properties.map(P)}` |
| `DisjointObjectProperties` | `properties:[...]` | `{axiomType:AT.DISJOINT_OBJECT_PROPERTIES, properties:properties.map(P)}` |
| `HasKey` | `classExpression, propertyExpressions:[...]` | `{axiomType:AT.HAS_KEY, classExpression:C(ce), propertyExpressions:props.map(P)}` |
| `SameIndividual` | `individuals:[nodeId...]` | `E.sameIndividual(individuals.map(I))` |
| `DifferentIndividuals` | `individuals:[nodeId...]` | `E.differentIndividuals(individuals.map(I))` |
| `DatatypeDefinition` | `datatype, dataRange` | `{axiomType:AT.DATATYPE_DEFINITION, datatype:E.datatype(dt), dataRange}` |
| `NegativeObjectPropertyAssertion` | `subject, property, object` | `E.negativeObjectPropertyAssertion(P(p), I(s), I(o))` |
| `SubDataPropertyOf` | `subProperty, superProperty` | `{axiomType:AT.SUB_DATA_PROPERTY_OF, subProperty:E.dataProperty(s), superProperty:E.dataProperty(o)}` |
| `AnonymousClassExpression` | 结构化类表达式树 | 用 `E.objectIntersectionOf` / `objectUnionOf` / `objectComplementOf` / `objectSomeValuesFrom` 等递归构造 |

> ⚠️ 属性链正则性：dl-js-reasoner 的 `ObjectPropertyInclusionManager.checkForRegularity`
> 会对**循环属性层级**抛 `IllegalArgumentException: The given property hierarchy is not regular`（附录 B.2 实测触发）。
> `dl.js` 必须在 `reasonerFor` 外 try/catch，把这类错误降级为「该体系 DL 推理不可用」而非崩溃（I5）。

### 3.5 owl:imports 的合并（复用 ontologyBundle.js）

dl-js-reasoner **不遍历 owl:imports**（README 明确：调用方须先合并）。
Synapse 的 `reason/ontologyBundle.js` 已经实现了「主本体 + 依赖发现/下载/合并为单一 profile」
（`discoverDependencies` / `mergeProfiles` / `importBundle`）。
因此 **bundle 导入产生的合并 profile 是 DL 的天然输入**，无需 dl-js-reasoner 侧做任何 imports 处理。
单文件导入（`importOwl`）若声明了 imports，`buildPreview` 已有 `hasImportsDecl` 标记，
DL 路径据此提示用户「建议走体系化导入以合并依赖」。

---

## §4 核心模块设计

### 4.1 `reason/dl.js`（★唯一新增文件）

职责：**dl-js-reasoner 的可用性探测、DL 公理合成、推理驱动、结果映射、规模门控与降级**。
模仿 `infer.js` 的「不写 kv、只返回结果」契约（上游设计 D3）与 `owlImport.js` 的惰性 `PJ` 模块袋模式。

```js
// 结构骨架（非最终代码，示意接口）
let DL = null, dlError = '';
function dlAvailable() {                       // ≈ infer.js:32 reasonerAvailable()
  if (DL) return true; if (dlError) return false;
  try { DL = require('dl-js-reasoner'); return true; }
  catch (e) { dlError = String(e.message || e); return false; }
}
function dlError_() { return dlError; }

// profile+graph → { getAxioms() } shim（IRI 走 bridge 常量，I6）
function buildDLOntology(profile, graph, opts) { /* §3.3/§3.4 */ }

// 规模门控（D4）：返回 { allowTBox, allowABox, reason }
function gateScale(profile, graph, limits) { /* §4.1.1 */ }

// TBox 级推理（始终允许）
function reasonTBox(ont, config) {
  // → { consistent, unsatClasses:[], hierarchy:{}, elapsedMs, stats }
}
// ABox 级推理（门控 + 显式触发）
function reasonABox(ont, config, opts) {
  // → { inferredEdges:[], inconsistencies:[], types:{}, elapsedMs }
}
// 合取查询（仅 Horn）
function answerCQ(ont, spec, config) {
  // getDLOntology().isHorn 预检 → query(spec) → Term[][] → Synapse 形态
}
module.exports = { dlAvailable, dlError: dlError_, buildDLOntology, gateScale,
                   reasonTBox, reasonABox, answerCQ, DL_LIMITS };
```

#### 4.1.1 规模门控（`gateScale`）

实测数据（附录 B.4，Node v22 本机）驱动门控阈值：

| 场景 | 类 | 个体 | 公理 | isConsistent | getInstances |
|---|---|---|---|---|---|
| 纯 TBox | 500 | 0 | 1002 | **0ms** | — |
| 纯 TBox | 200 | 0 | 402 | **0ms** | getSubClasses 39ms |
| ABox 链 | 20 | 20 | 101 | 7ms | 12ms |
| ABox 链 | 50 | 50 | 251 | 48ms | 84ms |
| ABox 链 | 50 | 100 | 401 | 517ms | 825ms |
| ABox 链 | 100 | 200 | 801 | **7933ms** | **10752ms** |

门控规则（`DL_LIMITS`，可经 settings 覆盖）：

- **TBox 级**：类数 ≤ `DL_MAX_CLASSES`（默认 **2000**）始终允许；超出则跳过 DL，留痕 `skipReason:'dl-too-large'`。
- **ABox 级**：仅当 `个体数 × 类数 ≤ DL_ABOX_BUDGET`（默认 **20000**，对应实测 ~50×100≈401 公理 / 517ms 的安全区）**且**用户在 UI 显式触发「深度推理」时允许；否则只做 TBox 级。
- **传递属性 + 大 ABox** 是最坏情况（实测 100×200 → 8s）：检测到 `transitive`/`SubPropertyChainOf` 且个体数 > `DL_TRANSITIVE_INDIVIDUAL_CAP`（默认 **80**）时，ABox 级自动降级为 TBox 级并告警。
- 所有 DL 推理一律设 `individualTaskTimeout = reasonTimeoutSec(settings) × 1000`（复用既有超时设置，默认 30s）。

#### 4.1.2 结果映射

| DL 产物 | Synapse 形态 | 落点 |
|---|---|---|
| `isConsistent()===false` | `inconsistencies` 增一条 `{rule:'dl-inconsistent', message, messageZh:'本体不一致（DL tableau 检出）', profileId, profileName}` | `runInference` 的 `allInconsistencies` |
| `getUnsatisfiableClasses()`（过滤 owl:Thing/Nothing） | 每个不可满足类 → 一条「类不可满足」记录 + 可选推理边（见下） | `meta.lastStats.dl.unsatClasses` |
| `getSubClasses/getSuperClasses`（分类） | 类层级边 `inferredVia:'dl-classify'`（仅当与 profile 既有 parent 不同时才落，避免冗余） | `inferredEdges` |
| `getTypes(individual)`（realisation，门控） | 类型断言边 `inferredVia:'dl-realise'` | `inferredEdges` |
| `getObjectPropertyValues`（门控） | 属性断言边 `inferredVia:'dl-tableau'` | `inferredEdges` |
| `isEntailed(axiom)` | 蕴含探针结果（UI 交互式，不落库） | IPC 返回 |
| `query(spec)` 答案 | CQ 答案行（UI / kgAsk，不落库） | IPC 返回 |

推理边形态**严格遵守** `infer.js:mergeInferredEdges` 的 7 键契约：
`{from, to, rel, inferred:true, inferredFrom, inferredVia, inferredAt, inferredBy}`，
其中 `inferredBy:'dl-js-reasoner'`，`inferredVia` 取上表值，`inferredFrom` 经 `inferredFromKeys` → 索引解析（I1）。

> ⚠️ `getInstances(C, direct)` 的 `direct` 语义需实施期实测确认：附录 B.3 中
> `getInstances(Device, true)` 返回了 Charger/Battery 的实例（按 OWL API「最具体类型」语义本应排除）。
> 在确认前，ABox 级实例查询**一律用 `direct=false`** 并由 `dl.js` 自行按 profile 类层级过滤。

### 4.2 `reason/profile.js`（★改：DL 裁决）

**改动点 1：`PROFILE_META` 增补 DL 行**（`:54` 附近）。QL/EL 的 `localReasoning` 由 `false` 改为
「经 DL 可为 true」，并新增 `DL` 元信息：

```js
DL: { id:'DL', name:'OWL 2 DL', desc:'完整描述逻辑，dl-js-reasoner 本地 tableau 推理',
      localReasoning:true, reasoner:'dl-js-reasoner（HermiT JS 移植）', complexity:'最坏 2-ExpTime，实测 TBox 毫秒级' }
```

**改动点 2：`detectProfile` 的 `reasonerAvailable` 裁决**（`:89`）。
现状 `reasonerAvailable: rl.ok`。改为：

```js
reasonerAvailable: rl.ok || dlAvailableFor(ontology, opts)
```

其中 `dlAvailableFor` = `dl.dlAvailable() && 类数 ≤ DL_MAX_CLASSES && 属性层级正则`。
返回体**保持 9 键不变**（`available, rl, ql, el, recommend, reasonerAvailable, profiles, meta` + 可选 `error`），
但 `recommend` 逻辑扩展：`rl.ok ? 'RL' : (dlAvailableFor(...) ? 'DL' : (ql.ok ? 'QL' : (el.ok ? 'EL' : null)))`。

> ⚠️ 硬契约：`preview.profileCheck` 被 `graph-reason-integration.test.js:586` 以**完整 JSON 相等**断言：
> `{"recommend","profiles","reasonerAvailable","rl":{ok,total,sample},"ql":{ok,total},"el":{ok,total}}`。
> 新增 `recommend:'DL'` 取值或 `dl` 子对象都会破坏该断言 → 见 §9 表 T1，必须同步改测试。

**改动点 3：`explainProfile` 第三分支重写**（`:188`）。删除「无法本地推理：完整 OWL 2 DL 需要 HermiT / Pellet / ELK」，
替换为：

```js
if (dlAvailable) {
  lines.push('→ 可本地推理：dl-js-reasoner（OWL 2 DL tableau）支持一致性、不可满足类、分类、蕴含与合取查询。');
  lines.push('  ABox 级深度推理（实例类型/属性值）按规模门控，超大规模仅做 TBox 级。');
} else {
  lines.push('→ 暂无法本地推理：dl-js-reasoner 未安装，或本体规模/属性层级超出 DL 门控。');
  lines.push('  仍可导入类层级与谓词作为受控词表。');
}
```

`explainProfile` 返回体**保持 4 键**（`headline, lines, canReasonLocally, recommend`），`canReasonLocally` 改为 `rl.ok || dlAvailable`。

### 4.3 `reason/owlImport.js`（★改：保留 DL 公理）

**改动点 1：缩短 `SKIPPED` 清单**（`:634-648`）。
现状 12 类公理 + 匿名类表达式 + ABox 全部跳过。改为：
- `SUPPORTED_AXIOM_TYPES`（`:70`，现 12 类）**扩充**到覆盖 §3.4 表的全部类型；
- 原 `SKIPPED` 中 dl-js-reasoner 支持的类型**移出**，改存入 `profile.dlAxioms[]`（结构化中立形态，§3.4）；
- 仅保留 dl-js-reasoner **确实不支持**的跳过项（SWRL built-ins、annotation 推理、description graph）；
- `ABoxDropped` 项：Turtle 路径丢失个体的问题**仍在**（protege-js `triplesToOntology` 只还原 TBox），
  但 DL 路径的 ABox 来自**图谱节点/边**（§3.3），不依赖导入的个体断言，故此项对 DL 无影响——备注更新为
  「个体断言在 Turtle 路径丢失，但 DL 推理的 ABox 由图谱提供，不受影响」。

**改动点 2：`ontologyToProfile` 增 `dlAxioms` 采集**（`:294`）。
在既有 `pushAx`（`:459`，按 `SUPPORTED_AXIOM_TYPES` + `MAX_AXIOMS` 过滤）之外，
新增 `pushDlAx(type, payload)`，把 §3.4 表的公理以中立形态收进 `profile.dlAxioms`，
受新上限 `MAX_DL_AXIOMS`（默认 **600**）约束。匿名类表达式递归序列化为结构树。

**改动点 3：`profile` 对象增字段**（`:700` 附近）。
`profile.dlAxioms`（数组，默认 `[]`）、`profile.dlCapable`（布尔，`detectProfile` 的 DL 裁决结果）。
**注意**：profile 存入 `kv.owlProfiles`，新增字段对旧数据向后兼容（读取时 `|| []` / `|| false`）。

**改动点 4：`buildPreview` 的 DL 提示**（`:855`）。
- `profileCheck` 增 `dl` 子对象 `{available, reason, classCount, dlAxiomCount}`（⚠️ 破坏 :586 完整 JSON 断言，见 T1）；
- 当 `!profileCheck.reasonerAvailable && profileCheck.dl.available` 时，
  **不再推送**「Synapse 内置推理机无法对其做完整本地推理」告警，改推送
  「该本体超出 OWL 2 RL，但可由 dl-js-reasoner 做完整 OWL 2 DL 本地推理」；
- `notes` 增列保留的 DL 公理类型直方图（复用 `axiomHistogram`）。
- **`preview` 顶层字段数保持 18**（`:582` 硬契约）——DL 信息全部嵌进既有 `profileCheck` 子对象，不新增顶层键。

**改动点 5：保留解析出的 `OWLOntology`（可选，供未来透传）**。
现状 `importOwlExtended`（`:738`）解析后**丢弃** `OWLOntology`。
本设计 D3 选择从 profile 合成，故**不强制**保留；但为未来「直接透传 ontology 给 DL」（规避合成开销）留口子，
`importOwlExtended` 返回体可增 `ontology`（⚠️ 该返回体被 `graph.js:importOwl` 解构，需同步）。**本期不做**，列为 Q-DL-2。

### 4.4 `reason/infer.js`（★改：DL 分支）

`materializeGraph`（`:105`）现状只走 RL。改为**双路径**：

```js
function materializeGraph(graph, profile, opts) {
  // …既有 RL 逻辑…
  const rlResult = materializeRL(graph, profile, opts);   // 原 materializeGraph 主体
  // DL 增强：仅当 profile.dlCapable 且规模门控通过
  let dlResult = { inferredEdges:[], inconsistencies:[], unsatClasses:[], hierarchy:null, skipped:true };
  if (profile && profile.dlCapable && dl.dlAvailable()) {
    const gate = dl.gateScale(profile, graph, opts.limits);
    if (gate.allowTBox) {
      const ont = dl.buildDLOntology(profile, graph, { abox: gate.allowABox });
      const tbox = dl.reasonTBox(ont, dlConfig(opts));
      dlResult = { ...tbox, skipped:false };
      if (gate.allowABox && opts.deep) {
        const abox = dl.reasonABox(ont, dlConfig(opts), opts);
        dlResult.inferredEdges = [...dlResult.inferredEdges, ...abox.inferredEdges];
        dlResult.inconsistencies = [...dlResult.inconsistencies, ...abox.inconsistencies];
      }
    } else {
      dlResult.skipReason = gate.reason;   // 'dl-too-large' / 'dl-abox-budget' …
    }
  }
  // 合并 RL + DL 产物（DL 边去重：edgeKey 已存在则丢，与 mergeInferredEdges 同口径）
  return mergeResults(rlResult, dlResult);
}
```

- `stats` 增 `dl` 子对象 `{ran, consistent, unsatCount, dlInferred, elapsedMs, skipReason}`（**嵌套，不增顶层键**，避免破坏 13 键 stats 契约——⚠️ 实施期确认 stats 是否被完整 JSON 断言；附录 B.6 显示 stats 未被逐键断言，安全）。
- `skipReason` 新增取值见 §4.5（⚠️ 破坏 `SKIP_REASON_TEXT` 7 键契约，见 T1）。
- `mergeInferredEdges`（`:232`）、`removeEdgeWithCascade`（`:279`）、`countInferred`（`:331`）**完全不改**（D5）。

### 4.5 `graph.js`（★改：装载 + 编排）

**改动点 1：`reason()` 惰性装载增 `dl`**（`:135`，9 → 10 个模块）：

```js
_reason = { infer, guard, impact, bridge, owlImport, ontologyBundle, profile, validate, repair,
            dl: require('./reason/dl') };   // ★新增
```

`reasonReady()`（`:157`）语义**不变**（仍以 RL 的 `infer.reasonerAvailable()` 为准）——
DL 缺失不影响 `reasonReady`，遵守 I5/D6。新增 `reasonDlReady()` 供 UI 区分展示。

**改动点 2：`SKIP_REASON_TEXT` 增 DL 码**（`:172`，7 → N 键，⚠️ T1）：

```js
'dl-too-large':    '本体规模超出 DL 推理上限，已跳过深度推理',
'dl-abox-budget':  'ABox 规模超出 DL 预算，仅做 TBox 级推理',
'dl-non-horn':     '本体非 Horn，合取查询不可用（一致性/分类仍可用）',
'dl-timeout':      'DL 推理超时，已中断（保留原始图谱）',
'dl-unavailable':  'dl-js-reasoner 未安装或加载失败',
'dl-irregular':    '属性层级不正则（循环依赖），DL 推理不可用',
```

**改动点 3：`runInference` 的 per-profile 循环**（`:1490`）。
现状对每个 pid 调 `R.infer.materializeGraph`。由于 §4.4 已把 DL 分支收进 `materializeGraph`，
**`runInference` 主体几乎不改**——DL 产物随 `mat.inferredEdges` / `mat.inconsistencies` 自然汇入
`allInferred` / `allInconsistencies`，`perProfile` 条目增 `dl` 子对象。
返回体**保持 12 键**（`:121` 硬契约），DL 细节嵌进 `perProfile` 与 `lastStats`。

**改动点 4：`getReasonState`**（`:1628`，**保持 11 键**）。
DL 状态嵌进既有字段：`meta.lastStats.dl`（运行结果）、`features` 项不变（8 键契约）、
`coverage` 增 `dlCapable` 子键（⚠️ 确认 coverage 是否被完整断言）。新增顶层键会破坏 `:287`/`:612`，**禁止**。

**改动点 5：新 IPC 编排函数** `dlQuery(profileId, spec, settings)`、`dlEntail(profileId, axiom, settings)`、
`dlHierarchy(profileId, settings)`——供 §6 前端与 §4.7 kgAsk 调用。均走 `reason().dl`，缺失时返回 `{ok:false, reason:'dl-unavailable'}`。

### 4.6 IPC / preload / web-shim（★三处同步，遵守三重绑定约定）

新增通道（⚠️ 破坏 `:605/:606` 的 14 通道断言，见 T1）：

| 通道 | 方向 | 载荷 |
|---|---|---|
| `graph:dlQuery` | renderer→main | `{profileId, spec}` → `{ok, answers, columns, isHorn, elapsedMs}` |
| `graph:dlEntail` | renderer→main | `{profileId, axiom}` → `{ok, entailed, explain}` |
| `graph:dlHierarchy` | renderer→main | `{profileId}` → `{ok, tree, unsatClasses, consistent}` |

三处必须同步登记（缺一侧 → Web 模式静默 `undefined is not a function`）：
- `src/main/ipc.js`（`:815` 起的推理通道区）
- `preload.js`（`:208` 起的 `graphReasonState` 邻接区）
- `web/kb-shim.js`（`:180` 起）

### 4.7 `corpus/decorators/mergeGraph.js`（★改：第二推理入口）

**关键发现**：推理不止 `graph.js:runInference` 一个入口。
`corpus/decorators/mergeGraph.js:110-120` 在语料流水线里**独立**调用
`R.infer.materializeGraph(...)`（`guardOn = graph.reasonEnabled(settings)`、`timeoutMs = graph.reasonTimeoutSec(settings)*1000`）。

由于 §4.4 把 DL 分支收进了 `materializeGraph` **内部**，
**mergeGraph.js 无需改动即可自动获得 DL 能力**——这是 D5「复用既有通道」的直接收益。
但需验证：语料流水线的 `onto`（profile）是否带 `dlCapable`（取决于该 profile 是否经 §4.3 扩展的 owlImport 产生）。
内置体系（bfo-lite）`dlCapable:false`，自然只走 RL，行为不变。

> `corpus/build.js:62` 把 `reasonEnabled` 暴露为 `evalExpr` 白名单函数、`corpus/recipes.js:32,78` 声明
> `{layer:'guard', enabled:'reasonEnabled(settings)'}`——这些只读 `reasonEnabled`，DL 不改变其语义，无需改动。

### 4.8 `src/renderer/graph.js`（★改：推理 Tab 第 6 区块 + kgAsk）

见 §6。

---

## §5 持久化与级联

**完全复用**上游设计 §5 的机制，零新增持久化路径（D5）：

| 机制 | 复用方式 |
|---|---|
| 推理边落库 | `infer.js:mergeInferredEdges`（`:232`）——DL 边与 RL 边同口径合并，`edgeKey` 去重（I1） |
| 级联清理 | `infer.js:removeEdgeWithCascade`（`:279`）/ `removeNodeWithCascade`（`:321`）——按 `inferredFrom`/`inferredFromKeys` 传播，DL 边同样适用 |
| 陈旧标记 | `graph.js:setGraphMeta({inferredStale:true})`——图谱变更时置位，`kgAsk` 惰性重推理（上游 §12.3.2 stage 0.5）触发 DL 重算 |
| 清除推理边 | `graph.js:clearInferredEdges`（`:1698`）——按 `e.inferred` 过滤，DL 边一并清除 |
| 冲突明细 | `capInconsistencies`（`:1609`，`INCONSISTENCY_DETAIL_CAP=50`）——DL 冲突同口径截断留痕 |

**新增取值**（不改结构，只改值域）：
- `inferredVia`：增 `'dl-tableau'`、`'dl-classify'`、`'dl-realise'`（现有值域 `'symmetric'/'inverse'/'transitive'/'transitive+'/'unknown'`）。
  前端 `inferredViaName()`（`renderer/graph.js`）需增中文映射。
- `inferredBy`：增 `'dl-js-reasoner'`（现有 `'owl2rl'`）。
- `meta.lastStats.dl`：新子对象（`lastStats` 本就是自由形态，不破坏 4 键 `getGraphMeta` 契约）。

**不变量遵守**：I1（edgeKey 三处一致）、I2（原始图先落库）、I3（旧推理边不回喂，`!e.inferred` 过滤）、
I4（saveGraph 唯一写入口，dl.js 不写 kv）、I5（DL 缺失静默降级）、I6（IRI 走 bridge 常量）、I7（字段契约见 §9）。

---

## §6 前端改进

### 6.1 推理 Tab 第 6 区块「DL 深度推理」

`renderKgReasonTab`（`renderer/graph.js:1065`）现有 5 区块（概览 / 待处理问题 / 护栏日志 / 谓词特性 / 全图校验）。
新增第 6 区块，**仅当 `rs.coverage.dlCapable` 或 `meta.lastStats.dl.ran` 时渲染**：

```
┌─ DL 深度推理（dl-js-reasoner · OWL 2 DL tableau）──────────────┐
│ 一致性：✅ 一致 / ❌ 不一致（检出 N 处矛盾）                      │
│ 不可满足类：U（设备⊓损坏）、…（点击定位到图谱）                   │
│ 类层级：[展开树] Device ⊒ {Charger, Battery} …                  │
│ 蕴含探针：[选择公理] ⊨ ?  → 是/否 + 解释                          │
│ 合取查询：[spec 编辑器] → 答案表（仅 Horn 本体可用）              │
│ 规模门控：TBox 级 ✅ / ABox 级 ⚠️（个体×类=12000 ≤ 20000）       │
│ [运行深度推理]（ABox 级，受门控；超时 reasonTimeout）             │
└────────────────────────────────────────────────────────────────┘
```

- 不可满足类清单：点击 → 高亮图谱中该类节点（复用既有节点定位）。
- 蕴含探针：下拉选「类断言 / 子类 / 属性断言」+ 实体选择器 → `graph:dlEntail`。
- CQ 编辑器：结构化表单（select 变量 + where 原子），非自由文本（降低门槛）→ `graph:dlQuery`。
  非 Horn 本体时编辑器禁用并提示 `dl-non-horn`。
- `reasonSkipText`（`:1611`，现 10 码）增 DL 码映射（与 §4.5 `SKIP_REASON_TEXT` 对齐）。

> ★**实施偏差（已落地形态，见 §9.2.3-B）**：
> ① **规模门控行不显示预算分母**。上图的 `个体×类=12000 ≤ 20000` 被改为只报「已用量 + 放行/超限结论」——
>    分母 `DL_LIMITS.aboxBudget` 在主进程，前端硬编码一份必然随主进程调整而漂移；结论本身才是用户要的。
> ② **不可满足类的「点击定位」用事件委托实现**（`panel.addEventListener('click')` + `closest('[data-dl-unsat]')`），
>    因为层级结果是按需重渲染的；命中节点排序为「原始节点优先于推理节点」，无命中时把原因写进 `button.title`
>    （不可满足类目前无实例，本体仍可能因 TBox 公理矛盾而不可满足）。
> ③ **`reasonSkipText` 最终 18 码**（`SKIP_REASON_TEXT` 的 15 个 + `disabled`/`unknown-profile`/`exception`），不是 10+8。

### 6.2 kgAsk 升级（CQ 召回）

`kgAsk` 七阶段管线（上游 §12.3.2）的 stage 3「BFS 事实扩展」在命中 DL 体系且本体为 Horn 时，
**优先用 CQ** 替代/补充 BFS：

- 把用户问题的实体识别结果（stage 1）转为 CQ `where` 原子（`{class}` / `{objectProperty}`）；
- `answerCQ` 返回答案行 → 转事实三元组（复用 `impactToFacts` 同口径）；
- CQ 失败（非 Horn / 超时）→ 回退 BFS，行为不变。
- `kg:facts` 载荷**保持 4 键**（`matched, facts, refs, impact`，`:538` 硬契约），CQ 答案并入 `facts`。

### 6.3 导入预览弹窗

`showOwlPreviewModal`（`:~1645`）的 `profileCheck` 区增 DL 裁决行：
「✅ 可由 dl-js-reasoner 做完整 OWL 2 DL 本地推理（保留 N 类 DL 公理）」，
替代原「无法本地推理」告警（§4.3 改动点 4）。

---

## §7 不在本设计范围内

- DL 推理的 worker 线程化 / 真·可取消（Q-DL-1）。
- 直接透传 protege-js `OWLOntology` 给 DL（规避合成开销，Q-DL-2）。
- SWRL 规则的 UI 编辑与提取时应用（上游 §8 四期；本设计 §10 说明其可基于 dl.js 落地，但不在本期）。
- owl:imports 的 DL 侧自动遍历（由 ontologyBundle.js 在导入期解决）。
- 数值约束 / 五元组（上游非目标，DL 路径同样不做）。
- DL 推理结果的可视化 tableau 树（dl-js-reasoner 的 `monitor/Debugger` 未移植）。

---

## §8 实施分期

| 期 | 内容 | 依赖 | 工作量 | 产出 |
|---|---|---|---|---|
| **P1** | `reason/dl.js` 骨架：可用性探测 + `buildDLOntology`（仅 TBox，profile 既有字段）+ `reasonTBox` + 规模门控 | 无 | 2 天 | 非 RL 本体可跑一致性/不可满足类/分类 |
| **P2** | `profile.js` DL 裁决 + `explainProfile` 重写；`infer.js` DL 分支（TBox）；`graph.js` 装载 + `SKIP_REASON_TEXT` | P1 | 1.5 天 | DL 接入 runInference 主链路，静默降级 |
| **P3** | `owlImport.js` 保留 12 类 DL 公理 + 匿名类表达式（`profile.dlAxioms`）；`buildPreview` DL 提示 | P2 | 2 天 | 导入不再丢弃 DL 表达力（DG2） |
| **P4** | ABox 级推理（门控 + 显式触发）：`reasonABox` + 结果映射为推理边；前端第 6 区块 | P3 | 2 天 | DG1/DG3 完整 |
| **P5** | CQ：`answerCQ` + `graph:dlQuery` 三重绑定 + kgAsk CQ 召回 + 蕴含探针 UI | P4 | 2 天 | DG4 |
| **P6** | 测试：新增 `test/graph-dl.test.js`；更新 §9 表 T1 列出的既有契约测试；端到端验证 | P1–P5 | 1.5 天 | DG6 |
| **P7** | **DL 设置页**（§12）：`dlEnabled`/`dlDeep` 双开关 + 5 项规模/产出上限可配；配置快照回显；`dl.js` 的 `maxDlAxioms` 截断 bug 修复 | P1–P6 | 1 天 | 用户可关闭 DL、可调门控，不必再牺牲 RL 总开关 |

合计 **~12 天**。P1–P2 即可交付「非 RL 本体本地可推理」的核心价值（DG1 的 TBox 部分），建议作为最小可发布单元。

> ★**实施状态：P1–P7 全部完成**。落地实测记录见 §9.2.1（P2/P3 破坏点）、§9.2.2（P5 IPC 三重绑定 + 全量回归基线）、
> §9.2.3（P4 渲染层 + P6 测试 + 6 个真实缺陷）、§11.1（Q-DL-1…6 决议）、**§12（P7 设置页）**。
> 测试 tally：`test/graph-dl.test.js` **418/418**（P6 的 317 条 + §12.9 的 101 条），
> 回归 7 文件 **1172/1172**（448+291+35+67+185+56+90），合计 **1590 条断言绿**。
> 未在本期修的红测试（`graph-ontology` / `charge-pile-ontology` / `mineru-route` / `skill-parse` / `prompts-llm` / 3 个超时）
> 已逐条归因为 **HEAD 既有缺陷或环境问题**，见 §9.2.2。
> ★P7 完成后已用 `git stash` 逐条复核：`graph-ontology`（100/102）、`charge-pile-ontology`（崩溃于 `:53`）、
> `prompts-llm`（111/113）在**还原全部 P7 改动后仍以完全相同的方式失败**，确证与本设计无关。

---

## §9 风险与缓解

### 9.1 工程风险

| 编号 | 风险 | 缓解 |
|---|---|---|
| **R1** | DL tableau 最坏指数级，大 ABox + 传递属性可达秒～十秒级（实测 100×200 → 8s/10.7s），阻塞主进程 | ① 规模门控（§4.1.1）默认只做 TBox 级；② `individualTaskTimeout` = reasonTimeout（实测能抛 `InterruptedException`，但粒度粗，wall 7.6s）；③ ABox 级须 UI 显式触发；④ 真·可取消需 worker（Q-DL-1，本期不做，如实告知用户「深度推理期间界面可能短暂无响应」） |
| **R2** | `interrupt()` 无法从定时器打断同步推理（JS 单线程，实测 setTimeout 回调在推理结束前不执行） | 同 R1：本期靠 `individualTaskTimeout` 内联检查点；不承诺「随时可取消」 |
| **R3** | 属性层级循环 → `ObjectPropertyInclusionManager.checkForRegularity` 抛 `IllegalArgumentException`（实测触发） | `dl.js` 在 `reasonerFor` 外 try/catch，降级为 `skipReason:'dl-irregular'`，不崩溃（I5） |
| **R4** | 非 Horn 本体 `query()` 抛 `disjunctive heads`（实测） | `getDLOntology().isHorn` 预检；非 Horn 时 CQ 入口禁用，一致性/分类仍可用 |
| **R5** | protege-js `FunctionalSyntaxParser` 不展开空前缀 `Prefix(:=<...>)`，`:A` 原样保留（实测） | D3 从 profile 合成（profile 的 key 是 `localName` 提取的干净本地名），规避该陷阱；透传 ontology 方案（Q-DL-2）须先做 IRI 归一化 |
| **R6** | asar 打包后 `require('dl-js-reasoner')` 路径解析 | dl-js-reasoner 是纯 JS 无原生模块，`build.files` 已含 `node_modules/**/*`；与 protege-js 同待遇，无需 `asarUnpack`。⚠️ 实施期验证打包后可加载 |
| **R7** | 不一致本体上 `getUnsatisfiableClasses` 返回**全部**类（含 owl:Thing，实测） | `dl.js` 先 `isConsistent()`，不一致时**不调** `getUnsatisfiableClasses`，改报「本体不一致」；一致时才取不可满足类（实测此时只返回真正不可满足的 U） |
| **R8** | DL 返回 IRI 含 owl:Thing/owl:Nothing，误写为 Synapse 节点 | `dl.js` 过滤内置 IRI（§3.2 ⚠️） |
| **R9** | **许可兼容性**：dl-js-reasoner 是 **LGPL-3.0-or-later**；Synapse `LICENSE` 是 **GPL-3.0**，但 `package.json` 声明 `"license":"MIT"`（三者不一致） | LGPL-3 §0 允许按 GPL-3 再许可，**GPL-3 + LGPL-3.0-or-later 兼容**；真正不一致的是 package.json 的 MIT 声明。建议：① 把 `package.json` license 修正为 `GPL-3.0-or-later`（与 LICENSE 文件一致）；② 在 NOTICE/关于页注明 dl-js-reasoner 的 LGPL-3.0-or-later 及其源码获取方式。⚠️ 发布前须法务确认。<br>★**①②已落地**（§9.2.3-G）：license 已改、新增 `NOTICE.md`（含 LGPL-3 §1「用户可替换库」的满足方式论证）、`build.files` 补入 `NOTICE.md`。**法务复核仍待办** |

### 9.2 硬契约影响表（I7）——**必须同步修改的测试**

下表列出本设计**必然破坏**的既有断言（均为 `graph-reason-integration.test.js`，附录 B.6 核实）。
实施时**先改测试再改实现**，或在同一提交内同步：

| 编号 | 测试位置 | 现断言 | 本设计改动 | 处理 |
|---|---|---|---|---|
| **T1-a** | `:586` | `preview.profileCheck` 完整 JSON 相等（5 键，无 dl） | `profileCheck` 增 `dl` 子对象 | 更新断言 JSON，纳入 `dl` |
| **T1-b** | `:68` | `SKIP_REASON_TEXT` 恰好 7 键 | 增 **8** 个 DL 码（§4.5）：`dl-too-large` / `dl-abox-budget` / `dl-non-horn` / `dl-timeout` / `dl-unavailable` / `dl-irregular` / `dl-error` / `dl-no-abox` | 更新为 **15 键**（实测）。⚠️ `dl-bad-spec` **刻意不入表**：它只在交互式探针路径出现，`infer.js` 只调 `reasonTBox`/`reasonABox`，永远不会走到 skipReason |
| **T1-c** | `:605/:606` | 推理通道恰好 14 个 | 增 3 个 DL 通道（§4.6） | 更新 `CHANNELS` 数组为 17 |
| **T1-d** | `:610` | `graph:reasonStatus` → 5 字段 | **不变**（DL 信息不进 reasonStatus 顶层） | 无需改 |
| **T1-e** | `:287/:612` | `getReasonState` 恰好 11 / 12 字段 | **不变**（DL 嵌进 meta.lastStats.dl / coverage） | 无需改 |
| **T1-f** | `:121` | `runInference` 恰好 12 字段 | **不变**（DL 嵌进 perProfile / lastStats） | 无需改 |
| **T1-g** | `:582/:590` | `preview` 18 字段 / `report` 18 字段 | **不变**（DL 嵌进 profileCheck 子对象） | 无需改 |
| **T1-h** | `:298` | `predicateFeatures` 每项 8 字段 | **不变** | 无需改 |
| **T1-i** | `:538` | `kg:facts` 4 字段 | **不变**（CQ 答案并入 facts） | 无需改 |

**设计纪律**：除 T1-a/b/c 三处**有意扩展**外，其余所有字段数契约**一律不动**。
DL 的新信息全部**嵌进既有自由形态子对象**（`meta.lastStats.dl`、`perProfile[].dl`、`profileCheck.dl`、`coverage.dlCapable`），
绝不新增顶层键。这是 DG6 的核心约束。

> ⚠️ 实施期须用脚本复核：`stats`（infer.js 13 键）、`coverage`、`perProfile` 条目是否被任何测试**完整 JSON 断言**。
> 附录 B.6 仅确认了上表所列；若发现 coverage/stats 被完整断言，则 DL 子键也需同步改测试。

#### 9.2.1 实施期实测新增的破坏点（P2/P3 落地后核实，附录 B.6 未覆盖）

上表只核对了 `graph-reason-integration.test.js`。P2/P3 实施后实测发现 `graph-reason.test.js`
另有 **9 处**断言被破坏（其中 1 处是 `stats` 被完整 JSON 断言，正是上表 ⚠️ 预警的情形）：

| 编号 | 测试位置 | 现断言 | 破坏原因 | 处理 |
|---|---|---|---|---|
| **T2-a** | `graph-reason.test.js:274` | `matT.stats` 去掉 `elapsedMs` 后**完整 JSON 相等**（13 键） | `materializeGraph` 的 stats 现恒带第 14 键 `dl`（DL 未跑时为 `{ran:false,…}`） | 断言改为「13 个 RL 键齐全 + `stats.dl` 存在且 `ran===false`」 |
| **T2-b** | `:662` | `PROFILE_META` 键序 `["RL","QL","EL"]` | 新增 `DL` 条目，键序变为 `["RL","DL","QL","EL"]` | 更新为 4 键 |
| **T2-c** | `:668` | `detectProfile(null).meta` 键序 `["RL","QL","EL"]` | 同 T2-b | 更新为 4 键 |
| **T2-d** | `:697` | 非 RL 本体 `recommend===null && reasonerAvailable===false` | DL 裁决通过后 `recommend==='DL'`、`reasonerAvailable===true` | 改为断言 `recommend==='DL'`、`reasonerAvailable===true`、`profiles` 仍为 `[]` |
| **T2-e** | `:701` | `explainProfile(...).canReasonLocally===false` | 同上，现为 `true`；headline 文案不变 | 改为 `canReasonLocally===true`，headline 断言保留 |
| **T2-f** | `:702` | `lines` 含 `/HermiT\|Pellet\|ELK/` 与 `/受控词表/` | DL 可用分支不再输出「需外部推理机」文案 | 改为断言 `/dl-js-reasoner/` 与 `/ABox 级深度推理/` |
| **T2-g** | `:824` | `owlImport` 导出 **22** 个成员 | 新增 `MAX_DL_AXIOMS`、`classExprToTree`、`pruneDlAxioms`、`dlNoteLines` → **26** | 更新为 26 |
| **T2-h** | `:872-875` | ro-core 的 `SUB_OBJECT_PROPERTY_OF` 条目 note 含 `/Synapse 体系结构不支持/` | 改为「保留」口径：note 现为 `Synapse 体系结构不直接使用，但已保留为 DL 公理…`，且新增 `preserved:true` | 断言改为 `preserved===true` + `/已保留为 DL 公理/`；`count===10` 不变 |
| **T2-i** | `:876` | `preview.notes` 含 `/跳过 10 条子属性/` | 措辞改为「保留」 | 改为 `/保留 10 条子属性/` |

**仍然通过的关键断言**（实测复核，勿误改）：`:775` ABoxDropped note `/只还原 TBox/`、`:790` OFN 的
`unsupportedAxioms===[]`、`:798` `.omn` 的 `warnings.length===1`、`:860` 空本体 `warnings.length===2 && profileCheck===null`、
`:882` ro-core `/护栏覆盖：12\/30/`、`:883` `/InverseProperties×14/`、`:884` `warnings===[]`、
`graph-reason-integration.test.js:121` runInference 12 字段、`:287/:612` getReasonState 11/12 字段、
`:582/:590` preview 18 / report 18 字段。

**新激活的 DL 路径**（实测无回归）：ro-core（14 类）与集成测试的 `TTL_PREVIEW`（2 类）导入后
`dlCapable===true`，故 `materializeGraph` 的 DL 分支会**真的跑起来**。实测结果：
`stats.dl = {ran:true, consistent:true, unsatCount:0, dlInferred:0}`，`inferredEdges` 与 `skipped` 均不变
（未传 `opts.deep` → 不做 ABox 深扫），`inconsistencies` 仍为 0。即 DL 只增加了一次 TBox 一致性判定（~17 ms），
不改变既有 RL 结论。

### 9.2.2 P5 落地：IPC 三重绑定与全量回归基线（实测）

**三重绑定已完成**（§4.6 要求的三处，缺一侧 → Web 模式静默 `undefined is not a function`）：

| 位置 | 新增内容 |
|---|---|
| `src/main/ipc.js`（`graph:predicateFeatures` 之后） | `graph:dlQuery` / `graph:dlEntail` / `graph:dlHierarchy` 三个 `ipcMain.handle`，全部 try/catch 兜底为 `{ok:false, reason:'dl-error', …}` |
| `preload.js`（`graphPredicateFeatures` 之后） | `graphDlQuery` / `graphDlEntail` / `graphDlHierarchy` |
| `web/kb-shim.js`（`graphPredicateFeatures` 之后） | 同上三个，走 `call(ch, {profileId, …})` 单 body 形态 |

**入参双形态兼容**：桌面端 `invoke(ch, profileId, payload)`；web shim 只转发单 body
`{profileId, spec|axiom}`。三个 handler 均以 `typeof arg === 'object'` 判别，与 `graph:validate` /
`graph:impactClosure` 同口径。集成测试对两种形态各加了一条断言。

**⚠️ 刻意不加第 4 个通道**：曾添加 `graph:dlStatus`，随后**删除**——T1-c 的通道数契约是 14 → **17**，
且 DG6 要求「绝不新增顶层键」。DL 就绪状态已有出口：`getReasonState().coverage.dlCapable`
（`graph.js:getReasonState` 内注入，`getReasonState` 返回值仍为 11 键）。

**T1-c 已更新**：`graph-reason-integration.test.js:604-606` 的 `CHANNELS` 由 14 → 17，
并新增 6 条 DL 通道断言（三通道注册、双形态兼容、非 DL 体系静默降级、省略 profileId 不抛）。

**⚠️ `unknown-profile` 不可达**：`resolveOntology(id)` 对未知 id **静默回退 `bfo-lite`**（不抛），
故未知体系走的是「非 `dlCapable`」分支 → `dl-unavailable`，而非 `unknown-profile`。
`_dlContext` 的 `unknown-profile` 分支仅在 `resolveOntology` 自身抛错时可达（当前实现不会）。

**全量回归基线**（31 个测试文件，逐文件 120 s 超时；`_suite.txt`）：

| 文件 | 状态 | 归因 |
|---|---|---|
| `graph-reason.test.js` | ✅ 0 失败 | T2-a…T2-i 全部更新到位 |
| `graph-reason-integration.test.js` | ✅ 0 失败 | T1-a/b/c 全部更新到位 |
| `ontology-bundle.test.js` / `owl-import.test.js` | ✅ 0 失败 | P3 无回归 |
| `graph-repair` / `graph-validate` / `graph-hierarchy` / `graph-density` / `templates-domains` / `corpus-pipeline` | ✅ 0 失败 | — |
| `graph-ontology.test.js` | ✅ 102/102（**已修**） | 原为 HEAD 既有缺陷，见下 |
| `charge-pile-ontology.test.js` | ✅ 通过（**已加固**） | 原为数据依赖崩溃，见下 |
| `mineru-route` / `skill-parse` | ⏭ 环境跳过 | `MinerU 转换失败：spawn EFTYPE`（Windows 无法 spawn 假 MinerU 可执行文件）；`run-all.js` 已归入 `ENV_DEPENDENT` |
| `prompts-llm.test.js` | ✅ 113/113（**已修**） | 原为 HEAD 既有缺陷：thinking 开关走 `/v1/chat/completions` 而非 ollama 原生 `/api/chat`，见下 |
| `corpus-store` / `mcp-client` / `skill-install` | ⏱ 超时 | **环境**：分别依赖子进程 `execFileSync`、`spawn` + 本地 HTTP、`jszip` + fetch 打桩；均不 require 任何 `graph/reason/*` 模块，与本设计无关 |
| `jobs-tasks` / `ollama-auto-start` | ✅（32 s / 32 s） | 慢但通过 |

**★三个既有失败的根因（与本设计无关，已在实施期一并修复）**：

> **关键发现：HEAD `daf7bfb`「fix MCP client problems」是一次范围过大的误回退，
> 它同时静默删掉了两个已上线且文档在册的功能。**

**（1）`graph-ontology.test.js` 2 失败 ← `daf7bfb` 回退了 `f49eccb`**
`f49eccb`「本体定义统计卡按体系隔离」把 `getOntology` 的 `instanceCount`/`edgeCount` 改为按节点
`profile` 归属统计（并同步改了 `src/renderer/graph.js` 的卡片副标题与测试断言）。
但 `daf7bfb` 把这两处改动一并回退了
（`git show daf7bfb -- src/main/graph/graph.js` 的 hunk `@@ -945,19 +945,7 @@` 与
`@@ -980,8 +968,8 @@` 精确删掉了 `pidOf`/`instCount`/`edgeCount`，恢复为 `g.nodes.length`/`g.edges.length`；
`src/renderer/graph.js` 的 hunk `@@ -732,13 +732,13 @@` 把副标题从 `o.profileName` 改回 `'全部体系'`），
**却没有回退测试断言** → 测试在 HEAD 上就是红的。
核实方式：`getOntology` 位于 `graph.js:973-1005`，而本次 DL 改动的 6 个 hunk 分别在
`@@ -148`、`@@ -171`、`@@ -1559`、`@@ -1642`、`@@ -1696`、`@@ -2253`，**无一覆盖该函数**。
✅ **已修**：在 `getOntology` 内重新实现按体系隔离的统计（口径同 `listGraphScopes`/`scopeFilter`：
节点归属 = `n.profile` → id 前缀 → 兜底 `bfo-lite`；**边仅在两端同属当前体系时计入**，
跨体系边不计入任何单体系，避免重复计数），并把 `src/renderer/graph.js` 的两张卡片副标题
从硬编码 `'全部体系'` 改回 `o.profileName`。
实现细节与 `f49eccb` 原版的唯一差异：`pidOf` 用 `indexOf(':')` + `i > 0` 判定，
而非原版的 `split(':')[0] || 'bfo-lite'` —— 功能等价，但避开了原版那个恒真的 `||`
（非空字符串永远为真，`'bfo-lite'` 兜底实际不可达），且正确处理无冒号的 id。

**（2）`prompts-llm.test.js` 2 失败 ← `daf7bfb` 回退了 `37d3213` 的整个「模型级思考开关」**
`37d3213` 上线了「设置 → 模型卡『开启思考（thinking）』」功能（`docs/10-设置.md:19` 至今仍在描述它），
核心是：Ollama 的 `/v1/chat/completions` **忽略** `think:false`（实测同一提示词
366 s / 8473 思考字符 vs 原生 71 s / 0 字符），因此「显式关思考 + Ollama」必须直连原生
`/api/chat`（NDJSON，非 SSE）才真正生效。
`daf7bfb` 把这套逻辑从 5 个文件里删了个干净，**却没有回退测试断言、也没有回退文档**：

| 文件 | 被删内容 | 恢复方式 |
|---|---|---|
| `src/main/ai/llm.js` | `streamChat` 的原生 `/api/chat` 分支（41 行）；`streamChat` 与 `agenticChat` 请求体上的 `withThinking`/`withThinkingBudget` 包裹；`thinkingWanted` 的模型级注释 | 逐字恢复；**保留** `daf7bfb` 有意新增的 MCP `onProgress` 第三参 |
| `src/renderer/chat.js` | `aiSettings()` 的 `thinkingEnabled` 注入（主模型读 `settings`，非主模型读卡片自身 `thinking`） | 逐字恢复 |
| `src/renderer/common.js` | 7 处：`modelEntryList`/`fillPrimaryModelFields`/`promoteModel` 的 `thinking` 字段、新函数 `syncPrimaryThinkBadge`、`modelCard` 的「无思考」徽标、`extraModelForm` 的勾选行与即存、`saveSettingsFields` 的持久化 | 逐字恢复 |
| `src/index.html` | `#set-thinking` 勾选行 | 逐字恢复（插入点在 AI 面板模型卡，与 P7 的 DL 面板相距 ~185 行，无冲突） |
| `src/styles.css` | `.model-think-row` 两条规则 | 逐字恢复 |

`withThinking`/`withThinkingBudget`/`consumeOllamaNdjson`/`thinkingWanted` 四个函数本体
`daf7bfb` 并未删除（只是没人调用了），故只需恢复调用点。
持久化沿用项目既有约定：**默认开启的布尔量 → 勾选时删键、取消勾选时落 `false`**
（与 `reasonEnabled`/`corpusPersist`/`skillParse`/`dlEnabled` 同口径）。
`#set-thinking` 的 id 以 `set-` 开头，会被 `src/renderer/app.js:190` 那个委派 `change`
监听自动路由到 `saveSettingsFields()`，无需改 `app.js`。

**（3）`charge-pile-ontology.test.js` 崩溃 ← 唯一读真实 `data/` 目录的套件**
本机 `data/` 仅 25 节点 / 1 个 scope，`scopes[1]` 为 `undefined` → `TypeError` 直接崩掉整个套件。
✅ **已加固**：引入 `dataCheck(name, fn)` / `skip(name, why)`，把 4 个节点形状断言、
`scopes[0]`/`scopes[1]` 跨组隔离断言、3 个 `recall` 断言改为「有数据才断言，否则输出
`○ 跳过（原因）`」；纯代码断言（`scopeFilter all null`、全部 `resolveOntology`/`listProfiles`）
**上移到数据依赖块之前并始终求值**。汇总行改为报告跳过数。
本机结果：14 通过 / 15 跳过 / 0 失败，`exit=0`。

**修复后的全量基线**：`node test/run-all.js` → **32 套件 / 30 通过 / 0 失败 / 2 环境跳过 / 0 基线损坏**
（修复前为 27 通过 / 3 失败 / 2 环境跳过）。

> **⚠️ 提交切分建议**：本文档原先建议「单独提一个修复提交恢复 `f49eccb` 的隔离逻辑，
> **不要混进 DL 融合分支**」。该建议对（1）（3）依然成立，且应扩展到（2）——
> 这三处修的都是 `daf7bfb` 造成的既有红测，与 DL 融合无因果关系。
> 推荐拆成两个提交：① `fix: 恢复 daf7bfb 误回退的体系隔离统计与模型级思考开关`（
> `graph.js` 的 `getOntology`、`renderer/graph.js` 卡片副标题、`llm.js`、`chat.js`、
> `common.js`、`index.html`、`styles.css` 的 thinking 部分、`charge-pile-ontology.test.js`）；
> ② DL 融合本体（P1–P7）。注意 `src/index.html`、`src/renderer/common.js`、`src/styles.css`
> 三个文件被两个提交共同触及，需按 hunk 分别 `git add -p`。

### 9.2.3 P4/P6 落地：渲染层、测试套件与实施期发现的 6 个真实缺陷（实测）

#### A. 第四处**有意扩展**：三个 DL 探针的失败形态增 `profileId`

T1 表只钉住了 `runInference`(12) / `getReasonState`(11) / `kg:facts`(4) 三处顶层契约，
`dlQuery` / `dlEntail` / `dlHierarchy` 的返回形态是本期新增的，无既有断言。实施期发现
`_dlContext` 的失败分支**不回传 pid**，导致前端三个探针面板拿到 `{ok:false, reason}` 时
无法判断「这次失败属于哪个体系」——多体系并存时会串台。已修：

| 函数 | 成功形态 | 失败形态 |
|---|---|---|
| `dlQuery` | 7 键 `ok,answers,columns,isHorn,elapsedMs,profileId,gate` | **8 键** `ok,reason,error,profileId,answers,columns,isHorn,elapsedMs` |
| `dlEntail` | 5 键 `ok,entailed,explain,elapsedMs,profileId` | **7 键** `ok,entailed,explain,reason,error,profileId,elapsedMs` |
| `dlHierarchy` | 9 键 `ok,profileId,consistent,hierarchy,topClasses,unsatClasses,labels,elapsedMs,stats` | **9 键** `ok,reason,error,profileId,consistent,hierarchy,topClasses,unsatClasses,elapsedMs` |

`_dlContext` 现在把 `const pid = profileId || readOntologyKv().profileId || 'bfo-lite'`
提到**所有分支之前**，失败形态一律带 `pid`。这是 T1-a/b/c 之外的**第四处有意扩展**，
不违反 DG6（未新增顶层键到既有契约对象上，只是给新对象补齐了必要字段）。

#### B. 渲染层（P4）最终形态

| 位置 | 内容 |
|---|---|
| `renderReasonDl(ctx)` | 读 `coverage.dlCapable` + `meta.lastStats.dl`，两者皆无 → 返回 `''`（非 DL 体系完全不渲染第 6 区块）。渲染上次结果摘要（一致性 / 不可满足类数 / DL 补边数 / 体系数·耗时 / skipReasons）+ 两个按钮 + `#kg-dl-hierarchy` / `#kg-dl-probe` 两个容器 |
| `renderDlCqResult(r)` | §6.1 残留已补：**规模门控行**。`dlQuery` 早已回传 `gate`（6 字段），此前只是没渲染 → 用户看到「无答案」却不知为何。⚠️ **刻意不显示预算分母**：`DL_LIMITS.aboxBudget` 在主进程，前端硬编码一份必然漂移；只报已用量 + 放行/超限结论 |
| `renderDlHierarchyResult(r)` | §6.1 残留已补：**不可满足类做成可点击按钮**（`data-dl-unsat`）。语义依据：不可满足类**不该有任何实例**，故「它的实例节点」正是不一致的成因，点一下跳到图谱里那个节点，用户能直接看到该改哪条边/哪个类型 |
| `bindReasonDlActions` | 用**事件委托**（`panel.addEventListener('click', …)` + `closest('[data-dl-unsat]')`）而非逐个绑定：层级结果是按需重渲染的，委托一次绑定覆盖后续每次刷新。`panel` 每次都是 `body.innerHTML` 重建的新元素，故不会累积重复监听器。命中节点排序 `原始节点优先于推理节点`；无命中时把原因写进 `btn.title`（不可满足类目前无实例，本体仍可能因 TBox 公理矛盾而不可满足） |
| `showOwlPreviewModal` | §6.3：在 RL/QL/EL 三行之后插入 DL 裁决行。⚠️ **数据源陷阱**：DL 裁决只挂在 `preview.profileCheck.dl` 上（T1-a），**顶层 `imp.profileCheck` 是 8 键、没有 `dl`**。代码两处都取一遍（`prv.profileCheck.dl \|\| pc.dl`），避免以后调用方换数据源时静默丢行。`dlp.reason` 是**码**（`dl-unavailable`/`dl-too-large`/`dl-irregular`），必须过 `reasonSkipText()` 查表出中文 |
| `reasonSkipText(code)` | 18 个码 = `SKIP_REASON_TEXT` 的 15 个 + `disabled`/`unknown-profile`/`exception`。⚠️ 必须与主进程同步，漏一个就把英文码直接展示给用户 |
| `styles.css` | `.kg-dl-*` 区块（ok/bad/probe/form/hier/table）+ 新增 `.kg-dl-link`（内联按钮重置：无边框无底色、继承颜色、虚线下划线、`:focus-visible` 用 `--primary` 描边）。用 `<button>` 而非 `<a>`：它不导航 URL，而是切 tab + 居中节点 |
| `constants.js` | `INFERRED_VIA_NAMES` 7 → 10，补 `dl-tableau` / `dl-classify` / `dl-realise` |

#### C. ★实施期发现并修复的 6 个真实缺陷（每个都有回归守卫）

前 4 个是在写 `test/graph-dl.test.js` 时**测试先红、追根后发现是代码错**——原计划只有 2 个候选代码问题，
实测变成 4 个。判据：代码行为确实错了或埋了雷，且**没有任何既有测试依赖旧行为**。

| # | 位置 | 症状 | 根因 | 修复 | 回归守卫 |
|---|---|---|---|---|---|
| **1** | `dl.js:cqWhereToIri` | CQ **静默返回 0 行**（不报错，最难查的一类 bug） | `QuerySpec.toTerm` 把「不以 `?` 开头的字符串」一律当 Individual IRI **原样**用。Synapse 节点 id（`owl:foo:d1`）没先编码成 `https://synapse.local/id/…`，于是查了个图里不存在的个体 | 每个 term 位无条件过 `termToIri`；**但 `null`/`undefined` 必须原样传下去**（`termToIri` 会把 undefined 变成空串 → `createIndividual('')`，把「缺参数」伪装成「0 行答案」） | `已编码 IRI 原样透传，结果一致` / `{individual:...} 包装透传，结果一致` |
| **2** | `dl.js:exprFromTree` | `TypeError: Cannot read properties of null (reading 'owlClass')` | 它是**导出成员**且被 `owlImport.js` 的序列化器复用，调用方可能在任何触发惰性装载的 API 之前就用它 → 模块级 `E` 仍为 `null` | 函数首行加 `if (!dlAvailable()) return null;`（`dataRangeFromTree` 同修，虽未导出） | ★**必须在全新子进程里验**（本进程早已装载过 DL，`E` 不再是 null）：`execFileSync(process.execPath, ['-e', script])` 断言 `['OWLClass','ObjectUnionOf','ObjectMinCardinality']` |
| **3** | `dl.js:reasonABox` | 请求 `maxInferredEdges:1` 却拿到 **2** 条边 | 上限检查只在外层两处（换个体 / 换谓词）。单个 `(个体, 谓词)` 对可能一次返回多个值（如传递闭包），内层循环把上限顶穿 | 上限检查下沉到**最内层** `for (const vIri of …)` | `maxInferredEdges=1 时严格只出 1 条边（上限检查在最内层）` |
| **4** | `dl.js:reasonABox` | 请求 `maxInferredEdges:0` 却拿到 **5000** 条 | `Number(x) > 0 ? x : 默认` 把 `0` 当 falsy 吞掉。而这个上限是**保护 kv 存储的硬约束**，调用方必须能真正压到 0 | `(Number.isFinite(capReq) && capReq >= 0) ? Math.round(capReq) : DL_LIMITS.maxInferredEdges`。⚠️ `infer.js` 传 `undefined` → `NaN` → 非有限 → 回落默认值，**无回归** | `maxInferredEdges=0 时不出边` + 负数/NaN 回落 + `runInference({maxDlEdges:0})` 端到端 2 条 |
| **5** | `dl.js:dlAvailableFor` | `dlAvailableFor(null)` → **`true`** | `else` 分支写的是 `classCount = 0`，一路走到 `return true`，把「压根没东西可推」误报成「DL 可用」；调用方（`profile.js`/`owlImport.js`/`ontologyBundle.js`）拿到 true 就去 `buildDLOntology`，纯属埋雷 | 既不是 profile 也不是 `OWLOntology` → **`return false`**。★3 个真实调用方都传真对象，安全 | `dlAvailableFor(null) = false（无本体可判）` + `显式 classCount 可绕过本体推断` |
| **6** | `dl.js:classifyError` | 调用方 spec 写错被归为 `dl-error`（「DL 推理出错」） | `QuerySpec.toTerm` 对 null term **显式抛错** `'A query term cannot be null or undefined.'`，这是**调用方的 spec 写错了**，不是推理引擎出问题 | 加 `/cannot be null or undefined/i → 'dl-bad-spec'`。⚠️ 该码**刻意不进 `SKIP_REASON_TEXT`**：它只在交互式探针路径（`answerCQ`/`answerCQs`/`entail`）出现，`infer.js` 只调 `reasonTBox`/`reasonABox` | `answerCQs 空数组 → ok=false + dl-bad-spec（六字段失败形态）` |

第 7 项是 UX 缺陷而非 bug，见本节 A（`_dlContext` 缺 `profileId`）。

#### D. ★实施期学到的 dl-js-reasoner 语义（附录 A/B 未覆盖，务必记住）

| 事实 | 影响 |
|---|---|
| **`E.declaration` 不存在** | 声明公理只能手搓普通对象：`{axiomType: AT.DECLARATION, entity: C_(k)}` |
| **公理用 `.axiomType` 判别，类表达式用 `.type` 判别** | 一个库里两套约定。`E.*` 公理工厂产物的 `.type` **恒为 `undefined`**；类表达式的 `.axiomType` 恒为 `undefined`，`.type` 是裸串（`'OWLClass'`/`'ObjectUnionOf'`/…） |
| **`E.AxiomType` 只含公理类型**（38 个） | `.OBJECT_UNION_OF` / `.OWL_CLASS` 是 `undefined`，别拿它当类表达式判别器 |
| **`AxiomType.SUB_PROPERTY_CHAIN_OF` 的值是 `'SubObjectPropertyChainOf'`** | ⚠️ 值 ≠ 常量名。而 protege-js 侧的 `OWLSubPropertyChainOfAxiom` 又是另一个形态，`dl.js` 内部统一用 `'SubPropertyChainOf'` |
| **OWL 无唯一名假设（no UNA）** | `differentIndividuals([d1,p1])` **不被蕴含**（entailed=false）。任何暗示「不同 id 即不同个体」的 UI 文案都是错的 |
| **`ObjectPropertyRange(:part_of :Device)` 给每条 part_of 边的「宾语」打上 Device 类型** | 实测 `types[p1] === ['Device','Part']`（p1 是 part_of 的 object）。这是正确的 OWL 语义，但很反直觉，写断言时别当成 bug |
| **`answerCQ` 总是显式传 `select: []`** | 覆盖了 `QuerySpec` 的 SELECT-\* 默认 → 无 select 的查询变成 **EXISTS 检查**，返回 `{ok:true, answers:[[]], columns:[]}`（一行零项） |
| **`answerCQs([])` 与 `answerCQs(null)` 同口径** | 都是 `ok:false` + `dl-bad-spec`（「没给查询」属调用方错误）。`dlRecallFacts` 自己有 `if (!specs.length) continue` 守卫，走不到这里 |
| **`importOwl` 丢弃 ABox** | 单个 `.ofn` fixture **永远不可能不一致**。要造 R7 路径必须：导入 `UNSAT_OFN`（`DisjointClasses(:Device :Software)` + `EquivalentClasses(:U ObjectIntersectionOf(:Device :Software))`）→ `reasonTBox` 得 `consistent:true` + `unsatClasses:['U']`；再往图里塞一个 `type:'U'` 的节点 → `buildDLOntology(…, {abox:true})` → `reasonTBox` 才得 `consistent:false` |
| **答案单元格是 `{kind,value}` 形态**（`normTerm` 产物），不是裸字符串 | 比较时先取 `.value`：`J(answers.map(r=>r[0].value)) === J([id])`，写成 `J([[id]])` 必红 |
| **`propertyHierarchyRegular` 有两个输入槽，形态不同** | 第 1 参 `model.axioms` 只认 bridge/RL 形态 `{type:'SubPropertyOf', subject, object}`；第 2 参 `dlAxioms` 认 DL 形态 `{type:'SubObjectPropertyOf', subProperty, superProperty}` 与 `{type:'SubPropertyChainOf', propertyChain[], superProperty}`。**把 DL 形态塞进 `model.axioms` 会被静默忽略 → 环检不出来**。这一条单独造成了 17 个失败里的 3 个 |
| **`a ⊑ a` 是重言式，不构成严格边** | `addEdge` 刻意跳过 `sub === sup`，故自环 → `propertyHierarchyRegular` 返回 **`true`**（正则） |
| **个体 IRI 是 `iriId(节点 id)`，而节点 id 带体系前缀** | 必须 `bridge.iriId(nid('p1'))` = `iriId('owl:dltest:p1')`；写成 `iriId('p1')` 会查一个图里不存在的个体 → 静默 0 行（与缺陷 #1 同一类陷阱） |

#### E. protege-js Functional-syntax 解析器的 4 个坑（写 fixture 必看）

| 想写的 | 实际必须写 | 原因 |
|---|---|---|
| `SubObjectPropertyChainOf(:p1 :p2 :super)` | `SubObjectPropertyOf(ObjectPropertyChain(:p1 :p2) :super)` | 前者解析失败（`FunctionalSyntaxParser.js:341-380`） |
| `HasKey(:A (:hasPart))` | `HasKey(:A :hasPart)` | 扁平 varargs，不接受括号列表 |
| `ObjectMinCardinality(2 :hasPart :B)` 当独立公理 | `SubClassOf(:A ObjectMinCardinality(2 :hasPart :B))` | 基数限制不是独立公理，必须包一层 |
| 直接写 `SameIndividual(:a :b)` | 先 `Declaration(NamedIndividual(:a))` | 个体必须声明 |

另：`require('@skaterqiang/protege-js').parseOntology` **不是函数**，用
`owlImport.parseWithProtege(text,'Functional',{})`。解析失败会冒泡成
`无法解析 X.ofn：protege-js 全部解析器均失败（Functional → Turtle → RDFXML → Manchester → OWLXML）…`（`owlImport.js:1114`）。

#### F. ★测试最终 tally（P6 完成）

`test/graph-dl.test.js`：**317/317 通过，EXIT=0**，13 个 section。覆盖
§3.1/§3.2/§3.3/§4.1/§5/§6.1/§6.2/§7/§9.2/§10 的 R1/R3/R4/R7/R8/R9。

回归批次（7 文件，全绿）：

| 文件 | 结果 |
|---|---|
| `graph-reason.test.js` | 448/448 |
| `graph-reason-integration.test.js` | 291/291 |
| `ask-chain.test.js` | 35 通过 / 0 失败 |
| `ontology-bundle.test.js` | 67/67 |
| `graph-repair.test.js` | 185/185 |
| `graph-validate.test.js` | 56/56 |
| `owl-import.test.js` | 90/90 |

合计 **1489 条断言绿**（含 graph-dl 的 317）。⚠️ 文件名是 `test/owl-import.test.js`，
**不是** `graph-owl-import.test.js`（批次脚本曾因此 MODULE_NOT_FOUND）。

#### G. ★R9 许可整改已落地

- `package.json` `"license"`：`MIT` → **`GPL-3.0-or-later`**（与根目录 `LICENSE` 文件一致）。
- 新增 **`NOTICE.md`**：列明 dl-js-reasoner 的 LGPL-3.0-or-later、npm 源码获取方式、
  LGPL-3 §0 的再许可兼容性论证、以及 **LGPL-3 §1「用户可替换库」如何被满足**
  （`require('dl-js-reasoner')` 动态装载 + `dlAvailable()` 静默降级）。
- `package.json` 的 `build.files` 补入 `NOTICE.md`，确保 electron-builder 打包时随附。
- ⚠️ 仍须法务复核（NOTICE.md 末尾已注明「不构成法律意见」）。

#### H. ★旁路发现并修复：笔记 frontmatter 解析器在 CRLF 文件上销毁元数据

在长时全量回归基线跑批期间，仓库里被 git 跟踪的欢迎笔记
`data/note/👋 欢迎使用个人知识库助手.md` 被改写（frontmatter 的 `id` 变成 `file:` URI、
`tags`/`pinned`/`createdAt` 被清空，原 frontmatter 被复制进正文）。**这与 DL 集成无关，是一条
既有的、当前仍可复现的数据损坏缺陷**，本节如实记录根因与修复。

| 项 | 内容 |
|---|---|
| **位置** | `src/main/notes/store.js` `parseNoteFile`（**未被我方改动过**，属于既有代码） |
| **症状** | 整段 frontmatter 被当成正文 → `id/title/tags/pinned/createdAt` 全解析为空；`loadNotesFromDisk` 用兜底 `id='file:'+相对路径` 与文件名标题补齐；**下一次存盘**就把真 id 覆盖、清空标签与置顶、`createdAt` 归零，并把原 frontmatter 复制进正文（实测 1184 → 1314 字节，**不可逆**——真 id 一旦被 `file:…` 顶掉就再也找不回来） |
| **根因** | 解析器把换行符**硬编码成 LF** 两次：`text.startsWith('---\n')` + `text.indexOf('\n---', 4)`。CRLF 文件第一步就失配 |
| **CRLF 来源** | ① `git core.autocrlf=true` 的 Windows 检出（仓库 `data/note` 是被跟踪的，`git checkout -- data/` 本身就产出 CRLF）；② 用户用记事本另存笔记 |
| **纠正我方的错误归因** | 最初怀疑是「某个测试逃逸沙箱写坏 data/」。逐一 bisect 全部 28 个快速测试文件（按 mtime 探测），**无一复现**；真相是**解析器本身**——长时跑批触发了对已还原（CRLF）欢迎笔记的读取+存盘。**教训：判断测试是否弄脏被跟踪的 `data/`，用 `git status` 而非 mtime**（幂等重写只改 mtime 不改内容） |
| **修复** | 两条硬编码 LF 扫描合并为一条换行无感正则 `FM_BLOCK_RE = /^---[ \t]*(?:\r\n|\n|\r)([\s\S]*?)(?:\r\n|\n|\r)---[ \t]*(?=\r\n|\n|\r|$)/`；frontmatter 行按 `/\r\n|\n|\r/` 切分（**仅 `.split('\n')` + `.trim()` 不够**——JS 的 `.` 不匹配 `\r`，`(.*)$` 在 CRLF 行上仍整体失配）；正文前导空行按 `/^(?:\r\n|\n|\r){1,2}/` 剥，保持幂等。结束分隔符用**前瞻**，使正文切点与旧 `slice(end + 4)` 完全一致 |
| **覆盖的变体** | LF / CRLF / CR-only / frontmatter-CRLF+正文-LF 混合 / `---` 带尾随空格 / frontmatter 后单换行；正文里的 markdown `---` 分隔线不误判（惰性匹配取第一个行首 `---`）；无 frontmatter 文件仍走 `file:` 兜底键、正文原样 |
| **回归守卫** | `test/notes-store.test.js` 新增 §15「frontmatter 换行风格容错」（6 种换行变体 × 3 断言 + 3 轮存/读幂等 + 正文分隔线 + 无 frontmatter 兜底，约 24 条断言）；套件 **84 → 108/108 通过** |

★已验证：同一份真实 CRLF 欢迎笔记，修复前 `id/title/tags/pinned/createdAt` 全空、正文混入
frontmatter；修复后全部还原（`id=mtrap7vfs7s7gc`、`tags=["指南"]`、`pinned=true`、
`createdAt=1788788857371`、正文干净）。仓库 `data/` 已用 `git checkout -- data/` 还原，
git 状态干净。

**给维护者的提示**：本仓库任何读取被 git 跟踪的 `.md`（带 frontmatter）的代码，都不能假设
LF——`core.autocrlf=true` 与记事本都会产出 CRLF。统一用 `(?:\r\n|\n|\r)` 切行。

---

## §10 与既有设计文档的关系

| 上游设计条目 | 本设计的影响 |
|---|---|
| §1 G6（OWL 重导入 diff，五期未启动） | **不直接闭合**，但 DL 分类结果可作为 diff 的语义比对基础（未来） |
| §1 G7 / §8 四期（SWRL，3 天，未启动） | **铺路**：dl-js-reasoner 已实现 SWRL 规则归一化（`RuleNormalizer`）与 clausification，规则可作为前提参与推理。四期可基于 `dl.js` 落地，但须如实标注：**SWRL built-ins（`swrlb:`）不支持**（`RuleNormalizer` 抛错）、**`isEntailed(swrlRule)` 不支持**（规则只能当前提，不能当被蕴含目标）。**开放问题 Q5（SWRL 作用范围）仍开放** |
| §2 D1（protege-js 依赖形式） | 本设计 D1 同构：dl-js-reasoner 走 npm `^0.3.0`，**回答了上游 §11 Q1 的同类问题**（不走 `file:` 本地路径） |
| §4.6 profile（子语言判定） | **扩展**：增 DL 裁决，`reasonerAvailable` 不再等价于 `rl.ok` |
| §9 风险 2（推理耗时） | **加剧**：DL 比 RL 慢得多，门控/超时/worker 是新增缓解（R1/R2） |
| §11 Q1（依赖形式） | **闭合**：npm 依赖 |
| §11 Q5（SWRL 范围） | **仍开放** |
| 上游 §12.4 不变量 I1–I7 | **全部遵守**；I7 的契约变更集中在 §9 表 T1 |
| 上游 §12.5 测试硬契约表 | **新增 4 行**（`profileCheck.dl` / `SKIP_REASON_TEXT` **15** 键 / 通道 17 个 / 三个 DL 探针失败形态带 `profileId`，见 §9.2.3-A），其余不变 |
| 上游 §12.5「设置项」清单 | **P7 扩充**：新增 7 个 `dl*` 设置键（本文 §12.1）。★仍**不新增 IPC 通道**（复用 `settings:get`/`settings:save`，通道数恒为 17） |

> ⚠️ 本文自 v1.1 起**自带 §12**（DL 设置页）。上表中凡写「上游 §12.x」者均指
> [`Synapse×protege-js融合设计.md`](./Synapse×protege-js融合设计.md) 的章节，与本文 §12 无关。

**许可层面**：本设计首次引入 LGPL-3.0-or-later 组件，触发 R9 的 license 一致性整改（Synapse package.json 的 MIT 声明与 GPL-3 LICENSE 文件本就不一致，应一并修正）。
★**已落地**（见 §9.2.3-G）：`package.json` license 改为 `GPL-3.0-or-later`、新增 `NOTICE.md`、`build.files` 补入 `NOTICE.md`。

---

## §11 开放问题

| 编号 | 问题 | 倾向 |
|---|---|---|
| **Q-DL-1** | ABox 级 DL 推理是否 worker 线程化以实现真·可取消？ | 倾向**后续期**：worker 化是独立工程（Synapse 现无任何 `worker_threads` 使用，全是 `child_process`），不应阻塞 P1–P6。本期用门控 + `individualTaskTimeout` + UI 提示 |
| **Q-DL-2** | 是否直接透传 protege-js `OWLOntology` 给 DL（规避 profile 合成开销）？ | 倾向**否（本期）**：D3 的合成方案规避了空前缀 IRI 陷阱（R5）且遵守 I6；透传需先做 IRI 归一化，收益（省一次合成）不抵风险 |
| **Q-DL-3** | DL 分类产生的类层级边是否落库（可能与 profile 既有 parent 冗余）？ | 倾向**仅落「新增」层级关系**（DL 推出但 profile 没有的），避免与导入的 parent 重复 |
| **Q-DL-4** | CQ 的 spec 由谁生成——LLM 把自然问题译为 CQ，还是模板化？ | 倾向**模板化优先**（实体识别 → 原子），LLM 译列为后续增强 |
| **Q-DL-5** | `getInstances(C, direct)` 的 direct 语义（附录 B.3 观察到与 OWL API「最具体类型」语义不符） | **实施期必测**；确认前 ABox 实例查询一律 `direct=false` + 自行过滤 |
| **Q-DL-6** | DL 与 RL 对同一体系都产出推理边时，冲突/重复如何仲裁？ | 倾向**RL 优先**（多项式、已验证），DL 边仅在 edgeKey 不重复时补充（`mergeInferredEdges` 天然去重） |

### 11.1 实施期决议（P1–P6 落地后的最终结论）

| 编号 | 决议 | 依据 |
|---|---|---|
| **Q-DL-1** | **推迟**（未 worker 化） | 本期用 `gateScale` 门控 + `individualTaskTimeout` + UI skipReason 文案。附录 B.5 已证 `setTimeout(()=>r.interrupt())` 在同步推理期间**回调根本不执行**，故不 worker 化就没有真·可取消——但门控把最坏情况压在预算内（`aboxBudget=20000`），实测 fixture 全程 <10 ms |
| **Q-DL-2** | **否**（不透传 `OWLOntology`） | 走 `buildDLOntology(profile, graph, opts)` 合成路径。合成产物是 13 键 shim（`getAxioms/axioms/model/classKeys/propertyKeys/individualKeys/originals/adjByRel/transitive/symmetric/inverseOf/abox/stats`），比透传多了 `originals`/`adjByRel` 两个**去重与溯源必需**的索引——透传反而要再算一遍 |
| **Q-DL-3** | **不落任何边**（比原倾向更严） | 原倾向「仅落新增层级关系」被否决：**类不是图节点**，落边即产生指向不存在节点的僵尸边。`dlHierarchy` 只作为数据返回（9 键），前端渲染成树。已在 `graph.js:dlHierarchy` 头注释固化 |
| **Q-DL-4** | **模板化**，落地为 `graph.dlRecallFacts(g, seeds, opts)` | 每个 seed × 每个谓词 × 2 方向 = 一条 CQ（`{select:['?o'], where:[{objectProperty:rel, subject:seed.id, object:'?o'}]}`）。护栏：`MAX_SEEDS_PER_PROFILE=5`（与影响面扩展同口径）、`MAX_SPECS=150`、答案上限 40 条。★**一个 reasoner 跑全部 spec**（`answerCQs`）——`Reasoner.getDatalogEngine()` 会缓存 `datalogEngine`，故 N 条查询远比 N 个 reasoner 便宜 |
| **Q-DL-5** | **绕过**：不用 `getInstances` | 改用 `getTypes(I)` 逐个体实现（realisation），再按 `declared = new Set(ont.classKeys)` 自行过滤掉 owl:Thing/内部定义类。这样 direct 语义的歧义根本不进入代码路径 |
| **Q-DL-6** | **RL 优先，按 `bridge.edgeKey` 去重** | ★**实测验证**：DL fixture 上 RL 已产 4 条推理边（`p2→d1 part_of|transitive`、`d1→p1 has_part|inverse`、`p1→p2 has_part|inverse`、`d1→p2 has_part|unknown`），DL 单独可产 5 条，取差集后**只补 1 条**（`p2→d1 located_in|dl-tableau`）→ `dlStats.dlInferred === 1`。即 DL 的真实增量是属性链推出的 `located_in`，RL 无法产出 |

★**R8 白名单的实现方式**（Q-DL-5 的配套）：`isSynIri(iri)` 只认 `bridge.PREFIX_ID` / `PREFIX_TYPE` / `PREFIX_REL`
三个前缀，`owl:Thing` / `owl:Nothing` / `internal:def#…` 一律落选。`pickKeys(iris, prefix, keyOf)` 是它的数组版。
`getSuperClasses` / `getSubClasses` / `getTypes` **都会返回 owl:Thing / owl:Nothing**，不过滤就会污染 UI。

---

## §12 DL 设置页（P7 补遗：把硬编码上限变成用户可配）

### 12.0 为什么需要这一节

P1–P6 落地后，DL 的**全部**用户可见控制只有两处：

1. 「知识图谱 → 推理」Tab 的 `#kg-diagnostic-dl` 面板里的三个按钮（深度推理 / 类层级 / 探针）；
2. `reason/dl.js:DL_LIMITS` 里 5 个**硬编码**常量。

也就是说：用户既无法关闭 DL，也无法调整规模门控。这在两个场景下是真问题：

- **慢机器 / 大图**：默认 `aboxBudget=20000` 放行后，一次深扫可能占用数秒且无法中止（Q-DL-1 已决议不 worker 化）。用户唯一的自救手段是关掉**整个**推理总开关 `reasonEnabled`，代价是连 RL 一起失去。
- **导入大本体**：OWL 导入侧的 `dlAxioms` 收录上限与 `DL_LIMITS.maxDlAxioms` 同口径（600），用户想让更完整的公理参与 tableau 时无处可调。

本节把这两类需求收进「设置 → DL 推理」页，**不新增任何 IPC 通道**（复用既有 `settings:get` / `settings:save`）。

### 12.1 设置项清单

| settings 键 | DOM id | 类型 | 范围 | 默认 | 落点 |
|---|---|---|---|---|---|
| `dlEnabled` | `set-dl-enabled` | checkbox | — | `true`（**缺省即开**） | 总开关：`infer.js` / `_dlContext` / `dlRecallFacts` |
| `dlDeep` | `set-dl-deep` | checkbox | — | `false`（**缺省即关**） | `materializeGraph` 的 `opts.deep` 缺省值 |
| `dlMaxClasses` | `set-dl-maxclasses` | number | 10 – 20000 | 2000 | `DL_LIMITS.maxClasses` |
| `dlAboxBudget` | `set-dl-aboxbudget` | number | 0 – 100000000 | 20000 | `DL_LIMITS.aboxBudget` |
| `dlTransitiveCap` | `set-dl-transcap` | number | 0 – 100000 | 80 | `DL_LIMITS.transitiveIndividualCap` |
| `dlMaxAxioms` | `set-dl-maxaxioms` | number | 0 – 100000 | 600 | `DL_LIMITS.maxDlAxioms` |
| `dlMaxEdges` | `set-dl-maxedges` | number | 0 – 1000000 | 5000 | `reasonABox` 的 `maxInferredEdges` |

`set-dl-status`（`<p class="modal-tip">`）是只读状态行，由 `common.js:fillDlStatusTip()` 填充。

### 12.2 三条设计约束（都是被硬契约逼出来的）

**约束 1：`dlLimitsFromSettings()` 对未设置的键必须「不产出该键」，而不是产出默认值。**

```js
function dlLimitsFromSettings(settings) {
  const out = {};
  for (const [sk, lk, , min, max] of MAP) {
    const raw = s[sk];
    if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) continue;
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;          // 非法值丢弃，而不是钳成 min
    out[lk] = Math.min(max, Math.max(min, Math.round(v)));
  }
  return out;   // ← 未设置的键**不出现**
}
```

理由：所有下游都是 `{ ...DL_LIMITS, ...limits }` 的合并形态（`gateScale` / `buildDLOntology` / `_dlContext`）。
如果这里把默认值也写进去，`DL_LIMITS` 就变成**死代码**——将来调整默认值时，凡是存过 settings 的用户都拿不到新默认。
留空 → 键缺失 → 合并时回落 `DL_LIMITS`，默认值才始终「活」着。

**约束 2：`dlEnabled` 的口径与 `reasonEnabled` 逐字一致，且 `undefined` 必须视为「开启」。**

```js
function dlEnabled(settings) {
  if (!reasonDlReady()) return false;                       // 模块缺失 → 连带为 false
  const v = settings && settings.dlEnabled;
  return v === undefined || v === null || v === '' ? true : !!v;
}
```

`infer.js` 里对应的是 `const dlSwitchOff = opts.dlEnabled === false;`——**只有显式 `false` 才关闭**。
这不是洁癖：`test/graph-reason.test.js` 有 27 处直接调用 `materializeGraph` 且不传该项，
若把 `undefined` 当关闭，这 27 处的 DL 断言会全部翻面。

**约束 3：`runInference` 里用 `dlOff` 而不是 `dlOn` 来构造 opts。**

```js
const dlOff = !!(s && s.dlEnabled === false);
// …
materializeGraph(g, prof, {
  dlEnabled: dlOff ? false : undefined,   // ← 不是 dlEnabled: dlOn
  deep: dlDeep, maxDlEdges: dlMaxEdges, limits: dlLimits,
});
```

差别在**推理模块缺失**时：若写 `dlEnabled: dlOn`，`dlOn` 因 `reasonDlReady()===false` 而为 `false`，
`infer.js` 就会报 `skipReason='dl-disabled'`，把「模块没装」误报成「用户关掉了」。
写成 `dlOff ? false : undefined` 后，模块缺失时该项保持 `undefined`，
`infer.js` 继续走原有的 `'dl-unavailable'` 分支——**既有原因码语义零变化**。

### 12.3 配置如何流到推理层（4 个透传点）

| 调用点 | 文件 | 说明 |
|---|---|---|
| `runInference` | `graph.js` | 「立即推理」按钮 / 作业队列。`opts.deep`、`opts.maxDlEdges`、`opts.limits` 显式传入时**优先**于 settings（按钮单次覆盖） |
| `extractGraph` | `graph.js` | 抽取后的自动推理，无 opts 覆盖，纯 settings 驱动 |
| `mergeGraph` 装饰器 | `corpus/decorators/mergeGraph.js` | 语料流水线的图谱合并。**必须与 `extractGraph` 同口径**，否则同一批内容走两条路径会得出不同 DL 结论 |
| `_dlContext` / `dlRecallFacts` | `graph.js` | 三个交互探针（`dlHierarchy`/`dlQuery`/`dlEntail`）与 kgAsk 的 CQ 召回。`_dlContext` 里 settings 的读取被**提到可用性检查之前**，因为开关判定不依赖模块是否装载 |

`limits` 一路透传到 `dl.buildDLOntology(prof, g, { abox, limits })`。

### 12.4 顺带修掉的一个真 bug

`dl.js` 原先在合成 `profile.dlAxioms` 时写的是：

```js
for (const d of dlAxioms.slice(0, DL_LIMITS.maxDlAxioms)) {   // ← 直接读常量
```

`gateScale` 已经按合并后的 `limits` 放行了，合成却仍按**默认** 600 截断——
「调大公理条数上限」会**静默无效**（门控说可以，合成说我只做 600 条）。现在改为：

```js
const L = { ...DL_LIMITS, ...((opts && opts.limits) || {}) };
const maxDlAxioms = (Number.isFinite(Number(L.maxDlAxioms)) && Number(L.maxDlAxioms) >= 0)
  ? Math.round(Number(L.maxDlAxioms)) : DL_LIMITS.maxDlAxioms;
for (const d of dlAxioms.slice(0, maxDlAxioms)) {
```

`>= 0` 而非 `> 0`：`maxDlAxioms=0` 是合法值（「一条复杂公理都不参与合成」），
与 §4.1 里 `reasonABox` 对 `maxInferredEdges=0` 的处理同口径（BUGFIX #4）。

### 12.5 前端如何回显（不在渲染进程复制 `DL_LIMITS`）

设置页状态行与「推理」Tab 的 DL 区块都需要显示**实际生效值**。
如果在渲染进程再抄一份 `DL_LIMITS`，就会出现两份默认值——主进程改了、界面还显示旧的。

解法是把快照挂到既有的 `coverage` 子对象下：

```js
// graph.js:dlConfigSnapshot(settings) → 7 键
{ ready, unavailableReason, enabled, deepDefault, limits, customized, timeoutSec }
```

- `limits` 是 `{...DL_LIMITS, ...dlLimitsFromSettings(s)}` 的**全量合并结果**（前端直接读，不必知道默认值）；
- `customized` 是被用户覆盖过的 `DL_LIMITS` 键名数组（前端据此打「已自定义」标签）。

挂载点：`reasonStatus().coverage.dl` 与 `getReasonState().coverage.dl`。

★**为什么嵌进 `coverage` 而不是加顶层键**：`getReasonState` 恰好 11 键、`reasonStatus` 恰好 5 键
都是 T1-e/T1 硬契约（`graph-reason-integration.test.js:75` 有整串 JSON 断言）。
而两处测试对 `coverage` **只断言具体值、不断言键集**，所以嵌进去是零风险的。
同理，`perProfile[].dl`（6 键）、`meta.lastStats`（12 键）、`summarizeDl`（7 键）、
`DL_LIMITS`（5 键）、`dl.js` 导出（16 个）、主进程 `SKIP_REASON_TEXT`（15 键）全部**未动**。

### 12.6 `dl-disabled` 是渲染进程独有的原因码

关闭 DL 后，`infer.js` 产出 `skipReason='dl-disabled'`，但主进程的 `SKIP_REASON_TEXT` **刻意不加**这一项
（15 键是 T1-b 硬契约，且 `graph-reason-integration.test.js:69` 断言了**完整键序**）。

文案只加在 `renderer/graph.js:reasonSkipText`（18 → 19 码）：

```js
'dl-disabled': 'DL 深度推理已在「设置 → DL 推理」中关闭',
```

这是安全的：`SKIP_REASON_TEXT` 的消费方全在渲染进程，主进程从不把它渲染给用户。

### 12.7 深链

「推理」Tab 的 DL 区块底部有 `#btn-dl-settings`（「修改 DL 配置」）：

```js
showSettingsView(); switchSettingsTab('dl');
```

`switchSettingsTab` 在找不到匹配 pane 时会静默回落 `'ai'`，所以 `data-pane="dl"` 必须存在——
这一点由 `test/graph-dl.test.js` §14 直接读 `src/index.html` 断言。

### 12.8 三处 min/max 必须逐字一致

| 位置 | 作用 |
|---|---|
| `src/index.html` 的 `min=`/`max=` 属性 | 浏览器原生校验 + 步进箭头边界 |
| `src/renderer/constants.js:NUM_SETTING_FIELDS` | `readNumInput(id, min, max)` 保存前钳制 |
| `src/main/graph/graph.js:dlLimitsFromSettings` 的 `MAP` | 主进程最终防线（Web 模式 / 直接改 kv 时） |

三处不一致的典型故障是「设置里能填 30000，主进程静默钳回 20000，界面显示的却是 30000」。
§14 用一张 `CLAMP` 表把三者交叉断言，任何一处漂移都会红。

### 12.9 测试覆盖（`test/graph-dl.test.js` §14，101 条断言）

- 4 个纯函数的全分支：默认值、`null`/`''`/`0`/`'false'` 的 truthy 语义、上下界钳制、小数取整、字符串数字、非法值丢弃、未知键忽略；
- 快照 7 键形状 + `limits` 键集恒等于 `DL_LIMITS` 键集 + `customized` 精确性；
- **契约不变**：`getReasonState` 11 键、`reasonStatus` 5 键、`runInference` 12 键、`perProfile[].dl` 6 键、`dlStats` 6 键、`SKIP_REASON_TEXT` 15 键；
- 端到端：`dlEnabled:false` → `skipReason='dl-disabled'` 且 RL 照常；`dlDeep:true` → 未传 `opts.deep` 也深扫；`opts.deep` 显式值优先于 settings；`dlMaxEdges:0` → 一条不落；`dlAboxBudget:0` → TBox 仍判定但深扫无产出；`opts.limits` 优先于 settings；
- 三个探针 + `dlRecallFacts` 在关闭态的降级形态（键集与 `dl-unavailable` 分支一致）；
- IPC 层如实透传 `dl-disabled`（不吞错、不改码）；
- **前端静态契约**：直接读 `src/index.html` / `src/renderer/constants.js` / `common.js` / `renderer/graph.js` / `mergeGraph.js`，断言 8 个控件 id、`data-tab`/`data-pane`、自动保存指示器、`NUM_SETTING_FIELDS` 的 min/max 与主进程逐字一致、保存口径（勾选即删键）、深链按钮、装饰器同口径。

> `constants.js` 是**无 `module.exports` 的全局脚本**（`index.html` 最先加载它），
> 测试里用 `new Function(src + '; return NUM_SETTING_FIELDS;')()` 求值，
> 并先打桩 `global.window = { kb: { defaults: {} } }`（该文件唯一的 `window.*` 引用在 `PROVIDER_PRESETS`）。

---

## 附录 A：dl-js-reasoner API 速查

**入口**：`const { reasonerFor } = require('dl-js-reasoner');` → `reasonerFor(ontology, config)` 返回 `ProtegeAdapter`。
`ontology` 只需 `getAxioms()`（返回数组/Set）；有 `getOntologyID()` 则用之。

**Configuration 关键项**（朴素对象即可，构造器 `Object.assign`）：
`throwInconsistentOntologyException:false`（默认 true，**Synapse 必须设 false**，否则不一致本体直接抛）、
`individualTaskTimeout:-1`（ms，Synapse 设为 reasonTimeout×1000）、
`bufferChanges:true`、`freshEntityPolicy:'ALLOW'`、`blockingStrategyType:'OPTIMAL'`、
`useDisjunctionLearning:true`、`tableauMonitorType:'NONE'`。

**ProtegeAdapter 方法分组**（镜像 protege-js `ReasonerQueries`）：

| 组 | 方法 |
|---|---|
| 生命周期 | `applyChange(s)`, `getPendingChanges`, `canProcessPendingChangesIncrementally`, `flush`, `dispose`, **`interrupt`**, `getBufferingMode` |
| 一致性 | `isConsistent`, `isSatisfiable`, `getUnsatisfiableClasses` |
| 类层级 | `isSubClassOf`, `getSuperClasses`, `getSubClasses`, `getEquivalentClasses`, `getDisjointClasses`, `getTopClasses` |
| 个体 | `getInstances`, `getTypes`, `hasType`, `getSameIndividuals`, `isSameIndividual`, `getDifferentIndividuals` |
| 属性值 | `getObjectPropertyValues`, `getDataPropertyValues`, `hasObjectPropertyRelationship` |
| 特性 | `isFunctional`, `isInverseFunctional`, `isSymmetric`, `isAsymmetric`, `isTransitive`, `isReflexive`, `isIrreflexive` |
| 蕴含 | `isEntailed(axiom)`, `isEntailmentCheckingSupported(type)` |
| 合取查询 | `query(spec)`, `answerQuery(spec)`（原始 `Term[][]`）, `createQuery(spec)`, `getDatalogEngine()`, `getQueryRepresentative(iri)` |
| 预计算 | `precomputeInferences`, `isPrecomputed`, `getPrecomputableInferenceTypes`, `classify()`, `classifyClasses()`, `classifyObjectProperties()`, `classifyDataProperties()`, `realise()` |
| 元信息 | `getReasonerName`, `getReasonerVersion`, `getRootOntology`, `getConfiguration`, `getPrefixes`, `getTableauStatistics`, **`getDLOntology()`**（含 `isHorn`/`hasNominals`/`allAtomicConcepts`/`allIndividuals` 等，实测 19 键） |

**CQ spec**：`{ select?:['?X',...], where:[atom...] }`；原子：`{class:iri,arg}`、`{objectProperty:iri,subject,object}`、
`{inverseObjectProperty:iri,subject,object}`、`{dataProperty:iri,subject,value}`、`{datatype:iri,arg}`、`{differentFrom:[t1,t2]}`。
项：`'?X'` 字符串 / IRI 字符串 / `{variable|individual|anonymousIndividual|literal}` 包装 / `OWLLiteral`。
**限制**：仅 Horn 本体（非 Horn 抛错）；无存在量词见证；`{sameAs}` 原子抛错；答案顺序未定义（断言前须排序）。

**E 工厂**（`require('dl-js-reasoner/src/owl/OWLExpressions.js')`）：
实体 `owlClass/objectProperty/dataProperty/namedIndividual/datatype/anonymousIndividual`；
表达式 `objectIntersectionOf/objectUnionOf/objectComplementOf/objectSomeValuesFrom/objectAllValuesFrom/objectHasValue/objectOneOf/objectHasSelf/objectMinCardinality/...`；
公理 `subclassOf/equivalentClasses/disjointClasses/disjointUnion/classAssertion/objectPropertyAssertion/negativeObjectPropertyAssertion/dataPropertyAssertion/sameIndividual/differentIndividuals/hasKey`。
**无**具名工厂的公理（属性特性/domain/range/declaration/属性链/逆属性/等价属性/不相交属性/HasKey 之外的）用朴素对象 `{axiomType:AT.X, ...}`（§3.3/§3.4 已给全形态）。

---

## 附录 B：核实依据（实测）

> 以下均为本次设计期用临时脚本（已删除）在本机 Node v22 实测，非转述。

**B.1 IRI 归一化**：`E.iriString(x)` 识别 string / `{getIRI()}` / `{iri}` / protege-js `IRI`（`_iri`）/ `toString()`（`OWLExpressions.js:143-152`）。

**B.2 protege-js 公理字段形态**（`FunctionalSyntaxParser` 解析后 `getAxioms()` 实测）：
`Declaration{entity}`、`EquivalentClasses{classExpressions[n]}`、`DisjointUnion{owlClass,classExpressions[n]}`、
`SubObjectPropertyChainOf{propertyChain[n],superProperty}`、`EquivalentObjectProperties{properties[n]}`、
`DisjointObjectProperties{properties[n]}`、`HasKey{classExpression,propertyExpressions[n]}`、
`SameIndividual{individuals[n]}`、`DifferentIndividuals{individuals[n]}`、
`NegativeObjectPropertyAssertion{subject,property,object}`、`ClassAssertion{individual,classExpression}`、
`ObjectPropertyAssertion{subject,property,object}`、`DataPropertyAssertion{subject,property,literal{lexicalValue,datatype,lang}}`、
`SubDataPropertyOf{subProperty,superProperty}`。
**端到端**：protege-js `OWLOntology` 直接喂 `reasonerFor` 成功（duck-typing），`getReasonerName()='DL-JS-REASONER 0.3.0'`。
**属性链循环**触发 `IllegalArgumentException: The given property hierarchy is not regular`（`ObjectPropertyInclusionManager.js:496`）。

**B.3 手工 shim 驱动**（`{getAxioms():[...]}`，无 protege-js）：成功。一致本体上
`isConsistent()=true`、`getUnsatisfiableClasses()=[]`、`getSubClasses(Device,true)` 含 `owl:Nothing`、
`getTypes(c1)` 含 `owl:Thing`、`getInstances(Device,true)` 返回全部 3 个体（⚠️ direct 语义存疑，Q-DL-5）、
`getObjectPropertyValues(c1,hasPart)=[b1,b2]`（传递闭包）、`isTransitive=true`、`isSymmetric=false`、
`isEntailed(hasPart(c1,b2))=true`、`isEntailed(Battery(c1))=false`、
`query({select:['?x','?y'],where:[{class:Device},{objectProperty:hasPart}]})` 返回 3 行（含链推出的 c1→b2）。
`getTableauStatistics()={iterations,nodeCreations,backjumps,clausesFired,startTime,elapsedMs}`。

**B.4 性能**（本机 Node v22，构造 / isConsistent / 查询）：
纯 TBox 50 类 10/1/9ms；200 类 5/0/39ms；500 类 11/0/143ms。
ABox（传递链+domain）20×20 2/7/12ms；50×50 2/48/84ms；50×100 2/517/825ms；**100×200 7/7933/10752ms**。
README 公布值（bfo/ogms/ro-core/iao，全 Horn）：classify 5–27ms。

**B.5 超时与中断**：`individualTaskTimeout=2000` 在 100×200 场景抛 `InterruptedException: Reasoning task exceeded the time limit.`，但 **wall=7656ms**（检查点粒度粗）；`=-1` 则 34154ms 跑完。
`setTimeout(()=>r.interrupt(),500)` 在同步推理期间**回调根本不执行**（`fired=false`，wall=9050ms）——证实 R2。

**B.6 非 Horn 与契约**：含 `DisjointUnion` 的本体 `query()` 抛 `Error: The supplied DL ontology contains rules with disjunctive heads.`；`getDLOntology()` 含 `isHorn` 字段（19 键）可预检。
既有测试契约（`graph-reason-integration.test.js`）：`SKIP_REASON_TEXT` 7 键（`:68`）、`runInference` 12 字段（`:121`）、`getReasonState` 11（`:287`）/IPC 12（`:612`）、`predicateFeatures` 8（`:298`）、`previewOwlImport` 7（`:579`）、`preview` 18（`:582`）、`report` 18（`:590`）、`preview.profileCheck` 完整 JSON（`:586`）、`kg:facts` 4（`:538`）、通道 14（`:605/:606`）。
`infer.js` 的 `stats`（13 键）与 `coverage` **未被完整 JSON 断言**（仅逐字段抽查），故 DL 子键安全。

**B.7 Synapse 现状锚点**（脚本核实）：`profile.js:188`（无法本地推理文案）、`owlImport.js:634-648`（12 类 SKIPPED）、`graph.js:135`（reason 惰性装载 9 模块）、`graph.js:172`（SKIP_REASON_TEXT 7 键）、`graph.js:1490`（runInference）、`infer.js:105`（materializeGraph）/`:232`（mergeInferredEdges）、`bridge.js:35`（edgeKey）/`:20-33`（IRI 常量）、`corpus/decorators/mergeGraph.js:110-120`（第二推理入口）、`renderer/graph.js:1065`（renderKgReasonTab）/`:1611`（reasonSkipText 10 码）。
**许可**：`Synapse/LICENSE` = GPL-3.0；`Synapse/package.json` `"license":"MIT"`（不一致）；dl-js-reasoner = LGPL-3.0-or-later。
★**已整改**（§9.2.3-G）：`package.json` → `GPL-3.0-or-later` + 新增 `NOTICE.md`。
**依赖**：`Synapse/node_modules` 当前**未安装**（设计期无法跑 Synapse 测试；实施前须 `npm install`）。
★**已安装**：349 个包，`dl-js-reasoner@0.3.0`（`require('dl-js-reasoner/package.json').license === 'LGPL-3.0-or-later'` 实测确认）。
