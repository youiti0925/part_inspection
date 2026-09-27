// =============================================================================
//  opsim/Header.jsx — 操業シミュレーションの一番上（4枚 ＋ 注意1行 ＋ 操作）
// -----------------------------------------------------------------------------
//  出典: 是正指示書 6.2 / 6.5 / 8.1 / 8.2 ＋ domain/operationsSimulation/PANEL_SPEC.md
//
//  ■ 画面4分割(2026-08-30 清水さんの指示「計算機能は減らさず、画面を4つに分ける」)
//   タブは board(盤面・既定) / nextMonth(来月の手当て) と、畳んだ物 today / month / improve。
//   （2026-09-05: basis(条件・根拠) は描く枝ごと無くなった。札だけ残っていて真っ白だった）
//   タブの状態は親(OperationsSimulationPanel)が持ち、ここは tab を受け取って出し分けるだけ。
//   🚨 実際に描かれる一覧も親が tabs= で渡す方（OPSIM_TABS_MAIN）。下の OPSIM_TABS は予備。
//   🚨 情報は1つも消していない。**場所を移しただけ**。移した先:
//     ・4枚のカード・主因の行・通常との差・記録の枚数警告 … Header の today
//     ・結論1行＋時間の操作(再生・つまみ) … Header の board
//     ・手ごとの効き目・教育の案 … ImproveDeck(このファイルの下)
//     ・見る範囲/何日先まで/工数の見方・仮の入荷日 … BasisControls(このファイルの下)
//     ・分かっていない事・力量の注記・基準時刻・根拠を見る・読み書き数・かかった時間 … BasisNotes(このファイルの下)
//   「詰めて表示」「大画面」の2ボタンは撤去(清水さんの指示)。タブバーが同じ場所に入った。
//
//  ■ ここが守っている事
//   🚨「すでに予定日を過ぎている」(今日の事実) と「この先で遅れる」(この見立ての結果) と
//      「判定できません」(入力が足りない) を **1つも混ぜない**。
//      混ぜたのが清水さんへ3回続けて違う件数を出した原因(CONTRACT.md)。
//      → lotResults の alreadyPastDue / late / judgeable を別々の行に出す。
//   🚨 「最初に越える日時」は **explain.forecastBreachAt**(この先で最初に越える時刻)で出す。
//      2026-08-22 まで explain.breachAt(すでに予定日を過ぎている物も入った時刻)を出していた。
//      あれは今日の事実なので、人を増やしても減らしても1秒も動かない。
//      → 是正指示書10章 S1-E ④「欠員時に突破日が変わる」が落ちていた直接の原因。
//      breachAt も **消さずに小さい字で** 別行に残す（今日の事実は今日の事実で要る）。
//   🚨 「手が付けられない仕事」(unresolvedCount) を、遅れ件数と **同じ大きさ** で出す。
//      欠員のシナリオで一番動くのがこの数。小さく出すと「何も変わらない画面」に見える。
//   🚨 シナリオを切り替えた時は「通常との差」を出す。**差が0の物は1つも出さない**。
//      「±0」を並べると、動いていない事の説明でなく「動かないタブ」に見える。
//   🚨 効果を測っていない手・効果が0の手に「+0」を出さない。数字を出すのは
//      deltaLate が実測で 1件以上 減った物だけ。
//      （deltaLate は「base の遅れ − その手を打った時の遅れ」。負なら悪化なので選ばない）
//   🚨 自動再生は初期状態で止める(指示書6.5)。この部品は playing を **受け取るだけ**で、
//      自分では時間を進めない(タイマーを持たない)。初期値を決めるのは呼ぶ側。
//   🚨 描画関数の中でコンポーネントを定義しない。小さい札も全部このファイルの一番上に置く。
//   🚨 engine が返す理由の文言を、この画面で言い換えない。言い換えると根拠画面と字が食い違う。
//
//  ■ 見た目
//   白 + slate。この画面のアクセントは cyan-600（分析タブの既存は indigo/rose/orange）。
//   ⚠ 文字は最小 11px 相当 = `text-2xs`。**`fi-tap-text` の px 直書きは使わない**。
//     px 直書きは文字サイズ設定(applyFontSizes)で1pxも拡大しない。
//     `text-2xs` は tailwind.config.js の SMALL_STEPS で 0.6875rem(=11px) かつ変数追従。
//
//  ■ 出してはいけない言葉（PANEL_SPEC 7章）
//   できない・不可・未経験・初級・上級者・有意・標本・スコア・偏差
//   「実績が1件しかないから当てにならない」も書かない。記録が無い＝分かりません。
// =============================================================================
import React, { useMemo, useState } from 'react';
import {
  Play, Pause, RotateCcw, FastForward, Rewind, ShieldCheck, ShieldAlert, HelpCircle,
  CalendarClock, AlertTriangle, Lightbulb, Info, Loader2, X, Database, ArrowLeftRight, GraduationCap,
  ChevronDown, ChevronRight,
} from 'lucide-react';

// 基準時刻の2択の名前。🚨 画面で書き直さず、domain の物をそのまま使う（字の食い違いを作らない）。
import { BASE_TIME_MODE, BASE_TIME_MODE_LABEL } from '../domain/opsimBaseNow.js';
import { Signal, Dots } from './vizKit.jsx';
// 盤の「時間の進み方」(刻み・速さ)の表。🚨 表は playPace.js がただ1つ持つ。ここに写しを作らない。
import {
  OPSIM_STEP_CHOICES, OPSIM_STEP_DEFAULT, OPSIM_PLAY_MS_CHOICES, OPSIM_PLAY_MS_DEFAULT,
  opsimStepOf, opsimPlayMsOf, opsimStepDays,
} from './playPace.js';
// 拡大（画面いっぱい）の 言い方 と 寸法。🚨 画面を持たない計算はここ1枚だけが持つ（2026-09-04 決まり20）。
//   ・opsimElapsedText …「＋2時間」を押したら「2時間ぶん」と言う（0.3日ぶん に言い換えない）
//   ・opsimFullBoardPx … 操作帯を1行足した分だけ、盤の使える高さを必ず減らす
import { opsimElapsedText } from './fullBoard.js';

// -----------------------------------------------------------------------------
// シナリオの並び。key は呼ぶ側（親）と共有する（親は onScenario(key) で受ける）。
// 🚨 押しても数字が1つも変わらないタブを出さない（モックの「保険ライン」がそれだった）。
//   まだ配線していないシナリオは、親が `enabledScenarios={['normal', ...]}` で外す。
// ⚠ ここを export しない理由: この1ファイルだけで完結させる約束なので、定数を出すと
//   eslint の react-refresh/only-export-components が赤くなる（部品と定数は同居できない）。
//   key の一覧は上記のとおり。親はこの文字列をそのまま使う。
// -----------------------------------------------------------------------------
const OPSIM_SCENARIOS = [
  { key: 'normal', label: '通常', hint: '今いる人・今の勤務時間のまま' },
  { key: 'overtime', label: '残業', hint: '1日に使える時間を増やした時' },
  { key: 'absence', label: '誰か休み', hint: '誰か1人が休んだ時' },
  { key: 'allSkills', label: '全員できる仮定', hint: '全員がどの工程も持てるとして数える（総量を見る）' },
  { key: 'history', label: '記録から', hint: '過去の作業記録から作った当てだけで数える' },
  // 🚨 仕様書5.11: 「後継を仮に」は **今すぐ単独可という仮定** であって OJT ではない。
  //   CONTRACT.md:343「画面にも『後継を仮に』と書かない」。名前を仕様どおりにする。
  { key: 'ojt', label: '後継者が単独可になった後', hint: 'その人が1人でその工程をできる様になった後の姿。OJTの最中ではありません' },
  // 追記(2026-08-29 S2-2): 人の任せ替え。1人を休みにして、その人が担う予定だった工程を別の人に仮に持たせる。
  //   ⚠親(OperationsSimulationPanel)の ENABLED_SCENARIOS にも同じ key がある。ここに無いとピルが出ない(実測)。
  { key: 'swap', label: '人の任せ替え', hint: '1人を休みにして、その人の工程を別の人に仮に持たせた時' },
];

// 見ている範囲（指示書8.1・CONTRACT.md の実測: 10件=111ms / 179件=約5秒 / 282件=約8秒）
const OPSIM_SCOPES = [
  { key: 'onhand', label: '手元だけ', hint: 'もう工場に入っているロットだけ' },
  { key: 'soon', label: '手元＋14日以内', hint: '14日以内に入ってくる分まで' },
  { key: 'all', label: 'ぜんぶ', hint: '終わっていないロットぜんぶ（時間がかかります）' },
];

/**
 * 何日先まで見るか（仕様書11章「上段」）。
 * 🚨 30日は計算が重い。5日の 4〜6倍かかる事がある（本番実測で5日 4.8〜6.8秒）。
 *   だから既定は5日。30日は「先の山を見る」ためだけに押す物として説明を付ける。
 */
const OPSIM_HORIZONS = [
  { key: 5, label: '5日', hint: '今週の山。日ごとに見る（既定）' },
  { key: 30, label: '30日', hint: '先の山。週ごとに見る。⚠計算に時間がかかります' },
];

/**
 * 工数の見積り（仕様書5.6）。
 * 🚨 **モードを変えると入力そのものが変わる**ので、前の結果とは比べられない。
 *   切り替えたら計算し直しになる（そういう作りにしてある）。
 * 🚨 「実績が足りない工程」はどのモードでもテンプレートの目標時間か「分かりません」。
 *   固定の 38/64/81% みたいな線で代用していない。
 */
const OPSIM_ESTIMATE_MODES = [
  { key: 'P50', label: 'P50 通常線', hint: '実績のまん中。半分はこれより早く終わる' },
  { key: 'P75', label: 'P75 保険線', hint: '実績の上から4分の1。既定。段取りの余裕を見る時' },
  { key: 'P90', label: 'P90 絶対線', hint: '実績の上から1割。「これなら間に合う」と言い切る時' },
];

/**
 * 画面4分割のタブ(2026-08-30 清水さんの表)。
 * 🚨 タブは見せ方の切替だけ。計算・シナリオ・保管庫には1ミリも触らない。
 *   置き場所は「詰めて表示」「大画面」ボタンが居た所(この2ボタンは撤去)。
 */
const OPSIM_TABS = [
  { key: 'today', label: '今日の判断', hint: '遅れるか・いつ・何件・主因・一番効く手・データ不足を見ます' },
  // 📅 月ごと(2026-09-03 清水さん「一月毎に、月毎の必要な人材を確認する」「一月前に分かれば準備が間に合う」)。
  //   中身は opsim/Monthly.jsx。計算は Worker の monthly.js（ここでは何も数えない）。
  //   hint は Codex 129ee00 の物を接いだ(2026-09-04。清水さんの言葉「月毎の必要な人材」に近い)。鍵とラベルは私のまま。
  { key: 'month', label: '月ごと', hint: '月毎に要る時間・働ける時間・不足と、持てる人を見ます' },
  { key: 'board', label: '盤面', hint: '盤を横いっぱいに出して、時間を進めてカードの動きを見ます' },
  { key: 'improve', label: '改善・教育', hint: '条件比較の表・手ごとの効き目・教育の案' },
  // 🗂 割付と空き(2026-09-23 Codex 13bb9d2 の画面を接いだ。清水さん「全部確認してちゃんと入れて」)。中身は opsim/DecisionBoard.jsx。
  { key: 'dispatch', label: '割付と空き', hint: '人ごとの順番・空き・理由と、どの担当記録があれば空きを仕事へ変えられるか' },
  // 🚨 決まり19C(2026-09-04 清水さん「条件根拠も全くわからん何のためにあるの？何を伝えたいの？」):
  //   「条件・根拠」は **タブ(画面)としては無くしました**。1行も消していません。
  //     ・設定 … 盤面の上の「⚙ 設定」の引き出し
  //     ・数字の意味 … 各数字の横の「？」（押した数字1つの根拠だけ）
  //     ・読み書き0件 … 盤面の上に常設
  //   引っ越しの表: src/opsim/basisRegistry.js ／ 見張り: scripts/opsim-basis-move-guard.mjs
  //   ⚠ 2026-09-05: 「鍵 'basis' 自体は残してあります」と書いてありましたが、
  //     'basis' へ飛ぶ道は1本も無く、飛んでも **描く枝が無いので真っ白**でした。だから鍵ごと外しました。
  //   🚨🚨 この一覧は **予備**です。本番で実際に描かれるのは
  //     OperationsSimulationPanel.jsx の OPSIM_TABS_MAIN（親が tabs= で渡す方）。
  //     2026-09-05 に、見張りがこちら（渡されない方）だけを見ていて、
  //     本物に残っていた「条件・根拠」の空白タブを **緑と報告した**事故が起きています。
  //     見張りを書く時は必ず **渡される方**（OPSIM_TABS_MAIN）を見る事。
];


/**
 * 基準時刻の2択（2026-08-30 清水さんの指摘 原文）:
 *   「夜に開くと全員が『勤務時間外』になります。計画用途なら、
 *     今から ／ 次の勤務開始から を切り替えられるようにすると、
 *     盤面がかなり理解しやすくなります」
 * 🚨 既定は「今から」＝ 今までと1ミリも同じ挙動。
 */
const BASE_TIME_ITEMS = [
  {
    key: BASE_TIME_MODE.NOW,
    label: BASE_TIME_MODE_LABEL[BASE_TIME_MODE.NOW],
    hint: '端末の時計そのままで見ます',
  },
  {
    key: BASE_TIME_MODE.NEXT_START,
    label: BASE_TIME_MODE_LABEL[BASE_TIME_MODE.NEXT_START],
    hint: '夜・休憩中・土日に見ている時は、次に働ける時刻へ合わせます（勤務時間の中なら今のまま）',
  },
];

// 🚨 2026-08-30 清水さんの指摘で直した: 主な原因の見出しは、前はここの CAUSE_TITLE +
//   explain.causes[0] から出していて、主因の行(classifyCauses)と**別の計算**だった。
//   「通常表示は『人の当てが無い工程』・詳しい原因は『仕事量が多すぎる』」と画面ごとに
//   主因が違って見え、判断を誤らせる。主因は classifyCauses(仕様書5.10)**ただ1つ**から配る。

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

// -----------------------------------------------------------------------------
// 数の出し方。🚨 丸めずに出すと 0.30000000000000004 が画面に出る。
// -----------------------------------------------------------------------------
/**
 * 日数の丸め。
 * 🚨 小数3桁で丸める。1桁で丸めてはいけない(2026-08-30)。
 *   刻みを「0.5時間」にすると1こまは 0.071日 ぶん。小数1桁で丸めると 0.1日 に化けて、
 *   **押しても数字が動かない／つまみが飛ぶ** 画面になる。
 *   人へ出す桁は showDay(刻みに合わせて1〜2桁)が別に決める。ここは計算用。
 */
const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const fmtInt = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('ja-JP') : '—');
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// 差の出し方。0 は呼ぶ側で捨てるので、ここでは 0 が来ない前提にしない（来ても「±0」と書かない）。
// ⚠ マイナス記号は U+2212。ハイフンだと tabular-nums で高さが揃わない。
const fmtDelta = (n) => `${n > 0 ? '+' : '−'}${fmtInt(Math.abs(n))}件`;

const fmtWhen = (ms) => {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  return {
    head: `${d.getMonth() + 1}/${d.getDate()}（${WEEK[d.getDay()]}）${hm}`,
    year: `${d.getFullYear()}年`,
  };
};

// 遅れの長さ。実時間のミリ秒なので「日・時間」で出す（稼働時間ではない）。
const fmtSpan = (ms) => {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  const total = Math.floor(ms / 60000);
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  if (days > 0) return hours > 0 ? `${days}日 ${hours}時間` : `${days}日`;
  if (hours > 0) return mins > 0 ? `${hours}時間 ${mins}分` : `${hours}時間`;
  return `${mins}分`;
};

/** 差を書くための短い言い方。0 や負も「—」にせず必ず何か返す（差の表で穴を作らない）。 */
const fmtSpanShort = (ms) => {
  const v = Math.abs(Number(ms) || 0);
  if (v < 60000) return '1分未満';
  return fmtSpan(v) || '1分未満';
};

// 進み具合。数でも { done,total } でも { ratio } でも受ける。分からなければ pct=null。
const readProgress = (p) => {
  if (p == null) return { pct: null, label: '' };
  if (typeof p === 'number' && Number.isFinite(p)) {
    return { pct: clamp(p <= 1 ? p * 100 : p, 0, 100), label: '' };
  }
  if (typeof p === 'object') {
    const label = typeof p.label === 'string' ? p.label : (typeof p.phase === 'string' ? p.phase : '');
    let pct = null;
    if (typeof p.ratio === 'number' && Number.isFinite(p.ratio)) pct = p.ratio <= 1 ? p.ratio * 100 : p.ratio;
    else if (typeof p.percent === 'number' && Number.isFinite(p.percent)) pct = p.percent;
    else if (Number.isFinite(p.done) && Number(p.total) > 0) pct = (100 * Number(p.done)) / Number(p.total);
    return { pct: pct == null ? null : clamp(pct, 0, 100), label };
  }
  return { pct: null, label: '' };
};

// 「手が付けられない仕事」の理由の内訳。
// engine 側が { 理由: 件数 } のまとまりで返しても [{ reason, count }] の並びで返しても受ける。
// 🚨 理由の文言は engine の物をそのまま出す（UNRESOLVED_REASON の日本語1文）。
//   ここで短く書き直すと、根拠画面や監査の字と食い違う。
const readByReason = (v) => {
  const rows = [];
  if (Array.isArray(v)) {
    v.forEach((x) => {
      if (x == null) return;
      const reason = typeof x === 'string' ? x : String(x.reason ?? x.label ?? '');
      const count = typeof x === 'string' ? 1 : Number(x.count ?? x.jobs ?? x.n);
      if (reason && Number.isFinite(count)) rows.push({ reason, count });
    });
  } else if (v != null && typeof v === 'object') {
    Object.keys(v).forEach((k) => {
      const count = Number(v[k]);
      if (k && Number.isFinite(count)) rows.push({ reason: k, count });
    });
  }
  // 多い順。同じ数なら理由の文字順（端末で並びが変わらないよう localeCompare は使わない）。
  return rows
    .filter((r) => r.count > 0)
    .sort((a, b) => (b.count - a.count) || (a.reason < b.reason ? -1 : 1));
};

// 数として読める時だけ数にする。🚨 Number(null) は 0 になるので、null を先に外す。
const numOrNull = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const hasKey = (o, k) => o != null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

// -----------------------------------------------------------------------------
// 見た目の部品。⚠ 全部この位置(モジュールの一番上)に置く。
//   描画関数の中で定義すると毎回別物になり、状態が飛ぶ。
// -----------------------------------------------------------------------------
const TONE = {
  emerald: { bar: 'bg-emerald-500', edge: 'border-emerald-200', value: 'text-emerald-700' },
  rose: { bar: 'bg-rose-500', edge: 'border-rose-200', value: 'text-rose-600' },
  amber: { bar: 'bg-amber-500', edge: 'border-amber-200', value: 'text-amber-700' },
  cyan: { bar: 'bg-cyan-500', edge: 'border-cyan-200', value: 'text-cyan-700' },
  slate: { bar: 'bg-slate-400', edge: 'border-slate-200', value: 'text-slate-700' },
};

/**
 * 4枚のカード。
 * 🚨 高さを揃えない(2026-08-30 清水さんの指摘1)。
 *   原文「判断カードの空白が大きいです。4枚を同じ高さにしているため、中身が短いカードに
 *        大きな空白ができます。カードを同じ高さにせず、下の長い内訳を折りたたむと
 *        さらに見やすくなります。」
 *   直す前の実測(幅1440px): 4枚とも 288px に引き伸ばされ、下の空白が
 *     見通し 178px / 最初に越える日時 216px / 遅れる・手が付けられない 14px / 主な原因 113px。
 *   → `h-full` を外して **中身の分だけの高さ** にする。伸ばす指示は親の grid からも外す。
 * ⚠ `overflow-hidden` は残す(角の丸みと下の色帯のため)。高さを決める物ではない。
 */
function StatCard({ tone = 'slate', icon: Icon, label, children }) {
  const t = TONE[tone] || TONE.slate;
  return (
    <article className={`relative overflow-hidden bg-white border ${t.edge} shadow-sm rounded-xl px-3 pt-2.5 pb-3.5`}>
      <div className="flex items-center gap-1.5">
        {Icon ? <Icon className={`w-3.5 h-3.5 shrink-0 ${t.value}`} /> : null}
        <span className="text-2xs font-bold text-slate-500 tracking-wide">{label}</span>
      </div>
      {children}
      <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 h-1 ${t.bar}`} />
    </article>
  );
}

/**
 * カードの中の「長い内訳」を畳む札(2026-08-30 清水さんの指摘1)。
 *
 * 🚨 畳んでも **一番大事な1行(結論)は必ず見えている**。畳むのは内訳だけ。
 *   ここで畳む物は1つも消えていない。押せば全部そのまま出る。
 * 🚨 押す所は 36px 以上の高さを取る(指で押せる大きさ)。
 * 🚨 描画関数の中でコンポーネントを定義しない決まりなので、このファイルの一番上に置く。
 * ⚠ `open` は端末の中の見た目だけ。ロットのデータにも設定にも1バイトも書かない。
 *
 * @param {string} props.summary 畳んでいる時に出す1行(何が入っているか)
 * @param {boolean} props.quiet  技術寄りの物を **目立たせない** 時に true。
 *   色を灰へ落とす。判断に使う物(判断カードの内訳)は既定のまま=cyan。
 */
function Fold({
  summary, children, defaultOpen = false, quiet = false, openLabel = '詳細を見る',
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const Icon = open ? ChevronDown : ChevronRight;
  const accent = quiet ? 'text-slate-500' : 'text-cyan-700';
  return (
    <div className="mt-2 pt-1.5 border-t border-slate-200">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-1 min-h-11 px-1 -mx-1 rounded-lg text-left hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-cyan-400"
      >
        <Icon className={`w-3.5 h-3.5 shrink-0 ${accent}`} />
        <span className="flex-1 min-w-0 text-2xs text-slate-500 leading-snug">{summary}</span>
        <span className={`shrink-0 text-2xs font-bold ${accent}`}>{open ? '畳む' : openLabel}</span>
      </button>
      {open ? <div className="pt-1">{children}</div> : null}
    </div>
  );
}

// 4枚の中の「主役でない行」。主役の数字と混ざらないよう、必ず線の下に置く。
function SubLine({ label, value, tone = 'slate' }) {
  const t = TONE[tone] || TONE.slate;
  return (
    <div className="flex items-baseline gap-1.5 leading-snug">
      <span className="text-2xs text-slate-500">{label}</span>
      <b className={`text-xs font-black tabular-nums ${t.value}`}>{value}</b>
    </div>
  );
}

// 「この先で遅れる」と「手が付けられない」を **同じ大きさ** で並べるための札。
// 🚨 片方だけ小さくしない。欠員のシナリオで動くのは右側なので、小さくすると画面が死ぬ。
function BigCount({ label, value, danger }) {
  return (
    <div className="min-w-0">
      <div className="text-2xs text-slate-500 leading-tight">{label}</div>
      <div className="flex items-baseline gap-1">
        <span className={`text-3xl font-black leading-none tabular-nums ${danger ? 'text-rose-600' : 'text-slate-700'}`}>
          {value == null ? '—' : fmtInt(value)}
        </span>
        {value == null ? null : <span className="text-xs font-black text-slate-500">件</span>}
      </div>
    </div>
  );
}

/**
 * 押すと一覧が開く件数（T027）。
 * 🚨 押せない数字は確かめようがない。onOpen が渡されていない時だけ、押せない見た目に戻す。
 * 🚨 一覧が空(0件)や、そもそも渡されていない時は押させない（開いても何も無い窓を出さない）。
 */
function ClickableCount({ label, value, danger, onOpen, req }) {
  const ids = Array.isArray(req && req.lotIds) ? req.lotIds : null;
  const can = typeof onOpen === 'function' && ids != null && ids.length > 0;
  const inner = <BigCount label={label} value={value} danger={danger} />;
  if (!can) return inner;
  return (
    <button
      type="button"
      onClick={() => onOpen(req)}
      title={`${label}の一覧を開きます（${ids.length}ロット）`}
      className="w-full text-left rounded-lg -m-1 p-1 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-cyan-400"
    >
      {inner}
      <span className="mt-0.5 block text-2xs font-bold text-cyan-700">押すと一覧が出ます</span>
    </button>
  );
}

/** 押すと一覧が開く小さい行（T027）。 */
function ClickableSub({ label, tone, value, onOpen, req }) {
  const ids = Array.isArray(req && req.lotIds) ? req.lotIds : null;
  const can = typeof onOpen === 'function' && ids != null && ids.length > 0;
  if (!can) return <SubLine label={label} tone={tone} value={value} />;
  return (
    <button
      type="button"
      onClick={() => onOpen(req)}
      title={`${label}の一覧を開きます（${ids.length}ロット）`}
      className="w-full text-left rounded-lg hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-cyan-400"
    >
      <SubLine label={`${label} ▸`} tone={tone} value={value} />
    </button>
  );
}

/** 件数つきの小さな札。単位を必ず書く（工程かロットか分からなくしない）。 */
function Pill({ tone, label, n }) {
  const t = {
    rose: 'border-rose-200 bg-white text-rose-700',
    amber: 'border-amber-200 bg-white text-amber-700',
    slate: 'border-slate-200 bg-white text-slate-600',
  }[tone] || 'border-slate-200 bg-white text-slate-600';
  return (
    <span className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-2xs ${t}`}>
      <Signal level={tone === 'rose' ? 'danger' : tone === 'amber' ? 'warn' : 'unknown'} size="w-3 h-3" />
      <span className="text-slate-600">{label}</span>
      <Dots count={n} cap={10} tone={tone === 'rose' ? 'late' : tone === 'amber' ? 'idle' : 'quiet'} size="w-2 h-2" title="工程の数" />
      <b className="tabular-nums">{fmtInt(n)}工程</b>
    </span>
  );
}

function PillGroup({ ariaLabel, items, activeKey, onPick }) {
  return (
    <div role="group" aria-label={ariaLabel} className="inline-flex flex-wrap gap-1 p-1 rounded-xl bg-slate-100 border border-slate-200">
      {items.map((it) => {
        const on = it.key === activeKey;
        return (
          <button
            key={it.key}
            type="button"
            title={it.hint || ''}
            aria-pressed={on}
            onClick={() => onPick && onPick(it.key)}
            className={`min-h-11 px-3 rounded-lg text-xs font-bold transition-colors ${
              // 🚨 2026-09-04: 白文字 on cyan-500 は明暗差 2.43（小さい字に要る 4.5 に届かない）。
              //   いま選ばれている札が一番読みにくい、が起きていた。地色を濃くして白文字が読めるようにする。
              on ? 'bg-cyan-700 text-white shadow-sm' : 'text-slate-600 hover:bg-white'
            }`}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

function ToolButton({ onClick, disabled, icon: Icon, children, tone = 'plain' }) {
  const skin = tone === 'accent'
    // 🚨 2026-09-04: 白文字は cyan-500 / amber-500 の上では読めない（明暗差 2.4／2.1）。濃い段へ。
    ? 'bg-cyan-700 border-cyan-700 text-white hover:bg-cyan-800'
    : tone === 'warn'
      ? 'bg-amber-700 border-amber-700 text-white hover:bg-amber-800'
      : 'bg-white border-slate-300 text-slate-700 hover:border-cyan-400 hover:text-cyan-700';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!!disabled}
      className={`inline-flex items-center gap-1.5 min-h-11 px-3 rounded-lg border text-xs font-bold transition-colors disabled:opacity-40 ${skin}`}
    >
      {Icon ? <Icon className="w-3.5 h-3.5 shrink-0" /> : null}
      {children}
    </button>
  );
}

/**
 * 画面4分割のタブバー(2026-08-30)。シナリオのピル(cyan)と見分けが付くよう violet で塗る。
 * 🚨 押しても計算は走らない(見せ方の切替だけ)。だから何度押しても答えは1つのまま。
 */
/* ===========================================================================
 * 結論の1行（2026-09-01）
 * ---------------------------------------------------------------------------
 * 🚨 盤面タブでも、盤だけを画面いっぱいに出した時でも、**結論だけは必ず残す**。
 *   「守れる/守れない・この先で最初に越える日時・主な原因」が消えると、
 *   盤が大きくなっても『で、どうなの』が読めない画面になる。
 *
 * 🚨🚨 同じ数字を2つの計算から出さない（2026-08-30 の指示）。
 *   ここに置いた3つの関数が **ただ1本の出どころ** で、
 *   Header の見通しカード・盤面タブの1行・画面いっぱいの帯が、全部これを読む。
 *   前は Header の中だけに書いてあり、別の場所で出そうとすると必ず写しになった。
 *
 * ⚠ 下の4つの関数は **わざと export していない**。
 *   外へ出すと eslint の react-refresh/only-export-components が1件ずつ増える
 *   （このファイルは部品を出すファイルなので）。外から要るのは <BoardConclusionLine> だけで、
 *   それは部品だから出してよい。数字が要る所には、この部品ごと置く事
 *   ＝ 数字を写して別の場所で組み立て直す道を、最初から作らない。
 * ========================================================================= */

/** 🚨 この3つは別々に数える。1つの数字にまとめない。 */
function opsimTallyOf(lotResults, explain) {
  const rows = Array.isArray(lotResults) ? lotResults : [];
  let late = 0;
  let pastDue = 0;
  let unjudgeable = 0;
  let worst = null;
  // 帯の積み棒(2026-09-02 決まり8)用の、重ならない5つ。足すと rows.length になる。
  //   pastDueDeep … すでに過ぎていて見立ても出ている / pastDueShallow … 過ぎているが見立てが出ない(到着なし等)
  //   late … この先で遅れる / unjudgeable(この先) … 判定がつかない / ok … 守れる
  let pastDueDeep = 0;
  let pastDueShallow = 0;
  let unjudgeableAhead = 0;
  let ok = 0;
  rows.forEach((r) => {
    if (!r) return;
    // 🚨 「この先で遅れる」に、すでに予定日を過ぎている物を足さない。
    //   足すと札の文言(この先で)と中身(合計)が食い違う。実測でこの画面が 35件を81件と出していた。
    if (r.late && !r.alreadyPastDue) late += 1;
    if (r.alreadyPastDue) pastDue += 1;
    if (r.judgeable === false) unjudgeable += 1;
    if (r.alreadyPastDue) { if (r.judgeable === false) pastDueShallow += 1; else pastDueDeep += 1; }
    else if (r.late) { /* late に数えた */ }
    else if (r.judgeable === false) unjudgeableAhead += 1;
    else ok += 1;
    // 🚨 「最大の遅れ」も、この先の見込みだけで出す。すでに予定日を過ぎている物を混ぜると
    //   42日 のような数が出て、これから何が起きるかの話に見えなくなる。
    if (!r.alreadyPastDue && typeof r.lateMs === 'number' && Number.isFinite(r.lateMs)) {
      if (worst == null || r.lateMs > worst) worst = r.lateMs;
    }
  });
  const hasRows = rows.length > 0;
  // explain.maxLateMs は「すでに過ぎている物」も含む合計側の値。行があるならこちらを優先する。
  const maxLateMs = hasRows ? worst : (typeof explain?.maxLateMs === 'number' ? explain.maxLateMs : null);
  return {
    // explain 側も「この先だけ」の一覧(forecastLateLots)を持っている。lateLots は合計なので使わない。
    late: hasRows ? late : (Array.isArray(explain?.forecastLateLots) ? explain.forecastLateLots.length : null),
    pastDue: hasRows ? pastDue : null,
    unjudgeable: hasRows ? unjudgeable : null,
    maxLateMs,
    // 帯の積み棒。行が無い時は null(0 と書かない)。
    segments: hasRows ? { pastDueDeep, pastDueShallow, late, unjudgeableAhead, ok, total: rows.length } : null,
  };
}

/**
 * 帯の積み棒の5段。🚨 色の意味は固定(全画面で同じ):
 *   濃い赤=いま遅れている(見立てあり) / 薄い赤=いま遅れている(見立てなし) / 赤の斜線=これから遅れる /
 *   緑=守れる / 灰=判定がつかない。文字は札だけ。
 */
const SIGNAL_SEGMENTS = [
  { key: 'pastDueDeep', label: 'いま遅れている', cls: 'bg-rose-600' },
  { key: 'pastDueShallow', label: 'いま遅れている（見立てなし）', cls: 'bg-rose-300' },
  { key: 'late', label: 'これから遅れる', cls: '', hatch: true },
  { key: 'ok', label: '守れる', cls: 'bg-emerald-500' },
  { key: 'unjudgeableAhead', label: '判定がつかない', cls: 'bg-slate-300' },
];
const HATCH_STYLE = Object.freeze({
  backgroundImage: 'repeating-linear-gradient(135deg, rgb(225 29 72) 0 0.4rem, rgb(255 228 230) 0.4rem 0.8rem)',
});

/**
 * 今日の判断の一番上の「信号1つ」の帯(2026-09-02 決まり6・8)。
 * 🚨 大きい字は **答え**(守れる/守れない/保留)だけ。件数は積み棒の長さで言い、数字は札に小さく添える。
 * 🚨 中身は opsimVerdictOf / opsimTallyOf / opsimForecastWhenOf(このファイルの上)から。ここで数え直さない。
 * 🚨 「遅れて完了」は見立て(lotResults)の外(完了したロット)なので積み棒に混ぜず、右の札で言う(決まり10)。
 */
/**
 * 内訳の積み棒 **ただ1本**(2026-09-15)。
 * 🚨 ここで数えない。opsimTallyOf が出した tally.segments をそのまま長さに変えるだけ。
 * 🚨 色と順番は SIGNAL_SEGMENTS ただ1本(今日の判断と盤面で同じ絵になる)。
 * ⚠ vizKit の StackBar は使わない。あちらの tone は4つ(late/lateSoon/ahead/quiet)しか無く、
 *   「いま遅れている(見立てあり)」と「(見立てなし)」を1色に潰す＝決まり8 の5段が4段に減る
 *   ＝情報を消す事になるから(決まり6「消さない」)。
 * @param {string} height 今日の判断=h-5(主役) / 盤面の結論の1行=h-2(行の高さを1pxも増やさない)
 */
function SignalStackBar({ seg, total, height = 'h-5', className = '' }) {
  const t = Number(total);
  if (!seg || !(t > 0)) return null;
  return (
    <div
      className={`flex ${height} w-full overflow-hidden rounded-md border border-white bg-slate-100 ${className}`}
      role="img"
      aria-label="ロットの内訳の積み棒"
    >
      {SIGNAL_SEGMENTS.map((s) => {
        const n = Number(seg[s.key]) || 0;
        if (!n) return null;
        return (
          <span
            key={s.key}
            data-signal-seg={s.key}
            data-signal-n={n}
            className={`h-full ${s.cls}`}
            style={{ width: `${(n / t) * 100}%`, ...(s.hatch ? HATCH_STYLE : {}) }}
            title={`${s.label} ${fmtInt(n)}件`}
          />
        );
      })}
    </div>
  );
}


function TodaySignalBand({
  v, vt, tally, forecastWhen, causeTitle, remedyLabel, remedyDrop,
  lateDoneCount = null, lateDoneWindowText = '', lateDoneMaxDays = null,
}) {
  const seg = tally && tally.segments;
  const total = seg ? seg.total : 0;
  const bandBg = v.tone === 'rose' ? 'bg-rose-50' : v.tone === 'emerald' ? 'bg-emerald-50' : v.tone === 'amber' ? 'bg-amber-50' : 'bg-slate-50';
  return (
    <section
      data-today-signal={v.tone}
      className={`flex flex-col gap-2 rounded-2xl border-2 px-4 py-3 ${vt.edge} ${bandBg}`}
      aria-label="今日の判断の信号"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="inline-flex items-center gap-2">
          <v.icon className={`h-8 w-8 shrink-0 ${vt.value}`} />
          <span className={`text-3xl font-black leading-none ${vt.value}`}>{v.title}</span>
        </span>
        <span className="text-xs leading-snug text-slate-600">{v.sub}</span>
        {lateDoneCount == null ? null : (
          <span
            className="ml-auto inline-flex items-baseline gap-1 rounded-lg border border-slate-300 bg-slate-100 px-2 py-1"
            data-late-done-count={lateDoneCount}
            title={`納期を過ぎてから完了した物(${lateDoneWindowText || '期間は下の札に'})。完了しても消しません。下の「遅れて完了した」に1本ずつ出ます`}
          >
            <span className="text-2xs font-bold text-slate-600">遅れて完了</span>
            <b className="text-xl font-black leading-none tabular-nums text-rose-600">{fmtInt(lateDoneCount)}</b>
            <span className="text-2xs font-bold text-slate-600">件</span>
            {lateDoneMaxDays == null ? null : <span className="text-2xs text-slate-500">（最大 +{fmtInt(lateDoneMaxDays)}日）</span>}
            {lateDoneWindowText ? <span className="text-2xs text-slate-500">{lateDoneWindowText}</span> : null}
          </span>
        )}
      </div>
      {seg && total > 0 ? (
        <div className="flex flex-col gap-1">
          <SignalStackBar seg={seg} total={total} height="h-5" />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-slate-600">
            {SIGNAL_SEGMENTS.map((s) => (
              <span key={s.key} className="inline-flex items-center gap-1">
                <span className={`inline-block h-2.5 w-4 rounded-sm ${s.cls}`} style={s.hatch ? HATCH_STYLE : undefined} />
                {s.label} <b className="tabular-nums text-slate-800">{fmtInt(Number(seg[s.key]) || 0)}</b>
              </span>
            ))}
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-2.5 w-4 rounded-sm bg-slate-400" />
              遅れて完了 <span className="font-black text-rose-600">+N日</span>
            </span>
            <span className="ml-auto text-slate-400">全 {fmtInt(total)}ロット（見立てに載せた分）</span>
          </div>
        </div>
      ) : (
        <div className="text-2xs text-slate-500">見立ては まだ計算していません。計算が終わると、ここに積み棒(いま遅れている・これから遅れる・守れる・判定がつかない)が出ます</div>
      )}
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-2xs text-slate-600">
        {forecastWhen ? (
          <span>この先で最初に越える <b className="tabular-nums text-rose-700">{forecastWhen.head}</b><span className="text-slate-400"> {forecastWhen.year}</span></span>
        ) : null}
        {causeTitle ? <span>主な原因 <b className="text-cyan-700">{causeTitle}</b></span> : null}
        {remedyLabel ? (
          <span>
            一番効く手 <b className="text-cyan-700">{remedyLabel}</b>
            {remedyDrop ? <b className="ml-1 text-emerald-700 tabular-nums">（遅れが {fmtInt(remedyDrop)}件 減ります）</b> : null}
          </span>
        ) : null}
      </div>
    </section>
  );
}

/** 到着の情報が足りないロット(T027 の4つ目)。inputQuality から取る。無ければ null。 */
function opsimArrivalShortOf(inputQuality) {
  if (!inputQuality) return null;
  const a = Number(inputQuality.arrivalOverdueCount) || 0;
  const b = Number(inputQuality.arrivalUnknownCount) || 0;
  return (a + b) > 0 ? a + b : null;
}

/**
 * 「この先で最初に越える日時」。
 * 🚨 forecastBreachAt（この先で最初に越える時刻）を使う。
 *   breachAt は「すでに予定日を過ぎている物」も入った時刻なので、
 *   人を増やしても減らしても動かない＝シナリオの効き目が見えなくなる。
 */
function opsimForecastWhenOf(explain) {
  const ms = (explain && typeof explain.forecastBreachAt === 'number' && Number.isFinite(explain.forecastBreachAt))
    ? explain.forecastBreachAt
    : null;
  return fmtWhen(ms);
}

/**
 * 見通しの言い方。verdict は safe / breach / unknown の3つだけ。
 * 🚨 2026-08-30 清水さんの指摘で直した: unknown なのに隣で「最初の突破 9/4・遅れ1件」が
 *   出ていて矛盾に見えた。**分かっている遅れが1件でもあるなら**「暫定見通し」として言い、
 *   全体判定は保留である事と保留の理由(判定がつかないロット数)を同じカードで言う。
 */
function opsimVerdictOf({ verdict, maxD, tally, arrivalShort }) {
  if (verdict === 'safe') {
    return { tone: 'emerald', icon: ShieldCheck, title: `${maxD}日後まで守れます`, sub: 'この見立てでは、納期線を越えるロットはありません' };
  }
  if (verdict === 'breach') {
    return { tone: 'rose', icon: ShieldAlert, title: `${maxD}日後まで守れません`, sub: 'この見立てでは、納期線を越えるロットがあります' };
  }
  if (verdict === 'unknown') {
    const knownLate = numOrNull(tally && tally.late);
    const holdN = numOrNull(tally && tally.unjudgeable) ?? arrivalShort;
    if (knownLate != null && knownLate > 0) {
      return {
        tone: 'amber', icon: ShieldAlert, small: true,
        title: `暫定見通し: 少なくとも${fmtInt(knownLate)}件 遅れる見込み`,
        sub: `全体判定は保留${holdN != null ? `: 判定がつかないロットが ${fmtInt(holdN)}件(到着未確認など)` : '(入っていない値があります)'}。入っている値だけで見た暫定です`,
      };
    }
    return { tone: 'slate', icon: HelpCircle, title: '全体判定は保留', sub: `入っていない値があるので、守れるかどうかをまだ言えません${holdN != null ? `(判定がつかないロット ${fmtInt(holdN)}件)` : ''}` };
  }
  return { tone: 'slate', icon: HelpCircle, title: 'まだ計算していません', sub: '見る範囲を選ぶと出ます' };
}

/**
 * 結論の1行。盤面タブの上と、盤だけを画面いっぱいに出した時の帯で **同じ物**を出す。
 * 🚨 中の数字は上の3関数から。ここでは1つも計算しない。
 * @param {React.ReactNode} [props.right] 行の右端に足す物（閉じるボタンなど）
 */
/**
 * 結論の丸の色(案A・2026-09-16 Main.dc.html)。🚨 結論は **色の丸** で言う(字を全部消しても分かる)。
 *   rose=守れない / emerald=守れる / amber=暫定 / slate=保留・まだ。opsimVerdictOf の tone と1対1。
 */
const VERDICT_DOT = {
  rose: 'bg-rose-500 ring-4 ring-rose-500/30',
  emerald: 'bg-emerald-500 ring-4 ring-emerald-500/30',
  amber: 'bg-amber-400 ring-4 ring-amber-400/30',
  slate: 'bg-slate-400 ring-4 ring-slate-400/30',
};

/** 濃い帯の上の数字の札(いま遅れ／この先／全)。🚨 数は渡された物をそのまま出す(ここで数えない)。null は「—」。 */
function BandCount({ label, value, tone = 'white' }) {
  const cls = tone === 'rose' ? 'text-rose-300' : tone === 'pink' ? 'text-rose-200' : 'text-white';
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap text-2xs text-slate-300">
      <b className={`text-base font-black leading-none tabular-nums ${cls}`}>{value == null ? '—' : fmtInt(value)}</b>
      {label}
    </span>
  );
}

/**
 * 結論の帯(案A・2026-09-16)。**濃い地(slate-900)に 1文 ＋ 数字の札 ＋ 基準時刻** を1行に。
 * 盤面タブの上と、盤だけを画面いっぱいに出した時の帯で **同じ物**を出す。
 * 🚨 中の数字は上の3関数から。ここでは1つも計算しない。
 * 🚨 結論は色の丸(VERDICT_DOT)で言い、字は札だけ。積み棒(SignalStackBar)は消さず札の横に h-2 で置く(同じ tally ただ1本)。
 * @param {React.ReactNode} [props.right]    基準時刻など、文の右に添える物
 * @param {React.ReactNode} [props.controls] 帯の右端に置く押す物(期間・時間を進める・設定)。親が渡す。無ければ出さない
 */
/** 帯の3行目の札の色。🚨 色の意味は固定: 赤=止まる/直す ・ 琥璜=仮に置いている ・ 灰=数え方の断り。 */
const BASIS_CHIP_TONE = Object.freeze({
  rose: 'border-rose-300 bg-rose-50 text-rose-800',
  amber: 'border-amber-300 bg-amber-50 text-amber-900',
  slate: 'border-slate-300 bg-slate-100 text-slate-700',
});

/**
 * 帯の3行目「この答えの土台」(2026-09-18 案A・絵 Main.dc.html ①)。
 * 🚨 ここで数を 1つも作らない。親が渡した札を並べるだけ
 *   (同じ数字を 2つの計算から出さない― 畳んだ警告の1行と **同じ変数** から来る)。
 * 🚨 0件の札は親が渡さない(無い物を札にしない)。
 */
function BasisChips({ items = null, onPick = null }) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return null;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5" data-opsim-basis-chips={String(list.length)}>
      <span className="text-2xs font-black text-slate-400" title="押すと一覧が開きます">この答えの土台</span>
      {list.map((c) => (
        <button
          key={c.key}
          type="button"
          data-opsim-basis-chip={c.key}
          onClick={() => { if (typeof onPick === 'function') onPick(c.key); }}
          title={`${c.title || ''}（押すと、畳んである警告の帯がそのまま出ます。何も確定しません）`}
          className={`inline-flex min-h-11 items-center gap-1 rounded-full border px-2.5 text-2xs font-black ${BASIS_CHIP_TONE[c.tone] || BASIS_CHIP_TONE.slate}`}
        >
          {c.label}
          <b className="tabular-nums">{Number(c.n).toLocaleString('ja-JP')}{c.suffix ? c.suffix : ''}</b>
        </button>
      ))}
    </span>
  );
}

export function BoardConclusionLine({
  explain = null,
  lotResults = [],
  maxDay = 5,
  inputQuality = null,
  causeTiers = null,
  right = null,
  note = null,
  controls = null,
  /** 🧮 2026-09-18 案A: 帯の3行目「この答えの土台」の札(親が作った数をそのまま受ける)。 */
  basis = null,
  onBasisPick = null,
  /** 🧭 2026-09-23: 今日決めること(3つ)＋理由の表。親が組んだ部品(<TodayDecisions>)をそのまま置く。 */
  decisions = null,
}) {
  const maxD = Number(maxDay) > 0 ? Number(maxDay) : 5;
  const tally = opsimTallyOf(lotResults, explain);
  const arrivalShort = opsimArrivalShortOf(inputQuality);
  const v = opsimVerdictOf({ verdict: explain?.verdict || null, maxD, tally, arrivalShort });
  const forecastWhen = opsimForecastWhenOf(explain);
  const dot = VERDICT_DOT[v.tone] || VERDICT_DOT.slate;
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-xl bg-slate-900 px-3 py-1 text-white"
      data-opsim-conclusion={v.tone}
    >
      <span className="inline-flex min-w-0 items-center gap-3">
        <span aria-hidden="true" data-opsim-verdict-dot={v.tone} className={`inline-block h-3.5 w-3.5 shrink-0 rounded-full ${dot}`} />
        {/* 1文だけ大きく。理由(v.sub)は title へ(消していない)。 */}
        <span className="text-lg font-black leading-tight tracking-tight" title={v.sub}>{v.title}</span>
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
        {/* 🚨 件数の札。null は 0 と書かず「—」。積み棒は同じ tally から(同じ数字を2つの計算から出さない)。 */}
        {tally.segments && tally.segments.total > 0 ? (
          /* 📱 2026-09-24 スマホ(390px)で件数の札3つ＋積み棒が1行に並ばず 横へ 187px はみ出していた(写しで実測)。折り返す。 */
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1" data-opsim-conclusion-bar={tally.segments.total}>
            <BandCount label="いま遅れ" value={tally.pastDue} tone="rose" />
            <BandCount label="この先で遅れる" value={tally.late} tone="pink" />
            <BandCount label="載せたロット" value={tally.segments.total} />
            <span className="inline-flex w-24 shrink-0">
              <SignalStackBar seg={tally.segments} total={tally.segments.total} height="h-2" />
            </span>
          </span>
        ) : null}
        {forecastWhen ? (
          <span className="text-2xs text-slate-300 sm:whitespace-nowrap">
            {/* 🚨 fmtWhen は文字列ではなく {head, year} を返す。そのまま描くと
                React が「Objects are not valid as a React child」で落ちる（実際に落とした）。 */}
            この先で最初に越える日時 <b className="tabular-nums text-rose-300">{forecastWhen.head}</b>
            <span className="text-slate-500"> {forecastWhen.year}</span>
          </span>
        ) : null}
        {causeTiers && causeTiers.primary ? (
          <span className="text-2xs text-slate-300" title={causeTiers.primary.detail || ''}>
            主な原因 <b className="text-cyan-300">{causeTiers.primary.label}</b>
          </span>
        ) : null}
        {note ? <span className="text-2xs text-slate-400">{note}</span> : null}
      </span>
      {/* 📐 2026-09-18 夜: 基準時刻は件数の段の外へ(土台の札と同じ行に並ぶ＝帯が3行→2行)。 */}
      {right ? <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5" data-opsim-band-right="1">{right}</span> : null}
      {controls ? (
        <span className="ml-auto flex shrink-0 flex-wrap items-center gap-2" data-opsim-band-controls="">{controls}</span>
      ) : null}
      {/* 土台の1行は **帯の中の3行目**。答えが何の上に載っているかを隠さない。 */}
      <BasisChips items={basis} onPick={onBasisPick} />
      {decisions}
    </div>
  );
}


/* ===========================================================================
 * 拡大（画面いっぱい）の時に盤の上へ残す **1行の操作帯**（2026-09-04 決まり20）
 * ---------------------------------------------------------------------------
 * 🚨 清水さん「拡大したらロットの流れの再生が全くボタンがないからできない」。
 *   実測（1280×800・本番の写し633ロット・拡大の前→後）で消えていたのは再生だけではない:
 *     ⏱の引き出し / シナリオの引き出し / 再生・一時停止 / 1こま戻る / 1こま送る /
 *     最初へ戻す / つまみ / 進み方の2つ / 基準時刻の2択 / 画面のタブ4つ
 *   ＝ 15種のうち **13種が押せなくなっていた**（DOM には残るが fixed の帯に覆われる）。
 *   残っていたのは 見せ方の切替3つ と × 閉じる だけ。
 *   拡大ボタンの title は「結論の1行は残ります」と書いていたが、**操作は残らなかった**。
 *
 * 🚨 この帯は「よく使う物だけを横一列」。消した物は1つも無く、残りは ▾ の引き出しへ。
 * 🚨 中身は playPace.js（刻み・速さの表）と opsimElapsedText ただ1本から出す。
 *   盤面タブの⏱の引き出しと **同じ関数** を読むので、2つの計算から同じ数字が出る事は無い。
 * 🚨 px を直書きしない。高さは min-h-11（2.25rem）＝ 文字サイズ設定で伸び縮みする。
 * 🚨 CSS の zoom / transform: scale は使わない（押す位置がズレる。2026-08-08 に廃止）。
 * =========================================================================== */
export function BoardFullStrip({
  // 時間
  day = 0, maxDay = 5, onDay = null, playing = false, onTogglePlay = null, onReset = null,
  playStep = OPSIM_STEP_DEFAULT, onPlayStep = null,
  playMs = OPSIM_PLAY_MS_DEFAULT, onPlayMs = null,
  dayCapMs = null,
  // 基準時刻
  baseNow = null, baseNowWanted = null, baseMode = BASE_TIME_MODE.NOW, onBaseMode = null,
  // 見せ方（流れ / 人 / 納期）。親の VIEW_MODES をそのまま受ける（写しを作らない）。
  viewMode = null, onViewMode = null, viewItems = null,
  // シナリオ
  scenarioKey = 'normal', onScenario = null, enabledScenarios = null,
  // 閉じる
  onClose = null,
}) {
  const [more, setMore] = useState(false);
  const maxD = Number(maxDay) > 0 ? Number(maxDay) : 5;
  const rawDay = Number.isFinite(Number(day)) ? round3(Number(day)) : 0;
  const nowDay = clamp(rawDay, 0, maxD);
  const stepChoice = opsimStepOf(playStep);
  const playMsChoice = opsimPlayMsOf(playMs);
  const stepDays = opsimStepDays(stepChoice.key, dayCapMs);
  const snapDay = (n) => clamp(round3(Math.round((Number(n) || 0) / stepDays) * stepDays), 0, maxD);
  // 🚨「＋2時間」を押したら「2時間ぶん」と言う。日は横に小さく添える（決まり20の⚠）。
  const elapsed = opsimElapsedText(nowDay, stepChoice.key, dayCapMs);
  const when = fmtWhen(numOrNull(baseNow) ?? numOrNull(baseNowWanted));
  const items = Array.isArray(viewItems) ? viewItems : [];
  const scenarioItems = Array.isArray(enabledScenarios) && enabledScenarios.length
    ? OPSIM_SCENARIOS.filter((s) => enabledScenarios.includes(s.key))
    : OPSIM_SCENARIOS;

  return (
    <div data-opsim-full="strip" className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-cyan-200 bg-white px-2 py-1">
        <span className="inline-flex shrink-0 items-baseline gap-1 rounded-lg border border-cyan-200 bg-cyan-50 px-2 py-1">
          <span className="text-2xs font-bold text-slate-500">{nowDay <= 0 ? '' : 'いまから'}</span>
          <b data-opsim-full-ctl="elapsed" className="text-sm font-black tabular-nums text-cyan-700">{elapsed.main}</b>
          {elapsed.sub ? <span className="text-2xs text-slate-500">（{elapsed.sub}）</span> : null}
        </span>

        <button
          type="button"
          data-opsim-full-ctl="stepback"
          onClick={() => { if (onDay) onDay(snapDay(nowDay - stepDays)); }}
          disabled={nowDay <= 0}
          title={`1こま戻す（${stepChoice.label}ぶん）`}
          className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 text-2xs font-bold text-slate-700 hover:border-cyan-400 disabled:opacity-40"
        >
          <Rewind className="h-3.5 w-3.5 shrink-0" />
          {`−${stepChoice.label}`}
        </button>

        <button
          type="button"
          data-opsim-full-ctl="play"
          onClick={() => { if (onTogglePlay) onTogglePlay(); }}
          title={playing ? '止めます' : `${playMsChoice.label}ごとに1こま（${stepChoice.label}）ずつ進めます`}
          className={`inline-flex min-h-11 items-center gap-1 rounded-lg border px-3 text-2xs font-black ${playing
            ? 'border-amber-700 bg-amber-700 text-white hover:bg-amber-800'
            : 'border-cyan-700 bg-cyan-700 text-white hover:bg-cyan-800'}`}
        >
          {playing ? <Pause className="h-3.5 w-3.5 shrink-0" /> : <Play className="h-3.5 w-3.5 shrink-0" />}
          {playing ? '一時停止' : '再生'}
        </button>

        <button
          type="button"
          data-opsim-full-ctl="stepfwd"
          onClick={() => { if (onDay) onDay(snapDay(nowDay + stepDays)); }}
          disabled={nowDay >= maxD}
          title={`1こま進める（${stepChoice.label}ぶん）`}
          className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 text-2xs font-bold text-slate-700 hover:border-cyan-400 disabled:opacity-40"
        >
          <FastForward className="h-3.5 w-3.5 shrink-0" />
          {`＋${stepChoice.label}`}
        </button>

        <label className="flex min-w-[10rem] flex-1 items-center gap-1.5">
          <span className="sr-only">何日目まで進めるか</span>
          <input
            data-opsim-full-ctl="slider"
            type="range"
            min={0}
            max={maxD}
            step={Math.max(0.01, Math.round(stepDays * 1000) / 1000)}
            value={nowDay}
            onChange={(e) => { const v = Number(e.target.value); if (onDay) onDay(snapDay(Number.isFinite(v) ? v : 0)); }}
            aria-label="何日目まで進めるか"
            className="h-9 flex-1 cursor-pointer accent-cyan-600"
          />
          <span className="shrink-0 text-3xs text-slate-500">{`${maxD}日`}</span>
        </label>

        <button
          type="button"
          data-opsim-full-ctl="reset"
          onClick={() => { if (onReset) onReset(); }}
          title="いま（0.0日ぶん）へ戻します。計算はやり直しません。"
          className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 text-2xs font-bold text-slate-700 hover:border-cyan-400"
        >
          <RotateCcw className="h-3.5 w-3.5 shrink-0" />
          最初へ
        </button>

        {/* 基準時刻は **読むだけ**（何時点の話かが読めないまま盤を見せない）。切替は ▾ の中。 */}
        <span data-opsim-full-ctl="base" className="inline-flex shrink-0 items-baseline gap-1 text-2xs text-slate-600">
          <CalendarClock className="h-3.5 w-3.5 shrink-0 self-center text-cyan-600" />
          基準
          {when
            ? <b className="font-black tabular-nums text-cyan-700">{when.head}</b>
            : <span className="text-slate-500">計算するまで まだ出せません</span>}
        </span>

        {/* 見せ方（流れ / 人 / 納期）。🚨 どれも同じ計算結果を置くだけで、答えは1つ。 */}
        <span role="group" aria-label="見せ方の切替" className="inline-flex shrink-0 flex-wrap gap-1">
          {items.map((m) => (
            <button
              key={m.key}
              type="button"
              data-opsim-full-ctl="view"
              data-opsim-full-view={m.key}
              aria-pressed={viewMode === m.key}
              onClick={() => { if (onViewMode) onViewMode(m.key); }}
              title={m.hint || ''}
              className={`min-h-11 rounded-full border px-2.5 text-3xs font-black leading-none ${viewMode === m.key
                ? 'border-cyan-700 bg-cyan-700 text-white'
                : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'}`}
            >
              {m.label}
            </button>
          ))}
        </span>

        <button
          type="button"
          data-opsim-full-ctl="more"
          aria-expanded={more}
          onClick={() => setMore((v) => !v)}
          title="進み方（刻み・速さ）・シナリオ・基準時刻の決め方を出します。1つも消していません。"
          className={`inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg border px-2 text-2xs font-bold ${more ? 'border-cyan-500 bg-cyan-50 text-cyan-700' : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'}`}
        >
          {`ほか ${more ? '▴' : '▾'}`}
        </button>

        <button
          type="button"
          data-opsim-full-ctl="close"
          onClick={() => { if (onClose) onClose(); }}
          title="盤を元の大きさに戻します（Esc でも閉じます）。何も確定しません。"
          className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 text-2xs font-bold text-slate-700 hover:bg-slate-50"
        >
          <X className="h-4 w-4 shrink-0" />
          閉じる
        </button>
      </div>

      {/* ▾ の引き出し。畳んだだけで、1つも消していない（決まり6）。 */}
      {more ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-slate-200 bg-white px-2 py-1.5">
          <span className="inline-flex items-center gap-1.5">
            <span className="text-3xs font-bold text-slate-500">進み方</span>
            <label className="flex items-center gap-1">
              <span className="sr-only">1こまで進む時間（刻み）</span>
              <select
                data-opsim-full-ctl="step"
                value={stepChoice.key}
                onChange={(e) => { if (typeof onPlayStep === 'function') onPlayStep(e.target.value); }}
                title={`1こまで進む時間。いまは「${stepChoice.label}」（${stepChoice.hint || ''}）`}
                className="min-h-11 rounded-md border border-slate-300 bg-white px-1.5 text-2xs font-bold text-slate-700"
              >
                {OPSIM_STEP_CHOICES.map((c) => <option key={c.key} value={c.key}>{`${c.label}ずつ`}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1">
              <span className="sr-only">1こまを何秒で送るか（再生の速さ）</span>
              <select
                data-opsim-full-ctl="pace"
                value={playMsChoice.key}
                onChange={(e) => { if (typeof onPlayMs === 'function') onPlayMs(e.target.value); }}
                title={`再生した時、1こまを何秒で送るか。いまは「${playMsChoice.label}」`}
                className="min-h-11 rounded-md border border-slate-300 bg-white px-1.5 text-2xs font-bold text-slate-700"
              >
                {OPSIM_PLAY_MS_CHOICES.map((c) => <option key={c.key} value={c.key}>{`${c.label}ごと`}</option>)}
              </select>
            </label>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="text-3xs font-bold text-slate-500">基準時刻</span>
            <PillGroup ariaLabel="基準時刻の決め方" items={BASE_TIME_ITEMS} activeKey={baseMode} onPick={onBaseMode} />
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="text-3xs font-bold text-slate-500">シナリオ</span>
            <PillGroup ariaLabel="シナリオ" items={scenarioItems} activeKey={scenarioKey} onPick={onScenario} />
          </span>
          <span className="basis-full text-3xs leading-snug text-slate-500">
            {/* 🚨 2026-09-05: 「条件・根拠」の札は無くなっています。行き先の無い案内を残さない。 */}
            くわしい内訳は「閉じる」を押すと、主役の下の「▾ くわしく」と [月] の画面で出ます。設定と数字の意味は 🧰 道具箱 の ⚙ です。
          </span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 画面の切替。
 * 🚨 2026-09-04 決まり19: 主役は **盤面 / 来月の手当て** の2つ。
 *   残りは `secondary:true` の札にして **強さを下げる**（消さない・移す・畳む）。
 * ⚠ tabs を渡さない呼び出し元は、今までの5つのまま動く。
 */
function TabBar({ tab, onTab, tabs = null }) {
  const list = (Array.isArray(tabs) && tabs.length) ? tabs : OPSIM_TABS;
  const main = list.filter((t) => !t.secondary);
  const sub = list.filter((t) => t.secondary);
  /* 案A(2026-09-16): 切替は **1段**。畳んだ札は「…その他」の1つに畳む(消さない・押せば全部出る)。
     ⚠ 開いているかは端末の中の見た目だけ。何も確定しない・何も送らない。 */
  const [moreOpen, setMoreOpen] = useState(false);
  const subOn = sub.find((t) => t.key === tab) || null;
  const pick = (key) => { setMoreOpen(false); if (typeof onTab === 'function') onTab(key); };
  return (
    <div className="relative inline-flex items-center" onKeyDown={(e) => { if (e.key === 'Escape') setMoreOpen(false); }}>
      <div role="tablist" aria-label="画面の切替" className="inline-flex flex-wrap items-center gap-1 rounded-xl border border-slate-200 bg-white p-1" data-opsim-tabs={String(main.length)}>
        {main.map((t) => {
          const on = t.key === tab;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              title={t.hint || ''}
              aria-selected={on}
              data-opsim-tab={t.key}
              onClick={() => pick(t.key)}
              className={`min-h-11 whitespace-nowrap rounded-lg px-4 text-sm font-black transition-colors ${
                on ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              {t.label}
            </button>
          );
        })}
        {/* 🚨 畳んだ画面。**消していない**（決まり19「移す・畳む・強さを変える。消さない」）。
            「…その他」を押すと畳んだ札がそのまま出る。いま畳んだ画面を見ている時は、その名前を札に出す。 */}
        {sub.length ? (
          <button
            type="button"
            data-opsim-tab-more=""
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            title={`ほかの画面（${sub.map((t) => t.label).join('・')}）を出します`}
            onClick={() => setMoreOpen((o) => !o)}
            className={`min-h-11 whitespace-nowrap rounded-lg px-3 text-sm font-bold transition-colors ${
              subOn ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-500 hover:bg-slate-100'
            }`}
          >
            {subOn ? `${subOn.label} ▾` : 'ほかの画面 ▾'}
          </button>
        ) : null}
      </div>
      {sub.length && moreOpen ? (
        <div
          role="menu"
          aria-label="ほかの画面"
          className="absolute left-0 top-full z-30 mt-1 flex min-w-max flex-col gap-0.5 rounded-xl border border-slate-200 bg-white p-1 shadow-lg"
        >
          {sub.map((t) => {
            const on = t.key === tab;
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                title={t.hint || ''}
                aria-selected={on}
                data-opsim-tab={t.key}
                data-opsim-tab-secondary=""
                onClick={() => pick(t.key)}
                className={`min-h-11 whitespace-nowrap rounded-lg px-3 text-left text-sm font-bold transition-colors ${
                  on ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// -----------------------------------------------------------------------------
// 本体
// -----------------------------------------------------------------------------
/* ===========================================================================
 * 🔘 BoardDrawerButtons — 盤面タブの「シナリオ：◯◯▾」「⏱ 時間を進める(…)▾」の2つ。
 * ---------------------------------------------------------------------------
 * 🚨 なぜ部品にしたか(2026-09-05 決まり31・清水さん「もう画面がぐちゃぐちゃになってる」):
 *   盤の主役(納期一覧)の上に段が **9つ** 積まれて、主役が画面の下端に居ました(実測 1467×795)。
 *   この2つのボタンは Header の一番上の行から、盤の上の **操作の1行[3]** へ移します。
 * 🚨 消していません。**同じ部品**を Header(渡されなかった時の今まで通りの場所)と
 *   OperationsSimulationPanel(操作の1行)の両方が呼ぶので、
 *   札に出る文字(いま選んでいるシナリオ・進めた量)は **1か所からしか出ません**
 *   ＝ 同じ数字を2つの計算から出していません。
 * 🚨 ここは **開け閉めのボタンだけ**。引き出しの中身(シナリオの札・再生のつまみ)は
 *   Header の今の場所のままです(1つも動かしていません)。
 * 🚨 何も確定しない・何も送らない・計算し直さない(見た目だけ)。
 * ========================================================================= */
export function BoardDrawerButtons({
  scenarioKey = 'normal',
  day = 0,
  maxDay = 5,
  playStep = OPSIM_STEP_DEFAULT,
  dayCapMs = null,
  /** null | 'scenario' | 'play'。開いているのはどれか(持ち主は親)。 */
  boardDrawer = null,
  /** 押した時に親へ知らせる。親が開け閉めを決める。 */
  onToggle = null,
}) {
  const maxD = Number(maxDay) > 0 ? Number(maxDay) : 5;
  // 🚨 0.0 を「1」に化けさせない。0.0 は「いま」という正しい値。
  const rawDay = Number.isFinite(Number(day)) ? round3(Number(day)) : 0;
  const nowDay = clamp(rawDay, 0, maxD);
  const scenarioLabel = (OPSIM_SCENARIOS.find((sc) => sc.key === scenarioKey) || {}).label || 'この条件';
  const stepChoice = opsimStepOf(playStep);
  // 🚨 中身は opsimElapsedText ただ1本(⏱の札・引き出しの大きい数字・拡大の帯が全部これを読む)。
  const elapsedText = opsimElapsedText(nowDay, stepChoice.key, dayCapMs);
  const toggleDrawer = (key) => { if (typeof onToggle === 'function') onToggle(key); };
  return (
    <>
              <button
                type="button"
                data-opsim-drawer="scenario"
                aria-expanded={boardDrawer === 'scenario'}
                onClick={() => toggleDrawer('scenario')}
                title="シナリオ（通常／残業／誰か休み／全員できる仮定／後継者／任せ替え）の札を出します。いま選んでいる物を横に書いています。"
                className={`min-h-11 rounded-lg border px-2.5 text-xs font-bold ${boardDrawer === 'scenario' ? 'border-cyan-500 bg-cyan-50 text-cyan-700' : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'}`}
              >
                {`シナリオ：${scenarioLabel} ${boardDrawer === 'scenario' ? '▴' : '▾'}`}
              </button>
              <button
                type="button"
                data-opsim-drawer="play"
                aria-expanded={boardDrawer === 'play'}
                onClick={() => toggleDrawer('play')}
                /* 🚨 2026-09-05: 「条件・根拠」タブは無いので、その名前で案内しない（行き先の無い案内）。
                   分かっていない事は ⚙ 設定の中と、各数字の ？ に在る。 */
                title="時間を進める操作（再生・1こま送り・つまみ・進み方）を出します。くわしい内訳は 主役の下の「▾ くわしく」（原因）と [月] の画面（手ごとの効き目・教育の案）、🧰 道具箱 の ⚙ 設定（分かっていない事・根拠）で出ます。"
                className={`min-h-11 rounded-lg border px-2.5 text-xs font-bold ${boardDrawer === 'play' ? 'border-cyan-500 bg-cyan-50 text-cyan-700' : 'border-cyan-300 bg-white text-cyan-700 hover:bg-cyan-50'}`}
              >
                {/* 🚨 押した量をそのまま言う（決まり20）。「＋2時間」なら「いまから 2時間ぶん」。 */}
                {`⏱ 時間を進める（${nowDay <= 0 ? 'いま' : `いまから ${elapsedText.main}${elapsedText.sub ? `＝${elapsedText.sub}` : ''}`}） ${boardDrawer === 'play' ? '▴' : '▾'}`}
              </button>
    </>
  );
}

export function Header({
  explain = null,
  lotResults = [],
  verdictLoading = false,
  progress = null,
  scenarioKey = 'normal',
  onScenario,
  day = 0,   // 🚨 elapsedDays 0.0〜5.0。0.0=いま（仕様書5.2 / T005）
  maxDay = 5,
  onDay,
  playing = false,
  onTogglePlay,
  /**
   * 時間の進み方（2026-08-30 清水さんの要望3）。**刻みと速さは別の札**。
   *   playStep … 1こまで進む量。OPSIM_STEP_CHOICES の key（既定 'd03' ＝ 旧「ふつう」）
   *   playMs  … 1こまを何秒で送るか。OPSIM_PLAY_MS_CHOICES の key（既定 'ms900'）
   * 🚨 既定は旧「ふつう」と1ミリも同じ（0.3日ずつ・0.9秒ごと）。
   */
  playStep = OPSIM_STEP_DEFAULT,
  onPlayStep = null,
  playMs = OPSIM_PLAY_MS_DEFAULT,
  onPlayMs = null,
  /**
   * 1日ぶんの直接作業能力(ms)。時間で決めた刻みを「日」へ直すのに要る。
   * 🚨 渡されない時は時間指定の刻みを日へ直せないので 0.3日 を使う（換算値を作らない）。
   */
  dayCapMs = null,
  onReset,
  // ⚠ 仮の入荷日・見る範囲・何日先まで・工数の見積りは BasisControls(条件・根拠タブ)へ移した。
  //   根拠を見るボタン・読み書き数・かかった時間は BasisNotes へ。値は1つも消していない。
  onCancel,
  enabledScenarios = null,
  // 通常シナリオ('normal')を回した時の値。親が覚えておいて、そのまま渡す。
  //   { late:number|null, unresolved:number|null, unjudgeable:number|null }
  // 🚨 scenarioKey==='normal' の時は使わない（自分との差は必ず0なので出す物が無い）。
  // 🚨 数が読めない項目は null を入れる。0 を入れると「差が出た」と嘘を出す。
  baseline = null,
  /**
   * 通常との差（scenarios.compareScenarios の戻り値）。
   * 🚨 comparable:false の時は **数字を1つも出さない**。理由だけを出す（仕様書5.8 / T014）。
   */
  comparison = null,
  /** 主因・副因・判定上の不足（scenarios.classifyCauses の戻り値・仕様書5.10）。 */
  causeTiers = null,
  /** normalizeInput の inputQuality。ここでは「見通し」カードの注記(到着の情報が足りない件数)に使う。
      一覧の帯そのものは BasisNotes(条件・根拠タブ)が出す。 */
  inputQuality = null,
  /**
   * 画面の記録が頼んだ日数ぶん残ったか（simulate の snapshotCoverage）。
   * 🚨 complete が false の時は「◯日表示」と書いてはいけない。
   *   以前 30日と言いながら12.5日ぶんしか残っていなかった事故がある。
   */
  snapshotCoverage = null,
  /**
   * 件数を押した時に一覧を出す（T027「一覧を開く導線」）。
   * 🚨 押せない数字は「確かめようがない数字」。1つずつ どのロットか を開けるようにする。
   * @param {{key:string, title:string, lotIds:string[], unit:string}} req
   */
  onOpenList = null,
  /**
   * 画面4分割のタブ(2026-08-30 清水さんの指示)。'today'(既定) / 'board' / 'improve' / 'basis'。
   * 🚨 旧 compact / boardOnly(「詰めて表示」「大画面」)は撤去(清水さんの指示)。
   *   盤面タブ(board)が「盤を全幅・上の帯を畳む」= 旧・大画面相当の見た目を担う。
   *   (2026-08-24 の実測「1920×1080で画面の67%が盤の外」への答えはタブに引き継がれた)
   */
  tab = 'today',
  onTab = null,
  /** 画面の一覧。🚨 渡さなければ今まで通りの5つ（決まり19 で主役2つ＋畳んだ物にする時だけ渡す）。 */
  tabs = null,
  /**
   * 基準時刻(2026-08-30 清水さんの指摘)。
   * 🚨 「いま画面に出ている数字の基準時刻」と「これから使う基準時刻」は **別に受け取る**。
   *   切り替えた直後、盤の数字はまだ前の基準時刻の物。1つの値で兼ねると、
   *   まだ計算していない時刻を「この見立ての基準時刻」として出す事になる＝嘘になる。
   *   baseNow       … result.metrics.baseNow（出ている数字の出どころ）。計算前は null
   *   baseNowWanted … これから使う基準時刻。計算が終われば baseNow と一致する
   */
  baseNow = null,
  baseNowWanted = null,
  /** 'now'(既定) / 'next-start'。BASE_TIME_MODE と同じ値。 */
  baseMode = BASE_TIME_MODE.NOW,
  onBaseMode = null,
  /** 実時計より後ろへ動かしたか。false なら実時計のまま。 */
  baseShifted = false,
  /** 「次の勤務開始」を決められたか。false なら勤務表が読めず、実時計のまま。 */
  baseResolved = true,
  /**
   * 今日の判断タブの本体(2026-09-02 決まり8・9)。人ごとの指示 ＋ 何が・どれだけ遅れるか(横棒)。
   * 帯(信号1つ)の **すぐ下** に置く。4枚の札はその下に畳む(消していない)。
   */
  todayBody = null,
  /** buildLateDone の戻り値 + rows[].tplName + windowText(決まり10: 遅れて完了を消さない)。帯の右の札に件数を出す。 */
  lateDone = null,
  /**
   * 盤面タブの一番上の行の **左側** に置く物（2026-09-04）。親は警告2本を件数だけに畳んだ1行を渡す。
   * 盤面タブ以外では使わない（渡されても出さない）。null なら題名「操業シミュレーション」が出る。
   */
  boardLeft = null,
  /** 📐 畳んである警告が開いているか(親が持つ)。閉じていて他に出す物も無ければ、この段は描かない。 */
  boardLeftOpen = false,
  /**
   * 盤面タブの一番上の行で、シナリオ▾ / ⏱ 時間を進める▾ の **代わり** に置く物(2026-09-05 決まり31)。
   * 🚨 渡されなかった時(undefined)は今まで通り、その2つのボタンがここに出ます(消していません)。
   *   親が盤の上の「操作の1行」へ移した時だけ null を渡し、ここには何も出しません。
   */
  controlsSlot,
  /**
   * 引き出し(シナリオ / ⏱)が開いているか。null | 'scenario' | 'play'。
   * 🚨 ボタンだけを親の行へ移すので、**開いているかどうか** は親と揃えないと
   *   「押しても引き出しが開かない」になります。onToggleDrawer を渡した時だけ親の値を使い、
   *   渡されなかった時は今まで通り Header が自分で覚えます。
   */
  boardDrawer: boardDrawerProp = null,
  onToggleDrawer = null,
  /**
   * 結論の帯の右端に置く押す物(案A・2026-09-16): 期間(5営業日/今月/来月)・⏱ 時間を進める・⚙ 設定。
   * 🚨 その3つの持ち主は親(OperationsSimulationPanel)なので、親が組んで渡す。渡されなければ何も出さない。
   *   盤面タブでだけ使う(帯は盤面タブにしか無い)。
   */
  bandControls = null,
  /** 🧮 2026-09-18 案A: 帯の3行目「この答えの土台」。親が作った札をそのまま渡す。 */
  basis = null,
  onBasisPick = null,
  decisions = null,
}) {
  const maxD = Number(maxDay) > 0 ? Number(maxDay) : 5;
  // 🚨 0.0 を `|| 1` で化けさせない。0.0 は「いま」という正しい値。
  const rawDay = Number.isFinite(Number(day)) ? round3(Number(day)) : 0;
  const nowDay = clamp(rawDay, 0, maxD);
  /**
   * 盤面タブの引き出し（2026-09-04 決まり6「情報は移す・畳む・強さを変える。消さない」）。
   * 実測(2026-09-04 1280×800): 盤の上に帯が7段（警告2・シナリオ・タブ・基準時刻・判定・再生）あって、
   * 盤の道は画面の 2.5%（最初の札 y=768）だった。盤面タブでは
   *   ・判定 ＋ 基準時刻 を1行に
   *   ・シナリオの札 と 時間の操作(再生・つまみ) を **引き出し** へ（押すと今まで通りの物がそのまま出る）
   * 🚨 見た目だけ。開閉は端末の中の状態で、何も確定しない・何も送らない。
   */
  /* 🚨 hooks はガード(return null)より上。並びは1つも動かしていません。 */
  const [boardDrawerOwn, setBoardDrawerOwn] = useState(null);   // null | 'scenario' | 'play'
  /* 開け閉めのボタンを親の行へ移した時(onToggleDrawer が来た時)は、親の値をそのまま使う。
     渡されなかった時は今まで通り自分で覚える＝この画面だけで今まで通り動く。 */
  const drawerLifted = typeof onToggleDrawer === 'function';
  const boardDrawer = drawerLifted ? (boardDrawerProp || null) : boardDrawerOwn;
  const toggleDrawer = (key) => {
    if (drawerLifted) { onToggleDrawer(key); return; }
    setBoardDrawerOwn((v) => (v === key ? null : key));
  };

  /**
   * この見立ての基準時刻の帯（2026-08-30）。
   * 🚨 出す時刻は **画面の数字が出てきた基準時刻**(baseNow)。まだ1度も計算していない時だけ、
   *   これから使う時刻(baseNowWanted)を出す。切替の直後に食い違う間は、その事を1行で言う。
   */
  const baseTime = useMemo(() => {
    const shownMs = numOrNull(baseNow) ?? numOrNull(baseNowWanted);
    const wantedMs = numOrNull(baseNowWanted);
    const shownIsWanted = shownMs != null && wantedMs != null && shownMs === wantedMs;
    const modeLabel = BASE_TIME_MODE_LABEL[baseMode] || BASE_TIME_MODE_LABEL[BASE_TIME_MODE.NOW];
    let note = null;
    if (baseMode === BASE_TIME_MODE.NEXT_START && !baseResolved) {
      note = '勤務表の設定から次の勤務開始を出せなかったので、端末の時計のままで見ています';
    } else if (baseMode === BASE_TIME_MODE.NEXT_START && !baseShifted) {
      note = 'いまが勤務時間の中なので、端末の時計のままです';
    }
    return {
      when: fmtWhen(shownMs),
      // 切替の直後だけ出す。計算が終わると消える。
      pending: shownIsWanted ? null : fmtWhen(wantedMs),
      // 出ている数字と選択が揃っている時だけ、時刻の横に決め方を添える。
      suffix: shownIsWanted ? modeLabel : null,
      note,
    };
  }, [baseNow, baseNowWanted, baseMode, baseShifted, baseResolved]);

  // 🚨 この3つは別々に数える。1つの数字にまとめない。
  //   数え方の中身は opsimTallyOf（このファイルの上）ただ1本。盤面タブの結論の行・
  //   画面いっぱいの帯も同じ関数を読む＝同じ数字を2つの計算から出さない。
  const tally = useMemo(() => opsimTallyOf(lotResults, explain), [lotResults, explain]);

  // 手が付けられなかった仕事。engine の unresolvedCount / unresolvedByReason をそのまま読む。
  // 🚨 engine がまだこの値を返していない時は null。0 と書かない（0件は「無い」という主張）。
  const unresolved = useMemo(() => ({
    count: hasKey(explain, 'unresolvedCount') ? numOrNull(explain.unresolvedCount) : null,
    reasons: readByReason(explain?.unresolvedByReason).slice(0, 2),
  }), [explain]);

  // 一番効く手 = ①実測で遅れが減った物 → ②まだ測っていない手(deltaLate:null)。
  // 🚨 実測で **悪くなる** 手(deltaLate<0)を「一番効く手」に出さない。
  //   実データの remedies[0] は deltaLate:-1（打つと1件増える）だった。そのまま出すと嘘になる。
  // 🚨 効果が0の物も出さない。「+0」は「効かない事を確かめた」に読める。
  const remedy = useMemo(() => {
    const list = Array.isArray(explain?.remedies) ? explain.remedies : [];
    const measured = list.find((r) => typeof r?.deltaLate === 'number' && r.deltaLate > 0);
    if (measured) return { item: measured, drop: measured.deltaLate };
    const hint = list.find((r) => r && r.deltaLate == null);
    return { item: hint || null, drop: null };
  }, [explain]);

  // 通常との差。🚨 差が0の物は1行も作らない。両方の値が読めない物も作らない。
  const deltas = useMemo(() => {
    if (scenarioKey === 'normal' || baseline == null || typeof baseline !== 'object') return [];
    const diff = (nowV, baseV) => {
      const a = numOrNull(nowV);
      const b = numOrNull(baseV);
      if (a == null || b == null) return null;
      const d = a - b;
      return d === 0 ? null : d;
    };
    const rows = [];
    const dLate = diff(tally.late, baseline.late);
    if (dLate != null) rows.push({ key: 'late', label: 'この先で遅れる', n: dLate });
    const dUnres = diff(unresolved.count, baseline.unresolved);
    if (dUnres != null) rows.push({ key: 'unresolved', label: '手が付けられない', n: dUnres });
    const dUnj = diff(tally.unjudgeable, baseline.unjudgeable);
    if (dUnj != null) rows.push({ key: 'unjudgeable', label: '判定できません', n: dUnj });
    return rows;
  }, [scenarioKey, baseline, tally.late, tally.unjudgeable, unresolved.count]);

  // ── 通常との差（T013 / 11章「主結果」）──────────────────────────────────
  // 🚨 差が無い時は「通常との差なし」と **言い切る**。何も出さないと
  //   「まだ計算していない」のか「同じだった」のか読めない（6.13）。
  const diff = useMemo(() => {
    if (scenarioKey === 'normal') return null;
    if (!comparison) return { kind: 'none', text: '通常との差はまだ出せません' };
    if (!comparison.comparable) return { kind: 'blocked', text: comparison.reason || '条件が違うので比べていません' };
    if (!comparison.hasDifference) return { kind: 'same', text: '通常との差はありません（12項目とも同じ）' };
    const D = comparison.deltas || {};
    const LABEL = {
      atRiskLotCount: '危険なロット',
      futureLateLotCount: 'この先で遅れるロット',
      unresolvedDueLotCount: '納期内に担当が付かないロット',
      unresolvedTotalLotCount: '手が付かないロット',
      unjudgeableLotCount: '判定のつかないロット',   // ⚠『できない』は禁じ語（実績が無い＝分からない、であって不可ではない）
      maxLateMs: '一番大きい遅れ',
      totalLateMs: '遅れの合計',
      forecastBreachAt: '最初に越える時刻',
      availableMinutes: '使える時間',
      assignedMinutes: '割り当てた時間',
      makespan: '最後の作業が終わるまで',
    };
    const isTime = (k) => k === 'maxLateMs' || k === 'totalLateMs' || k === 'makespan' || k === 'forecastBreachAt';
    const isMinutes = (k) => k === 'availableMinutes' || k === 'assignedMinutes';
    // 小さいほど良い項目。時刻(forecastBreachAt)だけは「後ろへ動く＝良い」。
    const betterWhenUp = new Set(['forecastBreachAt', 'availableMinutes']);
    // 🚨 null ↔ 数 の変化は deltas に入らない（引き算できないので）。
    //   その時 rows が空になり、「通常との差」の見出しだけが出て中身が空白になる。
    //   「差なし」とも「まだ計算していない」とも読めない＝6.13 が禁じている状態。
    //   → detail から拾って **言葉で** 出す。
    const nullChanges = [];
    const det = comparison.detail || {};
    for (const k of comparison.changedKeys || []) {
      if (Object.prototype.hasOwnProperty.call(D, k)) continue;   // 数で出せた物は下で扱う
      const d = det[k];
      if (!d) continue;
      const label = LABEL[k] || k;
      const wasNone = d.base == null;
      const nowNone = d.other == null;
      if (wasNone && !nowNone) nullChanges.push({ key: k, label, text: '通常では出ていなかった物が出ました', good: false });
      else if (!wasNone && nowNone) nullChanges.push({ key: k, label, text: '通常では出ていた物が無くなりました', good: true });
      else nullChanges.push({ key: k, label, text: '変わりました（数では出せません）', good: false });
    }

    const rows = Object.entries(D).map(([k, v]) => {
      const up = v > 0;
      const good = betterWhenUp.has(k) ? up : !up;
      let text;
      if (k === 'forecastBreachAt') text = `${up ? '後ろへ' : '前へ'} ${fmtSpanShort(Math.abs(v))}`;
      else if (isTime(k)) text = `${up ? '+' : '−'}${fmtSpanShort(Math.abs(v))}`;
      else if (isMinutes(k)) text = `${up ? '+' : '−'}${fmtInt(Math.round(Math.abs(v)))}分`;
      else text = `${up ? '+' : '−'}${fmtInt(Math.abs(v))}件`;
      return { key: k, label: LABEL[k] || k, text, good };
    });
    return { kind: 'diff', rows: [...rows, ...nullChanges] };
  }, [scenarioKey, comparison]);

  /**
   * 手が付かなかった **ロット** の数。
   * 🚨 explain.unresolvedCount は **仕事(工程)** の数。1つのロットに何十もの工程があるので
   *   そのまま「ロットの件数」の隣に置くと桁が1つ違って見える(実測: ロット70件 / 工程1,100件)。
   *   engine は explain.unresolvedLots(ロットID の配列)も返しているので、そちらを使う。
   * ⚠ 返っていない古い結果では null。0 にしない（「手が付かない物は無い」と嘘になる）。
   */
  const unresolvedLotCount = Array.isArray(explain?.unresolvedLots) ? explain.unresolvedLots.length : null;
  /** 到着の情報が足りないロット(T027 の4つ目)。⚠ 数え方は opsimArrivalShortOf ただ1本。 */
  const arrivalShort = opsimArrivalShortOf(inputQuality);

  const verdict = explain?.verdict || null;

  const forecastMs = (explain && typeof explain.forecastBreachAt === 'number' && Number.isFinite(explain.forecastBreachAt))
    ? explain.forecastBreachAt
    : null;
  // engine がこの値をまだ返していない(キーが無い)のと、返した上で null(＝越えない)のは別物。
  const hasForecast = hasKey(explain, 'forecastBreachAt');
  // ⚠ 「この先で最初に越える日時」の出どころは opsimForecastWhenOf ただ1本。
  const forecastWhen = opsimForecastWhenOf(explain);
  // すでに過ぎている物も入れた最初の時刻。**消さずに小さい字で残す**（今日の事実として要る）。
  const anyMs = (explain && typeof explain.breachAt === 'number' && Number.isFinite(explain.breachAt))
    ? explain.breachAt
    : null;
  const anyWhen = (anyMs != null && anyMs !== forecastMs) ? fmtWhen(anyMs) : null;

  const worstSpan = fmtSpan(tally.maxLateMs);
  const prog = readProgress(progress);

  /**
   * 3枚目で畳む内訳の見出し(2026-08-30 清水さんの指摘1)。
   * 🚨 畳んだ時に **中に何が入っているかが数で分かる** ようにする。
   *   「詳細を見る」だけだと、押すまで中身の有無が分からず、押させる為の札になってしまう。
   * ⚠ 数が入っていない(null)物は書かない。0 と「分かりません」を混ぜない。
   */
  const foldSummary = useMemo(() => {
    const parts = [];
    if (unresolved.reasons.length) parts.push(`手が付けられない理由 ${unresolved.reasons.length}種`);
    if (worstSpan) parts.push(`最大の遅れ ${worstSpan}`);
    if (tally.pastDue != null) parts.push(`すでに過ぎている ${fmtInt(tally.pastDue)}ロット`);
    if (tally.unjudgeable != null) parts.push(`判定がつかない ${fmtInt(tally.unjudgeable)}ロット`);
    return parts.length ? `内訳：${parts.join('・')}` : '内訳（今日の事実・判定がつかない分・単位の注記）';
  }, [unresolved.reasons.length, worstSpan, tally.pastDue, tally.unjudgeable]);

  // 4枚目の言い方。explain が無い(まだ計算していない)のと、計算した結果 原因が0件なのは別。
  // 🚨 主因は classifyCauses(causeTiers)ただ1つから。下の主因の行・大画面の1行と必ず同じ物が出る。
  const causeTitle = causeTiers?.primary
    ? causeTiers.primary.label
    : (explain ? 'ありません' : '—');
  const causeSub = (causeTiers?.primary && causeTiers.primary.detail)
    || (explain ? 'この見立てでは、遅れの原因になっている物は出ていません' : '計算するとここに出ます');
  const remedyLabel = remedy.item?.label || (explain ? 'いまは出ていません' : '—');

  const scenarioItems = Array.isArray(enabledScenarios) && enabledScenarios.length
    ? OPSIM_SCENARIOS.filter((s) => enabledScenarios.includes(s.key))
    : OPSIM_SCENARIOS;
  const scenarioLabel = (OPSIM_SCENARIOS.find((s) => s.key === scenarioKey) || {}).label || 'この条件';

  // ── 時間の進み方（2026-08-30 清水さんの要望3）─────────────────────────────
  // 🚨 刻みと速さは別物。刻み＝盤の中の時間がどれだけ進むか／速さ＝1こまを何秒で送るか。
  const stepChoice = opsimStepOf(playStep);
  const playMsChoice = opsimPlayMsOf(playMs);
  /**
   * 1こまが「何日ぶん」か。
   * 🚨 時間で決めた刻み(0.5/1/2時間)は、**その時の1日ぶんの直接作業能力**で日へ直す。
   *   残業シナリオだと1日ぶんが増える(420分→540分)ので、決め打ちの換算値を置かない。
   */
  const stepDays = opsimStepDays(stepChoice.key, dayCapMs);
  const stepLabel = stepChoice.label;
  /** 刻みの目盛りへ乗せる。0.1刻み決め打ちだと 0.05日 も 0.5時間 も同じ所で止まってしまう。 */
  const snapDay = (n) => clamp(round3(Math.round((Number(n) || 0) / stepDays) * stepDays), 0, maxD);
  /* ⚠ 表示の桁(dayDigits/showDay)は opsimElapsedText の中へ移した（2026-09-04）。
       ここに写しを置くと、⏱の札と引き出しの数字が別の丸め方で出て食い違う。 */
  /* 🚨 いま何ぶん進めたか。**押した量をそのまま言う**（2026-09-04 決まり20）。
     中身は opsimElapsedText ただ1本。⏱の札・引き出しの大きい数字・拡大の帯が全部これを読む
     ＝ 同じ数字を2つの計算から出さない。 */
  const elapsedText = opsimElapsedText(nowDay, stepChoice.key, dayCapMs);

  const stepDay = () => { if (onDay) onDay(snapDay(nowDay + stepDays)); };
  // 1こま戻る。🚨 0 より手前へは行かせない（「いま」より過去は計算していない）。
  const stepBack = () => { if (onDay) onDay(snapDay(nowDay - stepDays)); };
  // 🚨 スライダーの下限は 0.0。`|| 1` で 0 を 1 に化けさせない。
  const slideDay = (e) => {
    const v = Number(e.target.value);
    if (onDay) onDay(snapDay(Number.isFinite(v) ? v : 0));
  };

  // 1枚目の言い方。⚠ 中身は opsimVerdictOf（このファイルの上）ただ1本。
  //   見通しカード・盤面タブの結論の行・画面いっぱいの帯が、全部これを読む。
  const v = opsimVerdictOf({ verdict, maxD, tally, arrivalShort });
  const vt = TONE[v.tone];

  /* ── この見立ての基準時刻 ＋ 2択(2026-08-30 清水さんの指摘)。
      🚨 **どのタブにも出す**。何時点の話かが読めないまま盤を見せない。
      🚨 出す時刻は画面の数字が出てきた基準時刻。選んだだけでまだ計算していない時刻を
         「この見立ての基準時刻」として出さない(嘘の時刻で判断させない)。
      中身は1つ（baseTimeInner）。盤面タブでは判定の行の右に、他のタブでは自分の行に置く（2026-09-04）。 ── */
  /* 盤面タブでは濃い帯(slate-900)の上に載るので、字の色を帯用(dark)に切り替える。字は1つも変えない。 */
  const dark = tab === 'board';
  const baseTimeInner = (
    <>
      <span className={`inline-flex items-center gap-1.5 shrink-0 text-2xs font-bold ${dark ? 'text-slate-300' : 'text-slate-700'}`}>
        <CalendarClock className={`w-4 h-4 shrink-0 ${dark ? 'text-slate-400' : 'text-cyan-600'}`} />
        {tab === 'board' ? '基準時刻' : 'この見立ての基準時刻'}
      </span>
      {baseTime.when ? (
        <span className="inline-flex items-baseline gap-1">
          <b className={`text-sm font-black tabular-nums ${dark ? 'text-white' : 'text-cyan-700'}`}>{baseTime.when.head}</b>
          <span className={`text-2xs ${dark ? 'text-slate-500' : 'text-slate-400'}`}>{baseTime.when.year}</span>
          {baseTime.suffix ? <span className={`text-2xs font-bold ${dark ? 'text-slate-300' : 'text-slate-600'}`}>（{baseTime.suffix}）</span> : null}
        </span>
      ) : (
        <span className={`text-2xs ${dark ? 'text-slate-400' : 'text-slate-500'}`}>計算するまで まだ出せません</span>
      )}
      <PillGroup ariaLabel="基準時刻の決め方" items={BASE_TIME_ITEMS} activeKey={baseMode} onPick={onBaseMode} />
      {baseTime.pending ? (
        <span className={`text-2xs leading-snug ${dark ? 'text-amber-300' : 'text-amber-700'}`}>
          切り替えました。計算が終わると <b className="tabular-nums">{baseTime.pending.head}</b> 時点の見立てに入れ替わります
        </span>
      ) : null}
      {baseTime.note ? <span className={`text-2xs leading-snug ${dark ? 'text-slate-400' : 'text-slate-500'}`}>{baseTime.note}</span> : null}
    </>
  );

  return (
    <div className="flex flex-col gap-2.5">

      {/* ══ 案A(2026-09-16 Main.dc.html): 盤面タブの一番上は **結論の帯** ══════════
          濃い地に 1文(◯日後まで守れません)＋数字の札(いま遅れ／この先／全)＋基準時刻 を1行。
          右端に 期間・⏱ 時間を進める・⚙ 設定(親が bandControls で渡す)。
          🚨 中身は BoardConclusionLine ただ1本（画面いっぱいの帯と同じ物が出る）。
          🚨 判定＋基準時刻は前から1行(2026-09-04)。場所を切替の上へ移しただけで、字は消していない。 */}
      {/* 🗂 2026-09-23: 「割付と空き」(dispatch) も盤面と同じく 結論の1行を上に出す(人の順番だけ見て「で、どうなの」が消えない)。 */}
      {!(tab === 'board' || tab === 'dispatch') ? null : (
        <div className="flex flex-wrap items-stretch gap-2" data-opsim-band-row="1">
          {/* 📐 2026-09-18 夜: [今日][月] の札だけで1段(約56px)使っていた。帯の左へ寄せる。 */}
          <div className="flex shrink-0 items-center"><TabBar tab={tab} onTab={onTab} tabs={tabs} /></div>
          {/* 📱 2026-09-24 スマホ(390px)では札の横に詰められて帯が 142px しか無く、今日決めることの札が横へはみ出していた(写しで実測)。
              帯は 20rem より狭くなるなら次の行へ回す。 */}
          <div className="min-w-0 flex-1 basis-80">
        <BoardConclusionLine
          explain={explain}
          lotResults={lotResults}
          maxDay={maxD}
          inputQuality={inputQuality}
          causeTiers={causeTiers}
          right={(
            <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1" data-opsim-basetime="">
              {baseTimeInner}
            </span>
          )}
          controls={bandControls}
          basis={basis}
          onBasisPick={onBasisPick}
          decisions={decisions}
        />
          </div>
        </div>
      )}

      {/* 画面の切替(1段)。左に切替、右に 警告の1行(盤面タブ) と シナリオ／⏱ の札。 */}
      {(tab === 'board' && !boardLeftOpen && controlsSlot !== undefined && !controlsSlot) ? null : (
      <div className="flex flex-wrap items-center justify-between gap-2" data-opsim-tabs-row="1">
        {/* 画面4分割のタブバー(2026-08-30)。案A(2026-09-16): 1段の区切り(segmented)。左に置く。盤面の時は帯の横に在るのでここには出さない。 */}
        {(tab === 'board' || tab === 'dispatch') ? null : <TabBar tab={tab} onTab={onTab} tabs={tabs} />}
        {/* 盤面タブ: 親が畳んだ警告の1行（題名は盤面タブのラベルが兼ねる）。他のタブ: 題名と1行の説明。 */}
        <div className={tab === 'board' && boardLeft ? 'min-w-0 flex-1' : ''}>
          {tab === 'board' && boardLeft ? boardLeft : (
            <>
              <div className="text-sm font-black text-slate-800">操業シミュレーション</div>
              {tab === 'board' ? null : (
                <div className="text-2xs text-slate-500 leading-snug">
                  {/* 🚨 2026-09-18 写しの実測: [月] の画面なのに「5日ぶん時間を進めて」と
                      **盤の話** を書いていた(画面の言う事が当たらない)。画面ごとの1行にする。 */}
                  {tab === 'month'
                    ? 'いまの人数・勤務時間のまま、この先3か月ぶんの仕事と働ける時間を月ごとに並べます'
                    : `いまの人数・勤務時間のまま ${maxD}日ぶん時間を進めて、納期に間に合うかを見ます`}
                </div>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* 盤面タブ: シナリオの札は引き出しへ（押すと下に今まで通りの札が出る）。他のタブは今まで通り。 */}
          {tab === 'board' ? (
            /* 🚨 決まり31(2026-09-05 区画A): 親が「操作の1行[3]」へ移した時は controlsSlot を渡す。
               その時ここには何も出さない＝同じボタンが画面に2つ出ない。
               渡されなかった時は **今まで通り** この2つがここに出る(部品は1つも消していない)。 */
            controlsSlot === undefined ? (
              <BoardDrawerButtons
                scenarioKey={scenarioKey}
                day={nowDay}
                maxDay={maxD}
                playStep={playStep}
                dayCapMs={dayCapMs}
                boardDrawer={boardDrawer}
                onToggle={toggleDrawer}
              />
            ) : controlsSlot
          ) : (
            <PillGroup ariaLabel="シナリオ" items={scenarioItems} activeKey={scenarioKey} onPick={onScenario} />
          )}
        </div>
      </div>
      )}

      {tab === 'board' ? null : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5">
          {baseTimeInner}
        </div>
      )}

      {/* ── 計算の進み具合。どのタブからでも計算は走る(シナリオ切替・比較表の「計算する」)ので、
          タブの外に常に置く。以前は時間の操作カードの中に居た(場所を移しただけ)。 ── */}
      {verdictLoading ? (
        <div className="flex items-center gap-2.5 rounded-lg border border-cyan-200 bg-cyan-50 px-2.5 py-2">
          <Loader2 className="w-4 h-4 shrink-0 animate-spin text-cyan-600" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-2xs font-bold text-slate-700">計算しています</span>
              {prog.label ? <span className="text-2xs text-slate-500 truncate">{prog.label}</span> : null}
              {prog.pct == null ? null : (
                <span className="ml-auto text-2xs font-black text-cyan-700 tabular-nums">{Math.round(prog.pct)}%</span>
              )}
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-white border border-cyan-200 overflow-hidden">
              {prog.pct == null
                ? <div className="h-full w-1/3 bg-cyan-400 animate-pulse" />
                : <div className="h-full bg-cyan-500 transition-all" style={{ width: `${Math.round(prog.pct)}%` }} />}
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center gap-1 min-h-11 px-2.5 rounded-lg border border-rose-300 bg-white text-2xs font-bold text-rose-700 hover:bg-rose-50 shrink-0"
          >
            <X className="w-3.5 h-3.5" />
            中止
          </button>
        </div>
      ) : null}

      {/* 🚨 盤面タブでは上の帯を畳むが、**結論だけは必ず残す**（旧・大画面と同じ形）。
          結論（守れる/守れない・最初に越える日時・主な原因）が消えると、
          盤だけ大きくても『で、どうなの』が読めない画面になる。1行に畳んで置く。 */}
      {tab === 'board' ? (
        <>
        {/* 結論の1行(BoardConclusionLine)は 2026-09-16 に この画面の一番上(切替の上)へ移した。ここには引き出し2つだけ。 */}

        {/* シナリオの引き出し（畳んでいる時は上のボタンに「シナリオ：通常」と出ている）。 */}
        {boardDrawer === 'scenario' ? (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-1.5">
            <span className="text-2xs font-bold text-slate-500">シナリオ</span>
            <PillGroup ariaLabel="シナリオ" items={scenarioItems} activeKey={scenarioKey} onPick={onScenario} />
          </div>
        ) : null}

        {/* 🚨 時間の操作（再生・つまみ）。ここが無いと盤が動かせない。盤面タブの引き出し（⏱）の中。
            ⚠ 見ている範囲/何日先まで/工数の見方・仮の入荷日 は BasisControls(条件・根拠タブ)へ、
              かかった時間・読み書き数 は BasisNotes へ移した(1つも消していない)。 */}
        {boardDrawer !== 'play' ? null : (
        <div className="bg-white border border-slate-200 shadow-sm rounded-xl flex flex-col p-1.5 gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex items-baseline gap-1 min-h-11 px-3 rounded-lg border border-cyan-200 bg-cyan-50">
              {/* 🚨 0.0 が「いま」。以前は 1日目＝いま だったので「0日目」という言い方にならない。
                  仕様書5.2: elapsedDays 0.0〜5.0（0.0=現在 / 5.0=5日ぶんの直接作業能力を使い切った所） */}
              <span className="text-2xs font-bold text-slate-500 self-center">{nowDay <= 0 ? '' : 'いまから'}</span>
              {/* 🚨 押した量をそのまま言う（2026-09-04 決まり20）。「＋2時間」を押したのに
                  「0.3日ぶん」と出るのは、押した量を言い換えた嘘だった。
                  刻みが時間なら時間で言い、日は横に小さく併記する。中身は opsimElapsedText 1本。 */}
              <b data-opsim-elapsed="" className="text-xl font-black text-cyan-700 tabular-nums self-center">{elapsedText.main}</b>
              {elapsedText.sub
                ? <span className="text-2xs text-slate-500 self-center">（{elapsedText.sub}）進めた / {maxD}日</span>
                : <span className="text-2xs text-slate-500 self-center">進めた / {maxD}日</span>}
            </div>

            {/* 1こま戻る → 再生/一時停止 → 1こま進む の順。左が過去・右が未来で並べる。 */}
            <ToolButton onClick={stepBack} disabled={nowDay <= 0} icon={Rewind}>{`−${stepLabel}`}</ToolButton>
            <ToolButton onClick={onTogglePlay} tone={playing ? 'warn' : 'accent'} icon={playing ? Pause : Play}>
              {playing ? '一時停止' : '再生'}
            </ToolButton>
            <ToolButton onClick={stepDay} disabled={nowDay >= maxD} icon={FastForward}>{`＋${stepLabel}`}</ToolButton>
            <ToolButton onClick={onReset} icon={RotateCcw}>最初へ戻す</ToolButton>

            {/* 🚨 進み方の設定は **小さくまとめる**（清水さんの要望3「画面に出しっぱなしにせず
                盤面の上に小さくまとめる」）。押している間だけ開く小さい窓ではなく、
                選んだ物が札に出たままの2つの引き出しにする＝いま何で動くのかが一目で読める。
                ⚠ 引き出しは `<select>`。丸ボタンを10個並べると帯が2段になって盤が縮む。 */}
            <div className="inline-flex items-center gap-1.5 min-h-11 px-2 rounded-lg border border-slate-200 bg-slate-50 shrink-0">
              <span className="text-2xs font-bold text-slate-500 whitespace-nowrap">進み方</span>
              <label className="flex items-center gap-1">
                <span className="sr-only">1こまで進む時間（刻み）</span>
                <select
                  value={stepChoice.key}
                  onChange={(e) => { if (typeof onPlayStep === 'function') onPlayStep(e.target.value); }}
                  title={`1こまで進む時間。いまは「${stepChoice.label}」（${stepChoice.hint || ''}）`}
                  className="min-h-11 rounded-md border border-slate-300 bg-white px-1.5 text-2xs font-bold text-slate-700"
                >
                  {OPSIM_STEP_CHOICES.map((c) => (
                    <option key={c.key} value={c.key}>{`${c.label}ずつ`}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1">
                <span className="sr-only">1こまを何秒で送るか（再生の速さ）</span>
                <select
                  value={playMsChoice.key}
                  onChange={(e) => { if (typeof onPlayMs === 'function') onPlayMs(e.target.value); }}
                  title={`再生した時、1こまを何秒で送るか。いまは「${playMsChoice.label}」`}
                  className="min-h-11 rounded-md border border-slate-300 bg-white px-1.5 text-2xs font-bold text-slate-700"
                >
                  {OPSIM_PLAY_MS_CHOICES.map((c) => (
                    <option key={c.key} value={c.key}>{`${c.label}ごと`}</option>
                  ))}
                </select>
              </label>
            </div>

            <label className="flex items-center gap-2 flex-1 min-w-[180px]">
              <span className="text-2xs text-slate-500 shrink-0">1日</span>
              <input
                type="range"
                min={0}
                max={maxD}
                step={Math.max(0.01, Math.round(stepDays * 1000) / 1000)}
                value={nowDay}
                onChange={slideDay}
                aria-label="何日目まで進めるか"
                className="flex-1 h-10 accent-cyan-500 cursor-pointer"
              />
              <span className="text-2xs text-slate-500 shrink-0">{maxD}日</span>
            </label>
          </div>
        </div>
        )}
        </>
      ) : null}

      {/* ── 今日の判断: 一番上は信号1つの帯(2026-09-02 決まり6「大きい字は答え」・決まり8「視覚が第一」)。
          帯 → 人ごとの指示・遅れる物の横棒(todayBody) → 4枚の札(畳む。1つも消していない) の順。 ── */}
      {tab !== 'today' ? null : (
        <TodaySignalBand
          v={v}
          vt={vt}
          tally={tally}
          forecastWhen={forecastWhen}
          causeTitle={causeTiers?.primary ? causeTitle : null}
          remedyLabel={remedy.item ? remedyLabel : null}
          remedyDrop={remedy.drop}
          lateDoneCount={lateDone && Array.isArray(lateDone.rows) ? lateDone.rows.length : null}
          lateDoneWindowText={lateDone && typeof lateDone.windowText === 'string' ? lateDone.windowText : ''}
          lateDoneMaxDays={lateDone && Array.isArray(lateDone.rows) && lateDone.rows.length ? numOrNull(lateDone.rows[0].daysLate) : null}
        />
      )}
      {tab === 'today' && todayBody ? todayBody : null}

      {tab !== 'today' ? null : (
      <Fold
        quiet
        openLabel="4枚の札を開く"
        summary={`くわしく：見通し「${v.title}」・この先で最初に越える日時${forecastWhen ? ` ${forecastWhen.head}` : ''}・この先で遅れる ${tally.late == null ? '—' : fmtInt(tally.late)}ロット・主な原因「${causeTitle}」（4枚の札。中身はそのまま）`}
      >
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2.5 items-start">

        <StatCard tone={v.tone} icon={v.icon} label="見通し">
          {/* 長い言い方(暫定見通し)は2xlだと折り返して縦に伸びるので1段落とす */}
          <div className={`mt-1.5 ${v.small ? 'text-lg leading-tight' : 'text-2xl leading-none'} font-black ${vt.value}`}>{v.title}</div>
          <div className="mt-2 text-2xs text-slate-500 leading-snug">{v.sub}</div>
        </StatCard>

        <StatCard tone={forecastWhen ? 'rose' : (hasForecast ? 'emerald' : 'slate')} icon={CalendarClock} label="この先で最初に越える日時">
          {forecastWhen ? (
            <>
              <div className="mt-1.5 text-2xl font-black leading-none text-rose-600 tabular-nums">{forecastWhen.head}</div>
              <div className="mt-1 text-2xs text-slate-500 leading-snug">{forecastWhen.year}。ここで最初の1件が納期線を越えます</div>
            </>
          ) : (
            <>
              <div className={`mt-1.5 text-lg font-black leading-tight ${hasForecast ? 'text-emerald-700' : 'text-slate-500'}`}>
                {hasForecast ? `この${maxD}日の中では越えません` : '分かりません'}
              </div>
              <div className="mt-1 text-2xs text-slate-500 leading-snug">
                {hasForecast
                  ? 'この先で新しく納期線を越えるロットは出ていません'
                  : 'この先で越える時刻は、まだ出していません'}
              </div>
            </>
          )}
          {anyWhen ? (
            <div className="mt-2 pt-1.5 border-t border-slate-200 leading-snug">
              <div className="text-2xs text-slate-500">すでに過ぎている分も入れた最初の時刻（今日の事実）</div>
              <div className="text-2xs font-bold text-amber-700 tabular-nums">{anyWhen.head} {anyWhen.year}</div>
            </div>
          ) : null}
        </StatCard>

        <StatCard tone={(tally.late || unresolved.count) ? 'rose' : 'slate'} icon={AlertTriangle} label="この先で遅れる ／ 手が付けられない">
          <div className="mt-1.5 grid grid-cols-2 gap-2">
            <ClickableCount
              label="この先で遅れるロット"
              value={tally.late}
              danger={!!tally.late}
              onOpen={onOpenList}
              req={{ key: 'forecastLate', title: 'この先で遅れるロット', lotIds: explain?.forecastLateLots, unit: 'ロット' }}
            />
            <div className="pl-2 border-l border-slate-200 min-w-0">
              {/* 🚨 T027: ここは以前『仕事(工程)の件数』を、隣の『ロットの件数』と並べていた。
                  単位が違う物を横に並べると足し引きできる様に見える。
                  **ロットの数を主にし、工程の数は小さく添える**。 */}
              <ClickableCount
                label="手が付けられないロット"
                value={unresolvedLotCount}
                danger={!!unresolvedLotCount}
                onOpen={onOpenList}
                req={{ key: 'unresolved', title: '手が付けられないロット', lotIds: explain?.unresolvedLots, unit: 'ロット' }}
              />
              {unresolved.count == null ? null : (
                <div className="mt-0.5 text-2xs text-slate-500 leading-snug">
                  中の工程で数えると <b className="tabular-nums text-slate-700">{fmtInt(unresolved.count)}</b> 件
                </div>
              )}
            </div>
          </div>
          {/* 🚨 ここから下が「長い内訳」。既定で畳む(清水さんの指摘1)。
              上の2つの大きな数字＝結論は畳んでも必ず見えている。
              畳んだ中身は1つも消していない(理由の内訳・最大の遅れ・過ぎている分・
              判定がつかない分・単位の注記の5つが、押せばそのまま出る)。 */}
          <Fold summary={foldSummary}>
            {unresolved.reasons.length ? (
              <ul className="flex flex-col gap-0.5">
                {unresolved.reasons.map((r) => (
                  <li key={r.reason} className="flex items-baseline gap-1.5 leading-snug">
                    <span className="flex-1 min-w-0 text-2xs text-slate-500">{r.reason}</span>
                    {/* ⚠ この内訳は **工程(仕事)** の数。上のロット数とは足し引きできない。 */}
                    <b className="shrink-0 text-xs font-black text-slate-700 tabular-nums">{fmtInt(r.count)}工程</b>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className={`${unresolved.reasons.length ? 'mt-1.5 pt-1.5 border-t border-slate-200 ' : ''}flex flex-col gap-0.5`}>
              {worstSpan ? <SubLine label="この先での最大の遅れ" tone="rose" value={worstSpan} /> : null}
              <ClickableSub
                label="すでに予定日を過ぎている（今日の事実）"
                tone="amber"
                value={tally.pastDue == null ? '—' : `${fmtInt(tally.pastDue)}ロット`}
                onOpen={onOpenList}
                req={{ key: 'alreadyPastDue', title: 'すでに予定日を過ぎているロット（今日の事実）', lotIds: explain?.alreadyPastDueLots, unit: 'ロット' }}
              />
              <ClickableSub
                label="判定がつきません（入っていない値がある分）"
                tone="slate"
                value={tally.unjudgeable == null ? '—' : `${fmtInt(tally.unjudgeable)}ロット`}
                onOpen={onOpenList}
                req={{ key: 'unjudgeable', title: '判定がつかないロット（入っていない値がある分）', lotIds: explain?.unjudgeableLots, unit: 'ロット' }}
              />
              {/* 🚨 T027: 4つの数がどこから来たかを1行で言う。単位を混ぜない。 */}
              <div className="pt-1 mt-0.5 border-t border-dashed border-slate-200 text-2xs text-slate-500 leading-snug">
                ここに出ている件数は全部「ロット」の数です（内訳だけ工程の数）。
                {arrivalShort == null ? null : <> 到着の情報が足りないロット <b className="tabular-nums text-amber-700">{fmtInt(arrivalShort)}</b> 件は、この見立てに入れていません。</>}
              </div>
            </div>
          </Fold>
        </StatCard>

        <StatCard tone="cyan" icon={Lightbulb} label="主な原因">
          <div className="mt-1.5 text-lg font-black leading-tight text-slate-800">{causeTitle}</div>
          <div className="mt-1 text-2xs text-slate-500 leading-snug">{causeSub}</div>
          <div className="mt-2 pt-1.5 border-t border-slate-200">
            <div className="text-2xs font-bold text-slate-500">一番効く手</div>
            <div className="mt-0.5 flex items-start gap-1.5 flex-wrap">
              <span className="text-xs font-bold text-cyan-700 leading-snug">{remedyLabel}</span>
              {remedy.drop ? (
                <span className="shrink-0 rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-2xs font-black text-emerald-700 tabular-nums">
                  遅れが {fmtInt(remedy.drop)}件 減ります
                </span>
              ) : null}
            </div>
          </div>
        </StatCard>
      </div>
      </Fold>
      )}

      {/* ── 通常との差の帯（シナリオが通常以外の時）。今日の判断タブ ─────────── */}
      {tab === 'today' && deltas.length ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-cyan-200 bg-cyan-50 px-3 py-2">
          <span className="text-2xs font-bold text-slate-600 shrink-0">「{scenarioLabel}」は 通常より</span>
          {deltas.map((d) => (
            <span key={d.key} className="inline-flex items-baseline gap-1">
              <span className="text-2xs text-slate-600">{d.label}</span>
              <b className={`text-base font-black tabular-nums ${d.n > 0 ? 'text-rose-600' : 'text-emerald-700'}`}>
                {fmtDelta(d.n)}
              </b>
            </span>
          ))}
          <span className="basis-full text-2xs text-slate-500 leading-snug">
            通常の時の件数との差です。差が0だった物は出していません。
          </span>
        </div>
      ) : null}

      {/* ── 通常との差（T013 / 仕様書11章「主結果」）───────────────────────────
          🚨 比べられない時は数字を1つも出さない。差が無い時は「差なし」と言い切る。 */}
      {tab === 'today' && diff ? (
        <div className={`rounded-xl border px-3 py-2 ${
          diff.kind === 'diff' ? 'border-cyan-200 bg-cyan-50'
            : (diff.kind === 'same' ? 'border-slate-200 bg-slate-50' : 'border-amber-200 bg-amber-50')
        }`}
        >
          <div className="flex items-center gap-1.5">
            <ArrowLeftRight className="w-3.5 h-3.5 shrink-0 text-slate-500" />
            <span className="text-2xs font-black text-slate-700">通常との差</span>
            {diff.kind !== 'diff' ? (
              <span className="text-2xs text-slate-600 leading-snug">{diff.text}</span>
            ) : null}
          </div>
          {diff.kind === 'diff' ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {diff.rows.map((r) => (
                <span
                  key={r.key}
                  className={`inline-flex items-baseline gap-1 rounded-lg border px-2 py-1 text-2xs font-bold ${
                    r.good ? 'border-emerald-200 bg-white text-emerald-700' : 'border-rose-200 bg-white text-rose-700'
                  }`}
                >
                  <span className="text-slate-600 font-bold">{r.label}</span>
                  <b className="tabular-nums">{r.text}</b>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ── 主因・副因・判定上の不足（仕様書5.10 / 11章「主結果」）──────────────
          🚨 原因を1つに絞らない。「分かっていない事」は原因と別の段に置く。 */}
      {tab === 'today' ? <CauseTiersNote causeTiers={causeTiers} /> : null}

      {/* ── 記録が途中で切れていないか（30日と言って12.5日、を二度と出さない）──────
          今日の判断タブ（「データ不足」の仲間としてここに置く）。 */}
      {/* 🚨 2026-09-19: 「今日の判断」の札が無くなり、この注意が どこにも出なくなっていた。どの札でも出す(数字の読み違いを止める注意なので畳まない)。 */}
      {/* 📐 [今日]の札では 帯の赤い札「画面の記録 途中まで」が同じ事を言っている。全文のこの帯は 札を押して警告を開いた時(boardLeftOpen)と [月] で出す。 */}
      {(tab !== 'board' || boardLeftOpen) && snapshotCoverage && snapshotCoverage.requested > 0 && !snapshotCoverage.complete ? (
        <div data-opsim-snapshot-coverage-warn="1" className="flex flex-wrap items-center gap-1.5 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-rose-600" />
          <span className="text-2xs font-black text-rose-800">
            🚨 この見立ては {snapshotCoverage.requestedLastElapsedDays}日ぶんを頼みましたが、
            {snapshotCoverage.lastElapsedDays == null ? '—' : snapshotCoverage.lastElapsedDays}日ぶんまでしか残っていません
          </span>
          <span className="text-2xs text-rose-700">
            （記録 {fmtInt(snapshotCoverage.captured)} / {fmtInt(snapshotCoverage.requested)} 枚）。
            この画面を「{snapshotCoverage.requestedLastElapsedDays}日ぶん見た」と読まないでください。
          </span>
        </div>
      ) : null}

      {/* 手ごとの効き目(improvements)と教育の案(education)は ImproveDeck(このファイルの下)へ、
          分かっていない事(inputQuality)・力量の注記・根拠を見る は BasisNotes へ移した。
          出す場所は親(OperationsSimulationPanel)の 改善・教育タブ／条件・根拠タブ。1つも消していない。 */}
    </div>
  );
}

/**
 * 改善・教育タブの中身(手ごとの効き目 ＋ 教育の案)。
 * 元は Header の下段に居た物を、そのままの文言で移した(2026-08-30 画面4分割)。
 *
 * @param {object|null} improvements 改善策ごとの実測差分（scenarios.rankImprovements の戻り値・仕様書11章「下段」/ T019）
 * @param {object|null} education 教育の提案（education.js の結果・仕様書11章「下段」/ C5）。
 *   🚨 **提案だけ**。認定も実施記録も書かない。
 *   🚨 実績が無い＝「分かりません」であって「やれない」ではない。文言でそこを守る。
 */
export function ImproveDeck({ improvements = null, education = null }) {
  return (
    <div className="flex flex-col gap-2.5">

      {/* ── 改善策ごとの実測差分（仕様書11章 / T019）────────────────────
          🚨 効果の数字を持てるのは **同じ土俵で実際に計算した物だけ**。
             まだ押していない案は数字を持たせない（「候補」と「測った効果」を混ぜない）。 */}
      {improvements && ((improvements.measured || []).length || (improvements.candidates || []).length) ? (
        <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
          <div className="flex items-center gap-1.5">
            <Lightbulb className="w-3.5 h-3.5 shrink-0 text-cyan-600" />
            <span className="text-2xs font-black text-slate-700">手ごとの効き目（同じ条件で計算した分だけ）</span>
            {improvements.best ? (
              <span className="ml-auto text-2xs font-black text-emerald-700">
                一番効く手: {improvements.best.label}（危険 {fmtInt(improvements.best.effect)}件 減）
              </span>
            ) : null}
          </div>

          {(improvements.measured || []).length ? (
            <ul className="mt-1.5 flex flex-col gap-0.5">
              {improvements.measured.map((m) => {
                const e = Number(m.effect);
                const good = Number.isFinite(e) && e > 0;
                const bad = Number.isFinite(e) && e < 0;
                return (
                  <li key={m.scenarioId} className="flex items-baseline gap-2 leading-snug">
                    <span className="flex-1 min-w-0 truncate text-2xs text-slate-600">{m.label}</span>
                    {/* 🚨 効き目が **文字だけ** だった。危険が何件減るかを点で並べる。
                        緑＝減る(ahead) / 赤＝増える(late) / 変わらない＝灰の輪1つ。
                        🚨 ここで数えない。m.effect をそのまま点にするだけ。 */}
                    <Dots
                      count={Number.isFinite(e) ? Math.abs(e) : null}
                      cap={12}
                      tone={good ? 'ahead' : (bad ? 'late' : 'quiet')}
                      size="w-2 h-2"
                      className="shrink-0"
                      title="危険なロットが増減する件数"
                    />
                    <b className={`shrink-0 text-xs font-black tabular-nums ${
                      good ? 'text-emerald-700' : (bad ? 'text-rose-700' : 'text-slate-500')
                    }`}
                    >
                      {!Number.isFinite(e) ? '—' : (e === 0 ? '変わりません' : `危険 ${e > 0 ? '−' : '+'}${fmtInt(Math.abs(e))}件`)}
                    </b>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="mt-1 flex items-center gap-1.5 text-2xs text-slate-500"><Signal level="unknown" size="w-4 h-4" />まだ1つも計算していません（上のシナリオを押すと、ここに効き目が並びます）</div>
          )}

          {(improvements.candidates || []).length ? (
            <div className="mt-1.5 pt-1.5 border-t border-dashed border-slate-200">
              <div className="text-2xs font-bold text-slate-500">まだ測っていない手</div>
              <div className="mt-0.5 flex flex-wrap gap-1">
                {improvements.candidates.map((c) => (
                  <span key={c.scenarioId} className="inline-flex items-center rounded-lg border border-slate-200 bg-slate-50 px-2 py-0.5 text-2xs text-slate-500">
                    {c.label}
                  </span>
                ))}
              </div>
              <div className="mt-0.5 text-2xs text-slate-400">
                🚨 押して計算するまで効き目の数字は出しません（測っていない物に数を作らないため）
              </div>
            </div>
          ) : null}

          {(improvements.rejected || []).length ? (
            <div className="mt-1.5 text-2xs text-amber-700">
              条件が違うので比べなかった手: {improvements.rejected.map((r) => r.label).join(' / ')}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ── 将来足りなくなる工程と、教育の提案（仕様書11章 / C5・T033〜T036）── */}
      {education && !education.error ? (
        <div className="rounded-xl border border-violet-200 bg-violet-50/60 px-3 py-2">
          <div className="flex items-center gap-1.5">
            <GraduationCap className="w-3.5 h-3.5 shrink-0 text-violet-600" />
            <span className="text-2xs font-black text-violet-800">この先で人が足りなくなる工程と、教育の案</span>
            <span className="ml-auto text-2xs text-slate-500">提案だけです。認定や実施の記録は書きません</span>
          </div>

          {/* 足りない工程。🚨「持てる人が0人」と「誰が持てるか分かりません」を混ぜない */}
          {(() => {
            const sf = Array.isArray(education.shortfalls) ? education.shortfalls : [];
            const noOne = sf.filter((x) => x.kind === 'no-one');
            const only1 = sf.filter((x) => x.kind === 'single-person');
            const cap = sf.filter((x) => x.kind === 'capacity');
            const unknown = sf.filter((x) => x.kind === 'unknown');
            if (!sf.length) {
              return <div className="mt-1 text-2xs text-slate-500">足りない工程は出ていません。</div>;
            }
            return (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {noOne.length ? <Pill tone="rose" label="担当できる人が居ない工程" n={noOne.length} /> : null}
                {only1.length ? <Pill tone="amber" label="担当できるのが1人だけの工程" n={only1.length} /> : null}
                {cap.length ? <Pill tone="amber" label="時間が足りない工程" n={cap.length} /> : null}
                {unknown.length ? <Pill tone="slate" label="誰が担当できるか分からない工程" n={unknown.length} /> : null}
              </div>
            );
          })()}

          {/* OJT の候補 */}
          {(() => {
            const o = education.ojt;
            const cands = o && Array.isArray(o.candidates) ? o.candidates : [];
            if (!o) return null;
            if (!cands.length) {
              // 🚨 見送りの理由は why / missingLabels に入っている（reason や gap ではない）。
              //   読む項目を間違えると画面に「?」が並ぶ（実際に52件出た）。
              const reasons = {};
              (Array.isArray(o.rejected) ? o.rejected : []).forEach((r) => {
                const t2 = r.why || (Array.isArray(r.missingLabels) ? r.missingLabels.join('・') : '');
                const k = t2 || '理由が入っていません';
                reasons[k] = (reasons[k] || 0) + 1;
              });
              const why = Object.entries(reasons).length
                ? Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 3)
                  .map(([k, n]) => `${k}（${n}工程）`).join(' / ')
                : '条件がそろっていません';
              return (
                <div className="mt-1.5 pt-1.5 border-t border-dashed border-violet-200 text-2xs text-slate-600">
                  一緒にやって覚える案（OJT）は出せませんでした — <span className="text-slate-500">{why}</span>
                </div>
              );
            }
            return (
              <div className="mt-1.5 pt-1.5 border-t border-dashed border-violet-200">
                <div className="text-2xs font-bold text-violet-700">一緒にやって覚える案（指導する人と、教わる人の2人が同時に埋まります）</div>
                <ul className="mt-0.5 flex flex-col gap-0.5">
                  {cands.slice(0, 4).map((c) => (
                    <li key={`${c.processKey}|${c.trainee}`} className="text-2xs text-slate-700 leading-snug">
                      <b>{c.title || '（工程名の記録がありません）'}</b>
                      <span className="text-slate-500">：{c.mentor} さんが {c.trainee} さんへ</span>
                      {c.lotId ? <span className="text-slate-400">（実際のロット {c.lotId}）</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })()}

          {/* 動画・確認テストの候補 */}
          {education.study && Array.isArray(education.study.candidates) && education.study.candidates.length === 0 ? (
            <div className="mt-1 text-2xs text-slate-500">
              動画・確認テストの案はまだ出せません（工程と講座の結び付けが登録されていません）。
            </div>
          ) : null}

          {Array.isArray(education.notes) && education.notes.length ? (
            <div className="mt-1 text-2xs text-slate-400">{education.notes.join(' ／ ')}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 条件・根拠タブの下段(分かっていない事 ＋ 力量の注記・基準時刻・根拠を見る ＋ 読み書き数・かかった時間)。
 * 元は Header の下段と時間の操作カードに居た物を、そのままの文言で移した(2026-08-30 画面4分割)。
 *
 * @param {object|null} inputQuality normalizeInput の inputQuality。到着・工数・設備の「分かっていない事」
 * @param {number|null} baseNow この見立ての基準時刻（仕様書11章「上段」）
 * @param {boolean} baseShifted 端末の時計から動かしたか（2026-08-30「次の勤務開始から」）
 * @param {number|null} wallNow 端末の時計。動かした時だけ添える
 * @param {Function|null} onOpenEvidence 「根拠を見る」で根拠・データ監査を開く
 * @param {object|null} diagnostics normalized.diagnostics(読み書き数の実測)
 * @param {number|null} elapsedMs 計算にかかった時間(ms)
 */
export function BasisNotes({
  inputQuality = null,
  baseNow = null,
  /**
   * 基準時刻を端末の時計から後ろへ動かしたか(2026-08-30「次の勤務開始から」)。
   * 動かした時は、動かした事と 端末の時計 の両方をここに残す。
   */
  baseShifted = false,
  wallNow = null,
  /**
   * 上(全タブ常設の帯)が既に同じ基準時刻を出しているか(2026-08-30「重複文言を整理」)。
   * 🚨 true の時だけ、この下の帯では基準時刻を繰り返さない。既定は false ＝ 今までどおり出す
   *   (この部品を別の場所で使った時に、基準時刻が**どこにも出ない**事故を作らない為)。
   */
  baseNowShownAbove = false,
  onOpenEvidence = null,
  diagnostics = null,
  elapsedMs = null,
  verdictLoading = false,
  /**
   * 段ごとの所要時間（2026-08-30 追記）。計算側が実測した物をそのまま受ける。
   *   { phaseMs, partsMs, usedCachedHistory, usedCachedNormalize }
   * 🚨 ここで時間を測らない・作らない。**渡された数字を並べるだけ**。
   * 🚨 これは技術の話なので、この画面で一番小さく・一番地味に出す（清水さんの判断材料ではない）。
   *   出す理由: 次に遅くなった時、人が測りに行かなくても その場で重い段が分かる様にする為。
   */
  perf = null,
  /**
   * 📅 工場の暦(祝日・年末年始・お盆・全社休業・休日出勤)の札。
   * 形: { count, months: [{ label, rangeLabel, workdays, calendarDays, holidays, workOverrides }] }
   * 🚨 **ここで日数を数え直さない**。同じ数字を2つの計算から出さないため、
   *   forecast.buildMonthPeriods が作った札をそのまま並べるだけにする。
   * 🚨 登録が0件の時は「祝日を引いていません」と **正直に** 出す。
   *   黙っていると「祝日も見た上での数字」と読まれる。
   */
  factoryCalendar = null,
}) {
  const reads = Number(diagnostics?.reads) || 0;
  const writes = Number(diagnostics?.writes) || 0;
  const cleanIO = reads === 0 && writes === 0;
  // 🚨 まだ測っていない時に 0ms と出さない。Number(null) は 0 になるので null を先に外す。
  const elapsed = (elapsedMs == null || !Number.isFinite(Number(elapsedMs)))
    ? null
    : Math.round(Number(elapsedMs));

  /**
   * 段ごとの所要時間の行。
   * 🚨 並びは **計算が走った順**（履歴→正規化→割付→引き直し→全員万能→原因→教育）。
   *   重い順に並べ替えない。順番が変わると「どこで詰まったか」が読めなくなる。
   *   代わりに **一番重い段を 棒の濃さ・太字・札** の3つで目立たせる。
   * 🚨 段の名前は計算側(logPhaseBreakdown)と同じ言い方にする。画面と記録で字が違うと突き合わせられない。
   * ⚠ 測っていない段(値が無い)は行ごと出さない。0ms と書くと「一瞬で終わった」と嘘になる。
   */
  const { perfRows, perfSum, perfMax, perfSummary } = useMemo(() => {
    const ph = (perf && perf.phaseMs) || null;
    const parts = (perf && perf.partsMs) || {};
    if (!ph || typeof ph !== 'object') return { perfRows: [], perfSum: 0, perfMax: 0, perfSummary: '' };
    const ms = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
    const defs = [
      { key: 'history', label: '① 履歴（担当できる人）' },
      { key: 'normalize', label: '② 正規化（ロット→仕事）' },
      { key: 'simulate', label: '③ 通常の割付' },
      { key: 'resample', label: '③′ 引き直し（合計）' },
      { key: 'resample.samples', label: '└ 実測の束を作る', sub: true, from: ms(parts.samples) },
      { key: 'resample.draw', label: '└ 引き直し本体', sub: true, from: ms(parts.draw) },
      { key: 'allSkills', label: '④ 全員万能（原因判定用）' },
      { key: 'explain', label: '⑤ 原因と対策' },
      { key: 'education', label: '⑥ 教育の提案' },
    ];
    const rows = defs
      .map((d) => ({ ...d, ms: d.sub ? d.from : ms(ph[d.key]) }))
      .filter((d) => d.ms != null);
    // 合計は **段だけ** を足す（内訳の2行は引き直しの中身なので二重に数えない）。
    const sum = rows.filter((r) => !r.sub).reduce((a, r) => a + r.ms, 0);
    const max = rows.reduce((a, r) => Math.max(a, r.ms), 0);
    // 「いちばん重い」は段どうしで決める。内訳の行には付けない。
    let heavyKey = null;
    let heavyMs = -1;
    rows.forEach((r) => { if (!r.sub && r.ms > heavyMs) { heavyMs = r.ms; heavyKey = r.key; } });
    const marked = rows.map((r) => ({ ...r, heaviest: r.key === heavyKey }));
    const heavyLabel = (marked.find((r) => r.heaviest) || {}).label || '';
    // 🚨 「初回」と「再計算」で値が変わる。どちらの計算の数字かを必ず言う。
    //   使い回した段が1つでもあれば再計算。使い回しの有無は計算側が meta に入れている。
    const cached = [];
    if (perf && perf.usedCachedHistory) cached.push('履歴');
    if (perf && perf.usedCachedNormalize) cached.push('正規化');
    const kind = cached.length
      ? `再計算（${cached.join('・')}は前の結果を使い回しました）`
      : '初回（全部の段を計算しました）';
    const sec = Math.round(sum / 100) / 10;
    const summary = `計算にかかった時間：${sec}秒 ／ ${kind}${heavyLabel ? ` ／ いちばん重い段は「${heavyLabel.replace(/^[①-⑥]′?\s*/, '')}」` : ''}`;
    return { perfRows: marked, perfSum: sum, perfMax: max, perfSummary: summary };
  }, [perf]);

  return (
    <div className="flex flex-col gap-2.5">

      {/* ── データ品質の警告（仕様書11章「下段」/ T031）──────────────────────
          🚨 数字だけ見せて「分かっていない事」を隠さない。設備は常時出す。 */}
      {inputQuality ? (
        <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-600" />
          <span className="text-2xs font-black text-amber-800">この結果で分かっていない事</span>
          {[
            ['到着予定を過ぎたまま現物未確認', inputQuality.arrivalOverdueCount, 'ロット'],
            ['到着日時が分からない', inputQuality.arrivalUnknownCount, 'ロット'],
            ['工数が分からない', inputQuality.missingEstimateCount, '工程'],
            ['工数の信頼度が低い', inputQuality.lowConfidenceEstimateCount, '工程'],
            // 🚨 これは **人×日** の数（4人×5日=20）。「20人」ではない。
            //   単位を書かないと人数と読まれる（実際に私が読み違えた）。
            ['勤務の予定が入っていない（人×日）', inputQuality.missingAvailabilityCount, '人日'],
          ].filter(([, n]) => Number(n) > 0).map(([label, n, unit]) => (
            <span key={label} className="inline-flex items-baseline gap-1 rounded-lg border border-amber-200 bg-white px-2 py-1 text-2xs">
              <span className="text-slate-600">{label}</span>
              <b className="text-amber-700 tabular-nums">{fmtInt(n)}{unit || '件'}</b>
            </span>
          ))}
          {inputQuality.equipmentUnmodeled ? (
            <span className="inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-white px-2 py-1 text-2xs font-bold text-amber-800">
              設備を見ていません（設備待ちで止まる分はこの結果に出ません）
            </span>
          ) : null}
          {inputQuality.legacyWorkerCountConflict ? (
            <span className="inline-flex items-center gap-1 rounded-lg border border-rose-300 bg-white px-2 py-1 text-2xs font-bold text-rose-700">
              🚨 名前のある人数と、設定の人数が食い違っています（計算は名前のある人で回しています）
            </span>
          ) : null}
        </div>
      ) : null}

      {/* ── 📅 工場の暦(祝日・年末年始・お盆・全社休業・休日出勤) ─────────────
          🚨 清水さん(2026-09-01)「祝日表はいるね、これないと処理能力わからないからね」。
            営業日を、1日でも多く数えているかどうかは、必要な人数にそのまま出る。
            2026年9月は 平日22日のうち3日が祝日 = 営業19日。引かないと 13.6% 多く見積もる。
          🚨 札の数字は計算側(buildMonthPeriods)が作った物をそのまま出す。画面で数え直さない。 */}
      {factoryCalendar ? (
        <div className={`flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 ${
          Number(factoryCalendar.count) > 0 ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'}`}>
          <span className="text-2xs font-black text-slate-700">📅 工場の暦</span>
          {Number(factoryCalendar.count) > 0 ? (
            <span className="text-2xs font-bold text-emerald-800">
              祝日・休業を {fmtInt(factoryCalendar.count)}日分 引いて計算しています
            </span>
          ) : (
            <span className="text-2xs font-bold text-amber-800">
              🚨 祝日を引いていません（登録が0件）。実際の営業日はこの数より少なくなります
            </span>
          )}
          {(Array.isArray(factoryCalendar.months) ? factoryCalendar.months : []).map((m) => (
            <span key={m.label} className="inline-flex items-baseline gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-2xs">
              <b className="text-slate-700">{m.label}</b>
              <span className="text-slate-600 tabular-nums">{m.rangeLabel}</span>
            </span>
          ))}
        </div>
      ) : null}

      {/* 🚨 この帯は **消さない**。力量が仮の物である事は、いつでも辿れる所に無ければいけない。
          🚨 2026-08-30「重複文言を整理」: 基準時刻は上の帯(全タブ常設)が同じ物を出しているので、
            このタブでは二重に言わない。⚠ただし上の帯が出ていない時(基準時刻がまだ無い等)は
            ここで言う。情報を消すのではなく、**同じ画面で2回言わない**だけ。 */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
        <Info className="w-3.5 h-3.5 shrink-0 text-slate-400" />
        <span className="text-2xs text-slate-600 leading-snug">
          力量は過去の作業記録から作った仮の物です。正式な認定ではありません。
        </span>
        {baseNow && !baseNowShownAbove ? (
          <span className="text-2xs text-slate-500">
            基準時刻 <b className="tabular-nums text-slate-700">{new Date(baseNow).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</b> 時点の見立て
            {/* 2026-08-30: 端末の時計から動かした時は、必ずその事を添える。
                添えないと「なぜ夜に開いたのに朝の話になっているのか」が読めない。 */}
            {baseShifted ? (
              <>
                （{BASE_TIME_MODE_LABEL[BASE_TIME_MODE.NEXT_START]}）
                {wallNow ? (
                  <span className="text-slate-400">
                    {' '}端末の時計 {new Date(wallNow).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                ) : null}
              </>
            ) : null}
          </span>
        ) : null}
        <button
          type="button"
          onClick={onOpenEvidence}
          className="ml-auto inline-flex items-center gap-1 min-h-11 px-2.5 rounded-lg border border-cyan-300 bg-white text-2xs font-bold text-cyan-700 hover:bg-cyan-50"
        >
          <HelpCircle className="w-3.5 h-3.5" />
          根拠を見る
        </button>
      </div>

      {/* ── 性能と読み書き数(元は時間の操作カードの右下に居た開発用の数字) ──────
          🚨 「追加の読み取り0件 / 書き込み0件」は **消さない**。
             この画面が本番データを触らない事の唯一の見える証拠なので。 */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2">
        <span className="inline-flex items-center gap-1 text-2xs text-slate-500">
          <Loader2 className={`w-3 h-3 ${verdictLoading ? 'animate-spin text-cyan-600' : 'text-slate-300'}`} />
          かかった時間
          <b className="text-xs font-black text-slate-700 tabular-nums">{elapsed == null ? 'まだ測っていません' : `${fmtInt(elapsed)} ms`}</b>
        </span>
        <span className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-2xs font-bold ${
          cleanIO ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-rose-200 bg-rose-50 text-rose-700'
        }`}
        >
          <Database className="w-3 h-3" />
          追加の読み取り {fmtInt(reads)}件 / 書き込み {fmtInt(writes)}件
        </span>

        {/* ── 段ごとの所要時間。この画面の一番下・一番地味に置く ─────────────
            🚨 技術の話。畳んだ時は1行だけ。色は灰(quiet)で、上の判断材料より弱くする。
            🚨 数字はここで作らない。計算側の実測(meta.phaseMs / resample.partsMs)をそのまま並べる。 */}
        {perfRows.length ? (
          <div className="basis-full">
            <Fold quiet openLabel="内訳を見る" summary={perfSummary}>
              <div className="flex flex-col gap-0.5">
                {perfRows.map((r) => {
                  const pct = perfMax > 0 ? Math.round((r.ms / perfMax) * 100) : 0;
                  return (
                    <div key={r.key} className="flex items-center gap-1.5 leading-snug">
                      <span className={`w-40 shrink-0 truncate text-2xs ${r.sub ? 'text-slate-400 pl-2' : 'text-slate-500'}`}>
                        {r.label}
                      </span>
                      {/* 棒。一番重い段を長さで見せる。⚠ 棒は「段どうしの比べ物」であって割合ではない */}
                      <span className="flex-1 min-w-[40px] h-1.5 rounded-full bg-slate-100 overflow-hidden">
                        <span
                          className={`block h-full rounded-full ${r.heaviest ? 'bg-slate-500' : 'bg-slate-300'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </span>
                      <b className={`w-16 shrink-0 text-right text-2xs tabular-nums ${r.heaviest ? 'font-black text-slate-700' : 'font-bold text-slate-500'}`}>
                        {fmtInt(r.ms)} ms
                      </b>
                      <span className="w-20 shrink-0 text-2xs text-slate-400">
                        {r.heaviest ? 'いちばん重い' : ''}
                      </span>
                    </div>
                  );
                })}
                <div className="mt-1 pt-1 border-t border-dashed border-slate-200 text-2xs text-slate-400 leading-snug">
                  段の足し算は {fmtInt(perfSum)} ms です。
                  {elapsed == null ? null : <>「かかった時間」{fmtInt(elapsed)} ms との差は、段に分けて測っていない受け渡しなどの分です。</>}
                  {' '}この数字は計算のたびに測り直します（この画面で作った物ではありません）。
                </div>
              </div>
            </Fold>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 条件・根拠タブの上段(見る範囲・何日先まで・工数の見積り ＋ 仮の入荷日)。
 * 元は Header の時間の操作カードに居た物を、そのままの文言で移した(2026-08-30 画面4分割)。
 * ⚠ どれも変えると計算し直しになる(入力の指紋が変わる)。それは前から同じ。
 */
export function BasisControls({
  scope = 'onhand',
  onScope,
  // 何日先まで。⚠ 変えると計算し直しになる。
  horizonDays = 5,
  onHorizonDays,
  /* 🚨 2026-09-04 決まり19A: 「30日」という **届く日が言えない数字** をやめ、
     5営業日 / 今月 / 来月 の3つにした（前の担当の実測: 「30日」は 10/16 までしか届かず、
     月末に立つ納期の山が線の外へ落ちて画面に1件も出ていなかった）。
     ⚠ この4つが渡らない時は今までの2択のまま動く（他の呼び出し元を巻き込まない）。 */
  rangeKey = null,
  rangeItems = null,
  rangeInfo = null,
  onRange = null,
  // 工数の見積り（'P50'|'P75'|'P90'）。⚠ 変えると入力の指紋が変わる＝前の結果と比べられない。
  estimateMode = 'P75',
  onEstimateMode,
  /** 仮に置く入荷日（0=置かない / 2=納期の2日前）。🚨 既定は2=ON(2026-08-31)。仮定なので画面で必ず言う */
  assumeArrivalDays = 2,
  onAssumeArrivalDays = null,
}) {
  const useRange = !!(rangeKey && Array.isArray(rangeItems) && rangeItems.length && typeof onRange === 'function');
  return (
    <div className="bg-white border border-slate-200 shadow-sm rounded-xl p-2.5 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-2xs font-bold text-slate-500" title="どのロットを見立てに載せるか（手元だけ／14日以内に入る分まで／ぜんぶ）。変えると計算し直しになります">見ている範囲</span>
        <PillGroup ariaLabel="見ている範囲" items={OPSIM_SCOPES} activeKey={scope} onPick={onScope} />
        <span className="text-2xs font-bold text-slate-500 ml-1" title="何日先まで時間を進めるか。届く日は横の札に出ます。変えると計算し直しになります">{useRange ? '期間' : '何日先まで'}</span>
        {useRange ? (
          <>
            <PillGroup ariaLabel="期間" items={rangeItems} activeKey={rangeKey} onPick={onRange} />
            {/* 🚨 届く日を必ず札に出す（数字だけ置いて「30日ってどこまで？」にしない）。 */}
            <span className="text-2xs text-slate-500" data-opsim-range-reach="">
              {rangeInfo ? `${rangeInfo.rangeText}・営業${rangeInfo.days}日・暦${rangeInfo.calDays}日` : ''}
            </span>
          </>
        ) : (
          <PillGroup
            ariaLabel="何日先まで"
            items={OPSIM_HORIZONS}
            activeKey={Number(horizonDays) === 30 ? 30 : 5}
            onPick={onHorizonDays}
          />
        )}
        <span className="text-2xs font-bold text-slate-500 ml-1" title="実績のどの線で工数を見るか（P50=まん中／P75=上から4分の1・既定／P90=上から1割）。変えると入力そのものが変わるので前の結果とは比べられません">工数の見方</span>
        <PillGroup
          ariaLabel="工数の見方"
          items={OPSIM_ESTIMATE_MODES}
          activeKey={estimateMode}
          onPick={onEstimateMode}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-200">
        <span className="text-2xs font-bold text-slate-500" title="入荷日が分からないロットに仮の入荷日を置くか。これは仮定で、元のデータには1文字も書き戻しません">仮の入荷日</span>
        {/* 🚨🚨 仮に置く入荷日（2026-08-24 清水さん「入荷時間ないからほとんど動かなかった」）。
            入荷が分からない／予定を過ぎた物は人が付かないので、盤に出ても一生動かない。
            🚨 既定はON（2026-08-31 清水さん「とりあえず仮日入れないとなんもできない」。
              8/25の既定OFFは、清水さんから見れば作っていないのと同じだった）。
              押すと OFF＝「仮に置かない（実データだけで計算）」へ下がる。OFFの道は残す。
            ⚠ **これは仮定**。元のデータには1文字も書き戻さない。押している間は必ずそう言う。 */}
        {/* 案A(2026-09-16): 画面には短い語だけ。長い説明(仮の当て方・元のデータは変えない・件数と顔ぶれの在りか)は
            全部 title へ移した(1文字も消していない。指を置く／マウスを載せると出る)。 */}
        <button
          type="button"
          onClick={() => { if (typeof onAssumeArrivalDays === 'function') onAssumeArrivalDays(assumeArrivalDays > 0 ? 0 : 2); }}
          title={(assumeArrivalDays > 0
            ? '入荷日が入っていない／予定を過ぎたままの物を、「納期の2日前に着く」と仮に置いて計算しています（既定）。本当の入荷日が入っている物には仮を当てません。元のデータは1文字も変えません。押すと、仮に置かず実データだけで計算します。'
            : '仮に置かず、実データだけで計算しています。入荷日が無い物は判定がつきません。押すと「納期の2日前に着く」と仮に置いて計算します（既定）。')
            + ' 仮で置いた件数と顔ぶれは、上の⚠の帯（どのタブでも出ます）に出ます。'}
          className={`min-h-11 px-3 rounded-lg border-2 text-2xs font-black leading-tight ${assumeArrivalDays > 0
            ? 'border-amber-500 bg-amber-100 text-amber-900'
            : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'}`}
        >
          {assumeArrivalDays > 0 ? '⚠ 納期の2日前に仮置き（既定）' : '仮置きなし（実データだけ）'}
        </button>
        <span className="text-2xs text-slate-500 leading-snug" title="仮で置いた件数と顔ぶれは、上の⚠の帯（どのタブでも出ます）に出ます。">
          件数と顔ぶれは上の⚠の帯
        </span>
      </div>
    </div>
  );
}

export default Header;

/**
 * 主因・副因・判定上の不足（仕様書5.10 / 11章「主結果」）。🚨 原因を1つに絞らない。「分かっていない事」は原因と別の段に置く。
 * 2026-09-19: 「今日の判断」の札が無くなって どこからも開けなくなっていたので 部品にした(出す所＝主役の下の「▾ くわしく」)。中身は1文字も変えていない。
 */
export function CauseTiersNote({ causeTiers = null }) {
  if (!(causeTiers && (causeTiers.primary || causeTiers.secondary || (causeTiers.gaps || []).length))) return null;
  return (
    <div data-opsim-cause-tiers="1" className="rounded-xl border border-slate-200 bg-white px-3 py-2 flex flex-col gap-1.5">
      {causeTiers.primary ? (
        <div className="flex items-start gap-1.5">
          <span className="shrink-0 rounded-md bg-rose-100 px-1.5 py-0.5 text-2xs font-black text-rose-700">主因</span>
          <span className="text-2xs text-slate-700 leading-snug">
            <b>{causeTiers.primary.label}</b>
            <span className="text-slate-500"> — {causeTiers.primary.detail}</span>
            {causeTiers.primary.note ? <span className="block text-amber-700">{causeTiers.primary.note}</span> : null}
          </span>
        </div>
      ) : null}
      {causeTiers.secondary ? (
        <div className="flex items-start gap-1.5">
          <span className="shrink-0 rounded-md bg-amber-100 px-1.5 py-0.5 text-2xs font-black text-amber-700">副因</span>
          <span className="text-2xs text-slate-700 leading-snug">
            <b>{causeTiers.secondary.label}</b>
            <span className="text-slate-500"> — {causeTiers.secondary.detail}</span>
          </span>
        </div>
      ) : null}
      {(causeTiers.gaps || []).map((g) => (
        <div key={g.cause} className="flex items-start gap-1.5">
          <span className="shrink-0 rounded-md bg-slate-100 px-1.5 py-0.5 text-2xs font-black text-slate-600">判定上の不足</span>
          <span className="text-2xs text-slate-600 leading-snug">
            <b>{g.label}</b>
            <span className="text-slate-500"> — {g.detail}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
