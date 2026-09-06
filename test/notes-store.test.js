// 笔记存储模块测试（notes/store.js）
// 覆盖：笔记落盘/读取（frontmatter 序列化与解析往返）、目录树合成与清理、垃圾桶语义、
//      附件引用归一、importNote 同源更新与移出垃圾桶、URL 编码标题迁移幂等、
//      旧 assets/ 附件迁移、数据库存量笔记迁移、空列表回写防御、重名冲突处理。
// 运行：node test/notes-store.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { bootEnv, mkCheck, writeFile } = require('./helpers/harness');

const { check, section, summary } = mkCheck('笔记存储模块');
const TRASH = 'trash';
const TRASH_ID = '__trash__';

(async () => {
  const env = await bootEnv({ prefix: 'synapse-notes-' });
  const dir = env.dir;
  const settingsMod = require('../src/main/common/settings');
  const store = require('../src/main/notes/store');
  const paths = require('../src/main/common/paths');

  const root = store.notesRoot();
  check('notesRoot 指向 <dataRoot>/note', root === path.join(env.dataRoot, 'note'), root);
  check('TRASH_DIR 常量导出', store.TRASH_DIR === TRASH);

  // 直接写笔记文件（模拟磁盘既有内容）
  const writeNote = (rel, n) => writeFile(path.join(root, rel), [
    '---',
    `id: ${n.id}`,
    `title: "${String(n.title || '').replace(/"/g, '\\"')}"`,
    `tags: ${JSON.stringify(n.tags || [])}`,
    `pinned: ${n.pinned ? 1 : 0}`,
    `favorited: ${n.favorited ? 1 : 0}`,
    `createdAt: ${n.createdAt || 100}`,
    `updatedAt: ${n.updatedAt || 200}`,
    ...(n.trashFrom != null ? [`trashFrom: "${n.trashFrom}"`] : []),
    ...(n.source ? [`source: ${n.source}`] : []),
    '---',
    '',
    n.content || '',
  ].join('\n'));

  // ---------- 1. frontmatter 往返 ----------
  section('frontmatter 序列化与解析往返');
  writeNote('基础笔记.md', { id: 'n1', title: '基础笔记', tags: ['电力', '扩容'], pinned: true, favorited: true, createdAt: 111, updatedAt: 222, content: '# 标题\n\n正文内容。' });
  // 文件名不能含引号（Windows 非法），但 frontmatter 标题可以——正好验证转义往返
  writeNote('引号嵌套.md', { id: 'n2', title: '引号"嵌套"', tags: [], content: '含引号标题' });
  writeNote('多行source.md', { id: 'n3', title: '多行来源', source: 'local:/abs/path 备注', content: '来源带空格' });
  writeNote('无id笔记.md', { id: '', title: '无id笔记', content: 'id 缺失时回退 file: 键' });
  writeNote('坏tags.md', { id: 'n5', title: '坏tags', tags: null, content: 'tags 非 JSON 时容错' });
  fs.writeFileSync(path.join(root, '坏tags.md'), fs.readFileSync(path.join(root, '坏tags.md'), 'utf-8').replace('tags: null', 'tags: {不是JSON'), 'utf-8');

  let notes = store.getNotes();
  const byId = (id) => notes.find((n) => n.id === id);
  check('读取到全部笔记文件', notes.length >= 5, String(notes.length));
  const n1 = byId('n1');
  check('标题/标签/置顶/收藏/时间往返一致', n1.title === '基础笔记' && n1.tags.join(',') === '电力,扩容' && n1.pinned === true && n1.favorited === true && n1.createdAt === 111 && n1.updatedAt === 222, JSON.stringify(n1));
  check('正文完整保留', n1.content === '# 标题\n\n正文内容。', JSON.stringify(n1.content));
  check('含引号标题正确反转义', byId('n2').title === '引号"嵌套"', byId('n2').title);
  check('source 字段解析', byId('n3').source === 'local:/abs/path 备注', byId('n3').source);
  check('id 缺失回退 file: 相对路径键', notes.some((n) => String(n.id).startsWith('file:') && n.title === '无id笔记'), JSON.stringify(notes.map((n) => n.id)));
  check('tags 非 JSON 容错为空数组', Array.isArray(byId('n5').tags) && byId('n5').tags.length === 0, JSON.stringify(byId('n5').tags));
  check('pinned/favorited 缺省为 false', byId('n2').pinned === false && byId('n2').favorited === false);
  check('笔记按 updatedAt 倒序', notes[0].updatedAt >= notes[notes.length - 1].updatedAt);

  // ---------- 2. 目录树 ----------
  section('目录树合成与笔记归属');
  writeNote('电力/充电桩.md', { id: 'd1', title: '充电桩', content: '目录内笔记' });
  writeNote('电力/配电/变压器.md', { id: 'd2', title: '变压器', content: '二级目录笔记' });
  notes = store.getNotes();
  const folders = store.loadStore().folders;
  check('磁盘目录被合成为文件夹记录', folders.some((f) => f.name === '电力') && folders.some((f) => f.name === '配电'), JSON.stringify(folders.map((f) => f.name)));
  check('垃圾桶为虚拟根级目录且不落库', folders.some((f) => f.id === TRASH_ID && f.name === '垃圾桶') && !env.db.all('SELECT id FROM folders').some((r) => r.id === TRASH_ID));
  const d1 = notes.find((n) => n.id === 'd1');
  const d2 = notes.find((n) => n.id === 'd2');
  check('一级目录笔记归属正确', d1.folderId && folders.find((f) => f.id === d1.folderId).name === '电力', String(d1.folderId));
  check('二级目录笔记归属正确且 parentId 链正确', d2.folderId && folders.find((f) => f.id === d2.folderId).name === '配电', String(d2.folderId));
  check('目录层级父子关系正确', (() => { const pei = folders.find((f) => f.name === '配电'); const pa = folders.find((f) => f.id === pei.parentId); return pa && pa.name === '电力'; })());
  check('根目录笔记 folderId 为 null', byId('n1') === undefined || notes.find((n) => n.id === 'n1').folderId === null, JSON.stringify(notes.find((n) => n.id === 'n1').folderId));

  // 空目录（无 .md）被清理；笔记自身附件目录保留
  fs.mkdirSync(path.join(root, '空目录'), { recursive: true });
  fs.mkdirSync(path.join(root, '电力', '充电桩'), { recursive: true });   // 笔记自身附件目录
  writeFile(path.join(root, '电力', '充电桩', 'img.png'), 'x');
  notes = store.getNotes();
  check('无笔记的空目录被清理', !fs.existsSync(path.join(root, '空目录')));
  check('笔记自身附件目录（含图片）被保留', fs.existsSync(path.join(root, '电力', '充电桩', 'img.png')));
  check('附件目录不被合成为文件夹', !store.loadStore().folders.some((f) => f.name === '充电桩' && f.id !== 'd1'), JSON.stringify(store.loadStore().folders.filter((f) => f.name === '充电桩')));

  // hasAnyNoteFile
  check('hasAnyNoteFile 为真（磁盘有笔记）', store.loadStore().hasAnyNoteFile === true);

  // ---------- 3. 垃圾桶语义 ----------
  section('垃圾桶语义');
  writeNote('trash/被删笔记.md', { id: 't1', title: '被删笔记', trashFrom: '电力', content: '垃圾桶内笔记' });
  writeNote('trash/无trashFrom.md', { id: 't2', title: '无trashFrom', content: '历史残留：无 trashFrom' });
  notes = store.getNotes();
  const t1 = notes.find((n) => n.id === 't1');
  const t2 = notes.find((n) => n.id === 't2');
  check('带 trashFrom 的 trash 笔记标为 trashed', t1.trashed === true && t1.trashFrom === '电力', JSON.stringify({ trashed: t1.trashed, from: t1.trashFrom }));
  check('trashed 笔记 folderId 为 null（不参与目录树）', t1.folderId === null);
  check('无 trashFrom 的 trash 笔记视为根目录笔记', t2.trashed === false && t2.trashFrom === undefined, JSON.stringify({ trashed: t2.trashed, from: t2.trashFrom }));
  check('非垃圾桶笔记不暴露 trashFrom', notes.find((n) => n.id === 'n1').trashFrom === undefined);
  check('trash/ 不被合成为文件夹', !store.loadStore().folders.some((f) => f.name === TRASH && f.id !== TRASH_ID));

  // ---------- 4. saveStore 写盘 ----------
  section('saveStore — 写盘与删除防御');
  const st = store.loadStore();
  const newNote = { id: 's1', title: '新建笔记', tags: ['新'], pinned: false, favorited: false, createdAt: 1, updatedAt: 3, content: '通过 saveStore 写入', folderId: null };
  store.saveStore({ ...st, notes: [...st.notes, newNote] });
  check('saveStore 写入新笔记文件', fs.existsSync(path.join(root, '新建笔记.md')));
  check('新笔记可被读回', store.getNotes().some((n) => n.id === 's1' && n.content === '通过 saveStore 写入'));
  check('新笔记建立同名附件目录', fs.existsSync(path.join(root, '新建笔记')));

  // 移出列表的垃圾桶外文件 → 移入 trash 保留（绝不直接删）
  const st2 = store.loadStore();
  store.saveStore({ ...st2, notes: st2.notes.filter((n) => n.id !== 's1') });
  check('移出列表的笔记被移入 trash 而非删除', !fs.existsSync(path.join(root, '新建笔记.md')) && fs.existsSync(path.join(root, TRASH, '新建笔记.md')));
  check('移入 trash 时补写 trashFrom 标记', (() => { const txt = fs.readFileSync(path.join(root, TRASH, '新建笔记.md'), 'utf-8'); return /trashFrom: ""/.test(txt); })());

  // 清空垃圾桶：trash 内文件移出列表即真删
  const st3 = store.loadStore();
  const before = fs.existsSync(path.join(root, TRASH, '新建笔记.md'));
  store.saveStore({ ...st3, notes: st3.notes.filter((n) => n.id !== 's1') });
  check('trash 内笔记移出列表后被真删（清空垃圾桶）', before && !fs.existsSync(path.join(root, TRASH, '新建笔记.md')));

  // 空列表回写防御：垃圾桶外文件全部移入 trash，不丢失
  const stAll = store.loadStore();
  const withId = stAll.notes.filter((n) => !String(n.id).startsWith('file:'));
  store.saveStore({ ...stAll, notes: [] });
  const leftOutside = fs.readdirSync(root).filter((f) => f.endsWith('.md'));
  check('空列表回写后带 id 的笔记全部离开笔记根', leftOutside.length <= stAll.notes.length - withId.length, JSON.stringify(leftOutside));
  const trashedNow = fs.readdirSync(path.join(root, TRASH)).filter((f) => f.endsWith('.md'));
  check('空列表回写时垃圾桶外笔记移入 trash 而非删除（数据不丢）', trashedNow.length >= withId.filter((n) => !n.trashed).length, trashedNow.length + '/' + withId.length);
  check('无 frontmatter id 的文件不被误搬（file: 键跳过）', leftOutside.includes('无id笔记.md'), JSON.stringify(leftOutside));
  check('trash/ 目录常驻不被清理', fs.existsSync(path.join(root, TRASH)));

  // ---------- 5. 重名冲突 ----------
  section('同目录重名冲突处理');
  const stR = store.loadStore();
  store.saveStore({ ...stR, notes: [
    { id: 'c1', title: '同名', tags: [], pinned: false, favorited: false, createdAt: 1, updatedAt: 5, content: '第一篇', folderId: null },
    { id: 'c2', title: '同名', tags: [], pinned: false, favorited: false, createdAt: 1, updatedAt: 6, content: '第二篇', folderId: null },
  ] });
  const sameName = fs.readdirSync(root).filter((f) => f.startsWith('同名') && f.endsWith('.md'));
  check('同目录重名笔记追加短 id 后缀避免覆盖', sameName.length === 2, JSON.stringify(sameName));
  check('两篇重名笔记内容都在', store.getNotes().filter((n) => n.title === '同名').map((n) => n.content).sort().join('|') === '第一篇|第二篇');

  // ---------- 6. importNote ----------
  section('importNote — 落盘与同源更新');
  store.saveStore({ ...store.loadStore(), notes: [] });   // 清场
  const r1 = store.importNote('导入笔记', '第一次内容', '资料/电力', 'local:/abs/a.md');
  check('importNote 新建返回 updated=false', r1.updated === false && !!r1.id && r1.id.startsWith('import:'), JSON.stringify(r1));
  check('importNote 建立目录链并落盘到目录内', fs.existsSync(r1.path) && r1.path.includes(path.join('资料', '电力')), r1.path);
  check('importNote 带 folderId（非根目录）', !!r1.folderId);
  check('目录链被合成（资料 → 电力）', (() => { const fs2 = store.loadStore().folders; return fs2.some((f) => f.name === '资料') && fs2.some((f) => f.name === '电力'); })());

  const r2 = store.importNote('导入笔记', '第二次内容（更新）', '资料/电力', 'local:/abs/a.md');
  check('同 source 再次导入 → 原地更新不新建', r2.updated === true && r2.id === r1.id, JSON.stringify(r2));
  check('更新后正文被替换', store.getNotes().find((n) => n.id === r1.id).content === '第二次内容（更新）');
  check('更新不产生重复文件', store.getNotes().filter((n) => n.source === 'local:/abs/a.md').length === 1, String(store.getNotes().filter((n) => n.source === 'local:/abs/a.md').length));

  const r3 = store.importNote('另一篇', '不同来源', '资料/电力', 'local:/abs/b.md');
  check('不同 source 新建独立笔记', r3.updated === false && r3.id !== r1.id);

  // 移出垃圾桶：trash 内同源笔记 + 明确目标目录 → 迁回目录
  const trashNote = store.importNote('待迁回', '内容', '', 'local:/abs/trash.md');
  // 手动把它移进 trash 并标 trashed
  const stT = store.loadStore();
  const tn = stT.notes.find((n) => n.id === trashNote.id);
  tn.trashed = true; tn.trashFrom = ''; tn.folderId = null;
  store.saveStore({ ...stT, notes: stT.notes });
  check('前置：笔记已在 trash', fs.existsSync(path.join(root, TRASH, '待迁回.md')), JSON.stringify(fs.readdirSync(path.join(root, TRASH))));
  const r4 = store.importNote('待迁回', '迁回后内容', '资料/电力', 'local:/abs/trash.md');
  check('同源 + 明确目录 → 笔记移出垃圾桶', r4.updated === true && !r4.path.includes(TRASH), r4.path);
  check('迁回后 trashed 标记被清除', store.getNotes().find((n) => n.id === r4.id).trashed === false);
  check('迁回后落到目标目录', r4.path.includes(path.join('资料', '电力')), r4.path);

  // 无 folderRel → 落笔记根
  const r5 = store.importNote('根目录笔记', '内容', '', 'local:/abs/root.md');
  check('无目录参数时落笔记根', path.dirname(r5.path) === root, r5.path);
  check('标题为空回退「无标题笔记」', store.importNote('', '内容', '', 'local:/abs/empty.md').title === '无标题笔记');
  check('非法文件名字符被替换', (() => { const r = store.importNote('a/b:c*d', '内容', '', 'local:/abs/bad.md'); return !/[\\/:*?"<>|]/.test(path.basename(r.path)); })());

  // ---------- 7. noteAssetDir / notesDirFor ----------
  section('noteAssetDir / notesDirFor');
  check('noteAssetDir 根目录笔记', store.noteAssetDir('某笔记', null, false) === path.join(root, '某笔记'), store.noteAssetDir('某笔记', null, false));
  check('noteAssetDir trashed 落 trash 下', store.noteAssetDir('某笔记', null, true) === path.join(root, TRASH, '某笔记'));
  check('notesDirFor 无目录返回笔记根', store.notesDirFor(null, false) === root);
  check('notesDirFor trashed 返回 trash', store.notesDirFor('fid', true) === path.join(root, TRASH));

  // ---------- 8. 附件引用归一 ----------
  section('kb-asset 附件引用归一');
  const legacyAssets = paths.assetsDir();
  const legacyUrl = paths.kbAssetUrlFor(path.join(legacyAssets, '旧附件目录')) + '/img.png';
  writeNote('含旧附件.md', { id: 'a1', title: '含旧附件', content: `![图](${legacyUrl})` });
  notes = store.getNotes();
  const a1 = notes.find((n) => n.id === 'a1');
  check('历史 assets/ 引用被归一到笔记自身目录', !a1.content.includes(paths.kbAssetUrlFor(legacyAssets)) && a1.content.includes(paths.kbAssetUrlFor(path.join(root, '含旧附件'))), a1.content);
  check('归一结果被回写磁盘', fs.readFileSync(path.join(root, '含旧附件.md'), 'utf-8').includes(paths.kbAssetUrlFor(path.join(root, '含旧附件'))));

  // rewriteNoteFiles 显式重写
  writeNote('待重写.md', { id: 'a2', title: '待重写', content: `![图](${paths.kbAssetUrlFor('/from/dir')}/x.png)` });
  store.rewriteNoteFiles('/from/dir', '/to/dir');
  check('rewriteNoteFiles 替换前缀', store.getNotes().find((n) => n.id === 'a2').content.includes(paths.kbAssetUrlFor('/to/dir')));

  // ---------- 9. migrateEncodedNoteTitles ----------
  section('migrateEncodedNoteTitles — URL 编码标题迁移');
  const enc = encodeURIComponent('知识图谱导论');
  writeNote(enc + '.md', { id: 'e1', title: enc, content: '编码标题笔记' });
  store.migrateEncodedNoteTitles();
  check('编码标题被解码', store.getNotes().find((n) => n.id === 'e1').title === '知识图谱导论', store.getNotes().find((n) => n.id === 'e1').title);
  check('笔记文件改名为解码名', fs.existsSync(path.join(root, '知识图谱导论.md')) && !fs.existsSync(path.join(root, enc + '.md')));
  const beforeMtime = fs.statSync(path.join(root, '知识图谱导论.md')).mtimeMs;
  store.migrateEncodedNoteTitles();
  check('迁移幂等（已解码不再处理）', store.getNotes().find((n) => n.id === 'e1').title === '知识图谱导论' && fs.existsSync(path.join(root, '知识图谱导论.md')));

  // 附件目录随迁
  const enc2 = encodeURIComponent('带附件');
  writeNote(enc2 + '.md', { id: 'e2', title: enc2, content: 'x' });
  fs.mkdirSync(path.join(root, enc2), { recursive: true });
  writeFile(path.join(root, enc2, 'p.png'), 'x');
  store.migrateEncodedNoteTitles();
  check('编码标题的同名附件目录随迁', fs.existsSync(path.join(root, '带附件', 'p.png')) && !fs.existsSync(path.join(root, enc2)));

  // ---------- 10. migrateAssetsToNoteDirs ----------
  section('migrateAssetsToNoteDirs — 旧附件迁移');
  fs.mkdirSync(path.join(legacyAssets, '迁移目标'), { recursive: true });
  writeFile(path.join(legacyAssets, '迁移目标', 'old.png'), 'x');
  writeNote('迁移目标.md', { id: 'm1', title: '迁移目标', content: `![图](${paths.kbAssetUrlFor(path.join(legacyAssets, '迁移目标'))}/old.png)` });
  store.migrateAssetsToNoteDirs();
  check('附件从 assets/ 迁到笔记自身目录', fs.existsSync(path.join(root, '迁移目标', 'old.png')));
  check('旧 assets 目录被清空移除', !fs.existsSync(path.join(legacyAssets, '迁移目标')));
  check('正文引用被重写到新目录', store.getNotes().find((n) => n.id === 'm1').content.includes(paths.kbAssetUrlFor(path.join(root, '迁移目标'))));

  // ---------- 11. migrateDbNotesToFiles ----------
  section('migrateDbNotesToFiles — 数据库存量迁移');
  // 建 notes 表并塞入存量笔记
  env.db.run('CREATE TABLE IF NOT EXISTS notes (id TEXT, title TEXT, content TEXT, tags TEXT, folder_id TEXT, pinned INTEGER, created_at INTEGER, updated_at INTEGER)');
  env.db.run("INSERT INTO notes (id, title, content, tags, folder_id, pinned, created_at, updated_at) VALUES ('db1', '库内笔记', '数据库正文', '[\"库标签\"]', NULL, 1, 5, 6)");
  env.db.flush();
  store.migrateDbNotesToFiles();
  check('数据库笔记落盘为文件', store.getNotes().some((n) => n.id === 'db1' && n.content === '数据库正文' && n.title === '库内笔记'));
  check('落盘保留标签与置顶', (() => { const n = store.getNotes().find((x) => x.id === 'db1'); return n.tags.join(',') === '库标签' && n.pinned === true; })());
  check('迁移后清空 notes 表', env.db.all('SELECT COUNT(*) AS c FROM notes')[0].c === 0);
  check('无 notes 表时迁移不抛错', (() => { env.db.run('DROP TABLE notes'); env.db.flush(); store.migrateDbNotesToFiles(); return true; })());

  // ---------- 12. importLegacy ----------
  section('importLegacy — 旧数据导入');
  env.db.run('DELETE FROM folders'); env.db.flush();
  store.importLegacy({ folders: [{ id: 'f1', name: '旧目录', parentId: null }], notes: [{ id: 'l1', title: '旧笔记', tags: [], pinned: false, favorited: false, createdAt: 1, updatedAt: 2, content: '旧内容', folderId: 'f1' }], settings: { someKey: 'v' } });
  check('旧目录入库', env.db.all('SELECT name FROM folders').some((r) => r.name === '旧目录'));
  check('旧笔记落盘到对应目录', store.getNotes().some((n) => n.id === 'l1' && n.content === '旧内容'));
  check('旧笔记归属旧目录', (() => { const n = store.getNotes().find((x) => x.id === 'l1'); return n.folderId && store.loadStore().folders.find((f) => f.id === n.folderId).name === '旧目录'; })());

  // ---------- 13. trashedFolders ----------
  section('trashedFolders 持久化');
  const stTF = store.loadStore();
  store.saveStore({ ...stTF, trashedFolders: ['f1'] });
  check('trashedFolders 落 kv', JSON.parse(env.db.getKv('trashedFolders') || '[]').join(',') === 'f1');
  check('trashedFolders 读回', store.loadStore().trashedFolders.join(',') === 'f1');
  env.db.setKv('trashedFolders', '{坏');
  env.db.flush();
  check('trashedFolders 脏 JSON 容错为空数组', Array.isArray(store.loadStore().trashedFolders) && store.loadStore().trashedFolders.length === 0);

  // ---------- 14. settings 透传 ----------
  section('loadStore 透传 settings');
  settingsMod.saveSettings({ ...settingsMod.getSettings(), probeKey: 'probeVal' });
  check('loadStore 带回当前 settings', store.loadStore().settings.probeKey === 'probeVal');

  summary();
})().catch((err) => {
  console.error('测试执行异常：', err);
  process.exitCode = 1;
});
