// Skills 模块：SKILL.md 解析、目录引用植入
const fs = require('fs');
const { seedSampleSkills, findSkillFile } = require('./skillSeed');

// 抽取技能 frontmatter 的 6 个新增可选字段（语料流水线设计 §5.2）。
// 全部可选：缺省时行为与现状完全一致（kind 缺省 = instructions，即「指令技能」）
const SKILL_KINDS = ['instructions', 'extract'];
const SKILL_MODES = ['llm', 'script'];

// 第 7 个可选字段 enabled（缺省 true）：§5.5 要求 extract-ocr「示例，不默认启用」。
// 放在 frontmatter 而不是在 seedSampleSkills 里写死跳过名单，是因为用户自己装的技能
// 也需要「先植入、但默认关着」的能力（例如需要额外装 tesseract 的脚本技能）。
function parseBool(raw, dft) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return dft;
  if (['false', 'no', 'off', '0'].includes(s)) return false;
  if (['true', 'yes', 'on', '1'].includes(s)) return true;
  return dft;
}

// accepts 支持三种写法：`[pdf, png]`、`pdf, png`、`pdf`。统一成小写、不带点的数组
function parseAccepts(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;                       // 缺省 = 通配（select.js 里按「任意扩展名」处理）
  const body = s.replace(/^\[/, '').replace(/\]$/, '');
  const list = body.split(/[,\s]+/)
    .map((x) => x.trim().replace(/^["']|["']$/g, '').toLowerCase().replace(/^\./, ''))
    .filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1 && (list[0] === '*' || list[0] === 'any')) return null;
  return list;
}

function toInt(v, dft, min, max) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return dft;                       // ⚠️ Number('') === 0，不先挡空串会把「缺省」变成 0
  const n = Number(s);
  if (!Number.isFinite(n)) return dft;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// 读取 skill 目录：解析 SKILL.md 的 frontmatter 与正文（instructions）
// 返回体：{ ok, dir, name, description, instructions } + 6 个抽取技能字段 + enabled
//   kind     'instructions'（缺省）| 'extract'
//   accepts  string[] | null（null = 通配）
//   mode     'llm'（缺省）| 'script'
//   entry    mode=script 时的入口（相对技能目录），缺省 'scripts/main.js'
//   priority 同扩展名多技能命中时的优先级，大者胜，缺省 50
//   version  参与语料指纹（§3.6），版本变了缓存自动失效，缺省 '0.0.0'
function readSkill(dir) {
  const path = require('path');
  const file = findSkillFile(dir);
  if (!file) return { ok: false, error: '该目录下未找到 SKILL.md' };
  const text = fs.readFileSync(file, 'utf-8');
  let name = '', description = '', instructions = text;
  let kind = '', acceptsRaw = '', mode = '', entry = '', priority = '', version = '', enabledRaw = '';
  let timeoutSecRaw = '', output = '';
  // ⚠️ 行尾必须是 \r?\n：Windows 上 create_file/git 写出的 SKILL.md 是 CRLF，
  //    旧正则 /^---\n…/ 永远匹配不上 ⇒ frontmatter 整块被当成 instructions，
  //    name/kind/accepts 全部退化为缺省值（hive-data-analysis 这类老技能也一样中招）。
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (m) {
    instructions = m[2];
    const unquote = (v) => v.trim().replace(/^["']([\s\S]*)["']$/, '$1').trim();
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1];
      const val = kv[2].replace(/\s+$/, '');
      if (key === 'name') name = unquote(val);
      else if (key === 'description') description = unquote(val);
      else if (key === 'kind') kind = unquote(val).toLowerCase();
      else if (key === 'accepts') acceptsRaw = val;
      else if (key === 'mode') mode = unquote(val).toLowerCase();
      else if (key === 'entry') entry = unquote(val);
      else if (key === 'priority') priority = unquote(val);
      else if (key === 'version') unquote(val) && (version = unquote(val));
      else if (key === 'enabled') enabledRaw = unquote(val);
      else if (key === 'timeoutSec') timeoutSecRaw = unquote(val);
      else if (key === 'output') output = unquote(val);
    }
  }
  if (!name) name = path.basename(dir);
  return {
    ok: true,
    dir,
    name,
    description,
    instructions: instructions.trim(),
    kind: SKILL_KINDS.includes(kind) ? kind : 'instructions',
    accepts: parseAccepts(acceptsRaw),
    mode: SKILL_MODES.includes(mode) ? mode : 'llm',
    entry: entry || 'scripts/main.js',
    priority: toInt(priority, 50, 0, 1000),
    version: version || '0.0.0',
    // timeoutSec=0 表示「用全局 extractSkillTimeoutSec」；output 空表示「用默认 corpus-out.md」
    timeoutSec: toInt(timeoutSecRaw, 0, 0, 600),
    output: output || '',
    enabled: parseBool(enabledRaw, true),
  };
}

module.exports = { seedSampleSkills, findSkillFile, readSkill, parseAccepts, parseBool, SKILL_KINDS, SKILL_MODES };
