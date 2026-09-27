import './polyfills.js' // 古いSafari(iOS11)向けポリフィル。必ず最初に。
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './index.css'
// 🛟 描画で例外が出ても真っ白にしない受け皿。⚠これが無いと原因が何であれ結果は「白画面」になる。
import { ErrorBoundary, watchGlobalErrors } from './ErrorBoundary.jsx'
// 🚨 「まだ送れていない保存がある間は読み直させない」関所(2026-08-30)。
//   ⚠版の見張りとは切り離して**必ず**置く。index.html の「切り替える」はこれを見る。
import { installReloadGate } from './reloadGate.js'

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
createRoot(document.getElementById('root')).render(<ErrorBoundary where="app"><App /></ErrorBoundary>)
