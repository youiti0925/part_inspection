// =============================================================================
//  rescueLadder.js — 「効く手」のはしご(残業・土曜で納期遅れが消えるか)
// -----------------------------------------------------------------------------
//  清水さん(2026-09-04 深夜・原文):
//    「残業したらとか土曜日でたら納期遅れが回避できるとかも見やすく表示できるといいな」
//
//  この画面が答える1行:
//    「いま遅れる◯件を、どの手で何件救えるか」
//
//  🚨 このファイルが守る決まり(決まり23)
//    ① **件数は必ず「本当に引き直した結果」から出す。引き算で作らない。**
//       1段 = 1回のシミュレーション。段の count は その段の simResult を
//       atRiskBreakdown に通した数 ただ1つ。基準の数から引いて作らない。
//       (引き算で作ると、割り当てが貪欲なせいで実際には減っていない物が
//        「減りました」と出る。2026-09-01 の「同じ言葉が2つの計算から出ていた」と同じ族)
//    ② **効かない手は「効きません」と出す。0件の段を隠さない。**
//       全部効かないなら「この4手では間に合いません」と言い切る。
//    ③ **同じ窓(実時刻の期間)でしか比べない。**
//       🚨 これが一番の落とし穴。予測範囲は **営業日** で数えるので、
//         土曜を営業日に足すと窓の端が **手前へ動く**(実測: 9/11 08:30 → 9/10 08:30)。
//         そのまま比べると「土曜に出ても働ける時間が1分も増えない」という
//         嘘の「効きません」が出る(実測: 140.0時間 → 140.0時間)。
//         窓の端を基準の段に揃えると 140.0時間 → 168.0時間 と、実際に増える。
//         → 段ごとの horizonDays は workdaysToReach で作り直す。
//    ④ **新しい計算を書かない。** 残業は policy.js(overtimeDirectMinutesPerDay)、
//       土曜は 工場の暦(factoryCalendar.js の 'work')。どちらも既にある入口だけを使う。
//    ⑤ **これは仮の計算**。残業も土曜も人の同意が要る。画面にその旨を必ず添える
//       (言葉は下の CAUTION_TEXT ただ1つ)。
//
//  ⚠ 純関数だけ。React / Firebase を読み込まない。
//    関数の中で現在時刻(Date.now)も乱数(Math.random)も取らない。時刻は必ず引数で受ける。
//
//  ⚠ 製品検査 と 最終検査 で **1バイトも違わない**(md5 一致)。
//    2つのアプリで違うのは「暦をどの口から渡すか」だけで、それは画面側の仕事。
// =============================================================================

import { atRiskBreakdown } from './atRisk.js';
import { makeCalendar } from './calendar.js';
import {
  DAY_WORK,
  dowOfYmd,
  isWorkdayYmd,
  normalizeCalendar,
  nextYmd,
  ymdOf,
} from '../factoryCalendar.js';

// ── 段の名前 ─────────────────────────────────────────────────────────────────

/** 段の鍵。文字列を各所で直書きしない。 */
export const RUNG_KEY = Object.freeze({
  BASE: 'base',
  OVERTIME: 'overtime',
  SATURDAY: 'saturday',
  BOTH: 'both',
});

/** 段の並び。**この順で必ず全部出す**(0件の段を隠さない = 決まり23②)。 */
export const RUNG_ORDER = Object.freeze([
  RUNG_KEY.BASE, RUNG_KEY.OVERTIME, RUNG_KEY.SATURDAY, RUNG_KEY.BOTH,
]);

/** 残業の刻み(分/日)の既定。画面が変えられる。上限は policy.js が持つ(ここでは決めない)。 */
export const DEFAULT_OVERTIME_EXTRA_MINUTES = 60;

/** 土曜を出勤にした時の一言。暦の登録画面に出る文と揃える。 */
export const SATURDAY_LABEL = '土曜に出る(仮の計算)';

/** 🚨 人の同意が要る事を必ず添える(決まり23⑤)。言い方はここ1か所。 */
export const CAUTION_TEXT = 'これは仮の計算です。実際に残業や土曜出勤をやるかは別の話です。';

/** 全部効かない時の言い切り(決まり23②)。 */
export const ALL_INEFFECTIVE_TEXT = 'この4手では間に合いません。';

/** 段の名前。残業の分数が入るので関数にしてある。 */
export function rungLabel(key, overtimeExtraMinutes = DEFAULT_OVERTIME_EXTRA_MINUTES) {
  const n = Math.trunc(Number(overtimeExtraMinutes));
  const ot = Number.isFinite(n) && n > 0 ? n : DEFAULT_OVERTIME_EXTRA_MINUTES;
  if (key === RUNG_KEY.BASE) return 'いまのまま';
  if (key === RUNG_KEY.OVERTIME) return `＋残業 +${ot}分/日`;
  if (key === RUNG_KEY.SATURDAY) return '＋土曜も出る';
  if (key === RUNG_KEY.BOTH) return '＋両方';
  return String(key == null ? '' : key);
}

// ── 小道具 ───────────────────────────────────────────────────────────────────

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);
const finite = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** 数え上げの止め。壊れた入力で永久に回らないため。 */
const MAX_DAY_STEPS = 400;

const median = (sorted) => {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** 最小 / 中央 / 最大。1件も無ければ null(0 で埋めない)。 */
const spread = (values) => {
  const nums = values.map(finite).filter((v) => v != null).sort((a, b) => a - b);
  if (!nums.length) return { n: 0, min: null, mid: null, max: null };
  return { n: nums.length, min: nums[0], mid: median(nums), max: nums[nums.length - 1] };
};

// ── ① 土曜を「出勤」として足した暦 ───────────────────────────────────────────

/**
 * 土曜を出勤にした暦を作る。
 *
 * 🚨 **新しい暦の仕組みを作らない**。祝日表と同じ入口(factoryCalendar.js の 'work')に
 *   1日ずつ書くだけ。だから登録画面・営業日の数え方・指紋の作り方が全部そのまま効く。
 *
 * 🚨 **既に登録されている日には触らない。**
 *   その土曜を人が「休み(off)」と決めているなら、それは工場の決めた休みなので
 *   はしごが勝手に出勤へ塗り替えない(塗り替えると、暦の登録が意味を失う)。
 *
 * @param {object|null} baseCalendar いま登録されている暦(どの形でも normalizeCalendar が読む)
 * @param {number} fromMs 期間の始まり(実時刻)
 * @param {number} toMs   期間の終わり(実時刻)
 * @param {string} [label] 足した日に付ける一言
 * @returns {{ calendar: {days:object, workdays:number[]}, added: string[], keptOff: string[] }}
 *   calendar … normalizeInput / makeIsWorkday へそのまま渡せる形
 *   added   … 出勤にした土曜('YYYY-MM-DD' の昇順)
 *   keptOff … 既に休みで登録されていて **触らなかった** 土曜
 */
export function saturdayWorkCalendar(baseCalendar, fromMs, toMs, label = SATURDAY_LABEL) {
  const from = finite(fromMs);
  const to = finite(toMs);
  const cal = normalizeCalendar(baseCalendar);
  const days = { ...cal.days };
  const added = [];
  const keptOff = [];
  if (from == null || to == null || from > to) {
    return { calendar: { days, workdays: [...cal.workdays] }, added, keptOff };
  }
  let cur = ymdOf(from);
  const end = ymdOf(to);
  let guard = 0;
  while (cur && cur <= end && guard < MAX_DAY_STEPS) {
    if (dowOfYmd(cur) === 6) {
      if (days[cur]) keptOff.push(cur);            // 登録済みの日は動かさない
      else { days[cur] = { type: DAY_WORK, label }; added.push(cur); }
    }
    cur = nextYmd(cur);
    guard += 1;
  }
  return { calendar: { days, workdays: [...cal.workdays] }, added, keptOff };
}

// ── ② 窓を揃えるための営業日数 ───────────────────────────────────────────────

/**
 * その暦で、fromMs の翌日から endMs の日まで **何営業日あるか**。
 *
 * 🚨 これが決まり23③ の要。予測範囲(horizonDays)は営業日で数えるので、
 *   土曜を足した段は同じ 5 を渡すと窓が **手前へ縮む**。
 *   基準の段の窓の端(endMs)に届く営業日数を段ごとに出し直して渡す事で、
 *   どの段も **同じ実時刻の期間** を見る。
 *
 * ⚠ 始まりの日そのものは数えない(normalizeInput の addWorkdays が
 *   「翌日から n 営業日ぶん進める」形なので、それに合わせる)。
 *
 * @returns {number} 0以上の整数
 */
export function workdaysToReach(fromMs, endMs, calendar) {
  const from = finite(fromMs);
  const end = finite(endMs);
  if (from == null || end == null || end <= from) return 0;
  const startYmd = ymdOf(from);
  const endYmd = ymdOf(end);
  let cur = startYmd;
  let n = 0;
  let guard = 0;
  while (guard < MAX_DAY_STEPS) {
    cur = nextYmd(cur);
    guard += 1;
    if (!cur || cur > endYmd) break;
    if (isWorkdayYmd(cur, calendar)) n += 1;
  }
  return n;
}

// ── ③ 段の作り方(何を変えるか) ──────────────────────────────────────────────

/**
 * 4つの段の「何を変えるか」を作る。**計算はしない**(呼ぶ側が引き直す)。
 *
 * @param {object} o
 * @param {object|null} o.baseCalendar いま登録されている工場の暦
 * @param {number} o.nowMs        基準時刻
 * @param {number} o.windowEndMs  基準の段の窓の端(normalized.horizonEnd)
 * @param {number} [o.overtimeExtraMinutes] 残業の刻み(分/日)
 * @returns {Array<{key,label,horizonDays,scenarioPatch,factoryCalendar,saturdaysAdded,saturdaysKeptOff}>}
 *   scenarioPatch   … scenario へ重ねる物(残業)
 *   factoryCalendar … 暦(土曜)。⚠ 製品は scenario.factoryCalendar、最終は payload.factoryCalendar の口。
 *                     どちらの口へ入れるかは **画面側** が決める(アプリで口が違うため)。
 */
export function buildRungPlans({
  baseCalendar = null,
  nowMs,
  windowEndMs,
  overtimeExtraMinutes = DEFAULT_OVERTIME_EXTRA_MINUTES,
} = {}) {
  const now = finite(nowMs);
  const endMs = finite(windowEndMs);
  const otRaw = Math.trunc(Number(overtimeExtraMinutes));
  const ot = Number.isFinite(otRaw) && otRaw > 0 ? otRaw : DEFAULT_OVERTIME_EXTRA_MINUTES;
  if (now == null || endMs == null) return [];

  const sat = saturdayWorkCalendar(baseCalendar, now, endMs, SATURDAY_LABEL);
  const daysPlain = workdaysToReach(now, endMs, baseCalendar);
  const daysSat = workdaysToReach(now, endMs, sat.calendar);

  const mk = (key, useOvertime, useSaturday) => ({
    key,
    label: rungLabel(key, ot),
    // 🚨 段ごとに営業日数を作り直す。これが無いと土曜の段だけ窓が縮む(決まり23③)。
    horizonDays: useSaturday ? daysSat : daysPlain,
    scenarioPatch: useOvertime ? { overtimeExtraMinutes: ot } : {},
    factoryCalendar: useSaturday ? sat.calendar : (baseCalendar || null),
    saturdaysAdded: useSaturday ? [...sat.added] : [],
    saturdaysKeptOff: useSaturday ? [...sat.keptOff] : [],
  });

  return [
    mk(RUNG_KEY.BASE, false, false),
    mk(RUNG_KEY.OVERTIME, true, false),
    mk(RUNG_KEY.SATURDAY, false, true),
    mk(RUNG_KEY.BOTH, true, true),
  ];
}

// ── ④ 引き直した結果を読む ───────────────────────────────────────────────────

/**
 * その期間に **その人が実際に働ける分数**。
 * 🚨 式は calendar.js の workMsBetween ただ1本(simulate.js が使っている物と同じ)。
 *   ここで勤務表を読み直したり分×人×日を掛け算したりしない
 *   (休みの人を数え落とす／二重に数える形が復活する)。
 * @returns {number|null} 分。暦が作れなければ null(0 にしない = 「測れない」と「0」を混ぜない)
 */
export function workableMinutesOf(normalized, fromMs, toMs) {
  if (!isObj(normalized) || !isObj(normalized.calendarSpec)) return null;
  const from = finite(fromMs);
  const to = finite(toMs);
  if (from == null || to == null || to <= from) return null;
  let cal;
  try { cal = makeCalendar(normalized.calendarSpec); } catch { return null; }
  if (!cal || typeof cal.workMsBetween !== 'function') return null;
  let ms = 0;
  for (const w of arr(normalized.workers)) {
    const name = w && w.name ? String(w.name) : '';
    if (!name) continue;
    try { ms += Number(cal.workMsBetween(from, to, name)) || 0; } catch { /* 1人で全体を止めない */ }
  }
  return Math.round(ms / 60000);
}

/**
 * 1段ぶんの測り直し。**ここだけが件数を作る。**
 *
 * 🚨 count は `atRiskBreakdown(simResult).count` ただ1つ。
 *   基準の数から引いて作らない(決まり23①)。
 * 🚨 「この先で遅れる」と「納期があるのに手が付かない」と「すでに納期を過ぎた」を
 *   1つの数に混ぜない(2026-08-22)。3つとも別の欄で持つ。
 *
 * @param {object} run { key, label, normalized, simResult, tookMs, horizonDays }
 * @param {number} nowMs 基準時刻(働ける分数を測る窓の始まり)
 * @returns {object} 段の測定値。simResult が無ければ measured:false(数字を作らない)
 */
export function measureRun(run, nowMs) {
  const r = isObj(run) ? run : {};
  const key = String(r.key == null ? '' : r.key);
  const normalized = isObj(r.normalized) ? r.normalized : null;
  const sim = isObj(r.simResult) ? r.simResult : null;
  const windowEndMs = normalized ? finite(normalized.horizonEnd) : null;

  if (!sim) {
    return {
      key,
      label: String(r.label == null ? '' : r.label),
      measured: false,
      count: null,
      forecastLate: null,
      unresolvedDue: null,
      alreadyPastDue: null,
      lotIds: [],
      finishByLot: new Map(),
      dueByLot: new Map(),
      workersByLot: new Map(),
      directMinutesPerDay: null,
      workableMinutes: null,
      windowEndMs,
      horizonDays: finite(r.horizonDays),
      tookMs: finite(r.tookMs),
      evidence: { lotResults: 0, unresolved: 0 },
    };
  }

  const br = atRiskBreakdown(sim);
  const rows = arr(sim.lotResults).filter(isObj);
  const finishByLot = new Map();
  const dueByLot = new Map();
  // 「誰が」やる事になったか(決まり23④: 件数だけでは決められない)。
  // 🚨 割付の結果(assignments)から読むだけ。ここで担当を決め直さない。
  const workersByLot = new Map();
  arr(sim.assignments).filter(isObj).forEach((a) => {
    if (a.lotId == null) return;
    const id = String(a.lotId);
    let set = workersByLot.get(id);
    if (!set) { set = []; workersByLot.set(id, set); }
    [a.worker, a.partner].forEach((nm) => {
      const s = nm == null ? '' : String(nm);
      if (s && !set.includes(s)) set.push(s);
    });
  });
  let alreadyPastDue = 0;
  rows.forEach((row) => {
    if (row.lotId == null) return;
    const id = String(row.lotId);
    finishByLot.set(id, finite(row.finishMs));
    dueByLot.set(id, finite(row.dueLineMs));
    if (row.alreadyPastDue === true) alreadyPastDue += 1;
  });

  return {
    key,
    label: String(r.label == null ? '' : r.label),
    measured: true,
    // 🚨 引き直した結果 ただ1つから出す数。
    count: br.count,
    forecastLate: br.forecastLateLotIds.size,
    unresolvedDue: br.unresolvedDueLotIds.size,
    alreadyPastDue,
    lotIds: [...br.lotIds].sort(),
    finishByLot,
    dueByLot,
    workersByLot,
    directMinutesPerDay: normalized && isObj(normalized.calendarSpec)
      ? finite(normalized.calendarSpec.directMinutesPerDay) : null,
    workableMinutes: workableMinutesOf(normalized, nowMs, windowEndMs),
    windowEndMs,
    horizonDays: finite(r.horizonDays),
    tookMs: finite(r.tookMs),
    // 🚨 「本当に引き直した」の裏取り。0件なら画面は数字を出してはいけない。
    evidence: { lotResults: rows.length, unresolved: arr(sim.unresolved).length },
  };
}

// ── ⑤ はしごを組む ──────────────────────────────────────────────────────────

/**
 * はしご全体。
 *
 * @param {object} o
 * @param {Array} o.runs 段ごとの { key, label, normalized, simResult, tookMs, horizonDays }
 * @param {number} o.nowMs 基準時刻
 * @param {Map|object} [o.lotsById] ロットの素(型式・特注仕様/テンプレ・指図・納期を出すため)
 * @returns {object} 画面がそのまま描ける形
 */
export function buildLadder({ runs = [], nowMs, lotsById = null } = {}) {
  const now = finite(nowMs);
  const measured = arr(runs).map((r) => measureRun(r, now));
  const byKey = new Map(measured.map((m) => [m.key, m]));
  const base = byKey.get(RUNG_KEY.BASE) || null;

  // 🚨 同じ窓でしか比べない(決まり23③ / scenarios.js ①)。
  //   窓の端が1つでも違えば **差の数字を作らない**。
  const ends = measured.filter((m) => m.measured).map((m) => m.windowEndMs);
  const sameWindow = ends.length > 0 && ends.every((e) => e != null && e === ends[0]);
  const windowEndMs = sameWindow ? ends[0] : null;

  const lotOf = (id) => {
    if (!id) return null;
    if (lotsById instanceof Map) return lotsById.get(id) || null;
    if (isObj(lotsById)) return lotsById[id] || null;
    return null;
  };

  const maxCount = measured.reduce((a, m) => (m.measured && m.count > a ? m.count : a), 0);

  const rungs = measured.map((m) => {
    const isBase = m.key === RUNG_KEY.BASE;
    const canCompare = !!(base && base.measured && m.measured && sameWindow);
    const baseSet = base && base.measured ? new Set(base.lotIds) : null;
    const mySet = m.measured ? new Set(m.lotIds) : null;

    // 救えた = 基準では危険だったが、この段では危険でなくなったロット。
    // 🚨 どちらの集合も **それぞれ引き直した結果** から出ている(引き算で件数を作っていない)。
    const savedLotIds = (canCompare && !isBase)
      ? base.lotIds.filter((id) => !mySet.has(id)) : [];
    // 🚨 逆に **新たに危険になった** 物も必ず出す(消さない)。貪欲な割り当ては
    //   選べる時間が増えただけで別の順路へ行く事がある。隠すと「良くなった」だけの嘘になる。
    const newlyAtRiskLotIds = (canCompare && !isBase)
      ? m.lotIds.filter((id) => !baseSet.has(id)) : [];

    // 終わる時刻が早まったロット(基準と比べる)。件数は救えた数とは別物。混ぜない。
    const gains = [];
    let earlierFinish = 0;
    if (canCompare && !isBase) {
      m.finishByLot.forEach((fin, id) => {
        const bf = base.finishByLot.get(id);
        if (fin == null || bf == null) return;
        if (fin < bf) { earlierFinish += 1; gains.push((bf - fin) / 3600000); }
      });
    }

    const savedCount = savedLotIds.length;
    return {
      key: m.key,
      label: m.label,
      measured: m.measured,
      count: m.count,
      forecastLate: m.forecastLate,
      unresolvedDue: m.unresolvedDue,
      alreadyPastDue: m.alreadyPastDue,
      // 棒の長さ。文字を読まなくても段ごとの長短が分かる形(決まり23 の採点)。
      barRatio: (m.measured && maxCount > 0) ? (m.count / maxCount) : 0,
      savedCount: isBase ? null : (canCompare ? savedCount : null),
      // 🚨 0件を隠さない。効かない手は「効きません」と言う。
      effect: isBase ? null : (canCompare ? (savedCount > 0 ? `−${savedCount}件` : '効きません') : '比べられません'),
      effective: isBase ? null : (canCompare ? savedCount > 0 : null),
      // 🚨 「誰が」を必ず添える。担当が付いていなければ **空のまま**(名前を作らない)。
      savedLots: savedLotIds.map((id) => ({
        lotId: id, lot: lotOf(id), workers: m.workersByLot.get(id) || [],
      })),
      newlyAtRiskLots: newlyAtRiskLotIds.map((id) => ({
        lotId: id, lot: lotOf(id), workers: m.workersByLot.get(id) || [],
      })),
      newlyAtRiskCount: isBase ? null : (canCompare ? newlyAtRiskLotIds.length : null),
      earlierFinishCount: isBase ? null : (canCompare ? earlierFinish : null),
      gainHours: isBase ? null : spread(gains),
      directMinutesPerDay: m.directMinutesPerDay,
      workableMinutes: m.workableMinutes,
      // 基準より働ける時間がどれだけ増えたか(手が「何かをした」事の証拠)。
      extraWorkableMinutes: (!isBase && canCompare
        && m.workableMinutes != null && base.workableMinutes != null)
        ? m.workableMinutes - base.workableMinutes : null,
      horizonDays: m.horizonDays,
      windowEndMs: m.windowEndMs,
      tookMs: m.tookMs,
      evidence: m.evidence,
    };
  });

  // 基準の段で危険なロットが「どれだけ遅れるか」。手の効き目(gainHours)と並べて見る為。
  const lateHours = [];
  let lateUnmeasurable = 0;
  if (base && base.measured) {
    base.lotIds.forEach((id) => {
      const fin = base.finishByLot.get(id);
      const due = base.dueByLot.get(id);
      if (fin == null || due == null) { lateUnmeasurable += 1; return; }
      lateHours.push((fin - due) / 3600000);
    });
  }

  const others = rungs.filter((r) => r.key !== RUNG_KEY.BASE);
  const comparable = others.length > 0 && others.every((r) => r.savedCount != null);
  const allIneffective = comparable && others.every((r) => r.savedCount === 0);
  const best = comparable
    // 🚨 comparable の時だけここへ来る＝savedCount は全件 null でない（|| 0 で「分かりません」を0に潰さない）
    ? others.reduce((a, b) => (b.savedCount > a.savedCount ? b : a), others[0])
    : null;

  return {
    rungs,
    base,
    sameWindow,
    windowEndMs,
    comparable,
    allIneffective,
    bestKey: (best && best.savedCount > 0) ? best.key : null,
    lateHours: spread(lateHours),
    lateUnmeasurableCount: lateUnmeasurable,
    totalMs: measured.reduce((a, m) => a + (m.tookMs || 0), 0),
    cautionText: CAUTION_TEXT,
  };
}

/**
 * はしごの一言。**数字を作らず、組んだ物から言い直すだけ。**
 * 🚨 全部効かない時に黙らない。「この4手では間に合いません」と言い切る(決まり23②)。
 */
export function ladderVerdict(ladder) {
  const L = isObj(ladder) ? ladder : {};
  if (!L.base || !L.base.measured) return { tone: 'unknown', text: 'まだ引き直していません。' };
  if (!L.sameWindow) {
    return { tone: 'unknown', text: '段ごとに見ている期間が違うので、差の数字は出しません。' };
  }
  const n = L.base.count;
  if (n === 0) return { tone: 'ok', text: 'いまのままで、この期間に納期を越えるロットはありません。' };
  if (!L.comparable) return { tone: 'unknown', text: `いま ${n}件が危険です。手の効き目はまだ引き直していません。` };
  if (L.allIneffective) {
    return { tone: 'bad', text: `いま ${n}件が危険です。${ALL_INEFFECTIVE_TEXT}` };
  }
  const best = arr(L.rungs).find((r) => r.key === L.bestKey);
  if (!best) return { tone: 'unknown', text: `いま ${n}件が危険です。` };
  const left = best.count;
  return {
    tone: left === 0 ? 'ok' : 'warn',
    text: `いま ${n}件が危険です。「${best.label}」で ${best.savedCount}件 救えて、残り ${left}件です。`,
  };
}

export default buildLadder;
