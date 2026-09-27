// 📷「小さくしました。この画像でいいですか？」
//
// ⚠⚠ このファイルは **製品検査アプリと最終検査アプリで同一**。片方だけ直すと必ずズレる。
//
// 清水さん(2026-08-10):
//   「基本的なルールを決めて、毎回変更しますか？って聞くのはやめた方が作業者は楽。
//     まあ変更する場合はこの画像でいいですか？って見せた方がいいかな、
//     **見えない画像見せても意味ないから**。」
//
// だから:
//   ・上限の中に収まっている時は **何も出さない**(毎回聞かない)
//   ・小さくした時だけ出す
//   ・⚠**実物を画面いっぱいに大きく**出す。サムネで見せても判断できない。
//   ・元 → 後 のバイト数を必ず添える(数字には出どころを添える)

import React, { useEffect } from 'react';
import { X, Check, RotateCcw, ZoomIn } from 'lucide-react';

export const ShrinkConfirm = ({ open, src, info, label = '', onOk, onRetake }) => {
    // ⚠Escは「これでOK」にしない。押していないのに保存されるのが一番困る。閉じる=撮り直す扱いにもしない。
    useEffect(() => {
        if (!open) return undefined;
        const on = (e) => { if (e.key === 'Enter') onOk && onOk(); };
        window.addEventListener('keydown', on);
        return () => window.removeEventListener('keydown', on);
    }, [open, onOk]);
    if (!open || !src) return null;
    return (
        <div className="fixed inset-0 z-[1250] bg-black/85 flex flex-col" style={{ height: '100dvh' }}>
            <div className="shrink-0 px-4 py-2.5 text-white flex items-center gap-2 flex-wrap">
                <ZoomIn className="w-5 h-5 shrink-0" />
                <span className="font-black text-base">この画像でいいですか？</span>
                {label ? <span className="text-xs text-white/70">{label}</span> : null}
            </div>
            {/* ⚠ここが主役。実物を大きく出す。 */}
            <div className="flex-1 min-h-0 flex items-center justify-center px-3">
                <img src={src} alt="小さくした画像" className="max-w-full max-h-full object-contain rounded-lg bg-white" />
            </div>
            <div className="shrink-0 px-4 py-3" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
                {info?.note && (
                    <div className="text-center text-[13px] font-bold text-amber-200 mb-2">{info.note}</div>
                )}
                <div className="flex items-center gap-2">
                    <button onClick={onRetake}
                        className="px-4 py-3.5 rounded-2xl bg-white/15 hover:bg-white/25 text-white font-black text-sm flex items-center gap-1.5 shrink-0">
                        <RotateCcw className="w-4 h-4" />撮り直す
                    </button>
                    <button onClick={onOk}
                        className="flex-1 py-3.5 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white font-black text-base flex items-center justify-center gap-2">
                        <Check className="w-5 h-5" />これでOK
                    </button>
                </div>
                <div className="text-center fi-tap-text text-white/50 mt-2">
                    決まりより大きい写真だったので小さくしました。読めていればそのままでOKです。
                </div>
            </div>
            <button onClick={onRetake} className="absolute top-2 right-2 p-2 text-white/70 hover:text-white" title="撮り直す"><X className="w-6 h-6" /></button>
        </div>
    );
};

export default ShrinkConfirm;
