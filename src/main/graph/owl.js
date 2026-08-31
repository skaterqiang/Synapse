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
// 宽松正则解析（非完整 XML parser），兼容两种序列化：
//  1) 简写式：<owl:Class rdf:about="…">…</owl:Class> / 自闭合
//  2) Description 式：<rdf:Description rdf:about="…"><rdf:type rdf:resource="…#Class"/>…</rdf:Description>
//     （Protégé / rdflib 等工具的常见导出格式，含 xml:lang 多语言标签与 nodeID 匿名节点）
function xmlUnescape(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
// 多语言标签取值：zh 优先 → 无 xml:lang → 任一；rdfs:label 与 skos:prefLabel 等价
function pickLabel(body) {
  const re = /<(?:rdfs:label|skos:prefLabel)([^>]*)>([^<]*)<\/(?:rdfs:label|skos:prefLabel)>/g;
  let any = '';
  let noLang = '';
  let zh = '';
  for (const m of body.matchAll(re)) {
    const text = xmlUnescape(m[2]).trim();
    if (!text) continue;
    if (!any) any = text;
    const lang = ((m[1] || '').match(/xml:lang=["']([^"']+)["']/) || [])[1] || '';
    if (!lang && !noLang) noLang = text;
    if (/^zh/i.test(lang) && !zh) zh = text;
  }
  return zh || noLang || any;
}
function pickComment(body) {
  const m = body.match(/<rdfs:comment[^>]*>([^<]*)<\/rdfs:comment>/);
  return m ? xmlUnescape(m[1]).trim() : '';
}
function typeResources(body) {
  return [...body.matchAll(/<rdf:type\s+rdf:resource=["']([^"']+)["']/g)].map((m) => m[1]);
}
function resourceOf(body, tag) {
  const m = body.match(new RegExp('<' + tag + '\\s+rdf:resource=["\']([^"\']+)["\']'));
  return m ? m[1] : '';
}
function parseRdfXml(text) {
  const classes = new Map();
  const predicates = new Map();
  const constraints = [];

  // 块提取：命名块（含自闭合）统一捕获；嵌套同名 Description 罕见，宽松截断可接受
  const blockRe = /<(owl:Class|owl:ObjectProperty|rdf:Description)\b([^>]*?)>([\s\S]*?)<\/\1>|<(owl:Class|owl:ObjectProperty|rdf:Description)\b([^>]*?)\/>/g;
  for (const m of text.matchAll(blockRe)) {
    const tag = m[1] || m[4];
    const attrs = m[1] ? m[2] : m[5];
    const body = m[1] ? m[3] : '';
    const about = ((attrs || '').match(/(?:rdf:about|rdf:ID)=["']([^"']+)["']/) || [])[1] || '';
    const types = tag === 'owl:Class' ? ['x#Class'] : tag === 'owl:ObjectProperty' ? ['x#ObjectProperty'] : typeResources(body);
    const isClass = types.some((t) => /[#/]Class$/.test(t));
    const isProp = types.some((t) => /#ObjectProperty$/.test(t));
    const isRestr = types.some((t) => /#Restriction$/.test(t));
    const isIndividual = types.some((t) => /#NamedIndividual$/.test(t));

    // 匿名约束节点（rdf:nodeID）：收集 constraint 说明
    if (isRestr) {
      const onProp = resourceOf(body, 'owl:onProperty');
      const card = (body.match(/<owl:(?:minCardinality|maxCardinality|cardinality)[^>]*>(\d+)</) || [])[1];
      const hasValRes = resourceOf(body, 'owl:hasValue');
      const hasValLit = (body.match(/<owl:hasValue[^>]*>([^<]+)</) || [])[1];
      const some = resourceOf(body, 'owl:someValuesFrom');
      if (onProp) {
        let desc = `${localName(onProp)} 约束`;
        if (card) desc += `，基数=${card}`;
        if (hasValRes || hasValLit) desc += `，值=${localName(hasValRes || hasValLit)}`;
        if (some) desc += `，取值范围=${localName(some)}`;
        constraints.push(desc);
      }
      continue;
    }
    if (!about) continue; // 其余匿名节点（Datatype/列表 nodeID 等）跳过
    const key = localName(about);
    if (!key) continue;

    // 实例（NamedIndividual）：不计入类表，但其 rdf:type 补全类集合（部分本体仅经实例声明类）
    if (isIndividual && !isClass && !isProp) {
      for (const t of types) {
        if (/#(NamedIndividual|Thing)$/.test(t)) continue;
        const ck = localName(t);
        if (ck && !classes.has(ck)) classes.set(ck, { key: ck, label: ck, parent: '', desc: '', code: t });
      }
      continue;
    }

    if (isClass) {
      if (/<owl:deprecated[^>]*>\s*true\s*<\/owl:deprecated>/.test(body)) continue;
      if (!classes.has(key)) classes.set(key, { key, label: key, parent: '', desc: '', code: about });
      const c = classes.get(key);
      const lbl = pickLabel(body);
      if (lbl) c.label = lbl;
      const cmt = pickComment(body);
      if (cmt) c.desc = cmt;
      const sub = resourceOf(body, 'rdfs:subClassOf');
      if (sub) c.parent = localName(sub);
      continue;
    }

    if (isProp) {
      if (!predicates.has(key)) predicates.set(key, { key, label: key, domain: '', range: '', features: [], desc: '', code: about });
      const p = predicates.get(key);
      const lbl = pickLabel(body);
      if (lbl) p.label = lbl;
      const cmt = pickComment(body);
      if (cmt) p.desc = cmt;
      const dom = resourceOf(body, 'rdfs:domain');
      if (dom) p.domain = localName(dom);
      const rng = resourceOf(body, 'rdfs:range');
      if (rng) p.range = localName(rng);
      for (const t of types) {
        if (/TransitiveProperty$/.test(t)) p.features.push('transitive');
        else if (/SymmetricProperty$/.test(t)) p.features.push('symmetric');
        else if (/InverseFunctionalProperty$/.test(t)) p.features.push('inverseFunctional');
        else if (/FunctionalProperty$/.test(t)) p.features.push('functional');
      }
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
