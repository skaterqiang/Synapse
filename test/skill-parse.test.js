// 技能解析口径回归：node test/skill-parse.test.js
// 验证「内置解析使用技能能力解析文档」语义：
//   ① png + 技能开 → 技能解析（模型直读）成功，parseMethod=skill
//   ② png + 技能关（开关/无技能）→ 报不支持并说明技能解析未生效
//   ③ txt + 技能开 → 技能解析产出（全覆盖口径）
//   ④ txt + 技能开但模型调用失败 → 静默回退内置解析，info.skillError 留痕
//   ⑤ 缓存：skill 产物落 skill 缓存并命中；关闭开关后视为未命中重提
//   ⑥ pdf + MinerU 开 + 技能开 → 仍走 MinerU（技能不抢 PDF 路由）
//   ⑦ pdf + MinerU 失败 + 技能开 → 技能解析兜底产出，缓存按回退口径落 fallback
//
// 方法：临时沙箱数据目录 + electron shim + 假 OpenAI 兼容 SSE 服务 + 假 MinerU 脚本
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const Module = require('module');

// ---------- 沙箱：HOME/appData 指向临时目录，数据根/缓存全部隔离 ----------
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-skillparse-'));
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;

const electronShim = {
  app: {
    isPackaged: false,
    getPath: (name) => {
      if (name === 'userData') return path.join(SANDBOX, 'userData');
      if (name === 'appData') return path.join(SANDBOX, 'appData');
      if (name === 'documents') return path.join(SANDBOX, 'Documents');
      throw new Error(`沙箱不支持 app.getPath('${name}')`);
    },
    getAppPath: () => path.join(SANDBOX, 'app'),
  },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return electronShim;
  return origLoad.call(this, request, ...rest);
};

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' → ' + detail : ''}`); }
}

// 假 OpenAI 兼容服务：流式返回固定 Markdown；failMode 时返回 400（不可重试，模拟模型调用失败）
let failMode = false;
const FAKE_MD = '# SKILL-PARSED\n\n技能解析产出内容';
function startFakeLlm() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
        res.writeHead(404); return res.end();
      }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (failMode) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end('{"error":"fake model failure"}'); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: FAKE_MD } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function main() {
  const llmSrv = await startFakeLlm();
  const llmUrl = `http://127.0.0.1:${llmSrv.address().port}`;

  // 假 MinerU 脚本：ok 模式正常产出；fail 模式（exit 1）模拟转换失败
  const okMineru = path.join(SANDBOX, 'fake-mineru-ok.sh');
  const failMineru = path.join(SANDBOX, 'fake-mineru-fail.sh');
  fs.writeFileSync(okMineru, '#!/bin/bash\nmkdir -p "$2"\nprintf \'# MARKER\\nMINERU-CONVERTED %s\\n\' "$(basename "$1")" > "$2/result.md"\n');
  fs.writeFileSync(failMineru, '#!/bin/bash\necho "fake mineru failure" >&2\nexit 1\n');
  fs.chmodSync(okMineru, 0o755);
  fs.chmodSync(failMineru, 0o755);

  const files = require('../src/main/raws/files');
  const skillEntry = { name: 'test-skill', dir: SANDBOX, desc: '测试技能', instructions: '按测试指令解析文档', enabled: true };
  const base = { apiBaseUrl: llmUrl, model: 'fake-model', skills: [skillEntry] };
  const settingsSkill = { ...base };
  const settingsSkillOff = { ...base, skillParse: false };
  const settingsNoSkill = { apiBaseUrl: llmUrl, model: 'fake-model', skills: [] };

  // ---------- 样本文件 ----------
  const pngPath = path.join(SANDBOX, 'sample.png');
  fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const txtPath = path.join(SANDBOX, 'sample.txt');
  fs.writeFileSync(txtPath, 'PLAIN-TEXT-CONTENT');
  const pdfPath = path.join(SANDBOX, 'sample.pdf');
  const PDFDocument = require('pdfkit');
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const ws = fs.createWriteStream(pdfPath);
    doc.pipe(ws);
    doc.text('SKILL-PARSE-PDF-TEXT');
    doc.end();
    ws.on('finish', resolve);
    ws.on('error', reject);
  });

  // ---------- 【1】png + 技能开 → 技能解析成功 ----------
  const info1 = {};
  const t1 = await files.extractFileContent(pngPath, settingsSkill, { info: info1, noCache: true });
  check('png + 技能开 → 技能解析', info1.parseMethod === 'skill' && t1.includes('SKILL-PARSED'), JSON.stringify(info1) + ' | ' + t1.slice(0, 40));

  // ---------- 【2】png + 开关关 → 报不支持且说明技能解析未生效 ----------
  let e2 = null;
  try { await files.extractFileContent(pngPath, settingsSkillOff, { noCache: true }); } catch (e) { e2 = e; }
  check('png + 开关关 → 报不支持且提示技能解析未生效', !!e2 && e2.message.includes('不支持的文件格式') && e2.message.includes('技能解析未生效'), e2 && e2.message);

  // ---------- 【3】png + 无已启用技能 → 同样报不支持 ----------
  let e3 = null;
  try { await files.extractFileContent(pngPath, settingsNoSkill, { noCache: true }); } catch (e) { e3 = e; }
  check('png + 无已启用技能 → 报不支持且提示技能解析未生效', !!e3 && e3.message.includes('技能解析未生效'), e3 && e3.message);

  // ---------- 【4】txt + 技能开 → 技能解析产出（全覆盖） ----------
  const info4 = {};
  const t4 = await files.extractFileContent(txtPath, settingsSkill, { info: info4, noCache: true });
  check('txt + 技能开 → 技能解析产出', info4.parseMethod === 'skill' && t4.includes('SKILL-PARSED'), JSON.stringify(info4));

  // ---------- 【5】缓存：skill 产物命中（须在模型失败覆盖缓存前断言） ----------
  const info6 = {};
  const t6 = await files.extractFileContent(txtPath, settingsSkill, { info: info6 });
  check('txt 技能产物再次调用 → skill 缓存命中', info6.fromCache === true && info6.parseMethod === 'skill' && t6.includes('SKILL-PARSED'), JSON.stringify(info6));

  // ---------- 【6】txt + 技能开但模型失败 → 回退内置，skillError 留痕 ----------
  failMode = true;
  const info5 = {};
  const t5 = await files.extractFileContent(txtPath, settingsSkill, { info: info5, noCache: true });
  failMode = false;
  check('txt + 模型失败 → 回退内置解析', info5.parseMethod === 'builtin' && t5.includes('PLAIN-TEXT-CONTENT'), JSON.stringify(info5) + ' | ' + t5.slice(0, 40));
  check('回退时 info.skillError 留痕', typeof info5.skillError === 'string' && info5.skillError.length > 0, JSON.stringify(info5.skillError));

  // ---------- 【7】关闭开关后 skill 缓存视为未命中（png 重提报不支持） ----------
  let e7 = null;
  try { await files.extractFileContent(pngPath, settingsSkillOff, { info: {} }); } catch (e) { e7 = e; }
  check('关闭开关后 skill 缓存视为未命中（png 重提报不支持）', !!e7 && e7.message.includes('技能解析未生效'), e7 && e7.message);

  // ---------- 【8】pdf + MinerU 开 + 技能开 → 仍走 MinerU ----------
  const settingsMineruSkill = { ...settingsSkill, mineruMode: 'mineru', mineruConvertCmd: `${okMineru} {input} {output}` };
  const info8 = {};
  const t8 = await files.extractFileContent(pdfPath, settingsMineruSkill, { info: info8, noCache: true });
  check('pdf + MinerU 开 + 技能开 → 仍走 MinerU', info8.parseMethod === 'mineru' && t8.includes('MINERU-CONVERTED'), JSON.stringify(info8));

  // ---------- 【9】pdf + MinerU 失败 + 技能开 → 技能解析兜底，缓存落 fallback ----------
  const settingsMineruFail = { ...settingsSkill, mineruMode: 'mineru', mineruConvertCmd: `${failMineru} {input} {output}` };
  const info9 = {};
  const t9 = await files.extractFileContent(pdfPath, settingsMineruFail, { info: info9, noCache: true });
  check('pdf + MinerU 失败 + 技能开 → 技能解析兜底', info9.parseMethod === 'skill' && t9.includes('SKILL-PARSED'), JSON.stringify(info9));
  check('MinerU 失败原因保留在 info.externalError', typeof info9.externalError === 'string' && info9.externalError.includes('MinerU'), JSON.stringify(info9.externalError));
  const paths = require('../src/main/common/paths');
  const cacheDir = path.join(paths.dataRoot(), 'extract-cache');
  const pdfCache = fs.readdirSync(cacheDir)
    .map((f) => JSON.parse(fs.readFileSync(path.join(cacheDir, f), 'utf-8')))
    .find((j) => String(j.path).endsWith('sample.pdf'));
  check('pdf 技能兜底产物缓存按回退口径落 fallback', !!pdfCache && pdfCache.method === 'fallback', pdfCache && pdfCache.method);

  llmSrv.close();
  console.log(`\n${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
