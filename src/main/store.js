// 数据存储：笔记/目录/设置的读写（底层为 SQLite，见 db.js）
const db = require('./db');

function getDataFile() {
  return db.getDbFile();
}

function loadStore() {
  return db.getStore();
}

function saveStore(store) {
  db.saveStore(store);
}

module.exports = { getDataFile, loadStore, saveStore };
