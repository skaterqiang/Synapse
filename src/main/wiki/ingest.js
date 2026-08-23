// Ingest 编排：读来源 → 匹配领域模版 → AI 编译页面计划 → 落盘（拆分步骤，供作业系统分阶段上报）
const path = require('path');
const fs = require('fs');
const { chatOnce, extractJson } = require('../ai/llm');
const { safeJoin, readIfExists, appendLog, OKF_TYPES, rebuildIndex } = require('./wiki');
const { readRawText } = require('./files');
const { matchTemplate, templateGuidance, listTemplates } = require('./templates');
const { num } = require('../common/config');
const { getPrompt } = require('../ai/prompts');

async function loadIngestRaws(settings, ctx, rawPaths) {
  const raws = [];
  // 超长来源截断阈值（settings.sourceMaxChars），避免提示词爆炸
  const maxChars = num(settings, 'sourceMaxChars', 60000, 1000, 1000000);
  for (const rawPath of rawPaths) {
    let rawContent = '';
    try { rawContent = await readRawText(settings, rawPath); } catch (_) { rawContent = ''; }
    if (!rawContent) throw new Error('原始来源不存在或无法提取文本：' + rawPath);
    const capped = rawContent.length > maxChars ? rawContent.slice(0, maxChars) + '\n\n（…内容过长已截断…）' : rawContent;
    raws.push({ rawPath, content: capped });
  }
  return raws;
}

async function compileIngestPlan(settings, ctx, raws, onProgress, forceDomain) {
  const rawBlocks = raws
    .map((r, i) => `=== 新吸收的原始来源 ${i + 1}/${raws.length}（${r.rawPath}） ===\n${r.content}`)
    .join('\n\n');

  // 领域模版：提交前已由用户确认（forceDomain）则直接使用，否则 LLM 匹配
  let tpl = null;
  if (forceDomain) {
    tpl = listTemplates().find((t) => t.id === forceDomain) || null;
    if (onProgress) onProgress(`使用领域模版：${tpl ? tpl.name : forceDomain}（提交前已确认），模型生成页面计划中…`);
  } else {
    if (onProgress) onProgress('正在匹配领域模版…');
    tpl = await matchTemplate(settings, raws);
    if (onProgress) onProgress(`已匹配领域模版：${tpl ? tpl.name : '无'}，模型生成页面计划中…`);
  }

  const prompt = [
    '你是个人知识库（LLM Wiki）的维护 Agent，必须严格遵守下述模式文档（AGENTS.md）的全部约定：',
    '',
    ctx.schema,
    '',
    '=== 当前 wiki/index.md ===',
    ctx.indexContent,
    '',
    templateGuidance(tpl),
    '',
    '=== 现有页面全文 ===',
    ctx.pagesBlock || '（暂无页面）',
    '',
    rawBlocks,
    '',
    '任务：执行 Ingest 工作流，吸收上述全部来源。只输出一个 JSON 对象，不要输出其他任何内容：',
    '{',
    '  "pages": [ { "path": "<领域>/<类型>/<name>.md", "content": "完整文件内容（含 frontmatter）" } ],',
    '  "summary": "一句话中文摘要（只写内容本身，不要带任何前缀），用于 log.md"',
    '}',
    '要求：',
    '- 全程使用中文进行思考与输出（JSON 内的正文、摘要、页面内容均为中文）；',
    '- pages 包含所有需要新建或覆盖更新的页面，路径格式 <领域>/<sources|concepts|topics|entities>/<name>.md，领域固定为 ' + (tpl ? tpl.id : 'general') + '；每个 content 均为完整文件内容；',
    `- 每个页面的 frontmatter 必须包含 domain: ${tpl ? tpl.id : 'general'}（所属领域模版 ID）；`,
    '- 不要将 index.md、log.md 或 raw/ 中的文件放入 pages；',
    '- 严格遵守 OKF v0.2 frontmatter（type 必填）与脚注归因约定；正文用中文；',
    `- 必须为每个来源至少创建一个 <领域>/sources/ 下的来源摘要页（共 ${raws.length} 个来源）。`,
  ].join('\n');

  // 流式上报模型思考/输出进度与尾部预览（节流 600ms，避免事件风暴）
  let think = '';
  let out = '';
  let lastReport = 0;
  const report = onProgress
    ? (delta, isReasoning) => {
      if (isReasoning) think += delta; else out += delta;
      const now = Date.now();
      if (now - lastReport > 600) {
        lastReport = now;
        const phase = out ? `模型输出中（已 ${out.length} 字）` : `模型思考中（已 ${think.length} 字）`;
        const preview = ((think ? `【思考】\n${think}\n\n` : '') + (out ? `【输出】\n${out}` : '')).slice(-1500);
        onProgress(`已匹配领域模版：${tpl ? tpl.name : '无'}，${phase}…`, preview);
      }
    }
    : null;

  const answer = await chatOnce(settings, [
    { role: 'system', content: getPrompt(settings, 'ingestPrompt') },
    { role: 'user', content: prompt },
  ], undefined, report);
  try {
    const plan = extractJson(answer);
    plan.matchedTemplate = tpl ? tpl.name : '';
    plan.domainId = tpl ? tpl.id : 'general';
    return plan;
  } catch (err) {
    throw new Error('模型返回无法解析：' + err.message);
  }
}

function applyIngestPlan(ctx, plan, raws) {
  const touched = [];
  const domainId = plan.domainId || 'general';
  for (const page of plan.pages || []) {
    let rel = String(page.path || '').replace(/^\/?(wiki\/)?/, '');
    // 模型若漏写领域前缀（直接输出 <类型>/xxx.md），自动补上当前领域
    if (OKF_TYPES.includes(rel.split('/')[0])) rel = domainId + '/' + rel;
    if (!rel.endsWith('.md')) continue;
    if (rel === 'index.md' || rel === 'log.md' || rel.startsWith('..') || rel.startsWith('raw/')) continue;
    const abs = safeJoin(ctx.bundle, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, String(page.content || '').trim() + '\n', 'utf-8');
    touched.push(rel);
  }
  if (plan.index_md) delete plan.index_md; // index.md 由应用确定性重建，忽略模型输出
  rebuildIndex(ctx.root);
  const names = raws.map((r) => `[${path.basename(r.rawPath)}](../${r.rawPath})`).join('、');
  const label = raws.length > 1 ? `吸收 ${raws.length} 个来源（${names}）` : `吸收 ${names}`;
  appendLog(ctx.bundle, `**Ingest**: ${label}：${plan.summary || ''}；触及页面：${touched.join('、') || '无'}`);
  return { touched, summary: plan.summary || '' };
}

module.exports = { loadIngestRaws, compileIngestPlan, applyIngestPlan };
