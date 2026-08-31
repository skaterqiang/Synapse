// IPC 注册中心：全部 ipcMain.handle 统一在此登记，业务逻辑委托各领域模块
// 模块布局：common/（存储/LLM/作业） raws/（原始文件） graph/（图谱/模版） notes/
const { ipcMain, dialog, app } = require('electron');
const store = require('./notes/store');
const db = require('./common/db');
const paths = require('./common/paths');
const path = require('path');
const fs = require('fs');
const llm = require('./ai/llm');
const mcpMod = require('./mcp/mcp');
const skillsMod = require('./skills/skills');
const mcpClient = mcpMod.mcpClient;
const graph = require('./graph/graph');
const templates = require('./graph/templates');
const raws = require('./raws/raws');
const { rawsRoot } = require('./raws/root');
const prompts = require('./ai/prompts');
const knowledge = require('./knowledge/knowledge');
const notes = require('./notes/notes');
const { FILE_EXTENSIONS, readRawText, extractFileContent, canImportAsNote, noteImportExts, runMineruTest, installMineru, applyMineruModel, titleFromFileName, attachMineruImages } = require('./raws/files');
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
    const settings = payload.settings || {};
    const lastUser = messages.slice().reverse().find((m) => m.role === 'user');
    const question = lastUser ? String(lastUser.content || '') : '';
    const sendStep = (st) => { try { event.sender.send('ai:step', st); } catch (_) { /* 窗口已关闭 */ } };

    // 数据源：渲染层显式传「本次勾选了哪些源」（payload.sources），检索/引用全部交给 knowledge 层。
    // 兼容旧调用方：未传 sources 而传了 useGraph 时，仅开启图谱源；两者都无 → 不检索（与新渲染层默认全关一致）
    let enabled = null;
    if (payload.sources && typeof payload.sources === 'object') {
      enabled = {};
      for (const s of knowledge.listSources()) enabled[s.key] = payload.sources[s.key] === true;
    } else if (payload.useGraph !== undefined) {
      // retrieve 的 on() 语义：缺省键视为开启，故必须显式写全所有源，否则会把未勾选的源误开
      enabled = {};
      for (const s of knowledge.listSources()) enabled[s.key] = s.key === 'graph' && payload.useGraph !== false;
    }
    let knowledgeText = '';
    if (enabled && lastUser && Object.values(enabled).some(Boolean)) {
      try {
        // graphProfile：知识图谱源的体系范围（'all' 或具体体系 id），由渲染层知识源条的子选择传入
        // graphScope：二级范围（具体知识图谱，'profile|domain' 多选逗号分隔），优先于 graphProfile
        const know = await knowledge.retrieve({ settings, question, enabled, onStep: sendStep, graphProfile: payload.graphProfile, graphScope: payload.graphScope });
        knowledgeText = know.text || '';
        // 引用归一后一次上报（渲染层据此渲染 笔记/图谱/原始文件 引用徽标）
        try {
          event.sender.send('ai:refs', {
            graph: know.cites.graph || [],
            notes: know.cites.notes || [],
            raws: know.cites.raws || [],
          });
        } catch (_) { /* 窗口已关闭 */ }
      } catch (err) {
        sendStep({ kind: 'thought', text: `知识检索失败：${err.message}，本轮将不带知识上下文回答` });
      }
    }

    // 提示词管理：用户自定义问答系统提示词（留空不注入）
    const customSys = prompts.getPrompt(settings, 'aiAskPrompt');
    // 技能 / MCP 使用说明：由渲染层按本次生效能力计算（含「与问题格式直接匹配」的强制提示）
    const extHint = typeof payload.extHint === 'string' ? payload.extHint.trim() : '';

    // MCP 工具：逐服务器上报装载进度与失败（此前 buildMcpTools 静默吞掉失败，
    // 用户看不到勾选的 MCP 为何没被调用）
    const { cfgs: mcpCfgs } = mcpMod.resolveMcpCfgs(payload);
    const tools = [];
    if (mcpCfgs.length) sendStep({ kind: 'thought', text: `正在装载 ${mcpCfgs.length} 个 MCP 服务器的工具…` });
    for (const cfg of mcpCfgs) {
      try {
        const ts = await mcpMod.listToolsCached(cfg, settings);
        tools.push(...ts);
        sendStep({ kind: 'thought', text: `✓ ${cfg.name}：已装载 ${ts.length} 个工具` });
      } catch (e) {
        sendStep({ kind: 'thought', text: `❌ ${cfg.name || cfg.url} 工具装载失败：${e.message}` });
      }
    }

    const sysMsgs = [
      ...(customSys ? [{ role: 'system', content: customSys }] : []),
      ...(knowledgeText ? [{ role: 'system', content: knowledgeText }] : []),
      ...(extHint ? [{ role: 'system', content: extHint }] : []),
      { role: 'system', content: llm.ASK_PROTOCOL },
    ];
    // 可执行技能（docx/pptx/xlsx）：渲染层传来本次生效技能名单时按它门控（尊重逐题去除），
    // 否则（旧调用方）回退按 settings 判断
    const runner = require('./skills/runner');
    const skillNames = Array.isArray(payload.skillNames) ? payload.skillNames : null;
    const execTool = skillNames
      ? (skillNames.some((n) => /docx|pptx|xlsx/i.test(String(n || ''))) ? runner.execToolDef() : null)
      : runner.execToolIfActive(settings);
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

  ipcMain.handle('raw:pickFiles', async () => {
    const res = await dialog.showOpenDialog(getWindow(), {
      title: '选择要附加的文件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '常见文档', extensions: FILE_EXTENSIONS }, { name: '所有文件', extensions: ['*'] }],
    });
    return res.canceled ? { ok: true, paths: [] } : { ok: true, paths: res.filePaths };
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

  ipcMain.handle('tpl:matchPrompt', () => templates.matchPrompt());

  // 返回指定 profile 的类树 + 谓词集（供模版编辑器复选框渲染），避免前端自行合成本体
  ipcMain.handle('tpl:profileTree', (_e, profileId) => {
    try {
      const onto = graph.resolveOntology(profileId || 'bfo-lite');
      return { ok: true, profileId: onto.id, profileName: onto.name, classes: onto.classes, predicates: onto.predicates, fallbackType: onto.fallbackType };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

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
  // 预匹配只为选模版，不能挡住作业提交：LLM 判定限时（timeoutMs，默认 25 秒）且不重试，超时/失败即按关键词兜底返回
  ipcMain.handle('tpl:matchFor', async (_e, { settings, rawPaths, texts, timeoutMs }) => {
    try {
      const raws = await buildMatchRaws(settings, rawPaths, texts);
      if (!raws.length) return { ok: true, matched: null, hasSpecific: templates.listTemplates().some((x) => x.id !== 'general'), noText: true };
      const budget = num({ n: timeoutMs }, 'n', 25000, 3000, 120000);
      // 流式增量（含思考过程）实时推给渲染层，弹窗逐步打印判定思路
      const onDelta = (delta, isReasoning) => { try { _e.sender.send('tpl:match-chunk', { text: delta, reasoning: !!isReasoning }); } catch (_) { /* 窗口已关闭 */ } };
      return { ok: true, ...(await templates.preMatchTemplate(settings, raws, { timeoutMs: budget, retries: 0, onDelta })) };
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

  // 提取前按来源内容实时匹配最合适的本体体系（不读模版绑定）：从内置三体系+导入 OWL 中选最贴合者，返回 {id,name,similarity,reason}
  // 设置无全局默认体系时也走这里：只要来源有文本，就从体系列表中智能匹配，不再依赖模版绑定或全局默认
  ipcMain.handle('tpl:suggestProfile', async (_e, { settings, rawPaths, texts, timeoutMs }) => {
    try {
      const raws = await buildMatchRaws(settings, rawPaths, texts);
      if (!raws.length) return { ok: false, error: '来源内容为空，无法匹配体系' };
      // 流式增量（含思考过程）实时推给渲染层，弹窗逐步打印体系匹配思路
      const onDelta = (delta, isReasoning) => { try { _e.sender.send('tpl:suggest-profile-chunk', { text: delta, reasoning: !!isReasoning }); } catch (_) { /* 窗口已关闭 */ } };
      return { ok: true, ...(await templates.suggestOntologyProfile(settings, raws, onDelta)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 提示词注册表：供「提示词管理」页动态渲染全部可配置提示词
  ipcMain.handle('prompts:defs', () => prompts.PROMPT_DEFS);

  // 知识源清单：前端据此渲染知识源开关，新接入的源无需改前端代码即自动出现
  ipcMain.handle('knowledge:sources', () => knowledge.listSources());

  // 知识检索（统一入口）：任何需要知识上下文的功能都走这里，不要自己拼接各源
  ipcMain.handle('knowledge:retrieve', async (_e, { settings, question, sources, graphScope, graphProfile } = {}) => {
    try {
      return { ok: true, ...(await knowledge.retrieve({ settings, question, enabled: sources, graphScope, graphProfile })) };
    } catch (err) {
      return { ok: false, error: err.message, text: '', cites: {} };
    }
  });

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

  // 原始文件直接生成笔记，保留本机引用的目录层级
  ipcMain.handle('raw:extractNote', async (_e, { settings, relPath } = {}) => {
    settings = settings || {};
    try {
      const key = String(relPath || '');
      const record = raws.listRaws(settings).find((r) => r.path === key);
      if (!record) return { ok: false, error: '原始来源不存在' };
      // 类型白名单（设置→笔记导入文件类型）：单文件入口与作业保持同一口径
      if (!canImportAsNote(settings, record.name)) {
        return { ok: false, error: `${path.extname(record.name) || '无扩展名'} 不在笔记导入类型内（当前：${[...noteImportExts(settings)].join('、')}），可在设置里调整` };
      }
      const abs = key.startsWith('local:') ? key.slice('local:'.length) : path.join(rawsRoot(settings), key.replace(/^\//, ''));
      const info = {}; // extractFileContent 经此交还本次 MinerU 转换暂存的图片目录
      // noCache：与提取笔记作业同口径，每次重新生成，不读提取缓存
      const text = await extractFileContent(abs, settings, { info, noCache: true });
      // 目录层级与作业版保持一致（根目录名 + 子目录），key 作为 source 供重复提取时原地更新；
      // 单文件引用（无 root/rel）用文件所在父目录名作笔记目录，避免落入垃圾桶
      const rootName = record.root
        ? path.basename(String(record.root).replace(/[\\/]+$/, ''))
        : (key.startsWith('local:') ? path.basename(path.dirname(key.slice('local:'.length))) : '');
      const childDir = record.root && record.rel ? path.dirname(record.rel) : '';
      const folderRel = [rootName, childDir].filter((v) => v && v !== '.').join(path.sep);
      // 标题解码 URL 编码文件名（与作业版一致）；MinerU 图片并入笔记附件目录
      const note = store.importNote(titleFromFileName(record.name), text, folderRel, key);
      attachMineruImages(note.path, info.imagesDir);
      return { ok: true, note };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // MinerU 一键安装：无环境时在 <安装目录>/plugins/mineru/ 下建 venv、装 mineru、生成包装脚本；
  // 中间日志经 event 以 mineru:install-log 流式推送，前端复用测试日志展示组件
  ipcMain.handle('mineru:install', async (event, payload = {}) => {
    try {
      return await installMineru(payload.settings || {}, { event });
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // MinerU 应用模型：把「模型配置」里选定的模型（名称/端点/Key）写入包装脚本（不动 venv）
  ipcMain.handle('mineru:apply-model', async (event, payload = {}) => {
    try {
      return applyMineruModel(payload.settings || {}, payload.entry || {}, { event });
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // MinerU 配置测试：用内置样本或上传的 PDF 实跑一次转换，验证命令、依赖与模型链路；
  // 中间解析日志经 event 以 mineru:test-log 流式推送，产物保留在 <数据根>/test/<时间戳>/
  ipcMain.handle('mineru:test', async (event, payload = {}) => {
    try {
      // 以表单当前值为准（未保存也可测试），回退已保存设置
      const settings = Object.assign({}, payload.settings || {}, payload.overrides || {});
      return await runMineruTest(settings, { pdfBase64: payload.pdfBase64, fileName: payload.fileName, event });
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 问答附件：抽取指定文件的文本供本次提问使用（不写入 raw/，不进知识库）
  ipcMain.handle('ai:readAttachments', async (_e, { settings, paths, maxCharsPer } = {}) => {
    settings = settings || {};
    const cap = num({ n: maxCharsPer }, 'n', 20000, 500, 200000);
    const out = [];
    for (const p of (paths || []).slice(0, 10)) {
      const abs = path.resolve(String(p || ''));
      try {
        const st = fs.statSync(abs);
        if (!st.isFile()) { out.push({ path: abs, name: path.basename(abs), error: '不是文件' }); continue; }
        const text = await extractFileContent(abs, settings);
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

  // 使用手册（项目 docs/ 目录 Markdown）：应用内查看，仅限 docs 目录内文件，防路径穿越
  ipcMain.handle('docs:read', (_e, { file } = {}) => {
    try {
      const docsRoot = path.join(__dirname, '..', '..', 'docs');
      const name = path.basename(String(file || ''));
      if (!name || !/\.md$/.test(name)) return { ok: false, error: '无效文档' };
      const abs = path.join(docsRoot, name);
      if (!fs.existsSync(abs)) return { ok: false, error: '文档不存在：' + name };
      return { ok: true, text: fs.readFileSync(abs, 'utf-8'), root: docsRoot };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // 选择目录（skill 文件包/原始文件目录等）
  ipcMain.handle('dialog:pickDir', async () => {
    const res = await dialog.showOpenDialog(getWindow(), { title: '选择目录', properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, path: res.filePaths[0] };
  });

  // 读取 skill 文件包：解析目录下 SKILL.md 的 frontmatter（name/description）与正文（instructions）
  ipcMain.handle('skill:read', (_e, { dir }) => skillsMod.readSkill(dir));

  // 在线安装技能：兼容 npx skills add / skills.sh / GitHub 仓库链接；日志经 skill:install-log 推送
  ipcMain.handle('skill:install', async (event, payload) => require('./skills/skillInstall').installSkill(event, payload || {}));

  // 改写链接展示名：需登录的页面（语雀/飞书等）服务端只能拿到占位标题，留手改入口
  ipcMain.handle('raw:renameUrl', (_e, { settings, url, title }) => {
    try {
      return { ok: true, ...raws.renameUrl(settings, url, title) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 添加链接为原始来源：只保存链接信息（不下载正文/不转存 md），但会取一次网页标题做展示名
  // credentials 可选 { username, password }：需登录站点弹出登录窗时自动填充，登录态（Cookie）会被持久化保留
  ipcMain.handle('raw:addUrl', async (_e, { settings, url, title, credentials }) => {
    try {
      return { ok: true, ...(await raws.addUrl(settings, url, title, credentials)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  
  // 查看原始来源：local:/raw 用本机默认软件打开（shell.openPath），url: 用浏览器打开；网页模式不支持
  ipcMain.handle('raw:open', async (_e, { settings, relPath }) => {
    const { shell } = require('electron');
    if (!shell) return { ok: false, error: '当前环境不支持打开本地文件' };
    if (String(relPath).startsWith('url:')) {
      const err = await shell.openExternal(String(relPath).slice('url:'.length));
      return err ? { ok: false, error: err } : { ok: true };
    }
    const abs = String(relPath).startsWith('local:')
      ? String(relPath).slice('local:'.length)
      : path.join(rawsRoot(settings), String(relPath).replace(/^\//, ''));
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

  // 作业实时解析日志（ MinerU 子进程输出等）：页面刷新/新连接时拉取内存缓存补渲染
  ipcMain.handle('jobs:logs', (_e, { id } = {}) => jobs.getJobLogs(id));

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

  ipcMain.handle('jobs:cancel', (_e, id) => jobs.cancel(id));

  // ---------- 知识图谱 ----------
  ipcMain.handle('graph:get', () => graph.getGraph());
  ipcMain.handle('graph:clear', () => graph.clearGraph());
  ipcMain.handle('graph:ontology', (_e, profileId) => graph.getOntology(profileId));
  ipcMain.handle('graph:profiles', () => graph.listProfiles());
  // 二级范围：列出有抽取节点的具体知识图谱分组（体系→图谱），供问答范围二级选择
  ipcMain.handle('graph:scopes', () => graph.listGraphScopes());
  // OWL 导入（Electron：dialog 选文件；web：通过上传接口走后由 body.filePath 传入）
  ipcMain.handle('graph:importOwl', async (e, body) => {
    try {
      let filePath = body && body.filePath;
      if (!filePath) {
        const { dialog, BrowserWindow } = require('electron');
        // Web shim 无 BrowserWindow.fromWebContents：dialog 可选 parent，取不到即 null（桌面版正常取主窗口）
        let win = null;
        try { win = (BrowserWindow && BrowserWindow.fromWebContents) ? BrowserWindow.fromWebContents(e.sender) : null; } catch (_) { win = null; }
        const r = await dialog.showOpenDialog(win, {
          title: '导入 OWL 本体文件',
          filters: [{ name: 'OWL 本体', extensions: ['owl', 'rdf', 'ttl', 'xml'] }],
          properties: ['openFile'],
        });
        if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
        filePath = r.filePaths[0];
      }
      const result = graph.importOwl(filePath, body && body.fileName ? { displayName: body.fileName } : undefined);
      return { ok: true, profile: result.profile, report: result.report };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('graph:removeOwlProfile', (_e, { profileId, clearGraphNodes }) => {
    try {
      return graph.removeOwlProfile(profileId, !!clearGraphNodes);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('onto:setProfile', (_e, profileId) => {
    try {
      return { ok: true, ontology: graph.setOntologyProfile(profileId) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  // 节点来源标签 → 可打开目标（笔记/原始文件），供详情面板点击跳转
  ipcMain.handle('graph:resolveSources', (_e, { settings, labels }) => {
    try {
      return { ok: true, items: graph.resolveSources(settings, labels) };
    } catch (err) {
      return { ok: false, error: err.message, items: [] };
    }
  });

  ipcMain.handle('onto:save', (_e, { kind, item, profileId }) => {
    try {
      return { ok: true, ontology: graph.saveOntologyItem(kind, item, profileId) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('onto:remove', (_e, { kind, key, profileId }) => {
    try {
      return { ok: true, ontology: graph.removeOntologyItem(kind, key, profileId) };
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

  ipcMain.handle('note:aiAssist', (event, payload) => notes.aiAssist(event, payload));
  ipcMain.handle('note:aiAssistStop', () => notes.aiAssistStop());

  // ---------- 笔记历史版本（AI 改动前/后自动保存） ----------
  ipcMain.handle('note:saveVersion', (_e, payload) => notes.saveVersion(payload));
  ipcMain.handle('note:listVersions', (_e, payload) => notes.listVersions(payload));
  ipcMain.handle('note:getVersion', (_e, payload) => notes.getVersion(payload));
  ipcMain.handle('note:deleteVersions', (_e, payload) => notes.deleteVersions(payload && payload.noteId));
}

module.exports = { registerIpc };
