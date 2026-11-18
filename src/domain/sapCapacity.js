// 🧮 こなせるか表(工程 × 週): 必要な標準時間 ÷ 使える時間
// 目的: 「結局こなせるか・こなせないか」がすぐ分かる表。行=工程(機械グループ)・列=週・マス=その週に SAP の計画が求める標準時間 ÷ 使える時間(台数×稼働時間×稼働日)。
// 考え方:
//   ・必要な時間 = まだ済んでいない工程の標準時間を、SAP の計画の窓(最早実行開始日〜終了日)の稼働日へ均等に置く。
//     計画の窓がもう過ぎている分(遅れ)は「今週」に積む(今週に片付けないといけない分)。
//     ※積み上げ(sapSchedule)の見込みは 台に空きが無いと後ろへ送るので、負荷が必ず 100% 以内に収まり 足りない事が見えない。
//       だから「こなせるか」は 計画が求める量 で測り、積み上げは「計画どおり終わる指図の割合」と 工程の一覧 で使う。
//   ・必要な時間は 機械(段取り+機械)と 作業者(段取り+作業者)を別々に数える。標準値の意味: 1=段取り・2=機械・3=作業者(清水さん 11-18)
//   ・使える時間 = 台数(作業者は人数) × (定時 7.75h + 残業 h) × 稼働日(今週は今日から) + 土曜出勤の日数 × 7.75h × 台数
// 入力: scheduleOrders の orders・基準時刻・週の数・台数(capOf)・残業 h・土曜出勤
// 出力: capacityTable → { weeks, rows, totals }
// 触る外の物: なし(Firebase・ネットワーク・保存に触れない・Date.now() を呼ばない)
// 確かめ方: node --test src/domain/__tests__/sapCapacity.test.mjs
import { hoursOf, hoursKey } from './sapSchedule.js';
import { chainOf, msOf, sapStartOf, sapEndOf, LANE_ORDER, HOURS_PER_DAY } from './sapBoard.js';
import { factoryClock, DEFAULT_WORK_SCHEDULE } from './workClock.js';

export const GREEN_BELOW = 0.9;   // この割合未満=緑・以上 100% まで=黄・超えたら赤
const DAY = 86400000;
const r1 = (x) => Math.round(x * 10) / 10;
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const addDays = (ms, n) => { const d = new Date(ms); d.setDate(d.getDate() + n); d.setHours(0, 0, 0, 0); return d.getTime(); };
const mondayOf = (ms) => { const d = new Date(startOfDay(ms)); const w = (d.getDay() + 6) % 7; return addDays(d.getTime(), -w); };
const md = (ms) => `${new Date(ms).getMonth() + 1}/${new Date(ms).getDate()}`;

/** 週の列(月曜始まり)。0 番目=今週 */
export function weekList(nowMs, n = 5) {
    const m0 = mondayOf(nowMs);
    return Array.from({ length: n }, (_, i) => { const s = addDays(m0, 7 * i); const e = addDays(s, 7); return { startMs: s, endMs: e, label: `${md(s)}〜${md(addDays(e, -1))}`, name: i === 0 ? '今週' : i === 1 ? '来週' : `${i}週後` }; });
}

/** 標準時間が必要な工程(まだ済んでいない・付帯作業は除く)の SAP の計画の窓。無ければ null */
function windowOf(s) {
    const a = sapStartOf(s), b = sapEndOf(s);
    const aMs = a ? msOf(a, null, '00:00') : null, bMs = b ? msOf(b, null, '00:00') : null;
    if (aMs == null && bMs == null) return null;
    const s0 = aMs ?? bMs, e0 = bMs ?? aMs;
    return { startMs: Math.min(s0, e0), endMs: Math.max(s0, e0) };
}

/** 工程の週ごとの必要量・使える量・足りない時間。
 *  resources: ['machine'] 機械の占有時間(段取り+機械)÷(台数×稼働時間) / ['worker'] 作業者の時間(段取り+作業者)÷(人数×稼働時間)
 *  perQty: 標準値2・3 に数量を掛けるか(既定 false = ロットあたり) / peopleOf(工程名, 台数) = その工程の人数(既定は台数と同じ) */
export function capacityTable(orders, { nowMs, weeks = 5, perQty = false, capOf = () => 1, peopleOf = (name, dai) => dai, resources = ['machine'], otHours = 0, saturday = false, isWorkday = factoryClock(DEFAULT_WORK_SCHEDULE, null) } = {}) {
    const wl = weekList(nowMs, weeks);
    const today = startOfDay(nowMs);
    const weekOfDay = (dayMs) => { if (dayMs < today) return 0; for (let i = 0; i < wl.length; i++) if (dayMs >= wl[i].startMs && dayMs < wl[i].endMs) return i; return -1; };
    const modeOf = { machine: hoursKey('machine', perQty), worker: hoursKey('worker', perQty) };
    const lanes = new Map();
    const mk = () => ({ demand: new Array(weeks).fill(0), carry: 0, noDate: 0 });
    const L = (n) => { if (!lanes.has(n)) lanes.set(n, { name: n, wcs: new Set(), machine: mk(), worker: mk() }); return lanes.get(n); };
    for (const o of orders) for (const s of chainOf(o)) {
        const l = L(s.name); l.wcs.add(s.wc);
        if (s.status === 'done') continue;
        const w = windowOf(s);
        for (const res of ['machine', 'worker']) {
            const h = hoursOf(s, modeOf[res]);
            if (!(h > 0)) continue;
            if (!w) { l[res].noDate += h; continue; }
            const days = [];
            for (let d = w.startMs; d <= w.endMs; d = addDays(d, 1)) if (isWorkday(d)) days.push(d);
            if (!days.length) days.push(w.startMs);
            const per = h / days.length;
            for (const d of days) {
                const wi = weekOfDay(d);
                if (wi < 0) continue;
                l[res].demand[wi] += per;
                if (d < today) l[res].carry += per;
            }
        }
    }
    // 使える日数(今週は今日から)
    const dayCounts = wl.map((w) => {
        let work = 0, sat = 0;
        for (let d = Math.max(w.startMs, today); d < w.endMs; d = addDays(d, 1)) { if (isWorkday(d)) work++; else if (new Date(d).getDay() === 6) sat++; }
        return { work, sat };
    });
    const rank = (n) => { const i = LANE_ORDER.indexOf(n); return i < 0 ? 999 : i; };
    const unitOf = { machine: '台', worker: '人' };
    const rows = [];
    for (const l of [...lanes.values()].sort((a, b) => rank(a.name) - rank(b.name))) {
        const wcs = [...l.wcs];
        const dai = wcs.reduce((a, wc) => a + Math.max(1, capOf(wc) || 1), 0) || 1;
        for (const res of resources) {
            const d = l[res];
            if (!d.demand.some((x) => x > 0)) continue;
            const units = res === 'worker' ? Math.max(1, Math.floor(Number(peopleOf(l.name, dai)) || dai)) : dai;
            const cells = d.demand.map((dem, i) => {
                const c = dayCounts[i];
                const cap = units * (c.work * (HOURS_PER_DAY + otHours) + (saturday ? c.sat * HOURS_PER_DAY : 0));
                const slack = cap - dem;
                return { demand: r1(dem), cap: r1(cap), pct: cap > 0 ? dem / cap : (dem > 0 ? Infinity : 0), slack: r1(slack), level: cap <= 0 ? (dem > 0 ? 'red' : 'green') : dem / cap > 1 ? 'red' : dem / cap >= GREEN_BELOW ? 'yellow' : 'green' };
            });
            // どうすれば足りるか: 一番足りない週(足りる行は 一番余裕の少ない週)
            let wi = 0; cells.forEach((c, i) => { if (c.slack < cells[wi].slack) wi = i; });
            const worst = cells[wi], u = unitOf[res];
            let hint;
            if (worst.slack >= 0) hint = { ok: true, text: `+${Math.floor(worst.slack)}h 余裕`, week: wi };
            else {
                const short = -worst.slack, c = dayCounts[wi];
                const otPerDay = c.work > 0 ? Math.ceil((short / (units * c.work)) * 10) / 10 : null;
                const satDays = Math.ceil((short / (units * HOURS_PER_DAY)) * 2) / 2;
                hint = { ok: false, short: r1(short), week: wi, otPerDay, satDays, text: `${wl[wi].name} ${Math.ceil(short)}h 不足 → ${otPerDay != null ? `残業 1日${otPerDay}h×${units}${u}` : '残業は使えない週'} / 土曜 ${satDays}日(全${units}${u})` };
            }
            rows.push({ name: l.name, res, wcs, dai, units, cells, carry: r1(d.carry), noDate: r1(d.noDate), hint });
        }
    }
    const tot = (list) => { const now = list.filter((r) => r.cells[0].slack < 0); return { cannotNow: now.length, shortNow: r1(now.reduce((a, r) => a - r.cells[0].slack, 0)), rows: list.length }; };
    return { weeks: wl.map((w, i) => ({ ...w, ...dayCounts[i] })), rows, totals: tot(rows), byRes: { machine: tot(rows.filter((r) => r.res === 'machine')), worker: tot(rows.filter((r) => r.res === 'worker')) } };
}

/** 一覧の行(stageRows の行)が その週に関係するか: SAP 計画の窓が週と重なる。今週は 窓が過ぎている行(遅れ)も含む */
export function rowInWeek(row, week, weekIdx, nowMs) {
    const a = row.planStartMs ?? row.dueMs, b = row.dueMs ?? row.planStartMs;
    if (a == null && b == null) return false;
    if (weekIdx === 0 && b < startOfDay(nowMs)) return true;
    return a < week.endMs && b >= week.startMs;
}
