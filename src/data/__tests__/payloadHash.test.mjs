// 送る中身の指紋: 同じ中身なら同じ・違えば違う・キー順に振り回されない
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payloadHash, commandHash, stableString } from '../payloadHash.js';
import { DATA_DELETE, DATA_SERVER_NOW } from '../sentinels.js';

test('H01 キーの順番が違っても同じ指紋になる', () => {
  assert.equal(payloadHash({ a: 1, b: { x: 1, y: 2 } }), payloadHash({ b: { y: 2, x: 1 }, a: 1 }));
});

test('H02 中身が1文字でも違えば別の指紋になる', () => {
  assert.notEqual(payloadHash({ 台数: 5 }), payloadHash({ 台数: 6 }));
  assert.notEqual(payloadHash({ name: 'ロット' }), payloadHash({ name: 'ロツト' }));
});

test('H03 配列の順番は意味を持つので、並べ替えたら別物になる', () => {
  assert.notEqual(payloadHash({ steps: ['A', 'B'] }), payloadHash({ steps: ['B', 'A'] }));
});

test('H04 「消す印」と ただの文字列 を取り違えない', () => {
  assert.notEqual(payloadHash({ x: DATA_DELETE }), payloadHash({ x: 'delete' }));
  assert.notEqual(payloadHash({ x: DATA_DELETE }), payloadHash({ x: DATA_SERVER_NOW }));
});

test('H05 見た目が似ている値を取り違えない(0 と "0" と false と null)', () => {
  const hs = [0, '0', false, null, undefined].map((v) => payloadHash({ v }));
  assert.equal(new Set(hs).size, hs.length, 'すべて別の指紋');
});

test('H06 操作の種類が違えば別の指紋(save と setFields は結果が違う)', () => {
  const base = { ns: 'final-inspection-v1', col: 'settings', docId: 'config', patch: { skip: { on: false } } };
  assert.notEqual(commandHash({ ...base, op: 'save' }), commandHash({ ...base, op: 'setFields' }));
});

test('H07 baseRev は指紋に入れない(送り直しただけで別物に見えてはいけない)', () => {
  const base = { op: 'save', ns: 'a', col: 'b', docId: 'c', patch: { x: 1 } };
  assert.equal(commandHash({ ...base, opts: { baseRev: 3 } }), commandHash({ ...base, opts: { baseRev: 9 } }));
});

test('H08 別の書類なら別の指紋(取り違え防止)', () => {
  const base = { op: 'save', col: 'lots', patch: { x: 1 } };
  assert.notEqual(commandHash({ ...base, ns: 'final-inspection-v1', docId: 'L1' }),
    commandHash({ ...base, ns: 'product-inspection-v1', docId: 'L1' }));
  assert.notEqual(commandHash({ ...base, ns: 'a', docId: 'L1' }), commandHash({ ...base, ns: 'a', docId: 'L2' }));
});

test('H09 深い入れ子でもキー順に依存しない', () => {
  const a = { a: { b: { c: { d: [1, { e: 2, f: 3 }] } } } };
  const b = { a: { b: { c: { d: [1, { f: 3, e: 2 }] } } } };
  assert.equal(stableString(a), stableString(b));
  assert.equal(payloadHash(a), payloadHash(b));
});
