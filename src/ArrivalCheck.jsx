// 🚚 到着チェック（来た / 来ない）と、班ごとのクセ。
//
// ⚠⚠ このファイルは **製品検査アプリと最終検査アプリで同一**。片方だけ直すと必ずズレる。
//   中身の決まりごとは src/domain/arrivalActual.js（保存・購読はここに書かない）。
//
// ⚠⚠⚠ **この画面は検査側だけのもの。組立ポータルには絶対に出さない。**
//   清水さん「これはあくまで検査側の予測だけで使うやつで、他に見せることはしない」。
//   保存先も組立が読まない棚(arrival_actuals)。連絡の棚には1バイトも書かない。

import React, { useMemo, useState } from 'react';
import { Truck, Check, Bell, TrendingUp, Undo2, Info } from 'lucide-react';
import {
    CHECK_STATE, buildCheckList, checkCounts, groupTrends, trendLabel,
    MIN_SAMPLES, remindMessage, buildActual, actualsByKey,
} from './domain/arrivalActual.js';

const fmtHM = (ms) => {
    if (!ms) return '';
    const d = new Date(ms);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const fmtMin = (m) => {
    if (m == null) return '';
    const a = Math.abs(m);
    const s = a >= 60 ? `${Math.floor(a / 60)}時間${a % 60 ? `${a % 60}分` : ''}` : `${a}分`;
    return m > 0 ? `${s} 遅れ` : m < 0 ? `${s} 早い` : '時間どおり';
};

const STATE_CLS = {
    [CHECK_STATE.LATE]: 'border-rose-300 bg-rose-50',
    [CHECK_STATE.SOON]: 'border-amber-300 bg-amber-50',
    [CHECK_STATE.FUTURE]: 'border-slate-200 bg-white',
    [CHECK_STATE.DONE]: 'border-emerald-200 bg-emerald-50/50',
};

/**
 * @param items    [{ lotId, orderNo, model, group, date, time, qty, plannedTs }] 便ごとに1行
 * @param actuals  arrival_actuals の一覧
 * @param onCheck  (row, actualTs) => Promise  「着いた」を記録する
 * @param onUndo   (row) => Promise            押し間違いを取り消す
 * @param onRemind (row) => Promise            催促を送る(既存の連絡機能へ)
 */
export const ArrivalCheckPanel = ({ items = [], actuals = [], onCheck, onUndo, onRemind, now = Date.now() }) => {
    const [tab, setTab] = useState('check');   // check=来た/来ない / trend=傾向
    const [busy, setBusy] = useState('');
    const map = useMemo(() => actualsByKey(actuals), [actuals]);
    const rows = useMemo(() => buildCheckList({ items, actuals: map, now }), [items, map, now]);
    const counts = useMemo(() => checkCounts(rows), [rows]);
    const trends = useMemo(() => groupTrends({ rows: actuals }), [actuals]);

    const doCheck = async (r, ts) => {
        setBusy(r.id);
        try { await onCheck(r, ts); }
        catch (e) { alert(`記録できませんでした。\n${e?.message || e}`); }   // ⚠握りつぶさない
        finally { setBusy(''); }
    };

    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 flex-wrap">
                <div className="text-sm font-black text-slate-700 flex items-center gap-1.5"><Truck className="w-4 h-4 text-teal-600" />到着チェック</div>
                {[['check', `来た / 来ない${counts.late > 0 ? ` ・遅れ ${counts.late}` : ''}`], ['trend', '班ごとのクセ']].map(([id, lbl]) => (
                    <button key={id} onClick={() => setTab(id)}
                        className={`px-3 py-1.5 rounded-full text-xs font-black border ${tab === id ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'}`}>{lbl}</button>
                ))}
                {/* ⚠この画面の性質を毎回その場に書いておく。あとから見た人が相手に見せてしまわないように。 */}
                <span className="ml-auto fi-tap-text text-slate-400 flex items-center gap-1"><Info className="w-3 h-3" />検査グループだけの画面です（組立には出ません）</span>
            </div>

            {tab === 'check' ? (
                <>
                    <div className="flex items-center gap-2 flex-wrap fi-tap-text font-bold">
                        <span className="rounded-full px-2 py-1 bg-rose-100 text-rose-700">予定を過ぎた {counts.late}</span>
                        <span className="rounded-full px-2 py-1 bg-amber-100 text-amber-700">もうすぐ {counts.soon}</span>
                        <span className="rounded-full px-2 py-1 bg-emerald-100 text-emerald-700">確認済み {counts.done}</span>
                    </div>
                    <div className="flex flex-col gap-1.5">
                        {rows.map(r => (
                            <div key={r.id} className={`border rounded-2xl px-3 py-2 flex items-center gap-2 flex-wrap ${STATE_CLS[r.state]}`}>
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-baseline gap-2 flex-wrap">
                                        <span className="font-mono font-black text-slate-800">{r.orderNo}</span>
                                        <span className="font-bold text-slate-700 truncate">{r.model}</span>
                                        {r.qty > 0 && <span className="text-xs text-slate-500">{r.qty}台</span>}
                                        {r.group && <span className="fi-tap-text bg-white/70 border border-slate-200 rounded px-1.5 py-0.5 text-slate-600">{r.group}</span>}
                                    </div>
                                    <div className="fi-tap-text text-slate-500 mt-0.5 flex items-center gap-2 flex-wrap">
                                        <span>予定 {fmtHM(r.planned)}</span>
                                        {r.state === CHECK_STATE.LATE && <span className="font-black text-rose-700">{fmtMin(r.lateMin)}（まだ確認していません）</span>}
                                        {r.state === CHECK_STATE.DONE && <span className="font-black text-emerald-700">着 {fmtHM(r.actualTs)}・{fmtMin(r.diffMin)}</span>}
                                    </div>
                                </div>
                                {r.state === CHECK_STATE.DONE ? (
                                    <button onClick={() => onUndo && onUndo(r)} title="押し間違いを取り消す"
                                        className="px-2.5 py-1.5 rounded-lg fi-tap-text font-black border bg-white text-slate-400 border-slate-200 hover:border-slate-400 flex items-center gap-1">
                                        <Undo2 className="w-3.5 h-3.5" />取り消す
                                    </button>
                                ) : (
                                    <div className="flex items-center gap-1.5 shrink-0">
                                        {/* ⚠既定は「今」。あとから気づいた時のために、予定時刻ちょうどでも入れられるようにする */}
                                        <button onClick={() => doCheck(r, Date.now())} disabled={busy === r.id}
                                            className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white text-xs font-black flex items-center gap-1.5">
                                            <Check className="w-4 h-4" />{busy === r.id ? '記録中' : '着いた（今）'}
                                        </button>
                                        <button onClick={() => doCheck(r, r.planned)} disabled={busy === r.id || !r.planned} title="予定の時刻ちょうどに着いた（あとから記録するとき）"
                                            className="px-2.5 py-2 rounded-xl bg-white border border-slate-300 text-slate-600 fi-tap-text font-black disabled:opacity-40">予定どおり</button>
                                        {r.state === CHECK_STATE.LATE && onRemind && (
                                            <button onClick={() => onRemind(r)} title={remindMessage(r)}
                                                className="px-2.5 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white fi-tap-text font-black flex items-center gap-1">
                                                <Bell className="w-3.5 h-3.5" />催促
                                            </button>
                                        )}
                                    </div>
                                )}
                            </div>
                        ))}
                        {rows.length === 0 && (
                            <div className="text-center text-sm text-slate-400 py-10 border border-dashed border-slate-200 rounded-2xl">
                                いま確認する到着予定はありません
                            </div>
                        )}
                    </div>
                </>
            ) : (
                <div className="flex flex-col gap-2">
                    <div className="fi-tap-text text-slate-500 bg-slate-50 rounded-xl px-3 py-2 leading-relaxed">
                        教えてもらった時刻と、実際に着いた時刻のズレです。<b>プラス＝遅れ / マイナス＝早い</b>。
                        1回だけの大きな遅れに引っぱられないよう<b>中央値</b>で出しています。
                        <b>{MIN_SAMPLES}件たまるまでは数字を出しません</b>（少ない回数で決めつけると、それを見て組んだ段取りが外れるため）。
                    </div>
                    {trends.map(t => (
                        <div key={t.group} className={`border rounded-2xl px-3 py-2.5 ${t.enough ? 'border-slate-200 bg-white' : 'border-dashed border-slate-200 bg-slate-50'}`}>
                            <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-black text-slate-800">{t.group}</span>
                                {t.enough ? (
                                    <span className={`text-sm font-black flex items-center gap-1 ${t.median > 5 ? 'text-rose-700' : t.median < -5 ? 'text-sky-700' : 'text-emerald-700'}`}>
                                        <TrendingUp className="w-4 h-4" />{trendLabel(t)}
                                    </span>
                                ) : (
                                    <span className="text-sm font-bold text-slate-400">まだ分かりません（あと {MIN_SAMPLES - t.n}件）</span>
                                )}
                                <span className="ml-auto fi-tap-text text-slate-400">{t.n}件</span>
                            </div>
                            {t.enough && (
                                <div className="fi-tap-text text-slate-500 mt-1 flex items-center gap-2 flex-wrap">
                                    <span>ばらつき {fmtMin(t.p25)} 〜 {fmtMin(t.p75)}</span>
                                    <span>／ 時間どおり {t.onTime} ・ 遅れ {t.late} ・ 早い {t.early}</span>
                                </div>
                            )}
                        </div>
                    ))}
                    {trends.length === 0 && (
                        <div className="text-center text-sm text-slate-400 py-10 border border-dashed border-slate-200 rounded-2xl">
                            まだ記録がありません。「来た / 来ない」で着いた時刻を押していくと、ここに出ます。
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

// ⚠ buildActual は domain/arrivalActual.js から直接 import すること
//   (画面ファイルから再輸出すると、部品と道具が混ざって差し替えづらくなる)。
export default ArrivalCheckPanel;
