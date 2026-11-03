// =============================================================================
//  src/opsim/DailyLoadRefreshButton.jsx — 「最新にする」「今すぐ反映」のボタン(2026-10-03 B3)
// -----------------------------------------------------------------------------
//  清水さん(2026-10-03 夜・原文):
//    「その頻度でもいいけど、作業者が最新情報欲しい時は、更新ボタン押してできるようにしてもらえるならいいと思うよ」
//  🚨 ボタンは描くだけ。頼む・書く の配線は dailyLoadRefresh.js、決まりは domain/operationsSimulation/dailyLoadThrottle.js。
//  🚨 押す物は min-h-11(44px)・文字は .fi-tap-text / text-2xs 以上。
//  🚨 製品検査と最終検査で同じファイル。片方だけ変えない。
// =============================================================================
import React, { useContext } from 'react';
import { RefreshCw, Send } from 'lucide-react';
import { publishStateText } from '../domain/operationsSimulation/dailyLoadThrottle.js';
import { DailyLoadRefreshContext, APP_LABEL } from './dailyLoadRefresh.js';

/**
 * 相手の数字の隣に置く「最新にする」。押すと相手の端末へ「今すぐ計算して書いて」を頼む。
 * @param target 相手の工場('product' | 'final')。書類の app 欄から渡す。
 */
export function DailyLoadRefreshButton({ target = '', className = '' }) {
  const ctx = useContext(DailyLoadRefreshContext);
  if (!ctx || !ctx.canRequest || !target || target === ctx.hereApp) return null;
  const st = ctx.statusOf(target);
  const busy = st.phase === 'sending' || st.phase === 'asking' || st.phase === 'claimed';
  const tone = st.phase === 'arrived' ? 'text-emerald-700'
    : (st.phase === 'noAnswer' || st.phase === 'stalled' || st.phase === 'failed') ? 'text-amber-700' : 'text-slate-600';
  return (
    <span className={`inline-flex flex-wrap items-center gap-1.5 ${className}`} data-daily-load-refresh={target} data-daily-load-refresh-phase={st.phase}>
      <button
        type="button"
        disabled={busy}
        onClick={() => ctx.request(target)}
        title={`${APP_LABEL[target] || '相手'}の端末へ「今すぐ計算して共有して」と頼みます。いつもは計算が変わっても5分に1回だけ共有します。`}
        className="inline-flex min-h-11 items-center gap-1 whitespace-nowrap rounded-lg border border-sky-300 bg-sky-50 px-2 fi-tap-text font-bold text-sky-800 hover:bg-sky-100 disabled:opacity-60"
      >
        <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
        最新にする
      </button>
      {st.text ? <span className={`text-2xs font-bold ${tone}`} data-daily-load-refresh-text="">{st.text}</span> : null}
    </span>
  );
}

/** 自分の画面の「今すぐ反映」。押すと、5分を待たずに いまの計算を共有棚へ書く。 */
export function DailyLoadSendNowButton({ info = null, onPress = null, disabled = false, className = '' }) {
  if (typeof onPress !== 'function') return null;
  const text = publishStateText(info || {});
  const busy = !!(info && info.inFlight);
  return (
    <span className={`inline-flex flex-wrap items-center gap-1.5 ${className}`} data-daily-load-send-now="" data-daily-load-pending={info && info.pending ? '1' : '0'}>
      <button
        type="button"
        disabled={disabled || busy}
        onClick={onPress}
        title="この画面の計算を、5分を待たずに相手の工場(共有棚)へ書きます。いつもは計算が変わっても5分に1回だけ書きます。画面を閉じる時にも書きます。"
        className="inline-flex min-h-11 items-center gap-1 whitespace-nowrap rounded-lg border border-sky-300 bg-sky-50 px-2 fi-tap-text font-bold text-sky-800 hover:bg-sky-100 disabled:opacity-60"
      >
        <Send className="h-4 w-4" />
        今すぐ反映
      </button>
      {text ? <span className="text-2xs font-bold tabular-nums text-slate-600">{text}</span> : null}
    </span>
  );
}
