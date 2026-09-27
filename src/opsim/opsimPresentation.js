// =============================================================================
//  src/opsim/opsimPresentation.js — 「遅れの見取り図」(RiskFlowBoard) の3列の分け方（純関数）
// -----------------------------------------------------------------------------
//  元: ChatGPT/Codex の枝 codex/opsim-visual-monthly-20260902 の src/domain/opsimPresentation.js。
//  2026-09-23 に合流。枝に在った「遅れて完了の日数を自分で数える関数」は **持ち込まない**（lateDone.js の rows を置くだけ）。
//
//  🚨 3列は「すでに超過／この先の見込み／判定が出せない を混ぜるな」(2026-08-22) と決まり10・15 の物:
//    これから遅れる … 見立て(lotResults)で 終わり > 納期線、かつ いまの時刻は納期線の手前
//    いま遅れている … いまの時刻が納期線を越えている（決まり15 の ① 納期を過ぎた。
//                     計算の上ではもう終わった物 ② も、いまの時刻が線を越えていればここ。数は別に持つ）
//    遅れて完了     … Firestore の completedAt から(lateDone.js)。**渡された rows をそのまま置く**。
//  🚨 2026-09-24「同じ物に2つの数を出さない」: 結論の帯の「この先で遅れる」は late===true かつ まだ納期線の手前
//     (製品 opsim/Header.jsx・最終 workers/operationsSimulationFI.worker.js)。ここも同じ集まりにする。
//     エンジンが「納期線は期間の中・この期間の中では終わらない」で late=true / finishMs=null にした物は
//     **確かに遅れる** ので「これから遅れる」の列に入れる(finishBeyondHorizon:true)。量(lateMs・日数)は null のまま。
//     simulate.js が禁じた「期間の終わり − 納期線」を数にしない。控え(2026-09-24_0930)で 最終 54 vs 30・製品 17 vs 6 が割れていた。
//     残る unknownCount は「判定がつかない」(judgeable=false)だけ。そのうち納期の記録が無い物を unknownNoDueCount に分ける。
//  🚨 「+N日」の式は lateDone.js の lateDays ただ1本（製品 lateForecast.daysPastDueLine／
//     最終 lateForecast.daysLateAt と同じ呼び方）。ここで2本目を書かない。
//  🚨 型式に添える文字の元は 製品=tplNameOf(domain/workerPlan.js)／最終=specialByLotOf(opsimfi/assignView.js)。
//     ここは呼び手から subOf を受けて **札を付けるだけ**（枝の workLabelOf は templateId で判定していたが、
//     表示の元は tplNameOf/specialByLotOf に一本化する）。
//  🚨 Date.now は呼ばない。製品・最終で同じ中身(md5 の対)。
// =============================================================================
import { lateDays, dueEndMsOf } from '../domain/operationsSimulation/lateDone.js';

const clean = (value) => (value == null ? '' : String(value).trim());
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const lotIdOf = (x) => clean(x && (x.lotId ?? x.id ?? x.__id));

/** その時刻(ms)の日の 0:00（端末の時間帯）。lateForecast.js の startOfDayMs と同じ。 */
export const startOfDayMs = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/**
 * 時刻 t で納期線を過ぎているか。「線ちょうど」は過ぎていない（dueLineMs < t）。
 * simulate.js の lot.late（atMs > dueLineMs）と同じ向き。
 */
export const isPastDueLineAt = (dueLineMs, t) => finite(t) != null && finite(dueLineMs) != null && dueLineMs < t;

/**
 * 時刻 t での「+N日」。納期の日の終わりを越えた日数（lateDays ただ1本）。当日中なら null（＝「今日」）。
 */
export const daysPastDueLineAt = (t, dueLineMs) => (
  (finite(t) != null && finite(dueLineMs) != null) ? lateDays(t, dueEndMsOf(startOfDayMs(dueLineMs))) : null
);

/**
 * 型式に添える札。🚨 表示の元(テンプレ名／特注仕様)は呼び手の subOf が決める。
 *   製品検査: subOf = (x) => tplNameOf(templatesById, x.templateId), subName = 'テンプレ'
 *   最終検査: subOf = (x) => x.special || specialOf(subByLot, x.lotId), subName = '特注仕様'
 *   （枝では templateId === 'final_inspection_std' で「特注仕様：…」に分けていた。最終検査は subName で同じ札になる）
 * subOf が無い時は行の tplName／special を読む（lateDone の rows はこの形）。
 * @returns {string} 例「テンプレ：標準検査」「特注仕様：外観A」「テンプレの記録なし」
 */
export function workLabelOf(x, { subOf = null, subName = 'テンプレ' } = {}) {
  const sub = clean(typeof subOf === 'function' ? subOf(x) : (x && (x.tplName ?? x.special)));
  const name = clean(subName) || 'テンプレ';
  return sub ? `${name}：${sub}` : `${name}の記録なし`;
}

const modelOf = (x) => clean(x && x.model) || '(型式なし)';

/**
 * 3列に分ける。
 * @param {object} p
 * @param {Array}  p.lotResults   simulate.js の lotResults（lotId / dueLineMs / finishMs / lateMs / late / judgeable）
 * @param {Array}  p.lots         normalized.lots（lotId / model / orderNo / templateId / special）
 * @param {Array}  p.lateDoneRows lateDone.buildLateDone の rows（lotId / model / orderNo / dueEndMs / completedMs / daysLate）
 * @param {number} p.nowMs        いまの時刻（つまみの時刻）
 * @param {Function} [p.subOf]    型式に添える文字の引き方（上の workLabelOf を見よ）
 * @param {string}   [p.subName]  札の名前（'テンプレ' / '特注仕様'）
 * @returns {{future:Array, current:Array, completed:Array, safeCount:number, unknownCount:number, unknownNoDueCount:number,
 *   currentFinishedCount:number, futureBeyondHorizonCount:number}}
 *   🚨 safeCount / unknownCount は「列に出していない物」を白状する為の数。消さない。
 *   unknownNoDueCount … unknownCount のうち 納期の記録が無い物(残りは 入力が足りず判定がつかない物)。
 *   futureBeyondHorizonCount … future のうち 期間の中で終わらない物(行は finishBeyondHorizon:true・量は null)。
 */
export function buildDelayLanes({
  lotResults = [], lots = [], lateDoneRows = [], nowMs = null, subOf = null, subName = 'テンプレ',
} = {}) {
  const lotById = new Map();
  (Array.isArray(lots) ? lots : []).forEach((lot) => { const id = lotIdOf(lot); if (id && !lotById.has(id)) lotById.set(id, lot); });
  const now = finite(nowMs);
  const future = [];
  const current = [];
  let safeCount = 0;
  let unknownCount = 0;
  let unknownNoDueCount = 0;
  let currentFinishedCount = 0;
  let futureBeyondHorizonCount = 0;

  (Array.isArray(lotResults) ? lotResults : []).forEach((result) => {
    const lotId = lotIdOf(result);
    if (!lotId) return;
    const lot = lotById.get(lotId) || {};
    const dueMs = finite(result.dueLineMs) ?? finite(lot.dueLineMs);
    const finishMs = finite(result.finishMs);
    const row = {
      lotId,
      model: modelOf(lot),
      orderNo: clean(lot.orderNo),
      workLabel: workLabelOf({ ...lot, lotId }, { subOf, subName }),
      dueMs,
      finishMs,
      lateMs: finite(result.lateMs),
      daysLate: null,
      finishedInCalc: false,
      finishBeyondHorizon: false,
    };
    if (isPastDueLineAt(dueMs, now)) {
      // ① いま遅れている。棒の長さは いま − 納期線、+N日 は lateDays ただ1本。
      const finished = finishMs != null && finishMs <= now;
      if (finished) currentFinishedCount += 1;
      current.push({ ...row, lateMs: now - dueMs, daysLate: daysPastDueLineAt(now, dueMs), finishedInCalc: finished });
    } else if (result.judgeable === false) {
      unknownCount += 1;
      if (dueMs == null) unknownNoDueCount += 1;
    } else if (result.late === true && dueMs != null && finishMs != null) {
      future.push({ ...row, daysLate: daysPastDueLineAt(finishMs, dueMs) });
    } else if (result.late === true && dueMs != null) {
      // 納期線は期間の中・この期間の中では終わらない＝確かに遅れる(simulate.js)。結論の帯と同じく「これから遅れる」へ。
      // 🚨 量は出さない(lateMs・daysLate は null)。「期間の終わり − 納期線」を作らない。
      futureBeyondHorizonCount += 1;
      future.push({ ...row, lateMs: null, daysLate: null, finishBeyondHorizon: true });
    } else if (result.late === true) {
      // 遅れると言っているのに 納期線が無い(エンジンは出さない形)。列には出さず数に残す。
      unknownCount += 1;
      unknownNoDueCount += 1;
    } else {
      safeCount += 1;
    }
  });

  // 期間の中で終わらない物(量が出ない＝一番重い側)を先頭に。「ほか N件」の奥に隠さない。
  const sorter = (a, b) => Number(b.finishBeyondHorizon === true) - Number(a.finishBeyondHorizon === true)
    || (b.lateMs ?? -1) - (a.lateMs ?? -1)
    || (a.dueMs ?? Infinity) - (b.dueMs ?? Infinity)
    || a.lotId.localeCompare(b.lotId);
  future.sort(sorter);
  current.sort(sorter);

  // ③ 遅れて完了。🚨 日数は row.daysLate をそのまま運ぶ（lateDone.js が出した値。ここで数え直さない）。
  const completed = (Array.isArray(lateDoneRows) ? lateDoneRows : [])
    .filter((r) => r && lotIdOf(r))
    .map((r) => {
      const dueEndMs = finite(r.dueEndMs);
      const completedMs = finite(r.completedMs);
      return {
        lotId: lotIdOf(r),
        model: modelOf(r),
        orderNo: clean(r.orderNo),
        workLabel: workLabelOf(r, { subOf, subName }),
        dueMs: dueEndMs,
        finishMs: completedMs,
        lateMs: (dueEndMs != null && completedMs != null) ? Math.max(0, completedMs - dueEndMs) : null,
        daysLate: finite(r.daysLate),
        finishedInCalc: false,
        finishBeyondHorizon: false,
      };
    });

  return {
    future, current, completed, safeCount, unknownCount, unknownNoDueCount, currentFinishedCount, futureBeyondHorizonCount,
  };
}

export default { workLabelOf, buildDelayLanes, isPastDueLineAt, daysPastDueLineAt, startOfDayMs };
