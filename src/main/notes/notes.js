// 笔记领域层：附件选择/图片落盘/AI 扫描文稿/笔记导出（IPC 业务逻辑，由 ipc.js 委托）
const { app, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const llm = require('../ai/llm');
const paths = require('../common/paths');
const { getPrompt } = require('../ai/prompts');
const db = require('../common/db');
const store = require('./store');

// 导出笔记为 Markdown/文本文件
async function exportNote(getWindow, { defaultName, content }) {
  const result = await dialog.showSaveDialog(getWindow(), {
    defaultPath: defaultName || 'note.md',
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: '文本文件', extensions: ['txt'] },
    ],
  });
  if (!result.canceled && result.filePath) {
    fs.writeFileSync(result.filePath, content, 'utf-8');
    return { ok: true, path: result.filePath };
  }
  return { ok: false };
}

// 选择图片/文件：图片返回 dataUrl 供 Markdown 内嵌，非图片返回路径供链接引用
async function pickImage(getWindow, { imagesOnly } = {}) {
  const res = await dialog.showOpenDialog(getWindow(), {
    title: imagesOnly ? '选择照片' : '附加文件',
    properties: ['openFile'],
    filters: imagesOnly
      ? [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }]
      : [{ name: '所有文件', extensions: ['*'] }],
  });
  if (res.canceled || !res.filePaths.length) return { ok: true, canceled: true };
  const p = res.filePaths[0];
  const name = path.basename(p);
  const ext = path.extname(p).slice(1).toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) {
    const buf = fs.readFileSync(p);
    if (buf.length > 4 * 1024 * 1024) return { ok: false, error: '图片超过 4MB，请压缩后再插入' };
    const mime = ext === 'jpg' ? 'image/jpeg' : 'image/' + ext;
    return { ok: true, name, path: p, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
  }
  return { ok: true, name, path: p, dataUrl: null };
}

// 图片落盘：保存到该笔记自身目录（<note根>/<目录>/<笔记标题>/），返回绝对路径供 kb-asset 引用
async function saveImage({ dataUrl, name, title, folderId }) {
  try {
    const m = /^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i.exec(String(dataUrl || ''));
    if (!m) return { ok: false, error: '图片数据无效' };
    const safe = (s, dft) => (String(s || '').trim().replace(/[\\/:*?"<>|]/g, '-').slice(0, 40) || dft);
    const dir = store.noteAssetDir(title, folderId);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, safe(name, 'image.png'));
    fs.writeFileSync(target, Buffer.from(m[2], 'base64'));
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// 扫描文稿：图片送大模型视觉能力识别，输出 Markdown（复用已配置的模型与 Key）
async function scan({ settings, dataUrl }) {
  try {
    const text = await llm.chatOnce(settings, [
      {
        role: 'user',
        content: [
          { type: 'text', text: '你是文档扫描助手：请识别图片中的文字与表格，尽量保留原有结构，直接输出 Markdown 正文，不要输出任何解释。' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ]);
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// 在系统文件管理器中打开笔记所在文件夹
async function openNoteFolder({ folderId }) {
  if (!shell) return { ok: false, error: '当前环境不支持打开本地文件夹' };
  const dir = store.notesDirFor(folderId);
  fs.mkdirSync(dir, { recursive: true });
  const err = await shell.openPath(dir);
  if (err) return { ok: false, error: err };
  return { ok: true, path: dir };
}

// AI 辅助（编辑器工具栏）：默认润色提示词，可在设置-编辑器自定义
const DEFAULT_AI_ASSIST_PROMPT = '你是一位专业文字编辑：请润色以下内容，修正错别字与语病、优化表达与标点，保持原意与 Markdown 结构不变，直接输出润色后的全文，不要输出任何解释或额外说明。';

async function aiAssist({ settings, text, prompt }) {
  try {
    const sys = (prompt || '').trim() || getPrompt(settings, 'aiAssistPrompt');
    const out = await llm.chatOnce(settings, [
      { role: 'system', content: sys },
      { role: 'user', content: String(text || '') },
    ]);
    return { ok: true, text: String(out || '').trim() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------- 笔记历史版本 ----------------
// 版本号 = 日期+时间精确到秒（如 2026-08-12 14:16:05）；同一笔记同秒已存在时追加 -2/-3 保证唯一
function formatVersion(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 保存一条历史版本（AI 改动前/后各自动一条；恢复前自动备份也走这里）
function saveVersion({ noteId, content, label }) {
  try {
    if (!noteId) return { ok: false, error: '缺少笔记 ID' };
    const now = Date.now();
    let version = formatVersion(now);
    const dup = db.all('SELECT COUNT(*) AS c FROM note_versions WHERE note_id = ? AND version = ?', [String(noteId), version])[0].c || 0;
    if (dup) version = `${version}-${dup + 1}`;
    db.run('INSERT INTO note_versions (note_id, version, label, content, created_at) VALUES (?,?,?,?,?)', [String(noteId), version, String(label || ''), String(content || ''), now]);
    db.flush();
    return { ok: true, version };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// 版本列表（新→旧）
function listVersions({ noteId }) {
  try {
    const rows = db.all('SELECT version, label, created_at AS createdAt FROM note_versions WHERE note_id = ? ORDER BY created_at DESC, rowid DESC', [String(noteId || '')]);
    return { ok: true, versions: rows };
  } catch (err) {
    return { ok: false, error: err.message, versions: [] };
  }
}

// 取指定版本正文
function getVersion({ noteId, version }) {
  try {
    const rows = db.all('SELECT content, label FROM note_versions WHERE note_id = ? AND version = ?', [String(noteId || ''), String(version || '')]);
    if (!rows.length) return { ok: false, error: '版本不存在' };
    return { ok: true, content: rows[0].content, label: rows[0].label };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// 删除笔记时一并清理其历史版本
function deleteVersions(noteId) {
  try {
    db.run('DELETE FROM note_versions WHERE note_id = ?', [String(noteId || '')]);
    db.flush();
  } catch (_) {}
}

module.exports = { exportNote, pickImage, saveImage, scan, openNoteFolder, aiAssist, DEFAULT_AI_ASSIST_PROMPT, saveVersion, listVersions, getVersion, deleteVersions };
