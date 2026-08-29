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
  sourceMaxChars: ['set-sourcechars', 1000, 1000000],
  rawDirMaxFiles: ['set-rawdirmax', 10, 100000],
  maxToolRounds: ['set-toolrounds', 1, 12],
  logTailLines: ['set-loglines', 1, 500],
  mineruTimeout: ['set-minerutimeout', 10, 21600],
};

// ---------- 模型服务商 ----------
// 服务商预设：仅支持阿里云百炼与 Ollama（默认阿里云）
// label 用于模型选择器分组展示；suggest 仅作为「添加模型」时的候选提示，实际可用模型以用户配置为准
const PROVIDER_PRESETS = {
  dashscope: { label: '阿里云百炼', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: ((window.kb && window.kb.defaults) || {}).model || 'qwen3.8-max', suggest: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-long'] },
  ollama: { label: 'Ollama（本地）', url: 'http://localhost:11434/v1', model: '', suggest: ['qwen2.5', 'llama3.1', 'deepseek-r1'] },
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
// 图谱面板 Tab 名称
const KG_TAB_NAMES = { overview: '概览', entities: '实体浏览', graph: '整体图谱', ontology: '本体定义', ask: '自然语言问答' };

// ---------- 作业 ----------
// 作业类型图标：统一使用 index.html 顶部 SVG sprite 中的线性图标
const JOB_TYPE_ICONS = {
  'extract-note': 'notes',
  ingest: 'download',
  graph: 'kg',
  lint: 'checklist',
};

// ---------- 原始文件 ----------
// 提取知识图谱时的目录匹配超时（ms）
const GRAPH_MATCH_TIMEOUT = 10000;
