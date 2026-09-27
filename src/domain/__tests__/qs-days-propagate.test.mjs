// 🧾➡📋 P109 品質規格の日数の波及: 規格を指す品目コードをまたいでまとめ、1ロットは1回だけ・手で登録したロットは動かさない
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planQsDaysChange } from '../qsDaysPropagate.js';

const lot = (id, model, extra = {}) => ({ id, orderNo: 'O' + id, model, templateId: 'T1', dueDate: '2026-10-20', entryAt: new Date(2026, 9, 16, 8, 30).getTime(), status: 'waiting', location: 'arrival', importedFromExcel: true, importSource: 'arrival-excel', ...extra });

test('Q1 同じ規格を指す品目コード2つのロットが両方1つの窓に入る・他の規格は入らない', () => {
  const lots = [lot('1', 'A'), lot('2', 'B'), lot('3', 'C')];
  const p = planQsDaysChange({ standardId: 'qs1', templateId: 'T1', before: { entryDaysBefore: 3 }, after: { entryDaysBefore: 5 }, lots,
    modelStandardMap: { A: 'qs1', B: 'qs1', C: 'qs2' }, calendar: null, defaultEntryDaysBefore: 3, entryHHMM: '08:30', defaultShipDaysBefore: 1 });
  assert.deepEqual(p.models.sort(), ['A', 'B']);
  const ids = [...p.updates, ...p.skipped].map(x => x.lotId).sort();
  assert.ok(!ids.includes('3'));
  assert.equal(new Set(ids).size, ids.length, '1ロットが二重に出ている');
  assert.equal(p.counts.updates, p.updates.length);
  assert.equal(p.updates.length, 2, '入荷の日数を変えたのに2件とも直す側に出ていない');
});

test('Q2 手で登録したロット(印なし)の納期は動かさない(K33 を変えても)', () => {
  const lots = [lot('1', 'A', { importedFromExcel: false, importSource: '' })];
  const p = planQsDaysChange({ standardId: 'qs1', templateId: 'T1', before: { daysBefore: 0 }, after: { daysBefore: -2 }, lots,
    modelStandardMap: { A: 'qs1' }, calendar: null, defaultEntryDaysBefore: 3, entryHHMM: '08:30', defaultShipDaysBefore: 1 });
  assert.equal(p.updates.filter(u => u.dueChange).length, 0);
});

test('Q3 規格を指す品目コードが無ければ何も出さない', () => {
  const p = planQsDaysChange({ standardId: 'qsX', templateId: 'T1', before: {}, after: { entryDaysBefore: 5 }, lots: [lot('1', 'A')], modelStandardMap: { A: 'qs1' } });
  assert.equal(p.updates.length + p.skipped.length, 0);
});
