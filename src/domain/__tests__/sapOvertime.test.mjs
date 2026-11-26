// 残業は いくつ要るか・持ち越しは いつ無くなるか(作り物の数字・手計算と合う事)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrders } from '../sapProgress.js';
import { scheduleOrders } from '../sapSchedule.js';
import { capacityGroups } from '../sapGroups.js';
import { overtimeNeed, overtimePlan, weekSeries, carryOutlook, carryGoal } from '../sapOvertime.js';

const near = (a, b, m = '') => assert.ok(Math.abs(a - b) < 1e-9, `${m} ${a} != ${b}`);

test('SO01 手計算(見本): 平面研削 3人 必要137h・使える116.25h → 足りない20.75h → 1日1.5h × 3人 × 5日 = 22.5h', () => {
    const r = overtimeNeed({ demand: 137, cap: 116.25, count: 3, workDays: 5, satDays: 1, capOT: 2 });
    assert.equal(r.need, true); assert.equal(r.short, 20.75);
    assert.equal(r.ot, 1.5); assert.equal(r.otHours, 22.5); assert.equal(r.satDays, 0); assert.equal(r.remain, 0);
    assert.equal(r.usable, 138.75);
});

test('SO02 手計算(見本): 横M/C 2人 必要108h・使える77.5h → 足りない30.5h → 1日2h(上限) × 2人 × 5日=20h + 残り10.5h → 土曜1日(15.5h)', () => {
    const r = overtimeNeed({ demand: 108, cap: 77.5, count: 2, workDays: 5, satDays: 1, capOT: 2 });
    assert.equal(r.short, 30.5);
    assert.equal(r.ot, 2); assert.equal(r.otHours, 20); assert.equal(r.satDays, 1); assert.equal(r.satHours, 15.5); assert.equal(r.remain, 0);
    assert.equal(r.usable, 113);
    assert.ok(r.usable >= 108);
});

test('SO03 足りる時は 残業 0(境目: ちょうど同じ・0.01h 足りない)', () => {
    assert.equal(overtimeNeed({ demand: 72, cap: 77.5, count: 2, workDays: 5, satDays: 1 }).need, false);
    assert.equal(overtimeNeed({ demand: 77.5, cap: 77.5, count: 2, workDays: 5, satDays: 1 }).need, false);
    const r = overtimeNeed({ demand: 77.51, cap: 77.5, count: 2, workDays: 5, satDays: 1 });
    assert.equal(r.need, true); assert.equal(r.ot, 0.5);   // 0.01÷10 → 0.5h に切り上げ
});

test('SO04 上限の境目: ちょうど上限(20h÷10=2h)は残業だけ・0.01h 超えると 残業は上限+土曜 0.5日', () => {
    const a = overtimeNeed({ demand: 100, cap: 80, count: 2, workDays: 5, satDays: 1, capOT: 2 });
    assert.equal(a.ot, 2); assert.equal(a.satDays, 0); assert.equal(a.remain, 0);
    const b = overtimeNeed({ demand: 100.01, cap: 80, count: 2, workDays: 5, satDays: 1, capOT: 2 });
    assert.equal(b.ot, 2); assert.equal(b.satDays, 0.5);
});

test('SO05 残り稼働日 1日・0日(金曜の夕方=残業は使えない → 土曜だけ)', () => {
    const one = overtimeNeed({ demand: 20, cap: 15.5, count: 2, workDays: 1, satDays: 1, capOT: 2 });   // 足りない 4.5h・残業 2h×2人×1日=4h・残り 0.5h → 土曜 0.5日
    assert.equal(one.ot, 2); assert.equal(one.satDays, 0.5);
    const zero = overtimeNeed({ demand: 20, cap: 15.5, count: 2, workDays: 0, satDays: 1, capOT: 2 });
    assert.equal(zero.ot, 0); assert.equal(zero.otHours, 0); assert.equal(zero.satDays, 0.5); assert.equal(zero.remain, 0);
});

test('SO06 土曜が無い週: 残業の上限を超えた分は 「それでも残る」', () => {
    const r = overtimeNeed({ demand: 108, cap: 77.5, count: 2, workDays: 5, satDays: 0, capOT: 2 });
    assert.equal(r.satDays, 0); assert.equal(r.remain, 10.5); assert.equal(r.usable, 97.5);
});

test('SO07 足した後の「使える ≥ 必要」(残りが 0 の時)が いつも成り立つ', () => {
    for (const count of [1, 2, 3, 7]) for (const workDays of [0, 1, 3, 5]) for (const satDays of [0, 1, 2]) for (const capOT of [1, 1.5, 2, 3]) for (let demand = 0; demand <= 200; demand += 7.3) {
        const r = overtimeNeed({ demand, cap: 60, count, workDays, satDays, capOT });
        if (r.remain === 0) assert.ok(r.usable + 1e-6 >= Math.max(demand, 60), `${count}/${workDays}/${satDays}/${capOT}/${demand}`);
        else assert.ok(r.usable < demand);
    }
});

test('SO08 上限を上げると 土曜の日数は 増えない(1→3h)', () => {
    const s = (capOT) => overtimeNeed({ demand: 108, cap: 77.5, count: 2, workDays: 5, satDays: 2, capOT });
    assert.ok(s(1).satDays >= s(1.5).satDays && s(1.5).satDays >= s(2).satDays && s(2).satDays >= s(3).satDays);
});

test('SO09 持ち越し(見本): 平面研削 62h・必要 137/110/92・以後は平均113・使える116.25 → 82.75 → 76.5 → 52.25 … 8週後 36h・片付かないが減る', () => {
    const demand = [137, 110, 92, 113, 113, 113, 113, 113], cap = Array(8).fill(116.25);
    const o = carryOutlook({ carry: 62, demand, cap });
    assert.deepEqual(o.balance.slice(0, 4), [62, 82.8, 76.5, 52.3]);   // 画面用に 0.1h で丸める(82.75→82.8)
    near(o.balance[8], 36); assert.equal(o.state, 'remain'); assert.equal(o.left, 36); assert.equal(o.clearedAt, null);
});

test('SO10 持ち越し: 増える(減らない)=「片付かない」と言う・日付を作らない', () => {
    const o = carryOutlook({ carry: 45, demand: Array(8).fill(120), cap: Array(8).fill(100) });
    assert.equal(o.state, 'grow'); assert.equal(o.clearedAt, null);
});

test('SO11 持ち越し 0 で 毎週足りる = none・途中で無くなる = clear の週', () => {
    assert.equal(carryOutlook({ carry: 0, demand: Array(8).fill(50), cap: Array(8).fill(60) }).state, 'none');
    const o = carryOutlook({ carry: 30, demand: Array(8).fill(50), cap: Array(8).fill(60) });   // 10h ずつ減る
    assert.equal(o.state, 'clear'); assert.equal(o.clearedAt, 3);
});

test('SO12 手計算(見本): 平面研削を 4週で片付ける = 1人1日 1h × 3人(0.5h では 足りない)', () => {
    const demand = [137, 110, 92, 113, 113, 113, 113, 113], cap = Array(8).fill(116.25);
    const g = carryGoal({ carry: 62, demand, cap, work: Array(8).fill(5), sat: Array(8).fill(1), count: 3, N: 4, capOT: 2 });
    assert.equal(g.ok, true); assert.equal(g.ot, 1); assert.equal(g.sat, 0);
    assert.ok(g.outlook.balance[4] <= 1e-6);
    // (62+137+110+92+113−465)÷4 = 12.25h/週 ÷(3×5) = 0.82 → 1h
    const half = carryOutlook({ carry: 62, demand, cap, extra: Array(8).fill(0.5 * 3 * 5) });
    assert.ok(half.balance[4] > 1e-6);
});

test('SO13 目標を入れた減り方は N 週以内に 0・上限に当たったら 「N週では片付かない(○週かかる)」', () => {
    const demand = Array(8).fill(120), cap = Array(8).fill(100);
    const base = { carry: 60, demand, cap, work: Array(8).fill(5), sat: Array(8).fill(0), count: 2 };
    const ng = carryGoal({ ...base, N: 2, capOT: 2 });   // 週 20h 超過 + 60 → 2週で 100h・残業は 上限 2h で 2×2×5=20h/週 → 足りない
    assert.equal(ng.ok, false); assert.ok(ng.weeksNeeded == null || ng.weeksNeeded > 2);
    const ok = carryGoal({ ...base, N: 8, capOT: 3 });
    assert.equal(ok.ok, true); assert.ok(ok.outlook.balance[8] <= 1e-6);
});

test('SO14 残業を足すと 片付く週は 必ず 早まるか同じ', () => {
    const demand = [137, 110, 92, 113, 113, 113, 113, 113], cap = Array(8).fill(116.25);
    let last = Infinity;
    for (const ot of [0, 0.5, 1, 1.5, 2, 3]) {
        const o = carryOutlook({ carry: 62, demand, cap, extra: Array(8).fill(ot * 15) });
        const w = o.clearedAt ?? 99; assert.ok(w <= last); last = w;
    }
});

// ---- capacityGroups とつなぐ(今の答えと 1ミリも違わない事・残業 0 と土曜なしの時)----
const D = (iso) => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000) + 25569;
const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const NOW = at(2026, 11, 16, 8, 30);   // 月曜(今週の稼働日 5日・土曜 1日)
const st = (A, B, C, T, J, extra = {}) => ({ A, B, C, D: T, J, U: 'X', V: 'x', F: 1, ...extra });
const stage = (order, wc, J, L, N) => st(order, '0010', wc, '平面研削:a', J, { L, N, R: D('2026-11-16'), S: D('2026-11-20') });
const run = (rows, o = {}) => capacityGroups(scheduleOrders(buildOrders(rows), { nowMs: NOW }).orders, { nowMs: NOW, weeks: 5, cfgOf: () => ({ units: 2 }), ...o });

test('SO15 capacityGroups の答えから: 必要=使える+足りない・残業を足した使える ≥ 必要・基の答え(残業0・土曜なし)を変えない', () => {
    const rows = [stage('1', '2385', 2, 70, 0), stage('2', '2386', 2, 68, 0)];   // 平面研削 2作業区×2台・必要 142h(各作業区 77.5h 以内)・使える 4×7.75×5=155h
    const cap = run(rows);
    const g = cap.groups[0];
    assert.equal(g.cells[0].capM, 155); assert.equal(g.cells[0].demandM, 142);
    const p0 = overtimePlan(cap, { weekIdx: 0, capOT: 2 });
    assert.equal(p0.rows.length, 0); assert.equal(p0.fine.length, 1);
    const rows2 = [stage('1', '2385', 2, 120, 0), stage('2', '2386', 2, 60, 0)];   // 必要 184h
    const cap2 = run(rows2);
    const p = overtimePlan(cap2, { weekIdx: 0, capOT: 2 });
    const r = p.rows[0];
    assert.equal(r.short, 29); assert.equal(r.count, 4);   // 184−155
    assert.equal(r.ot, 1.5);                              // 29÷(4×5)=1.45 → 1.5h
    assert.ok(r.usable >= 184);
    assert.deepEqual(run(rows2).groups[0].cells, cap2.groups[0].cells);   // 同じ入力なら同じ答え
    const s = weekSeries(cap2.groups[0], cap2.weeks);
    assert.equal(s.demand.length, 8); assert.equal(s.cap.length, 8); assert.equal(s.count, 4);
});
