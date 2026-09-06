// 📦 検査リスト「指図ごとにまとめる」(2026-09-06・製品検査から移植)の見張り。部品検査には到着予定の口が無い。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOf } from './_code.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const app = codeOf(path.resolve(HERE, '..', '..', 'App.jsx'));
const listAt = app.indexOf('const InspectionListView = (');
assert.ok(listAt >= 0, 'InspectionListView が見つからない');
const list = app.slice(listAt, listAt + 60000);
const cardAt = app.indexOf('const OrderGroupCard = (');
assert.ok(cardAt >= 0, 'OrderGroupCard が見つからない');
const card = app.slice(cardAt, listAt);

test('G1 押す口(data-list-group-toggle)が在り、押した時だけ まとめ表示(グリッド／リストは残る)', () => {
  assert.match(list, /const \[groupByOrder, setGroupByOrder\] = useState\(false\);/, '既定で まとめ表示になっている／覚えが無い');
  assert.ok(list.includes("data-list-group-toggle={groupByOrder ? '1' : '0'}"), '押す口が無い');
  assert.match(list, /groupByOrder \? \(\s*<div data-order-group-grid="1"/, '押した時だけ描く形になっていない');
  assert.match(list, /\) : viewMode === 'grid' \? \(/, 'グリッド表示が消えている');
});

test('G2 同じ指図で束ね、完了ロットも足す(「終わったか」が分かる)', () => {
  const i = list.indexOf('const orderGroups = useMemo(');
  assert.ok(i >= 0, 'orderGroups が無い');
  const block = list.slice(i, i + 1400);
  assert.match(block, /sortedLots\.forEach/, '絞り込み・並び替え済み(sortedLots)から束ねていない');
  assert.match(block, /l\.status === 'completed' \|\| l\.location === 'completed'/, '同じ指図の完了ロットを足していない');
});

test('G3 1枚の中身: テンプレ名・台数・入荷・納期・状態・誰が。台数は足さない(同じ台を別テンプレで見る)', () => {
  for (const s of ['tplName(lot)', 'lot.quantity', 'fmtMd(lot.entryAt)', 'fmtDueShort(lot.dueDate)', 'data-order-group-state={st.key}', 'st.who']) {
    assert.ok(card.includes(s), `1枚に ${s} が無い`);
  }
  assert.match(card, /Math\.max\(a, Number\(l\.quantity\) \|\| 0\)/, '台数を足している');
  const st = app.slice(app.indexOf('const lotStateForGroup = ('), cardAt);
  assert.match(st, /t\.workerName/, '誰が今やっているかを作業中タスクの workerName から読んでいない');
  assert.match(st, /computeLotProgress\(lot\)/, '進捗を既存の computeLotProgress で読んでいない');
  assert.match(st, /isTemplateSkippedLot\(lot\)/, 'スキップのロットを状態に出していない');
});

test('G4 行を押すと そのロットの割当画面が開く', () => {
  assert.match(card, /data-order-group-row=\{lot\.id\}[^>]*onClick=\{\(\) => onOpen\(lot\)\}/, '行が押せない');
  assert.match(list, /onOpen=\{\(lot\) => setAssignmentLot\(lot\)\}/, '押しても割当画面に繋がっていない');
});
