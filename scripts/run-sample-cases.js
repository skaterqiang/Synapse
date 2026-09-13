'use strict';
// ============================================================================
// 样例案例三步实操 runner（headless）
//
// 严格按用户约定的三步跑通 data/note/sample/ 下每个案例：
//   ① 客户上传资料 → 按顶层本体体系构建图谱      graph.extractGraph(ontologyProfile=…)
//   ② 用体系的约束/公理校验图谱                  graph.validateGraph(pid)（通道 C，只读体检）
//   ③ 用户输入具体问题 → 根据图谱推理作答        graph.kgAsk(question)
//
// 用法：
//   node scripts/run-sample-cases.js                     # 跑全部 10 个案例
//   node scripts/run-sample-cases.js case1-ecommerce-risk # 只跑指定案例（可多个）
//   node scripts/run-sample-cases.js --list              # 只列出案例
//
// 前置：本机 Ollama 已启动（ollama serve）且已拉取模型（默认 qwen3.8:27b）。
//       可用环境变量覆盖：SYNAPSE_MODEL / SYNAPSE_BASE_URL / SYNAPSE_PROVIDER
//
// 安全：整个运行落在临时沙箱（os.tmpdir 下），**不会污染仓库内真实的 data/ 图谱与笔记**。
//       报告写回案例目录的 报告.md（这是唯一的仓库内写入）。
// ============================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const SAMPLE = path.join(REPO, 'data', 'note', 'sample');

const PROVIDER = process.env.SYNAPSE_PROVIDER || 'ollama';
const BASE_URL = process.env.SYNAPSE_BASE_URL || 'http://127.0.0.1:11434/v1';
const MODEL = process.env.SYNAPSE_MODEL || 'qwen3.8:27b';
// 思考链：默认关闭。本地 27B Q4 上开启思考会把单次抽取从 ~37s 拖到 ~75s（长资料批次
// 实测 8 分钟/任务），10 个案例共 20 个批次将耗时数小时。三步闭环的推理能力来自
// 本体推理引擎（runInference）与图谱事实（kg:facts），不依赖模型自述思考，故默认关闭。
// 需要观察模型思考过程时设 SYNAPSE_THINK=1。
const THINK = process.env.SYNAPSE_THINK === '1';

// ---------- 参数 ----------
const argv = process.argv.slice(2);
if (argv.includes('--list')) {
  for (const d of fs.readdirSync(SAMPLE, { withFileTypes: true })) {
    if (d.isDirectory() && /^case\d+-/.test(d.name)) console.log(d.name);
  }
  process.exit(0);
}
const wantSlugs = argv.filter((a, i) => !a.startsWith('-') && argv[i - 1] !== '--log');

// 日志：stdout 重定向到管道/文件时 Node 会缓冲，长任务看不到进度；
// 额外用 appendFileSync 写一份无缓冲日志，便于 tail 实时观察。
const logIdx = argv.indexOf('--log');
const LOG_FILE = logIdx >= 0 ? path.resolve(argv[logIdx + 1] || '') : '';
if (logIdx >= 0 && !LOG_FILE) { console.error('--log 需要跟一个文件路径'); process.exit(2); }
if (LOG_FILE) { try { fs.writeFileSync(LOG_FILE, '', 'utf8'); } catch (e) { console.error('无法写日志文件：' + e.message); process.exit(2); } }

// ---------- 环境（必须在 require src/main/** 之前装 electron 桩） ----------
const { bootEnv } = require(path.join(REPO, 'test', 'helpers', 'harness'));

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...a) => {
  const line = `[${ts()}] ` + a.join(' ');
  console.log(line);
  if (LOG_FILE) { try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch (_) {} }
};

function readCase(slug) {
  const dir = path.join(SAMPLE, slug);
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`缺少 manifest.json：${slug}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const materials = (manifest.steps.step1.materials || []).map((rel) => {
    const abs = path.join(dir, rel);
    if (!fs.existsSync(abs)) throw new Error(`缺少资料文件：${slug}/${rel}`);
    return { rel, abs, title: path.basename(rel).replace(/\.md$/, ''), text: fs.readFileSync(abs, 'utf8') };
  });
  return { slug, dir, manifest, materials };
}

function listSlugs() {
  return fs.readdirSync(SAMPLE, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^case\d+-/.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
}

// ---------- 报告渲染 ----------
const md = {
  h1: (s) => `# ${s}`,
  h2: (s) => `## ${s}`,
  h3: (s) => `### ${s}`,
  code: (s, lang = '') => '```' + lang + '\n' + s + '\n```',
  table: (head, rows) => [
    '| ' + head.join(' | ') + ' |',
    '|' + head.map(() => '---').join('|') + '|',
    ...rows.map((r) => '| ' + r.map((c) => String(c == null ? '' : c).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ') + ' |'),
  ].join('\n'),
  esc: (s) => String(s == null ? '' : s).replace(/\|/g, '\\|'),
};

function renderReport(c, run) {
  const L = [];
  L.push(md.h1(`${c.manifest.title}（${c.slug}）`));
  L.push('');
  L.push(`> 本报告由 \`node scripts/run-sample-cases.js ${c.slug}\` 于 **${run.at}** 自动生成。`);
  L.push(`> 模型：\`${run.model}\`（${run.provider} @ ${run.baseUrl}）｜运行耗时：${run.elapsed}`);
  L.push(`> 沙箱：\`${run.sandbox}\`（临时目录，未触碰仓库内真实 data/）`);
  L.push('');

  // ---- 第一步 ----
  L.push(md.h2('第一步：客户上传资料 → 按顶层本体体系构建图谱'));
  L.push('');
  L.push(md.table(
    ['资料（客户上传）', '字数', '顶层本体体系'],
    c.materials.map((m, i) => [
      `\`${m.rel}\``,
      m.text.length,
      i === 0 ? `\`${c.manifest.steps.step1.ontologyProfile}\`（提取弹窗显式指定，五级优先级链第 ① 级）` : '',
    ])
  ));
  L.push('');
  L.push(`**体系选择理由**：${c.manifest.steps.step1.profileReason}`);
  L.push('');
  L.push(md.h3('作业阶段'));
  L.push('');
  L.push(md.code(run.stages.map((s) => `[${s.k}] ${s.t}`).join('\n')));
  L.push('');
  L.push(md.h3('建图结果'));
  L.push('');
  const ex = run.extract || {};
  L.push(md.table(['指标', '值'], [
    ['节点数', ex.nodeCount],
    ['原始边数', ex.rawEdgeCount],
    ['落库边数（含推理边）', ex.edgeCount],
    ['来源数', ex.sourceCount],
    ['生效体系', `${ex.profileName}（\`${ex.profileId}\`）`],
    ['失败任务', (ex.failedTasks || []).length],
    ['护栏拦截', ex.guard ? `${ex.guard.total} 条（${JSON.stringify(ex.guard.byReason)}）` : '无（该体系未声明 domain/range，coverage 0%，属预期）'],
    ['推理', run.reasonLine],
  ]));
  L.push('');
  if (run.nodeTypes && run.nodeTypes.length) {
    L.push(md.h3('节点类型分布'));
    L.push('');
    L.push(md.table(['类型', '数量', '示例节点'], run.nodeTypes));
    L.push('');
  }
  if (run.edgeSample && run.edgeSample.length) {
    L.push(md.h3('边样例（前 20 条）'));
    L.push('');
    L.push(md.table(['起点', '关系', '终点', '推理边'], run.edgeSample));
    L.push('');
  }

  // ---- 第二步 ----
  L.push(md.h2('第二步：使用顶层本体体系的约束公理校验图谱'));
  L.push('');
  L.push(`入口：\`graph.validateGraph('${run.profile}', {})\`（IPC \`graph:validate\`，融合设计 §12.2.3 通道 C，**只读体检**）。`);
  L.push('UI 等价操作：本体定义 → 列表 → 推理 Tab → 全图校验。');
  L.push('');
  const v = run.validate || {};
  if (v.ok === false) {
    L.push(`⚠️ 校验降级：${v.error}`);
  } else {
    const cov = v.coverage || {};
    L.push(md.table(['校验项', '结果'], [
      ['体系', `${v.profileName}（\`${v.profileId}\`）`],
      ['受检边数 checked', v.checked],
      ['违规总数 violations', (v.violations || []).length + (v.truncated ? `（已截断，上限 ${50}）` : '')],
      ['按原因 byReason', JSON.stringify(v.byReason || {})],
      ['按谓词 byRel', JSON.stringify(v.byRel || {})],
      ['不相交冲突 disjointConflicts', (v.disjointConflicts || []).length],
      ['护栏覆盖率 coveragePct', `${cov.coveragePct != null ? cov.coveragePct + '%' : '—'}（${cov.withAny || 0}/${cov.predicates || 0} 个谓词声明了 domain/range）`],
      ['公理数 axiomCount', cov.axiomCount],
      ['类数 classCount', cov.classCount],
      ['不相交公理 disjointPairs', (cov.disjointPairs || []).length],
      ['传递谓词 transitive', JSON.stringify(cov.transitive || [])],
      ['对称谓词 symmetric', JSON.stringify(cov.symmetric || [])],
      ['互逆谓词 inversePairs', JSON.stringify(cov.inversePairs || [])],
    ]));
    L.push('');
    if ((v.violations || []).length) {
      L.push(md.h3('违规明细'));
      L.push('');
      L.push(md.table(['边', '关系', '原因', '说明'],
        v.violations.slice(0, 30).map((x) => [
          `${x.from} → ${x.to}`, x.rel || '(空)', x.reason, x.detail || '',
        ])));
      L.push('');
    }
    if ((v.disjointConflicts || []).length) {
      L.push(md.h3('不相交冲突明细'));
      L.push('');
      L.push(md.table(['节点', '声明类型', '被强制类型', '经由', '说明'],
        v.disjointConflicts.slice(0, 20).map((x) => [x.node, x.declaredType, x.forcedType, x.via, x.detail || ''])));
      L.push('');
    }
    if (!(v.violations || []).length && !(v.disjointConflicts || []).length) {
      L.push('✅ **未发现违规**：全部受检边的谓词、定义域、值域与不相交公理均满足体系声明。');
      L.push('');
    }
  }
  L.push(md.h3('物化推理（OWL 2 RL 前向链）'));
  L.push('');
  L.push(md.code(run.inferText));
  L.push('');

  // ---- 第三步 ----
  L.push(md.h2('第三步：用户输入具体问题 → 根据图谱推理作答'));
  L.push('');
  L.push('入口：`graph.kgAsk()`（IPC `graph:ask`）。UI 等价操作：AI 问答页输入问题。');
  L.push('');
  for (let i = 0; i < run.answers.length; i++) {
    const a = run.answers[i];
    L.push(md.h3(`问题 ${i + 1}：${a.question}`));
    L.push('');
    L.push(md.table(['环节', '结果'], [
      ['识别到的图谱实体', (a.matched || []).join('、') || '（未命中，已回退关键词/分词召回）'],
      ['召回事实条数', (a.facts || []).length],
      ['原文回溯材料', (a.refs || []).map((r) => r.label).join('、') || '（无）'],
      ['影响面闭包', a.impact ? `下游 ${a.impact.nodeCount} 个节点（推理边 ${a.impact.inferredCount} 个），传导事实 ${a.impact.factCount} 条，关键词「${(a.impact.keywords || []).join('、')}」` : '（未触发，非影响面提问）'],
      ['回答字数', (a.answer || '').length],
    ]));
    L.push('');
    if ((a.facts || []).length) {
      L.push('<details><summary>图谱召回的事实（前 25 条）</summary>');
      L.push('');
      L.push(md.code(a.facts.slice(0, 25).join('\n')));
      L.push('');
      L.push('</details>');
      L.push('');
    }
    if (a.error) {
      L.push(`⚠️ 问答出错：${a.error}`);
    } else {
      L.push(md.h3('回答'));
      L.push('');
      L.push(a.answer || '（模型返回为空）');
    }
    L.push('');
    if ((a.stages || []).length) {
      L.push('<details><summary>问答阶段日志</summary>');
      L.push('');
      L.push(md.code(a.stages.join('\n')));
      L.push('');
      L.push('</details>');
      L.push('');
    }
  }

  // ---- 结论 ----
  L.push(md.h2('小结'));
  L.push('');
  L.push(md.table(['步骤', '预期', '实际'], [
    ['① 建图', c.manifest.expect.step1, run.summ1],
    ['② 校验', c.manifest.expect.step2, run.summ2],
    ['③ 问答', c.manifest.expect.step3, run.summ3],
  ]));
  L.push('');
  return L.join('\n');
}

// ---------- 单案例执行 ----------
async function runCase(mods, c) {
  const { graph, notesStore, settingsMod, db } = mods;
  const profile = c.manifest.steps.step1.ontologyProfile;
  const t0 = Date.now();
  const stages = [];

  // 清场：每个案例从空图开始，避免跨案例串味。
  // 笔记存在沙箱磁盘上（loadStore 扫描目录），只删 db 的 folders 表不够，
  // 必须把笔记根目录一并清空，否则上一案例的资料会被 collectSources 带进本案例。
  graph.clearGraph();
  db.run('DELETE FROM folders');
  db.flush();
  try { fs.rmSync(notesStore.notesRoot(), { recursive: true, force: true }); } catch (_) {}

  // ① 客户上传资料 → 落成沙箱笔记（这样节点 sources 能回溯到原文，第三步才有引用）
  for (const m of c.materials) {
    notesStore.importNote(m.title, m.text, `sample/${c.slug}/资料`, `sample:${c.slug}/${m.rel}`);
  }
  const notes = notesStore.getNotes();
  log(`  资料已入库：${notes.length} 篇笔记（${notes.map((n) => n.title).join('、')}）`);

  const settings = Object.assign({}, settingsMod.getSettings(), {
    apiProvider: PROVIDER,
    apiBaseUrl: BASE_URL,
    model: MODEL,
    apiKey: '',
    reasonEnabled: true,
    reasonTimeout: 120,
    graphConcurrency: 1,     // 本地单卡模型，串行抽取避免排队/显存抖动
    chatRetries: 1,
    llmRequestTimeout: 3600,
    ollamaNumCtx: 32768,
    thinkingEnabled: THINK,  // 默认 false：见文件头 THINK 说明
  });
  settingsMod.saveSettings(settings);

  // ---- 第一步：建图 ----
  log('  ① extractGraph …');
  let ex = null;
  let extractError = '';
  try {
    ex = await graph.extractGraph(settings, {
      ontologyProfile: profile,          // 五级优先级链第 ① 级：显式指定
      domainId: 'general',
      domainLabel: '通用',
      autoReason: true,
    }, (k, t) => { stages.push({ k, t }); log(`     [${k}] ${t}`); }, null, null);
  } catch (err) {
    extractError = String((err && err.message) || err);
    log('  ❌ 抽取失败：' + extractError);
  }

  const g = graph.getGraph();
  const meta = graph.getGraphMeta();
  const byType = {};
  for (const n of g.nodes) (byType[n.type] = byType[n.type] || []).push(n.name);
  const nodeTypes = Object.entries(byType)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([t, names]) => [t, names.length, names.slice(0, 6).join('、') + (names.length > 6 ? ' …' : '')]);
  const nameOf = (id) => { const n = g.nodes.find((x) => x.id === id); return n ? n.name : id; };
  const edgeSample = g.edges.slice(0, 20).map((e) => [nameOf(e.from), e.rel || '(空)', nameOf(e.to), e.inferred ? '是' : '']);

  const reasonLine = ex && ex.reason
    ? (ex.reason.skipped
      ? `已跳过（${ex.reason.skipReason}${ex.reason.error ? '：' + ex.reason.error.slice(0, 80) : ''}）`
      : `新增 ${ex.reason.inferredEdges} 条推理边（${ex.reason.stats ? ex.reason.stats.rounds + ' 轮 / ' + ex.reason.stats.elapsedMs + ' ms' : ''}），语义冲突 ${ex.reason.inconsistencies.length} 处`)
    : '未执行';

  // ---- 第二步：全图校验（通道 C） ----
  log('  ② validateGraph …');
  const validate = graph.validateGraph(profile, {});
  if (validate.ok === false) log('  ⚠️ 校验降级：' + validate.error);
  else log(`     checked=${validate.checked} violations=${validate.violations.length} disjoint=${validate.disjointConflicts.length} coverage=${validate.coverage && validate.coverage.coveragePct}%`);

  const infer = await graph.runInference(settings, { profileId: profile });
  const inferText = JSON.stringify(infer, null, 2);

  // ---- 第三步：图谱问答 ----
  const answers = [];
  for (const q of c.manifest.steps.step3.questions) {
    log(`  ③ kgAsk：${q}`);
    const a = { question: q, stages: [], matched: [], facts: [], refs: [], impact: null, answer: '', error: '' };
    const event = {
      sender: {
        send: (ch, payload) => {
          if (ch === 'ai:chunk') a.answer += payload;
          else if (ch === 'kg:stage') { a.stages.push(payload); log('     · ' + payload); }
          else if (ch === 'kg:facts') { a.matched = payload.matched || []; a.facts = payload.facts || []; a.refs = payload.refs || []; a.impact = payload.impact || null; }
          else if (ch === 'ai:error') { a.error = String(payload); log('     ❌ ' + a.error); }
        },
      },
      senderFrame: null,
    };
    try {
      await graph.kgAsk(event, { settings, question: q, hops: 2, withFacts: true });
    } catch (err) {
      a.error = String((err && err.message) || err);
    }
    log(`     → 回答 ${a.answer.length} 字，事实 ${a.facts.length} 条，材料 ${a.refs.length} 份`);
    answers.push(a);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1) + ' s';
  const cov = validate.coverage || {};
  const run = {
    at: ts(), model: MODEL, provider: PROVIDER, baseUrl: BASE_URL, elapsed,
    sandbox: mods.sandbox, profile, stages, extract: ex, extractError,
    nodeTypes, edgeSample, reasonLine, validate, inferText, answers,
    summ1: extractError
      ? `❌ 抽取失败：${extractError}`
      : `${ex.nodeCount} 节点 / ${ex.rawEdgeCount} 原始边 / ${ex.edgeCount} 落库边，体系「${ex.profileName}」`,
    summ2: validate.ok === false
      ? `⚠️ 降级：${validate.error}`
      : `受检 ${validate.checked} 边，违规 ${validate.violations.length} 条，不相交冲突 ${validate.disjointConflicts.length} 处，护栏覆盖率 ${cov.coveragePct != null ? cov.coveragePct + '%' : '—'}`,
    summ3: `${answers.length} 问全部作答，共 ${answers.reduce((s, a) => s + a.answer.length, 0)} 字；`
      + `命中实体 ${answers.reduce((s, a) => s + a.matched.length, 0)} 个，召回事实 ${answers.reduce((s, a) => s + a.facts.length, 0)} 条，回溯原文 ${answers.reduce((s, a) => s + a.refs.length, 0)} 份`,
  };
  if (meta && meta.lastStats) run.metaStats = meta.lastStats;

  const report = renderReport(c, run);
  const out = path.join(c.dir, '报告.md');
  fs.writeFileSync(out, report, 'utf8');
  log(`  ✅ 报告已写入 ${path.relative(REPO, out)}（${report.length} 字）`);
  return { slug: c.slug, ok: !extractError && validate.ok !== false && answers.every((a) => !a.error && a.answer.length > 0), elapsed };
}

// ---------- 主流程 ----------
(async () => {
  const all = listSlugs();
  const slugs = wantSlugs.length ? wantSlugs : all;
  for (const s of slugs) if (!all.includes(s)) { console.error(`未知案例：${s}\n可选：${all.join(', ')}`); process.exit(2); }

  // 探活：模型服务不通就直接失败，别白跑
  try {
    const origin = new URL(BASE_URL).origin;
    const r = await fetch(`${origin}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const names = (j.models || []).map((m) => m.name);
    if (!names.some((n) => n === MODEL || n.startsWith(MODEL + ':'))) {
      console.error(`⚠️ 模型 ${MODEL} 不在本机列表中：${names.join(', ')}`);
    }
    log(`模型服务就绪：${origin}（${names.join(', ')}）`);
  } catch (err) {
    console.error(`❌ 无法连接模型服务 ${BASE_URL}：${err.message}\n   请先运行 ollama serve，或用 SYNAPSE_BASE_URL/SYNAPSE_PROVIDER/SYNAPSE_MODEL 指定其他 OpenAI 兼容端点。`);
    process.exit(3);
  }

  const env = await bootEnv({ prefix: 'synapse-sample-' });
  const mods = {
    sandbox: env.dir,
    graph: require(path.join(REPO, 'src', 'main', 'graph', 'graph')),
    notesStore: require(path.join(REPO, 'src', 'main', 'notes', 'store')),
    settingsMod: require(path.join(REPO, 'src', 'main', 'common', 'settings')),
    db: require(path.join(REPO, 'src', 'main', 'common', 'db')),
  };
  log(`沙箱：${env.dir}`);
  log(`推理层可用：${mods.graph.reasonReady()}（${mods.graph.reasonUnavailableReason() || 'OK'}）`);
  if (!mods.graph.reasonReady()) {
    console.error('❌ protege-js 推理层不可用，第二/三步的推理与校验会降级。请先在仓库根执行 npm install。');
    process.exit(4);
  }

  const results = [];
  for (const slug of slugs) {
    log(`\n===== ${slug} =====`);
    const c = readCase(slug);
    try {
      results.push(await runCase(mods, c));
    } catch (err) {
      log('  ❌ 案例异常：' + (err && err.stack || err));
      results.push({ slug, ok: false, elapsed: '-', error: String((err && err.message) || err) });
    }
  }

  log('===== 汇总 =====');
  for (const r of results) log(`${r.ok ? '✅' : '❌'} ${r.slug}  ${r.elapsed}${r.error ? '  ' + r.error : ''}`);
  const bad = results.filter((r) => !r.ok).length;
  log(`${results.length - bad}/${results.length} 个案例三步全部跑通`);
  process.exit(bad ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
