// 🔠 文字サイズを上げても **画面からはみ出さない** ことを実測する。
//
// ⚠⚠ 私(Claude)は「zoom は当たり判定がズレる根因」と言っていたが、**それは今のChromeでは間違い**。
//   設計役が実測して否定した(rect の中心に elementFromPoint が一致し、実クリックも届く)。
//   本当に壊れているのはこちら:
//     ・zoom の下では `85vh` が「ビューポート基準で解決してから×倍率」される
//       → 160% で **276px 画面外**(実測)。作業/測定画面に vh/vw の指定が15か所ある
//     ・`fixed` の子の `right-4` / `bottom-20` が倍率ぶんズレる
//       → それを打ち消すための `unzoom`(逆倍率)と `width:100/Xvw` という2つの場当たりが生まれた
//
// ⚠⚠ この試験は **直す前に書いた**。いまは わざと落ちるはず。
//
// 使い方: BASE=http://localhost:<部品の写しのポート> node scripts/verify-font-scale.mjs
import { chromium } from 'playwright-core';

const BASE = process.env.BASE || 'http://localhost:5174';
const problems = [];
const say = (ok, label, extra = '') => {
  console.log(` ${ok ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) problems.push(label + (extra ? ' — ' + extra : ''));
};

const br = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});
// ⚠現場のタブレットに合わせる。ここを広くすると はみ出しが隠れて **偽の合格** が出る。
const ctx = await br.newContext({ viewport: { width: 1024, height: 768 }, locale: 'ja-JP' });
const p = await ctx.newPage();

// 実アプリの入れ子・実クラスを切り出した1枚。
// ⚠本番データが要る画面(作業モーダル)は、ログインを通さないと出せない。
//   CSSの話なので、**同じ入れ子・同じクラス**を再現すれば十分に決着がつく
//   (verify-map-bottom.mjs と同じやり方)。
const page = (mode, k) => `<!doctype html><meta charset="utf-8">
<script src="https://cdn.tailwindcss.com"></script>
<style>
  html,body{margin:0}
  ${mode === 'zoom'
    ? `[data-fs="execution"]{ zoom:${k}; width:${100 / k}vw; height:${100 / k}vh; }`
    : `[data-fs="execution"]{ --spacing:${0.25 * k}rem; font-size:${k}em; }`}
</style>
<body>
<div data-fs="execution" class="fixed inset-0 bg-slate-100">
  <div id="band" class="h-[85vh] bg-white border">帯（画面の85%の高さ）</div>
  <div id="mini" class="fixed bottom-20 right-4 w-40 h-20 bg-rose-500 text-white">🎬小窓</div>
</div>`;

const measure = async (mode, k) => {
  await p.setContent(page(mode, k));
  await p.waitForTimeout(600);
  return p.evaluate(() => {
    const b = document.getElementById('band').getBoundingClientRect();
    const m = document.getElementById('mini').getBoundingClientRect();
    return {
      bandBottom: Math.round(b.bottom), bandH: Math.round(b.height),
      miniRight: Math.round(m.right), miniBottom: Math.round(m.bottom),
      vh: window.innerHeight, vw: window.innerWidth,
    };
  });
};

for (const mode of ['zoom', 'vars']) {
  console.log(`\n=== ${mode === 'zoom' ? 'いまの作り（zoom）' : '直したあと（テーマ変数）'} ===`);
  const base = await measure(mode, 1);
  for (const k of [1.3, 1.6]) {
    const r = await measure(mode, k);
    const over = r.bandBottom - r.vh;
    console.log(`   ${Math.round(k * 100)}%: 帯の下端=${r.bandBottom}px (画面${r.vh}px) ${over > 0 ? `→ ${over}px はみ出し` : '→ 収まっている'} / 小窓の右端=${r.miniRight}px 下端=${r.miniBottom}px`);
    if (mode === 'vars') {
      say(over <= 1, `⚠${Math.round(k * 100)}% で帯が画面からはみ出さない`, `はみ出し ${Math.max(0, over)}px`);
      say(Math.abs(r.miniRight - base.miniRight) <= 1, `⚠${Math.round(k * 100)}% で🎬小窓の位置が動かない`,
        `右端 ${base.miniRight}px → ${r.miniRight}px`);
    }
  }
}

await br.close();
console.log(`\n${problems.length ? `❌ ${problems.length}件だめでした:\n - ` + problems.join('\n - ') : '✅ ぜんぶ通りました'}`);
process.exit(problems.length ? 1 : 0);
