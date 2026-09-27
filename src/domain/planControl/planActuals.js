// =============================================================================
// 📊 保存した計画と 実際の開始・停止・完了 を重ねる(2026-09-22)。
// -----------------------------------------------------------------------------
// 🚨 実績は既存の記録(lot.tasks[key].firstStartTime / endTime / sessions / status・lot.pauseReason)だけ。
//   二重入力させない。記録が無ければ「未記録」。差が出た理由を時刻の差から作らない(停止理由は記録の物だけ)。
//   遅れて完了した仕事は消さない(遅れて完了 として残す)。
// 区別: 未着手(記録なし・計画の時刻はまだ) / 作業中 / 完了 / 遅れて完了(納期後に完了)
//       / 未記録(計画の終了時刻を過ぎたのに記録が無い) / 計画外(計画の期間内に記録は在るが計画に無い)
// 🚨 lot.tasks がまだ無いロットは「未着手」(記録が無いのは普通)。「未記録」は 時刻が過ぎてから言う。
//
// 🚨 純関数だけ。firebase も React も import しない。
// =============================================================================
import { compareActuals } from './planControl.js';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
const isDone = (t) => isObj(t) && ['completed', 'done', 'finished', 'skipped', 'na'].includes(String(t.status || '').toLowerCase());

/** 計画の工程に対応する lot.tasks の鍵(liveStates と同じ決まり)。 */
function lotTaskKeysOf(task, lot) {
  const stepIndex = lot?.steps?.findIndex((s) => String(s.id) === task.stepId) ?? -1;
  if (!lot || stepIndex < 0 || !isObj(lot.tasks)) return [];
  if (task.unitIndex === null) return Object.keys(lot.tasks).filter((k) => k.startsWith(`${task.stepId}-lot-`));
  return [`${task.stepId}-${task.unitIndex}`, `${stepIndex}-${task.unitIndex}`];
}

/** 1つの記録から 開始・終了。 */
function spanOf(t) {
  if (!isObj(t)) return { startMs: null, endMs: null, done: false, running: false };
  const sessions = Array.isArray(t.sessions) ? t.sessions.filter((s) => isObj(s) && num(s.startTime) != null) : [];
  const starts = [num(t.firstStartTime), ...sessions.map((s) => num(s.startTime))].filter((x) => x != null);
  const ends = [num(t.endTime), ...sessions.map((s) => num(s.endTime))].filter((x) => x != null);
  const running = String(t.status || '') === 'processing' || sessions.some((s) => num(s.startTime) != null && num(s.endTime) == null);
  const done = isDone(t);
  return { startMs: starts.length ? Math.min(...starts) : null, endMs: done && ends.length ? Math.max(...ends) : null, done, running };
}

/**
 * 計画の工程ごとに 実績を lots から拾う。
 * @returns { actuals:[{key,startMs,endMs,cause}], stateByKey:{key:'unstarted'|'running'|'completed'|'unrecorded'}, unplanned:[{lotId, taskKey}] }
 */
export function actualsFromLots(plan, lots, nowMs = null) {
  const byId = new Map((Array.isArray(lots) ? lots : []).map((l) => [String(l.id), l]));
  const actuals = [], stateByKey = {};
  const seen = new Map(); // lotId -> Set(lot.tasks の鍵)
  for (const task of (plan && plan.tasks) || []) {
    const lot = byId.get(String(task.lotId));
    const keys = lotTaskKeysOf(task, lot);
    const found = keys.map((k) => lot.tasks[k]).filter(Boolean);
    if (!seen.has(task.lotId)) seen.set(task.lotId, new Set());
    keys.forEach((k) => seen.get(task.lotId).add(k));
    const overdue = Number.isFinite(nowMs) && task.assignment && Number.isFinite(task.assignment.endMs) && task.assignment.endMs < nowMs;
    if (!lot) { stateByKey[task.key] = 'unrecorded'; continue; }           // ロットそのものが無い = 読めない
    if (!isObj(lot.tasks) || keys.length === 0) { stateByKey[task.key] = overdue ? 'unrecorded' : 'unstarted'; continue; }
    const spans = found.map(spanOf);
    const startMs = spans.map((s) => s.startMs).filter((x) => x != null);
    const allDone = found.length > 0 && spans.every((s) => s.done);
    const endMs = allDone ? spans.map((s) => s.endMs).filter((x) => x != null) : [];
    const cause = lot && isObj(lot.pauseReason) && typeof lot.pauseReason.category === 'string' && lot.pauseReason.category ? lot.pauseReason.category : null;
    if (found.length === 0 || (startMs.length === 0 && !allDone)) { stateByKey[task.key] = overdue ? 'unrecorded' : 'unstarted'; continue; }
    stateByKey[task.key] = allDone ? 'completed' : (spans.some((s) => s.running) ? 'running' : 'unstarted');
    actuals.push({ key: task.key, startMs: startMs.length ? Math.min(...startMs) : null, endMs: endMs.length ? Math.max(...endMs) : null, cause });
  }
  // 計画外: 計画の対象ロットの中で、計画の期間内に記録(開始)が在るのに計画に無い工程
  const unplanned = [];
  const from = plan && plan.context ? num(plan.context.fromMs) : null, to = plan && plan.context ? num(plan.context.toMs) : null;
  for (const [lotId, keys] of seen) {
    const lot = byId.get(String(lotId));
    if (!lot || !isObj(lot.tasks)) continue;
    for (const [k, t] of Object.entries(lot.tasks)) {
      if (keys.has(k)) continue;
      const st = spanOf(t).startMs;
      if (st != null && (from == null || st >= from) && (to == null || st <= to)) unplanned.push({ lotId, taskKey: k });
    }
  }
  return { actuals, stateByKey, unplanned };
}

export const ACTUAL_STATE_LABELS = Object.freeze({
  unstarted: '未着手', running: '作業中', completed: '完了', late: '遅れて完了', unrecorded: '未記録', unplanned: '計画外に実施',
});

/**
 * 画面の行。startShift/endShift は compareActuals の物(時刻の差)。理由は記録の物だけ(無ければ 未記録)。
 */
export function actualRows(plan, lots, nowMs = null) {
  const { actuals, stateByKey, unplanned } = actualsFromLots(plan, lots, nowMs);
  const cmp = compareActuals(plan, actuals);
  const byKey = new Map(cmp.rows.map((r) => [r.key, r]));
  const rows = (plan.tasks || []).map((t) => {
    const r = byKey.get(t.key);
    let state = stateByKey[t.key] || 'unrecorded';
    const a = actuals.find((x) => x.key === t.key) || null;
    if (state === 'completed' && Number.isFinite(t.dueMs) && a && a.endMs != null && a.endMs > t.dueMs) state = 'late';
    return {
      key: t.key, lotId: t.lotId, model: t.model || '', variant: t.variant || '', processLabel: t.processLabel || t.stepId, unitIndex: t.unitIndex,
      planned: t.assignment ? { worker: t.assignment.worker, startMs: t.assignment.startMs, endMs: t.assignment.endMs } : null,
      dueMs: Number.isFinite(t.dueMs) ? t.dueMs : null,
      actual: a ? { startMs: a.startMs, endMs: a.endMs } : null,
      state, label: ACTUAL_STATE_LABELS[state],
      startShiftMs: r ? r.startShiftMs : null, endShiftMs: r ? r.endShiftMs : null,
      cause: a && a.cause ? a.cause : (state === 'running' || state === 'completed' || state === 'late' ? '未記録' : ''),
    };
  });
  const counts = {};
  for (const r of rows) counts[r.state] = (counts[r.state] || 0) + 1;
  counts.unplanned = unplanned.length;
  return { rows, counts, unplanned };
}

/** 差の言い方(分)。 */
export const shiftText = (ms) => (Number.isFinite(ms) ? (ms === 0 ? '同じ' : `${ms > 0 ? '+' : '−'}${Math.round(Math.abs(ms) / 60000)}分`) : '—');
