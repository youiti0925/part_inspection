import { compareFullPair, planAvailableWork } from './scheduler.mjs';

const DONE = new Set(['completed', 'skipped', 'rework-done']);
const waiting = s => !s || s === 'waiting' || s === 'pending';

/** Original plan + authoritative task observations -> remaining work at ONE
 * new origin. Automatic work already running is carried, never launched again.
 * A planned end timestamp is only an estimate; it never completes a task. */
export function remainingInputOf(input, { records = {}, asOfMin = 0, currentLocation } = {}) {
  const errors = [];
  if (!Number.isFinite(asOfMin) || asOfMin < 0 || !currentLocation) return { ok: false, errors: ['現在時刻と作業者の現在区画を確認してください'] };
  const done = new Set(input.jobs.filter(j => DONE.has(records[j.id]?.status)).map(j => j.id));
  const jobs = [], needsCheck = [];
  for (const j of input.jobs) {
    const record = records[j.id] || {};
    if (done.has(j.id)) continue;
    if (record.status === 'processing' && (j.kind !== 'auto' || j.unattended !== true)) {
      return { ok: false, mode: 'finish-current', currentJob: j, errors: ['いまの手作業・監視を完了してから順序を組み直します'] };
    }
    const continued = record.status === 'processing' && j.kind === 'auto';
    if (!waiting(record.status) && !continued) errors.push(`${j.label || j.id}: 停止・不良などの状態を確認してください`);
    const durationMin = continued ? record.expectedEndMin - asOfMin : j.durationMin;
    if (continued && (!Number.isFinite(record.expectedEndMin) || !(durationMin > 0))) {
      errors.push(`${j.label || j.id}: 自動運転はまだ完了していません。終了または残時間を確認してください`);
      needsCheck.push(j.id);
    }
    const deps = j.deps.filter(id => !done.has(id));
    if (continued && deps.length) errors.push(`${j.id}: 前工程未完了なのに自動運転中です`);
    jobs.push({ ...j, deps, durationMin, initiallyRunning: continued,
      releaseMin: continued ? 0 : Math.max(0, (j.baseReleaseMin ?? j.releaseMin) - asOfMin) });
  }
  const pending = new Set(jobs.map(j => j.id)), initialHolds = {};
  for (const j of input.jobs) if (done.has(j.id) && j.holdFor && pending.has(j.holdFor) && !jobs.find(x => x.id === j.holdFor).initiallyRunning) {
    if (initialHolds[j.resourceId] && initialHolds[j.resourceId] !== j.holdFor) errors.push(`${j.resourceId}: 複数の製品が載っている記録です`);
    initialHolds[j.resourceId] = j.holdFor;
  }
  for (const j of jobs) if (j.holdFor && !pending.has(j.holdFor)) errors.push(`${j.id}: 設備を解放する工程だけが先に完了しています`);
  const resources = Object.fromEntries(Object.entries(input.resources).map(([id, free]) => [id, Math.max(0, free - asOfMin)]));
  const lots = input.lots.filter(l => jobs.some(j => j.lotId === l.id)).map(l => ({ ...l, dueMin: l.dueMin == null ? null : Math.max(0, l.dueMin - asOfMin), overdueAtOriginMin: l.dueMin == null ? 0 : Math.max(0, asOfMin - l.dueMin) }));
  const workerWindows = input.workerWindows.filter(([, end]) => end > asOfMin).map(([start, end]) => [Math.max(0, start - asOfMin), end - asOfMin]);
  if (jobs.length && !workerWindows.length) errors.push('残作業を計算する勤務日がありません');
  const continued = jobs.filter(j => j.initiallyRunning);
  return { ok: !errors.length, errors, needsCheck, input: { ...input, scope: 'available-work', lots, jobs, resources, initialHolds,
    workerWindows, startLocation: currentLocation, origin: `開始後${asOfMin}分時点の残作業`,
    startAt: input.startAt ? new Date(Date.parse(input.startAt) + asOfMin * 60000).toISOString() : null,
    assumptions: [...(input.assumptions || []), ...(continued.length ? ['進行中の自動運転は確認した終了見込みで計算。予定時刻で完了扱いにはしません'] : [])] } };
}

function subset(input, ids) {
  const jobs = input.jobs.filter(j => ids.includes(j.lotId));
  return { ...input, scope: 'available-work', lots: input.lots.filter(l => ids.includes(l.id)), jobs,
    initialHolds: Object.fromEntries(Object.entries(input.initialHolds || {}).filter(([, target]) => jobs.some(j => j.id === target))) };
}

/** arrivals: {lotId:{status:'arrived'|'expected'|'missing'|'unknown',expectedMin?}}
 * expectedMin and asOfMin share the original origin. No date-only inference.
 * revision is the current observation/configuration revision, echoed by commands.
 * This function never writes arrival, task, plan or personnel records. */
export function arrivalDecision(input, { arrivals = {}, records = {}, asOfMin = 0, currentLocation, revision, options = {} } = {}) {
  if (!revision) return { mode: 'blocked', errors: ['現在の記録の版が必要です'] };
  const base = { revision, asOfMin, arrivals, records, currentLocation,
    missing: input.lots.filter(l => arrivals[l.id]?.status !== 'arrived' && input.jobs.some(j => j.lotId === l.id && !DONE.has(records[j.id]?.status))).map(l => l.id) };
  if (input.jobs.some(j => records[j.id]?.status === 'processing' && arrivals[j.lotId]?.status !== 'arrived')) return { ...base, mode: 'blocked', errors: ['作業中のロットが未到着扱いです。到着記録と作業実績を照合してください'] };
  const remain = remainingInputOf(input, base);
  if (!remain.ok) {
    // An elapsed estimate must not deadlock the worker in the other area:
    // guide a physical check, without inventing the machine's completion.
    const check = input.jobs.find(j => remain.needsCheck?.includes(j.id));
    const target = input.lots.find(l => l.id === check?.lotId)?.location;
    const travel = input.travel?.[currentLocation]?.[target];
    const window = Number.isFinite(travel) && travel >= 0 && input.workerWindows.find(([a, b]) => Math.max(a, asOfMin) + travel <= b && Math.max(a, asOfMin) < b);
    const start = window ? Math.max(window[0], asOfMin) - asOfMin : null;
    const next = target && target !== currentLocation && window ? { kind: 'travel', purpose: 'check-auto', from: currentLocation, to: target, start, end: start + travel } : null;
    return { ...base, ...remain, mode: remain.mode || 'blocked', next };
  }
  const remaining = remain.input;
  if (!remaining.jobs.length) return { ...base, mode: 'done', message: '対象の全台・全工程が完了しています' };
  const missing = remaining.lots.filter(l => arrivals[l.id]?.status !== 'arrived');
  let forecast = null;
  const uncertain = missing.filter(l => !Number.isFinite(arrivals[l.id]?.expectedMin) || arrivals[l.id].expectedMin < asOfMin);
  if (remaining.lots.length === 2 && missing.length && !uncertain.length) {
    const predicted = { ...remaining, jobs: remaining.jobs.map(j => ({ ...j,
      releaseMin: Math.max(j.releaseMin, arrivals[j.lotId]?.status === 'arrived' ? 0 : arrivals[j.lotId].expectedMin - asOfMin) })) };
    forecast = compareFullPair(predicted, options);
  }
  const ids = remaining.lots.filter(l => arrivals[l.id]?.status === 'arrived').map(l => l.id);
  if (!ids.length) return { ...base, mode: 'waiting-arrival', missing: missing.map(l => l.id), forecast,
    message: '物がまだありません。到着を確認するまで開始しません', forecastReason: uncertain.length ? '到着時刻未定・予定超過のため組合せ効果は未確定です' : '' };
  const available = subset(remaining, ids);
  const comparison = ids.length === 2 ? compareFullPair(available, options) : null;
  const plan = comparison?.status === 'ok' ? comparison.paired : planAvailableWork(available, options);
  if (!plan.complete) return { ...base, mode: 'blocked', errors: plan.errors, forecast };
  const next = plan.worker.find(e => e.kind !== 'idle') || null;
  return { ...base, mode: ids.length === 1 ? 'single' : 'pair', input: available, plan, comparison, forecast, next,
    warnings: comparison?.warnings || available.assumptions || [],
    missing: missing.map(l => l.id), forecastReason: uncertain.length ? '到着時刻未定・予定超過。届いている物だけ進めます' : '',
    message: ids.length === 1 ? `${ids[0]}を単独で進めます。相手が届いたら、その時点の残作業で再計算します` : '両ロットが到着済みです。残作業から次の順序を計算しました' };
}

/** Validate a UI intent before handing it to the EXISTING task handler.
 * The caller must re-read records and repeat this check in its transaction;
 * a returned command is not evidence that a write succeeded. */
export function executionIntent({ decision, jobId, action, currentRevision, workerId, assignedWorkerId, nowMin, input }) {
  const fail = reason => ({ ok: false, reason });
  if (!decision || decision.revision !== currentRevision) return fail('記録が変わりました。最新状態で組み直してください');
  if (!workerId || workerId !== assignedWorkerId) return fail('この順序を担当する作業者を確認してください');
  const job = input.jobs.find(j => j.id === jobId);
  if (!job) return fail('対象工程が見つかりません');
  if (!job.sourceLotId || !job.sourceTaskKey) return fail('本番のロット・台・工程との接続が未設定です');
  const record = decision.records?.[jobId] || {};
  if (record.workerId && record.workerId !== workerId) return fail('別の作業者が開始した工程です。引継ぎを確認してください');
  if (action === 'complete') {
    if (record.status !== 'processing') return fail('開始済みの工程だけ完了できます');
    if (input.lots.find(l => l.id === job.lotId)?.location !== decision.currentLocation) return fail('終了を確認する作業場所へ移動してください');
    if (input.jobs.some(j => j.id !== jobId && (j.kind === 'manual' || !j.unattended) && decision.records?.[j.id]?.status === 'processing')) return fail('いまの手作業・監視を先に終えてください');
    // Completion remains possible after arrival delays / replanning warnings.
    return { ok: true, command: { type: 'complete-existing-task', lotId: job.sourceLotId, taskKey: job.sourceTaskKey, jobId, workerId, revision: currentRevision } };
  }
  if (action !== 'start') return fail('操作の種類を確認してください');
  if (!Number.isFinite(nowMin) || nowMin < decision.asOfMin) return fail('現在時刻を確認してください');
  if (decision.arrivals[job.lotId]?.status !== 'arrived') return fail('物がまだありません。到着を確認してから開始してください');
  if (!waiting(record.status)) return fail('開始済み・完了済みの工程を二重に開始しません');
  if (decision.next?.jobId !== jobId) return fail('次に行う工程が変わりました。移動・作業順を確認してください');
  if (nowMin < decision.asOfMin + decision.next.start) return fail('計算した着手時刻より前です');
  if (input.lots.find(l => l.id === job.lotId)?.location !== decision.currentLocation) return fail('作業場所への到着を確認してください');
  if (job.deps.some(id => !DONE.has(decision.records[id]?.status))) return fail('前工程の実際の完了を確認してください。終了予定時刻だけでは進めません');
  if (input.jobs.some(j => (j.kind === 'manual' || !j.unattended) && decision.records[j.id]?.status === 'processing')) return fail('いまの手作業・監視を先に終えてください');
  if (job.resourceId && input.jobs.some(j => j.id !== jobId && j.resourceId === job.resourceId && decision.records[j.id]?.status === 'processing')) return fail('設備がまだ運転中です');
  return { ok: true, command: { type: 'start-existing-task', lotId: job.sourceLotId, taskKey: job.sourceTaskKey, jobId, workerId, revision: currentRevision } };
}
