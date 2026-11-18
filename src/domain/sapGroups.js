// 🧮 機械グループごとの「こなせるか」(作業区まで割る)・台数と人数と掛け持ち・手で回す(マニュアル変更)
// 目的: 「結局こなせるか」を 機械グループ(10行)で見せ、行を開くと中の作業区ごとに見せる。機械の占有と人の占有を別に数える。
// 考え方:
//   ・必要な時間(作業区×週)= まだ済んでいない工程の標準時間を SAP の計画の窓の稼働日へ均等に置く(窓が過ぎた遅れ分は今週)。
//     機械の占有 = 段取り+機械(標準値1+2)・人の占有 = 段取り+作業者(標準値1+3)。検査と、機械が 0 の工程は 段取り+作業者(hoursOf)。
//   ・使える時間 = 台数・人数 ×(定時 7.75h + 残業)× 稼働日(今週は今日から)+ 土曜。
//   ・台数・人数・掛け持ち(作業区ごと): 掛け持ち可 = 機械は台数ぶん・人は人数ぶん 別々に使える(1人が複数台を受け持てる。人が要るのは段取り+作業者の間だけ)。
//                                       掛け持ち不可 = 同時に動ける台数 = min(台数, 人数)(機械も人も その数が上限)。
//     マス = 機械と人の悪い方(悪い方の色)。
//   ・手で回す: 指図×工程(order|act)を 同じ機械グループの別の作業区へ移した写しを作る(applyMoves)。決めるのは人。元のデータは書き換えない。
// 入力: scheduleOrders の orders / buildOrders の orders(applyMoves)・基準時刻・作業区の設定(cfgOf)
// 出力: capacityGroups / applyMoves / moveKey / groupWcs
// 触る外の物: なし(Firebase・ネットワーク・保存に触れない・Date.now() を呼ばない)
// 確かめ方: node --test src/domain/__tests__/sapGroups.test.mjs
import { hoursOf, hoursKey } from './sapSchedule.js';
import { chainOf, msOf, sapStartOf, sapEndOf, LANE_ORDER, HOURS_PER_DAY } from './sapBoard.js';
import { weekList, GREEN_BELOW } from './sapCapacity.js';
import { factoryClock, DEFAULT_WORK_SCHEDULE } from './workClock.js';

const r1 = (x) => Math.round(x * 10) / 10;
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const addDays = (ms, n) => { const d = new Date(ms); d.setDate(d.getDate() + n); d.setHours(0, 0, 0, 0); return d.getTime(); };
const int1 = (v, dflt = 1) => Math.max(1, Math.floor(Number(v) || dflt));
const rank = (n) => { const i = LANE_ORDER.indexOf(n); return i < 0 ? 999 : i; };
const LEVEL_RANK = { red: 2, yellow: 1, green: 0 };

/** 作業区の設定 → 同時に使える数(機械・人)。掛け持ち可=それぞれ別・不可=min(台数,人数) */
export function effUnits(cfg) {
    const units = int1(cfg && cfg.units), people = int1(cfg && cfg.people, units);
    const multi = !!(cfg && cfg.multi);
    return { units, people, multi, machine: multi ? units : Math.min(units, people), worker: multi ? people : Math.min(units, people) };
}

/** 手で回した印の鍵(指図×工程) */
export const moveKey = (order, act) => `${order}|${act}`;

/** 同じ機械グループ(工程名)の作業区の一覧(候補を出すだけ・決めるのは人) */
export function groupWcs(orders, name) {
    const s = new Set();
    for (const o of orders) for (const st of chainOf(o)) if (st.name === name) s.add(st.wc);
    return [...s].sort();
}

/** 手で回した写し: moves = { 'order|act': 移し先の作業区 }。同じ機械グループの作業区にだけ移す(違う物・済の工程は無視)。移した工程には fromWc と moved を付ける */
export function applyMoves(orders, moves) {
    const mv = moves && typeof moves === 'object' ? moves : {};
    if (!Object.keys(mv).length) return { orders, applied: [], ignored: [] };
    const wcsOf = new Map();
    const wcsFor = (name) => { if (!wcsOf.has(name)) wcsOf.set(name, new Set(groupWcs(orders, name))); return wcsOf.get(name); };
    const applied = [], ignored = [];
    const seen = new Set();
    const out = orders.map((o) => {
        let changed = false;
        const stages = o.stages.map((s) => {
            const k = moveKey(o.order, s.act);
            if (!(k in mv)) return s;
            seen.add(k);
            const to = String(mv[k]);
            if (s.status === 'done' || s.kind === 'misc') { ignored.push({ key: k, why: '済の工程・付帯作業は動かせない' }); return s; }
            if (to === s.wc) return s;
            if (!wcsFor(s.name).has(to)) { ignored.push({ key: k, why: '同じ機械グループの作業区ではない' }); return s; }
            changed = true; applied.push({ key: k, order: o.order, act: s.act, name: s.name, from: s.wc, to });
            return { ...s, fromWc: s.wc, wc: to, moved: true };
        });
        return changed ? { ...o, stages } : o;
    });
    for (const k of Object.keys(mv)) if (!seen.has(k)) ignored.push({ key: k, why: 'その指図×工程が見つからない' });
    return { orders: out, applied, ignored };
}

const windowOf = (s) => {
    const a = sapStartOf(s), b = sapEndOf(s);
    const aMs = a ? msOf(a, null, '00:00') : null, bMs = b ? msOf(b, null, '00:00') : null;
    if (aMs == null && bMs == null) return null;
    const s0 = aMs ?? bMs, e0 = bMs ?? aMs;
    return { startMs: Math.min(s0, e0), endMs: Math.max(s0, e0) };
};

/** マスの計算(機械と人の悪い方) */
function cellOf(dm, dw, cm, cw) {
    const ratio = (d, c) => (c > 0 ? d / c : (d > 0 ? Infinity : 0));
    const pm = ratio(dm, cm), pw = ratio(dw, cw);
    const pct = Math.max(pm, pw);
    const level = pct > 1 ? 'red' : pct >= GREEN_BELOW ? 'yellow' : 'green';
    return { demandM: r1(dm), demandW: r1(dw), capM: r1(cm), capW: r1(cw), pctM: pm, pctW: pw, pct, worse: pw > pm ? 'worker' : 'machine', slackM: r1(cm - dm), slackW: r1(cw - dw), slack: r1(Math.min(cm - dm, cw - dw)), level };
}

/**
 * 機械グループ × 作業区 × 週。
 * @param {object} o { nowMs, weeks, perQty, cfgOf(wc)=>{units,people,multi}, otHours, saturday, isWorkday }
 * @returns {{ weeks, groups: Array<{ name, kind, wcs: Array<{ wc, cfg, eff, cells, carry }>, cells, hint, redWcs, tight }>, summary }}
 */
export function capacityGroups(orders, { nowMs, weeks = 5, perQty = false, cfgOf = () => ({ units: 1 }), otHours = 0, saturday = false, isWorkday = factoryClock(DEFAULT_WORK_SCHEDULE, null) } = {}) {
    const wl = weekList(nowMs, weeks);
    const today = startOfDay(nowMs);
    const weekOfDay = (dayMs) => { if (dayMs < today) return 0; for (let i = 0; i < wl.length; i++) if (dayMs >= wl[i].startMs && dayMs < wl[i].endMs) return i; return -1; };
    const modeM = hoursKey('machine', perQty), modeW = hoursKey('worker', perQty);
    const groups = new Map();   // name → { kind, wcs: Map(wc → {m[], w[], carry}) }
    const mk = () => ({ m: new Array(weeks).fill(0), w: new Array(weeks).fill(0), carry: 0 });
    for (const o of orders) for (const s of chainOf(o)) {
        if (!groups.has(s.name)) groups.set(s.name, { kind: s.kind, wcs: new Map() });
        const g = groups.get(s.name);
        if (!g.wcs.has(s.wc)) g.wcs.set(s.wc, mk());
        const rec = g.wcs.get(s.wc);
        if (s.status === 'done') continue;
        const hm = hoursOf(s, modeM), hw = hoursOf(s, modeW);
        if (!(hm > 0) && !(hw > 0)) continue;
        const w = windowOf(s);
        if (!w) continue;
        const days = [];
        for (let d = w.startMs; d <= w.endMs; d = addDays(d, 1)) if (isWorkday(d)) days.push(d);
        if (!days.length) days.push(w.startMs);
        for (const d of days) {
            const wi = weekOfDay(d);
            if (wi < 0) continue;
            rec.m[wi] += hm / days.length; rec.w[wi] += hw / days.length;
            if (d < today) rec.carry += hm / days.length;
        }
    }
    const dayCounts = wl.map((w) => {
        let work = 0, sat = 0;
        for (let d = Math.max(w.startMs, today); d < w.endMs; d = addDays(d, 1)) { if (isWorkday(d)) work++; else if (new Date(d).getDay() === 6) sat++; }
        return { work, sat };
    });
    const hoursPerUnit = (i) => dayCounts[i].work * (HOURS_PER_DAY + otHours) + (saturday ? dayCounts[i].sat * HOURS_PER_DAY : 0);
    const out = [];
    for (const [name, g] of groups) {
        if (![...g.wcs.values()].some((r) => r.m.some((x) => x > 0) || r.w.some((x) => x > 0))) continue;
        const wcs = [...g.wcs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([wc, r]) => {
            const eff = effUnits(cfgOf(wc));
            const cells = r.m.map((dm, i) => cellOf(dm, r.w[i], eff.machine * hoursPerUnit(i), eff.worker * hoursPerUnit(i)));
            return { wc, eff, cells, carry: r1(r.carry), active: r.m.some((x) => x > 0) || r.w.some((x) => x > 0) };
        });
        // グループ全体(同じグループの中で仕事を回せる前提で足し合わせ)
        const cells = wl.map((_, i) => {
            let dm = 0, dw = 0, cm = 0, cw = 0;
            for (const x of wcs) { dm += x.cells[i].demandM; dw += x.cells[i].demandW; cm += x.cells[i].capM; cw += x.cells[i].capW; }
            return cellOf(dm, dw, cm, cw);
        });
        const redWcs = wcs.filter((x) => x.cells[0].level === 'red').length;
        const c0 = cells[0];
        let hint;
        if (c0.level === 'red') {
            const res = c0.worse, short = Math.ceil(-(res === 'worker' ? c0.slackW : c0.slackM));
            const units = wcs.reduce((a, x) => a + x.eff[res === 'worker' ? 'worker' : 'machine'], 0) || 1, u = res === 'worker' ? '人' : '台';
            const wd = dayCounts[0].work;
            const ot = wd > 0 ? Math.ceil((short / (units * wd)) * 10) / 10 : null, sat = Math.ceil((short / (units * HOURS_PER_DAY)) * 2) / 2;
            hint = { kind: 'short', res, short, ot, sat, units, text: `今週 ${res === 'worker' ? '人' : '機械'}が ${short}h 不足 → ${ot != null ? `残業 1日${ot}h(全${units}${u})` : '残業は使えない週'} か 土曜 ${sat}日` };
        } else if (redWcs > 0) hint = { kind: 'skew', redWcs, text: `全体は足りるが 作業区 ${redWcs} つに偏り・他の作業区へ回せれば こなせる` };
        else hint = { kind: 'ok', text: `足りる(余裕 ${Math.floor(Math.min(...cells.map((c) => c.slack)))}h〜)` };
        out.push({ name, kind: g.kind, wcs, cells, redWcs, hint, dai: wcs.reduce((a, x) => a + x.eff.machine, 0), people: wcs.reduce((a, x) => a + x.eff.worker, 0) });
    }
    const worstOrder = (a, b) => LEVEL_RANK[b.cells[0].level] - LEVEL_RANK[a.cells[0].level] || (b.cells[0].pct === a.cells[0].pct ? rank(a.name) - rank(b.name) : b.cells[0].pct - a.cells[0].pct);
    out.sort(worstOrder);
    const byWeek = wl.map((_, i) => out.filter((g) => g.cells[i].level === 'red').map((g) => g.name));
    const tight = out.filter((g) => g.cells[0].level !== 'red' && g.redWcs > 0).map((g) => g.name);
    const short0 = out.filter((g) => g.cells[0].level === 'red').reduce((a, g) => a + Math.max(0, -g.cells[0].slack), 0);
    return { weeks: wl.map((w, i) => ({ ...w, ...dayCounts[i] })), groups: out, summary: { cannotNow: byWeek[0], byWeek, tight, shortNow: r1(short0), groupCount: out.length } };
}
