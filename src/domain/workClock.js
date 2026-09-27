// 勤務時間を考えた「時計」。製品検査 / 最終検査 で同一ファイル。
//
// なぜ要るか: 「到着16:00 + 見積3時間 = 19:00」は現場では絶対に成り立たない。
//   15時休憩・定時17:00・翌朝跨ぎ・土日がある。素で足した時刻を相手工程に送ると必ず外れる。
//   ここは「その仕事が終わる壁時計の時刻」を返す。
//
// ⚠ 製品検査アプリでは App.jsx の中に同じ関数があったものをここへ出した(実装は同じ)。
//   最終検査アプリには元々無く、到着＋見積を素で足していた(=休憩も定時も無視した嘘の時刻)。
//
// 📅 2026-09-01 工場の暦(祝日表)を繋いだ。
//   それまでは **土日しか飛ばしていなかった** ので、祝日を跨ぐ仕事は「何時に終わるか」が必ず外れた
//   (祝日を勤務時間として数えていた)。いまは domain/factoryCalendar.js の登録を見る。
//   🚨 登録が空なら今までと1ミリも同じ挙動(祝日表を入れるまで数字は1秒も動かない)。

import { makeIsWorkday, DEFAULT_WORKDAYS } from './factoryCalendar.js';

export const DEFAULT_WORK_SCHEDULE = {
    dayStart: '08:30',
    dayEnd: '17:00',           // 定時終わり
    overtimeStart: '17:15',    // 残業開始 (定時終わり後の休憩明け)
    overtimeEnd: '19:15',      // 残業終わり (=2時間残業を想定)
    breaks: [
        { start: '10:00', end: '10:10', name: '10時休憩' },
        { start: '12:00', end: '12:45', name: '昼休憩' },
        { start: '15:00', end: '15:15', name: '15時休憩' },
        { start: '17:00', end: '17:15', name: '残業前休憩' },
    ],
    daysPerWeek: 5,
    daysPerMonth: 20,
    includeOvertimeInCapacity: false,
};

/** 週に6日以上働く勤務表(daysPerWeek>5)なら、既定では土日も働く。 */
export const WORKDAYS_ALL = Object.freeze([0, 1, 2, 3, 4, 5, 6]);

/**
 * 勤務表(稼働日/週)から「既定で働く曜日」を出す。
 * 🚨 週の形の持ち主を1つにする。ここが唯一の変換で、
 *   `daysPerWeek <= 5 → 月〜金` は今までの excludeWeekend と同じ意味(挙動を変えない)。
 */
export const workdaysOfSchedule = (schedule) => {
  const sch = { ...DEFAULT_WORK_SCHEDULE, ...(schedule || {}) };
  return ((sch.daysPerWeek || 5) <= 5 ? DEFAULT_WORKDAYS : WORKDAYS_ALL).slice();
};

/**
 * 勤務表 と 工場の暦(祝日表) を1つに畳んだ「その日は工場が動くか」。
 * 🚨 稼働日を判定する所は **必ずこれを通す**。土日だけを見る式をその場で書かない
 *   (見張り: src/domain/__tests__/factoryCalendarWiring.test.mjs)。
 */
export const factoryClock = (schedule, calendar) => makeIsWorkday(calendar, workdaysOfSchedule(schedule));

export const timeStrToMinutes = (str) => {
    if (!str || typeof str !== 'string') return 0;
    const [h, m] = str.split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return 0;
    return h * 60 + m;
};

// 見積が異常に大きい時の暴走止め(この日数で見つからなければ null = 「算出不可」)
export const WORK_END_MAX_DAYS = 60;

// 「この時刻から実作業を needSec 秒やったら、実際に何時に終わるか」。
//   休憩中/勤務時間外の開始は「次に働ける瞬間」まで送る。
//   休みの日(土日 + 工場の暦に登録した祝日・全社休業)は飛ばす。休日出勤の登録があればその日は使う。
//   ⚠ needSec=0 なら開始時刻そのもの(丸めない)。
//   ⚠ 出せない時は null。ここで適当な時刻を返すと、その嘘がそのまま相手工程へ送られる。
//   ⚠ calendar を渡さなければ今までと1ミリも同じ(土日だけ飛ばす)。
export const addWorkSeconds = (startMs, needSec, schedule, includeOvertime = true, calendar = null) => {
    if (!startMs || !Number.isFinite(needSec)) return null;
    let remainMs = Math.max(0, needSec) * 1000;
    if (remainMs === 0) return startMs;
    const sch = { ...DEFAULT_WORK_SCHEDULE, ...(schedule || {}) };
    const dayStartMin = timeStrToMinutes(sch.dayStart);
    const dayEndMin = (includeOvertime && sch.overtimeEnd) ? timeStrToMinutes(sch.overtimeEnd) : timeStrToMinutes(sch.dayEnd);
    if (!(dayEndMin > dayStartMin)) return null;
    const breaks = (sch.breaks || []).map(b => ({ start: timeStrToMinutes(b.start), end: timeStrToMinutes(b.end) }))
        .filter(b => b.end > b.start).sort((a, b) => a.start - b.start);
    const isFactoryWorkday = factoryClock(sch, calendar);   // 🚨 ループの外で1回だけ暦を読む
    const at = (day, min) => { const d = new Date(day); d.setHours(0, min, 0, 0); return d.getTime(); };

    const cursor = new Date(startMs); cursor.setHours(0, 0, 0, 0);
    for (let guard = 0; guard < WORK_END_MAX_DAYS; guard++) {
        if (isFactoryWorkday(cursor)) {
            // その日の「働ける区間」= 勤務時間から休憩を抜いたもの。区間ごとに残りを削る。
            const segs = [];
            let segStart = dayStartMin;
            for (const b of breaks) {
                if (b.start > segStart) segs.push([segStart, Math.min(b.start, dayEndMin)]);
                segStart = Math.max(segStart, b.end);
            }
            if (segStart < dayEndMin) segs.push([segStart, dayEndMin]);
            for (const [s, e] of segs) {
                if (e <= s) continue;
                const segStartMs = Math.max(at(cursor, s), startMs); // 初日は開始時刻より前の区間は使えない
                const segEndMs = at(cursor, e);
                if (segEndMs <= segStartMs) continue;
                const cap = segEndMs - segStartMs;
                if (remainMs <= cap) return segStartMs + remainMs;
                remainMs -= cap;
            }
        }
        cursor.setDate(cursor.getDate() + 1);
    }
    return null; // 見積が大きすぎて WORK_END_MAX_DAYS 以内に終わらない → 呼び出し側で「算出不可」を出す
};
