// =============================================================================
//  educationLeadTime.js — 「今から教育を始めれば間に合うか」だけを出す（読み取り専用）
// -----------------------------------------------------------------------------
//  清水さんの指示（2026-09-01 原文）:
//    「月毎でやるのは、必要な人材がわかるのと教育するのに必要な時間とか人材もわかっても
//      一週間前だと間に合わないけど、一月前にわかったら準備する時間もあるから間に合うからね」
//  ＝ 月毎にする理由そのもの。ここが空だと月毎にする意味が半分無い。
//
//  出す物の形はこれ1つだけ（増やさない）:
//    A = その工程が足りなくなる日 ＝ その月の、その工程の一番早い納期線
//    B = 今日 + 一人前までに要る営業日数
//    判定: B ≦ A なら「今から始めれば間に合う」
//
//  🚨 いちばん大事な決まり — 数字の出どころを必ず持ち回る:
//    B には出どころが3通りある。**どれで出したかを必ず値と一緒に返す**。
//      1) 'mark'   🎓の印から（いちばん正しい）… traineeSince → graduatedAt の実測
//      2) 'record' 実際の記録から（検定 ものさし×1.2 を3回続けて出せた所までを数えた値）
//      3) 'none'   出せない … その工程で判定できる組が無い
//    ・2 で出す時は「何人の・何件の記録から出たか」を必ず一緒に返す。
//      1人の記録しか無い時は basis.singleWorker が true になる（画面に出す為）。
//      2026-08-30 の実測では、合格した組の90%が1人の記録だった。
//    ・3 の時は **日付を1つも作らない**。代わりに「足りない材料」を返す。
//    ・leadDays が null なら startByMs も readyByMs も **必ず** null（片方だけ埋めない）。
//      これは sealRow() ただ1箇所で機械的に守る（人の注意力に頼らない）。
//
//  🚨 「一人前」の決め方は、この中で新しく作らない。
//    traineeProgress.js に既にある「ものさし×1.2以内を3回続けて出せた（検定）」を使う。
//    その判定済みの結果（recordCells）を **引数で受け取る**。ここで判定し直さない。
//
//  ⚠ 純関数だけ。現在時刻も乱数も読まない。Firestore も React も触らない。
//    「今日」は baseNowMs として引数で受け取る。
//  ⚠ 引数は1バイトも書き換えない（Object.freeze された物を渡されても落ちない）。
//
//  📅 営業日について（2026-09-02 に工場の暦を繋いだ）:
//    ここが数える営業日は既定で「月〜金・両端を含む」。
//    🚨 第3引数に工場の暦を畳んだ判定（domain/factoryCalendar.js の makeIsWorkday）を
//      渡すと、祝日・年末年始・お盆・全社休業を引き、休日出勤を足す。
//      渡さなければ 月〜金 のまま = **今までと1ミリも同じ**。
//    ⚠ 渡していない間は実際の営業日はここの数より少なく出る。
//      その事は holidaysKnown:false で notes / unknowns に必ず出す。
// =============================================================================

// 📅 工場の暦（祝日・年末年始・お盆・全社休業・休日出勤）。純関数だけ。
import { makeIsWorkday } from '../factoryCalendar.js';

// ── 出どころ ─────────────────────────────────────────────────────────────────
/** B（一人前までに要る営業日数）の出どころ。この3つ以外を作らない。 */
export const LEAD_SOURCE = Object.freeze({
  MARK: 'mark',
  RECORD: 'record',
  NONE: 'none',
});

/** 画面にそのまま出せる言い方。🚨 言い換えはここ1箇所に閉じ込める。 */
export const LEAD_SOURCE_LABEL = Object.freeze({
  mark: '🎓の印から（教育を始めた日と卒業した日の実測）',
  record: '実際の記録から（ものさし×1.2以内を3回続けて出せた所までを数えた値）',
  none: '出せません（この工程で判定できる組がありません）',
});

/** 出どころが 'none' の時に足りない材料。押すとその画面へ行ける様に screen を付ける。 */
export const LEAD_MATERIAL = Object.freeze({
  TRAINEE_MARK: 'trainee-mark',
  TEACH_MARK: 'teach-mark',
  GRADUATION: 'graduation',
});

const MATERIAL_LABEL = Object.freeze({
  'trainee-mark': '🎓の印',
  'teach-mark': '「教えられる」の指名',
  'graduation': '卒業の記録',
});

/** その材料を足しに行く画面。画面側はこの文字で行き先を決める。 */
const MATERIAL_SCREEN = Object.freeze({
  'trainee-mark': 'trainee',
  'teach-mark': 'star',
  'graduation': 'trainee',
});

// ── 小道具 ───────────────────────────────────────────────────────────────────
/**
 * 🚨 数として読む。読めなければ null。
 *   `Number(null)` は 0、`Number('')` も 0、`Number(false)` も 0。
 *   素直に書くと「渡していない」が「0日」に化ける（forecast.js / education.js と同じ罠）。
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
/** 🚨 localeCompare を使わない（端末の ICU の版で並びが変わると結果が変わる）。 */
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ── 営業日（月〜金・両端を含む） ──────────────────────────────────────────────
const DAY_MS = 86400000;
/** その時刻の「その日の 0時0分」。時刻の細かい所で判定が割れない様にする。 */
const startOfDay = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
/**
 * 🚨 2026-09-02: ここは **土日だけ** を見ていた。
 *   清水さんが月毎を求めた理由は「教育のリードタイム」なので、
 *   この逆算が祝日を営業日と数えると「今から始めれば間に合う」を多く出す。
 *   2026年9月は平日22日のうち3日が祝日 = 13.6% 多く見積もっていた。
 * ⚠ 渡さなければ 月〜金。**登録が空なら今までと1ミリも同じ**。
 */
const defaultIsWorkday = makeIsWorkday(null);
const worksOf = (fn) => (typeof fn === 'function' ? fn : defaultIsWorkday);

/**
 * from の日から to の日まで、月〜金の日数を数える（**両端を含む**）。
 * to が from より前なら 0。読めない時は null（0にしない＝「分かりません」を潰さない）。
 */
export function businessDaysBetween(fromMs, toMs, isWorkdayFn = null) {
  const isWorkday = worksOf(isWorkdayFn);
  const a = num(fromMs);
  const b = num(toMs);
  if (a == null || b == null) return null;
  let cur = startOfDay(a);
  const end = startOfDay(b);
  if (end < cur) return 0;
  let n = 0;
  // 日数の上限。壊れた入力で永久に回らない様にする（20年ぶん）。
  let guard = 0;
  while (cur <= end && guard < 8000) {
    if (isWorkday(cur)) n += 1;
    cur += DAY_MS;
    // 夏時間のある土地でも日がずれない様に、必ずその日の0時へ戻す。
    cur = startOfDay(cur);
    guard += 1;
  }
  return n;
}

/**
 * from から数えて n 営業日目の日（**両端を含む**数え方の逆）。
 * つまり businessDaysBetween(from, addBusinessDays(from, n)) === n になる。
 * n が 1 で from が月〜金なら、その日自身を返す。
 * 時刻は from の時刻をそのまま残す（勝手に0時や終業時刻を作らない）。
 */
export function addBusinessDays(fromMs, days, isWorkdayFn = null) {
  const isWorkday = worksOf(isWorkdayFn);
  const a = num(fromMs);
  const n = num(days);
  if (a == null || n == null || n < 1) return null;
  const need = Math.ceil(n);
  const timeOfDay = a - startOfDay(a);
  let cur = startOfDay(a);
  let counted = 0;
  let guard = 0;
  while (guard < 8000) {
    if (isWorkday(cur)) {
      counted += 1;
      if (counted >= need) return cur + timeOfDay;
    }
    cur = startOfDay(cur + DAY_MS);
    guard += 1;
  }
  return null;
}

/**
 * to から n 営業日ぶん **戻した** 日（両端を含む数え方の逆）。
 * businessDaysBetween(subBusinessDays(to, n), to) === n になる。
 * 「いつまでに始めれば間に合うか」に使う。
 */
export function subBusinessDays(toMs, days, isWorkdayFn = null) {
  const isWorkday = worksOf(isWorkdayFn);
  const b = num(toMs);
  const n = num(days);
  if (b == null || n == null || n < 1) return null;
  const need = Math.ceil(n);
  const timeOfDay = b - startOfDay(b);
  let cur = startOfDay(b);
  let counted = 0;
  let guard = 0;
  while (guard < 8000) {
    if (isWorkday(cur)) {
      counted += 1;
      if (counted >= need) return cur + timeOfDay;
    }
    cur = startOfDay(cur - DAY_MS);
    guard += 1;
  }
  return null;
}

/** 中央値。空なら null。 */
const medianOf = (list) => {
  const xs = list.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
};

// -----------------------------------------------------------------------------
// 1. 日付を1つも作らせない金庫（🚨 ここ1箇所で守る）
// -----------------------------------------------------------------------------
/** 行が持ってよい日付の鍵。増やしたらここにも足す事（足し忘れると穴になる）。 */
const DATE_KEYS = Object.freeze(['deadlineMs', 'readyByMs', 'startByMs']);

/**
 * 🚨 決まりを機械で守る。人の注意力に頼らない。
 *   ① leadDays が null なら、日付は **1つ残らず** null（片方だけ埋めない）
 *   ② 出どころが 'none' なら、日付は1つも出さない（作った様に見せない）
 *   ③ 出どころは必ず値と一緒に持つ（落とすと落ちる）
 * どれかを踏み外したら **throw する**。黙って直さない（黙って直すと欠陥が隠れる）。
 */
export function sealRow(row) {
  const r = { ...row };
  const source = str(r.source);
  if (!Object.values(LEAD_SOURCE).includes(source)) {
    throw new Error(
      `educationLeadTime.sealRow: source は ${Object.values(LEAD_SOURCE).join(' / ')} のどれか。`
      + ` 受け取った値: ${JSON.stringify(row && row.source)}。出どころを落とした値は返せません。`,
    );
  }
  r.sourceLabel = LEAD_SOURCE_LABEL[source];
  const lead = num(r.leadDays);
  if (lead == null || source === LEAD_SOURCE.NONE) {
    r.leadDays = null;
    r.leadDaysRaw = null;
    DATE_KEYS.forEach((k) => { r[k] = null; });
    r.inTime = null;
  }
  return r;
}

// -----------------------------------------------------------------------------
// 2. 材料をそろえる
// -----------------------------------------------------------------------------
/**
 * 🎓の印から出す実測。
 * @param {Array} graduations [{workerName, processKey, traineeSinceMs, graduatedAtMs}]
 */
function markLeadsByProcess(graduations, bdays) {
  const byKey = new Map();
  arr(graduations).filter(isObj).forEach((g) => {
    const key = str(g.processKey);
    const from = num(g.traineeSinceMs);
    const to = num(g.graduatedAtMs);
    const who = trimmed(g.workerName);
    if (!key || from == null || to == null || !who) return;
    const d = bdays(from, to);
    if (d == null || d < 1) return;
    let box = byKey.get(key);
    if (!box) { box = { days: [], workers: new Set(), records: 0 }; byKey.set(key, box); }
    box.days.push(d);
    box.workers.add(who);
    const rec = num(g.recordCount);
    if (rec != null) box.records += rec;
  });
  return byKey;
}

/**
 * 実際の記録から出す代用値。
 * traineeProgress.js の検定（ものさし×1.2以内を3回続けて出せた）に届いた組だけ。
 * @param {Array} recordCells
 *   [{workerName, processKey, examPassed, firstEndMs, passedAtMs, recordCount}]
 */
function recordLeadsByProcess(recordCells, bdays) {
  const byKey = new Map();
  arr(recordCells).filter(isObj).forEach((c) => {
    if (c.examPassed !== true) return;
    const key = str(c.processKey);
    const from = num(c.firstEndMs);
    const to = num(c.passedAtMs);
    const who = trimmed(c.workerName);
    if (!key || from == null || to == null || !who) return;
    const d = bdays(from, to);
    if (d == null || d < 1) return;
    let box = byKey.get(key);
    if (!box) { box = { days: [], workers: new Set(), records: 0 }; byKey.set(key, box); }
    box.days.push(d);
    box.workers.add(who);
    const rec = num(c.recordCount);
    box.records += rec == null ? 0 : rec;
  });
  return byKey;
}

/** 足りない材料の札。数が分からない物は count を null にする（0と混ぜない）。 */
function missingMaterials({ traineeMarkCount, teachMarkCount, graduationCount }) {
  const row = (kind, count) => ({
    kind,
    label: MATERIAL_LABEL[kind],
    count: num(count),
    screen: MATERIAL_SCREEN[kind],
  });
  return [
    row(LEAD_MATERIAL.TRAINEE_MARK, traineeMarkCount),
    row(LEAD_MATERIAL.TEACH_MARK, teachMarkCount),
    row(LEAD_MATERIAL.GRADUATION, graduationCount),
  ];
}

// -----------------------------------------------------------------------------
// 3. 本体
// -----------------------------------------------------------------------------
/**
 * 「今から教育を始めれば間に合うか」を工程ごとに出す。
 *
 * @param {object} args
 * @param {Array} args.processes  [{processKey, title, deadlineMs}]
 *   deadlineMs = A ＝ その月の、その工程の一番早い納期線。無ければ null で渡す。
 * @param {number} args.baseNowMs 「今日」。🚨 この関数は時計を読まない。
 * @param {Array} [args.graduations] 🎓の実測（出どころ1）
 * @param {Array} [args.recordCells] 記録からの代用値（出どころ2）
 * @param {object} [args.materials] {traineeMarkCount, teachMarkCount, graduationCount}
 * @param {Function} [args.businessDaysBetween] 暦を差し替えたい時だけ
 * @param {Function} [args.addBusinessDays] 同上
 * @param {Function} [args.subBusinessDays] 同上
 * @param {boolean} [args.holidaysKnown] 祝日を引けているか。既定 false（引けていない）
 * @returns {{rows:Array, counts:object, notes:string[], unknowns:string[]}}
 */
export function buildEducationLeadTime({
  processes,
  baseNowMs,
  graduations = null,
  recordCells = null,
  materials = null,
  businessDaysBetween: bdaysIn = null,
  addBusinessDays: addIn = null,
  subBusinessDays: subIn = null,
  holidaysKnown = false,
} = {}) {
  const now = num(baseNowMs);
  const calendarGiven = typeof bdaysIn === 'function'
    || typeof addIn === 'function' || typeof subIn === 'function';
  const bdays = typeof bdaysIn === 'function' ? bdaysIn : businessDaysBetween;
  const addB = typeof addIn === 'function' ? addIn : addBusinessDays;
  const subB = typeof subIn === 'function' ? subIn : subBusinessDays;

  const mat = isObj(materials) ? materials : {};
  const teachGiven = num(mat.teachMarkCount);
  const gradList = arr(graduations).filter(isObj);
  const gradGiven = num(mat.graduationCount) != null
    ? num(mat.graduationCount)
    : gradList.filter((g) => num(g.graduatedAtMs) != null).length;
  const missingTemplate = missingMaterials({
    traineeMarkCount: mat.traineeMarkCount,
    teachMarkCount: teachGiven,
    graduationCount: gradGiven,
  });

  const markBy = markLeadsByProcess(gradList, bdays);
  const recBy = recordLeadsByProcess(recordCells, bdays);

  const counts = { total: 0, mark: 0, record: 0, none: 0, inTime: 0, tooLate: 0, unjudged: 0 };
  const rows = arr(processes).filter(isObj).map((p) => {
    const processKey = str(p.processKey);
    const title = str(p.title);
    const deadlineMs = num(p.deadlineMs);
    counts.total += 1;

    const mark = markBy.get(processKey) || null;
    const rec = recBy.get(processKey) || null;
    const box = mark || rec;
    const source = mark ? LEAD_SOURCE.MARK : (rec ? LEAD_SOURCE.RECORD : LEAD_SOURCE.NONE);

    if (source === LEAD_SOURCE.NONE) {
      counts.none += 1;
      counts.unjudged += 1;
      return sealRow({
        processKey,
        title,
        source,
        leadDays: null,
        leadDaysRaw: null,
        deadlineMs: null,
        readyByMs: null,
        startByMs: null,
        inTime: null,
        basis: {
          workerCount: 0, recordCount: 0, sampleCount: 0, workerNames: [], singleWorker: false,
        },
        missing: missingTemplate.map((m) => ({ ...m })),
        evidence: [],
        unknowns: [
          'この工程で「一人前まで何日かかったか」を判定できる組が1つもありません。'
          + ' 日にちは1つも出していません（材料が無いのに日付を作ると、私が作った数字になります）。',
        ],
        why: '教育に要る日数は、いまの記録からは出せません。',
      });
    }

    const raw = medianOf(box.days);
    // 🚨 端数は必ず切り上げる（安全側）。切り捨てると「間に合う」に寄る。
    const leadDays = raw == null ? null : Math.ceil(raw);
    const readyByMs = leadDays == null || now == null ? null : addB(now, leadDays);
    const startByMs = leadDays == null || deadlineMs == null ? null : subB(deadlineMs, leadDays);
    const inTime = (readyByMs == null || deadlineMs == null)
      ? null
      : startOfDay(readyByMs) <= deadlineMs;
    if (source === LEAD_SOURCE.MARK) counts.mark += 1; else counts.record += 1;
    if (inTime === true) counts.inTime += 1;
    else if (inTime === false) counts.tooLate += 1;
    else counts.unjudged += 1;

    const workerNames = [...box.workers].sort(cmpStr);
    const singleWorker = workerNames.length === 1;
    const evidence = [];
    const unknowns = [];
    if (source === LEAD_SOURCE.MARK) {
      evidence.push(
        `🎓の印から出しています。教育を始めた日と卒業した日が入っている組 ${box.days.length}件`
        + `（${workerNames.length}人）の中央値です。`,
      );
    } else {
      evidence.push(
        `実際の記録から出しています。ものさし×1.2以内を3回続けて出せた組 ${box.days.length}件`
        + `（${workerNames.length}人・記録 ${box.records}件）の中央値です。`,
      );
      unknowns.push(
        'これは教育の記録ではありません。🎓の印が付いていない、普通の作業の記録から数えた代用値です。',
      );
    }
    if (singleWorker) {
      unknowns.push(
        `🚨 ${workerNames[0]} さん1人の記録だけから出ています。人によってどれだけ違うかは分かりません。`,
      );
    }
    if (!holidaysKnown) {
      unknowns.push('祝日を引けていません（工場の暦が登録されていません）。実際の営業日はこの数より少なくなります。');
    }
    if (deadlineMs == null) {
      unknowns.push('この工程の納期線がありません。間に合うかどうかは判定していません。');
    }
    if (now == null) {
      unknowns.push('「今日」を渡されていないので、いつ一人前になるかは出していません。');
    }

    const why = inTime === true
      ? `いま始めれば間に合います（${leadDays}営業日かかる見込み）。`
      : inTime === false
        ? `いま始めても間に合いません（${leadDays}営業日かかる見込み）。もっと早く始める必要がありました。`
        : `一人前まで ${leadDays}営業日かかる見込みです。間に合うかどうかは判定していません。`;

    return sealRow({
      processKey,
      title,
      source,
      leadDays,
      leadDaysRaw: raw,
      deadlineMs,
      readyByMs,
      startByMs,
      inTime,
      basis: {
        workerCount: workerNames.length,
        recordCount: box.records,
        sampleCount: box.days.length,
        workerNames,
        singleWorker,
      },
      missing: [],
      evidence,
      unknowns,
      why,
    });
  });

  rows.sort((a, b) => {
    const va = a.deadlineMs == null ? Infinity : a.deadlineMs;
    const vb = b.deadlineMs == null ? Infinity : b.deadlineMs;
    if (va !== vb) return va - vb;
    return cmpStr(a.processKey, b.processKey);
  });

  const notes = [
    '🚨 B（一人前までに要る営業日数）は、必ず出どころ（🎓の印 / 実際の記録 / 出せません）と一緒に読んでください。',
    '🚨 出どころが「出せません」の行には、日にちを1つも出していません。',
  ];
  if (calendarGiven) notes.push('営業日の数え方は、渡された暦で数えています（この中の月〜金の数え方は使っていません）。');
  else notes.push('営業日は月〜金・両端を含めて数えています。祝日は引いていません。');
  if (now == null) notes.push('「今日」（baseNowMs）を渡されていないので、いつ一人前になるかは1件も出していません。');

  const unknowns = [];
  if (counts.mark === 0) {
    unknowns.push('🎓の印から出せた工程は0件です。印が付き始めるまで、いちばん正しい出どころは使えません。');
  }
  if (counts.record > 0) {
    unknowns.push('実際の記録から出した値は、教育の記録ではなく普通の作業の記録から数えた代用値です。');
  }

  return { rows, counts, notes, unknowns };
}

// -----------------------------------------------------------------------------
// 4. 記録が1件も無くても言える事（設定値だけから出る）
// -----------------------------------------------------------------------------
/**
 * 「10月1日まで営業◯日。OJTは1日◯組までなので、それまでに組めるOJTは最大◯組」。
 * 🚨 これは **設定値と暦だけ** から出る。記録が0件でも言える。
 * 🚨 maxOjtPairsPerDay を自前で 1 と書かない。渡されなければ組数を出さない
 *    （既定値を作ると、設定と画面が食い違う）。
 *
 * @param {object} args
 * @param {number} args.baseNowMs 今日
 * @param {number} args.untilMs いつまで（例: 10月1日）
 * @param {number} [args.maxOjtPairsPerDay] policy.maxOjtPairsPerDay
 * @param {Function} [args.businessDaysBetween] 暦を差し替えたい時だけ
 * @param {Array} [args.workers] [{name, canTeach}] 持てる人と「教えられる」の指名
 * @param {boolean} [args.holidaysKnown]
 */
export function buildEducationCapacityNote({
  baseNowMs,
  untilMs,
  maxOjtPairsPerDay = null,
  businessDaysBetween: bdaysIn = null,
  workers = null,
  holidaysKnown = false,
} = {}) {
  const bdays = typeof bdaysIn === 'function' ? bdaysIn : businessDaysBetween;
  const from = num(baseNowMs);
  const to = num(untilMs);
  const days = (from == null || to == null) ? null : bdays(from, to);
  const perDay = num(maxOjtPairsPerDay);
  const maxOjtSlots = (days == null || perDay == null) ? null : days * perDay;

  const names = [];
  const teachNames = [];
  arr(workers).forEach((w) => {
    const n = isObj(w) ? trimmed(w.name) : trimmed(w);
    if (!n || names.includes(n)) return;
    names.push(n);
    if (isObj(w) && w.canTeach === true) teachNames.push(n);
  });
  names.sort(cmpStr);
  teachNames.sort(cmpStr);

  const sentences = [];
  if (days != null) sentences.push(`その日まで営業${days}日あります。`);
  else sentences.push('その日までの営業日数を出せません（今日、またはいつまでか、を渡されていません）。');
  if (maxOjtSlots != null) {
    sentences.push(`OJTは1日${perDay}組まで（設定値）なので、それまでに組めるOJTは最大${maxOjtSlots}組です。`);
  } else if (perDay == null) {
    sentences.push('1日に組めるOJTの数（設定値）を渡されていないので、組める数は出していません。');
  }
  if (names.length > 0) {
    sentences.push(`いま名簿に居るのは ${names.length}人（${names.join('・')}）です。`);
    sentences.push(
      teachNames.length > 0
        ? `そのうち「教えられる」の指名がある人は ${teachNames.length}人（${teachNames.join('・')}）です。`
        : '🚨 そのうち「教えられる」の指名がある人は0人です。指名は管理者が星取表で付けます。',
    );
  } else {
    sentences.push('名簿を渡されていないので、持てる人の名前は出していません。');
  }

  const unknowns = [];
  if (!holidaysKnown) unknowns.push('祝日を引いていません。実際の営業日はこの数より少なくなります。');
  unknowns.push('この組数は「1日に何組まで組んでよいか」の設定値と暦だけから出した上限です。実際に組めるかは、人の空きしだいです。');

  return {
    businessDays: days,
    maxOjtPairsPerDay: perDay,
    maxOjtSlots,
    workerNames: names,
    teachNames,
    sentences,
    unknowns,
  };
}

export default {
  LEAD_SOURCE,
  LEAD_SOURCE_LABEL,
  LEAD_MATERIAL,
  businessDaysBetween,
  addBusinessDays,
  subBusinessDays,
  sealRow,
  buildEducationLeadTime,
  buildEducationCapacityNote,
};
