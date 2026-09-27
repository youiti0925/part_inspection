// ============================================================================
// 📊 通信量と保存容量の目安表 —「10分とったら / 20分とったら どうなるか」
//
// ⚠⚠ このファイルは **製品検査アプリと最終検査アプリで同一**。片方だけ直すと必ずズレる。
//
// なぜ作ったか(清水さん 2026-08-16):
//   「今の感じだったら、**10分とったら 20分とったらってなったら
//     どれぐらいの表になるのかも表で見れたらいい**なあ、**アプリでも**」
//   「今は作業標準と作業の例として見るなかで、**あまりカクカクだと使えない**のも事実、
//     それでも**あんまり容量使ったらいつか限界くる**のも事実、
//     その辺を**判断するためにも表が必要**」
//   「今の表って**通信容量？保存したときのファイルの容量？両方いるよ**」
//
// だから、この画面が守る事:
//   ① 📶送る通信 と 💾残る容量 を **必ず分けて** 出す。1つの数字に混ぜない。
//   ② 中継(なめらか・コマ送り)は **後に何も残らない**。空欄にせず「0」と言い切る。
//   ③ 💾録画は Drive に **ずっと残る**。しかも **見る人1人ごとに毎回** 同じだけ流れる。
//      → 「いつか限界が来る」のは **残る容量** と **見る通信×人数**。ここを見せる。
//   ④ 数字の出どころ(実測/設定から計算/一般的な目安)を **必ず名乗る**。
//      ⚠「一般的な目安（未実測）」は色を変えて、実測と一目で見分けが付くようにする。
//      ここを混ぜると清水さんが判断を誤る(2026-07-10「推測を事実として出すな」)。
//   ⑤ 横文字を使わない。「1秒に何コマ」「1分に何MB」で言う。
//
// ⚠ 現場はタブレット(指)。押す物は 44px 以上。表は横スクロールの箱の中に入れて、
//   **ページ全体が横に伸びない**ようにする。1列目(行の名前)は貼り付けて残す。
// ⚠ 縦に伸びた時に **一番下が消えない**事(2026-08-05 に前科あり)。
//
// ⚠⚠ 数字はすべて src/domain/liveDataUsage.js(試験あり)から取る。**ここで計算しない**。
// ============================================================================

import React, { useMemo, useState } from 'react';
import { X, BarChart3 } from 'lucide-react';
import {
    usageTable, mbText, SOURCE_LABEL, watchTotalMb, usageWarnings, relayNote, USAGE_MINUTES,
    relayBudgetPlan, relayLastsHours,
} from './domain/liveDataUsage.js';

/** `**ここ**` を太字にして出す。⚠元の言葉(domain側)を書き換えずに見せる為。 */
const Rich = ({ text }) => {
    const parts = String(text == null ? '' : text).split('**');
    return (
        <>
            {parts.map((s, i) => (i % 2 === 1
                ? <b key={i} className="font-black">{s}</b>
                : <span key={i}>{s}</span>))}
        </>
    );
};

/**
 * 数字の出どころの札。
 * ⚠⚠ 「一般的な目安（未実測）」だけ **色を変える**。実測と同じ見た目にしない。
 */
const SourceTag = ({ source }) => {
    const cls = source === 'measured'
        ? 'bg-emerald-100 text-emerald-900 border-emerald-400'
        : source === 'spec'
            ? 'bg-sky-100 text-sky-900 border-sky-400'
            : 'bg-amber-200 text-amber-950 border-amber-600';
    return (
        <span className={`inline-block px-1.5 py-0.5 rounded border fi-tap-text font-black whitespace-nowrap ${cls}`}>
            {source === 'typical' ? '⚠ ' : ''}{SOURCE_LABEL[source] || source}
        </span>
    );
};

/** 1秒あたり何コマか(カクカク具合)。⚠録画は端末まかせなので、無い物は無いと書く。 */
const komaText = (row) => (row && Number.isFinite(row.fps)
    ? `1秒に${row.fps}コマ`
    : '1秒のコマ数はスマホのまま');

/**
 * 📊 本体。どこに置いても使える板(枠は置く側が決める)。
 * @param defaultPeople 何人が見るかの初期値。⚠既定20人(清水さんの話の前提)
 */
export const DataUsageTable = ({ defaultPeople = 20, minutes = USAGE_MINUTES }) => {
    const [people, setPeople] = useState(defaultPeople);
    const [times, setTimes] = useState(1);
    const [pickMin, setPickMin] = useState(10);
    const [metered, setMetered] = useState(false);

    const table = useMemo(() => usageTable(minutes), [minutes]);
    const cols = table.minutes;
    const pick = cols.includes(pickMin) ? pickMin : cols[0];
    // 🔢 その日の枠の逆算。⚠数字はすべて domain 側で作る(この画面で掛け算しない)。
    const plan = useMemo(() => relayBudgetPlan(), []);
    const lasts2 = useMemo(() => relayLastsHours('saving', 2), []);

    // ⚠「いつか限界が来る」のは 残る容量 と 見る通信×人数。ここを数字で名指しする。
    const recRows = table.rows.filter(r => r.kind === 'record');
    const normalRow = recRows.find(r => r.key === 'rec:normal') || recRows[0] || null;
    const normalCell = normalRow ? normalRow.cells.find(c => c.min === pick) : null;
    const keepSumAtPick = recRows.reduce((a, r) => {
        const c = r.cells.find(x => x.min === pick);
        return a + (c ? c.keepMb : 0);
    }, 0);

    // ⚠出すべき注意は domain に持たせてある(画面で文言を作らない)。
    const warnGroups = table.rows
        .filter(r => r.kind === 'live')
        .map(r => ({
            key: r.key,
            label: r.label,
            list: usageWarnings({
                mode: r.key === 'smooth' ? 'smooth' : 'relay',
                speedKey: r.key.startsWith('relay:') ? r.key.slice('relay:'.length) : '',
                minutes: pick,
                metered,
            }),
        }))
        .filter(g => g.list.length > 0);

    const numBox = 'w-20 min-h-[44px] px-2 py-2 rounded-lg border-2 border-slate-300 text-center text-base font-black text-slate-800';

    return (
        <div className="w-full min-w-0 text-slate-800">
            {/* ① 何を見る表なのか。⚠先に言葉で言い切る(表だけ出しても読み方が分からない) */}
            <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 mb-3">
                <div className="text-[13px] font-black mb-1">この表の見方</div>
                <ul className="text-[12px] leading-relaxed space-y-0.5">
                    <li><span className="font-black text-sky-700">📶 送る通信</span>… 撮る側（スマホ）が使う通信量です。</li>
                    <li><span className="font-black text-rose-700">💾 残る容量</span>… <b>あとに残る物</b>です。中継は<b>何も残りません</b>。録画だけ残ります。</li>
                    <li><span className="font-black text-violet-700">👀 見る通信</span>… 見る人ぶんの合計です。<b className="text-rose-700">⚠録画は見るたびに毎回</b>この通信がかかります（1回上げて終わりではありません）。</li>
                    {/* 🚨2026-08-17 追加。ここが無かったので「容量は平気なのに、その日の枠が尽きて
                        検査の記録が保存できない」が起きた。**回数は容量とは別の限界**。 */}
                    <li><span className="font-black text-amber-700">🔢 書き込み回数</span>… <b>Firebaseの1日の枠</b>を使う回数です。
                        <b className="text-rose-700">⚠コマ送りは1枚＝1回</b>。<b>枠を使い切ると、4つのアプリ全部で検査の記録が保存できなくなります。</b></li>
                </ul>
                <div className="mt-2 text-[12px] font-black text-rose-800 bg-rose-50 border border-rose-200 rounded-lg px-2 py-1.5">
                    ⚠ <b>限界は2種類あります。</b>
                    「ためた物」の限界＝💾残る容量 と 👀見る通信×人数（中継はどれだけ使っても残りません）。
                    <b className="text-rose-900">「その日の限界」＝🔢書き込み回数</b>（中継はここだけを食います）。
                </div>
            </div>

            {/* 🔢🚨 その日の枠。⚠**回数だけ出しても判断できない**ので「あと何時間」まで出す */}
            <div className="rounded-xl border-2 border-amber-300 bg-amber-50 p-3 mb-3">
                <div className="text-[13px] font-black text-amber-900 mb-1">
                    🔢 Firebaseの1日の枠（{plan.freeWrites.toLocaleString()}回／日・4つのアプリで分け合っています）
                </div>
                <div className="text-[12px] leading-relaxed text-amber-950">
                    中継に使ってよいのは <b>{plan.budget.toLocaleString()}回</b>までと決めています
                    （残りは検査の作業に要ります）。1日 <b>{plan.targetHours}時間</b> 送るなら、
                    1枚あたり <b>{(plan.minEveryMs / 1000).toFixed(2)}秒</b> より速くできません。
                    → だから既定は <b>2秒ごと</b>です。
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {plan.hoursAt.map(h => (
                        <span key={h.key} className="fi-tap-text font-bold bg-white border border-amber-300 rounded px-2 py-1">
                            {h.label.split('（')[0]}（{(h.everyMs / 1000)}秒ごと）… <b>{h.perHour.toLocaleString()}回/時</b>
                            ・枠で <b>約{h.hours}時間</b>
                        </span>
                    ))}
                </div>
                <div className="mt-1.5 fi-tap-text text-amber-900 leading-snug">
                    ⚠ スマホ<b>2台</b>で同時に送ると半分です（{lasts2.writesPerHour.toLocaleString()}回/時 ＝ 約{lasts2.budgetHours}時間）。
                    ⚠ 録画していない間・PC側が見ていない間・なめらかな中継で映っている間は<b>1枚も送りません</b>
                    （画角合わせの{plan.previewFrames}枚だけ送ります）。
                </div>
            </div>

            {/* ② つまみ。⚠指で押す物は44px以上 */}
            <div className="flex flex-wrap items-center gap-2 mb-3">
                <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[12px] font-black text-slate-600">だいたい</span>
                    {cols.map(m => (
                        <button key={m} type="button" onClick={() => setPickMin(m)}
                            className={`min-h-[44px] min-w-[56px] px-2 rounded-lg text-sm font-black border-2 ${m === pick
                                ? 'bg-indigo-600 border-indigo-700 text-white'
                                : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'}`}>
                            {m}分
                        </button>
                    ))}
                    <span className="text-[12px] font-black text-slate-600">撮るつもり</span>
                </div>
                <div className="flex items-center gap-1.5">
                    <span className="text-[12px] font-black text-slate-600">👀 この動画を</span>
                    <input type="number" inputMode="numeric" min="0" max="999" value={people}
                        onChange={(e) => setPeople(Math.max(0, Math.min(999, Math.round(Number(e.target.value) || 0))))}
                        className={numBox} aria-label="見る人数" />
                    <span className="text-[12px] font-black text-slate-600">人が</span>
                    <input type="number" inputMode="numeric" min="1" max="99" value={times}
                        onChange={(e) => setTimes(Math.max(1, Math.min(99, Math.round(Number(e.target.value) || 1))))}
                        className={numBox} aria-label="1人が見る回数" />
                    <span className="text-[12px] font-black text-slate-600">回ずつ見たら</span>
                </div>
                <button type="button" onClick={() => setMetered(v => !v)}
                    className={`min-h-[44px] px-3 rounded-lg text-[12px] font-black border-2 ${metered
                        ? 'bg-amber-500 border-amber-700 text-white'
                        : 'bg-white border-slate-300 text-slate-600'}`}>
                    {metered ? '☑' : '☐'} 使い放題でない回線
                </button>
            </div>

            {/*
              ③ 表そのもの。
              ⚠ 横にも縦にも、この箱の中だけでスクロールさせる(ページごと横に伸ばさない)。
              ⚠ max-h を付けて、縦に伸びた時に一番下が消えないようにする。
              ⚠ 1列目と1行目は貼り付けて残す(どの行のどの時間か分からなくなる為)。
            */}
            <div className="overflow-auto max-h-[58vh] border-2 border-slate-300 rounded-xl bg-white">
                <table className="min-w-max w-full border-collapse text-[12px]">
                    <thead>
                        <tr>
                            <th className="sticky left-0 top-0 z-30 bg-slate-200 border-b-2 border-r-2 border-slate-300 px-2 py-2 text-left font-black min-w-[220px]">
                                何を選ぶか
                            </th>
                            {cols.map(m => (
                                <th key={m}
                                    className={`sticky top-0 z-20 border-b-2 border-slate-300 px-3 py-2 text-center font-black whitespace-nowrap ${m === pick ? 'bg-indigo-100 text-indigo-900' : 'bg-slate-200'}`}>
                                    {m}分
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {table.rows.map((row, ri) => {
                            const isRec = row.kind === 'record';
                            const headBg = isRec ? 'bg-rose-50' : 'bg-white';
                            return (
                                <tr key={row.key} className={ri % 2 ? 'bg-slate-50/60' : ''}>
                                    <th scope="row"
                                        className={`sticky left-0 z-10 ${headBg} border-b border-r-2 border-slate-300 px-2 py-2 text-left align-top min-w-[220px] max-w-[300px]`}>
                                        <div className="font-black text-[13px] leading-tight">{row.label}</div>
                                        <div className="fi-tap-text text-slate-600 mt-0.5">{komaText(row)}</div>
                                        <div className="mt-1"><SourceTag source={row.source} /></div>
                                        <div className="fi-tap-text text-slate-600 mt-1 leading-snug whitespace-normal">
                                            <Rich text={row.note} />
                                        </div>
                                        {!isRec && row.cells[0] && row.cells[0].keepMb > 0 && (
                                            <div className="fi-tap-text text-slate-500 mt-1 leading-snug whitespace-normal">
                                                （送っている間だけ下書きが {mbText(row.cells[0].keepMb)} 置かれますが、終わると消えます）
                                            </div>
                                        )}
                                    </th>
                                    {row.cells.map(c => (
                                        <td key={c.min}
                                            className={`border-b border-slate-200 px-3 py-2 text-right align-top whitespace-nowrap ${c.min === pick ? 'bg-indigo-50' : ''}`}>
                                            <div className="text-sky-800 font-black">📶 {mbText(c.netMb)}</div>
                                            <div className={isRec ? 'text-rose-700 font-black' : 'text-slate-400 font-bold'}>
                                                💾 {isRec ? mbText(c.keepMb) : '0（何も残りません）'}
                                            </div>
                                            <div className="text-violet-800 font-bold">
                                                👀 {mbText(watchTotalMb(c.viewMb, people, times))}
                                            </div>
                                            {/* 🔢🚨 その日の枠。⚠通信量と容量だけでは「その日止まる」が読めない */}
                                            <div className={Number(c.writes) > 0 ? 'text-amber-800 font-black' : 'text-slate-400 font-bold'}>
                                                🔢 {Number(c.writes) > 0
                                                    ? `${Number(c.writes).toLocaleString()}回（枠の${Math.round((Number(c.writes) / plan.budget) * 100)}%）`
                                                    : '0回'}
                                            </div>
                                        </td>
                                    ))}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {/* ④ いちばん見落とされる所を、表の外にもう一度、言葉で書く */}
            {normalCell && (
                <div className="mt-3 rounded-xl border-2 border-rose-300 bg-rose-50 p-3">
                    <div className="text-[13px] font-black text-rose-900 mb-1">⚠ ここが見落とされます</div>
                    <div className="text-[12px] leading-relaxed text-rose-950">
                        <b>{pick}分</b>の{normalRow.label.replace('💾 録画 ', '')}を <b>{people}人</b>が
                        <b>{times}回ずつ</b>見ると、通信は <b className="text-base">{mbText(watchTotalMb(normalCell.viewMb, people, times))}</b> になります。
                        <br />
                        動画そのものは <b>{mbText(normalCell.keepMb)}</b> ですが、
                        <b className="text-rose-800">見るたびに毎回、同じだけ流れます</b>（1回上げて終わりではありません）。
                    </div>
                    <div className="text-[12px] leading-relaxed text-rose-950 mt-1.5 pt-1.5 border-t border-rose-200">
                        4つの画質で <b>{pick}分</b> ずつ撮ると、Drive に <b>{mbText(keepSumAtPick)}</b> がずっと残ります。
                        中継はどれだけ使っても <b>0</b> です。
                    </div>
                </div>
            )}

            {/* ⑤ 選び方の注意(domain が決めた物だけ出す) */}
            {warnGroups.length > 0 && (
                <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3">
                    <div className="text-[13px] font-black text-amber-900 mb-1">⚠ {pick}分 のときの注意</div>
                    <div className="space-y-1.5">
                        {warnGroups.map(g => (
                            <div key={g.key} className="text-[12px]">
                                <div className="font-black text-amber-900">{g.label}</div>
                                <ul className="ml-3 list-disc text-amber-950 leading-relaxed">
                                    {g.list.map((w, i) => <li key={i}>{w}</li>)}
                                </ul>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* ⑥ 数字の出どころ。⚠ここを省くと「測った物」と思われる */}
            <div className="mt-3 fi-tap-text text-slate-600 leading-relaxed space-y-1">
                <div>{relayNote()}</div>
                <div>
                    <SourceTag source="measured" /> …このアプリで実際に測った数字です。
                    <span className="mx-1">/</span>
                    <SourceTag source="spec" /> …設定してある画質から算数で出した数字です（実ファイルを測った物ではありません）。
                    <span className="mx-1">/</span>
                    <SourceTag source="typical" /> …<b className="text-amber-900">一般に言われている値で、まだ実測していません</b>。実際に繋いで測るまでは目安です。
                </div>
                <div>MB・GB は端末の画面と同じ数え方（1024）です。通信会社の言う「GB」とは少し違います。</div>
            </div>
        </div>
    );
};

/** 📊 いつでも開ける全画面の表。⚠一番下が消えないよう、中身側だけをスクロールさせる。 */
export const DataUsageModal = ({ open, onClose, title = '📊 通信量と保存容量の目安表' }) => {
    if (!open) return null;
    return (
        <div className="fixed inset-0 z-[1300] bg-black/60 flex flex-col" style={{ height: '100dvh' }}>
            <div className="m-auto w-full max-w-5xl max-h-full bg-white rounded-2xl shadow-2xl flex flex-col min-h-0 overflow-hidden">
                <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-slate-200">
                    <BarChart3 className="w-5 h-5 text-indigo-600 shrink-0" />
                    <div className="min-w-0">
                        <div className="font-black text-base leading-tight truncate">{title}</div>
                        <div className="fi-tap-text text-slate-500 leading-tight">10分・20分…と撮ったら、通信と容量がどれだけ要るか</div>
                    </div>
                    <button type="button" onClick={onClose}
                        className="ml-auto shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg hover:bg-slate-100"
                        title="閉じる" aria-label="閉じる">
                        <X className="w-6 h-6 text-slate-600" />
                    </button>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto p-3">
                    <DataUsageTable />
                </div>
                <div className="shrink-0 px-4 py-2.5 border-t border-slate-200"
                    style={{ paddingBottom: 'max(0.625rem, env(safe-area-inset-bottom))' }}>
                    <button type="button" onClick={onClose}
                        className="w-full min-h-[44px] rounded-xl bg-slate-700 hover:bg-slate-800 text-white font-black text-sm">
                        閉じる
                    </button>
                </div>
            </div>
        </div>
    );
};

/**
 * 📊 表を開くボタン(押す物+中身を1組で持つ)。
 * ⚠置く側は、これを1つ書くだけでよい。開け閉めの状態を持たせない。
 */
export const DataUsageOpenButton = ({
    label = '📊 通信量と保存容量の目安',
    className = 'min-h-[44px] px-3 rounded-lg bg-indigo-50 hover:bg-indigo-100 border-2 border-indigo-300 text-indigo-800 text-xs font-black',
    title = '10分・20分…と撮ったら、通信と容量がどれだけ要るかの表を開きます',
}) => {
    const [open, setOpen] = useState(false);
    return (
        <>
            <button type="button" onClick={() => setOpen(true)} className={className} title={title}>
                {label}
            </button>
            <DataUsageModal open={open} onClose={() => setOpen(false)} />
        </>
    );
};

export default DataUsageTable;
