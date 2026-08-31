// 知识访问统一层：把「有哪些知识源」「怎么检索一个源」「结果怎么进提示词/怎么展示引用」收敛到一处。
//
// ── 知识源接入接口（新增一个知识源只需 register 一个对象，无需改问答链路）──
//   {
//     key,                  // 唯一标识，同时是前端知识源开关的键（state.aiSources[key]）
//     label, icon,          // 前端知识源选择条的展示名与图标
//     order,                // 上下文拼装顺序（小的在前）：影响提示词里各知识块的前后
//     uiOrder,              // 选择条展示顺序（缺省跟随 order）：与提示词顺序解耦，
//                           // 因为“用户先看到哪个源”和“模型先读到哪个源”是两个不同的诉求
//     async retrieve(ctx),  // ctx = { settings, question, signal }
//   }
//   retrieve 返回（各字段均可缺省）：
//   {
//     block: { title, body, caveat },   // title 为空表示整块直出；caveat 是给模型的取舍说明
//     cites: { notes?, raws?, graph? },          // 供渲染层统一展示引用
//     steps: [{ kind: 'thought', text }],        // 执行过程，逐条下发到 UI
//   }
//
// ── 知识访问接口（问答链路只依赖这两个函数）──
//   listSources()                       → 知识源清单（供前端渲染开关）
//   retrieve({ settings, question, enabled, onStep, signal }) → { text, cites, blocks }
//
// 说明：各源用延迟 require 拿领域模块，避免与 raws/graph/notes 形成加载期循环依赖。
const { num } = require('../common/config');

const sources = new Map();

function register(def) {
  if (!def || !def.key || typeof def.retrieve !== 'function') {
    throw new Error('知识源接入失败：需要 { key, retrieve }');
  }
  sources.set(def.key, { order: 100, label: def.key, icon: '📚', ...def });
  return def.key;
}

// 知识源清单（按 uiOrder 排序，缺省跟随 order）：前端据此渲染知识源开关，新增源自动出现
function listSources() {
  const ord = (s) => (s.uiOrder === undefined ? s.order : s.uiOrder);
  return [...sources.values()]
    .sort((a, b) => ord(a) - ord(b))
    .map((s) => ({ key: s.key, label: s.label, icon: s.icon, desc: s.desc || '' }));
}

// 统一检索：并行跑所有勾选的源，单源失败/超时只丢该源，绝不拖垮整次问答
// enabled 缺省视为「全开」；onStep 用于把各源的执行过程实时下发给 UI
async function retrieve({ settings, question, enabled, onStep, signal, graphProfile, graphScope } = {}) {
  const on = (key) => !enabled || enabled[key] !== false;
  const picked = [...sources.values()].filter((s) => on(s.key)).sort((a, b) => a.order - b.order);
  const emit = (st) => { try { if (onStep) onStep(st); } catch (_) { /* 忽略 */ } };
  const results = await Promise.all(picked.map(async (s) => {
    // 立即下发「已开始」步骤：用户实时看到哪些源在跑，不必等检索结束（原始文件扫描/链接读取可能耗时数十秒）
    emit({ kind: 'thought', text: `检索${s.label}…` });
    try {
      // 步骤由各源在执行过程中实时自报（结果里仍带回 steps，供未传 onStep 的调用方）；此处不再重复下发
      return { key: s.key, order: s.order, ...(await s.retrieve({ settings, question, signal, onStep: emit, graphProfile, graphScope }) || {}) };
    } catch (err) {
      const st = { kind: 'thought', text: `知识源「${s.label}」检索失败：${err.message}，本轮跳过` };
      emit(st);
      return { key: s.key, order: s.order, steps: [st] };
    }
  }));
  const cites = {};
  const blocks = [];
  for (const r of results.sort((a, b) => a.order - b.order)) {
    if (r.block && String(r.block.body || '').trim()) blocks.push({ key: r.key, ...r.block });
    for (const [k, v] of Object.entries(r.cites || {})) {
      if (Array.isArray(v) && v.length) cites[k] = (cites[k] || []).concat(v);
    }
  }
  return { text: buildContextText(blocks), cites, blocks };
}

// 拼装成提示词里的知识上下文：每块「标题 + 正文 + 取舍说明」
function buildContextText(blocks) {
  return (blocks || [])
    .map((b) => [b.title ? `【${b.title}】` : '', b.body, b.caveat || ''].filter(Boolean).join('\n'))
    .join('\n\n');
}

// ---------- 检索打分工具（笔记源与图谱召回共用的中英文分词） ----------
function tokenize(text) {
  const tokens = new Set();
  (String(text).toLowerCase().match(/[a-z0-9_]{2,}/g) || []).forEach((w) => tokens.add(w));
  (String(text).match(/[\u4e00-\u9fa5]+/g) || []).forEach((seg) => {
    if (seg.length === 1) tokens.add(seg);
    for (let i = 0; i < seg.length - 1; i++) tokens.add(seg.slice(i, i + 2));
  });
  return [...tokens];
}

// ---------- 内置知识源 ----------
// 笔记：标题/标签/正文关键词打分取 Top N
register({
  key: 'notes',
  label: '笔记',
  icon: '📝',
  order: 20,
  desc: '本地 Markdown 笔记，关键词打分检索',
  async retrieve({ settings, question, onStep }) {
    const emit = (st) => { if (onStep) onStep(st); };
    const store = require('../notes/store');
    const topN = num(settings, 'askNotes', 4, 1, 20);
    const tokens = tokenize(question).filter((t) => t.length >= 2);
    if (!tokens.length) { const steps = [{ kind: 'thought', text: '问题无有效关键词，跳过笔记检索' }]; steps.forEach(emit); return { steps }; }
    const scored = store.getNotes().map((note) => {
      const title = (note.title || '').toLowerCase();
      const tags = (note.tags || []).join(' ').toLowerCase();
      const content = (note.content || '').toLowerCase();
      let score = 0;
      const matched = new Set();
      tokens.forEach((t) => {
        let hit = false;
        if (title.includes(t)) { score += 5; hit = true; }
        if (tags.includes(t)) { score += 3; hit = true; }
        let idx = 0;
        let count = 0;
        while ((idx = content.indexOf(t, idx)) !== -1 && count < 10) { count++; idx += t.length; }
        if (count) { score += count; hit = true; }
        if (hit) matched.add(t);
      });
      const longest = [...matched].reduce((a, t) => Math.max(a, t.length), 0);
      return { note, score, matched: matched.size, longest };
    }).filter((x) => x.matched >= 2 || x.longest >= 4)
      .sort((a, b) => b.score - a.score).slice(0, topN);
    if (!scored.length) { const steps = [{ kind: 'thought', text: '笔记无关键词命中' }]; steps.forEach(emit); return { steps }; }
    const steps = [{ kind: 'thought', text: `笔记命中 ${scored.length} 篇：${scored.map((x) => x.note.title || '无标题').join('、')}` }];
    steps.forEach(emit);
    return {
      block: { title: '笔记检索结果', body: scored.map((x, i) => `【笔记${i + 1}】标题：${x.note.title || '无标题'}\n${(x.note.content || '').slice(0, 1500)}`).join('\n\n') },
      cites: { notes: scored.map((x) => ({ id: x.note.id, title: x.note.title || '无标题笔记' })) },
      steps,
    };
  },
});

// 知识图谱：按问题关键词召回本体层节点与关系
register({
  key: 'graph',
  label: '知识图谱',
  icon: '🕸',
  order: 30,
  desc: '本体层实体与关系，按问题关键词召回',
  async retrieve({ question, onStep, graphProfile, graphScope }) {
    const emit = (st) => { if (onStep) onStep(st); };
    const graph = require('../graph/graph');
    // graphScope 优先（二级具体图谱）；否则 graphProfile（'all' 或体系 id）
    const scope = graphScope && graphScope !== 'all' ? graphScope : '';
    const pid = !scope && graphProfile && graphProfile !== 'all' ? graphProfile : '';
    const recall = graph.recallFor(question, 8, pid, scope);
    if (!String(recall.context || '').trim()) {
      const steps = [{ kind: 'thought', text: (scope || pid) ? `知识图谱在选定范围下无相关实体命中` : '知识图谱无相关实体命中' }];
      steps.forEach(emit); return { steps };
    }
    const steps = [{ kind: 'thought', text: `知识图谱召回 ${(recall.hits || []).length} 个实体${scope ? '（指定图谱）' : pid ? `（体系：${pid}）` : ''}` }];
    steps.forEach(emit);
    return {
      block: { body: recall.context },
      cites: { graph: recall.hits || [] },
      steps,
    };
  },
});

// 原始文件：grep 式关键字检索（纯 Node 实现，跨平台一致）
register({
  key: 'raws',
  label: '原始文件',
  icon: '🗄',
  order: 40,     // 提示词里排最后：关键字命中未经语义校对，置顶会抬高它在模型眼里的权重
  uiOrder: 5,    // 选择条里排第一：原始文件是知识入口，用户最常勾选它
  desc: '已引入的原始文件，关键字（grep 式）检索',
  async retrieve({ settings, question, onStep }) {
    const raws = require('../raws/raws');
    let lastProg = 0;
    const res = await raws.searchRaws(settings, question, {
      topN: num(settings, 'askRaws', 5, 1, 20),
      // 扫描/读取进度实时上报：链接类原始文件要在桌面端隐藏窗重抓正文，单次可达数十秒，无进度则 UI 像卡死
      onScan: (info) => {
        if (!onStep) return;
        const now = Date.now();
        if (info.kind !== 'url' && now - lastProg < 500) return; // 本地文件按 500ms 节流；链接逐条报
        lastProg = now;
        onStep(info.kind === 'url'
          ? { kind: 'progress', text: `🔗 读取链接正文：${info.name}（${info.idx + 1}/${info.total}）` }
          : { kind: 'progress', text: `🗄 扫描原始文件 ${info.idx + 1}/${info.total}…` });
      },
    });
    const hits = (res && res.hits) || [];
    // 链接类来源读取失败（登录态缺失/超时等）逐条可见，避免「有链接却没用上」无从解释
    const failSteps = ((res && res.urlFails) || []).map((f) => ({ kind: 'thought', text: `⚠️ 链接「${f.name}」正文读取失败：${f.error}` }));
    if (!hits.length) {
      const steps = [...failSteps, { kind: 'thought', text: `原始文件无关键字命中（已扫 ${(res && res.scanned) || 0}/${(res && res.candidates) || 0}）` }];
      steps.forEach((st) => { if (onStep) onStep(st); });
      return { steps };
    }
    const steps = [...failSteps, { kind: 'thought', text: `原始文件命中 ${hits.length} 个（已扫 ${res.scanned || 0}/${res.candidates || 0}）：${hits.map((h) => h.name).join('、')}` }];
    steps.forEach((st) => { if (onStep) onStep(st); });
    return {
      block: {
        title: '原始文件关键字命中',
        body: hits.map((h, i) => `【文件${i + 1}】${h.name}（命中：${(h.matched || []).slice(0, 6).join('、')}）\n${(h.snippets || []).join('\n…\n')}`).join('\n\n'),
        // 关键字命中未经语义校对，必须如实告知模型自行取舍，否则容易把碰巧命中的片段当依据
        caveat: '以上片段由关键字检索得到，未经语义校对，可能含不相关内容。请只采用与问题真正相关的片段，引用时注明文件名；若均不相关，就当作没有相关资料，不得强行引用。',
      },
      cites: { raws: hits.map((h) => ({ path: h.path, name: h.name, strong: !!h.strong, matched: h.matched || [] })) },
      steps,
    };
  },

});

module.exports = { register, listSources, retrieve, buildContextText, tokenize };
