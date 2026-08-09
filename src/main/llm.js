// LLM 请求层：OpenAI 兼容接口，流式 SSE 解析与重试策略
// 说明：该部署环境的网关对长时间无响应头的非流式请求会触发 undici headers timeout，
// 因此 chatOnce 也统一以 stream:true 发起并累积全文。
const { num } = require('./config');

// 可重试错误：网络异常、5xx、空返回等瞬时故障（4xx 客户端错误不重试）
class RetriableError extends Error {}

// SSE 流解析：逐行解析 data: 增量，回调 delta（供流式展示与全文累积共用）
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
    const delta = JSON.parse(data).choices?.[0]?.delta?.content;
    if (delta) onDelta(delta);
  } catch (_) {
    // 忽略无法解析的行
  }
}

// 流式对话：增量经 ai:chunk 推送给渲染进程，错误经 ai:error 上报
async function streamChat(event, settings, messages) {
  const baseUrl = (settings.apiBaseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const apiKey = settings.apiKey || '';
  const model = settings.model || 'gpt-4o-mini';

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
      body: JSON.stringify({ model, messages, stream: true }),
    });
  } catch (err) {
    event.sender.send('ai:error', `网络请求失败：${err.message}`);
    return;
  }

  if (!resp.ok) {
    const detail = (await resp.text().catch(() => '')).slice(0, 300);
    event.sender.send('ai:error', `接口返回错误 (${resp.status})：${detail}`);
    return;
  }

  try {
    await consumeSseStream(resp, (delta) => event.sender.send('ai:chunk', delta));
    event.sender.send('ai:done');
  } catch (err) {
    event.sender.send('ai:error', `读取响应流失败：${err.message}`);
  }
}

// 非流式对话（用于编排步骤）：内部流式接收并累积全文返回
// 重试次数默认读 settings.chatRetries（设置弹窗可配），递归重试时显式传入剩余次数
async function chatOnce(settings, messages, retries) {
  const left = retries !== undefined ? retries : num(settings, 'chatRetries', 1, 0, 5);
  const baseUrl = (settings.apiBaseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  if (!settings.apiKey) throw new Error('尚未配置 API Key，请先在设置中填写。');
  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({ model: settings.model || 'gpt-4o-mini', messages, stream: true }),
    });
    if (!resp.ok) {
      const detail = (await resp.text().catch(() => '')).slice(0, 300);
      if (resp.status >= 400 && resp.status < 500) {
        // 客户端错误（鉴权/参数等）重试无意义，直接抛出
        throw new Error(`接口错误 (${resp.status})：${detail}`);
      }
      throw new RetriableError(`接口错误 (${resp.status})：${detail}`);
    }
    let text = '';
    await consumeSseStream(resp, (delta) => { text += delta; });
    if (!text) throw new RetriableError('模型返回为空');
    return text;
  } catch (err) {
    // 仅可重试错误（网络/5xx/空返回）才重试，4xx 客户端错误直接抛出
    if (left > 0 && err instanceof RetriableError) {
      return chatOnce(settings, messages, left - 1);
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
