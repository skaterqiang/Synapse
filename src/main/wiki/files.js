// 本地文件解析：PDF/DOCX/Excel/PPTX/纯文本 → Markdown，并保存到 raw/
const path = require('path');
const fs = require('fs');
const TurndownService = require('turndown');
const JSZip = require('jszip');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const { PDFParse } = require('pdf-parse');
const { wikiRoot, slugify, uniquePath } = require('./wiki');

const FILE_EXTENSIONS = ['pdf', 'docx', 'xlsx', 'xls', 'pptx', 'md', 'markdown', 'txt', 'csv', 'html', 'htm'];

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

async function extractFileContent(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  const buffer = fs.readFileSync(absPath);
  switch (ext) {
    case '.md':
    case '.markdown':
    case '.txt':
    case '.csv':
    case '.json':
    case '.log':
      return buffer.toString('utf-8');
    case '.html':
    case '.htm': {
      const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
      return turndown.turndown(buffer.toString('utf-8'));
    }
    case '.pdf': {
      const parser = new PDFParse({ data: buffer });
      try {
        const res = await parser.getText();
        return res.text || '';
      } finally {
        parser.destroy();
      }
    }
    case '.docx': {
      const result = await mammoth.convertToHtml({ buffer });
      const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
      return turndown.turndown(result.value);
    }
    case '.xlsx':
    case '.xls': {
      const wb = XLSX.read(buffer, { type: 'buffer' });
      return wb.SheetNames.map((name) => {
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
        return `## 工作表：${name}\n\n\`\`\`\n${csv}\n\`\`\``;
      }).join('\n\n');
    }
    case '.pptx': {
      const zip = await JSZip.loadAsync(buffer);
      const slideNames = Object.keys(zip.files)
        .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
        .sort((a, b) => {
          const num = (s) => parseInt(s.match(/slide(\d+)/)[1], 10);
          return num(a) - num(b);
        });
      const parts = [];
      for (let i = 0; i < slideNames.length; i++) {
        const xml = await zip.files[slideNames[i]].async('string');
        const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXmlEntities(m[1]));
        if (texts.length) parts.push(`## 幻灯片 ${i + 1}\n\n${texts.join('\n')}`);
      }
      return parts.join('\n\n');
    }
    default:
      throw new Error(`不支持的文件格式：${ext || '无扩展名'}`);
  }
}

// 解析本地文件并保存到 raw/：原样保留原始文件（保留扩展名），查看时用本机软件打开；
// 管道（生成 Wiki/图谱）在读取时再按需提取文本（readRawText）。
async function saveFileSource(settings, filePath) {
  const root = wikiRoot(settings);
  const rawDir = path.join(root, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });

  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) throw new Error('文件不存在：' + filePath);
  const ext = path.extname(absPath).toLowerCase().replace(/^\./, '');
  if (!FILE_EXTENSIONS.includes(ext)) throw new Error(`不支持的格式 .${ext}（支持：${FILE_EXTENSIONS.join('、')}）`);

  const title = path.basename(absPath).replace(/\.[^.]+$/, '');
  const date = new Date().toISOString().slice(0, 10);
  const filename = `${date}-${slugify(title)}.${ext}`;
  // 重复校验：raw/ 下已存在同名（去日期前缀）且同大小的来源则直接复用，避免重复复制
  const suffix = `-${slugify(title)}.${ext}`;
  const srcSize = fs.statSync(absPath).size;
  const dup = fs.readdirSync(rawDir).find((f) => f.endsWith(suffix) && (() => { try { return fs.statSync(path.join(rawDir, f)).size === srcSize; } catch (_) { return false; } })());
  if (dup) return { relPath: 'raw/' + dup, title, ext };
  const file = uniquePath(rawDir, filename);
  fs.copyFileSync(absPath, file); // 原样保留原始文件
  return { relPath: 'raw/' + path.basename(file), title, ext };
}

// 读取 raw 来源文本：md/文本直接读；office/pdf 等按需提取；local: 前缀为本机引用路径
async function readRawText(settings, relPath) {
  const abs = String(relPath).startsWith('local:')
    ? String(relPath).slice('local:'.length)
    : path.join(wikiRoot(settings), String(relPath).replace(/^\//, ''));
  const ext = path.extname(abs).toLowerCase();
  if (['.md', '.markdown', '.txt', '.csv', '.json', '.log'].includes(ext)) {
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : '';
  }
  return extractFileContent(abs);
}

module.exports = { FILE_EXTENSIONS, saveFileSource, readRawText, extractFileContent };
