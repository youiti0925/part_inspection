import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { comparePlans, prepareAdoption } from '../../domain/planControl/planControl.js';
import { fromResult, liveStates } from '../../domain/planControl/resultAdapter.js';
import { makeSharedPlanStore } from '../../domain/planControl/sharedPlanStore.js';
import { jobLocksOf } from '../../domain/planControl/engineLocks.js';
import { conditionsDrift, restorableInputs } from '../../domain/planControl/planConditions.js';
import { REVIEW_STATUS, reviewBadge, reviewHistoryOf, reviewLineForReport, canTransition } from '../../domain/planControl/planReview.js';
import { actualRows, ACTUAL_STATE_LABELS, shiftText } from '../../domain/planControl/planActuals.js';
import { openSubmission, downloadSubmissionExcel, downloadEvidence } from './submissionReport.js';

/* 🚨 2026-09-22 保存先は **共有棚**(端末ローカルではない)。
   読み書きの口は上(App)から planShelf で受け取る。渡されない画面では保存させない
   — 端末の中へ黙って逃がすと、端末ごとに答えが変わる物を作ってしまう。 */
const clock = n => Number.isFinite(n) ? new Date(n).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '未割付';
const messages = {
  'stale-revision': '別タブで計画が更新されました。保存計画を読み直してください',
  'inputs-changed-recalculate': '条件が更新されています。計算完了を待ってください',
  'incomparable-plans': '期間または工程定義が異なります。同じ期間・定義で計算してください',
  'live-state-unverified': '実作業の状態を確認できない仕事があります',
  'existing-work-needs-baseline': '既に準備・着手した仕事があります。初回の計画保存には現場の割付との照合が必要です',
  'protected-task': '準備済み・作業中の仕事が変更されています',
  'frozen-task': '固定する時間帯の仕事が変更されています',
  'missing-task-needs-review': '前の計画から消えた仕事に完了の記録がありません',
  'completed-task-rescheduled': '完了した仕事がもう一度割り付いています',
  'acknowledgment-required': '未確認・未割付の内容を確認してください',
};
const explain = errors => [...new Set(errors.map(e => messages[e.split(':')[0]] || '計画を採用できません。再計算して確認してください'))];

export function PlanBars({ before, after, fromMs, toMs }) {
  const width = Math.max(1, toMs - fromMs);
  const x = value => Math.max(0, Math.min(100, (value - fromMs) / width * 100));
  return <div className="grid gap-1" aria-label="上段が保存計画、下段が今回の割付">
    {[before, after].map((task, i) => {
      const a = task?.assignment, due = task?.dueMs;
      return <div key={i} className="flex items-center gap-2">
        <span className="w-10 shrink-0 text-xs">{i ? '今回' : '保存'}</span>
        <div className="relative h-5 flex-1 rounded bg-slate-100">
          {a && <span className={`absolute inset-y-0 rounded border-2 border-sky-700 ${i ? 'bg-sky-200' : 'bg-white'}`}
            style={{ left: `${x(a.startMs)}%`, width: `${Math.max(0, x(a.endMs) - x(a.startMs))}%` }} />}
          {a && Number.isFinite(due) && a.endMs > due && <span className="absolute inset-y-0 bg-red-700 opacity-70"
            style={{ left: `${x(Math.max(due, a.startMs))}%`, width: `${Math.max(0, x(a.endMs) - x(Math.max(due, a.startMs)))}%` }} />}
          {Number.isFinite(due) && due >= fromMs && due <= toMs && <span title={`納期 ${clock(due)}`} className="absolute inset-y-0 border-l-2 border-red-800" style={{ left: `${x(due)}%` }} />}
        </div>
        <span className="w-16 shrink-0 break-words text-xs">{a ? `${a.worker}${a.partner ? `・${a.partner}` : ''}` : '未割付'}</span>
      </div>;
    })}
  </div>;
}

export default function PlanControlPanel({ app, result, receipt, currentRunKey, loading, lots, templates = [], canEdit, onApplyLocks, locksActive = false, rangeKey, onRestoreContext, planShelf = null,
  conditions = null, onRestoreConditions = null, restoredRevision = null }) {
  // 共有棚の口。渡されていない時は null = 読むことも保存することもしない。
  const store = useMemo(
    () => (planShelf ? makeSharedPlanStore({ ...planShelf, appId: app }) : null),
    [planShelf, app],
  );
  const [open, setOpen] = useState(false), [baseline, setBaseline] = useState(null);
  const [loaded, setLoaded] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const [ackId, setAckId] = useState(null), [page, setPage] = useState(0), [notice, setNotice] = useState('');
  const [freezeMinutes, setFreezeMinutes] = useState(60);
  const [showAll, setShowAll] = useState(false);
  // 過去版: 一覧(新しい順)と、開いている1件。🚨 開いた過去版は当時のまま出す。比較・保存には使わない
  const [history, setHistory] = useState(null), [opened, setOpened] = useState(null), [historyError, setHistoryError] = useState('');
  // ✅ 審査(提出・承認・差戻し)。保存と別。baseline の版の記録と、開いた過去版の記録
  const [review, setReview] = useState(null), [openedReview, setOpenedReview] = useState(null), [reviewNote, setReviewNote] = useState(''), [paperApprover, setPaperApprover] = useState(''), [reviewBusy, setReviewBusy] = useState(false);
  const actor = (planShelf && planShelf.actor) || '';
  const isApprover = !!(planShelf && planShelf.isApprover);
  const loadReview = useCallback((p, set) => { if (!store || !p) { set(null); return; } store.readReview(app, p.revision).then(set).catch(() => set(null)); }, [store, app]);
  const latest = useRef(null);
  const parsed = useMemo(() => {
    if (!open) return { proposal: null, error: '' };
    try { return { proposal: { ...fromResult({ app, result, receipt, lots, templates, conditions: conditions ? { ...conditions, runKey: currentRunKey } : null }), rangeKey }, error: '' }; }
    catch (e) { return { proposal: null, error: e.message }; }
  }, [open, app, result, receipt, lots, templates, rangeKey, conditions, currentRunKey]);
  // 📐 保存した条件を戻して再計算する口(Body が持つ)。無い画面ではボタンを出さない
  const restore = (p) => {
    const inputs = restorableInputs(p);
    if (!inputs || !onRestoreConditions) return false;
    if (onRestoreContext) onRestoreContext(p);
    onRestoreConditions(inputs);
    return true;
  };
  const proposal = parsed.proposal;
  const current = !!proposal && !loading && receipt?.key === currentRunKey;
  const drift = baseline && current ? conditionsDrift(baseline.conditions, currentRunKey) : null;
  const states = useMemo(() => liveStates([...(baseline?.tasks || []), ...(proposal?.tasks || [])], lots), [baseline, proposal, lots]);
  const makeOptions = () => {
    if (!canEdit || !loaded || !current) throw new Error('計算・読込が完了していないか、編集できません');
    const now = Date.now();
    return { proposal, baseline, expectedRevision: baseline?.revision || 0, headRevision: baseline?.revision || 0,
      currentInputKey: currentRunKey, liveStateByKey: states,
      freezeBeforeMs: now + freezeMinutes * 60000, actor: actor || 'この端末の計画担当', atMs: now,
      newId: crypto.randomUUID(), acknowledgedIssueIds: ackId === proposal.id ? [
        ...proposal.qualityIssues.map(q => `quality:${q.id}`),
        ...proposal.tasks.filter(t => !t.assignment && states[t.key] !== 'completed').map(t => `unscheduled:${t.key}`),
      ] : [] };
  };
  latest.current = makeOptions;
  useEffect(() => {
    if (!open) return undefined;
    let active = true; setLoaded(false); setError('');
    if (!store) { setError('共有棚に繋がっていないため、計画の保存・読み込みはできません'); return undefined; }
    store.read(app).then(p => { if (active) { setBaseline(p); setLoaded(true); loadReview(p, setReview); } }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [app, open, store, loadReview]);
  useEffect(() => { setAckId(null); setPage(0); setNotice(''); }, [receipt?.id, app]);
  let diff = null, gate = null, compareError = '';
  if (proposal && baseline) {
    try { diff = comparePlans(baseline, proposal); } catch { compareError = messages['incomparable-plans']; }
  }
  if (current && loaded && canEdit) {
    try { gate = prepareAdoption(makeOptions()); } catch (e) { compareError = e.message; }
  }
  const changedKeys = new Set(diff?.changes.map(c => c.key));
  const previous = new Map(baseline?.tasks.map(t => [t.key, t]));
  const rows = diff ? [...diff.changes, ...(showAll ? proposal.tasks.filter(t => !changedKeys.has(t.key)).map(t => ({ key: t.key, before: previous.get(t.key), after: t })) : [])]
    : (proposal?.tasks || []).map(t => ({ key: t.key, before: null, after: t }));
  const shown = rows.slice(page * 30, (page + 1) * 30);
  async function adopt() {
    setSaving(true); setError('');
    try {
      const answer = await store.adopt(app, () => latest.current());
      if (!answer.ok) throw new Error(explain(answer.errors).join('。'));
      setBaseline(answer.snapshot); setHistory(null); setOpened(null); setReview(null); setNotice(`第${answer.snapshot.revision}版を共有棚へ保存しました。前の版も残っています。どの端末からも同じ計画が見えます（現場への指示配信はまだです）`);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }
  // 🧹 2026-09-23: 閉じている時は1行(44px)だけ。上下の余白で 70px 取り、主役(納期一覧)を画面の下へ押し出していた
  return <section className={`rounded-xl border border-slate-300 bg-white ${open ? 'p-3' : 'px-3 py-0'}`} data-plan-control={app}>
    <button type="button" aria-expanded={open} onClick={() => setOpen(v => !v)} className="min-h-11 font-bold text-slate-800">{open ? '▾' : '▸'} 計画を保存・比較 <span className="text-sm font-normal">（両工場で共有）</span></button>
    {open && <div className="grid gap-3">
      <p className="text-sm text-slate-600">保存すると<b>どの端末からも同じ計画</b>が見えます。版は上書きせず残ります。現場の指示は「採用」した版から出ます（上の帯）。</p>
      <div className="flex flex-wrap items-center gap-4">
        <strong className="text-2xl">{diff ? `変更 ${diff.summary.changedTasks}件` : baseline ? `保存計画 第${baseline.revision}版` : '最初の計画'}</strong>
        {proposal && <span>{clock(proposal.context.fromMs)} ～ {clock(proposal.context.toMs)}</span>}
        {diff && <button type="button" className="min-h-11 rounded border px-3 text-sm" onClick={() => { setShowAll(v => !v); setPage(0); }}>{showAll ? '変更だけを見る' : '全工程を見る'}</button>}
      </div>
      {(!current || !loaded) && <p role="status">{parsed.error || '計算・保存計画の読込を待っています'}</p>}
      {(error || compareError) && <p role="alert" className="text-red-800">{error || compareError}</p>}
      {notice && <p role="status">{notice}</p>}
      {restoredRevision != null && <p role="status" className="rounded border border-indigo-300 bg-indigo-50 p-2 text-sm" data-plan-restored={restoredRevision}>第{restoredRevision}版の条件（残業・土曜・応援・配置・担当固定などの切替）で<b>今のロット・作業者・設定</b>を計算しています。画面の切替は効きません。
        <button type="button" className="ml-2 min-h-11 rounded border px-3" onClick={() => onRestoreConditions && onRestoreConditions(null)}>今の条件に戻す</button></p>}
      {drift && drift.length > 0 && restoredRevision === baseline?.revision && <p className="text-sm text-amber-800">保存した第{baseline.revision}版の時と違う物: {drift.map(d => d.label).join('・')}</p>}
      {baseline && (() => { const b = reviewBadge({ revision: baseline.revision, headRevision: baseline.revision, doc: review }); const act = async (status) => {
        setReviewBusy(true); setError('');
        try { const r = await store.recordReview(app, baseline.revision, { status, by: actor, atMs: Date.now(), note: reviewNote, paperApprover, isApprover, canEdit }); if (!r.ok) throw new Error(r.reason); setReviewNote(''); setPaperApprover(''); loadReview(baseline, setReview); setNotice(`第${baseline.revision}版を「${({ submitted: '提出済み', approved: '承認済み', returned: '差戻し' })[status]}」として記録しました（${actor}）`); }
        catch (e) { setError(e.message); } finally { setReviewBusy(false); } };
        const can = (to) => canTransition(b.status, to, { isApprover, canEdit }).ok;
        return <div className="grid gap-2 rounded border border-slate-300 p-2" data-plan-review={b.status}>
        <div className="flex flex-wrap items-center gap-2"><strong>第{baseline.revision}版の審査：</strong><span className={`rounded px-2 py-1 text-sm ${b.status === 'approved' ? 'bg-emerald-100 text-emerald-900' : b.status === 'submitted' ? 'bg-amber-100 text-amber-900' : b.status === 'returned' ? 'bg-red-100 text-red-900' : 'bg-slate-100'}`}>{b.label}</span>{b.approvedBy && <span className="text-sm">承認 {b.approvedBy} {clock(b.approvedAt)}</span>}</div>
        <p className="text-sm text-slate-600">保存は試算を棚に置いただけです。提出と承認はここで記録します（誰が・いつ・どの版）。承認済みの版は変えません。変更は次の版として保存します。</p>
        {reviewHistoryOf(review).length > 0 && <ul className="text-sm">{reviewHistoryOf(review).map((h, i) => <li key={i}>{clock(h.at)} {({ submitted: '提出', approved: '承認', returned: '差戻し' })[h.status] || h.status} · {h.by}{h.onPaper ? `（紙の承認・確認者 ${h.paperApprover}）` : ''}{h.note ? ` · ${h.note}` : ''}</li>)}</ul>}
        {(can('submitted') || can('approved') || can('returned')) && <div className="grid gap-2">
          <input className="min-h-11 rounded border px-2" placeholder="一言（差戻しの理由・条件など）" value={reviewNote} onChange={e => setReviewNote(e.target.value)} />
          {isApprover && b.status === 'submitted' && <input className="min-h-11 rounded border px-2" placeholder="紙で承認した場合は確認者の名前" value={paperApprover} onChange={e => setPaperApprover(e.target.value)} />}
          <div className="flex flex-wrap gap-2">
            {can('submitted') && <button type="button" className="min-h-11 rounded border px-3" disabled={reviewBusy || !actor} onClick={() => act('submitted')}>{b.status === 'returned' ? 'もう一度提出する' : '提出する（承認待ちにする）'}</button>}
            {can('approved') && <button type="button" className="min-h-11 rounded bg-emerald-700 px-3 text-white" disabled={reviewBusy} onClick={() => act('approved')}>承認する</button>}
            {can('returned') && <button type="button" className="min-h-11 rounded border px-3" disabled={reviewBusy} onClick={() => act('returned')}>差し戻す</button>}
          </div>
          {!actor && <span className="text-sm text-red-800">ログインしていないので記録できません</span>}
        </div>}
        {b.status === 'submitted' && !isApprover && <p className="text-sm">承認・差戻しは管理者が行います。</p>}
      </div>; })()}
      {baseline && (() => { let act; try { act = actualRows(baseline, lots, Date.now()); } catch (e) { return <p role="alert">実績を読めません: {e.message}</p>; }
        const order = ['late', 'running', 'completed', 'unstarted', 'unrecorded'];
        const shown = [...act.rows].filter(r => r.state !== 'unstarted').sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state)).slice(0, 40);
        return <details data-plan-actuals={baseline.revision}><summary className="min-h-11 cursor-pointer">計画と実績（第{baseline.revision}版 × 今の記録）</summary>
        <p className="text-sm text-slate-600">実績は既存の開始・停止・完了の記録だけです（ここで入力しません）。停止の理由は記録に在る物だけ。無ければ「未記録」。差は時刻の差で、理由ではありません。</p>
        <div className="flex flex-wrap gap-2 text-sm">{Object.entries(ACTUAL_STATE_LABELS).map(([k, l]) => <span key={k} className={`rounded border px-2 py-1 ${k === 'late' ? 'border-red-300 bg-red-50' : k === 'unrecorded' || k === 'unplanned' ? 'border-amber-300 bg-amber-50' : ''}`}>{l} {act.counts[k] || 0}</span>)}</div>
        {shown.length === 0 && <p className="text-sm">まだ記録が付いた工程はありません（全件 未着手）。</p>}
        {shown.length > 0 && <div className="overflow-x-auto"><table className="text-sm"><thead><tr><th className="pr-2 text-left">状態</th><th className="pr-2 text-left">工程</th><th className="pr-2 text-left">計画</th><th className="pr-2 text-left">実際</th><th className="pr-2 text-left">開始の差</th><th className="pr-2 text-left">終了の差</th><th className="text-left">停止の理由</th></tr></thead>
          <tbody>{shown.map(r => <tr key={r.key} data-actual-state={r.state}><td className="pr-2">{r.label}</td><td className="pr-2">{r.model}｜{r.processLabel}{r.unitIndex === null ? '' : ` ${r.unitIndex + 1}台目`}</td><td className="pr-2">{r.planned ? `${r.planned.worker} ${clock(r.planned.startMs)}→${clock(r.planned.endMs)}` : '未割付'}</td><td className="pr-2">{r.actual ? `${clock(r.actual.startMs)}→${r.actual.endMs != null ? clock(r.actual.endMs) : '…'}` : '—'}</td><td className="pr-2">{shiftText(r.startShiftMs)}</td><td className="pr-2">{shiftText(r.endShiftMs)}</td><td>{r.cause}</td></tr>)}</tbody></table>
          {act.rows.filter(r => r.state !== 'unstarted').length > 40 && <p className="text-sm">…ほか {act.rows.filter(r => r.state !== 'unstarted').length - 40}件</p>}</div>}
        {act.unplanned.length > 0 && <p className="text-sm">計画外に実施: {act.unplanned.slice(0, 10).map(u => `${u.lotId}/${u.taskKey}`).join('、')}{act.unplanned.length > 10 ? ' …' : ''}</p>}
        <p className="text-sm">実績を反映した後の納期の見込みは、上の「今回」（最新の試算）と保存計画の比較（納期が変更された行）で見ます。</p>
      </details>; })()}
      {baseline && <details><summary className="min-h-11 cursor-pointer">保存した第{baseline.revision}版を提出する（全件の根拠付き）</summary>
        <p className="text-sm">保存した同じ計算の納期一覧・担当・工程明細・未確認事項を出力します。現在の未保存の変更は含みません。</p>
        {!baseline.evidence && <p role="status">以前の保存版には根拠がありません。再計算して新しい版を保存してください。</p>}
        <div className="flex flex-wrap gap-2">{[['A4一枚・PDF',()=>openSubmission(baseline,true,{ reviewLine: reviewLineForReport(review, { revision: baseline.revision, headRevision: baseline.revision }) })],['詳細版・PDF',()=>openSubmission(baseline,false,{ reviewLine: reviewLineForReport(review, { revision: baseline.revision, headRevision: baseline.revision }) })],['Excel',()=>downloadSubmissionExcel(baseline,{ reviewLine: reviewLineForReport(review, { revision: baseline.revision, headRevision: baseline.revision }) })],['保存データ',()=>downloadEvidence(baseline)]].map(([label,action])=><button type="button" key={label} disabled={!baseline.evidence} className="min-h-11 rounded border px-3 disabled:opacity-40" onClick={async()=>{try { await action(); setError(''); } catch(e) {setError(e.message);} }}>{label}</button>)}</div>
      </details>}
      {store && <details data-plan-history><summary className="min-h-11 cursor-pointer" onClick={() => { if (history === null) store.history(app).then(setHistory).catch(e => setHistoryError(e.message)); }}>過去の版を開いて再出力する</summary>
        <p className="text-sm">保存した版は書き換わりません。当時の納期・担当・設定のまま出力します（今の設定は混ぜません）。</p>
        {historyError && <p role="alert" className="text-red-800">{historyError}</p>}
        {history === null && !historyError && <p role="status">版の一覧を読んでいます</p>}
        {history && history.versions.length === 0 && <p className="text-sm">まだ保存した版がありません。</p>}
        {history && <ul className="grid gap-1">{history.versions.map(v => <li key={v.revision} className="flex flex-wrap items-center gap-2 text-sm">
          <button type="button" className={`min-h-11 rounded border px-3 ${opened?.revision === v.revision ? 'bg-slate-800 text-white' : ''}`} onClick={async () => { setHistoryError(''); try { const p = await store.readRevision(app, v.revision); if (!p) throw new Error(`第${v.revision}版の本体が棚にありません`); setOpened(p); loadReview(p, setOpenedReview); } catch (e) { setHistoryError(e.message); } }}>第{v.revision}版{v.revision === history.currentRevision ? '（採用中）' : ''}</button>
          <span>{clock(v.committedAt)} · {v.committedBy || '記録なし'}{v.hasEvidence ? '' : ' · 根拠なし'}</span></li>)}</ul>}
        {opened && <div className="grid gap-2 rounded border border-slate-300 p-2" data-plan-opened={opened.revision}>
          <strong>第{opened.revision}版 {clock(opened.context?.fromMs)} ～ {clock(opened.context?.toMs)} · 工程 {opened.tasks.length}件</strong>
          <span className="text-sm" data-plan-opened-review>{reviewBadge({ revision: opened.revision, headRevision: history?.currentRevision ?? null, doc: openedReview }).label}</span>
          {!opened.evidence && <p role="status">この版には根拠がありません。出力できるのは保存データだけです。</p>}
          {restorableInputs(opened) && onRestoreConditions && <button type="button" className="min-h-11 rounded border px-3" disabled={loading} onClick={() => restore(opened)}>この版の条件で最新データを再計算（版は変わりません）</button>}
          <div className="flex flex-wrap gap-2">{(() => { const meta = { reviewLine: reviewLineForReport(openedReview, { revision: opened.revision, headRevision: history?.currentRevision ?? null }) }; return [['A4一枚・PDF',()=>openSubmission(opened,true,meta),true],['詳細版・PDF',()=>openSubmission(opened,false,meta),true],['Excel',()=>downloadSubmissionExcel(opened,meta),true],['保存データ',()=>downloadEvidence(opened),false]]; })().map(([label,action,needEv])=><button type="button" key={label} disabled={needEv && !opened.evidence} className="min-h-11 rounded border px-3 disabled:opacity-40" onClick={async()=>{try { await action(); setHistoryError(''); } catch(e) {setHistoryError(e.message);} }}>{label}</button>)}</div>
        </div>}
      </details>}
      <div className="flex flex-wrap gap-3 text-xs"><span>▱ 保存</span><span className="text-sky-800">▰ 今回</span><span className="text-red-800">│ 納期 ／ ▰ 超過時間</span></div>
      {diff && rows.length === 0 && <p className="text-sm">担当・開始・終了・納期の変更はありません。保存した工程は「全工程を見る」から確認できます。</p>}
      {shown.map(row => {
        const t = row.after || row.before;
        return <article key={row.key} data-lot-id={t.lotId} className="grid gap-1 border-b border-slate-200 py-2">
          <div className="flex flex-wrap gap-x-3 text-sm"><strong>{t.model || t.lotId}｜{t.variant || '作業内容未確認'}</strong><span>指図 {t.orderNo || '未記載'} · {t.unitIndex === null ? 'ロット1回' : `${t.unitIndex + 1}台目`} · {t.processLabel || t.stepId}</span><span>{['prepared','processing'].includes(states[t.key]) ? '🔒 着手・準備済み' : states[t.key] === 'unverified' ? '？ 実作業未確認' : ''}</span></div>
          <PlanBars before={row.before} after={row.after} fromMs={proposal.context.fromMs} toMs={proposal.context.toMs} />
          <div className="text-xs text-slate-600">保存 {clock(row.before?.assignment?.startMs)} → {clock(row.before?.assignment?.endMs)} ／ 今回 {clock(row.after?.assignment?.startMs)} → {clock(row.after?.assignment?.endMs)}</div>
          {row.changes?.includes('dueMs') && <p className="text-sm text-amber-800">納期が変更されました：{Number.isFinite(row.before?.dueMs) ? clock(row.before.dueMs) : '未確認'} → {Number.isFinite(row.after?.dueMs) ? clock(row.after.dueMs) : '未確認'}</p>}
        </article>;
      })}
      {rows.length > 30 && <div className="flex gap-3"><button className="min-h-11" disabled={!page} onClick={() => setPage(p => p-1)}>前へ</button><span>{page+1} / {Math.ceil(rows.length/30)}</span><button className="min-h-11" disabled={(page+1)*30 >= rows.length} onClick={() => setPage(p => p+1)}>次へ</button></div>}
      <details><summary className="min-h-11 cursor-pointer text-sm">比較条件・担当の固定{locksActive ? '（固定中）' : ''}</summary><div className="grid gap-3">
        <p className="text-sm text-slate-600">棒は休日を含む暦時間です。保存は共有棚の1件だけで、検査データや既存の担当固定設定は変更しません。</p>
        <div className="flex flex-wrap gap-2"><button type="button" className="min-h-11 rounded border px-3" disabled={saving} onClick={async () => {
          if (!store) { setError('共有棚に繋がっていません'); return; }
          setLoaded(false); try { const p = await store.read(app); setBaseline(p); loadReview(p, setReview); setLoaded(true); setError(''); } catch (e) { setError(e.message); }
        }} disabled={!store}>保存計画を読み直す</button>
        {baseline && onRestoreContext && <button type="button" className="min-h-11 rounded border px-3" disabled={saving || loading} onClick={() => { if (!restore(baseline)) onRestoreContext(baseline); }}>{restorableInputs(baseline) && onRestoreConditions ? '保存した条件で最新データを再計算' : '保存した基準時刻・期間で再計算'}</button>}
        {baseline && !restorableInputs(baseline) && <span className="text-sm text-slate-600">この版には条件の記録がありません（基準時刻・期間だけ戻せます）</span>}
        {!store && <span className="text-sm text-red-800">共有棚に繋がっていません（この画面からは保存できません）</span>}</div>
      <label className="text-sm">これから固定する範囲 <select value={freezeMinutes} onChange={e => setFreezeMinutes(Number(e.target.value))} className="min-h-11 rounded border px-2"><option value={0}>作業中・準備済みのみ</option><option value={60}>1時間</option><option value={120}>2時間</option></select></label>
      {onApplyLocks && <div className="flex flex-wrap items-center gap-3"><button type="button" className="min-h-11 rounded border px-3" disabled={!baseline || !current || !!compareError || saving} onClick={() => onApplyLocks(jobLocksOf(baseline, states, Date.now() + freezeMinutes * 60000))}>保存した担当を固定して再計算</button>
        {locksActive && <button type="button" className="min-h-11 rounded border px-3" disabled={saving || loading} onClick={() => onApplyLocks({})}>この試算の担当固定を外す</button>}
        <span className="text-sm">開始・終了時刻も守れたかは保存時に検査します。守れない案は採用しません。</span></div>}
      </div></details>
      {gate?.requiredAcknowledgments?.length > 0 && <details><summary className="min-h-11">未確認・未割付 {gate.requiredAcknowledgments.length}件</summary>
        <ul className="list-disc pl-5">{proposal.qualityIssues.map(q => <li key={q.id}>{q.message}</li>)}{proposal.tasks.filter(t => !t.assignment).map(t => <li key={t.key}>{t.model}｜{t.variant} · {t.processLabel}：未割付</li>)}</ul>
        <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={ackId === proposal.id} onChange={e => setAckId(e.target.checked ? proposal.id : null)} />未確認・未割付を残した案として保存する</label>
      </details>}
      {gate && !gate.ok && <ul className="text-sm text-red-800">{explain(gate.errors).map(m => <li key={m}>{m}</li>)}</ul>}
      <button type="button" className="min-h-11 rounded bg-slate-800 px-4 text-white disabled:opacity-40" disabled={!store || !gate?.ok || saving || !current || !!compareError} onClick={adopt}>{saving ? '保存中…' : 'この案を計画として保存（共有）'}</button>
    </div>}
  </section>;
}
