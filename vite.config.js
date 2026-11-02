import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { onpremGuardPlugin } from './scripts/guard-not-onprem.mjs'

// 🏢 2026-10-29 社内サーバ版(npm run build:onprem = vite build --mode onprem)だけ:
//   ① 出力先を dist-onprem に分ける(本番の dist と混ぜない)
//   ② public/firebase-messaging-sw.js を出力から外す(一番上 '/' 決め打ちの本番用。社内版は ③ の onprem-sw.js を使う)
//   ③ 2026-10-30(決定 D1/D2/D4): アプリを '/' でも '/parts/' のような下の階層でも置けるようにする:
//      ・base を './'(相対)にする(assets・アイコン・manifest を index.html の階層から読む)
//      ・index.html の版の見張りの fetch('/index.html…') を相対にする(下の階層で隣のアプリの版を見ない為)
//      ・manifest の start_url / scope / アイコンを相対にする
//      ・onprem-public/onprem-sw.js(社内版の通知と「アプリとして入れる」の SW)を写す
//      ・docs/onprem-config.example.json を onprem-config.sample.json として写す(本物の onprem-config.json は写さない・上書きしない)
//   ⚠ mode が onprem でない時(いつもの npm run build)は、前と同じ設定になる(この部品は入らない)。
const ONPREM_DROP = ['firebase-messaging-sw.js']
const ONPREM_MANIFESTS = ['manifest.json', 'manifest-renraku.json']
/** manifest の '/' 始まりを相対にする(純関数・試験用)。'/' → './'、'/?renraku=1' → './?renraku=1'、'/icon-192.png' → 'icon-192.png'。 */
export const relativizeManifest = (m) => {
  const rel = (u) => (typeof u !== 'string' || !u.startsWith('/') || u.startsWith('//')) ? u
    : (u === '/' || u.startsWith('/?') || u.startsWith('/#')) ? `.${u}` : u.slice(1)
  return {
    ...m,
    ...(m.start_url !== undefined ? { start_url: rel(m.start_url) } : {}),
    ...(m.scope !== undefined ? { scope: rel(m.scope) } : {}),
    ...(Array.isArray(m.icons) ? { icons: m.icons.map((i) => ({ ...i, src: rel(i.src) })) } : {}),
  }
}
/** index.html の版の見張りが読む先を相対にする(純関数・試験用)。 */
export const relativizeIndexHtml = (html) => html.split("fetch('/index.html?__v='").join("fetch('index.html?__v='")
const onpremDropPlugin = (outDir) => ({
  name: 'onprem-drop-firebase-files',
  apply: 'build',
  transformIndexHtml: { order: 'pre', handler: (html) => relativizeIndexHtml(html) },
  closeBundle() {
    for (const f of ONPREM_DROP) {
      const p = path.resolve(outDir, f)
      if (fs.existsSync(p)) fs.rmSync(p)
    }
    for (const f of ONPREM_MANIFESTS) {
      const p = path.resolve(outDir, f)
      if (fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(relativizeManifest(JSON.parse(fs.readFileSync(p, 'utf8'))), null, 2))
    }
    fs.copyFileSync(path.resolve('onprem-public', 'onprem-sw.js'), path.resolve(outDir, 'onprem-sw.js'))
    fs.copyFileSync(path.resolve('docs', 'onprem-config.example.json'), path.resolve(outDir, 'onprem-config.sample.json'))
  },
})

// 🛡 2026-10-30 本番へ社内版が混ざらない為の関門(4アプリ共通・1文字も違わない scripts/guard-not-onprem.mjs)。
//   plugins の先頭の onpremGuardPlugin() が、設定が決まった所(--mode・--outDir まで合わさった後)で見る:
//   ・いつものビルド(mode が onprem 以外)に VITE_ONPREM=1(環境変数でも .env.local などでも)→ 止める。
//   ・社内版のビルド(mode=onprem)に VITE_ONPREM=1 が無い(.env.onprem を確かめる)→ 止める。
//   ・社内版の出力先が本番の出力先(dist・大文字小文字を問わず・解決したパスで比べる)→ 止める。
//   ⚠ 開発サーバ(vite dev)は止めない。止めない時の設定・出力は今までと同じ(関門の部品は いつものビルドでは何も出さない)。

// https://vite.dev/config/
// ============================================================================
// 📴 繋がらなくても開ける(2026-11-02): この版の画面部品の一覧(precache.json)を出す
// ----------------------------------------------------------------------------
// 何のため: LAN/Wi-Fi が落ちても、一度開いた端末ではアプリが開くようにする。
//   端末の Service Worker(社内版の Service Worker(onprem-sw.js / ③は sw.js)の「Offline shell」)が、この一覧の物を裏で端末に保存しておく。
// ⚠名前は index.html からの相対(assets/…)。社内版(base ./・/final/ の様な下の階層)でも同じ一覧が使える。
// ⚠一覧は「この版のビルドで出来た物」だけ。js/css/字体/wasm は 20MB まで、画像は 1MB まで
//   (端末の容量と通信を食わない為)。外した物は skippedBig に名前を残す(黙って外さない)。外した部品の画面だけは繋がるまで開けない。
// ⚠社内版のビルド(VITE_ONPREM=1 / mode onprem)だけで出す。いつものビルド(Firebase 版)の出力は今までと同じ。
// ⚠precache.json は入口(https-front)と関門(scripts/onprem-dist-guard.mjs)の「配ってよい形」に足してある。
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

export default defineConfig(({ mode }) => {
  const onprem = mode === 'onprem'
  // loadEnv は .env* と環境変数(process.env)の両方を見る。
  const flag = String(loadEnv(mode, process.cwd(), 'VITE_').VITE_ONPREM || '')
  return {
    // 社内版だけ相対(下の階層 /parts/ でも動く)。いつものビルドは base を書かない(= '/' のまま・前と同じ)。
    ...(onprem ? { base: './' } : {}),
    plugins: [onpremGuardPlugin(), react(), ...(onprem ? [onpremDropPlugin('dist-onprem'), offlinePrecache()] : [])],
    // 社内版かどうかをビルドの時の定数にする(いつものビルドでは false → 社内版だけの道は出力から消える)。
    define: { __ONPREM__: JSON.stringify(onprem && flag === '1') },
    server: {
      port: 5174,
    },
    build: {
      // 古い Safari (iOS 11 / Safari 11) 向け: ?. ?? などの新構文を変換して白画面を防ぐ
      target: ['es2015', 'safari11'],
      ...(onprem ? { outDir: 'dist-onprem' } : {}),
    },
  }
})
