// =============================================================================
//  src/opsim/LotDrawer.jsx — 盤面のカードを押した時だけ出る「引き出し」
// -----------------------------------------------------------------------------
//  🚨 2026-08-30 清水さんの指摘（原文）:
//     「盤面を最初から横幅いっぱいにする / ロットを押した時だけ、右から詳細を開く」
//     それまでは、ロットを1件も選んでいない時でも右側の詳細欄が場所を取り続け、
//     中身は「盤面のカードを押してください」という空の案内だけだった。
//     → 選んでいない間は **1pxも取らない**。押した時だけ、この引き出しが上に重なる。
//
//  🚨🚨 背景を押した時は **閉じるだけ**。何も決めない・何も確定しない。
//     2026-08-21 の事故（モーダルの背景タップが「連絡しない」を確定させ、
//     製品124件中98件・最終68件中68件が取り消せないまま焼き付いた）と
//     **同じ形を二度と作らない**。ここには確定の道が1本も無い。
//
//  ⚠ 閉じる道は3つ（どれも閉じるだけ）: ×ボタン ／ 背景 ／ Esc。
//  ⚠ ×ボタンは中身と一緒に流れない（見出しは shrink-0・中身だけ overflow-y-auto）。
//     中身がどれだけ長くなっても、閉じるボタンが画面の外へ出ない。
//  ⚠ 狭い画面（スマホ）では下から出る。max-h-[85vh] で画面を覆い切らない。
//     広い画面では右から全高で出る。
// =============================================================================
import React, { useEffect } from 'react';
import { X } from 'lucide-react';

/**
 * @param {boolean}  props.open     開いているか
 * @param {string}   props.title    見出し（品目コードなど）
 * @param {string}   props.sub      見出しの下の小さい行
 * @param {Function} props.onClose  閉じる（🚨 閉じるだけ。ここで何かを決めない）
 */
export function LotDrawer({ open = false, title = '', sub = '', onClose = null, children }) {
  // 🚨 hooks は必ずガード（下の `if (!open) return null`）より **上** に置く。
  //   ガードより後ろに hooks を足すと "Rendered fewer hooks" で画面が丸ごと落ちる
  //   （2026-08-27 の事故と同じ形）。
  useEffect(() => {
    if (!open) return undefined;
    if (typeof window === 'undefined') return undefined;
    const onKey = (e) => {
      if (!e) return;
      if (e.key !== 'Escape' && e.key !== 'Esc') return;
      if (typeof onClose === 'function') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  // 🚨 閉じるだけ。ここから確定・送信・取り消しへ行く道は1本も無い。
  const close = () => { if (typeof onClose === 'function') onClose(); };

  return (
    <>
      {/* 背景。押すと閉じるだけ（何も決まらない）。
          🚨 2026-08-30 直した: 前は広い画面でも背景が全面を覆っていたので、
            **盤のカードを押しても1回目は必ず背景に当たって閉じるだけ**になり、
            別のロットを見るのに2回押しが要った（見えていて押せそうな物が裏切る形）。
            広い画面では引き出しは右460pxだけで左の盤は見えているのだから、
            **1回で次のロットへ切り替われる**のが正しい。→ 背景は狭い画面だけに出す。
            広い画面の閉じる道は ✕ と Esc の2つ（どちらも見出しに常に居る）。 */}
      <div
        className="fixed inset-0 z-[300] bg-slate-900/20 md:hidden"
        onClick={close}
        aria-hidden="true"
      />

      {/* 引き出し本体。狭い画面＝下から / 広い画面（768px以上）＝右から全高 */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title || '選んだ仕事の詳しい話'}
        className={[
          'fixed z-[301] flex flex-col bg-white shadow-2xl',
          'inset-x-0 bottom-0 max-h-[85vh] rounded-t-2xl border-t border-violet-300',
          'md:inset-y-0 md:left-auto md:right-0 md:h-full md:max-h-none',
          'md:w-[min(460px,94vw)] md:rounded-t-none md:border-l md:border-t-0 md:border-violet-300',
        ].join(' ')}
      >
        {/* 見出し。⚠ shrink-0 ＝ 中身が長くても、閉じるボタンは必ず画面に残る */}
        <div className="flex shrink-0 items-start gap-2 border-b border-slate-200 bg-white px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-black leading-tight text-slate-800">{title}</div>
            {sub ? <div className="mt-0.5 truncate text-2xs leading-none text-slate-500">{sub}</div> : null}
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="閉じる"
            title="閉じます。閉じても、何かが決まったり送られたりする事はありません。"
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-500 hover:bg-slate-50"
          >
            <X size={18} />
          </button>
        </div>

        {/* 中身。ここだけが流れる */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-2.5">
          {children}
        </div>
      </div>
    </>
  );
}

export default LotDrawer;
