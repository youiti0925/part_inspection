// 工程連絡 プッシュ通知(FCM) クライアントヘルパー。
// VAPID鍵とWorker URLは settings.push に保存する(Firestore側に持つ=再ビルド不要で運用開始できる)。
// 送信はCloudflare Worker(/fcm/send)経由 — サービスアカウント鍵をクライアントに出さないため。
import { getApp } from 'firebase/app';
import { getMessaging, getToken, onMessage, isSupported, deleteToken } from 'firebase/messaging';

// 端末の種類判定(ヘルプの出し分けとpush_tokensの記録用)
export const pushPlatform = () => {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  // iPadOSはMacintoshを名乗るのでタッチ有無で判定
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
  const android = /Android/.test(ua);
  const standalone = (typeof window !== 'undefined') &&
    ((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true);
  return { os: ios ? 'ios' : (android ? 'android' : 'pc'), standalone };
};

// この端末でプッシュが使えない理由(ユーザー向け文言)。空文字=使える見込み。
export const pushSupportProblem = () => {
  if (typeof window === 'undefined') return '未対応の環境です';
  if (!window.isSecureContext) return 'httpsでないため通知を使えません(本番URLで開いてください)';
  if (!('serviceWorker' in navigator)) return 'このブラウザは通知に対応していません(Chrome/Safari最新版を使ってください)';
  if (!('Notification' in window)) {
    const p = pushPlatform();
    if (p.os === 'ios' && !p.standalone) return 'iPhone/iPadは「ホーム画面に追加」したアイコンから開くと通知を使えます(通知ヘルプの手順参照)';
    return 'このブラウザは通知に対応していません';
  }
  return '';
};

// この端末を表す安定ID(push_tokensのdocId)。トークンが更新されても同じdocを上書きする。
export const pushDeviceId = () => {
  try {
    let id = localStorage.getItem('pushDeviceId');
    if (!id) {
      id = 'pd-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      localStorage.setItem('pushDeviceId', id);
    }
    return id;
  } catch (e) {
    return 'pd-volatile';
  }
};

let swRegPromise = null;
const ensureSw = () => {
  if (!swRegPromise) swRegPromise = navigator.serviceWorker.register('/firebase-messaging-sw.js');
  return swRegPromise;
};

// 通知許可→FCMトークン取得。成功でトークン文字列。失敗は Error(ユーザー向けメッセージ)。
export async function enablePush(vapidKey) {
  const prob = pushSupportProblem();
  if (prob) throw new Error(prob);
  if (!(await isSupported())) throw new Error('このブラウザはプッシュ通知(FCM)に対応していません');
  if (!vapidKey || !String(vapidKey).trim()) throw new Error('VAPID鍵が未設定です。管理者が連絡タブ→宛先・公開設定→通知(プッシュ)で設定してください');
  // 公開鍵の形式チェック: P-256公開鍵のbase64urlは必ず「B」始まり・約87文字。
  // 43文字前後は「秘密鍵」を貼ってしまった典型パターンなので、ここで分かりやすく弾く。
  const k = String(vapidKey).trim();
  if (!/^B[A-Za-z0-9_-]{85,90}$/.test(k)) {
    throw new Error(`VAPID鍵が公開鍵の形式ではありません(今の値: 「${k[0] || ''}」始まり・${k.length}文字)。正しいのは「B」で始まる約88文字です。Firebaseコンソール→プロジェクト設定→Cloud Messaging→ウェブプッシュ証明書の「鍵ペア」欄(公開鍵)をコピーしてください${k.length >= 40 && k.length <= 46 ? '(※43文字前後は秘密鍵です。公開鍵の方を貼ってください)' : ''}`);
  }
  const reg = await ensureSw();
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('通知が許可されませんでした。端末/ブラウザの設定でこのサイトの通知を「許可」にしてください(通知ヘルプ参照)');
  const token = await getToken(getMessaging(getApp()), { vapidKey: String(vapidKey).trim(), serviceWorkerRegistration: reg });
  if (!token) throw new Error('この端末を登録できませんでした。電波を確認して、時間をおいてもう一度押してください');
  return token;
}

// この端末の受信を止める(トークン無効化)。失敗しても黙って続行(doc削除側が本体)。
export async function disablePush() {
  try { if (await isSupported()) await deleteToken(getMessaging(getApp())); } catch (e) { /* noop */ }
}

// フォアグラウンド(画面を開いている時)の受信購読。unsubscribe関数をresolveする。
export async function listenForegroundPush(handler) {
  try {
    if (pushSupportProblem() || !(await isSupported())) return () => {};
    if (Notification.permission !== 'granted') return () => {};
    return onMessage(getMessaging(getApp()), (payload) => {
      const n = (payload && payload.notification) || {};
      const d = (payload && payload.data) || {};
      handler({ title: n.title || d.title || '工程連絡', body: n.body || d.body || '', link: d.link || '' });
    });
  } catch (e) {
    return () => {};
  }
}

// Worker経由でFCM送信。業務操作(Firestore書き込み)を止めないよう、失敗してもthrowしない。
export async function sendPushViaWorker(workerUrl, { tokens, title, body, link, tag, requireInteraction, vibrate }) {
  try {
    const res = await fetch(String(workerUrl).replace(/\/+$/, '') + '/fcm/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokens, title, body, link, tag, requireInteraction, vibrate }),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}
