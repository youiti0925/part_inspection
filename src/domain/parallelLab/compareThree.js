// =============================================================================
//  parallelLab/compareThree.js — 1人・ロットA(自動運転中)・ロットB(手作業)・設備 の時間軸で 3案を並べる純関数(2026-09-22 夜)
// -----------------------------------------------------------------------------
//  案: 待機 / 間に合う範囲で応援 / 全体の納期を見て応援。同じ固定入力(A の残り・B の所要・往復・余裕)から。
//  🚨 根拠が無い数字は出さない: profile.ok / candidate.ok / 往復・余裕 が無ければ ok:false と missing を返す(数字は null)。
//  🚨 時計を読まない(nowMs は引数)。確率を作らない(「時間が外れた場合」は shift で指定して引き直す)。
// =============================================================================
const finite = (v) => (Number.isFinite(v) ? v : null);

export const PLAN_KEYS = Object.freeze(['stay', 'safe', 'due']);
export const PLAN_LABEL = Object.freeze({ stay: '待機', safe: '間に合う範囲で応援', due: '全体の納期を見て応援' });

/**
 * @param profile   buildPhaseProfile の戻り(ロットA)
 * @param candidate buildCandidateJob の戻り(ロットB)
 * @param travelMin 片道の分(登録)。null なら比較しない
 * @param returnMarginMin 戻る余裕の分(登録)。null なら比較しない
 * @param nowMs 基準時刻
 * @param aDueMs ロットAの納期線(無ければ null。納期の判定は出さない)。Bの納期は 後続の割付が要るので 全体再計算(未)で
 * @param equipNextStartMs 設備の次の仕事の開始予定(無ければ null)
 * @param shift { autoDeltaMin?:number, bDeltaMin?:number } 時間が外れた場合(自動が早く/遅く・Bが長引く)。既定 0
 * @param urgent ロットAが緊急か(urgentPolicy='stay' なら応援の2案は「離れない」に畳む)
 */
export function compareThree({ profile, candidate, travelMin, returnMarginMin, nowMs, aDueMs = null, equipNextStartMs = null, shift = {}, urgent = false, urgentPolicy = 'stay' } = {}) {
  const missing = [];
  if (!profile || !profile.ok) missing.push(...((profile && profile.missing) || ['ロットAの材料が無い']));
  if (!candidate || !candidate.ok) missing.push(...((candidate && candidate.missing) || ['ロットBの材料が無い']));
  if (!Number.isFinite(travelMin)) missing.push('場所どうしの往復時間(片道の分)が未登録');
  if (!Number.isFinite(returnMarginMin)) missing.push('戻る余裕(終了見込みの何分前までに戻るか)が未登録');
  if (!Number.isFinite(nowMs)) missing.push('基準時刻が無い');
  if (missing.length) return { ok: false, missing, plans: null, summary: null };

  const autoRemain = Math.max(0, profile.autoRemainingMs + (finite(shift.autoDeltaMin) || 0) * 60000);
  const bWork = Math.max(0, candidate.workMs + (finite(shift.bDeltaMin) || 0) * 60000);
  const travel = travelMin * 60000;
  const margin = returnMarginMin * 60000;
  const autoEndMs = nowMs + autoRemain;
  const finish = profile.finishWorkMs;
  const leaveAllowed = profile.mayLeave === true && !(urgent && urgentPolicy === 'stay');

  // 案1 待機: 人はAのそばで待つ。終了後すぐ対応。Bは進まない
  const stay = {
    key: 'stay', label: PLAN_LABEL.stay, segments: [
      { who: 'worker', kind: 'idle', fromMs: nowMs, toMs: autoEndMs, label: '自動中の手待ち' },
      { who: 'A', kind: 'auto', fromMs: nowMs, toMs: autoEndMs },
      { who: 'worker', kind: 'finish', fromMs: autoEndMs, toMs: autoEndMs + finish, label: 'Aの終了対応' },
      { who: 'A', kind: 'finish', fromMs: autoEndMs, toMs: autoEndMs + finish },
    ],
    aDoneMs: autoEndMs + finish, bDoneMs: null, bProgressMs: 0, idleMs: autoRemain, travelMs: 0, aWaitMs: 0,
  };
  // 応援の共通: 行って(travel)・Bを bWork やって・戻る(travel)
  const backAt = nowMs + travel + bWork + travel;
  const helper = (key, allow, whyNot = null) => {
    if (!leaveAllowed) return { ...stay, key, label: PLAN_LABEL[key], sameAsStay: true, why: profile.mayLeave !== true ? '離れてよい工程として登録されていない' : '緊急ロットは離れない(設定)' };
    if (!allow) return { ...stay, key, label: PLAN_LABEL[key], sameAsStay: true, why: whyNot || `往復込み ${Math.round((travel * 2 + candidate.workMs) / 60000)}分 は 自動の残り ${Math.round(profile.autoRemainingMs / 60000)}分 − 余裕 ${returnMarginMin}分 に収まらない` };
    const aWait = Math.max(0, backAt - autoEndMs);           // 機械が終わってから人が戻るまでの人待ち
    const finishStart = Math.max(backAt, autoEndMs);
    return {
      key, label: PLAN_LABEL[key], sameAsStay: false, segments: [
        { who: 'worker', kind: 'travel', fromMs: nowMs, toMs: nowMs + travel, label: 'Bへ移動' },
        { who: 'worker', kind: 'work', fromMs: nowMs + travel, toMs: nowMs + travel + bWork, label: 'Bの手作業' },
        { who: 'B', kind: 'work', fromMs: nowMs + travel, toMs: nowMs + travel + bWork },
        { who: 'worker', kind: 'travel', fromMs: nowMs + travel + bWork, toMs: backAt, label: 'Aへ戻る' },
        { who: 'A', kind: 'auto', fromMs: nowMs, toMs: autoEndMs },
        ...(aWait > 0 ? [{ who: 'A', kind: 'wait', fromMs: autoEndMs, toMs: backAt, label: '終了後の人待ち' }] : []),
        ...(backAt < autoEndMs ? [{ who: 'worker', kind: 'idle', fromMs: backAt, toMs: autoEndMs, label: '戻ってからの手待ち' }] : []),
        { who: 'worker', kind: 'finish', fromMs: finishStart, toMs: finishStart + finish, label: 'Aの終了対応' },
        { who: 'A', kind: 'finish', fromMs: finishStart, toMs: finishStart + finish },
      ],
      aDoneMs: finishStart + finish, bDoneMs: nowMs + travel + bWork, bProgressMs: bWork, idleMs: Math.max(0, autoEndMs - backAt), travelMs: travel * 2, aWaitMs: aWait,
    };
  };
  // 🚨 「間に合うか」の判断は **見込み(shift 前)** で。時間が外れた(shift)のは結果に効く(行ってから分かる)
  const fitsSafe = travel * 2 + candidate.workMs <= profile.autoRemainingMs - margin;
  const safe = helper('safe', fitsSafe);
  // 案3: 収まらなくても、Aを待たせて Bを進める(後で 納期・設備で採点)
  // 🚨 第三者(2026-09-23)⑤: 緊急ロットで「余裕を持って戻れるなら可」の時は、案3でも Aを待たせる案を通さない
  const urgentReturnable = urgent && urgentPolicy === 'returnable';
  const due = helper('due', !urgentReturnable || fitsSafe, urgentReturnable ? '緊急ロットは 余裕を持って戻れる時だけ(設定)。この組は戻れない' : null);

  const score = (p) => ({
    aDoneMs: p.aDoneMs, bDoneMs: p.bDoneMs,
    aDelayMs: p.aDoneMs - stay.aDoneMs, bGainMs: p.bDoneMs == null ? 0 : bWork,   // Bを進めた分(待機では 0)
    idleMs: p.idleMs, aWaitMs: p.aWaitMs, travelMs: p.travelMs,
    aLate: aDueMs == null ? null : p.aDoneMs > aDueMs,
    aLateDeltaMs: aDueMs == null ? null : Math.max(0, p.aDoneMs - aDueMs) - Math.max(0, stay.aDoneMs - aDueMs),
    equipDelayMs: equipNextStartMs == null ? null : Math.max(0, p.aDoneMs - equipNextStartMs) - Math.max(0, stay.aDoneMs - equipNextStartMs),
  });
  const plans = { stay: { ...stay, score: score(stay) }, safe: { ...safe, score: score(safe) }, due: { ...due, score: score(due) } };
  return { ok: true, missing: [], nowMs, autoEndMs, inputs: { autoRemainMs: autoRemain, bWorkMs: bWork, travelMin, returnMarginMin, shift: { autoDeltaMin: finite(shift.autoDeltaMin) || 0, bDeltaMin: finite(shift.bDeltaMin) || 0 } }, plans, summary: summaryLines(plans, { aDueMs, equipNextStartMs }) };
}

const min = (ms) => Math.round(ms / 60000);
/** 大きく出す答え(根拠つきの数字だけ)。 */
export function summaryLines(plans, { aDueMs = null, equipNextStartMs = null } = {}) {
  const out = [];
  for (const k of ['safe', 'due']) {
    const p = plans[k]; if (!p || p.sameAsStay) { out.push(`${PLAN_LABEL[k]}: 待機と同じ（${p ? p.why : '材料なし'}）`); continue; }
    const s = p.score;
    const parts = [`手待ち ${min(s.idleMs - plans.stay.score.idleMs)}分`, `Aは ${s.aDelayMs >= 0 ? '+' : ''}${min(s.aDelayMs)}分`, `Bは ${min(s.bGainMs)}分 進む`, `移動 ${min(s.travelMs)}分`];
    if (s.aWaitMs > 0) parts.push(`終了後の人待ち ${min(s.aWaitMs)}分`);
    if (aDueMs != null) parts.push(s.aLateDeltaMs > 0 ? `Aの納期超過 +${min(s.aLateDeltaMs)}分` : 'Aの納期超過は増えない');
    if (equipNextStartMs != null) parts.push(s.equipDelayMs > 0 ? `設備の次の仕事 +${min(s.equipDelayMs)}分` : '設備の次の仕事は遅れない');
    out.push(`${PLAN_LABEL[k]}: ${parts.join('／')}`);
  }
  return out;
}
