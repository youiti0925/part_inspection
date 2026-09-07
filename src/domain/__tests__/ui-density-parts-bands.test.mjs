// 🧹 部品検査「中身の少ない横帯」を、また作らない為の見張り(2026-09-07)。
//
// 何があったか(本番・1366×768 で実測。設計_画面の無駄を全部なくす_2026-09-07.md の表):
//   帯                                                        中身   高さ
//   「改善スコアボード — 今月のうごき（先月と比べて）」          1%   36px  ← 見出しだけの帯
//   「手動でカルテ: / 品目コードを選択 / 工程を選択 / ＋ 作成」  29%   46px
//   「読み方：1年でその工程に…」(説明1行)                       30%   30px
//   「品目コード / 品目コードを選択... / 集計 / 過去1ヶ月」      34%   59px
//   「出力: / 月初・作業計画 / PDF / Excel」                     47%   70px
//
// 直した形(本番と同じ dist の CSS を当てて、1366px の中で帯そのものを描いて実測。前 → 後):
//   改善スコアボードの見出し             107px → 67px
//   改善PDCA 検索の行 + 手動でカルテ     150px → 93px
//   重点工程 見出し + 読み方の1行         73px → 43px
//   目標時間最適化 見出し + 品目コードの帯 167px → 137px
//   月次レポート 見出し + 出力の箱       239px → 206px
//                                        合計 −190px
//
// 🚨 この見張りが守る事は3つ:
//   ① 中身の少ない専用の帯が復活していない(入れ物の数を **数える**)
//   ② 移した押す物・入れる物が、合体した先の中に **本当に入っている**(入れ物を辿って中を見る)
//   ③ 畳んだ・移した文言が1つも消えていない(字で数える)
// ⚠ コメントは codeOf が落とすので、コメント化で緑にはできない。
// ⚠ この見張り自身も試験する(PB0)。本物の App.jsx を **控えの上で** わざと壊し、
//   ちゃんと赤になる事を毎回走らせて確かめる(ソースには1バイトも書かない)。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOf } from './_code.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const app = codeOf(path.resolve(HERE, '..', '..', 'App.jsx'));

const count = (s, code) => code.split(s).length - 1;
// 目印は「入れ物に付いている物」だけを数える(人が書いた説明文の中の同じ字を数えない)。
const bands = (name, code) => count(`<div data-band="${name}"`, code) + count(`<div data-fold="${name}"`, code);

// 目印を含む <div …> から、その div が閉じる所までを切り出す。
// ⚠ 範囲を先に切らないと、同じ文言が別の場所に在るだけで緑になってしまう。
//   自分で閉じる <div … /> は数に入れない(「出力:」の中の区切り線がこの形)。
const elementSlice = (marker, code) => {
  const at = code.indexOf(marker);
  assert.ok(at > 0, `目印 ${marker} がソースに無い`);
  const open = code.lastIndexOf('<div', at);
  assert.ok(open >= 0, `${marker} を持つ <div> が見つからない`);
  let i = open;
  let depth = 0;
  while (i < code.length) {
    const nextOpen = code.indexOf('<div', i + 1);
    const nextClose = code.indexOf('</div>', i + 1);
    assert.ok(nextClose > 0, `${marker} の入れ物が閉じていない`);
    if (nextOpen > 0 && nextOpen < nextClose) {
      const tagEnd = code.indexOf('>', nextOpen);
      const selfClosing = code.slice(nextOpen, tagEnd).trimEnd().endsWith('/');
      if (!selfClosing) depth += 1;
      i = tagEnd;
      continue;
    }
    if (depth === 0) return code.slice(open, nextClose + 6);
    depth -= 1;
    i = nextClose + 5;
  }
  throw new Error(`${marker} の入れ物が閉じていない`);
};

const has = (slice, needle, why) => assert.ok(slice.includes(needle), `${why}: 「${needle}」がその入れ物の中に無い`);

// 🚨 畳んだ・移した文言。1つでも消えたら赤。
const KEEP = [
  '改善スコアボード — 今月のうごき（先月と比べて）',
  '今月 浮いた時間（先月より速くなった分）',
  '浮いた余力（時間）',
  '増産・多能工化・内製化・改善活動',
  '手動でカルテ:',
  '品目コードを選択',
  '工程を選択',
  '＋ 作成',
  '手動作成',
  '1年でその工程に合計どれだけ時間がかかっているかの大きい順です。',
  '同じ工程（例: 測定準備）を',
  'その1工程を直すと全品目コードに効いて大きい',
  '品目コードを選択...',
  '過去1ヶ月',
  '期間指定',
  '全工程に一括:',
  '標準バランス型',
  '出力:',
  '月初・作業計画',
  '月末・業務実績',
  '対象月',
  '提出先',
  'グループ / 部署名',
  '所感 (実績報告書 §8 に記載 — 任意)',
];

// 🚨 合体した帯の中に在る「12px 未満の字」の一覧(2026-09-08 に実測して控えた)。
//   前から在る物をそのまま移しただけ。**これ以上 小さくしない・新しく足さない** を PB7 が数で見る。
const PB7_SMALL = {
  'サマリの行': [10, 11],
  '検索の行': [],
  '品目コードの行': [11],
  '出力の行': [],
};

// 見張りの中身。PB0(自己試験)から同じ物を呼ぶ為に、コードを引数で受ける形にする。
export const CHECKS = {
  PB1: (code) => {
    const box = code.indexOf('border-2 border-indigo-200 rounded-xl overflow-hidden mb-4');
    assert.ok(box > 0, '改善スコアボードの箱が無い');
    const summary = code.indexOf('data-band="scoreboard-summary"', box);
    assert.ok(summary > box, 'サマリの行の目印 data-band="scoreboard-summary" が無い');
    // 箱を開けたら、次に出て来る入れ物は **サマリの行1つだけ**。間に帯を挟まない。
    const between = code.slice(code.indexOf('>', box) + 1, summary);
    const opens = (between.match(/<div/g) || []).length;
    assert.equal(opens, 1, `箱とサマリの行の間に入れ物が ${opens} 個ある(見出しだけの帯が復活している)`);
    const row = elementSlice('data-band="scoreboard-summary"', code);
    has(row, '改善スコアボード — 今月のうごき（先月と比べて）', '見出しがサマリの行の中に無い');
    has(row, '今月 浮いた時間（先月より速くなった分）', 'サマリの中身が消えている');
    assert.ok(row.indexOf('改善スコアボード —') < row.indexOf('今月 浮いた時間'), '見出しは行の左端に置く');
  },

  PB2: (code) => {
    assert.equal(bands('pdca-search', code), 1, '検索の行の目印が1つでない');
    const row = elementSlice('data-band="pdca-search"', code);
    has(row, 'placeholder="品目コード・工程・担当・問題で検索"', '検索の入れ物');
    has(row, '手動でカルテ:', '手動でカルテの札');
    has(row, '品目コードを選択', '品目コードの選び口');
    has(row, '工程を選択', '工程の選び口');
    has(row, '＋ 作成', '作成のボタン');
    has(row, 'createCard(', '作成ボタンの行き先');
    // 移したのに元も残す(二重化)をしていない
    assert.equal(count('手動でカルテ:', code), 1, '「手動でカルテ:」がソースに2か所以上ある');
    // 専用の帯が戻っていない
    assert.ok(!code.includes('flex items-center gap-2 flex-wrap bg-white border rounded-xl p-2'),
      '「手動でカルテ」だけの専用の帯が戻っている');
  },

  PB3: (code) => {
    assert.equal(bands('ranking-howto', code), 1, '読み方を畳んだ入れ物の目印が1つでない');
    const fold = elementSlice('data-fold="ranking-howto"', code);
    has(fold, '1年でその工程に合計どれだけ時間がかかっているかの大きい順です。', '読み方(品目別)の文');
    has(fold, '同じ工程（例: 測定準備）を', '読み方(工程横断)の文');
    has(fold, '集計に使った指図一覧（確認用）が見られます。', '読み方の後半');
    // ？ は 重点工程の見出しの行の中に置く(専用の行を足さない)
    const head = code.indexOf('重点工程 —');
    assert.ok(head > 0, '重点工程の見出しが無い');
    assert.ok(code.indexOf('data-fold="ranking-howto"') - head < 1500, '？ が見出しの行から離れている(行を1本足したのでは)');
    // 説明1行だけの帯が戻っていない
    assert.ok(!code.includes('px-3 py-1.5 bg-white text-[11px] text-slate-500 border-b'),
      '「読み方：」だけの1行の帯が戻っている');
    // 🚨 押せる所は 44px 以上。**字面ではなく数で** 見る(2026-09-08 直し)。
    //   前は after:-top-2.5(=10px)等の **字が在るか** だけを見ていた。実際の当たりは
    //     札 w-6 h-6 = 24px、border 1px、box-sizing:border-box → 内側(padding box)は 24 - 1×2 = 22px。
    //     ::after は border box ではなく **padding box** に対して置かれるので 22 + 10 + 10 = 42px しか無く、
    //   決まり7 の 44px を 2px 割ったまま、見張りがその値を固定していた。数で見る形へ直した。
    const sum = code.slice(code.indexOf('<summary', code.indexOf('<details', head)), code.indexOf('data-fold="ranking-howto"'));
    assert.ok(/\bw-6 h-6\b/.test(sum), '？ の札の大きさ(w-6 h-6)が変わっている(内側の大きさが読めない)');
    assert.ok(/\bborder border-emerald-300\b/.test(sum), '？ の枠(border 1px)が変わっている(内側の大きさが読めない)');
    const INNER = 24 - 1 * 2; // 札 24px − わく 1px×2 = 内側 22px
    const grow = (side) => {
      const m = sum.match(new RegExp(`after:${side}-\\[(-?\\d+)px\\]`));
      assert.ok(m, `？ の当たり判定 after:${side}-[…px] が無い(小さくしたか、書き方を変えた)`);
      const v = -Number(m[1]);
      assert.ok(v > 0, `？ の当たり判定 after:${side} が外へ広がっていない(${m[1]}px)`);
      return v;
    };
    const w = INNER + grow('left') + grow('right');
    const h = INNER + grow('top') + grow('bottom');
    assert.ok(w >= 44 && h >= 44, `？ の当たり判定が ${w}x${h}px(決まり7 の 44x44px 以上のはず)`);
    // 上へ広げた分が、親の overflow-hidden(rounded-xl の箱)に切られていない事。
    //   箱のわく 1px + 見出しの行の上の余白(py-N = N×4px) が、上へ広げた px 以上なければ切られる。
    const rowPad = Number((code.slice(code.lastIndexOf('<div className="px-3 py-', head), head).match(/py-(\d+(?:\.\d+)?)/) || [])[1]);
    assert.ok(Number.isFinite(rowPad), '重点工程の見出しの行の上下の余白(py-…)が読めない');
    assert.ok(1 + rowPad * 4 >= grow('top'),
      `？ の当たりの上 ${grow('top')}px が箱に切られる(わく1px + 行の余白 ${rowPad * 4}px しか無い)`);
  },

  PB4: (code) => {
    assert.equal(bands('optimize-filter', code), 1, '品目コードの帯の目印が1つでない');
    const headBox = elementSlice('data-band="optimize-head"', code);
    has(headBox, '工程改善・目標時間最適化', '見出しの箱の題');
    has(headBox, 'data-band="optimize-filter"', '見出しの箱の中に品目コードの行が入っていない');
    const filt = elementSlice('data-band="optimize-filter"', code);
    has(filt, '品目コードを選択...', '品目コードの選び口');
    has(filt, '集計', '集計の札');
    for (const opt of ['過去1ヶ月', '過去3ヶ月', '過去6ヶ月', '全期間', '期間指定']) has(filt, opt, '集計の選び口');
    has(filt, '全工程に一括:', '一括の札');
    for (const opt of ['標準バランス型', '効率追求型', '余裕確保型']) has(filt, opt, '一括のやり方');
    has(filt, 'applyAllSuggestedTargets', '一括の適用ボタンの行き先');
    has(filt, '件で判断', '工程の件数の札');
    // 専用の箱が戻っていない
    assert.ok(!code.includes('flex flex-wrap items-center gap-2 bg-white p-2.5 rounded-lg border shadow-sm shrink-0'),
      '「品目コード / 集計」だけの専用の箱が戻っている');
  },

  PB5: (code) => {
    assert.equal(bands('monthly-export', code), 1, '出力の目印が1つでない');
    const exp = elementSlice('data-band="monthly-export"', code);
    has(exp, '出力:', '出力の札');
    has(exp, '月初・作業計画', '月初の札');
    has(exp, '月末・業務実績', '月末の札');
    for (const fn of ['buildPlanPdf', 'buildPlanExcel', 'buildActualPdf', 'buildActualExcel']) has(exp, fn, '出力の行き先');
    assert.equal((exp.match(/<Btn /g) || []).length, 4, '出力のボタンが4つでない(PDF/Excel × 月初/月末)');
    // 対象月・提出先と同じ行に居る
    const row = elementSlice('data-band="monthly-head"', code);
    has(row, '対象月', '対象月の札');
    has(row, '提出先', '提出先の入れ物');
    has(row, 'data-band="monthly-export"', '出力が対象月の行の外に出ている(帯が1本増える)');
    assert.ok(!code.includes('shadow-sm p-4 flex flex-wrap items-center gap-3'), '「出力:」だけの専用の箱が戻っている');
  },

  PB6: (code) => {
    const gone = KEEP.filter((s) => !code.includes(s));
    assert.deepEqual(gone, [], `消えた文言がある: ${gone.join(' / ')}`);
  },

  // ⚠ 10px / 11px の小さな札は、このアプリが前から使っている物(App.jsx 全体で
  //    text-[10px] 511か所・text-[11px] 239か所)。今回はそれを **そのまま移した** だけで、
  //    1文字も小さくしていない。
  // 🚨 2026-09-08 直し: 前は「10px 未満なら赤」だった。決まり7 の線は **12px** なので、
  //    11px へ縮めても緑のまま通ってしまう穴が在った。今は
  //    「12px 未満の物は、**いま在るこの並びと1つも違ってはいけない**」を数える。
  //    = これ以上 小さくもできないし、新しく小さい字を足す事もできない。
  //    ⚠ ここの数を増やしたり小さくしたりして緑にしない。減らす(大きくする)時だけ、この表も直す。
  PB7: (code) => {
    const slices = {
      'サマリの行': elementSlice('data-band="scoreboard-summary"', code),
      '検索の行': elementSlice('data-band="pdca-search"', code),
      '品目コードの行': elementSlice('data-band="optimize-filter"', code),
      '出力の行': elementSlice('data-band="monthly-export"', code),
    };
    for (const [name, s] of Object.entries(slices)) {
      const px = [...s.matchAll(/text-\[(\d+)px\]/g)].map((m) => Number(m[1]));
      assert.deepEqual(px.filter((n) => n < 12).sort((a, b) => a - b), PB7_SMALL[name],
        `${name} の 12px 未満の文字が変わっている(小さくした・新しく足した)`);
      assert.deepEqual(px.filter((n) => n >= 26), [], `${name} に 26px 以上の直書きがある`);
      const big = [...s.matchAll(/text-(3xl|4xl|5xl|6xl)\b/g)].map((m) => m[0]);
      assert.deepEqual(big, [], `${name} に大きすぎる文字がある: ${big.join(', ')}`);
    }
  },
};

const TITLES = {
  PB1: '改善スコアボードの見出しは、専用の帯ではなく中身の行の中に在る',
  PB2: '「手動でカルテ」の3つの押す物は、右が空いていた検索の行の中に在る',
  PB3: '「読み方：」の説明は ？ の中に畳んである(1行だけの帯を作らない)',
  PB4: '「品目コード / 集計」は 工程改善・目標時間最適化 の見出しの箱の中に在る',
  PB5: '「出力:」の4つのボタンは 月次レポートの対象月の行の中に在る',
  PB6: '🚨 畳んだ・移した文言が1つも消えていない(字で数える)',
  PB7: '合体した帯の中に、今より小さい文字も 26px 以上の文字も作らない',
};

// ---------------------------------------------------------------------------
// PB0 見張り自身の試験。**本物の App.jsx の控え** をわざと壊して、赤になるか数える。
//   壊し方は3通り: ①行を消す(＝コメント化と同じ。codeOf がコメントを落とすので同じ形になる)
//                  ②値を変える(目印の名前を変える) ③元の形へ戻す(専用の帯を作り直す)
//   🚨 ソースには1バイトも書かない。控え(文字列)の上だけで壊す。
// ---------------------------------------------------------------------------
export const BREAKS_FOR_PROOF = [
  ['PB1', '③ 見出しだけの帯を作り直す', (s) => {
    const i = s.indexOf('border-2 border-indigo-200 rounded-xl overflow-hidden mb-4');
    const j = s.indexOf('>', i) + 1;
    return `${s.slice(0, j)}\n<div className="px-3 py-2 bg-indigo-600 text-white text-sm font-black">改善スコアボード — 今月のうごき（先月と比べて）</div>${s.slice(j)}`;
  }],
  ['PB2', '① 「手動でカルテ:」の札の行を消す(コメント化と同じ形)', (s) =>
    s.replace('<span className="text-xs font-bold text-slate-500">手動でカルテ:</span>', '')],
  ['PB6', '① 「手動でカルテ:」の札の行を消す', (s) =>
    s.replace('<span className="text-xs font-bold text-slate-500">手動でカルテ:</span>', '')],
  ['PB2', '② 検索の行の目印の名前を変える(合体先が分からなくなる)', (s) =>
    s.replace('<div data-band="pdca-search"', '<div data-band="pdca-search-2"')],
  ['PB2', '③ 「手動でカルテ」を専用の帯へ戻す', (s) =>
    s.replace('<div className="flex items-center gap-2 flex-wrap">\n            <span className="text-xs font-bold text-slate-500">手動でカルテ:</span>',
      '<div className="flex items-center gap-2 flex-wrap bg-white border rounded-xl p-2">\n            <span className="text-xs font-bold text-slate-500">手動でカルテ:</span>')],
  ['PB3', '① 読み方(品目別)の文を消す', (s) =>
    s.replace('1年でその工程に合計どれだけ時間がかかっているかの大きい順です。', '')],
  ['PB3', '② ？ の当たり判定の指定を消す(24px の札だけになる)', (s) =>
    s.replace('after:top-[-11px] after:bottom-[-11px] after:left-[-11px] after:right-[-11px]', '')],
  ['PB3', '② ？ の当たり判定を 前後 10px(=42px) へ 2px だけ小さくする', (s) =>
    s.replace('after:top-[-11px] after:bottom-[-11px] after:left-[-11px] after:right-[-11px]',
      'after:top-[-10px] after:bottom-[-10px] after:left-[-10px] after:right-[-10px]')],
  ['PB3', '② 見出しの行の余白を py-2 へ戻す(？ の当たりの上 3px が箱に切られる)', (s) =>
    s.replace('<div className="px-3 py-2.5 bg-emerald-50', '<div className="px-3 py-2 bg-emerald-50')],
  ['PB7', '② 検索の行に 11px の字を新しく足す(決まり7 の 12px 割れ)', (s) =>
    s.replace('className="mt-2 flex items-center gap-x-3 gap-y-2 flex-wrap"',
      'className="mt-2 text-[11px] flex items-center gap-x-3 gap-y-2 flex-wrap"')],
  ['PB4', '③ 「品目コード / 集計」を専用の箱へ戻す', (s) =>
    s.replace('<div data-band="optimize-filter" className="flex flex-wrap items-center gap-2">',
      '<div className="flex flex-wrap items-center gap-2 bg-white p-2.5 rounded-lg border shadow-sm shrink-0">')],
  ['PB5', '① 出力のボタンを1つ消す', (s) =>
    s.replace('<Btn onClick={buildPlanExcel} color="bg-emerald-600 hover:bg-emerald-700" icon={FileSpreadsheet}>Excel</Btn>', '')],
  ['PB5', '② 出力を対象月の行の外へ出す', (s) =>
    s.replace('<div data-band="monthly-export"', '<div data-band="monthly-export-2"')],
  ['PB6', '① 「所感」の札を消す', (s) => s.replace('所感 (実績報告書 §8 に記載 — 任意)', '')],
  ['PB7', '② サマリの行に 30px の文字を入れる', (s) =>
    s.replace('<div data-band="scoreboard-summary" className="px-3', '<div data-band="scoreboard-summary" className="text-[30px] px-3')],
  ['PB7', '② サマリの行の文字を 8px へ小さくする', (s) =>
    s.replace('<div data-band="scoreboard-summary" className="px-3', '<div data-band="scoreboard-summary" className="text-[8px] px-3')],
];

test('PB0 🚨 見張り自身の試験: 本物のコードをわざと壊すと、その場で赤になる', () => {
  for (const [id, why, mutate] of BREAKS_FOR_PROOF) {
    const broken = mutate(app);
    assert.notEqual(broken, app, `見本を壊せていない(壊し方が古い): ${id} ${why}`);
    // 壊す前は緑
    CHECKS[id](app);
    // 壊したら赤
    assert.throws(() => CHECKS[id](broken), `${id} は「${why}」を入れても緑のまま = 何も見ていない`);
  }
  assert.equal(BREAKS_FOR_PROOF.length, 16, '壊し方の数が変わっている(減らさない)');
});

for (const [id, fn] of Object.entries(CHECKS)) test(`${id} ${TITLES[id]}`, () => fn(app));
