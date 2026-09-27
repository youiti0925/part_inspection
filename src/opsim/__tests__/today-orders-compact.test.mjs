// 📐 2026-09-18 夜 清水さん「この表示が無駄にでかすぎて枠とってる…シュミレーションをメインでちゃんと映るようにして」
//   今日の指示の既定は 1人1行(いま → 次)。大きな札は「▾ くわしく」で開く。1文字も消さない。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(HERE, '..', 'TodayOrders.jsx'), 'utf8').replace(/\r\n/g, '\n');

test('TC-1 既定は畳んだ形。開閉の state はガード(return null)より上に在る', () => {
  assert.ok(SRC.includes('defaultOpen = false,'), '既定が畳んだ形でない');
  const iState = SRC.indexOf('const [open, setOpen] = React.useState(!!defaultOpen);');
  const iGuard = SRC.indexOf('if (!rows.length) return null;');
  assert.ok(iState > 0 && iGuard > 0 && iState < iGuard, 'hooks がガードより後ろに在る(画面が丸ごと消える形)');
});

test('TC-2 畳んだ形は 1人1行: 名前・いま・次。押す所は 44px・分担の相手も出る', () => {
  const i = SRC.indexOf('function OrderChip('); assert.ok(i > 0, 'OrderChip が無い');
  const body = SRC.slice(i, SRC.indexOf('\n}\n', i));
  assert.ok(body.includes('data-today-order-compact="1"') && body.includes('data-today-order-worker={name}'), '目印が無い');
  assert.ok(body.includes('data-today-order-now=') && body.includes('data-today-order-next='), 'いま／次 の押す口が無い');
  assert.equal((body.match(/<button/g) || []).length, (body.match(/min-h-11/g) || []).length - 1, '押す物が 44px でない(min-h-11 は いま・次・割付なしの行 の3つ)');
  assert.ok(body.includes('order.nowWith'), '分担の相手が畳んだ形から消えている');
  assert.ok(body.includes('この先、今日の割付はありません'), '割付が無い時の言葉が無い');
});

test('TC-3 大きな札は消していない: 「▾ くわしく」で今までの OrderCard がそのまま出る', () => {
  assert.ok(SRC.includes("data-today-orders-toggle={open ? 'open' : 'compact'}"), '開く札が無い');
  assert.ok(/\{!open \? \([\s\S]*?<OrderChip[\s\S]*?\) : \([\s\S]*?<OrderCard/.test(SRC), '畳んだ形と大きな札の切替になっていない');
  assert.ok(SRC.includes('function OrderCard('), '大きな札の部品が消えている');
});
