// =============================================================================
//  opsim/horizonRange.js — 盤面の「期間の切替」(5営業日 / 今月 / 来月)。純関数だけ
// -----------------------------------------------------------------------------
//  出典: 2026-09-04 決まり19A(親)
//    「盤面 + 期間の切替 `5営業日 / 今月 / 来月`」
//    「『30日』の曖昧な数字をやめる。届く日を札に出す」
//  根: いままでの「30日」は **10/16 までしか届かない**(2026-09-04 実測)。
//      清水さんが見たいのは「今月末」「来月末」であって「30日後」ではない。
//      月末に立つ納期の山が、30日の線の外に落ちて **画面に1件も出ない**。
//
//  🚨 このファイルは Firestore も React も **時計** も持たない。
//     「今」が要る所は呼ぶ側が ms を渡す(factoryCalendar.js と同じ掟)。
//     Date.now() を1回でも呼ぶと、試験が走った時刻で答えが変わる。
//
//  🚨 営業日の数え方は normalizeInput.js の addWorkdays と **同じ数え方** にする
//     (基準の日そのものは数えない・翌日から1日ずつ進めて worksOn の日だけ数える)。
//     ここで別の数え方をすると、画面の札の「営業18日」と
//     エンジンの horizonEnd が **別の日** を指す(同じ数字を2つの計算から出す事になる)。
// =============================================================================

/** 日を1つ進める。🚨 86400000 を足さない(夏時間のある帯で日が飛ぶ・重なる)。 */
const nextDayMs = (ms) => {
  const d = new Date(ms);
  d.setDate(d.getDate() + 1);
  return d.getTime();
};

const startOfDayMs = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** 数え続けて止まらなくならない為の上限。暦日で 400日(1年+α)。 */
export const OPSIM_RANGE_MAX_DAY_STEPS = 400;

/** 案C の「軽い方」で回す営業日数。🚨 いままでの既定(5日)と1ミリも同じ値。 */
export const OPSIM_LIGHT_DAYS = 5;

/**
 * 期間の3択。
 * 🚨 「30日」を置かない。**届く日が言えない数字は札にしない**(決まり19A)。
 *   ・5営業日 … 今週の山。既定。1回およそ1秒(2026-09-04 実測・本番の写し633ロット)
 *   ・今月   … 今日から今月末まで(営業日で数える)
 *   ・来月   … 今日から来月末まで
 * ⚠ label に日数を焼き込まない。日数は暦と基準時刻で変わる(祝日を登録すれば減る)。
 */
export const OPSIM_RANGES = Object.freeze([
  Object.freeze({ key: 'd5', label: '5営業日', hint: '今週の山を、日ごとに見ます（既定）' }),
  Object.freeze({ key: 'thisMonth', label: '今月', hint: '今日から今月末まで。月末に立つ納期まで届きます' }),
  Object.freeze({ key: 'nextMonth', label: '来月', hint: '今日から来月末まで。教育の支度が要る山を先に見ます' }),
]);

export const OPSIM_RANGE_KEYS = Object.freeze(OPSIM_RANGES.map((r) => r.key));

const isFn = (f) => typeof f === 'function';
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/** その月の最後の日の 00:00。 */
const endOfMonthDayMs = (ms, addMonths) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  // 「翌月の1日」の前日 = その月の末日。月をまたぐ足し算はここ1箇所だけ。
  d.setMonth(d.getMonth() + (Math.trunc(Number(addMonths)) || 0) + 1);
  d.setDate(0);
  return d.getTime();
};

/**
 * 基準の日の **翌日から** 末日までに営業日が何日あるか。
 * 🚨 normalizeInput.addWorkdays と同じ数え方(基準の日そのものは数えない)。
 * @param {number} baseNowMs 基準時刻
 * @param {number} untilDayMs 数える最後の日(その日を含む)の 00:00
 * @param {(ms:number)=>boolean} [worksOnDay] 稼働日か。渡さないと暦日として数える
 * @returns {number} 営業日の数(0以上)
 */
export function opsimWorkdaysBetween(baseNowMs, untilDayMs, worksOnDay) {
  const base = num(baseNowMs);
  const until = num(untilDayMs);
  if (base == null || until == null) return 0;
  const countAll = !isFn(worksOnDay);
  let cur = nextDayMs(startOfDayMs(base));
  let n = 0;
  let guard = 0;
  while (cur <= until && guard < OPSIM_RANGE_MAX_DAY_STEPS) {
    if (countAll || worksOnDay(cur)) n += 1;
    cur = nextDayMs(cur);
    guard += 1;
  }
  return n;
}

/** 暦日の数(基準の日の翌日から末日まで)。札に「営業◯日・暦◯日」を併記する為(決まり3)。 */
export function opsimCalendarDaysBetween(baseNowMs, untilDayMs) {
  const base = num(baseNowMs);
  const until = num(untilDayMs);
  if (base == null || until == null) return 0;
  let cur = nextDayMs(startOfDayMs(base));
  let n = 0;
  let guard = 0;
  while (cur <= until && guard < OPSIM_RANGE_MAX_DAY_STEPS) { n += 1; cur = nextDayMs(cur); guard += 1; }
  return n;
}

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
/** 2026/9/30（水） の形。🚨 納期の書き方(2026-07-18 統一)に合わせる。 */
export const opsimYmdW = (ms) => {
  const v = num(ms);
  if (v == null) return '—';
  const d = new Date(v);
  return `${d.getMonth() + 1}/${d.getDate()}（${WEEK[d.getDay()]}）`;
};

/**
 * 期間の中身を出す。
 * 🚨 **返す days をそのまま engine の horizonDays にする**。画面用に別の数を作らない。
 *
 * @param {object} a
 * @param {string} a.rangeKey 'd5' | 'thisMonth' | 'nextMonth'
 * @param {number} a.baseNowMs 基準時刻(この画面が使っている1つの時刻)
 * @param {(ms:number)=>boolean} [a.worksOnDay] 工場の暦を畳んだ物
 * @returns {{key:string,label:string,days:number,endMs:number|null,lastDayMs:number|null,
 *            calDays:number,empty:boolean,isMonth:boolean,rangeText:string,reachText:string}}
 */
export function opsimRangeDays({ rangeKey = 'd5', baseNowMs = null, worksOnDay = null } = {}) {
  const key = OPSIM_RANGE_KEYS.includes(String(rangeKey)) ? String(rangeKey) : 'd5';
  const item = OPSIM_RANGES.find((r) => r.key === key) || OPSIM_RANGES[0];
  const base = num(baseNowMs);
  const countAll = !isFn(worksOnDay);

  if (key === 'd5') {
    const endMs = base == null ? null : opsimAddWorkdays(base, OPSIM_LIGHT_DAYS, worksOnDay);
    return {
      key,
      label: item.label,
      days: OPSIM_LIGHT_DAYS,
      endMs,
      lastDayMs: endMs == null ? null : startOfDayMs(endMs),
      calDays: endMs == null ? 0 : opsimCalendarDaysBetween(base, startOfDayMs(endMs)),
      empty: false,
      isMonth: false,
      rangeText: base == null ? '5営業日' : `${opsimYmdW(base)} 〜 ${opsimYmdW(endMs)}`,
      reachText: base == null ? '' : `${opsimYmdW(endMs)} まで届きます`,
    };
  }

  const addMonths = key === 'nextMonth' ? 1 : 0;
  const lastDayMs = base == null ? null : endOfMonthDayMs(base, addMonths);
  const days = base == null ? 0 : opsimWorkdaysBetween(base, lastDayMs, worksOnDay);
  const calDays = base == null ? 0 : opsimCalendarDaysBetween(base, lastDayMs);
  // 🚨 営業日が 0 の時に 1 を作らない。「今月の残りは 0営業日です」と正直に言う為に 0 のまま返す。
  const endMs = (base == null || days <= 0) ? null : opsimAddWorkdays(base, days, worksOnDay);
  return {
    key,
    label: item.label,
    days,
    endMs,
    lastDayMs,
    calDays,
    empty: days <= 0,
    isMonth: true,
    rangeText: base == null ? item.label : `${opsimYmdW(base)} 〜 ${opsimYmdW(lastDayMs)}`,
    reachText: base == null ? ''
      : (days <= 0
        ? `${opsimYmdW(lastDayMs)} までに営業日が1日も残っていません`
        // 🚨 どう数えたかを必ず言う。工場の暦が渡っていない時に「営業日で数えた」と言わない。
        : `${opsimYmdW(endMs)} まで届きます（${countAll ? '工場の暦が渡っていないので暦日として数えました' : '工場の暦（祝日・休日出勤）で数えました'}）`),
  };
}

/**
 * 稼働日で n 日ぶん進めた実時刻。
 * 🚨 normalizeInput.js の addWorkdays と **同じ式**(写しではなく、同じ数え方をここでも1本)。
 *   engine 側は import できない(domain は画面を知らない約束)ので、ここに置く。
 *   ⚠ ズレていないかは見張り(verify-opsim-horizon.mjs)が
 *     本物の normalizeInput を通した horizonEnd と突き合わせて確かめる。
 */
export function opsimAddWorkdays(ms, n, worksOnDay) {
  const steps = Math.trunc(Number(n) || 0);
  const base = num(ms);
  if (base == null) return null;
  if (steps === 0) return base;
  const dir = steps > 0 ? 1 : -1;
  const countAll = !isFn(worksOnDay);
  const d = new Date(base);
  let left = Math.abs(steps);
  let guard = 0;
  while (left > 0 && guard < OPSIM_RANGE_MAX_DAY_STEPS) {
    d.setDate(d.getDate() + dir);
    guard += 1;
    if (countAll || worksOnDay(d.getTime())) left -= 1;
  }
  return d.getTime();
}

/**
 * 盤・棚・空の札で使う「期間の言い方」。
 * 🚨 ここが **唯一の口**。「この5日」を画面のどこにも焼き込まない(決まり19A・親の指示3)。
 *   日数が分からない時は日数を作らない(「この期間」とだけ言う)。
 * @param {number|null} days 実際にエンジンが回した営業日の数(result.normalized.horizonDays)
 */
export const opsimPeriodWord = (days) => {
  const d = num(days);
  if (d == null || d <= 0) return 'この期間';
  return `この${d}営業日`;
};

/**
 * 月の期間では、時間を進めるつまみの刻みを **1日** にする。
 * -----------------------------------------------------------------------------
 * 🚨 なぜ(2026-09-04 実測): 盤の記録(snapshot)は
 *   ・5営業日以内 … 直接作業30分ごと(細かい目盛りを足している)
 *   ・6営業日以上 … **1日ごと**(buildSnapshotTargets の粗い目盛りだけ)
 *   なので、月の期間で「＋0.3日」進めても **同じ1枚の記録が選ばれ、札の残り時間が1分も動かない**
 *   (6回押して3回動かなかった)。押しても何も起きないつまみは、清水さんの
 *   「作業者が処理してるのに残り時間が変わってなかったり」そのもの。
 * → 月の期間では刻みを1日にする。**黙って放置しない**。
 * ⚠ 記録の作り方(worker側)は担当が違うので触っていない。
 *   触らずに直せる側(押した時に必ず1枚先の記録へ動く)をここで直す。
 * @param {number|null} days エンジンが回した営業日の数
 * @returns {boolean} 1日刻みに固定するか
 */
export const opsimNeedsDayStep = (days) => {
  const d = num(days);
  return d != null && d > OPSIM_LIGHT_DAYS;
};

export default OPSIM_RANGES;
