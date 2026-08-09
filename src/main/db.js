// SQLite 存储层（sql.js WASM 实现）
// 负责：笔记/目录/设置（原 knowledge-data.json）与作业历史（原 wiki-jobs.json）的持久化
// 说明：sql.js 为内存数据库，每次变更后整体导出并原子写盘（个人知识库数据量小，开销可忽略）
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

let SQL = null;
let db = null;
let dbFilePath = null; // 当前数据库文件路径（init 时按指针文件解析，运行期可切换）

function defaultDbFile() {
  return path.join(app.getPath('userData'), 'knowledge.db');
}

// 指针文件独立于数据库存放（设置存在库内，避免先有鸡还是先有蛋）
function pointerFile() {
  return path.join(app.getPath('userData'), 'db-path.json');
}

function resolveDbFile() {
  try {
    const p = JSON.parse(fs.readFileSync(pointerFile(), 'utf-8')).dbPath;
    if (p && fs.existsSync(p)) return p;
    if (p) console.warn('指针文件指向的数据库不存在，回退默认位置:', p);
  } catch (_) {}
  return defaultDbFile();
}

function getDbFile() {
  return dbFilePath;
}

// 切换数据库文件位置：整库导出迁移到新路径，成功后更新指针文件
// 留空表示恢复默认位置；目标已存在时拒绝覆盖（恢复默认时旧文件改名留底）
function setDbPath(newPath) {
  try {
    const raw = String(newPath || '').trim();
    let target;
    if (!raw) {
      target = defaultDbFile();
    } else {
      if (!path.isAbsolute(raw)) return { ok: false, error: '请输入绝对路径' };
      target = path.resolve(raw);
      if (fs.existsSync(target) && target !== dbFilePath) {
        return { ok: false, error: '目标文件已存在，为避免覆盖请换一个路径' };
      }
    }
    if (target === dbFilePath) return { ok: true, path: target, changed: false };

    // 恢复默认位置时，若默认文件残留旧数据则改名留底，避免新旧混淆
    if (!raw && fs.existsSync(target)) {
      let bak = target + '.bak';
      let n = 2;
      while (fs.existsSync(bak)) bak = target + '.bak' + n++;
      fs.renameSync(target, bak);
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, Buffer.from(db.export()));
    fs.renameSync(tmp, target);

    // 离开默认位置时，旧文件改名留底（防指针丢失时误读陈旧数据）
    const old = dbFilePath;
    dbFilePath = target;
    if (raw && old === defaultDbFile() && fs.existsSync(old)) {
      try { fs.renameSync(old, old + '.bak'); } catch (_) {}
    }
    if (!raw) {
      try { fs.unlinkSync(pointerFile()); } catch (_) {}
    } else {
      fs.writeFileSync(pointerFile(), JSON.stringify({ dbPath: target }, null, 2), 'utf-8');
    }
    flush();
    console.log('数据库文件已切换至:', target);
    return { ok: true, path: target, changed: true };
  } catch (err) {
    return { ok: false, error: '切换失败：' + err.message };
  }
}

function legacyDataFile() {
  return path.join(app.getPath('userData'), 'knowledge-data.json');
}

function legacyJobsFile() {
  return path.join(app.getPath('userData'), 'wiki-jobs.json');
}

// ---------- 初始化与迁移 ----------
async function init() {
  const initSqlJs = require('sql.js');
  SQL = await initSqlJs({
    // sql-wasm.wasm 与 sql-wasm.js 同目录（exports 映射不允许直接解析 package.json）
    locateFile: (file) => path.join(path.dirname(require.resolve('sql.js/dist/sql-wasm.js')), file),
  });
  const file = resolveDbFile();
  dbFilePath = file;
  if (fs.existsSync(file)) {
    db = new SQL.Database(new Uint8Array(fs.readFileSync(file)));
    createSchema(); // 兼容旧库补建表
  } else {
    db = new SQL.Database();
    createSchema();
    migrateLegacy();
    flush();
  }
}

function createSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS folders (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      parent_id TEXT
    );
    CREATE TABLE IF NOT EXISTS notes (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      folder_id TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL DEFAULT 0,
      finished_at INTEGER NOT NULL DEFAULT 0,
      stages TEXT NOT NULL DEFAULT '[]',
      raw_paths TEXT,
      result TEXT,
      error TEXT NOT NULL DEFAULT ''
    );
  `);
}

// 旧 JSON 文件一次性迁入 SQLite，成功后原文件改名 .bak 留作备份
function migrateLegacy() {
  const dataFile = legacyDataFile();
  if (fs.existsSync(dataFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
      insertFolders(Array.isArray(data.folders) ? data.folders : []);
      insertNotes(Array.isArray(data.notes) ? data.notes : []);
      setKv('settings', JSON.stringify(data.settings || {}));
      fs.renameSync(dataFile, dataFile + '.bak');
      console.log('已迁移 knowledge-data.json → SQLite');
    } catch (err) {
      console.error('笔记数据迁移失败，保留原文件:', err);
    }
  }
  const jobsFile = legacyJobsFile();
  if (fs.existsSync(jobsFile)) {
    try {
      const list = JSON.parse(fs.readFileSync(jobsFile, 'utf-8'));
      if (Array.isArray(list)) insertJobs(list);
      fs.renameSync(jobsFile, jobsFile + '.bak');
      console.log('已迁移 wiki-jobs.json → SQLite');
    } catch (err) {
      console.error('作业数据迁移失败，保留原文件:', err);
    }
  }
}

// ---------- 落盘 ----------
// 整体导出 + 临时文件 rename，避免写入中断损坏数据库
function flush() {
  const data = db.export();
  const file = getDbFile();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, Buffer.from(data));
  fs.renameSync(tmp, file);
}

// ---------- 笔记/目录/设置 ----------
function insertFolders(folders) {
  const stmt = db.prepare('INSERT INTO folders (id, name, parent_id) VALUES (?, ?, ?)');
  try {
    for (const f of folders) {
      stmt.run([String(f.id), String(f.name || ''), f.parentId == null ? null : String(f.parentId)]);
    }
  } finally {
    stmt.free();
  }
}

function insertNotes(notes) {
  const stmt = db.prepare(
    'INSERT INTO notes (id, title, content, tags, folder_id, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  try {
    for (const n of notes) {
      stmt.run([
        String(n.id),
        String(n.title || ''),
        String(n.content || ''),
        JSON.stringify(Array.isArray(n.tags) ? n.tags : []),
        n.folderId == null ? null : String(n.folderId),
        n.pinned ? 1 : 0,
        n.createdAt || 0,
        n.updatedAt || 0,
      ]);
    }
  } finally {
    stmt.free();
  }
}

function getSettings() {
  try { return JSON.parse(getKv('settings') || '{}'); } catch (_) { return {}; }
}

function getStore() {
  const folders = [];
  for (const row of db.exec('SELECT id, name, parent_id FROM folders ORDER BY rowid')[0]?.values || []) {
    folders.push({ id: row[0], name: row[1], parentId: row[2] });
  }
  const notes = [];
  const res = db.exec('SELECT id, title, content, tags, folder_id, pinned, created_at, updated_at FROM notes ORDER BY rowid')[0];
  for (const row of res?.values || []) {
    let tags = [];
    try { tags = JSON.parse(row[3]); } catch (_) {}
    notes.push({
      id: row[0],
      title: row[1],
      content: row[2],
      tags: Array.isArray(tags) ? tags : [],
      folderId: row[4],
      pinned: !!row[5],
      createdAt: row[6],
      updatedAt: row[7],
    });
  }
  return { folders, notes, settings: getSettings() };
}

// 渲染层每次提交全量 store：事务内清空重插，保持行序与内存数组一致
function saveStore(store) {
  db.run('BEGIN');
  try {
    db.run('DELETE FROM folders');
    db.run('DELETE FROM notes');
    insertFolders(Array.isArray(store.folders) ? store.folders : []);
    insertNotes(Array.isArray(store.notes) ? store.notes : []);
    setKv('settings', JSON.stringify(store.settings || {}));
    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
  flush();
}

function getKv(key) {
  // sql.js 需在 prepare 时绑定参数，否则 ? 视为 NULL 查不到行
  const stmt = db.prepare('SELECT value FROM kv WHERE key = ?', [key]);
  try {
    if (stmt.step()) return stmt.get()[0];
    return null;
  } finally {
    stmt.free();
  }
}

function setKv(key, value) {
  const stmt = db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  try {
    stmt.run([key, value]);
  } finally {
    stmt.free();
  }
}

// ---------- 作业历史 ----------
function insertJobs(list) {
  const stmt = db.prepare(
    'INSERT INTO jobs (id, type, title, status, created_at, started_at, finished_at, stages, raw_paths, result, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  try {
    for (const j of list) {
      stmt.run([
        String(j.id),
        String(j.type),
        String(j.title || ''),
        String(j.status),
        j.createdAt || 0,
        j.startedAt || 0,
        j.finishedAt || 0,
        JSON.stringify(Array.isArray(j.stages) ? j.stages : []),
        Array.isArray(j.rawPaths) ? JSON.stringify(j.rawPaths) : null,
        j.result == null ? null : JSON.stringify(j.result),
        String(j.error || ''),
      ]);
    }
  } finally {
    stmt.free();
  }
}

function getJobs() {
  const res = db.exec('SELECT id, type, title, status, created_at, started_at, finished_at, stages, raw_paths, result, error FROM jobs ORDER BY rowid DESC')[0];
  const list = [];
  for (const row of res?.values || []) {
    let stages = [];
    try { stages = JSON.parse(row[7]); } catch (_) {}
    let rawPaths = null;
    try { rawPaths = row[8] ? JSON.parse(row[8]) : null; } catch (_) {}
    let result = null;
    try { result = row[9] ? JSON.parse(row[9]) : null; } catch (_) {}
    list.push({
      id: row[0],
      type: row[1],
      title: row[2],
      status: row[3],
      createdAt: row[4],
      startedAt: row[5],
      finishedAt: row[6],
      stages,
      rawPaths,
      result,
      error: row[10] || '',
      payload: null, // payload 仅运行期内存持有，不入库
    });
  }
  return list;
}

// 作业列表全量覆盖（调用方已完成截断与 payload 剥离）
function saveJobs(list) {
  db.run('BEGIN');
  try {
    db.run('DELETE FROM jobs');
    // 恢复原列表展示序（新→旧），表内按 rowid 升序存储
    insertJobs(list.slice().reverse());
    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
  flush();
}

module.exports = { init, getDbFile, setDbPath, getSettings, getStore, saveStore, getJobs, saveJobs };
