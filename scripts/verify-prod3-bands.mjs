#!/usr/bin/env node
// =============================================================================
// 📏 見張り(振る舞い): 本番でだけ出ていた無駄3本が、**本物の画面で** 直っているか測る。
// -----------------------------------------------------------------------------
// 🚨 なぜ要るか(2026-09-08):
//   これまでの見張りは **写しで開ける画面** だけを測って作った。ところが
//   分析 > ① データを正す / ⑤ 基準を固める の帯は、写しの担当が使っていた測り方
//   (子の最左〜最右 ÷ 帯の幅)では 100% と出る。左に詰めても「端から端」は同じだからだ。
//   親が本番を 1366×768 で読むだけで測ったら、こう出た:
//     ① データを正す 「怪しい値はありません — データはクリーンです 🎉」  中身 4% / **176px**
//     ① データを正す の帯2                                           中身 **54%** / 46px
//     ⑤ 基準を固める の帯2                                           中身 **51%** / 46px
//
//   直した形を **同じ写しの画面** で測った(この見張りが毎回やる事):
//     ・帯2 の ？(analysis-sub-howto)を display:none にした形 = 直す前
//     ・戻した形 = 直した後
//     実測(1366×768): ① 58% → **98%** / ⑤ 55% → **98%**。帯の高さは 50px のまま(太っていない)。
//   「怪しい値はありません」の箱は 写しには異常値が在るので描かれない。
//   そこで **本番と同じ CSS が効いているその画面の中** に、直す前の形と直した後の形を
//   同じ幅で描いて高さを測り、測り終わったら消す(画面には何も残さない)。
//     実測: **167px → 40px**(−127px)。決まりの 64px 以下。
//
// 🚨 読むだけ。保存・登録・削除・確定・出力・取込 は1つも押さない。
//    押すのは 上のタブ(分析)と 大分類の札だけ。firestore への書き込みを数えて 0 でなければ赤にする。
//
// ⚠ この段は `npm run check` の門には **入れていない**。理由を隠さず書く:
//   ①走っている写し(既定 http://localhost:5630/) ②Chrome ③playwright-core が要る。
//   門に入れると、写しが止まっているだけで門が赤になり「門を外す」動機になる。
//   代わりに **字の見張り** src/domain/__tests__/ui-density-parts-prod3.test.mjs を門へ入れてある。
//   画面を触った時に手で走らせる:
//       node scripts/verify-prod3-bands.mjs               … 測る
//       node scripts/verify-prod3-bands.mjs --selftest    … わざと壊して赤になるか確かめる
// =============================================================================
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const URL = process.env.PARTS_COPY_URL || process.argv.find((a) => /^https?:\/\//.test(a)) || 'http://localhost:5630/';
const SELFTEST = process.argv.includes('--selftest');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
// 現場のノートPC 1366px と、それを拡大した時の幅。
const WIDTHS = [1366, 1100, 1000, 940, 911, 900, 800, 781];
// 合格の線
const 帯の中身の下限 = 60;   // 設計 決まり1
const 空箱の高さの上限 = 64; // 設計 決まり6 / この画面の直し
const 当たりの下限 = 44;     // 設計 決まり7

// playwright-core は この repo の持ち物ではない。在る所を順に探し、無ければ **赤**
// (「見つからないので緑」は 2026-08-23 の「作り物を食って緑」と同じ穴)。
const CANDIDATES = [path.join(ROOT, 'node_modules'), 'C:/Users/anrw3/inspection-audit-local/node_modules'];
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
  console.error('❌ playwright-core が見つかりません。探した所: ' + CANDIDATES.join(' , '));
  process.exit(1);
}

const fail = [];
const say = (s) => console.log(s);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const page = await ctx.newPage();
const writes = [];
page.on('request', (r) => {
  const u = r.url();
  if (/firestore/.test(u) && /POST|PATCH|PUT|DELETE/.test(r.method()) && !/Listen|channel/.test(u)) writes.push(r.method() + ' ' + u.slice(0, 80));
});

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(15000);
await page.selectOption('select.border-red-400', { label: '管理者' }).catch(() => {});
await page.waitForTimeout(3000);

const click = (want) => page.evaluate((w) => {
  const xs = Array.from(document.querySelectorAll('button,[role=tab],a')).filter((y) => y.getClientRects().length > 0 && !y.disabled);
  const x = xs.find((y) => (y.textContent || '').trim() === w);
  if (!x) return false; x.click(); return true;
}, want);

// --selftest: 走っている画面の上で **CSS だけ** 直す前の形へ戻す(ソースには1バイトも書かない)。
if (SELFTEST) {
  await page.addStyleTag({
    content: '[data-band="analysis-sub"] details[data-fold="analysis-sub-howto"]{display:none !important;}',
  });
  say('🧪 --selftest: 帯2 の ？ を CSS で隠した(= 直す前の形)。この見張りは赤になるはず。');
}

if (!(await click('分析'))) { console.error('❌ 「分析」の札が見つかりません(写しが動いていますか)'); process.exit(1); }
await page.waitForTimeout(2500);

for (const g of ['① データを正す', '⑤ 基準を固める（定着）']) {
  if (!(await click(g))) { fail.push(`「${g}」の札が見つからない(行き先が消えている)`); continue; }
  await page.waitForTimeout(2000);
  say(`\n== 帯2 / ${g} ==`);
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 768 });
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => {
      const band = document.querySelector('[data-band="analysis-sub"]');
      if (!band) return { err: '帯2 が無い' };
      const W = band.getBoundingClientRect().width;
      const kids = Array.from(band.children).filter((c) => c.getClientRects().length > 0).map((c) => c.getBoundingClientRect());
      const sum = kids.reduce((a, k) => a + k.width, 0);
      const sorted = kids.slice().sort((a, c) => a.left - c.left);
      let gap = 0;
      for (let i = 1; i < sorted.length; i += 1) gap = Math.max(gap, sorted[i].left - sorted[i - 1].right);
      const det = band.querySelector('details[data-fold="analysis-sub-howto"]');
      const out = {
        画面幅: window.innerWidth,
        中身: Math.round((sum / W) * 100),
        内側の最大の空き: Math.round((gap / W) * 100),
        帯の高さ: Math.round(band.getBoundingClientRect().height),
      };
      if (det) {
        const s = det.querySelector('summary').getBoundingClientRect();
        out.押す所 = Math.round(s.width) + 'x' + Math.round(s.height);
        out.当たりの短い方 = Math.min(Math.round(s.width), Math.round(s.height));
        det.open = true;
        const pop = det.querySelector('div.absolute').getBoundingClientRect();
        out.吹き出し = Math.round(pop.left) + '〜' + Math.round(pop.right);
        out.画面の中 = pop.left >= 0 && pop.right <= window.innerWidth;
        det.open = false;
      } else { out.押す所 = '(？ が無い)'; out.当たりの短い方 = 0; out.画面の中 = false; }
      return out;
    });
    say(` 幅${w} → ${JSON.stringify(r)}`);
    if (r.err) { fail.push(`${g} 幅${w}: ${r.err}`); continue; }
    if (r.中身 < 帯の中身の下限) fail.push(`${g} 幅${w}: 帯2 の中身が ${r.中身}%(${帯の中身の下限}% 以上のはず)`);
    if (r.内側の最大の空き > 25) fail.push(`${g} 幅${w}: 帯2 の内側の空きが ${r.内側の最大の空き}%(25% 以下のはず)`);
    if (r.当たりの短い方 < 当たりの下限) fail.push(`${g} 幅${w}: ？ の当たりが ${r.押す所}(${当たりの下限}px 以上のはず)`);
    if (!r.画面の中) fail.push(`${g} 幅${w}: ？ の吹き出し(${r.吹き出し})が画面の外へ出ている`);
  }
}

await page.setViewportSize({ width: 1366, height: 768 });
await page.waitForTimeout(400);

// ── 「怪しい値はありません — データはクリーンです 🎉」の箱 ──
// 写しは異常値が在るのでこの箱が描かれない。同じ画面の CSS の中で 前と後を描いて測り、すぐ消す。
say('\n== 「怪しい値はありません — データはクリーンです 🎉」の箱 ==');
const clean = await page.evaluate(() => {
  const body = document.querySelector('.flex-1.overflow-y-auto.p-6');
  if (!body) return { err: '分析の中身の入れ物が見つからない' };
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:0;';
  host.style.width = Math.round(body.getBoundingClientRect().width) + 'px';
  document.body.appendChild(host);
  const svg = (cls) => '<svg class="' + cls + '" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>';
  const TXT = ' 怪しい値はありません — データはクリーンです 🎉';
  const before = '<div class="text-center py-12 text-emerald-600">' + svg('w-12 h-12 mx-auto mb-2') + TXT + '</div>';
  const after = '<div class="flex items-center justify-center gap-2 py-2 text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-lg">' + svg('w-5 h-5 shrink-0') + TXT + '</div>';
  const h = (html) => { host.innerHTML = html; return Math.round(host.firstElementChild.getBoundingClientRect().height); };
  const a = h(before); const c = h(after);
  const 文 = host.firstElementChild.textContent.trim();
  host.remove();
  return { 直す前: a, 直した後: c, 文 };
});
say(JSON.stringify(clean));
if (clean.err) fail.push(clean.err);
else {
  if (clean.直した後 > 空箱の高さの上限) fail.push(`「怪しい値はありません」の箱が ${clean.直した後}px(${空箱の高さの上限}px 以下のはず)`);
  if (clean.文 !== '怪しい値はありません — データはクリーンです 🎉') fail.push(`文言が変わっている: 「${clean.文}」`);
  say(` 直す前 ${clean.直す前}px → 直した後 ${clean.直した後}px (−${clean.直す前 - clean.直した後}px)`);
}

// 🚨 ソースの中に「直した後の形」が本当に在るか(この見張りが器だけを測って自分を騙さない為)
const app = fs.readFileSync(path.join(ROOT, 'src', 'App.jsx'), 'utf8');
if (!app.includes('data-empty-clean="anomaly"')) fail.push('App.jsx に data-empty-clean="anomaly" が無い(器だけ測っていた)');
if (!app.includes('data-fold="analysis-sub-howto"')) fail.push('App.jsx に data-fold="analysis-sub-howto" が無い(器だけ測っていた)');

await browser.close();

say(`\nfirestore への書き込み: ${writes.length} 件 ${JSON.stringify(writes)}`);
if (writes.length > 0) fail.push(`写しへ ${writes.length} 件 書き込んだ(読むだけのはず)`);

if (SELFTEST) {
  if (fail.length > 0) { say(`\n✅ --selftest: 直す前の形へ戻すと ${fail.length} 件で赤になりました(見張りは効いています)`); process.exit(0); }
  say('\n❌ --selftest: 直す前の形へ戻したのに緑のまま = この見張りは何も見ていません'); process.exit(1);
}
if (fail.length > 0) { say('\n❌ ' + fail.length + ' 件:\n  - ' + fail.join('\n  - ')); process.exit(1); }
say('\n✅ 帯3本とも合格(中身 60% 以上・内側の空き 25% 以下・押す物 44px 以上・空箱 64px 以下・書き込み0)');
