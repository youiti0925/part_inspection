// ============================================================================
// 社内サーバ用の切替(2026-10-29 G1/G3)の試験。通信しない。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ONPREM_PROVIDERS, parseOnpremConfig, onpremRoute, fetchOnpremConfig,
  readDeviceLogin, writeDeviceLogin, clearDeviceLogin, ONPREM_DEVICE_KEY, ONPREM_DB, makeOnpremUser,
} from '../onpremConfig.js';
import { AREAS, COLLECTION_AREA, NS, CONTACT_NS, DEFAULT_PROVIDERS } from '../routes.js';
import { providerFor, registerPocketbaseFactory } from '../provider.js';

const memStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m }; };

test('OP01 社内用の保管庫は全部の領域が PocketBase(連絡・通知の置き場も)', () => {
  assert.deepEqual(Object.keys(ONPREM_PROVIDERS).sort(), [...AREAS].sort());
  for (const a of AREAS) assert.equal(ONPREM_PROVIDERS[a], 'pocketbase', a);
  assert.ok(Object.isFrozen(ONPREM_PROVIDERS));
  // 既定(今の本番)は変わっていない
  for (const a of AREAS) assert.equal(DEFAULT_PROVIDERS[a], 'firebase', a);
});

test('OP02 設定ファイル: url だけで動く・末尾の / を落とす・アカウントが無ければ初回入力', () => {
  const p = parseOnpremConfig({ url: 'https://pb.local:8090/' });
  assert.equal(p.ok, true);
  assert.equal(p.url, 'https://pb.local:8090');
  assert.equal(p.authCollection, 'device_users');
  assert.equal(p.needsLogin, true);
  assert.equal(p.source, 'onprem-config.json');
});

test('OP03 設定ファイルが無ければビルド時の VITE_PB_URL・どちらも無ければ起動しない(理由を言う)', () => {
  const b = parseOnpremConfig(null, { url: 'http://10.0.0.5:8090' });
  assert.equal(b.ok, true); assert.equal(b.url, 'http://10.0.0.5:8090'); assert.equal(b.source, 'VITE_PB_URL');
  const n = parseOnpremConfig(null, {});
  assert.equal(n.ok, false); assert.match(n.errors[0], /接続先がありません/);
  const bad = parseOnpremConfig({ url: 'pb.local' });
  assert.equal(bad.ok, false); assert.match(bad.errors[0], /形がおかしい/);
  const badCol = parseOnpremConfig({ url: 'http://x', authCollection: 'a b' });
  assert.equal(badCol.ok, false);
  assert.equal(parseOnpremConfig([1, 2], { url: 'http://x' }).url, 'http://x', '配列は設定として読まない');
});

test('OP04 アカウント: 設定ファイルが優先・無ければ端末に覚えた物', () => {
  const dev = { email: 'dev@x', password: 'p2' };
  const f = parseOnpremConfig({ url: 'http://x', email: 'file@x', password: 'p1' }, {}, dev);
  assert.equal(f.email, 'file@x'); assert.equal(f.password, 'p1'); assert.equal(f.credentialsFrom, 'file'); assert.equal(f.needsLogin, false);
  const d = parseOnpremConfig({ url: 'http://x' }, {}, dev);
  assert.equal(d.email, 'dev@x'); assert.equal(d.credentialsFrom, 'device'); assert.equal(d.needsLogin, false);
  const half = parseOnpremConfig({ url: 'http://x', email: 'file@x' }, {}, null);
  assert.equal(half.needsLogin, true, 'パスワードの無い設定ファイルは使わない');
});

test('OP05 onpremRoute: 窓口へ渡す形(applyDataRoute と同じ形)・note は PocketBase で始まる', () => {
  const p = parseOnpremConfig({ url: 'http://x', email: 'a@x', password: 'p' });
  const onAuthError = () => {};
  const r = onpremRoute(p, { onAuthError });
  assert.equal(r.providers, ONPREM_PROVIDERS);
  assert.deepEqual({ url: r.pbConfig.url, email: r.pbConfig.email, password: r.pbConfig.password, authCollection: r.pbConfig.authCollection },
    { url: 'http://x', email: 'a@x', password: 'p', authCollection: 'device_users' });
  assert.equal(r.pbConfig.onAuthError, onAuthError);
  assert.ok(r.note.startsWith('PocketBase'), '画面の帯は PocketBase で始まる時だけ出す');
  assert.throws(() => onpremRoute(parseOnpremConfig(null, {})), /正しくありません/);
});

test('OP06 設定ファイルを読む: 404・index.html が返る・壊れた JSON は null と理由', async () => {
  const resp = (status, text) => async () => ({ ok: status >= 200 && status < 300, status, text: async () => text });
  assert.deepEqual((await fetchOnpremConfig({ fetchImpl: resp(200, '{"url":"http://x"}') })).raw, { url: 'http://x' });
  const nf = await fetchOnpremConfig({ fetchImpl: resp(404, '') });
  assert.equal(nf.raw, null); assert.match(nf.reason, /404/);
  const html = await fetchOnpremConfig({ fetchImpl: resp(200, '<!doctype html><html>') });
  assert.equal(html.raw, null); assert.match(html.reason, /JSON/);
  const net = await fetchOnpremConfig({ fetchImpl: async () => { throw new Error('つながらない'); } });
  assert.equal(net.raw, null); assert.match(net.reason, /つながらない/);
  let asked = '';
  await fetchOnpremConfig({ fetchImpl: async (u, o) => { asked = `${u} ${o.cache}`; return { ok: false, status: 404 }; }, baseUrl: '/final' });
  assert.equal(asked, '/final/onprem-config.json no-store', 'index.html と同じ階層を毎回サーバから読む');
});

test('OP07 端末に覚えるアカウント: 書く・読む・消す・壊れた値は null・使えない保管でも落ちない', () => {
  const st = memStorage();
  assert.equal(readDeviceLogin(st), null);
  assert.equal(writeDeviceLogin(st, { email: ' a@x ', password: 'p' }), true);
  assert.deepEqual(readDeviceLogin(st), { email: 'a@x', password: 'p', owner: '' });
  st.setItem(ONPREM_DEVICE_KEY, '{broken');
  assert.equal(readDeviceLogin(st), null);
  assert.equal(clearDeviceLogin(st), true);
  const dead = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => { throw new Error('x'); } };
  assert.equal(readDeviceLogin(dead), null);
  assert.equal(writeDeviceLogin(dead, { email: 'a', password: 'b' }), false);
  assert.equal(clearDeviceLogin(dead), false);
});

test('OP08 db/user の代わりの印: オブジェクト(WeakMap の鍵になる)・合言葉は空', async () => {
  assert.equal(typeof ONPREM_DB, 'object');
  const u = makeOnpremUser('a@x');
  assert.ok(u); assert.equal(await u.getIdToken(), '');
});

test('OP09 社内用の窓口は Firebase の関数を1つも呼ばない(連絡・通知・目標・写真も PocketBase へ)', async () => {
  const touched = [];
  const fsNames = ['collection', 'doc', 'onSnapshot', 'setDoc', 'deleteDoc', 'getDocs', 'getDoc', 'serverTimestamp', 'deleteField', 'updateDoc', 'runTransaction', 'query', 'where', 'orderBy', 'limit', 'startAfter', 'getCountFromServer', 'getDocFromServer', 'getDocFromCache'];
  const fs = Object.fromEntries(fsNames.map((n) => [n, (...a) => { touched.push(n); throw new Error(`Firebase の ${n} が呼ばれた`); }]));
  const calls = [];
  const fakePb = new Proxy({ kind: 'pocketbase' }, {
    get: (t, k) => (k in t ? t[k] : (...a) => { calls.push([k, a[0], a[1]]); return typeof k === 'string' && k.startsWith('watch') ? () => {} : Promise.resolve(null); }),
  });
  registerPocketbaseFactory(() => fakePb);
  const route = onpremRoute(parseOnpremConfig({ url: 'http://pb.test', email: 'a@x', password: 'p' }));
  const P = providerFor({ ...ONPREM_DB }, fs, route.providers, route.pbConfig);
  // 地図に載っている全部の置き場所を一通り触る
  const pairs = [];
  for (const [col, area] of Object.entries(COLLECTION_AREA)) pairs.push([area === 'contact' ? CONTACT_NS : NS.final, col]);
  pairs.push([NS.goals, 'settings'], [NS.capacity, 'plan_control'], [NS.capacity, 'plan_versions']);
  assert.ok(pairs.length > 10);
  for (const [ns, col] of pairs) {
    P.watchCollection(ns, col, () => {});
    await P.getAll(ns, col);
    await P.save(ns, col, 'x', { a: 1 });
    assert.equal(P.routeOf(ns, col).backend, 'pocketbase', `${ns}/${col}`);
  }
  for (const col of ['contact_requests', 'arrival_times', 'factory_calendar', 'app_notices', 'push_tokens']) {
    if (COLLECTION_AREA[col]) assert.equal(P.routeOf(COLLECTION_AREA[col] === 'contact' ? CONTACT_NS : NS.final, col).backend, 'pocketbase', col);
  }
  assert.deepEqual(touched, [], 'Firebase の関数は1つも呼ばれない');
  assert.ok(calls.length >= pairs.length * 3);
});
