import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { collectBuildStamp } from './scripts/verify-no-regress.mjs'

// https://vite.dev/config/
// ============================================================================
// 🆕 版の印(build id)をビルドに焼き込む(2026-11-03・最終検査と同じ物)
// ----------------------------------------------------------------------------
// 何のため: 出す前の ⓪(scripts/verify-no-regress.mjs)が「いま本番に出ている版が、これから出す物の
//   祖先か」を調べる為。2026-11-03 に、別の枝から本番へ出していた直しを master から出して黙って消した。
// 焼き込む先は同じ1つの値:
//   ① index.html の <meta name="app-build" content="YYYYMMDD-HHMMSS-<短いハッシュ>">
//   ② dist/version.json  {"build":"…","commit":"<40桁>","dirty":false,"builtAt":"…"}
//      dirty = 追跡中のファイルが変わったまま焼いた(.claude/ は数えない)。
// ⚠静的ファイルだけ(Firestore を使わない＝読み書きの枠を食わない)。firebase.json で version.json は no-store。
// ⚠作る処理は scripts/verify-no-regress.mjs の collectBuildStamp(4アプリ共通)。
// ============================================================================
function buildStamp() {
  const STAMP = collectBuildStamp()
  return {
    name: 'app-build-stamp',
    transformIndexHtml() {
      return [
        { tag: 'meta', attrs: { name: 'app-build', content: STAMP.build }, injectTo: 'head' },
        { tag: 'meta', attrs: { name: 'app-built-at', content: STAMP.builtAt }, injectTo: 'head' },
      ]
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: `${JSON.stringify({ build: STAMP.build, commit: STAMP.commit, dirty: STAMP.dirty, builtAt: STAMP.builtAt }, null, 2)}
`,
      })
    },
    closeBundle() {
      console.log(`  app-build-stamp: 版の印 = ${STAMP.build}${STAMP.dirty ? '  ⚠dirty' : ''}`)
    },
  }
}

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
  plugins: [react(), buildStamp(), offlinePrecache()],
  server: {
    port: 5174,
  },
  build: {
    // 古い Safari (iOS 11 / Safari 11) 向け: ?. ?? などの新構文を変換して白画面を防ぐ
    target: ['es2015', 'safari11'],
  },
})
