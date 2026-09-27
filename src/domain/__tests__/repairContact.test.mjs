import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldSkipReworkContact, buildRepairDraft } from '../repairContact.js';

test('P131 止める設定は既定 OFF', () => {
  assert.equal(shouldSkipReworkContact(null, '中間分割_傾斜', 'バックラッシュ大'), false);
  assert.equal(shouldSkipReworkContact({ enabled: true }, '中間分割_傾斜', 'バックラッシュ大'), true);
  assert.equal(shouldSkipReworkContact({ enabled: true }, '回転分割', 'バックラッシュ大'), false);
  assert.equal(shouldSkipReworkContact({ enabled: true }, '中間分割_傾斜', ''), false);
});

test('P131 下書きは 品目コード｜品名・工程・台・理由', () => {
  const d = buildRepairDraft({ taskKey: 's1-2', reason: '傷', steps: [{ id: 's1', title: '外観' }], itemLabel: 'A-100｜ブラケット' });
  assert.equal(d.kind, 'repair');
  assert.equal(d.unitLabel, '3台目');
  assert.equal(d.message, '【A-100｜ブラケット】外観 3台目：傷 の修正をお願いします');
  assert.deepEqual(d.chips, ['傷']);
  const e = buildRepairDraft({ taskKey: 's1-0', steps: [{ id: 's1', title: '外観' }], noteLabel: '全工程やり直し' });
  assert.equal(e.message, '【全工程やり直し】外観 1台目 の修正をお願いします');
});
