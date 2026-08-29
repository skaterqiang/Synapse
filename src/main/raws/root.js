// 原始文件根目录解析：原始来源统一存放在 <root>/raw/ 下。
// 根目录默认取 data/llmwiki（历史命名保留），支持设置项 wikiRoot 自定义（兼容存量配置键）。
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const paths = require('../common/paths');

function defaultRawsRoot() {
  const candidates = [
    path.join(paths.dataRoot(), 'llmwiki'),
    path.join(app.getAppPath(), 'llmwiki'),
    path.join(process.resourcesPath || app.getAppPath(), 'llmwiki'),
    path.join(app.getPath('documents'), 'llmwiki'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'AGENTS.md'))) return c;
  }
  return candidates[0];
}

// 设置键沿用历史 wikiRoot（存量用户配置兼容），返回解析后的绝对路径
function rawsRoot(settings) {
  const root = (settings && settings.wikiRoot) || defaultRawsRoot();
  return path.resolve(root);
}

// root 内相对路径安全拼接：拒绝越界（如 ../）访问
function safeJoin(root, rel) {
  const p = path.resolve(root, rel);
  if (p !== root && !p.startsWith(root + path.sep)) {
    throw new Error('非法路径：' + rel);
  }
  return p;
}

module.exports = { rawsRoot, safeJoin };
