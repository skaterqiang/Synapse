// Ingest 编排：读来源 → AI 编译页面计划 → 落盘（三步拆分，供作业系统分阶段上报）
const path = require('path');
const fs = require('fs');
const { chatOnce, extractJson } = require('./llm');
const { safeJoin, readIfExists, appendLog } = require('./wiki');
const { num } = require('./config');

function loadIngestRaws(settings, ctx, rawPaths) {
  const raws = [];
  // 超长来源截断阈值（settings.sourceMaxChars），避免提示词爆炸
  const maxChars = num(settings, 'sourceMaxChars', 60000, 1000, 1000000);
  for (const rawPath of rawPaths) {
    const rawAbs = safeJoin(ctx.root, rawPath);
    const rawContent = readIfExists(rawAbs);
    if (!rawContent) throw new Error('原始来源不存在：' + rawPath);
    const capped = rawContent.length > maxChars ? rawContent.slice(0, maxChars) + '\n\n（…内容过长已截断…）' : rawContent;
    raws.push({ rawPath, content: capped });
  }
  return raws;
}

async function compileIngestPlan(settings, ctx, raws) {
  const rawBlocks = raws
    .map((r, i) => `=== 新吸收的原始来源 ${i + 1}/${raws.length}（${r.rawPath}） ===\n${r.content}`)
    .join('\n\n');

  const prompt = [
    '你是个人知识库（LLM Wiki）的维护 Agent，必须严格遵守下述模式文档（AGENTS.md）的全部约定：',
    '',
    ctx.schema,
    '',
    '=== 当前 wiki/index.md ===',
    ctx.indexContent,
    '',
    '=== 现有页面全文 ===',
    ctx.pagesBlock || '（暂无页面）',
    '',
    rawBlocks,
    '',
    '任务：执行 Ingest 工作流，吸收上述全部来源。只输出一个 JSON 对象，不要输出其他任何内容：',
    '{',
    '  "pages": [ { "path": "sources/xxx.md", "content": "完整文件内容（含 frontmatter）" } ],',
    '  "index_md": "更新后的完整 wiki/index.md 内容（保留 okf_version frontmatter）",',
    '  "summary": "一句话中文摘要（只写内容本身，不要带任何前缀），用于 log.md"',
    '}',
    '要求：',
    '- pages 包含所有需要新建或覆盖更新的页面（sources/concepts/topics/entities 目录下），每个 content 均为完整文件内容；',
    '- 不要将 index.md、log.md 或 raw/ 中的文件放入 pages；',
    '- 严格遵守 OKF v0.2 frontmatter（type 必填）与脚注归因约定；正文用中文；',
    `- 必须为每个来源至少创建一个 sources/ 下的来源摘要页（共 ${raws.length} 个来源）。`,
  ].join('\n');

  const answer = await chatOnce(settings, [
    { role: 'system', content: '你是严谨的知识库维护 Agent，输出必须是合法 JSON。' },
    { role: 'user', content: prompt },
  ]);
  try {
    return extractJson(answer);
  } catch (err) {
    throw new Error('模型返回无法解析：' + err.message);
  }
}

function applyIngestPlan(ctx, plan, raws) {
  const touched = [];
  for (const page of plan.pages || []) {
    const rel = String(page.path || '').replace(/^\/?(wiki\/)?/, '');
    if (!rel.endsWith('.md')) continue;
    if (rel === 'index.md' || rel === 'log.md' || rel.startsWith('..')) continue;
    const abs = safeJoin(ctx.bundle, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, String(page.content || '').trim() + '\n', 'utf-8');
    touched.push(rel);
  }
  if (plan.index_md) {
    fs.writeFileSync(path.join(ctx.bundle, 'index.md'), String(plan.index_md).trim() + '\n', 'utf-8');
  }
  const names = raws.map((r) => `[${path.basename(r.rawPath)}](../${r.rawPath})`).join('、');
  const label = raws.length > 1 ? `吸收 ${raws.length} 个来源（${names}）` : `吸收 ${names}`;
  appendLog(ctx.bundle, `**Ingest**: ${label}：${plan.summary || ''}；触及页面：${touched.join('、') || '无'}`);
  return { touched, summary: plan.summary || '' };
}

module.exports = { loadIngestRaws, compileIngestPlan, applyIngestPlan };
