// Synapse Web 模式：用纯 Node HTTP 服务替代 Electron 外壳，原样复用 src/main 业务模块
// 启动：npm run web  →  浏览器访问 http://localhost:8787
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const PORT = Number(process.env.PORT) || 8787;

// ---------- electron shim：拦截 require('electron')，让业务模块无需改动 ----------
// userData 与桌面端 app.getPath('appData') 在各平台的默认值保持一致，
// 保证 web 模式与桌面模式共用同一份 knowledge.db：
//   win32 → %APPDATA%；darwin → ~/Library/Application Support；linux → ~/.config
function appDataDir() {
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}
const userDataDir = path.join(appDataDir(), '个人知识库助手');
const uploadsDir = path.join(userDataDir, 'uploads');
fs.mkdirSync(userDataDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });

// SSE 客户端集合：主进程广播（ai:chunk / jobs:update 等）统一推到这里
const sseClients = new Set();
function broadcast(channel, data) {
  const frame = `data: ${JSON.stringify({ channel, data })}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch (_) { /* 客户端断开时忽略 */ }
  }
}

// jobs.js 通过 getWindow().webContents.send 广播，注入一个等价壳窗口
const shimWindow = {
  isDestroyed: () => false,
  webContents: { send: (ch, d) => broadcast(ch, d) },
};

// 业务模块推流用的事件对象（llm.js / raws 等模块使用 event.sender.send）
const fakeEvent = { sender: { send: (ch, d) => broadcast(ch, d) } };

const handlers = new Map();
const electronShim = {
  app: {
    isPackaged: false,
    getPath: (name) => {
      if (name === 'userData') return userDataDir;
      if (name === 'appData') return path.dirname(userDataDir);
      if (name === 'documents') return path.join(os.homedir(), 'Documents');
      throw new Error(`Web 模式不支持 app.getPath('${name}')`);
    },
    getAppPath: () => ROOT,
  },
  ipcMain: {
    handle: (channel, fn) => handlers.set(channel, fn),
  },
  dialog: {
    // Web 模式不使用原生对话框：导出由浏览器下载实现（kb-shim 端拦截），选文件由页面上传实现
    showSaveDialog: async () => ({ canceled: true }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
  // 用系统文件管理器打开/定位本地路径（如解析测试后打开产物目录）
  shell: {
    openPath: async (p) => {
      try {
        const { spawn } = require('child_process');
        const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
        const child = spawn(cmd, [String(p)], { detached: true, stdio: 'ignore' });
        child.unref();
        return '';
      } catch (e) { return e.message || String(e); }
    },
    showItemInFolder: async () => undefined,
    openExternal: async () => undefined,
  },
};

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return electronShim;
  return origLoad.call(this, request, ...rest);
};

// ---------- 复用既有业务模块，装配顺序与 main.js 保持一致 ----------
const db = require(path.join(SRC, 'main', 'common', 'db'));
const jobs = require(path.join(SRC, 'main', 'jobs', 'jobs'));
const paths = require(path.join(SRC, 'main', 'common', 'paths'));
const raws = require(path.join(SRC, 'main', 'raws', 'raws'));
const settingsMod = require(path.join(SRC, 'main', 'common', 'settings'));
const mcpMod = require(path.join(SRC, 'main', 'mcp', 'mcp'));
const skillsMod = require(path.join(SRC, 'main', 'skills', 'skills'));
const { registerIpc } = require(path.join(SRC, 'main', 'ipc'));

async function start() {
  paths.ensureUnifiedRoot(); // 与 Electron 入口一致：统一根目录 + 旧数据迁移
  await db.init();
  raws.migrateAutoRaws(settingsMod.getSettings());
  raws.migrateFileRefsToDirs();
  mcpMod.seedWebSearchMcp();
  skillsMod.seedSampleSkills(settingsMod);
  jobs.init(() => shimWindow);
  jobs.loadJobs();
  registerIpc(() => shimWindow);

  const server = http.createServer(handleRequest);
  server.listen(PORT, () => {
    console.log(`Synapse Web 模式已启动: http://localhost:${PORT}`);
  });
}

// ---------- HTTP 路由 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    // SSE 事件流：替代 ipcRenderer.on 的事件广播
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // 通道调用：替代 ipcRenderer.invoke
    if (req.method === 'POST' && url.pathname.startsWith('/api/call/')) {
      const channel = decodeURIComponent(url.pathname.slice('/api/call/'.length));
      const raw = await readBody(req);
      const body = raw.length ? JSON.parse(raw.toString('utf-8')) : undefined;
      // 导出笔记：不走服务端对话框，直接告知前端走浏览器下载
      if (channel === 'dialog:export') {
        return sendJson(res, 200, { result: { ok: true, browserDownload: true } });
      }
      const fn = handlers.get(channel);
      if (!fn) return sendJson(res, 404, { error: `未知通道: ${channel}` });
      const result = await fn(fakeEvent, body);
      return sendJson(res, 200, { result });
    }

    // 本地附件图片：kb-asset 引用的网页模式等价路由，仅限统一根目录 assets（兼容旧目录）
    if (req.method === 'GET' && url.pathname === '/api/asset') {
      const p = path.resolve(url.searchParams.get('path') || '');
      const assetsRoot = paths.assetsDir();
      const legacyAssets = path.join(paths.legacyUserData(), 'assets');
      const noteRoot = require(path.join(SRC, 'main', 'notes', 'store')).notesRoot();
      const allowed = p.startsWith(assetsRoot + path.sep) || p.startsWith(legacyAssets + path.sep) || p.startsWith(noteRoot + path.sep);
      if (!allowed || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
        return sendJson(res, 404, { error: 'Not Found' });
      }
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' }[path.extname(p).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      return res.end(fs.readFileSync(p));
    }

    // 使用手册资源：docs/ 目录静态文件（Markdown 经 docs:read 通道读取，图片/附件走这里）
    if (req.method === 'GET' && url.pathname.startsWith('/docs/')) {
      const docsRoot = path.join(ROOT, 'docs');
      const rel = decodeURIComponent(url.pathname.slice('/docs/'.length));
      const filePath = path.resolve(docsRoot, rel);
      if (!filePath.startsWith(docsRoot + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return sendJson(res, 404, { error: 'Not Found' });
      }
      const mime = { '.md': 'text/markdown; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml' }[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      return res.end(fs.readFileSync(filePath));
    }

    // 文件上传：替代 dialog.showOpenDialog，落盘后把服务端路径交给作业流程
    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const name = path.basename(url.searchParams.get('name') || 'file');
      const buf = await readBody(req);
      const target = path.join(uploadsDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`);
      fs.writeFileSync(target, buf);
      return sendJson(res, 200, { path: target });
    }

    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method Not Allowed' });

    // ---------- 静态资源（src/ 目录） ----------
    let rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    // kb-shim.js 位于 web/ 目录
    if (rel === 'kb-shim.js') {
      const js = fs.readFileSync(path.join(__dirname, 'kb-shim.js'));
      res.writeHead(200, { 'Content-Type': MIME['.js'] });
      return res.end(js);
    }
    const filePath = path.join(SRC, rel);
    if (!filePath.startsWith(SRC) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return sendJson(res, 404, { error: 'Not Found' });
    }
    let content = fs.readFileSync(filePath);
    let mime = MIME[path.extname(filePath)] || 'application/octet-stream';
    // index.html：在首个渲染模块脚本之前注入 Web 桥接脚本
    if (rel === 'index.html') {
      // 正则匹配 common.js 脚本标签（兼容带/不带版本号），在其前注入 Web 桥接脚本
      content = Buffer.from(
        content.toString('utf-8').replace(/<script src="renderer\/common\.js[^"]*"><\/script>/, (m) => `<script src="kb-shim.js"></script>\n  ${m}`)
      );
    }
    // 静态资源禁用缓存，确保前端代码更新后刷新即生效
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    res.end(content);
  } catch (err) {
    console.error('[web] 请求处理失败:', err);
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
  }
}

start().catch((err) => {
  console.error('Synapse Web 模式启动失败:', err);
  process.exit(1);
});
