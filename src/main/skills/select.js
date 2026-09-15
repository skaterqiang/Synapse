// 抽取技能选择（语料流水线设计 §5.4）
//
// 与「指令技能」的分野：
//   · 指令技能 kind:'instructions'（缺省）——用户勾选后**全部**拼进问答系统提示词（parse.js:64）
//   · 抽取技能 kind:'extract'——由**扩展名自动匹配**，且**只注入命中的那一个**
// 现状「所有技能指令一起拼」正是解析质量不稳的病根，故抽取技能默认只取 1 个（extractSkillTopN）。
const { num } = require('../common/config');
const { DEFAULT_EXTRACT_SKILL_TOPN } = require('../common/constants');

// 扩展名归一：'.PDF' / 'PDF' / 'pdf' → 'pdf'
function normExt(ext) {
  return String(ext == null ? '' : ext).trim().toLowerCase().replace(/^\./, '');
}

/**
 * 按扩展名挑出应当参与解析的抽取技能（已按优先级排序、已截断到 topN）。
 * 三条规则：
 *   ① 只取 kind:'extract'——指令技能永不参与文件解析（向后兼容 G8：缺省 kind 即 instructions）
 *   ② accepts 缺省 = 通配，但 priority 缺省 50 会输给专用技能（专用者优先）
 *   ③ 默认只取 1 个（settings.extractSkillTopN，1–5）
 * @param {Object} settings
 * @param {string} ext 带点或不带点均可
 * @returns {Array<Object>} 命中的技能（settings.skills 里的原对象引用）
 */
function selectExtractSkills(settings, ext) {
  const e = normExt(ext);
  const list = ((settings && settings.skills) || []).filter((k) => k && k.name && k.enabled);
  const hit = list
    .filter((k) => String(k.kind || 'instructions') === 'extract')
    .filter((k) => {
      const acc = Array.isArray(k.accepts) ? k.accepts : null;
      if (!acc || !acc.length) return true;                       // 缺省 = 通配
      return acc.map(normExt).includes(e);
    })
    .sort((a, b) => (num(b, 'priority', 50) - num(a, 'priority', 50))
      || String(a.name).localeCompare(String(b.name)));           // 同优先级按名字，保证结果稳定
  return hit.slice(0, num(settings, 'extractSkillTopN', DEFAULT_EXTRACT_SKILL_TOPN, 1, 5));
}

/**
 * 某个具体技能是否适用于该扩展名（试跑与 UI 提示用，不做排序/截断）。
 * 与 selectExtractSkills 的判据同源，避免两处口径漂移。
 */
function skillAcceptsExt(skill, ext) {
  if (!skill || !skill.name) return false;
  const acc = Array.isArray(skill.accepts) ? skill.accepts : null;
  if (!acc || !acc.length) return true;
  return acc.map(normExt).includes(normExt(ext));
}

module.exports = { selectExtractSkills, skillAcceptsExt, normExt };
