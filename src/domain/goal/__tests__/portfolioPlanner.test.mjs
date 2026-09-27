import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goalGapOf, gradeCandidate, candidateOf, planPortfolio } from '../portfolioPlanner.js';

test('仕様2: 必要削減時間=金額(100万/2800=357.14h)と10%の大きい方', () => {
  const g = goalGapOf({ moneyTargetYen: 1000000, chargePerHour: 2800, baselineAnnualLaborSec: 3000 * 3600, reductionPct: 10 });
  assert.ok(Math.abs(g.moneyRequiredHours - 357.14) < 0.01);
  assert.equal(g.timeRequiredHours, 300);
  assert.ok(Math.abs(g.requiredHours - 357.14) < 0.01);
});

test('確定済み時間を引いた残りが出る', () => {
  const g = goalGapOf({ moneyTargetYen: 1000000, chargePerHour: 2800, baselineAnnualLaborSec: 0, reductionPct: 10, verifiedFixedYen: 280000 });
  assert.equal(Math.round(g.fixedHours), 100);
  assert.ok(Math.abs(g.remainingHours - 257.14) < 0.01);
});

test('信頼度: A=登録台数+標本+較正済 / B=推定あり / C=標本少or目標なし', () => {
  assert.equal(gradeCandidate({ n: 20, annualUnitsSource: 'actual', hasTarget: true }).grade, 'A');
  assert.equal(gradeCandidate({ n: 20, annualUnitsSource: 'estimated', hasTarget: true }).grade, 'B');
  assert.equal(gradeCandidate({ n: 5, annualUnitsSource: 'actual', hasTarget: true }).grade, 'C');
  assert.equal(gradeCandidate({ n: 20, annualUnitsSource: 'actual', hasTarget: false }).grade, 'C');
  assert.equal(gradeCandidate({ n: 20, annualUnitsSource: 'actual', hasTarget: true, targetSuspect: true }).grade, 'C');
});

const cand = (key, hours, grade = 'B') => ({ key, saveHours: hours, expectedHours: hours * (grade === 'C' ? 0.35 : 0.6), grade, stepTitle: key });

test('組み合わせ: 必要計画在庫(残り÷成功率)に届くまで期待値順に選ぶ', () => {
  // 残り150h → 必要在庫 150/0.7≒214.3h。期待値: b=180, a=60, c=30 → b+a=240で充足、cは選ばれない
  const p = planPortfolio({ candidates: [cand('a', 100), cand('b', 300), cand('c', 50)], remainingHours: 150, successRatePct: 70 });
  assert.ok(Math.abs(p.pipelineRequiredHours - 150 / 0.7) < 0.01);
  assert.equal(p.picked[0].key, 'b'); // 期待値最大から
  assert.equal(p.picked.length, 2);
  assert.equal(p.sufficient, true);
});

test('仕様6-6/#17: 在庫が足りなければ不足を正直に返す(数字を作らない)', () => {
  const p = planPortfolio({ candidates: [cand('a', 50)], remainingHours: 210, successRatePct: 70 });
  assert.equal(p.sufficient, false);
  assert.ok(p.shortfallHours > 0);
});

test('仕様5.3: C評価は自動採用せず「要観測」枠へ', () => {
  const p = planPortfolio({ candidates: [cand('a', 500, 'C'), cand('b', 100)], remainingHours: 100 });
  assert.ok(!p.picked.some(c => c.key === 'a'));
  assert.equal(p.needsObservation[0].key, 'a');
});

test('仕様6-1/#14: 同じ場所の候補は二重計上しない・進行中カルテの場所は在庫から除外', () => {
  const p = planPortfolio({ candidates: [cand('a', 100), cand('a', 100), cand('x', 80)], remainingHours: 500, openKeys: new Set(['x']) });
  assert.equal(p.usableCount, 1);
});

test('candidateOf: ランキング行から期待値つき候補を作る', () => {
  const c = candidateOf({ model: 'M', templateId: 't1', stepKey: 'cat_準備', stepTitle: '準備', n: 20, annualUnitsSource: 'estimated', hasTarget: true, annualSaveSec: 7200, annualSaveYen: 5600 }, { appId: 'product' });
  assert.equal(c.grade, 'B');
  assert.equal(c.saveHours, 2);
  assert.ok(Math.abs(c.expectedHours - 1.2) < 1e-9);
});
