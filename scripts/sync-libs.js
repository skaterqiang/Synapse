// 将 node_modules 中 pinned 的前端库（marked / dompurify / highlight.js）
// 同步到 src/lib/，保证渲染层内嵌副本与 package.json 版本一致。
// 用法：node scripts/sync-libs.js（postinstall 自动执行）
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const libDir = path.join(root, 'src', 'lib');

// [源（相对 node_modules）, 目标（相对 src/lib）]
const FILES = [
  ['marked/lib/marked.umd.js', 'marked.min.js'],
  ['dompurify/dist/purify.min.js', 'purify.min.js'],
  ['@highlightjs/cdn-assets/highlight.min.js', 'highlight.min.js'],
  ['@highlightjs/cdn-assets/styles/atom-one-dark.min.css', 'hljs-atom-one-dark.min.css'],
];

let copied = 0;
for (const [from, to] of FILES) {
  const src = path.join(root, 'node_modules', from);
  const dst = path.join(libDir, to);
  if (!fs.existsSync(src)) {
    console.warn(`[sync-libs] 跳过（源不存在）: ${from}`);
    continue;
  }
  fs.copyFileSync(src, dst);
  copied++;
  console.log(`[sync-libs] ${from} -> src/lib/${to}`);
}
console.log(`[sync-libs] 完成，共同步 ${copied}/${FILES.length} 个文件`);
