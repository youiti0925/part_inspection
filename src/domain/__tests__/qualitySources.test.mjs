import test from 'node:test';
import assert from 'node:assert/strict';
import { collectQualityRows, filterQuality, sourceBreakdown, sourceNote } from '../qualitySources.js';

const M = (y, m, d) => new Date(y, m - 1, d).getTime();

test('製品型: NG理由は独立した1件として数える(ngReportIdが無い)', () => {
  const lots = [{
    id: 'L1', model: 'A', orderNo: 'O1',
    steps: [{ id: 's1', title: '外観', category: '外観チェック' }],
    interruptions: [{ id: 'i1', type: 'complaint', label: 'キズ', timestamp: M(2026, 5, 10) }],
    tasks: { 's1-0': { status: 'completed', ngReason: '寸法外れ', ngAt: M(2026, 5, 11) } },
  }];
  const { rows, mergedNg } = collectQualityRows({ lots, ledger: [] });
  assert.equal(mergedNg, 0);
  const cur = filterQuality(rows, { kinds: ['complaint', 'improvement'], from: M(2026, 5, 1), to: M(2026, 6, 1) });
  assert.equal(cur.length, 2);
  assert.deepEqual(sourceBreakdown(cur), { interruption: 1, ng: 1, ledger: 0, sample: 0, total: 2 });
  assert.equal(cur.find(r => r.src === 'ng').stepTitle, '外観');
});

test('最終型: ngReportId のあるNG理由は不具合報告の写し → 二重に数えない', () => {
  const ledger = [{ id: 'F1', type: 'defect', label: '打痕', timestamp: M(2026, 5, 12), model: 'B', source: 'inspection-ng' }];
  const lots = [{
    id: 'L2', model: 'B', steps: [{ id: 's1', title: '塗装', category: 'タッチアップ後' }],
    tasks: { 's1-0': { status: 'ng', ngReason: '打痕', ngAt: M(2026, 5, 12), ngReportId: 'F1' } },
  }];
  const { rows, mergedNg } = collectQualityRows({ lots, ledger });
  assert.equal(mergedNg, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'defect');   // 不具合として1回だけ
  assert.match(sourceNote(rows, { mergedNg }), /二重に数えていません/);
});

test('最終型: ngReportId の無い古いNG理由は今まで通り軽微不良として残す(黙って減らさない)', () => {
  const ledger = [{ id: 'F9', type: 'defect', label: '別件', timestamp: M(2026, 5, 2), model: 'B' }];
  const lots = [{ id: 'L3', model: 'B', steps: [], tasks: { '0-0': { ngReason: '古い記録', ngAt: M(2026, 5, 3) } } }];
  const { rows, mergedNg } = collectQualityRows({ lots, ledger });
  assert.equal(mergedNg, 0);
  assert.equal(rows.filter(r => r.src === 'ng').length, 1);
  assert.equal(rows.find(r => r.src === 'ng').stepTitle, '全体');
});

test('台帳と検査中で id が同じ記録は1件(最終検査の移行データ)', () => {
  const ledger = [{ id: 'X1', type: 'complaint', label: '台帳で直した後の文', timestamp: M(2026, 5, 5), model: 'C' }];
  const lots = [{ id: 'L4', model: 'C', interruptions: [{ id: 'X1', type: 'complaint', label: '古い文', timestamp: M(2026, 5, 5) }], tasks: {} }];
  const { rows } = collectQualityRows({ lots, ledger });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].src, 'ledger');
  assert.equal(rows[0].content, '台帳で直した後の文');
});

test('サンプルは既定で数えない / 数えなかった事を出せる', () => {
  const ledger = [
    { id: 'S1', type: 'complaint', content: '見本', timestamp: M(2026, 5, 6), model: 'D', sample: true },
    { id: 'R1', type: 'complaint', content: '本物', timestamp: M(2026, 5, 7), model: 'D' },
  ];
  const { rows } = collectQualityRows({ lots: [], ledger });
  const shown = filterQuality(rows, { kinds: ['complaint'] });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].content, '本物');
  assert.equal(filterQuality(rows, { kinds: ['complaint'], includeSample: true }).length, 2);
  assert.match(sourceNote(shown, { excludedSample: 1 }), /サンプル 1件は数えていません/);
});

test('気づき・改善も3ソースから拾う(台帳の improvement が一生0件だった穴)', () => {
  const ledger = [{ id: 'I1', type: 'improvement', label: '治具を変えたい', timestamp: M(2026, 5, 8), model: 'E' }];
  const lots = [{ id: 'L5', model: 'E', interruptions: [{ id: 'I2', type: 'improvement', label: '順番を変えたい', timestamp: M(2026, 5, 9), improvementKind: 'order' }], tasks: {} }];
  const { rows } = collectQualityRows({ lots, ledger });
  assert.equal(filterQuality(rows, { kinds: ['improvement'], from: M(2026, 5, 1), to: M(2026, 6, 1) }).length, 2);
});

test('時刻が無い記録は期間に入れない(1970年に飛ばさない)', () => {
  const ledger = [{ id: 'N1', type: 'complaint', content: '時刻なし', timestamp: null, model: 'F' }];
  const { rows } = collectQualityRows({ lots: [], ledger });
  assert.equal(rows.length, 1);
  assert.equal(filterQuality(rows, { kinds: ['complaint'], from: M(1970, 1, 1), to: M(2100, 1, 1) }).length, 0);
});

test('壊れた入力で落ちない', () => {
  assert.doesNotThrow(() => collectQualityRows({}));
  assert.doesNotThrow(() => collectQualityRows({ lots: [null, { id: 'z' }], ledger: [null, { id: 'q' }] }));
});
