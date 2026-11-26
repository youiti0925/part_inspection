// =============================================================================
//  opsim/SharedWorkerPlan.jsx — 村さんを「どの日は製品・どの日は最終」で置く(2026-09-05)
// -----------------------------------------------------------------------------
//  清水さん(2026-09-05):「シミュレーションで両方の工場で働ける人でボタン押したけど、
//    よくわからなかった」「これだったら **どの日に製品に行って この日は最終検査とか**
//    そういう意味で言ったのに」「負荷を平均でするか、どっちかの優先率を設定して…」
//
//  答える1行:
//    「この期間、村さんは **どの営業日に製品・どの営業日に最終** に居るべきか。
//      そうすると両方の遅れは何件になるか」
//
//  🚨 この画面は **描くだけ**。数字は sharedWorkerPlan.js(純関数)と
//     runRung(はしごと同じ道具)が返した物をそのまま出す。ここで足し算・判定を書かない。
//  🚨 引き直しは押した時だけ **1回**。相手側の件数は **相手の書類の数字を出すだけ**
//     (相手の計算をこちらで回さない。書類が無ければ「読めていません」と言う)。
//  🚨 今までの「期間まるごと2通り」(SharedWorkerStrip)は **消さない**。
//     この画面の中に畳んで置く(押せば必ず出る)。Strip のファイルは1バイトも変えない。
//  🚨 hooks は必ずガード(return null)より上。宣言より前で変数を読まない
//     (TDZ で盤が丸ごと落ちた 2026-09-05)。
// =============================================================================

import React from 'react';
import { CalendarRange, ChevronDown, Loader2, Play, Users } from 'lucide-react';
import {
  allocateSharedWorker, buildSharedPlanRung, measurePlanRun, planRunBlocker, planSideEffect, PLACE, PLAN_MODE,
  buildPlacement, placementText, isPlacementActive,
  normalizeWeeklyRule, fixedFromWeekly, fixedByFromWeekly, dayRuleText, docDayKeys, weeklyText, WEEKDAY_JA,
  dueListCounts, dueListText,
} from '../domain/operationsSimulation/sharedWorkerPlan.js';
import { sharedWorkerNames } from '../domain/operationsSimulation/sharedWorker.js';
import { LATE_TONE } from './lateTone.js';
import { SharedWorkerStrip } from './SharedWorkerStrip.jsx';
// ⏱ 2026-10-03 B3 「最新にする」(相手の端末へ今すぐ計算して書いてと頼む)。App が口を配っていない所では何も出さない。
import { DailyLoadRefreshButton } from './DailyLoadRefreshButton.jsx';
import { targetAppOf } from './dailyLoadRefresh.js';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const fmtInt = (n) => (num(n) == null ? '—' : Math.round(Number(n)).toLocaleString('ja-JP'));
const fmt1 = (n) => (num(n) == null ? '—' : (Math.round(Number(n) * 10) / 10).toLocaleString('ja-JP'));
const signed = (n) => (num(n) == null ? '—' : (n > 0 ? `+${fmtInt(n)}` : fmtInt(n)));
const pct = (p) => (num(p) == null ? '—' : `${Math.round(Number(p) * 100)}%`);

/** 'YYYY-MM-DD' → 「9/8(月)」。文字を作るだけ(数を作らない)。 */
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
const dayLabel = (ymd) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return String(ymd || '');
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEK[d.getDay()]})`;
};
const ymdText = (ms) => {
  if (num(ms) == null) return null;
  const d = new Date(Number(ms));
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * 色は **工場** で決める。製品=cyan・最終=violet(決まり: 遅れの赤とは分ける)。
 * 🚨 here/there で決めてはいけない。golden 側は hereLabel='最終検査' なので、
 *   here=cyan と書くと 最終検査アプリだけ 最終=cyan・製品=violet に入れ替わり、
 *   2つの画面を並べた時に **同じ色が別の工場を指す**(同じファイルを両アプリで使う決まり)。
 */
const TONE = Object.freeze({
  product: Object.freeze({
    chip: 'border-cyan-500 bg-cyan-50 text-cyan-900',
    solid: 'border-cyan-600 bg-cyan-600 text-white hover:bg-cyan-700',
    on: 'bg-cyan-600 text-white',
  }),
  final: Object.freeze({
    chip: 'border-violet-500 bg-violet-50 text-violet-900',
    solid: 'border-violet-600 bg-violet-600 text-white hover:bg-violet-700',
    on: 'bg-violet-600 text-white',
  }),
  /** どちらの工場か読めていない時(書類が無い)。決めていない日の灰とは別の見た目にする。 */
  unknown: Object.freeze({
    chip: 'border-slate-500 bg-white text-slate-900',
    solid: 'border-slate-700 bg-slate-700 text-white hover:bg-slate-800',
    on: 'bg-slate-800 text-white',
  }),
});
const toneOf = (app) => (app === 'product' ? TONE.product : (app === 'final' ? TONE.final : TONE.unknown));
/** 決めていない日。工場の色とは別(灰)。 */
const NONE_CHIP = 'border-slate-300 bg-slate-100 text-slate-500';

/**
 * 段の見出し。①②③ の順に読めば決められる形にする(2026-09-15)。
 * 🚨 清水さん「めちゃくちゃ見づらい・適当にしか感じられない」→ 6段が同じ濃さで並んでいたのが原因。
 *   1段=1つの問い。答え(結果)は線で区切って下に置く。
 */
function StepHead({ n, title, hint = '' }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-800 font-black text-white">{n}</span>
      <b className="text-slate-900">{title}</b>
      {hint ? <span className="text-slate-500">{hint}</span> : null}
    </span>
  );
}

/**
 * @param {object} p
 * @param {Array} p.hereWorkers   この工場の名簿({name})
 * @param {Array|null} p.thereNames 向こうの名簿の名前。null=まだ読めていない
 * @param {string[]} [p.pausedNames] 休止中
 * @param {string} p.hereLabel   例 '製品検査'
 * @param {string} p.thereLabel  例 '最終検査'
 * @param {object|null} p.hereDoc  この工場の日ごとの負荷(buildDailyLoadDoc の戻り)
 * @param {object|null} p.thereDoc 相手の工場の書類(共有棚から読んだ物)。null=読めていません
 * @param {'product'|'final'|null} [p.hereApp]  この工場。省くと hereDoc.app
 * @param {'product'|'final'|null} [p.thereApp] 向こうの工場。省くと thereDoc.app
 * @param {'balance'|'priority'} [p.mode]
 * @param {number} [p.priority] 0..1(1 = 常にここ)
 * @param {number} [p.minBlockDays] 最低何日は同じ工場に居るか(往復を減らす)
 * @param {Function} [p.onChangeMode]     (mode) => void  ※保存は呼ぶ側
 * @param {Function} [p.onChangePriority] (0..1) => void
 * @param {Function} [p.onChangeMinBlockDays] (1..3) => void
 * @param {number} p.nowMs
 * @param {number} p.horizonDays いま盤が回している営業日数
 * @param {object|null} p.baseRun いまの盤の結果({normalized, simResult})。引き直す前の件数
 * @param {Function} p.runRung   (plan) => Promise<{normalized, simResult, tookMs}> ※はしごと同じ
 * @param {string} [p.inputKey] 盤が回した入力の指紋。畳んだ「期間まるごと2通り」へそのまま渡す
 *   (指紋が変われば、前に出した2通りの件数は別の話なので Strip 側が捨てる)
 * @param {Function} [p.disposeRun]
 * @param {boolean} [p.disabled]
 */
export function SharedWorkerPlan({
  hereWorkers = [], thereNames = null, pausedNames = [],
  hereLabel = 'この工場', thereLabel = '向こうの工場',
  hereDoc = null, thereDoc = null, hereApp = null, thereApp = null,
  mode = PLAN_MODE.BALANCE, priority = 0.5, minBlockDays = 1,
  onChangeMode = null, onChangePriority = null, onChangeMinBlockDays = null,
  nowMs = null, horizonDays = null, untilMs = null, worksOnDay = null,
  baseRun = null, runRung = null, disposeRun = null, disabled = false,
  inputKey = '',
  // 🚨 2026-09-12 清水さん「この配置で引き直すしても、盤とかのシュミレーション変化してないよ」
  //   決めた配置を親へ渡す口。親が書類に載せ、盤の休みとして効かせる(両方の工場)。
  onDecide = null, onClearDecision = null, decidedPlacement = null,
  // 📅 2026-09-14 曜日の配置(毎週)。書類(共有棚)は親が読んで渡す。押した物は親が書く。
  weeklyRules = null, onSaveWeekly = null,
  // 📋 2026-09-15 相手の書類(daily_load)。中の dueList(相手の納期一覧)の件数を帯に出す。
  thereDueList = null,
}) {
  // ── hooks(全部ここ。返り値の分岐より上) ───────────────────────────────────
  const shared = React.useMemo(
    () => sharedWorkerNames({ hereWorkers, thereNames, pausedNames }),
    [hereWorkers, thereNames, pausedNames],
  );
  const [who, setWho] = React.useState('');
  const name = who || shared.names[0] || '';
  // 📅 曜日の配置(毎週)。この人の分だけ使う。決まっている日は負荷で決めない(fixed)。
  const weeklyRule = React.useMemo(() => {
    const list = Array.isArray(weeklyRules) ? weeklyRules : [];
    return normalizeWeeklyRule(list.find((r) => r && String(r.name || '').trim() === name) || null);
  }, [weeklyRules, name]);
  const fixed = React.useMemo(
    () => fixedFromWeekly({ rule: weeklyRule, ymds: docDayKeys(hereDoc), hereApp }),
    [weeklyRule, hereDoc, hereApp],
  );
  // 📌 2026-09-17 清水さんの言葉「営業日ごとボタンでどっちで働くか切り替えれればいいけど、
  //   そうでもなく、どこで切り替えれるの？謎すぎる」
  //   その日が「この日だけ(③の札を押した日)」で決まったのか「毎週(②)」なのかを、
  //   札の見た目と理由の文に使う。🚨 決めるのは純関数(fixedByFromWeekly)。画面は出すだけ。
  const fixedBy = React.useMemo(
    () => fixedByFromWeekly({ rule: weeklyRule, ymds: docDayKeys(hereDoc) }),
    [weeklyRule, hereDoc],
  );

  const [openDay, setOpenDay] = React.useState('');
  const [oldOpen, setOldOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [out, setOut] = React.useState(null);
  const [error, setError] = React.useState('');
  const aliveRef = React.useRef(true);
  // 🚨 StrictMode は effect を 付けて→外して→付け直す。cleanup だけ書くと初回で false になり
  //   「引き直しています」のまま止まる(SharedWorkerStrip で実測 2026-09-05)。
  React.useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);

  // 🚨 配置は純関数が決める。画面は出すだけ。
  // 🚨 minBlockDays を **渡し忘れない**。渡さないと既定の1日のままで、清水さんの
  //   「そっちに移動することが多くするか」(往復の量)が画面から効かない(2026-09-05 実測)。
  const plan = React.useMemo(() => allocateSharedWorker({
    name,
    here: hereDoc,
    there: thereDoc,
    mode,
    priority,
    minBlockDays,
    nowMs,
    hereLabel,
    thereLabel,
    fixed,
    fixedBy,
  }), [name, hereDoc, thereDoc, mode, priority, minBlockDays, nowMs, hereLabel, thereLabel, fixed, fixedBy]);

  const groundKey = [name, nowMs, horizonDays, mode, priority, minBlockDays, hereDoc && hereDoc.fingerprint, thereDoc && thereDoc.fingerprint].join('|');
  React.useEffect(() => { setOut(null); setError(''); setOpenDay(''); }, [groundKey]);

  // 🚨 つまみを動かしている **途中では保存しない**。step=10 なので 0→100 のひと引きで
  //   onChange が最大10回発火し、その度に保存(Firestore への書き込み)が走る。
  //   指を離した時・欄から出た時・キーを離した時だけ 1回 呼ぶ。
  const [priorityDraft, setPriorityDraft] = React.useState(null);
  React.useEffect(() => { setPriorityDraft(null); }, [priority]);
  const priorityShown = priorityDraft == null ? Number(plan.priority) : priorityDraft;
  const priorityPending = priorityDraft != null && priorityDraft !== Number(plan.priority);
  const commitPriority = React.useCallback(() => {
    if (priorityDraft == null) return;
    if (typeof onChangePriority === 'function') onChangePriority(priorityDraft);
  }, [priorityDraft, onChangePriority]);

  const run = React.useCallback(async () => {
    // 🚨 引き直せない理由の判定は **純関数(planRunBlocker)** が持つ。画面は文を出すだけ。
    //   ここに `horizonDays || 5` と書くと、読めない時に勝手に5営業日で引き直し、
    //   期間ぜんぶの「前」と5日ぶんの「後」を矢印で並べてしまう(Number(null)===0 の罠)。
    const blocked = planRunBlocker({
      name, planDays: plan.days, horizonDays, nowMs, runnable: typeof runRung === 'function', thereApp: thereApp || '',
    });
    if (blocked) { setError(blocked); return; }
    // 👥 2026-09-16 向こうの工場を渡す = 休みの表の記号が 応援(support:◯◯)になり、計算が「◯◯の応援」と言える
    const rung = buildSharedPlanRung({ name, planDays: plan.days, horizonDays, hereLabel, thereLabel, thereApp: thereApp || '' });
    if (!rung) { setError('この配置では引き直す段が作れません'); return; }
    // 🚨 2026-09-12: 押した配置を **決定** として親へ渡す。親が書類へ載せ、盤(納期一覧・カード)が
    //   この配置の休みで引き直る。相手の工場も同じ書類を読むので、向こうの盤にも効く。
    //   それまでは帯の中の1行の数字が出るだけで、盤は1ミリも変わらなかった。
    if (typeof onDecide === 'function') {
      // 🚨 2026-09-14 決めた時刻は **押した時刻**。計算の基準時刻(nowMs)を渡すと、過去の期間を選んで
      //   押した決定が「古い」と読まれ、相手の古い配置に負ける(ChatGPT の指摘②)。
      const decidedAtMs = Date.now();
      const placement = buildPlacement({ name, planDays: plan.days, hereApp, thereApp, nowMs: decidedAtMs });
      if (placement) onDecide(placement);
    }
    setBusy(true); setError(''); setOut(null);
    try {
      const got = await runRung(rung, 0);
      if (!aliveRef.current) return;
      const planRun = {
        key: rung.key, label: rung.label, horizonDays: rung.horizonDays,
        normalized: got ? got.normalized : null, simResult: got ? got.simResult : null, tookMs: got ? got.tookMs : null,
      };
      setOut({ ...measurePlanRun({ planRun, baseRun, nowMs }), label: rung.label });
    } catch (e) {
      if (aliveRef.current) setError((e && e.message) ? String(e.message) : '引き直しに失敗しました');
    } finally {
      if (typeof disposeRun === 'function') { try { disposeRun(); } catch { /* 畳めなくても止めない */ } }
      if (aliveRef.current) setBusy(false);
    }
  }, [runRung, name, nowMs, horizonDays, plan, hereLabel, thereLabel, baseRun, disposeRun, onDecide, hereApp, thereApp]);

  // ── ここから描くだけ ───────────────────────────────────────────────────────
  // 🚨 2026-09-12「押せるのか / 押せないなら なぜか」を **1箇所** で決める。
  //   色と disabled で別の式を持つと、押せないのに押せそうな札ができる(実際そうなっていた)。
  const noPlacedDays = plan.summary.thereDays + plan.summary.hereDays === 0;
  const cantRun = !!(disabled || busy || !name || noPlacedDays);
  //   理由は 純関数が作った文をそのまま出す。ここで新しい文を作らない。
  //   相手の書類が古い/無い時は plan.missingText がその事を言っている。
  const cantRunWhy = busy ? ''
    : (!name ? '動かす人が決まっていません'
      : (noPlacedDays
        ? ((plan.missingText && plan.missingText.length)
          ? plan.missingText.join('・')
          : `${hereLabel}にも ${thereLabel}にも置く日がありません`)
        : ''));
  // 🚚 2026-09-12 清水さん「両方シュミレーションがこう変わるっていうのを画面で見せないとダメ」
  //   🚨 出せるのは **分(時間)** まで。相手の書類にロットが1件も入っていないので、
  //     相手の遅れが何件になるかは こちらでは出せない。作り話をしない。
  // 🚨 向こうの書類が見ている終わりと、こちらの窓の終わりが違うか。
  //   どちらかが読めない時は **何も言わない**(「同じ」と決めつけない)。
  const thereHorizonMs = (thereDoc && Number.isFinite(Number(thereDoc.horizonEnd))) ? Number(thereDoc.horizonEnd) : null;
  const hereHorizonMs = (out && out.after && Number.isFinite(Number(out.after.windowEndMs))) ? Number(out.after.windowEndMs) : null;
  const thereHorizonText = (thereHorizonMs != null && hereHorizonMs != null && ymdText(thereHorizonMs) !== ymdText(hereHorizonMs))
    ? `${hereLabel} ${ymdText(hereHorizonMs)} まで／${thereLabel} ${ymdText(thereHorizonMs)} まで`
    : '';
  const thereEffect = planSideEffect({ days: plan.days, side: PLACE.THERE });
  // 📋 相手の納期一覧の件数(相手が最後に開いた時の物)。🚨 数は書類の行の tier を数えるだけ(dueListCounts)。
  const thereDueCounts = dueListCounts(thereDueList);
  const thereDueLabel = dueListText({ doc: thereDueList, label: thereLabel });
  const hereEffect = planSideEffect({ days: plan.days, side: PLACE.HERE });
  const isPriority = mode === PLAN_MODE.PRIORITY;
  const opened = plan.days.find((d) => d.ymd === openDay) || null;
  // 📌 2026-09-17 「この日だけ」で決めた日の1文。文は純関数が作る(画面は出すだけ)。
  const dayRuleLine = dayRuleText({
    rule: weeklyRule, ymds: plan.days.map((d) => d.ymd), hereApp, hereLabel, thereLabel,
  });
  const thereWritten = ymdText(thereDoc && thereDoc.writtenAt);
  // 🚨 横に並べる件数は **書類まるごとの合計**。days[最後] を使ってはいけない
  //   (日ごとは 納期線がその日より後のロットを落とすので、左の measureRun.count と
  //    切り方が違う数を並べる事になる。2026-09-06 実測 1件 対 0件)。
  const thereTotals = (thereDoc && thereDoc.totals && typeof thereDoc.totals === 'object')
    ? thereDoc.totals : null;

  // 色は工場で引く(here/there では引かない)。書類が読めるまでは工場が分からない。
  const hereAppId = hereApp || (hereDoc && hereDoc.app) || null;
  const thereAppId = thereApp || (thereDoc && thereDoc.app) || null;
  const hereTone = toneOf(hereAppId);
  const chipClass = (place) => (place === PLACE.HERE
    ? hereTone.chip
    : (place === PLACE.THERE ? toneOf(thereAppId).chip : NONE_CHIP));
  const placeText = (place) => (place === PLACE.HERE ? hereLabel : place === PLACE.THERE ? thereLabel : '決まっていません');
  const blockNow = Math.max(1, Math.trunc(Number(minBlockDays)) || 1);
  // 👤 両方の書類の「そのまま信じてはいけない」札。文は純関数が作る(画面は並べるだけ)。
  const warnOf = (doc, label) => (doc && Array.isArray(doc.warnings) ? doc.warnings.map((w) => `${label}: ${w}`) : []);
  const warnText = [...warnOf(hereDoc, hereLabel), ...warnOf(thereDoc, thereLabel)];

  return (
    <section
      className="rounded-xl border-2 border-slate-300 bg-white fi-tap-text"
      data-opsim-shared-plan=""
      data-opsim-shared-plan-name={name}
      data-opsim-shared-plan-mode={plan.mode}
    >
      {/* ── 見出し: この帯が答える1つの問い ─────────────────────────────── */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-t-xl border-b-2 border-slate-300 bg-slate-100 px-3 py-1.5">
        <span className="inline-flex items-center gap-1 font-black text-slate-900">
          <Users className="h-4 w-4" />
          両方の工場で働ける人の配置
        </span>
        <span className="text-slate-700">
          この期間、{name ? `${name}さんを` : 'その人を'} どの営業日に <b className="text-slate-900">{hereLabel}</b>・どの営業日に <b className="text-slate-900">{thereLabel}</b> に置くか
        </span>
      </div>

      {/* ── ① 誰を動かすか ─────────────────────────────────────────────── */}
      <section data-opsim-shared-step="1" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 px-3 py-1.5">
        <StepHead n="①" title="誰を動かすか" hint="両方の名簿に同じ名前で居る人だけ" />
        {!shared.ready ? (
          <span className="text-slate-600">{thereLabel}の名簿はまだ読めていません（読めると、同じ名前の人がここに出ます）</span>
        ) : shared.names.length === 0 ? (
          <span className="text-slate-600">両方の名簿に同じ名前の人は居ません（{hereLabel} {fmtInt(shared.hereCount)}人／{thereLabel} {fmtInt(shared.thereCount)}人）</span>
        ) : shared.names.length > 1 ? (
          <select
            value={name}
            onChange={(e) => setWho(e.target.value)}
            className="fi-tap-text min-h-11 rounded-lg border-2 border-slate-400 bg-white px-2 font-black text-slate-900"
            aria-label="どの人を動かすか"
          >
            {shared.names.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        ) : (
          <b className="text-slate-900">{name}さん</b>
        )}
      </section>

      {/* ── ② 毎週の決まり。2026-09-14 清水さん「両方作業できる作業者を曜日毎で指定したのに、
          シュミレーションでは全く適用していなかった」→ ここで1回登録し、両方の工場の盤に効かせる。
          🚨 押す物は44px以上・文字は .fi-tap-text(12px以上)。保存先は親(共有棚)。 ── */}
      {shared.names.length > 0 && name ? (
        <section data-opsim-shared-step="2" className="border-b border-slate-200 px-3 py-1.5"
          data-opsim-weekly={name} data-opsim-weekly-text={weeklyText({ rule: weeklyRule, hereApp, hereLabel, thereLabel })}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <StepHead n="②" title="毎週の決まり" hint="押すたびに 工場 → 工場 → 決めない の順で変わります（③の営業日の札で 1日だけ変えられます）" />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {[1, 2, 3, 4, 5, 6, 0].map((wd) => {
              const app = (weeklyRule && weeklyRule.weekly[String(wd)]) || '';
              const label = app ? (app === hereApp ? hereLabel : thereLabel) : '決めない';
              const cls = app ? (app === hereApp ? hereTone.solid : toneOf(thereAppId).solid) : 'border-slate-300 bg-white text-slate-600';
              return (
                <button key={wd} type="button"
                  data-opsim-weekly-day={String(wd)} data-opsim-weekly-app={app}
                  disabled={typeof onSaveWeekly !== 'function'}
                  title={`${WEEKDAY_JA[wd]}曜: 押すたびに ${hereLabel} → ${thereLabel} → 決めない の順に変わります`}
                  onClick={() => {
                    if (typeof onSaveWeekly !== 'function') return;
                    const next = app === '' ? hereApp : (app === hereApp ? thereApp : '');
                    const weekly = { ...((weeklyRule && weeklyRule.weekly) || {}) };
                    if (next) weekly[String(wd)] = next; else delete weekly[String(wd)];
                    onSaveWeekly({ name, weekly });
                  }}
                  className={`fi-tap-text inline-flex min-h-11 items-center gap-1 rounded-lg border-2 px-2 font-black ${cls}`}>
                  <span>{WEEKDAY_JA[wd]}</span><span>{label}</span>
                </button>
              );
            })}
          </div>
          <div className="mt-1 text-slate-700">
            {weeklyText({ rule: weeklyRule, hereApp, hereLabel, thereLabel }) || '曜日では決めていません（押して決めると、両方の工場の盤に毎週効きます）'}
            {typeof onSaveWeekly !== 'function' ? <span className="ml-1 text-slate-500">（この画面からは変えられません）</span> : null}
          </div>
        </section>
      ) : null}

      {/* ── ③ この期間はどうするか ──────────────────────────────────────── */}
      {shared.names.length > 0 ? (
        <section data-opsim-shared-step="3" className="border-b-2 border-slate-300 px-3 py-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <StepHead n="③" title="この期間はどうするか" hint="日の札を押すと その日だけ決められます（残りは負荷で振り分けます）" />

            {/* 決め方: 平均で決める / どちらかを優先する */}
            <span className="inline-flex items-center overflow-hidden rounded-lg border-2 border-slate-400" role="group" aria-label="配置の決め方">
              <button
                type="button"
                data-opsim-shared-mode={PLAN_MODE.BALANCE}
                aria-pressed={!isPriority}
                onClick={() => { if (typeof onChangeMode === 'function') onChangeMode(PLAN_MODE.BALANCE); }}
                className={`fi-tap-text min-h-11 px-2.5 font-black ${!isPriority ? 'bg-slate-800 text-white' : 'bg-white text-slate-700'}`}
              >
                平均で決める
              </button>
              <button
                type="button"
                data-opsim-shared-mode={PLAN_MODE.PRIORITY}
                aria-pressed={isPriority}
                onClick={() => { if (typeof onChangeMode === 'function') onChangeMode(PLAN_MODE.PRIORITY); }}
                className={`fi-tap-text min-h-11 border-l-2 border-slate-400 px-2.5 font-black ${isPriority ? hereTone.on : 'bg-white text-slate-700'}`}
              >
                {hereLabel}を優先 {pct(plan.priority)}
              </button>
            </span>
            {isPriority ? (
              <label className="inline-flex min-h-11 items-center gap-1 text-slate-700">
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="10"
                  value={Math.round(Number(priorityShown) * 100)}
                  data-opsim-shared-priority={String(plan.priority)}
                  onChange={(e) => setPriorityDraft(Number(e.target.value) / 100)}
                  onPointerUp={commitPriority}
                  onKeyUp={commitPriority}
                  onBlur={commitPriority}
                  aria-label={`${hereLabel}を優先する割合`}
                  className="h-5 w-32"
                />
                <span className="tabular-nums font-black text-slate-900">{pct(priorityShown)}</span>
                {priorityPending ? <span className="text-slate-500">（指を離すと反映します）</span> : null}
              </label>
            ) : null}

            {/* 往復を減らす: 最低◯日は同じ工場に居る。🚨 決めるのは純関数(minBlockDays)。 */}
            <label className="inline-flex min-h-11 items-center gap-1 text-slate-700">
              最低
              <select
                value={String(blockNow)}
                data-opsim-shared-block={String(blockNow)}
                onChange={(e) => { if (typeof onChangeMinBlockDays === 'function') onChangeMinBlockDays(Number(e.target.value)); }}
                disabled={typeof onChangeMinBlockDays !== 'function'}
                className="fi-tap-text min-h-11 rounded-lg border-2 border-slate-400 bg-white px-2 font-black text-slate-900"
                aria-label="最低何日は同じ工場に居るか"
              >
                {[1, 2, 3].map((n) => <option key={n} value={String(n)}>{n}日</option>)}
              </select>
              は同じ工場
            </label>
          </div>

          {/* 日の札。押すと なぜ その日そちらなのかが出る。
              🚨 2026-09-15 ②で決まった日(点線)と ③の負荷で決めた日(実線)を枠で分ける。 */}
          <div className="mt-1 flex flex-wrap items-center gap-1" data-opsim-shared-days={String(plan.days.length)}>
            <span className="inline-flex items-center gap-1 text-slate-600"><CalendarRange className="h-4 w-4" />営業日ごと</span>
            {plan.days.length === 0 ? (
              <span className="text-slate-600">日ごとの負荷がまだ読めていません（{hereLabel}の計算が終わると出ます）</span>
            ) : plan.days.map((d) => {
              // 📌 2026-09-17 清水さんの言葉「営業日ごとボタンでどっちで働くか切り替えれればいい」
              //   この日だけ(day) = 太い枠＋📌／毎週(weekly) = 点線／負荷で決めた日 = 実線。
              const byDay = d.whyKey === 'day';
              const byWeekly = d.whyKey === 'weekly';
              return (
                <button
                  key={d.ymd}
                  type="button"
                  data-opsim-shared-day={d.ymd}
                  data-opsim-shared-place={d.place == null ? 'null' : d.place}
                  data-opsim-shared-fixed={byDay ? 'day' : (byWeekly ? '1' : '0')}
                  onClick={() => {
                    // 🚨 保存の口が無い時は 今までどおり 理由の開け閉めだけ(渡されなければ1行も動かない)。
                    if (typeof onSaveWeekly !== 'function') { setOpenDay(openDay === d.ymd ? '' : d.ymd); return; }
                    // この日の決めを '' → この工場 → 向こうの工場 → '' の順に回す。書くのは親(共有棚)。
                    const cur = (weeklyRule && weeklyRule.days && weeklyRule.days[d.ymd]) || '';
                    const next = cur === '' ? hereApp : (cur === hereApp ? thereApp : '');
                    const days = { ...((weeklyRule && weeklyRule.days) || {}) };
                    if (next) days[d.ymd] = next; else delete days[d.ymd];
                    onSaveWeekly({ name, weekly: (weeklyRule && weeklyRule.weekly) || {}, days });
                    setOpenDay(d.ymd);
                  }}
                  title={`${dayLabel(d.ymd)} 押すと この日だけ ${hereLabel} → ${thereLabel} → 決めない の順に変わります（両方の工場の盤にすぐ効きます）／${d.why}`}
                  className={`fi-tap-text min-h-11 rounded-lg px-2 font-bold ${chipClass(d.place)} ${byDay ? 'border-4' : (byWeekly ? 'border border-dashed' : 'border-2')} ${openDay === d.ymd ? 'ring-2 ring-slate-900' : ''}`}
                >
                  {byDay ? <span className="mr-0.5">📌</span> : null}
                  <span className="tabular-nums">{dayLabel(d.ymd)}</span>
                  <span className="ml-1 font-black">{d.place == null ? '—' : placeText(d.place)}</span>
                </button>
              );
            })}
          </div>
          {plan.days.length > 0 ? (
            <div className="mt-0.5 text-slate-600">
              太い枠＋📌＝この日だけ決めた日／点線の枠＝②の毎週で決まった日／実線の枠＝③の負荷で決めた日／「—」＝決まっていません
              （{hereLabel} {fmtInt(plan.summary.hereDays)}日・{thereLabel} {fmtInt(plan.summary.thereDays)}日・決めていない {fmtInt(plan.summary.unknownDays)}日）
            </div>
          ) : null}
          {/* 📌 2026-09-17 「この日だけ」で決めた日を1文で。文は純関数(dayRuleText)が作る。 */}
          {dayRuleLine ? (
            <div className="mt-0.5 font-bold text-slate-800" data-opsim-day-rule-text={dayRuleLine}>
              📌 {dayRuleLine}（もう一度その日の札を押すと 変わります）
            </div>
          ) : null}

          {opened ? (
            <div className="mt-1 rounded-lg border border-slate-300 bg-slate-50 px-2 py-1 text-slate-700" data-opsim-shared-why={opened.ymd}>
              <b className="text-slate-900">{dayLabel(opened.ymd)} {placeText(opened.place)}</b>
              <span className="ml-2">{opened.why}</span>
            </div>
          ) : null}

          {/* 🚨 2026-09-12 清水さん「『この配置で引き直す』ってボタン押しても全くシュミレーションが変わらなかったのはなんで？」
              原因の1つ: **押せないのに水色のまま** だった。
              disabled の式(相手の書類が古いと thereDays+hereDays が 0 になる)と、
              色の式(disabled||busy しか見ない)が **別々** だったので、
              灰色にならず・回りもせず・文字も1つも出ない ＝ 押したのに何も起きないように見えた。
              🚨 同じ判定を2つ書かない。1つの変数を 色と disabled の両方で使う。 */}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <button
              type="button"
              onClick={run}
              disabled={cantRun}
              data-opsim-shared-plan-run=""
              data-opsim-shared-plan-cant={cantRun ? '1' : '0'}
              title={cantRunWhy || `決めた配置（${thereLabel}に居る日は ${hereLabel} では休み）で、割付を1回だけ引き直します。`}
              className={`fi-tap-text inline-flex min-h-11 items-center gap-1 rounded-lg border-2 px-3 font-black ${cantRun ? 'border-slate-300 bg-slate-100 text-slate-400' : hereTone.solid}`}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {busy ? '引き直しています…' : 'この配置で引き直す'}
            </button>
            {/* 🚨 押せない時は **ボタンの隣に** 理由を出す。下の小さい灰色の行だけだと読まれない。 */}
            {cantRun && !busy && cantRunWhy
              ? <span className="font-black text-slate-800" data-opsim-shared-plan-cant-why="1">押せません: {cantRunWhy}</span>
              : null}
            {error ? <span className="font-black text-rose-700">{error}</span> : null}
            {!plan.inputsOk ? (
              <span className="text-slate-600" data-opsim-shared-plan-missing={plan.missing.join(',')}>
                足りていない物: {plan.missingText.join('・')}（{thereLabel}の日ごとの負荷が読めるまで、決められない日が残ります）
              </span>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* ══ 結果 ══════════════════════════════════════════════════════════ */}
      <section data-opsim-shared-result="" className="px-3 py-1.5">
        {/* ── 🚨 2026-09-12 いま盤に効いている配置。無ければ「効いていない」と言う ── */}
        {shared.names.length > 0 ? (
          isPlacementActive(decidedPlacement) ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border-2 border-emerald-500 bg-emerald-50 px-2 py-1 font-bold text-emerald-900"
              data-opsim-shared-decided={String(decidedPlacement.decidedAt || '')}>
              <span className="font-black">✅ いま盤に効いている配置</span>
              <span>{placementText({ placement: decidedPlacement, hereApp, hereLabel, thereLabel })}</span>
              <span className="font-normal text-emerald-800">（{thereLabel} に居る日は {hereLabel} の盤で休み。相手の盤も同じ配置で引き直ります）</span>
              {typeof onClearDecision === 'function' ? (
                <button type="button" onClick={onClearDecision} data-opsim-shared-decided-clear=""
                  className="fi-tap-text ml-auto inline-flex min-h-11 items-center rounded-lg border-2 border-emerald-700 bg-white px-3 font-black text-emerald-800">
                  配置を外す
                </button>
              ) : null}
            </div>
          ) : decidedPlacement && decidedPlacement.cleared === true ? (
            /* 🚨 2026-09-14 外した事も決定。相手の書類に古い配置が残っていても、こちらの「外した」が新しければ勝つ。 */
            <div className="rounded-lg border border-slate-300 bg-slate-50 px-2 py-1 text-slate-700" data-opsim-shared-decided="" data-opsim-shared-cleared={String(decidedPlacement.decidedAt || '')}>
              {placementText({ placement: decidedPlacement, hereApp, hereLabel, thereLabel })}。③の日の札は提案で、盤には効いていません（②の毎週は効いたままです）。
            </div>
          ) : (
            <div className="rounded-lg border border-slate-300 bg-slate-50 px-2 py-1 text-slate-700" data-opsim-shared-decided="">
              まだ配置を決めていません。下の日の札は提案で、盤には効いていません。「この配置で引き直す」を押すと盤に効きます。
            </div>
          )
        ) : null}

        {/* ── 引き直した結果。数は measureRun の物をそのまま出す ─────────────── */}
        {out ? (
          <div
            className="mt-1 grid gap-1 sm:grid-cols-2"
            data-opsim-shared-plan-result={out.sameWindow ? '1' : '0'}
          >
            {/* 🚨 ここに並ぶ数は どちらも atRiskBreakdown の切り方(この先で遅れる ∪ 手が付かない)。
                「すでに納期を過ぎた」は別の欄・濃い赤で出す(混ぜない・消さない。2026-08-22)。
                🚨 左は measureRun.count、右は **書類の totals**(同じ式)。
                右に days[最後].atRiskCount を使うと 納期線が窓より後のロットが落ちて
                右だけ少なく出る(2026-09-06 実測 1件 対 0件)。days[最後] は件数に使わない。 */}
            <div className={`rounded-lg border-2 px-2 py-1 ${hereTone.chip}`} data-opsim-shared-plan-here="">
              <div className="font-black">{hereLabel}（この場で引き直した数）</div>
              <div className="mt-0.5">
                <span>この先で遅れる</span>
                <b className={`ml-1 tabular-nums ${LATE_TONE.forecast.text}`}>{fmtInt(out.before.count)}件</b>
                {out.sameWindow ? (
                  <>
                    <span className="mx-1">→</span>
                    <b className={`tabular-nums ${LATE_TONE.forecast.text}`}>{fmtInt(out.after.count)}件</b>
                    {num(out.delta.count) != null ? (
                      <b className={`ml-1 tabular-nums ${out.delta.count > 0 ? 'text-rose-700' : out.delta.count < 0 ? 'text-emerald-700' : 'text-slate-600'}`}>
                        （{signed(out.delta.count)}件）
                      </b>
                    ) : null}
                  </>
                ) : null}
              </div>
              <div className="mt-0.5 text-slate-600">
                この先で遅れる {fmtInt(out.after.forecastLate)}・納期があるのに手が付かない {fmtInt(out.after.unresolvedDue)}
              </div>
              {num(out.after.alreadyPastDue) != null ? (
                <div className="mt-0.5">
                  <span className="text-slate-600">すでに納期を過ぎている</span>
                  <b className={`ml-1 tabular-nums ${LATE_TONE.past.text}`}>{fmtInt(out.after.alreadyPastDue)}件</b>
                  <span className="text-slate-600">（今日の事実。置き分けても減りません）</span>
                </div>
              ) : null}
              {!out.sameWindow ? (
                <div className="mt-0.5 font-bold text-rose-700">窓の端が違うので、引き直した後の件数は並べられません</div>
              ) : null}
              {num(out.after.tookMs) != null ? (
                <div className="mt-0.5 tabular-nums text-slate-600">（{fmt1(Number(out.after.tookMs) / 1000)}秒・本当に引き直した数）</div>
              ) : null}
            </div>

            <div className={`rounded-lg border-2 px-2 py-1 ${toneOf(thereAppId).chip}`} data-opsim-shared-plan-there="">
              <div className="font-black">{thereLabel}（{thereLabel}アプリが書いた書類の数）</div>
              {thereTotals && num(thereTotals.atRiskCount) != null ? (
                <>
                  <div className="mt-0.5">
                    <span>この先で遅れる</span>
                    <b className={`ml-1 tabular-nums ${LATE_TONE.forecast.text}`}>{fmtInt(thereTotals.atRiskCount)}件</b>
                  </div>
                  <div className="mt-0.5 text-slate-600">
                    この先で遅れる {fmtInt(thereTotals.forecastLateCount)}・納期があるのに手が付かない {fmtInt(thereTotals.unresolvedDueCount)}
                  </div>
                  {num(thereTotals.alreadyPastDueCount) != null ? (
                    <div className="mt-0.5">
                      <span className="text-slate-600">すでに納期を過ぎている</span>
                      <b className={`ml-1 tabular-nums ${LATE_TONE.past.text}`}>{fmtInt(thereTotals.alreadyPastDueCount)}件</b>
                    </div>
                  ) : null}
                  {/* 🚚 2026-09-12: 置き分けた後の **向こう** を、出せる所まで出す。
                      件数は出せないので 分(時間)で言う。何が出せて何が出せないかを隠さない。 */}
                  <div className="mt-0.5" data-opsim-shared-plan-there-effect={String(thereEffect.withPerson)}>
                    <span className="text-slate-600">この配置だと</span>
                    <b className="ml-1">{thereLabel}</b>
                    <span className="ml-1">に</span>
                    <b className="tabular-nums">{fmtInt(thereEffect.withPerson)}日</b>
                    <span>／</span>
                    <b className="ml-1">{hereLabel}</b>
                    <span className="ml-1">に</span>
                    <b className="tabular-nums">{fmtInt(hereEffect.withPerson)}日</b>
                    {num(thereEffect.gapMin) != null ? (
                      <span className="ml-1 text-slate-600">
                        （{name}さんが {hereLabel} に居る日、{thereLabel} に足りないのは
                        <b className="mx-0.5 tabular-nums">{fmt1(thereEffect.gapMin / 60)}時間</b>）
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 text-slate-600">
                    {thereWritten ? `${thereWritten} の書類` : '書いた時刻が入っていないので いつの物か分かりません'}
                    。置き分けた後の数は {thereLabel}アプリで引き直すと出ます
                    <DailyLoadRefreshButton target={targetAppOf({ doc: thereDoc, label: thereLabel })} className="ml-2" />
                  </div>
                </>
              ) : (
                <div className="mt-0.5 text-slate-600">の負荷は読めていません（{thereLabel}アプリが書いた書類が届いていません）
                  <DailyLoadRefreshButton target={targetAppOf({ doc: thereDoc, label: thereLabel })} className="ml-2" />
                </div>
              )}
            </div>

            {/* 🚨 2026-09-12 確かめ役が実測: 左(ここ)は6営業日・右(向こう)は15営業日 の数字が
                何も言わずに並んでいた。窓が違う数を並べると 引き算したくなる(2026-08-22「3つの数を混ぜるな」)。
                向こうの書類が見ている終わりが こちらと違う時は、比べられない事を字で出す。 */}
            {thereHorizonText ? (
              <div className="font-bold text-slate-800 sm:col-span-2" data-opsim-shared-plan-window="differ">
                ⚠ 見ている期間が違います（{thereHorizonText}）。左右の件数はそのまま引き算できません
              </div>
            ) : null}
            <div className="text-slate-600 sm:col-span-2">
              ⚠ {hereLabel}の数は この場で引き直した結果。{thereLabel}の数は {thereLabel}アプリが書いた1枚の書類から そのまま出しています。
            </div>
          </div>
        ) : null}

        {/* ── 📋 2026-09-15 向こうの納期一覧の件数(相手の書類から) ── */}
        {thereDueCounts ? (
          <div className="mt-1 text-slate-700" data-opsim-shared-there-due={`${thereDueCounts.past}/${thereDueCounts.late}/${thereDueCounts.unknown}`}>
            {thereDueLabel}: <b className="text-rose-700">すでに過ぎた {fmtInt(thereDueCounts.past)}件</b>・<b className="text-rose-700">この先で遅れる {fmtInt(thereDueCounts.late)}件</b>・判定できません {fmtInt(thereDueCounts.unknown)}件・間に合う {fmtInt(thereDueCounts.ok)}件（表は納期一覧の下）
          </div>
        ) : null}

        {/* 👤 「読めてはいるが そのまま信じてはいけない」事。純関数が作った文をそのまま出す。
            🚨 橙(amber)は 空き(スキル待ち)専用・赤は遅れ専用(lateTone.js)。ここは灰の枠にする。 */}
        {warnText.length > 0 && shared.names.length > 0 ? (
          <div
            className="mt-1 rounded-lg border-2 border-slate-400 bg-slate-50 px-2 py-1 font-bold text-slate-800"
            data-opsim-shared-plan-warn={String(warnText.length)}
          >
            ⚠ {warnText.join('／')}
          </div>
        ) : null}

        {/* ── 今までの「期間まるごと2通り」。消さずにここへ畳む(押せば必ず出る) ── */}
        <div className="mt-1 border-t border-slate-200 pt-1">
          <button
            type="button"
            data-opsim-shared-old-toggle={oldOpen ? '1' : '0'}
            aria-expanded={oldOpen}
            onClick={() => setOldOpen(!oldOpen)}
            className="fi-tap-text inline-flex min-h-11 items-center gap-1 rounded-lg border-2 border-slate-300 bg-white px-3 font-bold text-slate-700"
          >
            <ChevronDown className={`h-4 w-4 ${oldOpen ? 'rotate-180' : ''}`} />
            期間まるごと どちらかに置く（今までの2通り）
          </button>
          {oldOpen ? (
            <div className="mt-1">
              <SharedWorkerStrip
                hereWorkers={hereWorkers}
                thereNames={thereNames}
                pausedNames={pausedNames}
                hereLabel={hereLabel}
                thereLabel={thereLabel}
                nowMs={nowMs}
                horizonDays={horizonDays}
                untilMs={untilMs}
                worksOnDay={worksOnDay}
                runRung={runRung}
                disposeRun={disposeRun}
                disabled={disabled}
                inputKey={inputKey}
              />
            </div>
          ) : null}
        </div>
      </section>
    </section>
  );
}

export default SharedWorkerPlan;
