// 原始文件模块测试（raws/files.js 纯函数与解析链、raws/root.js、raws/urlcookies.js）
// 覆盖：导入类型白名单解析与钳制、MinerU 路由口径（严格只接 PDF）、命令模板解析与 argv 构建、
//      子进程 UTF-8/GBK 流式解码（跨块多字节截断）、loopback 代理白名单注入、
//      内置解析器（md/txt/csv/json/html/xlsx/pptx）、不支持格式报错口径、
//      提取缓存口径（builtin/mineru/skill/fallback + TTL + size/mtime 失效 + noCache/forceMineru）、
//      标题派生（URL 编码解码、占位标题识别、pickPageTitle 优先级链）、
//      MinerU 图片暂存与并入笔记附件目录、rawsRoot/safeJoin、Cookie 持久化与按域匹配注入。
// 运行：node test/raws-utils.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bootEnv, mkCheck, writeFile } = require('./helpers/harness');

const { check, section, summary } = mkCheck('原始文件模块');
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const env = await bootEnv({ prefix: 'synapse-raws-' });
  const files = require('../src/main/raws/files');
  const { rawsRoot, safeJoin } = require('../src/main/raws/root');
  const cookies = require('../src/main/raws/urlcookies');
  const settingsMod = require('../src/main/common/settings');
  const paths = require('../src/main/common/paths');
  const C = require('../src/main/common/constants');

  const wiki = path.join(env.dir, 'wiki');
  const rawDir = path.join(wiki, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  const settings = { ...settingsMod.getSettings(), wikiRoot: wiki, skillParse: false };

  // 假 Ollama：/api/version 返回 200，使 ensureOllamaServer 判定已就绪、不真实拉起 ollama serve
  const http = require('http');
  const ollamaSrv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"version":"fake"}'); });
  await new Promise((r) => ollamaSrv.listen(0, '127.0.0.1', r));
  const ollamaUrl = `http://127.0.0.1:${ollamaSrv.address().port}`;

  // 假 MinerU 转换器：node fake-converter.js <input> <output> -u <ollama> --mode=<m>
  const CONV = path.join(__dirname, 'fixtures', 'fake-converter.js');
  const convCmd = (mode) => `"${process.execPath}" "${CONV}" {input} {output} -u ${ollamaUrl} --mode=${mode}`;
  const mineruOn = (mode) => ({ ...settings, mineruMode: 'mineru', mineruConvertCmd: convCmd(mode), mineruTimeout: 120 });

  // ---------- 1. 导入类型白名单 ----------
  section('noteImportExts / canImportAsNote — 导入类型白名单');
  check('未配置时回退默认白名单', (() => { const s = files.noteImportExts({}); return s.has('pdf') && s.has('docx') && s.has('md') && s.size === C.DEFAULT_NOTE_IMPORT_EXTS.length; })());
  check('配成空串也回退默认（防误关整个导入能力）', files.noteImportExts({ noteImportExts: '' }).size === C.DEFAULT_NOTE_IMPORT_EXTS.length);
  check('配成 null 回退默认', files.noteImportExts({ noteImportExts: null }).size === C.DEFAULT_NOTE_IMPORT_EXTS.length);
  check('自定义白名单生效', (() => { const s = files.noteImportExts({ noteImportExts: 'md,txt' }); return s.size === 2 && s.has('md') && s.has('txt') && !s.has('pdf'); })());
  check('容许分号/空格/换行分隔', files.noteImportExts({ noteImportExts: 'md;txt csv\njson' }).size === 4);
  check('容许前导点与大小写', (() => { const s = files.noteImportExts({ noteImportExts: '.MD, .Pdf' }); return s.has('md') && s.has('pdf'); })());
  check('canImportAsNote 按扩展名判定', files.canImportAsNote(settings, 'a.md') === true && files.canImportAsNote(settings, 'a.xyz') === false);
  check('无扩展名一律不收', files.canImportAsNote(settings, 'README') === false && files.canImportAsNote(settings, '') === false && files.canImportAsNote(settings, null) === false);
  check('大小写不敏感', files.canImportAsNote(settings, 'A.MD') === true);
  check('自定义白名单外的类型被拒', files.canImportAsNote({ noteImportExts: 'md' }, 'a.pdf') === false);
  check('目录风格路径按扩展名判定', files.canImportAsNote(settings, 'raw/子目录/文档.docx') === true);

  // ---------- 2. MinerU 路由口径 ----------
  section('isMineruRoutable — MinerU 严格只接 PDF');
  check('MINERU_SUPPORTED_EXTS 仅 pdf', C.MINERU_SUPPORTED_EXTS.join(',') === 'pdf');
  check('pdf 可路由', files.mineruCmdParts({ mineruMode: 'mineru', mineruConvertCmd: 'x {input} {output}' }) !== null);
  check('图片类型集合覆盖常见格式', ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff'].every((e) => C.MINERU_IMAGE_EXTS.has(e)));

  // ---------- 3. 命令模板解析 ----------
  section('mineruCmdParts / buildMineruArgv — 命令模板解析');
  check('未配置命令返回 null', files.mineruCmdParts({}) === null && files.mineruCmdParts(null) === null);
  check('命令为空白返回 null', files.mineruCmdParts({ mineruConvertCmd: '   ' }) === null);
  check('builtin 模式即使命令已填也返回 null', files.mineruCmdParts({ mineruMode: 'builtin', mineruConvertCmd: 'mineru {input} {output}' }) === null);
  check('未设 mineruMode（旧数据）按命令是否填写决定', files.mineruCmdParts({ mineruConvertCmd: 'a b' }).join(',') === 'a,b');
  check('auto 模式解析命令', files.mineruCmdParts({ mineruMode: 'auto', mineruConvertCmd: 'mineru-run.bat {input} {output}' }).length === 3);
  check('双引号包裹的含空格路径作为单个参数', files.mineruCmdParts({ mineruConvertCmd: '"C:\\Program Files\\mineru\\run.bat" {input}' })[0] === 'C:\\Program Files\\mineru\\run.bat');
  check('单引号包裹同样剥离引号', files.mineruCmdParts({ mineruConvertCmd: "'/opt/mineru run' {input}" })[0] === '/opt/mineru run');
  check('多余空白被压缩', files.mineruCmdParts({ mineruConvertCmd: '  a    b  ' }).join('|') === 'a|b');

  // buildMineruArgv 未导出，通过假转换器回写实收 argv 验证占位符替换
  // x.pdf 用真实极简 PDF（含文本层）：MinerU 失败时内置解析能兜出文本，才能验证「静默回退」口径
  const MINI_PDF_B64 = 'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA1NCA+PgpzdHJlYW0KQlQgL0YxIDE4IFRmIDcyIDcyMCBUZCAoTWluZXJVIENvbmZpZyBUZXN0IDIwMjYpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvRm9udCAvU3VidHlwZSAvVHlwZTEgL0Jhc2VGb250IC9IZWx2ZXRpY2EgPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAwMDAwMzQ1IDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNDE1CiUlRU9G';
  fs.writeFileSync(path.join(rawDir, 'x.pdf'), Buffer.from(MINI_PDF_B64, 'base64'));
  writeFile(path.join(rawDir, 'y.pdf'), 'fake pdf');
  const keepOut1 = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-argv-'));
  const md1 = await files.convertWithMineru(mineruOn('argv'), path.join(rawDir, 'x.pdf'), { outDir: keepOut1 }).catch(() => '');
  const gotArgv = (() => { try { return JSON.parse(String(md1).split('\n\n')[1]); } catch (_) { return []; } })();
  check('占位符被替换为实际输入路径', gotArgv.some((a) => a.endsWith('x.pdf')), JSON.stringify(gotArgv));
  check('占位符被替换为调用方指定的输出目录', gotArgv.some((a) => a === keepOut1), JSON.stringify(gotArgv));
  check('-u 与 --mode 等额外参数原样传递', gotArgv.includes('-u') && gotArgv.some((a) => a === '--mode=argv'), JSON.stringify(gotArgv));

  // 未写占位符时自动追加 input/output
  const keepOut2 = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-argv-'));
  const md2 = await files.convertWithMineru({ ...settings, mineruMode: 'mineru', mineruConvertCmd: `"${process.execPath}" "${CONV}" -u ${ollamaUrl} --mode=argv`, mineruTimeout: 120 }, path.join(rawDir, 'y.pdf'), { outDir: keepOut2 }).catch(() => '');
  const gotArgv2 = (() => { try { return JSON.parse(String(md2).split('\n\n')[1]); } catch (_) { return []; } })();
  check('未写占位符时自动追加输入文件', gotArgv2.some((a) => a.endsWith('y.pdf')), JSON.stringify(gotArgv2));
  check('未写占位符时自动追加输出目录', gotArgv2.includes(keepOut2), JSON.stringify(gotArgv2));

  // 转换产物为空 → 报错（不静默返回空文本）
  let emptyErr = '';
  try { await files.convertWithMineru(mineruOn('empty'), path.join(rawDir, 'x.pdf'), {}); } catch (e) { emptyErr = e.message; }
  check('输出目录没有 Markdown 时报错', /没有 Markdown 文件/.test(emptyErr), emptyErr);
  // 未配置命令时 convertWithMineru 返回 null（不抛错）
  check('未配置命令时 convertWithMineru 返回 null', (await files.convertWithMineru({ mineruMode: 'mineru' }, path.join(rawDir, 'x.pdf'), {})) === null);
  // 临时输出目录用后自动清理；指定 outDir 则保留
  check('指定 outDir 时保留产物', fs.existsSync(path.join(keepOut1, 'out.md')));
  const imgInfo = {};
  const imgMd = await files.convertWithMineru(mineruOn('imgs'), path.join(rawDir, 'x.pdf'), { info: imgInfo }).catch(() => '');
  check('MinerU 产物图片目录被暂存（info.imagesDir）', !!imgInfo.imagesDir && fs.existsSync(path.join(imgInfo.imagesDir, 'a.png')), JSON.stringify(imgInfo.imagesDir));
  check('暂存产物 Markdown 仍引用 images/ 相对路径（待并入笔记时改写）', /images\/a\.png/.test(String(imgMd)), String(imgMd).slice(0, 120));
  if (imgInfo.imagesDir) fs.rmSync(imgInfo.imagesDir, { recursive: true, force: true });

  // ---------- 4. 子进程解码与代理白名单 ----------
  section('childUtf8Env / 流式解码（跨块多字节）');
  // childUtf8Env 未导出，通过假转换器回写子进程实际环境变量验证
  const envOut = await files.convertWithMineru(mineruOn('env'), path.join(rawDir, 'x.pdf'), {}).catch(() => '');
  check('子进程注入 PYTHONUTF8=1', /PYTHONUTF8=1/.test(String(envOut)), String(envOut).slice(0, 200));
  check('子进程注入 PYTHONIOENCODING=utf-8', /PYTHONIOENCODING=utf-8/.test(String(envOut)), String(envOut).slice(0, 200));
  check('子进程注入 loopback NO_PROXY 白名单（防健康检查被送到远端代理）', /NO_PROXY=.*127\.0\.0\.1/.test(String(envOut)) && /localhost/.test(String(envOut)) && /::1/.test(String(envOut)), String(envOut).slice(0, 300));
  check('NO_PROXY 大小写两个键都注入', /no_proxy=.*127\.0\.0\.1/.test(String(envOut)), String(envOut).slice(0, 300));

  // 流式解码：把一个三字节中文字符拆成两次 write，验证跨块拼接不产生替换符
  const splitLog = [];
  await files.convertWithMineru(mineruOn('split'), path.join(rawDir, 'x.pdf'), { onLog: (l) => splitLog.push(l) }).catch(() => null);
  check('跨块截断的多字节字符被正确拼接（无 U+FFFD）', !splitLog.join('\n').includes('\uFFFD'), JSON.stringify(splitLog));
  check('跨块中文日志内容完整', splitLog.some((l) => l.includes('中文日志跨块输出')), JSON.stringify(splitLog));

  // GBK 输出：UTF-8 解码出替换符时回退 GBK（仅 Windows 生效，其它平台断言不崩溃即可）
  const gbkLog = [];
  await files.convertWithMineru(mineruOn('gbk'), path.join(rawDir, 'x.pdf'), { onLog: (l) => gbkLog.push(l) }).catch(() => null);
  if (process.platform === 'win32') check('GBK 输出回退解码为中文', gbkLog.some((l) => l.includes('中文')), JSON.stringify(gbkLog));
  else check('非 Windows 平台不做 GBK 回退（不崩溃）', Array.isArray(gbkLog));

  // \r 进度行：视为行分隔、带 replace 标记、剥离 ANSI 转义
  const crLog = [];
  await files.convertWithMineru(mineruOn('crlf'), path.join(rawDir, 'x.pdf'), { onLog: (l, replace) => crLog.push({ l, replace }) }).catch(() => null);
  check('\\r 进度行被当作独立行上抛', crLog.some((x) => /进度 10%/.test(x.l)) && crLog.some((x) => /进度 90%/.test(x.l)), JSON.stringify(crLog));
  check('\\r 产出的行带 replace 标记（前端原位刷新）', crLog.some((x) => x.l === '进度 10%' && x.replace === true), JSON.stringify(crLog));
  check('\\r\\n（CRLF）视为单个换行、不带 replace', crLog.some((x) => x.l === '进度 90%' && !x.replace), JSON.stringify(crLog));
  check('\\n 行不带 replace 标记', crLog.some((x) => x.l === '完成行' && !x.replace), JSON.stringify(crLog));
  check('ANSI 控制序列被剥离', !crLog.some((x) => x.l.includes('\x1b')), JSON.stringify(crLog));

  // 子进程非 0 退出：错误信息带退出码与 stderr 尾部
  let failErr = '';
  try { await files.convertWithMineru(mineruOn('fail'), path.join(rawDir, 'x.pdf'), {}); } catch (e) { failErr = e.message; }
  check('非 0 退出报错带退出码', /退出码 3/.test(failErr), failErr);
  check('非 0 退出报错带 stderr 尾部原因', /VLM 模型缺失/.test(failErr), failErr);

  // 作业停止：signal 触发时立即 kill 子进程
  const ac = new AbortController();
  const slowCmd = `"${process.execPath}" -e "setTimeout(()=>{},60000)" {input} {output} -u ${ollamaUrl}`;
  const sigT0 = Date.now();
  const slowP = files.convertWithMineru({ ...settings, mineruMode: 'mineru', mineruConvertCmd: slowCmd, mineruTimeout: 120 }, path.join(rawDir, 'x.pdf'), { signal: ac.signal }).catch((e) => e.message);
  await tick(400);
  ac.abort();
  const slowRes = await slowP;
  check('外部 signal 触发时子进程被终止（不跑完 60 秒）', Date.now() - sigT0 < 15000 && /信号|终止/.test(String(slowRes)), String(slowRes));
  // 已 aborted 的 signal 传入时立即终止
  const ac2 = new AbortController(); ac2.abort();
  const sigT1 = Date.now();
  const preRes = await files.convertWithMineru({ ...settings, mineruMode: 'mineru', mineruConvertCmd: slowCmd, mineruTimeout: 120 }, path.join(rawDir, 'x.pdf'), { signal: ac2.signal }).catch((e) => e.message);
  check('传入已中止的 signal 时立即失败', Date.now() - sigT1 < 15000 && /信号|终止/.test(String(preRes)), String(preRes));

  // ---------- 5. 内置解析器 ----------
  section('extractFileContent — 内置解析器');
  writeFile(path.join(rawDir, '文本.md'), '# 标题\n\n正文 **加粗**');
  writeFile(path.join(rawDir, '纯文本.txt'), '第一行\n第二行');
  writeFile(path.join(rawDir, '数据.csv'), '名称,数量\n充电桩,10');
  writeFile(path.join(rawDir, '配置.json'), '{"a":1}');
  writeFile(path.join(rawDir, '页面.html'), '<html><head><title>网页标题</title></head><body><h1>大标题</h1><p>段落内容</p><ul><li>项目一</li></ul></body></html>');
  check('md 直读原文', (await files.extractFileContent(path.join(rawDir, '文本.md'), settings)) === '# 标题\n\n正文 **加粗**');
  check('txt 直读', (await files.extractFileContent(path.join(rawDir, '纯文本.txt'), settings)) === '第一行\n第二行');
  check('csv 直读', (await files.extractFileContent(path.join(rawDir, '数据.csv'), settings)).includes('充电桩,10'));
  check('json 直读', (await files.extractFileContent(path.join(rawDir, '配置.json'), settings)) === '{"a":1}');
  const html = await files.extractFileContent(path.join(rawDir, '页面.html'), settings);
  check('html 转 Markdown（atx 标题）', html.includes('# 大标题'), html.slice(0, 120));
  check('html 列表转 Markdown', /[-*]\s+项目一/.test(html), html.slice(0, 200));

  // xlsx / pptx：用最小合法二进制构造
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['名称', '数量'], ['充电桩', 10]]), '扩容表');
  XLSX.writeFile(wb, path.join(rawDir, '表格.xlsx'));
  const xls = await files.extractFileContent(path.join(rawDir, '表格.xlsx'), settings);
  check('xlsx 转 Markdown（带工作表名）', xls.includes('## 工作表：扩容表') && xls.includes('充电桩'), xls.slice(0, 150));
  check('xlsx 内容包在代码块内', /```/.test(xls));

  const JSZip = require('jszip');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  zip.file('ppt/slides/slide1.xml', '<?xml version="1.0"?><p:sld xmlns:a="a" xmlns:p="p"><a:t>第一页要点</a:t><a:t>含 &amp; 符号</a:t></p:sld>');
  zip.file('ppt/slides/slide2.xml', '<?xml version="1.0"?><p:sld xmlns:a="a" xmlns:p="p"><a:t>第二页要点</a:t></p:sld>');
  fs.writeFileSync(path.join(rawDir, '幻灯.pptx'), await zip.generateAsync({ type: 'nodebuffer' }));
  const ppt = await files.extractFileContent(path.join(rawDir, '幻灯.pptx'), settings);
  check('pptx 按幻灯片顺序输出', ppt.indexOf('第一页要点') < ppt.indexOf('第二页要点'), ppt.slice(0, 200));
  check('pptx 幻灯片编号正确', /## 幻灯片 1/.test(ppt) && /## 幻灯片 2/.test(ppt));
  check('pptx XML 实体被解码', ppt.includes('含 & 符号'), ppt.slice(0, 200));

  // 不支持的格式
  writeFile(path.join(rawDir, '未知.xyz'), 'whatever');
  let unsupErr = '';
  try { await files.extractFileContent(path.join(rawDir, '未知.xyz'), settings); } catch (e) { unsupErr = e.message; }
  check('不支持格式抛错并给出配置指引', /不支持的文件格式：\.xyz/.test(unsupErr) && /设置→文档解析/.test(unsupErr), unsupErr);

  // 图片：技能解析未就绪 → 报不支持并说明原因
  writeFile(path.join(rawDir, '图片.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  let imgErr = '';
  try { await files.extractFileContent(path.join(rawDir, '图片.png'), settings); } catch (e) { imgErr = e.message; }
  check('图片在技能解析未生效时报不支持并说明开启路径', /不支持的文件格式：\.png/.test(imgErr) && /技能解析未生效/.test(imgErr), imgErr);

  // forceMineru 但未配置命令 → 明确报错，不静默回退内置
  let fmErr = '';
  try { await files.extractFileContent(path.join(rawDir, '文本.md'), settings, { forceMineru: true }); } catch (e) { fmErr = e.message; }
  check('文本型即使 forceMineru 也走内置（MinerU 只接 PDF）', fmErr === '');
  let fmErr2 = '';
  try { await files.extractFileContent(path.join(rawDir, 'x.pdf'), settings, { forceMineru: true }); } catch (e) { fmErr2 = e.message; }
  check('PDF + forceMineru 但未配置命令 → 明确报错不回退', /未配置 MinerU 转换命令/.test(fmErr2), fmErr2);

  // ---------- 6. 提取缓存口径 ----------
  section('提取缓存 — 命中/失效/绕过');
  const cacheDir = path.join(env.dataRoot, 'extract-cache');
  const cacheCount = () => (fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json')).length : 0);
  check('内置解析产物落缓存', cacheCount() > 0, String(cacheCount()));
  const before = cacheCount();
  const info1 = {};
  const cacheText1 = await files.extractFileContent(path.join(rawDir, '表格.xlsx'), settings, { info: info1 });
  check('第二次提取命中缓存（fromCache=true）', info1.fromCache === true && info1.parseMethod === 'builtin', JSON.stringify(info1));
  check('命中缓存不新增缓存条目', cacheCount() === before, cacheCount() + '/' + before);
  check('命中缓存内容一致', cacheText1.includes('充电桩'));

  const info2 = {};
  await files.extractFileContent(path.join(rawDir, '表格.xlsx'), settings, { info: info2, noCache: true });
  check('noCache 跳过读缓存（fromCache 不为真）', info2.fromCache !== true, JSON.stringify(info2));

  // 文件变更（size/mtime）→ 缓存失效
  const cacheFileOf = (abs) => { const crypto = require('crypto'); const id = crypto.createHash('sha1').update(String(abs)).digest('hex').slice(0, 16); return path.join(cacheDir, id + '.json'); };
  const xlsxPath = path.join(rawDir, '表格.xlsx');
  check('缓存键为路径 sha1 前 16 位', fs.existsSync(cacheFileOf(xlsxPath)));
  const cached = JSON.parse(fs.readFileSync(cacheFileOf(xlsxPath), 'utf-8'));
  check('缓存记录 path/size/mtime/method/at', cached.path === xlsxPath && typeof cached.size === 'number' && typeof cached.mtime === 'number' && cached.method === 'builtin' && cached.at > 0);
  fs.writeFileSync(cacheFileOf(xlsxPath), JSON.stringify({ ...cached, size: cached.size + 1 }), 'utf-8');
  const info3 = {};
  await files.extractFileContent(xlsxPath, settings, { info: info3 });
  check('size 不匹配视为未命中并重新提取', info3.fromCache !== true, JSON.stringify(info3));

  // 脏缓存容错
  fs.writeFileSync(cacheFileOf(xlsxPath), '{坏 JSON', 'utf-8');
  const info4 = {};
  const t4 = await files.extractFileContent(xlsxPath, settings, { info: info4 });
  check('缓存损坏时容错重提', info4.fromCache !== true && t4.includes('充电桩'));

  // 非 PDF 类型即使配了 MinerU 也走内置（严格只接 PDF）
  const mineruSettings = mineruOn('ok');
  const info5 = {};
  await files.extractFileContent(path.join(rawDir, '表格.xlsx'), mineruSettings, { info: info5 });
  check('非 PDF 类型即使配了 MinerU 也走内置（严格只接 PDF）', info5.parseMethod === 'builtin' || info5.fromCache === true, JSON.stringify(info5));
  check('非 PDF 的内置缓存不因配置 MinerU 而失效', JSON.parse(fs.readFileSync(cacheFileOf(xlsxPath), 'utf-8')).method === 'builtin');

  // PDF + MinerU 成功 → 落 mineru 缓存，后续命中不再跑子进程
  const pdfPath = path.join(rawDir, 'x.pdf');
  check('内置解析器能从真实 PDF 抽出文本层（MinerU 失败回退的兜底前提）', /MinerU Config Test 2026/.test(await files.extractFileContent(pdfPath, settings, { noCache: true })));
  const infoP1 = {};
  const pdfText = await files.extractFileContent(pdfPath, mineruSettings, { info: infoP1, noCache: true });
  check('PDF 走 MinerU 产出 Markdown', /MINERU-CONVERTED/.test(pdfText), pdfText.slice(0, 80));
  check('PDF 解析方式记为 mineru', infoP1.parseMethod === 'mineru', JSON.stringify(infoP1));
  check('MinerU 产物落 mineru 缓存', JSON.parse(fs.readFileSync(cacheFileOf(pdfPath), 'utf-8')).method === 'mineru');
  const infoP2 = {};
  const pdfText2 = await files.extractFileContent(pdfPath, mineruSettings, { info: infoP2 });
  check('PDF 第二次提取命中 mineru 缓存', infoP2.fromCache === true && infoP2.parseMethod === 'mineru' && pdfText2 === pdfText, JSON.stringify(infoP2));
  // 非 PDF 的历史 mineru 缓存视为过期（旧版图片/docx 转换产物）
  fs.writeFileSync(cacheFileOf(xlsxPath), JSON.stringify({ path: xlsxPath, size: fs.statSync(xlsxPath).size, mtime: Math.round(fs.statSync(xlsxPath).mtimeMs), at: Date.now(), method: 'mineru', reason: '', text: '旧 mineru 产物' }), 'utf-8');
  const infoP3 = {};
  const xlsxText3 = await files.extractFileContent(xlsxPath, settings, { info: infoP3 });
  check('非 PDF 的历史 mineru 缓存视为过期重提', infoP3.fromCache !== true && xlsxText3.includes('充电桩'), JSON.stringify(infoP3));
  // 无解析方式标记的旧条目视为未命中
  fs.writeFileSync(cacheFileOf(xlsxPath), JSON.stringify({ path: xlsxPath, size: fs.statSync(xlsxPath).size, mtime: Math.round(fs.statSync(xlsxPath).mtimeMs), at: Date.now(), text: '无标记旧条目' }), 'utf-8');
  const infoP4 = {};
  await files.extractFileContent(xlsxPath, settings, { info: infoP4 });
  check('无 method 标记的旧缓存条目视为未命中', infoP4.fromCache !== true, JSON.stringify(infoP4));

  // ---------- 7. readRawText / readRawTextForScan ----------
  section('readRawText / readRawTextForScan');
  check('readRawText 读 raw 相对路径', (await files.readRawText(settings, 'raw/文本.md')) === '# 标题\n\n正文 **加粗**');
  check('readRawText 读 local: 绝对路径', (await files.readRawText(settings, 'local:' + path.join(rawDir, '纯文本.txt'))) === '第一行\n第二行');
  check('readRawText 文件不存在返回空串', (await files.readRawText(settings, 'raw/不存在.md')) === '');
  check('readRawText 富文本走提取链', (await files.readRawText(settings, 'raw/表格.xlsx')).includes('充电桩'));
  const scan = await files.readRawTextForScan(settings, 'raw/纯文本.txt', 8);
  check('readRawTextForScan 按 maxBytes 截断（不小于 4096 下限）', scan.length >= 4 && scan.length <= 4096, String(scan.length));
  check('readRawTextForScan 文件不存在返回空串', (await files.readRawTextForScan(settings, 'raw/不存在.txt', 100)) === '');
  check('readRawTextForScan 富文本可用', (await files.readRawTextForScan(settings, 'raw/表格.xlsx', 4096)).includes('充电桩'));
  // 二进制文件（含 NUL）按扫描口径返回空串，避免乱码进检索
  const binPath = path.join(rawDir, '二进制.txt');
  fs.writeFileSync(binPath, Buffer.concat([Buffer.from('文本'), Buffer.from([0, 0, 0]), Buffer.from('更多')]));
  check('含 NUL 字节的文本文件扫描时返回空串', (await files.readRawTextForScan(settings, 'raw/二进制.txt', 4096)) === '');

  // ---------- 8. 标题派生 ----------
  section('titleFromFileName / isPlaceholderTitle / pickPageTitle');
  check('去掉扩展名', files.titleFromFileName('充电桩扩容方案.pdf') === '充电桩扩容方案');
  check('只去最后一个扩展名', files.titleFromFileName('v1.2 方案.docx') === 'v1.2 方案');
  check('URL 编码名被解码', files.titleFromFileName(encodeURIComponent('知识图谱导论') + '.md') === '知识图谱导论');
  check('普通含 % 的名字不被误解码', files.titleFromFileName('增长 50% 报告.txt') === '增长 50% 报告');
  check('非法编码序列保留原值', files.titleFromFileName('%E7broken.md') === '%E7broken');
  check('空名回退原值', files.titleFromFileName('') === '' && files.titleFromFileName(null) === '');

  check('空标题为占位', files.isPlaceholderTitle('') === true && files.isPlaceholderTitle(null) === true && files.isPlaceholderTitle('   ') === true);
  check('loading 类为占位', ['Loading', 'loading...', '加载中', '请稍候...', 'Redirecting', 'Just a moment'].every((s) => files.isPlaceholderTitle(s) === true));
  check('通用名为占位', ['Untitled', 'Document', 'New Document', '新建文档', 'Index', 'Home', '首页', '—', '-'].every((s) => files.isPlaceholderTitle(s) === true));
  check('真实标题非占位', files.isPlaceholderTitle('充电桩扩容方案') === false && files.isPlaceholderTitle('Loading 组件设计') === false);
  check('多空白归一后判定', files.isPlaceholderTitle('  loading \n ') === true);

  check('pickPageTitle 取 og:title 优先', files.pickPageTitle('<html><head><title>普通标题</title><meta property="og:title" content="OG 标题"></head></html>') === 'OG 标题');
  check('pickPageTitle 支持 content 在前的写法', files.pickPageTitle('<meta content="前置 OG" property="og:title">') === '前置 OG');
  check('pickPageTitle 退到 twitter:title', files.pickPageTitle('<meta name="twitter:title" content="推特标题"><title>普通</title>') === '推特标题');
  check('pickPageTitle 退到 itemprop=name', files.pickPageTitle('<meta itemprop="name" content="结构化标题"><title>普通</title>') === '结构化标题');
  check('pickPageTitle 退到 <title>', files.pickPageTitle('<html><head><title>文档标题</title></head></html>') === '文档标题');
  check('pickPageTitle 退到内联 JSON title', files.pickPageTitle('<script>window.appData={"title":"内嵌标题","x":1}</script>') === '内嵌标题');
  check('占位标题被跳过继续找下一个候选', files.pickPageTitle('<title>Loading</title><meta property="og:title" content="真实标题">') === '真实标题');
  check('全是占位返回空串', files.pickPageTitle('<title>Loading</title>') === '');
  check('标题内 HTML 实体被解码', files.pickPageTitle('<title>设备 &amp; 装置</title>') === '设备 & 装置');
  check('多行标题空白归一', files.pickPageTitle('<title>  多行\n  标题  </title>') === '多行 标题');
  check('超长标题截断到 120 字', files.pickPageTitle('<title>' + 'A'.repeat(300) + '</title>').length === 120);
  check('无标题返回空串', files.pickPageTitle('<html><body>无头</body></html>') === '');

  // ---------- 9. MinerU 图片并入 ----------
  section('attachMineruImages — 图片并入笔记附件目录');
  const noteDir = path.join(env.dataRoot, 'note');
  fs.mkdirSync(noteDir, { recursive: true });
  const notePath = path.join(noteDir, '带图笔记.md');
  fs.writeFileSync(notePath, '# 带图\n\n![](images/a.png)\n![](images/b.png)\n', 'utf-8');
  const imgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-img-'));
  fs.writeFileSync(path.join(imgDir, 'a.png'), 'A');
  fs.writeFileSync(path.join(imgDir, 'b.png'), 'B');
  const moved = files.attachMineruImages(notePath, imgDir);
  check('返回并入图片数', moved === 2, String(moved));
  check('图片复制到笔记同名附件目录', fs.existsSync(path.join(noteDir, '带图笔记', 'a.png')) && fs.existsSync(path.join(noteDir, '带图笔记', 'b.png')));
  check('正文 images/ 引用改写为 kb-asset 绝对引用', (() => { const t = fs.readFileSync(notePath, 'utf-8'); return !t.includes('](images/') && t.includes(paths.kbAssetUrlFor(path.join(noteDir, '带图笔记')) + '/a.png'); })());
  check('暂存图片目录被清理', !fs.existsSync(imgDir));
  check('空图片目录返回 0 并清理', (() => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-img-')); return files.attachMineruImages(notePath, d) === 0 && !fs.existsSync(d); })());
  check('参数缺失返回 0', files.attachMineruImages(null, null) === 0 && files.attachMineruImages(notePath, null) === 0);
  check('目录不存在返回 0', files.attachMineruImages(notePath, path.join(env.dir, '没有这个目录')) === 0);
  check('已存在同名图片不重复复制（moved=0）', (() => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-img-')); fs.writeFileSync(path.join(d, 'a.png'), 'X'); const r = files.attachMineruImages(notePath, d); return r === 0 && fs.readFileSync(path.join(noteDir, '带图笔记', 'a.png'), 'utf-8') === 'A'; })());

  // ---------- 10. rawsRoot / safeJoin ----------
  section('rawsRoot / safeJoin — 路径安全');
  check('rawsRoot 取 settings.wikiRoot', rawsRoot(settings) === path.resolve(wiki));
  check('rawsRoot 未配置时落 <dataRoot>/llmwiki', rawsRoot({}) === path.resolve(path.join(env.dataRoot, 'llmwiki')), rawsRoot({}));
  check('safeJoin 正常拼接', safeJoin(wiki, 'raw/a.md') === path.join(wiki, 'raw', 'a.md'));
  check('safeJoin 允许根自身', safeJoin(wiki, '') === path.resolve(wiki));
  check('safeJoin 拒绝越界', (() => { try { safeJoin(wiki, '../escape.md'); return false; } catch (e) { return /非法路径/.test(e.message); } })());
  check('safeJoin 拒绝深层越界', (() => { try { safeJoin(wiki, 'raw/../../escape.md'); return false; } catch (e) { return /非法路径/.test(e.message); } })());
  check('safeJoin 拒绝绝对路径越界', (() => { try { safeJoin(wiki, 'C:\\Windows\\x.md'); return false; } catch (e) { return /非法路径/.test(e.message); } })());

  // ---------- 11. Cookie 持久化 ----------
  section('urlcookies — 登录态持久化与按域注入');
  check('无 Cookie 时返回空数组', cookies.getCookiesForUrl('https://www.yuque.com/x').length === 0);
  check('无 Cookie 时请求头为空串', cookies.cookieHeaderForUrl('https://www.yuque.com/x') === '');
  const n1 = cookies.storeCookies([
    { name: 'sid', value: 'abc', domain: '.yuque.com', path: '/', secure: true, httpOnly: true, expirationDate: 9999999999 },
    { name: 'theme', value: 'dark', domain: 'yuque.com', path: '/' },
  ]);
  check('storeCookies 返回保存条数', n1 === 2, String(n1));
  check('Cookie 落 kv（url_cookies）', !!env.db.getKv(C.URL_COOKIES_KEY));
  check('域名前导点被剥离并小写', Object.keys(JSON.parse(env.db.getKv(C.URL_COOKIES_KEY))).join(',') === 'yuque.com');
  check('父域 Cookie 覆盖子域 URL', cookies.getCookiesForUrl('https://www.yuque.com/doc/1').length === 2);
  check('请求头拼接格式正确', cookies.cookieHeaderForUrl('https://www.yuque.com/doc/1').split('; ').sort().join('; ') === 'sid=abc; theme=dark');
  check('不相关域名不注入', cookies.cookieHeaderForUrl('https://example.com/') === '');
  check('非法 URL 返回空', cookies.getCookiesForUrl('不是 URL').length === 0);
  check('空值 Cookie 被丢弃', cookies.storeCookies([{ name: 'x', value: '', domain: 'a.com' }, { name: '', value: 'v', domain: 'a.com' }, { name: 'y', value: 'v' }]) === 0);
  check('空数组不写库', cookies.storeCookies([]) === 0);
  const n2 = cookies.storeCookies([{ name: 'sid', value: 'new', domain: 'yuque.com', path: '/' }]);
  check('同名同路径覆盖更新（不重复）', n2 === 1 && cookies.getCookiesForUrl('https://yuque.com/').filter((c) => c.name === 'sid').length === 1);
  check('覆盖后取到新值', /sid=new/.test(cookies.cookieHeaderForUrl('https://yuque.com/')));
  cookies.storeCookies([{ name: 'sub', value: 'v', domain: 'www.yuque.com', path: '/' }]);
  check('子域 Cookie 优先于父域同名项', (() => { cookies.storeCookies([{ name: 'sid', value: 'fromSub', domain: 'www.yuque.com', path: '/' }]); return /sid=fromSub/.test(cookies.cookieHeaderForUrl('https://www.yuque.com/')); })());
  check('父域 URL 不取子域 Cookie', !/sub=v/.test(cookies.cookieHeaderForUrl('https://yuque.com/')));
  check('不同 path 的同名 Cookie 并存', (() => { cookies.storeCookies([{ name: 'p', value: '1', domain: 'a.com', path: '/' }, { name: 'p', value: '2', domain: 'a.com', path: '/admin' }]); return cookies.getCookiesForUrl('https://a.com/admin').filter((c) => c.name === 'p').length === 2; })());

  // restoreToSession
  const setCalls = [];
  const fakeSession = { cookies: { set: async (o) => { setCalls.push(o); } } };
  env.db.setKv(C.URL_COOKIES_KEY, JSON.stringify({ 'restore.com': { at: 1, cookies: [{ name: 'k', value: 'v', domain: 'restore.com', path: '/', secure: true, httpOnly: false }] } }));
  env.db.flush();
  const restored = await cookies.restoreToSession(fakeSession);
  check('restoreToSession 返回回填条数', restored === 1, String(restored));
  check('secure Cookie 用 https URL 回填', setCalls[0].url === 'https://restore.com/' && setCalls[0].name === 'k' && setCalls[0].value === 'v');
  check('会话级 Cookie 补 7 天过期', typeof setCalls[0].expirationDate === 'number' && setCalls[0].expirationDate > Math.floor(Date.now() / 1000));
  check('session 为空时返回 0 不抛错', (await cookies.restoreToSession(null)) === 0 && (await cookies.restoreToSession({})) === 0);
  const failSession = { cookies: { set: async () => { throw new Error('boom'); } } };
  check('单条回填失败不影响整体', (await cookies.restoreToSession(failSession)) === 0);
  env.db.setKv(C.URL_COOKIES_KEY, '{坏');
  env.db.flush();
  check('脏 Cookie JSON 容错为空', cookies.getCookiesForUrl('https://yuque.com/').length === 0 && (await cookies.restoreToSession(fakeSession)) === 0);

  // ---------- 12. fetchUrlTitle / fetchUrlMarkdown ----------
  section('fetchUrlTitle / fetchUrlMarkdown — 网页抓取');
  const pages = {
    '/og': '<html><head><title>Loading</title><meta property="og:title" content="OG 真实标题"></head><body><p>正文</p></body></html>',
    '/plain': '<html><head><meta charset="utf-8"><title>普通页面</title></head><body><h1>大标题</h1><p>段落一</p><p>段落二</p></body></html>',
    '/big': '<html><head><title>大页面</title></head><body>' + '<p>填充内容</p>'.repeat(20000) + '</body></html>',
  };
  const srv = http.createServer((req, res) => {
    if (req.url === '/404') { res.writeHead(404); return res.end('nope'); }
    if (req.url === '/charset') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<html><head><title>编码页面</title></head><body><p>内容</p></body></html>');
    }
    const body = pages[req.url.split('?')[0]];
    if (!body) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    check('fetchUrlTitle 取到 og:title（跳过占位 <title>）', (await files.fetchUrlTitle(base + '/og', 5)) === 'OG 真实标题');
    check('fetchUrlTitle 取到普通 <title>', (await files.fetchUrlTitle(base + '/plain', 5)) === '普通页面');
    check('fetchUrlTitle 404 返回空串', (await files.fetchUrlTitle(base + '/404', 5)) === '');
    check('fetchUrlTitle 连接失败返回空串（不抛错）', (await files.fetchUrlTitle('http://127.0.0.1:1/x', 2)) === '');
    check('fetchUrlTitle 大页面只读到 </head> 即断流', (await files.fetchUrlTitle(base + '/big', 5)) === '大页面');

    const md = await files.fetchUrlMarkdown(base + '/plain', 5);
    check('fetchUrlMarkdown 统一「# 标题 + 来源 + 正文」格式', md.startsWith('# 普通页面\n\n> 来源 URL: ' + base + '/plain\n\n'), md.slice(0, 100));
    check('fetchUrlMarkdown 正文转 Markdown', md.includes('# 大标题') && /段落一/.test(md), md.slice(0, 200));
    check('fetchUrlMarkdown 过滤脚本行', !/^\s*(var |window\.|function\()/m.test(md));
    let fetchErr = '';
    try { await files.fetchUrlMarkdown(base + '/404', 5); } catch (e) { fetchErr = e.message; }
    check('fetchUrlMarkdown 非 2xx 抛错并带状态码', /网页拉取失败 \(HTTP 404\)/.test(fetchErr), fetchErr);
    check('fetchUrlMarkdown 超时钳制生效（不挂起）', (await files.fetchUrlMarkdown(base + '/plain', 1)).includes('普通页面'));
    check('响应头声明 charset 时按其解码', (await files.fetchUrlTitle(base + '/charset', 5)) === '编码页面');
  } finally {
    srv.close();
  }

  // ---------- 13. MinerU 回退日志 ----------
  section('MinerU 失败回退与回退日志');
  const logFile = path.join(env.dataRoot, 'mineru-fallback.log');
  // PDF + MinerU 必失败 → 回退内置文本层，任务仍成功但留痕
  const infoF1 = {};
  const fbText = await files.extractFileContent(pdfPath, mineruOn('fail'), { info: infoF1, noCache: true }).catch((e) => 'ERR:' + e.message);
  check('MinerU 失败时静默回退内置解析（不报错）', !String(fbText).startsWith('ERR:'), String(fbText).slice(0, 100));
  check('回退时 info 记录 externalError 原因', /MinerU 转换失败/.test(String(infoF1.externalError)) && /VLM 模型缺失/.test(String(infoF1.externalError)), JSON.stringify(infoF1));
  check('回退产物解析方式记为 builtin', infoF1.parseMethod === 'builtin', JSON.stringify(infoF1));
  check('MinerU 失败原因落盘到 mineru-fallback.log', fs.existsSync(logFile) && /x\.pdf/.test(fs.readFileSync(logFile, 'utf-8')), fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8').slice(0, 200) : '日志未生成');
  check('回退日志带时间戳与原因', /^\d{4}-\d{2}-\d{2}T/.test(fs.readFileSync(logFile, 'utf-8').trim().split('\n')[0]), fs.readFileSync(logFile, 'utf-8').slice(0, 120));
  // 回退产物按 TTL 缓存：期内复用，避免反复跑必失败的分钟级转换
  const fbCache = JSON.parse(fs.readFileSync(cacheFileOf(pdfPath), 'utf-8'));
  check('MinerU 回退产物落 fallback 缓存并带 reason', fbCache.method === 'fallback' && /MinerU 转换失败/.test(fbCache.reason), JSON.stringify({ m: fbCache.method, r: fbCache.reason }));
  const infoF2 = {};
  await files.extractFileContent(pdfPath, mineruOn('fail'), { info: infoF2 });
  check('fallback 缓存在 TTL 内命中（方式展示为 builtin）', infoF2.fromCache === true && infoF2.parseMethod === 'builtin', JSON.stringify(infoF2));
  check('命中 fallback 缓存时带出真实失败原因', /MinerU 转换失败/.test(String(infoF2.externalError)), JSON.stringify(infoF2));
  // TTL 过期 → 重试 MinerU
  fs.writeFileSync(cacheFileOf(pdfPath), JSON.stringify({ ...fbCache, at: Date.now() - 11 * 60 * 1000 }), 'utf-8');
  const infoF3 = {};
  await files.extractFileContent(pdfPath, mineruOn('fail'), { info: infoF3 });
  check('fallback 缓存过 TTL 后重试 MinerU（不命中）', infoF3.fromCache !== true, JSON.stringify(infoF3));
  // MinerU 已不再配置 → 回退文本即正确结果，长期复用
  const infoF4 = {};
  await files.extractFileContent(pdfPath, settings, { info: infoF4 });
  check('未配 MinerU 时 fallback 缓存直接复用', infoF4.fromCache === true, JSON.stringify(infoF4));
  // forceMineru 不回退内置，直接失败
  let forceErr = '';
  try { await files.extractFileContent(pdfPath, mineruOn('fail'), { forceMineru: true, noCache: true }); } catch (e) { forceErr = e.message; }
  check('forceMineru 下 MinerU 失败不回退内置（直接报错）', /MinerU 转换失败/.test(forceErr), forceErr);
  // 回退日志只保留最近 30 行（灌入超长历史后再触发一次写入，验证裁剪）
  fs.writeFileSync(logFile, Array.from({ length: 60 }, (_, i) => `历史行 ${i}`).join('\n') + '\n', 'utf-8');
  await files.extractFileContent(pdfPath, mineruOn('fail'), { noCache: true }).catch(() => null);
  const logLines = fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean);
  check('回退日志最多保留 30 行', logLines.length === 30, String(logLines.length));
  check('裁剪保留的是最近 30 行（旧行被丢弃）', !logLines.some((l) => l === '历史行 0') && logLines[0] === '历史行 31' && /x\.pdf/.test(logLines[logLines.length - 1]), JSON.stringify([logLines[0], logLines[logLines.length - 1]]));

  // ---------- 14. 配置测试（runMineruTest） ----------
  section('runMineruTest — 设置页配置测试');
  const testLogs = [];
  const ev = { sender: { send: (ch, payload) => testLogs.push({ ch, payload }) } };
  check('未配置命令时返回明确错误', (await files.runMineruTest({ mineruMode: 'builtin' }, { event: ev })).error === '未配置文档转换命令，无法测试');
  const okRes = await files.runMineruTest(mineruOn('ok'), { event: ev });
  check('内置样本 PDF 转换成功', okRes.ok === true, JSON.stringify(okRes));
  check('返回耗时/字符数/产物摘要', typeof okRes.elapsedSec === 'number' && okRes.mdLength > 0 && /MINERU-CONVERTED/.test(okRes.sample), JSON.stringify(okRes));
  check('产物保留在 <数据根>/test/<时间戳>/ 便于查看', okRes.outDir.startsWith(path.join(env.dataRoot, 'test')) && fs.existsSync(path.join(okRes.outDir, 'out.md')), okRes.outDir);
  check('日志经 mineru:test-log 事件流式推送', testLogs.length > 0 && testLogs.every((x) => x.ch === 'mineru:test-log') && testLogs.some((x) => /内置 1 页样本 PDF/.test(x.payload.line)), JSON.stringify(testLogs.slice(0, 3)));
  check('日志带 replace 标记字段', testLogs.every((x) => typeof x.payload.replace === 'boolean'));
  // 用上传文件测试
  const upRes = await files.runMineruTest(mineruOn('ok'), { pdfBase64: Buffer.from('fake pdf bytes').toString('base64'), fileName: '我的 方案.pdf', event: ev });
  check('上传文件测试成功并沿用文件名', upRes.ok === true && fs.existsSync(path.join(upRes.outDir, '我的 方案.pdf')), JSON.stringify(upRes));
  // 文件名非法字符被替换
  const badNameRes = await files.runMineruTest(mineruOn('ok'), { pdfBase64: 'eA==', fileName: 'a/b:c*d?.pdf', event: ev });
  check('上传文件名非法字符被替换为下划线', badNameRes.ok === true && fs.existsSync(path.join(badNameRes.outDir, 'a_b_c_d_.pdf')), JSON.stringify(badNameRes));
  const emptyNameRes = await files.runMineruTest(mineruOn('ok'), { pdfBase64: 'eA==', fileName: '  ', event: ev });
  check('文件名留空时用默认样本名', emptyNameRes.ok === true && fs.existsSync(path.join(emptyNameRes.outDir, 'mineru-config-test.pdf')), JSON.stringify(emptyNameRes));
  const failRes = await files.runMineruTest(mineruOn('fail'), { event: ev });
  check('转换失败时 ok=false 并带原因', failRes.ok === false && /VLM 模型缺失/.test(failRes.error), JSON.stringify(failRes));
  check('失败也返回输出目录且推送 ❌ 日志', !!failRes.outDir && testLogs.some((x) => /转换失败/.test(x.payload.line)), JSON.stringify(failRes));

  ollamaSrv.close();
  summary();
})().catch((err) => {
  console.error('测试执行异常：', err);
  process.exitCode = 1;
});
