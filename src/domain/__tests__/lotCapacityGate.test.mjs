// 📦 1MBの関所の線引きを固定する。
// ⚠ここが緩むと「作業時間だけの保存」まで止まり、記録が消える(2026-08-17 の事故と同じ結果)。
// ⚠負の対照(止まらないといけない場面)も同じ数だけ置く。片側だけ試すと必ず嘘の合格になる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideCapacity, imageBytesOf, capacityBlockMessage } from '../lotCapacityGate.js';
import { approxBytes, mergeEstimate, DANGER_BYTES, DOC_LIMIT } from '../lotCapacity.js';

const photo = (kb) => 'data:image/jpeg;base64,' + 'A'.repeat(kb * 1024);

// 実測で作った「上限に迫った指図」。3枚×300KB で 約900KB(危険線の真上)。
const heavyLot = {
    id: 'lot-1', orderNo: '1001456630', status: 'processing',
    tasks: { 's1': { status: 'done', duration: 1200, firstStartTime: 1, endTime: 2 } },
    interruptions: [
        { id: 'i1', type: 'defect', photos: [photo(300)] },
        { id: 'i2', type: 'defect', photos: [photo(300)] },
        { id: 'i3', type: 'defect', photos: [photo(300)] },
    ],
};
// 画面(App.jsx)がやるのと同じ手順で判定する。ここがずれると試験の意味が無い。
const decideFor = (lot, patch) => {
    const merged = mergeEstimate(lot, patch);
    return decideCapacity(lot, merged, approxBytes(merged), DANGER_BYTES);
};

test('C00 前提: この指図は危険線を超えている(試験そのものが意味を持つことの確認)', () => {
    assert.ok(approxBytes(heavyLot) > DANGER_BYTES, `実測 ${approxBytes(heavyLot)} バイト`);
    assert.ok(approxBytes(heavyLot) < DOC_LIMIT, 'まだ上限には達していない(=保存はできる状態)');
});

test('C01 🚨🚨 作業時間だけの保存は **絶対に止めない**(止めると記録が消える)', () => {
    const patch = { tasks: { ...heavyLot.tasks, 's2': { status: 'done', duration: 900, firstStartTime: 3, endTime: 4 } }, status: 'processing' };
    const d = decideFor(heavyLot, patch);
    assert.equal(d.action, 'warn');
    assert.equal(d.reason, 'records-only-over-limit');
});

test('C02 完了にするだけの保存も止めない', () => {
    assert.equal(decideFor(heavyLot, { status: 'completed', completedAt: 99 }).action, 'warn');
});

test('C03 🚨 気づきを1件足すだけの保存も止めない（配列なので既存の写真を全部載せて送る）', () => {
    // ⚠ここが「payload に写真が入っているか」で判定すると止まってしまう場面。実測で外した。
    const patch = { interruptions: [...heavyLot.interruptions, { id: 'i4', type: 'notice', memo: '気づき' }] };
    const d = decideFor(heavyLot, patch);
    assert.equal(d.action, 'warn');
    assert.equal(d.imgAfter, d.imgBefore, '写真の量は1バイトも増えていない');
});

// ---- 負の対照: ここは止まらないといけない ----
test('C10 ⚠負の対照: 写真を1枚足す保存は止める', () => {
    const patch = { interruptions: [...heavyLot.interruptions, { id: 'i4', type: 'defect', photos: [photo(300)] }] };
    const d = decideFor(heavyLot, patch);
    assert.equal(d.action, 'block');
    assert.ok(d.imgAfter > d.imgBefore);
});

test('C11 ⚠負の対照: 写真を減らす保存は止めない(止めると容量を減らす手が無くなる)', () => {
    const patch = { interruptions: heavyLot.interruptions.slice(0, 2) };
    const d = decideFor(heavyLot, patch);
    assert.notEqual(d.action, 'block');
});

test('C12 ⚠負の対照: 軽い指図は写真を足しても止めない', () => {
    const light = { id: 'l2', tasks: { a: { duration: 10 } } };
    const patch = { interruptions: [{ id: 'x', type: 'defect', photos: [photo(300)] }] };
    assert.equal(decideFor(light, patch).action, 'ok');
});

test('C13 ⚠負の対照: 危険線を超えていなければ何も言わない', () => {
    assert.equal(decideCapacity({}, { a: 1 }, 2000, DANGER_BYTES).action, 'ok');
});

test('C14 ⚠負の対照: 上限を超えていて写真も増えるなら、記録が入っていても止める', () => {
    const patch = {
        tasks: { ...heavyLot.tasks, 's2': { status: 'done', duration: 5 } },
        interruptions: [...heavyLot.interruptions, { id: 'i4', type: 'defect', photos: [photo(300)] }],
    };
    assert.equal(decideFor(heavyLot, patch).action, 'block');
});

// ---- 写真のバイト数の数え方 ----
test('C20 写真は入れ子(配列の中のマップの中の配列)でも足す', () => {
    const p = photo(1);
    assert.equal(imageBytesOf({ interruptions: [{ photos: [p, p] }] }), p.length * 2);
    assert.equal(imageBytesOf({ tasks: { a: { aiAnalysis: { imageUrl: p } } } }), p.length);
});

test('C21 写真でない文字は数えない(誤検出で記録の保存を止めない)', () => {
    assert.equal(imageBytesOf({ memo: 'data:text/plain;base64,AAA', note: 'https://例' }), 0);
    assert.equal(imageBytesOf({ tasks: { a: { duration: 10, status: 'done' } } }), 0);
    assert.equal(imageBytesOf(null), 0);
});

test('C30 止めた時の文には「記録の保存は止めていない」と実数が入る', () => {
    const m = capacityBlockMessage(950_000, DOC_LIMIT);
    assert.ok(m.includes('作業時間の記録だけの保存は止めていません'), m);
    assert.ok(m.includes('928KB'), m); // 実数が出ている(「大きすぎます」だけでは判断できない)
});
