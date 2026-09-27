// =============================================================================
//  operationsSimulation/sharedWorker.js — 両方の工場で働ける人(決まり30・2026-09-05)。純関数だけ
// -----------------------------------------------------------------------------
//  清水さん(2026-09-04 深夜・原文):
//    「最終検査と製品検査で同じ人材の名前で村さんって人がいて、唯一どっちも作業ができるスキルがある。
//      負荷によって最終検査で働いたり、製品検査で働いたりしているのが現状。
//      とりあえず村さんを負荷によって移動させてどうやって回すかシミュレーションできるようにするのを優先。
//      両方のアプリに同じ名前の人が出てきたら、両方できる人として扱えばいい」
//  実データ(2026-08-30 の写し): 製品=尾田・村・片山・信濃 / 最終=坂井・平野・村。重なりは「村」1人。
//
//  答える1行:「今週、この人はどちらの工場に居るべきか」
//  やる事(この工場の中で言える所まで):
//    ① 両方の名簿に **同じ名前** が在る人 = 両方で働ける人(名前の一致で決める。対応表は要らない)
//    ② その人を「この工場に置く」「向こうに置く(=ここでは期間まるごと休み)」の2通りで **実際に割付を引き直す**
//       (引き算で作らない。既存の休みの口 scenario.absences を使う。新しい計算を書かない)
//    ③ 遅れの件数を並べる。向こうの工場で何が起きるかは向こうの同じ帯で(承認前は自分のアプリの2通りだけ)
//  🚨 このファイルは Firestore も React も時計も持たない。「今」は呼ぶ側が ms を渡す。
//  🚨 製品検査と最終検査で同じファイル(md5 一致)。片方だけ変えない。
// =============================================================================

import { measureRun } from './rescueLadder.js';

const str = (v) => (v == null ? '' : String(v).trim());
const arr = (v) => (Array.isArray(v) ? v : []);
// 🚨 null/'' を 0 にしない(Number(null)===0 の罠。2026-08-22 の「分かりません を 0 で埋めるな」)。自分の試験で見つけた。
const finite = (v) => ((v == null || v === '') ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const isFn = (f) => typeof f === 'function';

export const SHARED_KEY = Object.freeze({ HERE: 'here', AWAY: 'away' });

/** 名簿の名前だけを取り出す({name} でも 文字列でも)。空は捨てる。 */
export function namesOf(list) {
  return [...new Set(arr(list).map((w) => (w && typeof w === 'object' ? str(w.name) : str(w))).filter(Boolean))];
}

/**
 * 両方の名簿に同じ名前が在る人。
 * @param {object} a
 * @param {Array} a.hereWorkers  この工場の名簿({name}の配列でも名前の配列でも)
 * @param {Array|null} a.thereNames 向こうの工場の名前。**null = まだ読めていない**(0人と混ぜない)
 * @param {Array} [a.pausedNames] 休止中(この工場)。割付に出ないので外す
 * @returns {{ready:boolean, names:string[], hereCount:number, thereCount:number|null}}
 */
export function sharedWorkerNames({ hereWorkers = [], thereNames = null, pausedNames = [] } = {}) {
  const here = namesOf(hereWorkers);
  const paused = new Set(namesOf(pausedNames));
  if (thereNames == null) return { ready: false, names: [], hereCount: here.length, thereCount: null };
  const there = new Set(namesOf(thereNames));
  const names = here.filter((n) => there.has(n) && !paused.has(n));
  return { ready: true, names, hereCount: here.length, thereCount: there.size };
}

/** 現場の壁時計の日付 'YYYY-MM-DD'(normalizeInput の absences の鍵と同じ)。 */
export const ymdLocal = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const nextDay = (ms) => { const d = new Date(ms); d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); return d.getTime(); };

/**
 * その人を **期間まるごと休み** にする休みの表(scenario.absences の形)。
 * 基準の日から数えて horizonDays 営業日ぶん(worksOnDay が無ければ暦日)。
 * ⚠ 見通しの窓と同じ数え方(基準の日も含めて、働ける日だけ数える)。
 */
export function absencesForPeriod({ name, fromMs, horizonDays, untilMs = null, worksOnDay = null } = {}) {
  const who = str(name);
  const from = finite(fromMs);
  const until = finite(untilMs);
  const days = Math.max(1, Math.trunc(Number(horizonDays)) || 1);
  if (!who || from == null) return null;
  const out = {};
  let cur = new Date(from); cur.setHours(0, 0, 0, 0); cur = cur.getTime();
  let n = 0; let guard = 0;
  if (until != null) {
    // 窓の端(normalized.horizonEnd)が分かる時は **その日まで毎日** 休みにする(土日に休みを書いても害は無い)。
    while (cur <= until && guard < 400) { out[ymdLocal(cur)] = { [who]: 'off' }; cur = nextDay(cur); guard += 1; }
    return out;
  }
  while (n < days && guard < 400) {
    if (!isFn(worksOnDay) || worksOnDay(cur)) { out[ymdLocal(cur)] = { [who]: 'off' }; n += 1; }
    cur = nextDay(cur); guard += 1;
  }
  return out;
}

/**
 * 2通りの段。形は rescueLadder の plan と同じ(ladderRunner.runLadderRung がそのまま食える)。
 * @returns {Array<{key,label,horizonDays,scenarioPatch,factoryCalendar}>}
 */
export function buildSharedWorkerPlans({ name, nowMs, horizonDays, untilMs = null, worksOnDay = null, hereLabel = 'この工場', thereLabel = '向こうの工場' } = {}) {
  const who = str(name);
  const now = finite(nowMs);
  const days = Math.max(1, Math.trunc(Number(horizonDays)) || 1);
  if (!who || now == null) return [];
  return [
    { key: SHARED_KEY.HERE, label: `${who}さんを ${hereLabel} に置く`, horizonDays: days, scenarioPatch: {}, factoryCalendar: null },
    {
      key: SHARED_KEY.AWAY,
      label: `${who}さんを ${thereLabel} に置く（${hereLabel} では この期間 休み）`,
      horizonDays: days,
      scenarioPatch: { absences: absencesForPeriod({ name: who, fromMs: now, horizonDays: days, untilMs, worksOnDay }) },
      factoryCalendar: null,
    },
  ];
}

/**
 * 2通りの結果を読む。🚨 数える式は rescueLadder.measureRun ただ1本(はしごと同じ数え方)。
 * 窓の端が違えば差を作らない(sameWindow=false)。
 * @returns {{here:object|null, away:object|null, sameWindow:boolean, delta:{count:number|null, forecastLate:number|null, unresolvedDue:number|null}}}
 */
export function measureSharedRuns({ runs = [], nowMs } = {}) {
  const now = finite(nowMs);
  const measured = arr(runs).map((r) => measureRun(r, now));
  const here = measured.find((m) => m.key === SHARED_KEY.HERE) || null;
  const away = measured.find((m) => m.key === SHARED_KEY.AWAY) || null;
  const ok = !!(here && away && here.measured && away.measured);
  const sameWindow = ok && here.windowEndMs != null && here.windowEndMs === away.windowEndMs;
  const diff = (k) => (sameWindow ? (Number(away[k]) - Number(here[k])) : null);
  return {
    here, away, sameWindow,
    delta: { count: diff('count'), forecastLate: diff('forecastLate'), unresolvedDue: diff('unresolvedDue') },
  };
}

export default buildSharedWorkerPlans;
