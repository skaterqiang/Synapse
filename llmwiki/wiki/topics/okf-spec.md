---
type: Topic
title: OKF 规范（Open Knowledge Format v0.2）
description: Google Cloud 发布的开放知识格式规范综述：Markdown + YAML frontmatter 的自描述知识包，含溯源、信任、生命周期机制。
tags: [okf, google, knowledge-format, standard]
status: stable
generated: { by: personal-kb-agent/1.0, at: 2026-08-08T21:35:00Z }
sources:
  - id: okf-spec
    resource: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
    title: "OKF SPEC v0.2"
    author: team:google-cloud
    last_modified: 2026-07-01
---

# 定位

OKF 是 Google Cloud 推出的开放、厂商中立的**知识表示规范**（不是平台、数据库或 SDK）：一个 markdown 文件目录 + YAML frontmatter。它把 [LLM Wiki 模式](/concepts/llm-wiki-pattern.md) 的"媒介层"标准化为可移植、可交换、可被任意 Agent 消费的格式。[^okf-spec]

# 核心结构

- **Knowledge Bundle**：自包含的 markdown 目录树，分发单位（git 仓库 / 压缩包 / 子目录）。
- **Concept**：单个知识单元 = 一个 markdown 文件。Concept ID = 文件路径去掉 `.md`。
- **保留文件名**：`index.md`（目录，渐进式披露）、`log.md`（变更历史），不得用作概念文档。
- **链接**：标准 markdown 链接表达关系；推荐 bundle 根相对路径（`/xxx.md`）；消费方必须容忍悬空链接。

# Frontmatter 字段族

| 字段族 | 关键字段 | 回答的问题 |
|--------|----------|------------|
| 基础 | `type`（唯一必填）、`title`、`description`、`resource`、`tags` | 这是什么 |
| 溯源 Provenance | `sources[]`（resource 必填，id/title/author/usage_count/last_modified 可选） | 从哪来 |
| 信任 Trust | `generated: {by, at}`、`verified: [{by, at}]` | 谁写的、谁确认过 |
| 生命周期 | `status`（draft/stable/deprecated）、`stale_after` | 是否仍然有效 |
| 认证计算 | `runtime`、`parameters`、`executor`、`attester`（仅 Attested Computation 类型） | 数值是否按规定算出 |

# 信任机制（v0.2 重点）

- **Actor 约定**：`<producer>/<version>`（Agent）、`human:<id>`、`process:<id>`。
- **信任等级**由 `verified` 推导：无 verified ⇒ unverified；仅非人类验证 ⇒ machine-confirmed；有 `human:` 验证 ⇒ human-reviewed。
- **可信度信号**（author / usage_count / last_modified）是客观事实记录，不存储主观评分——信任由消费方推断。
- **逐论断归因**：正文脚注标签 = `sources[].id`（稳定 key，抗列表重排）。

# 合规底线（§11）

1. 所有非保留 `.md` 文件有可解析的 frontmatter；
2. frontmatter 含非空 `type`；
3. `index.md` / `log.md` 符合各自结构。

消费方**不得**因缺少可选字段、未知 type、未知扩展键、悬空链接或缺少 index.md 而拒绝 bundle。

# 与本知识库的关系

本库 `wiki/` 目录即一个 OKF v0.2 bundle（根 index.md 声明 `okf_version: "0.2"`），类型词汇表（Source/Concept/Entity/Topic/Answer）为本库自定义扩展——OKF 明确允许，消费方须容忍未知 type。

[^okf-spec]: OKF SPEC v0.2
