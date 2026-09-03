// LLM 请求层：OpenAI 兼容接口，流式 SSE 解析与重试策略
// 说明：该部署环境的网关对长时间无响应头的非流式请求会触发 undici headers timeout，
// 因此 chatOnce 也统一以 stream:true 发起并累积全文。
const { num } = require('../common/config');
// 默认模型 / API 基础 URL 统一引用单一配置源（defaults.js）
const { DEFAULTS, normalizeModel } = require('./defaults');

// 本地/慢推理模型（如 qwen3.8:27b 并发抽取）首字节可能远超 undici 默认 headersTimeout(≈300s)，
// 触发 UND_ERR_HEADERS_TIMEOUT 致作业整体失败。用自定义 Agent 放大响应头/正文超时（默认一天，可在设置→作业→模型请求超时调整）。
const DAY_MS = 24 * 60 * 60 * 1000;
let undici = null;
try { undici = require('undici'); } catch (_) { /* undici 不可用时沿用内置 fetch 默认 */ }
const agentCache = {}; // ms → Agent，按超时值缓存复用连接池
function llmDispatcher(settings) {
  if (!undici) return undefined;
  let ms = DAY_MS;
  try {
    const v = Number((settings || {}).llmRequestTimeout);
    if (Number.isFinite(v) && v >= 60 && v <= 86400) ms = v * 1000;
  } catch (_) {}
  if (!agentCache[ms]) agentCache[ms] = new undici.Agent({ headersTimeout: ms, bodyTimeout: ms, connectTimeout: 60000 });
  return agentCache[ms];
}

// 可选模型参数：仅当设置中填写时才透传（留空走接口默认值），供设置页调参
function withModelParams(body, settings) {
  const s = settings || {};
  if (s.temperature !== undefined && s.temperature !== null && String(s.temperature).trim() !== '') {
    const t = Number(s.temperature);
    if (Number.isFinite(t)) body.temperature = Math.min(2, Math.max(0, t));
  }
  if (s.topP !== undefined && s.topP !== null && String(s.topP).trim() !== '') {
    const t = Number(s.topP);
    if (Number.isFinite(t)) body.top_p = Math.min(1, Math.max(0, t));
  }
  const mt = Number(s.maxTokens);
  if (Number.isFinite(mt) && mt > 0) body.max_tokens = Math.round(mt);
  return body;
}

// 推理增量开关：各服务商默认行为不一（Ollama 需 think:true，DashScope/百炼 Qwen3.8 需 enable_thinking:true），
// 未显式配置时按 provider 自动开启，使判定类请求（领域匹配/体系匹配等）也能把思考过程实时推给进度弹窗。
function withThinking(body, settings) {
  if (body.think !== undefined || body.enable_thinking !== undefined) return body; // 调用方已显式指定（含 false）
  const s = settings || {};
  const provider = String(s.apiProvider || '');
  console.log('[withThinking] provider=', provider, 'model=', s.model);
  if (provider === 'ollama') {
    body.think = true;
    console.log('[withThinking] set think=true');
  } else if (provider === 'dashscope' || provider === 'aliyun' || provider === 'bailian') {
    body.enable_thinking = true;
    console.log('[withThinking] set enable_thinking=true');
  } else {
    console.log('[withThinking] no thinking param set for provider');
  }
  return body;
}

// 可重试错误：网络异常、5xx、空返回等瞬时故障（4xx 客户端错误不重试）
class RetriableError extends Error {}

// 交互问答停止控制：仅 streamChat/agenticChat 受停止影响，作业编排用的 chatOnce 不受影响；
// 同一时刻只有一个交互请求，新请求开始时重置控制器即可覆盖旧请求的残留停止
let aiAbort = null;
// 流令牌：全局广播事件（ai:chunk/ai:done 等）不区分请求，旧流若未被终止会继续向新问答灌事件。
// 每次开启新流时递增令牌并静默 abort 旧流；旧流发事件前校验令牌，被顶替后不再发声。
let streamSeq = 0;
let streamToken = null;
function beginStream() {
  if (aiAbort && !aiAbort.signal.aborted) { try { aiAbort.abort(); } catch (_) {} }
  const ctrl = new AbortController();
  aiAbort = ctrl;
  const token = ++streamSeq;
  streamToken = token;
  return { ctrl, token };
}
function stopAi() {
  if (aiAbort) aiAbort.abort();
}
// 交互流程在开始时注册自己的控制器，使 stopAi 能中断前置阶段的 fetch
function setAbortController(ctrl) { aiAbort = ctrl; }
const abortErr = () => Object.assign(new Error('已停止回答。'), { name: 'AbortError' });
const isAbortErr = (err) => !!(err && (err.name === 'AbortError' || (err.cause && err.cause.name === 'AbortError')));

// 推理增量字段各家命名不一：DashScope/百炼=reasoning_content，Ollama=reasoning，部分=thinking。
// 只认其中一种会导致其他服务商的思考内容被静默丢弃（界面长时间只显示“思考中”）
const reasoningOf = (d) => (d && (d.reasoning_content || d.reasoning || d.thinking)) || '';

// SSE 流解析：逐行解析 data: 增量，回调 delta（供流式展示与全文累积共用）
// 回调签名 (delta, isReasoning)：推理模型的 thinking 增量也会回调，isReasoning=true
async function consumeSseStream(resp, onDelta) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  // 读流停滞保护：本地慢模型排队时 read() 可能长时间不返回，但若连接被静默关闭，
  // read() 既不 done 也不抛错会永远挂起（曾致单任务 stuck「进行中」拖死作业）。
  // 单次 read 最长等待 60 分钟无数据视为连接已死（本地 27B 排队也很少超过 60 分钟无响应），
  // 超时主动判失败抛错，交给上层重试/标记失败。若仍有疑虑可把超时调更大（上限由设置项 llmRequestTimeout 控制）。
  const stallMs = 60 * 60 * 1000; // 60 分钟
  while (true) {
    let readResult;
    let stallTimer;
    try {
      readResult = await Promise.race([
        reader.read(),
        new Promise((_, rej) => { stallTimer = setTimeout(() => rej(new Error('流式响应停滞超时（60 分钟无数据，连接可能已被对端关闭）')), stallMs); }),
      ]);
    } catch (e) {
      try { reader.cancel(); } catch (_) {}
      throw e;
    } finally {
      clearTimeout(stallTimer);
    }
    const { done, value } = readResult;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // 保留未完整的一行
    for (const line of lines) {
      emitDataLine(line.trim(), onDelta);
    }
  }
  emitDataLine(buffer.trim(), onDelta);
}

// Qwen3 风格 <think>...</think> 包裹：部分 Ollama/第三方兼容接口不开 think 开关时，
// 会把推理内容直接嵌在 content 增量里。解析时把包裹内的文本也按 reasoning 上报，
// 否则这些接口下判定弹窗始终不打印思考过程。
const THINK_RE = /<think>([\s\S]*?)<\/think>/g;
function splitThinkWrapped(content) {
  if (!content || !content.includes('<think>')) return { think: '', text: content || '' };
  let think = '';
  const text = String(content).replace(THINK_RE, (_, inner) => { think += inner; return ''; });
  return { think, text };
}

function emitDataLine(trimmed, onDelta) {
  if (!trimmed.startsWith('data:')) return;
  const data = trimmed.slice(5).trim();
  if (!data || data === '[DONE]') return;
  try {
    const parsed = JSON.parse(data);
    const delta = parsed.choices?.[0]?.delta;
    const think = reasoningOf(delta);
    if (think) {
      console.log('[emitDataLine] reasoning:', think.slice(0, 50));
      onDelta(think, true);
    }
    if (delta?.content) {
      const { think: wrappedThink, text } = splitThinkWrapped(delta.content);
      if (wrappedThink) {
        console.log('[emitDataLine] wrapped think:', wrappedThink.slice(0, 50));
        onDelta(wrappedThink, true);
      }
      if (text) onDelta(text, false);
    }
  } catch (e) {
    console.log('[emitDataLine] parse error:', e.message, 'line:', trimmed.slice(0, 100));
  }
}

// 流式对话：增量经 ai:chunk 推送给渲染进程，错误经 ai:error 上报
// 本地部署（Ollama 等回环地址）无需 API Key，仅对远端接口强制要求；
// 否则选用本地模型时会被“尚未配置 API Key”直接拦下
function requiresApiKey(settings) {
  if (String((settings && settings.apiProvider) || '') === 'ollama') return false;
  const url = String((settings && settings.apiBaseUrl) || DEFAULTS.apiBaseUrl);
  return !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url);
}

async function streamChat(event, settings, messages) {
  const baseUrl = (settings.apiBaseUrl || DEFAULTS.apiBaseUrl).replace(/\/$/, '');
  const apiKey = settings.apiKey || '';
  const model = normalizeModel(settings.model);

  if (!apiKey && requiresApiKey(settings)) {
    event.sender.send('ai:error', '尚未配置 API Key，请先点击右上角设置按钮填写。');
    return;
  }

  let resp;
  // 开启新流：顶替（静默 abort）尚未结束的旧流，避免旧流事件串进本次回答
  const { ctrl, token } = beginStream();
  const isMine = () => streamToken === token;
  const send = (ch, d) => { if (isMine()) event.sender.send(ch, d); };
  const signal = ctrl.signal;
  try {
    resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(withModelParams({ model, messages, stream: true }, settings)),
      signal,
      dispatcher: llmDispatcher(settings),
    });
  } catch (err) {
    if (signal.aborted) { if (isMine()) event.sender.send('ai:error', '已停止回答。'); return; }
    send('ai:error', `网络请求失败：${err.message}${err.cause ? `（${err.cause.code || err.cause.message}）` : ''}`);
    return;
  }

  if (!resp.ok) {
    const detail = (await resp.text().catch(() => '')).slice(0, 300);
    send('ai:error', `接口返回错误 (${resp.status})：${detail}`);
    return;
  }

  try {
    // 聊天界面只推正文增量，thinking 不混入回答；
    // 推理增量以 ai:step(thinking) 下发，无工具路径（streamChat）也能实时展示思考过程
    await consumeSseStream(resp, (delta, isReasoning) => {
      if (isReasoning) send('ai:step', { kind: 'thinking', text: delta });
      else send('ai:chunk', delta);
    });
    send('ai:done');
  } catch (err) {
    if (signal.aborted || isAbortErr(err)) { if (isMine()) event.sender.send('ai:error', '已停止回答。'); return; }
    send('ai:error', `读取响应流失败：${err.message}`);
  } finally {
    if (aiAbort && aiAbort.signal === signal) aiAbort = null;
    if (streamToken === token) streamToken = null;
  }
}

// 非流式对话（用于编排步骤）：内部流式接收并累积全文返回
// 重试次数默认读 settings.chatRetries（设置弹窗可配），递归重试时显式传入剩余次数
// onDelta 可选：流式增量回调，供作业系统上报执行细节
async function chatOnce(settings, messages, retries, onDelta, signal) {
  const left = retries !== undefined ? retries : num(settings, 'chatRetries', 2, 0, 5);
  const baseUrl = (settings.apiBaseUrl || DEFAULTS.apiBaseUrl).replace(/\/$/, '');
  if (!settings.apiKey && requiresApiKey(settings)) throw new Error('尚未配置 API Key，请先在设置中填写。');
  if (signal && signal.aborted) throw abortErr();
  try {
    let resp;
    try {
      resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
        body: JSON.stringify(withThinking(withModelParams({ model: normalizeModel(settings.model), messages, stream: true }, settings), settings)),
        dispatcher: llmDispatcher(settings),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      // 停止导致的 abort 不重试，直接抛出
      if (signal && signal.aborted) throw abortErr();
      // 网络层失败（DNS/连接/超时）视为可重试，并带上根因便于诊断
      throw new RetriableError(`网络请求失败：${err.message}${err.cause ? `（${err.cause.code || err.cause.message}）` : ''}`);
    }
    if (!resp.ok) {
      const detail = (await resp.text().catch(() => '')).slice(0, 300);
      if (resp.status >= 400 && resp.status < 500) {
        // 客户端错误（鉴权/参数等）重试无意义，直接抛出
        throw new Error(`接口错误 (${resp.status})：${detail}`);
      }
      throw new RetriableError(`接口错误 (${resp.status})：${detail}`);
    }
    let text = '';
    let chunkCount = 0;
    // text 只累积正文（thinking 不进最终结果），onDelta 透传两类增量供进度展示
    await consumeSseStream(resp, (delta, isReasoning) => { 
      chunkCount++;
      if (chunkCount <= 3 || chunkCount % 50 === 0) console.log('[chatOnce] chunk', chunkCount, 'isReasoning=', isReasoning, 'len=', delta.length);
      if (!isReasoning) text += delta; 
      if (onDelta) onDelta(delta, isReasoning); 
    });
    console.log('[chatOnce] total chunks:', chunkCount, 'text len:', text.length);
    if (!text) throw new RetriableError('模型返回为空');
    return text;
  } catch (err) {
    // 仅可重试错误（网络/5xx/空返回）才重试，4xx 客户端错误直接抛出
    if (left > 0 && err instanceof RetriableError) {
      return chatOnce(settings, messages, left - 1, onDelta, signal); // 透传 signal，重试轮仍可被停止/超时中断
    }
    throw err;
  }
}

// 解析一轮流式响应：累积正文与 tool_calls（供 agenticChat 工具循环）
// onDelta(delta, isReasoning) 可选：推理模型的 thinking 与正文增量实时回调
// onToolCallStart 可选：首次出现 tool_calls 时触发，用于区分“工具轮前言”与“最终回答”
async function consumeToolStream(resp, onDelta, onToolCallStart) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '';
  let content = '';
  const tc = {};
  const handle = (line) => {
    if (!line.startsWith('data:')) return;
    const d = line.slice(5).trim();
    if (!d || d === '[DONE]') return;
    try {
      const delta = JSON.parse(d).choices?.[0]?.delta;
      if (delta?.content) { content += delta.content; if (onDelta) onDelta(delta.content, false); }
      const think = reasoningOf(delta);
      if (think && onDelta) onDelta(think, true);
      if (delta?.tool_calls) {
        if (onToolCallStart) onToolCallStart();
        for (const c of delta.tool_calls) {
          const i = c.index ?? 0;
          tc[i] = tc[i] || { id: '', name: '', arguments: '' };
          if (c.id) tc[i].id = c.id;
          if (c.function?.name) tc[i].name += c.function.name;
          if (c.function?.arguments) tc[i].arguments += c.function.arguments;
        }
      }
    } catch (_) {}
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    lines.forEach((l) => handle(l.trim()));
  }
  handle(buf.trim());
  return { content, toolCalls: Object.values(tc).filter((x) => x.name) };
}

// 从工具返回中提取参考链接（搜索类工具的 pages/results/…）。
// 必须在主进程对完整返回做：下发给渲染层的 text 会被截断，JSON 已不可解析
function extractToolLinks(result) {
  const out = [];
  let j = null;
  try { j = JSON.parse(String(result || '')); } catch (_) { return out; }
  if (!j || typeof j !== 'object') return out;
  const seen = new Set();
  for (const key of ['pages', 'results', 'items', 'data', 'organic', 'webPages', 'documents']) {
    const arr = j[key];
    if (!Array.isArray(arr)) continue;
    for (const it of arr) {
      const url = it && (it.url || it.link || it.href);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const snip = it.snippet || it.description || it.summary || it.abstract || '';
      out.push({ url: String(url), title: String(it.title || it.name || url), snippet: String(snip).slice(0, 160) });
    }
  }
  return out;
}

// 智能体对话：支持 LLM 动态选择并执行 MCP 工具（tool_calls 循环），无工具时退化为普通流式
async function agenticChat(event, settings, messages, tools, toolRouter) {
  const baseUrl = (settings.apiBaseUrl || DEFAULTS.apiBaseUrl).replace(/\/$/, '');
  if (!settings.apiKey && requiresApiKey(settings)) { event.sender.send('ai:error', '尚未配置 API Key，请先在设置中填写。'); return; }
  const openaiTools = tools && tools.length ? tools.map((t) => ({ type: 'function', function: t.function })) : undefined;
  const msgs = messages.slice();
  // 最近一条用户消息：工具轮后续请求尾部是 assistant(tool_calls)/tool，
  // 部分网关（如某些 Ollama/本地模型）要求生成前紧邻存在 user 消息，否则报 no user query found；
  // 每轮工具结果后追加一条 user 提醒（重述原问题）兜底，并引导模型基于工具结果继续回答
  let lastUserContent = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { lastUserContent = String(messages[i].content || ''); break; }
  }
  const toolMap = new Map((tools || []).map((t) => [t.function.name, t]));
  // 工具循环轮数（settings.maxToolRounds 可配）：多步任务（先搜索再查地图再汇总）需要多于 4 轮
  const maxRounds = num(settings, 'maxToolRounds', 6, 1, 12);
  // “只说不做”补偿标记：小模型常口头说“让我搜索”却不发 tool_calls，检测到后催一次，最多一次避免乒乓循环
  let nudged = false;
  // 停止控制：用户点“停止”时 abort 当前请求并在下一轮循环/工具间隙退出，避免继续白跑工具轮
  const { ctrl, token } = beginStream();
  const isMine = () => streamToken === token;
  const send = (ch, d) => { if (isMine()) event.sender.send(ch, d); };
  const signal = ctrl.signal;
  const stopped = () => { if (isMine()) event.sender.send('ai:error', '已停止回答。'); };
  try {
  for (let round = 0; round < maxRounds; round++) {
    if (signal.aborted) { stopped(); return; }
    let resp;
    try {
      resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
        // 剔除内部标记字段（_toolResume），避免严格网关拒绝未知属性
        body: JSON.stringify(withModelParams({ model: normalizeModel(settings.model), messages: msgs.map((m) => { const { _toolResume, ...rest } = m; return rest; }), stream: true, ...(openaiTools ? { tools: openaiTools } : {}) }, settings)),
        signal,
        dispatcher: llmDispatcher(settings),
      });
    } catch (err) {
      if (signal.aborted || isAbortErr(err)) { stopped(); return; }
      send('ai:error', `网络请求失败：${err.message}`); return;
    }
    if (!resp.ok) { const d = (await resp.text().catch(() => '')).slice(0, 300); send('ai:error', `接口返回错误 (${resp.status})：${d}`); return; }
    // 本轮是否已把正文实时流给渲染层，避免结尾重复下发
    let streamed = false;
    let sawToolCall = false;
    let acc;
    try {
      acc = await consumeToolStream(
        resp,
        (d, isReasoning) => {
          // thinking 增量实时推送，渲染进程折叠展示
          if (isReasoning) { send('ai:step', { kind: 'thinking', text: d }); return; }
          // 正文增量也实时下发：否则长回答期间界面只能干等到整轮结束。
          // 已出现 tool_calls 的轮次不流正文，它属于工具前言，改作步骤展示
          if (sawToolCall) return;
          send('ai:chunk', d);
          streamed = true;
        },
        () => { sawToolCall = true; },
      );
    } catch (err) {
      if (signal.aborted || isAbortErr(err)) { stopped(); return; }
      send('ai:error', `读取响应流失败：${err.message}`); return;
    }
    if (acc.toolCalls.length) {
      // 前言已实时流出时不再重复作为 thought 步骤下发
      if (acc.content && !streamed) send('ai:step', { kind: 'thought', text: acc.content });
      msgs.push({ role: 'assistant', content: acc.content || null, tool_calls: acc.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } })) });
      const toolResults = [];
      for (const t of acc.toolCalls) {
        // 已停止时不再执行后续工具调用，直接退出循环（已执行的结果仍保留在 msgs 中）
        if (signal.aborted) { stopped(); return; }
        send('ai:step', { kind: 'tool', name: t.name, args: t.arguments });
        let result = '';
        const def = toolMap.get(t.name);
        if (def) {
          try { let args = {}; try { args = JSON.parse(t.arguments || '{}'); } catch (_) {} result = await toolRouter(def, args); } catch (e) { result = '工具调用失败：' + e.message; }
        }
        // 推送工具结果摘要（供步骤展示）；links 取自完整返回，供引用区展示
        send('ai:step', {
          kind: 'tool-result',
          name: t.name,
          text: String(result || '').slice(0, 600),
          links: extractToolLinks(result),
        });
        msgs.push({ role: 'tool', tool_call_id: t.id, content: result });
        // 同步收集结果文本：部分网关/本地模型会丢弃 role:'tool' 消息，
        // 需在后续 user 提醒里重述结果，避免模型“看不到工具结果”而反复重调工具直至超限（单项截断防超长）
        toolResults.push(`【${t.name}】${String(result || '').slice(0, 3000)}`);
      }
      // 兜底：重述工具结果 + 用户问题作为紧邻生成位置的 user 消息，兼容要求最近 user 消息的网关；
      // 若工具返回后模型又发起新工具调用，移除上一条提醒避免堆积，只保留最新一条
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user' && msgs[i]._toolResume) { msgs.splice(i, 1); break; }
        if (msgs[i].role !== 'tool' && !(msgs[i].role === 'assistant' && msgs[i].tool_calls)) break;
      }
      let resultsText = toolResults.join('\n\n');
      if (resultsText.length > 12000) resultsText = resultsText.slice(0, 12000) + '\n…（结果过长已截断）';
      msgs.push({ role: 'user', _toolResume: true, content: `以上是刚刚工具调用返回的最新结果。请基于这些结果直接回答，若结果已足够则不要再调用工具。\n\n${resultsText}\n\n请继续回答我最初的问题：${lastUserContent}` });
      continue;
    }
    // “只说不做”检测：正文表达搜索/查询意图却没发 tool_calls（小模型常见）→
    // 把该段正文记入上下文并催一次真实工具调用；正文已实时流出，用户可见，不撤回；
    // 仅在仍有剩余轮次且未曾催过时触发，避免无限循环
    const c = acc.content || '';
    const wantsSearch = /搜索|检索|联网|查找|查询|搜一下|查一下/.test(c) && /让我|我来|尝试|试试|接下来|准备|先去|现在去/.test(c);
    if (!nudged && openaiTools && round < maxRounds - 1 && wantsSearch) {
      nudged = true;
      msgs.push({ role: 'assistant', content: c });
      msgs.push({ role: 'user', content: '注意：你刚才表示要去搜索/查询，但还没有实际调用任何工具。请不要只做口头说明，现在就立即调用合适的工具（如联网搜索）获取信息，再基于工具结果给出最终回答。' });
      continue;
    }
    if (acc.content && !streamed) send('ai:chunk', acc.content);
    send('ai:done');
    return;
  }
  send('ai:error', '工具调用轮数超限，已停止。');
  } finally {
    if (aiAbort === ctrl) aiAbort = null;
    if (streamToken === token) streamToken = null;
  }
}

// 从模型输出中提取 JSON（容忍代码栏包裹与前后杂质）
function extractJson(text) {
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('模型未返回 JSON');
  return JSON.parse(s.slice(start, end + 1));
}

// 澄清问题协议：注入问答系统提示词，让模型对开放式复杂任务先结构化确认再开工
// 渲染进程识别 ```ask 围栏块并渲染为可选卡片（见 chat.js splitAsk/renderAskCard）
const ASK_PROTOCOL = [
  '【澄清问题协议】当且仅当任务明显开放式且复杂（如调研、报告、方案、创作），且缺少关键约束（方向/格式/范围/受众等）时，可先向用户澄清再开工：',
  '输出一个 ```ask 围栏块（整个任务最多问一次、最多 3 个问题、每题 2-5 个选项），格式：',
  '```ask',
  '[{"q":"问题","type":"single 或 multi","options":[{"t":"选项标题","d":"说明（可选）"}]}]',
  '```',
  '围栏外最多一句简短引导语。普通提问、信息已充分、或用户已回答过澄清时，直接作答，不得再问。',
].join('\n');

// 列出接口可用模型：优先 OpenAI 兼容的 GET /models（Ollama / 百炼 等均支持）；
// 失败时对 Ollama 再试一次其原生 /api/tags（未开启兼容层的旧版本）。
async function listModels(settings) {
  const s = settings || {};
  const baseUrl = (s.apiBaseUrl || DEFAULTS.apiBaseUrl).replace(/\/$/, '');
  const headers = {};
  if (s.apiKey) headers.Authorization = `Bearer ${s.apiKey}`;
  const get = async (url) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(url, { headers, signal: ctrl.signal });
      if (!r.ok) {
        const d = (await r.text().catch(() => '')).slice(0, 200);
        throw new Error(`HTTP ${r.status} ${d.trim()}`);
      }
      return await r.json();
    } finally { clearTimeout(timer); }
  };
  // 兼容两种形状：{data:[{id}]}（OpenAI）与 {models:[{name}]}（Ollama 原生）
  const pick = (j) => {
    const arr = Array.isArray(j && j.data) ? j.data : (Array.isArray(j && j.models) ? j.models : []);
    return arr.map((x) => (typeof x === 'string' ? x : (x.id || x.name || ''))).filter(Boolean);
  };
  try {
    return { ok: true, models: pick(await get(`${baseUrl}/models`)) };
  } catch (err) {
    try {
      // 取 origin 拼原生端点（如 http://localhost:11434/v1 → http://localhost:11434/api/tags）
      const origin = new URL(baseUrl).origin;
      return { ok: true, models: pick(await get(`${origin}/api/tags`)) };
    } catch (_) {
      return { ok: false, error: `获取模型列表失败：${err.message}` };
    }
  }
}

module.exports = { RetriableError, consumeSseStream, streamChat, chatOnce, extractJson, agenticChat, listModels, stopAi, setAbortController, ASK_PROTOCOL };
