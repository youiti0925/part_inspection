/* On-prem service worker (shared by product / final / parts: keep this file byte-identical in all three apps).
 * - Loads NO script from any other host (no external SDK). Push is handled here directly.
 * - Registered as "onprem-sw.js" next to index.html; its scope is that directory (e.g. /parts/).
 * - Only in the on-prem build (npm run build:onprem). The normal build keeps public/firebase-messaging-sw.js.
 * - No caching: the fetch handler exists only so the app is installable (it never answers, so the browser fetches normally).
 * - Two push kinds (onprem-config.json "pushMode", 2026-10-31):
 *     relay (default): the push carries an FCM JSON payload -> shown exactly as before.
 *     signal: the push has NO payload -> read {sid, secret} from IndexedDB (key = registration.scope),
 *             POST /__push/v1/inbox on this origin (credentials omit, 6 s timeout) and show what came back.
 *             If that fails, show a generic notice. Same IndexedDB names as src/data/webPushClient.js.
 * ASCII only (Japanese is written as \u escapes). */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

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
