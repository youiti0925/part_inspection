// =============================================================================
//  operationsSimulation/workerLoad.js — 人ごとの「この期間の負荷」(要る直接作業 ÷ 働ける直接作業)。純関数(2026-09-17)
// -----------------------------------------------------------------------------
//  清水さん(2026-09-16 深夜)「これで本当に負荷見えるの？って感じだからね今は」
//
//  答える1行: 「この期間、◯◯さんは 働ける H時間 に対して 割り付いた仕事が h時間(負荷 h/H)」
//  🚨 ここで割付を変えない・数を推測しない:
//    ・割り付いた分 = 割付の答え(assignments)の仕事の直接作業(job.durationMs)を、期間に重なる割合で数える
//      (assignment の startMs〜endMs は休憩や夜を跨ぐ壁時計なので、長さには使わない。重なりの割合にだけ使う)。
//    ・働ける分 = normalizeInput が日ごとに解いた availableDirectMinutes(policy.js の答え)を期間の日だけ足す。
//    ・相方(partner)として入った仕事も その人の負荷に数える(2人で押さえている間は手が塞がっている)。
//  🚨 働ける分が 0 の人は 率を null(0 で割らない・∞ と書かない)。
// =============================================================================

const str = (v) => (v == null ? '' : String(v)).trim();
const num = (v) => ((v == null || v === '') ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const ymdLocal = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/**
 * @param {object} o
 * @param {Array}  o.assignments  base.assignments([{ jobId, worker, partner, startMs, endMs }])
 * @param {Array}  o.jobs         normalized.jobs([{ jobId, durationMs }])
 * @param {Array}  o.workers      normalized.workers([{ name, availability:[{ date:'YYYY-MM-DD', availableDirectMinutes }] }])
 * @param {number} o.fromMs       期間の始まり
 * @param {number} o.toMs         期間の終わり
 * @returns {{ byWorker: Object<string, { assignedMin:number, availableMin:number, ratio:number|null, jobs:number }>, fromMs:number|null, toMs:number|null }}
 */
export function workerLoadInWindow({ assignments = [], jobs = [], workers = [], fromMs = null, toMs = null } = {}) {
  const from = num(fromMs); const to = num(toMs);
  const jobDur = new Map();
  for (const j of (Array.isArray(jobs) ? jobs : [])) if (j && j.jobId != null) jobDur.set(str(j.jobId), num(j.durationMs));
  const out = {};
  const touch = (name) => { if (!out[name]) out[name] = { assignedMin: 0, availableMin: 0, ratio: null, jobs: 0 }; return out[name]; };
  for (const w of (Array.isArray(workers) ? workers : [])) {
    const name = str(w && w.name);
    if (!name) continue;
    const row = touch(name);
    for (const a of (Array.isArray(w.availability) ? w.availability : [])) {
      if (!a || !a.date) continue;
      if (from != null && to != null) {
        const d = new Date(`${a.date}T00:00:00`); const ms = d.getTime();
        if (!Number.isFinite(ms)) continue;
        if (ms < from - 86400000 || ms > to) continue;
        if (ymdLocal(ms) < ymdLocal(from) || ymdLocal(ms) > ymdLocal(to)) continue;
      }
      row.availableMin += Math.max(0, num(a.availableDirectMinutes) || 0);
    }
  }
  for (const a of (Array.isArray(assignments) ? assignments : [])) {
    if (!a) continue;
    const dur = jobDur.get(str(a.jobId));
    if (dur == null) continue;
    const s = num(a.startMs); const e = num(a.endMs);
    let frac = 1;
    if (from != null && to != null && s != null && e != null && e > s) {
      const ov = Math.min(e, to) - Math.max(s, from);
      frac = Math.max(0, Math.min(1, ov / (e - s)));
    }
    if (frac <= 0) continue;
    for (const who of [a.worker, a.partner]) {
      const name = str(who);
      if (!name) continue;
      const row = touch(name);
      row.assignedMin += (dur / 60000) * frac;
      row.jobs += 1;
    }
  }
  for (const row of Object.values(out)) {
    row.assignedMin = Math.round(row.assignedMin);
    row.availableMin = Math.round(row.availableMin);
    row.ratio = row.availableMin > 0 ? row.assignedMin / row.availableMin : null;
  }
  return { byWorker: out, fromMs: from, toMs: to };
}

/** 1行の言い方(画面はこれをそのまま出す)。 */
export function workerLoadText(row) {
  if (!row) return '';
  const h = (m) => `${(m / 60).toFixed(1)}h`;
  if (row.availableMin <= 0) return `働ける時間が この期間に無い（割り付いた仕事 ${h(row.assignedMin)}）`;
  return `負荷 ${Math.round(row.ratio * 100)}%（要る ${h(row.assignedMin)}／働ける ${h(row.availableMin)}）`;
}

export default workerLoadInWindow;
