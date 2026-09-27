// =============================================================================
//  education.js — F3 教育提案（読み取り専用）
//                 仕様書 5.11「OJTと後継者シナリオ」/ 6章 C5「教育提案」/
//                 11章 下段「将来不足する力量・OJT候補または資料教育候補」
//                 受入試験 T033〜T036
// -----------------------------------------------------------------------------
//  このファイルがやる事は3つだけ:
//    ① forecast.js が出した「不足」を、いつ足りなくなるかで並べ直す
//    ② その不足に対して OJT の候補（指導する人・受ける人・実ロット）を組む
//    ③ 教育を入れた結果が、同じ土俵で測って悪くなっていないかを見る
//
//  🚨 やらない事（ここを踏み外すと事故になる）:
//    ・力量マスタを書き換えない。認定しない。実施済みにしない（仕様書6章 C5 / T036）。
//      引数も1バイトも書き換えない。Object.freeze された物を渡されても落ちない。
//    ・OJT の「2人が同時に埋まる」計算をここで作り直さない。
//      それは simulate.js に既にある（scenario.ojt / S22）。ここが作るのは
//      **simulate がそのまま食える配列**（buildOjtScenario）と、その前段の候補だけ。
//    ・予備時間 60分/人日 と OJT の上限 1組/日 を、この中へ直書きしない。
//      policy.js（provisionalReserveMinutesPerDay / maxOjtPairsPerDay）から
//      **引数で受け取る**。渡されなければ「分かりません」として候補にしない。
//    ・工程と講座の結び付けが無い時に、題名が似ているからと結び付けない。
//
//  🚨 言い方の決まり（2026-08-20 の指摘）:
//    実績が無い ＝「分かりません」。その人にその仕事が向かない、という意味ではない。
//    forecast.SHORTFALL.UNKNOWN（誰が持てるか分からない）を
//    「持てる人が0人」と同じ所へ入れない。混ぜると教育の機会が消える。
//
//  ⚠ 純関数だけ。Firestore も React も時計（現在時刻）も乱数も触らない。
//    基準時刻・空き分数・予備分数は、全部 引数で受け取る。
// =============================================================================

import { SHORTFALL } from './forecast.js';
import { compareScenarios, NON_DEGRADATION_KEYS } from './scenarios.js';
// ⭐ 星取表の「教えられる」の印。畳み方(追記型・retract も追記・履歴は消さない)を
//   ここで作り直さない。starChart.js の deriveTeachMarks をそのまま借りる。
import { deriveTeachMarks } from '../starChart.js';
import {
  normalizeCourse,
  isPublished,
  courseQuestionCount,
  passNeeded,
  QUIZ_PASS_RATIO,
} from '../knowledgeCourses.js';

// ── 小道具 ───────────────────────────────────────────────────────────────────
/**
 * 🚨 数として読む。読めなければ null。
 *   `Number(null)` は 0、`Number('')` も 0、`Number(false)` も 0。
 *   素直に書くと「空き時間を渡していない」が「空き0分」に化ける（forecast.js と同じ罠）。
 */
const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const arr = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? '' : String(v));
const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');
/**
 * 文字列の並べ替え。🚨 localeCompare を使わない。
 * 端末の ICU の版で並びが変わると、同じ入力で結果が変わる（S23 が環境で割れる）。
 */
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** 分を小数1桁で止める。画面と試験で同じ数になるように、丸め方を1箇所にする。 */
const round1 = (n) => Math.round(Number(n) * 10) / 10;

// ── 提案の種類 ───────────────────────────────────────────────────────────────
/** 提案の種類。仕様書 C5「OJT候補と動画・確認テスト候補を分離」。 */
export const EDUCATION_KIND = Object.freeze({ OJT: 'ojt', STUDY: 'study' });

/**
 * OJT が成り立たない時の「何が欠けているか」。
 * 🚨 欠けたら黙って消さない。必ずこの札を付けて返す（消すと、何を用意すれば良いかが誰にも分からない）。
 */
export const OJT_GAP = Object.freeze({
  NO_REAL_LOT: 'no-real-lot',
  REAL_LOT_UNKNOWN: 'real-lot-unknown',
  DURATION_UNKNOWN: 'duration-unknown',
  NO_MENTOR: 'no-mentor',
  NO_TRAINEE: 'no-trainee',
  MENTOR_NO_ROOM: 'mentor-no-room',
  TRAINEE_NO_ROOM: 'trainee-no-room',
  FREE_TIME_UNKNOWN: 'free-time-unknown',
  RESERVE_UNKNOWN: 'reserve-unknown',
});

/** 画面にそのまま出せる言い方。🚨 言い換えはここ1箇所に閉じ込める。 */
export const OJT_GAP_LABEL = Object.freeze({
  'no-real-lot': 'この工程に残っている実際の仕事がありません（練習用の架空ロットは作りません）',
  'real-lot-unknown': '残っている仕事の一覧を渡されていないので、実ロットがあるか確かめていません',
  'duration-unknown': 'この工程にかかる時間が分かりません（見積りがありません）。何分2人を押さえるか決められません',
  'no-mentor': '指導できる人が見つかりません（この工程の記録も、正式な力量の設定もありません）。分かりません、という意味です',
  'no-trainee': 'この工程の記録が無い人が名簿に見つかりません（今いる人は全員この工程の記録を持っています）',
  'mentor-no-room': '指導する人に、その時間ぶんの空きがありません',
  'trainee-no-room': '受ける人に、その時間ぶんの空きがありません',
  'free-time-unknown': '空き時間が分かりません（空き分数を渡されていません）',
  'reserve-unknown': '予備時間（暫定）の分数を渡されていないので、余力を使い切らない判定をしていません',
});

/** 動画＋確認テストが組めない時の札。 */
export const STUDY_GAP = Object.freeze({
  NO_COURSE_LINK: 'no-course-link',
  NO_PUBLISHED_COURSE: 'no-published-course',
});

export const STUDY_GAP_LABEL = Object.freeze({
  'no-course-link': 'この工程に結び付いた講座がありません（題名が似ているだけで結び付けません）',
  'no-published-course': '結び付いた講座がまだ公開されていません',
});

/**
 * 根拠の強さの並び順。🚨 これは足切りの段ではない。下の段の人を候補から消さない。
 * teach = 管理者が星取表で「教えられる」と指名した人。人の判断なので一番前に置く。
 */
const EVIDENCE_RANK = Object.freeze({
  teach: -1, certified: 0, provisional_id: 1, provisional_name: 2, unknown: 3,
});

/**
 * 提案1件の形。
 * 🚨 evidence（なぜそう言えるか）と unknowns（分かっていない事）を必ず持たせる。
 *    数字だけ出すと、測った物と仮定した物が同じ顔になる。
 *
 * @typedef {object} EducationProposal
 * @property {'ojt'|'study'} kind 提案の種類
 * @property {string} processKey 工程の身元（soloDependency の processKeyOf）
 * @property {string} title 工程の題（画面用）
 * @property {string|null} lotId OJT を乗せる実ロット。study では null
 * @property {string|null} mentor 指導する人。study では null
 * @property {string|null} trainee 受ける人。study では null
 * @property {number|null} occupancyMinutes 2人を同時に押さえる分数。分からなければ null
 * @property {string[]} evidence なぜそう言えるか（日本語）
 * @property {string[]} unknowns 分かっていない事（日本語）
 * @property {string} why 画面にそのまま出せる1文
 */

// -----------------------------------------------------------------------------
// 1. いつ足りなくなるか（F3-①）
// -----------------------------------------------------------------------------
/**
 * forecast.findShortfalls の結果を「いつ足りなくなるか」で並べ直す。
 *
 * 🚨 SHORTFALL.UNKNOWN（誰が持てるか分からない）は、期間の中へ入れない。
 *    `unknownWho` へ**別に**返す。「持てる人が0人（NO_ONE）」と同じ列に並べると、
 *    「調べていないだけ」が「誰にも頼めない」に化ける。
 *
 * ⚠ 引数は読むだけ。並べ替えは必ず複製に対して行う（Object.freeze された配列でも落ちない）。
 *
 * @param {object} args
 * @param {Array} args.shortfalls forecast.findShortfalls の戻り値
 * @param {Array} args.periods forecast.buildPeriods の戻り値
 * @returns {{periods:Array, undated:Array, unknownWho:Array, counts:object, notes:string[]}}
 */
export function findFutureShortfalls({ shortfalls, periods } = {}) {
  const rows = arr(shortfalls).filter(isObj);
  const ps = arr(periods).filter(isObj);

  const buckets = ps.map((p) => ({
    index: num(p.index) == null ? 0 : Number(p.index),
    label: str(p.label),
    fromMs: num(p.fromMs),
    toMs: num(p.toMs),
    items: [],
  }));

  const unknownWho = [];
  const undated = [];
  const counts = {
    total: rows.length, inPeriods: 0, undated: 0, unknownWho: 0,
    noOne: 0, capacity: 0, singlePerson: 0,
  };

  rows.forEach((row) => {
    const kind = str(row.kind);
    if (kind === SHORTFALL.NO_ONE) counts.noOne += 1;
    else if (kind === SHORTFALL.CAPACITY) counts.capacity += 1;
    else if (kind === SHORTFALL.SINGLE_PERSON) counts.singlePerson += 1;

    // 🚨 「分かりません」は期間へ入れない。別の箱へ。
    if (kind === SHORTFALL.UNKNOWN) {
      unknownWho.push({ ...row, periodIndex: null, periodLabel: null });
      counts.unknownWho += 1;
      return;
    }

    const due = num(row.earliestDueMs);
    const at = due == null
      ? -1
      : buckets.findIndex((b) => b.fromMs != null && b.toMs != null && due >= b.fromMs && due < b.toMs);
    if (at < 0) {
      // 納期線が無い、または見ている期間の外。数え落としを見えるようにする。
      undated.push({ ...row, periodIndex: null, periodLabel: null });
      counts.undated += 1;
      return;
    }
    buckets[at].items.push({ ...row, periodIndex: buckets[at].index, periodLabel: buckets[at].label });
    counts.inPeriods += 1;
  });

  const bySeverity = (a, b) => {
    const da = num(a.earliestDueMs);
    const db = num(b.earliestDueMs);
    const va = da == null ? Infinity : da;
    const vb = db == null ? Infinity : db;
    if (va !== vb) return va - vb;
    const sa = num(a.shortMinutes);
    const sb = num(b.shortMinutes);
    const wa = sa == null ? -1 : sa;
    const wb = sb == null ? -1 : sb;
    if (wa !== wb) return wb - wa;
    return cmpStr(str(a.processKey), str(b.processKey));
  };
  buckets.forEach((b) => b.items.sort(bySeverity));
  undated.sort(bySeverity);
  unknownWho.sort((a, b) => cmpStr(str(a.processKey), str(b.processKey)));

  const notes = [
    '「誰が持てるか分かりません」は、担当できる人が0人という意味ではありません。別の箱に分けて数えています。',
  ];
  if (counts.undated > 0) {
    notes.push(`納期線が無い、または見ている期間の外にある不足が ${counts.undated}件あります。期間の表には出していません。`);
  }
  if (counts.unknownWho > 0) {
    notes.push(`誰が持てるか分からない工程が ${counts.unknownWho}件あります。まずここを調べるのが先です。`);
  }

  return { periods: buckets, undated, unknownWho, counts, notes };
}

// -----------------------------------------------------------------------------
// 2. OJT の候補（F3-② / T034）
// -----------------------------------------------------------------------------
/** 名簿を名前の一覧にする。同じ名前は1人として扱う（画面は名前で人を見分けるため）。 */
function rosterNames(workers) {
  const seen = new Set();
  const out = [];
  arr(workers).forEach((w) => {
    const n = isObj(w) ? trimmed(w.name) : trimmed(w);
    if (!n || seen.has(n)) return;
    seen.add(n);
    out.push(n);
  });
  return out.sort(cmpStr);
}

/**
 * その工程を「指導できる人」。
 * 実績（provisional_id / provisional_name）か、正式な力量（certified）がある人だけ。
 * 🚨 総量シナリオ（mode:'all'）が付ける assumed:true / evidence:'unknown' の人は入れない。
 *    あれは「全員が全工程を担当する仮定」であって、教えられるという裏付けではない。
 */
function mentorPoolOf(eligibility, processKey) {
  const fn = isObj(eligibility) && typeof eligibility.eligibleFor === 'function'
    ? eligibility.eligibleFor.bind(eligibility)
    : null;
  if (!fn) return null;   // 🚨 調べようがない。0人にしない。
  let list;
  try {
    list = fn(str(processKey));
  } catch {
    return null;
  }
  const src = Array.isArray(list) ? list : (list instanceof Set ? [...list] : null);
  if (src == null) return null;
  // ⚠ 複製してから並べ替える。渡された配列を書き換えない。
  return [...src]
    .filter(isObj)
    .filter((c) => c.assumed !== true && str(c.evidence) !== 'unknown' && trimmed(c.name))
    .map((c) => ({ name: trimmed(c.name), evidence: str(c.evidence) }))
    .sort((a, b) => (EVIDENCE_RANK[a.evidence] ?? 9) - (EVIDENCE_RANK[b.evidence] ?? 9) || cmpStr(a.name, b.name));
}

/**
 * ⭐ 星取表の「教えられる」の印を、工程 → 名前の一覧 に畳む。
 *
 * なぜ要るか:
 *   これまで指導する人は mentorPoolOf（＝その工程の記録が1件でもある人）から選んでいた。
 *   記録が有る事と、教えられる事は別物。「教えられる」は管理者が付ける **人の判断** で、
 *   星取表(starChart.js)に既に在る。それを1行も読んでいなかった。
 *
 * 🚨 渡されなくても壊れない事:
 *   skillMarks が null / 空 / 形が違う → null を返す。呼ぶ側は今までどおり
 *   mentorPoolOf の結果で動く（渡ってこない画面が1つも壊れない）。
 * 🚨 取消(retract)された印は入らない（deriveTeachMarks が最後の doc で決める）。
 *
 * @param {Array} skillMarks skill_marks の doc の山
 * @returns {Map<string, string[]>|null} 工程 → 指名された人の名前（名前順）
 */
function teachMarksByProcess(skillMarks) {
  if (!Array.isArray(skillMarks) || skillMarks.length === 0) return null;
  let derived;
  try {
    derived = deriveTeachMarks(skillMarks);
  } catch {
    return null;   // 🚨 読めない物は「分かりません」。0人にしない。
  }
  if (!derived || !(derived.byKey instanceof Map)) return null;
  const byProcess = new Map();
  // 鍵の文字列(worker||processKey)は割り戻さない（区切り文字の割り方事故を避ける。
  // starChart.js:282 と同じ流儀で、doc から (worker, processKey) の組を集めて引く）。
  skillMarks.forEach((d) => {
    if (!isObj(d)) return;
    const worker = trimmed(d.worker);
    const processKey = typeof d.processKey === 'string' ? d.processKey : '';
    if (!worker || !processKey) return;
    const st = derived.byKey.get(`${worker}||${processKey}`);
    if (!st || !st.taught) return;
    let list = byProcess.get(processKey);
    if (!list) { list = []; byProcess.set(processKey, list); }
    if (!list.includes(worker)) list.push(worker);
  });
  byProcess.forEach((list) => list.sort(cmpStr));
  return byProcess.size > 0 ? byProcess : null;
}

/** その工程に残っている実際の仕事。🚨 練習用の架空ロットは作らない。 */
function realJobsOf(jobs, processKey) {
  const key = str(processKey);
  return arr(jobs)
    .filter(isObj)
    .filter((j) => str(j.processKey) === key)
    .map((j) => ({
      jobId: str(j.jobId),
      lotId: str(j.lotId),
      dueLineMs: num(j.dueLineMs),
      durationMs: j.durationKnown === false ? null : num(j.durationMs),
    }))
    .sort((a, b) => {
      const va = a.dueLineMs == null ? Infinity : a.dueLineMs;
      const vb = b.dueLineMs == null ? Infinity : b.dueLineMs;
      if (va !== vb) return va - vb;
      return cmpStr(a.jobId, b.jobId) || cmpStr(a.lotId, b.lotId);
    });
}

/**
 * OJT の候補を組む。**T034 の4条件が全部そろった時だけ** 候補にする。
 *   ① 実ロットがある（練習用の架空ロットを作らない）
 *   ② 指導できる人が居る（その工程の実績か、正式な力量がある）
 *   ③ 受ける人が居る（その工程の記録がまだ無い人）
 *   ④ 両方に空きがある（🚨 片方だけでは足りない。2人同時に埋まるため）
 * 1つでも欠けたら候補にせず、**何が欠けているか** を rejected に返す。
 *
 * 🚨 空きの判定は「空き − 予備時間」で見る（CONTRACT.md 38行「教育へ全余力を使い切らない」）。
 *    予備時間は policy.provisionalReserveMinutesPerDay（暫定60分/人日）を**引数で**受け取る。
 *    渡されなければ判定せず、候補にしない（勝手に0分にすると、余力を使い切る案が出る）。
 *
 * ⚠ 所要時間の割り増し（durationMultiplier）について:
 *    今の simulate.js は OJT でも所要時間を伸ばさない（2人が同時に埋まるだけ・S22）。
 *    だから既定は 1 とし、1 以外を渡された時は
 *    「画面に出すだけで、計算には効いていない」と unknowns に必ず書く。
 *
 * @param {object} args
 * @param {Array} args.shortfalls forecast.findShortfalls の戻り値
 * @param {object} args.eligibility historyEligibility.buildEligibility の戻り値
 * @param {Array} args.workers 今いる人 [{name}]
 * @param {Array} [args.jobs] buildJobs の戻り値。実ロットの裏付けはこれで取る
 * @param {Array} [args.lots] ロットの題名など画面用。実ロットの裏付けには使わない
 * @param {object} [args.freeMinutesByWorker] { 名前: その期間に空いている分 }
 * @param {number} [args.reserveMinutesPerDay] policy.provisionalReserveMinutesPerDay（暫定）
 * @param {number} [args.horizonDays] 予備を何日ぶん取り置くか
 * @param {number} [args.durationMultiplier] 受ける人ぶんの割り増し。既定 1
 * @param {number} [args.baseNow] 基準時刻。持ち回すだけ（この関数は時計を読まない）
 * @param {Array} [args.skillMarks] ⭐ 星取表の「教えられる」の印（skill_marks の doc の山）。
 *   渡すと、指導する人が「その工程の記録が1件でもある人」から
 *   **管理者が指名した「教えられる」の人** へ変わる。
 *   🚨 渡さなければ今までどおり動く（この引数が無い画面が1つも壊れない）。
 *   🚨 受ける人の候補は、これまでどおり **記録の有無** で決める（指名では決めない）。
 *      指名で決めると、記録のある人まで受ける側へ回ってしまう。
 * @returns {{candidates:Array, rejected:Array, notes:string[]}}
 */
export function buildOjtCandidates({
  shortfalls,
  eligibility,
  workers,
  jobs = null,
  lots = null,
  freeMinutesByWorker = null,
  reserveMinutesPerDay = null,
  horizonDays = null,
  durationMultiplier = null,
  baseNow = null,
  skillMarks = null,
} = {}) {
  const teachByProcess = teachMarksByProcess(skillMarks);
  const roster = rosterNames(workers);
  const days = num(horizonDays) == null ? 1 : Math.max(1, Number(horizonDays));
  const reservePerDay = num(reserveMinutesPerDay);
  const reserveMinutes = reservePerDay == null ? null : round1(reservePerDay * days);
  const mult = num(durationMultiplier) == null ? 1 : Number(durationMultiplier);
  const jobsGiven = Array.isArray(jobs);
  const lotTitleById = new Map();
  arr(lots).filter(isObj).forEach((l) => {
    const id = str(l.lotId ?? l.id ?? l.__id);
    if (id) lotTitleById.set(id, str(l.model ?? l.name ?? ''));
  });

  const freeOf = (name) => {
    if (!isObj(freeMinutesByWorker)) return null;
    return num(freeMinutesByWorker[name]);
  };

  const candidates = [];
  const rejected = [];

  arr(shortfalls).filter(isObj).forEach((sf) => {
    const kind = str(sf.kind);
    // 🚨 「誰が持てるか分かりません」は OJT の入口にしない。
    //    誰に教えてもらうかも分からないのに、人を2人押さえる案は作れない。
    if (kind === SHORTFALL.UNKNOWN) return;

    const processKey = str(sf.processKey);
    const title = str(sf.title);
    const missing = [];

    // ── ① 実ロット ────────────────────────────────────────────────────────
    let job = null;
    if (!jobsGiven) {
      missing.push(OJT_GAP.REAL_LOT_UNKNOWN);
    } else {
      const list = realJobsOf(jobs, processKey);
      if (list.length === 0) missing.push(OJT_GAP.NO_REAL_LOT);
      else {
        job = list.find((j) => j.durationMs != null && j.durationMs > 0) || null;
        if (!job) missing.push(OJT_GAP.DURATION_UNKNOWN);
      }
    }
    const occupancyMinutes = job ? round1((job.durationMs / 60000) * mult) : null;

    // ── ② 指導できる人 ────────────────────────────────────────────────────
    // まず「その工程の記録がある人」を出す。これは受ける人を決める為にも要るので必ず出す。
    const recordPool = mentorPoolOf(eligibility, processKey);
    // ⭐ 指名があればそちらが勝つ。指名は管理者の判断＝記録より強い根拠。
    //    名簿に居ない名前は候補にしない（人を割り当てられないため）。
    const nominated = teachByProcess
      ? arr(teachByProcess.get(processKey)).filter((n) => roster.includes(n))
      : [];
    const mentors = nominated.length > 0
      ? nominated.map((n) => ({ name: n, evidence: 'teach' }))
      : recordPool;
    if (mentors == null || mentors.length === 0) missing.push(OJT_GAP.NO_MENTOR);

    // ── ③ 受ける人（この工程の記録がまだ無い人） ──────────────────────────
    // 🚨 ここは **記録の有無** で決める。指名で決めない。
    //    指名した人だけを外すと、記録のある人まで受ける側へ回ってしまう。
    const hasRecord = new Set((recordPool || []).map((m) => m.name));
    const trainees = roster.filter((n) => !hasRecord.has(n));
    if (trainees.length === 0) missing.push(OJT_GAP.NO_TRAINEE);

    // ── ④ 両方の空き ─────────────────────────────────────────────────────
    if (reserveMinutes == null) missing.push(OJT_GAP.RESERVE_UNKNOWN);
    const roomOf = (name) => {
      const free = freeOf(name);
      if (free == null || reserveMinutes == null) return null;   // 分かりません
      return round1(free - reserveMinutes);
    };
    const fits = (name) => {
      const room = roomOf(name);
      if (room == null || occupancyMinutes == null) return null;
      return room >= occupancyMinutes;
    };

    let mentor = null;
    let trainee = null;
    // 🚨 空きを判定できる材料（何分押さえるか・予備は何分か）がそろっている時だけ、
    //    空き不足の札を付ける。材料が無いのに「空きが足りません」と書くと嘘になる。
    if (occupancyMinutes != null && reserveMinutes != null) {
      const pool = mentors || [];
      const okMentors = pool.filter((m) => fits(m.name) === true);
      if (okMentors.length === 0 && pool.length > 0) {
        missing.push(pool.some((m) => fits(m.name) == null) ? OJT_GAP.FREE_TIME_UNKNOWN : OJT_GAP.MENTOR_NO_ROOM);
      }
      // 空きの多い人から。同じなら根拠の強い人、それも同じなら名前順。
      const pickedMentor = [...okMentors].sort((a, b) => {
        const ra = roomOf(a.name);
        const rb = roomOf(b.name);
        if (ra !== rb) return rb - ra;
        return (EVIDENCE_RANK[a.evidence] ?? 9) - (EVIDENCE_RANK[b.evidence] ?? 9) || cmpStr(a.name, b.name);
      })[0] || null;
      mentor = pickedMentor ? pickedMentor.name : null;

      const okTrainees = trainees.filter((n) => n !== mentor && fits(n) === true);
      if (okTrainees.length === 0 && trainees.length > 0) {
        missing.push(trainees.some((n) => fits(n) == null) ? OJT_GAP.FREE_TIME_UNKNOWN : OJT_GAP.TRAINEE_NO_ROOM);
      }
      trainee = [...okTrainees].sort((a, b) => {
        const ra = roomOf(a);
        const rb = roomOf(b);
        if (ra !== rb) return rb - ra;
        return cmpStr(a, b);
      })[0] || null;
    }

    if (missing.length > 0 || !mentor || !trainee || !job) {
      const uniq = [...new Set(missing)];
      // 🚨 理由の無い却下を作らない。黙って消すのと同じになる。
      if (uniq.length === 0) uniq.push(OJT_GAP.FREE_TIME_UNKNOWN);
      rejected.push({
        kind: EDUCATION_KIND.OJT,
        processKey,
        title,
        shortfallKind: kind,
        missing: uniq,
        missingLabels: uniq.map((m) => OJT_GAP_LABEL[m] || m),
        mentorOptions: (mentors || []).map((m) => m.name),
        traineeOptions: trainees,
        lotId: job ? job.lotId : null,
        occupancyMinutes,
        why: `OJTの候補にしていません（${uniq.map((m) => OJT_GAP_LABEL[m] || m).join(' / ')}）。`,
      });
      return;
    }

    const mentorFree = freeOf(mentor);
    const traineeFree = freeOf(trainee);
    const evidence = [
      `この工程は不足として挙がっています（${sf.why ? str(sf.why) : str(kind)}）。`,
      `実際に残っている仕事に乗せます（ロット ${job.lotId} / 仕事 ${job.jobId}）。練習用の架空ロットは作っていません。`,
      (mentors.find((m) => m.name === mentor) || {}).evidence === 'teach'
        ? `${mentor} さんは管理者から「教えられる」と指名されています（星取表の印）。`
        : `${mentor} さんはこの工程の裏付けがあります（${(mentors.find((m) => m.name === mentor) || {}).evidence}）。`,
      `${trainee} さんはこの工程の記録がまだありません。分かりません、という意味です。`,
      `2人を同時に ${occupancyMinutes}分 押さえます（指導する人と受ける人の両方）。`,
      `予備時間として1人1日 ${reservePerDay}分 × ${days}日 = ${reserveMinutes}分 を残したうえで空きを見ています（暫定）。`,
    ];
    const unknowns = [
      '予備時間 60分/人日 は暫定です。過去の突発対応で確かめるまで、この数字は仮です。',
      'OJT を終えても単独可にはなりません。認定は人が別に決めます（この画面は提案だけです）。',
    ];
    if (mult !== 1) {
      unknowns.push(
        `受ける人ぶんの割り増し ${mult}倍 は画面に出しているだけで、いまの計算には効いていません`
        + '（simulate.js は OJT でも所要時間を伸ばさず、2人が同時に埋まるだけです）。',
      );
    }

    candidates.push({
      kind: EDUCATION_KIND.OJT,
      processKey,
      title,
      shortfallKind: kind,
      earliestDueMs: num(sf.earliestDueMs),
      shortMinutes: num(sf.shortMinutes),
      lotId: job.lotId,
      lotTitle: lotTitleById.get(job.lotId) || null,
      jobId: job.jobId,
      mentor,
      trainee,
      occupancyMinutes,
      durationMultiplier: mult,
      /** 🚨 いまのエンジンは所要時間を伸ばさない。1以外を渡しても計算には効かない。 */
      durationMultiplierAppliedByEngine: mult === 1,
      // 🚨 T033: 指導する人と受ける人の**両方**が減る。片方だけ減らす実装はここで落ちる。
      mentorFreeMinutes: mentorFree,
      traineeFreeMinutes: traineeFree,
      mentorFreeMinutesAfter: mentorFree == null ? null : round1(mentorFree - occupancyMinutes),
      traineeFreeMinutesAfter: traineeFree == null ? null : round1(traineeFree - occupancyMinutes),
      reserveMinutes,
      reserveMinutesPerDay: reservePerDay,
      reserveProvisional: true,
      mentorOptions: mentors.map((m) => m.name),
      /** ⭐ 指導する人をどこから選んだか。'teach-mark' = 管理者の指名 / 'history' = その工程の記録。 */
      mentorFrom: nominated.length > 0 ? 'teach-mark' : 'history',
      traineeOptions: trainees,
      baseNow: num(baseNow),
      requiresManagerApproval: true,
      evidence,
      unknowns,
      why: `${mentor} さんが ${trainee} さんに付いて、ロット ${job.lotId} の「${title}」を一緒にやります（2人で ${occupancyMinutes}分）。`,
    });
  });

  const bySeverity = (a, b) => {
    const va = a.earliestDueMs == null ? Infinity : a.earliestDueMs;
    const vb = b.earliestDueMs == null ? Infinity : b.earliestDueMs;
    if (va !== vb) return va - vb;
    const wa = a.shortMinutes == null ? -1 : a.shortMinutes;
    const wb = b.shortMinutes == null ? -1 : b.shortMinutes;
    if (wa !== wb) return wb - wa;
    return cmpStr(a.processKey, b.processKey);
  };
  candidates.sort(bySeverity);
  rejected.sort((a, b) => cmpStr(a.processKey, b.processKey));

  const notes = [
    '🚨 ここは提案だけです。力量の設定は1つも書き換えていません。',
    '🚨 OJT中は指導する人と受ける人の2人が同時に埋まります。片方だけの計算にしていません。',
  ];
  if (teachByProcess) {
    notes.push('⭐ 指導する人は、管理者が星取表で指名した「教えられる」の人から選んでいます（記録の有無ではありません）。');
  } else {
    notes.push('⭐「教えられる」の指名（星取表の印）を渡されていないので、指導する人はその工程の記録から選んでいます。');
  }
  if (!jobsGiven) notes.push('残っている仕事の一覧（jobs）を渡されていないので、実ロットの裏付けが取れていません。');
  if (reserveMinutes == null) notes.push('予備時間（policy.provisionalReserveMinutesPerDay）を渡されていないので、候補を1件も作っていません。');
  if (!isObj(freeMinutesByWorker)) notes.push('空き分数を渡されていないので、空きの有無は分かりません。');

  return { candidates, rejected, notes };
}

// -----------------------------------------------------------------------------
// 3. simulate.js がそのまま食える形へ（scenario.ojt）
// -----------------------------------------------------------------------------
/**
 * 候補から `scenario.ojt` の配列を組む。
 *
 * simulate.js（297〜305行）はこう読む:
 *   for (const row of (Array.isArray(scenario.ojt) ? scenario.ojt : [])) {
 *     const key = String(row?.processKey ?? '');
 *     const mentor = trimmedName(row?.mentor);
 *     const trainee = trimmedName(row?.trainee);
 *     if (!key || !mentor || !trainee || mentor === trainee) continue;
 *     if (!ojtByProcess.has(key)) ojtByProcess.set(key, { mentor, trainee });
 *   }
 * つまり ①3つの鍵だけ ②空は捨てられる ③同じ人は不可（mentor === trainee で捨てられる）
 * ④同じ工程は**先に来た1件だけ**が生きる。だからここで工程の重複を先に落としておく。
 *
 * 🚨 1人が同時に2組へ入る行は作らない。人は同時に1つの仕事しか持てない
 *    （simulate.js は holderOf に1件しか入れられない）。
 *
 * 🚨 maxPairs（policy.maxOjtPairsPerDay）を自前で 1 と書かない。渡されなければ**落とす**。
 *    黙って0件を返すと「候補が無かった」と読めてしまい、設定漏れが誰にも見えない。
 *
 * @param {object} args
 * @param {Array} args.candidates buildOjtCandidates の candidates
 * @param {number} args.maxPairs policy.maxOjtPairsPerDay
 * @returns {Array<{processKey:string, mentor:string, trainee:string}>}
 */
export function buildOjtScenario({ candidates, maxPairs } = {}) {
  const limit = num(maxPairs);
  if (limit == null || limit < 0 || !Number.isInteger(limit)) {
    throw new Error(
      'education.buildOjtScenario: maxPairs（policy.maxOjtPairsPerDay）を渡してください。'
      + ' 0以上の整数です。ここで既定値を作ると、設定と画面が食い違います。',
    );
  }
  const rows = [];
  const usedProcess = new Set();
  const usedPerson = new Set();
  arr(candidates).filter(isObj).forEach((c) => {
    if (rows.length >= limit) return;
    if (str(c.kind) !== EDUCATION_KIND.OJT) return;
    const processKey = str(c.processKey);
    const mentor = trimmed(c.mentor);
    const trainee = trimmed(c.trainee);
    if (!processKey || !mentor || !trainee || mentor === trainee) return;
    if (usedProcess.has(processKey)) return;
    if (usedPerson.has(mentor) || usedPerson.has(trainee)) return;
    usedProcess.add(processKey);
    usedPerson.add(mentor);
    usedPerson.add(trainee);
    rows.push(Object.freeze({ processKey, mentor, trainee }));
  });
  return Object.freeze(rows);
}

// -----------------------------------------------------------------------------
// 4. 教育を入れて悪くなっていないか（T035）
// -----------------------------------------------------------------------------
/**
 * 教育（OJT）を入れた結果を、通常と**同じ土俵で**比べる。
 *
 * 🚨 効果の数字を持てるのは、同じ土俵（入力の指紋と基準時刻が一致）で計算済みの物だけ。
 *    未計算・土俵違いは `deltaAtRisk: null`。参考値も出さない（必ず1人歩きする）。
 * 🚨 5日内の危険が**増える**案は推奨しない（仕様書6章 C5 / T035）。
 * 🚨 差が0の時に「改善した」と書かない（12章-7）。
 *
 * @param {object} args
 * @param {object} args.baseline 通常の ScenarioMetrics
 * @param {object} args.withOjt 教育を入れた ScenarioMetrics
 * @param {Array} [args.shortfalls] 何に効かせたいか（根拠として数だけ載せる）
 * @param {number} [args.horizonDays] 何日で測ったか
 * @returns {{recommended:boolean, why:string, deltaAtRisk:number|null, comparable:boolean,
 *            worsenedKeys:string[], horizonDays:number|null, evidence:string[], unknowns:string[]}}
 */
export function recommendEducation({ baseline, withOjt, shortfalls = null, horizonDays = null } = {}) {
  const days = num(horizonDays);
  const cmp = compareScenarios(baseline, withOjt);
  const evidence = [];
  const unknowns = [];
  const sfCount = arr(shortfalls).filter(isObj).length;
  if (sfCount > 0) evidence.push(`将来 足りなくなる工程として ${sfCount}件 が挙がっています。`);

  if (!cmp.comparable) {
    return {
      recommended: false,
      why: `同じ土俵で計算した結果がそろっていないので、教育を勧めません（${str(cmp.reason)}）。`,
      deltaAtRisk: null,
      comparable: false,
      worsenedKeys: [],
      horizonDays: days,
      evidence,
      unknowns: [...unknowns, '同じ入力・同じ基準時刻で計算し直すまで、効果の数字は出せません。'],
    };
  }

  const detail = isObj(cmp.detail) ? cmp.detail : {};
  const atRisk = isObj(detail.atRiskLotCount) ? detail.atRiskLotCount : null;
  const deltaAtRisk = atRisk && atRisk.delta != null ? Number(atRisk.delta) : null;

  const worsenedKeys = [];
  NON_DEGRADATION_KEYS.forEach((k) => {
    const d = isObj(detail[k]) ? detail[k] : null;
    if (!d) return;
    if (d.delta != null && d.delta > 0) { worsenedKeys.push(k); return; }
    // 片方だけ測れていない = 良し悪しを言えない。黙って「良い」に倒さない。
    if (d.delta == null && d.changed === true) unknowns.push(`${k} は片方が測れていないので、良し悪しを言えません。`);
  });

  if (deltaAtRisk == null) {
    unknowns.push('納期が危ないロットの数を、どちらか一方で測れていません。');
  }
  if (days != null && days !== 5) {
    unknowns.push(`この判定は ${days}日 で測った物です。T035 が言う「5日内」の土俵とは違います。`);
  }
  if (days == null) {
    unknowns.push('何日で測ったかを渡されていません。5日内の判定かどうか分かりません。');
  }

  if (worsenedKeys.length > 0) {
    const names = {
      atRiskLotCount: '納期が危ないロット',
      futureLateLotCount: 'この先 遅れるロット',
      unresolvedDueLotCount: '手が付かず納期を持つロット',
    };
    return {
      recommended: false,
      why: `教育を入れると ${worsenedKeys.map((k) => names[k] || k).join('・')} が増えます。この案は勧めません。`,
      deltaAtRisk,
      comparable: true,
      worsenedKeys,
      horizonDays: days,
      evidence: [...evidence, ...worsenedKeys.map((k) => `${names[k] || k}: ${detail[k].base} → ${detail[k].other}`)],
      unknowns,
    };
  }

  if (deltaAtRisk != null && deltaAtRisk < 0) {
    return {
      recommended: true,
      why: `教育を入れても納期が危ないロットは増えず、${Math.abs(deltaAtRisk)}件 減ります。`,
      deltaAtRisk,
      comparable: true,
      worsenedKeys: [],
      horizonDays: days,
      evidence: [...evidence, `納期が危ないロット: ${detail.atRiskLotCount.base} → ${detail.atRiskLotCount.other}`],
      unknowns,
    };
  }

  return {
    recommended: true,
    why: '教育を入れても、いま見ている範囲で悪くなる所はありません（差はありません）。将来の備えとして進められます。',
    deltaAtRisk,
    comparable: true,
    worsenedKeys: [],
    horizonDays: days,
    evidence: [...evidence, '悪化した指標はありません。改善した、とも書いていません（差が0のため）。'],
    unknowns,
  };
}

// -----------------------------------------------------------------------------
// 5. 動画＋確認テストの候補（F3-⑤）
// -----------------------------------------------------------------------------
/**
 * 講座（動画・資料＋確認テスト）の候補。
 *
 * 🚨 工程と講座の結び付けが無ければ**空を返す**。題名が似ているからと結び付けない。
 *    別の資料の別のページを事実として指示する事になる（knowledgeCourses.js の chapterTarget と同じ考え）。
 *
 * ⚠ いまの knowledge_courses に「どの工程の講座か」という項目はありません。
 *   だから結び付けは呼ぶ側から受け取ります:
 *     ・course.processKeys（配列）… 講座側に項目を足した場合
 *     ・linkOf(processKey) → 講座IDの配列 … 別表で持つ場合
 *   どちらも無ければ 0件です（無理に結び付けません）。
 *
 * @param {object} args
 * @param {Array} args.shortfalls forecast.findShortfalls の戻り値
 * @param {Array} args.courses knowledge_courses の生データ
 * @param {(processKey:string)=>string[]} [args.linkOf] 工程 → 講座ID
 * @param {object} [args.eligibility] 受ける人を出す時だけ使う
 * @param {Array} [args.workers] 受ける人を出す時だけ使う
 * @returns {{candidates:Array, rejected:Array, notes:string[]}}
 */
export function buildStudyCandidates({
  shortfalls, courses, linkOf = null, eligibility = null, workers = null,
} = {}) {
  // ⚠ normalizeCourse は決まった項目だけを残すので、結び付け（processKeys）は
  //   **元の物** から読む。正規化した後の物だけを見ると、結び付けが黙って消える。
  const list = arr(courses).filter(isObj).map((raw) => ({ raw, course: normalizeCourse(raw) }));
  const byId = new Map(list.map((e) => [str(e.course.id), e]));
  const roster = rosterNames(workers);

  const candidates = [];
  const rejected = [];
  let linkedCount = 0;

  arr(shortfalls).filter(isObj).forEach((sf) => {
    const processKey = str(sf.processKey);
    const title = str(sf.title);

    const ids = new Set();
    if (typeof linkOf === 'function') {
      let got = null;
      try { got = linkOf(processKey); } catch { got = null; }
      arr(got).forEach((id) => { const s = str(id); if (s) ids.add(s); });
    }
    list.forEach((e) => {
      const keys = Array.isArray(e.raw.processKeys) ? e.raw.processKeys : [];
      if (keys.map(str).includes(processKey)) ids.add(str(e.course.id));
    });

    if (ids.size === 0) {
      rejected.push({
        kind: EDUCATION_KIND.STUDY,
        processKey,
        title,
        missing: [STUDY_GAP.NO_COURSE_LINK],
        missingLabels: [STUDY_GAP_LABEL[STUDY_GAP.NO_COURSE_LINK]],
        why: STUDY_GAP_LABEL[STUDY_GAP.NO_COURSE_LINK],
      });
      return;
    }
    linkedCount += 1;

    const hasRecord = new Set((mentorPoolOf(eligibility, processKey) || []).map((m) => m.name));
    const learners = roster.length ? roster.filter((n) => !hasRecord.has(n)) : null;

    [...ids].sort(cmpStr).forEach((id) => {
      const entry = byId.get(id);
      const course = entry ? entry.course : null;
      if (!course) {
        rejected.push({
          kind: EDUCATION_KIND.STUDY,
          processKey,
          title,
          courseId: id,
          missing: [STUDY_GAP.NO_COURSE_LINK],
          missingLabels: [`結び付いている講座 ${id} が一覧にありません`],
          why: `結び付いている講座 ${id} が一覧にありません。`,
        });
        return;
      }
      if (!isPublished(course)) {
        rejected.push({
          kind: EDUCATION_KIND.STUDY,
          processKey,
          title,
          courseId: id,
          courseTitle: course.title,
          missing: [STUDY_GAP.NO_PUBLISHED_COURSE],
          missingLabels: [STUDY_GAP_LABEL[STUDY_GAP.NO_PUBLISHED_COURSE]],
          why: STUDY_GAP_LABEL[STUDY_GAP.NO_PUBLISHED_COURSE],
        });
        return;
      }
      const questionCount = courseQuestionCount(course);
      const unknowns = [
        '動画を見て確認テストに通っても、単独でやれる事にはなりません（仕様書12章-8）。',
      ];
      if (questionCount === 0) unknowns.push('この講座には確認テストがまだありません。');
      if (!(course.estMin > 0)) unknowns.push('この講座にかかる時間が登録されていません。');
      if (learners == null) unknowns.push('今いる人の名簿を渡されていないので、誰に出すかは決めていません。');

      candidates.push({
        kind: EDUCATION_KIND.STUDY,
        processKey,
        title,
        shortfallKind: str(sf.kind),
        earliestDueMs: num(sf.earliestDueMs),
        courseId: str(course.id),
        courseTitle: course.title,
        chapterCount: arr(course.chapters).length,
        fileCount: arr(course.files).length,
        questionCount,
        passNeeded: passNeeded(questionCount, QUIZ_PASS_RATIO),
        passRatio: QUIZ_PASS_RATIO,
        estMin: course.estMin > 0 ? course.estMin : null,
        learners,
        lotId: null,
        mentor: null,
        trainee: null,
        occupancyMinutes: null,
        requiresManagerApproval: true,
        evidence: [
          `工程「${title}」と講座「${course.title}」は、結び付けの設定で結ばれています（題名では結んでいません）。`,
          `確認テストは ${questionCount}問、${passNeeded(questionCount, QUIZ_PASS_RATIO)}問 で通ります。`,
        ],
        unknowns,
        why: `工程「${title}」に結び付いた講座「${course.title}」を見てもらう案です。`,
      });
    });
  });

  candidates.sort((a, b) => {
    const va = a.earliestDueMs == null ? Infinity : a.earliestDueMs;
    const vb = b.earliestDueMs == null ? Infinity : b.earliestDueMs;
    if (va !== vb) return va - vb;
    return cmpStr(a.processKey, b.processKey) || cmpStr(a.courseId, b.courseId);
  });
  rejected.sort((a, b) => cmpStr(a.processKey, b.processKey) || cmpStr(str(a.courseId), str(b.courseId)));

  const notes = [
    '🚨 工程と講座の結び付けが無い所は、無理に結び付けず0件にしています。',
    '🚨 動画と確認テストだけで単独可にはしません（仕様書12章-8）。',
  ];
  if (linkedCount === 0) notes.push('結び付いている工程が1件もありませんでした。まず結び付けの設定が要ります。');

  return { candidates, rejected, notes };
}

export default {
  EDUCATION_KIND,
  OJT_GAP,
  OJT_GAP_LABEL,
  STUDY_GAP,
  STUDY_GAP_LABEL,
  findFutureShortfalls,
  buildOjtCandidates,
  buildOjtScenario,
  recommendEducation,
  buildStudyCandidates,
};
