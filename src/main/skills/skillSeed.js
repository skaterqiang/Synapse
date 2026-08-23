// 一次性把指定目录下的 skill 文件包（含 SKILL.md，可一层嵌套）以「目录引用」方式植入设置.skills
const fs = require('fs');
const path = require('path');

const DEFAULT_SKILLS_DIR = '/Users/qiang/sample_center-release/backend/resource/skills';

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
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const top = path.join(dir, entry.name);
      const file = findSkillFile(top);
      if (!file) continue;
      let name = entry.name; let desc = '';
      try {
        const text = fs.readFileSync(file, 'utf-8');
        const m = text.match(/^---\n([\s\S]*?)\n---/);
        if (m) for (const line of m[1].split('\n')) {
          const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
          if (kv) { if (kv[1] === 'name') name = kv[2].trim(); if (kv[1] === 'description') desc = kv[2].trim(); }
        }
      } catch (_) {}
      if (have.has(name)) continue;
      skills.push({ name, dir: path.dirname(file), desc, description: desc, instructions: '', enabled: true });
      have.add(name);
    }
  } catch (_) {}
  s.skills = skills;
  s.__seededSampleSkills = true;
  settingsMod.saveSettings(s);
}

module.exports = { seedSampleSkills, findSkillFile, DEFAULT_SKILLS_DIR };
