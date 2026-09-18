// 语料流水线·写笔记层（设计 §4.3 NoteImportDecorator）——extract-note 作业的终点
//
// 搬迁 jobs.js:399/423/426 的「解析 → importNote → 图片归位」中的**后两步**
// （解析已由内层 FallbackDecorator 完成，本层只拿 item.text 写笔记）。
//
//   · 标题：files.titleFromFileName(origin.name)（解码 URL 编码，≡ jobs.js:423）
//   · 目录归属 folderRel：仅「按目录添加」保留来源目录结构（root 名 + 子目录），单文件不套父目录（≡ jobs.js:415-420）
//   · source 传 origin.path（relPath）：同一来源重复提取时原地 upsert 而不新增重名笔记（≡ jobs.js:423）
//   · 图片归位：MinerU/脚本技能的图片副产物（meta.assets）并入笔记附件目录，正文 `](name)` 改写为 kb-asset 绝对引用
//
// ⚠️ 与 CorpusWriteDecorator 的差异：语料用**相对引用**（可迁移的纯文本资产），笔记用 **kb-asset 绝对引用**
//    （与现状 attachMineruImages 一致，笔记附件目录随笔记走）。故本层不复用 store.attachAssets。
'use strict';

const fs = require('fs');
const path = require('path');
const { CorpusDecorator } = require('../decorator');
const { addWarning } = require('../item');

const IMG_EXT_RE = /\.(png|jpe?g|gif|svg|webp|bmp|avif|ico)$/i;

/**
 * 把图片副产物并入笔记附件目录，并把正文里的裸文件名引用 `](name)` 改写为 kb-asset 绝对引用。
 * 与 files.js:244 attachMineruImages 同口径（跨目录用 copy 防 EXDEV），差别仅在引用形态：
 * MineruDecorator 已把 `](images/name)` 压平为 `](name)`，故这里按 `](name)` 改写。
 * @returns {number} 实际并入的图片数
 */
function attachNoteImages(notePath, text, assets) {
  const list = (Array.isArray(assets) ? assets : []).map((p) => String(p || '')).filter((p) => p && IMG_EXT_RE.test(p));
  if (!notePath || !list.length) return { text: String(text || ''), moved: 0 };
  const { kbAssetUrlFor } = require('../../common/paths');
  let out = String(text || '');
  try {
    const assetDir = path.join(path.dirname(notePath), path.basename(notePath, '.md'));
    fs.mkdirSync(assetDir, { recursive: true });
    let moved = 0;
    const prefix = kbAssetUrlFor(assetDir) + '/';
    for (const src of list) {
      try {
        if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
        const name = path.basename(src);
        const to = path.join(assetDir, name);
        if (path.resolve(src) !== path.resolve(to) && !fs.existsSync(to)) fs.copyFileSync(src, to);
        out = out.split('](' + name + ')').join('](' + prefix + name + ')');
        moved++;
      } catch (_) { /* 单张图失败不影响其余 */ }
    }
    return { text: out, moved };
  } catch (_) { return { text: out, moved: 0 }; }
}

class NoteImportDecorator extends CorpusDecorator {
  constructor(inner, opts = {}) {
    super(inner);
    this.opts = opts || {};
    this.written = 0;
    this.updated = 0;
    this.failed = 0;
    this.skipped = 0;
    this.images = 0;
    this.notes = [];
    this.writtenPaths = [];
    this._records = null;
  }

  get caps() { return { ...this.inner.caps, text: true }; }

  async open(ctx) {
    await this.inner.open(ctx);
    const c = ctx || {};
    // 缓存 listRaws 记录：按 origin.path 查 root/rel 以还原目录归属（≡ jobs.js:337-338 byPath）
    try {
      const raws = require('../../raws/raws');
      this._records = new Map((raws.listRaws(c.settings || {}) || []).map((r) => [String(r.path), r]));
    } catch (_) { this._records = new Map(); }
  }

  /** 目录归属（≡ jobs.js:415-420）：仅「按目录添加」保留来源目录结构，单文件不套父目录 */
  folderRelOf(item) {
    const o = (item && item.origin) || {};
    const rec = this._records ? this._records.get(String(o.path || '')) : null;
    if (rec) {
      const rootName = rec.root ? path.basename(String(rec.root).replace(/[\\/]+$/, '')) : '';
      const childDir = rec.root && rec.rel ? path.dirname(rec.rel) : '';
      return [rootName, childDir].filter((v) => v && v !== '.').join(path.sep);
    }
    // 兜底：无记录时按 origin.rel 的目录部分
    const rel = String(o.rel || '').replace(/\\/g, '/');
    const dir = rel.includes('/') ? path.dirname(rel) : '';
    return dir && dir !== '.' ? dir.split('/').join(path.sep) : '';
  }

  async next(ctx) {
    const c = ctx || {};
    const item = await this.inner.next(c);
    if (!item) return null;
    const task = this.taskOf(item, c);
    const text = String(item.text == null ? '' : item.text);
    const o = item.origin || {};
    const files = require('../../raws/files');
    const notesStore = require('../../notes/store');

    if (!text.trim()) {
      this.skipped++;
      if (task) { task.status = 'done'; task.output = (task.output || '') + '\n来源内容为空，已跳过'; this.emitTasks(c); }
      return item;
    }
    if (task) { task.status = 'running'; this.emitTasks(c); }
    try {
      const title = files.titleFromFileName(o.name || item.label || '未命名');
      const folderRel = this.folderRelOf(item);
      const source = String(o.path || item.label || '');
      // 先按原文写笔记（importNote 按 source upsert），落盘拿到 notePath 后再把图片并入附件目录、
      // 把正文 `](name)` 改写为 kb-asset 绝对引用（≡ files.js:244 attachMineruImages 的时机）
      const res = notesStore.importNote(title, text, folderRel, source);
      const finalAttach = attachNoteImages(res.path, text, item.meta && item.meta.assets);
      if (finalAttach.moved && finalAttach.text !== text) {
        try { fs.writeFileSync(res.path, finalAttach.text, 'utf-8'); } catch (_) { /* 改写失败不影响笔记本体 */ }
      }
      this.images += finalAttach.moved;
      // 清理 MinerU 暂存目录（图片已并入笔记附件）
      for (const d of (item.meta && item.meta.cleanupDirs) || []) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
      for (const f of (item.meta && item.meta.cleanupFiles) || []) { try { fs.unlinkSync(f); } catch (_) {} }

      this.written++;
      if (res.updated) this.updated++;
      this.notes.push(res);
      const relNotePath = path.relative(notesStore.notesRoot(), res.path).split(path.sep).join('/');
      this.writtenPaths.push(relNotePath);
      if (task) {
        task.status = 'done';
        task.output = `${res.updated ? '已更新已有笔记' : '已新建笔记'} → ${relNotePath}${finalAttach.moved ? `（含 ${finalAttach.moved} 张图）` : ''}`;
        this.emitTasks(c);
      }
      if (c.onStage) { try { c.onStage('save', 'running', `写入笔记 ${o.name || item.label}（${this.written} 篇）`); } catch (_) {} }
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;   // P11
      this.failed++;
      if (!Array.isArray(c.errors)) c.errors = [];
      c.errors.push({ label: o.name || item.label, error: err.message });
      addWarning(item, `写笔记失败：${err.message}`);
      if (task) { task.status = 'failed'; task.output = (task.output || '') + `\n[失败] ${err.message}`; this.emitTasks(c); }
    }
    return item;
  }

  taskOf(item, ctx) {
    const c = ctx || {};
    const tasks = c.shared && c.shared.tasks;
    const indexOf = c.shared && c.shared.taskIndexOf;
    if (!Array.isArray(tasks) || !(indexOf instanceof Map)) return null;
    const parentId = String(item.id || '').split('#')[0];
    const idx = indexOf.has(parentId) ? indexOf.get(parentId) : indexOf.get(item.id);
    return (idx != null && tasks[idx]) ? tasks[idx] : null;
  }
  emitTasks(ctx) { if (ctx && typeof ctx.onTasks === 'function' && ctx.shared && ctx.shared.tasks) { try { ctx.onTasks(ctx.shared.tasks); } catch (_) {} } }

  async finish(ctx) {
    const c = ctx || {};
    // 全失败 → fatalError，由适配层抛出（≡ jobs.js:462-464）
    if (!this.written && this.failed) c.shared.fatalError = `全部 ${this.failed} 个来源解析失败：${(c.errors && c.errors[0] && c.errors[0].error) || '未知错误'}`;
    c.shared.noteImport = { notes: this.notes, writtenPaths: this.writtenPaths, written: this.written, updated: this.updated, failed: this.failed, skipped: this.skipped, images: this.images };
    return {
      ok: true,
      count: this.written,
      stats: { notesWritten: this.written, notesUpdated: this.updated, notesFailed: this.failed, notesSkipped: this.skipped, noteImages: this.images },
      warnings: [],
    };
  }
}

module.exports = { NoteImportDecorator, attachNoteImages };
