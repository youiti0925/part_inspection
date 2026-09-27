// =============================================================================
//  opsim/PeriodStrip.jsx — 盤の上の「期間の切替」と、月を選んだ時の 案C の画面
// -----------------------------------------------------------------------------
//  出典: 2026-09-04 決まり19A（親）
//   ・期間は 5営業日 / 今月 / 来月 の3つ。「30日」という **届く日が言えない数字** はやめた。
//   ・🚨 **案C を既定**にする＝月を選んだ直後は割付を回さない。
//     月ごとの人日と「誰も持てない工程」まで（軽い方の計算のまま出せる）。
//     その上に「この期間で 誰がどのロットをいつ まで計算する」のボタン（案A・重い方）。
//   ・🚨 押す前は「まだ計算していません」と正直に出す。**空の盤を出さない**。
//
//  この画面が答える1行:
//    「今月（来月）、要る時間と働ける時間はどちらが長いか。誰も持てない工程はいくつか」
//
//  🚨 数字はここで1つも作らない。engine の result.monthly が出した値を置くだけ
//     （同じ数字を2つの計算から出さない）。
//  🚨 px を直書きしない（全部 rem 段の Tailwind クラス）。zoom / transform:scale も使わない。
// =============================================================================
import React from 'react';
import { Loader2, Play, Info } from 'lucide-react';
import { opsimYmdW } from './horizonRange.js';

/* 🚨 null / '' / undefined を 0 にしない。
   Number(null) は 0 なので、素で書くと「渡していない」が「0」に化ける。
   実データで撮って見つけた（押した事が無いのに「前回およそ 0秒」と出ていた）。 */
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  return Number.isFinite(Number(v)) ? Number(v) : null;
};
const arr = (v) => (Array.isArray(v) ? v : []);
const fmt1 = (n) => (num(n) == null ? '—' : (Math.round(Number(n) * 10) / 10).toLocaleString('ja-JP'));
const fmtInt = (n) => (num(n) == null ? '—' : Math.round(Number(n)).toLocaleString('ja-JP'));

/* ---------------------------------------------------------------------------
 * ① 期間の切替（5営業日 / 今月 / 来月）＋ 届く日の札
 * ------------------------------------------------------------------------- */
/**
 * @param {object} p
 * @param {Array}  p.items       OPSIM_RANGES
 * @param {string} p.value       いま選んでいる key
 * @param {Function} p.onPick
 * @param {object} p.info        opsimRangeDays の戻り（届く日・営業日・暦日）
 * @param {number|null} p.resultDays 🚨 **エンジンが実際に回した営業日の数**。
 *   選んだ期間と食い違う時は、その事をこの帯が1行で言う（選んだだけの日数で盤に名前を付けない）。
 */
export function PeriodPills({ items = [], value = 'd5', onPick = null, info = null, resultDays = null }) {
  const list = arr(items);
  const pick = (k) => { if (typeof onPick === 'function') onPick(k); };
  const rd = num(resultDays);
  const want = info ? num(info.days) : null;
  const mismatch = rd != null && want != null && rd !== want;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1" data-opsim-period-pills={String(value)}>
      <span className="text-2xs font-black tracking-wider text-slate-500">期間</span>
      <div role="group" aria-label="期間" className="inline-flex gap-1 rounded-xl border border-slate-300 bg-white p-0.5">
        {list.map((it) => {
          const on = it.key === value;
          return (
            <button
              key={it.key}
              type="button"
              aria-pressed={on}
              title={it.hint || ''}
              onClick={() => pick(it.key)}
              data-opsim-period-key={it.key}
              className={`min-h-11 rounded-lg px-3 text-xs font-black leading-none ${on
                ? 'bg-slate-900 text-white'
                : 'text-slate-600 hover:bg-slate-100'}`}
            >
              {it.label}
            </button>
          );
        })}
      </div>
      {/* 🚨 「届く日」を必ず出す。数字だけ置いて「で、いつまで？」にしない（決まり19A）。

          🚨🚨 2026-09-05 実データの実画面で見つけた食い違い（ここで直した）:
            この札は **明日から** 数えた日数（あと営業18日・暦25日）を出していた。
            すぐ下の月の見取り図は engine が **今日を入れて** 数えた日数（営業18日・暦26日）。
            同じ「今月」を指しているのに数え始めが1日違うので、**同じ画面に2通りの日数**が並ぶ。
            ある日は 18 と 19、別の日は 18 と 18 で **たまたま合う日がある** のが一番悪い
            （読む人はどちらが本当か決められない）。
          → 月を選んでいる時、この札は **日数を1つも出さない**。日数は engine が出した1本
            （下の月の見取り図「9/5〜9/30 ・ 営業18日 ・ 暦26日」）だけにする。
            消したのではなく **移した**（決まり6）。この札に要る「届く日」はそのまま残す。
          ⚠ 5営業日の時だけ日数を出す。その 5 は engine へ渡す horizonDays そのもの
            （盤の「この5営業日」と同じ1つの計算）なので 2通りにならない。 */}
      {info ? (
        <span className="text-2xs leading-snug text-slate-500" data-opsim-period-reach={info.isMonth ? 'month' : 'days'}>
          {info.rangeText}
          <span className="mx-1 text-slate-300">｜</span>
          {info.isMonth ? (
            <span
              title={'この期間の営業日数・暦日数は、下の月の見取り図に1本だけ出しています'
                + `（engine が今日を入れて数えた日数）。この札から計算へ渡しているのは「いまの時刻から ${fmtInt(info.days)}営業日ぶん先まで」で、`
                + '今日の残りを1日目と数えます。数え始めが1日違うので、2つ並べると どちらが本当か決められなくなります。'}
            >
              日数は下の月の札に1本だけ出します
            </span>
          ) : (
            <>あと営業{fmtInt(info.days)}日・暦{fmtInt(info.calDays)}日</>
          )}
          {/* 📐 この一言で切替の段が2行に折れていた(約56px)。字は読み上げ用に残し、目には期間の札の title で出す(箱の幅は画面が広くても約1100pxで頭打ちなので、広い画面でも折れていた)。 */}
          {info.reachText ? <span className="sr-only" title={info.reachText}>（{info.reachText}）</span> : null}
        </span>
      ) : null}
      {/* 🚨 選んだ期間と、いま盤に出ている見立ての期間が違う時は、必ずそう言う。
          前に基準時刻で同じ間違いをした（選んだだけの値を「この見立ての」と名乗らせた）。
          ⚠ この札の日数は **選んだ期間ではなく、いま盤に出ている前の期間** を指す。
            だから data-opsim-period-stale を付けて、見張りが「選んだ期間の日数」と
            混ぜて数えない様にしてある。 */}
      {mismatch ? (
        <span
          data-opsim-period-stale="1"
          className="rounded-md border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-2xs font-bold text-amber-900"
        >
          いま盤に出ているのは <b>前の期間</b>（{fmtInt(rd)}営業日ぶん）の見立てです
        </span>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * ② 横棒2本（同じ物差し）。文字を隠しても「どちらが長いか」で分かる。
 * ------------------------------------------------------------------------- */
function TwoBars({ requiredMinutes, workableMinutes, dayMinutes }) {
  const req = num(requiredMinutes);
  const cap = num(workableMinutes);
  const dm = num(dayMinutes);
  const max = Math.max(req || 0, cap || 0);
  const pct = (v) => (max > 0 && num(v) != null ? Math.max(1, Math.round((Number(v) / max) * 100)) : 0);
  const pd = (v) => (num(v) != null && dm && dm > 0 ? Number(v) / dm : null);
  const reqPd = pd(req);
  const capPd = pd(cap);
  const diffPd = (reqPd == null || capPd == null) ? null : capPd - reqPd;
  return (
    <div className="flex flex-col gap-1.5" data-opsim-two-bars="">
      <Bar label="要る時間" tone="bg-amber-500" pct={pct(req)} minutes={req} personDays={reqPd} />
      <Bar label="働ける時間" tone="bg-cyan-500" pct={pct(cap)} minutes={cap} personDays={capPd} />
      {diffPd == null ? (
        <div className="text-2xs text-slate-500">要る時間か働ける時間が測れていないので、差は出しません。</div>
      ) : (
        <div className="text-sm font-black leading-none text-slate-900">
          {diffPd >= 0
            ? <>働ける方が <span className="text-cyan-700">{fmt1(diffPd)} 人日</span> 長い</>
            : <>働ける方が <span className="text-rose-700">{fmt1(-diffPd)} 人日</span> 足りない</>}
        </div>
      )}
    </div>
  );
}

function Bar({ label, tone, pct, minutes, personDays }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-2xs font-bold text-slate-500">{label}</span>
      <span className="h-3 flex-1 overflow-hidden rounded-full bg-slate-200">
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </span>
      <b className="w-28 shrink-0 text-right text-xs font-black tabular-nums text-slate-800">
        {fmt1(personDays)} 人日
      </b>
      <span className="w-24 shrink-0 text-right text-2xs tabular-nums text-slate-400">{fmtInt(minutes)} 分</span>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * ③ 案C の本体 — 月を選んで、まだ「誰がどのロットをいつ」を回していない時
 * ------------------------------------------------------------------------- */
/**
 * @param {object} p
 * @param {object} p.info      opsimRangeDays の戻り
 * @param {object} p.month     result.monthly.withPile.months[i]（engine の値。ここで数えない）
 * @param {object} p.monthly   result.monthly（山の件数・数え方の言葉に使う）
 * @param {Function} p.onRunFull 「誰がどのロットをいつ」まで計算する
 * @param {boolean} p.busy     計算中
 * @param {number|null} p.estSeconds 前に測った秒数（無ければ札に秒を書かない）
 */
/**
 * 期間の1行(決まり26・2026-09-05)。「どの期間で・何秒で・範囲をどこまで広げて」盤を回したかを言う。
 * 🚨 数字はここで作らない。info(horizonRange)・seconds(measure した値)・scopeDays(Panel が渡した暦日)を並べるだけ。
 * 🚨 案C(「まだ計算していません」＋ボタン)は撤回。清水さん「今月指定したのに5日間だけ。何のために今月ってあるの？」
 */
export function PeriodRunNote({ info = null, seconds = null, busy = false, scopeDays = null, scopeKey = '', lotsScoped = null }) {
  if (!info) return null;
  const sec = num(seconds);
  const widened = !!info.isMonth && scopeKey !== 'all';
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-2xs leading-snug text-slate-700"
      data-opsim-period-note={String(info.key || '')}
      data-opsim-period-days={String(info.days ?? '')}
      data-opsim-scope-days={scopeDays == null ? 'all' : String(scopeDays)}
      data-opsim-scope-widened={widened ? '1' : '0'}
    >
      <b className="text-slate-900">
        {info.label}
        {info.rangeText ? `（${info.rangeText}・営業${fmtInt(info.days)}日）` : ''}
      </b>
      <span>
        納期一覧・人ごとの指示・ロットの流れ を この期間で回して{busy ? 'います…' : 'あります'}
        {sec != null ? <span className="tabular-nums">（{fmt1(sec)}秒）</span> : null}
      </span>
      {info.isMonth ? (
        <span>
          範囲：
          {scopeKey === 'all'
            ? '未完了ぜんぶ'
            : `${opsimYmdW(info.lastDayMs)} までに来る分まで（${info.label}を選んだので、既定の「手元＋14日」から広げています）`}
          {num(lotsScoped) != null ? <span className="tabular-nums">・載せたロット {fmtInt(lotsScoped)}件</span> : null}
        </span>
      ) : null}
      {info.empty ? (
        <span className="font-bold text-rose-700">この月に営業日が残っていないので、5営業日で回しています</span>
      ) : null}
    </div>
  );
}

export function MonthOutlookCard({
  info = null, month = null, monthly = null, onRunFull = null, busy = false, estSeconds = null,
}) {
  const m = month || null;
  const procs = arr(m && m.processes);
  const ownerUnknown = procs.filter((p) => p && p.ownerUnknown);
  const topUnknown = ownerUnknown.slice(0, 6);
  /** この月に納期が来る仕事の件数（engine の値。ここで数え直さない）。決まり1・2 の要。 */
  const lotCount = num(m && m.lotCount) == null ? 0 : Math.trunc(Number(m.lotCount));
  const pileCount = num(monthly && monthly.pileLotCount);
  const openCount = num(monthly && monthly.openLotCount);
  const holdingWord = (monthly && monthly.holdingWord) || '到着待ち';
  const sec = num(estSeconds);

  return (
    <section
      className="rounded-xl border border-slate-300 bg-white p-3"
      data-opsim-month-outlook={info ? String(info.key) : ''}
      data-opsim-full-run="0"
    >
      {/* 🚨 まず「何が出ていないか」を正直に言う。空の盤を出さない（決まり19A・親の指示2）。 */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-base font-black leading-tight text-slate-900">
            {info ? info.label : '月'}
            {m ? `（${m.rangeLabel || m.label || ''}）` : ''}
            ：人は足りるか
          </div>
          <div className="mt-0.5 text-2xs leading-snug text-slate-600">
            この段は <b>割付を回していません</b>（月ごとの 要る時間・働ける時間・誰も持てない工程まで）。
            <b className="text-slate-900">「誰が・どのロットを・いつ」はまだ計算していません。</b>
            下のボタンを押すと、この期間ぶんの割付を1回だけ回します。
          </div>
        </div>
        <button
          type="button"
          onClick={() => { if (typeof onRunFull === 'function') onRunFull(); }}
          disabled={busy}
          data-opsim-run-full=""
          title={'この期間（月末まで）の割付を1回だけ回します。押すまでは回りません。'
            + '押した後は、納期一覧・人ごとの指示・ロットの流れが、この期間ぶんで出ます。'
            + '何も保存しません（元のデータは1文字も変わりません）。'}
          className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl border-2 px-3 text-xs font-black ${busy
            ? 'border-slate-300 bg-slate-100 text-slate-400'
            : 'border-cyan-600 bg-cyan-600 text-white hover:bg-cyan-700'}`}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          この期間で「誰が・どのロットを・いつ」まで計算する
          {sec != null ? <span className="font-bold opacity-90">（前回およそ {fmt1(sec)}秒）</span> : null}
        </button>
      </div>

      {!m ? (
        <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2 text-2xs text-slate-600">
          月ごとの数字がまだ出ていません（計算の途中か、出せませんでした）。
        </div>
      ) : (
        <div className="mt-2 grid gap-2 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
          {/* 左: 横棒2本（同じ物差し）。文字を隠しても長短で分かる。 */}
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-2">
            {/* 🚨🚨 決まり1・2（清水さんが一番困る形の嘘）:
                中身の無い月は「余裕で回ります」と出る。仕事が無いからではなく
                **登録がまだ少ないから**。だから棒のすぐ上に **その月に納期が来ている件数** を、
                人日と同じ強さで置く。0件の月は棒そのものを描かない（数字を出さない）。
                実データで撮って見つけた: 10月は登録 2件で「余力 87.2人日」と出ていた。 */}
            {lotCount === 0 ? (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs font-bold leading-snug text-amber-900">
                この月に納期が来る仕事は <b className="text-base">0件</b> です（これから登録されます）。
                <span className="block font-normal">
                  登録が無いので、要る時間・働ける時間の棒は出しません（0件だから回る、という意味ではありません）。
                </span>
              </div>
            ) : (
              <>
                <div className="mb-1 flex items-baseline gap-1.5">
                  <b className="text-lg font-black leading-none tabular-nums text-slate-900">{fmtInt(lotCount)}件</b>
                  <span className="text-2xs font-bold text-slate-600">がこの月に納期（いま登録されている分）</span>
                </div>
                <TwoBars
                  requiredMinutes={m.requiredMinutes}
                  workableMinutes={m.workableMinutes}
                  dayMinutes={m.dayMinutes || (monthly && monthly.dayMinutes)}
                />
            <div className="mt-1 text-2xs leading-snug text-slate-500" data-opsim-month-denominator="">
              {/* 🚨 この画面で「営業◯日」を名乗るのは **ここ1か所だけ**（2026-09-05）。
                  上の期間の札は日数を出さない側へ寄せた（PeriodPills のコメント参照）。
                  ⚠ この数（m.workdays）は engine の月の行が持っている値。ここで数え直さない。 */}
              分母＝この月の営業{fmtInt(m.workdays)}日（今日を含む）× 名前のある作業者
              {fmtInt(arr(monthly && monthly.roster).length)}人・
              1日{fmtInt(m.dayMinutes || (monthly && monthly.dayMinutes))}分。
              上の期間の札と同じ範囲を、今日を入れて数えた日数です。
              {/* 🚨 決まり4: 工程の行を足しても全体にはならない。合計欄を作らない。 */}
              工程ごとの行を足しても、この2本にはなりません（同じ人が何工程も持てるため）。
                </div>
              </>
            )}
            {/* 🚨 engine が名乗る判定の言葉は、engine の物をそのまま置く（ここで作り直さない）。
                ⚠ 「回ります」は **いま登録されている分だけ** の話。上の件数と必ず並べて読ませる。 */}
            {m.headline ? (
              <div className="mt-1.5 rounded border border-slate-200 bg-white px-2 py-1 text-2xs font-bold text-slate-700">
                {m.headline}
                {m.unjudgeableWhy ? <span className="ml-1 font-normal text-slate-500">（{m.unjudgeableWhy}）</span> : null}
                <span className="ml-1 font-normal text-slate-500">
                  — いま登録されている {fmtInt(lotCount)}件 で数えた話です。
                </span>
              </div>
            ) : null}
          </div>

          {/* 右: 誰も持てない工程。赤い四角の数が、文字を読まずに分かる物。 */}
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-2">
            <div className="flex items-baseline gap-2">
              <b className="text-2xl font-black leading-none text-rose-700 tabular-nums">{fmtInt(ownerUnknown.length)}</b>
              <span className="text-xs font-bold text-slate-700">工程は、持てる人の記録がありません</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-0.5" aria-hidden="true">
              {ownerUnknown.slice(0, 60).map((p, i) => (
                <span key={p.processKey || i} className="inline-block h-2.5 w-2.5 rounded-sm bg-rose-500" />
              ))}
            </div>
            <div className="mt-1 text-2xs leading-snug text-slate-500">
              全{fmtInt(procs.length)}工程のうち。
              {/* 🚨 2026-08-20: 「実績が無い＝できない」と書かない。分かりませんまで。 */}
              記録が無いだけで、やれないという意味ではありません。誰に教えるかを決めるための数です。
            </div>
            {topUnknown.length ? (
              <ul className="mt-1 space-y-0.5">
                {topUnknown.map((p) => (
                  <li key={p.processKey} className="truncate text-2xs text-slate-600">
                    <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-rose-500 align-middle" />
                    {p.title || p.processKey}
                    {p.templateName ? <span className="text-slate-400">｜{p.templateName}</span> : null}
                    {arr(p.models).length ? <span className="text-slate-400">｜{arr(p.models).join('・')}</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      )}

      {/* 🚨 山（到着待ちのまま記録0件）は隠さない。数え方も言う（決まり22 の札と同じ言葉）。 */}
      {pileCount != null && openCount != null ? (
        <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 p-2 text-2xs leading-snug text-amber-900">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            未完了 {fmtInt(openCount)}件のうち <b>{fmtInt(pileCount)}件</b>は「{holdingWord}のまま作業の記録が0件」です。
            この段は<b>その山を数える側</b>の数字を出しています（数えない側の数字は「月ごと」の画面で切り替えられます）。
          </span>
        </div>
      ) : null}
    </section>
  );
}

export default PeriodPills;
