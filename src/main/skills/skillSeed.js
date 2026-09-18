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

// 植入策略（2026-09-17 修正）：不再用「一次性守卫」直接 return。
// 旧实现里 __seededSampleSkills 置位后，skills/ 目录后续新增的技能（如 extract-markdown /
// extract-table / extract-slide / extract-ocr）永远不会被植入 settings.skills，导致
// pickExtractSkill 看不到任何 kind:extract 技能，「抽取为语料」的技能选择弹窗静默跳过。
// 现改为：每次启动都扫描目录——新目录植入；已植入的同 dir 条目同步 frontmatter 元数据
// （kind/accepts/mode/entry/priority/version/timeoutSec/output/desc），但**不覆盖 enabled**
// （用户在设置里的启停勾选优先）。无变化时不落盘。
function seedSampleSkills(settingsMod, dir = DEFAULT_SKILLS_DIR) {
  const s = settingsMod.getSettings();
  const skills = Array.isArray(s.skills) ? s.skills : [];
  const have = new Set(skills.map((k) => k.name));
  // 延迟 require：skills.js 在装载期 require 本模块，反向引用只能在运行期发生
  let readSkill = null;
  try { readSkill = require('./skills').readSkill; } catch (_) { /* 解析失败按最小字段植入 */ }
  let dirty = false;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
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
      let extra = { kind: 'instructions', accepts: null, mode: 'llm', entry: 'scripts/main.js', priority: 50, version: '0.0.0', timeoutSec: 0, output: '' };
      // §5.5：extract-ocr 是「示例，不默认启用」——由 frontmatter 的 enabled: false 表达，
      // 而不是在这里写死一份跳过名单（用户自己装的技能也能用同一机制）
      let enabled = true;
      try {
        if (readSkill) {
          const r = readSkill(skillDir);
          if (r && r.ok) {
            name = r.name || name;
            desc = r.description || '';
            extra = { kind: r.kind, accepts: r.accepts, mode: r.mode, entry: r.entry, priority: r.priority, version: r.version, timeoutSec: r.timeoutSec, output: r.output };
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
      if (have.has(name)) {
        // 已植入过：仅当指向同一目录时同步 frontmatter 元数据（kind/accepts/mode 等），
        // 让用户改 SKILL.md 后重启即生效；enabled 不覆盖（设置页的启停勾选优先）
        const cur = skills.find((k) => k.name === name);
        if (cur && cur.dir === skillDir) {
          const next = { ...cur, desc, description: desc, ...extra };
          if (!same(cur, next)) { Object.assign(cur, next); dirty = true; }
        }
        continue;
      }
      // instructions 刻意留空：正文可能很长，写进 settings.json 会让配置文件膨胀；
      // parse.js:skillInstructions 在需要时会回读目录内的 SKILL.md
      skills.push({ name, dir: skillDir, desc, description: desc, instructions: '', enabled, ...extra });
      have.add(name);
      dirty = true;
    }
  } catch (_) {}
  s.skills = skills;
  s.__seededSampleSkills = true;
  if (dirty) settingsMod.saveSettings(s);
}

module.exports = { seedSampleSkills, findSkillFile, DEFAULT_SKILLS_DIR };
