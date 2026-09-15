// 语料流水线·语料落盘层（设计 §4.3 / §6）
//
// CorpusWriteDecorator：把解析产物写成 <数据根>/corpus/<领域>/<名称>.md（含 §6.2 的出处 frontmatter），
//   并把 MinerU / 脚本技能产出的图片副产物归位到同名 .assets/ 目录（store.attachAssets 负责）。
//
// 位置约束 O2：必须在 ChunkDecorator **内层**——落盘的是**完整** Markdown；
//   分块只是喂 LLM 的临时形态，不该产生 N 个碎片文件。
//
// 降级（§12.3）：写盘失败只记 warning，**item 照常透传**——语料库是副产品，
//   绝不能因为它坏了就让图谱抽取整条作业失败。
//
// 开关：settings.corpusPersist === false ⇒ 整层空转（只在内存里流转，不留语料库）。
//   注意这一层仍会被构造（配方里是 enabled 条件），空转时 finish() 给一条说明性 warning。
//
// 副产物清理：attachAssets 用的是 **copy** 而非 move（防 EXDEV），
//   故 MinerU 的暂存目录（meta.cleanupDirs）与脚本技能的非图片产物（meta.cleanupFiles）
//   在写盘成功后由本层删除——否则会永久堆在 artifacts/ 与系统临时目录里。
'use strict';

const fs = require('fs');
const { CorpusDecorator } = require('../decorator');
const { addWarning } = require('../item');

/** 删除一批临时文件/目录（尽力而为，任何失败都吞掉） */
function cleanup(list, recursive) {
  for (const p of (Array.isArray(list) ? list : [])) {
    const s = String(p || '');
    if (!s) continue;
    try {
      if (recursive) fs.rmSync(s, { recursive: true, force: true });
      else fs.unlinkSync(s);
    } catch (_) { /* 清理失败不影响主流程 */ }
  }
}

class CorpusWriteDecorator extends CorpusDecorator {
  /**
   * @param {CorpusStream} inner
   * @param {Object} opts { terminal, persist }
   *   terminal=true 时本层是 CORPUS_RECIPE 的终点（extract-corpus 作业：只抽语料、不入图、不写笔记）
   *   persist 显式给出时优先于 settings.corpusPersist（便于测试与「本次不落盘」的一次性调用）
   */
  constructor(inner, opts = {}) {
    super(inner);
    this.opts = opts || {};
    this.terminal = !!this.opts.terminal;
    this.written = 0;
    this.created = 0;
    this.updated = 0;
    this.skipped = 0;
    this.failed = 0;
    this.assets = 0;
    this.evicted = 0;
    this.rels = [];
    this._persist = null;
  }

  get caps() { return { ...this.inner.caps, text: true }; }

  /** 本次是否落盘（settings.corpusPersist 默认 true，故只有显式 false 才关） */
  shouldPersist(ctx) {
    if (this._persist !== null) return this._persist;
    if (typeof this.opts.persist === 'boolean') { this._persist = this.opts.persist; return this._persist; }
    const s = (ctx && ctx.settings) || {};
    this._persist = s.corpusPersist !== false;
    return this._persist;
  }

  async next(ctx) {
    const c = ctx || {};
    const item = await this.inner.next(c);
    if (!item) return null;
    if (!this.shouldPersist(c)) { this.skipped++; return item; }

    const text = String(item.text == null ? '' : item.text);
    if (!text.trim()) {
      // 空正文不是「失败」：内置解析对空 PDF 合法返回空串（files.js:691），照实跳过
      this.skipped++;
      return item;
    }

    let res = null;
    try {
      const store = require('../store');
      res = store.writeCorpus(item, c);
    } catch (err) {
      res = { ok: false, error: (err && err.message) || String(err) };
    }

    if (res && res.ok) {
      this.written++;
      if (res.created) this.created++; else this.updated++;
      this.assets += Number(res.assets) || 0;
      this.evicted += Number(res.evicted) || 0;
      if (res.rel) this.rels.push(res.rel);
      // meta 追加式（C3）：只加不改
      item.meta.corpusFile = 'corpus/' + String(res.rel).replace(/\\/g, '/');
      item.meta.corpusVersion = Number(res.version) || 1;
      if (!item.meta.corpusId && res.corpusId) item.meta.corpusId = String(res.corpusId);
      // 副产物已归位到 .assets/，暂存目录与脚本残留可以删了
      cleanup(item.meta.cleanupDirs, true);
      cleanup(item.meta.cleanupFiles, false);
      delete item.meta.cleanupDirs;
      delete item.meta.cleanupFiles;
      if (c.onLog) {
        try { c.onLog(`语料已写入：${item.meta.corpusFile}（v${item.meta.corpusVersion}）`); } catch (_) { /* 忽略 */ }
      }
    } else {
      this.failed++;
      const msg = `语料落盘失败：${(res && res.error) || '未知错误'}（不影响图谱抽取）`;
      addWarning(item, msg);
      this.pushWarning(c, msg);
      if (c.onLog) { try { c.onLog('⚠ ' + msg); } catch (_) { /* 忽略 */ } }
      // 落盘失败也要清理暂存，否则临时目录越堆越多
      cleanup(item.meta.cleanupDirs, true);
      cleanup(item.meta.cleanupFiles, false);
    }
    return item; // P10：无论成败都透传
  }

  async finish(ctx) {
    const warnings = [];
    if (this._persist === false) warnings.push('语料落盘已关闭（corpusPersist=false），本次产物只在内存中流转');
    return {
      ok: true,
      count: 0,
      stats: {
        corpusWritten: this.written,
        corpusCreated: this.created,
        corpusUpdated: this.updated,
        corpusSkipped: this.skipped,
        corpusFailed: this.failed,
        corpusAssets: this.assets,
        corpusEvicted: this.evicted,
      },
      warnings,
    };
  }
}

module.exports = { CorpusWriteDecorator, cleanup };
