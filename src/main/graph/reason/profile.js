'use strict';

// ---------------------------------------------------------------------------
// reason/profile.js — OWL 2 子语言（Profile）判定（设计文档 §4.6）
//
// 职责：导入 OWL 时判定它属于 RL / QL / EL 中的哪些子语言，
//       并据此告诉用户「本地推理是否可行」。
//
// ⚠️ 已核实：protege-js 的 checkRL/checkQL/checkEL 接收的是 **OWLOntology
//    对象**（内部调 ont.getAxiomsOfType(...)），不是 TripleStore。
//    因此本模块只在 owlImport 路径（有 OWLOntology）上可用；
//    Synapse 原生图谱没有 OWLOntology，走 reason/infer.js 的 RL 物化即可。
//
// ⚠️ 已核实（实测 OWL2Profiles 导出形态）：
//      module.exports = { Profiles, checkProfile, isInProfile, checkRL, checkQL, checkEL }
//      Profiles === { RL:'RL', QL:'QL', EL:'EL' }  ← 只是**字符串常量表**，
//      上面**没有** checkRL/checkQL/checkEL 方法（typeof 均为 undefined）。
//    判定函数是模块级独立导出。早期实现误写成 Profiles.checkRL(ont)，
//    导致每个本体都报「fn is not a function」、recommend 恒为 null、
//    reasonerAvailable 恒为 false（即「所有导入本体都无法本地推理」的假结论）。
// ---------------------------------------------------------------------------

let Profiles = null;        // { RL:'RL', QL:'QL', EL:'EL' } 常量表
let checkRL = null;         // (ont) => violations[]
let checkQL = null;
let checkEL = null;
let checkProfile = null;    // (ont, 'RL'|'QL'|'EL') => violations[]
let loadError = '';
try {
  const m = require('@skaterqiang/protege-js/src/profiles/OWL2Profiles');
  Profiles = (m && m.Profiles) || null;
  const fn = (f) => (typeof f === 'function' ? f : null);
  checkRL = fn(m.checkRL);
  checkQL = fn(m.checkQL);
  checkEL = fn(m.checkEL);
  checkProfile = fn(m.checkProfile);
  // 兜底：若未来版本把判定函数挂回 Profiles 上，也能取到
  if (Profiles) {
    checkRL = checkRL || fn(Profiles.checkRL);
    checkQL = checkQL || fn(Profiles.checkQL);
    checkEL = checkEL || fn(Profiles.checkEL);
  }
  // 再兜底：只有 checkProfile 时，用它拼出三个判定函数
  if (!checkRL && checkProfile) checkRL = (ont) => checkProfile(ont, 'RL');
  if (!checkQL && checkProfile) checkQL = (ont) => checkProfile(ont, 'QL');
  if (!checkEL && checkProfile) checkEL = (ont) => checkProfile(ont, 'EL');
} catch (err) {
  loadError = String((err && err.message) || err);
}

/** 子语言判定能力是否可用。 */
function profileCheckAvailable() { return !!(checkRL && checkQL && checkEL); }

const PROFILE_META = {
  RL: {
    id: 'RL', name: 'OWL 2 RL',
    desc: '规则可实现的子语言，支持前向链物化推理',
    localReasoning: true,
    reasoner: 'OWL2RLReasoner（Synapse 默认走这条）',
    complexity: '多项式时间',
  },
  QL: {
    id: 'QL', name: 'OWL 2 QL',
    desc: '面向数据库查询改写的子语言',
    localReasoning: false,
    reasoner: '需 OBDA/查询改写引擎（如 Ontop），Synapse 不内置',
    complexity: 'AC0（查询复杂度）',
  },
  EL: {
    id: 'EL', name: 'OWL 2 EL',
    desc: '面向大规模分类推理的子语言（SNOMED CT、GO 常用）',
    localReasoning: false,
    reasoner: '需 EL 专用分类器（Synapse 暂不接）',
    complexity: '多项式时间',
  },
};

/**
 * 判定一个 OWLOntology 的 profile 归属。
 *
 * @param {object} ontology  protege-js 的 OWLOntology 实例
 * @param {object} [opts]
 * @param {number} [opts.maxViolations=20]  每个 profile 最多回报多少条违规（防 UI 撑爆）
 * @returns {{available:boolean, error?:string,
 *   rl:{ok:boolean, violations:Array, shown:number, total:number},
 *   ql:{...}, el:{...},
 *   recommend:string|null, reasonerAvailable:boolean, profiles:string[], meta:object}}
 */
function detectProfile(ontology, opts = {}) {
  const maxViolations = Number.isFinite(Number(opts.maxViolations))
    ? Math.max(1, Math.min(200, Math.round(Number(opts.maxViolations)))) : 20;

  if (!profileCheckAvailable()) {
    return {
      available: false, error: loadError || 'OWL2Profiles 的 checkRL/checkQL/checkEL 不可用',
      rl: none(), ql: none(), el: none(),
      recommend: null, reasonerAvailable: false, profiles: [], meta: PROFILE_META,
    };
  }
  if (!ontology || typeof ontology.getAxiomsOfType !== 'function') {
    return {
      available: false, error: '需要 OWLOntology 实例（含 getAxiomsOfType）',
      rl: none(), ql: none(), el: none(),
      recommend: null, reasonerAvailable: false, profiles: [], meta: PROFILE_META,
    };
  }

  const run = (fn) => {
    try {
      const v = fn(ontology);
      return Array.isArray(v) ? v : [];
    } catch (err) {
      return [{ profile: '?', rule: 'check-failed', message: String((err && err.message) || err), axiom: null }];
    }
  };

  const wrap = (list) => ({
    ok: list.length === 0,
    violations: list.slice(0, maxViolations).map(normViolation),
    shown: Math.min(list.length, maxViolations),
    total: list.length,
  });

  const rl = wrap(run(checkRL));
  const ql = wrap(run(checkQL));
  const el = wrap(run(checkEL));

  // 推荐顺序：RL 优先（Synapse 本地能推）→ QL → EL
  const recommend = rl.ok ? 'RL' : (ql.ok ? 'QL' : (el.ok ? 'EL' : null));
  const profiles = [rl.ok && 'RL', ql.ok && 'QL', el.ok && 'EL'].filter(Boolean);

  return {
    available: true,
    rl, ql, el,
    recommend,
    // 只有 RL 能在 Synapse 本地物化推理；QL/EL 需要外部推理机
    reasonerAvailable: rl.ok,
    profiles,
    meta: PROFILE_META,
  };
}

function none() { return { ok: false, violations: [], shown: 0, total: 0 }; }

function normViolation(v) {
  if (!v || typeof v !== 'object') return { rule: '?', message: String(v), profile: '', axiom: '' };
  let axiom = '';
  try {
    if (v.axiom && typeof v.axiom.toString === 'function') axiom = v.axiom.toString();
    else if (typeof v.axiom === 'string') axiom = v.axiom;
  } catch (_) { axiom = ''; }
  return {
    profile: v.profile || '',
    rule: v.rule || '',
    message: v.message || '',
    axiom: axiom.slice(0, 300),
  };
}

/**
 * 面向 UI 的可读结论（导入预览弹窗用）。
 * @returns {{headline:string, lines:string[], canReasonLocally:boolean, recommend:string|null}}
 */
function explainProfile(result) {
  if (!result || !result.available) {
    return {
      headline: '子语言判定不可用',
      lines: [(result && result.error) || 'protege-js 的 OWL2Profiles 模块未能加载'],
      canReasonLocally: false, recommend: null,
    };
  }
  const lines = [];
  for (const key of ['rl', 'ql', 'el']) {
    const r = result[key];
    const meta = PROFILE_META[key.toUpperCase()];
    lines.push(r.ok
      ? `✅ ${meta.name}：符合（${meta.desc}）`
      : `❌ ${meta.name}：不符合，${r.total} 处违规${r.total > r.shown ? `（仅显示前 ${r.shown} 条）` : ''}`);
  }
  const headline = result.recommend
    ? `该本体属于 OWL 2 ${result.recommend}`
      : '该本体不属于 RL / QL / EL 任一子语言（OWL 2 Full 或 DL 完整表达力）';
  if (result.reasonerAvailable) {
    lines.push('→ Synapse 可用内置 OWL 2 RL 推理机做本地物化推理。');
  } else if (result.recommend) {
    lines.push(`→ 属于 ${PROFILE_META[result.recommend].name}，但 Synapse 只内置 RL 推理机：${PROFILE_META[result.recommend].reasoner}。`);
  } else {
    lines.push('→ 无法本地推理：完整 OWL 2 DL 需要 HermiT / Pellet / ELK 等外部推理机。');
    lines.push('  仍可导入类层级与谓词作为受控词表，只是不产生推理边。');
  }
  return { headline, lines, canReasonLocally: !!result.reasonerAvailable, recommend: result.recommend };
}

module.exports = {
  PROFILE_META,
  profileCheckAvailable,
  detectProfile,
  explainProfile,
};
