// Ollama 本地服务按需自动启动测试：node test/ollama-auto-start.test.js
// 覆盖：非本地地址不启动、已在运行不启动、本地未运行时自动启动并等待就绪、超时降级。
'use strict';
const http = require('http');
const { spawn } = require('child_process');

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' → ' + detail : ''}`); }
}

// 清除 require 缓存，确保每次测试拿到新的 ollamaStartedByUs 状态
function freshOllama() {
  delete require.cache[require.resolve('../src/main/common/ollama')];
  return require('../src/main/common/ollama');
}

let requestHits = [];
let spawnCalls = [];
let requestHandler = null;

// 桩 http.request：只响应 /api/version，其余透传到原 handler（此处无）
const origRequest = http.request;
http.request = function (opts, cb) {
  const path = (opts && opts.path) || '';
  const hostname = (opts && opts.hostname) || '';
  const port = (opts && opts.port) || '';
  requestHits.push({ hostname, port, path });
  if (path === '/api/version') {
    const ok = typeof requestHandler === 'function' ? requestHandler() : false;
    const req = {
      end: () => {},
      on: () => {},
      destroy: () => {},
    };
    setTimeout(() => {
      if (cb) cb({ statusCode: ok ? 200 : 503, resume: () => {} });
    }, 1);
    return req;
  }
  return origRequest.apply(this, arguments);
};

// 桩 child_process.spawn
const origSpawn = spawn;
require('child_process').spawn = function (cmd, args, opts) {
  spawnCalls.push({ cmd, args, opts });
  return {
    unref: () => {},
    killed: false,
    exitCode: null,
  };
};

(async () => {
  section('非本地地址不触发启动');
  let mod = freshOllama();
  requestHits = []; spawnCalls = [];
  await mod.ensureOllamaServer('http://example.com:11434');
  check('未发起探测请求', requestHits.length === 0, JSON.stringify(requestHits));
  check('未尝试启动 Ollama', spawnCalls.length === 0);

  section('本地服务已在运行时不重复启动');
  mod = freshOllama();
  requestHits = []; spawnCalls = [];
  requestHandler = () => true;
  await mod.ensureOllamaServer('http://127.0.0.1:11434');
  check('发起了版本探测', requestHits.length === 1 && requestHits[0].path === '/api/version');
  check('未尝试启动 Ollama', spawnCalls.length === 0);

  section('本地未运行时自动启动并等待就绪');
  mod = freshOllama();
  requestHits = []; spawnCalls = [];
  let calls = 0;
  requestHandler = () => { calls++; return calls >= 2; };
  const logs = [];
  await mod.ensureOllamaServer('http://localhost:11434', (line) => logs.push(line));
  check('尝试启动 Ollama', spawnCalls.length === 1 && spawnCalls[0].cmd === 'ollama' && JSON.stringify(spawnCalls[0].args) === '["serve"]');
  check('最终探测成功', calls >= 2);
  check('日志包含就绪提示', logs.some((l) => /已就绪/.test(l)), JSON.stringify(logs));

  section('启动超时后静默降级');
  mod = freshOllama();
  requestHits = []; spawnCalls = [];
  requestHandler = () => false;
  const logs2 = [];
  const t0 = Date.now();
  await mod.ensureOllamaServer('http://127.0.0.1:11434', (line) => logs2.push(line));
  const elapsed = Date.now() - t0;
  check('仍尝试启动一次', spawnCalls.length === 1);
  check('超时后返回（约 30s）', elapsed >= 28000 && elapsed <= 35000, elapsed);
  check('日志包含超时降级提示', logs2.some((l) => /30 秒内未就绪/.test(l)), JSON.stringify(logs2));

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });

function section(title) { console.log(`\n[${title}]`); }
