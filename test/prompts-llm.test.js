// AI 层测试：ai/prompts.js（提示词注册表与体系覆盖链）、ai/llm.js（SSE 解析 / JSON 提取 / 模型列表 / 请求编排）
// 运行：node test/prompts-llm.test.js
const path = require('path');
const { bootEnv, mkCheck, startFakeLlm, sseText, REPO_ROOT } = require('./helpers/harness');

const { check, section, summary } = mkCheck('AI 层（prompts/llm）');

// 构造一个最小可读流响应（consumeSseStream 只用到 resp.body.getReader()）
function fakeResp(pieces) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => (i < pieces.length ? { done: false, value: enc.encode(pieces[i++]) } : { done: true, value: undefined }),
        cancel: async () => {},
      }),
    },
  };
}

(async () => {
  await bootEnv({ prefix: 'synapse-ai-', db: false });

  const prompts = require(path.join(REPO_ROOT, 'src/main/ai/prompts'));
  const llm = require(path.join(REPO_ROOT, 'src/main/ai/llm'));

  // ================= prompts.js =================
  section('ai/prompts.js — PROMPT_DEFS 注册表');
  const keys = prompts.PROMPT_DEFS.map((d) => d.key);
  const expectKeys = ['aiAssistPrompt', 'aiAskPrompt', 'matchPrompt', 'graphExtractPrompt', 'graphEntityPrompt', 'graphAskPrompt', 'tplGenPrompt'];
  check('PROMPT_DEFS 覆盖全部 7 个提示词', JSON.stringify(keys) === JSON.stringify(expectKeys), keys.join(','));
  check('每条定义都有 name/desc/def', prompts.PROMPT_DEFS.every((d) => d.name && d.desc && String(d.def).length > 20));
  check('key 无重复', new Set(keys).size === keys.length);
  check('PROFILE_PROMPTS 覆盖三体系', ['bfo-lite', 'bfo', 'iso15926'].every((p) => prompts.PROFILE_PROMPTS[p] && prompts.PROFILE_PROMPTS[p].graphExtractPrompt && prompts.PROFILE_PROMPTS[p].graphEntityPrompt));
  check('各体系抽取提示词互不相同', new Set(['bfo-lite', 'bfo', 'iso15926'].map((p) => prompts.PROFILE_PROMPTS[p].graphExtractPrompt)).size === 3);

  section('ai/prompts.js — getPrompt 覆盖优先级');
  check('无设置时返回内置默认', prompts.getPrompt({}, 'matchPrompt') === prompts.PROMPT_DEFS.find((d) => d.key === 'matchPrompt').def);
  check('设置覆盖优先于默认', prompts.getPrompt({ matchPrompt: '自定义匹配提示词' }, 'matchPrompt') === '自定义匹配提示词');
  check('覆盖值为空白时回退默认', prompts.getPrompt({ matchPrompt: '   ' }, 'matchPrompt') === prompts.PROMPT_DEFS.find((d) => d.key === 'matchPrompt').def);
  check('覆盖值非字符串时回退默认', prompts.getPrompt({ matchPrompt: 123 }, 'matchPrompt').length > 20);
  check('未知 key 返回空串', prompts.getPrompt({}, 'noSuchKey') === '');
  check('settings 为 null 不抛错', prompts.getPrompt(null, 'aiAskPrompt').length > 20);

  section('ai/prompts.js — getPromptForProfile 四级覆盖链');
  const DEF_EXTRACT = prompts.PROMPT_DEFS.find((d) => d.key === 'graphExtractPrompt').def;
  check('① 无任何覆盖 → 体系默认', prompts.getPromptForProfile({}, 'graphExtractPrompt', 'bfo') === prompts.PROFILE_PROMPTS.bfo.graphExtractPrompt);
  check('① 未知体系 → 通用默认', prompts.getPromptForProfile({}, 'graphExtractPrompt', 'owl:custom') === DEF_EXTRACT);
  check('① 空体系 → 通用默认', prompts.getPromptForProfile({}, 'graphExtractPrompt', '') === DEF_EXTRACT);
  check('② baseKey 覆盖 → 优先于体系默认', prompts.getPromptForProfile({ graphExtractPrompt: 'BASE' }, 'graphExtractPrompt', 'bfo') === 'BASE');
  check('③ baseKey:profileId 覆盖 → 最高优先', prompts.getPromptForProfile({ graphExtractPrompt: 'BASE', 'graphExtractPrompt:bfo': 'SPECIFIC' }, 'graphExtractPrompt', 'bfo') === 'SPECIFIC');
  check('③ 体系专属覆盖不影响其他体系', prompts.getPromptForProfile({ 'graphExtractPrompt:bfo': 'SPECIFIC' }, 'graphExtractPrompt', 'iso15926') === prompts.PROFILE_PROMPTS.iso15926.graphExtractPrompt);
  check('④ 覆盖为空白时继续向下回退', prompts.getPromptForProfile({ 'graphExtractPrompt:bfo': '  ', graphExtractPrompt: '' }, 'graphExtractPrompt', 'bfo') === prompts.PROFILE_PROMPTS.bfo.graphExtractPrompt);
  check('实体提示词同样走体系链', prompts.getPromptForProfile({}, 'graphEntityPrompt', 'iso15926') === prompts.PROFILE_PROMPTS.iso15926.graphEntityPrompt);
  check('非体系类 key 回退通用默认', prompts.getPromptForProfile({}, 'matchPrompt', 'bfo') === prompts.PROMPT_DEFS.find((d) => d.key === 'matchPrompt').def);

  // ================= llm.extractJson =================
  section('ai/llm.js — extractJson');
  check('纯 JSON', llm.extractJson('{"a":1}').a === 1);
  check('```json 围栏', llm.extractJson('```json\n{"a":2}\n```').a === 2);
  check('``` 无语言围栏', llm.extractJson('```\n{"a":3}\n```').a === 3);
  check('前后有说明文字', llm.extractJson('好的，结果如下：\n{"a":4,"b":"x"}\n希望有帮助').b === 'x');
  check('嵌套对象取最外层花括号', llm.extractJson('{"a":{"b":[1,2]}}').a.b[1] === 2);
  check('数组内容可解析', Array.isArray(llm.extractJson('{"list":[{"n":1},{"n":2}]}').list));
  check('首尾空白容忍', llm.extractJson('  \n {"a":5} \n ').a === 5);
  let e1 = '';
  try { llm.extractJson('完全没有 JSON'); } catch (e) { e1 = e.message; }
  check('无 JSON 抛「模型未返回 JSON」', e1 === '模型未返回 JSON', e1);
  let e2 = '';
  try { llm.extractJson('{"broken":'); } catch (e) { e2 = e.message; }
  check('残缺 JSON 抛解析错误', !!e2, e2);
  let e3 = '';
  try { llm.extractJson(''); } catch (e) { e3 = e.message; }
  check('空串抛错', !!e3, e3);
  // 括号配对鲁棒性（思考型模型散文前言/多组花括号）
  check('散文前置带花括号，取首个可解析对象', llm.extractJson('我想到了 {示例} 然后给出结果：{"a":7}').a === 7);
  check('多组花括号跨块不误拼接', llm.extractJson('先看 {"x":1} 再看 {"y":2}').x === 1);
  check('JSON 后散文带花括号不污染', llm.extractJson('{"ok":true} 这就是结果 {完}').ok === true);
  check('嵌套配平 + 尾部散文', llm.extractJson('答案 {"d":{"list":[1,{"k":"v"}]}} 说明文字').d.list[1].k === 'v');
  check('字符串内含花括号不参与配平', llm.extractJson('{"s":"a{b}c"}').s === 'a{b}c');

  // ================= llm.ASK_PROTOCOL =================
  section('ai/llm.js — ASK_PROTOCOL 澄清协议');
  check('包含 ```ask 围栏标记', llm.ASK_PROTOCOL.includes('```ask'));
  check('限定最多 3 个问题', /最多\s*3\s*个问题/.test(llm.ASK_PROTOCOL));
  check('限定每题 2-5 个选项', /2-5\s*个选项/.test(llm.ASK_PROTOCOL));
  check('给出 JSON 结构示例', llm.ASK_PROTOCOL.includes('"options"') && llm.ASK_PROTOCOL.includes('"type"'));
  check('声明普通提问不再追问', /直接作答/.test(llm.ASK_PROTOCOL));

  // ================= llm.consumeSseStream =================
  section('ai/llm.js — consumeSseStream（SSE 解析）');
  {
    const out = [];
    await llm.consumeSseStream(fakeResp(sseText('你好世界', { chunkSize: 2 })), (d, r) => out.push([d, r]));
    check('正文增量按序拼回全文', out.filter((x) => !x[1]).map((x) => x[0]).join('') === '你好世界');
    check('正文增量 isReasoning=false', out.every((x) => x[1] === false));
  }
  {
    const out = [];
    await llm.consumeSseStream(fakeResp(sseText('答案', { reasoning: '思考中…', chunkSize: 3 })), (d, r) => out.push([d, r]));
    check('reasoning_content 增量标记为推理', out.some((x) => x[1] === true));
    check('推理内容拼回完整', out.filter((x) => x[1]).map((x) => x[0]).join('') === '思考中…');
    check('正文与推理分离', out.filter((x) => !x[1]).map((x) => x[0]).join('') === '答案');
    check('推理增量先于正文', out.findIndex((x) => x[1]) < out.findIndex((x) => !x[1]));
  }
  for (const field of ['reasoning', 'thinking']) {
    const out = [];
    await llm.consumeSseStream(fakeResp(sseText('A', { reasoning: 'R', reasoningField: field })), (d, r) => out.push([d, r]));
    check(`兼容推理字段 ${field}`, out.some((x) => x[1] && x[0] === 'R'), JSON.stringify(out));
  }
  {
    // 跨 chunk 断行：一行 data 被切成两半，必须缓冲后完整解析
    const full = `data: ${JSON.stringify({ choices: [{ delta: { content: '跨块内容' } }] })}\n\n`;
    const half = Math.floor(full.length / 2);
    const out = [];
    await llm.consumeSseStream(fakeResp([full.slice(0, half), full.slice(half), 'data: [DONE]\n\n']), (d) => out.push(d));
    check('跨 chunk 断行仍能完整解析', out.join('') === '跨块内容', JSON.stringify(out));
  }
  {
    // 多行挤在同一个 chunk
    const pieces = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'A' } }] })}\n` +
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'B' } }] })}\n\n` +
      'data: [DONE]\n\n',
    ];
    const out = [];
    await llm.consumeSseStream(fakeResp(pieces), (d) => out.push(d));
    check('同 chunk 多行全部解析', out.join('') === 'AB', JSON.stringify(out));
  }
  {
    // <think> 包裹在 content 里（未开 think 开关的兼容接口）
    const pieces = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: '<think>推理A</think>正文B' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const out = [];
    await llm.consumeSseStream(fakeResp(pieces), (d, r) => out.push([d, r]));
    check('<think> 包裹内容按推理上报', out.some((x) => x[1] && x[0] === '推理A'), JSON.stringify(out));
    check('<think> 之外的正文按正文上报', out.some((x) => !x[1] && x[0] === '正文B'), JSON.stringify(out));
  }
  {
    const out = [];
    await llm.consumeSseStream(fakeResp([
      'event: ping\n\n',
      ': 注释行\n',
      `data: ${JSON.stringify({ choices: [{ delta: {} }] })}\n\n`,
      'data: not-json\n\n',
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'OK' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ]), (d) => out.push(d));
    check('忽略非 data 行 / 空 delta / 非法 JSON', out.join('') === 'OK', JSON.stringify(out));
  }
  {
    // 多字节 UTF-8 被切在 chunk 边界
    const enc = new TextEncoder();
    const bytes = enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '中文测试' } }] })}\n\ndata: [DONE]\n\n`);
    const cut = bytes.indexOf(0xE4) + 1; // 切在某个中文字符中间
    let i = 0;
    const chunks = [bytes.slice(0, cut), bytes.slice(cut)];
    const resp = { body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }), cancel: async () => {} }) } };
    const out = [];
    await llm.consumeSseStream(resp, (d) => out.push(d));
    check('多字节字符跨 chunk 不乱码', out.join('') === '中文测试', JSON.stringify(out));
  }

  // ================= llm.chatOnce =================
  section('ai/llm.js — chatOnce（请求编排与重试）');
  {
    const fake = await startFakeLlm(() => ({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, sse: sseText('{"ok":true}') }));
    try {
      const text = await llm.chatOnce(fake.settings(), [{ role: 'user', content: 'hi' }]);
      check('chatOnce 返回累积正文', text === '{"ok":true}', text);
      const body = fake.requests[0].body;
      check('请求走 /chat/completions', fake.requests[0].url === '/v1/chat/completions', fake.requests[0].url);
      check('强制 stream:true', body.stream === true);
      check('模型名归一后透传', body.model === 'test-model');
      check('messages 原样透传', body.messages[0].content === 'hi');
      check('Authorization 头带 Key', fake.requests[0].headers.authorization === 'Bearer test-key');
    } finally { await fake.close(); }
  }
  {
    // 未配 Key 且远端地址 → 直接报错，不发请求
    const fake = await startFakeLlm(() => ({ status: 200, json: {} }));
    try {
      let err = '';
      try { await llm.chatOnce({ apiKey: '', apiBaseUrl: 'https://api.example.com/v1', model: 'm' }, []); } catch (e) { err = e.message; }
      check('远端无 Key 抛「尚未配置 API Key」', /尚未配置 API Key/.test(err), err);
      check('未发出任何请求', fake.requests.length === 0);
    } finally { await fake.close(); }
  }
  {
    // loopback 免 Key
    const fake = await startFakeLlm(() => ({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, sse: sseText('本地回答') }));
    try {
      const text = await llm.chatOnce({ apiKey: '', apiBaseUrl: fake.baseUrl, model: 'm' }, [{ role: 'user', content: 'q' }]);
      check('loopback 无 Key 也可请求', text === '本地回答', text);
    } finally { await fake.close(); }
  }
  {
    // 4xx 不重试
    const fake = await startFakeLlm(() => ({ status: 401, text: '{"error":"invalid key"}' }));
    try {
      let err = null;
      try { await llm.chatOnce(fake.settings({ chatRetries: 3 }), []); } catch (e) { err = e; }
      check('4xx 抛接口错误', err && /接口错误 \(401\)/.test(err.message), err && err.message);
      check('4xx 不重试（仅 1 次请求）', fake.requests.length === 1, String(fake.requests.length));
      check('4xx 错误非 RetriableError', !(err instanceof llm.RetriableError));
    } finally { await fake.close(); }
  }
  {
    // 5xx 重试到耗尽
    const fake = await startFakeLlm(() => ({ status: 503, text: 'busy' }));
    try {
      let err = null;
      try { await llm.chatOnce(fake.settings({ chatRetries: 2 }), []); } catch (e) { err = e; }
      check('5xx 抛 RetriableError', err instanceof llm.RetriableError, err && err.message);
      check('5xx 按 chatRetries 重试（1+2=3 次）', fake.requests.length === 3, String(fake.requests.length));
    } finally { await fake.close(); }
  }
  {
    // 先失败后成功
    const fake = await startFakeLlm(({ n }) => (n < 3 ? { status: 500, text: 'oops' } : { status: 200, headers: { 'Content-Type': 'text/event-stream' }, sse: sseText('第三次成功') }));
    try {
      const text = await llm.chatOnce(fake.settings({ chatRetries: 5 }), []);
      check('瞬时故障后重试成功', text === '第三次成功', text);
      check('共发出 3 次请求', fake.requests.length === 3, String(fake.requests.length));
    } finally { await fake.close(); }
  }
  {
    // 空返回视为可重试
    const fake = await startFakeLlm(() => ({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, sse: ['data: [DONE]\n\n'] }));
    try {
      let err = null;
      try { await llm.chatOnce(fake.settings({ chatRetries: 1 }), []); } catch (e) { err = e; }
      check('模型返回为空视为可重试错误', err instanceof llm.RetriableError && /返回为空/.test(err.message), err && err.message);
      check('空返回重试 1 次（共 2 请求）', fake.requests.length === 2, String(fake.requests.length));
    } finally { await fake.close(); }
  }
  {
    // onDelta 透传两类增量
    const fake = await startFakeLlm(() => ({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, sse: sseText('正文', { reasoning: '推理', chunkSize: 2 }) }));
    try {
      const seen = [];
      const text = await llm.chatOnce(fake.settings(), [], 0, (d, r) => seen.push([d, r]));
      check('chatOnce 返回值不含推理内容', text === '正文', text);
      check('onDelta 收到推理增量', seen.some((x) => x[1] === true));
      check('onDelta 收到正文增量', seen.some((x) => x[1] === false));
    } finally { await fake.close(); }
  }
  {
    // 已 abort 的 signal 立即抛 AbortError
    const ctrl = new AbortController();
    ctrl.abort();
    let err = null;
    try { await llm.chatOnce({ apiKey: 'k', apiBaseUrl: 'http://127.0.0.1:1/v1', model: 'm' }, [], 0, null, ctrl.signal); } catch (e) { err = e; }
    check('已中止的 signal 抛 AbortError', err && err.name === 'AbortError', err && err.message);
  }
  {
    // 模型参数透传与钳制
    const fake = await startFakeLlm(() => ({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, sse: sseText('x') }));
    try {
      await llm.chatOnce(fake.settings({ temperature: 5, topP: -1, maxTokens: 128.6 }), []);
      const b = fake.requests[0].body;
      check('temperature 钳制到 ≤2', b.temperature === 2, String(b.temperature));
      check('topP 钳制到 ≥0', b.top_p === 0, String(b.top_p));
      check('maxTokens 取整', b.max_tokens === 129, String(b.max_tokens));
    } finally { await fake.close(); }
  }
  {
    // 未配置模型参数时不附加任何调参键（走接口默认值）
    const fake = await startFakeLlm(() => ({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, sse: sseText('y') }));
    try {
      await llm.chatOnce(fake.settings(), []);
      const bb = fake.requests[0].body;
      check('未配置时不附加 temperature/top_p/max_tokens', bb.temperature === undefined && bb.top_p === undefined && bb.max_tokens === undefined, JSON.stringify(bb));
      await llm.chatOnce(fake.settings({ temperature: '', topP: null, maxTokens: 0 }), []);
      const b2 = fake.requests[1].body;
      check('空串/null/0 视为未配置', b2.temperature === undefined && b2.top_p === undefined && b2.max_tokens === undefined, JSON.stringify(b2));
    } finally { await fake.close(); }
  }
  {
    // 推理开关按 provider 自动开启；思考预算仅对百炼生效
    const fake = await startFakeLlm(() => ({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, sse: sseText('x') }));
    try {
      await llm.chatOnce(fake.settings({ apiProvider: 'ollama', thinkingBudget: 2000 }), []);
      check('ollama 自动附加 think:true', fake.requests[0].body.think === true);
      check('ollama 不附加 thinking_budget', fake.requests[0].body.thinking_budget === undefined);
      await llm.chatOnce(fake.settings({ apiProvider: 'dashscope', thinkingBudget: 2000 }), []);
      check('dashscope 自动附加 enable_thinking', fake.requests[1].body.enable_thinking === true);
      check('dashscope 附加 thinking_budget', fake.requests[1].body.thinking_budget === 2000, String(fake.requests[1].body.thinking_budget));
      await llm.chatOnce(fake.settings({ apiProvider: 'dashscope', thinkingBudget: 0 }), []);
      check('thinkingBudget=0 不限制', fake.requests[2].body.thinking_budget === undefined);
      await llm.chatOnce(fake.settings({ apiProvider: 'openai' }), []);
      check('其他 provider 不自动开推理', fake.requests[3].body.think === undefined && fake.requests[3].body.enable_thinking === undefined);
    } finally { await fake.close(); }
  }
  {
    // baseUrl 末尾斜杠归一
    const fake = await startFakeLlm(() => ({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, sse: sseText('x') }));
    try {
      await llm.chatOnce(fake.settings({ apiBaseUrl: fake.baseUrl + '/' }), []);
      check('baseUrl 末尾斜杠不产生双斜杠', fake.requests[0].url === '/v1/chat/completions', fake.requests[0].url);
    } finally { await fake.close(); }
  }

  // ================= llm.listModels =================
  section('ai/llm.js — listModels');
  {
    const fake = await startFakeLlm(({ url }) => (url === '/v1/models' ? { status: 200, json: { data: [{ id: 'qwen-max' }, { id: 'qwen-plus' }] } } : { status: 404, text: 'nf' }));
    try {
      const r = await llm.listModels(fake.settings());
      check('OpenAI 形状 {data:[{id}]}', r.ok && JSON.stringify(r.models) === JSON.stringify(['qwen-max', 'qwen-plus']), JSON.stringify(r));
    } finally { await fake.close(); }
  }
  {
    const fake = await startFakeLlm(({ url }) => (url === '/api/tags' ? { status: 200, json: { models: [{ name: 'llama3.1' }, { name: 'qwen2.5' }] } } : { status: 404, text: 'nf' }));
    try {
      const r = await llm.listModels(fake.settings({ apiBaseUrl: fake.baseUrl }));
      check('/models 失败后回退 Ollama /api/tags', r.ok && r.models.includes('llama3.1'), JSON.stringify(r));
      check('回退请求打到 origin（去掉 /v1）', fake.requests.some((q) => q.url === '/api/tags'), fake.requests.map((q) => q.url).join(','));
    } finally { await fake.close(); }
  }
  {
    const fake = await startFakeLlm(() => ({ status: 500, text: 'boom' }));
    try {
      const r = await llm.listModels(fake.settings());
      check('两处都失败返回 ok:false', r.ok === false && /获取模型列表失败/.test(r.error), JSON.stringify(r));
    } finally { await fake.close(); }
  }
  {
    const fake = await startFakeLlm(() => ({ status: 200, json: { data: ['plain-string', { id: 'obj-id' }, { name: 'obj-name' }, { id: '' }] } }));
    try {
      const r = await llm.listModels(fake.settings());
      check('兼容字符串/对象混合并过滤空值', JSON.stringify(r.models) === JSON.stringify(['plain-string', 'obj-id', 'obj-name']), JSON.stringify(r.models));
    } finally { await fake.close(); }
  }
  {
    const fake = await startFakeLlm(() => ({ status: 200, json: { unexpected: 1 } }));
    try {
      const r = await llm.listModels(fake.settings());
      check('未知形状返回空列表且不报错', r.ok === true && r.models.length === 0, JSON.stringify(r));
    } finally { await fake.close(); }
  }
  {
    const fake = await startFakeLlm(() => ({ status: 200, json: { data: [] } }));
    try {
      await llm.listModels(fake.settings({ apiKey: '' }));
      check('无 Key 时不发送 Authorization 头', fake.requests[0].headers.authorization === undefined, String(fake.requests[0].headers.authorization));
    } finally { await fake.close(); }
  }

  // ================= 停止控制 =================
  section('ai/llm.js — stopAi / setAbortController');
  {
    const ctrl = new AbortController();
    llm.setAbortController(ctrl);
    llm.stopAi();
    check('stopAi 中止已注册控制器', ctrl.signal.aborted === true);
    check('重复 stopAi 不抛错', (llm.stopAi(), true));
  }

  summary();
})().catch((err) => {
  console.error('测试执行异常：', err);
  process.exitCode = 1;
});
