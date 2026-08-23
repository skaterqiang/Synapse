// 原始文件管理层：raw/ 自动生成来源 + 本机文件引用（不转存，直接记录本地路径）
const path = require('path');
const fs = require('fs');
const db = require('../common/db');
const { num } = require('../common/config');
const { wikiRoot, safeJoin } = require('./wiki');
const { FILE_EXTENSIONS, readRawText } = require('./files');

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
    let entries;
    // 单个不可读目录不能让整份列表失败
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== '_auto') walk(p); }
      else if (!entry.name.startsWith('.')) {
        let st;
        try { st = fs.statSync(p); } catch (_) { continue; }
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
  // 目录引用：实时遍历源目录，源目录增删文件时本列表同步变化。
  // 每个引用封顶（settings.rawDirMaxFiles）：早年可能存下过超大目录（甚至根目录），
  // 不封顶会每次刷新都扫全盘；超出部分记入 truncated 供界面告警
  const limit = dirMaxFiles(settings);
  const truncated = [];
  for (const dr of getDirRefs()) {
    if (!fs.existsSync(dr.dir)) continue;
    let n = 0;
    let cut = false;
    const walkDir = (d) => {
      if (n >= limit) { cut = true; return; }
      let entries;
      // 无权限/已删除的子目录直接跳过，不能抛出（否则整份列表为空）
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
      for (const entry of entries) {
        if (n >= limit) { cut = true; return; }
        const p = path.join(d, entry.name);
        if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walkDir(p); }
        else if (!excl.has(p)) {
          let st; try { st = fs.statSync(p); } catch (_) { continue; }
          n++;
          list.push({ path: 'local:' + p, name: entry.name, ext: path.extname(entry.name).slice(1).toLowerCase(), size: st.size, mtime: st.mtimeMs, root: dr.dir, rel: path.relative(dr.dir, p), ingested: ingestInfo(ingMap, 'local:' + p, st.mtimeMs) });
        }
      }
    };
    walkDir(dr.dir);
    // 被截断时再数一次实际规模（封顶 limit*20），让告警能说出到底有多少
    if (cut) truncated.push({ dir: dr.dir, shown: n, total: countDirFiles(dr.dir, limit * 20) });
  }
  list.sort((a, b) => b.mtime - a.mtime);
  if (truncated.length) list.truncated = truncated;
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

// 跳过依赖/隐藏/构建产物目录，保留用户内容目录（原样引用多级结构）
const SKIP_DIRS = new Set(['.venv', 'node_modules', '.git', '.idea', '.vscode', '.qoder', '__pycache__', '.DS_Store', 'dist', 'build', 'target']);

// 单个目录引用的文件数上限（递归计数，settings.rawDirMaxFiles 可调）：
// 目录引用会被实时遍历，过大的目录会拖慢列表与后续吸收，故在添加时就拒绝
const DEFAULT_MAX_DIR_FILES = 500;
const dirMaxFiles = (settings) => num(settings, 'rawDirMaxFiles', DEFAULT_MAX_DIR_FILES, 10, 100000);

// 递归统计目录下文件数；达到 limit 即提前停止（大目录不用走完）
function countDirFiles(dir, limit) {
  let count = 0;
  const walk = (d) => {
    if (limit && count > limit) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (limit && count > limit) return;
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(p); } else count++;
    }
  };
  walk(dir);
  return count;
}

async function addDir(settings, dir) {
  if (!fs.existsSync(dir)) throw new Error('目录不存在：' + dir);
  const abs0 = path.resolve(dir);
  const limit = dirMaxFiles(settings);
  // 先校数量再登记：超限时不能把目录引用写进去
  const count = countDirFiles(abs0, limit);
  if (count > limit) {
    throw new Error(`目录文件数超过上限（最多 ${limit} 个，已超过）：${abs0}。请改选更小的子目录，或在设置→作业中调高“单目录文件数上限”。`);
  }
  // 移除该目录下的单文件引用，改由目录引用实时遍历
  saveRefs(getRefs().filter((r) => !String(r.path).startsWith(abs0 + path.sep) && r.path !== abs0));
  const dirs = getDirRefs();
  if (!dirs.some((d) => d.dir === abs0)) dirs.push({ dir: abs0, addedAt: Date.now() });
  saveDirRefs(dirs);
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
    // 单个目录超限/失败不影响其余选中项，分开记录原因
    try {
      const dr = await addDir(settings, d);
      total += dr.added || 0;
      skipped += dr.skipped || 0;
    } catch (err) {
      failed.push({ path: d, error: err.message });
    }
  }
  return { added: total, failed, skipped, dirCount: dirs.length, maxDirFiles: dirMaxFiles(settings) };
}

// ---------- 原始文件关键字检索（作为 AI 问答的知识源）----------
// 约当于 grep，但用纯 Node 实现：不调 grep/findstr，Windows 与 macOS 行为一致，
// 也避开路径/中文/引号的 shell 转义问题。
// 纯文本/代码直接按字节读头部；富文本（pdf/docx/…）走已有的抽取器，因较慢排在后面
const TEXT_EXTS = new Set([
  'md', 'markdown', 'txt', 'csv', 'tsv', 'json', 'jsonl', 'log', 'html', 'htm', 'xml', 'yml', 'yaml',
  'ini', 'conf', 'cfg', 'toml', 'env', 'properties', 'sql', 'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'java', 'go', 'rs', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'rb', 'sh', 'bash', 'zsh', 'bat', 'ps1',
  'vue', 'svelte', 'css', 'scss', 'less', 'r', 'swift', 'kt', 'pl', 'lua', 'tex', 'gradle', 'dockerfile',
]);
const RICH_EXTS = new Set(['pdf', 'docx', 'xlsx', 'xls', 'pptx']);

// 问题分词：英文单词 + 中文二元组（与笔记检索口径一致）；单字过于通用，剔除。
// 含虚词/疑问词的二元组（如“算的”“的最”“一下”）多是跳词碎片，会带来大量
// 假命中（实测其 df 反而最低，无法靠稀有度过滤），故在分词阶段就去除
const STOP_CHARS = new Set('的了是在和与或怎么吗呢吧呢请帮我你您他它这那哪有些个被把给对从到为也就都还再吗呢下上一吗');
function searchTokens(question) {
  const q = String(question || '').toLowerCase();
  const set = new Set();
  (q.match(/[a-z0-9_.+-]{2,}/g) || []).forEach((w) => set.add(w));
  for (const seg of (q.match(/[\u4e00-\u9fa5]+/g) || [])) {
    for (let i = 0; i < seg.length - 1; i++) {
      const bi = seg.slice(i, i + 2);
      if (STOP_CHARS.has(bi[0]) || STOP_CHARS.has(bi[1])) continue;
      set.add(bi);
    }
  }
  return [...set].filter((t) => t.length >= 2);
}

// 按字节读取文件头部（避免整个大日志载入内存）；含 NUL 字节则当二进制跳过
function readTextHead(abs, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    const slice = buf.slice(0, n);
    if (slice.includes(0)) return '';
    return slice.toString('utf-8');
  } catch (_) {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

const absOfRaw = (settings, relPath) => (String(relPath).startsWith('local:')
  ? String(relPath).slice('local:'.length)
  : path.join(wikiRoot(settings), String(relPath).replace(/^\//, '')));

// 在单份文本里打分并取命中片段；证据不足返回 null
function matchInText(text, tokens, snippetChars) {
  const low = text.toLowerCase();
  const matched = [];
  let score = 0;
  const positions = [];
  for (const t of tokens) {
    let idx = low.indexOf(t);
    if (idx === -1) continue;
    matched.push(t);
    let cnt = 0;
    while (idx !== -1 && cnt < 20) {
      if (positions.length < 40) positions.push(idx);
      cnt++;
      idx = low.indexOf(t, idx + t.length);
    }
    score += cnt + (t.length >= 4 ? 3 : 0);
  }
  const longest = matched.reduce((a, t) => Math.max(a, t.length), 0);
  // 与笔记检索同一尺度：需 ≥2 个不同关键词，或一个足够具体的长词
  if (!(matched.length >= 2 || longest >= 4)) return null;
  // 取前几处命中的上下文，合并重叠区间
  positions.sort((a, b) => a - b);
  const spans = [];
  for (const p of positions) {
    const s = Math.max(0, p - 60);
    const e = Math.min(text.length, p + 120);
    const last = spans[spans.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else spans.push([s, e]);
    if (spans.length >= 4) break;
  }
  let used = 0;
  const snippets = [];
  for (const [s, e] of spans) {
    if (used >= snippetChars) break;
    const piece = text.slice(s, Math.min(e, s + (snippetChars - used))).replace(/\s+/g, ' ').trim();
    if (piece) { snippets.push(piece); used += piece.length; }
  }
  return { score, matched, snippets };
}

// 检索已引入的原始文件，返回命中文件与片段。
// 带时间与体量预算：引用可能有上千个文件，不能让单次提问无限期阻塞
async function searchRaws(settings, question, opts = {}) {
  const topN = Math.max(1, opts.topN || 5);
  const budgetMs = Math.max(500, opts.budgetMs || 8000);
  const maxBytes = Math.max(4096, opts.maxBytes || 512 * 1024);
  const snippetChars = Math.max(100, opts.snippetChars || 700);
  const tokens = searchTokens(question);
  if (!tokens.length) return { hits: [], scanned: 0, candidates: 0, timedOut: false };

  const cheap = [];
  const rich = [];
  for (const it of listRaws(settings)) {
    const ext = String(it.ext || '').toLowerCase();
    if (TEXT_EXTS.has(ext)) cheap.push(it);
    else if (RICH_EXTS.has(ext)) rich.push(it);
  }
  const candidates = [...cheap, ...rich];
  const t0 = Date.now();
  let scanned = 0;
  let timedOut = false;
  const hits = [];
  for (const it of candidates) {
    if (Date.now() - t0 > budgetMs) { timedOut = true; break; }
    scanned++;
    let text = '';
    try {
      if (TEXT_EXTS.has(String(it.ext || '').toLowerCase())) text = readTextHead(absOfRaw(settings, it.path), maxBytes);
      else text = String((await readRawText(settings, it.path)) || '').slice(0, maxBytes);
    } catch (_) { continue; }
    if (!text) continue;
    const m = matchInText(text, tokens, snippetChars);
    if (!m) continue;
    hits.push({ path: it.path, name: it.name, ext: it.ext, root: it.root || '', rel: it.rel || '', score: m.score, matched: m.matched, snippets: m.snippets });
  }
  hits.sort((a, b) => b.score - a.score);
  // strong：命中具体长词（如 renovation/flask）或多词密集命中，置信度较高；
  // 弱命中仍返回（供模型自行取舍），但界面不应把它当成已验证的依据
  const out = hits.slice(0, topN).map((h) => ({
    ...h,
    strong: h.matched.some((t) => t.length >= 4) || h.matched.length >= 3 || h.score >= 8,
  }));
  return { hits: out, scanned, candidates: candidates.length, timedOut };
}

module.exports = { listRaws, removeRaw, removeRawDir, addFiles, addDir, addPaths, migrateAutoRaws, migrateFileRefsToDirs, SKIP_DIRS, DEFAULT_MAX_DIR_FILES, dirMaxFiles, countDirFiles, searchRaws, markIngested, isIngestedFresh, backfillIngested };
