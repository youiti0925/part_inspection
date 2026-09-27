// Phase A 受入テスト A08〜A12・A15 (時間区間の集合演算)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeIntervals, intersectIntervals, subtractIntervals, durationMs } from '../timeIntervals.js';

const M = 60000; // 1分
const iv = (a, b) => ({ start: a * M, end: b * M });
const min = (ms) => ms / M;

test('A08 手動区間重複: 同じ30分に手動A/Bが重なっても30分 (60分に水増ししない)', () => {
  const manual = [iv(0, 30), iv(0, 30)];
  assert.equal(min(durationMs(manual)), 30);
  const auto = [iv(0, 60)];
  assert.equal(min(durationMs(intersectIntervals(auto, manual))), 30); // 50%であって100%ではない
});

test('A09 自動区間重複: 自動区間同士の重なりを二重計上しない', () => {
  assert.equal(min(durationMs([iv(0, 60), iv(30, 90)])), 90);
});

test('A10 監視区間: 監視を自動時間へ足さず、活用可能時間から引く', () => {
  const auto = [iv(0, 60)];
  const monitoring = [iv(0, 10)];
  const evaluable = subtractIntervals(auto, monitoring);
  assert.equal(min(durationMs(evaluable)), 50); // 60に足して70にしない
});

test('A11 監視重複: 同じ監視区間を複数登録しても拘束時間を二重計上しない', () => {
  const auto = [iv(0, 60)];
  const monitoring = [iv(0, 10), iv(0, 10), iv(5, 10)];
  assert.equal(min(durationMs(subtractIntervals(auto, monitoring))), 50);
});

test('A12 分母0: 活用可能時間が0なら 0% ではなく null (評価対象なし)', () => {
  const evaluable = subtractIntervals([iv(0, 30)], [iv(0, 30)]);
  const evaluableMs = durationMs(evaluable);
  assert.equal(evaluableMs, 0);
  const rate = evaluableMs > 0 ? durationMs([]) / evaluableMs : null;
  assert.equal(rate, null);
});

test('A15 セッション中断: 2分作業→3分停止→4分再開 は 6分 (25分にしない)', () => {
  const sessions = [iv(0, 2), iv(5, 9)];
  assert.equal(min(durationMs(sessions)), 6);
  // firstStartTime〜endTime の単純差だと 9分になってしまう
  assert.notEqual(min(durationMs([iv(0, 9)])), 6);
});

test('subtractIntervals: 部分重なり・完全内包・境界接触', () => {
  assert.deepEqual(subtractIntervals([iv(0, 60)], [iv(20, 30)]).map(x => [min(x.start), min(x.end)]), [[0, 20], [30, 60]]);
  assert.deepEqual(subtractIntervals([iv(0, 60)], [iv(0, 60)]), []);
  assert.deepEqual(subtractIntervals([iv(0, 60)], [iv(60, 90)]).map(x => [min(x.start), min(x.end)]), [[0, 60]]);
  assert.deepEqual(subtractIntervals([iv(0, 10), iv(20, 30)], [iv(5, 25)]).map(x => [min(x.start), min(x.end)]), [[0, 5], [25, 30]]);
});

test('intersectIntervals: 複数区間同士の交差', () => {
  const r = intersectIntervals([iv(0, 30), iv(60, 90)], [iv(20, 70)]);
  assert.deepEqual(r.map(x => [min(x.start), min(x.end)]), [[20, 30], [60, 70]]);
});

test('無効な区間(end<=start・NaN・null)は捨てる', () => {
  assert.deepEqual(mergeIntervals([iv(10, 10), { start: NaN, end: 5 }, null, iv(0, 5)]).map(x => [min(x.start), min(x.end)]), [[0, 5]]);
  assert.equal(durationMs(null), 0);
});

test('A03相当(区間側): 一括5台10分は機械の壁時計10分 (50分にしない)', () => {
  const machineRun = [iv(0, 10)];               // 5台まとめて1回の運転
  const perUnitBaked = Array.from({ length: 5 }, () => iv(0, 10)); // 各台に同じ開始終了が焼かれた旧データ
  assert.equal(min(durationMs(machineRun)), 10);
  assert.equal(min(durationMs(perUnitBaked)), 10); // 和集合なので50分にならない
});
