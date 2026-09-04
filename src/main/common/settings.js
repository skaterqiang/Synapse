// 设置存取：基于 kv 的通用结构（引擎无关，见 db.js 统一接口）
const db = require('./db');
const appdb = require('./appdb');

// 应用级配置与知识库数据分库存储：API Key 不进入 knowledge.db，MCP/Skills 配置也独立保存。
const APP_KEYS = ['apiKey', 'extraModels', 'mcpServers', 'skills'];

function parse(value, fallback) {
  try { return JSON.parse(value || ''); } catch (_) { return fallback; }
}

function getSettings() {
  const legacy = parse(db.getKv('settings'), {});
  const appSettings = parse(appdb.get('settings'), null);
  if (!appSettings) {
    const moved = {};
    for (const key of APP_KEYS) {
      if (legacy[key] !== undefined) moved[key] = legacy[key];
      delete legacy[key];
    }
    appdb.set('settings', JSON.stringify(moved));
    appdb.flush();
    db.setKv('settings', JSON.stringify(legacy));
    db.flush();
    return { ...legacy, ...moved };
  }
  return { ...legacy, ...appSettings };
}

function saveSettings(s) {
  const mainSettings = { ...(s || {}) };
  const appSettings = {};
  for (const key of APP_KEYS) {
    if (mainSettings[key] !== undefined) appSettings[key] = mainSettings[key];
    delete mainSettings[key];
  }
  appdb.set('settings', JSON.stringify(appSettings));
  appdb.flush();
  db.setKv('settings', JSON.stringify(mainSettings));
  db.flush();
}

module.exports = { getSettings, saveSettings, APP_KEYS };
