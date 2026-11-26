// 進捗管理表の U 列(出庫完了日)を読む: 既存の取り込みの割付は変えない・U 列は部品検査だけの追加
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SHEET_MAP, normalizeSheetMap } from '../progressSheet.js';
import { SHIP_DONE_COL, PARTS_SHEET_MAP, shipDoneYmd, shipDoneByOrder } from '../progressShipDone.js';

test('SD01 既存の割付は 変えていない(AD=出荷日のまま・shipDone の鍵は無い)・U 列は 部品検査の追加の写しにだけ', () => {
    assert.equal(DEFAULT_SHEET_MAP.cols.shipDate, 'AD'); assert.equal('shipDone' in DEFAULT_SHEET_MAP.cols, false);
    assert.equal(SHIP_DONE_COL, 'U'); assert.equal(PARTS_SHEET_MAP.cols.shipDone, 'U'); assert.equal(PARTS_SHEET_MAP.cols.shipDate, 'AD');
    assert.equal(Object.isFrozen(PARTS_SHEET_MAP), true);
});

test('SD02 normalizeSheetMap(base=写し)で U 列が残る・列を打ち直せる・変な字は空', () => {
    assert.equal(normalizeSheetMap(null, PARTS_SHEET_MAP).cols.shipDone, 'U');
    assert.equal(normalizeSheetMap({ cols: { shipDone: 'v' } }, PARTS_SHEET_MAP).cols.shipDone, 'V');
    assert.equal(normalizeSheetMap({ cols: { shipDone: '??' } }, PARTS_SHEET_MAP).cols.shipDone, '');
    assert.equal(normalizeSheetMap(null).cols.shipDone, undefined);   // 今までの既定は 鍵ごと無い(1ミリも変わらない)
});

test('SD03 U 列の値を 日付に読む(Date・文字・M/D)・読めなければ null(でっち上げない)', () => {
    const today = new Date(2026, 10, 18);
    assert.equal(shipDoneYmd(new Date(2026, 11, 4), today), '2026-12-04');
    assert.equal(shipDoneYmd('2026/12/4', today), '2026-12-04');
    assert.equal(shipDoneYmd('', today), null); assert.equal(shipDoneYmd(null, today), null); assert.equal(shipDoneYmd('未定', today), null);
});

test('SD04 取り込んだ行 → { 組立の指図: 出庫完了日 }(U が読めない行は入れない)', () => {
    const m = shipDoneByOrder([{ orderNo: 'A1', shipDone: new Date(2026, 11, 4) }, { orderNo: 'A2', shipDone: '' }, { orderNo: 'A3' }], new Date(2026, 10, 18));
    assert.deepEqual(m, { A1: '2026-12-04' });
});
