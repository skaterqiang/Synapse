// LLM Wiki 领域层：wiki 根目录定位、页面读取/描述、来源保存、上下文打包、问答/体检/回填
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const TurndownService = require('turndown');
const { chatOnce, streamChat, extractJson } = require('./llm');
const { num } = require('./config');

// ---------- 根目录与路径工具 ----------
function defaultWikiRoot() {
  const candidates = [
    path.join(app.getAppPath(), 'llmwiki'),
    path.join(app.getPath('documents'), 'llmwiki'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'AGENTS.md'))) return c;
  }
  return candidates[1];
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
// 读取单个页面：raw/ 下按根目录解析，其余按 wiki/ bundle 解析
function readPage(settings, relPath) {
  const root = wikiRoot(settings);
  const bundle = path.join(root, 'wiki');
  const abs = relPath.startsWith('raw/') ? safeJoin(root, relPath) : safeJoin(bundle, relPath.replace(/^\//, ''));
  return fs.readFileSync(abs, 'utf-8');
}

function describeWiki(settings) {
  const root = wikiRoot(settings);
  const bundle = path.join(root, 'wiki');
  if (!fs.existsSync(path.join(root, 'AGENTS.md')) || !fs.existsSync(bundle)) {
    return { exists: false, root };
  }
  const pages = walkMd(bundle, bundle).map((rel) => {
    const content = readIfExists(path.join(bundle, rel)) || '';
    const { fm } = parseFrontmatter(content);
    return { path: rel, type: fm.type || '', title: fm.title || '', description: fm.description || '', status: fm.status || '' };
  });
  const log = readIfExists(path.join(bundle, 'log.md')) || '';
  const logTailLines = num(settings, 'logTailLines', 30, 1, 500);
  return {
    exists: true,
    root,
    schema: readIfExists(path.join(root, 'AGENTS.md')) || '',
    indexContent: readIfExists(path.join(bundle, 'index.md')) || '',
    logTail: log.split(/\r?\n/).slice(0, logTailLines).join('\n'),
    pages,
  };
}

// ---------- 上下文打包与日志 ----------
function bundleContext(settings, { includeFullPages = true } = {}) {
  const root = wikiRoot(settings);
  const bundle = path.join(root, 'wiki');
  const schema = readIfExists(path.join(root, 'AGENTS.md')) || '';
  const indexContent = readIfExists(path.join(bundle, 'index.md')) || '';
  const pages = walkMd(bundle, bundle);
  let pagesBlock = '';
  const listing = [];
  for (const rel of pages) {
    const content = readIfExists(path.join(bundle, rel)) || '';
    const { fm } = parseFrontmatter(content);
    listing.push(`- ${rel} | ${fm.type || ''} | ${fm.title || ''} | ${fm.description || ''}`);
    if (includeFullPages && !rel.endsWith('index.md') && !rel.endsWith('log.md')) {
      pagesBlock += `\n=== 页面: ${rel} ===\n${content}\n`;
    }
  }
  return { root, bundle, schema, indexContent, listing: listing.join('\n'), pagesBlock };
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
async function saveRawSource(settings, { title, content, sourceUrl }) {
  const root = wikiRoot(settings);
  const rawDir = path.join(root, 'raw');
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
  return { relPath: 'raw/' + path.basename(file), title: usedTitle };
}

// ---------- Wiki 问答：两步检索 + 流式合成 ----------
async function wikiAsk(event, { settings, question }) {
  try {
    const ctx = bundleContext(settings, { includeFullPages: false });
    const maxPages = num(settings, 'wikiAskMaxPages', 5, 1, 20);
    const pickAnswer = await chatOnce(settings, [
      { role: 'system', content: '你是知识库检索器，只输出 JSON。' },
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
    if (loaded.length === 0) {
      // 回退：带上全部页面清单与 index
      loaded.push({ path: 'index.md', content: ctx.indexContent });
    }
    event.sender.send('wiki:refs', loaded.map((x) => x.path));

    const contextText = loaded.map((x) => `=== 页面: ${x.path} ===\n${x.content}`).join('\n\n');
    const messages = [
      {
        role: 'system',
        content: `你是个人知识库问答助手。以下是知识库中的相关页面：\n\n${contextText}\n\n请基于页面内容回答用户问题，使用 Markdown 格式；引用具体页面时使用形如 [页面标题](/路径.md) 的链接。若页面中没有答案，请如实说明。`,
      },
      { role: 'user', content: question },
    ];
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
  const rel = `topics/answer-${stamp}.md`;
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

  // 更新 index.md：在主题小节首行后插入条目
  const indexFile = path.join(ctx.bundle, 'index.md');
  let index = readIfExists(indexFile) || '';
  const bullet = `* [${title}](${rel}) - 归档问答：${title}`;
  const m = index.match(/^#\s*主题.*$/m);
  if (m) {
    index = index.replace(m[0], `${m[0]}\n\n${bullet}`);
    fs.writeFileSync(indexFile, index, 'utf-8');
  }
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
    { role: 'system', content: '你是严谨的知识库质量审查员。' },
    { role: 'user', content: prompt },
  ]);
}

module.exports = {
  defaultWikiRoot,
  wikiRoot,
  safeJoin,
  readIfExists,
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
