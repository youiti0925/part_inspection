// 🏭 SAP 工程の進み(旗つき・既定 OFF)
// 目的: SAP の工程表(xlsx)を端末の中だけで読み、①部品検査に近い順 ②機械グループの負荷
//       ③指図ごとのチャート ④次の工程への連絡 ⑤作業区の日別の負荷 を出す。
// 入力: ブラウザで選んだ xlsx(送信しない・保存しない・Firebase に触れない)
// 呼ぶ人: App.jsx の設定画面(旗が ON の時だけ) / sap-demo.html(見本の入口・force)
// 確かめ方: sap-demo.html で実データを選ぶ
import { useEffect, useMemo, useState } from 'react';
import { readSapXlsx } from './domain/sapXlsx.js';
import { buildOrders, reachList, loadByGroup, loadByWorkCenter, itemSummary, orderChart, handoffList, dailyLoad, STATUS_LABEL } from './domain/sapProgress.js';

const FLAG_KEY = 'feature:sapProgress';
/** 旗: localStorage の feature:sapProgress が '1' の時だけ ON(既定 OFF) */
export function isSapProgressOn() {
    try { return typeof localStorage !== 'undefined' && localStorage.getItem(FLAG_KEY) === '1'; } catch { return false; }
}
const todayIso = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const REACH_NOTE = {
    estimate: '検査の直前の機械工程の終了日',
    'machine-end': '検査工程が表に無いので機械工程が全部終わる見込み日',
};
const BAR_COLOR = { done: '#10b981', working: '#f59e0b', todo: '#94a3b8' };
const MACHINE_GROUPS = ['平面研削', '円筒研削', '歯切り', 'フライス', '門M/C', '横M/C', '立旋盤', '旋盤', '仕様変更'];

/** 1指図=1本のチャート(横=日付・工程を活動順に矢印でつなぐ・色=済/作業中/未・赤線=今日) */
function OrderChart({ order, today }) {
    const c = orderChart(order, today);
    const W = 760, L = 170, rowH = 26, H = c.bars.length * rowH + 28, span = Math.max(1, c.maxDay - c.minDay);
    const x = (d) => L + ((d - c.minDay) / span) * (W - L - 20);
    const md = (d) => new Date(d * 86400000).toISOString().slice(0, 10);
    let prev = null;
    return (
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full border rounded bg-white" data-testid="sap-chart">
            <defs><marker id="sapArrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#475569" /></marker></defs>
            <text x={L} y={12} fontSize="10" fill="#64748b">{md(c.minDay)}</text>
            <text x={W - 20} y={12} fontSize="10" fill="#64748b" textAnchor="end">{md(c.maxDay)}</text>
            {c.bars.map((b, i) => {
                const y = 20 + i * rowH;
                const has = b.startDay != null;
                const x0 = has ? x(b.startDay) : 0, x1 = has ? Math.max(x(b.endDay), x0 + 6) : 0;
                const arrow = has && prev ? <path d={`M${prev.x},${prev.y + 8} L${x0},${y + 8}`} stroke="#475569" strokeWidth="1" fill="none" markerEnd="url(#sapArrow)" /> : null;
                if (has) prev = { x: x1, y };
                return (
                    <g key={b.act + i}>
                        <text x={4} y={y + 12} fontSize="11" fill="#0f172a">{b.act} {b.name}({STATUS_LABEL[b.status]})</text>
                        {arrow}
                        {has ? <rect x={x0} y={y} width={x1 - x0} height={16} rx="3" fill={BAR_COLOR[b.status]} /> : <text x={L} y={y + 12} fontSize="10" fill="#94a3b8">日付なし</text>}
                    </g>
                );
            })}
            <line x1={x(c.todayDay)} x2={x(c.todayDay)} y1={14} y2={H} stroke="#dc2626" strokeWidth="1.5" strokeDasharray="3 2" />
            <text x={x(c.todayDay) + 3} y={H - 3} fontSize="10" fill="#dc2626">今日</text>
        </svg>
    );
}

export default function SapProgressPanel({ force = false, autoUrl = null, autoChartIndex = 0 }) {
    const [on] = useState(() => force || isSapProgressOn());
    const [orders, setOrders] = useState(null);
    const [info, setInfo] = useState('');
    const [err, setErr] = useState('');
    const [today, setToday] = useState(todayIso());
    const [tab, setTab] = useState('14');
    const [openGroup, setOpenGroup] = useState(null);
    const [q, setQ] = useState('');
    const [chartOrder, setChartOrder] = useState(null);
    const [hoTab, setHoTab] = useState('passed');

    const list = useMemo(() => (orders ? reachList(orders, today) : []), [orders, today]);
    const shown = useMemo(() => {
        let l = list;
        if (tab === '14') l = l.filter((o) => o.daysFromToday >= 0 && o.daysFromToday <= 14);
        else if (tab === 'late') l = l.filter((o) => o.daysFromToday < 0);
        const k = q.trim();
        if (k) l = l.filter((o) => (o.item + o.itemText + o.order).includes(k));
        return l;
    }, [list, tab, q]);
    const handoffs = useMemo(() => (orders ? handoffList(orders, today) : []), [orders, today]);
    const hoShown = useMemo(() => (hoTab === 'passed' ? handoffs.filter((h) => h.kind === 'passed').slice().reverse() : handoffs.filter((h) => h.kind === 'expected')), [handoffs, hoTab]);
    const daily = useMemo(() => (orders ? dailyLoad(orders, today, { days: 14 }) : null), [orders, today]);
    const groups = useMemo(() => (orders ? loadByGroup(orders) : []), [orders]);
    const wcs = useMemo(() => (orders ? loadByWorkCenter(orders) : []), [orders]);
    const items = useMemo(() => (orders ? itemSummary(orders) : []), [orders]);

    const loadBuffer = async (name, buf) => {
        setErr(''); setInfo('読み込み中…');
        try {
            const { rows } = await readSapXlsx(buf);
            const o = buildOrders(rows);
            setOrders(o); setChartOrder(null); setInfo(`${name}: ${rows.length}行 → 指図 ${o.length}件(この端末の中だけで読みました・送信なし)`);
            return o;
        } catch (ex) { setOrders(null); setInfo(''); setErr('読めませんでした: ' + (ex && ex.message ? ex.message : ex)); return null; }
    };
    const onFile = async (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) await loadBuffer(f.name, await f.arrayBuffer());
    };
    // 見本の入口だけ: 同じ PC の 127.0.0.1 にある写しを自動で読む(画面の確認用・本番の画面では使わない)
    useEffect(() => {
        if (!autoUrl) return;
        (async () => {
            const o = await loadBuffer('(自動読み込み)', await (await fetch(autoUrl)).arrayBuffer());
            if (o) { const l = reachList(o, todayIso(), { withinDays: 14 }); if (l[autoChartIndex]) setChartOrder(l[autoChartIndex].order); }
        })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoUrl]);
    if (!on) return null;
    const maxH = Math.max(1, ...groups.map((g) => g.openHours));
    const cnt = (f) => list.filter(f).length;
    const chart = orders && orders.find((x) => x.order === chartOrder);
    const tabBtn = (cur, set, k, l) => (
        <button key={k} onClick={() => set(k)} className={'px-2 py-1 rounded border ' + (cur === k ? 'bg-blue-600 text-white border-blue-600' : 'bg-white border-slate-300')}>{l}</button>
    );

    return (
        <section data-testid="sap-progress" className="bg-white border border-slate-300 rounded-lg p-4 my-4 text-sm text-slate-800">
            <h2 className="text-lg font-bold mb-1">🏭 SAP 工程の進み <span className="text-xs font-normal text-slate-500">(試験機能・端末の中だけで読みます)</span></h2>
            <p className="text-xs text-slate-600 mb-2">SAP の工程表(xlsx)を選ぶと、部品検査に届く見込みと機械グループの負荷が出ます。ファイルはどこにも送りません・保存もしません。</p>
            <div className="flex flex-wrap items-center gap-3 mb-2">
                <input type="file" accept=".xlsx" onChange={onFile} data-testid="sap-file" className="text-xs" />
                <label className="text-xs">基準日 <input type="date" value={today} onChange={(e) => e.target.value && setToday(e.target.value)} className="border rounded px-1" /></label>
            </div>
            {info && <p className="text-xs text-emerald-700 mb-2" data-testid="sap-info">{info}</p>}
            {err && <p className="text-xs text-red-600 mb-2">{err}</p>}

            {orders && (<>
                <h3 className="font-bold mt-3 mb-1">① 部品検査に近い順 <span className="text-xs font-normal text-slate-500">(行を押すと下にその指図のチャート)</span></h3>
                <div className="flex flex-wrap items-center gap-2 mb-2 text-xs">
                    {tabBtn(tab, setTab, '14', `今後14日以内 (${cnt((o) => o.daysFromToday >= 0 && o.daysFromToday <= 14)})`)}
                    {tabBtn(tab, setTab, 'late', `見込み日が過ぎた (${cnt((o) => o.daysFromToday < 0)})`)}
                    {tabBtn(tab, setTab, 'all', `すべて (${list.length})`)}
                    <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="品目・指図で絞る" className="border rounded px-2 py-1 ml-2" />
                </div>
                <div className="overflow-x-auto max-h-80 overflow-y-auto border rounded">
                    <table className="w-full text-xs" data-testid="sap-reach-table">
                        <thead className="bg-slate-100 sticky top-0"><tr><th className="p-1 text-left">届く見込み</th><th className="p-1 text-left">品目</th><th className="p-1 text-left">指図</th><th className="p-1 text-left">今の工程</th><th className="p-1 text-left">進み</th><th className="p-1 text-left">根拠</th></tr></thead>
                        <tbody>
                            {shown.slice(0, 300).map((o) => (
                                <tr key={o.order} onClick={() => setChartOrder(o.order)} className={'cursor-pointer border-t ' + (chartOrder === o.order ? 'outline outline-2 outline-blue-400 ' : '') + (o.daysFromToday < 0 ? 'bg-red-50' : o.daysFromToday <= 3 ? 'bg-amber-50' : '')}>
                                    <td className="p-1 whitespace-nowrap font-bold">{o.reach}<span className="font-normal text-slate-500"> ({o.daysFromToday >= 0 ? `あと${o.daysFromToday}日` : `${-o.daysFromToday}日超過`})</span></td>
                                    <td className="p-1">{o.item} <span className="text-slate-500">{o.itemText}</span></td>
                                    <td className="p-1">{o.order}</td>
                                    <td className="p-1 whitespace-nowrap">{o.currentLabel}{o.current ? `(${STATUS_LABEL[o.current.status]})` : ''}</td>
                                    <td className="p-1 whitespace-nowrap">{o.doneCount}/{o.total}</td>
                                    <td className="p-1 text-slate-500">{REACH_NOTE[o.reachKind] || ''}</td>
                                </tr>
                            ))}
                            {shown.length === 0 && <tr><td colSpan={6} className="p-3 text-center text-slate-500">該当なし</td></tr>}
                        </tbody>
                    </table>
                </div>
                {shown.length > 300 && <p className="text-xs text-slate-500 mt-1">先頭300件を表示(全{shown.length}件)</p>}

                <h3 className="font-bold mt-4 mb-1">指図のチャート <span className="text-xs font-normal text-slate-500">(1つの品番に多数の工程を、活動順に矢印でつなぐ)</span></h3>
                {chart ? (<div><p className="text-xs mb-1">指図 {chart.order}・{chart.item} {chart.itemText}・今: {chart.currentLabel}</p><OrderChart order={chart} today={today} /></div>)
                    : <p className="text-xs text-slate-500">上の一覧か下の連絡の行を押してください</p>}

                <h3 className="font-bold mt-4 mb-1">次の工程(作業区)への連絡</h3>
                <div className="flex gap-2 mb-1 text-xs">
                    {tabBtn(hoTab, setHoTab, 'passed', `前の工程が済 → 次へ渡った (${handoffs.filter((h) => h.kind === 'passed').length})`)}
                    {tabBtn(hoTab, setHoTab, 'expected', `今の工程が終わると次へ渡る見込み (${handoffs.filter((h) => h.kind === 'expected').length})`)}
                </div>
                <div className="overflow-x-auto max-h-72 overflow-y-auto border rounded">
                    <table className="w-full text-xs" data-testid="sap-handoff">
                        <thead className="bg-slate-100 sticky top-0"><tr><th className="p-1 text-left">{hoTab === 'passed' ? '渡った日' : '渡る見込み日'}</th><th className="p-1 text-left">品目 / 指図</th><th className="p-1 text-left">前の工程(作業区)</th><th className="p-1 text-left">→ 次の工程(作業区)へ連絡</th></tr></thead>
                        <tbody>{hoShown.slice(0, 200).map((h) => (
                            <tr key={h.order + h.fromAct} className="border-t cursor-pointer" onClick={() => setChartOrder(h.order)}>
                                <td className="p-1 whitespace-nowrap">{h.date}</td><td className="p-1">{h.item} / {h.order}</td>
                                <td className="p-1 whitespace-nowrap">{h.fromAct} {h.fromName}({h.fromWc})</td>
                                <td className="p-1 whitespace-nowrap font-bold">{h.toAct} {h.toName}({h.toWc}){h.toStatus === 'working' ? ' 作業中' : ''}</td>
                            </tr>))}</tbody>
                    </table>
                </div>

                <h3 className="font-bold mt-4 mb-1">② 機械グループごとの負荷 <span className="text-xs font-normal text-slate-500">(未完了の標準時間=標準値1〜3の合計・H)</span></h3>
                <div data-testid="sap-load">
                    {groups.filter((g) => g.kind === 'machine').map((g) => (
                        <div key={g.name} className="mb-1">
                            <button className="w-full text-left flex items-center gap-2" onClick={() => setOpenGroup(openGroup === g.name ? null : g.name)}>
                                <span className="w-24 shrink-0 font-bold">{g.name}</span>
                                <span className="flex-1 bg-slate-100 rounded h-4"><span className="block bg-blue-500 h-4 rounded" style={{ width: `${(g.openHours / maxH) * 100}%` }} /></span>
                                <span className="w-44 shrink-0 text-right text-xs">{g.openHours}H・{g.openCount}件未完了</span>
                            </button>
                            {openGroup === g.name && (
                                <div className="ml-24 text-xs text-slate-600 border-l pl-2">
                                    {wcs.filter((w) => w.name === g.name).map((w) => <div key={w.wc}>作業区 {w.wc}: {w.openHours}H・未完了{w.openCount}件(実績あり{w.actual}/全{w.total}件)</div>)}
                                </div>
                            )}
                        </div>
                    ))}
                </div>

                {daily && (<>
                    <h3 className="font-bold mt-4 mb-1">機械グループの日別の負荷 <span className="text-xs font-normal text-slate-500">(未完了の標準時間Hを 最早開始〜終了に等分・「遅れ」は基準日より前の分)</span></h3>
                    <div className="overflow-x-auto border rounded">
                        <table className="text-xs" data-testid="sap-daily">
                            <thead className="bg-slate-100"><tr><th className="p-1 text-left">機械グループ</th><th className="p-1">遅れ</th>{daily.days.map((d) => <th key={d} className="p-1">{d.slice(5)}</th>)}</tr></thead>
                            <tbody>{daily.rows.filter((r) => MACHINE_GROUPS.includes(r.name)).map((r) => (
                                <tr key={r.key} className="border-t"><td className="p-1 font-bold whitespace-nowrap">{r.name}</td>
                                    {[r.late, ...r.perDay].map((h, i) => <td key={i} className="p-1 text-right" style={{ background: h ? `rgba(37,99,235,${Math.min(0.75, h / 60)})` : undefined, color: h / 60 > 0.4 ? '#fff' : undefined }}>{h || ''}</td>)}</tr>))}</tbody>
                        </table>
                    </div>
                </>)}

                <details className="mt-4"><summary className="cursor-pointer font-bold">③ 品目ごとの集計(上位30)</summary>
                    <table className="w-full text-xs mt-1"><thead className="bg-slate-100"><tr><th className="p-1 text-left">品目</th><th className="p-1 text-right">指図</th><th className="p-1 text-right">工程件数</th><th className="p-1 text-right">標準H</th><th className="p-1 text-right">実績あり</th></tr></thead>
                        <tbody>{items.slice(0, 30).map((e) => <tr key={e.item} className="border-t"><td className="p-1">{e.item} <span className="text-slate-500">{e.itemText}</span></td><td className="p-1 text-right">{e.orderCount}</td><td className="p-1 text-right">{e.count}</td><td className="p-1 text-right">{e.stdHours}</td><td className="p-1 text-right">{e.actual}</td></tr>)}</tbody></table>
                </details>
            </>)}
        </section>
    );
}
