#!/usr/bin/env node
// =============================================================================
// 📏 見張り(振る舞い): 「指標の意味」の吹き出しが **どの画面幅でも画面の中に居る** か
//    本物のブラウザで 幅を変えながら 座標を測って数える。
// -----------------------------------------------------------------------------
// 🚨 なぜ要るか(2026-09-08 実測):
//   2026-09-08 P3 で「指標の意味」を 中身の一番下の **静かな details** から
//   帯2 の中の **吹き出し(absolute)** へ移した。移した先の土台(position の親)が
//   details 自身(幅118px)だったので、画面が狭くなって帯が折り返し、
//   details が2行目の左端(左41px)へ落ちると right-0 の吹き出しの左端が
//   **-325px**(画面の外)になった。祖先(h-full flex flex-col bg-slate-50 overflow-hidden)が
//   横スクロールを止めるので、4つの指標の説明の 2/3 が **どうやっても読めない**。
//   写しの実測(直す前):
//       幅1366 → 左 391 / 右 874  画面の中
//       幅1100 → 左 391 / 右 874  画面の中
//       幅 940 → 左 391 / 右 874  画面の中
//       幅 911 → 左-325 / 右 158  🚨 画面の外
//       幅 900 → 左-325 / 右 158  🚨 画面の外
//       幅 800 → 左-325 / 右 158  🚨 画面の外
//       幅 781 → 左-169 / 右 314  🚨 画面の外
//   911px は 現場の 1366px のノートPC で ブラウザ拡大150%、781px は 175% にした時の幅。
//   つまり **現場の実機で起きる**。
//   直した形: 土台を details から 帯2(data-band="analysis-sub"・画面いっぱいの幅)へ移した。
//   写しの実測(直した後): 7通り全部 左は0以上・右は画面幅の内側(下で毎回数える)。
//
// 🚨 字だけの見張りと違い、これは **本物の画面の座標** を見る。
//   ・--selftest は 走っている画面の上で わざと古い形(土台を details へ戻す /
//     right-0 を left-0 にする)へ **CSS で** 戻し、この見張りが赤にするかを確かめる。
//     ソースには1バイトも書かない。
//
// ⚠ この段は `npm run check` の門には **入れていない**。理由を隠さず書く:
//   ①走っている写し(既定 http://localhost:5630/)②Chrome ③playwright-core が要る。
//   門に入れると、写しが止まっているだけで門が赤になり「門を外す」動機になる。
//   代わりに **字の見張り** src/domain/__tests__/ui-density-parts-p4.test.mjs を門へ入れてある
//   (土台が 帯2 である事・right-0/max-w-full である事を毎回数える)。
//   この振る舞いの見張りは **画面を触った時に手で走らせる**:
//       node scripts/verify-metrics-popup.mjs                 … 7通りの幅で測る
//       node scripts/verify-metrics-popup.mjs --selftest      … わざと壊して赤になるか確かめる
//
// 🚨 読むだけ。保存・登録・削除・確定・出力・取込 は1つも押さない。
//    firestore への書き込みを数えて 0 でなければ赤にする。
// =============================================================================
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// 現場のノートPC 1366px を ブラウザ拡大した時の幅も混ぜてある。
//   1366=100% / 1100 / 940 / 911=150% / 900 / 800 / 781=175%
const WIDTHS = [1366, 1100, 940, 911, 900, 800, 781];
const URL = process.env.PARTS_COPY_URL || process.argv.find((a) => /^https?:\/\//.test(a)) || 'http://localhost:5630/';
const SELFTEST = process.argv.includes('--selftest');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

// playwright-core は この repo の持ち物ではない。在る所を順に探し、無ければ **赤** にする
// (「見つからないので緑」は 2026-08-23 の「作り物を食って緑」と同じ穴)。
const CANDIDATES = [
  path.join(ROOT, 'node_modules'),
  'C:/Users/anrw3/inspection-audit-local/node_modules',
];
let chromium = null;
for (const dir of CANDIDATES) {
  if (!fs.existsSync(path.join(dir, 'playwright-core'))) continue;
  try {
    const req = createRequire(path.join(dir, '_resolve.cjs'));
    ({ chromium } = req('playwright-core'));
    break;
  } catch { /* 次を探す */ }
}
if (!chromium) {
  console.error('🚨 playwright-core が見つかりません。探した所:\n  ' + CANDIDATES.join('\n  '));
  console.error('   → 測れないので **緑にはしません**。');
  process.exit(1);
}
if (!fs.existsSync(CHROME)) {
  console.error(`🚨 Chrome が見つかりません: ${CHROME}(CHROME_PATH で場所を渡せます)`);
  process.exit(1);
}

const b = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await b.newContext({ viewport: { width: 1366, height: 768 } });
const p = await ctx.newPage();

const writes = [];
p.on('request', (r) => {
  const m = r.method(); const u = r.url();
  if (/firestore/.test(u) && /POST|PATCH|PUT|DELETE/.test(m) && !/Listen|channel/.test(u)) writes.push(m + ' ' + u.slice(0, 90));
});

const click = async (label, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    const ok = await p.evaluate((want) => {
      const vis = Array.from(document.querySelectorAll('button,[role=tab],a'))
        .filter((y) => y.getClientRects().length > 0 && !y.disabled);
      const x = vis.find((y) => (y.textContent || '').trim() === want)
        || vis.find((y) => (y.textContent || '').trim().replace(/[0-9]+$/, '') === want);
      if (!x) return false;
      x.scrollIntoView({ block: 'center' });
      x.click();
      return true;
    }, label);
    if (ok) return true;
    if (Date.now() - t0 > ms) return false;
    await p.waitForTimeout(250);
  }
};

const die = async (msg) => { console.error('🚨 ' + msg); await b.close(); process.exit(1); };


// -----------------------------------------------------------------------------
// 測る相手。**同じ形の吹き出しは2つある**。片方だけ直して片方を放置しない為、両方測る。
//   ⚠ 2026-09-08 の実測で、作業最適化の ？ の吹き出しも 幅940 / 700 / 600px で 左-319px だった。
// -----------------------------------------------------------------------------
const TARGETS = [
  {
    name: '分析 > 人・配分「指標の意味」',
    tabs: ['分析', '人・配分', '作業者評価'],
    popup: '[data-fold="worker-eval-metrics"] > div',
    details: 'details[data-fold="worker-eval-metrics"]',
    band: '[data-band="analysis-sub"]',
    designW: 420,
    // 🚨 壊し方は「2026-09-08 P3 の形へ本当に戻す」事。実測で確かめた事:
    //   ・土台を details へ戻す **だけ** では左は負にならない(上限 max-w-full が details の幅になり、
    //     吹き出しが 483px → 116px に潰れる)。潰れて読めないのも壊れなので、幅も一緒に見る。
    //   ・P3 の形 = 土台が details **かつ** 上限が calc(100vw-3rem)。これで左が -325px になる。
    //   ・right-0 を left-0 にするのは、土台が帯なら **壊れない**(41→524px で画面の中)ので
    //     壊し方には入れない(嘘の壊し方を並べると、見張りが何を見ているか分からなくなる)。
    breaks: [
      ['③ P3 の形へ丸ごと戻す(土台=details・上限=calc(100vw-3rem))',
        'details[data-fold="worker-eval-metrics"]{position:relative}'
        + 'details[data-fold="worker-eval-metrics"]>div{max-width:calc(100vw - 3rem)!important}'],
      ['③ 土台だけ details へ戻す(吹き出しが潰れて読めなくなる)',
        'details[data-fold="worker-eval-metrics"]{position:relative}'],
      ['② 幅の上限を外して 画面より広くする',
        'details[data-fold="worker-eval-metrics"]>div{max-width:none!important;width:2000px!important}'],
    ],
  },
  {
    name: '作業最適化「？」',
    tabs: ['分析', '作業最適化'],
    popup: '[data-fold="optimize-howto"]',
    details: 'details:has(> [data-fold="optimize-howto"])',
    band: '[data-band="optimize-top"]',
    designW: 380,
    breaks: [
      ['③ 直す前の形へ戻す(土台=？ の details)',
        'details:has(>[data-fold="optimize-howto"]){position:relative}'],
      ['② 幅の上限を外して 画面より広くする',
        '[data-fold="optimize-howto"]{max-width:none!important;width:2000px!important}'],
      ['③ right-0 を外して左端から出す(土台が細い時に画面の外へ出る形)',
        'details:has(>[data-fold="optimize-howto"]){position:relative}'
        + '[data-fold="optimize-howto"]{max-width:calc(100vw - 3rem)!important}'],
    ],
  },
];

// 測る道具。details は押さずに open を立てるだけ(何も保存しない)。
const measure = (t) => p.evaluate((cfg) => {
  const d = document.querySelector(cfg.details);
  if (!d) return { err: `「${cfg.name}」の details(${cfg.details})が画面に無い` };
  d.open = true;
  const pop = document.querySelector(cfg.popup);
  if (!pop) return { err: `「${cfg.name}」の吹き出し(${cfg.popup})が無い` };
  const band = document.querySelector(cfg.band);
  if (!band) return { err: `「${cfg.name}」の土台の帯(${cfg.band})が無い` };
  const r = pop.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  // 中の文が1行でも画面の外に出ていないか(=読めるか)まで見る
  let tl = Infinity; let tr = -Infinity;
  for (const x of pop.querySelectorAll('div,span,b')) {
    if ((x.textContent || '').trim().length < 8) continue;
    const q = x.getBoundingClientRect();
    if (q.width < 2) continue;
    tl = Math.min(tl, q.left); tr = Math.max(tr, q.right);
  }
  if (!Number.isFinite(tl)) { tl = r.left; tr = r.right; }
  // 横へ逃げられるか(祖先が overflow:hidden なら はみ出した分は永久に読めない)
  let clipped = false;
  for (let e = pop.parentElement; e; e = e.parentElement) {
    const ox = getComputedStyle(e).overflowX;
    if (ox === 'hidden' || ox === 'clip') { clipped = true; break; }
  }
  // 🚨 「画面の中に居る」だけでは足りない。土台を details へ戻すと、上限 max-w-full が
  //   **details の幅(116px / 24px)** になって吹き出しが潰れ、画面の中に居るのに読めなくなる(実測)。
  //   だから「あるべき幅」も一緒に測る。あるべき幅 = min(元の幅 × いまの文字倍率, 土台の帯の幅)。
  //   文字倍率は 設定(データ・リストの文字サイズ)が zoom で効くので、祖先の zoom を掛け合わせて出す。
  let zoom = 1;
  for (let e = pop; e; e = e.parentElement) {
    const z = parseFloat(getComputedStyle(e).zoom);
    if (z && z !== 1) zoom *= z;
  }
  const bandW = band.getBoundingClientRect().width;
  const wantW = Math.min(cfg.designW * zoom, bandW);
  return {
    vw,
    L: Math.round(r.left), R: Math.round(r.right), W: Math.round(r.width),
    textL: Math.round(tl), textR: Math.round(tr),
    zoom: Math.round(zoom * 100) / 100,
    wantW: Math.round(wantW),
    wideEnough: r.width >= wantW - 2,
    anchorIsBand: pop.offsetParent === band,
    anchor: (pop.offsetParent && (pop.offsetParent.dataset.band || pop.offsetParent.tagName)) || '(無し)',
    bandL: Math.round(band.getBoundingClientRect().left),
    bandR: Math.round(band.getBoundingClientRect().right),
    clipped,
    canScrollX: document.scrollingElement.scrollWidth > vw,
  };
}, { name: t.name, details: t.details, popup: t.popup, band: t.band, designW: t.designW });

const run = async (t, title) => {
  console.log(`\n──── ${title} ────`);
  const rows = [];
  for (const w of WIDTHS) {
    await p.setViewportSize({ width: w, height: 768 });
    await p.waitForTimeout(600);
    const m = await measure(t);
    if (m.err) await die(m.err);
    const inScreen = m.L >= 0 && m.R <= m.vw && m.textL >= 0 && m.textR <= m.vw;
    const ok = inScreen && m.wideEnough && m.anchorIsBand;
    rows.push({ w, ...m, inScreen, ok });
    console.log(`  ${ok ? '✅' : '🚨'} 幅${String(w).padStart(4)}px  吹き出し 左${String(m.L).padStart(5)} 右${String(m.R).padStart(5)}(幅${m.W}/あるべき${m.wantW})`
      + `  文 左${String(m.textL).padStart(5)} 右${String(m.textR).padStart(5)}`
      + `  帯 左${m.bandL} 右${m.bandR}  土台=${m.anchor}  文字倍率=${m.zoom}  横スクロール可=${m.canScrollX}`);
  }
  return rows;
};

console.log(`写し: ${URL}`);
await p.goto(URL, { waitUntil: 'domcontentloaded' }).catch(async () => die(`写しが開けません: ${URL}(npm run dev は走っていますか)`));
await p.waitForTimeout(14000);
await p.selectOption('select.border-red-400', { label: '管理者' }).catch(() => {});
await p.waitForTimeout(3000);

let bad = 0;
for (const t of TARGETS) {
  await p.setViewportSize({ width: 1366, height: 768 });
  for (const tab of t.tabs) {
    if (!await click(tab)) await die(`「${tab}」の札が画面に見つかりません(画面が変わっています。測らずに終わります)`);
  }
  await p.waitForTimeout(1500);

  const rows = await run(t, `${t.name} — 直した形(いまのコード)`);
  const ng = rows.filter((r) => !r.inScreen);
  const narrow = rows.filter((r) => !r.wideEnough);
  const noAnchor = rows.filter((r) => !r.anchorIsBand);
  if (ng.length) {
    bad += 1;
    console.log(`\n🚨 ${t.name}: 画面の外へ出た幅 ${ng.length} 通り: ` + ng.map((r) => `${r.w}px(左${r.L} 右${r.R})`).join(' / '));
    console.log(`   → 吹き出しの土台(position の親)を ${t.band} に戻してください。`);
  }
  if (narrow.length) {
    bad += 1;
    console.log(`\n🚨 ${t.name}: 吹き出しが潰れて読めない幅 ${narrow.length} 通り: ` + narrow.map((r) => `${r.w}px(幅${r.W}/あるべき${r.wantW})`).join(' / '));
    console.log('   → 上限 max-w-full は「土台の幅」です。土台が細い物(details 自身)になっていないか見てください。');
  }
  if (noAnchor.length) {
    bad += 1;
    console.log(`\n🚨 ${t.name}: 吹き出しの土台が帯ではない幅 ${noAnchor.length} 通り: ` + noAnchor.map((r) => `${r.w}px→${r.anchor}`).join(' / '));
  }
  if (!ng.length && !narrow.length && !noAnchor.length) console.log(`  → ${t.name}: ${WIDTHS.length} 通り全部 画面の中・潰れていない・土台は帯`);

  // ── 見張り自身の試験。走っている画面の上で わざと古い形へ戻し、赤にできるか数える ──
  if (SELFTEST) {
    const BREAKS = t.breaks;
    if (BREAKS.length < 3) { bad += 1; console.log(`🚨 ${t.name}: 壊し方が減っています(3通り未満)`); }
    let caught = 0;
    for (const [why, css] of BREAKS) {
      const tag = await p.addStyleTag({ content: css });
      const got = await run(t, `${t.name} — わざと壊す: ${why}`);
      await p.evaluate((el) => el.remove(), tag);
      const out = got.filter((r) => !r.ok);
      if (out.length) { caught += 1; console.log(`  ✅ 赤にできた(${out.length} 通りで 画面の外 か 潰れている)`); }
      else console.log('  🚨 壊したのに全部の幅で緑のまま = この見張りは何も見ていない');
    }
    if (caught !== BREAKS.length) { bad += 1; console.log(`\n🚨 ${t.name} 見張り自身の試験: ${caught}/${BREAKS.length} しか赤にできませんでした`); }
    else console.log(`\n✅ ${t.name} 見張り自身の試験: ${caught}/${BREAKS.length} 全部その場で赤になりました`);
  }
}

console.log('\n=== まとめ ===');
console.log(`測った吹き出し ${TARGETS.length} つ × 幅 ${WIDTHS.length} 通り`);
console.log('🚨 本番への書き込み', writes.length, writes.slice(0, 3).join(' | '));
if (writes.length) bad += 1;
await b.close();
if (bad) { console.log('\n❌ 赤'); process.exit(1); }
console.log('\n✅ 緑: どちらの吹き出しも どの幅でも 左は0以上・右は画面幅の内側・潰れていない');
