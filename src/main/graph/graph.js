// 知识图谱领域层：本体层定义、从笔记/原始文件自动抽取、持久化与问答上下文注入
// 存储：整图 JSON 存于 SQLite kv 表（key='graph'），个人知识库图谱规模小，整体读写开销可忽略
const db = require('../common/db');
const notesStore = require('../notes/store');
const { chatOnce, extractJson, streamChat } = require('../ai/llm');
const { num } = require('../common/config');
const { buildTasks } = require('../jobs/tasks');
const { getPrompt, getPromptForProfile } = require('../ai/prompts');

// ---------- 本体层定义（多体系：内置只读基座 + 用户叠加层，kv schema v3） ----------
// ONTOLOGY_KEY / DEFAULT_ONTOLOGY / ONTOLOGY_PROFILES / PROFILE_LIST 定义于 common/constants.js
const { ONTOLOGY_KEY, DEFAULT_ONTOLOGY, ONTOLOGY_PROFILES, PROFILE_LIST } = require('../common/constants');

// 读取并迁移本体 kv（v3：{profileId,userClasses[],userPredicates[],userConstraints[],owlProfiles[]}）
// 旧版（扁平 {classes,predicates,constraints}）整体转入用户层叠加到 bfo-lite，中文谓词 key 原样保留，零数据丢失
function readOntologyKv() {
  let o = null;
  try { o = JSON.parse(db.getKv(ONTOLOGY_KEY) || 'null'); } catch (_) {}
  if (o && o.profileId !== undefined) {
    return {
      profileId: o.profileId || 'bfo-lite',
      userClasses: Array.isArray(o.userClasses) ? o.userClasses : [],
      userPredicates: Array.isArray(o.userPredicates) ? o.userPredicates : [],
      userConstraints: Array.isArray(o.userConstraints) ? o.userConstraints : [],
      owlProfiles: Array.isArray(o.owlProfiles) ? o.owlProfiles : [],
    };
  }
  // v1 扁平结构 → v3：旧 classes/predicates/constraints 视为用户层叠加项
  if (o && Array.isArray(o.classes)) {
    return {
      profileId: 'bfo-lite',
      userClasses: o.classes.map((c) => ({ key: c.key, label: c.label || c.key, parent: '', desc: c.desc || '', examples: c.examples || [], from: 'custom' })),
      userPredicates: (o.predicates || []).map((p) => ({ key: p.key, label: p.key, desc: p.desc || '', from: 'custom' })),
      userConstraints: (o.constraints || []).map((d) => ({ desc: d, from: 'custom' })),
      owlProfiles: [],
      _migrated: true,
    };
  }
  return { profileId: 'bfo-lite', userClasses: [], userPredicates: [], userConstraints: [], owlProfiles: [] };
}

// 合成生效本体：基座（内置或 OWL 导入）+ 用户层（同 key 覆盖）
// profileId 省略时用 kv 当前编辑 profileId；owl:* 从 owlProfiles 查找，缺失回退 bfo-lite
function resolveOntology(profileId) {
  const kv = readOntologyKv();
  let id = profileId || kv.profileId || 'bfo-lite';
  let base = null;
  if (id.startsWith('owl:')) {
    base = (kv.owlProfiles || []).find((p) => p.id === id);
    if (!base) { id = 'bfo-lite'; }
  }
  if (!base) base = ONTOLOGY_PROFILES[id] || ONTOLOGY_PROFILES['bfo-lite'];
  const merged = JSON.parse(JSON.stringify(base));
  merged.id = base.id;
  // 叠加用户层（同 key 覆盖，新增追加）
  for (const uc of kv.userClasses) {
    const i = merged.classes.findIndex((c) => c.key === uc.key);
    if (i >= 0) merged.classes[i] = { ...merged.classes[i], ...uc, from: 'custom' };
    else merged.classes.push({ ...uc, from: 'custom' });
  }
  for (const up of kv.userPredicates) {
    const i = merged.predicates.findIndex((p) => p.key === up.key);
    if (i >= 0) merged.predicates[i] = { ...merged.predicates[i], ...up, from: 'custom' };
    else merged.predicates.push({ ...up, from: 'custom' });
  }
  merged.constraints = [
    ...(merged.constraints || []).map((d) => (typeof d === 'string' ? { desc: d, from: 'base' } : d)),
    ...kv.userConstraints.map((c) => (typeof c === 'string' ? { desc: c, from: 'custom' } : c)),
  ];
  return merged;
}

// 用户层持久化（只写叠加层，内置基座永不落库）
function persistOntologyKv(kv) {
  const clean = {
    profileId: kv.profileId || 'bfo-lite',
    userClasses: kv.userClasses || [],
    userPredicates: kv.userPredicates || [],
    userConstraints: kv.userConstraints || [],
    owlProfiles: kv.owlProfiles || [],
  };
  db.setKv(ONTOLOGY_KEY, JSON.stringify(clean));
  db.flush();
}

// 列出可选体系（内置三体系 + OWL 导入），每项带 类/谓词/约束 计数（体系 tab 徽标用）
function listProfiles() {
  const kv = readOntologyKv();
  const countOf = (src) => ({ classes: (src.classes || []).length, predicates: (src.predicates || []).length, constraints: (src.constraints || []).length, axioms: (src.axioms || []).length });
  const builtins = PROFILE_LIST.map((p) => {
    const src = ONTOLOGY_PROFILES[p.id] || {};
    return { ...p, counts: countOf(src) };
  });
  const owls = (kv.owlProfiles || []).map((p) => ({ id: p.id, name: p.name || p.id, desc: p.desc || 'OWL 导入体系', owl: true, counts: countOf(p) }));
  return [...builtins, ...owls];
}

// 实体类 key → 展示名（按当前生效本体）
function nodeTypesMap(profileId) {
  const m = {};
  for (const c of resolveOntology(profileId).classes) m[c.key] = `${c.label}（${c.desc || ''}）`;
  return m;
}

function relationsList(profileId) {
  return resolveOntology(profileId).predicates.map((p) => p.key);
}

// 类型/谓词回退值（按当前生效本体的 fallback）
function fallbackType(profileId) {
  const o = resolveOntology(profileId);
  const keys = o.classes.map((c) => c.key);
  return keys.includes(o.fallbackType) ? o.fallbackType : (keys[0] || 'object');
}
function fallbackRel(profileId) {
  const o = resolveOntology(profileId);
  const rels = o.predicates.map((p) => p.key);
  return rels.includes(o.fallbackRel) ? o.fallbackRel : (rels[0] || '相关');
}

const GRAPH_KEY = 'graph';
// 推理元数据独立存一个 kv 键（设计文档 §5.4）：图谱本体与推理状态分离，
// 清图谱时一并清掉，避免「图已空但仍显示上次推理时间」的错觉。
const GRAPH_META_KEY = 'graph.meta';
// 单批送入模型的语料上限（字符），控制 token 与抽取质量
const BATCH_CHARS = 6000;
// 单个来源截断长度，避免超长页面挤占批次
const SOURCE_CHARS = 1500;

// ---------- 推理层（reason/ 子目录，设计文档 §3–§5） ----------
// 惰性 require：protege-js 缺失或 reason 层损坏时，图谱的抽取/问答主链路必须照常工作
// （§9 风险 1/2：推理是增强项，不是前置依赖）。
let _reason = null;
let _reasonError = '';
function reason() {
  if (_reason) return _reason;
  if (_reasonError) return null;
  try {
    _reason = {
      infer: require('./reason/infer'),
      guard: require('./reason/guard'),
      impact: require('./reason/impact'),
      bridge: require('./reason/bridge'),
      owlImport: require('./reason/owlImport'),
      ontologyBundle: require('./reason/ontologyBundle'),
      profile: require('./reason/profile'),
      validate: require('./reason/validate'),
      repair: require('./reason/repair'),
      dl: require('./reason/dl'),   // dl-js-reasoner 适配层（融合设计 §4.5 改动点 1）
    };
  } catch (err) {
    _reasonError = String((err && err.message) || err);
    _reason = null;
  }
  return _reason;
}
/** 推理层是否可用（含 protege-js 是否装好）。不可用时所有推理入口静默降级。 */
function reasonReady() {
  const r = reason();
  return !!(r && r.infer && typeof r.infer.reasonerAvailable === 'function' && r.infer.reasonerAvailable());
}
/** 推理层不可用的原因（供 UI 显示，而不是静默失效）。 */
function reasonUnavailableReason() {
  if (_reasonError) return `推理模块加载失败：${_reasonError}`;
  const r = reason();
  if (!r) return '推理模块不可用';
  if (!r.infer || typeof r.infer.reasonerAvailable !== 'function') return '推理模块接口不完整';
  if (!r.infer.reasonerAvailable()) return 'protege-js 未安装或加载失败，本地推理不可用';
  return '';
}
/**
 * DL 推理层（dl-js-reasoner）是否可用（融合设计 §4.5 改动点 1）。
 * 与 reasonReady 独立：DL 缺失不影响 RL 主链路（I5/D6），仅供 UI 区分展示。
 */
function reasonDlReady() {
  const r = reason();
  return !!(r && r.dl && typeof r.dl.dlAvailable === 'function' && r.dl.dlAvailable());
}
/** DL 推理层不可用的原因（供 UI 显示）。 */
function reasonDlUnavailableReason() {
  const r = reason();
  if (!r) return '推理模块不可用';
  if (!r.dl || typeof r.dl.dlAvailable !== 'function') return 'DL 适配层接口不完整';
  if (!r.dl.dlAvailable()) {
    const e = typeof r.dl.dlError === 'function' ? r.dl.dlError() : '';
    return `dl-js-reasoner 未安装或加载失败${e ? `：${e}` : ''}`;
  }
  return '';
}

// materializeGraph 的 skipReason → 面向用户的人话（作业阶段行/推理 Tab 共用）
// 8 个 dl-* 码来自 dl-js-reasoner 融合设计 §4.5 改动点 2（T1-b：7 → 15 键）。
// ⚠️ 这里必须覆盖 dl.js 能产出的**全部**码（gateScale 2 个 + classifyError 4 个 +
//    reasonABox 的 dl-no-abox + 适配层的 dl-unavailable），漏一个就会把英文码直接展示给用户。
const SKIP_REASON_TEXT = {
  'reasoner-unavailable': 'protege-js 不可用，无法本地推理',
  'empty-graph': '图谱为空，无内容可推理',
  'bridge-failed': '图谱桥接为三元组失败',
  'no-rule-fuel': '该体系没有传递/对称/互逆/domain/range/类层级声明，推理不会产生新边',
  'aborted': '已被用户中止',
  'materialize-failed': '物化过程出错',
  'timeout': '推理超时（已保留原始图谱，可在设置中调大超时）',
  'dl-too-large': '本体规模超出 DL 推理上限，已跳过深度推理',
  'dl-abox-budget': 'ABox 规模超出 DL 预算，仅做 TBox 级推理',
  'dl-non-horn': '本体非 Horn，合取查询不可用（一致性/分类仍可用）',
  'dl-timeout': 'DL 推理超时，已中断（保留原始图谱）',
  'dl-unavailable': 'dl-js-reasoner 未安装或加载失败',
  'dl-irregular': '属性层级不正则（循环依赖），DL 推理不可用',
  'dl-error': 'DL 推理出错（已保留原始图谱，详见推理日志）',
  'dl-no-abox': '该体系无实例数据，DL 只做 TBox 级推理',
};

/** 总开关：settings.reasonEnabled，默认开（设计文档 §6.11 / §11 开放问题 2 倾向默认开）。 */
function reasonEnabled(settings) {
  if (!reasonReady()) return false;
  const v = settings && settings.reasonEnabled;
  return v === undefined || v === null || v === '' ? true : !!v;
}
/** 推理超时（秒）：settings.reasonTimeout，默认 30，范围 5–120（§6.11）。 */
function reasonTimeoutSec(settings) {
  return num(settings || {}, 'reasonTimeout', 30, 5, 120);
}

// ---------------------------------------------------------------------------
// DL 深度推理配置（dl-js-reasoner 融合设计 §12：设置页 UI）
//
// 三个纯函数，全部只读 settings，不碰 kv、不碰推理层，因此可在任何降级态下安全调用。
// 口径与 reasonEnabled 完全一致：「未显式关闭即开启」，且推理层不可用时连带为 false。
//
// ⚠️ dlLimitsFromSettings 的返回对象**只含 dl.js:DL_LIMITS 的 5 个既有键名**，
//    绝不新增键（test/graph-dl.test.js:172-173 对 DL_LIMITS 的形状与默认值有硬断言）。
//    min/max 必须与 src/renderer/constants.js 的 NUM_SETTING_FIELDS 逐字一致，
//    否则会出现「设置里能填但主进程静默钳回」。
// ---------------------------------------------------------------------------

/** DL 深度推理开关：settings.dlEnabled，默认开；推理层不可用时连带为 false。 */
function dlEnabled(settings) {
  if (!reasonDlReady()) return false;
  const v = settings && settings.dlEnabled;
  return v === undefined || v === null || v === '' ? true : !!v;
}

/** 是否默认执行 ABox 级深度扫描：settings.dlDeep，默认关（D4 成本控制）。 */
function dlDeepDefault(settings) {
  return !!(settings && settings.dlDeep);
}

/**
 * settings → dl.js 规模门控阈值（DL_LIMITS 的 5 个键，逐项钳制）。
 * 留空/非法的项**不出现在返回对象里**，由 gateScale 的 `{...DL_LIMITS, ...limits}` 回落默认值 —— 这样
 * 「用户只改了一项」时其余四项永远跟随代码里的默认值，不会把旧版本落盘的过期数值钉死。
 * @param {object} [settings]
 * @returns {object} DL_LIMITS 键名的子集（0–5 个键）
 */
function dlLimitsFromSettings(settings) {
  const s = settings || {};
  const out = {};
  // [settings 键, DL_LIMITS 键, 默认值, min, max] —— 默认值只为可读性，实际回落发生在 gateScale
  const MAP = [
    ['dlMaxClasses', 'maxClasses', 2000, 10, 20000],
    ['dlAboxBudget', 'aboxBudget', 20000, 0, 100000000],
    ['dlTransitiveCap', 'transitiveIndividualCap', 80, 0, 100000],
    ['dlMaxAxioms', 'maxDlAxioms', 600, 0, 100000],
    ['dlMaxEdges', 'maxInferredEdges', 5000, 0, 1000000],
  ];
  for (const [sk, lk, , min, max] of MAP) {
    const raw = s[sk];
    if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) continue;
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    out[lk] = Math.min(max, Math.max(min, Math.round(v)));
  }
  return out;
}

/**
 * DL 生效配置快照（供设置页状态行与「推理」Tab 的 DL 区块展示，避免前端硬编码默认值漂移）。
 * 嵌套在 coverage.dl 下返回，不新增任何顶层键（getReasonState 11 键 / reasonStatus 5 键硬契约不变）。
 */
function dlConfigSnapshot(settings) {
  const s = settings || readSettingsSafe();
  const R = reason();
  const D = (R && R.dl && R.dl.DL_LIMITS) || null;
  const limits = dlLimitsFromSettings(s);
  const merged = { ...(D || {}), ...limits };
  return {
    ready: reasonDlReady(),
    unavailableReason: reasonDlReady() ? '' : reasonDlUnavailableReason(),
    enabled: dlEnabled(s),
    deepDefault: dlDeepDefault(s),
    // 运行时实际生效值（默认值来自主进程，前端不必再抄一份）
    limits: merged,
    // 用户是否显式覆盖过（前端据此标注「已自定义」）
    customized: Object.keys(limits),
    timeoutSec: reasonTimeoutSec(s),
  };
}

// ---------- 推理元数据（kv 'graph.meta'） ----------
function getGraphMeta() {
  try {
    const m = JSON.parse(db.getKv(GRAPH_META_KEY) || 'null');
    if (!m || typeof m !== 'object') return { lastInferredAt: 0, inferredStale: false, lastStats: null, lastGuard: null };
    return {
      lastInferredAt: Number(m.lastInferredAt) || 0,
      inferredStale: !!m.inferredStale,
      lastStats: m.lastStats || null,
      lastGuard: m.lastGuard || null,
    };
  } catch (_) {
    return { lastInferredAt: 0, inferredStale: false, lastStats: null, lastGuard: null };
  }
}

function setGraphMeta(patch) {
  const m = Object.assign(getGraphMeta(), patch || {});
  db.setKv(GRAPH_META_KEY, JSON.stringify(m));
  db.flush();
  return m;
}

// ---------- 持久化 ----------
function getGraph() {
  try {
    const raw = db.getKv(GRAPH_KEY);
    if (!raw) return { nodes: [], edges: [], updatedAt: 0 };
    const g = JSON.parse(raw);
    return { nodes: Array.isArray(g.nodes) ? g.nodes : [], edges: Array.isArray(g.edges) ? g.edges : [], updatedAt: g.updatedAt || 0 };
  } catch (_) {
    return { nodes: [], edges: [], updatedAt: 0 };
  }
}

function saveGraph(nodes, edges) {
  db.setKv(GRAPH_KEY, JSON.stringify({ nodes, edges, updatedAt: Date.now() }));
  db.flush();
}

function clearGraph() {
  db.setKv(GRAPH_KEY, JSON.stringify({ nodes: [], edges: [], updatedAt: Date.now() }));
  // §5.4：清图谱同时清推理元数据，避免残留「上次推理时间/护栏日志」误导 UI
  db.setKv(GRAPH_META_KEY, JSON.stringify({ lastInferredAt: 0, inferredStale: false, lastStats: null, lastGuard: null }));
  // 修复撤销点也一并清掉：图都清空了，恢复旧快照只会「复活」整张图
  try { db.setKv(REPAIR_UNDO_KEY, ''); } catch (_) { /* 键不存在时忽略 */ }
  db.flush();
  return { ok: true };
}

function nodeKey(name) {
  return String(name || '').trim().toLowerCase();
}

// ---------- 语料收集 ----------
// 集合范围：读全量笔记 store（原始来源/内联来源由 extractGraph 另走专用分支）
function collectSources() {
  const sources = [];
  for (const n of notesStore.getNotes()) {
    const text = `# ${n.title}\n${n.content || ''}`.slice(0, SOURCE_CHARS);
    if (text.trim()) sources.push({ label: '笔记·' + (n.title || n.id), text });
  }
  return sources;
}

// ---------- 语料流水线适配层（设计 §7.5 / §14 三期）----------
// settings.pipeline 为真时，extractGraph 改走可组合的装饰器流水线，返回与现状**逐字段等价**的
// 10 字段结果（§12.1 硬契约）；为假时完全走下方老实现（G8 零行为变更开关）。
//
// 为什么分「收集相 / 抽取相」两次 drive：领域归纳（resolveDomain）需要**全部来源文本**才能跑，
// 而拉取式流是惰性的。故先 drive 收集相把来源解析成文本（顺带走解析缓存），归纳领域后再 drive
// 抽取相（ArraySource 重放已解析项 → enrich 定领域/体系 → corpusWrite 落盘 → chunk → extract → guard → merge）。
// 老实现同样是「先 collectSources 收齐、再 resolveDomain、再分批抽取」，两相拆分与之同构。
async function extractGraphViaPipeline(settings, opts, onStage, onProgress, onTasks) {
  const {
    rawPaths, inlineSources, typeHints, domainLabel, domainId,
    resolveDomain, ontologyProfile, signal, taskFilter, autoReason: autoReasonOpt, corpusRels,
    onLog, onParseStart, onParseEnd, onSkip,
  } = opts || {};
  const { drive, makeContext } = require('../corpus/drive');
  const { buildPipeline } = require('../corpus/build');
  const { GRAPH_COLLECT_RECIPE, GRAPH_EXTRACT_RECIPE } = require('../corpus/recipes');
  const { buildTasks } = require('../jobs/tasks');
  const stage = (key, detail) => { if (onStage) { try { onStage(key, detail); } catch (_) { /* 忽略 */ } } };

  // ---- 收集相：Source → 解析（MinerU/技能/内置 + 缓存），把带 text 的 items 收进数组 ----
  // onLog/onParseStart/onParseEnd 由作业层注入：解析日志进「解析过程」面板，
  // 每条来源开始/结束解析时标定对应任务行（否则收集阶段任务列表全是 pending，看不出在跑哪一条）
  const collected = [];
  const collectCtx = makeContext({
    settings, signal,
    rawPaths: (Array.isArray(rawPaths) && rawPaths.length) ? rawPaths : undefined,
    inlineSources: (Array.isArray(inlineSources) && inlineSources.length) ? inlineSources : undefined,
    corpusRels: (Array.isArray(corpusRels) && corpusRels.length) ? corpusRels : undefined,
    onLog: typeof onLog === 'function' ? onLog : undefined,
    onParseStart: typeof onParseStart === 'function' ? onParseStart : undefined,
    // 被过滤丢弃的条目（无可用解析器/空文本等）：作业层据此把任务行标为失败，不再停在 pending
    onSkip: typeof onSkip === 'function' ? onSkip : undefined,
    onStage: (key, status, detail) => stage(key, detail),
    onItem: (item) => {
      collected.push(item);
      if (typeof onParseEnd === 'function') { try { onParseEnd(item); } catch (_) { /* 忽略 */ } }
    },
    shared: {},
  });
  await drive(buildPipeline(GRAPH_COLLECT_RECIPE, collectCtx), collectCtx);
  // 解析失败/被过滤的来源不会到达 onItem：把失败原因回传给作业层，任务行不再永远停在「解析中…」
  if (typeof onParseEnd === 'function') {
    for (const e of (collectCtx.errors || [])) { try { onParseEnd(null, e); } catch (_) { /* 忽略 */ } }
  }

  // 空来源校验（≡ 老实现 graph.js:278/286/290 的三分支报错口径）
  const items = collected.filter((it) => String(it.text || '').trim());
  if (!items.length) {
    if (Array.isArray(corpusRels) && corpusRels.length) throw new Error('语料 Markdown 内容为空或文件不存在，无法抽取');
    if (Array.isArray(inlineSources) && inlineSources.length) throw new Error('笔记内容为空，无法抽取');
    if (Array.isArray(rawPaths) && rawPaths.length) throw new Error('原始来源内容为空或不存在');
    throw new Error('选定范围内没有可抽取的内容（笔记为空）');
  }

  // ---- 任务列表（P13：以来源为单位，不随分块变化）----
  const tasks = buildTasks(items.map((it) => it.label));
  items.forEach((it, i) => {
    if (it.kind !== 'corpus') return;
    // 当前输入是语料 Markdown；原文出处单独留档，不改写 origin 或语料指纹。
    const origin = it.origin || {};
    const hasOrigin = origin.path && !String(origin.path).startsWith('corpus:');
    tasks[i].source = {
      kind: 'corpus',
      path: it.meta.corpusFile,
      originName: hasOrigin ? String(origin.name || '') : '',
      originPath: hasOrigin ? String(origin.path) : '',
    };
  });
  const taskIndexOf = new Map(items.map((it, i) => [it.id, i]));
  const retryTaskNo = (typeof taskFilter === 'number' && taskFilter >= 1) ? taskFilter : null;
  let runItems = items;
  if (retryTaskNo !== null) {
    // 单任务重跑：非目标来源标记为跳过（≡ graph.js:347-355），只重跑目标来源
    for (let i = 0; i < tasks.length; i++) {
      if (i !== retryTaskNo - 1) { tasks[i].status = 'done'; tasks[i].output = (tasks[i].output || '') + '\n[跳过] 本次为单任务重跑，该来源未重新抽取'; }
    }
    runItems = items.filter((it) => taskIndexOf.get(it.id) === retryTaskNo - 1);
  }
  if (onTasks) onTasks(tasks);

  const sourceLabels = items.map((it) => it.label);
  const sourcePreviews = items.map((it) => ({ rawPath: it.label, content: String(it.text || '').slice(0, 8000) }));

  // ---- 抽取相：ArraySource(runItems) → enrich（含领域归纳）→ corpusWrite → chunk → extract → guard → merge ----
  const extractCtx = makeContext({
    settings, signal,
    autoReason: autoReasonOpt,
    domainId: (domainId && domainId !== 'general') ? domainId : '',
    domainLabel: domainLabel || '',
    typeHints: typeHints || null,
    profileId: ontologyProfile || '',
    resolveDomain: typeof resolveDomain === 'function' ? resolveDomain : undefined,
    onStage: (key, status, detail) => stage(key, detail),
    onProgress: (detail, preview) => { if (onProgress) { try { onProgress(detail, preview); } catch (_) { /* 忽略 */ } } },
    onTasks: (t) => { if (onTasks) { try { onTasks(t); } catch (_) { /* 忽略 */ } } },
    shared: { collectedItems: runItems, tasks, taskIndexOf, sourceLabels, sourcePreviews },
  });
  await drive(buildPipeline(GRAPH_EXTRACT_RECIPE, extractCtx), extractCtx);

  // 全失败 / 无节点：与老实现同口径抛错（≡ graph.js:613-623），由 runJob 标作业失败
  if (extractCtx.shared.fatalError) throw new Error(extractCtx.shared.fatalError);
  const result10 = extractCtx.shared.result10;
  if (!result10) throw new Error('流水线未产出图谱结果');
  return result10;
}

// ---------- 本体抽取 ----------
// 逐批调用模型抽取节点/边，合并去重后持久化；onStage 回调用于作业阶段进度展示
// resolveDomain(raws)：未命中特定领域时由作业层决定最终领域（可新建/复用领域模版），
// 返回 { domainId, domainLabel, typeHints }；graph 层不直接依赖 templates
async function extractGraph(settings, { rawPaths, readRaw, inlineSources, typeHints, domainLabel, domainId, resolveDomain, ontologyProfile, signal, taskFilter, autoReason: autoReasonOpt, corpusRels, onLog, onParseStart, onParseEnd, onSkip }, onStage, onProgress, onTasks) {
  // G8 零行为变更开关：settings.pipeline 为真时走语料流水线（返回逐字段等价的 10 字段），否则走下方老实现
  if (settings && settings.pipeline) {
    return extractGraphViaPipeline(settings, { rawPaths, inlineSources, typeHints, domainLabel, domainId, resolveDomain, ontologyProfile, signal, taskFilter, autoReason: autoReasonOpt, corpusRels, onLog, onParseStart, onParseEnd, onSkip }, onStage, onProgress, onTasks);
  }
  // 作业停止信号：批次开始前检查 + 透传给 chatOnce 中断在途模型请求
  const mkAbort = () => Object.assign(new Error('用户手动停止作业'), { name: 'AbortError' });
  // 生效体系优先级（融合设计 §12.1.1 五级链，两入口 renderer/raws.js 与 jobs/jobs.js 一致）：
  //   ① 弹窗显式指定（ontologyProfile 入参，即 explicitPid）
  //   ② 领域模版绑定（resolveDomain 回填的 tplProfile，见下方 :309 附近）
  //   ③ 模型动态选择（suggestOntologyProfile，在调用方完成，同样以 explicitPid 形态传入）
  //   ④ settings.ontologyProfile —— v4 起设置页已无该入口，仅作历史数据兜底（死层）
  //   ⑤ bfo-lite 硬兜底
  // graph.js 只消费最终结果，无法区分「弹窗选的」与「模型选的」（两者都走 explicitPid）。
  const explicitPid = ontologyProfile || '';
  let sources;
  if (Array.isArray(inlineSources) && inlineSources.length) {
    // 内联语料：直接从传入文本抽取（笔记「生成图谱」按钮）
    sources = inlineSources
      .map((s) => ({ label: s.label || '内联', text: String(s.text || '').slice(0, SOURCE_CHARS), domain: s.domain || '' }))
      .filter((s) => s.text.trim());
    if (!sources.length) throw new Error('笔记内容为空，无法抽取');
  } else if (Array.isArray(rawPaths) && rawPaths.length && readRaw) {
    // 指定原始来源：仅从 raw 文件抽取（生成图谱按钮）
    sources = [];
    for (const rel of rawPaths) {
      const text = String((await readRaw(rel)) || '').slice(0, SOURCE_CHARS);
      if (text.trim()) sources.push({ label: '原始·' + String(rel).replace(/^raw\//, ''), text, domain: '' });
    }
    if (!sources.length) throw new Error('原始来源内容为空或不存在');
  } else {
    sources = collectSources();
  }
  if (!sources.length) throw new Error('选定范围内没有可抽取的内容（笔记为空）');
  // 领域归属：命中特定领域则直接用；否则交由作业层自动建域/复用已有领域，抽取出的节点随之挂到该领域下
  let hints = typeHints;
  let domLabel = domainLabel;
  let domainTag = domainId && domainId !== 'general' ? domainId : '';
  let tplProfile = '';
  let profileReason = '';
  let profileSimilarity = 0;
  let domainSimilarity = 0;
  if (resolveDomain) {
    const r = await resolveDomain(sources.map((s) => ({ rawPath: s.label, content: s.text })));
    if (r) {
      if (r.typeHints) hints = r.typeHints;
      if (r.domainLabel) domLabel = r.domainLabel;
      if (r.domainId && r.domainId !== 'general') domainTag = r.domainId;
      if (r.ontologyProfile) tplProfile = r.ontologyProfile;
      if (r.profileReason) profileReason = r.profileReason;
      if (r.profileSimilarity) profileSimilarity = r.profileSimilarity;
      if (r.domainSimilarity) domainSimilarity = r.domainSimilarity;
    }
  }
  // 指定已有领域（不走 resolveDomain）时，主动读取该领域模版绑定的体系，否则模版的 ontologyProfile 不会生效
  if (!tplProfile && domainTag && domainTag !== 'general') {
    try {
      const { listTemplates } = require('./templates');
      const tpl = listTemplates().find((t) => t.id === domainTag);
      if (tpl && tpl.ontologyProfile) tplProfile = tpl.ontologyProfile;
    } catch (_) {}
  }
  // 体系解析放在领域判定之后：① 弹窗显式 > ② 命中模板的体系绑定 > ④ settings 历史兜底 > ⑤ bfo-lite
  // （③ 模型动态选择在调用方已折进 explicitPid；完整五级链见函数头部注释与 §12.1.1）
  const pid = explicitPid || tplProfile || (settings && settings.ontologyProfile) || 'bfo-lite';
  const onto = resolveOntology(pid);
  const profileId = onto.id;
  const twoStage = onto.promptMode === 'two-stage';
  // 收集阶段同时报出本次抽取所用领域与类型约束（与吸收作业「使用领域模版：X」的信息量对齐）
  if (onStage) {
    const ent = (hints && hints.entity) || [];
    const con = (hints && hints.concept) || [];
    const domText = ent.length || con.length
      ? `领域「${domLabel || domainTag}」（实体〔${ent.join('、')}〕；概念〔${con.join('、')}〕）`
      : `领域「${domLabel || domainTag || '通用'}」（未附加实体/概念类型约束）`;
    const domSim = domainSimilarity ? `（相似度 ${domainSimilarity}%）` : '';
    const profSim = profileReason ? `（相似度 ${profileSimilarity}%，${profileReason}）` : '';
    onStage('collect', `共 ${sources.length} 个来源，${domText}${domSim}，体系「${onto.name}」${profSim}${twoStage ? '（两阶段）' : ''}，开始分批抽取…`);
  }

  // 分批：每个来源独立一批（一个任务），便于逐任务展示当前进度与独立输出
  const batches = sources.map((s) => [s]);

  // 任务列表：每个来源一个独立 task，随批次推进更新状态（供作业内展示）
  sources.forEach((s, i) => { s._i = i; });
  const tasks = buildTasks(sources.map((s) => s.label));
  if (onTasks) onTasks(tasks);

  // 单任务重跑：仅执行指定批次，其余任务直接标记为跳过
  const retryTaskNo = (typeof taskFilter === 'number' && taskFilter >= 1) ? taskFilter : null;
  if (retryTaskNo !== null) {
    for (let i = 0; i < tasks.length; i++) {
      if (i !== retryTaskNo - 1) {
        tasks[i].status = 'done';
        tasks[i].output = (tasks[i].output || '') + '\n[跳过] 本次为单任务重跑，该来源未重新抽取';
      }
    }
    if (onTasks) onTasks(tasks);
  }

  const nodes = new Map(); // key -> {id,name,type,desc,sources[],domain,profile}
  const edges = new Map(); // key -> {from,to,rel,sources[]}
  const typeMap = nodeTypesMap(profileId);
  const rels = relationsList(profileId);
  const fbType = fallbackType(profileId);
  const fbRel = fallbackRel(profileId);

  // ---------- 写入护栏（设计文档 §4.3） ----------
  // 抽取阶段就拦掉「谓词定义域/值域越界」的连线，降级为回退谓词并留痕，
  // 而不是等推理阶段才发现图里全是语义非法边。
  // 护栏依赖体系的 domain/range 声明；老内置体系里只有 bfo / iso15926 各 2 个谓词有（公理形式），
  // ogms 与 OWL 导入体系则直接挂在谓词上；bfo-lite 一个都没有 —— 此时护栏自然不拦截（coverage 0%），属预期行为，不是失效。
  const guardOn = reasonEnabled(settings);
  const guardLog = [];
  const R = guardOn ? reason() : null;
  const guardProfile = (R && R.guard) ? onto : null;
  // 抽取结束后是否自动跑一次物化推理（§6.7 的 `extract-auto-reason` 复选框，默认勾选）。
  // 与护栏共用同一个总开关：推理层不可用时两者一起静默降级。
  const doReason = guardOn && autoReasonOpt !== false;
  const ensureNode = (name, type, desc, srcLabel, srcDomain) => {
    const key = nodeKey(name);
    if (!key) return null;
    let node = nodes.get(key);
    if (!node) {
      // id 带 profile 前缀：同一事物在不同体系下生成不同节点，保证多体系图谱共存可对比
      node = { id: `${profileId}:${key}`, name: String(name).trim().slice(0, 40), type: typeMap[type] ? type : fbType, desc: '', sources: [], domain: srcDomain || '', profile: profileId };
      nodes.set(key, node);
    }
    if (!node.desc && desc) node.desc = String(desc).slice(0, 120);
    if (srcLabel && !node.sources.includes(srcLabel) && node.sources.length < 5) node.sources.push(srcLabel);
    if (srcDomain && !node.domain) node.domain = srcDomain;
    return node;
  };

  // 并发池：默认同时执行 3 个抽取任务（settings.graphConcurrency 可调，1–8）
  const CONC = num(settings, 'graphConcurrency', 3, 1, 8);
  // 单任务失败不拖死整个作业：记录后继续其余批次，作业结束时按部分成功处理
  const batchFailed = [];
  const runBatch = async (i) => {
    if (signal && signal.aborted) throw mkAbort();
    const curTask = tasks[batches[i][0]._i];
    const taskHead = curTask ? `任务 ${curTask.no}/${tasks.length}「${curTask.label}」` : `批次 ${i + 1}/${batches.length}`;
    if (onStage) onStage('extract', `AI 本体抽取（${taskHead}）…`);
    // 本批来源标记为处理中，实时上报任务状态
    for (const s of batches[i]) if (tasks[s._i]) tasks[s._i].status = 'running';
    if (onTasks) onTasks(tasks);
    try {
    const batchText = batches[i].map((s) => `=== 来源: ${s.label} ===\n${s.text}`).join('\n\n');
    // 已抽取节点（供后续任务建立跨来源关系）
    const existing = [...nodes.values()].slice(0, 60).map((n) => `${n.name}(${n.type})`).join('、');
    // 流式上报本批思考/输出进度与尾部预览（节流 600ms）
    let think = '';
    let out = '';
    let lastReport = 0;
    const report = onProgress
      ? (delta, isReasoning) => {
        if (isReasoning) think += delta; else out += delta;
        const now = Date.now();
        if (now - lastReport > 600) {
          lastReport = now;
          const phase = out ? `模型输出中（已 ${out.length} 字）` : `模型思考中（已 ${think.length} 字）`;
          const preview = ((think ? `【思考】\n${think}\n\n` : '') + (out ? `【输出】\n${out}` : '')).slice(-1500);
          if (curTask) { curTask.output = preview; if (onTasks) onTasks(tasks); }
          onProgress(`AI 本体抽取（${taskHead}），${phase}…`, preview);
        }
      }
      : null;
    // 体系提示：类型表（两阶段=仅顶级类）+ 谓词表
    const classLine = (list) => list.map((c) => `${c.key}(${c.label}${c.desc ? '：' + c.desc : ''})`).join('、');
    const topClasses = onto.classes.filter((c) => !c.parent || !typeMap[c.parent]);
    const promptHead = twoStage
      ? `【第一步·粗分类】本体系为两阶段抽取。节点的一级类只能从以下顶级类中选择：${classLine(topClasses)}。\n`
      : `节点类型只能从：${classLine(onto.classes)} 中选择。\n`;
    const sysPrompt = getPromptForProfile(settings, 'graphExtractPrompt', profileId) + (twoStage
      ? `\n当前使用顶层本体体系「${onto.name}」的两阶段抽取模式：第一步先按顶级类粗分类，第二步再在用户指定的子树内细分到叶子类。`
      : `\n当前使用顶层本体体系「${onto.name}」。`);
    const answer = await chatOnce(settings, [
      { role: 'system', content: sysPrompt },
      {
        role: 'user',
        content:
          `以下是知识库中的一个来源内容。请抽取本体层：节点与关系。\n` +
          promptHead +
          `关系只能从：${rels.join('、')} 中选择。\n` +
          (existing ? `已有节点（可为其建立关系，避免重复创建）：${existing}。\n` : '') +
          (hints && ((hints.entity || []).length || (hints.concept || []).length)
            ? `本次为领域「${domLabel || domainTag || ''}」抽取，请围绕该领域模版的类别组织节点：优先归入〔${(hints.entity || []).concat(hints.concept || []).join('、')}〕相关类别。\n`
            : '') +
          `节点名使用规范简短名词；同一事物只输出一个节点；关系须有明确依据，最多 30 个节点、50 条边。\n` +
          `输出 JSON：{"nodes":[{"name":"","type":"","desc":""}],"edges":[{"from":"","to":"","rel":""}]}\n\n` +
          batchText,
      },
    ], undefined, report, signal);
    // 本批来源已处理，更新任务状态（解析失败也视为已处理）。
    // 任务完成时把该任务完整的思考+输出写入 output（此前流式仅 600ms 节流写尾部预览，
    // 快速完成的任务可能从未触发节流而导致展开后看不到详情），确保每个任务都可独立展开查看运行详情
    for (const s of batches[i]) if (tasks[s._i]) tasks[s._i].status = 'done';
    if (curTask) {
      const full = ((think ? `【思考】\n${think}\n\n` : '') + (out ? `【输出】\n${out}` : '')).trim();
      if (full) curTask.output = full;
    }
    if (onTasks) onTasks(tasks);
    let parsed;
    try {
      parsed = extractJson(answer);
    } catch (_) {
      return; // 单批解析失败跳过，不中断整体抽取
    }
    let coarse = parsed.nodes || [];
    // 两阶段第二步：在粗分类顶级类的子树内细分到叶子类
    if (twoStage && coarse.length) {
      const subOf = {};
      for (const n of coarse) {
        const top = typeMap[n.type] ? n.type : (onto.classes.find((c) => !c.parent || !typeMap[c.parent]) || {}).key;
        if (!subOf[top]) subOf[top] = [];
        subOf[top].push(n.name);
      }
      const refined = [];
      for (const [top, names] of Object.entries(subOf)) {
        const subtree = onto.classes.filter((c) => {
          let p = c;
          while (p) { if (p.key === top) return true; p = onto.classes.find((x) => x.key === p.parent); }
          return false;
        });
        try {
          const ans2 = await chatOnce(settings, [
            { role: 'system', content: sysPrompt },
            {
              role: 'user',
              content:
                `【第二步·细分类】以下节点已粗分为「${top}」，请在子树内细分为最合适的叶子类。\n` +
                `可选类型：${classLine(subtree)}。\n` +
                `节点：${names.join('、')}。\n` +
                `输出 JSON：{"nodes":[{"name":"","type":""}]}，只输出这些节点的细分结果。`,
            },
          ], undefined, undefined, signal);
          const r = extractJson(ans2);
          for (const x of r.nodes || []) refined.push(x);
        } catch (_) { /* 单组细分失败则沿用粗分类 */ }
      }
      const refMap = new Map(refined.map((x) => [nodeKey(x.name), x.type]));
      coarse = coarse.map((n) => ({ ...n, type: refMap.get(nodeKey(n.name)) || n.type }));
    }
    for (const n of coarse) ensureNode(n.name, n.type, n.desc, null);
    for (const e of parsed.edges || []) {
      const from = ensureNode(e.from, null, null, null);
      const to = ensureNode(e.to, null, null, null);
      let rel = rels.includes(e.rel) ? e.rel : fbRel;
      if (!from || !to || from.id === to.id) continue;
      // 护栏：domain/range 越界 → 降级为回退谓词并留痕（§4.3）
      let guardBlocked = null;
      if (guardProfile && R.guard) {
        try {
          const verdict = R.guard.checkEdge(guardProfile, from, rel, to);
          if (verdict && !verdict.ok) {
            guardBlocked = verdict;
            guardLog.push({
              taskNo: curTask ? curTask.no : 0,
              from: from.name, fromType: from.type,
              rel, to: to.name, toType: to.type,
              reason: verdict.reason || 'constraint-violation',
              detail: verdict.detail || '',
              downgradedTo: fbRel,
            });
            rel = fbRel;
          }
        } catch (_) { /* 护栏自身异常绝不能拖死抽取主链路 */ }
      }
      // 护栏·写侧互斥预检（冲突自动处理方案1）：即使 domain/range 校验通过，
      // 若谓词的定义域/值域会把端点强制归入与其声明类型互斥的类
      // （prp-dom/prp-rng + DisjointClasses ⇒ 推理时必报 cax-dw），
      // 同样降级为回退谓词——把冲突消灭在写库前，而不是事后修复。
      // 典型触发场景：导入的 OWL 体系同时声明了 subclass 与 disjoint（体系自身不一致），
      // 或两阶段细分把节点类型改深后与谓词约束撞上互斥对。
      if (guardProfile && R.guard && rel !== fbRel) {
        try {
          // 与推理器/修复规划同口径（guard.forcingProbes）：强制类型含逆谓词物化，
          // 否则「bearer_of 无约束但逆 inheres_in 有 domain」这类边会漏拦截、入库后必报 cax-dw
          const probes = R.guard.forcingProbes(guardProfile, rel)
            .map((p) => ({ node: p.node === 'from' ? from : to, type: (p.node === 'from' ? from : to).type, forced: p.forced, via: p.via, inverseRel: p.inverse ? p.rel : '' }));
          for (const p of probes) {
            if (!p.type || !p.forced.length) continue;
            let hit = null;
            for (const f of p.forced) {
              const d = R.guard.checkDisjoint(guardProfile, p.type, f);
              if (d && d.conflict) { hit = { f, d }; break; }
            }
            if (!hit) continue;
            guardLog.push({
              taskNo: curTask ? curTask.no : 0,
              from: from.name, fromType: from.type,
              rel, to: to.name, toType: to.type,
              reason: 'disjoint-type-forcing',
              detail: `「${p.node.name}」声明类型 ${p.type}，但谓词 ${p.inverseRel ? `${rel} 的逆谓词 ${p.inverseRel}` : rel} 的${p.via === 'domain' ? '定义域' : '值域'}会把它强制归入互斥类 ${hit.f}${hit.d.detail ? `（${hit.d.detail}）` : ''}`,
              downgradedTo: fbRel,
            });
            rel = fbRel;
            break;
          }
        } catch (_) { /* 护栏自身异常绝不能拖死抽取主链路 */ }
      }
      const key = `${from.id}|${to.id}|${rel}`;
      if (!edges.has(key)) edges.set(key, { from: from.id, to: to.id, rel });
      else if (guardBlocked) { /* 已有同键边，护栏记录仍保留供 UI 汇总 */ }
    }
    // 来源标签挂到批次内被提及的节点（按名称包含粗匹配），同时继承本次解析出的领域归属
    for (const s of batches[i]) {
      const label = s.label;
      const sDomain = s.domain || domainTag;
      for (const node of nodes.values()) {
        if (s.text.includes(node.name)) {
          if (!node.sources.includes(label) && node.sources.length < 5) node.sources.push(label);
          if (sDomain && !node.domain) node.domain = sDomain;
        }
      }
    }
    // 兑底：若本批次粗匹配全部未命中（节点名未出现在原文），仍按本次领域兜底补齐 domain，避免节点入「未分类」
    if (domainTag && domainTag !== 'general') {
      for (const node of nodes.values()) {
        if (!node.domain) node.domain = domainTag;
      }
    }
    } catch (err) {
      // 用户手动停止：必须向上传播，让作业标为已停止而非部分成功
      if (err && err.name === 'AbortError') throw err;
      // 单任务失败（网络中断/连接被关闭/超时/模型返回为空等）：标记该任务失败并继续其余批次，
      // 作业结束时按部分成功处理，不再因单个来源失败拖死整个作业
      for (const s of batches[i]) if (tasks[s._i]) { tasks[s._i].status = 'failed'; tasks[s._i].output = (tasks[s._i].output || '') + `\n[失败] ${err.message || err}`; }
      batchFailed.push({ index: i, label: (batches[i][0] && batches[i][0].label) || `批次 ${i + 1}`, error: err.message || String(err) });
      if (onTasks) onTasks(tasks);
      return;
    }
  };

  // 启动 N 个 worker 并发消费批次（单线程内 await 切换，Map 变更同步无竞态）
  // 单任务重跑时仅执行目标批次，其余批次已在上方标记为跳过
  let nextIdx = 0;
  const workers = Array.from({ length: Math.min(CONC, batches.length) }, async () => {
    for (;;) {
      const i = nextIdx++;
      if (i >= batches.length) break;
      if (retryTaskNo !== null && i !== retryTaskNo - 1) continue;
      await runBatch(i);
    }
  });
  await Promise.all(workers);

  // 单任务重跑：只重跑目标批次，其余批次视为成功（沿用已有产物），不做全部失败校验
  if (retryTaskNo !== null) {
    // 仅目标批次失败才算失败；其余批次产物已在图谱中，本次未动
    if (batchFailed.length) {
      throw new Error(`任务 ${retryTaskNo} 重跑失败：${batchFailed[0].error}`);
    }
    // 重跑成功：沿用已有节点/边，仅目标批次新增内容合并进来
  } else {
    // 全部任务失败：无产出，作业整体失败
    if (batchFailed.length && batchFailed.length === batches.length) {
      throw new Error(`全部 ${batchFailed.length} 个来源抽取失败：${batchFailed[0].error}`);
    }
  }
  // 部分失败：作业整体成功，但结果中携带 failedTasks，作业卡片据此展示警告
  const failedTasks = batchFailed.length
    ? batchFailed.map((f) => ({ taskNo: f.index + 1, label: f.label, error: f.error }))
    : undefined;

  if (!nodes.size && retryTaskNo === null) throw new Error('模型未抽取到任何节点，请检查 API 配置或缩小范围重试');
  if (!nodes.size && retryTaskNo !== null) throw new Error('重跑未抽取到任何节点，请检查该来源内容或模型配置');

  // 多体系共存合并：节点 id 带 profile 前缀（避免跨体系同名撞 id）；
  // 与已有图谱合并——同 profile 同 id 合并 sources/desc，跨 profile 节点保留共存，差的版本可按体系清除
  const existing = getGraph();
  const mergedNodes = new Map(); // nodeId -> node
  const mergedEdges = new Map(); // edgeKey -> edge
  const putNode = (n) => {
    const ex = mergedNodes.get(n.id);
    if (!ex) { mergedNodes.set(n.id, { ...n }); return; }
    // 同 id 同 profile：合并 sources / desc / domain，保留既有 type
    for (const s of n.sources || []) if (!ex.sources.includes(s) && ex.sources.length < 8) ex.sources.push(s);
    if (!ex.desc && n.desc) ex.desc = n.desc;
    if (!ex.domain && n.domain) ex.domain = n.domain;
  };
  const putEdge = (e) => { const k = `${e.from}|${e.to}|${e.rel}`; if (!mergedEdges.has(k)) mergedEdges.set(k, { ...e }); };
  // 先放已有图谱（跨体系保留），再放本次抽取（本体系内合并）
  for (const n of existing.nodes || []) if (n && n.id) putNode(n);
  // 旧推理边不参与合并：本轮统一重算（§5.4）。
  // 若不过滤，上一轮的推理产物会被当成「原始边」再喂给推理器，形成自我循环论证。
  for (const e of existing.edges || []) if (e && e.from && e.to && !e.inferred) putEdge(e);
  for (const n of nodes.values()) putNode(n);
  for (const e of edges.values()) putEdge(e);

  const mergedNodeList = [...mergedNodes.values()];
  const rawEdgeList = [...mergedEdges.values()];
  // 先落原始图：推理是增强项，失败/超时/被关闭都不能让用户丢掉抽取结果（§9 风险 2）
  saveGraph(mergedNodeList, rawEdgeList);

  // ---------- 自动推理（设计文档 §4.2 / §5.1 / §6.7） ----------
  const guardSummary = guardLog.length
    ? (R && R.guard ? R.guard.summarizeGuardLog(guardLog) : { total: guardLog.length, byReason: {}, byRel: {}, entries: guardLog.slice(0, 200), truncated: false })
    : null;
  if (onStage && guardSummary) {
    onStage('guard', `护栏拦截 ${guardSummary.total} 条越界连线（已降级为「${fbRel}」）`);
  }

  let reasonResult = null;
  if (doReason) {
    if (onStage) onStage('reason', '本地物化推理中（OWL 2 RL 前向链）…');
    try {
      // DL 生效配置（融合设计 §12）：提取后的自动推理同样受设置页的 DL 开关/默认深度/规模上限约束。
      const exDlLimits = dlLimitsFromSettings(settings);
      const mat = await R.infer.materializeGraph(
        { nodes: mergedNodeList, edges: rawEdgeList },
        onto,
        {
          timeoutMs: reasonTimeoutSec(settings) * 1000,
          signal,
          dlEnabled: (settings && settings.dlEnabled === false) ? false : undefined,
          deep: dlDeepDefault(settings),
          maxDlEdges: exDlLimits.maxInferredEdges,
          limits: exDlLimits,
          onProgress: (info) => { if (onStage && info && info.phase) onStage('reason', info.phase); },
        }
      );
      if (mat.skipped) {
        reasonResult = { skipped: true, skipReason: mat.skipReason || 'unknown', stats: mat.stats || null };
        if (onStage) onStage('reason', `推理已跳过：${SKIP_REASON_TEXT[mat.skipReason] || mat.skipReason || '未知原因'}`);
      } else {
        const merged = R.infer.mergeInferredEdges(rawEdgeList, mat.inferredEdges);
        saveGraph(mergedNodeList, merged.edges);
        reasonResult = {
          skipped: false,
          stats: mat.stats,
          inferredEdges: merged.edges.length - rawEdgeList.length,
          bound: merged.bound,
          dropped: merged.dropped,
          inconsistencies: mat.inconsistencies || [],
        };
        if (onStage) {
          const nInf = reasonResult.inferredEdges;
          const nCon = (mat.inconsistencies || []).length;
          onStage('reason', `推理完成：新增 ${nInf} 条推理边（${mat.stats.rounds} 轮 / ${mat.stats.elapsedMs} ms）`
            + (nCon ? `，检出 ${nCon} 处语义冲突` : ''));
        }
      }
    } catch (err) {
      // 推理异常绝不影响抽取作业的成功判定：原始图已落库，这里只记录原因
      reasonResult = { skipped: true, skipReason: 'exception', error: String((err && err.message) || err) };
      if (onStage) onStage('reason', `推理失败（已保留原始图谱）：${reasonResult.error.slice(0, 160)}`);
    }
    setGraphMeta({
      lastInferredAt: reasonResult && !reasonResult.skipped ? Date.now() : getGraphMeta().lastInferredAt,
      inferredStale: false,
      lastStats: reasonResult ? {
        skipped: !!reasonResult.skipped,
        skipReason: reasonResult.skipReason || '',
        inferredEdges: reasonResult.inferredEdges || 0,
        inconsistencies: (reasonResult.inconsistencies || []).length,
        inconsistencyDetails: capInconsistencies(reasonResult.inconsistencies || []),
        elapsedMs: (reasonResult.stats && reasonResult.stats.elapsedMs) || 0,
        rounds: (reasonResult.stats && reasonResult.stats.rounds) || 0,
        profileId,
        at: Date.now(),
      } : null,
      lastGuard: guardSummary ? {
        total: guardSummary.total, byReason: guardSummary.byReason, byRel: guardSummary.byRel,
        entries: (guardSummary.entries || []).slice(0, 50), profileId, at: Date.now(),
      } : getGraphMeta().lastGuard,
    });
  } else if (guardSummary) {
    setGraphMeta({ lastGuard: { total: guardSummary.total, byReason: guardSummary.byReason, byRel: guardSummary.byRel, entries: (guardSummary.entries || []).slice(0, 50), profileId, at: Date.now() } });
  }

  const finalGraph = getGraph();
  return {
    nodeCount: mergedNodes.size,
    edgeCount: finalGraph.edges.length,
    rawEdgeCount: rawEdgeList.length,
    sourceCount: sources.length,
    sourceLabels: sources.map((s) => s.label),
    profileId,
    profileName: onto.name,
    failedTasks,
    guard: guardSummary ? { total: guardSummary.total, byReason: guardSummary.byReason, byRel: guardSummary.byRel } : null,
    reason: reasonResult,
  };
}

// ---------- 问答上下文注入 ----------
// 问题分词：英文/数字词 + 中文二元组（无标点的整句中文也能命中节点）
function questionTokens(q) {
  const tokens = new Set();
  for (const w of q.split(/[^A-Za-z0-9]+/).filter((t) => t.length >= 2)) tokens.add(w);
  for (const seg of q.match(/\p{Script=Han}+/gu) || []) {
    if (seg.length < 2) tokens.add(seg);
    else for (let i = 0; i < seg.length - 1; i++) tokens.add(seg.slice(i, i + 2));
  }
  return [...tokens];
}

// 体系展示名（内置/OWL 均从 listProfiles 查；查不到回退 id 本身）
function profileNameOf(pid) {
  const p = (listProfiles() || []).find((x) => x.id === pid);
  return p ? (p.name || pid) : pid;
}

// 依据问题关键词召回相关节点及其关系边，返回上下文文本与命中实体名单
// profileId：可选，指定后只召回该体系下抽取的节点（多体系共存时按体系隔离问答上下文）
// scope：可选，二级范围（'all' | 'profile|*' | 'profile|domain'，多选逗号分隔），优先级高于 profileId
function recallFor(question, maxNodes = 8, profileId, scope) {
  const g = getGraph();
  if (!g.nodes.length) return { context: '', hits: [] };
  const q = String(question || '').toLowerCase();
  if (!q.trim()) return { context: '', hits: [] };
  let pool = g.nodes;
  const scopePred = scopeFilter(scope);
  if (scopePred) pool = pool.filter(scopePred);
  else if (profileId) pool = pool.filter((n) => n.profile === profileId);
  if (!pool.length) return { context: '', hits: [] };
  const tokens = questionTokens(q);
  const scored = pool
    .map((n) => {
      const name = n.name.toLowerCase();
      const desc = (n.desc || '').toLowerCase();
      let nameScore = 0;
      let descScore = 0;
      // 全名被问题包含（名称太短时不算，避免单字误命中）
      if (name.length >= 2 && q.includes(name)) nameScore += 5;
      for (const t of tokens) {
        if (name.includes(t)) nameScore += 2;
        if (desc.includes(t)) descScore += 1;
      }
      return { n, score: nameScore + descScore, nameScore };
    })
    // 必须名称命中才算召回：仅 desc 里出现「能力」「方法」这类通用词不足以构成引用依据
    .filter((x) => x.nameScore > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxNodes);
  if (!scored.length) return { context: '', hits: [] };

  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  // 按节点自身 profile 取该体系的类表，避免混合体系时类型标签错配（本体体系 + 图谱 结合的关键）
  const typeMaps = new Map(); // profile -> {typeKey: true}
  const typeMapFor = (prof) => {
    if (!typeMaps.has(prof)) typeMaps.set(prof, nodeTypesMap(prof));
    return typeMaps.get(prof);
  };
  const fbTypeOf = (prof) => { try { return fallbackType(prof); } catch (_) { return 'object'; } };
  const lines = scored.map(({ n }) => {
    const rels = g.edges
      .filter((e) => e.from === n.id || e.to === n.id)
      .slice(0, 6)
      .map((e) => {
        const other = e.from === n.id ? byId.get(e.to) : byId.get(e.from);
        return other ? `${e.from === n.id ? '' : '被'}${e.rel}→${other.name}` : '';
      })
      .filter(Boolean)
      .join('；');
    const prof = n.profile || 'bfo-lite';
    const tm = typeMapFor(prof);
    const typeKey = tm[n.type] ? n.type : fbTypeOf(prof);
    // 标签形如 [体系·类型]，让模型清楚每个实体属于哪个本体体系、是什么类（本体+图谱结合的体现）
    return `- [${profileNameOf(prof)}·${typeKey}] ${n.name}${n.desc ? `：${n.desc}` : ''}${rels ? `（关系：${rels}）` : ''}`;
  });
  // 头部：区分 全部 / 单体系 / 二级具体图谱范围
  let head = '【知识图谱·本体层】';
  if (scope && scope !== 'all') head = '【知识图谱·本体层·指定图谱范围】';
  else if (profileId) head = `【知识图谱·本体层·体系：${profileNameOf(profileId)}】`;
  return {
    context: `${head}\n${lines.join('\n')}\n回答时可结合上述实体与关系（标签为「本体体系·实体类型」）。`,
    hits: scored.map(({ n }) => n.name),
  };
}

// 兼容旧调用：只要上下文文本
function contextFor(question, maxNodes = 8, profileId) {
  return recallFor(question, maxNodes, profileId).context;
}

// ---------- 本体定义（Ontology）查询与增删改查（v3：基座 + 用户层） ----------
// 本体视图数据：profile 摘要 + 类树 + 谓词 + 约束 + 实例统计 + 可选体系列表
function getOntology(profileId) {
  const kv = readOntologyKv();
  const id = profileId || kv.profileId || 'bfo-lite';
  const o = resolveOntology(id);
  const g = getGraph();
  // 实例/关系统计**按体系隔离**（口径同 listGraphScopes / scopeFilter）：
  //   节点归属 = 自身 profile 字段 → id 前缀（形如 `bfo-lite:充电桩`）→ 兜底 bfo-lite；
  //   边仅在**两端同属当前体系**时计入（跨体系边不计入任何单体系，避免重复计数）。
  // 历史：f49eccb 引入该隔离，daf7bfb「fix MCP client problems」误将其回退（测试断言未同步回退 → 长期红测），此处恢复。
  const pidOf = (n) => {
    if (n && n.profile) return String(n.profile);
    const nid = String((n && n.id) || '');
    const i = nid.indexOf(':');
    return i > 0 ? nid.slice(0, i) : 'bfo-lite';
  };
  const countBy = {};
  const nodePid = new Map();
  let instCount = 0;
  let edgeCount = 0;
  for (const n of g.nodes) {
    if (!n) continue;
    const p = pidOf(n);
    nodePid.set(n.id, p);
    if (p !== id) continue;
    instCount += 1;
    countBy[n.type] = (countBy[n.type] || 0) + 1;
  }
  for (const e of g.edges) {
    if (!e || !e.from || !e.to) continue;
    if (nodePid.get(e.from) === id && nodePid.get(e.to) === id) edgeCount += 1;
  }
  const baseKeys = { classes: new Set(), predicates: new Set() };
  const baseProfile = id.startsWith('owl:') ? (kv.owlProfiles || []).find((p) => p.id === id) : ONTOLOGY_PROFILES[id];
  (baseProfile ? baseProfile.classes : []).forEach((c) => baseKeys.classes.add(c.key));
  (baseProfile ? baseProfile.predicates : []).forEach((p) => baseKeys.predicates.add(p.key));
  const classes = o.classes.map((c) => ({ ...c, instances: countBy[c.key] || 0, builtin: baseKeys.classes.has(c.key), custom: !baseKeys.classes.has(c.key) }));
  const predicates = o.predicates.map((p) => ({ ...p, builtin: baseKeys.predicates.has(p.key), custom: !baseKeys.predicates.has(p.key) }));
  return {
    profileId: id,
    profileName: o.name,
    profileDesc: o.desc,
    promptMode: o.promptMode,
    classes,
    predicates,
    constraints: o.constraints || [],
    axioms: o.axioms || [],
    profiles: listProfiles(),
    owlProfiles: kv.owlProfiles.map((p) => ({ id: p.id, name: p.name, desc: p.desc })),
    stats: {
      classCount: o.classes.length,
      predicateCount: o.predicates.length,
      constraintCount: (o.constraints || []).length,
      axiomCount: (o.axioms || []).length,
      instanceCount: instCount,
      edgeCount,
    },
  };
}

// 切换本体页当前编辑的体系（落 kv profileId）
function setOntologyProfile(profileId) {
  const kv = readOntologyKv();
  const ok = ONTOLOGY_PROFILES[profileId] || (kv.owlProfiles || []).some((p) => p.id === profileId);
  if (!ok) throw new Error('未知本体体系：' + profileId);
  kv.profileId = profileId;
  persistOntologyKv(kv);
  return getOntology(profileId);
}

// 增/改：写入用户叠加层（同 key 覆盖基座）；kind = classes | predicates | constraints
function saveOntologyItem(kind, item, profileId) {
  const kv = readOntologyKv();
  const it = item || {};
  if (kind === 'classes') {
    const key = String(it.key || '').trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) throw new Error('标识键须为英文标识符（字母开头，仅字母/数字/下划线）');
    const label = String(it.label || '').trim();
    if (!label) throw new Error('名称不能为空');
    const rec = {
      key,
      label,
      parent: String(it.parent || '').trim(),
      desc: String(it.desc || '').trim(),
      examples: Array.isArray(it.examples) ? it.examples.map((s) => String(s).trim()).filter(Boolean).slice(0, 8) : [],
      from: 'custom',
    };
    const i = kv.userClasses.findIndex((c) => c.key === key);
    if (i >= 0) kv.userClasses[i] = rec; else kv.userClasses.push(rec);
  } else if (kind === 'predicates') {
    const key = String(it.key || '').trim();
    if (!key) throw new Error('谓词名称不能为空');
    const rec = { key, label: String(it.label || key).trim(), desc: String(it.desc || '').trim(), from: 'custom' };
    const i = kv.userPredicates.findIndex((p) => p.key === key);
    if (i >= 0) kv.userPredicates[i] = rec; else kv.userPredicates.push(rec);
  } else {
    const text = String(it.desc || '').trim();
    if (!text) throw new Error('约束内容不能为空');
    const idx = Number(it.index);
    if (Number.isInteger(idx) && kv.userConstraints[idx] !== undefined) kv.userConstraints[idx] = { desc: text, from: 'custom' };
    else kv.userConstraints.push({ desc: text, from: 'custom' });
  }
  persistOntologyKv(kv);
  return getOntology(profileId || kv.profileId);
}

// 删：仅删用户叠加层项；内置基座项只读不可删
function removeOntologyItem(kind, keyOrIndex, profileId) {
  const kv = readOntologyKv();
  if (kind === 'classes') {
    const isBuiltin = Object.values(ONTOLOGY_PROFILES).some((p) => p.classes.some((c) => c.key === keyOrIndex));
    if (isBuiltin) { const e = new Error('内置基座类只读，不可删除'); e.code = 'BUILTIN_READONLY'; throw e; }
    const i = kv.userClasses.findIndex((c) => c.key === keyOrIndex);
    if (i < 0) throw new Error('未找到自定义类：' + keyOrIndex);
    kv.userClasses.splice(i, 1);
  } else if (kind === 'predicates') {
    const isBuiltin = Object.values(ONTOLOGY_PROFILES).some((p) => p.predicates.some((x) => x.key === keyOrIndex));
    if (isBuiltin) { const e = new Error('内置基座谓词只读，不可删除'); e.code = 'BUILTIN_READONLY'; throw e; }
    const i = kv.userPredicates.findIndex((p) => p.key === keyOrIndex);
    if (i < 0) throw new Error('未找到自定义谓词：' + keyOrIndex);
    kv.userPredicates.splice(i, 1);
  } else {
    kv.userConstraints.splice(Number(keyOrIndex), 1);
  }
  persistOntologyKv(kv);
  return getOntology(profileId || kv.profileId);
}

// ---------- KG 自然语言问答 ----------
// 管线：LLM 抽取实体 → 匹配本体节点（多层兑底）→ BFS 邻居事实 → 沿节点 sources 回溯笔记原文 → 事实+材料约束流式回答，并下发引用清单
async function kgAsk(event, { settings, question, hops, withFacts }) {
  try {
    let g = getGraph();
    if (!g.nodes.length) {
      event.sender.send('ai:error', '知识图谱为空，请先在「整体图谱」页运行「抽取本体层」。');
      return;
    }
    // §5.4 惰性重推理：删除节点/边会标记 inferredStale=true，问答前重跑一次物化。
    // 与约束 D4 一致——「问答时若图未变直接读缓存的 inferred 边，变了才重跑」：
    // 不在每次写边时实时推理（批处理），只在读侧（问答）发现图变脏时补跑。
    if (getGraphMeta().inferredStale && reasonEnabled(settings)) {
      event.sender.send('kg:stage', '检测到图谱已变更，重新物化推理…');
      try {
        const rr = await runInference(settings, {
          onProgress: (info) => { if (info && info.phase) event.sender.send('kg:stage', info.phase); },
        });
        if (rr && rr.ok && !rr.skipped) {
          event.sender.send('kg:stage', `推理已刷新：新增 ${rr.inferredEdges} 条推理边`);
        } else if (rr && rr.skipped) {
          event.sender.send('kg:stage', `推理刷新跳过：${SKIP_REASON_TEXT[rr.skipReason] || rr.skipReason || '未知原因'}`);
        }
        g = getGraph();   // 重推理会重写图，必须重读
      } catch (err) {
        // 推理失败不阻断问答（§9：推理是增强项）
        event.sender.send('kg:stage', `推理刷新失败（按现有图谱继续作答）：${String((err && err.message) || err)}`);
      }
    }
    const maxHops = Math.max(1, Math.min(5, Number(hops) || 3));
    event.sender.send('kg:stage', '解析问题并抽取实体…');
    // 实体识别按图内节点的主导体系取提示词（多体系共存时取节点数最多的体系）
    let entityPid = '';
    try {
      const cnt = {};
      for (const n of g.nodes) { const p = String(n.profile || ''); if (p) cnt[p] = (cnt[p] || 0) + 1; }
      entityPid = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0] || '';
    } catch (_) {}
    let names = [];
    try {
      const ans = await chatOnce(settings, [
        { role: 'system', content: getPromptForProfile(settings, 'graphEntityPrompt', entityPid) },
        { role: 'user', content: `从问题中抽取可能在知识图谱中存在的实体名（节点名）。问题：${question}\n输出 JSON：{"names":["..."]}` },
      ]);
      names = extractJson(ans).names || [];
    } catch (_) {}
    event.sender.send('kg:stage', names.length
      ? `实体抽取完成：${names.slice(0, 6).join('、')}${names.length > 6 ? '…' : ''}（${names.length} 个）`
      : 'LLM 未抽到实体，回退关键词/分词评分召回…');
    const norm = (s) => String(s || '').toLowerCase();
    let seeds = g.nodes.filter((n) => names.some((s) => {
      const t = norm(s);
      return t && (n.id.includes(t) || n.name.toLowerCase().includes(t) || t.includes(n.name.toLowerCase()));
    }));
    if (!seeds.length) {
      // 兜底 1：问题关键词直接包含节点名
      seeds = g.nodes.filter((n) => {
        const q = norm(question);
        return n.name.length >= 2 && q.includes(n.name.toLowerCase());
      });
    }
    if (!seeds.length) {
      // 兜底 2：分词评分召回，保证抽取失手时仍能桥接到本体节点
      const tokens = norm(question).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);
      seeds = g.nodes
        .map((n) => {
          const name = n.name.toLowerCase();
          const desc = (n.desc || '').toLowerCase();
          let score = 0;
          for (const t of tokens) {
            if (name.includes(t)) score += 2;
            if (desc.includes(t)) score += 1;
          }
          return { n, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map((x) => x.n);
    }
    event.sender.send('kg:stage', seeds.length
      ? `命中图谱节点：${seeds.map((n) => n.name).slice(0, 6).join('、')}${seeds.length > 6 ? '…' : ''}（${seeds.length} 个）`
      : '未命中任何图谱节点，将仅靠全局材料作答');
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    // BFS 收集 hops 跳内事实三元组
    const facts = [];
    const seen = new Set(seeds.map((n) => n.id));
    let frontier = seeds.map((n) => n.id);
    for (let h = 0; h < maxHops && frontier.length; h++) {
      const next = [];
      for (const e of g.edges) {
        let other = null;
        if (frontier.includes(e.from)) other = e.to;
        else if (frontier.includes(e.to)) other = e.from;
        if (!other) continue;
        const a = byId.get(e.from), b = byId.get(e.to);
        if (a && b) {
          // 事实三元组带体系标签（§5），混合图谱下可辨识来源体系
          const tag = (n) => `[${n.profile || 'bfo-lite'}·${n.type}]`;
          facts.push(`${tag(a)}${a.name} —${e.rel}→ ${tag(b)}${b.name}`);
        }
        if (!seen.has(other)) { seen.add(other); next.push(other); }
      }
      frontier = next;
    }
    const uniqFacts = [...new Set(facts)].slice(0, 80);
    event.sender.send('kg:stage', `邻居事实扩展完成（${maxHops} 跳内）：共 ${uniqFacts.length} 条事实`);

    // ---------- DL 合取查询召回（融合设计 §6.2） ----------
    // BFS 只能沿**图里已有的边**走；DL tableau 能回答「按公理应当成立、但图里没画出来」的关系
    // （传递闭包、互逆、对称、属性链、domain/range 触发的类型归入）。命中 dlCapable 体系时，
    // 用 CQ 补一轮召回，答案并入 facts。失败（非 Horn / 超预算 / 未安装）静默跳过，BFS 结果不变。
    let dlFacts = [];
    try {
      dlFacts = dlRecallFacts(g, seeds, { settings, entityPid, send: (m) => event.sender.send('kg:stage', m) }).facts;
    } catch (err) {
      // DL 召回是增强项：任何异常都不得影响问答主链路（I5 静默降级）
      event.sender.send('kg:stage', `DL 查询召回失败（已跳过）：${String((err && err.message) || err).slice(0, 120)}`);
    }

    // ---------- 影响面扩展（设计文档 §4.4 / §11 开放问题 4：关键词触发） ----------
    // BFS 只给「N 跳内的直接邻居」，回答「变压器故障会波及什么」这类问题时，
    // 需要沿**传递谓词**做闭包（含推理边），并把传导路径写进事实里。
    // 仅在问题命中影响类关键词时触发，避免每次问答都跑闭包。
    let impactFacts = [];
    let impactInfo = null;
    const RR = reasonEnabled(settings) ? reason() : null;
    if (RR && RR.impact && seeds.length) {
      let intent = { hit: false, keywords: [] };
      try { intent = RR.impact.detectImpactIntent(question) || intent; } catch (_) {}
      if (intent.hit) {
        event.sender.send('kg:stage', `检测到影响面提问（${intent.keywords.join('、')}），沿传递谓词做闭包扩展…`);
        try {
          // 种子可能跨体系：按 profile 分组，各自用自己的体系解析谓词特性。
          // 节点 id 形如 `${profileId}:${key}`（见 ensureNode），profile 字段缺失时从 id 前缀还原。
          const pidOf = (n) => String(n.profile || (String(n.id || '').split(':')[0]) || entityPid || 'bfo-lite');
          const byProfile = new Map();
          for (const s of seeds) {
            const pid = pidOf(s);
            if (!byProfile.has(pid)) byProfile.set(pid, []);
            byProfile.get(pid).push(s);
          }
          const allImpacted = [];
          const summaries = [];
          for (const [pid, list] of byProfile) {
            let prof = null;
            try { prof = resolveOntology(pid); } catch (_) { prof = null; }
            if (!prof) continue;
            for (const seed of list.slice(0, 5)) {   // 每个体系至多取 5 个种子，防止闭包爆炸
              const impacted = RR.impact.impactClosure(g, prof, seed.id, {
                maxDepth: Math.max(2, maxHops + 2),
                direction: 'downstream',
                includeInferred: true,
              });
              if (!impacted || !impacted.length) continue;
              allImpacted.push(...impacted);
              summaries.push(RR.impact.impactSummary(prof, impacted, {}));
              impactFacts.push(...RR.impact.impactToFacts(g, seed, impacted, { limit: 20 }));
            }
          }
          impactFacts = [...new Set(impactFacts)].slice(0, 40);
          impactInfo = {
            keywords: intent.keywords,
            nodeCount: allImpacted.length,
            factCount: impactFacts.length,
            inferredCount: allImpacted.filter((x) => x && x.inferred).length,
            summaries: [...new Set(summaries)],
          };
          event.sender.send('kg:stage', impactFacts.length
            ? `影响面扩展完成：${impactInfo.nodeCount} 个下游节点（其中 ${impactInfo.inferredCount} 个来自推理边），生成 ${impactFacts.length} 条传导事实`
            : '影响面扩展完成：未发现可传导的下游节点（该体系未声明传递谓词，或图谱中无相应连线）');
        } catch (err) {
          // 影响面是增强项：失败只报一行，绝不影响问答主链路
          event.sender.send('kg:stage', `影响面扩展失败（已跳过）：${String((err && err.message) || err).slice(0, 120)}`);
        }
      }
    }
    // BFS 事实与影响面事实措辞略有差异（`—包含→` vs `—包含 →（1 跳，⚡推理）`），
    // 按字符串去重会漏掉语义相同的行、白白占用提示词额度。这里用「归一化键」去重：
    // 抹平箭头两侧空格与尾部括注（跳数/推理标记），并保留信息更丰富的影响面版本。
    const factKey = (f) => String(f).replace(/\s*→\s*/g, '→').replace(/（[^）]*）\s*$/, '').trim();
    let askFacts = uniqFacts;
    if (impactFacts.length || dlFacts.length) {
      const byKey = new Map();
      const order = [];
      const add = (list) => { for (const f of list) { const k = factKey(f); if (!byKey.has(k)) order.push(k); byKey.set(k, f); } };
      add(uniqFacts);
      // DL 事实放中间：措辞与 BFS 同口径（`—rel→`），键相同则被 BFS 版本覆盖（保留先出现的）
      add(dlFacts);
      add(impactFacts);
      askFacts = order.map((k) => byKey.get(k)).slice(0, 120);
    }

    // 沿本体节点的 sources 回溯笔记原文，作为回答材料与引用明细
    event.sender.send('kg:stage', '沿本体层回溯笔记原文…');
    const visited = [...seen].map((id) => byId.get(id)).filter(Boolean);
    const refs = collectRefs(settings, visited);
    event.sender.send('kg:stage', refs.length
      ? `原文回溯完成：命中 ${refs.length} 份材料（${refs.map((r) => r.label).slice(0, 3).join('、')}${refs.length > 3 ? '…' : ''}）`
      : '原文回溯完成：无可回溯材料');

    event.sender.send('kg:facts', {
      matched: seeds.map((n) => n.name),
      facts: withFacts ? askFacts : [],
      refs: refs.map((r) => ({ kind: r.kind, label: r.label, path: r.path })),
      impact: impactInfo,
    });
    event.sender.send('kg:stage', '基于事实与原文生成回答…');
    const factBlock = withFacts && askFacts.length ? `【知识图谱事实】\n${askFacts.join('\n')}` : '';
    const matBlock = refs.length
      ? `【原文材料】\n${refs.map((r, i) => `材料${i + 1}（笔记·${r.label}，路径 ${r.path}）：\n${r.content}`).join('\n\n')}`
      : '';
    const messages = [
      {
        role: 'system',
        content: `${getPrompt(settings, 'graphAskPrompt')}\n\n${factBlock || '（无匹配事实）'}\n\n${matBlock || '（无匹配原文材料）'}`,
      },
      { role: 'user', content: question },
    ];
    await streamChat(event, settings, messages);
  } catch (err) {
    event.sender.send('ai:error', err.message);
  }
}

// 节点 sources（'笔记·标题'）→ 原文内容；历史存量 'Wiki·' 标签不再回溯（Wiki 功能已移除）
function collectRefs(settings, nodes, maxRefs = 4) {
  const refs = [];
  const seen = new Set();
  let notes = null;
  for (const n of nodes) {
    for (const label of n.sources || []) {
      if (refs.length >= maxRefs) break;
      try {
        if (label.startsWith('笔记·')) {
          if (!notes) notes = notesStore.getNotes();
          const note = notes.find((x) => (x.title || '') === label.slice(3));
          if (!note || seen.has('n:' + note.id)) continue;
          seen.add('n:' + note.id);
          refs.push({ kind: 'note', label: note.title, path: note.id, content: `# ${note.title}\n${note.content || ''}`.slice(0, 3000) });
        }
      } catch (_) { /* 单个材料失败不阻断其余 */ }
    }
  }
  return refs;
}

// 节点来源标签（'笔记·…'/'原始·…'）→ 可打开的目标（kind + 路径/ID），供详情面板点击跳转；
// 历史存量 'Wiki·' 标签已无对应页面，统一归为 missing
function resolveSources(settings, labels) {
  const out = [];
  let notes = null;
  let raws = null;
  for (const label of labels || []) {
    const s = String(label || '');
    try {
      if (s.startsWith('笔记·')) {
        if (!notes) notes = notesStore.getNotes();
        const name = s.slice(3).trim();
        const note = (notes || []).find((x) => (x.title || '') === name);
        out.push(note ? { label: s, kind: 'note', id: note.id, title: note.title } : { label: s, kind: 'missing' });
      } else if (s.startsWith('原始·')) {
        if (!raws) raws = require('../raws/raws').listRaws(settings) || [];
        const rel = s.slice(3).trim();
        const raw = (raws || []).find((r) => r.path === rel || r.path === 'raw/' + rel.replace(/^raw\//, ''));
        out.push(raw ? { label: s, kind: 'raw', path: raw.path, title: raw.name || rel } : { label: s, kind: 'missing' });
      } else {
        out.push({ label: s, kind: 'missing' });
      }
    } catch (_) {
      out.push({ label: s, kind: 'missing' });
    }
  }
  return out;
}

// ---------- OWL 导入 ----------
// 导入 OWL 文件：解析 → 生成 profile → 存入 kv.owlProfiles（同名覆盖）→ 源文件复制到 data/ontology/ 留存
//
// 设计文档 §4.5/§9 风险 5：优先走 protege-js（reason/owlImport.js 的 importOwlExtended），
// 它能产出 OWLOntology，从而附带 OWL 2 子语言判定（profileCheck）与导入预览（preview）；
// protege-js 不可用或解析失败时，owlImport 内部自动降级到既有正则解析器 owl.js。
// 因此这里**不再直接** require('./owl')——降级逻辑统一收敛在 owlImport 内部，避免两条路径分叉。
//
// ⚠️ 本函数是 async：IPC 侧必须 await（graph:importOwl 已是 async handler）。
async function importOwl(filePath, opts) {
  const path = require('path');
  const fs = require('fs');
  const R = reason();
  let parsed;
  if (R && R.owlImport && typeof R.owlImport.importOwlExtended === 'function') {
    parsed = await R.owlImport.importOwlExtended(filePath, opts || {});
  } else {
    // 推理层整体不可用时的最后兜底：直接用 owl.js（与旧行为一致）
    const { parseOwlFile } = require('./owl');
    const { profile, report } = parseOwlFile(filePath, opts);
    parsed = { profile, report, via: 'owl.js', profileCheck: null, preview: null };
  }
  const { profile, report } = parsed;
  const kv = readOntologyKv();
  kv.owlProfiles = kv.owlProfiles || [];
  const idx = kv.owlProfiles.findIndex((p) => p.id === profile.id);
  if (idx >= 0) kv.owlProfiles[idx] = profile; else kv.owlProfiles.push(profile);
  persistOntologyKv(kv);
  // 源文件复制到 data/ontology/ 留存（便于重新导入）
  try {
    const { dataRoot } = require('../common/paths');
    const ontoDir = path.join(dataRoot(), 'ontology');
    if (!fs.existsSync(ontoDir)) fs.mkdirSync(ontoDir, { recursive: true });
    const dest = path.join(ontoDir, path.basename(filePath));
    if (path.resolve(dest) !== path.resolve(filePath)) fs.copyFileSync(filePath, dest);
  } catch (_) { /* 留存失败不影响导入结果 */ }
  // 透传 profileCheck / preview / via，供 §6.9 导入预览弹窗展示子语言判定与降级说明
  return {
    profile,
    report,
    profileCheck: parsed.profileCheck || null,
    preview: parsed.preview || null,
    via: parsed.via || 'owl.js',
  };
}

// 删除 OWL 体系；可选连带清除该体系图谱节点
function removeOwlProfile(profileId, clearGraphNodes) {
  const kv = readOntologyKv();
  kv.owlProfiles = kv.owlProfiles || [];
  const idx = kv.owlProfiles.findIndex((p) => p.id === profileId);
  if (idx < 0) return { ok: false, error: '体系不存在' };
  const removed = kv.owlProfiles.splice(idx, 1)[0];
  persistOntologyKv(kv);
  let clearedNodes = 0;
  if (clearGraphNodes) {
    const g = getGraph();
    const before = g.nodes.length;
    const nodes = g.nodes.filter((n) => n.profile !== profileId);
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges = g.edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));
    saveGraph(nodes, edges);
    clearedNodes = before - nodes.length;
  }
  return { ok: true, removed: { id: removed.id, name: removed.name }, clearedNodes };
}

// domain（模版 id）→ 知识图谱显示名。general → 「通用（未匹配领域）」。
// 带缓存的惰性 require：templates 依赖本模块的 resolveOntology，顶层 require 会循环依赖。
let _domainLabelCache = null;
function domainLabelOf(domain) {
  const d = (domain && String(domain).trim()) || 'general';
  if (d === 'general') return '通用（未匹配领域）';
  if (!_domainLabelCache) {
    _domainLabelCache = new Map();
    try {
      for (const t of require('./templates').listTemplates()) _domainLabelCache.set(t.id, t.name || t.id);
    } catch (_) { /* 模版模块不可用时回退到 domain 原值 */ }
  }
  return _domainLabelCache.get(d) || d;
}

// ---------- 两级范围：体系 → 具体知识图谱 ----------
// 列出「有抽取节点」的具体知识图谱分组，供问答范围二级选择。
// 维度：profile（体系）→ 其下按 domain（领域/图谱）分组；domain 为空归入 (general)。
// 返回 [{ id: `${profile}|${domain}`, profile, profileName, domain, label, nodeCount, edgeCount }]
function listGraphScopes() {
  const g = getGraph();
  const profiles = listProfiles();
  const nameOf = (pid) => { const p = profiles.find((x) => x.id === pid); return p ? (p.name || pid) : pid; };
  // 领域中文名映射统一走模块级 domainLabelOf（带缓存）
  const groups = new Map(); // key -> scope
  const nodeIds = new Map(); // key -> Set(nodeId) 用于数边
  for (const n of g.nodes || []) {
    if (!n) continue;
    const profile = n.profile || 'bfo-lite';
    const domain = (n.domain && String(n.domain).trim()) || 'general';
    const key = `${profile}|${domain}`;
    if (!groups.has(key)) {
      groups.set(key, {
        id: key, profile, profileName: nameOf(profile), domain,
        label: domainLabelOf(domain),
        nodeCount: 0, edgeCount: 0,
      });
      nodeIds.set(key, new Set());
    }
    groups.get(key).nodeCount += 1;
    nodeIds.get(key).add(n.id);
  }
  for (const e of g.edges || []) {
    if (!e) continue;
    for (const [key, ids] of nodeIds) {
      if (ids.has(e.from) && ids.has(e.to)) { groups.get(key).edgeCount += 1; }
    }
  }
  return [...groups.values()].sort((a, b) => b.nodeCount - a.nodeCount);
}

// 把二级范围 id（profile|domain 或 profile|* 或 all）解析成节点过滤谓词
// 直接返回 pred(node)=>bool；all/空 = 不过滤（null）
function scopeFilter(scope) {
  if (!scope || scope === 'all') return null;
  const s = String(scope);
  // 多选：逗号分隔若干 scope id
  const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
  if (!parts.length || parts.includes('all')) return null;
  const conds = parts.map((p) => {
    const [profile, domain] = p.split('|');
    // 对空节点（undefined/null）一律视为不匹配，避免谓词在稀疏数组/查找未命中时抛 TypeError
    if (!domain || domain === '*') return (n) => !!n && (n.profile || 'bfo-lite') === profile;
    if (domain === 'general') return (n) => !!n && (n.profile || 'bfo-lite') === profile && !(n.domain && String(n.domain).trim());
    return (n) => !!n && (n.profile || 'bfo-lite') === profile && String(n.domain || '') === domain;
  });
  return (n) => conds.some((c) => c(n));
}

// ===========================================================================
// 推理层对外接口（设计文档 §4–§6）
//
// 设计约束 D3：推理结果一律**返回给本模块**，由 saveGraph 单点落库；
//             reason/ 下的模块绝不直接写 kv。
// 设计约束 D4：推理是**批处理**（抽取后自动一次 / 用户手动点一次），不做实时增量。
// ===========================================================================

/** 推理层总体状态，供前端置灰入口（§6.11）与「推理」Tab 头部（§6.6）。 */
function reasonStatus() {
  const ready = reasonReady();
  const r = reason();
  let coverage = null;
  if (ready && r && r.guard) {
    try {
      const kv = readOntologyKv();
      coverage = r.guard.coverage(resolveOntology(kv.profileId || 'bfo-lite'));
    } catch (_) { coverage = null; }
  }
  // DL 生效配置（融合设计 §12）：嵌在 coverage.dl 下，**不新增顶层键**
  // （test/graph-reason-integration.test.js:75 断言 reasonStatus() 恰好 5 个字段）。
  if (coverage && typeof coverage === 'object') {
    try { coverage.dl = dlConfigSnapshot(); } catch (_) { /* 降级态下不阻断状态查询 */ }
  }
  return {
    available: ready,
    enabled: reasonEnabled(readSettingsSafe()),
    reason: ready ? '' : reasonUnavailableReason(),
    timeoutSec: reasonTimeoutSec(readSettingsSafe()),
    coverage,
  };
}

// settings 读取的容错包装：设置模块异常时回退空对象，
// 让推理入口按「默认开」处理，而不是整个图谱页崩掉
function readSettingsSafe() {
  try { return require('../common/settings').getSettings() || {}; } catch (_) { return {}; }
}

/**
 * 手动跑一次全图物化推理（§6.6「立即推理」按钮）。
 *
 * 多体系共存：图里可能同时有 bfo-lite / bfo / owl:xxx 的节点。
 * 谓词特性（传递/对称/互逆）是**按体系**声明的，跨体系混在一起物化会张冠李戴，
 * 因此按 profile 分组、各跑各的子图，最后把推理边一次性并入全量原始边数组
 * （inferredFrom 的下标必须相对最终数组，见 mergeInferredEdges）。
 *
 * @param {object} [settings]
 * @param {object} [opts] {onProgress, signal, maxRounds, timeoutMs, profileId}
 * @returns {Promise<{ok:boolean, skipped?:boolean, skipReason?:string, error?:string,
 *                    inferredEdges?:number, bound?:number, dropped?:number,
 *                    inconsistencies?:Array, stats?:object, perProfile?:Array, total?:object}>}
 */
async function runInference(settings, opts = {}) {
  const s = settings || readSettingsSafe();
  if (!reasonReady()) return { ok: false, skipped: true, skipReason: 'reasoner-unavailable', error: reasonUnavailableReason() };
  if (!reasonEnabled(s)) return { ok: false, skipped: true, skipReason: 'disabled', error: '推理功能已在设置中关闭' };
  const R = reason();
  const g = getGraph();
  if (!g.nodes.length) return { ok: false, skipped: true, skipReason: 'empty-graph', error: '图谱为空' };

  const report = (phase, pct) => {
    if (typeof opts.onProgress === 'function') { try { opts.onProgress({ phase, pct }); } catch (_) {} }
  };
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : reasonTimeoutSec(s) * 1000;

  // DL 生效配置（融合设计 §12）：开关 / 默认深度 / 规模上限全部来自 settings，
  // 但 opts 里的显式值优先——「运行深度推理」按钮传 {deep:true} 单次覆盖，测试传 opts.limits 亦如此。
  // ⚠️ dlEnabled 只在**用户显式关闭**时传 false，模块缺失时传 undefined：
  //    后者必须继续走 infer.js 的 'dl-unavailable' 分支（既有原因码语义不变，
  //    SKIP_REASON_TEXT 15 键硬契约不动，'dl-disabled' 只由前端 reasonSkipText 解释）。
  const dlOff = !!(s && s.dlEnabled === false);
  const dlLimitsS = dlLimitsFromSettings(s);
  const dlDeep = opts.deep !== undefined ? !!opts.deep : dlDeepDefault(s);
  const dlMaxEdges = opts.maxDlEdges !== undefined ? opts.maxDlEdges : dlLimitsS.maxInferredEdges;
  const dlLimits = { ...dlLimitsS, ...(opts.limits || {}) };

  // 只保留原始边作为推理输入（§5.4：上一轮推理产物本轮重算）
  const rawEdges = (g.edges || []).filter((e) => e && e.from && e.to && !e.inferred);
  const nodeById = new Map(g.nodes.map((n) => [n && n.id, n]));

  // 按 profile 分组
  const groups = new Map(); // pid -> {nodes:[], nodeIds:Set}
  for (const n of g.nodes || []) {
    if (!n || !n.id) continue;
    const pid = String(n.profile || String(n.id).split(':')[0] || 'bfo-lite');
    if (!groups.has(pid)) groups.set(pid, { nodes: [], nodeIds: new Set() });
    const grp = groups.get(pid);
    grp.nodes.push(n);
    grp.nodeIds.add(n.id);
  }
  // 显式指定 profileId 时只跑该体系
  const pids = opts.profileId ? [...groups.keys()].filter((p) => p === opts.profileId) : [...groups.keys()];

  const perProfile = [];
  const allInferred = [];
  const allInconsistencies = [];
  // domain（模版 id）→ 知识图谱显示名，供冲突归属标注
  const scopeLabelOf = domainLabelOf;
  let gi = 0;
  for (const pid of pids) {
    gi++;
    const grp = groups.get(pid);
    if (!grp || !grp.nodes.length) continue;
    let prof = null;
    try { prof = resolveOntology(pid); } catch (_) { prof = null; }
    if (!prof) { perProfile.push({ profileId: pid, skipped: true, skipReason: 'unknown-profile' }); continue; }
    // 子图：两端都属于该体系的边
    const subEdges = rawEdges.filter((e) => grp.nodeIds.has(e.from) && grp.nodeIds.has(e.to));
    report(`推理体系「${prof.name || pid}」（${gi}/${pids.length}）…`, Math.round((gi / pids.length) * 100));
    let mat;
    try {
      mat = await R.infer.materializeGraph({ nodes: grp.nodes, edges: subEdges }, prof, {
        timeoutMs,
        maxRounds: opts.maxRounds,
        signal: opts.signal || null,
        scopeLabelOf,
        // DL 深度推理（融合设计 §4.4/§6.1/§12）：深度扫描由设置项 dlDeep 决定默认值，
        // 调用方可用 opts.deep 单次覆盖（「运行深度推理」按钮）。
        // dlEnabled=false 时传 dlEnabled:false → infer.js 跳过整个 DL 阶段（RL 结论不变）。
        // 规模上限来自设置（dlLimitsFromSettings），opts.limits 仍可再覆盖（测试用）。
        dlEnabled: dlOff ? false : undefined,
        deep: dlDeep,
        maxDlEdges: dlMaxEdges,
        limits: dlLimits,
        onProgress: (info) => report(info && info.phase ? `[${prof.name || pid}] ${info.phase}` : '', info && info.pct),
      });
    } catch (err) {
      perProfile.push({ profileId: pid, profileName: prof.name, skipped: true, skipReason: 'exception', error: String((err && err.message) || err) });
      continue;
    }
    if (mat.skipped) {
      perProfile.push({ profileId: pid, profileName: prof.name, skipped: true, skipReason: mat.skipReason, stats: mat.stats || null });
      continue;
    }
    allInferred.push(...(mat.inferredEdges || []));
    for (const c of (mat.inconsistencies || [])) allInconsistencies.push({ ...c, profileId: pid, profileName: prof.name });
    perProfile.push({
      profileId: pid, profileName: prof.name, skipped: false,
      inferredEdges: (mat.inferredEdges || []).length,
      inconsistencies: (mat.inconsistencies || []).length,
      stats: mat.stats,
      // DL 子对象（融合设计 §4.5 改动点 3）：嵌进 perProfile 条目，不增顶层键
      dl: (mat.stats && mat.stats.dl) || null,
    });
  }

  const ran = perProfile.filter((p) => !p.skipped);
  if (!ran.length) {
    const first = perProfile[0] || {};
    setGraphMeta({ inferredStale: false, lastStats: { skipped: true, skipReason: first.skipReason || 'no-rule-fuel', at: Date.now() } });
    return { ok: true, skipped: true, skipReason: first.skipReason || 'no-rule-fuel', perProfile, total: countInferredSafe(g) };
  }

  const merged = R.infer.mergeInferredEdges(rawEdges, allInferred);
  saveGraph(g.nodes, merged.edges);
  const stats = {
    inferredEdges: merged.edges.length - rawEdges.length,
    bound: merged.bound,
    dropped: merged.dropped,
    inconsistencies: allInconsistencies.length,
    rounds: ran.reduce((a, p) => a + ((p.stats && p.stats.rounds) || 0), 0),
    elapsedMs: ran.reduce((a, p) => a + ((p.stats && p.stats.elapsedMs) || 0), 0),
    profiles: ran.length,
    skippedProfiles: perProfile.length - ran.length,
  };
  // DL 汇总（融合设计 §4.5 改动点 3 / §6.1）：只嵌进 lastStats.dl，**不进顶层返回值**
  // （顶层 12 键是 T1-f 硬契约，DG6：绝不新增顶层键）。
  // 前端「DL 深度推理」区块靠它显示上次运行的一致性/不可满足类/ABox 推理边数，
  // 不必再跑一次 dlHierarchy。逐体系明细仍在 perProfile[i].dl（perProfile 是自由形态数组）。
  const dlSummary = summarizeDl(perProfile);
  setGraphMeta({
    lastInferredAt: Date.now(),
    inferredStale: false,
    // inconsistencyDetails 是「推理」Tab 冲突区块的数据源（§6.6）：
    // lastStats.inconsistencies 只存条数（前端徽标用），明细单独存且限量，
    // 避免一次大推理产生上千条冲突把 kv 撑爆。
    lastStats: { skipped: false, ...stats, dl: dlSummary, inconsistencyDetails: capInconsistencies(allInconsistencies), at: Date.now() },
  });
  return { ok: true, skipped: false, ...stats, inconsistencies: allInconsistencies, perProfile, total: countInferredSafe(getGraph()) };
}

// 把 perProfile[i].dl（infer.js 的 dlStats）汇总成一条全局摘要。
// 口径：ran=任一体系真跑了 DL；consistent=全部一致才为 true（有一个 false 即 false，
// 全没跑则为 null）；unsatCount/dlInferred 求和；skipReasons 去重收集（前端查
// SKIP_REASON_TEXT 出中文）；elapsedMs 求和。
function summarizeDl(perProfile) {
  const list = (Array.isArray(perProfile) ? perProfile : []).map((p) => p && p.dl).filter(Boolean);
  const out = { ran: false, consistent: null, unsatCount: 0, dlInferred: 0, elapsedMs: 0, skipReasons: [], profiles: 0 };
  if (!list.length) return out;
  out.profiles = list.filter((d) => d.ran).length;
  out.ran = out.profiles > 0;
  for (const d of list) {
    if (d.ran) {
      if (d.consistent === false) out.consistent = false;
      else if (d.consistent === true && out.consistent === null) out.consistent = true;
    }
    out.unsatCount += Number(d.unsatCount) || 0;
    out.dlInferred += Number(d.dlInferred) || 0;
    out.elapsedMs += Number(d.elapsedMs) || 0;
    const sr = String(d.skipReason || '');
    if (sr && !out.skipReasons.includes(sr)) out.skipReasons.push(sr);
    if (d.error && !out.skipReasons.includes('dl-error')) out.skipReasons.push('dl-error');
  }
  return out;
}

function countInferredSafe(g) {
  const R = reason();
  if (!R || !R.infer) return { total: (g.edges || []).length, inferred: 0, raw: (g.edges || []).length, byVia: {} };
  try { return R.infer.countInferred(g); } catch (_) { return { total: (g.edges || []).length, inferred: 0, raw: (g.edges || []).length, byVia: {} }; }
}

// 冲突明细限量落库（§6.6「推理」Tab 冲突区块的数据源）。
// 只保留前 50 条 + 总数，避免大推理产生上千条冲突把 kv 撑爆；
// 每条保留 UI 需要的字段（rule/message/中文说明/归属体系与知识图谱）
// + 修复定位需要的 nodeIds/raw（repair.js 靠 raw 里的谓词 IRI 与 nodeIds 找到具体边）。
const INCONSISTENCY_DETAIL_CAP = 50;
function capInconsistencies(list) {
  const arr = Array.isArray(list) ? list : [];
  return {
    total: arr.length,
    truncated: arr.length > INCONSISTENCY_DETAIL_CAP,
    items: arr.slice(0, INCONSISTENCY_DETAIL_CAP).map((c) => ({
      rule: (c && c.rule) || '',
      message: (c && c.message) || '',
      messageZh: (c && c.messageZh) || '',
      reasonZh: (c && c.reasonZh) || '',
      profileId: (c && c.profileId) || '',
      profileName: (c && c.profileName) || '',
      nodeIds: ((c && c.nodeIds) || []).slice(0, 10),
      raw: String((c && c.raw) || '').slice(0, 400),
      nodeNames: (c && c.nodeNames) || [],
      scopes: ((c && c.scopes) || []).map((s) => ({ profile: s.profile, domain: s.domain, label: s.label })),
    })),
  };
}

/**
 * 「推理」Tab 的一次性数据（§6.6 四个区块）：
 * 上次运行 / 语义冲突 / 护栏日志 / 谓词特性。
 */
function getReasonState(profileId) {
  const meta = getGraphMeta();
  const g = getGraph();
  const counts = countInferredSafe(g);
  const st = reasonStatus();
  const R = reason();
  let features = [];
  let cov = null;
  try {
    const pid = profileId || readOntologyKv().profileId || 'bfo-lite';
    const prof = resolveOntology(pid);
    if (R && R.guard) {
      cov = R.guard.coverage(prof);
      features = predicateFeatures(pid);
    }
    // DL 能力子键（融合设计 §4.5 改动点 4）：嵌进既有 coverage 对象，不增顶层键
    // （getReasonState 11 键 / IPC 12 键硬契约不变）。前端据此决定是否渲染第 6 区块。
    if (cov && typeof cov === 'object') {
      cov.dlCapable = !!(prof && prof.dlCapable && R && R.dl && typeof R.dl.dlAvailable === 'function' && R.dl.dlAvailable());
      // DL 生效配置（融合设计 §12）：设置页的开关/深度/上限在「推理」Tab 的 DL 区块回显，
      // 让「门控分母」不再靠前端硬编码默认值。同样嵌在 coverage 下，不增顶层键。
      try { cov.dl = dlConfigSnapshot(); } catch (_) { /* 降级态下不阻断 */ }
    }
  } catch (_) { /* 体系解析失败时留空，不影响其余区块 */ }
  return {
    available: st.available,
    enabled: st.enabled,
    unavailableReason: st.reason,
    timeoutSec: st.timeoutSec,
    meta,
    counts,
    coverage: cov,
    features,
    lastInconsistencies: (meta.lastStats && meta.lastStats.inconsistencies) || 0,
    // 修复入口状态（冲突自动处理方案2/3）：LLM 仲裁开关 + 是否有撤销点
    repairLlm: repairLlmEnabled(readSettingsSafe()),
    repairUndoAvailable: repairUndoAvailable(),
  };
}

/**
 * 谓词特性表（§6.6 区块 4）：把「体系声明了什么」摊平给用户看，
 * 解释为什么某些边会被推理出来、某些不会。
 * 数据来源是 normalizeProfile —— 它同时合并 predicates[].features 与 axioms[]，
 * 单看任一处都会漏（实测 iso15926.composedOf 只有公理、没有 features 字段）。
 */
function predicateFeatures(profileId) {
  const R = reason();
  if (!R || !R.bridge) return [];
  const pid = profileId || readOntologyKv().profileId || 'bfo-lite';
  let prof;
  try { prof = resolveOntology(pid); } catch (_) { return []; }
  let m;
  try { m = R.bridge.normalizeProfile(prof); } catch (_) { return []; }
  const out = [];
  for (const p of m.predicates) {
    const feats = [...(m.features.get(p.key) || [])];
    // ⚠️ inverseOf / domain / range 的值都是 **Set**（见 bridge.normalizeProfile），
    //    必须展开成数组才能 JSON 序列化过 IPC，否则前端拿到 {} 空对象。
    const invs = [...(m.inverseOf.get(p.key) || [])];
    const dom = [...(m.domain.get(p.key) || [])];
    const rng = [...(m.range.get(p.key) || [])];
    if (!feats.length && !invs.length && !dom.length && !rng.length) continue;
    out.push({
      key: p.key,
      label: p.label || p.key,
      features: feats,
      inverseOf: invs,
      domain: dom,
      range: rng,
      domainLabels: dom.map((k) => m.classLabel.get(k) || k),
      rangeLabels: rng.map((k) => m.classLabel.get(k) || k),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// DL 深度推理编排（dl-js-reasoner 融合设计 §4.5 改动点 5）
//
// 三个交互式入口（IPC 通道 graph:dlQuery / graph:dlEntail / graph:dlHierarchy）：
// 均为**只读**——不落库、不写 kv（I4），每次现合成 DL 本体（TBox+ABox）后查询。
// dl 模块缺失/体系非 dlCapable/规模超限时返回 {ok:false, reason:'dl-*'}，
// 前端按 SKIP_REASON_TEXT 同码文案提示。
// ---------------------------------------------------------------------------

/** 解析 DL 推理上下文：体系 + 门控 + 合成本体。失败返回 {ok:false, reason}。 */
function _dlContext(profileId, opts = {}) {
  const R = reason();
  // ⚠️ pid 必须在**所有**分支里都算出来并回传：失败形态也要带 profileId，
  //    否则前端拿到 {ok:false} 时无法判断是哪个体系面板失败了（多体系并存时会串台）。
  const pid = profileId || readOntologyKv().profileId || 'bfo-lite';
  // settings 必须在门控**之前**取到：DL 开关与规模上限都来自设置页（融合设计 §12）。
  const s = opts.settings || readSettingsSafe();
  const limits = { ...dlLimitsFromSettings(s), ...(opts.limits || {}) };
  if (!R || !R.dl || typeof R.dl.dlAvailable !== 'function' || !R.dl.dlAvailable()) {
    return { ok: false, pid, reason: 'dl-unavailable', error: reasonDlUnavailableReason() };
  }
  // 设置页总开关（融合设计 §12）：关闭后三个探针一律拒绝，前端按 'dl-disabled' 文案提示。
  // 该码**刻意不进** SKIP_REASON_TEXT（15 键硬契约），只由 renderer/graph.js:reasonSkipText 解释。
  if (!dlEnabled(s)) {
    return { ok: false, pid, reason: 'dl-disabled', error: 'DL 深度推理已在「设置 → 推理」中关闭' };
  }
  let prof;
  try { prof = resolveOntology(pid); } catch (err) {
    return { ok: false, pid, reason: 'unknown-profile', error: String((err && err.message) || err) };
  }
  if (!prof || !prof.dlCapable) {
    return { ok: false, pid, reason: 'dl-unavailable', error: `体系「${(prof && prof.name) || pid}」未启用 DL 推理（仅 OWL 导入的完整 DL 体系支持）` };
  }
  const g = getGraph();
  const gate = R.dl.gateScale(prof, g, limits);
  if (!gate.allowTBox) return { ok: false, pid, reason: gate.reason || 'dl-too-large', gate };
  let ont;
  try {
    ont = R.dl.buildDLOntology(prof, g, { abox: gate.allowABox, limits });
  } catch (err) {
    return { ok: false, pid, reason: 'dl-error', error: String((err && err.message) || err), gate };
  }
  const cfg = R.dl.makeConfig({ timeoutMs: reasonTimeoutSec(s) * 1000 });
  return { ok: true, pid, prof, graph: g, gate, ont, cfg, dl: R.dl };
}

/**
 * 合取查询（CQ，§4.6 通道 graph:dlQuery）。
 * @param {string} [profileId]
 * @param {object} spec  {select:['?x',…], where:[{class|objectProperty,…}]}（key 或完整 IRI）
 * @returns {{ok:boolean, reason?:string, answers?:Array, columns?:Array, isHorn?:boolean|null, elapsedMs?:number}}
 */
function dlQuery(profileId, spec) {
  const ctx = _dlContext(profileId);
  // ⚠️ 失败形态也必须带 profileId：前端三个探针面板共用一个结果渲染器，
  //    没有 profileId 就无法知道「这次失败属于哪个体系」，多体系并存时会串台。
  if (!ctx.ok) return { ok: false, reason: ctx.reason, error: ctx.error || '', profileId: ctx.pid, answers: [], columns: [], isHorn: null, elapsedMs: 0 };
  if (!ctx.gate.allowABox) return { ok: false, reason: ctx.gate.reason || 'dl-abox-budget', error: 'ABox 规模超出 DL 预算，合取查询不可用', profileId: ctx.pid, answers: [], columns: [], isHorn: null, elapsedMs: 0 };
  const res = ctx.dl.answerCQ(ctx.ont, spec, ctx.cfg);
  return { ...res, profileId: ctx.pid, gate: ctx.gate };
}

/**
 * 蕴含探针（§4.6 通道 graph:dlEntail）。
 * @param {string} [profileId]
 * @param {object} axiom  中立公理形态（见 dl.entail 的 axSpec）
 * @returns {{ok:boolean, entailed?:boolean|null, explain?:string, reason?:string}}
 */
function dlEntail(profileId, axiom) {
  const ctx = _dlContext(profileId);
  if (!ctx.ok) return { ok: false, entailed: null, explain: '', reason: ctx.reason, error: ctx.error || '', profileId: ctx.pid, elapsedMs: 0 };
  const res = ctx.dl.entail(ctx.ont, axiom, ctx.cfg);
  return { ...res, profileId: ctx.pid };
}

/**
 * 类层级 + 一致性 + 不可满足类（§4.6 通道 graph:dlHierarchy）。
 * Q-DL-3 决议：层级**不落图边**（类不是图节点，落边即僵尸边），仅作为数据返回。
 * @param {string} [profileId]
 * @returns {{ok:boolean, reason?:string, consistent?:boolean|null, hierarchy?:object|null,
 *            topClasses?:Array, unsatClasses?:Array, elapsedMs?:number}}
 */
function dlHierarchy(profileId) {
  const ctx = _dlContext(profileId);
  if (!ctx.ok) return { ok: false, reason: ctx.reason, error: ctx.error || '', profileId: ctx.pid, consistent: null, hierarchy: null, topClasses: [], unsatClasses: [], elapsedMs: 0 };
  const res = ctx.dl.reasonTBox(ctx.ont, ctx.cfg);
  if (res.skipped) return { ok: false, reason: res.skipReason || 'dl-error', error: res.error || '', profileId: ctx.pid, consistent: null, hierarchy: null, topClasses: [], unsatClasses: [], elapsedMs: res.elapsedMs };
  // 附类中文名（前端树展示用）
  const labels = {};
  for (const c of (ctx.prof.classes || [])) if (c && c.key) labels[c.key] = c.label || c.key;
  return {
    ok: true, profileId: ctx.pid,
    consistent: res.consistent,
    hierarchy: res.hierarchy,
    topClasses: res.topClasses,
    unsatClasses: res.unsatClasses,
    labels,
    elapsedMs: res.elapsedMs,
    stats: res.stats,
  };
}

/**
 * DL 合取查询召回（融合设计 §6.2）：把 kgAsk stage 1 的实体识别结果转成 CQ 原子，
 * 用 dl-js-reasoner 的 datalog 引擎问「按公理应当成立」的属性关系，补 BFS 的盲区。
 *
 * BFS 只沿图里已画的边走；DL 能补上传递闭包 / 互逆 / 对称 / 属性链 / domain·range
 * 触发的关系。答案渲染成与 BFS **完全同口径**的事实串
 * （`[profile·type]名称 —rel→ [profile·type]名称`），上层 factKey 去重因此能直接吃掉重复项。
 *
 * 全程只读（I4）：不落库、不写 kv、不改图。任何前置条件不满足都返回 `{facts:[]}`，
 * 调用方按 BFS 原样继续（I5 静默降级）。
 *
 * @param {object} g  当前图（getGraph()）
 * @param {Array} seeds  stage 1 命中的种子节点
 * @param {object} [opts]  {settings, entityPid, limits, send(stageMsg)}
 * @returns {{facts:Array<string>, info:Array<object>|null}}
 */
function dlRecallFacts(g, seeds, opts = {}) {
  const none = { facts: [], info: null };
  if (!Array.isArray(seeds) || !seeds.length) return none;
  if (!reasonEnabled(opts.settings)) return none;   // §6.11 总开关关闭 → DL 召回也不跑
  if (!dlEnabled(opts.settings)) return none;       // §12 DL 开关关闭 → 召回同样不跑（问答退回 BFS）
  const R = reason();
  if (!R || !R.dl || typeof R.dl.answerCQs !== 'function' || !R.dl.dlAvailable()) return none;
  // 规模上限来自设置页；opts.limits（测试用）优先
  const limits = { ...dlLimitsFromSettings(opts.settings), ...(opts.limits || {}) };

  const nodes = (g && g.nodes) || [];
  const edges = (g && g.edges) || [];
  const byId = new Map();
  for (const n of nodes) if (n && n.id) byId.set(n.id, n);

  // 种子按体系分组（多体系共存时各用自己的谓词表；口径同影响面扩展）
  const pidOf = (n) => String(n.profile || (String(n.id || '').split(':')[0]) || opts.entityPid || 'bfo-lite');
  const byProfile = new Map();
  for (const s of seeds) {
    const pid = pidOf(s);
    if (!byProfile.has(pid)) byProfile.set(pid, []);
    byProfile.get(pid).push(s);
  }

  const send = typeof opts.send === 'function' ? opts.send : () => {};
  const MAX_SEEDS_PER_PROFILE = 5;   // 与影响面扩展同口径，防止 CQ 数量爆炸
  const MAX_SPECS = 150;
  const out = [];
  const infos = [];

  for (const [pid, list] of byProfile) {
    let prof = null;
    try { prof = resolveOntology(pid); } catch (_) { prof = null; }
    // 内置体系（bfo-lite 等）dlCapable=false：RL 物化已覆盖其全部规则，不必合成 DL 本体
    if (!prof || !prof.dlCapable) continue;

    const gate = R.dl.gateScale(prof, g, limits);
    if (!gate.allowABox) continue;   // CQ 需要 ABox；规模超预算则跳过（TBox 级对召回无贡献）

    let ont = null;
    try { ont = R.dl.buildDLOntology(prof, g, { abox: true, limits }); } catch (_) { continue; }
    if (!ont || !ont.abox) continue;

    // 图里已存在的边（规范 rel key）：DL 答案命中这些就不必再报，省提示词额度。
    // relDisplay 把规范 key 映射回图里实际存的 rel 串（可能是中文别名），
    // 保证 DL 事实与 BFS 事实**字面同口径**，上层 factKey 去重才吃得掉。
    const m = R.bridge.normalizeProfile(prof);
    const have = new Set();
    const relDisplay = new Map();
    for (const e of edges) {
      if (!e || !e.from || !e.to) continue;
      const key = m.relAlias.get(e.rel) || e.rel;
      have.add(R.bridge.edgeKey(e.from, e.to, key));
      if (!relDisplay.has(key)) relDisplay.set(key, e.rel);
    }

    // 每个种子 × 每个谓词：出向 + 入向各一条 CQ
    const specs = [];
    const meta = [];   // 与 specs 一一对应：{seedId, rel, dir}
    for (const seed of list.slice(0, MAX_SEEDS_PER_PROFILE)) {
      for (const rel of ont.propertyKeys) {
        if (specs.length >= MAX_SPECS) break;
        specs.push({ select: ['?o'], where: [{ objectProperty: rel, subject: seed.id, object: '?o' }] });
        meta.push({ seedId: seed.id, rel, dir: 'out' });
        if (specs.length >= MAX_SPECS) break;
        specs.push({ select: ['?s'], where: [{ objectProperty: rel, subject: '?s', object: seed.id }] });
        meta.push({ seedId: seed.id, rel, dir: 'in' });
      }
      if (specs.length >= MAX_SPECS) break;
    }
    if (!specs.length) continue;

    const res = R.dl.answerCQs(ont, specs, R.dl.makeConfig({ timeoutMs: reasonTimeoutSec(opts.settings) * 1000 }));
    if (!res || !res.ok) {
      infos.push({ profileId: pid, ok: false, reason: (res && res.reason) || 'dl-error', specs: specs.length, facts: 0 });
      continue;
    }
    const tag = (n) => `[${(n && n.profile) || pid}·${(n && n.type) || '?'}]`;
    let added = 0;
    (res.results || []).forEach((one, i) => {
      if (!one || !one.ok) return;
      const mm = meta[i] || {};
      const relKey = mm.rel;
      const relText = relDisplay.get(relKey) || relKey;
      for (const row of (one.answers || [])) {
        const cell = row && row[0];
        if (!cell || cell.kind !== 'individual') continue;   // 只收个体答案（变量/字面量不入事实）
        const a = byId.get(mm.seedId);
        const b = byId.get(cell.value);
        if (!a || !b || a === b) continue;
        const from = mm.dir === 'out' ? a : b;
        const to = mm.dir === 'out' ? b : a;
        if (have.has(R.bridge.edgeKey(from.id, to.id, relKey))) continue;   // 图里已有 → BFS 已覆盖
        out.push(`${tag(from)}${from.name} —${relText}→ ${tag(to)}${to.name}（⚡DL 推理）`);
        added++;
      }
    });
    infos.push({ profileId: pid, ok: true, isHorn: res.isHorn, specs: specs.length, facts: added, elapsedMs: res.elapsedMs });
  }

  const facts = [...new Set(out)].slice(0, 40);
  if (infos.length) {
    send(facts.length
      ? `DL 合取查询召回完成：${infos.reduce((a, x) => a + (x.specs || 0), 0)} 条查询 → ${facts.length} 条 BFS 未覆盖的推理事实`
      : 'DL 合取查询召回完成：未发现图外的新关系（BFS 已覆盖全部可推理事实）');
  }
  return { facts, info: infos.length ? infos : null };
}

/** 清除全部推理边（§9 风险 3 的「清除所有推理边」按钮）。 */
function clearInferredEdges() {
  const R = reason();
  const g = getGraph();
  if (!R || !R.infer) {
    // 推理层不可用时也要能清：直接按 inferred 标记过滤，不依赖 infer.js
    const kept = (g.edges || []).filter((e) => e && !e.inferred);
    const removed = (g.edges || []).length - kept.length;
    saveGraph(g.nodes, kept);
    setGraphMeta({ lastInferredAt: 0, inferredStale: false });
    return { ok: true, removed, total: kept.length };
  }
  const res = R.infer.stripInferred(g);
  saveGraph(g.nodes, res.edges);
  setGraphMeta({ lastInferredAt: 0, inferredStale: false });
  return { ok: true, removed: res.removed, total: res.edges.length };
}

/**
 * 删除一条边并级联清理依赖它的推理边（§5.3）。
 * @param {number} edgeIdx  当前 graph.edges 数组下标
 */
function deleteEdgeWithCascade(edgeIdx) {
  const g = getGraph();
  const idx = Number(edgeIdx);
  if (!Number.isInteger(idx) || idx < 0 || idx >= (g.edges || []).length) return { ok: false, error: '边下标越界' };
  const target = g.edges[idx];
  const R = reason();
  let removed = 1, cascaded = 0, kept;
  if (R && R.infer) {
    const res = R.infer.removeEdgeWithCascade(g, idx);
    removed = res.removed; cascaded = res.cascaded; kept = res.edges;
  } else {
    kept = g.edges.filter((_, i) => i !== idx);
  }
  saveGraph(g.nodes, kept);
  // §5.4：删除后推理结果不再完整 → 标记过期，UI 提示「图谱已变更，建议重新推理」
  setGraphMeta({ inferredStale: true });
  return { ok: true, removed, cascaded, total: kept.length, edge: target ? { from: target.from, to: target.to, rel: target.rel } : null };
}

/** 删除一个节点并级联清理（§5.3）。 */
function deleteNodeWithCascade(nodeId) {
  const g = getGraph();
  const id = String(nodeId || '');
  if (!id) return { ok: false, error: '未指定节点' };
  const before = (g.nodes || []).length;
  const nodes = (g.nodes || []).filter((n) => n && n.id !== id);
  if (nodes.length === before) return { ok: false, error: '节点不存在：' + id };
  const R = reason();
  let removed = 0, cascaded = 0, kept;
  if (R && R.infer) {
    const res = R.infer.removeNodeWithCascade(g, id);
    removed = res.removed; cascaded = res.cascaded;
    kept = (g.edges || []).filter((e) => e && e.from !== id && e.to !== id);
  } else {
    kept = (g.edges || []).filter((e) => e && e.from !== id && e.to !== id);
    removed = (g.edges || []).length - kept.length;
  }
  saveGraph(nodes, kept);
  setGraphMeta({ inferredStale: true });
  return { ok: true, nodeId: id, removedEdges: removed, cascaded, nodeCount: nodes.length, edgeCount: kept.length };
}

/**
 * 单节点影响面（§6.5 实体详情面板的「影响面」区块）。
 * @param {string} nodeId
 * @param {object} [opts] {maxDepth, maxNodes, direction, followSymmetric, includeInferred}
 */
function impactClosureFor(nodeId, opts = {}) {
  const R = reason();
  if (!R || !R.impact) return { ok: false, error: reasonUnavailableReason() || '推理模块不可用' };
  const g = getGraph();
  const id = String(nodeId || '');
  const seed = (g.nodes || []).find((n) => n && n.id === id);
  if (!seed) return { ok: false, error: '节点不存在：' + id };
  const pid = String(seed.profile || id.split(':')[0] || 'bfo-lite');
  let prof;
  try { prof = resolveOntology(pid); } catch (err) { return { ok: false, error: '体系解析失败：' + err.message }; }
  let rel;
  try { rel = R.impact.impactRelations(prof); } catch (_) { rel = { transitive: [], symmetric: [], inverseOf: {}, usable: false }; }
  if (!rel || !rel.usable) {
    return { ok: true, usable: false, profileId: pid, profileName: prof.name, nodes: [], facts: [], summary: '',
      hint: '该体系未声明传递/互逆谓词，无法做影响面闭包' };
  }
  let impacted;
  try {
    impacted = R.impact.impactClosure(g, prof, id, {
      maxDepth: opts.maxDepth,
      maxNodes: opts.maxNodes,
      direction: opts.direction || 'downstream',
      followSymmetric: !!opts.followSymmetric,
      includeInferred: opts.includeInferred !== false,
    });
  } catch (err) { return { ok: false, error: '闭包计算失败：' + err.message }; }
  let facts = [];
  try { facts = R.impact.impactToFacts(g, seed, impacted, { limit: Number(opts.limit) || 40 }); } catch (_) {}
  let summary = '';
  try { summary = R.impact.impactSummary(prof, impacted, {}); } catch (_) {}
  return {
    ok: true, usable: true,
    profileId: pid, profileName: prof.name,
    seed: { id: seed.id, name: seed.name, type: seed.type },
    nodes: impacted,
    facts,
    summary,
    inferredCount: impacted.filter((x) => x && x.inferred).length,
  };
}

/**
 * OWL 导入预览（§6.9）：只解析不落库，让用户先看到类/谓词/子语言判定/降级说明，
 * 再决定是否真正导入（真正导入走 importOwl）。
 */
async function previewOwlImport(filePath, opts = {}) {
  const R = reason();
  if (R && R.owlImport && typeof R.owlImport.importOwlExtended === 'function') {
    const res = await R.owlImport.importOwlExtended(filePath, { ...opts, previewOnly: true });
    return { ok: true, ...res };
  }
  const { parseOwlFile } = require('./owl');
  const { profile, report } = parseOwlFile(filePath, opts);
  // filePath 透传（与 owlImport 路径一致）：前端「确认导入」复用它，避免二次弹文件对话框
  return { ok: true, profile, report, profileCheck: null, preview: null, via: 'owl.js', filePath };
}

/**
 * 体系化导入预览（bundle）：解析主本体 → 推断/获取依赖 → 合并为单一体系，只解析不落库。
 * 让用户先看到「依赖清单（本地/已下载/缺失）+ 合并后类/谓词计数 + 中英对照覆盖」，再决定是否导入。
 * @param {object} payload { mainPath, displayName?, download?, discover?, deps? }
 * @param {object} [opts]  { forceLegacy, _downloadImpl, timeoutMs }
 */
async function previewBundleImport(payload, opts = {}) {
  const R = reason();
  if (!R || !R.ontologyBundle || typeof R.ontologyBundle.importBundle !== 'function') {
    return { ok: false, error: reasonUnavailableReason() || '体系化导入模块不可用' };
  }
  try {
    const res = await R.ontologyBundle.importBundle(payload, opts);
    return { ok: true, ...res };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/**
 * 体系化导入（bundle）：合并主本体与依赖为单一 owl: 体系并落库（同名覆盖），
 * 源文件（主本体 + 已下载依赖）复制到 data/ontology/ 留存，便于重新导入。
 * @returns {Promise<{profile,report,preview,dependencies,via}>}
 */
async function importBundle(payload, opts = {}) {
  const R = reason();
  if (!R || !R.ontologyBundle || typeof R.ontologyBundle.importBundle !== 'function') {
    throw new Error(reasonUnavailableReason() || '体系化导入模块不可用');
  }
  const res = await R.ontologyBundle.importBundle(payload, opts);
  const { profile } = res;
  const kv = readOntologyKv();
  kv.owlProfiles = kv.owlProfiles || [];
  const idx = kv.owlProfiles.findIndex((p) => p.id === profile.id);
  if (idx >= 0) kv.owlProfiles[idx] = profile; else kv.owlProfiles.push(profile);
  persistOntologyKv(kv);
  // 主本体源文件复制到 data/ontology/ 留存（依赖若是下载的已直接落在该目录）
  try {
    const path = require('path');
    const fs = require('fs');
    const { dataRoot } = require('../common/paths');
    const ontoDir = path.join(dataRoot(), 'ontology');
    if (!fs.existsSync(ontoDir)) fs.mkdirSync(ontoDir, { recursive: true });
    const mainPath = res.mainPath;
    if (mainPath && fs.existsSync(mainPath)) {
      const dest = path.join(ontoDir, path.basename(mainPath));
      if (path.resolve(dest) !== path.resolve(mainPath)) fs.copyFileSync(mainPath, dest);
    }
  } catch (_) { /* 留存失败不影响导入结果 */ }
  return {
    profile,
    report: res.report,
    preview: res.preview,
    dependencies: res.dependencies,
    via: res.via || 'protege-js',
  };
}

/**
 * 全图校验（融合设计 §12.2.3 通道 C）：对已落库的整张图按指定体系重跑
 * 未知谓词 / domain / range 三类检查 + 节点不相交归属检查（cax-dw 的只读等价）。
 *
 * 边界：**只读、只报告**——不改 rel、不删边、不写 inferredStale。修复动作留给用户。
 * 不依赖推理器：reason/validate.js 纯 guard 逻辑，protege-js 缺失时照常可跑
 * （降级探针拦截 reason/* 时本入口返回 {ok:false}，不抛错）。
 *
 * @param {string} [profileId] 缺省取当前绑定体系（readOntologyKv）
 * @param {object} [opts]      { includeInferred=true, strictUnknownType=false, scope='' }
 *        opts.scope：知识图谱二级范围 id（`${profile}|${domain}`，逗号多选，空/all=不限）；
 *        校验集恒为「选定体系 ∩ 选定知识图谱」内两端点均落圈的边——
 *        多体系共存的全图里，他体系/他范围的边不再进入本次体检（避免跨体系误报与误修）
 * @returns {{ok:boolean, profileId:string, profileName:string, checked:number,
 *            violations:Array, byReason:object, byRel:object, disjointConflicts:Array,
 *            coverage:object, truncated:boolean, at:number}}  // 11 字段硬契约
 */
function validateGraph(profileId, opts = {}) {
  const R = reason();
  if (!R || !R.validate || !R.guard) {
    return { ok: false, error: reasonUnavailableReason() || '校验模块不可用', at: Date.now() };
  }
  const pid = profileId || readOntologyKv().profileId || 'bfo-lite';
  let prof;
  try { prof = resolveOntology(pid); } catch (err) {
    return { ok: false, error: String((err && err.message) || err), at: Date.now() };
  }
  const gAll = getGraph();
  // 校验范围 = 选定体系 ∩ 选定知识图谱（opts.scope，与整体图谱页二级筛选同口径）：
  // 仅两端点均落圈的边进入校验集；节点无 profile 的历史数据按 bfo-lite 计（与展示层一致）
  const sf = opts && opts.scope ? scopeFilter(opts.scope) : null;
  const nodeOk = (n) => !!n && (n.profile || 'bfo-lite') === prof.id && (!sf || sf(n));
  const byId0 = new Map((gAll.nodes || []).map((n) => [n.id, n]));
  const g = {
    nodes: gAll.nodes,
    edges: (gAll.edges || []).filter((e) => e && nodeOk(byId0.get(e.from)) && nodeOk(byId0.get(e.to))),
  };
  try {
    // 注入体系解析器：校验集内边的端点 profile 与选中体系一致（无 profile 的历史边回退选中体系），
    // 条目归属字段仍按边自身体系回填，修复规划据此解析约束
    const result = R.validate.validateGraph(g, prof, Object.assign({}, opts, { resolveProfile: (pid2) => resolveOntology(pid2) }));
    // 给越界边与不相交归属冲突补「知识图谱（domain）」的展示名（模版名），
    // 与推理 Tab 冲突列表 / listGraphScopes 口径一致；reason/ 内为纯版本回退标签
    if (result && Array.isArray(result.disjointConflicts)) {
      for (const c of result.disjointConflicts) {
        if (c) c.scopeLabel = domainLabelOf(c.domain);
      }
    }
    if (result && Array.isArray(result.violations)) {
      for (const x of result.violations) {
        if (x) x.scopeLabel = domainLabelOf(x.domain);
      }
    }
    return result;
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), at: Date.now() };
  }
}

// ===========================================================================
// 冲突自动修复（冲突自动处理方案2/3）：规划 → 应用 → 撤销
//
// 数据流：上次推理落库的 lastStats.inconsistencyDetails（capInconsistencies 产物，
//   含 nodeIds/raw）→ repair.planRepairs 生成动作清单（纯函数，不落库）
//   → 用户在 UI 预览确认 → applyRepairs 落库 + 重推理 → 冲突数应下降。
// 撤销：应用前把 nodes/edges 快照进 kv 'graph.repairUndo'，undoRepair 原样恢复。
//   只保留最近一次快照（一步撤销）——修复本身可重复执行，多步历史收益低、
//   而整图快照很占 kv。
// LLM 语义仲裁（方案3）：settings.graphRepairLlm 开启且调用方 opts.llmArbitrate
//   不为 false 时，对「降级谓词 vs 改节点类型」多解冲突征询模型；失败静默退回
//   确定性动作（repair.planOne 内部已兜底）。
// ===========================================================================
const REPAIR_UNDO_KEY = 'graph.repairUndo';

/** LLM 仲裁开关：settings.graphRepairLlm，默认关（修复要可预期，模型参与是显式选择）。 */
function repairLlmEnabled(settings) {
  return !!(settings && settings.graphRepairLlm);
}

/**
 * 规划修复动作（dry-run，不改任何数据）。
 * @param {object} [opts]
 * @param {number[]} [opts.conflictIdxs]  只规划指定下标的冲突（明细列表中的序号）；缺省全部
 * @param {boolean}  [opts.llmArbitrate]  是否允许 LLM 仲裁（还要 settings.graphRepairLlm 开启）
 * @param {boolean}  [opts.refresh]       true = 先重跑一轮推理取最新冲突再规划（默认用上次落库的明细）
 */
async function planRepairs(opts = {}) {
  const R = reason();
  if (!R || !R.repair) return { ok: false, error: reasonUnavailableReason() || '修复模块不可用' };
  const s = readSettingsSafe();
  if (!reasonEnabled(s)) return { ok: false, error: '推理功能已在设置中关闭，无法规划修复' };

  let conflicts = [];
  if (opts.refresh) {
    const r = await runInference(s, {});
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || '重推理失败，无法获取最新冲突' };
    conflicts = r.inconsistencies || [];
  } else {
    const det = (getGraphMeta().lastStats || {}).inconsistencyDetails;
    conflicts = (det && det.items) || [];
  }
  if (opts.conflictIdxs && opts.conflictIdxs.length) {
    const want = new Set(opts.conflictIdxs.map(Number));
    conflicts = conflicts.filter((_, i) => want.has(i));
  }
  if (!conflicts.length) {
    return { ok: true, actions: [], byKind: {}, autoCount: 0, manualCount: 0, conflictCount: 0, hint: '没有待修复的冲突（先运行推理/校验）' };
  }
  // 旧版本落库的冲突明细没有 nodeIds/raw（修复定位靠这两个字段），
  // 直接规划会得到「N 处冲突 → 0 个动作」的死胡同。这里显式给出可操作提示，
  // 而不是让用户对着空预览猜原因。点「一键修复」（refresh:true）或「立即推理」即可刷新明细。
  const legacyDetails = !opts.refresh && conflicts.every((c) => !c || !Array.isArray(c.nodeIds) || !c.nodeIds.length);

  const g = getGraph();
  const profCache = new Map();
  const resolveProfile = (pid) => {
    if (profCache.has(pid)) return profCache.get(pid);
    let p = null;
    try { p = resolveOntology(pid); } catch (_) { p = null; }
    profCache.set(pid, p);
    return p;
  };

  const planOpts = {};
  if (opts.llmArbitrate !== false && repairLlmEnabled(s)) {
    planOpts.arbitrate = async (q) => {
      const ans = await chatOnce(s, [
        {
          role: 'system',
          content: '你是知识图谱本体一致性仲裁器。给定一个节点与其声明类型、以及推理强制归入的候选互斥类，判断该节点语义上更应属于哪个类。只输出类名本身，不要解释。',
        },
        {
          role: 'user',
          content: `节点「${q.nodeName}」（描述：${(q.nodeDesc || '无').slice(0, 200)}）当前声明类型为「${q.nodeType}」。\n`
            + `本体冲突（${q.rule}）：${q.reasonZh}\n`
            + `推理通过边的 domain/range 把它强制归入的候选类：${q.candidates.join('、')}。\n`
            + `问题：该节点语义上更应属于「${q.nodeType}」还是候选类之一？若应改类型，从候选类中选出最贴切的一个并只输出其类名；若当前类型正确（应保留边降级方案），只输出「${q.nodeType}」。`,
        },
      ], undefined, undefined, undefined);
      return String(ans || '').trim().split(/[\n。，,;；]/)[0].trim();
    };
  }

  try {
    const plan = await R.repair.planRepairs(conflicts, g, resolveProfile, planOpts);
    const out = { ok: true, ...plan, llmArbitrate: !!planOpts.arbitrate, at: Date.now() };
    if (legacyDetails && !(out.actions || []).length) {
      out.hint = '冲突明细是旧版本推理留下的（缺少定位所需的节点信息），无法直接规划修复。请先点「立即推理」刷新，或用「一键修复」自动重推理后再规划。';
    }
    return out;
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), at: Date.now() };
  }
}

/**
 * 问题汇总表行级修复入口（v1.2.2）：入参是 validate.js 产出的问题条目子集
 * （violations / disjointConflicts 的行），dry-run 规划，不落库。
 * 与 planRepairs 的区别：不按「推理冲突明细」规划，而按「体检报告的行」规划，
 * 让用户对 195 条越界边里的某一条单独点「修复」。
 * @param {Array} issues validate.js 的 violation / disjointConflicts 条目
 */
async function planRepairsForIssues(issues) {
  const R = reason();
  if (!R || !R.repair) return { ok: false, error: reasonUnavailableReason() || '修复模块不可用' };
  const s = readSettingsSafe();
  if (!reasonEnabled(s)) return { ok: false, error: '推理功能已在设置中关闭，无法规划修复' };
  const list = Array.isArray(issues) ? issues.filter(Boolean) : [];
  if (!list.length) return { ok: true, actions: [], byKind: {}, autoCount: 0, manualCount: 0, conflictCount: 0, hint: '没有选中的问题行' };
  const g = getGraph();
  const profCache = new Map();
  const resolveProfile = (pid) => {
    if (profCache.has(pid)) return profCache.get(pid);
    let p = null;
    try { p = resolveOntology(pid); } catch (_) { p = null; }
    profCache.set(pid, p);
    return p;
  };
  try {
    const plan = await R.repair.planIssues(list, g, resolveProfile);
    return { ok: true, ...plan, llmArbitrate: false, at: Date.now() };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), at: Date.now() };
  }
}

/**
 * 应用修复动作：快照撤销点 → 施加动作 → 落库 → 重推理验证。
 * @param {Array} actions  planRepairs 返回的动作（UI 可让用户勾选子集）
 * @param {object} [opts]  { rerun=true 修复后是否立即重推理 }
 */
async function applyRepairs(actions, opts = {}) {
  const R = reason();
  if (!R || !R.repair) return { ok: false, error: reasonUnavailableReason() || '修复模块不可用' };
  const list = Array.isArray(actions) ? actions.filter((a) => a && a.kind && a.kind !== 'manual') : [];
  if (!list.length) return { ok: false, error: '没有可自动应用的动作' };
  const g = getGraph();
  let res;
  try { res = R.repair.applyActions(g, list); } catch (err) {
    return { ok: false, error: '施加动作失败：' + String((err && err.message) || err) };
  }
  if (!res.applied.length) {
    return { ok: false, error: '所有动作都无法定位目标（图谱可能已变化），请重新规划', skipped: res.skipped };
  }
  // 撤销快照：一步撤销，整图 nodes/edges（大图也就几 MB，kv 可承受；与图谱同生命周期）
  try {
    db.setKv(REPAIR_UNDO_KEY, JSON.stringify({ at: Date.now(), nodes: g.nodes, edges: g.edges }));
  } catch (_) { /* 快照失败不阻断修复，只是没有撤销点 */ }
  saveGraph(res.nodes, res.edges);
  setGraphMeta({ inferredStale: true });
  const out = {
    ok: true,
    applied: res.applied.length,
    appliedZh: res.applied.map((a) => a.actionZh || ''),
    skipped: res.skipped || [],
    nodes: res.nodes.length,
    edges: res.edges.length,
    rerun: null,
  };
  // 修复后重推理：验证冲突是否消除，并刷新推理边（§5.4 旧推理产物一律重算）
  if (opts.rerun !== false) {
    try {
      const r = await runInference(null, {});
      out.rerun = r && r.ok
        ? { skipped: !!r.skipped, inconsistencies: r.skipped ? 0 : (r.inconsistencies || []).length, inferredEdges: r.inferredEdges || 0 }
        : { skipped: true, error: (r && r.error) || '重推理失败' };
    } catch (err) {
      out.rerun = { skipped: true, error: String((err && err.message) || err) };
    }
  }
  return out;
}

/**
 * 逐动作应用修复（作业版）：与 applyRepairs 同一套语义（快照 → 施加 → 落库 → 重推理），
 * 但每个动作独立施加、独立落库、独立回调，供「图谱冲突修复」作业把每个动作呈现为一条子任务。
 * 单个动作失败/无法定位不中断整个作业：记入 failed/skipped，作业终态为 warning（部分失败）。
 * @param {Array} actions  planRepairs 产出的动作（UI 勾选后的子集）
 * @param {object} [opts]
 * @param {(i:number,status:'running'|'done'|'failed'|'skipped',output?:string)=>void} [opts.onTask]
 * @param {(done:number,total:number)=>void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]  作业停止信号：已应用的动作保留（每步已落库），剩余不再执行
 * @param {boolean} [opts.rerun]  修复后是否重推理验证（默认 true）
 */
async function applyRepairsStepwise(actions, opts = {}) {
  const R = reason();
  if (!R || !R.repair) return { ok: false, error: reasonUnavailableReason() || '修复模块不可用' };
  const list = (Array.isArray(actions) ? actions : []).filter((a) => a && a.kind && a.kind !== 'manual');
  if (!list.length) return { ok: false, error: '没有可自动应用的动作' };
  const g0 = getGraph();
  // 撤销快照先于任何改动：作业中途停止/部分失败时，仍可一步回到修复前。
  // opts.snapshot === false（单任务重跑）不覆盖既有快照——撤销点仍指向整批修复前的原图
  if (opts.snapshot !== false) {
    try {
      db.setKv(REPAIR_UNDO_KEY, JSON.stringify({ at: Date.now(), nodes: g0.nodes, edges: g0.edges }));
    } catch (_) { /* 快照失败不阻断修复，只是没有撤销点 */ }
  }
  let work = { nodes: g0.nodes, edges: g0.edges };
  const applied = [];
  const skipped = [];
  const failed = [];   // { taskNo, label, error } —— 与作业 warning 语义对齐
  let aborted = false;
  // 批量落库：每 SAVE_BATCH 步或终态时保存一次，避免同步循环中反复 db.flush 撑爆堆内存。
  const SAVE_BATCH = 50;
  let lastSaved = 0;
  const persistWork = () => {
    if (lastSaved === applied.length) return;
    saveGraph(work.nodes, work.edges);
    lastSaved = applied.length;
  };
  for (let i = 0; i < list.length; i++) {
    if (opts.signal && opts.signal.aborted) { aborted = true; break; }
    const a = list[i];
    const label = a.actionZh || a.kind;
    if (opts.onTask) { try { opts.onTask(i, 'running'); } catch (_) {} }
    try {
      // 单动作施加：applyActions 是纯函数，逐条调用可精确定位「哪一步没打上」
      const r = R.repair.applyActions(work, [a]);
      if (r.applied.length) {
        work = { nodes: r.nodes, edges: r.edges };
        applied.push(a);
        if (opts.onTask) { try { opts.onTask(i, 'done', `已应用：${label}`); } catch (_) {} }
      } else {
        const why = (r.skipped && r.skipped[0] && r.skipped[0].reason) || '目标不存在（图谱可能已变化）';
        skipped.push({ actionZh: label, reason: why });
        if (opts.onTask) { try { opts.onTask(i, 'skipped', `已跳过：${why}`); } catch (_) {} }
      }
    } catch (err) {
      const msg = String((err && err.message) || err);
      failed.push({ taskNo: i + 1, label, error: msg });
      if (opts.onTask) { try { opts.onTask(i, 'failed', '失败：' + msg); } catch (_) {} }
    }
    if (opts.onProgress) { try { opts.onProgress(i + 1, list.length); } catch (_) {} }
    // 让出事件循环：GC 可回收临时对象，SSE/TCP 缓冲区有机会排空，避免 Web 模式下堆内存累积。
    if (i % 8 === 7) await new Promise((r) => setImmediate(r));
    // 每 SAVE_BATCH 个实际应用的动作批量落库一次（崩溃时已应用部分最多丢一个批次）。
    if (applied.length - lastSaved >= SAVE_BATCH) persistWork();
  }
  // 终态落库：确保最后一次批量保存及空批次也能同步状态。
  persistWork();
  if (aborted) {
    const err = new Error('用户手动停止作业');
    err.name = 'AbortError';
    err.partial = { applied: applied.length, skipped, failed, nodes: work.nodes.length, edges: work.edges.length };
    throw err;
  }
  if (!applied.length && !skipped.length) {
    // 全部动作都抛错：按作业失败处理（没有任何产出）
    const e = new Error(`全部 ${failed.length} 个修复动作执行失败：${failed[0] ? failed[0].error : '未知错误'}`);
    e.failedTasks = failed;
    throw e;
  }
  setGraphMeta({ inferredStale: true });
  const out = {
    ok: true,
    applied: applied.length,
    appliedZh: applied.map((a) => a.actionZh || ''),
    skipped,
    // failedTasks 非空 → runJob 把作业标为 warning（部分失败），卡片上可看到哪条动作没打上
    failedTasks: failed,
    nodes: work.nodes.length,
    edges: work.edges.length,
    rerun: null,
  };
  if (opts.rerun !== false) {
    try {
      const r = await runInference(null, {});
      out.rerun = r && r.ok
        ? { skipped: !!r.skipped, inconsistencies: r.skipped ? 0 : (r.inconsistencies || []).length, inferredEdges: r.inferredEdges || 0 }
        : { skipped: true, error: (r && r.error) || '重推理失败' };
    } catch (err) {
      out.rerun = { skipped: true, error: String((err && err.message) || err) };
    }
  }
  return out;
}

/** 撤销最近一次修复：恢复快照的 nodes/edges 并重推理。 */
async function undoRepair(opts = {}) {
  let snap = null;
  try { snap = JSON.parse(db.getKv(REPAIR_UNDO_KEY) || 'null'); } catch (_) { snap = null; }
  if (!snap || !Array.isArray(snap.nodes) || !Array.isArray(snap.edges)) {
    return { ok: false, error: '没有可撤销的修复记录（只保留最近一次）' };
  }
  saveGraph(snap.nodes, snap.edges);
  try { db.setKv(REPAIR_UNDO_KEY, ''); } catch (_) { /* 清掉撤销点，防止重复撤销 */ }
  setGraphMeta({ inferredStale: true });
  const out = { ok: true, nodes: snap.nodes.length, edges: snap.edges.length, at: snap.at || 0, rerun: null };
  if (opts.rerun !== false) {
    try {
      const r = await runInference(null, {});
      out.rerun = r && r.ok
        ? { skipped: !!r.skipped, inconsistencies: r.skipped ? 0 : (r.inconsistencies || []).length, inferredEdges: r.inferredEdges || 0 }
        : { skipped: true, error: (r && r.error) || '重推理失败' };
    } catch (err) {
      out.rerun = { skipped: true, error: String((err && err.message) || err) };
    }
  }
  return out;
}

/** 是否存有撤销点（UI 用来置灰「撤销修复」按钮）。 */
function repairUndoAvailable() {
  try {
    const snap = JSON.parse(db.getKv(REPAIR_UNDO_KEY) || 'null');
    return !!(snap && Array.isArray(snap.nodes));
  } catch (_) { return false; }
}

module.exports = { getGraph, saveGraph, clearGraph, extractGraph, contextFor, recallFor, getOntology, setOntologyProfile, saveOntologyItem, removeOntologyItem, listProfiles, resolveOntology, kgAsk, resolveSources, importOwl, removeOwlProfile, listGraphScopes, scopeFilter,
  // ---------- 推理层对外接口（设计文档 §4–§6） ----------
  runInference, getReasonState, clearInferredEdges, deleteEdgeWithCascade, deleteNodeWithCascade,
  impactClosureFor, predicateFeatures, reasonStatus, previewOwlImport, validateGraph,
  // ---------- DL 深度推理（dl-js-reasoner 融合设计 §4.5/§4.6） ----------
  dlQuery, dlEntail, dlHierarchy, reasonDlReady, reasonDlUnavailableReason,
  dlRecallFacts,   // §6.2 kgAsk 的 CQ 召回（导出供测试直接驱动）
  // ---------- DL 设置页配置（融合设计 §12）----------
  // 导出供 mergeGraph 装饰器与测试直接驱动；均为纯函数（只读 settings）。
  dlEnabled, dlDeepDefault, dlLimitsFromSettings, dlConfigSnapshot,
  // ---------- 体系化导入（bundle：主本体 + 依赖合并为单一体系）----------
  importBundle, previewBundleImport,
  // ---------- 冲突自动修复（方案2/3） ----------
  planRepairs, planRepairsForIssues, applyRepairs, applyRepairsStepwise, undoRepair, repairUndoAvailable,
  // 内部工具（测试与调试用）
  getGraphMeta, setGraphMeta, reasonReady, reasonEnabled, reasonUnavailableReason, SKIP_REASON_TEXT,
  // ---------- 语料流水线复用（设计 §7.2/§7.3：Extract/Guard/GraphMerge 装饰器搬迁自本文件）----------
  // 这些是 extractGraph 内部用到的本体/图谱工具，装饰器需同口径调用，故导出避免两处漂移。
  nodeTypesMap, relationsList, fallbackType, fallbackRel, nodeKey,
  reasonLayer: reason, reasonTimeoutSec, capInconsistencies, BATCH_CHARS, SOURCE_CHARS };
