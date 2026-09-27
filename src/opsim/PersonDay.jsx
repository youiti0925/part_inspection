// =============================================================================
//  src/opsim/PersonDay.jsx — 人・日順（その日、その人が、どの順で、いつ終わり、納期に対してどうか）
// -----------------------------------------------------------------------------
//  🚨 決まり14-5（2026-09-03 清水さん）「同じ日に作業する作業者を固めて表示するやつ」。
//  🚨 決まり13: 「人ごとの指示」の2枚の大きな札は **各人の見出しに畳む**（消さない）。
//
//  形(案A・2026-09-16): 日の黒帯(1日＝1つの段) → その中を **人ごとの札** に。広い画面は3列、狭い画面は1列。
//      札の頭 = 丸(頭文字)＋名前(大きく)＋「08:30〜14:10・4ロット・空き ◯分」
//      その日の帯を1本(太く丸く。休憩は網掛け。色＝納期との関係。隙間の色＝空きの理由)
//      順番の行 = 番号の丸／品目コード｜テンプレ／「08:30 → 10:54・指図・×台数」／右に「納期 9/16 +1日」と「9/17 10:54 終」
//      空き(隙間)も順番の中に1行で出す（色＝理由。仕事が無いのか、記録が無い工程が待っているのか）。
//      「なぜ次のロットへ？」は行の下の1行(押すと計算の why がそのまま出る)。
//      応援・休みの人は 札の中に理由の1文(計算の idleLog の reason そのまま)と「割付はありません」。
//  🚨 材料は buildPersonDayRows（domain/operationsSimulation/personDay.js）の戻りだけ。ここで数え直さない。
//  ⚠ 寸法は rem の段だけ(Tailwind)。文字の床は text-2xs / .fi-tap-text。押す物は min-h-11。
// =============================================================================
import React, { useState } from 'react';
import { LATE_TONE } from './lateTone.js';
import { toneOf } from './workerColors.js';
import { tplNameOf } from '../domain/workerPlan.js';
import { IDLE_KIND_LABEL, fmtHours } from '../domain/operationsSimulation/idleReason.js';
import { toneOfKind, OFF_HATCH } from './idleTone.js';
// 🧵 「なぜ次のロットへ？」(2026-09-10 23:30 清水さん「ロット処理して次のロットでいいでしょ」)。
//   🚨 文は計算(lotResults[].lotSwitches[].why)そのまま。当てはめ方は lotSwitchWhy.js の純関数。
import { switchesOfRow, LOT_SWITCH_WHY_HEAD } from './lotSwitchWhy.js';
// 🎨 絵の語彙(2026-09-15 清水さん「文字ばっかりじゃなくてグラフとかイラストとかで」)。
//   🚨 ここで数を作らない。この画面がもう持っている値を 長さ・丸に変えるだけ。
import { Avatar, Glyph } from './vizKit.jsx';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const MS_MIN = 60000;
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const fmtHM = (ms) => {
  if (!isNum(ms)) return '—';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const fmtMD = (ms) => {
  if (!isNum(ms)) return '—';
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};
const dayTitle = (ms) => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}（${WD[d.getDay()]}）`;
};
const dayStartOf = (ms) => (isNum(ms) ? new Date(ms).setHours(0, 0, 0, 0) : null);
const parseHHMM = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** 段の色。納期との関係だけ（人の色は丸に残す）。 */
// 🚨 決まり27(2026-09-05): 遅れの色は lateTone.js ただ1つ。橙は空き(スキル待ち)専用なのでここで使わない。
const TIER_BAR = [LATE_TONE.past.bar, LATE_TONE.forecast.bar, 'bg-slate-300', 'bg-cyan-400'];
const TIER_TEXT = [LATE_TONE.past.text, LATE_TONE.forecast.text, 'text-slate-500', 'text-cyan-700'];

/** 応援・休みの札の色(紫)。空きの理由の色(idleTone)とも遅れの赤とも別。 */
const AWAY_TONE = Object.freeze({
  text: 'text-violet-700',
  band: 'bg-violet-100',
  hatch: { backgroundImage: 'repeating-linear-gradient(135deg, rgba(196,181,253,0.9) 0, rgba(196,181,253,0.9) 0.25rem, transparent 0.25rem, transparent 0.625rem)' },
});

/** その日の時間軸（勤務の窓を 0〜100% に）。休憩は網掛け。 */
function Axis({ winStartMs, winEndMs, breaks, children, className = '', ...rest }) {
  const span = winEndMs - winStartMs;
  const dayMs = new Date(winStartMs).setHours(0, 0, 0, 0);
  return (
    <div className={`relative ${className}`} {...rest}>
      {(Array.isArray(breaks) ? breaks : []).map((b, i) => {
        const a = parseHHMM(b && b.start); const z = parseHHMM(b && b.end);
        if (a == null || z == null || z <= a || span <= 0) return null;
        const l = ((dayMs + a * MS_MIN - winStartMs) / span) * 100;
        const w = ((z - a) * MS_MIN / span) * 100;
        if (l >= 100 || l + w <= 0) return null;
        return <div key={i} className="absolute top-0 bottom-0" style={{ left: `${Math.max(0, l)}%`, width: `${w}%`, ...OFF_HATCH }} />;
      })}
      {children}
    </div>
  );
}

/** 行の右端: 納期との関係(色＝段)。数は buildPersonDayRows の pastDays / lateDays そのまま。 */
/* 🧑‍🏭 2026-09-18 夕: 「人ごとの指示」の行の列(広い画面)。[番号 1.75rem][品目コード・指図 22rem][その日の時間軸の棒 残り全部][納期と終わり 10rem]。
 *   🚨 幅を固定するのは、どの行の棒も同じ時間軸に揃える為(auto にすると 納期の字の長さで棒の位置が行ごとにずれる)。
 *   その日の帯(見出しの1本)も同じ位置に寄せる: 左 = 0.75(px-3)+1.75+0.5+22+0.5 = 25.5rem / 右 = 0.5+10+0.75 = 11.25rem。 */
const PD_ROW_COLS = 'lg:grid-cols-[1.75rem_22rem_1fr_10rem]';
const PD_BAR_CELL = 'col-span-2 col-start-2 row-start-2 lg:col-span-1 lg:col-start-3 lg:row-start-1';
const PD_GAP_BAR_CELL = 'col-start-2 row-start-2 lg:col-start-3 lg:row-start-1';
const PD_BAND_INSET = 'lg:pl-[25.5rem] lg:pr-[11.25rem]';

function DueCell({ it }) {
  const days = it.pastDays != null ? it.pastDays : it.lateDays;
  const late = it.tier <= 1;
  const unknown = it.tier === 2;
  return (
    <span className={`flex shrink-0 flex-col items-end leading-tight ${TIER_TEXT[it.tier]}`} data-row-due-tier={it.tier}>
      <span className="text-2xs font-black tabular-nums">
        納期 {fmtMD(it.dueMs)}
        {late && days != null ? <span className="ml-1 text-sm font-black">+{days}日</span> : null}
        {late && days == null ? <span className="ml-1">遅れます</span> : null}
        {!late && !unknown ? <span className="ml-1">間に合う</span> : null}
        {unknown ? <span className="ml-1">判定なし</span> : null}
      </span>
      <span className="text-2xs tabular-nums text-slate-400">
        {isNum(it.finishMs) ? `${fmtMD(it.finishMs)} ${fmtHM(it.finishMs)} 終` : '終わりが出せません'}
      </span>
    </span>
  );
}

/**
 * @param {object} p
 * @param {Array} p.rows           buildPersonDayRows の戻り
 * @param {object} p.workerColors
 * @param {number} p.nowMs
 * @param {object} [p.idleByDay]   buildIdleByDay の戻り（見出しの「空き ◯h」と理由）
 * @param {Array}  [p.breaks]      calendar.spec.breaks
 * @param {Map}    [p.templatesById]
 * @param {function} [p.renderHeaderExtra] (name, dayMs, isToday) → 見出しに畳む物（いま／次の札）
 * @param {function} [p.awayReasonOf] (name, dayMs) → その日その人が居ない理由の文(idleLog の reason そのまま)。無ければ null。
 *   🚨 文はここで作らない。WorkerLanes が idleLog(計算の戻り)から引いて渡す。
 * @param {number} [p.maxDays]     最初に開く営業日の数。
 *   🚨 2026-09-04 決まり19A: **5 の決め打ちをやめた**。
 *     期間を「今月」に変えても、ここが 5 のままだと人ごとの指示は
 *     「折り畳みが増えるだけ」で、開いて見える中身は1日も増えなかった（前の担当の実測）。
 *     渡さない時は **全部開く**（日数を作らない）。呼ぶ側が期間から決めて渡す。
 * @param {number} [p.periodDays]  エンジンが実際に回した営業日の数。畳んだ札に添える言葉だけに使う。
 * @param {Array}  [p.lotSwitches] collectLotSwitches の戻り(人がロットを離れた理由)。
 *   🚨 渡ってこなければ(0件なら)「なぜ次のロットへ？」の札は1文字も出さない。文は計算の why そのまま。
 */
export function PersonDay({
  rows = [], workerColors = null, nowMs = null, selectedLotId = null, onSelectLot = null,
  idleByDay = null, breaks = null, templatesById = null, renderHeaderExtra = null,
  awayReasonOf = null,
  maxDays = null, periodDays = null, lotSwitches = null,
}) {
  const [showAll, setShowAll] = useState(false);
  const list = Array.isArray(rows) ? rows : [];
  // 🚨 maxDays が来ない／数でない時は「全部開く」。0 や 5 を勝手に作らない。
  const openCount = (Number.isFinite(Number(maxDays)) && Number(maxDays) > 0)
    ? Math.trunc(Number(maxDays)) : list.length;
  const days = showAll ? list : list.slice(0, openCount);
  const hiddenDays = list.length - days.length;
  const todayMs = dayStartOf(nowMs);
  const select = (lotId) => { if (lotId && typeof onSelectLot === 'function') onSelectLot(lotId); };
  const awayOf = (name, dayMs) => (typeof awayReasonOf === 'function' ? (awayReasonOf(name, dayMs) || null) : null);

  if (!list.length) {
    return (
      <div className="flex min-h-40 items-center justify-center rounded-xl border border-slate-200 bg-white p-6 text-2xs text-slate-500">
        この範囲に営業日が1日もありません。上の「見ている範囲」を広げてみてください。
      </div>
    );
  }

  return (
    <div className="space-y-3" data-person-day-days={days.length}>
      {days.map((day) => {
        const isToday = todayMs != null && day.dayMs === todayMs;
        const span = day.winEndMs - day.winStartMs;
        const pct = (ms) => (span > 0 ? Math.min(100, Math.max(0, ((ms - day.winStartMs) / span) * 100)) : 0);
        // 🚨 数えているのは「この段に並ぶ行」の数だけ(計算の値を集計し直していない)。
        const lotIds = new Set(day.workers.flatMap((w) => w.items.map((it) => it.lotId)));
        const lateIds = new Set(day.workers.flatMap((w) => w.items.filter((it) => it.tier <= 1).map((it) => it.lotId)));
        return (
          <section key={day.dayMs} className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-50" data-person-day={day.dayMs}>
            {/* 日の黒帯: 結論は1文＋数字の札 */}
            <div className={`flex flex-wrap items-end gap-x-4 gap-y-1 px-3 py-2 text-white ${isToday ? 'bg-slate-900' : 'bg-slate-700'}`}>
              <span className="text-lg font-black leading-tight tabular-nums">{dayTitle(day.dayMs)}<span className="ml-2 text-base font-black">誰が・何を・どの順で</span></span>
              {isToday ? <span className="rounded bg-cyan-500 px-1.5 py-0.5 text-2xs font-black">今日</span> : null}
              <span className="flex items-baseline gap-3 text-2xs text-slate-300">
                <span><b className="text-base font-black text-white tabular-nums" data-person-day-lots={lotIds.size}>{lotIds.size}</b> ロット</span>
                {lateIds.size ? <span><b className="text-base font-black text-rose-300 tabular-nums" data-person-day-late={lateIds.size}>{lateIds.size}</b> 納期を過ぎて終わる</span> : null}
                <span className="font-black text-white tabular-nums">{fmtHM(day.winStartMs)}〜{fmtHM(day.winEndMs)}</span>
              </span>
            </div>

            {/* 🧑‍🏭 2026-09-18 夕: 3列の札は 1行が狭く、行ごとの棒を置けなかった(清水さん「見づらい。前の、指図ごとに開始と終了の棒が順に並ぶ形が見やすい」)。
                1人＝横いっぱいの段に戻す。行の列幅は固定(PD_ROW_COLS)＝どの行の棒も同じ時間軸に揃う。 */}
            <div className="flex flex-col gap-3 p-3" data-person-day-layout="rows">
              {day.workers.map((w) => {
                const tone = toneOf(workerColors, w.name);
                const cell = idleByDay && idleByDay.byWorker && idleByDay.byWorker[w.name] ? idleByDay.byWorker[w.name][day.dayMs] : null;
                const topKind = cell && cell.top ? cell.top.kind : (w.gaps.length ? w.gaps.slice().sort((a, b) => b.minutes - a.minutes)[0].kind : null);
                // 🚨 2026-09-04: 見出しの「空き」は idleByDay（＝forecast の1本）だけから引く。
                //   直す前は cell が無い／記録が無い時に w.freeMin（gaps の足し算＝別の計算）へ落ちていて、
                //   同じ人・同じ日で 見出し 0分／下の行 空き7h と反対の事を言っていた（決まり6違反）。
                //   数えていない時は 0 と言わずに「—」を出す（0 と 分かりません を混ぜない）。
                const measured = !!cell;
                const freeMin = cell && cell.freeMin != null ? cell.freeMin : null;
                const ktone = topKind ? toneOfKind(topKind) : null;
                const away = w.items.length ? null : awayOf(w.name, day.dayMs);
                // 順番: 仕事と空きを時刻順に並べる（空きも順番の中）
                const seq = [
                  ...w.items.map((it) => ({ kind: 'item', at: it.startMs, it })),
                  ...w.gaps.map((g) => ({ kind: 'gap', at: g.startMs, g })),
                ].sort((a, b) => a.at - b.at);
                const freeText = freeMin != null && freeMin >= 5
                  ? `空き ${fmtHours(freeMin)}`
                  : !measured ? '空き —（数えていません）'
                    : cell && cell.workMin > 0 ? (freeMin == null ? '空き 0分（記録なし）' : '空き 0分')
                      : 'この日は勤務なし';
                return (
                  <article key={w.name} className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white" data-worker-plan={w.name} data-person-day-worker={w.name}>
                    {/* 札の頭: 丸＋名前＋1行の副情報 */}
                    <div className="flex items-center gap-3 border-b border-slate-200 px-3 py-2">
                      {/* 🚨 色は呼ぶ側(workerColors.js の toneOf)が決めた tone を **渡すだけ**。ここで名前から色を作らない。
                          🚨 実データの作業者は4人。色だけで見分けさせないので名前の文字は隣にそのまま残す。 */}
                      <Avatar name={w.name} tone={tone} size="w-10 h-10" showName={false} />
                      <div className="flex min-w-0 flex-col leading-tight">
                        <span className="truncate text-lg font-black text-slate-900">{w.name}</span>
                        {away ? (
                          <span className={`truncate text-2xs font-bold ${AWAY_TONE.text}`} data-person-day-away="1">{away}</span>
                        ) : (
                          <span className={`truncate text-2xs font-bold tabular-nums ${freeMin != null && freeMin >= 5 && ktone ? ktone.text : 'text-slate-500'}`} data-person-day-free={topKind || ''}>
                            {w.items.length ? `${fmtHM(w.firstMs)}〜${fmtHM(w.lastMs)}・${w.items.length}ロット` : 'この日の割付なし'}
                            ・{freeText}
                            {topKind && freeMin != null && freeMin >= 5 ? `（${IDLE_KIND_LABEL[topKind]}）` : ''}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* その日の帯を1本: 棒＝仕事(色＝納期との関係)、隙間＝空き(色＝理由)、休憩＝網掛け */}
                    <div className={`px-3 pb-1 pt-2 ${PD_BAND_INSET}`}>
                      {away ? (
                        <div className={`h-3.5 overflow-hidden rounded-full ${AWAY_TONE.band}`} style={AWAY_TONE.hatch} data-person-day-band="away" />
                      ) : (
                        <Axis winStartMs={day.winStartMs} winEndMs={day.winEndMs} breaks={breaks} className="h-3.5 overflow-hidden rounded-full bg-slate-100" data-person-day-band="work">
                          {w.gaps.map((g, i) => (
                            <div key={`g${i}`} className={`absolute top-0 bottom-0 opacity-60 ${toneOfKind(g.kind || 'unexplained').bar}`}
                              style={{ left: `${pct(g.startMs)}%`, width: `${Math.max(0.3, pct(g.endMs) - pct(g.startMs))}%` }} />
                          ))}
                          {w.items.flatMap((it) => it.segs.map(([s, e], i) => (
                            <div key={`${it.lotId}-${i}`} className={`opsim-move absolute top-0 bottom-0 ${TIER_BAR[it.tier]}`}
                              style={{ left: `${pct(s)}%`, width: `${Math.max(0.3, pct(e) - pct(s))}%` }} />
                          )))}
                        </Axis>
                      )}
                      <div className="mt-0.5 flex justify-between text-2xs font-bold tabular-nums text-slate-400">
                        <span>{fmtHM(day.winStartMs)}</span>
                        <span>{fmtHM(day.winEndMs)}</span>
                      </div>
                    </div>

                    {typeof renderHeaderExtra === 'function' ? <div className="px-3 pb-1">{renderHeaderExtra(w.name, day.dayMs, isToday)}</div> : null}

                    {away ? (
                      <div className="flex flex-col gap-1 px-3 py-3 text-sm leading-snug text-slate-600" data-person-day-away-body="1">
                        <span className={`font-black ${AWAY_TONE.text}`}>{away}</span>
                        <span>この日の割付はありません。</span>
                      </div>
                    ) : null}

                    {seq.length ? (
                      <ol className="flex flex-col">
                        {seq.map((e, i) => {
                          if (e.kind === 'gap') {
                            const g = e.g;
                            const gt = toneOfKind(g.kind || 'unexplained');
                            return (
                              <li key={`gap-${i}`} className={`grid min-h-11 grid-cols-[1.75rem_1fr] items-center gap-x-2 gap-y-1 border-t border-slate-100 px-3 py-1.5 ${PD_ROW_COLS} ${gt.bg}`} data-person-gap={g.kind || ''}>
                                <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full border-2 border-dashed ${gt.text} border-current`} aria-hidden="true" />
                                <span className="grid min-w-0 leading-tight">
                                  {/* 🚨 2026-09-04: ここは「この時間帯の長さ」。その日の空きの合計は上の見出し（idleByDay の1本）。
                                      合計と読めると、見出しと足し算が食い違って見える（決まり6）。 */}
                                  <span className={`truncate text-sm font-black ${gt.text}`}>手が空く（この時間帯 {fmtHours(g.minutes)}）</span>
                                  <span className={`truncate text-2xs font-bold tabular-nums ${gt.text}`}>{fmtHM(g.startMs)}〜{fmtHM(g.endMs)}・{g.logged ? IDLE_KIND_LABEL[g.kind] : '理由の記録なし'}</span>
                                </span>
                                <Axis winStartMs={day.winStartMs} winEndMs={day.winEndMs} breaks={breaks} data-person-gap-bar={g.kind || ''}
                                  className={`h-3 overflow-hidden rounded-full bg-white/70 ${PD_GAP_BAR_CELL}`}>
                                  <div className={`absolute top-0 bottom-0 rounded-full ${gt.bar}`} style={{ left: `${pct(g.startMs)}%`, width: `${Math.max(0.3, pct(g.endMs) - pct(g.startMs))}%` }} />
                                </Axis>
                              </li>
                            );
                          }
                          const it = e.it;
                          const on = it.lotId === selectedLotId;
                          const tpl = tplNameOf(templatesById, it.templateId);
                          const continues = isNum(it.finishMs) && it.finishMs > it.endMs && dayStartOf(it.finishMs) !== day.dayMs;
                          // 🧵 この行(ロット×人×日)で人がロットを離れた理由。計算が残した物だけ(無ければ空)。
                          const left = switchesOfRow(lotSwitches, { worker: w.name, lotId: it.lotId, startMs: it.startMs, endMs: it.endMs });
                          return (
                            <li key={`${it.lotId}-${i}`} className="border-t border-slate-100">
                              <button type="button" data-lot-id={it.lotId} data-row-tier={it.tier} onClick={() => select(it.lotId)}
                                className={`grid min-h-11 w-full grid-cols-[1.75rem_1fr_auto] items-center gap-x-2 gap-y-1 px-3 py-1.5 text-left hover:bg-slate-50 ${PD_ROW_COLS} ${on ? 'bg-cyan-50' : ''}`}>
                                <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-slate-900 text-sm font-black text-white tabular-nums">{it.order}</span>
                                <span className="grid min-w-0 leading-tight">
                                  <span className="truncate text-base font-black text-slate-900" title={`${it.model}｜${tpl || 'テンプレ名なし'}`}>
                                    {it.assumed ? '［仮］' : ''}{it.model}<span className="font-bold text-slate-500">｜{tpl || 'テンプレ名なし'}</span>
                                  </span>
                                  <span className="truncate text-2xs text-slate-500 tabular-nums" data-row-order={it.orderNo || ''}>
                                    {fmtHM(it.startMs)} → {fmtHM(it.endMs)}・指図 {it.orderNo || '—'}{isNum(it.quantity) ? ` ×${it.quantity}` : ''}
                                    {it.stepTitles.length ? `・${it.stepTitles.slice(0, 2).join('・')}${it.stepTitles.length > 2 ? '…' : ''}` : ''}
                                    {continues ? `・続きは ${fmtMD(it.finishMs)}` : ''}
                                    {it.assumed ? <span className="ml-1 font-bold text-amber-700">入荷日は仮</span> : null}
                                    {!it.isMain && it.mainWorker ? <span className="ml-1 text-amber-700">（主担当 {it.mainWorker}）</span> : null}
                                    {it.asPartner ? <span className="ml-1 text-violet-700">OJT</span> : null}
                                  </span>
                                </span>
                                <DueCell it={it} />
                                {/* 指図ごとの棒(開始〜終了)。位置は その日の勤務の窓の中の割合。狭い画面では行の下、広い画面では3列目。 */}
                                <Axis winStartMs={day.winStartMs} winEndMs={day.winEndMs} breaks={breaks} data-person-row-bar={it.lotId}
                                  className={`h-3 overflow-hidden rounded-full bg-slate-100 ${PD_BAR_CELL}`}>
                                  {it.segs.map(([s, ee], j) => (
                                    <div key={j} className={`opsim-move absolute top-0 bottom-0 rounded-full ${TIER_BAR[it.tier]}`}
                                      style={{ left: `${pct(s)}%`, width: `${Math.max(0.4, pct(ee) - pct(s))}%` }} />
                                  ))}
                                </Axis>
                              </button>
                              {/* 🧵 なぜ次のロットへ？(2026-09-10 23:30)。🚨 文は計算(lotSwitches[].why)そのまま。画面で作り直さない。
                                  渡ってこなければ(left が空なら)この行ごと出ない。
                                  案A(2026-09-16): 行の下の1行のリンク風の札。押すと、いままでの札(時刻＋計算の why そのまま)が出る。
                                  🚨 1文字も消していない。 */}
                              {left.length ? (
                                <details className="px-3 pb-1" data-row-lot-switch-why={it.lotId} data-row-lot-switch-count={left.length}>
                                  <summary className="fi-tap-text flex min-h-11 cursor-pointer select-none items-center gap-1 text-xs font-black text-amber-800 underline decoration-amber-300 underline-offset-2">
                                    <Glyph kind="step" className="w-3.5 h-3.5 shrink-0" title={LOT_SWITCH_WHY_HEAD} />
                                    <span>{LOT_SWITCH_WHY_HEAD}</span>
                                    <span className="font-bold text-amber-600 tabular-nums">（{left.length}回）</span>
                                  </summary>
                                  <div className="mt-1 flex flex-col gap-1">
                                    {left.map((s, k) => (
                                      <div key={`${s.atMs}-${k}`} className="fi-tap-text flex flex-wrap items-baseline gap-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs leading-snug text-amber-900">
                                        <span className="shrink-0 font-black">{LOT_SWITCH_WHY_HEAD}</span>
                                        <span className="tabular-nums text-amber-700">{fmtHM(s.atMs)}</span>
                                        <span className="min-w-0 font-bold" data-row-lot-switch-text="1">{s.why}</span>
                                      </div>
                                    ))}
                                  </div>
                                </details>
                              ) : null}
                            </li>
                          );
                        })}
                      </ol>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}

      {hiddenDays > 0 ? (
        <button type="button" onClick={() => setShowAll(true)}
          className="min-h-11 w-full rounded-lg border border-dashed border-slate-300 bg-white py-1.5 text-2xs font-black text-cyan-700 hover:bg-slate-50">
          あと {hiddenDays} 営業日を開く
          {Number.isFinite(Number(periodDays)) && Number(periodDays) > 0
            ? `（この期間は ${Math.trunc(Number(periodDays))} 営業日。いま ${days.length} 日ぶんを開いています）`
            : null}
        </button>
      ) : null}

      {/* 凡例は末尾に小さく(案A)。文は前と同じ(移しただけ)。 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-2xs text-slate-500">
        <span className="font-black text-slate-700">日 → 人 → その日の順番。棒＝その日の時間（休憩は網掛け）。色＝納期との関係。空きの行の色＝理由</span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-5 rounded-full bg-cyan-400" />間に合う</span>
          <span className="inline-flex items-center gap-1"><span className={`inline-block h-2 w-5 rounded-full ${LATE_TONE.forecast.bar}`} />この先で遅れる</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-5 rounded-full bg-rose-500" />納期を過ぎている</span>
          <span className="inline-flex items-center gap-1"><span className={`inline-block h-2 w-5 rounded-full ${toneOfKind('skill').bar}`} />空き：{IDLE_KIND_LABEL.skill}</span>
          <span className="inline-flex items-center gap-1"><span className={`inline-block h-2 w-5 rounded-full ${toneOfKind('nojob').bar}`} />空き：{IDLE_KIND_LABEL.nojob}</span>
          <span className="inline-flex items-center gap-1"><span className={`inline-block h-2 w-5 rounded-full ${AWAY_TONE.band}`} style={AWAY_TONE.hatch} />応援・休み</span>
        </span>
      </div>
    </div>
  );
}

export default PersonDay;
