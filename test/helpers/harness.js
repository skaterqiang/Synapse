// 测试公共脚手架：沙箱环境 + electron 桩 + 断言计数 + 假 LLM 服务
// 所有 test/*.test.js 统一 require 本文件，避免每个用例重复搭环境。
//
// 关键约束：
//   1) 必须在 require 任何 src/main/** 模块「之前」安装 electron 桩（Module._load 拦截）
//   2) 必须把数据根目录指向沙箱，否则会污染仓库内真实的 data/ 目录
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Module = require('module');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------- 沙箱 ----------
// 建临时目录并接管 HOME/USERPROFILE/APPDATA，使 app.getPath 全部落在沙箱内
function sandbox(prefix = 'synapse-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.APPDATA = path.join(dir, 'AppData', 'Roaming');
  process.env.LOCALAPPDATA = path.join(dir, 'AppData', 'Local');
  fs.mkdirSync(process.env.APPDATA, { recursive: true });
  fs.mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
  return dir;
}

// ---------- electron 桩 ----------
// 返回 { shim, handlers, sent, invoke }；invoke 可直接调用 ipcMain.handle 注册的通道
function installElectronShim(opts = {}) {
  const handlers = new Map();
  const sent = [];
  const userData = opts.userData || path.join(process.env.USERPROFILE, 'electron-userData');
  fs.mkdirSync(userData, { recursive: true });
  const appPath = opts.appPath || REPO_ROOT;

  const shim = {
    app: {
      getPath: (name) => {
        if (name === 'userData') return userData;
        if (name === 'appData') return process.env.APPDATA;
        if (name === 'documents') return path.join(process.env.USERPROFILE, 'Documents');
        if (name === 'downloads') return path.join(process.env.USERPROFILE, 'Downloads');
        if (name === 'temp') return os.tmpdir();
        return process.env.USERPROFILE;
      },
      getAppPath: () => appPath,
      isPackaged: false,
      getName: () => 'Synapse',
      getVersion: () => '1.0.0',
      on: () => {},
      once: () => {},
      quit: () => {},
      exit: () => {},
      relaunch: () => {},
    },
    ipcMain: {
      handle: (ch, fn) => handlers.set(ch, fn),
      on: () => {},
      removeHandler: (ch) => handlers.delete(ch),
    },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true, filePath: '' }),
      showMessageBox: async () => ({ response: 1, checkboxChecked: false }),
      showErrorBox: () => {},
    },
    shell: {
      openPath: async () => '',
      openExternal: async () => '',
      showItemInFolder: () => {},
    },
    BrowserWindow: class {
      static getAllWindows() { return []; }
      static getFocusedWindow() { return null; }
      static fromWebContents() { return null; }
      constructor() { this.webContents = { send: () => {}, openDevTools: () => {} }; }
      isDestroyed() { return true; }
      loadFile() {} loadURL() {} show() {} hide() {} close() {}
    },
    session: {
      defaultSession: {
        cookies: { get: async () => [], set: async () => {}, remove: async () => {} },
        clearStorageData: async () => {},
      },
      fromPartition: () => ({ cookies: { get: async () => [], set: async () => {}, remove: async () => {} } }),
    },
    Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}), getApplicationMenu: () => null },
    protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {}, registerFileProtocol: () => {} },
    nativeImage: { createFromPath: () => ({ resize: () => ({}), isEmpty: () => true }) },
    clipboard: { writeText: () => {}, readText: () => '' },
  };

  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === 'electron') return shim;
    return origLoad.apply(this, arguments);
  };

  const invoke = async (channel, ...args) => {
    const fn = handlers.get(channel);
    if (!fn) throw new Error('未注册的 IPC 通道：' + channel);
    const event = {
      sender: { send: (ch, payload) => sent.push({ channel: ch, payload }) },
      senderFrame: null,
    };
    return fn(event, ...args);
  };

  return { shim, handlers, sent, invoke, userData, appPath };
}

// ---------- 一键启动测试环境 ----------
// 沙箱 + electron 桩 + 数据根目录重定向（可选 db.init）
async function bootEnv(opts = {}) {
  const dir = sandbox(opts.prefix);
  const el = installElectronShim(opts);
  const paths = require(path.join(REPO_ROOT, 'src', 'main', 'common', 'paths'));
  const dataRoot = path.join(dir, 'data');
  paths.setDataRoot(dataRoot);
  let db = null;
  if (opts.db !== false) {
    db = require(path.join(REPO_ROOT, 'src', 'main', 'common', 'db'));
    await db.init();
  }
  return { dir, dataRoot, el, paths, db, repoRoot: REPO_ROOT };
}

// ---------- 断言 ----------
function mkCheck(label = '测试') {
  let pass = 0;
  const fails = [];
  const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fails.push(name); console.log(`  ❌ ${name}${detail ? ' → ' + detail : ''}`); }
  };
  const section = (title) => console.log(`\n[${title}]`);
  const summary = () => {
    console.log('');
    console.log(`${label}：${pass}/${pass + fails.length} 通过`);
    if (fails.length) {
      console.log('失败用例：' + fails.join('；'));
      process.exitCode = 1;
    }
    return fails.length === 0;
  };
  return { check, section, summary, fails, count: () => pass + fails.length };
}

// ---------- 假 LLM 服务（OpenAI 兼容） ----------
// handler({ url, method, body, headers, n }) → { status, json } | { status, text } | { status, sse: [片段] }
async function startFakeLlm(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    // Ollama 健康探测：避免 ensureOllamaServer 的 ping 污染请求记录与响应逻辑
    if (req.url === '/api/version' || req.url === '/v1/api/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: 'fake-ollama' }));
      return;
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = { _raw: raw }; }
      requests.push({ url: req.url, method: req.method, headers: req.headers, body });
      let out;
      try {
        out = await handler({ url: req.url, method: req.method, body, headers: req.headers, n: requests.length, requests });
      } catch (err) {
        out = { status: 500, text: 'fake-llm handler error: ' + err.message };
      }
      out = out || { status: 200, json: {} };
      const headers = Object.assign({ 'Content-Type': 'application/json' }, out.headers || {});
      res.writeHead(out.status || 200, headers);
      if (Array.isArray(out.sse)) {
        for (const piece of out.sse) res.write(piece);
        res.end();
      } else if (out.text !== undefined) {
        res.end(out.text);
      } else if (out.hang) {
        // 不结束响应：用于验证超时/中止路径（调用方需自行 close）
      } else {
        res.end(JSON.stringify(out.json || {}));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  return {
    port,
    baseUrl,
    requests,
    // 生成可直接喂给业务函数的 settings（loopback 免 Key，但仍给一个便于校验透传）
    settings: (extra) => Object.assign({
      apiKey: 'test-key',
      apiBaseUrl: baseUrl,
      model: 'test-model',
      apiProvider: 'openai',
    }, extra || {}),
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections && server.closeAllConnections(); }),
  };
}

// 构造 SSE 流片段：reasoning 走 reasoning_content，正文按 chunkSize 切片
function sseText(text, opts = {}) {
  const chunkSize = opts.chunkSize || 12;
  const field = opts.reasoningField || 'reasoning_content';
  const parts = [];
  const reasoning = opts.reasoning || '';
  for (let i = 0; i < reasoning.length; i += chunkSize) {
    parts.push(`data: ${JSON.stringify({ choices: [{ delta: { [field]: reasoning.slice(i, i + chunkSize) } }] })}\n\n`);
  }
  const body = String(text == null ? '' : text);
  for (let i = 0; i < body.length; i += chunkSize) {
    parts.push(`data: ${JSON.stringify({ choices: [{ delta: { content: body.slice(i, i + chunkSize) } }] })}\n\n`);
  }
  parts.push('data: [DONE]\n\n');
  return parts;
}

// ---------- 杂项工具 ----------
function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

// 生成 n 个类的 Turtle 本体（用于截断/孤儿类测试）
function makeTurtle(n, opts = {}) {
  const lines = [
    '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
    '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
    '@prefix ex: <http://example.org/big#> .',
    '',
  ];
  const root = opts.root || 'Entity';
  lines.push(`ex:${root} a owl:Class ; rdfs:label "${opts.rootLabel || '实体'}" .`);
  for (let i = 1; i <= n; i++) {
    const parent = i <= 10 ? root : 'C' + (((i - 1) % 10) + 1);
    lines.push(`ex:C${i} a owl:Class ; rdfs:label "类${i}" ; rdfs:subClassOf ex:${parent} .`);
  }
  lines.push('ex:rel1 a owl:ObjectProperty ; rdfs:label "关联" ; rdfs:domain ex:' + root + ' ; rdfs:range ex:C1 .');
  return lines.join('\n');
}

module.exports = {
  REPO_ROOT,
  sandbox,
  installElectronShim,
  bootEnv,
  mkCheck,
  startFakeLlm,
  sseText,
  writeFile,
  makeTurtle,
};
