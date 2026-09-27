// =============================================================================
//  forecast.js — 5日／30日の見通しと「将来どの工程で人が足りなくなるか」
//                (仕様書 C4「30日サマリー」/ 11章 下段「将来不足する力量」/ F1)
// -----------------------------------------------------------------------------
//  🚨 ここが守る事:
//    ① **足りない事は「需要 > 供給」でしか言わない**。勘で「危なそう」と言わない。
//       需要 = 残っている仕事の見積り分数(estimate.js が出した物)。
//       供給 = その工程を**持てる人**が、その期間に働ける分数(calendar が出した物)。
//    ② **見積りが分からない工程を 0分として足さない**。
//       0で足すと「需要が小さい＝足りている」という嘘になる。
//       分からない分は unknownMinutes に**別で**数え、画面に必ず出す。
//    ③ **「持てる人が0人」と「分からない」を混ぜない**。
//       実績も正式設定も無い工程は「できない」ではなく「分かりません」。
//       ここを混ぜると、教育の機会が消える(2026-08-20 の指摘)。
//    ④ 期間の区切りは**稼働日**で数える。土日を「働ける日」に数えない。
//
//  ⚠ ここは純関数だけ。Firestore も React も時計(Date.now)も触らない。
//     基準時刻は必ず引数で受け取る。
// =============================================================================

/** 見通しの長さ。仕様書11章 上段「5日／30日」。 */
export const HORIZON = Object.freeze({ FIVE_DAYS: 5, THIRTY_DAYS: 30 });

/**
 * 期間の区切り方。5日は日ごと、30日は週ごとに見ないと読めない。
 *
 * 🚨 2026-09-01 追加: MONTH（暦の月）。
 *   清水さんの指示「シミュレーションは一月毎にして、月毎の必要な人材を確認する感じ」
 *   「一週間前だと間に合わないけど、一月前にわかったら準備する時間もあるから間に合う」。
 *   つまり月で見る意味は **教育の準備が間に合うかどうか** で、そのために要る。
 *   ⚠ MONTH は buildPeriods では扱わない（buildPeriods は稼働日を数える作りなので、
 *     暦の月末で切れない）。月は buildMonthPeriods（下の6章）が作る。
 */
export const BUCKET = Object.freeze({ DAY: 'day', WEEK: 'week', MONTH: 'month' });

/** その長さに合う既定の区切り。 */
export const defaultBucketFor = (days) => (Number(days) > 10 ? BUCKET.WEEK : BUCKET.DAY);

/**
 * 🚨 数として読む。読めなければ null。
 *   ⚠ `Number(null)` は **0** になる。素直に Number.isFinite(Number(v)) と書くと
 *     「納期線が無い(null)」が「納期線 = 1970年(0)」に化け、
 *     納期の無いロットが『納期があるのに手が付かない』に数えられる(実際に起きた)。
 *   ⚠ 空文字も Number('') === 0。真偽値も Number(false) === 0。全部はじく。
 */
const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 上の num をそのまま配る口（2026-09-01 追加）。
 * 🚨 monthly.js が同じ「Number(null) は 0」の罠を自分で書き直さない為に在る。
 *   納期の読み方を2か所で決めると、片方だけ直った時に
 *   「納期の無いロットが 1970年1月1日に納期が来た仕事」へ化ける（実際に起きた）。
 */
export const readNumberOrNull = (v) => num(v);
const arr = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? '' : String(v));

// -----------------------------------------------------------------------------
// 1. 需要 — 残っている仕事が何分あるか
// -----------------------------------------------------------------------------
/**
 * @typedef {object} ProcessDemand
 * @property {string} processKey
 * @property {string} title 工程の題(画面用)
 * @property {number} minutes 見積りが分かっている分の合計(分)
 * @property {number} unknownJobCount 見積りが分からない仕事の件数。🚨 minutes に足していない
 * @property {number} jobCount 仕事の件数(分かっている物も分からない物も)
 * @property {number} lotCount 関わるロット数
 * @property {number|null} earliestDueMs 一番早い納期線
 * @property {Set<string>} lotIds
 */

/**
 * 残っている仕事(jobs)を工程ごとにまとめる。
 *
 * ⚠ jobs は buildJobs が作った物をそのまま使う。ここで作り直さない
 *   (作り直すと台ごと/ロット1回の展開がズレて、件数が二重になる)。
 *
 * @param {object} args
 * @param {Array} args.jobs buildJobs の戻り値(未着手の仕事)
 * @param {Map<string,number|null>} [args.dueLineByLot] lotId → 納期線
 * @param {number|null} [args.untilMs] この時刻より後に納期が来る仕事は数えない。null なら全部
 * @returns {{byProcess:Map<string,ProcessDemand>, totalMinutes:number, unknownJobCount:number}}
 */
export function buildProcessDemand({ jobs, dueLineByLot = null, untilMs = null } = {}) {
  const byProcess = new Map();
  let totalMinutes = 0;
  let unknownJobCount = 0;
  const limit = num(untilMs);

  arr(jobs).forEach((job) => {
    if (!isObj(job)) return;
    const lotId = str(job.lotId);
    const due = dueLineByLot instanceof Map ? num(dueLineByLot.get(lotId)) : null;
    // 期間を切る時は「納期線がこの先に来る物」だけ。納期線が無い物は落とさない
    // (落とすと「納期が分からない仕事」が消えて、需要が小さく見える)。
    if (limit != null && due != null && due > limit) return;

    const key = str(job.processKey || job.stepId);
    let e = byProcess.get(key);
    if (!e) {
      e = {
        processKey: key,
        title: str(job.title),
        minutes: 0,
        unknownJobCount: 0,
        jobCount: 0,
        lotCount: 0,
        earliestDueMs: null,
        lotIds: new Set(),
      };
      byProcess.set(key, e);
    }
    e.jobCount += 1;
    if (lotId) e.lotIds.add(lotId);
    if (due != null && (e.earliestDueMs == null || due < e.earliestDueMs)) e.earliestDueMs = due;

    const ms = num(job.durationMs);
    // 🚨 分からない物を 0 として足さない(仕様書 T030 と同じ理由)
    if (ms == null || job.durationKnown === false || !(ms > 0)) {
      e.unknownJobCount += 1;
      unknownJobCount += 1;
      return;
    }
    const min = ms / 60000;
    e.minutes += min;
    totalMinutes += min;
  });

  for (const e of byProcess.values()) e.lotCount = e.lotIds.size;
  return { byProcess, totalMinutes, unknownJobCount };
}

// -----------------------------------------------------------------------------
// 2. 供給 — その工程を持てる人が、その期間に何分働けるか
// -----------------------------------------------------------------------------
/**
 * 区間を重ならない形にまとめる。
 *
 * 🚨🚨 2026-08-23 事故: 「この見立ての中で空いていた時間」を
 *   idleLog の区間を **そのまま足して** 出していた。
 *   実測(本番636ロット・5日): 村さん 133.7時間 と出た。
 *   **5日の通常勤務なら1人あたり最大35時間**（420分/日 × 5日）。桁が違う。
 *   この数字で教育を勧めると、**実際には空いていない人にOJTを勧める**。
 *
 * 🚨 2026-09-01 訂正 — 膨らんだ元は「重なり」ではありませんでした。
 *   ここには元々「idleLog は同じ時間帯が何度も記録されるので、重なりを畳まないと
 *   二重三重に数える」と書いてありましたが、**いまの simulate.js では重なりません**。
 *   実測（作り物のデータ・4条件）で、同じ人の idleLog の区間が重なった組は **0組**。
 *   効いていたのは freeMinutesByWorkerOf の ③
 *   「勤務できる時間との共通部分だけ」が入っていなかった事 ただ1つで、
 *   8人60ロット・5営業日の回では idle の生の合計 52,920分 → 勤務時間の中だけ 16,200分
 *   （133.7時間も、7暦日=168時間の中に収まるので、夜と土日だけで説明が付きます）。
 *   ⚠ この関数を消してよい、という意味ではありません。
 *     simulate 側が待機の記録の付け方を変えたら、いつでも重なり得ます。
 *     **安い保険として残す**。ただし「これが原因だった」とは書かない。
 *
 * @param {Array<[number,number]>} intervals [開始, 終了] の配列（順不同でよい）
 * @returns {Array<[number,number]>} 開始の昇順・重なり無し
 */
export function mergeIntervals(intervals) {
  const list = arr(intervals)
    .map((x) => [num(Array.isArray(x) ? x[0] : x && x.from), num(Array.isArray(x) ? x[1] : x && x.to)])
    .filter(([f, t]) => f != null && t != null && t > f)
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [f, t] of list) {
    const last = out[out.length - 1];
    // ⚠ 隣り合う区間（前の終わり == 次の始まり）も1本にまとめる。分けても合計は同じだが、
    //   数える回数が減るので、後ろの勤務時間との突き合わせが軽くなる。
    if (last && f <= last[1]) { if (t > last[1]) last[1] = t; continue; }
    out.push([f, t]);
  }
  return out;
}

/**
 * その人が「この期間に、勤務時間の中で、実際に空いていた分数」。
 *
 * 🚨 3つとも必ずやる。1つでも抜くと数が膨らむ:
 *   ① 見立ての期間で切る（期間の外まで数えない）
 *   ② 重なりをまとめる（idleLog は同じ時間帯を何度も記録する）
 *   ③ **勤務できる時間との共通部分だけ**を数える（夜・土日・休憩・休みを空きに数えない）
 *   ③は calendar.workMsBetween に任せる。ここで勤務表を読み直さない。
 *
 * @param {object} args
 * @param {Array} args.idleLog simulate の idleLog（{worker, reason, fromMs, toMs}）
 * @param {object} args.calendar makeCalendar の戻り値
 * @param {number} args.fromMs 見立ての始まり
 * @param {number} args.toMs 見立ての終わり
 * @returns {Object<string, number>} 名前 → 分。記録が1件も無い人は **入れない**（0分にしない）
 */
export function freeMinutesByWorkerOf({ idleLog, calendar, fromMs, toMs } = {}) {
  const lo = num(fromMs);
  const hi = num(toMs);
  const byWorker = new Map();
  arr(idleLog).forEach((e) => {
    if (!isObj(e)) return;
    const name = str(e.worker).trim();
    if (!name) return;
    let f = num(e.fromMs);
    let t = num(e.toMs);
    if (f == null || t == null) return;
    // ① 期間で切る
    if (lo != null && f < lo) f = lo;
    if (hi != null && t > hi) t = hi;
    if (!(t > f)) return;
    if (!byWorker.has(name)) byWorker.set(name, []);
    byWorker.get(name).push([f, t]);
  });

  const out = {};
  const canMeasure = calendar && typeof calendar.workMsBetween === 'function';
  for (const [name, list] of byWorker) {
    // ② 重なりをまとめる
    const merged = mergeIntervals(list);
    let ms = 0;
    for (const [f, t] of merged) {
      // ③ 勤務できる時間との共通部分だけ
      //   ⚠ カレンダーが渡されていない時は、まとめた区間の長さをそのまま使う。
      //     その時は夜や土日が混ざり得るので、呼ぶ側が承知して使う事。
      ms += canMeasure ? (num(calendar.workMsBetween(f, t, name)) || 0) : (t - f);
    }
    out[name] = ms / 60000;
  }
  return out;
}

/**
 * 候補の一覧から **人の名前** を取り出す。
 * 🚨 本物の buildEligibility().eligibleFor は
 *   `[{ name, evidence, workerId, taskCount, lotCount, assumed, label }]` を返す。
 *   文字列の配列ではない。ここを間違えると人名が "[object Object]" になり、
 *   働ける分数の突き合わせが全部外れる（実際に起きた）。
 * ⚠ 文字列で渡す呼ぶ側（試験の作り物など）も居るので、両方を受ける。
 * @returns {string[]|null} 読めなければ null（空配列と区別する）
 */
export function namesOf(v) {
  const pick = (x) => {
    if (typeof x === 'string') return x.trim();
    if (isObj(x)) return str(x.name ?? x.workerName ?? x.worker).trim();
    return '';
  };
  if (Array.isArray(v)) return v.map(pick).filter(Boolean);
  if (v instanceof Set) return [...v].map(pick).filter(Boolean);
  if (isObj(v) && Array.isArray(v.names)) return v.names.map(pick).filter(Boolean);
  return null;
}

/**
 * @typedef {object} ProcessSupply
 * @property {string} processKey
 * @property {string[]} workers 持てる人の名前
 * @property {number} workerCount 持てる人数
 * @property {number|null} minutes その人達がその期間に働ける合計分。測れなければ null
 * @property {boolean} unknown 🚨 「持てる人が分からない」。**0人と混ぜない**
 */

/**
 * 工程ごとの供給を作る。
 *
 * 🚨 `workerCount === 0` と `unknown === true` は**別物**:
 *    ・0人  … 候補を調べた上で、誰も持てないと分かっている
 *    ・不明 … その工程の実績も正式設定も無く、**誰が持てるか調べようがない**
 *   これを混ぜると「できない」と「分からない」が同じ顔になり、教育の機会が消える。
 *
 * ⚠ 1人が複数の工程を持てる場合、その人の分数は**各工程で重複して数える**。
 *   だから「工程ごとの供給の合計」は全体の能力を超える。合計として使わない事。
 *   ここは「この工程を誰かがやれる余地があるか」を見るための数字。
 *
 * @param {object} args
 * @param {Iterable<string>} args.processKeys 見たい工程
 * @param {object} args.eligibility buildEligibility の戻り値(eligibleFor を使う)
 * @param {(name:string)=>number|null} [args.workMinutesOf] その人がその期間に働ける分。測れなければ null
 * @returns {Map<string,ProcessSupply>}
 */
export function buildProcessSupply({
  processKeys, eligibility, workMinutesOf = null,
  /**
   * 🚨🚨 2026-08-23 是正（あら探しで見つかった重大な欠陥）:
   *   本物の `buildEligibility().eligibleFor(key)` は、**知らない工程に空配列 `[]` を返す**
   *   （historyEligibility.js:553）。そのすぐ下にこう書いてある:
   *     「実績なし＝**『分かりません』。やれないという意味ではありません。**」
   *   ところがここは `[]` を「調べた上で0人」と読み、
   *   画面に「担当できる人が居ません。**教育か応援が要ります**」と出していた。
   *   これは 2026-08-20 に清水さんが名指しで禁じた
   *   「実績なし＝できない、と書くな」そのもの。
   *   → 既定で **空配列も「分かりません」** として扱う。
   *   ⚠ 「調べた上で本当に0人」と言える呼ぶ側だけ false を渡す事。
   *     いまの本番にそんな呼ぶ側は無い（eligibleFor は0人と分かりませんを区別しない）。
   */
  emptyMeansUnknown = true,
} = {}) {
  const out = new Map();
  const elig = isObj(eligibility) ? eligibility : null;
  const eligibleFor = elig && typeof elig.eligibleFor === 'function' ? elig.eligibleFor.bind(elig) : null;

  for (const key of processKeys || []) {
    const k = str(key);
    let names = null;
    if (eligibleFor) {
      try {
        const v = eligibleFor(k);
        // 🚨🚨 2026-08-23 是正: 本物の eligibleFor が返すのは **文字列ではなくオブジェクト**
        //   （historyEligibility.js:549 → [{ name, evidence, workerId, taskCount, ... }]）。
        //   ここは以前 v.map(str) と書いていたので、人名が全部 "[object Object]" になっていた。
        //   ⚠ 表示が化けるだけでなく、**workMinutesOf(名前) が誰とも一致せず働ける分数が常に null**
        //     になり、「時間が足りない工程」が一度も検出できなくなっていた（実測で確認）。
        //   文字列・オブジェクト・Set のどれで来ても名前を取り出す。
        names = namesOf(v);
      } catch {
        names = null;
      }
    }
    // 🚨 null（読めなかった）も、空配列（本物の eligibleFor が「分かりません」で返す物）も
    //   どちらも **「分かりません」**。0人にしない。
    if (names == null || (emptyMeansUnknown && names.length === 0)) {
      out.set(k, { processKey: k, workers: [], workerCount: 0, minutes: null, unknown: true });
      continue;
    }
    let minutes = null;
    if (typeof workMinutesOf === 'function' && names.length) {
      let sum = 0;
      let any = false;
      names.forEach((n) => {
        const m = num(workMinutesOf(n));
        if (m == null) return;
        any = true;
        sum += m;
      });
      minutes = any ? sum : null;
    } else if (names.length === 0) {
      minutes = 0;
    }
    out.set(k, { processKey: k, workers: names, workerCount: names.length, minutes, unknown: false });
  }
  return out;
}

// -----------------------------------------------------------------------------
// 3. 不足 — 需要 > 供給 の工程を、理由を分けて出す
// -----------------------------------------------------------------------------
/** 不足の種類。🚨 「仕事量が多い」と「持てる人が居ない」を分ける(仕様書5.10 と同じ考え)。 */
export const SHORTFALL = Object.freeze({
  /** 持てる人は居るが、その期間の分数が足りない */
  CAPACITY: 'capacity',
  /** 持てる人が1人しか居ない = その人が休むと止まる */
  SINGLE_PERSON: 'single-person',
  /**
   * 持てる人が0人。
   * 🚨 これは **「調べた上で本当に0人」** と言える時だけ。
   *   本物の eligibleFor は 0人 と 分かりません を区別しないので、
   *   既定（emptyMeansUnknown:true）では **この種別は出ない**。
   *   出るのは、呼ぶ側が「調べた上で0人」と保証できる時だけ。
   */
  NO_ONE: 'no-one',
  /** 誰が持てるか分からない。🚨 「できない」ではない */
  UNKNOWN: 'unknown',
});

/**
 * 不足している工程を出す。
 *
 * @param {Map<string,ProcessDemand>} demandByProcess
 * @param {Map<string,ProcessSupply>} supplyByProcess
 * @param {object} [opts]
 * @param {number} [opts.marginRatio] 供給がこの倍率を下回ったら不足とみなす。既定 1.0(ちょうど)
 * @returns {Array<object>} 深刻な順(納期が早い順 → 不足分数が大きい順)
 */
export function findShortfalls(demandByProcess, supplyByProcess, { marginRatio = 1.0 } = {}) {
  const out = [];
  const ratio = num(marginRatio) == null ? 1.0 : Number(marginRatio);
  const dem = demandByProcess instanceof Map ? demandByProcess : new Map();
  const sup = supplyByProcess instanceof Map ? supplyByProcess : new Map();

  for (const [key, d] of dem) {
    const s = sup.get(key) || { workerCount: 0, minutes: null, unknown: true, workers: [] };
    const base = {
      processKey: key,
      title: d.title,
      demandMinutes: d.minutes,
      unknownJobCount: d.unknownJobCount,
      lotCount: d.lotCount,
      earliestDueMs: d.earliestDueMs,
      workerCount: s.workerCount,
      workers: s.workers,
      supplyMinutes: s.minutes,
    };
    if (s.unknown) {
      out.push({ ...base, kind: SHORTFALL.UNKNOWN, shortMinutes: null,
        why: 'この工程を誰が担当できるか分かりません（実績も正式な設定もありません）。「やれないという意味ではありません。」' });
      continue;
    }
    if (s.workerCount === 0) {
      out.push({ ...base, kind: SHORTFALL.NO_ONE, shortMinutes: d.minutes,
        why: '担当できる人が居ません。教育か応援が要ります。' });
      continue;
    }
    const need = d.minutes;
    const have = num(s.minutes);
    if (have != null && need > have * ratio) {
      out.push({ ...base, kind: SHORTFALL.CAPACITY, shortMinutes: need - have * ratio,
        why: `この工程に要る時間 ${Math.round(need)}分 に対して、担当できる ${s.workerCount}人 が働ける時間は ${Math.round(have)}分 です。` });
      continue;
    }
    if (s.workerCount === 1) {
      out.push({ ...base, kind: SHORTFALL.SINGLE_PERSON, shortMinutes: 0,
        why: `担当できるのが ${s.workers[0]} さん1人だけです。休むとこの工程が止まります。` });
    }
  }

  const rank = { [SHORTFALL.NO_ONE]: 0, [SHORTFALL.CAPACITY]: 1, [SHORTFALL.SINGLE_PERSON]: 2, [SHORTFALL.UNKNOWN]: 3 };
  out.sort((a, b) => (rank[a.kind] - rank[b.kind])
    || ((a.earliestDueMs == null ? Infinity : a.earliestDueMs) - (b.earliestDueMs == null ? Infinity : b.earliestDueMs))
    || ((num(b.shortMinutes) || 0) - (num(a.shortMinutes) || 0))
    || String(a.processKey).localeCompare(String(b.processKey)));
  return out;
}

// 📅 工場の暦(祝日・年末年始・お盆・全社休業・休日出勤)。純関数だけ。
// 🚨 2026-09-02: 既定の稼働日を「月〜金」とこのファイルで自分で書いていた。
//   同じ判定が2つに分かれていると、片方だけ祝日を覚えて画面ごとに違う答えが出る。
//   ■判定の持ち主は domain/factoryCalendar.js ただ一つ。
import { makeIsWorkday, isYmd, dowOfYmd } from '../factoryCalendar.js';

// -----------------------------------------------------------------------------
// 4. 期間の区切り
// -----------------------------------------------------------------------------
/**
 * 基準時刻から days 稼働日ぶんの区切りを作る。
 * ⚠ 土日を「働ける日」に数えない。`isWorkday` は呼ぶ側(カレンダー)から受け取る。
 *
 * @param {object} args
 * @param {number} args.baseNow
 * @param {number} args.days 稼働日の数
 * @param {(ms:number)=>boolean} [args.isWorkday] 稼働日か。無ければ月〜金
 * @param {'day'|'week'} [args.bucket]
 * @returns {Array<{index:number, label:string, fromMs:number, toMs:number, workdays:number}>}
 */
export function buildPeriods({ baseNow, days, isWorkday = null, bucket = null } = {}) {
  const base = num(baseNow);
  const n = Math.max(0, Math.trunc(num(days) || 0));
  if (base == null || n === 0) return [];
  const b = bucket || defaultBucketFor(n);
  // ⚠ 渡されなかった時の既定も工場の暦を通す。登録が無ければ月〜金 = 今までと同じ。
  const workday = typeof isWorkday === 'function' ? isWorkday : defaultIsWorkday;

  const DAY = 86400000;
  const start = new Date(base);
  start.setHours(0, 0, 0, 0);
  const day0 = start.getTime();

  const out = [];
  let collected = 0;
  let cursor = day0;
  let guard = 0;
  const perBucket = b === BUCKET.WEEK ? 5 : 1;
  let cur = null;

  while (collected < n && guard < 4000) {
    guard += 1;
    if (workday(cursor)) {
      if (!cur) {
        cur = { index: out.length, label: '', fromMs: cursor, toMs: cursor + DAY, workdays: 0 };
      }
      cur.workdays += 1;
      cur.toMs = cursor + DAY;
      collected += 1;
      if (cur.workdays >= perBucket) {
        cur.label = b === BUCKET.WEEK ? `${cur.index + 1}週目` : fmtDay(cur.fromMs);
        out.push(cur);
        cur = null;
      }
    }
    cursor += DAY;
  }
  if (cur) {
    cur.label = b === BUCKET.WEEK ? `${cur.index + 1}週目` : fmtDay(cur.fromMs);
    out.push(cur);
  }
  // 最初の区切りは「今から」始まる(0時からではない)。
  if (out.length) out[0].fromMs = Math.max(out[0].fromMs, base);
  return out;
}

const fmtDay = (ms) => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

/**
 * 期間ごとに「納期が来るロット」と「危険なロット」を数える。
 * @param {Array} lotResults simulate の lotResults
 * @param {Array} periods buildPeriods の戻り値
 */
export function bucketLots(lotResults, periods) {
  const ps = arr(periods);
  const rows = ps.map((p) => ({
    ...p, dueCount: 0, lateCount: 0, unjudgeableCount: 0, alreadyPastDueCount: 0, lotIds: [],
  }));
  arr(lotResults).forEach((r) => {
    const due = num(r && r.dueLineMs);
    if (due == null) return;
    const i = rows.findIndex((p) => due >= p.fromMs && due < p.toMs);
    if (i < 0) return;
    rows[i].dueCount += 1;
    rows[i].lotIds.push(str(r.lotId));
    if (r.alreadyPastDue === true) rows[i].alreadyPastDueCount += 1;
    else if (r.late === true) rows[i].lateCount += 1;
    if (r.judgeable === false) rows[i].unjudgeableCount += 1;
  });
  return rows;
}

/**
 * 5日／30日のまとめ。画面(F2)と教育提案(F3)がそのまま読める形。
 *
 * 🚨 分からない物を必ず一緒に返す。「危険 3件」だけを出すと、
 *   「見積り不明が40件あって数えられていない」が消える。
 */
export function buildHorizonSummary({
  days,
  baseNow,
  lotResults,
  demand = null,
  shortfalls = null,
  isWorkday = null,
  bucket = null,
} = {}) {
  const periods = buildPeriods({ baseNow, days, isWorkday, bucket });
  const buckets = bucketLots(lotResults, periods);
  const rows = arr(lotResults);
  return {
    days: Math.max(0, Math.trunc(num(days) || 0)),
    baseNow: num(baseNow),
    bucket: bucket || defaultBucketFor(days),
    periods: buckets,
    totals: {
      lotCount: rows.length,
      dueInHorizon: buckets.reduce((a, p) => a + p.dueCount, 0),
      lateCount: buckets.reduce((a, p) => a + p.lateCount, 0),
      alreadyPastDueCount: rows.filter((r) => r && r.alreadyPastDue === true).length,
      unjudgeableCount: rows.filter((r) => r && r.judgeable === false).length,
      /** 🚨 納期線が期間の外・または納期が無いロット。数え落としを見えるようにする */
      outsideHorizonCount: rows.filter((r) => {
        const d = num(r && r.dueLineMs);
        if (d == null) return true;
        return !buckets.some((p) => d >= p.fromMs && d < p.toMs);
      }).length,
    },
    demand: demand
      ? {
        totalMinutes: demand.totalMinutes,
        /** 🚨 見積りが分からない仕事の件数。totalMinutes には入っていない */
        unknownJobCount: demand.unknownJobCount,
        processCount: demand.byProcess ? demand.byProcess.size : 0,
      }
      : null,
    shortfalls: arr(shortfalls),
  };
}

// -----------------------------------------------------------------------------
// 6. 月の区切り（2026-09-01 追加。既存の 1〜5章は1行も書き換えていない）
// -----------------------------------------------------------------------------
//
//  清水さん(2026-08-31):
//    「シミュレーションは一月毎にして、月毎の必要な人材を確認する感じ。
//      詳細を見るために一週間毎も見る」
//    「月毎でやるのは…一週間前だと間に合わないけど、
//      一月前にわかったら準備する時間もあるから間に合うからね」
//
//  🚨 ここが守る事:
//    ① 「一月」は **暦の月**（月末締め）。日数は **営業日** で数える。
//       札には必ず暦日と営業日の**両方**を出す(「30日が実は6週間」の読み違えを止める)。
//    ② buildPeriods（稼働日を n 日ぶん数える作り）は触らない。
//       あちらは日・週の呼び出しが生きていて、暦の月末では切れない。**別に作る**。
//    ③ 週の帯は月の中を隙間なく敷き詰める。
//       隙間があると「週の合計 ≠ 月の合計」になり、どちらが正しいか誰にも言えなくなる。
//    ④ 週ごとに営業日数が揃わない（月初が火〜金の4日、など）。
//       **見出しに必ず「営業◯日」を出す**。無いと「1週目だけ山が低い＝楽」と読み違える。

/** 既定の稼働日。呼ぶ側がカレンダーを渡さなかった時だけ使う（月〜金）。 */
// 🚨 工場の暦を番んだ既定。登録が無ければ 月〜金 で、**今までと1ミリも同じ**。
//   ここを直書きの曜日判定に戻すと、祝日を登録しても月の営業日が減らない
//   (= 月の分母が大きいまま = 足りない人数を少なく見積もる)。
const defaultIsWorkday = makeIsWorkday(null);

/** 日をまたぐ加算は setDate に任せる（月末・年末・夏時間をこちらで数えない）。 */
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const addDays = (ms, n) => {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** 月曜0時へ戻す。週の区切りは月曜始まり。 */
const startOfWeek = (ms) => {
  const d0 = startOfDay(ms);
  const back = (new Date(d0).getDay() + 6) % 7; // 0=日 → 6日戻る / 1=月 → 0日
  return addDays(d0, -back);
};

/** `M/D`。札に出す。 */
const fmtMd = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()}`; };

/** `YYYY-MM`。並べ替えと突き合わせに使う。 */
const fmtYm = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

/**
 * その月の1日 0時。offsetMonths ヶ月ずらせる。
 * ⚠ ms を足し引きして月を動かさない事（月の長さが 28〜31 日で揃わない）。
 *   `new Date(y, m + offset, 1)` は月が 12 を超えても年へ繰り上がる。
 * @returns {number|null} 読めない値なら null
 */
export function startOfMonthMs(ms, offsetMonths = 0) {
  const t = num(ms);
  if (t == null) return null;
  const off = Math.trunc(num(offsetMonths) || 0);
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth() + off, 1, 0, 0, 0, 0).getTime();
}

/**
 * その月の末日 23:59:59.999。offsetMonths ヶ月ずらせる。
 * ⚠ `new Date(y, m + 1, 0)` が「翌月の0日」＝当月の末日。うるう年もここが数える。
 * @returns {number|null}
 */
export function endOfMonthMs(ms, offsetMonths = 0) {
  const t = num(ms);
  if (t == null) return null;
  const off = Math.trunc(num(offsetMonths) || 0);
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth() + 1 + off, 0, 23, 59, 59, 999).getTime();
}

/** 暴走止め。13ヶ月ぶんでも400日ちょっと。 */
const MAX_DAY_WALK = 4000;

/**
 * [fromMs, toMs) に**重なる**稼働日の数。
 *
 * ⚠ 半端な日も1日と数える。基準時刻が 9/7 の 13:00 なら、9/7 は「営業1日」。
 *   これは札に出す日数（人が数える単位）で、**働ける分数ではない**。
 *   分数は必ず calendar.workMsBetween が出す（あちらは半端な日を正しく半端に数える）。
 *
 * @param {object} args
 * @param {number} args.fromMs
 * @param {number} args.toMs
 * @param {(ms:number)=>boolean} [args.isWorkday] 稼働日か。無ければ月〜金
 * @returns {number}
 */
export function countWorkdaysBetween({ fromMs, toMs, isWorkday = null } = {}) {
  const lo = num(fromMs);
  const hi = num(toMs);
  if (lo == null || hi == null || !(hi > lo)) return 0;
  const workday = typeof isWorkday === 'function' ? isWorkday : defaultIsWorkday;
  let n = 0;
  let cur = startOfDay(lo);
  let guard = 0;
  while (cur < hi && guard < MAX_DAY_WALK) {
    guard += 1;
    if (workday(cur)) n += 1;
    cur = addDays(cur, 1);
  }
  return n;
}

/**
 * [fromMs, toMs) のうち「登録して休みにした日」の数（＝祝日・年末年始・お盆・全社休業）。
 *
 * 🚨 清水さん(2026-09-01)「祝日表はいるね、これないと処理能力わからないからね」。
 *   札に「営業19日」とだけ出しても、22日から3日減った事が読めない。
 *   **何日引いたか**を並べて出す。2026年9月なら 営業19日・暦30日・祝日3日。
 *
 * ⚠ 土日は数えない。土日は元から休みで、見ても何も分からない。
 *   数えるのは「本来なら働く曜日なのに、登録で休みにした日」だけ。
 * ⚠ 暦を知らない判定関数(days を持たない物)を渡された時は 0。
 *   **推測で埋めない**。分からない物は0件として、画面は「祝日◯日」を出さない。
 *
 * @param {object} args
 * @param {number} args.fromMs
 * @param {number} args.toMs
 * @param {(ms:number)=>boolean} args.isWorkday makeIsWorkday が返した物(days / workdays を持つ)
 * @returns {{holidays:number, workOverrides:number}} holidays=登録した休み / workOverrides=休日出勤
 */
export function countRegisteredDaysBetween({ fromMs, toMs, isWorkday = null } = {}) {
  const none = { holidays: 0, workOverrides: 0 };
  const lo = num(fromMs);
  const hi = num(toMs);
  if (lo == null || hi == null || !(hi > lo)) return none;
  const days = (typeof isWorkday === 'function' && isWorkday.days && typeof isWorkday.days === 'object')
    ? isWorkday.days : null;
  if (!days) return none;
  const dowSet = new Set(Array.isArray(isWorkday.workdays) ? isWorkday.workdays : [1, 2, 3, 4, 5]);
  let holidays = 0;
  let workOverrides = 0;
  // 🚨 期間を1日ずつ辿るのではなく、**登録された日の方**を辿る。
  //   登録は多くても年に数十件。期間が数か月でも数える回数が増えない。
  for (const ymd of Object.keys(days)) {
    if (!isYmd(ymd)) continue;
    const e = days[ymd];
    if (!e || (e.type !== 'off' && e.type !== 'work')) continue;
    // 'YYYY-MM-DD' → その日の0時(端末の帯)。期間の判定は他の数え方と同じ土俵で行う。
    const t = new Date(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));
    t.setHours(0, 0, 0, 0);
    const ms = t.getTime();
    if (ms < startOfDay(lo) || ms >= hi) continue;
    const dow = dowOfYmd(ymd);
    if (e.type === 'off') { if (dowSet.has(dow)) holidays += 1; }
    else if (!dowSet.has(dow)) workOverrides += 1;
  }
  return { holidays, workOverrides };
}

/**
 * [fromMs, toMs) に**重なる**暦日の数。札の「暦30日」。
 * 🚨 営業日とセットで必ず出す。片方だけだと「30日」が営業日なのか暦日なのか読めない。
 */
export function countCalendarDaysBetween({ fromMs, toMs } = {}) {
  const lo = num(fromMs);
  const hi = num(toMs);
  if (lo == null || hi == null || !(hi > lo)) return 0;
  let n = 0;
  let cur = startOfDay(lo);
  let guard = 0;
  while (cur < hi && guard < MAX_DAY_WALK) { guard += 1; n += 1; cur = addDays(cur, 1); }
  return n;
}

/**
 * 暦の月の帯を作る。中に週の帯（月曜始まり・月の中で隙間なく敷き詰め）も入れる。
 *
 * 🚨 index 0（今の月）だけ fromMs が「今」から始まる。過去は働けないので。
 *   ただし **需要（納期が来る仕事）は暦の月まるごとで数える**ので、
 *   暦の月の端も monthFromMs / monthToMs として別に持たせる。
 *   ここを1つにすると、「今日より前に納期が来ていた今月の仕事」がどの月にも入らず消える。
 *
 * 🚨 index 1 以降は「見る長さ」に関係なく必ず暦の月まるごと。
 *   3か月ぶんで見ても12か月ぶんで見ても、10月の帯は1ミリ秒も違わない
 *   （＝10月の不足人日が、見る長さで動かない）。
 *
 * @param {object} args
 * @param {number} args.baseNow 基準時刻
 * @param {number} [args.months] 何ヶ月ぶん。既定3
 * @param {(ms:number)=>boolean} [args.isWorkday] 稼働日か。無ければ月〜金
 * @returns {Array<object>} 月の帯
 */
/**
 * 札の後ろに足す「祝日◯日 / 休日出勤◯日」。
 * 🚨 **0件の時は空文字**。登録が空なら札は直す前と1文字も変わらない。
 */
const regSuffix = (reg) => {
  const r = reg || {};
  let out = '';
  if (r.holidays > 0) out += ` ・ 祝日${r.holidays}日`;
  if (r.workOverrides > 0) out += ` ・ 休日出勤${r.workOverrides}日`;
  return out;
};

export function buildMonthPeriods({ baseNow, months = 3, isWorkday = null } = {}) {
  const base = num(baseNow);
  const n = Math.max(0, Math.trunc(num(months) || 0));
  if (base == null || n === 0) return [];
  const workday = typeof isWorkday === 'function' ? isWorkday : defaultIsWorkday;

  const out = [];
  for (let i = 0; i < n; i += 1) {
    const monthFromMs = startOfMonthMs(base, i);
    // 半開区間 [from, to) に揃える。23:59:59.999 + 1ms = 翌月1日 0時ちょうど。
    const monthToMs = endOfMonthMs(base, i) + 1;
    const fromMs = i === 0 ? Math.max(monthFromMs, base) : monthFromMs;
    const toMs = monthToMs;

    const workdays = countWorkdaysBetween({ fromMs, toMs, isWorkday: workday });
    const calendarDays = countCalendarDaysBetween({ fromMs, toMs });
    const monthWorkdays = countWorkdaysBetween({ fromMs: monthFromMs, toMs: monthToMs, isWorkday: workday });
    const monthCalendarDays = countCalendarDaysBetween({ fromMs: monthFromMs, toMs: monthToMs });
    // 📅 何日を登録で引いたか。札に「営業19日・暦30日・祝日3日」と並べて出すため。
    // 🚨 登録が0件なら 0/0。その時は札に足さない = 直す前と1文字も変わらない。
    const reg = countRegisteredDaysBetween({ fromMs, toMs, isWorkday: workday });
    const monthReg = countRegisteredDaysBetween({ fromMs: monthFromMs, toMs: monthToMs, isWorkday: workday });

    // ── 週の帯。月の中を隙間なく敷き詰める（週の合計 === 月の合計 が成り立つ形） ──
    const weeks = [];
    let cursor = fromMs;
    let guard = 0;
    while (cursor < toMs && guard < 400) {
      guard += 1;
      const weekEnd = Math.min(addDays(startOfWeek(cursor), 7), toMs);
      const wFrom = cursor;
      const wTo = weekEnd;
      const wWorkdays = countWorkdaysBetween({ fromMs: wFrom, toMs: wTo, isWorkday: workday });
      const wReg = countRegisteredDaysBetween({ fromMs: wFrom, toMs: wTo, isWorkday: workday });
      const label = `${fmtMd(wFrom)}〜${fmtMd(wTo - 1)}`;
      weeks.push({
        index: weeks.length,
        label,
        // 🚨 見出しには必ず営業日数を入れる。週ごとに営業日数が揃わない（月初が火〜金の4日など）ので、
        //   無いと「1週目だけ山が低い＝楽」と読み違える。
        //   📅 祝日で短い週は「営業3日（祝日2日）」と理由まで出す。
        //   🚨 登録が0件なら何も足さない = 直す前と1文字も変わらない。
        heading: `${label}（営業${wWorkdays}日${regSuffix(wReg)}）`,
        fromMs: wFrom,
        toMs: wTo,
        workdays: wWorkdays,
        holidays: wReg.holidays,
        workOverrides: wReg.workOverrides,
        calendarDays: countCalendarDaysBetween({ fromMs: wFrom, toMs: wTo }),
      });
      cursor = weekEnd;
    }

    const label = `${new Date(monthFromMs).getMonth() + 1}月`;
    out.push({
      index: i,
      label,
      ym: fmtYm(monthFromMs),
      // 実際に数える範囲（index 0 は「今」から）
      fromMs,
      toMs,
      workdays,
      calendarDays,
      // 暦の月まるごと（需要を切る時と、札に出す時に使う）
      monthFromMs,
      monthToMs,
      monthWorkdays,
      monthCalendarDays,
      // 📅 登録した休み(祝日・年末年始・お盆・全社休業)と休日出勤の数。
      //   🚨 0件なら 0。「祝日0日」を札に出さない事(登録が空の時、今までと同じ札にする)。
      holidays: reg.holidays,
      workOverrides: reg.workOverrides,
      monthHolidays: monthReg.holidays,
      monthWorkOverrides: monthReg.workOverrides,
      // 🚨 札の文言。営業日と暦日を必ず両方書く。引いた祝日・足した休日出勤は在る時だけ足す
      rangeLabel: `${fmtMd(fromMs)}〜${fmtMd(toMs - 1)} ・ 営業${workdays}日 ・ 暦${calendarDays}日`
        + regSuffix(reg),
      monthRangeLabel: `${fmtMd(monthFromMs)}〜${fmtMd(monthToMs - 1)} ・ 営業${monthWorkdays}日 ・ 暦${monthCalendarDays}日`
        + regSuffix(monthReg),
      weeks,
    });
  }
  return out;
}
