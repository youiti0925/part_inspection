/* On-prem service worker (shared by product / final / parts: keep this file byte-identical in all three apps).
 * - Loads NO script from any other host (no external SDK). Push is handled here directly.
 * - Registered as "onprem-sw.js" next to index.html; its scope is that directory (e.g. /parts/).
 * - Only in the on-prem build (npm run build:onprem). The normal build keeps public/firebase-messaging-sw.js.
 * - Offline shell (2026-11-02, block at the end): the app page is network first (fresh when the server answers),
 *   build-hashed assets/ are cache first, onprem-config.json falls back to the stored copy. api/, _/, __* are never touched.
 *   So the app still opens when the LAN / server is down (it did not on 2026-11-02).
 * - Two push kinds (onprem-config.json "pushMode", 2026-10-31):
 *     relay (default): the push carries an FCM JSON payload -> shown exactly as before.
 *     signal: the push has NO payload -> read {sid, secret} from IndexedDB (key = registration.scope),
 *             POST /__push/v1/inbox on this origin (credentials omit, 6 s timeout) and show what came back.
 *             If that fails, show a generic notice. Same IndexedDB names as src/data/webPushClient.js.
 * ASCII only (Japanese is written as \u escapes). */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const appRoot = () => self.registration.scope;
const swOrigin = () => new URL(appRoot()).origin;
const DEFAULT_TITLE = '\u5de5\u7a0b\u9023\u7d61';
const GENERIC_BODY = '\u65b0\u3057\u3044\u9023\u7d61\u304c\u3042\u308a\u307e\u3059';
const IDB_NAME = 'onprem-push';
const IDB_STORE = 'subs';
const INBOX_TIMEOUT_MS = 6000;

// Link: a same-origin URL only; anything else (other host, javascript:, //host) -> the scope.
const safeLink = (link) => {
  const s = String(link || '');
  if (!s || /^\s*(javascript|data|blob|file|vbscript):/i.test(s) || /^\s*\/\//.test(s) || s.indexOf('\\') >= 0) return appRoot();
  try {
    const u = new URL(s, appRoot());
    if (u.origin !== swOrigin()) return appRoot();
    return u.href;
  } catch (e) { return appRoot(); }
};

const pushApi = (name) => new URL('/__push/v1/' + name, swOrigin()).href;

const readSub = () => new Promise((resolve) => {
  let req;
  try { req = self.indexedDB.open(IDB_NAME, 1); } catch (e) { resolve(null); return; }
  req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE); };
  req.onerror = () => resolve(null);
  req.onsuccess = () => {
    const db = req.result;
    try {
      const g = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(appRoot());
      g.onsuccess = () => { try { db.close(); } catch (e) { /* noop */ } resolve(g.result || null); };
      g.onerror = () => { try { db.close(); } catch (e) { /* noop */ } resolve(null); };
    } catch (e) { resolve(null); }
  };
});

const postJson = (url, body) => {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => { if (ctl) ctl.abort(); }, INBOX_TIMEOUT_MS);
  return fetch(url, {
    method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl ? ctl.signal : undefined,
  }).then((res) => { clearTimeout(timer); return res; }, (err) => { clearTimeout(timer); throw err; });
};

const showGeneric = () => self.registration.showNotification(DEFAULT_TITLE, {
  body: GENERIC_BODY, icon: new URL('icon-192.png', appRoot()).href, tag: 'onprem-signal', renotify: true, data: { link: appRoot() },
});

const showItem = (it) => {
  const title = String((it && it.title) || DEFAULT_TITLE).slice(0, 120);
  const opts = {
    body: String((it && it.body) || '').slice(0, 300),
    icon: new URL('icon-192.png', appRoot()).href,
    data: { link: safeLink(it && it.link) },
  };
  const tag = String((it && it.tag) || '').slice(0, 100);
  if (tag) { opts.tag = tag; opts.renotify = true; }
  if (it && (it.requireInteraction === true || it.requireInteraction === '1')) opts.requireInteraction = true;
  return self.registration.showNotification(title, opts);
};

// 4 or more notices -> the newest 2 one by one + one "N more" notice. Items come oldest first.
const showItems = (items) => {
  if (items.length < 4) return Promise.all(items.map(showItem));
  const rest = items.length - 2;
  return Promise.all(items.slice(-2).map(showItem).concat([self.registration.showNotification(DEFAULT_TITLE, {
    body: '\u307b\u304b' + rest + '\u4ef6\u306e\u9023\u7d61\u304c\u3042\u308a\u307e\u3059',
    icon: new URL('icon-192.png', appRoot()).href, tag: 'onprem-signal-more', renotify: true, data: { link: appRoot() },
  })]));
};

const showSignal = () => readSub().then((rec) => {
  if (!rec || !rec.sid || !rec.secret) throw new Error('no subscription record');
  return postJson(pushApi('inbox'), { sid: String(rec.sid), secret: String(rec.secret) });
}).then((res) => {
  if (!res || !res.ok) throw new Error('inbox ' + (res ? res.status : '?'));
  return res.json();
}).then((j) => {
  const items = (j && Array.isArray(j.items)) ? j.items.filter((x) => x && typeof x === 'object').slice(-20) : [];
  if (!items.length) throw new Error('inbox empty');
  return showItems(items);
}).catch(() => showGeneric());

// Push from the notification relay (Worker -> FCM web push). Payload is FCM JSON: { notification, data, fcmOptions }.
// Same fields production uses: notification.{title,body,tag} or data-only data.{title,body,tag,requireInteraction,link}.
// A push with no payload is the signal mode (see the top of this file).
self.addEventListener('push', (event) => {
  let text = '';
  try { text = event.data ? (typeof event.data.text === 'function' ? event.data.text() : JSON.stringify(event.data.json())) : ''; } catch (e) { text = ''; }
  if (!text) { event.waitUntil(showSignal()); return; }
  let p = {};
  try { p = event.data ? event.data.json() : {}; } catch (e) { p = {}; }
  const n = (p && p.notification) || {};
  const d = (p && p.data) || {};
  const fo = (p && (p.fcmOptions || p.fcm_options)) || {};
  const title = n.title || d.title || DEFAULT_TITLE;
  const tag = n.tag || d.tag || '';
  const opts = {
    body: n.body || d.body || '',
    icon: new URL('icon-192.png', appRoot()).href,
    data: { link: fo.link || d.link || appRoot() },
  };
  if (tag) { opts.tag = tag; opts.renotify = true; }
  if (n.requireInteraction === true || d.requireInteraction === '1') opts.requireInteraction = true;
  if (Array.isArray(n.vibrate)) opts.vibrate = n.vibrate;
  event.waitUntil(self.registration.showNotification(title, opts));
});

// The browser replaced the subscription: tell the server the new endpoint (same sid / secret).
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(readSub().then((rec) => {
    if (!rec || !rec.sid || !rec.secret) return null;
    const next = event.newSubscription ? Promise.resolve(event.newSubscription)
      : (event.oldSubscription && event.oldSubscription.options
        ? self.registration.pushManager.subscribe(event.oldSubscription.options)
        : self.registration.pushManager.getSubscription());
    return next.then((sub) => {
      if (!sub) return null;
      const j = sub.toJSON();
      return postJson(pushApi('renew'), { sid: String(rec.sid), secret: String(rec.secret), endpoint: j.endpoint, keys: j.keys || {} });
    });
  }).catch(() => null));
});

// Click: focus an open window of the same page, otherwise open it (relative links resolve against the scope;
// a link to another host opens the scope instead).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = safeLink((event.notification.data && event.notification.data.link) || appRoot());
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        try {
          const u = new URL(c.url);
          const t = new URL(link);
          if (u.origin === t.origin && u.pathname === t.pathname && u.search === t.search && 'focus' in c) return c.focus();
        } catch (e) { /* noop */ }
      }
      return self.clients.openWindow(link);
    })
  );
});

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
