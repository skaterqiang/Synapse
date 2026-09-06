// 原始文件应用内只读预览（md/markdown）
// 职责：① 把原始来源 relPath 解析为绝对路径并读出 Markdown 文本；② 登记「本次预览文件所在目录」
// 为图片白名单根，供 kb-asset 协议（桌面）/ /api/asset 路由（网页）放行同级相对图片。
// 只读：不写入笔记库、不改写正文（需要入库走「提取笔记」作业）。
const fs = require('fs');
const path = require('path');
const { rawsRoot, safeJoin } = require('./root');

const MD_EXT_RE = /\.(md|markdown)$/i;
// 仅放行图片：预览目录里可能还有别的文件，不给任意文件读取的口子
const IMG_EXT_RE = /\.(png|jpe?g|gif|svg|webp|bmp|avif|ico)$/i;
// 白名单只保留最近若干个目录，防长期运行无界增长
const MAX_ALLOWED_DIRS = 16;

// Windows 文件系统大小写不敏感，统一小写比较；其余平台原样
const dirKey = (p) => (process.platform === 'win32' ? String(p).toLowerCase() : String(p));

// 已登记的预览目录（绝对路径，插入序即时间序）
const allowedDirs = new Set();

function allowDir(dir) {
  const d = path.resolve(String(dir || ''));
  if (!d) return;
  const key = dirKey(d);
  allowedDirs.delete(key); // 重新登记以刷新新旧顺序
  allowedDirs.add(key);
  while (allowedDirs.size > MAX_ALLOWED_DIRS) {
    const oldest = allowedDirs.values().next();
    if (oldest.done) break;
    allowedDirs.delete(oldest.value);
  }
}

// 该来源是否可应用内预览：url: 链接交浏览器，其余按扩展名判定
function isPreviewable(relPath) {
  const p = String(relPath || '');
  return !!p && !p.startsWith('url:') && MD_EXT_RE.test(p);
}

// 解析原始来源为绝对路径。与 raw:open 同口径：
//   local:<绝对路径> → 本机引用（不转存）
//   url:<链接>       → 不支持（预览只面向本地文件）
//   其余             → <rawsRoot>/<relPath>（raw/ 下副本），safeJoin 拒绝 ../ 越界
function resolveRawPath(settings, relPath) {
  const rel = String(relPath || '');
  if (!rel) throw new Error('无效来源');
  if (rel.startsWith('url:')) throw new Error('网页链接请在浏览器中打开');
  if (rel.startsWith('local:')) return path.resolve(rel.slice('local:'.length));
  return safeJoin(rawsRoot(settings), rel.replace(/^\//, ''));
}

// 读取 Markdown 文本用于应用内预览；返回 { text, name, dir }，dir 供渲染层解析相对图片/链接
function readMarkdown(settings, relPath) {
  const abs = resolveRawPath(settings, relPath);
  if (!MD_EXT_RE.test(abs)) throw new Error('仅支持预览 Markdown（.md/.markdown）文件');
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error('文件不存在：' + abs);
  const dir = path.dirname(abs);
  allowDir(dir);
  return { text: fs.readFileSync(abs, 'utf-8'), name: path.basename(abs), dir };
}

// kb-asset / /api/asset 的额外放行判定：已登记预览目录内的图片文件
function isAllowedAsset(absPath) {
  const p = path.resolve(String(absPath || ''));
  if (!IMG_EXT_RE.test(p)) return false;
  const key = dirKey(p);
  for (const d of allowedDirs) {
    if (key.startsWith(d + path.sep)) return true;
  }
  return false;
}

module.exports = { isPreviewable, resolveRawPath, readMarkdown, isAllowedAsset };
