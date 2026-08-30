import './polyfills.js' // 古いSafari(iOS11)向けポリフィル。必ず最初に。
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './index.css'
// 🛟 描画で例外が出ても真っ白にしない受け皿。⚠これが無いと原因が何であれ結果は「白画面」になる。
import { ErrorBoundary, watchGlobalErrors } from './ErrorBoundary.jsx'
// 🚨 「まだ送れていない保存がある間は読み直させない」関所(2026-08-30)。
//   ⚠版の見張りとは切り離して**必ず**置く。index.html の「切り替える」はこれを見る。
import { installReloadGate } from './reloadGate.js'

installReloadGate()
watchGlobalErrors()
createRoot(document.getElementById('root')).render(<ErrorBoundary where="app"><App /></ErrorBoundary>)
