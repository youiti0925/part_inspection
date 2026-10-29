/* global importScripts, firebase, clients */
/* 社内サーバ版(npm run build:onprem)だけの Service Worker — 2026-10-30
 * ・本番の firebase-messaging-sw.js の代わり。⚠いつものビルド(dist)には入らない(vite.config.js の社内版の部品だけが写す)。
 * ・場所は index.html の横(相対)。アプリを /parts/ のような下の階層に置いても、その階層だけを受け持つ。
 * ・通知の公開設定(秘密ではない web 設定)は登録の URL の ?fb= で受け取る(SW は onprem-config.json を読めないため)。
 *   ?fb= が無い・壊れている時は通知を受けない(「アプリとして入れる」の為の SW としてだけ動く)。
 * ・キャッシュはしない(fetch は何もしない = 通常どおり取りに行く。古い画面のまま、を作らない)。 */
var fb = null;
try {
  var raw = new URL(self.location.href).searchParams.get('fb');
  if (raw) fb = JSON.parse(raw);
} catch { fb = null; }

if (fb && fb.apiKey && fb.projectId && fb.messagingSenderId && fb.appId) {
  try {
    importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
    importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');
    firebase.initializeApp({ apiKey: fb.apiKey, projectId: fb.projectId, messagingSenderId: fb.messagingSenderId, appId: fb.appId });
    var messaging = firebase.messaging();
    // data だけの知らせ(notification 無し)の時だけ自前で出す(本番の SW と同じ)
    messaging.onBackgroundMessage(function (payload) {
      if (payload && payload.notification) return;
      var d = (payload && payload.data) || {};
      self.registration.showNotification(d.title || '工程連絡', {
        body: d.body || '',
        icon: new URL('favicon.svg', self.registration.scope).href,
        tag: d.tag || undefined,
        renotify: d.tag ? true : undefined,
        requireInteraction: d.requireInteraction === '1',
        data: { link: d.link || self.registration.scope },
      });
    });
  } catch { /* 外へ出られない時は通知を受けないだけ。画面は普通に動く */ }
}

self.addEventListener('notificationclick', function (event) {
  var data = event.notification && event.notification.data;
  if (!data || data.FCM_MSG) return;
  event.notification.close();
  var link = new URL(data.link || './', self.registration.scope).href;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        try {
          var u = new URL(c.url);
          var t = new URL(link);
          if (u.pathname === t.pathname && u.search === t.search && 'focus' in c) return c.focus();
        } catch { /* noop */ }
      }
      return clients.openWindow(link);
    })
  );
});

self.addEventListener('fetch', function () { /* 何もしない = 通常どおり取りに行く */ });
