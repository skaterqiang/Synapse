// 技能在线安装：兼容 skills.sh / npx skills add 的安装方式
// 支持输入形态：
//   1) npx skills add https://github.com/anthropics/skills --skill docx
//   2) https://www.skills.sh/anthropics/skills/docx （或 /owner/repo 仓库页）
//   3) https://github.com/owner/repo （整库安装全部技能）
// 实现不依赖 npm/git：直接下载 GitHub 源码 zip（codeload），解压后把含 SKILL.md 的目录
// 拷贝到 <数据根>/skills/ 下，再由设置层以目录引用方式登记。
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { findSkillFile, readSkill } = require('./skills');
// paths 依赖 electron（app 路径），延迟到执行期加载，便于纯 Node 单测
function dataRoot() { return require('../common/paths').dataRoot(); }

// UA / 下载超时 / 包大小上限统一定义于 common/constants.js
const { HTTP_USER_AGENT: UA, SKILL_DOWNLOAD_TIMEOUT_MS: TIMEOUT_MS, SKILL_MAX_ZIP_BYTES: MAX_ZIP_BYTES } = require('../common/constants');

// ---------- 输入解析 ----------
// 从任意输入中提取 GitHub owner/repo、可选 skill 名；返回 { owner, repo, ref, skills[], source }
function parseSkillSource(input) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, error: '请输入安装来源' };

  // 形态1：npx skills add <url> [--skill a --skill b] / [--skill a,b]
  const npx = raw.match(/skills\s+add\s+["']?([^"'\s]+)["']?/i);
  if (npx) {
    const rest = raw.slice((npx.index || 0) + npx[0].length);
    const names = [];
    const re = /--skill(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/g;
    let m;
    while ((m = re.exec(rest))) {
      const v = (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]) || '';
      v.split(',').forEach((s) => { const t = s.trim(); if (t) names.push(t); });
    }
    const g = parseRepoUrl(npx[1]);
    if (!g) return { ok: false, error: '无法从命令中识别 GitHub 仓库地址：' + npx[1] };
    return { ok: true, owner: g.owner, repo: g.repo, ref: g.ref, skills: names, source: 'npx' };
  }

  // 形态2/3：URL
  if (/^https?:\/\//i.test(raw)) {
    let u;
    try { u = new URL(raw); } catch (_) { return { ok: false, error: 'URL 格式无效：' + raw }; }
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    const segs = u.pathname.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch (_) { return s; } });
    if (host === 'skills.sh' || host.endsWith('.skills.sh')) {
      if (segs.length >= 3) return { ok: true, owner: segs[0], repo: segs[1], ref: '', skills: [segs[2]], source: 'skills.sh' };
      if (segs.length === 2) return { ok: true, owner: segs[0], repo: segs[1], ref: '', skills: [], source: 'skills.sh' };
      return { ok: false, error: 'skills.sh 链接需包含 owner/repo（/skill 名可选）' };
    }
    const g = parseRepoUrl(raw);
    if (g) return { ok: true, owner: g.owner, repo: g.repo, ref: g.ref, skills: [], source: 'github' };
    return { ok: false, error: '暂仅支持 GitHub 仓库 / skills.sh 链接：' + raw };
  }

  // 形态4：简写 owner/repo 或 owner/repo@ref
  const short = raw.match(/^([\w.-]+)\/([\w.-]+?)(?:@([\w./-]+))?$/);
  if (short) return { ok: true, owner: short[1], repo: short[2], ref: short[3] || '', skills: [], source: 'short' };

  return { ok: false, error: '无法识别的安装来源，支持：npx skills add 命令 / skills.sh 链接 / GitHub 仓库地址 / owner/repo' };
}

// 从 GitHub URL 提取 owner/repo/ref（支持 /tree/<ref>、/blob/<ref>/...）
function parseRepoUrl(url) {
  let u;
  try { u = new URL(url); } catch (_) { return null; }
  const host = u.hostname.replace(/^www\./i, '').toLowerCase();
  if (host !== 'github.com' && host !== 'raw.githubusercontent.com') return null;
  const segs = u.pathname.split('/').filter(Boolean);
  if (segs.length < 2) return null;
  const [owner, repo] = segs;
  let ref = '';
  const ti = segs.indexOf('tree');
  const bi = segs.indexOf('blob');
  if (ti >= 0 && segs[ti + 1]) ref = segs.slice(ti + 1).join('/');
  else if (bi >= 0 && segs[bi + 1]) ref = segs.slice(bi + 1).join('/');
  return { owner, repo, ref: ref.split('/').filter(Boolean).join('/') };
}

// ---------- 下载与解压 ----------
function fmtBytes(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + 'KB';
  return n + 'B';
}

// 流式下载并推送进度（⏳ 行由渲染端原地刷新）；无 body 流的环境（测试桩）回退整包读取
async function fetchBuffer(url, send) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: ctrl.signal });
    if (!resp.ok) {
      const e = new Error(`HTTP ${resp.status} ${url}`);
      e.httpStatus = resp.status;
      throw e;
    }
    const total = Number(resp.headers && resp.headers.get && resp.headers.get('content-length')) || 0;
    if (!resp.body || typeof resp.body.getReader !== 'function') {
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > MAX_ZIP_BYTES) throw new Error('源码包过大（>60MB），暂不支持');
      return buf;
    }
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;
    const t0 = Date.now();
    let last = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) chunks.push(Buffer.from(value));
      received += (value && value.length) || 0;
      if (received > MAX_ZIP_BYTES) {
        try { await reader.cancel(); } catch (_) {}
        throw new Error('源码包过大（>60MB），暂不支持');
      }
      const now = Date.now();
      if (send && now - last >= 400) {
        last = now;
        const secs = ((now - t0) / 1000).toFixed(0);
        const pct = total ? ` ${(Math.min(100, (received / total) * 100)).toFixed(0)}%` : '';
        send(`⏳ 下载中 ${fmtBytes(received)}${total ? ' / ' + fmtBytes(total) : ''}${pct}（${secs}s）`);
      }
    }
    if (send) {
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      send(`⏳ 下载完成 ${fmtBytes(received)}（${secs}s）`);
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}

// 下载：404 视为分支不存在（main→master 回退）；瞬时网络错误重试一次，避免吞掉真实错误
async function downloadWithFallback(owner, repo, ref, send) {
  const heads = ref ? [ref] : ['main', 'master'];
  let lastErr = null;
  for (const h of heads) {
    const url = `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${h}`;
    send(`⬇️ 下载源码包：${url}`);
    try {
      return await fetchBuffer(url, send);
    } catch (e) {
      lastErr = e;
      if (e.httpStatus === 404) continue; // 分支不存在，尝试下一个
      send(`⚠️ 下载失败（${e.message}），重试一次…`);
      try { return await fetchBuffer(url, send); } catch (e2) { throw e2; }
    }
  }
  throw lastErr || new Error('下载失败');
}

// 解压 zip：去掉仓库根目录前缀，返回 { relPath: { dir, name, data } }（仅文件）
async function extractZip(buf) {
  const zip = await JSZip.loadAsync(buf);
  const files = [];
  zip.forEach((rel, entry) => { if (!entry.dir) files.push(entry); });
  // 公共根前缀（GitHub 归档形如 repo-branch/...）
  let prefix = '';
  const first = files[0] && files[0].name;
  if (first && first.includes('/')) {
    const cand = first.slice(0, first.indexOf('/') + 1);
    if (files.every((f) => f.name.startsWith(cand))) prefix = cand;
  }
  const out = [];
  for (const f of files) {
    const rel = f.name.slice(prefix.length);
    if (!rel || rel.startsWith('__MACOSX/') || /(^|\/)\.git\//.test(rel)) continue;
    const base = path.posix.basename(rel);
    if (base === '.DS_Store') continue;
    out.push({ rel, entry: f });
  }
  return out;
}

// 在解压结果中查找技能目录：
//   - 指定了 skill 名：匹配 <name>/SKILL.md 或 */<name>/SKILL.md（一层嵌套，如 document-skills/docx/SKILL.md）
//   - 未指定：收集全部含 SKILL.md 的顶层/一层目录
function discoverSkillDirs(entries, wanted) {
  const skillFiles = entries.filter((e) => {
    const base = path.posix.basename(e.rel).toLowerCase();
    return base === 'skill.md';
  });
  const dirs = [];
  const seen = new Set();
  for (const e of skillFiles) {
    const parts = e.rel.split('/');
    if (parts.length < 2) continue; // SKILL.md 不能在仓库根
    const dir = parts.slice(0, parts.length - 1).join('/');
    if (parts.length - 1 > 2) continue; // 最多一层嵌套
    if (seen.has(dir)) continue;
    seen.add(dir);
    dirs.push({ dir, name: parts[parts.length - 2] });
  }
  if (!wanted || !wanted.length) return dirs;
  const picked = [];
  for (const w of wanted) {
    const hit = dirs.find((d) => d.name.toLowerCase() === String(w).toLowerCase() || d.dir.toLowerCase() === String(w).toLowerCase());
    if (hit) picked.push(hit);
  }
  return picked;
}

// 名称冲突时追加 (2)/(3) 后缀
function uniqueName(base, taken) {
  let name = base;
  let i = 2;
  while (taken.has(name)) { name = `${base} (${i++})`; }
  taken.add(name);
  return name;
}

function sanitizeDirName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_').trim() || 'skill';
}

// ---------- 主流程 ----------
// event：主进程 invoke 事件（日志经 skill:install-log 推送）；payload: { input }
// 返回 { ok, installed: [{ name, dir, description }], skipped: [name], source }
async function installSkill(event, payload = {}) {
  const send = (line) => { try { if (event && event.sender) event.sender.send('skill:install-log', { line }); } catch (_) { /* 忽略 */ } };
  try {
    const parsed = parseSkillSource(payload.input);
    if (!parsed.ok) return parsed;
    const { owner, repo, ref, skills } = parsed;
    send(`🔎 解析来源：github.com/${owner}/${repo}${ref ? '@' + ref : ''}${skills.length ? '，技能：' + skills.join(', ') : '（整库）'}`);

    const buf = await downloadWithFallback(owner, repo, ref, send);
    send(`📦 解压中（${(buf.length / 1024 / 1024).toFixed(1)}MB）…`);
    const entries = await extractZip(buf);

    const picked = discoverSkillDirs(entries, skills);
    if (!picked.length) {
      return { ok: false, error: skills.length ? `仓库中未找到技能：${skills.join(', ')}（未匹配到含 SKILL.md 的目录）` : '该仓库未包含任何技能（未找到 SKILL.md）' };
    }
    send(`🧩 发现 ${picked.length} 个技能：${picked.map((p) => p.name).join(', ')}`);

    const root = dataRoot();
    const skillsRoot = path.join(root, 'skills');
    fs.mkdirSync(skillsRoot, { recursive: true });
    const taken = new Set(fs.readdirSync(skillsRoot).filter((n) => { try { return fs.statSync(path.join(skillsRoot, n)).isDirectory(); } catch (_) { return false; } }));

    const installed = [];
    const skipped = [];
    for (const p of picked) {
      const dirFiles = entries.filter((e) => e.rel === p.dir + '/SKILL.md' || e.rel.startsWith(p.dir + '/'));
      const dirName = uniqueName(sanitizeDirName(p.name), taken);
      const target = path.join(skillsRoot, dirName);
      for (const f of dirFiles) {
        const rel = f.rel.slice(p.dir.length + 1);
        if (!rel) continue;
        const dest = path.join(target, rel);
        // 防路径穿越
        if (!dest.startsWith(target + path.sep)) continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, await f.entry.async('nodebuffer'));
      }
      const skillFile = findSkillFile(target);
      if (!skillFile) { skipped.push(p.name); continue; }
      const meta = readSkill(target);
      installed.push({ name: meta.ok ? meta.name : p.name, dir: target, description: meta.ok ? meta.description : '' });
      send(`✅ 已安装：${p.name} → ${target}`);
    }
    if (!installed.length) return { ok: false, error: '安装失败：解压后未找到有效 SKILL.md', skipped };
    return { ok: true, installed, skipped, source: `${owner}/${repo}` };
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? '下载超时（300s），请检查网络或稍后重试' : (e && e.message) || String(e);
    send('❌ ' + msg);
    return { ok: false, error: msg };
  }
}

module.exports = { installSkill, parseSkillSource };
