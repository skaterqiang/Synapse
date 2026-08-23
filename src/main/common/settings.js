// 设置存取：基于 kv 的通用结构（引擎无关，见 db.js 统一接口）
const db = require('./db');

function getSettings() {
  try {
    return JSON.parse(db.getKv('settings') || '{}');
  } catch (_) {
    return {};
  }
}

function saveSettings(s) {
  db.setKv('settings', JSON.stringify(s));
  db.flush();
}

module.exports = { getSettings, saveSettings };
