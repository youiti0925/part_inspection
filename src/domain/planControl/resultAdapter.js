import { capturePlan, taskKey } from './planControl.js';
import { captureConditions } from './planConditions.js';
import { isDoneTask } from '../lotRemaining.js';
import { captureSubmissionEvidence } from './submissionEvidence.js';

export function canonical(value) {
  if (value == null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

// A missing task is unstarted only when its real lot and step are both present.
// Paused/rework work has already consumed preparation: protect it as prepared.
// 🚨 lot.tasks の欄が無く status==='waiting' のロットは「まだ始まっていない」だけ
//   (normalizeInput.js は無い tasks を {} と読み、planActuals.js も「記録が無い=未着手」)。
//   その時だけ {} と読む。processing/paused なのに tasks が無い・配列・知らない形は 'unverified' のまま。
function liveTaskMap(lot) {
  if (lot.tasks && typeof lot.tasks === 'object' && !Array.isArray(lot.tasks)) return lot.tasks;
  if (lot.tasks == null && lot.status === 'waiting') return {};
  return null;
}
export function liveStates(tasks, lots) {
  const byId = new Map(lots.map(l => [String(l.id), l]));
  return Object.fromEntries(tasks.map(j => {
    const lot = byId.get(j.lotId);
    const stepIndex = lot?.steps?.findIndex(s => String(s.id) === j.stepId) ?? -1;
    const liveTasks = lot ? liveTaskMap(lot) : null;
    let state = 'unverified';
    if (lot && stepIndex >= 0 && liveTasks) {
      const keys = j.unitIndex === null
        ? Object.keys(liveTasks).filter(k => k.startsWith(`${j.stepId}-lot-`))
        : [`${j.stepId}-${j.unitIndex}`, `${stepIndex}-${j.unitIndex}`];
      const found = keys.map(k => liveTasks[k]).filter(Boolean);
      if (found.some(isDoneTask)) state = 'completed';
      else if (found.some(t => t.status === 'processing')) state = 'processing';
      else if (found.some(t => ['paused', 'reworking', 'ng', 'rework-done', 'prepared'].includes(t.status))) state = 'prepared';
      else if (found.every(t => t.status === 'waiting')) state = 'waiting';
    }
    return [j.key || taskKey(j), state];
  }));
}

export function fromResult({ app, result, receipt, lots, templates = [], conditions = null }) {
  const n = result?.normalized;
  if (!receipt || !n || !Array.isArray(n.jobs) || !Array.isArray(result?.base?.assignments)) throw new Error('割付の計算完了を待ってください');
  if (!n.unknowns || typeof n.unknowns !== 'object') throw new Error('入力の確認結果がありません');
  const issues = Object.entries(n.unknowns).filter(([, rows]) => Array.isArray(rows) && rows.length)
    .map(([kind, rows]) => ({ id: kind, kind, message: `${kind}: ${rows.length}件（計算元の未確認）` }));
  for (const [kind, value] of Object.entries(n.unknowns)) {
    if (!Array.isArray(value) && value != null && value !== '' && value !== false && value !== 0)
      issues.push({ id: kind, kind, message: `${kind}: ${typeof value === 'string' ? value : '計算元の確認事項あり'}` });
  }
  const labels = Object.fromEntries(lots.map(l => [l.id, {
    model: l.model || '', variant: app === 'final'
      ? [l.specialConditions, l.appearanceNote, l.simpleSpec].filter(v => typeof v === 'string' && v.trim()).join(' / ') || '特注仕様未記載'
      : templates.find(t => t.id === l.templateId)?.name || l.templateName || 'テンプレ名未確認',
  }]));
  const p = capturePlan({ id: receipt.id, context: { app, fromMs: n.now, toMs: n.horizonEnd, schemaKey: 'engine-task-v1' },
    source: { runId: receipt.id, inputKey: receipt.key, engineVersion: receipt.engineVersion, calculatedAt: receipt.at },
    jobs: n.jobs, assignments: result.base.assignments, qualityIssues: issues,
    liveStateByKey: liveStates(n.jobs, lots), labelsByLot: labels });
  const jobs = new Map(n.jobs.map(j => [j.jobId, j]));
  const sourceLots = new Map(lots.map(l => [l.id, l]));
  p.tasks = p.tasks.map(t => {
    const l = sourceLots.get(t.lotId), j = jobs.get(t.jobId);
    const step = l?.steps?.find(s => String(s.id) === t.stepId);
    return { ...t, orderNo: l?.orderNo || '', processLabel: step?.title || j.processKey,
      definition: canonical([j.processKey, step || null]),
      estimateMs: j.durationKnown && Number.isFinite(j.durationMs) ? j.durationMs : null,
      dueMs: Number.isFinite(j.dueLineMs) ? j.dueLineMs : null };
  });
  p.evidence = captureSubmissionEvidence(result, p.tasks, labels);
  // 📐 計算した時の条件(残業・土曜・応援・曜日配置・担当固定…の切替と、基準時刻・期間・技能/工数の見方)。
  //   後で「この条件で最新データを再計算」に使う。渡されなければ null(古い版と同じ)。
  p.conditions = conditions ? captureConditions(conditions) : null;
  return p;
}
