// MCP 客户端：支持 stdio（spawn + 行式 JSON-RPC）与远程 http/sse
// 会话化设计：一次会话内完成 initialize → notifications/initialized → 多次请求。
// 远程 SSE 传输的会话状态绑定在长连接上，若每次调用都重开连接，服务端会把未初始化的
// 请求拒为 -32602，因此列工具与调用工具必须复用同一会话（见 openSession）。
const PROTOCOL = '2024-11-05';
const CONNECT_MS = 20000; // 建连 / 取 SSE endpoint 超时
const REQUEST_MS = 30000; // 单次请求超时（搜索类工具较慢）

// 远程传输探测缓存：url → { kind, sseUrl }，避免每次调用都重复付出 405 回退的往返
const probeCache = new Map();

function authHeaders(cfg, settings) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (cfg.useModelKey && settings && settings.apiKey) h.Authorization = 'Bearer ' + settings.apiKey;
  if (cfg.env && cfg.env.Authorization) {
    // Cline 风格 ${VAR} 占位符：先取进程环境变量，再回退模型 Key；
    // 解析不出就不发占位符原文（否则服务端 401 且难以定位）
    let auth = String(cfg.env.Authorization);
    const ph = auth.match(/^(Bearer\s+)?\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/i);
    if (ph) {
      const secret = process.env[ph[2]] || (settings && settings.apiKey) || '';
      auth = secret ? (/^Bearer /i.test(secret) ? secret : 'Bearer ' + secret) : '';
    }
    if (auth) h.Authorization = auth;
  }
  return h;
}

function rpcErrText(err) {
  const extra = err.data && typeof err.data !== 'object' ? ' ' + err.data : '';
  return `${err.message || 'MCP 错误'}${extra}（code ${err.code}）`;
}

function parseJson(s) {
  const t = String(s || '').trim();
  if (!t.startsWith('{')) return null;
  try { return JSON.parse(t); } catch (_) { return null; }
}

function withTimeout(p, ms, msg) {
  let timer;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(msg)), ms); }),
  ]);
}

// SSE 增量解析：event 名与 data 必须跨 chunk 持久化。
// 若在每个 chunk 内重置事件名，"event:endpoint" 与其 "data:" 落在不同 chunk 时事件名会丢失，
// 导致永远等不到 endpoint 而挂死到超时。
function createSseParser(onEvent) {
  let buf = '';
  let ev = '';
  let data = [];
  return (text) => {
    buf += text;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line === '') { // 空行 = 事件结束，派发
        if (data.length) onEvent(ev || 'message', data.join('\n'));
        ev = ''; data = [];
        continue;
      }
      if (line.startsWith(':')) continue; // 注释/心跳
      const c = line.indexOf(':');
      const field = c < 0 ? line : line.slice(0, c);
      let val = c < 0 ? '' : line.slice(c + 1);
      if (val.startsWith(' ')) val = val.slice(1);
      if (field === 'event') ev = val;
      else if (field === 'data') data.push(val);
    }
  };
}

// 请求登记簿：按 id 匹配响应，超时/断开时统一失败
function createPending() {
  const map = new Map();
  return {
    wait(id, ms, label) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { map.delete(id); reject(new Error(label)); }, ms);
        map.set(id, { resolve, reject, timer });
      });
    },
    settle(json) {
      const e = map.get(json.id);
      if (!e) return;
      clearTimeout(e.timer);
      map.delete(json.id);
      if (json.error) e.reject(new Error(rpcErrText(json.error)));
      else e.resolve(json.result);
    },
    fail(id, err) {
      const e = map.get(id);
      if (!e) return;
      clearTimeout(e.timer);
      map.delete(id);
      e.reject(err);
    },
    failAll(err) {
      for (const [, e] of map) { clearTimeout(e.timer); e.reject(err); }
      map.clear();
    },
  };
}

// 读取一次性 SSE 响应体，直到取到匹配 id 的 JSON-RPC 响应
async function readSseUntil(reader, id) {
  const dec = new TextDecoder('utf-8');
  let got = false; let out = null; let rpcError = null;
  const feed = createSseParser((_ev, data) => {
    const j = parseJson(data);
    if (j && j.id === id) { if (j.error) rpcError = j.error; else { out = j.result; got = true; } }
  });
  try {
    while (!got && !rpcError) {
      const { done, value } = await reader.read();
      if (done) break;
      feed(dec.decode(value, { stream: true }));
    }
  } finally { try { await reader.cancel(); } catch (_) {} }
  if (rpcError) throw new Error(rpcErrText(rpcError));
  if (!got) throw new Error('未收到 MCP 响应');
  return out;
}

// ---------- streamable-http 会话 ----------
async function openHttp(cfg, settings) {
  let sessionId = null;
  let nextId = 1;

  const once = async (body, wantId) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_MS);
    try {
      const h = authHeaders(cfg, settings);
      if (sessionId) h['Mcp-Session-Id'] = sessionId;
      const r = await fetch(cfg.url, { method: 'POST', headers: h, body: JSON.stringify(body), signal: ctrl.signal });
      const sid = r.headers.get('mcp-session-id');
      if (sid) sessionId = sid;
      // 405/404/406：服务端不支持 streamable-http，交由上层回退 SSE
      if (r.status === 405 || r.status === 404 || r.status === 406) {
        const d = (await r.text().catch(() => '')).slice(0, 120);
        const e = new Error(`不支持 streamable-http（HTTP ${r.status} ${d.trim()}）`);
        e.fallback = true;
        throw e;
      }
      if (r.status >= 400) {
        const d = (await r.text().catch(() => '')).slice(0, 200);
        throw new Error(`HTTP ${r.status} ${d.trim()}`);
      }
      if (wantId === null) { await r.text().catch(() => {}); return null; } // 通知无响应
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        const j = await r.json();
        if (j.error) throw new Error(rpcErrText(j.error));
        return j.result;
      }
      if (!r.body) throw new Error('响应无内容');
      return await readSseUntil(r.body.getReader(), wantId);
    } finally { clearTimeout(timer); }
  };

  const init = await withTimeout(
    once({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'synapse', version: '1.0' } } }, 0),
    CONNECT_MS, `initialize 超时（${CONNECT_MS / 1000}s）`,
  );
  await once({ jsonrpc: '2.0', method: 'notifications/initialized' }, null).catch(() => {});

  return {
    kind: 'streamable-http',
    serverInfo: init && init.serverInfo,
    request: (method, params) => { const id = nextId++; return once({ jsonrpc: '2.0', id, method, params }, id); },
    async close() {},
  };
}

// ---------- SSE 会话 ----------
// 旧版 SSE 的 GET 地址可能是 /mcp 或 /sse，逐个探测；
// 注意部分服务端（如百炼）对 /mcp 的 GET 会返回 200 + 空 body，必须校验 content-type 才算可用。
function sseCandidates(url, cached) {
  if (cached) return [cached];
  const out = [url];
  if (/\/mcp\/?$/.test(url)) out.push(url.replace(/\/mcp\/?$/, '/sse'));
  return out;
}

async function openSse(cfg, settings, cachedUrl) {
  const ctrl = new AbortController();
  const pending = createPending();
  let closing = false;
  let endpointResolve;
  const endpointP = new Promise((res) => { endpointResolve = res; });

  const errs = [];
  let resp = null; let baseUrl = null;
  for (const u of sseCandidates(cfg.url, cachedUrl)) {
    let r;
    try {
      r = await withTimeout(
        fetch(u, { method: 'GET', headers: { ...authHeaders(cfg, settings), Accept: 'text/event-stream' }, signal: ctrl.signal }),
        CONNECT_MS, `连接超时（${CONNECT_MS / 1000}s）`,
      );
    } catch (e) { errs.push(`${u} → ${e.message}`); continue; }
    const ct = r.headers.get('content-type') || '';
    if (!r.ok || !ct.includes('text/event-stream') || !r.body) {
      errs.push(`${u} → HTTP ${r.status}${ct ? ' ' + ct : ' 无事件流'}`);
      try { r.body && await r.body.cancel(); } catch (_) {}
      continue;
    }
    resp = r; baseUrl = u; break;
  }
  if (!resp) { try { ctrl.abort(); } catch (_) {} throw new Error('SSE 连接失败：' + errs.join('；')); }

  // 后台泵：持续读流，endpoint 事件解析地址，message 事件按 id 派发响应
  const reader = resp.body.getReader();
  const dec = new TextDecoder('utf-8');
  const feed = createSseParser((ev, data) => {
    if (ev === 'endpoint') return endpointResolve(data.trim());
    const j = parseJson(data);
    if (j && j.id !== undefined) pending.settle(j);
  });
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        feed(dec.decode(value, { stream: true }));
      }
      if (!closing) pending.failAll(new Error('MCP 服务器关闭了连接'));
    } catch (e) {
      if (!closing) pending.failAll(new Error('SSE 连接中断：' + e.message));
    }
  })();

  const endpoint = await withTimeout(endpointP, CONNECT_MS, `未收到 SSE endpoint 事件（${CONNECT_MS / 1000}s 超时）`)
    .catch((e) => { closing = true; try { ctrl.abort(); } catch (_) {} throw e; });
  const msgUrl = endpoint.startsWith('http') ? endpoint : new URL(endpoint, baseUrl).href;

  const post = async (body) => {
    const r = await fetch(msgUrl, { method: 'POST', headers: authHeaders(cfg, settings), body: JSON.stringify(body), signal: ctrl.signal });
    if (r.status >= 400) {
      const d = (await r.text().catch(() => '')).slice(0, 200);
      throw new Error(`POST HTTP ${r.status} ${d.trim()}`);
    }
    await r.text().catch(() => {}); // 释放连接（响应走 SSE 流）
  };

  let nextId = 1;
  // 先登记再发送，避免响应早于登记导致漏接；
  // 发送失败时必须让已登记的 wait 失败并返回它，否则 wait 成为无人接管的 promise（未处理拒绝）
  const request = (method, params, ms) => {
    const id = nextId++;
    const wait = pending.wait(id, ms || REQUEST_MS, `${method} 响应超时（${(ms || REQUEST_MS) / 1000}s）`);
    post({ jsonrpc: '2.0', id, method, params }).catch((e) => pending.fail(id, e));
    return wait;
  };

  const init = await request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'synapse', version: '1.0' } }, CONNECT_MS)
    .catch((e) => { closing = true; try { ctrl.abort(); } catch (_) {} throw e; });
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => {});

  return {
    kind: 'sse',
    sseUrl: baseUrl,
    serverInfo: init && init.serverInfo,
    request: (method, params) => request(method, params),
    async close() {
      closing = true;
      pending.failAll(new Error('会话已关闭'));
      try { await reader.cancel(); } catch (_) {}
      try { ctrl.abort(); } catch (_) {}
    },
  };
}

// 远程会话：按缓存/URL 特征决定传输顺序，streamable-http 不支持时回退 SSE
async function openRemote(cfg, settings) {
  const cached = probeCache.get(cfg.url) || null;
  let order;
  if (cached) order = cached.kind === 'sse' ? ['sse', 'http'] : ['http', 'sse'];
  else if (/\/sse\/?$/.test(cfg.url) || cfg.type === 'sse') order = ['sse', 'http'];
  else order = ['http', 'sse'];

  const errs = [];
  for (const kind of order) {
    try {
      const s = kind === 'sse'
        ? await openSse(cfg, settings, cached && cached.sseUrl)
        : await openHttp(cfg, settings);
      probeCache.set(cfg.url, { kind, sseUrl: s.sseUrl || null });
      return s;
    } catch (e) { errs.push(`[${kind}] ${e.message}`); }
  }
  probeCache.delete(cfg.url);
  throw new Error(errs.join('；'));
}

// ---------- stdio 会话 ----------
function openStdio(cfg) {
  const { spawn } = require('child_process');
  const pending = createPending();
  let closing = false;
  let buffer = '';
  let stderr = '';
  let spawnErr = null;
  const child = spawn(cfg.command, cfg.args || [], { env: { ...process.env, ...(cfg.env || {}) } });

  child.on('error', (e) => {
    spawnErr = new Error(`启动失败：${e.message}`);
    if (!closing) pending.failAll(spawnErr);
  });
  child.stderr && child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-500); });
  child.stdout.on('data', (d) => {
    buffer += d.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const j = parseJson(line);
      if (j && j.id !== undefined) pending.settle(j);
    }
  });
  child.on('exit', (code) => {
    if (!closing) pending.failAll(new Error(`MCP 进程退出（code ${code}）${stderr ? '：' + stderr.trim() : ''}`));
  });

  let nextId = 1;
  const send = (body) => new Promise((res, rej) => {
    child.stdin.write(JSON.stringify(body) + '\n', (e) => (e ? rej(e) : res()));
  });
  // 同 SSE：发送失败也要让已登记的 wait 失败，避免未处理拒绝崩溃主进程；
  // 写失败（EPIPE）常常只是 spawn 失败的副作用，稍等一拍取更准确的启动错误
  const request = (method, params, ms) => {
    const id = nextId++;
    const wait = pending.wait(id, ms || REQUEST_MS, `${method} 响应超时（${(ms || REQUEST_MS) / 1000}s）`);
    send({ jsonrpc: '2.0', id, method, params }).catch(async (e) => {
      await new Promise((r) => setTimeout(r, 50));
      pending.fail(id, spawnErr || e);
    });
    return wait;
  };

  const session = {
    kind: 'stdio',
    request: (method, params) => request(method, params),
    async close() {
      closing = true;
      pending.failAll(new Error('会话已关闭'));
      try { child.kill(); } catch (_) {}
    },
  };
  return request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'synapse', version: '1.0' } }, CONNECT_MS)
    .then(async (init) => {
      await send({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => {});
      session.serverInfo = init && init.serverInfo;
      return session;
    })
    .catch(async (e) => { await session.close(); throw e; });
}

// 打开会话：调用方负责 close（务必用 try/finally）
function openSession(cfg, settings) {
  if (cfg.type === 'stdio') return openStdio(cfg);
  return openRemote(cfg, settings);
}

// 工具名需满足 LLM function name 约束（字母数字下划线短横），非法字符统一替换
function toolFuncName(serverName, toolName) {
  return `${serverName}__${toolName}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function toOpenAiTools(cfg, res) {
  return ((res && res.tools) || []).map((t) => ({
    type: 'function',
    function: {
      name: toolFuncName(cfg.name, t.name),
      description: `[${cfg.name}] ${t.description || t.name}`,
      parameters: t.inputSchema || { type: 'object', properties: {} },
    },
    _server: cfg,
    _tool: t.name,
  }));
}

function toText(res) {
  const parts = ((res && res.content) || []).map((c) => c.text || '').filter(Boolean);
  return parts.join('\n') || JSON.stringify(res);
}

// 列出服务器工具（OpenAI function 格式）
async function listTools(cfg, settings) {
  const s = await openSession(cfg, settings);
  try { return toOpenAiTools(cfg, await s.request('tools/list', {})); }
  finally { await s.close(); }
}

// 调用工具，返回文本结果
async function callTool(cfg, settings, toolName, args) {
  const s = await openSession(cfg, settings);
  try { return toText(await s.request('tools/call', { name: toolName, arguments: args || {} })); }
  finally { await s.close(); }
}

module.exports = { listTools, callTool, openSession, toOpenAiTools, toText };
