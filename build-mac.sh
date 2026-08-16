#!/bin/bash
# Synapse macOS 构建脚本：生成可独立安装部署的 .pkg 安装包与 .dmg 镜像
# 用法：npm run dist:mac  或  bash build-mac.sh
#
# 流程：
#   1. electron-builder 打包出未签名的 Synapse.app（target=dir）
#   2. ad-hoc 重签名（由内向外）——绕过 macOS XProtect 对 linker-signed
#      Electron 的恶意软件误报（本机无开发者证书，无法做 Developer ID 签名）
#   3. pkgbuild 生成 .pkg 安装包（macOS 原生 Installer 安装到 /Applications）
#   4. hdiutil 生成 .dmg 镜像（拖拽安装）
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="Synapse"
VERSION=$(node -p "require('./package.json').version")
ARCH=$(node -p "process.arch === 'arm64' ? 'arm64' : 'x64'")
OUT="release"

echo "==> [1/4] electron-builder 构建 $APP_NAME.app（不签名）"
rm -rf "$OUT"/mac* "$OUT"/*.dmg "$OUT"/*.pkg
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir

# electron-builder 输出目录带架构后缀（mac / mac-arm64 / mac-x64）
APP_DIR=$(ls -d "$OUT"/mac* 2>/dev/null | head -1)
APP_PATH="$APP_DIR/$APP_NAME.app"

echo "==> [2/4] ad-hoc 重签名（由内向外，绕过 XProtect 误报）"
# 先签内层嵌套代码：Helper .app 与 .framework（find -depth 保证子级先于父级）
while IFS= read -r -d '' comp; do
  echo "    签名: ${comp#"$OUT/mac/"}"
  codesign --force --sign - "$comp"
done < <(find "$APP_PATH/Contents/Frameworks" -depth \( -name "*.app" -o -name "*.framework" \) -print0)
# 其余散落二进制（dylib 等）
while IFS= read -r -d '' bin; do
  codesign --force --sign - "$bin"
done < <(find "$APP_PATH/Contents" -maxdepth 2 -type f -name "*.dylib" -print0)
# 主 bundle（--deep 兜底未覆盖的嵌套代码）
codesign --force --deep --sign - "$APP_PATH"
codesign --verify --deep --strict "$APP_PATH" && echo "    签名校验通过"
xattr -cr "$APP_PATH"

echo "==> [3/4] 生成 .pkg 安装包"
pkgbuild --component "$APP_PATH" \
  --install-location /Applications \
  --version "$VERSION" \
  "$OUT/$APP_NAME-$VERSION-$ARCH.pkg"

echo "==> [4/4] 生成 .dmg 镜像"
STAGE="$OUT/dmg-stage"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R "$APP_PATH" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "$APP_NAME" -srcfolder "$STAGE" -ov -format UDZO \
  "$OUT/$APP_NAME-$VERSION-$ARCH.dmg"
rm -rf "$STAGE"

echo ""
echo "构建完成，产物位于 $OUT/ 目录："
ls -lh "$OUT" | grep -E "pkg|dmg"
echo ""
echo "安装方式："
echo "  方式一（pkg）：双击 $APP_NAME-$VERSION-$ARCH.pkg，按提示安装到 /Applications"
echo "  方式二（dmg）：双击 $APP_NAME-$VERSION-$ARCH.dmg，将 $APP_NAME 拖入 Applications"
