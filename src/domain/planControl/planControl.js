// Isolated planning domain. No database, UI, clock, engine, or input mutation.
// The host supplies real normalized jobs and assignments from the SAME run.
const text = (v, name) => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${name}: required`);
  return v.trim();
};
const ms = (v, name) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`${name}: invalid time`);
  return v;
};
const list = (v, name) => {
  if (!Array.isArray(v)) throw new Error(`${name}: array required`);
  return v;
};
const clone = v => structuredClone(v);
const states = new Set(['waiting', 'prepared', 'processing', 'completed', 'unverified']);

export function taskKey(job) {
  const unit = job.unitIndex;
  if (unit !== null && (!Number.isInteger(unit) || unit < 0)) throw new Error('unitIndex: null or nonnegative integer required');
  return JSON.stringify([
    text(job.lotId, 'lotId'), text(job.templateId, 'templateId'),
    text(job.stepId, 'stepId'), unit,
  ]);
}

/** Context.schemaKey describes task definitions, not the schedule or worker choices.
 * Quality findings come from the engine/import/host; [] must be explicit.
 * liveStateByKey must be mapped from real task state, NEVER estimated schedule time.
 */
export function capturePlan({ id, context, source, jobs, assignments, qualityIssues,
  liveStateByKey = {}, labelsByLot = {} }) {
  const scope = {
    app: text(context?.app, 'app'),
    fromMs: ms(context?.fromMs, 'fromMs'), toMs: ms(context?.toMs, 'toMs'),
    schemaKey: text(context?.schemaKey, 'schemaKey'),
  };
  if (!['product', 'final'].includes(scope.app) || scope.toMs <= scope.fromMs) throw new Error('invalid scope');
  const origin = {
    runId: text(source?.runId, 'runId'),
    inputKey: text(source?.inputKey, 'inputKey'),
    engineVersion: text(source?.engineVersion, 'engineVersion'),
    calculatedAt: ms(source?.calculatedAt, 'calculatedAt'),
  };
  const findings = list(qualityIssues, 'qualityIssues').map(q => ({
    id: text(q.id, 'quality id'), kind: text(q.kind, 'quality kind'),
    message: text(q.message, 'quality message'),
  }));
  if (new Set(findings.map(q => q.id)).size !== findings.length) throw new Error('duplicate quality id');
  const byAssignment = new Map();
  for (const a of list(assignments, 'assignments')) {
    const id = text(a.jobId, 'assignment jobId');
    if (byAssignment.has(id)) throw new Error('duplicate assignment');
    const startMs = ms(a.startMs, 'startMs'), endMs = ms(a.endMs, 'endMs');
    if (endMs < startMs) throw new Error('end before start');
    byAssignment.set(id, {
      lotId: text(a.lotId, 'assignment lotId'), worker: text(a.worker, 'worker'),
      partner: a.partner == null ? null : text(a.partner, 'partner'), startMs, endMs,
    });
  }
  const keys = new Set(), ids = new Set();
  const tasks = list(jobs, 'jobs').map(job => {
    const key = taskKey(job), jobId = text(job.jobId, 'jobId');
    if (keys.has(key) || ids.has(jobId)) throw new Error('ambiguous task identity');
    keys.add(key); ids.add(jobId);
    const assignment = byAssignment.get(jobId) || null;
    if (assignment && assignment.lotId !== job.lotId) throw new Error('assignment lot mismatch');
    const workState = liveStateByKey[key] ?? 'unverified';
    if (!states.has(workState)) throw new Error('invalid live work state');
    const labels = labelsByLot[job.lotId] || {};
    return {
      key, jobId, lotId: job.lotId, templateId: job.templateId, stepId: job.stepId,
      unitIndex: job.unitIndex, workState, assignment,
      model: typeof labels.model === 'string' ? labels.model : null,
      variant: typeof labels.variant === 'string' ? labels.variant : null,
    };
  });
  for (const id of byAssignment.keys()) if (!ids.has(id)) throw new Error('assignment has no normalized job');
  tasks.sort((a, b) => a.key.localeCompare(b.key));
  return { version: 1, id: text(id, 'plan id'), status: 'draft', context: scope,
    source: origin, qualityIssues: findings, tasks };
}

function sameScope(a, b) {
  if (!['app', 'fromMs', 'toMs', 'schemaKey'].every(k => a.context[k] === b.context[k])) throw new Error('different period/app/task schema: cannot compare');
  if (a.source.engineVersion !== b.source.engineVersion) throw new Error('engine versions differ: recalculate both');
}
const fields = ['worker', 'partner', 'startMs', 'endMs'];
const equalAssignment = (a, b) => a === null || b === null ? a === b : fields.every(k => a[k] === b[k]);

export function comparePlans(before, after) {
  sameScope(before, after);
  const old = new Map(before.tasks.map(t => [t.key, t]));
  const next = new Map(after.tasks.map(t => [t.key, t]));
  const changes = [];
  for (const key of [...new Set([...old.keys(), ...next.keys()])].sort()) {
    const a = old.get(key), b = next.get(key);
    if (a && b && a.definition !== b.definition) throw new Error('task definition changed: cannot compare');
    const assignmentChanged = !a || !b || !equalAssignment(a.assignment, b.assignment);
    const dueChanged = !!a && !!b && (a.dueMs ?? null) !== (b.dueMs ?? null);
    if (!assignmentChanged && !dueChanged) continue;
    const kind = !a ? 'added' : !b ? 'missing' : !a.assignment ? 'scheduled'
      : !b.assignment ? 'unscheduled' : 'changed';
    changes.push({ key, kind, before: a ? clone(a) : null, after: b ? clone(b) : null,
      assignmentChanged,
      changes: [...(a?.assignment && b?.assignment ? fields.filter(k => a.assignment[k] !== b.assignment[k]) : []), ...(dueChanged ? ['dueMs'] : [])],
      // Wall-clock movement, NOT labor time or overtime.
      startShiftMs: a?.assignment && b?.assignment ? b.assignment.startMs - a.assignment.startMs : null,
      endShiftMs: a?.assignment && b?.assignment ? b.assignment.endMs - a.assignment.endMs : null,
    });
  }
  return { beforeId: before.id, afterId: after.id, changes,
    summary: { changedTasks: changes.length,
      unscheduledTasks: after.tasks.filter(t => !t.assignment).length,
      qualityFindings: after.qualityIssues.length,
      unverifiedStates: after.tasks.filter(t => t.workState === 'unverified').length },
    // Deliberately no "on time" or "can run": those are engine verdicts, not diff counts.
  };
}

/** Prepare a WHOLE-run adoption; never mix arbitrary rows from two runs.
 * expectedRevision/headRevision must also be checked atomically by the host's DB.
 * This pure function returns a command/snapshot and DOES NOT persist anything.
 */
export function prepareAdoption({ baseline = null, proposal, expectedRevision, headRevision,
  currentInputKey, liveStateByKey, freezeBeforeMs, actor, atMs, newId,
  acknowledgedIssueIds = [] }) {
  const errors = [];
  if (!Number.isInteger(headRevision) || headRevision < 0 || expectedRevision !== headRevision) errors.push('stale-revision');
  if (baseline && (baseline.status !== 'committed' || baseline.revision !== headRevision)) errors.push('baseline-revision-mismatch');
  if (!baseline && headRevision !== 0) errors.push('baseline-required');
  if (proposal.status !== 'draft') errors.push('proposal-must-be-draft');
  if (proposal.source.inputKey !== currentInputKey) errors.push('inputs-changed-recalculate');
  const at = ms(atMs, 'atMs'), freeze = ms(freezeBeforeMs, 'freezeBeforeMs');
  const who = text(actor, 'actor'), id = text(newId, 'newId');
  if (id === proposal.id || id === baseline?.id) errors.push('new-plan-id-required');
  if (at < proposal.source.calculatedAt || (baseline && at < baseline.committedAt)) errors.push('invalid-commit-time');
  if (!liveStateByKey || typeof liveStateByKey !== 'object') errors.push('live-state-required');
  let diff = null;
  if (baseline) {
    try { diff = comparePlans(baseline, proposal); }
    catch { errors.push('incomparable-plans'); }
  }
  const live = liveStateByKey || {};
  for (const task of proposal.tasks) {
    if (!states.has(live[task.key]) || live[task.key] === 'unverified') errors.push(`live-state-unverified:${task.key}`);
    if (live[task.key] === 'completed' && task.assignment) errors.push(`completed-task-rescheduled:${task.key}`);
    // An initial plan accepts running/prepared work as it is now (recorded in workState below).
    // 2026-09-24 清水さん決定(A): the factory always has work in progress, so refusing it meant the first version could never be saved.
  }
  for (const change of diff?.changes || []) {
    const state = live[change.key];
    if (!states.has(state) || state === 'unverified') errors.push(`live-state-unverified:${change.key}`);
    if (change.kind === 'missing' && state === 'completed') continue;
    if (change.kind === 'missing') errors.push(`missing-task-needs-review:${change.key}`);
    if (!change.assignmentChanged) continue; // A changed deadline does not move protected work.
    if (['prepared', 'processing'].includes(state)) errors.push(`protected-task:${change.key}`);
    if (change.before?.assignment?.startMs < freeze || change.after?.assignment?.startMs < freeze) errors.push(`frozen-task:${change.key}`);
  }
  const required = [...proposal.qualityIssues.map(q => `quality:${q.id}`),
    ...proposal.tasks.filter(t => !t.assignment && live[t.key] !== 'completed').map(t => `unscheduled:${t.key}`)];
  const acknowledgments = new Set(list(acknowledgedIssueIds, 'acknowledgedIssueIds'));
  for (const issue of required) if (!acknowledgments.has(issue)) errors.push(`acknowledgment-required:${issue}`);
  if (errors.length) return { ok: false, errors: [...new Set(errors)], requiredAcknowledgments: required, diff };
  const committed = clone(proposal);
  committed.tasks = committed.tasks.map(t => ({ ...t, workState: live[t.key] }));
  Object.assign(committed, { id, status: 'committed', revision: headRevision + 1,
    parentId: baseline?.id ?? null, committedAt: at, committedBy: who,
    acknowledgedIssueIds: required });
  return { ok: true, expectedRevision: headRevision, snapshot: committed, diff };
}

/** Actual comparisons use explicit same-key observations. No worker-name inference. */
export function compareActuals(plan, actuals) {
  const byKey = new Map();
  for (const a of list(actuals, 'actuals')) {
    const key = text(a.key, 'actual task key');
    if (byKey.has(key)) throw new Error('duplicate actual: aggregate sessions upstream');
    const start = a.startMs == null ? null : ms(a.startMs, 'actual start');
    const end = a.endMs == null ? null : ms(a.endMs, 'actual end');
    if (start !== null && end !== null && end < start) throw new Error('actual end before start');
    byKey.set(key, { startMs: start, endMs: end, cause: a.cause == null ? null : text(a.cause, 'cause') });
  }
  const rows = plan.tasks.map(t => {
    const a = byKey.get(t.key);
    return { key: t.key, observed: !!a,
      startShiftMs: a?.startMs != null && t.assignment ? a.startMs - t.assignment.startMs : null,
      endShiftMs: a?.endMs != null && t.assignment ? a.endMs - t.assignment.endMs : null,
      cause: a?.cause ?? null };
  });
  const planned = new Set(plan.tasks.map(t => t.key));
  return { rows, unplannedKeys: [...byKey.keys()].filter(k => !planned.has(k)) };
}
