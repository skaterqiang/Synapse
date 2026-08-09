# AGENTS.md — 个人知识库维护模式（Schema）

本文件是这个 LLM Wiki 知识库的模式层（schema）。任何 LLM Agent 在操作本知识库前必须先阅读本文件，并严格遵守以下约定。

## 1. 架构（三层）

```
llmwiki/
├── AGENTS.md        # 模式层：本文件，定义约定与工作流
├── raw/             # 原始源层：不可变的原始材料，Agent 只读不写
│   └── YYYY-MM-DD-<slug>.md
└── wiki/            # wiki 层：OKF v0.2 知识包（bundle），由 Agent 全权维护
    ├── index.md     # 目录（保留文件名）
    ├── log.md       # 变更日志（保留文件名）
    ├── concepts/    # 概念页（定义、方法论、结论）
    ├── sources/     # 来源摘要页（每个 raw 源一个）
    ├── topics/      # 主题综合页
    └── entities/    # 实体页（人物、组织、工具）
```

- **raw/ 不可变**：Agent 永远不修改 raw/ 中的文件。新增来源 = 新建文件，文件名格式 `YYYY-MM-DD-<slug>.md`。
- **wiki/ 由 Agent 维护**：用户只读，Agent 负责创建、更新、交叉引用与一致性。
- 知识只"编译"一次，之后持续保鲜：新来源进入时更新既有页面，而不是每次问答重新推导。

## 2. OKF v0.2 格式约定

wiki/ 是一个遵循 OKF v0.2 的 Knowledge Bundle：

### 2.1 概念文档

每个概念是一个 markdown 文件 = YAML frontmatter + markdown 正文。

```yaml
---
type: <必填>            # Source | Concept | Entity | Topic | Answer
title: <显示名>
description: <一句话摘要，供 index.md 与检索使用>
tags: [tag1, tag2]
status: stable          # draft | stable | deprecated
generated: { by: <actor>, at: <ISO 8601> }   # 每次实质修改后更新
sources:                # 溯源：本概念来自哪些材料
  - id: <稳定 id>
    resource: <URL 或相对路径（如 ../../raw/xxx.md）>
    title: <来源标题>
    author: <actor>     # 可选，可信度信号
---
```

### 2.2 Actor 约定

- Agent 生成/修改：`personal-kb-agent/1.0`
- 用户人工确认：`human:owner`
- 自动化流程：`process:<id>`

用户人工审阅过某页面后，追加 `verified: { by: human:owner, at: <时间> }`（信任等级从 unverified 升为 human-reviewed）。

### 2.3 链接

- 概念间链接优先使用 bundle 根相对路径：`[标题](/concepts/xxx.md)`（`/` = wiki/ 根）。
- 引用具体论断时使用脚注归因，脚注标签 = `sources[].id`：
  `该论断成立。[^llm-wiki-gist]`
- 允许"悬空链接"（指向尚未撰写的页面），这是待写知识的信号。

### 2.4 保留文件名

`index.md`、`log.md` 为保留名，不得用作概念文档。

## 3. 类型词汇表（本库自定义）

| type | 目录 | 用途 |
|------|------|------|
| `Source` | sources/ | 一个原始来源的结构化摘要与要点提取 |
| `Concept` | concepts/ | 概念、方法论、定义、跨源综合结论 |
| `Entity` | entities/ | 人物、组织、工具、项目 |
| `Topic` | topics/ | 某主题下的大型综合页（含演化中的论点） |
| `Answer` | topics/ | 值得归档的问答结果（query 回填） |

## 4. 工作流

### 4.1 Ingest（吸收新来源）

用户将新材料放入 raw/（或提供 URL 由 Agent 抓取后存入 raw/），然后说"ingest 这个来源"：

1. 读取原始源全文。
2. 与用户讨论关键要点（除非用户要求批量静默模式）。
3. 在 sources/ 创建 `Source` 摘要页（要点、论断、来源元数据）。
4. 更新相关的 concepts/、entities/、topics/ 页面；新信息与旧结论冲突时必须显式标注冲突并说明取舍。
5. 更新 index.md（新增条目含一句话描述）。
6. 在 log.md 追加条目（当日分组下新增一行）。
7. 单次 ingest 触及多个页面是常态（10-15 页不必惊讶）。

### 4.2 Query（问答）

1. 先读 wiki/index.md 定位相关页面，再深入阅读（中等规模下无需向量检索）。
2. 综合回答并给出引用（链接到具体概念页）。
3. **有价值的回答应回填 wiki**：以 `type: Answer` 归档到 topics/，并更新 index.md 与 log.md，让探索复利。

### 4.3 Lint（健康检查）

用户说"lint"时执行：

1. 页面间矛盾；2. 被新来源取代的陈旧论断；3. 无入链的孤儿页；
4. 被频繁提及却没有独立页面的概念；5. 缺失的交叉引用；
6. `stale_after` 已过期的页面；7. 建议下一步值得寻找的来源或值得提出的问题。

输出一份报告，修复动作需用户确认后执行。

## 5. log.md 格式

按日期倒序分组（最新在上），条目为散文行，首词加粗标注动作类型：

```markdown
# Update Log

## 2026-08-08
* **Ingest**: 吸收 [LLM Wiki (Karpathy)](/sources/llm-wiki-karpathy.md)，新建概念页 ...
* **Initialization**: 初始化知识库。
```

## 6. 其他约定

- 语言：正文用中文书写，术语保留英文原文。
- 文件名：kebab-case，英文 slug。
- 时间：全部使用 ISO 8601；日志日期用 `YYYY-MM-DD`。
- 本库是 git 友好设计：每次 ingest/lint 后建议提交一次，获得完整演化历史。
- 模式层与 wiki 共同演化：发现更好的约定时，先更新本文件再执行。
