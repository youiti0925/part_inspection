// =============================================================================
// 🗣 2026-09-18 案A: 「今日の指示」(opsim/TodayOrders.jsx)の休みの言葉の表(AWAY_LABEL)と、
//   エンジン(simulate.js)の AWAY_STATUS_LABEL は **同じ記号に同じ言葉** でなければならない。
//   片方だけ言い換えると、帯の理由と今日の指示の札で「休み／他の作業／◯◯検査の応援」が食い違う。
//   (simulate.js は触らない決まりなので export して共有せず、この見張りで同じ物と保証する)
// 🚨 表が見つからなければ赤(黙って緑にしない)。
// =============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

const tableOf = (src, name) => {
  const m = src.match(new RegExp(`const ${name} = Object\\.freeze\\(\\{([\\s\\S]*?)\\}\\);`));
  assert.ok(m, `${name} の表が見つかりません`);
  const out = {};
  for (const pair of m[1].matchAll(/(?:'([^']+)'|([A-Za-z_]+))\s*:\s*'([^']*)'/g)) out[pair[1] || pair[2]] = pair[3];
  return out;
};

test('AW-1 今日の指示の休みの言葉は、エンジンの言葉と1文字も違わない', () => {
  const ui = tableOf(read('opsim/TodayOrders.jsx'), 'AWAY_LABEL');
  const engine = tableOf(read('domain/operationsSimulation/simulate.js'), 'AWAY_STATUS_LABEL');
  assert.ok(Object.keys(ui).length >= 4, `AWAY_LABEL の記号が少なすぎます: ${JSON.stringify(ui)}`);
  assert.deepEqual(ui, engine, '今日の指示(AWAY_LABEL) と エンジン(AWAY_STATUS_LABEL) の 記号→言葉 が食い違っています');
});

test('AW-2 応援の言葉は「◯◯検査の応援」(2026-09-16 清水さん「どのグループ応援してるか記載して」)', () => {
  const ui = tableOf(read('opsim/TodayOrders.jsx'), 'AWAY_LABEL');
  assert.equal(ui['support:product'], '製品検査の応援');
  assert.equal(ui['support:final'], '最終検査の応援');
  assert.equal(ui.off, '休み');
});
