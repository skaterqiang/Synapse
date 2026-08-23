// 技能脚本执行器：为 docx/pptx/xlsx 等技能提供"写脚本并运行"的执行面
// 安全边界：仅 node 解释器、限定输出目录、超时 kill、进程树清理；脚本可用项目 node_modules 的 office 库
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function artifactsDir() {
  const paths = require('../common/paths');
  const dir = path.join(paths.dataRoot(), 'artifacts');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 运行 Node 脚本生成 office 文件：require('docx'/'pptxgenjs'/'exceljs') 可用，
// 输出必须写入 process.env.AGENT_OUTPUT_DIR；返回生成文件列表
function runNodeScript({ code, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const outDir = artifactsDir();
    const before = new Set(fs.readdirSync(outDir));
    const ms = Math.min(Number(timeoutMs) || 60000, 180000);
    let stdout = ''; let stderr = '';
    let child;
    try {
      child = spawn(process.execPath, ['-e', String(code || '')], {
        cwd: outDir,
        env: {
          ...process.env,
          // 桌面版主进程下 process.execPath 是 Electron 二进制，
          // 必须置 ELECTRON_RUN_AS_NODE 让其以纯 node 身份执行脚本，
          // 否则 Electron 会把脚本当应用路径尝试启动（弹 Error launching app）
          ELECTRON_RUN_AS_NODE: '1',
          AGENT_OUTPUT_DIR: outDir,
          NODE_PATH: path.join(__dirname, '../../../node_modules'),
        },
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      return resolve(JSON.stringify({ ok: false, error: '启动失败：' + e.message, files: [] }));
    }
    const timer = setTimeout(() => { killTree(child); }, ms);
    const killTree = (c) => {
      try { if (process.platform !== 'win32') process.kill(-c.pid, 'SIGKILL'); } catch (_) { try { c.kill('SIGKILL'); } catch (_) {} }
    };
    child.stdout.on('data', (d) => { stdout = (stdout + d).slice(-4000); });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.on('error', (e) => { clearTimeout(timer); resolve(JSON.stringify({ ok: false, error: e.message, files: [] })); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
      const after = fs.readdirSync(outDir);
      const files = after.filter((f) => !before.has(f)).map((f) => path.join(outDir, f));
      resolve(JSON.stringify({
        ok: code === 0,
        exitCode: code,
        stdout: stdout.slice(-1500),
        stderr: stderr.slice(-1500),
        files,
        outputDir: outDir,
      }));
    });
  });
}

// 可执行技能（docx/pptx/xlsx）激活时注入的智能体工具定义
function execToolDef() {
  return {
    type: 'function',
    function: {
      name: 'skill__run_script',
      description: '运行 Node.js 脚本生成办公文件：.docx 用 require("docx")、.pptx 用 require("pptxgenjs")、.xlsx 用 require("exceljs")。生成文件必须写入 process.env.AGENT_OUTPUT_DIR 目录（用 require("path").join 拼接文件名），禁止硬编码绝对路径。返回 {ok, files:[生成文件绝对路径], stdout, stderr}。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '完整 Node.js 脚本内容' },
          note: { type: 'string', description: '脚本用途简述（如：生成阿里云ECS新特性汇总.docx）' },
        },
        required: ['code'],
      },
    },
    _builtin: 'run',
  };
}

// 已启用的可执行技能（docx/pptx/xlsx）存在时返回工具定义，否则 null
function execToolIfActive(settings) {
  const hit = (settings && settings.skills || []).some((k) => k.enabled && /docx|pptx|xlsx/i.test(k.name || ''));
  return hit ? execToolDef() : null;
}

module.exports = { runNodeScript, execToolDef, execToolIfActive, artifactsDir };
