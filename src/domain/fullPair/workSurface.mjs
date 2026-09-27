// One offer / one accepted plan, shared by map, task screen and personal list.
// This module writes no task status. All writes belong to the existing app.
const done = s => ['completed', 'skipped', 'rework-done'].includes(s);
// Plans are JSON documents (also used for input revision keys / persistence).
const copy = value => JSON.parse(JSON.stringify(value));
const fail = reason => ({ ok: false, reason });

export function lotBindings(input) {
  return input.lots.map(l => {
    const jobs = input.jobs.filter(j => j.lotId === l.id);
    const ids = [...new Set(jobs.map(j => j.sourceLotId))];
    return { id: l.id, label: l.label || l.id, sourceLotId: ids.length === 1 ? ids[0] : null,
      bound: jobs.length > 0 && ids.length === 1 && !!ids[0] && jobs.every(j => !!j.sourceTaskKey) && new Set(jobs.map(j => j.sourceTaskKey)).size === jobs.length };
  });
}

export function offerFor({ input, observation, decision, workerId }) {
  const lots = lotBindings(input), comparison = decision.comparison || decision.forecast;
  const conditional = !!decision.missing?.length;
  const errors = [];
  if (!workerId || observation.workerId !== workerId) errors.push('担当者を確認してください');
  if (decision.revision !== observation.revision) errors.push('最新の作業状態を計算しています');
  if (lots.some(l => !l.bound) || new Set(lots.map(l => l.sourceLotId)).size !== lots.length) errors.push('本番のロット・台・工程との対応が未確認です');
  for (const l of lots) {
    const claim = observation.claims?.[l.sourceLotId];
    if (!claim) errors.push(`${l.id}の担当・使用可否が未確認です`);
    else if (!claim.available || (claim.workerId && claim.workerId !== workerId) || (claim.planId && claim.planId !== observation.activePlanId)) errors.push(`${l.id}は他の担当・計画で使用中です`);
  }
  if (input.jobs.some(j => observation.records?.[j.id]?.status === 'processing' && observation.records[j.id].workerId !== workerId)) errors.push('作業中の工程の担当者を確認してください');
  if (input.assumptions?.length) errors.push(...input.assumptions);
  if (decision.mode === 'finish-current') errors.push('いまの手作業・監視を終えてから組合せを採用します');
  if (decision.mode === 'blocked') errors.push(...(decision.errors || ['作業状態を確認してください']));
  if (!comparison || comparison.status !== 'ok') errors.push(decision.forecastReason || '全台完了までの前後比較がまだありません');
  if (comparison?.status === 'ok') {
    if (!(comparison.savingsMin > 0)) errors.push('試した範囲では、単独の順序より短くなる案はありません');
    for (const l of input.lots) {
      if (comparison.completionDelta[l.id] > (input.maxLotDelay?.[l.id] ?? 0)) errors.push(`${l.id}の許容遅延を超えています`);
      if (comparison.paired.metrics.lateness[l.id] == null || comparison.paired.metrics.lateness[l.id] > 0) errors.push(`${l.id}の納期を確認してください`);
    }
  }
  const phase = decision.mode === 'done' ? 'done' : errors.length ? 'unavailable' : conditional ? 'conditional' : 'ready';
  return { phase, canAdopt: !errors.length, errors: [...new Set(errors)], comparison, conditional, lots, workerId,
    revision: observation.revision, asOfMin: observation.asOfMin, inputKey: JSON.stringify(input),
    // These describe the current observation; no old prediction becomes fact.
    missing: decision.missing || [], warnings: comparison?.warnings || [], searchLimited: !!comparison?.searchLimited };
}

/** Draft only. The host must atomically check revision AND acquire both lot
 * reservations before publishing this as an accepted plan. */
export function adoptionDraft({ offer, input, observation, workerId, operationId }) {
  if (!offer?.canAdopt) return fail(offer?.errors?.join(' / ') || '採用できる案がありません');
  if (offer.revision !== observation.revision || offer.inputKey !== JSON.stringify(input)) return fail('条件が変わりました。新しい比較を確認してください');
  if (!workerId || workerId !== offer.workerId || workerId !== observation.workerId) return fail('担当者が変わりました');
  if (!operationId) return fail('操作IDが必要です');
  for (const l of offer.lots) {
    const c = observation.claims?.[l.sourceLotId];
    if (!c?.available || (c.workerId && c.workerId !== workerId) || (c.planId && c.planId !== observation.activePlanId)) return fail(`${l.id}の使用状況が変わりました`);
  }
  return { ok: true, draft: { schemaVersion: 1, operationId, expectedRevision: observation.revision,
    workerId, status: 'active', lotIds: offer.lots.map(l => l.sourceLotId), adoptedAtMin: observation.asOfMin,
    inputSnapshot: copy(input), originalComparison: copy(offer.comparison), conditionalAtAdoption: offer.conditional,
    policy: { preserveRunning: true, maxLotDelay: copy(input.maxLotDelay || {}) } } };
}

export function planState({ plan, input, observation, workerId }) {
  if (!plan) return { active: false, reason: '組合せはまだ採用していません' };
  if (!plan.id || !Array.isArray(plan.lotIds) || plan.lotIds.length !== 2) return { active: false, reason: '保存済みの計画を確認してください' };
  if (plan.workerId !== workerId || observation.workerId !== workerId) return { active: false, reason: '別の担当者の計画です' };
  if (input.jobs.length && input.jobs.every(j => done(observation.records?.[j.id]?.status))) return { active: false, complete: true, reason: '対象の全台・全工程が完了しました' };
  if (plan.status !== 'active') return { active: false, reason: '並列作業の案内を中断しています。作業実績は残っています' };
  if (JSON.stringify(plan.inputSnapshot) !== JSON.stringify(input)) return { active: false, reason: '工程・時間・設備などの条件が変わりました。再確認が必要です' };
  for (const id of plan.lotIds) {
    const c = observation.claims?.[id];
    if (!c?.available || c.workerId !== workerId || c.planId !== plan.id) return { active: false, reason: '担当または計画の使用予約が変わりました。再確認してください' };
  }
  return { active: true, reason: '' };
}

/** Navigation only; must never be wired to handleStart/toggleTask. Flush errors
 * keep the old screen. Re-read AFTER flushing to avoid opening a stale target. */
export async function openLinkedLot({ targetLotId, expectedRevision, workerId, planId, flushCurrent, readCurrent, openExisting }) {
  if (!targetLotId || !workerId || !planId || !expectedRevision) return fail('画面切替の条件を確認してください');
  if (typeof flushCurrent !== 'function' || typeof readCurrent !== 'function' || typeof openExisting !== 'function') return fail('既存の作業画面への接続が必要です');
  try {
    const saved = await flushCurrent();
    if (saved?.ok !== true) return fail(saved?.reason || 'いまの画面の保存を確認できませんでした');
    const current = await readCurrent();
    if (current.revision !== expectedRevision || current.workerId !== workerId || current.plan?.id !== planId || current.plan.workerId !== workerId || current.plan.status !== 'active') return fail('保存中に記録・担当・計画が変わりました。次の作業を再確認してください');
    if (!current.plan.lotIds.includes(targetLotId)) return fail('この計画の対象ロットではありません');
    const claim = current.claims?.[targetLotId];
    if (!claim?.available || claim.workerId !== workerId || claim.planId !== planId) return fail('移動先ロットの使用予約が変わりました');
    if (current.activeManualLotId && current.activeManualLotId !== targetLotId) return fail('いまの手作業・監視を完了してから切り替えてください');
    const opened = await openExisting({ lotId: targetLotId, focusOnly: true, planId, expectedRevision });
    return opened?.ok === true ? { ok: true } : fail(opened?.reason || '作業画面を開けませんでした');
  } catch (e) { return fail(String(e.message || e)); }
}
