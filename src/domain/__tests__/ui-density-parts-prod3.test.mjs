// 🧹 部品検査「本番でだけ出る無駄」3本の見張り(2026-09-08)。
//
// 🚨 なぜ別の見張りが要ったか:
//   これまでの見張り(ui-density-parts*.test.mjs)は、帯の中身を「子の最左〜最右 ÷ 帯の幅」で測っていた。
//   左に詰めても「端から端」は同じなので、**右が空いた帯はこの測り方では出ない**(いつも100%)。
//   さらに「怪しい値はありません」の箱は、写しには異常値が在るので **一度も描かれない**。
//   その結果、この3本が「無駄0本」として素通りしていた。
//   親が **本番を読むだけ** で 1366×768 で測った結果:
//
//   | 画面                | 帯                                                              | 中身 | 高さ  |
//   |---------------------|-----------------------------------------------------------------|------|-------|
//   | 分析 > ① データを正す | 「怪しい値はありません — データはクリーンです 🎉」                  |  4%  | 176px |
//   | 分析 > ① データを正す | 「① データを正す（要確認） / 要確認（異常値・該当なし） / 月単位 / 期間」 | 54% |  46px |
//   | 分析 > ⑤ 基準を固める | 「⑤ 基準を固める（定着） / 目標時間・厳密モードへ / 月単位 / 期間指定」  | 51% |  46px |
//   (同じ画面が2つの札から開けるので、数の上では6本に見える)
//
// 直した形を **写し(http://localhost:5630/)の本物の画面** で測り直した(scripts/verify-prod3-bands.mjs が毎回やる):
//   ・帯2 ① データを正す  中身 58% → **98%**(帯の高さは 50px のまま。太っていない)
//   ・帯2 ⑤ 基準を固める  中身 55% → **98%**(同上)
//     測り方: ？(analysis-sub-howto)を display:none にした形 = 直す前 / 戻した形 = 直した後。
//     中身 = **子の幅の合計 ÷ 帯の幅**(右へ飛ばしても 100% にならない数え方)。
//   ・「怪しい値はありません…」 **167px → 40px**(−127px)。
//     写しには描かれないので、その画面の CSS の中に 前と後を同じ幅で描いて測り、すぐ消している。
//   (本番の実測 176px と写しの 167px の差は 行の高さの違い。どちらも 64px の線からは遠い)
//
// 🚨 この見張りが守る事は5つ。全部 **数える**(字面だけを見ない):
//   PC1 「怪しい値はありません — データはクリーンです 🎉」の箱が また太らない(高さを px で出して 64px 以下)
//   PC2 🚨 移した説明の箱の文が **1文字も消えていない**・二重に出していない(回数を数える)
//   PC3 帯2 の ？ は 残りの幅を埋める(flex-1)。ml-auto で右端へ飛ばして真ん中を空けない
//   PC4 押す物 44px 以上・足した文字は 12px 以上(移した箱の 11px も 12px へ直した)
//   PC5 ？ の吹き出しは absolute(開いても帯が縦に伸びて中身を押し下げない)・出す条件は ①/⑤ の2画面だけ
// ⚠ コメントは codeOf が落とすので、コメント化で緑にはできない。
// ⚠ PC0 で **本物の App.jsx の控え** をわざと壊し、赤になる事を毎回走らせて確かめる(ソースには1バイトも書かない)。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOf } from './_code.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const app = codeOf(path.resolve(HERE, '..', '..', 'App.jsx'));

const BAND2 = '<div data-band="analysis-sub"';
const AFTER_HEADER = '<div className="flex-1 overflow-y-auto p-6">';
const FOLD = '<details data-fold="analysis-sub-howto"';
const CLEAN = 'data-empty-clean="anomaly"';

// 範囲を先に切る(同名の物を拾わない為)。
const between = (code, from, to, why) => {
  const a = code.indexOf(from);
  assert.ok(a >= 0, `${why}: 目印 ${from} がソースに無い`);
  const b = code.indexOf(to, a + from.length);
  assert.ok(b > a, `${why}: 終わりの目印 ${to} が見つからない`);
  return code.slice(a, b);
};
const count = (s, code) => code.split(s).length - 1;

// 目印を持つ札の className を取る。
const classOf = (code, marker, why) => {
  const i = code.indexOf(marker);
  assert.ok(i >= 0, `${why}: 目印 ${marker} がソースに無い`);
  const j = code.indexOf('>', i);
  const m = code.slice(code.lastIndexOf('<', i), j).match(/className="([^"]*)"/);
  assert.ok(m, `${why}: className が読めない`);
  return m[1];
};

// tailwind の py-N / p-N は N×4px。上下ぶんを px で返す。
const padY = (cls) => {
  const py = cls.match(/\bpy-(\d+)\b/);
  if (py) return Number(py[1]) * 4 * 2;
  const p = cls.match(/\bp-(\d+)\b/);
  if (p) return Number(p[1]) * 4 * 2;
  return 0;
};

// 🚨 直した「怪しい値はありません」の1行。文字は1文字も変えない。
const CLEAN_TEXT = '怪しい値はありません — データはクリーンです 🎉';

// 🚨 帯2 の ？ の中へ移した説明の文。1文でも消えたら赤。
const MOVED = [
  'まず土台＝データを正す。',
  '0秒・4時間超・時刻矛盾などの',
  '怪しい値',
  'を直すか「',
  '該当なし(対象外)',
  '」にしてから、②で分析します（汚れたデータだと分析が嘘になります）。',
  'セルをタップ →「目標で埋める / 実時間を手入力 / 📦該当なし / そのまま」。',
  '工程名タップ',
  'で「#2以降をまとめて該当なし」（ロットで1回だけの工程の過去データ向け）。',
  '改善（③④）で効果が出たら、',
  'その成果を「標準」に反映して定着',
  'させます。基準時間を更新し、安定した作業順を固定します。',
];

// この説明の箱にしか出ない長い文(実測: どれも App.jsx に1回だけ)。
// 「移した」であって「増やした」でも「二重に出した」でもない事を、回数で数える。
const ONLY_HERE = [
  'まず土台＝データを正す。',
  '0秒・4時間超・時刻矛盾などの',
  '」にしてから、②で分析します（汚れたデータだと分析が嘘になります）。',
  'セルをタップ →「目標で埋める / 実時間を手入力 / 📦該当なし / そのまま」。',
  'で「#2以降をまとめて該当なし」（ロットで1回だけの工程の過去データ向け）。',
  '改善（③④）で効果が出たら、',
  'その成果を「標準」に反映して定着',
  'させます。基準時間を更新し、安定した作業順を固定します。',
];

export const CHECKS = {
  // ── PC1 「怪しい値はありません」の箱は 64px 以下(176px へ戻さない) ──
  PC1: (code) => {
    const n = count(CLEAN_TEXT, code);
    assert.equal(n, 1, `「${CLEAN_TEXT}」が ${n} か所(1か所のはず。消しても増やしてもいけない)`);
    const cls = classOf(code, CLEAN, '怪しい値はありませんの箱');
    // 太る書き方(py-12 / 丸い大きな絵)が復活していない
    assert.ok(!/\bpy-(1[0-9]|2[0-9])\b/.test(cls), `また巨大な空箱に戻っている(${cls})`);
    const box = between(code, CLEAN, '</div>', '怪しい値はありませんの箱');
    assert.ok(!/w-12 h-12/.test(box), '緑の✔の絵がまた 48px(w-12 h-12)に戻っている');
    assert.ok(!/mx-auto mb-2/.test(box), '絵がまた「中央に置いて下に余白」の縦積みに戻っている(高さが2行ぶんになる)');
    // 絵(CheckCircle2)は残っている。消したのではなく小さくしただけ。
    const icon = Number((box.match(/<CheckCircle2 className="w-(\d+) h-\1/) || [])[1]);
    assert.ok(Number.isFinite(icon), '緑の✔の絵(CheckCircle2)が消えている');
    assert.ok(icon * 4 <= 24, `絵が ${icon * 4}px(24px 以下のはず)`);
    // 喜びの印も文も そのまま
    assert.ok(box.includes('🎉'), '喜びの印(🎉)が消えている');
    assert.ok(box.includes(CLEAN_TEXT), '文言が変わっている');
    // 高さを px で出す: 上下の余白 + わく(1px×2) + 行の高さ(絵と文字の高い方。文字は 16px/24px)
    const border = /\bborder\b/.test(cls) ? 2 : 0;
    const h = padY(cls) + border + Math.max(icon * 4, 24);
    assert.ok(h <= 64, `「${CLEAN_TEXT}」の箱が ${h}px(64px 以下のはず)`);
    // 横1行に並べている(縦積みに戻していない)
    assert.ok(/\bflex\b/.test(cls) && /\bitems-center\b/.test(cls), `絵と文が横1行に並んでいない(${cls})`);
  },

  // ── PC2 🚨 移した説明の文が1文字も消えていない・二重に出していない ──
  PC2: (code) => {
    const fold = between(code, FOLD, '</details>', '帯2 の ？');
    for (const s of MOVED) {
      assert.ok(fold.includes(s), `帯2 の ？ の中から文が消えている: 「${s}」`);
    }
    // 「移した」であって「増やした」ではない事も数える。
    // ⚠ 「怪しい値」「該当なし(対象外)」のような短い言い回しは別の画面でも使うので、
    //    **この説明の箱にしか出ない長い文** だけを 1回ちょうど で数える(緩めではなく、正しい数え方)。
    for (const s of ONLY_HERE) {
      const n = count(s, code);
      assert.equal(n, 1, `「${s}」が ${n} か所(1か所のはず。移したのに元の場所へも残すと二重に出る)`);
    }
    // 中身の側(分析の本文)には もう説明の箱を置いていない = 移した(消したのではない)
    // ⚠ 本文の始まりは **帯2 より後ろ** の目印で探す(同じ入れ物の書き方が別の画面にも在る)。
    const body = code.slice(code.indexOf(AFTER_HEADER, code.indexOf(BAND2)));
    assert.ok(!body.includes('まず土台＝データを正す。'), '説明の箱が本文へ戻っている(帯2 の右がまた空く)');
    assert.ok(!body.includes('改善（③④）で効果が出たら、'), '説明の箱が本文へ戻っている(帯2 の右がまた空く)');
    // ？ は1つだけ(二重に置いていない)
    assert.equal(count(FOLD, code), 1, `帯2 の ？ が ${count(FOLD, code)} か所(1か所のはず)`);
  },

  // ── PC3 ？ は残りの幅を埋める(flex-1)。ml-auto で右端へ飛ばさない ──
  PC3: (code) => {
    const b2 = between(code, BAND2, AFTER_HEADER, '帯2');
    assert.ok(b2.includes(FOLD), '帯2 の中に ？(analysis-sub-howto)が無い。移した説明が帯の外へ出ている');
    const cls = classOf(code, FOLD, '帯2 の ？');
    assert.ok(/\bflex-1\b/.test(cls),
      `帯2 の ？ に flex-1 が無い(${cls})。残りの幅を埋めないと 中身が 54% / 51% のままで右が空く`);
    // 🚨 幅の下限は2段。写しで幅を16通り測って見つけた穴(どちらも実測):
    //   ・下限が無い(flex-1 だけ) … 幅900px で ？ が **46px** まで縮み、もう少し狭いと決まり7 の 44px を割る
    //   ・下限が 7rem(112px)だけ  … 幅 820〜960px で 帯が 50px → **109px**(2行に折り返して太る)
    //   → 狭い時の下限は 44px 以上(押せる)・広い時(xl)は 7rem 以上(読み方の1行が出る)。
    const small = (cls.match(/(?:^|\s)min-w-\[(\d+(?:\.\d+)?)rem\]/) || [])[1];
    const wide = (cls.match(/\bxl:min-w-\[(\d+(?:\.\d+)?)rem\]/) || [])[1];
    assert.ok(small, `帯2 の ？ に幅の下限(min-w-[Nrem])が無い(${cls})。狭い画面で押す所が 44px を割る`);
    assert.ok(Number(small) * 16 >= 44,
      `帯2 の ？ の狭い時の幅の下限が ${Number(small) * 16}px(決まり7 の 44px 以上のはず)`);
    assert.ok(wide, `帯2 の ？ に広い画面での幅の下限(xl:min-w-[Nrem])が無い(${cls})。1366px で読み方の1行が潰れる`);
    assert.ok(Number(wide) >= 7,
      `帯2 の ？ の広い時の幅の下限が ${wide}rem(7rem 以上のはず)`);
    assert.ok(Number(wide) > Number(small),
      `広い時の下限(${wide}rem)が狭い時(${small}rem)より大きくない。2段にした意味が無い`);
    assert.ok(!/\bml-auto\b/.test(cls),
      `帯2 の ？ が ml-auto で右端へ飛んでいる(${cls})。真ん中が空く(設計 決まり1 の⚠・UG1 と同じ)`);
    // 帯そのものは今までどおり1本(帯を増やしていない)
    assert.equal(count('data-band="', b2), 1, '帯2 の中に新しい帯を足している(段が増える)');
  },

  // ── PC4 押す物 44px 以上・文字 12px 以上 ──
  PC4: (code) => {
    const fold = between(code, FOLD, '</details>', '帯2 の ？');
    const sum = fold.slice(fold.indexOf('<summary'), fold.indexOf('</summary>'));
    assert.ok(sum.includes('min-h-[2.75rem]'), '帯2 の ？ の押す所が 44px 未満');
    assert.ok(sum.includes('？'), '帯2 の ？ の札が消えている(押すと説明が出る事が分からない)');
    // 12px 未満の直書きが1つも無い(移した箱の text-[11px] は text-xs へ直した)
    const px = [...fold.matchAll(/text-\[(\d+)px\]/g)].map((m) => Number(m[1]));
    assert.deepEqual(px.filter((n) => n < 12), [], `帯2 の ？ の中に 12px 未満の文字がある: ${px.join(', ')}`);
    assert.ok(fold.includes('text-xs text-slate-600 bg-amber-50'),
      '移した ① の説明の箱の文字が text-xs でない(11px のままだと決まり7 の 12px を割る)');
  },

  // ── PC5 吹き出しは absolute・出すのは ①/⑤ の2画面だけ ──
  PC5: (code) => {
    const fold = between(code, FOLD, '</details>', '帯2 の ？');
    const pop = fold.slice(fold.indexOf('<div className="absolute'), fold.indexOf('<div className="absolute') + 200);
    assert.ok(/\babsolute\b/.test(pop), '吹き出しが absolute でない(開くと帯が縦に伸びて中身を押し下げる)');
    assert.ok(/\bright-0\b/.test(pop), '吹き出しが right-0 でない(帯の右端に居るので画面の外へ出る)');
    assert.ok(/\bmax-w-full\b/.test(pop), '吹き出しの幅の上限が max-w-full でない(zoom の中では vw は上限にならない)');
    // 出す条件: ① データを正す と ⑤ 基準を固める の2画面だけ。他の画面の帯を太らせない。
    const b2 = between(code, BAND2, AFTER_HEADER, '帯2');
    const cond = b2.slice(0, b2.indexOf(FOLD));
    assert.ok(cond.includes("{(activeMode === 'anomaly' || activeMode === 'standardize') && ("),
      '帯2 の ？ を出す条件(① データを正す・⑤ 基準を固める の2画面だけ)が変わっている');
    // 閉じている時は1行(帯を2行にしない)
    const sum = fold.slice(fold.indexOf('<summary'), fold.indexOf('</summary>'));
    assert.ok(sum.includes('truncate'), '閉じている時の1行に truncate が無い(狭い画面で帯が2行になって太る)');
  },
};

const TITLES = {
  PC1: '「怪しい値はありません — データはクリーンです 🎉」の箱は 64px 以下(176px へ戻さない)',
  PC2: '🚨 帯2 の ？ へ移した説明の文が1文字も消えていない・二重に出していない',
  PC3: '帯2 の ？ は残りの幅を埋める(右端へ飛ばして真ん中を空けない)',
  PC4: '押す物 44px 以上・足した文字は 12px 以上',
  PC5: '？ の吹き出しは absolute・出すのは ①/⑤ の2画面だけ',
};

// ---------------------------------------------------------------------------
// PC0 見張り自身の試験。**本物の App.jsx の控え** をわざと壊して、赤になるか数える。
//   壊し方は3通り: ①行を消す(コメント化と同じ形) ②値を変える ③直す前の形へ戻す
//   🚨 ソースには1バイトも書かない。控え(文字列)の上だけで壊す。
// ---------------------------------------------------------------------------
export const BREAKS_FOR_PROOF = [
  ['PC1', '③ 直す前の形(py-12 + w-12 h-12 の縦積み)へ戻す', (s) =>
    s.replace('<div data-empty-clean="anomaly" className="flex items-center justify-center gap-2 py-2 text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-lg"><CheckCircle2 className="w-5 h-5 shrink-0" />',
      '<div data-empty-clean="anomaly" className="text-center py-12 text-emerald-600"><CheckCircle2 className="w-12 h-12 mx-auto mb-2" />')],
  ['PC1', '② 上下の余白だけ py-2 → py-8 へ太らせる(72px)', (s) =>
    s.replace('data-empty-clean="anomaly" className="flex items-center justify-center gap-2 py-2',
      'data-empty-clean="anomaly" className="flex items-center justify-center gap-2 py-8')],
  ['PC1', '① 緑の✔の絵を消す', (s) =>
    s.replace('<CheckCircle2 className="w-5 h-5 shrink-0" /> 怪しい値はありません', ' 怪しい値はありません')],
  ['PC1', '① 喜びの印(🎉)を消す', (s) =>
    s.replace('怪しい値はありません — データはクリーンです 🎉', '怪しい値はありません — データはクリーンです')],
  ['PC2', '① 移した ① の説明の1文を消す', (s) =>
    s.replace('セルをタップ →「目標で埋める / 実時間を手入力 / 📦該当なし / そのまま」。', '')],
  ['PC2', '① 移した ⑤ の説明の1文を消す', (s) =>
    s.replace('させます。基準時間を更新し、安定した作業順を固定します。', 'させます。')],
  ['PC2', '③ 説明の箱を本文へも戻す(二重に出る)', (s) =>
    s.replace('             <div className="space-y-3">\n',
      '             <div className="space-y-3">\n               <div className="text-xs">まず土台＝データを正す。</div>\n')],
  ['PC3', '② ？ の flex-1 を外す(右がまた 42〜45% 空く)', (s) =>
    s.replace('<details data-fold="analysis-sub-howto" className="min-w-[3rem] xl:min-w-[7rem] flex-1 bg-slate-50 rounded-xl border">',
      '<details data-fold="analysis-sub-howto" className="min-w-[3rem] xl:min-w-[7rem] bg-slate-50 rounded-xl border">')],
  ['PC3', '② ？ を ml-auto で右端へ飛ばす(真ん中が空く)', (s) =>
    s.replace('<details data-fold="analysis-sub-howto" className="min-w-[3rem] xl:min-w-[7rem] flex-1',
      '<details data-fold="analysis-sub-howto" className="ml-auto min-w-[3rem] xl:min-w-[7rem] flex-1')],
  ['PC3', '② 狭い時の幅の下限を 2rem(32px)へ縮める(押す所が 44px を割る)', (s) =>
    s.replace('className="min-w-[3rem] xl:min-w-[7rem] flex-1', 'className="min-w-[2rem] xl:min-w-[7rem] flex-1')],
  ['PC3', '① 幅の下限を丸ごと外す(実測: 幅900px で 46px まで縮み、もう少し狭いと 44px を割る)', (s) =>
    s.replace('className="min-w-[3rem] xl:min-w-[7rem] flex-1 bg-slate-50', 'className="flex-1 bg-slate-50')],
  ['PC3', '① 広い画面の下限(xl:min-w-[7rem])だけ外す(1366px で読み方の1行が潰れる)', (s) =>
    s.replace('className="min-w-[3rem] xl:min-w-[7rem] flex-1', 'className="min-w-[3rem] flex-1')],
  ['PC4', '② 押す所を 44px 未満(min-h-[2rem])にする', (s) =>
    s.replace('<summary className="flex min-h-[2.75rem] cursor-pointer select-none list-none items-center gap-1 px-3 text-xs font-bold text-slate-600">',
      '<summary className="flex min-h-[2rem] cursor-pointer select-none list-none items-center gap-1 px-3 text-xs font-bold text-slate-600">')],
  ['PC4', '③ 移した ① の説明の文字を text-[11px](直す前の大きさ)へ戻す', (s) =>
    s.replace('<div className="text-xs text-slate-600 bg-amber-50', '<div className="text-[11px] text-slate-600 bg-amber-50')],
  ['PC5', '③ 吹き出しを帯の中へ流し込む(absolute をやめる = 開くと帯が縦に伸びる)', (s) =>
    s.replace('<div className="absolute right-0 top-full mt-1 z-30 w-[420px] max-w-full bg-white border rounded-xl shadow-lg px-4 py-3">\n                {activeMode === \'anomaly\' && (',
      '<div className="mt-1 z-30 w-[420px] max-w-full bg-white border rounded-xl shadow-lg px-4 py-3">\n                {activeMode === \'anomaly\' && (')],
  ['PC5', '② 出す条件を全画面へ広げる(他の画面の帯まで太る)', (s) =>
    s.replace("{(activeMode === 'anomaly' || activeMode === 'standardize') && (", "{(activeMode !== '') && (")],
  ['PC5', '① 閉じている時の truncate を外す(狭い画面で帯が2行になる)', (s) =>
    s.replace('<span className="truncate">{activeMode === \'anomaly\'', '<span>{activeMode === \'anomaly\'')],
];

test('PC0 🚨 見張り自身の試験: 本物のコードをわざと壊すと、その場で赤になる', () => {
  for (const [id, why, mutate] of BREAKS_FOR_PROOF) {
    const broken = mutate(app);
    assert.notEqual(broken, app, `見本を壊せていない(壊し方が古い): ${id} ${why}`);
    CHECKS[id](app);                                   // 壊す前は緑
    assert.throws(() => CHECKS[id](broken), `${id} は「${why}」を入れても緑のまま = 何も見ていない`);
  }
  assert.equal(BREAKS_FOR_PROOF.length, 17, '壊し方の数が変わっている(減らさない)');
});

for (const [id, fn] of Object.entries(CHECKS)) test(`${id} ${TITLES[id]}`, () => fn(app));
