// ============================================================================
// 社内サーバ版(オンプレ)のプッシュ通知 — 2026-10-30(清水さんの決定 D4: 社内版でも通知を使う)
// ----------------------------------------------------------------------------
// ⚠ このファイルの関数は 社内版のビルド(IS_ONPREM_BUILD)の時だけ呼ばれる(ContactKit・App の起動の所)。
//   いつものビルドでは呼ばれないので、出力から消える(本番の push.js の動きは1つも変わらない)。
// ⚠ push.js は製品と1バイト同じに保つ決まり(product-pairs)なので、社内版の違いはここに置く。違いは3つだけ:
//   ① Service Worker の場所が相対(アプリを /parts/ のような下の階層に置いても動く)。
//      本番は '/firebase-messaging-sw.js'(一番上)。社内版は index.html の横の 'onprem-sw.js'。
//   ② Firebase は「通知(Messaging)」の為だけに起こす(Firestore・ログイン・Storage は起こさない)。
//      名前付きの app('onprem-push')にして、ほかの Firebase の道と混ざらないようにする。
//   ③ 通知の宛先の端末一覧(push_tokens)は PocketBase に置く(保管庫の窓口が決める・ここは触らない)。
//   送る道は本番と同じ: 連絡タブの設定(settings.push の VAPID 鍵と Worker URL)→ 外の中継(/fcm/send)。
// ============================================================================
import { initializeApp, getApps } from 'firebase/app';
import { getMessaging, getToken, onMessage, isSupported, deleteToken } from 'firebase/messaging';
import { pushSupportProblem as pushSupportProblemBase } from './push.js';

/** 社内版の Service Worker のファイル名(index.html と同じ階層・相対で登録する)。 */
export const ONPREM_SW_FILE = 'onprem-sw.js';
const APP_NAME = 'onprem-push';

/** 通知の為だけに使う Firebase の公開 web 設定の既定(本番の public/firebase-messaging-sw.js と同じ公開値・秘密ではない)。
 *  onprem-config.json の pushFirebase で上書きできる(書かなければこの既定 = 本番と同じ通知の窓口)。 */
export const ONPREM_PUSH_FIREBASE_DEFAULT = {
  apiKey: 'AIzaSyDiIS-TDH6MgXaLvG9T2VRioFDomQ_zQ9E',
  projectId: 'inspection-time-c4fd3',
  messagingSenderId: '750297489065',
  appId: '1:750297489065:web:b19e30920b2c68182fd3b8',
};
const KEYS = ['apiKey', 'projectId', 'messagingSenderId', 'appId'];

/** 設定ファイルの pushFirebase を確かめる(純関数)。4つの鍵が揃っていなければ既定。
 *  pushFirebase が false なら通知を使わない(null)。 */
export const pushFirebaseOf = (raw) => {
  if (raw === false) return null;
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : null;
  if (o && KEYS.every((k) => typeof o[k] === 'string' && o[k].trim())) {
    return Object.fromEntries(KEYS.map((k) => [k, o[k].trim()]));
  }
  return Object.assign({}, ONPREM_PUSH_FIREBASE_DEFAULT);   // 🧪 R2: { ...x } と書かない(onprem.js と同じ理由)
};

/** Service Worker の URL(相対・index.html の横)。2026-10-30 製品・最終と同じファイル(onprem-public/onprem-sw.js・3アプリで1バイトも違わない)。
 *  SW は外から何も読まず、push を自分で受けて通知を出す = Firebase の設定は要らない(前の ?fb= は渡さない)。
 *  Firebase の公開設定を使うのは画面側の通知の登録(getToken・同梱の firebase/messaging)だけ。 */
export const onpremSwUrl = () => `./${ONPREM_SW_FILE}`;

let _fb = null;          // 起動の所が setOnpremPush で入れる
let _swPromise = null;
export const setOnpremPush = (raw) => { _fb = pushFirebaseOf(raw); _swPromise = null; return _fb; };
export const onpremPushConfig = () => _fb;

/** SW を登録する(起動の所で1回・「アプリとして入れる」にも要る)。scope は index.html の階層(相対 './')。 */
export const registerOnpremSw = () => {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return Promise.resolve(null);
  if (!_swPromise) _swPromise = navigator.serviceWorker.register(onpremSwUrl(), { scope: './' });
  return _swPromise;
};

const messagingApp = () => {
  if (!_fb) throw new Error('この社内サーバでは通知を使わない設定です(onprem-config.json の pushFirebase が false)');
  return getApps().find((a) => a.name === APP_NAME) || initializeApp(_fb, APP_NAME);
};

export const pushSupportProblem = () => {
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return 'https でないため通知を使えません(社内サーバの https の入口から開いてください)';
  }
  if (!_fb) return 'この社内サーバでは通知を使わない設定です';
  return pushSupportProblemBase();
};

// 通知の許可 → FCM の端末の印(トークン)。中身は push.js の enablePush と同じ順番(SW の場所と app だけが違う)。
// ⚠ async を書かずに Promise で書く(古い Safari 向けの変換で async は「すぐ呼ぶ包み」になり、いつものビルドの出力に残る・onprem.js と同じ理由)。
export const enablePush = (vapidKey) => Promise.resolve().then(() => {
  const prob = pushSupportProblem();
  if (prob) throw new Error(prob);
  return isSupported();
}).then((ok) => {
  if (!ok) throw new Error('このブラウザはプッシュ通知(FCM)に対応していません');
  if (!vapidKey || !String(vapidKey).trim()) throw new Error('VAPID鍵が未設定です。管理者が連絡タブ→宛先・公開設定→通知(プッシュ)で設定してください');
  const k = String(vapidKey).trim();
  if (!/^B[A-Za-z0-9_-]{85,90}$/.test(k)) {
    throw new Error(`VAPID鍵が公開鍵の形式ではありません(今の値: 「${k[0] || ''}」始まり・${k.length}文字)。正しいのは「B」で始まる約88文字です。`);
  }
  return registerOnpremSw().then((reg) => Notification.requestPermission().then((perm) => {
    if (perm !== 'granted') throw new Error('通知が許可されませんでした。端末/ブラウザの設定でこのサイトの通知を「許可」にしてください(通知ヘルプ参照)');
    return getToken(getMessaging(messagingApp()), { vapidKey: k, serviceWorkerRegistration: reg });
  }));
}).then((token) => {
  if (!token) throw new Error('この端末を登録できませんでした。電波を確認して、時間をおいてもう一度押してください');
  return token;
});

export const disablePush = () => Promise.resolve()
  .then(() => (_fb ? isSupported() : false))
  .then((ok) => (ok ? deleteToken(getMessaging(messagingApp())) : null))
  .then(() => undefined, () => undefined);   // 宛先の行を消す方が本体(ここは失敗しても黙って続ける)

export const listenForegroundPush = (handler) => Promise.resolve()
  .then(() => (pushSupportProblem() ? false : isSupported()))
  .then((ok) => {
    if (!ok || Notification.permission !== 'granted') return () => {};
    return onMessage(getMessaging(messagingApp()), (payload) => {
      const n = (payload && payload.notification) || {};
      const d = (payload && payload.data) || {};
      handler({ title: n.title || d.title || '工程連絡', body: n.body || d.body || '', link: d.link || '' });
    });
  })
  .catch(() => () => {});
