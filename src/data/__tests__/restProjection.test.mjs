// 📉 項目を選ぶ読み(getPageFields)の試験。
// ⚠ここで押さえるのは「数字が1つも変わらない」事と「落ちた時に黙らない」事の2つ。
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRestValue, decodeRestDoc, createFirebaseBackend } from '../provider.js';

test('REST の値をほどく: 数は必ず数に戻す(文字のままにしない)', () => {
  assert.equal(decodeRestValue({ integerValue: '2048' }), 2048);
  assert.equal(decodeRestValue({ doubleValue: 1.5 }), 1.5);
  assert.equal(decodeRestValue({ stringValue: 'L1' }), 'L1');
  assert.equal(decodeRestValue({ booleanValue: true }), true);
  assert.equal(decodeRestValue({ nullValue: null }), null);
});

test('🚨 数を文字のまま足すと容量の数字が化ける(だから数に戻す)', () => {
  const rows = [{ bytes: decodeRestValue({ integerValue: '100' }) }, { bytes: decodeRestValue({ integerValue: '200' }) }];
  assert.equal(rows.reduce((n, r) => n + r.bytes, 0), 300);   // '100200' にならない
});

test('REST の値をほどく: 入れ子(配列・マップ)も戻す', () => {
  assert.deepEqual(decodeRestValue({ arrayValue: { values: [{ stringValue: 'a' }, { integerValue: '2' }] } }), ['a', 2]);
  assert.deepEqual(decodeRestValue({ mapValue: { fields: { x: { integerValue: '7' } } } }), { x: 7 });
});

test('REST の書類をほどく: id は名前の最後から採る', () => {
  const d = decodeRestDoc({ name: 'projects/p/databases/(default)/documents/artifacts/ns/public/data/lot_images/abc123',
    fields: { lotId: { stringValue: 'L1' }, kind: { stringValue: 'pkg' } } });
  assert.deepEqual(d, { id: 'abc123', lotId: 'L1', kind: 'pkg' });
});

test('項目が空の書類でも id は取れる(0枚と読めないを混ぜない)', () => {
  assert.deepEqual(decodeRestDoc({ name: 'a/b/xyz' }), { id: 'xyz' });
});

// --- 落ちる道 ---------------------------------------------------------------
const fakeFs = (docs) => ({
  collection: () => ({}), doc: () => ({}), onSnapshot: () => () => {}, setDoc: async () => {},
  deleteDoc: async () => {}, getDoc: async () => ({ exists: () => false }),
  getDocs: async () => ({ docs: docs.map((d) => ({ id: d.id, data: () => ({ ...d, id: undefined }) })) }),
  serverTimestamp: () => 'now', deleteField: () => 'del', updateDoc: async () => {}, runTransaction: async () => {},
});
const fakeDb = { app: { options: { projectId: 'p' } }, _settings: { host: '127.0.0.1:8380', ssl: false } };

test('🚨 合言葉を渡す係が無い時は、黙らずに全部読みへ落ちる', async () => {
  const be = createFirebaseBackend(fakeDb, fakeFs([{ id: 'a' }, { id: 'b' }]));
  const r = await be.getPageFields('ns', 'lot_images', ['lotId'], {});
  assert.equal(r.projected, false);
  assert.match(r.fellBack, /getToken/);
  assert.equal(r.rows.length, 2, '落ちても件数は今までと同じ');
});

test('🚨 取る項目を書き忘れた時も、黙らずに全部読みへ落ちる', async () => {
  const be = createFirebaseBackend(fakeDb, fakeFs([{ id: 'a' }]));
  const r = await be.getPageFields('ns', 'lot_images', [], { getToken: async () => 't' });
  assert.equal(r.projected, false);
  assert.ok(r.fellBack.length > 0);
});

test('🚨 サーバが断ったら、黙らずに全部読みへ落ちる', async () => {
  const be = createFirebaseBackend(fakeDb, fakeFs([{ id: 'a' }, { id: 'b' }, { id: 'c' }]));
  globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => 'bad' });
  const r = await be.getPageFields('ns', 'lot_images', ['lotId'], { getToken: async () => 't' });
  assert.equal(r.projected, false);
  assert.match(r.fellBack, /400/);
  assert.equal(r.rows.length, 3);
});

test('通った時は projected:true で、落ちた印は空', async () => {
  const be = createFirebaseBackend(fakeDb, fakeFs([]));
  globalThis.fetch = async () => ({ ok: true, status: 200,
    json: async () => ([{ document: { name: 'a/b/z1', fields: { lotId: { stringValue: 'L9' } } } }]) });
  const r = await be.getPageFields('ns', 'lot_images', ['lotId'], { getToken: async () => 't' });
  assert.equal(r.projected, true);
  assert.equal(r.fellBack, '');
  assert.equal(r.fromCache, false, 'RESTで読めた返事はサーバ本体の物');
  assert.deepEqual(r.rows, [{ id: 'z1', lotId: 'L9' }]);
});

// --- 🚨 端末の控え(キャッシュ)を「全部」と信じない(2026-08-31 実機で発生) ---------
//   通信が死んでいると SDK は黙って控えの一部を返す。呼び元が見分けられるよう
//   fromCache を必ず返す。これが無いと「写真 全595枚」(本当は2,355枚)のような嘘が出る。
const fakeFsCache = (docs, fromCache) => ({
  ...fakeFs(docs),
  getDocs: async () => ({ docs: docs.map((d) => ({ id: d.id, data: () => ({ ...d, id: undefined }) })),
    metadata: { fromCache } }),
});

test('🚨 全部読みへ落ちた返事が控え(キャッシュ)なら fromCache:true と言う', async () => {
  const be = createFirebaseBackend(fakeDb, fakeFsCache([{ id: 'a' }], true));
  const r = await be.getPageFields('ns', 'lot_images', ['lotId'], {});   // getToken 無し → 全部読みへ
  assert.equal(r.projected, false);
  assert.equal(r.fromCache, true, '控えしか読めていない事を隠さない');
});

test('全部読みでもサーバ本体から読めたなら fromCache:false', async () => {
  const be = createFirebaseBackend(fakeDb, fakeFsCache([{ id: 'a' }], false));
  const r = await be.getPageFields('ns', 'lot_images', ['lotId'], {});
  assert.equal(r.projected, false);
  assert.equal(r.fromCache, false);
});

test('metadata を返さない保管庫(試験の偽物など)は fromCache:false 扱い(落とさない)', async () => {
  const be = createFirebaseBackend(fakeDb, fakeFs([{ id: 'a' }]));
  const r = await be.getPageFields('ns', 'lot_images', ['lotId'], {});
  assert.equal(r.fromCache, false);
});

// --- 📷📄(2026-10-03 夜)続きから読む(after = 前のページの最後の ID)。全件の整理を1回の上限で止めて、続きは人が押す為 ---
test('続きの位置(after): REST は __name__ の並びの時だけ startAt(before:false・書類の名前)で渡す', async () => {
  const be = createFirebaseBackend(fakeDb, fakeFs([]));
  let sent = null;
  globalThis.fetch = async (url, init) => { sent = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ([]) }; };
  await be.getPageFields('ns', 'lot_images', ['lotId'], { getToken: async () => 't', orderBy: [['__name__', 'asc']], limit: 1000, after: 'img00999' });
  assert.equal(sent.structuredQuery.limit, 1000);
  assert.deepEqual(sent.structuredQuery.orderBy, [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }]);
  assert.equal(sent.structuredQuery.startAt.before, false, 'その ID 自身をもう一度読まない');
  assert.match(sent.structuredQuery.startAt.values[0].referenceValue, /\/documents\/artifacts\/ns\/public\/data\/lot_images\/img00999$/);
  // 1ページ目(after 無し)は startAt を付けない
  await be.getPageFields('ns', 'lot_images', ['lotId'], { getToken: async () => 't', orderBy: [['__name__', 'asc']], limit: 1000 });
  assert.equal(sent.structuredQuery.startAt, undefined);
});

test('続きの位置(after): 全部読みへ落ちた時も同じ位置・上限を SDK に渡す(落ちても全件にしない)', async () => {
  const seen = [];
  const fs = { ...fakeFs([{ id: 'x' }]),
    query: (base, ...parts) => ({ base, parts }),
    where: (...a) => ({ where: a }), orderBy: (...a) => ({ orderBy: a }), startAfter: (v) => ({ startAfter: v }), limit: (n) => ({ limit: n }),
    getDocs: async (q) => { seen.push(q); return { docs: [], metadata: { fromCache: false } }; } };
  const be = createFirebaseBackend(fakeDb, fs);
  const r = await be.getPageFields('ns', 'lot_images', [], { orderBy: [['__name__', 'asc']], limit: 500, after: 'img00499' });
  assert.equal(r.projected, false);
  const parts = seen[0].parts;
  assert.deepEqual(parts, [{ orderBy: ['__name__', 'asc'] }, { startAfter: 'img00499' }, { limit: 500 }]);
});
