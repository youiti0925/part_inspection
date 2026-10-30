// 社内版の端末ごとのログインと守った写真の札(src/onpremDevice.js・src/onpremPbFactory.js)の試験 — 2026-10-30
// 約束: C:\Users\anrw3\tmp-onprem-e2e\CONTRACT_device_login.md
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_SESSION_KEY, LEGACY_DEVICE_KEY, CONFIG_CREDS_USED_KEY, REFRESH_INTERVAL_MS, FILE_TOKEN_INTERVAL_MS,
  createDeviceSession, readDeviceSession, withFileToken, isPbFileUrl, rewriteCssUrls, rewriteHtmlFileUrls,
  loginErrorMessage, credentialsFromLoginFile, startDeviceSessionTimers, makeSessionFetch, isPbApiUrl,
} from '../../onpremDevice.js';

const mem = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
};
const res = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
/** 偽の PocketBase。routes: { 'auth-with-password': (body, headers) => [status, json], ... } */
const fakePb = (routes) => {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return res(404, {});
    const r = routes[key];
    if (r instanceof Error) throw r;
    const [st, js] = r(init.body ? JSON.parse(init.body) : undefined, init.headers || {}, url);
    return res(st, js);
  };
  f.calls = calls;
  return f;
};
const REC = { id: 'r1', email: 'parts-1@device.local', label: '部品 検査台1', disabled: false };

test('D01 ログイン: 札だけ覚える(合言葉は覚えない)・決まった鍵・形', async () => {
  const storage = mem();
  const f = fakePb({ 'auth-with-password': (b) => (b.identity === 'parts-1@device.local' && b.password === 'pw' ? [200, { token: 'T1', record: REC }] : [400, {}]) });
  const s = createDeviceSession({ baseUrl: 'https://kensa.local:8443/', fetchImpl: f, storage, now: () => Date.parse('2026-10-30T12:00:00Z') });
  assert.equal((await s.start()).status, 'login', '覚えた物が無ければログインの画面');
  const bad = await s.login('parts-1@device.local', 'wrong');
  assert.equal(bad.ok, false); assert.equal(bad.message, 'メールアドレスか合言葉が違います');
  const ok = await s.login(' parts-1@device.local ', 'pw');
  assert.equal(ok.ok, true); assert.equal(s.token, 'T1');
  assert.equal(f.calls.at(-1).url, 'https://kensa.local:8443/api/collections/device_users/auth-with-password');
  const raw = storage.getItem(DEVICE_SESSION_KEY);
  assert.ok(!/pw/.test(raw.replace(/"[a-zA-Z]+":/g, '')), '合言葉の値を覚えない');
  const saved = JSON.parse(raw);
  assert.deepEqual(Object.keys(saved).sort(), ['collection', 'email', 'label', 'recordId', 'refreshedAt', 'savedAt', 'token', 'v']);
  assert.equal(saved.v, 1); assert.equal(saved.token, 'T1'); assert.equal(saved.recordId, 'r1'); assert.equal(saved.label, '部品 検査台1');
  assert.equal('password' in saved, false);
  assert.equal(DEVICE_SESSION_KEY, 'onprem.deviceSession.v1');
});

test('D02 開いた時: 覚えた札を延ばす・401/403/404 は消してログイン・通信できなければ覚えた札のまま(offline)', async () => {
  for (const st of [401, 403, 404]) {
    const storage = mem();
    const s0 = createDeviceSession({ baseUrl: 'http://pb', fetchImpl: fakePb({ 'auth-with-password': () => [200, { token: 'OLD', record: REC }] }), storage });
    await s0.login('a', 'b');
    const s = createDeviceSession({ baseUrl: 'http://pb', fetchImpl: fakePb({ 'auth-refresh': () => [st, {}] }), storage });
    const r = await s.start();
    assert.equal(r.status, 'login', `${st} はログインの画面へ`);
    assert.equal(storage.getItem(DEVICE_SESSION_KEY), null, `${st} は覚えた物を消す`);
  }
  const storage = mem();
  await createDeviceSession({ baseUrl: 'http://pb', fetchImpl: fakePb({ 'auth-with-password': () => [200, { token: 'OLD', record: REC }] }), storage }).login('a', 'b');
  const ref = fakePb({ 'auth-refresh': (b, h) => (h.Authorization === 'OLD' ? [200, { token: 'NEW', record: REC }] : [401, {}]) });
  const s = createDeviceSession({ baseUrl: 'http://pb', fetchImpl: ref, storage });
  assert.equal((await s.start()).status, 'ok');
  assert.equal(s.token, 'NEW'); assert.equal(readDeviceSession(storage).token, 'NEW', '新しい札を覚え直す');
  const off = createDeviceSession({ baseUrl: 'http://pb', fetchImpl: fakePb({ 'auth-refresh': new TypeError('Failed to fetch') }), storage });
  const r = await off.start();
  assert.equal(r.status, 'offline'); assert.equal(off.token, 'NEW', '通信できない時は覚えた札のまま');
  assert.equal(readDeviceSession(storage).token, 'NEW', '消さない');
  const e500 = createDeviceSession({ baseUrl: 'http://pb', fetchImpl: fakePb({ 'auth-refresh': () => [503, {}] }), storage });
  assert.equal((await e500.start()).status, 'offline', '5xx も覚えた札のまま');
});

test('D03 移し替え: onprem.device.v1(合言葉)は1回使って必ず消す・成功なら札を覚える', async () => {
  const storage = mem({ [LEGACY_DEVICE_KEY]: JSON.stringify({ email: 'parts-1@device.local', password: 'pw', owner: '' }) });
  const s = createDeviceSession({ baseUrl: 'http://pb', fetchImpl: fakePb({ 'auth-with-password': (b) => (b.password === 'pw' ? [200, { token: 'T', record: REC }] : [400, {}]) }), storage });
  const r = await s.start();
  assert.equal(r.status, 'ok'); assert.equal(r.migrated, 'legacy');
  assert.equal(storage.getItem(LEGACY_DEVICE_KEY), null, '合言葉を端末に残さない');
  assert.equal(readDeviceSession(storage).token, 'T');
  const st2 = mem({ [LEGACY_DEVICE_KEY]: JSON.stringify({ email: 'x', password: 'bad' }) });
  const s2 = createDeviceSession({ baseUrl: 'http://pb', fetchImpl: fakePb({ 'auth-with-password': () => [400, {}] }), storage: st2 });
  const r2 = await s2.start();
  assert.equal(r2.status, 'login'); assert.equal(st2.getItem(LEGACY_DEVICE_KEY), null, '失敗でも消す');
});

test('D04 前の形の onprem-config.json(email/password 入り)は1回だけ使い、次からは無視する', async () => {
  const storage = mem();
  const f = fakePb({ 'auth-with-password': () => [200, { token: 'C1', record: REC }] });
  const cc = { email: 'parts-1@device.local', password: 'pw' };
  const s = createDeviceSession({ baseUrl: 'http://pb', fetchImpl: f, storage, configCreds: cc });
  const r = await s.start();
  assert.equal(r.status, 'ok'); assert.equal(r.migrated, 'config');
  assert.equal(storage.getItem(CONFIG_CREDS_USED_KEY), 'parts-1@device.local', '印は email だけ');
  s.logout();
  const again = createDeviceSession({ baseUrl: 'http://pb', fetchImpl: f, storage, configCreds: cc });
  assert.equal((await again.start()).status, 'login', '2回目は使わない(ログインの画面)');
  assert.equal(f.calls.length, 1);
});

test('D05 401 → 1回だけ延ばす・だめならログアウト(loggedOut を知らせる)・同時に来ても1回', async () => {
  const storage = mem();
  let refreshCalls = 0;
  const f = fakePb({ 'auth-with-password': () => [200, { token: 'A', record: REC }], 'auth-refresh': () => { refreshCalls++; return [401, {}]; } });
  const s = createDeviceSession({ baseUrl: 'http://pb', fetchImpl: f, storage });
  await s.login('a', 'b');
  const events = [];
  s.onChange((ev, d) => events.push([ev, d]));
  const [t1, t2] = await Promise.all([s.handleUnauthorized(), s.handleUnauthorized()]);
  assert.equal(t1, null); assert.equal(t2, null); assert.equal(refreshCalls, 1, '同時の 401 でも延長は1回');
  assert.deepEqual(events.at(-1), ['loggedOut', 'unauthorized']);
  assert.equal(s.isLoggedIn(), false); assert.equal(storage.getItem(DEVICE_SESSION_KEY), null);
});

test('D06 6時間ごとの延長: 6時間未満は呼ばない・以上で呼ぶ・使えない札はログアウト', async () => {
  let t = Date.parse('2026-10-30T00:00:00Z');
  let mode = 200;
  const f = fakePb({ 'auth-with-password': () => [200, { token: 'A', record: REC }], 'auth-refresh': () => (mode === 200 ? [200, { token: 'B', record: REC }] : [mode, {}]) });
  const s = createDeviceSession({ baseUrl: 'http://pb', fetchImpl: f, storage: mem(), now: () => t });
  await s.login('a', 'b');
  t += REFRESH_INTERVAL_MS - 1;
  assert.equal((await s.maybeRefresh()).skipped, true);
  t += 1;
  assert.equal((await s.maybeRefresh()).ok, true); assert.equal(s.token, 'B');
  t += REFRESH_INTERVAL_MS; mode = 401;
  await s.maybeRefresh();
  assert.equal(s.isLoggedIn(), false);
  // 時計: 渡した tick を呼ぶと延長と写真の札の取り直しを確かめる
  let tick = null; let cleared = false;
  const stop = startDeviceSessionTimers({ isLoggedIn: () => true, maybeRefresh: async () => { tick = 'refreshed'; }, fileTokenAgeMs: () => FILE_TOKEN_INTERVAL_MS, getFileToken: async () => { tick += '+file'; } },
    { setIntervalImpl: (fn) => { fn(); return 1; }, clearIntervalImpl: () => { cleared = true; }, doc: null });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(tick, 'refreshed+file'); stop(); assert.equal(cleared, true);
});

test('D07 写真の札: POST /api/files/token に Authorization・メモリだけ・30分は使い回し・ログインなしは null', async () => {
  let t = 0; let n = 0;
  const storage = mem();
  const f = fakePb({ 'auth-with-password': () => [200, { token: 'A', record: REC }], '/api/files/token': (b, h) => (h.Authorization === 'A' ? [200, { token: `F${++n}` }] : [401, {}]) });
  const s = createDeviceSession({ baseUrl: 'http://pb', fetchImpl: f, storage, now: () => t });
  assert.equal(await s.getFileToken(), null);
  await s.login('a', 'b');
  assert.equal(await s.getFileToken(), 'F1');
  t += FILE_TOKEN_INTERVAL_MS - 1; assert.equal(await s.getFileToken(), 'F1');
  t += 1; assert.equal(await s.getFileToken(), 'F2');
  assert.ok(![...storage._m.values()].some((v) => v.includes('F2')), '写真の札は localStorage に書かない');
});

test('D08 withFileToken: /api/files/ だけ・? と & ・付け替え・よその口へ渡さない', () => {
  assert.equal(withFileToken('/api/files/blobs/r1/a.jpg', 'F'), '/api/files/blobs/r1/a.jpg?token=F');
  assert.equal(withFileToken('/api/files/blobs/r1/a.jpg?thumb=100x100', 'F'), '/api/files/blobs/r1/a.jpg?thumb=100x100&token=F');
  assert.equal(withFileToken('/api/files/blobs/r1/a.jpg?token=OLD&thumb=1', 'NEW'), '/api/files/blobs/r1/a.jpg?token=NEW&thumb=1');
  assert.equal(withFileToken('https://kensa.local:8443/api/files/blobs/r1/a.jpg', 'F'), 'https://kensa.local:8443/api/files/blobs/r1/a.jpg?token=F');
  assert.equal(withFileToken('https://evil.example/api/files/blobs/r1/a.jpg', 'F', ['https://kensa.local:8443']), 'https://evil.example/api/files/blobs/r1/a.jpg', 'よその口には付けない');
  assert.equal(withFileToken('data:image/png;base64,AAAA', 'F'), 'data:image/png;base64,AAAA');
  assert.equal(withFileToken('blob:https://x/1', 'F'), 'blob:https://x/1');
  assert.equal(withFileToken('/assets/api/files/x', 'F'), '/assets/api/files/x');
  assert.equal(withFileToken('/api/files/blobs/r1/a.jpg', ''), '/api/files/blobs/r1/a.jpg');
  assert.equal(withFileToken('/api/files/blobs/r1/a.jpg#p', 'a b'), '/api/files/blobs/r1/a.jpg?token=a%20b#p');
  assert.equal(isPbFileUrl('/api/files/token'), false, '札を取る道そのものには付けない');
  assert.equal(rewriteCssUrls('url(/api/files/b/r/x.png) no-repeat', 'F'), 'url(/api/files/b/r/x.png?token=F) no-repeat');
  assert.equal(rewriteCssUrls('url("data:image/png;base64,AA")', 'F'), 'url("data:image/png;base64,AA")');
  const html = '<img src="/api/files/blobs/r/a.jpg"><a href=\'/api/files/blobs/r/b.pdf\'>b</a><img src="data:x"><div style="background:url(/api/files/b/r/c.png)"></div>';
  assert.equal(rewriteHtmlFileUrls(html, 'F'), '<img src="/api/files/blobs/r/a.jpg?token=F"><a href=\'/api/files/blobs/r/b.pdf?token=F\'>b</a><img src="data:x"><div style="background:url(/api/files/b/r/c.png?token=F)"></div>');
});

test('D09 文言とファイルから読む', () => {
  assert.equal(loginErrorMessage(429), '何度も失敗したので少し待ってください');
  assert.equal(loginErrorMessage(500), '社内サーバーにつながりません(500)');
  assert.equal(loginErrorMessage(0), '社内サーバーにつながりません(通信できません)');
  const a = credentialsFromLoginFile({ kind: 'onprem-device-login', v: 1, collection: 'device_users', email: 'e@x', password: 'p', label: 'L' });
  assert.deepEqual(a, { ok: true, email: 'e@x', password: 'p', label: 'L', collection: 'device_users' });
  const b = credentialsFromLoginFile({ url: '', authCollection: 'device_users', email: 'e@x', password: 'p', deviceLabel: 'PC' });
  assert.equal(b.ok, true); assert.equal(b.label, 'PC');
  assert.equal(credentialsFromLoginFile({ url: '' }).ok, false, '合言葉の無い(入口が配る)設定ファイルは駄目と言う');
  assert.equal(credentialsFromLoginFile([]).ok, false);
});

test('D10 fetch の入口: PB の /api/ に今の札・401 は1回延ばして新しい札でやり直す・写真に札・ログインの道と外の住所は触らない', async () => {
  const calls = [];
  const session = {
    token: 'A', currentFileToken: () => 'F',
    handleUnauthorized: async () => { session.token = 'B'; return 'B'; },
  };
  const auth = (init) => (init && init.headers && typeof init.headers.get === 'function' ? init.headers.get('Authorization') : (init && init.headers && init.headers.Authorization) || null);
  const inner = async (url, init) => {
    calls.push([url, auth(init)]);
    if (url.includes('/auth-with-password')) return { status: 401 };
    if (url.startsWith('https://ai.example')) return { status: 200 };
    return { status: auth(init) === 'B' ? 200 : 401 };
  };
  const sf = makeSessionFetch(session, { fetchImpl: inner, apiBase: 'https://kensa.local:8443', allowedOrigins: ['https://kensa.local:8443'] });
  const r = await sf('https://kensa.local:8443/api/collections/docs/records', { headers: { Authorization: 'STALE' } });
  assert.equal(r.status, 200);
  assert.deepEqual(calls.slice(-2), [['https://kensa.local:8443/api/collections/docs/records', 'A'], ['https://kensa.local:8443/api/collections/docs/records', 'B']], '送る瞬間の札に替え、401 で延ばした札でやり直す');
  await sf('/api/files/blobs/r/a.jpg?thumb=1');
  assert.equal(calls.at(-1)[0], '/api/files/blobs/r/a.jpg?thumb=1&token=F');
  const n = calls.length;
  const a = await sf('https://kensa.local:8443/api/collections/device_users/auth-with-password', { method: 'POST' });
  assert.equal(a.status, 401); assert.equal(calls.length, n + 1, 'ログインの道の 401 はやり直さない'); assert.equal(calls.at(-1)[1], null, 'ログインの道に札を入れない');
  await sf('https://ai.example/generate', { headers: {} });
  assert.equal(calls.at(-1)[1], null, '外の住所に札を入れない');
  assert.equal(isPbApiUrl('https://kensa.local:8443/api/x', 'https://kensa.local:8443/'), true);
  assert.equal(isPbApiUrl('https://other/api/x', 'https://kensa.local:8443'), false);
  const loggedOut = makeSessionFetch({ token: 'A', currentFileToken: () => null, handleUnauthorized: async () => null }, { fetchImpl: async () => ({ status: 401 }), apiBase: 'http://pb' });
  assert.equal((await loggedOut('http://pb/api/collections/docs/records')).status, 401, '延ばせなければ 401 をそのまま返す');
});
