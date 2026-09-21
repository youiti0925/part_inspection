// 品目名簿 (品目コード → 品名) の純関数の試験。2026-09-21
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeItemMaster, resolveItemName, itemMasterRows,
  unregisteredItems, itemNameConflicts, withItem, withoutItem,
} from '../itemMaster.js';

const lot = (model, modelText) => ({ model, modelText });

test('IM-1 名簿の形を整える: 空の鍵・空の名前・前後の空白を落とす', () => {
  assert.deepEqual(
    normalizeItemMaster({ ' MB-200.5 ': ' ベアリング ', '': 'x', 'A-1': '', 'B-1': null }),
    { 'MB-200.5': 'ベアリング' },
  );
  assert.deepEqual(normalizeItemMaster(null), {});
  assert.deepEqual(normalizeItemMaster('文字列'), {});
});

test('IM-2 品名の決め方: ロット自身の品目テキストが最優先、空なら名簿で補う', () => {
  const m = { 'MB-200.5': '名簿の名前' };
  assert.equal(resolveItemName('MB-200.5', 'ロットの名前', m), 'ロットの名前');
  assert.equal(resolveItemName('MB-200.5', '   ', m), '名簿の名前');
  assert.equal(resolveItemName('MB-200.5', null, m), '名簿の名前');
  assert.equal(resolveItemName('知らないコード', '', m), '');
  assert.equal(resolveItemName('', '', m), '');
  // 名簿が無くても落ちない
  assert.equal(resolveItemName('MB-200.5', '', null), '');
});

test('IM-3 名簿の一覧: 品目コード順で、使っているロットの数がつく', () => {
  const rows = itemMasterRows(
    { 'B-2': '名前B', 'A-1': '名前A' },
    [lot('A-1', ''), lot('A-1', ''), lot('C-3', ''), lot('', '')],
  );
  assert.deepEqual(rows, [
    { code: 'A-1', name: '名前A', lotCount: 2 },
    { code: 'B-2', name: '名前B', lotCount: 0 },
  ]);
});

test('IM-4 名簿に無い品目コード: ロットの多い順、候補の品名は一番多く名乗られている物', () => {
  const out = unregisteredItems({ 'A-1': '登録済み' }, [
    lot('A-1', '登録済み'),
    lot('Z-9', 'ハウジング'),
    lot('Z-9', 'ハウジング'),
    lot('Z-9', '筐体'),
    lot('M-1', ''),
  ]);
  assert.deepEqual(out.map((x) => x.code), ['Z-9', 'M-1']);
  assert.equal(out[0].lotCount, 3);
  assert.equal(out[0].suggestedName, 'ハウジング');
  assert.deepEqual(out[0].suggestions, ['ハウジング', '筐体']);
  // 品名を一度も名乗っていないコードは候補が空 (勝手に埋めない)
  assert.equal(out[1].suggestedName, '');
});

test('IM-5 名簿と食い違う品名を見つける (名簿に載っているコードだけ)', () => {
  const out = itemNameConflicts({ 'A-1': '正しい名前', 'B-2': '名前B' }, [
    lot('A-1', '正しい名前'),
    lot('A-1', 'ちがう名前'),
    lot('A-1', 'ちがう名前'),
    lot('B-2', '名前B'),
    lot('Z-9', '名簿に無い'),   // 名簿に無い物はここには出さない
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].code, 'A-1');
  assert.equal(out[0].masterName, '正しい名前');
  assert.deepEqual(out[0].lotNames, [{ name: 'ちがう名前', lotCount: 2 }]);
  assert.equal(out[0].lotCount, 2);
});

test('IM-6 名簿の足し引きは元を触らない。空は受け付けない', () => {
  const base = Object.freeze({ 'A-1': '名前A' });
  const added = withItem(base, ' B-2 ', ' 名前B ');
  assert.deepEqual(added, { 'A-1': '名前A', 'B-2': '名前B' });
  assert.deepEqual(base, { 'A-1': '名前A' });
  assert.equal(withItem(base, '', '名前'), null);
  assert.equal(withItem(base, 'A-1', '   '), null);
  assert.deepEqual(withoutItem(base, 'A-1'), {});
  assert.deepEqual(base, { 'A-1': '名前A' });
});

test('IM-7 ドットの入る品目コードをそのまま鍵にできる', () => {
  const m = withItem({}, 'MB-200.5', 'ベアリングハウジング');
  assert.deepEqual(m, { 'MB-200.5': 'ベアリングハウジング' });
  assert.equal(resolveItemName('MB-200.5', '', m), 'ベアリングハウジング');
  assert.deepEqual(withoutItem(m, 'MB-200.5'), {});
});
