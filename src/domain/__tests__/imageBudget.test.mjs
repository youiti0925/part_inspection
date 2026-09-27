// 📷 画像の容量ルール。⚠一番危ないのは「上限を決めたのに効いていない」こと。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeOf } from './_code.mjs';
import { DEFAULT_IMG_BUDGET, budgetOf, laddersFor, dataUrlBytes, pickStep, shouldConfirm, shrinkNote, fmtKB } from '../imageBudget.js';

test('B01 ⚠⚠ 上限のキーは、画質設定(DEFAULT_IMG_QUALITY)に必ず存在する', () => {
  // resizeImage は IMG_QUALITY[key] || default なので、キーがズレると **黙って既定に落ちて上限が効かない**。
  // 🚨 コメントを落としてから見る(2026-09-04)。コメントに書いた名前を「使っている」と数えない。
  const src = codeOf(new URL('../../App.jsx', import.meta.url));
  const block = src.slice(src.indexOf('const DEFAULT_IMG_QUALITY = {'));
  const qualityKeys = new Set([...block.slice(0, block.indexOf('};')).matchAll(/^\s{2}([A-Za-z]+):/gm)].map(m => m[1]));
  for (const k of Object.keys(DEFAULT_IMG_BUDGET)) {
    assert.ok(qualityKeys.has(k), `上限に書いた「${k}」が DEFAULT_IMG_QUALITY に無い(上限が効かない)`);
  }
});

test('B02 ⚠上限を決めた用途は、実際にその名前で resizeImage が呼ばれている', () => {
  // 🚨 コメントを落としてから見る(2026-09-04)。コメントに書いた名前を「使っている」と数えない。
  const src = codeOf(new URL('../../App.jsx', import.meta.url));
  for (const k of Object.keys(DEFAULT_IMG_BUDGET)) {
    if (k === 'default') continue;
    assert.ok(src.includes(`'${k}'`), `上限を決めた「${k}」を使っている場所がソースに無い`);
  }
});

test('B03 設定で上書きできる。壊れた値・小さすぎる値は既定に倒す', () => {
  assert.equal(budgetOf(null, 'defectPhoto'), DEFAULT_IMG_BUDGET.defectPhoto);
  assert.equal(budgetOf({ imageBudget: { defectPhoto: 500 * 1024 } }, 'defectPhoto'), 500 * 1024);
  assert.equal(budgetOf({ imageBudget: { defectPhoto: 'たくさん' } }, 'defectPhoto'), DEFAULT_IMG_BUDGET.defectPhoto);
  assert.equal(budgetOf({ imageBudget: { defectPhoto: 1024 } }, 'defectPhoto'), DEFAULT_IMG_BUDGET.defectPhoto, '20KB未満は事故');
  assert.equal(budgetOf(null, '知らない用途'), DEFAULT_IMG_BUDGET.default);
});

test('B04 ⚠1段目は「いまの設定そのまま」= 上限内なら今までと1ミリも変わらない', () => {
  const L = laddersFor({ maxDim: 1000, quality: 0.5 });
  assert.deepEqual(L[0], { maxDim: 1000, quality: 0.5 });
  assert.ok(L.length > 1, '下げる段がある');
  for (let i = 1; i < L.length; i++) assert.ok(L[i].maxDim < L[i - 1].maxDim, '段は必ず小さくなる');
});

test('B05 240px を下回る段は作らない(何も判別できなくなる)', () => {
  laddersFor({ maxDim: 400, quality: 0.5 }).forEach(s => assert.ok(s.maxDim >= 240, `${s.maxDim}px は小さすぎる`));
});

test('B06 バイト数は「保存される文字数」で数える(推定しない)', () => {
  assert.equal(dataUrlBytes('data:image/jpeg;base64,AAAA'), 27);
  assert.equal(dataUrlBytes(null), 0);
});

test('B07 上限に収まった **最初の段** を採る(必要以上に落とさない)', () => {
  assert.deepEqual(pickStep([500, 300, 150, 90], 200), { index: 2, withinBudget: true });
  assert.deepEqual(pickStep([100, 90], 200), { index: 0, withinBudget: true }, '1段目で収まるなら1段目');
});

test('B08 ⚠どの段でも収まらない時は、最後の段を使って「超えている」と伝える(黙って捨てない)', () => {
  const r = pickStep([900, 800, 700], 200);
  assert.deepEqual(r, { index: 2, withinBudget: false });
  assert.match(shrinkNote({ before: 900, after: 700, stepIndex: 2, withinBudget: false, budget: 200 * 1024 }), /超えています/);
});

test('B09 ⚠毎回は聞かない。段が下がった時だけ聞く', () => {
  assert.equal(shouldConfirm(0), false, '今までと同じなら聞かない');
  assert.equal(shouldConfirm(1), true, '見た目が変わったら聞く');
  assert.equal(shrinkNote({ stepIndex: 0 }), '', '縮んでいない時は何も言わない');
});

test('B10 知らせる文には 元→後 の実測と、決まりの容量が必ず入る', () => {
  const t = shrinkNote({ before: 3.2 * 1024 * 1024, after: 240 * 1024, stepIndex: 2, withinBudget: true, budget: 300 * 1024 });
  assert.match(t, /3277KB → 240KB/);
  assert.match(t, /300KB までの決まり/);
  assert.equal(fmtKB(1024), '1KB');
});
