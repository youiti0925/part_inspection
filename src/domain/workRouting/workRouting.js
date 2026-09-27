// Execution area is separate from order ownership. No transport/setup allowance.
// Drafts never change an assignment. An engine candidate must pass the audit below.
import { taskKey as canonicalTaskKey } from '../planControl/planControl.js';
export const AREAS = Object.freeze({ product: '製品検査', final: '最終検査', parts: '部品検査' });
const nonempty = x => typeof x === 'string' && x.trim().length > 0;
const interval = x => x && Number.isFinite(x.startMs) && Number.isFinite(x.endMs) && x.endMs > x.startMs;
const overlaps = (a, b) => a.startMs < b.endMs && b.startMs < a.endMs;
export const routeId = (app, taskKey) => JSON.stringify([app, taskKey]);

export function makeRouteDraft({ plan, taskKey, executionArea, workerId = null, equipmentId = null, nowMs }) {
  const task = plan?.tasks?.find(t => t.key === taskKey);
  if (!AREAS[plan?.context?.app] || !AREAS[executionArea]) throw new Error('実施エリアを確認してください');
  if (!task || !nonempty(task.definition) || !nonempty(plan.source?.inputKey)) throw new Error('工程の計算元が確認できません');
  if (task.workState !== 'waiting') throw new Error('着手済み・完了済み・状態不明の工程は移動できません');
  if (executionArea === plan.context.app) throw new Error('元のエリアへ戻す場合は移動案を取り消してください');
  if (![workerId, equipmentId].every(v => v === null || nonempty(v))) throw new Error('担当者・設備の識別情報が不正です');
  if (!Number.isFinite(nowMs)) throw new Error('保存時刻が確認できません');
  return validateDraft({ version: 1, id: routeId(plan.context.app, task.key), status: 'draft', ownerArea: plan.context.app,
    executionArea, taskKey: task.key, lotId: task.lotId, templateId: task.templateId, stepId: task.stepId,
    unitIndex: task.unitIndex, definition: task.definition, sourceInputKey: plan.source.inputKey,
    fromMs: plan.context.fromMs, toMs: plan.context.toMs, workerId, equipmentId, updatedAt: nowMs,
    model: task.model, variant: task.variant, orderNo: task.orderNo, processLabel: task.processLabel });
}

export function validateDraft(d) {
  if (d?.version !== 1 || !['draft', 'cancelled'].includes(d.status) || !AREAS[d.ownerArea]
    || !AREAS[d.executionArea] || d.ownerArea === d.executionArea || !nonempty(d.taskKey)
    || d.id !== routeId(d.ownerArea, d.taskKey) || !nonempty(d.definition) || !nonempty(d.sourceInputKey)
    || !interval({ startMs: d.fromMs, endMs: d.toMs }) || !Number.isFinite(d.updatedAt)
    || ![d.workerId, d.equipmentId].every(v => v === null || nonempty(v))) throw new Error('移動案を読み取れません');
  if (canonicalTaskKey(d) !== d.taskKey) throw new Error('工程・対象台の識別情報が一致しません');
  return d;
}

// Global IDs and actual occupied segments are required: elapsed bars spanning a
// holiday must not be mistaken for working intervals. This validates, not schedules.
export function auditRouteCandidate({ draft, plan, resources, candidate }) {
  const reasons = [];
  try { validateDraft(draft); } catch (e) { return { ok: false, reasons: [e.message] }; }
  const task = plan?.tasks?.find(t => t.key === draft.taskKey);
  if (draft.status !== 'draft') reasons.push('移動案は取り消されています');
  if (!task || task.workState !== 'waiting') reasons.push('未着手であることを確認できません');
  if (plan?.context?.app !== draft.ownerArea || plan?.source?.inputKey !== draft.sourceInputKey
    || task?.definition !== draft.definition || plan?.context?.fromMs !== draft.fromMs || plan?.context?.toMs !== draft.toMs)
    reasons.push('計算元が変わっています。最新の結果から選び直してください');
  if (!resources?.revision || resources?.complete !== true
    || resources?.sourceInputKeys?.[draft.ownerArea] !== draft.sourceInputKey
    || resources?.fromMs !== draft.fromMs || resources?.toMs !== draft.toMs
    || !Object.keys(AREAS).every(area => resources?.coveredAreas?.includes(area))
    || !Array.isArray(resources?.workers) || !Array.isArray(resources?.equipment)
    || !Array.isArray(resources?.reservations)) reasons.push('全エリアの勤務・設備・既存の仕事が未接続です');
  if (!candidate || candidate.resourceRevision !== resources?.revision
    || candidate.taskKey !== draft.taskKey || candidate.executionArea !== draft.executionArea
    || candidate.ownerArea !== draft.ownerArea) reasons.push('移動後の割付結果が未確認です');
  if (reasons.length) return { ok: false, reasons };
  const workers = resources.workers || [], equipment = resources.equipment || [];
  const worker = workers.find(w => w.id === candidate.workerId);
  const machine = equipment.find(e => e.id === candidate.equipmentId);
  if (!worker || workers.filter(w => w.id === candidate.workerId).length !== 1
    || !worker.qualifiedWorkIds?.includes(draft.id)) reasons.push('この工程を担当できる人として確認できません');
  if (!machine || equipment.filter(e => e.id === candidate.equipmentId).length !== 1
    || machine.area !== draft.executionArea || !machine.compatibleWorkIds?.includes(draft.id)) reasons.push('移動先で使える設備として確認できません');
  if ((draft.workerId && draft.workerId !== candidate.workerId) || (draft.equipmentId && draft.equipmentId !== candidate.equipmentId))
    reasons.push('選んだ担当者・設備と割付が一致しません');
  const segments = candidate.segments;
  if (!Array.isArray(segments) || !segments.length || !segments.every(interval)) reasons.push('作業時間帯を確認できません');
  else {
    if (segments.some((s, i) => segments.slice(i + 1).some(t => overlaps(s, t)))) reasons.push('作業時間帯が重複しています');
    for (const s of segments) {
      if (s.startMs < draft.fromMs || s.endMs > draft.toMs) reasons.push('計画の期間外です');
      if (!worker?.availability?.some(a => interval(a) && a.area === draft.executionArea && a.startMs <= s.startMs && a.endMs >= s.endMs))
        reasons.push('曜日配置・勤務時間と合いません');
      if (!machine?.availability?.some(a => interval(a) && a.startMs <= s.startMs && a.endMs >= s.endMs)) reasons.push('設備の稼働時間外です');
      for (const r of resources.reservations) {
        if (!interval(r) || !AREAS[r.ownerArea] || !nonempty(r.taskKey) || (!nonempty(r.workerId) && !nonempty(r.equipmentId))) { reasons.push('既存の割付に未確認の情報があります'); continue; }
        if (r.ownerArea === draft.ownerArea && r.taskKey === draft.taskKey) continue;
        if (!overlaps(s, r)) continue;
        if (r.workerId === candidate.workerId || r.partnerId === candidate.workerId) reasons.push('担当者が別の仕事と重複します');
        if (r.equipmentId === candidate.equipmentId) reasons.push('設備が別の仕事と重複します');
      }
    }
  }
  if (candidate.precedenceVerified !== true || candidate.durationVerified !== true) reasons.push('工程の順番・所要時間が未確認です');
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}
