// 誰が検査をするか(割付): 着いた物から リミットの早い順に・一番早く手が空く人へ・重ならない・着く前に始めない・手が空く理由
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrders } from '../sapProgress.js';
import { arrivalForecast } from '../sapArrivalForecast.js';
import { allocate, place, nextWorkT, windowsOf, WORK, ASSUMED_MIN } from '../sapInspectAlloc.js';

const DOW_WED = 3;   // 今日 = 水曜
const row = (o, extra = {}) => ({ o, it: 'X' + o, tx: 'ひん' + o, q: 1, kind: 'bar', arrive: 0, limit: null, ship: null, late: null, ih: 1, ...extra });

test('AL01 勤務の窓: 8:30〜17:15・昼 45 分・15 時 15 分・土日は休み・仕事は窓をまたいで続く', () => {
    assert.equal(windowsOf(DOW_WED, 0).length, 3);
    assert.deepEqual(windowsOf(DOW_WED, 3), []);   // 土曜
    assert.equal(WORK.end - WORK.start - 45 - 15, 465);
    const p = place(DOW_WED, WORK.start, 300);      // 5h: 8:30〜12:00(210分)+ 12:45〜14:15(90分)
    assert.deepEqual(p, [[510, 720], [765, 855]]);
    assert.equal(nextWorkT(DOW_WED, 3 * 1440 + 100), 5 * 1440 + WORK.start);   // 土曜の朝 → 次の月曜 8:30
});

test('AL02 リミットの早い順・一番早く手が空く人へ・同じ人の仕事は重ならない・着く前に始めない', () => {
    const rows = [row('A', { arrive: 0, limit: 5, ih: 3 }), row('B', { arrive: 0, limit: 2, ih: 2 }), row('C', { arrive: 1, limit: 9, ih: 1 }), row('D', { arrive: 0, limit: 3, ih: 4 })];
    const r = allocate({ rows, inspectors: ['佐藤', '鈴木'], dow0: DOW_WED, horizonDays: 10 });
    assert.equal(r.jobs.length, 4);
    const first = r.jobs.filter((j) => j.seq === 1).map((j) => j.o).sort();
    assert.deepEqual(first, ['B', 'D']);   // 一番リミットの早い B(2)・D(3)を 2 人が先に始める
    for (const w of ['佐藤', '鈴木']) { const p = r.jobs.filter((j) => j.who === w).flatMap((j) => j.pieces).sort((a, b) => a[0] - b[0]); for (let i = 1; i < p.length; i++) assert.ok(p[i][0] >= p[i - 1][1], '重なり'); }
    assert.ok(r.jobs.every((j) => j.t0 >= j.ready), '着く前に始めている');
    assert.ok(r.jobs.find((j) => j.o === 'C').t0 >= 1 * 1440 + WORK.start);   // 着くのは明日の朝
});

test('AL03 リミットを越えて終わる物は overDays(日数)・検査の時間が無い指図は 仮に 60 分', () => {
    const r = allocate({ rows: [row('A', { limit: 0, ih: 12 }), row('B', { ih: null })], inspectors: ['佐藤'], dow0: DOW_WED, horizonDays: 10 });
    const a = r.jobs.find((j) => j.o === 'A'), b = r.jobs.find((j) => j.o === 'B');
    assert.ok(a.overDays >= 1); assert.equal(b.assumed, true); assert.equal(b.dur, ASSUMED_MIN);
});

test('AL04 手が空く時間とその理由: 次の物がまだ着いていない=arrival(次に着く日)・もう物が無い=nojob・止まり/日付なしは割り付けず件数だけ', () => {
    const rows = [row('A', { arrive: 0, ih: 1 }), row('B', { arrive: 2, ih: 1 }), row('S', { kind: 'stuck' }), row('U', { kind: 'unknown' })];
    const r = allocate({ rows, inspectors: ['佐藤'], dow0: DOW_WED, horizonDays: 5 });
    assert.deepEqual(r.skipped, { stuck: 1, unknown: 1, far: 0 });
    assert.equal(r.jobs.length, 2);
    const g = r.gaps.find((x) => x.kind === 'arrival'); assert.ok(g && g.nextReady === 2 && g.min >= 15);
    assert.ok(r.gaps.some((x) => x.kind === 'nojob'));
});

test('AL05 実データの形(いつ来るか → 割付): 日付の出た指図だけ割り付く・検査の時間は 標準値3 × 数量', () => {
    const D = (iso) => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000) + 25569;
    const orders = buildOrders([
        { A: '1', B: '0010', C: '2385', D: '平面研削:a', J: 1, U: 'X', V: 'x', F: 3, H: D('2026-11-16'), I: D('2026-11-16') },
        { A: '1', B: '0090', C: '2509', D: '三次元検査:a', J: 0, N: 0.5, U: 'X', V: 'x', F: 3, R: D('2026-11-30') },
        { A: '2', B: '0010', C: '2385', D: '平面研削:a', J: 1, U: 'Y', V: 'y', F: 1, H: D('2026-11-01'), I: D('2026-11-01') },
        { A: '2', B: '0020', C: '2325', D: 'ﾌﾗｲｽ:a', J: 1, U: 'Y', V: 'y', F: 1 },
        { A: '2', B: '0090', C: '2509', D: '三次元検査:a', J: 0, N: 1, U: 'Y', V: 'y', F: 1, R: D('2026-11-30') },
    ]);
    const f = arrivalForecast(orders, { todayIso: '2026-11-18' });
    assert.equal(f.rows.find((r) => r.o === '1').ih, 1.5);   // 0.5 × 数量 3
    const r = allocate({ rows: f.rows, inspectors: ['佐藤'], dow0: 3, horizonDays: 45 });
    assert.deepEqual(r.jobs.map((j) => j.o), ['1']);          // 2 は止まっている → 割り付けない
    assert.equal(r.skipped.stuck, 1);
});
