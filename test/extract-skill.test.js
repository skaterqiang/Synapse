// 抽取技能（kind: extract）测试 —— 语料流水线设计 §5、§10.3、§15 问题1b
// 覆盖：frontmatter 8 字段解析（readSkill）与存量缺陷回归（CRLF / toInt('') / 通配）、
//      selectExtractSkills 三条规则、seedSampleSkills 植入、mode:script「文件交接」(P12)。
// 内置示例技能（extract-*）在工作区级 skills/：存在则校验，缺失则跳过（不阻断 CI）。
// 运行：node test/extract-skill.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { bootEnv, mkCheck } = require('./helpers/harness');

const { check, section, summary } = mkCheck('抽取技能（kind:extract）');

// 写一个技能目录：dir/SKILL.md(+可选 scripts/main.js)，返回 dir
function writeSkill(root, name, fmText, body, entryScript) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const nl = fmText.__crlf ? '\r\n' : '\n';
  const fm = fmText.lines.join(nl);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---${nl}${fm}${nl}---${nl}${body || ''}`, 'utf8');
  if (entryScript) {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts', entryScript.file), entryScript.code, 'utf8');
  }
  return dir;
}

(async () => {
  const env = await bootEnv({ prefix: 'synapse-extract-skill-' });
  const skillsMod = require('../src/main/skills/skills');
  const { readSkill, parseAccepts, parseBool } = skillsMod;
  const { selectExtractSkills } = require('../src/main/skills/select');
  const { seedSampleSkills } = require('../src/main/skills/skillSeed');
  const fixtures = path.join(env.dir, 'fixtures');
  fs.mkdirSync(fixtures, { recursive: true });

  // ---------- 1. readSkill：完整 8 字段 ----------
  section('readSkill · 完整 frontmatter');
  const full = writeSkill(fixtures, 'pdf-table-extract', { lines: [
    'name: pdf-table-extract',
    'description: 从扫描版 PDF 与表格截图抽取结构化 Markdown',
    'kind: extract',
    'accepts: [pdf, png, JPG, .jpeg]',
    'mode: script',
    'entry: scripts/extract.js',
    'priority: 60',
    'version: 1.2.0',
    'enabled: false',
    'timeoutSec: 300',
    'output: out.md',
  ] }, '\n正文即 README\n', { file: 'extract.js', code: 'module.exports.run=async()=>({markdown:"x"});' });
  const rf = readSkill(full);
  check('ok', rf.ok === true, rf.error);
  check('kind=extract', rf.kind === 'extract', rf.kind);
  check('accepts 规范化（小写去点，含 JPEG）', JSON.stringify(rf.accepts) === JSON.stringify(['pdf', 'png', 'jpg', 'jpeg']), JSON.stringify(rf.accepts));
  check('mode=script', rf.mode === 'script', rf.mode);
  check('entry 保留相对路径', rf.entry === 'scripts/extract.js', rf.entry);
  check('priority=60', rf.priority === 60, rf.priority);
  check('version=1.2.0', rf.version === '1.2.0', rf.version);
  check('enabled=false', rf.enabled === false, rf.enabled);
  check('timeoutSec=300', rf.timeoutSec === 300, rf.timeoutSec);
  check('output=out.md', rf.output === 'out.md', rf.output);
  check('instructions = 正文（不含 frontmatter）', /README/.test(rf.instructions) && !/^kind:/.test(rf.instructions), rf.instructions.slice(0, 20));

  // ---------- 2. readSkill：老技能缺省 ----------
  section('readSkill · 缺省值与存量缺陷回归');
  const legacy = writeSkill(fixtures, 'legacy', { lines: ['name: legacy', 'description: 老指令技能'] }, '老的说明正文');
  const rl = readSkill(legacy);
  check('缺省 kind=instructions', rl.kind === 'instructions', rl.kind);
  check('缺省 accepts=null', rl.accepts === null, JSON.stringify(rl.accepts));
  check('缺省 mode=llm', rl.mode === 'llm', rl.mode);
  check('缺省 entry=scripts/main.js', rl.entry === 'scripts/main.js', rl.entry);
  check('缺省 priority=50', rl.priority === 50, rl.priority);
  check('缺省 version=0.0.0', rl.version === '0.0.0', rl.version);
  check('缺省 timeoutSec=0', rl.timeoutSec === 0, rl.timeoutSec);
  check('缺省 enabled=true', rl.enabled === true, rl.enabled);

  // CRLF 行尾仍能解析（§5.36 存量缺陷：旧正则无 \r? 导致整块当正文）
  const crlf = writeSkill(fixtures, 'crlf-skill', { lines: ['name: crlf-skill', 'description: CRLF 技能', 'kind: extract', 'accepts: [md]', 'priority: 70'], __crlf: true }, '正文');
  const rc = readSkill(crlf);
  check('CRLF：kind 解析出来（非缺省）', rc.kind === 'extract', rc.kind);
  check('CRLF：name 未被退化为目录名之外的空值', rc.name === 'crlf-skill', rc.name);
  check('CRLF：accepts=[md]', JSON.stringify(rc.accepts) === JSON.stringify(['md']), JSON.stringify(rc.accepts));

  // toInt('') → 缺省 50 而非 0（§5.36：Number('')===0 会让 priority 变 0）
  const emptyPri = writeSkill(fixtures, 'empty-pri', { lines: ['name: empty-pri', 'kind: extract', 'priority:'] }, 'b');
  check('priority 留空回退 50（非 0）', readSkill(emptyPri).priority === 50, readSkill(emptyPri).priority);
  const emptyTo = writeSkill(fixtures, 'empty-to', { lines: ['name: empty-to', 'kind: extract', 'mode: script', 'timeoutSec:'] }, 'b', { file: 'main.js', code: 'module.exports.run=async()=>({markdown:"x"});' });
  check('timeoutSec 留空回退 0', readSkill(emptyTo).timeoutSec === 0, readSkill(emptyTo).timeoutSec);

  check('parseAccepts 空→null', parseAccepts('') === null);
  check('parseAccepts 去点去空白', JSON.stringify(parseAccepts('[ PDF , .docx ]')) === JSON.stringify(['pdf', 'docx']), JSON.stringify(parseAccepts('[ PDF , .docx ]')));
  check('parseBool 各种假值', ['false', 'no', 'off', '0'].every((v) => parseBool(v, true) === false));
  check('parseBool 缺省', parseBool('', true) === true && parseBool('', false) === false);

  // ---------- 3. selectExtractSkills 三条规则 ----------
  section('selectExtractSkills');
  const S = (name, extra) => ({ name, enabled: true, ...extra });
  const mk = 'M';
  const list = [
    S('instr-skill', { kind: 'instructions', accepts: ['pdf'] }),        // 规则1：指令永不入选
    S('off-skill', { kind: 'extract', enabled: false, accepts: ['pdf'] }), // 停用不入选
    S('wild', { kind: 'extract', accepts: null, priority: 50 }),          // 通配兜底
    S('pdf-hi', { kind: 'extract', accepts: ['pdf'], priority: 80 }),
    S('pdf-lo', { kind: 'extract', accepts: ['pdf'], priority: 60 }),
    S('dotpdf', { kind: 'extract', accepts: ['.PDF'], priority: 70 }),    // 大小写/点归一
  ];
  const onlyNames = (arr) => arr.map((k) => k.name);
  check('规则1 过滤指令技能', !onlyNames(selectExtractSkills({ skills: list }, 'pdf')).includes('instr-skill'));
  check('停用技能不入选', !onlyNames(selectExtractSkills({ skills: list }, 'pdf')).includes('off-skill'));
  check('pdf 命中全部 extract+通配，按 priority 降序', JSON.stringify(onlyNames(selectExtractSkills({ skills: list, extractSkillTopN: 9 }, 'pdf'))) === JSON.stringify(['pdf-hi', 'dotpdf', 'pdf-lo', 'wild']), JSON.stringify(onlyNames(selectExtractSkills({ skills: list, extractSkillTopN: 9 }, 'pdf'))));
  check('规则3 默认只取 1 个（topN 缺省=1）', selectExtractSkills({ skills: list }, 'pdf').length === 1);
  check('topN=2 取前两个', selectExtractSkills({ skills: list, extractSkillTopN: 2 }, 'pdf').length === 2);
  check('无 accepts 的其它扩展名走通配', onlyNames(selectExtractSkills({ skills: list, extractSkillTopN: 9 }, 'docx')).join(',') === 'wild');
  check('.pdf 带点也能匹配', selectExtractSkills({ skills: list }, '.pdf')[0].name === 'pdf-hi');
  const tieA = S('aaa', { kind: 'extract', accepts: ['zip'], priority: 50 });
  const tieB = S('bbb', { kind: 'extract', accepts: ['zip'], priority: 50 });
  check('同优先级按名字升序', selectExtractSkills({ skills: [tieB, tieA], extractSkillTopN: 9 }, 'zip').map((k) => k.name).join(',') === 'aaa,bbb');
  check('无启用抽取技能返回空', selectExtractSkills({ skills: [] }, 'pdf').length === 0);

  // ---------- 4. seedSampleSkills ----------
  section('seedSampleSkills');
  writeSkill(fixtures, 'seed-a', { lines: ['name: seed-a', 'description: A', 'kind: extract', 'accepts: [txt]'] }, 'A 正文');
  writeSkill(fixtures, 'seed-b', { lines: ['name: seed-b', 'kind: extract', 'enabled: false'] }, 'B 正文', { file: 'main.js', code: 'module.exports.run=async()=>({markdown:"x"});' });
  let store = { skills: [{ name: 'seed-a', dir: 'pre', kind: 'instructions', enabled: true }] };
  const settingsMod = { getSettings: () => store, saveSettings: (s) => { store = s; } };
  seedSampleSkills(settingsMod, fixtures);
  const seededA = store.skills.find((k) => k.name === 'seed-a');
  const seededB = store.skills.find((k) => k.name === 'seed-b');
  check('已存在同名不重复植入（seed-a 保留原对象）', seededA.dir === 'pre' && store.skills.filter((k) => k.name === 'seed-a').length === 1);
  check('seed-b 被植入', !!seededB && seededB.kind === 'extract', JSON.stringify(seededB && seededB.kind));
  check('seed-b enabled=false 由 frontmatter 表达', seededB && seededB.enabled === false, seededB && String(seededB.enabled));
  check('植入项带 dir 指向目录', !!seededB && seededB.dir === path.join(fixtures, 'seed-b'), seededB && seededB.dir);
  check('一次性守卫置位', store.__seededSampleSkills === true);
  const before = JSON.stringify(store);
  seedSampleSkills(settingsMod, fixtures);
  check('第二次调用因守卫而不改动', JSON.stringify(store) === before);

  // ---------- 5. mode: script「文件交接」(P12) ----------
  section('mode:script 文件交接（SkillMarkdownDecorator.runScript）');
  const { SkillMarkdownDecorator } = require('../src/main/corpus/decorators/parse');
  const scriptDir = writeSkill(fixtures, 'handoff', { lines: ['name: handoff', 'kind: extract', 'mode: script', 'entry: scripts/main.js', 'version: 2.0.0'] }, 'README',
    { file: 'main.js', code: 'module.exports.run = async ({ inputPath, outputDir }) => {\n  const fs=require("fs"),path=require("path");\n  const head = fs.existsSync(inputPath)?("读取到 "+fs.readFileSync(inputPath,"utf8")):"(无输入)";\n  return { markdown: "# 产物\\n"+head };\n};' });
  const inputAbs = path.join(env.dir, 'sample-input.txt');
  fs.writeFileSync(inputAbs, 'HELLO', 'utf8');
  const dec = new SkillMarkdownDecorator(null, {});
  const skillObj = { name: 'handoff', dir: scriptDir, kind: 'extract', mode: 'script', entry: 'scripts/main.js', enabled: true, priority: 50, version: '2.0.0', timeoutSec: 60, output: '' };
  const ctx = { settings: { extractSkillTimeoutSec: 120 }, errors: [], shared: {}, stats: {}, onLog: () => {}, signal: null };
  const item = { kind: 'raw', label: '样本', origin: { name: 'sample-input.txt', path: 'local:' + inputAbs }, bytes: Buffer.from('HELLO') };
  const out = await dec.runScript(item, ctx, skillObj, inputAbs, 'txt');
  check('返回文本 = 脚本产出的 Markdown', out && /# 产物/.test(out.text) && /HELLO/.test(out.text), out && out.text);
  check('meta.parseMethod=skill', out.meta && out.meta.parseMethod === 'skill', JSON.stringify(out.meta));
  check('meta.skill.mode=script 且带版本', out.meta.skill && out.meta.skill.mode === 'script' && out.meta.skill.version === '2.0.0', JSON.stringify(out.meta.skill));
  check('透传后不留 bytes', out.bytes === undefined);
  const runnerMod = require('../src/main/skills/runner');
  check('交接文件 corpus-out.md 读后已删除（不污染 artifacts/）', !fs.existsSync(path.join(runnerMod.artifactsDir(), 'corpus-out.md')));

  // 自定义 output 文件名
  const skillObj2 = { ...skillObj, output: 'custom-result.md' };
  const out2 = await dec.runScript(item, ctx, skillObj2, inputAbs, 'txt');
  check('output 指定文件名生效', out2 && /# 产物/.test(out2.text));
  check('自定义交接文件读后已删除', !fs.existsSync(path.join(runnerMod.artifactsDir(), 'custom-result.md')));

  // 失败路径：入口不存在
  const badSkill = { ...skillObj, dir: path.join(fixtures, 'no-such'), entry: 'scripts/nope.js' };
  let threw = '';
  try { await dec.runScript(item, ctx, badSkill, inputAbs, 'txt'); } catch (e) { threw = e.message; }
  check('入口不存在 → 明确抛错', /入口不存在/.test(threw), threw);
  // 失败路径：脚本返回空 Markdown
  const emptyDir = writeSkill(fixtures, 'empty-out', { lines: ['name: empty-out', 'kind: extract', 'mode: script', 'entry: scripts/main.js'] }, 'x', { file: 'main.js', code: 'module.exports.run = async () => ({ markdown: "   " });' });
  let threw2 = '';
  try { await dec.runScript(item, ctx, { ...skillObj, dir: emptyDir }, inputAbs, 'txt'); } catch (e) { threw2 = e.message; }
  check('空 Markdown → 抛错', /Markdown 为空/.test(threw2), threw2);

  // ---------- 6. 显式指定 skill（ctx.skillName）覆盖自动匹配 ----------
  section('显式指定 skill 覆盖扩展名自动匹配');
  const { findExtractSkill } = require('../src/main/skills/select');
  const hiPdf = { name: 'hi-pdf', kind: 'extract', enabled: true, accepts: ['pdf'], priority: 100, mode: 'llm', version: '1.0.0' };
  const loPdf = { name: 'lo-pdf', kind: 'extract', enabled: true, accepts: ['pdf'], priority: 10, mode: 'llm', version: '1.0.0' };
  const wild = { name: 'wild', kind: 'extract', enabled: true, accepts: null, priority: 50, mode: 'llm', version: '1.0.0' };
  const offSkill = { name: 'off', kind: 'extract', enabled: false, accepts: ['pdf'], priority: 50, mode: 'llm', version: '1.0.0' };
  const cfg = { skills: [hiPdf, loPdf, wild, offSkill] };
  check('findExtractSkill 命中并校验扩展名', findExtractSkill(cfg, 'hi-pdf', 'pdf') === hiPdf);
  check('findExtractSkill 不匹配扩展名返回 null', findExtractSkill(cfg, 'hi-pdf', 'docx') === null);
  check('findExtractSkill 未启用返回 null', findExtractSkill(cfg, 'off', 'pdf') === null);
  check('findExtractSkill 名称不存在返回 null', findExtractSkill(cfg, 'none', 'pdf') === null);
  check('findExtractSkill 空名称返回 null', findExtractSkill(cfg, '', 'pdf') === null);

  const txtDir = writeSkill(fixtures, 'txt-forced', { lines: ['name: txt-forced', 'kind: extract', 'mode: script', 'entry: scripts/main.js', 'accepts: [txt]', 'version: 3.0.0'] }, 'x',
    { file: 'main.js', code: 'module.exports.run = async ({ inputPath, outputDir }) => { const fs=require("fs"),p=require("path"); fs.writeFileSync(p.join(outputDir,"corpus-out.md"),"# 强制技能"); return { markdown: "# 强制技能" }; };' });
  const pdfDir = writeSkill(fixtures, 'pdf-auto', { lines: ['name: pdf-auto', 'kind: extract', 'mode: script', 'entry: scripts/main.js', 'accepts: [pdf]', 'version: 4.0.0'] }, 'x',
    { file: 'main.js', code: 'module.exports.run = async ({ inputPath, outputDir }) => { const fs=require("fs"),p=require("path"); fs.writeFileSync(p.join(outputDir,"corpus-out.md"),"# 自动技能"); return { markdown: "# 自动技能" }; };' });
  const txtSkill = { name: 'txt-forced', dir: txtDir, kind: 'extract', mode: 'script', entry: 'scripts/main.js', accepts: ['txt'], enabled: true, priority: 50, version: '3.0.0', timeoutSec: 60, output: '' };
  const pdfSkill = { name: 'pdf-auto', dir: pdfDir, kind: 'extract', mode: 'script', entry: 'scripts/main.js', accepts: ['pdf'], enabled: true, priority: 50, version: '4.0.0', timeoutSec: 60, output: '' };
  const txtAbs = path.join(env.dir, 'forced.txt');
  fs.writeFileSync(txtAbs, 'TXT', 'utf8');
  const decForced = new SkillMarkdownDecorator(null, {});
  const ctxForced = { settings: { apiBaseUrl: 'http://127.0.0.1:11434', skills: [txtSkill, pdfSkill], extractSkillTimeoutSec: 120 }, errors: [], shared: {}, stats: {}, onLog: () => {}, signal: null, skillName: 'txt-forced' };
  const itemForced = { kind: 'raw', label: '强制样本', origin: { name: 'forced.txt', path: 'local:' + txtAbs }, bytes: Buffer.from('TXT') };
  check('ctx.skillName 不匹配扩展名时 accepts 返回 false', !decForced.accepts(itemForced, { ...ctxForced, skillName: 'pdf-auto' }));
  check('ctx.skillName 匹配扩展名时 accepts 返回 true', decForced.accepts(itemForced, ctxForced));
  const outForced = await decForced.apply(itemForced, ctxForced);
  check('强制指定 skill 覆盖自动匹配结果', outForced && /强制技能/.test(outForced.text) && outForced.meta.skill.name === 'txt-forced');
  check('强制指定 skill 不匹配时回退自动匹配', async () => {
    const out = await decForced.apply(itemForced, { ...ctxForced, skillName: 'pdf-auto' });
    return out && /自动技能/.test(out.text) && out.meta.skill.name === 'pdf-auto';
  });

  // ---------- 7. 内置示例技能（工作区级 skills/，缺失则跳过） ----------
  section('内置示例技能（随环境，缺失跳过）');
  const { DEFAULT_SKILLS_DIR } = require('../src/main/skills/skillSeed');
  const expectBuiltin = {
    'extract-markdown': { kind: 'extract', accepts: null, mode: 'llm', enabled: true },
    'extract-table': { kind: 'extract', accepts: ['xlsx', 'xls', 'csv'], mode: 'llm', enabled: true },
    'extract-slide': { kind: 'extract', accepts: ['pptx'], mode: 'llm', enabled: true },
    'extract-ocr': { kind: 'extract', accepts: ['png', 'jpg', 'jpeg', 'tiff'], mode: 'script', enabled: false },
  };
  let found = 0;
  for (const [name, exp] of Object.entries(expectBuiltin)) {
    const dir = path.join(DEFAULT_SKILLS_DIR, name);
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) { console.log(`  ⏭ ${name}（工作区 skills/ 未内置，跳过）`); continue; }
    found++;
    const r = readSkill(dir);
    check(`${name} kind=extract`, r.kind === exp.kind, r.kind);
    check(`${name} accepts 正确`, JSON.stringify(r.accepts) === JSON.stringify(exp.accepts), JSON.stringify(r.accepts));
    check(`${name} mode=${exp.mode}`, r.mode === exp.mode, r.mode);
    check(`${name} enabled=${exp.enabled}`, r.enabled === exp.enabled, String(r.enabled));
    if (name === 'extract-ocr') check('extract-ocr 入口脚本存在', fs.existsSync(path.join(dir, r.entry || 'scripts/extract.js')), r.entry);
  }
  if (found === 0) console.log('  （未找到任何内置技能，环境相关，不计失败）');

  process.exitCode = summary() ? 0 : 1;
})().catch((e) => { console.error('测试崩溃：', e); process.exit(1); });
