// node --test で実行 (npm test)。verdictEngine の判定仕様を凍結するテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeVerdict, PDCA_MIN_N } from '../verdictEngine.js';

const stat = (over = {}) => ({ n: 10, median: 100, mean: 100, sigma: 10, startMs: 0, endMs: 90 * 86400000, days: 90, ...over });

test('時間KPI: 5%以上短縮で improved', () => {
  const v = computeVerdict(stat({ median: 100 }), stat({ median: 90 }), 'time');
  assert.equal(v.result, 'improved');
});

test('時間KPI: 5%未満の小改善は flat (確定に入れてはいけない値)', () => {
  const v = computeVerdict(stat({ median: 100 }), stat({ median: 97 }), 'time');
  assert.equal(v.result, 'flat');
});

test('時間KPI: 5%以上悪化で worse', () => {
  const v = computeVerdict(stat({ median: 100 }), stat({ median: 110 }), 'time');
  assert.equal(v.result, 'worse');
});

test('標本不足: 実施後がn<5なら insufficient', () => {
  const v = computeVerdict(stat(), stat({ n: PDCA_MIN_N - 1 }), 'time');
  assert.equal(v.result, 'insufficient');
});

test('標本不足: ベースラインがn<5でも insufficient (実施後だけ揃ってもダメ)', () => {
  const v = computeVerdict(stat({ n: 2 }), stat({ n: 20 }), 'time');
  assert.equal(v.result, 'insufficient');
});

test('不具合KPI: unitsSeen があれば検査台数分母で比較 (生産量が変わっても歪まない)', () => {
  // 前: 10件/100台=0.1  後: 12件/200台=0.06 → 台数分母なら improved (日数分母だと件数増で worse に見える)
  const b = stat({ defectCount: 10, unitsSeen: 100, days: 28 });
  const a = stat({ defectCount: 12, unitsSeen: 200, days: 28 });
  const v = computeVerdict(b, a, 'defectRate');
  assert.equal(v.denominator, 'units');
  assert.equal(v.result, 'improved');
});

test('不具合KPI: unitsSeen が無い旧データは日数分母にフォールバック', () => {
  const b = stat({ defectCount: 10, days: 90 });
  const a = stat({ defectCount: 1, days: 28 });
  const v = computeVerdict(b, a, 'defectRate');
  assert.equal(v.denominator, 'days');
  assert.equal(v.result, 'improved'); // 0.111/日 → 0.036/日
});

test('不具合KPI: ベースライン0件から増加は worse', () => {
  const v = computeVerdict(stat({ defectCount: 0, unitsSeen: 100 }), stat({ defectCount: 3, unitsSeen: 100 }), 'defectRate');
  assert.equal(v.result, 'worse');
});

test('達成率KPI: 大きいほど良い向きで判定', () => {
  const v = computeVerdict(stat({ achievementRate: 80 }), stat({ achievementRate: 90 }), 'achievement');
  assert.equal(v.result, 'improved');
});
