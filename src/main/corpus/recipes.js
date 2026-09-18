// 语料流水线·声明式配方（设计 §8.1）
//
// 装饰器链手写嵌套 11 层既难读也难按设置动态增减，故用**纯数据数组**描述「用哪些层、什么顺序、什么参数」，
// 由 build.js 的 buildPipeline 从内向外折叠成装饰器链。
//
// 书写顺序 = **自内向外**（数组第 0 项是最内层的 Source，最后一项是最外层的终端装饰器）。
// 数据流向：next() 自内向外拉取；open() 自内向外；close()/finish() 自外向内（§4.4）。
//
// 字段约定：
//   layer    层注册键（见 build.js LAYERS）
//   enabled  字符串表达式（对 ctx 求值）或布尔；求值为 false 时整层跳过（G7 降级）
//   其余键   作为该层的 opts，字符串值会先对 ctx 求值（如 size:'BATCH_CHARS'、autoReason:'payload.autoReason'）
//
// 层序硬约束 O1–O5（§4.4）由 build.js 的 validateCaps 在构建期强制，配方写错会抛错。
'use strict';

// 图谱抽取作业（§4.4 全景链，默认配方共 11 层）：
//   Source → Log → Filter → Fallback[Mineru|Skill|Builtin] → Cache → CorpusWrite
//          → Enrich → Chunk → Extract → Guard → MergeGraph
// corpusReuse 为可选层（O4，在 fallback 与 cache 之间），默认 settings.corpusReuse 不为 true → 整层跳过，默认链仍是 11 层。
const GRAPH_RECIPE = [
  { layer: 'source', kind: 'raw' },                       // 由 payload 决定 Source 类型（makeSource）
  { layer: 'log', stageKey: 'collect' },
  { layer: 'filter', extWhitelist: true, dedup: false },  // dedup 默认关（§1.4，等《提取去重判断方案》拍板）
  { layer: 'fallback', candidates: ['mineru', 'skill', 'builtin'], forceFirst: 'forceMineru' },
  { layer: 'corpusReuse', enabled: 'settings.corpusReuse === true' },  // 可选（§4.2 / O4）：未过期语料直接复用，跳过解析
  { layer: 'cache' },
  { layer: 'corpusWrite', enabled: 'settings.corpusPersist !== false' },
  { layer: 'enrich' },
  { layer: 'chunk', size: 'settings.corpusChunkChars || BATCH_CHARS' },
  { layer: 'extract' },
  { layer: 'guard', enabled: 'reasonEnabled(settings)' },
  { layer: 'mergeGraph', autoReason: 'payload.autoReason' },
];

// extract-corpus 作业（§7.5）：只抽取、不入图、不写笔记——到落盘为止（corpusWrite 为终端）
const CORPUS_RECIPE = [
  { layer: 'source', kind: 'raw' },
  { layer: 'log', stageKey: 'parse' },
  { layer: 'filter', extWhitelist: true },
  { layer: 'fallback', candidates: ['mineru', 'skill', 'builtin'], forceFirst: 'forceMineru' },
  { layer: 'corpusReuse', enabled: 'settings.corpusReuse === true' },
  { layer: 'cache' },
  { layer: 'corpusWrite', terminal: true },
];

// extract-note 作业（§7.5）：解析 → 写笔记（noteImport 为终端）。阶段仍只发 extract/save 两个（§12.1 硬契约）
const NOTE_RECIPE = [
  { layer: 'source', kind: 'raw' },
  { layer: 'log', stageKey: 'extract' },
  { layer: 'filter', canImportAsNote: true },
  { layer: 'fallback', candidates: ['mineru', 'skill', 'builtin'], forceFirst: 'forceMineru' },
  { layer: 'corpusReuse', enabled: 'settings.corpusReuse === true' },
  { layer: 'cache' },
  { layer: 'noteImport', terminal: true },
];

// 「收集相」子链：图谱作业在领域归纳前需要先把来源解析成文本（resolveDomain 要全部来源内容）。
// 适配层先 drive 这条子链拿到带 text 的 items，再 drive「抽取相」子链（ArraySource → enrich → …）。
// 注意：**不含 corpusWrite**——语料落盘放到抽取相的 enrich 之后，frontmatter 才带得上领域（§6.2）。
const GRAPH_COLLECT_RECIPE = [
  { layer: 'source', kind: 'raw' },
  { layer: 'log', stageKey: 'collect' },
  { layer: 'filter', extWhitelist: true, dedup: false },
  { layer: 'fallback', candidates: ['mineru', 'skill', 'builtin'], forceFirst: 'forceMineru' },
  { layer: 'corpusReuse', enabled: 'settings.corpusReuse === true' },
  { layer: 'cache' },
];

// 「抽取相」子链：来源已解析（ArraySource 重放），enrich 定领域/体系后再落盘语料，然后分块→抽取→护栏→合并。
// corpusWrite 在 enrich 之后、chunk 之前（满足 O2：落盘完整语料而非碎片，且 frontmatter 带领域）。
const GRAPH_EXTRACT_RECIPE = [
  { layer: 'source', kind: 'array' },
  { layer: 'enrich' },
  { layer: 'corpusWrite', enabled: 'settings.corpusPersist !== false' },
  { layer: 'chunk', size: 'settings.corpusChunkChars || BATCH_CHARS' },
  { layer: 'extract' },
  { layer: 'guard', enabled: 'reasonEnabled(settings)' },
  { layer: 'mergeGraph', autoReason: 'payload.autoReason' },
];

const RECIPES = {
  graph: GRAPH_RECIPE,
  corpus: CORPUS_RECIPE,
  note: NOTE_RECIPE,
  'graph-collect': GRAPH_COLLECT_RECIPE,
  'graph-extract': GRAPH_EXTRACT_RECIPE,
};

module.exports = {
  GRAPH_RECIPE,
  CORPUS_RECIPE,
  NOTE_RECIPE,
  GRAPH_COLLECT_RECIPE,
  GRAPH_EXTRACT_RECIPE,
  RECIPES,
};
