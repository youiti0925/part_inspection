// 🕐 SAP 工程の「見込み日時」(標準時間から計算・SAP の日付には頼らない)
// 目的: 各指図の各工程の開始・終了の見込みを、時刻つきで出す。
// 考え方(製品検査アプリの操業シミュレーションと同じ):
//   ・工場カレンダー=稼働日と定時と休憩(workClock.js の addWorkSeconds をそのまま使う・部品検査アプリにある同じ形)
//   ・設備/作業区の能力=同時に何本まで(capacity・既定 1 台=同時 1 本)
//   ・前の工程が済(終わる)と次の工程に渡る(handoff)=次の工程は前の工程の終了以降にしか始まらない
//   ・標準時間で順に積む(早く渡る指図から順・同じなら指図番号の若い順)
//   ・実績がある工程は実績を起点にする: 済=実績(日付のみ・SAP に時刻なし)/作業中=実績開始から標準時間ぶん/未=今(基準時刻)以降へ積む
//   ・SAP の計画日(R=最早実行開始日・S=最早実行終了日)も使う: 工程は計画開始日より前には始めない(usePlanStart)・見込み終了と計画終了(S の定時)の差=遅れ
//   ・どの作業区のどの日に能力(台数)を超えて待たされたか=キャパオーバーの起点。その遅れが後ろの工程・どの指図へ波及したかを追う
// 入力: buildOrders の結果(sapProgress.js)・nowMs・capacity({作業区:台数})・hoursMode
// 出力: 同じ形の指図の配列(未完了の工程の planStart/planEnd/…Time を見込みに差し替え・est=true・SAP の元の予定は sapPlanStart/End に残す)
// 触る外の物: なし(純関数・Date.now() を呼ばない)
// 確かめ方: node --test src/domain/__tests__/sapSchedule.test.mjs
import { addWorkSeconds, DEFAULT_WORK_SCHEDULE, timeStrToMinutes } from './workClock.js';
import { summarizeOrder } from './sapProgress.js';

/** 標準値の意味(清水さん 11-18): 標準値1=段取り・標準値2=機械・標準値3=作業者。
 *  機械(作業区)の占有時間 = 段取り + 機械 / 作業者の時間 = 段取り + 作業者。
 *  標準値2・3 が「1個あたり」か「1ロットあたり」かは未確認 → 既定は ロットあたり(数量を掛けない)。mode の末尾に '*' を付けると 標準値2・3 に数量を掛ける。
 *  ただし 検査工程(kind=inspect)と、機械の時間が 0 で作業者の時間がある工程は、既定の「機械の占有時間」でも 段取り+作業者 で数える(人の作業)。
 *  段取りは 1ロットにつき1回なので 数量は掛けない。 */
export const HOURS_MODES = [
    ['machine', '機械の占有時間 = 段取り(標準値1)+ 機械(標準値2)(既定)'],
    ['worker', '作業者の時間 = 段取り(標準値1)+ 作業者(標準値3)'],
    ['J', '段取り(標準値1)だけ'],
    ['L', '機械(標準値2)だけ'],
    ['N', '作業者(標準値3)だけ'],
    ['sum', '3つの合計(旧い見方)'],
];
/** 画面の選び(mode と 数量を掛けるか)→ hoursOf に渡す鍵 */
export const hoursKey = (mode, perQty) => (perQty ? mode + '*' : mode);
export const hoursOf = (s, mode = 'machine') => {
    const perQty = typeof mode === 'string' && mode.endsWith('*');
    const m = perQty ? mode.slice(0, -1) : mode;
    const q = perQty ? Math.max(1, s.qty || 1) : 1;
    const J = s.hJ || 0, L = (s.hL || 0) * q, N = (s.hN || 0) * q;
    if (m === 'J') return J;
    if (m === 'L') return L;
    if (m === 'N') return N;
    if (m === 'worker') return J + N;
    if (m === 'sum') return J + L + N;
    // machine(既定): 検査工程は人の作業なので 段取り+作業者。機械の時間が 0 で人の時間がある工程も 人の時間で占有する(機械を持たない作業)
    if (s.kind === 'inspect' || (L === 0 && N > 0)) return J + N;
    return J + L;
};

const p2 = (n) => String(n).padStart(2, '0');
export const localIso = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
export const localTime = (ms) => { const d = new Date(ms); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const dayStartMs = (iso, schedule) => {
    const [y, m, d] = iso.split('-').map(Number);
    const min = timeStrToMinutes(schedule.dayStart);
    return new Date(y, m - 1, d, Math.floor(min / 60), min % 60, 0, 0).getTime();
};

/** その時刻から need 秒ぶん働く: { start: 実際に手を付ける時刻(休憩・夜・休日を飛ばした後), end } 。出せない時は null */
export function runFrom(startMs, needSec, schedule, calendar) {
    if (!(needSec > 0)) return { start: startMs, end: startMs };
    const end = addWorkSeconds(startMs, needSec, schedule, false, calendar);
    if (end == null) return null;
    const first = addWorkSeconds(startMs, 1, schedule, false, calendar);   // 最初の1秒が終わる時刻 → 手を付けた時刻 = その1秒前
    return { start: first == null ? startMs : first - 1000, end };
}

const dayEndMs = (iso, schedule) => dayStartMs(iso, { ...schedule, dayStart: schedule.dayEnd });
const HOUR = 3600000;

/** 指図の配列 → { orders: 見込み日時を入れた指図の配列, origins: キャパオーバーの起点(超えた時間の多い順) } */
export function scheduleOrders(orders, { nowMs, capacity = {}, defaultCapacity = 1, hoursMode = 'machine', usePlanStart = true, schedule = DEFAULT_WORK_SCHEDULE, calendar = null } = {}) {
    const capOf = (wc) => Math.max(1, Math.floor(Number(capacity[wc] ?? defaultCapacity) || 1));
    const slots = new Map();   // 作業区 → 台ごとの「空く時刻」
    const slotsOf = (wc) => { if (!slots.has(wc)) slots.set(wc, new Array(capOf(wc)).fill(nowMs)); return slots.get(wc); };
    const minSlot = (arr) => { let k = 0; for (let i = 1; i < arr.length; i++) if (arr[i] < arr[k]) k = i; return k; };
    const originMap = new Map();
    const waits = [];   // 台が空くのを待った工程(仕掛かりの山の元)
    const est = new Map();     // 工程(オブジェクト) → { start, end, overrun }
    const MIN_LEFT_SEC = 1800; // 作業中で標準時間を過ぎている物は「あと30分」と見込む

    const chains = orders.map((o) => o.stages.filter((s) => s.kind !== 'misc'));
    // ① 作業中の工程: 実績開始から標準時間ぶん(過ぎていれば今からあと30分)。台を埋める
    chains.forEach((c) => c.forEach((s) => {
        if (s.status !== 'working') return;
        const startMs = s.actualStart ? dayStartMs(s.actualStart, schedule) : nowMs;
        let r = runFrom(startMs, hoursOf(s, hoursMode) * 3600, schedule, calendar);
        let overrun = false;
        if (!r || r.end <= nowMs) { r = runFrom(nowMs, MIN_LEFT_SEC, schedule, calendar); overrun = true; if (r) r = { start: startMs, end: r.end }; }
        if (!r) return;
        est.set(s, { ...r, overrun });
        const arr = slotsOf(s.wc), k = minSlot(arr);
        arr[k] = Math.max(arr[k], r.end);
    }));
    // ② 未の工程: 前の工程が終わった物から順に積む(早い順・同じなら指図番号の若い順)
    const pend = [];
    chains.forEach((c, oi) => {
        let i = 0, prevEnd = nowMs;
        for (; i < c.length; i++) {
            const s = c[i];
            if (s.status === 'done') { prevEnd = nowMs; continue; }
            if (s.status === 'working') { const e = est.get(s); prevEnd = e ? e.end : nowMs; continue; }
            break;
        }
        if (i < c.length) pend.push({ oi, i, ready: prevEnd, origin: null });
    });
    while (pend.length) {
        let bi = 0;
        for (let k = 1; k < pend.length; k++) {
            const a = pend[k], b = pend[bi];
            if (a.ready < b.ready || (a.ready === b.ready && orders[a.oi].order < orders[b.oi].order)) bi = k;
        }
        const p = pend[bi], c = chains[p.oi], s = c[p.i];
        const arr = slotsOf(s.wc), k = minSlot(arr);
        const need = hoursOf(s, hoursMode) * 3600;
        const bound = usePlanStart && s.planStart ? dayStartMs(s.planStart, schedule) : 0;   // SAP の計画開始日より前には始めない
        const desired = Math.max(p.ready, bound);
        const r = runFrom(Math.max(desired, arr[k]), need, schedule, calendar);
        let end = p.ready, origin = null;
        if (r) {
            const capWait = need > 0 && arr[k] > desired;      // 台が空いていなくて待たされた=能力を超えた
            if (capWait) {
                const d0 = runFrom(desired, 1, schedule, calendar);
                origin = { wc: s.wc, name: s.name, day: localIso(d0 ? d0.start : desired) };
                const key = origin.wc + '|' + origin.day;
                if (!originMap.has(key)) originMap.set(key, { ...origin, overHours: 0, waitStages: 0, orderSet: new Set(), maxWaitH: 0 });
                const og = originMap.get(key);
                waits.push({ wc: s.wc, name: s.name, order: orders[p.oi].order, desired, start: r.start, hours: need / 3600 });
                og.overHours += need / 3600; og.waitStages++; og.maxWaitH = Math.max(og.maxWaitH, (r.start - desired) / HOUR);
            } else if (p.origin && p.ready > bound) origin = p.origin;   // 前の工程の遅れが渡ってきた
            est.set(s, { ...r, overrun: false, origin });
            end = r.end;
            if (need > 0) arr[k] = r.end;
        }
        let j = p.i + 1;
        while (j < c.length && c[j].status !== 'todo') j++;
        if (j < c.length && r) { p.i = j; p.ready = end; p.origin = origin; } else pend.splice(bi, 1);
    }
    const out = orders.map((o) => summarizeOrder(o.stages.map((s) => {
        const e = est.get(s);
        if (!e) return s;
        const o2 = { ...s, est: true, sapPlanStart: s.planStart, sapPlanEnd: s.planEnd, planEnd: localIso(e.end), planEndTime: localTime(e.end), estOverrun: e.overrun, origin: e.origin };
        if (s.status !== 'working') { o2.planStart = localIso(e.start); o2.planStartTime = localTime(e.start); }
        // 遅れ = 見込み終了 − 計画終了(S の定時)。正なら計画を越えた
        o2.delayMs = s.planEnd ? e.end - dayEndMs(s.planEnd, schedule) : null;
        return o2;
    })));
    // 波及: 起点ごとに「遅れた工程を持つ指図」を数える
    for (const o of out) for (const s of o.stages) if (s.origin && s.delayMs > 0) originMap.get(s.origin.wc + '|' + s.origin.day)?.orderSet.add(o.order);
    const origins = [...originMap.values()].map((g) => ({ wc: g.wc, name: g.name, day: g.day, overHours: Math.round(g.overHours * 10) / 10, waitStages: g.waitStages, orders: g.orderSet.size, maxWaitH: Math.round(g.maxWaitH * 10) / 10 }))
        .sort((x, y) => y.overHours - x.overHours);
    return { orders: out, origins, waits };
}

/** 作業区×日の仕掛かりの山(待ち行列): その日の定時終わりに、その作業区の前で待っている指図の数と標準時間の合計。
 *  待ち = 前の工程が終わった(または計画開始日が来た)のに、作業区の台が空いていない。
 *  rows[].peakH/peakDay=最大の山・startDay=溜まり始めた日・clearDay=解消する見込み日(horizon 内で 0 に戻らなければ null)・growing=後ろの日ほど多い */
export function queueTable(waits, nowMs, { days = 21, horizon = 60, schedule = DEFAULT_WORK_SCHEDULE } = {}) {
    const dayList = Array.from({ length: horizon }, (_, i) => { const d = new Date(nowMs); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + i); return d; });
    const endMin = timeStrToMinutes(schedule.dayEnd);
    const ends = dayList.map((d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(endMin / 60), endMin % 60).getTime());
    const rows = new Map();
    for (const w of waits) {
        if (!rows.has(w.wc)) rows.set(w.wc, { wc: w.wc, name: w.name, per: ends.map(() => ({ n: 0, h: 0 })) });
        const r = rows.get(w.wc);
        ends.forEach((e, i) => { if (w.desired <= e && w.start > e) { r.per[i].n++; r.per[i].h += w.hours; } });
    }
    const out = [...rows.values()].map((r) => {
        const per = r.per.map((x) => ({ n: x.n, h: Math.round(x.h * 10) / 10 }));
        let pk = 0; per.forEach((x, i) => { if (x.h > per[pk].h) pk = i; });
        const startI = per.findIndex((x) => x.n > 0);
        let clearI = -1; for (let i = pk + 1; i < per.length; i++) if (per[i].n === 0) { clearI = i; break; }
        const mid = Math.floor(days / 2);
        const growing = per[pk].n > 0 && per.slice(mid, days).reduce((a, x) => a + x.h, 0) >= per.slice(0, mid).reduce((a, x) => a + x.h, 0);
        return { wc: r.wc, name: r.name, per, perShown: per.slice(0, days), peakN: per[pk].n, peakH: per[pk].h, peakDay: localIso(ends[pk]), startDay: startI >= 0 ? localIso(ends[startI]) : null, clearDay: clearI >= 0 ? localIso(ends[clearI]) : null, growing };
    }).sort((a, b) => b.peakH - a.peakH);
    return { days: ends.slice(0, days).map(localIso), rows: out };
}

