'use strict';

// ---------------------------------------------------------------------------
// reason/owlImport.js — OWL 导入（protege-js 路径，设计文档 §4.5）
//
// 职责：用 protege-js 的多格式解析器读 OWL，把 OWLOntology 转成 Synapse
//       体系（profile），并给出子语言判定与导入预览。
//
// 与既有 src/main/graph/owl.js 的关系（§9 风险 4「格式误判」）：
//   protege-js 可用且解析成功 → 用本模块（表达力更全：匿名类、互逆、
//   等价类、属性特征、domain/range 都能拿到）
//   否则 → 降级到 owl.js 的正则解析（保留既有能力，不回归）
//   两者都失败 → 抛错，由调用方报给用户
//
// ⚠️ 以下 5 点均已用探针实测，与设计文档 §4.5 的伪代码不同：
//   1. io/RDFXMLParser 导出的是**函数** parseRDFXML(text)，没有 RDFXMLParser 类。
//   2. TurtleParser.parse(text) 返回的是 **TripleStore**，不是 OWLOntology；
//      必须再经 io/RDFGraphToOntology 的 triplesToOntology(store, {ontologyIRI})。
//      其余 4 个解析器（RDFXML/Functional/Manchester/OWLXML）直接返回 OWLOntology。
//      另注：triplesToOntology 只还原 TBox，**个体断言全部丢失**（实测 individuals=0），
//      所以 Turtle 路径拿不到「类示例」，这是上游限制而非本模块缺陷。
//   3. OntologyLoader.detectFormat 是**实例方法**，且把 .omn 判成 'Functional'、
//      完全不认识 OWL/XML —— 所以本模块自己按扩展名选解析器。
//   4. AxiomType 在 src/model/OWLAxiom（不是 src/core/，包里根本没有 src/core/）；
//      InverseObjectProperties 的字段是 property1/property2；
//      AnnotationAssertion.subject 是**纯字符串 IRI**；
//      DisjointClasses/EquivalentClasses 的字段是 classExpressions（**数组**）；
//      SubClassOf 是 subClass/superClass；ObjectPropertyDomain 是 property/domain。
//   5. OWLLiteral.toString() 在 datatype 为普通字符串时会抛
//      `this.datatype.getIRI is not a function` —— 取词法值一律用 getLiteral()。
//      OWLClass **没有** isAnonymous() 方法，判断具名要用
//      src/model/OWLClassExpression 的 isNamedClass(expr)。
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

// --- protege-js 可选加载（缺失时整体降级到 owl.js） -----------------------
let PJ = null;
let pjError = '';
try {
  PJ = {
    TurtleParser: require('@skaterqiang/protege-js/src/io/TurtleParser').TurtleParser,
    parseRDFXML: require('@skaterqiang/protege-js/src/io/RDFXMLParser').parseRDFXML,
    FunctionalSyntaxParser: require('@skaterqiang/protege-js/src/io/FunctionalSyntaxParser').FunctionalSyntaxParser,
    ManchesterSyntaxParser: require('@skaterqiang/protege-js/src/io/ManchesterSyntaxParser').ManchesterSyntaxParser,
    OWLXMLParser: require('@skaterqiang/protege-js/src/io/OWLXMLParser').OWLXMLParser,
    triplesToOntology: require('@skaterqiang/protege-js/src/io/RDFGraphToOntology').triplesToOntology,
    AxiomType: require('@skaterqiang/protege-js/src/model/OWLAxiom').AxiomType,
    isNamedClass: require('@skaterqiang/protege-js/src/model/OWLClassExpression').isNamedClass,
  };
} catch (err) {
  pjError = String((err && err.message) || err);
}

const { detectProfile, explainProfile } = require('./profile');

/** protege-js 导入路径是否可用。 */
function protegeAvailable() { return !!PJ; }
function protegeError() { return pjError; }

const MAX_CLASSES = 200;          // 与 owl.js 一致的上限
const MAX_PREDICATES = 120;
const MAX_AXIOMS = 400;
const MAX_CONSTRAINTS = 60;
const MAX_EXAMPLES_PER_CLASS = 3;

// Synapse 体系只支持这 12 种公理（与 renderer/graph.js:691 的 typeNames 一致）
const SUPPORTED_AXIOM_TYPES = new Set([
  'DisjointClasses', 'SubClassOf', 'TransitiveProperty', 'SymmetricProperty',
  'AsymmetricProperty', 'InverseProperties', 'PropertyDomain', 'PropertyRange',
  'FunctionalProperty', 'InverseFunctionalProperty', 'ReflexiveProperty', 'IrreflexiveProperty',
]);
// 二元公理（必须有 object）；其余为一元公理（属性特征，只有 subject）
const BINARY_AXIOM_TYPES = new Set([
  'SubClassOf', 'DisjointClasses', 'InverseProperties', 'PropertyDomain', 'PropertyRange',
]);

const FORMAT_LABEL = {
  Turtle: 'Turtle (.ttl)',
  RDFXML: 'RDF/XML (.owl/.rdf)',
  Functional: 'OWL Functional Syntax (.ofn)',
  Manchester: 'Manchester Syntax (.omn)',
  OWLXML: 'OWL/XML (.owx)',
};

const KNOWN_FORMATS = ['Turtle', 'RDFXML', 'Functional', 'Manchester', 'OWLXML'];

// ---------------------------------------------------------------------------
// 格式识别
// ---------------------------------------------------------------------------

/**
 * 按扩展名 + 内容嗅探判定格式。
 * @returns {{format:string, by:string}} by ∈ ext|ext+xml|ext+ofn|ext+ttl|sniff|sniff-pname|sniff-xml|default
 */
function detectOwlFormat(filePath, text) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  const head = String(text || '').slice(0, 4096);

  // 1) 扩展名优先（最可靠；protege-js 的 detectFormat 在这一步就会把 .omn 误判成 Functional）
  if (ext === '.ttl' || ext === '.n3' || ext === '.trig' || ext === '.nt') return { format: 'Turtle', by: 'ext' };
  if (ext === '.ofn' || ext === '.func') return { format: 'Functional', by: 'ext' };
  if (ext === '.omn' || ext === '.manchester') return { format: 'Manchester', by: 'ext' };
  if (ext === '.owx') return { format: 'OWLXML', by: 'ext' };
  if (ext === '.owl' || ext === '.rdf' || ext === '.xml') {
    // .owl 实际可能是 RDF/XML、Turtle 或 Functional，继续嗅探内容
    if (/^\s*<\?xml|<rdf:RDF|<Ontology[\s>]/i.test(head)) return { format: 'RDFXML', by: 'ext+xml' };
    if (/^\s*(Prefix|Ontology|Declaration|SubClassOf|AnnotationAssertion)\s*\(/m.test(head)) return { format: 'Functional', by: 'ext+ofn' };
    if (/@prefix|@base/i.test(head)) return { format: 'Turtle', by: 'ext+ttl' };
    return { format: 'RDFXML', by: 'ext' };
  }

  // 2) 无扩展名/未知扩展名 → 纯内容嗅探
  if (/^\s*<\?xml|<rdf:RDF/i.test(head)) return { format: 'RDFXML', by: 'sniff' };
  if (/^\s*(Prefix|Ontology|Declaration|SubClassOf)\s*\(/m.test(head)) return { format: 'Functional', by: 'sniff' };
  if (/^\s*(Ontology|Class|ObjectProperty|DataProperty|Individual)\s*:/m.test(head)) return { format: 'Manchester', by: 'sniff' };
  if (/@prefix|@base|^\s*PREFIX\s/im.test(head)) return { format: 'Turtle', by: 'sniff' };
  if (/^\s*[A-Za-z_][\w.-]*:\S/m.test(head)) return { format: 'Turtle', by: 'sniff-pname' };
  if (/<[A-Za-z]/.test(head)) return { format: 'RDFXML', by: 'sniff-xml' };
  return { format: 'RDFXML', by: 'default' };
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/** 单格式解析。Turtle 需要额外一步 TripleStore → OWLOntology。 */
function parseOne(text, format, ontologyIRI) {
  if (!PJ) throw new Error('protege-js 不可用：' + (pjError || '未安装'));
  if (format === 'Turtle') {
    const store = new PJ.TurtleParser().parse(text);
    if (!store || typeof store.size !== 'function') throw new Error('TurtleParser 未返回 TripleStore');
    if (!store.size()) throw new Error('Turtle 解析结果为空（0 条三元组）');
    return PJ.triplesToOntology(store, { ontologyIRI: ontologyIRI || undefined });
  }
  if (format === 'RDFXML') return PJ.parseRDFXML(text);
  if (format === 'Functional') return new PJ.FunctionalSyntaxParser().parse(text, ontologyIRI || undefined);
  if (format === 'Manchester') return new PJ.ManchesterSyntaxParser().parse(text);
  if (format === 'OWLXML') return new PJ.OWLXMLParser().parse(text);
  throw new Error('未知格式：' + format);
}

/**
 * 用 protege-js 解析文本为 OWLOntology。
 * 先按判定格式解析，失败则依次尝试其余格式（应对扩展名与内容不符，§9 风险 4）。
 *
 * @returns {{ontology:object, format:string, tried:Array<{format:string, error:string}>}}
 */
function parseWithProtege(text, formatHint, opts = {}) {
  if (!PJ) throw new Error('protege-js 不可用：' + (pjError || '未安装'));
  // opts 允许传 null（默认值只在 undefined 时生效），否则下面读属性会炸
  const ontologyIRI = (opts && opts.ontologyIRI) || null;
  const order = [formatHint].filter((f) => KNOWN_FORMATS.includes(f));
  for (const f of KNOWN_FORMATS) if (!order.includes(f)) order.push(f);
  const tried = [];
  let lastErr = null;
  for (const format of order) {
    try {
      const ont = parseOne(text, format, ontologyIRI);
      // ⚠️ 必须用 getAxiomsOfType 判定：TurtleParser 返回的 TripleStore 没有这个方法，
      //    若不校验就会把 TripleStore 当 OWLOntology 往下传，然后在签名读取处炸掉。
      if (ont && typeof ont.getAxiomsOfType === 'function' && ont.getAxiomCount() > 0) {
        return { ontology: ont, format, tried };
      }
      lastErr = new Error(`${format} 解析出 0 条公理`);
    } catch (err) {
      lastErr = err;
    }
    tried.push({ format, error: String((lastErr && lastErr.message) || lastErr).slice(0, 200) });
  }
  throw new Error(`protege-js 全部解析器均失败（${order.join(' → ')}）：${(lastErr && lastErr.message) || lastErr}`);
}

// ---------------------------------------------------------------------------
// 小工具：IRI / 字面量 / 具名判定 / key
// ---------------------------------------------------------------------------

/** 从 IRI 取本地名（# 之后，否则最后一个 / 之后，再否则 : 之后）。 */
function localName(iri) {
  const s = String(iri || '');
  const h = s.lastIndexOf('#');
  if (h >= 0 && h < s.length - 1) return s.slice(h + 1);
  const sl = s.lastIndexOf('/');
  if (sl >= 0 && sl < s.length - 1) return s.slice(sl + 1);
  const cl = s.lastIndexOf(':');
  if (cl >= 0 && cl < s.length - 1) return s.slice(cl + 1);
  return s;
}

/**
 * 任意实体/IRI → 纯 IRI 字符串。
 * 兼容三种形态：纯字符串（AnnotationAssertion.subject）、
 * IRI 对象（entity.getIRI()）、以及 toString() 形如 `Class(<http://…>)`。
 */
function iriOf(x) {
  if (!x) return '';
  if (typeof x === 'string') return x;
  try {
    if (typeof x.getIRI === 'function') {
      const i = x.getIRI();
      if (!i) return '';
      return typeof i.toString === 'function' ? String(i.toString()) : String(i);
    }
  } catch (_) { /* 落到下面的兜底 */ }
  try {
    const s = String(x.toString());
    const m = s.match(/<([^>]+)>/);
    if (m) return m[1];
    if (/^https?:\/\/|^urn:/.test(s)) return s;
    // 兜底：缩写 IRI（形如 `:Local` 或 `pfx:Local`）。
    // protege-js 的 FunctionalSyntaxParser **不展开** `Prefix(:=<…>)`，
    // 实体与 AnnotationAssertion.subject 都以缩写形态出现（实测 toString()=":Device"）。
    // 两端一致即可正确配对 label/comment，故此处原样返回缩写串。
    if (/^[A-Za-z0-9_.-]*:[A-Za-z0-9_.-]+$/.test(s)) return s;
  } catch (_) { /* 无 toString */ }
  return '';
}

/**
 * 字面量 → 词法形式。
 * ⚠️ 不能依赖 OWLLiteral.toString()：当 datatype 是普通字符串而非 OWLDatatype
 *    实例时它会抛 `this.datatype.getIRI is not a function`（protege-js 0.1.0 实测）。
 *    一律优先 getLiteral() / .lexicalValue。
 */
function literalOf(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { if (typeof v.getLiteral === 'function') return String(v.getLiteral()); } catch (_) { /* 继续 */ }
  try { if (typeof v.lexicalValue === 'string') return v.lexicalValue; } catch (_) { /* 继续 */ }
  try {
    const s = String(v.toString());
    const m = s.match(/^"([\s\S]*?)"(?:@[\w-]+|\^\^<[^>]*>)?$/);
    if (m) return m[1];
    return s;
  } catch (_) { return ''; }
}

/** 类表达式是否为具名类。匿名类（交/并/补/存在限定）无法映射为 Synapse 具名类。 */
function isNamed(expr) {
  if (!expr) return false;
  if (PJ && typeof PJ.isNamedClass === 'function') {
    try { return !!PJ.isNamedClass(expr); } catch (_) { /* 落到下面的兜底 */ }
  }
  try { if (typeof expr.isAnonymous === 'function') return !expr.isAnonymous(); } catch (_) { /* 继续 */ }
  return !!iriOf(expr);
}

/** IRI → Synapse key：优先本地名，非法字符转下划线，重名加序号。 */
function iriToKey(iri, usedKeys) {
  let k = localName(iri);
  if (!k) k = 'unnamed';
  k = k.replace(/[^\w\u4e00-\u9fa5.-]/g, '_').replace(/^_+|_+$/g, '') || 'unnamed';
  if (k.length > 60) k = k.slice(0, 60);
  const base = k;
  let i = 2;
  while (usedKeys && usedKeys.has(k)) k = `${base}_${i++}`;
  if (usedKeys) usedKeys.add(k);
  return k;
}

// ---------------------------------------------------------------------------
// OWLOntology → Synapse profile
// ---------------------------------------------------------------------------

/**
 * 把 OWLOntology 转成 Synapse 体系对象。
 *
 * @param {object} ontology  protege-js OWLOntology 实例
 * @param {object} [opts]
 * @param {string} [opts.id]          体系 id（默认 owl:<basename>）
 * @param {string} [opts.displayName] 体系名
 * @param {string} [opts.sourceFile]
 * @param {string} [opts.format]      解析所用格式（写进 report）
 * @returns {{profile:object, report:object}}
 */
function ontologyToProfile(ontology, opts = {}) {
  if (!ontology || typeof ontology.getAxiomsOfType !== 'function') {
    throw new Error('ontologyToProfile 需要 OWLOntology 实例（含 getAxiomsOfType）');
  }
  const AT = PJ ? PJ.AxiomType : {};
  const src = opts.sourceFile || opts.displayName || 'imported';
  const baseName = String(src).replace(/\.[A-Za-z0-9]+$/, '');

  const axiomsOf = (name) => {
    const t = AT[name];
    if (!t) return [];
    try { const a = ontology.getAxiomsOfType(t); return Array.isArray(a) ? a : []; } catch (_) { return []; }
  };

  // --- key 分配（IRI → key，全局唯一） ----------------------------------
  const usedKeys = new Set();
  const iriToKeyMap = new Map();
  const keyOf = (x) => {
    const iri = iriOf(x);
    if (!iri) return '';
    if (iriToKeyMap.has(iri)) return iriToKeyMap.get(iri);
    const k = iriToKey(iri, usedKeys);
    iriToKeyMap.set(iri, k);
    return k;
  };

  // --- 1) 注解读取（rdfs:label / comment / notation） --------------------
  const annBySubject = new Map();
  for (const a of axiomsOf('ANNOTATION_ASSERTION')) {
    const subj = iriOf(a && a.subject);          // 实测：subject 是纯字符串 IRI
    if (!subj) continue;
    const prop = localName(iriOf(a && a.property));
    const val = literalOf(a && a.value).trim();
    if (!val) continue;
    if (!annBySubject.has(subj)) annBySubject.set(subj, {});
    const bag = annBySubject.get(subj);
    if (/^(label|prefLabel|altLabel)$/i.test(prop) && !bag.label) bag.label = val;
    else if (/^(comment|definition|description|scopeNote)$/i.test(prop) && !bag.desc) bag.desc = val;
    else if (/^(notation|code|identifier|shelfmark)$/i.test(prop) && !bag.code) bag.code = val;
  }

  // --- 2) 类 -------------------------------------------------------------
  let classEntities = [];
  try { classEntities = ontology.getClassesInSignature() || []; } catch (_) { classEntities = []; }
  const classIris = classEntities.map(iriOf).filter(Boolean);

  // 子类关系：只取「两端都是具名类」的公理，确定 parent
  const subClassAxioms = axiomsOf('SUBCLASS_OF');
  const parentIri = new Map();
  let anonSubClass = 0;
  for (const ax of subClassAxioms) {
    if (!isNamed(ax && ax.subClass) || !isNamed(ax && ax.superClass)) { anonSubClass++; continue; }
    const sub = iriOf(ax.subClass), sup = iriOf(ax.superClass);
    if (!sub || !sup || sub === sup) continue;
    if (!parentIri.has(sub)) parentIri.set(sub, sup);   // 多父类时取第一个（Synapse 是单继承树）
  }

  // 先给所有类分配 key（保证 parent 引用能解析到同一个 key）
  const classKeySet = new Set();
  const classEntries = [];
  for (const iri of classIris) {
    const k = keyOf(iri);
    if (!k || classKeySet.has(k)) continue;
    classKeySet.add(k);
    classEntries.push([iri, k]);
  }

  const classes = [];
  for (const [iri, k] of classEntries) {
    const ann = annBySubject.get(iri) || {};
    const pIri = parentIri.get(iri) || '';
    const pKey = pIri ? keyOf(pIri) : '';
    classes.push({
      key: k,
      label: ann.label || localName(iri),
      code: ann.code || '',
      parent: (pKey && pKey !== k) ? pKey : '',   // 父类可能不在签名里，稍后统一校验
      desc: String(ann.desc || '').slice(0, 300),
      examples: [],
    });
  }

  // --- 3) 谓词（对象属性 + 数据属性） ------------------------------------
  let opEntities = [], dpEntities = [];
  try { opEntities = ontology.getObjectPropertiesInSignature() || []; } catch (_) { /* 签名缺失 */ }
  try { dpEntities = ontology.getDataPropertiesInSignature() || []; } catch (_) { /* 签名缺失 */ }
  const predIriList = [];
  for (const p of opEntities.map(iriOf).filter(Boolean)) predIriList.push([p, false]);
  for (const p of dpEntities.map(iriOf).filter(Boolean)) predIriList.push([p, true]);

  // domain / range（只接受具名类；数据属性的 range 是 XSD 类型，不是类，故意不收）
  const domByProp = new Map();
  const rngByProp = new Map();
  const collectDR = (axName, target) => {
    const isDomain = axName.indexOf('DOMAIN') >= 0;
    for (const ax of axiomsOf(axName)) {
      const p = iriOf(ax && ax.property);
      if (!p) continue;
      const field = isDomain ? ax.domain : ax.range;
      if (!isNamed(field)) continue;
      const v = iriOf(field);
      if (!v) continue;
      if (!target.has(p)) target.set(p, v);
    }
  };
  collectDR('OBJECT_PROPERTY_DOMAIN', domByProp);
  collectDR('OBJECT_PROPERTY_RANGE', rngByProp);
  collectDR('DATA_PROPERTY_DOMAIN', domByProp);

  // 属性特征
  const FLAG_AXIOMS = [
    ['TRANSITIVE_OBJECT_PROPERTY', 'transitive'],
    ['SYMMETRIC_OBJECT_PROPERTY', 'symmetric'],
    ['ASYMMETRIC_OBJECT_PROPERTY', 'asymmetric'],
    ['FUNCTIONAL_OBJECT_PROPERTY', 'functional'],
    ['INVERSE_FUNCTIONAL_OBJECT_PROPERTY', 'inverseFunctional'],
    ['IRREFLEXIVE_OBJECT_PROPERTY', 'irreflexive'],
    ['REFLEXIVE_OBJECT_PROPERTY', 'reflexive'],
  ];
  const featureFlags = new Map();
  for (const [axName, feat] of FLAG_AXIOMS) {
    for (const ax of axiomsOf(axName)) {
      const p = iriOf(ax && ax.property);
      if (!p) continue;
      if (!featureFlags.has(p)) featureFlags.set(p, new Set());
      featureFlags.get(p).add(feat);
    }
  }

  const predicates = [];
  const predKeySet = new Set();
  for (const [pIri, isDatatype] of predIriList) {
    const k = keyOf(pIri);
    if (!k || predKeySet.has(k)) continue;
    predKeySet.add(k);
    const ann = annBySubject.get(pIri) || {};
    const dIri = domByProp.get(pIri) || '';
    const rIri = rngByProp.get(pIri) || '';
    predicates.push({
      key: k,
      label: ann.label || localName(pIri),
      code: ann.code || '',
      domain: dIri ? keyOf(dIri) : '',
      range: rIri ? keyOf(rIri) : '',
      features: [...(featureFlags.get(pIri) || [])],
      desc: String(ann.desc || '').slice(0, 300),
      datatype: isDatatype,
    });
  }

  // --- 4) 公理（只保留 Synapse 支持的 12 种） ----------------------------
  const axioms = [];
  const pushAx = (type, subject, object, desc) => {
    if (!SUPPORTED_AXIOM_TYPES.has(type)) return;
    if (!subject) return;
    if (axioms.length >= MAX_AXIOMS) return;
    const binary = BINARY_AXIOM_TYPES.has(type);
    const a = { type, subject, desc: String(desc || '').slice(0, 200) };
    if (binary) {
      if (!object) return;
      a.object = object;
    } else if (object) {
      return;   // 一元公理不该带 object
    }
    axioms.push(a);
  };

  for (const ax of subClassAxioms) {
    if (!isNamed(ax.subClass) || !isNamed(ax.superClass)) continue;
    const s = keyOf(ax.subClass), o = keyOf(ax.superClass);
    if (s && o && s !== o) pushAx('SubClassOf', s, o, `${s} ⊑ ${o}`);
  }
  // DisjointClasses 可能是 n 元 → 展平成两两组合（Synapse 的公理是二元结构）
  for (const ax of axiomsOf('DISJOINT_CLASSES')) {
    const exprs = Array.isArray(ax.classExpressions) ? ax.classExpressions : [];
    const named = exprs.filter(isNamed).map((e) => keyOf(e)).filter(Boolean);
    for (let i = 0; i < named.length; i++) {
      for (let j = i + 1; j < named.length; j++) {
        if (named[i] !== named[j]) pushAx('DisjointClasses', named[i], named[j], `${named[i]} ⊥ ${named[j]}`);
      }
    }
  }
  const PROP_AXIOM_MAP = [
    ['TRANSITIVE_OBJECT_PROPERTY', 'TransitiveProperty', '传递性'],
    ['SYMMETRIC_OBJECT_PROPERTY', 'SymmetricProperty', '对称性'],
    ['ASYMMETRIC_OBJECT_PROPERTY', 'AsymmetricProperty', '非对称性'],
    ['FUNCTIONAL_OBJECT_PROPERTY', 'FunctionalProperty', '函数性'],
    ['INVERSE_FUNCTIONAL_OBJECT_PROPERTY', 'InverseFunctionalProperty', '反函数性'],
    ['REFLEXIVE_OBJECT_PROPERTY', 'ReflexiveProperty', '自反性'],
    ['IRREFLEXIVE_OBJECT_PROPERTY', 'IrreflexiveProperty', '反自反性'],
  ];
  for (const [axName, synType, zh] of PROP_AXIOM_MAP) {
    for (const ax of axiomsOf(axName)) {
      const k = keyOf(ax && ax.property);
      if (k) pushAx(synType, k, undefined, `${k} 具${zh}`);
    }
  }
  // ⚠️ 实测字段名是 property1 / property2（不是 properties / first / second）
  for (const ax of axiomsOf('INVERSE_OBJECT_PROPERTIES')) {
    const list = Array.isArray(ax.properties) ? ax.properties
      : [ax.property1, ax.property2, ax.first, ax.second].filter(Boolean);
    const keys = list.map((p) => keyOf(p)).filter(Boolean);
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        if (keys[i] !== keys[j]) pushAx('InverseProperties', keys[i], keys[j], `${keys[i]} ⇄ ${keys[j]}`);
      }
    }
  }
  for (const [pIri, dIri] of domByProp) {
    const pk = keyOf(pIri), dk = keyOf(dIri);
    if (pk && dk) pushAx('PropertyDomain', pk, dk, `${pk} 的定义域为 ${dk}`);
  }
  for (const [pIri, rIri] of rngByProp) {
    const pk = keyOf(pIri), rk = keyOf(rIri);
    if (pk && rk) pushAx('PropertyRange', pk, rk, `${pk} 的值域为 ${rk}`);
  }

  // --- 5) 个体 → 类示例（ABox） -----------------------------------------
  // 注意：Turtle 路径经 triplesToOntology 后个体恒为 0（该转换器只还原 TBox），
  // RDF/XML 路径才可能带个体。拿不到就是空，不影响体系可用性。
  let indEntities = [];
  try { indEntities = ontology.getIndividualsInSignature() || []; } catch (_) { indEntities = []; }
  const typeByIndividual = new Map();
  for (const ax of axiomsOf('CLASS_ASSERTION')) {
    const ind = iriOf(ax && (ax.individual || ax.subject));
    if (!ind || !isNamed(ax && (ax.classExpression || ax.class))) continue;
    const c = iriOf(ax.classExpression || ax.class);
    if (c && !typeByIndividual.has(ind)) typeByIndividual.set(ind, c);
  }
  const examplesByClass = new Map();
  const individualCount = indEntities.length;
  for (const ind of indEntities.map(iriOf).filter(Boolean)) {
    const cIri = typeByIndividual.get(ind);
    if (!cIri) continue;
    const ck = keyOf(cIri);
    if (!classKeySet.has(ck)) continue;
    if (!examplesByClass.has(ck)) examplesByClass.set(ck, []);
    const bag = examplesByClass.get(ck);
    const ann = annBySubject.get(ind) || {};
    const nm = String(ann.label || localName(ind)).slice(0, 40);
    if (bag.length < MAX_EXAMPLES_PER_CLASS && nm && !bag.includes(nm)) bag.push(nm);
  }
  for (const c of classes) {
    const ex = examplesByClass.get(c.key);
    if (ex && ex.length) c.examples = ex;
  }

  // --- 6) 本体 IRI / report 初始化 --------------------------------------
  const report = {
    classCount: classes.length,
    predicateCount: predicates.length,
    axiomCount: axioms.length,
    constraintCount: 0,
    individualCount,
    format: FORMAT_LABEL[opts.format] || opts.format || 'OWL',
    formatId: opts.format || '',
    parser: 'protege-js',
    sourceFile: String(src),
    truncated: false,
    originalClassCount: classes.length,
    predicatesTruncated: false,
    orphanClasses: [],
    unsupportedAxioms: [],
    droppedAxioms: 0,
    ontologyIri: '',
  };
  try {
    const oid = ontology.getOntologyID();
    // OWLOntologyID 有 ontologyIRI 字段；toString() 形如 `OntologyID(<http://…>)`
    report.ontologyIri = oid ? String(oid.ontologyIRI || '').trim() : '';
    if (!report.ontologyIri && oid && typeof oid.toString === 'function') {
      const m = String(oid.toString()).match(/<([^>]+)>/);
      if (m) report.ontologyIri = m[1];
    }
  } catch (_) { /* 匿名本体 */ }

  // --- 7) 截断 -----------------------------------------------------------
  if (classes.length > MAX_CLASSES) {
    // 保留根类 + 一级子类（与 owl.js 同策略）
    const roots = classes.filter((c) => !c.parent);
    const rootKeys = new Set(roots.map((c) => c.key));
    const firstLevel = classes.filter((c) => c.parent && rootKeys.has(c.parent));
    const keep = new Set([...roots, ...firstLevel].map((c) => c.key));
    const kept = classes.filter((c) => keep.has(c.key)).slice(0, MAX_CLASSES);
    const keptKeys = new Set(kept.map((c) => c.key));
    for (const c of kept) if (c.parent && !keptKeys.has(c.parent)) c.parent = '';
    classes.length = 0;
    for (const c of kept) classes.push(c);
    report.truncated = true;
    report.classCount = classes.length;
  }
  if (predicates.length > MAX_PREDICATES) {
    predicates.length = MAX_PREDICATES;
    report.predicateCount = predicates.length;
    report.predicatesTruncated = true;
  }

  // --- 8) 引用完整性 ----------------------------------------------------
  const finalClassKeys = new Set(classes.map((c) => c.key));
  for (const c of classes) {
    if (c.parent && !finalClassKeys.has(c.parent)) {
      report.orphanClasses.push(`${c.key} (parent: ${c.parent})`);
      c.parent = '';
    }
  }
  // 谓词 domain/range 指向被截断掉的类 → 清空，否则护栏会误拦所有边
  let clearedRefs = 0;
  for (const p of predicates) {
    if (p.domain && !finalClassKeys.has(p.domain)) { p.domain = ''; clearedRefs++; }
    if (p.range && !finalClassKeys.has(p.range)) { p.range = ''; clearedRefs++; }
  }
  if (clearedRefs) report.clearedRefs = clearedRefs;

  // 公理里引用了不存在的 key → 丢弃（悬挂引用会让推理器与护栏都出错）
  const validKeys = new Set([...finalClassKeys, ...predicates.map((p) => p.key)]);
  const keptAxioms = axioms.filter((a) => validKeys.has(a.subject) && (a.object === undefined || validKeys.has(a.object)));
  report.droppedAxioms = axioms.length - keptAxioms.length;
  axioms.length = 0;
  for (const a of keptAxioms) axioms.push(a);
  report.axiomCount = axioms.length;

  // 被跳过的公理类型（让用户知道有多少表达力没保留下来）
  const SKIPPED = [
    ['EQUIVALENT_CLASSES', '等价类'],
    ['DISJOINT_UNION', '不相交并'],
    ['SUB_OBJECT_PROPERTY_OF', '子属性'],
    ['SUB_PROPERTY_CHAIN_OF', '属性链'],
    ['EQUIVALENT_OBJECT_PROPERTIES', '等价属性'],
    ['DISJOINT_OBJECT_PROPERTIES', '不相交属性'],
    ['HAS_KEY', '键约束'],
    ['SAME_INDIVIDUAL', '相同个体'],
    ['DIFFERENT_INDIVIDUALS', '不同个体'],
    ['DATATYPE_DEFINITION', '自定义数据类型'],
    ['NEGATIVE_OBJECT_PROPERTY_ASSERTION', '否定属性断言'],
    ['SUB_DATA_PROPERTY_OF', '子数据属性'],
  ];
  for (const [t, zh] of SKIPPED) {
    const n = axiomsOf(t).length;
    if (n) report.unsupportedAxioms.push({ type: t, label: zh, count: n, note: 'Synapse 体系结构不支持，已跳过（不影响类层级与谓词导入）' });
  }
  if (anonSubClass) {
    report.unsupportedAxioms.push({
      type: 'AnonymousClassExpression', label: '匿名类表达式', count: anonSubClass,
      note: '交/并/补/存在限定等匿名类表达式无法映射为 Synapse 具名类，已跳过',
    });
  }
  if (individualCount === 0 && opts.format === 'Turtle') {
    report.unsupportedAxioms.push({
      type: 'ABoxDropped', label: '个体断言', count: 0,
      note: 'protege-js 的 Turtle 路径（TurtleParser → TripleStore → triplesToOntology）只还原 TBox，个体与个体间断言会丢失，故无「类示例」',
    });
  }

  // --- 9) 约束（人话，供体系编辑器与「推理」Tab 展示） -------------------
  const labelOf = (k) => {
    const c = classes.find((x) => x.key === k);
    if (c) return c.label || c.key;
    const p = predicates.find((x) => x.key === k);
    if (p) return p.label || p.key;
    return k;
  };
  const constraints = [];
  for (const a of axioms) {
    let desc = '';
    if (a.type === 'DisjointClasses') desc = `类「${labelOf(a.subject)}」与「${labelOf(a.object)}」不相交，同一节点不可同时属于两者`;
    else if (a.type === 'SubClassOf') desc = `「${labelOf(a.subject)}」是「${labelOf(a.object)}」的子类，父类约束自动继承`;
    else if (a.type === 'TransitiveProperty') desc = `谓词「${labelOf(a.subject)}」具传递性：A→B→C 可推理出 A→C`;
    else if (a.type === 'SymmetricProperty') desc = `谓词「${labelOf(a.subject)}」具对称性：A→B 可推理出 B→A`;
    else if (a.type === 'AsymmetricProperty') desc = `谓词「${labelOf(a.subject)}」为非对称属性：A→B 与 B→A 不可同时成立`;
    else if (a.type === 'InverseProperties') desc = `谓词「${labelOf(a.subject)}」与「${labelOf(a.object)}」互逆：一方成立可推出另一方反向成立`;
    else if (a.type === 'PropertyDomain') desc = `谓词「${labelOf(a.subject)}」的起点必须是「${labelOf(a.object)}」或其子类`;
    else if (a.type === 'PropertyRange') desc = `谓词「${labelOf(a.subject)}」的终点必须是「${labelOf(a.object)}」或其子类`;
    else if (a.type === 'FunctionalProperty') desc = `谓词「${labelOf(a.subject)}」为函数属性：同一起点最多一个终点`;
    else if (a.type === 'InverseFunctionalProperty') desc = `谓词「${labelOf(a.subject)}」为反函数属性：同一终点最多一个起点`;
    else if (a.type === 'IrreflexiveProperty') desc = `谓词「${labelOf(a.subject)}」为反自反属性：不可自环`;
    else if (a.type === 'ReflexiveProperty') desc = `谓词「${labelOf(a.subject)}」为自反属性：每个个体都应有自环`;
    if (desc) constraints.push({ desc });
    if (constraints.length >= MAX_CONSTRAINTS) break;
  }
  report.constraintCount = constraints.length;

  // --- 10) 兜底类型 / 兜底谓词 / 提取模式 --------------------------------
  const roots = classes.filter((c) => !c.parent);
  const rootHit = roots.find((c) => /entity|thing|object|实体|事物|物体/i.test(`${c.label} ${c.key}`));
  const fallbackType = (rootHit && rootHit.key) || (roots[0] && roots[0].key)
    || (classes[0] && classes[0].key) || 'thing';
  // 兜底谓词优先选无 domain/range 约束的（否则降级边会立刻被护栏再拦一次）
  const unconstrained = predicates.find((p) => !p.domain && !p.range);
  const fallbackRel = (unconstrained && unconstrained.key) || (predicates[0] && predicates[0].key) || '相关';

  const profile = {
    id: opts.id || ('owl:' + baseName.replace(/[^\w\u4e00-\u9fa5.-]/g, '_')),
    name: opts.displayName || baseName,
    desc: `protege-js 导入：${baseName} · ${classes.length}类/${predicates.length}谓词/${axioms.length}公理 · ${report.format}`,
    classes,
    predicates,
    axioms,
    constraints,
    fallbackType,
    fallbackRel,
    promptMode: classes.length <= 12 ? 'flat' : 'two-stage',
    owl: true,
    sourceFile: String(src),
    parser: 'protege-js',
    ontologyIri: report.ontologyIri,
  };

  return { profile, report };
}

// ---------------------------------------------------------------------------
// 对外主入口
// ---------------------------------------------------------------------------

/**
 * 导入 OWL 文件为 Synapse 体系。
 *
 * @param {string} filePath
 * @param {object} [opts]
 * @param {string}  [opts.displayName]  体系显示名（web 上传会加时间戳前缀）
 * @param {string}  [opts.id]           体系 id
 * @param {boolean} [opts.forceLegacy=false] 强制走 owl.js（用户在预览弹窗手选解析器时用）
 * @param {string}  [opts.forceFormat]  强制指定格式（跳过自动识别）
 * @param {boolean} [opts.previewOnly]  仅解析预览，不落库（落库由 graph.js 负责）
 * @returns {Promise<{profile:object, report:object, profileCheck:object, preview:object, via:string}>}
 */
async function importOwlExtended(filePath, opts = {}) {
  if (!filePath) throw new Error('未指定文件路径');
  if (!fs.existsSync(filePath)) throw new Error('文件不存在：' + filePath);
  const text = fs.readFileSync(filePath, 'utf8');
  if (!text || !text.trim()) throw new Error('文件为空：' + filePath);
  const fileName = path.basename(filePath);
  const detected = detectOwlFormat(filePath, text);
  const wantFormat = KNOWN_FORMATS.includes(opts.forceFormat) ? opts.forceFormat : detected.format;
  const displayName = opts.displayName || fileName.replace(/\.[A-Za-z0-9]+$/, '');

  // 1) protege-js 路径
  if (!opts.forceLegacy && PJ) {
    try {
      const { ontology, format, tried } = parseWithProtege(text, wantFormat);
      const { profile, report } = ontologyToProfile(ontology, {
        id: opts.id, displayName, sourceFile: fileName, format,
      });
      if (!profile.classes.length) throw new Error('解析成功但未提取到任何类');
      const profileCheck = detectProfile(ontology);
      const preview = buildPreview(profile, report, profileCheck, detected);
      // 格式识别与实际解析成功的格式不一致时提示用户
      if (format !== detected.format) {
        preview.notes.unshift(`扩展名/内容判定为 ${detected.format}，实际由 ${format} 解析器成功解析。`);
      }
      if (tried && tried.length) {
        preview.notes.push(`解析器尝试中失败的有：${tried.map((t) => `${t.format}（${t.error.slice(0, 60)}）`).join('；')}`);
      }
      return { profile, report, profileCheck, preview, via: 'protege-js' };
    } catch (err) {
      // 记录后降级，不直接抛（§9 风险 4：至少让用户拿到正则解析的结果）
      const pjErr = String((err && err.message) || err);
      const legacy = tryLegacy(filePath, opts, displayName, detected);
      if (legacy && legacy.ok) {
        legacy.result.report.protegeError = pjErr;
        legacy.result.preview.notes.unshift(`protege-js 解析失败（${pjErr.slice(0, 200)}），已降级为内置正则解析器。`);
        return legacy.result;
      }
      const why = legacy && legacy.reason ? legacy.reason : `内置解析器（owl.js）也不可用`;
      throw new Error(`无法解析 ${fileName}：${pjErr}；${why}`);
    }
  }

  // 2) 降级路径
  const legacy = tryLegacy(filePath, opts, displayName, detected);
  if (legacy && legacy.ok) {
    legacy.result.preview.notes.unshift(PJ
      ? '已按要求使用内置正则解析器（owl.js）。'
      : `protege-js 不可用（${pjError || '未安装'}），使用内置正则解析器（owl.js）。`);
    return legacy.result;
  }
  // owl.js 跑通了但没提取到类（典型：默认前缀 `:` 的 Turtle，owl.js 正则只认具名前缀），
  // 与「owl.js 模块缺失/抛异常」是两回事，报错要分清，否则用户会误以为兜底解析器坏了。
  const why = legacy && legacy.reason ? legacy.reason : (pjError || 'protege-js 解析失败');
  throw new Error(`无法解析 ${fileName}：${why}`);
}

/**
 * 降级到既有 owl.js 正则解析器。
 * @returns {{ok:true, result:object}|{ok:false, reason:string}|null}
 *   ok=false 时 reason 说明原因（供上层拼错误消息）；模块缺失/抛异常返回 null。
 */
function tryLegacy(filePath, opts, displayName, detected) {
  let legacy;
  try {
    legacy = require('../owl');
  } catch (err) {
    return { ok: false, reason: `内置解析器（owl.js）不可用：${String((err && err.message) || err)}` };
  }
  try {
    const { profile, report } = legacy.parseOwlFile(filePath, Object.assign({}, opts, { displayName }));
    if (!profile || !Array.isArray(profile.classes) || !profile.classes.length) {
      return {
        ok: false,
        reason: '内置解析器（owl.js）未能从该文件提取到任何类'
          + '（owl.js 为轻量正则解析，不支持默认前缀 `:` 的 Turtle 等写法）；'
          + (pjError ? `protege-js 亦失败：${pjError}` : 'protege-js 亦失败'),
      };
    }
    report.parser = 'owl.js';
    report.format = report.format || FORMAT_LABEL[detected.format] || detected.format;
    report.formatId = detected.format;
    // owl.js 不产生 OWLOntology，无法做子语言判定；但 Synapse 的 RL 物化只依赖
    // 体系里的传递/对称/互逆/domain/range 声明，与 OWL 2 子语言无关，故仍可用。
    const profileCheck = {
      available: false,
      error: 'owl.js 路径不产生 OWLOntology，无法判定 OWL 2 子语言',
      rl: { ok: false, violations: [], shown: 0, total: 0 },
      ql: { ok: false, violations: [], shown: 0, total: 0 },
      el: { ok: false, violations: [], shown: 0, total: 0 },
      recommend: null, reasonerAvailable: true, profiles: [], meta: {},
    };
    return {
      ok: true,
      result: {
        profile, report, profileCheck,
        preview: buildPreview(profile, report, profileCheck, detected),
        via: 'owl.js',
      },
    };
  } catch (err) {
    return { ok: false, reason: `内置解析器（owl.js）抛出异常：${String((err && err.message) || err)}` };
  }
}

/**
 * 构造导入预览（设计文档 §6.9「OWL 导入预览弹窗」的数据源）。
 * 纯数据，不含 HTML —— 渲染在 renderer 侧做。
 */
function buildPreview(profile, report, profileCheck, detected) {
  const notes = [];
  const warnings = [];
  // owl.js 降级路径产出的 profile **没有 axioms 字段**（只有 classes/predicates/constraints），
  // 这里统一取安全副本，避免 undefined.length 崩在预览阶段。
  const axioms = Array.isArray(profile.axioms) ? profile.axioms : [];
  const classes = Array.isArray(profile.classes) ? profile.classes : [];
  const predicates = Array.isArray(profile.predicates) ? profile.predicates : [];

  if (report.truncated) {
    warnings.push(`类数量 ${report.originalClassCount} 超过上限 ${MAX_CLASSES}，已保留根类与一级子类共 ${report.classCount} 个。`);
  }
  if (report.predicatesTruncated) {
    warnings.push(`谓词数量超过上限 ${MAX_PREDICATES}，已截断至 ${report.predicateCount} 个。`);
  }
  if (report.orphanClasses && report.orphanClasses.length) {
    warnings.push(`${report.orphanClasses.length} 个类的父类不在导入范围内，已置为根类：${report.orphanClasses.slice(0, 5).join('、')}${report.orphanClasses.length > 5 ? ' 等' : ''}`);
  }
  if (report.droppedAxioms) {
    warnings.push(`${report.droppedAxioms} 条公理因引用了被截断/不存在的实体而丢弃。`);
  }
  if (report.clearedRefs) {
    warnings.push(`${report.clearedRefs} 处 domain/range 引用指向了被截断的类，已清空以免护栏误拦。`);
  }
  for (const u of (report.unsupportedAxioms || [])) {
    notes.push(`跳过 ${u.count} 条${u.label || u.type}：${u.note}`);
  }
  if (!classes.length) warnings.push('未提取到任何类，该体系不可用。');

  // ⚠️ 已核实（protege-js 0.1.0 实测）：ManchesterSyntaxParser 不产出任何
  //    AnnotationAssertion 公理，也不解析 `Prefix:` / `Ontology:` 头（实体 IRI 一律
  //    落到 http://example.org/<Local>，本体 IRI 为空）。因此 .omn 导入必然丢 label。
  //    这是上游解析器的能力边界，不是本模块的 bug —— 但要显式告知用户，
  //    否则表现为「明明写了 rdfs:label 却显示英文名」的困惑。
  const unlabeled = classes.length > 0 && classes.every((c) => !c.label || c.label === c.key);
  if (detected && detected.format === 'Manchester' && unlabeled) {
    warnings.push('Manchester 语法（.omn）：protege-js 的 Manchester 解析器不还原 rdfs:label 注解，'
      + '类与谓词名称已回退为英文本地名。如需中文显示名，请改用 Turtle（.ttl）、RDF/XML（.owl）或 Functional（.ofn）导出。');
  }

  // 子语言判定
  if (profileCheck && profileCheck.available) {
    const ex = explainProfile(profileCheck);
    notes.push(ex.headline);
    for (const l of ex.lines) notes.push(l);
    if (!profileCheck.reasonerAvailable) {
      warnings.push('该本体不属于 OWL 2 RL，Synapse 内置推理机无法对其做完整本地推理；导入后类层级与谓词受控词表仍生效。');
    }
  } else if (profileCheck && profileCheck.error) {
    notes.push('子语言判定：' + profileCheck.error);
  }

  // 护栏覆盖度 —— 显式回应「导入了但护栏不生效」的困惑，而不是静默失效
  const withDomain = predicates.filter((p) => p.domain).length;
  const withRange = predicates.filter((p) => p.range).length;
  const withFeat = predicates.filter((p) => (p.features || []).length).length;
  if (!withDomain && !withRange) {
    notes.push('该本体未声明 rdfs:domain / rdfs:range，写入护栏不会拦截越界连线（传递/对称/互逆推理仍可用）。');
  } else {
    notes.push(`护栏覆盖：${withDomain}/${predicates.length} 个谓词有定义域，${withRange} 个有值域。`);
  }

  // 推理燃料：有这些才会产生推理边
  const axHist = axiomHistogram(axioms);
  const fuelTypes = ['TransitiveProperty', 'SymmetricProperty', 'InverseProperties', 'PropertyDomain', 'PropertyRange', 'SubClassOf', 'DisjointClasses'];
  const fuelHits = axHist.filter((h) => fuelTypes.includes(h.type));
  const hasFuel = fuelHits.length > 0 || withFeat > 0 || classes.some((c) => c.parent);
  if (hasFuel) {
    notes.push(`可产生推理边：${fuelHits.map((h) => `${h.type}×${h.count}`).join('、') || '仅类层级'}。`);
  } else {
    warnings.push('该体系没有传递/对称/互逆/domain/range 声明，也没有类层级 —— 推理不会产生任何新边。');
  }

  const roots = classes.filter((c) => !c.parent);
  return {
    fileName: report.sourceFile || profile.sourceFile || '',
    format: report.format,
    formatId: report.formatId || (detected ? detected.format : ''),
    detectedFormat: detected ? detected.format : '',
    detectedBy: detected ? detected.by : '',
    parser: report.parser || 'protege-js',
    ontologyIri: report.ontologyIri || profile.ontologyIri || '',
    counts: {
      classes: classes.length,
      predicates: predicates.length,
      axioms: axioms.length,
      constraints: (profile.constraints || []).length,
      individuals: report.individualCount || 0,
      roots: roots.length,
    },
    rootClasses: roots.slice(0, 12).map((c) => ({ key: c.key, label: c.label })),
    sampleClasses: classes.slice(0, 12).map((c) => ({ key: c.key, label: c.label, parent: c.parent, desc: c.desc })),
    samplePredicates: predicates.slice(0, 12).map((p) => ({ key: p.key, label: p.label, domain: p.domain, range: p.range, features: p.features || [] })),
    axiomTypes: axHist,
    promptMode: profile.promptMode,
    fallbackType: profile.fallbackType,
    fallbackRel: profile.fallbackRel,
    profileCheck: (profileCheck && profileCheck.available) ? {
      recommend: profileCheck.recommend,
      profiles: profileCheck.profiles,
      reasonerAvailable: profileCheck.reasonerAvailable,
      rl: { ok: profileCheck.rl.ok, total: profileCheck.rl.total, sample: profileCheck.rl.violations.slice(0, 5) },
      ql: { ok: profileCheck.ql.ok, total: profileCheck.ql.total },
      el: { ok: profileCheck.el.ok, total: profileCheck.el.total },
    } : null,
    warnings,
    notes,
  };
}

/** 公理类型直方图（按数量降序）。 */
function axiomHistogram(axioms) {
  const h = {};
  for (const a of (axioms || [])) { if (a && a.type) h[a.type] = (h[a.type] || 0) + 1; }
  return Object.keys(h).map((k) => ({ type: k, count: h[k] })).sort((a, b) => b.count - a.count);
}

module.exports = {
  protegeAvailable,
  protegeError,
  detectOwlFormat,
  parseOne,
  parseWithProtege,
  ontologyToProfile,
  importOwlExtended,
  buildPreview,
  axiomHistogram,
  localName,
  iriOf,
  literalOf,
  isNamed,
  iriToKey,
  SUPPORTED_AXIOM_TYPES,
  KNOWN_FORMATS,
  FORMAT_LABEL,
  MAX_CLASSES,
  MAX_PREDICATES,
  MAX_AXIOMS,
};
