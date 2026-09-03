// 领域模版领域层：模版存储（SQLite kv）、AI 自动生成、图谱抽取前的领域匹配与类型约束
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


// ---------- 模版 v2：体系绑定 + 领域类/谓词/约束 ----------
// 解析指定 profile 的合成本体（延迟 require 避免与 graph.js 的加载顺序耦合）
function resolveOntologyFor(profileId) {
  const graph = require('./graph');
  try { return graph.resolveOntology(profileId); } catch (_) { return graph.resolveOntology('bfo-lite'); }
}

// domainClasses 归一化
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
  // 运行时补充体系中文名（不持久化）：弹窗/列表直接展示「体系名（id）」
  for (const t of list) {
    if (t && typeof t === 'object') {
      try { t.profileName = resolveOntologyFor(t.ontologyProfile || 'bfo-lite').name; } catch (_) { /* 忽略 */ }
    }
  }
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
  next.profileName = onto.name; // 运行时展示字段：体系中文名（listTemplates 不经过本函数，读取方需要时按 ontologyProfile 自查）
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
    '3. similarity 为 0-100 的整数，表示来源内容与所选模版的相似程度（100 完全契合，0 毫不相关）；选 general 时给 0；',
    '4. 只输出一个 JSON 对象，不要输出其他任何内容：{"template": "<模版ID>", "similarity": <0-100>, "reason": "一句话判定理由"}',
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
  // 轻量判定场景：限制 thinking 预算避免思考型模型在领域匹配这种一句话判定上耗费分钟级 thinking
  const matchSettings = { ...(settings || {}), thinkingBudget: (settings && settings.thinkingBudget) || 4000 };
  try {
    const prompt = matchPrompt(list).replace('{{SOURCE_EXCERPT}}', text || '（空）');
    const answer = await chatOnce(matchSettings, [
      { role: 'system', content: getPrompt(settings, 'matchPrompt') },
      { role: 'user', content: prompt },
    ], opts.retries, opts.onDelta, opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined);
    const parsed = extractJson(answer);
    const picked = list.find((t) => t.id === parsed.template);
    const similarity = Math.max(0, Math.min(100, parseInt(parsed.similarity, 10) || 0));
    if (picked) { if (opts.onPick) opts.onPick(trimStr(parsed.reason, 200), similarity); picked._similarity = similarity; return picked; }
    // 模型给了非法 id：把原始返回带给调用方，便于进度流展示
    if (opts.onPick) opts.onPick('模型返回了未注册的领域 id「' + trimStr(parsed.template, 60) + '」，回退关键词匹配', 0);
  } catch (err) {
    // LLM 匹配失败（含超时）走关键词兜底，绝不阻断调用方的后续提交
    if (opts.onDegrade) opts.onDegrade(err);
  }
  const fb = matchByKeywords(list, text);
  if (opts.onPick && fb && fb.id !== 'general') {
    const hits = (fb.keywords || []).filter((k) => k && text.includes(k));
    fb._similarity = Math.min(100, hits.length * 20); // 关键词兜底：每命中一个词计 20 分
    opts.onPick('关键词命中：' + (hits.join('、') || '无'), fb._similarity);
  }
  return fb;
}

// 提取前的领域预匹配：返回命中的特定领域模版；未命中（含 LLM/关键词均判定为 general）返回 null，
// 由渲染层据此询问用户“新建领域模版还是用通用模版”
// degraded=true 表示 LLM 判定失败/超时、结果来自关键词兜底
async function preMatchTemplate(settings, raws, opts = {}) {
  const list = listTemplates();
  const hasSpecific = list.some((t) => t.id !== 'general');
  if (!hasSpecific) return { matched: null, hasSpecific, total: list.length };
  let degradeErr = null;
  let pickReason = '';
  let similarity = 0;
  const tpl = await matchTemplate(settings, raws, { ...opts, onDegrade: (err) => { degradeErr = err; }, onPick: (r, s) => { pickReason = r || ''; similarity = s || 0; } });
  const matched = tpl && tpl.id !== 'general' ? { id: tpl.id, name: tpl.name, reason: pickReason, similarity } : null;
  // 超时中断在 llm 层报为“已停止回答”，对预检查场景改写成用户能看懂的超时描述
  const degradeMsg = !degradeErr ? ''
    : (degradeErr.name === 'AbortError' && opts.timeoutMs ? `模型未在 ${Math.round(opts.timeoutMs / 1000)} 秒内响应` : degradeErr.message);
  return { matched, hasSpecific, total: list.length, degraded: !!degradeErr, degradeError: degradeMsg, reason: pickReason };
}

// AI 自动生成：按名称与描述补全模版 ID、关键词、体系绑定与领域类
// onDelta(delta, isReasoning) 可选：流式增量回调，供渲染层实时打印生成过程
// 领域类 parent 必须是所选体系类树中真实存在的 key（各体系类树差异巨大）：
// 先生成 ontologyProfile，再用该体系的类树细节做第二次调用生成领域类，避免硬编码 bfo-lite 的 object/information。
// 各体系的「实体父类 / 概念父类」候选（领域类 parent 从中二选一，取体系内最具概括性的两个挂点）
const PROFILE_PARENT_HINTS = {
  'bfo-lite': { entity: 'object', concept: 'information' },
  bfo: { entity: 'object', concept: 'generically_dependent_continuant' },
  iso15926: { entity: 'physical_object', concept: 'class_of_individual' },
};
async function generateTemplate(settings, { name, desc }, onDelta) {
  if (!trimStr(name, 100)) throw new Error('请先填写名称');
  // 第一步：选体系 + 生成 id / keywords（不带领域类，体系选择不受类树干扰）
  const prompt1 = [
    '你是知识库领域建模专家。请为下述知识领域设计「领域模版」的标识与体系绑定。',
    '',
    `领域名称：${trimStr(name, 100)}`,
    `领域描述：${trimStr(desc) || '（无，请按名称推断）'}`,
    '',
    '只输出一个 JSON 对象，不要输出其他任何内容：',
    '{',
    '  "id": "与该领域语义对应的英文标识符（小写字母/数字/下划线，字母开头；应是领域名称的英文翻译或缩写，例如领域“樱桃种植”对应 cherry_planting；严禁照抄本示例）",',
    '  "ontologyProfile": "建议绑定的顶层本体体系，三选一：bfo-lite / bfo / iso15926",',
    '  "keywords": ["用于领域匹配的中文关键词，5-8 个"]',
    '}',
    '要求：id 必须与领域名称语义一致；全部使用中文（id 除外）。',
    '',
    'ontologyProfile 选择要点：',
    '- 日常办公 / 通用文档 / 产品说明 / 流程步骤 / 会议纪要 → bfo-lite',
    '- 科研文献 / 实验报告 / 学术论文 / 严谨推理 → bfo',
    '- 工业设备运维 / 工厂产线 / 质量检测流程 / 设备生命周期管理 / 工程数据集成 → iso15926',
    '- 若领域同时涉及「质量检测/试验方法/工艺流程」与「设备/仪器」，优先 iso15926',
  ].join('\n');
  const answer1 = await chatOnce(settings, [
    { role: 'system', content: getPrompt(settings, 'tplGenPrompt') },
    { role: 'user', content: prompt1 },
  ], undefined, onDelta);
  const raw1 = extractJson(answer1);
  let id = /^[A-Za-z][A-Za-z0-9_]*$/.test(trimStr(raw1.id, 60)) ? trimStr(raw1.id, 60) : '';
  if (!id || /^(rental_service|example|domain|test|demo)$/.test(id)) id = 'domain_' + Date.now().toString(36);
  const profileId = ['bfo-lite', 'bfo', 'iso15926'].includes(trimStr(raw1.ontologyProfile, 60)) ? trimStr(raw1.ontologyProfile, 60) : 'bfo-lite';
  const keywords = toList(raw1.keywords);

  // 第二步：把所选体系的类树细节注入 prompt，让领域类 parent 从真实类树中选
  const onto = resolveOntologyFor(profileId);
  const hints = PROFILE_PARENT_HINTS[profileId] || PROFILE_PARENT_HINTS['bfo-lite'];
  const entityOk = (onto.classes || []).some((c) => c.key === hints.entity);
  const conceptOk = (onto.classes || []).some((c) => c.key === hints.concept);
  const entityParent = entityOk ? hints.entity : (onto.fallbackType || 'object');
  // 概念父类：优先提示值，缺失时回退到体系内含 information/class 语义的类，再不行用 entityParent
  let conceptParent = conceptOk ? hints.concept : '';
  if (!conceptParent) {
    const infoCls = (onto.classes || []).find((c) => /information|class_of_individual|generically_dependent/.test(c.key));
    conceptParent = infoCls ? infoCls.key : entityParent;
  }
  const classLine = (onto.classes || []).map((c) => `${c.key}(${c.label}${c.desc ? '：' + c.desc : ''})`).join('、');
  const prompt2 = [
    `你是知识库领域建模专家。已确定领域「${trimStr(name, 100)}」绑定顶层本体体系「${onto.name}」。`,
    `领域描述：${trimStr(desc) || '（无）'}`,
    '',
    `该体系的类树（key(中文名：说明)）：${classLine}`,
    '',
    '请为该领域设计 5-8 个领域类，每个领域类挂载到上述体系类树中合适的父类下。只输出一个 JSON 对象：',
    '{ "domainClasses": [ { "label": "领域类中文名", "parent": "父类的体系类 key", "desc": "一句话说明" } ] }',
    '',
    `要求：`,
    `- parent 只能从上述类树的 key 中选，且只能是代表「具体实体」的 ${entityParent} 或代表「抽象概念/标准/规范/信息」的 ${conceptParent}；`,
    `- 具体的人/物/组织/设备/工具/产品用 ${entityParent}；概念/标准/规范/方法/规则/文档等抽象信息用 ${conceptParent}；`,
    '- 领域类之间尽量正交（不重叠）；全部使用中文。',
  ].join('\n');
  const answer2 = await chatOnce(settings, [
    { role: 'system', content: getPrompt(settings, 'tplGenPrompt') },
    { role: 'user', content: prompt2 },
  ], undefined, onDelta);
  const raw2 = extractJson(answer2);
  const validKeys = new Set((onto.classes || []).map((c) => c.key));
  const domainClasses = (Array.isArray(raw2.domainClasses) ? raw2.domainClasses : [])
    .map((c) => {
      const p = trimStr(c.parent, 60);
      // parent 必须是体系类树真实 key，且限定在 entity/concept 两个挂点之一；非法则按内容倾向回退
      const parent = (p === entityParent || p === conceptParent) ? p : (validKeys.has(p) ? p : entityParent);
      return {
        key: trimStr(c.label, 60), label: trimStr(c.label, 100),
        parent, desc: trimStr(c.desc, 300), examples: [], from: 'custom',
      };
    })
    .filter((c) => c.key);
  return {
    id,
    ontologyProfile: profileId,
    profileName: onto.name, // 运行时展示字段：体系中文名
    keywords,
    domainClasses,
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

// 从已有本体定义（内置三体系 + OWL 导入）中按来源内容选出最贴合的体系，返回 { id, name, similarity, reason }
// 体系不再盲从模版上绑定的 ontologyProfile，而是实时按资料内容判定；失败回退 bfo-lite
// 按来源内容从全部可用体系（内置三体系+导入 OWL）实时匹配最贴合的一个
// onDelta(delta, isReasoning) 可选：流式增量回调，供渲染层实时打印 AI 思考过程
async function suggestOntologyProfile(settings, raws, onDelta) {
  const { listProfiles } = require('./graph'); // 惰性 require 避免循环依赖
  const { PROFILE_SCENARIOS } = require('../common/constants');
  const profiles = listProfiles();
  const lines = profiles.map((p) => {
    const scenario = PROFILE_SCENARIOS[p.id] || '';
    return `- ${p.id}（${p.name}）：${p.desc || '无描述'}（含 ${p.counts ? p.counts.classes : 0} 个类）${scenario ? `\n  ${scenario}` : ''}`;
  });
  const text = (raws || []).map((r) => r.content || r.text || '').join('\n').slice(0, 3000);
  const prompt = [
    '你是知识库本体建模专家。下方是待抽取的来源内容摘录，以及当前可用的顶层本体体系清单（含各体系适用场景）。',
    '请依据内容的核心特征，从清单中选出最适合作为本次抽取基座的一个体系。判断要点：',
    '- 内容是日常办公/通用文档/流程说明 → 选 bfo-lite（轻量、中文谓词、分类扁平）',
    '- 内容是科研文献/实验报告/学术推理 → 选 bfo（严谨分类、持续体/发生体二分）',
    '- 内容涉及设备/仪器/产线/质检流程/工程数据 → 选 iso15926（4D 时空观、物理对象/活动/事件）',
    '- 内容是其他专用领域 → 选导入的 OWL 体系（如有）',
    '',
    ...lines,
    '',
    '只输出一个 JSON 对象，不要输出其他任何内容：',
    '{ "profile": "<体系ID>", "similarity": <0-100>, "reason": "为什么选它（一句话，说明内容特征与体系定位的契合点）" }',
    'similarity 为 0-100 整数，表示内容与该体系定位的契合程度。',
    '',
    '=== 来源内容摘录 ===',
    text || '（空）',
  ].join('\n');
  try {
    const answer = await chatOnce(settings, [
      { role: 'system', content: getPrompt(settings, 'tplGenPrompt') },
      { role: 'user', content: prompt },
    ], undefined, onDelta);
    const raw = extractJson(answer);
    const picked = profiles.find((p) => p.id === trimStr(raw.profile, 60));
    if (picked) {
      return { id: picked.id, name: picked.name || picked.id, similarity: Math.max(0, Math.min(100, parseInt(raw.similarity, 10) || 0)), reason: trimStr(raw.reason, 200) };
    }
  } catch (_) { /* 失败回退默认 */ }
  const dft = profiles.find((p) => p.id === 'bfo-lite') || profiles[0];
  return { id: dft.id, name: dft.name || dft.id, similarity: 0, reason: '模型未给出有效选择，回退默认体系' };
}

module.exports = { listTemplates, saveTemplate, removeTemplate, matchPrompt, matchTemplate, preMatchTemplate, generateTemplate, suggestTemplateName, suggestOntologyProfile };
