// 🎓 卒業の直後に出す1枚「独り立ちの記録を残しますか？」 (SignoffModal)
//
// ■ 何の画面か
//   作業者が🎓教育中の印を外れた(=独り立ちした)直後に、その場の記憶が新しいうちに
//   「横で見た先輩」と「そのロット」をひと押しで残してもらう窓。
//   保存先は education_events(追記型。1出来事=1ドキュメント)。docの組み立ては
//   domain/educationEvents.js の buildSignoffDoc に任せる(このファイルは選ぶだけ)。
//
// ■ propsの前提(App固有のimportはしない。react + lucide-react + Tailwind のみ)
//   props = { worker, workers, lots, onSave, onClose }
//   - worker: 卒業した人。名前の文字列(防御で {name} のオブジェクトも受ける)。
//   - workers: [{id, name, trainee?}]。先輩チップの候補(worker本人はここで除く)。
//   - lots: Firestore 'lots' の配列。「そのロット」チップは
//     recentLotsOfWorker(その人のtask.workerNameが付いた完了/進行ロット)で出す。
//   - onSave: (doc)=>void。buildSignoffDoc の返り値をそのまま渡す(保存の配線は親)。
//   - onClose: ()=>void。窓を閉じるだけ(保存はしない)。
//   - by: 仕様外の任意prop。操作した人の名前。渡されなければ worker 本人
//     (卒業の直後は本人が画面の前に居るのが普通)。
//
// ■ 守りの決めごと
//   🚨背景タップで確定しない。閉じるだけ・何も保存しない
//     (2026-08-21「背景タップのdeclineが焼き付き、完了連絡が一度も飛ばなかった」の教訓。
//      「押していないのに保存された」を構造で防ぐ)。Escも同じく閉じるだけ。
//   ⚠窓は max-h-[80vh] + 中身だけスクロール。ボタンが画面の外に出ない
//     (2026-08-21に max-h 無しでボタンが画面外に出た窓が3種あった)。
//   ⚠「残す」は先輩を選んでいる時だけ活性(空のdocを作らせない)。
//   ⚠nowMs/rand はこの画面側の Date.now()/Math.random()(domainは純関数のまま)。
//   文字は fi-tap-text 以上のみ。

import React, { useState, useEffect, useMemo } from 'react';
import { GraduationCap, Check, X, Package } from 'lucide-react';
import { buildSignoffDoc, recentLotsOfWorker } from './domain/educationEvents.js';
// 💾 保存を少しだけ待って「閉じてよいか」を決める(2026-08-17 の是正。判定は domain 側の1か所)。
import { settleSaveBriefly, mayCloseAfterSave } from './domain/settleSave.js';

// ms → 'M/D' (ロットチップの「いつ触ったか」用。無ければ空)
const fmtMD = (ms) => {
    const n = Number(ms) || 0;
    if (n <= 0) return '';
    const d = new Date(n);
    return `${d.getMonth() + 1}/${d.getDate()}`;
};

export const SignoffModal = ({ worker, workers, lots, onSave, onClose, by = null }) => {
    // ---- hooks(全部ここ。条件付き禁止・早期returnより後ろに置かない) ----
    const [senior, setSenior] = useState('');   // 選んだ先輩の名前('' = 未選択)
    const [selLotId, setSelLotId] = useState(''); // 選んだロットのid('' = 選ばない。任意)
    const [note, setNote] = useState('');       // ひとことメモ(任意)
    const [errMsg, setErrMsg] = useState('');   // 残せなかった時の理由(白画面にしない)

    // Esc = 閉じるだけ(⚠保存はしない。背景タップと同じ扱い)
    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape' && onClose) onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    // 卒業した人の名前(文字列 or {name} の防御)
    const workerName = String(
        (typeof worker === 'string' ? worker : (worker && worker.name) || '') || ''
    ).trim();

    // 先輩チップの候補 = workers から worker 本人を除いた一覧
    const seniorList = useMemo(() => {
        const src = Array.isArray(workers) ? workers : [];
        return src
            .map(w => (typeof w === 'string' ? { id: w, name: w } : w))
            .filter(w => w && String(w.name || '').trim() && String(w.name).trim() !== workerName);
    }, [workers, workerName]);

    // 「そのロット」チップの候補(最近その人が触ったロット。新しい順)
    // ⚠domainが想定外の入力でthrowしても窓ごと落とさない(空に倒す)
    const recentLots = useMemo(() => {
        try {
            return recentLotsOfWorker({ lots: Array.isArray(lots) ? lots : [], workerName }) || [];
        } catch { return []; } // 壊れた入力でも画面を止めない
    }, [lots, workerName]);

    // ---- ここから描画用の小物(hooksではない) ----
    const selLot = recentLots.find(l => l.lotId === selLotId) || null;
    const canKeep = !!senior && !!workerName;

    // 「残す」: doc を組み立てて親へ。⚠throwしたら理由を出して窓は開いたまま
    const handleKeep = async () => {
        if (!canKeep) return;
        try {
            const doc = buildSignoffDoc({
                worker: workerName,
                senior,
                lotId: selLot ? (selLot.lotId || '') : '',
                orderNo: selLot ? (selLot.orderNo || '') : '',
                by: String(by || workerName).trim(),
                nowMs: Date.now(),
                rand: Math.random().toString(36).slice(2) || '0', // ⚠文字列で渡す。万一0が出ても空文字にしない(domainは空randをthrowする)
                note,
            });
            // 🚨 保存を投げっぱなしにして閉じない(2026-08-30)。拒否されたら窓を開けたままにする。
            //   閉じた瞬間に、この独り立ちの記録はどこにも残らない(2026-08-17 と同じ形)。
            const r = await settleSaveBriefly(onSave ? onSave(doc) : null);
            if (!mayCloseAfterSave(r)) {
                setErrMsg('🚨 残せませんでした（保存が拒否されました）。この窓は閉じません。通信を確かめて、もう一度押してください。');
                return;
            }
            if (onClose) onClose();
        } catch (err) {
            setErrMsg(`残せませんでした: ${(err && err.message) || String(err)}`);
        }
    };

    return (
        // 🚨背景タップ = 閉じるだけ。何も保存しない(確定を背景に置かない)
        <div
            className="fixed inset-0 z-[1200] bg-black/50 flex items-center justify-center p-3"
            onClick={() => { if (onClose) onClose(); }}
        >
            <div
                className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden"
                onClick={(e) => e.stopPropagation()}
            >
                {/* 見出し(shrink-0で常に見える) */}
                <div className="shrink-0 px-4 py-3 bg-emerald-50 border-b-2 border-emerald-200 flex items-center gap-2">
                    <GraduationCap className="w-5 h-5 text-emerald-700 shrink-0" />
                    <div className="min-w-0">
                        <div className="font-black text-emerald-900 text-sm truncate">
                            {workerName ? `${workerName}さんが独り立ちしました` : '独り立ちしました'}
                        </div>
                        <div className="fi-tap-text text-emerald-700">横で見た先輩を残しておけます(あとからでも大丈夫)</div>
                    </div>
                    <button
                        type="button"
                        onClick={() => { if (onClose) onClose(); }}
                        className="ml-auto p-1.5 text-emerald-700/60 hover:text-emerald-900 shrink-0"
                        title="閉じる(何も残さない)"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* 中身(ここだけスクロール。ボタンは下に固定) */}
                <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col gap-3">
                    {/* 横で見た先輩(必須。選ぶまで「残す」は押せる状態にしない) */}
                    <div>
                        <div className="text-xs font-black text-slate-700 mb-1.5">横で見た先輩 <span className="text-rose-600">*</span></div>
                        {seniorList.length === 0 ? (
                            <div className="fi-tap-text text-slate-400">先輩の候補が見つかりません(作業者の登録を確かめてください)</div>
                        ) : (
                            <div className="flex flex-wrap gap-1.5">
                                {seniorList.map(w => {
                                    const name = String(w.name).trim();
                                    const on = senior === name;
                                    return (
                                        <button
                                            key={w.id || name}
                                            type="button"
                                            onClick={() => setSenior(on ? '' : name)}
                                            className={`px-2.5 py-1.5 rounded-full border-2 text-xs font-bold transition-all ${on
                                                ? 'bg-emerald-600 border-emerald-700 text-white shadow'
                                                : 'bg-white border-slate-300 text-slate-700 hover:border-emerald-400'}`}
                                        >
                                            {on ? '✓ ' : ''}{name}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    {/* そのロット(任意。もう一度タップで解除) */}
                    <div>
                        <div className="text-xs font-black text-slate-700 mb-1.5 flex items-center gap-1">
                            <Package className="w-3.5 h-3.5" />そのロット <span className="fi-tap-text text-slate-400 font-normal">(任意)</span>
                        </div>
                        {recentLots.length === 0 ? (
                            <div className="fi-tap-text text-slate-400">最近のロットが見つかりません(選ばなくても残せます)</div>
                        ) : (
                            <div className="flex flex-wrap gap-1.5">
                                {recentLots.map(l => {
                                    const on = selLotId === l.lotId;
                                    return (
                                        <button
                                            key={l.lotId}
                                            type="button"
                                            onClick={() => setSelLotId(on ? '' : l.lotId)}
                                            className={`px-2.5 py-1.5 rounded-lg border-2 text-left transition-all ${on
                                                ? 'bg-blue-600 border-blue-700 text-white shadow'
                                                : 'bg-white border-slate-300 text-slate-700 hover:border-blue-400'}`}
                                        >
                                            <span className="text-xs font-bold">{on ? '✓ ' : ''}{l.orderNo || l.lotId}</span>
                                            <span className={`fi-tap-text ml-1 ${on ? 'text-blue-100' : 'text-slate-500'}`}>
                                                {l.model || ''}{fmtMD(l.lastMs) ? ` ・${fmtMD(l.lastMs)}` : ''}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    {/* ひとことメモ(任意) */}
                    <div>
                        <div className="text-xs font-black text-slate-700 mb-1.5">ひとこと <span className="fi-tap-text text-slate-400 font-normal">(任意)</span></div>
                        <input
                            type="text"
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            placeholder="例: 外観のコツを教わった"
                            className="w-full border-2 border-slate-300 rounded-lg px-2.5 py-2 text-sm focus:border-emerald-500 outline-none"
                        />
                    </div>

                    {errMsg ? (
                        <div className="fi-tap-text font-bold text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-2.5 py-1.5">{errMsg}</div>
                    ) : null}

                    <div className="fi-tap-text text-slate-500">記録は教育のためだけに使います</div>
                </div>

                {/* ボタン(shrink-0。max-h-[80vh]でも必ず画面内) */}
                <div className="shrink-0 px-4 py-3 border-t border-slate-200 flex items-center gap-2 bg-white">
                    <button
                        type="button"
                        onClick={() => { if (onClose) onClose(); }}
                        className="px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 border border-slate-300 text-slate-600 font-bold text-sm shrink-0"
                    >
                        あとで(残さない)
                    </button>
                    <button
                        type="button"
                        onClick={handleKeep}
                        disabled={!canKeep}
                        className={`flex-1 py-2.5 rounded-xl font-black text-sm flex items-center justify-center gap-1.5 transition-all ${canKeep
                            ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow'
                            : 'bg-slate-200 text-slate-400'}`}
                        title={canKeep ? 'この内容で残す' : '先輩を選ぶと押せます'}
                    >
                        <Check className="w-4 h-4" />残す
                    </button>
                </div>
            </div>
        </div>
    );
};

export default SignoffModal;
