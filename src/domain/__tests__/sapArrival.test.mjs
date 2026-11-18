// SAP の検査の到着見込み → 部品検査の操業シミュレーションの「これから届く」(lot.entryAt)。作り物の小さなデータ
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normCode, normText, matchSapToLots, applySapArrivals, sapRowsWithMs } from '../sapArrival.js';
import { setSapArrivals, getSapArrivals, subscribeSapArrivals } from '../sapArrivalStore.js';
import { normalizeInput } from '../operationsSimulation/normalizeInput.js';

const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const NOW = at(2026, 11, 18, 8, 30);
const sap = (order, item, itemText, startIso, extra = {}) => ({ order, item, itemText, startIso, startTime: null, startBasis: 'sap', phase: 'far', ...extra });
const lot = (id, over = {}) => ({ id, status: 'processing', location: 'arrival', quantity: 2, orderNo: '', model: '', modelText: '', templateId: 'T', dueDate: '2026-12-10', entryAt: at(2026, 11, 20, 8, 30), steps: [{ id: 's1', title: '検査', targetTime: 600 }], tasks: {}, ...over });

test('SA01 比べ方: 品目コードは全角・大文字・ハイフンを揃える・品目テキストは半角カナと小さい仮名・長音を揃える', () => {
    assert.equal(normCode(' rwe-160l,J '), normCode('RWE-160L,J'));
    assert.notEqual(normCode('RWE-160L,J'), normCode('RWE-160L'));   // 枝番が違う物は別(部分一致で当てない)
    assert.equal(normText('ﾃﾞｲｽﾄﾘﾋﾞﾕ-ﾀ'), normText('ディストリビュータ'));
});

test('SA02 当て方: 指図番号が同じ→当たる・品目コードが1対1→当たる・品目テキストが1対1→当たる', () => {
    const rows = sapRowsWithMs([sap('1001', 'AAA', 'x', '2026-11-25'), sap('1002', 'BBB', 'y', '2026-11-26'), sap('1003', 'CCC', 'ﾊﾞﾙﾌﾞ', '2026-11-27')]);
    const lots = [lot('L1', { orderNo: '1001', model: 'ZZZ' }), lot('L2', { orderNo: 'N2', model: 'bbb' }), lot('L3', { orderNo: 'N3', model: 'Q', modelText: 'バルブ' })];
    const m = matchSapToLots(rows, lots);
    assert.deepEqual(m.matches.map((x) => [x.row.order, x.lotId, x.by]), [['1001', 'L1', 'order'], ['1002', 'L2', 'item'], ['1003', 'L3', 'text']]);
    assert.equal(m.unmatched.length + m.ambiguous.length, 0);
});

test('SA03 勝手に当てない: 候補が複数=あいまい・どれにも当たらない=対応なし(適用しない)・部分一致は当てない', () => {
    const rows = sapRowsWithMs([sap('1', 'AAA', 'x', '2026-11-25'), sap('2', 'AAA', 'x', '2026-11-26'), sap('3', 'RWE-160L,J', 'y', '2026-11-27'), sap('4', 'NONE', 'zz', '2026-11-28')]);
    const lots = [lot('L1', { model: 'AAA' }), lot('L2', { model: 'AAA' }), lot('L3', { model: 'RWE-160L' })];
    const m = matchSapToLots(rows, lots);
    assert.equal(m.matches.length, 0);
    assert.equal(m.ambiguous.length, 2);   // AAA は SAP 2件・ロット 2件 → 1対1 に決まらない
    assert.deepEqual(m.unmatched.map((x) => x.row.order).sort(), ['3', '4']);   // RWE-160L,J と RWE-160L は別
    assert.match(m.unmatched[0].reason, /対応なし/);
    const a = applySapArrivals(lots, rows, { nowMs: NOW });
    assert.equal(a.applied.length, 0); assert.equal(a.lots, lots);   // 何も当たらなければ元の配列のまま
});

test('SA04 差し替え: 未入荷のロットの entryAt が SAP の見込み(日付だけなら始業 08:30)になる・元のロットは書き換えない', () => {
    const lots = [lot('L1', { orderNo: '1001' })];
    const orig = lots[0].entryAt;
    const a = applySapArrivals(lots, sapRowsWithMs([sap('1001', 'AAA', 'x', '2026-11-25')]), { nowMs: NOW });
    assert.equal(a.applied.length, 1);
    assert.equal(a.lots[0].entryAt, at(2026, 11, 25, 8, 30)); assert.equal(a.lots[0].sapArrival.prevEntryAt, orig);
    assert.equal(lots[0].entryAt, orig); assert.equal(lots[0].sapArrival, undefined);
    assert.match(a.key, /L1@/);
    const t = applySapArrivals(lots, sapRowsWithMs([sap('1001', 'AAA', 'x', '2026-11-25', { startTime: '13:15', startBasis: 'sim' })]), { nowMs: NOW });
    assert.equal(t.lots[0].entryAt, at(2026, 11, 25, 13, 15));
});

test('SA05 差し替えない物(理由つき): 手元にあるロット・SAP の予定日が過ぎている・SAP でも検査を始めている・予定開始日なし', () => {
    const lots = [lot('A', { orderNo: '1', location: 'inshop' }), lot('B', { orderNo: '2' }), lot('C', { orderNo: '3' }), lot('D', { orderNo: '4' })];
    const rows = sapRowsWithMs([sap('1', 'x', 'x', '2026-11-25'), sap('2', 'x', 'x', '2026-11-10'), sap('3', 'x', 'x', '2026-11-25', { startBasis: 'actual' }), sap('4', 'x', 'x', null)]);
    const a = applySapArrivals(lots, rows, { nowMs: NOW });
    assert.equal(a.applied.length, 0); assert.equal(a.skipped.length, 4);
    assert.match(a.skipped.find((s) => s.lotId === 'A').why, /手元/);
    assert.match(a.skipped.find((s) => s.lotId === 'B').why, /過ぎている/);
    assert.match(a.skipped.find((s) => s.lotId === 'C').why, /実績/);
    assert.match(a.skipped.find((s) => s.lotId === 'D').why, /予定開始日が無い/);
    assert.equal(a.lots, lots);
});

test('SA06 既存の到着の口に入る: normalizeInput が SAP 由来の entryAt を「到着予定(これから届く)」として読み、その時刻から着手させる', () => {
    const lots = [lot('L1', { orderNo: '1001', entryAt: at(2026, 11, 19, 8, 30) }), lot('L2', { orderNo: '1002', entryAt: at(2026, 11, 19, 8, 30) })];
    const a = applySapArrivals(lots, sapRowsWithMs([sap('1001', 'AAA', 'x', '2026-11-25')]), { nowMs: NOW });
    const run = (ls) => normalizeInput({ lots: ls, templates: [{ id: 'T', name: 'T', steps: [] }], workers: [{ name: '尾田' }], settings: {}, now: NOW, horizonDays: 14, scenario: {} });
    const before = run(lots).lots.find((l) => l.lotId === 'L1'), after = run(a.lots).lots.find((l) => l.lotId === 'L1');
    assert.equal(before.arrivalMs, at(2026, 11, 19, 8, 30));
    assert.equal(after.arrivalMs, at(2026, 11, 25, 8, 30)); assert.equal(after.arrivalState, 'scheduled');   // 検査にはその時刻から届く
    assert.equal(run(a.lots).lots.find((l) => l.lotId === 'L2').arrivalMs, at(2026, 11, 19, 8, 30));   // 当たらないロットは そのまま
});

test('SA07 受け渡し: 保存せずメモリの中だけ・読み込むと購読者に知らせる・null で空に戻る', () => {
    let n = 0; const off = subscribeSapArrivals(() => { n++; });
    assert.equal(getSapArrivals(), null);
    setSapArrivals({ rows: [1], baseMs: 1, label: 'x' }); assert.equal(n, 1); assert.deepEqual(getSapArrivals().rows, [1]);
    setSapArrivals(null); assert.equal(getSapArrivals(), null); off(); setSapArrivals(null); assert.equal(n, 2);
});

test('SA08 旗: feature:sapProgress が 1 の時だけ ON(既定 OFF)・OFF の間は 受け渡しがあっても 読む側は使わない', async () => {
    const { sapFlagOn } = await import('../sapArrivalStore.js');
    const keep = globalThis.localStorage;
    try {
        globalThis.localStorage = { getItem: () => null }; assert.equal(sapFlagOn(), false);
        globalThis.localStorage = { getItem: (k) => (k === 'feature:sapProgress' ? '1' : null) }; assert.equal(sapFlagOn(), true);
        globalThis.localStorage = { getItem: () => '0' }; assert.equal(sapFlagOn(), false);
        globalThis.localStorage = { getItem: () => { throw new Error('blocked'); } }; assert.equal(sapFlagOn(), false);
    } finally { if (keep === undefined) delete globalThis.localStorage; else globalThis.localStorage = keep; }
});
