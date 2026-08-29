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
      fs.cpSync(legacyAssets, rootAssets, { recursive: true });
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

module.exports = { dataRoot, setDataRoot, ensureUnifiedRoot, consumeAssetsRewrite, assetsDir, legacyUserData, kbAssetUrlFor };
