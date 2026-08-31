// ============================================================================
// 💾 「保存してから閉じてよいか」の試験
// ----------------------------------------------------------------------------
// 🚨 ここが狂うと 2026-08-17 が再現する:
//   拒否された保存で画面を閉じる = その記録はどこにも残らない(復旧できない)。
// ⚠ **わざと詰まらせた保存**(永久に返事が来ない約束)で画面が固まらない事も、
//   同じ重さで見る。固まる方に倒すと現場は使えなくなり、結局 別の逃げ道を探す。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  settleSaveBriefly, mayCloseAfterSave, SETTLE_MS, SAVE_REFUSED_MESSAGE,
} from '../settleSave.js';

test('S01 届いた保存は ok。閉じてよい', async () => {
  const r = await settleSaveBriefly(Promise.resolve('done'), 50);
  assert.equal(r, 'ok');
  assert.equal(mayCloseAfterSave(r), true);
});

test('S02 🚨 拒否された保存は error。**閉じてはいけない**', async () => {
  const r = await settleSaveBriefly(Promise.reject(new Error('permission-denied')), 50);
  assert.equal(r, 'error');
  assert.equal(mayCloseAfterSave(r), false, '🚨拒否された保存で閉じると記録が消える');
});

test('S03 🚨 わざと詰まらせた保存(永久に返事が来ない)は pending。画面は固まらない', async () => {
  const stuck = new Promise(() => { /* 永久に解決しない = 電波が無い時の Firestore */ });
  const t0 = Date.now();
  const r = await settleSaveBriefly(stuck, 30);
  const waited = Date.now() - t0;
  assert.equal(r, 'pending');
  assert.ok(waited < 3000, `待ちすぎ(${waited}ms)。現場では「固まった」に見える`);
  // 待ち行列には入っているので閉じてよい(帯・タブを閉じる時の警告・関所が見張る)
  assert.equal(mayCloseAfterSave(r), true);
});

test('S04 遅れて届いた保存も、待っている間に届けば ok', async () => {
  const slow = new Promise((res) => setTimeout(() => res('done'), 10));
  assert.equal(await settleSaveBriefly(slow, 200), 'ok');
});

test('S05 遅れて拒否された保存も、待っている間に分かれば error', async () => {
  const slowFail = new Promise((_, rej) => setTimeout(() => rej(new Error('x')), 10));
  assert.equal(await settleSaveBriefly(slowFail, 200), 'error');
  // ⚠ 待ち時間を過ぎてから拒否された場合は pending のまま。その時は帯が面倒を見る。
  const later = new Promise((_, rej) => setTimeout(() => rej(new Error('x')), 60));
  assert.equal(await settleSaveBriefly(later, 10), 'pending');
  later.catch(() => {});   // 誰も受け取らない拒否で試験を落とさない
});

test('S06 約束でない物が来たら ok(呼ぶ側の返し忘れで画面を永久に閉じなくしない)', async () => {
  assert.equal(await settleSaveBriefly(undefined, 10), 'ok');
  assert.equal(await settleSaveBriefly(null, 10), 'ok');
  assert.equal(await settleSaveBriefly(42, 10), 'ok');
});

test('S07 既定の待ち時間は 3秒(2026-08-17 の是正で決めた値)', () => {
  assert.equal(SETTLE_MS, 3000);
});

test('S08 人へ出す言葉に「次にどうするか」が入っている', () => {
  assert.ok(SAVE_REFUSED_MESSAGE.includes('閉じません'));
  assert.ok(SAVE_REFUSED_MESSAGE.includes('残っています'), '入力が残っている事を伝える');
  assert.ok(SAVE_REFUSED_MESSAGE.includes('もう一度'), '次にどうするかを書く');
});

// ---------------------------------------------------------------------------
// 🚨 この試験自身も、わざと壊して落ちるか見る
// ---------------------------------------------------------------------------
const failed = async (fn) => { try { await fn(); return false; } catch { return true; } };

test('S90 🚨 「拒否でも閉じてよい」に壊したら、この試験は落ちる', async () => {
  const broken = (result) => result !== 'nope';   // error でも true を返す = 壊れた判定
  assert.equal(
    await failed(async () => assert.equal(broken('error'), false)),
    true,
    '🚨 拒否で閉じる形に壊しても落ちなかった = この確認は何も見ていない'
  );
});

test('S91 🚨 「ずっと待つ」に壊したら、詰まりの確認は落ちる', async () => {
  const neverSettles = async (p) => p.then(() => 'ok', () => 'error');   // 打ち切りが無い版
  const stuck = new Promise(() => {});
  const raced = await Promise.race([
    neverSettles(stuck),
    new Promise((res) => setTimeout(() => res('固まったまま'), 30)),
  ]);
  assert.equal(raced, '固まったまま', '🚨 打ち切りを外しても返事が返ってきた = 確認が効いていない');
});
