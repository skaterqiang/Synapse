// MCP 客户端回归测试：node test/mcp-client.test.js
// 覆盖三种传输的连通性，并针对历史 bug 做定点回归：
//   1) SSE 的 event/data 分片投递（事件名跨 chunk 丢失会挂死到超时）
//   2) 会话复用（列工具与调工具换连接会被服务端拒为 -32602）
//   3) GET 返回 200+空 body 的伪 SSE 地址必须被跳过
//   4) stdio 启动失败不得引发未处理拒绝
const { spawn } = require('child_process');
const path = require('path');
const mcp = require('../src/main/mcp/mcp');

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' → ' + detail : ''}`); }
}

function startMock() {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'mock-mcp-server.js')]);
    let out = '';
    const timer = setTimeout(() => rej(new Error('mock 启动超时')), 5000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      const m = out.match(/PORT=(\d+)/);
      if (m) { clearTimeout(timer); res({ child, port: Number(m[1]) }); }
    });
    child.stderr.on('data', (d) => process.stderr.write('[mock] ' + d));
  });
}

(async () => {
  process.on('unhandledRejection', (e) => {
    console.log('  ❌ 出现未处理拒绝：' + (e && e.message));
    fail++;
  });

  const { child, port } = await startMock();
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  try {
    console.log('\n【1】streamable-http（POST 返回 application/json）');
    let r = await mcp.testMcp({ name: 'mockJson', type: 'http', url: `${base}/json/mcp`, query: 'hello' });
    check('连接并列出工具', r.ok && r.tools.join() === 'echo', r.error);
    check('同会话内调用工具成功（未初始化会被拒为 -32602）', r.ok && /hello/.test(r.result || ''), r.result || r.error);
    check('报告传输方式与服务端名', r.ok && /streamable-http · mock-mcp/.test(r.message), r.message);

    console.log('\n【2】streamable-http（POST 返回 text/event-stream，event 与 data 分片）');
    r = await mcp.testMcp({ name: 'mockSseResp', type: 'http', url: `${base}/sseresp/mcp`, query: 'chunked' });
    check('跨 chunk 解析 SSE 响应体', r.ok && /chunked/.test(r.result || ''), r.error || r.result);

    console.log('\n【3】旧版 SSE（/mcp 返回 405；GET /mcp 是 200+空 body；endpoint 分片投递）');
    const tSse = Date.now();
    r = await mcp.testMcp({ name: 'mockLegacy', type: 'http', url: `${base}/legacy/mcp`, query: 'legacy-q' });
    const costSse = Date.now() - tSse;
    check('自动回退到 /sse 并连通', r.ok && r.tools.join() === 'echo', r.error);
    check('endpoint 事件跨 chunk 仍能解析（不再挂到超时）', costSse < 5000, `耗时 ${costSse}ms`);
    check('同一 SSE 会话内调用工具成功', r.ok && /legacy-q/.test(r.result || ''), r.result || r.error);
    check('识别为 sse 传输', r.ok && /sse · mock-mcp/.test(r.message), r.message);

    console.log('\n【4】传输探测缓存（第二次应更快且仍成功）');
    const t1 = Date.now();
    const r1 = await mcp.testMcp({ name: 'mockLegacy', type: 'http', url: `${base}/legacy/mcp` });
    check('缓存后仍连通', r1.ok, r1.error);
    check('缓存后不再重试 405 分支', Date.now() - t1 < 3000, `耗时 ${Date.now() - t1}ms`);

    console.log('\n【5】stdio');
    r = await mcp.testMcp({ name: 'mockStdio', type: 'stdio', command: process.execPath, args: [path.join(__dirname, 'mock-mcp-stdio.js')], query: 'stdio-q' });
    check('连接并列出工具', r.ok && r.tools.join() === 'echo', r.error);
    check('同会话内调用工具成功', r.ok && /stdio-q/.test(r.result || ''), r.result || r.error);

    console.log('\n【6】错误处理（应快速失败且给出可读原因，不得崩溃）');
    r = await mcp.testMcp({ name: 'x', type: 'http', url: '' });
    check('URL 为空即时提示', !r.ok && /请填写 URL/.test(r.error), r.error);
    r = await mcp.testMcp({ name: 'x', type: 'stdio', command: '' });
    check('命令为空即时提示', !r.ok && /请填写命令/.test(r.error), r.error);
    r = await mcp.testMcp({ name: 'x', type: 'stdio', command: 'definitely-not-a-real-cmd-xyz' });
    check('stdio 启动失败给出 ENOENT 原因', !r.ok && /ENOENT/.test(r.error), r.error);
    const tBad = Date.now();
    r = await mcp.testMcp({ name: 'x', type: 'http', url: `${base}/nope` });
    check('404 地址快速失败（不等超时）', !r.ok && Date.now() - tBad < 5000, `${Date.now() - tBad}ms ${r.error}`);

    await new Promise((res) => setTimeout(res, 300)); // 留出未处理拒绝的观察窗口
  } finally {
    child.kill();
  }

  console.log(`\n总计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}，耗时 ${Date.now() - t0}ms`);
  process.exit(fail ? 1 : 0);
})();
