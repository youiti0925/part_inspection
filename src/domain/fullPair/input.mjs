/** Build precedence DAGs from full unit counts, not aggregate free-time chunks. */
export function buildPairInput({ lots, travel, startLocation, workerWindows, resources, maxLotDelay = {}, assumptions = [], origin }) {
  const errors = [], jobs = [];
  if (!Array.isArray(lots) || lots.length !== 2) return { ok: false, errors: ['2ロットが必要です'] };
  for (const lot of lots) {
    if (!Number.isInteger(lot.quantity) || lot.quantity < 1) { errors.push(`台数が不明: ${lot.id}`); continue; }
    if (!Array.isArray(lot.steps) || !lot.steps.length) { errors.push(`工程がありません: ${lot.id}`); continue; }
    const frontier = Array.from({ length: lot.quantity }, () => []);
    const built = [];
    for (let si = 0; si < lot.steps.length; si++) {
      const step = lot.steps[si];
      const units = step.lotOnce ? [null] : Array.from({ length: lot.quantity }, (_, i) => i);
      for (const unit of units) {
        const key = `${step.id}-${unit === null ? 'lot-0' : unit}`;
        const state = lot.taskStates?.[key] || 'waiting';
        if (['completed', 'skipped', 'rework-done'].includes(state)) {
          const next = lot.steps[si + 1];
          const nextKey = next ? `${next.id}-${unit === null ? 'lot-0' : unit}` : null;
          if (state !== 'skipped' && step.holdForNext && nextKey && !['completed','skipped','rework-done'].includes(lot.taskStates?.[nextKey])) errors.push(`途中の設備占有状態を確定してください: ${lot.id}/${key}`);
          continue;
        }
        if (state !== 'waiting') { errors.push(`進行中・中断・不良の残り時間を確定してください: ${lot.id}/${key}`); continue; }
        const id = `${lot.id}/${key}`;
        const deps = [...new Set(unit === null ? frontier.flat() : frontier[unit])];
        const job = { id, lotId: lot.id, label: step.label || step.id, stepId: step.id, unit,
          kind: step.kind, durationMin: step.durationMin, qualified: step.qualified,
          unattended: step.unattended, resourceId: step.resourceId || null,
          releaseMin: lot.releaseMin, deps, evidence: step.evidence || null };
        built.push({ job, si, unit, hold: step.holdForNext === true }); jobs.push(job);
        if (unit === null) for (let u = 0; u < frontier.length; u++) frontier[u] = [id];
        else frontier[unit] = [id];
      }
    }
    for (const b of built) if (b.hold) {
      const next = built.find(n => n.si === b.si + 1 && n.unit === b.unit);
      if (!next || !b.job.resourceId || next.job.resourceId !== b.job.resourceId) errors.push(`設備占有の引継先が不明: ${b.job.id}`);
      else b.job.holdFor = next.job.id;
    }
  }
  return { ok: !errors.length, errors, input: { lots: lots.map(({ id, label, location, dueMin }) => ({ id, label, location, dueMin })), jobs, travel, startLocation, workerWindows, resources, maxLotDelay, assumptions, origin } };
}

/** Explicit production bridge. This reads supplied facts only; no database access.
 * stepFacts[lotId][stepId] must contain verified resource, worker and time facts.
 * Time facts may come from existing stepTimesOf; resource identity is NOT guessed
 * from a zone or a title. A map distance alone cannot identify a machine.
 */
export function adaptProductionPair({ lots, stepFacts, releaseByLot, dueByLot, locationByLot, ...context }) {
  const errors = [];
  const mapped = (lots || []).map(l => {
    if (!Array.isArray(l.steps)) errors.push(`実工程がありません: ${l.id}`);
    const steps = (l.steps || []).map(s => {
      const f = stepFacts?.[l.id]?.[s.id];
      if (!f || f.confirmed !== true || !f.evidence || typeof f.usesEquipment !== 'boolean' || (f.usesEquipment && !f.resourceId)) errors.push(`時間・技能・設備の確認が必要: ${l.id}/${s.id}`);
      if (s.lotOnce && Object.keys(l.tasks || {}).some(k => k.startsWith(`${s.id}-lot-`) && k !== `${s.id}-lot-0`)) errors.push(`ロット1回工程に複数の実行記録があります: ${l.id}/${s.id}`);
      return { ...f, id: String(s.id), label: s.title || String(s.id), lotOnce: !!s.lotOnce };
    });
    const taskStates = {};
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      for (const u of s.lotOnce ? ['lot-0'] : Array.from({ length: Math.max(0, Number(l.quantity) || 0) }, (_, k) => k)) {
        const byId = l.tasks?.[`${s.id}-${u}`], byIndex = l.tasks?.[`${i}-${u}`];
        if (byId && byIndex && byId.status !== byIndex.status) errors.push(`工程記録のキーが競合: ${l.id}/${s.id}-${u}`);
        const t = byId || byIndex;
        if (t) taskStates[`${s.id}-${u}`] = t.status || 'unknown';
      }
    }
    if ((!l.tasks || !Object.keys(l.tasks).length) && l.status !== 'waiting') errors.push(`作業実績が未取得: ${l.id}`);
    if (l.status === 'completed') errors.push(`完了済みロットです: ${l.id}`);
    if (l.location === 'arrival' && !Number.isFinite(releaseByLot?.[l.id])) errors.push(`入荷時刻が不明: ${l.id}`);
    return { id: String(l.id), label: `${l.model || l.id} / ${l.templateId || 'テンプレ未定'} / ${l.quantity}台`, quantity: Number(l.quantity), steps, taskStates,
      location: locationByLot?.[l.id], releaseMin: releaseByLot?.[l.id], dueMin: dueByLot?.[l.id] ?? null };
  });
  if (errors.length) return { ok: false, errors };
  return buildPairInput({ ...context, lots: mapped });
}
