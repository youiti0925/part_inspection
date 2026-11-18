// 🏭 SAP 工程の一覧(納期の一覧+日付の軸)
// 目的: 製品検査アプリの操業シミュレーション「納期の一覧」(src/opsim/DueCalendar.jsx)と同じ作りで、
//       ①品目(指図)ごと ②工程(作業区グループ)ごと ③工程の一覧 ④部品検査に届く見込み を 1行=1件・日付の軸の上の棒で出す。
//       数は作らない(src/domain/sapBoard.js・sapInspect.js の答えを置くだけ)。軸・並べ方・色・丸い印は 製品側と同じ部品を使う。
// 入力: baseOrders(buildOrders)・orders(scheduleOrders の結果)・queue・origins・基準時刻・設定(標準値の選び方・台数)
// 出力: 画面(Firebase・ネットワーク・保存に触れない)
// 呼ぶ人: SapProgressPanel.jsx
// 確かめ方: sap-demo.html で実データを選ぶ
import React, { useMemo, useState } from 'react';
import { buildDayColumns, xOf, segmentsOf, columnAt } from './opsim/dueAxis.js';
import { LATE_TONE } from './opsim/lateTone.js';
import { OFF_HATCH } from './opsim/idleTone.js';
import { Bar, Avatar } from './opsim/vizKit.jsx';
import { WORKER_TONES, NEUTRAL_TONE } from './opsim/workerColors.js';
import { sortDueRows, DUE_SORT, DUE_SORT_LABEL, dueSortHint } from './domain/operationsSimulation/dueListOrder.js';
import { DUE_TIER } from './domain/operationsSimulation/dueRowFacts.js';
import { factoryClock, DEFAULT_WORK_SCHEDULE, timeStrToMinutes } from './domain/workClock.js';
import { orderRows, stageRows, laneSummary, boardStats, LANE_ORDER, HOURS_PER_DAY } from './domain/sapBoard.js';
import { capacityTable, rowInWeek } from './domain/sapCapacity.js';
import { inspectForecast, HOURS_BASIS_LABEL, NEAR_REMAINING_DEFAULT } from './domain/sapInspect.js';

const TIER = DUE_TIER;
const SHORT_BASIS = { sap: 'SAP 予定どおり', sim: 'シミュ更新', actual: '検査開始済', unknown: '不明' };
const DAY = 86400000;
const SORTS = [DUE_SORT.LATE, DUE_SORT.FINISH, DUE_SORT.DUE, DUE_SORT.ORDER, DUE_SORT.MODEL];
const GRID = 'grid grid-cols-[19rem_6rem_1fr] items-center gap-2';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const p2 = (n) => String(n).padStart(2, '0');
const fmtMD = (ms) => (isNum(ms) ? `${new Date(ms).getMonth() + 1}/${new Date(ms).getDate()}` : '—');
const fmtHM = (ms) => (isNum(ms) ? `${p2(new Date(ms).getHours())}:${p2(new Date(ms).getMinutes())}` : '');
const fmtMDHM = (ms) => (isNum(ms) ? `${fmtMD(ms)} ${fmtHM(ms)}` : '—');
const isoOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
const isoMd = (iso) => (iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : '—');

/** 工程ごとの色(丸い印)。工程の順で色を配る。色だけでなく頭文字も出す */
const toneOfLane = (name) => { const i = LANE_ORDER.indexOf(name); return i < 0 ? NEUTRAL_TONE : WORKER_TONES[i % WORKER_TONES.length]; };

/** 遅れの札: 赤い短い棒+「+N日」(軸の外=左の列のすぐ右) */
function LateChip({ days, soon, maxDays, title }) {
    if (!days) return <span />;
    return (
        <span className="inline-flex min-w-0 items-center gap-1 justify-self-end" title={title}>
            <Bar value={days} max={maxDays} tone={soon ? 'lateSoon' : 'late'} height="h-2" className="w-10 rounded-full" />
            <b className="whitespace-nowrap text-sm font-black leading-none text-rose-600 tabular-nums">{`+${days}日`}</b>
        </span>
    );
}

function Chip({ children, cls = '', title }) {
    return <span title={title} className={`shrink-0 rounded border px-1 text-2xs font-black leading-none ${cls}`}>{children}</span>;
}

/** 左の列: 丸い印(今いる工程の頭文字・工程ごとの色)+太字「品目|工程名」+下段「指図 ×個数 作業区」 */
function NameCell({ lead, title, sub, chips = null, tone }) {
    return (
        <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2">
            <Avatar name={lead} tone={tone} size="w-8 h-8" showName={false} className="row-span-2 shrink-0" />
            <span className="min-w-0 truncate text-base font-black leading-tight text-slate-900" title={title.join('')}>{title[0]}<span className="text-sm font-bold text-slate-500">{title[1] ? `｜${title[1]}` : ''}</span></span>
            <span className="col-start-2 flex min-w-0 items-center gap-1.5 truncate text-2xs leading-tight text-slate-500">{sub}{chips}</span>
        </div>
    );
}

/** 日付の軸の見出し */
function AxisHead({ cols, nowMs, left }) {
    const today = useMemo(() => cols.find((c) => !c.off && c.endMs > nowMs) || null, [cols, nowMs]);
    return (
        <div className={GRID + ' items-end'}>
            <div className="text-2xs font-black text-slate-500">{left[0]}</div>
            <div className="text-right text-2xs font-black text-slate-500" title={left[2] || ''}>{left[1]}</div>
            <div className="relative h-6 border-b-2 border-slate-200">
                {cols.map((d) => {
                    const isToday = !!(today && today.ms === d.ms);
                    const dense = d.width < 2.2;   // 列が細い時は月曜の列だけ日付を出す(読めないため)
                    if (dense && d.wd !== '月' && !isToday) return null;
                    return (
                        <div key={d.ms} className={`absolute bottom-0 whitespace-nowrap rounded-t px-1 text-2xs leading-none ${isToday ? 'bg-cyan-50 py-1 font-black text-cyan-700' : (d.off ? 'text-slate-300' : 'font-bold text-slate-600')}`}
                            style={{ left: `${d.left}%`, width: d.width < 2.2 ? 'auto' : `${d.width}%` }} data-day-head={d.ms}>
                            {d.off && d.width < 3 ? d.wd : d.width < 5.5 ? d.label : `${d.label}(${d.wd})${isToday ? (new Date(d.ms).toDateString() === new Date(nowMs).toDateString() ? ' 今日' : ' 次の勤務') : ''}`}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

/** 軸の地: 日の列の点線・休みの網掛け・次の勤務(今日)の薄い水色の帯 */
function DayColumns({ cols, nowMs }) {
    const today = cols.find((c) => !c.off && c.endMs > nowMs) || columnAt(cols, nowMs);
    return (
        <>
            {cols.map((d) => <div key={d.ms} className="absolute bottom-0 top-0 border-l border-dashed border-slate-100" style={{ left: `${d.left}%`, width: `${d.width}%`, ...(d.off ? OFF_HATCH : null) }} />)}
            {today ? <div className="absolute bottom-0 top-0 bg-cyan-50/60" style={{ left: `${today.left}%`, width: `${today.width}%` }} /> : null}
        </>
    );
}

/** 棒の軸(1行ぶん)。segs=工程の棒(営業日ごとに切る)・wait=薄い棒・due=計画終了の縦線(遅れは赤)・finishMs=右の「終」の札 */
function BarAxis({ r, cols, nowMs, showNames = true, noteWhenOut = '' }) {
    const pct = (ms) => (isNum(ms) ? xOf(cols, ms) : null);
    const nowPct = pct(nowMs);
    const inRange = (ms) => isNum(ms) && ms >= cols[0].ms && ms < cols[cols.length - 1].endMs;
    const duePct = inRange(r.dueMs) ? pct(r.dueMs) : null;
    const dueOutRight = isNum(r.dueMs) && r.dueMs >= cols[cols.length - 1].endMs;
    const cut = r.tier <= TIER.LATE && isNum(r.dueMs) ? (duePct != null ? duePct : (dueOutRight ? 100 : 0)) : null;   // 計画終了を越えた分だけ赤
    const groups = (r.segs || []).map((g, gi) => ({ g, gi, pieces: segmentsOf(cols, g.startMs, g.endMs) }));
    const all = groups.flatMap((x) => x.pieces);
    const waitPieces = r.waitMs > 0 ? segmentsOf(cols, r.readyMs, r.readyMs + r.waitMs) : [];
    const hasBar = all.length > 0 || groups.some((x) => x.g.startMs === x.g.endMs && pct(x.g.startMs) != null && x.g.startMs >= cols[0].ms && x.g.startMs < cols[cols.length - 1].endMs);
    const right = all.length ? Math.max(...all.map((s) => s.left + s.width)) : (hasBar ? pct(groups[0].g.startMs) : 0);
    const shade = (gi) => (gi === 0 ? 'bg-cyan-500' : gi % 2 ? 'bg-cyan-400' : 'bg-cyan-300');
    return (
        <div className="relative h-12">
            <DayColumns cols={cols} nowMs={nowMs} />
            {nowPct != null ? <div className="absolute bottom-0 top-0 z-10 w-px bg-slate-400" style={{ left: `${nowPct}%` }} /> : null}
            {waitPieces.map((s) => <div key={'w' + s.startMs} className="absolute top-6 h-2 bg-cyan-100" title={`前の工程が済んでから始まるまでの待ち(${r.prevLabel || ''})`} style={{ left: `${s.left}%`, width: `${Math.max(0.3, s.width)}%` }} />)}
            {groups.map(({ g, gi, pieces }) => (
                <React.Fragment key={g.act + gi}>
                    {showNames && pieces.length ? <span className="absolute top-0.5 truncate text-2xs font-bold leading-none text-slate-700" title={`${g.act} ${g.name}(${g.wc}) ${g.status === 'working' ? '作業中' : g.est ? '見込み' : 'SAP の計画日'}`}
                        style={{ left: `${pieces[0].left}%`, width: `${Math.max(3, pieces.reduce((a, p) => Math.max(a, p.left + p.width), 0) - pieces[0].left)}%` }}>{g.name}</span> : null}
                    {pieces.map((s, i) => {
                        const l = s.left, rr = s.left + s.width;
                        const overFrom = cut == null ? rr : Math.max(l, Math.min(rr, cut));
                        const baseW = Math.max(0, overFrom - l), overW = Math.max(0, rr - overFrom);
                        const first = i === 0, last = i === pieces.length - 1;
                        return (
                            <React.Fragment key={s.startMs}>
                                {baseW > 0 ? <div className={`absolute top-6 h-4 ${first && gi === 0 ? 'rounded-l-full' : ''} ${first && gi > 0 ? 'border-l-2 border-white' : ''} ${last && overW <= 0 && gi === groups.length - 1 ? 'rounded-r-full' : ''} ${shade(gi)}`}
                                    style={{ left: `${l}%`, width: `${Math.max(0.4, baseW)}%`, minWidth: '0.4rem' }} /> : null}
                                {overW > 0 ? <div className={`absolute top-6 h-4 shadow-sm ${last && gi === groups.length - 1 ? 'rounded-r-full' : ''} ${r.tier === TIER.PAST ? LATE_TONE.past.bar : LATE_TONE.forecast.bar}`}
                                    title={r.lateDays != null ? `SAP の計画終了を ${r.lateDays}日 越える見込み` : 'SAP の計画終了を過ぎています'} style={{ left: `${overFrom}%`, width: `${Math.max(0.4, overW)}%` }} /> : null}
                            </React.Fragment>
                        );
                    })}
                    {!pieces.length && g.startMs === g.endMs && pct(g.startMs) != null && g.startMs >= cols[0].ms && g.startMs < cols[cols.length - 1].endMs
                        ? <div className={`absolute top-6 h-4 w-1.5 rounded-sm ${shade(gi)}`} title={`${g.name}: 標準時間 0(ある時点の印)`} style={{ left: `${pct(g.startMs)}%` }} /> : null}
                </React.Fragment>
            ))}
            {hasBar && isNum(r.finishMs) ? <span className="absolute inset-y-0 z-20 ml-1.5 flex items-end whitespace-nowrap pb-0.5 text-2xs font-black leading-none text-slate-700 tabular-nums" style={{ left: `${Math.min(right, 84)}%` }}>{`${fmtMDHM(r.finishMs)} 終`}</span> : null}
            {!hasBar ? <span className="absolute inset-y-0 right-1 flex items-center text-2xs font-bold leading-tight text-slate-500">{noteWhenOut || (isNum(r.finishMs) ? (r.finishMs >= cols[cols.length - 1].endMs ? `${fmtMDHM(r.finishMs)} 終の見込み ▶(この軸の外)` : `◀ ${fmtMDHM(r.finishMs)} 終(軸より前)`) : '見込み日時なし')}</span> : null}
            {duePct != null && duePct >= 0 && duePct <= 100 ? <div className={`absolute bottom-0 top-0 z-20 w-1 rounded-sm ${r.tier <= TIER.LATE ? 'bg-rose-600' : 'bg-slate-400'}`} title={`SAP の計画終了 ${fmtMDHM(r.dueMs)}`} style={{ left: `${duePct}%` }} /> : null}
        </div>
    );
}

/** 押した行の下: 工程ごとの 始め・終わり(実績/見込み)・SAP の計画終了・遅れ */
function DetailStrip({ r }) {
    return (
        <div className="border-b border-cyan-200 bg-cyan-50 px-3 py-2 text-2xs text-slate-700" data-sap-detail={r.key}>
            <b className="text-slate-900">{r.model}</b> 指図 {r.orderNo} ×{r.qty} ・見込みは標準時間と工場カレンダーから積んだ値(≈)・▲=SAP の計画終了
            <div className="mt-1 grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-1">
                {(r.segs || []).map((g) => (
                    <div key={g.act} className="rounded border border-slate-200 bg-white px-2 py-1">
                        <b>{g.name}</b>({g.wc}) <span className="text-slate-500">{g.status === 'working' ? '作業中' : '未'} ・段取り {g.hJ}h・機械 {g.hL}h・作業者 {g.hN}h</span>
                        <div className="tabular-nums">{g.status === 'working' ? '実績開始' : '≈'}{fmtMDHM(g.startMs)} → ≈{fmtMDHM(g.endMs)}</div>
                        <div className="tabular-nums text-amber-700">▲計画終了 {fmtMD(g.planEndMs)}{g.delayMs > 0 ? <b className="ml-1 text-rose-600">{`+${Math.ceil(g.delayMs / DAY)}日`}</b> : null}</div>
                        {g.origin ? <div className="text-slate-500">遅れの元: {g.origin}</div> : null}
                    </div>
                ))}
            </div>
        </div>
    );
}

const Legend = () => (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-slate-50 px-2 py-1.5 text-2xs font-bold text-slate-500">
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-5 rounded-full bg-cyan-500" />今の工程</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-5 rounded-full bg-cyan-300" />これから(見込み)</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-5 rounded-full bg-cyan-100" />待ち(前の工程が済んでから始まるまで)</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-5 rounded-full bg-rose-500" />計画終了を過ぎた分</span>
        <span className="inline-flex items-center gap-1"><span className={`inline-block h-2 w-5 rounded-full ${LATE_TONE.forecast.bar}`} />この先で越える分</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-3.5 w-1 rounded-sm bg-rose-600" />SAP の計画終了</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-5 rounded border border-slate-200" style={OFF_HATCH} />休み</span>
        <span className="ml-auto font-normal text-slate-400">棒は営業日だけ・見込みは各作業区の台数と標準時間から積んだ仮の計算</span>
    </div>
);

/** 並べ替え・絞り込み・件数の帯 */
function Toolbar({ sortKey, setSortKey, q, setQ, extra }) {
    return (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
            {SORTS.map((k) => <button key={k} type="button" onClick={() => setSortKey(k)} className={`inline-flex min-h-8 items-center rounded-lg border-2 px-2 font-black ${k === sortKey ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-300 bg-white text-slate-700'}`}>{DUE_SORT_LABEL[k]}</button>)}
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="品目・指図で絞る" className="min-h-8 rounded border border-slate-300 px-2" data-testid="sap-due-q" />
            {extra}
        </div>
    );
}

/** 行の並び(品目ごと・工程ごと)。rows は sapBoard の行 */
function RowList({ rows, cols, nowMs, sortKey, q, kind, limit, openAll, setOpenAll }) {
    const [sel, setSel] = useState(null);
    const list = useMemo(() => {
        const k = q.trim();
        const f = k ? rows.filter((r) => (r.item + r.itemText + r.orderNo).includes(k)) : rows;
        return sortDueRows(f, sortKey);
    }, [rows, q, sortKey]);
    const shown = openAll ? list : list.slice(0, limit);
    const lateMax = Math.max(1, ...list.map((r) => r.lateDays != null ? r.lateDays : (r.pastDays || 0)));
    return (
        <div data-testid={'sap-due-' + kind}>
            <AxisHead cols={cols} nowMs={nowMs} left={kind === 'order' ? ['品目｜今の工程 ／ 指図・個数・作業区', '遅れ', '計画終了(SAP)を越える日数。棒の長さは一番遅れる行を全幅にした比'] : ['品目｜この工程 ／ 指図・個数・作業区', '遅れ', 'この工程の SAP 計画終了を越える日数']} />
            {shown.map((r) => {
                const tone = toneOfLane(kind === 'order' ? r.curName : r.worker);
                const on = sel === r.key;
                const days = r.lateDays != null ? r.lateDays : r.pastDays;
                return (
                    <React.Fragment key={r.key}>
                        <button type="button" onClick={() => setSel(on ? null : r.key)} data-sap-row={r.key} data-row-tier={r.tier}
                            className={`${GRID} min-h-14 w-full border-b border-slate-100 py-1 text-left hover:bg-slate-50 ${on ? 'bg-cyan-50' : ''}`}>
                            <NameCell lead={kind === 'order' ? r.curName : r.worker} tone={tone} title={[r.model, kind === 'order' ? r.curName : r.worker]}
                                sub={<><span className="tabular-nums">指図 {r.orderNo}</span><span className="tabular-nums">×{r.qty}</span><span className="font-black text-slate-700">{kind === 'order' ? r.curWc : r.stageWc}</span></>}
                                chips={kind === 'order' ? (r.curStatus === 'working' ? <Chip cls="border-emerald-300 bg-emerald-50 text-emerald-700">作業中</Chip> : r.nextName ? <span className="truncate">次 {r.nextName}</span> : null)
                                    : <Chip cls={r.where === 'working' ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : r.where === 'waiting' ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-slate-300 bg-white text-slate-600'} title={r.where === 'next' ? `前の工程 ${r.prevLabel} がまだ` : `前の工程 ${r.prevLabel}`}>{r.where === 'working' ? '作業中' : r.where === 'waiting' ? '待っている' : 'これから来る'}</Chip>} />
                            <LateChip days={days} soon={r.lateDays != null && r.tier !== TIER.PAST} maxDays={lateMax} title={r.tier === TIER.PAST ? `SAP の計画終了を ${r.pastDays}日 過ぎています` : `SAP の計画終了を ${r.lateDays}日 越える見込み`} />
                            <BarAxis r={r} cols={cols} nowMs={nowMs} showNames={kind === 'order'} />
                        </button>
                        {on && kind === 'order' ? <DetailStrip r={r} /> : null}
                    </React.Fragment>
                );
            })}
            {list.length === 0 ? <p className="p-3 text-center text-xs text-slate-500">該当なし</p> : null}
            {!openAll && list.length > limit ? <button type="button" data-due-more={list.length - limit} onClick={() => setOpenAll(true)} className="mt-1 inline-flex min-h-9 w-full items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white py-1.5 text-2xs font-black text-cyan-700 hover:bg-slate-50">あと {(list.length - limit).toLocaleString('ja-JP')}件を開く（{dueSortHint(sortKey)}。ここから下も同じ並び）</button> : null}
            <Legend />
        </div>
    );
}

/** ③ 工程そのものの一覧: 1行=1工程。日付の列にその日の待ちの山(定時終わりに台が空かず待っている標準時間H) */
function LaneList({ lanes, queueDays, cols, nowMs, onPick }) {
    const maxBack = Math.max(1, ...lanes.map((l) => l.backlogDays));
    const dayMs = useMemo(() => queueDays.map((iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).getTime(); }), [queueDays]);
    const maxH = Math.max(1, ...lanes.flatMap((l) => l.spark));
    return (
        <div data-testid="sap-due-lanes">
            <AxisHead cols={cols} nowMs={nowMs} left={['工程 ／ 待ち・台数', '溜まり', '待ちの標準時間 ÷ 台数 = 何日ぶん']} />
            {lanes.map((l) => (
                <button key={l.name} type="button" onClick={() => onPick(l.name)} data-sap-lane={l.name} className={`${GRID} min-h-14 w-full border-b border-slate-100 py-1 text-left hover:bg-slate-50`}>
                    <NameCell lead={l.name} tone={toneOfLane(l.name)} title={[l.name, '']}
                        sub={<><span className="tabular-nums">待ち {l.total}件・{l.waitH}h</span><span className="tabular-nums">{l.dai}台</span><span className="tabular-nums">次に来る {l.next}件</span></>}
                        chips={l.heat === 3 ? <Chip cls="border-rose-300 bg-rose-50 text-rose-700">溜まり大</Chip> : l.heat === 2 ? <Chip cls="border-amber-300 bg-amber-50 text-amber-800">注意</Chip> : null} />
                    <span className="inline-flex min-w-0 items-center gap-1 justify-self-end" title={`待ち ${l.waitH}h ÷ ${l.dai}台 ÷ ${HOURS_PER_DAY}h/日 = 約 ${l.backlogDays}日ぶん`}>
                        <Bar value={l.backlogDays} max={maxBack} tone={l.heat === 3 ? 'late' : l.heat === 2 ? 'lateSoon' : 'quiet'} height="h-2" className="w-10 rounded-full" />
                        <b className="whitespace-nowrap text-sm font-black leading-none tabular-nums text-slate-800">{`${l.backlogDays}日`}</b>
                    </span>
                    <div className="relative h-12">
                        <DayColumns cols={cols} nowMs={nowMs} />
                        {cols.map((c) => {
                            const i = dayMs.indexOf(c.ms); const h = i >= 0 ? l.spark[i] : 0;
                            if (!h) return null;
                            return <div key={c.ms} className="absolute inset-y-2 flex items-center justify-center rounded text-2xs font-black tabular-nums" title={`${c.label} の定時終わりに待っている標準時間 ${h}h`}
                                style={{ left: `${c.left}%`, width: `${c.width}%`, background: `rgba(225,29,72,${Math.min(0.85, 0.12 + (h / maxH) * 0.75)})`, color: h / maxH > 0.45 ? '#fff' : '#9f1239' }}>{c.width > 2.5 ? Math.round(h) : ''}</div>;
                        })}
                    </div>
                </button>
            ))}
            <p className="mt-2 rounded-lg bg-slate-50 px-2 py-1.5 text-2xs font-bold text-slate-500">日付の列の数字=その日の定時終わりに 台が空かず待っている指図の標準時間(H)。濃い赤ほど多い。行を押すと その工程の一覧(工程ごと)へ。</p>
        </div>
    );
}

/** ④ 部品検査に届く見込み(検査工程 2509 の開始見込みと所要) */
function InspectList({ fc, cols, nowMs, q, sortKey, limit, openAll, setOpenAll }) {
    const list = useMemo(() => {
        const k = q.trim();
        let l = k ? fc.rows.filter((r) => (r.item + r.itemText + r.order).includes(k)) : fc.rows;
        if (sortKey === DUE_SORT.ORDER) l = l.slice().sort((a, b) => (a.order < b.order ? -1 : 1));
        else if (sortKey === DUE_SORT.MODEL) l = l.slice().sort((a, b) => (a.itemText || a.item).localeCompare(b.itemText || b.item, 'ja'));
        else if (sortKey === DUE_SORT.LATE) l = l.slice().sort((a, b) => (b.diffDays ?? -1e9) - (a.diffDays ?? -1e9));
        return l;
    }, [fc, q, sortKey]);
    const shown = openAll ? list : list.slice(0, limit);
    const maxDiff = Math.max(1, ...list.map((r) => Math.abs(r.diffDays || 0)));
    const msOfIso = (iso, t, d) => { if (!iso) return null; const [y, m, dd] = iso.split('-').map(Number); const [h, mi] = (t || d).split(':').map(Number); return new Date(y, m - 1, dd, h, mi).getTime(); };
    return (
        <div data-testid="sap-due-inspect">
            <AxisHead cols={cols} nowMs={nowMs} left={['品目｜検査 ／ 指図・個数・根拠', 'SAP 予定との差', '+は SAP の予定開始日より遅れる・−は早まる(「シミュレーションで更新」の行だけ)']} />
            {shown.map((r) => {
                const startMs = msOfIso(r.startIso, r.startTime, '08:30'), endMs = msOfIso(r.endIso, r.endTime, '17:00'), sapMs = msOfIso(r.sapStart, null, '08:30');
                const row = { segs: startMs != null ? [{ act: r.order, name: r.hours != null ? `所要 ${r.hours}h` : '所要 不明', wc: r.inspWc, status: 'todo', startMs, endMs: endMs ?? startMs, est: true }] : [], finishMs: endMs, tier: TIER.OK, dueMs: null, waitMs: 0 };
                const sapPct = sapMs != null ? xOf(cols, sapMs) : null;
                const tag = r.startBasis === 'sap' ? 'border-slate-300 bg-white text-slate-700' : r.startBasis === 'sim' ? 'border-cyan-300 bg-cyan-50 text-cyan-800' : r.startBasis === 'actual' ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-dashed border-slate-400 bg-white text-slate-500';
                const hTag = r.hoursBasis === 'unknown' ? 'border-dashed border-slate-400 bg-white text-slate-500' : 'border-slate-300 bg-white text-slate-700';
                return (
                    <div key={r.order} data-sap-inspect-row={r.order} data-phase={r.phase} className={`${GRID} min-h-14 w-full border-b border-slate-100 py-1`}>
                        <NameCell lead="検" tone={WORKER_TONES[4]} title={[r.itemText || r.item, r.inspName]}
                            sub={<><span className="tabular-nums">指図 {r.order}</span><span className="tabular-nums">×{r.qty}</span>
                                <Chip cls={tag} title={`検査の手前に未完了の工程が ${r.remaining}つ(直前: ${r.prevLabel})`}>{SHORT_BASIS[r.startBasis]}</Chip>
                                {r.overdue ? <Chip cls="border-rose-300 bg-rose-50 text-rose-700" title="SAP の予定開始日はもう過ぎていますが、検査の手前の工程が未完了です">予定日を過ぎている</Chip> : null}
                                <Chip cls={hTag} title="所要=MT(標準値)。MT が無ければ アプリの検査実績の中央値。どちらも無ければ不明のまま">{r.hoursBasis === 'actual' ? `${HOURS_BASIS_LABEL.actual} ${r.actualN}件` : r.hoursBasis === 'MT' ? `MT ${r.hours}h` : '所要 不明'}</Chip></>} />
                        {r.diffDays > 0 ? <LateChip days={r.diffDays} soon maxDays={maxDiff} title={`SAP の予定開始日(${isoMd(r.sapStart)})より ${r.diffDays}日 遅れる見込み`} />
                            : r.diffDays < 0 ? <b className="justify-self-end whitespace-nowrap text-sm font-black text-emerald-700 tabular-nums" title={`SAP の予定開始日(${isoMd(r.sapStart)})より早まる見込み`}>{`${r.diffDays}日`}</b> : <span />}
                        <div className="relative">
                            <BarAxis r={row} cols={cols} nowMs={nowMs} showNames noteWhenOut={r.startIso ? `この範囲の外(${isoMd(r.startIso)} 開始の見込み)` : 'SAP に予定開始日が無く 見込みを出せません'} />
                            {sapPct != null && sapPct >= 0 && sapPct <= 100 ? <div className="pointer-events-none absolute bottom-0 top-0 z-20 w-0 border-l-2 border-dashed border-amber-500" title={`SAP の予定開始 ${isoMd(r.sapStart)}`} style={{ left: `${sapPct}%` }} /> : null}
                        </div>
                    </div>
                );
            })}
            {list.length === 0 ? <p className="p-3 text-center text-xs text-slate-500">検査工程が未完了の指図はありません</p> : null}
            {!openAll && list.length > limit ? <button type="button" data-due-more={list.length - limit} onClick={() => setOpenAll(true)} className="mt-1 inline-flex min-h-9 w-full items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white py-1.5 text-2xs font-black text-cyan-700 hover:bg-slate-50">あと {(list.length - limit).toLocaleString('ja-JP')}件を開く（届く順）</button> : null}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-slate-50 px-2 py-1.5 text-2xs font-bold text-slate-500">
                <span className="inline-flex items-center gap-1"><span className="inline-block h-3.5 w-0 border-l-2 border-dashed border-amber-500" />SAP の予定開始日</span>
                <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-5 rounded-full bg-cyan-500" />検査の見込み(開始〜終了・所要が分かる時だけ)</span>
                <span className="ml-auto font-normal text-slate-400">遠い=SAP の予定どおり・MT どおり / 近い=前工程の実績から積み上げ直し / MT が無ければ アプリの実績の中央値・それも無ければ「不明」</span>
            </div>
        </div>
    );
}

/** 上の4枚(小さく) */
function StatCards({ st }) {
    const card = (k, v, small, s, bad) => (
        <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
            <div className="text-xs text-slate-500">{k}</div>
            <div className={`mt-0.5 text-xl font-extrabold leading-tight ${bad ? 'text-rose-600' : 'text-slate-900'}`}>{v} <small className="text-xs font-semibold text-slate-500">{small}</small></div>
            <div className="text-xs text-slate-500">{s}</div>
        </div>
    );
    const t = st.top, og = st.origin;
    return (
        <div className="my-2 grid grid-cols-2 gap-2 lg:grid-cols-4" data-testid="sap-stats">
            {card('一番溜まっている工程', t ? t.name : '—', t ? `待ち ${t.total}件` : '', t ? `標準 ${t.waitH}h ÷ ${t.dai}台 ＝ 約 ${Math.round(t.backlogDays)} 日ぶん` : '', true)}
            {card('最初に台数を超える所', og ? og.name : 'なし', og ? `${isoMd(og.day)}〜` : '', og ? `作業区 ${og.wc}・待たされる工程 ${og.waitStages}件・${og.orders}指図に遅れが波及` : '能力を超えて待たされる工程はありません', !!og)}
            {card('計画より遅れる指図', `${st.late}件`, `/ ${st.open}`, `最大の遅れ 約 ${Math.round(st.maxDelayDays)} 日`, st.late > 0)}
            {card('計画終了日を過ぎた件数', `${st.pastNow}件`, '', 'SAP の最後の工程の計画終了日が今日より前の指図', st.pastNow > 0)}
        </div>
    );
}


const LEVEL_CLS = { green: 'border-emerald-300 bg-emerald-50 text-emerald-800', yellow: 'border-amber-300 bg-amber-50 text-amber-900', red: 'border-rose-300 bg-rose-100 text-rose-700' };

/** こなせるか表: 行=工程・列=週・マス=必要な標準時間 ÷ 使える時間(緑<90%・黄90〜100%・赤>100%=足りない時間) */
function CapacityTable({ cap, passRate, onPick, set, capOf, setLaneCap, peopleOf, setPeople }) {
    const { weeks, rows, totals, byRes } = cap;
    const card = (k, v, small, bad) => (
        <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
            <div className="text-xs text-slate-500">{k}</div>
            <div className={`mt-0.5 text-2xl font-extrabold leading-tight ${bad ? 'text-rose-600' : 'text-emerald-700'}`}>{v} <small className="text-xs font-semibold text-slate-500">{small}</small></div>
        </div>
    );
    const GRIDC = { gridTemplateColumns: `9rem 11rem repeat(${weeks.length}, minmax(0, 1fr)) 19rem` };
    return (
        <div className="mb-3" data-testid="sap-capacity">
            <div className="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                {card('今週こなせない工程', `${totals.cannotNow}`, `/ ${rows.length}行${set.view === 'both' ? `(機械 ${byRes.machine.cannotNow}・人 ${byRes.worker.cannotNow})` : ''}`, totals.cannotNow > 0)}
                {card('今週足りない時間の合計', `${totals.shortNow}h`, set.view === 'both' ? `(機械 ${byRes.machine.shortNow}h・人 ${byRes.worker.shortNow}h)` : '', totals.shortNow > 0)}
                {card('計画どおり終わる指図の割合', passRate == null ? '—' : `${Math.round(passRate * 100)}%`, '積み上げの見込みが SAP の計画終了に収まる指図', passRate != null && passRate < 0.9)}
            </div>
            <div className="mb-1 flex flex-wrap items-center gap-3 text-xs" data-testid="sap-capacity-settings">
                <b className="text-sm text-slate-900">こなせるか表</b>
                <span className="text-slate-500">マス = 必要な標準時間 ÷ 使える時間(台数または人数×稼働時間×稼働日)</span>
                <label>残業 1日 <input type="number" min="0" max="4" step="0.5" value={set.ot} onChange={(e) => set.setOt(Math.max(0, Math.min(4, Number(e.target.value) || 0)))} className="w-14 rounded border border-slate-300 px-1" data-testid="sap-ot" /> h</label>
                <label><input type="checkbox" checked={set.sat} onChange={(e) => set.setSat(e.target.checked)} data-testid="sap-sat" /> 土曜も出る</label>
                <label>見る <select value={set.view} onChange={(e) => set.setView(e.target.value)} className="rounded border border-slate-300 px-1" data-testid="sap-capview"><option value="both">機械と人</option><option value="machine">機械だけ</option><option value="worker">人だけ</option></select></label>
                <label>週の数 <select value={set.weeks} onChange={(e) => set.setWeeks(Number(e.target.value))} className="rounded border border-slate-300 px-1">{[4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
            </div>
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
                <div className="grid items-end gap-1 border-b-2 border-slate-200 px-2 py-1 text-2xs font-black text-slate-500" style={GRIDC}>
                    <span>工程</span><span title="機械=各作業区の台数(同時に何本まで)・人=その工程の人数(既定は台数と同じ)。変えると表がすぐ変わります">台数・人数</span>
                    {weeks.map((w) => <span key={w.startMs} className="text-center" title={`${w.work}稼働日${w.sat ? `(土曜 ${w.sat}日)` : ''}`}>{w.name}<br /><span className="font-normal">{w.label}</span></span>)}
                    <span>どうすれば足りるか(足りない週の目安)</span>
                </div>
                {rows.map((r) => (
                    <div key={r.name + r.res} className={`grid items-center gap-1 border-b border-slate-100 px-2 py-1 ${r.res === 'worker' ? 'bg-slate-50' : ''}`} style={GRIDC} data-cap-row={r.name} data-cap-res={r.res}>
                        <span className="flex items-center gap-1.5 truncate text-sm font-black text-slate-900">{r.res === 'worker' ? <span className="ml-2 truncate text-2xs font-bold text-slate-600">└ {r.name} 人(段取り+作業者)</span> : <><Avatar name={r.name} tone={toneOfLane(r.name)} size="w-6 h-6" showName={false} />{r.name}{set.view === 'both' ? <span className="text-xs font-bold text-slate-500">機械</span> : null}</>}</span>
                        {r.res === 'worker'
                            ? <label className="text-2xs text-slate-600" title="この工程で働く人数(既定は台数と同じ)"><input type="number" min="1" max="99" value={peopleOf(r.name, r.dai)} onChange={(e) => setPeople(r.name, Math.max(1, Math.floor(Number(e.target.value) || 1)))} className="mx-0.5 w-11 rounded border border-slate-300 px-1 text-xs" />人</label>
                            : <label className="text-2xs text-slate-600" title={`作業区 ${r.wcs.join(' / ')}`}>各<input type="number" min="1" max="20" value={capOf(r.wcs[0])} onChange={(e) => setLaneCap(r.wcs, Math.max(1, Math.floor(Number(e.target.value) || 1)))} className="mx-0.5 w-11 rounded border border-slate-300 px-1 text-xs" />台 ×作業区{r.wcs.length}つ=<b>{r.dai}台</b></label>}
                        {r.cells.map((c, i) => (
                            <button key={i} type="button" data-cap-cell={`${r.name}|${i}`} data-level={c.level} onClick={() => onPick(r.name, i)}
                                className={`min-h-12 rounded-lg border px-1 py-0.5 text-center leading-tight hover:ring-2 hover:ring-cyan-400 ${LEVEL_CLS[c.level]}`}
                                title={`必要 ${c.demand}h ÷ 使える ${c.cap}h${i === 0 && r.carry ? `(うち計画の窓が過ぎた遅れ分 ${r.carry}h)` : ''}。押すとこの工程のこの週の一覧へ`}>
                                <b className="text-sm tabular-nums">{c.pct === Infinity ? '—' : `${Math.round(c.pct * 100)}%`}</b>
                                <div className="text-2xs font-bold tabular-nums">{c.slack < 0 ? `−${Math.ceil(-c.slack)}h` : ''}</div>
                            </button>
                        ))}
                        <span className={`text-2xs font-bold leading-snug ${r.hint.ok ? 'text-emerald-700' : 'text-rose-700'}`}>{r.hint.text}</span>
                    </div>
                ))}
                {rows.length === 0 ? <p className="p-3 text-center text-xs text-slate-500">必要な標準時間のある工程がありません</p> : null}
            </div>
            <p className="mt-1 text-2xs text-slate-500">必要な時間 = まだ済んでいない工程の標準時間(機械=段取り+機械・人=段取り+作業者)を、SAP の計画の窓(最早実行開始日〜終了日)の稼働日に均等に置いた量(窓が過ぎた遅れ分は今週に積む)。緑 &lt;90% ・黄 90〜100% ・赤 &gt;100%(足りない時間)。使える時間 = 台数(人は人数)×(定時 7.75h＋残業)× 稼働日(今週は今日から)。</p>
        </div>
    );
}

const TABS = [['order', '品目(指図)ごと'], ['stage', '工程ごと'], ['lanes', '工程の一覧'], ['inspect', '部品検査に届く見込み']];

export default function SapDueSection({ baseOrders, orders, queue, origins, nowMs, hoursMode, defCap, capMap, setCapMap, perQty = false, actualsByItem = {}, initialTab = 'order', initialDays = null, initialStage = null, initialSort = null }) {
    const [tab, setTab] = useState(initialTab);
    const [sortKey, setSortKey] = useState(SORTS.includes(initialSort) ? initialSort : DUE_SORT.LATE);
    const [q, setQ] = useState('');
    const [days, setDays] = useState(initialDays || 30);
    const [stageName, setStageName] = useState(initialStage);
    const [openAllMap, setOpenAllMap] = useState({});
    const [near, setNear] = useState(NEAR_REMAINING_DEFAULT);
    const [ot, setOt] = useState(0);
    const [sat, setSat] = useState(false);
    const [nWeeks, setNWeeks] = useState(5);
    const [view, setView] = useState('both');   // こなせるか表: 機械 / 人 / 両方
    const [peopleMap, setPeopleMap] = useState({});   // 工程ごとの人数(指定した物だけ・既定は台数と同じ)
    const peopleOf = (name, dai) => peopleMap[name] ?? dai;
    const [weekSel, setWeekSel] = useState(null);   // こなせるか表のマスから来た時: 週の番号
    const limit = 30;
    const capOf = (wc) => capMap[wc] ?? defCap;
    const cols = useMemo(() => {
        const d0 = new Date(nowMs); d0.setHours(0, 0, 0, 0);
        const w = DEFAULT_WORK_SCHEDULE;
        return buildDayColumns({ fromMs: d0.getTime(), toMs: d0.getTime() + days * DAY, isWorkday: factoryClock(w, null), startMin: timeStrToMinutes(w.dayStart), endMin: timeStrToMinutes(w.dayEnd) });
    }, [nowMs, days]);
    const oRows = useMemo(() => orderRows(orders, { nowMs, hoursMode }), [orders, nowMs, hoursMode]);
    const lanes = useMemo(() => laneSummary(orders, { hoursMode, capOf, queue, days: 14 }), [orders, hoursMode, queue, capMap, defCap]); // eslint-disable-line react-hooks/exhaustive-deps
    const st = useMemo(() => boardStats(oRows, lanes, origins), [oRows, lanes, origins]);
    const cap = useMemo(() => capacityTable(orders, { nowMs, weeks: nWeeks, perQty, capOf, peopleOf, resources: view === 'both' ? ['machine', 'worker'] : [view], otHours: ot, saturday: sat }), [orders, nowMs, nWeeks, perQty, capMap, defCap, ot, sat, view, peopleMap]); // eslint-disable-line react-hooks/exhaustive-deps
    const passRate = oRows.length ? oRows.filter((r) => r.lateDays == null && r.tier !== DUE_TIER.PAST).length / oRows.length : null;
    const setLaneCap = (wcs, n) => { const m = { ...capMap }; wcs.forEach((wc) => { m[wc] = n; }); setCapMap(m); };
    const pickCell = (name, wi) => { setStageName(name); setWeekSel(wi); setTab('stage'); setOpenAllMap({}); const w = cap.weeks[wi]; if (w) setDays((d) => Math.max(d, Math.ceil((w.endMs - nowMs) / DAY) + 1)); };
    const stage = stageName || (lanes.find((l) => l.name === (st.top && st.top.name)) || lanes[0] || {}).name || null;
    const sRowsAll = useMemo(() => (stage ? stageRows(orders, stage, { nowMs, hoursMode }) : []), [orders, stage, nowMs, hoursMode]);
    const weekObj = weekSel != null ? cap.weeks[weekSel] : null;
    const sRows = useMemo(() => (weekObj ? sRowsAll.filter((r) => rowInWeek(r, weekObj, weekSel, nowMs)) : sRowsAll), [sRowsAll, weekObj, weekSel, nowMs]);
    const fc = useMemo(() => inspectForecast(baseOrders, orders, { nearRemaining: near, actualsByItem, hoursMode, todayIso: isoOf(nowMs) }), [baseOrders, orders, near, actualsByItem, hoursMode, nowMs]);
    const openAll = !!openAllMap[tab], setOpenAll = (v) => setOpenAllMap({ ...openAllMap, [tab]: v });
    const stageLane = lanes.find((l) => l.name === stage);
    const maxFin = Math.max(0, ...oRows.map((r) => r.finishMs || 0));
    const fitDays = maxFin > nowMs ? Math.min(365, Math.ceil((maxFin - nowMs) / DAY) + 2) : 30;
    const horizon = (
        <span className="inline-flex items-center gap-1 text-xs"><label>日付の軸 <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded border border-slate-300 px-1">{[...new Set([14, 21, 30, 45, 60, 90, 180, days])].sort((a, b) => a - b).map((d) => <option key={d} value={d}>{d}日</option>)}</select></label>
            <button type="button" onClick={() => setDays(fitDays)} className="min-h-8 rounded border border-slate-300 bg-white px-2 font-bold text-slate-700" title="いちばん遅い指図の終わりまで入れる" data-testid="sap-fit">全部入れる({fitDays}日)</button></span>
    );
    return (
        <div data-testid="sap-due">
            <CapacityTable cap={cap} passRate={passRate} onPick={pickCell} set={{ ot, setOt, sat, setSat, weeks: nWeeks, setWeeks: setNWeeks, view, setView }} capOf={capOf} setLaneCap={setLaneCap} peopleOf={peopleOf} setPeople={(n, v) => setPeopleMap({ ...peopleMap, [n]: v })} />
            <StatCards st={st} />
            <div className="mb-2 flex flex-wrap gap-1" role="tablist">
                {TABS.map(([k, l]) => <button key={k} type="button" role="tab" onClick={() => setTab(k)} data-sap-tab={k} className={`min-h-9 rounded-lg border-2 px-3 text-sm font-black ${tab === k ? 'border-cyan-600 bg-cyan-600 text-white' : 'border-slate-300 bg-white text-slate-700'}`}>{l}{k === 'inspect' ? `(${fc.counts.total})` : k === 'order' ? `(${oRows.length})` : ''}</button>)}
            </div>
            {tab === 'order' && (<>
                <Toolbar sortKey={sortKey} setSortKey={setSortKey} q={q} setQ={setQ} extra={horizon} />
                <RowList rows={oRows} cols={cols} nowMs={nowMs} sortKey={sortKey} q={q} kind="order" limit={limit} openAll={openAll} setOpenAll={setOpenAll} />
            </>)}
            {tab === 'stage' && (<>
                <div className="mb-2 flex flex-wrap gap-1" data-testid="sap-stage-tabs">
                    {lanes.map((l) => <button key={l.name} type="button" onClick={() => { setStageName(l.name); setWeekSel(null); setOpenAllMap({}); }} className={`inline-flex min-h-8 items-center gap-1 rounded-lg border-2 px-2 text-xs font-black ${l.name === stage ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-300 bg-white text-slate-700'}`}>{l.name}<span className={l.name === stage ? 'text-slate-300' : 'text-slate-400'}>{l.total + l.next}</span></button>)}
                </div>
                {stageLane ? <div className="mb-2 rounded border bg-slate-50 p-2 text-xs" data-testid="sap-cap">この工程の作業区の台数(同時に何本まで・既定 {defCap}): {stageLane.wcs.map((wc) => (
                    <label key={wc} className="mr-3 inline-block">{wc} <input type="number" min="1" max="20" value={capOf(wc)} onChange={(e) => setCapMap({ ...capMap, [wc]: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} className="w-12 rounded border px-1" /></label>))}
                    <span className="text-slate-500">待ち {stageLane.waitH}h ÷ {stageLane.dai}台 ＝ 約 {stageLane.backlogDays} 日ぶん</span></div> : null}
                {weekObj ? <div className="mb-2 flex items-center gap-2 text-xs"><span className="rounded-lg border-2 border-cyan-600 bg-cyan-50 px-2 py-1 font-black text-cyan-800" data-testid="sap-week-chip">{stage} ・{weekObj.name}({weekObj.label})に計画の窓がかかる指図 {sRows.length}件{weekSel === 0 ? '(遅れ分を含む)' : ''}</span><button type="button" onClick={() => setWeekSel(null)} className="min-h-8 rounded border border-slate-300 bg-white px-2 font-bold">週の絞りを外す({sRowsAll.length}件)</button></div> : null}
                <Toolbar sortKey={sortKey} setSortKey={setSortKey} q={q} setQ={setQ} extra={horizon} />
                <RowList key={stage + '|' + weekSel} rows={sRows} cols={cols} nowMs={nowMs} sortKey={sortKey} q={q} kind="stage" limit={limit} openAll={openAll} setOpenAll={setOpenAll} />
            </>)}
            {tab === 'lanes' && (<>
                <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">{horizon}</div>
                <LaneList lanes={lanes} queueDays={queue ? queue.days : []} cols={cols} nowMs={nowMs} onPick={(n) => { setStageName(n); setWeekSel(null); setTab('stage'); }} />
            </>)}
            {tab === 'inspect' && (<>
                <div className="mb-2 rounded border bg-slate-50 p-2 text-xs" data-testid="sap-inspect-summary">
                    検査工程(作業区 2509・受入検査/三次元検査)が未完了の指図 <b>{fc.counts.total}件</b>: 近づいた(シミュレーションで更新) <b>{fc.counts.near}件</b>・遠い(SAP 予定どおり) <b>{fc.counts.far}件</b>・MT(標準値)なし <b>{fc.counts.noMt}件</b>(うちアプリの実績あり {fc.counts.withActual}件・所要 不明 {fc.counts.unknownHours}件)・予定開始日なし {fc.counts.unknownStart}件
                    <label className="ml-3">近づいたとみなす: 検査の手前の未完了の工程が <input type="number" min="0" max="10" value={near} onChange={(e) => setNear(Math.max(0, Math.floor(Number(e.target.value) || 0)))} className="w-12 rounded border px-1" /> つ以下(直前の工程が作業中か済でも近い)</label>
                    <div className="mt-1 text-slate-500">MT が無い検査は所要を「不明」とします(作り物の数字は出しません)。アプリで時間取り(実績の記録)が貯まれば、品目ごとの実績の中央値を所要に使えます(この画面にはまだつないでいません)。</div>
                </div>
                <Toolbar sortKey={sortKey === DUE_SORT.FINISH || sortKey === DUE_SORT.DUE ? DUE_SORT.DUE : sortKey} setSortKey={setSortKey} q={q} setQ={setQ} extra={horizon} />
                <InspectList fc={fc} cols={cols} nowMs={nowMs} q={q} sortKey={sortKey} limit={limit} openAll={openAll} setOpenAll={setOpenAll} />
            </>)}
        </div>
    );
}
