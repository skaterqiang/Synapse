@echo off
rem Windows 双击启动：浏览器访问 Synapse Web 模式
rem 自动处理：缺 Node.js → 尝试 winget/choco 安装；缺项目依赖 → 启动器内自动 npm install
cd /d "%~dp0"

rem 1) Node.js：缺失时尝试 winget，其次 chocolatey
where node >nul 2>nul
if not errorlevel 1 goto hasnode
echo 未检测到 Node.js。
where winget >nul 2>nul
if not errorlevel 1 (
  echo 正在通过 winget 安装 Node.js LTS（首次可能几分钟）…
  winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
) else (
  where choco >nul 2>nul
  if not errorlevel 1 (
    echo 正在通过 Chocolatey 安装 Node.js LTS…
    choco install nodejs-lts -y
  ) else (
    echo 请先安装 Node.js（LTS）：https://nodejs.org
    pause
    exit /b 1
  )
)
rem 安装后当前窗口 PATH 未刷新，补上默认安装目录
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%PATH%;%ProgramFiles%\nodejs"
where node >nul 2>nul
if errorlevel 1 (
  echo 安装完成但当前窗口找不到 node，请关闭本窗口后重新双击运行。
  pause
  exit /b 1
)
:hasnode
for /f "tokens=*" %v in (node -v 2^>nul) do echo Node 版本：%v

rem 2) 启动服务（依赖缺失时启动器会自动 npm install）并打开浏览器
node scripts\start-web.js
if errorlevel 1 (
  echo.
  echo 启动失败，请查看上方错误信息。
  pause
)
