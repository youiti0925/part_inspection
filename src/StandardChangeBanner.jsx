// 📢 「やり方が変わりました」バナー (StandardChangeBanner)
//
// ■ 何の画面か
//   エース動画/作業標準が変わった時(education_events の kind:'standard_change')に、
//   **その工程を過去にやった事のある人にだけ** 横長バナーで知らせる
//   (どれを出すかの選別は domain/educationEvents.js の pendingStandardChanges。
//    経験の判定・期限(maxAgeDays)・並び順は全部そちらが持つ)。
//
// ■ propsの前提(App固有のimportはしない。react + lucide-react + Tailwind のみ)
//   props = { events, lots, workerName }
//   - events: education_events の配列(全kind混在でよい。選別はdomain)。
//   - lots: Firestore 'lots' の配列(「その工程をやった事があるか」の判定材料)。
//   - workerName: いま画面を見ている人の名前。
//
// ■ 既読の決めごと
//   ・「確認した」= localStorage 'standardChangeSeen.v1'(配列・上限200件・古い方から捨てる)。
//     app_notices の appNoticeSeen と同じ流儀 = **端末ごと**。
//     既読は人の判断ではなく表示制御なのでローカルでよい
//     (⚠逆に「人の判断」を端末ローカルに置くのは禁止。2026-07-17の教訓)。
//   ・この部品だけは中で pendingStandardChanges を呼ぶ
//     (seenIds の localStorage 読み書きと一体のため。契約どおり)。
//   ・複数あれば 件数+先頭1件+開閉。無ければ null。
//   ・文字は fi-tap-text 以上のみ。

import React, { useState, useMemo } from 'react';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { pendingStandardChanges } from './domain/educationEvents.js';

export const SEEN_LS_KEY = 'standardChangeSeen.v1';
const SEEN_MAX = 200; // 覚えておく上限(古いものから捨てる。無限に伸ばさない)

// 端末に覚えている「確認した」一覧。⚠壊れていたら空に倒す(画面を止めない)
const readSeen = () => {
    try {
        const v = JSON.parse(window.localStorage.getItem(SEEN_LS_KEY) || '[]');
        return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
    } catch { return []; } // JSONが壊れていても白画面にしない
};

// ms → 'M/D' (無ければ空)
const fmtMD = (ms) => {
    const n = Number(ms) || 0;
    if (n <= 0) return '';
    const d = new Date(n);
    return `${d.getMonth() + 1}/${d.getDate()}`;
};

// どこが変わったかの出どころ札(事実の表示だけ)
const sourceLabelOf = (source) =>
    source === 'video' ? '🎬エース動画' : source === 'workStandard' ? '📘作業標準' : '';

export const StandardChangeBanner = ({ events, lots, workerName }) => {
    // ---- hooks(全部ここ。早期returnより上) ----
    const [seen, setSeen] = useState(readSeen);       // 既読id(この端末)
    const [open, setOpen] = useState(false);          // 2件目以降の開閉
    const [nowMs] = useState(() => Date.now());       // 期限判定の基準(開いた瞬間で固定)

    // 自分宛ての未読だけ(新しい順)。⚠domainがthrowしても空に倒す(バナーで全体を落とさない)
    const pending = useMemo(() => {
        try {
            return pendingStandardChanges({
                events: Array.isArray(events) ? events : [],
                lots: Array.isArray(lots) ? lots : [],
                workerName: String(workerName || '').trim(),
                seenIds: seen,
                nowMs,
            }) || [];
        } catch { return []; } // 壊れた入力でも画面を止めない
    }, [events, lots, workerName, seen, nowMs]);

    // ---- 描画用の小物(hooksではない) ----
    // 「確認した」。⚠localStorageと画面のstateを必ず同時に更新(片方だけだと出っぱなし)
    const markSeen = (id) => {
        if (!id) return;
        setSeen(prev => {
            const next = [...(prev || []).filter(x => x !== id), id].slice(-SEEN_MAX);
            try { window.localStorage.setItem(SEEN_LS_KEY, JSON.stringify(next)); }
            catch { /* 保存に失敗しても表示は続ける */ }
            return next;
        });
    };

    if (pending.length === 0) return null; // 無ければ場所を食わない

    const head = pending[0];
    const rest = pending.slice(1);

    // バナー1行ぶんの中身(先頭と開いた時の2件目以降で共用)
    const renderRow = (ev, isHead) => (
        <div key={ev.id} className={`flex items-center gap-2 flex-wrap ${isHead ? '' : 'border-t border-amber-200 pt-1.5 mt-1.5'}`}>
            <span className="text-xs font-black text-amber-900 whitespace-nowrap shrink-0">📢 やり方が変わりました:</span>
            <span className="text-xs font-bold text-slate-800 min-w-0">
                {ev.stepTitle || ev.stepId || ''}{(ev.stepTitle || ev.stepId) && ev.title ? ' — ' : ''}{ev.title || ''}
            </span>
            {sourceLabelOf(ev.source) ? (
                <span className="fi-tap-text text-amber-700 bg-white/70 border border-amber-200 rounded px-1 py-px whitespace-nowrap shrink-0">
                    {sourceLabelOf(ev.source)}
                </span>
            ) : null}
            {fmtMD(ev.at) ? <span className="fi-tap-text text-amber-700/70 whitespace-nowrap shrink-0">{fmtMD(ev.at)}</span> : null}
            <button
                type="button"
                onClick={() => markSeen(ev.id)}
                className="ml-auto shrink-0 inline-flex items-center gap-1 bg-white hover:bg-amber-100 border-2 border-amber-400 text-amber-900 rounded-lg px-2.5 py-1 fi-tap-text font-black"
                title="この端末では次から出しません(記録は消えません)"
            >
                <Check className="w-3.5 h-3.5" />確認した
            </button>
        </div>
    );

    return (
        <div className="w-full bg-amber-50 border-2 border-amber-300 rounded-xl px-3 py-2">
            <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                    {renderRow(head, true)}
                    {open ? rest.map(ev => renderRow(ev, false)) : null}
                </div>
                {rest.length > 0 ? (
                    <button
                        type="button"
                        onClick={() => setOpen(o => !o)}
                        className="shrink-0 inline-flex items-center gap-0.5 fi-tap-text font-bold text-amber-800 hover:text-amber-950 bg-white/70 border border-amber-300 rounded-lg px-2 py-1 whitespace-nowrap"
                        title={open ? 'たたむ' : '残りも見る'}
                    >
                        {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                        他{rest.length}件
                    </button>
                ) : null}
            </div>
        </div>
    );
};

export default StandardChangeBanner;
