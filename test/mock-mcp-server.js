// MCP 客户端回归测试用 mock 服务器（仅测试用，不属于应用运行时）
// 覆盖：streamable-http(JSON) / streamable-http(SSE 响应体) / 旧版 SSE(分片投递 endpoint + 强制初始化)
const http = require('http');

const TOOLS = [{ name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }];
const sessions = new Map(); // sessionId -> { res, initialized }

function rpcResult(id, result) { return JSON.stringify({ jsonrpc: '2.0', id, result }); }
function rpcError(id, code, message) { return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }); }

function handle(body, sess) {
  const { id, method } = body;
  if (method === 'initialize') {
    if (sess) sess.initialized = true;
    return rpcResult(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock-mcp', version: '9.9' } });
  }
  if (method === 'notifications/initialized') return null;
  // 关键规则：未初始化的会话不允许列/调工具（真实服务端行为，用于回归"每次调用重开连接"的 bug）
  if (sess && !sess.initialized) return rpcError(id, -32602, 'Invalid request parameters');
  if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });
  if (method === 'tools/call') return rpcResult(id, { content: [{ type: 'text', text: 'echo: ' + JSON.stringify(body.params.arguments) }], isError: false });
  return rpcError(id, -32601, 'Method not found');
}

function readBody(req) {
  return new Promise((res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => res(b)); });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // --- 场景 A：streamable-http，POST 返回 application/json ---
  if (p === '/json/mcp' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const sid = req.headers['mcp-session-id'] || 'sid-json';
    if (!sessions.has(sid)) sessions.set(sid, { initialized: false });
    const out = handle(body, sessions.get(sid));
    if (!out) { res.writeHead(202).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': sid }).end(out);
    return;
  }

  // --- 场景 B：streamable-http，POST 返回 text/event-stream 响应体 ---
  if (p === '/sseresp/mcp' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const sid = req.headers['mcp-session-id'] || 'sid-sseresp';
    if (!sessions.has(sid)) sessions.set(sid, { initialized: false });
    const out = handle(body, sessions.get(sid));
    if (!out) { res.writeHead(202).end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': sid });
    res.write('event: message\n');       // 故意与 data 分两次写，验证跨 chunk 解析
    res.flushHeaders && res.flushHeaders();
    setTimeout(() => res.end(`data: ${out}\n\n`), 30);
    return;
  }

  // --- 场景 C：旧版 SSE。GET /legacy/mcp 模仿百炼：200 + 空 body（非事件流，必须被跳过）---
  if (p === '/legacy/mcp') {
    if (req.method === 'GET') { res.writeHead(200, { 'Content-Length': '0' }).end(); return; }
    res.writeHead(405).end('current mcp not support streamableHttp');
    return;
  }

  // GET /legacy/sse：真正的事件流，endpoint 的 event 行与 data 行分片投递（原 bug 触发点）
  if (p === '/legacy/sse' && req.method === 'GET') {
    const sid = 'sid-' + Math.random().toString(16).slice(2);
    sessions.set(sid, { res, initialized: false });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('event:endpoint\n');
    setTimeout(() => res.write(`data:/legacy/message?sessionId=${sid}\n\n`), 40);
    req.on('close', () => sessions.delete(sid));
    return;
  }

  if (p === '/legacy/message' && req.method === 'POST') {
    const sid = url.searchParams.get('sessionId');
    const sess = sessions.get(sid);
    if (!sess) { res.writeHead(404).end('no session'); return; }
    const body = JSON.parse(await readBody(req));
    res.writeHead(202).end();
    const out = handle(body, sess);
    if (out) setTimeout(() => sess.res.write(`event:message\ndata:${out}\n\n`), 20);
    return;
  }

  res.writeHead(404).end('nope');
});

server.listen(0, () => console.log('PORT=' + server.address().port));
