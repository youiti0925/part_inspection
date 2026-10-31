// ============================================================================
// 社内版の通知の切替(src/data/webPushClient.js・2026-10-31)の試験。
// ⚠この試験ファイルは 製品・最終・部品・③ で1バイトも違わない(src/data/__tests__/webPushClient.test.mjs)。
//   W01 md5(webPushClient.js は4アプリ同じ)・import も一番上の動きも無い
//   W02 切替の既定は relay(無い・空・違う字)。"signal" だけ signal
//   W03 種類の表(tag / title → category)
//   W04 "wp:" の宛先は中継へ渡さない・重なりは1つ
//   W05 鍵の形・push の口の名前・同じ口のリンク・/__push/v1/ の名前
//   W06 IndexedDB の鍵 = registration.scope(SW と同じ名前)
//   W07 relay: 中継(relaySend)を今と同じ形で呼び、横で notify_queue に種類だけの行(mode relay)を1件。行が書けなくても止めない
//   W08 signal: 中継を呼ばない・宛先 sids と文面の行(mode signal)・同じ口の外へは1回も出ない(登録→送る→解除の全部)
//   W09 signal の登録: 古い鍵の購読は外す・同じ endpoint は作り直さない・許していない口は断る・秘密は hash だけ送る
//   W10 準備の判定・画面を開いている時の受信(signal は Firebase を使わない)
// 通信はしない(fetch・IndexedDB・pushManager は偽物)。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  pushModeOf, noticeCategoryOf, splitPushTokens, isWpToken, sidOfToken, isVapidPublicKey, isAllowedPushEndpoint,
  safeNoticeLink, isSameOriginUrl, pushApiUrl, idbGetSub, idbPutSub, idbDeleteSub, PUSH_IDB_NAME, PUSH_IDB_STORE,
  sendOnpremPush, buildQueueRow, enableSignalPush, disableSignalPush, createOnpremPush, onpremPushReady, bytesToB64u, b64uToBytes,
} from '../webPushClient.js';

// md5 of src/data/webPushClient.js (LF). Change it in all four apps at once.
const SHARED_WEBPUSH_MD5 = '5eb10c8b7bf84ac2c314b7d0a241102b';
const SRC = readFileSync(fileURLToPath(new URL('../webPushClient.js', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

const ORIGIN = 'https://kensa.local';
const SCOPE = 'https://kensa.local/product/';
const KEY = 'B' + 'A'.repeat(86);   // 87 字の公開鍵の形

// --- 偽の IndexedDB(open / transaction / get / put / delete だけ) -----------------
const makeFakeIdb = () => {
  const dbs = new Map();
  const later = (fn) => setTimeout(fn, 0);
  return {
    _dbs: dbs,
    open(name) {
      const req = {};
      later(() => {
        let stores = dbs.get(name); const fresh = !stores;
        if (!stores) { stores = new Map(); dbs.set(name, stores); }
        const db = {
          objectStoreNames: { contains: (n) => stores.has(n) },
          createObjectStore: (n) => { stores.set(n, new Map()); },
          close() {},
          transaction(storeName) {
            const m = stores.get(storeName);
            if (!m) throw new Error('NotFoundError');
            const tx = {};
            const op = (f) => { const r = {}; later(() => { r.result = f(); if (r.onsuccess) r.onsuccess(); later(() => { if (tx.oncomplete) tx.oncomplete(); }); }); return r; };
            tx.objectStore = () => ({
              get: (k) => op(() => (m.has(k) ? structuredClone(m.get(k)) : undefined)),
              put: (v, k) => op(() => { m.set(k, structuredClone(v)); return k; }),
              delete: (k) => op(() => { m.delete(k); }),
            });
            return tx;
          },
        };
        req.result = db;
        if (fresh && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };
};

const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

/** 呼ばれた URL を全部覚える偽の fetch。 */
const makeFetch = (routes = {}) => {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const u = new URL(String(url));
    const key = `${(init.method || 'GET').toUpperCase()} ${u.pathname}`;
    const h = routes[key];
    if (typeof h === 'function') return h(init, u);
    if (h) return h;
    return jsonRes(200, { id: 'rec' + calls.length });
  };
  f.calls = calls;
  return f;
};

const makeSub = (endpoint, keyBytes) => {
  const sub = {
    endpoint, options: { applicationServerKey: keyBytes ? keyBytes.buffer : null }, unsubscribed: false,
    toJSON: () => ({ endpoint, keys: { p256dh: 'BPk' + 'x'.repeat(84), auth: 'auth1234auth1234' } }),
    unsubscribe: async () => { sub.unsubscribed = true; return true; },
  };
  return sub;
};
const makeReg = ({ existing = null, endpoint = 'https://fcm.googleapis.com/fcm/send/abc123' } = {}) => {
  const reg = {
    scope: SCOPE, subscribed: [],
    pushManager: {
      current: existing,
      getSubscription: async () => reg.pushManager.current,
      subscribe: async (opts) => { reg.subscribed.push(opts); reg.pushManager.current = makeSub(endpoint, new Uint8Array(opts.applicationServerKey)); return reg.pushManager.current; },
    },
  };
  return reg;
};

test('W01 webPushClient.js is the shared file (same md5 in 4 apps) / no import / nothing runs at the top', () => {
  assert.equal(createHash('md5').update(SRC, 'utf8').digest('hex'), SHARED_WEBPUSH_MD5);
  assert.ok(!/^\s*import\s/m.test(SRC) && !/\bimport\s*\(/.test(SRC), 'import しない');
  assert.ok(!/firebase|gstatic|workers\.dev|\/fcm\/send|getToken\(/i.test(SRC.replace(/^\s*\/\/.*$/gm, '')), 'Firebase / 中継の字がコードに無い');
  assert.ok(!/\basync\b|\bawait\b/.test(SRC.replace(/^\s*\/\/.*$/gm, '')), 'async を書かない(Promise の鎖)');
  // 一番上の文は export const / const / コメントだけ
  for (const line of SRC.split('\n')) {
    if (!line || /^\s/.test(line) || /^\/[/*]/.test(line) || /^[}\])]/.test(line)) continue;
    assert.match(line, /^(export )?const /, `一番上の文: ${line}`);
  }
});

test('W02 pushMode: default relay, only "signal" switches', () => {
  for (const v of [undefined, null, '', 'relay', 'RELAY', 'fcm', 0, {}, 'signals']) assert.equal(pushModeOf(v), 'relay', String(v));
  for (const v of ['signal', ' Signal ', 'SIGNAL']) assert.equal(pushModeOf(v), 'signal');
  const p = createOnpremPush({ getMode: () => undefined, relaySend: () => {}, relayEnable: () => {}, relayDisable: () => {}, relayListen: () => {} });
  assert.equal(p.mode(), 'relay');
});

test('W03 category table (tag / title → category)', () => {
  const cases = [
    [{ tag: 'req-1', title: '🔧 修正依頼 → 田中さん' }, 'repair'],
    [{ tag: 'req-2', title: '📞 呼出・連絡' }, 'call'],
    [{ tag: 'req-3', title: '🚚 到着予定を教えてください (2件)' }, 'info'],
    [{ tag: 'int-9', title: '🏭 社内: 応援要請' }, 'internal'],
    [{ tag: 'intack-9', title: '🏭 対応します' }, 'info'],
    [{ tag: 'reply-4', title: '↩ 行けない（佐藤）' }, 'cantgo'],
    [{ tag: 'reply-5', title: '↩ すぐ行きます（佐藤）' }, 'info'],
    [{ tag: 'esc-7', title: '催促' }, 'escalate'],
    [{ tag: 'rem-7-2', title: 'まだです' }, 'remind'],
    [{ tag: 'remind-lot-1', title: '予定' }, 'info'],
    [{ tag: 'req-1-cc', title: '📋 CC(組立宛): 🔧 修正依頼' }, 'cc'],
    [{ tag: 'cc-cc', title: '📋 CC' }, 'cc'],
    [{ tag: 'push-test-123', title: '✅ テスト通知' }, 'test'],
    [{ tag: 'weekly-brief-2026-W44', title: '🎯 今週の工場' }, 'info'],
    [{ tag: '', title: '' }, 'info'],
    [{}, 'info'],
  ];
  for (const [a, want] of cases) assert.equal(noticeCategoryOf(a), want, JSON.stringify(a));
});

test('W04 "wp:" tokens are never handed to the relay; duplicates collapse', () => {
  assert.ok(isWpToken('wp:abc123DEF456ghi'));
  assert.ok(!isWpToken('wp:'));
  assert.ok(!isWpToken('wp:a b'));
  assert.ok(!isWpToken('fcmTokenXYZ'));
  assert.equal(sidOfToken('wp:r1'), 'r1');
  assert.equal(sidOfToken('xx'), '');
  const s = splitPushTokens(['f1', 'wp:s1', 'f1', 'wp:s1', 'wp:bad id', 'wp:', '', null, 7, 'f2', 'wp:s2']);
  assert.deepEqual(s, { fcm: ['f1', 'f2'], sids: ['s1', 's2'] });
  assert.deepEqual(splitPushTokens(undefined), { fcm: [], sids: [] });
});

test('W05 key / host / link / api checks', () => {
  assert.ok(isVapidPublicKey(KEY));
  assert.ok(!isVapidPublicKey('A' + 'A'.repeat(86)), '"B" で始まらない');
  assert.ok(!isVapidPublicKey('B' + 'A'.repeat(42)), '43 字前後(秘密鍵)');
  assert.ok(!isVapidPublicKey(null));
  for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://wns2-par02p.notify.windows.com/w/?token=x', 'https://web.push.apple.com/QW', 'https://fcm.googleapis.com:443/x']) assert.ok(isAllowedPushEndpoint(ok), ok);
  for (const bad of ['http://fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.com/x', 'https://evil.com/fcm.googleapis.com/', 'https://user:p@fcm.googleapis.com/x',
    'https://fcm.googleapis.com:8443/x', 'https://notify.windows.com/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://fcm.googleapis.com./x', 'https://xn--fcm-x.googleapis.com/x',
    'wss://fcm.googleapis.com/x', '', null, 'https://fcm.googleapis.com\\@evil.com/x']) assert.ok(!isAllowedPushEndpoint(bad), String(bad));
  assert.equal(safeNoticeLink('https://kensa.local/product/?renraku=1', ORIGIN, SCOPE), '/product/?renraku=1');
  assert.equal(safeNoticeLink('/final/#x', ORIGIN, SCOPE), '/final/#x');
  for (const bad of ['https://evil.com/', '//evil.com/x', 'javascript:alert(1)', 'data:text/html,x', 'http://kensa.local/', 'https://kensa.local:8443/']) {
    assert.equal(safeNoticeLink(bad, ORIGIN, SCOPE), SCOPE, bad);
  }
  assert.ok(isSameOriginUrl('/x', ORIGIN));
  assert.ok(!isSameOriginUrl('https://other/x', ORIGIN));
  assert.equal(pushApiUrl('https://kensa.local/product/index.html', 'inbox'), 'https://kensa.local/__push/v1/inbox');
  assert.throws(() => pushApiUrl(ORIGIN, 'send'));
  assert.throws(() => pushApiUrl('', 'config'));
  assert.deepEqual([...b64uToBytes(bytesToB64u(new Uint8Array([0, 251, 255, 7])))], [0, 251, 255, 7]);
});

test('W06 IndexedDB key = registration.scope (same db/store names as onprem-sw.js)', async () => {
  const idb = makeFakeIdb();
  await idbPutSub(SCOPE, { sid: 's1', secret: 'k' }, idb);
  await idbPutSub('https://kensa.local/final/', { sid: 's2', secret: 'k2' }, idb);
  assert.deepEqual(await idbGetSub(SCOPE, idb), { sid: 's1', secret: 'k' });
  assert.equal((await idbGetSub('https://kensa.local/final/', idb)).sid, 's2');
  assert.deepEqual([...idb._dbs.get(PUSH_IDB_NAME).get(PUSH_IDB_STORE).keys()], [SCOPE, 'https://kensa.local/final/']);
  await idbDeleteSub(SCOPE, idb);
  assert.equal(await idbGetSub(SCOPE, idb), null);
  assert.equal(PUSH_IDB_NAME, 'onprem-push');
  assert.equal(PUSH_IDB_STORE, 'subs');
});

test('W07 relay (default): the Worker is called as today (FCM tokens only) and a category-only relay row is queued', async () => {
  const fetchImpl = makeFetch();
  const relayCalls = [];
  const relaySend = async (url, args) => { relayCalls.push({ url, args }); return { ok: true, sent: args.tokens.length, results: [] }; };
  const pb = { baseUrl: ORIGIN, getAuth: () => 'TOK', fetchImpl };
  const args = { tokens: ['f1', 'wp:s1', 'f2'], title: '🔧 修正依頼 → 田中さん', body: '指図 123: 傷', link: `${SCOPE}?renraku=1`, tag: 'req-9', requireInteraction: true, vibrate: [1] };
  const res = await sendOnpremPush({ mode: undefined, ns: 'product-inspection-v1', pb, origin: ORIGIN, scope: SCOPE, relaySend }, 'https://w.example', args);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(res, { ok: true, sent: 2, results: [] });
  assert.equal(relayCalls.length, 1);
  assert.equal(relayCalls[0].url, 'https://w.example');
  assert.deepEqual(relayCalls[0].args, { ...args, tokens: ['f1', 'f2'] }, '中継へは今と同じ項目(token だけ FCM の物)');
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, `${ORIGIN}/api/collections/notify_queue/records`);
  assert.equal(fetchImpl.calls[0].init.method, 'POST');
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'TOK');
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), { mode: 'relay', state: 'new', ns: 'product-inspection-v1', category: 'repair' }, '本文・宛先・リンクは載せない');
  // 行を書けなくても(500・通信の失敗)中継の返事はそのまま・投げない
  for (const bad of [async () => jsonRes(500, {}), async () => { throw new Error('down'); }]) {
    const r2 = await sendOnpremPush({ ns: 'n', pb: { baseUrl: ORIGIN, fetchImpl: bad }, origin: ORIGIN, relaySend }, 'https://w.example', { tokens: ['f1'], tag: 'int-1' });
    assert.equal(r2.ok, true);
  }
  // pb が無くても中継は呼ぶ
  const r3 = await sendOnpremPush({ ns: 'n', pb: null, origin: ORIGIN, relaySend }, 'https://w.example', { tokens: ['f9'] });
  assert.equal(r3.ok, true);
  // 宛先が 0(Teams のためだけ)でも行は入れる・中継は呼ばない
  const f4 = makeFetch(); const before = relayCalls.length;
  const r4 = await sendOnpremPush({ ns: 'final-inspection-v1', pb: { baseUrl: ORIGIN, fetchImpl: f4 }, origin: ORIGIN, relaySend }, 'https://w.example', { tokens: [], tag: 'int-2', title: '社内' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(relayCalls.length, before);
  assert.equal(r4.ok, false);
  assert.equal(JSON.parse(f4.calls[0].init.body).category, 'internal');
});

test('W08 signal: no Worker, a signal row with sids + text, and nothing leaves the page origin (enable → send → disable)', async () => {
  const fetchImpl = makeFetch({ 'GET /__push/v1/config': jsonRes(200, { publicKey: KEY }), 'POST /api/collections/push_subs/records': jsonRes(200, { id: 'sub0000000001' }) });
  const idb = makeFakeIdb();
  const reg = makeReg();
  let relayCalled = 0;
  const p = createOnpremPush({
    getMode: () => 'signal', ns: 'product-inspection-v1', getPb: () => ({ baseUrl: ORIGIN, getAuth: () => 'TOK', fetchImpl }),
    getOrigin: () => ORIGIN, getScope: () => SCOPE, fetchImpl, idbFactory: idb,
    registerSw: async () => reg, requestPermission: async () => 'granted',
    relaySend: () => { relayCalled++; }, relayEnable: () => { relayCalled++; }, relayDisable: () => { relayCalled++; }, relayListen: () => { relayCalled++; },
  });
  const token = await p.enable('ignored-firebase-vapid');
  assert.equal(token, 'wp:sub0000000001');
  const res = await p.send('https://gemini-proxy.example.workers.dev', { tokens: [token, 'fcmOld'], title: '📞 呼出・連絡', body: 'b', link: 'https://evil.com/x', tag: 'req-1', requireInteraction: true });
  assert.deepEqual(res, { ok: true, sent: 1, queued: true, mode: 'signal', results: [] });
  const q = fetchImpl.calls.find((c) => c.url.endsWith('/notify_queue/records'));
  assert.deepEqual(JSON.parse(q.init.body), { mode: 'signal', state: 'new', ns: 'product-inspection-v1', category: 'call', sids: ['sub0000000001'], title: '📞 呼出・連絡', body: 'b', link: SCOPE, tag: 'req-1', requireInteraction: true });
  await p.disable();
  const unsub = await p.listenForeground(() => {});
  assert.equal(typeof unsub, 'function');
  assert.equal(relayCalled, 0, '中継・Firebase の口は1回も呼ばない');
  assert.ok(fetchImpl.calls.length >= 4);
  for (const c of fetchImpl.calls) assert.equal(new URL(c.url).origin, ORIGIN, `同じ口の外へ出ない: ${c.url}`);
  assert.ok(fetchImpl.calls.some((c) => c.url === `${ORIGIN}/api/collections/push_subs/records/sub0000000001` && c.init.method === 'DELETE'), '解除で push_subs を消す');
  assert.equal(await idbGetSub(SCOPE, idb), null, '解除で IndexedDB も消す');
  assert.equal(reg.pushManager.current.unsubscribed, true);
  // 行が書けない時は ok:false(投げない)
  const bad = await sendOnpremPush({ mode: 'signal', ns: 'n', pb: { baseUrl: ORIGIN, fetchImpl: async () => jsonRes(403, {}) }, origin: ORIGIN }, '', { tokens: ['wp:a'] });
  assert.equal(bad.ok, false);
});

test('W09 signal enable: old-key subscription replaced, same endpoint reused, bad endpoint refused, only secretHash sent', async () => {
  const idb = makeFakeIdb();
  const fetchImpl = makeFetch({ 'GET /__push/v1/config': jsonRes(200, { vapidPublicKey: KEY }), 'POST /api/collections/push_subs/records': (init) => jsonRes(200, { id: 'sidA', echo: init.body }) });
  const oldSub = makeSub('https://fcm.googleapis.com/fcm/send/old', new Uint8Array([1, 2, 3]));
  const reg = makeReg({ existing: oldSub });
  const deps = { pb: { baseUrl: ORIGIN, getAuth: () => 'T', fetchImpl }, ns: 'final-inspection-v1', origin: ORIGIN, fetchImpl, registerSw: async () => reg, requestPermission: async () => 'granted', idbFactory: idb };
  assert.equal(await enableSignalPush(deps), 'wp:sidA');
  assert.equal(oldSub.unsubscribed, true, '鍵の違う古い購読は外す');
  assert.equal(reg.subscribed.length, 1);
  assert.equal(reg.subscribed[0].userVisibleOnly, true);
  assert.deepEqual([...reg.subscribed[0].applicationServerKey], [...b64uToBytes(KEY)]);
  const body = JSON.parse(fetchImpl.calls.find((c) => c.url.endsWith('/push_subs/records')).init.body);
  assert.deepEqual(Object.keys(body).sort(), ['auth', 'endpoint', 'ns', 'p256dh', 'secretHash']);
  assert.match(body.secretHash, /^[0-9a-f]{64}$/);
  const saved = await idbGetSub(SCOPE, idb);
  assert.equal(saved.sid, 'sidA');
  assert.match(saved.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!JSON.stringify(fetchImpl.calls.map((c) => c.init.body || '')).includes(saved.secret), '秘密そのものはどこへも送らない');
  const { createHash: h } = await import('node:crypto');
  assert.equal(h('sha256').update(saved.secret).digest('hex'), body.secretHash);
  // 2回目(同じ endpoint・同じ ns)は push_subs を作り直さない
  const n = fetchImpl.calls.length;
  assert.equal(await enableSignalPush(deps), 'wp:sidA');
  assert.equal(fetchImpl.calls.filter((c, i) => i >= n && c.url.endsWith('/push_subs/records')).length, 0);
  // 許していない口の endpoint は断って外す
  const reg2 = makeReg({ endpoint: 'https://push.evil.example/x' });
  await assert.rejects(enableSignalPush({ ...deps, idbFactory: makeFakeIdb(), registerSw: async () => reg2 }), /許した送り先/);
  assert.equal(reg2.pushManager.current.unsubscribed, true);
  // 許可されない・鍵の形が違う・config が読めない
  await assert.rejects(enableSignalPush({ ...deps, requestPermission: async () => 'denied' }), /許可されませんでした/);
  await assert.rejects(enableSignalPush({ ...deps, fetchImpl: makeFetch({ 'GET /__push/v1/config': jsonRes(200, { publicKey: 'xyz' }) }) }), /鍵の形/);
  await assert.rejects(enableSignalPush({ ...deps, fetchImpl: makeFetch({ 'GET /__push/v1/config': jsonRes(404, {}) }) }), /読めません/);
  // config は Cookie を付けずに読む
  const cfgCall = fetchImpl.calls.find((c) => c.url === `${ORIGIN}/__push/v1/config`);
  assert.equal(cfgCall.init.credentials, 'omit');
});

test('W10 ready / support / foreground switch by mode', async () => {
  assert.equal(onpremPushReady('relay', { vapidKey: 'v', workerUrl: 'w' }), true);
  assert.equal(onpremPushReady(undefined, { vapidKey: 'v' }), false);
  assert.equal(onpremPushReady('signal', {}), true);
  let listened = 0;
  const relay = createOnpremPush({ getMode: () => 'relay', relayListen: async () => { listened++; return () => {}; }, relayProblem: () => 'R', relaySend: async () => ({ ok: true }), relayEnable: async (k) => `fcm:${k}`, relayDisable: async () => 'd' });
  await relay.listenForeground(() => {});
  assert.equal(listened, 1);
  assert.equal(relay.supportProblem(), 'R');
  assert.equal(await relay.enable('K'), 'fcm:K', 'relay の登録は今の getToken の道のまま');
  const sig = createOnpremPush({ getMode: () => 'signal', env: { window: { isSecureContext: true, PushManager: function P() {}, Notification: function N() {} }, navigator: { serviceWorker: {} } } });
  assert.equal(sig.supportProblem(), '');
  const sig2 = createOnpremPush({ getMode: () => 'signal', env: { window: { isSecureContext: true }, navigator: { serviceWorker: {} } } });
  assert.match(sig2.supportProblem(), /Web Push/);
  assert.deepEqual(buildQueueRow({ mode: 'relay', ns: 'x', category: 'cc', sids: ['a'], title: 't' }), { mode: 'relay', state: 'new', ns: 'x', category: 'cc' });
});
