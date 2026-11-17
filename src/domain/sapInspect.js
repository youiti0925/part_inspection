// 🔍 部品検査に届く見込み(検査工程 2509 の開始見込みと所要)
// 目的: 指図ごとに「検査工程」を見つけ、
//   遠い時=SAP の予定開始日どおりに物が届き・MT(標準時間)どおりに時間がかかる前提
//   近づいた時=前工程の実績から積み上げた(操業シミュレーション)開始見込みで更新
//   MT が無い時=所要は「不明」(でっち上げない)。アプリの検査実績(中央値)があればそれを使う
//   を出す。
// 入力: buildOrders の結果(base・SAP の元の予定 R/S)・scheduleOrders の orders(sched・見込み入り・同じ並び)
//       actualsByItem = { 品目: { n: 実績件数, medianMin: 中央値(分) } }(アプリで時間取りした検査の実績・無ければ {})
// 出力: inspectForecast → { rows, counts } / medianActuals(records) → actualsByItem
// 触る外の物: なし(Firebase・ネットワーク・保存に触れない・Date.now() を呼ばない)
// 確かめ方: node --test src/domain/__tests__/sapInspect.test.mjs
import { hoursOf, runFrom, localIso, localTime } from './sapSchedule.js';
import { DEFAULT_WORK_SCHEDULE, timeStrToMinutes } from './workClock.js';
import { isoToDayNo } from './sapProgress.js';

/** 「近い」のしきい値(1か所): 検査の手前の未完了の工程が この数以下、または検査の直前の工程が作業中か済 なら近い */
export const NEAR_REMAINING_DEFAULT = 1;

const chainOf = (o) => o.stages.filter((s) => s.kind !== 'misc');
const dayStartMs = (iso, schedule = DEFAULT_WORK_SCHEDULE) => {
    const [y, m, d] = iso.split('-').map(Number); const min = timeStrToMinutes(schedule.dayStart);
    return new Date(y, m - 1, d, Math.floor(min / 60), min % 60).getTime();
};
const r1 = (x) => Math.round(x * 10) / 10;

/** アプリの実績の記録 [{ item, minutes }] → actualsByItem(品目ごとの件数と中央値の分)。0 以下・数でない物は数えない */
export function medianActuals(records) {
    const m = new Map();
    for (const r of records || []) {
        const v = Number(r && r.minutes);
        if (!r || !r.item || !isFinite(v) || v <= 0) continue;
        if (!m.has(r.item)) m.set(r.item, []);
        m.get(r.item).push(v);
    }
    const out = {};
    for (const [k, a] of m) { a.sort((x, y) => x - y); const h = a.length >> 1; out[k] = { n: a.length, medianMin: a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2 }; }
    return out;
}

export const BASIS_LABEL = { sap: 'SAP 予定どおり', sim: 'シミュレーションで更新(前工程の実績から)', actual: '検査を始めた実績', unknown: '不明(SAP に予定開始日なし)' };
export const HOURS_BASIS_LABEL = { MT: 'MT(標準値)', actual: 'アプリの実績の中央値', unknown: '不明(MT なし・実績なし)' };

/** base/sched は同じ並びの指図配列。検査工程が未完了の指図だけ返す(届く順) */
export function inspectForecast(base, sched, { nearRemaining = NEAR_REMAINING_DEFAULT, actualsByItem = {}, hoursMode = 'sum', schedule = DEFAULT_WORK_SCHEDULE, todayIso = null } = {}) {
    const rows = [];
    base.forEach((bo, oi) => {
        const so = (sched && sched[oi]) || bo;
        const bc = chainOf(bo);
        const idx = bc.findIndex((s) => s.kind === 'inspect' && s.status !== 'done');
        if (idx < 0) return;
        const insp = bc[idx], sinsp = chainOf(so)[idx] || insp;
        const before = bc.slice(0, idx);
        const remaining = before.filter((s) => s.status !== 'done').length;
        const prev = before[before.length - 1] || null;
        const near = insp.status === 'working' || remaining <= nearRemaining || (prev && prev.status !== 'todo');
        const sapStart = insp.planStart || null, sapEnd = insp.planEnd || null;
        // 所要: MT → アプリの実績の中央値 → 不明
        const mt = hoursOf(insp, hoursMode);
        const act = actualsByItem && actualsByItem[bo.item];
        let hours = null, hoursBasis = 'unknown', actualN = 0;
        if (mt > 0) { hours = mt; hoursBasis = 'MT'; }
        else if (act && act.n > 0 && act.medianMin > 0) { hours = r1(act.medianMin / 60); hoursBasis = 'actual'; actualN = act.n; }
        // 開始の見込み
        let startIso = null, startTime = null, startBasis = 'unknown', phase = near ? 'near' : 'far';
        if (insp.status === 'working' && insp.actualStart) { startIso = insp.actualStart; startTime = insp.actualStartTime || null; startBasis = 'actual'; phase = 'started'; }
        else if (near && sinsp.est && sinsp.planStart) { startIso = sinsp.planStart; startTime = sinsp.planStartTime || null; startBasis = 'sim'; }
        else if (sapStart) { startIso = sapStart; startBasis = 'sap'; if (near) phase = 'near'; }
        // 近い時にシミュレーションが出せなかった(見込みなし)場合は SAP の予定にとどまる(根拠にそう出る)
        let endIso = null, endTime = null;
        if (startIso && hours != null) {
            const base0 = startTime ? (() => { const [h, m] = startTime.split(':').map(Number); const [y, mo, d] = startIso.split('-').map(Number); return new Date(y, mo - 1, d, h, m).getTime(); })() : dayStartMs(startIso, schedule);
            const r = runFrom(base0, hours * 3600, schedule, null);
            if (r) { endIso = localIso(r.end); endTime = localTime(r.end); }
        }
        const diffDays = startIso && sapStart && startBasis !== 'sap' ? isoToDayNo(startIso) - isoToDayNo(sapStart) : null;   // + = SAP 予定より遅れる
        const overdue = !!(todayIso && startBasis === 'sap' && startIso && startIso < todayIso);   // SAP の予定開始日がもう過ぎているのに、手前の工程が未完了
        rows.push({
            order: bo.order, item: bo.item, itemText: bo.itemText, qty: (bc[0] && bc[0].qty) || 0,
            phase, remaining, prevLabel: prev ? `${prev.name}(${prev.wc})` : '(最初の工程)', prevStatus: prev ? prev.status : null,
            inspName: insp.name, inspWc: insp.wc,
            startIso, startTime, startBasis, endIso, endTime,
            hours, hoursBasis, actualN,
            sapStart, sapEnd, diffDays, overdue,
        });
    });
    rows.sort((a, b) => (a.startIso && b.startIso ? (a.startIso < b.startIso ? -1 : a.startIso > b.startIso ? 1 : (a.order < b.order ? -1 : 1)) : a.startIso ? -1 : b.startIso ? 1 : (a.order < b.order ? -1 : 1)));
    const counts = {
        total: rows.length,
        near: rows.filter((r) => r.phase !== 'far').length, far: rows.filter((r) => r.phase === 'far').length,
        noMt: rows.filter((r) => r.hoursBasis !== 'MT').length, withActual: rows.filter((r) => r.hoursBasis === 'actual').length,
        unknownHours: rows.filter((r) => r.hoursBasis === 'unknown').length, overdue: rows.filter((r) => r.overdue).length, unknownStart: rows.filter((r) => !r.startIso).length,
    };
    return { rows, counts };
}
