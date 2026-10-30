/* On-prem service worker (shared by product / final / parts: keep this file byte-identical in all three apps).
 * - Loads NO script from any other host (no external SDK). Push is handled here directly.
 * - Registered as "onprem-sw.js" next to index.html; its scope is that directory (e.g. /parts/).
 * - Only in the on-prem build (npm run build:onprem). The normal build keeps public/firebase-messaging-sw.js.
 * - No caching: the fetch handler exists only so the app is installable (it never answers, so the browser fetches normally).
 * ASCII only (Japanese is written as \u escapes). */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

const appRoot = () => self.registration.scope;

// Push from the notification relay (Worker -> FCM web push). Payload is FCM JSON: { notification, data, fcmOptions }.
// Same fields production uses: notification.{title,body,tag} or data-only data.{title,body,tag,requireInteraction,link}.
self.addEventListener('push', (event) => {
  let p = {};
  try { p = event.data ? event.data.json() : {}; } catch (e) { p = {}; }
  const n = (p && p.notification) || {};
  const d = (p && p.data) || {};
  const fo = (p && (p.fcmOptions || p.fcm_options)) || {};
  const title = n.title || d.title || '\u5de5\u7a0b\u9023\u7d61';
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

// Click: focus an open window of the same page, otherwise open it (relative links resolve against the scope).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = new URL((event.notification.data && event.notification.data.link) || appRoot(), appRoot()).href;
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
