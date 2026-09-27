// =============================================================================
//  src/domain/operationsSimulation/idleReason.js — 「誰が・いつ・どれだけ手が空くか。なぜか」（純関数）
// -----------------------------------------------------------------------------
//  🚨 決まり14-3（2026-09-03 清水さん）「どっちかが暇だっていうなら、それもどこかで表示する必要あって、
//     その暇な理由が **仕事が全くないのかスキルがないのか** って話がやっとでてくるよね(ここがかなり重要)」
//  🚨 決まり16 「担当未定ばかりの画面は出さない。担当未定の理由を出す」
//
//  ここは **割付の結果をそのまま読む** だけ。理由を新しく作らない。
//    ・空き時間      … simulate の idleLog（{worker, reason, fromMs, toMs}）。
//                     分数は forecast.freeMinutesByWorkerOf **ただ1本**（期間で切る・重なりを畳む・勤務時間の中だけ）。
//    ・理由の内訳    … 同じ idleLog の reason（simulate の IDLE_REASON の言葉）を、勤務時間との共通部分で分に直す。
//    ・手が付かない仕事 … simulate の unresolved（{jobId, reason}）を、工程ごとに束ねる。数は増やさない。
//    ・この人に記録が無い工程 … historyEligibility.eligibleFor(processKey) に名前が無い工程。
//                     🚨 空配列は「分かりません」（誰にも記録が無い）であって、やれないという意味ではない。
//  🚨 画面はこの戻り値を置くだけ。画面で数え直さない（同じ数字を2つの計算から出さない）。
//  🚨 Date.now() を読まない。時刻は全部引数。
// =============================================================================
import { IDLE_REASON, UNRESOLVED_REASON } from './simulate.js';
import { freeMinutesByWorkerOf, mergeIntervals } from './forecast.js';

const MS_DAY = 86400000;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const arr = (v) => (Array.isArray(v) ? v : []);

/** 画面が色と札に使う「空きの種類」。文字は IDLE_KIND_LABEL。 */
export const IDLE_KIND = Object.freeze({
  SKILL: 'skill',             // 仕事は残っているが、この人に記録が無い工程（技能の当てが無い）
  NO_JOB: 'nojob',            // 仕事が1件も無い
  ARRIVAL: 'arrival',         // 仕事はあるがまだ着いていない
  PREV_STEP: 'prev',          // 前の工程を待っている
  RESERVED: 'reserved',       // 専門の作業のために手を空けている
  EQUIPMENT: 'equipment',     // 設備が空くのを待っている
  // 🏭 2026-09-10: 作業する区画(場所)が満杯。塞ぐ側(simulate の IDLE_REASON.ZONE_FULL)は
  //   2026-09-06 に本番へ出ていたのに、**この欄が無かった**ので画面は UNEXPLAINED
  //   （札の文字は「理由をまだ言えない」）を出していた。下の kindOfIdleReason と対で読む事。
  ZONE: 'zone',               // 作業する場所が空くのを待っている
  // 👥 2026-09-10: 「1台は同じ人が最後まで」の設定で、その台を持っている人の手が空くのを待つ。
  //   清水さん「分担するときはできたら一台毎で区切る感じじゃないとだめだからね」。
  //   ⚠ 塞ぐ側(simulate の IDLE_REASON.HANDOFF)と **必ず対** で持つ事。片方だけだと
  //     画面は UNEXPLAINED（「理由をまだ言えない」）を出す（ZONE の時と同じ穴）。
  HANDOFF: 'handoff',         // 同じ台を続ける人の手が空くのを待っている
  // 📋 2026-09-22: 保存した計画で その仕事が別の人に固定されている。
  //   ⚠ 塞ぐ側(simulate の IDLE_REASON.PLAN_FIXED)と **必ず対** で持つ事。
  //     片方だけだと画面は UNEXPLAINED（「理由をまだ言えない」）を出す(ZONE・HANDOFF と同じ穴の3度目)。
  PLAN_FIXED: 'planfixed',    // 保存した計画で別の人に決まっている
  NO_TIME: 'notime',          // 残っている仕事に目標時間が無い
  UNEXPLAINED: 'unexplained', // 理由をまだ言えない（simulate が白状した物）
  UNAVAILABLE: 'unavailable', // 休み・勤務時間外・他の作業（空きではない）
});

export const IDLE_KIND_LABEL = Object.freeze({
  [IDLE_KIND.SKILL]: '記録が無い工程が待っている',
  [IDLE_KIND.NO_JOB]: '仕事が無い',
  [IDLE_KIND.ARRIVAL]: '仕事がまだ着いていない',
  [IDLE_KIND.PREV_STEP]: '前の工程を待っている',
  [IDLE_KIND.RESERVED]: '専門の作業のために空けている',
  [IDLE_KIND.EQUIPMENT]: '設備が空くのを待っている',
  [IDLE_KIND.ZONE]: '作業する場所が空くのを待っている',
  [IDLE_KIND.HANDOFF]: '同じ台を続ける人が空くのを待っている',
  [IDLE_KIND.PLAN_FIXED]: '保存した計画で別の人に決まっている',
  [IDLE_KIND.NO_TIME]: '残りの仕事に目標時間が無い',
  [IDLE_KIND.UNEXPLAINED]: '理由をまだ言えない',
  [IDLE_KIND.UNAVAILABLE]: '勤務の外',
});

/** simulate の IDLE_REASON（原文）→ 種類。知らない文言は UNEXPLAINED（黙って NO_JOB に寄せない）。 */
export function kindOfIdleReason(reason) {
  const r = str(reason);
  if (!r) return IDLE_KIND.UNEXPLAINED;
  if (r === IDLE_REASON.NO_SKILL_MATCH) return IDLE_KIND.SKILL;
  if (r === IDLE_REASON.NO_JOB) return IDLE_KIND.NO_JOB;
  if (r === IDLE_REASON.ARRIVAL) return IDLE_KIND.ARRIVAL;
  if (r === IDLE_REASON.PREV_STEP) return IDLE_KIND.PREV_STEP;
  if (r === IDLE_REASON.RESERVED) return IDLE_KIND.RESERVED;
  if (r === IDLE_REASON.HELD) return IDLE_KIND.RESERVED;   // 🧷👤 前回の担当・優先の人を待つ(2026-09-17)
  if (r === IDLE_REASON.PLAN_FIXED) return IDLE_KIND.PLAN_FIXED;   // 📋 2026-09-22
  if (r === IDLE_REASON.EQUIPMENT) return IDLE_KIND.EQUIPMENT;
  // 🔧 2026-09-10: 設備の台数が埋まっている(EQUIPMENT_FULL)。
  //   ⚠ 塞ぐ側(simulate の equipmentGate)と対で読む事。この欄が無いと
  //     画面は UNEXPLAINED『理由をまだ言えない』を出す(ZONE_FULL の時と同じ穴)。
  //   idleLog は素の文言だが、audit(wait-equipment)の方は
  //   『…（測定機 は同時 1台まで・いま 1台 使っています）』と後ろに説明が付く。
  //   どちらを渡されても同じ札にする(後ろに足した説明で UNEXPLAINED へ落とさない)。
  if (r.startsWith(IDLE_REASON.EQUIPMENT_FULL)) return IDLE_KIND.EQUIPMENT;
  // 🏭 作業する場所の満杯。idleLog は素の文言だが、audit(wait-zone)の方は
  //   『…（中間分割1 は同時 1人まで）』と区画の名前を後ろに足してある。
  //   どちらを渡されても同じ札にする（後ろに足した説明で UNEXPLAINED へ落とさない）。
  if (r.startsWith(IDLE_REASON.ZONE_FULL)) return IDLE_KIND.ZONE;
  // 👥 同じ台を続ける人待ち。idleLog は素の文言だが、audit(wait-unit-owner)の方は
  //   『…（片山さん）』と誰を待っているかを後ろに足してある。
  //   どちらを渡されても同じ札にする（後ろに足した説明で UNEXPLAINED へ落とさない）。
  if (r.startsWith(IDLE_REASON.HANDOFF)) return IDLE_KIND.HANDOFF;
  if (r === IDLE_REASON.NO_TARGET_TIME) return IDLE_KIND.NO_TIME;
  if (r === IDLE_REASON.OFF || r === IDLE_REASON.OUT_OF_HOURS
    || r === IDLE_REASON.OTHER_WORK || r === IDLE_REASON.ROSTER_UNKNOWN
    || r === IDLE_REASON.SUPPORT_PRODUCT || r === IDLE_REASON.SUPPORT_FINAL) return IDLE_KIND.UNAVAILABLE;   // 👥 応援(2026-09-16)
  return IDLE_KIND.UNEXPLAINED;
}

/**
 * 「仕事が無い」側か「記録が無い」側か。清水さんの問い（仕事が全く無いのか／スキルが無いのか）に1語で答える為の札。
 * ⚠ EQUIPMENT / ZONE / HANDOFF は 'other'。仕事も技能も在って **場所・設備・同じ台の人** を
 *   待っているだけなので、'nowork'（仕事が無い）へ寄せると嘘になる。
 */
export function familyOfKind(kind) {
  if (kind === IDLE_KIND.SKILL) return 'skill';
  if (kind === IDLE_KIND.NO_JOB || kind === IDLE_KIND.ARRIVAL || kind === IDLE_KIND.PREV_STEP
    || kind === IDLE_KIND.NO_TIME) return 'nowork';
  return 'other';
}

/** その日の 0:00（端末のローカル時刻）。 */
export const localDayStart = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** fromMs〜toMs に掛かる日の 0:00 の並び（端末のローカル時刻）。上限 400日。 */
export function dayStartsBetween(fromMs, toMs) {
  const out = [];
  if (!isNum(fromMs) || !isNum(toMs) || toMs <= fromMs) return out;
  let t = localDayStart(fromMs);
  let guard = 0;
  while (t < toMs && guard < 400) {
    out.push(t);
    const d = new Date(t);
    d.setDate(d.getDate() + 1);
    d.setHours(0, 0, 0, 0);
    t = d.getTime();
    guard += 1;
  }
  return out;
}

/** lots[].steps[].processKey → title の表。無い工程は '' のまま（名前を作らない）。 */
export function processTitleMap(lots) {
  const m = new Map();
  arr(lots).forEach((l) => {
    arr(l && l.steps).forEach((s) => {
      const k = s && s.processKey;
      if (!k || m.has(k)) return;
      m.set(k, str(s.title));
    });
  });
  return m;
}

/**
 * 手が付かなかった仕事（simulate の unresolved）を「理由 → 工程」で束ねる。
 * 🚨 件数は unresolved の行をそのまま数える。ロット数は lotId の種類数。
 */
export function groupUnresolved({ unresolved, jobs, lots } = {}) {
  const jobById = new Map();
  arr(jobs).forEach((j) => { if (j && j.jobId != null) jobById.set(String(j.jobId), j); });
  const titleOf = processTitleMap(lots);
  const byReason = new Map();
  let jobCount = 0;
  const lotIdsAll = new Set();
  arr(unresolved).forEach((u) => {
    if (!u || u.jobId == null) return;
    const reason = str(u.reason) || '理由の記録がありません';
    const job = jobById.get(String(u.jobId)) || null;
    const pk = job && job.processKey != null ? String(job.processKey) : '';
    const lotId = job && job.lotId != null ? String(job.lotId) : '';
    jobCount += 1;
    if (lotId) lotIdsAll.add(lotId);
    let r = byReason.get(reason);
    if (!r) { r = { reason, jobCount: 0, lotIds: new Set(), processes: new Map() }; byReason.set(reason, r); }
    r.jobCount += 1;
    if (lotId) r.lotIds.add(lotId);
    let p = r.processes.get(pk);
    if (!p) { p = { processKey: pk, title: titleOf.get(pk) || '', lotIds: new Set(), jobCount: 0 }; r.processes.set(pk, p); }
    p.jobCount += 1;
    if (lotId) p.lotIds.add(lotId);
  });
  const rows = [...byReason.values()].map((r) => ({
    reason: r.reason,
    kind: r.reason === UNRESOLVED_REASON.NO_CANDIDATE ? 'skill'
      : (r.reason === UNRESOLVED_REASON.ARRIVAL_UNKNOWN ? 'arrival' : 'other'),
    jobCount: r.jobCount,
    lotCount: r.lotIds.size,
    processes: [...r.processes.values()]
      .map((p) => ({ processKey: p.processKey, title: p.title, jobCount: p.jobCount, lotCount: p.lotIds.size, lotIds: [...p.lotIds].slice(0, 5) }))
      .sort((a, b) => b.lotCount - a.lotCount || a.title.localeCompare(b.title, 'ja')),
  })).sort((a, b) => b.lotCount - a.lotCount);
  return { rows, jobCount, lotCount: lotIdsAll.size };
}

/**
 * この人に記録が無い工程（この期間の仕事のうち）。
 * 🚨 eligibility.eligibleFor(processKey) の名前に居ない工程を数えるだけ。
 *    誰にも記録が無い工程（空配列）は unknown に分けて出す＝「分かりません」であって不足ではない。
 * @returns {{lacking: Array<{processKey,title,lotCount}>, unknown: Array<{processKey,title,lotCount}>}|null}
 *   eligibility が無ければ null（調べていない事を、記録が無いと言わない）。
 */
export function lackingProcessesOf({ name, jobs, lots, eligibility } = {}) {
  const who = str(name);
  if (!who || !eligibility || typeof eligibility.eligibleFor !== 'function') return null;
  const titleOf = processTitleMap(lots);
  const seen = new Map(); // processKey -> Set(lotId)
  arr(jobs).forEach((j) => {
    if (!j || j.processKey == null) return;
    const pk = String(j.processKey);
    let s = seen.get(pk);
    if (!s) { s = new Set(); seen.set(pk, s); }
    if (j.lotId != null) s.add(String(j.lotId));
  });
  const lacking = [];
  const unknown = [];
  const cache = new Map();
  for (const [pk, lotIds] of seen) {
    let names = cache.get(pk);
    if (!names) {
      const list = eligibility.eligibleFor(pk);
      names = arr(list).map((c) => (typeof c === 'string' ? c : str(c && c.name))).filter(Boolean);
      cache.set(pk, names);
    }
    const row = { processKey: pk, title: titleOf.get(pk) || '', lotCount: lotIds.size };
    if (names.length === 0) unknown.push(row);
    else if (!names.includes(who)) lacking.push(row);
  }
  const cmp = (a, b) => b.lotCount - a.lotCount || a.title.localeCompare(b.title, 'ja');
  return { lacking: lacking.sort(cmp), unknown: unknown.sort(cmp) };
}

/**
 * 人 × 日 の「空き」と「理由」。
 *
 * @param {object} args
 * @param {Array}  args.idleLog     simulate の idleLog
 * @param {object} args.calendar    makeCalendar の戻り（workMsBetween を使う）
 * @param {string[]} args.workerNames 名簿（normalized.workers[].name）
 * @param {number[]} args.dayStarts  日の 0:00（ms）の並び
 * @param {Array}  [args.unresolved] simulate の unresolved
 * @param {Array}  [args.jobs]       normalized.jobs
 * @param {Array}  [args.lots]       normalized.lots（工程名の為）
 * @param {object} [args.eligibility] buildEligibility の戻り（無ければ「記録が無い工程」の内訳は null）
 * @returns {{
 *   dayStarts:number[],
 *   byWorker: Object<string, Object<number, {workMin:number, freeMin:number|null, inferredZero:boolean,
 *              reasons:Array<{kind,reason,minutes}>, top:{kind,reason,minutes}|null}>>,
 *   unresolved: {rows:Array, jobCount:number, lotCount:number},
 *   lackingByWorker: Object<string, {lacking:Array, unknown:Array}|null>,
 * }}
 */
export function buildIdleByDay({
  idleLog, calendar, workerNames, dayStarts, unresolved = null, jobs = null, lots = null, eligibility = null,
  fromMs = null, toMs = null,
} = {}) {
  const names = arr(workerNames).map(str).filter(Boolean);
  const days = arr(dayStarts).filter(isNum);
  const canMeasure = !!(calendar && typeof calendar.workMsBetween === 'function');
  const byWorker = {};
  names.forEach((n) => { byWorker[n] = {}; });

  for (const d0 of days) {
    // 🚨 2026-09-04: 日の窓を **計算した範囲で切る**。
    //   直す前は最後の日を丸1日ぶん(0時〜24時)数えていたので、割付も idleLog も1分も無い
    //   最終日が「働ける420分・空きの記録なし」＝まる1日ふさがっている、と描かれていた
    //   (実測: 働ける合計が 1人1日420分の物理の上限の1.20倍)。
    //   空き(freeMinutesByWorkerOf)は元から fromMs/toMs で切っているので、働ける側を揃える。
    const d = isNum(fromMs) ? Math.max(d0, fromMs) : d0;
    const to = isNum(toMs) ? Math.min(d0 + MS_DAY, toMs) : (d0 + MS_DAY);
    if (!(to > d)) {
      // 範囲の外。列は残すが「働ける0分」＝ゲージを出さない(休日と同じ扱い)。
      for (const name of names) {
        byWorker[name][d0] = { workMin: 0, freeMin: null, inferredZero: false, reasons: [], top: null };
      }
      continue;
    }
    // 🚨 分数は forecast の1本。ここで足し直さない。
    const free = freeMinutesByWorkerOf({ idleLog, calendar, fromMs: d, toMs: to });
    // 🚨 2026-09-04: 理由の分数も **重なりを畳んでから** 数える。
    //   直す前は idleLog をそのまま足していたので、同じ 9:00〜12:00 が「仕事なし」と
    //   「技能の当てが無い」の2本で記録されると 170分＋170分＝340分 と、空き(170分)の倍で出た。
    //   2026-08-23「空き133.7時間」と同じ足し方。区間を集める → mergeIntervals → 勤務時間で切る。
    const spansByName = new Map(); // name -> Map(reason -> {kind, reason, spans:[[f,t],…]})
    arr(idleLog).forEach((e) => {
      if (!e) return;
      const name = str(e.worker);
      if (!name || !byWorker[name]) return;
      let f = Number(e.fromMs); let t = Number(e.toMs);
      if (!isNum(f) || !isNum(t)) return;
      if (f < d) f = d;
      if (t > to) t = to;
      if (!(t > f)) return;
      const kind = kindOfIdleReason(e.reason);
      if (kind === IDLE_KIND.UNAVAILABLE) return; // 勤務の外は空きではない（workMsBetween が 0 を返すはずだが、念のため）
      let m = spansByName.get(name);
      if (!m) { m = new Map(); spansByName.set(name, m); }
      const key = str(e.reason);
      const cur = m.get(key) || { kind, reason: key, spans: [] };
      cur.spans.push([f, t]);
      m.set(key, cur);
    });
    for (const name of names) {
      const workMin = canMeasure ? (Number(calendar.workMsBetween(d, to, name)) || 0) / 60000 : 0;
      const reasons = [...(spansByName.get(name) || new Map()).values()].map((r) => {
        let ms = 0;
        for (const [f, t] of mergeIntervals(r.spans)) {
          ms += canMeasure ? (Number(calendar.workMsBetween(f, t, name)) || 0) : (t - f);
        }
        return { kind: r.kind, reason: r.reason, minutes: isNum(ms) && ms > 0 ? ms / 60000 : 0 };
      }).filter((r) => r.minutes > 0).sort((a, b) => b.minutes - a.minutes);
      const freeMin = Object.prototype.hasOwnProperty.call(free, name) ? free[name] : null;
      byWorker[name][d0] = {
        workMin,
        freeMin,
        // idleLog に区間が1つも無い勤務日 ＝ 空きの記録が無い（simulate S02: 空ける時は必ず idleLog に書く）。
        //   0 と決めつけず、印を残す。画面は「空き 0」ではなく「空きの記録なし」と出せる。
        inferredZero: freeMin == null && workMin > 0,
        reasons,
        top: reasons.length ? reasons[0] : null,
      };
    }
  }

  const lackingByWorker = {};
  names.forEach((n) => { lackingByWorker[n] = lackingProcessesOf({ name: n, jobs, lots, eligibility }); });

  return {
    dayStarts: days,
    byWorker,
    unresolved: groupUnresolved({ unresolved, jobs, lots }),
    lackingByWorker,
  };
}

/** 時間の札。60分未満は「分」、それ以上は小数1桁の「h」。 */
export function fmtHours(min) {
  if (!isNum(min) || min < 0) return '—';
  if (min < 60) return `${Math.round(min)}分`;
  return `${Math.round(min / 6) / 10}h`;
}

export default buildIdleByDay;
