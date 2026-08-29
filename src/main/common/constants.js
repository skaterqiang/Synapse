// 主进程常量中心：跨模块共用的业务常量统一定义于此，避免散落在各领域模块中
// 说明：仅存放「值」，不含业务逻辑；模块私有且无复用价值的常量仍留在原模块
const pathJoin = require('path').join;

// ---------- 笔记领域 ----------
// 「垃圾桶」磁盘目录名：移入垃圾桶的笔记统一落盘到 <note根>/trash/
const TRASH_DIR = 'trash';
// 垃圾桶虚拟目录 id：UI 目录树中的垃圾桶节点（不落 folders 表，loadStore 每次合成）
const TRASH_FOLDER_ID = '__trash__';

// ---------- 原始文件领域 ----------
// MinerU 官方支持的文件类型（来源：mineru/cli/common.py：pdf/docx/pptx/xlsx + 图片 png,jpeg,jp2,webp,gif,bmp,jpg,tiff）。
// 内置解析只覆盖文本型文档；这些二进制/图片类型在配置了 MinerU 命令后由插件转换，未配置时导入后读取会报「不支持」并引导去设置
const MINERU_SUPPORTED_EXTS = ['pdf', 'docx', 'pptx', 'xlsx', 'png', 'jpg', 'jpeg', 'jp2', 'webp', 'gif', 'bmp', 'tiff'];
// 文件选择对话框支持的扩展名（文档类 + MinerU 支持类型）
const FILE_EXTENSIONS = [...new Set(['pdf', 'docx', 'xlsx', 'xls', 'pptx', 'md', 'markdown', 'txt', 'csv', 'html', 'htm', ...MINERU_SUPPORTED_EXTS])];
// 笔记导入默认白名单：文档类 + MinerU 支持类型（含图片）。不包含 .java/.xml/.py/.sh 等代码/配置文件——
// 它们虽然能当纯文本读，但会把大量工程文件灌进笔记、淡化真正的知识内容。
// 用户可在设置里改（settings.noteImportExts），但默认不替他做这个选择
const DEFAULT_NOTE_IMPORT_EXTS = [...new Set(['pdf', 'docx', 'xlsx', 'xls', 'pptx', 'md', 'markdown', 'txt', 'csv', 'html', 'htm', ...MINERU_SUPPORTED_EXTS])];
// 原始文件引用的 kv 存储键（单文件 / 目录 / 目录内排除项 / 网页链接）
const RAW_REFS_KEY = 'raw_refs';
const RAW_DIRS_KEY = 'raw_dir_refs';
const RAW_EXCLUDED_KEY = 'raw_excluded';
const RAW_URLS_KEY = 'raw_url_refs';
// 吸收状态追踪键（防重复吸收）：key=来源路径 → {at, mtime, jobId}
const RAW_INGESTED_KEY = 'raw_ingested';
// 目录扫描跳过的依赖/隐藏/构建产物目录，保留用户内容目录（原样引用多级结构）
const SKIP_DIRS = new Set(['.venv', 'node_modules', '.git', '.idea', '.vscode', '.qoder', '__pycache__', '.DS_Store', 'dist', 'build', 'target']);
// 噪声文件：系统元数据与办公软件临时文件。它们无可提取内容，
// 却会占满目录引用的文件数上限、在作业里刷出一堆“不支持的文件格式”失败项，因此扫描阶段就滤掉
const SKIP_FILES = new Set(['.DS_Store', '.localized', 'Thumbs.db', 'thumbs.db', 'ehthumbs.db', 'desktop.ini', 'Icon\r', '.gitkeep', '.gitignore']);
// 目录引用单目录文件数默认上限（settings.rawDirMaxFiles 可调）
const DEFAULT_MAX_DIR_FILES = 500;

// ---------- MinerU 插件 ----------
// 大文档（数百页扫描件）转换常需数十分钟，默认 1 小时，可在设置里调（mineruTimeout）
const MINERU_TIMEOUT_SEC = 3600;
// MinerU 安装目录名（<安装目录>/plugins/mineru/）：venv、包装脚本等全部置于其下
const PLUGINS_DIR = 'plugins';
const MINERU_PLUGIN_DIR = 'mineru';
// 一键安装总超时：pip 安装 mineru 依赖较多，给 30 分钟
const MINERU_INSTALL_TIMEOUT_MS = 30 * 60 * 1000;
// MinerU 默认视觉模型与本机 Ollama 端点（hybrid-http-client 后端）
const MINERU_DEFAULT_VLM_MODEL = 'qwen3.8:27b';
const MINERU_DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
// 纯 ASCII 路径别名候选（fasttext C++ 层打不开中文路径，经 junction 绕行）
const MINERU_ASCII_ALIAS_CANDIDATES = (env) => {
  const progData = env.ProgramData || 'C:\\ProgramData';
  return [pathJoin(progData, 'synapse-mineru'), pathJoin((env.SystemDrive || 'C:') + '\\', 'synapse-mineru')];
};
// 运行期附加依赖：mineru 3.4.x hybrid 后端用到但未在 extras 里声明的包
const MINERU_EXTRA_PACKAGES = ['six', 'pandas', 'accelerate', 'psutil', 'Pygments', 'orjson', 'python-dateutil', 'pytz', 'rich'];

// ---------- 图谱领域 ----------
// 本体层定义 kv 键
const ONTOLOGY_KEY = 'ontology';
// 默认本体：抽取与展示共用的受控词表（未持久化时回退）
const DEFAULT_ONTOLOGY = {
  classes: [
    { key: 'concept', label: '抽象概念', desc: '方法/原理/术语/抽象想法', examples: ['RAG', '本体层'] },
    { key: 'entity', label: '实体', desc: '人/组织/产品/工具等具体个体', examples: ['通义千问', 'SQLite'] },
    { key: 'topic', label: '主题', desc: '领域/议题/主题综合页', examples: ['LLM Wiki'] },
    { key: 'source', label: '来源', desc: '文档/网页/资料等原始材料', examples: ['OKF 规范'] },
    { key: 'note', label: '笔记', desc: '用户手工记录的 Markdown 条目', examples: ['快速上手'] },
  ],
  predicates: [
    { key: '属于', desc: '实例归于某类/某集合' },
    { key: '包含', desc: '整体与部分/集合成员' },
    { key: '依赖', desc: '运行或成立以前者为条件' },
    { key: '相关', desc: '弱关联兜底关系' },
    { key: '引用', desc: '内容援引后者' },
    { key: '应用于', desc: '前者作用于后者场景' },
    { key: '衍生自', desc: '由后者演化/抽象而来' },
    { key: '矛盾于', desc: '与后者冲突/互斥' },
  ],
  constraints: [
    '节点类型须从五个实体类中选取，其余回退为 concept',
    '关系谓词须从受控词表选取，其余回退为「相关」',
    '禁止自环边（from == to）',
    '节点按规范化名称去重；边按 (from, to, rel) 去重',
  ],
};
// 领域模版 kv 键
const DOMAIN_TEMPLATES_KEY = 'domain_templates';
// 内置通用模版：不可删除，未匹配到特定领域时兜底
const GENERAL_TEMPLATE = {
  id: 'general',
  name: '通用',
  desc: '通用知识领域模版，适用于未匹配到特定领域的文档',
  keywords: [],
  entityTypes: [
    { name: '人物', desc: '文中出现的关键人物' },
    { name: '组织', desc: '公司、机构、团队' },
    { name: '产品/工具', desc: '被提及的产品、软件或工具' },
  ],
  conceptTypes: [
    { name: '方法', desc: '方法论、流程、最佳实践' },
    { name: '术语', desc: '专业名词及其定义' },
    { name: '原则', desc: '观点、结论、原则' },
  ],
  mustExtract: ['核心概念定义', '关键事实与数据', '结论与要点'],
  ignoreContent: ['广告与推广内容', '页面导航等无关文本'],
  quality: '信息准确、要点完整、语言凝练，保留来源中的关键数据与结论。',
  skeleton: [
    { title: '概览', desc: '主题背景与核心内容摘要' },
    { title: '核心概念', desc: '关键概念与术语解释' },
    { title: '要点清单', desc: '重要事实、结论与待办' },
  ],
  builtin: true,
};

// ---------- MCP ----------
// MCP 协议版本（initialize 协商）
const MCP_PROTOCOL = '2024-11-05';
// 建连 / 取 SSE endpoint 超时
const MCP_CONNECT_MS = 20000;
// 单次请求超时（搜索类工具较慢）
const MCP_REQUEST_MS = 30000;

// ---------- 技能 / 网络 ----------
// 抓取网页/下载源码包使用的 User-Agent
const HTTP_USER_AGENT = 'Mozilla/5.0 (personal-kb)';
// 技能源码包下载超时：慢网络下大包下载耗时较长，放宽到 5 分钟
const SKILL_DOWNLOAD_TIMEOUT_MS = 300000;
// 技能源码包大小上限
const SKILL_MAX_ZIP_BYTES = 60 * 1024 * 1024;
// 技能种子目录（示例技能植入来源，历史路径）
const DEFAULT_SKILLS_DIR = '/Users/qiang/sample_center-release/backend/resource/skills';

// ---------- 链接登录态 ----------
// 链接来源 Cookie 持久化 kv 键
const URL_COOKIES_KEY = 'url_cookies';

module.exports = {
  TRASH_DIR,
  TRASH_FOLDER_ID,
  MINERU_SUPPORTED_EXTS,
  FILE_EXTENSIONS,
  DEFAULT_NOTE_IMPORT_EXTS,
  RAW_REFS_KEY,
  RAW_DIRS_KEY,
  RAW_EXCLUDED_KEY,
  RAW_URLS_KEY,
  RAW_INGESTED_KEY,
  SKIP_DIRS,
  SKIP_FILES,
  DEFAULT_MAX_DIR_FILES,
  MINERU_TIMEOUT_SEC,
  PLUGINS_DIR,
  MINERU_PLUGIN_DIR,
  MINERU_INSTALL_TIMEOUT_MS,
  MINERU_DEFAULT_VLM_MODEL,
  MINERU_DEFAULT_OLLAMA_URL,
  MINERU_ASCII_ALIAS_CANDIDATES,
  MINERU_EXTRA_PACKAGES,
  ONTOLOGY_KEY,
  DEFAULT_ONTOLOGY,
  DOMAIN_TEMPLATES_KEY,
  GENERAL_TEMPLATE,
  MCP_PROTOCOL,
  MCP_CONNECT_MS,
  MCP_REQUEST_MS,
  HTTP_USER_AGENT,
  SKILL_DOWNLOAD_TIMEOUT_MS,
  SKILL_MAX_ZIP_BYTES,
  DEFAULT_SKILLS_DIR,
  URL_COOKIES_KEY,
};
