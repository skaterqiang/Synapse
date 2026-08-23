// IPC 注册中心：全部 ipcMain.handle 统一在此登记，业务逻辑委托各领域模块
// 模块布局：common/（存储/LLM/作业） wiki/（Wiki/吸收/原始文件/模版） graph/ notes/
const { ipcMain, dialog } = require('electron');
const store = require('./notes/store');
const db = require('./common/db');
const paths = require('./common/paths');
const path = require('path');
const fs = require('fs');
const llm = require('./ai/llm');
const mcpMod = require('./mcp/mcp');
const skillsMod = require('./skills/skills');
const mcpClient = mcpMod.mcpClient;
const wiki = require('./wiki/wiki');
const graph = require('./graph/graph');
const templates = require('./wiki/templates');
const raws = require('./wiki/raws');
const prompts = require('./ai/prompts');
const notes = require('./notes/notes');
const { FILE_EXTENSIONS, readRawText, extractFileContent } = require('./wiki/files');
const { num } = require('./common/config');
const jobs = require('./jobs/jobs');

// getWindow：对话框与广播需要主窗口引用，由入口注入
function registerIpc(getWindow) {
  // ---------- 数据 ----------
  ipcMain.handle('data:load', () => store.loadStore());

  ipcMain.handle('data:save', (_event, data) => {
    try {
      store.saveStore(data);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('app:getDataPath', () => db.getDbFile());

  // 统一数据根目录：查询与配置（配置重启后生效）
  ipcMain.handle('app:dataRoot', () => paths.dataRoot());

  ipcMain.handle('data:setRoot', (_e, p) => {
    try {
      return { ok: true, root: paths.setDataRoot(p) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 切换 SQLite 数据文件位置（整库迁移，留空恢复默认）
  ipcMain.handle('data:setDbPath', (_e, p) => db.setDbPath(p));

  ipcMain.handle('dialog:export', (_e, opts) => notes.exportNote(getWindow, opts));

  // ---------- AI 问答（流式） ----------
  // 知识图谱非空时，按问题召回本体层上下文注入 system 提示
  // AI 会话历史：存入 SQLite kv，跨会话保留（上下文记忆）
  ipcMain.handle('chat:getHistory', () => {
    try { return JSON.parse(db.getKv('aiHistory') || '[]'); } catch (_) { return []; }
  });
  ipcMain.handle('chat:saveHistory', (_e, list) => {
    db.setKv('aiHistory', JSON.stringify(Array.isArray(list) ? list : []));
    db.flush();
    return { ok: true };
  });
  // 多会话列表（主框架 AI 页左侧历史）
  ipcMain.handle('chat:getSessions', () => {
    try { return JSON.parse(db.getKv('aiSessions') || '[]'); } catch (_) { return []; }
  });
  ipcMain.handle('chat:saveSessions', (_e, list) => {
    db.setKv('aiSessions', JSON.stringify(Array.isArray(list) ? list : []));
    db.flush();
    return { ok: true };
  });

  // 停止当前交互问答（回答中时发送按钮变为“停止”）；中断后经 ai:error 上报恢复界面
  ipcMain.handle('ai:stop', () => {
    llm.stopAi();
    return { ok: true };
  });

  ipcMain.handle('ai:ask', async (event, payload) => {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const useGraph = payload.useGraph !== false;
    const lastUser = messages.slice().reverse().find((m) => m.role === 'user');
    const ctx = useGraph && lastUser ? graph.contextFor(lastUser.content) : '';
    // 提示词管理：用户自定义问答系统提示词（留空不注入）
    const customSys = prompts.getPrompt(payload.settings, 'aiAskPrompt');
    const tools = await mcpMod.buildMcpTools(payload);
    // 已启用的 MCP 默认全部参与（用户可在输入区逐个去除），具体调哪个工具由模型自行判断；
    // 不再无条件强制搜索，否则“你好”这类问题也会白白跑一次搜索
    const sysMsgs = [
      ...(customSys ? [{ role: 'system', content: customSys }] : []),
      ...(ctx ? [{ role: 'system', content: ctx }] : []),
      { role: 'system', content: llm.ASK_PROTOCOL },
    ];
    // 可执行技能（docx/pptx/xlsx）激活时注入脚本执行工具（无 MCP 时也走智能体循环）
    const execTool = require('./skills/runner').execToolIfActive(payload.settings);
    if (execTool) tools.push(execTool);
    // 工具使用策略：有工具时明确告知模型“知识库答不了就去调工具”，
    // 否则模型容易直接回“知识库里没有”而不去搜索
    const toolNames = tools.map((t) => t.function && t.function.name).filter(Boolean);
    const toolPolicy = tools.length ? {
      role: 'system',
      content: '【工具使用策略】本会话已接入外部工具（function calling），可用工具：'
        + toolNames.join('、') + '。\n'
        + '- 当问题涉及实时/最新/事实性信息（产品规格、新闻、价格、天气、地点等），或提供的知识库/笔记内容不足以回答时，'
        + '必须先自行选择并调用合适的工具获取依据，再基于工具结果作答并注明来源。\n'
        + '- 不得仅因“知识库没有”就直接拒答；先尝试工具。多个子问题可分多步多次调用不同工具。\n'
        + '- 未实际调用工具时，不得声称“已搜索/已联网/已查询”；工具返回为空时如实说明。\n'
        + '- 凡有“让我搜索/查询”之类意图，必须立即真实发起工具调用，不得只口头宣告后直接结束回答。',
    } : null;
    const all = [...sysMsgs, ...(toolPolicy ? [toolPolicy] : []), ...messages];
    if (tools.length) return llm.agenticChat(event, payload.settings, all, tools, (t, args) => (t._builtin === 'run' ? require('./skills/runner').runNodeScript(args) : mcpMod.callTool(t._server, payload.settings, t._tool, args)));
    return llm.streamChat(event, payload.settings, all);
  });

  // 列出接口可用模型（供设置页「获取模型」使用，如本地 Ollama）
  ipcMain.handle('ai:listModels', (_e, settings) => llm.listModels(settings || {}));

  // ---------- LLM Wiki ----------
  ipcMain.handle('wiki:defaultRoot', () => wiki.defaultWikiRoot());

  ipcMain.handle('wiki:describe', (_e, settings) => wiki.describeWiki(settings));

  ipcMain.handle('wiki:read', (_e, { settings, relPath }) => {
    try {
      return { ok: true, content: wiki.readPage(settings, relPath) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('wiki:pickFiles', async () => {
    const res = await dialog.showOpenDialog(getWindow(), {
      title: '选择要吸收的文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '常见文档', extensions: FILE_EXTENSIONS },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (res.canceled) return { ok: true, paths: [] };
    return { ok: true, paths: res.filePaths };
  });

  ipcMain.handle('wiki:ask', (event, payload) => wiki.wikiAsk(event, payload));

  ipcMain.handle('wiki:fileAnswer', async (_e, { settings, question, answer }) => {
    try {
      return { ok: true, ...(await wiki.fileAnswer(settings, { question, answer })) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ---------- 领域模版 ----------
  ipcMain.handle('tpl:list', () => templates.listTemplates());

  ipcMain.handle('tpl:save', (_e, tpl) => {
    try {
      return { ok: true, template: templates.saveTemplate(tpl) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('tpl:remove', (_e, id) => {
    try {
      return { ok: true, ...templates.removeTemplate(id) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('tpl:generate', async (_e, { settings, name, desc }) => {
    try {
      // 流式增量经 tpl:gen-chunk 实时推给渲染层，打印生成过程（thinking/正文分开标记）
      const template = await templates.generateTemplate(settings, { name, desc }, (delta, isReasoning) => {
        try { _e.sender.send('tpl:gen-chunk', { text: delta, reasoning: !!isReasoning }); } catch (_) { /* 窗口已关闭 */ }
      });
      return { ok: true, template };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('tpl:suggest', async (_e, { settings }) => {
    try {
      return { ok: true, templates: await templates.suggestTemplates(settings) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('tpl:matchPrompt', () => templates.matchPrompt());

  // 预匹配/自动建模共用：把 rawPaths（raw/… 或 local:…）与 texts（内联文本）读成来源内容列表
  const buildMatchRaws = async (settings, rawPaths, texts) => {
    const raws = [];
    for (const p of rawPaths || []) {
      try {
        const content = await readRawText(settings, String(p));
        if (content) raws.push({ rawPath: String(p), content });
      } catch (_) { /* 单个来源提取失败不阻断 */ }
    }
    for (const t of texts || []) {
      if ((t || '').trim()) raws.push({ rawPath: 'inline-text', content: String(t) });
    }
    return raws;
  };

  // 吸收前的领域预匹配：渲染层提交吸收作业前先问用户“新建领域模版还是用通用”
  ipcMain.handle('tpl:matchFor', async (_e, { settings, rawPaths, texts }) => {
    try {
      const raws = await buildMatchRaws(settings, rawPaths, texts);
      if (!raws.length) return { ok: true, matched: null, hasSpecific: templates.listTemplates().some((x) => x.id !== 'general'), noText: true };
      return { ok: true, ...(await templates.preMatchTemplate(settings, raws)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 未命中后点「确定」：按来源内容归纳领域名称与简述，渲染层自动填入新建模版弹窗并触发 AI 生成
  ipcMain.handle('tpl:suggestName', async (_e, { settings, rawPaths, texts }) => {
    try {
      const raws = await buildMatchRaws(settings, rawPaths, texts);
      if (!raws.length) return { ok: false, error: '来源内容为空，无法归纳领域名称' };
      return { ok: true, ...(await templates.suggestTemplateName(settings, raws)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 提示词注册表：供「提示词管理」页动态渲染全部可配置提示词
  ipcMain.handle('prompts:defs', () => prompts.PROMPT_DEFS);

  // ---------- 原始文件管理 ----------
  // 返回 {list, truncated}：truncated 告知哪些目录引用因超上限只列出了部分文件
  ipcMain.handle('raw:list', (_e, settings) => {
    const list = raws.listRaws(settings);
    return { list, truncated: list.truncated || [], maxDirFiles: raws.dirMaxFiles(settings) };
  });

  // 原始文件关键字检索（grep 式，纯 Node 实现，Windows/macOS 一致），供 AI 问答作知识源
  ipcMain.handle('raw:search', async (_e, { settings, question, topN } = {}) => {
    try {
      return { ok: true, ...(await raws.searchRaws(settings, question, { topN })) };
    } catch (err) {
      return { ok: false, error: err.message, hits: [] };
    }
  });

  // 问答附件：抽取指定文件的文本供本次提问使用（不写入 raw/，不进知识库）
  ipcMain.handle('ai:readAttachments', async (_e, { paths, maxCharsPer } = {}) => {
    const cap = num({ n: maxCharsPer }, 'n', 20000, 500, 200000);
    const out = [];
    for (const p of (paths || []).slice(0, 10)) {
      const abs = path.resolve(String(p || ''));
      try {
        const st = fs.statSync(abs);
        if (!st.isFile()) { out.push({ path: abs, name: path.basename(abs), error: '不是文件' }); continue; }
        const text = await extractFileContent(abs);
        const s = String(text || '');
        out.push({
          path: abs,
          name: path.basename(abs),
          size: st.size,
          chars: s.length,
          truncated: s.length > cap,
          text: s.slice(0, cap),
        });
      } catch (err) {
        // 单个文件失败不影响其他附件
        out.push({ path: abs, name: path.basename(abs), error: err.message });
      }
    }
    return { ok: true, items: out };
  });

  // 测试 MCP 服务器连通性：http/sse 发 initialize 握手；stdio 试启动进程
  ipcMain.handle('mcp:test', (_e, cfg) => mcpMod.testMcp(cfg));

  // 外部链接用系统浏览器打开，避免渲染窗被导航导致白屏
  // 技能脚本执行器：docx/pptx/xlsx 等技能生成真实文件
  const runner = require('./skills/runner');
  ipcMain.handle('skill:run', async (_e, payload) => runner.runNodeScript(payload || {}));
  ipcMain.handle('shell:openPath', async (_e, { path: p } = {}) => {
    try {
      const err = await require('electron').shell.openPath(p);
      return err ? { ok: false, error: err } : { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // 定位到文件所在目录并选中它（Finder / 资源管理器）
  ipcMain.handle('shell:revealPath', async (_e, { path: p } = {}) => {
    try {
      const abs = path.resolve(String(p || ''));
      if (!fs.existsSync(abs)) return { ok: false, error: '文件已不存在：' + abs };
      require('electron').shell.showItemInFolder(abs);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('shell:openExternal', async (_e, url) => {
    try { await require('electron').shell.openExternal(url); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  // 选择目录（skill 文件包/原始文件目录等）
  ipcMain.handle('dialog:pickDir', async () => {
    const res = await dialog.showOpenDialog(getWindow(), { title: '选择目录', properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, path: res.filePaths[0] };
  });

  // 读取 skill 文件包：解析目录下 SKILL.md 的 frontmatter（name/description）与正文（instructions）
  ipcMain.handle('skill:read', (_e, { dir }) => skillsMod.readSkill(dir));

  // 添加链接/文本为原始来源（存 raw/，纳入原始文件管理）
  ipcMain.handle('raw:addSource', async (_e, { settings, url, text, title }) => {
    try {
      const res = await wiki.saveRawSource(settings, { title: title || '', content: text || '', sourceUrl: url || '', auto: false });
      return { ok: true, ...res };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 查看原始文件：用本机默认软件打开（shell.openPath），网页模式不支持
  ipcMain.handle('raw:open', async (_e, { settings, relPath }) => {
    const { shell } = require('electron');
    if (!shell) return { ok: false, error: '当前环境不支持打开本地文件' };
    const abs = String(relPath).startsWith('local:')
      ? String(relPath).slice('local:'.length)
      : path.join(wiki.wikiRoot(settings), String(relPath).replace(/^\//, ''));
    const err = await shell.openPath(abs);
    return err ? { ok: false, error: err } : { ok: true };
  });

  ipcMain.handle('raw:remove', (_e, { settings, relPath }) => {
    try {
      return { ok: true, ...raws.removeRaw(settings, relPath) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('raw:removeDir', (_e, { settings, dir }) => {
    try {
      return { ok: true, ...raws.removeRawDir(settings, dir) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('raw:addFiles', async (_e, { settings, paths }) => {
    try {
      return { ok: true, ...(await raws.addFiles(settings, paths)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('raw:addDir', async (_e, { settings, paths }) => {
    try {
      return { ok: true, ...(await raws.addPaths(settings, paths)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('raw:browse', async (_e, { dir } = {}) => {
    // 自定义目录浏览器：原生文件夹选择器无法列出文件，改由主进程列举目录内容供渲染层展示
    try {
      if (!dir) {
        // 根级：分平台枚举可用盘符/入口
        const dirs = [];
        if (process.platform === 'win32') {
          for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
            const d = letter + ':\\';
            try { if (fs.existsSync(d)) dirs.push({ name: d, path: d }); } catch (_) {}
          }
        } else {
          // macOS / Linux：列出常用入口供快速定位
          const home = require('os').homedir();
          const add = (name, p) => { try { if (fs.existsSync(p)) dirs.push({ name, path: p }); } catch (_) {} };
          add('🏠 个人目录', home);
          add('📄 桌面', path.join(home, 'Desktop'));
          add('📁 文档', path.join(home, 'Documents'));
          add('⬇️ 下载', path.join(home, 'Downloads'));
          add('🖥 根目录 /', '/');
          // macOS 外接卷与网络卷：/Volumes/*（可能不存在）
          if (process.platform === 'darwin') {
            try {
              for (const name of fs.readdirSync('/Volumes')) {
                if (name.startsWith('.')) continue;
                dirs.push({ name: '💾 ' + name, path: '/Volumes/' + name });
              }
            } catch (_) {}
          }
        }
        return { ok: true, dir: '', parent: null, dirs, files: [], supported: FILE_EXTENSIONS };
      }
      const abs = path.resolve(dir);
      const st = fs.statSync(abs);
      if (!st.isDirectory()) return { ok: false, error: '不是目录：' + abs };
      const dirs = [];
      const files = [];
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || raws.SKIP_DIRS.has(entry.name)) continue;
        const p = path.join(abs, entry.name);
        if (entry.isDirectory()) {
          dirs.push({ name: entry.name, path: p });
        } else if (entry.isFile()) {
          let fst;
          try { fst = fs.statSync(p); } catch (_) { continue; }
          files.push({ name: entry.name, path: p, ext: path.extname(entry.name).slice(1).toLowerCase(), size: fst.size, mtime: fst.mtimeMs });
        }
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      files.sort((a, b) => b.mtime - a.mtime);
      const parent = path.dirname(abs) === abs ? null : path.dirname(abs);
      return { ok: true, dir: abs, parent, dirs, files, supported: FILE_EXTENSIONS };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ---------- 作业管理 ----------
  ipcMain.handle('jobs:list', () => jobs.list());

  ipcMain.handle('jobs:submit', (_e, payload) => {
    try {
      return jobs.submit(payload);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('jobs:remove', (_e, id) => jobs.remove(id));

  ipcMain.handle('jobs:clear', () => jobs.clear());

  ipcMain.handle('jobs:retry', (_e, payload) => {
    try {
      return jobs.retry(payload);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ---------- 知识图谱 ----------
  ipcMain.handle('graph:get', () => graph.getGraph());
  ipcMain.handle('graph:clear', () => graph.clearGraph());
  ipcMain.handle('graph:ontology', () => graph.getOntology());

  ipcMain.handle('onto:save', (_e, { kind, item }) => {
    try {
      return { ok: true, ontology: graph.saveOntologyItem(kind, item) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('onto:remove', (_e, { kind, key }) => {
    try {
      return { ok: true, ontology: graph.removeOntologyItem(kind, key) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('graph:ask', (event, payload) => graph.kgAsk(event, payload));

  // ---------- 笔记附件与 AI 扫描（委托 notes 模块） ----------
  ipcMain.handle('note:pickImage', (_e, opts) => notes.pickImage(getWindow, opts));

  ipcMain.handle('note:saveImage', (_e, payload) => notes.saveImage(payload));

  ipcMain.handle('note:scan', (_e, payload) => notes.scan(payload));

  ipcMain.handle('note:openFolder', (_e, payload) => notes.openNoteFolder(payload));

  ipcMain.handle('note:aiAssist', (_e, payload) => notes.aiAssist(payload));

  // ---------- 笔记历史版本（AI 改动前/后自动保存） ----------
  ipcMain.handle('note:saveVersion', (_e, payload) => notes.saveVersion(payload));
  ipcMain.handle('note:listVersions', (_e, payload) => notes.listVersions(payload));
  ipcMain.handle('note:getVersion', (_e, payload) => notes.getVersion(payload));
  ipcMain.handle('note:deleteVersions', (_e, payload) => notes.deleteVersions(payload && payload.noteId));
}

module.exports = { registerIpc };
