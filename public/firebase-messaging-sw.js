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

// 「アプリとしてインストール」(PWA)の条件を満たすためのハンドラ。
// ブラウザは「fetchハンドラを持つService Worker」がないとインストールを許さない。
// インストールできないと、Androidの設定にこのアプリの項目が出ず、
// 通知の重要度を「緊急」に上げたり電池最適化から外したりが一切できない(=Galaxyで通知が埋もれる根本原因)。
// ⚠ここでキャッシュは一切しない。respondWith を呼ばなければブラウザの通常の取得がそのまま走る。
//   下手にキャッシュすると「デプロイしたのに古い画面のまま」を再発させる(index.htmlは no-store 運用)。
self.addEventListener('fetch', () => { /* 何もしない = 通常どおり取りに行く */ });
