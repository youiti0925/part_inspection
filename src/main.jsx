import './polyfills.js' // 古いSafari(iOS11)向けポリフィル。必ず最初に。
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './index.css'
// 🛟 描画で例外が出ても真っ白にしない受け皿。⚠これが無いと原因が何であれ結果は「白画面」になる。
import { ErrorBoundary, watchGlobalErrors } from './ErrorBoundary.jsx'
// 🚨 「まだ送れていない保存がある間は読み直させない」関所(2026-08-30)。
//   ⚠版の見張りとは切り離して**必ず**置く。index.html の「切り替える」はこれを見る。
import { installReloadGate } from './reloadGate.js'
// 📴 2026-11-02 Wi-Fi/LAN が切れても使える: 「オフライン中・未送信 N 件」の札(React の外・どの画面でも出る)
import { installOfflineBadge } from './offline/offlineBadge.js'
import { countFirestorePending } from './offline/firestorePending.js'

// P140: 製品 src/main.jsx の SW 登録と「アプリとして入れる」合図の捕まえを写した
// Service Worker を起動時に必ず登録する。
// ⚠これが無いと「アプリをインストール」がブラウザのメニューに出ない。
//   ブラウザは「fetchハンドラを持つSWが登録済み」でないとインストールを許さず、代わりに
//   「ホーム画面に追加」(=ただのショートカット)しか出さない。ショートカットではOSの設定に
//   アプリの項目が出ないので、通知の重要度を「緊急」に上げられない = Galaxyで通知が埋もれたまま。
// ⚠以前は push.js の ensureSw() だけが登録しており、それは「この端末で通知を受け取る」を押した
//   端末でしか走らなかった。押していない端末はSWゼロ=インストール不可だった(実際にそうなっていた)。
// 同じURL/スコープなので、後から push.js が register しても同じ登録が返るだけ(二重にならない)。
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/firebase-messaging-sw.js').catch(() => { /* 失敗時はインストールできないだけ。画面は普通に動く */ })
  })
}

// 「アプリとして入れられます」の合図(beforeinstallprompt)を捕まえて取っておく。
// ⚠ここで捕まえないとブラウザ任せになり、Chromeのメニューの奥に「アプリをインストール」が
//   埋もれる(=現場では見つけられない。実際「そんなメニューは無い」と言われた)。
//   取っておけば、アプリの中の分かりやすいボタンから1タップで入れられる。
// ⚠この合図はページ読み込みのごく初期に飛ぶので、必ず render より前・最上位で待つ。
//   React の中で addEventListener しても間に合わない。
window.__pwaInstallEvent = null
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()                    // ブラウザ既定のミニバーを止め、こちらのボタンで出す
  window.__pwaInstallEvent = e
  window.dispatchEvent(new Event('pwa-installable'))
})
window.addEventListener('appinstalled', () => {
  window.__pwaInstallEvent = null
  window.dispatchEvent(new Event('pwa-installed'))
})

installReloadGate()
watchGlobalErrors()
// ============================================================================
// 📴 オフラインの札(2026-11-02・最終/製品/部品/③で同じ形)
// ・未送信の数 = Firestore の端末の待ち行列(persistentLocalCache)の件数。再読込の後に復活した保存も数える。
//   数えられない端末は、画面の保存の札(window.__appSaveStatus)が在ればその「まだ」を使う(0 と言わない)。
// ・切れているかは同じ口の precache.json に HEAD で聞く(Firestore の読み取りは使わない)。
// ============================================================================
window.addEventListener('load', () => {
  try {
    installOfflineBadge({
      probeUrl: '/precache.json',
      getPending: async () => {
        const n = await countFirestorePending('inspection-time-c4fd3')
        if (n !== null) return { count: n }
        const st = window.__appSaveStatus || {}
        return { count: null, has: !!(st.unknown || st.unsent > 0 || st.fsPending || st.lotsPending) }
      },
    })
  } catch (e) { console.warn('オフラインの札を出せませんでした', e) }
})

createRoot(document.getElementById('root')).render(<ErrorBoundary where="app"><App /></ErrorBoundary>)
