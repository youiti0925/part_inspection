import test from 'node:test';
import assert from 'node:assert/strict';
import { measured, workloadGeometry, evidenceGeometry } from '../workloadMeter.js';

test('欠損・文字でない値を実測0にしない', () => {
  for (const value of [null, undefined, '', '  ', true, false, [], {}, NaN, Infinity, -1]) assert.equal(measured(value), null);
  assert.equal(measured(0), 0);
  assert.equal(measured('12.5'), 12.5);
});
test('仕事と時間は同じ目盛で比べ、超過分だけ赤になる', () => {
  const g = workloadGeometry(150, 100);
  assert.equal(g.need, 100);
  assert.ok(Math.abs(g.capacity - 200 / 3) < 1e-10);
  assert.ok(Math.abs(g.excess - 100 / 3) < 1e-10);
  assert.equal(g.within, g.capacity);
  assert.equal(g.state, 'over');
});
test('時間が足りても納期内の判定を作らない', () => {
  assert.deepEqual(workloadGeometry(50,100), {need:50,capacity:100,within:50,excess:0,state:'within'});
});
test('時間の欠損を不足または余裕にしない', () => {
  for (const [a,b] of [[null,100],[100,null],[null,null]]) {
    const g = workloadGeometry(a,b);
    assert.equal(g.state,'unknown');
    assert.equal(g.excess,null);
  }
});
test('実測0は欠損と区別し、幅0を維持する', () => {
  assert.equal(workloadGeometry(0,0).capacity,0);
  assert.equal(workloadGeometry(20,0).excess,100);
  assert.equal(workloadGeometry(0,20).excess,0);
});
test('小数の実績を丸めて到達扱いにしない', () => {
  const g=evidenceGeometry(19.99,20);
  assert.equal(g.state,'pending');
  assert.ok(g.percent < 100);
});
test('実績欠損も条件欠損も未確認、条件0は到達ではない', () => {
  assert.equal(evidenceGeometry(null,20).state,'unknown');
  assert.equal(evidenceGeometry(20,null).state,'unknown');
  assert.deepEqual(evidenceGeometry(0,0), {state:'not-required',percent:null,current:0,target:0});
});
test('実測が条件に届いた時だけ到達、棒は100%を越えない', () => {
  assert.equal(evidenceGeometry(20,20).state,'reached');
  assert.equal(evidenceGeometry(30,20).percent,100);
  assert.equal(evidenceGeometry(0,20).state,'pending');
});
