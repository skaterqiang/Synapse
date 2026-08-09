// 本地文件解析：PDF/DOCX/Excel/PPTX/纯文本 → Markdown，并保存到 raw/
const path = require('path');
const fs = require('fs');
const TurndownService = require('turndown');
const JSZip = require('jszip');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const { PDFParse } = require('pdf-parse');
const { wikiRoot, slugify, uniquePath } = require('./wiki');

const FILE_EXTENSIONS = ['pdf', 'docx', 'xlsx', 'xls', 'pptx', 'md', 'markdown', 'txt', 'csv'];

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

// 解析本地文件并保存到 raw/
async function saveFileSource(settings, filePath) {
  const root = wikiRoot(settings);
  const rawDir = path.join(root, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });

  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) throw new Error('文件不存在：' + filePath);
  const ext = path.extname(absPath).toLowerCase().replace(/^\./, '');
  if (!FILE_EXTENSIONS.includes(ext)) throw new Error(`不支持的格式 .${ext}（支持：${FILE_EXTENSIONS.join('、')}）`);

  let text = await extractFileContent(absPath);
  text = String(text).trim();
  if (!text) throw new Error('文件内容为空或无法提取文本：' + path.basename(absPath));

  const title = path.basename(absPath).replace(/\.[^.]+$/, '');
  const md = `# ${title}\n\n> 来源文件: ${path.basename(absPath)} (${ext.toUpperCase()})\n> 导入时间: ${new Date().toISOString()}\n\n${text}`;

  const date = new Date().toISOString().slice(0, 10);
  const filename = `${date}-${slugify(title)}.md`;
  const file = uniquePath(rawDir, filename);
  fs.writeFileSync(file, md, 'utf-8');
  return { relPath: 'raw/' + path.basename(file), title };
}

module.exports = { FILE_EXTENSIONS, saveFileSource };
