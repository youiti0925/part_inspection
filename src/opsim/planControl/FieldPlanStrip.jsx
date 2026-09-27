import React, { useMemo } from 'react';
import { changesForWorker, fieldPlanLine, newerVersionNotice } from '../../domain/planControl/fieldOrders.js';
import { reviewBadge } from '../../domain/planControl/planReview.js';

/* 👷 2026-09-22 現場の指示の元を「採用中の版」にする帯。既存の「今日の指示」の上に置く。
   🚨 新しい試算を現場の指示にしない。棚の head を購読し、新しい版が保存されたら札で伝える(勝手に差し替えない)。
   渡す物: planShelf(棚の口) / app / workerNames / dayStartMs・dayEndMs(今日の窓) / onSource(割付の並びを親へ) */
const clock = n => Number.isFinite(n) ? new Date(n).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

export default function FieldPlanStrip({ adopted, workerNames = [], dayStartMs, dayEndMs, useAdopted, onToggleSource }) {
  const { plan, prev, review, headRevision, error, reload } = adopted;
  const badge = plan ? reviewBadge({ revision: plan.revision, headRevision: headRevision || plan.revision, doc: review }) : null;
  const line = fieldPlanLine({ revision: plan ? plan.revision : null, reviewLabel: badge ? badge.label : '', committedAt: plan ? plan.committedAt : null, fmt: clock });
  const notice = plan ? newerVersionNotice(plan.revision, headRevision) : (headRevision > 0 ? `第${headRevision}版が棚にあります` : '');
  const changes = useMemo(() => {
    if (!plan || !prev) return null;
    const out = {};
    for (const name of workerNames) { const c = changesForWorker(prev, plan, name, dayStartMs, dayEndMs); if (c && c.length) out[name] = c; }
    return out;
  }, [plan, prev, workerNames, dayStartMs, dayEndMs]);
  return <div className="grid gap-1 rounded border border-slate-300 bg-slate-50 p-2 text-sm" data-field-plan={plan ? plan.revision : 'none'} data-field-source={useAdopted ? 'plan' : 'trial'}>
    <div className="flex flex-wrap items-center gap-2">
      <strong>{useAdopted && plan ? line : 'いま表示しているのは今の試算です（現場の指示ではありません）'}</strong>
      {plan && onToggleSource && <button type="button" className="min-h-11 rounded border px-3" onClick={onToggleSource}>{useAdopted ? '今の試算を見る' : `第${plan.revision}版の指示を見る`}</button>}
      {!plan && headRevision === 0 && <span>まだ保存した計画がありません</span>}
    </div>
    {notice && <p role="status" className="rounded border border-amber-300 bg-amber-50 p-2" data-field-newer={headRevision}>{notice} <button type="button" className="ml-2 min-h-11 rounded border px-3" onClick={reload}>読み直す</button></p>}
    {error && <p role="alert" className="text-red-800">{error}</p>}
    {useAdopted && plan && prev && <details><summary className="min-h-11 cursor-pointer">前の版（第{prev.revision}版）からの今日の変更 {changes ? Object.values(changes).reduce((n, c) => n + c.length, 0) : 0}件</summary>
      {changes && Object.keys(changes).length === 0 && <p>今日の担当・順番・時刻・納期・場所に変更はありません。</p>}
      {changes && Object.entries(changes).map(([name, list]) => <div key={name} data-field-changes={name}><strong>{name}</strong><ul className="list-disc pl-5">{list.map(c => { const t = c.after || c.before; return <li key={c.key}>{c.labels.join('・')}：{t.model || t.lotId}｜{t.processLabel || t.stepId}{t.unitIndex === null ? '' : ` ${t.unitIndex + 1}台目`} {c.before?.assignment ? `${clock(c.before.assignment.startMs)}${c.before.assignment.worker !== name ? `（${c.before.assignment.worker}）` : ''}` : '—'} → {c.after?.assignment ? `${clock(c.after.assignment.startMs)}${c.after.assignment.worker !== name ? `（${c.after.assignment.worker}）` : ''}` : '外れた'}</li>; })}</ul></div>)}
    </details>}
    {useAdopted && plan && !prev && plan.revision === 1 && <span className="text-slate-600">最初の版です（比べる前の版はありません）</span>}
  </div>;
}
