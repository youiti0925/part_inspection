/** Read-only adapter. Input is normalizeInput's output, NOT raw Firestore data.
 * It lists actual jobs (unit/once-per-lot), never quantity copies or invented durations.
 * Phase profiles are a NEW explicit contract: the current app does not provide them yet.
 */
const finite = x => typeof x === 'number' && Number.isFinite(x);
const text = x => typeof x === 'string' ? x : '';
export function buildInspectionCatalog({ normalized, templateLabels = {}, phaseProfiles = {}, snapshotId }) {
  if (!text(snapshotId)) throw new Error('固定入力の snapshotId が必要です');
  if (!Array.isArray(normalized?.jobs) || !Array.isArray(normalized?.lots)) throw new Error('normalizeInputのlots/jobsが必要です');
  const lots = new Map(normalized.lots.map(l => [l.lotId, l]));
  const seen = new Set();
  return normalized.jobs.map(job => {
    if (!text(job.jobId) || seen.has(job.jobId)) throw new Error('工程IDが欠損または重複しています');
    seen.add(job.jobId);
    const lot = lots.get(job.lotId);
    if (!lot) throw new Error('工程に対応するロットがありません');
    const step = lot.steps?.find(s => s.stepId === job.stepId && s.index === job.stepIndex)
      ?? lot.steps?.find(s => s.stepId === job.stepId);
    const issues = [];
    if (!step) issues.push('工程の根拠なし');
    if (!finite(job.arrivalMs)) issues.push('この台の到着未定');
    if (!finite(job.durationMs) || job.durationKnown === false) issues.push('工程時間不明');
    const phase = phaseProfiles[job.jobId];
    // A phase profile must identify precisely the same lot/unit/job snapshot.
    const validPhase = phase && phase.snapshotId === snapshotId && phase.jobId === job.jobId
      && finite(phase.autoRemainingMs) && phase.autoRemainingMs > 0
      && finite(phase.finishWorkMs) && phase.finishWorkMs > 0
      && typeof phase.mayLeave === 'boolean' && text(phase.source?.kind)
      && text(phase.source?.ref);
    if (!validPhase) issues.push('離席可能な自動残り・終了対応の根拠なし');
    return {
      snapshotId, jobId: job.jobId, lotId: lot.lotId, model: lot.model,
      templateId: lot.templateId, templateName: text(templateLabels[lot.templateId]) || 'テンプレ名未取得',
      orderNo: lot.orderNo, lotQuantity: lot.quantity, unitIndex: job.unitIndex,
      unitLabel: job.unitIndex === null ? 'ロットに1回' : `${job.unitIndex + 1}台目`,
      stepId: job.stepId, title: step?.title || '工程不明', processKey: job.processKey,
      zoneId: job.zoneId ?? null, equipmentId: job.equipmentId ?? null,
      readyAtMs: finite(job.arrivalMs) ? job.arrivalMs : null,
      afterJobId: job.afterJobId ?? null, dueLineMs: finite(job.dueLineMs) ? job.dueLineMs : null,
      durationMs: finite(job.durationMs) && job.durationKnown !== false ? job.durationMs : null,
      estimate: { source: step?.estimateSource ?? 'missing', confidence: step?.estimateConfidence ?? null,
        sampleCount: step?.estimateSampleCount ?? null, groupLevel: step?.estimateGroupLevel ?? null,
        why: step?.estimateWhy ?? '' },
      phase: validPhase ? structuredClone(phase) : null, issues,
      // Being listed is not permission to start. Engine must check skill, predecessors,
      // per-lot barriers, equipment and calendars at the proposed start instant.
      readinessEvaluated: false,
    };
  });
}
export function selectRegisteredJobs(catalog, selectedJobIds) {
  if (!Array.isArray(selectedJobIds) || selectedJobIds.length < 2) throw new Error('比較する工程を2件以上選んでください');
  if (new Set(selectedJobIds).size !== selectedJobIds.length) throw new Error('同じ台・工程が重複しています');
  const map = new Map(catalog.map(j => [j.jobId, j]));
  const out = selectedJobIds.map(id => { if (!map.has(id)) throw new Error('登録されていない工程です'); return structuredClone(map.get(id)); });
  if (new Set(out.map(j => j.snapshotId)).size !== 1) throw new Error('異なる時点の入力を混ぜられません');
  return { kind: 'registered-job-selection', snapshotId: out[0].snapshotId, jobs: out,
    productionEligible: false, needsWholeScheduleReplay: true };
}
