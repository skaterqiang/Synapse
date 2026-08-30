// 应用入口：仅负责生命周期、窗口创建与模块装配
// 业务逻辑按模块分文件夹组织在 src/main/ 下：
//   common/  db 存储 · store 存取 · llm 请求 · jobs 作业 · config 参数
//   raws/    原始文件管理（root 根目录 · files 解析 · raws 列表 · weblogin 登录态）
//   graph/   知识图谱 · templates 领域模版        notes/  笔记附件/扫描/导出
const { app, BrowserWindow, protocol, net, Menu, shell, session } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const db = require('./src/main/common/db');
const paths = require('./src/main/common/paths');
const { registerIpc } = require('./src/main/ipc');
const jobs = require('./src/main/jobs/jobs');
const raws = require('./src/main/raws/raws');
const settingsMod = require('./src/main/common/settings');
const mcpMod = require('./src/main/mcp/mcp');
const skillsMod = require('./src/main/skills/skills');

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

async function createWindow() {
  // 启动即清空渲染层资源缓存：渲染代码经 file:// 加载同样会进 Chromium 磁盘缓存，
  // 不清缓存会导致前端更新后重启 App 仍跑旧代码（如手册链接点击空白等已修复问题复现）
  try { await session.defaultSession.clearCache(); } catch (_) { /* 忽略缓存清理失败 */ }
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
      // preload 需 require 本地模块（defaults.js 单一默认值配置源），沙箱模式下 require 仅限白名单内置模块
      sandbox: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  // Electron 44：console-message 旧多参签名已弃用，改用 Event 对象（event.message）
  mainWindow.webContents.on('console-message', (event) => {
    console.log('[renderer]', event.message);
  });
  // 兜底安全网：渲染层任何直接导航（旧前端未拦截的链接、相对资源路径等）一律阻止，
  // 避免 file:// 找不到文件出现整页空白；docs 资源用系统默认软件打开，外链走系统浏览器
  mainWindow.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    try {
      const u = new URL(url);
      if (u.protocol === 'file:') {
        const p = decodeURIComponent(u.pathname);
        const docsRoot = path.join(__dirname, 'docs');
        if (p.startsWith(docsRoot + path.sep)) require('electron').shell.openPath(p);
        return; // 其余本地路径：留在当前页，不导航
      }
      if (/^https?:$/.test(u.protocol)) require('electron').shell.openExternal(url);
    } catch (_) { /* 非法 URL：仅阻止导航 */ }
  });
  if (process.argv.includes('--kb-debug')) mainWindow.webContents.openDevTools({ mode: 'detach' });
  // 版本 query 使 index.html 自身绕开 file:// 缓存（内部脚本引用另带各自版本号）
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'), { query: { v: '20260830b' } });
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
    // 兼容两种历史/现行格式：
    //  新格式 kb-asset://fileD:/<encodeURI 路径>（盘符后带 /，host=fileD，new URL 可解析）
    //  旧格式 kb-asset://fileD:%5C<encodeURI 路径>（盘符后无 /，host 并入路径导致 new URL 抛 Invalid URL）
    let p = null;
    try {
      let pathname = decodeURIComponent(new URL(request.url).pathname);
      // Windows 盘符前导斜杠：/D:/x → D:/x，否则 path.resolve 出 D:\D:\x
      if (/^\/[A-Za-z]:[\/]/.test(pathname)) pathname = pathname.slice(1);
      p = path.resolve(pathname);
    } catch (_) {
      // 旧格式：new URL 解析失败，直接从原始串剥掉 'kb-asset://file' 前缀后解码还原
      const raw = request.url.replace(/^kb-asset:\/\/file/i, '');
      try { p = path.resolve(decodeURIComponent(raw)); } catch (_) { p = null; }
    }
    if (!p) return new Response('bad request', { status: 400 });
    const allowed = p.startsWith(assetsRoot + path.sep) || p.startsWith(legacyAssets + path.sep) || p.startsWith(noteRoot + path.sep);
    if (!allowed) {
      return new Response('forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(p).toString());
  });
  // 使用手册内嵌图片协议：仅限项目 docs/ 目录，防路径穿越
  const docsRoot = path.join(__dirname, 'docs');
  protocol.handle('kb-doc', (request) => {
    const p = path.resolve(decodeURIComponent(new URL(request.url).pathname));
    if (!p.startsWith(docsRoot + path.sep)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(p).toString());
  });
  await db.init();
  // 把持久化的链接登录态（Cookie）回填 defaultSession：隐藏窗渲染/抓取即可直接带登录态
  require('./src/main/raws/urlcookies').restoreToSession(session.defaultSession).catch(() => {});
  raws.migrateAutoRaws(settingsMod.getSettings()); // 存量自动生成 raw 移入 raw/_auto/，原始文件只管本机添加
  raws.migrateFileRefsToDirs(); // 存量按目录添加的单文件引用升级为目录引用（实时遍历）
  mcpMod.seedWebSearchMcp(); // 一次性植入阿里云百炼 WebSearch MCP（API Key 复用模型配置）
  skillsMod.seedSampleSkills(settingsMod); // 一次性植入示例 skill 文件包（目录引用）
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
