// 问答发送链路端到端回归：node test/ask-chain.test.js
// 验证 ai:ask 正确使用：① 勾选的数据源（笔记/图谱/原始文件）② 绑定的 MCP
// ③ 生效技能（含逐题去除门控）④ 上传附件（渲染层拼好的 system 消息透传）
//
// 方法：临时沙箱数据目录 + electron shim + mock LLM（本地 SSE 服务）+ mock MCP（stdio），
// 直接调用 ipcMain.handle('ai:ask') 处理器并断言下发事件与发给模型的请求体。
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const Module = require('module');

// ---------- 沙箱：HOME 指向临时目录，数据根/数据库/笔记/原始文件全部隔离 ----------
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-asktest-'));
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;

const handlers = new Map();
let events = []; // [{ch, d}] 主进程下发事件
const fakeEvent = { sender: { send: (ch, d) => events.push({ ch, d }) } };

const electronShim = {
  app: {
    isPackaged: false,
    getPath: (name) => {
      if (name === 'userData') return path.join(SANDBOX, 'userData');
      if (name === 'appData') return SANDBOX;
      if (name === 'documents') return path.join(SANDBOX, 'Documents');
      throw new Error(`沙箱不支持 app.getPath('${name}')`);
    },
    getAppPath: () => SANDBOX,
  },
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
  dialog: { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '', showItemInFolder: async () => undefined, openExternal: async () => undefined },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return electronShim;
  return origLoad.call(this, request, ...rest);
};

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' → ' + detail : ''}`); }
}

// ---------- mock LLM：OpenAI 兼容 SSE；回显收到的关键上下文特征，便于断言 ----------
function startMockLLM() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let j = {};
      try { j = JSON.parse(body); } catch (_) {}
      received.push(j);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const hasToolResult = (j.messages || []).some((m) => m.role === 'tool');
      // MCP 工具名被命名空间化为「服务器名__工具名」，这里匹配后缀 __echo
      const echoTool = (j.tools || []).find((t) => t.function && /(^|__)echo$/.test(t.function.name));
      if (echoTool && !hasToolResult) {
        // 第一轮：发起一次 echo 工具调用（验证 MCP 真实执行链路；工具名被命名空间化为 服务器名__工具名）
        const delta = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: echoTool.function.name, arguments: '{"query":"MOCK-TOOL-Q"}' } }] } }] };
        res.write('data: ' + JSON.stringify(delta) + '\n\n');
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      const sys = (j.messages || []).filter((m) => m.role === 'system').map((m) => String(m.content || ''));
      const flags = {
        notes: sys.some((c) => c.includes('【笔记检索结果】')),
        raws: sys.some((c) => c.includes('【原始文件关键字命中】')),
        graph: sys.some((c) => c.includes('【知识图谱·本体层】')),
        attach: sys.some((c) => c.includes('请优先依据以下附件内容回答')),
        extHint: sys.some((c) => c.includes('【可用扩展能力】')),
        toolResult: (j.messages || []).some((m) => m.role === 'tool' && /stdio echo/.test(String(m.content || ''))),
        tools: (j.tools || []).map((t) => t.function && t.function.name).filter(Boolean),
      };
      const text = 'MOCK-ANSWER ' + JSON.stringify(flags);
      for (const piece of text.match(/.{1,24}/g) || []) {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: piece } }] }) + '\n\n');
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, received, port: server.address().port })));
}

// 调用 ai:ask 并收集事件直到 ai:done / ai:error
async function ask(payload) {
  events = [];
  await handlers.get('ai:ask')(fakeEvent, payload);
  const ev = (ch) => events.filter((e) => e.ch === ch).map((e) => e.d);
  const answer = ev('ai:chunk').join('');
  return {
    answer,
    steps: ev('ai:step'),
    refs: ev('ai:refs')[0] || null,
    error: ev('ai:error')[0] || '',
    flags: (() => { try { return JSON.parse(answer.replace(/^MOCK-ANSWER /, '')); } catch (_) { return null; } })(),
  };
}

const QUESTION = '山东高速迁移上云方案有哪些要点？';
const stdioMock = { name: 'mockStdio', type: 'stdio', command: process.execPath, args: [path.join(__dirname, 'mock-mcp-stdio.js')] };

(async () => {
  // ---------- 装配：与 web/server.js 相同顺序 ----------
  const db = require('../src/main/common/db');
  const paths = require('../src/main/common/paths');
  paths.ensureUnifiedRoot();
  await db.init();
  const { registerIpc } = require('../src/main/ipc');
  registerIpc(() => ({ isDestroyed: () => false, webContents: { send: () => {} } }));

  const llm = await startMockLLM();
  const settings = { apiBaseUrl: `http://127.0.0.1:${llm.port}/v1`, apiKey: 'test-key', model: 'mock-model' };

  // ---------- 播种测试语料 ----------
  const root = paths.dataRoot();
  // 笔记：<根>/note/<标题>.md（frontmatter 与 store.serializeNote 一致）
  const noteDir = path.join(root, 'note');
  fs.mkdirSync(noteDir, { recursive: true });
  fs.writeFileSync(path.join(noteDir, '山东高速迁移上云方案.md'), [
    '---', 'id: t-note-1', 'title: "山东高速迁移上云方案"', 'tags: ["云","迁移"]',
    'pinned: 0', 'createdAt: 1', 'updatedAt: 2', '---', '',
    '山东高速集团计划将核心业务系统迁移上云，采用混合云架构，分批迁移。',
  ].join('\n'), 'utf-8');
  // 原始文件：<根>/llmwiki/raw/*.md
  const rawDir = path.join(root, 'llmwiki', 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, '山东高速云上迁移方案.md'), '# 山东高速云上迁移方案\n\n迁移上云要点：网络打通、数据同步、灰度切换、回滚预案。', 'utf-8');
  // 知识图谱：kv 'graph'
  db.setKv('graph', JSON.stringify({
    nodes: [{ id: 'n1', name: '山东高速', type: 'entity', desc: '山东高速集团云上迁移项目' }],
    edges: [], updatedAt: Date.now(),
  }));

  const base = (extra) => ({
    settings,
    messages: [
      { role: 'system', content: '你是个人知识库助手，请简洁、准确地回答问题。' },
      { role: 'user', content: QUESTION },
    ],
    extMcp: [],
    skillNames: [],
    ...extra,
  });

  console.log('\n【1】数据源·笔记：勾选笔记 → 检索、引用、上下文注入');
  let r = await ask(base({ sources: { notes: true, graph: false, raws: false } }));
  check('勾选源立即下发「检索…」步骤', r.steps.some((s) => /检索笔记…/.test(s.text || '')), JSON.stringify(r.steps.map((s) => s.text)));
  check('笔记检索步骤下发', r.steps.some((s) => /笔记命中/.test(s.text || '')), JSON.stringify(r.steps));
  check('ai:refs 上报笔记引用', !!(r.refs && r.refs.notes && r.refs.notes.length && r.refs.notes[0].title === '山东高速迁移上云方案'), JSON.stringify(r.refs));
  check('笔记上下文注入 system', !!(r.flags && r.flags.notes), r.answer || r.error);
  check('未勾选的源不检索', !(r.flags && (r.flags.raws || r.flags.graph)));

  console.log('\n【2】数据源·原始文件：勾选原始文件 → 关键字命中与引用');
  r = await ask(base({ sources: { notes: false, graph: false, raws: true } }));
  check('原始文件扫描进度步骤下发', r.steps.some((s) => (s.kind === 'progress' && /扫描原始文件/.test(s.text || '')) || /检索原始文件…/.test(s.text || '')), JSON.stringify(r.steps.map((s) => s.kind + ':' + s.text).slice(0, 6)));
  check('原始文件检索步骤下发', r.steps.some((s) => /原始文件命中/.test(s.text || '')), JSON.stringify(r.steps));
  check('ai:refs 上报原始文件引用', !!(r.refs && r.refs.raws && r.refs.raws.length && /山东高速/.test(r.refs.raws[0].name)), JSON.stringify(r.refs));
  check('原始文件上下文注入 system', !!(r.flags && r.flags.raws), r.answer || r.error);

  console.log('\n【3】数据源·知识图谱：勾选图谱 → 实体召回与引用');
  r = await ask(base({ sources: { notes: false, graph: true, raws: false } }));
  check('图谱召回步骤下发', r.steps.some((s) => /知识图谱召回/.test(s.text || '')), JSON.stringify(r.steps));
  check('ai:refs 上报图谱命中', !!(r.refs && r.refs.graph && r.refs.graph.includes('山东高速')), JSON.stringify(r.refs));
  check('图谱上下文注入 system', !!(r.flags && r.flags.graph), r.answer || r.error);

  console.log('\n【4】数据源全关：不检索、不上报引用');
  r = await ask(base({ sources: { notes: false, graph: false, raws: false } }));
  check('无 ai:refs 事件', r.refs === null, JSON.stringify(r.refs));
  check('全关不下发任何检索步骤', !r.steps.some((s) => /检索|扫描/.test(s.text || '')), JSON.stringify(r.steps.map((s) => s.text)));
  check('无知识上下文注入', !!(r.flags && !r.flags.notes && !r.flags.raws && !r.flags.graph), r.answer || r.error);
  check('正常出答案（无工具走 streamChat）', /MOCK-ANSWER/.test(r.answer), r.error);

  console.log('\n【5】MCP：绑定的 stdio 服务器 → 装载上报 + 工具真实调用');
  r = await ask(base({ extMcp: [stdioMock], sources: { notes: false, graph: false, raws: false } }));
  check('MCP 装载步骤上报', r.steps.some((s) => /mockStdio：已装载/.test(s.text || '')), JSON.stringify(r.steps.map((s) => s.text)));
  check('工具随请求下发给模型（命名空间化 mockStdio__echo）', !!(r.flags && r.flags.tools.includes('mockStdio__echo')), JSON.stringify(r.flags && r.flags.tools));
  check('模型发起工具调用且 MCP 真实执行', !!(r.flags && r.flags.toolResult), r.answer || r.error);

  console.log('\n【6】MCP 装载失败：逐服务器告警，不阻塞回答');
  r = await ask(base({ extMcp: [{ name: 'badStdio', type: 'stdio', command: 'definitely-not-a-real-cmd-xyz' }] }));
  check('失败步骤下发（❌）', r.steps.some((s) => /^❌ badStdio/.test(s.text || '')), JSON.stringify(r.steps.map((s) => s.text)));
  check('失败不阻塞出答案', /MOCK-ANSWER/.test(r.answer), r.error);

  console.log('\n【7】技能门控：生效名单含 docx → 注入脚本执行工具；空名单 → 不注入');
  r = await ask(base({ skillNames: ['docx', 'deep-research'] }));
  check('docx 生效 → skill__run_script 注入', !!(r.flags && r.flags.tools.includes('skill__run_script')), JSON.stringify(r.flags && r.flags.tools));
  r = await ask(base({ skillNames: ['deep-research'] }));
  check('仅非执行类技能 → 不注入脚本工具', !!(r.flags && !r.flags.tools.includes('skill__run_script')), JSON.stringify(r.flags && r.flags.tools));

  console.log('\n【8】附件与扩展提示：渲染层拼好的 system 消息原样透传');
  r = await ask(base({
    messages: [
      { role: 'system', content: '请优先依据以下附件内容回答：\n\n【上传文件1】report.txt\n双十一保障重点是稳定性。' },
      { role: 'user', content: QUESTION },
    ],
    extHint: '【可用扩展能力】启用技能：docx。请在回答中酌情运用。',
  }));
  check('附件 system 消息透传给模型', !!(r.flags && r.flags.attach), r.answer || r.error);
  check('extHint 注入 system', !!(r.flags && r.flags.extHint), r.answer || r.error);

  console.log('\n【9】兼容旧调用方：未传 sources 仅传 useGraph → 只检索图谱');
  r = await ask({ settings, messages: [{ role: 'user', content: QUESTION }], useGraph: true, extMcp: [] });
  check('旧参数 useGraph 生效', !!(r.refs && r.refs.graph && r.refs.graph.includes('山东高速')), JSON.stringify(r.refs));
  check('未误开笔记/原始文件', !(r.flags && (r.flags.notes || r.flags.raws)));

  console.log('\n【10】原始文件·链接优先：名称命中的链接最先读取；链接读取失败可见');
  // mock 链接服务器：普通 HTML 正文（Web/测试模式走全局 fetch，不经隐藏窗）
  const linkHtml = '<html><head><meta charset="utf-8"><title>山东高速云上迁移方案</title></head><body><h1>山东高速云上迁移方案</h1><p>山东高速迁移上云总体策略采用混合云架构，步骤为：网络打通、数据同步、灰度切换、回滚预案。核心业务系统分批迁移，确保业务连续性与数据安全，同时完成合规审查与等保备案，迁移窗口安排在业务低峰期。</p></body></html>';
  const linkServer = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(linkHtml); });
  await new Promise((r2) => linkServer.listen(0, '127.0.0.1', r2));
  const linkUrl = `http://127.0.0.1:${linkServer.address().port}/doc/sdgs`;
  const raws = require('../src/main/raws/raws');
  await raws.addUrl(settings, linkUrl, '山东高速云上迁移方案');
  // 150 个噪声文本文件稀释队列：若无优先机制，链接会被排在队尾并被扫描预算截断
  const noiseDir = path.join(root, 'llmwiki', 'raw', 'noise');
  fs.mkdirSync(noiseDir, { recursive: true });
  for (let i = 0; i < 150; i++) fs.writeFileSync(path.join(noiseDir, `noise-${i}.md`), `噪声文件 ${i}：与问题无关的填充文本，仅用于撑大扫描队列验证预算截断。`);
  r = await ask(base({ sources: { notes: false, graph: false, raws: true } }));
  check('名称命中链接最先读取（进度步骤出现）', r.steps.some((s) => /读取链接正文：山东高速云上迁移方案/.test(s.text || '')), JSON.stringify(r.steps.map((s) => s.text)));
  check('链接正文命中进入上下文', !!(r.flags && r.flags.raws), r.answer || r.error);
  check('ai:refs 上报链接引用', !!(r.refs && r.refs.raws && r.refs.raws.some((x) => /山东高速云上迁移方案/.test(x.name))), JSON.stringify(r.refs));
  // 链接读取失败可见性：指向已关闭端口 → 读取失败 → ⚠️ 步骤
  await raws.addUrl(settings, 'http://127.0.0.1:9/none', '死链测试');
  r = await ask(base({ sources: { notes: false, graph: false, raws: true } }));
  check('链接读取失败步骤下发（⚠️）', r.steps.some((s) => /⚠️ 链接「死链测试」正文读取失败/.test(s.text || '')), JSON.stringify(r.steps.map((s) => s.text).filter((t) => /⚠️|链接/.test(t || ''))));
  linkServer.close();

  console.log('\n【11】提取缓存：富文本提取结果落盘复用；文件变化失效');
  const filesMod = require('../src/main/raws/files');
  const JSZip = require('jszip');
  const mkDocx = async (txt) => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${txt}</w:t></w:r></w:p></w:body></w:document>`);
    return zip.generateAsync({ type: 'nodebuffer' });
  };
  const docxPath = path.join(rawDir, 'cache-probe.docx');
  fs.writeFileSync(docxPath, await mkDocx('山东高速缓存验证正文内容'));
  const t1 = await filesMod.readRawTextForScan(settings, 'raw/cache-probe.docx', 512 * 1024);
  check('首次提取返回正文', /山东高速缓存验证/.test(t1 || ''), t1 || 'empty');
  const cacheDir = path.join(root, 'extract-cache');
  const cacheFiles = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : [];
  check('提取结果写入磁盘缓存', cacheFiles.length > 0, JSON.stringify(cacheFiles));
  await filesMod.extractFileContent(docxPath, settings);
  check('二次读取命中缓存（parseMethod=cache）', filesMod.extractFileContent.lastParseMethod === 'cache', filesMod.extractFileContent.lastParseMethod);
  await new Promise((r2) => setTimeout(r2, 30)); // 保证 mtime 差异
  fs.writeFileSync(docxPath, await mkDocx('缓存失效后的新内容'));
  const t2 = await filesMod.readRawTextForScan(settings, 'raw/cache-probe.docx', 512 * 1024);
  check('文件变化后缓存失效重提取', /缓存失效后的新内容/.test(t2 || ''), t2 || 'empty');

  llm.server.close();
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试运行异常:', e);
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});
