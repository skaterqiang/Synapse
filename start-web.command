#!/bin/bash
# macOS 双击启动：浏览器访问 Synapse Web 模式
# 自动处理：缺 Node.js → 尝试 Homebrew 安装；缺项目依赖 → 启动器内自动 npm install
cd "$(dirname "$0")" || exit 1

# 1) Node.js：缺失时优先用 Homebrew 装（LTS）
if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js。"
  if command -v brew >/dev/null 2>&1; then
    echo "正在通过 Homebrew 安装 Node.js（首次可能几分钟）…"
    if ! brew install node; then
      echo ""
      echo "Homebrew 安装失败。请手动安装 Node.js（LTS）：https://nodejs.org"
      read -n 1 -s -r -p "按任意键关闭窗口…"
      exit 1
    fi
  else
    echo "请先安装 Node.js（LTS）：https://nodejs.org"
    echo "（或先安装 Homebrew：https://brew.sh ，再重新运行本脚本即可自动装 Node）"
    read -n 1 -s -r -p "按任意键关闭窗口…"
    exit 1
  fi
fi
echo "Node 版本：$(node -v)"

# 2) 启动服务（依赖缺失时启动器会自动 npm install）并打开浏览器
node scripts/start-web.js
code=$?
if [ $code -ne 0 ]; then
  echo ""
  echo "启动失败（退出码 $code），请查看上方错误信息。"
  read -n 1 -s -r -p "按任意键关闭窗口…"
fi
