// 假 MinerU 转换器（测试 fixture）：node fake-converter.js <input> <output> [-u <ollama>] [--mode=<m>]
// 用 Node 而非 .cmd/.sh：① 跨平台一致；② 可精确控制 stdout 字节流，
// 用于验证主进程的子进程日志解码器（跨块多字节截断、UTF-8 非法时回退 GBK）。
// 模式（--mode）：
//   ok      写出 out.md（默认）
//   argv    把收到的参数原样写进 out.md，供断言占位符替换/自动追加
//   env     把 PYTHONUTF8 / PYTHONIOENCODING / NO_PROXY 写进 out.md
//   split   把一个三字节中文字符拆成两次 write（验证跨块拼接不产生 U+FFFD）
//   gbk     输出 GBK 编码字节（验证 Windows 下回退 GBK 解码）
//   crlf    输出 \r 进度行 + ANSI 转义（验证 \r 视为行分隔并剥离控制序列）
//   imgs    写出 out.md 与同级 images/a.png（验证图片暂存）
//   empty   只建目录不写 md（验证「输出目录中没有 Markdown」报错）
//   fail    向 stderr 写原因并以退出码 3 结束
'use strict';
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
let mode = 'ok';
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-u') { i++; continue; }
  const m = /^--mode=(.+)$/.exec(a);
  if (m) { mode = m[1]; continue; }
  positional.push(a);
}
const input = positional[0] || '';
const output = positional[1] || '';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (mode === 'fail') {
    process.stderr.write('VLM 模型缺失：qwen2-vl 未安装\n');
    process.exit(3);
  }
  if (mode === 'split') {
    // “中” = E4 B8 AD：先写前两字节，再写第三字节 + 剩余文本
    const buf = Buffer.from('中文日志跨块输出', 'utf-8');
    process.stdout.write(buf.slice(0, 2));
    await wait(30);
    process.stdout.write(buf.slice(2));
    process.stdout.write('\n');
  } else if (mode === 'gbk') {
    // GBK：中文 = D6 D0 CE C4（UTF-8 解码必出替换符 → 触发 GBK 回退）
    // 一次 write 完整字节：解码器的末尾截留按 UTF-8 序列长度判定，GBK 双字节被拦腰截断无法还原
    process.stdout.write(Buffer.concat([Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('\n')]));
  } else if (mode === 'crlf') {
    process.stdout.write('\x1b[32m进度 10%\x1b[0m\r');
    await wait(20);
    process.stdout.write('\x1b[32m进度 90%\x1b[0m\r\n');
    process.stdout.write('完成行\n');
  }

  if (output) fs.mkdirSync(output, { recursive: true });

  if (mode === 'argv') {
    // 回写完整原始 argv（含 -u / --mode），供断言占位符替换与额外参数透传
    fs.writeFileSync(path.join(output, 'out.md'), '# ARGV\n\n' + JSON.stringify(argv) + '\n', 'utf-8');
    return;
  }
  if (mode === 'env') {
    fs.writeFileSync(path.join(output, 'out.md'), [
      '# ENV',
      `PYTHONUTF8=${process.env.PYTHONUTF8 || ''}`,
      `PYTHONIOENCODING=${process.env.PYTHONIOENCODING || ''}`,
      `NO_PROXY=${process.env.NO_PROXY || ''}`,
      `no_proxy=${process.env.no_proxy || ''}`,
    ].join('\n'), 'utf-8');
    return;
  }
  if (mode === 'empty') return;
  if (mode === 'imgs') {
    fs.mkdirSync(path.join(output, 'images'), { recursive: true });
    fs.writeFileSync(path.join(output, 'images', 'a.png'), 'PNGDATA');
    fs.writeFileSync(path.join(output, 'out.md'), '# 图片产物\n\n![](images/a.png)\n', 'utf-8');
    return;
  }
  // ok / split / gbk / crlf：都产出正常 Markdown
  fs.writeFileSync(path.join(output, 'out.md'), `# FAKE\nMINERU-CONVERTED ${path.basename(input)}\n`, 'utf-8');
})();
