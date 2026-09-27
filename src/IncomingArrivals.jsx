// 🚚 これから来るもの一覧（見るための窓）。
//
// ⚠⚠ このファイルは **製品検査アプリと最終検査アプリで同一**。片方だけ直すと必ずズレる。
//   置き場所は 両方とも src/IncomingArrivals.jsx（ArrivalCheck.jsx と同じやり方）。
//
// ⚠⚠ 清水さん(2026-08-05):
//   「あちらから知らされてる情報は到着エリアにあるけど、移動させるとなくなるから、
//     どこかで到着予定の情報(カード)をボタンかクリックで出せたらいいなって思う。
//     カードを移動させるためではなくて、何が到着するか見やすくするため」
//   → ①**ここではカードを1ミリも動かせない**。ドラッグも「作業画面を開く」も付けない。見るだけ。
//     ②出す元は arrival_times（組立が知らせてくれた棚）そのもの。
//       ロットをどのエリアへ移しても、検査を始めても、**この窓からは消えない**。
//       マップ下の🚚到着予定の棚は「置き場所」や「手を付けたか」で出し入れが決まるので、
//       移すと棚から消える。そこが「なくなる」の正体だった（データは消えていない）。
//
// ⚠ 元データに無い値は作らない。
//   ・台数は 到着予定に書かれた台数。書かれていない時だけ 検査リストの台数を出し、そう明記する。
//   ・📋手順名は 到着予定に入っている時だけ出す。ロットの templateId から名前を作らない。

import React, { useState } from 'react';
import { Truck, X, Clock, Package, MapPin, ClipboardList, Users } from 'lucide-react';
import { splitsOf, splitMs, hasPendingArrival, arrivalForWhen, splitTotalQty } from './domain/arrivalSplits.js';
import { ARRIVAL_WHEN, arrivalWhenOf } from './domain/contactBoard.js';
// ⏱ fmtWorkSec / isUntouchedLot は domain/incomingWork.js へ移した(2026-08-29)。
//   画面部品のファイルから関数を export すると react-refresh/only-export-components に当たる為。
//   ⚠ここから出し直さない(出し直しも同じ規則に当たる)。使う側も domain/incomingWork.js から import する。
import { fmtWorkSec, isUntouchedLot } from './domain/incomingWork.js';

// 「これから来る」/「予定を過ぎた」/「もう始めている」の3つだけ。増やすと現場が読めない。
export const INCOMING_STATE = { COMING: 'coming', PAST: 'past', WORKING: 'working' };

const STATE_LABEL = {
    [INCOMING_STATE.COMING]: 'これから来る',
    [INCOMING_STATE.PAST]: '⚠ 予定を過ぎています',
    [INCOMING_STATE.WORKING]: 'もう検査を始めています',
};
const STATE_CLS = {
    [INCOMING_STATE.COMING]: 'bg-teal-600 text-white border-teal-700',
    [INCOMING_STATE.PAST]: 'bg-amber-100 text-amber-900 border-amber-400',
    [INCOMING_STATE.WORKING]: 'bg-slate-100 text-slate-600 border-slate-300',
};
const CARD_CLS = {
    [INCOMING_STATE.COMING]: 'border-teal-300 bg-white',
    [INCOMING_STATE.PAST]: 'border-amber-300 bg-amber-50/60',
    [INCOMING_STATE.WORKING]: 'border-slate-200 bg-slate-50/60',
};

const fmtSplitWhen = (s) => {
    const ms = splitMs(s);
    if (ms == null) return `${s.date || ''} ${s.time || ''}`.trim();
    const d = new Date(ms);
    return `${d.getMonth() + 1}/${d.getDate()} ${s.time}`;
};

/**
 * 到着予定の棚(arrival_times)から「これから来るもの」の行を作る。
 * ⚠ 置き場所(mapZoneId / location)は **1文字も見ない**。だから移しても消えない。
 * @param arrivalByLot { [lotId]: arrival_times のドキュメント }
 * @param lots         検査リストのロット一覧（台数や今どこにあるかを添えるだけ。無くても行は作る）
 */
export const buildIncomingRows = ({ arrivalByLot = {}, lots = [], now = Date.now() } = {}) => {
    const lotById = new Map((lots || []).filter(l => l && l.id).map(l => [l.id, l]));
    return Object.entries(arrivalByLot || {})
        .map(([lotId, arr]) => {
            if (!arr || !arr.time) return null;
            const lot = lotById.get(lotId) || null;
            // 完了した物は「これから来るもの」ではない。窓からは外す。
            if (lot && (lot.status === 'completed' || lot.location === 'completed')) return null;
            const splits = splitsOf(arr);
            const pending = hasPendingArrival(arr, now);
            const touched = lot
                ? Object.values(lot.tasks || {}).some(t => t && (t.status === 'completed' || t.status === 'processing' || t.status === 'ng'))
                : false;
            const state = pending ? INCOMING_STATE.COMING : (touched ? INCOMING_STATE.WORKING : INCOMING_STATE.PAST);
            const aw = arrivalWhenOf(arrivalForWhen(arr, now), now);
            // ⚠⚠ 2026-08-07: この行が「同じ指図の別ロットへ広げた札」かどうか。
            //   広げた札は **中身が元のロットの物のまま**(台数・手順名は元のロットの値)。
            //   そのまま出すと「1台なのに2台」「別の手順名」という **嘘の数字**になる。
            //   広げた分は、台数も手順名も **そのロット自身の値だけ**を使う。無ければ出さない。
            const spread = !!arr._spreadFrom;
            const arrQty = (!spread && Number(arr.quantity) > 0) ? Number(arr.quantity) : 0;
            const lotQty = Number(lot && lot.quantity) > 0 ? Number(lot.quantity) : 0;
            return {
                lotId, lot, arr, splits, state, aw, spread,
                // 台数は「到着予定に書かれた台数」が本命。無い時だけ検査リストの台数(qtyFromLot=true)。
                qty: arrQty || lotQty,
                qtyFromLot: !arrQty && lotQty > 0,
                orderNo: arr.orderNo || (lot && lot.orderNo) || '',
                model: (spread ? (lot && lot.model) : arr.model) || (lot && lot.model) || '',
                // 手順名も同じ。広げた分は元のロットの手順名を出さない(別の手順の物なので)。
                templateName: spread ? '' : (arr.templateName || ''),
            };
        })
        .filter(Boolean)
        // 🚨並び順は **状態が先、時刻はその中** で決める。
        //   時刻だけで並べると、3週間前の予定超過が一番上に来て「次に来る物」が下へ押し出される(実測)。
        //   これから来る → 検査中 → 予定超過。予定超過だけは **新しい順**(古い幻の行を下に沈める)。
        .sort((a, b) => {
            const rank = { [INCOMING_STATE.COMING]: 0, [INCOMING_STATE.WORKING]: 1, [INCOMING_STATE.PAST]: 2 };
            const ra = rank[a.state] ?? 9, rb = rank[b.state] ?? 9;
            if (ra !== rb) return ra - rb;
            const ta = a.aw.ts == null ? Infinity : a.aw.ts;
            const tb = b.aw.ts == null ? Infinity : b.aw.ts;
            return a.state === INCOMING_STATE.PAST ? (tb - ta) : (ta - tb);
        });
};

/** ボタンに出す件数。**まだ来ていない便が残っている物だけ**数える(棚に出ているかは関係ない)。 */
export const incomingCountOf = ({ arrivalByLot = {}, lots = [], now = Date.now() } = {}) =>
    buildIncomingRows({ arrivalByLot, lots, now }).filter(r => r.state === INCOMING_STATE.COMING).length;

/**
 * 「これから来るもの」を出すだけの窓。
 * ⚠ ここに **移動・編集・開始のボタンは付けない**（清水さん「移動させるためではない」）。
 * @param zoneNameOf (lot) => '第1検査エリア' など。アプリごとにエリアの持ち方が違うので外から渡す。
 */
export const IncomingArrivalsPanel = ({ arrivalByLot = {}, lots = [], zoneNameOf = null, onClose, now = Date.now(), onDeleteArrival = null, canDelete = false, estimateSecOf = null }) => {
    const [showAll, setShowAll] = useState(false);   // false=これから来る分だけ / true=ぜんぶ
    // ⚠件数は多くて数十件。useMemo は付けない(now が毎回変わるので効かず、読みにくくなるだけ)。
    const all = buildIncomingRows({ arrivalByLot, lots, now });
    const comingN = all.filter(r => r.state === INCOMING_STATE.COMING).length;
    const todayN = all.filter(r => r.aw.when === ARRIVAL_WHEN.TODAY).length;
    const pastN = all.filter(r => r.state === INCOMING_STATE.PAST).length;
    const workingN = all.filter(r => r.state === INCOMING_STATE.WORKING).length;
    // 🚨2026-08-21 清水さん「これから来る分とぜんぶが同じなんだけど、だから必要な情報見るために作ったのに
    //   無駄に多くなってるよ」。原因: ここが外していたのは「もう検査を始めた物」だけで、
    //   **予定超過を外していなかった**。検査中が0件だと両方まったく同じ件数になる(実測 14件 vs 14件)。
    //   → 「これから来る分だけ」は **本当にこれから来る物だけ** にする。
    const rows = showAll ? all : all.filter(r => r.state === INCOMING_STATE.COMING);
    const hiddenN = all.length - rows.length;
    const totalQty = rows.reduce((n, r) => n + (r.qty || 0), 0);
    // ⏱ 処理に要る時間(見込み)。清水さん(2026-08-28)「到着予定のところに到着分を処理するために必要な時間を記載してほしい」。
    //   ・estimateSecOf はアプリごとの「予定工数の親玉」を外から注入(最終=calculateLotEstimatedTimeFI/製品=calculateLotEstimatedTime較正込み)。
    //   ・⚠出すのは **まだ手を付けていないロットだけ**。検査中に満額を出すと「残り」より大きい嘘になる。
    const workRows = estimateSecOf ? rows.filter(r => r.lot && isUntouchedLot(r.lot)) : [];
    const workSec = workRows.reduce((n, r) => n + (Number(estimateSecOf(r.lot)) || 0), 0);
    // 🚚 検査リストに指図が無いまま残り続けている行。3週間前の物が上に積み上がって、
    //   本当に見たい「次に来る物」を押し下げていた。件数を出して、原因が人ではない事を分かるようにする。
    const ghostN = all.filter(r => !r.lot).length;
    // 片付けてよいのは **その行自身が到着予定の原本** の物だけ。
    // 「同じ指図へ広げた分」(_spreadFrom あり)は原本の写しなので、原本を消せば一緒に消える。
    // ⚠ここで写しまで消しに行くと、実在する別の到着予定を巻き込む。
    const ghostDeletable = all.filter(r => !r.lot && !r.spread && r.arr && r.arr.id);

    return (
        <div className="fixed inset-0 z-[95] bg-black/50 flex items-center justify-center p-2 sm:p-4" onClick={onClose}>
            <div className="bg-white w-full max-w-4xl max-h-full rounded-xl shadow-2xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
                <div className="shrink-0 px-4 py-3 bg-teal-600 text-white flex items-center gap-2 flex-wrap">
                    <Truck className="w-5 h-5 shrink-0" />
                    <span className="font-black text-lg">これから来るもの</span>
                    {/* ⚠ 検査が同じ指図の別ロットへ広げた札も混ざるので、「組立からだけ」と言い切らない。 */}
                    <span className="fi-tap-text bg-white/20 rounded-full px-2 py-0.5">組立から知らせてもらった到着予定（＋同じ指図へ広げた分）</span>
                    <button onClick={onClose} className="ml-auto p-1.5 rounded-lg hover:bg-white/20" title="閉じる"><X className="w-5 h-5" /></button>
                </div>
                {/* ⚠何のための窓かを最初に言い切る。押せるものが無いのは「作り忘れ」ではない。 */}
                <div className="shrink-0 px-4 py-2 bg-teal-50 border-b border-teal-200 fi-tap-text text-teal-800">
                    見るための窓です。<b>ここではカードを動かせません</b>。エリアを移しても・検査を始めても、この一覧からは消えません。
                </div>
                <div className="shrink-0 px-4 py-2 border-b border-slate-200 flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-black text-slate-700">
                        これから来る <span className="font-mono text-base text-teal-700">{comingN}</span> 件
                        {todayN > 0 ? <span className="ml-2 text-teal-700">本日 {todayN}</span> : null}
                        {pastN > 0 ? <span className="ml-2 text-amber-700">予定超過 {pastN}</span> : null}
                    </span>
                    <span className="fi-tap-text text-slate-500">（表示中 {rows.length} 件 / 合計 {totalQty} 台）</span>
                    {workSec > 0 && (
                        <span className="fi-tap-text font-black text-teal-800 bg-teal-50 border border-teal-300 rounded px-1.5 py-0.5"
                            title={`目標時間の合計から出した見込みです（実測ではありません）。まだ手を付けていない ${workRows.length}件ぶん。検査中のロットは入れていません。`}>
                            ⏱ 処理に{fmtWorkSec(workSec)}{workRows.length < rows.length ? `（未着手${workRows.length}件ぶん）` : ''}
                        </span>
                    )}
                    {!showAll && hiddenN > 0 && (
                        <button onClick={() => setShowAll(true)} className="fi-tap-text font-bold text-amber-700 bg-amber-50 border border-amber-300 rounded px-2 py-0.5 hover:bg-amber-100">
                            ここに出していない {hiddenN}件（{pastN > 0 ? `予定超過 ${pastN}` : ''}{pastN > 0 && workingN > 0 ? ' / ' : ''}{workingN > 0 ? `検査中 ${workingN}` : ''}）を見る
                        </button>
                    )}
                    <div className="ml-auto flex bg-slate-100 rounded-lg p-0.5">
                        <button onClick={() => setShowAll(false)} className={`px-3 py-1 rounded-md text-xs font-bold ${!showAll ? 'bg-white shadow text-teal-700' : 'text-slate-500'}`}>これから来る分だけ</button>
                        <button onClick={() => setShowAll(true)} className={`px-3 py-1 rounded-md text-xs font-bold ${showAll ? 'bg-white shadow text-teal-700' : 'text-slate-500'}`}>ぜんぶ</button>
                    </div>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
                    {rows.length === 0 && (
                        <div className="text-center text-sm text-slate-400 py-10">
                            {!showAll && all.length > 0
                                ? <>これから来る予定のものは <b className="text-slate-600">ありません</b>。<br />
                                    <span className="fi-tap-text">予定を過ぎた分は「ぜんぶ」で見られます（{pastN}件）。</span></>
                                : <>知らせてもらっている到着予定はありません。<br />
                                    <span className="fi-tap-text">連絡タブの「到着予定を聞く」で、組立へ「いつ来るか」を聞けます。</span></>}
                        </div>
                    )}
                    {showAll && ghostN > 0 && (
                        <div className="fi-tap-text text-slate-600 bg-slate-50 border border-slate-200 rounded p-2 leading-relaxed flex items-start gap-2 flex-wrap">
                            <div className="min-w-0 flex-1">
                                このうち <b>{ghostN}件</b> は「検査リストにこの指図がありません」。到着予定だけが残っていて、
                                検査リストの側に指図が無い状態です。<b>人の操作の問題ではありません</b>。
                                {ghostDeletable.length < ghostN && (
                                    <div className="mt-0.5 text-slate-500">
                                        うち {ghostN - ghostDeletable.length}件 は「同じ指図へ広げた分」なので、元の到着予定を片付けると一緒に消えます。
                                    </div>
                                )}
                            </div>
                            {canDelete && onDeleteArrival && ghostDeletable.length > 0 && (
                                <button
                                    onClick={() => {
                                        const names = ghostDeletable.map(r => `・${r.orderNo || '(指図番号なし)'}  ${r.model || ''}  ${r.aw.label || ''}`).join(String.fromCharCode(10));
                                        if (!window.confirm(`検査リストに指図が無い到着予定 ${ghostDeletable.length}件 を片付けます。

${names}

⚠消えるのは「到着予定」の記録だけです。検査の記録(ロット)には触りません。
よろしいですか？`)) return;
                                        ghostDeletable.forEach(r => onDeleteArrival(r.arr.id));
                                    }}
                                    className="shrink-0 px-3 py-1.5 rounded-lg bg-white border-2 border-slate-400 text-slate-700 text-xs font-black hover:bg-slate-100">
                                    {ghostDeletable.length}件 を片付ける
                                </button>
                            )}
                        </div>
                    )}
                    {rows.map(r => {
                        const zone = (zoneNameOf && r.lot) ? (zoneNameOf(r.lot) || '') : '';
                        return (
                            <div key={r.lotId} className={`border-2 rounded-lg p-2.5 ${CARD_CLS[r.state]}`}>
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span className={`fi-tap-text font-black border rounded px-1.5 py-0.5 shrink-0 ${STATE_CLS[r.state]}`}>{STATE_LABEL[r.state]}</span>
                                    <span className="fi-tap-text font-black text-teal-800 bg-teal-50 border border-teal-300 rounded px-1.5 py-0.5 inline-flex items-center gap-1 shrink-0">
                                        <Clock className="w-3 h-3" />{r.aw.label || '—'}
                                    </span>
                                    <span className="text-xs font-bold text-slate-500 shrink-0">{r.orderNo || '指図なし'}</span>
                                    <span className="text-base font-black text-slate-800 truncate min-w-0 flex-1">{r.model || '型式なし'}</span>
                                    <span className="text-sm font-black text-blue-700 shrink-0 inline-flex items-center gap-1">
                                        <Package className="w-3.5 h-3.5" />{r.qty > 0 ? `${r.qty}台` : '—'}
                                    </span>
                                    {estimateSecOf && r.lot && isUntouchedLot(r.lot) ? (() => {
                                        const s = Number(estimateSecOf(r.lot)) || 0;
                                        return s > 0 ? (
                                            <span className="fi-tap-text font-bold text-teal-800 bg-teal-50 border border-teal-200 rounded px-1.5 py-0.5 shrink-0"
                                                title="この1件を処理するのに要る時間。目標時間の合計から出した見込みです（実測ではありません）">⏱ 処理に{fmtWorkSec(s)}</span>
                                        ) : null;
                                    })() : null}
                                </div>
                                <div className="mt-1 flex items-center gap-2 flex-wrap fi-tap-text text-slate-600">
                                    {r.arr.group && <span className="inline-flex items-center gap-1 bg-white border border-slate-200 rounded px-1.5 py-0.5"><Users className="w-3 h-3" />{r.arr.group}</span>}
                                    {r.arr.by && <span className="text-slate-400">登録: {r.arr.by}</span>}
                                    {/* ⚠ 同じ指図の別ロットへ検査が広げた札。組立が直接この物について言ってきたわけではないので、
                                        見て区別が付くようにする（広げた分は台数・手順名も このロット自身の値だけを出している）。 */}
                                    {r.spread && (
                                        <span className="inline-flex items-center gap-1 font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded px-1.5 py-0.5"
                                            title={`同じ指図の別ロットの到着予定を、検査が入荷時間に反映した時に広げた札です${r.arr._spreadBy ? `（${r.arr._spreadBy}）` : ''}。組立がこのロットについて直接言ってきた物ではありません。`}>
                                            同じ指図から
                                        </span>
                                    )}
                                    {/* 📋手順名は到着予定に入っている時だけ。昔の連絡には入っていないので空のまま出さない。 */}
                                    {r.templateName && <span className="inline-flex items-center gap-1 font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded px-1.5 py-0.5"><ClipboardList className="w-3 h-3" />{r.templateName}</span>}
                                    {r.qtyFromLot && <span className="fi-tap-text text-slate-400">台数は検査リストの値（連絡に台数が入っていません）</span>}
                                    {!r.lot && <span className="fi-tap-text font-bold text-amber-700 bg-amber-100 rounded px-1.5 py-0.5">検査リストにこの指図がありません</span>}
                                    {zone && <span className="ml-auto inline-flex items-center gap-1 text-slate-500"><MapPin className="w-3 h-3" />いまの置き場所: <b>{zone}</b></span>}
                                </div>
                                {/* 分納は便ごとに1行ずつ。どれが着いてどれがこれからかを、この窓だけで分かるようにする。 */}
                                {r.splits.length > 1 && (
                                    <div className="mt-1.5 pt-1.5 border-t border-slate-200 flex flex-wrap gap-1">
                                        <span className="fi-tap-text font-black text-slate-500 mr-1">分納 {r.splits.length}回（合計 {splitTotalQty(r.splits)}台）:</span>
                                        {r.splits.map((s, i) => {
                                            const ms = splitMs(s);
                                            const arrived = ms != null && ms < now;
                                            return (
                                                <span key={`${s.date}T${s.time}-${i}`}
                                                    className={`fi-tap-text font-bold border rounded px-1.5 py-0.5 ${arrived ? 'bg-slate-100 text-slate-500 border-slate-300' : 'bg-teal-50 text-teal-800 border-teal-300'}`}>
                                                    {i + 1}便 {fmtSplitWhen(s)} ×{s.qty}台 {arrived ? '着' : 'これから'}
                                                </span>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
};
