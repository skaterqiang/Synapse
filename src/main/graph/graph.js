// 知识图谱领域层：本体层定义、从笔记/原始文件自动抽取、持久化与问答上下文注入
// 存储：整图 JSON 存于 SQLite kv 表（key='graph'），个人知识库图谱规模小，整体读写开销可忽略
const db = require('../common/db');
const notesStore = require('../notes/store');
const { chatOnce, extractJson, streamChat } = require('../ai/llm');
const { num } = require('../common/config');
const { buildTasks } = require('../jobs/tasks');
const { getPrompt } = require('../ai/prompts');

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
// 单批送入模型的语料上限（字符），控制 token 与抽取质量
const BATCH_CHARS = 6000;
// 单个来源截断长度，避免超长页面挤占批次
const SOURCE_CHARS = 1500;

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

// ---------- 本体抽取 ----------
// 逐批调用模型抽取节点/边，合并去重后持久化；onStage 回调用于作业阶段进度展示
// resolveDomain(raws)：未命中特定领域时由作业层决定最终领域（可新建/复用领域模版），
// 返回 { domainId, domainLabel, typeHints }；graph 层不直接依赖 templates
async function extractGraph(settings, { rawPaths, readRaw, inlineSources, typeHints, domainLabel, domainId, resolveDomain, ontologyProfile, signal }, onStage, onProgress, onTasks) {
  // 作业停止信号：批次开始前检查 + 透传给 chatOnce 中断在途模型请求
  const mkAbort = () => Object.assign(new Error('用户手动停止作业'), { name: 'AbortError' });
  // 生效体系优先级：弹窗显式指定 > 命中模板的体系绑定（resolveDomain 回填）> settings 全局默认 > bfo-lite
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
  // 体系解析放在领域判定之后：弹窗显式指定优先，其次命中模板的体系绑定，最后全局默认
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

  const nodes = new Map(); // key -> {id,name,type,desc,sources[],domain,profile}
  const edges = new Map(); // key -> {from,to,rel,sources[]}
  const typeMap = nodeTypesMap(profileId);
  const rels = relationsList(profileId);
  const fbType = fallbackType(profileId);
  const fbRel = fallbackRel(profileId);
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
    const sysPrompt = getPrompt(settings, 'graphExtractPrompt') + (twoStage
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
      const rel = rels.includes(e.rel) ? e.rel : fbRel;
      if (!from || !to || from.id === to.id) continue;
      const key = `${from.id}|${to.id}|${rel}`;
      if (!edges.has(key)) edges.set(key, { from: from.id, to: to.id, rel });
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
    } catch (err) {
      // 单任务失败（网络中断/连接被关闭/超时等）：标记该任务失败并把错误抛给 worker，
      // 让作业整体失败而不是永远停在「进行中」（此前连接被静默关闭时任务停在 running 拖死作业）
      for (const s of batches[i]) if (tasks[s._i]) { tasks[s._i].status = 'failed'; tasks[s._i].output = (tasks[s._i].output || '') + `\n[失败] ${err.message || err}`; }
      if (onTasks) onTasks(tasks);
      throw err;
    }
  };

  // 启动 N 个 worker 并发消费批次（单线程内 await 切换，Map 变更同步无竞态）
  let nextIdx = 0;
  const workers = Array.from({ length: Math.min(CONC, batches.length) }, async () => {
    for (;;) {
      const i = nextIdx++;
      if (i >= batches.length) break;
      await runBatch(i);
    }
  });
  await Promise.all(workers);

  if (!nodes.size) throw new Error('模型未抽取到任何节点，请检查 API 配置或缩小范围重试');

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
  for (const e of existing.edges || []) if (e && e.from && e.to) putEdge(e);
  for (const n of nodes.values()) putNode(n);
  for (const e of edges.values()) putEdge(e);
  saveGraph([...mergedNodes.values()], [...mergedEdges.values()]);
  return { nodeCount: mergedNodes.size, edgeCount: mergedEdges.size, sourceCount: sources.length, sourceLabels: sources.map((s) => s.label), profileId, profileName: onto.name };
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
  const countBy = {};
  for (const n of g.nodes) countBy[n.type] = (countBy[n.type] || 0) + 1;
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
      instanceCount: g.nodes.length,
      edgeCount: g.edges.length,
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
    const g = getGraph();
    if (!g.nodes.length) {
      event.sender.send('ai:error', '知识图谱为空，请先在「整体图谱」页运行「抽取本体层」。');
      return;
    }
    const maxHops = Math.max(1, Math.min(5, Number(hops) || 3));
    event.sender.send('kg:stage', '解析问题并抽取实体…');
    let names = [];
    try {
      const ans = await chatOnce(settings, [
        { role: 'system', content: getPrompt(settings, 'graphEntityPrompt') },
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

    // 沿本体节点的 sources 回溯笔记原文，作为回答材料与引用明细
    event.sender.send('kg:stage', '沿本体层回溯笔记原文…');
    const visited = [...seen].map((id) => byId.get(id)).filter(Boolean);
    const refs = collectRefs(settings, visited);
    event.sender.send('kg:stage', refs.length
      ? `原文回溯完成：命中 ${refs.length} 份材料（${refs.map((r) => r.label).slice(0, 3).join('、')}${refs.length > 3 ? '…' : ''}）`
      : '原文回溯完成：无可回溯材料');

    event.sender.send('kg:facts', {
      matched: seeds.map((n) => n.name),
      facts: withFacts ? uniqFacts : [],
      refs: refs.map((r) => ({ kind: r.kind, label: r.label, path: r.path })),
    });
    event.sender.send('kg:stage', '基于事实与原文生成回答…');
    const factBlock = withFacts && uniqFacts.length ? `【知识图谱事实】\n${uniqFacts.join('\n')}` : '';
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
function importOwl(filePath, opts) {
  const { parseOwlFile } = require('./owl');
  const path = require('path');
  const fs = require('fs');
  const { profile, report } = parseOwlFile(filePath, opts);
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
  return { profile, report };
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

// ---------- 两级范围：体系 → 具体知识图谱 ----------
// 列出「有抽取节点」的具体知识图谱分组，供问答范围二级选择。
// 维度：profile（体系）→ 其下按 domain（领域/图谱）分组；domain 为空归入 (general)。
// 返回 [{ id: `${profile}|${domain}`, profile, profileName, domain, label, nodeCount, edgeCount }]
function listGraphScopes() {
  const g = getGraph();
  const profiles = listProfiles();
  const nameOf = (pid) => { const p = profiles.find((x) => x.id === pid); return p ? (p.name || pid) : pid; };
  // 领域中文名映射：domain 存的是模版 id（如 ev_charger_application），需要查模版的 name（如「充电桩报装」）
  // 惰性 require 避免循环依赖（templates 依赖本模块的 resolveOntology）
  let tplNameOf = (id) => id;
  try {
    const templates = require('./templates');
    const tpls = templates.listTemplates();
    const byId = new Map(tpls.map((t) => [t.id, t.name || t.id]));
    tplNameOf = (id) => byId.get(id) || id;
  } catch (_) { /* 模版模块不可用时回退到 id */ }
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
        label: domain === 'general' ? '未分类' : tplNameOf(domain),
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
// 返回 { profiles:Set|null, pred(node)=>bool }；all/空 = 不过滤
function scopeFilter(scope) {
  if (!scope || scope === 'all') return null;
  const s = String(scope);
  // 多选：逗号分隔若干 scope id
  const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
  if (!parts.length || parts.includes('all')) return null;
  const conds = parts.map((p) => {
    const [profile, domain] = p.split('|');
    if (!domain || domain === '*') return (n) => (n.profile || 'bfo-lite') === profile;
    if (domain === 'general') return (n) => (n.profile || 'bfo-lite') === profile && !(n.domain && String(n.domain).trim());
    return (n) => (n.profile || 'bfo-lite') === profile && String(n.domain || '') === domain;
  });
  return (n) => conds.some((c) => c(n));
}

module.exports = { getGraph, saveGraph, clearGraph, extractGraph, contextFor, recallFor, getOntology, setOntologyProfile, saveOntologyItem, removeOntologyItem, listProfiles, resolveOntology, kgAsk, resolveSources, importOwl, removeOwlProfile, listGraphScopes, scopeFilter };
