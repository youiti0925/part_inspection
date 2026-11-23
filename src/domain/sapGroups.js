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
import { leadTimes } from './sapArrivalForecast.js';
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

/** マスの計算。resource: 'machine'(機械の占有だけ)/ 'worker'(人だけ)/ 'both'(悪い方) */
function cellOf(dm, dw, cm, cw, resource = 'machine') {
    const ratio = (d, c) => (c > 0 ? d / c : (d > 0 ? Infinity : 0));
    const pm = ratio(dm, cm), pw = ratio(dw, cw);
    const pct = resource === 'worker' ? pw : resource === 'both' ? Math.max(pm, pw) : pm;
    const level = pct > 1 ? 'red' : pct >= GREEN_BELOW ? 'yellow' : 'green';
    const slackM = cm - dm, slackW = cw - dw;
    const slack = resource === 'worker' ? slackW : resource === 'both' ? Math.min(slackM, slackW) : slackM;
    const worse = resource === 'worker' || (resource === 'both' && pw > pm) ? 'worker' : 'machine';
    return { demandM: r1(dm), demandW: r1(dw), capM: r1(cm), capW: r1(cw), pctM: pm, pctW: pw, pct, worse, slackM: r1(slackM), slackW: r1(slackW), slack: r1(slack), level };
}

/** 週ごとの「SAP に入っている仕事量」を 1稼働日あたりで比べ、今週〜2週後の最大の この割合 未満の週は「薄い」(まだ計画が入っていない) */
export const THIN_RATIO = 0.8;

/**
 * 機械グループ × 作業区 × 週(Fable の検証 11-18 の指示を反映)。
 *  ・標準値2・3 は ×数量(1個あたり)が既定(perQty)。段取りは 1ロット1回。
 *  ・計画の窓の 今日より前の日の分(持ち越し)は 今週のマスに足さず 別に持つ(carry: h・件・一番古い計画)。窓の稼働日へ均等に置き 今日以降の分だけを週に入れる。
 *  ・グループは 作業区コード(readWorkName)で決まった名前。能力に数えるのは 未完了の工程がある作業区だけ。
 *  ・検査(2509/2519)・洗浄・付帯作業は 機械の表に入れない。付帯作業の数えていない時間は summary.uncounted。
 *  ・後ろの工程が済で 前が未の工程(完了の入力もれらしい)は 必要量から外し summary.suspect に数える。
 * @param {object} o { nowMs, weeks, perQty, cfgOf(wc)=>{units,people,multi}, otHours, saturday, isWorkday, resource:'machine'|'worker'|'both' }
 */
export function capacityGroups(orders, { nowMs, weeks = 5, perQty = true, cfgOf = () => ({ units: 1 }), otHours = 0, saturday = false, resource = 'machine', isWorkday = factoryClock(DEFAULT_WORK_SCHEDULE, null) } = {}) {
    const wl = weekList(nowMs, weeks);
    const today = startOfDay(nowMs);
    const todayDay = Math.floor((today + 12 * 3600000) / 86400000);
    const dayNoOf = (ms) => Math.floor((ms + 12 * 3600000) / 86400000);
    const weekOfDay = (dayMs) => { for (let i = 0; i < wl.length; i++) if (dayMs >= wl[i].startMs && dayMs < wl[i].endMs) return i; return -1; };
    const modeM = hoursKey('machine', perQty), modeW = hoursKey('worker', perQty);
    const groups = new Map();
    const mk = () => ({ m: new Array(weeks).fill(0), w: new Array(weeks).fill(0), carryM: 0, carryW: 0, carryN: 0, oldest: 0, n: 0, zero: 0, top: [] });
    let suspect = 0, uncountedH = 0, uncountedN = 0;
    for (const o of orders) {
        const chain = chainOf(o);
        const lastDoneIdx = chain.reduce((a, s, x) => (s.status === 'done' ? x : a), -1);
        for (const s of o.stages) {
            if (s.kind === 'misc' && s.status !== 'done') { const h = hoursOf(s, modeM); if (h > 0) { uncountedH += h; uncountedN++; } }
        }
        chain.forEach((s, ci) => {
            if (s.kind !== 'machine') return;
            if (!groups.has(s.name)) groups.set(s.name, { kind: s.kind, wcs: new Map() });
            const g = groups.get(s.name);
            if (!g.wcs.has(s.wc)) g.wcs.set(s.wc, mk());
            const rec = g.wcs.get(s.wc);
            if (s.status === 'done') return;
            if (ci < lastDoneIdx) { suspect++; return; }   // 後ろが済で前が未 = 完了の入力もれらしい
            const hm = hoursOf(s, modeM), hw = hoursOf(s, modeW);
            rec.n++;
            if (!(hm > 0) && !(hw > 0)) { rec.zero++; return; }
            const w = windowOf(s);
            if (!w) return;
            const agoDays = Math.max(0, todayDay - dayNoOf(w.startMs));
            rec.top.push({ key: o.order + '|' + s.act, order: o.order, tx: (o.itemText || '').trim() || o.item, qty: s.qty, wc: s.wc, ago: agoDays, planIso: sapStartOf(s) || '', h: r1(hm), hw: r1(hw), moved: !!s.moved, from: s.fromWc || '' });
            // 窓の稼働日に均等に置き、今日より前の日の分は 持ち越し(別の列)・今日以降の分だけを 週のマスに入れる
            const days = [];
            for (let d = w.startMs; d <= w.endMs; d = addDays(d, 1)) if (isWorkday(d)) days.push(d);
            if (!days.length) days.push(w.startMs);
            const past = days.filter((d) => d < today).length;
            if (past) { rec.carryM += hm * past / days.length; rec.carryW += hw * past / days.length; rec.carryN++; rec.oldest = Math.max(rec.oldest, agoDays); }
            for (const d of days) {
                if (d < today) continue;
                const wi = weekOfDay(d);
                if (wi < 0) continue;
                rec.m[wi] += hm / days.length; rec.w[wi] += hw / days.length;
            }
        });
    }
    const dayCounts = wl.map((w) => {
        let work = 0, sat = 0;
        for (let d = Math.max(w.startMs, today); d < w.endMs; d = addDays(d, 1)) { if (isWorkday(d)) work++; else if (new Date(d).getDay() === 6) sat++; }
        return { work, sat };
    });
    const hoursPerUnit = (i) => dayCounts[i].work * (HOURS_PER_DAY + otHours) + (saturday ? dayCounts[i].sat * HOURS_PER_DAY : 0);
    const lead = leadTimes(orders);
    const out = [];
    const allDemand = new Array(weeks).fill(0); let allCarry = 0, allCarryN = 0;
    for (const [name, g] of groups) {
        const wcsAll = [...g.wcs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([wc, r]) => {
            const eff = effUnits(cfgOf(wc));
            const cells = r.m.map((dm, i) => cellOf(dm, r.w[i], eff.machine * hoursPerUnit(i), eff.worker * hoursPerUnit(i), resource));
            const carry = resource === 'worker' ? r.carryW : r.carryM;
            const u = (resource === 'worker' ? eff.worker : eff.machine) || 1;
            return { wc, eff, cells, active: r.n > 0, n: r.n, zero: r.zero, carry: r1(carry), carryN: r.carryN, oldest: r.oldest, carryDays: carry / (u * HOURS_PER_DAY), top: r.top };
        });
        const wcs = wcsAll.filter((x) => x.active);      // 能力に数えるのは 未完了の工程がある作業区だけ
        if (!wcs.length) continue;
        const cells = wl.map((_, i) => {
            let dm = 0, dw = 0, cm = 0, cw = 0;
            for (const x of wcs) { dm += x.cells[i].demandM; dw += x.cells[i].demandW; cm += x.cells[i].capM; cw += x.cells[i].capW; }
            return cellOf(dm, dw, cm, cw, resource);
        });
        cells.forEach((c, i) => { allDemand[i] += resource === 'worker' ? c.demandW : c.demandM; });
        const carry = wcs.reduce((a, x) => a + x.carry, 0), carryN = wcs.reduce((a, x) => a + x.carryN, 0);
        const units = wcs.reduce((a, x) => a + (resource === 'worker' ? x.eff.worker : x.eff.machine), 0) || 1;
        allCarry += carry; allCarryN += carryN;
        const carryDays = carry / (units * HOURS_PER_DAY);
        const overWeeks = cells.slice(0, 3).filter((c) => c.pct > 1).length;
        const redWcs = wcs.filter((x) => x.cells.slice(0, 3).some((c) => c.pct > 1)).length;
        const verdict = overWeeks ? { level: 'red', text: `計画の分だけで あふれる週が ${overWeeks} つ(今週〜2週後)` }
            : carryDays > 5 ? { level: 'yellow', text: `持ち越しが 全台で 約${Math.round(carryDays)}日分。片付けるまで 新しい分が待つ` } : { level: 'green', text: '計画の分は足りる見込み' };
        const top = wcs.flatMap((x) => x.top).sort((a, b) => b.ago - a.ago || b.h - a.h).slice(0, 10);
        out.push({ name, kind: g.kind, wcs, wcsAll, cells, carry: r1(carry), carryN, oldest: Math.max(0, ...wcs.map((x) => x.oldest)), carryDays: r1(carryDays), redWcs, verdict, n: wcs.reduce((a, x) => a + x.n, 0), zero: wcs.reduce((a, x) => a + x.zero, 0),
            dai: wcs.reduce((a, x) => a + x.eff.machine, 0), people: wcs.reduce((a, x) => a + x.eff.worker, 0), lead: lead({ kind: 'machine', wc: wcs[0].wc, name }), top });
    }
    const vr = { red: 0, yellow: 1, green: 2 };
    const peak = (g) => Math.max(...g.cells.slice(0, 3).map((c) => c.pct));
    out.sort((a, b) => vr[a.verdict.level] - vr[b.verdict.level] || peak(b) - peak(a) || rank(a.name) - rank(b.name));
    const perDay = allDemand.map((h, i) => h / Math.max(1, dayCounts[i].work));
    const ref = Math.max(...perDay.slice(0, 3));
    const weeksOut = wl.map((w, i) => ({ ...w, ...dayCounts[i], allH: r1(allDemand[i]), perDay: r1(perDay[i]), thin: perDay[i] < ref * THIN_RATIO }));
    return { weeks: weeksOut, groups: out, summary: { reds: out.filter((g) => g.verdict.level === 'red').map((g) => g.name), redWcGroups: out.filter((g) => g.verdict.level !== 'red' && g.redWcs > 0).map((g) => ({ name: g.name, n: g.redWcs })), worst: out[0] || null, allCarry: r1(allCarry), allCarryN, suspect, uncounted: { h: r1(uncountedH), n: uncountedN }, groupCount: out.length } };
}
