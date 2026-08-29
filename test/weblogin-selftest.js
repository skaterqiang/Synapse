// 桌面端「隐藏窗口真实渲染取标题」自测（不写库、不弹窗，仅验证第二级能力）：
//   macOS: ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron test/weblogin-selftest.js
//   win:   node_modules\electron\dist\electron.exe test\weblogin-selftest.js
const { app } = require('electron');
const path = require('path');
const { renderPageTitle, hasBrowser } = require(path.join(__dirname, '..', 'src', 'main', 'raws', 'weblogin'));

app.whenReady().then(async () => {
  app.on('window-all-closed', (e) => e.preventDefault()); // 测试脚本无主窗口：隐藏窗销毁后不要退出
  console.log('hasBrowser:', hasBrowser());
  const pub = await renderPageTitle('https://www.163.com/', 12000);
  console.log('公开页 =>', JSON.stringify(pub));
  const sec = await renderPageTitle('https://aliyuque.antfin.com/gmzrvk/tdkisb/gnhr2b7paopoe2wm', 12000);
  console.log('需登录页 =>', JSON.stringify(sec));
  setTimeout(() => app.exit(0), 800); // 等待 stdout 刷新，避免管道下丢最后一行
}).catch((e) => {
  console.error('selftest error:', e && e.message);
  app.exit(1);
});
