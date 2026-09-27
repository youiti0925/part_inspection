// =============================================================================
//  Board.jsx — 操業シミュレーションの盤面（モックの .battle にあたる所）
// -----------------------------------------------------------------------------
//  左＝これから入ってくる仕事 / 右＝納期のゲート。カードは左から右へ進む。
//
//  🚨 ここは **描くだけ**。計算は src/domain/operationsSimulation/ の完成済みエンジン。
//     この部品は simulate.js が作った snapshot（{ atMs, lots[], workers[] }）を
//     そのまま受け取って並べるだけで、時間も力量も一切ここでは作らない。
//
//  🚨 カードの横位置は snapshot.lots[].duePosRatio ただ1つで決める。
//     これは「到着から納期線までの時間の、どこまで来たか」で、時刻が進めば必ず増える。
//     ⚠ 実データで −4.53 〜 17.77 まで出る（到着前＝負 / 予定日を過ぎた物＝1超）。
//
//  🚨🚨 **盤に出す物を絞る（focus）**。前の版は 179件を全部レーンへ入れていた。
//     本番データの duePosRatio の散らばり（`opsim-sample.json` の snapshotSample 179件を
//     このファイルの判定式で数えた実測）:
//        <0 が 87件 ／ 0〜0.75 が 0件 ／ 0.75〜1 が 14件 ／ >1 が 64件 ／ null 14件
//     0..1 に丸めて置くと **左端か右端の2値**にしかならず、時刻を進めても札が動かない。
//     さらに、この null 14件のうち12件は「納期が到着より前」で位置が出せない物なので、
//     左端に置くと一生動かない。納期線（dueLineMs）を過ぎている事実で右の帯へ回す。
//     → focus='moving' では「担当が付いている物」と「届いていて、まだ納期線を越えていない物」
//        だけを盤へ出し、**まだ届いていない物は左の帯／予定日を過ぎた物は右の帯**へ逃がす。
//     🚨 盤から外した物は **必ず件数で出す**（黙って間引いたように見せない）。
//
//  🚨 横位置は「ratio=0 の left」と「ratio=1 の left」を先に出し、その間を割り付ける。
//     前の版は中心を出してから両端で clamp していたので、端に寄った札は ratio が変わっても
//     left が同じ値へ潰れた＝時間を進めても動かなかった。ここは単調でなければならない。
//
//  🚨 カード同士を重ねない（是正指示書 6.3）。同じレーンで位置が近い物は縦にずらす。
//     縦に置ける段数は盤の高さで決まるので、置き切れない分は数だけ柱に出す。
//  🚨 片付いた仕事は盤から消す（是正指示書 6.3）。エンジン側でも消しているが、
//     ここでも念のため落とす（前の版は90枚居座った）。
//
//  ⚠ 色は PANEL_SPEC 1章の翻訳表どおり。**濃紺は使わない**。白＋slate＋cyan-600。
//  ⚠ 文字は px 直書きにしない。`text-2xs`(0.6875rem=11px) が最小で、
//     これは tailwind.config.js の var(--text-2xs) 経由なので文字サイズ設定に追従する。
//     fi-tap-text と見た目は同じだが、px 直書きだと拡大に付いてこない。
//  ⚠ 出してはいけない言葉（できない/不可/未経験/初級/上級者/有意/標本/スコア/偏差）は
//     この画面に1つも出さない。担当が付いていない＝「人が決まっていません」であって
//     「やれません」ではない。
// =============================================================================
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LATE_TONE } from './lateTone.js';
// 🚨 人の色は workerColors.js ただ1本。盤と右の一覧で必ず同じ色にする。
import { buildWorkerColors, toneOf, workerNamesOf, NEUTRAL_TONE } from './workerColors.js';
// 🚨「次の仕事」の規則は nextJob.js ただ1本。右の作業者一覧も同じ物を読む。
import { nextJobOf } from './nextJob.js';
// 🚨 決まり15（2026-09-04）: 「納期をどれだけ過ぎたか(+N日)」の式は lateDone.js の lateDays ただ1本
//   （App.jsx の納期分析・「遅れて完了」の棚と同じ物）。盤で2本目の式を作らない。
//   右の棚の ①納期を過ぎた（isPastDueAt）と ②遅れて終わる見込み（buildLateForecast）は lateForecast.js が数える。
//   ③遅れて完了（記録）は Panel が lateDone.js で数えて渡す。**3つの棚・3つの数。混ぜない**（2026-08-22）。
import { buildLateForecast, isPastDueAt, daysPastDueLine } from '../domain/operationsSimulation/lateForecast.js';
// 🚨 盤の寸法は boardDims.js ただ1本。**倍率 k で作り直した値**だけを読む
//   （CSS の zoom / transform: scale は使わない＝押した所がズレない）。
import {
  dimsOf, D1, MIN_VIEWPORT_H,
  BOARD_ZOOM_STEPS, BOARD_ZOOM_DEFAULT, BOARD_ZOOM_KEY, zoomStepOf,
} from './boardDims.js';
// 🚨 2026-09-04 決まり19A: 「この5日」を画面へ焼き込まない。
//   期間の言い方は horizonRange.js の opsimPeriodWord **ただ1本**から出す。
//   焼き込みが1つでも残ると、期間を「今月」へ変えても盤が「この5日」と言い続ける
//   （実測: Board.jsx に7か所。Board は horizonDays を1回も受け取っていなかった）。
import { opsimPeriodWord } from './horizonRange.js';
// 🎨 絵の語彙(2026-09-15)。🚨 ここで数を作らない。盤がもう持っている値
//   (daysLate / 件数 / 人の tone)を 長さ・点・形に変えるだけ。npm は増やしていない(手書きSVG)。
import { Avatar, Bar, Dots, Signal, Glyph } from './vizKit.jsx';
// 🚨 2026-09-05 清水さん(根拠の札の写真「いまは −33% の位置です」):
//   「納期線の右側にいます」の言い方は dispatchWords.js の1本だけ。盤(ここ)と
//   右の根拠(Side.jsx)で別々に書くと、片方だけ直して食い違う(2026-08-21『片方だけ直すな』)。
import { WORDS } from '../domain/dispatchWords.js';

/* ===========================================================================
 * 1. レーン（盤面の縦の分け方）＝ **品目コードごとに1本**（仕様書6.14 / T021）
 * ---------------------------------------------------------------------------
 * 🚨 2026-08-23 まで、ここはテンプレ名の語で4本に振り分けていた（円テーブル/傾斜/回転分割/受け皿）。
 *    仕様書は「品目コードごとの行」「同じ行にロット数だけカードがある」なので、**品目コードに変えた**。
 *
 * ⚠ 本番実測(2026-08-23・未完了282ロット):
 *      品目コードは **81種類**（空欄は0件）。1品目コードあたり 平均3.48 / 中央値2 / **最大50ロット**。
 *      **1ロットしか無い品目コードが31種類**。
 *    → 行は81本になり、盤は縦に長くなる（81行 × 92px ≒ 7,500px）。
 *      これは仕様どおり。**隠して短くしない**（隠すと「無い」と読まれる）。
 *      代わりに **急ぐ品目コードから上に並べる**ので、上から見れば足りる。
 *
 * 🚨 並び順は **時刻で変わらない物** で決める（packLane と同じ理由）。
 *    「その品目コードの中で一番早い納期線」→ 同じなら品目コード名。
 *    ここを「危ない順」など時刻で動く物にすると、時間を進めるたびに行が入れ替わり、
 *    カードが動いたのか行が動いたのか人が判別できなくなる。
 */
/** 品目コード名。空なら「品目コードなし」の1本にまとめる（黙って落とさない）。 */
export function laneKeyOf(lot) {
  const m = lot && typeof lot.model === 'string' ? lot.model.trim() : '';
  return m || '(品目コードなし)';
}

/* ===========================================================================
 * 1-b. 並べ替え（🚨 2026-08-24 清水さん「見づらい」）
 * ---------------------------------------------------------------------------
 * 🚨 「すでに予定日を過ぎた」「この先で遅れる」「判定できません」を **1つの点数に混ぜない**
 *   （2026-08-22: 1つの数で157件と出したが、正しくは 超過46 / この先40 / 判定不能13 だった）。
 *   段(tier)で分けて、**同じ段の中だけ** 二次キーを比べる。
 * 🚨 「この先で遅れる」は snapshot の lot.late では出せない。
 *   simulate.js:1027 の lot.late は `atMs > dueLineMs` ＝ **今日の事実** で、
 *   Board.jsx:690 の pastDue とまったく同じ条件。エンジンの見立ては
 *   result.base.lotResults の { late, alreadyPastDue, lateMs, judgeable } にしかない。
 * 🚨 priority は本番636件すべて 'normal'（急ぎは1件も無い）。
 *   急ぎ 0件でも tier0 が空になるだけで、並びは1行も壊れない。
 * ========================================================================= */
export const RISK_TIER = Object.freeze({
  HIGH_PRIORITY: 0,   // 急ぎ（lot.priority === 'high'）
  PAST_DUE: 1,        // すでに予定日を過ぎている（今日の事実）
  WILL_BE_LATE: 2,    // この先で遅れる（この見立ての結果）
  UNJUDGEABLE: 3,     // 判定できません（入っていない値がある）
  ON_TIME: 4,         // 上のどれでもない
});
export const RISK_TIER_LABEL = Object.freeze([
  '急ぎ',
  'すでに予定日を過ぎています（今日の事実）',
  'この先で遅れます（この見立ての結果）',
  '判定できません（入っていない値があります）',
  '',
]);

/** 1レーン（品目コード1つ）の段と、段の中の二次キー。🚨 段をまたいで足し引きしない。 */
function laneRiskOf(cards, highPriorityLotIds, lotVerdictById) {
  let tier = RISK_TIER.ON_TIME;
  let worstLateMs = 0;      // tier=2 の中だけで使う
  let oldestDueMs = Infinity;
  const counts = [0, 0, 0, 0, 0];
  for (const c of (Array.isArray(cards) ? cards : [])) {
    const lot = c && c.lot;
    if (!lot) continue;
    const id = String(lot.lotId);
    const d = Number(lot.dueLineMs);
    if (Number.isFinite(d) && d < oldestDueMs) oldestDueMs = d;
    const v = lotVerdictById ? lotVerdictById.get(id) : null;
    let t = RISK_TIER.ON_TIME;
    if (highPriorityLotIds && highPriorityLotIds.has(id)) t = RISK_TIER.HIGH_PRIORITY;
    else if (v && v.alreadyPastDue === true) t = RISK_TIER.PAST_DUE;
    else if (v && v.late === true) {
      t = RISK_TIER.WILL_BE_LATE;
      const ms = Number(v.lateMs);
      if (Number.isFinite(ms) && ms > worstLateMs) worstLateMs = ms;
    } else if (v && v.judgeable === false) t = RISK_TIER.UNJUDGEABLE;
    counts[t] += 1;
    if (t < tier) tier = t;
  }
  return { tier, worstLateMs, oldestDueMs, counts };
}

/**
 * 盤に出すカードから、品目コードのレーンを作る。
 * @param {Array} cards
 * @param {object} [opts]
 * @param {'due'|'risk'} [opts.sortMode] 'due'（既定・いままでの並び）/ 'risk'（納期がやばい順）
 * @param {Set<string>|null} [opts.highPriorityLotIds] 急ぎ(lot.priority==='high')のロットID
 * @param {Map<string,object>|null} [opts.lotVerdictById] エンジンの見立て(result.base.lotResults)
 * @param {Array<string>|null} [opts.frozenOrder] 再生を始めた時に固定した並び
 * @returns {{lanes:Array, appendedCount:number}}
 */
export function buildModelLanes(cards, opts = {}) {
  const {
    sortMode = 'due',
    highPriorityLotIds = null,
    lotVerdictById = null,
    frozenOrder = null,
  } = opts || {};

  const by = new Map();
  for (const c of Array.isArray(cards) ? cards : []) {
    const k = laneKeyOf(c && c.lot);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(c);
  }
  const earliest = (list) => {
    let best = Infinity;
    for (const c of list) {
      const d = c && c.lot && Number.isFinite(Number(c.lot.dueLineMs)) ? Number(c.lot.dueLineMs) : Infinity;
      if (d < best) best = d;
    }
    return best;
  };

  // 決まり12: レーン名にもテンプレを添える。同じ品目コードでテンプレが2つ以上なら全部並べる（丸めない）。
  const tplLabelOf = (list) => {
    const names = [...new Set(list.map((c) => (c && c.tplName) || '').filter(Boolean))];
    if (list.some((c) => !(c && c.tplName))) names.push('テンプレ名なし');
    return names.join('／');
  };
  const built = [...by.entries()].map(([id, list]) => ({
    id,
    label: id,
    tplLabel: tplLabelOf(list),
    cards: list,
    key: earliest(list),
    risk: laneRiskOf(list, highPriorityLotIds, lotVerdictById),
  }));

  // 既定＝その品目コードの一番早い納期線。**時刻で変わらない**（いままでどおり）。
  const byDue = (a, b) => (a.key - b.key) || String(a.id).localeCompare(String(b.id));
  // 納期がやばい順＝段で分ける。段の中だけ二次キーを見る。
  const byRisk = (a, b) => {
    if (a.risk.tier !== b.risk.tier) return a.risk.tier - b.risk.tier;
    if (a.risk.tier === RISK_TIER.WILL_BE_LATE && a.risk.worstLateMs !== b.risk.worstLateMs) {
      return b.risk.worstLateMs - a.risk.worstLateMs;   // 同じ段の中では遅れが大きい順
    }
    return byDue(a, b);
  };
  const cmp = sortMode === 'risk' ? byRisk : byDue;

  // 🚨 再生中は凍らせた並びだけを使う（統合担当の判断・2026-08-24）。
  //   凍結より後に増えた品目コードは **下へ付けて件数で言う**。割り込ませない・黙って消さない。
  if (Array.isArray(frozenOrder) && frozenOrder.length) {
    const rank = new Map(frozenOrder.map((id, i) => [id, i]));
    const known = built.filter((l) => rank.has(l.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id));
    const added = built.filter((l) => !rank.has(l.id)).sort(cmp);
    return { lanes: [...known, ...added], appendedCount: added.length };
  }
  return { lanes: built.sort(cmp), appendedCount: 0 };
}
/* ===========================================================================
 * 2. 盤の寸法と、**大きさの倍率 k** → src/opsim/boardDims.js
 * ---------------------------------------------------------------------------
 * 🚨 寸法は **boardDims.js ただ1本**。ここで px を作り直さない。
 *   2026-09-01: 「拡大」を入れるにあたって、寸法を倍率 k で作り直す形にした。
 *   CSS の zoom / transform: scale は使わない（押した所がズレる。2026-08-08 に廃止済み）。
 * ========================================================================= */
const STRIP_LIST_MAX = 4;    // 帯に名前で出す件数。これを超えた分は必ず「ほか N件」と数で出す

/**
 * 納期線の位置（盤の幅に対する％）。
 * 🚨 min(38%) と caution(64%) は **撤去した**（仕様書6.14-556〜560）。測った値ではなかった。
 *   due だけ残す。ここが duePosRatio=1 の場所＝「納期線」そのもの。
 *   ⚠ この数字は「盤のどこに線を引くか」という見た目の話で、判定には使わない。
 */
const LINE_PCT = Object.freeze({ due: 81 });
/** カードの走る道の左端（％）。duePosRatio 0 がここ、1 が納期線（81％）。 */
const TRACK_LEFT_PCT = 4;

// 上の対応から逆算した「札の色が変わる進み具合」。盤の幅が変わっても札がぶれないよう
// 比のまま定数にしておく（幅から毎回計算すると、窓を縮めただけで札の文字が変わる）。
// 🚨 2026-08-23 削除: R_CAUTION（注意ライン64%を比に直した物・≒0.779）。
//   固定の64%は測った値ではないので、これでカードの色を決めるのをやめた（statusOf を見る事）。

// 🚨 CARD_W_MIN / CARD_W_MAX はここから boardDims.js へ移した（2026-09-01）。
//   px の寸法をこのファイルに残すと、倍率を上げた時に **そこだけ標準のまま**になって重なる。
//   幅が要る所は D.CARD_W_MIN / D.CARD_W_MAX を読む事。

const MS_H = 3600000;
const MS_DAY = 86400000;

/* ===========================================================================
 * 3. 動き（モックの .7s cubic-bezier(.22,.72,.22,1) に寄せる）
 * ------------------------------------------------------------------------- */
const BOARD_CSS = `
.opsim-move {
  transition: left .7s cubic-bezier(.22,.72,.22,1), top .7s cubic-bezier(.22,.72,.22,1),
              width .7s cubic-bezier(.22,.72,.22,1), border-color .2s ease, box-shadow .2s ease;
}
.opsim-bar { transition: width .7s cubic-bezier(.22,.72,.22,1); }
@keyframes opsimBreachShake {
  0%, 100% { transform: translate3d(0, 0, 0); }
  15% { transform: translate3d(-3px, 0, 0); }
  35% { transform: translate3d(3px, 0, 0); }
  55% { transform: translate3d(-2px, 0, 0); }
  75% { transform: translate3d(2px, 0, 0); }
}
/* 越えた印。**1回だけ**震える（ずっと動かすと画面が読めない）。 */
.opsim-breach { animation: opsimBreachShake .55s cubic-bezier(.36,.07,.19,.97) 1 both; }
@keyframes opsimHold { 0%, 100% { transform: translate3d(0, 0, 0); } 50% { transform: translate3d(3px, 0, 0); } }
.opsim-hold { animation: opsimHold 1.4s ease-in-out infinite; }
/* 担当者の札が、右どなりのカードを **つつく**（2026-08-24 清水さん）。
   🚨 動く幅は 4px まで。大きくすると隣の段のカードに触れて、誰の札か読めなくなる。
   🚨 止まって見える人（手が空いている人）には付けない。付けると全員が働いて見える。 */
@keyframes opsimPokeRight {
  0%, 62%, 100% { transform: translate3d(0, 0, 0); }
  74% { transform: translate3d(4px, 0, 0); }
  86% { transform: translate3d(1px, 0, 0); }
}
@keyframes opsimPokeLeft {
  0%, 62%, 100% { transform: translate3d(0, 0, 0); }
  74% { transform: translate3d(-4px, 0, 0); }
  86% { transform: translate3d(-1px, 0, 0); }
}
.opsim-poke-right { animation: opsimPokeRight 1.8s cubic-bezier(.34,.6,.3,1) infinite; }
.opsim-poke-left  { animation: opsimPokeLeft  1.8s cubic-bezier(.34,.6,.3,1) infinite; }
@media (prefers-reduced-motion: reduce) {
  .opsim-move, .opsim-bar { transition: none; }
  .opsim-breach, .opsim-hold, .opsim-poke-right, .opsim-poke-left { animation: none; }
}
`;

/* ===========================================================================
 * 4. 小さい道具
 * ------------------------------------------------------------------------- */
const isNum = (v) => typeof v === 'number' && isFinite(v);
const clamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));
const clamp01 = (v) => clamp(v, 0, 1);

/** 🚨 0.30000000000000004 を出さない。時間は必ず丸めてから文字にする。 */
function fmtDur(ms) {
  if (!isNum(ms) || ms < 0) return '—';
  if (ms < MS_H) return `${Math.round(ms / 60000)}分`;
  return `${(ms / MS_H).toFixed(1)}h`;
}
function fmtMD(ms) {
  if (!isNum(ms)) return '—';
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '—';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
/** 🚨 月日だけだと「到着は 9/7 の予定」で朝か夕方か分からない。到着の予定は時刻まで書く。 */
function fmtMDHM(ms) {
  if (!isNum(ms)) return '—';
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '—';
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
const startOfDay = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
/** originMs（1日目の朝）が分かっている時だけ「N日目」と書ける。無ければ月日で書く。 */
function dayNoOf(ms, originMs) {
  if (!isNum(ms) || !isNum(originMs)) return null;
  return Math.floor((startOfDay(ms) - startOfDay(originMs)) / MS_DAY) + 1;
}
function dueText(lot, originMs) {
  if (!isNum(lot.dueLineMs)) return '納期 分かりません';
  const n = dayNoOf(lot.dueLineMs, originMs);
  // ⚠ 1日目より前に納期が来ている物（実データに78件ある）に「−27日目」とは書かない。
  //   数え始めより前なので日番号が付かない。月日で書いて、越えた事は状態札に任せる。
  if (n == null || n < 1) return `納期 ${fmtMD(lot.dueLineMs)}`;
  return `納期 ${n}日目`;
}
/** 左の帯（これから届く）に書く言葉。originMs が無い時は月日で書く（推測で日番号を作らない）。 */
function arrivalText(lot, originMs) {
  if (!isNum(lot.arrivalMs)) return '到着 分かりません';
  const n = dayNoOf(lot.arrivalMs, originMs);
  if (n == null || n < 1) return `${fmtMD(lot.arrivalMs)} に届く`;
  return `${n}日目に届く`;
}
function remainText(lot) {
  const known = lot.remainingKnown !== false;
  if (!known && !(lot.remainingMs > 0)) return '残 未登録';
  return known ? `残 ${fmtDur(lot.remainingMs)}` : `残 ${fmtDur(lot.remainingMs)}＋未登録`;
}
function doneText(lot) {
  if (!isNum(lot.doneRatio)) return '進み —';
  return `進み ${Math.round(clamp01(lot.doneRatio) * 100)}%`;
}

/** templatesById は Map でも素のオブジェクトでも、値が文字列でも受ける。 */
function tplNameOf(templatesById, id) {
  if (!id || !templatesById) return '';
  const t = templatesById instanceof Map ? templatesById.get(id) : templatesById[id];
  if (typeof t === 'string') return t;
  return (t && typeof t.name === 'string') ? t.name : '';
}

// simulate.js の WORKER_STATE と同じ文字列。
// ⚠ Worker 越しに JSON で来る値なので、エンジン本体を画面へ import しない。
const W_WORKING = 'working';

/**
 * 担当が付いていないカードに添える理由。**1語**（PANEL_SPEC 3章の6）。
 * 🚨 ここで作ってよいのは snapshot に実際に載っている事実だけ。
 *    「やれません」に読める言い方は作らない。
 */
function noOneReason(lot, snapWorkers) {
  if (lot.remainingKnown === false) return '時間未登録';
  const list = Array.isArray(snapWorkers) ? snapWorkers : [];
  if (list.length > 0 && list.every((w) => w && w.state === W_WORKING)) return '全員作業中';
  return '順番待ち';
}

/** カードの状態札。順番＝越えた > まだ来ていない > 押し込まれる > 人が当たっている > それ以外。 */
/**
 * カードの札（色と一言）。
 *
 * 🚨 2026-08-23 是正（仕様書6.14-556〜560）:
 *   以前は **位置**（固定の注意ライン64%より右か）で「押し込まれる」を付けていた。
 *   あの64%は測った値ではないので、遅れる見込みが無いカードにも黄色が付いていた。
 *   いまは **見込み** で決める:
 *     突破    … すでに納期線より先に居る（今の事実）
 *     遅れます … この見立てでは納期に間に合わない（willBeLate＝計算の結果）
 *     これから … まだ届いていない
 *     迎撃中  … 担当が付いて動いている
 *     分かりません … 納期か到着が無くて位置が出せない
 *     順番待ち … 上のどれでもない
 *   ⚠ 「突破」と「遅れます」は別物。突破＝今の位置 / 遅れます＝この先の見込み。
 *     混ぜると「線の手前なのに突破」が出る。
 */
function statusOf({ breached, notArrived, ratio, hasWorker, willBeLate }) {
  if (breached) return { label: '突破', cls: 'bg-rose-50 text-rose-600 border-rose-200' };
  if (notArrived) return { label: 'これから', cls: 'bg-slate-100 text-slate-500 border-slate-200' };
  if (willBeLate) return { label: '遅れます', cls: LATE_TONE.forecast.chip };
  if (ratio == null) return { label: '分かりません', cls: 'bg-slate-100 text-slate-500 border-slate-200' };
  if (hasWorker) return { label: '迎撃中', cls: 'bg-cyan-50 text-cyan-700 border-cyan-300' };
  return { label: '順番待ち', cls: 'bg-slate-100 text-slate-500 border-slate-200' };
}

/* ---------------------------------------------------------------------------
 * 4-a-2. 横位置の **生の値** を出す ただ1本
 * ---------------------------------------------------------------------------
 * 🚨🚨 2026-09-05(検証で出た穴): 位置の **言い方** は positionSentence 1本にしたのに、
 *   **数字** が2本のままだった。盤(lotFactsOf)は つまみの時刻(nowMs)で出し直し、
 *   右の根拠(Side.jsx)は記録(snapshot)の値をそのまま使っていた。記録は
 *   snapshotEveryMs 刻みの標本なので、必ず つまみの時刻より前(最大でその刻みぶん)。
 *   その結果、同じ引き出しの中で 上のカードが「45% の所です」、
 *   すぐ下の根拠が「41% の所です」と、**文言が同じまま数字だけ違う**形になっていた。
 *   到着が その2つの時刻の間に入る時は、片方が「N% の所です」もう片方が
 *   「まだ着いていません」と正反対の事を言う道まで在った。
 *   → 生の値も **ここ ただ1本**。盤も右も この関数を呼ぶ
 *     (決まり「同じ数字を2つの計算から出さない」)。
 * 🚨 式は simulate.js の posRatioOf と同じ物(画面で3本目を書かない)。
 *   つまみの時刻が来ていない時だけ、記録の値をそのまま返す。
 * ⚠ 0 で埋めない。到着か納期が無ければ null(Number(null)===0 の罠)。
 *
 * @param {object} input { arrivalMs, dueLineMs, snapRatio, nowMs }
 * @returns {number|null} 到着=0 / 納期線=1 の生の値（負も1超もそのまま返す）
 */
// eslint-disable-next-line react-refresh/only-export-components -- 部品ではなく数を出す関数。Side.jsx も同じ物を呼ぶ(2本目を作らない)
export function posRatioAt(input) {
  const o = input || {};
  const arrivalMs = isNum(o.arrivalMs) ? o.arrivalMs : null;
  const dueLineMs = isNum(o.dueLineMs) ? o.dueLineMs : null;
  const nowMs = isNum(o.nowMs) ? o.nowMs : null;
  if (nowMs != null && arrivalMs != null && dueLineMs != null) {
    const span = dueLineMs - arrivalMs;
    return span > 0 ? (nowMs - arrivalMs) / span : null;
  }
  return isNum(o.snapRatio) ? o.snapRatio : null;
}

/* ---------------------------------------------------------------------------
 * 4-b. 1件ぶんの「カードに出る事」を作る（🚨 ここ ただ1本）
 * ---------------------------------------------------------------------------
 * 🚨 2026-08-30 清水さん「カードには品目コード・納期・残り時間・担当状態だけ」。
 *   カードから外した物（テンプレ名・台数・進み具合・状態の言い方・担当が付いていない理由）は
 *   **1つも消していない**。押した時に右から出る引き出し（SelectedCardFacts）へ丸ごと移した。
 * 🚨 盤と引き出しが **別々の式** で同じ事を作ると、必ず片方だけ直して食い違う
 *   （2026-08-21「片方だけ直すな」）。だから1件ぶんの事実は この関数ただ1本 で作り、
 *   盤（layout）も引き出し（SelectedCardFacts）も ここだけ を読む。
 * ⚠ ここは計算だけ。色（tone）とレーンは呼ぶ側が付ける
 *   （色は名簿の並びで決まる物で、1件の中だけでは決められない）。
 *
 * @param {object} lot         snapshot.lots の1件
 * @param {number} atMs        いまの時刻（つまみの時刻。無ければ記録の時刻）
 * @param {number} nowMs       つまみの時刻そのもの。あれば横位置を同じ式で出し直す
 * @param {object} verdict     result.base.lotResults の1件（この先の見込み）
 * @param {Array}  snapWorkers snapshot.workers（担当が付いていない理由に要る）
 * @param {number} busyMs      いまこの仕事に当たっている人の残り時間
 */
function lotFactsOf(lot, {
  atMs = null,
  nowMs = null,
  verdict = null,
  snapWorkers = [],
  busyMs = null,
} = {}) {
  // 🚨 位置は「到着→納期線のどこまで来たか」。記録の値をそのまま使うと
  //   0.3日ごとにしか動かないので、つまみの時刻が来ていれば同じ式で出し直す。
  //   🚨 式は posRatioAt(4-a-2章)ただ1本。ここで2本目を書かない
  //     (右の根拠 Side.jsx も同じ関数を呼ぶので、上と下で数字が食い違わない)。
  const raw = posRatioAt({
    arrivalMs: lot.arrivalMs,
    dueLineMs: lot.dueLineMs,
    snapRatio: lot.duePosRatio,
    nowMs,
  });
  const ratio = raw == null ? null : clamp01(raw);
  const notArrived = atMs != null && isNum(lot.arrivalMs) && lot.arrivalMs > atMs;
  // 🚨 **位置** の話と **見込み** の話を混ぜない。
  //   raw>1 = いま納期線の右へ抜けている（位置の事実）。
  //   lot.late = この先で間に合わない見込み（エンジンの判定）。位置は動く。
  //   混ぜると、まだ線の手前に居る札まで『張り付き』扱いになり、盤から動く札が消える。
  //   🚨 越えたかどうかは2つの入口で見る。
  //   ① raw>1 … 到着→納期の道のりを走り切った。
  //   ② dueLineMs が いまの時刻より前 … 納期線そのものを過ぎている。
  //   ⚠ 実測(opsim-sample.json snapshotSample 179件をこの式で数えた):
  //      ①=64件 ／ ②=76件 で、①は②に丸ごと含まれる（①だけに当たる物は0件）。
  //      差の12件は「納期が到着より前」で duePosRatio が出せず null になる物。
  //      これを『まだ越えていない』に入れると、盤の左端へ張り付いて
  //      時間を進めても一生動かない札になる（②が落ちる原因そのもの）。
  //   🚨 条件は lateForecast.js の isPastDueAt ただ1本（右の棚の「遅れて終わる見込み」と同じ向き）。
  const pastDue = isPastDueAt(lot.dueLineMs, atMs);
  const breached = (raw != null && raw > 1) || pastDue;
  // 決まり15（2026-09-04 清水さん「納期遅れたらずっと右側で表示残して、どれだけ遅れているかとか」）:
  //   納期を過ぎた物は「+N日」の数字1つを持つ。🚨 式は lateDone.js の lateDays ただ1本
  //   （lateForecast.js の daysPastDueLine がそれを呼ぶ。盤で2本目を書かない）。
  //   納期線(dueLineMs)は納期の日の中の時刻(17:00 等)なので、その日の終わりに直してから数える
  //   （遅れて完了の棚と同じ数え方＝同じロットが完了した時に数字が変わらない）。
  //   当日のうちに線を過ぎた物は null（0日）＝「今日」と書く。
  const daysLate = pastDue ? daysPastDueLine(atMs, lot.dueLineMs) : null;
  // 🚨 2026-08-24 是正: ここは `lot.late` を読んでいた。
  //   simulate.js:1027 の lot.late は `atMs > dueLineMs` ＝ **今日の事実** で、
  //   すぐ上の pastDue と同じ条件。breached が先に返るので（statusOf の1行目）、
  //   「遅れます」の札は **一度も出ていなかった**（実コードで確認済み）。
  //   この先の見込みは result.base.lotResults にしか無いので、そこから受け取る。
  // ⚠ verdict が渡っていない時は false。ここで lot.late に戻さない
  //   （戻すと「突破」と同じ物を「遅れます」と呼ぶ状態へ逆戻りする）。
  const willBeLate = !!(verdict && verdict.late === true && verdict.alreadyPastDue !== true);

  const names = Array.from(new Set((Array.isArray(lot.workers) ? lot.workers : []).filter(Boolean)));
  const hasWorker = names.length > 0;
  const workerText = hasWorker
    ? `${names[0]}${names.length > 1 ? ` 他${names.length - 1}` : ''}${isNum(busyMs) ? ` あと${fmtDur(busyMs)}` : ''}`
    : '';

  return {
    raw,
    ratio,
    notArrived,
    pastDue,
    breached,
    daysLate,
    hasWorker,
    names,
    workerText,
    needsSomeone: !hasWorker && !notArrived,
    reason: hasWorker ? '' : noOneReason(lot, snapWorkers),
    // 🚨 breached(いまの位置) と willBeLate(この先の見込み) を **混ぜない**。
    //   以前は `breached || willBeLate` を breached として渡していたので、
    //   納期線の手前に居るカードにも「突破」が付いていた。
    willBeLate,
    status: statusOf({ breached, notArrived, ratio, hasWorker, willBeLate }),
    barPct: isNum(lot.doneRatio) ? Math.round(clamp01(lot.doneRatio) * 1000) / 10 : 0,
  };
}

/* ===========================================================================
 * 5. 段組み（カードを重ねずに置く）
 * ---------------------------------------------------------------------------
 * 置く順は「大事な物から」。大事な物ほど確実に盤へ乗る。
 * 置ける段が無かった物は数えるだけにして、柱に「+N」と出す（黙って消さない）。
 * ========================================================================= */
// 🚨 2026-08-23 weightOf は消した。
//   盤へ出す順を「担当が付いているか」「納期線までの距離」で決めていたが、
//   どちらも時刻で変わるので、時間を進めるたびに盤の顔ぶれが入れ替わり、
//   人には『動いた』ではなく『差し替わった』としか見えなかった（実測: 8回進めて動いた0件）。
//   いまは packLane の中で **納期線が早い順 → lotId 順** に固定している。

function packLane(cards, rows, cardW, laneRight = Infinity, D = D1) {
  const placed = [];
  const rowBoxes = [];
  for (let i = 0; i < rows; i += 1) rowBoxes.push([]);
  let overflow = 0;

  // 🚨 2026-08-23 実測: +0.3日 を8回押すと 盤のカードが 8件→10件 に入れ替わり、
  //   **両方に居るカードが1件しか無く、位置が動いたカードは0件** だった。
  //   原因はここ。weightOf は「担当が付いているか」「納期線までの距離」を見ているので、
  //   時刻が進むと順位が入れ替わり、盤に残る顔ぶれが毎回変わる。
  //   カードが**差し替わる**と、人は「動いた」と認識できない(指示書10章②⑥)。
  //   → **どれを盤に出すかは、時刻で変わらない順で決める。**
  //   納期線が早い順 → 同じなら lotId 順。これなら時間を進めても顔ぶれが変わらず、
  //   位置だけが動く。届いた/越えた で出入りするのは focus の絞り込み側の仕事。
  const stableKey = (c) => {
    const d = c && c.lot && Number.isFinite(Number(c.lot.dueLineMs)) ? Number(c.lot.dueLineMs) : Infinity;
    return d;
  };
  const order = cards.slice().sort((a, b) => (stableKey(a) - stableKey(b))
    || String(a.lot && a.lot.lotId).localeCompare(String(b.lot && b.lot.lotId)));
  for (const c of order) {
    const left = c.left;
    const right = left + cardW;
    let put = -1;
    for (let r = 0; r < rows; r += 1) {
      let ok = true;
      for (const b of rowBoxes[r]) {
        if (left < b.right + D.GAP_X && right + D.GAP_X > b.left) { ok = false; break; }
      }
      if (ok) { put = r; break; }
    }
    if (put < 0) { overflow += 1; continue; }
    rowBoxes[put].push({ left, right });
    placed.push({ ...c, row: put });
  }

  // 同じ段の「左どなり」「右どなり」の空きを出す。担当者の札と線を出す余地の判定に使う。
  // 🚨 2026-08-24 是正: 前は左だけを見ていた。カードは左端に固まるので左に空きが無く、
  //   担当者の札が **実質1枚も出ていなかった**（実測: 盤に19枚出ていて札は0枚）。
  //   清水さんの要望は「作業者が **右側で** 左側の品目コードカードをつついている」なので、
  //   右どなりの空きも測って、札は右へ出す。
  for (const r of rowBoxes) r.sort((a, b) => a.left - b.left);
  for (const p of placed) {
    let edge = D.LANE_GUTTER;   // 一番左のカードの左どなりは、レーン名の柱
    for (const b of rowBoxes[p.row]) {
      if (b.right <= p.left && b.right > edge) edge = b.right;
    }
    p.freeLeft = p.left - edge;
    const pRight = p.left + cardW;
    let rEdge = laneRight;    // 一番右のカードの右どなりは、盤の右端（納期ゲートの手前）
    for (const b of rowBoxes[p.row]) {
      if (b.left >= pRight && b.left < rEdge) rEdge = b.left;
    }
    p.freeRight = rEdge - pRight;
  }
  return { placed, overflow };
}

/** 担当者の丸バッジの幅。**バッジと線で必ず同じ値**を使う（別々に計算すると線がずれる）。
 *  🚨 幅も倍率 k で作り直す。ここだけ標準のままにすると、大きくした札の中で名前が折れる。 */
function badgeWidthOf(name, D = D1) {
  const n = typeof name === 'string' ? name.length : 0;
  return Math.min(D.BADGE_W_MAX, Math.max(D.BADGE_W_MIN, D.BADGE_W_BASE + n * D.BADGE_W_PER_CHAR));
}
/** バッジと線を出すのに要る、カードのとなりの空き幅。 */
const badgeNeed = (badgeW, D = D1) => badgeW + D.BADGE_NEED_GAP;

/**
 * 担当者の札を置く場所。**右を先に試す**（清水さん「作業者が右側で左側のカードをつつく」）。
 * 🚨 前は左だけを見ていたので、カードが左端に固まる本番では札が1枚も出なかった。
 * @returns null = どちらにも置けない（重ねて出すより、出さない方が読める）
 */
function badgeSpotOf(card, cardW, D = D1) {
  const w = badgeWidthOf(card.names[0], D);
  const need = badgeNeed(w, D);
  const gap = D.GAP_X;   // 札とカードの間。段組みの隙間と同じ値＝倍率でいっしょに動く
  const right = card.left + cardW;
  if ((card.freeRight ?? 0) >= need) {
    return { side: 'right', left: Math.round(right + gap), beamLeft: right, beamW: gap, w };
  }
  if ((card.freeLeft ?? 0) >= need) {
    const l = Math.round(card.left - gap - w);
    return { side: 'left', left: l, beamLeft: l + w, beamW: card.left - (l + w), w };
  }
  return null;
}

/** 段数を、混んでいるレーンへ多く配る（1レーン最低1段）。 */
function shareRows(counts, totalRows) {
  const rows = counts.map(() => 1);
  let left = totalRows - counts.length;
  while (left > 0) {
    let best = 0;
    let bestLoad = -1;
    for (let i = 0; i < counts.length; i += 1) {
      const load = counts[i] / rows[i];
      if (load > bestLoad) { bestLoad = load; best = i; }
    }
    rows[best] += 1;
    left -= 1;
  }
  return rows;
}

/* ===========================================================================
 * 6. 画面の部品
 * ---------------------------------------------------------------------------
 * 🚨 描画関数の中でコンポーネントを定義しない（毎回作り直されて状態が飛ぶ）。
 *    だからここ（モジュールの一番外）に置く。
 * ========================================================================= */

function GuardLine({ leftPct, top, height, tone, label }) {
  const tones = {
    min: { border: 'border-emerald-300', text: 'text-emerald-700', bg: 'bg-emerald-50/90 border-emerald-200' },
    caution: { border: 'border-amber-300', text: 'text-amber-700', bg: 'bg-amber-50/90 border-amber-200' },
    due: { border: 'border-rose-300', text: 'text-rose-600', bg: 'bg-rose-50/90 border-rose-200' },
  };
  const t = tones[tone] || tones.min;
  return (
    <>
      <div
        className={`absolute border-l border-dashed ${t.border} pointer-events-none`}
        style={{ left: `${leftPct}%`, top, height }}
        aria-hidden="true"
      />
      <div
        className={`absolute rounded border px-0.5 py-1 text-2xs font-bold leading-none ${t.bg} ${t.text} pointer-events-none`}
        style={{ left: `${leftPct}%`, top: 6, writingMode: 'vertical-rl' }}
      >
        {label}
      </div>
    </>
  );
}

/**
 * レーンの帯。kind='model'（品目コードごと・いままで通り）／ kind='worker'（作業者ごと。決まり15-1・2026-09-04）。
 * 作業者の帯は **その人の色** で塗り、一番下の行(LANE_FOOTER)に「つぎは何を」か「手が空いている理由」を書く
 * （2026-08-24 からあった盤の上の「作業者の帯(WorkerRail)」の中身を、ここへ移した。1つも消していない:
 *   名前→レーン名 ／ いま何を・あと何分→その帯に居る札そのもの ／ つぎ→この下の行 ／ 手が空いている理由→この下の行）。
 */
function LaneBand({ top, height, label, tplLabel = '', hidden, D = D1, kind = 'model', tone = null, working = false, note = '' }) {
  // 決まり12: 縦書きのレーン名も 品目コード｜テンプレ。
  const laneText = tplLabel ? `${label}｜${tplLabel}` : label;
  const isWorker = kind === 'worker';
  const t = tone || NEUTRAL_TONE;
  const bandCls = isWorker
    ? (working ? `border-y ${t.border} ${t.bg}` : 'border-y border-slate-300 bg-slate-50')
    : 'border-y border-slate-200 bg-white/60';
  const labelCls = isWorker ? (working ? t.text : 'text-slate-500') : 'text-slate-500';
  return (
    <>
      <div
        className={`absolute left-0 right-0 pointer-events-none ${bandCls}`}
        style={{ top, height }}
        aria-hidden="true"
        data-lane-kind={kind}
        data-lane-name={label}
      />
      {/* レーン名（品目コード）。柱が32pxしか無いので横書きでは入らない＝縦に倒して置く。
          🚨 2026-08-30 直し: 「縦書きの品目コード名が読めない」への手当て。
            ① `text-orientation: sideways` を付ける。既定(mixed)だと英数字が
               1字ずつ立って積まれ、"RTH-425,AA" が縦1列のバラバラな字に見える。
               sideways なら **語ごと90度倒れる**ので、本の背表紙と同じ読み方になる。
            ② 入り切らない時は `truncate` で「…」を出す。前は overflow-hidden で
               黙って切れていたので、切れている事すら分からなかった。
            ③ title を付けて、指を乗せれば全部読める様にする。
          ⚠ 半透明の板(位置が出せない札の置き場)がこの柱へ被らない事。
            被ると品目コード名が白く沈む。置き場は LANE_GUTTER から右にしてある。 */}
      {/* 🚨 2026-09-15(写しの実測): 作業者のレーンは、手が空いている人だと帯が bg-slate-50(ほぼ白)・
          名前は縦書きの文字・理由も文字なので、notext では **帯が丸ごと消えて** いた。
          柱に丸を1つ置く。名前は下の縦書きがそのまま持つので **1文字も消していない**。
          🚨 色は呼ぶ側が workerColors.js で決めた tone をそのまま。ここで名前から色を作らない。
          🚨 手が空いている人は 点線の輪(＝この時間は動いていない)。色だけで見分けさせない為に形を変える。
             橙(空き)は使わない — 理由の語(w.reason)は自由な文字列で、
             スキル待ちかどうかを画面で判定し直す事になる(＝新しい判定を書かない)。 */}
      {isWorker ? (
        <div className="pointer-events-none absolute z-[3]" style={{ left: 6, top: top + 4 }}>
          {working
            ? <Avatar name={label} tone={t} size="w-5 h-5" showName={false} />
            : <Signal level="unknown" size="w-5 h-5" title={`${label}：${note || '手が空いている理由が取れていません'}`} />}
        </div>
      ) : null}
      <div
        className={`absolute overflow-hidden whitespace-nowrap ${D.text.lane} font-bold leading-none ${labelCls} pointer-events-none`}
        style={{
          left: 8, top: top + 8, maxHeight: Math.max(22, height - D.LANE_FOOTER - 10),
          writingMode: 'vertical-rl', textOrientation: 'sideways', letterSpacing: '0.06em',
          textOverflow: 'ellipsis',
        }}
        title={laneText}
      >
        {laneText}
      </div>
      {/* 作業者の帯の一番下の行: 働いている人は「つぎ ◯◯」、手が空いている人は **理由**（決まり14-3）。
          🚨 理由の書いていない待機を出さない（理由が取れない事自体を書く）。
          ⚠ 帯の下端の行(LANE_FOOTER)は必ず空けてある場所なので札と重ならない。 */}
      {isWorker && note ? (
        <div
          className={`absolute z-[2] truncate ${D.text.lane} leading-tight ${working ? 'text-slate-600' : 'font-bold text-amber-800'} pointer-events-none`}
          style={{ left: D.LANE_GUTTER + 4, right: D.GATE_W + D.GATE_R + 8, top: top + height - D.LANE_FOOTER + 1 }}
          title={note}
          data-lane-note={label}
        >
          {note}
        </div>
      ) : null}
      {/* 🚨 出し切れなかった分は必ず数で言う。黙って間引いたように見せない。
          場所はレーンの一番下に必ず空けてある帯（カードと重ならない）。
          ⚠ この注記は `cond && (` の**前**に置く事。直後に置くと構文エラー＝白画面。 */}
      {hidden > 0 && (
        <div
          className={`absolute z-[2] whitespace-nowrap rounded border border-slate-300 bg-white px-1 ${D.text.lane} font-bold leading-tight text-slate-500`}
          style={isWorker
            ? { right: D.GATE_W + D.GATE_R + 8, top: top + height - D.LANE_FOOTER + 1 }
            : { left: D.LANE_GUTTER + 4, top: top + height - D.LANE_FOOTER + 1 }}
          title="盤の高さが足りないので出していません（片付いたのではありません）。盤を高くすると出ます。"
        >
          {`このレーンは あと ${hidden} 件（高さが足りず出していません）`}
        </div>
      )}
    </>
  );
}

/* ---------------------------------------------------------------------------
 * 盤の外の細い帯（左＝これから届く / 右＝予定日を過ぎた）
 * 🚨 盤に出していない物の置き場所。**必ず件数を頭に書く**。
 *    名前で出すのは先頭 STRIP_LIST_MAX 件だけで、残りは「ほか N件」と数で出す。
 * ------------------------------------------------------------------------- */
const STRIP_TONES = {
  wait: {
    box: 'border-slate-200 bg-white', head: 'text-slate-500',
    item: 'border-slate-200 bg-slate-50', main: 'text-slate-700', sub: 'text-slate-500',
  },
  over: {
    box: 'border-rose-200 bg-rose-50/60', head: 'text-rose-600',
    item: 'border-rose-200 bg-white', main: 'text-rose-700', sub: 'text-rose-500',
  },
  // 遅れて終わる見込み（決まり15・計算）。琥珀の札に赤い「+N日」。計算の上で終わった事は琥珀、遅れた事実は赤で残す。
  forecast: {
    // 🚨 決まり27(2026-09-05): 橙をやめて薄い赤(lateTone.js)。橙は空き(スキル待ち)専用。
    box: LATE_TONE.forecast.box, head: LATE_TONE.forecast.head,
    item: LATE_TONE.forecast.item, main: LATE_TONE.forecast.main, sub: LATE_TONE.forecast.sub,
  },
  // 遅れて完了（決まり10）。灰色の札に赤い「+N日」。片付いた事は灰、遅れた事実は赤で残す。
  done: {
    box: 'border-slate-300 bg-slate-100', head: 'text-slate-600',
    item: 'border-slate-300 bg-slate-50', main: 'text-slate-600', sub: 'text-slate-500',
  },
};

function SideStrip({ height, tone, title, count, items, emptyText, D = D1, note = '', dataName = '' }) {
  const t = STRIP_TONES[tone] || STRIP_TONES.wait;
  const rest = Math.max(0, count - items.length);
  return (
    <div
      className={`shrink-0 overflow-y-auto overflow-x-hidden rounded-xl border ${t.box}`}
      style={{ width: D.STRIP_W, height }}
      data-strip={dataName || undefined}
    >
      <div className="border-b border-slate-200 px-1.5 py-1.5">
        <div className={`${D.text.lane} font-bold leading-none ${t.head}`}>{title}</div>
        <div className={`mt-1 flex items-center gap-1 ${D.text.lane} font-black leading-none text-slate-700`}>
          <span className="tabular-nums">{`${count}件`}</span>
          {/* 🚨 2026-09-15: 「53件」が notext で消え、棚が白い箱にしか見えなかった。
              点の数＝いま見出しが出している件数そのもの(数え直していない)。多い時は「＋」1つで打ち切る。 */}
          <Dots count={count} cap={10} tone="quiet" size="w-1.5 h-1.5" className="shrink-0" title={`${title} ${count}件`} />
        </div>
        {note ? <div className={`mt-1 ${D.text.lane} leading-tight text-slate-500`}>{note}</div> : null}
      </div>
      <div className="flex flex-col gap-1 p-1.5">
        {items.map((it) => (
          <div key={it.key} className={`rounded border px-1 py-1 ${t.item}`} title={it.title || ''} data-lot-id={it.key}>
            <div className={`truncate ${D.text.lane} font-bold leading-none ${t.main}`}>{it.main}</div>
            {/* 赤い大きめの札（+N日）。遅れの大きさは数字1つで答える（決まり6: 大きい字は答え）。 */}
            {it.badge ? <div className={`mt-1 ${D.text.model} font-black leading-none text-rose-600 tabular-nums`}>{it.badge}</div> : null}
            <div className={`mt-1 truncate ${D.text.lane} leading-none ${t.sub}`}>{it.sub}</div>
          </div>
        ))}
        {rest > 0 && (
          <div className="px-1 text-2xs leading-tight text-slate-500">
            {`ほか ${rest}件（名前は出していません）`}
          </div>
        )}
        {count === 0 && (
          <div className="px-1 text-2xs leading-tight text-slate-400">{emptyText}</div>
        )}
      </div>
    </div>
  );
}

/**
 * 盤の右の棚（決まり15・2026-09-04 清水さん「納期遅れたらずっと右側で表示残して、どれだけ遅れているかとか
 * どれだけ遅れて処理したかとか表示しないと」）。**1つの棚に3段・3つの数（1つに足さない）**:
 *   上段「納期を過ぎた」… まだ終わっていない物。赤い「+N日」（いまの時刻で数えた遅れ）。時間を進めると増える。
 *   中段「遅れて終わる見込み」… この計算で、いまの時刻までに納期を過ぎて終わった物。琥珀の札に赤い「+N日」（納期→終わり）。
 *       🚨 2026-09-04 確かめ役の実測: ＋2時間で RT-106,H(+30日) が上段から消え、どこにも無くなっていた。ここに残す。
 *       時間を進めると上段の物がここへ移るだけ＝上段＋中段は減らない（late-forecast.test.mjs）。
 *   下段「遅れて完了」… 記録(completedAt)で終わった物。灰の札に赤い「+N日」（納期→完了）。**終わっても消さない**（決まり10）。
 * 🚨 +N日 の式は3段とも lateDone.js の lateDays ただ1本（片方だけ直して食い違う事が起きない）。
 * 🚨 名前は **全部出す**（間引かない）。棚の中は縦に送れる。件数は必ず見出しに出す。
 * ⚠ 上段は以前 SideStrip(tone='over') で先頭4件だけ名前を出し、+N日 が無かった。下段は別の棚だった。
 */
function OverdueShelf({
  height, overdueCount, overdueItems, onBoardNote = '',
  forecastCount = 0, forecastItems = [], forecastNote = '',
  lateDone = null, lateDoneItems = [], D = D1,
}) {
  /* 🚨 2026-09-15: 3段で **同じ目盛り**(この棚の中で一番長い遅れが枠いっぱい)。長さを見比べられる。
     🚨 ここで作るのは「描く為の枠」だけで、この数は画面に1文字も出さない。
        遅れの日数を答えるのは いままで通り it.badge(＋N日)ただ1つ
        ＝「同じ数字を2つの計算から出さない」を破っていない。
     🚨 式は足していない。it.days は lateDone.js の lateDays ただ1本が出した値をそのまま運んだ物。 */
  const scaleDays = Math.max(1, ...[...overdueItems, ...forecastItems, ...lateDoneItems]
    .map((it) => (typeof it.days === 'number' && Number.isFinite(it.days) ? it.days : 0)));
  const rows = (items, tone, toneKey) => items.map((it) => (
    <div key={it.key} className={`rounded border px-1 py-1 ${tone.item}`} title={it.title || ''} data-lot-id={it.key}>
      <div className={`truncate ${D.text.lane} font-bold leading-none ${tone.main}`}>{it.main}</div>
      {/* 赤い大きめの札（+N日）。遅れの大きさは数字1つで答える（決まり6: 大きい字は答え）。
          🚨 2026-09-15: 写しの実測で +20日 と +1日 が **同じ大きさの白い箱** だった(文字を消すと差が消える)。
             数字はそのまま置いたまま、右に **長さ** を足す。 */}
      {it.badge ? (
        <div className="mt-1 flex items-center gap-1">
          <div className={`${D.text.model} shrink-0 font-black leading-none text-rose-600 tabular-nums`}>{it.badge}</div>
          <Bar value={it.days} max={scaleDays} tone={toneKey} height="h-1.5" className="min-w-0 flex-1"
            title={`この棚で一番長い遅れを枠いっぱいにした時の長さ（数は左の ${it.badge}）`} />
        </div>
      ) : null}
      <div className={`mt-1 truncate ${D.text.lane} leading-none ${tone.sub}`}>{it.sub}</div>
    </div>
  ));
  const over = STRIP_TONES.over;
  const fore = STRIP_TONES.forecast;
  const done = STRIP_TONES.done;
  return (
    <div
      className="flex shrink-0 flex-col overflow-y-auto overflow-x-hidden rounded-xl border border-rose-200 bg-white"
      style={{ width: D.STRIP_W, height }}
      data-strip="overdue-shelf"
    >
      <div data-strip="overdue">
        <div className="border-b border-rose-200 bg-rose-50/60 px-1.5 py-1.5">
          <div className={`${D.text.lane} font-bold leading-none text-rose-600`}>納期を過ぎた</div>
          <div className={`mt-1 ${D.text.lane} font-black leading-none text-slate-700`}>{`${overdueCount}件`}</div>
          <div className={`mt-1 ${D.text.lane} leading-tight text-slate-500`}>まだ終わっていない物。+N日＝いまの時刻での遅れ</div>
          {onBoardNote ? <div className={`mt-1 ${D.text.lane} leading-tight text-slate-500`}>{onBoardNote}</div> : null}
        </div>
        <div className="flex flex-col gap-1 p-1.5">
          {rows(overdueItems, over, 'late')}
          {overdueCount === 0 ? <div className="px-1 text-2xs leading-tight text-slate-400">納期を過ぎた物はありません。</div> : null}
        </div>
      </div>
      {/* ② 遅れて終わる見込み（計算）。決まり15: 時間を進めて終わっても、遅れた事実を棚から消さない。
          🚨 ①（まだ終わっていない）とも ③（記録）とも別の棚・別の数。1つに足さない。 */}
      <div data-strip="late-forecast" data-late-forecast-count={forecastCount} className="border-t-2 border-rose-300 bg-rose-50/40">
        <div className="border-b border-rose-200 bg-rose-50 px-1.5 py-1.5">
          <div className={`${D.text.lane} font-bold leading-none text-rose-700`}>遅れて終わる見込み</div>
          <div className={`mt-1 ${D.text.lane} font-black leading-none text-slate-700`}>{`${forecastCount}件`}</div>
          <div className={`mt-1 ${D.text.lane} leading-tight text-slate-500`}>この計算で、いまの時刻までに納期を過ぎて終わった物。+N日＝納期→終わりの遅れ</div>
          {forecastNote ? <div className={`mt-1 ${D.text.lane} leading-tight text-slate-500`}>{forecastNote}</div> : null}
        </div>
        <div className="flex flex-col gap-1 p-1.5">
          {rows(forecastItems, fore, 'lateSoon')}
          {forecastCount === 0 ? <div className="px-1 text-2xs leading-tight text-slate-400">いまの時刻までに、遅れて終わった見込みの物はありません。</div> : null}
        </div>
      </div>
      {lateDone && Array.isArray(lateDone.rows) ? (
        <div data-strip="late-done" className="border-t-2 border-slate-300 bg-slate-100">
          <div className="border-b border-slate-200 px-1.5 py-1.5">
            <div className={`${D.text.lane} font-bold leading-none text-slate-600`}>遅れて完了</div>
            <div className={`mt-1 ${D.text.lane} font-black leading-none text-slate-700`}>{`${lateDone.rows.length}件`}</div>
            {lateDone.windowText ? <div className={`mt-1 ${D.text.lane} leading-tight text-slate-500`}>{lateDone.windowText}</div> : null}
            <div className={`mt-1 ${D.text.lane} leading-tight text-slate-500`}>終わった物。+N日＝納期→完了の遅れ。消しません</div>
          </div>
          <div className="flex flex-col gap-1 p-1.5">
            {rows(lateDoneItems, done, 'quiet')}
            {lateDone.rows.length === 0 ? <div className="px-1 text-2xs leading-tight text-slate-400">この期間に、遅れて完了した物はありません。</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 盤の主役を切り替えるピル2つ。既定は「この期間で動く物」（期間の言い方は親から降りてくる）。 */
function FocusPills({ value, onChange, periodWord = 'この期間' }) {
  const base = 'pointer-events-auto rounded-full border px-2 py-1 text-2xs font-bold leading-none';
  const on = 'border-cyan-500 bg-cyan-50 text-cyan-700';
  const off = 'border-slate-300 bg-white text-slate-500';
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className={`${base} ${value === 'moving' ? on : off}`}
        onClick={() => onChange('moving')}
        title="担当が付いている物と、届いていて納期線を越えていない物だけを盤に出します。"
      >
        {periodWord}で動く物
      </button>
      <button
        type="button"
        className={`${base} ${value === 'all' ? on : off}`}
        onClick={() => onChange('all')}
        title="まだ届いていない物と予定日を過ぎた物も、まとめて盤に出します。"
      >
        全部
      </button>
    </div>
  );
}

/**
 * 大きさの切替（2026-09-01）。
 * 🚨 名前は「何が起きるか」で書く。押した時に何が起きるかは title に必ず入れる
 *   （旧「詰めて表示」「大画面」は 清水さん「意味が分からない」＝名前が分かりにくい だった）。
 * 🚨 押せる大きさを 36px 以上にする（現場は手袋で触る）。
 */
function ZoomPills({ value, onChange }) {
  const base = 'pointer-events-auto min-h-11 rounded-full border px-2.5 text-2xs font-bold leading-none';
  const on = 'border-cyan-500 bg-cyan-50 text-cyan-700';
  const off = 'border-slate-300 bg-white text-slate-500 hover:bg-slate-50';
  return (
    <div className="flex items-center gap-1" role="group" aria-label="盤の大きさ">
      <span className="pointer-events-none text-2xs font-bold leading-none text-slate-400">大きさ</span>
      {BOARD_ZOOM_STEPS.map((s) => (
        <button
          key={s.key}
          type="button"
          aria-pressed={value === s.key}
          className={`${base} ${value === s.key ? on : off}`}
          onClick={() => onChange(s.key)}
          title={`${s.hint}（札の高さ ${dimsOf(s.k).CARD_H}px）`}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 並べ替えの切替。🚨 段(tier)で分ける事を題名でも言う。
 *   段をまたいで足し引きしない＝『すでに過ぎた』と『この先で遅れる』を1つの数にしない。
 */
function SortPills({ value, onChange, highCount, frozen }) {
  const base = 'pointer-events-auto rounded-full border px-2 py-1 text-2xs font-bold leading-none';
  const on = 'border-cyan-500 bg-cyan-50 text-cyan-700';
  const off = 'border-slate-300 bg-white text-slate-500';
  return (
    <div className="flex items-center gap-1">
      <button type="button" className={`${base} ${value === 'due' ? on : off}`}
        onClick={() => onChange('due')}
        title="その品目コードの一番早い納期線が早い順。時刻を進めても行は動きません。">納期の早い順</button>
      <button type="button" className={`${base} ${value === 'risk' ? on : off}`}
        onClick={() => onChange('risk')}
        title="急ぎ → すでに予定日を過ぎた → この先で遅れる → 判定できません → それ以外。段ごとに分けて並べます。">納期がやばい順</button>
      {value === 'risk' && highCount != null ? (
        <span className="pointer-events-none rounded-full border border-slate-300 bg-white px-2 py-1 text-2xs font-bold leading-none text-slate-500">
          {highCount > 0 ? `急ぎ ${highCount}件` : '急ぎ 0件（まだ1件も付いていません）'}
        </span>
      ) : null}
      {frozen ? (
        <span className="pointer-events-none rounded-full border border-violet-300 bg-violet-50 px-2 py-1 text-2xs font-bold leading-none text-violet-700"
          title="再生を始めた時の並びで止めています。カードが動いたのか行が動いたのかを分けて見る為です。「最初へ戻す」で並び直します。">
          並びを止めています
        </span>
      ) : null}
    </div>
  );
}

/**
 * 担当者の札。カードの左どなりに置いて、右どなりのカードを「つつく」形にする
 * （2026-08-24 清水さん「作業者が品目コードカードをつついてるような動きで名前付きで」）。
 * 🚨 名前は略さない。以前は max-w-[86px] truncate で、長い名前が「尾…」になっていた。
 * 🚨 色は workerColors.js が **名簿の並び** から決めた物ただ1つ。ここで色を作らない
 *    （作ると右の作業者一覧と食い違う）。
 * ⚠ 高さは BADGE_H 固定。可変にすると上下の段のカードにかぶる。
 */
function FighterBadge({ left, top, name, extra, tone, side = 'right', D = D1 }) {
  const t = tone || NEUTRAL_TONE;
  // 🚨 つつく向きは、札がカードのどちら側に居るかで決まる。
  //   右に居るなら **左へ** つつく（カードは左に在る）。逆だと離れていく動きになる。
  const poke = side === 'right' ? 'opsim-poke-left' : 'opsim-poke-right';
  return (
    <div
      className={`opsim-move ${poke} absolute z-20 flex items-center gap-1 rounded-lg border ${t.border} ${t.bg} px-1.5 shadow-sm`}
      style={{ left, top, height: D.BADGE_H }}
      title={extra > 0
        ? `${name} さん ほか ${extra}人が、この仕事に当たっています`
        : `${name} さんが、この仕事に当たっています`}
    >
      <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${t.dot}`} aria-hidden="true" />
      <span className={`whitespace-nowrap ${D.text.lane} font-black leading-none ${t.text}`}>
        {extra > 0 ? `${name} 他${extra}` : name}
      </span>
    </div>
  );
}

/** 札 → カード をつなぐ線。🚨 色は札と同じ物（別々に決めると線だけ違う色になる）。 */
function EngagementBeam({ left, top, width, tone }) {
  const t = tone || NEUTRAL_TONE;
  return (
    <div
      className={`opsim-move absolute z-10 rounded-full bg-gradient-to-r ${t.beam}`}
      style={{ left, top, width, height: 2 }}
      aria-hidden="true"
    />
  );
}

/**
 * 作業者の帯（盤の一番上）。「終わったら次はこの品目コードをやる予定」をここに書く
 * （2026-08-24 清水さん）。
 *
 * 🚨 なぜカードの横ではなくここか:
 *   カードの横に札を出せるのは「左どなりに 80px 以上空いている時」だけ（badgeNeed）。
 *   位置が出せない札は道の手前に置かれるので、左に空きが作れない。
 *   人は数人なので、人ごとの話は上に並べれば必ず読める。
 * 🚨 assignments が渡っていない時、「つぎ」の行は **1文字も書かない**。
 *   「予定なし」と書くと、測っていないのに測ったように見える。
 * 🚨 理由の書いていない待機を出さない。理由が取れない事自体を書く。
 */
/*
 * 🚨 2026-09-04 決まり15-1: WorkerRail（盤の一番上の作業者の帯・48px）はここから **作業者ごとのレーン** へ移した。
 *   清水さん「作業者処理してるやつは見やすくするために上に来る」。帯は「人の話」を上に1行で並べていたが、
 *   その人が持っている札は下の品目コードのレーンに散っていて、どこで何をしているかが読めなかった。
 *   いまは盤の先頭に作業者ごとのレーンを固定し、その人の札をその帯に置く。帯の中身の行き先:
 *     名前 → レーン名（縦書き・その人の色） ／ いま何を・あと何分 → 帯に居る札そのもの（「尾田 あと4分」）
 *     つぎ ◯◯ → 帯の一番下の行 ／ 手が空いている理由 → 帯の一番下の行（決まり14-3）
 *   文言を作る所は railItems（下）のまま。1つも消していない。
 */

/* 🚨 2026-08-30 撤去: NoOneRibbon（カード1枚ずつに赤い小札で「人が決まっていません」）。
 *   清水さん「『分かりません』『人が決まっていません』の繰り返しを減らす」。
 *   あの小札は **盤に出ているカードのうち担当が付いていない物の枚数ぶん、そのまま出ていた**
 *   （間引きも上限も無かった）。夜に開くと誰も working ではないので、
 *   盤のカードが丸ごと赤い札で埋まる＝同じ一言が何十回も並ぶ状態だった。
 *   言葉は消していない。行き先は2つ:
 *     ① カードの担当の行 … 「○ 担当 未定」（印だけ。1枚に1回）
 *     ② 凡例（画面に1回だけ）と、押した時の引き出し（理由つきで丸ごと）
 */

function ForecastPath({ left, top, width, label, labelLeft }) {
  return (
    <>
      <div
        className="opsim-move absolute z-[5] border-t border-dashed border-slate-400"
        style={{ left, top, width }}
        aria-hidden="true"
      />
      <div
        className="opsim-move absolute z-[16] h-1.5 w-1.5 rounded-full bg-slate-400"
        style={{ left: left + width - 3, top: top - 3 }}
        aria-hidden="true"
      />
      <div
        className="opsim-move absolute z-[16] whitespace-nowrap rounded border border-slate-300 bg-white px-1 py-0.5 text-2xs font-bold leading-none text-slate-600 shadow-sm"
        style={{ left: labelLeft, top: top - 8 }}
      >
        {label}
      </div>
    </>
  );
}

/**
 * カードに出す **短い印**（状態札の代わり）。
 *
 * 🚨 2026-08-30 清水さん「カードには品目コード・納期・残り時間・担当状態だけ」
 *    「『分かりません』『人が決まっていません』の繰り返しを減らす」。
 *    印にするのは次の2種類だけで、**言葉は1つも消していない**
 *    （全部そのまま引き出しの「カードに出ていた事」に出る）:
 *      ① 同じカードの他の行と同じ事を言っている札
 *         迎撃中   … すぐ下の担当の行が名前を出している
 *         順番待ち … すぐ下の担当の行が「○ 担当 未定」を出している
 *      ② 長い言い方
 *         分かりません … カードでは「?」の1文字。意味は凡例と引き出しで1回だけ言う
 * @returns {{text:string, cls:string, title:string}|null} null なら印を出さない
 */
function cardMarkOf(status, daysLate = null) {
  if (!status) return null;
  switch (status.label) {
    case '突破':
      // 決まり15: 越えた札には「どれだけ過ぎたか」を数字で添える（式は lateDays ただ1本）。
      return {
        text: daysLate != null && daysLate >= 1 ? `突破 +${daysLate}日` : '突破',
        cls: status.cls,
        title: daysLate != null && daysLate >= 1
          ? `納期を ${daysLate}日 過ぎています（今の位置の事実）。`
          : 'いま納期線より先に居ます（今の位置の事実）。',
      };
    case '遅れます':
      return { text: '遅れます', cls: status.cls, title: 'この見立てでは納期に間に合いません（この先の見込み）。' };
    case 'これから':
      return { text: 'これから', cls: status.cls, title: 'まだ届いていません。' };
    case '分かりません':
      return { text: '?', cls: status.cls, title: '到着日か納期が入っていないので、盤の位置が出せません。カードを押すと、入っている値が出ます。' };
    default:
      // 迎撃中 / 順番待ち は、すぐ下の担当の行と同じ事なのでカードには出さない。
      return null;
  }
}

/**
 * 盤のカード。**出す物は4つだけ**（品目コード・納期・残り時間・担当状態）。
 * 🚨 2026-08-30 ここから外した物（テンプレ名・台数・進み%・進みバー・状態の言い方・
 *   担当が付いていない理由）は **1件も消していない**。押した時に右から出る引き出しへ移した。
 *   対応は SelectedCardFacts（この下）が受け持つ。
 * ⚠ 文字は 2xs(11px) から xs(12px) / sm(14px) へ上げた（清水さん「小さい文字を整理」）。
 *   行が5つ→3つになったぶんの余りをそのまま文字に回している。CARD_H は変えていない
 *   （変えると盤の段組みが丸ごと組み直しになる）。
 */
function LotCard({ card, cardW, selected, onSelect, D = D1 }) {
  const { lot, left, top, status, breached, hasWorker, workerText, tone } = card;
  const border = breached
    ? 'border-rose-400 bg-rose-50'
    : (selected ? 'border-cyan-500 bg-white'
      : (hasWorker ? 'border-cyan-300 bg-white'
        : (card.needsSomeone ? 'border-rose-200 bg-white' : 'border-slate-200 bg-white')));
  const mark = cardMarkOf(status, card.daysLate);
  /* 🚨 2026-09-15(清水さん「文字ばっかり」): カードの印「突破」「遅れます」「これから」「?」は
     notext の写しで **全部消えて白い箱** になっていた。字は1文字も消さずに **形** を隣へ足す。
     🚨 色だけで見分けさせない(workerColors.js の決まり)。だから4つとも形が違う:
        突破=赤い丸に縦棒 / 遅れます=赤い旗(納期) / これから=箱(ロット) / 分かりません=灰の点線の輪。
     🚨 橙は空き(スキル待ち)専用なので、遅れの印には1つも使っていない。
     🚨 ここで判定していない。cardMarkOf(＝statusOf ただ1本)が返した印を形へ写すだけ。 */
  const markArt = !mark ? null
    : (mark.text === '?' ? <Signal level="unknown" size="w-3 h-3" title={mark.title} />
      : /^突破/.test(mark.text) ? <Signal level="danger" size="w-3 h-3" title={mark.title} />
        : mark.text === '遅れます' ? <Glyph kind="due" className="w-3 h-3" title={mark.title} />
          : <Glyph kind="lot" className="w-3 h-3" title={mark.title} />);
  const dueKnown = isNum(lot.dueLineMs);
  const dot = (tone || NEUTRAL_TONE);
  return (
    <button
      type="button"
      onClick={() => onSelect(lot.lotId)}
      data-lot-id={lot.lotId}
      title={`${lot.model || '品目コードなし'}｜${card.tplName || 'テンプレ名なし'}｜${lot.quantity || 1}台（押すと、この仕事の詳しい話が出ます）`}
      className={`opsim-move ${breached ? 'opsim-breach' : ''} absolute z-[15] flex flex-col justify-between overflow-hidden rounded-xl border px-2 py-1.5 text-left shadow-sm hover:shadow-md ${border} ${selected ? 'ring-2 ring-cyan-500' : ''}`}
      style={{ left, top, width: cardW, height: D.CARD_H }}
    >
      {/* ① 品目コード（＋短い印）。「仮」＝仮の入荷日で計算されている印（2026-08-31 清水さん
          「仮日をとりあえず入れて後から本当のやつ入れるってことだから、そこはわかりやすくして」）。
          小さくてよいが必ず見える事。意味は上の⚠の帯が1回だけ言う。 */}
      <div className="flex items-center justify-between gap-1">
        {/* 決まり12（2026-09-02 清水さん「品目コードだけ記載されてても意味ない」）: 品目コード｜テンプレ を1行に並べる。
            🚨 2026-08-30 に「テンプレ名は引き出しへ」と外していたが、テンプレで作業内容が変わるので札に戻した。 */}
        <span className="flex min-w-0 items-baseline gap-1">
          <span className={`shrink-0 ${D.text.model} font-black leading-none text-slate-800`}>{lot.model || '品目コードなし'}</span>
          <span className={`min-w-0 truncate ${D.text.meta} font-bold leading-none text-slate-500`}>{`｜${card.tplName || 'テンプレ名なし'}`}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {card.assumed ? (
            <span
              data-assumed-kind={card.assumedKind || 'unknown'}
              title={card.assumedKind === 'clampedToNow'
                ? '入荷日が無いので納期より前に置こうとしましたが、その日はもう過ぎているので、計算の基準時刻に置いています。納期が来ているのに入荷の登録がありません。'
                : (card.assumedKind === 'beforeDue'
                  ? '入荷日が無いので、納期より前に仮に置いて計算しています。本当の入荷日を入力すると、そちらで計算し直します。'
                  : '入荷日が無いので仮に置いて計算しています（どちらの置き方かは計算から返ってきていません）。')}
              className={`rounded border px-1 py-0.5 ${D.text.mark} font-bold leading-none ${
                card.assumedKind === 'clampedToNow'
                  ? 'border-red-500 bg-red-50 text-red-800'
                  : 'border-amber-400 bg-amber-50 text-amber-800'}`}
            >
              {card.assumedKind === 'clampedToNow' ? '仮(過ぎ)' : '仮'}
            </span>
          ) : null}
          {mark ? (
            <span
              title={mark.title}
              className={`inline-flex items-center gap-0.5 rounded border px-1 py-0.5 ${D.text.mark} font-bold leading-none ${mark.cls}`}
            >
              {markArt}
              {mark.text}
            </span>
          ) : null}
        </span>
      </div>

      {/* ② 残り時間 ／ ③ 納期 */}
      <div className={`flex items-center justify-between gap-1 ${D.text.meta} leading-none text-slate-600`}>
        <span className="truncate">{remainText(lot)}</span>
        <span
          className={`shrink-0 ${breached ? 'font-bold text-rose-600' : ''}`}
          title={dueKnown ? undefined : '納期が入っていません。カードを押すと、入っている値が出ます。'}
        >
          {dueKnown ? dueText(lot, card.originMs) : '納期 ?'}
        </span>
      </div>

      {/* ④ 担当状態。理由の1語は引き出しへ（同じ言葉を盤に何十回も並べない） */}
      <div className={`flex items-center gap-1 ${D.text.meta} leading-none`}>
        {hasWorker ? (
          <>
            <span className={`h-2 w-2 shrink-0 rounded-full ${dot.dot}`} aria-hidden="true" />
            <span className="truncate font-bold text-cyan-700">{workerText}</span>
          </>
        ) : card.needsSomeone ? (
          <>
            <span className="h-2 w-2 shrink-0 rounded-full border border-rose-400 bg-white" aria-hidden="true" />
            <span
              className="truncate font-bold text-rose-600"
              title="人が決まっていません。理由（順番待ち／全員作業中／時間未登録）は、カードを押すと出ます。"
            >
              担当 未定
            </span>
          </>
        ) : (
          <span className="truncate font-bold text-slate-500">到着前</span>
        )}
      </div>
    </button>
  );
}

/* ===========================================================================
 * 6-b. 引き出しに出す「カードに出ていた事」
 * ---------------------------------------------------------------------------
 * 🚨 2026-08-30 清水さん「カードには品目コード・納期・残り時間・担当状態だけ表示 /
 *    ロットIDや細かい理由は詳細画面へ移す」。
 *    **移しただけで、1つも減らしていない**。ここが移し先。
 *    ・テンプレ名・N台        … 旧カード2行目
 *    ・進み ◯%（バーつき）    … 旧カード4行目の右と5行目
 *    ・盤の札の言い方          … 旧カード1行目の右（迎撃中／順番待ち／分かりません…）
 *    ・担当が付いていない理由  … 旧カード4行目の左（順番待ち／全員作業中／時間未登録）
 *    ・「人が決まっていません」… 旧・赤い小札（カード1枚ずつに出ていた物）
 *    ・ロットID                … これまで画面に1文字も出ていなかった（data 属性だけ）
 * 🚨 値は lotFactsOf（4-b章）ただ1本で作る。盤と同じ式なので、盤と引き出しで
 *    違う事を言う事が起こらない（2026-08-21「片方だけ直すな」）。
 * 🚨 時刻のつまみを動かすと、開いたままでもここが追従する（押した時の値で凍らせない）。
 * ========================================================================= */
function FactRow({ k, children }) {
  return (
    <div className="flex items-start gap-2 border-b border-slate-100 px-2 py-1 last:border-b-0">
      <span className="w-24 shrink-0 text-2xs font-bold leading-snug text-slate-500">{k}</span>
      <span className="min-w-0 flex-1 break-words text-xs leading-snug text-slate-700">{children}</span>
    </div>
  );
}

/* ===========================================================================
 * 6-b. 盤の横位置を「言葉」にする ただ1本
 * ---------------------------------------------------------------------------
 * 🚨🚨 2026-09-05 清水さん(根拠の札の写真)「いまは −33% の位置です」。
 *   位置は「到着 → 納期線」の道のりなので、基準時刻が到着より前なら **負**、
 *   納期線を過ぎていれば **1超** になる(このファイルの頭の実測: −4.53 〜 17.77)。
 *   それを % のまま出すと「マイナス33パーセントの位置」という、現場に無い言い方になる。
 *   逆に 0..1 へ丸めてから出すと「まだ着いていない物」が「到着ちょうど(0%)」という
 *   **嘘**になる(この下の FactRow は clamp01 していたので、こちらの嘘を出していた)。
 * 🚨 だから **% を出すのは 0..1 の時だけ**。その外は起きている事を言葉で言う。
 * 🚨 この文は盤(ここ)と右の根拠(Side.jsx の「計算の元」)の2か所に出る。
 *   **2か所で書かない**ので、ここが ただ1本の口。Side.jsx は import して呼ぶだけ。
 * ⚠ 渡すのは clamp していない生の値(facts.raw)。clamp 済みの facts.ratio を渡すと
 *   負も1超も消えてしまい、この関数が一生 % しか返さない。
 * ⚠ 0 で埋めない。分からない物は「出せません」のまま返す(Number(null)===0 の罠)。
 *
 * 🚨🚨 2026-09-05(検証で出た穴): raw が出せない時の文に **理由を決め打ちしていた**。
 *   盤(この下の FactRow)では raw=null ＝ 到着か納期が無い、で合っている。
 *   ところが右の根拠(Side.jsx)は「到着も納期も分かっている」枝の中から呼ぶので、
 *   すぐ左に日付を書いておきながら「到着日か納期が入っていない」と言う
 *   **自分で自分を否定する1行** が出ていた(そちらで raw が出せないのは、
 *   このロットがその時刻の写しに入っていない＝もう盤から降りている時)。
 *   → 出せない時の言い方は **呼ぶ側が渡す**。言い方の口は1本のまま、
 *     言っていない事を言わない(『元データに無い値を推測で埋めるな』2026-07-10)。
 *
 * @param {object} facts { raw, arrivalMs } もしくは lotFactsOf の戻り(facts.lot.arrivalMs)
 * @param {object} opts  { unknownText } raw が出せない時に返す1文（省略時は盤の言い方）
 * @returns {string} 画面にそのまま出す1文
 */
// eslint-disable-next-line react-refresh/only-export-components -- 部品ではなく文を作る関数。Side.jsx も同じ物を呼ぶ(2か所で書かない)
export function positionSentence(facts, opts) {
  const o = opts || {};
  const raw = (facts && isNum(facts.raw)) ? facts.raw : null;
  if (raw == null) {
    return typeof o.unknownText === 'string' && o.unknownText
      ? o.unknownText
      : '出せません。到着日か納期が入っていないので、盤では道の手前に置いています。';
  }
  if (raw < 0) {
    const arrivalMs = (facts && isNum(facts.arrivalMs))
      ? facts.arrivalMs
      : ((facts && facts.lot && isNum(facts.lot.arrivalMs)) ? facts.lot.arrivalMs : null);
    return arrivalMs == null
      ? 'まだ着いていません（到着の記録がありません）。'
      : `まだ着いていません（到着は ${fmtMDHM(arrivalMs)} の予定）。`;
  }
  if (raw > 1) return WORDS.OPSIM_TRACE_OVER;
  return `到着から納期線までの ${Math.round(raw * 100)}% の所です。`;
}

export function SelectedCardFacts({
  snapshot = null,
  lotId = null,
  lots = [],
  templatesById = null,
  lotVerdictById = null,
  nowMs = null,
}) {
  const facts = useMemo(() => {
    if (!lotId) return null;
    const snapLots = Array.isArray(snapshot && snapshot.lots) ? snapshot.lots : [];
    const lot = snapLots.find((l) => l && l.lotId === lotId) || null;
    if (!lot) return null;
    const snapWorkers = Array.isArray(snapshot && snapshot.workers) ? snapshot.workers : [];
    const atMs = isNum(nowMs) ? nowMs : ((snapshot && isNum(snapshot.atMs)) ? snapshot.atMs : null);
    // 「あと◯分」。盤の layout と同じ拾い方（一番早く終わる人）。
    // ⚠ `!busyMs` で見ると 0分（今まさに終わる）が「未設定」扱いになる。
    let busyMs = null;
    for (const w of snapWorkers) {
      if (!w || w.state !== W_WORKING || w.lotId !== lotId) continue;
      if (!isNum(w.remainingMs)) continue;
      if (busyMs === null || w.remainingMs < busyMs) busyMs = w.remainingMs;
    }
    const fallback = (Array.isArray(lots) ? lots : []).find((l) => l && (l.lotId ?? l.id) === lotId) || null;
    const tplId = lot.templateId || (fallback && fallback.templateId) || null;
    return {
      lot,
      tplName: tplNameOf(templatesById, tplId),
      // 仮の入荷日で計算されている印。判定は normalizeInput の arrivalKind:'assumed' そのまま。
      assumed: !!(fallback && fallback.arrivalKind === 'assumed'),
      // 🚨 2026-09-04: 「仮」の2通り。判定は normalizeInput の arrivalAssumedKind そのまま。
      assumedKind: (fallback && fallback.arrivalAssumedKind) || null,
      ...lotFactsOf(lot, {
        atMs,
        nowMs,
        verdict: lotVerdictById ? lotVerdictById.get(String(lotId)) : null,
        snapWorkers,
        busyMs,
      }),
    };
  }, [snapshot, lotId, lots, templatesById, lotVerdictById, nowMs]);

  if (!facts) return null;
  const { lot } = facts;
  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center gap-1.5 border-b border-slate-100 px-3 py-2">
        <span className="text-xs font-black leading-none text-slate-700">カードに出ていた事</span>
        <span className="text-2xs leading-none text-slate-400">盤では印だけにしています</span>
      </div>
      <div className="py-1">
        <FactRow k="ロットID">{String(lot.lotId)}</FactRow>
        <FactRow k="テンプレ・台数">{`${facts.tplName || 'テンプレ名なし'}・${lot.quantity || 1}台`}</FactRow>
        {/* 「仮」の意味をカードを押した先でも1回言う（2026-08-31 清水さん「わかりやすくして」）。 */}
        {facts.assumed ? (
          /* 🚨 2026-09-04: 丸めた物を「納期の2日前」と言わない（清水さんが見た嘘の元）。 */
          <FactRow k="入荷日">
            <span className={`mr-1 inline-block rounded border px-1 py-0.5 text-2xs font-bold leading-none ${
              facts.assumedKind === 'clampedToNow'
                ? 'border-red-500 bg-red-50 text-red-800'
                : 'border-amber-400 bg-amber-50 text-amber-800'}`}
            >
              {facts.assumedKind === 'clampedToNow' ? '仮（過ぎ→基準時刻）' : '仮'}
            </span>
            {facts.assumedKind === 'clampedToNow'
              ? '入荷日が無いので納期より前に置こうとしましたが、その日はもう過ぎているので、計算の基準時刻に置いています。納期が来ているのに入荷の登録がありません'
              : (facts.assumedKind === 'beforeDue'
                ? '入荷日が無いので、納期より前に仮に置いて計算しています'
                : '入荷日が無いので仮に置いて計算しています（どちらの置き方かは計算から返ってきていません）')}
            。本当の入荷日を入力すると、そちらで計算し直します（元のデータには1文字も書き戻していません）。
          </FactRow>
        ) : null}
        {/* 🚨 2026-08-30「重複文言を整理」: 盤の札と、下の担当状態の括弧が
            同じ語になる時がある(夜は必ず「順番待ち」が2回並ぶ。statusOf と
            noOneReason の最後の枝が同じ条件で同時に成立する為)。同じ事を2回言わない。 */}
        {String(facts.status.label) === String(facts.reason) ? null : (
          <FactRow k="盤の札">
            <span className={`inline-block rounded border px-1 py-0.5 text-2xs font-bold leading-none ${facts.status.cls}`}>
              {facts.status.label}
            </span>
          </FactRow>
        )}
        <FactRow k="担当状態">
          {facts.hasWorker
            ? <span className="font-bold text-cyan-700">{facts.workerText}</span>
            : (facts.needsSomeone
              ? <span className="font-bold text-rose-600">{`人が決まっていません（${facts.reason}）`}</span>
              : <span className="text-slate-500">到着前</span>)}
        </FactRow>
        <FactRow k="進み">
          <span className="tabular-nums">{doneText(lot)}</span>
          <span className="mt-1 block h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
            <span
              className="block h-full rounded-full bg-gradient-to-r from-cyan-500 to-amber-400"
              style={{ width: `${facts.barPct}%` }}
            />
          </span>
        </FactRow>
        {/* ⚠ 納期・残り・到着は、この下の「根拠」が日時つきで出す（そちらが細かい）。
            ここに3つ目を書くと同じ事を2回言う事になるので、書かない。 */}
        {/* 🚨 2026-09-05: ここは clamp01 済みの facts.ratio を見ていたので、
            まだ着いていない物(raw が負)まで「0% の所です」と言っていた。
            言い方は positionSentence ただ1本(6-b章)。生の facts.raw を渡す。
            🚨🚨 2026-09-05(検証で出た穴): その positionSentence を
            この下の根拠(Side.jsx の「計算の元」)も呼ぶ。数字も1本(posRatioAt)にした結果、
            **同じ1文が上下に2回** 並ぶ形になった。すぐ上の納期・残り・到着と同じ決まりで、
            細かい方(到着→納期の道のりと一緒に出る根拠)へ寄せる。
            ⚠ 行そのものは消さない(決まり11: 情報は移す・畳む)。ここには行き先だけ残す。 */}
        <FactRow k="盤の位置">
          <span className="text-slate-500">この下の「根拠 → 計算の元」に、到着から納期までの道のりと一緒に出しています。</span>
        </FactRow>
      </div>
    </div>
  );
}

/* ===========================================================================
 * 7. 盤面ほんたい
 * ------------------------------------------------------------------------- */
/**
 * @param {object}   props.snapshot          simulate.js の snapshot（{ atMs, lots[], workers[] }）
 * @param {Array}    props.lots              元のロット一覧（品目コードなどの控え。無くても動く）
 * @param {object}   props.templatesById     テンプレ id → { name }（Map でも可）
 * @param {string}   props.selectedLotId     いま選ばれているカード
 * @param {Function} props.onSelectLot       カードを押した時に lotId を渡す
 * @param {object}   props.forecastSnapshot  期間の終わりの snapshot（予測の点線に使う）
 * @param {number}   props.heightPx          盤の高さ。**下限**として効く（段が入らない時は伸びる）
 * @param {number}   [props.originMs]        1日目の朝。渡すと納期を「N日目」と書く（無ければ月日）
 * @param {string}   [props.focus]           'moving'（既定）＝この期間で動く物だけ / 'all'＝全部
 * @param {number}   [props.widthPx]         幅を測る前（初回描画・サーバ描画）に使う幅。
 *                                          実際に測れたら実測が勝つ。
 * @param {number}   [props.periodDays]      🚨 **エンジンが実際に回した営業日の数**
 *                   （result.normalized.horizonDays）。盤の言い方（「この◯営業日」）は
 *                   すべてこれ1つから出る。渡さない時は日数を作らず「この期間」とだけ言う。
 *                   ⚠ 画面が選んだ期間ではなく、**結果が名乗る日数** を渡す事。
 *                     選んだ期間を渡すと、まだ計算していない期間の名前で
 *                     前の結果の盤を出す事になる（基準時刻で一度やった間違い）。
 */
export function Board({
  snapshot = null,
  lots = [],
  templatesById = null,
  selectedLotId = null,
  onSelectLot = null,
  forecastSnapshot = null,
  heightPx = 620,
  originMs = null,
  focus = 'moving',
  widthPx = null,
  periodDays = null,
  /** 'due'（既定・一番早い納期線順）/ 'risk'（納期がやばい順・急ぎが最上位） */
  sortMode = 'due',
  /** 並べ替えの切替を親へ返す（親が持ち主。盤は持たない） */
  onSortMode = null,
  /** 急ぎ(lot.priority==='high')のロットID。🚨 本番は0件。0件でも壊れない事。 */
  highPriorityLotIds = null,
  /** result.base.lotResults を lotId で引ける形にした物（エンジンの見立て） */
  lotVerdictById = null,
  /** 再生を始めた時に固定した並び。null なら毎回 sortMode で並べ直す */
  frozenLaneOrder = null,
  /** いま決まった並び（品目コードIDの配列）を親へ返す。親はこれを凍結の材料にする */
  onLaneOrder = null,
  /** 🚨「終わったら次はこの品目コード」に要る。result.base.assignments をそのまま。
   *   渡らない時は **その行を1文字も書かない**（「予定なし」は測っていないのに測った顔になる）。 */
  assignments = null,
  /**
   * つまみが指している **いまの時刻**。記録(snapshot)は 0.3日ごとにしか無いので、
   * それより細かく動かすとカードが止まって見える。
   * 🚨 これで作り直すのは **横位置と、着いたか/納期線を過ぎたか だけ**。
   *   位置は「到着→納期線のどこまで来たか」＝時刻だけで決まる純粋な計算なので、
   *   記録の間を埋めても値をでっち上げた事にならない（エンジンと同じ式）。
   * 🚨 誰が何をしているか（帯・担当者の札）は作り直さない。あれは計算の結果で、
   *   間を埋めると **測っていない割り当てを作る** 事になる。記録のまま出す。
   */
  nowMs = null,
  /**
   * 遅れて完了した物（決まり10・2026-09-02 清水さん「一回納期遅れてることは事実なのに情報がなくなってる」）。
   * 形は domain/operationsSimulation/lateDone.js の buildLateDone の戻り + rows[].tplName
   * （{ rows:[{lotId, model, tplName, orderNo, dueMs, completedMs, daysLate}], counts, windowText }）。
   * 🚨 ここでは数えない。盤の右端の棚に **灰色の札＋赤い +N日** で並べるだけ。null なら棚を出さない。
   */
  lateDone = null,
}) {
  const boardRef = useRef(null);
  const [measured, setMeasured] = useState(0);

  // ⚠ 画面では useLayoutEffect が測った実測が勝つ。widthPx は測る前だけの下地。
  const width = measured > 0 ? measured : (isNum(widthPx) && widthPx > 0 ? widthPx : 0);

  // 盤の中のピルで切り替えた時だけ、この値が親の focus より優先される。
  // （useEffect で prop を state へ写すと、親が focus を変えても戻らなくなる）
  const [focusOverride, setFocusOverride] = useState(null);
  const focusMode = focusOverride || (focus === 'all' ? 'all' : 'moving');
  const focusMoving = focusMode === 'moving';

  /* 🚨 2026-09-04 決まり19A: 期間の言い方は **ここ1本**。
   *   「この5日」を文字で書かない。日数が渡っていなければ日数を作らず「この期間」と言う。 */
  const periodWord = opsimPeriodWord(periodDays);

  /* ── 大きさ（倍率 k）。2026-09-01 ────────────────────────────────────────
   * 🚨 端末に覚えさせる（次に開いた時も同じ大きさ）。
   *   ⚠ localStorage が読めない端末・私用ブラウザの設定で例外が出る事があるので、
   *     読み書きは必ず try/catch。読めなければ「標準」で普通に動く。
   * 🚨 ここで作った D（寸法一式）だけを、この下の計算と描画が読む。
   *   モジュールの BASE_DIMS を直に読む所を1つでも残すと、そこだけ大きくならずに重なる。 */
  const [zoomKey, setZoomKey] = useState(() => {
    try {
      const v = window.localStorage.getItem(BOARD_ZOOM_KEY);
      if (v && BOARD_ZOOM_STEPS.some((s) => s.key === v)) return v;
    } catch { /* 読めない端末では標準で動かす */ }
    return BOARD_ZOOM_DEFAULT;
  });
  const pickZoom = useCallback((key) => {
    setZoomKey(key);
    try { window.localStorage.setItem(BOARD_ZOOM_KEY, key); } catch { /* 覚えられなくても今の画面は大きくなる */ }
  }, []);
  const D = useMemo(() => dimsOf(zoomStepOf(zoomKey).k), [zoomKey]);

  useLayoutEffect(() => {
    const el = boardRef.current;
    if (!el) return undefined;
    const read = () => setMeasured(el.clientWidth || 0);
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleSelect = useCallback((lotId) => {
    if (typeof onSelectLot === 'function') onSelectLot(lotId);
  }, [onSelectLot]);

  const lotsById = useMemo(() => {
    const m = new Map();
    (Array.isArray(lots) ? lots : []).forEach((l) => {
      const id = l && (l.lotId ?? l.id);
      if (id) m.set(id, l);
    });
    return m;
  }, [lots]);

  // 🚨 人の色は **名簿の並び** だけで決める。時刻でも、持っている仕事でも決めない。
  //   時間を進めるたびに人の色が変わると、盤と右の一覧を見比べられなくなる。
  const workerColors = useMemo(() => buildWorkerColors(workerNamesOf(snapshot)), [snapshot]);

  /**
   * 作業者ごとの言葉（いま何を・あと何分・つぎは何を・手が空いている理由）。
   * 2026-09-04 から、作業者ごとのレーン（盤の先頭）の帯の一番下の行に出る（前は盤の上の WorkerRail）。
   * 🚨 assignments が渡っていない時、「つぎ」は空文字＝1文字も書かない。
   * 🚨 理由の書いていない待機を出さない（理由が取れない事自体を書く）。
   */
  const railItems = useMemo(() => {
    const ws = Array.isArray(snapshot && snapshot.workers) ? snapshot.workers : [];
    const snapLots = Array.isArray(snapshot && snapshot.lots) ? snapshot.lots : [];
    // assignments は lotId しか持たないので、品目コードはここで引く。
    const modelOf = (lotId) => {
      const a = lotsById.get(lotId);
      const am = a && typeof a.model === 'string' ? a.model.trim() : '';
      if (am) return am;
      const b = snapLots.find((l) => l && l.lotId === lotId);
      return (b && typeof b.model === 'string') ? b.model.trim() : '';
    };
    // 決まり12: テンプレ名も lotId から引く（正規化済みロット → snapshot の順。どちらも templateId を持つ）。
    const tplOf = (lotId) => {
      const a = lotsById.get(lotId);
      const b = a || snapLots.find((l) => l && l.lotId === lotId);
      return tplNameOf(templatesById, b && b.templateId) || 'テンプレ名なし';
    };
    const withTpl = (model, lotId) => `${model || '品目コードなし'}｜${tplOf(lotId)}`;
    return ws.map((w) => {
      const name = (w && w.name) || '';
      const working = !!w && w.state === W_WORKING;
      const nx = (working && isNum(w.endMs)) ? nextJobOf(assignments, name, w.endMs) : null;
      const nextModel = nx ? modelOf(nx.lotId) : '';
      return {
        name,
        tone: toneOf(workerColors, name),
        working,
        nowText: working ? `${withTpl(w.model, w.lotId)}・${w.stepTitle || '工程名の記録がありません'}` : '',
        remainText: (working && isNum(w.remainingMs)) ? `あと${fmtDur(w.remainingMs)}` : '',
        idleText: working ? '' : ((w && w.reason) ? `手が空いています：${String(w.reason)}` : '手が空いている理由が取れていません'),
        // 🚨 いま働いていない人に「この先の割り当てはありません」と書かない。
        //   その人の『次』は、いまの仕事が終わる時刻を起点に探す物なので、
        //   働いていない＝**探していない**。探していないのに「ありません」は嘘になる。
        nextText: (!Array.isArray(assignments) || !working)
          ? ''
          : (nx
            ? `つぎ ${withTpl(nextModel, nx.lotId)}`
            : 'この先の割り当ては、この見立ての中にはありません'),
        title: working
          ? `${name} さん：${withTpl(w.model, w.lotId)}／${w.stepTitle || '工程名の記録がありません'}`
          : `${name} さん：${(w && w.reason) || '理由が取れていません'}`,
      };
    });
  }, [snapshot, assignments, workerColors, lotsById, templatesById]);

  const layout = useMemo(() => {
    const snapAtMs = snapshot && isNum(snapshot.atMs) ? snapshot.atMs : null;
    // つまみの時刻が来ていればそちらを使う（記録の間を埋める）。
    const atMs = isNum(nowMs) ? nowMs : snapAtMs;
    const snapWorkers = Array.isArray(snapshot && snapshot.workers) ? snapshot.workers : [];
    const src = Array.isArray(snapshot && snapshot.lots) ? snapshot.lots : [];

    // 片付いた仕事は盤から消す（是正指示書 6.3）。
    // ⚠ lotId が無い物も外す。カードの key と選択の目印が lotId なので、無いと重なる。
    const live = src.filter((l) => l && l.lotId && !(l.doneRatio >= 1 && !(l.remainingMs > 0)));

    // 「この人がいま何分で終わるか」を lotId から引けるようにしておく。
    const busyByLot = new Map();
    for (const w of snapWorkers) {
      if (!w || w.state !== W_WORKING || !w.lotId) continue;
      if (!isNum(w.remainingMs)) continue;
      const cur = busyByLot.get(w.lotId);
      // ⚠ `!cur` で見ると 0 分（今まさに終わる）が「未設定」扱いになって上書きされる。
      if (cur === undefined || w.remainingMs < cur) busyByLot.set(w.lotId, w.remainingMs);
    }

    // --- 1件ずつの下ごしらえ（ここでは絞らない。数を全部持っておく） --------
    const prepared = [];
    for (const lot of live) {
      const fallback = lotsById.get(lot.lotId) || null;
      const tplId = lot.templateId || (fallback && fallback.templateId) || null;
      const tplName = tplNameOf(templatesById, tplId);
      const laneId = laneKeyOf(lot);

      // 🚨 1件ぶんの事実は lotFactsOf ただ1本（4-b章）。盤と引き出しが同じ式を読む。
      //   ここに2本目を書くと、押した時の引き出しと盤で違う事を言い始める。
      const facts = lotFactsOf(lot, {
        atMs,
        nowMs,
        verdict: lotVerdictById ? lotVerdictById.get(String(lot.lotId)) : null,
        snapWorkers,
        busyMs: busyByLot.get(lot.lotId),
      });

      prepared.push({
        ...facts,
        lot,
        laneId,
        tplName,
        originMs: isNum(originMs) ? originMs : null,
        // ⑤ その人の色。**ここで色を作らない**（右の一覧と食い違う）。名簿から引くだけ。
        tone: facts.hasWorker ? toneOf(workerColors, facts.names[0]) : NEUTRAL_TONE,
        // ⑥ 仮の入荷日で計算されている印（2026-08-31 清水さん「そこはわかりやすくして」）。
        //   判定は normalizeInput の arrivalKind:'assumed' **そのまま**（ここで作り直さない）。
        //   snapshot には乗っていないので、lots プロップ(正規化済みロット)から同じ lotId で引く。
        assumed: !!(fallback && fallback.arrivalKind === 'assumed'),
        // 🚨 2026-09-04: 「仮」の2通り（納期のN日前に置けた／N日前が過ぎていて基準時刻に置いた）。
        //   ここで取らないと、盤のカードが丸めた物まで「納期の2日前」と言う事になる。
        assumedKind: (fallback && fallback.arrivalAssumedKind) || null,
      });
    }

    // 🚨 三つに分ける。ここは重なりが無い（合計＝未完了の総数）。
    //   実データ(`opsim-sample.json` snapshotSample 179件をこの式で数えた):
    //   まだ届いていない 87件 ／ 届いている 16件 ／ 予定日を過ぎた 76件。
    const groupCounts = {
      notArrived: prepared.filter((c) => c.notArrived).length,
      inPlay: prepared.filter((c) => !c.notArrived && !c.breached).length,
      breached: prepared.filter((c) => c.breached).length,
    };

    // --- 盤へ出す物を決める ------------------------------------------------
    // 🚨 'moving' の中身:
    //   ① 担当が付いている物（すでに人が動かしている＝この期間で必ず動く）
    //   ② 届いていて、まだ納期線を越えていない物
    //   ②の判定に `!breached`（raw>1 でない）を使う。`ratio < 1` と書くと
    //   **納期が分からない物（raw=null・実データ14件）** の扱いが JS の型変換頼みになる。
    //   納期が分からない物は左端に置いて「納期 分かりません」と書く。ここで落とすと
    //   左右どちらの帯にも入らず、画面のどこにも出ない物ができてしまう。
    // 🚨 未到着(notArrived)は **どちらの focus でも盤に出さない**。左の帯が受け持つ。
    //   以前 focus='all' では盤の左端(ratio=0)へ置いていたが、
    //   ①左の帯と二重に出る ②到着していない物が「作業できる場所」に並ぶ、の2つが起きていた。
    //   ただし **担当が付いている物** は例外。到着前に手が付く事は無いはずだが、
    //   もし起きていたらそれは見えないといけない（黙って消さない）。
    const boardList = focusMoving
      ? prepared.filter((c) => c.hasWorker || (!c.notArrived && !c.breached))
      : prepared.filter((c) => c.hasWorker || !c.notArrived);

    // 🚨 決まり15-1（2026-09-03 清水さん「作業者処理してるやつは見やすくするために上に来る」）:
    //   担当が付いている札は **作業者ごとの帯** に入れて盤の先頭に固定する。品目コードのレーンからは外す
    //   （同じ札を2か所に出さない）。帯の並びは名簿の並び（snapshot.workers）＝時刻で変わらない。
    //   手が空いている人の帯も出す（札は0枚）＝「空いている事」と「理由」が盤の上で読める（決まり14-3）。
    //   2人で1つの札を持つ時は、1人目の帯に置いて札に「他1」と書く（いままでの札の書き方のまま）。
    const heldBy = new Map();   // lotId → 帯の主（names[0]）
    const workerLaneCards = new Map(snapWorkers.map((w) => [w && w.name, []]).filter(([n]) => !!n));
    for (const c of prepared) {
      if (!c.hasWorker) continue;
      const owner = c.names[0];
      if (!workerLaneCards.has(owner)) workerLaneCards.set(owner, []);
      workerLaneCards.get(owner).push(c);
      heldBy.set(c.lot.lotId, owner);
    }
    const workerLaneList = [...workerLaneCards.entries()].map(([name, list]) => ({ name, cards: list }));
    const modelList = boardList.filter((c) => !heldBy.has(c.lot.lotId));

    // 盤に出していない物の置き場所（左右の帯）。名前で出すのは先頭だけ、残りは数で出す。
    const incomingAll = prepared
      .filter((c) => c.notArrived)
      .sort((a, b) => {
        const av = isNum(a.lot.arrivalMs) ? a.lot.arrivalMs : Infinity;
        const bv = isNum(b.lot.arrivalMs) ? b.lot.arrivalMs : Infinity;
        return av - bv;
      });
    const overdueAll = prepared
      .filter((c) => c.breached)
      .sort((a, b) => {
        // 予定日が古い順＝いちばん長く過ぎている物から。
        const av = isNum(a.lot.dueLineMs) ? a.lot.dueLineMs : Infinity;
        const bv = isNum(b.lot.dueLineMs) ? b.lot.dueLineMs : Infinity;
        return av - bv;
      });
    const toItem = (c, sub) => ({
      key: c.lot.lotId,
      // 決まり12: 帯の札にも 品目コード｜テンプレ。
      main: `${c.lot.model || '品目コードなし'}｜${c.tplName || 'テンプレ名なし'}`,
      sub,
      title: `${c.lot.model || '品目コードなし'}｜${c.tplName || 'テンプレ名なし'}｜${c.lot.quantity || 1}台`,
    });
    // 「（仮）」＝仮の入荷日で計算されている印（2026-08-31）。左の帯にも必ず見せる。
    const incoming = incomingAll.slice(0, STRIP_LIST_MAX)
      .map((c) => toItem(c, `${arrivalText(c.lot, isNum(originMs) ? originMs : null)}${c.assumed ? '（仮）' : ''}`));
    // 決まり15: 右の棚は **全部** 名前で出す（間引かない）。赤い「+N日」＝いまの時刻で数えた遅れ（lateDays ただ1本）。
    //   並びは納期が古い順＝一番長く過ぎている物が上（時間を進めても入れ替わらない）。
    const overdue = overdueAll.map((c) => ({
      ...toItem(c, `${fmtMD(c.lot.dueLineMs)}納期・${c.hasWorker
        ? `${c.names[0]} 作業中`
        : (c.notArrived ? 'まだ届いていない' : '担当 未定')}${c.assumed ? '（仮）' : ''}`),
      badge: c.daysLate != null && c.daysLate >= 1 ? `+${c.daysLate}日` : '今日',
      // 🚨 棒の長さにする数。lateDone.js の lateDays(＝上の badge と同じ1本)をそのまま運ぶだけ。
      //   「今日」は 0日 なので 0(＝長さ0の溝)。読めていない(点線の枠)とは別の絵にする。
      days: c.daysLate != null && c.daysLate >= 1 ? c.daysLate : 0,
      title: `${c.lot.model || '品目コードなし'}｜${c.tplName || 'テンプレ名なし'}｜指図 ${(lotsById.get(c.lot.lotId) || {}).orderNo || '—'}｜納期 ${fmtMD(c.lot.dueLineMs)} を ${c.daysLate != null && c.daysLate >= 1 ? `${c.daysLate}日` : '今日'} 過ぎています（まだ終わっていません）`,
    }));
    // 盤にも出している「予定日を過ぎたが担当が付いている物」の数（数字の二重計上を白状する用）。
    const overdueOnBoard = focusMoving ? prepared.filter((c) => c.breached && c.hasWorker).length : 0;

    // ② 遅れて終わる見込み（決まり15・2026-09-04 確かめ役の実測「＋2時間で RT-106,H(+30日) が棚から消えた」）。
    //   記録(snapshot)は片付いたロットを乗せない（指示書6.3）ので、見立て(lotResults)の
    //   「いまの時刻までに終わっていて、終わりが納期線より後」を lateForecast.js で数えて棚に残す。
    //   🚨 ①納期を過ぎた（上）とも ③遅れて完了（記録・下）とも **別の棚・別の数**。
    //   品目コード・テンプレ・指図は snapshot に無いので lots プロップ(lotsById)から引く。無ければ「品目コードなし」と正直に書く。
    const lateForecastAll = buildLateForecast({
      lotResults: lotVerdictById ? [...lotVerdictById.values()] : [],
      atMs,
    });
    const lateForecast = lateForecastAll.rows.map((r) => {
      const fb = lotsById.get(r.lotId) || null;
      const model = (fb && fb.model) || '品目コードなし';
      const tplName = tplNameOf(templatesById, fb && fb.templateId);
      const orderNo = (fb && fb.orderNo) || '—';
      const late = r.daysLate != null && r.daysLate >= 1 ? `${r.daysLate}日` : '今日';
      return {
        key: r.lotId,
        main: `${model}｜${tplName || 'テンプレ名なし'}`,
        sub: `${fmtMD(r.dueLineMs)}納期→${fmtMD(r.finishMs)}終わる見込み${fb && fb.arrivalKind === 'assumed' ? '（仮）' : ''}`,
        badge: r.daysLate != null && r.daysLate >= 1 ? `+${r.daysLate}日` : '今日',
        days: r.daysLate != null && r.daysLate >= 1 ? r.daysLate : 0,
        title: `${model}｜${tplName || 'テンプレ名なし'}｜指図 ${orderNo}｜納期 ${fmtMD(r.dueLineMs)} を ${late} 過ぎて終わる見込み（計算の上では ${fmtMD(r.finishMs)} に終わっています）`,
      };
    });

    // --- レーン分け（品目コードごとに1本）--------------------------------------
    // 🚨 並べ替えは段(tier)で分ける。急ぎ／すでに過ぎた／この先で遅れる／判定できません を
    //    1つの点数に混ぜない（2026-08-22 の事故と同じ形になる）。
    const laneBuild = buildModelLanes(modelList, {
      sortMode,
      highPriorityLotIds,
      lotVerdictById,
      frozenOrder: frozenLaneOrder,
    });
    const activeLanes = laneBuild.lanes;
    const byLane = new Map(activeLanes.map((l) => [l.id, l.cards]));

    /* --- 高さ。**入れ物（見える窓）と 中身（描く全部）を分ける**（2026-09-01）-----
     * 🚨🚨 ここが 2026-08-24 から2度残っていた罠の直し。
     *   前の版:
     *      const minH     = topStrip + BOTTOM_PAD + laneCount * (ROW_H + LANE_FOOTER);
     *      const contentH = Math.max(heightPx, minH);      // ← heightPx は下限にしかならない
     *      const trackH   = contentH - topStrip - BOTTOM_PAD;
     *      const totalRows= max(laneCount, floor((trackH - laneCount*LANE_FOOTER) / ROW_H));
     *   実測（本番の写し 633ロット・レーン14本）で minH=1414 が heightPx(578/610/890)に
     *   毎回勝っていた。すると trackH は必ず laneCount*(ROW_H+LANE_FOOTER) になり、
     *   totalRows は **必ず laneCount に潰れる**（1レーン1段）。
     *   ＝「高さの数を増やすボタン」を作っても盤は1pxも大きくならず、段も1段も増えない。
     *   窓を 1024→1920 に広げても盤の高さは 1412px のまま動かなかった。
     *
     *   直した形:
     *      viewportH   … 入れ物。親が渡した heightPx そのもの＝「一度に目に入る高さ」
     *      trackViewH  … その中で道に使える高さ。**段数はこれで決める**
     *      trackContentH … 中身。段を並べ切るのに要る高さ（足りなければ縦に送る）
     *   これで heightPx が段数に効く＝窓を広げると本当に段が増える。
     *   置けない分は黙って隠さず、「何本中 何本見えています」で必ず数を出す。 */
    const laneCount = Math.max(activeLanes.length, 1);
    // 🚨 2026-09-04: 上の作業者の帯(RAIL_H)は作業者ごとのレーンへ移した（道の中・先頭に固定）。
    //   上の帯は TOP_STRIP だけ＝盤の道が 48px 上から始まる。
    const topStrip = D.TOP_STRIP;
    // 作業者のレーンは1人1段（札は普通1枚。2枚以上は段組みが「あと N件」で数を出す）。
    const WORKER_ROWS = 1;
    const workerLaneCount = workerLaneList.length;
    const workerLanesH = workerLaneCount * (WORKER_ROWS * D.ROW_H + D.LANE_FOOTER);
    const viewportH = Math.max(MIN_VIEWPORT_H, isNum(heightPx) ? heightPx : 0);
    const trackViewH = Math.max(D.ROW_H + D.LANE_FOOTER, viewportH - topStrip - D.BOTTOM_PAD);
    // 品目コードのレーンに配れる高さ＝道の高さ − 作業者のレーンの高さ。
    const modelViewH = Math.max(D.ROW_H + D.LANE_FOOTER, trackViewH - workerLanesH);
    const totalRows = Math.max(laneCount, Math.floor((modelViewH - laneCount * D.LANE_FOOTER) / D.ROW_H));
    // shareRows は totalRows を1段ずつ配り切る（合計は必ず totalRows）ので、中身の高さは式で出せる。
    const trackContentH = workerLanesH + totalRows * D.ROW_H + laneCount * D.LANE_FOOTER;
    const contentH = topStrip + trackContentH + D.BOTTOM_PAD;

    const common = {
      viewportH,
      trackViewH,
      trackContentH,
      contentH,
      laneTotal: laneCount + workerLaneCount,
      workerLaneCount,
      heldCount: heldBy.size,
      zoomK: D.k,
      topStrip,
      total: prepared.length,
      boardTotal: boardList.length,
      groupCounts,
      incoming,
      overdue,
      incomingTotal: incomingAll.length,
      overdueTotal: overdueAll.length,
      overdueOnBoard,
      // ② 遅れて終わる見込み（計算）。①とも③とも別の数。counts は「数えていない物」の白状。
      lateForecast,
      lateForecastTotal: lateForecastAll.rows.length,
      lateForecastCounts: lateForecastAll.counts,
      appendedLanes: laneBuild.appendedCount,
      laneIds: activeLanes.map((l) => l.id),
      // 🚨 急ぎは本番636件すべて 'normal'。0件を隠さずそのまま出す。
      highCount: highPriorityLotIds
        ? prepared.filter((c) => highPriorityLotIds.has(String(c.lot.lotId))).length
        : null,
    };

    if ((!activeLanes.length && !workerLaneCount) || width <= 0) {
      return {
        ...common,
        lanes: [], cards: [], cardW: D.CARD_W_MIN,
        empty: !activeLanes.length && !workerLaneCount, shown: 0, visibleLanes: 0, visibleCards: 0,
      };
    }

    // --- 横位置。duePosRatio 0 → 道の左端 / 1 → 納期線（81％） -------------
    const cardW = Math.round(clamp(width * 0.2, D.CARD_W_MIN, D.CARD_W_MAX));
    const trackLeft = Math.max(D.LANE_GUTTER + 6, width * (TRACK_LEFT_PCT / 100));
    const dueX = width * (LINE_PCT.due / 100);
    const gateLeft = width - D.GATE_R - D.GATE_W;
    const minLeft = D.LANE_GUTTER + 4;
    const maxLeft = Math.max(minLeft, gateLeft - 8 - cardW);

    // 🚨🚨 ここが「カードが動いて見えるか」の急所。
    //   前の版は「中心＝道の位置」を1枚ずつ出してから両端で clamp していた。
    //   すると左端寄り・右端寄りの札は ratio が変わっても left が同じ値へ潰れ、
    //   時間を進めても1pxも動かなかった。
    //   ここでは先に「ratio=0 の left」と「ratio=1 の left」を作り、その間を ratio で割る。
    //   clamp を使うのは両端の2つを作る時だけなので、間の札は ratio に対して必ず単調に動く。
    // 🚨 2026-08-24: 位置が出せない札（到着か納期が入っていない／納期が到着より前）を
    //   道の左端へ置くと、「いま着いたばかり」の札と **同じ場所** に並ぶ。
    //   実測(2026-08-24): 盤の13枚中11枚がこれで、13枚とも left=36px に固まっていた。
    //   ＝盤を横に広げても、広がるのは札の居ない空白だけだった。
    //   なので道の **手前** に置き場を作り、道の始まりをその分だけ右へずらす。
    //   ⚠ 置き場を作るのは、実際に位置の出せない札が居る時だけ。
    //     居ないのに空けると、道が理由なく狭くなる。
    const unknownCount = boardList.filter((c) => c && c.ratio == null).length;
    // 🚨 2026-08-30: 説明の文字が、置き場に停めた札の **下に潜って読めなかった**。
    //   原因は「札の置き場」と「説明の置き場」が同じ長方形を共有していた事。
    //   説明は左上(left-1 top-0)、札も同じ所(left=minLeft)の1段目だったので、
    //   1段目に札が1枚でも入れば文字が隠れる＝ほぼ必ず隠れていた。
    //   → **説明に専用の柱を作り、札はその右へ寄せる**。
    //     札の縦の位置はレーンの段で決まる(レーンごとに縦へ散る)ので縦では避けられない。
    //     横で分ける以外に、重なりを無くす道は無い。
    //   ⚠ 柱を作るのは位置の出せない札が居る時だけ。居ないのに空けると道が理由なく狭くなる。
    //   ⚠ 幅は文字が収まる分だけ(11px×8字＝約88px)。広げるほど道の長さ(travel)を食う。
    //   ⚠ この柱も倍率 k で作り直す(文字が大きくなるので、標準のままだと入り切らない)。
    const UNKNOWN_LABEL_W = unknownCount > 0 ? D.UNKNOWN_LABEL_W : 0;
    const unknownX = minLeft + UNKNOWN_LABEL_W;
    const trackStart = unknownCount > 0
      ? Math.max(trackLeft, unknownX + cardW + D.UNKNOWN_GAP)
      : trackLeft;

    // 🚨🚨 ここが「カードが動いて見えるか」の急所。
    //   前の版は「中心＝道の位置」を1枚ずつ出してから両端で clamp していた。
    //   すると左端寄り・右端寄りの札は ratio が変わっても left が同じ値へ潰れ、
    //   時間を進めても1pxも動かなかった。
    //   ここでは先に「ratio=0 の left」と「ratio=1 の left」を作り、その間を ratio で割る。
    //   clamp を使うのは両端の2つを作る時だけなので、間の札は ratio に対して必ず単調に動く。
    const leftAt0 = Math.round(clamp(trackStart - cardW / 2, unknownCount > 0 ? trackStart - cardW / 2 : minLeft, maxLeft));
    const leftAt1 = Math.round(clamp(dueX - cardW / 2, minLeft, maxLeft));
    const leftOfRatio = (r) => (r == null
      ? unknownX
      : Math.round(leftAt0 + clamp01(r) * (leftAt1 - leftAt0)));

    const rowsPerLane = activeLanes.length
      ? shareRows(activeLanes.map((l) => byLane.get(l.id).length), totalRows)
      : [];

    const lanes = [];
    const cards = [];
    // 🚨 レーンの縦位置は **道（track）の中での 0 から** 数える（2026-09-01）。
    //   上の帯は道の外に出して、縦に送っても消えない場所へ置いた。
    let top = 0;
    // ① 作業者のレーン（先頭に固定・決まり15-1）。帯の一番下の行に「つぎ」か「手が空いている理由」。
    const railByName = new Map(railItems.map((it) => [it.name, it]));
    for (const wl of workerLaneList) {
      const it = railByName.get(wl.name) || null;
      const working = !!(it && it.working);
      const laneH = WORKER_ROWS * D.ROW_H + D.LANE_FOOTER;
      const list = wl.cards.map((c) => ({ ...c, left: leftOfRatio(c.ratio), posUnknown: c.ratio == null }));
      const { placed, overflow } = packLane(list, WORKER_ROWS, cardW, gateLeft - 6, D);
      lanes.push({
        id: `w:${wl.name}`, kind: 'worker', label: wl.name, tplLabel: '', top, height: laneH, hidden: overflow,
        tone: toneOf(workerColors, wl.name), working,
        // 働いている人＝「つぎ ◯◯」（assignments が無い時は空＝1文字も書かない）。空いている人＝理由。
        note: it ? (working ? (it.nextText || '') : (it.idleText || '')) : '',
      });
      for (const p of placed) {
        cards.push({ ...p, top: top + p.row * D.ROW_H + 6, laneTop: top, laneH });
      }
      top += laneH;
    }
    // ② 品目コードのレーン（いままで通り）。
    activeLanes.forEach((lane, i) => {
      const rows = rowsPerLane[i];
      const laneH = rows * D.ROW_H + D.LANE_FOOTER;
      const list = byLane.get(lane.id).map((c) => ({ ...c, left: leftOfRatio(c.ratio), posUnknown: c.ratio == null }));
      const { placed, overflow } = packLane(list, rows, cardW, gateLeft - 6, D);
      lanes.push({ id: lane.id, kind: 'model', label: lane.label, tplLabel: lane.tplLabel || '', top, height: laneH, hidden: overflow });
      for (const p of placed) {
        cards.push({ ...p, top: top + p.row * D.ROW_H + 6, laneTop: top, laneH });
      }
      top += laneH;
    });

    /* 🚨「今 何本中 何本見えています」を出すための実数（2026-08-30 の指示:
     *   情報は移す・畳む・強さを変える。**消さない・黙って隠さない**）。
     *   「見える」＝ 縦に送らずに、まるごと目に入る物だけ。半分だけの物は数えない。 */
    const visibleLanes = lanes.filter((l) => l.top + l.height <= trackViewH).length;
    const visibleCards = cards.filter((c) => c.top + D.CARD_H <= trackViewH).length;

    return {
      ...common,
      lanes, cards, cardW, unknownCount, dueX, trackLeft, gateLeft, leftAt0, leftAt1,
      // 説明の柱と、札の置き場の境目。描く側が同じ値で引けるように出す
      // （盤の絵と位置の計算を別々の式で作らない）。
      unknownX, unknownLabelW: UNKNOWN_LABEL_W,
      empty: false, shown: cards.length, visibleLanes, visibleCards,
    };
  }, [snapshot, lotsById, templatesById, width, heightPx, originMs, focusMoving,
    sortMode, highPriorityLotIds, lotVerdictById, frozenLaneOrder, workerColors, nowMs, D, railItems]);

  // 🚨 決まった並びを親へ返す。**描画の中で親の state を触らない**（無限ループになる）。
  //    並びが変わった時だけ1回知らせる。親はこれを「再生開始時に凍らせる」材料にする。
  const laneKeyStr = layout.laneIds ? layout.laneIds.join(' ') : '';
  useEffect(() => {
    if (typeof onLaneOrder === 'function') onLaneOrder(laneKeyStr ? laneKeyStr.split(' ') : []);
  }, [laneKeyStr, onLaneOrder]);

  // --- 予測の点線（選んだカードだけ） ------------------------------------
  const forecast = useMemo(() => {
    if (!selectedLotId || !layout.cards.length || width <= 0) return null;
    const card = layout.cards.find((c) => c.lot.lotId === selectedLotId);
    if (!card) return null;

    const fLots = Array.isArray(forecastSnapshot && forecastSnapshot.lots) ? forecastSnapshot.lots : null;
    if (!fLots) return null;
    const fLot = fLots.find((l) => l && l.lotId === selectedLotId) || null;

    const dayN = dayNoOf(forecastSnapshot.atMs, isNum(originMs) ? originMs : null);
    const when = dayN != null ? `${dayN}日目` : `${fmtMD(forecastSnapshot.atMs)}`;

    const x0 = card.left + layout.cardW / 2;
    let x1;
    let label;
    if (!fLot) {
      x1 = layout.dueX;
      label = `${when} 片付く見込み`;
    } else {
      const raw = isNum(fLot.duePosRatio) ? fLot.duePosRatio : null;
      // ⚠ カードと**同じ式**で出す（別々に計算すると点線の先だけずれる）。
      x1 = layout.leftAt0
        + clamp01(raw == null ? 0 : raw) * (layout.leftAt1 - layout.leftAt0)
        + layout.cardW / 2;
      const over = fLot.late === true || (raw != null && raw > 1);
      label = `${when} ${over ? '突破' : 'ここまで'}`;
    }
    const left = Math.round(Math.min(x0, x1));
    const w = Math.max(2, Math.round(Math.abs(x1 - x0)));
    // ⚠ 段が詰まっているので、点線はカードの**真ん中の高さ**へ通す。
    //   カードの下へ置くと、すぐ下の段のカードと札が重なって読めなくなる。
    return {
      left,
      width: w,
      top: card.top + Math.round(D.CARD_H / 2),
      label,
      labelLeft: Math.round(clamp(x1 - 24, D.LANE_GUTTER + 4, Math.max(D.LANE_GUTTER + 4, width - 116))),
    };
  }, [selectedLotId, layout, forecastSnapshot, width, originMs, D]);

  // 遅れて完了の棚の札。🚨 日数はここで計算しない（lateDone.js の同じ式1本）。並びは渡された順（遅れが大きい順）。
  const lateDoneItems = useMemo(() => {
    const rows = lateDone && Array.isArray(lateDone.rows) ? lateDone.rows : [];
    return rows.map((r) => ({
      key: r.lotId,
      main: `${r.model || '品目コードなし'}｜${r.tplName || 'テンプレ名なし'}`,
      badge: `+${r.daysLate}日`,
      days: typeof r.daysLate === 'number' ? r.daysLate : 0,
      sub: `${fmtMD(r.dueMs)}納期→${fmtMD(r.completedMs)}完了`,
      title: `${r.model || '品目コードなし'}｜${r.tplName || 'テンプレ名なし'}｜指図 ${r.orderNo || '—'}｜納期 ${fmtMD(r.dueMs)} より ${r.daysLate}日 遅れて ${fmtMD(r.completedMs)} に完了`,
    }));
  }, [lateDone]);

  const gridBg = {
    backgroundImage:
      'linear-gradient(rgba(100,116,139,.07) 1px, transparent 1px), linear-gradient(90deg, rgba(100,116,139,.07) 1px, transparent 1px)',
    backgroundSize: '42px 42px, 42px 42px',
  };

  const gc = layout.groupCounts;
  // 🚨 盤に出していない物を、必ずこの1行で数にして出す。
  const countLine = focusMoving
    ? `作業中 ${layout.heldCount || 0}件（上の作業者の帯）＋ ${periodWord}で動く ${layout.boardTotal}件 ／ まだ届いていない ${gc.notArrived}件 ／ 納期を過ぎた ${gc.breached}件・遅れて終わる見込み ${layout.lateForecastTotal}件（右の棚）`
    : `盤に ${layout.shown}件 ／ ${layout.total}件・まだ届いていない ${gc.notArrived}件 ／ 進んでいる ${gc.inPlay}件 ／ 納期を過ぎた ${gc.breached}件・遅れて終わる見込み ${layout.lateForecastTotal}件`;
  const noteLine = (() => {
    const parts = [];
    if (focusMoving && layout.overdueOnBoard > 0) {
      parts.push(`納期を過ぎた ${gc.breached}件のうち ${layout.overdueOnBoard}件は担当が付いているので作業者の帯にも出しています`);
    }
    if (layout.shown < layout.boardTotal) {
      parts.push(`盤に置けたのは ${layout.shown}件（残りは各レーンの下に件数で出しています）`);
    }
    // ⚠ ここへ「位置が出せません ◯件」を足すのは **やめた**（2026-08-30）。
    //   上の帯は高さ 66px(TOP_STRIP)で、その下 64px から作業者の帯が始まる。
    //   この行を伸ばすと帯が1行ぶん高くなり、z-40 の帯が作業者の帯へ被る＝
    //   いま直している「重なって読めない」を別の場所に作る事になる。
    //   件数と理由は盤の中の専用の柱に、札と重ならない形で出している。
    return parts.join(' ／ ');
  })();

  /* 🚨「今 何本中 何本見えています」（2026-09-01）。
   *   入れ物（見える窓）と 中身（描く全部）を分けた以上、**入り切らない事は必ず数で言う**。
   *   黙って縦に送れる形にすると、下に在る物が「無い」と読まれる。
   *   ⚠ 「見える」＝ 送らずにまるごと目に入る物だけ。半分だけの物は数えない。 */
  const seenLine = (() => {
    const all = Number(layout.laneTotal) || 0;
    const seen = Number(layout.visibleLanes) || 0;
    // ⚠ ここで言っている「入っています」は **この盤の窓** の話で、画面の話ではない。
    //   実測(1280×800): 盤の窓には8本ぶん入るが、盤そのものが画面の 684px から始まるので、
    //   ページを送らずに目に入るのは0本だった。だから文言に「盤の窓には」と必ず書く。
    //   ここを「見えています」とだけ書くと、私が数えた物より多く見えると読ませてしまう。
    if (!all) return { text: '', title: '', short: false };
    if (seen >= all) {
      return {
        text: `この盤の窓に レーン ${all}本ぜんぶ入っています`,
        title: '品目コードの行（レーン）が、盤の中を送らずに全部入っています。'
          + '\n盤そのものが画面からはみ出している時は、これより少なく目に入ります。'
          + '「⤢ 拡大」を押すと、盤だけを画面いっぱいにできます。',
        short: false,
      };
    }
    return {
      text: `この盤の窓に レーン ${all}本のうち ${seen}本ぶん（下へ送ると残りが出ます）`,
      title: '盤の中を下へ送ると残りが出ます。隠れているだけで、片付いたのではありません。'
        + '\n・「大きさ」を「小さく」にすると、一度に入る本数が増えます。'
        + '\n・盤そのものが画面からはみ出している時は、これより少なく目に入ります。'
        + '「⤢ 拡大」を押すと、盤だけを画面いっぱいにできます。',
      short: true,
    };
  })();

  return (
    <div
      className="flex w-full items-stretch gap-2"
      data-opsim-board=""
      /* 🚨 見張り(verify-opsim-horizon.mjs)がここを読む。
         「期間を変えると盤が受け取る日数が変わる」を **文字ではなく数** で確かめる為
         （文字で確かめると、言い回しを変えただけで見張りが赤／緑に化ける）。 */
      data-opsim-period-days={periodDays == null ? '' : String(periodDays)}
      data-opsim-period-word={periodWord}
    >
      {/* 🚨 T022: ここは以前 focus==='moving' の時だけ描いていた。
          実測(2026-08-23 本番)では **未完了282件のうち272件(96.5%)が到着待ち** で、
          手元にあるのは10件だけ。盤の主役を条件分岐の中に隠さない。
          focus='all' の時も出す（盤の左端に重なって置かれるのを防ぐ意味もある）。 */}
      <SideStrip
        height={layout.viewportH}
        tone="wait"
        title="これから届く"
        count={layout.incomingTotal}
        items={layout.incoming}
        emptyText="この時点で、まだ届いていない物はありません。"
        D={D}
      />

      {/* 🚨 入れ物（見える窓）。高さは親が渡した heightPx そのもの。
          中身が入り切らない時は **中の道だけ** が縦に送れる（上の帯は残る）。 */}
      <div
        className="relative min-w-0 flex-1 overflow-hidden rounded-xl border border-slate-200 bg-slate-100"
        style={{ height: layout.viewportH }}
      >
        <style>{BOARD_CSS}</style>

        {/* 上の帯: 見出し ＋ 件数の1行 ＋ 切替のピル。
            🚨 道の **外** に置く（縦に送っても消えない）。前は道と同じ長方形に描いていたので、
              盤が窓より高い時は帯ごと画面の外へ流れていた。
            ⚠ 入れ物は pointer-events-none。ピルだけ pointer-events-auto で押せるようにする。 */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 z-40 overflow-hidden bg-slate-100"
          style={{ height: layout.topStrip }}
        >
          <div className="pointer-events-none absolute" style={{ left: 8, top: 4, right: 96 }}>
            <div className="text-2xs font-bold leading-none tracking-wider text-slate-400">
              入ってくる仕事
            </div>
            <div className="mt-1 truncate text-2xs leading-none text-slate-500">{countLine}</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {/* 🚨 2026-09-15(清水さん 2026-09-03「盤の上に帯が何段も重なって盤が画面の下1割」):
                  盤の **中** の上の帯(TOP_STRIP 66px)にピルが7個並び、notext ではただの空の楕円7個。
                  主役の「この期間で動く物／全部」だけ残し、**見た目の設定** の2組は畳む。
                  🚨 1つも消していない。押せば今までのピルがそのまま出る。 */}
              <FocusPills value={focusMode} onChange={setFocusOverride} periodWord={periodWord} />
              <details className="pointer-events-auto">
                <summary className="inline-flex cursor-pointer select-none items-center gap-1 rounded-full border border-slate-300 bg-white px-2 py-1 text-2xs font-bold leading-none text-slate-500">
                  <Glyph kind="zone" className="w-3 h-3" title="並べ方と大きさ" />
                  並べ方・大きさ
                </summary>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <ZoomPills value={zoomKey} onChange={pickZoom} />
                  <SortPills
                    value={sortMode}
                    onChange={(v) => { if (typeof onSortMode === 'function') onSortMode(v); }}
                    highCount={layout.highCount}
                    frozen={Array.isArray(frozenLaneOrder) && frozenLaneOrder.length > 0}
                  />
                </div>
              </details>
              {/* 🚨 黙って隠さない。いま何本中 何本が目に入っているかを必ず数で出す。 */}
              <span className={`text-2xs leading-none ${seenLine.short ? 'text-amber-700' : 'text-slate-400'}`} title={seenLine.title}>
                {seenLine.text}
              </span>
              {layout.appendedLanes > 0 ? (
                <span className="text-2xs leading-none text-amber-700">
                  {`再生を始めた後に増えた品目コード ${layout.appendedLanes}種は、いちばん下に付けています`}
                </span>
              ) : null}
              {noteLine ? (
                <span className="truncate text-2xs leading-none text-slate-400">{noteLine}</span>
              ) : null}
            </div>
          </div>
          <div className="pointer-events-none absolute right-2 top-1.5 text-2xs font-bold tracking-wider text-rose-400">
            納期ゲート
          </div>
          {/* 2026-09-04: ここに在った作業者の帯(WorkerRail)は、道の先頭の作業者ごとのレーンへ移した（決まり15-1）。 */}
        </div>

        {/* 🚨 道（track）。**ここだけが縦に送れる**。
            ⚠ 幅を測るのはこの入れ物（カードが居るのはここ）。縦の送り帯のぶん、
              外側の箱より少し狭い＝外側で測ると札が納期ゲートへ食い込む。 */}
        <div
          ref={boardRef}
          className="absolute inset-x-0 bottom-0 overflow-y-auto overflow-x-hidden"
          style={{ top: layout.topStrip, ...gridBg }}
          data-opsim-track=""
        >
          <div className="relative" style={{ height: layout.trackContentH + D.BOTTOM_PAD }}>

        {/* 🚨 位置の出せない札の置き場（2026-08-24）。
            道の上に置くと「いま着いたばかり」と同じ見た目になるので、手前に分けて置く。
            🚨 件数と理由を必ず書く。黙って端へ寄せると「左に固まっている」としか読めない。

            🚨 2026-08-30 直し: 説明が札の下に潜って読めなかった。直した所は3つ。
              ① 入れ物の左端を 0 → LANE_GUTTER にした。
                 0 から描くと **レーン名の柱を丸ごう覆う**（半透明の板が上に乗るので
                 品目コード名が白っぽく沈む）。柱は柱として空ける。
              ② 説明に専用の柱(unknownLabelW)を作り、札はその右(unknownX)から置く。
                 これで札と説明は横に分かれ、どの段に札が入っても文字に被らない。
              ③ 入れ物の右端を「札の右端＋6px」に合わせた。前は leftAt0-10 で、
                 停めた札が入れ物からはみ出していた（囲いの意味が読めなかった）。 */}
        {layout.unknownCount > 0 && layout.unknownLabelW > 0 ? (
          <div
            className="pointer-events-none absolute z-10 border-r-2 border-dashed border-slate-300 bg-slate-50/70"
            style={{
              left: D.LANE_GUTTER,
              top: 0,
              width: Math.max(0, (layout.unknownX + layout.cardW + 6) - D.LANE_GUTTER),
              height: layout.trackContentH,
            }}
          >
            {/* 説明の柱。🚨 ここには札を1枚も置かない（unknownX がこの柱の右から始まる）。
                🚨 縦は **上に寄せる**。囲いは盤の高さぶん(数百px)あるので、中央に置くと
                  文字が下の方へ流れて、囲いの見出しとして読めなくなる。
                  1枚目の札と同じ高さに並ぶ＝「この囲いは何か」がその場で読める。 */}
            <div
              className="absolute flex flex-col"
              style={{ left: 4, top: 6, width: layout.unknownLabelW - 8 }}
            >
              <span className={`${D.text.lane} font-bold leading-tight text-slate-500`}>位置が出せません</span>
              <span className={`mt-0.5 ${D.text.model} font-black leading-none tabular-nums text-slate-600`}>{`${layout.unknownCount}件`}</span>
              <span className={`mt-1 ${D.text.lane} font-normal leading-tight text-slate-400`}>到着日か納期が入っていません</span>
            </div>
          </div>
        ) : null}

        {/* レーンの帯 */}
        {layout.lanes.map((l) => (
          <LaneBand
            key={l.id}
            top={l.top}
            height={l.height}
            label={l.label}
            tplLabel={l.tplLabel}
            hidden={l.hidden}
            D={D}
            kind={l.kind || 'model'}
            tone={l.tone || null}
            working={!!l.working}
            note={l.note || ''}
          />
        ))}

        {/* 🚨 2026-08-23（仕様書6.14-556〜560）: 固定の「最低ライン38%」「注意ライン64%」を撤去した。
            あの2本は **測った値ではない**（モックの絵をそのまま定数にした物）。
            線の手前か先かで札の色を変えていたので、遅れる見込みが無いカードにも
            「押し込まれる」が付いていた。
            残すのは **納期線1本だけ**。これは duePosRatio=1 の場所そのもの＝意味がある。
            色は下の statusOf が「遅れる見込みかどうか」で決める（位置では決めない）。 */}
        <GuardLine leftPct={LINE_PCT.due} top={0} height={layout.trackContentH} tone="due" label="納期線" />

        {/* 右端の納期ゲート（縦書き） */}
        <div
          className="pointer-events-none absolute rounded-t-xl border border-rose-200 bg-rose-50/80"
          style={{ right: D.GATE_R, top: 0, width: D.GATE_W, height: layout.trackContentH }}
        >
          {/* ⚠ 2026-09-01: 縦書きの「納期」は **上に寄せる**。
              道が縦に送れる様になって中身が 2,077px まで伸びたので、真ん中(top-1/2)に置くと
              1,038px の所＝最初は画面の外になる。ゲートの見出しとして読めなくなる。 */}
          <div
            className="absolute left-1/2 text-sm font-black text-rose-300"
            style={{ top: 8, transform: 'translateX(-50%)', writingMode: 'vertical-rl', letterSpacing: '0.24em' }}
          >
            納期
          </div>
        </div>

        {/* 予測の点線（選んだカードの、期間の終わりの位置まで） */}
        {forecast && (
          <ForecastPath
            left={forecast.left}
            top={forecast.top}
            width={forecast.width}
            label={forecast.label}
            labelLeft={forecast.labelLeft}
          />
        )}

        {/* 🚨 2026-08-24 是正: 担当者の札は **カードの右** に置く。
            清水さん「作業者が右側で左側の品目コードカードをつついてる」。
            前は左だけに置いていて、左に空きが無く **実質1枚も出ていなかった**
            （実測: 盤に19枚出ていて札は0枚）。
            右に置けない時だけ左へ逃がす。どちらも置けない時は出さない（重なるより良い）。 */}
        {layout.cards.map((c) => {
          if (!c.hasWorker) return null;
          const p = badgeSpotOf(c, layout.cardW, D);
          if (!p) return null;
          return (
            <EngagementBeam
              key={`beam-${c.lot.lotId}`}
              left={p.beamLeft}
              top={c.top + D.CARD_H / 2 - 1}
              width={p.beamW}
              tone={toneOf(workerColors, c.names[0])}
            />
          );
        })}

        {/* カード */}
        {layout.cards.map((c) => (
          <LotCard
            key={c.lot.lotId}
            card={c}
            cardW={layout.cardW}
            selected={c.lot.lotId === selectedLotId}
            onSelect={handleSelect}
            D={D}
          />
        ))}

        {/* 担当者の札（いま当たっている人）。カードの右どなりでつつく形。 */}
        {layout.cards.map((c) => {
          if (!c.hasWorker) return null;
          const p = badgeSpotOf(c, layout.cardW, D);
          if (!p) return null;
          return (
            <FighterBadge
              key={`badge-${c.lot.lotId}`}
              left={p.left}
              top={c.top + D.CARD_H / 2 - D.BADGE_H / 2}
              name={c.names[0]}
              extra={c.names.length - 1}
              tone={toneOf(workerColors, c.names[0])}
              side={p.side}
              D={D}
            />
          );
        })}

        {/* 🚨 2026-08-30 撤去: ここに「人が決まっていません」の赤い小札を
            **カード1枚につき1枚** 出していた（上限も間引きも無し）。
            夜に開くと誰も作業中ではないので、盤のカードが丸ごとこの一言で埋まっていた。
            いまは カードの担当の行の「○ 担当 未定」＋ 凡例1回 ＋ 引き出し（理由つき）。 */}

            {layout.empty && (
              <div className="absolute inset-x-0 top-0 flex items-start justify-center px-6 pt-6">
                <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-center text-xs text-slate-500 shadow-sm">
                  {layout.total > 0 && focusMoving
                    ? `${periodWord}で動く仕事はありません（まだ届いていない ${gc.notArrived}件 ／ 予定日を過ぎた ${gc.breached}件）。「全部」を押すと、その両方も盤に出ます。`
                    : '盤に出す仕事がありません。'}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 🚨 決まり15・10: 右の棚は1つ。上段＝納期を過ぎてまだ終わっていない物（+N日＝いまの時刻での遅れ）、
          下段＝遅れて完了した物（+N日＝納期→完了。完了しても消さない）。
          ⚠ 「全部」の見せ方でも棚は出す（納期を過ぎた事実の置き場は、見せ方で変わらない）。 */}
      <OverdueShelf
        height={layout.viewportH}
        overdueCount={layout.overdueTotal}
        overdueItems={layout.overdue}
        onBoardNote={focusMoving
          ? (layout.overdueOnBoard > 0 ? `うち ${layout.overdueOnBoard}件は作業中（上の作業者の帯にも）` : '')
          : '「全部」の見せ方では盤の右端にも出ています'}
        forecastCount={layout.lateForecastTotal}
        forecastItems={layout.lateForecast}
        forecastNote={layout.lateForecastCounts && layout.lateForecastCounts.finishMissing > 0
          ? `${periodWord}の中で終わりが出ない ${layout.lateForecastCounts.finishMissing}件（まだ届かない物など）は、この段では数えていません`
          : ''}
        lateDone={lateDone && Array.isArray(lateDone.rows) ? lateDone : null}
        lateDoneItems={lateDoneItems}
        D={D}
      />
    </div>
  );
}

export default Board;
