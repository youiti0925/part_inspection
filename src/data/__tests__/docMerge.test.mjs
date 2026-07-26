import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDoc, overwriteDoc, setFieldsDoc, serverNowPaths, hasServerNow, previewServerNow } from '../docMerge.js';
import { DATA_DELETE, DATA_SERVER_NOW } from '../sentinels.js';

// ⚠ここは Firestore の setDoc(merge:true) と **1バイトも違ってはいけない**。
//   違うと「消したはずのものが翌日復活する」類の不具合が全部戻ってくる。

test('M01 入れ子の map は再帰的に重ねる(送らなかったキーは残る)', () => {
  const cur = { a: { x: 1, y: 2 }, b: 9 };
  assert.deepEqual(mergeDoc(cur, { a: { y: 20, z: 30 } }), { a: { x: 1, y: 20, z: 30 }, b: 9 });
});

test('M02 配列は丸ごと差し替える(要素ごとに合体しない)', () => {
  assert.deepEqual(mergeDoc({ list: [1, 2, 3] }, { list: [9] }), { list: [9] });
});

test('M03 消す印が付いたキーだけが消える', () => {
  const out = mergeDoc({ a: 1, b: 2 }, { b: DATA_DELETE });
  assert.deepEqual(out, { a: 1 });
  assert.equal('b' in out, false);
});

test('M04 入れ子の1キーだけ消せる(ロスターの出勤戻し)', () => {
  const cur = { workerRoster: { '2026-07-27': { 田中: 'off', 佐藤: 'off' } } };
  const out = mergeDoc(cur, { workerRoster: { '2026-07-27': { 田中: DATA_DELETE } } });
  assert.deepEqual(out, { workerRoster: { '2026-07-27': { 佐藤: 'off' } } });
});

test('M05 元のオブジェクトを書き換えない', () => {
  const cur = { a: { x: 1 } };
  mergeDoc(cur, { a: { x: 2 }, b: DATA_DELETE });
  assert.deepEqual(cur, { a: { x: 1 } });
});

test('M06 サーバ時刻の印は残す(サーバ側で埋めるため)', () => {
  const out = mergeDoc({ a: 1 }, { updatedAt: DATA_SERVER_NOW });
  assert.equal(out.updatedAt, DATA_SERVER_NOW);
});

test('M07 今の中身が無ければ、差分がそのまま中身になる', () => {
  assert.deepEqual(mergeDoc(null, { a: 1 }), { a: 1 });
  assert.deepEqual(mergeDoc(undefined, { a: { b: 1 } }), { a: { b: 1 } });
});

test('M08 map 以外の値は差し替える(型が変わっても)', () => {
  assert.deepEqual(mergeDoc({ a: { x: 1 } }, { a: 'もじ' }), { a: 'もじ' });
  assert.deepEqual(mergeDoc({ a: 'もじ' }, { a: { x: 1 } }), { a: { x: 1 } });
});

test('M09 null は「値として」入る(キーを消すのとは別)', () => {
  // ⚠null と「キーが無い」を混ぜない。移行の照合で区別が要る。
  const out = mergeDoc({ a: 1 }, { a: null });
  assert.equal(out.a, null);
  assert.equal('a' in out, true);
});

test('M10 全上書きは、消す印のキーを最初から書かない', () => {
  assert.deepEqual(overwriteDoc({ a: 1, b: DATA_DELETE, c: { d: DATA_DELETE, e: 2 } }), { a: 1, c: { e: 2 } });
});

test('M11 setFields は入れ子を合体しない(丸ごと差し替える)', () => {
  // 抜取/スキップ設定の「許可OFF・条件クリア」がこれ。merge だと消えたキーが残る。
  const cur = { skipInspection: { on: true, rules: { a: 1, b: 2 } }, other: 'keep' };
  const out = setFieldsDoc(cur, { skipInspection: { on: false } });
  assert.deepEqual(out, { skipInspection: { on: false }, other: 'keep' });
});

test('M12 setFields でも消す印は効く', () => {
  assert.deepEqual(setFieldsDoc({ a: 1, b: 2 }, { b: DATA_DELETE }), { a: 1 });
});

test('M13 サーバ時刻の印の場所を全部拾える(入れ子・配列の中も)', () => {
  const paths = serverNowPaths({ t: DATA_SERVER_NOW, deep: { at: DATA_SERVER_NOW }, list: [{ at: DATA_SERVER_NOW }] });
  assert.deepEqual(paths.sort(), [['deep', 'at'], ['list', '0', 'at'], ['t']].sort());
  assert.equal(hasServerNow({ a: 1 }), false);
});

test('M14 previewServerNow は見た目の確認だけ(保存には使わない)', () => {
  // ⚠クライアントPCの時計で保存してはいけない。端末の時計は実際にずれている。
  const shown = previewServerNow({ t: DATA_SERVER_NOW }, '2026-07-27T00:00:00.000Z');
  assert.equal(shown.t, '2026-07-27T00:00:00.000Z');
});

test('M15 実際の不具合の再現: 特注工程を消した保存が「消えたまま」になる', () => {
  // 2026-07-26 に本番で直した不具合。merge:true は送らなかったキーを消さないので、
  // 消す印が無いと次の同期で復活していた。
  const server = { customSteps: { A: { on: true }, B: { on: true } }, name: 'ロット1' };
  const afterSave = mergeDoc(server, { customSteps: { B: DATA_DELETE } });
  assert.deepEqual(afterSave, { customSteps: { A: { on: true } }, name: 'ロット1' });
  // もう一度同じ差分を送っても結果は同じ(送信待ちの箱で二度送られても壊れない)
  assert.deepEqual(mergeDoc(afterSave, { customSteps: { B: DATA_DELETE } }), afterSave);
});
