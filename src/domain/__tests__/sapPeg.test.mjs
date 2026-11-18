// 部品の指図 → 組立の指図(ピッキング)とリミット: 在庫で足りる/在庫が足りず早い順に当たる/数量でまたがる/日付なしは後ろ/余り
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pegPartsToAssembly, shipByPartOrder, addWorkdays, LIMIT_DAYS_BEFORE_SHIP } from '../sapPeg.js';

const D = (order, u, items) => ({ order, u, items });
const P = (order, item, qty, arriveIso, sapIso = null) => ({ order, item, qty, arriveIso, sapIso });

test('PG01 リミット = U の 2 稼働日前(土日は数えない・定数 1 か所)', () => {
    assert.equal(LIMIT_DAYS_BEFORE_SHIP, 2);
    assert.equal(addWorkdays('2026-11-20', -2), '2026-11-18');   // 金 → 水
    assert.equal(addWorkdays('2026-11-23', -2), '2026-11-19');   // 月 → 木(土日をまたぐ)
});

test('PG02 在庫で足りる: 部品の指図は当てられない(需要なし=余り)', () => {
    const r = pegPartsToAssembly({ demands: [D('A1', '2026-12-04', [{ code: 'X', qty: 3 }])], stock: { X: 5 }, parts: [P('S1', 'X', 10, '2026-11-25')] });
    assert.equal(r.parts[0].status, 'surplus'); assert.equal(r.parts[0].limit, null); assert.equal(r.parts[0].ok, null);
    assert.deepEqual(r.stockUsed, { X: 3 }); assert.deepEqual(r.unmet, []);
});

test('PG03 在庫が足りない: 進捗管理表の順に在庫を使い 足りない需要に 検査に着く見込みの早い部品から当たる(リミット=U の 2 稼働日前・間に合うか)', () => {
    const demands = [D('A1', '2026-12-04', [{ code: 'X', qty: 3 }]), D('A2', '2026-12-10', [{ code: 'X', qty: 4 }])];
    const parts = [P('S2', 'X', 4, '2026-12-20'), P('S1', 'X', 4, '2026-11-25')];   // S1 の方が早い
    const r = pegPartsToAssembly({ demands, stock: { X: 3 }, parts });
    const s1 = r.parts.find((p) => p.order === 'S1'), s2 = r.parts.find((p) => p.order === 'S2');
    assert.equal(s1.status, 'peg'); assert.equal(s1.asm, 'A2'); assert.equal(s1.u, '2026-12-10'); assert.equal(s1.limit, '2026-12-08'); assert.equal(s1.ok, true);   // A1 は在庫で埋まり A2(4)が S1 に当たる
    assert.equal(s2.status, 'surplus');
});

test('PG04 数量でまたがる: 1 つの部品の指図が複数の需要に分かれる・リミットは一番早い方・足りない分は unmet', () => {
    const demands = [D('A1', '2026-12-04', [{ code: 'X', qty: 6 }]), D('A2', '2026-12-09', [{ code: 'X', qty: 6 }])];
    const r = pegPartsToAssembly({ demands, parts: [P('S1', 'X', 8, '2026-12-03')] });
    const s = r.parts[0];
    assert.deepEqual(s.allocs.map((a) => [a.asm, a.qty]), [['A1', 6], ['A2', 2]]);
    assert.equal(s.asm, 'A1'); assert.equal(s.limit, '2026-12-02'); assert.equal(s.ok, false);   // 着く 12/3 は リミット 12/2 に間に合わない
    assert.deepEqual(r.unmet, [{ asm: 'A2', code: 'X', short: 4, u: '2026-12-09' }]);
});

test('PG05 日付の無い部品の指図は 後ろに当たる(日付のある物が先)・日付が無ければ 間に合うかは null', () => {
    const r = pegPartsToAssembly({ demands: [D('A1', '2026-12-04', [{ code: 'X', qty: 2 }])], parts: [P('S0', 'X', 2, null, null), P('S1', 'X', 2, '2026-12-01')] });
    assert.equal(r.parts.find((p) => p.order === 'S1').status, 'peg'); assert.equal(r.parts.find((p) => p.order === 'S0').status, 'surplus');
    const r2 = pegPartsToAssembly({ demands: [D('A1', '2026-12-04', [{ code: 'X', qty: 2 }])], parts: [P('S0', 'X', 2, null, null)] });
    assert.equal(r2.parts[0].status, 'peg'); assert.equal(r2.parts[0].ok, null);   // 日付が無いので間に合うかは分からない
});

test('PG06 余り・品目コードの違い・U が無い需要: 別の品目コードは当たらない(大文字小文字・全角は揃える)・U が無い需要に当たった部品は リミット無し', () => {
    const r = pegPartsToAssembly({ demands: [D('A1', null, [{ code: 'ｘ', qty: 1 }]), D('A2', '2026-12-04', [{ code: 'Y', qty: 1 }])], parts: [P('S1', 'X', 1, '2026-12-01'), P('S9', 'Z', 5, '2026-12-01')] });
    assert.equal(r.parts[0].status, 'peg'); assert.equal(r.parts[0].limit, null);
    assert.equal(r.parts[1].status, 'surplus');
    assert.deepEqual(r.unmet.map((u) => u.asm), ['A2']);   // Y の部品は無い → 未手配
});

test('PG07 出庫日の口: 当たった部品の指図 → U(余りは入れない)。arrivalForecast の shipByOrder にそのまま渡せる', () => {
    const r = pegPartsToAssembly({ demands: [D('A1', '2026-12-04', [{ code: 'X', qty: 2 }])], parts: [P('S1', 'X', 2, '2026-12-01'), P('S2', 'X', 2, '2026-12-02')] });
    assert.deepEqual(shipByPartOrder(r), { S1: '2026-12-04' });
});
