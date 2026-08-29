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

// 「垃圾桶」目录：未分类（folderId=null）的笔记统一落盘到 <note根>/trash/，
// 不再平铺在 note 根下；该目录为系统保留目录，不参与目录树合成、不会被空目录清理删除
const TRASH_DIR = 'trash';
const isTrashRel = (rel) => rel === TRASH_DIR || rel.startsWith(TRASH_DIR + '/');

// ---------- frontmatter 序列化/解析 ----------
// source：笔记的来源标识（如 local:/abs/path）。它是“重复提取应该更新而不是新增”的依据，
// 因此必须随笔记文件一起持久化（写入 frontmatter）
function serializeNote(n) {
  const fm = [
    '---',
    `id: ${n.id}`,
    `title: "${String(n.title || '').replace(/"/g, '\\"')}"`,
    `tags: ${JSON.stringify(Array.isArray(n.tags) ? n.tags : [])}`,
    `pinned: ${n.pinned ? 1 : 0}`,
    `createdAt: ${n.createdAt || 0}`,
    `updatedAt: ${n.updatedAt || 0}`,
  ];
  // trashFrom：移入垃圾桶前的目录相对路径（''=根目录）；仅垃圾桶内笔记携带，供「还原到原来的位置」
  if (n.trashFrom != null) fm.push(`trashFrom: "${String(n.trashFrom).replace(/"/g, '\\"')}"`);
  if (n.source) fm.push(`source: ${String(n.source).replace(/[\r\n]+/g, ' ')}`);
  fm.push('---');
  return `${fm.join('\n')}\n\n${n.content || ''}`;
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
  let trashFrom;
  if (fm.trashFrom != null) {
    let v = fm.trashFrom;
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\"/g, '"');
    trashFrom = v;
  }
  return {
    id: fm.id || '',
    title,
    tags: Array.isArray(tags) ? tags : [],
    pinned: fm.pinned === '1',
    createdAt: Number(fm.createdAt) || 0,
    updatedAt: Number(fm.updatedAt) || 0,
    source: fm.source || '',
    trashFrom,
    content: body,
  };
}

// ---------- 目录 ↔ 磁盘路径 ----------
// folder id → 相对 note 根目录的路径（按名称链拼接）；统一用 / 分隔，与 scanNotes 的键形式一致
// （path.join 在 Windows 上会自行归一分隔符，因此拼实际路径不受影响）
function folderDirMap(folders) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const memo = new Map();
  const resolve = (id) => {
    if (memo.has(id)) return memo.get(id);
    const f = byId.get(id);
    if (!f) return '';
    const parent = f.parentId && byId.has(f.parentId) ? resolve(f.parentId) : '';
    const rel = parent ? `${parent}/${safeName(f.name, 'untitled')}` : safeName(f.name, 'untitled');
    memo.set(id, rel);
    return rel;
  };
  folders.forEach((f) => resolve(f.id));
  return memo;
}

// 扫描 note 根目录：返回 { id→文件路径, 全部 md 路径, 目录集合, 笔记自身目录集合 }
// 目录键统一用 / 分隔并去掉首尾斜杠：dirs 与 noteDirs 必须同一形式，否则“笔记自身目录”筛不掉
function scanNotes(root) {
  const found = new Map(); // id -> file
  const files = [];
  const dirs = new Set();
  const noteDirs = new Set(); // 与笔记文件同名同级的自身目录，不作为文件夹
  const relKey = (abs) => path.relative(root, abs).split(path.sep).join('/').replace(/^\/+|\/+$/g, '');
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        dirs.add(relKey(p));
        walk(p);
      } else if (entry.name.endsWith('.md')) {
        files.push(p);
        // 根目录下 path.relative 返回空串（不是 '.'），不判空会拼出 "/名字" 而永远对不上
        noteDirs.add(relKey(path.join(dir, entry.name.replace(/\.md$/, ''))));
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

function loadNotesFromDisk(folders, scan) {
  const root = notesRoot();
  const { found, files, dirs, noteDirs } = scan || scanNotes(root);
  const relToId = new Map();
  for (const [id, rel] of folderDirMap(folders)) relToId.set(rel, id);
  const notes = [];
  for (const [id, file] of found) {
    const n = parseNoteFile(file);
    const relDir = path.dirname(path.relative(root, file)).split(path.sep).join('/');
    const folderRel = relDir === '.' ? '' : relDir;
    // trash/ 下（含意外残留的更深层级）的笔记归为未分类，不合成目录记录
    const folderId = isTrashRel(folderRel) ? null : (relToId.get(folderRel) || null);
    const title = n.title || path.basename(file).replace(/\.md$/, '');
    // 历史 assets/ 附件引用归一到笔记自身目录，并回写磁盘
    const fixed = normalizeAssetRefs(n.content, title, folderId);
    if (fixed !== n.content) {
      n.content = fixed;
      try { fs.writeFileSync(file, serializeNote({ ...n, id: n.id || id, title }), 'utf-8'); } catch (_) {}
    }
    // 仅垃圾桶内笔记携带 trashFrom（原目录相对路径），其余目录残留的该字段不暴露给前端
    const trashFrom = isTrashRel(folderRel) ? (n.trashFrom != null ? n.trashFrom : '') : undefined;
    notes.push({ ...n, id: n.id || id, title, folderId, trashFrom });
  }
  notes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { notes, dirs, noteDirs, hasAnyNoteFile: files.length > 0 };
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

// 无效目录：整棵子树没有任何 .md 笔记文件（如残留空目录、孤立附件目录），不应合成/保留为目录
function collectInvalidDirs(root, dirs) {
  const hasMd = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (hasMd(p)) return true; }
      else if (e.name.endsWith('.md')) return true;
    }
    return false;
  };
  const invalid = new Set();
  for (const rel of dirs) {
    try { if (!hasMd(path.join(root, rel))) invalid.add(rel); } catch (_) { invalid.add(rel); }
  }
  return invalid;
}

function loadStore() {
  const folders = loadFolders();
  // 先扫盘并把「磁盘存在但 folders 表没有」的目录合成为目录记录，再计算笔记归属：
  // 否则实际目录不在 DB 的笔记（如被新版提取逻辑移出 trash、或外部工具挪动过文件）
  // 会因 relToId 查不到而归为未分类（folderId=null），persist 时又被搬回 trash
  const root = notesRoot();
  const scan = scanNotes(root);
  const { dirs, noteDirs } = scan;
  const invalidDirs = collectInvalidDirs(root, dirs);
  for (const rel of invalidDirs) {
    // 笔记自身目录（与某篇 .md 同名同级的附件目录，存放图片等）虽无 .md 文件，但属于活笔记，
    // 不能按「无笔记文件的残留目录」删除——否则 MinerU 抽取/粘贴的图片每次加载都会被清掉
    if (noteDirs.has(rel)) continue;
    try { fs.rmSync(path.join(root, rel), { recursive: true, force: true }); } catch (_) {}
  }
  // 过滤误入库的「笔记自身目录」文件夹行；合成来源（dir:*）且目录已不存在/无效的孤立记录一并清除
  const dirMap = folderDirMap(folders);
  const cleanFolders = folders.filter((f) => {
    const rel = dirMap.get(f.id) || '';
    if (noteDirs.has(rel)) return false;
    if (String(f.id).startsWith('dir:') && (!dirs.has(rel) || invalidDirs.has(rel))) return false;
    return true;
  });
  // 仅真实且有效的目录合成文件夹记录；笔记自身目录/无效目录不进入目录树
  const realDirs = [...dirs].filter((d) => !noteDirs.has(d) && !isTrashRel(d) && !invalidDirs.has(d));
  const allFolders = [...cleanFolders, ...synthesizeMissingFolders(cleanFolders, realDirs)];
  // 垃圾桶是虚拟根级目录：UI 显示「垃圾桶」，但不落 folders 表
  if (!allFolders.some((f) => f.id === '__trash__')) allFolders.push({ id: '__trash__', name: '垃圾桶', parentId: null });
  const { notes, hasAnyNoteFile } = loadNotesFromDisk(allFolders, scan);
  // hasAnyNoteFile：磁盘是否存在任何笔记文件——前端「首启种子笔记」据此判断，
  // 避免瞬时异常读到空列表时误种子并回写空列表导致磁盘笔记被清理
  return { folders: allFolders, notes, settings: settings.getSettings(), hasAnyNoteFile };
}

// ---------- 写入 ----------
// 目标文件路径：目录 + 安全标题；同目录重名（极端情况）追加短 id 后缀
function targetPathFor(root, dirMap, note, taken) {
  const rel = note.folderId ? dirMap.get(note.folderId) || '' : TRASH_DIR;
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
  fs.mkdirSync(path.join(root, TRASH_DIR), { recursive: true }); // 垃圾桶常驻
  const dirMap = folderDirMap(folders);
  const { found, noteDirs } = scanNotes(root);
  const taken = new Map();
  // 先于删除循环构建存活集合：删除循环必须先于写循环执行（防同名旧文件误删新文件）
  const aliveIds = new Set(notes.map((n) => n.id));

  // 先处理“列表里已不存在”的旧文件，再写新列表：
  // 否则同名不同 id 的旧文件（如重种子笔记）会把刚写好的新文件误删
  const trashDir = path.join(root, TRASH_DIR);
  for (const [id, file] of found) {
    if (aliveIds.has(id) || id.startsWith('file:')) continue;
    const inTrash = isTrashRel(path.relative(root, file).split(path.sep).join('/'));
    try {
      if (inTrash) {
        // 垃圾桶内的文件：列表已移除即视为用户明确删除（如清空垃圾桶）
        fs.rmSync(file);
      } else {
        // 垃圾桶外的文件：移入垃圾桶保留，绝不直接删除，防止异常空列表回写造成数据丢失
        fs.mkdirSync(trashDir, { recursive: true });
        let target = path.join(trashDir, path.basename(file));
        if (fs.existsSync(target)) target = path.join(trashDir, `${path.basename(file, '.md')}-${String(id).replace(/[^A-Za-z0-9]/g, '').slice(-6)}.md`);
        fs.renameSync(file, target);
      }
    } catch (_) {}
  }
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
  // 清理空目录（目录被改名/删除后残留）；笔记自身目录保留
  const validDirs = new Set([...dirMap.values()]);
  const prune = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) prune(path.join(dir, entry.name));
    }
    // 键形式必须与 validDirs / noteDirs 一致（统一 /），否则 Windows 上会把合法的空子目录误删
    // trash 顶层常驻（垃圾桶目录本身保留），其下空子目录可删；笔记自身目录仅在同名 .md 仍存在时保留
    const rel = path.relative(root, dir).split(path.sep).join('/');
    const isLiveNoteDir = noteDirs.has(rel) && fs.existsSync(dir + '.md');
    if (rel && rel !== TRASH_DIR && !validDirs.has(rel) && !isLiveNoteDir && fs.readdirSync(dir).length === 0) {
      try { fs.rmdirSync(dir); } catch (_) {}
    }
  };
  if (fs.existsSync(root)) prune(root);
}

function saveStore(store) {
  // 🗑 垃圾桶是虚拟目录（loadStore 每次合成），不落 folders 表
  const folders = (Array.isArray(store.folders) ? store.folders : []).filter((f) => f.id !== '__trash__');
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
  const dirRel = folderId ? folderDirMap(folders).get(folderId) || '' : TRASH_DIR;
  return path.join(notesRoot(), dirRel || '.', safeName(title, 'untitled'));
}

// 笔记文件所在目录（<note根>/<目录链>），用于「打开文件夹」
function notesDirFor(folderId) {
  const folders = loadFolders();
  const rel = folderId ? folderDirMap(folders).get(folderId) || '' : TRASH_DIR;
  return rel ? path.join(notesRoot(), rel) : notesRoot();
}

// 从原始来源直接落盘为笔记；folderRel 为来源目录相对路径，source 为来源标识（local:/abs/path 等）。
// 同一 source 重复提取时原地覆盖而不新建：否则反复跑一个目录会滞留出成倍的同名笔记，
// 列表里全是重复项、想找某个文件反而找不到
function importNote(title, content, folderRel, source) {
  const folders = loadFolders();
  const parts = String(folderRel || '').split(/[\\/]+/).map((s) => safeName(s, '')).filter(Boolean);
  let parentId = null;
  const dirMap = folderDirMap(folders);
  for (const name of parts) {
    const parentRel = parentId ? dirMap.get(parentId) || '' : '';
    const currentRel = parentRel ? `${parentRel}/${name}` : name;
    let folder = folders.find((f) => dirMap.get(f.id) === currentRel);
    if (!folder) {
      folder = { id: 'dir:' + uidForImport(), name, parentId };
      folders.push(folder);
      dirMap.set(folder.id, currentRel);
    }
    parentId = folder.id;
  }
  const now = Date.now();
  db.transaction(() => {
    db.run('DELETE FROM folders');
    for (const f of folders) db.run('INSERT INTO folders (id, name, parent_id) VALUES (?, ?, ?)', [String(f.id), String(f.name || ''), f.parentId == null ? null : String(f.parentId)]);
  });
  const { found, files } = scanNotes(notesRoot());
  // 同源已有笔记 → 只更新正文与时间，保留原 id/标签/置顶与原文件位置（用户可能已手动改过目录）；
  // 例外：旧笔记在垃圾桶（未分类）且本次提取带明确目标目录时，移出 trash 落到目标目录——
  // 单文件引用历史上 root/rel 为空导致目录信息缺失、笔记落入 trash，与「提取内容应进来源目录」的预期不符
  if (source) {
    const dirMap = folderDirMap(folders);
    const taken = new Map([...found.entries()].map(([existingId, f]) => [f, existingId]));
    for (const file of files) {
      let old;
      try { old = parseNoteFile(file); } catch (_) { continue; }
      if (old.source !== source) continue;
      const merged = { ...old, content: String(content || ''), updatedAt: now, source };
      const relDir = path.dirname(path.relative(notesRoot(), file)).split(path.sep).join('/');
      let target = file;
      let folderId = relDir === '.' ? null : ([...dirMap].find(([, rel]) => rel === relDir) || [null])[0];
      if (isTrashRel(relDir) && parentId) {
        target = targetPathFor(notesRoot(), dirMap, { id: merged.id, title: merged.title, folderId: parentId }, taken);
        if (target !== file) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.renameSync(file, target);
          // 笔记自身目录（附件）随迁，并重写正文 kb-asset 引用
          const oldAttach = path.join(path.dirname(file), path.basename(file, '.md'));
          const newAttach = path.join(path.dirname(target), path.basename(target, '.md'));
          if (fs.existsSync(oldAttach) && oldAttach !== newAttach) {
            try {
              fs.renameSync(oldAttach, newAttach);
              const oldPrefix = 'kb-asset://file' + encodeURI(oldAttach) + '/';
              const newPrefix = 'kb-asset://file' + encodeURI(newAttach) + '/';
              if (merged.content.includes(oldPrefix)) merged.content = merged.content.split(oldPrefix).join(newPrefix);
            } catch (_) { /* 附件目录随迁失败不影响笔记本体移出 trash */ }
          }
        }
        folderId = parentId;
      }
      fs.writeFileSync(target, serializeNote(merged), 'utf-8');
      db.flush();
      return { id: merged.id, title: merged.title, folderId, path: target, updated: true };
    }
  }
  const id = 'import:' + now.toString(36) + Math.random().toString(36).slice(2, 8);
  // 必须带上 folderId：targetPathFor 靠它解析落盘目录，不传则笔记会写到笔记根下，
  // 而刚建好的目录链里一篇笔记也没有（表现为“文件变成空目录”）
  const note = { id, title: safeName(title, '无标题笔记'), content: String(content || ''), tags: [], pinned: false, folderId: parentId, createdAt: now, updatedAt: now, source: source || '' };
  const taken = new Map([...found.entries()].map(([existingId, file]) => [file, existingId]));
  const target = targetPathFor(notesRoot(), folderDirMap(folders), note, taken);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, serializeNote(note), 'utf-8');
  fs.mkdirSync(path.join(path.dirname(target), path.basename(target, '.md')), { recursive: true });
  db.flush();
  return { id, title: note.title, folderId: parentId, path: target, updated: false };
}

function uidForImport() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// 一次性迁移：解码 URL 编码的笔记标题。历史上笔记标题直接取源文件名，源文件若是网页下载的
// URL 编码名（%E7%9F%A5…）标题/文件名即乱码，与 MinerU 测试展示的正常中文名不一致。
// 这里重写 frontmatter 标题并把笔记文件、同名附件目录改名为解码名；幂等（已解码的不再处理）
function migrateEncodedNoteTitles() {
  const root = notesRoot();
  if (!fs.existsSync(root)) return;
  const { files } = scanNotes(root);
  let fixed = 0;
  for (const file of files) {
    let note;
    try { note = parseNoteFile(file); } catch (_) { continue; }
    const title = String(note.title || '');
    if (!/%[0-9A-Fa-f]{2}/.test(title)) continue;
    let decoded;
    try { decoded = decodeURIComponent(title); } catch (_) { continue; }
    if (!decoded || decoded === title) continue;
    const newTitle = safeName(decoded, title);
    note.title = newTitle;
    try { fs.writeFileSync(file, serializeNote(note), 'utf-8'); } catch (_) { continue; }
    // 笔记文件改名为解码名；同名附件目录随迁（kb-asset 引用由下次加载的 normalizeAssetRefs 归一）
    const dir = path.dirname(file);
    const target = path.join(dir, newTitle + '.md');
    if (target !== file && !fs.existsSync(target)) {
      try {
        fs.renameSync(file, target);
        const oldAttach = path.join(dir, path.basename(file, '.md'));
        const newAttach = path.join(dir, newTitle);
        if (fs.existsSync(oldAttach) && !fs.existsSync(newAttach)) fs.renameSync(oldAttach, newAttach);
      } catch (_) { /* 改名失败不影响标题已修复 */ }
    }
    fixed++;
  }
  if (fixed) console.log('已解码 URL 编码笔记标题:', fixed, '篇');
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

module.exports = { loadStore, saveStore, getNotes, importLegacy, migrateDbNotesToFiles, rewriteNoteFiles, migrateAssetsToNoteDirs, migrateEncodedNoteTitles, noteAssetDir, notesDirFor, notesRoot, importNote, TRASH_DIR };
