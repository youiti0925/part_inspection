// =============================================================================
//  operationsSimulation/lotPins.js — 手で決めた担当(ロットの固定)。2026-09-15。純関数だけ
// -----------------------------------------------------------------------------
//  清水さん「この納期のやつで見ていてこれを優先的にやりたいからこの画面で誰がするか変更したり、外したり」
//
//  置き場: settings.opsim.pins = [{ lotId, worker }]  ← **並び(配列)** で持つ。
//    表({lotId: worker})にすると merge:true で1件消しても消えない(2026-07-26 の是正と同じ形)。
//  意味: worker が名前 → その人にだけ渡す(その人がその工程の候補に居なければ渡らない＝能力は変えない)
//        worker が ''  → この期間は誰にも当てない(手で外した)
//        載っていない  → 自動(今までどおり)
//  🚨 ここは形を整えるだけ。門を掛けるのは simulate.js(tryAssign)ただ1本。
//  🚨 製品検査と最終検査で同じファイル(md5 一致)。片方だけ変えない。
// =============================================================================

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? '' : String(v).trim());

/** 画面の「自動(計算に任せる)」の印。settings には書かない(載せない＝自動)。 */
export const PIN_AUTO = '__auto';

/** 並び([{lotId, worker}]) → 表({lotId: worker})。壊れた行は捨てる。同じロットは後の物が勝つ。 */
export function pinsMapOf(list) {
  const out = {};
  const src = Array.isArray(list) ? list : (isObj(list) ? Object.entries(list).map(([lotId, worker]) => ({ lotId, worker })) : []);
  for (const row of src) {
    if (!isObj(row)) continue;
    const lotId = str(row.lotId);
    if (!lotId) continue;
    if (row.worker == null) continue;
    out[lotId] = str(row.worker);
  }
  return out;
}

/** 並びを1件だけ変えた **新しい並び**。value が PIN_AUTO なら外す(自動へ戻す)。 */
export function pinsListWith(list, lotId, value) {
  const id = str(lotId);
  const base = (Array.isArray(list) ? list : []).filter((row) => isObj(row) && str(row.lotId) && str(row.lotId) !== id)
    .map((row) => ({ lotId: str(row.lotId), worker: str(row.worker) }));
  if (!id || value === PIN_AUTO || value == null) return base;
  return [...base, { lotId: id, worker: str(value) }];
}

/**
 * エンジンへ渡す前に整える。
 * @param {*} raw  scenario.pins(表でも並びでも)
 * @param {object} o
 * @param {Set|Array|null} [o.lotIds]      計算に載っているロットの id。渡すと それ以外は捨てる
 * @param {Set|Array|null} [o.workerNames] 名簿の名前。渡すと 名簿に居ない名前は捨てる('' は残す)
 * @returns {{ pins: object, dropped: Array<{lotId:string, worker:string, why:string}> }}
 */
export function normalizePins(raw, { lotIds = null, workerNames = null } = {}) {
  const map = pinsMapOf(raw);
  const lots = lotIds == null ? null : new Set([...lotIds].map(str));
  const names = workerNames == null ? null : new Set([...workerNames].map(str));
  const pins = {};
  const dropped = [];
  for (const [lotId, worker] of Object.entries(map)) {
    if (lots && !lots.has(lotId)) { dropped.push({ lotId, worker, why: 'このロットは計算に載っていません' }); continue; }
    if (worker && names && !names.has(worker)) { dropped.push({ lotId, worker, why: `${worker} は名簿に居ません` }); continue; }
    pins[lotId] = worker;
  }
  return { pins, dropped };
}

/** 人が読む1文(画面の札)。 */
export function pinText(worker) {
  const w = str(worker);
  return w ? `${w} に固定` : 'この期間は誰にも当てない';
}
