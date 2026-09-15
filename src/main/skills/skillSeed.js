// 一次性把指定目录下的 skill 文件包（含 SKILL.md，可一层嵌套）以「目录引用」方式植入设置.skills
const fs = require('fs');
const path = require('path');

// 技能种子目录常量定义于 common/constants.js
const { DEFAULT_SKILLS_DIR } = require('../common/constants');

function findSkillFile(dir) {
  const names = ['SKILL.md', 'skill.md', 'SKILL.MD'];
  for (const c of names) { const f = path.join(dir, c); if (fs.existsSync(f)) return f; }
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const c of names) { const f = path.join(dir, entry.name, c); if (fs.existsSync(f)) return f; }
    }
  } catch (_) {}
  return null;
}

function seedSampleSkills(settingsMod, dir = DEFAULT_SKILLS_DIR) {
  const s = settingsMod.getSettings();
  if (s.__seededSampleSkills) return;
  const skills = Array.isArray(s.skills) ? s.skills : [];
  const have = new Set(skills.map((k) => k.name));
  // 延迟 require：skills.js 在装载期 require 本模块，反向引用只能在运行期发生
  let readSkill = null;
  try { readSkill = require('./skills').readSkill; } catch (_) { /* 解析失败按最小字段植入 */ }
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const top = path.join(dir, entry.name);
      const file = findSkillFile(top);
      if (!file) continue;
      const skillDir = path.dirname(file);
      let name = entry.name; let desc = '';
      // 抽取技能的 6 个 frontmatter 字段（语料流水线设计 §5.2）：
      // 必须一并写进 settings.skills，否则 selectExtractSkills 永远看不到 kind/accepts
      let extra = { kind: 'instructions', accepts: null, mode: 'llm', entry: 'scripts/main.js', priority: 50, version: '0.0.0' };
      // §5.5：extract-ocr 是「示例，不默认启用」——由 frontmatter 的 enabled: false 表达，
      // 而不是在这里写死一份跳过名单（用户自己装的技能也能用同一机制）
      let enabled = true;
      try {
        if (readSkill) {
          const r = readSkill(skillDir);
          if (r && r.ok) {
            name = r.name || name;
            desc = r.description || '';
            extra = { kind: r.kind, accepts: r.accepts, mode: r.mode, entry: r.entry, priority: r.priority, version: r.version };
            enabled = r.enabled !== false;
          }
        } else {
          const text = fs.readFileSync(file, 'utf-8');
          // ⚠️ \r?\n：Windows 写出的 SKILL.md 是 CRLF，旧正则永远匹配不上（与 skills.js:readSkill 同一个坑）
          const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
          if (m) for (const line of m[1].split(/\r?\n/)) {
            const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
            if (!kv) continue;
            const val = kv[2].trim();
            if (kv[1] === 'name') name = val;
            else if (kv[1] === 'description') desc = val.replace(/^["']|["']$/g, '');
            else if (kv[1] === 'enabled') enabled = !['false', 'no', 'off', '0'].includes(val.toLowerCase());
          }
        }
      } catch (_) {}
      if (have.has(name)) continue;
      // instructions 刻意留空：正文可能很长，写进 settings.json 会让配置文件膨胀；
      // parse.js:skillInstructions 在需要时会回读目录内的 SKILL.md
      skills.push({ name, dir: skillDir, desc, description: desc, instructions: '', enabled, ...extra });
      have.add(name);
    }
  } catch (_) {}
  s.skills = skills;
  s.__seededSampleSkills = true;
  settingsMod.saveSettings(s);
}

module.exports = { seedSampleSkills, findSkillFile, DEFAULT_SKILLS_DIR };
