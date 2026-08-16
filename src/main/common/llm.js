// LLM 请求层：OpenAI 兼容接口，流式 SSE 解析与重试策略
// 说明：该部署环境的网关对长时间无响应头的非流式请求会触发 undici headers timeout，
// 因此 chatOnce 也统一以 stream:true 发起并累积全文。
const { num } = require('./config');

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

// 可重试错误：网络异常、5xx、空返回等瞬时故障（4xx 客户端错误不重试）
class RetriableError extends Error {}

// SSE 流解析：逐行解析 data: 增量，回调 delta（供流式展示与全文累积共用）
// 回调签名 (delta, isReasoning)：推理模型的 reasoning_content（thinking）也会回调，isReasoning=true
async function consumeSseStream(resp, onDelta) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
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

function emitDataLine(trimmed, onDelta) {
  if (!trimmed.startsWith('data:')) return;
  const data = trimmed.slice(5).trim();
  if (!data || data === '[DONE]') return;
  try {
    const delta = JSON.parse(data).choices?.[0]?.delta;
    if (delta?.reasoning_content) onDelta(delta.reasoning_content, true);
    if (delta?.content) onDelta(delta.content, false);
  } catch (_) {
    // 忽略无法解析的行
  }
}

// 流式对话：增量经 ai:chunk 推送给渲染进程，错误经 ai:error 上报
async function streamChat(event, settings, messages) {
  const baseUrl = (settings.apiBaseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
  const apiKey = settings.apiKey || '';
  const model = settings.model || 'qwen3.8-max';

  if (!apiKey) {
    event.sender.send('ai:error', '尚未配置 API Key，请先点击右上角设置按钮填写。');
    return;
  }

  let resp;
  try {
    resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(withModelParams({ model, messages, stream: true }, settings)),
    });
  } catch (err) {
    event.sender.send('ai:error', `网络请求失败：${err.message}${err.cause ? `（${err.cause.code || err.cause.message}）` : ''}`);
    return;
  }

  if (!resp.ok) {
    const detail = (await resp.text().catch(() => '')).slice(0, 300);
    event.sender.send('ai:error', `接口返回错误 (${resp.status})：${detail}`);
    return;
  }

  try {
    // 聊天界面只推正文增量，thinking 不混入回答
    await consumeSseStream(resp, (delta, isReasoning) => { if (!isReasoning) event.sender.send('ai:chunk', delta); });
    event.sender.send('ai:done');
  } catch (err) {
    event.sender.send('ai:error', `读取响应流失败：${err.message}`);
  }
}

// 非流式对话（用于编排步骤）：内部流式接收并累积全文返回
// 重试次数默认读 settings.chatRetries（设置弹窗可配），递归重试时显式传入剩余次数
// onDelta 可选：流式增量回调，供作业系统上报执行细节
async function chatOnce(settings, messages, retries, onDelta) {
  const left = retries !== undefined ? retries : num(settings, 'chatRetries', 2, 0, 5);
  const baseUrl = (settings.apiBaseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
  if (!settings.apiKey) throw new Error('尚未配置 API Key，请先在设置中填写。');
  try {
    let resp;
    try {
      resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
        body: JSON.stringify(withModelParams({ model: settings.model || 'qwen3.8-max', messages, stream: true }, settings)),
      });
    } catch (err) {
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
    // text 只累积正文（thinking 不进最终结果），onDelta 透传两类增量供进度展示
    await consumeSseStream(resp, (delta, isReasoning) => { if (!isReasoning) text += delta; if (onDelta) onDelta(delta, isReasoning); });
    if (!text) throw new RetriableError('模型返回为空');
    return text;
  } catch (err) {
    // 仅可重试错误（网络/5xx/空返回）才重试，4xx 客户端错误直接抛出
    if (left > 0 && err instanceof RetriableError) {
      return chatOnce(settings, messages, left - 1, onDelta);
    }
    throw err;
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

module.exports = { RetriableError, consumeSseStream, streamChat, chatOnce, extractJson };
