/** Full-lot, one-worker scheduling. Minutes from ONE shared origin.
 * Pure functions; no persistence. All timelines and metrics come from scheduled jobs.
 * Bounded beam search: returns a feasible plan, never a claim of global optimality.
 */
const EPS = 1e-7;
const sum = xs => xs.reduce((a, b) => a + b, 0);
const max = xs => Math.max(0, ...xs);
const round = n => Math.round(n * 1000) / 1000;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export function validateInput(input) {
  const errors = [];
  if (!input || !Array.isArray(input.lots) || !(input.lots.length === 2 || (input.lots.length === 1 && input.scope === 'available-work'))) return ['比較は2ロット、到着済みの単独処理は1ロットを指定してください'];
  const ids = new Set(input.lots.map(l => l.id));
  if (ids.size !== input.lots.length || input.lots.some(l => typeof l.id !== 'string' || !l.id || !l.location)) errors.push('ロットIDと場所が必要です');
  if (!input.startLocation) errors.push('作業者の開始場所が必要です');
  const jobs = input.jobs || [];
  if (!Array.isArray(jobs) || !jobs.length || jobs.length > 160) return [...errors, '対象工程は1〜160件にしてください'];
  const byId = new Map(jobs.map(j => [j.id, j]));
  if (byId.size !== jobs.length) errors.push('工程IDが重複しています');
  for (const j of jobs) {
    if (!j.id || !ids.has(j.lotId) || !['manual', 'auto'].includes(j.kind)) errors.push(`工程の識別情報が不正: ${j.id}`);
    if (!Number.isFinite(j.durationMin) || j.durationMin <= 0) errors.push(`時間が不明: ${j.id}`);
    if (!Number.isFinite(j.releaseMin) || j.releaseMin < 0) errors.push(`着手可能時刻が不明: ${j.id}`);
    if (j.kind === 'manual' && j.qualified !== true) errors.push(`担当可否が未確認: ${j.id}`);
    if (j.kind === 'auto' && (typeof j.unattended !== 'boolean' || !j.resourceId)) errors.push(`自動工程の設備・離席条件が未確認: ${j.id}`);
    if (j.resourceId && (!input.resources || !own(input.resources, j.resourceId) || !Number.isFinite(input.resources[j.resourceId]) || input.resources[j.resourceId] < 0)) errors.push(`設備が空く時刻が未確認: ${j.id}`);
    if (!Array.isArray(j.deps) || j.deps.some(id => !byId.has(id) || id === j.id || byId.get(id).lotId !== j.lotId)) errors.push(`工程順が不正: ${j.id}`);
    if (j.initiallyRunning && (j.kind !== 'auto' || j.unattended !== true || j.deps?.length || j.releaseMin !== 0)) errors.push(`継続中の自動工程の残時間・離席条件を確認してください: ${j.id}`);
    if (j.holdFor) {
      const next = byId.get(j.holdFor);
      if (!j.resourceId || !next || next.resourceId !== j.resourceId || !next.deps?.includes(j.id)) errors.push(`設備の占有解除先が不正: ${j.id}`);
    }
  }
  const runningResources = jobs.filter(j => j.initiallyRunning).map(j => j.resourceId);
  if (new Set(runningResources).size !== runningResources.length) errors.push('同じ設備で複数の自動工程が進行中です');
  for (const [resource, target] of Object.entries(input.initialHolds || {})) {
    if (!byId.has(target) || byId.get(target).resourceId !== resource || runningResources.includes(resource)) errors.push(`引継ぎ時の設備占有が不整合: ${resource}`);
  }
  const seen = new Set();
  for (let i = 0; i < jobs.length; i++) for (const j of jobs) if (Array.isArray(j.deps) && j.deps.every(d => seen.has(d))) seen.add(j.id);
  if (seen.size !== jobs.length) errors.push('工程順に循環または欠落があります');
  for (const l of input.lots) {
    if (!jobs.some(j => j.lotId === l.id)) errors.push(`残り工程がありません: ${l.id}`);
    if (input.maxLotDelay?.[l.id] != null && (!Number.isFinite(input.maxLotDelay[l.id]) || input.maxLotDelay[l.id] < 0)) errors.push(`許容遅延が不正: ${l.id}`);
    if (l.dueMin != null && (!Number.isFinite(l.dueMin) || l.dueMin < 0)) errors.push(`納期が不正: ${l.id}`);
    if (l.overdueAtOriginMin != null && (!Number.isFinite(l.overdueAtOriginMin) || l.overdueAtOriginMin < 0)) errors.push(`再計算時点の納期超過が不正: ${l.id}`);
  }
  const windows = input.workerWindows;
  if (!Array.isArray(windows) || !windows.length || windows.some((w, i) => !Array.isArray(w) || w.length !== 2 || !w.every(Number.isFinite) || w[0] < 0 || w[1] <= w[0] || (i && windows[i - 1][1] > w[0]))) errors.push('作業者の勤務時間帯が不正です');
  const locations = [...new Set([input.startLocation, ...input.lots.map(l => l.location)])];
  for (const a of locations) for (const b of locations) if (a !== b && (!Number.isFinite(input.travel?.[a]?.[b]) || input.travel[a][b] < 0)) errors.push(`片道時間が未登録: ${a} → ${b}`);
  return [...new Set(errors)];
}

function fit(t, duration, windows) {
  for (const [start, end] of windows) {
    const at = Math.max(t, start);
    if (at < end - EPS && at + duration <= end + EPS) return at;
  }
  return null;
}
function initial(input) {
  const state = { time: 0, location: input.startLocation, ends: {}, machine: { ...input.resources }, holds: { ...(input.initialHolds || {}) }, jobs: [], worker: [] };
  for (const j of input.jobs.filter(j => j.initiallyRunning)) {
    const location = input.lots.find(l => l.id === j.lotId).location;
    state.jobs.push({ ...j, start: 0, end: j.durationMin, location, continued: true });
    state.ends[j.id] = j.durationMin;
    state.machine[j.resourceId] = j.durationMin;
    state.holds[j.resourceId] = j.holdFor || null;
  }
  return state;
}
function put(state, job, input, barrier = 0) {
  if (own(state.ends, job.id) || !job.deps.every(id => own(state.ends, id))) return null;
  if (job.resourceId && state.holds[job.resourceId] && state.holds[job.resourceId] !== job.id) return null;
  const location = input.lots.find(l => l.id === job.lotId).location;
  const travel = location === state.location ? 0 : input.travel[state.location][location];
  let t = Math.max(state.time, barrier);
  const worker = [...state.worker];
  if (location !== state.location) {
    const start = fit(t, travel, input.workerWindows);
    if (start == null) return null;
    worker.push({ kind: 'travel', start, end: start + travel, from: state.location, to: location, lotId: job.lotId });
    t = start + travel;
  }
  t = Math.max(t, job.releaseMin, max(job.deps.map(id => state.ends[id])), job.resourceId ? state.machine[job.resourceId] : 0);
  const attends = job.kind === 'manual' || job.unattended === false;
  const start = fit(t, attends || input.autoOutsideWindows === false ? job.durationMin : 0, input.workerWindows);
  if (start == null) return null;
  const end = start + job.durationMin;
  // The worker must be physically present to start an automatic operation.
  const entry = { ...job, location, start, end };
  if (attends) worker.push({ kind: job.kind === 'manual' ? 'manual' : 'monitor', start, end, lotId: job.lotId, jobId: job.id });
  else worker.push({ kind: 'launch', start, end: start, lotId: job.lotId, jobId: job.id });
  return {
    time: attends ? end : start, location, ends: { ...state.ends, [job.id]: end },
    machine: job.resourceId ? { ...state.machine, [job.resourceId]: end } : state.machine,
    holds: job.resourceId ? { ...state.holds, [job.resourceId]: job.holdFor || null } : state.holds,
    jobs: [...state.jobs, entry], worker,
  };
}
function score(s, input) {
  // A lower-bound style heuristic only. Never reported as a measured saving.
  const unplanned = input.jobs.filter(j => !own(s.ends, j.id));
  return Math.max(max(Object.values(s.ends)), s.time + sum(unplanned.filter(j => j.kind === 'manual' || !j.unattended).map(j => j.durationMin)));
}
function activeTime(start, end, windows) {
  return sum(windows.map(([a, b]) => Math.max(0, Math.min(end, b) - Math.max(start, a))));
}
function finish(state, input, search) {
  const end = max(Object.values(state.ends));
  const lotEnds = Object.fromEntries(input.lots.map(l => [l.id, max(state.jobs.filter(j => j.lotId === l.id).map(j => j.end))]));
  const worker = [...state.worker].sort((a, b) => a.start - b.start || a.end - b.end);
  const busy = worker.filter(s => s.end > s.start);
  let cursor = 0;
  const idle = [];
  for (const s of busy) { if (s.start > cursor) idle.push({ kind: 'idle', start: cursor, end: s.start }); cursor = s.end; }
  if (end > cursor) idle.push({ kind: 'idle', start: cursor, end });
  const resourceWait = [];
  for (const [resourceId, target] of Object.entries(input.initialHolds || {})) {
    const next = state.jobs.find(j => j.id === target);
    if (next.start > 0) resourceWait.push({ resourceId, start: 0, end: next.start, carried: true });
  }
  for (const j of state.jobs) if (j.holdFor) {
    const next = state.jobs.find(x => x.id === j.holdFor);
    if (next.start > j.end) resourceWait.push({ resourceId: j.resourceId, start: j.end, end: next.start, afterJobId: j.id });
  }
  const plan = {
    complete: true, origin: input.origin || '同じ開始時点', jobs: state.jobs, worker: [...worker, ...idle].sort((a, b) => a.start - b.start), resourceWait,
    metrics: { totalMin: round(end), lotEnds, travelMin: round(sum(worker.filter(s => s.kind === 'travel').map(s => s.end - s.start))),
      travelCount: worker.filter(s => s.kind === 'travel').length,
      workerIdleMin: round(sum(idle.map(s => activeTime(s.start, s.end, input.workerWindows)))),
      machineReturnWaitMin: round(sum(resourceWait.map(s => s.end - s.start))),
      lateness: Object.fromEntries(input.lots.map(l => [l.id, l.dueMin == null ? null : Math.max(0, lotEnds[l.id] - l.dueMin) + (l.overdueAtOriginMin || 0)])),
    }, search,
  };
  const errors = auditPlan(input, plan);
  return errors.length ? { complete: false, errors, search } : plan;
}

/** Independent invariant checks on every complete search result. */
export function auditPlan(input, plan) {
  const errors = [];
  const byId = new Map(plan.jobs.map(j => [j.id, j]));
  if (byId.size !== input.jobs.length || plan.jobs.length !== input.jobs.length) errors.push('全工程が一度ずつ完了していません');
  for (const j of input.jobs) {
    const p = byId.get(j.id);
    if (!p) continue;
    if (j.kind === 'auto' && !j.initiallyRunning && input.autoOutsideWindows === false && !input.workerWindows.some(([a, b]) => p.start + EPS >= a && p.end <= b + EPS)) errors.push(`勤務外の自動継続が未確認: ${j.id}`);
    if (!!p.continued !== !!j.initiallyRunning || (j.initiallyRunning && p.start !== 0)) errors.push(`継続中の工程を再開始しています: ${j.id}`);
    if (Math.abs(p.end - p.start - j.durationMin) > EPS || p.start + EPS < j.releaseMin) errors.push(`工程時間が不整合: ${j.id}`);
    for (const d of j.deps) if (!byId.has(d) || p.start + EPS < byId.get(d).end) errors.push(`工程順が逆転: ${j.id}`);
    if (j.resourceId && p.start + EPS < input.resources[j.resourceId]) errors.push(`設備がまだ使用中: ${j.id}`);
  }
  const worker = plan.worker.filter(s => s.kind !== 'idle').sort((a, b) => a.start - b.start || a.end - b.end);
  let workerEnd = 0, location = input.startLocation;
  const worked = new Map();
  for (const s of worker) {
    if (s.start + EPS < workerEnd) errors.push('作業者が同時に複数の作業をしています');
    if (!input.workerWindows.some(([a, b]) => s.start + EPS >= a && s.start < b - EPS && s.end <= b + EPS)) errors.push('勤務時間外に作業・移動があります');
    if (s.kind === 'travel') {
      if (location !== s.from || Math.abs((s.end - s.start) - input.travel[s.from]?.[s.to]) > EPS) errors.push('移動時間または出発場所が不整合');
      location = s.to;
    } else if (s.jobId) {
      const j = byId.get(s.jobId);
      if (!j || j.location !== location || Math.abs(j.start - s.start) > EPS) errors.push('現地にいない作業者が着手しています');
      worked.set(s.jobId, (worked.get(s.jobId) || 0) + 1);
    }
    workerEnd = Math.max(workerEnd, s.end);
  }
  for (const j of input.jobs) if (worked.get(j.id) !== (j.initiallyRunning ? undefined : 1)) errors.push(`開始・作業記録が欠落: ${j.id}`);
  for (const resource of Object.keys(input.resources || {})) {
    const segments = plan.jobs.filter(j => j.resourceId === resource).map(j => ({ start: j.start, end: j.holdFor ? byId.get(j.holdFor)?.start : j.end, id: j.id }));
    if (input.initialHolds?.[resource]) segments.push({ start: 0, end: byId.get(input.initialHolds[resource])?.start, id: 'initial-hold' });
    segments.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < segments.length; i++) if (segments[i].start + EPS < segments[i - 1].end) errors.push(`設備の重複使用: ${resource}`);
  }
  return [...new Set(errors)];
}

export function searchPlan(input, { order = null, beamWidth = 128, maxExpansions = 100000, finishLimits = null } = {}) {
  const errors = validateInput(input);
  if (errors.length) return { complete: false, errors };
  if (order && (order.length !== input.lots.length || new Set(order).size !== input.lots.length || order.some(id => !input.lots.some(l => l.id === id)))) return { complete: false, errors: ['比較順序が不正です'] };
  if (!Number.isInteger(beamWidth) || beamWidth < 1 || !Number.isInteger(maxExpansions) || maxExpansions < 1) return { complete: false, errors: ['探索上限が不正です'] };
  let beam = [initial(input)], expansions = 0, pruned = false;
  for (let depth = beam[0].jobs.length; depth < input.jobs.length; depth++) {
    const next = [];
    for (const s of beam) {
      const activeLot = order?.find(id => input.jobs.some(j => j.lotId === id && !own(s.ends, j.id)));
      const prior = order && activeLot ? order.slice(0, order.indexOf(activeLot)) : [];
      const barrier = max(s.jobs.filter(j => prior.includes(j.lotId)).map(j => j.end));
      const equivalent = new Set();
      for (const j of input.jobs) {
        if (activeLot && j.lotId !== activeLot) continue;
        if (own(s.ends, j.id) || !j.deps.every(id => own(s.ends, id))) continue;
        if (j.resourceId && s.holds[j.resourceId] && s.holds[j.resourceId] !== j.id) continue;
        // Interchangeable units of the same lot need not consume every beam slot.
        // Include their remaining suffix, dependencies and equipment reservation.
        const suffix = input.jobs.filter(x => x.lotId === j.lotId && x.unit === j.unit && !own(s.ends, x.id)).map(x => [x.stepId, x.kind, x.durationMin, x.resourceId]);
        const symmetry = JSON.stringify([j.lotId, j.stepId || j.id, j.kind, j.durationMin, j.releaseMin, j.resourceId, j.unattended, j.unit === null, max(j.deps.map(id => s.ends[id])), suffix]);
        if (equivalent.has(symmetry)) continue;
        equivalent.add(symmetry);
        if (++expansions > maxExpansions) return { complete: false, errors: ['探索上限に達しました。実行不能とは断定していません'], search: { expansions, pruned: true, optimal: false } };
        const n = put(s, j, input, barrier);
        if (n) next.push(n);
      }
    }
    if (!next.length) return { complete: false, errors: ['探索した範囲では全工程を完了する計画が見つかりません'], search: { expansions, pruned, optimal: false } };
    // Deduplicate states with identical future constraints; retain less travel.
    const distinct = new Map();
    for (const s of next) {
      const key = JSON.stringify([s.time, s.location, Object.entries(s.ends).sort(), Object.entries(s.machine).sort(), Object.entries(s.holds).sort()]);
      const old = distinct.get(key);
      if (!old || travelOf(s) < travelOf(old)) distinct.set(key, s);
    }
    const overLimit = s => {
      if (!finishLimits) return 0;
      return sum(input.lots.map(l => {
        let bound = max(s.jobs.filter(j => j.lotId === l.id).map(j => j.end));
        for (const r of Object.keys(input.resources || {})) {
          const remaining = input.jobs.filter(j => j.lotId === l.id && j.resourceId === r && !own(s.ends, j.id));
          if (remaining.length) bound = Math.max(bound, s.machine[r] + sum(remaining.map(j => j.durationMin)));
        }
        return Math.max(0, bound - finishLimits[l.id]);
      }));
    };
    const ordered = [...distinct.values()].sort((a, b) => Number(overLimit(a) > EPS) - Number(overLimit(b) > EPS) || score(a, input) - score(b, input) || travelOf(a) - travelOf(b));
    if (ordered.length > beamWidth) pruned = true;
    beam = ordered.slice(0, beamWidth);
  }
  const exceeds = s => finishLimits ? sum(input.lots.map(l => Math.max(0, max(s.jobs.filter(j => j.lotId === l.id).map(j => j.end)) - finishLimits[l.id]))) : 0;
  beam.sort((a, b) => Number(exceeds(a) > EPS) - Number(exceeds(b) > EPS) || max(Object.values(a.ends)) - max(Object.values(b.ends)) || travelOf(a) - travelOf(b));
  return finish(beam[0], input, { expansions, pruned, optimal: false, method: 'bounded-beam', beamWidth });
}
const travelOf = state => sum(state.worker.filter(s => s.kind === 'travel').map(s => s.end - s.start));

/** Keep several inexpensive, complete dispatch plans as incumbents. A bounded
 * beam must not discard a good known plan simply because its prefix was pruned.
 * No extra machine capacity or interrupted manual operations are introduced. */
function dispatchPlan(input, order, policy) {
  let state = initial(input);
  for (let depth = state.jobs.length; depth < input.jobs.length; depth++) {
    const active = order?.find(id => input.jobs.some(j => j.lotId === id && !own(state.ends, j.id)));
    const prior = order && active ? order.slice(0, order.indexOf(active)) : [];
    const barrier = max(state.jobs.filter(j => prior.includes(j.lotId)).map(j => j.end));
    const choices = input.jobs.filter(j => !active || j.lotId === active).map(j => put(state, j, input, barrier)).filter(Boolean);
    if (!choices.length) return null;
    const key = s => {
      const j = s.jobs.at(-1);
      const nextAuto = input.jobs.find(x => x.kind === 'auto' && x.deps.includes(j.id));
      return [j.start, policy === 'auto' ? Number(j.kind !== 'auto') : 0,
        policy === 'feed' ? -(nextAuto?.durationMin || (j.kind === 'auto' ? j.durationMin : 0)) : 0,
        s.time, travelOf(s), j.id];
    };
    choices.sort((a, b) => { const ka = key(a), kb = key(b); for (let i = 0; i < ka.length; i++) { if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1; } return 0; });
    state = choices[0];
  }
  return finish(state, input, { method: `dispatch-${policy}`, optimal: false, pruned: false });
}

function solveWithIncumbents(input, options, order, finishLimits = null) {
  const searched = searchPlan(input, { ...options, order, finishLimits });
  const plans = [searched, ...['auto', 'feed'].map(policy => dispatchPlan(input, order, policy))].filter(p => p?.complete);
  const exceeds = p => finishLimits ? sum(input.lots.map(l => Math.max(0, p.metrics.lotEnds[l.id] - finishLimits[l.id]))) : 0;
  plans.sort((a, b) => Number(exceeds(a) > EPS) - Number(exceeds(b) > EPS) || a.metrics.totalMin - b.metrics.totalMin || a.metrics.travelMin - b.metrics.travelMin);
  if (!plans.length) return searched;
  return { ...plans[0], search: { ...plans[0].search, optimal: false, pruned: !!searched.search?.pruned,
    beamComplete: !!searched.complete, incumbentCount: plans.length, beamErrors: searched.errors || [] } };
}

/** Baseline is the faster COMPLETE sequential order, including within-lot parallel work.
 * Candidate includes this baseline: a failed/worse search can never become a saving.
 */
export function compareFullPair(input, options = {}) {
  if (input?.lots?.length !== 2) return { status: 'unknown', errors: ['前後比較には2ロット必要です'], recommended: false };
  const errors = validateInput(input);
  if (errors.length) return { status: 'unknown', errors, recommended: false };
  const ids = input.lots.map(l => l.id);
  const ab = solveWithIncumbents(input, options, ids);
  const ba = solveWithIncumbents(input, options, [...ids].reverse());
  const baselines = [ab, ba].filter(p => p.complete).sort((a, b) => a.metrics.totalMin - b.metrics.totalMin);
  if (baselines.length !== 2) return { status: 'unknown', errors: ['公平な比較に必要な順次処理の2案を完了まで計算できません', ...[ab, ba].flatMap(p => p.errors || [])], recommended: false };
  const baseline = baselines[0];
  const finishLimits = Object.fromEntries(input.lots.map(l => [l.id, Math.min(l.dueMin ?? Infinity, baseline.metrics.lotEnds[l.id] + (input.maxLotDelay?.[l.id] ?? 0))]));
  const explored = solveWithIncumbents(input, options, null, finishLimits);
  const withinLimits = p => input.lots.every(l => p.metrics.lotEnds[l.id] <= finishLimits[l.id] + EPS);
  // Never choose a delay-violating candidate over a valid baseline.
  const paired = explored.complete && explored.metrics.totalMin < baseline.metrics.totalMin - EPS &&
    (withinLimits(explored) || !withinLimits(baseline)) ? explored : baseline;
  const savingsMin = round(baseline.metrics.totalMin - paired.metrics.totalMin);
  // Preserve a faster complete result excluded by a completion limit. Zero in
  // the adopted comparison must not erase the known tradeoff.
  const excludedAlternative = paired === baseline && explored.complete && explored.metrics.totalMin < baseline.metrics.totalMin - EPS && !withinLimits(explored)
    ? { plan: explored, savingsMin: round(baseline.metrics.totalMin - explored.metrics.totalMin),
      completionDelta: Object.fromEntries(ids.map(id => [id, round(explored.metrics.lotEnds[id] - baseline.metrics.lotEnds[id])])),
      violations: input.lots.filter(l => explored.metrics.lotEnds[l.id] > finishLimits[l.id] + EPS).map(l => ({
        lotId: l.id, label: l.label || l.id, limitMin: finishLimits[l.id], finishMin: explored.metrics.lotEnds[l.id],
        excessMin: round(explored.metrics.lotEnds[l.id] - finishLimits[l.id]),
      })), recommended: false } : null;
  const completionDelta = Object.fromEntries(ids.map(id => [id, round(paired.metrics.lotEnds[id] - baseline.metrics.lotEnds[id])]));
  const warnings = [];
  if (!explored.complete) warnings.push(...explored.errors);
  if (explored.search?.beamErrors?.length) warnings.push(...explored.search.beamErrors);
  for (const l of input.lots) {
    const allowed = input.maxLotDelay?.[l.id] ?? 0;
    if (completionDelta[l.id] > allowed + EPS) warnings.push(`${l.label || l.id}の完了が ${round(completionDelta[l.id])}分遅くなります(許容 ${allowed}分)`);
    if (l.dueMin == null) warnings.push(`${l.label || l.id}の納期は未確認です`);
    else if (paired.metrics.lateness[l.id] > EPS) warnings.push(`${l.label || l.id}が納期を ${round(paired.metrics.lateness[l.id])}分超えます`);
  }
  if (input.assumptions?.length) warnings.push(...input.assumptions);
  return { status: 'ok', baseline, alternativeBaseline: baselines[1], paired, savingsMin, completionDelta, excludedAlternative,
    savingsPct: round(savingsMin / baseline.metrics.totalMin * 100),
    recommended: savingsMin > EPS && warnings.length === 0,
    verdict: savingsMin <= EPS ? '試した範囲では組合せの短縮効果なし' : warnings.length ? '短縮候補・条件の確認が必要' : '全台完了までの比較で短縮を確認',
    warnings, search: explored.search, productionEligible: false,
    searchLimited: !!(ab.search?.pruned || ba.search?.pruned || explored.search?.pruned),
  };
}

/** Complete all work that has physically arrived; no placeholder second lot. */
export function planAvailableWork(input, options = {}) {
  const scoped = { ...input, scope: 'available-work' };
  const errors = validateInput(scoped);
  if (errors.length) return { complete: false, errors };
  return solveWithIncumbents(scoped, options, null);
}

/** Scan nominated partners, calculating EVERY pair to completion, not idle-fit scores. */
export function rankFullPairs(inputs, options = {}) {
  return inputs.map(input => ({ lotIds: input.lots?.map(l => l.id) || [], comparison: compareFullPair(input, options) }))
    .sort((a, b) => Number(b.comparison.recommended) - Number(a.comparison.recommended) || (b.comparison.savingsMin || 0) - (a.comparison.savingsMin || 0));
}
