// 部品検査に届く見込み: 遠い / 近い / MT なし / 実績あり の4通り(作り物の小さな行)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrders } from '../sapProgress.js';
import { scheduleOrders } from '../sapSchedule.js';
import { inspectForecast, medianActuals, NEAR_REMAINING_DEFAULT } from '../sapInspect.js';

const D = (iso) => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000) + 25569;
const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const NOW = at(2026, 11, 17, 8, 30);   // 火曜
const st = (A, B, C, T, J, extra = {}) => ({ A, B, C, D: T, J, U: 'ITEM1', V: 'x', F: 2, ...extra });
const run = (rows, opts = {}) => {
    const base = buildOrders(rows);
    const { orders } = scheduleOrders(base, { nowMs: NOW });
    return inspectForecast(base, orders, opts);
};
const INSP = (A, J, extra = {}) => st(A, '0040', '2509', '三次元検査:a', J, { R: D('2026-11-25'), S: D('2026-11-26'), ...extra });
const far3 = (A, J) => [st(A, '0010', '2385', '平面研削:a', 4), st(A, '0020', '2325', 'ﾌﾗｲｽ:a', 4), st(A, '0030', '2393', '歯切り:a', 4), INSP(A, J)];

test('SI01 遠い時: SAP の予定開始日どおり・所要は MT どおり・根拠は SAP 予定どおり', () => {
    const { rows } = run(far3('1', 2));
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.phase, 'far'); assert.equal(r.remaining, 3);
    assert.equal(r.startIso, '2026-11-25'); assert.equal(r.startBasis, 'sap');
    assert.equal(r.hours, 2); assert.equal(r.hoursBasis, 'MT');
    assert.equal(r.endIso, '2026-11-25'); assert.equal(r.diffDays, null);
});

test('SI02 近づいた時: 前工程の実績から積み上げ直した開始見込み・SAP 予定との差を出す', () => {
    // 手前の2つは済・直前の歯切りが作業中 → 近い。検査の SAP 予定は 11-17 だが、作業中の歯切り(4h)の後なので 11-17 午後
    const rows = [
        st('1', '0010', '2385', '平面研削:a', 4, { H: D('2026-11-10'), I: D('2026-11-11') }),
        st('1', '0020', '2325', 'ﾌﾗｲｽ:a', 4, { H: D('2026-11-12'), I: D('2026-11-13') }),
        st('1', '0030', '2393', '歯切り:a', 4, { H: D('2026-11-17') }),
        INSP('1', 1, { R: D('2026-11-12'), S: D('2026-11-13') }),
    ];
    const r = run(rows).rows[0];
    assert.equal(r.phase, 'near'); assert.equal(r.startBasis, 'sim');
    assert.ok(r.startIso >= '2026-11-17'); assert.ok(r.startTime);
    assert.ok(r.diffDays > 0);   // SAP の 11-12 より遅れる
    assert.equal(r.hoursBasis, 'MT');
});

test('SI03 しきい値: 残りが1つ以下なら近い・画面で変えられる(0 なら遠いまま)', () => {
    const rows = [st('1', '0010', '2385', '平面研削:a', 4, { H: D('2026-11-10'), I: D('2026-11-11') }), st('1', '0020', '2325', 'ﾌﾗｲｽ:a', 4), INSP('1', 1)];
    assert.equal(NEAR_REMAINING_DEFAULT, 1);
    assert.equal(run(rows).rows[0].phase, 'near');                      // 残り1(フライス未着手)
    assert.equal(run(rows, { nearRemaining: 0 }).rows[0].phase, 'far');
    assert.equal(run(rows, { nearRemaining: 0 }).rows[0].startBasis, 'sap');
});

test('SI04 MT なし: 所要は不明のまま・開始は出る・でっち上げない', () => {
    const { rows, counts } = run(far3('1', 0));
    assert.equal(rows[0].hours, null); assert.equal(rows[0].hoursBasis, 'unknown'); assert.equal(rows[0].endIso, null);
    assert.equal(rows[0].startIso, '2026-11-25');
    assert.equal(counts.noMt, 1); assert.equal(counts.unknownHours, 1); assert.equal(counts.withActual, 0);
});

test('SI05 MT なし+アプリの実績あり: 品目の中央値を所要にし件数を根拠に出す・別品目は使わない', () => {
    const actualsByItem = medianActuals([{ item: 'ITEM1', minutes: 30 }, { item: 'ITEM1', minutes: 90 }, { item: 'ITEM1', minutes: 60 }, { item: 'OTHER', minutes: 5 }, { item: 'ITEM1', minutes: 0 }, { item: 'ITEM1', minutes: 'x' }]);
    assert.deepEqual(actualsByItem.ITEM1, { n: 3, medianMin: 60 });
    const r = run(far3('1', 0), { actualsByItem }).rows[0];
    assert.equal(r.hours, 1); assert.equal(r.hoursBasis, 'actual'); assert.equal(r.actualN, 3);
    assert.ok(r.endIso);
    const other = run(far3('1', 0), { actualsByItem: { ZZZ: { n: 9, medianMin: 10 } } }).rows[0];
    assert.equal(other.hoursBasis, 'unknown');
    // MT がある時は MT が優先
    assert.equal(run(far3('1', 3), { actualsByItem }).rows[0].hoursBasis, 'MT');
});

test('SI06 検査が済の指図・検査工程の無い指図は出ない・SAP 予定日が無ければ開始は不明・届く順に並ぶ', () => {
    const rows = [
        ...far3('1', 1),
        st('2', '0010', '2385', '平面研削:a', 4),                                     // 検査なし
        st('3', '0010', '2385', '平面研削:a', 4, { H: D('2026-11-01'), I: D('2026-11-02') }), st('3', '0020', '2509', '三次元検査:a', 1, { H: D('2026-11-03'), I: D('2026-11-03') }),   // 検査済
        st('4', '0010', '2385', '平面研削:a', 4), st('4', '0015', '2325', 'ﾌﾗｲｽ:a', 4), st('4', '0020', '2509', '三次元検査:a', 1),   // 予定日なし(遠い)
        st('5', '0010', '2385', '平面研削:a', 4), st('5', '0015', '2325', 'ﾌﾗｲｽ:a', 4), st('5', '0020', '2509', '三次元検査:a', 1, { R: D('2026-11-20') }),
    ];
    const { rows: out, counts } = run(rows);
    assert.deepEqual(out.map((r) => r.order), ['5', '1', '4']);   // 11-20 → 11-25 → 予定なし(最後)
    assert.equal(counts.unknownStart, 1);
    assert.equal(out[2].startBasis, 'unknown');
});
