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
};
// 供提取弹窗/本体页切换器列出可选体系
const PROFILE_LIST = [
  { id: 'bfo-lite', name: 'BFO-Lite 轻量体系', desc: '默认，中文谓词，flat 提取' },
  { id: 'bfo', name: 'BFO 2020 标准体系', desc: '严谨推理，two-stage 提取' },
  { id: 'iso15926', name: 'ISO 15926 工业体系', desc: '4D 时空观，two-stage 提取' },
];
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
// 技能种子目录（示例技能植入来源，历史路径）
const DEFAULT_SKILLS_DIR = '/Users/qiang/sample_center-release/backend/resource/skills';

// ---------- 链接登录态 ----------
// 链接来源 Cookie 持久化 kv 键
const URL_COOKIES_KEY = 'url_cookies';

module.exports = {
  TRASH_DIR,
  TRASH_FOLDER_ID,
  MINERU_SUPPORTED_EXTS,
  MINERU_IMAGE_EXTS,
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
