// 🔍 「部品検査に いつ来るか」の入口(SAP 工程の進み)
// 目的: 見込み(domain/sapArrivalForecast.js)を計算し、画面(InspectArrivalView)に渡す。同じ見込みを 部品検査アプリの操業シミュレーションの
//       「これから届く」(未入荷ロットの到着)へ渡す(メモリの中だけ・旗が ON の間だけ・保存しない)。部品検査のロットが渡されていれば 対応の件数も出す。
// 日付の出せない物(止まり・未着手で予定過ぎ・入力もれ・もう着いている)は 到着を渡さず 理由つきで「入れなかった」に回る。
import React, { useEffect, useMemo } from 'react';
import InspectArrivalView from './InspectArrivalView.jsx';
import { arrivalForecast, mockShipByOrder } from './domain/sapArrivalForecast.js';
import { matchSapToLots, sapRowsWithMs } from './domain/sapArrival.js';
import { setSapArrivals } from './domain/sapArrivalStore.js';
import { baseNowMs } from './domain/sapBoard.js';

export default function InspectArrivalSection({ baseOrders, todayIso, lots = null, shipByOrder = null, fileLabel = '' }) {
    const forecast = useMemo(() => {
        const first = arrivalForecast(baseOrders, { todayIso, shipByOrder });
        return first;
    }, [baseOrders, todayIso, shipByOrder]);
    const mockShip = useMemo(() => (shipByOrder ? null : mockShipByOrder(forecast)), [forecast, shipByOrder]);
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
            <InspectArrivalView forecast={forecast} shipByOrder={shipByOrder} mockShip={mockShip} fileLabel={fileLabel} />
        </div>
    );
}
