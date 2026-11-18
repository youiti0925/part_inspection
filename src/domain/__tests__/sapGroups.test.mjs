// 機械グループ×作業区×週・台数/人数/掛け持ち・手で回す(作り物の小さな行)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrders } from '../sapProgress.js';
import { scheduleOrders } from '../sapSchedule.js';
import { capacityGroups, effUnits, applyMoves, groupWcs, moveKey } from '../sapGroups.js';

const D = (iso) => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000) + 25569;
const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const NOW = at(2026, 11, 17, 8, 30);   // 火曜(今週の使える日 火〜金 = 4日 = 31h/台)
const st = (A, B, C, T, J, extra = {}) => ({ A, B, C, D: T, J, U: 'X', V: 'x', F: 1, ...extra });
// 平面研削(2385・2386)・窓 11/17〜11/20
const stage = (order, wc, J, L, N, act = '0010') => st(order, act, wc, '平面研削:a', J, { L, N, R: D('2026-11-17'), S: D('2026-11-20') });
const run = (rows, o = {}) => capacityGroups(scheduleOrders(buildOrders(rows), { nowMs: NOW }).orders, { nowMs: NOW, ...o });

test('SG01 掛け持ち: 台数と人数→同時に動ける数。可=機械は台数・人は人数 / 不可=min(台数,人数)', () => {
    assert.deepEqual(effUnits({ units: 2, people: 1, multi: true }), { units: 2, people: 1, multi: true, machine: 2, worker: 1 });
    assert.deepEqual(effUnits({ units: 2, people: 1, multi: false }), { units: 2, people: 1, multi: false, machine: 1, worker: 1 });
    assert.deepEqual(effUnits({ units: 3, people: 5, multi: false }).machine, 3);   // 人が余っても 台数が上限
    assert.deepEqual(effUnits({ units: 2 }), { units: 2, people: 2, multi: false, machine: 2, worker: 2 });   // 人数の既定=台数
});

test('SG02 「2台あるが作業者1人」: 掛け持ち 可 なら こなせる(機械 65%・人 32%)・不可 なら こなせない(機械 129%)', () => {
    // 段取り 2h + 機械 38h = 機械の占有 40h・作業者 2h+8h = 人の 10h。使える 31h/台
    const rows = [stage('1', '2385', 2, 38, 8)];
    const ok = run(rows, { cfgOf: () => ({ units: 2, people: 1, multi: true }) }).groups[0];
    const ng = run(rows, { cfgOf: () => ({ units: 2, people: 1, multi: false }) }).groups[0];
    const c1 = ok.wcs[0].cells[0], c2 = ng.wcs[0].cells[0];
    assert.equal(c1.demandM, 40); assert.equal(c1.capM, 62); assert.equal(c1.level, 'green'); assert.equal(c1.worse, 'machine');   // 40/62=65%
    assert.equal(c1.demandW, 10); assert.equal(c1.capW, 31);                                                                   // 10/31=32%
    assert.equal(c2.capM, 31); assert.equal(c2.level, 'red'); assert.equal(c2.slack, -9);                                       // 不可: 同時に動ける台数=1 → 40/31=129%
    assert.equal(ok.cells[0].level, 'green'); assert.equal(ng.cells[0].level, 'red');
});

test('SG03 人が足りない(機械は足りる): 人の方が悪ければ 人の色・マスは悪い方', () => {
    const rows = [stage('1', '2385', 2, 3, 40)];   // 機械 5h・人 42h
    const g = run(rows, { cfgOf: () => ({ units: 2, people: 1, multi: true }) }).groups[0];
    assert.equal(g.cells[0].worse, 'worker'); assert.equal(g.cells[0].level, 'red'); assert.equal(g.cells[0].slackW, -11);
    assert.match(g.hint.text, /人が 11h 不足/);
    assert.equal(g.hint.res, 'worker');
});

test('SG04 作業区ごとに割る: 偏り(片方の作業区があふれ もう片方が余る)・グループ全体は足りる=「全体は足りるが偏り」', () => {
    const rows = [stage('1', '2385', 0, 40, 0), stage('2', '2386', 0, 5, 0)];   // 2385 に 40h(31h/台 → 129%)・2386 に 5h
    const g = run(rows).groups[0];
    assert.equal(g.wcs.length, 2);
    const w = Object.fromEntries(g.wcs.map((x) => [x.wc, x.cells[0].level]));
    assert.deepEqual(w, { 2385: 'red', 2386: 'green' });
    assert.equal(g.cells[0].level, 'green');   // 45h ÷ 62h = 73%
    assert.equal(g.redWcs, 1); assert.equal(g.hint.kind, 'skew'); assert.match(g.hint.text, /偏り/);
});

test('SG05 グループの並び(悪い順)・上の要約(こなせない工程・偏りの工程・5週の赤の数)', () => {
    const rows = [stage('1', '2385', 0, 40, 0), st('2', '0010', '2371', '円筒研削:a', 0, { L: 5, R: D('2026-11-17'), S: D('2026-11-20') }), st('3', '0010', '2325', 'ﾌﾗｲｽ:a', 0, { L: 28, R: D('2026-11-17'), S: D('2026-11-20') })];
    const t = run(rows);
    assert.deepEqual(t.groups.map((g) => g.name), ['平面研削', 'フライス', '円筒研削']);   // 129% → 90% → 16%
    assert.deepEqual(t.summary.cannotNow, ['平面研削']); assert.equal(t.summary.byWeek.length, 5);
    assert.equal(t.summary.shortNow, 9);
});

test('SG06 手で回す: 同じ機械グループの別の作業区へ移すと あふれが移る・元は書き換えない・違うグループ/済の工程は動かない・戻せる(moves から消す)', () => {
    const base = buildOrders([stage('1', '2385', 0, 25, 0), stage('2', '2385', 0, 25, 0), st('3', '0010', '2386', '平面研削:a', 0, { L: 2, R: D('2026-11-17'), S: D('2026-11-20') }), st('9', '0010', '2371', '円筒研削:a', 0, { L: 2, R: D('2026-11-17'), S: D('2026-11-20') })]);
    assert.deepEqual(groupWcs(base, '平面研削'), ['2385', '2386']);   // 候補=同じ機械グループの作業区
    const before = capacityGroups(scheduleOrders(base, { nowMs: NOW }).orders, { nowMs: NOW }).groups.find((g) => g.name === '平面研削');
    assert.equal(before.wcs.find((x) => x.wc === '2385').cells[0].level, 'red');   // 50h > 31h
    const m = applyMoves(base, { [moveKey('2', '0010')]: '2386', [moveKey('9', '0010')]: '2385', [moveKey('1', '0010')]: '2385' });
    assert.equal(m.applied.length, 1); assert.equal(m.applied[0].to, '2386');
    assert.equal(m.ignored.length, 1); assert.match(m.ignored[0].why, /同じ機械グループ/);   // 円筒研削 → 2385 は動かない
    assert.equal(base[1].stages[0].wc, '2385'); assert.equal(base[1].stages[0].moved, undefined);   // 元は書き換えない
    const moved = m.orders[1].stages[0]; assert.equal(moved.wc, '2386'); assert.equal(moved.fromWc, '2385'); assert.equal(moved.moved, true);
    const after = capacityGroups(scheduleOrders(m.orders, { nowMs: NOW }).orders, { nowMs: NOW }).groups.find((g) => g.name === '平面研削');
    const lv = Object.fromEntries(after.wcs.map((x) => [x.wc, x.cells[0].level]));
    assert.deepEqual(lv, { 2385: 'green', 2386: 'green' });   // 25h と 27h → どちらも 31h に収まる(90% 未満)
    // 戻す = moves から消す → 元の値
    const back = applyMoves(base, {}); assert.equal(back.orders, base);
    // 見つからない・済の工程
    const bad = applyMoves(buildOrders([st('1', '0010', '2385', '平面研削:a', 1, { H: D('2026-11-10'), I: D('2026-11-11') }), stage('2', '2386', 0, 1, 0)]), { [moveKey('1', '0010')]: '2386', [moveKey('zz', '0010')]: '2385' });
    assert.equal(bad.applied.length, 0); assert.equal(bad.ignored.length, 2);
});

test('SG07 積み上げ(スケジュール)も 掛け持ち不可なら 同時に動ける台数 min(台数,人数) で数える(capacity に渡した数)', () => {
    const base = buildOrders([stage('1', '2385', 0, 4, 0), stage('2', '2385', 0, 4, 0)]);
    const two = scheduleOrders(base, { nowMs: NOW, capacity: { 2385: 2 } }).orders;     // 台数2・掛け持ち可(同時に2本)
    const one = scheduleOrders(base, { nowMs: NOW, capacity: { 2385: effUnits({ units: 2, people: 1, multi: false }).machine } }).orders;   // 掛け持ち不可 → 1本ずつ
    assert.equal(two[1].stages[0].planStartTime, two[0].stages[0].planStartTime);
    assert.notEqual(one[1].stages[0].planStartTime, one[0].stages[0].planStartTime);
});
