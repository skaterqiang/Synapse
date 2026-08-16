// 应用入口：仅负责生命周期、窗口创建与模块装配
// 业务逻辑按模块分文件夹组织在 src/main/ 下：
//   common/  db 存储 · store 存取 · llm 请求 · jobs 作业 · config 参数
//   wiki/    wiki 领域 · files 解析 · ingest 编排 · raws 原始文件 · templates 领域模版
//   graph/   知识图谱        notes/  笔记附件/扫描/导出
const { app, BrowserWindow, protocol, net, Menu, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const db = require('./src/main/common/db');
const paths = require('./src/main/common/paths');
const { registerIpc } = require('./src/main/ipc');
const jobs = require('./src/main/jobs/jobs');
const wiki = require('./src/main/wiki/wiki');
const raws = require('./src/main/wiki/raws');
const settingsMod = require('./src/main/common/settings');

// 产品改名为 Synapse 后，userData 仍固定旧目录，避免已有 knowledge.db 等数据失联
// 注：须在 app ready 后调用，过早调用会导致主进程静默崩溃

let mainWindow = null;
const getWindow = () => mainWindow;

// 应用菜单：保留系统标准菜单，Help 菜单提供项目仓库链接
const REPO_URL = 'https://github.com/skaterqiang/Synapse';
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'GitHub 仓库（Synapse）',
          click: () => shell.openExternal(REPO_URL),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

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
  // 统一数据根目录（默认 <安装目录>/data，可配置）：首启自动迁移旧 appData 数据
  paths.ensureUnifiedRoot();
  // 本地图片资源协议：Markdown 以 kb-asset://file<绝对路径> 引用附件图片，仅限笔记目录与旧 assets 目录
  const assetsRoot = paths.assetsDir();
  const legacyAssets = path.join(paths.legacyUserData(), 'assets');
  const noteRoot = require('./src/main/notes/store').notesRoot();
  protocol.handle('kb-asset', (request) => {
    const p = path.resolve(decodeURIComponent(new URL(request.url).pathname));
    const allowed = p.startsWith(assetsRoot + path.sep) || p.startsWith(legacyAssets + path.sep) || p.startsWith(noteRoot + path.sep);
    if (!allowed) {
      return new Response('forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(p).toString());
  });
  await db.init();
  wiki.unifyWikiRootToData(); // llmwiki 归一到 data/ 下（未自定义 wikiRoot 时）
  wiki.ensureDefaultWiki();
  wiki.migrateWikiToDomainDirs(); // 存量 Wiki 页迁移到 wiki/<领域>/<类型>/ 结构
  raws.migrateAutoRaws(settingsMod.getSettings()); // 存量自动生成 raw 移入 raw/_auto/，原始文件只管本机添加
  raws.migrateFileRefsToDirs(); // 存量按目录添加的单文件引用升级为目录引用（实时遍历）
  jobs.init(getWindow);
  jobs.loadJobs();
  registerIpc(getWindow);
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
