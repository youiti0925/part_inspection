// ============================================================================
// 📴 社内版だけ: 「繋がらなくても開ける」の起動の部品(2026-11-02・社内版の4アプリで同じ中身)
// ----------------------------------------------------------------------------
// main.jsx の社内版の枝(import.meta.env.VITE_ONPREM === '1' / __ONPREM__)からだけ動的に読む = いつものビルドの出力には入らない。
//   ① Service Worker を早めに登録する(swFile を渡した時だけ。製品・最終・③は main.jsx が既に登録している。部品は画面の奥で
//      登録していたので、最初に開いた画面を SW が受け持てず、切れた時に開けない事があった)。同じ URL なので二重にはならない。
//   ② 「オフライン中・未送信 N 件」の札(offlineBadge.js)。未送信 = 送信待ちの箱(outbox)の数(outboxPending.js)。
//      切れているかは同じ口の precache.json へ HEAD で聞く(入口 https-front・PocketBase の読み取りは使わない)。
// ============================================================================
import { installOfflineBadge } from './offlineBadge.js';
import { countOutboxPending } from './outboxPending.js';

export const ONPREM_OFFLINE_LIMITS = Object.freeze([
  '機番AI・写真から読む機能(社内サーバーの中継が要る)',
  '写真・資料の送信(つながってから撮り直す/送り直す)',
  '通知・連絡の送受信',
  '他の端末が入れた変更の受け取り(つながると届きます)',
]);

export const startOnpremOffline = ({ swFile = '' } = {}) => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const go = () => {
    try {
      if (swFile && 'serviceWorker' in navigator) {
        navigator.serviceWorker.register(`./${swFile}`, { scope: './' }).catch(() => { /* 入れられないだけ。画面は動く */ });
      }
    } catch { /* 画面は動く */ }
    try {
      installOfflineBadge({
        probeUrl: new URL('precache.json', document.baseURI).href,
        getPending: () => countOutboxPending(),
        limits: ONPREM_OFFLINE_LIMITS,
      });
    } catch (e) { console.warn('[offline] 札を出せませんでした', e); }
  };
  if (document.readyState === 'complete') go(); else window.addEventListener('load', go);
};
