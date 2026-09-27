// =============================================================================
// 🤝 2026-09-18 案A: 「今日の指示」は、同じロットを台ごとに2人で分担している時に **相手の名前** を添える。
//   確かめ役の実測(最終): 坂井の「次」のロットが納期一覧では 村 の担当と出て食い違って見えた
//   (納期一覧は主担当1人しか出さない)。嘘ではないが黙っていると分からない。
//   ここは本物の .jsx を読んで、その決まりが **割付をそのまま読むだけ**(数を作らない)で書かれている事を見張る。
// =============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(HERE, '..', 'TodayOrders.jsx'), 'utf8').replace(/\r\n/g, '\n');

test('SL-1 分担の相手は、その日の窓の中で同じロットに手を付ける ほかの人(worker/partner)を割付から読むだけ', () => {
  const i = SRC.indexOf('const withOf = (item) => {');
  assert.ok(i > 0, 'withOf が無い');
  const body = SRC.slice(i, SRC.indexOf('};', i));
  assert.ok(/String\(a\.lotId\) === id/.test(body), '同じロットで絞っていない');
  assert.ok(/Number\(a\.endMs\) > winStartMs && Number\(a\.startMs\) < winEndMs/.test(body), 'その日の窓で絞っていない');
  assert.ok(/\[str\(a\.worker\), str\(a\.partner\)\]/.test(body), 'worker と partner の両方を読んでいない');
  assert.ok(/w !== nm/.test(body), '本人を除いていない');
  assert.ok(!/Date\.now|Math\.random/.test(body), '時刻や乱数を作っている');
  assert.ok(/nowWith: withOf\(now\), nextWith: withOf\(next\)/.test(SRC), 'いま／次 の両方に相手を付けていない');
});

test('SL-2 札には「＋◯◯と分担」と出る(いま と 次 の両方・目印つき)。相手が居なければ1文字も出さない', () => {
  assert.ok(SRC.includes('data-today-order-with='), 'いま の分担の目印が無い');
  assert.ok(SRC.includes('data-today-order-next-with='), '次 の分担の目印が無い');
  assert.equal((SRC.match(/と分担`\}/g) || []).length, 2, '「＋◯◯と分担」の札が いま と 次 の2つでない');
  assert.ok(/arr\(order\.nowWith\)\.length \? <span/.test(SRC) && /arr\(order\.nextWith\)\.length \? <span/.test(SRC), '相手が居ない時に札を出さない形になっていない');
});
