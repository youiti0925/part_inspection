import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'

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

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const onprem = mode === 'onprem'
  return {
    plugins: onprem ? [react(), onpremDropPlugin('dist-onprem')] : [react()],
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
