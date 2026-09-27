// =============================================================================
//  src/domain/operationsSimulation/lateForecast.js — 盤の右の棚の「納期を過ぎた」と「遅れて終わる見込み」（純関数）
// -----------------------------------------------------------------------------
//  🚨 決まり15（2026-09-04 清水さん「納期遅れたらずっと右側で表示残して、どれだけ遅れているか・
//     どれだけ遅れて処理したかを表示」）。
//  確かめ役の実測（2026-09-04）: 時間を ＋2時間 進めると、納期を過ぎたまま **計算の上で終わった** ロット
//  （RT-106,H +30日）が右の棚から消え、「遅れて完了 46件」は46のまま＝画面のどこにも無くなっていた。
//  根: simulate.js の snapshot は片付いたロットを乗せない（指示書6.3・正しい）。盤はその snapshot だけを
//  見ていたので、終わった瞬間に「遅れていた事実」ごと消えていた。
//
//  🚨 右の棚は **3つの棚・3つの数**（1つに混ぜない。2026-08-22「すでに超過／この先の見込み／判定できない を混ぜるな」）:
//    ① 納期を過ぎた（まだ終わっていない）… snapshot.lots のうち 納期線 < いまの時刻。          → isPastDueAt
//    ② 遅れて終わる見込み（計算）        … lotResults のうち 終わり ≤ いまの時刻 かつ 納期線 < 終わり。 → buildLateForecast
//    ③ 遅れて完了（記録）                … Firestore の completedAt から（lateDone.js）。ここでは触らない。
//  時間を進めると ① の物が ② へ移るだけなので、①＋② は減らない（試験 late-forecast.test.mjs で見張る）。
//
//  🚨 +N日 の式は lateDone.js の lateDays ただ1本（③と同じ数え方）。納期線(17:00 等)は
//     納期の日の終わりへ直してから数える＝同じロットが完了した時に数字が変わらない。当日のうちは null（「今日」）。
//  🚨 ここは数えるだけ。見せ方（棚の色・札）は src/opsim/Board.jsx が持つ。Date.now は呼ばない。
// =============================================================================
import { lateDays, dueEndMsOf } from './lateDone.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** その時刻(ms)の日の 0:00（端末の時間帯）。Board.jsx の startOfDay と同じ。 */
export const startOfDayMs = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/**
 * 時刻 t で納期線を過ぎているか。盤の「納期を過ぎた」(①) の条件 **ただ1本**。
 * ⚠ 「線ちょうど」は過ぎていない（dueLineMs < t）。simulate.js の lot.late（atMs > dueLineMs）と同じ向き。
 */
export const isPastDueAt = (dueLineMs, t) => isNum(t) && isNum(dueLineMs) && dueLineMs < t;

/**
 * 時刻 t での「+N日」。納期の日の終わりを越えた日数（lateDays ただ1本）。当日中なら null（＝「今日」）。
 * @param {number} t          いまの時刻／終わった時刻(ms)
 * @param {number} dueLineMs  納期線(ms・納期の日の中の時刻)
 */
export const daysPastDueLine = (t, dueLineMs) => (
  (isNum(t) && isNum(dueLineMs)) ? lateDays(t, dueEndMsOf(startOfDayMs(dueLineMs))) : null
);

/**
 * ② 遅れて終わる見込み。見立て(result.base.lotResults)のうち、いまの時刻 atMs までに終わっていて、
 * 終わりが納期線より後の物。
 * 🚨 まだ終わっていない物（finishMs が atMs より後／出ていない）は入れない。それは ①（snapshot 側）の持ち分。
 * 🚨 counts は「数えていない物」を白状する為の物。rows.length と別に必ず持つ。
 * @param {object} p
 * @param {Array}  p.lotResults  simulate.js の lotResults（{lotId, finishMs, dueLineMs, ...}）
 * @param {number} p.atMs        いまの時刻(ms・つまみの時刻)
 * @returns {{rows:Array<{lotId:string, finishMs:number, dueLineMs:number, daysLate:number|null}>,
 *            counts:{results:number, finishMissing:number, notYetFinished:number, dueMissing:number, onTime:number, late:number}}}
 */
export function buildLateForecast({ lotResults = [], atMs = null } = {}) {
  const counts = { results: 0, finishMissing: 0, notYetFinished: 0, dueMissing: 0, onTime: 0, late: 0 };
  const rows = [];
  if (!isNum(atMs)) return { rows, counts };
  for (const r of (Array.isArray(lotResults) ? lotResults : [])) {
    if (!r || r.lotId == null) continue;
    counts.results += 1;
    if (!isNum(r.finishMs)) { counts.finishMissing += 1; continue; }
    if (r.finishMs > atMs) { counts.notYetFinished += 1; continue; }
    if (!isNum(r.dueLineMs)) { counts.dueMissing += 1; continue; }
    if (!isPastDueAt(r.dueLineMs, r.finishMs)) { counts.onTime += 1; continue; }
    counts.late += 1;
    rows.push({
      lotId: String(r.lotId),
      finishMs: r.finishMs,
      dueLineMs: r.dueLineMs,
      daysLate: daysPastDueLine(r.finishMs, r.dueLineMs),
    });
  }
  // 並びは ① と同じ「納期が古い順」（時間を進めても入れ替わらない）。
  rows.sort((a, b) => (a.dueLineMs - b.dueLineMs) || a.lotId.localeCompare(b.lotId));
  return { rows, counts };
}

/**
 * 試験用の数え方（盤と同じ条件で ①・② を数える）。
 * ⚠ 盤(Board.jsx)は ① を lotFactsOf の中で isPastDueAt で数え、② を buildLateForecast で数える。ここはその2つを呼ぶだけ。
 * @returns {{pastDue:string[], forecast:string[], sum:number}}
 */
export function overdueShelfIdsAt({ snapshotLots = [], lotResults = [], atMs = null } = {}) {
  const pastDue = (Array.isArray(snapshotLots) ? snapshotLots : [])
    .filter((l) => l && l.lotId && isPastDueAt(l.dueLineMs, atMs))
    .map((l) => String(l.lotId));
  const forecast = buildLateForecast({ lotResults, atMs }).rows.map((r) => r.lotId);
  return { pastDue, forecast, sum: pastDue.length + forecast.length };
}

export default buildLateForecast;
