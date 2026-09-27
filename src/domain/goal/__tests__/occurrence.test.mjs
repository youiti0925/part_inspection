import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAutoStep, annualOccurrencesOf, laborSecOf, machineSecOf } from '../occurrence.js';

test('自動工程判定: 「〜自動測定開始」「〜測定開始」「分割測定連携」は自動、普通の工程は手作業', () => {
  assert.equal(isAutoStep({ title: '分割自動測定開始' }), true);
  assert.equal(isAutoStep({ title: '三次元測定開始' }), true);
  assert.equal(isAutoStep({ title: '準備', rotaryLink: true }), true);
  assert.equal(isAutoStep({ title: '準備' }), false);
  assert.equal(isAutoStep({ title: '片付け' }), false);
});

test('仕様#3: 抜取1/10工程は 年間台数×1/10 回で計算される', () => {
  // 窓内: 100台対象のうち10回だけ実施(抜取) → 登録年間台数1000台なら年100回
  const r = annualOccurrencesOf({ useActual: true, inputAnnualUnits: 1000, windowExecs: 10, windowUnits: 100 });
  assert.equal(r.occ, 100);
  assert.equal(r.source, 'actual');
});

test('仕様#4: ロット1回工程は台数でなく実施率で計算される(5台ロット→台数の1/5回)', () => {
  // 窓内: 100台(20ロット)で20回実施 → 年1000台なら年200回 (1000回ではない)
  const r = annualOccurrencesOf({ useActual: true, inputAnnualUnits: 1000, windowExecs: 20, windowUnits: 100 });
  assert.equal(r.occ, 200);
});

test('毎台工程は従来どおり 年間台数≒年間回数', () => {
  const r = annualOccurrencesOf({ useActual: true, inputAnnualUnits: 500, windowExecs: 100, windowUnits: 100 });
  assert.equal(r.occ, 500);
});

test('年間台数が未登録なら実測回数の年換算(従来と同一)', () => {
  const r = annualOccurrencesOf({ useActual: false, measuredAnnualExecs: 321 });
  assert.equal(r.occ, 321);
  assert.equal(r.source, 'estimated');
});

test('窓内台数が0なら登録台数を使わず実測換算にフォールバック(0割り防止)', () => {
  const r = annualOccurrencesOf({ useActual: true, inputAnnualUnits: 1000, windowExecs: 0, windowUnits: 0, measuredAnnualExecs: 50 });
  assert.equal(r.occ, 50);
  assert.equal(r.source, 'estimated');
});

test('仕様#5: 自動工程は拘束率の分だけ人件費、機械時間は別集計', () => {
  assert.equal(laborSecOf({ workKind: 'auto', sec: 1000, autoLaborPct: 0 }), 0);      // 純自動=人件費ゼロ
  assert.equal(laborSecOf({ workKind: 'auto', sec: 1000, autoLaborPct: 30 }), 300);   // 拘束30%
  assert.equal(laborSecOf({ workKind: 'auto', sec: 1000, autoLaborPct: 100 }), 1000); // 既定=従来(上限)
  assert.equal(laborSecOf({ workKind: 'manual', sec: 1000, autoLaborPct: 0 }), 1000); // 手作業は影響なし
  assert.equal(machineSecOf({ workKind: 'auto', sec: 1000 }), 1000);
  assert.equal(machineSecOf({ workKind: 'manual', sec: 1000 }), 0);
});
