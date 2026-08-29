// SQLite 存储层（sql.js WASM 实现）——统一数据库引擎层
// 存储模型：
//   笔记内容 → 文件系统（<根目录>/note/<目录>/<标题>.md），notes 表为遗留表，迁移完成后自动 DROP
//   目录元数据 → folders 表；设置/图谱/本体/领域模版 → kv 表；作业历史 → jobs 表
// 说明：sql.js 为内存数据库，每次变更后整体导出并原子写盘（个人知识库数据量小，开销可忽略）
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const paths = require('./paths');

let SQL = null;
let db = null;
let dbFilePath = null; // 当前数据库文件路径（init 时按指针文件解析，运行期可切换）
let dbMtime = 0; // 加载时数据库文件 mtime：检测「别的进程写过盘」以触发重载
let inTx = false; // 事务进行中标记：期间禁止换 db 实例（BEGIN/COMMIT 必须落在同一实例）

// 默认库位置：统一数据根目录下（<安装目录>/data/knowledge.db，可配置）
function defaultDbFile() {
  return path.join(paths.dataRoot(), 'knowledge.db');
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
  // 统一根目录首启迁移：默认位置无库且旧 appData 有库时，整库搬迁（旧文件改名留底）
  if (!fs.existsSync(file) && file === defaultDbFile()) {
    const legacyDb = path.join(paths.legacyUserData(), 'knowledge.db');
    if (legacyDb !== file && fs.existsSync(legacyDb)) {
      fs.copyFileSync(legacyDb, file);
      fs.renameSync(legacyDb, legacyDb + '.migrated');
      console.log('数据库已迁移至统一根目录:', file);
    }
  }
  if (fs.existsSync(file)) {
    db = new SQL.Database(new Uint8Array(fs.readFileSync(file)));
    createSchema(); // 兼容旧库补建表
  } else {
    db = new SQL.Database();
    createSchema();
    migrateLegacy();
    flush();
  }
  // 附件目录迁移后，重写笔记正文中的 kb-asset 引用前缀（表形态 + 文件形态双通道）
  const rw = paths.consumeAssetsRewrite();
  const notesStore = require('../notes/store');
  if (rw) rewriteAssetPrefix(rw.from, rw.to);
  // 笔记存储模型迁移：数据库 notes 表 → 文件系统（<根目录>/note/）
  notesStore.migrateDbNotesToFiles();
  if (rw) notesStore.rewriteNoteFiles(rw.from, rw.to);
  notesStore.migrateAssetsToNoteDirs(); // 旧 assets/<标题>/ 附件 → 笔记自身目录
  notesStore.migrateEncodedNoteTitles(); // URL 编码乱码标题 → 解码为可读标题（幂等）
  // 遗留 notes 表：内容已全部落文件后移除，收缩库体积
  try {
    if (all("SELECT name FROM sqlite_master WHERE type='table' AND name='notes'").length) {
      const c = all('SELECT COUNT(*) AS c FROM notes')[0].c || 0;
      if (!c) {
        run('DROP TABLE notes');
        flush();
        console.log('遗留 notes 表已移除（笔记内容存于文件系统）');
      }
    }
  } catch (_) {}
  try { dbMtime = fs.statSync(dbFilePath).mtimeMs; } catch (_) { dbMtime = 0; }
}

// 将笔记内容中 kb-asset://file<旧附件目录> 前缀替换为新目录（路径在正文中为 encodeURI 编码形式）
function rewriteAssetPrefix(from, to) {
  // 仅表存在时生效（笔记落文件后由 rewriteNoteFiles 接管）
  if (!all("SELECT name FROM sqlite_master WHERE type='table' AND name='notes'").length) return;
  const search = 'kb-asset://file' + encodeURI(from);
  const replace = 'kb-asset://file' + encodeURI(to);
  for (const row of all('SELECT id, content FROM notes')) {
    if (typeof row.content === 'string' && row.content.includes(search)) {
      run('UPDATE notes SET content = ? WHERE id = ?', [row.content.split(search).join(replace), row.id]);
    }
  }
  flush();
  console.log('笔记附件引用已重写至:', to);
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
      error TEXT NOT NULL DEFAULT '',
      live_preview TEXT,
      source TEXT,
      tasks TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE TABLE IF NOT EXISTS note_versions (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id TEXT NOT NULL,
      version TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_note_versions_note ON note_versions(note_id, created_at);
  `);
  // 旧库迁移：jobs 表补建 live_preview 列（执行细节持久化），随即落盘
  const cols = db.exec('PRAGMA table_info(jobs)')[0]?.values || [];
  if (!cols.some((c) => c[1] === 'live_preview')) {
    db.run('ALTER TABLE jobs ADD COLUMN live_preview TEXT');
    flush();
  }
  if (!cols.some((c) => c[1] === 'source')) {
    db.run('ALTER TABLE jobs ADD COLUMN source TEXT');
    flush();
  }
  if (!cols.some((c) => c[1] === 'tasks')) {
    db.run('ALTER TABLE jobs ADD COLUMN tasks TEXT');
    flush();
  }
}

// 旧 JSON 文件一次性迁入 SQLite：各域数据的导入 SQL 由各自模块维护，此处仅调度
function migrateLegacy() {
  const dataFile = legacyDataFile();
  if (fs.existsSync(dataFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
      require('../notes/store').importLegacy(data);
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
      if (Array.isArray(list)) require('../jobs/jobs').importLegacyJobs(list);
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
  try { dbMtime = fs.statSync(file).mtimeMs; } catch (_) { /* 忽略 */ }
}

// ---------- 统一数据库操作（引擎无关接口：未来换 PG 仅需替换本文件内实现） ----------
// 各业务模块（notes/jobs/graph/templates…）的领域 SQL 在各自模块内维护，统一经由下述接口访问

// 执行写操作（参数绑定）
function run(sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.run(params);
  } finally {
    stmt.free();
  }
}

// 查询返回对象数组（列名为键）
function all(sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    if (params.length) stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

// 事务包装：失败自动回滚
// 重载只允许发生在 BEGIN 之前：事务内 setKv 等若触发跨进程重载换掉 db 实例，
// COMMIT/ROLLBACK 会打到没有活动事务的新实例上（cannot rollback - no transaction is active）
function transaction(fn) {
  reloadIfStale();
  inTx = true;
  try {
    db.run('BEGIN');
    fn();
    db.run('COMMIT');
  } catch (err) {
    try { db.run('ROLLBACK'); } catch (_) { /* 无活动事务时不掩盖原错误 */ }
    throw err;
  } finally {
    inTx = false;
  }
}

// 跨进程同步：sql.js 是内存库，桌面应用与 Web 服务各持一份快照。别的进程 flush 落盘后
// （典型场景：桌面端登录窗写入 Cookie 时 Web 服务已在运行），本进程快照就过期了。
// 读写 KV 前比较数据库文件 mtime，比加载时新则整库重载（个人知识库数据量小，开销可忽略）。
// 写方一律「导出后 rename」，mtime 必变，检测可靠；写前重载也避免旧快照覆盖别进程的新数据。
function reloadIfStale() {
  if (!SQL || !db || !dbFilePath || inTx) return;
  try {
    const st = fs.statSync(dbFilePath);
    if (st.mtimeMs <= dbMtime) return;
    db = new SQL.Database(new Uint8Array(fs.readFileSync(dbFilePath)));
    dbMtime = st.mtimeMs;
  } catch (_) { /* 重载失败沿用旧库，不影响主流程 */ }
}

// KV 通用存储（图谱/模版/设置等跨引擎可移植的简单结构）
function getKv(key) {
  reloadIfStale();
  const rows = all('SELECT value FROM kv WHERE key = ?', [key]);
  return rows.length ? rows[0].value : null;
}

function setKv(key, value) {
  reloadIfStale();
  run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
}

module.exports = { init, getDbFile, setDbPath, run, all, transaction, getKv, setKv, flush };
