// 笔记领域数据存取：笔记全部落文件系统（<根目录>/note/<目录>/<标题>.md，frontmatter 存元数据）
// 目录（folders）元数据仍存 SQLite；笔记内容/标签/置顶等不再入库
const path = require('path');
const fs = require('fs');
const db = require('../common/db');
const settings = require('../common/settings');
const paths = require('../common/paths');

function notesRoot() {
  return path.join(paths.dataRoot(), 'note');
}

function safeName(s, dft) {
  return String(s || '').trim().replace(/[\\/:*?"<>|]/g, '-').slice(0, 80) || dft;
}

// ---------- frontmatter 序列化/解析 ----------
function serializeNote(n) {
  const fm = [
    '---',
    `id: ${n.id}`,
    `title: "${String(n.title || '').replace(/"/g, '\\"')}"`,
    `tags: ${JSON.stringify(Array.isArray(n.tags) ? n.tags : [])}`,
    `pinned: ${n.pinned ? 1 : 0}`,
    `createdAt: ${n.createdAt || 0}`,
    `updatedAt: ${n.updatedAt || 0}`,
    '---',
  ].join('\n');
  return `${fm}\n\n${n.content || ''}`;
}

function parseNoteFile(file) {
  const text = fs.readFileSync(file, 'utf-8');
  const fm = {};
  let body = text;
  if (text.startsWith('---\n')) {
    const end = text.indexOf('\n---', 4);
    if (end !== -1) {
      for (const line of text.slice(4, end).split('\n')) {
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
        if (m) fm[m[1]] = m[2].trim();
      }
      body = text.slice(end + 4).replace(/^\n/, '');
    }
  }
  let tags = [];
  try { tags = JSON.parse(fm.tags || '[]'); } catch (_) {}
  let title = fm.title || '';
  if (title.startsWith('"') && title.endsWith('"')) title = title.slice(1, -1).replace(/\\"/g, '"');
  return {
    id: fm.id || '',
    title,
    tags: Array.isArray(tags) ? tags : [],
    pinned: fm.pinned === '1',
    createdAt: Number(fm.createdAt) || 0,
    updatedAt: Number(fm.updatedAt) || 0,
    content: body,
  };
}

// ---------- 目录 ↔ 磁盘路径 ----------
// folder id → 相对 note 根目录的路径（按名称链拼接）
function folderDirMap(folders) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const memo = new Map();
  const resolve = (id) => {
    if (memo.has(id)) return memo.get(id);
    const f = byId.get(id);
    if (!f) return '';
    const parent = f.parentId && byId.has(f.parentId) ? resolve(f.parentId) : '';
    const rel = parent ? path.join(parent, safeName(f.name, 'untitled')) : safeName(f.name, 'untitled');
    memo.set(id, rel);
    return rel;
  };
  folders.forEach((f) => resolve(f.id));
  return memo;
}

// 扫描 note 根目录：返回 { id→文件路径, 全部 md 路径, 目录集合, 笔记自身目录集合 }
function scanNotes(root) {
  const found = new Map(); // id -> file
  const files = [];
  const dirs = new Set();
  const noteDirs = new Set(); // 与笔记文件同名同级的自身目录，不作为文件夹
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        dirs.add(path.relative(root, p));
        walk(p);
      } else if (entry.name.endsWith('.md')) {
        files.push(p);
        const relDir = path.relative(root, dir);
        noteDirs.add((relDir === '.' ? '' : relDir + '/') + entry.name.replace(/\.md$/, ''));
        try {
          const n = parseNoteFile(p);
          const id = n.id || 'file:' + path.relative(root, p);
          if (!found.has(id)) found.set(id, p);
        } catch (_) {}
      }
    }
  };
  walk(root);
  return { found, files, dirs, noteDirs };
}

// 磁盘上存在但 folders 表没有的目录 → 合成目录记录（保证 UI 与磁盘一致）
function synthesizeMissingFolders(folders, dirs) {
  const known = new Set([...folderDirMap(folders).values()]);
  const byRel = new Map(folders.map((f) => [folderDirMap(folders).get(f.id), f]));
  const extra = [...dirs].filter((d) => !known.has(d)).sort((a, b) => a.length - b.length);
  const synth = [];
  for (const rel of extra) {
    const parentRel = path.dirname(rel) === '.' ? '' : path.dirname(rel);
    const parent = byRel.get(parentRel) || synth.find((s) => s._rel === parentRel);
    const rec = { id: 'dir:' + rel, name: path.basename(rel), parentId: parent ? parent.id : null, _rel: rel };
    synth.push(rec);
    byRel.set(rel, rec);
  }
  return synth.map(({ _rel, ...rest }) => rest);
}

// ---------- 读取 ----------
function loadFolders() {
  return db.all('SELECT id, name, parent_id AS parentId FROM folders ORDER BY rowid');
}

function loadNotesFromDisk(folders) {
  const root = notesRoot();
  const { found, dirs, noteDirs } = scanNotes(root);
  const relToId = new Map();
  for (const [id, rel] of folderDirMap(folders)) relToId.set(rel, id);
  const notes = [];
  for (const [id, file] of found) {
    const n = parseNoteFile(file);
    const relDir = path.dirname(path.relative(root, file));
    const folderRel = relDir === '.' ? '' : relDir;
    const folderId = relToId.get(folderRel) || null;
    const title = n.title || path.basename(file).replace(/\.md$/, '');
    // 历史 assets/ 附件引用归一到笔记自身目录，并回写磁盘
    const fixed = normalizeAssetRefs(n.content, title, folderId);
    if (fixed !== n.content) {
      n.content = fixed;
      try { fs.writeFileSync(file, serializeNote({ ...n, id: n.id || id, title }), 'utf-8'); } catch (_) {}
    }
    notes.push({ ...n, id: n.id || id, title, folderId });
  }
  notes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { notes, dirs, noteDirs };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 正文中的 kb-asset 附件引用统一指向笔记自身目录（兼容历史 assets/ 与旧 appData 路径）
function normalizeAssetRefs(content, title, folderId) {
  if (!content || !content.includes('kb-asset://file')) return content;
  const newPrefix = 'kb-asset://file' + encodeURI(noteAssetDir(title, folderId)) + '/';
  const roots = [paths.assetsDir(), path.join(paths.legacyUserData(), 'assets')];
  let out = content;
  for (const r of roots) {
    const re = new RegExp('kb-asset://file' + escapeRe(encodeURI(r)) + '/[^/]+/', 'g');
    out = out.replace(re, newPrefix);
  }
  return out;
}

function loadStore() {
  const folders = loadFolders();
  const { notes, dirs, noteDirs } = loadNotesFromDisk(folders);
  // 过滤误入库的「笔记自身目录」文件夹行（下次保存时从表中清除）
  const dirMap = folderDirMap(folders);
  const cleanFolders = folders.filter((f) => !noteDirs.has(dirMap.get(f.id) || ''));
  // 仅真实目录合成文件夹记录；笔记自身目录不进入目录树
  const realDirs = [...dirs].filter((d) => !noteDirs.has(d));
  const allFolders = [...cleanFolders, ...synthesizeMissingFolders(cleanFolders, realDirs)];
  return { folders: allFolders, notes, settings: settings.getSettings() };
}

// ---------- 写入 ----------
// 目标文件路径：目录 + 安全标题；同目录重名（极端情况）追加短 id 后缀
function targetPathFor(root, dirMap, note, taken) {
  const rel = note.folderId ? dirMap.get(note.folderId) || '' : '';
  const dir = rel ? path.join(root, rel) : root;
  let base = safeName(note.title, 'untitled');
  let candidate = path.join(dir, base + '.md');
  if (taken.has(candidate) && taken.get(candidate) !== note.id) {
    base = `${base}-${String(note.id).slice(-6) || 'x'}`;
    candidate = path.join(dir, base + '.md');
  }
  taken.set(candidate, note.id);
  return candidate;
}

function writeNotesToDisk(folders, notes) {
  const root = notesRoot();
  fs.mkdirSync(root, { recursive: true });
  const dirMap = folderDirMap(folders);
  const { found, noteDirs } = scanNotes(root);
  const taken = new Map();
  const aliveIds = new Set();

  for (const n of notes) {
    aliveIds.add(n.id);
    const target = targetPathFor(root, dirMap, n, taken);
    const old = found.get(n.id);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (old && old !== target) {
        try { fs.renameSync(old, target); } catch (_) {}
      }
      fs.writeFileSync(target, serializeNote(n), 'utf-8');
      // 笔记自身目录（与笔记文件同名同级），存放该笔记的附件图片
      fs.mkdirSync(path.join(path.dirname(target), path.basename(target, '.md')), { recursive: true });
    } catch (err) {
      console.error('笔记写盘失败:', n.title, err.message);
    }
  }
  // 数据库里有、新列表里没有的笔记文件 → 删除
  for (const [id, file] of found) {
    if (!aliveIds.has(id) && !id.startsWith('file:')) {
      try { fs.rmSync(file); } catch (_) {}
    }
  }
  // 清理空目录（目录被改名/删除后残留）；笔记自身目录保留
  const validDirs = new Set([...dirMap.values()]);
  const prune = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) prune(path.join(dir, entry.name));
    }
    const rel = path.relative(root, dir);
    if (rel && !validDirs.has(rel) && !noteDirs.has(rel) && fs.readdirSync(dir).length === 0) {
      try { fs.rmdirSync(dir); } catch (_) {}
    }
  };
  if (fs.existsSync(root)) prune(root);
}

function saveStore(store) {
  const folders = Array.isArray(store.folders) ? store.folders : [];
  db.transaction(() => {
    db.run('DELETE FROM folders');
    for (const f of folders) {
      db.run('INSERT INTO folders (id, name, parent_id) VALUES (?, ?, ?)', [
        String(f.id),
        String(f.name || ''),
        f.parentId == null ? null : String(f.parentId),
      ]);
    }
    db.setKv('settings', JSON.stringify(store.settings || {}));
  });
  writeNotesToDisk(folders, Array.isArray(store.notes) ? store.notes : []);
  db.flush();
}

// 仅笔记列表（供图谱等跨域只读使用）
function getNotes() {
  return loadStore().notes;
}

// 旧 knowledge-data.json 导入：folders 入库，笔记直接落文件
function importLegacy(data) {
  db.transaction(() => {
    for (const f of Array.isArray(data.folders) ? data.folders : []) {
      db.run('INSERT INTO folders (id, name, parent_id) VALUES (?, ?, ?)', [
        String(f.id),
        String(f.name || ''),
        f.parentId == null ? null : String(f.parentId),
      ]);
    }
    db.setKv('settings', JSON.stringify(data.settings || {}));
  });
  writeNotesToDisk(Array.isArray(data.folders) ? data.folders : [], Array.isArray(data.notes) ? data.notes : []);
}

// 首启迁移：数据库 notes 表存量笔记落文件，随后清空表（内容不再入库）
function migrateDbNotesToFiles() {
  if (!db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='notes'").length) return;
  const count = (db.all('SELECT COUNT(*) AS c FROM notes')[0] || {}).c || 0;
  if (!count) return;
  const folders = loadFolders();
  const notes = db
    .all('SELECT id, title, content, tags, folder_id AS folderId, pinned, created_at AS createdAt, updated_at AS updatedAt FROM notes ORDER BY rowid')
    .map((r) => {
      let tags = [];
      try { tags = JSON.parse(r.tags); } catch (_) {}
      return { ...r, tags: Array.isArray(tags) ? tags : [], pinned: !!r.pinned };
    });
  writeNotesToDisk(folders, notes);
  db.run('DELETE FROM notes');
  db.flush();
  console.log('笔记已从数据库迁移为文件:', count, '篇 →', notesRoot());
}

// 文件形态笔记：重写正文中的 kb-asset 附件引用前缀（根目录迁移后由本函数接管）
function rewriteNoteFiles(from, to) {
  const root = notesRoot();
  if (!fs.existsSync(root)) return;
  const search = 'kb-asset://file' + encodeURI(from);
  const replace = 'kb-asset://file' + encodeURI(to);
  const { files } = scanNotes(root);
  let n = 0;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf-8');
    if (text.includes(search)) {
      fs.writeFileSync(file, text.split(search).join(replace), 'utf-8');
      n++;
    }
  }
  if (n) console.log('笔记文件附件引用已重写:', n, '篇');
}

// 笔记附件目录：<note根>/<目录链>/<安全标题>/（与笔记文件同级）
function noteAssetDir(title, folderId) {
  const folders = loadFolders();
  const dirRel = folderId ? folderDirMap(folders).get(folderId) || '' : '';
  return path.join(notesRoot(), dirRel || '.', safeName(title, 'untitled'));
}

// 笔记文件所在目录（<note根>/<目录链>），用于「打开文件夹」
function notesDirFor(folderId) {
  const folders = loadFolders();
  const rel = folderId ? folderDirMap(folders).get(folderId) || '' : '';
  return rel ? path.join(notesRoot(), rel) : notesRoot();
}

// 旧 assets/<标题>/ 附件迁移到笔记自身目录，并重写正文 kb-asset 引用
function migrateAssetsToNoteDirs() {
  const assetsRoot = paths.assetsDir();
  if (!fs.existsSync(assetsRoot)) return;
  const { files } = scanNotes(notesRoot());
  let moved = 0;
  for (const entry of fs.readdirSync(assetsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = files.find((f) => path.basename(f, '.md') === entry.name);
    if (!target) continue;
    const oldDir = path.join(assetsRoot, entry.name);
    const noteDir = path.join(path.dirname(target), entry.name);
    fs.mkdirSync(noteDir, { recursive: true });
    for (const f of fs.readdirSync(oldDir)) {
      const to = path.join(noteDir, f);
      if (!fs.existsSync(to)) fs.renameSync(path.join(oldDir, f), to);
    }
    try { fs.rmdirSync(oldDir); } catch (_) {}
    const oldPrefix = 'kb-asset://file' + encodeURI(oldDir);
    const newPrefix = 'kb-asset://file' + encodeURI(noteDir);
    const text = fs.readFileSync(target, 'utf-8');
    if (text.includes(oldPrefix)) fs.writeFileSync(target, text.split(oldPrefix).join(newPrefix), 'utf-8');
    moved++;
  }
  if (moved) console.log('附件已迁移到笔记自身目录:', moved, '个');
}

module.exports = { loadStore, saveStore, getNotes, importLegacy, migrateDbNotesToFiles, rewriteNoteFiles, migrateAssetsToNoteDirs, noteAssetDir, notesDirFor, notesRoot };
