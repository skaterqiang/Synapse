---
type: Concept
title: LLM Wiki 模式
description: 用 LLM 增量构建并持续维护一个持久化、互相链接的个人 wiki，知识编译一次后持续保鲜，替代每次查询重新推导的 RAG。
tags: [llm-wiki, knowledge-management, rag-alternative, methodology]
status: stable
generated: { by: personal-kb-agent/1.0, at: 2026-08-08T21:30:00Z }
sources:
  - id: llm-wiki-gist
    resource: ../../raw/2026-08-08-llm-wiki-karpathy.md
    title: "LLM Wiki (Karpathy)"
    author: human:karpathy
    last_modified: 2026-08-08
---

# 定义

LLM Wiki 是一种个人知识管理模式：不把 LLM 用作查询时的一次性检索器（RAG），而是让 LLM **增量地把每个新来源编译进一个持久化的 markdown wiki**，并持续维护其交叉引用、一致性与时效性。知识被编译一次，之后持续保鲜，而不是在每次提问时重新推导。[^llm-wiki-gist]

# 与 RAG 的对比

| 维度 | 传统 RAG | LLM Wiki |
|------|----------|----------|
| 知识组织 | 原始文档切块 + 向量索引 | 结构化、互链的编译产物 |
| 每次查询 | 重新检索、重新拼凑、重新综合 | 直接读取已就位的综合结论 |
| 积累性 | 无（每次从零开始） | 复利式增长 |
| 矛盾处理 | 不感知 | 吸收时显式标注 |
| 基础设施 | 嵌入模型、向量库 | 一个 markdown 目录即可 |

# 关键机制

1. **吸收即编译**：新来源进入时更新实体页、修订主题综述、标注与旧论断的冲突（见 [来源摘要页](/sources/llm-wiki-karpathy.md) 的"三个操作"）。
2. **问答可回填**：有价值的查询结果归档为新页面，探索与吸收同样复利。
3. **定期 Lint**：健康检查保持 wiki 随规模增长而不腐化。
4. **index + log 导航**：中等规模（约百级来源）下纯文本目录即可，无需向量检索。

# 在本知识库中的实例化

本库是 LLM Wiki 模式的一个实例，并按 Google [OKF v0.2](/topics/okf-spec.md) 规范包装：

- 原始源层 → [../raw/](../../raw/)（不可变）
- wiki 层 → 本目录（[index.md](/index.md) 导航）
- 模式层 → [../AGENTS.md](../../AGENTS.md)（本库的 schema）

# 开放问题

- 规模上限：超过数百页面后 index-first 导航何时失效，何时需要引入混合检索（如 qmd）？
- 多人/多 Agent 协作时的冲突合并策略？
- 与 OKF 的信任机制（`verified`、`stale_after`）结合后，能否支撑团队级知识治理？

[^llm-wiki-gist]: LLM Wiki (Karpathy)
