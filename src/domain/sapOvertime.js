// 🕘 機械グループの「残業は いくつ要るか」と「持ち越しは いつ無くなるか」(純関数・仮の計算)
// 目的: 今の「あふれるか」の答えから、足りない時間 → 1人1日の残業 → 土曜の日数 → それでも残る時間 を出す(①)。
//       持ち越し(計画日を過ぎた未完了)が 何週で無くなるか・N週で片付ける残業はいくつか を出す(②)。
// 考え方(平易に):
//   ① 足りない時間 = 必要 − 使える(0以下なら残業は要らない)。1人1日の残業 = 足りない時間 ÷(人数 × 残りの稼働日)を 0.5h きざみで切り上げ。
//      上限(1人1日)を超える時は 残業は上限まで・残りを ÷(人数 × 7.75h)を 0.5日きざみで切り上げ=土曜の日数(その週の土曜の数まで)。
//      それでも残る時間は remain(回す・来週・相談)。持ち越しは入れない(②で別に見る)。
//   ② 週の終わりの持ち越し = 前の週の持ち越し +(その週に求められる時間 − 使える時間)・0 より下にはしない。
//      3週後から先は SAP にまだ計画が入りきっていないので 今週〜2週後の平均が続くと置く(目安)。
//      N週で片付ける = balance[N] が 0 になる最小の残業(1人1日・0.5h きざみ)。上限で足りなければ 土曜を 0.5日ずつ足す。
// 入力: capacityGroups の答え(groups・weeks)。人数は画面で入れた数(SAP に人の名前・人数は無い)。
// 出力: overtimeNeed / overtimePlan / weekSeries / carryOutlook / carryGoal
// 触る外の物: なし(Firebase・ネットワーク・保存に触れない・Date.now() を呼ばない)
// 確かめ方: node --test src/domain/__tests__/sapOvertime.test.mjs
import { HOURS_PER_DAY } from './sapBoard.js';

export const OT_CHOICES = [1, 1.5, 2, 3];   // 1人1日の残業の上限(おすすめ=2h)
export const OT_DEFAULT = 2;
export const HORIZON = 8;                    // 持ち越しを見る週の数
const EPS = 1e-6;
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const ceilHalf = (x) => Math.ceil(x * 2 - EPS) / 2;     // 0.5 きざみで切り上げ
const cnt = (v) => Math.max(1, Math.floor(Number(v) || 1));

/**
 * 1つのグループ・1週ぶんの 残業の答え。
 * @param {{demand:number,cap:number,count:number,workDays:number,satDays:number,capOT?:number}} p
 */
export function overtimeNeed({ demand, cap, count, workDays, satDays, capOT = OT_DEFAULT }) {
    const n = cnt(count);
    const wd = Math.max(0, Math.floor(workDays) || 0), sd = Math.max(0, Math.floor(satDays) || 0);
    const short = demand - cap;
    const base = { need: false, short: 0, count: n, workDays: wd, ot: 0, otHours: 0, satDays: 0, satHours: 0, remain: 0, usable: r2(cap), capOT };
    if (!(short > EPS)) return base;
    let rest = short, ot = 0, otHours = 0;
    if (wd > 0 && capOT > 0) {
        const want = ceilHalf(short / (n * wd));
        ot = Math.min(want, capOT);
        otHours = ot * n * wd;
        rest = short - otHours;
    }
    let sat = 0, satHours = 0;
    if (rest > EPS) {
        sat = Math.min(ceilHalf(rest / (n * HOURS_PER_DAY)), sd);
        satHours = sat * n * HOURS_PER_DAY;
        rest = rest - satHours;
    }
    return { ...base, need: true, short: r2(short), ot, otHours: r2(otHours), satDays: sat, satHours: r2(satHours), remain: rest > EPS ? r2(rest) : 0, usable: r2(cap + otHours + satHours) };
}

/** capacityGroups の1グループ → 週ごとの 必要・使える・稼働日・土曜(8週ぶんに伸ばす・3週後から先の必要は 今週〜2週後の平均) */
export function weekSeries(g, weeks, res = 'machine', horizon = HORIZON) {
    const worker = res === 'worker';
    const dem = (c) => (worker ? c.demandW : c.demandM);
    const have = g.cells.length;
    const first3 = g.cells.slice(0, Math.min(3, have)).map(dem);
    const avg = first3.length ? first3.reduce((a, b) => a + b, 0) / first3.length : 0;
    const demand = [], cap = [], work = [], sat = [], actual = [];
    for (let k = 0; k < horizon; k++) {
        const c = g.cells[k];
        const real = !!c && k < 3;
        demand.push(real ? dem(c) : avg);
        work.push(weeks[k] ? weeks[k].work : (weeks[weeks.length - 1] ? weeks[weeks.length - 1].work : 5));
        sat.push(weeks[k] ? weeks[k].sat : 1);
        actual.push(real);
    }
    // 使える時間は 台数(人数)× 7.75h × 稼働日 で出し直す(グループの合計は 作業区ごとに 0.1h へ丸めた物の足し算で 0.1h ずれるため)
    const count = cnt(worker ? g.people : g.dai);
    for (let k = 0; k < horizon; k++) cap.push(r2(count * HOURS_PER_DAY * work[k]));
    return { demand, cap, work, sat, actual, count };
}

/**
 * ① 全グループの残業の答え(見る週 weekIdx・上限 capOT)。
 * rows = 残業が要るグループ(あふれる)・fitByMove = グループは足りるが作業区があふれる(回せば収まる)・fine = 足りるグループ
 */
export function overtimePlan(cap, { weekIdx = 0, capOT = OT_DEFAULT, res = 'machine' } = {}) {
    const { groups, weeks } = cap;
    const w = weeks[weekIdx] || weeks[0];
    const rows = [], fitByMove = [], fine = [];
    for (const g of groups) {
        const c = g.cells[weekIdx] || g.cells[0];
        const demand = res === 'worker' ? c.demandW : c.demandM;
        const count = cnt(res === 'worker' ? g.people : g.dai);
        const capH = r2(count * HOURS_PER_DAY * w.work);   // 作業区ごとの 0.1h 丸めの足し算に頼らない
        const wcOver = g.wcs.filter((x) => x.cells[weekIdx] && x.cells[weekIdx].pct > 1);
        if (demand > capH + EPS) {
            const need = overtimeNeed({ demand, cap: capH, count, workDays: w.work, satDays: w.sat, capOT });
            rows.push({ name: g.name, pct: c.pct, level: c.level, demand, cap: capH, count, wcs: g.wcs.map((x) => x.wc), wcOver: wcOver.map((x) => x.wc), ...need });
        } else if (wcOver.length) {
            fitByMove.push({ name: g.name, pct: c.pct, demand, cap: capH, wcOver: wcOver.map((x) => ({ wc: x.wc, pct: x.cells[weekIdx].pct })) });
        } else {
            fine.push({ name: g.name, pct: c.pct });
        }
    }
    const otTotal = rows.reduce((a, r) => a + r.otHours, 0);
    const otPeople = rows.filter((r) => r.ot > 0).reduce((a, r) => a + r.count, 0);
    const satPeople = rows.filter((r) => r.satDays > 0).reduce((a, r) => a + r.count, 0);
    const remainTotal = rows.reduce((a, r) => a + r.remain, 0);
    return { week: w, weekIdx, capOT, rows, fitByMove, fine, otTotal: r2(otTotal), otPeople, satPeople, remainTotal: r2(remainTotal) };
}

/**
 * ② 持ち越しの行き先。balance[0]=今の持ち越し・balance[k]=k週の終わり(k=1..horizon)。
 * extra[k-1] = k週目に残業で足せる時間(任意)。state: none(持ち越しなし)/ clear(N週で無くなる)/ remain(減るが残る)/ grow(減らない・増える)
 */
export function carryOutlook({ carry, demand, cap, extra = [], horizon = HORIZON }) {
    const balance = [Math.max(0, carry)];
    for (let k = 0; k < horizon; k++) {
        const d = demand[k] ?? 0, c = (cap[k] ?? 0) + (extra[k] || 0);
        balance.push(Math.max(0, balance[k] + d - c));
    }
    const firstZero = balance.findIndex((b, k) => k > 0 && b <= EPS);   // 初めて 0 になる週(-1=ならない)
    if (balance[0] <= EPS) return { balance: balance.map(r1), clearedAt: 0, firstZero: firstZero < 0 ? null : firstZero, state: 'none', left: r1(balance[horizon]) };
    let clearedAt = null;   // 無くなって そのあと増えない週
    for (let k = 1; k <= horizon; k++) if (balance.slice(k).every((b) => b <= EPS)) { clearedAt = k; break; }
    const last = balance[horizon], prev = balance[horizon - 1];
    const state = clearedAt != null ? 'clear' : last >= prev - EPS ? 'grow' : 'remain';
    return { balance: balance.map(r1), clearedAt, firstZero: firstZero < 0 ? null : firstZero, state, left: r1(last) };
}

/**
 * ② N週で片付ける残業。1人1日の残業を 0.5h から上限まで・足りなければ 上限+土曜を 0.5日ずつ(その週の土曜の数まで)。
 * 戻り: { ok, ot, sat(1週あたりの土曜の日数), extra, outlook, weeksNeeded }。ok=false は「N週では片付かない(weeksNeeded 週かかる・null=8週でも片付かない)」
 */
export function carryGoal({ carry, demand, cap, work, sat, count, N, capOT = OT_DEFAULT, horizon = HORIZON }) {
    const n = cnt(count);
    const extraOf = (ot, sd) => Array.from({ length: horizon }, (_, k) => ot * n * (work[k] || 0) + Math.min(sd, sat[k] || 0) * n * HOURS_PER_DAY);
    const run = (ot, sd) => { const extra = extraOf(ot, sd); return { extra, outlook: carryOutlook({ carry, demand, cap, extra, horizon }) }; };
    const done = (o) => o.outlook.balance[N] <= EPS;
    for (let ot = 0; ot <= capOT + EPS; ot += 0.5) { const o = run(ot, 0); if (done(o)) return { ok: true, ot, sat: 0, ...o, weeksNeeded: N }; }
    const maxSat = Math.max(0, ...sat.slice(0, horizon));
    for (let sd = 0.5; sd <= maxSat + EPS; sd += 0.5) { const o = run(capOT, sd); if (done(o)) return { ok: true, ot: capOT, sat: sd, ...o, weeksNeeded: N }; }
    const o = run(capOT, maxSat);
    return { ok: false, ot: capOT, sat: maxSat, ...o, weeksNeeded: o.outlook.clearedAt };
}
