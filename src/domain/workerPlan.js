const isNum = (value) => typeof value === 'number' && Number.isFinite(value);

const clean = (value) => (typeof value === 'string' ? value.trim() : '');

const lotIdOf = (lot) => clean(lot && (lot.lotId || lot.id || lot.__id));

/**
 * テンプレ名（決まり12・2026-09-02 清水さん「型式だけ記載されてても意味ない」）。
 * templatesById は Map でも素のオブジェクトでも、値が文字列でも受ける（Board.jsx の tplNameOf と同じ規則）。
 * 🚨 ここで名前を作らない。無ければ '' を返し、画面側が「テンプレ名なし」と正直に書く。
 */
export function tplNameOf(templatesById, id) {
  if (!id || !templatesById) return '';
  const t = templatesById instanceof Map ? templatesById.get(id) : templatesById[id];
  if (typeof t === 'string') return t;
  return (t && typeof t.name === 'string') ? t.name : '';
}

const assignmentBelongsTo = (assignment, name) => (
  assignment && (clean(assignment.worker) === name || clean(assignment.partner) === name)
);

const normalizeAssignment = (assignment, modelByLot, name = '', templatesById = null) => {
  const rawStart = assignment && assignment.startMs;
  const rawEnd = assignment && assignment.endMs;
  const startMs = Number(rawStart);
  const endMs = Number(rawEnd);
  const lotId = clean(assignment && assignment.lotId);
  if (rawStart == null || rawEnd == null || !lotId || !isNum(startMs) || !isNum(endMs) || endMs <= startMs) return null;
  const lot = modelByLot.get(lotId) || null;
  const worker = clean(assignment.worker);
  const partner = clean(assignment.partner);
  return {
    jobId: clean(assignment.jobId),
    lotId,
    model: clean(lot && lot.model) || '(型式なし)',
    // 決まり12: 型式に必ずテンプレ名を添える。lots(正規化済み)は全ロットで templateId を運んでいる。
    tplName: tplNameOf(templatesById, lot && lot.templateId),
    // 決まり14-4（2026-09-03）: 指図。normalized.lots が運ぶ orderNo をそのまま（Codex 129ee00 から接いだ2行の1つ目）。
    orderNo: clean(lot && lot.orderNo),
    dueLineMs: isNum(lot && lot.dueLineMs) ? lot.dueLineMs : null,
    startMs,
    endMs,
    workMs: endMs - startMs,
    stepCount: 1,
    partner,
    worker,
    withWorker: worker === clean(name) ? partner : worker,
  };
};

const modelMapOf = (lots) => {
  const out = new Map();
  (Array.isArray(lots) ? lots : []).forEach((lot) => {
    const lotId = lotIdOf(lot);
    if (lotId) out.set(lotId, lot);
  });
  return out;
};

const workerAssignments = (assignments, name, lots, templatesById = null) => {
  const who = clean(name);
  if (!who || !Array.isArray(assignments)) return [];
  const modelByLot = modelMapOf(lots);
  return assignments
    .filter((assignment) => assignmentBelongsTo(assignment, who))
    .map((assignment) => normalizeAssignment(assignment, modelByLot, who, templatesById))
    .filter(Boolean)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.jobId.localeCompare(b.jobId));
};

/**
 * 同じ人に連続して割り付いた同じロットの工程を、型式1件の予定へまとめる。
 * 休憩をまたぐ場合があるため、表示用の作業時間は各工程の時間を足し、
 * 最初から最後までの経過時間を作業時間として扱わない。
 */
export function groupWorkerAssignments(assignments, name, lots = [], templatesById = null) {
  const who = clean(name);
  if (!who || !Array.isArray(assignments)) return [];

  const rows = workerAssignments(assignments, who, lots, templatesById);

  const groups = [];
  rows.forEach((row) => {
    const previous = groups[groups.length - 1];
    if (previous && previous.lotId === row.lotId) {
      previous.endMs = Math.max(previous.endMs, row.endMs);
      previous.workMs += row.workMs;
      previous.stepCount += 1;
      previous.jobIds.push(row.jobId);
      if (!previous.partner && row.partner) previous.partner = row.partner;
      return;
    }
    groups.push({ ...row, jobIds: [row.jobId] });
  });
  return groups;
}

/** 操業シミュレーターの「人」表示へ渡す、1人1行の現在・次・5日予定。 */
export function buildWorkerPlans({ snapshot = null, assignments = null, lots = [], nowMs = null, templatesById = null } = {}) {
  const workers = Array.isArray(snapshot && snapshot.workers) ? snapshot.workers : [];
  // 「現在」の札は snapshot.workers から作る。そこには lotId しか無いので、テンプレは lots から引く。
  const lotById = modelMapOf(lots);
  const atMs = isNum(nowMs) ? nowMs : (isNum(snapshot && snapshot.atMs) ? snapshot.atMs : null);
  const hasSchedule = Array.isArray(assignments);

  return workers.map((worker) => {
    const name = clean(worker && worker.name);
    const assignmentRows = workerAssignments(assignments, name, lots, templatesById);
    const groups = groupWorkerAssignments(assignments, name, lots, templatesById);
    const working = clean(worker && worker.state).toLowerCase() === 'working';
    const current = working ? {
      jobId: clean(worker && worker.jobId),
      lotId: clean(worker && worker.lotId),
      model: clean(worker && worker.model) || '(型式なし)',
      tplName: (() => {
        const l = lotById.get(clean(worker && worker.lotId));
        return tplNameOf(templatesById, l && l.templateId);
      })(),
      // 決まり14-4: 指図（同じ lotById から。Map を新設しない）。
      orderNo: clean((lotById.get(clean(worker && worker.lotId)) || {}).orderNo),
      stepTitle: clean(worker && worker.stepTitle) || '工程名の記録がありません',
      endMs: isNum(worker && worker.endMs) ? worker.endMs : null,
      remainingMs: isNum(worker && worker.remainingMs) ? Math.max(0, worker.remainingMs) : null,
      withWorker: clean(worker && worker.withWorker),
    } : null;

    const nextFrom = current && isNum(current.endMs) ? current.endMs : atMs;
    const next = isNum(nextFrom)
      ? assignmentRows.find((assignment) => assignment.startMs >= nextFrom) || null
      : null;
    const visibleGroups = isNum(atMs)
      ? groups.filter((group) => group.endMs > atMs)
      : groups;

    return {
      name,
      current,
      next,
      groups: visibleGroups,
      scheduledModelCount: new Set(visibleGroups.map((group) => group.lotId)).size,
      scheduledStepCount: visibleGroups.reduce((sum, group) => sum + group.stepCount, 0),
      idleReason: current ? '' : (clean(worker && worker.reason) || '現在作業していない理由が取れていません'),
      hasSchedule,
    };
  });
}

export default buildWorkerPlans;
