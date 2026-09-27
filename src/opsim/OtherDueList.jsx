// =============================================================================
//  src/opsim/OtherDueList.jsx — 相手の工場の納期一覧(読むだけ)。2026-09-15 / 絵に 2026-09-16
// -----------------------------------------------------------------------------
//  清水さん「両方いける人の話になるけど、これはバランスの話だから、やっぱり両方の納期の一覧を
//  同時に見える状態が望ましいかな、それ見ながら調整するべきだしね」
//  清水さん(2026-09-16)「製品検査に最終検査の納期一覧って追加されてるけど、見づらいから、
//  納期一覧 — 誰が・いつ終わり・納期に間に合うか（手が空くなら、なぜか）みたいに表示して最終検査も」
//  → 表をやめ、こちらの納期一覧(DueCalendar)と同じ形: 名前｜遅れ｜日の軸 の3列・棒・納期線・+N日 の札。
//
//  🚨 数は1つも作らない。相手の工場が共有棚(daily_load.dueList)に **自分の納期一覧の行そのまま**
//     (段・遅れ日数・終わる時刻・手が付いている区間 spans)を書いた物を、並べて描くだけ。
//     並べ方は dueListOrder(こちらの納期一覧と同じ)。日の列は dueAxis(こちらの納期一覧と同じ)。
//  🚨 「いつの物か」を必ず出す(相手が最後に開いた時の物。こちらから引き直せない)。
//  🚨 押す物は min-h-11(44px)・文字は .fi-tap-text / text-2xs 以上。px を直書きしない。
//  🚨 製品検査と最終検査で同じファイル。片方だけ変えない。
//  🚨 hooks はガード(return)より上(2026-08-27 の白画面の根因)。
// =============================================================================
import React, { useMemo, useState } from 'react';
import { dueListCounts, dueListText, readDueListDoc } from '../domain/operationsSimulation/sharedWorkerPlan.js';
import { sortDueRows, DUE_SORT } from '../domain/operationsSimulation/dueListOrder.js';
import { DUE_TIER, DUE_TIER_LABEL } from '../domain/operationsSimulation/dueRowFacts.js';
import { buildDayColumns, xOf, segmentsOf, columnAt, workWindowOfSpec } from './dueAxis.js';
import { OFF_HATCH } from './idleTone.js';
import { LATE_TONE } from './lateTone.js';
// 🎨 絵の語彙(2026-09-15)。🚨 数を作らない部品だけを借りる。
import { Bar } from './vizKit.jsx';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const fmtMD = (ms) => { if (!isNum(ms)) return '—'; const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()}`; };
const fmtHM = (ms) => { if (!isNum(ms)) return ''; const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const TIER = DUE_TIER;

/**
 * 📏 遅れの札。日の軸の **外**(左の列のすぐ右)。軸の中に置くと2本目の棒に見える(DueCalendar と同じ理由)。
 *   🚨 数は作らない。r.lateDays / r.pastDays を lateMax で割って長さにするだけ(札の数字はそのまま)。
 */
function LateChip({ r, lateMax }) {
  const days = r.lateDays != null ? r.lateDays : r.pastDays;
  if (days == null) return <span data-row-late="" />;
  const soon = r.lateDays != null && r.tier !== TIER.PAST;
  return (
    <span className="inline-flex min-w-0 items-center gap-1 justify-self-end" data-row-late={days}
      title={soon ? `納期を ${days}日 越えます（一番遅れる行を全幅にした長さです）` : `予定日を ${days}日 過ぎています（一番遅れる行を全幅にした長さです）`}>
      <Bar value={days} max={lateMax} tone={soon ? 'lateSoon' : 'late'} height="h-2" className="w-8" />
      <b className="whitespace-nowrap text-base font-black leading-none text-rose-600 tabular-nums">{`+${days}日`}</b>
    </span>
  );
}

/** 左列: 品目コード｜添え書き（1行目・太く大きく）／ 指図・台数・担当（2行目・小さく灰）。 */
function NameCell({ r }) {
  const main = r.worker;
  return (
    <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-1.5" data-row-name={r.lotId}>
      <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${main ? 'bg-violet-500' : 'border border-rose-400 bg-white'}`} />
      <span className="min-w-0 truncate text-base font-black leading-tight text-slate-800" title={`${r.model || '(品目コードなし)'}${r.sub ? `｜${r.sub}` : ''}`}>
        {r.model || '(品目コードなし)'}
        {r.sub ? <span className="text-2xs font-bold text-slate-500">{`｜${r.sub}`}</span> : null}
      </span>
      <span className="col-start-2 flex min-w-0 items-center gap-1.5 truncate text-2xs leading-tight text-slate-500">
        <span className="tabular-nums">指図 {r.orderNo || '—'}</span>
        {isNum(r.qty) ? <span className="tabular-nums">×{r.qty}</span> : null}
        <span className={`font-black ${main ? 'text-slate-700' : 'text-rose-600'}`} data-row-worker={main || ''}>{main || '未定'}</span>
      </span>
    </div>
  );
}

/**
 * @param {object} p
 * @param {object|null} p.doc      相手の daily_load(中の dueList を読む)
 * @param {string} p.label         相手の工場の名前(「最終検査」)
 * @param {string} [p.sortKey]     並べ方(こちらの納期一覧と同じ鍵を渡す)
 * @param {number} [p.maxRows]     最初に出す行数
 * @param {number} [p.fromMs]      日の軸の始まり(こちらの納期一覧と同じ範囲)
 * @param {number} [p.toMs]        日の軸の終わり
 * @param {object} [p.calendar]    計算で使った暦(isWorkday / spec)。休みの列はこれで決める
 * @param {number} [p.nowMs]       今(今日の列を薄い水色に)。🚨 中で時計を読まない
 */
export function OtherDueList({ doc = null, label = '向こうの工場', sortKey = DUE_SORT.RISK, maxRows = 40, fromMs = null, toMs = null, calendar = null, nowMs = null }) {
  const list = useMemo(() => readDueListDoc(doc), [doc]);
  const rows = useMemo(() => sortDueRows(list ? list.rows : [], sortKey), [list, sortKey]);
  const counts = useMemo(() => dueListCounts(list), [list]);
  const [showAll, setShowAll] = useState(false);
  // 日の列は こちらの納期一覧と同じ関数・同じ範囲・同じ暦(数を作らない)。範囲が無ければ空(軸なし)。
  const cols = useMemo(() => {
    const win = workWindowOfSpec(calendar && calendar.spec);
    return buildDayColumns({
      fromMs, toMs,
      isWorkday: calendar && typeof calendar.isWorkday === 'function' ? calendar.isWorkday : null,
      startMin: win.startMin, endMin: win.endMin,
    });
  }, [fromMs, toMs, calendar]);
  if (!list) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-3 fi-tap-text text-slate-600" data-other-due-list="">
        {label}の納期一覧はまだ届いていません（{label}が操業シミュレーションを開くと、その時の納期一覧がここに出ます）。
      </div>
    );
  }
  const shown = showAll ? rows : rows.slice(0, maxRows);
  const hidden = rows.length - shown.length;
  const hasAxis = cols.length > 0;
  const pctOf = (ms) => xOf(cols, ms);
  const nowPct = pctOf(nowMs);
  const todayCol = columnAt(cols, nowMs);
  /* 📏 遅れの棒の分母(一番遅れる行を全幅に)。🚨 画面に1文字も出さない。rows(全行)で取る(「あと◯件」で長さが変わらない) */
  const lateMax = Math.max(1, ...rows.map((r) => Number(r.lateDays != null ? r.lateDays : r.pastDays) || 0));

  const DayColumns = () => (
    <>
      {cols.map((d) => (
        <div key={d.ms}
          className="absolute top-0 bottom-0 border-l border-dashed border-slate-100"
          data-day-col={d.ms} data-day-off={d.off ? '1' : '0'}
          style={{ left: `${d.left}%`, width: `${d.width}%`, ...(d.off ? OFF_HATCH : null) }} />
      ))}
      {todayCol ? (
        <div className="absolute top-0 bottom-0 bg-cyan-50/60" style={{ left: `${todayCol.left}%`, width: `${todayCol.width}%` }} />
      ) : null}
    </>
  );

  return (
    <div className="rounded-xl border border-violet-300 bg-white p-2" data-other-due-list={rows.length} data-other-due-written={String(list.writtenAt || '')}>
      {/* 見出し: 1文 ＋ いつの物か */}
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-base font-black text-slate-900">{label}の納期一覧 — 誰が・いつ終わり・納期に間に合うか</span>
        <span className="fi-tap-text font-black text-slate-700">{dueListText({ doc: list, label })}</span>
        <span className="fi-tap-text text-slate-500">読むだけ。こちらから押しても{label}の盤は動きません（{label}が次に開いた時に変わります）</span>
      </div>
      {counts ? (
        <div className="mb-1 grid grid-cols-3 gap-2" data-other-due-counts={`${counts.past}/${counts.late}/${counts.unknown}`}>
          {[[DUE_TIER.PAST, counts.past, LATE_TONE.past.chip], [DUE_TIER.LATE, counts.late, LATE_TONE.forecast.chip], [DUE_TIER.UNKNOWN, counts.unknown, 'border-slate-300 bg-slate-50 text-slate-600']].map(([t, n, cls]) => (
            <div key={t} className={`rounded-lg border-2 px-2 py-1 ${cls}`}>
              <div className="text-2xs font-black leading-tight">{DUE_TIER_LABEL[t]}</div>
              <div className="text-lg font-black leading-none tabular-nums">{Number(n).toLocaleString('ja-JP')}<span className="ml-0.5 text-2xs font-bold">件</span></div>
            </div>
          ))}
        </div>
      ) : null}

      {/* 日付の目盛り(こちらの納期一覧と同じ3列) */}
      <div className="grid grid-cols-[15rem_6rem_1fr] items-end gap-2">
        <div className="text-2xs font-black text-slate-500">品目コード｜添え書き ／ 指図・台数・担当</div>
        <div className="text-2xs font-black text-slate-500 text-right" title="納期をどれだけ越えるか(日)。棒の長さは一番遅れる行を全幅にした比">遅れ</div>
        <div className="relative h-4 border-b border-slate-200">
          {hasAxis ? cols.map((d) => (
            <div key={d.ms} className={`absolute bottom-0 truncate text-2xs leading-none ${d.off ? 'text-slate-300' : 'text-slate-500'}`}
              style={{ left: `${d.left}%`, width: `${d.width}%` }}>
              {d.off && d.width < 3 ? d.wd : `${d.label}(${d.wd})`}
            </div>
          )) : (
            <span className="absolute bottom-0 text-2xs leading-none text-slate-400">日の軸は 見ている範囲を受け取ると出ます</span>
          )}
        </div>
      </div>

      {shown.map((r) => {
        const duePct = pctOf(r.dueMs);
        // 🚨 棒は spans(相手が書いた 手が付いている区間)ごとに切る。区間の間は細い線(data-bar-gap)。
        //   finishMs が最後の区間より後ろ(中断の待ち等)なら、その分も細い線。spans が無ければ棒は引かない(作らない)。
        // 🚨 2026-09-19: 棚の形は { s, e }(Firestore は配列の中の配列を受け取らない)。古い [開始,終了] も読めるようにしておく。
        const spanList = (Array.isArray(r.spans) ? r.spans : [])
          .map((x) => (Array.isArray(x) ? x : [x && x.s, x && x.e]))
          .filter((x) => isNum(x[0]) && isNum(x[1]));
        const segs = hasAxis ? spanList.flatMap(([s0, e0]) => segmentsOf(cols, s0, e0)) : [];
        const hasBar = segs.length > 0;
        const gaps = [];
        for (let gi = 1; gi < spanList.length; gi += 1) {
          const a = pctOf(spanList[gi - 1][1]); const b = pctOf(spanList[gi][0]);
          if (a != null && b != null && b > a) gaps.push({ left: a, width: b - a, fromMs: spanList[gi - 1][1], toMs: spanList[gi][0] });
        }
        if (hasBar && isNum(r.finishMs) && spanList.length && r.finishMs > spanList[spanList.length - 1][1]) {
          const a = pctOf(spanList[spanList.length - 1][1]); const b = pctOf(r.finishMs);
          if (a != null && b != null && b > a) gaps.push({ left: a, width: b - a, fromMs: spanList[spanList.length - 1][1], toMs: r.finishMs });
        }
        const right = hasBar ? (segs[segs.length - 1].left + segs[segs.length - 1].width) : 0;
        const baseCls = r.tier === TIER.UNKNOWN ? 'bg-slate-300' : 'bg-cyan-400';
        const labelLeft = Math.min(right, 92);
        // 🚨 線を越えた分だけ赤。納期線が棒の中に在れば、線で切って右側だけ赤にする。
        const cut = (duePct != null && r.tier <= TIER.LATE) ? duePct : null;
        // 棒が引けない時の文(相手が書いた why をそのまま。無ければ「この範囲では手が付きません」)
        const whyText = r.why || ((hasAxis && spanList.length) ? 'この範囲の外で手が付きます' : (isNum(r.finishMs) ? `${fmtMD(r.finishMs)} ${fmtHM(r.finishMs)} に終わる見込み（区間は届いていません）` : 'この範囲では手が付きません'));
        return (
          <div key={r.lotId} data-other-due-row={r.lotId} data-other-due-tier={r.tier}
            className="grid w-full grid-cols-[15rem_6rem_1fr] items-center gap-2 border-b border-slate-50 py-1">
            <NameCell r={r} />
            <LateChip r={r} lateMax={lateMax} />
            <div className="relative h-8">
              <DayColumns />
              {nowPct != null ? (
                <div className="absolute top-0 bottom-0 z-10 w-px bg-slate-400" style={{ left: `${nowPct}%` }} />
              ) : null}
              {gaps.map((g) => (
                <div key={`gap-${g.fromMs}`} data-bar-gap="1"
                  className="absolute top-4 h-px bg-slate-300"
                  style={{ left: `${g.left}%`, width: `${g.width}%` }}
                  title={`${fmtMD(g.fromMs)} ${fmtHM(g.fromMs)}〜${fmtMD(g.toMs)} ${fmtHM(g.toMs)} は、このロットに手が付いていません（他の仕事を挟んでいます）`} />
              ))}
              {hasBar ? segs.map((s, i) => {
                const l = s.left; const rr = s.left + s.width;
                const overFrom = cut == null ? rr : Math.max(l, Math.min(rr, cut));
                const baseW = Math.max(0, overFrom - l);
                const overW = Math.max(0, rr - overFrom);
                const first = i === 0; const last = i === segs.length - 1;
                return (
                  <React.Fragment key={`${s.dayMs}-${s.startMs}`}>
                    {baseW > 0 ? (
                      <div className={`absolute top-2.5 h-3 ${first ? 'rounded-l-full' : ''} ${last && overW <= 0 ? 'rounded-r-full' : ''} ${baseCls}`}
                        data-bar-day={s.dayMs}
                        style={{ left: `${l}%`, width: `${Math.max(0.4, baseW)}%` }} />
                    ) : null}
                    {overW > 0 ? (
                      <div className={`absolute top-2.5 h-3 ${last ? 'rounded-r-full' : ''} ${first && baseW <= 0 ? 'rounded-l-full' : ''} ${r.tier === TIER.PAST ? LATE_TONE.past.bar : LATE_TONE.forecast.bar}`}
                        data-bar-day={s.dayMs} data-bar-over="1"
                        style={{ left: `${overFrom}%`, width: `${Math.max(0.4, overW)}%` }}
                        title={r.lateDays != null ? `納期を ${r.lateDays}日 越えます` : '納期を越えます'} />
                    ) : null}
                  </React.Fragment>
                );
              }) : (
                <span className={`absolute left-0 top-2 text-2xs leading-tight ${r.tier <= TIER.LATE ? 'text-rose-600' : 'text-slate-400'}`} data-row-why="">{whyText}</span>
              )}
              {/* 終わる時刻(小さく)。相手が書いた finishMs そのまま */}
              {hasBar ? (
                <span className="absolute top-0.5 z-20 ml-1 whitespace-nowrap text-2xs leading-tight text-slate-500 tabular-nums" style={{ left: `${labelLeft}%` }}>
                  {isNum(r.finishMs) ? `${fmtMD(r.finishMs)} ${fmtHM(r.finishMs)} 終` : ''}
                </span>
              ) : null}
              {duePct != null && duePct >= 0 && duePct <= 100 ? (
                <div className={`absolute top-0 bottom-0 z-20 w-0.5 ${r.tier <= TIER.LATE ? 'bg-rose-600' : 'bg-slate-400'}`}
                  data-due-line={r.dueMs}
                  style={{ left: `${duePct}%` }} />
              ) : null}
            </div>
          </div>
        );
      })}

      {hidden > 0 ? (
        <button type="button" onClick={() => setShowAll(true)} data-other-due-more={hidden}
          className="fi-tap-text mt-1 w-full min-h-11 rounded-lg border border-dashed border-violet-300 bg-white font-black text-violet-700 hover:bg-violet-50">
          あと {hidden.toLocaleString('ja-JP')}件を開く
        </button>
      ) : null}
      {list.truncated ? <div className="mt-1 fi-tap-text text-amber-800">⚠ {label}の書類は上限（{list.rows.length}行）で切れています。全体は {Number(list.total).toLocaleString('ja-JP')}件</div> : null}
      {list.spansTruncated ? <div className="mt-1 fi-tap-text text-amber-800">⚠ 書類の大きさの上限で、一部の行は棒の区間が届いていません（終わる時刻と遅れは届いています）</div> : null}

      {/* 凡例は末尾に小さく */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-slate-500">
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-5 rounded-full bg-cyan-400" />納期の手前</span>
        <span className="inline-flex items-center gap-1"><span className={`inline-block h-2 w-5 rounded-full ${LATE_TONE.past.bar}`} />すでに過ぎた分</span>
        <span className="inline-flex items-center gap-1"><span className={`inline-block h-2 w-5 rounded-full ${LATE_TONE.forecast.bar}`} />この先で遅れる分（縞）</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-5 rounded-full bg-slate-300" />判定できません</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-3.5 w-0.5 bg-rose-600" />納期</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-px w-5 bg-slate-300" />他の仕事を挟んで触らない間</span>
        <span className="ml-auto">網掛け＝休み。棒は営業日だけ。遅れの棒の長さ＝一番遅れる行を全幅にした比</span>
      </div>
    </div>
  );
}

export default OtherDueList;
