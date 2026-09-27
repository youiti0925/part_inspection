import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
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
    ],
    rules: {
      'no-use-before-define': ['error', { functions: false, classes: false, variables: true, allowNamedExports: true }],
    },
  },
])
