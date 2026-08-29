// 回归测试：事务进行中若别的进程写盘（数据库文件 mtime 变新），reloadIfStale 不得中途
// 换掉 db 实例，否则 COMMIT/ROLLBACK 打到无活动事务的新实例上。
// 线上症状：安装技能后 persist 设置弹「保存失败：cannot rollback - no transaction is active」
// 运行：node test/db-transaction.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-dbtx-'));
const tmpUser = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-dbtx-user-'));

// 注入 electron / paths 桩（db.js、store.js 顶层依赖 electron 与 paths）
const stubs = {
  [require.resolve('electron')]: {
    app: {
      getPath: (n) => (n === 'userData' ? tmpUser : tmpRoot),
      getAppPath: () => tmpRoot,
      isPackaged: false,
    },
  },
  [path.join(__dirname, '..', 'src', 'main', 'common', 'paths.js')]: {
    dataRoot: () => tmpRoot,
    legacyUserData: () => tmpUser,
    assetsDir: () => path.join(tmpRoot, 'assets'),
    consumeAssetsRewrite: () => null,
    ensureUnifiedRoot: () => tmpRoot,
    setDataRoot: () => tmpRoot,
  },
};
for (const [resolved, exportsObj] of Object.entries(stubs)) {
  const m = new Module(resolved, module);
  m.filename = resolved;
  m.loaded = true;
  m.exports = exportsObj;
  require.cache[resolved] = m;
}

const db = require('../src/main/common/db');
const store = require('../src/main/notes/store');

(async () => {
  await db.init();

  // 基线：saveStore 正常落盘
  store.saveStore({ folders: [], notes: [], settings: { skills: [] } });

  // 模拟别的进程（如 Web 服务）写盘：把数据库文件 mtime 拨到未来，触发重载条件
  const file = db.getDbFile();
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(file, future, future);

  // 事务内含 setKv（重载路径）。修复前此处实例被换掉 → cannot rollback - no transaction is active
  let threw = null;
  try {
    db.transaction(() => {
      db.setKv('settings', JSON.stringify({ skills: [{ name: 'pptx' }] }));
    });
  } catch (err) {
    threw = err;
  }
  assert.strictEqual(threw, null, '事务不应抛错：' + (threw && threw.message));
  assert.strictEqual(JSON.parse(db.getKv('settings')).skills.length, 1, '事务提交应生效');

  // 安装流程的 persist 路径（saveStore）同样恢复正常
  let saveErr = null;
  try {
    store.saveStore({ folders: [], notes: [], settings: { skills: [{ name: 'pptx', enabled: true }] } });
  } catch (err) {
    saveErr = err;
  }
  assert.strictEqual(saveErr, null, 'saveStore 不应抛错：' + (saveErr && saveErr.message));

  // 事务外重载仍生效：别的进程写盘后 getKv 应能看到新数据（不破坏原有跨进程同步能力）
  fs.utimesSync(file, new Date(Date.now() + 9000), new Date(Date.now() + 9000));
  assert.strictEqual(db.getKv('settings') != null, true, '事务外重载应正常工作');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(tmpUser, { recursive: true, force: true });
  console.log('db-transaction 回归测试通过：事务期间他进程写盘不再触发 rollback 错误');
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
