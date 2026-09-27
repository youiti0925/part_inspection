// 操業シミュレーター — 勤務カレンダー
// 契約: src/domain/operationsSimulation/CONTRACT.md の「calendar.js」の節。
// 正:   docs/製品検査_操業シミュレーター_完全是正実装仕様書_2026-08-23.md
//       3章(確定した業務ルール) / 5.2(時間軸) / 5.3(納期線) / 6.3(このファイルの修正内容)
//
// ここが持つ責任はただ1つ:
//   「実時刻(epoch ms)」と「その人が実際に働ける時間(ms)」の変換。
//   他のモジュール(simulate/priority/buildJobs)は実時刻だけを持ち、
//   休憩・土日・休み・残業の事情はここでしか触らない。
//
// なぜ純関数の別ファイルにしたか:
//   「到着16:00 + 見積3時間 = 19:00」は現場では成り立たない(15時休憩・定時・翌朝跨ぎ・土日)。
//   その換算が各所に散ると、画面と計算で違う時刻が出て突破日が食い違う。
//   src/domain/workClock.js が既に同じ考えで作られているので、その並びに合わせた。
//
// 🚨 決め事(CONTRACT.md 0章):
//   - React / Firebase を import しない。
//   - 関数の中で「現在時刻」や「乱数」を取らない（引数なしの日時生成・乱数生成をしない）。
//     時刻は必ず引数で受ける。同じ入力なら毎回同じ結果になる事(S23)。
//   - 1日ぶんの量を直書きしない。directMinutesPerDay は呼ぶ側(policy.js)が必ず入れる。
//
// 🚨 2026-08-23 の是正(仕様書6.3)で変えた所:
//   - 主要APIの入口を **directMinutesPerDay(1日の直接作業の分数)** にした。
//     capacityMs = directMinutesPerDay × 60,000。ここで indirectFactor で割らない。
//     通常420分・残業540分は **policy.js が決める**。このファイルは受け取った分数を数えるだけ。
//     （仕様書D01: 勤務表440分 ÷ 1.3 ≒ 338分 という作り方をしていたのが誤り）
//   - 時間の足し算の入口を addDirectWorkMs ただ1本にした。0.3日・5日・30日は
//     すべて elapsedDaysToMs → addDirectWorkMs を通す(仕様書5.2)。
//   - 納期の解決 resolveDueAt / resolveRegularWorkEnd をここへ置いた。
//     日付だけの納期は **その日の通常勤務終了時刻**。0:00 にしない(仕様書5.3 / D04)。
//     🚨 納期線は通常でも残業でも動かない。directMinutesPerDay を渡しても結果は変わらない(T008)。
//
// ⚠ 旧い名前(dailyHours / indirectFactor / addWorkMs)は当面残してある。
//   simulate.js / priority.js / OperationsSimulationPanel.jsx がまだ旧い名前で呼んでいて、
//   それらは今回の担当ファイルではないため。新しく書く所は新しい名前だけを使う事。
//
// ⚠ 時刻はすべて「端末のローカル時刻」で解釈する。
//   absences の鍵 'YYYY-MM-DD' も、休憩の '10:00' も、現場の壁時計の話だから。
//   既存の workClock.js / dueDefense.js も同じくローカル時刻で組んである。
//
// 🚨 2026-09-02 追加: **工場の暦(祝日・年末年始・お盆・全社休業・休日出勤)**。
//   清水さん(2026-09-01)「祝日表はいるね、これないと処理能力わからないからね」。
//   それまでこのファイルは **曜日だけ** で稼働日を決めていた。つまり
//   9/21 敬老の日・9/22 国民の休日・9/23 秋分の日 を「働ける日」と答えていた。
//   2026年9月は 平日22日 のうち 3日が祝日 = 実際の営業日は19日。
//   多く見積もる率 13.6%。この分だけ「処理能力がある」と嘘をついていた。
//
//   🚨 週の形(何曜日に働くか)の持ち主は **workdays ただ1つ**。
//     暦(factoryCalendar)は「その日1日だけの上書き」を **両方向** に持つ。
//       平日 → 休み('off')  /  土日 → 出勤('work')
//     片方向だけ効かせると、休日出勤を登録しても能力が増えない画面になる。
//   🚨 登録が空(null / {})なら 月〜金 のまま = **今までと1ミリも同じ**。
//
// 🚨 2026-09-05 追加: **人ごとの勤務の窓(settings.workerProfiles)**。
//   清水さん「村さんは9:30〜16:00までの時短勤務で、片山さんは職長だから管理業務もあるから
//   普通の作業者より作業時間ができなかったりする(個人直工比率が高い)。この辺を設定したい」
//   それまでこのファイルは **全員が同じ窓** で働く前提だった。時短の人にも 420分 を立てていた。
//
//   決め方(この1か所だけ。他のファイルは segmentsFor / dayCapacityMs(name) を呼ぶだけ):
//     その人がその日に働ける時間 = 工場の窓 ∩ 本人の窓 − 休憩
//       ・工場の窓 = 始業(dayStartHHMM) 〜 その日の区間の終わり(1日の分数を使い切る時刻)
//       ・本人の窓 = dayStart 〜 dayEnd(書いてある方だけ差し替える。無い方は工場の値)
//       ・直工比率(directRatio 0<r<=1) = 本人の窓のうち検査に回せる割合。
//         **管理業務ぶんは1日の終わりに固めて置く** = 窓の終わりを縮める:
//           effectiveEnd = start + (end − start) × ratio
//   🚨 読めない値(HH:MM でない・比率が 0 以下や 1 より大きい)は **黙って丸めず** 捨てて、
//     警告文を spec.warnings へ残す(呼ぶ側 normalizeInput が policyWarnings へ写す)。
//   🚨 登録が無い人は今までと1ミリも同じ(工場の窓そのまま)。
import { makeIsWorkday } from '../factoryCalendar.js';
// 👤 2026-09-10: settings.workerProfiles の **新しい3欄**(byWeekday / days / overtime)を読むのは
//   workerAvailability.js ただ1本。ここで読み直さない(読み方が2本になると片方だけ直る)。
//   ⚠ workerAvailability.js は何も import しないので、輪(循環参照)にはならない。
import {
  normalizeWorkerAvailability, mergeWorkerProfile, workerWindowOn, countWorkerAvailability,
} from './workerAvailability.js';
// 👤 2026-09-10: 人ごとの残業の上書きを解くのは policy.js ただ1本。
//   🚨 1人1日の直接作業分数の決まりの持ち主を2つにしない為(仕様書5.1 / D02)。
//     ここは「解いた答え」を受け取って区間を切るだけで、分を足し引きしない。
//   ⚠ policy.js は何も import しないので、輪(循環参照)にはならない。
import { resolveWorkerDayMinutes } from './policy.js';

// ── 定数 ─────────────────────────────────────────────────────────────────────
const MS_PER_MIN = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MIN;
const MIN_PER_DAY = 24 * 60;

// 暴走止め。5日ぶんのシミュレーションで 400 日ぶん走ったら、それは前提の壊れ方。
// 黙って打ち切ると「働ける時間0」という嘘の答えが出るので、必ず例外にする。
const MAX_LOOKAHEAD_DAYS = 400;

// 休憩の本数の上限。設定の作り間違い(同じ休憩を数千件)でループが伸びるのを止める。
const MAX_BREAKS = 64;

// 画面が要求できる経過日数の上限。仕様書6.2 の horizon 1〜90稼働日に合わせた。
// 90稼働日 ≒ 126暦日で MAX_LOOKAHEAD_DAYS(400) に収まる。
const MAX_ELAPSED_DAYS = 90;

// 納期を解決する時の通常勤務。呼ぶ側が regularSchedule を渡さなかった時だけ使う。
// 🚨 これは「納期の時刻」を決める値であって、1日に働ける量ではない。
//   1日に働ける量(420/540分)は policy.js が決め、directMinutesPerDay で渡ってくる。
const DEFAULT_REGULAR_SCHEDULE = Object.freeze({ dayStart: '08:30', dayEnd: '17:00' });

/** 働けない理由。画面が「休み」と「他の作業」を書き分けられるように、理由を分けて返す。 */
export const UNAVAILABLE = Object.freeze({
  OFF: 'off',                    // workerRoster の 'off' = 終日の休み
  OTHER_WORK: 'other-work',      // workerRoster の 'other' = 他の作業に入っている(検査には回せない)
  ROSTER_UNKNOWN: 'roster-unknown', // roster に見た事のない値。出勤と決めつけず、そのまま出す
  // 👥 2026-09-16 配置(共有棚 placement_rules / 決めた配置)で **向こうの工場の応援** に行っている日。
  //   記号は sharedWorkerPlan.js の SUPPORT_STATUS('support:product' / 'support:final')。
  //   'off' に丸めると画面が「ずっと休み」と嘘を言う(清水さん 2026-09-16)。
  SUPPORT_PRODUCT: 'support-product',
  SUPPORT_FINAL: 'support-final',
  NON_WORKDAY: 'non-workday',    // 土日など workdays に無い曜日
  BEFORE_HOURS: 'before-hours',  // 始業前
  BREAK: 'break',                // 休憩中
  AFTER_HOURS: 'after-hours',    // その日ぶんの時間を使い切った後
});

export const DEFAULT_CALENDAR = Object.freeze({
  directMinutesPerDay: null, // 🚨 呼ぶ側(policy.js)が必ず入れる。null のままなら throw
  // 👤 所定内(残業を含まない)の1日の分数。人ごとの残業を解く時にだけ使う。
  //   🚨 渡さなければ directMinutesPerDay と同じ = 「この見立てに残業ぶんは無い」。
  //     その時は人ごとの残業を登録しても分数は1分も動かない(今までと同じ)。
  regularDirectMinutesPerDay: null,
  dailyHours: null,          // ⚠ 旧API。directMinutesPerDay が無い時だけ見る(橋渡し)
  workdays: [1, 2, 3, 4, 5], // 0=日 .. 6=土。仕様書3章: 稼働日は月〜金
  // 🚨 工場の暦。{ days: { 'YYYY-MM-DD': {type:'off'|'work', label} } }。
  //   null / {} なら **登録なし** = 上の workdays だけで決まる(今までと同じ)。
  factoryCalendar: null,
  dayStartHHMM: '08:30',
  breaks: Object.freeze([
    Object.freeze({ start: '10:00', end: '10:10' }),
    Object.freeze({ start: '12:00', end: '12:45' }),
    Object.freeze({ start: '15:00', end: '15:15' }),
  ]),
  indirectFactor: 1,       // ⚠ 旧API。directMinutesPerDay を渡した時は**使わない**(仕様書5.1)
  absences: Object.freeze({}), // { '2026-07-17': { '村': 'off' } }
  regularSchedule: DEFAULT_REGULAR_SCHEDULE, // 納期解決用。能力とは無関係
  // 👤 人ごとの勤務の窓。{ '村': { dayStart:'09:30', dayEnd:'16:00' }, '片山': { directRatio: 0.7 } }。
  //   null / {} なら **登録なし** = 全員が工場の窓(今までと同じ)。
  workerProfiles: null,
  // 👤 曜日ごとの窓・その日の予定(有給/半休/出張/会議)を **暦に効かせるか**。
  //   🚨 既定は false = 切ってある。渡さなければ 1ミリも変わらない。
  //     true にした時だけ workerAvailability.workerWindowOn がその日の窓を決める。
  //     ⚠ true にしても、byWeekday / days の登録が1件も無ければ答えは同じ
  //       (下の availProfiles が空のままで、窓を決める道を1度も通らない)。
  workerAvailability: false,
  // 🕒 2026-09-16 納期対応の残業・土曜(必要分)。scenario から normalizeInput が写す(overtimePlan.js)。
  //   extraByDay = { 'YYYY-MM-DD': { [名前]: 追加の分数 } } … その人のその日の終業を分数ぶん延ばす
  //   workOnDays = { 'YYYY-MM-DD': [名前, …] }              … 工場の休み(土曜)でも その人だけ通常の窓で働く
  //   extraMaxMinutesPerDay … 1人1日に足せる上限(policy の残業込み上限 − この見立ての1日の分数)。
  //     🚨 上限は policy.js が決めた差を呼ぶ側が渡す。ここで 540 等の数を書かない。
  //   🚨 3つとも null / {} なら **登録なし** = segmentsFor は今までの道しか通らない(1ミリも同じ)。
  extraByDay: null,
  workOnDays: null,
  extraMaxMinutesPerDay: null,
});

// ── 人ごとの勤務の窓(settings.workerProfiles)の読み取り ──────────────────────

/** 'HH:MM' を 0時からの分へ。読めなければ null(例外にしない。1人の書き間違いで全員の計算を止めない)。 */
const hhmmToMinOrNull = (text) => {
  if (typeof text !== 'string' || !/^\d{1,2}:\d{2}$/.test(text.trim())) return null;
  const [h, m] = text.trim().split(':').map(Number);
  if (!(h >= 0 && h <= 24) || !(m >= 0 && m < 60)) return null;
  return h * 60 + m;
};

/**
 * settings.workerProfiles を **1か所で** 読む(normalizeInput も makeCalendar もこれを呼ぶ)。
 *
 * 受ける形: { [名前]: { dayStart?:'HH:MM', dayEnd?:'HH:MM', directRatio?:number(0<r<=1),
 *                      byWeekday?:…, days?:…, overtime?:… } }
 * 返す形:   { profiles: { [名前]: { dayStart:string|null, dayEnd:string|null, directRatio:number|null,
 *                                 byWeekday?, days?, overtime? } }, warnings:string[] }
 *
 * 🚨 読めない値は **黙って丸めない・既定へ寄せない**。捨てて warnings に1行残す。
 *   (清水さんが 9:30 と打ったつもりで '930' と保存されていた時、黙って 08:30 にすると
 *    「設定したのに変わらない」画面になり、誰も気づけない)
 * ⚠ 3つとも無い(全部読めなかった)人は profiles に入れない = 登録なしと同じ。
 *
 * 👤 2026-09-10 の直し ─────────────────────────────────────────────────────────
 *   新しい3欄(byWeekday=曜日ごとの窓 / days=有給・半休・出張・会議 / overtime=残業)を
 *   **workerAvailability.js に読ませて、ここへ合わせる**。
 *   直す前は dayStart / dayEnd / directRatio しか見ておらず、3欄だけを登録した人は
 *   下の「3つとも null なら入れない」で **1人残らず落ちていた**。落ちると
 *   normalizeInput の workerProfileCount が 0 のままになり、入力指紋に workerProfiles の
 *   鍵ごと出ない = 「曜日ごとの時短を登録したのに計算し直さない画面」になる。
 *   ⚠ 3欄の読み方と warnings の文は workerAvailability.js のまま(1文字も変えない)。
 *     ここは呼んで合わせるだけ。warnings は今まで通りの並びの **後ろ** へ足す。
 * @param {object|null} raw settings.workerProfiles
 * @param {object} [o]
 * @param {string[]} [o.rosterNames] 名簿。渡した時は名簿に居ない名前を黙って外す(退職・休止の人の設定が残っていても警告で埋めない)
 */
export function normalizeWorkerProfiles(raw, { rosterNames = null } = {}) {
  const profiles = {};
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { profiles, warnings };
  // 👤 新しい3欄。名簿の絞り方も同じ物を渡す(片方だけ名簿を見る、が起きない様に)。
  const avail = normalizeWorkerAvailability(raw, { rosterNames });
  const allow = Array.isArray(rosterNames) ? new Set(rosterNames.map((n) => String(n ?? '').trim()).filter(Boolean)) : null;
  for (const rawName of Object.keys(raw)) {
    const name = String(rawName ?? '').trim();
    if (!name) continue;
    if (allow && !allow.has(name)) continue;
    const p = raw[rawName];
    if (!p || typeof p !== 'object') continue;

    const out = { dayStart: null, dayEnd: null, directRatio: null };
    let startMin = null;
    let endMin = null;
    if (p.dayStart != null && p.dayStart !== '') {
      startMin = hhmmToMinOrNull(p.dayStart);
      if (startMin == null) warnings.push(`個人設定「${name}」の勤務開始 ${JSON.stringify(p.dayStart)} が HH:MM の形ではないので使っていません`);
      else out.dayStart = String(p.dayStart).trim();
    }
    if (p.dayEnd != null && p.dayEnd !== '') {
      endMin = hhmmToMinOrNull(p.dayEnd);
      if (endMin == null) warnings.push(`個人設定「${name}」の勤務終了 ${JSON.stringify(p.dayEnd)} が HH:MM の形ではないので使っていません`);
      else out.dayEnd = String(p.dayEnd).trim();
    }
    if (startMin != null && endMin != null && !(endMin > startMin)) {
      warnings.push(`個人設定「${name}」の勤務終了 ${out.dayEnd} が勤務開始 ${out.dayStart} より後ではないので、この2つを使っていません`);
      out.dayStart = null;
      out.dayEnd = null;
    }
    if (p.directRatio != null && p.directRatio !== '') {
      const r = Number(p.directRatio);
      if (!Number.isFinite(r) || !(r > 0) || !(r <= 1)) {
        warnings.push(`個人設定「${name}」の直工比率 ${JSON.stringify(p.directRatio)} は 0 より大きく 1 以下の数ではないので使っていません`);
      } else {
        out.directRatio = r;
      }
    }
    // 👤 新しい3欄。**1つでも読めた人は落とさない**(落とすと指紋に出ず、画面が計算し直さない)。
    const extra = Object.prototype.hasOwnProperty.call(avail.profiles, name) ? avail.profiles[name] : null;
    if (out.dayStart == null && out.dayEnd == null && out.directRatio == null && extra == null) continue;
    // ⚠ 合わせ方は workerAvailability.mergeWorkerProfile ただ1本(workerWindowOn が受け取る形と揃える)。
    profiles[name] = mergeWorkerProfile(out, extra);
  }
  // ⚠ 3欄の警告は今まで通りの並びの **後ろ** へ足す(既に見張りが数えている並びを崩さない)。
  avail.warnings.forEach((w) => warnings.push(w));
  return { profiles, warnings };
}

/**
 * 画面の1行(「村 9:30〜16:00 ／ 片山 直工 70%」)。normalizeWorkerProfiles の戻りを受ける。
 * 登録が無ければ ''。数字はここで作らない(設定の写しをそのまま並べるだけ)。
 */
export function describeWorkerProfiles(profiles) {
  if (!profiles || typeof profiles !== 'object') return '';
  const parts = [];
  for (const name of Object.keys(profiles)) {
    const p = profiles[name];
    if (!p) continue;
    const bits = [];
    if (p.dayStart || p.dayEnd) bits.push(`${p.dayStart || '始業'}〜${p.dayEnd || '定時'}`);
    if (p.directRatio != null) bits.push(`直工 ${Math.round(Number(p.directRatio) * 100)}%`);
    if (bits.length) parts.push(`${name} ${bits.join(' ')}`);
  }
  return parts.join(' ／ ');
}

// 設定の検算に使う基準日(月曜)。日付そのものに意味は無く、
// 「始業から1日ぶんの時間が、その日の24時までに収まるか」を組み立て前に1度だけ試すためだけの物。
// 🚨 引数付きの new Date なので、実行の度に値が変わる事は無い。
const REFERENCE_MONDAY_MS = new Date(2026, 0, 5, 0, 0, 0, 0).getTime();

// ── 小道具 ───────────────────────────────────────────────────────────────────

/** 'HH:MM' → 0時からの分。読めない値は握り潰さず例外にする(黙って0時になると始業が真夜中になる)。 */
const parseHHMM = (text, label) => {
  if (typeof text !== 'string' || !/^\d{1,2}:\d{2}$/.test(text.trim())) {
    throw new Error(`calendar: ${label} は 'HH:MM' の形で渡してください（受け取った値: ${JSON.stringify(text)}）`);
  }
  const [h, m] = text.trim().split(':').map(Number);
  if (!(h >= 0 && h <= 24) || !(m >= 0 && m < 60)) {
    throw new Error(`calendar: ${label} の時刻が範囲外です（受け取った値: ${JSON.stringify(text)}）`);
  }
  return h * 60 + m;
};

/**
 * その実時刻の「ローカルのその日の0時」。
 *
 * 🚨 2026-08-30 性能: ここは1回の見立てで延べ100万回以上呼ばれる(実測で全体の中の
 *   単独2位・390ms)。呼ばれ方は「同じ日の中の時刻が続く」ので、**直前に出した1日の
 *   区間だけ**覚えておいて、その中なら Date を作らずに返す。
 *   ⚠ 覚えるのは1日ぶんだけ(表が育たない)。区切りは Date で作った実際の翌日0時なので、
 *     夏時間の切り替わりでも1秒もずれない。答えは1つも変わらない。
 */
let lsodDayStart = NaN;
let lsodDayEnd = NaN;
const localStartOfDay = (ms) => {
  if (ms >= lsodDayStart && ms < lsodDayEnd) return lsodDayStart;
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  const start = d.getTime();
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  lsodDayStart = start;
  lsodDayEnd = d.getTime();
  return start;
};

/** 翌日の0時。日付を跨ぐ加算は setDate に任せる(月末・年末をこちらで数えない)。 */
const nextDayMs = (dayMs) => {
  const d = new Date(dayMs);
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/**
 * その日の0時から min 分後の実時刻。
 * ⚠ dayMs + min*60000 と書かない。setHours なら壁時計の意味が保たれる
 *   (休憩「10:00」は、その日が何分の日でも10時ちょうど)。min は1日ぶんの分数を超えてもよい。
 */
const atMinuteOfDay = (dayMs, min) => {
  const d = new Date(dayMs);
  d.setHours(0, min, 0, 0);
  return d.getTime();
};

/**
 * 'YYYY-MM-DD'。absences の鍵と突き合わせる。UTC へ寄せると日付が1日ずれるので getFullYear 系で作る。
 *
 * 🚨 2026-08-23 性能(案C): ここは1回の見立てで延べ数百万回呼ばれる（日送りの中）。
 *   **その日の0時**を鍵にして覚える。
 *   ⚠ 秒単位の実時刻を鍵にしない事（鍵が際限なく増えて逆に遅くなる）。
 *   ⚠ ローカル時刻に依る。実行中に端末の時刻帯が変わらない前提。
 *   ⚠ 際限なく増えないよう、上限を超えたら丸ごと捨てる（数十年ぶんでも数千件にしかならない）。
 */
const YMD_CACHE = new Map();
const YMD_CACHE_MAX = 20000;
const ymdOf = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  const key = d.getTime();
  const hit = YMD_CACHE.get(key);
  if (hit !== undefined) return hit;
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const out = `${d.getFullYear()}-${mm}-${dd}`;
  if (YMD_CACHE.size >= YMD_CACHE_MAX) YMD_CACHE.clear();
  YMD_CACHE.set(key, out);
  return out;
};

/** 休憩を「開始順・重なりを1本に潰した」形へ。重なったまま引くと同じ時間を二重に引いてしまう。 */
const normalizeBreaks = (rawBreaks) => {
  const list = Array.isArray(rawBreaks) ? rawBreaks : [];
  if (list.length > MAX_BREAKS) {
    throw new Error(`calendar: breaks が ${MAX_BREAKS} 本を超えています（${list.length} 本）。設定を確かめてください`);
  }
  const parsed = list
    .map((b, i) => ({
      startMin: parseHHMM(b?.start, `breaks[${i}].start`),
      endMin: parseHHMM(b?.end, `breaks[${i}].end`),
    }))
    .filter((b) => b.endMin > b.startMin)   // 長さ0・逆順の休憩は無い物として扱う
    .sort((a, b) => (a.startMin - b.startMin) || (a.endMin - b.endMin));

  const merged = [];
  for (const b of parsed) {
    const last = merged[merged.length - 1];
    if (last && b.startMin <= last.endMin) last.endMin = Math.max(last.endMin, b.endMin);
    else merged.push({ ...b });
  }
  return merged;
};

/** workdays を 0..6 の整数の集合へ。空だと永久に働けない日が続くので、その場で止める。 */
const normalizeWorkdays = (raw) => {
  const list = Array.isArray(raw) ? raw : [];
  const set = new Set();
  for (const v of list) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 6) {
      throw new Error(`calendar: workdays は 0(日)〜6(土) の整数で渡してください（受け取った値: ${JSON.stringify(v)}）`);
    }
    set.add(n);
  }
  if (set.size === 0) {
    throw new Error('calendar: workdays が空です。勤務日が1つも無いと、時間をいくら進めても作業が進みません');
  }
  return [...set].sort((a, b) => a - b);
};

/**
 * その日の「働ける区間」を組み立てる。
 *
 * 考え方(ここが本体):
 *   ・**いつ**働けるか = 始業時刻と休憩で決まる。1日の分数では動かない。
 *     休憩は dayStartHHMM からの実時間帯そのもの。420分の日でも540分の日でも12:00に昼休憩が来る。
 *   ・**どれだけ**働けるか = capacityMs (= directMinutesPerDay × 60,000) で決まる。
 *   この2つは食い違う事がある。本番の既定の勤務帯は始業08:30・休憩3本で440分ぶんしか無いのに、
 *   残業シナリオでは 540分 を渡される。
 *   その時は **勤務帯の終わりを後ろへ伸ばして** 540分ぶんを確保する。
 *   定時後に残って続きをやる、という現場の実態がこれ。逆に420分なら定時より早く終わる
 *   (15:15 の休憩明けから 85 分で終わり、その日はそこまで)。
 *   🚨 伸ばすのは「終わり」だけ。始業を早めたり休憩を削ったりはしない。
 *
 * @returns {{start:number,end:number}[]} 実時刻の半開区間 [start, end)。開始順。
 */
const buildDaySegments = (dayMs, norm, capacityMs) => {
  const segs = [];
  let cursorMin = norm.dayStartMin;
  let filled = 0;

  for (const b of norm.breaks) {
    if (filled >= capacityMs) break;          // その日ぶんを使い切った。以降の休憩は関係ない
    if (b.endMin <= cursorMin) continue;      // 始業前に終わる休憩(あるいは既に通り過ぎた休憩)
    if (b.startMin > cursorMin) {
      const s = atMinuteOfDay(dayMs, cursorMin);
      const e = atMinuteOfDay(dayMs, b.startMin);
      const span = e - s;
      if (span > 0) {
        const use = Math.min(span, capacityMs - filled);
        segs.push({ start: s, end: s + use });
        filled += use;
      }
    }
    // 始業に食い込む休憩(start < 始業 < end)もここで正しく飛ばせる
    cursorMin = Math.max(cursorMin, b.endMin);
  }

  if (filled < capacityMs) {
    // 残りは最後の休憩明けから続けて消化する。ここが「定時後へ伸ばす」箇所。
    const s = atMinuteOfDay(dayMs, cursorMin);
    segs.push({ start: s, end: s + (capacityMs - filled) });
  }

  const lastEnd = segs.length ? segs[segs.length - 1].end : dayMs;
  if (lastEnd > nextDayMs(dayMs)) {
    // 日を跨ぐ勤務は、この先の日付ごとの計算がすべて崩れる。黙って切り詰めず止める。
    throw new Error('calendar: 1日ぶんの勤務が翌日へはみ出します。directMinutesPerDay / dayStartHHMM / breaks を見直してください');
  }
  return segs;
};

/**
 * 1日ぶんの能力(ms)を決める。
 *
 * 🚨 新しい入口は directMinutesPerDay ただ1つ。capacityMs = 分 × 60,000。
 *   ここで indirectFactor を掛けたり割ったりしない(仕様書5.1 / D01)。
 *   通常420分・残業540分という数はこのファイルには無い。policy.js が持つ。
 *
 * ⚠ dailyHours / indirectFactor は旧API。directMinutesPerDay が無い時だけ、
 *   既存の呼び出し元(simulate.js の calendarSpec 経由・S13/S14 の試験)を壊さないために使う。
 *
 * @returns {{capacityMs:number, source:'direct'|'legacy-hours', legacyIndirectFactor:number|null, warnings:string[]}}
 */
const resolveCapacity = (merged) => {
  const warnings = [];
  const directRaw = Number(merged.directMinutesPerDay);
  const hasDirect = Number.isFinite(directRaw) && directRaw > 0;

  const hoursRaw = Number(merged.dailyHours);
  const hasHours = Number.isFinite(hoursRaw) && hoursRaw > 0;

  const factorRaw = Number(merged.indirectFactor);
  const factorUsable = Number.isFinite(factorRaw) && factorRaw > 0;

  if (hasDirect) {
    // 🚨 ここが仕様書6.3 の本体。掛け算1つだけ。
    const capacityMs = Math.round(directRaw * MS_PER_MIN);
    if (!(capacityMs > 0)) {
      throw new Error('calendar: directMinutesPerDay が 1ミリ秒未満です。渡した値を確かめてください');
    }
    // ⚠ normalizeInput は当面 dailyHours = directMinutesPerDay/60 を写して渡す(橋渡し)。
    //   同じ値の写しなら黙って使う。**食い違っている時だけ**言う。
    //   食い違いを黙って捨てると「どちらが効いているのか」が誰にも分からなくなる。
    if (hasHours && Math.abs(hoursRaw * 60 - directRaw) > 1e-6) {
      warnings.push(`directMinutesPerDay=${directRaw}分 と dailyHours=${hoursRaw}時間 が食い違っています。directMinutesPerDay を使い、dailyHours は無視します`);
    }
    if (factorUsable && factorRaw !== 1) {
      // 割らない。ただし黙って捨てると「効いているつもり」で使われるので、必ず言う。
      warnings.push(`indirectFactor=${factorRaw} は能力の計算に使っていません（仕様書5.1: 直接作業の分数を係数で割らない）`);
    }
    return {
      capacityMs,
      source: 'direct',
      legacyIndirectFactor: factorUsable ? factorRaw : null,
      warnings,
    };
  }

  if (!hasHours) {
    throw new Error('calendar: directMinutesPerDay を渡してください（1日に直接作業へ使える分数。policy.js の regularDirectMinutesPerDay / overtimeDirectMinutesPerDay から渡す値です）');
  }

  // ── 以下は旧API。新しい呼び出しでは使わない ────────────────────────────
  if (!factorUsable) {
    throw new Error('calendar: indirectFactor は 0 より大きい数で渡してください（1 なら効かせない）');
  }
  // ⚠ 1ミリ秒未満を捨てる(Math.round)理由:
  //   割り切れない値をそのまま持つと、区間ごとに足し込んだ合計と1日ぶんの値が末尾で食い違う
  //   (実測で 0.00008 ミリ秒ずれた)。その差は「働ける時間がまだ 0.00008 ミリ秒残っている」という
  //   扱いになり、長さ0に近い区間へ作業者を割り当てる無意味な配置を生む。
  const capacityMs = Math.round((hoursRaw * MS_PER_HOUR) / factorRaw);
  if (!(capacityMs > 0)) {
    throw new Error('calendar: dailyHours ÷ indirectFactor が 1ミリ秒未満です。渡した値を確かめてください');
  }
  warnings.push('dailyHours / indirectFactor は旧APIです。directMinutesPerDay（policy.js）へ移してください');
  return { capacityMs, source: 'legacy-hours', legacyIndirectFactor: factorRaw, warnings };
};

// ── 納期の解決（仕様書5.3） ──────────────────────────────────────────────────
//
// 🚨 D04: 日付だけの納期を 0:00 として扱っていたのが誤り。
//   「8/24 納期」は 8/24 の朝までではなく、8/24 の通常勤務が終わるまで。
//   0:00 にすると、その日の仕事を前日までに終える計算になり、遅れが1日ぶん多く出る。

/** 'YYYY-MM-DD' / 'YYYY/M/D' / 'YYYY-MM-DDTHH:MM(:SS)' / epoch ms / Date を受ける。 */
const DUE_TEXT_RE = /^\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/;

/**
 * 納期の入力を「年・月・日・(時・分・秒)」へほどく。読めなければ null。
 * 🚨 new Date('2026-08-24') と書かない。ISOの日付だけの文字列は **UTC** として読まれ、
 *   日本時間では 09:00 になってしまう。日付は必ず現地の壁時計として組み立てる。
 */
const parseDueParts = (dueDate) => {
  if (dueDate instanceof Date) {
    const ms = dueDate.getTime();
    if (!Number.isFinite(ms)) return null;
    const d = new Date(ms);
    return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds(), hasTime: true };
  }
  if (typeof dueDate === 'number' && Number.isFinite(dueDate)) {
    const d = new Date(dueDate);
    return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds(), hasTime: true };
  }
  if (typeof dueDate !== 'string') return null;
  const m = DUE_TEXT_RE.exec(dueDate);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) return null;
  const hasTime = m[4] != null;
  return {
    y, mo, d,
    h: hasTime ? Number(m[4]) : 0,
    mi: hasTime ? Number(m[5]) : 0,
    s: hasTime && m[6] != null ? Number(m[6]) : 0,
    hasTime,
  };
};

/**
 * その日の「通常勤務の終わり」の実時刻。
 *
 * @param {number} dateMs   その日のどこかの実時刻(epoch ms)。時刻部分は使わない
 * @param {object} [schedule] { dayEnd: 'HH:MM' }。省略時は 17:00
 * @returns {number} epoch ms
 *
 * ⚠ 残業カレンダーでもここは通常勤務の終わりを返す。納期線は残業で動かない(仕様書5.3 / T008)。
 */
export function resolveRegularWorkEnd(dateMs, schedule) {
  const ms = Number(dateMs);
  if (!Number.isFinite(ms)) {
    throw new Error('calendar: resolveRegularWorkEnd には実時刻(epoch ms)を渡してください');
  }
  const dayEnd = (schedule && typeof schedule.dayEnd === 'string' && schedule.dayEnd.trim())
    ? schedule.dayEnd
    : DEFAULT_REGULAR_SCHEDULE.dayEnd;
  return atMinuteOfDay(localStartOfDay(ms), parseHHMM(dayEnd, 'regularSchedule.dayEnd'));
}

/**
 * 納期の実時刻を決める（仕様書5.3）。
 *
 * @param {object}  o
 * @param {string|number|Date} o.dueDate  '2026-08-24' / '2026-08-24T13:45:00' / '2026/8/24（月）' / epoch ms
 * @param {boolean} [o.hasExplicitTime]   時刻が明示されているか。省略時は dueDate の形から判断する
 * @param {object}  [o.regularSchedule]   { dayStart, dayEnd }。省略時は 08:30-17:00
 * @param {number}  [o.dueOffsetWorkdays] 明示設定された稼働日数だけ日付を後ろへ動かす(仕様書5.3)。既定0
 * @param {number[]}[o.workdays]          稼働日(0=日..6=土)。dueOffsetWorkdays を使う時だけ意味を持つ
 * @param {number}  [o.directMinutesPerDay] 🚨 **受け取るが使わない**。
 *                                        通常420分でも残業540分でも納期線は同じ(T008)。
 *                                        呼ぶ側がカレンダーの設定をそのまま渡しても事故らないように受けている。
 * @returns {number|null} epoch ms。読めない納期は推測せず null（仕様書12章10: 便宜的な値で埋めない）
 */
export function resolveDueAt({
  dueDate,
  hasExplicitTime,
  regularSchedule,
  dueOffsetWorkdays = 0,
  workdays,
  // 🚨 2026-09-02: 稼働日ぶんの移動も祝日を飛ばす。ここが曜日だけだと、
  //   「納期の3営業日前に線を引く」が祝日を1営業日と数えて、線が実際より後ろに立つ。
  factoryCalendar = null,
  // eslint-disable-next-line no-unused-vars
  directMinutesPerDay,
} = {}) {
  const parts = parseDueParts(dueDate);
  if (!parts) return null;

  // 稼働日ぶんの移動。dueBufferDays(暦日) ではなく **稼働日** で動かす(仕様書5.3)。
  let dayMs = new Date(parts.y, parts.mo - 1, parts.d, 0, 0, 0, 0).getTime();
  const offset = Number(dueOffsetWorkdays);
  if (Number.isFinite(offset) && offset > 0) {
    const worksOnDay = makeIsWorkday(
      factoryCalendar,
      normalizeWorkdays(Array.isArray(workdays) ? workdays : DEFAULT_CALENDAR.workdays),
    );
    let moved = 0;
    let guard = 0;
    while (moved < offset) {
      if (++guard > MAX_LOOKAHEAD_DAYS) {
        throw new Error('calendar: dueOffsetWorkdays の移動が長すぎます。workdays と日数を確かめてください');
      }
      dayMs = nextDayMs(dayMs);
      if (worksOnDay(dayMs)) moved += 1;
    }
  }

  // 時刻あり → 元の時刻を保つ。時刻なし → その日の通常勤務終了時刻。
  const keepTime = parts.hasTime && hasExplicitTime !== false;
  if (keepTime) {
    const d = new Date(dayMs);
    d.setHours(parts.h, parts.mi, parts.s, 0);
    return d.getTime();
  }
  // 🚨 ここを 0:00 にしない(D04)。土日が納期でも日時はそのまま返す。
  //   土日に能力が無い事は、カレンダー側(workMsBetween が0)で表す(仕様書5.3)。
  return resolveRegularWorkEnd(dayMs, regularSchedule || DEFAULT_REGULAR_SCHEDULE);
}

// ── 本体 ─────────────────────────────────────────────────────────────────────

/**
 * @param {object} spec DEFAULT_CALENDAR を上書きする設定。directMinutesPerDay は必須。
 * @returns Calendar (CONTRACT.md の形 + 仕様書6.3 の追加分)
 */
export function makeCalendar(spec = {}) {
  const merged = { ...DEFAULT_CALENDAR, ...(spec || {}) };

  const cap = resolveCapacity(merged);
  const capacityMs = cap.capacityMs;

  const dayStartMin = parseHHMM(merged.dayStartHHMM, 'dayStartHHMM');
  if (dayStartMin >= MIN_PER_DAY) {
    throw new Error('calendar: dayStartHHMM が 24:00 以降です');
  }

  const absences = (merged.absences && typeof merged.absences === 'object') ? merged.absences : {};

  // 納期線に使う通常勤務。
  // ⚠ normalizeInput の calendarSpec は dayEndHHMM という名前で定時終了を渡してくる。
  //   同じ物を2通りの名前で受けるのは本意ではないが、あちらは別の担当ファイルなので受け側で吸収する。
  // 🚨 残業カレンダー(540分)でもここは **通常** の終業時刻。納期線は残業で動かない(T008)。
  const regularSchedule = Object.freeze({
    dayStart: (merged.regularSchedule && merged.regularSchedule.dayStart) || merged.dayStartHHMM || DEFAULT_REGULAR_SCHEDULE.dayStart,
    dayEnd: (merged.regularSchedule && merged.regularSchedule.dayEnd)
      || (typeof merged.dayEndHHMM === 'string' && merged.dayEndHHMM.trim() ? merged.dayEndHHMM : null)
      || DEFAULT_REGULAR_SCHEDULE.dayEnd,
  });
  parseHHMM(regularSchedule.dayEnd, 'regularSchedule.dayEnd'); // 形が違えば組み立て時に止める

  const normWorkdays = normalizeWorkdays(merged.workdays);

  /**
   * 🚨 「その日は工場が動くか」を決める **ただ1つの口**。
   *   ・週の形(何曜日) … normWorkdays が持つ(勤務表・シナリオから来る)
   *   ・その日1日の上書き … merged.factoryCalendar が持つ(祝日/全社休業 と 休日出勤)
   *   makeIsWorkday は暦を1回だけ畳んで引くだけの形にする(日ごとに読み直さない)。
   * ⚠ 登録が空なら normWorkdays だけで決まる = 直す前と同じ答え。
   */
  const worksOnDay = makeIsWorkday(merged.factoryCalendar, normWorkdays);

  const norm = {
    dayStartMin,
    breaks: normalizeBreaks(merged.breaks),
    workdays: new Set(normWorkdays),
    worksOnDay,
    absences,
  };

  // 設定の作り間違い(始業が遅すぎる・1日の分数が長すぎる)を、シミュレーションを回す前に出す。
  buildDaySegments(REFERENCE_MONDAY_MS, norm, capacityMs);

  // 日ごとの区間の作り直しを避ける。休みは人ごとに違うが、区間の並び自体は日付だけで決まるので
  // 鍵は日付だけにして、休みは呼び出し口で弾く(人数×日数ぶんの重複計算をしない)。
  const dayCache = new Map();
  const segmentsOfDay = (dayMs) => {
    if (dayCache.has(dayMs)) return dayCache.get(dayMs);
    // 🚨 ここで `norm.workdays.has(new Date(dayMs).getDay())` と曜日だけを見ていたのが、
    //   祝日に1日ぶんの働ける区間を作っていた本体(2026-09-02)。判定は worksOnDay 1本に統一。
    const segs = norm.worksOnDay(dayMs) ? buildDaySegments(dayMs, norm, capacityMs) : [];
    // 5日ぶんでも数十件。念のため上限を置き、超えたら作り直す(取り違えより作り直しの方が安い)。
    if (dayCache.size > MAX_LOOKAHEAD_DAYS * 4) dayCache.clear();
    dayCache.set(dayMs, segs);
    return segs;
  };

  /**
   * その日その人が休みかどうか。
   * 'off'   = 終日の休み。
   * 'other' = 他の作業に入っている。**検査には回せない**ので能力は同じく0。
   *           ただし理由は分けて返す(画面で「休み」と「他の作業」を書き分けるため)。
   * 見た事の無い値は「出勤」と決めつけず、そのまま理由として出す。
   * 元データに無い前提を足さない、というのがこの計画の決め事なので。
   */
  // 🚨 2026-08-30 性能: 休みの表を引くのに毎回 'YYYY-MM-DD' を作っていた。
  //   ymdOf は覚え書きを持っているが、それでも Date を1つ作る。実測で全体の中の
  //   単独1位(480ms)だった。**その日の0時**を鍵にして、引いた結果ごと覚える。
  //   ⚠ 鍵は日付だけなので表は数十件で頭打ち。休みの表そのものは組み立て時に固まっている。
  const absenceDayCache = new Map();
  const absenceDayOf = (dayMs) => {
    if (absenceDayCache.has(dayMs)) return absenceDayCache.get(dayMs);
    const raw = norm.absences[ymdOf(dayMs)];
    const day = (raw && typeof raw === 'object') ? raw : null;
    if (absenceDayCache.size > MAX_LOOKAHEAD_DAYS * 4) absenceDayCache.clear();
    absenceDayCache.set(dayMs, day);
    return day;
  };

  const absenceReasonOf = (dayMs, workerName) => {
    if (!workerName) return null;
    const day = absenceDayOf(dayMs);
    if (!day) return null;
    const status = day[workerName];
    if (status == null || status === '' || status === 'present') return null;
    if (status === 'off') return UNAVAILABLE.OFF;
    if (status === 'other') return UNAVAILABLE.OTHER_WORK;
    if (status === 'support:product') return UNAVAILABLE.SUPPORT_PRODUCT;
    if (status === 'support:final') return UNAVAILABLE.SUPPORT_FINAL;
    return UNAVAILABLE.ROSTER_UNKNOWN;
  };

  // ── 👤 人ごとの勤務の窓(2026-09-05。決め方はファイル頭の注記) ─────────────────
  // 🚨 ここが **唯一の計算場所**。workMsBetween / addDirectWorkMs / nextBoundaryAfter /
  //   unavailableReason / dayCapacityMs(name) は全部 segmentsFor を通るので、ここを直せば全部揃う。
  const wp = normalizeWorkerProfiles(merged.workerProfiles);
  // 👤 2026-09-10 の配線: 曜日ごとの窓・その日の予定を暦に効かせるか。
  //   🚨 既定 false。渡されなければ この下の availProfiles は空のままで、
  //     窓の決め方は 2026-09-05 のまま(dayStart / dayEnd / directRatio だけ)= 1ミリも変わらない。
  const availabilityOn = merged.workerAvailability === true;
  // 👤 2026-09-10 人ごとの残業(清水さん「残業は個人毎でお願い、しない人はしない人でいるからね」)。
  //   🚨 分を決めるのは policy.js の resolveWorkerDayMinutes ただ1本。ここでは足し引きしない。
  //   🚨 所定内が渡されない時は「この見立てに残業ぶんは無い」= 誰の分数も1分も動かない。
  const dayMinutes = Math.round(capacityMs / MS_PER_MIN);
  const regularRaw = Number(merged.regularDirectMinutesPerDay);
  const regularProvided = merged.regularDirectMinutesPerDay != null && merged.regularDirectMinutesPerDay !== '';
  const regularUsable = Number.isFinite(regularRaw) && regularRaw > 0 && Math.round(regularRaw) <= dayMinutes;
  const regularMinutes = regularUsable ? Math.round(regularRaw) : dayMinutes;
  const overtimeWarnings = [];
  if (regularProvided && !regularUsable) {
    // 🚨 黙って寄せない。寄せると「残業しない設定にしたのに何も変わらない」を誰も見つけられない。
    overtimeWarnings.push(`所定内の分数 ${JSON.stringify(merged.regularDirectMinutesPerDay)} が この見立ての1日 ${dayMinutes}分 に収まらないので、残業ぶんは無いものとして数えています`);
  }
  /** 名前 -> policy の答え。**工場から分数が動いた人だけ**(動かない人はこの道を1度も通らない)。 */
  const personDay = new Map();
  /** 名前 -> policy の答え。残業の登録が在る人ぜんぶ(画面の札が「誰の何分がどこから来たか」を言う為)。 */
  const personDayAll = new Map();
  const profileMin = new Map();
  // 👤 曜日ごとの窓・その日の予定を持つ人だけ。ON の時だけ入る。
  const availProfiles = new Map();
  for (const name of Object.keys(wp.profiles)) {
    const p = wp.profiles[name];
    const startMin = p.dayStart != null ? hhmmToMinOrNull(p.dayStart) : null;
    const endMin = p.dayEnd != null ? hhmmToMinOrNull(p.dayEnd) : null;
    const ratio = p.directRatio;
    // 👤 2026-09-10: 新しい3欄(byWeekday / days / overtime)だけを登録した人は、
    //   毎日おなじ窓については **何も書いていない**。切ってある間(availabilityOn=false)は
    //   ここへ入れない。入れると工場の窓をそのまま切り直すだけの空回りになる
    //   (1回の見立てで延べ100万回通る道)。
    //   ⚠ ON の時は入れる。入れないと windowOfSegments が prof を引けず、
    //     曜日ごとの窓を登録した人が素通りしてしまう(設定したのに変わらない画面)。
    // 🚨 「曜日ごとの窓・その日の予定が在るか」も **数えるのは workerAvailability.js**。
    //   ここで欄の名前を書いて調べ始めると、読み方が2本になって片方だけ直る
    //   (見張り WA02 がこの1本を守っている)。呼ぶのは組み立て時の1回だけ。
    const avCount = availabilityOn ? countWorkerAvailability({ [name]: p }) : null;
    const hasAvail = !!avCount && (avCount.weekday > 0 || avCount.days > 0);
    if (hasAvail) availProfiles.set(name, p);
    // 👤 この人の1日の分数。**決めるのは policy.js**。ここは答えを受け取るだけ。
    //   🚨 登録が無ければ changed:false = この下の道を1つも通らない(今までと1ミリも同じ)。
    const dayRes = resolveWorkerDayMinutes({
      name,
      base: { regularMin: regularMinutes, dayMin: dayMinutes },
      profile: p,
    });
    if (p && p.overtime) personDayAll.set(name, dayRes);
    if (dayRes.changed) personDay.set(name, dayRes);
    if (startMin == null && endMin == null && ratio == null && !hasAvail && !dayRes.changed) continue;
    profileMin.set(name, { startMin, endMin, ratio });
  }
  const hasProfiles = profileMin.size > 0;

  /**
   * 👤 その日の工場の区間を、**その人の1日の分数**で組み直した物。
   * 🚨 分数は policy.js が決めた値(personDay)をそのまま使う。ここで足し引きしない。
   * ⚠ 分数が動く人が1人も居なければ、この道は1度も通らない(鍵も区間も作らない)。
   */
  const capDayCache = new Map();
  const segmentsOfDayWithCap = (dayMs, capMs) => {
    if (capMs === capacityMs) return segmentsOfDay(dayMs);
    const key = `${capMs}|${dayMs}`;
    if (capDayCache.has(key)) return capDayCache.get(key);
    const segs = norm.worksOnDay(dayMs) ? buildDaySegments(dayMs, norm, capMs) : [];
    if (capDayCache.size > MAX_LOOKAHEAD_DAYS * 4) capDayCache.clear();
    capDayCache.set(key, segs);
    return segs;
  };
  const segmentsOfDayFor = (dayMs, workerName) => {
    const res = (personDay.size > 0 && workerName) ? personDay.get(workerName) : null;
    if (!res) return segmentsOfDay(dayMs);
    return segmentsOfDayWithCap(dayMs, Math.round(res.directMin * MS_PER_MIN));
  };

  /**
   * その日のその人の窓。工場が動かない日・登録の無い人は null。
   * @returns {{startMs:number, endMs:number, effectiveEndMs:number}|null}
   *   startMs/endMs = 本人の窓(無い方は工場の値)。effectiveEndMs = 直工比率で縮めた終わり。
   */
  const windowOfSegments = (dayMs, factory, workerName, skipAvail = false) => {
    const prof = workerName ? profileMin.get(workerName) : null;
    if (!prof) return null;
    if (factory.length === 0) return null;
    const factoryStart = atMinuteOfDay(dayMs, norm.dayStartMin);
    const factoryEnd = factory[factory.length - 1].end;
    let startMs = prof.startMin != null ? atMinuteOfDay(dayMs, prof.startMin) : factoryStart;
    let endMs = prof.endMin != null ? atMinuteOfDay(dayMs, prof.endMin) : factoryEnd;
    // 👤 曜日ごとの窓 / その日の予定(有給・半休・出張・会議)。
    //   🚨 通るのは「切っていない(workerAvailability:true)」かつ「その人に登録が在る」時だけ。
    //     どちらか欠ければ availProfiles が引けず、上の2行のまま = 今までと1ミリも同じ。
    //   🚨 分の計算は workerAvailability.js ただ1本。ここで曜日も半休も読み直さない。
    // 🕒 土曜出勤(workOnDays)の日は曜日の窓を見ない(土曜が「曜日休み」の人が 0分 に化けて、出た事が消える)。
    const avail = (!skipAvail && availProfiles.size > 0 && workerName) ? availProfiles.get(workerName) : null;
    if (avail) {
      const w = workerWindowOn({
        name: workerName,
        ymd: ymdOf(dayMs),
        profile: avail,
        // 工場一律は「この日の実際の区間」から渡す(祝日・休日出勤で区間が変わるため)。
        factoryWindow: {
          startMin: Math.round((factoryStart - dayMs) / 60000),
          endMin: Math.round((factoryEnd - dayMs) / 60000),
        },
      });
      // 🚨 その日が休み(有給・曜日休み・時間数の入っていない出張)なら **幅0の窓** を返す。
      //   clipToWindow が空の区間を作り、その人のその日は0分になる。
      //   ⚠ null を返して「登録なし」に化けさせない(休みが工場一律に戻ってしまう)。
      if (w.off) return { startMs: dayMs, endMs: dayMs, effectiveEndMs: dayMs };
      if (w.startMin != null && w.endMin != null) {
        startMs = atMinuteOfDay(dayMs, w.startMin);
        endMs = atMinuteOfDay(dayMs, w.endMin);
      }
    }
    // 管理業務ぶんは1日の終わりに固めて置く = 窓の終わりを縮める(始業は動かさない)。
    //   ⚠ 窓(end−start)には休憩も入っている。「比率」は窓に対する割合であって、
    //     直接作業の分数に対する割合ではない(清水さんの言葉どおり「勤務時間のうちの割合」)。
    const effectiveEndMs = prof.ratio != null
      ? Math.round(startMs + (endMs - startMs) * prof.ratio)
      : endMs;
    return { startMs, endMs, effectiveEndMs };
  };
  const workerWindowOf = (dayMs, workerName) => windowOfSegments(dayMs, segmentsOfDayFor(dayMs, workerName), workerName);

  /** 工場の区間を本人の窓 [startMs, effectiveEndMs) で切る。窓が無ければ工場の区間そのまま。 */
  const clipToWindow = (dayMs, factory, workerName, skipAvail = false) => {
    const win = windowOfSegments(dayMs, factory, workerName, skipAvail);
    if (!win) return factory;
    const segs = [];
    for (const s of factory) {
      const a = Math.max(s.start, win.startMs);
      const b = Math.min(s.end, win.effectiveEndMs);
      if (b > a) segs.push({ start: a, end: b });
    }
    return segs;
  };

  /** その日のその人の区間(本人の窓で切った物)。休みは見ない(呼ぶ側が先に弾く)。 */
  const personalSegCache = new Map();
  const personalSegmentsOf = (dayMs, workerName) => {
    const key = `${workerName}|${dayMs}`;
    if (personalSegCache.has(key)) return personalSegCache.get(key);
    const segs = clipToWindow(dayMs, segmentsOfDayFor(dayMs, workerName), workerName);
    if (personalSegCache.size > MAX_LOOKAHEAD_DAYS * 4 * Math.max(1, profileMin.size)) personalSegCache.clear();
    personalSegCache.set(key, segs);
    return segs;
  };

  /** その人がその日に働ける区間(残業・土曜の案を **見ない** 素の答え)。休みなら空。登録のある人は本人の窓で切った区間。 */
  const baseSegmentsFor = (dayMs, workerName) => {
    if (absenceReasonOf(dayMs, workerName)) return [];
    // ⚠ 登録が0人なら Map すら引かない(1回の見立てで延べ100万回通る道。性能を1ミリも変えない)。
    if (hasProfiles && workerName && profileMin.has(workerName)) return personalSegmentsOf(dayMs, workerName);
    return segmentsOfDay(dayMs);
  };

  // ── 🕒 納期対応の残業・土曜(必要分)(2026-09-16 清水さん「必要なタイミングで必要な分をする計算」) ──
  // 🚨 ここが **唯一の入口**(segmentsFor)。workMsBetween / addDirectWorkMs / nextBoundaryAfter /
  //   unavailableReason は全部 segmentsFor を通るので、ここで延ばせば全部揃う。
  // 🚨 渡されなければ(null / {})下の hasPlan が false で、segmentsFor は baseSegmentsFor そのもの = 1ミリも同じ。
  const extraByDay = (merged.extraByDay && typeof merged.extraByDay === 'object') ? merged.extraByDay : {};
  const workOnDays = (merged.workOnDays && typeof merged.workOnDays === 'object') ? merged.workOnDays : {};
  // ⚠ null / '' は「上限なし」。Number(null) は 0 なので、先に有無を見る(0 にすると全部切れて「足したのに増えない」)。
  const extraMaxProvided = merged.extraMaxMinutesPerDay != null && merged.extraMaxMinutesPerDay !== '';
  const extraMaxRaw = Number(merged.extraMaxMinutesPerDay);
  const extraMaxMs = (extraMaxProvided && Number.isFinite(extraMaxRaw) && extraMaxRaw >= 0) ? Math.round(extraMaxRaw * MS_PER_MIN) : null;
  const hasExtra = Object.keys(extraByDay).length > 0;
  const hasWorkOn = Object.keys(workOnDays).length > 0;
  const hasPlan = hasExtra || hasWorkOn;
  /** その人のその日の追加の分数(ms)。無ければ 0。上限(extraMaxMinutesPerDay)を越えた分は切る。 */
  const extraMsFor = (dayMs, workerName) => {
    if (!hasExtra || !workerName) return 0;
    const day = extraByDay[ymdOf(dayMs)];
    if (!day || typeof day !== 'object') return 0;
    const raw = Number(day[workerName]);
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    const ms = Math.round(raw * MS_PER_MIN);
    return extraMaxMs != null ? Math.min(ms, extraMaxMs) : ms;
  };
  /** その人がその日(工場の休み)に出るか。 */
  const worksOnPlanDay = (dayMs, workerName) => {
    if (!hasWorkOn || !workerName) return false;
    const list = workOnDays[ymdOf(dayMs)];
    return Array.isArray(list) && list.includes(workerName);
  };
  /**
   * 区間の終わりから extraMs ぶん延ばす。休憩は飛ばし、日を跨がない(跨ぐ分は切る)。
   * 🚨 延ばすのは「終わり」だけ(buildDaySegments と同じ決め)。始業も休憩も動かさない。
   */
  const extendSegments = (dayMs, segs, extraMs) => {
    if (!(extraMs > 0) || segs.length === 0) return segs;
    const out = segs.map((s) => ({ start: s.start, end: s.end }));
    let cursorMs = out[out.length - 1].end;
    let remain = extraMs;
    const dayEnd = nextDayMs(dayMs);
    for (let guard = 0; remain > 0 && cursorMs < dayEnd && guard < MAX_BREAKS + 2; guard++) {
      let nextBreak = null;
      for (const b of norm.breaks) {
        const be = atMinuteOfDay(dayMs, b.endMin);
        if (be <= cursorMs) continue;
        nextBreak = { start: atMinuteOfDay(dayMs, b.startMin), end: be };
        break;
      }
      if (nextBreak && nextBreak.start <= cursorMs) { cursorMs = nextBreak.end; continue; }
      const limit = nextBreak ? Math.min(nextBreak.start, dayEnd) : dayEnd;
      const span = Math.min(limit - cursorMs, remain);
      if (span <= 0) break;
      const last = out[out.length - 1];
      if (last.end === cursorMs) last.end += span; else out.push({ start: cursorMs, end: cursorMs + span });
      remain -= span;
      cursorMs += span;
    }
    return out;
  };
  const planSegCache = new Map();
  /** その人がその日に働ける区間(残業・土曜の案を **含む**)。案が無ければ baseSegmentsFor と同じ物。 */
  const segmentsFor = (dayMs, workerName) => {
    if (!hasPlan || !workerName) return baseSegmentsFor(dayMs, workerName);
    const key = `${workerName}|${dayMs}`;
    if (planSegCache.has(key)) return planSegCache.get(key);
    let segs = baseSegmentsFor(dayMs, workerName);
    if (segs.length === 0 && !absenceReasonOf(dayMs, workerName) && segmentsOfDay(dayMs).length === 0 && worksOnPlanDay(dayMs, workerName)) {
      // 工場の休みの日に この人だけ出る: 工場が動く日と同じ区間を組み、本人の窓で切る(曜日の窓は見ない)。
      const res = (personDay.size > 0) ? personDay.get(workerName) : null;
      const capMs = res ? Math.round(res.directMin * MS_PER_MIN) : capacityMs;
      segs = clipToWindow(dayMs, buildDaySegments(dayMs, norm, capMs), workerName, true);
    }
    segs = extendSegments(dayMs, segs, extraMsFor(dayMs, workerName));
    if (planSegCache.size > MAX_LOOKAHEAD_DAYS * 8) planSegCache.clear();
    planSegCache.set(key, segs);
    return segs;
  };

  const isWorkday = (ms) => {
    if (!Number.isFinite(ms)) return false;
    return segmentsOfDay(localStartOfDay(ms)).length > 0;
  };
  // 🚨 この関数をそのまま forecast.buildMonthPeriods へ渡す(「同じ数字を2つの計算から出さない」)。
  //   札に「祝日◯日」を出す側が、登録された休みを数え直せる様に、畳んだ暦を持たせておく。
  //   ⚠ 画面が days を書き換えないよう凍らせる。
  isWorkday.days = Object.freeze({ ...(worksOnDay.days || {}) });
  isWorkday.workdays = Object.freeze([...normWorkdays]);

  /**
   * 働けない理由。働けるなら null。
   * ⚠ CONTRACT.md の表には無い追加。指示書6.4の
   *   「適格な仕事が残っているのに待機と出す場合は理由を必須にする」を満たすために要る。
   */
  const unavailableReason = (ms, workerName) => {
    if (!Number.isFinite(ms)) {
      throw new Error('calendar: unavailableReason には実時刻(epoch ms)を渡してください');
    }
    const dayMs = localStartOfDay(ms);
    const absent = absenceReasonOf(dayMs, workerName);
    if (absent) return absent;

    // 工場が動かない日は、誰であっても NON_WORKDAY(本人の窓より先に見る)。
    //   🕒 ただし土曜出勤の案(workOnDays)でこの人が出る日は、その人の区間で答える。
    if (segmentsOfDay(dayMs).length === 0 && !worksOnPlanDay(dayMs, workerName)) return UNAVAILABLE.NON_WORKDAY;
    // 👤 登録のある人は本人の窓で切った区間で「始業前／休憩／時間外」を答える(村さんの 16:00 以降は時間外)。
    const segs = segmentsFor(dayMs, workerName);
    if (segs.length === 0) return UNAVAILABLE.AFTER_HOURS;
    if (ms < segs[0].start) return UNAVAILABLE.BEFORE_HOURS;
    for (const s of segs) {
      if (ms >= s.start && ms < s.end) return null;
    }
    if (ms >= segs[segs.length - 1].end) return UNAVAILABLE.AFTER_HOURS;
    return UNAVAILABLE.BREAK;
  };

  const isAvailable = (ms, workerName) => unavailableReason(ms, workerName) === null;

  /** fromMs 以上 toMs 未満で、その人が実際に働けるミリ秒。土日・休憩・休みは 0(S15)。 */
  const workMsBetween = (fromMs, toMs, workerName) => {
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
      throw new Error('calendar: workMsBetween には実時刻(epoch ms)を2つ渡してください');
    }
    if (!(toMs > fromMs)) return 0;

    let total = 0;
    let dayMs = localStartOfDay(fromMs);
    let guard = 0;
    while (dayMs < toMs) {
      if (++guard > MAX_LOOKAHEAD_DAYS) {
        throw new Error(`calendar: workMsBetween の期間が ${MAX_LOOKAHEAD_DAYS} 日を超えました。渡した from/to を確かめてください`);
      }
      for (const s of segmentsFor(dayMs, workerName)) {
        const a = Math.max(s.start, fromMs);
        const b = Math.min(s.end, toMs);
        if (b > a) total += b - a;
      }
      dayMs = nextDayMs(dayMs);
    }
    return total;
  };

  /**
   * 🚨 時間変換の唯一の入口（仕様書6.3）。
   * fromMs から「直接作業に使える時間を workMs ぶん使い切った」実時刻。
   * +0.3日 も 5日 も 30日 も、必ずこの関数を通す(elapsedDaysToMs 経由)。
   *
   * 🚨 workMs=0 は「今すぐ働けるならその時刻、働けないなら次に働ける時刻」。
   *   ここで fromMs をそのまま返すと、休憩中や夜中に張り付いた作業者が
   *   永久に同じ時刻で回り続ける(進まないまま再配置を繰り返す)。
   *
   * @param {number} fromMs      起点の実時刻(epoch ms)
   * @param {number} workMs      使う直接作業の時間(ミリ秒)
   * @param {string} [workerName] 休み(absences)を見るための名前。省略すると誰の休みも見ない
   */
  const addDirectWorkMs = (fromMs, workMs, workerName) => {
    if (!Number.isFinite(fromMs)) {
      throw new Error('calendar: addDirectWorkMs には実時刻(epoch ms)を渡してください');
    }
    const need = Number(workMs);
    if (!Number.isFinite(need) || need < 0) {
      throw new Error('calendar: addDirectWorkMs の workMs は 0 以上のミリ秒で渡してください');
    }

    let remain = need;
    let dayMs = localStartOfDay(fromMs);
    for (let guard = 0; guard < MAX_LOOKAHEAD_DAYS; guard++) {
      for (const s of segmentsFor(dayMs, workerName)) {
        const start = Math.max(s.start, fromMs);
        if (s.end <= start) continue;          // fromMs より前に終わる区間
        if (remain === 0) return start;        // 「次に働ける時刻」まで進めるだけ
        const cap = s.end - start;
        if (remain <= cap) return start + remain;
        remain -= cap;
      }
      dayMs = nextDayMs(dayMs);
    }
    throw new Error(`calendar: addDirectWorkMs が ${MAX_LOOKAHEAD_DAYS} 日ぶん進んでも終わりませんでした（残り ${Math.round(remain / MS_PER_MIN)} 分）。休みの設定か作業時間を確かめてください`);
  };

  /**
   * ⚠ 旧名。中身は addDirectWorkMs と同一。
   *   simulate.js / priority.js / OperationsSimulationPanel.jsx がまだこの名前で呼んでいる。
   *   それらは別の担当ファイルなので、橋渡しとして残す。新しく書く所では使わない。
   */
  const addWorkMs = (fromMs, workMs, workerName) => addDirectWorkMs(fromMs, workMs, workerName);

  /**
   * ms より後で、最初に「働ける/働けない」が入れ替わる実時刻。イベント駆動の次の目印に使う。
   * 見つからなければ null(ここで適当な時刻を返すと、その嘘がそのまま突破日時になる)。
   */
  const nextBoundaryAfter = (ms, workerName) => {
    if (!Number.isFinite(ms)) {
      throw new Error('calendar: nextBoundaryAfter には実時刻(epoch ms)を渡してください');
    }
    let dayMs = localStartOfDay(ms);
    for (let guard = 0; guard < MAX_LOOKAHEAD_DAYS; guard++) {
      for (const s of segmentsFor(dayMs, workerName)) {
        if (ms < s.start) return s.start;   // 休憩明け・翌朝の始業
        if (ms < s.end) return s.end;       // 今の区間の終わり(休憩入り・その日の終わり)
      }
      dayMs = nextDayMs(dayMs);
    }
    return null;
  };

  /**
   * 1日ぶんの働ける時間(ms) = directMinutesPerDay × 60,000。
   * 画面の「+0.3日」はこれの 0.3 倍(通常126分 / 残業162分 — 仕様書3章)。
   *
   * ⚠ 契約の並びは dayCapacityMs(workerName) だが、引数は受け取らない形にしてある。
   *   1日ぶんの量は人で変わらず、人ごとの違い(休み・他の作業)は「その日まるごと0」として
   *   absences 側で表しているため、ここで人を見ると同じ事を2箇所で決める事になる。
   *   呼ぶ側が名前を渡しても JavaScript 側で捨てられるので、呼び出しは壊れない。
   * ⚠ 日付を取らないので、休みの日でもこの値を返す。ある日その人が働けるかは
   *   workMsBetween / isAvailable / unavailableReason で見る事。
   *
   * 👤 2026-09-05: 名前を渡した時だけ、その人の窓(workerProfiles)で切った1日ぶんを返す。
   *   登録の無い人・名前なし = 工場の値(今までと同じ)。日付は取らないので、
   *   どの日でも同じ形になる基準の月曜(REFERENCE_MONDAY_MS)で1回だけ数える。
   *   ⚠ elapsedDaysToMs(画面の時間軸)は名前なしで呼ぶ。時間軸は工場の1日であって、人の1日ではない。
   */
  const dayCapacityMs = (workerName) => {
    // 👤 2026-09-10: 残業をしない人・上限の在る人は、1日ぶんの量そのものが短い。
    const res = (personDay.size > 0 && workerName) ? personDay.get(workerName) : null;
    const capMs = res ? Math.round(res.directMin * MS_PER_MIN) : capacityMs;
    if (!(hasProfiles && workerName && profileMin.has(workerName))) return capMs;
    // ⚠ 基準の月曜が工場の暦で休み(年末年始が 1/5 まで等)でも 0 にならないよう、
    //   暦を見ずに「工場が動く日の区間」を組んでから本人の窓で切る。
    const factory = buildDaySegments(REFERENCE_MONDAY_MS, norm, capMs);
    return clipToWindow(REFERENCE_MONDAY_MS, factory, workerName).reduce((a, s) => a + (s.end - s.start), 0);
  };

  /** その日の通常勤務の終わり。納期線に使う。残業カレンダーでも同じ時刻を返す(T008)。 */
  const regularWorkEndOf = (ms) => resolveRegularWorkEnd(ms, regularSchedule);

  return Object.freeze({
    spec: Object.freeze({
      directMinutesPerDay: capacityMs / MS_PER_MIN,
      capacitySource: cap.source,          // 'direct' | 'legacy-hours'
      legacyIndirectFactor: cap.legacyIndirectFactor, // 診断表示だけに使う(仕様書5.1)
      // 👤 人ごとの窓の読めなかった値も、能力の警告と同じ列に並べる(黙って捨てない)。
      warnings: Object.freeze([...cap.warnings, ...wp.warnings, ...overtimeWarnings]),
      // 👤 所定内(残業を含まない)の1日の分数。渡されなければ1日の分数と同じ。
      regularDirectMinutesPerDay: regularMinutes,
      // 👤 人ごとの残業の答え(policy.js が解いた物をそのまま)。登録が無ければ {} と 0 = 直す前と同じ姿。
      //   画面はここの why をそのまま札に出す(数え直さない・言い換えない)。
      workerDayMinutes: Object.freeze(Object.fromEntries(personDayAll)),
      workerDayMinutesCount: personDayAll.size,
      workerDayMinutesChangedCount: personDay.size,
      // 👤 効いている個人設定(読めた物だけ)。登録が無ければ {} と 0 = 直す前と同じ姿。
      workerProfiles: Object.freeze({ ...wp.profiles }),
      workerProfileCount: Object.keys(wp.profiles).length,
      // 🕒 納期対応の残業・土曜の案が効いているか(日×人の数)。渡されなければ 0 と 0 = 直す前と同じ姿。
      overtimePlanExtraCount: Object.values(extraByDay).reduce((a, d) => a + ((d && typeof d === 'object') ? Object.keys(d).length : 0), 0),
      overtimePlanWorkOnCount: Object.values(workOnDays).reduce((a, l) => a + (Array.isArray(l) ? l.length : 0), 0),
      workdays: [...norm.workdays],
      // 🚨 登録された工場の暦。**登録が空なら {} と 0** = 直す前と同じ姿。
      //   画面はこれを「祝日を引いた計算です」と言い切る根拠に使う。
      factoryCalendarDays: Object.freeze({ ...(worksOnDay.days || {}) }),
      factoryCalendarCount: Object.keys(worksOnDay.days || {}).length,
      dayStartHHMM: merged.dayStartHHMM,
      breaks: merged.breaks,
      regularSchedule,
      absences,
      // ⚠ 旧API。渡された値をそのまま映しているだけで、能力の計算には使っていない
      dailyHours: Number.isFinite(Number(merged.dailyHours)) ? Number(merged.dailyHours) : null,
      indirectFactor: cap.legacyIndirectFactor,
    }),
    isWorkday,
    isAvailable,
    unavailableReason,
    workMsBetween,
    addDirectWorkMs,
    addWorkMs,          // ⚠ 旧名の橋渡し
    nextBoundaryAfter,
    dayCapacityMs,
    regularWorkEndOf,
    // 👤 その日のその人の窓 {startMs,endMs,effectiveEndMs}。登録の無い人・工場が動かない日は null。
    //   画面や試験が「どこで切ったか」を見る為の物。数字はここ(calendar.js)以外で作らない。
    workerWindowOf,
  });
}

/**
 * 画面の時間軸「経過日 0.0〜5.0」を実時刻へ直す（仕様書5.2 / D05）。
 *
 * 🚨 elapsedDays は **1..5 ではなく 0.0..5.0**。
 *   0.0 = いま（= baseNowMs そのもの）。0.3 = 1回進めた状態。5.0 = 5日ぶんの能力を使い切った状態。
 *   以前は「1日目 = 開始時刻」として (day-1) を足していたため、5日目の表示が4日ぶんしか進まなかった。
 *
 * 🚨 通常(420分)と残業(540分)で1日の長さが違う。ここは calendar.dayCapacityMs() を掛けるだけで、
 *   420/540 という数はこのファイルに書かない。
 *
 * @param {object} calendar     makeCalendar() の戻り値
 * @param {number} baseNowMs    基準時刻(epoch ms)。シナリオ間で必ず同じ値を使う(仕様書5.8)
 * @param {number} elapsedDays  0.0 以上 90 以下
 * @param {string} [workerName] 特定の人の休みを反映したい時だけ渡す。既定は誰の休みも見ない
 * @returns {number} epoch ms
 */
/**
 * 画面の記録(スナップショット)を **いつ撮るか** の一覧。
 *
 * 🚨 2026-08-23 是正: それまでは「30分ごと」で撮っていた。
 *   5日で337枚(23MB)、30日は上限600枚に当たって **12.5日ぶんで黙って打ち切られていた**。
 *   30日と言いながら12.5日しか残っていないのは「30日予測」ではない。
 *   → **要求する時刻を先に決めて、その時刻だけ撮る**。
 *      5日 : 0.0 / 0.3 / 0.6 … 4.8 / 5.0（つまみの刻みと同じ = 18枚）
 *      30日: 0 / 1 / 2 … 30（31枚）
 *   これで枚数が 337→18、600(打ち切り)→31 になり、上限に当たらない。
 *
 * ⚠ 「納期を越えた瞬間」の様な大事な出来事は、この一覧とは別に milestones へ残す
 *   （粗い刻みで見落とさないため）。
 *
 * @param {object} args
 * @param {object} args.calendar makeCalendar() の戻り値
 * @param {number} args.baseNow 基準時刻
 * @param {number} args.horizonDays 何日ぶん見るか
 * @param {number} [args.fineStep] 5日以下の時の刻み(日)。既定 0.3
 * @returns {Array<{elapsedDays:number, targetMs:number}>} 時刻の昇順
 */
export function buildSnapshotTargets({ calendar, baseNow, horizonDays, fineStep = 0.3 } = {}) {
  const hz = Number(horizonDays);
  if (!Number.isFinite(hz) || hz <= 0) return [];
  const step = Number.isFinite(Number(fineStep)) && Number(fineStep) > 0 ? Number(fineStep) : 0.3;

  const elapsed = [];
  if (hz <= 5) {
    // ⚠ 0.1 の足し算は誤差が出る(0.30000000000000004)。必ず小数1桁へ丸める。
    for (let d = 0; d < hz; d += step) elapsed.push(Math.round(d * 10) / 10);
  } else {
    for (let d = 0; d <= hz; d += 1) elapsed.push(d);
  }
  // 🚨 終点を必ず入れる。ここが無いと「30日表示」なのに 29日で終わる。
  if (elapsed.length === 0 || elapsed[elapsed.length - 1] !== hz) elapsed.push(hz);

  const out = [];
  for (const d of elapsed) {
    let targetMs;
    try { targetMs = elapsedDaysToMs(calendar, baseNow, d); } catch { continue; }
    if (Number.isFinite(targetMs)) out.push({ elapsedDays: d, targetMs });
  }
  out.sort((a, b) => a.targetMs - b.targetMs || a.elapsedDays - b.elapsedDays);
  return out;
}

export function elapsedDaysToMs(calendar, baseNowMs, elapsedDays, workerName) {
  if (!calendar || typeof calendar.dayCapacityMs !== 'function' || typeof calendar.addDirectWorkMs !== 'function') {
    throw new Error('calendar: elapsedDaysToMs の第1引数には makeCalendar() の戻り値を渡してください');
  }
  const base = Number(baseNowMs);
  if (!Number.isFinite(base)) {
    throw new Error('calendar: elapsedDaysToMs には基準時刻(epoch ms)を渡してください');
  }
  const days = Number(elapsedDays);
  if (!Number.isFinite(days) || days < 0) {
    throw new Error('calendar: elapsedDaysToMs の elapsedDays は 0 以上の数で渡してください（0.0 が「いま」）');
  }
  if (days > MAX_ELAPSED_DAYS) {
    throw new Error(`calendar: elapsedDaysToMs の elapsedDays が ${MAX_ELAPSED_DAYS} 日を超えています（受け取った値: ${days}）`);
  }
  // 🚨 0.0 は「いま」そのもの。ここで addDirectWorkMs(base, 0) を通すと、
  //   基準時刻が休憩中・夜間・土日の時に「次に働ける時刻」へ飛んでしまい、
  //   画面の左端が現在時刻とずれる(T005)。
  if (days === 0) return base;

  return calendar.addDirectWorkMs(base, days * calendar.dayCapacityMs(), workerName);
}
