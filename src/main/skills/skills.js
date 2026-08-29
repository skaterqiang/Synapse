// Skills 模块：SKILL.md 解析、目录引用植入
const fs = require('fs');
const { seedSampleSkills, findSkillFile } = require('./skillSeed');

// 读取 skill 目录：解析 SKILL.md 的 frontmatter（name/description）与正文（instructions）
function readSkill(dir) {
  const path = require('path');
  const file = findSkillFile(dir);
  if (!file) return { ok: false, error: '该目录下未找到 SKILL.md' };
  const text = fs.readFileSync(file, 'utf-8');
  let name = '', description = '', instructions = text;
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (m) {
    instructions = m[2];
    const unquote = (v) => v.trim().replace(/^["']([\s\S]*)["']$/, '$1').trim();
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
      if (!kv) continue;
      if (kv[1] === 'name') name = unquote(kv[2]);
      if (kv[1] === 'description') description = unquote(kv[2]);
    }
  }
  if (!name) name = path.basename(dir);
  return { ok: true, dir, name, description, instructions: instructions.trim() };
}

module.exports = { seedSampleSkills, findSkillFile, readSkill };
