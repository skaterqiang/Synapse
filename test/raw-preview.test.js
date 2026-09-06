// 原始 Markdown 应用内只读预览测试（raws/preview.js + raw:preview IPC）
// 覆盖：可预览判定（md/markdown，排除 url:）、来源解析（local:/raw 副本/越界拒绝）、
//      读取返回 { text, name, dir }、只读保证（不写入笔记库）、
//      图片白名单（仅图片扩展名、仅已登记目录内、子目录放行、父目录不放行、LRU 上限）、
//      IPC 契约（成功带 dir，失败 ok=false 带 error）。
// 运行：node test/raw-preview.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bootEnv, mkCheck, writeFile } = require('./helpers/harness');

const { check, section, summary } = mkCheck('原始 Markdown 应用内预览');

(async () => {
  const env = await bootEnv({ prefix: 'synapse-rawpreview-' });
  const preview = require('../src/main/raws/preview');
  const settingsMod = require('../src/main/common/settings');
  const store = require('../src/main/notes/store');

  const wiki = path.join(env.dir, 'wiki');
  const rawDir = path.join(wiki, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  const settings = { ...settingsMod.getSettings(), wikiRoot: wiki };

  // ---------- 1. isPreviewable ----------
  section('isPreviewable — 仅本地 md/markdown 走应用内');
  check('.md 可预览', preview.isPreviewable('raw/a.md') === true);
  check('.markdown 可预览', preview.isPreviewable('raw/a.markdown') === true);
  check('扩展名大小写不敏感', preview.isPreviewable('raw/A.MD') === true && preview.isPreviewable('raw/A.MarkDown') === true);
  check('local: 绝对路径的 md 可预览', preview.isPreviewable('local:D:\\docs\\a.md') === true);
  check('url: 链接一律不可预览（交浏览器）', preview.isPreviewable('url:https://x.com/a.md') === false);
  check('非 md 类型不可预览', ['raw/a.pdf', 'raw/a.docx', 'raw/a.txt', 'raw/a.csv', 'raw/a.html', 'raw/a.png'].every((p) => preview.isPreviewable(p) === false));
  check('扩展名须在结尾（.md.bak 不算）', preview.isPreviewable('raw/a.md.bak') === false);
  check('空值/ null 不可预览', preview.isPreviewable('') === false && preview.isPreviewable(null) === false && preview.isPreviewable(undefined) === false);

  // ---------- 2. resolveRawPath ----------
  section('resolveRawPath — 与 raw:open 同口径的来源解析');
  check('raw 副本相对路径拼到 rawsRoot', preview.resolveRawPath(settings, 'raw/a.md') === path.join(wiki, 'raw', 'a.md'));
  check('前导斜杠被剥离', preview.resolveRawPath(settings, '/raw/a.md') === path.join(wiki, 'raw', 'a.md'));
  check('local: 前缀取本机绝对路径', preview.resolveRawPath(settings, 'local:' + path.join(env.dir, 'x.md')) === path.join(env.dir, 'x.md'));
  check('结果为绝对路径', path.isAbsolute(preview.resolveRawPath(settings, 'raw/a.md')));
  check('url: 抛错并提示走浏览器', (() => { try { preview.resolveRawPath(settings, 'url:https://x.com/a.md'); return false; } catch (e) { return /浏览器/.test(e.message); } })());
  check('空来源抛错', (() => { try { preview.resolveRawPath(settings, ''); return false; } catch (e) { return /无效来源/.test(e.message); } })());
  check('拒绝 ../ 越界', (() => { try { preview.resolveRawPath(settings, '../escape.md'); return false; } catch (e) { return /非法路径/.test(e.message); } })());
  check('拒绝深层 ../ 越界', (() => { try { preview.resolveRawPath(settings, 'raw/../../escape.md'); return false; } catch (e) { return /非法路径/.test(e.message); } })());

  // ---------- 3. readMarkdown ----------
  section('readMarkdown — 读取正文并返回所在目录');
  const mdPath = writeFile(path.join(rawDir, '带图笔记.md'), '# 标题\n\n![图](images/a.png)\n\n正文\n');
  const r = preview.readMarkdown(settings, 'raw/带图笔记.md');
  check('返回正文原文（不改写）', r.text === fs.readFileSync(mdPath, 'utf-8'), JSON.stringify(r.text));
  check('返回文件名', r.name === '带图笔记.md', r.name);
  check('返回所在目录（供渲染层解析相对资源）', r.dir === rawDir, r.dir);
  check('.markdown 同样可读', (() => { writeFile(path.join(rawDir, 'b.markdown'), 'x'); return preview.readMarkdown(settings, 'raw/b.markdown').name === 'b.markdown'; })());
  // 注意：local: 用例的目录必须独立于 env.dir，否则 env.dir 本身会被登记为白名单根，
  // 使后面「未登记目录/父目录/同前缀目录」的否定断言全部失真
  check('local: 绝对路径可读', (() => { const p = writeFile(path.join(env.dir, 'external', 'out.md'), '外部'); return preview.readMarkdown(settings, 'local:' + p).text === '外部'; })());
  check('local: 预览登记的是文件所在目录（非 env.dir 本身）', preview.isAllowedAsset(path.join(env.dir, 'external', 'i.png')) === true && preview.isAllowedAsset(path.join(env.dir, 'i.png')) === false);
  check('非 md 文件被拒（即使存在）', (() => { writeFile(path.join(rawDir, 'c.txt'), 'x'); try { preview.readMarkdown(settings, 'raw/c.txt'); return false; } catch (e) { return /仅支持预览 Markdown/.test(e.message); } })());
  check('文件不存在时报错带路径', (() => { try { preview.readMarkdown(settings, 'raw/没有.md'); return false; } catch (e) { return /文件不存在/.test(e.message) && e.message.includes('没有.md'); } })());
  check('目录不被当作文件读取', (() => { fs.mkdirSync(path.join(rawDir, 'dir.md'), { recursive: true }); try { preview.readMarkdown(settings, 'raw/dir.md'); return false; } catch (e) { return /文件不存在/.test(e.message); } })());
  check('空文件可读（返回空串）', (() => { writeFile(path.join(rawDir, 'empty.md'), ''); return preview.readMarkdown(settings, 'raw/empty.md').text === ''; })());

  // ---------- 4. 只读保证 ----------
  section('只读 — 预览不写入笔记库、不改原文件');
  const noteRoot = store.notesRoot();
  const before = fs.existsSync(noteRoot) ? fs.readdirSync(noteRoot).sort().join('|') : '<无目录>';
  const beforeText = fs.readFileSync(mdPath, 'utf-8');
  preview.readMarkdown(settings, 'raw/带图笔记.md');
  const after = fs.existsSync(noteRoot) ? fs.readdirSync(noteRoot).sort().join('|') : '<无目录>';
  check('笔记库目录未新增文件', before === after, `${before} → ${after}`);
  check('原文件内容未被改写', fs.readFileSync(mdPath, 'utf-8') === beforeText);

  // ---------- 5. 图片白名单 ----------
  section('isAllowedAsset — 仅放行已登记预览目录内的图片');
  check('已登记目录内的 png 放行', preview.isAllowedAsset(path.join(rawDir, 'images', 'a.png')) === true);
  check('已登记目录内直接子文件放行', preview.isAllowedAsset(path.join(rawDir, 'b.jpg')) === true);
  check('多种图片扩展名放行', ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'avif', 'ico'].every((ext) => preview.isAllowedAsset(path.join(rawDir, 'x.' + ext)) === true));
  check('扩展名大小写不敏感', preview.isAllowedAsset(path.join(rawDir, 'X.PNG')) === true);
  check('非图片扩展名一律拒绝（不开任意文件读取口子）', ['md', 'txt', 'pdf', 'json', 'js', 'exe', ''].every((ext) => preview.isAllowedAsset(path.join(rawDir, 'x' + (ext ? '.' + ext : ''))) === false));
  check('未登记目录内的图片拒绝', preview.isAllowedAsset(path.join(env.dir, 'elsewhere', 'a.png')) === false);
  check('已登记目录的父目录不放行（不做前缀误匹配）', preview.isAllowedAsset(path.join(wiki, 'a.png')) === false);
  check('同级同前缀目录不放行（raw 与 raw2）', (() => { const d2 = path.join(wiki, 'raw2'); fs.mkdirSync(d2, { recursive: true }); return preview.isAllowedAsset(path.join(d2, 'a.png')) === false; })());
  // 正文里的相对路径可能带 ../（marked 不会归一），解析后落到白名单目录之外必须拒绝
  check('../ 逃逸出已登记目录被拒', preview.isAllowedAsset(path.join(rawDir, '..', 'escape', 'a.png')) === false);
  check('多层 ../ 逃逸被拒', preview.isAllowedAsset(path.join(rawDir, 'images', '..', '..', '..', 'escape', 'a.png')) === false);
  check('空值/ null 拒绝', preview.isAllowedAsset('') === false && preview.isAllowedAsset(null) === false);
  check('相对路径按 cwd 解析后仍拒绝', preview.isAllowedAsset('images/a.png') === false);
  check('新预览的目录被登记', (() => { const d = path.join(env.dir, 'other'); writeFile(path.join(d, 'n.md'), 'x'); preview.readMarkdown(settings, 'local:' + path.join(d, 'n.md')); return preview.isAllowedAsset(path.join(d, 'i.png')) === true; })());
  check('登记不影响兄弟目录', preview.isAllowedAsset(path.join(env.dir, 'sibling', 'i.png')) === false);

  section('isAllowedAsset — 白名单有界（LRU 上限 16）');
  const dirs = [];
  for (let i = 0; i < 20; i++) {
    const d = path.join(os.tmpdir(), 'synapse-lru-' + i);
    writeFile(path.join(d, 'n.md'), 'x');
    preview.readMarkdown(settings, 'local:' + path.join(d, 'n.md'));
    dirs.push(d);
  }
  check('最新登记的目录仍放行', preview.isAllowedAsset(path.join(dirs[19], 'a.png')) === true);
  check('超出上限后最旧目录被淘汰', preview.isAllowedAsset(path.join(dirs[0], 'a.png')) === false);
  check('淘汰是有界的（不会无限增长）', dirs.slice(0, 3).every((d) => preview.isAllowedAsset(path.join(d, 'a.png')) === false));
  check('上限内的较新目录仍放行', dirs.slice(-16).every((d) => preview.isAllowedAsset(path.join(d, 'a.png')) === true));

  // ---------- 6. IPC 契约 ----------
  section('raw:preview — IPC 契约');
  const { registerIpc } = require('../src/main/ipc');
  registerIpc(() => ({ isDestroyed: () => false, webContents: { send: () => {} } }));
  const ok = await env.el.invoke('raw:preview', { settings, relPath: 'raw/带图笔记.md' });
  check('成功返回 ok=true', ok.ok === true, JSON.stringify(ok));
  check('成功返回 text/name/dir', ok.text === beforeText && ok.name === '带图笔记.md' && ok.dir === rawDir, JSON.stringify({ name: ok.name, dir: ok.dir }));
  check('返回体不含多余字段', Object.keys(ok).sort().join(',') === 'dir,name,ok,text', Object.keys(ok).sort().join(','));
  const bad = await env.el.invoke('raw:preview', { settings, relPath: 'raw/没有.md' });
  check('失败返回 ok=false 且不抛异常', bad.ok === false && !!bad.error, JSON.stringify(bad));
  check('失败带可读原因', /文件不存在/.test(bad.error), bad.error);
  const badType = await env.el.invoke('raw:preview', { settings, relPath: 'raw/c.txt' });
  check('非 md 类型失败并说明限制', badType.ok === false && /仅支持预览 Markdown/.test(badType.error), JSON.stringify(badType));
  const badUrl = await env.el.invoke('raw:preview', { settings, relPath: 'url:https://x.com/a.md' });
  check('url: 来源失败并提示浏览器', badUrl.ok === false && /浏览器/.test(badUrl.error), JSON.stringify(badUrl));
  const badArgs = await env.el.invoke('raw:preview', {});
  check('缺参数不崩（ok=false）', badArgs.ok === false && !!badArgs.error, JSON.stringify(badArgs));

  summary();
})().catch((err) => {
  console.error('测试执行异常：', err);
  process.exitCode = 1;
});
