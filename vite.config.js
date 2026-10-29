import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

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

// 🛡 2026-10-30 本番へ社内版が混ざらない為の関門(4アプリ共通の決まり)。
//   ・いつものビルド(mode が onprem 以外)に VITE_ONPREM=1 が入っていたら **止める**
//     (.env.local や環境変数に残った 1 で、本番の dist が「Firebase を起こさない社内版」になるのを防ぐ)。
//   ・社内版のビルド(mode=onprem)に VITE_ONPREM=1 が無ければ止める(dist-onprem に Firebase 版が入るのを防ぐ)。
//   ⚠ 開発サーバ(vite dev)は止めない。ビルドの時だけ。
export const onpremBuildProblem = ({ mode, command, flag }) => {
  if (command !== 'build') return ''
  const onprem = mode === 'onprem'
  if (!onprem && flag === '1') return `VITE_ONPREM=1 のまま いつものビルド(mode=${mode})をしようとしました。本番の dist に社内版が入るので止めます。社内版は npm run build:onprem で作ってください(.env.local と環境変数の VITE_ONPREM を確かめてください)。`
  if (onprem && flag !== '1') return '社内版のビルド(mode=onprem)なのに VITE_ONPREM=1 がありません(.env.onprem を確かめてください)。'
  return ''
}

// https://vite.dev/config/
export default defineConfig(({ mode, command }) => {
  const onprem = mode === 'onprem'
  // loadEnv は .env* と環境変数(process.env)の両方を見る。
  const flag = String(loadEnv(mode, process.cwd(), 'VITE_').VITE_ONPREM || '')
  const problem = onpremBuildProblem({ mode, command, flag })
  if (problem) throw new Error(`[onprem-guard] ${problem}`)
  return {
    plugins: onprem ? [react(), onpremDropPlugin('dist-onprem')] : [react()],
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
