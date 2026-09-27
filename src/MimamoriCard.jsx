// 👀 独り立ち直後の見守りカード (MimamoriCard)
//
// ■ 何の画面か
//   独り立ちしたばかりの人の「最初の数台」を、事実だけで1枚のカードにして
//   先輩(と管理者)が様子を見に行けるようにする。
//   出すのは 工程名・型式・時間・不良の有無 という事実のみ。
//   🚨他人との比べ物・順位・平均比・評価の言葉は一切出さない
//     (見守りは「事実を1枚で見せる」だけ。人を並べ替える画面ではない)。
//
// ■ propsの前提(App固有のimportはしない。react + Tailwind のみ)
//   props = { report, currentUserName, canEdit }
//   - report: domain/educationEvents.js の buildMimamoriReport の結果
//       { cards:[{ worker, graduatedAtMs, senior|null, sinceDays,
//                  items:[{orderNo, model, stepTitle, durationSec, ng, ngReason, endMs}](古い順),
//                  count, ngCount }] }
//     ⚠再計算はここでやらない。親が1回だけ計算して渡す
//       (この部品の中で buildMimamoriReport を呼ぶと、置いた場所の数だけ再計算が走る)。
//   - currentUserName: いま画面を見ている人の名前。
//   - canEdit: 管理者フラグ。true=全カード / false=senior===currentUserName のカードだけ。
//
// ■ 守りの決めごと
//   ・卒業後の記録が0件でもカードは出す(「まだ記録がありません」を見せる=消息不明にしない)。
//   ・見せるカードが1枚も無ければ null(場所を食わない)。
//   ・文字は fi-tap-text 以上のみ。

import React from 'react';

// 秒 → '1時間5分' / '12分34秒' / '40秒' (0以下は '—' = 時間の作り話をしない)
const fmtDurSec = (sec) => {
    const s = Math.floor(Number(sec) || 0);
    if (s <= 0) return '—';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    if (h > 0) return `${h}時間${m > 0 ? `${m}分` : ''}`;
    if (m > 0) return `${m}分${ss > 0 ? `${ss}秒` : ''}`;
    return `${ss}秒`;
};

// ms → 'M/D HH:MM' (無ければ空)
const fmtMDHM = (ms) => {
    const n = Number(ms) || 0;
    if (n <= 0) return '';
    const d = new Date(n);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// 'N日前' (0日は「今日」)
const fmtSinceDays = (days) => {
    const n = Number(days) || 0;
    return n <= 0 ? '今日' : `${n}日前`;
};

export const MimamoriCard = ({ report, currentUserName, canEdit }) => {
    const allCards = (report && Array.isArray(report.cards)) ? report.cards : [];
    const myName = String(currentUserName || '').trim();
    // 管理者は全カード。そうでない人は「自分が横で見た人」のカードだけ
    const cards = canEdit ? allCards : allCards.filter(c => c && String(c.senior || '').trim() === myName && myName !== '');
    if (cards.length === 0) return null; // 場所を食わない

    return (
        <div className="border-2 border-sky-200 bg-sky-50/60 rounded-xl p-3 flex flex-col gap-2.5">
            <div className="text-sm font-black text-sky-900">👀 独り立ち直後の見守り(様子を見に行く)</div>

            {cards.map((c) => {
                const items = Array.isArray(c.items) ? c.items : [];
                return (
                    <div key={`${c.worker}-${c.graduatedAtMs || 0}`} className="bg-white border border-sky-200 rounded-lg p-2.5">
                        {/* 誰が・いつ独り立ちしたか(事実だけ) */}
                        <div className="text-xs font-bold text-slate-800 leading-relaxed">
                            <span className="font-black">{c.worker}</span>さんが独り立ちしました
                            <span className="text-slate-500">({fmtSinceDays(c.sinceDays)})</span>。
                            {items.length > 0 ? (
                                <>
                                    最初の{items.length}台:
                                    {Number(c.count) > items.length ? (
                                        <span className="fi-tap-text text-slate-400 ml-1">(これまで合計{c.count}台)</span>
                                    ) : null}
                                </>
                            ) : null}
                        </div>
                        {c.senior ? (
                            <div className="fi-tap-text text-slate-500 mt-0.5">横で見た先輩: {c.senior}</div>
                        ) : null}

                        {/* 台ごとの事実(古い順)。工程名・型式・時間・不良の有無のみ */}
                        {items.length === 0 ? (
                            <div className="fi-tap-text text-slate-400 mt-1.5">まだ記録がありません</div>
                        ) : (
                            <div className="overflow-x-auto mt-1.5">
                                <table className="w-full border-collapse min-w-[24rem]">
                                    <thead>
                                        <tr className="fi-tap-text text-slate-500 font-bold text-left border-b border-slate-200">
                                            <th className="py-1 pr-2 whitespace-nowrap">いつ</th>
                                            <th className="py-1 pr-2 whitespace-nowrap">工程</th>
                                            <th className="py-1 pr-2 whitespace-nowrap">型式</th>
                                            <th className="py-1 pr-2 whitespace-nowrap text-right">時間</th>
                                            <th className="py-1 whitespace-nowrap">不良</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {items.map((it, i) => (
                                            <tr key={`${it.orderNo || ''}-${it.endMs || 0}-${i}`} className="border-b border-slate-100 align-middle">
                                                <td className="py-1 pr-2 fi-tap-text text-slate-500 font-mono whitespace-nowrap">{fmtMDHM(it.endMs) || '—'}</td>
                                                <td className="py-1 pr-2 fi-tap-text text-slate-700 font-bold max-w-[10rem] truncate" title={it.stepTitle || ''}>{it.stepTitle || '—'}</td>
                                                <td className="py-1 pr-2 fi-tap-text text-slate-700 whitespace-nowrap max-w-[8rem] truncate" title={it.model || ''}>{it.model || '—'}</td>
                                                <td className="py-1 pr-2 fi-tap-text text-slate-700 font-mono text-right whitespace-nowrap">{fmtDurSec(it.durationSec)}</td>
                                                <td className="py-1 whitespace-nowrap">
                                                    {it.ng ? (
                                                        <span className="inline-flex items-center gap-0.5 bg-rose-50 text-rose-700 border border-rose-200 rounded px-1 py-px fi-tap-text font-bold max-w-[10rem]"
                                                            title={it.ngReason || ''}>
                                                            ⚠不良あり{it.ngReason ? <span className="truncate">: {it.ngReason}</span> : null}
                                                        </span>
                                                    ) : (
                                                        <span className="fi-tap-text text-emerald-700">なし</span>
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}

                        {/* カード全体の事実(件数だけ。評価はしない) */}
                        {Number(c.ngCount) > 0 ? (
                            <div className="fi-tap-text text-rose-700 font-bold mt-1">不良 {c.ngCount}件</div>
                        ) : null}
                    </div>
                );
            })}
        </div>
    );
};

export default MimamoriCard;
