// 主进程常量中心：跨模块共用的业务常量统一定义于此，避免散落在各领域模块中
// 说明：仅存放「值」，不含业务逻辑；模块私有且无复用价值的常量仍留在原模块
const pathJoin = require('path').join;

// ---------- 笔记领域 ----------
// 「垃圾桶」磁盘目录名：移入垃圾桶的笔记统一落盘到 <note根>/trash/
const TRASH_DIR = 'trash';
// 垃圾桶虚拟目录 id：UI 目录树中的垃圾桶节点（不落 folders 表，loadStore 每次合成）
const TRASH_FOLDER_ID = '__trash__';

// ---------- 原始文件领域 ----------
// MinerU 严格接受的扩展名：产品定位 MinerU 只接 PDF（扫描件 PDF 的高质量解析），
// 其它二进制类型（docx/pptx/xlsx/图片）不交给 MinerU；图片无内置解析器，
// 由「技能解析」（设置→文档解析，默认开启）经模型多模态直读解析；关闭开关时报「不支持」
const MINERU_SUPPORTED_EXTS = ['pdf'];
// 图片类型集合：文件选择器可添加为引用，无内置解析器、MinerU 也不接；
// 技能解析开启时经模型直读解析，关闭时报「不支持」并如实说明现状（用于错误提示与文档口径）
const MINERU_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.jp2', '.webp', '.gif', '.bmp', '.tiff']);
// 源码/配置类纯文本扩展名：本身就是 UTF-8 文本，内置解析直接解码（与 .txt 同口径）——
// 不路由 MinerU（严格只接 PDF），也不交技能解析（纯文本让模型重读无增益，只是逐文件空耗调用）。
// 是否纳入笔记导入白名单仍由 noteImportExts 决定（默认不含代码类，此处只定「解析方式」）
const CODE_TEXT_EXTS = ['.java', '.js', '.jsx', '.ts', '.tsx', '.vue', '.py', '.cs', '.c', '.h', '.cpp', '.hpp', '.cc', '.go', '.rs', '.kt', '.scala', '.php', '.rb', '.lua', '.sql', '.xml', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.properties', '.sh', '.bat', '.ps1', '.gradle'];
// 文件选择对话框支持的扩展名（文档类 + 图片类：图片可选入引用，但解析需有解析器）
const FILE_EXTENSIONS = [...new Set(['pdf', 'docx', 'xlsx', 'xls', 'pptx', 'md', 'markdown', 'txt', 'csv', 'html', 'htm', 'png', 'jpg', 'jpeg', 'jp2', 'webp', 'gif', 'bmp', 'tiff'])];
// 笔记导入默认白名单：文档类（文本型 + 常规 PDF/Office，内置解析直接支持）。不含图片与代码/配置文件——
// 图片没有内置解析器（MinerU 严格只接 PDF）；代码文件虽然能当纯文本读，但会把大量工程文件灌进笔记、淡化真正的知识内容。
// 用户可在设置里改（settings.noteImportExts），但默认不替他做这个选择
const DEFAULT_NOTE_IMPORT_EXTS = ['pdf', 'docx', 'xlsx', 'xls', 'pptx', 'md', 'markdown', 'txt', 'csv', 'html', 'htm'];
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

// ---------- 顶层本体体系（TopOntologyProfile，内置只读基座） ----------
// 多本体体系选择总体设计 §2：每个 profile 是自包含基座，classes 以 parent 构成树，
// 提取弹窗可切换，节点按提取所用 profile 打标实现混合体系共存。
const ONTOLOGY_PROFILES = {
  // bfo-lite：轻量默认（约 9 类，flat prompt）
  'bfo-lite': {
    id: 'bfo-lite',
    name: 'BFO-Lite 轻量体系',
    desc: '面向个人知识库的轻量顶层本体，延续现有中文谓词，默认选用',
    promptMode: 'flat',
    fallbackType: 'object',
    fallbackRel: '相关',
    classes: [
      { key: 'thing', label: '事物', code: 'BFO:0000001', parent: '', desc: '顶层根类：任何实体' },
      { key: 'continuant', label: '持续体', code: 'BFO:0000002', parent: 'thing', desc: '在时间中持续存在、保持同一的实体' },
      { key: 'object', label: '物体', code: 'BFO:0000030', parent: 'continuant', desc: '独立存在的具体物（人/物/组织/工具）', examples: ['充电桩', '通义千问'] },
      { key: 'quality', label: '性质', code: 'BFO:0000019', parent: 'continuant', desc: '依附于承载者的固有属性', examples: ['额定功率', '颜色'] },
      { key: 'realizable', label: '可实现体', code: 'BFO:0000017', parent: 'continuant', desc: '可被实现/行使的倾向性实体' },
      { key: 'role', label: '角色', code: 'BFO:0000023', parent: 'realizable', desc: '依情境获得的外在身份', examples: ['业主', '租户'] },
      { key: 'function', label: '功能', code: 'BFO:0000034', parent: 'realizable', desc: '被设计赋予的固有用途', examples: ['供电功能', '存储功能'] },
      { key: 'occurrent', label: '发生体', code: 'BFO:0000003', parent: 'thing', desc: '在时间中展开/发生的实体' },
      { key: 'process', label: '过程', code: 'BFO:0000015', parent: 'occurrent', desc: '有始有终的过程', examples: ['施工', '扩容审批'] },
      { key: 'event', label: '事件', code: 'BFO:0000015e', parent: 'occurrent', desc: '瞬时发生的事件', examples: ['跳闸', '故障'] },
      { key: 'information', label: '信息体', code: 'BFO:0000031i', parent: 'occurrent', desc: '依赖承载者的信息/文档/数据', examples: ['设计图纸', '申请表'] },
    ],
    predicates: [
      { key: '属于', label: '属于', desc: '实例归于某类/某集合' },
      { key: '包含', label: '包含', desc: '整体与部分/集合成员' },
      { key: '依赖', label: '依赖', desc: '运行或成立以前者为条件' },
      { key: '相关', label: '相关', desc: '弱关联兜底关系' },
      { key: '引用', label: '引用', desc: '内容援引后者' },
      { key: '应用于', label: '应用于', desc: '前者作用于后者场景' },
      { key: '衍生自', label: '衍生自', desc: '由后者演化/抽象而来' },
      { key: '矛盾于', label: '矛盾于', desc: '与后者冲突/互斥' },
    ],
    constraints: [
      '节点类型须从体系类表中选取，其余回退为 object',
      '关系谓词须从受控词表选取，其余回退为「相关」',
      '禁止自环边（from == to）',
      '节点按规范化名称去重；边按 (from, to, rel) 去重',
      '持续体（continuant）与发生体（occurrent）互斥，节点不可同时归类两者',
      '性质（quality）/角色（role）/功能（function）必须依附于某个物体（object）承载者，不允许悬空',
      '「属于」谓词仅用于 实例→类 的方向，不可用于类→类（类层级用 parent）',
      '「包含」「依赖」为方向性关系，抽取时需保持 整体→部分、依赖方→被依赖方 的方向',
      '信息体（information）须通过「引用」或「应用于」关联到其承载的物体或过程，不孤立存在',
      '「矛盾于」标记的节点对不得再建立「属于」「包含」等同向关系',
    ],
    // OWL 逻辑公理（BFO-Lite 轻量集，源自 BFO 2.0 核心公理）
    axioms: [
      { type: 'DisjointClasses', subject: 'continuant', object: 'occurrent', desc: '持续体与发生体不相交（实体要么持续存在，要么在发生）' },
      { type: 'DisjointClasses', subject: 'object', object: 'quality', desc: '物体与性质不相交（物体独立存在，性质依附承载者）' },
      { type: 'DisjointClasses', subject: 'role', object: 'function', desc: '角色与功能不相交（角色依情境获得，功能被设计赋予）' },
      { type: 'SubClassOf', subject: 'role', object: 'realizable', desc: '角色是可被实现的（扮演某角色=实现该角色）' },
      { type: 'SubClassOf', subject: 'function', object: 'realizable', desc: '功能是可被实现的（行使功能=实现该功能）' },
      { type: 'TransitiveProperty', subject: '包含', desc: '包含关系传递（A包含B、B包含C → A包含C）' },
      { type: 'SymmetricProperty', subject: '相关', desc: '相关关系对称（A相关B ⇔ B相关A）' },
      { type: 'AsymmetricProperty', subject: '矛盾于', desc: '矛盾关系非对称的互斥（A矛盾B → B矛盾A，但不可自反）' },
    ],
  },
  // bfo：标准 BFO 2020（15 类，two-stage prompt）
  bfo: {
    id: 'bfo',
    name: 'BFO 2020 标准体系',
    desc: 'Basic Formal Ontology 2020，严谨推理与科研知识组织，two-stage 提取',
    promptMode: 'two-stage',
    fallbackType: 'material_entity',
    fallbackRel: 'related_to',
    classes: [
      { key: 'entity', label: '实体', code: 'BFO:0000001', parent: '', desc: '顶层根类' },
      { key: 'continuant', label: '持续体', code: 'BFO:0000002', parent: 'entity', desc: '在任何时刻都完整存在的实体' },
      { key: 'independent_continuant', label: '独立持续体', code: 'BFO:0000004', parent: 'continuant', desc: '不依附他物独立存在' },
      { key: 'material_entity', label: '物质实体', code: 'BFO:0000040', parent: 'independent_continuant', desc: '有物质构成的实体' },
      { key: 'object', label: '物体', code: 'BFO:0000030', parent: 'material_entity', desc: '因果统一的单个物体' },
      { key: 'object_aggregate', label: '物体聚合', code: 'BFO:0000027', parent: 'material_entity', desc: '物体集合体' },
      { key: 'fiat_object_part', label: '人为物体部件', code: 'BFO:0000024', parent: 'material_entity', desc: '人为划分的物体部分' },
      { key: 'immaterial_entity', label: '非物质实体', code: 'BFO:0000141', parent: 'independent_continuant', desc: '空间/边界等非物质实体' },
      { key: 'specifically_dependent_continuant', label: '特依存持续体', code: 'BFO:0000020', parent: 'continuant', desc: '依附特定承载者' },
      { key: 'quality', label: '性质', code: 'BFO:0000019', parent: 'specifically_dependent_continuant', desc: '固有属性' },
      { key: 'realizable_entity', label: '可实现实体', code: 'BFO:0000017', parent: 'specifically_dependent_continuant', desc: '可实现倾向' },
      { key: 'role', label: '角色', code: 'BFO:0000023', parent: 'realizable_entity', desc: '外在角色' },
      { key: 'disposition', label: '倾向', code: 'BFO:0000016', parent: 'realizable_entity', desc: '内在倾向' },
      { key: 'function', label: '功能', code: 'BFO:0000034', parent: 'realizable_entity', desc: '设计功能' },
      { key: 'generically_dependent_continuant', label: '泛依存持续体', code: 'BFO:0000031', parent: 'continuant', desc: '可跨承载者的信息实体' },
      { key: 'occurrent', label: '发生体', code: 'BFO:0000003', parent: 'entity', desc: '在时间中展开发生的实体' },
      { key: 'process', label: '过程', code: 'BFO:0000015', parent: 'occurrent', desc: '有始有终的过程' },
      { key: 'history', label: '历程', code: 'BFO:0000182', parent: 'process', desc: '一个体全部过程的总和' },
      { key: 'process_boundary', label: '过程边界', code: 'BFO:0000035', parent: 'occurrent', desc: '过程的边界时刻' },
      { key: 'temporal_region', label: '时间区域', code: 'BFO:0000008', parent: 'occurrent', desc: '时间区间' },
      { key: 'spatiotemporal_region', label: '时空区域', code: 'BFO:0000011', parent: 'occurrent', desc: '时空区间' },
    ],
    predicates: [
      { key: 'is_a', label: '是一种', code: 'RO:is_a', desc: '类层级' },
      { key: 'instance_of', label: '实例于', code: 'RO:0000008i', desc: '实例归属类' },
      { key: 'part_of', label: '部分于', code: 'BFO:0000050', desc: '整体-部分', features: ['transitive'] },
      { key: 'has_part', label: '有部分', code: 'BFO:0000051', desc: '部分-整体', features: ['transitive'] },
      { key: 'participates_in', label: '参与', code: 'RO:0000056', desc: '持续体参与发生体' },
      { key: 'has_participant', label: '有参与者', code: 'RO:0000057', desc: '发生体含参与者' },
      { key: 'inheres_in', label: '内在于', code: 'RO:0000052', desc: '性质/可实现体内在于承载者' },
      { key: 'bearer_of', label: '承载', code: 'RO:0000053', desc: '承载者承载性质' },
      { key: 'located_in', label: '位于', code: 'RO:0001025', desc: '空间位置', features: ['transitive'] },
      { key: 'occurs_in', label: '发生于', code: 'BFO:0000066', desc: '发生体发生于某处' },
      { key: 'precedes', label: '先于', code: 'BFO:0000063', desc: '时序在前', features: ['transitive'] },
      { key: 'realizes', label: '实现', code: 'BFO:0000055', desc: '过程实现可实现体' },
      { key: 'has_role', label: '有角色', code: 'RO:0000087', desc: '承载者拥有角色' },
      { key: 'derives_from', label: '衍生自', code: 'RO:0001000', desc: '由后者演化而来' },
      { key: 'related_to', label: '相关于', code: 'RO:related', desc: '弱关联兜底', features: ['symmetric'] },
    ],
    constraints: [
      '节点类型须从 BFO 2020 类表选取，其余回退为 material_entity',
      '关系谓词须从 RO 子集选取，其余回退为 related_to',
      '禁止自环边（from == to）',
      '节点按规范化名称去重；边按 (from, to, rel) 去重',
      '持续体（continuant）与发生体（occurrent）顶层二分互斥，节点仅属其一',
      '物质实体（material_entity）与非物质实体（immaterial_entity）互斥',
      'inheres_in 的定义域须为特依存持续体（specifically_dependent_continuant），值域须为独立持续体',
      'participates_in 仅允许 持续体→发生体 方向，禁止反向',
      'part_of / has_part 互为逆关系，成对出现时方向须一致（A part_of B ⇔ B has_part A）',
      'is_a 仅用于类→父类的层级，instance_of 仅用于 实例→类，二者不可混用',
      'located_in / precedes 为传递关系，链路抽取时避免产生 (A→B→A) 环路',
      'role / disposition / function 必须经 bearer_of 或 inheres_in 挂靠到独立持续体，不孤立存在',
    ],
    // OWL 逻辑公理（BFO 2020 标准公理，来自 Basic Formal Ontology 2.0 + Relation Ontology）
    axioms: [
      { type: 'DisjointClasses', subject: 'continuant', object: 'occurrent', desc: '持续体与发生体不相交（BFO 顶层二分）' },
      { type: 'DisjointClasses', subject: 'independent_continuant', object: 'specifically_dependent_continuant', desc: '独立持续体与特依存持续体不相交' },
      { type: 'DisjointClasses', subject: 'material_entity', object: 'immaterial_entity', desc: '物质实体与非物质实体不相交' },
      { type: 'DisjointClasses', subject: 'quality', object: 'realizable_entity', desc: '性质与可实现实体不相交' },
      { type: 'SubClassOf', subject: 'role', object: 'realizable_entity', desc: '角色⊑可实现实体' },
      { type: 'SubClassOf', subject: 'disposition', object: 'realizable_entity', desc: '倾向⊑可实现实体' },
      { type: 'SubClassOf', subject: 'function', object: 'realizable_entity', desc: '功能⊑可实现实体' },
      { type: 'TransitiveProperty', subject: 'part_of', desc: '部分于传递（BFO:0000050）' },
      { type: 'TransitiveProperty', subject: 'has_part', desc: '有部分传递（BFO:0000051）' },
      { type: 'TransitiveProperty', subject: 'located_in', desc: '位于传递（RO:0001025）' },
      { type: 'TransitiveProperty', subject: 'precedes', desc: '先于传递（BFO:0000063，时序偏序）' },
      { type: 'InverseProperties', subject: 'inheres_in', object: 'bearer_of', desc: '内在于⇄承载 互逆（RO:0000052 ⇄ RO:0000053）' },
      { type: 'InverseProperties', subject: 'part_of', object: 'has_part', desc: '部分于⇄有部分 互逆（BFO:0000050 ⇄ BFO:0000051）' },
      { type: 'SymmetricProperty', subject: 'related_to', desc: '相关于对称（RO 兜底关系）' },
      { type: 'PropertyDomain', subject: 'inheres_in', object: 'specifically_dependent_continuant', desc: 'inheres_in 定义域=特依存持续体' },
      { type: 'PropertyRange', subject: 'inheres_in', object: 'independent_continuant', desc: 'inheres_in 值域=独立持续体（承载者）' },
      { type: 'PropertyDomain', subject: 'participates_in', object: 'continuant', desc: 'participates_in 定义域=持续体' },
      { type: 'PropertyRange', subject: 'participates_in', object: 'occurrent', desc: 'participates_in 值域=发生体' },
    ],
  },
  // iso15926：4D 三维时空观（11 类，two-stage prompt）
  iso15926: {
    id: 'iso15926',
    name: 'ISO 15926 工业体系',
    desc: 'ISO 15926 4D 时空观，工业数据集成与生命周期建模，two-stage 提取',
    promptMode: 'two-stage',
    fallbackType: 'physical_object',
    fallbackRel: 'relatedTo',
    classes: [
      { key: 'thing', label: '事物', code: 'ISO:thing', parent: '', desc: '顶层根类' },
      { key: 'possible_individual', label: '可能个体', code: 'ISO:PossibleIndividual', parent: 'thing', desc: '时空中的个体' },
      { key: 'physical_object', label: '物理对象', code: 'ISO:PhysicalObject', parent: 'possible_individual', desc: '占据时空的物理对象' },
      { key: 'whole_life_individual', label: '全生命周期个体', code: 'ISO:WholeLifeIndividual', parent: 'physical_object', desc: '含全部时间段的个体' },
      { key: 'arranged_individual', label: '组合个体', code: 'ISO:ArrangedIndividual', parent: 'physical_object', desc: '由部件组合而成的个体' },
      { key: 'activity', label: '活动', code: 'ISO:Activity', parent: 'possible_individual', desc: '有目的的活动' },
      { key: 'event', label: '事件', code: 'ISO:Event', parent: 'possible_individual', desc: '时间点事件' },
      { key: 'period_in_time', label: '时间段', code: 'ISO:PeriodInTime', parent: 'possible_individual', desc: '时间区间' },
      { key: 'abstract_object', label: '抽象对象', code: 'ISO:AbstractObject', parent: 'thing', desc: '非时空的抽象对象' },
      { key: 'class', label: '类', code: 'ISO:Class', parent: 'abstract_object', desc: '成员的类' },
      { key: 'class_of_class', label: '类的类', code: 'ISO:ClassOfClass', parent: 'class', desc: '以类为成员的类' },
      { key: 'class_of_individual', label: '个体的类', code: 'ISO:ClassOfIndividual', parent: 'class', desc: '以个体为成员的类' },
      { key: 'number', label: '数', code: 'ISO:Number', parent: 'abstract_object', desc: '数值对象' },
      { key: 'relationship', label: '关系对象', code: 'ISO:Relationship', parent: 'abstract_object', desc: '关系本身对象化' },
    ],
    predicates: [
      { key: 'classifiedBy', label: '归类于', code: 'ISO:classifiedBy', desc: '个体归于类' },
      { key: 'hasSuperclass', label: '父类为', code: 'ISO:hasSuperclass', desc: '类层级（向父）' },
      { key: 'hasClassMember', label: '含成员', code: 'ISO:hasClassMember', desc: '类含个体成员' },
      { key: 'temporalPartOf', label: '时间段属于', code: 'ISO:temporalPartOf', desc: '时间段整体-部分', features: ['transitive'] },
      { key: 'spatialPartOf', label: '空间部分于', code: 'ISO:spatialPartOf', desc: '空间整体-部分', features: ['transitive'] },
      { key: 'composedOf', label: '由组成', code: 'ISO:composedOf', desc: '组合关系' },
      { key: 'startsBefore', label: '开始早于', code: 'ISO:startsBefore', desc: '时序起点在前', features: ['transitive'] },
      { key: 'endsBefore', label: '结束早于', code: 'ISO:endsBefore', desc: '时序终点在前', features: ['transitive'] },
      { key: 'existsAt', label: '存在于', code: 'ISO:existsAt', desc: '存在于某时间段' },
      { key: 'involvedIn', label: '参与于', code: 'ISO:involvedIn', desc: '参与活动' },
      { key: 'connectedTo', label: '连接到', code: 'ISO:connectedTo', desc: '物理连接', features: ['symmetric'] },
      { key: 'containedIn', label: '包含于', code: 'ISO:containedIn', desc: '被包含', features: ['transitive'] },
      { key: 'representsIn', label: '表征于', code: 'ISO:representsIn', desc: '信息表征对象' },
      { key: 'relatedTo', label: '相关于', code: 'ISO:relatedTo', desc: '弱关联兜底', features: ['symmetric'] },
    ],
    constraints: [
      '节点类型须从 ISO 15926 类表选取，其余回退为 physical_object',
      '关系谓词须从 Part 7 模板选取，其余回退为 relatedTo',
      '禁止自环边（from == to）',
      '节点按规范化名称去重；边按 (from, to, rel) 去重',
      '可能个体（possible_individual）与抽象对象（abstract_object）顶层二分互斥，节点仅属其一',
      'classifiedBy 的定义域须为可能个体，值域须为个体的类（class_of_individual）',
      'hasSuperclass 仅用于 类→父类，两端都必须是 class 及其子类',
      'temporalPartOf / spatialPartOf / containedIn 为传递关系，链路避免 (A→B→A) 环路',
      'startsBefore / endsBefore 为时序偏序，仅作用于 event / period_in_time / activity 节点',
      'connectedTo 为对称的物理连接，仅作用于 physical_object 节点之间',
      'whole_life_individual 与 arranged_individual 均须归入 physical_object 之下，不可直接挂 thing',
      'number / relationship 等抽象对象不可与 physical_object 建立 connectedTo 等物理谓词',
    ],
    // OWL 逻辑公理（ISO 15926-2 数据模型 + Part 7 模板公理）
    axioms: [
      { type: 'DisjointClasses', subject: 'possible_individual', object: 'abstract_object', desc: '可能个体与抽象对象不相交（时空个体 vs 非时空对象）' },
      { type: 'DisjointClasses', subject: 'physical_object', object: 'activity', desc: '物理对象与活动不相交' },
      { type: 'SubClassOf', subject: 'whole_life_individual', object: 'physical_object', desc: '全生命周期个体⊑物理对象' },
      { type: 'SubClassOf', subject: 'arranged_individual', object: 'physical_object', desc: '组合个体⊑物理对象' },
      { type: 'SubClassOf', subject: 'class_of_class', object: 'class', desc: '类的类⊑类' },
      { type: 'SubClassOf', subject: 'class_of_individual', object: 'class', desc: '个体的类⊑类' },
      { type: 'TransitiveProperty', subject: 'temporalPartOf', desc: '时间段属于传递（时序区间包含）' },
      { type: 'TransitiveProperty', subject: 'spatialPartOf', desc: '空间部分于传递（空间区域包含）' },
      { type: 'TransitiveProperty', subject: 'composedOf', desc: '由组成传递（组合关系传递）' },
      { type: 'TransitiveProperty', subject: 'startsBefore', desc: '开始早于传递（时序起点偏序）' },
      { type: 'TransitiveProperty', subject: 'endsBefore', desc: '结束早于传递（时序终点偏序）' },
      { type: 'TransitiveProperty', subject: 'containedIn', desc: '包含于传递' },
      { type: 'SymmetricProperty', subject: 'connectedTo', desc: '连接到对称（物理连接无向）' },
      { type: 'SymmetricProperty', subject: 'relatedTo', desc: '相关于对称' },
      { type: 'PropertyDomain', subject: 'classifiedBy', object: 'possible_individual', desc: 'classifiedBy 定义域=可能个体' },
      { type: 'PropertyRange', subject: 'classifiedBy', object: 'class_of_individual', desc: 'classifiedBy 值域=个体的类' },
      { type: 'PropertyDomain', subject: 'hasSuperclass', object: 'class', desc: 'hasSuperclass 定义域=类' },
      { type: 'PropertyRange', subject: 'hasSuperclass', object: 'class', desc: 'hasSuperclass 值域=类（类层级自反传递）' },
    ],
  },
  // ogms：通用医学科学本体（35 类，two-stage prompt；类树与 ID 取自 OGMS 2021-08-19 发布版，
  // 谓词取 RO/BFO 医学子集并在 ro.owl 中核实过 IRI；label 中文 + key/code/desc 英文构成中英对照）
  ogms: {
    id: 'ogms',
    name: 'OGMS 医学体系',
    desc: 'Ontology for General Medical Science，医疗/临床/病历领域，中英对照，two-stage 提取',
    promptMode: 'two-stage',
    fallbackType: 'material_entity',
    fallbackRel: 'related_to',
    classes: [
      { key: 'disposition', label: '倾向', code: 'BFO:0000016', parent: '', desc: '顶层锚：倾向 disposition，可引发特定过程的可实现实体' },
      { key: 'material_entity', label: '物质实体', code: 'BFO:0000040', parent: '', desc: '顶层锚：物质实体 material entity，有物质构成的实体' },
      { key: 'process', label: '过程', code: 'BFO:0000015', parent: '', desc: '顶层锚：过程 process，在时间中展开的实体' },
      { key: 'quality', label: '性质', code: 'BFO:0000019', parent: '', desc: '顶层锚：性质 quality，内在于承载者的固有属性' },
      { key: 'information_content_entity', label: '信息内容实体', code: 'IAO:0000030', parent: '', desc: '顶层锚：信息内容实体 information content entity' },
      { key: 'planned_process', label: '计划过程', code: 'OBI:0000011', parent: 'process', desc: '计划过程 planned process：按计划执行的过程' },
      { key: 'data_item', label: '数据项', code: 'IAO:0000027', parent: 'information_content_entity', desc: '数据项 data item：测量/观察产生的信息内容' },
      { key: 'disease', label: '疾病', code: 'OGMS:0000031', parent: 'disposition', desc: '疾病 disease：经历病理过程的倾向（disposition）' },
      { key: 'disorder', label: '障碍', code: 'OGMS:0000045', parent: 'material_entity', desc: '障碍 disorder：临床异常的物质实体（material entity）' },
      { key: 'injury', label: '损伤', code: 'OGMS:0000102', parent: 'disorder', desc: '损伤 injury：外力所致的障碍（injury）' },
      { key: 'neoplasm', label: '肿瘤', code: 'OGMS:0000147', parent: 'disorder', desc: '肿瘤 neoplasm：组织异常增殖（源层级经 tissue disorder 归入障碍）' },
      { key: 'physical_sign', label: '物理体征', code: 'OGMS:0000129', parent: 'material_entity', desc: '物理体征 physical sign：客观可观测的异常物理实体' },
      { key: 'syndrome', label: '综合征', code: 'OGMS:0000086', parent: 'quality', desc: '综合征 syndrome：共现的临床表现集合（syndrome）' },
      { key: 'manifestation_of_a_disease', label: '疾病表现', code: 'OGMS:0000022', parent: 'quality', desc: '疾病表现 manifestation of a disease：疾病可观察的表现' },
      { key: 'phenotype', label: '表型', code: 'OGMS:0000023', parent: 'quality', desc: '表型 phenotype：可观测的性质组合（phenotype）' },
      { key: 'symptom', label: '症状', code: 'OGMS:0000020', parent: 'process', desc: '症状 symptom：患者主观异常体验，OGMS 建模为过程' },
      { key: 'pain', label: '疼痛', code: 'OGMS:0000085', parent: 'symptom', desc: '疼痛 pain：典型主观症状（pain）' },
      { key: 'clinical_data_item', label: '临床数据项', code: 'OGMS:0000123', parent: 'data_item', desc: '临床数据项 clinical data item：临床语境的数据项' },
      { key: 'clinical_finding', label: '临床发现', code: 'OGMS:0000014', parent: 'clinical_data_item', desc: '临床发现 clinical finding：检查/观察得出的数据项' },
      { key: 'laboratory_finding', label: '实验室发现', code: 'OGMS:0000018', parent: 'clinical_finding', desc: '实验室发现 laboratory finding：检验得出的临床发现' },
      { key: 'diagnosis', label: '诊断', code: 'OGMS:0000073', parent: 'clinical_data_item', desc: '诊断 diagnosis：关于疾病归属的结论性数据项' },
      { key: 'prognosis', label: '预后', code: 'OGMS:0000093', parent: 'data_item', desc: '预后 prognosis：对疾病结局的预测数据项' },
      { key: 'etiological_process', label: '病因过程', code: 'OGMS:0000059', parent: 'process', desc: '病因过程 etiological process：引发疾病/障碍的过程' },
      { key: 'bodily_process', label: '身体过程', code: 'OGMS:0000060', parent: 'process', desc: '身体过程 bodily process：机体内的生理过程' },
      { key: 'pathological_bodily_process', label: '病理身体过程', code: 'OGMS:0000061', parent: 'bodily_process', desc: '病理身体过程 pathological bodily process：异常的身体过程' },
      { key: 'disease_course', label: '疾病病程', code: 'OGMS:0000063', parent: 'process', desc: '疾病病程 disease course：疾病从发生到结束的过程' },
      { key: 'health_care_process', label: '医疗过程', code: 'OGMS:0000096', parent: 'planned_process', desc: '医疗过程 health care process：面向健康的计划过程' },
      { key: 'health_care_encounter', label: '医疗就诊', code: 'OGMS:0000097', parent: 'health_care_process', desc: '医疗就诊 health care encounter：医患接触过程' },
      { key: 'hospitalization', label: '住院', code: 'OGMS:0000098', parent: 'health_care_process', desc: '住院 hospitalization：住院形式的医疗过程' },
      { key: 'treatment', label: '治疗', code: 'OGMS:0000090', parent: 'health_care_process', desc: '治疗 treatment：以改善健康为目的的医疗过程' },
      { key: 'therapeutic_procedure', label: '治疗操作', code: 'OGMS:0000112', parent: 'treatment', desc: '治疗操作 therapeutic procedure：具体治疗手段（手术/化疗等）' },
      { key: 'health_care_process_assay', label: '医疗检测', code: 'OGMS:0000108', parent: 'health_care_process', desc: '医疗检测 health care process assay：检查/检验类医疗过程' },
      { key: 'physical_examination', label: '体格检查', code: 'OGMS:0000057', parent: 'health_care_process_assay', desc: '体格检查 physical examination：查体类检测' },
      { key: 'clinical_laboratory_test', label: '临床检验', code: 'OGMS:0000056', parent: 'health_care_process_assay', desc: '临床检验 clinical laboratory test：实验室检验' },
      { key: 'diagnostic_process', label: '诊断过程', code: 'OGMS:0000104', parent: 'health_care_process', desc: '诊断过程 diagnostic process：得出诊断结论的过程' },
    ],
    predicates: [
      { key: 'part_of', label: '部分于', code: 'BFO:0000050', desc: '整体-部分（part of）', features: ['transitive'] },
      { key: 'has_part', label: '有部分', code: 'BFO:0000051', desc: '部分-整体（has part）', features: ['transitive'] },
      { key: 'participates_in', label: '参与', code: 'RO:0000056', desc: '实体参与过程（participates in）', domain: 'material_entity', range: 'process' },
      { key: 'has_participant', label: '有参与者', code: 'RO:0000057', desc: '过程含参与者（has participant）', domain: 'process', range: 'material_entity' },
      { key: 'located_in', label: '位于', code: 'RO:0001025', desc: '空间/解剖位置（located in）', features: ['transitive'], domain: 'material_entity', range: 'material_entity' },
      { key: 'derives_from', label: '衍生自', code: 'RO:0001000', desc: '由后者演化而来（derives from）', features: ['transitive'] },
      { key: 'has_disposition', label: '有倾向', code: 'RO:0000091', desc: '承载者拥有倾向/疾病（has disposition）', domain: 'material_entity', range: 'disposition' },
      { key: 'realizes', label: '实现', code: 'BFO:0000055', desc: '过程实现倾向（realizes）', domain: 'process', range: 'disposition' },
      { key: 'occurs_in', label: '发生于', code: 'BFO:0000066', desc: '过程发生于某处/某器官（occurs in）', domain: 'process', range: 'material_entity' },
      { key: 'precedes', label: '先于', code: 'BFO:0000063', desc: '时序在前（precedes）', features: ['transitive'], domain: 'process', range: 'process' },
      { key: 'inheres_in', label: '内在于', code: 'RO:0000052', desc: '性质内在于承载者（inheres in）', domain: 'quality', range: 'material_entity' },
      { key: 'bearer_of', label: '承载', code: 'RO:0000053', desc: '承载者承载性质（bearer of）', domain: 'material_entity', range: 'quality' },
      { key: 'related_to', label: '相关于', code: 'RO:related', desc: '弱关联兜底（related to）', features: ['symmetric'] },
    ],
    constraints: [
      '节点类型须从 OGMS 类表选取，其余回退为 material_entity',
      '关系谓词须从 RO/BFO 医学子集选取，其余回退为 related_to',
      '禁止自环边（from == to）',
      '节点按规范化名称去重；边按 (from, to, rel) 去重',
      '疾病（disease，倾向）与障碍（disorder，物质实体）互斥，节点仅属其一',
      '症状（symptom）为过程（主观体验），体征/表型/综合征为性质或物质实体，主客观两类不可混挂',
      '诊断/临床发现/预后等为数据项（信息内容），不得挂到物质实体或过程分支',
      '医疗过程子类（就诊/住院/治疗/检测/诊断过程）须挂在计划过程（planned_process）分支下',
      'inheres_in 的定义域须为性质（quality），值域须为物质实体；bearer_of 方向相反',
      'participates_in 仅允许 物质实体→过程 方向，禁止反向',
      'part_of/has_part、inheres_in/bearer_of、participates_in/has_participant 为互逆对，成对出现时方向须一致',
      '因果/表现类表述优先用 realizes 或经病因过程（etiological_process）参与表达，不得一律以 related_to 代替',
    ],
    // OWL 逻辑公理（OGMS 2021-08-19 类层级 + BFO/RO 关系公理子集）
    axioms: [
      { type: 'DisjointClasses', subject: 'disposition', object: 'material_entity', desc: '倾向与物质实体不相交（BFO 顶层二分）' },
      { type: 'DisjointClasses', subject: 'disease', object: 'disorder', desc: '疾病（倾向）与障碍（物质实体）不相交（OGMS 核心区分）' },
      { type: 'DisjointClasses', subject: 'quality', object: 'process', desc: '性质与过程不相交（客观属性 vs 时间展开）' },
      { type: 'DisjointClasses', subject: 'information_content_entity', object: 'material_entity', desc: '信息内容实体与物质实体不相交' },
      { type: 'SubClassOf', subject: 'disease', object: 'disposition', desc: '疾病⊑倾向（OGMS:0000031 ⊑ BFO:0000016）' },
      { type: 'SubClassOf', subject: 'disorder', object: 'material_entity', desc: '障碍⊑物质实体（OGMS:0000045 ⊑ BFO:0000040）' },
      { type: 'SubClassOf', subject: 'symptom', object: 'process', desc: '症状⊑过程（OGMS:0000020 ⊑ BFO:0000015）' },
      { type: 'SubClassOf', subject: 'phenotype', object: 'quality', desc: '表型⊑性质（OGMS:0000023 ⊑ BFO:0000019）' },
      { type: 'SubClassOf', subject: 'data_item', object: 'information_content_entity', desc: '数据项⊑信息内容实体（IAO:0000027 ⊑ IAO:0000030）' },
      { type: 'SubClassOf', subject: 'clinical_data_item', object: 'data_item', desc: '临床数据项⊑数据项（OGMS:0000123）' },
      { type: 'SubClassOf', subject: 'health_care_process', object: 'planned_process', desc: '医疗过程⊑计划过程（OGMS:0000096 ⊑ OBI:0000011）' },
      { type: 'SubClassOf', subject: 'pathological_bodily_process', object: 'bodily_process', desc: '病理身体过程⊑身体过程（OGMS:0000061 ⊑ OGMS:0000060）' },
      { type: 'TransitiveProperty', subject: 'part_of', desc: '部分于传递（BFO:0000050）' },
      { type: 'TransitiveProperty', subject: 'has_part', desc: '有部分传递（BFO:0000051）' },
      { type: 'TransitiveProperty', subject: 'located_in', desc: '位于传递（RO:0001025，解剖位置链）' },
      { type: 'TransitiveProperty', subject: 'precedes', desc: '先于传递（BFO:0000063，病程时序偏序）' },
      { type: 'TransitiveProperty', subject: 'derives_from', desc: '衍生自传递（RO:0001000）' },
      { type: 'InverseProperties', subject: 'part_of', object: 'has_part', desc: '部分于⇄有部分 互逆（BFO:0000050 ⇄ BFO:0000051）' },
      { type: 'InverseProperties', subject: 'inheres_in', object: 'bearer_of', desc: '内在于⇄承载 互逆（RO:0000052 ⇄ RO:0000053）' },
      { type: 'InverseProperties', subject: 'participates_in', object: 'has_participant', desc: '参与⇄有参与者 互逆（RO:0000056 ⇄ RO:0000057）' },
      { type: 'SymmetricProperty', subject: 'related_to', desc: '相关于对称（RO 兜底关系）' },
      { type: 'PropertyDomain', subject: 'inheres_in', object: 'quality', desc: 'inheres_in 定义域=性质' },
      { type: 'PropertyRange', subject: 'inheres_in', object: 'material_entity', desc: 'inheres_in 值域=物质实体（承载者）' },
      { type: 'PropertyDomain', subject: 'has_disposition', object: 'material_entity', desc: 'has_disposition 定义域=物质实体' },
      { type: 'PropertyRange', subject: 'has_disposition', object: 'disposition', desc: 'has_disposition 值域=倾向（疾病挂靠点）' },
      { type: 'PropertyDomain', subject: 'realizes', object: 'process', desc: 'realizes 定义域=过程' },
      { type: 'PropertyRange', subject: 'realizes', object: 'disposition', desc: 'realizes 值域=倾向（病程实现疾病）' },
    ],
  },
  // legal：法律体系（LKIF Core 精选，43 类，two-stage prompt，中英对照）
  // 源自 LKIF Core（Legal Knowledge Interchange Format，ESTRELLA 联盟）：规范/法律渊源/表述/行为/主体/角色六大分支。
  legal: {
    id: 'legal',
    name: '法律体系（LKIF）',
    desc: 'Legal Knowledge Interchange Format 核心法律本体精选，法律/规范/合同/判例领域，中英对照，two-stage 提取',
    promptMode: 'two-stage',
    fallbackType: 'Thing',
    fallbackRel: 'related_to',
    classes: [
      { key: 'Thing', label: '事物', code: 'LKIF:Thing', parent: '', desc: '顶层根类 thing：法律领域任何实体' },
      // —— 规范（Norm）：应然层 ——
      { key: 'Norm', label: '规范', code: 'LKIF:Norm', parent: 'Thing', desc: '规范 norm：规定应当/可以/禁止的规范性表达' },
      { key: 'Permission', label: '许可', code: 'LKIF:Permission', parent: 'Norm', desc: '许可 permission：允许某行为的规范' },
      { key: 'Obligation', label: '义务', code: 'LKIF:Obligation', parent: 'Norm', desc: '义务 obligation：要求必须为某行为的规范' },
      { key: 'Prohibition', label: '禁止', code: 'LKIF:Prohibition', parent: 'Norm', desc: '禁止 prohibition：禁止某行为的规范' },
      { key: 'Right', label: '权利', code: 'LKIF:Right', parent: 'Norm', desc: '权利 right：主体可主张的规范地位' },
      { key: 'Liberty_Right', label: '自由权', code: 'LKIF:Liberty_Right', parent: 'Right', desc: '自由权 liberty right：免于干涉的自由（Hohfeld liberty）' },
      { key: 'Obligative_Right', label: '请求权', code: 'LKIF:Obligative_Right', parent: 'Right', desc: '请求权 obligative right：要求他人为/不为的权利（claim）' },
      { key: 'Power', label: '权力', code: 'LKIF:Hohfeldian_Power', parent: 'Norm', desc: '权力 power：变更法律关系的能力（Hohfeldian power）' },
      { key: 'Immunity', label: '豁免', code: 'LKIF:Immunity', parent: 'Power', desc: '豁免 immunity：免于他人权力支配的地位' },
      // —— 法律渊源（Legal_Source）——
      { key: 'Legal_Source', label: '法律渊源', code: 'LKIF:Legal_Source', parent: 'Thing', desc: '法律渊源 legal source：法律规范的来源' },
      { key: 'Legal_Document', label: '法律文件', code: 'LKIF:Legal_Document', parent: 'Legal_Source', desc: '法律文件 legal document：成文的法律文件' },
      { key: 'Contract', label: '合同', code: 'LKIF:Contract', parent: 'Legal_Document', desc: '合同 contract：当事人间设立权利义务的协议' },
      { key: 'Code', label: '法典', code: 'LKIF:Code', parent: 'Legal_Document', desc: '法典 code：系统编纂的成文法' },
      { key: 'Statute', label: '制定法', code: 'LKIF:Statute', parent: 'Legal_Source', desc: '制定法 statute：立法机关制定的法律' },
      { key: 'Regulation', label: '法规', code: 'LKIF:Regulation', parent: 'Legal_Source', desc: '法规 regulation：行政机关制定的规范性文件' },
      { key: 'Proclamation', label: '公告', code: 'LKIF:Proclamation', parent: 'Legal_Source', desc: '公告 proclamation：正式宣告的法律文件' },
      { key: 'Directive', label: '指令', code: 'LKIF:Directive', parent: 'Proclamation', desc: '指令 directive：要求达成目标的规范（如欧盟指令）' },
      { key: 'Customary_Law', label: '习惯法', code: 'LKIF:Customary_Law', parent: 'Legal_Source', desc: '习惯法 customary law：经长期惯例形成的法律' },
      { key: 'Precedent', label: '判例', code: 'LKIF:Precedent', parent: 'Legal_Source', desc: '判例 precedent：法院先例' },
      { key: 'Mandatory_Precedent', label: '强制性判例', code: 'LKIF:Mandatory_Precedent', parent: 'Precedent', desc: '强制性判例 mandatory precedent：具拘束力的先例' },
      { key: 'International_Agreement', label: '国际协议', code: 'LKIF:International_Agreement', parent: 'Legal_Source', desc: '国际协议 international agreement：国家/主体间的国际约定' },
      { key: 'Treaty', label: '条约', code: 'LKIF:Treaty', parent: 'International_Agreement', desc: '条约 treaty：具法律拘束力的国际协议' },
      // —— 表述（Expression）——
      { key: 'Expression', label: '表述', code: 'LKIF:Expression', parent: 'Thing', desc: '表述 expression：被表达的内容（文档/陈述/命题）' },
      { key: 'Legal_Expression', label: '法律表述', code: 'LKIF:Legal_Expression', parent: 'Expression', desc: '法律表述 legal expression：具法律意义的表述' },
      { key: 'Qualificatory_Expression', label: '定性表述', code: 'LKIF:Qualificatory_Expression', parent: 'Legal_Expression', desc: '定性表述 qualificatory expression：将事实归入法律概念的表述' },
      // —— 行为（Action）：实然层 ——
      { key: 'Action', label: '行为', code: 'LKIF:Action', parent: 'Thing', desc: '行为 action：主体实施的行为' },
      { key: 'Public_Act', label: '公法行为', code: 'LKIF:Public_Act', parent: 'Action', desc: '公法行为 public act：公权力主体实施的行为' },
      { key: 'Act_of_Law', label: '立法行为', code: 'LKIF:Act_of_Law', parent: 'Public_Act', desc: '立法行为 act of law：制定法律的行为' },
      { key: 'Legal_Speech_Act', label: '法律言语行为', code: 'LKIF:Legal_Speech_Act', parent: 'Action', desc: '法律言语行为 legal speech act：产生法律效果的言语行为' },
      { key: 'Assignment', label: '转让', code: 'LKIF:Assignment', parent: 'Legal_Speech_Act', desc: '转让 assignment：权利/义务的转移行为' },
      { key: 'Delegation', label: '委托', code: 'LKIF:Delegation', parent: 'Legal_Speech_Act', desc: '委托 delegation：将职权委托他人的行为' },
      { key: 'Transaction', label: '交易', code: 'LKIF:Transaction', parent: 'Action', desc: '交易 transaction：多方协作的财产/权利交换行为' },
      // —— 主体（Agent）——
      { key: 'Agent', label: '主体', code: 'LKIF:Agent', parent: 'Thing', desc: '主体 agent：能实施行为的主体（人/组织）' },
      { key: 'Person', label: '人', code: 'LKIF:Person', parent: 'Agent', desc: '人 person：自然人主体' },
      { key: 'Natural_Person', label: '自然人', code: 'LKIF:Natural_Person', parent: 'Person', desc: '自然人 natural person：生物学意义上的人' },
      { key: 'Organisation', label: '组织', code: 'LKIF:Organisation', parent: 'Agent', desc: '组织 organisation：多人构成的机构' },
      { key: 'Legal_Person', label: '法人', code: 'LKIF:Legal_Person', parent: 'Organisation', desc: '法人 legal person：具法律人格的组织' },
      { key: 'Public_Body', label: '公共机构', code: 'LKIF:Public_Body', parent: 'Legal_Person', desc: '公共机构 public body：行使公权力的法人' },
      { key: 'Company', label: '公司', code: 'LKIF:Company', parent: 'Legal_Person', desc: '公司 company：以营利为目的的法人' },
      // —— 角色（Role）——
      { key: 'Role', label: '角色', code: 'LKIF:Role', parent: 'Thing', desc: '角色 role：主体在特定语境承担的身份' },
      { key: 'Legal_Role', label: '法律角色', code: 'LKIF:Legal_Role', parent: 'Role', desc: '法律角色 legal role：由法律赋予的角色' },
      { key: 'Professional_Legal_Role', label: '职业法律角色', code: 'LKIF:Professional_Legal_Role', parent: 'Legal_Role', desc: '职业法律角色 professional legal role：法官/律师等职业角色' },
    ],
    predicates: [
      { key: 'qualifies', label: '定性', code: 'LKIF:qualifies', desc: '法律定性：把事实归入法律概念（qualifies）' },
      { key: 'counts_as', label: '算作', code: 'LKIF:counts_as', desc: '构成性规则：X 在法律上算作 Y（counts as）' },
      { key: 'allows', label: '允许', code: 'LKIF:allows', desc: '规范允许某行为（allows）', domain: 'Norm', range: 'Action' },
      { key: 'disallows', label: '禁止', code: 'LKIF:disallows', desc: '规范禁止某行为（disallows）', domain: 'Norm', range: 'Action' },
      { key: 'commands', label: '命令', code: 'LKIF:commands', desc: '规范要求必须为某行为（commands）', domain: 'Norm', range: 'Action' },
      { key: 'holds', label: '成立', code: 'LKIF:holds', desc: '规范/权利在某语境下成立（holds）', domain: 'Norm' },
      { key: 'imposed_on', label: '施加于', code: 'LKIF:imposed_on', desc: '义务/责任施加于主体（imposed on）', domain: 'Obligation', range: 'Agent' },
      { key: 'plays', label: '扮演', code: 'LKIF:plays', desc: '主体扮演角色（plays）', domain: 'Agent', range: 'Role' },
      { key: 'actor', label: '行为主体', code: 'LKIF:actor', desc: '行为的行为者（actor）', domain: 'Action', range: 'Agent' },
      { key: 'participant', label: '参与者', code: 'LKIF:participant', desc: '行为的参与者（participant）', domain: 'Action', range: 'Agent' },
      { key: 'declares', label: '声明', code: 'LKIF:declares', desc: '法律言语行为声明某表述（declares）', domain: 'Legal_Speech_Act', range: 'Expression' },
      { key: 'part_of', label: '部分于', code: 'LKIF:part_of', desc: '整体-部分（part of）', features: ['transitive'] },
      { key: 'composed_of', label: '由...组成', code: 'LKIF:composed_of', desc: '由部分组成（composed of）', features: ['transitive'] },
      { key: 'after', label: '之后', code: 'LKIF:after', desc: '时间在后（after）', features: ['transitive'], domain: 'Action', range: 'Action' },
      { key: 'normatively_comparable', label: '规范可比', code: 'LKIF:normatively_comparable', desc: '规范强度可比较（normatively comparable）', features: ['symmetric'], domain: 'Norm', range: 'Norm' },
      { key: 'related_to', label: '相关于', code: 'LKIF:related', desc: '弱关联兜底（related to）', features: ['symmetric'] },
    ],
    constraints: [
      '节点类型须从 LKIF 法律类表选取，其余回退为 Thing',
      '关系谓词须从 LKIF 法律关系子集选取，其余回退为 related_to',
      '禁止自环边（from == to）',
      '节点按规范化名称去重；边按 (from, to, rel) 去重',
      '规范（Norm，应然）与行为（Action，实然）互斥，节点不可同时归类',
      '许可（Permission）、义务（Obligation）、禁止（Prohibition）三类规范互斥，同一规范节点仅属其一',
      '权利（Right）为可主张的规范地位、权力（Power）为变更法律关系的能力，二者不可混挂',
      '法律渊源子类（制定法/法规/合同/判例/条约等）须挂在 Legal_Source 分支下，不得混入规范或表述分支',
      'allows/disallows/commands 的定义域须为规范（Norm）、值域须为行为（Action）',
      'imposed_on 仅允许 义务→主体 方向；plays 仅允许 主体→角色 方向',
      'actor/participant 仅用于 行为→主体 方向，不得反向',
      'part_of/composed_of 为互逆的传递关系，成对出现时方向须一致',
      '定性（qualifies）/算作（counts_as）表达构成性规则，不得一律以 related_to 代替',
    ],
    // OWL 逻辑公理（LKIF Core 类层级 + 法律关系公理子集）
    axioms: [
      { type: 'DisjointClasses', subject: 'Norm', object: 'Action', desc: '规范与行为不相交（应然 vs 实然）' },
      { type: 'DisjointClasses', subject: 'Permission', object: 'Prohibition', desc: '许可与禁止不相交' },
      { type: 'DisjointClasses', subject: 'Obligation', object: 'Prohibition', desc: '义务与禁止不相交' },
      { type: 'DisjointClasses', subject: 'Permission', object: 'Obligation', desc: '许可与义务不相交' },
      { type: 'DisjointClasses', subject: 'Right', object: 'Power', desc: '权利与权力不相交（Hohfeld 区分）' },
      { type: 'DisjointClasses', subject: 'Agent', object: 'Role', desc: '主体与角色不相交（承担者 vs 身份）' },
      { type: 'SubClassOf', subject: 'Obligation', object: 'Norm', desc: '义务⊑规范' },
      { type: 'SubClassOf', subject: 'Right', object: 'Norm', desc: '权利⊑规范' },
      { type: 'SubClassOf', subject: 'Contract', object: 'Legal_Document', desc: '合同⊑法律文件' },
      { type: 'SubClassOf', subject: 'Treaty', object: 'International_Agreement', desc: '条约⊑国际协议' },
      { type: 'SubClassOf', subject: 'Natural_Person', object: 'Person', desc: '自然人⊑人' },
      { type: 'SubClassOf', subject: 'Person', object: 'Agent', desc: '人⊑主体' },
      { type: 'SubClassOf', subject: 'Legal_Person', object: 'Organisation', desc: '法人⊑组织' },
      { type: 'SubClassOf', subject: 'Act_of_Law', object: 'Public_Act', desc: '立法行为⊑公法行为' },
      { type: 'SubClassOf', subject: 'Legal_Role', object: 'Role', desc: '法律角色⊑角色' },
      { type: 'SubClassOf', subject: 'Mandatory_Precedent', object: 'Precedent', desc: '强制性判例⊑判例' },
      { type: 'TransitiveProperty', subject: 'part_of', desc: '部分于传递' },
      { type: 'TransitiveProperty', subject: 'composed_of', desc: '由...组成传递' },
      { type: 'TransitiveProperty', subject: 'after', desc: '之后传递（时间偏序）' },
      { type: 'SymmetricProperty', subject: 'related_to', desc: '相关于对称（兜底关系）' },
      { type: 'SymmetricProperty', subject: 'normatively_comparable', desc: '规范可比对称' },
      { type: 'InverseProperties', subject: 'part_of', object: 'composed_of', desc: '部分于⇄由...组成 互逆' },
      { type: 'PropertyDomain', subject: 'allows', object: 'Norm', desc: 'allows 定义域=规范' },
      { type: 'PropertyRange', subject: 'allows', object: 'Action', desc: 'allows 值域=行为' },
      { type: 'PropertyDomain', subject: 'commands', object: 'Norm', desc: 'commands 定义域=规范' },
      { type: 'PropertyRange', subject: 'commands', object: 'Action', desc: 'commands 值域=行为' },
      { type: 'PropertyDomain', subject: 'imposed_on', object: 'Obligation', desc: 'imposed_on 定义域=义务' },
      { type: 'PropertyRange', subject: 'imposed_on', object: 'Agent', desc: 'imposed_on 值域=主体' },
      { type: 'PropertyDomain', subject: 'plays', object: 'Agent', desc: 'plays 定义域=主体' },
      { type: 'PropertyRange', subject: 'plays', object: 'Role', desc: 'plays 值域=角色' },
      { type: 'PropertyDomain', subject: 'actor', object: 'Action', desc: 'actor 定义域=行为' },
      { type: 'PropertyRange', subject: 'actor', object: 'Agent', desc: 'actor 值域=主体' },
    ],
  },
  // automotive：汽车制造体系（IOF Core 精选 + 汽车领域扩展，50 类，two-stage prompt，中英对照）
  // 制造骨干源自 IOF Core（Industrial Ontologies Foundry，OAGi 发布，BFO 2020 基础，data/ontology/iof-core.rdf）：
  //   产品/装配体/物料组件/原材料/装备/制造过程/装配过程/测量过程/物料状态/规范/主体八大支。
  // 汽车专属类（整车/车身/动力总成/底盘/发动机/动力电池/零部件，四大工艺冲压/焊装/涂装/装配）为领域扩展（AUTO: 前缀），挂在 IOF 骨干上。
  automotive: {
    id: 'automotive',
    name: '汽车制造体系（IOF）',
    desc: 'Industrial Ontologies Foundry Core 制造本体精选 + 汽车领域扩展，整车/零部件/四大工艺/装备/物料/质量领域，中英对照，two-stage 提取',
    promptMode: 'two-stage',
    fallbackType: 'MaterialEntity',
    fallbackRel: 'related_to',
    classes: [
      // —— BFO 顶层锚点 ——
      { key: 'MaterialEntity', label: '物质实体', code: 'BFO:0000040', parent: '', desc: '顶层锚：物质实体 material entity，有物质构成的实体' },
      { key: 'Process', label: '过程', code: 'BFO:0000015', parent: '', desc: '顶层锚：过程 process，在时间中展开的实体' },
      { key: 'InformationContentEntity', label: '信息内容实体', code: 'BFO:0000031', parent: '', desc: '顶层锚：信息内容实体 information content entity' },
      { key: 'Quality', label: '性质', code: 'BFO:0000019', parent: '', desc: '顶层锚：性质 quality，内在于承载者的固有属性' },
      { key: 'RealizableEntity', label: '可实现实体', code: 'BFO:0000017', parent: '', desc: '顶层锚：可实现实体 realizable entity（能力/功能/倾向）' },
      // —— 主体与组织（Agent）——
      { key: 'Agent', label: '主体', code: 'IOF:Agent', parent: 'MaterialEntity', desc: '主体 agent：能实施行为的主体（人/组织）' },
      { key: 'Person', label: '人', code: 'IOF:Person', parent: 'MaterialEntity', desc: '人 person：自然人' },
      { key: 'Organization', label: '组织', code: 'IOF:Organization', parent: 'Agent', desc: '组织 organization：多人构成的机构' },
      { key: 'BusinessOrganization', label: '商业组织', code: 'IOF:BusinessOrganization', parent: 'Organization', desc: '商业组织 business organization：从事经营活动的组织' },
      { key: 'Manufacturer', label: '制造商', code: 'IOF:Manufacturer', parent: 'Agent', desc: '制造商 manufacturer：生产产品的主体' },
      { key: 'Supplier', label: '供应商', code: 'IOF:Supplier', parent: 'Agent', desc: '供应商 supplier：提供物料/零部件的主体' },
      // —— 产品与物料（IOF Core）——
      { key: 'MaterialArtifact', label: '物料制品', code: 'IOF:MaterialArtifact', parent: 'MaterialEntity', desc: '物料制品 material artifact：经加工制成的人造物' },
      { key: 'MaterialProduct', label: '物料产品', code: 'IOF:MaterialProduct', parent: 'MaterialEntity', desc: '物料产品 material product：作为产品输出的物料' },
      { key: 'Assembly', label: '装配体', code: 'IOF:Assembly', parent: 'MaterialArtifact', desc: '装配体 assembly：由多个零部件装配而成的制品' },
      { key: 'MaterialComponent', label: '物料组件', code: 'IOF:MaterialComponent', parent: 'MaterialEntity', desc: '物料组件 material component：构成装配体的零部件' },
      { key: 'RawMaterial', label: '原材料', code: 'IOF:RawMaterial', parent: 'MaterialEntity', desc: '原材料 raw material：未经加工的初始物料（钢板/铝材/塑料粒）' },
      { key: 'Consumable', label: '消耗品', code: 'IOF:Consumable', parent: 'MaterialEntity', desc: '消耗品 consumable：过程中被消耗的物料（焊材/涂料/刀具）' },
      { key: 'PieceOfEquipment', label: '设备', code: 'IOF:PieceOfEquipment', parent: 'MaterialEntity', desc: '设备 piece of equipment：执行制造/测量的装备（冲压机/焊机器人/涂装线）' },
      { key: 'EngineeredSystem', label: '工程系统', code: 'IOF:EngineeredSystem', parent: 'MaterialEntity', desc: '工程系统 engineered system：多设备協同的系统（产线/车间）' },
      // —— 汽车产品（领域扩展 AUTO）——
      { key: 'Vehicle', label: '整车', code: 'AUTO:Vehicle', parent: 'Assembly', desc: '整车 vehicle：完整的汽车产品（领域扩展，⊑装配体）' },
      { key: 'VehicleBody', label: '车身', code: 'AUTO:VehicleBody', parent: 'Assembly', desc: '车身 vehicle body：白车身/车身总成（领域扩展）' },
      { key: 'Powertrain', label: '动力总成', code: 'AUTO:Powertrain', parent: 'Assembly', desc: '动力总成 powertrain：发动机/电机与传动系统（领域扩展）' },
      { key: 'Chassis', label: '底盘', code: 'AUTO:Chassis', parent: 'Assembly', desc: '底盘 chassis：行驶/转向/制动系统总成（领域扩展）' },
      { key: 'Engine', label: '发动机', code: 'AUTO:Engine', parent: 'MaterialArtifact', desc: '发动机 engine：内燃机/驱动电机（领域扩展）' },
      { key: 'TractionBattery', label: '动力电池', code: 'AUTO:TractionBattery', parent: 'MaterialArtifact', desc: '动力电池 traction battery：电动车驱动电池包（领域扩展）' },
      { key: 'AutomotivePart', label: '汽车零部件', code: 'AUTO:AutomotivePart', parent: 'MaterialComponent', desc: '汽车零部件 automotive part：构成整车/总成的零件（领域扩展）' },
      // —— 制造过程（IOF Core）——
      { key: 'PlannedProcess', label: '计划过程', code: 'IOF:PlannedProcess', parent: 'Process', desc: '计划过程 planned process：按计划执行的过程' },
      { key: 'ManufacturingProcess', label: '制造过程', code: 'IOF:ManufacturingProcess', parent: 'PlannedProcess', desc: '制造过程 manufacturing process：将原材料转化为产品的过程' },
      { key: 'AssemblyProcess', label: '装配过程', code: 'IOF:AssemblyProcess', parent: 'ManufacturingProcess', desc: '装配过程 assembly process：将零部件装配为总成的过程' },
      { key: 'BusinessProcess', label: '业务过程', code: 'IOF:BusinessProcess', parent: 'PlannedProcess', desc: '业务过程 business process：企业运营业务过程' },
      { key: 'ProductProductionProcess', label: '产品生产过程', code: 'IOF:ProductProductionProcess', parent: 'BusinessProcess', desc: '产品生产过程 product production process：面向产品的生产业务过程' },
      { key: 'MeasurementProcess', label: '测量过程', code: 'IOF:MeasurementProcess', parent: 'PlannedProcess', desc: '测量过程 measurement process：获取量值/质量数据的过程' },
      { key: 'MaterialLocationChangeProcess', label: '物料搬运过程', code: 'IOF:MaterialLocationChangeProcess', parent: 'PlannedProcess', desc: '物料搬运过程 material location change process：物流/上线配送' },
      // —— 汽车四大工艺（领域扩展 AUTO）——
      { key: 'StampingProcess', label: '冲压过程', code: 'AUTO:StampingProcess', parent: 'ManufacturingProcess', desc: '冲压过程 stamping process：钢板冲压成形（领域扩展，四大工艺之一）' },
      { key: 'WeldingProcess', label: '焊装过程', code: 'AUTO:WeldingProcess', parent: 'ManufacturingProcess', desc: '焊装过程 welding process：车身焊接拼装（领域扩展，四大工艺之一）' },
      { key: 'PaintingProcess', label: '涂装过程', code: 'AUTO:PaintingProcess', parent: 'ManufacturingProcess', desc: '涂装过程 painting process：车身涂装防腐（领域扩展，四大工艺之一）' },
      { key: 'QualityInspectionProcess', label: '质量检验过程', code: 'AUTO:QualityInspectionProcess', parent: 'MeasurementProcess', desc: '质量检验过程 quality inspection process：零件/整车质量检测（领域扩展）' },
      // —— 质量与状态 ——
      { key: 'ProcessCharacteristic', label: '过程特性', code: 'IOF:ProcessCharacteristic', parent: 'Quality', desc: '过程特性 process characteristic：过程可量化的特性（温度/压力/节拍）' },
      { key: 'MaterialState', label: '物料状态', code: 'IOF:MaterialState', parent: 'Process', desc: '物料状态 material state：物料在过程中的状态（IOF 建模为过程）' },
      { key: 'Defect', label: '缺陷', code: 'AUTO:Defect', parent: 'Quality', desc: '缺陷 defect：不符合质量要求的性质（领域扩展）' },
      // —— 能力与功能 ——
      { key: 'Capability', label: '能力', code: 'IOF:Capability', parent: 'RealizableEntity', desc: '能力 capability：实体可引发特定过程的可实现能力' },
      { key: 'MeasurementCapability', label: '测量能力', code: 'IOF:MeasurementCapability', parent: 'Capability', desc: '测量能力 measurement capability：执行测量的能力' },
      { key: 'DesignedFunction', label: '设计功能', code: 'IOF:DesignedFunction', parent: 'RealizableEntity', desc: '设计功能 designed function：制品被设计实现的功能' },
      // —— 规范与信息（IOF Core）——
      { key: 'PlanSpecification', label: '计划规范', code: 'IOF:PlanSpecification', parent: 'InformationContentEntity', desc: '计划规范 plan specification：指导过程执行的规范（工艺文件）' },
      { key: 'ActionSpecification', label: '行动规范', code: 'IOF:ActionSpecification', parent: 'InformationContentEntity', desc: '行动规范 action specification：规定具体动作的规范（工序/工步）' },
      { key: 'DesignSpecification', label: '设计规范', code: 'IOF:DesignSpecification', parent: 'InformationContentEntity', desc: '设计规范 design specification：产品/零部件设计图纸与规范' },
      { key: 'RequirementSpecification', label: '需求规范', code: 'IOF:RequirementSpecification', parent: 'InformationContentEntity', desc: '需求规范 requirement specification：产品/过程需满足的要求' },
      { key: 'ObjectiveSpecification', label: '目标规范', code: 'IOF:ObjectiveSpecification', parent: 'InformationContentEntity', desc: '目标规范 objective specification：过程预期达成的目标' },
      { key: 'MeasurementInformationContentEntity', label: '测量信息', code: 'IOF:MeasurementInformationContentEntity', parent: 'InformationContentEntity', desc: '测量信息 measurement information content entity：测量产生的数据/记录' },
      { key: 'ValueExpression', label: '值表达式', code: 'IOF:ValueExpression', parent: 'InformationContentEntity', desc: '值表达式 value expression：量值/阈值/区间的表达' },
    ],
    predicates: [
      { key: 'hasInput', label: '有输入', code: 'IOF:hasInput', desc: '过程消耗输入物料（has input）', domain: 'Process', range: 'MaterialEntity' },
      { key: 'hasOutput', label: '有输出', code: 'IOF:hasOutput', desc: '过程产出输出物料（has output）', domain: 'Process', range: 'MaterialEntity' },
      { key: 'hasSpecifiedOutput', label: '有规定输出', code: 'IOF:hasSpecifiedOutput', desc: '计划过程规定应产出的输出（has specified output）', domain: 'PlannedProcess', range: 'MaterialEntity' },
      { key: 'hasComponentPart', label: '有零部件', code: 'IOF:hasComponentPartAtAllTimes', desc: '装配体含零部件（has component part）', features: ['transitive'], domain: 'MaterialEntity', range: 'MaterialEntity' },
      { key: 'componentPartOf', label: '零部件属于', code: 'IOF:componentPartOfAtAllTimes', desc: '零部件属于装配体（component part of）', features: ['transitive'], domain: 'MaterialEntity', range: 'MaterialEntity' },
      { key: 'isMadeOf', label: '由...制成', code: 'IOF:isMadeOfAtAllTimes', desc: '制品由某原材料制成（is made of）', domain: 'MaterialEntity', range: 'MaterialEntity' },
      { key: 'hasMaterialState', label: '有物料状态', code: 'IOF:hasMaterialState', desc: '物料处于某状态（has material state）', domain: 'MaterialEntity', range: 'MaterialState' },
      { key: 'hasProcessCharacteristic', label: '有过程特性', code: 'IOF:hasProcessCharacteristic', desc: '过程具备某特性（has process characteristic）', domain: 'Process', range: 'ProcessCharacteristic' },
      { key: 'hasQuality', label: '有性质', code: 'IOF:hasQuality', desc: '实体拥有性质/缺陷（has quality）', domain: 'MaterialEntity', range: 'Quality' },
      { key: 'hasCapability', label: '有能力', code: 'IOF:hasCapability', desc: '实体拥有能力（has capability）', domain: 'MaterialEntity', range: 'Capability' },
      { key: 'hasFunction', label: '有功能', code: 'IOF:hasFunction', desc: '制品拥有设计功能（has function）', domain: 'MaterialEntity', range: 'DesignedFunction' },
      { key: 'classifiedBy', label: '被分类', code: 'IOF:classifiedBy', desc: '实体被分类器/信息分类（classified by）', domain: 'MaterialEntity', range: 'InformationContentEntity' },
      { key: 'describes', label: '描述', code: 'IOF:describes', desc: '信息内容描述实体（describes）', domain: 'InformationContentEntity', range: 'MaterialEntity' },
      { key: 'prescribes', label: '规定', code: 'IOF:prescribes', desc: '规范规定过程/行为（prescribes）', domain: 'InformationContentEntity', range: 'Process' },
      { key: 'satisfiesRequirement', label: '满足需求', code: 'IOF:satisfiesRequirement', desc: '实体满足需求规范（satisfies requirement）', domain: 'MaterialEntity', range: 'RequirementSpecification' },
      { key: 'before', label: '先于', code: 'IOF:before', desc: '过程时序在前（before）', features: ['transitive'], domain: 'Process', range: 'Process' },
      { key: 'after', label: '后于', code: 'IOF:after', desc: '过程时序在后（after）', features: ['transitive'], domain: 'Process', range: 'Process' },
      { key: 'related_to', label: '相关于', code: 'AUTO:related', desc: '弱关联兜底（related to）', features: ['symmetric'] },
    ],
    constraints: [
      '节点类型须从 IOF/汽车制造类表选取，其余回退为 MaterialEntity',
      '关系谓词须从 IOF Core 制造谓词选取，其余回退为 related_to',
      '禁止自环边（from == to）',
      '节点按规范化名称去重；边按 (from, to, rel) 去重',
      '产品/物料（MaterialEntity 分支）与制造过程（Process 分支）互斥，节点不可同时归类',
      '整车/车身/动力总成/底盘为装配体（Assembly），发动机/动力电池为物料制品，汽车零部件为物料组件，按粒度归入对应分支',
      '四大工艺（冲压/焊装/涂装/装配）须挂在制造过程（ManufacturingProcess）分支下；质量检验挂在测量过程下',
      'hasInput/hasOutput 仅允许 过程→物料 方向；hasSpecifiedOutput 仅用于计划过程',
      'hasComponentPart/componentPartOf 为互逆传递关系，成对出现时方向须一致',
      'hasQuality/hasCapability/hasFunction 的定义域须为物质实体，值域分别须为性质/能力/设计功能',
      'prescribes 仅允许 信息内容实体→过程 方向；satisfiesRequirement 仅允许 物料→需求规范 方向',
      'before/after 仅用于 过程→过程 方向，不得用于物料或信息实体',
      '物料状态（MaterialState）为过程，过程特性/缺陷为性质，二者不可混挂',
    ],
    // OWL 逻辑公理（IOF Core 制造层级 + 汽车领域扩展 + BFO 关系公理子集）
    axioms: [
      { type: 'DisjointClasses', subject: 'MaterialEntity', object: 'Process', desc: '物质实体与过程不相交（BFO 顶层二分）' },
      { type: 'DisjointClasses', subject: 'Process', object: 'InformationContentEntity', desc: '过程与信息内容实体不相交' },
      { type: 'DisjointClasses', subject: 'MaterialEntity', object: 'InformationContentEntity', desc: '物质实体与信息内容实体不相交' },
      { type: 'DisjointClasses', subject: 'Quality', object: 'Process', desc: '性质与过程不相交' },
      { type: 'DisjointClasses', subject: 'Assembly', object: 'MaterialComponent', desc: '装配体与物料组件不相交（整体 vs 零件）' },
      { type: 'SubClassOf', subject: 'Assembly', object: 'MaterialArtifact', desc: '装配体⊑物料制品（IOF:Assembly）' },
      { type: 'SubClassOf', subject: 'Vehicle', object: 'Assembly', desc: '整车⊑装配体（汽车领域扩展）' },
      { type: 'SubClassOf', subject: 'VehicleBody', object: 'Assembly', desc: '车身⊑装配体' },
      { type: 'SubClassOf', subject: 'Powertrain', object: 'Assembly', desc: '动力总成⊑装配体' },
      { type: 'SubClassOf', subject: 'Chassis', object: 'Assembly', desc: '底盘⊑装配体' },
      { type: 'SubClassOf', subject: 'Engine', object: 'MaterialArtifact', desc: '发动机⊑物料制品' },
      { type: 'SubClassOf', subject: 'TractionBattery', object: 'MaterialArtifact', desc: '动力电池⊑物料制品' },
      { type: 'SubClassOf', subject: 'AutomotivePart', object: 'MaterialComponent', desc: '汽车零部件⊑物料组件' },
      { type: 'SubClassOf', subject: 'ManufacturingProcess', object: 'PlannedProcess', desc: '制造过程⊑计划过程（IOF:ManufacturingProcess）' },
      { type: 'SubClassOf', subject: 'AssemblyProcess', object: 'ManufacturingProcess', desc: '装配过程⊑制造过程（IOF:AssemblyProcess）' },
      { type: 'SubClassOf', subject: 'StampingProcess', object: 'ManufacturingProcess', desc: '冲压过程⊑制造过程' },
      { type: 'SubClassOf', subject: 'WeldingProcess', object: 'ManufacturingProcess', desc: '焊装过程⊑制造过程' },
      { type: 'SubClassOf', subject: 'PaintingProcess', object: 'ManufacturingProcess', desc: '涂装过程⊑制造过程' },
      { type: 'SubClassOf', subject: 'QualityInspectionProcess', object: 'MeasurementProcess', desc: '质量检验过程⊑测量过程' },
      { type: 'SubClassOf', subject: 'MeasurementProcess', object: 'PlannedProcess', desc: '测量过程⊑计划过程（IOF:MeasurementProcess）' },
      { type: 'SubClassOf', subject: 'ProductProductionProcess', object: 'BusinessProcess', desc: '产品生产过程⊑业务过程' },
      { type: 'SubClassOf', subject: 'BusinessProcess', object: 'PlannedProcess', desc: '业务过程⊑计划过程' },
      { type: 'SubClassOf', subject: 'ProcessCharacteristic', object: 'Quality', desc: '过程特性⊑性质' },
      { type: 'SubClassOf', subject: 'Defect', object: 'Quality', desc: '缺陷⊑性质' },
      { type: 'SubClassOf', subject: 'MaterialState', object: 'Process', desc: '物料状态⊑过程（IOF 建模）' },
      { type: 'SubClassOf', subject: 'Capability', object: 'RealizableEntity', desc: '能力⊑可实现实体' },
      { type: 'SubClassOf', subject: 'MeasurementCapability', object: 'Capability', desc: '测量能力⊑能力' },
      { type: 'SubClassOf', subject: 'DesignedFunction', object: 'RealizableEntity', desc: '设计功能⊑可实现实体' },
      { type: 'SubClassOf', subject: 'Manufacturer', object: 'Agent', desc: '制造商⊑主体' },
      { type: 'SubClassOf', subject: 'Supplier', object: 'Agent', desc: '供应商⊑主体' },
      { type: 'SubClassOf', subject: 'Organization', object: 'Agent', desc: '组织⊑主体' },
      { type: 'SubClassOf', subject: 'PlanSpecification', object: 'InformationContentEntity', desc: '计划规范⊑信息内容实体' },
      { type: 'SubClassOf', subject: 'RequirementSpecification', object: 'InformationContentEntity', desc: '需求规范⊑信息内容实体' },
      { type: 'TransitiveProperty', subject: 'hasComponentPart', desc: '有零部件传递（装配体→子系统→零件）' },
      { type: 'TransitiveProperty', subject: 'componentPartOf', desc: '零部件属于传递' },
      { type: 'TransitiveProperty', subject: 'before', desc: '先于传递（工艺时序偏序）' },
      { type: 'TransitiveProperty', subject: 'after', desc: '后于传递' },
      { type: 'InverseProperties', subject: 'hasComponentPart', object: 'componentPartOf', desc: '有零部件⇄零部件属于 互逆' },
      { type: 'InverseProperties', subject: 'before', object: 'after', desc: '先于⇄后于 互逆' },
      { type: 'SymmetricProperty', subject: 'related_to', desc: '相关于对称（兜底关系）' },
      { type: 'PropertyDomain', subject: 'hasInput', object: 'Process', desc: 'hasInput 定义域=过程' },
      { type: 'PropertyRange', subject: 'hasInput', object: 'MaterialEntity', desc: 'hasInput 值域=物质实体' },
      { type: 'PropertyDomain', subject: 'hasOutput', object: 'Process', desc: 'hasOutput 定义域=过程' },
      { type: 'PropertyRange', subject: 'hasOutput', object: 'MaterialEntity', desc: 'hasOutput 值域=物质实体' },
      { type: 'PropertyDomain', subject: 'hasMaterialState', object: 'MaterialEntity', desc: 'hasMaterialState 定义域=物质实体' },
      { type: 'PropertyRange', subject: 'hasMaterialState', object: 'MaterialState', desc: 'hasMaterialState 值域=物料状态' },
      { type: 'PropertyDomain', subject: 'hasProcessCharacteristic', object: 'Process', desc: 'hasProcessCharacteristic 定义域=过程' },
      { type: 'PropertyRange', subject: 'hasProcessCharacteristic', object: 'ProcessCharacteristic', desc: 'hasProcessCharacteristic 值域=过程特性' },
      { type: 'PropertyDomain', subject: 'hasQuality', object: 'MaterialEntity', desc: 'hasQuality 定义域=物质实体' },
      { type: 'PropertyRange', subject: 'hasQuality', object: 'Quality', desc: 'hasQuality 值域=性质' },
      { type: 'PropertyDomain', subject: 'hasCapability', object: 'MaterialEntity', desc: 'hasCapability 定义域=物质实体' },
      { type: 'PropertyRange', subject: 'hasCapability', object: 'Capability', desc: 'hasCapability 值域=能力' },
      { type: 'PropertyDomain', subject: 'hasFunction', object: 'MaterialEntity', desc: 'hasFunction 定义域=物质实体' },
      { type: 'PropertyRange', subject: 'hasFunction', object: 'DesignedFunction', desc: 'hasFunction 值域=设计功能' },
      { type: 'PropertyDomain', subject: 'prescribes', object: 'InformationContentEntity', desc: 'prescribes 定义域=信息内容实体' },
      { type: 'PropertyRange', subject: 'prescribes', object: 'Process', desc: 'prescribes 值域=过程' },
      { type: 'PropertyDomain', subject: 'satisfiesRequirement', object: 'MaterialEntity', desc: 'satisfiesRequirement 定义域=物质实体' },
      { type: 'PropertyRange', subject: 'satisfiesRequirement', object: 'RequirementSpecification', desc: 'satisfiesRequirement 值域=需求规范' },
    ],
  },
};

// 常见英文谓词 → 中文别名。
// 键为 canonical key，值为别名数组；别名在体系内唯一映射到一个 canonical key，
// 同一别名在不同体系可指向不同谓词（体系级隔离）。
const RELATION_ALIASES = {
  // related_to / relatedTo：BFO 2020 与 ISO 15926 的兜底谓词拼写不同，
  // 但语义相同，互相视为别名，避免跨体系校验时把对方 canonical key 当未知谓词。
  related_to: ['相关', '相关于', 'relatedTo'],
  relatedTo: ['相关', '相关于', 'related_to'],
  // 跨体系语义等价（canonical key 不同，但概念一致），互相视为别名。
  // 注意：别名只影响「是否识别」，domain/range 仍按当前体系的 canonical key 校验。
  part_of: ['部分', '组成部分'],
  has_part: ['包含', '具有部分', '拥有部分', 'composedOf'],
  located_in: ['位于', '在...中', '坐落于', 'containedIn'],
  occurs_in: ['发生于', '出现在'],
  precedes: ['先于', '在...之前'],
  inheres_in: ['依附于', '依存于', '内在于'],
  bearer_of: ['承载', '具有', '带有'],
  participates_in: ['参与', '参加', 'involvedIn'],
  has_participant: ['有参与者', '参与者为'],
  realizes: ['实现', '履行'],
  has_role: ['有角色', '扮演'],
  derives_from: ['衍生自', '来源于', '源自'],
  has_disposition: ['有倾向', '具有倾向', '易患'],
  instance_of: ['实例', '是...的实例', 'classifiedBy'],
  is_a: ['是', '是一种', 'hasSuperclass'],
  connectedTo: ['连接', '相连', '连接到'],
  classifiedBy: ['分类为', '被分类为', '归类于', 'instance_of'],
  composedOf: ['由...组成', '组成', '由组成', 'has_part'],
  temporalPartOf: ['时间段属于', '时间部分于'],
  spatialPartOf: ['空间部分于', '空间组成部分'],
  containedIn: ['包含于', '被包含', 'located_in'],
  startsBefore: ['开始早于'],
  endsBefore: ['结束早于'],
  existsAt: ['存在于'],
  involvedIn: ['参与于', '参与', 'participates_in'],
  hasSuperclass: ['父类为', 'is_a'],
  hasClassMember: ['含成员', '有成员'],
  representsIn: ['表征于', '表征'],
};

// 把全局别名写入内置体系定义，OWL 导入路径会复用同一张表。
for (const pid of ['bfo', 'iso15926', 'ogms', 'legal', 'automotive']) {
  const prof = ONTOLOGY_PROFILES[pid];
  if (!prof || !Array.isArray(prof.predicates)) continue;
  for (const p of prof.predicates) {
    if (!p || !p.key) continue;
    const aliases = RELATION_ALIASES[p.key];
    if (aliases && aliases.length) {
      p.aliases = Array.isArray(p.aliases) ? [...new Set([...p.aliases, ...aliases])] : aliases.slice();
    }
  }
}

// 供提取弹窗/本体页切换器列出可选体系
const PROFILE_LIST = [
  { id: 'bfo-lite', name: 'BFO-Lite 轻量体系', desc: '默认，中文谓词，flat 提取' },
  { id: 'bfo', name: 'BFO 2020 标准体系', desc: '严谨推理，two-stage 提取' },
  { id: 'iso15926', name: 'ISO 15926 工业体系', desc: '4D 时空观，two-stage 提取' },
  { id: 'ogms', name: 'OGMS 医学体系', desc: '医疗/临床/病历，中英对照，two-stage 提取' },
  { id: 'legal', name: '法律体系（LKIF）', desc: '法律/规范/合同/判例，中英对照，two-stage 提取' },
  { id: 'automotive', name: '汽车制造体系（IOF）', desc: '整车/零部件/四大工艺/装备/物料/质量，中英对照，two-stage 提取' },
];
// 各体系的适用场景提示（供 suggestOntologyProfile 的 prompt 引导模型选择，避免无依据时一律回退 bfo-lite）
const PROFILE_SCENARIOS = {
  'bfo-lite': '适用：日常笔记、会议纪要、通用文档、产品说明、流程步骤、轻量知识组织。特点：分类扁平（物体/性质/过程/事件/信息体），中文谓词，理解门槛低。',
  bfo: '适用：科研文献、实验报告、学术论文、严谨推理场景。特点：区分持续体/发生体、物质/非物质实体、角色/功能/倾向，推理链完整。',
  iso15926: '适用：工业设备运维、工厂产线、质量检测流程、设备生命周期管理、工程数据集成。特点：4D 时空观，区分物理对象/活动/事件/时间段，支持设备部件组合关系。',
  ogms: '适用：医疗病历、临床指南、疾病/诊断/治疗文档、公共卫生、医学文献。特点：疾病/障碍/病程/诊断/体征症状/医疗过程完整类树（OGMS 编号），RO/BFO 医学关系子集，中英对照标签。',
  legal: '适用：法律法规、合同协议、判例裁定、合规审查、权利义务关系文档。特点：规范（许可/义务/禁止/权利/权力）、法律渊源（制定法/法规/合同/判例/条约）、表述、行为、主体、法律角色六大分支（源自 LKIF Core），定性/算作/允许/禁止/命令等法律关系谓词，中英对照标签。',
  automotive: '适用：汽车整车与零部件制造、四大工艺（冲压/焊装/涂装/总装）、产线装备、物料与供应链、质量检验、工艺文件。特点：产品/装配体/物料组件/原材料/装备/制造过程/测量过程/物料状态/规范/主体完整类树（源自 IOF Core 工业本体），整车/车身/动力总成/底盘/发动机/动力电池等汽车专属类，有输入/有输出/有零部件/由...制成/有过程特性/规定/满足需求等制造关系谓词，中英对照标签。',
};
// 默认本体：bfo-lite 的兼容投影（供未传 profileId 的旧调用路径回退）
const DEFAULT_ONTOLOGY = ONTOLOGY_PROFILES['bfo-lite'];
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
// 技能种子目录（示例技能植入来源）。
// 历史值是一个 macOS 绝对路径（/Users/qiang/...），在其它机器上永远不存在 ⇒ 种子技能从未被植入过。
// 改为「应用目录的上一级的 skills/」：src/main/common → 上溯 4 级（口径同 skills/runner.js 的 NODE_PATH）。
// （§10.3 实测：仓库根无 skills/，内置示例技能与用户技能集合同放在工作区级的 skills/。）
// 目录不存在时 seedSampleSkills 会静默跳过（打包后 asar 内没有该目录属正常情况）。
const DEFAULT_SKILLS_DIR = pathJoin(__dirname, '..', '..', '..', '..', 'skills');

// ---------- 技能解析预算（原散落在 skills/parse.js，语料流水线复用同一口径） ----------
// 图片直读上限：base64 会膨胀约 33%，过大的图多数视觉接口也拒收
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// 技能指令注入预算：单技能截断 + 总量上限，避免超长 SKILL.md 挤爆上下文
const PER_SKILL_CHARS = 6000;
const TOTAL_SKILL_CHARS = 16000;
// 抽取技能命中数：同一扩展名有多个 kind:extract 技能时，按 priority 取前 N 个。
// 默认 1——多个抽取技能的指令一起注入会互相干扰（与现状「全部技能拼一起」是同一个病）
const DEFAULT_EXTRACT_SKILL_TOPN = 1;

// ---------- 语料库（语料流水线设计 §6） ----------
// 语料库目录名：<数据根>/corpus/。机器产物、可重生成，故不进搜索、不入备份（§15 问题 6/7）
const CORPUS_DIR = 'corpus';

// ---------- 链接登录态 ----------
// 链接来源 Cookie 持久化 kv 键
const URL_COOKIES_KEY = 'url_cookies';

module.exports = {
  TRASH_DIR,
  TRASH_FOLDER_ID,
  MINERU_SUPPORTED_EXTS,
  MINERU_IMAGE_EXTS,
  CODE_TEXT_EXTS,
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
  ONTOLOGY_PROFILES,
  PROFILE_LIST,
  PROFILE_SCENARIOS,
  DOMAIN_TEMPLATES_KEY,
  GENERAL_TEMPLATE,
  MCP_PROTOCOL,
  MCP_CONNECT_MS,
  MCP_REQUEST_MS,
  HTTP_USER_AGENT,
  SKILL_DOWNLOAD_TIMEOUT_MS,
  SKILL_MAX_ZIP_BYTES,
  DEFAULT_SKILLS_DIR,
  MAX_IMAGE_BYTES,
  PER_SKILL_CHARS,
  TOTAL_SKILL_CHARS,
  DEFAULT_EXTRACT_SKILL_TOPN,
  CORPUS_DIR,
  URL_COOKIES_KEY,
  RELATION_ALIASES,
};
