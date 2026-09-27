// =============================================================================
//  operationsSimulation/dueRowFacts.js — 納期一覧の1行の「段・遅れ日数」(純関数)。2026-09-15
// -----------------------------------------------------------------------------
//  今まで DueCalendar.jsx の中に在った数え方を、そのまま外へ出した物。
//  理由: 相手の工場へ渡す「納期一覧の行」も同じ数で作る為(同じ数字を2つの計算から出さない)。
//
//  🚨 数はエンジン(simulate の lotResults)の物をそのまま読む。ここで遅れを判定し直さない。
//     late / alreadyPastDue / judgeable / lateMs / finishMs / dueLineMs をそのまま使う。
//  🚨 「すでに過ぎた」「この先で遅れる」「判定できません」を1つの点数に混ぜない(段 tier)。
//  🚨 製品検査と最終検査で同じファイル(md5 一致)。片方だけ変えない。
// =============================================================================

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const MS_DAY = 86400000;

/** 段。数が小さいほど上(危ない)。 */
export const DUE_TIER = Object.freeze({ PAST: 0, LATE: 1, UNKNOWN: 2, OK: 3 });
export const DUE_TIER_LABEL = Object.freeze(['すでに予定日を過ぎています', 'この先で遅れます', '判定できません', '']);

/**
 * @param {object} o
 * @param {object|null} o.verdict  lotResults の1件(lotVerdictById.get(id))。無ければ null
 * @param {object|null} o.lot      normalized.lots の1件(dueLineMs の予備)
 * @param {number|null} o.nowMs    今(すでに過ぎた日数を数える基準)。🚨 中で時計を読まない
 * @returns {{ tier:number, dueMs:number|null, lateMs:number|null, lateDays:number|null, pastDays:number|null, finishMs:number|null, blocked:string }}
 */
export function dueRowFacts({ verdict = null, lot = null, nowMs = null } = {}) {
  const v = verdict && typeof verdict === 'object' ? verdict : null;
  const l = lot && typeof lot === 'object' ? lot : null;
  const due = v && isNum(v.dueLineMs) ? v.dueLineMs : (l && isNum(l.dueLineMs) ? l.dueLineMs : null);

  let tier = DUE_TIER.OK;
  if (v && v.alreadyPastDue === true) tier = DUE_TIER.PAST;
  else if (v && v.late === true) tier = DUE_TIER.LATE;
  else if ((v && v.judgeable === false) || due == null) tier = DUE_TIER.UNKNOWN;

  // どれだけ遅れるか(日)。🚨 エンジンの lateMs をそのまま日に直すだけ。無ければ書かない。
  const lateMs = v && isNum(v.lateMs) ? v.lateMs : null;
  const lateDays = (tier <= DUE_TIER.LATE && isNum(lateMs) && lateMs > 0) ? Math.ceil(lateMs / MS_DAY) : null;
  const pastDays = (tier === DUE_TIER.PAST && isNum(nowMs) && isNum(due)) ? Math.max(1, Math.ceil((nowMs - due) / MS_DAY)) : null;
  const finishMs = v && isNum(v.finishMs) ? v.finishMs : null;
  const blocked = v && v.blocked ? String(v.blocked) : '';
  return { tier, dueMs: due, lateMs, lateDays, pastDays, finishMs, blocked };
}
