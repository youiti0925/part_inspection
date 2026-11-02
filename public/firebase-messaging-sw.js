/* 工程連絡 プッシュ通知の受信 Service Worker (部品検査アプリ)
 * バックグラウンド(画面を閉じている/他アプリを見ている)時の通知表示を担当する。
 * notification付きメッセージはFCM SDK+ブラウザが自動表示するので、ここはdata-onlyの保険と
 * 自前表示分のクリック処理だけ。configは公開webキー(秘密ではない)。 */
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDiIS-TDH6MgXaLvG9T2VRioFDomQ_zQ9E",
  authDomain: "inspection-time-c4fd3.firebaseapp.com",
  projectId: "inspection-time-c4fd3",
  storageBucket: "inspection-time-c4fd3.firebasestorage.app",
  messagingSenderId: "750297489065",
  appId: "1:750297489065:web:b19e30920b2c68182fd3b8",
});

const messaging = firebase.messaging();

// data-only メッセージ(notification無し)のときだけ自前で表示する
messaging.onBackgroundMessage((payload) => {
  if (payload && payload.notification) return; // ブラウザが自動表示済み
  const d = (payload && payload.data) || {};
  self.registration.showNotification(d.title || '工程連絡', {
    body: d.body || '',
    icon: '/favicon.svg',
    tag: d.tag || undefined,
    renotify: d.tag ? true : undefined,          // 同じ用件の再通知でも鳴らし直す
    requireInteraction: d.requireInteraction === '1', // 触るまで消さない(連絡アプリの設定)
    data: { link: d.link || '/' },
  });
});

// 自前表示分のクリック→リンクを開く。SDK表示分(FCM_MSG持ち)はSDKに任せる。
self.addEventListener('notificationclick', (event) => {
  const data = event.notification && event.notification.data;
  if (!data || data.FCM_MSG) return;
  event.notification.close();
  const link = data.link || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        try {
          const u = new URL(c.url);
          const t = new URL(link, self.location.origin);
          if (u.pathname === t.pathname && u.search === t.search && 'focus' in c) return c.focus();
        } catch (e) { /* noop */ }
      }
      return clients.openWindow(link);
    })
  );
});

// 「アプリとしてインストール」(PWA)の条件(fetch ハンドラを持つ SW)は、下の「繋がらなくても開ける」の fetch が満たす。
// ⚠2026-11-02 までは「何もしない fetch」だった(キャッシュ一切なし)。社内 LAN が落ちた日に画面が開けなかったので、
//   画面の入口はネットワーク優先(繋がっていれば必ず最新)・版の印の付いた部品だけ端末優先、に変えた。
//   index.html の no-store 運用(「デプロイしたのに古い画面のまま」を出さない)は崩さない(下の規則1)。
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

// ============================================================================
// Offline shell (2026-11-02): the app still opens when Wi-Fi / LAN / the server is down.
// SAME BLOCK in every app (cloud x4 and on-prem x4). ASCII only. Change all copies together.
// Rules (do not break them):
//  1. The app page (navigation inside this SW's scope) is NETWORK FIRST. When the network answers,
//     the fresh page is used and stored. Only when the network fails or does not answer within
//     OFF_NAV_TIMEOUT_MS is the stored page used. (= a deploy is never hidden behind an old page.)
//  2. "<scope>assets/..." files have the build hash in their name, so they are CACHE FIRST.
//  3. Other hosts (Firestore, PocketBase realtime, AI proxy, Google) and every non-GET request are
//     never touched (no respondWith). Same-origin "api/", "_/", "__*" paths are never touched either.
//  4. version.json / precache.json / the SW scripts are never answered from the cache.
//  5. onprem-config.json (on-prem only) is NETWORK FIRST with a stored copy as the fallback, so the
//     on-prem boot (group check + config) still works while the server is unreachable.
//  6. precache.json (written by the build: this build's asset names, relative to the scope) is read
//     on activate and at most every OFF_REFRESH_MS after an online page load; missing assets are
//     stored, assets of older builds are dropped (this build + the previous build are kept).
// ============================================================================
const OFF_CACHE = 'offline-shell-v1';
const OFF_NAV_TIMEOUT_MS = 4000;
const OFF_REFRESH_MS = 5 * 60 * 1000;
const OFF_ASSET_NAME = /^assets\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,200}$/;
let offLastRefresh = 0;
let offRefreshing = null;

const offScope = () => self.registration.scope;                 // always ends with "/"
const offUrl = (p) => new URL(p, offScope()).href;
const offShellKey = () => offUrl('./');                          // the stored app page
const offListKey = () => offUrl('./__offline_precache_list__');  // the asset list stored last time
const offRest = (url) => (url.href.startsWith(offScope()) ? url.href.slice(offScope().length).split(/[?#]/)[0] : null);

const offTimeout = (p, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout')), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});
const offIsHtml = (res) => !!res && res.ok && res.type !== 'opaqueredirect' && /text\/html/i.test(res.headers.get('content-type') || '');
const offIsJson = (res) => !!res && res.ok && /json/i.test(res.headers.get('content-type') || '');

async function offRefresh() {
  const cache = await caches.open(OFF_CACHE);
  try {
    const shell = await fetch(offShellKey(), { cache: 'no-store', credentials: 'same-origin' });
    if (offIsHtml(shell)) await cache.put(offShellKey(), shell);
  } catch (e) { /* offline: keep the stored page */ }
  // on-prem: keep a copy of onprem-config.json too (the first page of a device is not controlled yet, so its own
  // read of the config never passes through this worker). Cloud builds have no such JSON file -> nothing stored.
  try {
    const cfg = await fetch(offUrl('./onprem-config.json'), { cache: 'no-store', credentials: 'same-origin' });
    if (offIsJson(cfg)) await cache.put(offUrl('./onprem-config.json'), cfg);
  } catch (e) { /* offline: keep the stored copy */ }
  let list;
  try {
    const r = await fetch(offUrl('./precache.json'), { cache: 'no-store', credentials: 'same-origin' });
    if (!offIsJson(r)) return;
    const j = await r.json();
    list = (Array.isArray(j && j.files) ? j.files : []).map((f) => String(f).replace(/^\/+/, ''))
      .filter((f) => OFF_ASSET_NAME.test(f)).map(offUrl);
  } catch (e) { return; }
  for (const u of list) {
    try {
      if (await cache.match(u)) continue;
      const res = await fetch(u, { credentials: 'same-origin' });
      if (res.ok) await cache.put(u, res);
    } catch (e) { /* try again next time */ }
  }
  let prev = [];
  try { const p = await cache.match(offListKey()); if (p) prev = await p.json(); } catch (e) { prev = []; }
  const keep = new Set(list.concat(Array.isArray(prev) ? prev : []));
  const assetsRoot = offUrl('./assets/');
  for (const req of await cache.keys()) {
    if (req.url.startsWith(assetsRoot) && !keep.has(req.url)) await cache.delete(req);
  }
  await cache.put(offListKey(), new Response(JSON.stringify(list), { headers: { 'content-type': 'application/json' } }));
}
function offRefreshOnce() {
  if (offRefreshing) return offRefreshing;
  offLastRefresh = Date.now();
  offRefreshing = offRefresh().catch(() => {}).then(() => { offRefreshing = null; });
  return offRefreshing;
}

// Network first; when it fails / is too slow, the stored copy under `key`. `keep(res)` decides what may be stored.
function offNetworkFirst(event, key, keep) {
  const net = fetch(event.request);
  const stored = net.then(async (res) => {
    if (keep(res)) { const c = await caches.open(OFF_CACHE); await c.put(key, res.clone()); }
    return res;
  });
  event.waitUntil(stored.then(() => {}, () => {}));
  return offTimeout(stored, OFF_NAV_TIMEOUT_MS).catch(async () => {
    const hit = await caches.match(key, { cacheName: OFF_CACHE });
    if (hit) return hit;
    return stored;   // nothing stored yet: wait for the network (its error is what the user sees)
  });
}

async function offCacheFirst(event) {
  const cache = await caches.open(OFF_CACHE);
  const hit = await cache.match(event.request.url);
  if (hit) return hit;
  const res = await fetch(event.request);
  if (res && res.ok && res.type === 'basic') { try { await cache.put(event.request.url, res.clone()); } catch (e) { /* storage full: still answer */ } }
  return res;
}

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => (k.startsWith('offline-shell-') || k.startsWith('app-shell-')) && k !== OFF_CACHE).map((k) => caches.delete(k)));
  })());
  // Storing the assets must NOT hold the activation (the page would stay uncontrolled while ~10 MB download).
  // If the worker is stopped before it finishes, the next page load starts it again (offLastRefresh is 0 again).
  offRefreshOnce();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  const rest = offRest(url);
  if (rest === null) return;                                              // other host / outside the scope
  if (/^(api\/|_\/|__)/.test(rest)) return;                               // PocketBase, its admin UI, front/push endpoints
  if (/(^|\/)(version\.json|precache\.json|onprem-files\.json)$/.test(rest) || /sw\.js$/.test(rest)) return;
  if (rest === 'onprem-config.json') { event.respondWith(offNetworkFirst(event, offUrl('./onprem-config.json'), offIsJson)); return; }
  if (req.mode === 'navigate') {
    if (rest !== '' && rest !== 'index.html' && /\.[A-Za-z0-9]{1,8}$/.test(rest)) return;   // another file (e.g. *.html tool page)
    event.respondWith(offNetworkFirst(event, offShellKey(), offIsHtml));
    if (Date.now() - offLastRefresh > OFF_REFRESH_MS) event.waitUntil(offRefreshOnce());
    return;
  }
  if (OFF_ASSET_NAME.test(rest)) { event.respondWith(offCacheFirst(event)); return; }
  // everything else (icons, manifest, notice images, photos): the browser's normal fetch
});
