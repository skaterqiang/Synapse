// MCP 模块：优先使用官方 @modelcontextprotocol/sdk，未安装/连接失败时回退内置客户端
// 对外统一 listTools / callTool / buildMcpTools / testMcp / seedWebSearchMcp
// 约定：所有操作都在"一次会话"内完成（withClient），列工具与调用工具共用同一连接，
// 因为远程 SSE 传输的初始化状态绑定在长连接上，换连接会被服务端拒为 -32602。
const builtin = require('./mcpClient');
const settingsMod = require('../common/settings');

let sdkCache = null;
let sdkUnavailable = false; // 未安装 SDK 时不再反复尝试动态 import
async function loadSdk() {
  if (sdkCache) return sdkCache;
  if (sdkUnavailable) return null;
  try {
    const [c, stdio, http, sse] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/stdio.js'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
      import('@modelcontextprotocol/sdk/client/sse.js'),
    ]);
    sdkCache = { Client: c.Client, Stdio: stdio.StdioClientTransport, Http: http.StreamableHTTPClientTransport, Sse: sse.SSEClientTransport };
    return sdkCache;
  } catch (_) {
    sdkUnavailable = true;
    return null;
  }
}

function authHeaders(cfg, settings) {
  const h = {};
  if (cfg.useModelKey && settings && settings.apiKey) h.Authorization = 'Bearer ' + settings.apiKey;
  if (cfg.env && cfg.env.Authorization) h.Authorization = cfg.env.Authorization;
  return h;
}

// 建立 SDK 连接：stdio 用 StdioClientTransport；远程先试 StreamableHTTP，失败回退 SSE
async function connectSdk(cfg, settings) {
  const sdk = await loadSdk();
  if (!sdk) return null;
  if (cfg.type === 'stdio') {
    const client = new sdk.Client({ name: 'synapse', version: '1.0' });
    await client.connect(new sdk.Stdio({ command: cfg.command, args: cfg.args || [], env: { ...process.env, ...(cfg.env || {}) } }));
    return client;
  }
  const headers = authHeaders(cfg, settings);
  try {
    const client = new sdk.Client({ name: 'synapse', version: '1.0' });
    await client.connect(new sdk.Http(new URL(cfg.url), { requestInit: { headers } }));
    return client;
  } catch (_) {
    const client = new sdk.Client({ name: 'synapse', version: '1.0' });
    await client.connect(new sdk.Sse(new URL(cfg.url), { requestInit: { headers } }));
    return client;
  }
}

// 打开一次会话并执行 fn，结束后必定关闭；仅"建连失败"才回退内置客户端，
// 会话内部的业务错误直接抛出（避免工具被重复执行）
async function withClient(cfg, settings, fn) {
  const sdkClient = await connectSdk(cfg, settings).catch(() => null);
  if (sdkClient) {
    try {
      return await fn({
        kind: 'sdk',
        serverInfo: sdkClient.getServerVersion && sdkClient.getServerVersion(),
        listTools: async () => builtin.toOpenAiTools(cfg, await sdkClient.listTools()),
        callTool: async (name, args) => builtin.toText(await sdkClient.callTool({ name, arguments: args || {} })),
      });
    } finally { try { await sdkClient.close(); } catch (_) {} }
  }
  const s = await builtin.openSession(cfg, settings);
  try {
    return await fn({
      kind: s.kind,
      serverInfo: s.serverInfo,
      listTools: async () => builtin.toOpenAiTools(cfg, await s.request('tools/list', {})),
      callTool: async (name, args) => builtin.toText(await s.request('tools/call', { name, arguments: args || {} })),
    });
  } finally { await s.close(); }
}

function listTools(cfg, settings) {
  return withClient(cfg, settings, (c) => c.listTools());
}

function callTool(cfg, settings, name, args) {
  return withClient(cfg, settings, (c) => c.callTool(name, args));
}

// 工具列表缓存（按服务器身份）：自动模式下每次提问都要列工具，缓存避免重复建连开销
const toolsCache = new Map(); // key -> { at, tools }
const TOOLS_TTL = 5 * 60 * 1000;
const cfgKey = (c) => [c.name, c.type, c.url, c.command, (c.args || []).join(' ')].join('|');

async function listToolsCached(cfg, settings) {
  const k = cfgKey(cfg);
  const hit = toolsCache.get(k);
  if (hit && Date.now() - hit.at < TOOLS_TTL) return hit.tools;
  const tools = await listTools(cfg, settings);
  toolsCache.set(k, { at: Date.now(), tools });
  return tools;
}

// 解析本次问答要装载的 MCP 服务器：
//  渲染层总是传数组（已启用 − 用户去除，可为空表示全部去除）→ 以它为准；
//  未传数组的调用方（内部/兼容）→ 默认全部已启用服务器
function resolveMcpCfgs(payload) {
  if (payload && Array.isArray(payload.extMcp)) return { cfgs: payload.extMcp, explicit: true };
  const all = ((payload && payload.settings && payload.settings.mcpServers) || [])
    .filter((m) => m && m.name && m.enabled !== false);
  return { cfgs: all, explicit: false };
}

// 装载可用工具（OpenAI function 格式），单个服务器失败不阻塞其余
async function buildMcpTools(payload) {
  const { cfgs } = resolveMcpCfgs(payload);
  const settings = (payload && payload.settings) || {};
  const tools = [];
  for (const cfg of cfgs) {
    try { tools.push(...await listToolsCached(cfg, settings)); }
    catch (e) { console.warn(`MCP [${cfg.name}] 列工具失败：${e.message}`); }
  }
  return tools;
}

// 依据工具的 inputSchema 推断“把查询文本放哪个参数”（仅测试用）。
// 必须看 required 与 type：早前的 keys[0] 兜底会把文本塞进第一个属性，
// 如百炼图片生成工具的首个属性是 boolean 的 watermark，
// 结果既填错了类型又漏掉必填的 prompt，服务端直接报 "Param:prompt is required"。
// 返回 missing：无法自动推断的其余必填项（如 image_url），由调用方提示用户显式传参
function guessArgs(tool, query) {
  const p = (tool.function && tool.function.parameters) || {};
  const props = p.properties || {};
  const keys = Object.keys(props).filter((k) => k !== 'ctx');
  const required = (p.required || []).filter((k) => k !== 'ctx');
  // 类型未声明时当作可接文本；明确非 string 的（boolean/integer/array）一律不填
  const isStr = (k) => {
    const t = props[k] && props[k].type;
    return t === undefined || t === 'string' || (Array.isArray(t) && t.includes('string'));
  };
  const strKeys = keys.filter(isStr);
  const reqStr = required.filter(isStr);
  const EXACT = /^(prompt|query|q|keyword|keywords|search|text|input|content|message|question)$/i;
  const LOOSE = /prompt|query|keyword|search|text|input|content|message|question/i;
  const filled = reqStr.find((k) => EXACT.test(k))          // 必填且名字正好是常见语义名
    || strKeys.find((k) => EXACT.test(k))                   // 非必填但名字精确匹配
    || (reqStr.length === 1 ? reqStr[0] : '')               // 只有一个必填字符串参数
    || reqStr.find((k) => LOOSE.test(k))
    || strKeys.find((k) => LOOSE.test(k))
    || '';
  // 推不出来就不编造参数名：与其塞错一个，不如让服务端报出真实缺失项
  return {
    args: filled ? { [filled]: query } : {},
    filled,
    missing: required.filter((k) => k !== filled),
  };
}

// 工具调用成功但无实质内容时给出排查提示。
// 注意：MCP 层的 isError=false 只说明“调用通了”，业务层是否成功要看返回体（如百炼 status：0=成功）。
function resultHint(text) {
  let j;
  try { j = JSON.parse(text); } catch (_) { return ''; }
  if (!j || typeof j !== 'object') return '';
  const arr = ['pages', 'results', 'items', 'data', 'organic'].map((k) => j[k]).find(Array.isArray);
  const empty = arr && arr.length === 0;
  // 业务状态码非 0：服务端未真正执行成功（常见于服务未开通 / 无额度 / 无权限）
  const status = j.status;
  const badStatus = status !== undefined && status !== null && String(status) !== '0';
  if (badStatus) {
    return `⚠️ 服务端返回 status=${status}（非 0 通常表示未执行成功）${empty ? '且结果为空' : ''}。`
      + '这意味着连接与工具调用均正常，但该 MCP 服务本身没有回数据。'
      + '请到服务商控制台确认：① 该 MCP 服务（如百炼 WebSearch）已开通；② 当前 API Key 对该服务有权限；③ 账户有可用额度。';
  }
  if (empty) return '⚠️ 工具已调通，但服务端返回 0 条结果，请确认该 MCP 服务已开通、API Key 有权限与额度。';
  return '';
}

// 测试 MCP：连接 → 列工具；在同一会话内可真实调用一次工具。
// cfg.toolName 显式指定工具（多工具服务必需，否则自动猜测很容易选错）；
// cfg.args 显式指定入参对象（优先于由 query 猜参）。
// 返回 toolSchemas 供前端展示各工具的必填/可选参数，避免盲猜导致 INVALID_PARAMS。
async function testMcp(cfg) {
  const settings = (cfg && cfg.settings) || {};
  const query = String((cfg && cfg.query) || '').trim();
  const wantTool = String((cfg && cfg.toolName) || '').trim();
  const wantArgs = cfg && cfg.args && typeof cfg.args === 'object' && !Array.isArray(cfg.args) ? cfg.args : null;
  const t0 = Date.now();
  try {
    if (cfg.type === 'stdio' ? !cfg.command : !cfg.url) {
      return { ok: false, error: cfg.type === 'stdio' ? '请填写命令' : '请填写 URL' };
    }
    return await withClient(cfg, settings, async (c) => {
      const tools = await c.listTools();
      // 工具入参摘要：名称 + 必填参数 + 全部参数名（剔除 ctx 这类注入型参数）
      const toolSchemas = tools.map((x) => {
        const p = (x.function && x.function.parameters) || {};
        const props = Object.keys(p.properties || {}).filter((k) => k !== 'ctx');
        return { name: x._tool, required: (p.required || []).filter((k) => k !== 'ctx'), params: props };
      });
      let result = null; let usedTool = ''; let usedArgs = null; let toolErr = ''; let argHint = '';
      // 显式指定优先；否则仅在有 query 时自动挑搜索类工具
      let target = null;
      if (wantTool) {
        target = tools.find((x) => x._tool === wantTool) || null;
        if (!target) toolErr = `未找到工具 ${wantTool}`;
      } else if (query && tools.length) {
        target = tools.find((x) => /search|web|query/i.test(x._tool)) || tools[0];
      }
      if (target && (query || wantArgs)) {
        usedTool = target._tool;
        if (wantArgs) {
          usedArgs = wantArgs;
        } else {
          const g = guessArgs(target, query);
          usedArgs = g.args;
          // 自动推参只能填一个文本参数，其余必填项（如 image_url）得用「参数 JSON」传
          if (!g.filled) {
            argHint = `无法从该工具的参数表推断文本参数，请在「参数 JSON」里显式填写（必填：${(g.missing || []).join('、') || '见工具参数说明'}）。`;
          } else if (g.missing.length) {
            argHint = `已自动填入 ${g.filled}；该工具还有必填参数未提供：${g.missing.join('、')}，请在「参数 JSON」里补全。`;
          }
        }
        result = await c.callTool(target._tool, usedArgs);
      }
      const via = c.serverInfo && c.serverInfo.name ? `${c.kind} · ${c.serverInfo.name}` : c.kind;
      return {
        ok: true,
        message: `连接成功（${via}，${Date.now() - t0}ms），共 ${tools.length} 个工具`
          + (usedTool ? `，已调用 ${usedTool}` : toolErr ? `，${toolErr}` : (query ? '，无可用工具可调用' : '')),
        tools: tools.map((x) => x._tool),
        toolSchemas,
        usedTool,
        usedArgs,
        hint: [argHint, result ? resultHint(result) : ''].filter(Boolean).join(' '),
        result,
      };
    });
  } catch (e) {
    return { ok: false, error: `连接失败（${Date.now() - t0}ms）：${e.message}` };
  }
}

// 一次性植入阿里云百炼 WebSearch MCP（API Key 复用模型配置，不重复存储密钥）
// 官方地址为 /mcp（Streamable HTTP）；旧版协议账号该地址会返回 405，
// 客户端会自动回退到 /sse，无需用户改配置（详见 mcpClient.openRemote）
function seedWebSearchMcp() {
  const s = settingsMod.getSettings();
  if (s.__seededWebSearch) return;
  const list = Array.isArray(s.mcpServers) ? s.mcpServers : [];
  if (!list.some((m) => m.name === 'WebSearch')) {
    list.push({ name: 'WebSearch', type: 'http', url: 'https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp', useModelKey: true, enabled: true });
  }
  s.mcpServers = list;
  s.__seededWebSearch = true;
  settingsMod.saveSettings(s);
}

module.exports = { mcpClient: builtin, listTools, listToolsCached, callTool, buildMcpTools, resolveMcpCfgs, testMcp, seedWebSearchMcp };
