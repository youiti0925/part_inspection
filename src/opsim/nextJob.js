// =============================================================================
//  src/opsim/nextJob.js — 「その人の次の仕事」を1か所で決める
// -----------------------------------------------------------------------------
//  🚨 中身は src/opsim/Side.jsx にあった nextJobOf **そのまま**（規則を変えていない）。
//     Board（盤の作業者の帯）と Side（右の一覧）の2か所から読むので、外へ出しただけ。
//     2本に増やすと片方だけ直して食い違う。
// =============================================================================
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * その人の **次の仕事** と、いまの仕事との間の空き（T024 即時再割当）。
 * 🚨 assignments が渡されなければ null。**0分と書かない**（測っていないのに「0分」は嘘）。
 * @param {Array} assignments simulate の result.base.assignments
 *                （{ jobId, lotId, worker, startMs, endMs, evidence, reason }・simulate.js:745-754）
 * @param {string} name  作業者名
 * @param {number} afterMs いまの仕事が終わる時刻
 */
export function nextJobOf(assignments, name, afterMs) {
  if (!Array.isArray(assignments) || !name || !isNum(afterMs)) return null;
  let best = null;
  for (const a of assignments) {
    if (!a || a.worker !== name) continue;
    const st = Number(a.startMs);
    if (!Number.isFinite(st) || st < afterMs) continue;
    if (best == null || st < best.startMs) best = a;
  }
  if (!best) return null;
  return { ...best, gapMs: Number(best.startMs) - afterMs };
}

export default nextJobOf;
