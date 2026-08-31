// 技能解析：用已启用技能（SKILL.md 指令包）+ 模型把文档解析为 Markdown。
// 定位：「内置解析」的能力扩展层——内置解析覆盖常见文本型与常规 Office/PDF，
// 技能解析补齐缺口（图片等内置不支持的格式），并按技能指令对内容做结构化重组。
// 机制为「AI 直读」：文件内容（文本 / 图片 base64）+ 已启用技能指令 → 模型直接产出 Markdown；
// 非图片二进制先经内置解析取文本再交给模型。模型调用失败由 files.js 编排自动回退内置解析。
const fs = require('fs');
const path = require('path');
const { num } = require('../common/config');
const { DEFAULTS } = require('../ai/defaults');
const { MINERU_IMAGE_EXTS } = require('../common/constants');

// 图片 MIME 映射（多模态 data URL 用）；与 MINERU_IMAGE_EXTS 同口径
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jp2': 'image/jp2',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
};
// 图片直读上限：base64 会膨胀约 33%，过大的图多数视觉接口也拒收
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// 技能指令注入预算：单技能截断 + 总量上限，避免超长 SKILL.md 挤爆上下文
const PER_SKILL_CHARS = 6000;
const TOTAL_SKILL_CHARS = 16000;

// 已启用技能（设置→技能，enabled 且有名）
function enabledSkills(settings) {
  return ((settings && settings.skills) || []).filter((k) => k && k.name && k.enabled);
}

// 模型是否可用：本地端点（Ollama/loopback）免 Key，远端需已填 API Key（与 llm.requiresApiKey 同口径）
function hasModel(settings) {
  const url = String((settings && settings.apiBaseUrl) || DEFAULTS.apiBaseUrl);
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url)) return true;
  if (String((settings && settings.apiProvider) || '') === 'ollama') return true;
  return !!String((settings && settings.apiKey) || '').trim();
}

// 技能解析是否就绪：开关未显式关闭（默认开启）+ 有已启用技能 + 模型可用。
// 注意与「skill 缓存是否命中」的口径区分：缓存命中只看开关（settings.skillParse !== false），
// 产物本身是有效 Markdown，技能/模型后续变化不必强制重跑
function skillParseReady(settings) {
  if (!settings || settings.skillParse === false) return false;
  if (!enabledSkills(settings).length) return false;
  return hasModel(settings);
}

// 技能指令正文：优先取设置里登记的 instructions；为空（在线安装登记时未带正文）时回读目录内 SKILL.md
function skillInstructions(k) {
  if (String((k && k.instructions) || '').trim()) return String(k.instructions);
  try {
    if (!k || !k.dir) return '';
    const { readSkill } = require('./skills');
    const r = readSkill(k.dir);
    if (r && r.ok && r.instructions) return r.instructions;
  } catch (_) { /* 目录失效等：按无指令处理 */ }
  return '';
}

// 系统提示词：解析职责 + 已启用技能指令（截断注入）+ 输出约束
function buildSystemPrompt(skills, ext) {
  const parts = ['你是文档解析引擎。任务：把给定的文件内容转换为高质量 Markdown，直接作为笔记正文。'];
  const blocks = [];
  let total = 0;
  for (const k of skills) {
    const ins = skillInstructions(k);
    if (!ins) continue;
    const clipped = ins.length > PER_SKILL_CHARS ? ins.slice(0, PER_SKILL_CHARS) + '\n…（指令过长已截断）' : ins;
    const block = `## 技能：${k.name}\n${clipped}`;
    if (total + block.length > TOTAL_SKILL_CHARS) break;
    blocks.push(block);
    total += block.length;
  }
  if (blocks.length) parts.push('【已启用技能指令】参照其中与当前文件格式相关的部分：\n' + blocks.join('\n\n'));
  parts.push([
    '【输出要求】',
    '1. 只输出 Markdown 正文本身，不要前言、解释或代码围栏包裹',
    '2. 忠实于原内容，不虚构、不添加原文没有的信息',
    '3. 保留标题、列表、表格等结构；表格用 Markdown 表格语法呈现',
    MINERU_IMAGE_EXTS.has(ext)
      ? '4. 图片：完整转写图中文字，并用 Markdown 描述图表、结构等重要视觉信息'
      : '4. 内容被截断时只解析已提供部分，不要猜测被截断的内容',
  ].join('\n'));
  return parts.join('\n\n');
}

// 模型输出清洗：去掉整体包裹的 ```markdown 围栏（个别模型不遵守「不要围栏」约束）
function cleanOutput(text) {
  let s = String(text || '').trim();
  const fence = s.match(/^```(?:markdown|md)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
  if (fence) s = fence[1].trim();
  return s;
}

// 技能解析入口。返回 { ok:true, text } 或 { ok:false, error }（由 files.js 决定是否回退内置）。
// opts: { buffer, builtinText, builtinExtract(ext, buffer) -> Promise<string>, onLog(line) }
//   builtinText：调用方已提取的内置文本（优先使用，避免重复解析）；
//   builtinExtract 由 files.js 注入（避免本模块反向依赖解析层）：未提供文本时用它取
async function parseWithSkills(absPath, settings, opts = {}) {
  const ext = path.extname(String(absPath)).toLowerCase();
  const skills = enabledSkills(settings);
  if (!skills.length) return { ok: false, error: '没有已启用的技能' };
  let buffer;
  try { buffer = opts.buffer || fs.readFileSync(absPath); } catch (err) { return { ok: false, error: '文件读取失败：' + err.message }; }
  const log = (line) => { if (opts.onLog) { try { opts.onLog(line); } catch (_) { /* 日志回调失败不影响解析 */ } } };

  // 构造 user 消息：图片走 base64 多模态直读；其它类型先取文本（内置解析 → 无 NUL 按文本兜底）
  const userContent = [];
  if (MINERU_IMAGE_EXTS.has(ext)) {
    if (buffer.length > MAX_IMAGE_BYTES) {
      return { ok: false, error: `图片过大（${(buffer.length / 1048576).toFixed(1)}MB），超过技能解析 ${(MAX_IMAGE_BYTES / 1048576).toFixed(0)}MB 上限` };
    }
    const mime = IMAGE_MIME[ext] || 'application/octet-stream';
    userContent.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${buffer.toString('base64')}` } });
    userContent.push({ type: 'text', text: `以上是图片文件 ${path.basename(String(absPath))} 的内容，请解析并以 Markdown 输出。` });
  } else {
    let text = '';
    let builtinError = '';
    if (typeof opts.builtinText === 'string') {
      text = opts.builtinText;
    } else if (typeof opts.builtinExtract === 'function') {
      try { text = String((await opts.builtinExtract(ext, buffer)) || ''); } catch (err) { builtinError = err.message; }
    }
    // 内置解析拿不到文本但内容无 NUL（rtf/epub 内文等文本样二进制）：原文直接交给模型
    if (!text.trim() && !buffer.includes(0)) {
      try { text = buffer.toString('utf-8'); } catch (_) { /* 解码失败保持空 */ }
    }
    if (!text.trim()) {
      return {
        ok: false,
        error: builtinError
          ? `内置解析无法提取文本（${builtinError}），且该二进制内容无法直接交给模型`
          : '文件内容为空',
      };
    }
    const cap = num(settings, 'sourceMaxChars', 60000, 1000, 1000000);
    let body = text;
    let truncated = false;
    if (body.length > cap) { body = body.slice(0, cap); truncated = true; }
    userContent.push({
      type: 'text',
      text: `以下是文件 ${path.basename(String(absPath))}（${ext || '无扩展名'}）提取出的原始内容${truncated ? '（过长已截断）' : ''}：\n\n${body}`,
    });
  }

  log(`技能解析：${skills.length} 个已启用技能参与，调用模型…`);
  // 延迟 require 避免装载期循环（llm 不依赖本模块，运行期引用安全）
  const llm = require('../ai/llm');
  const messages = [
    { role: 'system', content: buildSystemPrompt(skills, ext) },
    { role: 'user', content: userContent },
  ];
  let out;
  try {
    out = await llm.chatOnce(settings, messages, 1);
  } catch (err) {
    return { ok: false, error: '模型调用失败：' + err.message };
  }
  const md = cleanOutput(out);
  if (!md.trim()) return { ok: false, error: '模型返回内容为空' };
  return { ok: true, text: md };
}

module.exports = { skillParseReady, enabledSkills, parseWithSkills };
