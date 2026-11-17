// SAP 工程の一覧(納期の一覧と同じ作り): 品目ごとの行・工程ごとの行・工程の一覧・上の4枚(作り物の小さな行)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrders } from '../sapProgress.js';
import { scheduleOrders, queueTable } from '../sapSchedule.js';
import { orderRows, stageRows, laneSummary, boardStats, msOf } from '../sapBoard.js';
import { sortDueRows, DUE_SORT } from '../operationsSimulation/dueListOrder.js';
import { DUE_TIER } from '../operationsSimulation/dueRowFacts.js';

const D = (iso) => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000) + 25569;
const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const NOW = at(2026, 11, 17, 8, 30);
const st = (A, B, C, T, J, extra = {}) => ({ A, B, C, D: T, J, U: 'X' + A, V: 'ひん' + A, F: 3, ...extra });
const make = (rows) => { const base = buildOrders(rows); const s = scheduleOrders(base, { nowMs: NOW }); return { ...s, base }; };

// 指図 1: 平面研削(計画終了 11-20)→フライス(計画終了 11-17=今日の定時)→検査  ・指図 2: 平面研削だけ(計画終了が過去)
const rows = [
    st('1', '0010', '2385', '平面研削:a', 4, { S: D('2026-11-20') }), st('1', '0020', '2325', 'ﾌﾗｲｽ:a', 8, { S: D('2026-11-18') }), st('1', '0030', '2509', '三次元検査:a', 1, { S: D('2026-11-30') }),
    st('2', '0010', '2385', '平面研削:a', 4, { S: D('2026-11-10') }),
    st('3', '0010', '2385', '平面研削:a', 2, { H: D('2026-11-12'), I: D('2026-11-13'), S: D('2026-11-13') }), st('3', '0020', '2325', 'ﾌﾗｲｽ:a', 2, { S: D('2026-11-25') }),
];

test('SB01 品目ごとの行: 残りの工程を横に繋いだ棒・終了日時・計画終了(納期)・段', () => {
    const { orders } = make(rows);
    const r = orderRows(orders, { nowMs: NOW });
    const a = r.find((x) => x.orderNo === '1');
    assert.equal(a.curName, '平面研削'); assert.equal(a.nextName, 'フライス'); assert.equal(a.qty, 3);
    assert.equal(a.segs.length, 3);
    assert.ok(a.segs[0].endMs <= a.segs[1].startMs && a.segs[1].endMs <= a.segs[2].startMs);   // 前の工程が済んでから次
    assert.equal(a.finishMs, a.segs[2].endMs);
    assert.equal(a.dueMs, msOf('2026-11-30', null, '17:00'));   // 最後の工程の SAP 計画終了
    assert.equal(a.tier, DUE_TIER.OK); assert.equal(a.lateDays, null);
    const b = r.find((x) => x.orderNo === '2');
    assert.equal(b.tier, DUE_TIER.PAST); assert.ok(b.pastDays >= 7);   // 計画終了 11-10・今日 11-17
});

test('SB02 品目ごとの行: 済の工程は棒に入れない・全工程済と機械の無い指図は出ない', () => {
    const { orders } = make([...rows, st('9', '0010', '2509', '三次元検査:a', 1)]);
    const r = orderRows(orders, { nowMs: NOW });
    const c = r.find((x) => x.orderNo === '3');
    assert.equal(c.segs.length, 1); assert.equal(c.curName, 'フライス');   // 平面研削は済
    assert.equal(r.find((x) => x.orderNo === '9'), undefined);
});

test('SB03 遅れ: 見込み終了が計画終了を越えた日数(切り上げ)・並べ方は製品側の dueListOrder(遅れの大きい順)', () => {
    const late = [
        st('1', '0010', '2385', '平面研削:a', 8, { S: D('2026-11-17') }), st('2', '0010', '2385', '平面研削:a', 8, { S: D('2026-11-17') }), st('3', '0010', '2385', '平面研削:a', 8, { S: D('2026-11-30') }),
    ];
    const { orders } = make(late);
    const r = orderRows(orders, { nowMs: NOW });
    const byNo = Object.fromEntries(r.map((x) => [x.orderNo, x]));
    assert.equal(byNo['1'].lateDays, 1); assert.equal(byNo['1'].tier, DUE_TIER.LATE);
    assert.ok(byNo['2'].lateDays >= 1);   // 2本目は台が空かず待たされる→遅れが大きい
    assert.equal(byNo['3'].lateDays, null);
    const sorted = sortDueRows(r, DUE_SORT.LATE).map((x) => x.orderNo);
    assert.equal(sorted[sorted.length - 1], '3');
    assert.ok(byNo[sorted[0]].lateDays >= byNo[sorted[1]].lateDays);
});

test('SB04 工程ごとの行: その工程を済ませていない指図・待ち(前の工程が済んでから始まるまで)・今いる/待っている/これから来る', () => {
    const { orders } = make(rows);
    const f = stageRows(orders, 'フライス', { nowMs: NOW });
    assert.deepEqual(f.map((x) => x.orderNo).sort(), ['1', '3']);
    const o3 = f.find((x) => x.orderNo === '3'), o1 = f.find((x) => x.orderNo === '1');
    assert.equal(o3.where, 'waiting'); assert.equal(o3.prevLabel, '平面研削(2385)');   // 前が済んで待っている
    assert.equal(o1.where, 'next');                                                     // 前の工程(平面研削)がまだ
    assert.ok(o1.waitMs >= 0); assert.equal(o1.segs.length, 1);
    assert.equal(o1.finishMs, o1.seg.endMs);
    assert.equal(stageRows(orders, '歯切り', { nowMs: NOW }).length, 0);
});

test('SB05 工程の一覧: 待ち件数・待ちの標準時間÷台数=何日ぶん・台数を増やすと日数が減る・赤/黄', () => {
    const many = [];
    for (let i = 1; i <= 20; i++) many.push(st(String(i), '0010', '2385', '平面研削:a', 8, { S: D('2026-11-30') }));
    const { orders, waits } = make(many);
    const q = queueTable(waits, NOW, { days: 14 });
    const one = laneSummary(orders, { queue: q, capOf: () => 1 }).find((l) => l.name === '平面研削');
    assert.equal(one.wait, 20); assert.equal(one.waitH, 160); assert.equal(one.dai, 1);
    assert.equal(one.backlogDays, Math.round(160 / 7.75 * 10) / 10); assert.equal(one.heat, 3);
    assert.equal(one.spark.length, 14); assert.ok(one.spark[0] > 0);
    const four = laneSummary(orders, { queue: q, capOf: () => 4 }).find((l) => l.name === '平面研削');
    assert.equal(four.dai, 4); assert.equal(four.heat, 2);   // 160h ÷ 4台 ÷ 7.75 = 5.2日ぶん → 黄
    assert.ok(four.backlogDays < one.backlogDays);
});

test('SB06 上の4枚: 一番溜まっている工程・最初に台数を超える所・遅れる指図数・計画終了日を過ぎた件数', () => {
    const { orders, origins } = make(rows);
    const r = orderRows(orders, { nowMs: NOW });
    const lanes = laneSummary(orders, {});
    const s = boardStats(r, lanes, origins);
    assert.equal(s.open, r.length); assert.equal(s.pastNow, r.filter((x) => x.tier === DUE_TIER.PAST).length);
    assert.ok(s.top && s.top.name);
    assert.equal(s.late, r.filter((x) => x.lateDays != null).length);
});

test('SB07 積み上げの基準時刻 = 基準日の始業 08:30(実行した夜の時刻にしない)・1h の工程は 09:30 に終わる', async () => {
    const { baseNowMs } = await import('../sapBoard.js');
    assert.equal(baseNowMs('2026-11-17'), at(2026, 11, 17, 8, 30));
    const base = buildOrders([st('1', '0010', '2385', '平面研削:a', 1, { S: D('2026-11-17') })]);
    const s = scheduleOrders(base, { nowMs: baseNowMs('2026-11-17') });
    const r = orderRows(s.orders, { nowMs: baseNowMs('2026-11-17') })[0];
    assert.equal(r.finishMs, at(2026, 11, 17, 9, 30)); assert.equal(r.lateDays, null);
    // 夜の 22:58 を基準にすると 翌日以降へ送られる(今までの「全部 22:58 終」の元)
    const night = scheduleOrders(base, { nowMs: at(2026, 11, 17, 22, 58) });
    assert.ok(orderRows(night.orders, { nowMs: at(2026, 11, 17, 22, 58) })[0].finishMs > at(2026, 11, 17, 17, 0));
});
