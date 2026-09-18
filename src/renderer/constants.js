// 渲染层常量中心：跨渲染模块共用的业务常量统一定义于此（index.html 最先加载本文件）
// 说明：仅存放「值」，不含业务逻辑；模块私有的会话状态（如折叠状态表）仍留在原模块

// ---------- 编辑器 ----------
// 编辑器三种模式：编辑 / 分屏 / 预览
const EDITOR_MODES = ['edit', 'split', 'preview'];

// 数值配置项表单：id 与钳制范围（留空时主进程回退默认值）
const NUM_SETTING_FIELDS = {
  maxJobsHistory: ['set-maxhistory', 1, 500],
  chatRetries: ['set-retries', 0, 5],
  maxConcurrentJobs: ['set-maxconcurrent', 1, 8],
  graphConcurrency: ['set-graphconc', 1, 8],
  urlFetchTimeout: ['set-urltimeout', 1, 600],
  llmRequestTimeout: ['set-llmreqtimeout', 60, 86400],
  sourceMaxChars: ['set-sourcechars', 1000, 1000000],
  rawDirMaxFiles: ['set-rawdirmax', 10, 100000],
  maxToolRounds: ['set-toolrounds', 1, 12],
  logTailLines: ['set-loglines', 1, 500],
  mineruTimeout: ['set-minerutimeout', 10, 21600],
  // 推理超时（融合设计 §6.11）：范围与主进程 reasonTimeoutSec 的 num(...,30,5,120) 完全一致，
  // 两边不同步会导致「设置里能填但主进程静默钳回」。
  reasonTimeout: ['set-reason-timeout', 5, 120],
  // 语料流水线（语料流水线设计 §10.1）：以下 4 项须与主进程 num() 的默认/上下限逐字一致，
  // 否则「设置里能填但主进程静默钳回」。控件均放在 设置→语料流水线（§16.3）。
  extractSkillTopN: ['set-extracttopn', 1, 5],           // 同扩展名命中多个抽取技能时注入几个（§5.4）
  extractSkillTimeoutSec: ['set-extracttimeout', 5, 600], // mode:script 子进程超时（秒），默认 120
  corpusChunkChars: ['set-corpuschunk', 1000, 40000],    // 分块大小，默认 6000（= graph BATCH_CHARS）
  corpusMaxFiles: ['set-corpumaxfiles', 100, 20000],     // 语料库文件数上限，超出按 generatedAt 淘汰最旧
};

// ---------- 模型服务商 ----------
// 服务商预设：均使用 OpenAI 兼容接口；本地 vLLM/sglang/Ollama 不要求 API Key
// label 用于模型选择器分组展示；suggest 仅作为「添加模型」时的候选提示，实际可用模型以用户配置为准
const PROVIDER_PRESETS = {
  dashscope: { label: '阿里云百炼', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: ((window.kb && window.kb.defaults) || {}).model || 'qwen3.8-max', suggest: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-long'] },
  ollama: { label: 'Ollama', url: 'http://localhost:11434/v1', model: '', suggest: ['qwen2.5', 'llama3.1', 'deepseek-r1'] },
  vllm: { label: 'vLLM', url: 'http://localhost:8000/v1', model: '', suggest: ['Qwen/Qwen2.5-0.5B-Instruct', 'Qwen/Qwen3-0.6B'] },
  sglang: { label: 'sglang', url: 'http://localhost:30000/v1', model: '', suggest: ['Qwen/Qwen2.5-0.5B-Instruct', 'Qwen/Qwen3-0.6B'] },
};
const DEFAULT_PROVIDER = 'dashscope';

// ---------- 技能安装 ----------
// 技能在线安装命令默认值（设置页占位）
const DEFAULT_SKILL_INSTALL_CMD = 'npx skills add https://github.com/anthropics/skills --skill docx';

// ---------- AI 问答 ----------
// 单次提问附件上限
const MAX_ATTACH = 5;
// AI 数据源 key → 图标名映射
const AI_SRC_ICON_MAP = { notes: 'notes', graph: 'kg', raws: 'folder-open' };

// ---------- 内置文档 ----------
// 内置帮助文档索引文件（docs/ 根）
const DOCS_INDEX = 'README.md';
// 文档内可内联展示的图片资源扩展名
const DOC_ASSET_IMG_RE = /\.(png|jpe?g|gif|svg|webp|bmp)$/i;

// ---------- 知识图谱 ----------
// 图谱节点配色：固定类型色 + 调色板兜底
const GRAPH_PALETTE = ['#3370ff', '#0fbfa1', '#7a5af8', '#f5a623', '#8a919f'];
const GRAPH_COLORS = { entity: '#3370ff', source: '#0fbfa1', concept: '#7a5af8', topic: '#f5a623', note: '#8a919f' };
const GRAPH_TYPE_NAMES = { concept: '抽象概念', entity: '实体', topic: '主题', source: '来源', note: '笔记' };
// 类型数超出调色板时，按黄金角共轭在色环上取色，保证各类颜色互不重复
function graphGenColor(index) {
  const hue = (index * 137.508) % 360;
  return `hsl(${hue.toFixed(1)}, 68%, 52%)`;
}
// 图谱面板 Tab 名称
const KG_TAB_NAMES = { graph: '整体图谱', ontology: '本体定义', reason: '推理与校验', ask: '自然语言问答' };

// ---------- 推理边（融合设计 §6.1/§6.4）----------
// 推理边统一用紫色虚线，与原始边（灰色实线）在画布/图例/标签/详情四处共用同一套色值，
// 保证「哪条边是推理得出的」在任何视图里都能一眼对上。
const INFERRED_EDGE = {
  color: '#8b5cf6',              // 紫色主色（标签/图例/徽标）
  stroke: 'rgba(139,92,246,0.45)', // 画布连线
  arrow: 'rgba(139,92,246,0.6)',   // 画布箭头
  width: 1.2,
  dash: [5, 4],                    // 虚线节奏
};
const RAW_EDGE = {
  stroke: 'rgba(138,145,159,0.5)',
  arrow: 'rgba(138,145,159,0.7)',
  color: '#8a919f',
  width: 1,
};
// 推导方式（边的 inferredVia）→ 中文说明，用于悬停 tooltip。
// 取值来自 reason/bridge.js:justify()（symmetric/inverse/transitive/transitive+/
// subproperty/equivalent-property/unknown）与 reason/infer.js 的兜底。
const INFERRED_VIA_NAMES = {
  transitive: '传递闭包（A→B→C ⇒ A→C）',
  'transitive+': '传递闭包（多跳）',
  symmetric: '对称反转（A↔B）',
  inverse: '互逆反转（P 与 P⁻¹）',
  subproperty: '子谓词继承',
  'equivalent-property': '等价谓词',
  unknown: '推理器得出（未记录推导路径）',
};
function inferredViaName(via) {
  if (!via) return '';
  return INFERRED_VIA_NAMES[via] || via;
}
// 注意：影响面闭包（reason/impact.js）里节点的 via 是**谓词名**（如「包含」），
// 不是上面这套推导方式枚举，两者不要混用。

// ---------- 作业 ----------
// 作业类型图标：统一使用 index.html 顶部 SVG sprite 中的线性图标
const JOB_TYPE_ICONS = {
  'extract-note': 'notes',
  ingest: 'download',
  graph: 'kg',
  'graph-repair': 'clean',
  lint: 'checklist',
  // 语料抽取（§16.5）：复用 #i-parse 图标，无需新增 SVG symbol
  'extract-corpus': 'parse',
};

// ---------- 原始文件 ----------
// 提取知识图谱时的目录匹配超时（ms）：思考型模型（如 qwen3.8-max 默认开思考）仅 thinking 就需数十秒，
// 10s 会在 matchTemplate 流式思考阶段就触发 AbortError 静默回退关键词匹配，弹窗看不到任何思考过程
const GRAPH_MATCH_TIMEOUT = 60000;
