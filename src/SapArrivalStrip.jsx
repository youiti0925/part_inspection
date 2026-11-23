// 🔗 操業シミュレーションの上の帯: SAP から見込んだ検査の到着を「これから届く」に入れた事を言う(件数・どのロットか・入れなかった理由・対応なし)
// 数は作らない(domain/sapArrival.js の applySapArrivals の答えを置くだけ)。旗 OFF や未読込なら何も出ない。
import React, { useState } from 'react';

const WD = ['日', '月', '火', '水', '木', '金', '土'];
const fmt = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]}) ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const BY = { order: '指図番号が同じ', item: '品目コードが1対1', text: '品目テキストが1対1' };
const BASIS = { sap: 'SAP 予定どおり', calc: '前工程の実績から逆算', sim: '前工程の実績から逆算', actual: '検査に着いている', unknown: '不明' };

export function SapArrivalStrip({ applied = null }) {
    const [open, setOpen] = useState(false);
    if (!applied) return null;
    const { applied: ap, skipped, match } = applied;
    const { ambiguous, unmatched } = match;
    return (
        <div className="mb-2 rounded-lg border border-cyan-300 bg-cyan-50 px-3 py-2 text-2xs text-slate-700" data-testid="sap-arrival-strip">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <b className="text-cyan-800">🏭 SAP から見込んだ検査の到着を「これから届く」に入れています: {ap.length}件</b>
                <span>入れなかった(理由つき) {skipped.length}件</span>
                <span>あいまい(勝手に当てない) {ambiguous.length}件</span>
                <span>対応なし {unmatched.length}件</span>
                <button type="button" onClick={() => setOpen(!open)} className="ml-auto min-h-8 rounded border border-cyan-400 bg-white px-2 font-black text-cyan-800" data-testid="sap-arrival-toggle">{open ? '閉じる' : '一覧を開く'}</button>
            </div>
            <div className="text-slate-500">近い物は前工程の実績+工程ごとの普段の日数で逆算した日、遠い物は SAP の検査予定日。止まっている物・予定を過ぎて未着手の物は日付を作らず入れません。入荷の縦線は既存の「登録された入荷日」と同じ見た目で出ます(SAP 由来はこの帯の一覧で見分けます)。保存はしません・本番のロットには書きません。</div>
            {open ? (
                <div className="mt-2 grid gap-2 lg:grid-cols-2">
                    <div>
                        <b>入れたロット({ap.length})</b>
                        <ul className="max-h-60 overflow-auto">{ap.map((a) => (
                            <li key={a.lotId} className="border-b border-cyan-100 py-0.5 tabular-nums">指図 {a.orderNo || '—'} {a.model} → <b>{fmt(a.atMs)}</b> に届く({BASIS[a.row.startBasis]}・{BY[a.by]}){a.prevEntryAt ? <span className="text-slate-500">・元の入荷予定 {fmt(a.prevEntryAt)}</span> : null}</li>))}
                        </ul>
                    </div>
                    <div>
                        <b>入れなかった・当たらなかった</b>
                        <ul className="max-h-60 overflow-auto">
                            {skipped.map((a) => <li key={'s' + a.lotId} className="border-b border-cyan-100 py-0.5">指図 {a.orderNo || '—'} {a.model}: {a.why}</li>)}
                            {ambiguous.map((a, i) => <li key={'a' + i} className="border-b border-cyan-100 py-0.5">SAP 指図 {a.row.order}({a.row.item}): あいまい — {a.reason}</li>)}
                            {unmatched.slice(0, 200).map((a) => <li key={'u' + a.row.order} className="border-b border-cyan-100 py-0.5">SAP 指図 {a.row.order}({a.row.item} {a.row.itemText}): {a.reason}</li>)}
                        </ul>
                    </div>
                </div>
            ) : null}
        </div>
    );
}

export default SapArrivalStrip;
