// =============================================================================
//  processTimes.js — 工程ごとの「いつやったか」と、全体の期間
// -----------------------------------------------------------------------------
//  soloDependency.js は「誰がやったか」しか返さない。画面には「いつ」も要るので
//  ここで数える。
//  🚨 工程の当て方は soloDependency の resolveTaskProcess / processKeyOf を
//     **そのまま**使う。自前で当て直すと集計とキーがズレて、別工程の日付が出る。
//  🚨 日付が読めなかった記録は捨てずに undatedTaskCount で数える。
//     捨てると「いつの記録か」の分母が黙って減る。
// =============================================================================
import { resolveTaskProcess, processKeyOf } from './soloDependency.js';

/** 作業の時刻。読めなければ null。⚠ 推測で埋めない。 */
export function taskTimeMs(task) {
  const cands = [task?.endTime, task?.firstStartTime, task?.startTime];
  for (const c of cands) {
    if (typeof c === 'number' && isFinite(c)) return c;
    if (c && typeof c === 'object' && typeof c.seconds === 'number') return c.seconds * 1000;
    if (typeof c === 'string') {
      const t = Date.parse(c);
      if (!isNaN(t)) return t;
    }
  }
  return null;
}

/**
 * 数える対象は computeSoloDependency と同じ（status が accept で、工程が決まったタスク）。
 * そろえてあるので datedTaskCount + undatedTaskCount === confidence.tasksEvaluated になる。
 * @returns {{byKey:Map<string,{firstMs:number|null,lastMs:number|null,datedTaskCount:number,undatedTaskCount:number}>,
 *            overall:{firstMs:number|null,lastMs:number|null,datedTaskCount:number,undatedTaskCount:number}}}
 */
export function computeProcessTimes(lots, acceptStatuses = ['completed']) {
  const ok = new Set(Array.isArray(acceptStatuses) && acceptStatuses.length ? acceptStatuses : ['completed']);
  const byKey = new Map();
  let datedTaskCount = 0;
  let undatedTaskCount = 0;
  let firstMs = null;
  let lastMs = null;

  (Array.isArray(lots) ? lots : []).forEach((lot) => {
    if (!lot || typeof lot !== 'object') return;
    const steps = Array.isArray(lot.steps) ? lot.steps : [];
    const tid = lot.templateId == null ? '' : String(lot.templateId);
    const tasks = (lot.tasks && typeof lot.tasks === 'object' && !Array.isArray(lot.tasks)) ? lot.tasks : {};
    Object.entries(tasks).forEach(([taskKey, task]) => {
      if (!task || typeof task !== 'object' || Array.isArray(task)) return;
      if (!ok.has(task.status == null ? '' : String(task.status))) return;
      const r = resolveTaskProcess(taskKey, steps);
      if (!r.resolved) return;
      const key = processKeyOf(tid, r.stepId);
      let e = byKey.get(key);
      if (!e) {
        e = { firstMs: null, lastMs: null, datedTaskCount: 0, undatedTaskCount: 0 };
        byKey.set(key, e);
      }
      const ms = taskTimeMs(task);
      if (ms == null) {
        e.undatedTaskCount += 1;
        undatedTaskCount += 1;
        return;
      }
      e.datedTaskCount += 1;
      datedTaskCount += 1;
      if (e.firstMs == null || ms < e.firstMs) e.firstMs = ms;
      if (e.lastMs == null || ms > e.lastMs) e.lastMs = ms;
      if (firstMs == null || ms < firstMs) firstMs = ms;
      if (lastMs == null || ms > lastMs) lastMs = ms;
    });
  });

  return { byKey, overall: { firstMs, lastMs, datedTaskCount, undatedTaskCount } };
}
