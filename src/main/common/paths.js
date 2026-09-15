// 统一数据根目录：默认 <安装目录>/data（开发态为项目根/data），可配置，旧 appData 数据首启自动迁移
// 根目录下统一存放：knowledge.db（数据库）、assets/（笔记附件图片）、llmwiki/（Wiki 默认根）
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

// 旧版用户数据目录（macOS: ~/Library/Application Support/个人知识库助手），仅作迁移来源与配置指针存放处
function legacyUserData() {
  return path.join(app.getPath('appData'), '个人知识库助手');
}

// 根目录配置指针独立存放（根目录本身可换，指针须固定）
function rootPointerFile() {
  return path.join(legacyUserData(), 'root-path.json');
}

function writable(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

// 递归复制目录（手写实现，替代 fs.cpSync）
// 原因：Windows 下 fs.cpSync(含非 ASCII 的源目录, 目标, {recursive:true}) 会让 Node 进程
// 直接崩溃（STATUS_STACK_BUFFER_OVERRUN，退出码 -1073740791），无法被 try/catch 捕获。
// 旧版用户数据目录名恰为「个人知识库助手」，首启迁移必然踩中。手写复制逐项 copyFileSync，
// 行为可控且跨平台一致（符号链接解引用为普通文件复制，个人附件场景无链接需求）。
function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else if (entry.isSymbolicLink()) {
      try { fs.copyFileSync(s, d); } catch (_) { /* 断链忽略，不阻断整体迁移 */ }
    } else fs.copyFileSync(s, d);
  }
}

// 默认根目录候选：安装目录/data → 资源目录/data → 可执行文件目录/data（仅打包版）→ 旧 appData
function defaultDataRoot() {
  const candidates = [
    path.join(app.getAppPath(), 'data'),
    path.join(process.resourcesPath || app.getAppPath(), 'data'),
    ...(app.isPackaged ? [path.join(path.dirname(app.getPath('exe')), 'data')] : []),
    legacyUserData(),
  ];
  for (const c of candidates) {
    if (c && writable(c)) return c;
  }
  return legacyUserData();
}

let cached = null;
function dataRoot() {
  if (cached) return cached;
  try {
    const cfg = JSON.parse(fs.readFileSync(rootPointerFile(), 'utf-8'));
    if (cfg && cfg.root && writable(cfg.root)) {
      cached = cfg.root;
      return cached;
    }
  } catch (_) {}
  cached = defaultDataRoot();
  return cached;
}

// 配置根目录：留空恢复默认；写入指针后重启生效
function setDataRoot(newPath) {
  const raw = String(newPath || '').trim();
  const target = raw ? path.resolve(raw) : '';
  if (target && !writable(target)) throw new Error('目标根目录不可写：' + target);
  fs.mkdirSync(legacyUserData(), { recursive: true });
  fs.writeFileSync(rootPointerFile(), JSON.stringify({ root: target }));
  cached = null;
  return dataRoot();
}

// 首启数据归一：把旧 appData 下的附件目录迁移到统一根目录（数据库迁移在 db.js 内按指针逻辑处理）
let assetsRewrite = null;
function ensureUnifiedRoot() {
  const root = dataRoot();
  const legacy = legacyUserData();
  if (root !== legacy) {
    const legacyAssets = path.join(legacy, 'assets');
    const rootAssets = path.join(root, 'assets');
    if (fs.existsSync(legacyAssets) && !fs.existsSync(rootAssets)) {
      copyDirSync(legacyAssets, rootAssets);
      fs.renameSync(legacyAssets, legacyAssets + '.migrated');
      assetsRewrite = { from: legacyAssets, to: rootAssets };
    }
  }
  return root;
}

// db 初始化后消费附件迁移记录，用于重写笔记正文中的 kb-asset 引用前缀
function consumeAssetsRewrite() {
  const r = assetsRewrite;
  assetsRewrite = null;
  return r;
}

function assetsDir() {
  return path.join(dataRoot(), 'assets');
}

// 语料库根目录（语料流水线设计 §6.1）：<数据根>/corpus/
// 与 note/ 并列但语义不同——语料是「机器产物、可重生成」，故：
//   ① 不进笔记列表与全局搜索（§15 问题 6）
//   ② 不随备份/迁移搬迁（§15 问题 7；ensureUnifiedRoot 的迁移清单刻意不含 corpus/）
//   ③ 支持一键「提升为笔记」（store.promoteToNote）
function corpusRoot() {
  return path.join(dataRoot(), 'corpus');
}

// 把本地绝对路径编码为 kb-asset://file URL（Markdown 图片引用）。
// encodeURI 不编码 ( ) '，而笔记目录常含「 (更新版)」等括号——未编码的 ( 会让 Markdown 解析器
// 提前截断 ![](...) 的 URL，导致整条图片引用损坏看不到图。故 encodeURI 后手动补编码 markdown 定界符。
// 跨平台：统一正斜杠；Windows 盘符保留冒号（D:/...），Mac 绝对路径保留前导 /（/Users/...）。
// 解析端（main.js protocol.handle / web /api/asset）用 path.resolve(decodeURIComponent(pathname)) 还原，
// 与旧格式（kb-asset://fileD:%5C...，host 并入路径）结构兼容，仅需处理 Windows 盘符前导斜杠。
function kbAssetUrlFor(absPath) {
  const p = String(absPath).replace(/\\/g, '/'); // 统一正斜杠
  const enc = encodeURI(p).replace(/[()']/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return 'kb-asset://file' + enc;
}

module.exports = { dataRoot, setDataRoot, ensureUnifiedRoot, consumeAssetsRewrite, assetsDir, corpusRoot, legacyUserData, kbAssetUrlFor };
