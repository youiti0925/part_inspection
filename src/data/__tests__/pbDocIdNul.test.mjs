// ============================================================================
// 🔒 2026-10-31 R28: 書く時に、書類の場所(ns・col・docId)に NUL(\u0000)を入れさせない(4アプリで同じ中身)
//   ・保管庫の窓口(pocketbaseBackend)の save / setFields / appendCapped は、手元にも送信待ちの箱にも入れずに投げる
//   ・書く所(pbDocStore)の save / setFields / appendCapped / commitVersion は投げる・createOnce / claimOnce は reason 'error'
//   ・サーバへは1回も送らない(偽サーバの create / update の回数が 0)
//   ・普通の docId(日本語・記号・数)は今までどおり書ける。読む・消すは断らない(前に入った物を消せる様に)
// ⚠本物のサーバは使わない。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDocStore, PbBadDocIdError, assertWritableDocKey, isWritableKeyPart } from '../pbDocStore.js';
import { createPocketbaseBackend } from '../pocketbaseBackend.js';
import { createMemoryStore } from '../outbox.js';

const NUL = '\u0000';
const BAD = [`lot${NUL}1`, `${NUL}`, `abc${NUL}`, '', null, undefined, {}, ['a']];

/** 呼ばれた回数を数える偽サーバ(何も無い docs)。 */
const makeServer = () => {
  const calls = { create: 0, update: 0, remove: 0, list: 0 };
  const rows = [];
  const srv = {
    calls, rows,
    isAuthed: () => true,
    listPage: async () => { calls.list++; return { items: [], totalItems: 0, totalPages: 1 }; },
    listAll: async () => { calls.list++; return []; },
    getOne: async () => null,
    create: async (col, data) => { calls.create++; const r = { id: `r${rows.length + 1}`, ...data }; rows.push(r); return r; },
    update: async (col, id, data) => { calls.update++; return { id, ...data }; },
    remove: async () => { calls.remove++; },
    subscribe: async () => () => {},
  };
  return srv;
};

test('N01 書類の場所の値の確かめ(純関数)', () => {
  for (const ok of ['lot1', '指図-001', 'a b', 'x/y', 12345, 'R'.repeat(200)]) assert.equal(isWritableKeyPart(ok), true, String(ok));
  for (const ng of BAD) assert.equal(isWritableKeyPart(ng), false, JSON.stringify(ng));
  assert.equal(isWritableKeyPart(NaN), false);
  assert.throws(() => assertWritableDocKey('final-inspection-v1', 'lots', `a${NUL}b`), (e) => e instanceof PbBadDocIdError && e.what === 'docId' && !e.message.includes(NUL));
  assert.throws(() => assertWritableDocKey(`final${NUL}`, 'lots', 'a'), (e) => e instanceof PbBadDocIdError && e.what === 'ns');
  assert.throws(() => assertWritableDocKey('final-inspection-v1', `lo${NUL}ts`, 'a'), (e) => e instanceof PbBadDocIdError && e.what === 'col');
  assert.doesNotThrow(() => assertWritableDocKey('final-inspection-v1', 'lots', '1001456630'));
});

test('N02 書く所(pbDocStore): NUL 入りは投げる・サーバへ送らない・普通の値は書ける', async () => {
  const srv = makeServer();
  const store = createDocStore(srv);
  const id = `lot${NUL}1`;
  await assert.rejects(store.save('final-inspection-v1', 'lots', id, { a: 1 }), PbBadDocIdError);
  await assert.rejects(store.setFields('final-inspection-v1', 'lots', id, { a: 1 }), PbBadDocIdError);
  await assert.rejects(store.appendCapped('final-inspection-v1', 'lots', id, 'log', { a: 1 }), PbBadDocIdError);
  await assert.rejects(store.commitVersion('final-inspection-v1', { headCol: 'plans', headId: 'head', versionCol: 'planVersions', versionId: `v${NUL}1`, expectRevision: 0, versionDoc: {}, headDoc: {} }), PbBadDocIdError);
  await assert.rejects(store.commitVersion('final-inspection-v1', { headCol: 'plans', headId: 'head', versionCol: 'planVersions', versionId: 'v1', expectRevision: 0, versionDoc: {}, headDoc: {}, chunks: [{ id: `c${NUL}`, doc: {} }] }), PbBadDocIdError);
  const co = await store.createOnce('final-inspection-v1', 'lots', id, { a: 1 });
  assert.equal(co.acquired, false); assert.equal(co.reason, 'error'); assert.ok(co.error instanceof PbBadDocIdError);
  const cl = await store.claimOnce('final-inspection-v1', 'lots', id, {}, { a: 1 });
  assert.equal(cl.acquired, false); assert.equal(cl.reason, 'error'); assert.ok(cl.error instanceof PbBadDocIdError);
  assert.equal(srv.calls.create, 0, 'サーバへ作る要求を送っていない');
  assert.equal(srv.calls.update, 0);
  assert.equal(srv.calls.list, 0, '読みにも行かない(書く前に断る)');
  // 普通の値は書ける
  const r = await store.save('final-inspection-v1', 'lots', '指図-001', { a: 1 });
  assert.equal(r.created, true);
  assert.equal(srv.calls.create, 1);
  assert.equal(srv.rows[0].docId, '指図-001');
  // 消すは断らない(前に入った物を消せる様に)
  await assert.doesNotReject(store.remove('final-inspection-v1', 'lots', id));
});

test('N03 保管庫の窓口(pocketbaseBackend): NUL 入りは手元にも送信待ちの箱にも入れずに投げる', async () => {
  const srv = makeServer();
  const box = createMemoryStore();
  const be = createPocketbaseBackend(srv, { outboxStore: box, autoRealtime: false });
  const id = `lot${NUL}1`;
  await assert.rejects(be.save('final-inspection-v1', 'lots', id, { a: 1 }), PbBadDocIdError);
  await assert.rejects(be.save('final-inspection-v1', 'lots', id, { a: 1 }, { merge: false }), PbBadDocIdError);
  await assert.rejects(be.setFields('final-inspection-v1', 'lots', id, { a: 1 }), PbBadDocIdError);
  await assert.rejects(be.appendCapped('final-inspection-v1', 'lots', id, 'log', { a: 1 }), PbBadDocIdError);
  await assert.rejects(be.save(`final${NUL}`, 'lots', 'ok', { a: 1 }), PbBadDocIdError);
  assert.equal((await box.all()).length, 0, '送信待ちの箱は空のまま');
  assert.equal(srv.calls.create, 0); assert.equal(srv.calls.update, 0);
  // 普通の値は今までどおり受け付ける(断らない)
  await assert.doesNotReject(be.save('final-inspection-v1', 'lots', 'ok-1', { a: 1 }));
  await assert.doesNotReject(be.setFields('final-inspection-v1', 'lots', 1001456630, { a: 2 }));
  try { be.close(); } catch { /* 済 */ }
});
