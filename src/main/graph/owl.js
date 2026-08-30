// OWL 2 本体导入解析器（纯 Node 实现，无外部依赖）
// 支持 RDF/XML 与 Turtle 两种序列化，输出标准化 TopOntologyProfile
// 解析深度：仅直接定义，不做本体推理/闭包展开；超大本体（类>200）截断保留前两层

const fs = require('fs');
const path = require('path');

// ---------- 工具 ----------
function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\.(owl|rdf|ttl|xml)$/i, '')
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'custom';
}

function localName(uri) {
  if (!uri) return '';
  const s = String(uri);
  const hash = s.lastIndexOf('#');
  const slash = s.lastIndexOf('/');
  const idx = Math.max(hash, slash);
  return idx >= 0 ? s.slice(idx + 1) : s;
}

function stripNs(tag) {
  return String(tag || '').replace(/^[a-zA-Z0-9_-]+:/, '');
}

// ---------- Turtle 解析 ----------
// 轻量行解析：按 ";" / "." 分句，提取 Class / ObjectProperty / subClassOf / label / comment / domain / range
function parseTurtle(text) {
  const classes = new Map(); // key -> {key,label,parent,desc,code}
  const predicates = new Map(); // key -> {key,label,domain,range,features,desc}
  const constraints = [];
  const prefixes = {};

  // 收集 @prefix
  for (const m of text.matchAll(/@prefix\s+([a-zA-Z0-9_-]+):\s*<([^>]+)>/g)) {
    prefixes[m[1]] = m[2];
  }

  function resolveUri(token) {
    token = token.trim().replace(/^<|>$/g, '');
    if (token.includes('://')) return token; // full URI
    const m = token.match(/^([a-zA-Z0-9_-]+):(.+)$/);
    if (m && prefixes[m[1]]) return prefixes[m[1]] + m[2];
    return token;
  }

  // 按 "." 分句（Turtle 语句终止符，注意 . 也可能在 URI 中，宽松处理）
  const stmts = text.split(/\.\s*(?=\n|$)/);
  for (const stmt of stmts) {
    const s = stmt.trim();
    if (!s || s.startsWith('@prefix') || s.startsWith('@base')) continue;

    // 提取主语（第一个 token）
    const subjMatch = s.match(/^(<[^>]+>|[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+|[a-zA-Z0-9_-]+)/);
    if (!subjMatch) continue;
    const subj = resolveUri(subjMatch[1]);
    const subjKey = localName(subj);
    if (!subjKey) continue;

    // owl:Class
    if (/a\s+owl:Class/.test(s) || /rdf:type\s+owl:Class/.test(s)) {
      if (!classes.has(subjKey)) classes.set(subjKey, { key: subjKey, label: subjKey, parent: '', desc: '', code: subj });
      const c = classes.get(subjKey);
      // label
      const lbl = s.match(/rdfs:label\s+"([^"]+)"/) || s.match(/skos:prefLabel\s+"([^"]+)"/);
      if (lbl) c.label = lbl[1];
      // comment
      const cmt = s.match(/rdfs:comment\s+"([^"]+)"/);
      if (cmt) c.desc = cmt[1];
      // subClassOf
      const sub = s.match(/rdfs:subClassOf\s+(<[^>]+>|[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+)/);
      if (sub) c.parent = localName(resolveUri(sub[1]));
      // deprecated
      if (/owl:deprecated\s+true/.test(s)) classes.delete(subjKey);
    }

    // owl:ObjectProperty
    if (/a\s+owl:ObjectProperty/.test(s) || /rdf:type\s+owl:ObjectProperty/.test(s)) {
      if (!predicates.has(subjKey)) predicates.set(subjKey, { key: subjKey, label: subjKey, domain: '', range: '', features: [], desc: '', code: subj });
      const p = predicates.get(subjKey);
      const lbl = s.match(/rdfs:label\s+"([^"]+)"/);
      if (lbl) p.label = lbl[1];
      const cmt = s.match(/rdfs:comment\s+"([^"]+)"/);
      if (cmt) p.desc = cmt[1];
      const dom = s.match(/rdfs:domain\s+(<[^>]+>|[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+)/);
      if (dom) p.domain = localName(resolveUri(dom[1]));
      const rng = s.match(/rdfs:range\s+(<[^>]+>|[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+)/);
      if (rng) p.range = localName(resolveUri(rng[1]));
      if (/a\s+owl:TransitiveProperty/.test(s)) p.features.push('transitive');
      if (/a\s+owl:SymmetricProperty/.test(s)) p.features.push('symmetric');
      if (/a\s+owl:FunctionalProperty/.test(s)) p.features.push('functional');
      if (/a\s+owl:InverseFunctionalProperty/.test(s)) p.features.push('inverseFunctional');
    }

    // owl:Restriction → constraints（仅记录文本说明）
    if (/a\s+owl:Restriction/.test(s)) {
      const onProp = s.match(/owl:onProperty\s+(<[^>]+>|[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+)/);
      const card = s.match(/owl:(?:minC|c)?ardinality\s+"?(\d+)"?/);
      const hasVal = s.match(/owl:hasValue\s+(<[^>]+>|[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+|"[^"]+")/);
      const some = s.match(/owl:someValuesFrom\s+(<[^>]+>|[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+)/);
      if (onProp) {
        const propKey = localName(resolveUri(onProp[1]));
        let desc = `${propKey} 约束`;
        if (card) desc += `，基数=${card[1]}`;
        if (hasVal) desc += `，值=${hasVal[1]}`;
        if (some) desc += `，取值范围=${localName(resolveUri(some[1]))}`;
        constraints.push(desc);
      }
    }
  }

  return { classes: [...classes.values()], predicates: [...predicates.values()], constraints };
}

// ---------- RDF/XML 解析 ----------
// 用正则提取 owl:Class / owl:ObjectProperty 块（宽松解析，非完整 XML parser）
function parseRdfXml(text) {
  const classes = new Map();
  const predicates = new Map();
  const constraints = [];

  // 提取 <owl:Class rdf:about="...">...</owl:Class> 或 <owl:Class rdf:ID="...">
  const classRe = /<owl:Class[^>]*?(?:rdf:about|rdf:ID)=["']([^"']+)["'][^>]*?>([\s\S]*?)<\/owl:Class>/g;
  for (const m of text.matchAll(classRe)) {
    const uri = m[1];
    const body = m[2];
    const key = localName(uri);
    if (!key) continue;
    const c = { key, label: key, parent: '', desc: '', code: uri };
    const lbl = body.match(/<rdfs:label[^>]*>([^<]+)<\/rdfs:label>/) || body.match(/<skos:prefLabel[^>]*>([^<]+)<\/skos:prefLabel>/);
    if (lbl) c.label = lbl[1].trim();
    const cmt = body.match(/<rdfs:comment[^>]*>([^<]+)<\/rdfs:comment>/);
    if (cmt) c.desc = cmt[1].trim();
    const sub = body.match(/<rdfs:subClassOf\s+rdf:resource=["']([^"']+)["']/);
    if (sub) c.parent = localName(sub[1]);
    if (!/<owl:deprecated[^>]*>true<\/owl:deprecated>/.test(body)) classes.set(key, c);
  }
  // 自闭合 <owl:Class rdf:about="..." />
  const classSelfRe = /<owl:Class\s+(?:rdf:about|rdf:ID)=["']([^"']+)["']\s*\/>/g;
  for (const m of text.matchAll(classSelfRe)) {
    const key = localName(m[1]);
    if (key && !classes.has(key)) classes.set(key, { key, label: key, parent: '', desc: '', code: m[1] });
  }

  // owl:ObjectProperty
  const propRe = /<owl:ObjectProperty[^>]*?(?:rdf:about|rdf:ID)=["']([^"']+)["'][^>]*?>([\s\S]*?)<\/owl:ObjectProperty>/g;
  for (const m of text.matchAll(propRe)) {
    const uri = m[1];
    const body = m[2];
    const key = localName(uri);
    if (!key) continue;
    const p = { key, label: key, domain: '', range: '', features: [], desc: '', code: uri };
    const lbl = body.match(/<rdfs:label[^>]*>([^<]+)<\/rdfs:label>/);
    if (lbl) p.label = lbl[1].trim();
    const cmt = body.match(/<rdfs:comment[^>]*>([^<]+)<\/rdfs:comment>/);
    if (cmt) p.desc = cmt[1].trim();
    const dom = body.match(/<rdfs:domain\s+rdf:resource=["']([^"']+)["']/);
    if (dom) p.domain = localName(dom[1]);
    const rng = body.match(/<rdfs:range\s+rdf:resource=["']([^"']+)["']/);
    if (rng) p.range = localName(rng[1]);
    if (/<rdf:type\s+rdf:resource=["'][^"']*TransitiveProperty["']/.test(body)) p.features.push('transitive');
    if (/<rdf:type\s+rdf:resource=["'][^"']*SymmetricProperty["']/.test(body)) p.features.push('symmetric');
    if (/<rdf:type\s+rdf:resource=["'][^"']*FunctionalProperty["']/.test(body)) p.features.push('functional');
    if (/<rdf:type\s+rdf:resource=["'][^"']*InverseFunctionalProperty["']/.test(body)) p.features.push('inverseFunctional');
    predicates.set(key, p);
  }

  // owl:Restriction
  const restRe = /<owl:Restriction[^>]*?>([\s\S]*?)<\/owl:Restriction>/g;
  for (const m of text.matchAll(restRe)) {
    const body = m[1];
    const onProp = body.match(/<owl:onProperty\s+rdf:resource=["']([^"']+)["']/);
    const card = body.match(/<owl:(?:minC|c)?ardinality[^>]*>(\d+)</);
    const hasVal = body.match(/<owl:hasValue\s+rdf:resource=["']([^"']+)["']/);
    if (onProp) {
      const propKey = localName(onProp[1]);
      let desc = `${propKey} 约束`;
      if (card) desc += `，基数=${card[1]}`;
      if (hasVal) desc += `，值=${localName(hasVal[1])}`;
      constraints.push(desc);
    }
  }

  return { classes: [...classes.values()], predicates: [...predicates.values()], constraints };
}

// ---------- 主入口 ----------
// 解析 OWL 文件 → TopOntologyProfile（不持久化，由 graph.js 存 kv）
function parseOwlFile(filePath, opts) {
  opts = opts || {};
  const raw = fs.readFileSync(filePath, 'utf8');
  // displayName：web 上传时服务端文件带时间戳前缀，用原始文件名作为体系名/ID
  const fileName = opts.displayName ? path.basename(opts.displayName) : path.basename(filePath);
  const baseName = slugify(fileName);

  // 判定序列化格式
  const isTurtle = /@prefix|@base|^\s*[a-zA-Z0-9_-]+:/m.test(raw) && !raw.includes('<?xml') && !raw.includes('<rdf:RDF');
  const isRdfXml = raw.includes('<?xml') || raw.includes('<rdf:RDF');

  let parsed;
  if (isTurtle) {
    parsed = parseTurtle(raw);
  } else if (isRdfXml) {
    parsed = parseRdfXml(raw);
  } else {
    // 无法判定：先试 Turtle，再试 RDF/XML
    parsed = parseTurtle(raw);
    if (!parsed.classes.length && !parsed.predicates.length) parsed = parseRdfXml(raw);
  }

  const { classes, predicates, constraints } = parsed;
  const report = {
    classCount: classes.length,
    predicateCount: predicates.length,
    constraintCount: constraints.length,
    format: isTurtle ? 'Turtle' : isRdfXml ? 'RDF/XML' : 'auto',
    truncated: false,
    orphanClasses: [],
  };

  // 超大本体截断（类>200 保留前两层）
  let finalClasses = classes;
  if (classes.length > 200) {
    report.truncated = true;
    report.originalClassCount = classes.length;
    // 保留根类 + 第一层子类
    const roots = classes.filter((c) => !c.parent);
    const rootKeys = new Set(roots.map((r) => r.key));
    const firstLevel = classes.filter((c) => c.parent && rootKeys.has(c.parent));
    finalClasses = [...roots, ...firstLevel].slice(0, 200);
    report.classCount = finalClasses.length;
  }

  // 孤儿类检测（有 parent 但 parent 不在类表中）
  const classKeys = new Set(finalClasses.map((c) => c.key));
  for (const c of finalClasses) {
    if (c.parent && !classKeys.has(c.parent)) report.orphanClasses.push(`${c.key} (parent: ${c.parent})`);
  }

  // promptMode 按类数自动判定
  const promptMode = finalClasses.length <= 12 ? 'flat' : 'two-stage';
  // fallbackType：根类中 label 最通用者（含"entity/thing/object/实体/事物"），否则首个根类
  const roots = finalClasses.filter((c) => !c.parent);
  let fallbackType = roots.length ? roots[0].key : (finalClasses[0] ? finalClasses[0].key : 'thing');
  for (const r of roots) {
    if (/entity|thing|object|实体|事物|物体/i.test(r.label + r.key)) { fallbackType = r.key; break; }
  }
  // fallbackRel：首个谓词
  const fallbackRel = predicates.length ? predicates[0].key : '相关';

  const profile = {
    id: 'owl:' + baseName,
    name: fileName.replace(/\.(owl|rdf|ttl|xml)$/i, ''),
    desc: `自定义 OWL 导入：${fileName} · ${report.classCount}类/${report.predicateCount}谓词 · ${report.format}`,
    classes: finalClasses.map((c) => ({ key: c.key, label: c.label || c.key, code: c.code || '', parent: c.parent || '', desc: c.desc || '', examples: [] })),
    predicates: predicates.map((p) => ({ key: p.key, label: p.label || p.key, code: p.code || '', domain: p.domain || '', range: p.range || '', features: p.features || [], desc: p.desc || '' })),
    constraints: constraints.map((c) => ({ desc: c })),
    fallbackType,
    fallbackRel,
    promptMode,
    owl: true,
    sourceFile: fileName,
  };

  return { profile, report };
}

module.exports = { parseOwlFile, slugify };
