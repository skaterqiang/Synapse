// 应用配置 SQLite：与知识库 knowledge.db 分离，存放 API Key、MCP 与 Skills 配置。
// 文件位于统一数据根目录下的 app.db；知识库迁移或切换时不会携带这些应用级配置。
const path = require('path');
const fs = require('fs');
const paths = require('./paths');

let SQL = null;
let db = null;
let dbFilePath = null;

function defaultFile() {
  return path.join(paths.dataRoot(), 'app.db');
}

async function init() {
  const initSqlJs = require('sql.js');
  SQL = await initSqlJs({
    locateFile: (file) => path.join(path.dirname(require.resolve('sql.js/dist/sql-wasm.js')), file),
  });
  dbFilePath = defaultFile();
  fs.mkdirSync(path.dirname(dbFilePath), { recursive: true });
  if (fs.existsSync(dbFilePath)) db = new SQL.Database(new Uint8Array(fs.readFileSync(dbFilePath)));
  else db = new SQL.Database();
  db.run(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  flush();
}

function ensureReady() {
  if (!db) throw new Error('应用配置数据库尚未初始化');
}

function getFile() {
  return dbFilePath;
}

function get(key) {
  ensureReady();
  const stmt = db.prepare('SELECT value FROM kv WHERE key = ?');
  try {
    stmt.bind([key]);
    return stmt.step() ? stmt.getAsObject().value : null;
  } finally { stmt.free(); }
}

function set(key, value) {
  ensureReady();
  const stmt = db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  try { stmt.run([key, value]); } finally { stmt.free(); }
}

function flush() {
  ensureReady();
  const tmp = dbFilePath + '.tmp';
  fs.writeFileSync(tmp, Buffer.from(db.export()));
  fs.renameSync(tmp, dbFilePath);
}

module.exports = { init, getFile, get, set, flush };
