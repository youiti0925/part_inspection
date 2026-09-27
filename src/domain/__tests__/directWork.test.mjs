// 🔧 直工の時間取り。⚠一番危ないのは「数字が食い違う」こと。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORK_KIND, kindOf, isIndirect, isDirectOther, defaultDirectCategories, directCategoriesOf,
         secOf, sumByKind, overlapSec, inclusiveFactor, factorNote } from '../directWork.js';

const w = (o) => ({ startTime: 1000, endTime: 2000, duration: 100, ...o });

test('D01 ⚠⚠ kind が無い過去の記録は今までどおり「間接」', () => {
  assert.equal(kindOf({}), WORK_KIND.INDIRECT);
  assert.equal(kindOf(null), WORK_KIND.INDIRECT);
  assert.equal(isIndirect({ category: '会議' }), true, '過去データが直工に化けると直間比率が壊れる');
  assert.equal(isDirectOther({ kind: 'directOther' }), true);
});

test('D02 ⚠最終検査の既定に「梱包・出荷準備」を入れない(荷姿写真と二重計上になる)', () => {
  assert.ok(!defaultDirectCategories('final').includes('梱包・出荷準備'));
  assert.ok(defaultDirectCategories('product').includes('梱包・出荷準備'));
  // 設定で変えられる(決めつけない)
  assert.deepEqual(directCategoriesOf({ directCategories: ['A', 'B'] }, 'final'), ['A', 'B']);
  assert.deepEqual(directCategoriesOf({ directCategories: [] }, 'final'), defaultDirectCategories('final'));
});

test('D03 終わっていない記録は0秒(毎秒変わる数字を作らない)', () => {
  assert.equal(secOf({ duration: 0 }), 0);
  assert.equal(secOf({}), 0);
  assert.equal(secOf({ duration: 55 }), 55);
});

test('D04 種別ごとに分けて数える。期間外は入れない', () => {
  const rows = [
    w({ kind: 'indirect', duration: 100, endTime: 5000 }),
    w({ kind: 'directOther', duration: 200, endTime: 5000 }),
    w({ kind: 'directOther', duration: 999, endTime: 50 }), // 期間外
  ];
  const r = sumByKind(rows, { from: 1000, to: 9000 });
  assert.equal(r.indirect, 100);
  assert.equal(r.directOther, 200);
  assert.equal(r.overlap, 0);
});

test('D05 ⚠⚠ 検査作業と重なった直工は「重なり」として別に数える(黙って二重計上しない)', () => {
  const rows = [w({ kind: 'directOther', startTime: 0, endTime: 10_000, duration: 10 })];
  const r = sumByKind(rows, { lotBusyRanges: [{ from: 4_000, to: 9_000 }] });
  assert.equal(r.directOther, 10);
  assert.equal(r.overlap, 5, '5秒ぶん重なっている');
  assert.equal(r.directOtherExclusive, 5, '人件費・係数はこちらを使う');
});

test('D06 重なりは記録の長さを超えない', () => {
  assert.equal(overlapSec({ startTime: 0, endTime: 3000 }, [{ from: -99999, to: 99999 }]), 3);
  assert.equal(overlapSec({ startTime: 0, endTime: 0 }, [{ from: 0, to: 9999 }]), 0);
});

test('D07 ⚠⚠ 係数の分母は「検査タスクの時間」に固定する(掛ける相手と物差しを合わせる)', () => {
  // 検査10h・直工その他2h・間接3h → (10+2+3)/10 = 1.5
  const f = inclusiveFactor({ inspectionSec: 36000, directOtherExclusiveSec: 7200, indirectSec: 10800 });
  assert.equal(f, 1.5);
  // ⚠分母に直工を足す実装だと (10+2+3)/(10+2)=1.25 になり、必要人数が過小になる
  assert.notEqual(f, 15 / 12);
  assert.equal(inclusiveFactor({ inspectionSec: 0 }), 1, '検査0なら1(0除算しない)');
});

test('D08 係数の説明に 出どころ と 重なりの扱い が入る', () => {
  const t = factorNote({ inspectionSec: 36000, directOtherExclusiveSec: 7200, indirectSec: 10800, overlapSec: 3600 });
  assert.match(t, /検査 10\.0h/);
  assert.match(t, /直工その他 2\.0h/);
  assert.match(t, /間接 3\.0h/);
  assert.match(t, /重なっていた 1\.0h は除いています/);
  assert.ok(!factorNote({ inspectionSec: 1, overlapSec: 0 }).includes('除いています'), '重なり0なら余計な事を書かない');
});
