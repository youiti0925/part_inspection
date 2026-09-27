// =============================================================================
//  skillRegistry.js — スキルの「置き場の形」と「割付へ渡す形」を1か所に（2026-09-03 決まり17）
// -----------------------------------------------------------------------------
//  ここが決めるのは3つだけ。
//   ① スキルの記録の形      settings.skills[] = { id, name, note, scope, templateId, by, at }
//   ② テンプレに要るスキル  templates/{id}.requiredSkills[] = { skillId, stepIds:[] }（空＝全工程）
//   ③ 人のレベルの言葉      settings.workerSkills[名前][skillId] = 0〜3
//        0 記録なし（分かりません）／1 🎓教育中／2 一人でできる／3 教えられる
//        割付で「配れる」と見なす線 = ASSIGNABLE_LEVEL（2）
//
//  🚨 割付へ渡す skillConfig を作る式は buildSkillConfig **ただ1つ**。
//     以前は OperationsSimulationPanel.jsx と operationsSimulation.worker.js に同じ式が
//     2つあり、片方だけ直すと画面と計算で「配れる人」が割れる。ここへ寄せた。
//  🚨 React / Firebase を import しない（node --test で単体で動く）。
//  🚨 現在時刻を関数の中で取らない。id を作る時は呼ぶ側が now を渡す。
//  🚨 禁じ語（dispatchWords.js）を文字列に書かない。実績・登録が無い人は「分かりません」。
// =============================================================================

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const asArray = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);
const str = (v) => (v == null ? '' : String(v));
const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

/** 人のレベルの言葉（語彙4つ）。画面の select も凡例もここから引く。 */
export const SKILL_LEVELS = Object.freeze([
  Object.freeze({ v: 0, label: '記録なし', mark: '−', cls: 'text-slate-300', cell: '' }),
  Object.freeze({ v: 1, label: '教育中', mark: '🎓', cls: 'text-amber-600', cell: 'bg-amber-50' }),
  Object.freeze({ v: 2, label: '一人でできる', mark: '○', cls: 'text-blue-600', cell: 'bg-blue-50' }),
  Object.freeze({ v: 3, label: '教えられる', mark: '教', cls: 'text-emerald-700', cell: 'bg-emerald-50' }),
]);

/** 割付で「配れる」と見なすレベル。⚠ 清水さんの確認待ち（設計書4-1）。3 に戻すならここ1か所。 */
export const ASSIGNABLE_LEVEL = 2;

export const SKILL_SCOPE = Object.freeze({ SHARED: 'shared', TEMPLATE: 'template' });
export const SKILL_SCOPE_LABEL = Object.freeze({ shared: '共通', template: '★特注機' });

/** レベル値 → 言葉。知らない値は 0 扱い。 */
export const skillLevelOf = (v) => SKILL_LEVELS.find((l) => l.v === int(v)) || SKILL_LEVELS[0];
export const isAssignableLevel = (v) => int(v) >= ASSIGNABLE_LEVEL;

/** id を作る。🚨 now は呼ぶ側が渡す（この中で Date.now を呼ばない）。 */
export const newSkillId = (now, salt = '') => `sk_${int(now).toString(36)}${salt ? '_' + str(salt) : ''}`;

/** スキル1件を決まった形に。壊れた物は null。 */
export function normalizeSkill(s) {
  if (!isObj(s)) return null;
  const id = trimmed(str(s.id));
  const name = trimmed(str(s.name));
  if (!id || !name) return null;
  const scope = s.scope === SKILL_SCOPE.TEMPLATE ? SKILL_SCOPE.TEMPLATE : SKILL_SCOPE.SHARED;
  const out = { id, name, note: trimmed(str(s.note)), scope };
  const tid = trimmed(str(s.templateId));
  if (scope === SKILL_SCOPE.TEMPLATE && tid) out.templateId = tid;
  if (trimmed(str(s.by))) out.by = trimmed(str(s.by));
  if (Number.isFinite(Number(s.at)) && Number(s.at) > 0) out.at = Number(s.at);
  return out;
}

/** 一覧を決まった形に（壊れた物は落とす・id の重複は先勝ち）。 */
export function normalizeSkills(list) {
  const seen = new Set();
  const out = [];
  asArray(list).forEach((s) => {
    const n = normalizeSkill(s);
    if (!n || seen.has(n.id)) return;
    seen.add(n.id);
    out.push(n);
  });
  return out;
}

export function upsertSkill(list, skill) {
  const n = normalizeSkill(skill);
  if (!n) return normalizeSkills(list);
  const cur = normalizeSkills(list);
  const i = cur.findIndex((x) => x.id === n.id);
  if (i < 0) return [...cur, n];
  const next = cur.slice();
  next[i] = n;
  return next;
}

export function removeSkill(list, skillId) {
  const id = str(skillId);
  return normalizeSkills(list).filter((x) => x.id !== id);
}

/**
 * テンプレの requiredSkills を決まった形へ。
 * 受ける形: 'sk_x' ／ { skillId, level } ／ { skillId, stepIds:[] }
 * 返す形:  [{ skillId, stepIds:[] }]（stepIds 空＝全工程）。同じ skillId は1つに束ねる。
 * ⚠ level は使わない（配れる線は ASSIGNABLE_LEVEL ただ1つ）。
 */
export function normalizeRequiredSkills(list) {
  const by = new Map();
  asArray(list).forEach((rs) => {
    const skillId = typeof rs === 'string' ? trimmed(rs) : trimmed(str(rs?.skillId));
    if (!skillId) return;
    const stepIds = typeof rs === 'string' ? [] : asArray(rs?.stepIds).map((x) => trimmed(str(x))).filter(Boolean);
    const cur = by.get(skillId);
    if (!cur) { by.set(skillId, { skillId, stepIds: [...new Set(stepIds)] }); return; }
    // 同じスキルが2回あれば「広い方」（全工程指定があれば全工程）
    if (cur.stepIds.length === 0 || stepIds.length === 0) cur.stepIds = [];
    else cur.stepIds = [...new Set([...cur.stepIds, ...stepIds])];
  });
  return [...by.values()];
}

/** その工程に要るスキル id の一覧。 */
export function requiredSkillIdsForStep(requiredSkills, stepId) {
  const sid = str(stepId);
  return normalizeRequiredSkills(requiredSkills)
    .filter((rs) => rs.stepIds.length === 0 || rs.stepIds.includes(sid))
    .map((rs) => rs.skillId);
}

/** テンプレへスキルを付ける（stepIds 空＝全工程）。既にあれば上書き。 */
export function attachSkill(requiredSkills, skillId, stepIds = []) {
  const id = trimmed(str(skillId));
  if (!id) return normalizeRequiredSkills(requiredSkills);
  const rest = normalizeRequiredSkills(requiredSkills).filter((rs) => rs.skillId !== id);
  const ids = [...new Set(asArray(stepIds).map((x) => trimmed(str(x))).filter(Boolean))];
  return [...rest, { skillId: id, stepIds: ids }];
}

export function detachSkill(requiredSkills, skillId) {
  const id = str(skillId);
  return normalizeRequiredSkills(requiredSkills).filter((rs) => rs.skillId !== id);
}

/**
 * 工程1つについて「このスキルが要る」を付け外しする。
 * 全工程（stepIds 空）の物はここでは外せない（テンプレの行で外す）。
 */
export function toggleSkillOnStep(requiredSkills, skillId, stepId, on) {
  const id = trimmed(str(skillId));
  const sid = trimmed(str(stepId));
  const cur = normalizeRequiredSkills(requiredSkills);
  if (!id || !sid) return cur;
  const hit = cur.find((rs) => rs.skillId === id);
  if (on) {
    if (!hit) return [...cur, { skillId: id, stepIds: [sid] }];
    if (hit.stepIds.length === 0) return cur;                 // 全工程 → 既に含む
    if (hit.stepIds.includes(sid)) return cur;
    return cur.map((rs) => (rs.skillId === id ? { skillId: id, stepIds: [...rs.stepIds, sid] } : rs));
  }
  if (!hit || hit.stepIds.length === 0) return cur;           // 全工程の物はここでは外せない
  const left = hit.stepIds.filter((x) => x !== sid);
  if (left.length === 0) return cur.filter((rs) => rs.skillId !== id);
  return cur.map((rs) => (rs.skillId === id ? { skillId: id, stepIds: left } : rs));
}

/** スキルごとに「使っているテンプレ」を数える。{ [skillId]: [{ templateId, name, stepCount, totalSteps }] } */
export function templatesBySkill(templates) {
  const out = {};
  asArray(templates).forEach((t) => {
    const tid = trimmed(str(t?.id ?? t?.__id));
    if (!tid) return;
    const steps = asArray(t?.steps);
    normalizeRequiredSkills(t?.requiredSkills).forEach((rs) => {
      const stepCount = rs.stepIds.length === 0 ? steps.length : rs.stepIds.filter((s) => steps.some((st) => str(st?.id) === s)).length;
      (out[rs.skillId] = out[rs.skillId] || []).push({ templateId: tid, name: str(t?.name), stepCount, totalSteps: steps.length, allSteps: rs.stepIds.length === 0 });
    });
  });
  return out;
}

/**
 * 割付（historyEligibility.buildEligibility）へ渡す skillConfig を作る。**唯一の式**。
 *  - workerSkills が無ければ null（正式な登録が0件＝今までどおり実績だけで配る）
 *  - あれば { workerSkills, templates, certifiedLevel: ASSIGNABLE_LEVEL }
 * ⚠ templates は requiredSkills を持つ物をそのまま渡す（工程ごとの絞りは historyEligibility 側）。
 */
export function buildSkillConfig({ settings, templates } = {}) {
  const ws = isObj(settings) && isObj(settings.workerSkills) ? settings.workerSkills : null;
  if (!ws) return null;
  return { workerSkills: ws, templates: asArray(templates), certifiedLevel: ASSIGNABLE_LEVEL };
}

/** 人 × スキルのレベル。無ければ 0。 */
export const workerSkillLevel = (workerSkills, name, skillId) => int(isObj(workerSkills) ? workerSkills?.[str(name)]?.[str(skillId)] : 0);
