/** NEW presentation contract for future phase-aware adopted plans.
 * Not authentication, not approval persistence, not a worker start-command endpoint.
 */
const finite = n => typeof n === 'number' && Number.isFinite(n);
export function fieldView({ plan, approval, workerId, atMs, headRevision }) {
  const refuse = reason => ({ status: 'unavailable', reason, orders: [] });
  if (!plan || plan.kind !== 'parallel-field-plan' || plan.productionEligible !== true) return refuse('実験結果は現場指示に使えません');
  if (!Number.isInteger(plan.revision) || plan.revision < 1 || !plan.id || !plan.inputSnapshotId || !plan.validationId) return refuse('計画の版または検証根拠がありません');
  if (!approval || approval.status !== 'approved' || approval.planId !== plan.id || approval.revision !== plan.revision) return refuse('この版の承認がありません');
  if (!finite(atMs) || !finite(plan.validFromMs) || !finite(plan.validUntilMs) || atMs < plan.validFromMs || atMs >= plan.validUntilMs) return refuse('計画の適用時間外です');
  if (!workerId || !Array.isArray(plan.workerEvents)) return refuse('作業者または指示がありません');
  const orders = plan.workerEvents.filter(e => e.workerId === workerId).map(e => structuredClone(e)).sort((a,b) => a.startMs-b.startMs);
  for (let i=0;i<orders.length;i++) {
    const e=orders[i];
    if (!e.jobId || !e.lotId || !finite(e.startMs) || !finite(e.endMs) || e.endMs<=e.startMs || !['work','travel','return','wait'].includes(e.kind)) return refuse('読めない作業指示があります');
    if (i && orders[i-1].endMs > e.startMs) return refuse('作業者の指示が重なっています');
  }
  return { status:'ok', planId:plan.id, revision:plan.revision, inputSnapshotId:plan.inputSnapshotId,
    orders, current:orders.find(e=>e.startMs<=atMs&&atMs<e.endMs)??null,
    next:orders.find(e=>e.startMs>atMs)??null,
    // Never silently substitute the new head. Acknowledge separately.
    newerAvailable:Number.isInteger(headRevision)&&headRevision>plan.revision,
    requiresAcknowledgement:Number.isInteger(headRevision)&&headRevision>plan.revision };
}
