// =============================================================================
//  operationsSimulation/dueListOrder.js — 納期一覧の並べ方(純関数)。2026-09-15
// -----------------------------------------------------------------------------
//  清水さん「納期が遅いやつが上に来てるけど、この辺納期順とか並べ替えもカスタマイズできるようにした方がいい」
//
//  🚨 ここは **並べるだけ**。数(遅れ・納期・終わる時刻)は1つも作らない。行は DueCalendar が
//     dueRowFacts で作った物をそのまま受ける。
//  🚨 同点は 指図 → ロットid で固定する(描画のたびに入れ替わらない)。
//  🚨 読めない鍵は「危ない順」(今までの並び)に倒す。分からない物(null)は必ず最後。
//  🚨 製品検査と最終検査で同じファイル(md5 一致)。片方だけ変えない。
// =============================================================================

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v) => (v == null ? '' : String(v).trim());

export const DUE_SORT = Object.freeze({
  RISK: 'risk',      // 危ない順(すでに過ぎた → この先で遅れる → 判定できません → 間に合う。中は納期の早い順)
  DUE: 'due',        // 納期の早い順
  FINISH: 'finish',  // 終わる順(終わる時刻の早い順)
  LATE: 'late',      // 遅れの大きい順(日数)
  WORKER: 'worker',  // 担当ごと(五十音。未定は最後)
  MODEL: 'model',    // 型式ごと
  ORDER: 'order',    // 指図順
});

export const DUE_SORT_KEYS = Object.freeze([
  DUE_SORT.RISK, DUE_SORT.DUE, DUE_SORT.FINISH, DUE_SORT.LATE, DUE_SORT.WORKER, DUE_SORT.MODEL, DUE_SORT.ORDER,
]);

/** 札の字。🚨 画面はここから取る(手で書かない)。 */
export const DUE_SORT_LABEL = Object.freeze({
  [DUE_SORT.RISK]: '危ない順',
  [DUE_SORT.DUE]: '納期の早い順',
  [DUE_SORT.FINISH]: '終わる順',
  [DUE_SORT.LATE]: '遅れの大きい順',
  [DUE_SORT.WORKER]: '担当ごと',
  [DUE_SORT.MODEL]: '型式ごと',
  [DUE_SORT.ORDER]: '指図順',
});

/** 「あと◯件を開く」の但し書き。 */
export const dueSortHint = (key) => `${DUE_SORT_LABEL[normalizeDueSort(key)]}に上から出しています`;

export const normalizeDueSort = (v) => (DUE_SORT_KEYS.includes(str(v)) ? str(v) : DUE_SORT.RISK);

// ── 比べ方 ────────────────────────────────────────────────────────────────────
const numAsc = (a, b) => {
  const x = isNum(a) ? a : null; const y = isNum(b) ? b : null;
  if (x == null && y == null) return 0;
  if (x == null) return 1;   // 分からない物は最後
  if (y == null) return -1;
  return x - y;
};
const numDesc = (a, b) => {
  const x = isNum(a) ? a : null; const y = isNum(b) ? b : null;
  if (x == null && y == null) return 0;
  if (x == null) return 1;
  if (y == null) return -1;
  return y - x;
};
const jaAsc = (a, b) => str(a).localeCompare(str(b), 'ja');
/** 担当: 空(未定)は最後。 */
const workerAsc = (a, b) => {
  const x = str(a); const y = str(b);
  if (!x && !y) return 0;
  if (!x) return 1;
  if (!y) return -1;
  return x.localeCompare(y, 'ja');
};
/** 遅れの大きさ: すでに過ぎた日数と この先の遅れ日数を **同じ物差しで比べない**。段が先、日数は段の中だけ。 */
const lateRank = (r) => (isNum(r.pastDays) ? r.pastDays : (isNum(r.lateDays) ? r.lateDays : null));
const tie = (a, b) => jaAsc(a.orderNo, b.orderNo) || jaAsc(a.lotId, b.lotId);

const CMP = Object.freeze({
  [DUE_SORT.RISK]: (a, b) => numAsc(a.tier, b.tier) || numAsc(a.dueMs, b.dueMs) || jaAsc(a.model, b.model) || tie(a, b),
  [DUE_SORT.DUE]: (a, b) => numAsc(a.dueMs, b.dueMs) || numAsc(a.tier, b.tier) || tie(a, b),
  [DUE_SORT.FINISH]: (a, b) => numAsc(a.finishMs, b.finishMs) || numAsc(a.dueMs, b.dueMs) || tie(a, b),
  [DUE_SORT.LATE]: (a, b) => numAsc(a.tier, b.tier) || numDesc(lateRank(a), lateRank(b)) || numAsc(a.dueMs, b.dueMs) || tie(a, b),
  [DUE_SORT.WORKER]: (a, b) => workerAsc(a.worker, b.worker) || numAsc(a.dueMs, b.dueMs) || tie(a, b),
  [DUE_SORT.MODEL]: (a, b) => jaAsc(a.model, b.model) || numAsc(a.dueMs, b.dueMs) || tie(a, b),
  [DUE_SORT.ORDER]: (a, b) => jaAsc(a.orderNo, b.orderNo) || numAsc(a.dueMs, b.dueMs) || jaAsc(a.lotId, b.lotId),
});

/**
 * @param {Array} rows  DueCalendar の行({ lotId, orderNo, model, worker, tier, dueMs, finishMs, lateDays, pastDays })
 * @param {string} key  DUE_SORT の鍵。読めなければ 'risk'
 * @returns {Array} 新しい並び(元の配列は触らない)
 */
export function sortDueRows(rows, key = DUE_SORT.RISK) {
  const cmp = CMP[normalizeDueSort(key)];
  return (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === 'object').slice().sort(cmp);
}
