'use strict';

// ---------------------------------------------------------------------------
// reason/ontologyBundle.js — 体系化导入（bundle import）
//
// 把「手工导入 OGMS 的整套流程」通用化为一个可复用模块：
//   1. 解析主本体（如 ogms.owl）——OBO 发布版通常只含类层级、零谓词；
//      主本体也可能是「聚合入口」（如 LKIF lkif-core.owl：0 类、仅 owl:imports 汇总各模块），
//      此时正文解析不出类，但只要它有 owl:imports 就视为空主本体，由依赖模块提供全部内容；
//   2. 发现事实依赖，两条互补通路：
//      a) OBO 内联引用统计（collectExternalRefs：BFO/RO/OBI…，仅主本体、单级）；
//      b) owl:imports 声明的传递闭包（collectOwlImports：模块化本体如 LKIF 逐层展开）；
//   3. 逐个获取依赖本体：本地 data/ontology/ 已有则复用，缺失则从 purl 自动下载
//      （用户选定策略：自动下载并合并；离线/失败自动回退本地）；
//   4. 把「主本体 + 依赖」合并为**单一** owl: 体系：类取并集（主本体优先）、
//      谓词取并集（RO/BFO 提供关系词汇）、公理/约束去重合并；
//   5. 中英对照沿用源文件已有多语注解，并把 RO/BFO 谓词挂钩内置 RELATION_ALIASES，
//      不臆造翻译（用户选定策略：用源文件已有的多语注解）。
//
// 与单文件导入（reason/owlImport.js）的关系：本模块**复用** owlImport 解析每个文件，
//   只做「依赖发现 + 下载 + 合并 + 完整性回校」，不重复造解析轮子。
//   产物仍是 owl:<id> 体系，落库/删除/列举/护栏/推理全部沿用既有 owlProfiles 机制。
//
// ⚠️ 下载安全：仅允许从 OBO 官方 PURL 主机（purl.obolibrary.org）下载，跟随其重定向；
//    有大小上限与超时；测试可注入 _downloadImpl 桩，保证离线可测（见 test/ontology-bundle.test.js）。
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const owlImport = require('./owlImport');
const { collectExternalRefs, MAX_CLASSES, MAX_PREDICATES, MAX_AXIOMS, MAX_CONSTRAINTS } = owlImport;
const { RELATION_ALIASES } = require('../../common/constants');

const PURL_HOST = 'purl.obolibrary.org';   // 唯一允许的下载主机（OBO 官方 PURL）
const MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 5;

// data/ontology 目录（依赖本体的落地位置），不存在则创建
function ontoDir() {
  const { dataRoot } = require('../../common/paths');
  const dir = path.join(dataRoot(), 'ontology');
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* 只读环境降级：返回路径但不保证存在 */ }
  return dir;
}

// 按依赖前缀在 data/ontology 里找本地文件（大小写/常见扩展名都试一遍）
function resolveLocalDep(prefix) {
  const dir = ontoDir();
  const lower = String(prefix || '').toLowerCase();
  const upper = String(prefix || '').toUpperCase();
  const candidates = [`${lower}.owl`, `${upper}.owl`, `${lower}.ttl`, `${lower}.rdf`, `${lower}.ofn`, `${lower}.omn`];
  for (const c of candidates) {
    const p = path.join(dir, c);
    try { if (fs.existsSync(p) && fs.statSync(p).size > 0) return p; } catch (_) { /* 跳过 */ }
  }
  return null;
}

// 从 import IRI 取末段文件名（去 query/hash）：http://…/lkif-core/norm.owl → norm.owl
function importBasename(iri) {
  let s = String(iri || '').trim();
  s = s.split('#')[0].split('?')[0];
  const i = s.lastIndexOf('/');
  if (i >= 0) s = s.slice(i + 1);
  return s;
}

// 从本体正文抽取 owl:imports 声明的目标 IRI，兼容三种语法（去重）：
//   RDF/XML   <owl:imports rdf:resource="IRI"/>
//   Turtle    <ontIRI> owl:imports <IRI> , <IRI2> ;   （逗号分隔的对象列表，需全部取）
//   Functional Imports(<IRI>)
function collectOwlImports(text) {
  const s = String(text || '');
  const iris = new Set();
  // RDF/XML：owl:imports 同一标签内的 rdf:resource
  for (const m of s.matchAll(/owl:imports[^>]*?rdf:resource\s*=\s*["']([^"']+)["']/g)) if (m[1]) iris.add(m[1].trim());
  // Turtle：owl:imports 后跟随一串 <...>（逗号分隔），直到 ; 或 . 等非 < 字符终止
  for (const m of s.matchAll(/owl:imports\s+((?:<[^>]*>\s*,?\s*)+)/g)) {
    for (const im of m[1].matchAll(/<([^>]*)>/g)) if (im[1]) iris.add(im[1].trim());
  }
  // Functional：Imports(<IRI>)
  for (const m of s.matchAll(/\bImports\s*\(\s*<([^>]+)>/g)) if (m[1]) iris.add(m[1].trim());
  return [...iris];
}

// 按 import IRI 的末段文件名在 data/ontology 里解析本地文件：
//   精确名 → 词干 + 常见扩展名 → 大小写不敏感兜底扫描目录。
function resolveImportLocal(iriOrName) {
  const dir = ontoDir();
  const base = importBasename(iriOrName);
  if (!base) return null;
  const hit = (p) => { try { return fs.existsSync(p) && fs.statSync(p).size > 0 ? p : null; } catch (_) { return null; } };
  const direct = hit(path.join(dir, base));
  if (direct) return direct;
  const stem = base.replace(/\.[A-Za-z0-9]+$/, '');
  for (const ext of ['.owl', '.ttl', '.rdf', '.ofn', '.omn', '.owx', '.xml']) {
    const p = hit(path.join(dir, stem + ext));
    if (p) return p;
  }
  try {
    const lb = base.toLowerCase(); const ls = stem.toLowerCase();
    for (const f of fs.readdirSync(dir)) {
      const fl = f.toLowerCase();
      if (fl === lb || fl.replace(/\.[a-z0-9]+$/, '') === ls) { const p = hit(path.join(dir, f)); if (p) return p; }
    }
  } catch (_) { /* 目录不可读则放弃兜底 */ }
  return null;
}

/**
 * 下载单个文件到 destPath（跟随重定向、限主机/限时/限量）。
 * 测试可传 opts._downloadImpl(url, destPath, opts) 注入桩，避免真实联网。
 * @returns {Promise<{ok:true, path:string, bytes:number}|{ok:false, error:string}>}
 */
function downloadFile(url, destPath, opts = {}) {
  if (typeof opts._downloadImpl === 'function') return Promise.resolve(opts._downloadImpl(url, destPath, opts));
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (_) { return resolve({ ok: false, error: '非法 URL：' + url }); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return resolve({ ok: false, error: '仅支持 http(s)：' + url });
    if (u.hostname !== PURL_HOST) return resolve({ ok: false, error: `出于安全仅允许从 ${PURL_HOST} 下载（实际 ${u.hostname}）` });
    let redirects = 0;
    const doReq = (cur) => {
      let req;
      try {
        const lib = cur.startsWith('https:') ? https : http;
        req = lib.get(cur, { timeout: opts.timeoutMs || DOWNLOAD_TIMEOUT_MS }, (res) => {
          const status = res.statusCode || 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            if (++redirects > MAX_REDIRECTS) return resolve({ ok: false, error: '重定向次数过多' });
            let next;
            try { next = new URL(res.headers.location, cur).toString(); } catch (_) { return resolve({ ok: false, error: '重定向地址非法' }); }
            return doReq(next);
          }
          if (status !== 200) { res.resume(); return resolve({ ok: false, error: `HTTP ${status}` }); }
          let bytes = 0; let oversize = false;
          const ws = fs.createWriteStream(destPath);
          res.on('data', (c) => { bytes += c.length; if (bytes > MAX_DOWNLOAD_BYTES) { oversize = true; try { req.destroy(); } catch (_) {} ws.destroy(); } });
          res.pipe(ws);
          ws.on('finish', () => {
            if (oversize) { try { fs.unlinkSync(destPath); } catch (_) {} return resolve({ ok: false, error: `文件超过 ${MAX_DOWNLOAD_BYTES >> 20}MB 上限` }); }
            resolve({ ok: true, path: destPath, bytes });
          });
          ws.on('error', (e) => resolve({ ok: false, error: '写入失败：' + ((e && e.message) || e) }));
        });
      } catch (e) { return resolve({ ok: false, error: '请求异常：' + ((e && e.message) || e) }); }
      req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve({ ok: false, error: '下载超时' }); });
      req.on('error', (e) => resolve({ ok: false, error: '网络错误：' + ((e && e.message) || e) }));
    };
    doReq(u.toString());
  });
}

/**
 * 发现主本体的事实依赖并逐个获取（本地优先，缺失则按策略下载）。两条互补通路：
 *   A) OBO 内联引用（collectExternalRefs）：仅扫主本体、单级——OBO 发布版（ogms/bfo/ro）
 *      无 owl:imports，靠正文里的 purl.obolibrary.org/obo/<前缀>_ 子串统计（既有行为，不回归）。
 *   B) owl:imports 声明（collectOwlImports）：从主本体出发做**传递闭包**——模块化本体
 *      （如 LKIF：lkif-core → norm/legal-role → action/role/process…）逐层展开，按 IRI 末段
 *      文件名在 data/ontology 本地解析；缺失且允许下载时按其 IRI 下载（仍限白名单主机）。
 * @param {string} mainPath
 * @param {object} [opts] { displayName, download=true, followImports=true, _downloadImpl, timeoutMs }
 * @returns {Promise<Array<{prefix,count,purl,localPath,source,error,via}>>}
 *   source ∈ local|downloaded|missing|failed；via ∈ obo-ref|owl-import
 */
async function discoverDependencies(mainPath, opts = {}) {
  const text = fs.readFileSync(mainPath, 'utf8');
  const displayName = opts.displayName || path.basename(mainPath).replace(/\.[A-Za-z0-9]+$/, '');
  const ownPrefix = String(displayName).toUpperCase();
  const allowDownload = opts.download !== false;
  const followImports = opts.followImports !== false;
  const out = [];
  const rp = (p) => { try { return fs.realpathSync(p); } catch (_) { return p; } };
  const seenLocal = new Set([rp(mainPath)]);   // 已纳入的依赖文件（realpath）；主本体自身不作依赖，兼防环

  // --- A) OBO 内联引用（仅主本体，单级）---
  for (const r of collectExternalRefs(text, ownPrefix)) {
    let localPath = resolveLocalDep(r.prefix);
    let source = localPath ? 'local' : 'missing';
    let error = '';
    if (!localPath && allowDownload) {
      const dest = path.join(ontoDir(), `${String(r.prefix).toLowerCase()}.owl`);
      const res = await downloadFile(r.purl, dest, opts);
      if (res && res.ok) { localPath = res.path; source = 'downloaded'; }
      else { source = 'failed'; error = (res && res.error) || '下载失败'; }
    }
    if (localPath) seenLocal.add(rp(localPath));
    out.push({ prefix: r.prefix, count: r.count, purl: r.purl, localPath: localPath || '', source, error, via: 'obo-ref' });
  }

  // --- B) owl:imports 传递闭包（BFS 逐层展开；只跟 imports，不再对依赖做 OBO 引用统计，避免依赖爆炸）---
  if (followImports) {
    const seenIri = new Set();
    const queue = [text];
    while (queue.length) {
      const cur = queue.shift();
      for (const iri of collectOwlImports(cur)) {
        if (seenIri.has(iri)) continue;
        seenIri.add(iri);
        const base = importBasename(iri);
        const prefix = base.replace(/\.[A-Za-z0-9]+$/, '') || iri;
        let localPath = resolveImportLocal(iri);
        if (localPath && seenLocal.has(rp(localPath))) continue;   // 已纳入或指回主本体/上游模块
        let source = localPath ? 'local' : 'missing';
        let error = '';
        if (!localPath && allowDownload) {
          const dest = path.join(ontoDir(), base || `${prefix}.owl`);
          const res = await downloadFile(iri, dest, opts);
          if (res && res.ok) { localPath = res.path; source = 'downloaded'; }
          else { source = 'failed'; error = (res && res.error) || '下载失败'; }
        }
        out.push({ prefix, count: 1, purl: iri, localPath: localPath || '', source, error, via: 'owl-import' });
        if (localPath) {
          seenLocal.add(rp(localPath));
          try { queue.push(fs.readFileSync(localPath, 'utf8')); } catch (_) { /* 读不了就不继续展开 */ }
        }
      }
    }
  }

  return out;
}

// 薄封装：解析单个 OWL 为 profile（不落库）；失败不抛，返回 {ok:false}。
// deferIntegrity:true——单文件解析时保留跨文件的 parent/domain/range 与悬挂公理，
// 等 mergeProfiles 合并出完整类集后由 enforceIntegrity 统一回校（否则 RO 谓词指向 BFO 类的
// domain/range 会在单独解析 RO 时被误清）。
async function parseToProfile(filePath, opts = {}) {
  try {
    const res = await owlImport.importOwlExtended(filePath, { ...opts, previewOnly: true, deferIntegrity: true });
    return { ok: true, profile: res.profile, report: res.report, preview: res.preview, via: res.via, filePath };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), filePath };
  }
}

// 合并后回校引用完整性（孤儿父类→根、domain/range 指向被删类→清空、公理悬挂引用→丢弃）
function enforceIntegrity(classes, predicates, axioms, stats) {
  const classKeys = new Set(classes.map((c) => c.key));
  let orphans = 0;
  for (const c of classes) if (c.parent && !classKeys.has(c.parent)) { c.parent = ''; orphans++; }
  let cleared = 0;
  for (const p of predicates) {
    if (p.domain && !classKeys.has(p.domain)) { p.domain = ''; cleared++; }
    if (p.range && !classKeys.has(p.range)) { p.range = ''; cleared++; }
  }
  const valid = new Set([...classKeys, ...predicates.map((p) => p.key)]);
  const kept = axioms.filter((a) => valid.has(a.subject) && (a.object === undefined || valid.has(a.object)));
  stats.orphanClasses = orphans;
  stats.clearedRefs = cleared;
  stats.droppedAxioms = axioms.length - kept.length;
  axioms.length = 0;
  for (const a of kept) axioms.push(a);
}

// 主本体类超上限时的截断（保留根类 + 一级子类，与 owlImport 同策略）
function truncateByRoots(classes) {
  const roots = classes.filter((c) => !c.parent);
  const rootKeys = new Set(roots.map((c) => c.key));
  const firstLevel = classes.filter((c) => c.parent && rootKeys.has(c.parent));
  const keep = new Set([...roots, ...firstLevel].map((c) => c.key));
  return classes.filter((c) => keep.has(c.key)).slice(0, MAX_CLASSES);
}

/**
 * 把主本体与依赖本体的解析结果合并为**单一** profile。
 * 主本体优先：类/谓词同 key 冲突时保留主本体版本；依赖只补主本体没有的。
 * @param {{ok:boolean, profile:object}} mainParsed
 * @param {Array<{ok:boolean, profile:object, prefix?:string}>} depParseds
 * @param {object} [opts] { displayName, baseName, id, mainName }
 * @returns {{profile:object, report:object}}
 */
function mergeProfiles(mainParsed, depParseds, opts = {}) {
  const mainProfile = (mainParsed && mainParsed.profile) || {};
  const classes = []; const classKeys = new Set();
  const predicates = []; const predKeys = new Set();
  const axioms = []; const axSeen = new Set();
  const constraints = []; const conSeen = new Set();

  const addClasses = (list) => { for (const c of (list || [])) { if (!c || !c.key || classKeys.has(c.key)) continue; classKeys.add(c.key); classes.push({ ...c }); } };
  const addPreds = (list) => { for (const p of (list || [])) { if (!p || !p.key || predKeys.has(p.key)) continue; predKeys.add(p.key); predicates.push({ ...p }); } };
  const addAxs = (list) => { for (const a of (list || [])) { if (!a || !a.type || !a.subject) continue; const sig = `${a.type}|${a.subject}|${a.object === undefined ? '' : a.object}`; if (axSeen.has(sig)) continue; axSeen.add(sig); axioms.push({ ...a }); } };
  const addCons = (list) => { for (const c of (list || [])) { const d = typeof c === 'string' ? c : (c && c.desc) || ''; if (!d || conSeen.has(d)) continue; conSeen.add(d); constraints.push({ desc: d }); } };

  // 主本体先入（享有 key 冲突优先权）
  addClasses(mainProfile.classes); addPreds(mainProfile.predicates); addAxs(mainProfile.axioms); addCons(mainProfile.constraints);
  const mainClassCount = classes.length;
  const mainPredCount = predicates.length;
  const sources = [{ name: mainProfile.name || opts.mainName || 'main', role: 'main', classes: mainClassCount, predicates: mainPredCount }];

  // 依赖补齐
  for (const d of (depParseds || [])) {
    if (!d || !d.ok || !d.profile) continue;
    const bc = classes.length, bp = predicates.length;
    addClasses(d.profile.classes); addPreds(d.profile.predicates); addAxs(d.profile.axioms); addCons(d.profile.constraints);
    sources.push({ name: d.profile.name || d.prefix || 'dep', role: 'dep', classes: classes.length - bc, predicates: predicates.length - bp });
  }

  // 类截断（主本体优先保留）
  const originalClassCount = classes.length;
  let truncated = false;
  if (classes.length > MAX_CLASSES) {
    truncated = true;
    const kept = mainClassCount >= MAX_CLASSES
      ? truncateByRoots(classes.slice(0, mainClassCount))
      : classes.slice(0, MAX_CLASSES);   // 主本体已排在最前，直接截取即优先保留主类
    classes.length = 0; for (const c of kept) classes.push(c);
  }
  const predicatesTruncated = predicates.length > MAX_PREDICATES;
  if (predicatesTruncated) predicates.length = MAX_PREDICATES;
  if (axioms.length > MAX_AXIOMS) axioms.length = MAX_AXIOMS;
  if (constraints.length > MAX_CONSTRAINTS) constraints.length = MAX_CONSTRAINTS;

  // 中英对照：把 RO/BFO 谓词挂钩内置别名表（依赖若走 owl.js 降级则未挂过），并保留源文件中文 label
  for (const p of predicates) {
    const set = new Set(Array.isArray(p.aliases) ? p.aliases : []);
    if (p.label && /[\u4e00-\u9fa5]/.test(p.label) && p.label !== p.key) set.add(p.label);
    for (const a of (RELATION_ALIASES[p.key] || [])) if (a && a !== p.key) set.add(a);
    if (set.size) p.aliases = [...set];
  }

  const stats = {};
  enforceIntegrity(classes, predicates, axioms, stats);

  // 兜底类型/谓词 + 提取模式
  const roots = classes.filter((c) => !c.parent);
  const rootHit = roots.find((c) => /entity|thing|object|实体|事物|物体/i.test(`${c.label} ${c.key}`));
  const fallbackType = (rootHit && rootHit.key) || (roots[0] && roots[0].key) || (classes[0] && classes[0].key) || 'thing';
  const unconstrained = predicates.find((p) => !p.domain && !p.range);
  const fallbackRel = (unconstrained && unconstrained.key) || (predicates[0] && predicates[0].key) || '相关';

  const baseName = opts.baseName || String(mainProfile.sourceFile || mainProfile.name || 'bundle').replace(/\.[A-Za-z0-9]+$/, '');
  const profile = {
    id: opts.id || ('owl:' + baseName.replace(/[^\w\u4e00-\u9fa5.-]/g, '_')),
    name: opts.displayName || mainProfile.name || baseName,
    desc: `体系化导入：${sources.length} 个本体合并 · ${classes.length}类/${predicates.length}谓词/${axioms.length}公理`,
    classes, predicates, axioms, constraints,
    fallbackType, fallbackRel,
    promptMode: classes.length <= 12 ? 'flat' : 'two-stage',
    owl: true, bundle: true,
    sources,
    sourceFile: mainProfile.sourceFile || baseName,
    parser: (mainParsed && mainParsed.via) || 'protege-js',
    ontologyIri: mainProfile.ontologyIri || '',
  };
  const report = {
    classCount: classes.length,
    predicateCount: predicates.length,
    axiomCount: axioms.length,
    constraintCount: constraints.length,
    individualCount: 0,
    format: 'OWL bundle',
    formatId: 'bundle',
    parser: profile.parser,
    sourceFile: profile.sourceFile,
    truncated,
    originalClassCount,
    predicatesTruncated,
    orphanClasses: stats.orphanClasses || 0,
    droppedAxioms: stats.droppedAxioms || 0,
    clearedRefs: stats.clearedRefs || 0,
    mergedSources: sources.length,
    ontologyIri: profile.ontologyIri,
  };
  return { profile, report };
}

// 体系化导入的预览数据（供渲染层向导弹窗；不复用单文件 buildPreview，字段口径不同）
function buildBundlePreview(profile, report, dependencies) {
  const notes = []; const warnings = [];
  const deps = Array.isArray(dependencies) ? dependencies : [];
  const usedDeps = deps.filter((d) => d.source === 'local' || d.source === 'downloaded');
  const missingDeps = deps.filter((d) => d.source === 'missing' || d.source === 'failed');
  if (!deps.length) notes.push('主本体既无 OBO 内联引用、也无 owl:imports 声明，将作为单文件体系导入（与「导入 OWL」等效）。');
  if (usedDeps.length) notes.push(`已合并依赖本体：${usedDeps.map((d) => `${d.prefix}（${d.source === 'downloaded' ? '已下载' : '本地'}${d.via === 'owl-import' ? '，owl:imports' : `，引用×${d.count}`}）`).join('、')}。`);
  if (missingDeps.length) warnings.push(`以下依赖未能获取、其类/谓词未并入：${missingDeps.map((d) => `${d.prefix}（${d.error || d.source}）`).join('、')}——可手动下载放入 data/ontology 后重试。`);
  if (report.truncated) warnings.push(`合并后类数 ${report.originalClassCount} 超上限 ${MAX_CLASSES}，已优先保留主本体类、截断至 ${report.classCount} 个。`);
  if (report.predicatesTruncated) warnings.push(`合并后谓词超上限 ${MAX_PREDICATES}，已截断至 ${report.predicateCount} 个。`);
  if (!profile.predicates.length && profile.classes.length) warnings.push('合并后仍无谓词：主本体与依赖均未声明对象/数据属性（可另导入 RO 等关系本体）。');
  if (report.orphanClasses) notes.push(`${report.orphanClasses} 个类的父类不在合并范围内，已置为根类。`);
  if (report.droppedAxioms) notes.push(`${report.droppedAxioms} 条公理因引用被截断的实体而丢弃。`);
  if (report.clearedRefs) notes.push(`${report.clearedRefs} 处 domain/range 指向被截断的类，已清空以免护栏误拦。`);
  const zhClasses = profile.classes.filter((c) => /[\u4e00-\u9fa5]/.test(c.label || '')).length;
  const zhPreds = profile.predicates.filter((p) => /[\u4e00-\u9fa5]/.test(p.label || '')).length;
  notes.push(`中英对照：类 ${zhClasses}/${profile.classes.length}、谓词 ${zhPreds}/${profile.predicates.length} 带中文 label，其余按源文件为英文本地名（未臆造翻译）。`);
  const roots = profile.classes.filter((c) => !c.parent);
  return {
    kind: 'bundle',
    fileName: report.sourceFile || '',
    ontologyIri: report.ontologyIri || '',
    parser: report.parser || 'protege-js',
    profileId: profile.id,
    profileName: profile.name,
    counts: {
      classes: profile.classes.length,
      predicates: profile.predicates.length,
      axioms: profile.axioms.length,
      constraints: profile.constraints.length,
      roots: roots.length,
      sources: report.mergedSources || 1,
    },
    dependencies: deps.map((d) => ({ prefix: d.prefix, count: d.count, source: d.source, purl: d.purl, error: d.error || '', via: d.via || 'obo-ref' })),
    sources: profile.sources || [],
    rootClasses: roots.slice(0, 12).map((c) => ({ key: c.key, label: c.label })),
    sampleClasses: profile.classes.slice(0, 12).map((c) => ({ key: c.key, label: c.label, parent: c.parent, desc: c.desc })),
    samplePredicates: profile.predicates.slice(0, 12).map((p) => ({ key: p.key, label: p.label, domain: p.domain, range: p.range, features: p.features || [] })),
    fallbackType: profile.fallbackType,
    fallbackRel: profile.fallbackRel,
    promptMode: profile.promptMode,
    warnings,
    notes,
  };
}

/**
 * 体系化导入主入口：解析主本体 → 发现/获取依赖 → 合并为单一体系（不落库，落库由 graph.js 负责）。
 * @param {object} payload
 * @param {string} payload.mainPath           主本体文件路径（必填）
 * @param {string} [payload.displayName]      体系显示名（默认取文件名）
 * @param {string} [payload.id]               体系 id（默认 owl:<basename>）
 * @param {boolean}[payload.download=true]    缺失依赖是否自动下载
 * @param {boolean}[payload.discover=true]    是否自动推断依赖（false 时仅用 payload.deps）
 * @param {boolean}[payload.followImports=true] 是否沿 owl:imports 做传递闭包发现（模块化本体如 LKIF）
 * @param {Array<{prefix?,path?,purl?}>} [payload.deps]  显式指定依赖文件（跳过自动推断）
 * @param {object} [opts] { forceLegacy, _downloadImpl, timeoutMs }
 * @returns {Promise<{profile,report,preview,dependencies,via,mainPath,depPaths}>}
 */
async function importBundle(payload = {}, opts = {}) {
  const mainPath = payload.mainPath || payload.filePath;
  if (!mainPath) throw new Error('未指定主本体文件');
  if (!fs.existsSync(mainPath)) throw new Error('主本体文件不存在：' + mainPath);
  const displayName = payload.displayName || payload.mainName || path.basename(mainPath).replace(/\.[A-Za-z0-9]+$/, '');
  let mainParsed = await parseToProfile(mainPath, { displayName, forceLegacy: opts.forceLegacy });
  if (!mainParsed.ok) {
    // 主本体可能是「聚合入口」（如 LKIF lkif-core.owl：0 类、仅 owl:imports 汇总各模块），
    // 正文解析不出类会报错。若它确有 owl:imports，则视为空主本体继续，由依赖模块提供全部内容；否则才判失败。
    let rawText = '';
    try { rawText = fs.readFileSync(mainPath, 'utf8'); } catch (_) { rawText = ''; }
    if (collectOwlImports(rawText).length) {
      mainParsed = {
        ok: true,
        profile: { name: displayName, sourceFile: path.basename(mainPath), classes: [], predicates: [], axioms: [], constraints: [] },
        report: {}, via: 'empty-aggregator', filePath: mainPath,
      };
    } else {
      throw new Error('主本体解析失败：' + mainParsed.error);
    }
  }

  let dependencies = [];
  if (Array.isArray(payload.deps) && payload.deps.length) {
    dependencies = payload.deps.map((d) => {
      const p = d.path || d.localPath || '';
      const present = p && fs.existsSync(p);
      return { prefix: d.prefix || (p ? path.basename(p).replace(/\.[A-Za-z0-9]+$/, '') : 'dep'), count: d.count || 0, purl: d.purl || '', localPath: present ? p : '', source: present ? 'local' : 'missing', error: present ? '' : '文件不存在', via: d.via || 'explicit' };
    });
  } else if (payload.discover !== false) {
    dependencies = await discoverDependencies(mainPath, {
      displayName,
      download: payload.download !== false,
      followImports: payload.followImports !== false,
      _downloadImpl: opts._downloadImpl,
      timeoutMs: opts.timeoutMs,
    });
  }

  const depParseds = [];
  for (const d of dependencies) {
    if (!d.localPath || (d.source !== 'local' && d.source !== 'downloaded')) continue;
    const parsed = await parseToProfile(d.localPath, { displayName: d.prefix, forceLegacy: opts.forceLegacy });
    parsed.prefix = d.prefix; parsed.depSource = d.source;
    depParseds.push(parsed);
  }

  const baseName = String(displayName).replace(/\.[A-Za-z0-9]+$/, '');
  const merged = mergeProfiles(mainParsed, depParseds, { displayName, baseName, id: payload.id, mainName: displayName });
  const preview = buildBundlePreview(merged.profile, merged.report, dependencies);
  return {
    profile: merged.profile,
    report: merged.report,
    preview,
    dependencies,
    via: mainParsed.via || 'protege-js',
    mainPath,
    depPaths: depParseds.map((d) => d.filePath).filter(Boolean),
  };
}

module.exports = {
  PURL_HOST,
  ontoDir,
  resolveLocalDep,
  importBasename,
  collectOwlImports,
  resolveImportLocal,
  downloadFile,
  discoverDependencies,
  parseToProfile,
  mergeProfiles,
  buildBundlePreview,
  importBundle,
};
