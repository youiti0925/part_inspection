import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qualityGuardOf, canCloseEffective, sustainCheckDue, sustainVerdict, cardStageOf, SUSTAIN_DAYS } from '../effectiveGate.js';
import { computeVerdict } from '../verdictEngine.js';

const stat = (over = {}) => ({ n: 10, median: 100, mean: 100, sigma: 10, days: 90, ...over });
const okArgs = (over = {}) => ({
  verdict: computeVerdict(stat({ median: 100 }), stat({ median: 80 }), 'time'),
  before: stat({ median: 100 }), after: stat({ median: 80 }),
  quality: { passed: true }, action: '治具を変えた', owner: '山田', actionDate: 1000,
  ...over,
});

test('仕様#6: verdict=flat では effective にできない (5%未満の小改善の混入を遮断)', () => {
  const g = canCloseEffective(okArgs({ verdict: computeVerdict(stat({ median: 100 }), stat({ median: 97 }), 'time'), after: stat({ median: 97 }) }));
  assert.equal(g.ok, false);
  assert.ok(g.reasons.join().includes('自動判定'));
});

test('仕様#7: verdict=worse では effective にできない', () => {
  const g = canCloseEffective(okArgs({ verdict: computeVerdict(stat({ median: 100 }), stat({ median: 120 }), 'time'), after: stat({ median: 120 }) }));
  assert.equal(g.ok, false);
});

test('ベースライン標本不足(n<5)では、実施後が揃っていても effective にできない', () => {
  const g = canCloseEffective(okArgs({ before: stat({ n: 3 }) }));
  assert.equal(g.ok, false);
  assert.ok(g.reasons.join().includes('改善前の標本'));
});

test('仕様#8: 時間が改善しても不具合率が悪化したら品質ガードNG', () => {
  const q = qualityGuardOf({ beforeDefects: 1, beforeUnits: 100, afterDefects: 5, afterUnits: 100 });
  assert.equal(q.passed, false);
  const g = canCloseEffective(okArgs({ quality: q }));
  assert.equal(g.ok, false);
  assert.ok(g.reasons.join().includes('品質ガード'));
});

test('品質ガード: 機会不足なら unknown (確定は可能だが qualityUnknown フラグ)', () => {
  const q = qualityGuardOf({ beforeDefects: 0, beforeUnits: 5, afterDefects: 0, afterUnits: 5 });
  assert.equal(q.passed, 'unknown');
  const g = canCloseEffective(okArgs({ quality: q }));
  assert.equal(g.ok, true);
  assert.equal(g.qualityUnknown, true);
});

test('品質ガード: ベースライン0件→実施後発生は NG', () => {
  const q = qualityGuardOf({ beforeDefects: 0, beforeUnits: 50, afterDefects: 1, afterUnits: 50 });
  assert.equal(q.passed, false);
});

test('必須項目: 対策/担当/実施日が無いと effective にできない', () => {
  assert.equal(canCloseEffective(okArgs({ action: '' })).ok, false);
  assert.equal(canCloseEffective(okArgs({ owner: '' })).ok, false);
  assert.equal(canCloseEffective(okArgs({ actionDate: null })).ok, false);
});

test('全条件を満たせば effective にできる', () => {
  assert.equal(canCloseEffective(okArgs()).ok, true);
});

test('30日定着: 判定から30日経過で確認対象、確認済み/崩れは対象外', () => {
  const now = Date.now();
  const base = { status: 'effective', verdictFrozen: { afterVal: 80 }, closedAt: now - (SUSTAIN_DAYS + 1) * 86400000 };
  assert.equal(sustainCheckDue(base, now), true);
  assert.equal(sustainCheckDue({ ...base, closedAt: now - 5 * 86400000 }, now), false);
  assert.equal(sustainCheckDue({ ...base, verifiedStage: 'verified' }, now), false);
});

test('仕様#20: 定着確認で崩れていたら broken (確定から要再確認へ)', () => {
  assert.equal(sustainVerdict({ afterVal: 80, recentMedian: 100, recentN: 5 }).result, 'broken');
  assert.equal(sustainVerdict({ afterVal: 80, recentMedian: 82, recentN: 5 }).result, 'sustained');
  assert.equal(sustainVerdict({ afterVal: 80, recentMedian: 82, recentN: 1 }).result, 'unknown');
});

test('段階: effective直後は provisional(暫定)、verified だけが確定', () => {
  const c = { status: 'effective', verdictFrozen: { afterVal: 80 } };
  assert.equal(cardStageOf(c), 'provisional');
  assert.equal(cardStageOf({ ...c, verifiedStage: 'verified' }), 'verified');
  assert.equal(cardStageOf({ status: 'plan' }), null);
});
