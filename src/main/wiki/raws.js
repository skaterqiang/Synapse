// 原始文件管理层：raw/ 自动生成来源 + 本机文件引用（不转存，直接记录本地路径）
const path = require('path');
const fs = require('fs');
const db = require('../common/db');
const { wikiRoot, safeJoin } = require('./wiki');
const { FILE_EXTENSIONS } = require('./files');

// 本机引用（kv 存储，不复制文件）：
//  raw_refs 单文件引用；raw_dir_refs 目录引用（实时遍历，随源变化）；raw_excluded 目录引用下被用户移除的路径
const REFS_KEY = 'raw_refs';
const DIRS_KEY = 'raw_dir_refs';
const EXCL_KEY = 'raw_excluded';
function getRefs() { try { return JSON.parse(db.getKv(REFS_KEY) || '[]'); } catch (_) { return []; } }
function saveRefs(list) { db.setKv(REFS_KEY, JSON.stringify(list)); db.flush(); }
function getDirRefs() { try { return JSON.parse(db.getKv(DIRS_KEY) || '[]'); } catch (_) { return []; } }
function saveDirRefs(list) { db.setKv(DIRS_KEY, JSON.stringify(list)); db.flush(); }
function getExcl() { try { return JSON.parse(db.getKv(EXCL_KEY) || '[]'); } catch (_) { return []; } }
function saveExcl(list) { db.setKv(EXCL_KEY, JSON.stringify(list)); db.flush(); }

// 吸收状态追踪（kv 存储，防重复吸收）：key=来源路径（raw/… 或 local:…）→ {at, mtime, jobId}
const ING_KEY = 'raw_ingested';
function getIngested() { try { return JSON.parse(db.getKv(ING_KEY) || '{}'); } catch (_) { return {}; } }
function saveIngested(map) { db.setKv(ING_KEY, JSON.stringify(map)); db.flush(); }

// 吸收作业成功后记录来源；local: 同时记录当时文件 mtime，供后续判断“吸收后是否被修改”
function markIngested(rawPaths, jobId) {
  const map = getIngested();
  for (const p of rawPaths || []) {
    const key = String(p);
    let mtime = 0;
    if (key.startsWith('local:')) {
      try { mtime = fs.statSync(key.slice('local:'.length)).mtimeMs; } catch (_) { mtime = 0; }
    }
    map[key] = { at: Date.now(), mtime, jobId: jobId || '' };
  }
  saveIngested(map);
}

// 从历史成功作业回填吸收状态（兼容功能上线前已吸收的来源；不覆盖已有记录）
function backfillIngested(items) {
  const map = getIngested();
  let changed = false;
  for (const it of items || []) {
    const key = String(it.path);
    if (map[key]) continue;
    let mtime = 0;
    if (key.startsWith('local:')) {
      try { mtime = fs.statSync(key.slice('local:'.length)).mtimeMs; } catch (_) { mtime = 0; }
    }
    map[key] = { at: it.at || Date.now(), mtime, jobId: it.jobId || '' };
    changed = true;
  }
  if (changed) saveIngested(map);
}

// 已吸收且来源未变化（local: 文件被修改过则返回 false，需重新吸收）
function isIngestedFresh(key) {
  const rec = getIngested()[String(key)];
  if (!rec) return false;
  if (!String(key).startsWith('local:') || !rec.mtime) return true;
  try { return fs.statSync(String(key).slice('local:'.length)).mtimeMs <= rec.mtime; } catch (_) { return false; }
}

// 列表展示用：已吸收 → {at, stale}；stale 表示本地文件在吸收后被修改过
function ingestInfo(ingMap, key, mtime) {
  const rec = ingMap[key];
  if (!rec) return undefined;
  const stale = typeof mtime === 'number' && rec.mtime > 0 && mtime > rec.mtime;
  return { at: rec.at, stale };
}

// 递归列举 raw/ 下全部来源（按修改时间倒序）
function listRaws(settings) {
  const rawDir = path.join(wikiRoot(settings), 'raw');
  const ingMap = getIngested();
  const list = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== '_auto') walk(p); }
      else if (!entry.name.startsWith('.')) {
        const st = fs.statSync(p);
        list.push({
          path: 'raw/' + path.relative(rawDir, p).replace(/\\/g, '/'),
          name: entry.name,
          ext: path.extname(entry.name).replace(/^\./, '').toLowerCase(),
          size: st.size,
          mtime: st.mtimeMs,
          ingested: ingestInfo(ingMap, 'raw/' + path.relative(rawDir, p).replace(/\\/g, '/'), st.mtimeMs),
        });
      }
    }
  };
  walk(rawDir);
  const excl = new Set(getExcl());
  // 单文件引用（存在且未被排除）
  for (const r of getRefs()) {
    if (!fs.existsSync(r.path) || excl.has(r.path)) continue;
    list.push({ path: 'local:' + r.path, name: r.name, ext: r.ext, size: r.size, mtime: r.mtime, root: r.root || '', rel: r.rel || '', ingested: ingestInfo(ingMap, 'local:' + r.path, r.mtime) });
  }
  // 目录引用：实时遍历源目录，源目录增删文件时本列表同步变化
  for (const dr of getDirRefs()) {
    if (!fs.existsSync(dr.dir)) continue;
    const walkDir = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walkDir(p); }
        else if (!excl.has(p)) {
          let st; try { st = fs.statSync(p); } catch (_) { continue; }
          list.push({ path: 'local:' + p, name: entry.name, ext: path.extname(entry.name).slice(1).toLowerCase(), size: st.size, mtime: st.mtimeMs, root: dr.dir, rel: path.relative(dr.dir, p), ingested: ingestInfo(ingMap, 'local:' + p, st.mtimeMs) });
        }
      }
    };
    walkDir(dr.dir);
  }
  list.sort((a, b) => b.mtime - a.mtime);
  return list;
}

// 删除：local: 单文件引用移除清单；目录引用下的文件加入排除集（均不删本机文件）；raw/ 下才真正删除
function removeRaw(settings, relPath) {
  if (String(relPath).startsWith('local:')) {
    const abs = String(relPath).slice('local:'.length);
    const refs = getRefs();
    if (refs.some((r) => r.path === abs)) {
      saveRefs(refs.filter((r) => r.path !== abs));
      return { removed: relPath };
    }
    const excl = getExcl();
    if (!excl.includes(abs)) { excl.push(abs); saveExcl(excl); }
    return { removed: relPath };
  }
  if (!String(relPath).startsWith('raw/')) throw new Error('仅可删除 raw/ 下的原始来源');
  fs.rmSync(safeJoin(wikiRoot(settings), relPath));
  return { removed: relPath };
}

// 整个目录解除引用：移除目录引用，并清除其下的单文件引用与排除项（不删除任何本机文件）
function removeRawDir(settings, dir) {
  if (!dir) throw new Error('缺少目录路径');
  const under = (p) => String(p) === dir || String(p).startsWith(dir + '\\') || String(p).startsWith(dir + '/');
  const dirs = getDirRefs();
  const hadDirRef = dirs.some((d) => d.dir === dir);
  if (hadDirRef) saveDirRefs(dirs.filter((d) => d.dir !== dir));
  const refs = getRefs();
  const rest = refs.filter((r) => !under(r.path));
  if (rest.length !== refs.length) saveRefs(rest);
  const excl = getExcl();
  const restExcl = excl.filter((p) => !under(p));
  if (restExcl.length !== excl.length) saveExcl(restExcl);
  return { removed: dir, hadDirRef };
}

// 逐文件添加：不转存，直接记录本地路径引用；baseDir 存在时记录目录结构（root/rel）
async function addFiles(settings, paths, baseDir) {
  const added = [];
  const failed = [];
  const refs = getRefs();
  const exist = new Set(refs.map((r) => r.path));
  for (const p of paths || []) {
    try {
      const abs = path.resolve(p);
      if (!fs.existsSync(abs)) throw new Error('文件不存在：' + p);
      const ext = path.extname(abs).slice(1).toLowerCase();
      if (exist.has(abs)) { failed.push({ path: p, error: '已添加' }); continue; }
      const st = fs.statSync(abs);
      refs.push({ path: abs, name: path.basename(abs), ext, size: st.size, mtime: st.mtimeMs, addedAt: Date.now(), root: baseDir || '', rel: baseDir ? path.relative(baseDir, abs) : '' });
      exist.add(abs);
      added.push({ relPath: 'local:' + abs, title: path.basename(abs).replace(/\.[^.]+$/, ''), ext });
    } catch (err) {
      failed.push({ path: p, error: err.message });
    }
  }
  saveRefs(refs);
  return { added, failed };
}

// 目录导入上限：防误选超大目录导致长时间阻塞（引用式不复制，上限放宽）
const MAX_DIR_FILES = 5000;
// 跳过依赖/隐藏/构建产物目录，保留用户内容目录（原样引用多级结构）
const SKIP_DIRS = new Set(['.venv', 'node_modules', '.git', '.idea', '.vscode', '.qoder', '__pycache__', '.DS_Store', 'dist', 'build', 'target']);

async function addDir(settings, dir) {
  if (!fs.existsSync(dir)) throw new Error('目录不存在：' + dir);
  const abs0 = path.resolve(dir);
  // 移除该目录下的单文件引用，改由目录引用实时遍历
  saveRefs(getRefs().filter((r) => !String(r.path).startsWith(abs0 + path.sep) && r.path !== abs0));
  const dirs = getDirRefs();
  if (!dirs.some((d) => d.dir === abs0)) dirs.push({ dir: abs0, addedAt: Date.now() });
  saveDirRefs(dirs);
  // 计数（仅用于提示）
  let count = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(p); } else count++;
    }
  };
  try { walk(abs0); } catch (_) {}
  return { added: count, failed: [], skipped: 0 };
}

// 一次性迁移：把存量「按目录添加」的单文件引用（root 非空）升级为目录引用（实时遍历）
function migrateFileRefsToDirs() {
  const refs = getRefs();
  const roots = [...new Set(refs.filter((r) => r.root).map((r) => r.root))];
  if (!roots.length) return;
  const dirs = getDirRefs();
  for (const r0 of roots) if (!dirs.some((d) => d.dir === r0) && fs.existsSync(r0)) dirs.push({ dir: r0, addedAt: Date.now() });
  saveDirRefs(dirs);
  saveRefs(refs.filter((r) => !r.root));
}

// 一次性迁移：把 raw/ 顶层的存量 md（均为吸收自动生成）移入 raw/_auto/，
// 使「原始文件」只管理用户从本机添加的文件/目录；用户自建子目录不受影响。
function migrateAutoRaws(settings) {
  const rawDir = path.join(wikiRoot(settings), 'raw');
  const marker = path.join(rawDir, '.migrated-auto');
  if (!fs.existsSync(rawDir) || fs.existsSync(marker)) return;
  const autoDir = path.join(rawDir, '_auto');
  let moved = 0;
  for (const entry of fs.readdirSync(rawDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      fs.mkdirSync(autoDir, { recursive: true });
      try { fs.renameSync(path.join(rawDir, entry.name), path.join(autoDir, entry.name)); moved++; } catch (_) {}
    }
  }
  try { fs.writeFileSync(marker, JSON.stringify({ moved, at: new Date().toISOString() })); } catch (_) {}
}

// 混合导入：选择器支持同时选中文件与目录，这里按类型拆分后分别走 addFiles / addDir
async function addPaths(settings, pathsList) {
  const dirs = [];
  const files = [];
  for (const p of pathsList || []) {
    let st;
    try { st = fs.statSync(p); } catch (_) { continue; }
    if (st.isDirectory()) dirs.push(p);
    else files.push(p);
  }
  let total = 0;
  const failed = [];
  let skipped = 0;
  if (files.length) {
    const fr = await addFiles(settings, files);
    total += fr.added.length;
    failed.push(...fr.failed);
  }
  for (const d of dirs) {
    const dr = await addDir(settings, d);
    total += dr.added || 0;
    skipped += dr.skipped || 0;
  }
  return { added: total, failed, skipped, dirCount: dirs.length };
}

module.exports = { listRaws, removeRaw, removeRawDir, addFiles, addDir, addPaths, migrateAutoRaws, migrateFileRefsToDirs, SKIP_DIRS, markIngested, isIngestedFresh, backfillIngested };
