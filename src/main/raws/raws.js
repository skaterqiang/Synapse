// 原始文件管理层：raw/ 自动生成来源 + 本机文件引用（不转存，直接记录本地路径）
const path = require('path');
const fs = require('fs');
const db = require('../common/db');
const { num } = require('../common/config');
const { rawsRoot, safeJoin } = require('./root');
const { FILE_EXTENSIONS, readRawTextForScan, fetchUrlTitleRich, isPlaceholderTitle } = require('./files');

// 本机引用（kv 存储，不复制文件）：
//  raw_refs 单文件引用；raw_dir_refs 目录引用（实时遍历，随源变化）；raw_excluded 目录引用下被用户移除的路径
const REFS_KEY = 'raw_refs';
const DIRS_KEY = 'raw_dir_refs';
const EXCL_KEY = 'raw_excluded';
const URLS_KEY = 'raw_url_refs';
function getRefs() { try { return JSON.parse(db.getKv(REFS_KEY) || '[]'); } catch (_) { return []; } }
function saveRefs(list) { db.setKv(REFS_KEY, JSON.stringify(list)); db.flush(); }
function getDirRefs() { try { return JSON.parse(db.getKv(DIRS_KEY) || '[]'); } catch (_) { return []; } }
function saveDirRefs(list) { db.setKv(DIRS_KEY, JSON.stringify(list)); db.flush(); }
function getExcl() { try { return JSON.parse(db.getKv(EXCL_KEY) || '[]'); } catch (_) { return []; } }
function saveExcl(list) { db.setKv(EXCL_KEY, JSON.stringify(list)); db.flush(); }
// 网页链接引用（不下载、不转存，仅保存链接信息）：读取时再按需拉取
function getUrlRefs() { try { return JSON.parse(db.getKv(URLS_KEY) || '[]'); } catch (_) { return []; } }
function saveUrlRefs(list) { db.setKv(URLS_KEY, JSON.stringify(list)); db.flush(); }

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
  const rawDir = path.join(rawsRoot(settings), 'raw');
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
      else if (!entry.name.startsWith('.') && !isNoiseFile(entry.name)) {
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
  // 单文件引用（存在、未被排除、且不是噪声）；早年已录入的噪声引用也在此隐去，无需手工清理
  for (const r of getRefs()) {
    if (!fs.existsSync(r.path) || excl.has(r.path) || isNoiseFile(r.name || path.basename(r.path))) continue;
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
        else if (!excl.has(p) && !isNoiseFile(entry.name)) {
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
  // 网页链接引用（仅保存链接信息，读取时再拉取）：优先展示网页标题，其次 URL 简名；
  // 已落库的占位标题（历史数据里的 loading 之类）也当作无标题，不需手工清理
  for (const u of getUrlRefs()) {
    const shown = isPlaceholderTitle(u.title) ? urlDisplayName(u.url) : u.title;
    list.push({ path: 'url:' + u.url, name: shown, ext: 'url', size: 0, mtime: u.addedAt || 0, ingested: ingestInfo(ingMap, 'url:' + u.url, 0) });
  }
  list.sort((a, b) => b.mtime - a.mtime);
  if (truncated.length) list.truncated = truncated;
  return list;
}

// 删除：local:/url: 引用移除清单（不删本机文件/不删网页）；raw/ 下才真正删除
function removeRaw(settings, relPath) {
  if (String(relPath).startsWith('url:')) {
    const url = String(relPath).slice('url:'.length);
    const refs = getUrlRefs();
    if (refs.some((r) => r.url === url)) saveUrlRefs(refs.filter((r) => r.url !== url));
    return { removed: relPath };
  }
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
  fs.rmSync(safeJoin(rawsRoot(settings), relPath));
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
  const skippedNoise = [];
  const refs = getRefs();
  const exist = new Set(refs.map((r) => r.path));
  for (const p of paths || []) {
    try {
      const abs = path.resolve(p);
      if (!fs.existsSync(abs)) throw new Error('文件不存在：' + p);
      // 噪声文件静默跳过（不计失败）：拖拽整目录时常会带进来，报错只是噪音
      if (isNoiseFile(path.basename(abs))) { skippedNoise.push(path.basename(abs)); continue; }
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
  return { added, failed, skippedNoise };
}

// 添加网页链接：不下载正文、不转存为本地 md，只保存链接信息；
// 展示名获取三级回退：匿名元数据 → 隐藏窗真实渲染 → 应用内登录（weblogin 模块）；
// 全部失败留空、展示时回退到 URL 简名，渲染层再给补填/改名兜底
// credentials 可选 { username, password }：需登录站点弹出登录窗时自动填充
async function addUrl(settings, url, title, credentials) {
  const clean = String(url || '').trim();
  if (!/^https?:\/\//i.test(clean)) throw new Error('链接需以 http:// 或 https:// 开头');
  const refs = getUrlRefs();
  if (refs.some((r) => r.url === clean)) throw new Error('该链接已添加');
  let name = (title || '').trim();
  let login = false;
  if (!name) {
    const rich = await fetchUrlTitleRich(clean, num(settings, 'urlFetchTimeout', 30, 1, 600), credentials);
    name = rich.title || '';
    login = !!rich.login;
  }
  refs.push({ url: clean, title: name, addedAt: Date.now() });
  saveUrlRefs(refs);
  return { relPath: 'url:' + clean, title: name || urlDisplayName(clean), login };
}

// 无标题时的兜底展示名：域名 + 末段路径，比几百字符的完整 URL（带一堆 query）可读得多
function urlDisplayName(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(seg ? `${u.hostname}/${seg}` : u.hostname);
  } catch (_) {
    return url;
  }
}

// 重命名链接展示名：需登录的页面（语雀/飞书等）服务端拿不到真标题，给个手改的口子；
// title 传空则清除自定义名，下次展示回退到 URL 简名
function renameUrl(settings, url, title) {
  const clean = String(url || '').replace(/^url:/, '').trim();
  const refs = getUrlRefs();
  const hit = refs.find((r) => r.url === clean);
  if (!hit) throw new Error('链接不存在：' + clean);
  hit.title = String(title || '').trim().slice(0, 120);
  saveUrlRefs(refs);
  return { relPath: 'url:' + clean, title: hit.title || urlDisplayName(clean) };
}

// 跳过依赖/隐藏/构建产物目录，保留用户内容目录（原样引用多级结构）
const SKIP_DIRS = new Set(['.venv', 'node_modules', '.git', '.idea', '.vscode', '.qoder', '__pycache__', '.DS_Store', 'dist', 'build', 'target']);

// 噪声文件：系统元数据与办公软件临时文件。它们无可提取内容，
// 却会占满目录引用的文件数上限、在作业里刷出一堆“不支持的文件格式”失败项，因此扫描阶段就滤掉
const SKIP_FILES = new Set(['.DS_Store', '.localized', 'Thumbs.db', 'thumbs.db', 'ehthumbs.db', 'desktop.ini', 'Icon\r', '.gitkeep', '.gitignore']);
function isNoiseFile(name) {
  const n = String(name || '');
  if (!n || SKIP_FILES.has(n)) return true;
  if (n.startsWith('~$')) return true;          // Office 打开文档时的锁文件（~$xxx.docx）
  if (n.startsWith('._')) return true;          // macOS AppleDouble 副本
  if (/\.(tmp|temp|crdownload|part|swp|swo|bak)$/i.test(n)) return true;
  if (/^\.~lock\./.test(n)) return true;         // LibreOffice 锁文件
  return false;
}

// 单个目录引用的文件数上限（递归计数，settings.rawDirMaxFiles 可调）：
// 目录引用会被实时遍历，过大的目录会拖慢列表与后续吸收，故在添加时就拒绝
const DEFAULT_MAX_DIR_FILES = 500;
const dirMaxFiles = (settings) => num(settings, 'rawDirMaxFiles', DEFAULT_MAX_DIR_FILES, 10, 100000);

// 递归统计目录下文件数（不计噪声文件，与列表/吸收口径一致）；达到 limit 即提前停止
function countDirFiles(dir, limit) {
  let count = 0;
  const walk = (d) => {
    if (limit && count > limit) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (limit && count > limit) return;
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(p); }
      else if (!isNoiseFile(entry.name)) count++;
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
  const rawDir = path.join(rawsRoot(settings), 'raw');
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
  const urls = [];
  for (const it of listRaws(settings)) {
    const ext = String(it.ext || '').toLowerCase();
    if (TEXT_EXTS.has(ext)) cheap.push(it);
    else if (RICH_EXTS.has(ext)) rich.push(it);
    else if (ext === 'url') urls.push(it); // 链接引用：读取时实时拉取正文，同样参与检索
  }
  // 名称命中问题关键词的来源优先扫描：用户问「山东高速迁移上云方案」而原始文件里
  // 恰好有同名链接/文件时，必须第一时间读到它。否则链接排在队列末尾、又每个都要一次
  // 网络请求，时间预算常被本地文件耗尽，导致「明明有这条来源却没用上」。
  // 链接类更甚：它是用户亲手添加的指向性来源，名称命中时置顶于一切本地文件之前。
  const lowQ = String(question || '').toLowerCase();
  const nameHit = (it) => {
    const n = String(it.name || '').toLowerCase();
    if (!n) return false;
    return tokens.some((t) => n.includes(t));
  };
  const prio = [...urls.filter(nameHit), ...cheap.filter(nameHit), ...rich.filter(nameHit)];
  const rest = [...cheap, ...rich, ...urls].filter((it) => !prio.includes(it));
  const candidates = [...prio, ...rest];
  const t0 = Date.now();
  let scanned = 0;
  let timedOut = false;
  const hits = [];
  const urlFails = [];
  const scanOne = async (it) => {
    const isUrl = String(it.ext || '').toLowerCase() === 'url';
    // 进度回调：让 UI 实时看到扫描/链接读取进展（链接类单次读取可能耗时数十秒）
    if (typeof opts.onScan === 'function') {
      try { opts.onScan({ idx: scanned, total: candidates.length, kind: isUrl ? 'url' : 'file', name: it.name || it.path }); } catch (_) { /* 忽略 */ }
    }
    scanned++;
    let text = '';
    let readErr = '';
    try {
      // 纯文本读头部、富文本优先磁盘缓存（未命中才整篇提取并落缓存），url 实时拉取
      text = String((await readRawTextForScan(settings, it.path, maxBytes)) || '');
      if (!isUrl) text = text.slice(0, maxBytes);
    } catch (err) { readErr = err.message || String(err); }
    if (isUrl && (!text || readErr)) {
      // 链接读取失败（登录态缺失/超时/429 等）必须可见，否则用户只看到「没使用」却不知原因
      urlFails.push({ name: it.name || it.path, error: readErr || '正文为空' });
      return;
    }
    if (!text) return;
    const m = matchInText(text, tokens, snippetChars);
    if (!m) return;
    hits.push({ path: it.path, name: it.name, ext: it.ext, root: it.root || '', rel: it.rel || '', score: m.score, matched: m.matched, snippets: m.snippets });
  };
  // 优先队列串行：名称命中的链接逐条读、进度清晰；独立预算不受普通截断
  for (const it of prio) {
    if (Date.now() - t0 > Math.max(budgetMs, 60000)) { timedOut = true; break; }
    await scanOne(it);
  }
  // 普通队列并发 4：首次提取富文本（内置解析）不再串行排队；命中缓存后更是毫秒级。
  // 预算按批检查：缓存命中时整批毫秒完成，实际扫描量远大于旧串行版
  if (!timedOut) {
    const CONC = 4;
    for (let i = 0; i < rest.length; i += CONC) {
      if (Date.now() - t0 > budgetMs) { timedOut = true; break; }
      await Promise.all(rest.slice(i, i + CONC).map((it) => scanOne(it)));
    }
  }
  hits.sort((a, b) => b.score - a.score);
  // strong：命中具体长词（如 renovation/flask）或多词密集命中，置信度较高；
  // 弱命中仍返回（供模型自行取舍），但界面不应把它当成已验证的依据
  const out = hits.slice(0, topN).map((h) => ({
    ...h,
    strong: h.matched.some((t) => t.length >= 4) || h.matched.length >= 3 || h.score >= 8,
  }));
  return { hits: out, scanned, candidates: candidates.length, timedOut, urlFails };
}

module.exports = { listRaws, removeRaw, removeRawDir, addFiles, addDir, addPaths, addUrl, renameUrl, urlDisplayName, migrateAutoRaws, migrateFileRefsToDirs, SKIP_DIRS, isNoiseFile, DEFAULT_MAX_DIR_FILES, dirMaxFiles, countDirFiles, searchRaws, markIngested, isIngestedFresh, backfillIngested };
