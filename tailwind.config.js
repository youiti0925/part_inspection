/** @type {import('tailwindcss').Config} */

// 余白の段。v4 の --spacing 相当を v3 で自前に持つ。名前を --spacing に揃えてあるのは、
// applyFontSizes を最終検査と**同じ文面**に保つため(2アプリで読み比べられるようにする)。
const sp = (n) => `calc(var(--spacing, 0.25rem) * ${n})`;
const SPACING = { px: '1px', 0: '0px' };
[0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24, 28, 32,
  36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 96].forEach((n) => { SPACING[n] = sp(n); });

// 文字の段。[rem, 行間の比]。100%時の見た目は v3 既定と完全一致する値。
const TEXT_STEPS = {
  xs: [0.75, 1 / 0.75], sm: [0.875, 1.25 / 0.875], base: [1, 1.5],
  lg: [1.125, 1.75 / 1.125], xl: [1.25, 1.75 / 1.25], '2xl': [1.5, 2 / 1.5],
  '3xl': [1.875, 2.25 / 1.875], '4xl': [2.25, 2.5 / 2.25], '5xl': [3, 1],
  '6xl': [3.75, 1], '7xl': [4.5, 1], '8xl': [6, 1], '9xl': [8, 1],
};
// 12px未満の段。text-[10px] のような px 直書きを置き換えるために足す(製品に1,806件ある)。
// ⚠px 直書きは zoom なら一緒に拡大したが、変数方式では**一切拡大しない**。
//   つまり zoom を外す前にここへ寄せておかないと、その文字だけ機能が後退する。
// ⚠**行間(lineHeight)は意図的に与えない**(文字列形式)。配列にすると line-height が出力され、
//   font-size だけを変える text-[10px] と挙動が変わって行間が動く。
// 🚨 2026-09-16 清水さん「見やすいかどうか…妥協しないように」→ **文字の床を 12px** にした。
//   それまで 11/10/9/8px の4段が 2,500か所で使われ、写しの実測で1画面に最大346件の
//   12px未満の字が出ていた。段は残す(class を2,500か所書き換えない)が、**値を床に揃える**。
//   ⚠ここと src/App.jsx の TW_TEXT_REM / SMALL_TEXT_STEPS_CSS は **同じ値**にする事。
const SMALL_STEPS = { '2xs': 0.75, '3xs': 0.75, '4xs': 0.75, '5xs': 0.75 }; // 全部 12px @16px(床)
const FONT_SIZE = {};
Object.entries(TEXT_STEPS).forEach(([k, [rem, lh]]) => {
  FONT_SIZE[k] = [`var(--text-${k}, ${rem}rem)`, { lineHeight: String(Number(lh.toFixed(6))) }];
});
Object.entries(SMALL_STEPS).forEach(([k, rem]) => { FONT_SIZE[k] = `var(--text-${k}, ${rem}rem)`; });

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  // === 文字サイズ機能(applyFontSizes)の土台 (2026-08-14 / 段階1) ===
  // ⚠なぜ config を触るのか: 最終検査は Tailwind v4 で、`p-4` が
  //   `padding: calc(var(--spacing) * 4)` に、`text-sm` が `font-size: var(--text-sm)` に
  //   コンパイルされる。だから area 内で変数を上書きするだけでレイアウトごと拡大できた。
  //   **製品検査は v3 で `.p-4{padding:1rem}` とリテラルに焼かれる**ため、同じ手は原理的に効かない
  //   (本番CSS index-CH8W8onn.css に var(--spacing) は 0 件だった)。
  //   → v3 のまま theme を var() 参照にすれば同じ形になる。ここがその宣言。
  // ⚠fallback 付き `var(--spacing, 0.25rem)` にしてあるのが要点。誰も変数を設定しない間は
  //   0.25rem に解決される = **今と1pxも変わらない**。だから「config だけ先に入れて
  //   applyFontSizes は zoom のまま」という段階移行ができる。将来 v4 に上げると
  //   :root に --spacing が定義されるだけで、そのまま一致する。
  // ⚠line-height を rem から**無単位の比**へ変えている。rem のままだと文字だけ大きくなって
  //   行間が置き去りになり、160% で行が重なる。比なら font-size に自動で追従する。
  //   100%時の実効値は使用中の10段すべて従来と完全一致(scripts/verify-font-scale.mjs で機械突合)。
  // ⚠段を増やしたら App.jsx の TW_TEXT_REM にも必ず足すこと。足し忘れると**その段だけ拡大せず**、
  //   最終検査で起きた「分母(text-2xl)が分子(text-4xl)を追い越す」逆転事故になる(2026-08-08)。
  theme: {
    extend: {},
    spacing: SPACING,
    fontSize: FONT_SIZE,
  },
  plugins: [],
};
