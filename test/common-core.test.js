// 主进程基础层测试：common/config.js、common/paths.js、common/appdb.js、common/settings.js、
//                    common/db.js、ai/defaults.js、common/defaults.js
// 运行：node test/common-core.test.js
const fs = require('fs');
const path = require('path');
const { bootEnv, mkCheck, writeFile, REPO_ROOT } = require('./helpers/harness');

const { check, section, summary } = mkCheck('基础层（config/paths/appdb/settings/db/defaults）');

(async () => {
  const env = await bootEnv({ prefix: 'synapse-common-' });
  const { dataRoot } = env;

  // ================= config.js =================
  section('common/config.js — num / pick');
  const { num, pick } = require(path.join(REPO_ROOT, 'src/main/common/config'));
  check('num 缺省键回退默认值', num({}, 'x', 7) === 7);
  check('num 四舍五入取整', num({ x: 3.6 }, 'x', 0) === 4, String(num({ x: 3.6 }, 'x', 0)));
  check('num 钳制下界', num({ x: -5 }, 'x', 3, 1, 8) === 1);
  check('num 钳制上界', num({ x: 99 }, 'x', 3, 1, 8) === 8);
  check('num 非数值回退默认', num({ x: 'abc' }, 'x', 5) === 5);
  check('num null 回退默认', num({ x: null }, 'x', 5) === 5);
  check('num settings 为 null 不抛错', num(null, 'x', 9) === 9);
  check('num 字符串数字可用', num({ x: '4' }, 'x', 0, 1, 8) === 4);
  check('pick 命中允许列表', pick({ m: 'b' }, 'm', 'a', ['a', 'b']) === 'b');
  check('pick 非法值回退默认', pick({ m: 'z' }, 'm', 'a', ['a', 'b']) === 'a');
  check('pick 缺键回退默认', pick({}, 'm', 'a', ['a', 'b']) === 'a');

  // ================= paths.js =================
  section('common/paths.js — dataRoot / setDataRoot / kbAssetUrlFor');
  const paths = require(path.join(REPO_ROOT, 'src/main/common/paths'));
  check('dataRoot 指向沙箱', paths.dataRoot() === dataRoot, paths.dataRoot());
  check('assetsDir 在根目录下', paths.assetsDir() === path.join(dataRoot, 'assets'));
  check('legacyUserData 在 appData 下', paths.legacyUserData().includes('个人知识库助手'));

  // setDataRoot：空串恢复默认（默认候选是 app.getAppPath()/data，即仓库 data 目录）
  const restored = paths.setDataRoot('');
  check('setDataRoot("") 恢复默认根目录', !restored.startsWith(dataRoot), restored);
  check('恢复后根目录可写（已创建）', fs.existsSync(restored));
  paths.setDataRoot(dataRoot); // 复位，避免污染后续用例
  check('setDataRoot 复位成功', paths.dataRoot() === dataRoot);

  // 不可写目录应抛错
  let threw = '';
  try { paths.setDataRoot(path.join(dataRoot, 'knowledge.db')); } catch (e) { threw = e.message; }
  check('setDataRoot 指向不可写路径抛错', /不可写/.test(threw), threw);

  // kbAssetUrlFor：Markdown 定界符必须编码，反斜杠转正斜杠
  const u1 = paths.kbAssetUrlFor('D:\\个人助手\\Synapse\\data\\assets\\图 (更新版).png');
  check('kbAssetUrlFor 前缀正确', u1.startsWith('kb-asset://file'), u1);
  check('kbAssetUrlFor 反斜杠转正斜杠', !u1.includes('\\'));
  check('kbAssetUrlFor 编码左括号', u1.includes('%28'), u1);
  check('kbAssetUrlFor 编码右括号', u1.includes('%29'), u1);
  check('kbAssetUrlFor 编码空格', u1.includes('%20'));
  check('kbAssetUrlFor 保留盘符冒号', /kb-asset:\/\/fileD:/.test(u1), u1);
  const u2 = paths.kbAssetUrlFor("/Users/qiang/it's/a.png");
  check('kbAssetUrlFor 编码单引号', u2.includes('%27'), u2);
  check('kbAssetUrlFor Mac 路径保留前导斜杠', u2.startsWith('kb-asset://file/Users/'), u2);
  check('kbAssetUrlFor 中文可解码还原', decodeURIComponent(u1.slice('kb-asset://file'.length)) === 'D:/个人助手/Synapse/data/assets/图 (更新版).png');

  // ensureUnifiedRoot：旧 appData/assets 迁移到统一根目录，且迁移记录只消费一次
  const legacyAssets = path.join(paths.legacyUserData(), 'assets');
  writeFile(path.join(legacyAssets, 'a.png'), 'png-bytes');
  const root = paths.ensureUnifiedRoot();
  check('ensureUnifiedRoot 返回根目录', root === dataRoot);
  check('附件已复制到统一根目录', fs.existsSync(path.join(dataRoot, 'assets', 'a.png')));
  check('旧附件目录改名为 .migrated', fs.existsSync(legacyAssets + '.migrated') && !fs.existsSync(legacyAssets));
  const rw1 = paths.consumeAssetsRewrite();
  check('consumeAssetsRewrite 首次返回迁移记录', !!(rw1 && rw1.from && rw1.to), JSON.stringify(rw1));
  check('consumeAssetsRewrite 第二次返回 null（一次性）', paths.consumeAssetsRewrite() === null);

  // ================= appdb.js =================
  section('common/appdb.js — kv 读写与落盘');
  const appdb = require(path.join(REPO_ROOT, 'src/main/common/appdb'));
  await appdb.init();
  check('appdb 文件位于数据根目录', appdb.getFile() === path.join(dataRoot, 'app.db'), appdb.getFile());
  check('appdb 读不存在的键返回 null', appdb.get('nope') === null);
  appdb.set('k1', 'v1');
  check('appdb set/get 往返', appdb.get('k1') === 'v1');
  appdb.set('k1', 'v2');
  check('appdb 同键覆盖（upsert）', appdb.get('k1') === 'v2');
  appdb.set('json', JSON.stringify({ a: 1, b: [1, 2] }));
  check('appdb 存 JSON 可解析', JSON.parse(appdb.get('json')).b[1] === 2);
  appdb.flush();
  check('appdb 已落盘', fs.existsSync(path.join(dataRoot, 'app.db')));
  check('appdb 无残留 .tmp', !fs.existsSync(path.join(dataRoot, 'app.db.tmp')));
  // 重新 init（从磁盘重读，模拟重启）后数据仍在
  // 注意：不能删 require 缓存再 require，否则 settings.js 与本测试会各持一个 appdb 实例
  await appdb.init();
  check('appdb 重启后数据持久', appdb.get('k1') === 'v2');
  check('appdb 重启后 JSON 值持久', JSON.parse(appdb.get('json')).a === 1);

  // ================= db.js =================
  section('common/db.js — kv / transaction / 跨进程重载');
  const db = env.db;
  check('getDbFile 在数据根目录', db.getDbFile() === path.join(dataRoot, 'knowledge.db'), db.getDbFile());
  db.setKv('foo', 'bar');
  check('setKv/getKv 往返', db.getKv('foo') === 'bar');
  check('getKv 缺键返回 null', db.getKv('missing') === null);
  db.flush();
  check('db 已落盘', fs.existsSync(path.join(dataRoot, 'knowledge.db')));

  db.run('CREATE TABLE IF NOT EXISTS t_demo (id INTEGER PRIMARY KEY, name TEXT)');
  db.transaction(() => {
    db.run("INSERT INTO t_demo (name) VALUES ('a')");
    db.run("INSERT INTO t_demo (name) VALUES ('b')");
  });
  db.flush();
  check('transaction 提交生效', db.all('SELECT * FROM t_demo').length === 2);

  // 事务内抛错应回滚
  let txErr = '';
  try {
    db.transaction(() => {
      db.run("INSERT INTO t_demo (name) VALUES ('c')");
      throw new Error('boom');
    });
  } catch (e) { txErr = e.message; }
  check('transaction 抛错向外传播', txErr === 'boom', txErr);
  check('transaction 抛错后回滚', db.all('SELECT * FROM t_demo').length === 2, String(db.all('SELECT * FROM t_demo').length));

  // 别的进程写盘后本进程应重载（mtime 检测）
  const before = db.getKv('foo');
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ locateFile: (f) => path.join(path.dirname(require.resolve('sql.js/dist/sql-wasm.js')), f) });
  const other = new SQL.Database(new Uint8Array(fs.readFileSync(db.getDbFile())));
  other.run("UPDATE kv SET value = 'baz' WHERE key = 'foo'");
  const tmp = db.getDbFile() + '.other';
  fs.writeFileSync(tmp, Buffer.from(other.export()));
  fs.renameSync(tmp, db.getDbFile());
  // 确保 mtime 前进（部分文件系统 mtime 精度较粗）
  const now = new Date(Date.now() + 2000);
  fs.utimesSync(db.getDbFile(), now, now);
  check('跨进程写盘后读到新值', db.getKv('foo') === 'baz', `${before} → ${db.getKv('foo')}`);

  check('setDbPath 相对路径被拒绝', db.setDbPath('relative.db').ok === false);
  check('setDbPath 已存在文件被拒绝', db.setDbPath(path.join(dataRoot, 'app.db')).ok === false);
  check('setDbPath 指向当前文件返回 changed:false', db.setDbPath(db.getDbFile()).changed === false);

  // 整库迁移到新位置再迁回：数据不丢，旧文件改名留底，指针文件正确维护
  const moved = path.join(dataRoot, 'sub', 'moved.db');
  const r1 = db.setDbPath(moved);
  check('setDbPath 迁移成功', r1.ok === true && r1.changed === true, JSON.stringify(r1));
  check('迁移后新库文件存在', fs.existsSync(moved));
  check('迁移后 getDbFile 指向新库', db.getDbFile() === moved, db.getDbFile());
  check('迁移后数据仍可读', db.getKv('foo') === 'baz' && db.all('SELECT * FROM t_demo').length === 2);
  check('迁移写入了指针文件', fs.existsSync(path.join(env.el.userData, 'db-path.json')));
  const r2 = db.setDbPath('');
  check('setDbPath("") 恢复默认位置', r2.ok === true && db.getDbFile() === path.join(dataRoot, 'knowledge.db'), JSON.stringify(r2));
  check('恢复后数据完整', db.getKv('foo') === 'baz');
  check('恢复后指针文件被清除', !fs.existsSync(path.join(env.el.userData, 'db-path.json')));

  // ================= settings.js =================
  section('common/settings.js — 应用级配置分库');
  const settingsMod = require(path.join(REPO_ROOT, 'src/main/common/settings'));
  check('APP_KEYS 覆盖 Key/MCP/Skills', JSON.stringify(settingsMod.APP_KEYS) === JSON.stringify(['apiKey', 'extraModels', 'mcpServers', 'skills']));
  settingsMod.saveSettings({ apiKey: 'sk-1', model: 'qwen3.8-max', mcpServers: { a: 1 }, askNotes: 4 });
  const got = settingsMod.getSettings();
  check('saveSettings/getSettings 往返', got.apiKey === 'sk-1' && got.model === 'qwen3.8-max' && got.askNotes === 4, JSON.stringify(got));
  // 分库校验：apiKey 只应落在 app.db，不落 knowledge.db
  const mainRaw = JSON.parse(db.getKv('settings') || '{}');
  const appRaw = JSON.parse(appdb.get('settings') || '{}');
  check('apiKey 存于 app.db', appRaw.apiKey === 'sk-1');
  check('apiKey 不在 knowledge.db', mainRaw.apiKey === undefined, JSON.stringify(mainRaw));
  check('普通设置存于 knowledge.db', mainRaw.model === 'qwen3.8-max');
  check('mcpServers 存于 app.db', appRaw.mcpServers && appRaw.mcpServers.a === 1);

  // 旧版迁移：knowledge.db 里混有 apiKey、app.db 尚无 settings 时，首次读取应把应用级键搬到 app.db
  db.setKv('settings', JSON.stringify({ apiKey: 'legacy-key', model: 'm1', mcpServers: { s: 2 } }));
  appdb.set('settings', ''); // 空串 → parse 得 null → 触发迁移分支
  const migrated = settingsMod.getSettings();
  check('旧配置迁移后 apiKey 仍可读', migrated.apiKey === 'legacy-key', JSON.stringify(migrated));
  check('旧配置迁移后普通键仍可读', migrated.model === 'm1', JSON.stringify(migrated));
  const appRaw2 = JSON.parse(appdb.get('settings') || '{}');
  check('迁移把 apiKey 写入 app.db', appRaw2.apiKey === 'legacy-key', JSON.stringify(appRaw2));
  check('迁移把 mcpServers 写入 app.db', appRaw2.mcpServers && appRaw2.mcpServers.s === 2, JSON.stringify(appRaw2));
  const mainRaw2 = JSON.parse(db.getKv('settings') || '{}');
  check('迁移后 knowledge.db 不含应用级键', mainRaw2.apiKey === undefined && mainRaw2.mcpServers === undefined && mainRaw2.model === 'm1', JSON.stringify(mainRaw2));
  // 迁移只发生一次：再次读取走合并分支，不再改写
  const again = settingsMod.getSettings();
  check('迁移幂等（二次读取结果一致）', again.apiKey === 'legacy-key' && again.model === 'm1');

  // ================= defaults.js =================
  section('ai/defaults.js 与 common/defaults.js — 默认模型归一');
  const aiDefaults = require(path.join(REPO_ROOT, 'src/main/ai/defaults'));
  const commonDefaults = require(path.join(REPO_ROOT, 'src/main/common/defaults'));
  check('两处 DEFAULTS 一致', JSON.stringify(aiDefaults.DEFAULTS) === JSON.stringify(commonDefaults.DEFAULTS));
  check('默认 apiBaseUrl 为百炼兼容端点', /dashscope\.aliyuncs\.com\/compatible-mode\/v1$/.test(aiDefaults.DEFAULTS.apiBaseUrl), aiDefaults.DEFAULTS.apiBaseUrl);
  check('normalizeModel 空串回退默认', aiDefaults.normalizeModel('') === aiDefaults.DEFAULTS.model);
  check('normalizeModel undefined 回退默认', aiDefaults.normalizeModel(undefined) === aiDefaults.DEFAULTS.model);
  check('normalizeModel 纯空格回退默认', aiDefaults.normalizeModel('   ') === aiDefaults.DEFAULTS.model);
  check('normalizeModel 旧模型名归一', aiDefaults.normalizeModel('qianwen3.8-max') === aiDefaults.DEFAULTS.model, aiDefaults.normalizeModel('qianwen3.8-max'));
  check('normalizeModel 自定义模型原样保留', aiDefaults.normalizeModel('gpt-4o-mini') === 'gpt-4o-mini');
  check('normalizeModel 去首尾空格', aiDefaults.normalizeModel('  qwen-plus  ') === 'qwen-plus');
  check('common/defaults 行为一致', commonDefaults.normalizeModel('qianwen3.8-max') === aiDefaults.DEFAULTS.model);

  summary();
})().catch((err) => {
  console.error('测试执行异常：', err);
  process.exitCode = 1;
});
