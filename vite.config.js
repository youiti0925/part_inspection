import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { onpremGuardPlugin } from './scripts/guard-not-onprem.mjs'

// 🏢 2026-10-29 社内サーバ版(npm run build:onprem = vite build --mode onprem)だけ:
//   ① 出力先を dist-onprem に分ける(本番の dist と混ぜない)
//   ② public/firebase-messaging-sw.js を出力から外す(gstatic と Firebase の設定を中に持つ・社内版は通知を使わない)
//   ⚠ mode が onprem でない時(いつもの npm run build)は、前と同じ設定になる。
const ONPREM_DROP = ['firebase-messaging-sw.js']
const onpremDropPlugin = (outDir) => ({
  name: 'onprem-drop-firebase-files',
  apply: 'build',
  closeBundle() {
    for (const f of ONPREM_DROP) {
      const p = path.resolve(outDir, f)
      if (fs.existsSync(p)) fs.rmSync(p)
    }
  },
})

// 🛡 2026-10-30 本番へ社内版が混ざらない為の関門(4アプリ共通・1文字も違わない scripts/guard-not-onprem.mjs)。
//   plugins の先頭の onpremGuardPlugin() が、設定が決まった所(--mode・--outDir まで合わさった後)で見る:
//   ・いつものビルド(mode が onprem 以外)に VITE_ONPREM=1(環境変数でも .env.local などでも)→ 止める。
//   ・社内版のビルド(mode=onprem)に VITE_ONPREM=1 が無い(.env.onprem を確かめる)→ 止める。
//   ・社内版の出力先が本番の出力先(dist・大文字小文字を問わず・解決したパスで比べる)→ 止める。
//   ⚠ 開発サーバ(vite dev)は止めない。止めない時の設定・出力は今までと同じ(関門の部品は いつものビルドでは何も出さない)。

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const onprem = mode === 'onprem'
  // loadEnv は .env* と環境変数(process.env)の両方を見る。
  const flag = String(loadEnv(mode, process.cwd(), 'VITE_').VITE_ONPREM || '')
  return {
    plugins: [onpremGuardPlugin(), react(), ...(onprem ? [onpremDropPlugin('dist-onprem')] : [])],
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
