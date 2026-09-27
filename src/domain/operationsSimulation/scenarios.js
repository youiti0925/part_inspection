// =============================================================================
//  scenarios.js — シナリオ比較の「同じ土俵」と「非悪化保証」と「原因分類」
//                 (仕様書 5.8 / 5.9 / 5.10 / F1)
// -----------------------------------------------------------------------------
//  🚨 ここが守る事:
//    ① **同じ入力どうしでなければ比べない**(5.8 / T014)。
//       inputFingerprint か baseNow が1つでも違えば comparable:false を返し、
//       **差の数字を作らない(deltas:null)**。違う土俵の数字を並べると
//       「残業したら悪くなった」の様な嘘が出る。
//    ② **差が無い時に「差がある」と言わない**(T015)。
//       hasDifference は「12項目のどれかが実際に違う」時だけ true。
//    ③ **全員万能が通常より悪くなる事は有り得ない**(5.9 / T017)。
//       貪欲な割り当ては「選べる人が増えた」だけで悪い順路へ迷い込む事がある。
//       悪化したら **通常解をそのまま万能シナリオの答えとして採る**(baseline-fallback)。
//       悪化した解で「仕事量が原因」と断定しない。
//    ④ **原因を1個に絞らない**(5.10)。主因・副因・判定上の不足の3段に分ける。
//    ⑤ **「候補」と「測定済みの改善効果」を混ぜない**(5.10 末尾 / T019)。
//       効果の数字を持てるのは、同じ土俵で実際に計算した差分だけ。
//
//  ⚠ ここは純関数だけ。Firestore も React も時計(Date.now)も触らない。
// =============================================================================

// 🚨 「その人がその期間に働ける分数」を出す道は forecast.js の1本だけ。
//   ここで勤務表を読み直したり、新しい式を書いたりしない。
//   同じ事を2か所で決めると、片方だけ直して片方が古いまま残る。
import { freeMinutesByWorkerOf } from './forecast.js';

// 🚨 2026-09-01 矛盾Aの直し。
//   「危険なロットの数え方」と「一番効く手の選び方」は、このファイルに書かない。
//   atRisk.js / remedyRank.js の **ただ1か所**にある物を呼ぶ。
//   ここへ式を書き戻すと、今日の判断と改善・教育で違う数が出る形が復活する。
import { atRiskBreakdown, lotIdOfUnresolved as lotIdOfUnresolvedShared } from './atRisk.js';
import { rankRemedies, REMEDY_MEASURE, REMEDY_MEASURE_LABEL } from './remedyRank.js';

/** シナリオの名前。画面と結果の両方でこれを使う(文字列を各所で直書きしない)。 */
export const SCENARIO_ID = Object.freeze({
  /** 通常。比較の土台。 */
  BASELINE: 'baseline',
  /** 残業(1日の直接作業分数が増える)。納期線は動かない(T008)。 */
  OVERTIME: 'overtime',
  /** 欠員(誰かが休む)。 */
  ABSENCE: 'absence',
  /** 全員万能(全員がどの工程も持てる)。**力量が原因かを切り分けるための仮定**。 */
  ALL_SKILLS: 'all-skills',
  /** 後継者(ある人の工程を別の人が引き継げる様になった場合)。 */
  SUCCESSOR: 'successor',
});

/** 5.10 の原因。**1個に絞らない**。 */
export const CAUSE = Object.freeze({
  /** 仕事量超過: 全員万能でも危険が残る = 人の割り振りではどうにもならない */
  WORKLOAD: 'workload',
  /** 力量・経験根拠の偏り: 全員万能にすると良くなる = 持てる人が偏っている */
  SKILL_BIAS: 'skill-bias',
  /** 欠員影響: 同じ土俵の欠員シナリオで悪化する */
  ABSENCE: 'absence',
  /** 到着情報不足: 到着予定超過 or 到着日時不明がある */
  ARRIVAL_INFO: 'arrival-info',
  /** 工数情報不足: 見積り不明 or 低信頼がある */
  ESTIMATE_INFO: 'estimate-info',
  /** 設備未評価: 設備要件・設備カレンダーが未接続 */
  EQUIPMENT_UNMODELED: 'equipment-unmodeled',
});

/** 原因の段。主因 / 副因 / 判定上の不足(結論の信頼度を下げる物)。 */
export const CAUSE_TIER = Object.freeze({ PRIMARY: 'primary', SECONDARY: 'secondary', GAP: 'gap' });

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
const arr = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * 手が付かなかった仕事(unresolved)から、どのロットの物かを取り出す。
 *
 * 🚨 simulate.js の classifyUnresolved が push しているのは `{ jobId, reason }` **だけ**で、
 *   lotId は入っていない(simulate.js:1136 で確認)。lotId が無いまま数えると
 *   「納期線があるのに手が付かないロット」が **0件** になり、危険件数が小さく出る。
 * jobId は buildJobs.js:180/196 で `${lotId}#${stepIndex}#${unit|'lot'}` と作られる。
 *   ⚠ lotId 自体に '#' が入っていても壊れないよう、**後ろ2つを落とす**形で戻す
 *      (split('#')[0] だと '#' 入りの lotId で切れる)。
 * ⚠ 将来 simulate 側が lotId を持たせたら、そちらを優先する。
 *
 * ⚠ 2026-09-01: 中身は atRisk.js へ移した(危険件数の式と離すと2か所に同じ物が出来るため)。
 *   ここは今まで通り呼べる様に名前だけ通している。**式をここへ書き戻さない事。**
 */
export const lotIdOfUnresolved = lotIdOfUnresolvedShared;

// -----------------------------------------------------------------------------
// 1. ScenarioMetrics — 比較に使う数字を1つの形にそろえる(仕様書5.8)
// -----------------------------------------------------------------------------
/**
 * @typedef {object} ScenarioMetrics
 * @property {string} scenarioId
 * @property {string} inputFingerprint 入力の指紋。**シナリオ差分を混ぜてはいけない**
 * @property {number} baseNow 基準時刻
 * @property {number} atRiskLotCount 「遅れる」∪「未配置で納期を守れる保証がない」の**和集合**
 * @property {number} futureLateLotCount この先 遅れるロット(すでに納期超過の物は含めない)
 * @property {number} unresolvedDueLotCount 手が付かず、かつ納期線を持つロット
 * @property {number} unresolvedTotalLotCount 手が付かなかったロット(納期線の有無を問わない)
 * @property {number} unjudgeableLotCount 入力不足で判定できないロット
 * @property {number} maxLateMs 一番大きい遅れ(この先の分だけ)
 * @property {number} totalLateMs 遅れの合計(この先の分だけ)
 * @property {number|null} forecastBreachAt この先 最初に納期線を越える時刻。無ければ null
 * @property {number|null} availableMinutes 期間内に使える直接作業分。測っていなければ null
 * @property {number|null} assignedMinutes 実際に割り当てた直接作業分。測っていなければ null
 * @property {number} makespan 最後の作業が終わるまでの長さ(ms)。何も置けなければ 0
 * @property {number} alreadyPastDueLotCount すでに納期を過ぎているロット(**今日の事実**)
 */

/**
 * simulate の結果を ScenarioMetrics にする。
 *
 * 🚨 `alreadyPastDue`(すでに納期を過ぎている)を maxLateMs / totalLateMs / futureLateLotCount に
 *    **入れない**。あれは今日の事実で、シナリオを変えても1件も動かない。
 *    入れると、42日超過のロット1件が maxLateMs を支配して
 *    「欠員で最大遅れが悪化した」が永久に検出できなくなる(T016 が死ぬ)。
 *    件数は alreadyPastDueLotCount として**別に**持つ(3つの数を混ぜない)。
 *
 * ⚠ availableMinutes / assignedMinutes は**測れた時だけ**入れる。
 *   simulate の戻り値だけからは出せない(カレンダーと jobs が要る)ので、
 *   呼ぶ側が渡さなければ null。🚨 0 で埋めない(0だと「能力ゼロ」に読める)。
 *
 * @param {object} simResult simulateOperations の戻り値
 * @param {object} opts
 * @param {string} opts.scenarioId
 * @param {string} opts.inputFingerprint
 * @param {number} opts.baseNow
 * @param {number|null} [opts.availableMinutes]
 * @param {Map<string,object>|null} [opts.jobsById] jobId → job。あれば assignedMinutes を出す
 * @param {object|null} [opts.calendar] makeCalendar の戻り値。
 *   🚨 availableMinutes を渡さない時、これが無いと availableMinutes は **null のまま**。
 *      勤務表が無いと夜と土日を落とせず、使える時間が上限の3.19倍に膨らむ(実測)。
 * @param {number|null} [opts.fromMs] 見立ての始まり。省略時は baseNow
 * @param {number|null} [opts.toMs] 見立ての終わり(normalized.horizonEnd)
 * @returns {ScenarioMetrics}
 */
export function toScenarioMetrics(simResult, {
  scenarioId,
  inputFingerprint,
  baseNow,
  availableMinutes = null,
  jobsById = null,
  calendar = null,
  fromMs = null,
  toMs = null,
} = {}) {
  const res = isObj(simResult) ? simResult : {};
  const rows = arr(res.lotResults);
  const base = num(baseNow);

  const forecastLate = rows.filter((r) => r && r.late === true && r.alreadyPastDue !== true);
  const alreadyPastDue = rows.filter((r) => r && r.alreadyPastDue === true);
  const unjudgeable = rows.filter((r) => r && r.judgeable === false);

  // 🚨🚨 2026-09-01 矛盾Aの直し。
  //   「危険なロット」の数え方は atRisk.js **ただ1本**。ここでは数え直さない。
  //   直す前は explain.js が同じ数え方を持たず `late === true` の件数
  //   (すでに納期を過ぎた物込み)で効き目を出していたので、
  //   同じ『一番効く手』が2つの違う数を持っていた。
  //   ⚠ ここへ式を書き戻すと、その形がそのまま戻る。
  //   🚨 和集合であって足し算ではない(両方に当てはまるロットの二重計上・仕様書5.8)。
  const risk = atRiskBreakdown(res);
  const unresolvedLotIds = risk.unresolvedLotIds;
  const unresolvedDueLotCount = risk.unresolvedDueLotIds.size;
  const atRisk = risk.lotIds;

  let maxLateMs = 0;
  let totalLateMs = 0;
  forecastLate.forEach((r) => {
    const v = num(r.lateMs);
    if (v == null || v <= 0) return;
    totalLateMs += v;
    if (v > maxLateMs) maxLateMs = v;
  });

  let forecastBreachAt = null;
  forecastLate.forEach((r) => {
    const d = num(r.dueLineMs);
    if (d == null) return;
    if (forecastBreachAt == null || d < forecastBreachAt) forecastBreachAt = d;
  });

  let lastEnd = null;
  arr(res.assignments).forEach((a) => {
    const e = num(a && a.endMs);
    if (e != null && (lastEnd == null || e > lastEnd)) lastEnd = e;
  });
  const makespan = (lastEnd == null || base == null) ? 0 : Math.max(0, lastEnd - base);

  // 割り当てた直接作業分。
  //   ① jobs を渡されたら **見積り時間の合計**(durationMs)。これが本当の直接作業分。
  //   ② 渡されなければ **開始〜終了の経過**で代用する。
  //      ⚠ 経過は休憩・夜・土日をまたぐと作業していない時間まで含む。
  //        代用である事を assignedMinutesFrom で明示する(数字だけを信じさせない)。
  let assignedMinutes = null;
  let assignedMinutesFrom = null;
  const asg = arr(res.assignments);
  if (jobsById instanceof Map) {
    let ms = 0;
    let any = false;
    asg.forEach((a) => {
      const j = jobsById.get(a && a.jobId);
      const d = num(j && j.durationMs);
      if (d != null && d > 0) { ms += d; any = true; }
    });
    if (any) { assignedMinutes = ms / 60000; assignedMinutesFrom = 'job-duration'; }
  }
  if (assignedMinutes == null && asg.length) {
    let ms = 0;
    asg.forEach((a) => {
      const st = num(a && a.startMs);
      const en = num(a && a.endMs);
      if (st != null && en != null && en > st) ms += en - st;
    });
    assignedMinutes = ms / 60000;
    assignedMinutesFrom = 'elapsed';
  }

  // 使える直接作業分。
  //   呼ぶ側が測った値をくれればそれを使う。無ければ **この見立ての中で記録した**
  //   「働いた分 + 勤務時間の中で空いていた分」で代用する。
  //
  // 🚨🚨 2026-09-01 是正。ここは以前 idleLog の区間を `toMs - fromMs` の
  //   **生の引き算で足していた**。夜と土日が丸ごと「使える時間」に入っていた。
  //   実測(作り物のデータ・5営業日・4条件とも同じ): 上限の **3.19倍**。
  //     8人60ロット … 上限 16,800分 に対して 53,520分
  //     3人 6ロット … 上限  6,300分 に対して 20,070分
  //     5人20ロット … 上限 10,500分 に対して 33,450分
  //     5人40ロット … 上限 10,500分 に対して 33,450分
  //   ⚠ 膨らんだ元は「同じ人の待機の区間が重なっていた」事ではない。
  //     実測で重なった組は **0組**。効いていたのは
  //     「勤務できる時間との共通部分だけ」が入っていない事 ただ1つで、
  //     8人60ロットの回では idle の生の合計 52,920分 → 勤務時間の中だけ 16,200分。
  //   → forecast.js の freeMinutesByWorkerOf に任せる（①期間で切る ②人ごとに分ける
  //     ③重なりをまとめる ④calendar.workMsBetween で勤務時間との共通部分だけ）。
  //
  // 🚨 カレンダーと期間を渡されなければ **null のまま返す**。
  //   夜と土日を落とせないので「働ける時間」は出せない。
  //   出せない物に数字を作ると、3.19倍の数がそのまま画面へ出る(実際に出ていた)。
  //   0 で埋めるのも同じく禁止(0だと「働ける時間が無い」に読める)。
  let available = num(availableMinutes);
  let availableMinutesFrom = available == null ? null : 'given';
  if (available == null && assignedMinutes != null) {
    const lo = num(fromMs) == null ? base : num(fromMs);
    const hi = num(toMs);
    const canMeasure = calendar && typeof calendar.workMsBetween === 'function';
    if (canMeasure && lo != null && hi != null && hi > lo) {
      const freeByWorker = freeMinutesByWorkerOf({
        idleLog: res.idleLog, calendar, fromMs: lo, toMs: hi,
      });
      let freeMinutes = 0;
      for (const v of Object.values(freeByWorker)) {
        const n = num(v);
        if (n != null && n > 0) freeMinutes += n;
      }
      available = assignedMinutes + freeMinutes;
      availableMinutesFrom = 'assigned+workable';
    }
  }

  return {
    scenarioId: String(scenarioId == null ? '' : scenarioId),
    inputFingerprint: String(inputFingerprint == null ? '' : inputFingerprint),
    baseNow: base == null ? 0 : base,
    atRiskLotCount: atRisk.size,
    futureLateLotCount: forecastLate.length,
    unresolvedDueLotCount,
    unresolvedTotalLotCount: unresolvedLotIds.size,
    unjudgeableLotCount: unjudgeable.length,
    maxLateMs,
    totalLateMs,
    forecastBreachAt,
    availableMinutes: available,
    assignedMinutes,
    /**
     * 🚨 上の2つが「何から出た数字か」。
     *   assignedMinutesFrom  … 'job-duration'(見積りの合計) / 'elapsed'(代用) / null
     *   availableMinutesFrom … 'given'(呼ぶ側が測った) / 'assigned+workable'(代用) / null(出せなかった)
     * ⚠ 'assigned+idle'(夜と土日を含む生の待機時間)は 2026-09-01 に廃止。
     */
    assignedMinutesFrom,
    availableMinutesFrom,
    makespan,
    alreadyPastDueLotCount: alreadyPastDue.length,
  };
}

// -----------------------------------------------------------------------------
// 2. 比較目的関数(仕様書5.9)
// -----------------------------------------------------------------------------
/**
 * 良い方を決める順番。**小さいほど良い**。
 * 🚨 前の項目で差が付いたら後ろは見ない(辞書順)。
 *    後ろも足し合わせると「危険が1件増えたが makespan が縮んだから良い」になってしまう。
 */
export const OBJECTIVE_KEYS = Object.freeze([
  'atRiskLotCount',
  'futureLateLotCount',
  'unresolvedDueLotCount',
  'totalLateMs',
  'unresolvedTotalLotCount',
  'makespan',
]);

/**
 * a が良ければ -1 / 同じなら **0** / b が良ければ 1。
 * 🚨 同点で -1 や 1 を返すと、非悪化の判定が入れ替わり続けて採用が揺れる。
 */
export function objectiveCompare(a, b) {
  const A = isObj(a) ? a : {};
  const B = isObj(b) ? b : {};
  for (const k of OBJECTIVE_KEYS) {
    const x = num(A[k]);
    const y = num(B[k]);
    const xv = x == null ? Infinity : x;   // 測れていない物は「一番悪い」扱い(良く見せない)
    const yv = y == null ? Infinity : y;
    if (xv < yv) return -1;
    if (xv > yv) return 1;
  }
  return 0;
}

// -----------------------------------------------------------------------------
// 3. 同じ土俵かどうか(仕様書5.8 / T014)
// -----------------------------------------------------------------------------
/** 比較の前提。1つでも違えば比べない。 */
export const COMPARABLE_KEYS = Object.freeze(['inputFingerprint', 'baseNow']);

/** 差として出す項目。 */
export const DELTA_KEYS = Object.freeze([
  'atRiskLotCount',
  'futureLateLotCount',
  'unresolvedDueLotCount',
  'unresolvedTotalLotCount',
  'unjudgeableLotCount',
  'maxLateMs',
  'totalLateMs',
  'forecastBreachAt',
  'availableMinutes',
  'assignedMinutes',
  'makespan',
  'alreadyPastDueLotCount',
]);

/**
 * 通常(baseline)と別シナリオを比べる。
 *
 * @returns {{comparable:boolean, reason:string|null, deltas:object|null,
 *            hasDifference:boolean, changedKeys:string[], better:number|null}}
 *   deltas[k] = { base, other, delta, changed }
 *     ・delta は数どうしの引き算。片方 null(測っていない/起きていない)なら delta:null。
 *     ・🚨 changed は **値が実際に違う時だけ** true(T015)。
 *   better: objectiveCompare(other, base) の結果。-1 なら other の方が良い。
 *
 * 🚨 comparable:false の時は **deltas を作らない**。
 *   「比べられないが参考までに」を出すと、必ずそれが1人歩きする。
 */
export function compareScenarios(baseline, other) {
  const A = isObj(baseline) ? baseline : null;
  const B = isObj(other) ? other : null;
  if (!A || !B) {
    return {
      comparable: false,
      reason: '比べる相手がありません（片方の結果がまだ出ていません）',
      deltas: null,
      detail: null,
      hasDifference: false,
      changedKeys: [],
      better: null,
    };
  }
  for (const k of COMPARABLE_KEYS) {
    if (A[k] !== B[k]) {
      const label = k === 'baseNow' ? '基準時刻' : '入力の指紋';
      return {
        comparable: false,
        reason: `${label}が違うので比べません（通常=${String(A[k])} / ${String(B.scenarioId || '相手')}=${String(B[k])}）。同じ入力・同じ時刻で計算し直してください。`,
        deltas: null,
        hasDifference: false,
        changedKeys: [],
        better: null,
      };
    }
  }

  // 🚨 差が無い項目は deltas に **入れない**（仕様書12章-7 / T015）。
  //   0 を入れて並べると、画面で「12項目全部が変わった」と読めてしまう。
  // deltas[k] は **数**（other - baseline）。片方だけ null の時は引き算できないので
  //   deltas には入れず、detail と changedKeys だけに残す（作り話の数字を出さない）。
  const deltas = {};
  const detail = {};
  const changedKeys = [];
  for (const k of DELTA_KEYS) {
    const bv = A[k] === undefined ? null : A[k];
    const ov = B[k] === undefined ? null : B[k];
    const bn = num(bv);
    const on = num(ov);
    const delta = (bn == null || on == null) ? null : on - bn;
    const changed = (bn == null && on == null) ? false : (bn == null || on == null ? true : on !== bn);
    detail[k] = { base: bv, other: ov, delta, changed };
    if (changed) {
      changedKeys.push(k);
      if (delta != null && delta !== 0) deltas[k] = delta;
    }
  }

  return {
    comparable: true,
    reason: null,
    /** 変わった項目だけ。値は数（other - baseline） */
    deltas,
    /** 全項目の内訳（base / other / delta / changed）。null ↔ 数 の変化もここに出る */
    detail,
    hasDifference: changedKeys.length > 0,
    changedKeys,
    better: objectiveCompare(B, A),
  };
}

// -----------------------------------------------------------------------------
// 4. 全員万能の非悪化保証(仕様書5.9 / T017)
// -----------------------------------------------------------------------------
/** 5.9 が名指しで「悪化させてはならない」と書いている3項目。 */
export const NON_DEGRADATION_KEYS = Object.freeze([
  'atRiskLotCount',
  'futureLateLotCount',
  'unresolvedDueLotCount',
]);

/**
 * 全員万能の解が通常より悪ければ、**通常解を万能シナリオの答えとして採る**。
 *
 * なぜ必要か: 全員万能は「選べる人が増えた」だけなので、通常の答えは必ず作れる。
 *   それでも貪欲な割り当ては、選べる人が増えた事で別の順路へ入り、結果が悪くなる事がある。
 *   その悪い解を使って「万能にしても直らない＝仕事量が原因」と断定すると **嘘になる**。
 *
 * @returns {{metrics:ScenarioMetrics, solutionSource:'all-skills'|'baseline-fallback',
 *            degradedKeys:string[], why:string}}
 */
export function resolveAllSkills(baselineMetrics, allSkillsMetrics) {
  const base = isObj(baselineMetrics) ? baselineMetrics : null;
  const all = isObj(allSkillsMetrics) ? allSkillsMetrics : null;
  if (!base) {
    return {
      metrics: all,
      solutionSource: 'all-skills',
      degradedKeys: [],
      why: '通常の結果がないので比べられません',
    };
  }
  if (!all) {
    return {
      metrics: { ...base, scenarioId: SCENARIO_ID.ALL_SKILLS },
      solutionSource: 'baseline-fallback',
      degradedKeys: [],
      why: '全員万能の計算結果がないので、通常の解をそのまま使います',
    };
  }

  const degradedKeys = NON_DEGRADATION_KEYS.filter((k) => {
    const a = num(all[k]);
    const b = num(base[k]);
    if (a == null || b == null) return false;
    return a > b;
  });

  // 名指しの3項目が悪化した時だけでなく、目的関数で総合的に悪い時も通常解を採る。
  const worseOverall = objectiveCompare(all, base) > 0;

  if (degradedKeys.length === 0 && !worseOverall) {
    return {
      metrics: all,
      solutionSource: 'all-skills',
      degradedKeys: [],
      why: '全員万能の解が通常以上だったので、そのまま使います',
    };
  }

  return {
    // 🚨 通常解を「万能シナリオの答え」として採るので、名前だけ付け替える。
    //   数字は通常のまま(作り替えない)。
    metrics: { ...base, scenarioId: SCENARIO_ID.ALL_SKILLS },
    solutionSource: 'baseline-fallback',
    degradedKeys,
    why: degradedKeys.length
      ? `全員万能の割り当てが通常より悪くなりました（${degradedKeys.join(' / ')}）。全員万能は通常の答えを必ず作れるので、通常の解を採ります。「「万能でも直らない＝仕事量が原因」とは言えません。」`
      : '全員万能の割り当ての総合成績が通常より悪かったので、通常の解を採ります',
  };
}

// -----------------------------------------------------------------------------
// 5. 原因分類(仕様書5.10)
// -----------------------------------------------------------------------------
/**
 * 原因を**複数**返す。主因＝危険件数への影響が最大の「確認済み」原因。
 *
 * 🚨 「確認済み(measured)」と「候補(candidate)」を混ぜない(T019)。
 *   ・measured … 同じ土俵で実際に計算した差分から出た物。**効果の数字を持てる**。
 *   ・candidate … まだ計算していない物。**効果の数字を持たせない(effect:null)**。
 *
 * @param {object} args
 * @param {ScenarioMetrics} args.baseline
 * @param {{metrics:ScenarioMetrics, solutionSource:string}|null} [args.allSkills] resolveAllSkills の戻り値
 * @param {ScenarioMetrics|null} [args.absence]
 * @param {object} [args.inputQuality] normalizeInput の inputQuality
 * @returns {{causes:Array, primary:object|null, secondary:object|null, gaps:Array}}
 */
export function classifyCauses({
  baseline,
  allSkills = null,
  absence = null,
  inputQuality = null,
} = {}) {
  const base = isObj(baseline) ? baseline : null;
  const causes = [];
  const gaps = [];
  if (!base) return { causes, primary: null, secondary: null, gaps };

  const q = isObj(inputQuality) ? inputQuality : {};
  const allM = allSkills && isObj(allSkills.metrics) ? allSkills.metrics : null;

  // ── 仕事量超過: 全員万能でも危険が残る ────────────────────────────────
  if (allM) {
    const remain = num(allM.atRiskLotCount);
    if (remain != null && remain > 0) {
      causes.push({
        cause: CAUSE.WORKLOAD,
        kind: 'measured',
        label: '仕事量が多すぎます',
        detail: `全員がどの工程も持てると仮定しても、${remain}件が危険なままです。人の割り振りでは解けません。`,
        // 「万能にしても消えない分」が仕事量に帰する量
        effect: remain,
        effectUnit: '件',
        // 🚨 通常解を採った(baseline-fallback)場合、万能の解は信用できないので
        //   「仕事量が原因」と断定しない。
        trustworthy: allSkills.solutionSource !== 'baseline-fallback',
        note: allSkills.solutionSource === 'baseline-fallback'
          ? '⚠ 全員万能の割り当てが通常より悪かったため通常解を採りました。「仕事量が原因とは言い切れません。」'
          : '',
      });
    }
  }

  // ── 力量・経験根拠の偏り: 万能にすると良くなる ─────────────────────────
  if (allM) {
    const dRisk = num(base.atRiskLotCount) - num(allM.atRiskLotCount);
    const dUnres = num(base.unresolvedDueLotCount) - num(allM.unresolvedDueLotCount);
    const gain = Math.max(dRisk || 0, dUnres || 0);
    if (gain > 0) {
      causes.push({
        cause: CAUSE.SKILL_BIAS,
        kind: 'measured',
        label: '持てる人が偏っています',
        detail: `全員がどの工程も持てると仮定すると、危険が ${gain}件 減ります。特定の工程に人が寄っています。`,
        effect: gain,
        effectUnit: '件',
        trustworthy: allSkills.solutionSource !== 'baseline-fallback',
        note: '',
      });
    }
  }

  // ── 欠員影響: 同じ土俵の欠員シナリオで悪化 ─────────────────────────────
  if (isObj(absence)) {
    const cmp = compareScenarios(base, absence);
    if (cmp.comparable) {
      const worse = ['atRiskLotCount', 'maxLateMs'].filter((k) => (num(cmp.detail[k] && cmp.detail[k].delta) || 0) > 0);
      const breachEarlier = cmp.detail.forecastBreachAt
        && num(cmp.detail.forecastBreachAt.other) != null
        && (num(cmp.detail.forecastBreachAt.base) == null
          || num(cmp.detail.forecastBreachAt.other) < num(cmp.detail.forecastBreachAt.base));
      if (worse.length > 0 || breachEarlier) {
        const d = num(cmp.detail.atRiskLotCount.delta) || 0;
        causes.push({
          cause: CAUSE.ABSENCE,
          kind: 'measured',
          label: '欠員が効いています',
          detail: `その人が休むと、危険が ${d}件 ${d >= 0 ? '増え' : '減り'}ます${breachEarlier ? '。最初に納期を越える時刻も早まります' : ''}。`,
          effect: d,
          effectUnit: '件',
          trustworthy: true,
          note: '',
        });
      }
    }
  }

  // ── 判定上の不足(結論の信頼度を下げる物)。🚨 原因ではなく「分かっていない事」 ──
  const overdue = num(q.arrivalOverdueCount) || 0;
  const arrUnknown = num(q.arrivalUnknownCount) || 0;
  if (overdue > 0 || arrUnknown > 0) {
    gaps.push({
      cause: CAUSE.ARRIVAL_INFO,
      kind: 'gap',
      label: '到着の情報が足りません',
      detail: `到着予定を過ぎたまま現物未確認 ${overdue}件 / 到着日時が分からない ${arrUnknown}件。手元にあるのか分からないので、結論の信頼度が下がります。`,
      effect: null,
      effectUnit: null,
      trustworthy: false,
      note: '',
    });
  }
  const missEst = num(q.missingEstimateCount) || 0;
  const lowEst = num(q.lowConfidenceEstimateCount) || 0;
  if (missEst > 0 || lowEst > 0) {
    gaps.push({
      cause: CAUSE.ESTIMATE_INFO,
      kind: 'gap',
      label: '工数の情報が足りません',
      detail: `見積りが分からない ${missEst}件 / 信頼度が低い ${lowEst}件。🚨 分からない分は合計に足していないので、実際はもっとかかる可能性があります。`,
      effect: null,
      effectUnit: null,
      trustworthy: false,
      note: '',
    });
  }
  if (q.equipmentUnmodeled === true) {
    gaps.push({
      cause: CAUSE.EQUIPMENT_UNMODELED,
      kind: 'gap',
      label: '設備を見ていません',
      detail: '設備の要件も設備の空きも計算に入っていません。設備待ちで止まる分は、この結果に出ません。',
      effect: null,
      effectUnit: null,
      trustworthy: false,
      note: '',
    });
  }

  // 主因・副因は「危険件数への影響が最大の**確認済み**原因」から選ぶ。
  // 🚨 gaps(判定上の不足)は原因の順位に混ぜない。あれは「分かっていない事」。
  const measured = causes
    .filter((c) => c.kind === 'measured' && c.trustworthy !== false)
    .sort((a, b) => (num(b.effect) || 0) - (num(a.effect) || 0)
      || String(a.cause).localeCompare(String(b.cause)));

  return {
    causes,
    primary: measured[0] || null,
    secondary: measured[1] || null,
    gaps,
  };
}

/**
 * 「一番効く手」。🚨 **同じ土俵で計算済みの差分だけ**から選ぶ(T019)。
 * 計算していない案は candidates に入れ、**効果の数字を持たせない**。
 *
 * 🚨 2026-09-01 矛盾Aの直し。
 *   並べ方と『一番効く手』の選び方は remedyRank.js **ただ1本**。ここで書かない。
 *   今日の判断(explain.js)も同じ関数を呼ぶので、同じ顔ぶれなら同じ手が選ばれる。
 *   押していない仮定(全員がどの工程も持てる 等)は best に**選ばない**。
 *   別の名前 `ceiling`(上限)で返し、画面も別の言葉で出す。
 *
 * @param {object} args
 * @param {ScenarioMetrics} args.baseline
 * @param {Array<{scenarioId:string, label:string, metrics:ScenarioMetrics}>} args.measuredScenarios
 *   人が押して計算した手。
 * @param {Array<{scenarioId:string, label:string, metrics:ScenarioMetrics, assumption:string}>} [args.assumptions]
 *   人が押していない仮定(全員がどの工程も持てる 等)。**best には選ばれない**。
 *   渡さなければ ceiling は null。
 * @param {Array<{scenarioId:string, label:string, why:string}>} [args.candidates] 未計算の案
 */
export function rankImprovements({
  baseline, measuredScenarios = [], assumptions = [], candidates = [],
} = {}) {
  const base = isObj(baseline) ? baseline : null;
  const measured = [];
  const assumed = [];
  const rejected = [];
  if (base) {
    const take = (s, pressed, assumption) => {
      const cmp = compareScenarios(base, s && s.metrics);
      if (!cmp.comparable) {
        rejected.push({ scenarioId: s && s.scenarioId, label: s && s.label, reason: cmp.reason });
        return;
      }
      const d = num(cmp.detail.atRiskLotCount.delta);
      (pressed ? measured : assumed).push({
        key: String(s.scenarioId == null ? '' : s.scenarioId),
        scenarioId: s.scenarioId,
        label: s.label,
        /** 危険が何件減るか(正が「良くなる」)。ものさしは remedyRank.REMEDY_MEASURE。 */
        effect: d == null ? null : -d,
        effectUnit: '件',
        measure: REMEDY_MEASURE,
        pressed,
        assumption: pressed ? null : assumption,
        hasDifference: cmp.hasDifference,
        better: cmp.better,
        deltas: cmp.deltas,
        detail: cmp.detail,
      });
    };
    arr(measuredScenarios).forEach((s) => take(s, true, null));
    arr(assumptions).forEach((s) => take(s, false, s && s.assumption));
  }
  // 🚨 並べ方も選び方も remedyRank.js の1本。ここに sort と find を書かない。
  const ranked = rankRemedies({ items: [...measured, ...assumed] });
  const rankedKeys = new Map(ranked.ranked.map((m, i) => [m.key, i]));
  const orderOf = (m) => (rankedKeys.has(String(m.key)) ? rankedKeys.get(String(m.key)) : Infinity);
  measured.sort((a, b) => orderOf(a) - orderOf(b));
  return {
    /** 効果を数字で言える手(同じ土俵で計算済み・**人が押した手だけ**)。改善するもの(effect>0)だけ。 */
    best: ranked.best,
    /** 🚨 押していない仮定の上限。best と**同じ言葉で出さない**。 */
    ceiling: ranked.ceiling,
    /** ものさしの名前と説明。今日の判断の画面と**同じ文字列**を使う。 */
    measure: ranked.measure,
    measureLabel: REMEDY_MEASURE_LABEL,
    /** 押していない仮定(効き目の数字付き)。measured には混ぜない。 */
    assumptions: assumed,
    measured,
    /** 🚨 まだ計算していない案。**effect は必ず null**。数字を作らない。 */
    candidates: arr(candidates).map((c) => ({
      scenarioId: c.scenarioId,
      label: c.label,
      why: c.why || '',
      effect: null,
      effectUnit: null,
      measured: false,
    })),
    /** 同じ土俵でなかったので比べなかった物 */
    rejected,
  };
}
