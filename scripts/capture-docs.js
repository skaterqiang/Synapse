// 文档截图工具：用 Electron 窗口打开已运行的 Web 模式页面，按视图逐一截图到 docs/images/
// 用法：先 `npm run web` 启动服务，再执行 `npx electron scripts/capture-docs.js`
// 说明：指向 http://localhost:8787（Web 模式复用同一套 src/index.html 与真实业务数据），
// 避免本进程再次打开 knowledge.db 与 web 服务抢占同一数据库文件。
// 截图为只读操作（仅点击导航切换视图），不会修改任何用户数据。
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const URL_BASE = process.env.CAP_URL || 'http://localhost:8787';
const OUT_DIR = path.join(__dirname, '..', 'docs', 'images');
const W = 1680;
const H = 1050;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 依据可见文字点击侧边栏/列表元素（渲染层无需改动，纯 DOM 查找）
const clickByText = (selector, text) => `(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
  const el = els.find((e) => (e.textContent || '').includes(${JSON.stringify(text)}));
  if (el) { el.click(); return true; }
  return false;
})()`;

// 截图任务：name 输出文件名；steps 为依次执行的 JS 片段
const SHOTS = [
  {
    name: 'notes-editor',
    steps: [clickByText('.note-card, .note-item', '欢迎使用')],
  },
  {
    name: 'ai-chat',
    steps: [clickByText('#btn-ai-toggle', 'AI')],
    after: [clickByText('#btn-ai-toggle', 'AI')], // 截完关闭，避免影响后续视图
  },
  {
    // Wiki 阅读：进入索引 → 展开领域分组（默认折叠）→ 打开第一个页面
    name: 'wiki-reader',
    steps: [
      clickByText('#wiki-header, .wiki-header', 'LLM Wiki'),
      clickByText('.wiki-group-toggle', '通用'),
      `(() => { const e = document.querySelector('.wiki-tree-item'); if (e) { e.click(); return true; } return false; })()`,
    ],
  },
  {
    // 吸收弹窗：侧边栏 LLM Wiki 右侧 ＋ 按钮
    name: 'wiki-ingest-dialog',
    steps: [`(() => { const b = document.getElementById('btn-wiki-ingest'); if (b) { b.click(); return true; } return false; })()`],
    after: [`(() => { const m = document.getElementById('ingest-modal'); if (m) m.hidden = true; return true; })()`],
  },
  { name: 'domain-templates', steps: [clickByText('#nav-templates', '领域模版')] },
  { name: 'raw-files', steps: [clickByText('#nav-raws', '原始文件')] },
  { name: 'knowledge-graph', steps: [clickByText('#kg-submenu .nav-sub-item', '整体图谱')], wait: 2600 },
  { name: 'graph-overview', steps: [clickByText('#kg-submenu .nav-sub-item', '概览')] },
  { name: 'graph-entities', steps: [clickByText('#kg-submenu .nav-sub-item', '实体浏览')] },
  { name: 'graph-ontology', steps: [clickByText('#kg-submenu .nav-sub-item', '本体定义')] },
  { name: 'graph-ask', steps: [clickByText('#kg-submenu .nav-sub-item', 'KG 问答')] },
  { name: 'jobs-manager', steps: [clickByText('#nav-jobs', '作业管理')] },
  { name: 'prompts-manager', steps: [clickByText('#nav-prompts', '提示词管理')] },
  { name: 'settings-ai', steps: [clickByText('#btn-settings', '设置')] },
];

app.whenReady().then(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const win = new BrowserWindow({
    width: W,
    height: H,
    show: false,
    backgroundColor: '#f5f6f8',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await win.loadURL(URL_BASE);
  await sleep(3500); // 等渲染层完成首屏数据加载

  const done = [];
  for (const shot of SHOTS) {
    for (const js of shot.steps || []) {
      try { await win.webContents.executeJavaScript(js); } catch (e) { console.warn(shot.name, '步骤失败:', e.message); }
      await sleep(700);
    }
    await sleep(shot.wait || 1200);
    const img = await win.webContents.capturePage();
    const file = path.join(OUT_DIR, shot.name + '.png');
    fs.writeFileSync(file, img.toPNG());
    const { width, height } = img.getSize();
    done.push(`${shot.name}.png  ${width}x${height}`);
    console.log('已保存:', file, `${width}x${height}`);
    for (const js of shot.after || []) {
      try { await win.webContents.executeJavaScript(js); } catch (_) {}
      await sleep(500);
    }
  }
  console.log('\n完成 ' + done.length + ' 张:\n' + done.join('\n'));
  app.quit();
});

app.on('window-all-closed', () => app.quit());
