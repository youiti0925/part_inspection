// 🏭 機械グループ 負荷(Fable の見本「機械_負荷_見本2」): いま言える事・数字の確かさ・SAP に入っている仕事量・機械グループの行(持ち越しは別の列・薄い週は斜線)
// 目的: 「結局こなせるか」を、計画の分だけ(今週のマスに持ち越しを混ぜない)で見せる。行を開くと 中の作業区(台数・人数・掛け持ち)と「先に片付ける候補」。
//       あふれた作業区の工程を 同じ機械グループの別の作業区へ 手で回せる(決めるのは人・端末の中だけに覚える・本番には書かない)。
// 数は作らない(src/domain/sapGroups.js の答えを置くだけ)。検査(2509)はこの画面に出さない(検査の画面へ)。
// 入力: orders(scheduleOrders の結果)・基準時刻・作業区の設定・手で回した物(moves)
// 呼ぶ人: SapProgressPanel.jsx の「機械グループ」の入口
// 確かめ方: sap-demo.html で実データを選ぶ
import React, { useMemo, useState } from 'react';
import { capacityGroups, groupWcs } from './domain/sapGroups.js';
import { machineBundleCheck } from './domain/sapBundleCheck.js';
import { t } from './domain/labels.js';   // 画面の言葉の辞書(空なら今の文字のまま)
import OvertimeCarryPanel from './OvertimeCarryPanel.jsx';   // 🕘 ①残業は いくつ要るか ②持ち越しは いつ無くなるか(旗 feature:sapSort の時だけ)
import { sapSortFlagOn } from './domain/sapSortStore.js';
import TopPublishBar from './TopPublishBar.jsx';   // 🏯 最上位司令塔へ載せる(topPublish が渡された時だけ出る)

const LV = {
    red: 'border-rose-300 bg-rose-100 text-rose-700', yellow: 'border-amber-300 bg-amber-50 text-amber-800', green: 'border-slate-200 bg-white text-slate-700',
};
const SQ = { red: 'bg-rose-600', yellow: 'bg-amber-500', green: 'bg-slate-200' };
const THIN_BG = { backgroundImage: 'repeating-linear-gradient(45deg,#fff,#fff 5px,#f1f5f9 5px,#f1f5f9 10px)' };
const pc = (p) => (Number.isFinite(p) ? `${Math.round(p * 100)}%` : '—');
const int = (v) => Math.max(1, Math.floor(Number(v) || 1));
const mdOf = (iso) => (iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : '—');

function Cell({ c, thin, dem, cap }) {
    const cls = c.level === 'red' ? LV.red : c.level === 'yellow' ? LV.yellow : LV.green;
    return (
        <div className={`rounded-lg border px-1 py-1 text-center font-bold tabular-nums ${cls} ${thin ? 'border-dashed text-slate-400' : ''} ${thin && c.level === 'red' ? '!text-rose-600' : ''}`} style={thin ? THIN_BG : undefined} data-level={c.level} data-thin={thin ? '1' : '0'} title={thin ? 'SAP にまだ計画が入りきっていない週(低く見えるだけ)' : ''}>
            <div className="text-base">{pc(c.pct)}</div>
            <small className="block text-xs font-normal opacity-85">{Math.round(dem)} / {Math.round(cap)}h</small>
        </div>
    );
}

export default function MachineGroupView({ initialOpen = null, orders, nowMs, perQty = true, setPerQty, defCap = 1, capMap, setCapMap, peopleMap, setPeopleMap, multiMap, setMultiMap, moves, setMoves, fileLabel = '', topPublish = null }) {
    const [res, setRes] = useState('machine');     // 数える資源: machine=機械(段取り+機械) / worker=人(段取り+作業者)
    const [ot, setOt] = useState(0);
    const [sat, setSat] = useState(false);
    const [openName, setOpenName] = useState(initialOpen);
    const cfgOf = (wc) => { const units = capMap[wc] ?? defCap; return { units, people: peopleMap[wc] ?? units, multi: !!multiMap[wc] }; };   // 画面の下の方で使う
    const cap = useMemo(() => {
        // 同じ式を中でも作る(外の cfgOf は毎回別の関数になり、useMemo の依存に入れられない)
        const cfgOf = (wc) => { const units = capMap[wc] ?? defCap; return { units, people: peopleMap[wc] ?? units, multi: !!multiMap[wc] }; };
        return capacityGroups(orders, { nowMs, weeks: 5, perQty, cfgOf, otHours: ot, saturday: sat, resource: res });
    }, [orders, nowMs, perQty, capMap, peopleMap, multiMap, defCap, ot, sat, res]);
    const { summary: S, weeks, groups } = cap;
    const moved = Object.entries(moves || {});
    const orderById = useMemo(() => new Map(orders.map((o) => [o.order, o])), [orders]);
    const doMove = (key, to) => setMoves({ ...moves, [key]: to });
    const undo = (key) => { const m = { ...moves }; delete m[key]; setMoves(m); };
    const worst = S.worst;
    const others = worst ? groups.filter((g) => g !== worst && g.lead && g.lead.n >= 10).map((g) => g.lead.med) : [];
    const maxPerDay = Math.max(1, ...weeks.map((w) => w.perDay), S.allCarry / 5 / 3);
    const wcAll = useMemo(() => groupWcs(orders, openName || ''), [orders, openName]);
    const bundle = useMemo(() => machineBundleCheck(orders), [orders]);   // 入れた束が 機械グループの計算に足りない時だけ 画面で言う

    const renderOpen = (g) => (
        <tr className="bg-cyan-50" data-mg-open={g.name}>
            <td colSpan={5 + weeks.length} className="px-3 py-3">
                <div className="grid gap-3 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
                    <div className="rounded-xl border border-slate-200 bg-white p-3" data-mg-wcs={g.name}>
                        <b className="text-sm">{t('machine.inner.heading', '中の作業区')}</b> <span className="text-xs text-slate-500">(台数・人数・掛け持ちを入れると 計算し直します・今は 台数の仮=各1台)</span>
                        <table className="mt-1 w-full text-xs">
                            <thead><tr className="text-slate-500"><th className="p-0.5 text-left">{t('machine.inner.wc', '作業区')}</th><th className="p-0.5" title="同時に何台動かせるか">{t('machine.inner.units', '台数')}</th><th className="p-0.5" title="その作業区で働く人数(既定は台数と同じ)">{t('machine.inner.people', '人数')}</th><th className="p-0.5" title="1人で複数台を同時に回せる(人が要るのは段取り+作業者の間だけ)。不可なら 同時に動ける台数=min(台数,人数)">{t('machine.inner.multi', '掛け持ち')}</th><th className="p-0.5 text-left">持ち越し</th>{weeks.map((w) => <th key={w.startMs} className="p-0.5 font-normal" title={w.label}>{w.name}</th>)}</tr></thead>
                            <tbody>{g.wcs.slice().sort((a, b) => Math.max(...b.cells.slice(0, 3).map((c) => c.pct)) - Math.max(...a.cells.slice(0, 3).map((c) => c.pct))).map((x) => { const cf = cfgOf(x.wc); return (
                                <tr key={x.wc} className="border-t border-slate-100" data-mg-wc={x.wc}>
                                    <td className="p-0.5 font-bold tabular-nums">{x.wc}</td>
                                    <td className="p-0.5 text-center"><input type="number" min="1" max="20" value={cf.units} onChange={(e) => setCapMap({ ...capMap, [x.wc]: int(e.target.value) })} className="w-10 rounded border border-slate-300 px-0.5" data-mg-units={x.wc} /></td>
                                    <td className="p-0.5 text-center"><input type="number" min="1" max="99" value={cf.people} onChange={(e) => setPeopleMap({ ...peopleMap, [x.wc]: int(e.target.value) })} className="w-10 rounded border border-slate-300 px-0.5" data-mg-people={x.wc} /></td>
                                    <td className="p-0.5 text-center"><input type="checkbox" checked={cf.multi} onChange={(e) => setMultiMap({ ...multiMap, [x.wc]: e.target.checked })} data-mg-multi={x.wc} /></td>
                                    <td className="p-0.5 tabular-nums">{Math.round(x.carry)}h・{x.carryN}件<span className="text-slate-500">(約{Math.round(x.carryDays)}日分)</span></td>
                                    {x.cells.map((c, i) => <td key={i} className="p-0.5"><span className={`inline-block min-w-[3.25rem] rounded border px-1 text-center font-semibold tabular-nums ${c.level === 'red' ? LV.red : c.level === 'yellow' ? LV.yellow : LV.green} ${weeks[i].thin ? 'border-dashed !text-slate-400' : ''}`} style={weeks[i].thin ? THIN_BG : undefined} title={`機械 ${c.demandM}h÷${c.capM}h・人 ${c.demandW}h÷${c.capW}h`}>{pc(c.pct)}</span></td>)}
                                </tr>); })}</tbody>
                        </table>
                        {g.wcsAll.some((x) => !x.active) ? <p className="mt-1 text-xs text-slate-500">未完了の工程が無い作業区({g.wcsAll.filter((x) => !x.active).map((x) => x.wc).join('・')})は 能力に数えていません。</p> : null}
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-white p-3" data-mg-list={g.name}>
                        <b className="text-sm">{t('machine.todo.heading', '先に片付ける候補')}</b> <span className="text-xs text-slate-500">(計画開始の古い順・上位10)・同じ機械グループの別の作業区へ回せます(決めるのは人)</span>
                        <table className="mt-1 w-full text-xs">
                            <thead><tr className="text-slate-500"><th className="p-0.5 text-left">品名 / 指図</th><th className="p-0.5">作業区</th><th className="p-0.5">計画開始</th><th className="p-0.5 text-right">{res === 'worker' ? '人の時間' : '機械の時間'}</th><th className="p-0.5 text-left">回す</th></tr></thead>
                            <tbody>{g.top.map((t) => { const key = t.key; const isMoved = key in (moves || {}); const cand = wcAll.filter((w) => w !== t.wc); return (
                                <tr key={key} className="border-t border-slate-100" data-mg-row={key}>
                                    <td className="p-0.5"><b>{t.tx}</b><div className="text-slate-500 tabular-nums">指図 {t.order} ×{t.qty}</div></td>
                                    <td className="p-0.5 text-center tabular-nums">{t.wc}</td>
                                    <td className="p-0.5 text-center tabular-nums">{mdOf(t.planIso)}<span className="text-rose-600">{t.ago ? `(${t.ago}日前)` : ''}</span></td>
                                    <td className="p-0.5 text-right tabular-nums">{res === 'worker' ? t.hw : t.h}h</td>
                                    <td className="p-0.5">{isMoved || t.moved ? <span className="text-violet-700">手で回した {t.from || '?'}→{t.wc} <button type="button" onClick={() => undo(key)} className="ml-1 rounded border border-slate-300 bg-white px-1 font-bold" data-mg-undo={key}>戻す</button></span>
                                        : cand.length ? <select defaultValue="" onChange={(e) => { if (e.target.value) doMove(key, e.target.value); }} className="rounded border border-slate-300 px-1" data-mg-move={key}><option value="">選ぶ</option>{cand.map((w) => { const x = g.wcsAll.find((y) => y.wc === w); const c = x && x.cells[0]; return <option key={w} value={w}>{w}(今週 {c && x.active ? pc(c.pct) : '仕事なし'})</option>; })}</select> : null}</td>
                                </tr>); })}</tbody>
                        </table>
                    </div>
                </div>
            </td>
        </tr>
    );

    return (
        <div data-testid="sap-mg" className="text-slate-800">
            <div className="mb-1"><h2 className="inline-block text-xl font-bold">{t('machine.title', '機械グループ 負荷')}</h2><span className="ml-2 text-xs text-slate-500">{fileLabel}・済んでいない機械工程だけ(検査は 検査の画面へ)</span></div>
            {topPublish ? <TopPublishBar cap={cap} basis={{ resource: res, otHours: ot, saturday: sat, perQty }} {...topPublish} /> : null}
            {sapSortFlagOn() ? <OvertimeCarryPanel orders={orders} nowMs={nowMs} perQty={perQty} defCap={defCap} capMap={capMap} peopleMap={peopleMap} multiMap={multiMap} res={res} onOpenGroup={(n) => { setOpenName(n); setTimeout(() => { const el = document.querySelector('[data-mg-open]'); if (el) el.scrollIntoView({ block: 'center' }); }, 0); }} /> : null}
            {bundle.short ? <div className="my-2 rounded-xl border-2 border-amber-400 bg-amber-50 px-3 py-2 text-sm font-bold text-amber-900" role="alert" data-testid="sap-mg-bundle-short" data-why={bundle.why}>⚠ {bundle.text}</div> : null}
            <div className="my-3 grid gap-3 lg:grid-cols-[1.1fr_1fr]">
                <div className="rounded-xl border border-slate-200 p-3" data-testid="sap-mg-answer">
                    <h3 className="mb-1 text-sm font-semibold text-slate-600">いま言える事</h3>
                    <div className="text-xl font-bold leading-snug">{S.reds.length ? <>計画の分だけで あふれるのは <em className="not-italic text-rose-600">{S.reds.join('・')}</em></> : '計画の分だけで グループ全体としては あふれません'}</div>
                    {S.redWcGroups.length ? <div className="mt-1 text-sm font-semibold text-amber-700" data-testid="sap-mg-wc-over">{S.reds.length ? 'ほかに ' : 'ただし '}作業区ごとに見ると 100%を超える作業区が あるグループ: {S.redWcGroups.map((x) => `${x.name}(${x.n}つ)`).join('・')}<span className="font-normal text-slate-500">(グループ全体では 足りる=同じグループの別の作業区へ回すと 収まる所です)</span></div> : null}
                    {worst ? <div className="mt-1 text-xs text-slate-500">{worst.name}: 今週分 {pc(worst.cells[0].pct)}・来週 {pc(worst.cells[1].pct)}・2週後 {pc(worst.cells[2].pct)}。{worst.lead && worst.lead.n >= 10 ? `実績でも 前の工程が済んでから ${worst.name} が済むまで 中央 ${worst.lead.med}日${others.length ? `(他のグループは ${Math.min(...others)}〜${Math.max(...others)}日)` : ''}。` : ''}</div> : null}
                    <div className="mt-1 text-xs text-slate-500">「計画の日を過ぎた 持ち越し」が 全体で {Math.round(S.allCarry).toLocaleString()}h({S.allCarryN}件)あります(今週のマスには 混ぜていません・左の列に分けています)。</div>
                </div>
                <div className="rounded-xl border border-slate-200 p-3">
                    <h3 className="mb-1 text-sm font-semibold text-slate-600">この画面の数字の確かさ(実データで確かめた結果)</h3>
                    <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs text-slate-700" data-testid="sap-mg-sure">
                        {[['見える', 'bg-cyan-100 text-cyan-800', 'どのグループ・どの作業区が 一番きついか(順位)。実績の待ち日数とも合う'], ['目安', 'bg-amber-100 text-amber-800', '何%か。台数=作業区1つにつき1台・1日 7.75時間 の仮の数字(夜の無人運転や2台持ちは 入っていない)'], ['目安', 'bg-amber-100 text-amber-800', 'どの週か。SAP の計画日は 実績と 中央で 0日・半分が −5〜+5日・1割は 2週間以上ずれる'], ['低く見える', 'bg-amber-100 text-amber-800', '3週後から先。SAP にまだ計画が入りきっていない(斜線の週)'], ['見えない', 'bg-slate-200 text-slate-700', '今 どの機械で作業中か(SAP に「作業中」の記録が 0件)・同じグループの別の機械へ回せるか'], ['確定', 'bg-cyan-100 text-cyan-800', '標準値2・3 は 1個あたり(清水さん確定・同じ品目×工程で数量が違う 416組のうち 415組が同じ値)→ 数量を掛ける。掛けないと 約4割に見える']].map(([k, c, t], i) => <React.Fragment key={i}><span className={`rounded px-1.5 text-center font-bold ${c}`}>{k}</span><span>{t}</span></React.Fragment>)}
                    </div>
                </div>
            </div>
            <div className="mb-3 rounded-xl border border-slate-200 p-3">
                <h3 className="mb-1 text-sm font-semibold text-slate-600">SAP に入っている仕事量({res === 'worker' ? '人' : '機械'}の時間・全グループ)― 先の週ほど まだ計画が入っていません</h3>
                <div className="mt-2 flex items-end gap-2" data-testid="sap-mg-vol">
                    <div className="flex-1 text-center text-xs text-slate-600"><div className="mx-2 rounded-t bg-slate-500" style={{ height: `${Math.min(44, Math.round(S.allCarry / 5 / 3 / maxPerDay * 44))}px` }} />持ち越し {Math.round(S.allCarry).toLocaleString()}h<br /><span className="text-slate-400">計画日を過ぎた分</span></div>
                    {weeks.map((w) => <div key={w.startMs} className="flex-1 text-center text-xs text-slate-600"><div className={`mx-2 rounded-t ${w.thin ? 'border border-dashed border-cyan-400' : 'bg-cyan-300'}`} style={{ height: `${Math.max(2, Math.round(w.perDay / maxPerDay * 44))}px`, ...(w.thin ? { backgroundImage: 'repeating-linear-gradient(45deg,#fff,#fff 5px,#cffafe 5px,#cffafe 10px)' } : null) }} />{w.name} {Math.round(w.allH).toLocaleString()}h<br /><span className="text-slate-400">1日あたり {Math.round(w.perDay)}h{w.thin ? '・薄い' : ''}</span></div>)}
                </div>
            </div>

            {moved.length ? (
                <div className="mb-2 rounded-lg border border-violet-300 bg-violet-50 px-3 py-2 text-xs" data-testid="sap-mg-moved">
                    <b className="text-violet-800">手で回した工程 {moved.length}件</b>(この端末の中だけに覚えています・本番には書きません)
                    <button type="button" onClick={() => setMoves({})} className="ml-2 min-h-7 rounded border border-violet-300 bg-white px-2 font-bold">全部戻す</button>
                    <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">{moved.map(([k, to]) => { const [od, act] = k.split('|'); const s = (orderById.get(od)?.stages || []).find((x) => x.act === act); return <li key={k}>指図 {od} {s ? s.name : act}: {s && s.fromWc ? s.fromWc : '?'}→<b>{to}</b> <button type="button" onClick={() => undo(k)} className="rounded border border-slate-300 bg-white px-1 font-bold">戻す</button></li>; })}</ul>
                </div>
            ) : null}

            <div className="mb-2 flex flex-wrap items-center gap-3 text-sm">
                <span>数える資源</span>
                <span className="inline-flex overflow-hidden rounded-lg border border-slate-300">{[['machine', '機械(段取り+機械)'], ['worker', '人(段取り+作業者)']].map(([k, l]) => <button key={k} type="button" onClick={() => setRes(k)} className={`px-3 py-1 ${res === k ? 'bg-slate-900 text-white' : 'bg-white text-slate-700'}`} data-mg-res={k}>{l}</button>)}</span>
                <span>標準値2・3</span>
                <span className="inline-flex overflow-hidden rounded-lg border border-slate-300">{[[true, '× 数量(1個あたり)'], [false, '掛けない']].map(([k, l]) => <button key={String(k)} type="button" onClick={() => setPerQty(k)} className={`px-3 py-1 ${perQty === k ? 'bg-slate-900 text-white' : 'bg-white text-slate-700'}`} data-mg-qty={String(k)}>{l}</button>)}</span>
                <label className="text-xs">残業 1日 <input type="number" min="0" max="4" step="0.5" value={ot} onChange={(e) => setOt(Math.max(0, Math.min(4, Number(e.target.value) || 0)))} className="w-12 rounded border border-slate-300 px-1" data-testid="sap-mg-ot" /> h</label>
                <label className="text-xs"><input type="checkbox" checked={sat} onChange={(e) => setSat(e.target.checked)} /> 土曜も出る</label>
                <span className="ml-auto flex items-center gap-3 text-xs text-slate-600"><span><i className="mr-1 inline-block h-3.5 w-3.5 rounded border border-rose-300 bg-rose-100 align-[-2px]" />あふれる(100%超)</span><span><i className="mr-1 inline-block h-3.5 w-3.5 rounded border border-amber-300 bg-amber-50 align-[-2px]" />ぎりぎり(90%〜)</span><span><i className="mr-1 inline-block h-3.5 w-3.5 rounded border border-dashed border-slate-300 align-[-2px]" style={THIN_BG} />計画が薄い週(低く見えるだけ)</span></span>
            </div>

            <p className="mb-1 text-xs text-slate-500 md:hidden" data-testid="sap-mg-scrollhint">表は 左右に スクロールできます →</p>
            {/* 幅が狭い端末(375px など)では 表を つぶさず 最低幅を持たせ、箱の中で 横にスクロールする(つぶすと 「門M/C」が縦に折れ 1 行が 数百px になる) */}
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white" data-testid="sap-mg-scroll">
                <table className="w-full max-lg:min-w-[56rem] border-separate border-spacing-0 text-sm" data-testid="sap-mg-table">
                    <thead><tr className="bg-slate-50 text-xs font-semibold text-slate-600">
                        <th className="max-lg:whitespace-nowrap border-b border-slate-200 px-2 py-1.5 text-left">{t('machine.col.group', '工程(機械グループ)')}</th>
                        <th className="max-lg:whitespace-nowrap border-b border-slate-200 px-2 py-1.5 text-left">{t('machine.col.wcs', '作業区(今週〜2週後)')}</th>
                        <th className="max-lg:whitespace-nowrap border-b border-slate-200 px-2 py-1.5 text-left">持ち越し<br /><span className="font-normal">計画日を過ぎた未完了</span></th>
                        {weeks.map((w, i) => <th key={w.startMs} className={`max-lg:whitespace-nowrap border-b border-slate-200 px-1 py-1.5 text-center ${w.thin ? 'text-slate-400' : ''}`}>{w.name}<br /><span className="font-normal">{w.label}{i === 0 ? `・残り${w.work}日` : ''}</span></th>)}
                        <th className="max-lg:whitespace-nowrap border-b border-slate-200 px-2 py-1.5 text-left">実績の待ち<br /><span className="font-normal">前の済→済 中央</span></th>
                        <th className="border-b border-slate-200 px-2 py-1.5 text-left">{t('machine.col.note', '見立て・注意')}</th>
                    </tr></thead>
                    <tbody>
                        {groups.map((g) => {
                            const open = openName === g.name;
                            const unset = g.wcs.every((x) => capMap[x.wc] == null);
                            const vc = g.verdict.level === 'red' ? 'font-semibold text-rose-600' : g.verdict.level === 'yellow' ? 'font-semibold text-amber-700' : 'text-slate-600';
                            return (
                                <React.Fragment key={g.name}>
                                    <tr className={`cursor-pointer ${open ? 'bg-cyan-50' : 'hover:bg-slate-50'}`} onClick={() => setOpenName(open ? null : g.name)} data-mg-group={g.name} data-verdict={g.verdict.level}>
                                        <td className="max-lg:whitespace-nowrap border-b border-slate-100 px-2 py-2"><div className="text-base font-bold">{open ? '▼' : '▶'} {g.name}</div><div className="text-xs text-slate-500">作業区 {g.wcs.length}・{g.dai}台・{g.people}人・残り {g.n} 工程</div></td>
                                        <td className="max-lg:whitespace-nowrap border-b border-slate-100 px-2 py-2">{g.wcs.map((x) => { const p = Math.max(...x.cells.slice(0, 3).map((c) => c.pct)); return <i key={x.wc} title={`${x.wc}: 今週〜2週後の最大 ${pc(p)}`} className={`mr-0.5 inline-block h-3 w-3 rounded-sm ${p > 1 ? SQ.red : p >= 0.9 ? SQ.yellow : SQ.green}`} />; })}<div className="text-xs text-slate-500" data-mg-redwcs={g.redWcs}>{g.verdict.level === 'red' ? `${g.redWcs} つ あふれ` : g.redWcs ? `${g.redWcs} つ 100%超(グループ全体では足りる)` : 'あふれなし'}</div></td>
                                        <td className="max-lg:whitespace-nowrap border-b border-slate-100 px-2 py-2"><div className="text-sm font-bold tabular-nums">{Math.round(g.carry).toLocaleString()}h</div><div className="text-xs text-slate-500">{g.carryN}件・全台で 約{Math.round(g.carryDays)}日分<br />一番古い計画 {g.oldest}日前</div></td>
                                        {g.cells.map((c, i) => <td key={i} className="border-b border-slate-100 px-1 py-2"><Cell c={c} thin={weeks[i].thin} dem={res === 'worker' ? c.demandW : c.demandM} cap={res === 'worker' ? c.capW : c.capM} /></td>)}
                                        <td className="max-lg:whitespace-nowrap border-b border-slate-100 px-2 py-2">{g.lead && g.lead.n >= 10 ? <><b>{g.lead.med}日</b><div className="text-xs text-slate-500">幅 {g.lead.p25}〜{g.lead.p75}日・{g.lead.n}件</div></> : <span className="text-xs text-slate-500">実績が少ない</span>}</td>
                                        <td className="max-lg:min-w-[14rem] border-b border-slate-100 px-2 py-2"><div className={`text-xs ${vc}`}>{g.verdict.text}</div>{unset ? <span className="mr-1 rounded border border-slate-300 px-1 text-xs text-slate-600">台数 未確認</span> : null}{g.zero ? <span className="rounded border border-slate-300 px-1 text-xs text-slate-600">標準値なし {g.zero}件</span> : null}</td>
                                    </tr>
                                    {open ? renderOpen(g) : null}
                                </React.Fragment>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            <div className="mt-3 rounded-xl border border-slate-200 p-3 text-xs text-slate-600">
                <b className="text-slate-900">読み方</b> マス = その週に SAP の計画が求める時間 ÷ 使える時間(台数または人数 × 7.75h × 稼働日)。<b>持ち越し</b>(計画の日を過ぎても済でない分)は 今週のマスに混ぜず 左の列に分けています(混ぜると 今週が ほぼ全グループ 200〜800% になり、本当にきつい所が見えません)。斜線の週は SAP にまだ計画が入りきっていない週(低く見えるだけ)。<br />
                <b className="text-slate-900">注意</b> SAP の日付は「最早」の日付で、納期側(最遅)の日付は この表にありません。「持ち越し」は 必ずしも 納期遅れではありません(計画日より あと、の意味です)。三次元検査(2509)は この画面から外し、検査の画面に出します。
                {S.suspect ? <> 後ろの工程が済んでいるのに 前が未完了のまま(完了の入力もれらしい)の工程 {S.suspect}件は 数えていません。</> : null}
                {S.uncounted.n ? <> 付帯作業に分類されて 数えていない時間 {Math.round(S.uncounted.h)}h({S.uncounted.n}工程)。</> : null}
            </div>
        </div>
    );
}
