// 🗑 いらない区間を消す / 🖼 画像を挟む の段取り。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRemoveRanges, keepRangesOf, buildEditPlan, editPlanDuration } from '../videoPlan.js';

test('E01 消す区間: 重なりはまとめ、範囲外・逆順・ゴミは捨てる', () => {
  const r = mergeRemoveRanges(60, [
    { start: 10, end: 20 }, { start: 18, end: 25 },   // 重なり → 10-25
    { start: 50, end: 99 },                            // はみ出し → 50-60
    { start: 30, end: 30.01 },                         // 短すぎ → 捨てる
    null, { start: 'x', end: 5 },
  ]);
  assert.deepEqual(r, [{ start: 10, end: 25 }, { start: 50, end: 60 }]);
  assert.deepEqual(mergeRemoveRanges(Infinity, [{ start: 1, end: 2 }]), [], '長さ不明では作らない');
});

test('E02 残す区間 = 全体 − 消す区間', () => {
  assert.deepEqual(keepRangesOf(60, [{ start: 10, end: 25 }, { start: 50, end: 60 }]),
    [{ start: 0, end: 10 }, { start: 25, end: 50 }]);
  assert.deepEqual(keepRangesOf(60, []), [{ start: 0, end: 60 }], '何も消さなければ丸ごと');
  assert.deepEqual(keepRangesOf(60, [{ start: 0, end: 60 }]), [], '⚠全部消したら空(呼び出し側で止める)');
  assert.deepEqual(keepRangesOf(60, [{ start: 0, end: 10 }]), [{ start: 10, end: 60 }], '頭を落とす(トリム)');
});

test('E03 画像を挟む: 残った区間の途中なら、そこで割って挟む', () => {
  const img = { at: 30, durationSec: 4, image: 'IMG' };
  const plan = buildEditPlan(60, [], [img]);
  assert.deepEqual(plan.map(p => p.type), ['video', 'image', 'video']);
  assert.equal(plan[0].end, 30);
  assert.equal(plan[2].start, 30);
  assert.equal(plan[1].insert.image, 'IMG');
});

test('E04 ⚠消した区間の中に置いた画像も捨てない(消した所の説明に画像を使うのが本命)', () => {
  const plan = buildEditPlan(60, [{ start: 20, end: 40 }], [{ at: 30, durationSec: 5 }]);
  assert.deepEqual(plan.map(p => p.type), ['video', 'image', 'video']);
  assert.equal(plan[0].end, 20, '消えた切れ目に挟まる');
  assert.equal(plan[2].start, 40);
});

test('E05 先頭・末尾・複数の画像', () => {
  const plan = buildEditPlan(60, [], [
    { at: 0, durationSec: 3 }, { at: 60, durationSec: 3 }, { at: 15, durationSec: 3 },
  ]);
  assert.deepEqual(plan.map(p => p.type), ['image', 'video', 'image', 'video', 'image']);
  assert.equal(plan[1].start, 0); assert.equal(plan[1].end, 15);
  assert.equal(plan[3].start, 15); assert.equal(plan[3].end, 60);
});

test('E06 カットと画像の組み合わせ(現場の使い方そのもの)', () => {
  // 0-60秒。10-20の雑談を消し、40にPC画面の画像(6秒)を挟む
  const plan = buildEditPlan(60, [{ start: 10, end: 20 }], [{ at: 40, durationSec: 6 }]);
  assert.deepEqual(plan.map(p => p.type), ['video', 'video', 'image', 'video']);
  assert.deepEqual([plan[0].start, plan[0].end], [0, 10]);
  assert.deepEqual([plan[1].start, plan[1].end], [20, 40]);
  assert.deepEqual([plan[3].start, plan[3].end], [40, 60]);
  assert.equal(editPlanDuration(plan), 10 + 20 + 6 + 20);
});

test('E07 出来上がりの長さ。画像の秒数が変でも0.5秒未満にはしない', () => {
  assert.equal(editPlanDuration([{ type: 'image', insert: { durationSec: 0 } }]), 4, '未指定は4秒');
  assert.equal(editPlanDuration([{ type: 'image', insert: { durationSec: 0.1 } }]), 0.5, '短すぎる指定は最低0.5秒に丸める');
});
