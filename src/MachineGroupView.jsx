// 🏭 機械グループ「こなせるか」(Fable の見本の形): 上=今週こなせない工程+5週の○×・行=機械グループ・開くと 前の工程→この工程→次の工程/作業区×週/かかる指図
// 目的: 「結局こなせるか・こなせないか」をすぐ分かる形で出し、あふれた作業区の工程を 同じグループの別の作業区へ手で回して すぐ再計算できる。
// 数は作らない(src/domain/sapGroups.js・sapBoard.js の答えを置くだけ)。保存は呼ぶ側(端末の localStorage・本番には書かない)。
// 入力: orders(scheduleOrders の結果)・queue・基準時刻・作業区の設定(台数・人数・掛け持ち)・手で回した物(moves)
// 呼ぶ人: SapProgressPanel.jsx の「機械グループ(試作)」の折りたたみ
// 確かめ方: sap-demo.html で実データを選ぶ
import React, { useMemo, useState } from 'react';
import { capacityGroups, effUnits, groupWcs, moveKey } from './domain/sapGroups.js';
import { rowInWeek } from './domain/sapCapacity.js';
import { stageRows, laneSummary, chainOf } from './domain/sapBoard.js';

const LV = {
    red: { box: 'border-rose-300 bg-rose-50 text-rose-700', bar: 'bg-rose-500', dot: 'bg-rose-500 border-rose-700' },
    yellow: { box: 'border-amber-300 bg-amber-50 text-amber-800', bar: 'bg-amber-500', dot: 'bg-amber-300 border-amber-700' },
    green: { box: 'border-emerald-200 bg-emerald-50 text-emerald-700', bar: 'bg-emerald-400', dot: 'bg-emerald-100 border-emerald-300' },
};
const COLS = '12rem 11rem repeat(5, minmax(0, 1fr)) 10rem 17rem';
const pctText = (p) => (p === Infinity ? '∞' : `${Math.round(p * 100)}%`);

function WeekCell({ c, calm, onClick, title }) {
    const lv = LV[c.level];
    return (
        <button type="button" onClick={onClick} title={title} className={`flex ${calm ? 'min-h-8' : 'min-h-11'} flex-col items-center justify-center rounded-lg border px-0.5 leading-tight hover:ring-2 hover:ring-cyan-400 ${lv.box}`}>
            <b className={`${calm ? 'text-xs' : 'text-base'} tabular-nums`}>{pctText(c.pct)}</b>
            {c.level === 'red' ? <small className="text-xs font-bold tabular-nums">{c.worse === 'worker' ? `人 ${Math.ceil(-c.slackW)}h不足` : `−${Math.ceil(-c.slackM)}h`}</small> : c.level === 'yellow' && c.worse === 'worker' ? <small className="text-xs font-bold">人</small> : null}
        </button>
    );
}

export default function MachineGroupView({ initialOpen = null, orders, queue, nowMs, perQty = false, defCap = 1, capMap, setCapMap, peopleMap, setPeopleMap, multiMap, setMultiMap, moves, setMoves, hoursMode = 'machine' }) {
    const [ot, setOt] = useState(0);
    const [sat, setSat] = useState(false);
    const [order, setOrder] = useState('bad');          // 'bad'=悪い順・'flow'=工程の流れ順
    const [openName, setOpenName] = useState(initialOpen);
    const [weekSel, setWeekSel] = useState(0);          // 開いた行の「かかる指図」の週
    const [listAll, setListAll] = useState(false);
    const cfgOf = (wc) => { const units = capMap[wc] ?? defCap; return { units, people: peopleMap[wc] ?? units, multi: !!multiMap[wc] }; };
    const cap = useMemo(() => capacityGroups(orders, { nowMs, weeks: 5, perQty, cfgOf, otHours: ot, saturday: sat }), [orders, nowMs, perQty, capMap, peopleMap, multiMap, defCap, ot, sat]); // eslint-disable-line react-hooks/exhaustive-deps
    const lanes = useMemo(() => Object.fromEntries(laneSummary(orders, { hoursMode, capOf: (wc) => effUnits(cfgOf(wc)).machine, queue, days: 14 }).map((l) => [l.name, l])), [orders, hoursMode, queue, capMap, peopleMap, multiMap, defCap]); // eslint-disable-line react-hooks/exhaustive-deps
    const groups = cap.groups;
    const sortedFlow = useMemo(() => {
        if (order !== 'flow') return groups;
        const idx = Object.keys(lanes);   // laneSummary は工程の流れ順
        return groups.slice().sort((a, b) => idx.indexOf(a.name) - idx.indexOf(b.name));
    }, [groups, lanes, order]);
    const { summary } = cap;
    const maxWait = Math.max(1, ...Object.values(lanes).map((l) => l.wait + l.now));

    // 前の工程→この工程→次の工程の件数(今この工程にいる/来る指図)
    const flowOf = (name) => {
        const prev = {}, next = {};
        for (const o of orders) { const st = chainOf(o); const ci = st.findIndex((s) => s.status !== 'done'); if (ci < 0) continue;
            if (st[ci].name === name && st[ci + 1]) next[st[ci + 1].name] = (next[st[ci + 1].name] || 0) + 1;
            if (st[ci + 1] && st[ci + 1].name === name) prev[st[ci].name] = (prev[st[ci].name] || 0) + 1; }
        const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 3);
        return { prev: top(prev), next: top(next) };
    };
    const orderById = useMemo(() => new Map(orders.map((o) => [o.order, o])), [orders]);
    const moved = Object.entries(moves || {});
    const doMove = (key, to) => setMoves({ ...moves, [key]: to });
    const undo = (key) => { const m = { ...moves }; delete m[key]; setMoves(m); };

    const renderOpen = (g) => {
        const fl = flowOf(g.name), lane = lanes[g.name] || {};
        const rows = stageRows(orders, g.name, { nowMs, hoursMode }).filter((r) => rowInWeek(r, cap.weeks[weekSel], weekSel, nowMs))
            .sort((a, b) => (b.pastDays || 0) - (a.pastDays || 0) || (b.lateDays || 0) - (a.lateDays || 0) || b.hours - a.hours);
        const shown = listAll ? rows : rows.slice(0, 8);
        const wcNames = groupWcs(orders, g.name);
        const wcCell = (wc, i) => (g.wcs.find((x) => x.wc === wc) || { cells: [] }).cells[i];
        return (
            <div className="border-b border-slate-200 bg-cyan-50 px-4 py-3" data-mg-open={g.name}>
                <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-xs text-slate-500">前の工程から来る</span>
                    {fl.prev.length ? fl.prev.map(([n, c]) => <span key={n} className="rounded-lg border border-slate-300 bg-white px-2 py-0.5 text-xs">{n} <b>{c}件</b></span>) : <span className="text-xs text-slate-400">なし</span>}
                    <span className="text-slate-400">→</span>
                    <span className="rounded-lg border-2 border-cyan-600 bg-white px-2 py-0.5 text-xs font-black">{g.name} 待ち {(lane.wait || 0) + (lane.now || 0)}件 <span className="font-normal text-slate-500">({lane.waitH || 0}h)</span></span>
                    <span className="text-xs text-slate-500">→ 済むと次へ連絡</span>
                    {fl.next.length ? fl.next.map(([n, c]) => <span key={n} className="rounded-lg border border-slate-300 bg-white px-2 py-0.5 text-xs">{n} <b>{c}件</b></span>) : <span className="text-xs text-slate-400">(最後の工程)</span>}
                </div>
                <div className="grid gap-3 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
                    <div className="rounded-xl border border-slate-200 bg-white p-3" data-mg-wcs={g.name}>
                        <b className="text-sm">中の作業区</b> <span className="text-xs text-slate-500">{g.wcs.filter((x) => x.active).length}つ(うち あふれ・ぎりぎり {g.wcs.filter((x) => x.cells[0].level !== 'green').length})・台数と人数と掛け持ちは ここで変えられます</span>
                        <table className="mt-1 w-full text-xs">
                            <thead><tr className="text-slate-500"><th className="p-0.5 text-left">作業区</th><th className="p-0.5" title="同時に何台動かせるか">台数</th><th className="p-0.5" title="その作業区で働く人数(既定は台数と同じ)">人数</th><th className="p-0.5" title="1人で複数台を同時に回せる(人が要るのは段取り+作業者の間だけ)。不可なら 同時に動ける台数=min(台数,人数)">掛け持ち</th>{cap.weeks.map((w) => <th key={w.startMs} className="p-0.5 font-normal" title={w.label}>{w.name}</th>)}</tr></thead>
                            <tbody>{g.wcs.filter((x) => x.active || capMap[x.wc] != null).map((x) => { const cf = cfgOf(x.wc); return (
                                <tr key={x.wc} className="border-t border-slate-100" data-mg-wc={x.wc}>
                                    <td className="p-0.5 font-bold tabular-nums">{x.wc}</td>
                                    <td className="p-0.5 text-center"><input type="number" min="1" max="20" value={cf.units} onChange={(e) => setCapMap({ ...capMap, [x.wc]: int(e.target.value) })} className="w-10 rounded border border-slate-300 px-0.5" data-mg-units={x.wc} /></td>
                                    <td className="p-0.5 text-center"><input type="number" min="1" max="99" value={cf.people} onChange={(e) => setPeopleMap({ ...peopleMap, [x.wc]: int(e.target.value) })} className="w-10 rounded border border-slate-300 px-0.5" data-mg-people={x.wc} /></td>
                                    <td className="p-0.5 text-center"><input type="checkbox" checked={cf.multi} onChange={(e) => setMultiMap({ ...multiMap, [x.wc]: e.target.checked })} data-mg-multi={x.wc} /></td>
                                    {x.cells.map((c, i) => <td key={i} className="p-0.5"><button type="button" onClick={() => setWeekSel(i)} className={`w-full rounded border px-0.5 py-0.5 font-bold tabular-nums ${LV[c.level].box} ${weekSel === i ? 'ring-2 ring-cyan-500' : ''}`} title={`機械 ${c.demandM}h÷${c.capM}h・人 ${c.demandW}h÷${c.capW}h`}>{pctText(c.pct)}{c.worse === 'worker' && c.level !== 'green' ? '人' : ''}</button></td>)}
                                </tr>); })}</tbody>
                        </table>
                        <p className="mt-1 text-xs text-slate-500">マス = 機械と人の悪い方。「人」の字=人が足りない方。掛け持ち不可の作業区は 同時に動ける台数 = min(台数, 人数)。</p>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-white p-3" data-mg-list={g.name}>
                        <b className="text-sm">{cap.weeks[weekSel].name} この工程にかかる指図</b> <span className="text-xs text-slate-500">{rows.length}件(うち 計画を過ぎた {rows.filter((r) => r.pastDays).length}件)・遅れの大きい順{listAll ? '' : ` に ${shown.length} 件`}</span>
                        {shown.map((r) => {
                            const o = orderById.get(r.orderNo); const st = o ? chainOf(o) : [];
                            const act = r.key.split('|')[1]; const key = moveKey(r.orderNo, act);
                            const isMoved = key in (moves || {});
                            const others = wcNames.filter((w) => w !== r.stageWc);
                            return (
                                <div key={r.key} className="border-b border-slate-100 py-1.5" data-mg-row={r.key}>
                                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                        <div className="min-w-0 flex-1"><b className="text-sm">{r.model}</b> <span className="text-xs text-slate-500 tabular-nums">指図 {r.orderNo} ×{r.qty}・作業区 {r.stageWc}・{r.hours}h</span>
                                            {isMoved ? <span className="ml-1 rounded border border-violet-300 bg-violet-50 px-1 text-xs font-black text-violet-700">手で回した</span> : null}</div>
                                        <div className="flex flex-wrap items-center gap-0.5">{st.map((s, i) => <span key={i} className={`rounded border px-1 text-xs ${s.status === 'done' ? 'border-slate-200 bg-slate-100 text-slate-400' : s.name === g.name ? 'border-cyan-600 bg-cyan-600 font-bold text-white' : 'border-slate-300 bg-white text-slate-600'}`}>{s.status === 'done' ? '✓' : ''}{s.name}</span>)}</div>
                                        <b className="w-14 text-right text-sm text-rose-600 tabular-nums">{r.pastDays ? `+${r.pastDays}日` : r.lateDays ? `+${r.lateDays}日` : ''}</b>
                                    </div>
                                    <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs">
                                        {isMoved ? <><span className="text-violet-700">作業区 {(orderById.get(r.orderNo).stages.find((s) => s.act === act) || {}).fromWc || '?'}→{r.stageWc} に移してあります</span><button type="button" onClick={() => undo(key)} className="min-h-7 rounded border border-slate-300 bg-white px-2 font-bold" data-mg-undo={key}>戻す</button></>
                                            : others.length ? <><span className="text-slate-500">別の作業区へ回す(同じ機械グループの候補・決めるのは人):</span>
                                                <select defaultValue="" onChange={(e) => { if (e.target.value) doMove(key, e.target.value); }} className="rounded border border-slate-300 px-1" data-mg-move={key}>
                                                    <option value="">選ぶ</option>{others.map((w) => { const c = wcCell(w, weekSel); return <option key={w} value={w}>{w}(今の{cap.weeks[weekSel].name} {c ? pctText(c.pct) : '仕事なし'})</option>; })}
                                                </select></> : null}
                                    </div>
                                </div>
                            );
                        })}
                        {rows.length === 0 ? <p className="py-2 text-xs text-slate-500">この週にかかる指図はありません</p> : null}
                        {!listAll && rows.length > 8 ? <button type="button" onClick={() => setListAll(true)} className="mt-1 min-h-8 w-full rounded border border-dashed border-slate-300 bg-white text-xs font-black text-cyan-700">あと {rows.length - 8} 件を開く</button> : null}
                    </div>
                </div>
            </div>
        );
    };

    return (
        <div data-testid="sap-mg">
            <div className="my-3 grid gap-3 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,2fr)]">
                <div className={`rounded-xl border border-slate-200 border-l-8 bg-white p-4 ${summary.cannotNow.length ? 'border-l-rose-500' : 'border-l-emerald-600'}`} data-testid="sap-mg-answer">
                    <div className={`text-2xl font-extrabold ${summary.cannotNow.length ? 'text-rose-700' : 'text-emerald-700'}`}>今週 こなせない工程 {summary.cannotNow.length} <small className="text-sm font-semibold text-slate-600">/ {summary.groupCount} 工程</small></div>
                    <p className="mt-1 text-sm text-slate-700">{summary.cannotNow.length ? <><b>{summary.cannotNow.join('・')}</b> があふれます(足りない時間 合計 約 {Math.round(summary.shortNow)}h)。</> : '今週は 全部の工程がこなせます。'}</p>
                    {summary.tight.length ? <p className="text-sm text-slate-600">ぎりぎり・中の作業区があふれる工程: {summary.tight.join('・')}</p> : null}
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                    <div className="mb-1 text-xs text-slate-500">この先 5 週(こなせない工程の数)</div>
                    <div className="grid grid-cols-5 gap-2">
                        {cap.weeks.map((w, i) => { const n = summary.byWeek[i].length; return (
                            <div key={w.startMs} className={`rounded-lg border px-2 py-1 ${n ? LV.red.box : LV.green.box}`} data-mg-week={i}>
                                <div className="text-xs text-slate-600">{w.name} {w.label}</div>
                                <div className="text-lg font-extrabold">{n ? `${n} 工程 ✕` : 'こなせる ○'}</div>
                                <div className="text-xs">{n ? summary.byWeek[i].join('・') : `稼働 ${w.work} 日`}</div>
                            </div>); })}
                    </div>
                </div>
            </div>

            {moved.length ? (
                <div className="mb-2 rounded-lg border border-violet-300 bg-violet-50 px-3 py-2 text-xs" data-testid="sap-mg-moved">
                    <b className="text-violet-800">手で回した工程 {moved.length}件</b>(この端末の中だけに覚えています・本番には書きません)
                    <button type="button" onClick={() => setMoves({})} className="ml-2 min-h-7 rounded border border-violet-300 bg-white px-2 font-bold">全部戻す</button>
                    <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">{moved.map(([k, to]) => { const [od, act] = k.split('|'); const s = (orderById.get(od)?.stages || []).find((x) => x.act === act); return <li key={k}>指図 {od} {s ? s.name : act}: {s && s.fromWc ? s.fromWc : '?'}→<b>{to}</b> <button type="button" onClick={() => undo(k)} className="rounded border border-slate-300 bg-white px-1 font-bold">戻す</button></li>; })}</ul>
                </div>
            ) : null}

            <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
                <b className="text-base">工程ごと</b><span className="text-slate-500">行を押すと 中の作業区とかかる指図が開きます</span>
                {[['bad', '悪い順'], ['flow', '工程の流れ順']].map(([k, l]) => <button key={k} type="button" onClick={() => setOrder(k)} className={`min-h-8 rounded border-2 px-2 font-black ${order === k ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-300 bg-white text-slate-700'}`}>{l}</button>)}
                <label className="ml-2">残業 1日 <input type="number" min="0" max="4" step="0.5" value={ot} onChange={(e) => setOt(Math.max(0, Math.min(4, Number(e.target.value) || 0)))} className="w-12 rounded border border-slate-300 px-1" data-testid="sap-mg-ot" /> h</label>
                <label><input type="checkbox" checked={sat} onChange={(e) => setSat(e.target.checked)} /> 土曜も出る</label>
                <span className="ml-auto flex items-center gap-2 text-slate-600">{[['red', 'こなせない(100%超)'], ['yellow', 'ぎりぎり(90%〜)'], ['green', 'こなせる']].map(([k, l]) => <span key={k}><i className={`mr-1 inline-block h-3 w-3 rounded border align-[-2px] ${LV[k].box}`} />{l}</span>)}<span>マス=機械と人の悪い方</span></span>
            </div>

            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
                <div className="grid items-end gap-1.5 border-b border-slate-200 px-3 py-2 text-xs text-slate-500" style={{ gridTemplateColumns: COLS }}>
                    <span>工程(機械グループ)</span><span>中の作業区(今週)</span>
                    {cap.weeks.map((w) => <span key={w.startMs} className="text-center leading-tight"><b className="block text-slate-700">{w.name}</b>{w.label}</span>)}
                    <span>溜まり(今)</span><span>どうすれば足りるか</span>
                </div>
                {sortedFlow.map((g) => {
                    const lane = lanes[g.name] || { wait: 0, now: 0, next: 0, waitH: 0 };
                    const calm = g.cells[0].level === 'green' && g.redWcs === 0 && g.cells.every((c) => c.level === 'green') && g.cells[0].pct < 0.5;
                    const open = openName === g.name;
                    const lv = LV[g.cells[0].level];
                    return (
                        <React.Fragment key={g.name}>
                            <div className={`grid cursor-pointer items-center gap-1.5 border-b border-slate-100 px-3 ${calm ? 'py-1' : 'py-2'} hover:bg-slate-50 ${open ? 'bg-cyan-50' : ''}`} style={{ gridTemplateColumns: COLS }} role="button" tabIndex={0}
                                onClick={() => { setOpenName(open ? null : g.name); setWeekSel(0); setListAll(false); }} onKeyDown={(e) => { if (e.key === 'Enter') { setOpenName(open ? null : g.name); setWeekSel(0); setListAll(false); } }} data-mg-group={g.name} data-level={g.cells[0].level}>
                                <div className="flex min-w-0 items-center gap-2"><span className="w-3 text-xs text-slate-400">{open ? '▼' : '▶'}</span><span className={`inline-block w-2.5 shrink-0 rounded ${calm ? 'h-5' : 'h-8'} ${lv.bar}`} />
                                    <div className="min-w-0"><b className="text-base">{g.name}</b><div className="text-xs text-slate-500">{g.dai}台・{g.people}人</div></div></div>
                                <div className="flex flex-wrap items-center gap-0.5">{g.wcs.filter((x) => x.active).map((x) => <i key={x.wc} title={`${x.wc}: ${pctText(x.cells[0].pct)}`} className={`inline-block h-3 w-3 rounded-sm border ${LV[x.cells[0].level].dot}`} />)}{g.redWcs ? <small className="ml-1 text-xs font-bold text-rose-700">{g.redWcs} あふれ</small> : null}</div>
                                {g.cells.map((c, i) => <WeekCell key={i} c={c} calm={calm} title={`機械 ${c.demandM}h÷${c.capM}h(${pctText(c.pctM)})・人 ${c.demandW}h÷${c.capW}h(${pctText(c.pctW)})`} onClick={(e) => { e.stopPropagation(); setOpenName(g.name); setWeekSel(i); setListAll(false); }} />)}
                                <div className="text-xs leading-tight text-slate-600"><div className="mb-0.5 flex h-2 overflow-hidden rounded bg-slate-100"><i className="bg-slate-600" style={{ width: `${(lane.wait / maxWait) * 100}%` }} /><u className="bg-cyan-400 no-underline" style={{ width: `${(lane.now / maxWait) * 100}%` }} /></div>待ち <b className="text-slate-900">{lane.wait + lane.now}</b> 件({Math.round(lane.waitH)}h)<br />これから来る {lane.next}</div>
                                <div className={`text-xs leading-snug ${g.hint.kind === 'ok' ? 'text-slate-500' : g.hint.kind === 'short' ? 'font-semibold text-rose-700' : 'font-semibold text-amber-800'}`}>{g.hint.text}</div>
                            </div>
                            {open ? renderOpen(g) : null}
                        </React.Fragment>
                    );
                })}
            </div>
            <p className="mt-2 text-xs text-slate-500">マス = 必要な標準時間 ÷ 使える時間(台数・人数×7.75h×稼働日)。機械=段取り+機械・人=段取り+作業者。計画の窓が過ぎた分は今週に積んでいます。台数・人数が未確定の作業区は 各1台・人数=台数 で計算しています。「中の作業区」の四角 1つ = 作業区 1つ(今週)。同じ機械グループの中で仕事を回せるかは未確認なので、回すのは人が決めます。</p>
        </div>
    );
}
const int = (v) => Math.max(1, Math.floor(Number(v) || 1));
