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

// ----------------------------------------------------------------------------
// 2026-10-03 setFields の鍵の「.」は道の区切り(Firestore の updateDoc と同じ)  ※ golden-pb から移植(2026-11-10)
//   ロットの保存は「押した所だけ」を { 'tasks.a-0.status': 値 } で送る(domain/lotPatchScope.js toUpdateFields)。
//   前は 'tasks.a-0.status' という名前のゴミの項目を作り、本当の台は変わらなかった
//   (社内版の家の試しで実測: 最終の H-2001 に平たい鍵 45 個・tasks 無し → 読み直すと進捗 0%)。
// ----------------------------------------------------------------------------
test('M16 点区切りの道は、その台だけを差し替える(他の台を消さない)', () => {
  const cur = { tasks: { 'a-0': { status: 'waiting' }, 'a-1': { status: 'completed', by: 'B' } }, name: 'L1' };
  const out = setFieldsDoc(cur, { 'tasks.a-0': { status: 'completed', by: 'A' } });
  assert.deepEqual(out, { tasks: { 'a-0': { status: 'completed', by: 'A' }, 'a-1': { status: 'completed', by: 'B' } }, name: 'L1' });
  assert.equal('tasks.a-0' in out, false, '名前に点を含むゴミの項目を作らない');
  assert.deepEqual(cur.tasks['a-0'], { status: 'waiting' }, '元は書き換えない');
});

test('M17 深い道(tasks.a-0.status)は末端の1項目だけ・途中の段は残す', () => {
  const cur = { tasks: { 'a-0': { status: 'waiting', note: 'x' } } };
  const out = setFieldsDoc(cur, { 'tasks.a-0.status': 'processing', updatedAt: 5 });
  assert.deepEqual(out, { tasks: { 'a-0': { status: 'processing', note: 'x' } }, updatedAt: 5 });
});

test('M18 途中の段が無ければ作る / 消す印は末端だけ消し、無い段は作らない', () => {
  assert.deepEqual(setFieldsDoc({}, { 'tasks.a-0': { s: 1 } }), { tasks: { 'a-0': { s: 1 } } });
  assert.deepEqual(setFieldsDoc({ tasks: 3 }, { 'tasks.a-0': 1 }), { tasks: { 'a-0': 1 } }, 'マップでない段はマップに置き換える(Firestore と同じ)');
  assert.deepEqual(setFieldsDoc({ tasks: { 'a-0': 1, 'a-1': 2 } }, { 'tasks.a-1': DATA_DELETE }), { tasks: { 'a-0': 1 } });
  assert.deepEqual(setFieldsDoc({ a: 1 }, { 'tasks.a-1': DATA_DELETE }), { a: 1 }, '消す先が無ければ何も作らない');
});

test('M19 点区切りの鍵と丸ごとの鍵を混ぜても、送った所だけが変わる', () => {
  const cur = { tasks: { 'a-0': 1, 'a-1': 2 }, measurementResults: { k1: 'old', k2: 'keep' }, steps: [1] };
  const out = setFieldsDoc(cur, { 'tasks.a-1': 20, 'measurementResults.k1': 'new', steps: [9], updatedAt: DATA_SERVER_NOW });
  assert.deepEqual(out.tasks, { 'a-0': 1, 'a-1': 20 });
  assert.deepEqual(out.measurementResults, { k1: 'new', k2: 'keep' });
  assert.deepEqual(out.steps, [9]);
  assert.equal(out.updatedAt, DATA_SERVER_NOW, 'サーバ時刻の印は残す(サーバ側で埋める)');
});

test('M20 merge で空のマップ {} を送ると、その場所は空になる(Firestore と同じ・workTimeGuard の前提)', () => {
  const cur = { tasks: { 'a-0': { s: 1 } }, nested: { m: { x: 1 }, keep: 2 } };
  assert.deepEqual(mergeDoc(cur, { tasks: {} }), { tasks: {}, nested: { m: { x: 1 }, keep: 2 } });
  assert.deepEqual(mergeDoc(cur, { nested: { m: {} } }), { tasks: { 'a-0': { s: 1 } }, nested: { m: {}, keep: 2 } }, '深い所の {} も同じ');
  assert.deepEqual(mergeDoc(cur, {}), cur, '本体そのものが {} なら何も変わらない');
});

test('M21 実際の不具合の再現(社内版 2026-11-10): toUpdateFields が作る末端の道を何台分送っても、tasks の入れ子に入る', () => {
  // 作業画面で工程を押した時の形(domain/lotPatchScope.js toUpdateFields の出力)そのまま
  const cur = { orderNo: 'H-2001', steps: [{ id: 's1' }, { id: 's2' }], completeNotified: { parts: { old: { qty: 1 } } } };
  const fields = {
    'tasks.s1-0.status': 'completed', 'tasks.s1-0.duration': 60, 'tasks.s1-0.startTime': null,
    'tasks.s2-0.status': 'completed', 'tasks.s2-0.workerName': '見本 太郎',
    'completeNotified.parts.cr-1.qty': 1, 'completeNotified.at': 5,
    updatedAt: DATA_SERVER_NOW,
  };
  const out = setFieldsDoc(cur, fields);
  assert.deepEqual(Object.keys(out).filter((k) => k.includes('.')), [], '平たい「a.b.c」の鍵を1つも作らない');
  assert.deepEqual(out.tasks, { 's1-0': { status: 'completed', duration: 60, startTime: null }, 's2-0': { status: 'completed', workerName: '見本 太郎' } });
  assert.deepEqual(out.completeNotified, { parts: { old: { qty: 1 }, 'cr-1': { qty: 1 } }, at: 5 }, '送らなかった枝(old)は残す');
  assert.deepEqual(out.steps, cur.steps);
});
