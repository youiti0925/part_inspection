// ⭕ 動画の印(楕円・矢印)。⚠古い印(固定サイズの丸・⬇)も壊さず読めること。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEGACY_R, normalizeMark, markFromDrag, moveMark, hitMark, markBox, drawMarksOnCanvas } from '../videoMarks.js';

test('M01 ⚠古い印がそのまま読める(壊すと過去のレシピの〇が全部消える)', () => {
  const old = normalizeMark({ x: 0.5, y: 0.4, text: 'ここ' });
  assert.equal(old.shape, 'ellipse');
  assert.equal(old.rx, LEGACY_R);
  assert.equal(old.ry, LEGACY_R);
  assert.equal(old.text, 'ここ');

  const oldArrow = normalizeMark({ x: 0.3, y: 0.6, shape: 'arrow' });
  assert.equal(oldArrow.shape, 'arrow2');
  assert.equal(oldArrow.x2, 0.3, '先端は元の点');
  assert.equal(oldArrow.y2, 0.6);
  assert.ok(oldArrow.y < 0.6, 'しっぽは上から');
  assert.equal(normalizeMark(null), null);
});

test('M02 なぞって楕円を描く(なぞった四角に内接=囲んだつもりの通り)', () => {
  const m = markFromDrag(0.2, 0.3, 0.6, 0.5);
  assert.equal(m.shape, 'ellipse');
  assert.equal(m.x, 0.4); assert.equal(m.y, 0.4);
  assert.equal(m.rx, 0.2); assert.equal(m.ry, 0.1, '縦横で違う=楕円');
});

test('M03 ⚠タップ(ほぼ動かない)は既定サイズの丸(今までの操作感を残す)', () => {
  const m = markFromDrag(0.5, 0.5, 0.505, 0.503);
  assert.equal(m.rx, LEGACY_R);
  assert.equal(m.ry, LEGACY_R);
  assert.equal(m.x, 0.505);
});

test('M04 矢印はなぞった向きのまま(しっぽ→先端)。タップは上から降りる矢印', () => {
  const a = markFromDrag(0.2, 0.2, 0.7, 0.6, 'arrow2');
  assert.deepEqual([a.x, a.y, a.x2, a.y2], [0.2, 0.2, 0.7, 0.6]);
  const t = markFromDrag(0.5, 0.5, 0.5, 0.5, 'arrow2');
  assert.equal(t.x2, 0.5); assert.equal(t.y2, 0.5);
  assert.ok(t.y < 0.5);
});

test('M05 印を動かせる。枠の外へは出ない', () => {
  const m = moveMark({ x: 0.5, y: 0.5, rx: 0.1, ry: 0.1, shape: 'ellipse' }, 0.2, -0.1);
  assert.equal(m.x, 0.7); assert.equal(m.y, 0.4);
  const edge = moveMark({ x: 0.9, y: 0.1, rx: 0.1, ry: 0.1, shape: 'ellipse' }, 0.5, -0.5);
  assert.equal(edge.x, 1); assert.equal(edge.y, 0);
  const a = moveMark({ shape: 'arrow2', x: 0.1, y: 0.1, x2: 0.3, y2: 0.3 }, 0.1, 0.1);
  assert.deepEqual([a.x, a.y, a.x2, a.y2], [0.2, 0.2, 0.4, 0.4], '矢印は両端いっしょに動く');
});

test('M06 どの印をつかんだか(上に描いた物=あとの物 が優先)', () => {
  const marks = [
    { x: 0.5, y: 0.5, rx: 0.2, ry: 0.2, shape: 'ellipse' },
    { x: 0.5, y: 0.5, rx: 0.05, ry: 0.05, shape: 'ellipse' },
  ];
  assert.equal(hitMark(marks, 0.5, 0.5), 1, '重なっていたら上の(小さい)方');
  assert.equal(hitMark(marks, 0.62, 0.5), 0, '外側は大きい方');
  assert.equal(hitMark(marks, 0.9, 0.9), -1, 'どれでもない');
  const arrow = [{ shape: 'arrow2', x: 0.1, y: 0.1, x2: 0.5, y2: 0.5 }];
  assert.equal(hitMark(arrow, 0.3, 0.3), 0, '線の上');
  assert.equal(hitMark(arrow, 0.3, 0.5), -1, '線から遠い');
});

test('M07 画面に重ねる枠の計算(%)', () => {
  const b = markBox({ x: 0.5, y: 0.4, rx: 0.2, ry: 0.1, shape: 'ellipse' });
  assert.equal(b.left, 30); assert.equal(b.top, 30);
  assert.equal(b.width, 40); assert.equal(b.height, 20);
  const a = markBox({ shape: 'arrow2', x: 0.2, y: 0.2, x2: 0.6, y2: 0.4 });
  assert.equal(a.left, 20); assert.equal(a.width, 40);
  assert.equal(a.lx1, 0); assert.equal(a.ly1, 0);
  assert.equal(a.lx2, 100); assert.equal(a.ly2, 100);
});

test('M08 canvasへの焼き込み(呼び出しが正しい形で並ぶか)', () => {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (t, k) => {
      if (k === 'measureText') return (s) => ({ width: s.length * 10 });
      return (...a) => calls.push([k, a]);
    },
    set: () => true,
  });
  drawMarksOnCanvas(ctx, 1000, 500, [
    { x: 0.5, y: 0.5, rx: 0.2, ry: 0.1, shape: 'ellipse', text: '見る' },
    { shape: 'arrow2', x: 0.1, y: 0.1, x2: 0.4, y2: 0.4 },
    null,
  ]);
  const names = calls.map(c => c[0]);
  assert.ok(names.includes('ellipse'), '楕円を描いた');
  assert.ok(names.filter(n => n === 'stroke').length >= 2, '楕円と矢印の線');
  assert.ok(names.includes('fillText'), '文字を描いた');
  const el = calls.find(c => c[0] === 'ellipse')[1];
  assert.equal(el[0], 500, '中心x=0.5*1000');
  assert.equal(el[2], 200, '半径x=0.2*1000');
  assert.equal(el[3], 50, '半径y=0.1*500 (楕円)');
});

// ---- 形・色・太さを増やした分(2026-08-13 市場比較) --------------------------
import {
  markFromPath, pathBounds, MARK_COLORS, MARK_WIDTHS, colorOf, widthOf, NUM_R,
} from '../videoMarks.js';

test('M09 四角の印: なぞった枠になる', () => {
  const m = markFromDrag(0.2, 0.3, 0.6, 0.5, 'rect');
  assert.equal(m.shape, 'rect');
  assert.ok(Math.abs(m.x - 0.4) < 1e-9 && Math.abs(m.y - 0.4) < 1e-9);
  assert.ok(Math.abs(m.rx - 0.2) < 1e-9 && Math.abs(m.ry - 0.1) < 1e-9);
  const b = markBox(m);
  assert.equal(b.shape, 'rect');
  assert.ok(Math.abs(b.left - 20) < 0.01 && Math.abs(b.width - 40) < 0.01);
});

test('M10 番号の印: ①②③。⚠1〜99に収める', () => {
  const m = markFromDrag(0.5, 0.5, 0.5, 0.5, 'num', { num: 3 });
  assert.equal(m.shape, 'num');
  assert.equal(m.num, 3);
  assert.equal(normalizeMark({ shape: 'num', x: 0.5, y: 0.5, num: 0 }).num, 1);
  assert.equal(normalizeMark({ shape: 'num', x: 0.5, y: 0.5, num: 999 }).num, 99);
  assert.equal(normalizeMark({ shape: 'num', x: 0.5, y: 0.5 }).num, 1);
  assert.equal(markBox(m).num, 3);
});

test('M11 なぞり書き: 点が多すぎたら間引く(保存を膨らませない)', () => {
  const pts = Array.from({ length: 500 }, (_, i) => ({ x: i / 500, y: 0.5 }));
  const m = markFromPath(pts);
  assert.equal(m.shape, 'free');
  assert.ok(m.pts.length <= 60, `点の数 ${m.pts.length}`);
  assert.ok(Math.abs(m.pts[0].x - 0) < 0.01);
  assert.ok(Math.abs(m.pts[m.pts.length - 1].x - 0.998) < 0.01);
});

test('M12 ⚠なぞり書きの点が1つ以下なら、捨てずに小さい丸にする', () => {
  assert.equal(markFromPath([{ x: 0.5, y: 0.5 }]), null, '作る時は作らない');
  const n = normalizeMark({ shape: 'free', pts: [{ x: 0.4, y: 0.6 }] });
  assert.equal(n.shape, 'ellipse');
  assert.ok(Math.abs(n.x - 0.4) < 1e-9);
  assert.equal(normalizeMark({ shape: 'free', pts: [] }).shape, 'ellipse');
});

test('M13 なぞり書きの外枠: 真横の線でも潰れない', () => {
  const b = pathBounds([{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }]);
  assert.ok(Math.abs(b.left - 0.2) < 1e-9);
  assert.ok(Math.abs(b.width - 0.6) < 1e-9);
  assert.ok(b.height >= 0.01, '高さ0にしない(割り算で壊れる)');
  assert.deepEqual(pathBounds([]), { left: 0, top: 0, width: 1, height: 1 });
});

test('M14 色と太さ: 知らない値は既定に落ちる', () => {
  assert.equal(colorOf(normalizeMark({ x: 0.5, y: 0.5, color: 'yellow' })), MARK_COLORS.yellow.hex);
  assert.equal(colorOf(normalizeMark({ x: 0.5, y: 0.5, color: 'ばなな' })), MARK_COLORS.red.hex);
  assert.equal(colorOf(normalizeMark({ x: 0.5, y: 0.5 })), MARK_COLORS.red.hex, '古いデータは赤のまま');
  assert.ok(widthOf({ width: 'l' }, 800, 450) > widthOf({ width: 's' }, 800, 450));
  assert.equal(widthOf({ width: 'ばなな' }, 800, 450), widthOf({ width: 'm' }, 800, 450));
  assert.ok(widthOf({ width: 's' }, 40, 40) >= 2, '小さい絵でも線が消えない');
});

test('M15 つかみ判定: 四角・なぞり書き・番号', () => {
  const rect = markFromDrag(0.2, 0.2, 0.6, 0.6, 'rect');
  assert.equal(hitMark([rect], 0.4, 0.4), 0, '四角の中');
  assert.equal(hitMark([rect], 0.9, 0.9), -1, '四角の外');
  const free = markFromPath([{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }]);
  assert.equal(hitMark([free], 0.5, 0.105), 0, '線の上');
  assert.equal(hitMark([free], 0.5, 0.5), -1, '線から離れている');
  const num = markFromDrag(0.5, 0.5, 0.5, 0.5, 'num', { num: 1 });
  assert.equal(hitMark([num], 0.5, 0.5), 0);
});

test('M16 動かす: なぞり書きは点ぜんぶ動く', () => {
  const free = markFromPath([{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }]);
  const moved = moveMark(free, 0.1, 0.05);
  assert.ok(Math.abs(moved.pts[0].x - 0.2) < 1e-9);
  assert.ok(Math.abs(moved.pts[1].y - 0.25) < 1e-9);
  const num = moveMark(markFromDrag(0.5, 0.5, 0.5, 0.5, 'num'), -0.2, 0);
  assert.ok(Math.abs(num.x - 0.3) < 1e-9);
});

test('M17 ⚠色を変えても、古い印(色なし)の見た目は変わらない', () => {
  const old = { x: 0.5, y: 0.5, shape: 'circle', text: 'あ' };
  const n = normalizeMark(old);
  assert.equal(n.shape, 'ellipse');
  assert.equal(n.rx, 0.045, '古い丸の大きさはそのまま');
  assert.equal(n.color, 'red');
  assert.equal(n.width, 'm');
});

test('M18 番号の印は markBox で NUM_R の枠になる', () => {
  const b = markBox({ shape: 'num', x: 0.5, y: 0.5, num: 7 });
  assert.ok(Math.abs(b.width - NUM_R * 200) < 0.01);
  assert.ok(Math.abs(b.left - (0.5 - NUM_R) * 100) < 0.01);
});
