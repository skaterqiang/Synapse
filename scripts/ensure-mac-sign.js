// macOS 启动/安装前对 Electron.app 做 ad-hoc 重签名，规避 XProtect/Gatekeeper 拦截。
// 仅在 darwin 平台执行；失败时静默忽略，不阻塞启动。
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

if (process.platform === 'darwin') {
  const app = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app');
  if (fs.existsSync(app)) {
    try {
      execSync(`codesign --force --deep --sign - "${app}"`, { stdio: 'ignore' });
    } catch (e) {
      // 重签名失败不阻塞（可能已有有效签名或无 codesign 权限）
    }
  }
}
