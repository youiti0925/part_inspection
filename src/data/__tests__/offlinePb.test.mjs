// ============================================================================
// 📴 2026-11-02 社内版(PocketBase)で「サーバーに届かない間も使える」の試験
//   ① 送信待ちの箱: 届かない失敗は何回でも FAILED にしない / サーバーが断った時は今まで通り FAILED
//   ② 送信待ちの箱: 送っている最中に閉じた(SENDING のまま)物を、開き直した時に送る(前は二度と送らなかった)
//   ③ 送信待ちの箱: 前の版で「届かない」で FAILED になった物を、つながった時に戻して送る
//   ④ 保管庫: 端末の控え(readCache)— 読めた一覧を控え、届かない時に控えを出す(画面の onError は呼ばず onOfflineCache へ)
//   ⑤ 保管庫: 控えが無い時は今まで通り onError(空を「読めた」にしない)
//   ⑥ 保管庫: 購読の知らせ(1件)は控えにも1件だけ書く
//   ⑦ 「未送信 N 件」の札の数え方(outboxPending)
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutbox, createMemoryStore, STATUS, isNetworkFailure } from '../outbox.js';
import { createPocketbaseBackend } from '../pocketbaseBackend.js';
import { createMemoryReadCache } from '../readCache.js';
import { PbNetworkError, PbHttpError } from '../pbClient.js';
import { summarizeOutboxRows, countOutboxPending } from '../../offline/outboxPending.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NS = 'product-inspection-v1';

test('isNetworkFailure: 届かない(PbNetworkError・502/503/504・fetch の字)と、断られた(4xx)を分ける', () => {
  assert.equal(isNetworkFailure(new PbNetworkError(new TypeError('Failed to fetch'), '/api')), true);
  assert.equal(isNetworkFailure(new PbHttpError(503, 'x', '/api')), true);
  assert.equal(isNetworkFailure('PocketBase 通信失敗 https://kensa.local:8441/api/...: Failed to fetch'), true);
  assert.equal(isNetworkFailure(new PbHttpError(400, { code: 400 }, '/api')), false);
  assert.equal(isNetworkFailure(new PbHttpError(403, 'forbidden', '/api')), false);
  assert.equal(isNetworkFailure(null), false);
});

test('① 届かない失敗は何回続いても FAILED にしない(つながったら送る)', async () => {
  const store = createMemoryStore();
  let t = 0; let down = true; const sent = [];
  const ob = createOutbox({
    store, deviceId: 'd1', maxTries: 3, backoffMs: 1, maxBackoffMs: 4, now: () => t,
    apply: async (cmd) => { if (down) throw new PbNetworkError(new TypeError('Failed to fetch'), '/api'); sent.push(cmd.commandId); return { ok: true }; },
  });
  await ob.enqueue({ op: 'save', ns: NS, col: 'lots', docId: 'L1', patch: { a: 1 } });
  for (let i = 0; i < 20; i++) { t += 100; await ob.drain(); }
  const rows = await store.all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, STATUS.PENDING, '20回届かなくても PENDING のまま');
  assert.equal(rows[0].tries, 0, '断られた回数には数えない');
  down = false; t += 100; await ob.drain();
  assert.equal((await store.all()).length, 0, 'つながったら送れて箱から消える');
  assert.equal(sent.length, 1);
});

test('① サーバーが断った失敗は今まで通り maxTries で FAILED(人が見るまで残す)', async () => {
  const store = createMemoryStore();
  let t = 0;
  const ob = createOutbox({ store, deviceId: 'd1', maxTries: 3, backoffMs: 1, maxBackoffMs: 4, now: () => t,
    apply: async () => { throw new PbHttpError(400, { message: 'bad' }, '/api'); } });
  await ob.enqueue({ op: 'save', ns: NS, col: 'lots', docId: 'L1', patch: {} });
  for (let i = 0; i < 20; i++) { t += 100; await ob.drain(); await sleep(1); }
  assert.equal((await store.all())[0].status, STATUS.FAILED);
});

test('② SENDING のまま残った物(送っている最中に閉じた)は、開き直した最初の drain で送る', async () => {
  const store = createMemoryStore();
  await store.put({ commandId: 'old-1', seq: 1, status: STATUS.SENDING, tries: 0, createdAt: 0, nextAt: 0, op: 'save', ns: NS, col: 'lots', docId: 'L9', patch: { x: 1 } });
  const sent = [];
  const ob = createOutbox({ store, deviceId: 'd2', apply: async (cmd) => { sent.push(cmd.commandId); return { ok: true }; } });
  await ob.drain();
  assert.deepEqual(sent, ['old-1']);
  assert.equal((await store.all()).length, 0);
});

test('③ 前の版で「届かない」で FAILED になった物は、つながった合図で戻して送る(断られた FAILED は戻さない)', async () => {
  const store = createMemoryStore();
  await store.put({ commandId: 'net-1', seq: 1, status: STATUS.FAILED, tries: 8, createdAt: 0, nextAt: 0, lastError: 'PocketBase 通信失敗 https://x/api: Failed to fetch', op: 'save', ns: NS, col: 'lots', docId: 'A', patch: {} });
  await store.put({ commandId: 'bad-1', seq: 2, status: STATUS.FAILED, tries: 8, createdAt: 0, nextAt: 0, lastError: 'PocketBase 400 /api: bad', op: 'save', ns: NS, col: 'lots', docId: 'B', patch: {} });
  const sent = [];
  const listeners = {};
  const win = { addEventListener: (n, f) => { listeners[n] = f; }, removeEventListener: () => {} };
  const ob = createOutbox({ store, deviceId: 'd3', apply: async (cmd) => { sent.push(cmd.commandId); return { ok: true }; } });
  const detach = ob.attachToWindow(win);
  listeners.online();
  await sleep(30);
  detach();
  assert.deepEqual(sent, ['net-1']);
  const left = await store.all();
  assert.equal(left.length, 1); assert.equal(left[0].commandId, 'bad-1'); assert.equal(left[0].status, STATUS.FAILED);
});

test('③ つながった合図(app-reconnected)で、届かずに待っている物をすぐ送る(最大60秒を待たない)', async () => {
  const store = createMemoryStore();
  let t = 1000; let down = true; const sent = [];
  const listeners = {};
  const win = { addEventListener: (n, f) => { listeners[n] = f; }, removeEventListener: () => {} };
  const ob = createOutbox({ store, deviceId: 'd4', backoffMs: 60000, maxBackoffMs: 60000, now: () => t,
    apply: async (cmd) => { if (down) throw new PbNetworkError(new TypeError('Failed to fetch'), '/api'); sent.push(cmd.commandId); return { ok: true }; } });
  const detach = ob.attachToWindow(win);
  await ob.enqueue({ op: 'save', ns: NS, col: 'lots', docId: 'L1', patch: {} });
  await sleep(10);
  assert.ok((await store.all())[0].nextAt > t, '60秒待ちに入っている');
  down = false; t += 1000;   // 1秒後に戻った
  listeners['app-reconnected']();
  await sleep(30);
  detach();
  assert.equal(sent.length, 1, '60秒を待たずに送れた');
  assert.equal((await store.all()).length, 0);
});

// --- 保管庫 ------------------------------------------------------------------
const makeClient = () => {
  const docs = new Map(); let down = false; let n = 0;
  const net = () => new PbNetworkError(new TypeError('Failed to fetch'), '/api');
  const c = {
    docs,
    setDown: (v) => { down = v; },
    isAuthed: () => true,
    whenReady: () => Promise.resolve(),
    listAll: async (col, { filter } = {}) => {
      if (down) throw net();
      const want = Object.fromEntries([...String(filter || '').matchAll(/(\w+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
      return [...docs.values()].filter((r) => Object.entries(want).every(([k, v]) => String(r[k] ?? '') === v));
    },
    listPage: async (col, opts) => { const items = await c.listAll(col, opts); return { items, totalItems: items.length, totalPages: 1 }; },
    create: async (col, data) => { if (down) throw net(); const rec = { id: `r${++n}`, ...data }; docs.set(rec.id, rec); return rec; },
    update: async (col, id, patch) => { if (down) throw net(); docs.set(id, { ...docs.get(id), ...patch }); return docs.get(id); },
    remove: async () => ({}),
    openRealtime: (o) => { c.emitRt = o.onEvent; return () => {}; },
  };
  return c;
};
const seed = (c, docId, data) => { c.docs.set(`s-${docId}`, { id: `s-${docId}`, ns: NS, col: 'lots', docId, data, rev: 1 }); };

test('④ 読めた一覧は端末の控えに入り、届かない時に開き直すと控えが出る(onError は呼ばず onOfflineCache)', async () => {
  const rc = createMemoryReadCache();
  const c1 = makeClient(); seed(c1, 'L1', { orderNo: 'A-1' }); seed(c1, 'L2', { orderNo: 'A-2' });
  const b1 = createPocketbaseBackend(c1, { outboxStore: createMemoryStore(), readCache: rc });
  await b1.getAll(NS, 'lots');
  await sleep(5);
  assert.equal(rc._size(), 2, '読めた2件が控えに入る');
  b1.close();

  // 開き直し(新しい保管庫)・サーバーに届かない
  const c2 = makeClient(); c2.setDown(true);
  const b2 = createPocketbaseBackend(c2, { outboxStore: createMemoryStore(), readCache: rc });
  const got = []; let errs = 0; let offline = 0;
  b2.watchCollection(NS, 'lots', (rows, snap) => got.push({ ids: rows.map((r) => r.id).sort(), fromCache: snap.metadata.fromCache }),
    { onError: () => { errs += 1; }, onOfflineCache: () => { offline += 1; } });
  await sleep(20);
  const last = got[got.length - 1];
  assert.deepEqual(last.ids, ['L1', 'L2'], '前の中身が出る');
  assert.equal(last.fromCache, true, 'サーバーから読めた印は付けない');
  assert.equal(errs, 0, '画面の onError は呼ばない(最終の保存の門を閉じない)');
  assert.equal(offline, 1, '読み直しの係へは知らせる');
  assert.equal(b2.restoredFromDevice(NS, 'lots'), true);

  // 届かない間の保存も画面に重なる(見込みの値)
  await b2.save(NS, 'lots', 'L3', { orderNo: 'OFF' });
  assert.deepEqual(got[got.length - 1].ids, ['L1', 'L2', 'L3']);

  // つながって読み直すと、サーバーの答えに替わる
  c2.setDown(false); c2.docs = c1.docs;
  b2.close();
});

test('⑤ 控えが無い一覧は、届かない時に今まで通り onError(空を「読めた」にしない)', async () => {
  const c = makeClient(); c.setDown(true);
  const b = createPocketbaseBackend(c, { outboxStore: createMemoryStore(), readCache: createMemoryReadCache() });
  let errs = 0; let offline = 0;
  b.watchCollection(NS, 'settings', () => {}, { onError: () => { errs += 1; }, onOfflineCache: () => { offline += 1; } });
  await sleep(20);
  assert.equal(errs, 1); assert.equal(offline, 0);
  b.close();
});

test('⑤ onOfflineCache が無い(読み直しの係を付けていない)時は、控えを出しても onError(今まで通り)', async () => {
  const rc = createMemoryReadCache();
  await rc.replaceAll(`${NS}/lots`, [['L1', { a: 1 }, 1]]);
  const c = makeClient(); c.setDown(true);
  const b = createPocketbaseBackend(c, { outboxStore: createMemoryStore(), readCache: rc });
  let errs = 0; let rows = null;
  b.watchCollection(NS, 'lots', (r) => { rows = r; }, { onError: () => { errs += 1; } });
  await sleep(20);
  assert.equal(errs, 1);
  assert.deepEqual(rows.map((r) => r.id), ['L1'], '中身は控えから出る');
  b.close();
});

test('⑥ 購読の知らせ(1件の変化)は控えにも1件だけ書く', async () => {
  const rc = createMemoryReadCache();
  const c = makeClient(); seed(c, 'L1', { v: 1 });
  const b = createPocketbaseBackend(c, { outboxStore: createMemoryStore(), readCache: rc });
  b.watchCollection(NS, 'lots', () => {});
  await sleep(20);
  c.emitRt({ action: 'update', record: { ns: NS, col: 'lots', docId: 'L1', data: { v: 2 }, rev: 2 } });
  c.emitRt({ action: 'create', record: { ns: NS, col: 'lots', docId: 'L2', data: { v: 9 }, rev: 1 } });
  c.emitRt({ action: 'delete', record: { ns: NS, col: 'lots', docId: 'L1' } });
  await sleep(10);
  const rows = await rc.getAll(`${NS}/lots`);
  assert.deepEqual(rows.map(([id, d, r]) => [id, d.v, r]), [['L2', 9, 1]]);
  b.close();
});

test('⑦ 札の数え方: pending/sending = 未送信 / failed・conflict = 送れない', () => {
  assert.deepEqual(summarizeOutboxRows([{ status: 'pending' }, { status: 'sending' }, { status: 'failed' }, { status: 'conflict' }, null]), { count: 2, failed: 2 });
  assert.deepEqual(summarizeOutboxRows([]), { count: 0, failed: 0 });
});

test('OB-CUR 未送信の数は IndexedDB を cursor で全行読んで数える(getAll は使わない・読み取りの枠の見張りの誤検知を避ける 2026-11-26)', async () => {
  const rows = [{ status: 'pending' }, { status: 'sending' }, { status: 'failed' }, { status: 'done' }];
  const idb = { open: () => { const req = {}; setTimeout(() => { req.result = { objectStoreNames: { contains: () => true }, close() {}, transaction: () => ({ objectStore: () => ({ openCursor: () => { const g = {}; let i = 0; const step = () => setTimeout(() => { g.result = i < rows.length ? { value: rows[i], continue() { i += 1; step(); } } : null; g.onsuccess(); }, 0); step(); return g; } }) }) }; req.onsuccess(); }, 0); return req; } };
  assert.deepEqual(await countOutboxPending({ idb }), { count: 2, failed: 1 });
});
