// 技能在线安装回归测试：node test/skill-install.test.js
// 覆盖：npx skills add 命令 / skills.sh 链接 / GitHub 仓库 / 简写 的解析；
// 离线端到端安装（fetch 打桩）：指定技能、整库、main→master 回退、重名去重。
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');

// paths 依赖 electron：在 skillInstall 懒加载前替换 dataRoot 指向临时目录
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-skilltest-'));
const pathsMod = require('../src/main/common/paths');
pathsMod.dataRoot = () => tmpRoot;

const { parseSkillSource, installSkill } = require('../src/main/skills/skillInstall');

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' → ' + detail : ''}`); }
}

// fetch 打桩：url → { status, buffer }；同时提供流式 body 以覆盖进度推送路径
let fetchMap = {};
function stubStream(buf) {
  const chunk = 64 * 1024;
  let off = 0;
  return new ReadableStream({
    pull(c) {
      if (off >= buf.length) { c.close(); return; }
      c.enqueue(buf.subarray(off, off + chunk));
      off += chunk;
    },
  });
}
global.fetch = async (url) => {
  const hit = fetchMap[String(url)];
  if (!hit) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
  return {
    ok: hit.status === 200,
    status: hit.status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-length' ? String(hit.buffer.length) : null) },
    body: stubStream(hit.buffer),
    arrayBuffer: async () => hit.buffer,
  };
};

async function makeZip(entries) {
  const zip = new JSZip();
  for (const [rel, text] of Object.entries(entries)) zip.file(rel, text);
  return Buffer.from(await zip.generateAsync({ type: 'arraybuffer' }));
}

const SKILL_DOCX = `---\nname: docx\ndescription: 生成 Word 文档时使用\n---\n\n正文指令：用 docx 库生成文档。\n`;
const SKILL_PDF = `---\nname: pdf\ndescription: 处理 PDF 时使用\n---\n\nPDF 指令。\n`;

(async () => {
  console.log('\n【1】输入解析');
  let p = parseSkillSource('npx skills add https://github.com/anthropics/skills --skill docx');
  check('npx 命令解析 owner/repo', p.ok && p.owner === 'anthropics' && p.repo === 'skills', JSON.stringify(p));
  check('npx --skill 提取', p.ok && p.skills.join() === 'docx', JSON.stringify(p.skills));

  p = parseSkillSource('npx skills add https://github.com/anthropics/skills --skill docx --skill pdf');
  check('多个 --skill', p.ok && p.skills.join() === 'docx,pdf', JSON.stringify(p.skills));

  p = parseSkillSource('https://www.skills.sh/anthropics/skills/docx');
  check('skills.sh 技能页', p.ok && p.owner === 'anthropics' && p.repo === 'skills' && p.skills.join() === 'docx', JSON.stringify(p));

  p = parseSkillSource('https://skills.sh/owner/repo');
  check('skills.sh 仓库页（整库）', p.ok && p.owner === 'owner' && p.repo === 'repo' && !p.skills.length, JSON.stringify(p));

  p = parseSkillSource('https://github.com/owner/repo/tree/v2');
  check('GitHub tree ref', p.ok && p.ref === 'v2', JSON.stringify(p));

  p = parseSkillSource('owner/repo');
  check('简写 owner/repo', p.ok && p.owner === 'owner' && p.repo === 'repo', JSON.stringify(p));

  p = parseSkillSource('随便一段话');
  check('非法输入报错', !p.ok, JSON.stringify(p));

  console.log('\n【2】指定技能安装（npx 命令，离线打桩）');
  const buf = await makeZip({
    'skills-main/skills/docx/SKILL.md': SKILL_DOCX,
    'skills-main/skills/docx/scripts/gen.js': 'console.log(1)',
    'skills-main/skills/pdf/SKILL.md': SKILL_PDF,
    'skills-main/README.md': 'readme',
  });
  fetchMap = { 'https://codeload.github.com/anthropics/skills/zip/refs/heads/main': { status: 200, buffer: buf } };
  let r = await installSkill(null, { input: 'npx skills add https://github.com/anthropics/skills --skill docx' });
  check('安装成功', r.ok, r.error);
  check('仅安装 docx', r.ok && r.installed.length === 1 && r.installed[0].name === 'docx', JSON.stringify(r.installed));
  check('SKILL.md 落盘', r.ok && fs.existsSync(path.join(r.installed[0].dir, 'SKILL.md')));
  check('子目录脚本落盘', r.ok && fs.existsSync(path.join(r.installed[0].dir, 'scripts', 'gen.js')));
  check('frontmatter 描述解析', r.ok && /Word/.test(r.installed[0].description), JSON.stringify(r.installed));

  console.log('\n【3】整库安装（GitHub URL）');
  r = await installSkill(null, { input: 'https://github.com/anthropics/skills' });
  check('整库安装两个技能', r.ok && r.installed.length === 2, JSON.stringify(r.installed && r.installed.map((x) => x.name)));

  console.log('\n【4】重名去重（再装一次 docx，此前已有 docx / docx (2)）');
  r = await installSkill(null, { input: 'npx skills add https://github.com/anthropics/skills --skill docx' });
  check('重名目录加后缀', r.ok && /docx \(3\)/.test(r.installed[0].dir), r.installed && r.installed[0].dir);

  console.log('\n【5】main→master 回退');
  const buf2 = await makeZip({ 'skills-master/my-skill/SKILL.md': '---\nname: my-skill\ndescription: t\n---\nbody\n' });
  fetchMap = { 'https://codeload.github.com/o/r/zip/refs/heads/master': { status: 200, buffer: buf2 } };
  r = await installSkill(null, { input: 'o/r' });
  check('main 404 后回退 master 成功', r.ok && r.installed[0].name === 'my-skill', r.error);

  console.log('\n【6】仓库无技能报错');
  const buf3 = await makeZip({ 'repo-main/README.md': 'x' });
  fetchMap = { 'https://codeload.github.com/e/m/zip/refs/heads/main': { status: 200, buffer: buf3 } };
  r = await installSkill(null, { input: 'e/m' });
  check('无 SKILL.md 报错', !r.ok && /SKILL.md/.test(r.error), JSON.stringify(r));

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
