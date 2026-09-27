// 📐 レターボックス(黒帯)の計算。⚠ここがズレると「小窓だけ印が数%ずれる」。
// RecipeMarks.jsx は React を import するので、計算だけをここに写して確かめる
// …のではなく、**同じ関数を import して**確かめる。写すと片方だけ直る事故になる。
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ⚠RecipeMarks.jsx は JSX なので node --test では読めない。
//   計算部分は素の JS なので、同じ式をここに置くのではなく、
//   videoBox / toPicture を素の JS モジュールに分けて両方から使う。
import { videoBox, toPicture } from '../videoBox.js';

const el = (cw, ch, vw, vh) => ({ clientWidth: cw, clientHeight: ch, videoWidth: vw, videoHeight: vh });

test('B01 縦横比が同じなら黒帯なし(全面)', () => {
  const b = videoBox(el(800, 450, 1600, 900));
  assert.equal(b.left, 0); assert.equal(b.top, 0);
  assert.equal(b.width, 1); assert.equal(b.height, 1);
});

test('B02 ⚠4:3の動画を16:9の枠に入れると左右に黒帯(小窓で必ず起きる形)', () => {
  const b = videoBox(el(800, 450, 640, 480));   // 枠16:9 / 絵4:3
  // 高さいっぱい(450) → 幅は 450*(4/3)=600 → 左右に100pxずつ
  assert.equal(b.top, 0); assert.equal(b.height, 1);
  assert.ok(Math.abs(b.width - 600 / 800) < 1e-9);
  assert.ok(Math.abs(b.left - 100 / 800) < 1e-9);
});

test('B03 縦撮り動画は左右が大きく空く', () => {
  const b = videoBox(el(800, 450, 720, 1280));
  assert.equal(b.height, 1);
  assert.ok(b.width < 0.32, `幅=${b.width}`);
  assert.ok(b.left > 0.33);
});

test('B04 上下に黒帯が出る場合', () => {
  const b = videoBox(el(800, 800, 1600, 900));   // 正方形の枠に横長
  assert.equal(b.left, 0); assert.equal(b.width, 1);
  assert.ok(Math.abs(b.height - 450 / 800) < 1e-9);
  assert.ok(Math.abs(b.top - 175 / 800) < 1e-9);
});

test('B05 ⚠まだ読めていない(大きさ0)なら全面として扱う。0除算にしない', () => {
  [videoBox(null), videoBox(el(0, 0, 0, 0)), videoBox(el(800, 450, 0, 0)), videoBox(el(0, 0, 640, 480))]
    .forEach(b => assert.deepEqual(b, { left: 0, top: 0, width: 1, height: 1 }));
});

test('B06 画面の位置 → 絵の中の割合(黒帯を除く)', () => {
  // 800x450 の枠に 4:3(600x450が絵。左100px空き)
  const e = { ...el(800, 450, 640, 480), getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 450 }) };
  const mid = toPicture(e, 400, 225);
  assert.ok(Math.abs(mid.x - 0.5) < 1e-9, '枠の中央は絵の中央');
  assert.ok(Math.abs(mid.y - 0.5) < 1e-9);

  const leftEdge = toPicture(e, 100, 0);
  assert.ok(Math.abs(leftEdge.x - 0) < 1e-9, '絵の左端');

  const rightEdge = toPicture(e, 700, 450);
  assert.ok(Math.abs(rightEdge.x - 1) < 1e-9, '絵の右端');
});

test('B07 ⚠黒帯の上をなぞっても 0〜1 に収める(枠の外に印を作らない)', () => {
  const e = { ...el(800, 450, 640, 480), getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 450 }) };
  const l = toPicture(e, 10, 225);
  assert.equal(l.x, 0);
  const r = toPicture(e, 790, 225);
  assert.equal(r.x, 1);
});

test('B08b ⚠<img>(naturalWidth)でも黒帯を計算する。videoだけ見ていると画像の印がズレる', () => {
  const img = { clientWidth: 960, clientHeight: 540, naturalWidth: 640, naturalHeight: 480 };
  const b = videoBox(img);
  assert.equal(b.top, 0); assert.equal(b.height, 1);
  assert.ok(Math.abs(b.width - 720 / 960) < 1e-9, '4:3の絵は720px幅');
  assert.ok(Math.abs(b.left - 120 / 960) < 1e-9, '左右に120pxずつ');

  const cv = { clientWidth: 800, clientHeight: 450, width: 640, height: 480 };
  assert.ok(videoBox(cv).left > 0, '<canvas>(width/height)でも効く');
});

test('B08 要素がページの途中にあっても正しい(rectのleft/topを引く)', () => {
  const e = { ...el(400, 225, 1600, 900), getBoundingClientRect: () => ({ left: 120, top: 60, width: 400, height: 225 }) };
  const p = toPicture(e, 120 + 200, 60 + 112.5);
  assert.ok(Math.abs(p.x - 0.5) < 1e-9);
  assert.ok(Math.abs(p.y - 0.5) < 1e-9);
});
