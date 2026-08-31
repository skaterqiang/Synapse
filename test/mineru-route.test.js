// MinerU 路由口径回归：node test/mineru-route.test.js
// 验证「MinerU 严格只接 PDF」语义：
//   ① pdf + MinerU 配置 → 走 MinerU（假脚本实跑）
//   ② docx + MinerU 配置 → 固定内置解析，绝不调用 MinerU
//   ③ 图片类型（png）→ 无内置解析器且 MinerU 不接，报「不支持」并说明现状
//   ④ pdf + 内置模式 → 内置文本层
//   ⑤ 缓存口径：pdf 的 MinerU 产物落 mineru 缓存；docx 内置产物长期 builtin 缓存
//
// 方法：临时沙箱数据目录 + electron shim + 假 MinerU 脚本 + 假 Ollama 端口
// （假 Ollama 使 ensureOllamaServer 探测成功，避免测试真实拉起 ollama serve）。
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const Module = require('module');

// ---------- 沙箱：HOME/appData 指向临时目录，数据根/缓存全部隔离 ----------
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-routetest-'));
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

async function main() {
  // 假 Ollama：/api/version 返回 200，使 ensureOllamaServer 判定已就绪、不真实拉起 ollama serve
  const ollamaSrv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"version":"fake"}'); });
  await new Promise((r) => ollamaSrv.listen(0, '127.0.0.1', r));
  const ollamaUrl = `http://127.0.0.1:${ollamaSrv.address().port}`;

  // 假 MinerU 脚本：记录被调用的输入路径，并向输出目录写标记 Markdown
  const fakeLog = path.join(SANDBOX, 'mineru-calls.log');
  const script = path.join(SANDBOX, 'fake-mineru.sh');
  fs.writeFileSync(script, `#!/bin/bash\necho "$1" >> "${fakeLog}"\nmkdir -p "$2"\nprintf '# MARKER\\nMINERU-CONVERTED %s\\n' "$(basename "$1")" > "$2/result.md"\n`);
  fs.chmodSync(script, 0o755);

  const files = require('../src/main/raws/files');
  // cmd 里带 -u 指向假 Ollama：ollamaBaseUrlFromCmd 从命令解析端点，探测成功即跳过自启动
  const settingsOn = { mineruMode: 'mineru', mineruConvertCmd: `${script} {input} {output} -u ${ollamaUrl}` };
  const settingsOff = { mineruMode: 'builtin' };

  // ---------- 样本文件 ----------
  const pdfPath = path.join(SANDBOX, 'sample.pdf');
  const PDFDocument = require('pdfkit');
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const ws = fs.createWriteStream(pdfPath);
    doc.pipe(ws);
    doc.text('MINERU-ROUTE-PDF-TEXT');
    doc.end();
    ws.on('finish', resolve);
    ws.on('error', reject);
  });

  const JSZip = require('jszip');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>HELLO-DOCX-CONTENT</w:t></w:r></w:p></w:body></w:document>');
  const docxPath = path.join(SANDBOX, 'sample.docx');
  fs.writeFileSync(docxPath, await zip.generateAsync({ type: 'nodebuffer' }));

  const pngPath = path.join(SANDBOX, 'sample.png');
  fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  const callsLog = () => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf-8') : '');

  // ---------- 【1】pdf + MinerU 开 → MinerU 解析 ----------
  const info1 = {};
  const t1 = await files.extractFileContent(pdfPath, settingsOn, { info: info1, noCache: true });
  check('pdf + MinerU 开 → MinerU 解析', info1.parseMethod === 'mineru' && t1.includes('MINERU-CONVERTED'), JSON.stringify(info1) + ' | ' + t1.slice(0, 60));
  check('假 MinerU 收到了 pdf', callsLog().includes('sample.pdf'));

  // ---------- 【2】docx + MinerU 开 → 固定内置，不调 MinerU ----------
  const info2 = {};
  const t2 = await files.extractFileContent(docxPath, settingsOn, { info: info2, noCache: true });
  check('docx + MinerU 开 → 内置解析', info2.parseMethod === 'builtin' && t2.includes('HELLO-DOCX-CONTENT'), JSON.stringify(info2));
  check('假 MinerU 未收到 docx', !callsLog().includes('sample.docx'));

  // ---------- 【3】png + MinerU 开 → 报不支持并说明技能解析未生效（本测试未配置技能/模型） ----------
  let e3 = null;
  try { await files.extractFileContent(pngPath, settingsOn, { noCache: true }); } catch (e) { e3 = e; }
  check('png + MinerU 开 → 报不支持且说明技能解析未生效', !!e3 && e3.message.includes('不支持的文件格式') && e3.message.includes('技能解析未生效'), e3 && e3.message);
  check('假 MinerU 未收到 png', !callsLog().includes('sample.png'));

  // ---------- 【4】png + MinerU 关 → 同样报不支持 ----------
  let e4 = null;
  try { await files.extractFileContent(pngPath, settingsOff, { noCache: true }); } catch (e) { e4 = e; }
  check('png + MinerU 关 → 报不支持且说明技能解析未生效', !!e4 && e4.message.includes('不支持的文件格式') && e4.message.includes('技能解析未生效'), e4 && e4.message);

  // ---------- 【4.5】缓存落盘口径：pdf=mineru、docx=builtin ----------
  const paths = require('../src/main/common/paths');
  const cacheDir = path.join(paths.dataRoot(), 'extract-cache');
  const cacheMethods = () => fs.readdirSync(cacheDir).map((f) => JSON.parse(fs.readFileSync(path.join(cacheDir, f), 'utf-8')).method);
  check('缓存落盘含 mineru 与 builtin 两类', cacheMethods().includes('mineru') && cacheMethods().includes('builtin'), JSON.stringify(cacheMethods()));

  // ---------- 【5】pdf + MinerU 关 → 内置文本层 ----------
  const info5 = {};
  const t5 = await files.extractFileContent(pdfPath, settingsOff, { info: info5, noCache: true });
  check('pdf + MinerU 关 → 内置文本层', info5.parseMethod === 'builtin' && t5.includes('MINERU-ROUTE-PDF-TEXT'), (t5 || '').slice(0, 60));
  const info6 = {};
  const t6 = await files.extractFileContent(docxPath, settingsOn, { info: info6 });
  check('docx 缓存命中（builtin 长期有效，配置 MinerU 后也不重提）', info6.fromCache === true && info6.parseMethod === 'builtin' && t6.includes('HELLO-DOCX-CONTENT'), JSON.stringify(info6));
  // 【5】内置模式提取 pdf 会把缓存写为 builtin；切回 MinerU 模式应视为过期并重跑 MinerU
  const info7 = {};
  const t7 = await files.extractFileContent(pdfPath, settingsOn, { info: info7 });
  check('pdf 切回 MinerU 模式 → 重跑 MinerU', info7.parseMethod === 'mineru' && t7.includes('MINERU-CONVERTED'), JSON.stringify(info7));
  const info8 = {};
  const t8 = await files.extractFileContent(pdfPath, settingsOn, { info: info8 });
  check('pdf 再次调用 → MinerU 缓存命中', info8.fromCache === true && info8.parseMethod === 'mineru' && t8.includes('MINERU-CONVERTED'), JSON.stringify(info8));

  ollamaSrv.close();
  console.log(`\n${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
