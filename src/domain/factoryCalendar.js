// ============================================================================
// 工場の暦(祝日・全社休業・休日出勤) — 純関数だけ
// ----------------------------------------------------------------------------
// 清水さん(2026-09-01):
//   「祝日表はいるね、これないと処理能力わからないからね、
//     今進捗管理のところで休みか他かみたいなことできるけど、
//     これみたいなので予め登録する感じなのかな」
//   → 既にある「休み/他工場」(settings.workerRoster)と **同じ形・同じ操作** で、
//     先に登録する。この読みが正しい。
//
// ⚠⚠ workerRoster と役割が違う。混ぜないこと。
//     workerRoster … **人ごと**に「その日は居ない」(休み/他工場)
//     この暦      … **工場ごと**に「その日は誰も働かない / 土日だが働く」
//     人が全員休みでも「工場が休み」にはならない(逆も同じ)。だから別の入れ物にする。
//
// ⚠⚠ ここに Firestore も React も **時計** も持ち込まない。
//     `Date.now()` を1回でも呼ぶと、試験が走った時刻で答えが変わる。
//     「今日」が要る所は、呼ぶ側が ms を渡す。
//
// 🚨 時刻の帯(タイムゾーン)について
//   判定の芯は **すべて 'YYYY-MM-DD' の文字** で回す。曜日は Date.UTC から出す。
//   → 端末の帯が UTC でも 日本でも UTC+14 でも、同じ日付なら同じ答えになる。
//   ms を受ける入口(ymdOf)だけが端末の帯を見る = 「その端末にとっての、その日」。
//   2026-08-30 に「時計の帯に依る試験が落ちた」件があるので、ここは試験で固定する。
//
// 🚨 日をまたぐ時に 86400000 を足さない。
//   夏時間のある帯では 1日が 23時間/25時間になり、日付が飛ぶ・重なる。
//   数える所は必ず **暦の日** を1つずつ進める(nextYmd)。
// ============================================================================

/** 既定の稼働曜日 = 月〜金。**登録が空なら今までと1ミリも同じ挙動**。 */
export const DEFAULT_WORKDAYS = Object.freeze([1, 2, 3, 4, 5]);

/** 登録できる種類は2つだけ。 */
export const DAY_OFF = 'off';    // 平日だが工場が休み(祝日・年末年始・お盆・全社休業)
export const DAY_WORK = 'work';  // 土日だが出勤(休日出勤)

/** 一言(なぜ休みか)の最大の長さ。長い文は画面が崩れるので切る。 */
export const LABEL_MAX = 40;

/** 数え上げの上限(日)。壊れた入力で永久に回らないための止め。約110年。 */
export const MAX_SPAN_DAYS = 40000;

const pad2 = (n) => String(n).padStart(2, '0');

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 'YYYY-MM-DD' を {y,m,d} に。**実在しない日付は null**。
 * ⚠ '2026-02-30' や '2026-13-01' を通すと、その先の曜日計算が黙って別の日になる。
 */
export const partsOfYmd = (v) => {
  if (typeof v !== 'string') return null;
  const m = YMD_RE.exec(v);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // 実在するか(2/30・4/31 を弾く)。UTC で作るので端末の帯に依らない。
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return { y, m: mo, d };
};

/** 'YYYY-MM-DD' として正しいか。 */
export const isYmd = (v) => partsOfYmd(v) !== null;

/** 年月日 → 'YYYY-MM-DD'。 */
export const ymdOfParts = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;

/**
 * ms(または Date) → その端末にとっての 'YYYY-MM-DD'。
 * ⚠ ここだけが端末の帯を見る。既存の workerRoster の rymd と同じ形に揃えてある。
 */
export const ymdOf = (ms) => {
  const d = ms instanceof Date ? ms : new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return null;
  return ymdOfParts(d.getFullYear(), d.getMonth() + 1, d.getDate());
};

/** 'YYYY-MM-DD' の曜日(0=日〜6=土)。**端末の帯に依らない**。不正なら -1。 */
export const dowOfYmd = (ymd) => {
  const p = partsOfYmd(ymd);
  if (!p) return -1;
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
};

/** 翌日の 'YYYY-MM-DD'。⚠ 86400000 を足さない(夏時間で壊れる)。 */
export const nextYmd = (ymd) => {
  const p = partsOfYmd(ymd);
  if (!p) return null;
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
  return ymdOfParts(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
};

/** ms / Date / 'YYYY-MM-DD' のどれで渡されても 'YYYY-MM-DD' にする。 */
export const toYmd = (v) => {
  if (typeof v === 'string') return isYmd(v) ? v : null;
  if (v instanceof Date) return ymdOf(v);
  if (typeof v === 'number' && Number.isFinite(v)) return ymdOf(v);
  return null;
};

const cleanLabel = (v) => {
  if (typeof v !== 'string') return '';
  const s = v.trim().replace(/\s+/g, ' ');
  return s.length > LABEL_MAX ? s.slice(0, LABEL_MAX) : s;
};

/**
 * 中身が1つ登録された日を、決まった形に直す。読めない値は null(=登録なし扱い)。
 * 🚨 **読めない値を 'off' に寄せない。** 寄せると、壊れた1件で工場が丸ごと休みになる。
 *   受ける形: 'off' / 'work' / {type,label} / {type:'holiday'} など言い換えも少しだけ。
 */
const normalizeEntry = (raw) => {
  let type = null, label = '';
  if (typeof raw === 'string') type = raw;
  else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    type = typeof raw.type === 'string' ? raw.type : null;
    label = cleanLabel(raw.label ?? raw.name ?? raw.note);
  } else return null;
  if (typeof type !== 'string') return null;
  const t = type.trim().toLowerCase();
  if (t === DAY_OFF || t === 'holiday' || t === 'closed' || t === '休' || t === '休み') return { type: DAY_OFF, label };
  if (t === DAY_WORK || t === 'workday' || t === 'open' || t === '出' || t === '出勤') return { type: DAY_WORK, label };
  return null; // 知らない値は「登録なし」。**黙って休みにしない**。
};

const normalizeWorkdays = (raw) => {
  if (!Array.isArray(raw)) return DEFAULT_WORKDAYS.slice();
  const out = [];
  for (const v of raw) {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 0 && n <= 6 && !out.includes(n)) out.push(n);
  }
  // 🚨 空配列(=1日も働かない)は事故の形。読み違いとみなして既定へ戻す。
  //   本当に全休にしたい時は、その日を1件ずつ 'off' で登録する(意図が残る)。
  return out.length ? out.sort((a, b) => a - b) : DEFAULT_WORKDAYS.slice();
};

/** 年の鍵('2026')。⚠ 'YYYY-MM-DD' は4桁ではないので、平たい地図と取り違えない。 */
const YEAR_KEY_RE = /^\d{4}$/;

/**
 * 生の値 → 「'YYYY-MM-DD' → 中身」の平たい地図。**読み方はここ1本**。
 *
 * 🚨 2026-09-02 実測の穴: 最終検査は暦を **1年=1ドキュメント** で購読していて、
 *   画面が持つ形は `{ '2026': {days:{…}}, '2027': {days:{…}} }`(年ごとの束)。
 *   これを isWorkdayYmd / makeIsWorkday へそのまま渡すと、鍵が 'YYYY-MM-DD' でないので
 *   **登録0件と同じ扱い**になり、祝日を登録しても1日も減らない(エラーも出ない)。
 *   束をほどく所が操業シミュレーションの中(normalizeInput.js)にしか無かったので、
 *   そこを通らない画面(ロスターの平均在席・経過時間の時計)は黙って素通りしていた。
 *   → 読み方を **この1本** に寄せる。以後どの入口から渡しても同じ答えになる。
 *
 * 受ける形:
 *   ② { days: {…} }                              1年ぶん1ドキュメントの中身
 *   ③ { 'YYYY-MM-DD': 'off', … }                 平たい地図(手で書いた物・古い形)
 *   ④ [ {id:'2026',days:{…}}, {id:'2027',…} ]    購読が配列で渡してくる形
 *   ⑤ { '2026': {days:{…}}, '2027': {…} }        年ごとの購読を束ねた形(最終検査の画面が作る形)
 * ⚠ 混ざっていても union で読む(②と③が同じ物に入っていても落とさない)。
 * ⚠ depth の止めは、自分を指す形を渡された時に永久に回らないため。
 */
const rawDaysOf = (raw, depth = 0) => {
  const out = {};
  if (!raw || typeof raw !== 'object' || depth > 4) return out;
  if (Array.isArray(raw)) {
    for (const doc of raw) Object.assign(out, rawDaysOf(doc, depth + 1));
    return out;
  }
  if (raw.days && typeof raw.days === 'object' && !Array.isArray(raw.days)) Object.assign(out, raw.days);
  for (const k of Object.keys(raw)) {
    if (YEAR_KEY_RE.test(k)) Object.assign(out, rawDaysOf(raw[k], depth + 1));
    else if (isYmd(k)) out[k] = raw[k];
  }
  return out;
};

/**
 * 保存されている生の値を、安全に読める形へ。
 * 受ける形:
 *   ① null / undefined / 壊れた値      → 空の暦(= 月〜金。今までと同じ)
 *   ②〜⑤ … rawDaysOf の説明を参照
 * @returns {{days: Object, workdays: number[]}} 凍結済み
 */
export const normalizeCalendar = (raw) => {
  const empty = Object.freeze({ days: Object.freeze({}), workdays: Object.freeze(DEFAULT_WORKDAYS.slice()) });
  if (!raw || typeof raw !== 'object') return empty;
  const src = rawDaysOf(raw);
  const days = {};
  for (const [k, v] of Object.entries(src)) {
    if (!isYmd(k)) continue;            // 鍵の形が違う物は読み捨てる(落ちない)
    const e = normalizeEntry(v);
    if (e) days[k] = Object.freeze(e);
  }
  return Object.freeze({ days: Object.freeze(days), workdays: Object.freeze(normalizeWorkdays(raw.workdays)) });
};

/** その日の登録(無ければ null)。 */
export const entryOfYmd = (calendar, ymd) => {
  const cal = normalizeCalendar(calendar);
  return cal.days[ymd] || null;
};

/**
 * その日は工場が動くか。
 * 🚨 **登録が空なら月〜金**(今までの `[1,2,3,4,5]` と1ミリも同じ)。
 * 登録があれば **両方向に上書き**する(平日→休み / 土日→出勤)。
 */
export const isWorkdayYmd = (ymd, calendar) => {
  const dow = dowOfYmd(ymd);
  if (dow < 0) return false; // 日付として読めない物は数えない
  const cal = normalizeCalendar(calendar);
  const e = cal.days[ymd];
  if (e && e.type === DAY_OFF) return false;
  if (e && e.type === DAY_WORK) return true;
  return cal.workdays.includes(dow);
};

/** ms / Date / 'YYYY-MM-DD' で受ける版。 */
export const isWorkday = (v, calendar) => {
  const ymd = toYmd(v);
  return ymd ? isWorkdayYmd(ymd, calendar) : false;
};

/**
 * 期間の日を1つずつ辿る(両端を含む)。⚠ 日は暦で進める。
 * @returns 実際に辿った日数
 */
const eachDay = (from, to, fn) => {
  const a = toYmd(from), b = toYmd(to);
  if (!a || !b || a > b) return 0;   // 'YYYY-MM-DD' は文字の並びがそのまま日付の順
  let cur = a, n = 0;
  while (cur && cur <= b) {
    fn(cur);
    if (++n >= MAX_SPAN_DAYS) break;
    cur = nextYmd(cur);
  }
  return n;
};

/**
 * 期間の営業日数(両端を含む)。
 * @param {{from?:*, to?:*, fromMs?:*, toMs?:*, calendar?:*}} arg
 */
export const countWorkdaysBetween = ({ from, to, fromMs, toMs, calendar } = {}) => {
  const cal = normalizeCalendar(calendar);
  let n = 0;
  eachDay(from ?? fromMs, to ?? toMs, (ymd) => { if (isWorkdayYmd(ymd, cal)) n++; });
  return n;
};

/** 期間の暦日数(両端を含む)。札に「営業◯日 ・ 暦◯日」を併記するため。 */
export const countCalendarDaysBetween = ({ from, to, fromMs, toMs } = {}) =>
  eachDay(from ?? fromMs, to ?? toMs, () => {});

const DOW_JA = ['日', '月', '火', '水', '木', '金', '土'];

/** 曜日の文字(0=日)。画面用。 */
export const dowLabel = (dow) => DOW_JA[dow] || '';

/**
 * 期間のうち「登録して休みにした日」の一覧。画面の「この期間の休み」用。
 * ⚠ 土日は出さない(登録した物だけ)。土日は元から休みで、見ても何も分からないため。
 */
export const listHolidaysBetween = ({ from, to, fromMs, toMs, calendar } = {}) => {
  const cal = normalizeCalendar(calendar);
  const out = [];
  eachDay(from ?? fromMs, to ?? toMs, (ymd) => {
    const e = cal.days[ymd];
    if (e && e.type === DAY_OFF) out.push({ ymd, type: DAY_OFF, label: e.label || '', dow: dowOfYmd(ymd), dowLabel: dowLabel(dowOfYmd(ymd)) });
  });
  return out;
};

/** 期間のうち「登録して出勤にした日」(休日出勤)の一覧。 */
export const listWorkOverridesBetween = ({ from, to, fromMs, toMs, calendar } = {}) => {
  const cal = normalizeCalendar(calendar);
  const out = [];
  eachDay(from ?? fromMs, to ?? toMs, (ymd) => {
    const e = cal.days[ymd];
    if (e && e.type === DAY_WORK) out.push({ ymd, type: DAY_WORK, label: e.label || '', dow: dowOfYmd(ymd), dowLabel: dowLabel(dowOfYmd(ymd)) });
  });
  return out;
};

// ----------------------------------------------------------------------------
// 月(登録の画面が使う)
// ----------------------------------------------------------------------------

/** その月の1日と末日('YYYY-MM-DD')。month は 1〜12。 */
export const monthRange = (year, month) => {
  const y = Number(year), m = Number(month);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); // 翌月0日 = 当月末日
  return { from: ymdOfParts(y, m, 1), to: ymdOfParts(y, m, last), lastDay: last };
};

/** 月を送る({year,month} を n か月ずらす)。 */
export const shiftMonth = (year, month, n) => {
  const t = new Date(Date.UTC(Number(year), Number(month) - 1 + Number(n), 1));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1 };
};

/** その月の日の一覧(画面の格子用)。 */
export const monthDays = (year, month, calendar) => {
  const r = monthRange(year, month);
  if (!r) return [];
  const cal = normalizeCalendar(calendar);
  const out = [];
  eachDay(r.from, r.to, (ymd) => {
    const dow = dowOfYmd(ymd);
    const e = cal.days[ymd] || null;
    out.push({
      ymd,
      day: Number(ymd.slice(8, 10)),
      dow,
      dowLabel: dowLabel(dow),
      weekend: dow === 0 || dow === 6,
      entry: e,
      type: e ? e.type : null,
      label: e ? e.label : '',
      workday: isWorkdayYmd(ymd, cal),
    });
  });
  return out;
};

/**
 * 月の要約。画面の「この月の営業日 ◯日」はここから出す。
 * 🚨 同じ数字を2つの計算から出さない = 画面は自分で数え直さず、必ずこれを使う。
 */
export const monthSummary = ({ year, month, calendar } = {}) => {
  const r = monthRange(year, month);
  if (!r) return null;
  const cal = normalizeCalendar(calendar);
  const days = monthDays(year, month, cal);
  const workdays = days.filter((d) => d.workday).length;
  const holidays = days.filter((d) => d.type === DAY_OFF);
  const workOverrides = days.filter((d) => d.type === DAY_WORK);
  // 登録が1件も無かった時の営業日(= 今までの数え方)。「登録で何日減ったか」を見せるため。
  const baseWorkdays = days.filter((d) => cal.workdays.includes(d.dow)).length;
  return {
    year: Number(year), month: Number(month),
    from: r.from, to: r.to,
    calendarDays: days.length,
    workdays,
    baseWorkdays,
    diff: workdays - baseWorkdays,
    holidays, workOverrides,
    registered: holidays.length + workOverrides.length,
  };
};

// ----------------------------------------------------------------------------
// 登録を変える(保存する物を作るだけ。ここでは保存しない)
// ----------------------------------------------------------------------------
// 🚨 2026-09-01 の教訓(清水さん「ボタン連打しても休みとか他が戻ってこないから、
//   ミスしても直せないよ」)をそのまま持ち込む。
//   merge:true は **送らなかった鍵を消さない**。だから「既定に戻す」時は
//   消す印(__deleteMapKeys)を必ず一緒に返す。付け忘れると保存が素通りして焼き付く。
// ----------------------------------------------------------------------------

/**
 * 1日ぶんの登録を書き換えた結果を作る。
 * @param rootKey 保存先のフィールド名(例 'factoryCalendar')。消す印の道に使う。
 * @returns {{days:Object, deleteKeys:Array, next:(string|null)}}
 *          next = 変えたあとの種類(null = 登録なし=既定に戻した)
 */
export const applyDay = (calendar, ymd, type, label = '', rootKey = 'factoryCalendar') => {
  const cal = normalizeCalendar(calendar);
  const days = { ...cal.days };
  const deleteKeys = [];
  if (!isYmd(ymd)) return { days, deleteKeys, next: cal.days[ymd] ? cal.days[ymd].type : null };
  const e = type === null || type === undefined ? null : normalizeEntry({ type, label });
  if (e) {
    days[ymd] = e;
  } else {
    delete days[ymd];
    deleteKeys.push([String(rootKey), 'days', ymd]);   // ⚠ 消す印。これが無いと戻せない
  }
  return { days, deleteKeys, next: e ? e.type : null };
};

/**
 * セルを1回押した時の次の状態。**押し続ければ必ず元に戻る**(取り消せる)。
 *   平日: 出勤(既定) → 休み → 出勤(既定) → …
 *   土日: 休み(既定) → 出勤 → 休み(既定) → …
 * = 登録があれば消す・無ければ「既定の逆」を入れる、の1本。
 */
export const cycleDay = (calendar, ymd, label = '', rootKey = 'factoryCalendar') => {
  const cal = normalizeCalendar(calendar);
  if (!isYmd(ymd)) return { days: { ...cal.days }, deleteKeys: [], next: null };
  if (cal.days[ymd]) return applyDay(cal, ymd, null, '', rootKey);           // 既定へ戻す
  const defaultWork = cal.workdays.includes(dowOfYmd(ymd));
  return applyDay(cal, ymd, defaultWork ? DAY_OFF : DAY_WORK, label, rootKey);
};

/** 一言(なぜ休みか)だけ書き換える。登録が無い日には何もしない。 */
export const setDayLabel = (calendar, ymd, label, rootKey = 'factoryCalendar') => {
  const cal = normalizeCalendar(calendar);
  const e = cal.days[ymd];
  if (!e) return { days: { ...cal.days }, deleteKeys: [], next: null };
  return applyDay(cal, ymd, e.type, label, rootKey);
};

/** 保存する形({days}) にして返す。呼ぶ側はこれを既存の保存の関所へ渡す。 */
export const toStored = (days, extra = {}) => ({ days: days || {}, ...extra });

// ----------------------------------------------------------------------------
// 日を1日ずつ辿るループのための道具(暦を1回だけ畳む)
// ----------------------------------------------------------------------------

/** 前日の 'YYYY-MM-DD'。⚠ 86400000 を引かない(夏時間で日が飛ぶ・重なる)。 */
export const prevYmd = (ymd) => {
  const p = partsOfYmd(ymd);
  if (!p) return null;
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d - 1));
  return ymdOfParts(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
};

/**
 * 「その日は工場が動くか」を **1回だけ組み立てて** 使い回す形にする。
 *
 * なぜ要るか: `isWorkdayYmd` は呼ぶたびに暦を読み直す(normalizeCalendar)。
 *   見込み完了日は 1ロットにつき最大60日ぶん・数百ロット聞くので、
 *   登録が増えるほど画面が重くなる(2026-08-30「札の描き直し 370枚→2枚」と同じ形)。
 *   ループの外でこれを1回作り、中では引くだけにする。
 *
 * 🚨 週の形(何曜日に働くか)の持ち主は **1つだけ** にする。
 *   勤務表(daysPerWeek)を持っている呼び手は workdaysOverride を渡す。渡さない時だけ暦の値を使う。
 *   両方に別々の週の形を持たせると、同じ日が画面ごとに違う答えになる。
 * ⚠ すでに畳んだ物を渡されたらそのまま返す(二重に畳んでも答えが変わらない)。
 *
 * @param calendar          保存されている生の暦 / または畳んだ関数
 * @param workdaysOverride  稼働曜日の差し替え(勤務表の「稼働日/週」が6日・7日の時など)。
 *                          null なら暦の workdays(既定 月〜金)。
 * @returns {(v:*)=>boolean} ms / Date / 'YYYY-MM-DD' のどれでも受ける。
 *   戻り値に days / workdays が生えている(画面が「登録された休み」を出す時に使う)。
 */
export const makeIsWorkday = (calendar, workdaysOverride = null) => {
  if (typeof calendar === 'function' && workdaysOverride == null) return calendar;
  const base = normalizeCalendar(typeof calendar === 'function' ? { days: calendar.days } : calendar);
  const workdays = workdaysOverride == null
    ? base.workdays
    : normalizeCalendar({ workdays: workdaysOverride }).workdays;
  const dowSet = new Set(workdays);
  const days = base.days;
  const f = (v) => {
    const ymd = toYmd(v);
    if (!ymd) return false;
    const e = days[ymd];
    if (e && e.type === DAY_OFF) return false;
    if (e && e.type === DAY_WORK) return true;
    const dow = dowOfYmd(ymd);
    return dow >= 0 && dowSet.has(dow);
  };
  f.days = days;
  f.workdays = workdays;
  return f;
};

/**
 * その日が工場の休みなら **前の営業日** へ寄せた 'YYYY-MM-DD'。営業日ならそのまま返す。
 * 🚨 2026-08-23 清水さん「1は金曜によせる」。祝日表が無かった頃は土日しか寄せられず、
 *   **工場が休みの祝日に入荷予定が立っていた**。
 * ⚠ 1回ずらすだけでは足りない(祝日の前日が日曜なら更に金曜まで下がる)。営業日に当たるまで下がる。
 * @param maxBack 何日まで遡るか。全部休みの暦で永久に回らないための止め。
 * @returns 'YYYY-MM-DD' / 遡っても営業日が1日も無ければ null(呼ぶ側で「決められません」を出す)
 */
export const prevWorkdayYmd = (v, calendar, maxBack = 400) => {
  const works = makeIsWorkday(calendar);
  let cur = toYmd(v);
  if (!cur) return null;
  for (let i = 0; i < maxBack; i++) {
    if (works(cur)) return cur;
    cur = prevYmd(cur);
    if (!cur) return null;
  }
  return null;
};
