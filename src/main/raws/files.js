// 本地文件解析：PDF/DOCX/Excel/PPTX/纯文本 → Markdown，并保存到 raw/
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const TurndownService = require('turndown');
const JSZip = require('jszip');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const { PDFParse } = require('pdf-parse');
const { rawsRoot } = require('./root');
const { num } = require('../common/config');
const { dataRoot, kbAssetUrlFor } = require('../common/paths');

// MinerU 失败回退内置解析时，把原因落盘到 <数据根>/mineru-fallback.log（保留最近 30 行）。
// 回退本身是静默的（任务仍记 success），没有这份日志用户只能看到笔记质量变差却无从定位
function appendMineruFallbackLog(absPath, reason) {
  try {
    const file = path.join(dataRoot(), 'mineru-fallback.log');
    const line = `${new Date().toISOString()} ${path.basename(String(absPath || ''))} ${String(reason || '').replace(/[\r\n]+/g, ' ').slice(0, 300)}\n`;
    let prev = '';
    try { prev = fs.readFileSync(file, 'utf-8'); } catch (_) { /* 首次无文件 */ }
    const lines = (prev + line).split('\n').filter(Boolean).slice(-30);
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8');
  } catch (_) { /* 日志写失败不影响主流程 */ }
}

// MINERU_SUPPORTED_EXTS / FILE_EXTENSIONS / DEFAULT_NOTE_IMPORT_EXTS 等常量统一定义于 common/constants.js
const { MINERU_SUPPORTED_EXTS, FILE_EXTENSIONS, DEFAULT_NOTE_IMPORT_EXTS, MINERU_TIMEOUT_SEC, PLUGINS_DIR, MINERU_PLUGIN_DIR, MINERU_INSTALL_TIMEOUT_MS, MINERU_DEFAULT_VLM_MODEL, MINERU_DEFAULT_OLLAMA_URL, MINERU_ASCII_ALIAS_CANDIDATES, MINERU_EXTRA_PACKAGES } = require('../common/constants');

// 解析配置为扩展名集合：容许逗号/空格/分号/换行分隔，容许带不带前导点、大小写不敏感；
// 未配置或配成空则回退默认白名单（避免误操作把导入能力整个关死）
function noteImportExts(settings) {
  const raw = settings && typeof settings.noteImportExts === 'string' ? settings.noteImportExts : '';
  const list = raw.split(/[,;\s]+/).map((s) => s.trim().replace(/^\./, '').toLowerCase()).filter(Boolean);
  return new Set(list.length ? list : DEFAULT_NOTE_IMPORT_EXTS);
}

// 该来源是否允许导入为笔记（按文件名判定，无扩展名一律不收）
function canImportAsNote(settings, fileName) {
  const ext = path.extname(String(fileName || '')).replace(/^\./, '').toLowerCase();
  if (!ext) return false;
  return noteImportExts(settings).has(ext);
}

// ============ 子进程日志解码 ============
// Windows 下 pip/python 等子进程默认按控制台代码页（中文环境为 GBK）输出，直接按 UTF-8 解码
// 会把中文路径打成 ◆◆◆◆ 乱码；管道按块切分还可能把多字节字符拦腰截断产生替换符。双保险：
// 1) 给子进程注入 PYTHONUTF8/PYTHONIOENCODING，让 Python 系进程直接输出 UTF-8；
// 2) 流式解码器跨块保留末尾不完整序列，UTF-8 非法时回退 GBK（仅 Windows）。
// Windows 下 Python 的 httpx/urllib 会读注册表里的系统代理（WinINet 设置），本机一旦开代理，
// MinerU 本地 API 的 loopback 健康检查（http://127.0.0.1:<port>/health）也会被送到远程代理节点，
// 远端连不回本机端口 → 502 Bad Gateway → 健康检查永远不通过直到超时。
// 故对子进程注入 loopback 的 NO_PROXY 白名单（与已有配置合并，不影响外网走代理）。
const LOOPBACK_NO_PROXY = '127.0.0.1,localhost,::1';
function childUtf8Env(extra) {
  const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...(extra || {}) };
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const cur = String(env[key] || '').trim();
    env[key] = cur ? `${cur},${LOOPBACK_NO_PROXY}` : LOOPBACK_NO_PROXY;
  }
  return env;
}

function createChildStreamDecoder() {
  let pending = null;
  let gbk = null;
  const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);
  const decodeBuf = (buf) => {
    let text = new TextDecoder('utf-8').decode(buf);
    if (text.includes(REPLACEMENT_CHAR) && process.platform === 'win32') {
      if (gbk === null) { try { gbk = new TextDecoder('gbk'); } catch (_) { gbk = false; } }
      if (gbk) text = gbk.decode(buf);
    }
    return text;
  };
  return {
    push(chunk) {
      let buf = pending ? Buffer.concat([pending, chunk]) : chunk;
      pending = null;
      // 检查末尾是否为不完整的 UTF-8 多字节序列，是则截留到下一块拼接（最长 4 字节）
      let cut = 0;
      for (let i = 1; i <= Math.min(4, buf.length); i++) {
        const b = buf[buf.length - i];
        if ((b & 0xc0) === 0x80) { cut = i; continue; } // 延续字节，继续往前找首字节
        const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
        cut = need > i ? i : 0;
        break;
      }
      if (cut) { pending = buf.slice(buf.length - cut); buf = buf.slice(0, buf.length - cut); }
      return buf.length ? decodeBuf(buf) : '';
    },
    flush() {
      const rest = pending;
      pending = null;
      return rest ? decodeBuf(rest) : '';
    },
  };
}

// ============ 外部文档转换插件（本地 MinerU 等）============
// 内置解析只覆盖“文本型”文档；扫描件 PDF、图片、PPT/Keynote/plist 等格式需要外部工具转成 Markdown。
// 用户在 设置→文档解析 里配置一条命令模板（mineruConvertCmd），占位符：
//   {input}  源文件绝对路径   {output}  输出目录（临时目录，转换后自动清理）
// 未写占位符时按「命令 {input} {output}」追加。命令非 0 退出、超时或未产出 Markdown 均视为转换失败。
// MINERU_TIMEOUT_SEC 定义于 common/constants.js

function mineruCmdParts(settings) {
  // 解析方式开关：mineruMode='builtin' 时即使配置了命令也强制走内置解析；
  // 未设置（旧数据）或 'mineru'/'auto' 时按命令是否填写决定
  const mode = String((settings && settings.mineruMode) || 'auto');
  if (mode === 'builtin') return null;
  const raw = String((settings && settings.mineruConvertCmd) || '').trim();
  if (!raw) return null;
  const parts = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  return parts.map((p) => p.replace(/^"([^"]*)"$/, '$1').replace(/^'([^']*)'$/, '$1')).filter(Boolean);
}

function buildMineruArgv(parts, input, output) {
  const argv = parts.map((p) => p.split('{input}').join(input).split('{output}').join(output));
  if (!argv.some((a) => a.includes(input))) argv.push(input);
  if (!argv.some((a) => a.includes(output))) argv.push(output);
  return argv;
}

// ============ Ollama 服务按需自动启动 ============
// MinerU 包装脚本（mineru-run.bat）固定走 hybrid-http-client 后端，VLM 推理依赖本机 Ollama 服务
// （默认 http://127.0.0.1:11434）。Ollama 未启动时 MinerU 报「Failed to connect to server」并回退内置，
// 笔记质量明显下降。这里在跑 MinerU 转换前探测服务，未启动则自动拉起 ollama serve 并等待就绪。
// 就绪探测走 Node 原生 http 模块（不读系统代理，不会把 loopback 请求发到远端代理节点）。
function ollamaBaseUrlFromCmd(parts) {
  const joined = (parts || []).join(' ');
  const m = /-u\s+(\S+)/.exec(joined);
  const raw = m ? m[1] : MINERU_DEFAULT_OLLAMA_URL;
  return String(raw).replace(/\/+$/, '').replace(/\/v1$/i, '');
}
function pingOllama(baseUrl, timeoutMs = 3000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(baseUrl + '/api/version');
      const req = require('http').request({ hostname: u.hostname, port: u.port || 80, path: u.pathname, method: 'GET', timeout: timeoutMs }, (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 500);
      });
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
      req.end();
    } catch (_) { resolve(false); }
  });
}
// 自启动的 Ollama 进程句柄（detached + unref，应用退出不等待它；Ollama 作为本机服务继续运行）
let ollamaStartedByUs = null;
async function ensureOllamaServer(settings, onLog) {
  const parts = mineruCmdParts(settings);
  if (!parts || !parts.length) return; // 未配置 MinerU，无需拉起
  const baseUrl = ollamaBaseUrlFromCmd(parts);
  if (await pingOllama(baseUrl)) return; // 已在运行
  onLog(`⏳ Ollama 服务未运行（${baseUrl}），正在自动启动…`);
  let started = false;
  if (ollamaStartedByUs && !ollamaStartedByUs.killed && ollamaStartedByUs.exitCode === null) {
    started = true; // 已由本进程拉起，等待就绪即可
  } else {
    try {
      // 继承系统环境但不注入 NO_PROXY 等子进程改写（ollama serve 只需本机监听）
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
  onLog('⚠ Ollama 服务启动后 30 秒内未就绪，继续尝试转换（如失败请手动检查 ollama serve）');
}

// 递归收集目录下所有 .md（MinerU 会按 <文件名>/auto/<文件名>.md 之类结构产出），取内容最长者
function collectMarkdownFiles(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.md$/i.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

// 返回 { text, file }：file 为选中的 Markdown 绝对路径，供调用方定位其同级 images/ 目录
function pickBestMarkdown(outDir) {
  const files = collectMarkdownFiles(outDir);
  if (!files.length) return { text: '', file: '' };
  let best = '';
  let bestFile = '';
  for (const f of files) {
    try {
      const t = fs.readFileSync(f, 'utf-8');
      if (t.trim().length > best.trim().length) { best = t; bestFile = f; }
    } catch (_) { /* 忽略读失败的文件 */ }
  }
  return { text: best, file: bestFile };
}

// MinerU 把抽取图片放在 md 同级的 images/ 目录。临时产物目录即将被清理前，把该目录整体
// 搬到一个独立的暂存目录并返回其路径（无图片返回 null），让调用方来得及把图片迁进笔记附件目录
function stageMineruImages(mdFile) {
  if (!mdFile) return null;
  const src = path.join(path.dirname(mdFile), 'images');
  try {
    if (!fs.existsSync(src) || !fs.readdirSync(src).length) return null;
    const staging = path.join(os.tmpdir(), `synapse-mineru-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.renameSync(src, staging);
    return staging;
  } catch (_) { return null; }
}

// 从文件名派生可读标题：去掉扩展名；若文件名是 URL 编码（%E7%9F%A5…，常见于网页下载来源）则解码还原。
// 仅当含 %XX 十六进制序列时才尝试解码（避免误解普通含 % 的名字），解码失败回退原值
function titleFromFileName(name) {
  let title = String(name || '').replace(/\.[^.]+$/, '').trim();
  if (/%[0-9A-Fa-f]{2}/.test(title)) {
    try {
      const decoded = decodeURIComponent(title);
      if (decoded && decoded !== title) title = decoded;
    } catch (_) { /* 解码失败保留原值 */ }
  }
  return title || String(name || '');
}

// 把 MinerU 抽取的图片并入笔记附件目录，并把正文里的相对引用 images/xxx 改写为 kb-asset 绝对引用。
// 不做这一步，笔记正文的 ![](images/…) 全部是坏图（图片随 MinerU 临时目录被清理），与 MinerU 测试产物观感差异明显。
// imagesDir 为 convertWithMineru.lastImagesDir 捕获值；返回实际并入的图片数。跨目录用复制而非 rename（防 EXDEV）
function attachMineruImages(notePath, imagesDir) {
  if (!notePath || !imagesDir) return 0;
  let files = [];
  try { files = fs.readdirSync(imagesDir); } catch (_) { return 0; }
  if (!files.length) { try { fs.rmSync(imagesDir, { recursive: true, force: true }); } catch (_) {} return 0; }
  try {
    const assetDir = path.join(path.dirname(notePath), path.basename(notePath, '.md'));
    fs.mkdirSync(assetDir, { recursive: true });
    let moved = 0;
    for (const f of files) {
      const from = path.join(imagesDir, f);
      const to = path.join(assetDir, f);
      try {
        if (!fs.existsSync(to)) { fs.copyFileSync(from, to); moved++; }
      } catch (_) { /* 单张图失败不影响其余 */ }
    }
    if (moved) {
      const text = fs.readFileSync(notePath, 'utf-8');
      // 附件目录引用统一走 kbAssetUrlFor：逐段编码 ( ) 等保留字符，防目录名含括号时 Markdown 截断 URL
      const prefix = kbAssetUrlFor(assetDir) + '/';
      const updated = text.split('](images/').join('](' + prefix);
      if (updated !== text) fs.writeFileSync(notePath, updated, 'utf-8');
    }
    try { fs.rmSync(imagesDir, { recursive: true, force: true }); } catch (_) { /* 暂存目录清理失败可忽略 */ }
    return moved;
  } catch (_) { return 0; }
}

async function convertWithMineru(settings, absPath, opts = {}) {
  const parts = mineruCmdParts(settings);
  if (!parts || !parts.length) return null;
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  // hybrid-http-client 后端依赖本机 Ollama VLM 服务：MinerU 已配置而 Ollama 未启动时，
  // 应用自动拉起 ollama serve 并等待就绪，避免「Failed to connect to server http://localhost:11434」回退内置
  try { await ensureOllamaServer(settings, onLog); } catch (_) { /* 拉起失败不阻断，转换报错时如实展示原因 */ }
  // opts.outDir：调用方指定输出目录（如配置测试要保留产物），否则用临时目录并在结束后清理
  const keepOut = !!opts.outDir;
  const outDir = keepOut ? opts.outDir : fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-mineru-'));
  try {
    const argv = buildMineruArgv(parts, absPath, outDir);
    const timeoutMs = num(settings, 'mineruTimeout', MINERU_TIMEOUT_SEC, 10, 21600) * 1000;
    onLog('▶ 执行命令：' + argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '));
    await new Promise((resolve, reject) => {
      // Windows 上 Node ≥22 禁止无 shell 直接 spawn .bat/.cmd（EINVAL），须经 cmd /c 启动；
      // 其余平台/可执行文件保持直接 spawn（shell=true 会引入引号转义差异，不用）
      let spawnArgv = argv;
      if (process.platform === 'win32' && /\.(bat|cmd)$/i.test(argv[0])) {
        spawnArgv = ['cmd', '/c', ...argv];
      }
      const child = spawn(spawnArgv[0], spawnArgv.slice(1), { timeout: timeoutMs, env: childUtf8Env() });
      let tail = '';
      // 保留尾部若干非空行（stderr 报错通常在末尾），失败时拼进错误信息，
      // 否则回退日志只有「退出码 1」，用户无从知道是 Ollama 没起还是模型缺失
      const errTail = [];
      const remember = (line) => { errTail.push(line); if (errTail.length > 6) errTail.shift(); };
      const streamDec = createChildStreamDecoder();
      // tqdm 等进度条用 \r 原地刷新，仅按 \n 切行会把同一段进度反复追加成刷屏墙：
      // \r 也视为行分隔，且 \r 产出的行带 replace 标记（前端覆盖上一条进度行，实现原位更新效果）；
      // CRLF 视为单个换行；顺带剥离 ANSI 控制序列，避免日志出现乱码转义
      const push = (chunk) => {
        tail += streamDec.push(chunk);
        let m;
        while ((m = /[\r\n]/.exec(tail))) {
          let isCr = m[0] === '\r';
          let end = m.index + 1;
          if (isCr && tail[end] === '\n') { end += 1; isCr = false; }
          else if (isCr && end === tail.length) break; // \r 在缓冲末尾，等下一块判定是否 CRLF
          const line = tail.slice(0, m.index).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
          tail = tail.slice(end);
          if (line) { onLog(line, isCr); remember(line); }
        }
      };
      child.stdout.on('data', push);
      child.stderr.on('data', push);
      child.on('error', (err) => reject(new Error(`启动失败：${err.message}`)));
      child.on('close', (code, signal) => {
        tail += streamDec.flush();
        if (tail.trim()) {
          const last = tail.trim().replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
          onLog(last);
          remember(last);
        }
        if (code === 0) return resolve();
        const detail = errTail.filter(Boolean).slice(-3).join(' | ');
        reject(new Error(signal ? `被信号 ${signal} 终止（超时或外部 kill）` : `退出码 ${code}${detail ? `：${detail}` : ''}`));
      });
    });
    const { text: md, file: mdFile } = pickBestMarkdown(outDir);
    if (!md.trim()) throw new Error('转换完成但输出目录中没有 Markdown 文件');
    // 清理临时目录前把抽取图片暂存出来：否则图片随临时目录一起删除，
    // 笔记正文里的 images/xxx.jpg 全部变成坏图（与 MinerU 测试产物观感差异的根因之一）。
    // 经 opts.info 交还调用方（多文件并发提取时互不串扰，不能放全局静态字段）
    if (opts.info && typeof opts.info === 'object') {
      opts.info.imagesDir = keepOut ? path.join(path.dirname(mdFile), 'images') : stageMineruImages(mdFile);
    }
    return md;
  } finally {
    if (!keepOut) {
      try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) { /* 临时目录清理失败可忽略 */ }
    }
  }
}

// 配置测试用：内嵌 1 页极简 PDF（正文 "MinerU Config Test 2026"），
// 避免依赖用户本地文件；成功转换说明命令、依赖、模型链路全部打通
const MINERU_TEST_PDF_B64 = 'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA1NCA+PgpzdHJlYW0KQlQgL0YxIDE4IFRmIDcyIDcyMCBUZCAoTWluZXJVIENvbmZpZyBUZXN0IDIwMjYpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvRm9udCAvU3VidHlwZSAvVHlwZTEgL0Jhc2VGb250IC9IZWx2ZXRpY2EgPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAwMDAwMzQ1IDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNDE1CiUlRU9G';

// 配置测试：用内置样本或用户上传的 PDF 实跑一次转换。
// 产物（源文件 + MinerU 输出的 Markdown/JSON 等）保留在 <数据根>/test/<YYYY-MM-DD HH-mm-ss>/ 便于查看；
// 中间解析日志经 event 以 'mineru:test-log' 事件流式推送。
function testStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

async function runMineruTest(settings, { pdfBase64, fileName, event } = {}) {
  const send = (line, replace) => { try { if (event && event.sender) event.sender.send('mineru:test-log', { line, replace: !!replace }); } catch (_) { /* 忽略 */ } };
  const parts = mineruCmdParts({ ...settings, mineruMode: 'auto' });
  if (!parts || !parts.length) return { ok: false, error: '未配置文档转换命令，无法测试' };
  const outDir = path.join(dataRoot(), 'test', testStamp());
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `创建输出目录失败：${err.message}` };
  }
  const safeName = String(fileName || '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'mineru-config-test.pdf';
  const inputPath = path.join(outDir, safeName);
  try {
    if (pdfBase64) {
      fs.writeFileSync(inputPath, Buffer.from(pdfBase64, 'base64'));
      send(`📄 使用上传文件：${safeName}（${fs.statSync(inputPath).size} 字节）`);
    } else {
      fs.writeFileSync(inputPath, Buffer.from(MINERU_TEST_PDF_B64, 'base64'));
      send('📄 使用内置 1 页样本 PDF');
    }
    send(`📁 输出目录：${outDir}`);
    const started = Date.now();
    const md = await convertWithMineru(settings, inputPath, { onLog: send, outDir });
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const sample = (md || '').trim().split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3).join(' | ');
    send(`✅ 转换完成，耗时 ${elapsed}s，产出 ${md.length} 字符`);
    return { ok: true, elapsedSec: Number(elapsed), mdLength: md.length, sample: sample.slice(0, 200), outDir };
  } catch (err) {
    send(`❌ 转换失败：${err.message}`);
    return { ok: false, error: String(err && err.message || err), outDir };
  }
}

// Windows 中文路径绕行：fasttext 的 C++ 层用窄字符 ifstream 打开语言检测模型，走 ANSI 代码页，
// 打不开任何含中文的路径（venv 装在中文安装目录下时必然失败）。解法：建一个纯 ASCII 的目录
// junction 指向安装目录，经别名路径启动 python，使进程内 __file__/模型路径全部为 ASCII。
// junction 用 fs.symlinkSync(type=junction) 创建，Win10+ 无需管理员权限。
function ensureAsciiAlias(pluginDir, send) {
  // 纯 ASCII 别名目录候选列表定义于 common/constants.js
  const candidates = MINERU_ASCII_ALIAS_CANDIDATES(process.env);
  for (const alias of candidates) {
    let target = null;
    try { target = fs.readlinkSync(alias); } catch (_) { /* 不存在或不是 reparse 点 */ }
    if (target) {
      if (path.resolve(target) === path.resolve(pluginDir)) return alias; // 已指向当前安装目录
      try { fs.rmdirSync(alias); } catch (_) { continue; } // 指向旧位置：移除 junction 重建（rmdir 不删目标内容）
    } else if (fs.existsSync(alias)) continue; // 被真实目录占用，换候选
    try {
      fs.symlinkSync(pluginDir, alias, 'junction');
      send(`🔗 创建纯 ASCII 路径别名：${alias} → ${pluginDir}`);
      return alias;
    } catch (_) { /* 该候选不可写，试下一个 */ }
  }
  return null;
}

// ============ MinerU 一键安装 ============
// 本机没有 MinerU 环境时，在 <安装目录>/plugins/mineru/ 下自动创建：
//   venv/            Python 虚拟环境（python -m venv + pip install mineru）
//   mineru-run.sh    包装脚本（固化 hybrid-http-client 后端 + 本机 Ollama VLM 端点）
// 完成后返回包装脚本路径，前端据此回填「文档转换命令」并切到 MinerU 解析，完成配置。
// 中间日志经 event 以 'mineru:install-log' 流式推送，复用测试日志的展示组件。
function installMineru(settings, { event } = {}) {
  const send = (line, replace) => { try { if (event && event.sender) event.sender.send('mineru:install-log', { line, replace: !!replace }); } catch (_) { /* 忽略 */ } };
  const installTimeoutMs = MINERU_INSTALL_TIMEOUT_MS; // pip 安装 mineru 依赖较多，给 30 分钟
  const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
    // 强制 Python 子进程（venv/pip）输出 UTF-8，配合流式解码器消除 Windows GBK 乱码
    const child = spawn(cmd, args, { ...opts, env: childUtf8Env(opts.env) });
    let tail = '';
    const streamDec = createChildStreamDecoder();
    const push = (chunk) => {
      tail += streamDec.push(chunk);
      let m;
      while ((m = /[\r\n]/.exec(tail))) {
        let isCr = m[0] === '\r';
        let end = m.index + 1;
        if (isCr && tail[end] === '\n') { end += 1; isCr = false; }
        else if (isCr && end === tail.length) break;
        const line = tail.slice(0, m.index).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
        tail = tail.slice(end);
        if (line) send(line, isCr);
      }
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('error', (err) => reject(new Error(`启动失败：${err.message}`)));
    child.on('close', (code, signal) => {
      tail += streamDec.flush();
      if (tail.trim()) send(tail.trim().replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''));
      if (code === 0) return resolve();
      reject(new Error(signal ? `被信号 ${signal} 终止（超时或外部 kill）` : `退出码 ${code}`));
    });
  });
  return (async () => {
    const appDir = path.resolve(dataRoot(), '..'); // 数据根默认 <安装目录>/data，其上级即安装目录
    const pluginDir = path.join(appDir, PLUGINS_DIR, MINERU_PLUGIN_DIR);
    const venvDir = path.join(pluginDir, 'venv');
    const isWin = process.platform === 'win32';
    const pyBin = isWin ? path.join(venvDir, 'Scripts', 'python.exe') : path.join(venvDir, 'bin', 'python');
    const mineruBin = isWin ? path.join(venvDir, 'Scripts', 'mineru.exe') : path.join(venvDir, 'bin', 'mineru');
    const runnerPath = path.join(pluginDir, isWin ? 'mineru-run.bat' : 'mineru-run.sh');
    fs.mkdirSync(pluginDir, { recursive: true });
    send(`📁 安装目录：${pluginDir}`);
    const py = (() => {
      for (const c of ['python3', 'python']) {
        try {
          const v = require('child_process').execSync(`${c} --version`, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
          send(`🐍 使用系统 Python：${c}（${v}）`);
          return c;
        } catch (_) { /* 试下一个 */ }
      }
      return null;
    })();
    if (!py) throw new Error('未找到系统 Python（python3 / python），请先安装 Python 3.9+');
    // 中文安装目录先建纯 ASCII 别名，再经别名做后续启动验证（fasttext 打不开中文路径）
    const aliasDir = isWin && /[^\x00-\x7f]/.test(pluginDir) ? ensureAsciiAlias(pluginDir, send) : null;
    const checkPyBin = aliasDir ? path.join(aliasDir, path.relative(pluginDir, pyBin)) : pyBin;
    // 完整性检查：仅存在 mineru 可执行文件不够，hybrid 后端还需 torch 等 pipeline 依赖；
    // 直接导入 hybrid_analyze 入口，能连 mineru 未声明的运行时依赖（如 six）一起验证
    const venvReady = fs.existsSync(mineruBin) && (() => {
      try {
        require('child_process').execFileSync(checkPyBin, ['-c', 'import mineru.backend.hybrid.hybrid_analyze'], { stdio: ['ignore', 'pipe', 'pipe'] });
        return true;
      } catch (_) { return false; }
    })();
    if (venvReady) {
      send('♻️ 已存在完整的 MinerU 环境，跳过创建与安装');
    } else {
      if (!fs.existsSync(mineruBin)) {
        send('🧱 创建 Python 虚拟环境 venv/（首次约几十秒）…');
        await run(py, ['-m', 'venv', venvDir], { timeout: 5 * 60 * 1000 });
      } else {
        send('⚠️ 检测到已有环境缺少 pipeline 依赖（如 torch），将补装…');
      }
      // 必须装 pipeline extras：hybrid-http-client 后端依赖本地 torch/transformers 等
      send('📦 安装 mineru[pipeline]（含 torch 等大依赖，可能 5–20 分钟，进度见下方日志）…');
      await run(pyBin, ['-m', 'pip', 'install', '--upgrade', 'pip'], { timeout: 10 * 60 * 1000 });
      await run(pyBin, ['-m', 'pip', 'install', 'mineru[pipeline]'], { timeout: installTimeoutMs });
      // mineru 3.4.x 的 hybrid 后端运行期还用到一批未在 extras 里声明的包（如 six、pandas、accelerate），
      // 缺了会在首次转换时报 hybrid 依赖错误，这里一并装上，保证一键安装后开箱即用
      send('📦 补装运行期附加依赖（six/pandas/accelerate 等）…');
      await run(pyBin, ['-m', 'pip', 'install', ...MINERU_EXTRA_PACKAGES], { timeout: 10 * 60 * 1000 });
    }
    if (!fs.existsSync(mineruBin)) throw new Error('安装完成但未找到 mineru 可执行文件：' + mineruBin);
    // 包装脚本：与既有手动脚本同款语义（hybrid-http-client + 本机 Ollama 端点）
    const ollamaUrl = String((settings && settings.mineruOllamaUrl) || MINERU_DEFAULT_OLLAMA_URL);
    const vlmModel = String((settings && settings.mineruVlmModel) || MINERU_DEFAULT_VLM_MODEL);
    writeMineruRunnerScript({ pluginDir, venvDir, aliasDir, runnerPath, ollamaUrl, vlmModel, apiKey: '' });
    send(`✅ 安装完成：${runnerPath}`);
    return { ok: true, runner: runnerPath, venvDir, pluginDir };
  })().catch((err) => {
    send(`❌ 安装失败：${err.message}`);
    return { ok: false, error: String(err && err.message || err) };
  });
}

// 包装脚本生成：把后端参数与模型端点固化进 plugins/mineru 下的 bat/sh。
// 一键安装与「应用模型」共用，保证两条路径产物一致。
// Windows 两条硬约束：1) cmd.exe 按 GBK 解析 .bat 且不认 UTF-8 BOM，bat 内容必须纯 ASCII；
// 2) fasttext C++ 层打不开含中文的模型路径，python 必须经纯 ASCII 路径启动（aliasDir 为 junction 别名）
function writeMineruRunnerScript({ pluginDir, venvDir, aliasDir, runnerPath, ollamaUrl, vlmModel, apiKey }) {
  const isWin = process.platform === 'win32';
  const pyBin = isWin ? path.join(venvDir, 'Scripts', 'python.exe') : path.join(venvDir, 'bin', 'python');
  const mineruBin = isWin ? path.join(venvDir, 'Scripts', 'mineru.exe') : path.join(venvDir, 'bin', 'mineru');
  const key = String(apiKey || '').trim();
  if (isWin) {
    // 安装目录为纯 ASCII 时直接用 %~dp0 相对路径起 python；含中文时经 ASCII junction
    // 别名用 python -m mineru.cli.client 启动，bat 内若 junction 缺失则在运行期自愈重建
    const relPy = path.relative(pluginDir, pyBin);
    const keyLine = key ? `set MINERU_VL_API_KEY=${key}\r\n` : '';
    let batBody;
    if (aliasDir) {
      // 中文安装目录：经 ASCII 别名启动 python -m；junction 被外部删除时运行期自愈重建，
      // 目标用 %~dp0（bat 自身目录，cmd 运行期 Unicode 展开）传入，保证 bat 全文纯 ASCII
      const pyExe = path.join(aliasDir, relPy);
      batBody = `@echo off\r\nset MINERU_VL_MODEL_NAME=${vlmModel}\r\n${keyLine}set "PYEXE=${pyExe}"\r\nif not exist "%PYEXE%" mklink /J "${aliasDir}" "%~dp0" >nul 2>&1\r\n"%PYEXE%" -m mineru.cli.client -b hybrid-http-client -u ${ollamaUrl} %*\r\n`;
    } else {
      // 纯 ASCII 安装目录：%~dp0（bat 自身目录，运行期展开）+ 相对路径，天然无代码页问题
      batBody = `@echo off\r\nset MINERU_VL_MODEL_NAME=${vlmModel}\r\n${keyLine}"%~dp0${relPy}" -m mineru.cli.client -b hybrid-http-client -u ${ollamaUrl} %*\r\n`;
    }
    fs.writeFileSync(runnerPath, batBody);
  } else {
    const keyLine = key ? `export MINERU_VL_API_KEY="${key}"\n` : '';
    fs.writeFileSync(runnerPath, `#!/bin/bash\n# Synapse MinerU 包装脚本：固化环境变量与后端参数\nexport MINERU_VL_MODEL_NAME="${vlmModel}"\n${keyLine}exec "${mineruBin}" \\\n  -b hybrid-http-client \\\n  -u ${ollamaUrl} \\\n  "$@"\n`, { mode: 0o755 });
    try { fs.chmodSync(runnerPath, 0o755); } catch (_) { /* 忽略 */ }
  }
  return runnerPath;
}

// 把「模型配置」里选定的模型应用到 MinerU：重写包装脚本的模型名/端点（不动 venv）。
// entry: { provider, model, baseUrl, apiKey }，来自前端模型列表（主模型或更多模型）。
// MinerU 的 -u 需要服务器根地址，前端 Base URL 通常带 /v1 后缀（OpenAI 兼容约定），此处剥离；
// 非本地模型（如百炼）的 API Key 经 MINERU_VL_API_KEY 环境变量注入包装脚本
function applyMineruModel(settings, entry = {}, { event } = {}) {
  const send = (line) => { try { if (event && event.sender) event.sender.send('mineru:install-log', { line }); } catch (_) { /* 忽略 */ } };
  try {
    const model = String(entry.model || '').trim();
    const baseUrl = String(entry.baseUrl || '').trim();
    if (!model || !baseUrl) return { ok: false, error: '所选模型缺少模型名或 Base URL，请先在「模型配置」补全' };
    const ollamaUrl = baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');
    const appDir = path.resolve(dataRoot(), '..'); // 数据根默认 <安装目录>/data，其上级即安装目录
    const pluginDir = path.join(appDir, PLUGINS_DIR, MINERU_PLUGIN_DIR);
    const venvDir = path.join(pluginDir, 'venv');
    const isWin = process.platform === 'win32';
    const mineruBin = isWin ? path.join(venvDir, 'Scripts', 'mineru.exe') : path.join(venvDir, 'bin', 'mineru');
    if (!fs.existsSync(mineruBin)) return { ok: false, error: '未找到 MinerU 环境，请先点击「一键自动安装」' };
    const aliasDir = isWin && /[^\x00-\x7f]/.test(pluginDir) ? ensureAsciiAlias(pluginDir, send) : null;
    const runnerPath = path.join(pluginDir, isWin ? 'mineru-run.bat' : 'mineru-run.sh');
    writeMineruRunnerScript({ pluginDir, venvDir, aliasDir, runnerPath, ollamaUrl, vlmModel: model, apiKey: entry.apiKey || '' });
    send(`✅ MinerU 已切换模型：${model} @ ${ollamaUrl}`);
    return { ok: true, runner: runnerPath, ollamaUrl, vlmModel: model };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

async function extractFileContentRaw(absPath, settings, opts = {}) {
  const ext = path.extname(absPath).toLowerCase();
  const buffer = fs.readFileSync(absPath);
  extractFileContentRaw.lastExternalError = '';
  extractFileContentRaw.lastParseMethod = '';
  const setInfo = (k, v) => { if (opts && opts.info) opts.info[k] = v; };
  setInfo('externalError', '');
  setInfo('parseMethod', '');
  // 配置了外部转换（本地 MinerU 等）时，二进制文档优先走插件：扫描件 PDF/图片等内置解析拿不到
  // 文本，插件产出结构化 Markdown 质量更高；插件失败再回退内置解析。纯文本类仍走内置（快且稳）
  const external = mineruCmdParts(settings);
  const preferExternal = !TEXTUAL_EXTS.includes(ext);
  // 强制 MinerU 模式（作业「用 MinerU 重跑」）：未配置转换命令直接报错，不做内置回退
  if (opts.forceMineru && preferExternal && !(external && external.length)) {
    throw new Error('未配置 MinerU 转换命令（设置→文档解析），无法强制 MinerU 解析');
  }
  if (external && external.length && preferExternal) {
    try {
      // opts.onLog：调用方（作业）注入的日志回调，MinerU 子进程输出逐行上抛，实现解析过程实时展示
      const md = await convertWithMineru(settings, absPath, { info: opts.info, onLog: opts.onLog });
      if (md && md.trim()) {
        extractFileContentRaw.lastParseMethod = 'mineru';
        setInfo('parseMethod', 'mineru');
        // opts.info.imagesDir 已由 convertWithMineru 填入本次转换暂存的图片目录（可能为 null）
        return md;
      }
      extractFileContentRaw.lastExternalError = 'MinerU 转换输出为空';
      setInfo('externalError', extractFileContentRaw.lastExternalError);
    } catch (err) {
      // 记录失败原因，内置解析也失败时一并带出，便于在作业里定位
      extractFileContentRaw.lastExternalError = `MinerU 转换失败：${err.message}`;
      setInfo('externalError', extractFileContentRaw.lastExternalError);
    }
    appendMineruFallbackLog(absPath, extractFileContentRaw.lastExternalError);
    // 强制 MinerU 模式：不回退内置解析，直接失败，避免再次静默产出低质量内置文本
    if (opts.forceMineru) throw new Error(extractFileContentRaw.lastExternalError);
  }
  // 走到这里即内置解析分支（default 抛错不计）
  extractFileContentRaw.lastParseMethod = 'builtin';
  setInfo('parseMethod', 'builtin');
  switch (ext) {
    case '.md':
    case '.markdown':
    case '.txt':
    case '.csv':
    case '.json':
    case '.log':
      return buffer.toString('utf-8');
    case '.html':
    case '.htm': {
      const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
      return turndown.turndown(buffer.toString('utf-8'));
    }
    case '.pdf': {
      const parser = new PDFParse({ data: buffer });
      try {
        const res = await parser.getText();
        return res.text || '';
      } finally {
        parser.destroy();
      }
    }
    case '.docx': {
      const result = await mammoth.convertToHtml({ buffer });
      const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
      return turndown.turndown(result.value);
    }
    case '.xlsx':
    case '.xls': {
      const wb = XLSX.read(buffer, { type: 'buffer' });
      return wb.SheetNames.map((name) => {
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
        return `## 工作表：${name}\n\n\`\`\`\n${csv}\n\`\`\``;
      }).join('\n\n');
    }
    case '.pptx': {
      const zip = await JSZip.loadAsync(buffer);
      const slideNames = Object.keys(zip.files)
        .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
        .sort((a, b) => {
          const num = (s) => parseInt(s.match(/slide(\d+)/)[1], 10);
          return num(a) - num(b);
        });
      const parts = [];
      for (let i = 0; i < slideNames.length; i++) {
        const xml = await zip.files[slideNames[i]].async('string');
        const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXmlEntities(m[1]));
        if (texts.length) parts.push(`## 幻灯片 ${i + 1}\n\n${texts.join('\n')}`);
      }
      return parts.join('\n\n');
    }
    default: {
      // 内置解析不支持的格式：若配置了外部插件，上面已尝试过并回退到此；带上失败原因便于定位
      const hint = extractFileContentRaw.lastExternalError
        ? `（${extractFileContentRaw.lastExternalError}）`
        : '（可在 设置→文档解析 配置本地 MinerU 转换命令处理该格式）';
      throw new Error(`不支持的文件格式：${ext || '无扩展名'}${hint}`);
    }
  }
}

// ============ 提取结果磁盘缓存 ============
// 问答扫描原始文件时，富文本（pdf/docx/…）每次都要整篇提取；配置了 MinerU 时一个 PDF
// 甚至要跑一次完整转换（数十秒到数分钟），且串行扫描下同一文件反复提取 → 界面卡几十分钟。
// 缓存以「路径 + 大小 + mtime」为键落盘，文件不变直接复用；多进程（Web/桌面）共享同一数据根，天然共用。
// forceMineru（作业「用 MinerU 重跑」）不读缓存，保证强制重跑语义。
const EXTRACT_CACHE_DIR = () => path.join(dataRoot(), 'extract-cache');
const CACHE_MAX_BYTES = 5 * 1024 * 1024; // 单条缓存上限：检索本就只取头部，超大全文不必落盘
// 文本型扩展：按设计固定走内置解析，不经过 MinerU（与 extractFileContentRaw 的 preferExternal 同口径）
const TEXTUAL_EXTS = ['.md', '.markdown', '.txt', '.csv', '.json', '.log', '.html', '.htm'];
// MinerU 失败回退产物的缓存有效期：期内复用避免扫描/作业反复跑分钟级且必失败的转换；
// 过期自动视为未命中重试 MinerU（修好代理/模型后无需手动清缓存）。「用 MinerU 重跑」始终绕过缓存
const FALLBACK_CACHE_TTL_MS = 10 * 60 * 1000;
let cachePrunedAt = 0;
function extractCacheKey(absPath) {
  let st;
  try { st = fs.statSync(absPath); } catch (_) { return null; }
  const id = crypto.createHash('sha1').update(String(absPath)).digest('hex').slice(0, 16);
  return { id, size: st.size, mtime: Math.round(st.mtimeMs) };
}
function extractCachePath(id) { return path.join(EXTRACT_CACHE_DIR(), `${id}.json`); }
function readExtractCache(absPath, settings) {
  const key = extractCacheKey(absPath);
  if (!key) return null;
  try {
    const j = JSON.parse(fs.readFileSync(extractCachePath(key.id), 'utf-8'));
    if (j && j.size === key.size && j.mtime === key.mtime) {
      const textual = TEXTUAL_EXTS.includes(path.extname(String(absPath)).toLowerCase());
      const mineruOn = !!(mineruCmdParts(settings) || []).length;
      const out = { text: String(j.text || ''), reason: String(j.reason || '') };
      if (j.method === 'mineru') return { ...out, method: 'mineru' };
      if (j.method === 'fallback') {
        // MinerU 已不再配置：回退文本即正确结果；仍在 TTL 内：复用避免反复跑必失败的转换
        if (!mineruOn || Date.now() - (j.at || 0) <= FALLBACK_CACHE_TTL_MS) return { ...out, method: 'builtin' };
        return null; // TTL 过期：重试 MinerU
      }
      if (j.method === 'builtin') {
        // 文本型或未配 MinerU：内置结果一直有效；二进制型后来配置了 MinerU 则应重试 MinerU
        if (textual || !mineruOn) return { ...out, method: 'builtin' };
        return null;
      }
      // 无解析方式标记的旧条目（可能是失败回退的低质量文本）：视为未命中，重新提取并覆盖
      return null;
    }
  } catch (_) { /* 无缓存/损坏 → 重新提取 */ }
  return null;
}
function writeExtractCache(absPath, text, method, reason) {
  const key = extractCacheKey(absPath);
  if (!key || String(text || '').length > CACHE_MAX_BYTES) return;
  try {
    fs.mkdirSync(EXTRACT_CACHE_DIR(), { recursive: true });
    fs.writeFileSync(extractCachePath(key.id), JSON.stringify({ path: String(absPath), size: key.size, mtime: key.mtime, at: Date.now(), method: method || 'builtin', reason: String(reason || ''), text: String(text || '') }));
    // 低频清理：缓存目录超 60MB 时按修改时间保留最新 200 条（扫描路径高频调用，不能每次全量排序）
    const now = Date.now();
    if (now - cachePrunedAt > 60000) {
      cachePrunedAt = now;
      try {
        const entries = fs.readdirSync(EXTRACT_CACHE_DIR()).map((f) => {
          try { return { f, st: fs.statSync(path.join(EXTRACT_CACHE_DIR(), f)) }; } catch (_) { return null; }
        }).filter(Boolean);
        const total = entries.reduce((a, e) => a + e.st.size, 0);
        if (total > 60 * 1024 * 1024) {
          entries.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
          for (const e of entries.slice(200)) { try { fs.unlinkSync(path.join(EXTRACT_CACHE_DIR(), e.f)); } catch (_) {} }
        }
      } catch (_) { /* 清理失败不影响主流程 */ }
    }
  } catch (_) { /* 缓存写失败不影响主流程 */ }
}
// 对外入口：带缓存的提取。静态属性（lastParseMethod/lastExternalError，jobs.js 读取）
// 在真实跑解析时由 extractFileContentRaw 维护；命中缓存时沿用条目记录的解析方式（如实展示）。
// opts.noCache：跳过读缓存每次重新生成（提取笔记作业/单文件提取使用，用户要求产物始终为最新解析）；
// 问答扫描（readRawText 等）不传该项，仍走缓存避免反复跑分钟级 MinerU 转换。新生成结果照常落盘刷新缓存。
async function extractFileContent(absPath, settings, opts = {}) {
  if (!(opts && opts.forceMineru) && !(opts && opts.noCache)) {
    const hit = readExtractCache(absPath, settings);
    if (hit) {
      extractFileContent.lastParseMethod = hit.method;
      extractFileContent.lastExternalError = hit.reason;
      if (opts && opts.info) {
        opts.info.parseMethod = hit.method;
        opts.info.externalError = hit.reason;
        opts.info.imagesDir = null;
        opts.info.fromCache = true;
      }
      return hit.text;
    }
  }
  const text = await extractFileContentRaw(absPath, settings, opts);
  // 落盘策略：MinerU 产物昂贵（单次几十秒到分钟）长期复用；文本型/未配 MinerU 的内置结果也长期复用；
  // 二进制型在配了 MinerU 时的失败回退产物只缓存 TTL 期（reason 一并落盘，命中时作业能展示真实失败原因），
  // 过期自动重试 MinerU，避免低质量文本被永久固化
  const method = (opts.info && opts.info.parseMethod) || extractFileContentRaw.lastParseMethod || 'builtin';
  const textual = TEXTUAL_EXTS.includes(path.extname(String(absPath)).toLowerCase());
  const mineruOn = !!(mineruCmdParts(settings) || []).length;
  if (method === 'mineru') writeExtractCache(absPath, text, 'mineru');
  else if (!mineruOn || textual) writeExtractCache(absPath, text, 'builtin');
  else writeExtractCache(absPath, text, 'fallback', (opts.info && opts.info.externalError) || extractFileContentRaw.lastExternalError || 'MinerU 转换失败');
  return text;
}
extractFileContent.lastParseMethod = '';
extractFileContent.lastExternalError = '';
// 供 readRawText 等不走包装层的调用点回填解析方式
function markExtractInfo(opts, method) {
  if (opts && opts.info) { opts.info.parseMethod = method; opts.info.externalError = ''; }
}

// 拉取网页并转为 Markdown（url: 链接引用读取时调用）：带超时，避免无响应站点挂起流程
// 登录态三级利用：① 注入持久化 Cookie（kv，桌面/Web 通用）→ ② 桌面端 ses.fetch 自带会话 →
// ③ 仍是 SPA 空壳/被重定向到登录页时，隐藏窗真实渲染（带 defaultSession Cookie）抽取正文
async function fetchUrlMarkdown(url, timeoutSec) {
  const timeout = timeoutSec || 30;
  const headers = { 'User-Agent': 'Mozilla/5.0 (personal-kb)' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout * 1000);
  let resp;
  // 持久化登录 Cookie（kv，桌面/Web 通用）：Web 模式注入请求头；桌面端 ses.fetch 自带会话，
  // 但后续文档 API 直拉走全局 fetch，同样需要带上
  let cookieHdr = '';
  try { cookieHdr = require('./urlcookies').cookieHeaderForUrl(url); } catch (_) { /* 无 Cookie 模块时按匿名抓取 */ }
  try {
    let electron;
    try { electron = require('electron'); } catch (_) { electron = null; }
    const ses = electron && electron.session && electron.session.defaultSession;
    if (ses && typeof ses.fetch === 'function') {
      // 桌面端：启动时已把持久化 Cookie 回填 defaultSession，ses.fetch 自动携带
      resp = await ses.fetch(url, { headers, signal: ctrl.signal });
    } else {
      // Web 模式无会话：注入持久化在 kv 的登录 Cookie 带登录态
      if (cookieHdr) headers.Cookie = cookieHdr;
      resp = await fetch(url, { headers, signal: ctrl.signal });
    }
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) throw new Error(`网页拉取失败 (HTTP ${resp.status})`);
  // 按响应头/<meta charset> 解码（网易等站点用 GBK，resp.text() 强按 UTF-8 会乱码）
  const buf = Buffer.from(await resp.arrayBuffer());
  const probe = buf.toString('latin1');
  const cs = ((resp.headers.get('content-type') || '').match(/charset=["']?([\w-]+)/i)
    || probe.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1] || 'utf-8';
  let html;
  try { html = new TextDecoder(cs).decode(buf); } catch (_) { html = buf.toString('utf-8'); }
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  let body = turndown.turndown(html);
  body = body.split('\n').filter((l) => !/^\s*(var |window\.|function\(|\{)/.test(l)).join('\n');
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';

  // 语雀类 SPA：首屏 HTML 只有元数据，正文由前端异步调文档 API 拉取。
  // 服务端带 Cookie 复刻同一 API 调用即可拿权威完整正文（Web 模式同样可用），优先采用
  const apiHeaders = cookieHdr ? { ...headers, Cookie: cookieHdr } : headers;
  const yq = await fetchYuqueLikeContent(url, html, apiHeaders);
  if (yq && yq.body) return formatUrlDoc(yq.title || title || url, url, yq.body);

  // 其它 SPA 内嵌数据兜底：知乎等把正文写在 window.__INITIAL_STATE__ 等 JSON 里，
  // 服务端抓取即可提取（Web 模式无渲染能力时也能拿到正文），命中则直接返回
  const embedded = extractEmbeddedContent(html);
  if (embedded && embedded.body) return formatUrlDoc(embedded.title || title || url, url, embedded.body);

  // 语雀等 SPA 服务端只返回占位壳（正文是水合后才写上的），或被重定向到登录页（登录态缺失/过期）：
  // 两种情况服务端抓取都拿不到正文，回退隐藏窗真实渲染（仅桌面端，带会话 Cookie）
  let weblogin;
  try { weblogin = require('./weblogin'); } catch (_) { weblogin = null; }
  const redirectedToLogin = !!(weblogin && resp.url && weblogin.looksLikeLoginUrl(resp.url));
  const hasBrowser = !!(weblogin && weblogin.hasBrowser());
  if (redirectedToLogin || isShellBody(body, html)) {
    if (hasBrowser) {
      const r = await weblogin.renderPageBody(url, Math.min(25, timeout) * 1000);
      if (r.ok && r.body) return formatUrlDoc(r.title || title || url, url, r.body);
      if (r.login) throw new Error('该链接需要登录才能查看正文：请删除后重新添加该链接，在弹出的登录窗完成登录（可填用户名密码），登录态会被保留');
    }
    if (redirectedToLogin) {
      // Web 模式无登录窗：引导到桌面端登录一次，Cookie 落库后本模式即可复用
      throw new Error(hasBrowser
        ? '该链接需要登录才能查看正文：请删除后重新添加该链接并完成登录'
        : '该链接需要登录才能查看正文：请先在桌面端应用中删除并重新添加该链接、完成登录（登录态会同步到本模式）');
    }
  }
  return formatUrlDoc(title || url, url, body);
}

// 统一「# 标题 + 来源 + 正文」的输出格式
function formatUrlDoc(title, url, body) {
  return `# ${title}\n\n> 来源 URL: ${url}\n\n${body}`;
}

// 判断服务端抓取是否只拿到 SPA 空壳/占位页：正文文本过少，或标题为占位符（loading 之类）
function isShellBody(markdownBody, html) {
  const text = String(markdownBody || '').replace(/\s+/g, '');
  if (text.length >= 300) return false;
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m && isPlaceholderTitle(m[1])) return true;
  return text.length < 100;
}

// SPA 内嵌数据提取：语雀/知乎等把正文写在 window.appData / __INITIAL_STATE__ 等内联 JSON 里，
// 服务端抓取即可直接拿到（无需渲染，Web 模式也能用）。尽力而为，找不到返回 null。
// 注意两点：① 页面里锚点会出现多次，前面多是 `window.appData && ...` 的引用代码，
// 真正赋值在后半页，必须扫到「锚点 + =」的赋值点而非第一处出现；
// ② 赋值右侧不一定是对象字面量，语雀用 JSON.parse(decodeURIComponent("%7B...")) 的编码串形式。
function extractEmbeddedContent(html) {
  const text = String(html || '');
  const anchors = ['window.appData', 'window.__INITIAL_STATE__', 'window.__NUXT__'];
  for (const key of anchors) {
    const obj = parseFirstEmbeddedObject(text, key);
    if (!obj) continue;
    const found = findEmbeddedDoc(obj);
    if (found && found.body) return found;
  }
  return null;
}

// 按顺序扫描「锚点 = ...」赋值点，解析右侧值（对象字面量 / JSON.parse / decodeURIComponent 形式），
// 返回第一个成功解析出的对象；一个都没有返回 null。
function parseFirstEmbeddedObject(text, key) {
  let from = 0;
  for (;;) {
    const i = String(text).indexOf(key, from);
    if (i < 0) return null;
    from = i + 1;
    let p = i + key.length;
    while (p < text.length && /\s/.test(text[p])) p++;
    if (text[p] !== '=') continue; // 非赋值（引用/属性访问）跳过
    p++;
    while (p < text.length && /\s/.test(text[p])) p++;
    const obj = parseEmbeddedValue(text, p);
    if (obj && typeof obj === 'object') return obj;
  }
}

// 解析内嵌赋值的右侧，支持三种形式：
//   { ... }                                  对象字面量（括号配对截取后 JSON.parse）
//   JSON.parse("...")                        内联 JSON 字符串
//   JSON.parse(decodeURIComponent("%7B...")) 百分号编码串（语雀实际使用的形式）
// 解析失败返回 null，由调用方继续找下一个赋值点。
function parseEmbeddedValue(text, p) {
  if (text[p] === '{') {
    const jsonText = sliceBalancedBraces(text, p);
    if (!jsonText) return null;
    try { return JSON.parse(jsonText); } catch (_) { return null; }
  }
  const head = text.slice(p, p + 64);
  const m = /^JSON\.parse\(\s*(?:decodeURIComponent\s*\(\s*)?(["'])/.exec(head);
  if (!m) return null;
  const quote = m[1];
  const strStart = p + m[0].length;
  // 按字符串字面量规则找到结束引号（跳过转义字符），保留原始转义序列交给 JSON.parse 还原
  let q = strStart;
  let esc = false;
  for (; q < text.length; q++) {
    const ch = text[q];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === quote) break;
  }
  if (q >= text.length) return null;
  const lit = text.slice(strStart, q);
  let raw;
  try { raw = JSON.parse(quote + lit + quote); } catch (_) { raw = lit; }
  if (m[0].includes('decodeURIComponent')) {
    try { raw = decodeURIComponent(raw); } catch (_) { return null; }
  }
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// 从指定位置的 { 起按括号配对截取完整 JSON 文本（跳过字符串内的括号），超长/不配对返回空
function sliceBalancedBraces(text, start) {
  let depth = 0;
  let inStr = false;
  let quote = '';
  let esc = false;
  const MAX = 8 * 1024 * 1024; // 内嵌数据超过 8MB 视为异常，放弃
  for (let i = start; i < text.length && i - start < MAX; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === quote) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = true; quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return '';
}

// 语雀类文档正文 API 直拉：首屏 appData 里有 doc.slug / doc.book_id，
// 前端水合时调 /api/docs/{slug}?book_id=... 拿正文（lake HTML）。服务端带 Cookie 复刻该调用，
// 不依赖浏览器渲染，Web 模式也能拿到完整正文。返回 { title, body }，失败返回 null 走后续兜底。
async function fetchYuqueLikeContent(url, html, headers) {
  const meta = extractYuqueDocMeta(html);
  if (!meta) return null;
  let base;
  try { base = new URL(url).origin; } catch (_) { return null; }
  const api = `${base}/api/docs/${encodeURIComponent(meta.slug)}?book_id=${encodeURIComponent(meta.bookId)}`;
  // 主流程的超时控制器可能已解除，这里单独限时，避免 API 无响应挂起整个读取
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20000);
  try {
    const r = await fetch(api, {
      headers: { ...headers, Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      signal: ac.signal,
      redirect: 'follow',
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    const d = j && (j.data || j);
    if (!d || typeof d !== 'object') return null;
    const bodyHtml = (typeof d.content === 'string' && d.content) || (typeof d.body_html === 'string' && d.body_html) || (typeof d.body === 'string' && d.body) || '';
    if (bodyHtml.length < 200) return null;
    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    const body = td.turndown(bodyHtml);
    if (body.replace(/\s+/g, '').length < 100) return null;
    return { title: d.title || meta.title || '', body };
  } catch (_) {
    return null; // API 不可用/未登录等，交由后续兜底
  } finally {
    clearTimeout(t);
  }
}

// 从首屏 HTML 提取文档元数据（slug/book_id/title）：优先解码 appData 真实赋值的 doc 对象，
// 失败再用正则在 HTML 里直接匹配字段（兼容内嵌结构变化的站点）
function extractYuqueDocMeta(html) {
  const text = String(html || '');
  const obj = parseFirstEmbeddedObject(text, 'window.appData');
  const doc = obj && obj.doc;
  if (doc && doc.slug) return { slug: String(doc.slug), bookId: String(doc.book_id || ''), title: String(doc.title || '') };
  const slug = (text.match(/["']slug["']\s*:\s*["']([\w-]{6,64})["']/) || [])[1];
  const bookId = (text.match(/["']book_id["']\s*:\s*(\d+)/) || [])[1];
  if (slug && bookId) return { slug, bookId, title: '' };
  return null;
}

// 在内嵌对象里找文档正文：递归搜 body/content 类字段，取最长的可读文本；
// 标题必须与正文取自同一节点对象，避免张冠李戴。限制深度与节点数，避免超大 JSON 拖慢读取。
function findEmbeddedDoc(obj) {
  const BODY_KEYS = /^(body_html|content_html|body|content|body_draft|description)$/i;
  let bestBody = '';
  let bestTitle = '';
  let nodes = 0;
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 12 || nodes > 20000) return;
    nodes++;
    if (Array.isArray(node)) {
      for (const it of node) walk(it, depth + 1);
      return;
    }
    // 同一节点内先收标题与正文候选，正文更长时整体替换（标题随之更新）
    let titleHere = '';
    let bodyHere = '';
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string') {
        if (/^title$/i.test(k) && v.trim() && !isPlaceholderTitle(v)) titleHere = v.trim();
        else if (BODY_KEYS.test(k) && v.length >= 200 && v.length > bodyHere.length) bodyHere = v;
      } else if (v && typeof v === 'object') {
        walk(v, depth + 1);
      }
    }
    if (bodyHere.length > bestBody.length) { bestBody = bodyHere; bestTitle = titleHere; }
  };
  walk(obj, 0);
  if (!bestBody) return null;
  // 内嵌正文多为 HTML 或 lake 富文本：含标签则转 Markdown，否则按纯文本
  let body = bestBody;
  if (/<[a-z][\s\S]*?>/i.test(body.slice(0, 2000))) {
    try {
      const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
      body = td.turndown(body);
    } catch (_) { /* 转换失败保留原文 */ }
  }
  return { title: bestTitle, body };
}

// 占位标题黑名单：SPA（如语雀）服务端返回的 <title> 往往是 loading/加载中 这类占位符，
// 真正标题是前端水合后才写上去的。命中黑名单时必须继续找下一个候选，而不能直接采用。
const TITLE_PLACEHOLDERS = /^(loading|loading\.{0,3}|加载中\.{0,3}|请稍候\.{0,3}|redirecting?\.{0,3}|just a moment\.{0,3}|untitled|document|new document|新建文档|index|home|首页|—|-)$/i;

function isPlaceholderTitle(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return !t || TITLE_PLACEHOLDERS.test(t);
}

function pickPageTitle(html) {
  const clean = (s) => decodeXmlEntities(String(s || '')).replace(/\s+/g, ' ').trim();
  const metaOf = (re) => {
    const m = html.match(re);
    return m ? clean(m[1]) : '';
  };
  // 优先级：og:title / twitter:title / itemprop=name 这些由服务端渲染的元数据比 <title> 可靠；
  // 最后才退到内联脚本里的 "title":"..."（语雀/知乎等把文档元数据写在 appData 里）
  const cands = [
    metaOf(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i),
    metaOf(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i),
    metaOf(/<meta[^>]+name=["']twitter:title["'][^>]*content=["']([^"']+)["']/i),
    metaOf(/<meta[^>]+itemprop=["']name["'][^>]*content=["']([^"']+)["']/i),
    metaOf(/<title[^>]*>([\s\S]*?)<\/title>/i),
    metaOf(/["']title["']\s*:\s*["']([^"']{2,120})["']/i),
  ];
  for (const c of cands) {
    if (c && !isPlaceholderTitle(c)) return c.slice(0, 120);
  }
  return '';
}

// 只取网页标题（添加链接时调用）：只读到 </head> 或前 128KB 就断流，
// 不把整页拉下来（“保存链接信息”的初衷：只要元数据，不要正文）。
// 拉不到（需登录/超时/只有占位标题）则返回空字符串，由调用方回退到 URL 展示名。
async function fetchUrlTitle(url, timeoutSec) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(20, timeoutSec || 20) * 1000);
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (personal-kb)', Accept: 'text/html,application/xhtml+xml' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!resp.ok || !resp.body) return '';
    const reader = resp.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(Buffer.from(value));
      size += value.length;
      // latin1 只用于“是否已读完 <head>”的粗测，真正解码在下面按 charset 做；
      // 必须读过 <title> 继续到 </head>，否则拿不到排在其后的 og:title
      if (/<\/head>/i.test(Buffer.concat(chunks).toString('latin1')) || size >= 131072) break;
    }
    try { await reader.cancel(); } catch (_) { /* 流已结束 */ }
    const buf = Buffer.concat(chunks);
    const probe = buf.toString('latin1');
    // 编码：优先响应头 charset，其次 <meta charset>，都没有按 UTF-8
    const cs = ((resp.headers.get('content-type') || '').match(/charset=["']?([\w-]+)/i)
      || probe.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1] || 'utf-8';
    let html;
    try { html = new TextDecoder(cs).decode(buf); } catch (_) { html = buf.toString('utf-8'); }
    return pickPageTitle(html);
  } catch (_) {
    return '';   // 标题只是锦上添花，拉取失败不能阻断“添加链接”
  } finally {
    clearTimeout(timer);
  }
}

// 标题获取编排：第一级匿名元数据；失败则（仅桌面端）交给 weblogin 做真实渲染/应用内登录。
// 返回 { title, login, supported }：login=true 表示走到了登录流程，供调用方给出更准确的提示。
// credentials 可选 { username, password }：透传给登录窗自动填充。
// 延迟 require 避免 files.js ↔ weblogin.js 的循环依赖（weblogin 依赖本文件的 pickPageTitle）。
async function fetchUrlTitleRich(url, timeoutSec, credentials) {
  const t = await fetchUrlTitle(url, timeoutSec);
  if (t) return { title: t, login: false, supported: true };
  let weblogin;
  try { weblogin = require('./weblogin'); } catch (_) { weblogin = null; }
  if (!weblogin || !weblogin.hasBrowser()) return { title: '', login: false, supported: false };
  return weblogin.resolveUrlTitle(url, timeoutSec, credentials);
}

// 读取 raw 来源文本：md/文本直接读；office/pdf 等按需提取；local: 为本机引用；url: 为链接（读取时拉取）
async function readRawText(settings, relPath) {
  if (String(relPath).startsWith('url:')) {
    return fetchUrlMarkdown(String(relPath).slice('url:'.length), num(settings, 'urlFetchTimeout', 30, 1, 600));
  }
  const abs = String(relPath).startsWith('local:')
    ? String(relPath).slice('local:'.length)
    : path.join(rawsRoot(settings), String(relPath).replace(/^\//, ''));
  const ext = path.extname(abs).toLowerCase();
  if (['.md', '.markdown', '.txt', '.csv', '.json', '.log'].includes(ext)) {
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : '';
  }
  // 富文本走带缓存包装层：MinerU 产物落盘复用，问答扫描不再每次整篇重转（MinerU 配置下单 PDF 可达分钟级）
  return extractFileContent(abs, settings);
}
// 检索友好的轻量读取：纯文本读头部；富文本优先磁盘缓存，未命中才整篇提取并落缓存。
// 与 readRawText 的区别：不返回全文（检索只需头部打分），避免大文档整篇进内存
async function readRawTextForScan(settings, relPath, maxBytes) {
  if (String(relPath).startsWith('url:')) {
    return fetchUrlMarkdown(String(relPath).slice('url:'.length), num(settings, 'urlFetchTimeout', 30, 1, 600));
  }
  const abs = String(relPath).startsWith('local:')
    ? String(relPath).slice('local:'.length)
    : path.join(rawsRoot(settings), String(relPath).replace(/^\//, ''));
  const ext = path.extname(abs).toLowerCase();
  if (['.md', '.markdown', '.txt', '.csv', '.json', '.log', '.html', '.htm'].includes(ext)) {
    if (!fs.existsSync(abs)) return '';
    const buf = Buffer.alloc(Math.max(4096, maxBytes || 512 * 1024));
    let fd;
    try {
      fd = fs.openSync(abs, 'r');
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const slice = buf.slice(0, n);
      if (slice.includes(0)) return '';
      return slice.toString('utf-8');
    } catch (_) { return ''; } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
    }
  }
  const text = await extractFileContent(abs, settings);
  return String(text || '');
}

module.exports = { FILE_EXTENSIONS, DEFAULT_NOTE_IMPORT_EXTS, noteImportExts, canImportAsNote, mineruCmdParts, convertWithMineru, runMineruTest, installMineru, applyMineruModel, readRawText, readRawTextForScan, extractFileContent, fetchUrlMarkdown, fetchUrlTitle, fetchUrlTitleRich, pickPageTitle, isPlaceholderTitle, titleFromFileName, attachMineruImages };
