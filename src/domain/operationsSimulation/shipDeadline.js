// ============================================================================
// 🚚 出荷日から逆算した「本当の締切」— 検査の予定日と出荷日を分けて持つ
// ----------------------------------------------------------------------------
// いまの操業シミュレーションは lot.dueDate ただ1つを納期線にしている。
// ところが normalizeInput.js 自身がこう書いている:
//     「lot.dueDate は **予定日** であって守るべき納期ではない(完了実績の53.7%がこの日を過ぎている)」
// 遅れの札が半分以上のロットに立つので、**本当に間に合わない物が埋もれる**。
//
// 現場の表には最初から2つの日付が並んでいる:
//   工機進捗管理表 / 進捗管理表シート … Z列「中間・製品検査 予定日」/ AD列「出荷 予定日」
//   同 / 最終検査状況シート ………………… C列「納期」/ D列「出荷」
//
// 実物の Excel で実測(C:/Users/anrw3/Downloads/工機進捗管理表 (2).xlsx・取得日 2026/9/9):
//   [進捗管理表] 指図番号のある行 538件
//       Z列(検査予定日)が日付 …… 71件(日付でない書き方 130件。「①Z8/28①Z8/31」など)
//       AD列(出荷予定日)が日付 … 201件(日付でない書き方 259件。「M9/7」「しTGS」など)
//       両方が日付 ……………………… 57件
//       差(出荷 − 検査)の中央値 **2日**(p25 1日 / p75 7日 / 最小 −12日 / 最大 30日)
//       0日 6件 / 出荷の方が前 6件 / 営業日で数えた差の中央値も 2日(51件)
//   [最終検査状況] 指図のある行 80件 / 納期と出荷が両方日付 35件
//       差(出荷 − 納期)の中央値 **1日**(p25 1日 / p75 3日 / 最大 6日 / 前は0件)
//   → 検査の予定日と出荷日は **同じ日ではない**。中央で1〜2日、上位4分の1は7日以上ずれる。
//
// 本番の写しで実測(2026-09-10_0100 / product-inspection-v1・lots 603件):
//   出荷日に当たる欄は **1件も無い**(lot の鍵は 39種類。shipDate も shipYMD も0件)。
//   → 出荷日は **表から取り込んだ時に入る**。それまでこの関数は今までどおり
//     検査の予定日(lot.dueDate)だけで答える = 1ミリも計算が変わらない。
//
// 🚨 決め事(CONTRACT.md 0章):
//   ・React / Firebase を import しない。純関数だけ。
//   ・関数の中で現在時刻や乱数を取らない。時刻は必ず引数で受ける(同じ入力→同じ答え)。
//   ・推測で値を埋めない。読めない日付は null と why で返す。
// 🚨 納期の時刻の解決は calendar.js の resolveDueAt ただ1本(仕様書5.3)。
//   日付だけの日は **その日の通常勤務終了時刻**。0:00 にしない。ここで別の決め方を書かない。
// 🚨 稼働日の判定は factoryCalendar.js ただ1本。祝日・年末年始・休日出勤を曜日だけで数えない。
// ============================================================================

import { resolveDueAt } from './calendar.js';
import {
  makeIsWorkday, normalizeCalendar, toYmd, prevYmd, nextYmd,
  countWorkdaysBetween, countCalendarDaysBetween,
} from '../factoryCalendar.js';

/** 締切の出どころ。 */
export const DEADLINE_KIND = Object.freeze({
  SHIP: 'ship',       // 出荷日から逆算した
  INSPECT: 'inspect', // 出荷日が無いので検査の予定日そのもの(= 今までと同じ)
  NONE: 'none',       // どちらも読めない
});

/**
 * 梱包などのリードタイムの上限(営業日)。
 * ⚠ これを超える値は設定の書き間違いとして 0日 に戻し、why に残す。
 *   黙って60日ぶん締切を前へ倒すと、全ロットが真っ赤になる。
 */
export const MAX_LEAD_DAYS = 60;

// 逆算が暴走した時の止め。60営業日ぶん遡っても届かない = 暦が全部休みになっている。
const MAX_LOOKBACK_DAYS = 400;

const text = (v) => (v == null ? '' : String(v).trim());

/**
 * ロットが持っている出荷日。
 * 🚨 本番の写し(603件)には **1件も入っていない**。表の取込が入れるまで空のまま。
 *   ここで dueDate から作らない(元データに無い値を作らない)。
 */
export const shipYMDOfLot = (lot) => text(lot && (lot.shipDate ?? lot.shipYMD));

/** 渡された暦を1つの形へ。makeCalendar() の戻り値・生の暦・{workdays, factoryCalendar} を受ける。 */
const calendarContextOf = (calendar) => {
  const c = (calendar && typeof calendar === 'object') ? calendar : null;
  const spec = (c && c.spec && typeof c.spec === 'object') ? c.spec : null;
  // ① makeCalendar() の戻り値
  if (spec && typeof c.isWorkday === 'function') {
    return {
      cal: normalizeCalendar({ days: spec.factoryCalendarDays || {}, workdays: spec.workdays }),
      regularSchedule: spec.regularSchedule || null,
    };
  }
  // ② { workdays, factoryCalendar, regularSchedule } / ③ 生の暦そのもの
  if (c) {
    const rawDays = (c.factoryCalendar != null) ? c.factoryCalendar : c;
    const base = normalizeCalendar(rawDays);
    const cal = normalizeCalendar({ days: base.days, workdays: c.workdays ?? base.workdays });
    return { cal, regularSchedule: c.regularSchedule || null };
  }
  return { cal: normalizeCalendar(null), regularSchedule: null };
};

/** リードタイムの日数を正す。読めない値は 0日 に戻して理由を返す。 */
export const normalizeLeadDays = (v) => {
  if (v == null || v === '') return { days: 0, warn: '' };
  const n = (typeof v === 'number' || (typeof v === 'string' && String(v).trim() !== '')) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 0) return { days: 0, warn: `梱包などにかかる日数「${text(v)}」が読めません。0日として数えます` };
  if (n > MAX_LEAD_DAYS) return { days: 0, warn: `梱包などにかかる日数 ${n}日 は上限の ${MAX_LEAD_DAYS}日 を超えています。0日として数えます` };
  return { days: n, warn: '' };
};

/**
 * 2つの日の間の営業日数(符号つき)。
 *   b が a より後 … (a の翌日 〜 b) の営業日数(正)
 *   b が a より前 … (b の翌日 〜 a) の営業日数に − を付ける
 * ⚠ 両端の扱いを片方だけ含める(a の当日は数えない)。「あと何営業日ずらせるか」の数え方。
 */
export const signedWorkdaysBetween = (fromYmd, toYmd_, cal) => {
  const a = toYmd(fromYmd);
  const b = toYmd(toYmd_);
  if (!a || !b) return null;
  if (a === b) return 0;
  if (a < b) return countWorkdaysBetween({ from: nextYmd(a), to: b, calendar: cal });
  return -countWorkdaysBetween({ from: nextYmd(b), to: a, calendar: cal });
};

/**
 * 検査の予定日と出荷日から「本当の締切」を出す。
 *
 * @param {object} o
 * @param {object|null} o.lot      ロット。dueDate と(将来)出荷日を見る
 * @param {string|null} o.shipYMD  出荷日 'YYYY-MM-DD'(時刻付きも可)。省略時は lot から読む
 * @param {string|null} o.dueYMD   検査の予定日。省略時は lot.dueDate
 * @param {number} [o.leadDays=0]  出荷日から何**営業日**前までに検査を終える必要が在るか(梱包など)
 * @param {object|null} o.calendar makeCalendar() の戻り値 / 生の工場の暦 / {workdays, factoryCalendar}
 * @returns {{
 *   inspectDueMs:number|null, shipDueMs:number|null, hardDueMs:number|null,
 *   kind:'ship'|'inspect'|'none', slackDays:number|null, slackCalendarDays:number|null,
 *   leadDays:number, inspectYmd:string, shipYmd:string, hardYmd:string, why:string[],
 * }}
 *   hardDueMs … 出荷日が在れば「出荷日 − リードタイム(営業日)」の日の通常勤務終了時刻。
 *               出荷日が無ければ今までどおり検査の予定日。
 *   slackDays … 検査の予定日から本当の締切まで、あと何営業日ずらせるか。
 *               **負なら、検査の予定日どおりに終えても出荷に間に合わない**。
 */
export const resolveDeadlines = ({
  lot = null, shipYMD = null, dueYMD = null, leadDays = 0, calendar = null,
} = {}) => {
  const why = [];
  const { cal, regularSchedule } = calendarContextOf(calendar);
  const worksOn = makeIsWorkday(cal);
  const workdays = [...cal.workdays];

  const dueText = text(dueYMD) || text(lot && lot.dueDate);
  const shipText = text(shipYMD) || shipYMDOfLot(lot);

  const at = (v) => (v ? resolveDueAt({
    dueDate: v, regularSchedule: regularSchedule || undefined, workdays, factoryCalendar: cal,
  }) : null);

  const inspectDueMs = at(dueText);
  if (dueText && inspectDueMs == null) why.push(`検査の予定日「${dueText}」が読めません`);
  const shipDueMs = at(shipText);
  if (shipText && shipDueMs == null) why.push(`出荷日「${shipText}」が読めません`);

  const lead = normalizeLeadDays(leadDays);
  if (lead.warn) why.push(lead.warn);

  const inspectYmd = inspectDueMs == null ? '' : (toYmd(inspectDueMs) || '');
  const shipYmd = shipDueMs == null ? '' : (toYmd(shipDueMs) || '');

  let hardDueMs = null;
  let hardYmd = '';
  let kind = DEADLINE_KIND.NONE;

  if (shipDueMs != null) {
    kind = DEADLINE_KIND.SHIP;
    if (lead.days === 0) {
      // ⚠ 出荷日そのもの。時刻が書いてあればその時刻を保つ(resolveDueAt がそうする)。
      hardDueMs = shipDueMs;
      hardYmd = shipYmd;
      why.push(`出荷日 ${shipYmd} が締切です`);
    } else {
      let cur = shipYmd;
      let moved = 0;
      let guard = 0;
      while (moved < lead.days) {
        if (++guard > MAX_LOOKBACK_DAYS) {
          throw new Error('shipDeadline: 出荷日からの逆算が長すぎます。工場の暦と日数を確かめてください');
        }
        cur = prevYmd(cur);
        if (!cur) throw new Error('shipDeadline: 出荷日から前の日を数えられませんでした');
        if (worksOn(cur)) moved += 1;
      }
      hardYmd = cur;
      hardDueMs = at(cur);
      why.push(`出荷日 ${shipYmd} の ${lead.days}営業日前(${hardYmd})までに検査を終える必要があります`);
    }
  } else if (inspectDueMs != null) {
    kind = DEADLINE_KIND.INSPECT;
    hardDueMs = inspectDueMs;
    hardYmd = inspectYmd;
    // 🚨 出荷日が無い = 今までどおり。ここで別の日を作らない。
    why.push('出荷日が記録にありません。今までどおり検査の予定日を締切として使います');
  } else {
    why.push('検査の予定日も出荷日も記録にありません。締切の線は引けません');
  }

  const slackDays = (inspectYmd && hardYmd) ? signedWorkdaysBetween(inspectYmd, hardYmd, cal) : null;
  const slackCalendarDays = (inspectYmd && hardYmd)
    ? (inspectYmd === hardYmd
      ? 0
      : (inspectYmd < hardYmd
        ? countCalendarDaysBetween({ from: nextYmd(inspectYmd), to: hardYmd })
        : -countCalendarDaysBetween({ from: nextYmd(hardYmd), to: inspectYmd })))
    : null;

  if (slackDays != null && slackDays < 0) {
    why.push(`検査の予定日 ${inspectYmd} は本当の締切 ${hardYmd} より ${-slackDays}営業日 後ろです`);
  }

  return {
    inspectDueMs, shipDueMs, hardDueMs, kind,
    slackDays, slackCalendarDays,
    leadDays: lead.days, inspectYmd, shipYmd, hardYmd, why,
  };
};

/**
 * 終わる見込みの時刻を、本当の締切と突き合わせる。
 * 🚨 「検査の予定日を過ぎる」と「出荷に間に合わない」を分けて返す。
 *   予定日を過ぎるロットは実績で半分以上ある。**本当に間に合わないのはどれか**はこちらの missesHard。
 *
 * @param {object} o
 * @param {number|null} o.finishMs   終わる見込みの実時刻(epoch ms)
 * @param {object} o.deadlines       resolveDeadlines の戻り値
 * @returns {{
 *   missesHard:boolean, missesInspect:boolean, missesShipOnly:boolean,
 *   lateMs:number|null, lateHours:number|null, kind:string, sentence:string,
 * }}
 *   missesShipOnly … 検査の予定日には間に合うのに、出荷から逆算した締切には間に合わない
 */
export const judgeAgainstDeadlines = ({ finishMs = null, deadlines = null } = {}) => {
  const d = deadlines || {};
  const f = Number(finishMs);
  const has = Number.isFinite(f) && f > 0;
  const hard = Number.isFinite(d.hardDueMs) ? d.hardDueMs : null;
  const insp = Number.isFinite(d.inspectDueMs) ? d.inspectDueMs : null;
  if (!has || hard == null) {
    return {
      missesHard: false,
      missesInspect: false,
      missesShipOnly: false,
      lateMs: null,
      lateHours: null,
      kind: d.kind || DEADLINE_KIND.NONE,
      sentence: !has ? '終わる見込みの時刻がありません' : '締切の線が引けないので、間に合うかは答えられません',
    };
  }
  const missesHard = f > hard;
  const missesInspect = insp != null && f > insp;
  const lateMs = missesHard ? (f - hard) : 0;
  const lateHours = Math.round((lateMs / 3600000) * 10) / 10;
  const missesShipOnly = missesHard && !missesInspect;
  let sentence;
  if (!missesHard) sentence = d.kind === DEADLINE_KIND.SHIP ? `出荷から逆算した締切 ${d.hardYmd} に間に合います` : `検査の予定日 ${d.hardYmd} に間に合います`;
  else if (missesShipOnly) sentence = `検査の予定日 ${d.inspectYmd} には間に合いますが、出荷から逆算した締切 ${d.hardYmd} に ${lateHours}時間 足りません`;
  else sentence = `本当の締切 ${d.hardYmd} に ${lateHours}時間 足りません`;
  return { missesHard, missesInspect, missesShipOnly, lateMs, lateHours, kind: d.kind || DEADLINE_KIND.NONE, sentence };
};
