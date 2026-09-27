import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'src/opsim/parallelLab/ui.js']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },
  // ⚠⚠ 画面部品の中で「まだ値が入っていない名前」を読むと その場で白画面になる(製品 eslint.config.js と同じ塊)。
  //   App.jsx は後ろで定義した関数を JSX から呼ぶ書き方が多く安全なので入れない。いま0件のファイルだけを対象にする。
  //   新しい画面部品を足したら、この一覧にも足すこと。
  {
    files: [
      'src/SkillMap.jsx', 'src/StrictModeManager.jsx', 'src/TemplateSkipPanel.jsx', 'src/RotaryMeasurements.jsx',
      'src/HelpManual.jsx', 'src/ErrorBoundary.jsx', 'src/workscreen/**/*.jsx',
      // 2026-09-27 製品から移した操業シミュレーションの画面(製品と同じ対象・ui.js は build.py が大域名を注入する見本なので上で除外)
      'src/OperationsSimulationPanel.jsx', 'src/opsim/**/*.jsx', 'src/opsim/**/*.js',
    ],
    rules: {
      'no-use-before-define': ['error', { functions: false, classes: false, variables: true, allowNamedExports: true }],
    },
  },
  // 📨 製品から1バイト同じで写したファイル(product-pairs.test.mjs で md5 を見張る)。中身を直すと対が壊れるので、
  //   製品のままの書き方(未使用の catch 変数など)はここで黙らせる。⚠ no-undef は止めない(白画面の網)。
  {
    files: ['src/push.js', 'src/ArrivalCheck.jsx', 'src/IncomingArrivals.jsx'],
    rules: {
      'no-unused-vars': 'off',
      'react-refresh/only-export-components': 'off',
      'react-hooks/purity': 'off',
    },
  },
])
