// =============================================================================
//  src/opsim/lotSwitchWhy.js — 「なぜ次のロットへ？」の札の材料(純関数)
// -----------------------------------------------------------------------------
//  清水さん(2026-09-10 23:30 人ごとの指示の写真2枚を見て):
//    「なんでこんなぐちゃぐちゃの仕事になるの？これならロット処理して次のロットでいいでしょ」
//
//  🚨 理由の文は **計算(simulate)が lotResults[].lotSwitches[].why へ残した物そのまま**。
//    ここでは1文字も作らない・言い換えない(渡ってこなければ札を出さない)。
//  🚨 ここは純関数だけ(node --test でそのまま回す)。React を入れない。
//
//  ■ lotSwitches の形(scenario の鍵の約束・2026-09-10 まとめ役)
//    lotResults[].lotSwitches = [{ atMs, worker, fromLotId, toLotId, why }]
//    0件なら鍵ごと無い。
//  ■ 人・日順の行(buildPersonDayRows の items)への当てはめ方
//    その人(worker)が **そのロット(fromLotId)を離れた** 時刻 atMs が、その行(ロット×人×日)の
//    始まり〜終わりの中に在れば、その行の下に出す。1つの行で2回以上離れていれば全部出す(時刻順)。
// =============================================================================

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v) => (v == null ? '' : String(v));

/**
 * lotResults(またはその値の一覧)から lotSwitches を1本に集める。
 * 🚨 why が空の物・時刻が数でない物は捨てる(もっともらしい札を作らない)。
 * @param {Iterable<object>|null} lotResults
 * @returns {Array<{atMs:number, worker:string, fromLotId:string, toLotId:string, why:string}>}
 */
export function collectLotSwitches(lotResults) {
  const out = [];
  if (!lotResults || typeof lotResults[Symbol.iterator] !== 'function') return out;
  for (const r of lotResults) {
    const list = r && Array.isArray(r.lotSwitches) ? r.lotSwitches : null;
    if (!list) continue;
    for (const s of list) {
      if (!s || !isNum(Number(s.atMs))) continue;
      const why = str(s.why).trim();
      if (!why) continue;
      out.push({
        atMs: Number(s.atMs),
        worker: str(s.worker),
        fromLotId: str(s.fromLotId),
        toLotId: str(s.toLotId),
        why,
      });
    }
  }
  out.sort((a, b) => a.atMs - b.atMs);
  return out;
}

/**
 * 1行(ロット×人×日)に当てはまる「離れた理由」。無ければ **空配列**(札を出さない)。
 * @param {Array} switches collectLotSwitches の戻り
 * @param {object} row { worker, lotId, startMs, endMs }
 * @param {number} [tolMs] 行の端の許し(既定 1分。丸めで端が1ミリ秒ずれても落とさない)
 * @returns {Array<{atMs:number, toLotId:string, why:string}>}
 */
export function switchesOfRow(switches, row, tolMs = 60000) {
  if (!Array.isArray(switches) || !switches.length || !row) return [];
  const worker = str(row.worker);
  const lotId = str(row.lotId);
  const s0 = Number(row.startMs); const e0 = Number(row.endMs);
  if (!worker || !lotId || !isNum(s0) || !isNum(e0)) return [];
  return switches
    .filter((s) => s.worker === worker && s.fromLotId === lotId && s.atMs >= s0 - tolMs && s.atMs <= e0 + tolMs)
    .map((s) => ({ atMs: s.atMs, toLotId: s.toLotId, why: s.why }));
}

/** 札の見出し。⚠ 中身(why)はこの後ろに計算の文をそのまま置く。 */
export const LOT_SWITCH_WHY_HEAD = 'なぜ次のロットへ？';
