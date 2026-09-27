// ============================================================================
// P062 / P114 ロットが上限で溢れた時・過去を取り寄せている時の札(製品 App.jsx の取り寄せの帯と同じ形)。
//   ⚠ 黙って数字を少ないまま見せないための物。判定は domain/readBudget.js の lotsOverflowOf だけ。
//   ⚠ 浮かせない(fixed にしない)。列の一番上に流し込む。押す物が在る時(failed)だけ幅いっぱい。
// ============================================================================
import React from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';

const pill = 'shrink-0 w-fit max-w-full ml-3 my-1 rounded-lg px-4 py-2 text-white flex items-center gap-2 text-sm font-bold shadow-md';

export default function LotsReadNotice({
  overflow, archiveState, historyScreen, openScreen,
  historyLimit, openLimit, archiveLimit, onRetry,
}) {
  if (!overflow) return null;
  const out = [];
  if (openScreen && overflow.openCapped) {
    out.push(
      <div key="open" className={`${pill} bg-amber-600`} data-lots-overflow="open">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        <span className="min-w-0">未完了ロットが{openLimit}件の上限に届きました。作業画面に出ていないロットが在るかもしれません。</span>
      </div>,
    );
  }
  if (historyScreen && overflow.historyCapped) {
    if (archiveState === 'loading') {
      out.push(
        <div key="arch" className={`${pill} bg-sky-600`} data-archive-band="1">
          <Loader2 className="w-4 h-4 animate-spin shrink-0" />
          <span className="min-w-0">過去のロット（新しい順{historyLimit}件より古い分）を読み込んでいます… この画面の集計は、あと少し増えます</span>
        </div>,
      );
    } else if (archiveState === 'failed') {
      out.push(
        <div key="arch" className="shrink-0 px-4 py-2 bg-amber-600 text-white flex items-center justify-between gap-2 text-sm font-bold shadow-md" data-archive-band="1">
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span className="min-w-0">過去のロットを読めませんでした。過去のロットは新しい順{historyLimit}件までしか読めていません。それより古い完了ロットはこの集計に入っていません。</span>
          </div>
          <button onClick={onRetry} className="shrink-0 bg-white text-amber-700 hover:bg-amber-50 rounded-lg px-3 min-h-11 text-xs font-black">もう一度</button>
        </div>,
      );
    } else if (overflow.olderMissing) {
      const why = archiveState === 'blocked' ? '（読み取りの上限に達したため取り寄せていません）'
        : overflow.archiveCapped ? `（取り寄せも${archiveLimit}件の上限に届きました）` : '';
      out.push(
        <div key="arch" className={`${pill} bg-amber-600`} data-lots-overflow="history">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span className="min-w-0">過去のロットは新しい順{overflow.archiveCapped ? historyLimit + archiveLimit : historyLimit}件までしか読めていません。それより古い完了ロットはこの集計に入っていません{why}</span>
        </div>,
      );
    }
  }
  if (!out.length) return null;
  return <>{out}</>;
}
