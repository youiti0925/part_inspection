// ============================================================================
// 🎓 教育の待ち行列。軸Aの結果だけを引数に取る。
// ----------------------------------------------------------------------------
// 🚨 このファイルは軸B(件数・速さ・達成率)の索引を **引数で受け取らない**。
//   受け取らないので、混ざりようが無い(構文の上で不成立)。
//   「回数が少ないから教育対象から外す」という1行を、あとから足す余地を残さない。
//
// 教えても残りの272.3時間は1分も減らない。教育が守るのは
// 「その人が休んだ日に止まる時間」だけである。画面にもそう書く。
//
// ⚠ここには React も firebase も import しない (node --test で回すため)。
// ============================================================================

import { bucketOfDue } from './dueDefense.js';

const asArray = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);
const str = (v) => (v == null ? '' : String(v));

/**
 * 納期の近さの重み。
 * 🚨 この倍率だけは測った値ではない。**決めた値** である。
 *   だから画面には必ず「測った値ではなく決めた値です」と書き、
 *   重み無しの生の時間も併記する(片方だけを見せない)。
 */
export const DEFAULT_DUE_WEIGHT = Object.freeze({ overdueOr7d: 2, within30d: 1, later: 0.5 });

const weightOfBucket = (bucket, w) => {
  if (bucket === 'overdue' || bucket === 'within7') return w.overdueOr7d;
  if (bucket === 'within30') return w.within30d;
  return w.later;      // 'later' と 'noDue' は一番軽くする
};

/**
 * 休むと止まる時間。🚨 軸Aだけで数える。回数も速さも式に入らない。
 *
 * @param {Map<string,Object>} abilityResultByLot lotId -> whoCanDo の戻り
 * @param {Array} openRows buildOpenRows の戻り({lotId, remainingH, ...})
 * @returns {{zero:{n:number,h:number}, solo:Object, total:{n:number,h:number}}}
 *   solo は { 名前: {n, h} }。その人しか実績を持っていない仕事の件数と時間。
 */
export const stopHoursOf = (abilityResultByLot, openRows) => {
  const zero = { n: 0, h: 0 };
  // 🚨 検査表そのものが未設定の物は別枠。人が居ないのではなく**検査表が無い**ので、
  //   誰かに教えても直らない。ここを混ぜると「できる人0人」の母数が二重に膨らむ。
  const templateMissing = { n: 0, h: 0 };
  const solo = {};
  let totalN = 0, totalH = 0;
  asArray(openRows).forEach((r) => {
    const a = abilityResultByLot?.get ? abilityResultByLot.get(r.lotId) : (abilityResultByLot || {})[r.lotId];
    const people = a?.people || [];
    const h = Number(r.remainingH) || 0;
    if (a?.templateMissing) { templateMissing.n += 1; templateMissing.h += h; return; }
    if (people.length === 0) { zero.n += 1; zero.h += h; totalN += 1; totalH += h; return; }
    if (people.length === 1) {
      const n = people[0];
      if (!solo[n]) solo[n] = { n: 0, h: 0 };
      solo[n].n += 1; solo[n].h += h; totalN += 1; totalH += h;
    }
  });
  return { zero, solo, templateMissing, total: { n: totalN, h: totalH } };
};

/**
 * その検査表を1人に教えるのにかかる時間(h)。
 *   完了ロット1件あたりの実績時間の中央値 × 2人(付き添う先輩＋教わる人)。
 * 実績が1件も無い検査表は、未完了ロットの見積時間の中央値を使い basis='estimate' を返す。
 * 🚨 見積で出した時は画面に「※実績が無いので見積です」と札を付ける。
 */
export const teachCostDetailOf = (tid, lots, { openRows = null } = {}) => {
  const key = str(tid);
  const done = [];
  asArray(lots).forEach((l) => {
    if (str(l?.templateId) !== key) return;
    if (l.status !== 'completed' && l.location !== 'completed') return;
    let sec = 0;
    Object.values(l.tasks || {}).forEach((t) => {
      if (!t || (t.status !== 'completed' && t.status !== 'ng')) return;
      const d = Number(t.duration) || 0;
      if (d > 0) sec += d;                 // 🚨 負の時間は足さない
    });
    if (sec > 0) done.push(sec / 3600);
  });
  const median = (arr) => {
    if (!arr.length) return null;
    const a = [...arr].sort((x, y) => x - y);
    return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
  };
  const m = median(done);
  if (m != null) return { hours: m * 2, basis: 'actual', n: done.length };
  const est = asArray(openRows).filter((r) => str(r.tid) === key).map((r) => Number(r.remainingH) || 0).filter((x) => x > 0);
  const me = median(est);
  if (me != null) return { hours: me * 2, basis: 'estimate', n: est.length };
  return { hours: 0, basis: 'none', n: 0 };
};

/** teachCostDetailOf の時間だけ。仕様どおり数値1つを返す。 */
export const teachCostOf = (tid, lots, opts) => teachCostDetailOf(tid, lots, opts).hours;

/**
 * 教育カード。効果の高い順に並べる。
 * 効果 =(重みを掛けた止まる時間)÷(教える時間) → 「1時間教えると◯時間ぶん止まらなくなります」
 *
 * 対象は「できる人が0人 or 1人」の未完了ロットを持つ検査表。
 * 🚨 対象を件数で絞らない。1件しか無い検査表も出す(その1件が止まると納期が割れるから)。
 */
export const buildTeachingCards = (abilityResultByLot, openRows, lots, {
  dueWeight = DEFAULT_DUE_WEIGHT, templates = null, nowMs = Date.now(),
} = {}) => {
  const tplName = (tid) => {
    const t = asArray(templates).find((x) => str(x?.id) === str(tid) || str(x?.__id) === str(tid));
    return t?.name || '';
  };
  const byTid = new Map();
  asArray(openRows).forEach((r) => {
    const a = abilityResultByLot?.get ? abilityResultByLot.get(r.lotId) : (abilityResultByLot || {})[r.lotId];
    const people = a?.people || [];
    if (a?.templateMissing) return;                      // 🚨検査表が無い物は教えても直らない(別枠で出す)
    if (people.length > 1) return;                       // 2人以上いる仕事は、休んでも止まらない
    const tid = str(r.tid);
    let c = byTid.get(tid);
    if (!c) { c = { tid, tplName: tplName(tid), stopH: 0, weightedH: 0, openCount: 0, nearestDueMs: null, holders: new Set(), zeroCount: 0 }; byTid.set(tid, c); }
    const h = Number(r.remainingH) || 0;
    c.stopH += h;
    // 札は行が持っている物を優先する(画面の札と重みを必ず一致させる)。
    c.weightedH += h * weightOfBucket(r.bucket || bucketOfDue(r.dueMs, nowMs), dueWeight);
    c.openCount += 1;
    if (people.length === 0) c.zeroCount += 1;
    people.forEach((n) => c.holders.add(n));
    if (r.dueMs != null) c.nearestDueMs = c.nearestDueMs == null ? r.dueMs : Math.min(c.nearestDueMs, r.dueMs);
  });
  const cards = [...byTid.values()].map((c) => {
    const cost = teachCostDetailOf(c.tid, lots, { openRows });
    const teachH = cost.hours;
    return {
      tid: c.tid, tplName: c.tplName,
      stopH: c.stopH, weightedStopH: c.weightedH,
      teachH, teachBasis: cost.basis,
      effect: teachH > 0 ? c.weightedH / teachH : null,   // 教える時間が出せない時は null(0 にしない)
      nearestDueMs: c.nearestDueMs, openCount: c.openCount, zeroCount: c.zeroCount,
      holders: [...c.holders].sort((a, b) => String(a).localeCompare(String(b), 'ja')),
    };
  });
  cards.sort((a, b) => {
    const ea = a.effect == null ? -1 : a.effect;
    const eb = b.effect == null ? -1 : b.effect;
    if (eb !== ea) return eb - ea;
    return (b.weightedStopH - a.weightedStopH) || String(a.tid).localeCompare(String(b.tid));
  });
  return cards;
};

/**
 * 1日あたりの作業時間(h)。教える相手を選ぶ時の第2キーに使う。
 * 回っていない人が先に名前に出る仕掛け(実測 尾田3.81h/信濃2.73h/片山1.34h/村0.09h)。
 */
export const dailyHoursByWorker = (lots, workers, { days = 1 } = {}) => {
  const out = {};
  asArray(workers).forEach((w) => { if (w?.name) out[w.name] = 0; });
  asArray(lots).forEach((l) => {
    Object.values(l?.tasks || {}).forEach((t) => {
      if (!t || (t.status !== 'completed' && t.status !== 'ng')) return;
      const n = (t.workerName || '').trim();
      if (!n || !(n in out)) return;
      const d = Number(t.duration) || 0;
      if (d > 0) out[n] += d / 3600;
    });
  });
  const dv = Math.max(1, Number(days) || 1);
  Object.keys(out).forEach((k) => { out[k] = out[k] / dv; });
  return out;
};

/**
 * 次に覚えてもらう人の候補。
 * 並びは ①同じ特徴工程の網羅率(高い順) ②1日あたり作業時間の少ない順。
 *
 * 🚨 候補は登録されている人を全員出す。網羅率 0/7 の人も隠さない。
 *   隠すと「いつもの人」だけが候補に出続け、回っていない人へ仕事が回らなくなる。
 *   これは推薦であって決定ではない。
 * 🚨 特徴工程が0本の検査表では coverage を null にして「同じ工程の手がかりはありません」と出す。
 *   0/0 という嘘の数字を出さないため。
 *
 * @param {Object} lot
 * @param {string|string[]} holderName 今できる人(候補から外す)
 * @param {Object} abilityIndex buildAbilityIndex の戻り
 * @param {Object} workloadPerDay { 名前: 1日あたり時間 }。ここが候補の名簿にもなる。
 */
export const learnerCandidates = (lot, holderName, abilityIndex, workloadPerDay = {}) => {
  const holders = new Set(Array.isArray(holderName) ? holderName : (holderName ? [holderName] : []));
  const titles = [...new Set(asArray(lot?.steps).map((s) => (s?.title || '').trim())
    .filter((t) => t && abilityIndex?.featureTitles?.has(t)))];
  const total = titles.length;
  const hitOf = (name) => titles.reduce((a, t) => a + ((abilityIndex.byFeatureStep.get(t) || new Set()).has(name) ? 1 : 0), 0);
  return Object.keys(workloadPerDay || {})
    .filter((n) => !holders.has(n))
    .map((n) => {
      const hit = total > 0 ? hitOf(n) : 0;
      return {
        name: n,
        coverage: total > 0 ? `${hit}/${total}` : null,
        coverageRate: total > 0 ? hit / total : null,
        dailyHours: Number(workloadPerDay[n]) || 0,
      };
    })
    .sort((a, b) => {
      const ra = a.coverageRate == null ? -1 : a.coverageRate;
      const rb = b.coverageRate == null ? -1 : b.coverageRate;
      if (rb !== ra) return rb - ra;
      if (a.dailyHours !== b.dailyHours) return a.dailyHours - b.dailyHours;
      return String(a.name).localeCompare(String(b.name), 'ja');
    });
};
