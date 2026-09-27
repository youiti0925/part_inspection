import React, { useState } from 'react';
import { executionIntent } from '../../domain/fullPair/arrivalExecution.mjs';

/** Integration surface: callbacks must invoke existing task/arrival handlers.
 * This component owns no Firestore writes and never changes task state optimistically. */
export default function ArrivalExecutionGuide({ input, decision, currentRevision, workerId, assignedWorkerId, nowMin,
  onExecute = null, onReportMissing = null, onConfirmLocation = null, onReplan = null, training = false }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const act = async fn => { setBusy(true); setError(''); try { const r = await fn(); if (r === false || r?.ok === false) setError(r?.reason || '記録を更新できませんでした。最新状態を確認してください'); } catch (e) { setError(String(e.message || e)); } finally { setBusy(false); } };
  const send = (job, action) => {
    const intent = executionIntent({ decision, jobId: job.id, action, currentRevision, workerId, assignedWorkerId, nowMin, input });
    if (!intent.ok) { setError(intent.reason); return; }
    act(() => onExecute(intent.command));
  };
  const ongoing = input.jobs.filter(j => decision.records?.[j.id]?.status === 'processing');
  const next = input.jobs.find(j => j.id === decision.next?.jobId);
  const start = next ? executionIntent({ decision, jobId: next.id, action: 'start', currentRevision, workerId, assignedWorkerId, nowMin, input }) : null;
  return <section className="fp-plan fp-execution" aria-label="到着に応じた作業案内">
    <p className="fp-kicker">{training ? '動作確認用・本番の記録は変更しません' : '採用した順序に沿った作業'}</p>
    <h2>{decision.mode === 'single' ? '相手を待たず、届いているロットを進める' : decision.mode === 'pair' ? '到着済みの2ロットで残作業を進める' : decision.mode === 'finish-current' ? 'いまの作業を終えてから切り替える' : decision.mode === 'done' ? '対象の作業は完了' : '到着・作業状態を確認する'}</h2>
    <p>{decision.message}</p>
    {decision.errors?.length > 0 && <p className="fp-warning">{decision.errors.join(' / ')}</p>}
    {decision.warnings?.length > 0 && <p className="fp-warning">{decision.warnings.join(' / ')}</p>}
    {(decision.missing || []).map(id => <div className="fp-arrival-row" key={id}><b>{id}：物がまだありません</b><button type="button" disabled={busy || !onReportMissing} onClick={() => act(() => onReportMissing(id))}>未到着を知らせる{training ? '（試験）' : ''}</button></div>)}
    {!onReportMissing && decision.missing?.length > 0 && <p>連絡処理への接続が必要です。現在この画面からは送信しません。</p>}
    {decision.forecastReason && <p className="fp-note">{decision.forecastReason}</p>}
    {decision.forecast?.status === 'ok' && decision.missing?.length > 0 && <div className="fp-forecast"><h3>相手が予定どおり届いた場合の見込み</h3><p>現在から残り全台の完了まで：順次処理 <b>{decision.forecast.baseline.metrics.totalMin}分</b> → 組み合わせる案 <b>{decision.forecast.paired.metrics.totalMin}分</b>（{decision.forecast.savingsMin}分短縮）</p><p>到着後に実績から組み直します。未到着の作業は開始しません。</p>{!!decision.forecast.warnings.length && <p className="fp-note">確認事項：{decision.forecast.warnings.join(' / ')}</p>}</div>}
    {decision.comparison?.status === 'ok' && <div className="fp-forecast"><h3>現在の残作業を最後まで比較</h3><p>順次処理 <b>{decision.comparison.baseline.metrics.totalMin}分</b> → 採用候補 <b>{decision.comparison.paired.metrics.totalMin}分</b>（{decision.comparison.savingsMin}分短縮）</p><p className="fp-note">試した範囲の比較です。計画全体の当初見込みと、ここから先の見込みは区別します。</p></div>}
    {ongoing.map(j => { const completion = executionIntent({ decision, jobId: j.id, action: 'complete', currentRevision, workerId, assignedWorkerId, nowMin, input }); return <div key={j.id} className="fp-action"><div><b>{j.lotId} {j.unit == null ? '共通' : j.unit + 1 + '台目'} {j.label}：{j.kind === 'auto' ? '自動運転中・終了未確認' : '作業中'}</b>
      <p>予定時刻だけでは完了にしません。既存の検査結果・完了チェックを通します。</p>
      {!completion.ok && <p>{completion.reason}</p>}
      <button type="button" disabled={busy || !onExecute || !completion.ok} onClick={() => send(j, 'complete')}>{j.kind === 'auto' ? '終了を確認して完了処理へ' : 'この作業を完了する'}{training ? '（試験）' : ''}</button></div></div>; })}
    {decision.next?.kind === 'travel' && <div className="fp-action fp-action-travel"><div><b>次は {decision.next.from} → {decision.next.to}へ移動{decision.next.purpose === 'check-auto' ? 'して自動運転の終了を確認' : ''}</b><p>片道{decision.next.end - decision.next.start}分。移動したことを確認してから次の開始を案内します。</p>{nowMin < decision.asOfMin + decision.next.start && <p>勤務時間に入ってから移動します。</p>}<button type="button" disabled={busy || !onConfirmLocation || nowMin < decision.asOfMin + decision.next.start} onClick={() => act(() => onConfirmLocation(decision.next.to, decision.next.end - decision.next.start))}>移動先に着いた{training ? '（試験）' : ''}</button></div></div>}
    {next && <div className="fp-action"><div><b>次：{next.lotId} {next.unit == null ? '共通' : next.unit + 1 + '台目'} {next.label}</b><p>{start.ok ? '到着・前工程・作業順の条件を確認しました' : start.reason}</p><button type="button" className="fp-primary" disabled={busy || !onExecute || !start.ok} onClick={() => send(next, 'start')}>この工程を開始する{training ? '（試験）' : ''}</button></div></div>}
    {!onExecute && <p className="fp-warning">既存の開始・終了処理への接続前です。案内だけでは本番の作業記録を変更しません。</p>}
    {onReplan && <button type="button" disabled={busy} onClick={() => act(onReplan)}>到着・実績の最新状態で組み直す</button>}
    {busy && <p role="status">記録の更新を確認しています…</p>}{error && <p role="alert" className="fp-warning">{error}</p>}
  </section>;
}
