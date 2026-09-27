// =============================================================================
//  src/opsim/RescueLadder.jsx — 「効く手」のはしご(残業・土曜で納期遅れが消えるか)
// -----------------------------------------------------------------------------
//  清水さん(2026-09-04 深夜):「残業したらとか土曜日でたら納期遅れが回避できるとかも
//                              見やすく表示できるといいな」
//
//  この帯が伝える1行(決まり21):
//    「いま遅れる◯件を、どの手で何件救えるか。救えないなら、そうと言う。」
//
//  🚨 文字を隠しても分かる物(決まり8・決まり23の採点):
//    ・赤い棒 = 危険なロットの数。**段ごとに短くなれば効いている**。
//      同じ長さのまま並ぶ = どの手も効いていない、が一目で分かる。
//    ・赤の右に伸びる緑 = その段で救えた分(基準の長さまで届く)。緑が無い = 0件。
//    ・下の細い青い棒 = その手で **増えた働ける時間**。
//      🚨 青が伸びているのに赤が縮まない＝「時間は増えたのに遅れは減らない」が絵で分かる。
//        これが今の実データの答えで、次にやる事(誰に何を教えるか)へ繋がる。
//
//  🚨 決まり(rescueLadder.js と同じ):
//    ・件数は **本当に引き直した結果** から。引き算で作らない。
//    ・0件の段を隠さない。効かない手は「効きません」と出す。
//    ・押した時だけ回す(自動で回さない)。かかった秒数は実測して札に出す。
//    ・これは仮の計算。人の同意が要る事を必ず添える。
//
//  ⚠ 計算は1行も持たない。数は rescueLadder.js(純関数)が作った物を置くだけ。
//  ⚠ 引き直しの回し方(Worker か この場か)は **呼ぶ側** が runRung で渡す。
//    製品検査と最終検査で計算の入口が違うため(暦を渡す口が別)。この部品は同じ物を使う。
//  ⚠ px を直書きしない(rem 段)。CSS の zoom / transform: scale を使わない。
// =============================================================================
import React from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Play } from 'lucide-react';
import {
  buildLadder,
  buildRungPlans,
  ladderVerdict,
  DEFAULT_OVERTIME_EXTRA_MINUTES,
  RUNG_KEY,
} from '../domain/operationsSimulation/rescueLadder.js';

const DOW = ['日', '月', '火', '水', '木', '金', '土'];

const fmtAt = (ms) => {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '—';
  const d = new Date(n);
  return `${d.getMonth() + 1}/${d.getDate()}(${DOW[d.getDay()]}) ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const fmtHours = (minutes) => {
  const n = Number(minutes);
  if (!Number.isFinite(n)) return '—';
  return `${(n / 60).toFixed(1)}時間`;
};
const fmtSec = (ms) => {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return `${(n / 1000).toFixed(1)}秒`;
};
const pct = (v) => `${Math.max(0, Math.min(100, v * 100)).toFixed(2)}%`;

/** 救えたロットの1行。品目コード｜特注仕様/テンプレ｜指図｜納期｜誰が(決まり12・決まり23④)。 */
function LotLine({ lotId, lot, workers, subOf }) {
  const model = (lot && lot.model) ? String(lot.model) : '(品目コードなし)';
  const sub = subOf ? subOf(lot, lotId) : '';
  const order = (lot && (lot.orderNo || lot.orderNumber)) ? String(lot.orderNo || lot.orderNumber) : '';
  const due = (lot && (lot.dueDate || lot.due)) ? String(lot.dueDate || lot.due) : '';
  const who = Array.isArray(workers) && workers.length ? workers.join('・') : '';
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-slate-100 py-1 last:border-b-0">
      <span className="font-bold text-slate-800">{model}</span>
      {sub ? <span className="text-slate-500">｜{sub}</span> : null}
      <span className="text-slate-500">｜指図 {order || '—'}</span>
      <span className="text-slate-500">｜納期 {due || '—'}</span>
      {/* 🚨 担当が付いていない時は名前を作らない。「まだ決まっていません」と書く。 */}
      <span className={who ? 'font-bold text-cyan-700' : 'text-slate-400'}>
        ｜{who || 'まだ決まっていません'}
      </span>
    </li>
  );
}

/**
 * 1段ぶんの行。**0件の段も必ず描く**(隠さない)。
 *
 * 🚨🚨 2026-09-05 に見つけた食い違い（ここで直した）:
 *   同じ「＋土曜も出る」でも、画面は「働ける時間 +28.0時間」、別の所で回した数は
 *   「168.0時間(+28.0)」で、**同じ言葉で違う数** が2つ出ていた。
 *   原因は計算の誤りではなく **土俵が違う** 事だった（基準時刻が違う・窓の営業日が 5日と4日）。
 *   → だから段ごとに「**どの基準時刻から・何営業日で数えた数か**」を必ず添える。
 *     添えないと、別の時刻で回した数と並べた時に、どちらが本当か決められない。
 *   ⚠ 数はここで1つも作らない。nowMs・windowEndMs は呼ぶ側の物、horizonDays は
 *     rescueLadder.js が段ごとに作り直した物（workdaysToReach）をそのまま出す。
 */
function RungRow({ rung, maxCount, maxExtraMinutes, subOf, open, onToggle, nowMs, windowEndMs }) {
  const isBase = rung.key === RUNG_KEY.BASE;
  const count = rung.measured && rung.count != null ? rung.count : null;
  const saved = rung.savedCount == null ? 0 : rung.savedCount;
  const worse = rung.measured && !isBase && rung.newlyAtRiskCount != null && rung.newlyAtRiskCount > 0;
  const denom = maxCount > 0 ? maxCount : 1;
  const redRatio = count == null ? 0 : count / denom;
  const greenRatio = saved > 0 ? saved / denom : 0;
  const extra = rung.extraWorkableMinutes;
  const blueRatio = (extra != null && maxExtraMinutes > 0) ? Math.max(0, extra) / maxExtraMinutes : 0;

  return (
    <div
      className="border-b border-slate-100 py-1.5 last:border-b-0"
      data-rung={rung.key}
      data-measured={rung.measured ? '1' : '0'}
      data-count={count == null ? '' : String(count)}
      data-saved={isBase ? '' : String(saved)}
      data-effect={rung.effect || ''}
      /* 🚨 土俵。見張りが「各段に基準時刻と営業日数が付いているか」を機械で数える所。 */
      data-basis-ms={Number.isFinite(Number(nowMs)) ? String(Math.trunc(Number(nowMs))) : ''}
      data-basis-at={fmtAt(nowMs)}
      data-horizon-days={Number.isFinite(Number(rung.horizonDays)) ? String(Math.trunc(Number(rung.horizonDays))) : ''}
      data-window-end-at={fmtAt(windowEndMs)}
    >
      <div className="flex items-center gap-2">
        {/* 名前 */}
        <div className={`w-36 shrink-0 truncate text-xs ${isBase ? 'font-bold text-slate-700' : 'font-black text-slate-800'}`}>
          {rung.label}
        </div>
        {/* 🚨 絵。赤=残る危険 / 緑=救えた分。文字を読まなくても段ごとの長短が分かる。 */}
        <div className="relative h-5 min-w-0 flex-1 overflow-hidden rounded bg-slate-100">
          {/* 🚨 inset-0(＝幅いっぱい)にする事。left-0 だけだと親の幅が0になり、
              中の % 指定が全部 0 になって **棒が1本も描かれない**(2026-09-04 実測)。 */}
          <div className="absolute inset-0 flex">
            <div
              className={worse ? 'h-full bg-rose-700' : 'h-full bg-rose-500'}
              style={{ width: pct(redRatio) }}
              title={`この段で残る危険なロット ${count == null ? '—' : count}件`}
            />
            {greenRatio > 0 ? (
              <div
                className="h-full bg-emerald-400"
                style={{ width: pct(greenRatio) }}
                title={`この段で救えたロット ${saved}件`}
              />
            ) : null}
          </div>
        </div>
        {/* 数 */}
        <div className="w-16 shrink-0 text-right">
          <span className="text-lg font-black leading-none text-slate-900">{count == null ? '—' : count}</span>
          <span className="ml-0.5 text-2xs text-slate-500">件</span>
        </div>
        {/* 効き目の言葉。🚨 0件を「—」で誤魔化さない。 */}
        <div className="w-24 shrink-0 text-right text-xs font-black">
          {isBase ? <span className="text-slate-400">基準</span>
            : rung.effect === '効きません'
              ? <span className="text-slate-500">効きません</span>
              : <span className="text-emerald-700">{rung.effect || '—'}</span>}
        </div>
      </div>

      {/* 2行目: その手が「何をしたか」。時間は増えたのか。 */}
      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-36 text-2xs text-slate-500">
        {isBase ? (
          <span>1日 {rung.directMinutesPerDay ?? '—'}分 ／ この期間に働ける {fmtHours(rung.workableMinutes)}</span>
        ) : (
          <>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-1.5 w-16 overflow-hidden rounded bg-slate-100 align-middle">
                <span className="block h-full bg-sky-400" style={{ width: pct(blueRatio) }} />
              </span>
              <span className={extra > 0 ? 'font-bold text-sky-700' : ''}>
                働ける時間 {extra == null ? '—' : `+${fmtHours(extra)}`}
              </span>
            </span>
            <span>1日 {rung.directMinutesPerDay ?? '—'}分</span>
            <span>早く終わる {rung.earlierFinishCount == null ? '—' : `${rung.earlierFinishCount}件`}</span>
            {rung.gainHours && rung.gainHours.n > 0 ? (
              <span>早まる量 中央 {rung.gainHours.mid.toFixed(1)}時間 / 最大 {rung.gainHours.max.toFixed(1)}時間</span>
            ) : null}
            {/* 🚨 悪くなった分も必ず出す。隠すと「良くなっただけ」の嘘になる。 */}
            {worse ? (
              <span className="font-bold text-rose-700">新たに危険 {rung.newlyAtRiskCount}件</span>
            ) : null}
            <span>{fmtSec(rung.tookMs)}</span>
          </>
        )}
      </div>

      {/* 🚨 3行目: **この段の土俵**。基準時刻と、この段が何営業日ぶんで数えたか。
          これが無いと、別の時刻で回した数（例: 140.0時間／168.0時間）と並べた時に
          「同じ言葉で違う数」になり、どちらが本当か決められない（2026-09-05 実測）。
          ⚠ 段によって営業日数が違うのは正しい。土曜を営業日に足すと、同じ実時刻の端
            （windowEndMs）まで届くのに要る営業日が増えるため（決まり23③）。 */}
      <div className="mt-0.5 pl-36 text-3xs leading-snug text-slate-400" data-rung-basis="1">
        基準 {fmtAt(nowMs)} から
        {rung.horizonDays == null ? ' 営業日数が渡っていません' : ` 営業${rung.horizonDays}日`}
        ぶん（{fmtAt(windowEndMs)} まで）で数えた数です
      </div>

      {/* 救えたロットの一覧。件数だけでは決められない(決まり23④)。 */}
      {!isBase && saved > 0 ? (
        <div className="mt-1 pl-36">
          <button
            type="button"
            onClick={onToggle}
            className="inline-flex min-h-11 items-center gap-1 rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-2xs font-bold text-emerald-800 hover:bg-emerald-100"
            title="この手で納期に間に合うようになったロットを、品目コード・特注仕様/テンプレ・指図・納期・担当で出します。"
          >
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            救えた {saved}件を見る
          </button>
          {open ? (
            <ul className="mt-1 max-h-56 overflow-y-auto rounded border border-emerald-200 bg-white px-2 text-2xs">
              {rung.savedLots.map((s) => (
                <LotLine key={s.lotId} lotId={s.lotId} lot={s.lot} workers={s.workers} subOf={subOf} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* 新たに危険になった物の一覧も、同じ強さで出せる様にしておく。 */}
      {!isBase && worse ? (
        <ul className="mt-1 ml-36 max-h-40 overflow-y-auto rounded border border-rose-200 bg-white px-2 text-2xs">
          {rung.newlyAtRiskLots.map((s) => (
            <LotLine key={s.lotId} lotId={s.lotId} lot={s.lot} workers={s.workers} subOf={subOf} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * 「効く手」のはしご。
 *
 * @param {number}   nowMs        基準時刻(盤面と同じ物を渡す事)
 * @param {number}   windowEndMs  基準の割付の窓の端(result.normalized.horizonEnd)
 * @param {object}   baseCalendar いま登録されている工場の暦(祝日表)
 * @param {Map|object} lotsById   ロットの素(品目コード・指図・納期を出すため)
 * @param {function} subOf        品目コードに添える文字(製品=テンプレ名 / 最終=特注仕様)を返す
 * @param {function} runRung      async (plan, index) => { normalized, simResult, tookMs }
 * @param {function} disposeRun   4段を回し終えた時・画面を離れた時の後始末(Worker を畳む)
 * @param {boolean}  disabled     まだ基準の割付が出ていない等で押せない
 * @param {string}   disabledNote 押せない理由(1行)
 * @param {number}   overtimeExtraMinutes 残業の刻み(分/日)
 */
export function RescueLadder({
  nowMs,
  windowEndMs = null,
  baseCalendar = null,
  lotsById = null,
  subOf = null,
  runRung = null,
  disposeRun = null,
  disabled = false,
  disabledNote = '',
  overtimeExtraMinutes = DEFAULT_OVERTIME_EXTRA_MINUTES,
}) {
  // 🚨 hooks は必ずここに全部(ガードより上)。2026-08-27「画面が丸ごと消えた」根因。
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [step, setStep] = React.useState(0);
  const [ladder, setLadder] = React.useState(null);
  const [error, setError] = React.useState('');
  const [openRung, setOpenRung] = React.useState('');
  /** どの条件で回した答えか。条件が変わったら古い答えは捨てる(違う土俵の数字を残さない)。 */
  const [ranKey, setRanKey] = React.useState('');
  const aliveRef = React.useRef(true);
  // ⚠ 後始末は ref 越しに呼ぶ。props の関数を依存に入れると、親が作り直す度に
  //   Worker を畳んでしまう(押している最中に消える)。
  const disposeRef = React.useRef(null);
  disposeRef.current = disposeRun;
  React.useEffect(() => {
    // 🚨 立ち上げで必ず true へ戻す。ここを書かないと、一度でも外れて戻った時
    //   (画面の作り直し・HMR)に aliveRef が false のままになり、
    //   「引き直し中 1/4」から **二度と戻らない** 画面になる(2026-09-04 実測)。
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (typeof disposeRef.current === 'function') { try { disposeRef.current(); } catch { /* 畳めなくても止めない */ } }
    };
  }, []);

  const groundKey = React.useMemo(
    () => [nowMs, windowEndMs, overtimeExtraMinutes].join('|'),
    [nowMs, windowEndMs, overtimeExtraMinutes],
  );
  React.useEffect(() => {
    // 条件が変わった = 前の答えは別の土俵の物。**黙って残さない**。
    setLadder(null);
    setError('');
    setStep(0);
  }, [groundKey]);

  const plans = React.useMemo(
    () => buildRungPlans({ baseCalendar, nowMs, windowEndMs, overtimeExtraMinutes }),
    [baseCalendar, nowMs, windowEndMs, overtimeExtraMinutes],
  );

  const run = React.useCallback(async () => {
    if (typeof runRung !== 'function' || plans.length === 0) return;
    setBusy(true);
    setError('');
    setStep(0);
    setLadder(null);
    const runs = [];
    try {
      for (let i = 0; i < plans.length; i += 1) {
        setStep(i + 1);
        // ⚠ 1段ずつ順に引き直す(同時に走らせると計算機を奪い合って、どれも遅くなる)。
        const got = await runRung(plans[i], i);
        if (!aliveRef.current) return;
        runs.push({
          key: plans[i].key,
          label: plans[i].label,
          horizonDays: plans[i].horizonDays,
          normalized: got ? got.normalized : null,
          simResult: got ? got.simResult : null,
          tookMs: got ? got.tookMs : null,
        });
      }
      if (!aliveRef.current) return;
      setLadder(buildLadder({ runs, nowMs, lotsById }));
      setRanKey(groundKey);
    } catch (e) {
      if (!aliveRef.current) return;
      setError((e && e.message) ? String(e.message) : '引き直しに失敗しました');
    } finally {
      // 🚨 4段ぶん回し終えたら Worker は畳む。立てっぱなしにしない。
      if (typeof disposeRef.current === 'function') { try { disposeRef.current(); } catch { /* 畳めなくても止めない */ } }
      if (aliveRef.current) { setBusy(false); setStep(0); }
    }
  }, [runRung, plans, nowMs, lotsById, groundKey]);

  const verdict = React.useMemo(() => (ladder ? ladderVerdict(ladder) : null), [ladder]);
  const fresh = !!ladder && ranKey === groundKey;
  const maxCount = React.useMemo(
    () => (ladder ? ladder.rungs.reduce((a, r) => (r.measured && r.count > a ? r.count : a), 0) : 0),
    [ladder],
  );
  const maxExtra = React.useMemo(
    () => (ladder ? ladder.rungs.reduce((a, r) => {
      const v = Number(r.extraWorkableMinutes);
      return Number.isFinite(v) && v > a ? v : a;
    }, 0) : 0),
    [ladder],
  );

  const canRun = !disabled && !busy && typeof runRung === 'function' && plans.length > 0
    && Number.isFinite(Number(windowEndMs));
  const lastSec = ladder ? fmtSec(ladder.totalMs) : null;

  return (
    <div data-fs="rescue-ladder" className="rounded-xl border border-slate-200 bg-white">
      {/* ── 1行。押すと開く(決まり23 の形) ── */}
      <div className="flex flex-wrap items-center gap-2 px-2.5 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex min-h-11 items-center gap-1 text-xs font-black text-slate-800"
          title="残業や土曜出勤で納期遅れが何件消えるかを、実際に割付を引き直して出します。"
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          効く手のはしご
        </button>
        <span className="min-w-0 flex-1 truncate text-2xs text-slate-500">
          {fresh && verdict ? verdict.text : 'いま遅れる何件を、どの手で何件救えるか。押した時だけ引き直します。'}
        </span>
        <button
          type="button"
          onClick={run}
          disabled={!canRun}
          data-ladder-run="1"
          title={canRun
            ? '残業・土曜・両方の3つと、いまのまま を それぞれ1回ずつ割付し直します。押した時だけ回ります。'
            : (disabledNote || '基準の割付が出てから押せます')}
          className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-cyan-500 bg-cyan-50 px-2.5 text-2xs font-black text-cyan-700 disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          {busy ? `引き直し中 ${step}/${plans.length}` : `4通りを試す${lastSec ? `(前回 ${lastSec})` : ''}`}
        </button>
      </div>

      {open ? (
        <div className="border-t border-slate-200 px-2.5 py-2">
          {/* 答えの1行。**大きい字は答え**(件数ではない・決まり6)。 */}
          {fresh && verdict ? (
            <div className={`mb-1.5 text-sm font-black ${verdict.tone === 'bad' ? 'text-rose-700' : verdict.tone === 'ok' ? 'text-emerald-700' : 'text-slate-700'}`}>
              {verdict.text}
            </div>
          ) : (
            <div className="mb-1.5 text-xs text-slate-500">
              {busy ? '割付を引き直しています…' : '「4通りを試す」を押すと、4回ぶん割付を引き直して、実際に減る件数を出します。'}
            </div>
          )}

          {error ? (
            <div className="mb-1.5 flex items-start gap-1 rounded border border-rose-300 bg-rose-50 px-2 py-1 text-2xs text-rose-800">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>引き直せませんでした: {error}</span>
            </div>
          ) : null}

          {/* 土俵。**同じ窓でしか比べない**事を必ず見せる(決まり23③)。 */}
          {fresh ? (
            <div className="mb-1.5 text-2xs text-slate-500">
              どの段も同じ期間で数えています: {fmtAt(nowMs)} 〜 {fmtAt(ladder.windowEndMs)}
              {' ／ 4回引き直して '}{fmtSec(ladder.totalMs)}
              {plans[2] && plans[2].saturdaysAdded.length
                ? ` ／ 土曜に足した日: ${plans[2].saturdaysAdded.join('・')}`
                : ' ／ この期間に土曜はありません'}
              {plans[2] && plans[2].saturdaysKeptOff.length
                ? ` ／ 暦で休みに登録済みの土曜は動かしていません: ${plans[2].saturdaysKeptOff.join('・')}`
                : ''}
            </div>
          ) : null}

          {/* はしご本体。🚨 measured でない段も含めて **必ず4段全部** 描く。 */}
          {fresh ? (
            <div data-ladder-rungs={String(ladder.rungs.length)}>
              {ladder.rungs.map((r) => (
                <RungRow
                  key={r.key}
                  rung={r}
                  /* 🚨 土俵は段ごとに必ず添える（2026-09-05）。上の1行に書いてあるから
                     省く、はしない。数だけを切り取って別の場所へ写された時に、
                     どの基準時刻・何営業日の数か が分からなくなるため。 */
                  nowMs={nowMs}
                  windowEndMs={ladder.windowEndMs}
                  maxCount={maxCount}
                  maxExtraMinutes={maxExtra}
                  subOf={subOf}
                  open={openRung === r.key}
                  onToggle={() => setOpenRung((v) => (v === r.key ? '' : r.key))}
                />
              ))}
            </div>
          ) : null}

          {/* 全部効かない時。**黙らない**(決まり23②)。なぜ効かないかは数字で言う。 */}
          {fresh && ladder.allIneffective ? (
            <div className="mt-1.5 rounded border border-rose-300 bg-rose-50 px-2 py-1.5 text-2xs text-rose-900">
              <div className="font-black">4手とも、遅れは1件も減りません。</div>
              <div className="mt-0.5">
                働ける時間は増えています(＋両方で {fmtHours(maxExtra)})。
                それでも減らないので、詰まっているのは <b>時間ではありません</b>。
              </div>
              {/* 🚨 内訳は **和集合**。両方に当てはまるロットが居るので、足しても件数にならない。 */}
              <div className="mt-0.5">
                いま危険な {ladder.base.count}件の内訳: この先で遅れる {ladder.base.forecastLate}件 ／
                納期があるのに手が付かない {ladder.base.unresolvedDue}件
                （両方に当てはまる物が居るので、足し算にはなりません）。
              </div>
              {/* 🚨 「測れた物」と「測れない物」を1つの数に混ぜない(2026-08-22)。 */}
              <div className="mt-0.5">
                {ladder.lateHours.n > 0
                  ? `遅れの大きさを出せたのは ${ladder.lateHours.n}件で、中央 ${ladder.lateHours.mid.toFixed(1)}時間・最大 ${ladder.lateHours.max.toFixed(1)}時間 です。`
                  : ''}
                {ladder.lateUnmeasurableCount > 0
                  ? `残り ${ladder.lateUnmeasurableCount}件は終わる見込みが出ていないので、遅れの大きさは測れません。`
                  : ''}
              </div>
            </div>
          ) : null}

          {/* 🚨 人の同意が要る(決まり23⑤)。言葉は純関数側の1か所から。 */}
          <div className="mt-1.5 text-2xs text-slate-500">{ladder ? ladder.cautionText : '残業も土曜出勤も、実際にやるかは人が決める事です。'}</div>
        </div>
      ) : null}
    </div>
  );
}

export default RescueLadder;
