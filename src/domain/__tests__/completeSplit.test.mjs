// 📦 検査完了の分納。⚠製品検査/最終検査で同一。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    lotQtyOf, completePartsOf, sentQtyOf, remainingQtyOf, isFullyNotified, isDeclined,
    isPartiallyNotified, canSendComplete, buildCompletePart, completeNotifyPatch,
    completeMessage, completeStatusLabel,
} from '../completeSplit.js';

const NOW = 1_800_000_000_000;
const apply = (lot, patch) => ({ ...lot, ...patch }); // merge:true 相当(直下は上書き・parts は下で足す)

test('CS01 まだ何も送っていない = 残りは全部', () => {
    const lot = { id: 'l1', quantity: 4 };
    assert.equal(lotQtyOf(lot), 4);
    assert.equal(sentQtyOf(lot), 0);
    assert.equal(remainingQtyOf(lot), 4);
    assert.equal(isFullyNotified(lot), false);
    assert.equal(isPartiallyNotified(lot), false);
    assert.equal(completeStatusLabel(lot), '未連絡');
});

test('CS02 台数が無いロットは1台とみなす(0台は無い)', () => {
    assert.equal(lotQtyOf({}), 1);
    assert.equal(lotQtyOf({ quantity: 0 }), 1);
    assert.equal(lotQtyOf({ quantity: '3' }), 3);
});

test('CS03 4台のうち2台だけ送れる。残りは2台', () => {
    let lot = { id: 'l1', quantity: 4 };
    const p1 = buildCompletePart({ id: 'r1', qty: 2, by: '田中', group: '組立 高木班', now: NOW });
    lot = apply(lot, completeNotifyPatch(lot, p1));
    assert.equal(sentQtyOf(lot), 2);
    assert.equal(remainingQtyOf(lot), 2);
    assert.equal(isPartiallyNotified(lot), true);
    assert.equal(isFullyNotified(lot), false);
    assert.equal(completeStatusLabel(lot), '2/4台 連絡済み（残り 2台）');
});

test('CS04 残りを超える台数は送れない。0台も送れない', () => {
    let lot = { id: 'l1', quantity: 4 };
    lot = apply(lot, completeNotifyPatch(lot, buildCompletePart({ id: 'r1', qty: 3, now: NOW })));
    assert.equal(canSendComplete(lot, 1).ok, true);
    assert.equal(canSendComplete(lot, 2).ok, false);         // 残り1台なのに2台
    assert.equal(canSendComplete(lot, 2).reason.includes('残りは 1台'), true);
    assert.equal(canSendComplete(lot, 0).ok, false);
    assert.equal(canSendComplete(lot, -1).ok, false);
});

test('CS05 全部送り終わったら、もう送れない', () => {
    let lot = { id: 'l1', quantity: 2 };
    lot = apply(lot, completeNotifyPatch(lot, buildCompletePart({ id: 'r1', qty: 2, now: NOW })));
    assert.equal(isFullyNotified(lot), true);
    assert.equal(canSendComplete(lot, 1).ok, false);
    assert.equal(completeStatusLabel(lot), '連絡済み（2台）');
});

test('CS06 送った便は1件ずつ残る(古い順)', () => {
    let lot = { id: 'l1', quantity: 4 };
    lot = apply(lot, completeNotifyPatch(lot, buildCompletePart({ id: 'r1', qty: 2, by: 'A', now: NOW })));
    // 2便目: merge:true は parts を **合体** するので、既存のキーは残る
    const patch2 = completeNotifyPatch(lot, buildCompletePart({ id: 'r2', qty: 1, by: 'B', now: NOW + 1000 }));
    lot = { ...lot, completeNotified: { ...patch2.completeNotified, parts: { ...lot.completeNotified.parts, ...patch2.completeNotified.parts } } };
    const ps = completePartsOf(lot);
    assert.deepEqual(ps.map(p => p.id), ['r1', 'r2']);
    assert.deepEqual(ps.map(p => p.qty), [2, 1]);
    assert.equal(sentQtyOf(lot), 3);
    assert.equal(remainingQtyOf(lot), 1);
});

test('CS07 ⚠合計は保存された数値でなく parts から数え直す(同時送信で消えないため)', () => {
    // 誰かが古い合計(1)を書き戻しても、parts が正しければ答えは変わらない
    const lot = {
        quantity: 4,
        completeNotified: {
            at: NOW, sentTotal: 1,      // ← こういう数値があっても見ない
            parts: { r1: { id: 'r1', qty: 2, at: NOW }, r2: { id: 'r2', qty: 1, at: NOW + 1 } },
        },
    };
    assert.equal(sentQtyOf(lot), 3);
});

test('CS08 旧データ(partsが無い連絡済み)は「全部送り終わった」とみなす', () => {
    // ⚠ここを間違えると、今まで連絡済みのロットが「まだ残っている」に見えて二重送信になる
    const lot = { quantity: 3, completeNotified: { at: NOW, by: '田中', group: '組立', reqId: 'old1' } };
    assert.equal(sentQtyOf(lot), 3);
    assert.equal(isFullyNotified(lot), true);
    assert.equal(canSendComplete(lot, 1).ok, false);
    assert.equal(completePartsOf(lot)[0].legacy, true);
});

test('CS09 旧データから分納へ移る時、旧の1件を落とさない', () => {
    const lot = { quantity: 6, completeNotified: { at: NOW, by: '田中', group: '組立', reqId: 'old1' } };
    // ⚠旧は「6台ぶん送った」扱いなので、本来ここでは送れない。
    //   それでも patch の作りとして旧1件が parts に移ることを確かめる(取りこぼし防止)。
    const patch = completeNotifyPatch(lot, buildCompletePart({ id: 'r2', qty: 1, now: NOW + 1 }));
    assert.deepEqual(Object.keys(patch.completeNotified.parts).sort(), ['old1', 'r2']);
    assert.equal(patch.completeNotified.parts.old1.qty, 6);
});

test('CS10 「連絡しない」を選んだロットは送った扱いにしない', () => {
    const lot = { quantity: 4, completeNotified: { at: NOW, by: '田中', declined: true } };
    assert.equal(isDeclined(lot), true);
    assert.equal(sentQtyOf(lot), 0);
    assert.equal(completeStatusLabel(lot), '連絡しない');
});

test('CS11 直下にも最新の1件を置く(古い画面はそこしか見ていない)', () => {
    const lot = { quantity: 4 };
    const patch = completeNotifyPatch(lot, buildCompletePart({ id: 'r1', qty: 2, by: '田中', group: '組立 高木班', now: NOW }));
    assert.equal(patch.completeNotified.at, NOW);
    assert.equal(patch.completeNotified.by, '田中');
    assert.equal(patch.completeNotified.group, '組立 高木班');
    assert.equal(patch.completeNotified.reqId, 'r1');
    assert.equal(patch.completeNotified.declined, false);
});

test('CS12 相手に届く文: 分納の時は「何台のうち何台」を必ず書く', () => {
    assert.equal(completeMessage({ model: 'RTT-215,AB', qty: 4, total: 4 }),
        'RTT-215,AB 検査が完了しました（4台）');
    assert.equal(completeMessage({ model: 'RTT-215,AB', qty: 2, total: 4, sentBefore: 0 }),
        'RTT-215,AB 検査が完了しました（4台のうち 2台・これまで 2/4台）');
    assert.equal(completeMessage({ model: 'RTT-215,AB', qty: 1, total: 4, sentBefore: 2 }),
        'RTT-215,AB 検査が完了しました（4台のうち 1台・これまで 3/4台）');
    // 型式が無くても文になる
    assert.equal(completeMessage({ qty: 1, total: 1 }), '検査が完了しました（1台）');
});

test('CS13 壊れた中身でも落ちない', () => {
    assert.deepEqual(completePartsOf(null), []);
    assert.deepEqual(completePartsOf({ completeNotified: { parts: 'こわれた', at: NOW } }), [{ id: '__legacy', qty: 1, at: NOW, by: '', group: '', legacy: true }]);
    assert.deepEqual(completePartsOf({ completeNotified: {} }), []);
    assert.equal(sentQtyOf(undefined), 0);
    assert.equal(remainingQtyOf({}), 1);
});
