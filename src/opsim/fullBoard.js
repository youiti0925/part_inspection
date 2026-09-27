// =============================================================================
//  opsim/fullBoard.js — 拡大（画面いっぱい）の時の 言い方 と 寸法（純関数だけ）
// -----------------------------------------------------------------------------
//  出典: 2026-09-04 決まり20（清水さん「拡大したらロットの流れの再生が全くボタンがない
//        からできない」／「＋2時間を押すと 0.3日ぶん と出る」）。
//
//  🚨 なぜ Header.jsx から出したか
//    Header.jsx は部品(コンポーネント)だけを出す約束になっている
//    （eslint react-refresh/only-export-components。定数や関数を混ぜると赤）。
//    だから「画面を持たない計算」はこの1枚に置く。**写しは作らない**。
//    ここの2つは Header.jsx と OperationsSimulationPanel.jsx の両方が読む
//    ＝ 同じ数字を2つの計算から出さない。
//
//  🚨 このファイルは1バイトも書かない（Firestore を import すらしていない）。
// =============================================================================
import { OPSIM_STEP_CHOICES, opsimStepDays } from './playPace.js';

const MS_HOUR = 60 * 60 * 1000;

/* ---------------------------------------------------------------------------
 * ① いま何ぶん進めたか。**押した量をそのまま言う**。
 * ---------------------------------------------------------------------------
 * 🚨 いままでは「＋2時間」を1回押すと札が「いまから 0.3日ぶん」と出ていた。
 *   2時間 ÷ 1日ぶんの直接作業能力(420分) = 0.286日 を小数1桁に丸めて 0.3日 と書いていた。
 *   押した物は「2時間」なのに返ってくる字は「0.3日」＝ **押した量を言い換えた嘘**。
 * 直し: 刻みを時間で選んでいる時は **時間で** 言い、日が要る所は日を併記する。
 * 🚨 換算に使うのは capMs（その時の1日ぶんの直接作業能力）ただ1つ。
 *   残業シナリオだと 420分→540分 に増えるので、決め打ちの換算値を置かない。
 * 🚨 capMs が分からない時は時間へ直せない。その時は **日だけを言い、時間を作らない**。
 *
 * @param {number} nowDay  いま何日ぶん進めたか（0.0＝いま）
 * @param {string} stepKey OPSIM_STEP_CHOICES の key（押した刻み）
 * @param {number|null} capMs 1日ぶんの直接作業能力(ms)
 * @returns {{main:string, sub:string|null}} main=大きく出す言い方 / sub=併記（無ければ null）
 * --------------------------------------------------------------------------- */
export const opsimElapsedText = (nowDay, stepKey, capMs) => {
  const d = Number(nowDay);
  const day = Number.isFinite(d) && d > 0 ? d : 0;
  const choice = OPSIM_STEP_CHOICES.find((x) => x.key === stepKey) || null;
  const cap = Number(capMs);
  const capOk = Number.isFinite(cap) && cap > 0;
  const byHours = !!(choice && choice.hours != null) && capOk;
  // 日の言い方。刻みが 0.1日 より細かい時だけ小数2桁（0.05日 が 0.1日 に化けない様に）。
  const stepD = opsimStepDays(stepKey, capOk ? cap : null);
  const dayDigits = stepD < 0.1 ? 2 : 1;
  const dayText = `${Math.round(day * (10 ** dayDigits)) / (10 ** dayDigits)}日`;
  if (day <= 0) return { main: 'いま', sub: null };
  if (!byHours) return { main: `${dayText}ぶん`, sub: null };
  // 時間の言い方。押した刻みの整数倍にしかならないので、0.1時間の桁まで出せば言い換えにならない。
  const hours = Math.round(((day * cap) / MS_HOUR) * 10) / 10;
  return { main: `${hours}時間ぶん`, sub: dayText };
};

/* ---------------------------------------------------------------------------
 * ② 拡大の時に盤へ渡す「見える窓」の高さ。
 * ---------------------------------------------------------------------------
 * 🚨 帯を1行足したら、その高さだけ **盤の使える高さを減らす**。
 *   2026-08-24 の「詰めて表示」は盤を1pxも大きくしていなかった。その裏返しで、
 *   帯を足したのに高さを減らさないと、足した帯は盤を窓の外へ押し出すだけになる。
 * 🚨 だから帯の有無を **引数で受けて必ず引く**。呼ぶ側が本当に引いているかは
 *   見張り(verify-opsim-full-controls.mjs)が この関数を実際に呼んで確かめる。
 * ⚠ ここは CSS ではなく「盤という絵の入れ物に渡す寸法」なので px。
 *   帯そのものの高さは min-h-9（2.25rem）＝ 文字サイズ設定について伸び縮みする。
 *
 * @param {number} winH 窓の高さ(px)
 * @param {boolean} hasStrip 1行の操作帯を出しているか
 * --------------------------------------------------------------------------- */
export const OPSIM_FULL_STRIP_PX = 44;   // 操作帯1行ぶん（min-h-9 36px ＋ 上下の余白と隙間）
export const OPSIM_FULL_ABOVE_PX = 150;  // 結論の1行 ＋ 箱の見出し ＋ 凡例
export const OPSIM_FULL_MIN_PX = 420;    // これより低くしない（盤が潰れて1本も読めなくなる）
export const opsimFullBoardPx = (winH, hasStrip) => {
  const h = Math.round(Number(winH) || 0);
  const above = OPSIM_FULL_ABOVE_PX + (hasStrip ? OPSIM_FULL_STRIP_PX : 0);
  return Math.max(OPSIM_FULL_MIN_PX, h - above);
};
