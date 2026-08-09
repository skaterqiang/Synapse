---
type: Source
title: "LLM Wiki (Karpathy)"
description: Karpathy 的 LLM Wiki 概念文档：用 LLM 增量维护持久化个人 wiki 以替代每次重新检索的 RAG 模式。
resource: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
tags: [llm-wiki, knowledge-management, methodology]
status: stable
generated: { by: personal-kb-agent/1.0, at: 2026-08-08T21:30:00Z }
sources:
  - id: llm-wiki-gist
    resource: ../../raw/2026-08-08-llm-wiki-karpathy.md
    title: "LLM Wiki (gist 原文快照)"
    author: human:karpathy
    last_modified: 2026-08-08
---

# 元信息

| 项 | 值 |
|----|----|
| 作者 | Andrej Karpathy |
| 原始链接 | [gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) |
| 本地快照 | [raw/2026-08-08-llm-wiki-karpathy.md](../../raw/2026-08-08-llm-wiki-karpathy.md) |
| 性质 | 概念文档（idea file），描述模式而非具体实现 |

# 核心论断

1. **RAG 的根本缺陷是无积累**：每次提问都从零重新发现知识，需要综合多个文档的微妙问题每次都要重新拼凑碎片。NotebookLM、ChatGPT 文件上传均属此类。[^llm-wiki-gist]
2. **wiki 是持久的、复利式增长的产物**：LLM 在吸收新来源时直接把知识"编译"进结构化、互相链接的 markdown wiki——交叉引用已就位、矛盾已标注、综合已反映全部已读内容。[^llm-wiki-gist]
3. **分工**：人负责选源、探索与提出好问题；LLM 负责总结、交叉引用、归档与全部簿记工作。"Obsidian 是 IDE，LLM 是程序员，wiki 是代码库"。[^llm-wiki-gist]
4. **人类放弃 wiki 的原因是维护负担增长快于价值**；LLM 让维护成本趋近于零，这是模式成立的关键。[^llm-wiki-gist]

# 三层架构

- **Raw sources**：精选原始文档，不可变，LLM 只读——事实的最终来源。
- **The wiki**：LLM 生成并全权维护的 markdown 目录（摘要页、实体页、概念页、对比、综述）。
- **The schema**：一份模式文档（如 CLAUDE.md / AGENTS.md），定义结构约定与工作流，是"让 LLM 成为有纪律的 wiki 维护者而非普通聊天机器人"的关键配置。

# 三个操作

- **Ingest**：吸收新来源——阅读原文、讨论要点、写摘要页、更新索引、更新全库相关页面、追加日志；单个来源触及 10-15 个页面是常态。
- **Query**：先读 index.md 定位再深入阅读；**好的回答应回填为新页面**，让探索与吸收一样复利。
- **Lint**：定期健康检查——矛盾、陈旧论断、孤儿页、缺失页面与交叉引用、数据缺口。

# 导航与规模化

- `index.md`（内容目录）+ `log.md`（时间线）两个特殊文件；在中等规模（约 100 来源、数百页面）下无需向量检索基础设施。[^llm-wiki-gist]
- 更大规模可引入 [qmd](https://github.com/tobi/qmd) 等本地混合检索工具。

# 思想渊源

与 Vannevar Bush 1945 年的 Memex 构想同源：私有的、主动策展的知识库，文档间的关联轨迹与文档本身同等重要。Bush 没解决"谁来做维护"，LLM 解决了。[^llm-wiki-gist]

# 适用场景

个人成长追踪、研究深耕、读书伴侣 wiki、团队内部 wiki、竞品分析、尽调、旅行规划、课程笔记等一切需要长期积累知识的场景。

[^llm-wiki-gist]: LLM Wiki (gist 原文快照)
