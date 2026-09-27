import React, { useEffect, useRef, useState } from 'react';
import { timeLabel, workerActions, travelScenarios } from '../../domain/fullPair/fieldPlan.mjs';
import './fullPair.css';
const n = value => Number.isFinite(value) ? Number(value.toFixed(1)) : '—';
const word = { manual: '手作業', auto: '自動測定', travel: '移動', idle: '人の待ち', monitor: '監視', launch: '自動開始' };
const color = { manual:'#10756c', auto:'#307ec1', travel:'#d0842b', idle:'#dbe4e9', monitor:'#9361a6', launch:'#307ec1' };
const describe = j => `${j.lotId || ''} ${j.unit === null ? 'ロット1回' : j.unit == null ? '' : `${j.unit+1}台目`} ${j.label || word[j.kind] || ''}`;
function Timeline({ plan, input, horizon, title }) {
  const rows = [{ name: '作業者', events: plan.worker.filter(e=>e.end>e.start) }, ...input.lots.flatMap(l => {
    const units = [...new Set(plan.jobs.filter(j=>j.lotId===l.id).map(j=>j.unit))].sort((a,b)=>(a??-1)-(b??-1));
    return units.map(unit=>({name:`${l.id} ${unit===null?'ロット1回':`${unit+1}台目`}`,events:plan.jobs.filter(j=>j.lotId===l.id && j.unit===unit)}));
  })];
  const detail = [...plan.jobs, ...plan.worker.filter(s=>s.kind==='travel')].sort((a,b)=>a.start-b.start || a.end-b.end);
  return <section className="fp-plan"><h3>{title} <strong>{n(plan.metrics.totalMin)}分で全台完了</strong></h3>
    <div className="fp-scroll"><div className="fp-timeline">
      <div className="fp-axis"><span>同じ開始時点から</span>{[0,.25,.5,.75,1].map(k=><b key={k} style={{left:`${k*100}%`}}>{n(horizon*k)}分</b>)}</div>
      {rows.map(row=><div className="fp-row" key={row.name}><div className="fp-label">{row.name}</div><div className="fp-track">{row.events.map((e,i)=><div key={i} className="fp-segment" style={{left:`${e.start/horizon*100}%`,width:`${(e.end-e.start)/horizon*100}%`,background:color[e.kind] || '#506070'}} title={`${describe(e)} ${n(e.start)}〜${n(e.end)}分`}><span>{e.unit!=null?`${e.unit+1}台`:word[e.kind]}</span></div>)}</div></div>)}
    </div></div>
    <details><summary>開始から最後の台が終わるまでの全手順（{detail.length}件）</summary><div className="fp-scroll"><table><thead><tr><th>開始→終了</th><th>対象</th><th>作業・自動・移動</th><th>設備</th></tr></thead><tbody>{detail.map((e,i)=><tr key={i}><td>{n(e.start)} → {n(e.end)}分</td><td>{e.lotId} {e.unit===null?'ロット1回':e.unit==null?'':`${e.unit+1}台目`}</td><td>{e.kind==='travel'?`${e.from} → ${e.to}`:`${word[e.kind]}：${e.label}`}</td><td>{e.resourceId || '—'}</td></tr>)}</tbody></table></div></details>
  </section>;
}
/** 組んだ後に 遅れてよい分を越えたロット(組合せ前との差 − 許した分)。scheduler は越えても案として返すので ここで見分ける */
const overOf = (r, input) => (r.status !== 'ok' ? [] : input.lots.map(l => ({ label: l.label || l.id, delta: r.completionDelta[l.id], allowed: input.maxLotDelay?.[l.id] ?? 0 })).filter(x => x.delta > x.allowed + 1e-6));
const cutOf = (r) => [...(r.errors || []), ...(r.warnings || [])].some(w => /探索上限/.test(w));
/** 候補の札。短くなるか・遅れてよい分の中か・途中で打ち切ったか を分けて書く(前は どれも「要確認・効果なし」だった) */
function tagOf(r, input) {
  if (r.status !== 'ok') return cutOf(r) ? '工程が多く 計算を途中で打ち切り' : '計算に入れられない条件あり';
  if (r.excludedAlternative) return `条件内の短縮案は未発見 ／ ${n(r.excludedAlternative.savingsMin)}分短縮案は完了時刻の制限超過`;
  if (!(r.savingsMin > 0)) return cutOf(r) ? '探索上限・短縮案は未発見' : '今回の探索では短縮案なし';
  const over = overOf(r, input);
  return over.length ? `${n(r.savingsMin)}分短縮 ／ ${over.map(o => `${o.label.split(' ')[0]}が${n(o.delta)}分遅れる`).join('・')}` : `${n(r.savingsMin)}分短縮 ／ 遅れてよい分の中`;
}
function headOf(r, input) {
  if (r.excludedAlternative) return '短縮案はありましたが、完了時刻の制限を超えるため採用していません';
  if (!(r.savingsMin > 0)) return cutOf(r) ? '探索上限に達しました。短縮案はまだ見つかっていません' : '今回の探索では、全体を早める案は見つかっていません';
  const over = overOf(r, input);
  return over.length ? `全体は ${n(r.savingsMin)}分早まりますが、${over.map(o => o.label).join('・')}の遅れを確認してください` : `全体の完了が ${n(r.savingsMin)}分早まる組合せです`;
}
/** Read-only, reusable UI. Parent supplies confirmed candidates; no app settings writes.
 *  2026-09-25(製品アプリへ接続): preferredKey の組を最初に出す(前は 短くなる順の先頭=選んでいない組を出していた)。
 *  候補は1組ずつ計算して 出来た物から出す。候補ごとの前提(notes)を結果の横に並べる。options は候補ごとに渡せる */
function WorkerRoute({ plan, input }) {
  const [expanded, setExpanded] = useState(false);
  const actions = workerActions(plan), shown = expanded ? actions : actions.slice(0, 8);
  return <section className="fp-plan"><h2>作業者が動く順番</h2>
    <p className="fp-note">入力条件で成立する作業順の案です。現場への指示・割付は変更していません。時刻の間には待ち・勤務外の時間も含みます。</p>
    <ol className="fp-route">{shown.map((e, i) => <li key={i} className={'fp-action fp-action-' + e.kind}>
      <span className="fp-step">{i + 1}</span><div><b>{timeLabel(e.start, input)}{e.end > e.start ? ' → ' + timeLabel(e.end, input) : ''}</b>
      <p>{e.action}</p>{e.autoEnd != null && <span>自動運転の終了：{timeLabel(e.autoEnd, input)}（その間の行動は次の行）</span>}</div>
    </li>)}</ol>
    {actions.length > 8 && <button type="button" onClick={() => setExpanded(v => !v)}>{expanded ? '最初の8件に戻す' : '最後の台が終わるまで全' + actions.length + '件を見る'}</button>}
  </section>;
}

function DistanceCheck({ input, options }) {
  const [started, setStarted] = useState(false), [state, setState] = useState(null);
  const key = JSON.stringify({ input, options });
  useEffect(() => {
    if (!started) return;
    const worker = new Worker(new URL('./fullPair.worker.mjs', import.meta.url), { type: 'module' });
    let alive = true;
    worker.onmessage = ({ data }) => { if (alive && data.requestKey === key) setState(data); };
    worker.onerror = e => { if (alive) setState({ error: e.message || '距離の比較を開始できませんでした' }); };
    const request = JSON.parse(key);
    worker.postMessage({ requestKey: key, candidates: travelScenarios(request.input, request.options) });
    return () => { alive = false; worker.terminate(); };
  }, [started, key]);
  return <section className="fp-plan"><h2>移動が長引いても効果は残るか</h2>
    <p className="fp-note">現在の片道時間・1分長い場合・3分長い場合を、それぞれ全台完了まで再計算します。限界距離や最適解の証明ではありません。</p>
    <button type="button" onClick={() => { setStarted(v => !v); setState(null); }}>{started ? '距離の再計算を閉じる' : '片道が長い3条件を比較する'}</button>
    {started && !state?.done && !state?.error && <p role="status">計算中：{state?.rows?.length || 0}／3条件</p>}
    {state?.error && <p role="alert">{state.error}</p>}
    {!!state?.rows?.length && <div className="fp-scroll"><table><thead><tr><th>条件</th><th>組む前</th><th>組んだ後</th><th>全体の短縮</th></tr></thead><tbody>
      {state.rows.map(row => <tr key={row.key}><th>{row.label}</th><td>{row.result.status === 'ok' ? n(row.result.baseline.metrics.totalMin) + '分' : '未計算'}</td><td>{row.result.status === 'ok' ? n(row.result.paired.metrics.totalMin) + '分' : '未計算'}</td><td>{row.result.status === 'ok' ? n(row.result.savingsMin) + '分' : (row.result.errors || []).join('・')}</td></tr>)}
    </tbody></table></div>}
  </section>;
}

export default function FullPairComparison({ candidates, example = false, preferredKey = null }) {
  const requestKey = JSON.stringify(candidates);
  const [state, setState] = useState(null), [selected, setSelected] = useState({ key: '', requestKey: '' });
  const [run, setRun] = useState(null);
  const workerRef = useRef(null), cache = useRef(new Map());
  useEffect(() => {
    if (!run || run.requestKey !== requestKey) return;
    const parsed = JSON.parse(requestKey);
    const worker = new Worker(new URL('./fullPair.worker.mjs', import.meta.url), { type: 'module' });
    let alive = true;
    workerRef.current = worker;
    worker.onmessage = ({ data }) => {
      if (!alive || data.requestKey !== requestKey) return;
      for (const row of data.rows || []) {
        const c = parsed.find(x => x.key === row.key);
        if (c) cache.current.set(JSON.stringify([c.input, c.options, c.errors]), row.result);
      }
      while (cache.current.size > 120) cache.current.delete(cache.current.keys().next().value);
      setState(data);
    };
    worker.onerror = e => { if (alive) setState({ requestKey, error: e.message || '計算処理を開始できませんでした', rows: [], done: true }); };
    worker.postMessage({ requestKey, candidates: parsed.map(c => ({ ...c, cached: cache.current.get(JSON.stringify([c.input, c.options, c.errors])) })) });
    return () => { alive = false; worker.terminate(); if (workerRef.current === worker) workerRef.current = null; };
  }, [requestKey, run]);
  const current = state?.requestKey === requestKey ? state : null;
  const total = candidates.length;
  const calculating = run?.requestKey === requestKey && !current?.done;
  const start = () => { setState(null); setRun({ requestKey, nonce: Date.now() }); };
  const stop = () => { workerRef.current?.terminate(); setRun(null); setState(s => ({ ...(s?.requestKey === requestKey ? s : { rows: [] }), requestKey, done: true, cancelled: true })); };
  const pick = selected.requestKey === requestKey ? selected.key : '';
  const rows = [...(current?.rows || [])].sort((a, b) => Number(b.result.recommended) - Number(a.result.recommended) || (b.result.savingsMin || 0) - (a.result.savingsMin || 0));
  const completeCount = rows.filter(row => row.result.status === 'ok').length;
  const chosen = rows.find(r => r.key === pick) || rows.find(r => r.key === preferredKey) || rows[0];
  const cand = candidates.find(c => c.key === chosen?.key);
  const r = chosen?.result, input = cand?.input, notes = cand?.notes || [];
  const over = r?.status === 'ok' ? overOf(r, input) : [];
  const shownWarnings = r?.warnings || [];
  const download = () => {
    const a = document.createElement('a'), url = URL.createObjectURL(new Blob([JSON.stringify({ schema: 'full-pair-comparison-v2', example, input, notes, result: r }, null, 2)], { type: 'application/json' }));
    a.href = url; a.download = 'full-pair-result.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="fp-results">
    <section className="fp-runbar">
      <div><h2>条件を確認して、最後まで比較</h2><p>条件変更後は前の結果を表示しません。計算・中止で現場のデータは変わりません。</p></div>
      {calculating ? <button type="button" onClick={stop}>計算を中止する</button> : <button type="button" className="fp-primary" onClick={start} disabled={!total}>{current ? '同じ条件で再表示・再計算' : total + '組を全台完了まで計算する'}</button>}
    </section>
    {calculating && <div className="fp-status" role="status">処理済み {rows.length}／{total}組（全台計算成功 {completeCount}組） / {current?.activeLabel || '計算を開始しています…'}<progress max={total || 1} value={rows.length} /></div>}
    {current?.cancelled && <p role="status">計算を中止しました。処理済み{rows.length}組を表示しています（全台計算成功 {completeCount}組、ほかは条件不足などの結果です）。</p>}
    {!current && !calculating && <p className="fp-note">未計算です。上のボタンで比較を開始してください。</p>}
    {current?.error && <p className="fp-warning" role="alert">{current.error}</p>}
    {!!rows.length && <section><h2>候補の結果（全台計算成功 {completeCount}／処理済み{rows.length}組）</h2>
      <p className="fp-note">この一覧は全台計算後の短縮順です。未計算の相手や他のAを含む、全体最適の順位ではありません。</p>
      <div className="fp-candidates">{rows.map(row => <button type="button" key={row.key} aria-pressed={row.key === chosen.key} onClick={() => setSelected({ key: row.key, requestKey })}>
        <b>{row.label}</b><span>{tagOf(row.result, candidates.find(c => c.key === row.key).input)}</span></button>)}</div></section>}
    {chosen && <>
      {r.status !== 'ok' ? <div className="fp-warning" role="status"><h2>{cutOf(r) ? '探索上限・効果は未確定です' : 'この組の効果は未計算です'}</h2><ul>{(r.errors || []).map((e, i) => <li key={i}>{e}</li>)}</ul></div> : <>
        <section className={'fp-verdict ' + (r.recommended ? 'fp-good' : 'fp-check')}><div>
          <span>{example ? '架空データでの検証' : '現場確認前の短縮候補・自動採用なし'}</span><h2>{headOf(r, input)}</h2>
          <p>{input.lots.map(l => l.label || l.id).join(' ＋ ')}</p>
          <p>{input.lots.map(l => { const d = r.completionDelta[l.id]; return l.id + '：' + (d === 0 ? '完了は変わらない' : n(Math.abs(d)) + '分' + (d < 0 ? '早い' : '遅い')); }).join(' ／ ')}</p>
        </div>{r.excludedAlternative
          ? <div className="fp-saving"><strong>{n(r.excludedAlternative.savingsMin)}<small>分短縮の案あり</small></strong><span>完了時刻の制限を超えるため未採用 ／ 条件内の案は {n(r.savingsMin)}分</span></div>
          : <div className="fp-saving"><strong>{n(r.savingsMin)}<small>分短縮</small></strong><span>全体の完了まで ／ {n(r.savingsPct)}%</span></div>}</section>
        <div className="fp-summary-grid">
          <article><span>組む前 → 組んだ後</span><b>{n(r.baseline.metrics.totalMin)} → {n(r.paired.metrics.totalMin)}分</b><small>同じ開始時点から全台完了まで</small></article>
          <article><span>移動の負担</span><b>{n(r.paired.metrics.travelMin)}分・{r.paired.metrics.travelCount}回</b><small>組む前は{n(r.baseline.metrics.travelMin)}分</small></article>
          <article><span>機械を占有したままの対応待ち</span><b>{n(r.paired.metrics.machineReturnWaitMin)}分</b><small>機械に戻るまでの待ちも計上</small></article>
        </div>
        <p className="fp-note">比較元は、ロット内の並行作業を含めてA→BまたはB→Aと順に処理する案です。すでに行っている別ロットの掛け持ちから、さらに何分改善するかを示した数字ではありません。</p>
        {r.excludedAlternative && <details className="fp-warning"><summary>未採用の参考案：全体は{n(r.excludedAlternative.savingsMin)}分早いが、完了時刻の制限を超える</summary>
          <p>{r.excludedAlternative.violations.map(v => `${v.label}：制限を${n(v.excessMin)}分超過`).join(' ／ ')}。許容遅れ・納期は変更していません。この参考案は作業指示には使いません。</p>
          <Timeline plan={r.excludedAlternative.plan} input={input} horizon={Math.max(r.baseline.metrics.totalMin, r.excludedAlternative.plan.metrics.totalMin)} title="未採用の参考案（全台完了まで）" />
        </details>}
        {over.length > 0 && <p className="fp-warning">許した遅れを超えています。この案は勧めません。</p>}
        {shownWarnings.length > 0 && <details className="fp-warning" open><summary>実行前に確かめること</summary><ul>{shownWarnings.map((w, i) => <li key={i}>{w}</li>)}</ul></details>}
        <WorkerRoute key={JSON.stringify(['route', requestKey, chosen.key])} plan={r.paired} input={input} />
        <div className="fp-scroll"><table className="fp-metrics"><thead><tr><th>比較する内容</th><th>組合せ前</th><th>組合せ後</th><th>変化</th></tr></thead><tbody>
          {[['全台完了まで', 'totalMin'], ['勤務中の人の待ち', 'workerIdleMin'], ['設備を占有したままの対応待ち', 'machineReturnWaitMin'], ['移動時間の合計', 'travelMin']].map(([label, key]) => <tr key={key}><th>{label}</th><td>{n(r.baseline.metrics[key])}分</td><td>{n(r.paired.metrics[key])}分</td><td>{n(r.paired.metrics[key] - r.baseline.metrics[key])}分</td></tr>)}
          {input.lots.map(l => <tr key={l.id}><th>{l.label || l.id}の完了</th><td>{timeLabel(r.baseline.metrics.lotEnds[l.id], input)}</td><td>{timeLabel(r.paired.metrics.lotEnds[l.id], input)}</td><td>{n(r.completionDelta[l.id])}分</td></tr>)}
        </tbody></table></div>
        <details><summary>前後の全台タイムラインを見る（同じ縮尺）</summary>
          <div className="fp-legend">{['manual', 'auto', 'travel', 'idle', 'monitor'].map(k => <span key={k}><i style={{ background: color[k] }} />{word[k]}</span>)}</div>
          <Timeline plan={r.baseline} input={input} horizon={Math.max(r.baseline.metrics.totalMin, r.paired.metrics.totalMin)} title="組合せ前" />
          <Timeline plan={r.paired} input={input} horizon={Math.max(r.baseline.metrics.totalMin, r.paired.metrics.totalMin)} title="組合せ後" />
        </details>
        {travelScenarios(input, cand?.options).length > 0 && <DistanceCheck key={JSON.stringify(['distance', requestKey, chosen.key])} input={input} options={cand?.options} />}
        <button type="button" className="fp-download" onClick={download}>条件・全手順・比較結果をJSONで保存</button>
      </>}
      <details><summary>この組の入力条件・計算の限界</summary>
        <ul className="fp-notes" data-full-pair-assumptions="1">{notes.map(t => <li key={t}>{t}</li>)}</ul>
        <p>人1人。手作業と移動は途中で分割せず、自動開始時は現地にいる条件です。組む前もロット内の並列を計算し、A→B・B→Aの早い方と比べます。</p>
        <p>探索範囲には上限があり、組む前・後とも最短時間の証明ではありません。{r.searchLimited ? '今回も探索候補を絞っています。' : ''}短縮が0分でも、ほかの順序で短縮できないとは断定しません。設備の号機・技能・実際の残時間との照合が済むまでは現場の指示として使わないでください。</p>
      </details>
    </>}
  </div>;
}
