import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ClipboardList, MapPin, ArrowRight } from 'lucide-react';
import { fromResult } from '../../domain/planControl/resultAdapter.js';
import { AREAS, makeRouteDraft } from '../../domain/workRouting/workRouting.js';
import { makeRouteShelfStore, routeDocId, routeFactsFromShelf, routeFactsLines, routeInputsLinesOf, workerBusyAt } from '../../domain/workRouting/routeShelf.js';
import { makeSharedPlanStore } from '../../domain/planControl/sharedPlanStore.js';

/* 🚨 2026-09-22 移動案は共有棚(端末内の IndexedDB をやめた)。口は上(App)の planShelf。無い画面では保存させない */
const control = 'min-h-11 rounded-lg border border-slate-400 bg-white px-3 py-2 text-base text-slate-900';

export default function WorkRoutingAction({ app, lotId, result, receipt, currentRunKey, loading, lots, templates = [], canEdit, planShelf = null, routeInputsByArea = null }) {
  const store = useMemo(() => (planShelf && planShelf.readRoute && planShelf.saveRoute ? makeRouteShelfStore({ readDoc: planShelf.readRoute, writeDoc: planShelf.saveRoute }) : null), [planShelf]);
  const [facts, setFacts] = useState(null);
  const dialog = useRef(null), heading = useId();
  const [open, setOpen] = useState(false), [taskKey, setTaskKey] = useState('');
  const [area, setArea] = useState('parts'), [saved, setSaved] = useState(null);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const captured = useMemo(() => {
    try { return { plan: fromResult({ app, result, receipt, lots, templates }) }; }
    catch(e) { return { error: e.message }; }
  }, [app, result, receipt, lots, templates]);
  const tasks = captured.plan?.tasks.filter(t => t.lotId === String(lotId)) || [];
  const task = tasks.find(t => t.key === taskKey);
  const current = !loading && receipt?.key === currentRunKey;
  const whenMs = task?.assignment?.startMs ?? null;
  // 移動先の事実: 各エリアの採用中の版(既存の仕事)+相手の daily_load.routeInputs(勤務時間・休み・技能の記録)。無い物は名指しで missing に
  useEffect(() => {
    const extra = { routeInputs: routeInputsByArea || {}, whenMs };
    if (!open || !planShelf || !planShelf.readHeadOf) { setFacts(open ? routeFactsFromShelf(extra) : null); return undefined; }
    let disposed = false;
    (async () => {
      const plans = {};
      for (const a of Object.keys(AREAS)) {
        try { plans[a] = await makeSharedPlanStore({ readHead: () => planShelf.readHeadOf(a), readVersion: planShelf.readVersion, commitVersion: async () => ({ ok: false }), appId: a }).read(a); }
        catch { plans[a] = null; }
      }
      if (!disposed) setFacts(routeFactsFromShelf({ adoptedPlans: plans, ...extra }));
    })();
    return () => { disposed = true; };
  }, [open, planShelf, routeInputsByArea, whenMs]);
  useEffect(() => {
    if (!open || !taskKey) return;
    if (!store) { setMessage('共有棚に繋がっていないため、移動案の保存・読み込みはできません'); return; }
    let disposed = false; setReady(false); setSaved(null); setMessage('');
    store.read(routeDocId(app, taskKey)).then(d => {
      if (disposed) return;
      setSaved(d); setArea(d?.status === 'draft' ? d.executionArea : (app === 'parts' ? 'product' : 'parts')); setReady(true);
    }).catch(e => { if (!disposed) setMessage(e.message); });
    return () => { disposed = true; };
  }, [app, taskKey, open, store]);
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);

  async function save(cancel = false) {
    setBusy(true); setMessage('');
    try {
      if (!store) throw new Error('共有棚に繋がっていません');
      if (!canEdit || !current || !ready) throw new Error('最新の計算・保存情報の読み込みを待ってください');
      const base = cancel ? saved : makeRouteDraft({ plan: captured.plan, taskKey, executionArea: area, nowMs: Date.now() });
      const { revision: _r, ...d0 } = cancel ? { ...saved, status: 'cancelled', updatedAt: Date.now() } : base;
      const r = await store.save(d0, saved?.revision || 0);
      if (!r.ok) throw new Error(r.reason);
      setSaved(r.saved); setMessage(cancel ? '移動案を取り消しました。元の割付は変わりません。' : '共有棚に移動案を保存しました（どの端末からも見えます）。納期の計算にはまだ反映していません。');
    } catch(e) { setMessage(e.message); } finally { setBusy(false); }
  }
  const stale = saved?.status === 'draft' && (saved.sourceInputKey !== captured.plan?.source.inputKey || saved.definition !== task?.definition);
  const canSave = canEdit && current && ready && !busy && task?.workState === 'waiting';
  return <>
    <button type="button" className={`${control} font-bold`} disabled={!canEdit || loading}
      onClick={() => { setTaskKey(tasks.find(t => t.workState === 'waiting')?.key || tasks[0]?.key || ''); setOpen(true); }}>
      実施エリアを選ぶ
    </button>
    {createPortal(<dialog ref={dialog} aria-labelledby={heading} onCancel={() => setOpen(false)} onClose={() => setOpen(false)}
      className="m-auto w-[min(44rem,94vw)] max-h-[90dvh] overflow-y-auto rounded-2xl border border-slate-300 bg-white p-0 text-base text-slate-900 shadow-xl backdrop:bg-slate-900/40">
      <header className="flex items-center justify-between gap-3 border-b p-4">
        <h2 id={heading} className="text-xl font-bold">この工程をどこで行うか</h2>
        <button type="button" className={`${control} shrink-0 whitespace-nowrap`} onClick={() => setOpen(false)}>閉じる</button>
      </header>
      <div className="grid gap-4 p-4">
        <div><b>{task?.model || lots.find(l => String(l.id) === String(lotId))?.model}</b><p className="break-words">{task?.variant}</p><p>指図 {task?.orderNo || '未記載'} · 所属 {AREAS[app]}</p></div>
        {captured.error ? <p role="alert">{captured.error}</p> : null}
        {!tasks.length && !captured.error ? <p>移動する未完了の工程がありません。</p> : null}
        {tasks.length ? <>
          <label className="grid gap-1 font-bold">工程・対象の台
            <select className={`${control} w-full min-w-0`} value={taskKey} onChange={e => setTaskKey(e.target.value)}>
              {tasks.map(t => <option key={t.key} value={t.key}>{t.processLabel} · {t.unitIndex === null ? 'ロット共通' : `${t.unitIndex + 1}台目`}{t.workState !== 'waiting' ? '（移動できません）' : ''}</option>)}
            </select>
          </label>
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2" aria-label="仕事の実施場所">
            <div className="rounded-xl border-2 border-slate-300 bg-slate-50 p-3 text-center"><ClipboardList aria-hidden="true" className="mx-auto h-8 w-8"/><p className="font-bold">{AREAS[app]}の仕事</p><p>指図・納期を維持</p></div>
            <ArrowRight className="h-6 w-6" aria-hidden="true"/>
            <div className="rounded-xl border-2 border-cyan-700 bg-cyan-50 p-3 text-center"><MapPin aria-hidden="true" className="mx-auto h-8 w-8"/><p className="font-bold">{AREAS[area]}で実施</p><p>対象工程だけ</p></div>
          </div>
          <fieldset><legend className="mb-2 font-bold">実施エリア</legend><div className="flex flex-wrap gap-2">
            {Object.entries(AREAS).filter(([key]) => key !== app).map(([key, label]) => <button key={key} type="button" aria-pressed={area === key} onClick={() => setArea(key)}
              className={`min-h-11 flex-1 rounded-lg border-2 px-3 py-2 text-base font-bold ${area === key ? 'border-cyan-700 bg-cyan-50 text-cyan-900' : 'border-slate-400 bg-white text-slate-900'}`}>{label}</button>)}
          </div></fieldset>
          <div className="rounded-lg border p-3" data-route-facts>
            <b>移動先の事実（共有棚に在る物だけ）</b>
            {facts ? <p>既存の仕事が読めたエリア: {facts.coveredAreas.length ? facts.coveredAreas.map(a => AREAS[a]).join('・') : 'なし'}（採用中の計画の版から） · 予約 {facts.reservations.length}件</p> : <p>読んでいます</p>}
            {facts && task?.assignment && workerBusyAt(facts, task.assignment.worker, task.assignment.startMs, task.assignment.endMs).filter(r => r.ownerArea !== app).length > 0 && <p role="alert">同じ時間に {task.assignment.worker} が別のエリアの仕事を持っています（重複）</p>}
            {facts && routeInputsLinesOf(facts, area).map(l => <p key={l} data-route-inputs>{l}</p>)}
            {facts && <details><summary className="min-h-11 cursor-pointer">なぜ再計算できないか（未接続の物）</summary><ul className="list-disc pl-5">{routeFactsLines(facts).map(l => <li key={l}>{l}</li>)}</ul><p>詳しくは docs/エリア移動_データ契約.md</p></details>}
          </div>
          <div className="rounded-lg border-2 border-slate-500 bg-slate-100 p-3"><b>計算には未反映</b><p>移動先の担当者・設備・空き時間が繋がるまで、移動後の割付と納期は出しません（推測で出さない）。</p></div>
          {saved?.status === 'draft' ? <p>保存済み：{AREAS[saved.executionArea]} · 第{saved.revision}版（共有棚）{stale ? ' ／ 計算元が変わったため再確認が必要です' : ''}</p> : null}
          {task && task.workState !== 'waiting' ? <p role="alert">着手済み・完了済み・状態不明の工程は移動できません。</p> : null}
          {!current ? <p role="alert">計算結果が更新中です。完了してから保存してください。</p> : null}
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={!canSave} onClick={() => save()} className="min-h-11 flex-1 rounded-lg border border-cyan-800 bg-cyan-800 px-3 py-2 text-base font-bold text-white disabled:opacity-50">{busy ? '保存中…' : '移動案を保存（共有棚）'}</button>
            {saved?.status === 'draft' ? <button type="button" disabled={!ready || busy || !current || !canEdit} onClick={() => save(true)} className={control}>移動案を取り消す</button> : null}
          </div>
        </> : null}
        <p role="status" aria-live="polite">{message}</p>
      </div>
    </dialog>, document.body)}
  </>;
}
