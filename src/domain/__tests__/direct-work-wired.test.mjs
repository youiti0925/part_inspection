// 🔧 X8 直工(検査以外)を間接作業の窓から測る 配線の見張り(部品検査・2026-09-27)。
//   純関数 directWork.js は product-pairs で製品と1バイト同じ事を見ている。ここは画面と集計が kind を見ているか。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOf } from './_code.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const app = codeOf(path.resolve(HERE, '..', '..', 'App.jsx'));

test('D1 窓に直工の分類が渡り、直工の時だけ kind を付けて始める', () => {
  assert.match(app, /directCategories=\{directCategoriesOf\(settings, 'parts'\)\}/);
  assert.match(app, /kind === WORK_KIND\.DIRECT_OTHER \? \{ kind: WORK_KIND\.DIRECT_OTHER \} : \{\}/);
  assert.match(app, /onClick=\{\(\) => onStart\(cat, kind\)\}/);
});

test('D2 集計は直工その他を間接に混ぜない(分析 Excel 2か所・作業者別・全体進捗の係数・月報)', () => {
  const n = (app.match(/isDirectOther\(w\)/g) || []).length;
  assert.ok(n >= 6, `isDirectOther(w) で分けている所が ${n} か所しかない`);
  assert.match(app, /inclusiveFactor\(\{ inspectionSec: directSec, directOtherExclusiveSec: directOtherSec, indirectSec \}\)/);
});
