import { dueRowFacts, DUE_TIER } from '../operationsSimulation/dueRowFacts.js';
import { makeCalendar } from '../operationsSimulation/calendar.js';

// Capture from the SAME completed run as the assignments, never from today's live data.
export function captureSubmissionEvidence(result, tasks, labels = {}) {
  const n = result.normalized;
  const verdicts = new Map((result.base.lotResults || []).map(v => [String(v.lotId), v]));
  const calendar = n.calendarSpec ? makeCalendar(n.calendarSpec) : null;
  const lots = (n.lots || []).map(l => {
    const verdict = verdicts.get(String(l.lotId));
    const facts = dueRowFacts({ verdict, lot: l, nowMs: n.now });
    // dueRowFacts defaults to OK without a verdict. Absence is not evidence of success.
    if (!verdict) facts.tier = DUE_TIER.UNKNOWN;
    const own = tasks.filter(t => t.lotId === String(l.lotId));
    // 🚚 部分入荷: 到着が記録に無い台(arrivalMs が null の台単位の仕事)は割り付かない。何台かを根拠に残す(帳票で「到着未定 4/6台」)
    const jobsOfLot = (n.jobs || []).filter(j => String(j.lotId) === String(l.lotId) && j.unitIndex !== null && j.unitIndex !== undefined);
    const unitCount = new Set(jobsOfLot.map(j => j.unitIndex)).size;
    const arrivalUnknownUnits = new Set(jobsOfLot.filter(j => j.arrivalMs === null || j.arrivalMs === undefined).map(j => j.unitIndex)).size;
    return { lotId: String(l.lotId), model: own[0]?.model || l.model || '', unitCount, arrivalUnknownUnits,
      variant: own[0]?.variant || labels[l.lotId]?.variant || '作業内容未確認', orderNo: own[0]?.orderNo || l.orderNo || '',
      arrivalMs: Number.isFinite(l.arrivalMs) ? l.arrivalMs : null,
      ...facts, verdictPresent: !!verdict, reason: verdict?.blockedDetail || verdict?.blocked || verdict?.unknownReason || '',
      taskKeys: own.map(t => t.key) };
  });
  const spansByTask = {};
  for (const t of tasks) {
    const a = t.assignment;
    if (!a || !calendar) { spansByTask[t.key] = null; continue; }
    const spans = [];
    let cursor = a.startMs, guard = 0;
    while (cursor < a.endMs) {
      if (++guard > 20000) throw new Error('勤務区間が多すぎるため提出資料を作れません');
      const boundaries = [a.worker, a.partner].filter(Boolean).map(w => calendar.nextBoundaryAfter(cursor, w)).filter(Number.isFinite);
      const end = Math.min(a.endMs, ...boundaries);
      if (!(end > cursor)) throw new Error('勤務区間を確認できません');
      if ([a.worker, a.partner].filter(Boolean).every(w => calendar.isAvailable(cursor, w))) spans.push([cursor, end]);
      cursor = end;
    }
    spansByTask[t.key] = spans;
  }
  return structuredClone({ version: 1, lots, spansByTask, calendarSpec: n.calendarSpec || null,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    scope: '計算対象のロットと残工程。取込前のExcel原本・対象外ロット・過去の完了実績は含みません。' });
}

export function submissionRows(plan) {
  if (plan?.status !== 'committed' || plan.evidence?.version !== 1) throw new Error('根拠付きの計画を保存してから出力してください');
  const tasks = new Map(plan.tasks.map(t => [t.key, t]));
  return plan.evidence.lots.map(l => ({ ...l,
    // 理由の欄に 到着未定の台数を足す(保存値は変えない。表示だけ)
    reason: [l.reason, l.arrivalUnknownUnits > 0 ? `到着未定 ${l.arrivalUnknownUnits}/${l.unitCount}台（記録に無い到着は作らず、割り付けていません）` : ''].filter(Boolean).join(' ／ '),
    tasks: l.taskKeys.map(k => {
    if (!tasks.has(k)) throw new Error('提出資料と保存計画の工程が一致しません');
    return tasks.get(k);
  }) })).sort((a,b) => a.tier - b.tier || (a.dueMs ?? Infinity) - (b.dueMs ?? Infinity) || a.lotId.localeCompare(b.lotId));
}

/* 🚨 2026-09-22 判定の言い方は **この1本だけ**。資料の要約も行もここから出す。
   直す前は要約が「既に超過/判定不能」、行が「既に納期超過/判定できません」で
   同じ資料の中に2通りの言い方が在った(決まり: 3つの数えを混ぜない・言い方を増やさない)。 */
export const VERDICT_LABELS = Object.freeze(['既に納期超過', '今後遅れる', '判定できません', '納期内の見込み']);
export const verdictLabel = l => VERDICT_LABELS[l.tier];
