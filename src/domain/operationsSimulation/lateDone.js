// =============================================================================
//  src/domain/operationsSimulation/lateDone.js — 「納期に遅れて完了した」ロットを数える（純関数）
// -----------------------------------------------------------------------------
//  🚨 決まり10（2026-09-02 清水さん）: 遅れた後に完了しても「一回納期に遅れた事実」を消さない。
//     いままでは OperationsSimulationPanel.jsx が status==='completed' を計算から逃がし、
//     盤からも納期一覧からも消えていた。
//  🚨 式は **src/App.jsx（納期の分析）と同じ1本**。新しい式を作らない。
//       dd       = 納期の日の **終わり**（0:00 + 1日 − 1ms）
//       daysLate = ceil((completedAt − dd) / 1日)      … completedAt > dd の物だけ
//     ⚠ 納期の日の 0:00 を境に数えると、当日に完了した物まで +1日 になる（2026-09-02 実測 53件 vs 45件）。
//  🚨 納期の読み方は dueDefense.dueMsOfLot ただ1本（App.jsx の parseDueParts と同じ規則＋Date.parse 救済）。
//     `Mon Jun 08 2026 …` 形式の納期 25件はこの救済で読める。
//  🚨 ここは数えるだけ。見せ方（盤の棚・納期一覧の下段）は src/opsim/ が持つ。
// =============================================================================
import { dueMsOfLot } from '../dueDefense.js';

const MS_DAY = 86400000;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** completedAt を ms に。数値／Firestore Timestamp／文字列 を受ける。読めなければ null。 */
export function completedMsOf(lot) {
  const raw = lot && lot.completedAt;
  if (raw == null || raw === '') return null;
  if (isNum(raw)) return raw;
  if (typeof raw === 'object') {
    if (typeof raw.toMillis === 'function') { const t = raw.toMillis(); return isNum(t) ? t : null; }
    if (isNum(raw.seconds)) return raw.seconds * 1000 + Math.round((raw.nanoseconds || 0) / 1e6);
    return null;
  }
  const t = Date.parse(String(raw));
  return Number.isNaN(t) ? null : t;
}

export const isCompletedLot = (lot) => !!lot && (lot.status === 'completed' || lot.location === 'completed');

/** 納期線 = 納期の日の終わり(23:59:59.999)。App.jsx:27012 の `dd = _dm + 86400000 - 1` と同じ。 */
export const dueEndMsOf = (dueDayMs) => (isNum(dueDayMs) ? dueDayMs + MS_DAY - 1 : null);

/**
 * 遅れた日数。App.jsx(納期分析)の `Math.ceil((cm - dd) / 86400000)` と **同じ式**。
 * 🚨 App.jsx もこれを呼ぶ(2026-09-02 決まり10「新しい式を作らない」)。ここを変えると両方が同時に変わる。
 * 納期線までに終わっていれば(cm <= dd) null ＝ 遅れていない。
 * @param {number} completedMs 完了時刻(ms)
 * @param {number} dueEndMs    納期線(納期の日の終わり, ms)
 * @returns {number|null}
 */
export const lateDays = (completedMs, dueEndMs) => {
  if (!isNum(completedMs) || !isNum(dueEndMs)) return null;
  if (completedMs <= dueEndMs) return null;
  return Math.ceil((completedMs - dueEndMs) / MS_DAY);
};

/**
 * 1件ぶん。完了していて、納期と完了時刻が読めて、納期の日の終わりを越えていれば返す。
 * @returns {{lotId, orderNo, model, templateId, quantity, dueMs, dueEndMs, completedMs, daysLate}|null}
 */
export function lateDoneOf(lot) {
  if (!isCompletedLot(lot)) return null;
  const dueMs = dueMsOfLot(lot);
  const cm = completedMsOf(lot);
  if (!isNum(dueMs) || !isNum(cm)) return null;
  const dueEndMs = dueEndMsOf(dueMs);            // App.jsx と同じ: 納期の日の終わり
  const daysLate = lateDays(cm, dueEndMs);       // 🚨 式は lateDays ただ1本
  if (daysLate == null) return null;             // 間に合った
  const lotId = String((lot.id ?? lot.__id ?? lot.lotId) || '');
  return {
    lotId,
    orderNo: lot.orderNo == null ? '' : String(lot.orderNo),
    model: typeof lot.model === 'string' ? lot.model.trim() : '',
    templateId: lot.templateId == null ? '' : String(lot.templateId),
    quantity: Math.max(1, Math.trunc(Number(lot.quantity)) || 1),
    dueMs,
    dueEndMs,
    completedMs: cm,
    daysLate,
  };
}

/**
 * 一覧。遅れが大きい順（同じなら完了が新しい順）。
 * @param {object} p
 * @param {Array}  p.lots     生のロット（Firestore の形のまま）
 * @param {number} [p.fromMs] 完了時刻の下限（これより前の完了は数えない）。null なら全期間
 * @param {number} [p.toMs]   完了時刻の上限。null なら無制限
 * @returns {{rows:Array, counts:{completed:number, dueMissing:number, completedAtMissing:number, onTime:number, late:number, outsideWindow:number}}}
 *   🚨 counts は「数えていない物」を白状する為の物。rows.length と別に必ず持つ。
 */
export function buildLateDone({ lots = [], fromMs = null, toMs = null } = {}) {
  const counts = { completed: 0, dueMissing: 0, completedAtMissing: 0, onTime: 0, late: 0, outsideWindow: 0 };
  const rows = [];
  for (const lot of (Array.isArray(lots) ? lots : [])) {
    if (!isCompletedLot(lot)) continue;
    counts.completed += 1;
    const dueMs = dueMsOfLot(lot);
    const cm = completedMsOf(lot);
    if (!isNum(dueMs)) { counts.dueMissing += 1; continue; }
    if (!isNum(cm)) { counts.completedAtMissing += 1; continue; }
    const row = lateDoneOf(lot);
    if (!row) { counts.onTime += 1; continue; }
    if ((isNum(fromMs) && cm < fromMs) || (isNum(toMs) && cm > toMs)) { counts.outsideWindow += 1; continue; }
    counts.late += 1;
    rows.push(row);
  }
  rows.sort((a, b) => (b.daysLate - a.daysLate) || (b.completedMs - a.completedMs) || a.lotId.localeCompare(b.lotId));
  return { rows, counts };
}

export default buildLateDone;
