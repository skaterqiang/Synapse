// 语料抽取·指定 skill 测试
// 覆盖：pickExtractSkill 选择逻辑、extractRawCorpus/Batch/reExtractCorpus 提交 payload 携带 skillName。
// 运行：node test/corpus-extract-skill.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { bootEnv, mkCheck, writeFile } = require('./helpers/harness');

const { check, section, summary } = mkCheck('语料抽取·指定 skill');

(async () => {
  const env = await bootEnv({ prefix: 'synapse-corpus-skill-' });

  section('pickExtractSkill：无技能时直接返回空字符串');
  const scripts = ['web/kb-shim.js', 'src/renderer/raws.js', 'src/renderer/corpus.js']
    .map((rel) => ({ rel, code: fs.readFileSync(path.join(env.repoRoot, rel), 'utf8') }));
  let selectCalls = [];
  let submitted = [];
  const ctxBase = {
    state: { settings: { pipeline: true, skills: [] } },
    toast: () => {},
    showJobsView: () => {},
    askSelect: (...args) => { selectCalls.push(args); return Promise.resolve('extract-table'); },
    fetch: async (url, options) => {
      const channel = decodeURIComponent(url.slice('/api/call/'.length));
      const payload = JSON.parse(options.body);
      if (channel === 'jobs:submit') { submitted.push(payload); return { ok: true, json: async () => ({ result: { ok: true } }) }; }
      if (channel === 'corpus:read') return { ok: true, json: async () => ({ result: { ok: true, frontmatter: { source: { path: 'local:' + path.join(env.dir, payload.rel) } } } }) };
      return { ok: true, json: async () => ({ result: {} }) };
    },
    EventSource: class { constructor() {} },
    document: { querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ classList: { add: () => {} }, appendChild: () => {} }) },
    window: {
      addEventListener: () => {},
      kb: {
        jobsSubmit: (p) => { submitted.push(p); return Promise.resolve({ ok: true }); },
        corpusRead: ({ rel }) => Promise.resolve({ ok: true, frontmatter: { source: { path: 'local:' + path.join(env.dir, rel) } } }),
      },
    },
  };
  const runScript = (extra) => {
    selectCalls = [];
    submitted = [];
    const ctx = vm.createContext({ ...ctxBase, ...extra });
    for (const s of scripts) vm.runInContext(s.code, ctx, { filename: s.rel });
    return ctx;
  };

  let c = runScript({});
  let res = await c.pickExtractSkill('.xlsx');
  check('无抽取技能时不弹选择框并返回空', res === '' && selectCalls.length === 0);

  section('pickExtractSkill：有技能时弹出选择并按扩展名标记不匹配项');
  const skills = [
    { name: 'extract-table', kind: 'extract', enabled: true, accepts: ['xlsx', 'csv'], mode: 'llm' },
    { name: 'extract-slide', kind: 'extract', enabled: true, accepts: ['pptx'], mode: 'llm' },
    { name: 'extract-ocr', kind: 'extract', enabled: true, accepts: null, mode: 'script' },
    { name: 'disabled-skill', kind: 'extract', enabled: false, accepts: ['xlsx'], mode: 'llm' },
  ];
  c = runScript({ state: { settings: { pipeline: true, skills } } });
  res = await c.pickExtractSkill('.xlsx');
  check('返回用户所选 skill 名称', res === 'extract-table' && selectCalls.length === 1);
  const opts = selectCalls[0][1];
  check('首选项为自动匹配', opts[0].value === '' && opts[0].label.includes('自动匹配'));
  check('仅列出已启用的抽取技能', opts.length === 4 && opts.every((o) => o.value === '' || skills.some((k) => k.name === o.value)));
  check('xlsx 匹配的技能不带不匹配提示', opts.find((o) => o.value === 'extract-table').label.includes('xlsx') && !opts.find((o) => o.value === 'extract-table').label.includes('不匹配'));
  check('pptx 技能对 xlsx 显示不匹配提示', opts.find((o) => o.value === 'extract-slide').label.includes('不匹配'));
  check('通配技能不显示不匹配提示', !opts.find((o) => o.value === 'extract-ocr').label.includes('不匹配'));
  check('脚本技能带 [脚本] 提示', opts.find((o) => o.value === 'extract-ocr').label.includes('[脚本]'));

  section('extractRawCorpus / Batch / reExtractCorpus payload 携带 skillName');
  c = runScript({ state: { settings: { pipeline: true, skills } } });
  await c.extractRawCorpus('raw/AI数据知识引擎&AI知识库.xlsx');
  check('单文件抽取提交携带 skillName', submitted.length === 1 && submitted[0].payload.skillName === 'extract-table');

  c = runScript({ state: { settings: { pipeline: true, skills } }, confirm: () => true });
  await c.extractRawCorpusBatch(['raw/a.xlsx', 'raw/b.pptx'], '测试目录');
  check('批量抽取提交携带 skillName', submitted.length === 1 && submitted[0].payload.skillName === 'extract-table');

  c = runScript({ state: { settings: { pipeline: true, skills } } });
  await c.reExtractCorpus({ rel: 'AI数据知识引擎&AI知识库/AI数据知识引擎&AI知识库.md' });
  check('重新抽取提交携带 skillName 与 force', submitted.length === 1 && submitted[0].payload.skillName === 'extract-table' && submitted[0].payload.force === true);

  section('取消选择不提交作业');
  c = runScript({ state: { settings: { pipeline: true, skills } }, askSelect: () => Promise.resolve(null) });
  await c.extractRawCorpus('raw/AI数据知识引擎&AI知识库.xlsx');
  check('取消选择后没有提交任何作业', submitted.length === 0);

  section('选择「自动匹配」时 skillName 为空字符串');
  c = runScript({ state: { settings: { pipeline: true, skills } }, askSelect: () => Promise.resolve('') });
  await c.extractRawCorpus('raw/AI数据知识引擎&AI知识库.xlsx');
  check('自动匹配提交空 skillName', submitted.length === 1 && submitted[0].payload.skillName === '');

  process.exitCode = summary() ? 0 : 1;
})().catch((e) => { console.error('测试崩溃：', e); process.exit(1); });
