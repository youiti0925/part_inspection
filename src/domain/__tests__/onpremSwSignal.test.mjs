// ============================================================================
// onprem-sw.js behaviour in a simulated service worker (node:vm) — 2026-10-31 push switch relay / signal.
// This test file is byte-identical in product / final / parts (src/<dir>/__tests__/onpremSwSignal.test.mjs).
//   V01 empty push -> IndexedDB {sid, secret} (key = scope) -> POST /__push/v1/inbox (same origin, credentials omit) -> notifications
//   V02 inbox failure / no record / empty list / timeout (6 s) -> one generic notice
//   V03 FCM JSON payload (relay) -> shown exactly as before (no inbox call)
//   V04 a link to another host -> the scope (on show and on click); same-origin links kept
//   V05 grouping: 4 or more -> newest 2 + "N more"; 3 -> all 3
//   V06 pushsubscriptionchange -> POST /__push/v1/renew with sid / secret / new endpoint
// No network.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SW = readFileSync(join(ROOT, 'onprem-public', 'onprem-sw.js'), 'utf8');
const SCOPE = 'https://kensa.local/product/';
const ORIGIN = 'https://kensa.local';
const GENERIC = '新しい連絡があります';

const makeFakeIdb = (seed) => {
  const stores = new Map();
  if (seed) stores.set('subs', new Map(Object.entries(seed)));
  const later = (fn) => setTimeout(fn, 0);
  return {
    open() {
      const req = {};
      later(() => {
        const fresh = !stores.size;
        req.result = {
          objectStoreNames: { contains: (n) => stores.has(n) },
          createObjectStore: (n) => { stores.set(n, new Map()); },
          close() {},
          transaction: (n) => ({ objectStore: () => ({ get: (k) => { const r = {}; later(() => { r.result = stores.get(n).get(k); r.onsuccess(); }); return r; } }) }),
        };
        if (fresh && req.onupgradeneeded) req.onupgradeneeded();
        req.onsuccess();
      });
      return req;
    },
  };
};

const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const runSw = ({ fetchImpl, idb, timers } = {}) => {
  const handlers = {}; const shown = []; const opened = []; const focused = []; const calls = [];
  const self = {
    addEventListener: (t, f) => { handlers[t] = f; },
    skipWaiting() {},
    location: { origin: ORIGIN },
    indexedDB: idb || makeFakeIdb(),
    registration: {
      scope: SCOPE,
      showNotification: async (title, opts) => { shown.push({ title, opts }); },
      pushManager: { subscribe: async (o) => ({ toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/re-' + (o && o.k), keys: { p256dh: 'P', auth: 'A' } }) }), getSubscription: async () => null },
    },
    clients: { claim: async () => {}, matchAll: async () => [{ url: `${SCOPE}?renraku=1`, focus: async () => { focused.push(1); } }], openWindow: async (u) => { opened.push(u); } },
  };
  const f = async (url, init) => { calls.push({ url: String(url), init }); return fetchImpl ? fetchImpl(url, init) : jsonRes(200, { items: [] }); };
  const ctx = vm.createContext({
    self, fetch: f, URL, AbortController, JSON, Promise, String, Array, Error,
    setTimeout: timers ? timers.setTimeout : setTimeout, clearTimeout: timers ? timers.clearTimeout : clearTimeout,
  });
  vm.runInContext(SW, ctx, { filename: 'onprem-sw.js' });
  const fire = async (type, ev) => { let p = null; ev.waitUntil = (x) => { p = x; }; handlers[type](ev); await p; };
  return { handlers, shown, opened, focused, calls, fire, self };
};
const emptyPush = () => ({ data: { text: () => '', json: () => { throw new Error('empty'); } } });
const rec = { [SCOPE]: { sid: 'sid001', secret: 'sec-xyz' } };

test('V01 empty push -> inbox (same origin, credentials omit, sid/secret from IndexedDB by scope) -> notifications', async () => {
  const sw = runSw({ idb: makeFakeIdb(rec), fetchImpl: async () => jsonRes(200, { items: [{ title: 'T1', body: 'B1', link: '/product/?renraku=1', tag: 'req-1', requireInteraction: true }] }) });
  await sw.fire('push', emptyPush());
  assert.equal(sw.calls.length, 1);
  assert.equal(sw.calls[0].url, `${ORIGIN}/__push/v1/inbox`);
  assert.equal(sw.calls[0].init.method, 'POST');
  assert.equal(sw.calls[0].init.credentials, 'omit');
  assert.deepEqual(JSON.parse(sw.calls[0].init.body), { sid: 'sid001', secret: 'sec-xyz' });
  assert.ok(sw.calls[0].init.signal, 'abort signal for the timeout');
  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0].title, 'T1');
  assert.equal(sw.shown[0].opts.body, 'B1');
  assert.equal(sw.shown[0].opts.tag, 'req-1');
  assert.equal(sw.shown[0].opts.requireInteraction, true);
  assert.equal(sw.shown[0].opts.data.link, `${SCOPE}?renraku=1`);
  // no data at all is the same as an empty payload
  const sw2 = runSw({ idb: makeFakeIdb(rec), fetchImpl: async () => jsonRes(200, { items: [{ title: 'X' }] }) });
  await sw2.fire('push', {});
  assert.equal(sw2.calls.length, 1);
  assert.equal(sw2.shown[0].title, 'X');
});

test('V02 failure -> one generic notice (no record / HTTP error / network error / empty list / timeout)', async () => {
  const cases = [
    { idb: makeFakeIdb(), fetchImpl: async () => jsonRes(200, { items: [{ title: 'never' }] }), wantCalls: 0 },
    { idb: makeFakeIdb({ 'https://kensa.local/other/': { sid: 'a', secret: 'b' } }), fetchImpl: async () => jsonRes(200, { items: [{ title: 'never' }] }), wantCalls: 0 },
    { idb: makeFakeIdb(rec), fetchImpl: async () => jsonRes(403, {}), wantCalls: 1 },
    { idb: makeFakeIdb(rec), fetchImpl: async () => { throw new Error('net'); }, wantCalls: 1 },
    { idb: makeFakeIdb(rec), fetchImpl: async () => jsonRes(200, { items: [] }), wantCalls: 1 },
    { idb: makeFakeIdb(rec), fetchImpl: async () => jsonRes(200, 'nope'), wantCalls: 1 },
  ];
  for (const [i, c] of cases.entries()) {
    const sw = runSw(c);
    await sw.fire('push', emptyPush());
    assert.equal(sw.calls.length, c.wantCalls, `case ${i}`);
    assert.equal(sw.shown.length, 1, `case ${i}`);
    assert.equal(sw.shown[0].opts.body, GENERIC, `case ${i}`);
    assert.equal(sw.shown[0].opts.data.link, SCOPE);
  }
  // timeout: the fetch never answers; the 6 s timer aborts it
  const delays = [];
  const timers = { setTimeout: (fn, ms) => { delays.push(ms); return setTimeout(fn, 0); }, clearTimeout };
  const sw = runSw({ idb: makeFakeIdb(rec), timers, fetchImpl: (url, init) => new Promise((_, rej) => { init.signal.addEventListener('abort', () => rej(new Error('aborted'))); }) });
  await sw.fire('push', emptyPush());
  assert.ok(delays.includes(6000), `6 s timeout (${delays})`);
  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0].opts.body, GENERIC);
});

test('V03 FCM JSON payload (relay) -> shown exactly as before, no inbox call', async () => {
  const sw = runSw({ idb: makeFakeIdb(rec) });
  const payload = { notification: { title: 'N', body: 'NB', tag: 'req-5', requireInteraction: true, vibrate: [100, 50] }, fcmOptions: { link: `${SCOPE}?renraku=1` } };
  await sw.fire('push', { data: { text: () => JSON.stringify(payload), json: () => payload } });
  assert.equal(sw.calls.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(sw.shown)), [{ title: 'N', opts: { body: 'NB', icon: `${SCOPE}icon-192.png`, data: { link: `${SCOPE}?renraku=1` }, tag: 'req-5', renotify: true, requireInteraction: true, vibrate: [100, 50] } }]);
  const d = { data: { title: 'D', body: 'DB', tag: 't', requireInteraction: '1', link: '/product/' } };
  const sw2 = runSw();
  await sw2.fire('push', { data: { text: () => JSON.stringify(d), json: () => d } });
  assert.deepEqual(JSON.parse(JSON.stringify(sw2.shown)), [{ title: 'D', opts: { body: 'DB', icon: `${SCOPE}icon-192.png`, data: { link: '/product/' }, tag: 't', renotify: true, requireInteraction: true } }]);
  const sw3 = runSw();
  await sw3.fire('push', { data: { text: () => '{}', json: () => ({}) } });
  assert.equal(sw3.shown[0].title, '工程連絡');
  assert.equal(sw3.calls.length, 0);
});

test('V04 external link -> scope (shown and clicked); same-origin link kept', async () => {
  const sw = runSw({ idb: makeFakeIdb(rec), fetchImpl: async () => jsonRes(200, { items: [{ title: 'a', link: 'https://evil.example/x' }, { title: 'b', link: '//evil.example/y' }, { title: 'c', link: 'javascript:alert(1)' }] }) });
  await sw.fire('push', emptyPush());
  assert.deepEqual(sw.shown.map((s) => s.opts.data.link), [SCOPE, SCOPE, SCOPE]);
  const click = (link) => ({ notification: { close() {}, data: { link } } });
  await sw.fire('notificationclick', click('https://evil.example/x'));
  assert.deepEqual(sw.opened, [SCOPE], 'relay payload with another host also opens the scope');
  await sw.fire('notificationclick', click('/final/?renraku=1'));
  assert.deepEqual(sw.opened, [SCOPE, `${ORIGIN}/final/?renraku=1`]);
  await sw.fire('notificationclick', click('?renraku=1'));
  assert.equal(sw.focused.length, 1, 'an open window of the same page is focused');
});

test('V05 grouping: 4 or more -> newest 2 + "N more"; 3 -> all', async () => {
  const items = (n) => Array.from({ length: n }, (_, i) => ({ title: `t${i + 1}`, tag: `g${i + 1}` }));
  const sw = runSw({ idb: makeFakeIdb(rec), fetchImpl: async () => jsonRes(200, { items: items(5) }) });
  await sw.fire('push', emptyPush());
  assert.deepEqual(sw.shown.map((s) => s.title), ['t4', 't5', '工程連絡']);
  assert.equal(sw.shown[2].opts.body, 'ほか3件の連絡があります');
  const sw4 = runSw({ idb: makeFakeIdb(rec), fetchImpl: async () => jsonRes(200, { items: items(4) }) });
  await sw4.fire('push', emptyPush());
  assert.equal(sw4.shown.length, 3);
  assert.equal(sw4.shown[2].opts.body, 'ほか2件の連絡があります');
  const sw3 = runSw({ idb: makeFakeIdb(rec), fetchImpl: async () => jsonRes(200, { items: items(3) }) });
  await sw3.fire('push', emptyPush());
  assert.deepEqual(sw3.shown.map((s) => s.title), ['t1', 't2', 't3']);
});

test('V06 pushsubscriptionchange -> /__push/v1/renew with the stored sid / secret and the new endpoint', async () => {
  const sw = runSw({ idb: makeFakeIdb(rec), fetchImpl: async () => jsonRes(200, {}) });
  const newSubscription = { toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/new1', keys: { p256dh: 'P1', auth: 'A1' } }) };
  await sw.fire('pushsubscriptionchange', { newSubscription });
  assert.equal(sw.calls.length, 1);
  assert.equal(sw.calls[0].url, `${ORIGIN}/__push/v1/renew`);
  assert.equal(sw.calls[0].init.credentials, 'omit');
  assert.deepEqual(JSON.parse(sw.calls[0].init.body), { sid: 'sid001', secret: 'sec-xyz', endpoint: 'https://fcm.googleapis.com/fcm/send/new1', keys: { p256dh: 'P1', auth: 'A1' } });
  // no newSubscription: subscribe again with the old options
  const sw2 = runSw({ idb: makeFakeIdb(rec), fetchImpl: async () => jsonRes(200, {}) });
  await sw2.fire('pushsubscriptionchange', { oldSubscription: { options: { k: 'K' } } });
  assert.equal(JSON.parse(sw2.calls[0].init.body).endpoint, 'https://fcm.googleapis.com/fcm/send/re-K');
  // no record: nothing is sent
  const sw3 = runSw({ idb: makeFakeIdb(), fetchImpl: async () => jsonRes(200, {}) });
  await sw3.fire('pushsubscriptionchange', { newSubscription });
  assert.equal(sw3.calls.length, 0);
});
