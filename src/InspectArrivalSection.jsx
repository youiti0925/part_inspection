// 🔍 「部品検査に いつ来るか」の入口(SAP 工程の進み)
// 目的: 見込み(domain/sapArrivalForecast.js)を計算し、画面(InspectArrivalView)に渡す。同じ見込みを 部品検査アプリの操業シミュレーションの
//       「これから届く」(未入荷ロットの到着)へ渡す(メモリの中だけ・旗が ON の間だけ・保存しない)。部品検査のロットが渡されていれば 対応の件数も出す。
// 日付の出せない物(止まり・未着手で予定過ぎ・入力もれ・もう着いている)は 到着を渡さず 理由つきで「入れなかった」に回る。
import React, { useEffect, useMemo, useState } from 'react';
import InspectArrivalView from './InspectArrivalView.jsx';
import InspectWhoView from './InspectWhoView.jsx';
import { arrivalForecast, mockShipByOrder } from './domain/sapArrivalForecast.js';
import { pegPartsToAssembly, shipByPartOrder } from './domain/sapPeg.js';
import { matchSapToLots, sapRowsWithMs } from './domain/sapArrival.js';
import { setSapArrivals } from './domain/sapArrivalStore.js';
import { baseNowMs } from './domain/sapBoard.js';

export default function InspectArrivalSection({ baseOrders, todayIso, lots = null, shipByOrder = null, inspectors = null, pegInput = null, fileLabel = '', initialSub = 'when' }) {
    const [sub, setSub] = useState(initialSub);   // when=いつ来るか / who=誰がするか
    // 出庫日(リミットの元)の出どころ: ①本物の出庫日(shipByOrder・指図ごと)②ピッキングの当たり(pegInput = { demands, stock }:進捗管理表の U 列と ピッキングリスト・在庫から
    //   部品の指図ごとに 当てた組立の指図の U を出す)③どちらも無い間は 作り物の日付(印の見た目だけ・画面に黄色の帯で明記)
    const base0 = useMemo(() => arrivalForecast(baseOrders, { todayIso }), [baseOrders, todayIso]);
    const peg = useMemo(() => (pegInput && Array.isArray(pegInput.demands) ? pegPartsToAssembly({ demands: pegInput.demands, stock: pegInput.stock || {}, parts: base0.rows.filter((r) => r.kind !== 'here').map((r) => ({ order: r.o, item: r.it, qty: r.q, arriveIso: r.arriveIso, sapIso: r.sap == null ? null : new Date((Date.parse(todayIso + 'T00:00:00Z') / 86400000 + r.sap) * 86400000).toISOString().slice(0, 10) })) }) : null), [pegInput, base0, todayIso]);
    const realShip = useMemo(() => shipByOrder || (peg ? shipByPartOrder(peg) : null), [shipByOrder, peg]);
    const mockShip = useMemo(() => (realShip ? null : mockShipByOrder(base0)), [realShip, base0]);
    const forecast = useMemo(() => arrivalForecast(baseOrders, { todayIso, shipByOrder: realShip || mockShip }), [baseOrders, todayIso, realShip, mockShip]);
    // 操業シミュレーションへ渡す行: 日付が出せる物だけ startIso を持つ。出せない物は 理由つき(noDateWhy)で渡して「入れなかった」に回す
    const sapRows = useMemo(() => sapRowsWithMs(forecast.rows.map((r) => ({
        order: r.o, item: r.it, itemText: r.tx, phase: r.state,
        startIso: r.kind === 'bar' || r.kind === 'here' ? r.arriveIso : null, startTime: null,
        startBasis: r.kind === 'here' ? 'actual' : r.sapAsIs ? 'sap' : 'calc',
        noDateWhy: r.kind === 'stuck' ? `止まっている(${r.tag}日動きなし)ので 到着の日付を出せない` : r.kind === 'unknown' ? `日付を出せない(${r.short})` : null,
    }))), [forecast]);
    useEffect(() => { setSapArrivals({ rows: sapRows, baseMs: baseNowMs(todayIso) }); return () => setSapArrivals(null); }, [sapRows, todayIso]);
    const mt = useMemo(() => (lots ? matchSapToLots(sapRows, lots) : null), [sapRows, lots]);
    return (
        <div data-testid="sap-inspect">
            {mt ? <div className="mb-2 rounded border bg-slate-50 p-2 text-xs" data-testid="sap-match-summary">部品検査アプリのロットとの対応(指図番号→品目コード→品目テキストの順・1対1の時だけ当てる): 当たった <b>{mt.matches.length}件</b>・あいまい <b>{mt.ambiguous.length}件</b>・対応なし <b>{mt.unmatched.length}件</b>。当たった未入荷ロットの到着は 操業シミュレーションの「これから届く」に入ります(旗 ON の間だけ・保存しません・日付の出せない物は入れません)。</div> : null}
            {peg ? <div className="mb-2 rounded border bg-slate-50 p-2 text-xs" data-testid="sap-peg-summary">出庫日(リミットの元)= 進捗管理表の U 列(出庫完了日)。部品の指図は ピッキングで当てた組立の指図の U の 2 稼働日前がリミット: 当たった <b>{peg.parts.filter((p) => p.status === 'peg').length}件</b>・需要なし(余り) <b>{peg.parts.filter((p) => p.status === 'surplus').length}件</b>・手配が足りない需要 <b>{peg.unmet.length}件</b>。</div> : null}
            <div className="mb-2 flex gap-2" role="tablist" data-testid="sap-inspect-sub">
                {[['when', 'いつ来るか'], ['who', '誰がするか']].map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={sub === k} onClick={() => setSub(k)} data-sap-sub={k} className={`min-h-9 rounded-lg border-2 px-3 text-sm font-black ${sub === k ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-300 bg-white text-slate-700'}`}>{l}</button>)}
            </div>
            {sub === 'when' ? <InspectArrivalView forecast={forecast} shipIsMock={!realShip} fileLabel={fileLabel} /> : <InspectWhoView forecast={forecast} inspectors={inspectors} shipIsMock={!realShip} fileLabel={fileLabel} />}
        </div>
    );
}
