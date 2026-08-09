// IPC 注册中心：全部 ipcMain.handle 统一在此登记，业务逻辑委托各领域模块
const { ipcMain, dialog } = require('electron');
const fs = require('fs');
const store = require('./store');
const db = require('./db');
const llm = require('./llm');
const wiki = require('./wiki');
const { FILE_EXTENSIONS } = require('./files');
const jobs = require('./jobs');

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

  ipcMain.handle('app:getDataPath', () => store.getDataFile());

  // 切换 SQLite 数据文件位置（整库迁移，留空恢复默认）
  ipcMain.handle('data:setDbPath', (_e, p) => db.setDbPath(p));

  ipcMain.handle('dialog:export', async (_event, { defaultName, content }) => {
    const result = await dialog.showSaveDialog(getWindow(), {
      defaultPath: defaultName || 'note.md',
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: '文本文件', extensions: ['txt'] },
      ],
    });
    if (!result.canceled && result.filePath) {
      fs.writeFileSync(result.filePath, content, 'utf-8');
      return { ok: true, path: result.filePath };
    }
    return { ok: false };
  });

  // ---------- AI 问答（流式） ----------
  ipcMain.handle('ai:ask', (event, payload) => llm.streamChat(event, payload.settings, payload.messages));

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
}

module.exports = { registerIpc };
