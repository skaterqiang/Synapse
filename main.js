// 应用入口：仅负责生命周期、窗口创建与模块装配
// 业务逻辑按职责拆分在 src/main/ 下：
//   db.js     SQLite 存储层       store.js  笔记/目录/设置存取
//   llm.js    LLM 请求层          wiki.js   Wiki 领域层
//   files.js  文件解析            ingest.js Ingest 编排
//   jobs.js   作业管理            ipc.js    IPC 注册中心
const { app, BrowserWindow } = require('electron');
const path = require('path');
const db = require('./src/main/db');
const { registerIpc } = require('./src/main/ipc');
const jobs = require('./src/main/jobs');

// 产品改名为 Synapse 后，userData 仍固定旧目录，避免已有 knowledge.db 等数据失联
// 注：须在 app ready 后调用，过早调用会导致主进程静默崩溃

let mainWindow = null;
const getWindow = () => mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'Synapse',
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.on('console-message', (_e, _level, message) => {
    console.log('[renderer]', message);
  });
  if (process.argv.includes('--kb-debug')) mainWindow.webContents.openDevTools({ mode: 'detach' });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(async () => {
  app.setPath('userData', path.join(app.getPath('appData'), '个人知识库助手'));
  await db.init();
  jobs.init(getWindow);
  jobs.loadJobs();
  registerIpc(getWindow);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
