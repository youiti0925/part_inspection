// ============================================================================
// 🚚 入荷の遅れのクセ — 班ごとに「教えてもらった時刻から どれだけ ずれて着いたか」
// ----------------------------------------------------------------------------
// 清水さん(2026-09-07):「実際の生産に近い状態でシミュレーションしたい」
//
// 🚨 いまの割付は **組立から知らせてもらった到着予定は必ずその通りに来る** 前提で山を積む
//   (normalizeInput.js の scheduledArrivalMs / arrivalMs)。現物は班ごとにクセが在る。
//   清水さん(2026-08-01)「あの班の到着時間予定は、だいたい30分後にくるかなとかわかったらいい」。
//
// ⚠⚠ 数え方は既に在る物を使う(src/domain/arrivalActual.js)。
//   ・ずれの向き(＋遅れ / −早い)  … diffMinutes / actualDiffMin
//   ・班ごとの中央値・p25・p75    … groupTrends(中央値。平均は1回の3時間遅れで嘘になる)
//   ・件数が足りているか          … MIN_SAMPLES(既定5件)
//   ここで新しく作るのは「シミュへ渡す形」と「予定を何分ずらすか」だけ。
//
// ── 本番の写しで実測(2026-09-10_0100 の控え・製品検査) ──────────────────────
//   arrival_actuals(着いたを押した記録)          … 8件
//   予定と実績の対がある(両方の時刻が入っている) … 8件 / 8件
//   🚨 **その8件とも ずれ 0分**。actualTs が plannedTs と1ミリ秒も違わない。
//      押した時刻(at)は予定より +114分〜+6561分・−519分 と散らばっているので、
//      「予定どおり」の押し方(ArrivalCheck.jsx の『予定どおり』)で入った記録ばかり。
//      → 班ごとの中央値は 高木班 6件で 0分・南班 2件で 0分。
//        つまり **いまの写しからは「遅れのクセ」を1つも読み取れない**。
//   到着チェック画面は 2026-08-05 から封印中(App.jsx ARRIVAL_CHECK_ENABLED=false)。
//   封印のあいだ新しい記録は1件も貯まらない。清水さんの判断が要る(下の warnings に出す)。
//
//   contact_requests 62件 … 到着の時刻を持つ鍵は0件(kind は call/complete/repair だけ)。
//     使い道は「班が空の記録に lotId から班名を補う」だけ。写しでは補う必要が 0件 / 8件。
//   arrival_times 86件 … 到着予定そのもの。applied.entryAt は 85件とも date+time と一致(=予定)。
//     いま到着エリアに居るロット160件のうち、arrival_times で班が分かる物は **0件**。
//     → 班が分からない予定は動かさない(既定)ので、いまの写しでは 0件 が動く。
//
// ⚠⚠ 決めるのは人。ここは「過去はこうだった」を出すだけ。
//   ・mode の既定は 'off'。**渡されなければ1ミリ秒も動かさない**。
//   ・件数が足りない班は enough:false。少ない回数で「この班は30分遅い」と決めつけない。
//   ・ずらすのは **予定** だけ。**実際に着いた記録が在る物は動かさない**(arrived:true)。
//   ・元の予定は書き換えない。戻り値の ms を使うかどうかは呼ぶ側が決める。
// ⚠この数字は見た人には班の成績に見える。人数の少ない班では個人の話になり得る。
//   組立には見せない(置き場所は検査アプリ自身の arrival_actuals のまま)。
// ⚠ここには React も firebase も import しない (node --test で回すため)。
// ⚠関数の中で今の時刻や乱数を読まない。同じ入力なら毎回同じ答え。
// ============================================================================

import {
  actualDiffMin, groupTrends, trendLabel, actualsByKey, isChecked, MIN_SAMPLES,
} from '../arrivalActual.js';

/** ずらし方。⚠既定は off(1ミリ秒も動かさない)。 */
export const HABIT_MODE = Object.freeze({
  OFF: 'off',        // 使わない。教えてもらった予定のまま
  MEDIAN: 'median',  // だいたいの姿(中央値ぶんずらす)
  P75: 'p75',        // 悪い方に寄せる(4回に1回はこれより遅い、という側)
});

/** 班が分からない記録の置き場。⚠arrivalActual.groupTrends と同じ札にする(2つに割れない為)。 */
export const UNKNOWN_GROUP = '(班なし)';

/** 全部をひとまとめにした行の札。⚠班名と衝突しないよう括弧付き。 */
export const ALL_GROUP = '(全体)';

/** 何件から傾向を出すか。⚠arrivalActual の決まりをそのまま使う(2箇所で別の数にしない)。 */
export const MIN_SAMPLES_DEFAULT = MIN_SAMPLES;

/** 「ほぼ時間どおり」とみなす幅(分)。⚠arrivalActual.groupTrends の既定と揃える。 */
export const ON_TIME_WITHIN_MIN = 10;

const asArray = (v) => (Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : []));
const trim = (v) => String(v == null ? '' : v).trim();

/**
 * 連絡(contact_requests)から lotId → 班 を作る。
 * ⚠**宛先が1つに決まる時だけ** 使う。同じロットに2つの班が出てくる物は補わない
 *   (どちらから来たのか分からない物を、片方に決めつけない)。
 * ⚠ここでは到着の時刻は1つも作らない。連絡には到着の時刻が入っていないため
 *   (写しで実測: 到着の時刻を持つ連絡 0件 / 62件)。
 */
export const groupByLotFromRequests = (requests) => {
  const seen = new Map();
  for (const r of asArray(requests)) {
    const lotId = trim(r && r.lotId);
    const to = trim(r && r.to);
    if (!lotId || !to) continue;
    let set = seen.get(lotId);
    if (!set) { set = new Set(); seen.set(lotId, set); }
    set.add(to);
  }
  const out = {};
  for (const [lotId, set] of seen) { if (set.size === 1) out[lotId] = [...set][0]; }
  return out;
};

/**
 * 予定と実績の「対」を取り出す。
 * @param actuals  arrival_actuals の一覧(plannedTs / actualTs / group を持つ物)
 * @param requests contact_requests の一覧(班が空の時だけ補うのに使う)
 * @returns [{ lotId, date, time, group, plannedTs, actualTs, diffMin, groupFilled }]
 *   diffMin … ＋遅れ / −早い(arrivalActual.diffMinutes と同じ向き)
 * ⚠ 片方の時刻しか無い記録は対にならない。数に入れない(0分として数えない)。
 */
export const arrivalPairsOf = ({ actuals = [], requests = [] } = {}) => {
  const filler = groupByLotFromRequests(requests);
  const out = [];
  for (const r of asArray(actuals)) {
    const diffMin = actualDiffMin(r);
    if (diffMin == null) continue;          // 予定か実績のどちらかが入っていない
    const lotId = trim(r && r.lotId);
    const own = trim(r && r.group);
    const filled = !own && lotId && filler[lotId] ? filler[lotId] : '';
    out.push({
      lotId,
      date: trim(r && r.date),
      time: trim(r && r.time),
      group: own || filled || UNKNOWN_GROUP,
      plannedTs: Number(r && r.plannedTs) || 0,
      actualTs: Number(r && r.actualTs) || 0,
      diffMin,
      groupFilled: !!filled,
    });
  }
  return out;
};

/** groupTrends の1行を、シミュへ渡す形に直す。⚠単位を名前に入れる(分だと分かるように)。 */
const toEntry = (t) => ({
  group: t.group,
  n: t.n,
  medianMin: t.median,
  p25Min: t.p25,
  p75Min: t.p75,
  onTime: t.onTime,
  late: t.late,
  early: t.early,
  enough: t.enough,
});

/** 件数が足りていない時の空の行。⚠数字を作らない(null のまま)。 */
const emptyEntry = (group) => ({
  group, n: 0, medianMin: null, p25Min: null, p75Min: null,
  onTime: 0, late: 0, early: 0, enough: false,
});

/**
 * 班ごとのクセを作る。
 * @returns {
 *   byGroup: { [班]: { group, n, medianMin, p25Min, p75Min, onTime, late, early, enough } },
 *   all:     同じ形(全部をひとまとめ),
 *   minSamples, pairs, warnings: string[]
 * }
 * ⚠ n が minSamples 未満の班は enough:false。呼ぶ側はこの班のクセを使わない。
 * ⚠ warnings は画面にそのまま出す文。数字は必ずここで数えた物から作る(手書きしない)。
 */
export const buildArrivalHabit = ({ actuals = [], requests = [], minSamples = MIN_SAMPLES_DEFAULT, onTimeWithinMin = ON_TIME_WITHIN_MIN } = {}) => {
  const min = Number.isInteger(minSamples) && minSamples >= 1 ? minSamples : MIN_SAMPLES_DEFAULT;
  const pairs = arrivalPairsOf({ actuals, requests });

  const trends = groupTrends({ rows: pairs, minSamples: min, onTimeWithinMin });
  const byGroup = {};
  for (const t of trends) byGroup[t.group] = toEntry(t);

  const allRows = pairs.map((p) => ({ ...p, group: ALL_GROUP }));
  const allTrend = groupTrends({ rows: allRows, minSamples: min, onTimeWithinMin })[0];
  const all = allTrend ? toEntry(allTrend) : emptyEntry(ALL_GROUP);

  const warnings = [];
  if (pairs.length === 0) {
    warnings.push('到着の記録が1件もありません。到着予定はそのままの時刻で計算します。');
  } else {
    if (pairs.every((p) => p.diffMin === 0)) {
      warnings.push(
        `予定と実績のずれが ${pairs.length}件とも 0分でした。`
        + '「予定どおり」の押し方で入った記録ばかりだと、この形になります。'
        + '着いた時刻を押して記録するまで、クセは読み取れません。',
      );
    }
    const short = trends.filter((t) => !t.enough).map((t) => `${t.group} ${t.n}件`);
    if (short.length) {
      warnings.push(`記録が ${min}件に届かない班が ${short.length}班あります（${short.join('・')}）。この班は予定を動かしません。`);
    }
    const unknown = pairs.filter((p) => p.group === UNKNOWN_GROUP).length;
    if (unknown) warnings.push(`どの班から来たのか分からない記録が ${unknown}件あります。`);
  }

  return { byGroup, all, minSamples: min, pairs: pairs.length, warnings };
};

/** そのクセで何分ずらすか。⚠ mode が median/p75 以外なら null(=ずらさない)。 */
export const habitShiftMinutes = (entry, mode) => {
  if (!entry || !entry.enough) return null;
  const v = mode === HABIT_MODE.MEDIAN ? entry.medianMin
    : mode === HABIT_MODE.P75 ? entry.p75Min
      : null;
  return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
};

/**
 * 到着予定を「班のクセ」ぶんだけずらす。
 * @param scheduledMs 教えてもらった到着予定(ms)
 * @param group  その予定を知らせてきた班
 * @param habit  buildArrivalHabit の戻り
 * @param mode   'off'(既定) | 'median' | 'p75'
 * @param arrived  もう実際に着いた記録が在るか。🚨true なら1ミリ秒も動かさない
 * @param useAllWhenGroupUnknown 班のクセが無い時に全体のクセを使うか(既定 false)
 * @returns { ms, applied, why, shiftMin, source }
 *   ms       … ずらしたあとの時刻。動かさなかった時は **渡された値をそのまま返す**
 *   applied  … 実際に時刻が動いたか(0分のクセは false。何件動いたかを数える為)
 *   source   … 'group' | 'all' | null(クセを見ていない)
 *   why      … 'off' / 'noHabit' / 'noSchedule' / 'arrived' / 'noGroup' / 'notEnough'
 *              / 'noValue' / 'zero' / 'median' / 'p75'
 * 🚨 渡されなければ1行も動かない: mode の既定は 'off'、habit が無ければ素通り。
 */
export const applyArrivalHabit = (scheduledMs, { group = '', habit = null, mode = HABIT_MODE.OFF, arrived = false, useAllWhenGroupUnknown = false } = {}) => {
  const pass = (why, source = null) => ({ ms: scheduledMs, applied: false, why, shiftMin: 0, source });

  if (mode !== HABIT_MODE.MEDIAN && mode !== HABIT_MODE.P75) return pass('off');
  if (!habit || typeof habit !== 'object') return pass('noHabit');

  const base = Number(scheduledMs);
  if (!Number.isFinite(base) || base <= 0) return pass('noSchedule');

  // 🚨 もう着いている物の時刻は事実。クセで動かしたら嘘になる。
  if (arrived) return pass('arrived');

  const g = trim(group);
  const byGroup = habit.byGroup || {};
  const own = g ? byGroup[g] : null;

  let entry = null;
  let source = null;
  if (own && own.enough) { entry = own; source = 'group'; }
  else if (useAllWhenGroupUnknown && habit.all && habit.all.enough) { entry = habit.all; source = 'all'; }
  else if (own) return pass('notEnough');
  else return pass('noGroup');

  const shiftMin = habitShiftMinutes(entry, mode);
  if (shiftMin == null) return pass('noValue', source);
  if (shiftMin === 0) return { ms: base, applied: false, why: 'zero', shiftMin: 0, source };

  return { ms: base + shiftMin * 60000, applied: true, why: mode, shiftMin, source };
};

/** 動かさなかった理由の言い方。⚠画面にそのまま出す。責める言い方にしない。 */
export const habitWhyLabel = (why) => ({
  off: '到着のクセは使っていません',
  noHabit: '過去の到着の記録がありません',
  noSchedule: '到着予定の時刻が入っていません',
  arrived: 'もう着いた記録があるので、その時刻のままです',
  noGroup: 'どの班から来るのか分からないため、そのままです',
  notEnough: '記録の数が足りないため、そのままです',
  noValue: 'ずらす分数が出せないため、そのままです',
  zero: 'この班はだいたい時間どおりなので、そのままです',
  median: 'この班のだいたいのずれを足しました',
  p75: 'この班の遅い側のずれを足しました',
}[why] || '');

/**
 * もう着いた記録が在るか。⚠arrivalActual の鍵の作り方をそのまま使う(2通りの鍵を作らない)。
 * @param actuals arrival_actuals の一覧、または actualsByKey で作った map
 */
export const arrivedAlready = ({ actuals = null, lotId = '', date = '', time = '' } = {}) => {
  const map = Array.isArray(actuals) ? actualsByKey(actuals) : (actuals || {});
  return isChecked(map, lotId, date, time);
};

/**
 * 画面に出す1行(班ごと)。⚠数字は全部 buildArrivalHabit が数えた物から作る(手書きしない)。
 * ⚠件数が足りない班も **行としては出す**。消すと「その班は記録が無い」事が見えなくなる。
 */
export const arrivalHabitRows = (habit, mode = HABIT_MODE.MEDIAN) => {
  const byGroup = (habit && habit.byGroup) || {};
  const min = (habit && habit.minSamples) || MIN_SAMPLES_DEFAULT;
  return Object.values(byGroup).map((e) => {
    const shiftMin = habitShiftMinutes(e, mode);
    return {
      ...e,
      shiftMin,
      label: e.enough ? trendLabel({ enough: true, median: e.medianMin }) : '',
      note: e.enough
        ? `過去 ${e.n}回。ほぼ時間どおり ${e.onTime}回・遅れ ${e.late}回・早い ${e.early}回（振れ幅 ${e.p25Min}分〜${e.p75Min}分）`
        : `過去 ${e.n}回。${min}回に届かないため、この班の予定は動かしません`,
    };
  }).sort((a, b) => (b.n - a.n) || String(a.group).localeCompare(String(b.group), 'ja'));
};
