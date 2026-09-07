// 🧹 部品検査「帯は1本に合体したのに、中が スカスカ／押せない／画面の外」を、また作らない為の見張り(2026-09-08)。
//
// 何があったか(直した後の形を、独立した確かめ役3人が本番と同じ dist の CSS を当てて 1366×768 で測り直した):
//   ① 帯2(analysis-sub)が ml-auto で 月単位/期間指定 を右端へ飛ばしていた。
//      小分類が1〜2個の大分類では 左の見出しと右の絞り込みの間が空(実測):
//        ① データを正す 598px(47%) / ⑤ 基準を固める 637px(50%) / 人・配分 703px(55%) / 記録・出力 568px(44%)
//      設計 決まり1 の⚠「右端に1個・左端に1個・真ん中は空 も無駄(内側の空きが幅の25%を超えたら直す)」。
//      ⚠ 直す前に担当が出した「analysis-sub 100%」は「子の最左〜最右 ÷ 帯の幅」で測った数で、
//        ml-auto で右へ飛ばすと真ん中が空でも必ず 100% になる。**この測り方ではこの穴は出ない**。
//   ② 月次レポートの monthly-export も ml-auto。max-w-screen-xl(1280px)で必ず2行目へ折り返し、
//      その行の左に 659px(53%)の空きが残っていた。
//   ③ 作業最適化の ？(説明文を畳んだ札)の当たりが 34px しか無かった(決まり7 は 44px)。
//   ④ その ？ の吹き出し(w-[380px] を left-0 で出す)が 1366px で画面の右へ 30px はみ出し、
//      祖先が overflow-hidden なので「将来は空き人材」の「き人」の2文字がどこからも読めなかった。
//   ⑤ 親タブ(分析 | 作業最適化)を分析画面へ合流させた事で、
//      ・作業最適化では max-w-[1100px] の中に入って 1366px では左から 133px 内側 →
//        分析(左40px)との間で 押すたびに約93px 横に跳ぶ
//      ・分析では data-fs="tables"(テーブル・リストの文字サイズ 70〜160%)の中に入り、
//        70% にすると 14px → 9.8px。決まり7(文字 12px 以上)を割る。合流の前は区画の外で いつも 100% だった。
//
// 🚨 この見張りが守る事:
//   UG1 合体した帯の中で、右端へ飛ばして真ん中を空ける書き方(ml-auto)を使っていない
//   UG2 新しく足した ？ の当たりが **44px 以上**(字面ではなく数で出す)
//   UG3 作業最適化の帯が max-w の中に入っていない・左端が分析画面と同じ(px-6)
//   UG4 ？ の吹き出しが右端から出て、画面より広くならない
//   UG5 分析画面へ合流させた親タブが、区画の文字サイズで伸び縮みしない(打ち消しの規則が在る)
// ⚠ コメントは codeOf が落とすので、コメント化で緑にはできない。
// ⚠ UG0 で **本物の App.jsx の控え** をわざと壊し、赤になる事を毎回走らせて確かめる(ソースには1バイトも書かない)。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOf } from './_code.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const app = codeOf(path.resolve(HERE, '..', '..', 'App.jsx'));

// 目印の <div …> から、その中身(次の目印か終わりまで)を切り出す。範囲を先に切らないと同名の物を拾う。
const from = (code, marker, len, why) => {
  const at = code.indexOf(marker);
  assert.ok(at > 0, `${why}: 目印 ${marker} がソースに無い`);
  return code.slice(at, at + len);
};

// 札の当たり判定(px)を **数で** 出す。
//   box-sizing:border-box なので 札の大きさ − わく×2 = 内側(padding box)。
//   ::after は border box ではなく **padding box** に対して置かれるので、当たり = 内側 + 前 + 後。
const hitBox = (summary, why) => {
  const box = Number((summary.match(/\bw-(\d+) h-\1\b/) || [])[1]);
  assert.ok(Number.isFinite(box), `${why}: ？ の札の大きさ(w-N h-N)が読めない`);
  const px = box * 4;
  const border = /\bborder(?![-\w])/.test(summary) ? 1 : 0;
  assert.equal(border, 1, `${why}: ？ に 1px のわくが無い(内側の大きさが読めない)`);
  const inner = px - border * 2;
  const grow = (side) => {
    const m = summary.match(new RegExp(`after:${side}-\\[(-?\\d+)px\\]`));
    assert.ok(m, `${why}: ？ の当たり判定 after:${side}-[…px] が無い`);
    const v = -Number(m[1]);
    assert.ok(v > 0, `${why}: ？ の当たり判定 after:${side} が外へ広がっていない(${m[1]}px)`);
    return v;
  };
  return { w: inner + grow('left') + grow('right'), h: inner + grow('top') + grow('bottom') };
};

export const CHECKS = {
  // ── UG1 合体した帯の中で「右端へ飛ばして真ん中を空ける」書き方を使わない ──
  UG1: (code) => {
    // 帯2(見出し + 小分類 + 月単位/期間指定)
    const sub = from(code, '<div data-band="analysis-sub"', 4000, '分析画面の帯2');
    const filt = sub.slice(sub.indexOf('{renderDefectFilterUI()}') - 300, sub.indexOf('{renderDefectFilterUI()}'));
    assert.ok(!filt.includes('ml-auto'),
      '帯2の 月単位/期間指定 が ml-auto で右端へ飛んでいる(小分類が1〜2個の大分類で 内側が 44〜55% 空く)');
    // 月次レポートの 出力:
    const exp = from(code, '<div data-band="monthly-export"', 200, '月次レポートの出力');
    const cls = (exp.match(/className="([^"]*)"/) || [])[1] || '';
    assert.ok(!cls.includes('ml-auto'),
      '出力の一群が ml-auto で右端へ飛んでいる(1280px で必ず折り返し、その行の左に 53% の空きが残る)');
    // 中身は1つも減っていない(移しただけ)
    for (const s of ['出力:', '月初・作業計画', '月末・業務実績']) {
      assert.ok(exp.includes(s) || code.includes(s), `「${s}」が消えている`);
    }
  },

  // ── UG2 新しく足した ？ の当たりは 44px 以上 ──
  UG2: (code) => {
    const bar = from(code, '<div data-band="optimize-top"', 4000, '作業最適化の帯');
    const s = bar.indexOf('<summary');
    assert.ok(s > 0, '作業最適化の ？ が無い(説明文を畳む口が消えている)');
    const summary = bar.slice(s, bar.indexOf('</summary>', s));
    assert.ok(summary.includes('？'), '作業最適化の ？ の札が変わっている');
    const { w, h } = hitBox(summary, '作業最適化の ？');
    assert.ok(w >= 44 && h >= 44, `作業最適化の ？ の当たりが ${w}x${h}px(決まり7 の 44x44px 以上のはず)`);
    // 畳んだ説明文は1文字も消えていない
    assert.ok(code.includes('データから現場を最適化：<b>目標時間</b>→<b>厳密モード</b>→<b>スキル</b>。将来は空き人材・エリアから自動配置の土台に。'),
      '作業最適化の説明文が消えている');
  },

  // ── UG3 作業最適化の帯が max-w の中に入っていない(親タブが画面ごとに横へ跳ばない) ──
  UG3: (code) => {
    const at = code.indexOf('<div data-band="optimize-top"');
    assert.ok(at > 0, '作業最適化の帯の目印が無い');
    // 帯より前の、この画面の入れ物に max-w が付いていない
    const open = code.lastIndexOf("{activeTab === 'optimize' && (", at);
    assert.ok(open > 0 && open < at, '作業最適化の画面の始まりが見つからない');
    const before = code.slice(open, at);
    assert.ok(!before.includes('max-w-'), '作業最適化の帯がまた max-w の中に入っている(1366px で左へ 133px 寄り、分析画面と横にずれる)');
    // 帯の左端は分析画面と同じ px-6
    const cls = (code.slice(at, at + 300).match(/className="([^"]*)"/) || [])[1] || '';
    assert.ok(/\bpx-6\b/.test(cls), '作業最適化の帯の左右の余白が分析画面(px-6)と違う(同じ札が横にずれる)');
    const head = (from(code, '<div data-band="analysis-header"', 300, '分析画面のヘッダー').match(/className="([^"]*)"/) || [])[1] || '';
    assert.ok(/\bpx-6\b/.test(head), '分析画面のヘッダーの余白が px-6 でない(2つの画面で札の位置が揃わない)');
    // 中身(下の箱)の 1100px はそのまま残す
    assert.ok(code.slice(at, at + 6000).includes('max-w-[1100px] mx-auto'), '作業最適化の中身の 1100px が消えている');
  },

  // ── UG4 ？ の吹き出しが画面の外へ出ない ──
  UG4: (code) => {
    const fold = from(code, 'data-fold="optimize-howto"', 400, '作業最適化の吹き出し');
    const cls = (fold.match(/className="([^"]*)"/) || [])[1] || '';
    assert.ok(/\bright-0\b/.test(cls), '吹き出しが left-0(左端から右へ)のまま。1366px で右へ 30px はみ出し、2文字が読めなくなる');
    assert.ok(!/\bleft-0\b/.test(cls), '吹き出しに left-0 が残っている(左右の両端に留められて幅が壊れる)');
    const w = Number((cls.match(/\bw-\[(\d+)px\]/) || [])[1]);
    assert.ok(Number.isFinite(w), '吹き出しの幅が読めない');
    assert.ok(/max-w-\[calc\(100vw-/.test(cls), `吹き出しの幅 ${w}px に、画面より広くしない上限(max-w-[calc(100vw-…)])が無い`);
  },

  // ── UG5 合流させた親タブが、区画の文字サイズで伸び縮みしない ──
  UG5: (code) => {
    // 打ち消しの規則を CSS で出している
    assert.ok(code.includes('[data-fs="${area}"] [data-fs-reset] { zoom: ${(1 / scale).toFixed(4)}; }'),
      '区画の文字サイズを打ち消す規則が applyFontSizes から消えている(70% で 9.8px = 決まり7 の 12px 割れ)');
    // 区画の zoom と 打ち消しは、同じ所で必ず対で出す
    const fn = from(code, 'const applyFontSizes = ', 1600, 'applyFontSizes');
    const zoom = (fn.match(/\[data-fs="\$\{area\}"\] \{ zoom/g) || []).length;
    const reset = (fn.match(/\[data-fs="\$\{area\}"\] \[data-fs-reset\] \{ zoom/g) || []).length;
    assert.equal(reset, zoom, `区画の zoom ${zoom}本 に対して 打ち消し ${reset}本(対で出すはず)`);
    // 親タブに印が付いている(分析画面の帯1の中)
    const top = from(code, '<div data-band="analysis-top"', 900, '分析画面の帯1');
    assert.match(top, /data-fs-reset="1"[^>]*>\{parentTabs\}|\{parentTabs\}/, '帯1に親タブが無い');
    assert.ok(top.includes('data-fs-reset="1"'), '合流させた親タブに、区画の文字サイズを打ち消す印(data-fs-reset)が無い');
    const i = top.indexOf('data-fs-reset="1"');
    const j = top.indexOf('{parentTabs}');
    assert.ok(i > 0 && j > i && j - i < 200, '打ち消しの印が親タブに付いていない(別の物に付いている)');
  },
};

const TITLES = {
  UG1: '合体した帯で、右端へ飛ばして真ん中を空ける書き方(ml-auto)を使わない',
  UG2: '新しく足した ？ の当たりは 44px 以上(数で出す)',
  UG3: '作業最適化の帯は max-w の外・左端は分析画面と同じ(札が横に跳ばない)',
  UG4: '？ の吹き出しは右端から出す(1366px で画面の外へ出さない)',
  UG5: '合流させた親タブは、区画の文字サイズで伸び縮みしない',
};

// ---------------------------------------------------------------------------
// UG0 見張り自身の試験。**本物の App.jsx の控え** をわざと壊して、赤になるか数える。
//   壊し方は3通り: ①行を消す(コメント化と同じ形) ②値を変える ③直す前の形へ戻す
//   🚨 ソースには1バイトも書かない。控え(文字列)の上だけで壊す。
// ---------------------------------------------------------------------------
export const BREAKS_FOR_PROOF = [
  ['UG1', '③ 帯2の絞り込みを ml-auto で右端へ戻す', (s) =>
    s.replace('<div className="flex items-center gap-3 flex-wrap">\n              {renderDefectFilterUI()}',
      '<div className="ml-auto flex items-center gap-3 flex-wrap">\n              {renderDefectFilterUI()}')],
  ['UG1', '③ 月次レポートの出力を ml-auto で右端へ戻す', (s) =>
    s.replace('<div data-band="monthly-export" className="flex flex-wrap items-center gap-3"',
      '<div data-band="monthly-export" className="flex flex-wrap items-center gap-3 ml-auto"')],
  ['UG2', '① 作業最適化の ？ の当たり判定の指定を消す', (s) =>
    s.replace('after:top-[-11px] after:bottom-[-11px] after:left-[-11px] after:right-[-11px]" title="この画面の使い方"',
      '" title="この画面の使い方"')],
  ['UG2', '② 作業最適化の ？ の当たりを 前後 10px(=42px) へ 2px だけ小さくする', (s) =>
    s.replace('after:top-[-11px] after:bottom-[-11px] after:left-[-11px] after:right-[-11px]" title="この画面の使い方"',
      'after:top-[-10px] after:bottom-[-10px] after:left-[-10px] after:right-[-10px]" title="この画面の使い方"')],
  ['UG3', '③ 作業最適化の帯を max-w-[1100px] の中へ戻す', (s) =>
    s.replace("{activeTab === 'optimize' && (\n           <div className=\"h-full flex flex-col gap-3\">",
      "{activeTab === 'optimize' && (\n           <div className=\"h-full flex flex-col gap-3 max-w-[1100px] mx-auto\">")],
  ['UG3', '② 作業最適化の帯の左右の余白を削る(分析画面と横がずれる)', (s) =>
    s.replace('<div data-band="optimize-top" className="shrink-0 flex items-center gap-2 flex-wrap px-6"',
      '<div data-band="optimize-top" className="shrink-0 flex items-center gap-2 flex-wrap"')],
  ['UG4', '③ 吹き出しを left-0(直す前の形)へ戻す', (s) =>
    s.replace('className="absolute right-0 top-full mt-1 z-30 w-[380px] max-w-[calc(100vw-3rem)]',
      'className="absolute left-0 top-full mt-1 z-30 w-[380px]')],
  ['UG5', '① 打ち消しの規則を消す', (s) =>
    s.replace('    rules.push(`[data-fs="${area}"] [data-fs-reset] { zoom: ${(1 / scale).toFixed(4)}; }`);\n', '')],
  ['UG5', '① 親タブから打ち消しの印を消す', (s) =>
    s.replace('<div data-fs-reset="1" className="flex items-center gap-1">{parentTabs}</div>',
      '<div className="flex items-center gap-1">{parentTabs}</div>')],
];

test('UG0 🚨 見張り自身の試験: 本物のコードをわざと壊すと、その場で赤になる', () => {
  for (const [id, why, mutate] of BREAKS_FOR_PROOF) {
    const broken = mutate(app);
    assert.notEqual(broken, app, `見本を壊せていない(壊し方が古い): ${id} ${why}`);
    CHECKS[id](app);                                   // 壊す前は緑
    assert.throws(() => CHECKS[id](broken), `${id} は「${why}」を入れても緑のまま = 何も見ていない`);
  }
  assert.equal(BREAKS_FOR_PROOF.length, 9, '壊し方の数が変わっている(減らさない)');
});

for (const [id, fn] of Object.entries(CHECKS)) test(`${id} ${TITLES[id]}`, () => fn(app));
