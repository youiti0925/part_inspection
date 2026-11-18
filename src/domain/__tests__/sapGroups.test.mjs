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
    const cfg = () => ({ units: 2, people: 1, multi: true });
    const both = run(rows, { cfgOf: cfg, resource: 'both' }).groups[0];
    assert.equal(both.cells[0].worse, 'worker'); assert.equal(both.cells[0].level, 'red'); assert.equal(both.cells[0].slackW, -11);
    assert.equal(run(rows, { cfgOf: cfg, resource: 'machine' }).groups[0].cells[0].level, 'green');   // 機械だけ見れば足りる
    const w = run(rows, { cfgOf: cfg, resource: 'worker' }).groups[0];
    assert.equal(w.cells[0].level, 'red'); assert.equal(w.verdict.level, 'red'); assert.match(w.verdict.text, /あふれる週が 1 つ/);
});

test('SG04 作業区ごとに割る: 偏り(片方の作業区があふれ もう片方が余る)・グループ全体は足りる=「全体は足りるが偏り」', () => {
    const rows = [stage('1', '2385', 0, 40, 0), stage('2', '2386', 0, 5, 0)];   // 2385 に 40h(31h/台 → 129%)・2386 に 5h
    const g = run(rows).groups[0];
    assert.equal(g.wcs.length, 2);
    const w = Object.fromEntries(g.wcs.map((x) => [x.wc, x.cells[0].level]));
    assert.deepEqual(w, { 2385: 'red', 2386: 'green' });
    assert.equal(g.cells[0].level, 'green');   // 45h ÷ 62h = 73%
    assert.equal(g.redWcs, 1); assert.equal(g.verdict.level, 'green');   // 全体は足りるが 作業区 1 つがあふれる(行に「1 あふれ」)
});

test('SG05 グループの並び(悪い順)・上の要約(こなせない工程・偏りの工程・5週の赤の数)', () => {
    const rows = [stage('1', '2385', 0, 40, 0), st('2', '0010', '2371', '円筒研削:a', 0, { L: 5, R: D('2026-11-17'), S: D('2026-11-20') }), st('3', '0010', '2325', 'ﾌﾗｲｽ:a', 0, { L: 28, R: D('2026-11-17'), S: D('2026-11-20') })];
    const t = run(rows);
    assert.deepEqual(t.groups.map((g) => g.name), ['平面研削', 'フライス', '円筒研削']);   // あふれ(129%)→ 90% → 16%
    assert.deepEqual(t.summary.reds, ['平面研削']); assert.equal(t.weeks.length, 5);
    assert.equal(t.groups[0].cells[0].slack, -9);
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

// ── Fable の検証(11-18)の指示 ──
const WIN = { R: D('2026-11-17'), S: D('2026-11-20') };
test('SG08 持ち越し(計画の窓がもう過ぎた未完了)は 今週のマスに足さず 別の列(h・件・一番古い計画)', () => {
    const g = run([st('1', '0010', '2385', '平面研削:a', 0, { L: 20, R: D('2026-10-01'), S: D('2026-10-05') }), st('2', '0010', '2385', '平面研削:a', 0, { L: 10, ...WIN })]).groups[0];
    assert.equal(g.cells[0].demandM, 10);                          // 今週は今週の窓の分だけ
    assert.equal(g.carry, 20); assert.equal(g.carryN, 1); assert.equal(g.oldest, 47);   // 10/1 から 47 日
    assert.equal(g.wcs[0].carry, 20); assert.ok(g.carryDays > 2);
});

test('SG09 標準値2・3 は 既定=×数量(1個あたり)・段取りは 1ロット1回・掛けない に切り替えられる', () => {
    const rows = [st('1', '0010', '2385', '平面研削:a', 1, { L: 2, N: 1, F: 4, ...WIN })];
    assert.equal(run(rows).groups[0].cells[0].demandM, 9);   // 1 + 2×4
    assert.equal(run(rows, { perQty: false }).groups[0].cells[0].demandM, 3);
    assert.equal(run(rows, { resource: 'worker' }).groups[0].cells[0].demandW, 5);
});

test('SG10 グループは作業区コードで決まる・能力に数えるのは 未完了のある作業区だけ・検査と付帯作業は機械の表に入れない(付帯は数えていない時間に)', () => {
    const rows = [st('1', '0010', '2371', '歯切り:a', 0, { L: 5, ...WIN }),   // 作業テキストは歯切りでも 2371 は円筒研削
        st('2', '0010', '2372', '円筒研削:a', 0, { H: D('2026-11-01'), I: D('2026-11-02') }),   // 済だけの作業区 2372 は 能力に数えない
        st('3', '0010', '2509', '三次元検査:a', 0, { L: 5, N: 5, ...WIN }),
        st('4', '0010', '2503', '付帯作業:一時応援', 3, WIN)];
    const t = run(rows);
    assert.deepEqual(t.groups.map((g) => g.name), ['円筒研削']);   // 歯切りの作業区ではない・検査は無い
    assert.deepEqual(t.groups[0].wcs.map((x) => x.wc), ['2371']); assert.equal(t.groups[0].dai, 1);
    assert.equal(t.summary.uncounted.n, 1); assert.equal(t.summary.uncounted.h, 3);
});

test('SG11 薄い週: 今週〜2週後の 1日あたりの仕事量の最大の 8 割未満の週は 薄い(まだ計画が入っていない)', () => {
    const rows = [st('1', '0010', '2385', '平面研削:a', 0, { L: 31, ...WIN }), st('2', '0010', '2385', '平面研削:a', 0, { L: 40, R: D('2026-11-30'), S: D('2026-12-04') }), st('3', '0010', '2385', '平面研削:a', 0, { L: 4, R: D('2026-12-14'), S: D('2026-12-18') })];
    const w = run(rows).weeks;
    assert.equal(w[0].thin, false); assert.equal(w[2].thin, false); assert.equal(w[4].thin, true);   // 来週・2週後が 8h/日 前後・4週後は 0.8h/日
});

test('SG12 後ろが済で前が未(完了の入力もれらしい)は 必要量から外し 件数に数える', () => {
    const rows = [st('1', '0010', '2385', '平面研削:a', 0, { L: 20, ...WIN }), st('1', '0020', '2325', 'ﾌﾗｲｽ:a', 0, { H: D('2026-11-10'), I: D('2026-11-11') })];
    const t = run(rows);
    assert.equal(t.groups.length, 0); assert.equal(t.summary.suspect, 1);
});

test('SG13 窓が今日をまたぐ工程: 窓の稼働日へ均等に置き 今日より前の日の分は 持ち越し・今日以降の分だけ 今週のマスへ', () => {
    // 窓 11/16(月)〜11/19(木)の 4 稼働日・8h → 1日 2h。今日(火 11/17)より前は 月曜の 1 日分 = 2h が持ち越し・残り 6h が今週
    const g = run([st('1', '0010', '2385', '平面研削:a', 0, { L: 8, R: D('2026-11-16'), S: D('2026-11-19') })]).groups[0];
    assert.equal(g.cells[0].demandM, 6); assert.equal(g.carry, 2); assert.equal(g.carryN, 1);
});
