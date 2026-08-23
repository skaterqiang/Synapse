// MCP 客户端回归测试用 stdio mock 服务器（仅测试用）
// 行式 JSON-RPC，且强制要求先 initialize（未初始化返回 -32602）
let initialized = false;
let buf = '';

function send(o) { process.stdout.write(JSON.stringify(o) + '\n'); }

process.stdin.on('data', (d) => {
  buf += d.toString();
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let m;
    try { m = JSON.parse(t); } catch (_) { continue; }
    if (m.method === 'initialize') {
      initialized = true;
      send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock-stdio', version: '1.0' } } });
    } else if (m.method === 'notifications/initialized') {
      // 通知无响应
    } else if (!initialized) {
      send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Invalid request parameters' } });
    } else if (m.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }] } });
    } else if (m.method === 'tools/call') {
      send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'stdio echo: ' + JSON.stringify(m.params.arguments) }] } });
    } else {
      send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
    }
  }
});
