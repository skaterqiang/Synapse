// LLM Wiki 领域层：wiki 根目录定位、页面读取/描述、来源保存、上下文打包、问答/体检/回填
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const TurndownService = require('turndown');
const { chatOnce, streamChat, extractJson, agenticChat, ASK_PROTOCOL } = require('../ai/llm');
const mcpClient = require('../mcp/mcpClient');
const mcpMod = require('../mcp/mcp');
const runner = require('../skills/runner');
const { getPrompt } = require('../ai/prompts');
const graph = require('../graph/graph');
const paths = require('../common/paths');
const { num } = require('../common/config');

// OKF 页面类型目录（wiki/<领域>/<类型>/xxx.md）
const OKF_TYPES = ['concepts', 'entities', 'sources', 'topics'];

// ---------- 根目录与路径工具 ----------
// Wiki 根目录探测：统一数据根目录优先（data/llmwiki），其次内置/历史位置
function defaultWikiRoot() {
  const candidates = [
    path.join(paths.dataRoot(), 'llmwiki'),
    path.join(app.getAppPath(), 'llmwiki'),
    path.join(process.resourcesPath || app.getAppPath(), 'llmwiki'),
    path.join(app.getPath('documents'), 'llmwiki'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'AGENTS.md'))) return c;
  }
  return candidates[0];
}

// Wiki 目录归一：未自定义 wikiRoot 时，把内置/历史位置的 llmwiki 搬迁到统一根目录（data/llmwiki）
function unifyWikiRootToData() {
  try {
    const settings = require('../common/settings').getSettings();
    if ((settings.wikiRoot || '').trim()) return null; // 用户自定义优先
  } catch (_) {}
  const target = path.join(paths.dataRoot(), 'llmwiki');
  if (fs.existsSync(path.join(target, 'AGENTS.md'))) return null;
  const sources = [
    path.join(app.getAppPath(), 'llmwiki'),
    path.join(process.resourcesPath || app.getAppPath(), 'llmwiki'),
    path.join(app.getPath('documents'), 'llmwiki'),
  ];
  for (const src of sources) {
    if (src === target || !fs.existsSync(path.join(src, 'AGENTS.md'))) continue;
    try {
      fs.cpSync(src, target, { recursive: true });
      try { fs.renameSync(src, src + '.migrated'); } catch (_) { /* 只读源（打包内嵌）保留原样 */ }
      console.log('llmwiki 已归一到统一根目录:', target);
      return target;
    } catch (err) {
      console.error('llmwiki 归一失败:', err.message);
    }
  }
  return null;
}

// 安装版首启：把随包知识包释放到默认根目录；无任何种子时生成最小骨架（开发版同样适用，
// 避免首次吸收直接写出页面却缺 AGENTS.md 导致 Wiki 视图判为不存在）
const DEFAULT_AGENTS_MD = [
  '# AGENTS.md — 个人知识库维护约定（OKF v0.2）',
  '',
  '本目录是由 LLM 持续维护的个人知识库（OKF v0.2 Knowledge Bundle）。所有维护动作（Ingest / Query / Lint）须遵守下述约定。',
  '',
  '## 目录结构',
  '- `<领域>/sources/<slug>.md` 来源摘要页（每次吸收必须为每个来源至少创建一个）',
  '- `<领域>/concepts/<slug>.md` 概念与方法论',
  '- `<领域>/entities/<slug>.md` 人物 / 组织 / 工具',
  '- `<领域>/topics/<slug>.md` 主题综合页与归档问答',
  '- `raw/` 不可变原始源层，Agent 只读不写；新增来源一律新建文件',
  '- `index.md` 目录（应用确定性重建）；`log.md` 变更日志（应用追加）',
  '',
  '## 文档约定',
  '- 每页必带 YAML frontmatter：type（Source/Concept/Entity/Topic/Answer）、title、description、tags、status、generated，另含 domain 标明所属领域',
  '- 正文中文书写，术语保留英文；文件名用 kebab-case 英文 slug',
  '- 具体论断通过脚注归因到来源；时间统一 ISO 8601',
  '- Actor 标识：`personal-kb-agent/1.0`（Agent 生成）、`human:owner`（人工确认）',
  '',
  '## 工作流',
  '- **Ingest**：阅读新来源 → 新建/更新页面 → 同步目录与日志',
  '- **Query**：基于现有页面作答并归因来源',
  '- **Lint**：健康检查（矛盾、陈旧论断、孤儿页、缺失引用）',
  '',
].join('\n');

function ensureDefaultWiki() {
  const target = defaultWikiRoot();
  if (fs.existsSync(path.join(target, 'AGENTS.md'))) return target;
  if (app.isPackaged) {
    const seeds = [
      path.join(process.resourcesPath || '', 'llmwiki'),
      path.join(app.getAppPath(), 'llmwiki'),
    ];
    for (const seed of seeds) {
      if (seed && fs.existsSync(path.join(seed, 'AGENTS.md'))) {
        fs.cpSync(seed, target, { recursive: true });
        return target;
      }
    }
  }
  // 无可用种子：生成最小骨架，并基于已落盘页面重建 index.md
  try {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'AGENTS.md'), DEFAULT_AGENTS_MD, 'utf-8');
    if (!fs.existsSync(path.join(target, 'log.md'))) fs.writeFileSync(path.join(target, 'log.md'), '# Update Log\n', 'utf-8');
    rebuildIndex(target);
    console.log('已生成默认 Wiki 骨架:', target);
  } catch (err) {
    console.error('默认 Wiki 骨架生成失败:', err.message);
  }
  return target;
}

function wikiRoot(settings) {
  const root = (settings && settings.wikiRoot) || defaultWikiRoot();
  return path.resolve(root);
}

// 路径安全：禁止逃逸出指定根目录
function safeJoin(root, rel) {
  const p = path.resolve(root, rel);
  if (p !== root && !p.startsWith(root + path.sep)) {
    throw new Error('非法路径：' + rel);
  }
  return p;
}

function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf-8'); } catch (_) { return null; }
}

function slugify(text) {
  const s = String(text || '')
    .toLowerCase()
    .replace(/https?:\/\//g, '')
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || 'source';
}

function uniquePath(dir, filename) {
  let candidate = path.join(dir, filename);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, filename.replace(/\.md$/, `-${n}.md`));
    n++;
  }
  return candidate;
}

// ---------- Markdown 解析与遍历 ----------
// 轻量 frontmatter 解析（仅用于列表展示）
function parseFrontmatter(content) {
  const text = String(content).replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return { fm: {}, body: text };
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return { fm: {}, body: text };
  const fm = {};
  for (const line of text.slice(4, end).split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (m) fm[m[1]] = m[2].trim();
  }
  return { fm, body: text.slice(end + 5) };
}

function walkMd(dir, root, list = []) {
  if (!fs.existsSync(dir)) return list;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMd(p, root, list);
    else if (entry.name.endsWith('.md')) list.push(path.relative(root, p).replace(/\\/g, '/'));
  }
  return list;
}

// ---------- 读取与描述 ----------
// 最新布局：llmwiki/<领域>/<类型>/xxx.md，index.md/log.md 在根；raw/ 同在根下
function isWikiPageRel(rel) {
  return !rel.startsWith('raw/') && rel !== 'AGENTS.md' && rel !== 'index.md' && rel !== 'log.md';
}

// 读取单个页面：统一按根目录解析
function readPage(settings, relPath) {
  const root = wikiRoot(settings);
  const abs = safeJoin(root, relPath.replace(/^\//, ''));
  return fs.readFileSync(abs, 'utf-8');
}

function describeWiki(settings) {
  const root = wikiRoot(settings);
  if (!fs.existsSync(path.join(root, 'AGENTS.md'))) {
    return { exists: false, root };
  }
  const pages = walkMd(root, root).filter(isWikiPageRel).map((rel) => {
    const content = readIfExists(path.join(root, rel)) || '';
    const { fm } = parseFrontmatter(content);
    const segs = rel.split('/');
    // 领域推导：frontmatter.domain 优先，其次路径首段（<领域>/<类型>/xxx.md）
    const domain = fm.domain || (segs.length >= 3 && OKF_TYPES.includes(segs[1]) ? segs[0] : '') || 'general';
    return { path: rel, type: fm.type || '', title: fm.title || '', description: fm.description || '', status: fm.status || '', domain };
  });
  const nav = [];
  if (fs.existsSync(path.join(root, 'index.md'))) nav.push({ path: 'index.md', type: '', title: '目录', description: '', status: '', domain: '' });
  if (fs.existsSync(path.join(root, 'log.md'))) nav.push({ path: 'log.md', type: '', title: '更新日志', description: '', status: '', domain: '' });
  const log = readIfExists(path.join(root, 'log.md')) || '';
  const logTailLines = num(settings, 'logTailLines', 30, 1, 500);
  return {
    exists: true,
    root,
    schema: readIfExists(path.join(root, 'AGENTS.md')) || '',
    indexContent: readIfExists(path.join(root, 'index.md')) || '',
    logTail: log.split(/\r?\n/).slice(0, logTailLines).join('\n'),
    pages: [...nav, ...pages],
  };
}

// ---------- 上下文打包与日志 ----------
function bundleContext(settings, { includeFullPages = true } = {}) {
  const root = wikiRoot(settings);
  const schema = readIfExists(path.join(root, 'AGENTS.md')) || '';
  const indexContent = readIfExists(path.join(root, 'index.md')) || '';
  const pages = walkMd(root, root).filter((rel) => isWikiPageRel(rel) || rel === 'index.md' || rel === 'log.md');
  let pagesBlock = '';
  const listing = [];
  for (const rel of pages) {
    const content = readIfExists(path.join(root, rel)) || '';
    const { fm } = parseFrontmatter(content);
    listing.push(`- ${rel} | ${fm.type || ''} | ${fm.title || ''} | ${fm.description || ''}`);
    if (includeFullPages && rel !== 'index.md' && rel !== 'log.md') {
      pagesBlock += `\n=== 页面: ${rel} ===\n${content}\n`;
    }
  }
  return { root, bundle: root, schema, indexContent, listing: listing.join('\n'), pagesBlock };
}

// 在 log.md 当日分组下追加条目（精确匹配标题行，避免误插到正文中的同日期文本后）
function appendLog(bundle, entry) {
  const logFile = path.join(bundle, 'log.md');
  const today = new Date().toISOString().slice(0, 10);
  let log = readIfExists(logFile) || '# Update Log\n';
  const line = `* ${entry}`;
  const heading = `## ${today}`;
  const lines = log.split('\n');
  const idx = lines.findIndex((l) => l.trim() === heading);
  if (idx >= 0) {
    lines.splice(idx + 1, 0, line);
  } else {
    lines.splice(1, 0, '', heading, '', line);
  }
  fs.writeFileSync(logFile, lines.join('\n'), 'utf-8');
}

// ---------- 来源保存（文本 / URL） ----------
async function saveRawSource(settings, { title, content, sourceUrl, auto }) {
  const root = wikiRoot(settings);
  // auto=true（吸收笔记/文本/URL 自动生成）存入 raw/_auto/，不纳入「原始文件」管理；
  // 用户从本机添加的文件/目录仍存 raw/ 根下。
  const rawDir = auto ? path.join(root, 'raw', '_auto') : path.join(root, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });

  let md = '';
  let usedTitle = (title || '').trim();
  if (sourceUrl) {
    // 拉取超时（settings.urlFetchTimeout 秒），避免无响应站点导致流程挂起
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), num(settings, 'urlFetchTimeout', 30, 1, 600) * 1000);
    let resp;
    try {
      resp = await fetch(sourceUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (personal-kb)' }, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) throw new Error(`网页拉取失败 (HTTP ${resp.status})`);
    const html = await resp.text();
    const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    let body = turndown.turndown(html);
    // 去掉脚本/样式残留行
    body = body.split('\n').filter((l) => !/^\s*(var |window\.|function\(|\{)/.test(l)).join('\n');
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (!usedTitle && titleMatch) usedTitle = titleMatch[1].trim();
    md = `# ${usedTitle || sourceUrl}\n\n> 来源 URL: ${sourceUrl}\n> 拉取时间: ${new Date().toISOString()}\n\n${body}`;
  } else {
    md = String(content || '').trim();
    if (!md) throw new Error('内容为空');
    if (!usedTitle) usedTitle = md.split('\n')[0].replace(/^#+\s*/, '').slice(0, 40) || 'untitled';
  }

  const date = new Date().toISOString().slice(0, 10);
  const filename = `${date}-${slugify(usedTitle)}.md`;
  const file = uniquePath(rawDir, filename);
  fs.writeFileSync(file, md, 'utf-8');
  const rel = 'raw/' + (auto ? '_auto/' : '') + path.basename(file);
  return { relPath: rel, title: usedTitle };
}

// ---------- Wiki 问答：两步检索 + 流式合成 ----------
async function wikiAsk(event, { settings, question, notesContext, rawsContext, attachContext, includeGraph, extHint, history, extMcp }) {
  try {
    const ctx = bundleContext(settings, { includeFullPages: false });
    const maxPages = num(settings, 'wikiAskMaxPages', 5, 1, 20);
    // 选页是一次完整的非流式模型调用，本地大模型下可能很慢；
    // 下发阶段步骤，避免界面长时间只停在“思考中”而没任何反馈
    const pageCount = String(ctx.listing || '').split('\n').filter((x) => x.trim()).length;
    event.sender.send('ai:step', { kind: 'thought', text: `正在从 ${pageCount} 个 Wiki 页面中筛选与问题相关的页面…` });
    const pickAnswer = await chatOnce(settings, [
      { role: 'system', content: getPrompt(settings, 'wikiPickPrompt') },
      {
        role: 'user',
        content: `以下是知识库的 index.md 与页面清单：\n\n${ctx.indexContent}\n\n页面清单：\n${ctx.listing}\n\n用户问题：${question}\n\n请选出回答问题最需要阅读的页面（最多 ${maxPages} 个），输出 JSON：{"pages": ["concepts/xxx.md", ...]}。只输出 JSON。`,
      },
    ]);
    let picks = [];
    try {
      picks = (extractJson(pickAnswer).pages || []).slice(0, maxPages);
    } catch (_) {}
    const loaded = [];
    for (const rel of picks) {
      const abs = safeJoin(ctx.bundle, String(rel).replace(/^\//, ''));
      const content = readIfExists(abs);
      if (content) loaded.push({ path: String(rel).replace(/^\//, ''), content });
    }
    // 选页失败时回退带上 index（仅作为上下文兜底）；它不是真正的依据来源，不当引用上报
    let pagesFallback = false;
    if (loaded.length === 0) {
      pagesFallback = true;
      loaded.push({ path: 'index.md', content: ctx.indexContent });
    }
    // 知识图谱勾选时召回本体层上下文；命中实体随引用事件一并下发，供前端展示查询明细
    const recall = includeGraph ? graph.recallFor(question) : { context: '', hits: [] };
    event.sender.send('wiki:refs', { pages: pagesFallback ? [] : loaded.map((x) => x.path), graph: recall.hits });
    event.sender.send('ai:step', {
      kind: 'thought',
      text: pagesFallback
        ? '未选中具体页面，改用 index 概览作为上下文'
        : `已选中 ${loaded.length} 个页面：${loaded.map((x) => x.path).join('、')}`,
    });

    const contextText = loaded.map((x) => `=== 页面: ${x.path} ===\n${x.content}`).join('\n\n');
    const graphCtx = recall.context;
    const notesBlock = notesContext ? `【笔记检索结果】\n${notesContext}` : '';
    // 原始文件为关键字（grep 式）命中，未经语义校对，必须如实告知模型自行取舍，
    // 否则容易把碰巧命中的片段当成依据
    // 上传附件是用户本次明确指定的材料，优先级高于检索所得，
    // 与关键字命中区分开，不应要求模型“自行取舍相关性”
    const attachBlock = attachContext
      ? `【用户本次上传的文件】以下内容由用户直接提供，是本次提问的主要依据，请优先依据它作答：\n${attachContext}\n`
      : '';
    const rawsBlock = rawsContext
      ? `【原始文件关键字命中】以下片段由关键字检索得到，未经语义校对，可能含不相关内容：\n${rawsContext}\n`
        + '请只采用与问题真正相关的片段，引用时注明文件名；若均不相关，就当作没有相关资料，不得强行引用。'
      : '';
    // 先装载 MCP 工具，再定提示词策略：
    // 未勾选时自动装载全部 enabled 服务器（由模型自行选工具）；
    // 装载失败→剔除提示词里的 MCP 描述并下发告警步骤，避免模型在无工具时“声称已搜索”
    const { cfgs: mcpCfgs } = mcpMod.resolveMcpCfgs({ settings, extMcp });
    if (mcpCfgs.length) event.sender.send('ai:step', { kind: 'thought', text: `正在装载 ${mcpCfgs.length} 个 MCP 服务器的工具…` });
    const tools = [];
    const toolErrs = [];
    for (const cfg of mcpCfgs) {
      try { tools.push(...await mcpMod.listToolsCached(cfg, settings)); }
      catch (e) { toolErrs.push(`${cfg.name || cfg.url}: ${e.message}`); }
    }
    let hint = extHint || '';
    if (!tools.length && mcpCfgs.length) {
      hint = hint.replace(/可用 MCP 服务器：[^;。]*/g, '').replace(/【可用扩展能力】\s*[;；]\s*/, '【可用扩展能力】');
      if (!/启用技能|可用 MCP/.test(hint)) hint = '';
      event.sender.send('ai:step', { kind: 'thought', text: `⚠️ MCP 工具装载失败（${toolErrs.join('；')}），本轮不会调用外部工具` });
    }
    const toolRule = tools.length
      ? '【工具使用约定】本会话已接入外部工具（function calling），可用工具：'
        + tools.map((t) => t.function && t.function.name).filter(Boolean).join('、') + '。'
        + '凡涉及实时/最新/事实性/外部数据的问题，或上述页面与笔记不足以回答时，'
        + '必须先自行选择并调用合适的工具获取依据，再基于工具结果作答并注明来源；'
        + '不得仅因“知识库没有”就拒答。工具返回空结果时如实说明。未实际调用工具时，不得声称“已搜索/已联网/已调用”。\n\n'
      : '';
    // 已启用的 MCP 默认全部参与，调哪个工具由模型自行判断（不再无条件强制搜索）
    // 可执行技能（docx/pptx/xlsx）激活时注入脚本执行工具
    const execTool = runner.execToolIfActive(settings);
    if (execTool) tools.push(execTool);
    if (tools.length) event.sender.send('ai:step', { kind: 'thought', text: `已装载 ${tools.length} 个工具，由模型自行选择是否调用` });
    event.sender.send('ai:step', { kind: 'thought', text: '正在生成回答…' });
    const messages = [
      {
        role: 'system',
        content: `${getPrompt(settings, 'wikiAskPrompt')}\n以下是知识库中的相关页面：\n\n${contextText}\n\n${attachBlock ? attachBlock + '\n\n' : ''}${notesBlock ? notesBlock + '\n\n' : ''}${rawsBlock ? rawsBlock + '\n\n' : ''}${graphCtx ? graphCtx + '\n\n' : ''}${hint ? hint + '\n\n' : ''}${toolRule}请基于上述内容回答用户问题，使用 Markdown 格式；引用具体页面时使用形如 [页面标题](/路径.md) 的链接。若内容中没有答案，请如实说明。\n\n${ASK_PROTOCOL}`,
      },
      ...(Array.isArray(history) ? history : []),
      { role: 'user', content: question },
    ];
    if (tools.length) return agenticChat(event, settings, messages, tools, (t, args) => (t._builtin === 'run' ? runner.runNodeScript(args) : mcpClient.callTool(t._server, settings, t._tool, args)));
    await streamChat(event, settings, messages);
  } catch (err) {
    event.sender.send('ai:error', err.message);
  }
}

// 问答回填：归档为 type: Answer 页面
async function fileAnswer(settings, { question, answer }) {
  const ctx = bundleContext(settings, { includeFullPages: false });
  const now = new Date();
  // 精确到毫秒，避免同一分钟内多次回填文件名碰撞覆盖
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, '')
    + '-' + now.toTimeString().slice(0, 8).replace(/:/g, '')
    + String(now.getMilliseconds()).padStart(3, '0');
  const title = (question || '问答归档').slice(0, 40);
  const rel = `general/topics/answer-${stamp}.md`;
  const abs = safeJoin(ctx.bundle, rel);
  const fm = [
    '---',
    'type: Answer',
    `title: "${title.replace(/"/g, '\\"')}"`,
    `description: 归档问答——${title}`,
    'tags: [answer]',
    'status: stable',
    `generated: { by: personal-kb-agent/1.0, at: ${now.toISOString().replace(/\.\d+Z$/, 'Z')} }`,
    '---',
  ].join('\n');
  const content = `${fm}\n\n# 问题\n\n${question}\n\n# 回答\n\n${answer}\n`;
  fs.writeFileSync(abs, content, 'utf-8');

  // index.md 由应用确定性重建（不再手工插入）
  rebuildIndex(ctx.root);
  appendLog(ctx.bundle, `**Query**: 问答回填 [${title}](${rel})`);
  return { path: rel };
}

// ---------- Lint 全库体检 ----------
async function lintWiki(settings) {
  return lintFromContext(settings, bundleContext(settings, { includeFullPages: true }));
}

// 拆出 lintFromContext，供体检作业复用已收集的上下文
async function lintFromContext(settings, ctx) {
  const prompt = [
    '你是个人知识库（LLM Wiki）的维护 Agent，请依据下述模式文档执行 Lint 健康检查：',
    '',
    ctx.schema,
    '',
    '=== wiki/index.md ===',
    ctx.indexContent,
    '',
    '=== 全部页面 ===',
    ctx.pagesBlock,
    '',
    '请输出 Markdown 格式体检报告，逐项检查：页面间矛盾、陈旧论断、孤儿页（无入链）、被频繁提及却没有独立页面的概念、缺失的交叉引用、frontmatter 不合规项（对照 OKF v0.2）、值得补充的来源或值得提出的新问题。没有问题的小节请写“未发现问题”。只输出报告本身。',
  ].join('\n');
  return chatOnce(settings, [
    { role: 'system', content: getPrompt(settings, 'lintPrompt') },
    { role: 'user', content: prompt },
  ]);
}

// 存量 Wiki 迁移：wiki/<类型>/xxx.md → wiki/<领域>/<类型>/xxx.md（领域取 frontmatter.domain，缺省 general）
// index.md 确定性重建：按 领域 → OKF 类型 分组列出全部页面（吸收/迁移/回填后自动调用）
function rebuildIndex(rootArg) {
  const root = rootArg || wikiRoot(undefined);
  if (!fs.existsSync(path.join(root, 'AGENTS.md'))) return;
  const pages = walkMd(root, root).filter(isWikiPageRel).map((rel) => {
    const { fm } = parseFrontmatter(readIfExists(path.join(root, rel)) || '');
    const segs = rel.split('/');
    const domain = fm.domain || (segs.length >= 3 && OKF_TYPES.includes(segs[1]) ? segs[0] : '') || 'general';
    return { rel, domain, type: segs.length >= 2 ? segs[segs.length - 2] : '', title: fm.title || rel, description: fm.description || '' };
  });
  let tplName = (id) => id;
  try {
    tplName = (id) => {
      const t = require('./templates').listTemplates().find((x) => x.id === id);
      return t ? t.name : id;
    };
  } catch (_) {}
  const typeLabels = { concepts: '概念 Concepts', sources: '来源 Sources', topics: '主题 Topics', entities: '实体 Entities' };
  const domains = [...new Set(pages.map((p) => p.domain))].sort();
  let md = '---\nokf_version: "0.2"\n---\n\n# 个人知识库 · 目录\n\n由 LLM 持续维护的 OKF v0.2 知识包。维护约定见 [AGENTS.md](AGENTS.md)，演化历史见 [log.md](log.md)。\n';
  for (const d of domains) {
    md += `\n# 领域：${tplName(d)}（${d}）\n`;
    for (const [type, label] of Object.entries(typeLabels)) {
      const sub = pages.filter((p) => p.domain === d && p.type === type);
      if (!sub.length) continue;
      md += `\n## ${label}\n\n` + sub.map((p) => `* [${p.title}](${p.rel})${p.description ? ' - ' + p.description : ''}`).join('\n') + '\n';
    }
  }
  fs.writeFileSync(path.join(root, 'index.md'), md, 'utf-8');
}

// 存量迁移：拍平旧 wiki/ 中间层 + 顶层类型目录归入 general 领域，最后重建 index.md
function migrateWikiToDomainDirs(settings) {
  const root = wikiRoot(settings);
  if (!fs.existsSync(path.join(root, 'AGENTS.md'))) return 0;
  const mergeDir = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const f = path.join(from, entry.name);
      const t = path.join(to, entry.name);
      if (entry.isDirectory()) mergeDir(f, t);
      else if (!fs.existsSync(t)) fs.renameSync(f, t);
    }
    try { fs.rmdirSync(from); } catch (_) {}
  };
  // 1) 拍平旧 wiki/ 层：内容上移到 llmwiki/ 根
  const legacyBundle = path.join(root, 'wiki');
  if (fs.existsSync(legacyBundle)) {
    for (const entry of fs.readdirSync(legacyBundle, { withFileTypes: true })) {
      const from = path.join(legacyBundle, entry.name);
      const to = path.join(root, entry.name);
      if (entry.name === 'index.md' || entry.name === 'log.md') {
        if (!fs.existsSync(to)) fs.renameSync(from, to);
        else try { fs.rmSync(from); } catch (_) {}
      } else if (entry.isDirectory()) {
        if (!fs.existsSync(to)) fs.renameSync(from, to);
        else mergeDir(from, to);
      }
    }
    try { fs.rmdirSync(legacyBundle); } catch (_) {}
    console.log('已拍平旧 wiki/ 中间层');
  }
  // 2) 顶层类型目录归入 general 领域
  let moved = 0;
  for (const type of OKF_TYPES) {
    const dir = path.join(root, type);
    if (!fs.existsSync(dir)) continue;
    const target = path.join(root, 'general', type);
    mergeDir(dir, target);
    moved++;
  }
  // 3) 确定性重建 index.md
  rebuildIndex(root);
  return moved;
}

module.exports = {
  OKF_TYPES,
  migrateWikiToDomainDirs,
  rebuildIndex,
  unifyWikiRootToData,
  defaultWikiRoot,
  ensureDefaultWiki,
  wikiRoot,
  safeJoin,
  readIfExists,
  slugify,
  uniquePath,
  readPage,
  describeWiki,
  bundleContext,
  appendLog,
  saveRawSource,
  wikiAsk,
  fileAnswer,
  lintWiki,
  lintFromContext,
};
