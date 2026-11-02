// 📴 「オフライン中・未送信 N 件」の札の決め方と、Firestore の待ち行列の数え方(2026-11-02)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideBadge, probeOnce, settleOrQueued, isAppOffline } from '../../offline/offlineBadge.js';
import { countFirestorePending, firestoreDbName } from '../../offline/firestorePending.js';

test('つながっていて未送信0 → 何も出さない', () => {
  const d = decideBadge({ navOnline: true, probeOk: true, pending: { count: 0 } });
  assert.equal(d.show, false);
});

test('ブラウザが offline → オフライン中(未送信0)', () => {
  const d = decideBadge({ navOnline: false, probeOk: null, pending: { count: 0 } });
  assert.equal(d.show, true); assert.equal(d.offline, true);
  assert.match(d.text, /オフライン中/);
});

test('Wi-Fi は繋がっているがサーバーに届かない(probe 失敗) → オフライン中・未送信 N 件', () => {
  const d = decideBadge({ navOnline: true, probeOk: false, pending: { count: 3 } });
  assert.equal(d.offline, true);
  assert.equal(d.text, '📴 オフライン中・未送信 3 件');
});

test('つながったが未送信が残っている → 送信中(8秒以上続いた時だけ)', () => {
  const d = decideBadge({ navOnline: true, probeOk: true, pending: { count: 2 }, pendingAgeMs: 9000 });
  assert.equal(d.tone, 'sending'); assert.match(d.text, /未送信 2 件・送信中/);
  const quick = decideBadge({ navOnline: true, probeOk: true, pending: { count: 1 }, pendingAgeMs: 300 });
  assert.equal(quick.show, false, 'つながっている時の普通の保存の一瞬は出さない');
  const off = decideBadge({ navOnline: false, pending: { count: 1 }, pendingAgeMs: 300 });
  assert.equal(off.show, true, '切れている時はすぐ出す');
  const bad = decideBadge({ navOnline: true, probeOk: true, pending: { count: 0, failed: 1 }, pendingAgeMs: 0 });
  assert.equal(bad.show, true, '送れない保存はすぐ出す');
});

test('数えられない(null)が「ある」と分かっている → 「あり」(0 と言わない)', () => {
  const d = decideBadge({ navOnline: false, pending: { count: null, has: true } });
  assert.match(d.text, /未送信 あり/);
});

test('送れない保存は赤で必ず出す(つながっていても)', () => {
  const d = decideBadge({ navOnline: true, probeOk: true, pending: { count: 0, failed: 1 } });
  assert.equal(d.show, true); assert.equal(d.tone, 'failed'); assert.match(d.text, /送れない保存 1 件/);
});

test('probe: 返事あり(404 も届いた) → true / 5xx・通信失敗 → false', async () => {
  assert.equal(await probeOnce('/x', { fetchImpl: async () => ({ status: 200 }) }), true);
  assert.equal(await probeOnce('/x', { fetchImpl: async () => ({ status: 404 }) }), true);
  assert.equal(await probeOnce('/x', { fetchImpl: async () => ({ status: 503 }) }), false);
  assert.equal(await probeOnce('/x', { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), false);
  let seen = null;
  await probeOnce('/p.json', { fetchImpl: async (u, o) => { seen = { u, o }; return { status: 200 }; } });
  assert.equal(seen.o.method, 'HEAD'); assert.equal(seen.o.cache, 'no-store'); assert.match(seen.u, /^\/p\.json\?probe=\d+$/);
});

test('settleOrQueued: つながっている時はそのまま待つ / 切れている時は ms で先へ・送る前の失敗は届く', async () => {
  const g = globalThis;
  const prev = g.window;
  try {
    g.window = { navigator: { onLine: true } };
    const never = new Promise(() => {});
    assert.equal(settleOrQueued(never), never, 'online: 同じ約束を返す(挙動を変えない)');
    g.window = { navigator: { onLine: false } };
    const t0 = Date.now();
    await settleOrQueued(new Promise(() => {}), 50);
    assert.ok(Date.now() - t0 < 1000);
    await assert.rejects(settleOrQueued(Promise.reject(new Error('容量で中止')), 500), /容量で中止/);
    g.window = { navigator: { onLine: true }, __appOffline: true };
    assert.equal(isAppOffline(), true, 'Wi-Fi は在るがサーバーに届かない時も切れている扱い');
  } finally { g.window = prev; }
});

test('Firestore の DB 名(SDK の名付けと同じ)', () => {
  assert.equal(firestoreDbName('inspection-time-c4fd3'), 'firestore/[DEFAULT]/inspection-time-c4fd3/main');
});

// --- 偽の IndexedDB --------------------------------------------------------
const fakeIdb = ({ exists, stores = ['mutations'], count = 0, listDbs = true }) => {
  const created = [];
  return {
    created,
    databases: listDbs ? async () => (exists ? [{ name: firestoreDbName('p') }] : []) : undefined,
    open(name) {
      const req = {};
      setTimeout(() => {
        if (!exists) {
          let aborted = false;
          req.transaction = { abort: () => { aborted = true; } };
          req.onupgradeneeded && req.onupgradeneeded();
          if (aborted) { req.onerror && req.onerror(); return; }
          created.push(name);
        }
        let closed = false;
        req.result = {
          objectStoreNames: { contains: (s) => stores.includes(s) },
          close: () => { closed = true; },
          get closed() { return closed; },
          transaction: () => ({ objectStore: () => ({ count: () => { const c = {}; setTimeout(() => { c.result = count; c.onsuccess(); }); return c; } }) }),
        };
        req.onsuccess && req.onsuccess();
      });
      return req;
    },
  };
};

test('待ち行列の件数を数える', async () => {
  assert.equal(await countFirestorePending('p', { idb: fakeIdb({ exists: true, count: 4 }) }), 4);
});

test('DB が無い → 0(databases() で分かる・開かない)', async () => {
  const idb = fakeIdb({ exists: false });
  assert.equal(await countFirestorePending('p', { idb }), 0);
  assert.deepEqual(idb.created, []);
});

test('databases() が無い端末で DB が無い → 作らずに 0', async () => {
  const idb = fakeIdb({ exists: false, listDbs: false });
  assert.equal(await countFirestorePending('p', { idb }), 0);
  assert.deepEqual(idb.created, [], '空の DB を作ってはいけない');
});

test('SDK の作りが変わって mutations が無い → null(嘘の0を言わない)', async () => {
  assert.equal(await countFirestorePending('p', { idb: fakeIdb({ exists: true, stores: ['x'] }) }), null);
});
