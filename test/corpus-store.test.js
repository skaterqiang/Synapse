// 语料库存储测试（src/main/corpus/store.js，设计文档 §6）
// 覆盖：
//   · index.json 单条 11 字段契约（§12.1，增删字段即红）
//   · writeCorpus 落盘 + frontmatter 出处契约（§6.2）
//   · 按 corpusId upsert（同来源同技能重跑 → 覆盖同一文件、version+1）
//   · readCorpus 返回去 frontmatter 的正文
//   · listCorpus 的 domain / q 过滤与 stale 判定
//   · staleOf 的判据口径（复用 raws.js:59 isIngestedFresh）
//   · removeCorpus 连带 .assets/ 目录
//   · promoteToNote 复用 notes/store.js:444 importNote，且按 source upsert 不产生副本
//   · 索引损坏 → rebuildIndex 从 corpus/**/*.md 全量重建（§12.3）
//   · corpusMaxFiles 淘汰（§10.1）
//   · CorpusFileSource 与本 store 的对接（kind:'corpus'、id 沿用记录的 corpusId）
// 运行：node test/corpus-store.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const { bootEnv, mkCheck } = require('./helpers/harness');

const { check, section, summary } = mkCheck('语料库存储');

(async () => {
  const env = await bootEnv({ prefix: 'synapse-corpus-' });
  const store = require('../src/main/corpus/store');
  const { makeItem, originOf, parseFrontmatter } = require('../src/main/corpus/item');
  const { CorpusFileSource } = require('../src/main/corpus/sources');
  const { drive, makeContext } = require('../src/main/corpus/drive');
  const notesStore = require('../src/main/notes/store');
  const settingsMod = require('../src/main/common/settings');

  const corpusRoot = store.corpusRoot();
  check('corpusRoot 位于 <数据根>/corpus', corpusRoot === path.join(env.dataRoot, 'corpus'), corpusRoot);
  check('corpusRoot 与 paths.corpusRoot 同源', corpusRoot === env.paths.corpusRoot());

  const settings = { ...settingsMod.getSettings(), corpusMaxFiles: 2000 };

  // 造一个「原始文件」用于 origin 与 stale 判定
  const rawDir = path.join(env.dir, 'wiki', 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  const pdfPath = path.join(rawDir, '供电容量说明.pdf');
  fs.writeFileSync(pdfPath, 'PDF-BYTES');
  const st = fs.statSync(pdfPath);
  const record = {
    path: 'local:' + pdfPath,
    name: '供电容量说明.pdf',
    ext: 'pdf',
    size: st.size,
    mtime: st.mtimeMs,
    root: rawDir,
    rel: '供电容量说明.pdf',
  };

  const BASE_META = {
    parseMethod: 'skill',
    skill: { name: 'extract-markdown', mode: 'llm', version: '1.0.0' },
    domain: { id: 'ev_charging', label: '充电桩扩容', confidence: 0.95 },
    profileId: 'iso15926',
    provenance: [{ layer: 'RawFileSource', at: 1, ms: 12 }],
  };
  // meta 浅合并：只覆盖显式给出的键，其余（domain/profileId）保持基准值——
  // 否则不同用例会因丢掉 domain 而全部落到 general/ 并互相撞名
  const mkItem = (patch) => {
    const p = patch || {};
    return makeItem(Object.assign({
      kind: 'raw',
      label: '原始·供电容量说明.pdf',
      origin: originOf(record),
      text: '# 供电容量说明\n\n变电站容量 40MVA。\n',
    }, p, { meta: Object.assign({}, BASE_META, p.meta) }));
  };

  // ============ writeCorpus ============
  section('writeCorpus：落盘与 frontmatter 出处契约（§6.2）');
  const item = mkItem();
  const ctx = makeContext({ settings, jobId: 'job-42', profileId: 'iso15926' });
  const w = store.writeCorpus(item, ctx);
  check('写入成功', w.ok === true, JSON.stringify(w));
  check('rel 落在 <领域>/<名称>.md', w.rel === '充电桩扩容/供电容量说明.md', w.rel);
  check('首次写入 created=true', w.created === true);
  check('version 从 1 起', w.version === 1, String(w.version));
  check('文件真实存在', fs.existsSync(path.join(corpusRoot, w.rel)));

  const rawFile = fs.readFileSync(path.join(corpusRoot, w.rel), 'utf8');
  const parsed = parseFrontmatter(rawFile);
  const fm = parsed.frontmatter;
  check('frontmatter 有 --- 围栏', rawFile.startsWith('---\n'));
  check('corpusId 与 item.id 一致', fm.corpusId === item.id, fm.corpusId + ' vs ' + item.id);
  check('generator = Synapse-Corpus/1.0', fm.generator === store.GENERATOR, fm.generator);
  check('generatedAt 是 ISO 时间', /^\d{4}-\d{2}-\d{2}T/.test(String(fm.generatedAt)), String(fm.generatedAt));
  check('source 七字段齐全', ['type', 'path', 'name', 'ext', 'size', 'mtime'].every((k) => fm.source[k] !== undefined),
    JSON.stringify(fm.source));
  check('source.path 保留 local: 前缀', fm.source.path === 'local:' + pdfPath, fm.source.path);
  check('parse.method = skill', fm.parse && fm.parse.method === 'skill', JSON.stringify(fm.parse));
  check('parse.skill 三字段', fm.parse.skill && fm.parse.skill.name === 'extract-markdown'
    && fm.parse.skill.mode === 'llm' && fm.parse.skill.version === '1.0.0', JSON.stringify(fm.parse.skill));
  check('parse.chars 与正文长度一致', fm.parse.chars === parsed.body.replace(/^\n+/, '').length,
    `${fm.parse.chars} vs ${parsed.body.length}`);
  check('domain 三字段', fm.domain && fm.domain.id === 'ev_charging' && fm.domain.label === '充电桩扩容'
    && fm.domain.confidence === 0.95, JSON.stringify(fm.domain));
  check('profileId 落到 frontmatter', fm.profileId === 'iso15926', String(fm.profileId));
  check('provenance 是数组且含 RawFileSource', Array.isArray(fm.provenance) && fm.provenance.length === 1
    && fm.provenance[0].layer === 'RawFileSource', JSON.stringify(fm.provenance));
  check('正文完整保留（含中文标题）', parsed.body.includes('# 供电容量说明') && parsed.body.includes('40MVA'));
  check('未入图时不写 graph 键', fm.graph === undefined, JSON.stringify(fm.graph));

  // ============ index.json 11 字段契约 ============
  section('index.json：单条 11 字段（§12.1 硬契约）');
  const idxRaw = JSON.parse(fs.readFileSync(path.join(corpusRoot, store.INDEX_NAME), 'utf8'));
  check('index.json 是数组', Array.isArray(idxRaw) && idxRaw.length === 1, JSON.stringify(idxRaw).slice(0, 120));
  const rec0 = idxRaw[0];
  const keys = Object.keys(rec0);
  check('单条恰好 11 字段', keys.length === 11, keys.length + ' → ' + keys.join(','));
  check('字段名与 INDEX_FIELDS 完全一致', keys.slice().sort().join(',') === store.INDEX_FIELDS.slice().sort().join(','),
    keys.slice().sort().join(','));
  check('INDEX_FIELDS 常量本身是 11 项', store.INDEX_FIELDS.length === 11, String(store.INDEX_FIELDS.length));
  check('rec.rel 与 writeCorpus 返回一致', rec0.rel === w.rel, rec0.rel);
  check('rec.domainLabel = 充电桩扩容', rec0.domainLabel === '充电桩扩容', rec0.domainLabel);
  check('rec.parseMethod = skill', rec0.parseMethod === 'skill', rec0.parseMethod);
  check('rec.skill 是对象', rec0.skill && rec0.skill.name === 'extract-markdown', JSON.stringify(rec0.skill));
  check('rec.sourceMtime = 源文件 mtime', rec0.sourceMtime === Math.round(st.mtimeMs), String(rec0.sourceMtime));
  check('rec.chars > 0', rec0.chars > 0, String(rec0.chars));

  // ============ upsert ============
  section('upsert：同 corpusId 重跑覆盖同一文件、version+1');
  const item2 = mkItem({ text: '# 供电容量说明（修订）\n\n变电站容量 63MVA。\n' });
  check('同来源同技能 → 指纹相同', item2.id === item.id, item2.id + ' vs ' + item.id);
  const w2 = store.writeCorpus(item2, ctx);
  check('第二次写入成功', w2.ok === true, JSON.stringify(w2));
  check('rel 不变（覆盖而非新增）', w2.rel === w.rel, w2.rel);
  check('created=false', w2.created === false);
  check('version 递增到 2', w2.version === 2, String(w2.version));
  const idx2 = store.loadIndex();
  check('索引仍只有 1 条', idx2.length === 1, String(idx2.length));
  check('磁盘上仍只有 1 个 .md', fs.readdirSync(path.join(corpusRoot, '充电桩扩容')).filter((f) => f.endsWith('.md')).length === 1);
  check('正文已被覆盖', fs.readFileSync(path.join(corpusRoot, w.rel), 'utf8').includes('63MVA'));
  check('frontmatter.version = 2', parseFrontmatter(fs.readFileSync(path.join(corpusRoot, w.rel), 'utf8')).frontmatter.version === 2);

  // 换了技能 → 指纹变 → 新文件（同目录撞名则加指纹后缀）
  const item3 = mkItem({ meta: { parseMethod: 'builtin', skill: { name: 'extract-ocr', mode: 'script', version: '0.1.0' } } });
  check('换技能 → 指纹改变', item3.id !== item.id, item3.id);
  const w3 = store.writeCorpus(item3, ctx);
  check('换技能写入成功且是新文件', w3.ok && w3.created === true && w3.rel !== w.rel, JSON.stringify(w3));
  check('撞名时加指纹后缀', /供电容量说明-[0-9a-f]{6}\.md$/.test(w3.rel), w3.rel);
  check('索引增至 2 条', store.loadIndex().length === 2, String(store.loadIndex().length));

  // ============ readCorpus ============
  section('readCorpus：返回去 frontmatter 的正文');
  const r = store.readCorpus(w.rel);
  check('读取成功', r.ok === true, JSON.stringify(r).slice(0, 120));
  check('text 不含 --- 围栏', !r.text.startsWith('---'), r.text.slice(0, 20));
  check('text 是正文', r.text.includes('63MVA'));
  check('frontmatter 可拿到 corpusId', r.frontmatter.corpusId === item.id, String(r.frontmatter.corpusId));
  check('rel 归一化为正斜杠', r.rel === w.rel, r.rel);
  check('不存在的语料 → ok:false', store.readCorpus('充电桩扩容/不存在.md').ok === false);
  check('越界路径被拒（..）', store.readCorpus('../../etc/passwd').ok === false);
  check('绝对路径被拒', store.readCorpus('D:/Windows/win.ini').ok === false);
  check('normRel 统一反斜杠', store.normRel('a\\b\\c.md') === 'a/b/c.md', store.normRel('a\\b\\c.md'));
  check('normRel 拒绝 ..', store.normRel('a/../b.md') === '', JSON.stringify(store.normRel('a/../b.md')));

  // ============ listCorpus ============
  section('listCorpus：过滤与 stale');
  const all = store.listCorpus(settings);
  check('列出 2 篇', all.length === 2, String(all.length));
  check('每条都带 stale 布尔', all.every((x) => typeof x.stale === 'boolean'));
  check('按 generatedAt 倒序', Date.parse(all[0].generatedAt) >= Date.parse(all[1].generatedAt));
  const byDomain = store.listCorpus(settings, { domain: 'ev_charging' });
  check('按 domain id 过滤命中 2 篇', byDomain.length === 2, String(byDomain.length));
  const byLabel = store.listCorpus(settings, { domain: '充电桩扩容' });
  check('按 domainLabel 过滤同样命中', byLabel.length === 2, String(byLabel.length));
  const byQ = store.listCorpus(settings, { q: '供电' });
  check('q 过滤命中', byQ.length === 2, String(byQ.length));
  const byQ2 = store.listCorpus(settings, { q: 'zzz-不存在' });
  check('q 无命中 → 空数组', Array.isArray(byQ2) && byQ2.length === 0);
  const byProf = store.listCorpus(settings, { q: 'iso15926' });
  check('q 也能命中 profileId', byProf.length === 2, String(byProf.length));

  section('staleOf：源文件 mtime 变了才 true（口径同 raws.js:59）');
  check('未改动 → 不陈旧', store.staleOf(all[0], settings) === false, JSON.stringify(all[0]));
  const future = new Date(Date.now() + 60 * 60 * 1000);
  fs.utimesSync(pdfPath, future, future);
  store.invalidateIndex();
  const afterTouch = store.listCorpus(settings).find((x) => x.rel === w.rel);
  check('源文件被改 → stale=true', afterTouch.stale === true, JSON.stringify(afterTouch));
  check('无 sourceMtime → 不报陈旧', store.staleOf({ rel: w.rel, sourceMtime: 0 }, settings) === false);
  check('url: 来源 → 不报陈旧', store.staleOf({ sourcePath: 'url:https://x/y', sourceMtime: 1 }, settings) === false);
  check('源已删除 → 不报陈旧', store.staleOf({ sourcePath: 'local:D:/不存在/x.pdf', sourceMtime: 1 }, settings) === false);

  // ============ .assets/ 归位 ============
  section('图片副产物归位到 <同名>.assets/');
  const artDir = path.join(env.dataRoot, 'artifacts');
  fs.mkdirSync(artDir, { recursive: true });
  const img = path.join(artDir, 'img-1.png');
  fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const itemImg = mkItem({
    text: '# 图\n\n![](img-1.png)\n',
    // 用独立的技能版本 ⇒ 独立指纹，不会与上面的 item3 互相覆盖
    meta: { parseMethod: 'skill', skill: { name: 'extract-ocr', mode: 'script', version: '0.2.0' }, assets: [img] },
  });
  const wImg = store.writeCorpus(itemImg, ctx);
  check('带图语料写入成功', wImg.ok === true, JSON.stringify(wImg));
  check('moved 计数 = 1', wImg.assets === 1, String(wImg.assets));
  const ad = store.assetsDirFor(wImg.rel);
  check('.assets 目录已建', fs.existsSync(ad), ad);
  check('图片已复制进去', fs.existsSync(path.join(ad, 'img-1.png')));
  check('正文引用改写为相对路径', fs.readFileSync(path.join(corpusRoot, wImg.rel), 'utf8').includes('](供电容量说明.assets/img-1.png)')
    || fs.readFileSync(path.join(corpusRoot, wImg.rel), 'utf8').includes('.assets/img-1.png'),
    fs.readFileSync(path.join(corpusRoot, wImg.rel), 'utf8').slice(-80));

  // ============ removeCorpus ============
  section('removeCorpus：连带 .assets/ 与索引');
  const before = store.loadIndex().length;
  const rm = store.removeCorpus(wImg.rel);
  check('removed = 1', rm.ok && rm.removed === 1, JSON.stringify(rm));
  check('.md 已删', !fs.existsSync(path.join(corpusRoot, wImg.rel)));
  check('.assets 目录已删', !fs.existsSync(ad));
  check('索引减 1', store.loadIndex().length === before - 1, `${store.loadIndex().length} vs ${before}`);
  const rmArr = store.removeCorpus([w.rel, w3.rel, '不存在/x.md']);
  check('批量删除按存在的计数', rmArr.removed === 2, JSON.stringify(rmArr));
  check('索引清空', store.loadIndex().length === 0, String(store.loadIndex().length));
  check('空的领域目录被清理', !fs.existsSync(path.join(corpusRoot, '充电桩扩容')));

  // ============ promoteToNote ============
  section('promoteToNote：复用 importNote，按 source upsert 不产生副本（§6.4）');
  const itemP = mkItem({ text: '# 供电容量说明\n\n正文第一段。\n' });
  const wP = store.writeCorpus(itemP, ctx);
  check('准备语料成功', wP.ok === true, JSON.stringify(wP));
  const p1 = store.promoteToNote(wP.rel, { folderRel: '充电桩扩容' });
  check('首次提升成功', p1.ok === true, JSON.stringify(p1));
  check('updated=false（新建）', p1.updated === false);
  check('笔记文件已落盘', p1.path && fs.existsSync(p1.path), String(p1.path));
  check('标题取源文件名（去扩展名）', p1.title === '供电容量说明', String(p1.title));
  const notesAfter1 = notesStore.getNotes().length;
  const p2 = store.promoteToNote(wP.rel, { folderRel: '充电桩扩容' });
  check('重复提升成功', p2.ok === true, JSON.stringify(p2));
  check('updated=true（upsert 同一篇）', p2.updated === true);
  check('noteId 不变', p2.noteId === p1.noteId, p2.noteId + ' vs ' + p1.noteId);
  check('笔记总数不变（无副本）', notesStore.getNotes().length === notesAfter1,
    `${notesStore.getNotes().length} vs ${notesAfter1}`);
  const promoted = notesStore.getNotes().find((n) => n.id === p1.noteId);
  check('笔记 source = corpus:<rel>', promoted && promoted.source === 'corpus:' + wP.rel, String(promoted && promoted.source));
  check('笔记正文是语料正文', promoted && promoted.content.includes('正文第一段'));
  check('不存在的语料 → ok:false', store.promoteToNote('x/不存在.md').ok === false);

  // ============ 索引损坏重建 ============
  section('索引损坏 → 从 corpus/**/*.md 全量重建（§12.3）');
  fs.writeFileSync(path.join(corpusRoot, store.INDEX_NAME), '{ 这不是合法 JSON', 'utf8');
  store.invalidateIndex();
  const rebuilt = store.loadIndex();
  check('重建出 1 条', rebuilt.length === 1, String(rebuilt.length));
  check('重建条目的 rel 正确', rebuilt[0].rel === wP.rel, rebuilt[0].rel);
  check('重建条目仍是 11 字段', Object.keys(rebuilt[0]).length === 11, Object.keys(rebuilt[0]).join(','));
  check('重建保留了 parseMethod', rebuilt[0].parseMethod === 'skill', rebuilt[0].parseMethod);
  check('重建保留了 domainLabel', rebuilt[0].domainLabel === '充电桩扩容', rebuilt[0].domainLabel);
  // 注意：stale 用例已把源文件 mtime 推到未来，而 frontmatter 记的是**写入当时**的 mtime
  check('重建保留了 sourceMtime（写入当时的值）', rebuilt[0].sourceMtime === Math.round(st.mtimeMs),
    `${rebuilt[0].sourceMtime} vs ${Math.round(st.mtimeMs)}`);
  check('重建后 stale 判定仍可用', typeof store.listCorpus(settings)[0].stale === 'boolean');

  // 索引文件整个丢失也能重建
  fs.unlinkSync(path.join(corpusRoot, store.INDEX_NAME));
  store.invalidateIndex();
  check('索引缺失 → 同样重建', store.loadIndex().length === 1, String(store.loadIndex().length));

  // ============ corpusMaxFiles 淘汰 ============
  section('corpusMaxFiles：超出按 generatedAt 淘汰最旧（§10.1，下限 100）');
  // num() 的合法区间是 100–20000，填 2 会被钳回 100 ⇒ 必须真的写满 100 篇才能触发淘汰
  const MAXF = 100;
  const small = { ...settings, corpusMaxFiles: MAXF };
  const beforeEvict = store.loadIndex().length;
  for (let i = 0; i < MAXF + 5; i++) {
    const p = path.join(rawDir, `doc-${i}.txt`);
    fs.writeFileSync(p, '内容 ' + i);
    const s2 = fs.statSync(p);
    store.writeCorpus(makeItem({
      kind: 'raw',
      label: '原始·doc-' + i,
      origin: originOf({ path: 'local:' + p, name: `doc-${i}.txt`, ext: 'txt', size: s2.size, mtime: s2.mtimeMs, root: rawDir, rel: `doc-${i}.txt` }),
      text: '# doc-' + i + '\n\n正文\n',
      meta: { parseMethod: 'builtin', domain: null, profileId: '' },
    }), makeContext({ settings: small, jobId: 'job-x' }));
  }
  const afterEvict = store.loadIndex();
  check('淘汰后索引不超过上限', afterEvict.length <= MAXF, `${afterEvict.length} > ${MAXF}`);
  check('确实发生了淘汰（少于写入总数）', afterEvict.length < beforeEvict + MAXF + 5,
    `${afterEvict.length} vs ${beforeEvict + MAXF + 5}`);
  check('最新写入的 doc-104 仍在（不参与淘汰）', afterEvict.some((x) => x.name === 'doc-104.md'),
    JSON.stringify(afterEvict.slice(0, 3).map((x) => x.name)));
  check('最旧的 doc-0 已被淘汰', !afterEvict.some((x) => x.name === 'doc-0.md'));
  check('索引里的每条在磁盘上都存在', afterEvict.every((x) => fs.existsSync(path.join(corpusRoot, x.rel))));
  check('被淘汰的 .md 已从磁盘删除', !fs.existsSync(path.join(corpusRoot, 'general', 'doc-0.md')));

  // ============ CorpusFileSource 对接 ============
  section('CorpusFileSource：从语料库重新入图（零解析成本）');
  store.invalidateIndex();
  const list = store.listCorpus(settings);
  const rels = list.map((x) => x.rel);
  const src = new CorpusFileSource(rels);
  const c2 = makeContext({ settings });
  const items = [];
  const res = await drive(src, Object.assign(c2, { onItem: (it) => items.push(it) }));
  check('drive 成功', res.ok === true, JSON.stringify(res));
  check('条数与索引一致', items.length === rels.length, `${items.length} vs ${rels.length}`);
  check('kind = corpus', items.every((x) => x.kind === 'corpus'), items.map((x) => x.kind).join(','));
  check('label 以「语料·」开头', items.every((x) => x.label.startsWith('语料·')), items[0] && items[0].label);
  check('text 非空且不含围栏', items.every((x) => x.text && !x.text.startsWith('---')));
  check('id 沿用文件里记录的 corpusId', items.every((x) => /^[0-9a-f]{16}$/.test(x.id)), items.map((x) => x.id).join(','));
  check('meta.parseMethod = corpus', items.every((x) => x.meta.parseMethod === 'corpus'));
  check('meta.corpusFile 以 corpus/ 开头', items.every((x) => String(x.meta.corpusFile).startsWith('corpus/')),
    items[0] && items[0].meta.corpusFile);
  check('origin 来自 frontmatter.source（不是语料文件自身）',
    items.every((x) => x.origin.path.startsWith('local:')), items.map((x) => x.origin.path).join(','));
  check('caps.text = true、caps.bytes = false', src.caps.text === true && src.caps.bytes === false, JSON.stringify(src.caps));
  check('estimate 不放大条数（P13 口径）', src.estimate().total === rels.length, JSON.stringify(src.estimate()));
  const missing = new CorpusFileSource(['充电桩扩容/幽灵.md']);
  const cm = makeContext({ settings });
  const rm2 = await drive(missing, cm);
  check('缺失语料不抛错，记入 ctx.errors（P10）', rm2.ok === true && cm.errors.length === 1, JSON.stringify(cm.errors));

  // ============ 空正文 / 缺指纹 ============
  section('边界：空正文与缺指纹不落盘');
  const emptyW = store.writeCorpus(mkItem({ text: '   \n  ' }), ctx);
  check('空正文 → ok:false 且不写文件', emptyW.ok === false && !!emptyW.error, JSON.stringify(emptyW));
  const noId = store.writeCorpus({ origin: originOf(record), text: 'x', meta: {} }, ctx);
  check('缺 corpusId → ok:false', noId.ok === false, JSON.stringify(noId));
  check('上述失败未污染索引', store.loadIndex().every((x) => x.rel && x.corpusId));

  const ok = summary();
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('测试异常退出：', e && e.stack ? e.stack : e);
  process.exit(1);
});
