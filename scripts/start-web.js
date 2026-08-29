// 跨平台 Web 模式启动器：macOS / Windows / Linux 均可用
// 用法：node scripts/start-web.js [--no-open] [--port 8787]
// 也可双击根目录的 start-web.command（mac）/ start-web.bat（win）
// 作用：检查依赖 → 启动 web/server.js → 等就绪 → 自动打开浏览器
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const noOpen = args.includes('--no-open') || process.env.NO_OPEN === '1';
const portIdx = args.indexOf('--port');
const PORT = Number(portIdx >= 0 ? args[portIdx + 1] : process.env.PORT) || 8787;
const TARGET = `http://localhost:${PORT}`;

const log = (s) => console.log('[start-web] ' + s);

// 1) 依赖检查：按 package.json 的 dependencies 全量核对，
// node_modules 被清理过（EDR/磁盘清理）时自动补装，避免启动即报错
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const missingDeps = Object.keys(pkg.dependencies || {}).filter(
  (name) => !fs.existsSync(path.join(ROOT, 'node_modules', name))
);
if (missingDeps.length) {
  log(`缺少 ${missingDeps.length} 个依赖（${missingDeps.slice(0, 5).join(', ')}${missingDeps.length > 5 ? '…' : ''}），正在执行 npm install …`);
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: ROOT, stdio: 'inherit',
    shell: process.platform === 'win32', // Windows 下 npm 是 .cmd，需 shell
  });
  if (r.status !== 0) { log('npm install 失败，请手动执行 npm install 后重试'); process.exit(1); }
  log('依赖安装完成');
}

// 2) 启动服务（子进程继承输出，Ctrl+C 一并退出）
log(`启动 Synapse Web 服务（端口 ${PORT}）…`);
const child = spawn(process.execPath, [path.join(ROOT, 'web', 'server.js')], {
  cwd: ROOT, stdio: 'inherit', env: { ...process.env, PORT: String(PORT) },
});
child.on('exit', (code) => { log('服务已退出（code=' + code + '）'); process.exit(code || 0); });
const stop = () => { try { child.kill('SIGTERM'); } catch (_) {} };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

// 3) 轮询就绪后打开浏览器（各平台命令不同）
function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' })
    .on('error', () => log('无法自动打开浏览器，请手动访问 ' + TARGET));
}

const t0 = Date.now();
(function poll() {
  const req = http.get(TARGET + '/', (res) => {
    res.resume();
    log('服务已就绪：' + TARGET);
    log('在浏览器中打开即可使用；回到本窗口按 Ctrl+C 停止服务。');
    if (!noOpen) openBrowser(TARGET);
  });
  req.on('error', () => {
    if (Date.now() - t0 > 15000) { log('等待服务就绪超时，请查看上方输出'); process.exit(1); }
    setTimeout(poll, 400);
  });
  req.setTimeout(2000, () => { req.destroy(); });
})();
