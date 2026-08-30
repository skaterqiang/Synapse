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
const clickFirst = (selector) => `(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
  if (els[0]) { els[0].click(); return true; }
  return false;
})()`;

const SHOTS = [
  {
    name: 'notes-editor',
    steps: [
      // 优先点「欢迎使用」笔记，找不到则点第一张笔记卡
      `(() => {
        const els = [...document.querySelectorAll('.note-card')];
        const el = els.find((e) => (e.textContent || '').includes('欢迎使用')) || els[0];
        if (el) { el.click(); return true; }
        return false;
      })()`,
    ],
  },
  { name: 'domain-templates', steps: [clickByText('#nav-templates', '领域模版')] },
  { name: 'raw-files', steps: [clickByText('#nav-raws', '原始文件')] },
  { name: 'knowledge-graph', steps: [clickByText('#kg-submenu .nav-sub-item', '整体图谱')], wait: 2600 },
  // 以下子视图点击前先回到「概览」作为稳定锚点，避免连续点击时上一个视图异步渲染覆盖目标视图
  { name: 'graph-overview', steps: [clickByText('#kg-submenu .nav-sub-item', '概览')], wait: 1600 },
  { name: 'graph-entities', steps: [clickByText('#kg-submenu .nav-sub-item', '概览'), clickByText('#kg-submenu .nav-sub-item', '实体浏览')], wait: 1800 },
  { name: 'graph-ontology', steps: [clickByText('#kg-submenu .nav-sub-item', '概览'), clickByText('#kg-submenu .nav-sub-item', '本体定义')], wait: 1800 },
  { name: 'graph-ask', steps: [clickByText('#kg-submenu .nav-sub-item', '概览'), clickByText('#kg-submenu .nav-sub-item', 'KG 问答')], wait: 1600 },
  { name: 'jobs-manager', steps: [clickByText('#nav-jobs', '作业管理')] },
  { name: 'prompts-manager', steps: [clickByText('#nav-prompts', '提示词管理')] },
  { name: 'settings-ai', steps: [clickByText('#btn-settings', '设置')] },
  { name: 'settings-mcp', steps: [clickByText('button[data-tab]', 'MCP')] },
  { name: 'ai-chat', steps: [clickByText('#btn-ai-toggle', 'AI 问答')], wait: 1000 }, // 欢迎页（引导卡 + 知识源条 + 输入区）
  {
    name: 'ai-session',
    // 真实库无历史会话：注入纯内存演示会话（不写库），渲染列表后点开首条，展示会话视图
    steps: [
      `(() => {
        const now = Date.now();
        const day = new Date(now).toISOString().slice(0, 10);
        state.favView = false;
        state.aiSessions = [
          { id: 'demo-s1', title: '什么是知识图谱？如何构建？', date: day, updatedAt: now,
            messages: [
              { role: 'user', content: '什么是知识图谱？如何构建？' },
              { role: 'assistant', ms: 3200,
                steps: [ { kind: 'thought', text: '正在检索相关笔记与图谱上下文…' } ],
                content: '**知识图谱**是一种以「实体—关系—实体」三元组组织知识的语义网络，让机器能理解实体之间的关联。\\n\\n**核心构成**\\n- **实体（节点）**：现实世界的对象，如人、系统、概念\\n- **关系（边）**：实体之间的语义关联，如「依赖」「属于」\\n- **属性**：实体或关系的键值描述\\n\\n**构建流程**\\n1. **本体设计**：定义实体类型与关系模式\\n2. **实体识别**：从文档中抽取实体\\n3. **关系抽取**：识别实体间关系\\n4. **图谱问答**：基于图谱做检索增强问答' }
            ] },
          { id: 'demo-s2', title: '如何配置 MCP 服务器', date: day, updatedAt: now - 86400000, messages: [] },
          { id: 'demo-s3', title: '系统迁移方案要点总结', date: day, updatedAt: now - 172800000, messages: [] }
        ];
        state.activeSessionId = null;
        try { renderAiSessionList(); } catch (_) {}
        return true;
      })()`,
      clickFirst('.ai-session-item'),
    ],
    wait: 1400,
  }, // 会话视图（历史会话 + 对话区）
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
