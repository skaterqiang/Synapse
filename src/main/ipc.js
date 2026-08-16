// IPC 注册中心：全部 ipcMain.handle 统一在此登记，业务逻辑委托各领域模块
// 模块布局：common/（存储/LLM/作业） wiki/（Wiki/吸收/原始文件/模版） graph/ notes/
const { ipcMain, dialog } = require('electron');
const store = require('./notes/store');
const db = require('./common/db');
const paths = require('./common/paths');
const path = require('path');
const fs = require('fs');
const llm = require('./common/llm');
const wiki = require('./wiki/wiki');
const graph = require('./graph/graph');
const templates = require('./wiki/templates');
const raws = require('./wiki/raws');
const prompts = require('./common/prompts');
const notes = require('./notes/notes');
const { FILE_EXTENSIONS, readRawText } = require('./wiki/files');
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
  ipcMain.handle('ai:ask', (event, payload) => {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const useGraph = payload.useGraph !== false;
    const lastUser = messages.slice().reverse().find((m) => m.role === 'user');
    const ctx = useGraph && lastUser ? graph.contextFor(lastUser.content) : '';
    // 提示词管理：用户自定义问答系统提示词（留空不注入）
    const customSys = prompts.getPrompt(payload.settings, 'aiAskPrompt');
    const sysMsgs = [
      ...(customSys ? [{ role: 'system', content: customSys }] : []),
      ...(ctx ? [{ role: 'system', content: ctx }] : []),
    ];
    return llm.streamChat(event, payload.settings, [...sysMsgs, ...messages]);
  });

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
      return { ok: true, template: await templates.generateTemplate(settings, { name, desc }) };
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
  ipcMain.handle('raw:list', (_e, settings) => raws.listRaws(settings));

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
        // 根级：枚举可用盘符
        const dirs = [];
        for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
          const d = letter + ':\\';
          try { if (fs.existsSync(d)) dirs.push({ name: d, path: d }); } catch (_) {}
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
