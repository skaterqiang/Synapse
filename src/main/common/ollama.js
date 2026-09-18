// Ollama 本机服务探测与按需自动启动（图谱抽取 / AI 问答 / MinerU VLM 共用）
const { spawn } = require('child_process');
const http = require('http');

// 自启动的 Ollama 进程句柄（detached + unref，应用退出不等待它；Ollama 作为本机服务继续运行）
let ollamaStartedByUs = null;

function isLocalOllamaUrl(baseUrl) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(String(baseUrl || ''));
}

function pingOllama(baseUrl, timeoutMs = 3000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(String(baseUrl).replace(/\/$/, '') + '/api/version');
      // 部分环境 /etc/hosts 无 localhost 映射，Node 解析 "localhost" 直接 ENOTFOUND，
      // 会误判服务未运行并白等 30 秒自启动。回环探测统一归一到 127.0.0.1。
      const host = String(u.hostname).toLowerCase() === 'localhost' ? '127.0.0.1' : u.hostname;
      const req = http.request({
        hostname: host,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname,
        method: 'GET',
        timeout: timeoutMs,
      }, (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 500);
      });
      req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(false); });
      req.on('error', () => resolve(false));
      req.end();
    } catch (_) { resolve(false); }
  });
}

// 若 baseUrl 指向本机且未就绪，尝试自动启动 ollama serve 并等待其就绪。
// onLog(line) 用于向调用方日志通道输出进度；返回后不代表一定成功（找不到命令/超时均静默降级）。
async function ensureOllamaServer(baseUrl, onLog = () => {}) {
  if (!isLocalOllamaUrl(baseUrl)) return;
  if (await pingOllama(baseUrl)) return;
  onLog(`⏳ Ollama 服务未运行（${baseUrl}），正在自动启动…`);
  let started = false;
  if (ollamaStartedByUs && !ollamaStartedByUs.killed && ollamaStartedByUs.exitCode === null) {
    started = true; // 已由本进程拉起，等待就绪即可
  } else {
    try {
      const child = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      ollamaStartedByUs = child;
      started = true;
    } catch (_) { started = false; }
  }
  if (!started) { onLog('⚠ 未找到 ollama 命令，无法自动启动 Ollama 服务（请先安装 Ollama 或手动运行 ollama serve）'); return; }
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await pingOllama(baseUrl)) { onLog(`✅ Ollama 服务已就绪（${baseUrl}）`); return; }
  }
  onLog('⚠ Ollama 服务启动后 30 秒内未就绪，继续尝试请求（如失败请手动检查 ollama serve）');
}

module.exports = { isLocalOllamaUrl, pingOllama, ensureOllamaServer };
