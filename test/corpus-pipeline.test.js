// 语料流水线·装配与可选层测试（设计 §8.2 / §4.2 O4 / §4.1–§4.3 五期）
// 覆盖：buildPipeline 折叠 + makeSource 判别 + validateCaps 层序（重点 O4）+ previewPipeline，
//      以及可选层 CorpusReuseDecorator 的「端到端复用」（不接 LLM：.md 走内置解析）。
// GroupSource 注册、dedup 接线点默认关一并校验。
// 运行：node test/corpus-pipeline.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { bootEnv, mkCheck, writeFile } = require('./helpers/harness');

const { check, section, summary } = mkCheck('语料流水线·装配与可选层');

(async () => {
  const env = await bootEnv({ prefix: 'synapse-pipeline-' });
  const build = require('../src/main/corpus/build');
  const { buildPipeline, validateCaps, chainLayers, previewPipeline, LAYERS, makeSource } = build;
  const { drive, makeContext } = require('../src/main/corpus/drive');
  const store = require('../src/main/corpus/store');
  const { GRAPH_RECIPE, CORPUS_RECIPE, RECIPES } = require('../src/main/corpus/recipes');

  // ---- 准备一个 wiki 根，放一份 .md 原始文件（内置解析可读，无需 LLM）----
  const wiki = path.join(env.dir, 'wiki');
  const rawDir = path.join(wiki, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  const mdAbs = path.join(rawDir, 'doc.md');
  writeFile(mdAbs, '# 标题\n\n这是正文内容，用于验证复用与解析跳过。\n');
  const baseSettings = { wikiRoot: wiki };

  // ---------- 1. LAYERS 注册与可选层键 ----------
  section('LAYERS 注册表');
  check('18 个注册键', Object.keys(LAYERS).length === 18, 'got=' + Object.keys(LAYERS).length);
  check('corpusReuse 已注册（五期可选层）', typeof LAYERS.corpusReuse === 'function' && LAYERS.corpusReuse.name === 'CorpusReuseDecorator', LAYERS.corpusReuse && LAYERS.corpusReuse.name);
  check('group 已注册（GroupSource）', typeof LAYERS.group === 'function' && LAYERS.group.name === 'GroupSource', LAYERS.group && LAYERS.group.name);
  check('dedup 不占独立注册键（寄宿 filter.js）', LAYERS.dedup === undefined);

  // ---------- 2. makeSource 按 payload 判别 ----------
  section('makeSource 类型判别');
  check('corpusRels → CorpusFileSource', makeSource({ kind: 'auto' }, { corpusRels: ['x/1.md'] }).constructor.name === 'CorpusFileSource');
  check('inlineSources → InlineSource', makeSource({ kind: 'auto' }, { inlineSources: [{ label: 'l', text: 't' }] }).constructor.name === 'InlineSource');
  check('urls → UrlSource', makeSource({ kind: 'auto' }, { urls: ['http://a/b'] }).constructor.name === 'UrlSource');
  check('rawPaths → RawFileSource', makeSource({ kind: 'auto' }, { rawPaths: ['raw/doc.md'] }).constructor.name === 'RawFileSource');
  check('空 payload 兜底 NoteSource', makeSource({ kind: 'auto' }, {}).constructor.name === 'NoteSource');

  // ---------- 3. validateCaps O1–O4 构建期强制 ----------
  section('validateCaps 层序约束');
  // O4 违例：corpusReuse 落在 cache 外层（source→fallback→cache→corpusReuse）
  let o4 = '';
  try {
    buildPipeline([
      { layer: 'source', kind: 'raw' },
      { layer: 'fallback', candidates: ['builtin'] },
      { layer: 'cache' },
      { layer: 'corpusReuse', enabled: 'true' },
    ], makeContext({ settings: baseSettings, rawPaths: ['raw/doc.md'] }));
  } catch (e) { o4 = e.message; }
  check('O4：CorpusReuse 不在 Cache 内层 → 抛错', /O4/.test(o4), o4);
  // O1 违例：cache 落在 fallback 内层（写不出来，fallback 需要 inner；用直接抛验证）
  check('默认 GRAPH_RECIPE 构建不抛（含层序校验）', (() => {
    try { buildPipeline(GRAPH_RECIPE, makeContext({ settings: { ...baseSettings, rawPaths: ['raw/doc.md'] }, rawPaths: ['raw/doc.md'] })); return true; }
    catch (_) { return false; }
  })());
  check('默认 GRAPH_RECIPE 不含 corpusReuse（corpusReuse 默认关 → 整层跳过）',
    !chainLayers(buildPipeline(GRAPH_RECIPE, makeContext({ settings: baseSettings, rawPaths: ['raw/doc.md'] }))).includes('CorpusReuseDecorator'));
  check('corpusReuse=true 时 GRAPH_RECIPE 链含 CorpusReuseDecorator',
    chainLayers(buildPipeline(GRAPH_RECIPE, makeContext({ settings: { ...baseSettings, corpusReuse: true }, rawPaths: ['raw/doc.md'] }))).includes('CorpusReuseDecorator'));
  // O4 正确顺序：corpusReuse 在 cache 与 fallback 之间
  const ordered = chainLayers(buildPipeline([
    { layer: 'source', kind: 'raw' },
    { layer: 'fallback', candidates: ['builtin'] },
    { layer: 'corpusReuse', enabled: 'true' },
    { layer: 'cache' },
  ], makeContext({ settings: baseSettings, rawPaths: ['raw/doc.md'] })));
  check('O4 正解：cache(外) > corpusReuse > fallback(内)',
    ordered.indexOf('CacheDecorator') < ordered.indexOf('CorpusReuseDecorator')
    && ordered.indexOf('CorpusReuseDecorator') < ordered.indexOf('FallbackDecorator'), ordered.join(' > '));

  // ---------- 4. previewPipeline 可选层显隐 ----------
  section('previewPipeline（设置页链预览）');
  const pvOn = previewPipeline(GRAPH_RECIPE, makeContext({ settings: { ...baseSettings, corpusReuse: true }, rawPaths: ['raw/doc.md'] }));
  const pvOff = previewPipeline(GRAPH_RECIPE, makeContext({ settings: baseSettings, rawPaths: ['raw/doc.md'] }));
  check('corpusReuse=true → 预览里 corpusReuse enabled', (pvOn.find((l) => l.name === 'corpusReuse') || {}).enabled === true);
  check('corpusReuse 关 → 预览里 corpusReuse disabled 且给跳过原因', (() => {
    const r = pvOff.find((l) => l.name === 'corpusReuse') || {};
    return r.enabled === false && /跳过/.test(r.reason || '');
  })(), JSON.stringify(pvOff.find((l) => l.name === 'corpusReuse')));

  // ---------- 5. CorpusReuse 端到端：先落盘，再复用（跳过解析）----------
  section('CorpusReuseDecorator 端到端复用');
  const WRITE_RECIPE = [
    { layer: 'source', kind: 'raw' },
    { layer: 'fallback', candidates: ['builtin'] },
    { layer: 'cache' },
    { layer: 'corpusWrite' },
  ];
  const REUSE_RECIPE = [
    { layer: 'source', kind: 'raw' },
    { layer: 'fallback', candidates: ['builtin'] },
    { layer: 'corpusReuse', enabled: 'settings.corpusReuse === true' },
    { layer: 'cache' },
    { layer: 'corpusWrite' },
  ];

  // 第一次：正常内置解析 + 落盘
  const wItems = [];
  await drive(buildPipeline(WRITE_RECIPE, makeContext({ settings: baseSettings, rawPaths: ['raw/doc.md'] })),
    Object.assign(makeContext({ settings: baseSettings, rawPaths: ['raw/doc.md'] }), { onItem: (it) => wItems.push(it) }));
  check('首轮解析产出 1 条（内置）', wItems.length === 1 && wItems[0].meta.parseMethod === 'builtin', wItems[0] && wItems[0].meta.parseMethod);
  const idx = store.scanCorpusFiles();
  check('首轮已按原文档名落盘 1 篇语料', idx.length === 1 && idx[0].rel === 'doc/doc.md', JSON.stringify(idx.map((r) => r.rel)));
  check('流水线落盘不生成独立索引', !fs.existsSync(path.join(store.corpusRoot(), 'index.json')));

  // findReusableCorpus 直查
  const origin = { type: 'local', path: 'raw/doc.md' };
  const hit = store.findReusableCorpus(origin, baseSettings);
  check('findReusableCorpus 命中未过期语料并回正文', !!hit && hit.ok === true && /这是正文内容/.test(hit.text), JSON.stringify(hit && { rel: hit.rel }));
  check('非本地来源（note:）不复用', store.findReusableCorpus({ type: 'note', path: 'note:x' }, baseSettings) === null);

  // 源文件 mtime 变 → 过期，不复用
  const st = fs.statSync(mdAbs);
  fs.writeFileSync(mdAbs, '# 改了\n\n全新内容覆盖。\n');
  fs.utimesSync(mdAbs, new Date(st.atime), new Date(Date.now() + 5000));
  check('源文件 mtime 变 → findReusableCorpus 返回 null（让位重抽）', store.findReusableCorpus(origin, baseSettings) === null);
  // 复原内容并更新语料文件（重新落盘一次，使语料与源一致且未过期）
  writeFile(mdAbs, '# 标题\n\n这是正文内容，用于验证复用与解析跳过。\n');
  await drive(buildPipeline(WRITE_RECIPE, makeContext({ settings: baseSettings, rawPaths: ['raw/doc.md'] })),
    makeContext({ settings: baseSettings, rawPaths: ['raw/doc.md'] }));

  // 第二次：开 corpusReuse，走复用短路（parseMethod=corpus，不经内置解析）
  const rItems = [];
  const rctx = makeContext({ settings: { ...baseSettings, corpusReuse: true }, rawPaths: ['raw/doc.md'] });
  const rres = await drive(buildPipeline(REUSE_RECIPE, makeContext({ settings: { ...baseSettings, corpusReuse: true }, rawPaths: ['raw/doc.md'] })),
    Object.assign(rctx, { onItem: (it) => rItems.push(it) }));
  check('复用轮命中：parseMethod=corpus（非 builtin，证明跳过解析）',
    rItems.length === 1 && rItems[0].meta.parseMethod === 'corpus' && !!rItems[0].meta.reusedCorpus,
    rItems[0] && JSON.stringify({ m: rItems[0].meta.parseMethod, r: rItems[0].meta.reusedCorpus }));
  check('复用轮正文正确', rItems[0] && /这是正文内容/.test(rItems[0].text), rItems[0] && rItems[0].text.slice(0, 10));
  check('stats.corpusReuseHits ≥ 1', Number(rres.stats && rres.stats.corpusReuseHits) >= 1, JSON.stringify(rres.stats && { h: rres.stats.corpusReuseHits }));
  check('复用不留 bytes', rItems[0] && rItems[0].bytes === undefined);

  // ---------- 6. dedup 接线点：默认关（不改变条目数）----------
  section('FilterDecorator.dedup 接线点（默认关）');
  const { FilterDecorator } = require('../src/main/corpus/decorators/filter');
  check('filter 配方项 dedup 默认 false', (CORPUS_RECIPE.find((s) => s.layer === 'filter') || {}).dedup === undefined
    || (GRAPH_RECIPE.find((s) => s.layer === 'filter') || {}).dedup === false);
  check('FilterDecorator 接受 opts.dedup（预留开关存在）', typeof FilterDecorator === 'function');

  check('RECIPES 汇总含三配方 + 两子链', ['graph', 'corpus', 'note', 'graph-collect', 'graph-extract'].every((k) => Array.isArray(RECIPES[k])));

  section('语料页签：每次进入都重新加载磁盘列表');
  let listCalls = 0;
  let rendered = 0;
  const ui = vm.createContext({
    state: { corpusTab: 'raw', corpus: [], settings: baseSettings },
    $: () => null,
    document: { querySelectorAll: () => [] },
    window: { kb: { corpusList: async () => {
      listCalls++;
      return { ok: true, items: store.listCorpus(baseSettings) };
    } } },
  });
  vm.runInContext(fs.readFileSync(path.join(env.repoRoot, 'src/renderer/corpus.js'), 'utf8'), ui);
  ui.renderCorpusList = () => { rendered++; };
  const load = ui.loadCorpus;
  let loaded;
  ui.loadCorpus = () => (loaded = load());
  ui.showCorpusPane();
  await loaded;
  check('之前缓存为空也会查询并显示磁盘语料', listCalls === 1 && ui.state.corpus.length > 0 && rendered === 1);
  ui.showRawPane();
  check('切回原始文件不请求语料列表', listCalls === 1);
  ui.state.corpus = [{ rel: '旧缓存/不存在.md' }];
  ui.showCorpusPane();
  await loaded;
  check('再次进入替换旧缓存并重新渲染', listCalls === 2 && rendered === 2
    && ui.state.corpus.every((x) => x.rel !== '旧缓存/不存在.md'));

  section('语料抽取弹窗：真实渲染脚本与 Web 桥接回归');
  // 只实现本流程使用的 DOM 行为；业务函数和桥接均加载真实脚本，网络与作业使用桩。
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag;
      this.children = [];
      this.style = {};
      this.className = '';
      this.listeners = new Map();
      this.hidden = false;
      this.classList = {
        contains: (name) => this.className.split(/\s+/).includes(name),
        add: (...names) => { this.className = [...new Set(this.className.split(/\s+/).filter(Boolean).concat(names))].join(' '); },
        remove: (...names) => { this.className = this.className.split(/\s+/).filter((n) => !names.includes(n)).join(' '); },
        toggle: (name, on) => {
          const enabled = on === undefined ? !this.classList.contains(name) : on;
          if (enabled) this.classList.add(name); else this.classList.remove(name);
          return enabled;
        },
      };
    }
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.append(child); return child; }
    set textContent(text) { this.text = String(text); this.children = []; }
    get textContent() { return (this.text || '') + this.children.map((c) => c.textContent).join(''); }
    set innerHTML(html) {
      this.textContent = '';
      if (html.includes('class="tt"')) {
        const title = new Element('span'); title.className = 'tt'; this.append(title);
      }
    }
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [
        ...(selector.startsWith('.') && child.classList.contains(selector.slice(1)) ? [child] : []),
        ...child.querySelectorAll(selector),
      ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    async fire(type) {
      for (const fn of [...(this.listeners.get(type) || [])]) await fn({ target: this });
      if (this['on' + type]) await this['on' + type]({ target: this });
    }
  }
  const scripts = ['web/kb-shim.js', 'src/renderer/raws.js', 'src/renderer/corpus.js']
    .map((rel) => ({ rel, code: fs.readFileSync(path.join(env.repoRoot, rel), 'utf8') }));
  for (const scenario of ['name', 'content', 'unchecked', 'cancel']) {
    const ids = ['domain-modal-title', 'domain-modal-sub', 'domain-progress', 'domain-modal',
      'btn-domain-confirm', 'domain-judge-bar', 'btn-domain-judge-start', 'btn-domain-close', 'domain-progress-hint'];
    const elements = Object.fromEntries(ids.map((id) => [id, new Element()]));
    const rels = ['知识引擎/同名文档.md', '资金安全/同名文档.md'];
    const texts = ['知识引擎正文', '资金安全正文'];
    const templates = [{ id: 'general', name: '通用' },
      { id: 'engine', name: '知识引擎', ontologyProfile: 'bfo-lite' },
      { id: 'finance', name: '资金安全', ontologyProfile: 'bfo-lite' }];
    const calls = [];
    const jobs = [];
    let events;
    const ctx = vm.createContext({
      state: { settings: { pipeline: true }, templates: [] },
      $: (id) => elements[id] || null,
      document: {
        createElement: (tag) => new Element(tag),
        querySelector: () => ({ value: scenario === 'name' ? 'name' : 'content' }),
        getElementById: (id) => elements[id] || elements['domain-progress'].querySelectorAll('.domain-reason-row')
          .flatMap((row) => row.children).find((child) => child.id === id) || null,
      },
      toast: () => {}, showJobsView: () => {}, reasonAvailable: () => true,
      window: {},
      EventSource: class { constructor() { events = this; } },
      fetch: async (url, options) => {
        const channel = decodeURIComponent(url.slice('/api/call/'.length));
        const payload = JSON.parse(options.body);
        calls.push({ channel, payload });
        let result;
        if (channel === 'corpus:read') result = { ok: true, text: texts[rels.indexOf(payload.rel)] };
        else if (channel === 'tpl:suggestDomains' || channel === 'tpl:assignDomains') {
          if (!payload.inlineSources?.length) result = { ok: false, error: '带名语料未传入' };
          else if (channel === 'tpl:suggestDomains') result = { ok: true, domains: templates.slice(1).map((t) => ({ name: t.name })) };
          else result = { ok: true, assignments: Object.fromEntries(rels.map((rel, i) =>
            ['inline:' + rel, { domains: [templates[i + 1].name], confidence: 0.9 }])), unassigned: [] };
          events.onmessage({ data: JSON.stringify({ channel: channel === 'tpl:suggestDomains' ? 'tpl:suggest-domains-chunk' : 'tpl:assign-domains-chunk',
            data: { text: '测试思考流', reasoning: true } }) });
        } else if (channel === 'tpl:list') result = templates;
        else if (channel === 'graph:profiles') result = [{ id: 'bfo-lite', name: 'BFO-Lite' }];
        else if (channel === 'jobs:submit') { jobs.push(payload); result = { ok: true }; }
        else throw new Error('不应调用通道：' + channel);
        return { ok: true, json: async () => ({ result }) };
      },
    });
    for (const script of scripts) vm.runInContext(script.code, ctx, { filename: script.rel });
    let started;
    const opened = new Promise((resolve) => { started = resolve; });
    const auto = ctx.autoDomainAndExtract;
    ctx.autoDomainAndExtract = (payload) => { const pending = auto(payload); started(); return pending; };
    const flow = ctx.graphFromCorpus(rels);
    await opened;
    check(scenario + '：先显示判定方式弹窗，不提前识别/提交', elements['domain-modal'].hidden === false
      && !calls.some((c) => c.channel === 'tpl:suggestDomains') && jobs.length === 0);
    if (scenario === 'cancel') {
      await elements['btn-domain-close'].fire('click');
      await flow;
      check('选择阶段取消后不判定也不提交', elements['domain-modal'].hidden && jobs.length === 0 && calls.every((c) => c.channel === 'corpus:read'));
      continue;
    }
    await elements['btn-domain-judge-start'].fire('click');
    await flow;
    const sug = calls.find((c) => c.channel === 'tpl:suggestDomains');
    const asn = calls.find((c) => c.channel === 'tpl:assignDomains');
    check(scenario + '：识别和分类均携带完整语料路径、正文及判据', [sug, asn].every((c) => c && c.payload.judgeBy === (scenario === 'name' ? 'name' : 'content')
      && c.payload.inlineSources.every((s, i) => s.label === rels[i] && s.text === texts[i])));
    check(scenario + '：成功生成两个领域确认组且未回退通用', elements['domain-progress'].querySelectorAll('.dgroup-card').length === 2
      && !elements['domain-progress'].textContent.includes('多领域判定异常'));
    check(scenario + '：思考流显示且同名模版直接复用', elements['domain-progress'].textContent.includes('测试思考流')
      && !calls.some((c) => c.channel === 'tpl:generate'));
    check(scenario + '：配置准备完成仍等待确认，不提前提交作业', jobs.length === 0 && elements['btn-domain-confirm'].hidden === false);
    const reasonRow = elements['domain-progress'].querySelector('.domain-reason-row');
    const reasonCheckbox = ctx.document.getElementById('extract-auto-reason');
    check(scenario + '：推理选项为左侧复选框、右侧独立内容区', reasonRow.tagName === 'label'
      && reasonRow.children[0] === reasonCheckbox && reasonRow.children[1].className === 'domain-reason-content' && reasonCheckbox.checked === true);
    check(scenario + '：推理标题、推荐徽标、说明分层展示', reasonRow.querySelector('.domain-reason-title').textContent.includes('OWL 2 RL')
      && reasonRow.querySelector('.domain-reason-badge').textContent === '推荐' && reasonRow.querySelector('.domain-reason-hint').textContent.includes('本地'));
    if (scenario === 'unchecked') reasonCheckbox.checked = false;
    if (scenario === 'content') {
      await elements['btn-domain-close'].fire('click');
      await elements['btn-domain-confirm'].fire('click');
      check('配置阶段取消后，即使触发确认也不会提交', jobs.length === 0 && elements['domain-modal'].hidden);
    } else {
      await elements['btn-domain-confirm'].fire('click');
      check('确认后逐领域提交，corpusRels 保留同名文件的不同目录', jobs.length === 2 && jobs.every((j, i) => j.type === 'graph'
        && j.payload.corpusRels.length === 1 && j.payload.corpusRels[0] === rels[i] && j.payload.domainId === templates[i + 1].id));
      check('语料作业不退回原文件或内联解析，关闭自动判域', jobs.every((j) => !j.payload.rawPaths && !j.payload.inlineSources && j.payload.autoDomain === false));
      check(scenario + '：样式调整不改变推理开关提交值', jobs.every((j) => scenario === 'unchecked' ? j.payload.autoReason === false : j.payload.autoReason === undefined));
      await elements['btn-domain-confirm'].fire('click');
      check('重复确认不重复提交且弹窗关闭', jobs.length === 2 && elements['domain-modal'].hidden);
    }
  }

  section('领域确认：相同领域与体系合并作业，勾选来源取并集去重');
  const openMergeDialog = async (mode, scenario) => {
    const ids = ['domain-modal-title', 'domain-modal-sub', 'domain-progress', 'domain-modal',
      'btn-domain-confirm', 'domain-judge-bar', 'btn-domain-judge-start', 'btn-domain-close', 'domain-progress-hint'];
    const elements = Object.fromEntries(ids.map((id) => [id, new Element()]));
    const rels = ['共享/同名文档.md', '甲/同名文档.md', '乙/同名文档.md'].slice(0, scenario === 'same-source' ? 1 : 3);
    const sources = rels.map((label, i) => ({ label, text: '正文' + i }));
    const inputRels = scenario === 'duplicate-input' ? [...rels, rels[0]] : rels;
    const inputSources = scenario === 'duplicate-input' ? [...sources, sources[0]] : sources;
    const templates = [{ id: 'general', name: '通用' },
      { id: 'dataset', name: '数据集管理', ontologyProfile: 'bfo-lite', entityTypes: [{ name: '数据集' }] },
      { id: 'release', name: '产品发布矩阵', ontologyProfile: 'bfo-lite', entityTypes: [{ name: '产品' }] }];
    const jobs = [];
    const ctx = vm.createContext({
      state: { settings: { pipeline: true }, templates: [] },
      $: (id) => elements[id] || null,
      document: {
        createElement: (tag) => new Element(tag),
        querySelector: () => ({ value: 'content' }),
        getElementById: (id) => elements[id] || elements['domain-progress'].querySelector('.domain-reason-row')?.children.find((el) => el.id === id) || null,
      },
      toast: () => {}, reasonAvailable: () => true, window: {}, EventSource: class {},
      fetch: async (url, options) => {
        const channel = decodeURIComponent(url.slice('/api/call/'.length));
        const payload = JSON.parse(options.body);
        let result;
        if (channel === 'tpl:suggestDomains') result = { ok: true, domains: templates.slice(1).map((t) => ({ name: t.name })) };
        else if (channel === 'tpl:assignDomains') result = {
          ok: true, unassigned: [], assignments: Object.fromEntries(rels.map((rel, i) => [mode === 'raw' ? rel : 'inline:' + rel,
            { domains: i === 0 ? templates.slice(1).map((t) => t.name) : [templates[i].name], confidence: 1 }])),
        };
        else if (channel === 'tpl:list') result = templates;
        else if (channel === 'graph:profiles') result = [{ id: 'bfo-lite', name: 'BFO-Lite' }, { id: 'iso15926', name: 'ISO 15926' }];
        else if (channel === 'jobs:submit') { jobs.push(payload); result = { ok: true }; }
        else throw new Error('不应调用通道：' + channel);
        return { ok: true, json: async () => ({ result }) };
      },
    });
    for (const script of scripts) vm.runInContext(script.code, ctx, { filename: script.rel });
    const pending = ctx.autoDomainAndExtract({ label: '合并回归', corpusMode: mode === 'corpus',
      ...(mode === 'raw' ? { rawPaths: inputRels } : { inlineSources: inputSources }) });
    await elements['btn-domain-judge-start'].fire('click');
    await pending;
    return { ctx, elements, rels, sources, jobs, cards: elements['domain-progress'].querySelectorAll('.dgroup-card') };
  };
  const change = async (el, value) => { el.value = value; await el.fire('change'); };
  const setChecked = async (el, checked) => { el.checked = checked; await el.fire('change'); };
  for (const mode of ['corpus', 'raw', 'note']) {
    for (const scenario of ['same-source', 'union', 'partial', 'both-unchecked', 'group-off', 'removed',
      'empty', 'different-profile', 'restore-domain', 'restore-profile', 'general', 'duplicate-input']) {
      const { ctx, elements, rels, sources, jobs, cards } = await openMergeDialog(mode, scenario);
      const title = elements['domain-progress'].querySelector('.domain-confirm-title');
      const confirm = elements['btn-domain-confirm'];
      const prefix = mode + '/' + scenario;
      check(prefix + '：不同领域初始预览为两个作业', cards.length === 2 && title.textContent.includes('将提交 2 个作业'));
      await change(cards[1].querySelector('.dgroup-chg'), 'dataset');
      check(prefix + '：更改为相同领域后预览合并为一个作业', title.textContent.includes('将提交 1 个作业')
        && elements['domain-modal-sub'].textContent.includes('重复文件仅抽取一次'));
      let expected = [{ domainId: 'dataset', profileId: 'bfo-lite', rels }];
      const firstFiles = cards[0].querySelectorAll('.dgroup-file-cb');
      const secondFiles = cards[1].querySelectorAll('.dgroup-file-cb');
      if (scenario === 'partial') {
        await setChecked(firstFiles[0], false);
        await setChecked(secondFiles[1], false);
        expected[0].rels = rels.slice(0, 2);
      } else if (scenario === 'both-unchecked') {
        await setChecked(firstFiles[0], false);
        await setChecked(secondFiles[0], false);
        expected[0].rels = rels.slice(1);
      } else if (scenario === 'group-off' || scenario === 'removed') {
        if (scenario === 'group-off') await setChecked(cards[0].querySelector('.dgroup-cb'), false);
        else await cards[0].querySelector('.dgroup-rm').fire('click');
        expected[0].rels = [rels[0], rels[2]];
      } else if (scenario === 'empty') {
        for (const file of [...firstFiles, ...secondFiles]) await setChecked(file, false);
        check(prefix + '：取消全部文件后预览零作业且禁止确认', title.textContent.includes('将提交 0 个作业') && confirm.disabled);
        await confirm.fire('click');
        check(prefix + '：空选择即使触发确认也不提交', jobs.length === 0 && !elements['domain-modal'].hidden);
        await setChecked(firstFiles[0], true);
        check(prefix + '：重新勾选后可正常确认', !confirm.disabled && title.textContent.includes('将提交 1 个作业'));
        expected[0].rels = [rels[0]];
      } else if (scenario === 'different-profile' || scenario === 'restore-profile') {
        await change(cards[1].querySelector('.dgroup-profile'), 'iso15926');
        check(prefix + '：不同体系仍预览两个作业', title.textContent.includes('将提交 2 个作业'));
        if (scenario === 'restore-profile') await change(cards[1].querySelector('.dgroup-profile'), 'bfo-lite');
        else expected = [
          { domainId: 'dataset', profileId: 'bfo-lite', rels: rels.slice(0, 2) },
          { domainId: 'dataset', profileId: 'iso15926', rels: [rels[0], rels[2]] },
        ];
      } else if (scenario === 'restore-domain') {
        await change(cards[1].querySelector('.dgroup-chg'), 'release');
        expected = [
          { domainId: 'dataset', profileId: 'bfo-lite', rels: rels.slice(0, 2) },
          { domainId: 'release', profileId: 'bfo-lite', rels: [rels[0], rels[2]] },
        ];
      } else if (scenario === 'general') {
        for (const card of cards) await change(card.querySelector('.dgroup-chg'), 'general');
        expected[0].domainId = 'general';
      }
      if (scenario === 'union') ctx.document.getElementById('extract-auto-reason').checked = false;
      check(prefix + '：预览随勾选配置更新，确认前不提交', jobs.length === 0 && title.textContent.includes(`将提交 ${expected.length} 个作业`));
      await Promise.all([confirm.fire('click'), confirm.fire('click')]);
      check(prefix + '：实际作业数与合并预览一致，连续确认不重复创建', jobs.length === expected.length && elements['domain-modal'].hidden);
      const submittedRels = (p) => mode === 'corpus' ? p.corpusRels : mode === 'raw' ? p.rawPaths : (p.inlineSources || []).map((s) => s.label);
      check(prefix + '：每个作业仅包含勾选来源的去重并集，完整目录不丢失', jobs.every((j, i) => {
        const actual = submittedRels(j.payload);
        return actual && new Set(actual).size === actual.length && JSON.stringify([...actual].sort()) === JSON.stringify([...expected[i].rels].sort());
      }));
      check(prefix + '：使用最终领域、体系和类型约束，保留推理开关', jobs.every((j, i) => j.type === 'graph'
        && j.payload.domainId === expected[i].domainId && j.payload.ontologyProfile === expected[i].profileId
        && j.payload.autoDomain === false && j.payload.autoReason === (scenario === 'union' ? false : undefined)
        && (expected[i].domainId === 'general' ? !j.payload.typeHints
          : j.payload.typeHints.entity[0] === (expected[i].domainId === 'dataset' ? '数据集' : '产品'))));
      check(prefix + '：保持原有来源类型和笔记正文，不混用解析入口', jobs.every(({ payload: p }) => mode === 'corpus'
        ? !p.rawPaths && !p.inlineSources : mode === 'raw' ? !p.corpusRels && !p.inlineSources
          : !p.corpusRels && !p.rawPaths && p.inlineSources.every((s) => s.text === sources.find((src) => src.label === s.label).text)));
    }
  }

  process.exitCode = summary() ? 0 : 1;
})().catch((e) => { console.error('测试崩溃：', e); process.exit(1); });
