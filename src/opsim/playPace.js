// =============================================================================
//  opsim/playPace.js — 盤の「時間の進み方」（刻み と 速さ）の表 ただ1つ
// -----------------------------------------------------------------------------
//  出典: 2026-08-30 清水さんの要望3（原文）
//   「もっと細かくみたいときもあるので、0.5時間ごとで見たいときもあるかな。
//     0.5時間毎を1秒毎とか2秒毎とか、時間の進み(再生)をこっちで細かく設定して
//     シミュレーションの動きをみたいなと思ってる。」
//
//  ■ なぜ別のファイルにするか
//   Panel(状態を持つ側)と Header(札を描く側)の両方が同じ表を要る。
//   2026-08-30 まで「ふつう/こまかく」の2択が **Panel と Header の両方に書いてあった**。
//   片方だけ直すと、画面の札と実際の進み方が黙って食い違う形だった。表は1つにする。
//   ⚠ Header.jsx へ置くと eslint(react-refresh/only-export-components)が止める。
//
//  ■ 2つは別物。混ぜない。
//   ・刻み = 1こまで **盤の中の時間が何ぶん進むか**
//   ・速さ = 1こまを **見ている人の何秒で送るか**
//   束ねていると「0.5時間ごとを2秒ごとで」という組み合わせが作れない。
//
//  ■ 既定は今までと1ミリも同じ（`d03` ＋ `ms900` ＝ 旧「ふつう」）
//   🚨 0.3日 は CONTRACT.md 1章で決まっている量（通常126分／残業162分）。
//     ここで時間へ言い換えて上書きしない。日で持つ物は日のまま渡す。
//   🚨 旧「こまかく」(0.05日・2秒)も `d005` ＋ `ms2000` として残す。1つも減らさない。
//
//  ■ 時間で指定する刻みについて
//   記録(snapshot)は 30分ごとに残している（OperationsSimulationPanel の SNAPSHOT_EVERY_MS）。
//   だから **0.5時間が「押すたびに必ず次の記録へ進む」一番細かい刻み**。
//   これより細かくしても、誰が何をしているかは同じ記録のままで、動くのはカードの横位置だけ
//   （測っていない割り当てをこちらで作らない）。
//
//  🚨 React を import しない。ただの表と純関数だけ。
// =============================================================================

/** 1時間のミリ秒。 */
const MS_HOUR = 60 * 60 * 1000;

/**
 * 1こまで進む量（刻み）。
 * `day` と `hours` は **どちらか一方だけ** 入れる（両方入った物は作らない）。
 */
export const OPSIM_STEP_CHOICES = Object.freeze([
  { key: 'd005', label: '0.05日', day: 0.05, hours: null, hint: '旧「こまかく」。カードの動きがなめらかに見えます' },
  { key: 'd03', label: '0.3日', day: 0.3, hours: null, hint: '旧「ふつう」。CONTRACT の決まりどおり 通常126分・残業162分ぶん進みます' },
  { key: 'h05', label: '0.5時間', day: null, hours: 0.5, hint: '記録は30分ごとなので、押すたびに必ず次の記録へ進みます' },
  { key: 'h1', label: '1時間', day: null, hours: 1, hint: '記録2枚ぶん進みます' },
  { key: 'h2', label: '2時間', day: null, hours: 2, hint: '記録4枚ぶん進みます' },
  /* 🚨 2026-09-04 追記（決まり19A の実測）: 6営業日以上の期間では、盤の記録が **1日ごと** にしか無い
     （5営業日以内だけ「直接作業30分ごと」の細かい記録を足している）。
     そのため月の期間で「＋0.3日」を押しても **同じ1枚の記録が選ばれ、札の残り時間が1分も動かない**
     （6回押して3回動かなかった）。押しても何も起きないつまみを黙って残さないための刻み。
     ⚠ 5営業日の時にこれを選ぶのは自由（1日ぶん進むだけで、何も壊れない）。 */
  { key: 'd1', label: '1日', day: 1, hours: null, hint: '月の期間はここ。記録が1日ごとなので、押すたびに必ず次の記録へ進みます' },
]);
/** 🚨 既定は旧「ふつう」と同じ。ここを変えると開いた瞬間の見え方が変わる。 */
export const OPSIM_STEP_DEFAULT = 'd03';

/** 1こまを何秒で送るか（速さ）。 */
export const OPSIM_PLAY_MS_CHOICES = Object.freeze([
  { key: 'ms500', label: '0.5秒', ms: 500, hint: 'いちばん速い送り' },
  { key: 'ms900', label: '0.9秒', ms: 900, hint: '旧「ふつう」と同じ速さ' },
  { key: 'ms1000', label: '1秒', ms: 1000, hint: '' },
  { key: 'ms2000', label: '2秒', ms: 2000, hint: '旧「こまかく」と同じ速さ' },
  { key: 'ms4000', label: '4秒', ms: 4000, hint: 'ゆっくり見たい時' },
]);
/** 🚨 既定は旧「ふつう」と同じ 0.9秒。 */
export const OPSIM_PLAY_MS_DEFAULT = 'ms900';

/** 刻みの札 → その中身。知らない札が来たら既定へ落とす（画面を止めない）。 */
export const opsimStepOf = (key) => OPSIM_STEP_CHOICES.find((x) => x.key === key)
  || OPSIM_STEP_CHOICES.find((x) => x.key === OPSIM_STEP_DEFAULT);

/** 速さの札 → その中身。 */
export const opsimPlayMsOf = (key) => OPSIM_PLAY_MS_CHOICES.find((x) => x.key === key)
  || OPSIM_PLAY_MS_CHOICES.find((x) => x.key === OPSIM_PLAY_MS_DEFAULT);

/**
 * 刻み1こまが「何日ぶん」か。
 * 🚨 時間で指定した刻みは、1日ぶんの直接作業能力(capMs)で日へ直す。
 *   capMs は残業シナリオだと増える（420分→540分）ので、**その時の値で毎回割る**。
 *   ここを決め打ちにすると、残業の時だけ盤の進みが実際とズレる。
 * ⚠ capMs が分からない時は、時間指定の刻みを日へ直せない。既定の 0.3日 を使う
 *   （勝手な換算値をでっち上げない）。
 * @param {string} key   OPSIM_STEP_CHOICES の key
 * @param {number|null} capMs 1日ぶんの直接作業能力(ms)
 * @returns {number} 1こまで進む日数
 */
export const opsimStepDays = (key, capMs) => {
  const c = OPSIM_STEP_CHOICES.find((x) => x.key === key) || null;
  if (c && c.day != null) return c.day;
  if (c && c.hours != null && Number.isFinite(capMs) && capMs > 0) {
    return (c.hours * MS_HOUR) / capMs;
  }
  return 0.3;
};
