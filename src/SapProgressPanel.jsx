// 🏭 SAP 工程の進み(旗つき・既定 OFF)
// 目的: SAP の工程表(xlsx)を端末の中だけで読み、①部品検査に近い順 ②機械グループの負荷
//       ③指図ごとのチャート ④次の工程への連絡 ⑤作業区の日別の負荷 を出す。
// 入力: ブラウザで選んだ xlsx(送信しない・保存しない・Firebase に触れない)
// 呼ぶ人: App.jsx の設定画面(旗が ON の時だけ) / sap-demo.html(見本の入口・force)
// 確かめ方: sap-demo.html で実データを選ぶ
import { useEffect, useMemo, useRef, useState } from 'react';
import { readSapXlsx } from './domain/sapXlsx.js';
import { scheduleOrders, queueTable, HOURS_MODES, hoursKey } from './domain/sapSchedule.js';
import SapDueSection, { SapInspectSection } from './SapDueList.jsx';
import MachineGroupView from './MachineGroupView.jsx';
import { applyMoves, effUnits } from './domain/sapGroups.js';
import { sapFlagOn } from './domain/sapArrivalStore.js';
import { baseNowMs } from './domain/sapBoard.js';
import { buildOrders, reachList, loadByGroup, loadByWorkCenter, itemSummary, gaugeOf, stageView, handoffList, dailyLoad, STATUS_LABEL } from './domain/sapProgress.js';

/** 旗: localStorage の feature:sapProgress が '1' の時だけ ON(既定 OFF)。読み方は domain/sapArrivalStore.js の sapFlagOn と同じ1本 */
export function isSapProgressOn() { return sapFlagOn(); }
/** 端末の中(localStorage)だけに覚える。読み書きできない時は 覚えずに動く。本番(Firestore)には書かない */
const LS = 'sapProgress:';
const loadLS = (k, dflt) => { try { const v = typeof localStorage !== 'undefined' && localStorage.getItem(LS + k); return v ? JSON.parse(v) : dflt; } catch { return dflt; } };
const saveLS = (k, v) => { try { if (typeof localStorage !== 'undefined') localStorage.setItem(LS + k, JSON.stringify(v)); } catch { /* 覚えられなくても動く */ } };
const todayIso = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const REACH_NOTE = {
    estimate: '検査の直前の機械工程の終了日',
    'machine-end': '検査工程が表に無いので機械工程が全部終わる見込み日',
};
const BAR_COLOR = { done: '#10b981', working: '#f59e0b', todo: '#94a3b8' };
const MACHINE_GROUPS = ['平面研削', '円筒研削', '歯切り', 'フライス', '門M/C', '横M/C', '立旋盤', '旋盤', '仕様変更'];

const G_COLOR = { done: '#10b981', working: '#f59e0b', todo: '#cbd5e1', late: '#ef4444' };
const G_LABEL = { done: '済', working: '作業中', todo: '未', late: '遅れ' };

/** 1指図=横1本のゲージ。工程を活動順に隙間なく等幅で繋ぎ(区切り線つき)・上に工程名(作業区)・下に始め/終わりの日時。
 *  実績(SAP)=日付のみ・実線・濃い色 / 見込み(標準時間と工場カレンダーから計算)=「≈」と斜体・斜線の薄い色。
 *  その下に SAP の計画終了(S)の印。見込みが計画を越えたら赤(遅れ)+「+Nh」。
 *  等幅にした理由: 工程の長さは1日〜数十日でばらつき、日付に比例させると短い工程の名前が読めず、隙間や重なりも出るため。 */
function Gauge({ order, today, mark = null }) {
    const g = gaugeOf(order, today);
    if (!g.segs.length) return null;
    return (
        <div className="mb-2" data-testid="sap-gauge">
            <div className="text-xs mb-0.5"><b>{g.item}</b> <span className="text-slate-500">{g.itemText}</span> / 指図 {g.order}</div>
            <div className="flex w-full border border-slate-400 rounded overflow-hidden">
                {g.segs.map((s, i) => {
                    const est = s.startEst || s.endEst;
                    const bg = G_COLOR[s.status];
                    return (
                        <div key={s.act + i} className={'flex-1 min-w-0 ' + (i ? 'border-l border-slate-600' : '') + (mark === s.act ? ' ring-2 ring-inset ring-blue-700' : '')}>
                            <div className="text-[10px] leading-tight px-0.5 pt-0.5 truncate bg-white" title={`${s.act} ${s.name}(${s.wc})${s.origin ? ' ・遅れの元: ' + s.origin : ''}`}>{s.name}({s.wc})</div>
                            <div className="h-3 text-[9px] leading-3 text-center" style={{ background: est ? `repeating-linear-gradient(135deg, ${bg} 0 4px, ${bg}99 4px 8px)` : bg, color: s.status === 'todo' ? '#334155' : '#fff', borderTop: est ? '1px dashed #475569' : undefined }}>{G_LABEL[s.status]}{s.delayH > 0 ? ` +${s.delayH}h` : ''}</div>
                            <div className="flex justify-between text-[9px] leading-tight px-0.5 bg-white text-slate-700">
                                <span className={s.startEst ? 'italic text-slate-500' : ''}>{s.startEst ? '≈' : ''}{s.startLabel}</span><span className={s.endEst ? 'italic text-slate-500' : ''}>{s.endEst ? '≈' : ''}{s.endLabel}</span>
                            </div>
                            <div className={'text-[9px] leading-tight px-0.5 pb-0.5 bg-white text-right ' + (s.status === 'late' ? 'text-red-600 font-bold' : 'text-slate-400')}>{s.planEndLabel ? `▼計画終了 ${s.planEndLabel}` : ''}</div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
function GaugeLegend() {
    return (
        <p className="text-[11px] text-slate-600 mb-1">
            {Object.keys(G_COLOR).map((k) => <span key={k} className="mr-2"><span className="inline-block w-3 h-3 align-middle mr-0.5 rounded-sm" style={{ background: G_COLOR[k] }} />{G_LABEL[k]}{k === 'late' ? '(見込み終了が SAP の計画終了を越えた)' : ''}</span>)}
            <br />実線・濃い色=SAP の実績(日付のみ・SAP に時刻なし) / 「≈」・斜体・斜線=見込み(標準時間と工場カレンダーから計算) / ▼=SAP の計画終了日
        </p>
    );
}

export default function SapProgressPanel({ force = false, autoUrl = null, autoChartIndex = 0, autoStage = null, autoTab = 'order', autoDays = null, autoSort = null, autoMg = null, actualsByItem = {}, lots = null }) {
    const [on] = useState(() => force || isSapProgressOn());
    const [baseOrders, setOrders] = useState(null);
    const [info, setInfo] = useState('');
    const [err, setErr] = useState('');
    const [today, setToday] = useState(todayIso());
    const [tab, setTab] = useState('14');
    const [openGroup, setOpenGroup] = useState(null);
    const [q, setQ] = useState('');
    const [chartOrder, setChartOrder] = useState(null);
    const [hoTab, setHoTab] = useState('passed');
    const [stageKey, setStageKey] = useState(null);   // 工程中心の見方: 機械グループ名
    const [stageWc, setStageWc] = useState('');       // 作業区で更に絞る(空=グループ全体)
    const stageRef = useRef(null);
    const [hoursMode, setHoursMode] = useState('machine');  // 標準値の使い方(1=段取り・2=機械・3=作業者)。既定=機械の占有時間=段取り+機械
    const [perQty, setPerQty] = useState(false);            // 標準値2・3 が1個あたりなら ×数量(未確認なので既定=ロットあたり=掛けない)
    const hk = hoursKey(hoursMode, perQty);
    const [defCap, setDefCap] = useState(1);                // 作業区の既定の台数(同時に何本まで)
    const [capMap, setCapMapRaw] = useState(() => loadLS('capMap', {}));          // 作業区ごとの台数(指定した物だけ)
    const [peopleMap, setPeopleMapRaw] = useState(() => loadLS('peopleMap', {}));   // 作業区ごとの人数(既定=台数)
    const [multiMap, setMultiMapRaw] = useState(() => loadLS('multiMap', {}));      // 作業区ごとの掛け持ち可(既定=不可)
    const [moves, setMovesRaw] = useState(() => loadLS('moves', {}));               // 手で回した工程 { '指図|活動': 移し先の作業区 }
    const mk = (set, key) => (v) => { set(v); saveLS(key, v); };
    const setCapMap = mk(setCapMapRaw, 'capMap'), setPeopleMap = mk(setPeopleMapRaw, 'peopleMap'), setMultiMap = mk(setMultiMapRaw, 'multiMap'), setMoves = mk(setMovesRaw, 'moves');
    const [usePlanStart, setUsePlanStart] = useState(true); // SAP の計画開始日(R)より前には始めない
    const nowMs = useMemo(() => baseNowMs(today), [today]);   // 積み上げの基準時刻 = 基準日の始業 08:30(実行した時刻にしない)
    const movedOrders = useMemo(() => (baseOrders ? applyMoves(baseOrders, moves).orders : null), [baseOrders, moves]);   // 手で回した写し(元は書き換えない)
    // 作業区の同時に動かせる台数 = 掛け持ち可なら台数・不可なら min(台数, 人数)
    const capEff = useMemo(() => {
        const m = {};
        if (movedOrders) for (const o of movedOrders) for (const st of o.stages) if (!(st.wc in m)) { const u = capMap[st.wc] ?? defCap; m[st.wc] = effUnits({ units: u, people: peopleMap[st.wc] ?? u, multi: !!multiMap[st.wc] }).machine; }
        return m;
    }, [movedOrders, capMap, peopleMap, multiMap, defCap]);
    const sched = useMemo(() => (movedOrders ? scheduleOrders(movedOrders, { nowMs, capacity: capEff, defaultCapacity: defCap, hoursMode: hk, usePlanStart }) : null), [movedOrders, nowMs, capEff, defCap, hk, usePlanStart]);
    const orders = sched ? sched.orders : null;
    const queue = useMemo(() => (sched ? queueTable(sched.waits, nowMs, { days: 21 }) : null), [sched, nowMs]);

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
    const sv = useMemo(() => (orders && stageKey ? stageView(orders, stageWc || stageKey, today, { by: stageWc ? 'wc' : 'group' }) : null), [orders, stageKey, stageWc, today]);
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
            if (o && autoStage) setStageKey(autoStage);
            if (o) { const l = reachList(o, todayIso(), { withinDays: 14 }); if (l[autoChartIndex]) setChartOrder(l[autoChartIndex].order); }
        })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoUrl]);
    if (!on) return null;
    const maxH = Math.max(1, ...groups.map((g) => g.openHours));
    const cnt = (f) => list.filter(f).length;
    const pinned = orders && orders.find((x) => x.order === chartOrder);
    const gaugeRows = orders ? [...(pinned ? [pinned] : []), ...shown.filter((o) => !pinned || o.order !== pinned.order).slice(0, 12)] : [];
    const pickStage = (name, wc = '') => { setStageKey(name); setStageWc(wc); setTimeout(() => stageRef.current && stageRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); };
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
            <div className="flex flex-wrap items-center gap-3 mb-2 text-xs bg-slate-50 border rounded p-2" data-testid="sap-settings">
                <label>積み上げに使う時間 <select value={hoursMode} onChange={(e) => setHoursMode(e.target.value)} className="border rounded px-1">{HOURS_MODES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
                <label>作業区の既定の台数 <input type="number" min="1" max="20" value={defCap} onChange={(e) => setDefCap(Math.max(1, Math.floor(Number(e.target.value) || 1)))} className="border rounded px-1 w-14" />(同時に何本まで)</label>
                <label><input type="checkbox" checked={usePlanStart} onChange={(e) => setUsePlanStart(e.target.checked)} /> SAP の計画開始日(最早実行開始日)より前には始めない</label>
                <label title="標準値2(機械)・標準値3(作業者)が 1個あたりの時間なら入れる。段取り(標準値1)は 1ロットにつき1回なので 数量は掛けません"><input type="checkbox" checked={perQty} onChange={(e) => setPerQty(e.target.checked)} data-testid="sap-perqty" /> 標準値2・3 に 数量を掛ける(1個あたりの時間の場合)</label>
                <span className="text-slate-500">標準値 1=段取り・2=機械・3=作業者(清水さんの回答)。機械の占有時間=段取り+機械・作業者の時間=段取り+作業者。標準値2・3 が「1個あたり」か「1ロットあたり」かは未確認なので、既定は ロットあたり(数量を掛けない)です。日時は 工場カレンダー(平日 08:30-17:00・休憩あり)・前の工程が済んでから次・作業区ごとの台数・機械の占有時間で順に積んだ見込みです。</span>
            </div>
            {info && <p className="text-xs text-emerald-700 mb-2" data-testid="sap-info">{info}</p>}
            {err && <p className="text-xs text-red-600 mb-2">{err}</p>}

            {orders && (<>
                <SapInspectSection baseOrders={baseOrders} orders={orders} nowMs={nowMs} hoursMode={hk} actualsByItem={actualsByItem} lots={lots} initialDays={autoDays} initialSort={autoSort} />

                <details className="mt-6 border-t pt-3" data-testid="sap-machine-proto" open={!!autoMg}><summary className="cursor-pointer font-bold">機械グループ(試作・見せ方は別に設計中)</summary>
                <MachineGroupView initialOpen={autoMg && autoMg !== '1' ? autoMg : null} orders={orders} queue={queue} nowMs={nowMs} perQty={perQty} defCap={defCap} capMap={capMap} setCapMap={setCapMap} peopleMap={peopleMap} setPeopleMap={setPeopleMap} multiMap={multiMap} setMultiMap={setMultiMap} moves={moves} setMoves={setMoves} hoursMode={hk} />

                <details className="mt-4 border-t pt-2"><summary className="cursor-pointer font-bold">前の見せ方(品目ごと/工程ごと/工程の一覧のタブ)</summary>
                <SapDueSection orders={orders} queue={queue} origins={sched.origins} nowMs={nowMs} hoursMode={hk} perQty={perQty} defCap={defCap} capMap={capMap} setCapMap={setCapMap} initialTab={autoTab} initialDays={autoDays} initialSort={autoSort} initialStage={autoStage} />
                </details>

                <details className="mt-6 border-t pt-3" data-testid="sap-old-tables"><summary className="cursor-pointer font-bold">くわしい表(前の画面: 表とゲージ)</summary>
                <h3 className="font-bold mt-3 mb-1">遅れの起点トップ5 <span className="text-xs font-normal text-slate-500">(どの作業区のどの日に能力=台数を超えて待たされたか・その遅れが後ろの工程と指図へ波及)</span></h3>
                <div className="overflow-x-auto border rounded mb-1">
                    <table className="w-full text-xs" data-testid="sap-origins">
                        <thead className="bg-slate-100"><tr><th className="p-1 text-left">作業区</th><th className="p-1 text-left">起点の日</th><th className="p-1 text-right">超えた時間(待たされた仕事の標準H)</th><th className="p-1 text-right">待たされた工程</th><th className="p-1 text-right">巻き込まれた指図</th><th className="p-1 text-right">最大の待ち(暦h)</th><th className="p-1 text-left">仕掛かりの山(最大・日)</th></tr></thead>
                        <tbody>{sched.origins.slice(0, 5).map((g) => { const qr = queue && queue.rows.find((x) => x.wc === g.wc); return (
                            <tr key={g.wc + g.day} className="border-t cursor-pointer" onClick={() => pickStage(g.name, g.wc)}>
                                <td className="p-1 font-bold">{g.name}({g.wc})</td><td className="p-1">{g.day}</td><td className="p-1 text-right">{g.overHours}H</td><td className="p-1 text-right">{g.waitStages}</td><td className="p-1 text-right">{g.orders}</td><td className="p-1 text-right">{g.maxWaitH}</td>
                                <td className="p-1">{qr ? `${qr.peakN}件・${qr.peakH}H(${qr.peakDay.slice(5)})` : ''}</td></tr>); })}
                            {sched.origins.length === 0 && <tr><td colSpan={7} className="p-2 text-center text-slate-500">能力を超えて待たされた工程はありません</td></tr>}</tbody>
                    </table>
                </div>
                <p className="text-[11px] text-slate-500 mb-2">「超えた時間」=台が空いておらず順番待ちになった工程の標準時間の合計。作業区の台数は「工程(作業区)中心の見方」で変えられます(下)。</p>

                <h3 className="font-bold mt-3 mb-1">仕掛かりの山(作業区の前で待っている指図) <span className="text-xs font-normal text-slate-500">(各日の定時終わりに待っている標準時間H・濃いほど多い)</span></h3>
                {queue && (<>
                    <div className="text-xs mb-1" data-testid="sap-queue-top">増え続けている上位: {queue.rows.filter((r) => r.growing).slice(0, 5).map((r) => (
                        <span key={r.wc} className="inline-block mr-3"><b>{r.name}({r.wc})</b> 溜まり始め {r.startDay ? r.startDay.slice(5) : '-'}・最大 {r.peakN}件/{r.peakH}H({r.peakDay.slice(5)})・{r.clearDay ? `解消見込み ${r.clearDay.slice(5)}` : '60日以内に解消せず'}</span>))}
                        {queue.rows.filter((r) => r.growing).length === 0 && 'なし'}</div>
                    <div className="overflow-x-auto border rounded mb-2"><table className="text-xs" data-testid="sap-queue">
                        <thead className="bg-slate-100"><tr><th className="p-1 text-left">作業区</th>{queue.days.map((d) => <th key={d} className="p-1">{d.slice(5)}</th>)}</tr></thead>
                        <tbody>{queue.rows.slice(0, 15).map((r) => (<tr key={r.wc} className="border-t"><td className="p-1 font-bold whitespace-nowrap">{r.name}({r.wc})</td>
                            {r.perShown.map((x, i) => <td key={i} className="p-1 text-right" title={`${x.n}件`} style={{ background: x.h ? `rgba(220,38,38,${Math.min(0.8, x.h / 150)})` : undefined, color: x.h / 150 > 0.45 ? '#fff' : undefined }}>{x.h || ''}</td>)}</tr>))}</tbody>
                    </table></div>
                </>)}

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

                <h3 className="font-bold mt-4 mb-1">指図のゲージ <span className="text-xs font-normal text-slate-500">(1行=1指図・工程を活動順に横へ繋ぐ・上の一覧の先頭12件と、押した指図)</span></h3>
                <GaugeLegend />
                {gaugeRows.length ? gaugeRows.map((o) => <Gauge key={o.order} order={o} today={today} />) : <p className="text-xs text-slate-500">該当なし</p>}

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

                <h3 className="font-bold mt-4 mb-1">② 機械グループごとの負荷 <span className="text-xs font-normal text-slate-500">(未完了の機械の占有時間=段取り+機械・H)</span></h3>
                <div data-testid="sap-load">
                    {groups.filter((g) => g.kind === 'machine').map((g) => (
                        <div key={g.name} className="mb-1">
                            <button className="w-full text-left flex items-center gap-2" onClick={() => { setOpenGroup(openGroup === g.name ? null : g.name); pickStage(g.name); }}>
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
                    <h3 className="font-bold mt-4 mb-1">機械グループの日別の負荷 <span className="text-xs font-normal text-slate-500">(未完了の標準時間Hを 見込みの開始〜終了に等分・「遅れ」は基準日より前の分)</span></h3>
                    <div className="overflow-x-auto border rounded">
                        <table className="text-xs" data-testid="sap-daily">
                            <thead className="bg-slate-100"><tr><th className="p-1 text-left">機械グループ</th><th className="p-1">遅れ</th>{daily.days.map((d) => <th key={d} className="p-1">{d.slice(5)}</th>)}</tr></thead>
                            <tbody>{daily.rows.filter((r) => MACHINE_GROUPS.includes(r.name)).map((r) => (
                                <tr key={r.key} className="border-t"><td className="p-1 font-bold whitespace-nowrap">{r.name}</td>
                                    {[r.late, ...r.perDay].map((h, i) => <td key={i} className="p-1 text-right" style={{ background: h ? `rgba(37,99,235,${Math.min(0.75, h / 60)})` : undefined, color: h / 60 > 0.4 ? '#fff' : undefined }}>{h || ''}</td>)}</tr>))}</tbody>
                        </table>
                    </div>
                </>)}

                <div ref={stageRef} data-testid="sap-stage">
                    <h3 className="font-bold mt-4 mb-1">工程(作業区)中心の見方 <span className="text-xs font-normal text-slate-500">(負荷の行を押してもここへ来ます)</span></h3>
                    <div className="flex flex-wrap items-center gap-2 mb-2 text-xs">
                        <select value={stageKey || ''} onChange={(e) => { setStageKey(e.target.value || null); setStageWc(''); }} className="border rounded px-1 py-1">
                            <option value="">工程を選ぶ</option>
                            {groups.filter((g) => g.kind === 'machine').map((g) => <option key={g.name} value={g.name}>{g.name}</option>)}
                        </select>
                        {stageKey && <select value={stageWc} onChange={(e) => setStageWc(e.target.value)} className="border rounded px-1 py-1">
                            <option value="">作業区: すべて</option>
                            {wcs.filter((w) => w.name === stageKey).map((w) => <option key={w.wc} value={w.wc}>{w.wc}</option>)}
                        </select>}
                    </div>
                    {stageKey && (<div className="text-xs mb-2 bg-slate-50 border rounded p-2" data-testid="sap-cap">この工程の作業区の台数(同時に何本まで・既定 {defCap}): {wcs.filter((w) => w.name === stageKey).map((w) => (
                        <label key={w.wc} className="inline-block mr-3">{w.wc} <input type="number" min="1" max="20" value={capMap[w.wc] ?? defCap} onChange={(e) => setCapMap({ ...capMap, [w.wc]: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} className="border rounded px-1 w-12" /></label>))}</div>)}
                    {sv && [['working', '① 今この工程にいる指図(作業中)', sv.working, sv.working.length, '開始日'], ['next', '② 次にこの工程に来る指図(前の工程が済・来る見込み日順)', sv.next, sv.next.length, '来る見込み日'], ['done', '③ この工程を済ませた指図(最近' + sv.done.length + '件 / 全' + sv.doneTotal + '件)', sv.done, sv.doneTotal, '済んだ日']].map(([k, title, rows, n, dl]) => (
                        <div key={k} className="mb-3" data-testid={'sap-stage-' + k}>
                            <h4 className="text-xs font-bold mb-1">{title}: {n}件</h4>
                            {rows.slice(0, 8).map((r) => (
                                <div key={r.order + r.act} className="mb-1">
                                    <div className="text-[11px] text-slate-600">{dl} {r.date || '日付なし'}{k === 'next' ? ` ・前: ${r.prevLabel}` : ''}・{r.stdHours}H</div>
                                    <Gauge order={r.o} today={today} mark={r.act} />
                                </div>))}
                            {rows.length > 8 && <p className="text-[11px] text-slate-500">先頭8件を表示(全{rows.length}件)</p>}
                            {rows.length === 0 && <p className="text-[11px] text-slate-500">なし</p>}
                        </div>))}
                </div>

                <details className="mt-4"><summary className="cursor-pointer font-bold">③ 品目ごとの集計(上位30)</summary>
                    <table className="w-full text-xs mt-1"><thead className="bg-slate-100"><tr><th className="p-1 text-left">品目</th><th className="p-1 text-right">指図</th><th className="p-1 text-right">工程件数</th><th className="p-1 text-right">標準H</th><th className="p-1 text-right">実績あり</th></tr></thead>
                        <tbody>{items.slice(0, 30).map((e) => <tr key={e.item} className="border-t"><td className="p-1">{e.item} <span className="text-slate-500">{e.itemText}</span></td><td className="p-1 text-right">{e.orderCount}</td><td className="p-1 text-right">{e.count}</td><td className="p-1 text-right">{e.stdHours}</td><td className="p-1 text-right">{e.actual}</td></tr>)}</tbody></table>
                </details>
                </details>
                </details>
            </>)}
        </section>
    );
}
