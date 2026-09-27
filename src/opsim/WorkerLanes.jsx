// =============================================================================
//  src/opsim/WorkerLanes.jsx — 操業シミュレーターの「人ごとの指示」＝ 人・日順
// -----------------------------------------------------------------------------
//  🚨 決まり13（2026-09-03 清水さん）「こんな二つだけ無駄にでっかいカードで指示見せられてもだからって感じ」。
//    この画面が伝える物を1行で: **今日、この人が、どの順で何をやって、いつ終わり、納期に対してどうか。手が空くならなぜか。**
//  🚨 決まり14-5: 日 → 人 → その日の順番（PersonDay.jsx）。案A(2026-09-16): 1日＝1段、その中を人ごとの札(広い画面3列)。
//  🚨 2枚の札（現在／終わったら）は **消さない**。各人の見出しに畳む（今日の見出しで開ける）。
//
//  計算結果は assignments / snapshot / idleLog のまま。ここでは割付や時刻を作らない。
//  ⚠ px 直書きをしない（rem 段）。
// =============================================================================
import React, { useMemo } from 'react';
import { buildWorkerPlans } from '../domain/workerPlan.js';
import { buildPersonDayRows } from '../domain/operationsSimulation/personDay.js';
import { buildWorkerColors, toneOf, workerNamesOf } from './workerColors.js';
import { buildDayColumns, workWindowOfSpec } from './dueAxis.js';
import { mainWorkerOf, assignmentsByLot } from './mainWorker.js';
import { PersonDay } from './PersonDay.jsx';
// 🧵 人がロットを離れた理由(lotResults[].lotSwitches)。集めるだけ(文は計算の why そのまま)。
import { collectLotSwitches } from './lotSwitchWhy.js';
// 🚨 「軽い方で回す営業日の数」は horizonRange.js が持つ1つの値。ここで 5 を書かない。
import { OPSIM_LIGHT_DAYS } from './horizonRange.js';
// 🎨 絵の語彙(2026-09-15)。見出しの線画だけに使う(この画面で数は作らない)。
import { Glyph } from './vizKit.jsx';
// 👥 応援・休みの人(2026-09-16 案A)。その日その人が居ない理由は **計算の idleLog の reason そのまま**。
//   🚨 ここで文を作らない。IDLE_REASON の字(休み／他の作業／製品検査の応援／最終検査の応援…)を引くだけ。
import { IDLE_REASON } from '../domain/operationsSimulation/simulate.js';

/** 「この日は居ない」と言ってよい理由(勤務時間外・休憩は違う)。字は simulate の IDLE_REASON そのもの。 */
const AWAY_REASONS = new Set([
  IDLE_REASON.OFF, IDLE_REASON.OTHER_WORK, IDLE_REASON.ROSTER_UNKNOWN,
  IDLE_REASON.SUPPORT_PRODUCT, IDLE_REASON.SUPPORT_FINAL,
].filter((r) => typeof r === 'string' && r));

const isNum = (value) => typeof value === 'number' && Number.isFinite(value);
const DAY = 86400000;

/**
 * 札の「納期との関係」(2026-09-02 決まり9)。🚨 判定は lotResults(lotVerdictById) の値そのまま。
 *   past … alreadyPastDue(今日の事実)。日数 = ceil((いま − 納期線) / 1日)
 *   soon … late && !alreadyPastDue(この見立ての結果)。日数 = ceil(lateMs / 1日)
 * 🚨 札の塗りは納期との関係だけ(赤=越えている / 点線の赤=この見立てで越える / 白=それ以外)。
 *   人の色は「現在」の小さな札に残す(色の意味を1つにする)。
 */
function dueRelationOf(verdict, nowMs) {
  if (!verdict) return { kind: 'none', days: null, cls: 'border-slate-300 bg-white' };
  if (verdict.alreadyPastDue === true) {
    const d = (isNum(nowMs) && isNum(verdict.dueLineMs)) ? Math.max(1, Math.ceil((nowMs - verdict.dueLineMs) / DAY)) : null;
    return { kind: 'past', days: d, cls: 'border-rose-600 bg-rose-50' };
  }
  if (verdict.late === true) {
    const d = isNum(verdict.lateMs) ? Math.max(1, Math.ceil(verdict.lateMs / DAY)) : null;
    return { kind: 'soon', days: d, cls: 'border-rose-400 border-dashed bg-rose-50' };
  }
  return { kind: 'none', days: null, cls: 'border-slate-300 bg-white' };
}

/** 札の右端の大きな数字（答えだけ大きく）。past=「+N日」赤 / soon=「+N日」＋「この見立てで越えます」。 */
function DueTag({ rel, dueLineMs }) {
  if (!rel || rel.kind === 'none') return null;
  const md = isNum(dueLineMs) ? `${new Date(dueLineMs).getMonth() + 1}/${new Date(dueLineMs).getDate()}` : '—';
  if (rel.kind === 'past') {
    return (
      <span className="ml-auto flex shrink-0 flex-col items-end leading-none" data-due-relation="past">
        <span className="text-2xl font-black tabular-nums text-rose-600">{isNum(rel.days) ? `+${rel.days}日` : '納期を過ぎています'}</span>
        <span className="mt-0.5 text-2xs font-bold text-rose-700">納期 {md} を過ぎています</span>
      </span>
    );
  }
  return (
    <span className="ml-auto flex shrink-0 flex-col items-end leading-none" data-due-relation="soon">
      <span className="text-lg font-black tabular-nums text-rose-600">{isNum(rel.days) ? `+${rel.days}日` : '終わりが出せません'}</span>
      <span className="mt-0.5 text-2xs font-bold text-rose-700">納期 {md} をこの見立てで越えます</span>
    </span>
  );
}

/** 指図の札（Codex 129ee00 から接いだ物。決まり14-4）。 */
function OrderChip({ orderNo }) {
  if (!orderNo) return null;
  return <span className="shrink-0 rounded bg-white/80 px-2 py-0.5 text-xs font-black text-slate-600 tabular-nums" data-order-no={orderNo}>指図 {orderNo}</span>;
}

function fmtDur(ms) {
  if (!isNum(ms) || ms < 0) return '時間の記録なし';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}分`;
  const hours = minutes / 60;
  return `${hours >= 10 ? Math.round(hours) : Math.round(hours * 10) / 10}時間`;
}

function fmtWhen(ms, nowMs) {
  if (!isNum(ms)) return '時刻の記録なし';
  const value = new Date(ms);
  const now = isNum(nowMs) ? new Date(nowMs) : null;
  const clock = `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
  if (now && value.getFullYear() === now.getFullYear()
    && value.getMonth() === now.getMonth() && value.getDate() === now.getDate()) return clock;
  return `${value.getMonth() + 1}/${value.getDate()} ${clock}`;
}

// 仮の入荷日で計算されているロット(2026-08-31)の断り書き。判定は normalizeInput の arrivalKind そのまま。
const ASSUMED_NOTE = '仮の入荷日で計算。本当の入荷日を入力すると計算し直します';

function CurrentCard({ item, tone, nowMs, selected, onSelect, assumed = false, verdict = null }) {
  if (!item) return null;
  const rel = dueRelationOf(verdict, nowMs);
  return (
    <button
      type="button"
      data-lot-id={item.lotId}
      onClick={() => onSelect(item.lotId)}
      title={assumed ? ASSUMED_NOTE : undefined}
      data-due-kind={rel.kind}
      className={`min-w-0 rounded-xl border-2 px-3 py-2 text-left ${rel.cls} ${selected ? 'ring-2 ring-cyan-500 ring-offset-1' : ''}`}
      aria-label={`現在 ${item.model}｜${item.tplName || 'テンプレ名なし'} ${item.stepTitle}`}
    >
      <div className="flex items-center gap-2">
        <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-black text-white ${tone.dot}`}>現在</span>
        {/* 決まり12: 品目コード｜テンプレ を必ず並べる（テンプレで作業内容が変わる）。 */}
        <span className="truncate text-lg font-black leading-tight text-slate-900">
          {assumed ? '［仮］' : ''}{item.model}
          <span className="mx-1 font-bold text-slate-400">｜</span>
          <span className="text-base font-bold text-slate-700">{item.tplName || 'テンプレ名なし'}</span>
        </span>
        <OrderChip orderNo={item.orderNo} />
        <DueTag rel={rel} dueLineMs={verdict ? verdict.dueLineMs : null} />
      </div>
      <div className="mt-1 truncate text-sm font-bold text-slate-700">{item.stepTitle}</div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-bold text-slate-600">
        <span>{isNum(item.remainingMs) ? `残り ${fmtDur(item.remainingMs)}` : '残り時間の記録なし'}</span>
        <span>{isNum(item.endMs) ? `${fmtWhen(item.endMs, nowMs)}ごろ終了` : '終了時刻の記録なし'}</span>
        {item.withWorker ? <span>{item.withWorker}さんと2人</span> : null}
      </div>
    </button>
  );
}

function NextCard({ item, hasSchedule, idleReason, nowMs, selected, onSelect, assumed = false, verdict = null }) {
  if (!item) {
    return (
      <div className="min-w-0 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-2">
        <div className="text-xs font-black text-slate-500">{hasSchedule ? '終わったら' : '次の予定'}</div>
        <div className="mt-1 text-sm font-bold leading-snug text-slate-600">
          {hasSchedule ? 'この見立てには、次の割り当てがありません' : '予定はまだ計算されていません'}
        </div>
        {idleReason ? <div className="mt-1 text-xs leading-snug text-slate-500">現在：{idleReason}</div> : null}
      </div>
    );
  }
  const rel = dueRelationOf(verdict, nowMs);
  return (
    <button
      type="button"
      data-lot-id={item.lotId}
      data-due-kind={rel.kind}
      onClick={() => onSelect(item.lotId)}
      title={assumed ? ASSUMED_NOTE : undefined}
      className={`min-w-0 rounded-xl border-2 px-3 py-2 text-left ${rel.cls} ${selected ? 'ring-2 ring-cyan-500 ring-offset-1' : ''}`}
      aria-label={`終わったら ${item.model}｜${item.tplName || 'テンプレ名なし'}`}
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0 rounded-md bg-slate-700 px-2 py-0.5 text-xs font-black text-white">終わったら</span>
        <span className="truncate text-lg font-black leading-tight text-slate-900">
          {assumed ? '［仮］' : ''}{item.model}
          <span className="mx-1 font-bold text-slate-400">｜</span>
          <span className="text-base font-bold text-slate-700">{item.tplName || 'テンプレ名なし'}</span>
        </span>
        <OrderChip orderNo={item.orderNo} />
        <DueTag rel={rel} dueLineMs={verdict ? verdict.dueLineMs : null} />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-bold text-slate-600">
        <span>{fmtWhen(item.startMs, nowMs)}から</span>
        <span>作業 {fmtDur(item.workMs)}</span>
        <span>{item.stepCount}工程</span>
        {item.withWorker ? <span>{item.withWorker}さんと2人</span> : null}
      </div>
    </button>
  );
}

/** 2枚の札を各人の見出しに畳んだ物（決まり13: 消さない・畳む）。1行の小さな札＋開くと元の2枚。 */
function FoldedCards({ plan, tone, nowMs, selectedLotId, onSelect, assumedIds, verdictOf }) {
  if (!plan) return null;
  const cur = plan.current; const nxt = plan.next;
  const chip = (label, item, cls) => (item ? (
    <button type="button" data-lot-id={item.lotId} onClick={() => onSelect(item.lotId)}
      className={`inline-flex min-h-11 min-w-0 max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-2xs ${cls} ${selectedLotId === item.lotId ? 'ring-1 ring-cyan-500' : ''}`}>
      <span className="font-black">{label}</span>
      <span className="truncate font-bold text-slate-800">{item.model}<span className="font-bold text-slate-500">｜{item.tplName || 'テンプレ名なし'}</span></span>
      {item.orderNo ? <span className="shrink-0 tabular-nums text-slate-500">指図 {item.orderNo}</span> : null}
      {label === 'いま' && isNum(item.remainingMs) ? <span className="shrink-0 text-slate-600">残り {fmtDur(item.remainingMs)}</span> : null}
      {label === '次' && isNum(item.startMs) ? <span className="shrink-0 text-slate-600">{fmtWhen(item.startMs, nowMs)}〜</span> : null}
    </button>
  ) : null);
  return (
    <details className="mt-1 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1" data-folded-cards={plan.name}>
      <summary className="flex min-h-11 cursor-pointer select-none flex-wrap items-center gap-1.5">
        <span className="text-2xs font-black text-cyan-700">いま／次</span>
        {chip('いま', cur, 'border-cyan-300 bg-white')}
        {!cur ? <span className="text-2xs text-slate-500">いま：{plan.idleReason}</span> : null}
        {chip('次', nxt, 'border-slate-300 bg-white')}
        {!nxt && plan.hasSchedule ? <span className="text-2xs text-slate-400">次の割り当てなし</span> : null}
        <span className="ml-auto text-2xs text-slate-400">開くと大きな札</span>
      </summary>
      <div className="mt-1 grid gap-2 lg:grid-cols-2">
        {cur ? (
          <CurrentCard item={cur} tone={tone} nowMs={nowMs} selected={selectedLotId === cur.lotId} onSelect={onSelect}
            assumed={assumedIds.has(String(cur.lotId))} verdict={verdictOf(cur.lotId)} />
        ) : (
          <div className="min-w-0 rounded-xl border border-dashed border-slate-300 bg-white px-3 py-2">
            <div className="text-xs font-black text-slate-500">現在</div>
            <div className="mt-1 text-sm font-bold leading-snug text-slate-700">{plan.idleReason}</div>
          </div>
        )}
        <NextCard item={nxt} hasSchedule={plan.hasSchedule} idleReason={cur ? '' : plan.idleReason} nowMs={nowMs}
          selected={!!(nxt && selectedLotId === nxt.lotId)} onSelect={onSelect}
          assumed={!!(nxt && assumedIds.has(String(nxt.lotId)))} verdict={nxt ? verdictOf(nxt.lotId) : null} />
      </div>
    </details>
  );
}

export function WorkerLanes({
  snapshot = null,
  assignments = null,
  lots = [],
  nowMs = null,
  onSelectLot = null,
  selectedLotId = null,
  heightPx = null,
  /** 自前の見出し(青緑の帯)を描くか。⚠既定は true。
      OperationsSimulationPanel から呼ぶ時だけ false にする（CardBox の題・副題と
      **同じ文が上下15pxの所に二度**出ていたため。消える2語は VIEW_TITLE/VIEW_SUB へ移した）。
      TodaySignal は自前の見出し「今日 誰が何を？」を別に持つので既定(true)のまま。 */
  showHeading = true,
  /** テンプレ id → { name }（Map でも可）。決まり12: 全札に 品目コード｜テンプレ。 */
  templatesById = null,
  /** lotId → lotResults の行。札の塗り(納期との関係)と右端の +N日 に使う(決まり9)。 */
  lotVerdictById = null,
  /** 計算で使った暦（makeCalendar の戻り）。日の列と勤務の窓と休憩に使う。 */
  calendar = null,
  /** simulate の idleLog（空きの理由）。 */
  idleLog = null,
  /** buildIdleByDay の戻り（見出しの「空き ◯h」）。 */
  idleByDay = null,
  /** 見ている範囲。 */
  fromMs = null,
  toMs = null,
  /** 名簿の並び。 */
  workerNames = null,
  /** 🚨 エンジンが実際に回した営業日の数（result.normalized.horizonDays）。
   *   最初に開く日数と、畳んだ札の言葉に使う。渡らない時は日数を作らない。 */
  periodDays = null,
}) {
  const verdictOf = (lotId) => (lotVerdictById && lotId ? (lotVerdictById.get(String(lotId)) || null) : null);
  const names = useMemo(() => (Array.isArray(workerNames) && workerNames.length ? workerNames : workerNamesOf(snapshot)), [workerNames, snapshot]);
  const workerColors = useMemo(() => buildWorkerColors(names), [names]);
  const plans = useMemo(
    () => buildWorkerPlans({ snapshot, assignments, lots, nowMs, templatesById }),
    [snapshot, assignments, lots, nowMs, templatesById],
  );
  const plansByName = useMemo(() => new Map(plans.map((p) => [p.name, p])), [plans]);
  // 仮の入荷日で計算されているロット(2026-08-31)。判定は normalizeInput の arrivalKind そのまま。
  const assumedIds = useMemo(() => {
    const s = new Set();
    (Array.isArray(lots) ? lots : []).forEach((l) => {
      if (l && l.lotId && l.arrivalKind === 'assumed') s.add(String(l.lotId));
    });
    return s;
  }, [lots]);
  const selectLot = (lotId) => {
    if (lotId && typeof onSelectLot === 'function') onSelectLot(lotId);
  };

  // 日の列（納期一覧と同じ dueAxis）と、人・日順の材料（domain/personDay.js）。
  const cols = useMemo(() => {
    const win = workWindowOfSpec(calendar && calendar.spec);
    return buildDayColumns({
      fromMs, toMs,
      isWorkday: calendar && typeof calendar.isWorkday === 'function' ? calendar.isWorkday : null,
      startMin: win.startMin, endMin: win.endMin,
    });
  }, [fromMs, toMs, calendar]);
  const mainByLot = useMemo(() => {
    const m = new Map();
    for (const [lotId, list] of assignmentsByLot(assignments)) m.set(lotId, mainWorkerOf(list).worker);
    return m;
  }, [assignments]);
  const personRows = useMemo(() => buildPersonDayRows({
    assignments, lots,
    lotResults: lotVerdictById ? [...lotVerdictById.values()] : [],
    workerNames: names, days: cols, idleLog, calendar, mainByLot, nowMs,
  }), [assignments, lots, lotVerdictById, names, cols, idleLog, calendar, mainByLot, nowMs]);
  // 🧵 「なぜ次のロットへ？」の材料(2026-09-10 23:30)。計算が lotResults[].lotSwitches へ残した物だけ。
  //   ⚠ ここで作らない(同じ文を2か所から出さない)。計算が返していなければ空 = 札は1つも出ない。
  const lotSwitches = useMemo(() => collectLotSwitches(lotVerdictById ? lotVerdictById.values() : null), [lotVerdictById]);
  // 👥 その日その人が居ない理由(idleLog の reason そのまま)。人×日 → 文。
  //   🚨 idleLog は計算の戻り。ここでは「その日の勤務の窓と重なる 休み/応援 の記録」を引くだけ(文を作らない)。
  const awayByKey = useMemo(() => {
    const m = new Map();
    const log = Array.isArray(idleLog) ? idleLog : [];
    for (const r of personRows) {
      for (const e of log) {
        if (!e || !AWAY_REASONS.has(e.reason)) continue;
        const f = Number(e.fromMs); const t = Number(e.toMs);
        if (!isNum(f) || !isNum(t) || f >= r.winEndMs || t <= r.winStartMs) continue;
        const key = `${String(e.worker || '').trim()}|${r.dayMs}`;
        if (!m.has(key)) m.set(key, e.reason);
      }
    }
    return m;
  }, [idleLog, personRows]);
  const awayReasonOf = (name, dayMs) => awayByKey.get(`${String(name || '').trim()}|${dayMs}`) || null;
  // 今日より前の営業日は出さない（基準時刻から先の指示）。
  const todayMs = isNum(nowMs) ? new Date(nowMs).setHours(0, 0, 0, 0) : null;
  const rowsFromToday = useMemo(() => (todayMs == null ? personRows : personRows.filter((r) => r.dayMs >= todayMs)), [personRows, todayMs]);

  if (!names.length) {
    return (
      <div className="flex min-h-40 items-center justify-center rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
        名簿に人が1人も居ません。マスタ設定で作業者を登録すると、ここに1人ずつ作業指示が出ます。
      </div>
    );
  }

  const renderHeaderExtra = (name, dayMs, isToday) => {
    if (!isToday) return null;
    const plan = plansByName.get(name);
    if (!plan) return null;
    return (
      <FoldedCards plan={plan} tone={toneOf(workerColors, name)} nowMs={nowMs} selectedLotId={selectedLotId}
        onSelect={selectLot} assumedIds={assumedIds} verdictOf={verdictOf} />
    );
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-slate-100 p-2.5" style={heightPx ? { minHeight: heightPx } : undefined} data-worker-lanes={names.length}>
      {showHeading ? (
      <div className="mb-2 rounded-lg border border-cyan-200 bg-cyan-50 px-3 py-1.5">
        <div className="text-sm font-black text-slate-900">今日、誰が・何を・どの順で・いつ終わるか。手が空くなら、なぜか</div>
        {/* 🚨 2026-09-15: この2行目(124字)は今日の判断タブで **毎回いちばん上に開いたまま** 出る。
            畳む。🚨 文は1文字も変えていない — 押せばそのまま出る(移す・畳む。消さない)。 */}
        <details className="mt-0.5">
          <summary className="flex cursor-pointer select-none items-center gap-1 text-xs font-bold text-cyan-700">
            <Glyph kind="person" className="w-3.5 h-3.5" title="読み方" />
            読み方（色と棒の意味）
          </summary>
          <div className="mt-0.5 text-xs leading-snug text-slate-600">日ごとに人を固めて、その日の順番で並べています。品目コード｜テンプレ・指図・台数を全行に。空きの行の色＝理由（橙＝記録が無い工程が待っている／灰＝仕事が無い）。「いま／次」の札は今日の見出しに畳んであります。</div>
        </details>
      </div>
      ) : null}
      <PersonDay
        rows={rowsFromToday}
        workerColors={workerColors}
        nowMs={nowMs}
        selectedLotId={selectedLotId}
        onSelectLot={selectLot}
        idleByDay={idleByDay}
        breaks={calendar && calendar.spec ? calendar.spec.breaks : null}
        templatesById={templatesById}
        renderHeaderExtra={renderHeaderExtra}
        awayReasonOf={awayReasonOf}
        /* 🚨 2026-09-04 決まり19A: 最初に開く日数は **期間から** 決める。
           ・5営業日以下 … その期間を丸ごと開く（畳まない）
           ・今月・来月  … まず軽い方と同じ日数（OPSIM_LIGHT_DAYS）を開き、
             残りは「あと ◯営業日を開く」で開く。畳んだ札に期間の日数を必ず添える
             （前は 5 の決め打ちで、期間を変えても開く中身が1日も増えなかった）。 */
        maxDays={Number.isFinite(Number(periodDays)) && Number(periodDays) > OPSIM_LIGHT_DAYS
          ? OPSIM_LIGHT_DAYS : null}
        periodDays={periodDays}
        lotSwitches={lotSwitches}
      />
    </section>
  );
}

export default WorkerLanes;
