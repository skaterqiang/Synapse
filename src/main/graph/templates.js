// 领域模版领域层：模版存储（SQLite kv）、AI 自动生成、吸收时的领域匹配与提取约束注入
const db = require('../common/db');
const { chatOnce, extractJson } = require('../ai/llm');
const { getPrompt } = require('../ai/prompts');

// KV_KEY / GENERAL_TEMPLATE 定义于 common/constants.js
const { DOMAIN_TEMPLATES_KEY: KV_KEY, GENERAL_TEMPLATE } = require('../common/constants');

const trimStr = (v, max = 2000) => String(v ?? '').trim().slice(0, max);
// 逗号分隔字符串或数组 → 去空去重的字符串数组
const toList = (v) => {
  const arr = Array.isArray(v) ? v : String(v ?? '').split(/[,，]/);
  return [...new Set(arr.map((s) => trimStr(s, 100)).filter(Boolean))];
};
// {name, desc} 结构数组归一化（实体/概念类型与骨架页面共用）
const toPairs = (v, nameKey, descKey) =>
  (Array.isArray(v) ? v : [])
    .map((it) => ({ [nameKey]: trimStr(it && it[nameKey], 100), [descKey]: trimStr(it && it[descKey], 300) }))
    .filter((it) => it[nameKey]);

// ---------- 模版 v2：体系绑定 + 领域类/谓词/约束 ----------
// 解析指定 profile 的合成本体（延迟 require 避免与 graph.js 的加载顺序耦合）
function resolveOntologyFor(profileId) {
  const graph = require('./graph');
  try { return graph.resolveOntology(profileId); } catch (_) { return graph.resolveOntology('bfo-lite'); }
}

// domainClasses/domainPredicates 归一化
const toClasses = (v) =>
  (Array.isArray(v) ? v : [])
    .map((it) => ({
      key: trimStr(it && it.key, 60),
      label: trimStr(it && it.label, 100),
      parent: trimStr(it && it.parent, 60),
      desc: trimStr(it && it.desc, 300),
      examples: toList(it && it.examples),
      from: it && it.from === 'base' ? 'base' : 'custom',
    }))
    .filter((it) => it.key);
const toPredicates = (v) =>
  (Array.isArray(v) ? v : [])
    .map((it) => ({
      key: trimStr((it && it.key) || (it && it.label), 60),
      label: trimStr((it && it.label) || (it && it.key), 100),
      domain: trimStr(it && it.domain, 60),
      range: trimStr(it && it.range, 60),
      features: toList(it && it.features),
      from: it && it.from === 'base' ? 'base' : 'custom',
    }))
    .filter((it) => it.key);
// 约束五元组：{subject, attr, op, value, desc}
const toConstraints = (v) =>
  (Array.isArray(v) ? v : [])
    .map((it) => ({
      subject: trimStr(it && it.subject, 60),
      attr: trimStr(it && it.attr, 60),
      op: trimStr(it && it.op, 20),
      value: trimStr(it && it.value, 200),
      desc: trimStr(it && it.desc, 300),
    }))
    .filter((it) => it.subject || it.desc);

// v1 → v2 惰性迁移：entityTypes→domainClasses（挂 bfo-lite object）、conceptTypes→挂 information
// 通用模版（general）domainClasses 留空（不限制，退化为现有行为）
function migrateTplV2(tpl) {
  if (!tpl || typeof tpl !== 'object') return tpl;
  if (Array.isArray(tpl.domainClasses)) return tpl; // 已是 v2
  const migrated = { ...tpl, ontologyProfile: tpl.ontologyProfile || 'bfo-lite', migratedFrom: 'v1' };
  const isGeneral = tpl.id === 'general';
  const ent = (tpl.entityTypes || []).map((t) => ({
    key: trimStr(t.name, 60), label: trimStr(t.name, 100), parent: 'object',
    desc: trimStr(t.desc, 300), examples: [], from: 'custom',
  })).filter((c) => c.key);
  const con = (tpl.conceptTypes || []).map((t) => ({
    key: trimStr(t.name, 60), label: trimStr(t.name, 100), parent: 'information',
    desc: trimStr(t.desc, 300), examples: [], from: 'custom',
  })).filter((c) => c.key);
  migrated.domainClasses = isGeneral ? [] : [...ent, ...con];
  migrated.domainPredicates = Array.isArray(tpl.domainPredicates) ? toPredicates(tpl.domainPredicates) : [];
  migrated.constraints = Array.isArray(tpl.constraints) ? toConstraints(tpl.constraints) : [];
  return migrated;
}

function listTemplates() {
  let list = [];
  try {
    list = JSON.parse(db.getKv(KV_KEY) || '[]');
  } catch (_) {
    list = [];
  }
  if (!Array.isArray(list)) list = [];
  // 兜底：确保内置通用模版始终存在且排在最前
  if (!list.some((t) => t && t.id === 'general')) {
    list.unshift({ ...GENERAL_TEMPLATE, updatedAt: Date.now() });
  }
  // v1 → v2 惰性迁移（加载时升级，返回前持久化一次）
  let migratedAny = false;
  list = list.map((t) => {
    if (t && !Array.isArray(t.domainClasses)) { migratedAny = true; return migrateTplV2(t); }
    return t;
  });
  if (migratedAny) persistTemplates(list);
  return list;
}

function persistTemplates(list) {
  db.setKv(KV_KEY, JSON.stringify(list));
  db.flush();
}

// 新建/更新模版（按 id upsert），字段全部归一化后落库
function saveTemplate(input) {
  const tpl = input || {};
  let id = trimStr(tpl.id, 60);
  if (!trimStr(tpl.name, 100)) throw new Error('名称不能为空');
  const list = listTemplates();
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(id)) {
    // 新建时 ID 无需用户填写：空/非法则自动生成英文标识符（避让已有 ID）
    id = 'tpl_' + Date.now().toString(36);
    while (list.some((t) => t.id === id)) id += Math.floor(Math.random() * 36).toString(36);
  }
  const old = list.find((t) => t.id === id);
  const profileId = trimStr(tpl.ontologyProfile, 60) || 'bfo-lite';
  const onto = resolveOntologyFor(profileId);
  const profileKeys = new Set((onto.classes || []).map((c) => c.key));
  // 领域类：base 项的 key 必须存在于体系类树；custom 项的 parent 必须存在于体系类树
  const domainClasses = toClasses(tpl.domainClasses);
  const warnings = [];
  for (const c of domainClasses) {
    if (c.from === 'base' && !profileKeys.has(c.key)) {
      warnings.push(`领域类「${c.key}」不在体系「${onto.name}」中，已忽略`);
    }
    if (c.from !== 'base' && c.parent && !profileKeys.has(c.parent) && !domainClasses.some((x) => x.key === c.parent)) {
      warnings.push(`领域类「${c.label || c.key}」的父类「${c.parent}」不在体系类树内，已挂到兜底类 ${onto.fallbackType}`);
      c.parent = onto.fallbackType;
    }
  }
  const validClasses = domainClasses.filter((c) => c.from !== 'base' || profileKeys.has(c.key));
  const next = {
    id,
    name: trimStr(tpl.name, 100),
    desc: trimStr(tpl.desc),
    keywords: toList(tpl.keywords),
    ontologyProfile: profileId,
    domainClasses: validClasses,
    domainPredicates: toPredicates(tpl.domainPredicates),
    constraints: toConstraints(tpl.constraints),
    mustExtract: toList(tpl.mustExtract),
    ignoreContent: toList(tpl.ignoreContent),
    quality: trimStr(tpl.quality),
    skeleton: toPairs(tpl.skeleton, 'title', 'desc'),
    builtin: !!(old && old.builtin),
    demo: !!(old && old.demo),
    updatedAt: Date.now(),
  };
  // 兼容：从 domainClasses 反推 entityTypes/conceptTypes，供未升级的旧读取方使用
  next.entityTypes = validClasses.filter((c) => c.parent !== 'information').map((c) => ({ name: c.label || c.key, desc: c.desc }));
  next.conceptTypes = validClasses.filter((c) => c.parent === 'information').map((c) => ({ name: c.label || c.key, desc: c.desc }));
  if (old) list[list.indexOf(old)] = next;
  else list.push(next);
  persistTemplates(list);
  next._warnings = warnings; // 非持久化字段，供前端提示降级项
  return next;
}

function removeTemplate(id) {
  const list = listTemplates();
  const tpl = list.find((t) => t.id === id);
  if (!tpl) throw new Error('模版不存在：' + id);
  if (tpl.builtin) throw new Error('内置通用模版不可删除');
  persistTemplates(list.filter((t) => t.id !== id));
  return { removed: id };
}

// 领域匹配提示词（{{SOURCE_EXCERPT}} 在吸收时替换为来源摘录），也供前端「匹配提示词」预览
function matchPrompt(templates) {
  const list = templates || listTemplates();
  const lines = list.map((t) => {
    const kw = (t.keywords || []).join('、') || '无';
    return `- ${t.id}（${t.name}）：${t.desc || '无描述'}（关键词：${kw}）`;
  });
  return [
    '你是个人知识库的领域识别助手。请阅读下方来源内容摘录，从以下领域模版中选出最匹配的一个：',
    '',
    ...lines,
    '',
    '判定规则：',
    '1. 依据来源的主题、术语与模版关键词的吻合程度判定；',
    '2. 无法明确匹配任何特定领域时，一律返回 general；',
    '3. 只输出一个 JSON 对象，不要输出其他任何内容：{"template": "<模版ID>", "reason": "一句话判定理由"}',
    '',
    '=== 来源内容摘录 ===',
    '{{SOURCE_EXCERPT}}',
  ].join('\n');
}

// 关键词兜底匹配：按命中次数取最高分，全部未命中回退通用模版
function matchByKeywords(list, text) {
  let best = null;
  let bestScore = 0;
  for (const t of list) {
    const score = (t.keywords || []).reduce((n, kw) => n + (kw && text.includes(kw) ? 1 : 0), 0);
    if (score > bestScore) { best = t; bestScore = score; }
  }
  return best || list.find((t) => t.id === 'general') || list[0] || null;
}

// 吸收时的领域匹配：LLM 判定优先，失败或结果非法时回退关键词匹配
// opts.timeoutMs：LLM 判定的硬超时（提交前预匹配用，避免模型长时间无响应把调用方卡死）
// opts.retries：LLM 判定的重试次数（预匹配传 0，作业内匹配沿用设置项默认值）
// opts.onDegrade：LLM 判定失败、改用关键词兜底时回调，供调用方提示用户
async function matchTemplate(settings, raws, opts = {}) {
  const list = listTemplates();
  const text = (raws || []).map((r) => r.content).join('\n').slice(0, 3000);
  if (list.length <= 1) return list[0] || null;
  try {
    const prompt = matchPrompt(list).replace('{{SOURCE_EXCERPT}}', text || '（空）');
    const answer = await chatOnce(settings, [
      { role: 'system', content: getPrompt(settings, 'matchPrompt') },
      { role: 'user', content: prompt },
    ], opts.retries, undefined, opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined);
    const picked = list.find((t) => t.id === extractJson(answer).template);
    if (picked) return picked;
  } catch (err) {
    // LLM 匹配失败（含超时）走关键词兜底，绝不阻断调用方的后续提交
    if (opts.onDegrade) opts.onDegrade(err);
  }
  return matchByKeywords(list, text);
}

// 吸收前的领域预匹配：返回命中的特定领域模版；未命中（含 LLM/关键词均判定为 general）返回 null，
// 由渲染层据此询问用户“新建领域模版还是用通用模版”
// degraded=true 表示 LLM 判定失败/超时、结果来自关键词兜底
async function preMatchTemplate(settings, raws, opts = {}) {
  const list = listTemplates();
  const hasSpecific = list.some((t) => t.id !== 'general');
  if (!hasSpecific) return { matched: null, hasSpecific, total: list.length };
  let degradeErr = null;
  const tpl = await matchTemplate(settings, raws, { ...opts, onDegrade: (err) => { degradeErr = err; } });
  const matched = tpl && tpl.id !== 'general' ? { id: tpl.id, name: tpl.name } : null;
  // 超时中断在 llm 层报为“已停止回答”，对预检查场景改写成用户能看懂的超时描述
  const degradeMsg = !degradeErr ? ''
    : (degradeErr.name === 'AbortError' && opts.timeoutMs ? `模型未在 ${Math.round(opts.timeoutMs / 1000)} 秒内响应` : degradeErr.message);
  return { matched, hasSpecific, total: list.length, degraded: !!degradeErr, degradeError: degradeMsg };
}

// 模版 → 吸收提示词中的领域约束块（v2 四段式：体系 + 领域类 + 领域谓词 + 约束）
function templateGuidance(tpl) {
  if (!tpl) return '';
  const v2 = Array.isArray(tpl.domainClasses) ? tpl : migrateTplV2(tpl);
  const pairs = (arr, nameKey, descKey) =>
    (arr || []).map((it) => (it[descKey] ? `${it[nameKey]}（${it[descKey]}）` : it[nameKey])).join('、') || '无';
  const onto = resolveOntologyFor(v2.ontologyProfile);
  // 领域类：custom 类标注父类挂载点，base 类直接列名
  const classLine = (v2.domainClasses || []).map((c) => {
    const nm = c.label || c.key;
    const base = c.from === 'base';
    const parentTag = !base && c.parent ? `⊂${c.parent}` : '';
    return `${nm}${parentTag}${c.desc ? `（${c.desc}）` : ''}${base ? '' : '〔领域〕'}`;
  }).join('、') || '无';
  const predLine = (v2.domainPredicates || []).map((p) => {
    const sig = p.domain && p.range ? `（${p.domain}→${p.range}）` : '';
    return `${p.label || p.key}${sig}`;
  }).join('、') || '无';
  const consLine = (v2.constraints || []).map((c) => c.desc || `${c.subject}.${c.attr} ${c.op} ${c.value}`).join('；') || '无';
  return [
    `=== 领域模版：${v2.name}（${v2.id}） ===`,
    `绑定体系：${onto.name}（${v2.ontologyProfile}）`,
    `领域描述：${v2.desc || '无'}`,
    `领域类（挂在体系类树上）：${classLine}`,
    `领域谓词：${predLine}`,
    `领域约束：${consLine}`,
    `必须提取：${(v2.mustExtract || []).join('、') || '无'}`,
    `忽略内容：${(v2.ignoreContent || []).join('、') || '无'}`,
    `质量标准：${v2.quality || '无'}`,
    `核心页面骨架：${pairs(v2.skeleton, 'title', 'desc')}`,
    '吸收要求：按上述领域类组织节点（领域类优先归入其父类对应的体系类）；「必须提取」的信息不得遗漏，「忽略内容」不写入页面；关系优先使用领域谓词；产物满足质量标准并参考核心页面骨架组织章节。',
  ].join('\n');
}

// AI 自动生成：按名称与描述补全模版 ID、关键词、实体/概念类型与提取规则
// onDelta(delta, isReasoning) 可选：流式增量回调，供渲染层实时打印生成过程
async function generateTemplate(settings, { name, desc }, onDelta) {
  if (!trimStr(name, 100)) throw new Error('请先填写名称');
  const prompt = [
    '你是知识库领域建模专家。请为下述知识领域设计一个「领域模版」，用于指导 AI 从该领域文档中抽取结构化知识。',
    '',
    `领域名称：${trimStr(name, 100)}`,
    `领域描述：${trimStr(desc) || '（无，请按名称推断）'}`,
    '',
    '只输出一个 JSON 对象，不要输出其他任何内容：',
    '{',
    '  "id": "与该领域语义对应的英文标识符（小写字母/数字/下划线，字母开头；应是领域名称的英文翻译或缩写，例如领域“樱桃种植”对应 cherry_planting；严禁照抄本示例）",',
    '  "ontologyProfile": "建议绑定的顶层本体体系，三选一：bfo-lite（通用轻量，默认）/ bfo（科研严谨）/ iso15926（工业设备）",',
    '  "keywords": ["用于领域匹配的中文关键词，5-8 个"],',
    '  "domainClasses": [ { "label": "领域类中文名", "parent": "父类（体系类 key，实物体用 object，信息/概念用 information）", "desc": "一句话说明" } ],',
    '  "domainPredicates": [ { "label": "领域谓词中文名", "domain": "主语类", "range": "宾语类" } ],',
    '  "mustExtract": ["必须提取的信息点，3-6 条"],',
    '  "ignoreContent": ["应忽略的内容，2-4 条"],',
    '  "quality": "对页面内容的质量要求（一段话）",',
    '  "skeleton": [ { "title": "核心页面标题", "desc": "页面职责说明" } ]',
    '}',
    '要求：id 必须与领域名称语义一致；domainClasses 5-8 个，parent 只能是 object（具体的人/物/组织/工具）或 information（概念/文档/方法等抽象信息）；domainPredicates 0-4 个；skeleton 3-5 个页面；全部使用中文（id 除外）。',
  ].join('\n');
  const answer = await chatOnce(settings, [
    { role: 'system', content: getPrompt(settings, 'tplGenPrompt') },
    { role: 'user', content: prompt },
  ], undefined, onDelta);
  const raw = extractJson(answer);
  // 防模型照抄提示词示例/泛占位：命中时回退为时间戳 id（用户可在弹窗中修改）
  let id = /^[A-Za-z][A-Za-z0-9_]*$/.test(trimStr(raw.id, 60)) ? trimStr(raw.id, 60) : '';
  if (!id || /^(rental_service|example|domain|test|demo)$/.test(id)) id = 'domain_' + Date.now().toString(36);
  const profileId = ['bfo-lite', 'bfo', 'iso15926'].includes(trimStr(raw.ontologyProfile, 60)) ? trimStr(raw.ontologyProfile, 60) : 'bfo-lite';
  const domainClasses = (Array.isArray(raw.domainClasses) ? raw.domainClasses : [])
    .map((c) => ({
      key: trimStr(c.label, 60), label: trimStr(c.label, 100),
      parent: ['object', 'information'].includes(trimStr(c.parent, 60)) ? trimStr(c.parent, 60) : 'object',
      desc: trimStr(c.desc, 300), examples: [], from: 'custom',
    }))
    .filter((c) => c.key);
  return {
    id,
    ontologyProfile: profileId,
    keywords: toList(raw.keywords),
    domainClasses,
    domainPredicates: toPredicates(raw.domainPredicates),
    constraints: [],
    mustExtract: toList(raw.mustExtract),
    ignoreContent: toList(raw.ignoreContent),
    quality: trimStr(raw.quality),
    skeleton: toPairs(raw.skeleton, 'title', 'desc'),
  };
}

// 吸收前自动建模第一步：根据来源内容归纳领域名称与简述，供「新建领域模版」弹窗自动填充（随后由弹窗内 AI 生成补全其余字段）
async function suggestTemplateName(settings, raws) {
  const text = (raws || []).map((r) => r.content).join('\n').slice(0, 3000);
  if (!text.trim()) throw new Error('来源内容为空，无法归纳领域名称');
  const prompt = [
    '你是知识库领域建模专家。下方是用户正要吸收进知识库的来源内容摘录。',
    '请归纳这些内容所属的知识领域，输出一个适合建立「领域模版」的名称与简述。',
    '要求：名称 2-8 个汉字，是一个内聚的领域（如“樱桃种植”“产品发布”），避免过于宽泛（如“文档”“知识”）。',
    '',
    '只输出一个 JSON 对象，不要输出其他任何内容：',
    '{ "name": "领域中文名", "desc": "一句话领域描述" }',
    '',
    '=== 来源内容摘录 ===',
    text,
  ].join('\n');
  const answer = await chatOnce(settings, [
    { role: 'system', content: getPrompt(settings, 'tplGenPrompt') },
    { role: 'user', content: prompt },
  ]);
  const raw = extractJson(answer);
  const name = trimStr(raw.name, 100);
  if (!name) throw new Error('未能从来源内容归纳出领域名称');
  return { name, desc: trimStr(raw.desc, 500) };
}

// 智能生成：分析全部笔记 + 管理的原始文件，产出候选领域模版（数组）
async function suggestTemplates(settings) {
  // 延迟 require 避免与 notes 的循环依赖
  const notesStore = require('../notes/store');
  const raws = require('../raws/raws');
  const { readRawText } = require('../raws/files');
  const parts = [];
  for (const n of notesStore.getNotes()) {
    if ((n.content || '').trim() || (n.title || '').trim()) {
      parts.push(`笔记·${n.title || n.id}\n${String(n.content || '').slice(0, 300)}`);
    }
  }
  for (const r of raws.listRaws(settings)) {
    let txt = '';
    try { txt = (await readRawText(settings, r.path)) || ''; } catch (_) {}
    parts.push(`原始·${r.name}\n${String(txt).slice(0, 300)}`);
  }
  if (!parts.length) throw new Error('暂无笔记或原始文件，无法生成候选模版');
  const corpus = parts.join('\n\n').slice(0, 6000);
  const prompt = [
    '你是知识库领域建模专家。下面是一位用户知识库中的全部笔记与原始文件摘录。',
    '请分析这些内容的主题分布，归纳出 1-3 个「候选领域模版」，用于指导 AI 按领域抽取结构化知识。',
    '要求：每个模版对应一个清晰、内聚的知识领域；若内容单一只输出 1 个；全部使用中文（id 除外）。',
    '',
    '只输出一个 JSON 对象，不要输出其他任何内容：',
    '{ "templates": [ {',
    '  "id": "英文标识符（小写字母/数字/下划线，字母开头）",',
    '  "name": "领域中文名",',
    '  "desc": "领域简要描述",',
    '  "keywords": ["中文关键词 5-8 个"],',
    '  "ontologyProfile": "bfo-lite | bfo | iso15926 三选一（通用/科研工程/工业资产）",',
    '  "domainClasses": [ { "label": "领域类中文名", "parent": "object 或 information", "desc": "一句话说明" } ],',
    '  "domainPredicates": [ { "label": "领域谓词", "domain": "主语类中文", "range": "宾语类中文" } ],',
    '  "mustExtract": ["3-6 条"],',
    '  "ignoreContent": ["2-4 条"],',
    '  "quality": "一段话",',
    '  "skeleton": [ { "title": "", "desc": "" } ]',
    '} ] }',
    '',
    '要求：domainClasses 4-6 个，parent 只能是 object（具体的人/物/组织/工具）或 information（概念/文档/方法等抽象信息）；domainPredicates 0-3 个。',
    '',
    '=== 知识库内容摘录 ===',
    corpus,
  ].join('\n');
  const answer = await chatOnce(settings, [
    { role: 'system', content: getPrompt(settings, 'tplGenPrompt') },
    { role: 'user', content: prompt },
  ]);
  const raw = extractJson(answer);
  const arr = Array.isArray(raw.templates) ? raw.templates : (Array.isArray(raw) ? raw : []);
  return arr
    .filter((t) => t && (t.name || t.id))
    .map((t) => ({
      id: /^[A-Za-z][A-Za-z0-9_]*$/.test(trimStr(t.id, 60)) ? trimStr(t.id, 60) : '',
      name: trimStr(t.name, 100),
      desc: trimStr(t.desc),
      keywords: toList(t.keywords),
      ontologyProfile: ['bfo-lite', 'bfo', 'iso15926'].includes(trimStr(t.ontologyProfile, 60)) ? trimStr(t.ontologyProfile, 60) : 'bfo-lite',
      domainClasses: (Array.isArray(t.domainClasses) ? t.domainClasses : [])
        .map((c) => ({
          key: trimStr(c.label, 60), label: trimStr(c.label, 100),
          parent: ['object', 'information'].includes(trimStr(c.parent, 60)) ? trimStr(c.parent, 60) : 'object',
          desc: trimStr(c.desc, 300), examples: [], from: 'custom',
        }))
        .filter((c) => c.key),
      domainPredicates: toPredicates(t.domainPredicates),
      constraints: [],
      mustExtract: toList(t.mustExtract),
      ignoreContent: toList(t.ignoreContent),
      quality: trimStr(t.quality),
      skeleton: toPairs(t.skeleton, 'title', 'desc'),
    }));
}

module.exports = { listTemplates, saveTemplate, removeTemplate, matchPrompt, matchTemplate, preMatchTemplate, templateGuidance, generateTemplate, suggestTemplateName, suggestTemplates };
