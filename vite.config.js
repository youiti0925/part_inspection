import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// ============================================================================
// 📴 繋がらなくても開ける(2026-11-02): この版の画面部品の一覧(precache.json)を出す
// ----------------------------------------------------------------------------
// 何のため: LAN/Wi-Fi が落ちても、一度開いた端末ではアプリが開くようにする。
//   端末の Service Worker(public/firebase-messaging-sw.js の「Offline shell」)が、この一覧の物を裏で端末に保存しておく。
// ⚠名前は index.html からの相対(assets/…)。社内版(base ./・/final/ の様な下の階層)でも同じ一覧が使える。
// ⚠一覧は「この版のビルドで出来た物」だけ。js/css/字体/wasm は 20MB まで、画像は 1MB まで
//   (端末の容量と通信を食わない為)。外した物は skippedBig に名前を残す(黙って外さない)。外した部品の画面だけは繋がるまで開けない。
// ⚠これは保存の一覧を出すだけ。配信の設定(index.html は no-store)は変えない。
// ============================================================================
function offlinePrecache() {
  const CODE_LIMIT = 20 * 1024 * 1024
  const IMAGE_LIMIT = 1024 * 1024
  return {
    name: 'offline-precache',
    generateBundle(_o, bundle) {
      const files = []
      const skippedBig = []
      let bytes = 0
      for (const [name, item] of Object.entries(bundle)) {
        if (!name.startsWith('assets/')) continue
        const size = item.type === 'chunk' ? Buffer.byteLength(item.code) : Buffer.byteLength(item.source)
        const isCode = /\.(js|css|woff2?|ttf|wasm)$/.test(name)
        const isImage = /\.(png|jpe?g|gif|svg|webp|ico)$/.test(name)
        if (!isCode && !isImage) continue
        if (size > (isCode ? CODE_LIMIT : IMAGE_LIMIT)) { skippedBig.push(name); continue }
        files.push(name)
        bytes += size
      }
      files.sort()
      this.emitFile({
        type: 'asset',
        fileName: 'precache.json',
        source: `${JSON.stringify({ files, bytes, skippedBig }, null, 1)}\n`,
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), offlinePrecache()],
  server: {
    port: 5174,
  },
  build: {
    // 古い Safari (iOS 11 / Safari 11) 向け: ?. ?? などの新構文を変換して白画面を防ぐ
    target: ['es2015', 'safari11'],
  },
})
