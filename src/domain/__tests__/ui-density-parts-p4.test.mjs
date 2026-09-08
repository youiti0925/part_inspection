// =============================================================================
// 🚨 2026-09-08 P4: 「指標の意味」の吹き出しが **画面の外へ出ない** 為の見張り。
// -----------------------------------------------------------------------------
// 何があったか(写しで実測。数は全部 1366x768 のノートPCの目盛り):
//   2026-09-08 P3 で「指標の意味」を 中身の一番下の **静かな details** から
//   帯2 の中の **吹き出し(absolute right-0)** へ移した。
//   ところが吹き出しの **土台(position の親)** が details 自身(幅118px)だったので、
//   画面が狭くなって帯2が折り返し、details が2行目の左端(左41px)へ落ちると
//   吹き出しの左端が **-325px** になった。
//       幅1366 → 左 391 / 右 874   画面の中
//       幅1100 → 左 391 / 右 874   画面の中
//       幅 940 → 左 391 / 右 874   画面の中
//       幅 911 → 左-325 / 右 158   🚨 画面の外
//       幅 900 → 左-325 / 右 158   🚨 画面の外
//       幅 800 → 左-325 / 右 158   🚨 画面の外
//       幅 781 → 左-169 / 右 314   🚨 画面の外
//   祖先(h-full flex flex-col bg-slate-50 overflow-hidden)が横スクロールを止めるので、
//   4つの指標の説明の **2/3 が どうやっても読めない**。
//   911px は 現場の 1366px のノートPCで ブラウザ拡大150%、781px は 175% にした時の幅。
//   移す前は 中身の一番下の静かな details だったので、画面の外へ出る事はあり得なかった。
//
// 直した形(同じ写しで実測。7通り全部 左は0以上・右は画面幅の内側):
//   ① 吹き出しの土台を details から **帯2(data-band="analysis-sub")** へ移した。
//      帯2 は 分析画面のヘッダー(px-6・flex flex-col)の直下なので、**画面いっぱいの幅**。
//      right-0 は「帯2の右端」= 画面の右端の内側に固定される。
//       幅1366 → 左842/右1325   幅1100 → 左576/右1059   幅940 → 左416/右899
//       幅 911 → 左387/右 870   幅 900 → 左376/右 859   幅800 → 左276/右759
//       幅 781 → 左257/右 740
//   ② 幅の上限を calc(100vw-3rem) から **max-w-full**(=土台の幅)へ変えた。
//      理由(実測): この画面は data-fs="tables" の中に在り、文字サイズの設定は zoom で効く。
//      zoom:1.15 の中では 高さ512pxの画面で 100vh が **589px** と出た(100% は 512px)。
//      つまり vw / vh は zoom で一緒に伸びるので「画面より広くしない上限」にならない。
//
// 🚨 この見張りが守る事(字で):
//   P4A 吹き出しの土台は 帯2。details は position を持たない。帯2の中で position を持つのは
//       「帯2 自身」と「吹き出し」の2つだけ(間に1枚はさんで土台を横取りさせない)
//   P4B 吹き出しは details の直下(summary の次)。間に別の入れ物を作らない
//   P4C 吹き出しは absolute right-0、幅の上限は max-w-full(vw / vh の上限を使わない)
//   P4D 帯2 は 分析画面のヘッダーの **直下**(= 画面いっぱいの幅)。ヘッダーは px-6 の flex flex-col
//   P4E 振る舞いの見張り scripts/verify-metrics-popup.mjs が在り、吹き出し2つ × 幅7通りを測り、
//       壊し方を6通り(2つ × 3通り)持つ
//
// ⚠ 字の見張りだけでは「本当に画面の中に居る」までは言えない。
//   本物のブラウザで幅を変えて座標を測る見張りは scripts/verify-metrics-popup.mjs。
//   走らせ方: node scripts/verify-metrics-popup.mjs [--selftest]
//   (門に入れていない理由は そのファイルの頭に書いてある。写し・Chrome・playwright-core が要る)
// ⚠ コメントは codeOf が落とすので、コメント化で緑にはできない。
// ⚠ P40 で **本物のコードの控え** をわざと壊し、赤になる事を毎回確かめる(ソースには1バイトも書かない)。
// =============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOf } from './_code.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const APP = path.join(ROOT, 'src', 'App.jsx');
const WATCHDOG = path.join(ROOT, 'scripts', 'verify-metrics-popup.mjs');

const app = codeOf(APP);
const watchdog = fs.existsSync(WATCHDOG) ? fs.readFileSync(WATCHDOG, 'utf8') : '';

// 範囲を先に切る(同名の物を拾わない為)。
const between = (code, from, to, why) => {
  const a = code.indexOf(from);
  assert.ok(a >= 0, `${why}: 目印 ${from} がソースに無い`);
  const b = code.indexOf(to, a + from.length);
  assert.ok(b > a, `${why}: 終わりの目印 ${to} が見つからない`);
  return code.slice(a, b);
};

const POS = /\b(?:relative|absolute|fixed|sticky)\b/;
const BAND2 = '<div data-band="analysis-sub"';
const HEADER = '<div data-band="analysis-header"';
const BAND1 = '<div data-band="analysis-top"';
const DETAILS = '<details data-fold="worker-eval-metrics"';
const AFTER_HEADER = '<div className="flex-1 overflow-y-auto p-6">';

// 開き札の className を取り出す。
const classOf = (code, openTag, why) => {
  const i = code.indexOf(openTag);
  assert.ok(i >= 0, `${why}: ${openTag} がソースに無い`);
  const j = code.indexOf('>', i);
  assert.ok(j > i, `${why}: ${openTag} の札が閉じていない`);
  const m = code.slice(i, j).match(/className="([^"]*)"/);
  assert.ok(m, `${why}: ${openTag} に className が無い`);
  return m[1];
};

// その行の字下げ(先頭の空白の数)。
const indentOf = (code, needle, why) => {
  const i = code.indexOf(needle);
  assert.ok(i >= 0, `${why}: ${needle} がソースに無い`);
  const bol = code.lastIndexOf('\n', i) + 1;
  return i - bol;
};

export const CHECKS = {
  // ── P4A 吹き出しの土台は 帯2。details は position を持たない ──
  P4A: ({ code }) => {
    const b2cls = classOf(code, BAND2, '帯2');
    assert.ok(/\brelative\b/.test(b2cls),
      '帯2(data-band="analysis-sub")に relative が無い。吹き出しの土台が帯2でなくなり、'
      + '帯が折り返すと吹き出しの左端が負(実測 -325px)になって画面の外へ出る');

    const detCls = classOf(code, DETAILS, '「指標の意味」');
    assert.ok(!POS.test(detCls),
      `「指標の意味」の details に position のクラスが戻っている(${detCls})。`
      + '土台が details(幅118px)になり、狭い画面で吹き出しが画面の外へ出る(実測 幅911/900/800px で 左-325px)');

    // 帯2 の中で position を持つのは「帯2 自身(relative)」と「吹き出し(absolute)」だけ。
    // 間に1枚 relative をはさむと 土台がそちらへ移る(横取り)ので、その時はここも見直す。
    // 🚨 2026-09-08 PC2: 2個 → 3個 へ。本番でだけ出る「右が空いた帯」2本
    //   (① データを正す 中身54% / ⑤ 基準を固める 中身51%・どちらも右が空)を埋める為に、
    //   中身の一番上に在った説明の箱を 帯2 の右へ移し、？ の吹き出し(data-fold="analysis-sub-howto")を1つ足した。
    //   ⚠ **緩めていない**: 数を「以上」にはしない。1つ目が relative(帯2 自身)・**残りは全部 absolute の吹き出し**
    //     (relative / fixed / sticky が1枚でも紛れ込んだら赤)で、どの吹き出しも right-0 top-full max-w-full で
    //     帯2 に釣られている事まで数える。増やす時は理由を書いてこの数を直す。
    const b2 = between(code, BAND2, AFTER_HEADER, '帯2');
    const positioned = [...b2.matchAll(/className="([^"]*)"/g)].map((m) => m[1]).filter((c) => POS.test(c));
    assert.equal(positioned.length, 3,
      `帯2 の中で position を持つ物が ${positioned.length} 個(3個のはず: 帯2 自身 と 吹き出し2つ)。`
      + `土台が横取りされていないか確かめてください → ${JSON.stringify(positioned.map((c) => c.slice(0, 40)))}`);
    assert.ok(/\brelative\b/.test(positioned[0]), '帯2 の中の1つ目の position が relative(帯2 自身)でない');
    for (const [n, cls] of positioned.slice(1).entries()) {
      assert.ok(/\babsolute\b/.test(cls) && !/\b(?:relative|fixed|sticky)\b/.test(cls),
        `帯2 の中の ${n + 2} 個目の position が absolute の吹き出しでない(${cls.slice(0, 60)})。土台が横取りされている`);
      assert.ok(/\bright-0\b/.test(cls) && /\btop-full\b/.test(cls),
        `帯2 の ${n + 2} 個目の吹き出しが right-0 top-full でない(${cls.slice(0, 60)})。帯の右端に揃わず画面の外へ出る`);
      assert.ok(/\bmax-w-full\b/.test(cls),
        `帯2 の ${n + 2} 個目の吹き出しの幅の上限が max-w-full でない(${cls.slice(0, 60)})`);
    }
  },

  // ── P4B 吹き出しは details の直下(summary の次) ──
  P4B: ({ code }) => {
    const det = between(code, DETAILS, '</details>', '「指標の意味」');
    const after = det.slice(det.indexOf('</summary>') + '</summary>'.length);
    const first = after.indexOf('<');
    assert.ok(first >= 0, '「指標の意味」の summary の後ろに吹き出しが無い');
    assert.ok(after.slice(first).startsWith('<div className="absolute'),
      '吹き出しが summary の直後に居ない(間に入れ物が1枚増えている)。'
      + `土台が変わっている恐れがある → ${after.slice(first, first + 60)}`);
  },

  // ── P4C 吹き出しは absolute right-0 / 上限は max-w-full ──
  P4C: ({ code }) => {
    const det = between(code, DETAILS, '</details>', '「指標の意味」');
    const cls = classOf(det, '<div className="absolute', '吹き出し');
    assert.ok(/\babsolute\b/.test(cls), '吹き出しが absolute でない(開くと帯が縦に伸びて中身を押し下げる)');
    assert.ok(/\bright-0\b/.test(cls), '吹き出しの right-0 が無い(帯2の右端に揃えて 出力・絞り込みの下へ出す形)');
    assert.ok(/\btop-full\b/.test(cls), '吹き出しの top-full が無い(帯2の下へ出す形)');
    assert.ok(/\bmax-w-full\b/.test(cls),
      '吹き出しの幅の上限が max-w-full でない。max-w-full は「土台=帯2の幅」なので、'
      + 'どの画面幅でも帯2の中に収まる');
    assert.ok(!/\b(?:max-)?w-\[calc\(100(?:vw|vh|dvh|dvw)/.test(cls),
      '吹き出しの幅に vw / vh の上限が戻っている。実測: zoom:1.15 の中では 高さ512pxの画面で '
      + '100vh が 589px と出た(100% は 512px)。文字サイズの設定は zoom で効くので vw / vh は上限にならない');
  },

  // ── P4D 帯2 は 分析画面のヘッダーの直下(= 画面いっぱいの幅) ──
  P4D: ({ code }) => {
    const hCls = classOf(code, HEADER, '分析画面のヘッダー');
    assert.ok(/\bflex\b/.test(hCls) && /\bflex-col\b/.test(hCls),
      `分析画面のヘッダーが flex flex-col でない(${hCls})。帯2 が画面いっぱいの幅でなくなる`);
    assert.ok(/\bpx-6\b/.test(hCls), `分析画面のヘッダーの左右の余白が px-6 でない(${hCls})`);
    // 帯1 と 帯2 は同じ字下げ = ヘッダーの直下の兄弟。ヘッダーはそれより浅い。
    const ih = indentOf(code, HEADER, '分析画面のヘッダー');
    const i1 = indentOf(code, BAND1, '帯1');
    const i2 = indentOf(code, BAND2, '帯2');
    assert.equal(i1, i2, `帯1(字下げ${i1})と帯2(字下げ${i2})の深さが違う。帯2 がヘッダーの直下でなくなっている`);
    assert.ok(ih < i2, `ヘッダー(字下げ${ih})より帯2(字下げ${i2})が浅い/同じ。入れ子が変わっている`);
    // 帯2 の直前の「中身のある行」は 帯1 の閉じ札(= 帯2 は帯1の中ではない)。
    // ⚠ codeOf は {/* … */} の中だけを落とすので `{` と `}` だけの行が残る。数に入れない。
    const before = code.slice(0, code.indexOf(BAND2)).split('\n')
      .filter((l) => l.trim() && !/^[{}]+$/.test(l.trim())).pop() || '';
    assert.equal(before.trim(), '</div>', `帯2 の直前の行が 帯1 の閉じ札でない(「${before.trim().slice(0, 40)}」)。帯2 が帯1 の中へ入っている`);
    assert.equal(before.length - before.trimStart().length, i1,
      '帯2 の直前の閉じ札の字下げが 帯1 と揃っていない(帯1 が閉じ切れていない)');
  },

  // ── P4E 振る舞いの見張り(本物のブラウザで幅を変えて座標を測る)を消させない ──
  P4E: ({ guard }) => {
    assert.ok(guard.length > 0,
      'scripts/verify-metrics-popup.mjs が無い。字の見張りだけでは「本当に画面の中に居る」は言えない');
    const widths = (guard.match(/const WIDTHS = \[([^\]]*)\]/) || [])[1];
    assert.ok(widths, '振る舞いの見張りに 測る幅の一覧(WIDTHS)が無い');
    const list = widths.split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
    assert.deepEqual(list, [1366, 1100, 940, 911, 900, 800, 781],
      `振る舞いの見張りが測る幅が変わっている: ${JSON.stringify(list)}(1366/1100/940/911/900/800/781 の7通り)`);
    // 同じ形の吹き出しは2つ。片方だけ測って安心しない(2026-09-08 実測: 作業最適化の ？ も
    // 幅940 / 700 / 600px で 左-319px だった)。
    for (const need of ['worker-eval-metrics', 'optimize-howto']) {
      assert.ok(guard.includes(need), `振る舞いの見張りが「${need}」の吹き出しを測っていない`);
    }
    const targets = [...guard.matchAll(/\n    name: '/g)].length;
    assert.equal(targets, 2, `振る舞いの見張りが測る吹き出しが ${targets} つ(2つのはず)`);
    // 壊し方(--selftest)は 1つの吹き出しにつき3通り以上
    const n = [...guard.matchAll(/\n      \['[①②③]/g)].length;
    assert.ok(n >= 6, `振る舞いの見張りの壊し方が ${n} 通り(2つ × 3通り = 6通り以上のはず)`);
    assert.ok(/offsetParent === band/.test(guard), '振る舞いの見張りが「土台が帯2か」を見ていない');
    assert.ok(/wideEnough/.test(guard), '振る舞いの見張りが「吹き出しが潰れていないか」を見ていない');
    assert.ok(/process\.exit\(1\)/.test(guard), '振る舞いの見張りが赤(exit 1)で終われない');
  },
};

const TITLES = {
  P4A: '吹き出しの土台は 帯2(details に position を戻さない・間に1枚はさんで横取りしない)',
  P4B: '吹き出しは details の直下(summary の次)',
  P4C: '吹き出しは absolute right-0 / 幅の上限は max-w-full(vw・vh の上限は zoom で伸びる)',
  P4D: '帯2 は 分析画面のヘッダーの直下(= 画面いっぱいの幅)',
  P4E: '振る舞いの見張り(吹き出し2つ × 幅7通りで座標を測る)が在り、壊し方を6通り持っている',
};

// ---------------------------------------------------------------------------
// P40 見張り自身の試験。**本物のコードの控え** をわざと壊して、赤になるか数える。
//   壊し方は3通り: ①行を消す(コメント化と同じ形) ②値を変える ③直す前の形へ戻す
//   🚨 ソースには1バイトも書かない。控え(文字列)の上だけで壊す。
// ---------------------------------------------------------------------------
const POPUP = '<div className="absolute right-0 top-full mt-1 z-30 w-[420px] max-w-full';

export const BREAKS_FOR_PROOF = [
  ['P4A', '③ details へ relative を戻す(2026-09-08 P3 の形。実測 幅911px で 左-325px)',
    (s) => ({ ...s, code: s.code.replace('<details data-fold="worker-eval-metrics" className="bg-slate-50',
      '<details data-fold="worker-eval-metrics" className="relative bg-slate-50') })],
  ['P4A', '① 帯2 から relative を消す',
    (s) => ({ ...s, code: s.code.replace('<div data-band="analysis-sub" className="relative flex',
      '<div data-band="analysis-sub" className="flex') })],
  ['P4A', '② 帯2 の中に relative の入れ物を1枚はさんで土台を横取りする',
    (s) => ({ ...s, code: s.code.replace('<details data-fold="worker-eval-metrics"',
      '<div className="relative"><details data-fold="worker-eval-metrics"') })],
  ['P4B', '② 吹き出しを summary の直後から1枚奥へ入れる',
    (s) => ({ ...s, code: s.code.replace(POPUP, '<div className="contents">' + POPUP) })],
  ['P4C', '③ 幅の上限を calc(100vw-3rem) へ戻す(zoom の中では画面より広くなる)',
    (s) => ({ ...s, code: s.code.replace('w-[420px] max-w-full', 'w-[420px] max-w-[calc(100vw-3rem)]') })],
  ['P4C', '① 吹き出しから absolute を消す',
    (s) => ({ ...s, code: s.code.replace(POPUP, '<div className="right-0 top-full mt-1 z-30 w-[420px] max-w-full') })],
  // ⚠ 「absolute right-0 top-full」は App.jsx に7か所ある(他の吹き出し)。
  //   この見張りの POPUP(w-[420px] max-w-full まで含む)で **この吹き出しだけ** を壊す。
  ['P4C', '② 吹き出しを left-0 にする',
    (s) => ({ ...s, code: s.code.replace(POPUP, POPUP.replace('right-0', 'left-0')) })],
  ['P4D', '② 分析画面のヘッダーの左右の余白 px-6 を消す',
    (s) => ({ ...s, code: s.code.replace('<div data-band="analysis-header" className="bg-white border-b px-6 py-2',
      '<div data-band="analysis-header" className="bg-white border-b py-2') })],
  ['P4D', '③ 帯2 を 帯1 の中へ入れる(直前の 帯1 の閉じ札を外す)', (s) => {
    const i = s.code.indexOf(BAND2);
    const j = s.code.lastIndexOf('          </div>', i);
    return { ...s, code: s.code.slice(0, j) + s.code.slice(j + '          </div>'.length) };
  }],
  ['P4D', '② 帯1 と 帯2 の字下げを変えて 兄弟でなくす', (s) => {
    const i = s.code.indexOf(BAND2);
    const bol = s.code.lastIndexOf('\n', i) + 1;
    return { ...s, code: s.code.slice(0, bol) + '  ' + s.code.slice(bol) };
  }],
  ['P4E', '① 振る舞いの見張りを消す', (s) => ({ ...s, guard: '' })],
  ['P4E', '② 振る舞いの見張りが測る幅を1つ減らす(狭い方から)',
    (s) => ({ ...s, guard: s.guard.replace('[1366, 1100, 940, 911, 900, 800, 781]', '[1366, 1100, 940, 911, 900, 800]') })],
  ['P4E', '① 作業最適化の ？ の吹き出しを測る所を消す(片方だけ測って安心する形)',
    (s) => ({ ...s, guard: s.guard.split('optimize-howto').join('optimize-XXXX') })],
  ['P4E', '① 振る舞いの見張りから「土台が帯2か」の目を外す',
    (s) => ({ ...s, guard: s.guard.replace('offsetParent === band', 'offsetParent !== null') })],
];

const REAL = { code: app, guard: watchdog };

test('P40 🚨 見張り自身の試験: 本物のコードをわざと壊すと、その場で赤になる', () => {
  for (const [id, why, mutate] of BREAKS_FOR_PROOF) {
    const broken = mutate(REAL);
    assert.ok(broken.code !== REAL.code || broken.guard !== REAL.guard,
      `見本を壊せていない(壊し方が古い): ${id} ${why}`);
    CHECKS[id](REAL);                                  // 壊す前は緑
    assert.throws(() => CHECKS[id](broken), `${id} は「${why}」を入れても緑のまま = 何も見ていない`);
  }
  assert.equal(BREAKS_FOR_PROOF.length, 14, '壊し方の数が変わっている(減らさない)');
});

for (const [id, fn] of Object.entries(CHECKS)) test(`${id} ${TITLES[id]}`, () => fn(REAL));
