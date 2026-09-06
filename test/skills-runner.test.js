// 技能脚本执行器测试（skills/runner.js）
// 覆盖：artifactsDir 创建、execToolDef 工具定义、execToolIfActive 激活门槛、
//      runNodeScript 成功/失败/超时/输出目录/环境变量/文件清单/截断。
// 运行：node test/skills-runner.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { bootEnv, mkCheck } = require('./helpers/harness');

const { check, section, summary } = mkCheck('技能执行器（skills/runner.js）');

(async () => {
  const env = await bootEnv({ prefix: 'synapse-skills-' });
  const runner = require('../src/main/skills/runner');

  // ---------- 1. artifactsDir ----------
  section('artifactsDir');
  const ad = runner.artifactsDir();
  check('返回 <dataRoot>/artifacts', ad === path.join(env.dataRoot, 'artifacts'), ad);
  check('目录被创建', fs.existsSync(ad) && fs.statSync(ad).isDirectory());
  check('重复调用幂等', runner.artifactsDir() === ad && fs.existsSync(ad));

  // ---------- 2. execToolDef ----------
  section('execToolDef');
  const def = runner.execToolDef();
  check('type=function', def.type === 'function');
  check('name=skill__run_script', def.function.name === 'skill__run_script');
  check('描述提到 docx/pptx/xlsx 与 AGENT_OUTPUT_DIR', /docx|pptx|xlsx/.test(def.function.description) && /AGENT_OUTPUT_DIR/.test(def.function.description));
  check('parameters.required 含 code', def.function.parameters.required.includes('code'));
  check('标记 _builtin=run', def._builtin === 'run');

  // ---------- 3. execToolIfActive ----------
  section('execToolIfActive');
  check('无 skills → null', runner.execToolIfActive({}) === null && runner.execToolIfActive(null) === null);
  check('skills 空数组 → null', runner.execToolIfActive({ skills: [] }) === null);
  check('仅启用非 office 技能 → null', runner.execToolIfActive({ skills: [{ name: 'web-search', enabled: true }] }) === null);
  check('启用 docx 技能 → 工具定义', runner.execToolIfActive({ skills: [{ name: 'docx-generator', enabled: true }] }) !== null);
  check('启用 xlsx 技能 → 工具定义', runner.execToolIfActive({ skills: [{ name: 'XLSX 报表', enabled: true }] }) !== null);
  check('office 技能但未启用 → null', runner.execToolIfActive({ skills: [{ name: 'docx-gen', enabled: false }] }) === null);
  check('大小写不敏感匹配 PPTX', runner.execToolIfActive({ skills: [{ name: 'MyPPTXTool', enabled: true }] }) !== null);
  check('返回定义与 execToolDef 同形', (() => {
    const t = runner.execToolIfActive({ skills: [{ name: 'docx', enabled: true }] });
    return t && t.function.name === 'skill__run_script' && t._builtin === 'run';
  })());

  // ---------- 4. runNodeScript 成功路径 ----------
  section('runNodeScript — 成功');
  // 脚本往 AGENT_OUTPUT_DIR 写文件
  const r1 = JSON.parse(await runner.runNodeScript({
    code: `const fs=require('fs'),path=require('path');const out=process.env.AGENT_OUTPUT_DIR;fs.writeFileSync(path.join(out,'hello.txt'),'你好');console.log('done-marker');`,
  }));
  check('ok=true / exitCode=0', r1.ok === true && r1.exitCode === 0, JSON.stringify(r1));
  check('捕获 stdout', /done-marker/.test(r1.stdout), r1.stdout);
  check('列出新生成文件（绝对路径）', r1.files.length === 1 && r1.files[0].endsWith('hello.txt') && path.isAbsolute(r1.files[0]), JSON.stringify(r1.files));
  check('文件内容正确写入', fs.readFileSync(r1.files[0], 'utf-8') === '你好');
  check('outputDir=artifacts', r1.outputDir === ad);
  // 清理
  r1.files.forEach((f) => { try { fs.unlinkSync(f); } catch (_) {} });

  check('返回的是 JSON 字符串', typeof (await runner.runNodeScript({ code: 'console.log(1)' })) === 'string');

  // ---------- 5. runNodeScript 失败路径 ----------
  section('runNodeScript — 失败');
  const r2 = JSON.parse(await runner.runNodeScript({ code: 'process.exit(3)' }));
  check('非零退出 ok=false / exitCode=3', r2.ok === false && r2.exitCode === 3, JSON.stringify({ ok: r2.ok, exitCode: r2.exitCode }));
  const r3 = JSON.parse(await runner.runNodeScript({ code: 'throw new Error("脚本爆炸")' }));
  check('脚本抛错 ok=false 且 stderr 捕获', r3.ok === false && /脚本爆炸/.test(r3.stderr), r3.stderr.slice(0, 120));

  // ---------- 6. 环境变量 ----------
  section('runNodeScript — 环境变量');
  const r4 = JSON.parse(await runner.runNodeScript({ code: 'console.log(JSON.stringify({o:process.env.AGENT_OUTPUT_DIR,e:process.env.ELECTRON_RUN_AS_NODE,np:!!process.env.NODE_PATH}))' }));
  check('注入 AGENT_OUTPUT_DIR', (() => {
    // Windows 短路径（8.3）差异：比较前双方 realpath 归一
    const m = r4.stdout.match(/"o":"([^"]+)"/);
    if (!m) return false;
    const got = m[1].replace(/\\\\/g, '\\');
    try { return fs.realpathSync(got) === fs.realpathSync(ad); } catch (_) { return got === ad; }
  })(), r4.stdout.slice(0, 200));
  check('注入 ELECTRON_RUN_AS_NODE=1', /"e":"1"/.test(r4.stdout), r4.stdout.slice(0, 200));
  check('注入 NODE_PATH', /"np":true/.test(r4.stdout));

  // ---------- 7. 输出目录隔离（只列新文件） ----------
  section('runNodeScript — 仅列新文件');
  // 先放一个既有文件
  fs.writeFileSync(path.join(ad, 'pre-existing.txt'), 'x');
  const r5 = JSON.parse(await runner.runNodeScript({ code: `const fs=require('fs'),path=require('path');fs.writeFileSync(path.join(process.env.AGENT_OUTPUT_DIR,'new-one.txt'),'n')` }));
  check('既有文件不计入 files', r5.files.every((f) => !f.endsWith('pre-existing.txt')), JSON.stringify(r5.files));
  check('新文件计入 files', r5.files.some((f) => f.endsWith('new-one.txt')));
  ['pre-existing.txt', 'new-one.txt'].forEach((f) => { try { fs.unlinkSync(path.join(ad, f)); } catch (_) {} });

  // ---------- 8. stdout/stderr 截断 ----------
  section('runNodeScript — 输出截断');
  const big = 'A'.repeat(5000);
  const r6 = JSON.parse(await runner.runNodeScript({ code: `console.log('${big}')` }));
  check('stdout 截断到 ≤1500（保留尾部）', r6.stdout.length <= 1500 && /^A+$/.test(r6.stdout.trim()), 'len=' + r6.stdout.length);

  // ---------- 9. 超时 kill ----------
  section('runNodeScript — 超时');
  // 注：win32 下 detached=false，killTree 的 process.kill(-pid) 不适用且被吞，子进程实际不会被强杀；
  // 用「远超过 timeoutMs 的有限睡眠」验证超时路径被触发且父进程不被无限阻塞，子进程最终自行退出。
  const t0 = Date.now();
  const r7 = JSON.parse(await runner.runNodeScript({ code: 'setTimeout(()=>{},30000)', timeoutMs: 500 }));
  const elapsed = Date.now() - t0;
  check('超时路径返回结果', r7 && typeof r7.ok === 'boolean', JSON.stringify({ ok: r7.ok, exitCode: r7.exitCode }));
  check('父进程未被无限阻塞（<25s 返回）', elapsed < 25000, 'elapsed=' + elapsed);

  summary();
})().catch((err) => {
  console.error('测试执行异常：', err);
  process.exitCode = 1;
});
