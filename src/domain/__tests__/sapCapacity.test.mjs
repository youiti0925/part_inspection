// こなせるか表(工程 × 週): 作り物の小さな行
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrders } from '../sapProgress.js';
import { scheduleOrders } from '../sapSchedule.js';
import { stageRows } from '../sapBoard.js';
import { capacityTable, weekList, rowInWeek } from '../sapCapacity.js';

const D = (iso) => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000) + 25569;
const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const NOW = at(2026, 11, 17, 8, 30);   // 火曜(週は 11/16〜11/22)
const st = (A, B, C, T, J, extra = {}) => ({ A, B, C, D: T, J, U: 'X', V: 'x', F: 1, ...extra });
const run = (rows, o = {}) => { const base = buildOrders(rows); const s = scheduleOrders(base, { nowMs: NOW }); return { s, t: capacityTable(s.orders, { nowMs: NOW, ...o }) }; };
// 平面研削 40h を 今週(火〜金・4日)の窓に置く: 窓 11/17〜11/20
const wk = (n, h, a, b) => st(String(n), '0010', '2385', '平面研削:a', h, { R: D(a), S: D(b) });

test('SC01 週の列: 月曜始まり・今週・来週', () => {
    const w = weekList(NOW, 4);
    assert.equal(w.length, 4); assert.equal(w[0].name, '今週'); assert.equal(w[0].label, '11/16〜11/22'); assert.equal(w[1].label, '11/23〜11/29');
});

test('SC02 必要÷使える: 今週は今日(火)から4日=31h/台。必要 24h なら 77% で緑・余裕 7h', () => {
    const { t } = run([wk(1, 24, '2026-11-17', '2026-11-20')]);
    const r = t.rows.find((x) => x.name === '平面研削'); const c = r.cells[0];
    assert.equal(c.cap, 31); assert.equal(c.demand, 24); assert.equal(c.slack, 7); assert.equal(c.level, 'green');
    assert.equal(r.hint.ok, true); assert.match(r.hint.text, /\+7h 余裕/);
    assert.equal(t.totals.cannotNow, 0);
});

test('SC03 黄(90〜100%)と赤(100%超・足りない時間)・足りない時の換算(残業と土曜)', () => {
    const y = run([wk(1, 29, '2026-11-17', '2026-11-20')]).t.rows[0].cells[0];   // 29/31 = 93%
    assert.equal(y.level, 'yellow');
    const { t } = run([wk(1, 40, '2026-11-17', '2026-11-20')]);
    const r = t.rows[0]; const c = r.cells[0];
    assert.equal(c.level, 'red'); assert.equal(c.slack, -9);   // 31h - 40h
    assert.equal(r.hint.ok, false); assert.equal(r.hint.short, 9);
    assert.equal(r.hint.otPerDay, 2.3);       // 9h ÷ (1台×4日) = 2.25 → 2.3
    assert.equal(r.hint.satDays, 1.5);        // 9h ÷ 7.75 = 1.16 → 1.5日
    assert.equal(t.totals.cannotNow, 1); assert.equal(t.totals.shortNow, 9);
});

test('SC04 台数・残業・土曜で使える時間が変わる(変えると足りる)', () => {
    const rows = [wk(1, 40, '2026-11-17', '2026-11-20')];
    assert.equal(run(rows, { capOf: () => 2 }).t.rows[0].cells[0].cap, 62);
    assert.equal(run(rows, { otHours: 2 }).t.rows[0].cells[0].cap, 39);          // 4日 × (7.75+2)
    assert.equal(run(rows, { saturday: true }).t.rows[0].cells[0].cap, 38.8);   // 土曜 11/21 が使える
    assert.equal(run(rows, { otHours: 3 }).t.rows[0].cells[0].level, 'yellow');   // 4×10.75=43 → 93%
    assert.equal(run(rows, { otHours: 5 }).t.rows[0].cells[0].level, 'green');   // 4×12.75=51 → 78%
});

test('SC05 計画の窓がもう過ぎた分(遅れ)は 今週に積む・来週以降の窓は その週へ・範囲外は数えない', () => {
    const rows = [wk(1, 8, '2026-11-02', '2026-11-06'), wk(2, 8, '2026-11-24', '2026-11-24'), wk(3, 8, '2027-03-01', '2027-03-02')];
    const { t } = run(rows, { weeks: 4 });
    const r = t.rows[0];
    assert.equal(r.cells[0].demand, 8); assert.equal(r.carry, 8);
    assert.equal(r.cells[1].demand, 8); assert.equal(r.cells[2].demand, 0);
    assert.equal(t.rows.length, 1);
});

test('SC06 済の工程・標準時間 0 の工程・日付なしは必要量に入れない(日付なしは別に数える)', () => {
    const rows = [st('1', '0010', '2385', '平面研削:a', 8, { H: D('2026-11-10'), I: D('2026-11-11') }), st('2', '0010', '2385', '平面研削:a', 0, { R: D('2026-11-17'), S: D('2026-11-18') }), st('3', '0010', '2385', '平面研削:a', 5)];
    const { t } = run(rows);
    assert.equal(t.rows.length, 0);   // 必要量がある行は無い(日付なしの 5h は SAP の計画日が無いので どの週にも入れない)
});

test('SC07 マスを押した時の一覧: 工程ごとの行のうち その週に計画の窓がかかる行(今週は遅れも含む)', () => {
    const rows = [wk(1, 8, '2026-11-02', '2026-11-06'), wk(2, 8, '2026-11-24', '2026-11-24'), wk(3, 8, '2026-11-18', '2026-11-19')];
    const { s } = run(rows); const w = weekList(NOW, 3);
    const sr = stageRows(s.orders, '平面研削', { nowMs: NOW });
    assert.deepEqual(sr.filter((r) => rowInWeek(r, w[0], 0, NOW)).map((r) => r.orderNo).sort(), ['1', '3']);
    assert.deepEqual(sr.filter((r) => rowInWeek(r, w[1], 1, NOW)).map((r) => r.orderNo), ['2']);
});

test('SC08 機械と人を別に数える: 機械=段取り+機械・人=段取り+作業者。機械は足りても人が足りない/その逆', () => {
    // 窓 11/17〜11/20(4日=31h/台・人)。段取り 2h + 機械 20h + 作業者 40h
    const rows = [st('1', '0010', '2385', '平面研削:a', 2, { L: 20, N: 40, R: D('2026-11-17'), S: D('2026-11-20') })];
    const { t } = run(rows, { resources: ['machine', 'worker'] });
    const m = t.rows.find((r) => r.res === 'machine'), w = t.rows.find((r) => r.res === 'worker');
    assert.equal(m.cells[0].demand, 22); assert.equal(m.cells[0].level, 'green');            // 22 ÷ 31 = 71%
    assert.equal(w.cells[0].demand, 42); assert.equal(w.cells[0].level, 'red');              // 42 > 31 → 人が足りない
    assert.equal(w.cells[0].slack, -11); assert.match(w.hint.text, /残業 1日.*×1人/);
    assert.equal(t.byRes.machine.cannotNow, 0); assert.equal(t.byRes.worker.cannotNow, 1); assert.equal(t.totals.shortNow, 11);
    // 人数を増やすと足りる(既定は台数と同じ=1人)
    const t2 = run(rows, { resources: ['worker'], peopleOf: () => 2 }).t;
    assert.equal(t2.rows[0].units, 2); assert.equal(t2.rows[0].cells[0].level, 'green');    // 42/62 = 68%
});

test('SC09 標準値2・3 を ×数量 に切り替えると 必要量が増える(既定=ロットあたり)', () => {
    const rows = [st('1', '0010', '2385', '平面研削:a', 1, { L: 2, N: 1, F: 4, R: D('2026-11-17'), S: D('2026-11-20') })];
    const lot = run(rows, { resources: ['machine', 'worker'] }).t, qty = run(rows, { resources: ['machine', 'worker'], perQty: true }).t;
    assert.deepEqual(lot.rows.map((r) => r.cells[0].demand), [3, 2]);    // 機械 1+2・人 1+1
    assert.deepEqual(qty.rows.map((r) => r.cells[0].demand), [9, 5]);    // 機械 1+2×4・人 1+1×4
});
