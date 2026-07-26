import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutbox, createMemoryStore, STATUS } from '../outbox.js';
import { DATA_DELETE, DATA_SERVER_NOW, sentinelKind } from '../sentinels.js';

const mk = (over = {}) => {
  const applied = [];
  let online = true;
  const behavior = over.behavior || (() => ({ ok: true }));
  const store = over.store || createMemoryStore();
  const ob = createOutbox({
    store,
    deviceId: 'dev1',
    backoffMs: 1, maxBackoffMs: 2, maxTries: over.maxTries ?? 3,
    isOnline: () => online,
    apply: async (cmd) => { applied.push(cmd); return behavior(cmd, applied.length); },
    ...over.opts,
  });
  return { ob, applied, store, setOnline: (v) => { online = v; }, isOnline: () => online };
};
const settle = () => new Promise((r) => setTimeout(r, 30));

test('O01 つながっていれば、入れたらすぐ送られて箱は空になる', async () => {
  const { ob, applied } = mk();
  await ob.enqueue({ op: 'save', ns: 'A', col: 'lots', docId: 'x', patch: { a: 1 } });
  await settle();
  assert.equal(applied.length, 1);
  assert.deepEqual((await ob.summary()).total, 0);
});

test('O02 電波が切れている間は箱に残る(捨てない)', async () => {
  const { ob, applied, setOnline } = mk();
  setOnline(false);
  await ob.enqueue({ op: 'save', ns: 'A', col: 'lots', docId: 'x', patch: { a: 1 } });
  await settle();
  assert.equal(applied.length, 0, '切れているのに送ろうとした');
  const s = await ob.summary();
  assert.deepEqual({ total: s.total, pending: s.pending }, { total: 1, pending: 1 });
});

test('O03 つながったら自動で送られる', async () => {
  const { ob, applied, setOnline } = mk();
  setOnline(false);
  await ob.enqueue({ op: 'save', ns: 'A', col: 'lots', docId: 'x', patch: { a: 1 } });
  await ob.enqueue({ op: 'save', ns: 'A', col: 'lots', docId: 'y', patch: { b: 2 } });
  await settle();
  assert.equal(applied.length, 0);
  setOnline(true);
  await ob.drain(); await settle();
  assert.equal(applied.length, 2);
  assert.equal((await ob.summary()).total, 0);
});

test('O04 順番を守る(同じ書類への保存が入れ替わると結果が変わる)', async () => {
  const { ob, applied, setOnline } = mk();
  setOnline(false);
  for (const v of [1, 2, 3]) await ob.enqueue({ op: 'save', ns: 'A', col: 'lots', docId: 'x', patch: { v } });
  setOnline(true);
  await ob.drain(); await settle();
  assert.deepEqual(applied.map((c) => c.patch.v), [1, 2, 3]);
});

test('O05 通信に失敗したら消さずに残し、回数を数えて待ってから送り直す', async () => {
  let n = 0;
  const { ob, applied } = mk({ behavior: () => { n++; if (n < 3) throw new Error('切れました'); return { ok: true }; } });
  await ob.enqueue({ op: 'save', ns: 'A', col: 'lots', docId: 'x', patch: { a: 1 } });
  await settle();
  // 1回目で失敗 → 箱に残っている
  let rows = await ob.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tries, 1);
  assert.equal(rows[0].status, STATUS.PENDING);
  await new Promise((r) => setTimeout(r, 10));
  await ob.drain(); await settle();
  await ob.drain(); await settle();
  assert.equal((await ob.summary()).total, 0, `まだ残っている(applied=${applied.length})`);
});

test('O06 何度やっても送れないものは failed にして残す(黙って捨てない)', async () => {
  const { ob } = mk({ maxTries: 2, behavior: () => { throw new Error('だめ'); } });
  await ob.enqueue({ op: 'save', ns: 'A', col: 'lots', docId: 'x', patch: { a: 1 } });
  for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r, 5)); await ob.drain(); await settle(); }
  const rows = await ob.list();
  assert.equal(rows.length, 1, '消えてしまった');
  assert.equal(rows[0].status, STATUS.FAILED);
  assert.match(rows[0].lastError, /だめ/);
});

test('O07 ぶつかったら黙って上書きせず、人が見られるように残す', async () => {
  const { ob } = mk({ behavior: () => ({ conflict: true, detail: '他の端末が先に保存しました' }) });
  await ob.enqueue({ op: 'save', ns: 'A', col: 'lots', docId: 'x', patch: { a: 1 }, opts: { merge: false } });
  await settle();
  const rows = await ob.list();
  assert.equal(rows[0].status, STATUS.CONFLICT);
  assert.equal((await ob.summary()).conflict, 1);
});

test('O08 やり直すと、もう一度送られる', async () => {
  let fail = true;
  const { ob, applied } = mk({ behavior: () => (fail ? { conflict: true, detail: 'x' } : { ok: true }) });
  const id = await ob.enqueue({ op: 'save', ns: 'A', col: 'lots', docId: 'x', patch: { a: 1 } });
  await settle();
  assert.equal((await ob.summary()).conflict, 1);
  fail = false;
  await ob.retry(id); await settle();
  assert.equal((await ob.summary()).total, 0);
  assert.equal(applied.length, 2);
});

test('O09 人が捨てると決めた時だけ消える', async () => {
  const { ob } = mk({ behavior: () => ({ conflict: true, detail: 'x' }) });
  const id = await ob.enqueue({ op: 'save', ns: 'A', col: 'lots', docId: 'x', patch: { a: 1 } });
  await settle();
  await ob.discard(id);
  assert.equal((await ob.summary()).total, 0);
});

test('O10 命令の名前は端末ごとに違い、重ならない', async () => {
  const a = mk(); const b = mk({ opts: { deviceId: 'dev2' } });
  const ids = new Set();
  for (let i = 0; i < 20; i++) {
    ids.add(await a.ob.enqueue({ op: 'save', ns: 'A', col: 'c', docId: 'x', patch: {} }));
    ids.add(await b.ob.enqueue({ op: 'save', ns: 'A', col: 'c', docId: 'x', patch: {} }));
  }
  assert.equal(ids.size, 40, '同じ名前の命令ができた');
});

test('O11 ⚠印(消す/サーバ時刻)が箱を通っても壊れない', async () => {
  // Firestore の deleteField() は IndexedDB に入らない(構造化複製できない)。
  // だから印を「ただのオブジェクト」にしてある。ここが崩れると
  // オフライン保存だけ削除が効かない、という気づきにくい不具合になる。
  const { ob, applied, setOnline } = mk();
  setOnline(false);
  await ob.enqueue({ op: 'save', ns: 'A', col: 'lots', docId: 'x', patch: { gone: DATA_DELETE, at: DATA_SERVER_NOW } });
  // 端末に保存された形(JSON と structuredClone を通す)
  const raw = (await ob.list())[0];
  const roundTripped = JSON.parse(JSON.stringify(raw));
  assert.equal(sentinelKind(roundTripped.patch.gone), 'delete');
  assert.equal(sentinelKind(structuredClone(raw).patch.at), 'serverNow');
  setOnline(true); await ob.drain(); await settle();
  assert.equal(sentinelKind(applied[0].patch.gone), 'delete');
});

test('O12 送信待ちの件数が画面へ伝わる', async () => {
  const seen = [];
  const { ob, setOnline } = mk({ opts: { onChange: (s) => seen.push(s.pending) } });
  setOnline(false);
  await ob.enqueue({ op: 'save', ns: 'A', col: 'c', docId: '1', patch: {} });
  await ob.enqueue({ op: 'save', ns: 'A', col: 'c', docId: '2', patch: {} });
  await settle();
  assert.ok(seen.includes(2), `件数が伝わっていない: ${seen.join(',')}`);
});

test('O13 箱の中身は端末に残る(入れ物を作り直しても消えない)', async () => {
  const store = createMemoryStore();
  const first = mk({ store });
  first.setOnline(false);
  await first.ob.enqueue({ op: 'save', ns: 'A', col: 'c', docId: '1', patch: { a: 1 } });
  await settle();
  first.ob.stop();
  // ブラウザを閉じて開き直した想定 = 同じ置き場所から作り直す
  const second = mk({ store });
  const rows = await second.ob.list();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].patch, { a: 1 });
  await second.ob.drain(); await settle();
  assert.equal(second.applied.length, 1);
});
