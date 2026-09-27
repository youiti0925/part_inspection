// =============================================================================
//  opsim/lateTone.js — 「遅れ」の色はここ1か所。赤の濃淡だけを使う(決まり27・2026-09-05)
// -----------------------------------------------------------------------------
//  清水さん(2026-09-05 朝):「この先で遅れると空きがほぼ同じ色だろ、どうやって理解しろっていうんだ」
//  根: 「この先で遅れる」に amber-400、空き(記録が無い工程が待っている)に amber-500 を使っていた。
//      同じ系統の色に別の意味。決めた時に並べて見ていなかった。
//  決まり:
//    ・遅れ系は **赤の濃淡だけ**。すでに過ぎた=濃い赤(塗り)、この先で遅れる=薄い赤の縞、
//      遅れて完了(記録)=灰の札に赤い「+N日」(Board 側の done のまま)。**橙は使わない**。
//    ・橙(amber)は 空き(スキル待ち)専用(idleTone.js)。青(sky)=入荷待ち、紫(violet)=専門のため、灰=仕事なし。
//  🚨 製品検査と最終検査で同じファイル(md5 一致)。片方だけ変えない。
// =============================================================================

/** 縞: Tailwind の任意値。`_` が空白になる。rose-300(#fda4af) と rose-200(#fecdd3) の 4px 交互。 */
const FORECAST_STRIPE = 'bg-[repeating-linear-gradient(135deg,#fda4af_0_4px,#fecdd3_4px_8px)]';

export const LATE_TONE = Object.freeze({
  /** すでに予定日を過ぎている(事実) */
  past: Object.freeze({
    bar: 'bg-rose-500',
    text: 'text-rose-600',
    chip: 'border-rose-300 bg-rose-50 text-rose-700',
    dot: 'bg-rose-500',
  }),
  /** この先で遅れる(この見立ての結果)。薄い赤の縞 */
  forecast: Object.freeze({
    bar: FORECAST_STRIPE,
    text: 'text-rose-600',
    chip: 'border-rose-300 bg-rose-50 text-rose-700',
    dot: 'bg-rose-300',
    box: 'border-rose-200 bg-rose-50/40',
    head: 'text-rose-700',
    item: 'border-rose-200 bg-white',
    main: 'text-rose-800',
    sub: 'text-rose-600',
  }),
});

export default LATE_TONE;
