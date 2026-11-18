// SAP 見込み日時(作り物の小さな行で・勤務は既定 08:30-17:00 休憩あり・月〜金)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrders, gaugeOf } from '../sapProgress.js';
import { scheduleOrders, queueTable, hoursOf, hoursKey } from '../sapSchedule.js';

const D = (iso) => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000) + 25569;
const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const NOW = at(2026, 11, 17, 8, 30);   // 火曜 08:30
const stage = (A, B, C, D2, J, extra = {}) => ({ A, B, C, D: D2, J, U: 'X', V: 'x', F: 1, ...extra });

test('SS01 標準値の意味: 1=段取り・2=機械・3=作業者。機械の占有=段取り+機械(既定)・作業者=段取り+作業者・数量は 標準値2・3 だけに掛ける(切替・既定は掛けない)', () => {
    const s = { hJ: 1, hL: 2, hN: 0.5, qty: 3 };
    assert.equal(hoursOf(s), 3); assert.equal(hoursOf(s, 'machine'), 3); assert.equal(hoursOf(s, 'worker'), 1.5);
    assert.equal(hoursOf(s, 'J'), 1); assert.equal(hoursOf(s, 'L'), 2); assert.equal(hoursOf(s, 'N'), 0.5); assert.equal(hoursOf(s, 'sum'), 3.5);
    assert.equal(hoursOf(s, hoursKey('machine', false)), 3);
    assert.equal(hoursOf(s, hoursKey('machine', true)), 1 + 2 * 3);   // 段取りは1ロット1回・機械は ×数量
    assert.equal(hoursOf(s, hoursKey('worker', true)), 1 + 0.5 * 3);
});

test('SS01b 積み上げは 機械の占有時間(段取り+機械)で数える・作業者の時間(標準値3)では伸びない', () => {
    const rows = [stage('1', '0010', '2385', '平面研削：a', 1, { L: 1, N: 5 })];   // 段取り1h + 機械1h = 2h・作業者 5h は別
    const { orders: o } = scheduleOrders(buildOrders(rows), { nowMs: NOW });
    assert.deepEqual([o[0].stages[0].planStartTime, o[0].stages[0].planEndTime], ['08:30', '10:40']);   // 2h(10時休憩10分をまたぐ)
    const q = scheduleOrders(buildOrders([stage('1', '0010', '2385', '平面研削：a', 1, { L: 1, F: 3 })]), { nowMs: NOW, hoursMode: hoursKey('machine', true) }).orders[0].stages[0];
    assert.equal(q.planEndTime, '13:25');   // 1 + 1×3 = 4h(10時休憩・昼休憩をまたぐ)
});

test('SS02 1本の指図: 前の工程が終わると次が始まる・休憩を飛ばして時刻が出る', () => {
    // 平面研削 2h: 08:30 開始・10:00-10:10 の休憩をまたぐので 10:40 終了。次のフライス 1h は 10:40 開始
    const orders = buildOrders([stage('1', '0010', '2385', '平面研削：a', 2), stage('1', '0020', '2325', 'ﾌﾗｲｽ:a', 1)]);
    const { orders: o } = scheduleOrders(orders, { nowMs: NOW });
    const [a, b] = o[0].stages;
    assert.deepEqual([a.planStart, a.planStartTime, a.planEnd, a.planEndTime], ['2026-11-17', '08:30', '2026-11-17', '10:40']);
    assert.deepEqual([b.planStartTime, b.planEndTime], ['10:40', '11:40']);
    assert.equal(a.est, true);
});

test('SS03 1台(既定): 同じ作業区の2本は順番・2台にすると同時', () => {
    const rows = [stage('1', '0010', '2385', '平面研削：a', 2), stage('2', '0010', '2385', '平面研削：a', 2)];
    const one = scheduleOrders(buildOrders(rows), { nowMs: NOW }).orders;
    assert.equal(one[0].stages[0].planStartTime, '08:30'); assert.equal(one[1].stages[0].planStartTime, '10:40');
    const two = scheduleOrders(buildOrders(rows), { nowMs: NOW, capacity: { 2385: 2 } }).orders;
    assert.equal(two[1].stages[0].planStartTime, '08:30');
});

test('SS04 定時を過ぎる仕事は次の稼働日へ・金曜から月曜へ', () => {
    const fri = at(2026, 11, 20, 15, 30);   // 金曜 15:30 に 3h → 金曜は 15:30-17:00 の 1.5h だけ・残りは月曜
    const o = scheduleOrders(buildOrders([stage('1', '0010', '2385', '平面研削：a', 3)]), { nowMs: fri }).orders[0].stages[0];
    assert.equal(o.planEnd, '2026-11-23');
});

test('SS05 実績: 済は実績のまま・作業中は実績開始日から・未は今以降', () => {
    const rows = [
        stage('1', '0010', '2385', '平面研削：a', 2, { H: D('2026-11-10'), I: D('2026-11-11') }),
        stage('1', '0020', '2325', 'ﾌﾗｲｽ:a', 2, { H: D('2026-11-12') }),
        stage('1', '0030', '2393', '歯切り：a', 1),
    ];
    const s = scheduleOrders(buildOrders(rows), { nowMs: NOW }).orders[0].stages;
    assert.equal(s[0].est, undefined); assert.equal(s[0].actualEnd, '2026-11-11');
    assert.equal(s[1].actualStart, '2026-11-12'); assert.equal(s[1].estOverrun, true);   // 標準2hを過ぎてもまだ → あと30分と見込む
    assert.equal(s[1].planEndTime, '09:00');
    assert.equal(s[2].planStartTime, '09:00');
});

test('SS06 計画日(R)を使う: 計画開始日より前には始めない・遅れ = 見込み終了 − 計画終了', () => {
    const rows = [stage('1', '0010', '2385', '平面研削：a', 2, { R: D('2026-11-19'), S: D('2026-11-19') })];
    const o = scheduleOrders(buildOrders(rows), { nowMs: NOW }).orders[0].stages[0];
    assert.equal(o.planStart, '2026-11-19'); assert.equal(o.planStartTime, '08:30');
    assert.ok(o.delayMs < 0);   // 11-19 10:40 終了は 計画終了 11-19 17:00 より前
    const off = scheduleOrders(buildOrders(rows), { nowMs: NOW, usePlanStart: false }).orders[0].stages[0];
    assert.equal(off.planStart, '2026-11-17');
});

test('SS07 キャパオーバーの起点と波及: 台が空かず待たされた作業区・日・超えた時間・巻き込まれた指図', () => {
    // 2385 に 3本(各4h・計画終了は今日) → 2本目・3本目が待たされ計画を越える。後ろのフライスにも遅れが渡る
    const rows = [];
    for (const n of ['1', '2', '3']) {
        rows.push(stage(n, '0010', '2385', '平面研削：a', 4, { S: D('2026-11-17') }));
        rows.push(stage(n, '0020', '2325', 'ﾌﾗｲｽ:a', 1, { S: D('2026-11-17') }));
    }
    const { orders, origins } = scheduleOrders(buildOrders(rows), { nowMs: NOW });
    assert.equal(origins.length, 1);
    assert.equal(origins[0].wc, '2385'); assert.equal(origins[0].day, '2026-11-17');
    assert.equal(origins[0].overHours, 8);   // 待たされた2本 × 4h
    assert.equal(origins[0].orders, 2);      // 1本目は待たない・2本目と3本目が起点に連なる
    const g = gaugeOf(orders[1], '2026-11-17');
    assert.equal(g.segs[0].status, 'late'); assert.ok(g.segs[0].delayH > 0);
    assert.match(g.segs[1].origin, /平面研削\(2385\)/);   // 後ろの工程の遅れも同じ起点
});

test('SS08 仕掛かりの山: 作業区×日の待ち行列(数と標準時間)・解消する日', () => {
    const rows = [];
    for (const n of ['1', '2', '3', '4']) rows.push(stage(n, '0010', '2385', '平面研削：a', 8));   // 1台・各8h
    const { waits } = scheduleOrders(buildOrders(rows), { nowMs: NOW });
    const q = queueTable(waits, NOW, { days: 14 });
    const r = q.rows.find((x) => x.wc === '2385');
    assert.equal(q.days[0], '2026-11-17');
    assert.equal(r.per[0].n, 3);   // 11-17 の定時終わり: 1本目が作業中・3本が待ち
    assert.equal(r.peakN, 3); assert.equal(r.peakDay, '2026-11-17');
    assert.equal(r.startDay, '2026-11-17');
    assert.ok(r.clearDay && r.clearDay > r.peakDay);
});
