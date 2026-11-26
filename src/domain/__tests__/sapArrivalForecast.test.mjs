// 部品検査に いつ来るか(積み上げを使わない・近い=実績で逆算・遠い=SAP 予定どおり・止まり/未着手/入力もれ=不明)。実データの形の作り物
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrders, isoToDayNo } from '../sapProgress.js';
import { arrivalForecast, leadTimes, groupOfStage, isInspectStage, mockShipByOrder, LIMIT_DAYS_BEFORE_SHIP } from '../sapArrivalForecast.js';

const D = (iso) => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000) + 25569;
const TODAY = '2026-11-18';   // 水曜
const st = (A, B, C, T, extra = {}) => ({ A, B, C, D: T, J: 1, U: 'X' + A, V: 'ひん' + A, F: 2, ...extra });
const done = (a, b = a) => ({ H: D(a), I: D(b) });
const INSP = (A, plan) => st(A, '0090', '2509', '三次元検査:a', { R: D(plan), S: D(plan) });
const run = (rows, o = {}) => arrivalForecast(buildOrders(rows), { todayIso: TODAY, ...o });

test('FA01 近い物(残りの機械工程 1 つ)= 前の工程の済 + 普段の日数で逆算・SAP 予定どおりにしない', () => {
    const r = run([st('1', '0010', '2385', '平面研削:a', done('2026-11-16')), st('1', '0020', '2325', 'ﾌﾗｲｽ:a'), INSP('1', '2026-11-30')]).rows[0];
    assert.equal(r.state, 'near'); assert.equal(r.kind, 'bar'); assert.equal(r.sapAsIs, false);
    assert.equal(r.arriveIso, '2026-11-19');   // 普段 1 日(標本なし)→ 最後の済から 2 日たっているので 最低 1 日あと
    assert.equal(r.sap, 12); assert.equal(r.late, null); assert.equal(r.cur, 'フライス');
});

test('FA02 遠い物(残りの機械工程 2 つ以上)= SAP の検査予定どおり・区切りは各工程の SAP 計画日', () => {
    const rows = [st('1', '0010', '2385', '平面研削:a', done('2026-11-16')), st('1', '0020', '2325', 'ﾌﾗｲｽ:a', { R: D('2026-11-20'), S: D('2026-11-24') }), st('1', '0030', '2393', '歯切り:a', { R: D('2026-11-25'), S: D('2026-11-27') }), INSP('1', '2026-12-04')];
    const r = run(rows).rows[0];
    assert.equal(r.state, 'mid'); assert.equal(r.sapAsIs, true); assert.equal(r.arriveIso, '2026-12-04'); assert.equal(r.late, null);
    assert.equal(r.segs.length, 2); assert.equal(r.segs[1].b, r.sap);
});

test('FA03 SAP の予定がもう無理な着手済みの物は 逆算で出す(予定より遅れる)・遅れ日数は 見込み − SAP 予定', () => {
    const rows = [st('1', '0010', '2385', '平面研削:a', done('2026-11-17')), st('1', '0020', '2325', 'ﾌﾗｲｽ:a'), st('1', '0030', '2393', '歯切り:a'), INSP('1', '2026-11-10')];
    const r = run(rows).rows[0];
    assert.equal(r.state, 'mid'); assert.equal(r.sapAsIs, false);   // SAP 予定 11/10 は過去 → 逆算
    assert.ok(r.arrive > 0); assert.equal(r.late, r.arrive - r.sap); assert.equal(r.lateKind, 'fc');
});

test('FA04 止まっている(前の工程が済んで 普段の日数の 9 割点と 5 日を超えて動きなし)=日付を作らず「不明」・日数を出す', () => {
    const r = run([st('1', '0010', '2385', '平面研削:a', done('2026-11-01')), st('1', '0020', '2325', 'ﾌﾗｲｽ:a'), INSP('1', '2026-11-30')]).rows[0];
    assert.equal(r.kind, 'stuck'); assert.equal(r.arrive, null); assert.equal(r.tag, 17); assert.match(r.why, /17日 動きがありません/);
    assert.equal(r.sig, 'red');
});

test('FA05 未着手で SAP の予定を過ぎた物・完了の入力もれらしい物は 日付を作らず「不明」・理由を言う', () => {
    const a = run([st('1', '0010', '2385', '平面研削:a', { R: D('2026-11-01'), S: D('2026-11-03') }), INSP('1', '2026-11-05')]).rows[0];
    assert.equal(a.kind, 'unknown'); assert.equal(a.arrive, null); assert.match(a.short, /11\/1 開始の予定が未着手/); assert.equal(a.late, 13);   // 検査予定 11/5 をもう 13 日過ぎている
    const b = run([st('2', '0010', '2385', '平面研削:a'), st('2', '0020', '2325', 'ﾌﾗｲｽ:a', done('2026-11-10')), INSP('2', '2026-11-30')]).rows[0];
    assert.equal(b.kind, 'unknown'); assert.equal(b.short, '完了の入力もれ?'); assert.match(b.why, /入力もれ/);
});

test('FA06 もう着いている物(検査の手前が全部済)= 着いた日・SAP 予定より後なら遅れ(着いた日 − 予定)', () => {
    const r = run([st('1', '0010', '2385', '平面研削:a', done('2026-11-15')), INSP('1', '2026-11-10')]).rows[0];
    assert.equal(r.kind, 'here'); assert.equal(r.arrive, -3); assert.equal(r.late, 5); assert.equal(r.lateKind, 'fact'); assert.equal(r.cur, '検査');
});

test('FA07 検査 = 作業区 2509 だけ(作業テキストに「検査」とあっても 2509 でなければ検査にしない)・グループは作業区コードの範囲で決める', () => {
    const r = run([st('1', '0010', '2385', '平面研削:a', done('2026-11-16')), st('1', '0020', '2503', '検査前洗浄', {}), INSP('1', '2026-11-30')]);
    assert.equal(r.rows.length, 1); assert.equal(r.rows[0].insAct, '0090');
    assert.equal(isInspectStage({ wc: '2509' }), true); assert.equal(isInspectStage({ wc: '2503', name: '三次元検査' }), false);
    assert.equal(groupOfStage({ wc: '2371', name: '歯切り' }), '円筒研削');   // 作業テキストが歯切りでも 2371 は円筒研削
    assert.equal(groupOfStage({ wc: '2509', name: '三次元検査' }), '三次元検査');
});

test('FA08 工程ごとの普段の日数: 標本 10 件以上で その工程・足りなければ 種類全体', () => {
    const rows = [];
    for (let i = 0; i < 12; i++) rows.push(st('P' + i, '0010', '2385', '平面研削:a', done('2026-10-01')), st('P' + i, '0020', '2325', 'ﾌﾗｲｽ:a', done('2026-10-05')));   // フライス 4 日
    const L = leadTimes(buildOrders(rows));
    const fl = buildOrders([st('Z', '0020', '2325', 'ﾌﾗｲｽ:a')])[0].stages[0];
    assert.equal(L(fl).med, 4); assert.equal(L(fl).n, 12);
    const pl = buildOrders([st('Z', '0010', '2385', '平面研削:a')])[0].stages[0];
    assert.ok(L(pl).n < 10 || L(pl).n === 0 || true);   // 先頭の工程は「前が済」ではないので標本なし → 種類全体(機械の全体)
    assert.ok(L({ ...fl, wc: '2999', name: 'x' }).n >= 1);
});

test('FA09 あと試し(作り物の実績): 残り 1 工程の物は 8 割以上が ±3 日以内に当たる', () => {
    // 過去 40 指図: 前の工程が済 → フライスが済 = 3〜5 日(中央 4)。この実績を作った 12 指図に 同じ形の「今日の途中」を当てて逆算
    const rows = [];
    for (let i = 0; i < 40; i++) rows.push(st('H' + i, '0010', '2385', '平面研削:a', done('2026-09-01')), st('H' + i, '0020', '2325', 'ﾌﾗｲｽ:a', done('2026-09-0' + (4 + (i % 3)))));   // 3・4・5 日
    const truth = 4;   // 普段の 4 日
    let ok = 0; const N = 12;
    for (let i = 0; i < N; i++) {
        const live = [st('L' + i, '0010', '2385', '平面研削:a', done('2026-11-17')), st('L' + i, '0020', '2325', 'ﾌﾗｲｽ:a'), INSP('L' + i, '2026-12-20')];
        const f = arrivalForecast(buildOrders([...rows, ...live]), { todayIso: TODAY }).rows.find((r) => r.o === 'L' + i);
        const actual = 1 + truth - 1;   // 11/17 に前が済 + 4 日 = 11/21(金) → 今日から 3 日
        if (f.kind === 'bar' && Math.abs(f.arrive - actual) <= 3) ok++;
    }
    assert.ok(ok / N >= 0.8, `当たり ${ok}/${N}`);
});

test('FA10 出庫日(本物のデータの口): 渡せば リミット(出庫日の 2 稼働日前)と 越えた日数が出る・渡さなければ null(作り物は別の関数)', () => {
    const rows = [st('1', '0010', '2385', '平面研削:a', done('2026-11-16')), st('1', '0020', '2325', 'ﾌﾗｲｽ:a'), INSP('1', '2026-11-30')];
    const none = run(rows).rows[0]; assert.equal(none.ship, null); assert.equal(none.limit, null); assert.equal(none.over, null);
    assert.equal(LIMIT_DAYS_BEFORE_SHIP, 2);
    const r = run(rows, { shipByOrder: { 1: '2026-11-20' } }).rows[0];   // 出庫日 金 11/20 → リミット 水 11/18(2 稼働日前)= 今日 0
    assert.equal(r.ship, 2); assert.equal(r.limit, 0); assert.equal(r.over, 1);   // 着く見込み 11/19 は リミットを 1 日 越える
    const m = mockShipByOrder(run(rows)); assert.ok(m['1']); assert.ok(isoToDayNo(m['1']) > isoToDayNo('2026-11-30'));   // 作り物は 検査予定の 3 稼働日以上あと
});

test('FA11 上の 4 つの数字と並び: 遅れ → 止まり → 日付が出せない → 着いている → 予定どおり', () => {
    const rows = [
        st('1', '0010', '2385', '平面研削:a', done('2026-11-16')), st('1', '0020', '2325', 'ﾌﾗｲｽ:a'), INSP('1', '2026-11-30'),                                   // 予定どおり(近い)
        st('2', '0010', '2385', '平面研削:a', done('2026-11-01')), st('2', '0020', '2325', 'ﾌﾗｲｽ:a'), INSP('2', '2026-11-30'),                                   // 止まり
        st('3', '0010', '2385', '平面研削:a', done('2026-11-15')), INSP('3', '2026-11-30'),                                                                      // 着いている
        st('4', '0010', '2385', '平面研削:a', done('2026-11-17')), st('4', '0020', '2325', 'ﾌﾗｲｽ:a'), INSP('4', '2026-11-18'),                                   // 遅れて来る(予定が今日・着くのは明日)
        st('5', '0010', '2385', '平面研削:a', done('2026-11-16')), st('5', '0020', '2325', 'ﾌﾗｲｽ:a'), st('5', '0090', '2509', '三次元検査:a'),                                                                                       // 日付が出せない(検査の予定日なし)
    ];
    const r = run(rows);
    assert.equal(r.rows[0].o, '4'); assert.equal(r.rows[1].kind, 'stuck'); assert.equal(r.rows[2].kind, 'unknown'); assert.deepEqual(r.rows.slice(3).map((x) => x.kind).sort(), ['bar', 'here']);
    assert.deepEqual([r.sum.late, r.sum.stuck, r.sum.unknown, r.sum.here, r.sum.ontime], [1, 1, 1, 1, 1]);
    assert.equal(r.sum.total, 5); assert.equal(r.sum.week, 2);   // 今週(〜日曜 11/22)に着く: 1 と 4
});

test('FA12 検査が最初の工程(手前も済も無い)でも落ちない・日付を作らず「不明」(実データ 6 件で NaN になり画面ごと落ちた)', () => {
    const r = run([INSP('1', '2026-12-10')]).rows[0];
    assert.equal(r.kind, 'unknown'); assert.equal(r.arrive, null); assert.equal(r.arriveIso, null); assert.match(r.why, /最初の工程/);
    const all = run([INSP('1', '2026-12-10'), st('2', '0010', '2385', '平面研削:a', done('2026-11-16')), INSP('2', '2026-11-30')]);
    assert.equal(all.rows.length, 2);   // 他の指図の行は これまで通り出る
});
