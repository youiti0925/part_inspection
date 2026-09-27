// =============================================================================
//  opsim/SharedWorkerStrip.jsx — 両方の工場で働ける人を「どちらに置くか」で引き直す1行(決まり30・2026-09-05)
// -----------------------------------------------------------------------------
//  答える1行:「今週、この人はどちらの工場に居るべきか」
//  ・両方の名簿に同じ名前が在る人(いまは村さん1人)を、押した時だけ 2通り(この工場に置く／向こうに置く)で
//    **実際に割付を引き直す**(引き算で作らない)。数え方は はしご と同じ measureRun。
//  ・向こうの工場で何が起きるかは、向こうの同じ帯で見る(両方を1画面に並べる棚は清水さんの承認の後)。
//  🚨 数字を作らない。名簿が読めていない時は「読めていません」と言う(0人と混ぜない)。
// =============================================================================

import React from 'react';
import { Loader2, Play, Users } from 'lucide-react';
import { sharedWorkerNames, buildSharedWorkerPlans, measureSharedRuns, SHARED_KEY } from '../domain/operationsSimulation/sharedWorker.js';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const fmtInt = (n) => (num(n) == null ? '—' : Math.round(Number(n)).toLocaleString('ja-JP'));
const fmt1 = (n) => (num(n) == null ? '—' : (Math.round(Number(n) * 10) / 10).toLocaleString('ja-JP'));
const signed = (n) => (num(n) == null ? '—' : (n > 0 ? `+${fmtInt(n)}` : fmtInt(n)));

/**
 * @param {object} p
 * @param {Array} p.hereWorkers   この工場の名簿({name})
 * @param {Array|null} p.thereNames 向こうの名簿の名前。null=まだ読めていない
 * @param {string[]} [p.pausedNames] 休止中
 * @param {string} p.hereLabel   例 '製品検査'
 * @param {string} p.thereLabel  例 '最終検査'
 * @param {number} p.nowMs
 * @param {number} p.horizonDays いま盤が回している営業日数
 * @param {Function} p.worksOnDay
 * @param {Function} p.runRung   (plan) => Promise<{normalized, simResult, tookMs}>  ※はしごと同じ
 * @param {string} [p.inputKey] 盤が回した **入力の指紋**。これが変わったら、前に出した2通りは別の話なので捨てる
 * @param {Function} [p.disposeRun]
 * @param {boolean} [p.disabled]
 */
export function SharedWorkerStrip({
  hereWorkers = [], thereNames = null, pausedNames = [], hereLabel = 'この工場', thereLabel = '向こうの工場',
  nowMs = null, horizonDays = null, untilMs = null, worksOnDay = null, runRung = null, disposeRun = null, disabled = false,
  inputKey = '',
}) {
  const shared = React.useMemo(
    () => sharedWorkerNames({ hereWorkers, thereNames, pausedNames }),
    [hereWorkers, thereNames, pausedNames],
  );
  const [who, setWho] = React.useState('');
  const name = who || shared.names[0] || '';
  const [busy, setBusy] = React.useState(false);
  const [step, setStep] = React.useState(0);
  const [out, setOut] = React.useState(null);
  const [error, setError] = React.useState('');
  const aliveRef = React.useRef(true);
  // 🚨 StrictMode(開発時)は effect を 付けて→外して→付け直す。cleanup だけ書くと初回で false になり、
  //   引き直しが終わっても busy が戻らず「引き直しています（1／2）」のまま止まる(実画面で確認 2026-09-05)。
  React.useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
  // ── 🕰 古い結果を捨てる(2026-09-07) ─────────────────────────────────────────
  //  土俵(groundKey)に **盤が回した入力の指紋**(inputKey)も混ぜる。名前・基準時刻・日数が
  //  同じでも、ロット・名簿・設定が変われば 前に出した2通りの件数は **別の話** になる。
  //  さらに「世代の札」(epochRef)を持ち、引き直しの途中で土俵が変わったら **その回の結果は
  //  置かない**。aliveRef だけでは、画面が生きたまま入力だけ変わった時に古い件数が残った。
  const epochRef = React.useRef(0);
  const groundKey = [name, nowMs, horizonDays, inputKey].join('|');
  React.useEffect(() => { epochRef.current += 1; setOut(null); setError(''); }, [groundKey]);

  const run = React.useCallback(async () => {
    if (typeof runRung !== 'function' || !name || num(nowMs) == null) return;
    const plans = buildSharedWorkerPlans({ name, nowMs, horizonDays: horizonDays || 5, untilMs, worksOnDay, hereLabel, thereLabel });
    if (!plans.length) return;
    // 🚨 この回の世代。土俵が変わると上の effect が epochRef を進めるので own と食い違う。
    const own = ++epochRef.current;
    setBusy(true); setError(''); setOut(null); setStep(0);
    const runs = [];
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    try {
      for (let i = 0; i < plans.length; i += 1) {
        setStep(i + 1);
        const got = await runRung(plans[i], i);
        if (!aliveRef.current || own !== epochRef.current) return;
        runs.push({ key: plans[i].key, label: plans[i].label, horizonDays: plans[i].horizonDays, normalized: got ? got.normalized : null, simResult: got ? got.simResult : null, tookMs: got ? got.tookMs : null });
      }
      const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
      if (!aliveRef.current || own !== epochRef.current) return;
      setOut({ ...measureSharedRuns({ runs, nowMs }), seconds: t1 > t0 ? (t1 - t0) / 1000 : null, plans });
    } catch (e) {
      if (aliveRef.current && own === epochRef.current) setError((e && e.message) ? String(e.message) : '引き直しに失敗しました');
    } finally {
      if (typeof disposeRun === 'function') { try { disposeRun(); } catch { /* 畳めなくても止めない */ } }
      // 🚨 busy を戻す所だけは 世代の札を見ない(aliveRef だけ)。busy は「結果」ではなく
      //   「いま回しているか」の札で、回している間はボタンが押せない＝同時に2本は走らない。
      //   ここで own を見て飛ばすと、途中で土俵が変わった回は busy が true のまま残り、
      //   「引き直しています（1／2）」から動かない帯になる(2026-09-05 に実画面で見た形)。
      if (aliveRef.current) { setBusy(false); setStep(0); }
    }
  }, [runRung, name, nowMs, horizonDays, untilMs, worksOnDay, hereLabel, thereLabel, disposeRun]);

  const here = out && out.here; const away = out && out.away;
  const cell = (m) => (m && m.measured
    ? <>遅れ <b className="text-base tabular-nums">{fmtInt(m.count)}件</b><span className="text-2xs text-slate-500">（この先で遅れる {fmtInt(m.forecastLate)}・納期があるのに手が付かない {fmtInt(m.unresolvedDue)}）</span></>
    : <span className="text-slate-400">出せませんでした</span>);

  return (
    <section
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs"
      data-opsim-shared-worker={shared.ready ? String(shared.names.length) : 'unknown'}
      data-opsim-shared-name={name}
    >
      <span className="inline-flex items-center gap-1 font-black text-slate-900"><Users className="h-4 w-4" />両方の工場で働ける人</span>
      {!shared.ready ? (
        <span className="text-slate-500">{thereLabel}の名簿はまだ読めていません（読めると、同じ名前の人がここに出ます）</span>
      ) : shared.names.length === 0 ? (
        <span className="text-slate-500">両方の名簿に同じ名前の人は居ません（{hereLabel} {fmtInt(shared.hereCount)}人／{thereLabel} {fmtInt(shared.thereCount)}人）</span>
      ) : (
        <>
          {shared.names.length > 1 ? (
            <select value={name} onChange={(e) => setWho(e.target.value)} className="rounded border border-slate-300 bg-white px-1 py-0.5 text-xs font-bold" aria-label="どの人を動かすか">
              {shared.names.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          ) : <b className="text-slate-900">{name}</b>}
          <span className="text-slate-500">（名前の一致で決めています。{hereLabel} {fmtInt(shared.hereCount)}人／{thereLabel} {fmtInt(shared.thereCount)}人）</span>
          <button
            type="button"
            onClick={run}
            disabled={disabled || busy || !name}
            data-opsim-shared-run=""
            title={`${name}さんを「${hereLabel}に置く」「${thereLabel}に置く（${hereLabel}では この期間 休み）」の2通りで、割付を実際に引き直します。何も保存しません。`}
            className={`inline-flex min-h-11 items-center gap-1 rounded-lg border-2 px-2.5 text-xs font-black ${disabled || busy ? 'border-slate-300 bg-slate-100 text-slate-400' : 'border-cyan-600 bg-cyan-600 text-white hover:bg-cyan-700'}`}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {busy ? `引き直しています（${step}／2）` : `${name}さんを どちらに置くかで引き直す（2通り）`}
          </button>
          {error ? <span className="font-bold text-rose-700">{error}</span> : null}
          {out ? (
            <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-200 pt-1" data-opsim-shared-result={out.sameWindow ? '1' : '0'}>
              <span data-opsim-shared-cell={SHARED_KEY.HERE}><b className="text-slate-800">{hereLabel}に置く</b> → {cell(here)}</span>
              <span data-opsim-shared-cell={SHARED_KEY.AWAY}><b className="text-slate-800">{thereLabel}に置く</b><span className="text-2xs text-slate-500">（{hereLabel}では休み）</span> → {cell(away)}
                {out.sameWindow && num(out.delta.count) != null ? <b className={`ml-1 tabular-nums ${out.delta.count > 0 ? 'text-rose-700' : out.delta.count < 0 ? 'text-emerald-700' : 'text-slate-600'}`}>（{signed(out.delta.count)}件）</b> : null}
              </span>
              {!out.sameWindow ? <span className="text-2xs text-rose-700">窓の端が違うので差は出しません</span> : null}
              {num(out.seconds) != null ? <span className="text-2xs text-slate-500 tabular-nums">（{fmt1(out.seconds)}秒・2回とも本当に引き直した数）</span> : null}
              <span className="w-full text-2xs text-slate-500">
                ⚠ {thereLabel}側で何が変わるかは、{thereLabel}の同じ帯で見てください。両方を1つの画面に並べる棚は、清水さんの承認の後に作ります。
              </span>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

export default SharedWorkerStrip;
