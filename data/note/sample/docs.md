# Synapse 运行 protege-js 案例指南

本目录下的 `case1-*/`–`case10-*/` 共 10 个案例目录对应 protege-js（`@skaterqiang/protege-js`）附带的 10 个 OWL 2 RL / SWRL 业务示例。每个案例目录包含：`案例说明.md`（业务背景 + 原始示例代码）、`manifest.json`（三步契约）、`资料/`（第①步客户上传的建图语料）、`报告.md`（三步真实运行产物）。下面说明如何在 Synapse 中把每个示例跑起来并观察推理效果。

## 三步实操（每个案例统一流程）

```
① 客户上传资料，根据顶层本体体系构建图谱   → graph.extractGraph（提取弹窗显式指定体系，五级优先级链第①级）
② 使用顶层本体体系的约束公理校验图谱       → graph.validateGraph（IPC graph:validate，通道 C 只读体检）
③ 用户输入具体问题，根据图谱推理作答       → graph.kgAsk（IPC graph:ask，AI 问答页）
```

**方式 A · 界面手动**：

1. **启动 Synapse**：桌面模式 `npm start` 或浏览器模式 `npm run web`（访问 http://localhost:8787）。
2. **第①步 建图**：侧边栏「笔记」→ `sample/caseN-*/资料/` 打开两份资料（即客户上传资料）→ 选中 →「生成图谱」→ 弹窗里**显式选择该案例绑定的顶层本体体系**（见 `manifest.json → steps.step1.ontologyProfile`，或 README 案例一览表）→ 开始提取。
3. **第②步 校验**：「本体定义」→ 点击「列表」切换到列表视图 → 点击「推理」Tab → 「全图校验」，查看违规明细、不相交冲突与护栏覆盖率；再点「重新推理」让 OWL 2 RL 规则物化。
4. **第③步 问答**：「AI 问答」页输入 `manifest.json → steps.step3.questions` 里的问题，查看带「知识图谱事实 + 原文材料」引用的回答。

**方式 B · headless 一键跑通**（批量验证推荐）：

```bash
cd d:/个人助手/Synapse/Synapse
node scripts/run-sample-cases.js case1-ecommerce-risk   # 单个案例
node scripts/run-sample-cases.js                        # 全部 10 个
```

前置：本机 Ollama 已启动且已拉取模型（默认 `qwen3.8:27b`，可用 `SYNAPSE_MODEL`/`SYNAPSE_BASE_URL`/`SYNAPSE_PROVIDER` 覆盖）。runner 在临时沙箱中执行三步并把真实结果写入各案例目录的 `报告.md`，**不会污染仓库内真实的 data/ 图谱与笔记**。

## 电商订单风控：高风险订单识别（OWL 2 RL）

用 OWL 2 RL 的 someValuesFrom 限制自动把「被黑名单买家提交的订单」归类为 HighRiskOrder，再用 disjointWith 检测「同时是可信订单」的矛盾。

**案例目录**：`case1-ecommerce-risk/`｜**顶层本体体系**：`bfo-lite`

| 三步契约 | 本案例内容 |
|---|---|
| ① 客户上传资料 → 建图 | `资料/01-风控规则说明.md`、`资料/02-订单与买家台账.md` |
| ② 体系约束/公理校验 | 通道 C 全图校验（`bfo-lite` 的类层级 + 公理 + domain/range 护栏） |
| ③ 提问 → 图谱推理作答 | 见下方 3 个问题 |

**体系选择理由**：订单/买家/审核流程是日常业务对象与过程，bfo-lite 的物体/过程/事件/信息体分类与中文谓词最贴合

**第三步提问**：
1. 订单 ord-001 是不是高风险订单？依据是什么？
2. 黑名单买家 buyer-bad-9 提交的订单会波及哪些风控环节？
3. ord-002 为什么没有被判为高风险？

**跑通方式**：见本文件开头「三步实操」（界面手动 / `node scripts/run-sample-cases.js case1-ecommerce-risk`）；真实运行产物写入 `case1-ecommerce-risk/报告.md`。

**protege-js 原生示例**（可选对照，直接跑 JS 版推理机）：

```bash
node d:/个人助手/Synapse/protege/protege-js/sample/case1-ecommerce-risk.js
```

**protege-js 原生示例输出**（对照用，非 Synapse 三步产物）：

```
================ 业务结论 ================
ord-001 被识别为高风险订单 : true
ord-001 仍是合法订单       : true
ord-002 被误判为高风险     : false (应为 false)
黑名单买家被归类为 Buyer   : true
冲突前本体一致             : true
误标可信后触发不一致告警   : true
```

## 家庭关系：SWRL 规则推理亲属关系

用 SWRL 规则（如 hasParent(?x,?p) ∧ hasBrother(?p,?u) → hasUncle(?x,?u)）在家庭成员图谱上推导新的亲属关系。

**案例目录**：`case2-family-swrl/`｜**顶层本体体系**：`bfo-lite`

| 三步契约 | 本案例内容 |
|---|---|
| ① 客户上传资料 → 建图 | `资料/01-家庭成员登记.md`、`资料/02-亲属关系规则.md` |
| ② 体系约束/公理校验 | 通道 C 全图校验（`bfo-lite` 的类层级 + 公理 + domain/range 护栏） |
| ③ 提问 → 图谱推理作答 | 见下方 3 个问题 |

**体系选择理由**：家庭成员与亲属关系是轻量知识组织场景，bfo-lite 足够

**第三步提问**：
1. alice（张小雨）的叔叔是谁？是怎么推出来的？
2. bob（张小海）是否已成年？carol（张小风）呢？
3. 这个家庭里谁与谁存在监护关系？

**跑通方式**：见本文件开头「三步实操」（界面手动 / `node scripts/run-sample-cases.js case2-family-swrl`）；真实运行产物写入 `case2-family-swrl/报告.md`。

**protege-js 原生示例**（可选对照，直接跑 JS 版推理机）：

```bash
node d:/个人助手/Synapse/protege/protege-js/sample/case2-family-swrl.js
```

**protege-js 原生示例输出**（对照用，非 Synapse 三步产物）：

```
推出 alice 的叔叔是 carol   : true
bob(40岁) 被判定为成年人    : true
carol(12岁) 被判定为成年人  : false (应为 false)
逆关系推出 bob 的孩子是 alice: true
alice 归为 BFO material entity: true
```

## 药物安全：相互作用风险检测

把药物、成分、禁忌症建模为 OWL 类与属性，用 OWL 2 RL 检测「同时服用两种存在相互作用的药物」的风险组合。

**案例目录**：`case3-pharma-safety/`｜**顶层本体体系**：`bfo`

| 三步契约 | 本案例内容 |
|---|---|
| ① 客户上传资料 → 建图 | `资料/01-药物相互作用目录.md`、`资料/02-住院患者用药记录.md` |
| ② 体系约束/公理校验 | 通道 C 全图校验（`bfo` 的类层级 + 公理 + domain/range 护栏） |
| ③ 提问 → 图谱推理作答 | 见下方 3 个问题 |

**体系选择理由**：药物/成分/患者/处方涉及严谨的持续体-发生体区分与 RO 关系，用 BFO 2020 标准体系

**第三步提问**：
1. 患者 P-1024 当前的用药方案是否存在相互作用风险？
2. 华法林与阿司匹林同时使用会带来什么后果？
3. 哪些药物之间存在禁忌配伍？

**跑通方式**：见本文件开头「三步实操」（界面手动 / `node scripts/run-sample-cases.js case3-pharma-safety`）；真实运行产物写入 `case3-pharma-safety/报告.md`。

**protege-js 原生示例**（可选对照，直接跑 JS 版推理机）：

```bash
node d:/个人助手/Synapse/protege/protege-js/sample/case3-pharma-safety.js
```

**protege-js 原生示例输出**（对照用，非 Synapse 三步产物）：

```
初始合法用药方案一致         : true
相同ssn病人记录被识别为同一人: true
叠加禁忌后触发不一致         : true
推理机报告了冲突明细         : true
抗凝药归为 OGMS medication role: true
```

## 知识出版：多格式解析与互操作

演示 protege-js 同时解析 RDF/XML、Turtle、Functional、Manchester 等格式，并把它们统一到同一 OWL 模型。

**案例目录**：`case4-knowledge-publishing/`｜**顶层本体体系**：`bfo-lite`

| 三步契约 | 本案例内容 |
|---|---|
| ① 客户上传资料 → 建图 | `资料/01-课程知识图谱本体.md`、`资料/02-发布流程规范.md` |
| ② 体系约束/公理校验 | 通道 C 全图校验（`bfo-lite` 的类层级 + 公理 + domain/range 护栏） |
| ③ 提问 → 图谱推理作答 | 见下方 3 个问题 |

**体系选择理由**：课程/章节/知识点是信息组织场景，bfo-lite 的信息体/物体分类足够

**第三步提问**：
1. 「机器学习导论」这门课的先修课程是什么？
2. 课程知识图谱发布前要经过哪些校验环节？
3. 哪些教学内容属于「数据结构」课程？

**跑通方式**：见本文件开头「三步实操」（界面手动 / `node scripts/run-sample-cases.js case4-knowledge-publishing`）；真实运行产物写入 `case4-knowledge-publishing/报告.md`。

**protege-js 原生示例**（可选对照，直接跑 JS 版推理机）：

```bash
node d:/个人助手/Synapse/protege/protege-js/sample/case4-knowledge-publishing.js
```

**protege-js 原生示例输出**（对照用，非 Synapse 三步产物）：

```
解析得到公理数         : 11
记录的前缀             : {"ex":"http://edu.example.com/kg#"}
Turtle 导出含 Course   : true
FS 导出含 SubClassOf   : true
RDF/XML 导出为合法XML  : true
round-trip 后公理数    : 11 (>0 即往返成功)
Course ⊑ IAO document   : true
```

## OBDA 画像：RL / QL / EL profile 校验

用 protege-js 的 profile 校验器检查一个本体是否符合 OWL 2 RL、QL 或 EL 的表达能力约束，帮助选择适合查询或推理的 profile。

**案例目录**：`case5-obda-profiles/`｜**顶层本体体系**：`iso15926`

| 三步契约 | 本案例内容 |
|---|---|
| ① 客户上传资料 → 建图 | `资料/01-多源系统集成方案.md`、`资料/02-设备主数据台账.md` |
| ② 体系约束/公理校验 | 通道 C 全图校验（`iso15926` 的类层级 + 公理 + domain/range 护栏） |
| ③ 提问 → 图谱推理作答 | 见下方 3 个问题 |

**体系选择理由**：炼化装置/机组/设备/部件的层级与检修活动是典型工业数据集成场景，ISO 15926 的 4D 时空观最贴合

**第三步提问**：
1. 压缩机组 C-201 的润滑油泵属于哪个系统？
2. 哪些设备同时接入了 MES 和 EAM 两个源系统？
3. 装置 A 的停机事件会影响哪些下游设备？

**跑通方式**：见本文件开头「三步实操」（界面手动 / `node scripts/run-sample-cases.js case5-obda-profiles`）；真实运行产物写入 `case5-obda-profiles/报告.md`。

**protege-js 原生示例**（可选对照，直接跑 JS 版推理机）：

```bash
node d:/个人助手/Synapse/protege/protege-js/sample/case5-obda-profiles.js
```

**protege-js 原生示例输出**（对照用，非 Synapse 三步产物）：

```
QL 集成查询召回员工数      : 3 (含子类实例, 应为3)
  合同工 carol 归为 Employee: true
  合同工 carol 归为 Person  : true
EL 传递推出 小组partOf公司  : true
QL profile 校验返回数组     : true (违规数 0)
EL profile 校验返回数组     : true (违规数 0)
员工归为 BFO material entity : true
部门归为 BFO object aggregate: true
```

## 医疗本体：临床术语分类与推理

用 OWL 2 RL 对疾病、症状、检查、治疗等临床概念做分类推理，辅助医生快速定位相关诊疗方案。

**案例目录**：`case6-medical-ontology/`｜**顶层本体体系**：`bfo`

| 三步契约 | 本案例内容 |
|---|---|
| ① 客户上传资料 → 建图 | `资料/01-临床术语本体说明.md`、`资料/02-2型糖尿病诊疗数据.md` |
| ② 体系约束/公理校验 | 通道 C 全图校验（`bfo` 的类层级 + 公理 + domain/range 护栏） |
| ③ 提问 → 图谱推理作答 | 见下方 3 个问题 |

**体系选择理由**：疾病=倾向、症状=性质、检查=过程的 BFO/OGMS 对齐要求标准 BFO 体系

**第三步提问**：
1. 2型糖尿病的典型症状有哪些？
2. 确诊 2型糖尿病 需要做哪些检查？
3. 二甲双胍适用于哪些疾病？

**跑通方式**：见本文件开头「三步实操」（界面手动 / `node scripts/run-sample-cases.js case6-medical-ontology`）；真实运行产物写入 `case6-medical-ontology/报告.md`。

**protege-js 原生示例**（可选对照，直接跑 JS 版推理机）：

```bash
node d:/个人助手/Synapse/protege/protege-js/sample/case6-medical-ontology.js
```

**protege-js 原生示例输出**（对照用，非 Synapse 三步产物）：

```
Turtle 导入公理数            : 27
RDF/XML 导出为合法XML        : true
RDF/XML 导出含 Disease 类    : true
round-trip 再导入公理数      : 57
患者被归因到 DiabetesMellitus : true
患者被归因到 EndocrineDisease : true
患者被归因到 Disease(顶层)   : true
患者被归因到 OGMS disease     : true
本体一致性                  : true
```

## 制造业 PPR：产品-工艺-资源建模

把产品（Product）、工艺（Process）、资源（Resource）建模为 OWL 类，用 OWL 2 RL 推导「某工艺需要哪些资源」「某产品经过哪些工艺」。

**案例目录**：`case7-manufacturing-ppr/`｜**顶层本体体系**：`iso15926`

| 三步契约 | 本案例内容 |
|---|---|
| ① 客户上传资料 → 建图 | `资料/01-PPR建模规范.md`、`资料/02-变速箱壳体工艺路线.md` |
| ② 体系约束/公理校验 | 通道 C 全图校验（`iso15926` 的类层级 + 公理 + domain/range 护栏） |
| ③ 提问 → 图谱推理作答 | 见下方 3 个问题 |

**体系选择理由**：PPR 三角 + BOM 组成 + 工序时序是离散制造建模，ISO 15926 的 composedOf/startsBefore 谓词直接对应

**第三步提问**：
1. 变速箱壳体的加工需要哪些设备资源？
2. OP20 工序的紧前工序和紧后工序分别是什么？
3. 变速箱壳体由哪些零部件组成？

**跑通方式**：见本文件开头「三步实操」（界面手动 / `node scripts/run-sample-cases.js case7-manufacturing-ppr`）；真实运行产物写入 `case7-manufacturing-ppr/报告.md`。

**protege-js 原生示例**（可选对照，直接跑 JS 版推理机）：

```bash
node d:/个人助手/Synapse/protege/protege-js/sample/case7-manufacturing-ppr.js
```

**protege-js 原生示例输出**（对照用，非 Synapse 三步产物）：

```
RDF/XML 导出含 Product 类        : true
round-trip 再导入公理数          : 40
整车 hasPart 车门（传递推理）     : true
车门 partOf 整车（逆关系推理）    : true
冲压 precedes 涂装（工艺顺序传递）: true
部件被归类为 Product（子类推理）  : true
整车归为 BFO material entity      : true
冲压归为 BFO process              : true
本体一致性                      : true
```

## 真实医疗：BFO / OGMS 顶层本体

导入 OBO Foundry 的 BFO（Basic Formal Ontology）与 OGMS（Ontology for General Medical Science），在真实医疗本体上运行 OWL 2 RL 推理。

**案例目录**：`case8-real-medical-bfo-ogms/`｜**顶层本体体系**：`bfo`

| 三步契约 | 本案例内容 |
|---|---|
| ① 客户上传资料 → 建图 | `资料/01-感冒诊疗路径.md`、`资料/02-门诊就诊记录.md` |
| ② 体系约束/公理校验 | 通道 C 全图校验（`bfo` 的类层级 + 公理 + domain/range 护栏） |
| ③ 提问 → 图谱推理作答 | 见下方 3 个问题 |

**体系选择理由**：案例本身就是 BFO/OGMS 对齐的示范，必须用 BFO 2020 标准体系

**第三步提问**：
1. 患者出现发热和咽痛，最可能的诊断是什么？
2. 普通感冒的治疗方案包含哪些环节？
3. 这次门诊就诊过程中做了哪些检查？

**跑通方式**：见本文件开头「三步实操」（界面手动 / `node scripts/run-sample-cases.js case8-real-medical-bfo-ogms`）；真实运行产物写入 `case8-real-medical-bfo-ogms/报告.md`。

**protege-js 原生示例**（可选对照，直接跑 JS 版推理机）：

```bash
node d:/个人助手/Synapse/protege/protege-js/sample/case8-real-medical-bfo-ogms.js
```

**protege-js 原生示例输出**（对照用，非 Synapse 三步产物）：

```
================ 真实标准本体加载 ================
BFO 公理数                       : 178
OGMS 公理数                      : 845
真实类层级边数                   : 218
含全部 OGMS 临床标准类           : true

================ 治疗方案 OGMS 层级归因 ================
对症治疗归为 SymptomaticTreatment: true
  → treatment                    : true
  → therapeutic procedure(兄弟类): false
  → BFO process                  : true
沿真实 OGMS 层级完整归因         : true

================ 诊断 IDO 层级归因 ================
诊断归为上呼吸道感染             : true
  → diagnosis                    : true
  → infectious disorder          : true
  → acute disease course       : true
```

## 真实制造：IAO 信息工件本体

导入 IAO（Information Artifact Ontology），把设计文档、工艺卡、质量报告等建模为信息工件，并用 OWL 2 RL 追踪其版本与引用关系。

**案例目录**：`case9-real-manufacturing-iao/`｜**顶层本体体系**：`iso15926`

| 三步契约 | 本案例内容 |
|---|---|
| ① 客户上传资料 → 建图 | `资料/01-缸体加工工艺规程.md`、`资料/02-质量检验与批记录.md` |
| ② 体系约束/公理校验 | 通道 C 全图校验（`iso15926` 的类层级 + 公理 + domain/range 护栏） |
| ③ 提问 → 图谱推理作答 | 见下方 3 个问题 |

**体系选择理由**：工艺规程/参数采集/质检/批记录是工业信息工件与物理过程的集成，ISO 15926 覆盖设备层级与时序

**第三步提问**：
1. 缸体粗铣工序的切削参数是多少？
2. 批次 B20260901 的质检结果如何，有无不合格项？
3. 精镗工序用的是哪台设备和哪把刀具？

**跑通方式**：见本文件开头「三步实操」（界面手动 / `node scripts/run-sample-cases.js case9-real-manufacturing-iao`）；真实运行产物写入 `case9-real-manufacturing-iao/报告.md`。

**protege-js 原生示例**（可选对照，直接跑 JS 版推理机）：

```bash
node d:/个人助手/Synapse/protege/protege-js/sample/case9-real-manufacturing-iao.js
```

**protege-js 原生示例输出**（对照用，非 Synapse 三步产物）：

```
================ 真实标准本体加载 ================
BFO 公理数                       : 178
IAO 公理数                       : 2361
真实类层级边数                   : 288
含全部 IAO 工艺标准类            : true

================ 批记录 IAO 层级归因 ================
批记录归为 BatchRecord           : true
  → document                     : true
  → information content entity   : true
  → BFO generically dependent cont: true
沿真实 IAO 层级完整归因          : true

================ 产品与工艺执行 ================
EB-2024-001 归为 EngineBlock     : true
EB-2024-001 归为 Product         : true
铸造 precedes 精加工（传递）      : true
粗加工需要数控加工中心           : true
粗加工需要...
```

## 电商客服：知识库问答推理

把商品、订单、物流、售后政策建模为 OWL 本体，用 OWL 2 RL 推理回答客服常见问题（如「我的订单到哪了」「能否退货」）。

**案例目录**：`case10-ecommerce-customer-service/`｜**顶层本体体系**：`bfo-lite`

| 三步契约 | 本案例内容 |
|---|---|
| ① 客户上传资料 → 建图 | `资料/01-客服工单分派规则.md`、`资料/02-工单与会话记录.md` |
| ② 体系约束/公理校验 | 通道 C 全图校验（`bfo-lite` 的类层级 + 公理 + domain/range 护栏） |
| ③ 提问 → 图谱推理作答 | 见下方 3 个问题 |

**体系选择理由**：工单/用户/技能组/客服是业务对象与流程，bfo-lite 轻量分类即可

**第三步提问**：
1. 工单 T-3001 应该分派给哪个技能组？为什么是紧急工单？
2. 退款类工单的处理流程是怎样的？
3. 哪些工单需要升级为紧急或特急工单？

**跑通方式**：见本文件开头「三步实操」（界面手动 / `node scripts/run-sample-cases.js case10-ecommerce-customer-service`）；真实运行产物写入 `case10-ecommerce-customer-service/报告.md`。

**protege-js 原生示例**（可选对照，直接跑 JS 版推理机）：

```bash
node d:/个人助手/Synapse/protege/protege-js/sample/case10-ecommerce-customer-service.js
```

**protege-js 原生示例输出**（对照用，非 Synapse 三步产物）：

```
================ SWRL 工单分派 ================
SWRL 推理新增事实数        : 3
金牌工单路由到金牌客服组   : true
普通工单路由到通用客服组   : true

================ BFO/IAO 层级归因 ================
工单归为 BFO material entity: true
客户归为 BFO material entity: true
分派方案归为 IAO plan spec  : true
SLA 归为 IAO directive info : true
分派日志归为 IAO document   : true

================ 场景A：根因分析 ================
缺陷批次工单1告警          : true
缺陷批次工单2告警          : true
正常批次工单不告警         : true
批次→供应商关联            : true

================ 场景B：投诉升级预测 ================
高危工单标记升级风险       : true
关联工单传递升级风险       : true
```

## 相关文档

- [protege-js API 文档](https://github.com/skaterqiang/protege-js/blob/master/docs/API.md)
- [Synapse 知识图谱使用手册](../docs/07-知识图谱.md)
- [OWL 2 RL 推理设置](../docs/10-设置.md#107-图谱)
