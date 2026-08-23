// 知识图谱领域层：本体层定义、从 LLM Wiki / 笔记自动抽取、持久化与问答上下文注入
// 存储：整图 JSON 存于 SQLite kv 表（key='graph'），个人知识库图谱规模小，整体读写开销可忽略
const db = require('../common/db');
const notesStore = require('../notes/store');
const { chatOnce, extractJson, streamChat } = require('../ai/llm');
const { buildTasks } = require('../jobs/tasks');
const { getPrompt } = require('../ai/prompts');

// ---------- 本体层定义（抽取与展示共用的受控词表，可增删改查，持久化在 kv） ----------
const ONTO_KEY = 'ontology';
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

// 读取当前本体定义（未持久化时回退默认）
function getOntologyDef() {
  try {
    const o = JSON.parse(db.getKv(ONTO_KEY) || 'null');
    if (o && Array.isArray(o.classes) && o.classes.length && Array.isArray(o.predicates) && o.predicates.length) return o;
  } catch (_) {}
  return DEFAULT_ONTOLOGY;
}

function persistOntology(o) {
  db.setKv(ONTO_KEY, JSON.stringify(o));
  db.flush();
}

// 实体类 key → 展示名（抽取提示与上下文注入共用）
function nodeTypesMap() {
  const m = {};
  for (const c of getOntologyDef().classes) m[c.key] = `${c.label}（${c.desc || ''}）`;
  return m;
}

function relationsList() {
  return getOntologyDef().predicates.map((p) => p.key);
}

// 类型/谓词被删后的回退值
function fallbackType() {
  const keys = Object.keys(nodeTypesMap());
  return keys.includes('concept') ? 'concept' : keys[0] || 'concept';
}
function fallbackRel() {
  const rels = relationsList();
  return rels.includes('相关') ? '相关' : rels[0] || '相关';
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
// scope: 'wiki' | 'notes' | 'all'；wiki 复用 wiki.js 的页面遍历，notes 读全量 store
// domain: 可选，指定领域时仅收集该领域的 Wiki 页面（用于模版卡片「生成图谱」）
function collectSources(scope, wikiBundle, domain) {
  const sources = [];
  if (domain) {
    if (wikiBundle) {
      const { listPages, readPageContent } = wikiBundle;
      for (const p of listPages()) {
        if (p.rel.endsWith('index.md') || p.rel.endsWith('log.md')) continue;
        if ((p.domain || 'general') !== domain) continue;
        const text = String(readPageContent(p.rel) || '').slice(0, SOURCE_CHARS);
        if (text.trim()) sources.push({ label: 'Wiki·' + (p.title || p.rel), text, domain });
      }
    }
    return sources;
  }
  if (scope !== 'notes' && wikiBundle) {
    const { listPages, readPageContent } = wikiBundle;
    for (const p of listPages()) {
      if (p.rel.endsWith('index.md') || p.rel.endsWith('log.md')) continue;
      const text = String(readPageContent(p.rel) || '').slice(0, SOURCE_CHARS);
      if (text.trim()) sources.push({ label: 'Wiki·' + (p.title || p.rel), text, domain: p.domain || '' });
    }
  }
  if (scope !== 'wiki') {
    for (const n of notesStore.getNotes()) {
      const text = `# ${n.title}\n${n.content || ''}`.slice(0, SOURCE_CHARS);
      if (text.trim()) sources.push({ label: '笔记·' + (n.title || n.id), text });
    }
  }
  return sources;
}

// ---------- 本体抽取 ----------
// 逐批调用模型抽取节点/边，合并去重后持久化；onStage 回调用于作业阶段进度展示
async function extractGraph(settings, { scope, wikiBundle, rawPaths, readRaw, domain, inlineSources, typeHints, domainLabel }, onStage, onProgress, onTasks) {
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
    sources = collectSources(scope, wikiBundle, domain);
  }
  if (!sources.length) throw new Error(domain ? `领域「${domain}」下没有可抽取的 Wiki 页面` : '选定范围内没有可抽取的内容（Wiki 与笔记均为空）');
  if (onStage) onStage('collect', `共 ${sources.length} 个来源，开始分批抽取…`);

  // 分批：每个来源独立一批（一个任务），便于逐任务展示当前进度与独立输出
  const batches = sources.map((s) => [s]);

  // 任务列表：每个来源一个独立 task，随批次推进更新状态（供作业内展示）
  sources.forEach((s, i) => { s._i = i; });
  const tasks = buildTasks(sources.map((s) => s.label));
  if (onTasks) onTasks(tasks);

  const nodes = new Map(); // key -> {id,name,type,desc,sources[],domain}
  const edges = new Map(); // key -> {from,to,rel,sources[]}
  const ensureNode = (name, type, desc, srcLabel, srcDomain) => {
    const key = nodeKey(name);
    if (!key) return null;
    let node = nodes.get(key);
    if (!node) {
      node = { id: key, name: String(name).trim().slice(0, 40), type: nodeTypesMap()[type] ? type : fallbackType(), desc: '', sources: [], domain: srcDomain || '' };
      nodes.set(key, node);
    }
    if (!node.desc && desc) node.desc = String(desc).slice(0, 120);
    if (srcLabel && !node.sources.includes(srcLabel) && node.sources.length < 5) node.sources.push(srcLabel);
    if (srcDomain && !node.domain) node.domain = srcDomain;
    return node;
  };

  for (let i = 0; i < batches.length; i++) {
    const curTask = tasks[batches[i][0]._i];
    const taskHead = curTask ? `任务 ${curTask.no}/${tasks.length}「${curTask.label}」` : `批次 ${i + 1}/${batches.length}`;
    if (onStage) onStage('extract', `AI 本体抽取（${taskHead}）…`);
    // 本批来源标记为处理中，实时上报任务状态
    for (const s of batches[i]) if (tasks[s._i]) tasks[s._i].status = 'running';
    if (onTasks) onTasks(tasks);
    const batchText = batches[i].map((s) => `=== 来源: ${s.label} ===\n${s.text}`).join('\n\n');
    const typesMap = nodeTypesMap();
    const rels = relationsList();
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
    const answer = await chatOnce(settings, [
      { role: 'system', content: getPrompt(settings, 'graphExtractPrompt') },
      {
        role: 'user',
        content:
          `以下是知识库中的一个来源内容。请抽取本体层：节点与关系。\n` +
          `节点类型只能从：${Object.entries(typesMap).map(([k, v]) => `${k}(${v})`).join('、')} 中选择。\n` +
          `关系只能从：${rels.join('、')} 中选择。\n` +
          (existing ? `已有节点（可为其建立关系，避免重复创建）：${existing}。\n` : '') +
          (typeHints && ((typeHints.entity || []).length || (typeHints.concept || []).length)
            ? `本次为领域「${domainLabel || domain || ''}」抽取，请围绕该领域模版的类别组织节点：entity 节点对应实体类型〔${(typeHints.entity || []).join('、')}〕；concept 节点对应概念类型〔${(typeHints.concept || []).join('、')}〕。\n`
            : '') +
          `节点名使用规范简短名词；同一事物只输出一个节点；关系须有明确依据，最多 30 个节点、50 条边。\n` +
          `输出 JSON：{"nodes":[{"name":"","type":"","desc":""}],"edges":[{"from":"","to":"","rel":""}]}\n\n` +
          batchText,
      },
    ], undefined, report);
    // 本批来源已处理，更新任务状态（解析失败也视为已处理）
    for (const s of batches[i]) if (tasks[s._i]) tasks[s._i].status = 'done';
    if (onTasks) onTasks(tasks);
    let parsed;
    try {
      parsed = extractJson(answer);
    } catch (_) {
      continue; // 单批解析失败跳过，不中断整体抽取
    }
    for (const n of parsed.nodes || []) ensureNode(n.name, n.type, n.desc, null);
    for (const e of parsed.edges || []) {
      const from = ensureNode(e.from, null, null, null);
      const to = ensureNode(e.to, null, null, null);
      const rel = rels.includes(e.rel) ? e.rel : fallbackRel();
      if (!from || !to || from.id === to.id) continue;
      const key = `${from.id}|${to.id}|${rel}`;
      if (!edges.has(key)) edges.set(key, { from: from.id, to: to.id, rel });
    }
    // 来源标签挂到批次内被提及的节点（按名称包含粗匹配），同时继承来源的领域归属
    for (const s of batches[i]) {
      const label = s.label;
      for (const node of nodes.values()) {
        if (s.text.includes(node.name)) {
          if (!node.sources.includes(label) && node.sources.length < 5) node.sources.push(label);
          if (s.domain && !node.domain) node.domain = s.domain;
        }
      }
    }
  }

  if (!nodes.size) throw new Error('模型未抽取到任何节点，请检查 API 配置或缩小范围重试');
  saveGraph([...nodes.values()], [...edges.values()]);
  return { nodeCount: nodes.size, edgeCount: edges.size, sourceCount: sources.length, sourceLabels: sources.map((s) => s.label) };
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

// 依据问题关键词召回相关节点及其关系边，返回上下文文本与命中实体名单
function recallFor(question, maxNodes = 8) {
  const g = getGraph();
  if (!g.nodes.length) return { context: '', hits: [] };
  const q = String(question || '').toLowerCase();
  if (!q.trim()) return { context: '', hits: [] };
  const tokens = questionTokens(q);
  const scored = g.nodes
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
    return `- [${nodeTypesMap()[n.type] ? n.type : fallbackType()}] ${n.name}${n.desc ? `：${n.desc}` : ''}${rels ? `（关系：${rels}）` : ''}`;
  });
  return {
    context: `【知识图谱·本体层】\n${lines.join('\n')}\n回答时可结合上述实体与关系。`,
    hits: scored.map(({ n }) => n.name),
  };
}

// 兼容旧调用：只要上下文文本
function contextFor(question, maxNodes = 8) {
  return recallFor(question, maxNodes).context;
}

// ---------- 本体定义（Ontology）查询与增删改查 ----------
// 本体视图数据：类/谓词/约束 + 实例统计
function getOntology() {
  const o = getOntologyDef();
  const g = getGraph();
  const countBy = {};
  for (const n of g.nodes) countBy[n.type] = (countBy[n.type] || 0) + 1;
  const classes = o.classes.map((c) => ({ ...c, instances: countBy[c.key] || 0 }));
  return {
    classes,
    predicates: o.predicates,
    constraints: o.constraints || [],
    stats: {
      classCount: o.classes.length,
      predicateCount: o.predicates.length,
      constraintCount: (o.constraints || []).length,
      instanceCount: g.nodes.length,
      edgeCount: g.edges.length,
    },
  };
}

// 增/改：kind = classes | predicates | constraints；constraints 用 item.index 定位编辑
function saveOntologyItem(kind, item) {
  const o = getOntologyDef();
  const it = item || {};
  if (kind === 'classes') {
    const key = String(it.key || '').trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) throw new Error('标识键须为英文标识符（字母开头，仅字母/数字/下划线）');
    const label = String(it.label || '').trim();
    if (!label) throw new Error('名称不能为空');
    const rec = {
      key,
      label,
      desc: String(it.desc || '').trim(),
      examples: Array.isArray(it.examples) ? it.examples.map((s) => String(s).trim()).filter(Boolean).slice(0, 8) : [],
    };
    const i = o.classes.findIndex((c) => c.key === key);
    if (i >= 0) o.classes[i] = rec; else o.classes.push(rec);
  } else if (kind === 'predicates') {
    const key = String(it.key || '').trim();
    if (!key) throw new Error('谓词名称不能为空');
    const rec = { key, desc: String(it.desc || '').trim() };
    const i = o.predicates.findIndex((p) => p.key === key);
    if (i >= 0) o.predicates[i] = rec; else o.predicates.push(rec);
  } else {
    const text = String(it.desc || '').trim();
    if (!text) throw new Error('约束内容不能为空');
    const idx = Number(it.index);
    if (Number.isInteger(idx) && o.constraints[idx] !== undefined) o.constraints[idx] = text;
    else (o.constraints = o.constraints || []).push(text);
  }
  persistOntology(o);
  return getOntology();
}

// 删：classes/predicates 按 key，constraints 按下标
function removeOntologyItem(kind, keyOrIndex) {
  const o = getOntologyDef();
  if (kind === 'classes') {
    if (keyOrIndex === fallbackType()) throw new Error(`「${keyOrIndex}」是回退实体类，不可删除`);
    o.classes = o.classes.filter((c) => c.key !== keyOrIndex);
  } else if (kind === 'predicates') {
    if (o.predicates.length <= 1) throw new Error('至少保留一个谓词');
    o.predicates = o.predicates.filter((p) => p.key !== keyOrIndex);
  } else {
    o.constraints.splice(Number(keyOrIndex), 1);
  }
  persistOntology(o);
  return getOntology();
}

// ---------- KG 自然语言问答 ----------
// 管线：LLM 抽取实体 → 匹配本体节点（多层兜底）→ BFS 邻居事实 → 沿节点 sources 回溯 Wiki/笔记原文 → 事实+材料约束流式回答，并下发引用清单
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
        if (a && b) facts.push(`${a.name} —${e.rel}→ ${b.name}`);
        if (!seen.has(other)) { seen.add(other); next.push(other); }
      }
      frontier = next;
    }
    const uniqFacts = [...new Set(facts)].slice(0, 80);

    // 沿本体节点的 sources 回溯 Wiki 页面 / 笔记原文，作为回答材料与引用明细
    event.sender.send('kg:stage', '沿本体层回溯 Wiki/笔记原文…');
    const visited = [...seen].map((id) => byId.get(id)).filter(Boolean);
    const refs = collectRefs(settings, visited);

    event.sender.send('kg:facts', {
      matched: seeds.map((n) => n.name),
      facts: withFacts ? uniqFacts : [],
      refs: refs.map((r) => ({ kind: r.kind, label: r.label, path: r.path })),
    });
    event.sender.send('kg:stage', '基于事实与原文生成回答…');
    const factBlock = withFacts && uniqFacts.length ? `【知识图谱事实】\n${uniqFacts.join('\n')}` : '';
    const matBlock = refs.length
      ? `【原文材料】\n${refs.map((r, i) => `材料${i + 1}（${r.kind === 'wiki' ? 'Wiki' : '笔记'}·${r.label}，路径 ${r.path}）：\n${r.content}`).join('\n\n')}`
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

// 节点 sources（'Wiki·标题/路径'、'笔记·标题'）→ 原文内容；延迟 require wiki 避免与 wiki.js 的加载期循环依赖
function collectRefs(settings, nodes, maxRefs = 4) {
  const wiki = require('../wiki/wiki');
  const refs = [];
  const seen = new Set();
  let desc = null;
  let notes = null;
  for (const n of nodes) {
    for (const label of n.sources || []) {
      if (refs.length >= maxRefs) break;
      try {
        if (label.startsWith('Wiki·')) {
          if (!desc) {
            desc = wiki.describeWiki(settings);
            desc.byTitle = new Map((desc.pages || []).map((p) => [(p.title || '').toLowerCase(), p.path]));
            desc.byRel = new Map((desc.pages || []).map((p) => [p.path.toLowerCase(), p.path]));
          }
          if (!desc.exists) continue;
          const key = label.slice(5).trim().toLowerCase();
          const rel = desc.byTitle.get(key) || desc.byRel.get(key);
          if (!rel || seen.has('w:' + rel)) continue;
          seen.add('w:' + rel);
          refs.push({ kind: 'wiki', label: label.slice(5), path: rel, content: String(wiki.readPage(settings, rel) || '').slice(0, 3000) });
        } else if (label.startsWith('笔记·')) {
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

module.exports = { getGraph, saveGraph, clearGraph, extractGraph, contextFor, recallFor, getOntology, saveOntologyItem, removeOntologyItem, kgAsk };
