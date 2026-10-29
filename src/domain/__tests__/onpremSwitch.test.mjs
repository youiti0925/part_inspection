// ============================================================================
// 社内サーバ版のスイッチ(VITE_ONPREM=1)の試験 — 2026-10-29
// ----------------------------------------------------------------------------
// 確かめる事:
//   ① スイッチが無い時(いつもの本番)は、行き先は全部 Firebase のまま・設定の pocketbase が無ければ切り替わらない
//   ② 社内版の行き先は全部の領域(連絡・通知の宛先も)PocketBase で、端末に覚えた行き先や設定で戻らない
//   ③ 設定ファイル onprem-config.json が優先・無ければビルドの時の VITE_PB_URL・合言葉は設定ファイルからだけ
//   ④ 画面の入口の配線(Firebase を起こす前に社内版の道へ分かれる・SW を登録しない・外の Worker を既定に入れない)
//   ⑤ vite の設定: mode=onprem だけ dist-onprem へ出す。いつものビルドの設定は前と同じ
// ⚠通信なし。本物の PocketBase での起動はまだ確かめていない。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IS_ONPREM_BUILD, ONPREM_PROVIDERS, ONPREM_DB, normalizeOnpremConfig, loadOnpremConfig, pbConfigOfOnprem,
} from '../../onprem.js';
import {
  applyOnpremRoute, currentProviders, dataFor, isOnpremRoute, __resetDataRouteForTest, __setOnpremBuildForTest,
} from '../../dataRoute.js';
import { DEFAULT_PROVIDERS, AREAS, NS } from '../../data/routes.js';
import { registerPocketbaseFactory } from '../../data/provider.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const FS_MIN = Object.fromEntries(['collection', 'doc', 'onSnapshot', 'setDoc', 'deleteDoc', 'getDocs', 'getDoc',
  'serverTimestamp', 'deleteField', 'updateDoc', 'runTransaction'].map((k) => [k, () => { throw new Error(`Firebase の ${k} が呼ばれた`); }]));

test('O01 node(=スイッチの無いビルド)では社内版ではない・行き先の既定は全部 Firebase', () => {
  __resetDataRouteForTest();
  assert.equal(IS_ONPREM_BUILD, false);
  globalThis.localStorage = undefined;
  assert.deepEqual(currentProviders(), DEFAULT_PROVIDERS);
  assert.ok(AREAS.every((a) => DEFAULT_PROVIDERS[a] === 'firebase'));
  assert.equal(isOnpremRoute(), false);
});

test('O02 いつものビルド: 共有の設定・端末の記憶・社内版の行き先のどれでも PocketBase へ切り替わらない(2026-10-30)', async () => {
  __resetDataRouteForTest();
  assert.equal(IS_ONPREM_BUILD, false);
  // 端末に前の作りの行き先(data.route.v1)が覚えてあっても読まない
  let touched = 0;
  globalThis.localStorage = {
    getItem: () => { touched++; return JSON.stringify({ enabled: true, url: 'http://pb:8090', email: 'e', password: 'p' }); },
    setItem: () => { touched++; },
  };
  assert.deepEqual(currentProviders(), DEFAULT_PROVIDERS);
  // 社内版の行き先を呼ばれても、ビルドが社内版でなければ何もしない(二重の止め)
  const r = applyOnpremRoute({ url: 'http://pb:8090', email: 'e', password: 'p' });
  assert.deepEqual(r.providers, DEFAULT_PROVIDERS);
  assert.equal(r.pbConfig, null);
  assert.equal(isOnpremRoute(), false);
  // 窓口も全部 Firebase(PocketBase の工場は呼ばれない)
  let pbMade = 0;
  registerPocketbaseFactory(() => { pbMade++; return { kind: 'pocketbase' }; });
  const P = dataFor({ db: 'normal' }, FS_MIN);
  for (const [ns, col] of [[NS.parts, 'lots'], [NS.parts, 'lot_images'], [NS.contact, 'contact_requests'], [NS.parts, 'push_tokens'],
    [NS.goals, 'settings'], [NS.product, 'rotaryMeasurements']]) {
    assert.equal(P.routeOf(ns, col).backend, 'firebase', `${ns}/${col}`);
  }
  assert.equal(pbMade, 0, 'PocketBase の窓口を作らない');
  assert.equal(touched, 0, '端末の記憶を読み書きしない');
  globalThis.localStorage = undefined;
  // 切替の口(設定から行き先を作る・端末に覚える)はもう出していない
  const mod = await import('../../dataRoute.js');
  for (const k of ['applyDataRoute', 'savedRouteFromSettings', 'DATA_ROUTE_KEY', 'ensureDataRoute']) assert.equal(mod[k], undefined, k);
  // 画面: 共有の設定(settings.pocketbase)を見て端末に覚える所が無い
  const app = read('src/App.jsx');
  assert.ok(!/settings\?\.pocketbase/.test(app), 'settings.pocketbase を見ない');
  assert.ok(!/data\.route\.v1|DATA_ROUTE_KEY/.test(app), '端末に行き先を覚えない');
  assert.ok(!/localStorage\s*\./.test(read('src/dataRoute.js')), 'dataRoute.js は端末の記憶に触らない');
  __resetDataRouteForTest();
});

test('O03 社内版の行き先: 全部の領域が PocketBase(連絡と通知の宛先も)・以後 設定や端末の記憶で戻らない', () => {
  __resetDataRouteForTest();
  __setOnpremBuildForTest(true);
  assert.ok(AREAS.every((a) => ONPREM_PROVIDERS[a] === 'pocketbase'), '6つの領域すべて');
  const r = applyOnpremRoute({ url: 'http://pb:8090', email: 'e', password: 'p', authCollection: 'device_users' });
  assert.equal(r.providers, ONPREM_PROVIDERS);
  assert.equal(r.pbConfig.url, 'http://pb:8090');
  // 端末に覚えた行き先も読まない
  globalThis.localStorage = { getItem: () => { throw new Error('社内版で端末の記憶を読んだ'); } };
  assert.equal(currentProviders(), ONPREM_PROVIDERS);
  globalThis.localStorage = undefined;
  __resetDataRouteForTest();
});

test('O04 社内版の窓口: db の代わりの鍵で作れ、検査・写真・連絡・通知・共有棚が全部 PocketBase へ行き、Firebase の関数は1つも呼ばない', async () => {
  __resetDataRouteForTest();
  const seen = [];
  const fakePb = {
    kind: 'pocketbase',
    getAll: async (ns, col) => { seen.push(`${ns}/${col}`); return []; },
    save: async (ns, col) => { seen.push(`${ns}/${col}`); },
    uploadFile: async (ns, col) => { seen.push(`${ns}/${col}`); return 'http://pb/x'; },
  };
  let gotCfg = null;
  registerPocketbaseFactory((cfg) => { gotCfg = cfg; return fakePb; });
  __setOnpremBuildForTest(true);
  applyOnpremRoute({ url: 'http://pb:8090', email: 'e', password: 'p' });
  const P = dataFor(ONPREM_DB, FS_MIN);
  assert.ok(P, 'db の代わりの鍵で窓口ができる');
  assert.equal(gotCfg.url, 'http://pb:8090');
  await P.getAll(NS.parts, 'lots');
  await P.save(NS.contact, 'contact_requests', 'r1', { a: 1 });
  await P.save(NS.parts, 'push_tokens', 't1', { a: 1 });
  await P.getAll(NS.capacity, 'plan_versions');
  await P.getAll(NS.goals, 'settings');
  await P.uploadFile(NS.parts, 'work_standard_files', 'template-images', 'data:,a');
  assert.deepEqual(seen, [`${NS.parts}/lots`, `${NS.contact}/contact_requests`, `${NS.parts}/push_tokens`,
    `${NS.capacity}/plan_versions`, `${NS.goals}/settings`, `${NS.parts}/work_standard_files`]);
  for (const col of ['lots', 'lot_images', 'improvements', 'contact_requests', 'push_tokens', 'rotaryMeasurements']) {
    assert.equal(P.routeOf(NS.parts, col).backend, 'pocketbase', col);
  }
  assert.equal(P.routeOf(NS.product, 'rotaryMeasurements').backend, 'pocketbase', '回転計測(製品の名前空間)も同じ行き先(点検 G5)');
  __resetDataRouteForTest();
});

test('O05 設定ファイル: 優先・無ければ VITE_PB_URL・合言葉は設定ファイルからだけ・読めなくても投げない', async () => {
  const ok = normalizeOnpremConfig({ pocketbase: { url: 'http://pb:8090/', email: 'e', password: 'p' } }, { VITE_PB_URL: 'http://other' });
  assert.equal(ok.ok, true); assert.equal(ok.url, 'http://pb:8090'); assert.equal(ok.source, 'config');
  const envOnly = normalizeOnpremConfig(null, { VITE_PB_URL: 'http://env:8090', VITE_PB_EMAIL: 'x', VITE_PB_PASSWORD: 'y' });
  assert.equal(envOnly.url, 'http://env:8090'); assert.equal(envOnly.source, 'env');
  assert.equal(envOnly.email, '', 'ビルドの時の値から合言葉を読まない(VITE_ は JS に焼き込まれる)');
  assert.equal(envOnly.ok, false);
  const none = normalizeOnpremConfig(null, {});
  assert.equal(none.ok, false); assert.equal(none.url, ''); assert.ok(none.problems.length >= 1);
  assert.equal(normalizeOnpremConfig({ url: 'pb:8090', email: 'e', password: 'p' }).ok, false, 'http(s):// が無ければ駄目');

  // 2026-10-30 4アプリ共通の形(鍵は一番上)・appUrls は文字だけ拾う・前の形({pocketbase:{...}})も読める
  const flat = normalizeOnpremConfig({ url: 'http://pb:8090/', email: 'e', password: 'p', authCollection: 'devs',
    appUrls: { 'final-inspection-v1': ' http://srv/final/ ', bad: 3, empty: '' } }, { VITE_PB_URL: 'http://other' });
  assert.equal(flat.ok, true); assert.equal(flat.url, 'http://pb:8090'); assert.equal(flat.source, 'config');
  assert.equal(flat.email, 'e'); assert.equal(flat.authCollection, 'devs');
  assert.deepEqual(flat.appUrls, { 'final-inspection-v1': 'http://srv/final/' });
  assert.deepEqual(normalizeOnpremConfig(null, {}).appUrls, {});
  const both = normalizeOnpremConfig({ url: 'http://top', pocketbase: { url: 'http://nested', email: 'ne', password: 'np' } });
  assert.equal(both.url, 'http://top', '一番上が優先'); assert.equal(both.email, 'ne', '一番上に無い鍵は前の形から拾う');
  const example = JSON.parse(read('docs/onprem-config.example.json'));
  for (const k of ['url', 'email', 'password', 'authCollection']) assert.equal(typeof example[k], 'string', `見本は一番上に ${k}`);
  assert.equal(example.pocketbase, undefined, '見本は前の形を使わない');

  const fetch404 = async () => ({ ok: false, status: 404 });
  const r1 = await loadOnpremConfig({ fetchImpl: fetch404, env: { VITE_PB_URL: 'http://env' } });
  assert.equal(r1.url, 'http://env'); assert.match(r1.readProblem, /404/);
  const fetchThrow = async () => { throw new Error('つながらない'); };
  const r2 = await loadOnpremConfig({ fetchImpl: fetchThrow, env: {} });
  assert.equal(r2.ok, false); assert.match(r2.readProblem, /つながらない/);
  let asked = '';
  const fetchOk = async (p) => { asked = p; return { ok: true, json: async () => ({ pocketbase: { url: 'http://pb', email: 'e', password: 'p' } }) }; };
  const r3 = await loadOnpremConfig({ fetchImpl: fetchOk, env: {} });
  assert.equal(asked, 'onprem-config.json', 'index.html の横を相対で読む');
  assert.equal(r3.ok, true);
  assert.equal(pbConfigOfOnprem(r3).authCollection, 'device_users');
});

test('O06 画面の入口の配線: 社内版は Firebase を起こす前に分かれる・SW を登録しない・通知を使わない・外の Worker を既定に入れない', () => {
  const app = read('src/App.jsx');
  const eff = app.indexOf('if (IS_ONPREM_BUILD) {');
  const init = app.indexOf('const app = initializeApp(FIREBASE_CONFIG);');
  assert.ok(eff > 0 && init > eff, '社内版の分かれ道は initializeApp より前');
  const branch = app.slice(eff, init);
  assert.match(branch, /return \(\) => \{ alive = false; \};\s*\}\s*if \(!FIREBASE_CONFIG\.apiKey\) return;/, '社内版の道は return で抜け、Firebase の道へ落ちない');
  for (const bad of ['signInAnonymously', 'getAuth(', 'initializeFirestore', 'getStorage(', 'getMessaging']) assert.ok(!branch.includes(bad), `社内版の道で ${bad} を呼ばない`);
  assert.match(branch, /applyOnpremRoute\(cfg/); assert.match(branch, /setDb\(ONPREM_DB\)/); assert.match(branch, /setUser\(ONPREM_USER\)/);
  assert.match(app, /const DATA = \(db\) => dataFor\(db, FS_EST\);/);
  assert.match(app, /if \(attachmentsOffFirebase\(\)\) return await uploadViaProvider\(base64DataUrl, pathHint, 'jpg'\);/);
  const main = read('src/main.jsx');
  assert.match(main, /if \('serviceWorker' in navigator && import\.meta\.env\.VITE_ONPREM !== '1'\)/);
  const kit = read('src/contact/ContactKit.jsx');
  assert.match(kit, /const pushSupportProblem = \(\) => \(IS_ONPREM_BUILD \? ONPREM_PUSH_OFF : pushSupportProblemFcm\(\)\);/);
  assert.match(kit, /const sendPushViaWorker = \(workerUrl, msg\) => \(IS_ONPREM_BUILD \? Promise\.resolve\(\{ ok: false, skipped: true/);
  assert.match(kit, /const enablePush = \(vapidKey\) => \(IS_ONPREM_BUILD \? Promise\.reject/);
  assert.match(app, /if \(!IS_ONPREM_BUILD && cfg\.vapidKey && cfg\.workerUrl && targets\.length\)/, '週報の通知も社内版では送らない');
  assert.equal(read('src/push.js').includes('ONPREM'), false, 'push.js は製品と同じ中身のまま(product-pairs)');
  assert.match(kit, /import\.meta\.env\.VITE_ONPREM === '1' \? '' : 'https:\/\/gemini-proxy\.you0925\.workers\.dev'/);
  const rot = read('src/RotaryMeasurements.jsx');
  assert.match(rot, /const DATA = \(d\) => dataFor\(d, FS_API\);/, '回転計測も同じ行き先(点検 G5)');
  assert.ok(!rot.includes('const DATA = (d) => providerFor'), '前の2つの引数の呼び方が残っていない');
});

test('O07 .env.onprem: スイッチを入れ、外の Worker を空にする・合言葉を書かない', () => {
  const env = Object.fromEntries(read('.env.onprem').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split(/=(.*)/s).slice(0, 2)));
  assert.equal(env.VITE_ONPREM, '1');
  assert.equal(env.VITE_DRIVE_PROXY_URL, '');
  assert.equal(env.VITE_GEMINI_PROXY_URL, '');
  assert.ok(!Object.keys(env).some((k) => /PASSWORD|SECRET|TOKEN|API_?KEY/.test(k)));
});

test('O08 vite の設定: mode=onprem だけ dist-onprem・SW を外す。いつものビルドは前と同じ設定', async () => {
  const mod = await import('../../../vite.config.js');
  const prod = mod.default({ mode: 'production', command: 'build' });
  assert.equal(prod.build.outDir, undefined, 'いつものビルドは dist(既定)');
  assert.deepEqual(prod.build.target, ['es2015', 'safari11']);
  assert.equal(prod.server.port, 5174);
  assert.equal(prod.plugins.flat().some((p) => p && p.name === 'onprem-drop-firebase-files'), false);
  const on = mod.default({ mode: 'onprem', command: 'build' });
  assert.equal(on.build.outDir, 'dist-onprem');
  assert.ok(on.plugins.flat().some((p) => p && p.name === 'onprem-drop-firebase-files'));
  // 2026-10-30 社内版かどうかはビルドの時の定数(いつものビルドは false = 社内版の道が出力から消える)
  assert.equal(prod.define.__ONPREM__, 'false');
  assert.equal(on.define.__ONPREM__, 'true');
});

test('O10 本番へ社内版が混ざらない関門: vite の設定の先頭に4アプリ共通の関門(guard-not-onprem)がある', async () => {
  // ⚠決め方と本物の vite で止まる事は src/domain/__tests__/guardNotOnprem.test.mjs(4アプリ同じ中身)で見る。
  const mod = await import('../../../vite.config.js');
  for (const mode of ['production', 'onprem']) {
    const c = mod.default({ mode, command: 'build' });
    assert.equal(c.plugins[0].name, 'guard-not-onprem', `mode=${mode} でも先頭`);
  }
  assert.equal(mod.onpremBuildProblem, undefined, 'アプリごとの関門は残していない(1つに揃えた)');
});

test('O09 社内版の写し: index.html は最後・onprem-config.json は写さない・外の字を数える', async () => {
  const { planCopy, countExternal } = await import('../../../scripts/deploy-onprem.mjs');
  const p = planCopy(['index.html', 'assets/b.js', 'assets/a.js', 'onprem-config.json', 'manifest.json']);
  assert.deepEqual(p.order, ['assets/a.js', 'assets/b.js', 'manifest.json', 'index.html']);
  assert.deepEqual(p.skip, ['onprem-config.json']);
  assert.equal(countExternal('x workers.dev y workers.dev firebaseapp.com')['workers.dev'], 2);
});
