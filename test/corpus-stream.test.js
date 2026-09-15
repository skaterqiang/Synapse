// 语料流水线·一期地基测试（设计 §14.1 一期验收）
// 验收口径：「不接 LLM、不接业务：用 ArraySource + 3 个假装饰器验证接口契约
//           （C1–C3、StageResult 5 字段、drive 的 abort 与 finally）」
//
// 覆盖：
//   · StageResult 恰好 5 字段（§12.1 新增硬契约）+ mergeResults 的 layer 前缀去重
//   · C1/P1：next() 返回 null 后不得复活
//   · C2/P2：close() 幂等、finish() 只跑一次（否则 saveGraph 重复、边数翻倍）
//   · C3/P3：item.origin 冻结不可变、meta 追加式
//   · drive：finally 必调 close（正常结束 / 抛错 / abort 三条路径）、maxItems 截断、itemCount
//   · P11：AbortError 必须一路冒泡到调用方
//   · P10：单条失败不断流（errors 收集 + 后续条目继续产出）
//   · estimate 逐层透传；caps 逐层透传；CapsDecorator 覆写
//   · corpusId 稳定性（同源同技能同指纹；技能版本变则指纹变）、chunkId 形态
//   · frontmatter 序列化/解析往返（§6.2 语料文件头）
//   · RawFileSource 真实读盘 + 缺失文件跳过；LogDecorator provenance 累积 + >100 次 LLM 提示
// 运行：node test/corpus-stream.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { bootEnv, mkCheck, writeFile } = require('./helpers/harness');

const { check, section, summary } = mkCheck('语料流水线·地基');

// ---- 假装饰器：验证 C1–C3 与 StageResult 合并 ----
const { CorpusStream } = require('../src/main/corpus/stream');
const { CorpusDecorator } = require('../src/main/corpus/decorator');

class CountingDecorator extends CorpusDecorator {
  constructor(inner, opts = {}) {
    super(inner);
    this.opts = opts;
    this.n = 0;
    this.finishCalls = 0;
    this.closeCalls = 0;
  }
  async next(ctx) {
    const it = await super.next(ctx);
    if (it) this.n++;
    return it;
  }
  async finish(ctx) {
    this.finishCalls++;
    return { ok: true, count: this.n, stats: { seen: this.n }, warnings: this.opts.warn ? ['w-' + this.layer] : [] };
  }
  async close(ctx) {
    this.closeCalls++;
    return super.close(ctx);
  }
}

/** 违反 C1 的坏装饰器：返回 null 后又复活（用于验证 drive 不会被它拖成死循环——drive 只认第一个 null） */
class RevivingDecorator extends CorpusDecorator {
  constructor(inner) { super(inner); this.n = 0; }
  async next(ctx) {
    const it = await super.next(ctx);
    if (it) { this.n++; return it; }
    this.n++;
    if (this.n <= 3) return null;      // 先给 3 个 null
    return { id: 'ghost', label: 'ghost', kind: 'inline', origin: {}, meta: {} }; // 再复活（违反 C1）
  }
}

/** 抛错的装饰器：验证 drive 的 finally 仍然 close */
class ThrowingDecorator extends CorpusDecorator {
  constructor(inner) { super(inner); this.closeCalls = 0; this.finishCalls = 0; }
  async next(ctx) { throw new Error('boom'); }
  async finish(ctx) { this.finishCalls++; return null; }
  async close(ctx) { this.closeCalls++; return super.close(ctx); }
}

(async () => {
  const env = await bootEnv({ prefix: 'synapse-corpus-' });
  const stream = require('../src/main/corpus/stream');
  const { drive, makeContext, mkAbortErr, isAbort } = require('../src/main/corpus/drive');
  const item = require('../src/main/corpus/item');
  const { ArraySource, RawFileSource, InlineSource, resolveRecords, absOf } = require('../src/main/corpus/sources');
  const { LogDecorator, NullSink, CapsDecorator, LLM_CALL_HINT_AT } = require('../src/main/corpus/decorators/log');

  // ================= StageResult 契约 =================
  section('StageResult 5 字段契约（§12.1）');
  const empty = stream.emptyResult();
  check('emptyResult 恰好 5 个字段', Object.keys(empty).length === 5, Object.keys(empty).join(','));
  check('emptyResult 字段名与顺序一致',
    Object.keys(empty).join(',') === 'ok,count,stats,warnings,error', Object.keys(empty).join(','));
  check('emptyResult 默认值正确',
    empty.ok === true && empty.count === 0 && empty.error === ''
    && typeof empty.stats === 'object' && Array.isArray(empty.warnings));

  const merged = stream.mergeResults(
    { ok: true, count: 3, stats: { seen: 3 }, warnings: ['outer'], error: '', layer: 'CountingDecorator' },
    { ok: true, count: 5, stats: { seen: 5, llmCalls: 2 }, warnings: ['inner'], error: '' },
  );
  check('mergeResults 仍是 5 字段', Object.keys(merged).length === 5, Object.keys(merged).join(','));
  check('mergeResults 键冲突时加 layer 前缀', merged.stats['CountingDecorator.seen'] === 3, JSON.stringify(merged.stats));
  check('mergeResults 无冲突键原样保留', merged.stats.llmCalls === 2, JSON.stringify(merged.stats));
  check('mergeResults count 取外层', merged.count === 3, String(merged.count));
  check('mergeResults warnings 内层在前', merged.warnings.join('|') === 'inner|outer', merged.warnings.join('|'));
  check('mergeResults ok 任一为假即假',
    stream.mergeResults({ ok: false, count: 0, stats: {}, warnings: [], error: 'x' }, empty).ok === false);
  check('mergeResults error 外层优先',
    stream.mergeResults({ ok: false, count: 0, stats: {}, warnings: [], error: 'outer-err' },
      { ok: false, count: 0, stats: {}, warnings: [], error: 'inner-err' }).error === 'outer-err');
  check('mergeResults 容忍 undefined 入参', (() => {
    const r = stream.mergeResults(undefined, undefined);
    return r.ok === true && r.count === 0 && Object.keys(r).length === 5;
  })());

  // ================= CorpusStream 基类 =================
  section('CorpusStream 基类默认能力');
  const base = new CorpusStream();
  check('基类 caps 5 个标志全为 false',
    Object.keys(base.caps).length === 5 && Object.values(base.caps).every((v) => v === false),
    JSON.stringify(base.caps));
  check('基类 layer = 类名', base.layer === 'CorpusStream', base.layer);
  check('基类 next() 返回 null', (await base.next({})) === null);
  check('基类 estimate() 返回 {total:-1}', base.estimate({}).total === -1);
  const baseClose = await base.close({});
  check('基类 close() 返回 5 字段 StageResult', Object.keys(baseClose).length === 5);

  // ================= C1：null 不复活 =================
  section('C1 / P1：next() 返回 null 后不得复活');
  const src1 = new ArraySource(['a', 'b', 'c']);
  const c1 = makeContext({});
  await src1.open(c1);
  const got = [];
  let v;
  while ((v = await src1.next(c1)) !== null) got.push(v.text);
  check('ArraySource 产出 3 条', got.length === 3 && got.join(',') === 'a,b,c', got.join(','));
  const again1 = await src1.next(c1);
  const again2 = await src1.next(c1);
  check('耗尽后连续两次 next() 仍为 null（不复活）', again1 === null && again2 === null);

  const reviving = new RevivingDecorator(new ArraySource(['x']));
  const c1b = makeContext({});
  const seen = [];
  await drive(reviving, c1b);
  // drive 只认第一个 null：坏装饰器复活的那条不该被消费
  check('drive 遇到第一个 null 即停（坏装饰器复活无效）', c1b.itemCount === 1, 'itemCount=' + c1b.itemCount);

  // ================= C2：close 幂等 =================
  section('C2 / P2：close() 幂等、finish() 只跑一次');
  const cnt = new CountingDecorator(new ArraySource(['a', 'b']));
  const c2 = makeContext({});
  const r1 = await drive(cnt, c2);
  check('finish() 恰好调用 1 次', cnt.finishCalls === 1, 'finishCalls=' + cnt.finishCalls);
  const r2 = await cnt.close(c2);
  const r3 = await cnt.close(c2);
  check('重复 close() 不再调 finish()', cnt.finishCalls === 1, 'finishCalls=' + cnt.finishCalls);
  check('重复 close() 返回同一结果对象', r2 === r3 && r2.count === r1.count, 'count=' + r2.count);
  check('close 结果 stats 含本层 seen', r1.stats.seen === 2, JSON.stringify(r1.stats));

  // 嵌套两层：验证 close 自外向内、finish 各一次、warnings 两层合并
  const innerD = new CountingDecorator(new ArraySource(['a', 'b', 'c']), { warn: true });
  const outerD = new CountingDecorator(innerD, { warn: true });
  const c2b = makeContext({});
  const rNest = await drive(outerD, c2b);
  check('嵌套：内外层 finish 各 1 次', innerD.finishCalls === 1 && outerD.finishCalls === 1,
    `inner=${innerD.finishCalls} outer=${outerD.finishCalls}`);
  check('嵌套：count 取最外层', rNest.count === 3, 'count=' + rNest.count);
  check('嵌套：warnings 合并两层', rNest.warnings.length === 2, JSON.stringify(rNest.warnings));
  check('嵌套：stats 键冲突时按 layer 前缀去重', rNest.stats['CountingDecorator.seen'] === 3, JSON.stringify(rNest.stats));
  await outerD.close(c2b);
  check('嵌套：重复 close 后 finish 仍各 1 次', innerD.finishCalls === 1 && outerD.finishCalls === 1);

  // ================= C3：origin 不可变 =================
  section('C3 / P3：item.origin 不可变、meta 追加式');
  const it3 = item.makeItem({
    kind: 'raw', label: '原始·a.pdf',
    origin: { type: 'local', path: 'local:D:/a.pdf', name: 'a.pdf', ext: '.pdf', size: 10, mtime: 100 },
    text: 'hello',
  });
  check('origin 被冻结', Object.isFrozen(it3.origin));
  let threw = false;
  try { 'use strict'; it3.origin.name = 'hacked'; } catch (_) { threw = true; }
  check('改 origin 抛错或无效（严格模式抛 TypeError）', threw || it3.origin.name === 'a.pdf', 'name=' + it3.origin.name);
  check('meta 默认含 provenance/warnings 数组',
    Array.isArray(it3.meta.provenance) && Array.isArray(it3.meta.warnings));
  item.addProvenance(it3, { layer: 'X', ms: 1 });
  item.addProvenance(it3, { layer: 'Y', ms: 2 });
  check('addProvenance 追加不覆盖', it3.meta.provenance.length === 2
    && it3.meta.provenance[0].layer === 'X' && it3.meta.provenance[1].layer === 'Y');
  check('addProvenance 自动补 at 时间戳', typeof it3.meta.provenance[0].at === 'number');
  item.addWarning(it3, '降级了');
  check('addWarning 追加到 meta.warnings', it3.meta.warnings.join(',') === '降级了');

  // deriveItem：origin 必须是同一个冻结对象引用
  const chunk = item.deriveItem(it3, { id: item.chunkId(it3.id, 0), kind: 'chunk', text: 'he', meta: { chunk: { index: 0, total: 2 } } });
  check('deriveItem 复用同一 origin 引用', chunk.origin === it3.origin);
  check('deriveItem 的 origin 仍冻结', Object.isFrozen(chunk.origin));
  check('deriveItem 不污染父 meta', it3.meta.chunk === undefined && chunk.meta.chunk.index === 0);
  check('deriveItem 继承父 provenance 数组内容', Array.isArray(chunk.meta.provenance));

  // ================= 身份键 =================
  section('语料指纹 corpusId / chunkId（§3.6）');
  const o = { type: 'local', path: 'local:D:/a.pdf', size: 10, mtime: 100 };
  const id1 = item.corpusId(o, { name: 'extract-markdown', version: '1.0.0' });
  const id2 = item.corpusId(o, { name: 'extract-markdown', version: '1.0.0' });
  const id3 = item.corpusId(o, { name: 'extract-markdown', version: '1.1.0' });
  const id4 = item.corpusId(o, null);
  const id5 = item.corpusId({ ...o, mtime: 101 }, { name: 'extract-markdown', version: '1.0.0' });
  check('corpusId 长度 16', id1.length === 16, id1);
  check('corpusId 十六进制', /^[0-9a-f]{16}$/.test(id1), id1);
  check('同源同技能 → 同指纹（稳定）', id1 === id2);
  check('技能版本变 → 指纹变', id1 !== id3);
  check('无技能 → 与有技能不同', id1 !== id4);
  check('源 mtime 变 → 指纹变', id1 !== id5);
  check('chunkId 形态 = parentId#index', item.chunkId('abc', 2) === 'abc#2', item.chunkId('abc', 2));
  check('makeItem 未给 id 时自动算指纹', it3.id.length === 16 && it3.id === item.corpusId(it3.origin, undefined), it3.id);

  // ================= drive：finally / abort / maxItems =================
  section('drive()：finally 必调 close、abort 冒泡、maxItems 截断');

  // 正常结束
  const d1 = new CountingDecorator(new ArraySource(['a', 'b', 'c']));
  const ctx1 = makeContext({});
  const res1 = await drive(d1, ctx1);
  check('正常结束：close 被调用', d1.closeCalls === 1, 'closeCalls=' + d1.closeCalls);
  check('正常结束：ctx.result 被回填', ctx1.result === res1);
  check('正常结束：ctx.itemCount = 3', ctx1.itemCount === 3, String(ctx1.itemCount));
  check('正常结束：返回 5 字段 StageResult', Object.keys(res1).length === 5, Object.keys(res1).join(','));

  // onItem 回调逐条触发，n 从 1 开始
  const seenIdx = [];
  await drive(new ArraySource(['a', 'b']), makeContext({ onItem: (it, n) => { seenIdx.push(n + ':' + it.text); } }));
  check('onItem 收到 (item, n) 且 n 从 1 起', seenIdx.join(',') === '1:a,2:b', seenIdx.join(','));

  // maxItems 截断
  const ctxMax = makeContext({ maxItems: 2 });
  const dMax = new CountingDecorator(new ArraySource(['a', 'b', 'c', 'd']));
  await drive(dMax, ctxMax);
  check('maxItems=2 时只消费 2 条', ctxMax.itemCount === 2, String(ctxMax.itemCount));
  check('maxItems 截断后仍调 close', dMax.closeCalls === 1);
  const ctxMax0 = makeContext({ maxItems: 0 });
  await drive(new ArraySource(['a']), ctxMax0);
  check('maxItems=0 表示不限', ctxMax0.itemCount === 1, String(ctxMax0.itemCount));

  // 抛错路径：finally 仍 close
  const dThrowInner = new CountingDecorator(new ArraySource(['a']));
  const dThrow = new ThrowingDecorator(dThrowInner);
  const ctxThrow = makeContext({});
  let caught = null;
  try { await drive(dThrow, ctxThrow); } catch (e) { caught = e; }
  check('内层抛错时 drive 向上抛', caught && caught.message === 'boom', String(caught && caught.message));
  check('内层抛错时 finally 仍调 close（外层）', dThrow.closeCalls === 1, 'closeCalls=' + dThrow.closeCalls);
  check('内层抛错时 finally 仍调 close（内层）', dThrowInner.closeCalls === 1, 'closeCalls=' + dThrowInner.closeCalls);
  check('抛错时 ctx.result 仍被回填', ctxThrow.result && ctxThrow.result.ok === true, JSON.stringify(ctxThrow.result));

  // abort 路径（P11）
  const ac = new AbortController();
  const ctxAbort = makeContext({ signal: ac.signal });
  const dAbortInner = new CountingDecorator(new ArraySource(['a', 'b', 'c', 'd']));
  let abortErr = null;
  try {
    await drive(dAbortInner, Object.assign(ctxAbort, {
      onItem: (it, n) => { if (n === 2) ac.abort(); },
    }));
  } catch (e) { abortErr = e; }
  check('abort 时抛出 AbortError（P11 一路冒泡）', abortErr && isAbort(abortErr), String(abortErr && abortErr.name));
  check('AbortError 的 name = AbortError', abortErr && abortErr.name === 'AbortError');
  check('abort 时 finally 仍调 close', dAbortInner.closeCalls === 1, 'closeCalls=' + dAbortInner.closeCalls);
  check('abort 时只消费到第 2 条', ctxAbort.itemCount === 0 || ctxAbort.itemCount === 2,
    'itemCount=' + ctxAbort.itemCount);

  // Source 内部也检查 abort（RawFileSource/ArraySource 的 next 里）
  const ac2 = new AbortController();
  ac2.abort();
  let srcAbort = null;
  try { await drive(new ArraySource(['a']), makeContext({ signal: ac2.signal })); } catch (e) { srcAbort = e; }
  check('预先 abort 时 Source.next 直接抛 AbortError', srcAbort && isAbort(srcAbort));

  // drive 入参校验
  let typeErr = null;
  try { await drive(null, makeContext({})); } catch (e) { typeErr = e; }
  check('drive(null) 抛 TypeError', typeErr instanceof TypeError, String(typeErr && typeErr.message));

  // 装饰器构造校验
  let decErr = null;
  try { new CorpusDecorator(null); } catch (e) { decErr = e; }
  check('装饰器无内层时抛 TypeError', decErr instanceof TypeError, String(decErr && decErr.message));
  check('TypeError 文案与设计一致', decErr && decErr.message === '装饰器需要一个 CorpusStream 作为内层',
    String(decErr && decErr.message));
  let decErr2 = null;
  try { new CorpusDecorator({}); } catch (e) { decErr2 = e; }
  check('内层没有 next() 也抛 TypeError', decErr2 instanceof TypeError);

  // ================= caps / estimate 透传 =================
  section('caps 与 estimate 逐层透传');
  const capSrc = new ArraySource(['a'], { bytes: true, text: false });
  check('ArraySource caps 由入参决定', capSrc.caps.bytes === true && capSrc.caps.text === false, JSON.stringify(capSrc.caps));
  const capDec = new CountingDecorator(capSrc);
  check('装饰器 caps 透传内层', capDec.caps === capSrc.caps || JSON.stringify(capDec.caps) === JSON.stringify(capSrc.caps),
    JSON.stringify(capDec.caps));
  const capOvr = new CapsDecorator(capSrc, { text: true, graph: true });
  check('CapsDecorator 可覆写能力声明', capOvr.caps.text === true && capOvr.caps.graph === true && capOvr.caps.bytes === true,
    JSON.stringify(capOvr.caps));
  const est = new CountingDecorator(new ArraySource(['a', 'b', 'c'])).estimate({});
  check('estimate 透传（total=3）', est.total === 3, JSON.stringify(est));
  const estLabels = new ArraySource([{ label: 'L1', text: 'a' }, { label: 'L2', text: 'b' }]).estimate({});
  check('estimate 给出 labels', estLabels.labels.join(',') === 'L1,L2', JSON.stringify(estLabels.labels));

  // ================= P10：单条失败不断流 =================
  section('P10：单条失败不中断整条流');
  const ctxP10 = makeContext({});
  const failSrc = new ArraySource([{ label: 'ok1', text: 'a' }, { label: 'bad', text: 'b' }, { label: 'ok2', text: 'c' }], { failOn: ['bad'] });
  const resP10 = await drive(failSrc, ctxP10);
  check('坏条目被跳过、好条目照常产出', ctxP10.itemCount === 2, 'itemCount=' + ctxP10.itemCount);
  check('坏条目记入 ctx.errors', ctxP10.errors.length === 1 && ctxP10.errors[0].label === 'bad', JSON.stringify(ctxP10.errors));
  check('drive 未因单条失败而抛错', resP10.ok === true);

  // ================= makeContext 归一化 =================
  section('makeContext：回调归一化 + 额外字段透传');
  const ctxN = makeContext({ jobId: 'j1', tasks: [1, 2], autoReason: false, forceMineru: true });
  check('未给回调时补 noop 函数', typeof ctxN.onLog === 'function' && typeof ctxN.onStage === 'function'
    && typeof ctxN.onProgress === 'function');
  check('onItem 未给时为 null（drive 据此跳过）', ctxN.onItem === null);
  check('调用方额外字段透传', Array.isArray(ctxN.tasks) && ctxN.autoReason === false && ctxN.forceMineru === true);
  check('stats/shared/errors/warnings 归一为容器', typeof ctxN.stats === 'object' && typeof ctxN.shared === 'object'
    && Array.isArray(ctxN.errors) && Array.isArray(ctxN.warnings));
  check('itemCount/result 初值', ctxN.itemCount === 0 && ctxN.result === null);
  check('传入 undefined 回调不会被当成函数', typeof makeContext({ onLog: undefined }).onLog === 'function');
  const ctxKeep = makeContext({ onLog: () => 'x' });
  check('调用方给的回调原样保留', ctxKeep.onLog() === 'x');
  check('makeContext() 无参不炸', (() => { const c = makeContext(); return c.itemCount === 0 && typeof c.onLog === 'function'; })());

  // ================= NullSink / LogDecorator =================
  section('辅助层：NullSink 与 LogDecorator');
  const sink = new NullSink();
  check('NullSink.next() 恒 null', (await sink.next({})) === null);
  await sink.push({ id: 'a' }, {});
  await sink.push({ id: 'b' }, {});
  const sinkRes = await sink.close({});
  check('NullSink 收下副本并计数', sink.count === 2 && sinkRes.count === 2, 'count=' + sink.count);

  const logCtx = makeContext({ stageKey: 'collect', onStage: (k, s, d) => { logCtx._stage = [k, s, d]; } });
  const logged = new LogDecorator(new ArraySource(['a', 'b']), { stageKey: 'collect' });
  const logRes = await drive(logged, logCtx);
  check('LogDecorator 透明透传条目', logCtx.itemCount === 2, 'itemCount=' + logCtx.itemCount);
  check('LogDecorator open 时发 collect 阶段', logCtx._stage && logCtx._stage[0] === 'collect' && logCtx._stage[1] === 'running',
    JSON.stringify(logCtx._stage));
  check('LogDecorator 阶段文案含来源数', /共 2 个来源/.test(logCtx._stage[2]), String(logCtx._stage && logCtx._stage[2]));
  check('LogDecorator 累积 ctx.shared.provenance', Array.isArray(logCtx.shared.provenance) && logCtx.shared.provenance.length === 3,
    'len=' + (logCtx.shared.provenance || []).length);
  check('LogDecorator 收尾行含耗时', logCtx.shared.provenance.some((p) => p.layer === 'LogDecorator' && typeof p.ms === 'number'));
  check('LogDecorator stats 含 elapsedMs', typeof logRes.stats.elapsedMs === 'number', JSON.stringify(logRes.stats));

  // 每条 item 的 meta.provenance 也被追加
  const pvCtx = makeContext({});
  const pvItems = [];
  await drive(new LogDecorator(new ArraySource(['a'])), Object.assign(pvCtx, { onItem: (it) => pvItems.push(it) }));
  check('LogDecorator 给每条 item 追加 provenance', pvItems[0].meta.provenance.some((p) => p.layer === 'LogDecorator'),
    JSON.stringify(pvItems[0].meta.provenance));

  // errors → warnings 上报
  const errCtx = makeContext({});
  const errRes = await drive(new LogDecorator(new ArraySource([{ label: 'bad', text: 'x' }], { failOn: ['bad'] })), errCtx);
  check('LogDecorator 把 ctx.errors 转成 warnings', errRes.warnings.length === 1 && /bad/.test(errRes.warnings[0]),
    JSON.stringify(errRes.warnings));

  // >100 次 LLM 调用提示（§13 红线：只提示不阻断）
  const hintCtx = makeContext({ stats: { llmCalls: LLM_CALL_HINT_AT + 1 } });
  const hintLogs = [];
  hintCtx.onLog = (l) => hintLogs.push(l);
  const hinted = new LogDecorator(new ArraySource(['a', 'b']));
  const hintRes = await drive(hinted, hintCtx);
  check('LLM 调用超阈值时给出提示', hintLogs.some((l) => /本次抽取调用较多/.test(l)), JSON.stringify(hintLogs));
  check('提示只发一次（不逐条刷屏）', hintLogs.filter((l) => /本次抽取调用较多/.test(l)).length === 1);
  check('提示不阻断作业（ok 仍为 true）', hintRes.ok === true && hintCtx.itemCount === 2);
  check('提示同时进 warnings', hintRes.warnings.some((w) => /本次抽取调用较多/.test(w)), JSON.stringify(hintRes.warnings));
  const noHintCtx = makeContext({ stats: { llmCalls: 5 } });
  const noHintLogs = [];
  noHintCtx.onLog = (l) => noHintLogs.push(l);
  await drive(new LogDecorator(new ArraySource(['a'])), noHintCtx);
  check('未超阈值时不提示', !noHintLogs.some((l) => /本次抽取调用较多/.test(l)));

  // ================= frontmatter 往返（§6.2） =================
  section('frontmatter 序列化 / 解析往返（§6.2）');
  const fm = {
    corpusId: 'abc123def4567890',
    version: 1,
    generatedAt: 1757800000000,
    generator: 'Synapse-Corpus/1.0',
    source: { type: 'local', path: 'local:D:/docs/a.pdf', name: 'a.pdf', ext: '.pdf', size: 1048576, mtime: 1757800000000 },
    parse: { method: 'skill', skill: { name: 'extract-markdown', mode: 'llm', version: '1.0.0' }, fallbacks: [], truncated: false, chars: 12345 },
    domain: { id: 'charge-pile', label: '充电桩扩容', confidence: 0.95 },
    profileId: 'iso15926',
    graph: { extractedAt: 1757800001000, jobId: 'job-1', nodes: 37, edges: 51 },
    provenance: [
      { layer: 'RawFileSource', ms: 12 },
      { layer: 'SkillMarkdownDecorator', ms: 8421, skill: 'extract-markdown@1.0.0' },
      { layer: 'GraphMergeDecorator', ms: 88, nodes: 37, edges: 51 },
    ],
  };
  const rendered = item.renderCorpusFile(fm, '# 供电容量说明\n\n正文内容。\n');
  check('renderCorpusFile 以 --- 围栏开头', rendered.startsWith('---\n'), rendered.slice(0, 20));
  check('renderCorpusFile 含正文', rendered.includes('# 供电容量说明') && rendered.includes('正文内容。'));
  const parsed = item.parseFrontmatter(rendered);
  check('解析回 frontmatter 与 body', typeof parsed.frontmatter === 'object' && parsed.body.includes('正文内容'));
  check('标量往返：corpusId', parsed.frontmatter.corpusId === 'abc123def4567890', String(parsed.frontmatter.corpusId));
  check('标量往返：version 为数字', parsed.frontmatter.version === 1, String(parsed.frontmatter.version));
  check('标量往返：generator 含斜杠不加引号也可解析', parsed.frontmatter.generator === 'Synapse-Corpus/1.0',
    String(parsed.frontmatter.generator));
  check('一层对象往返：source.name', parsed.frontmatter.source && parsed.frontmatter.source.name === 'a.pdf',
    JSON.stringify(parsed.frontmatter.source));
  check('一层对象往返：source.size 为数字', parsed.frontmatter.source.size === 1048576);
  check('二层对象往返：parse.skill.name', parsed.frontmatter.parse && parsed.frontmatter.parse.skill
    && parsed.frontmatter.parse.skill.name === 'extract-markdown', JSON.stringify(parsed.frontmatter.parse));
  check('布尔往返：parse.truncated === false', parsed.frontmatter.parse.truncated === false,
    String(parsed.frontmatter.parse.truncated));
  check('空数组往返：parse.fallbacks', Array.isArray(parsed.frontmatter.parse.fallbacks)
    && parsed.frontmatter.parse.fallbacks.length === 0, JSON.stringify(parsed.frontmatter.parse.fallbacks));
  check('对象列表往返：provenance 3 条', Array.isArray(parsed.frontmatter.provenance)
    && parsed.frontmatter.provenance.length === 3, JSON.stringify(parsed.frontmatter.provenance));
  check('对象列表往返：provenance[1].skill', parsed.frontmatter.provenance[1]
    && parsed.frontmatter.provenance[1].skill === 'extract-markdown@1.0.0', JSON.stringify(parsed.frontmatter.provenance[1]));
  check('对象列表往返：provenance[2].nodes 为数字', parsed.frontmatter.provenance[2].nodes === 37);
  check('domain.confidence 浮点往返', Math.abs(parsed.frontmatter.domain.confidence - 0.95) < 1e-9,
    String(parsed.frontmatter.domain.confidence));

  // 特殊字符
  const fm2 = { title: '含: 冒号, 逗号 # 井号', quote: '他说"你好"', empty: '', nl: '第一行\n第二行' };
  const p2 = item.parseFrontmatter(item.renderCorpusFile(fm2, 'body'));
  check('含冒号/逗号/井号的值加引号后可往返', p2.frontmatter.title === fm2.title, JSON.stringify(p2.frontmatter.title));
  check('含双引号的值可往返', p2.frontmatter.quote === fm2.quote, JSON.stringify(p2.frontmatter.quote));
  check('空字符串可往返', p2.frontmatter.empty === '', JSON.stringify(p2.frontmatter.empty));
  check('换行值转义后可往返', p2.frontmatter.nl === fm2.nl, JSON.stringify(p2.frontmatter.nl));

  // 无围栏 / 损坏
  const noFm = item.parseFrontmatter('# 只有正文\n没有围栏');
  check('无围栏时 frontmatter 为空对象、body 为全文',
    Object.keys(noFm.frontmatter).length === 0 && noFm.body.startsWith('# 只有正文'));
  const broken = item.parseFrontmatter('---\n这不是: [合法 yaml\n  缩进也乱: {\n---\n正文');
  check('损坏 frontmatter 不抛异常', typeof broken === 'object' && typeof broken.body === 'string');

  // ================= originOf / 各 origin 构造器 =================
  section('origin 构造器（§12.1 七字段契约）');
  const oRaw = item.originOf({ path: 'local:D:/docs/a.pdf', name: 'a.pdf', ext: 'pdf', size: 1024, mtime: 1757800000123.7, root: 'D:/docs', rel: 'a.pdf' });
  check('originOf(local:) → type=local', oRaw.type === 'local', oRaw.type);
  check('originOf 补点并小写扩展名', oRaw.ext === '.pdf', oRaw.ext);
  check('originOf mtime 取整', oRaw.mtime === 1757800000124, String(oRaw.mtime));
  check('originOf rel 反斜杠归一', item.originOf({ path: 'raw/a\\b.pdf', name: 'b.pdf', rel: 'a\\b.pdf' }).rel === 'a/b.pdf');
  check('originOf 字段不超出 7 个契约键', Object.keys(oRaw).every((k) => item.ORIGIN_KEYS.includes(k)), Object.keys(oRaw).join(','));
  check('ORIGIN_KEYS 恰好 7 个', item.ORIGIN_KEYS.length === 7, item.ORIGIN_KEYS.join(','));
  const oUrl = item.originOf({ path: 'url:https://x.com/a', name: 'a', ext: 'html' });
  check('originOf(url:) → type=url 且无 rel', oUrl.type === 'url' && oUrl.rel === undefined, JSON.stringify(oUrl));
  const oNote = item.noteOrigin({ id: 'n1', title: '笔记一', content: 'abc', updatedAt: 555 });
  check('noteOrigin → type=note、path=note:id', oNote.type === 'note' && oNote.path === 'note:n1', JSON.stringify(oNote));
  check('noteOrigin size = 正文字节数', oNote.size === 3, String(oNote.size));
  check('noteOrigin mtime = updatedAt', oNote.mtime === 555);
  const oInline = item.inlineOrigin('内联一段', 'hello');
  check('inlineOrigin → type=inline', oInline.type === 'inline' && oInline.path === 'inline:内联一段', JSON.stringify(oInline));
  const oCorpus = item.corpusOrigin('充电桩扩容/供电容量说明.md', 'body', { source: { path: 'local:D:/a.pdf', name: 'a.pdf', ext: '.pdf', size: 99, mtime: 1757800000000 } });
  check('corpusOrigin 优先取 frontmatter.source', oCorpus.path === 'local:D:/a.pdf' && oCorpus.size === 99, JSON.stringify(oCorpus));
  check('corpusOrigin rel = 语料文件相对路径', oCorpus.rel === '充电桩扩容/供电容量说明.md', oCorpus.rel);
  const oCorpus2 = item.corpusOrigin('general/x.md', 'body', {});
  check('corpusOrigin 无 source 时回退到语料文件自身', oCorpus2.name === 'x.md' && oCorpus2.size === 4, JSON.stringify(oCorpus2));

  // ================= InlineSource =================
  section('InlineSource（graph.js:274-278 分支）');
  const inl = new InlineSource([{ label: '段落A', text: 'aaa' }, { label: '', text: '   ' }, { label: '段落B', text: 'bbb', domain: 'd1' }]);
  const inlCtx = makeContext({});
  const inlItems = [];
  await drive(inl, Object.assign(inlCtx, { onItem: (it) => inlItems.push(it) }));
  check('空白内联被过滤', inlItems.length === 2, 'len=' + inlItems.length);
  check('内联 kind=inline、label 原样', inlItems[0].kind === 'inline' && inlItems[0].label === '段落A');
  check('内联带 text', inlItems[0].text === 'aaa');
  check('内联 domain 进 meta.domain', inlItems[1].meta.domain && inlItems[1].meta.domain.id === 'd1', JSON.stringify(inlItems[1].meta.domain));
  check('InlineSource caps.text 为真、bytes 为假', inl.caps.text === true && inl.caps.bytes === false);

  // ================= RawFileSource 真实读盘 =================
  section('RawFileSource：真实读盘 + 缺失文件跳过（P10）');
  const wiki = path.join(env.dir, 'wiki');
  const rawDir = path.join(wiki, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  writeFile(path.join(rawDir, 'a.md'), '# A\n\n内容A\n');
  writeFile(path.join(rawDir, 'b.txt'), '纯文本B');
  const settings = { wikiRoot: wiki };

  const recs = resolveRecords(settings, ['raw/a.md', 'raw/b.txt', 'raw/missing.md']);
  check('resolveRecords 保留用户选中的顺序', recs.length === 3 && recs[0].name === 'a.md' && recs[1].name === 'b.txt',
    JSON.stringify(recs.map((r) => r.name)));
  check('resolveRecords 命中 listRaws 的记录带 size/mtime', recs[0].size > 0 && recs[0].mtime > 0,
    `size=${recs[0].size} mtime=${recs[0].mtime}`);
  check('resolveRecords 对不存在的路径兜底构造记录（不抛）', recs[2] && recs[2].name === 'missing.md' && recs[2].size === 0,
    JSON.stringify(recs[2] && { name: recs[2].name, size: recs[2].size }));
  check('absOf(raw/…) 解析到 rawsRoot 下', absOf(recs[0], settings) === path.join(rawDir, 'a.md'), absOf(recs[0], settings));
  check('absOf(local:) 直接取绝对路径', absOf({ path: 'local:D:/x/y.pdf' }, settings) === 'D:/x/y.pdf');

  const rfs = new RawFileSource(['raw/a.md', 'raw/b.txt', 'raw/missing.md'], {});
  check('RawFileSource caps：bytes+countable，无 text', rfs.caps.bytes === true && rfs.caps.text === false
    && rfs.caps.countable === true && rfs.caps.replayable === true, JSON.stringify(rfs.caps));
  const rawCtx = makeContext({ settings });
  const rawItems = [];
  const rawRes = await drive(rfs, Object.assign(rawCtx, { onItem: (it) => rawItems.push(it) }));
  check('存在的 2 个文件产出 2 条', rawItems.length === 2, 'len=' + rawItems.length);
  check('缺失文件记入 ctx.errors 且不断流（P10）', rawCtx.errors.length === 1 && /missing\.md/.test(rawCtx.errors[0].label),
    JSON.stringify(rawCtx.errors));
  check('条目 kind=raw、label 前缀「原始·」', rawItems[0].kind === 'raw' && rawItems[0].label === '原始·a.md', rawItems[0].label);
  check('条目带 bytes（Buffer）', Buffer.isBuffer(rawItems[0].bytes) && rawItems[0].bytes.toString('utf8').includes('内容A'));
  check('条目 origin.type=local 且含 rel（相对 rawsRoot）', rawItems[0].origin.type === 'local'
    && rawItems[0].origin.rel === 'raw/a.md', JSON.stringify(rawItems[0].origin));
  check('条目 origin.path 可被 absOf 还原为绝对路径', absOf({ path: rawItems[0].origin.path }, settings) === path.join(rawDir, 'a.md'),
    absOf({ path: rawItems[0].origin.path }, settings));
  check('条目 origin.ext 带点', rawItems[0].origin.ext === '.md', rawItems[0].origin.ext);
  check('drive 未因缺失文件抛错', rawRes.ok === true);
  check('RawFileSource estimate 给出 total 与 labels', rfs.estimate().total === 3
    && rfs.estimate().labels.join(',') === 'a.md,b.txt,missing.md', JSON.stringify(rfs.estimate()));

  // 可重放：replayable=true → 再 open 一次能重头产出
  const rawCtx2 = makeContext({ settings });
  const rawItems2 = [];
  await drive(rfs, Object.assign(rawCtx2, { onItem: (it) => rawItems2.push(it) }));
  check('RawFileSource 可重放（replayable）', rawItems2.length === 2 && rawItems2[0].id === rawItems[0].id,
    `${rawItems2.length} / ${rawItems2[0] && rawItems2[0].id} vs ${rawItems[0].id}`);

  // 全部缺失：产出 0 条但不抛
  const allMissing = new RawFileSource(['raw/nope1.md', 'raw/nope2.md'], {});
  const amCtx = makeContext({ settings });
  const amRes = await drive(allMissing, amCtx);
  check('全部来源缺失时产出 0 条、errors 2 条、不抛', amCtx.itemCount === 0 && amCtx.errors.length === 2 && amRes.ok === true,
    `count=${amCtx.itemCount} errors=${amCtx.errors.length}`);

  // 空入参
  const emptySrc = new RawFileSource([], {});
  const eCtx = makeContext({ settings });
  await drive(emptySrc, eCtx);
  check('空 rawPaths 时产出 0 条不抛', eCtx.itemCount === 0);
  check('空 rawPaths 时 estimate.total = 0', emptySrc.estimate().total === 0);

  // 目录整体注入（opts.records）
  const preRecs = resolveRecords(settings, ['raw/a.md']);
  const preSrc = new RawFileSource([], { records: preRecs });
  const preCtx = makeContext({ settings });
  await drive(preSrc, preCtx);
  check('opts.records 可绕过 resolveRecords', preCtx.itemCount === 1, 'count=' + preCtx.itemCount);

  // ================= 汇总 =================
  const ok = summary();
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('测试异常退出：', e && e.stack || e);
  process.exit(1);
});
