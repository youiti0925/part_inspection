// 🔄 元動画の向きを立て直す — 試験
//
// ⚠⚠ ここが崩れると、スマホを縦に持って撮った動画が書き出しで横に倒れ、
//   上下の黒帯で絵が半分以下の大きさになる(2026-08-15 清水さん報告)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normDeg, degFromMatrix, sourceRotateNeeded, rotatedSize, uprightTransform, drawUpright,
} from '../videoRotation.js';

// mp4-muxer が書く行列と同じ作り方(16.16 固定小数)。本物と同じ値で試す。
const mat = (deg) => {
  const th = (deg * Math.PI) / 180;
  const c = Math.round(Math.cos(th)), s = Math.round(Math.sin(th));
  return [c * 65536, s * 65536, 0, -s * 65536, c * 65536, 0, 0, 0, 1073741824];
};

test('VR1 90度ずつに丸めて 0〜359 に収める', () => {
  assert.equal(normDeg(0), 0);
  assert.equal(normDeg(90), 90);
  assert.equal(normDeg(-90), 270);
  assert.equal(normDeg(450), 90);
  assert.equal(normDeg(89), 90);      // 少しズレた行列でも 90 に寄せる
  assert.equal(normDeg(NaN), 0);
});

test('VR2 ⚠本物の行列(16.16固定小数)から角度が出る', () => {
  assert.equal(degFromMatrix(mat(0)), 0);
  assert.equal(degFromMatrix(mat(90)), 90);
  assert.equal(degFromMatrix(mat(180)), 180);
  assert.equal(degFromMatrix(mat(270)), 270);
});

test('VR3 行列が無い/つぶれている動画は 0(勝手に回さない)', () => {
  assert.equal(degFromMatrix(null), 0);
  assert.equal(degFromMatrix(undefined), 0);
  assert.equal(degFromMatrix([0, 0, 0, 0, 0, 0, 0, 0, 0]), 0);
  assert.equal(degFromMatrix([]), 0);
});

test('VR4 倍率が違っても角度は同じ(1.0=1 と書く実装でも通る)', () => {
  assert.equal(degFromMatrix([0, 1, 0, -1, 0, 0, 0, 0, 1]), 90);
  assert.equal(degFromMatrix([0, 65536, 0, -65536, 0, 0, 0, 0, 1]), 90);
});

test('VR5 スマホの縦動画: コマは横・<video>は縦 → 90度回す', () => {
  // 行列90度・コマ1920x1080(横)・<video>は1080x1920(縦) = 実物のiPhone/Android
  assert.equal(sourceRotateNeeded(90, 1920, 1080, 1080, 1920), 90);
  assert.equal(sourceRotateNeeded(270, 1920, 1080, 1080, 1920), 270);
});

test('VR6 ⚠⚠二重に回さない。寸法が既に合っているなら回さない', () => {
  // 将来ブラウザが VideoDecoder 側で回転を適用したら、こちらでも回すと倒れる。
  // その時に黙って壊れないよう、**寸法で答え合わせ**してから回す。
  assert.equal(sourceRotateNeeded(90, 1080, 1920, 1080, 1920), 0);
  assert.equal(sourceRotateNeeded(270, 1080, 1920, 1080, 1920), 0);
});

test('VR7 答え合わせができない時は行列を信じる', () => {
  assert.equal(sourceRotateNeeded(90, 1920, 1080, 0, 0), 90);       // <video>の寸法が取れない
  assert.equal(sourceRotateNeeded(90, 1000, 1000, 1000, 1000), 90); // 正方形は見分けられない
  assert.equal(sourceRotateNeeded(180, 1920, 1080, 1920, 1080), 180); // 180は縦横が変わらない
});

test('VR8 回転なしの動画には一切手を出さない', () => {
  assert.equal(sourceRotateNeeded(0, 1920, 1080, 1920, 1080), 0);
  assert.equal(sourceRotateNeeded(0, 1920, 1080, 1080, 1920), 0);
});

test('VR9 立て直した後の大きさ', () => {
  assert.deepEqual(rotatedSize(1920, 1080, 90), { width: 1080, height: 1920 });
  assert.deepEqual(rotatedSize(1920, 1080, 270), { width: 1080, height: 1920 });
  assert.deepEqual(rotatedSize(1920, 1080, 180), { width: 1920, height: 1080 });
  assert.deepEqual(rotatedSize(1920, 1080, 0), { width: 1920, height: 1080 });
});

// 描く時の置き場所を、**角が実際どこへ行くか**で確かめる。
// (translate → rotate の順で当てはめた時の写り先)
const mapPt = (t, x, y) => ({
  x: t.tx + x * Math.cos(t.rad) - y * Math.sin(t.rad),
  y: t.ty + x * Math.sin(t.rad) + y * Math.cos(t.rad),
});
const near = (a, b) => Math.abs(a - b) < 1e-6;

test('VR10 ⚠90度: 元の絵の4隅が、立てた枠の中にぴったり収まる', () => {
  const t = uprightTransform(1920, 1080, 90);
  assert.equal(t.width, 1080); assert.equal(t.height, 1920);
  for (const [x, y] of [[0, 0], [1920, 0], [0, 1080], [1920, 1080]]) {
    const p = mapPt(t, x, y);
    assert.ok(p.x >= -1e-6 && p.x <= t.width + 1e-6, `x が枠の外: ${p.x}`);
    assert.ok(p.y >= -1e-6 && p.y <= t.height + 1e-6, `y が枠の外: ${p.y}`);
  }
  // 元の左上(0,0)は、時計回り90度で **右上** へ行く
  const lt = mapPt(t, 0, 0);
  assert.ok(near(lt.x, 1080) && near(lt.y, 0), `左上の行き先が違う: ${JSON.stringify(lt)}`);
});

test('VR11 ⚠270度: 元の左上は左下へ行く(90度と逆)', () => {
  const t = uprightTransform(1920, 1080, 270);
  assert.equal(t.width, 1080); assert.equal(t.height, 1920);
  const lt = mapPt(t, 0, 0);
  assert.ok(near(lt.x, 0) && near(lt.y, 1920), `左上の行き先が違う: ${JSON.stringify(lt)}`);
  for (const [x, y] of [[0, 0], [1920, 0], [0, 1080], [1920, 1080]]) {
    const p = mapPt(t, x, y);
    assert.ok(p.x >= -1e-6 && p.x <= t.width + 1e-6 && p.y >= -1e-6 && p.y <= t.height + 1e-6);
  }
});

test('VR12 180度: 元の左上は右下へ行く。枠の大きさは変わらない', () => {
  const t = uprightTransform(1920, 1080, 180);
  assert.equal(t.width, 1920); assert.equal(t.height, 1080);
  const lt = mapPt(t, 0, 0);
  assert.ok(near(lt.x, 1920) && near(lt.y, 1080), `左上の行き先が違う: ${JSON.stringify(lt)}`);
});

test('VR13 0度は何もしない(save/rotate すら通らない)', () => {
  const t = uprightTransform(1920, 1080, 0);
  assert.equal(t.rad, 0); assert.equal(t.tx, 0); assert.equal(t.ty, 0);
  const log = [];
  const ctx = {
    save: () => log.push('save'), restore: () => log.push('restore'),
    translate: (x, y) => log.push(`translate:${x},${y}`),
    rotate: (r) => log.push(`rotate:${r}`),
    drawImage: (...a) => log.push(`draw:${a.slice(1).join(',')}`),
  };
  drawUpright(ctx, {}, 1920, 1080, 0);
  assert.deepEqual(log, ['draw:0,0,1920,1080']);
});

test('VR14 90度は translate → rotate → drawImage の順で、必ず restore する', () => {
  const log = [];
  const ctx = {
    save: () => log.push('save'), restore: () => log.push('restore'),
    translate: (x, y) => log.push(`translate:${x},${y}`),
    rotate: (r) => log.push(`rotate:${Math.round((r * 180) / Math.PI)}`),
    drawImage: (...a) => log.push(`draw:${a.slice(1).join(',')}`),
  };
  drawUpright(ctx, {}, 1920, 1080, 90);
  assert.deepEqual(log, ['save', 'translate:1080,0', 'rotate:90', 'draw:0,0,1920,1080', 'restore']);
});
