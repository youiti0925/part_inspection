import React, { useRef, useState } from 'react';
import { adoptionDraft, planState } from '../../domain/fullPair/workSurface.mjs';
import './workSurface.css';

const minute = n => Number.isFinite(n) ? Math.round(n * 10) / 10 + '分' : '未確定';
const operationId = () => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
};
function Comparison({ offer }) {
  const r = offer?.comparison;
  if (r?.status !== 'ok') return null;
  return <div className="pw-comparison"><p>{offer.conditional ? '到着予定どおりの場合' : '現在の状態から'}、残り全台の完了まで</p>
    <div className="pw-metrics"><span>順次処理<b>{minute(r.baseline.metrics.totalMin)}</b></span><span>組合せ案<b>{minute(r.paired.metrics.totalMin)}</b></span><span>全体の短縮<b>{minute(r.savingsMin)}</b></span></div>
    <div className="pw-table"><table><thead><tr><th>対象</th><th>順次で完了</th><th>組合せで完了</th><th>差</th></tr></thead><tbody>{offer.lots.map(l => <tr key={l.id}><th>{l.label}</th><td>{minute(r.baseline.metrics.lotEnds[l.id])}</td><td>{minute(r.paired.metrics.lotEnds[l.id])}</td><td>{r.completionDelta[l.id] > 0 ? '遅くなる ' : '早くなる '}{minute(Math.abs(r.completionDelta[l.id]))}</td></tr>)}</tbody></table></div>
    <details><summary>最後の台までの作業・移動を確認する</summary><div className="pw-table"><table><thead><tr><th>経過時間</th><th>対象</th><th>作業</th></tr></thead><tbody>{[...r.paired.jobs, ...r.paired.worker.filter(e => e.kind === 'travel')].sort((a,b) => a.start - b.start).map((j,i) => <tr key={j.id || 'travel-' + i}><td>{minute(j.start)} → {minute(j.end)}</td><td>{j.lotId} {j.unit == null ? '' : j.unit + 1 + '台目'}</td><td>{j.kind === 'travel' ? j.from + ' → ' + j.to : j.label}{j.continued ? '（継続）' : ''}</td></tr>)}</tbody></table></div></details>
    {offer.searchLimited && <p>探索した範囲の候補です。最適な順序の証明ではありません。</p>}
    {!!offer.warnings.length && <p className="pw-note">{offer.warnings.join(' / ')}</p>}
  </div>;
}

export function PairMapHint({ offer, plan, onReview, calculating = false }) {
  if (calculating) return <span className="pw-chip">組合せを確認中</span>;
  if (plan?.status === 'active') return <button type="button" className="pw-chip" onClick={onReview}>A＋Bの計画を確認</button>;
  if (!offer?.canAdopt) return null;
  return <button type="button" className={'pw-chip ' + (offer.conditional ? 'pw-conditional' : '')} onClick={onReview}>{offer.conditional ? '到着後の組合せ候補' : '並列作業の候補'} · {minute(offer.comparison.savingsMin)}短縮の見込み</button>;
}

/** Embed above the EXISTING task controls. This component does not duplicate
 * the app's start/finish buttons and never writes a task on screen navigation. */
export function PairWorkPanel({ input, observation, workerId, plan, calculation, onAdopt = null, onOpenLot = null, onPause = null, onReportMissing = null }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef(false);
  const { offer, decision, calculating } = calculation;
  const state = planState({ plan, input, observation, workerId });
  const invoke = async fn => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try { const result = await fn(); if (result?.ok !== true) setError(result?.reason || '操作を確認できませんでした'); }
    catch (e) { setError(String(e.message || e)); }
    finally { pending.current = false; setBusy(false); }
  };
  const adopt = () => invoke(async () => {
    const draft = adoptionDraft({ offer, input, observation, workerId, operationId: operationId() });
    return draft.ok ? onAdopt(draft.draft) : draft;
  });
  const event = state.active && decision?.next;
  const nextJob = input.jobs.find(j => j.id === event?.jobId);
  const nextLot = event?.kind === 'travel' ? input.lots.find(l => l.location === event.to) : input.lots.find(l => l.id === nextJob?.lotId);
  const nativeTarget = input.jobs.find(j => j.lotId === nextLot?.id)?.sourceLotId;
  const running = input.jobs.filter(j => j.kind === 'auto' && observation.records?.[j.id]?.status === 'processing');
  return <section className="pw-panel" aria-label="並列作業の案内"><div className="pw-panel-title"><h2>{state.complete ? '計画の全作業が完了' : state.active ? '採用した計画 · 次の一手' : 'このロットとの組合せ候補'}</h2><span>{plan ? `担当 ${plan.workerId}` : '採用前'}</span></div>
    {calculating ? <p role="status">最新の到着・実績から計算しています。既存の作業記録は変わりません。</p> : calculation.error ? <p role="alert">{calculation.error}</p> : <>
      {plan && !state.active && <p className="pw-warning">{state.reason}</p>}
      {running.length > 0 && <div className="pw-running">{running.map(j => <p key={j.id}><b>{j.lotId} {j.unit + 1}台目：自動運転中</b> · {observation.records[j.id].expectedEndMin > observation.asOfMin ? '終了見込みまで ' + minute(observation.records[j.id].expectedEndMin - observation.asOfMin) : '終了または残時間の確認が必要'}</p>)}</div>}
      {(decision?.missing || []).map(id => <div className="pw-warning" key={id}><b>{id}は未到着</b>。届いているロットを進めます。<button type="button" disabled={busy || !onReportMissing} onClick={() => invoke(() => onReportMissing(id, observation.revision))}>物がないと知らせる</button></div>)}
      {state.active ? <>
        <p>{decision?.message || decision?.errors?.join(' / ')}</p>
        {event && <div className="pw-next"><b>{event.kind === 'travel' ? `${event.from} → ${event.to}へ移動${event.purpose === 'check-auto' ? 'して終了を確認' : ''}` : `${nextJob?.lotId} ${nextJob?.unit == null ? '共通工程' : nextJob.unit + 1 + '台目'}：${nextJob?.label}`}</b><p>工程の開始・終了は、下の通常の作業欄で操作します。</p><button type="button" disabled={busy || !onOpenLot || !nativeTarget} onClick={() => invoke(() => onOpenLot(nativeTarget, observation.revision))}>{nextLot?.id}の作業画面を開く</button></div>}
        <details><summary>残作業の前後比較</summary><Comparison offer={offer} /></details>
        <button type="button" disabled={busy || !onPause} onClick={() => invoke(() => onPause(plan.id, observation.revision))}>並列作業の案内を中断する</button>
        <p className="pw-note">案内の中断では、自動運転・工程・実績を終了しません。</p>
      </> : !state.complete && <>
        <Comparison offer={offer} />
        {!!offer?.errors.length && <p className="pw-warning">{offer.errors.join(' / ')}</p>}
        <button type="button" className="pw-primary" disabled={busy || !onAdopt || !offer?.canAdopt} onClick={adopt}>{offer?.conditional ? '到着までは単独で進める計画として採用' : 'この組合せで進める'}</button>
        <p className="pw-note">採用すると、マップと自分の作業リストにも同じ計画を表示します。</p>
      </>}
    </>}
    {busy && <p role="status">保存・画面切替を確認しています…</p>}{error && <p role="alert" className="pw-warning">{error}</p>}
  </section>;
}

export function PairPersonalList({ plan, observation, decision, planStatus, onOpenLot }) {
  if (!plan) return <section className="pw-panel"><h2>自分の作業</h2><p>並列作業の計画はまだ採用していません。通常の担当ロットを表示する場所です。</p></section>;
  return <section className="pw-panel"><h2>自分の作業 · {plan.workerId}</h2><p>同じ計画：{plan.id} ／ {planStatus?.complete ? '全作業完了' : planStatus?.active ? '案内中' : '案内停止・確認が必要'}</p>
    {planStatus && !planStatus.active && <p className="pw-warning">{planStatus.reason}</p>}
    <p>{decision?.message || '最新の作業状態を確認しています'}</p>
    {plan.lotIds.map((id, i) => <div className="pw-list-row" key={id}><span><b>{plan.inputSnapshot.lots[i].label}</b> · {observation.arrivals[plan.inputSnapshot.lots[i].id]?.status === 'arrived' ? '到着済み' : '未到着'}</span><button type="button" onClick={() => onOpenLot(id)}>作業画面へ</button></div>)}
    <p className="pw-note">一覧の操作だけで工程を開始・完了しません。</p>
  </section>;
}
