// 🧹 部品検査 Q1「中身の少ない横帯を2本、隣の行へ入れて減らした」を戻させない為の見張り(2026-09-08)。
//
// 何があったか(写し・エミュレータ・1366×768 で実測。設計_画面の無駄を全部なくす_2026-09-07.md の 決まり1〜3):
//   画面            帯                                                            中身   高さ
//   検査リスト      「検査リスト / 完了履歴」(親タブだけの帯)                      15%   39px
//   分析>②現状を見る「出力: / PDF(A4 1枚) / PDF(詳細) / Excel(グラフ入り)」        32%   38px
//
// 直した形(同じ写しで測り直した。前 → 後):
//   検査リスト   帯2本(39px + 163px)          → 1本(159px)   … 親タブを絞り込みの行の**左端**へ入れた   −43px
//   分析>②      見出しの箱 112px(中に 38px)  → 96px          … 出力を見出しの箱の**右端**へ入れた       −16px
//   合計 −59px。中身が60%未満の帯は この2画面から 0本 になった。
//
// 🚨 消した物は1つも無い。札の名前・順番・押した時の行き先(setActiveTab / printReport / exportExcel)は そのまま。
//
// 🚨 この見張りが守る事:
//   Q1 親タブ(検査リスト|完了履歴)は 絞り込みの行の中の**左端**に在る(親タブだけの帯を作り直さない)
//   Q2 出力の3つのボタンは 工程分析の見出しの箱の中に在る(w-full の2行目を専有する帯へ戻さない)
//   Q3 狭い画面(1024px以下)で、親タブを畳んだ <details> の中へ閉じ込めない(完了履歴へ行く道を切らない)
//      + 完了履歴の画面では 今までどおり上の帯を出す(戻る道を切らない)
//   Q4 移した押す物の行き先(関数)が1つも変わっていない
//   Q5 移した文言が1つも消えていない・12px 未満の字を新しく足していない・26px 以上の字を作らない
// ⚠ コメントは codeOf が落とすので、コメント化で緑にはできない。
// ⚠ Q0 で **本物の App.jsx の控え** をわざと壊し、赤になる事を毎回走らせて確かめる(ソースには1バイトも書かない)。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOf } from './_code.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const app = codeOf(path.resolve(HERE, '..', '..', 'App.jsx'));

const count = (s, code) => code.split(s).length - 1;
const bands = (name, code) => count(`<div data-band="${name}"`, code);

// 目印を含む <div …> から、その div が閉じる所までを切り出す。
// ⚠ 範囲を先に切らないと、同じ文言が別の場所に在るだけで緑になってしまう。
//   自分で閉じる <div … /> は数に入れない(区切り線がこの形)。
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

// 🚨 移した文言。1つでも消えたら赤。
const KEEP = [
  '検査リスト',
  '完了履歴',
  'エリア:',
  '並び替え:',
  '詳細フィルタ',
  '工程分析',
  '取ったデータをそのまま見る（直近1年）',
  '品目コード',
  'テンプレ',
  '全テンプレ',
  '出力:',
  'PDF(A4 1枚)',
  'PDF(詳細)',
  'Excel(グラフ入り)',
  '生成中…',
];

// 🚨 合体した帯の中に在る「12px 未満の字」の一覧(2026-09-08 に実測して控えた)。
//   前から在る物をそのまま移しただけ。**これ以上 小さくしない・新しく足さない** を Q5 が数で見る。
const Q5_SMALL = {
  '絞り込みの行': [10, 10, 10, 10],
  '工程分析の見出しの箱': [11],
  '出力の一群': [11],
};

export const CHECKS = {
  // ── Q1 親タブは絞り込みの行の中の左端に在る ──
  Q1: (code) => {
    assert.equal(bands('inspection-filter', code), 1, '絞り込みの行の目印が1つでない');
    const row = elementSlice('data-band="inspection-filter"', code);
    has(row, '{!narrow && parentTabsEl && (<>{parentTabsEl}', '親タブが絞り込みの行の中に無い');
    has(row, 'エリア:', '絞り込みの行のエリアの札');
    has(row, '詳細フィルタ', '絞り込みの行の詳細フィルタ');
    // 左端に置く(エリア: より前)
    assert.ok(row.indexOf('parentTabsEl') < row.indexOf('エリア:'), '親タブが絞り込みの行の左端に無い');
    // 上の帯は 検査リストの時だけ返さない(合流先がその画面に必ず在るから)
    has(code, "if (activeTab === 'inspection') return null;", '上の帯が検査リストでも出たまま(帯が2本に戻っている)');
    // 親タブの作り方は1か所のまま。画面側で作り直していない(名前・順番・行き先が割れる)
    has(code, 'parentTabs={renderTabGroupButtons(TAB_GROUPS.inspection)}', '検査リストへ親タブを渡していない');
    assert.equal(count("{ id: 'history', label: '完了履歴'", code), 1, '完了履歴の札の作り方が2か所以上ある');
    // 親タブだけの専用の帯を、この画面へ作り直していない
    assert.ok(!code.includes('<div data-band="inspection-tabs-only"'), '親タブだけの専用の帯が戻っている');
  },

  // ── Q2 出力の3つのボタンは 工程分析の見出しの箱の中 ──
  Q2: (code) => {
    assert.equal(bands('proc-analysis-head', code), 1, '工程分析の見出しの箱の目印が1つでない');
    assert.equal(bands('proc-export', code), 1, '出力の一群の目印が1つでない');
    const head = elementSlice('data-band="proc-analysis-head"', code);
    has(head, '取ったデータをそのまま見る（直近1年）', '見出しの箱の題');
    has(head, '品目コード', '品目コードの選び口');
    has(head, 'data-band="proc-export"', '出力が見出しの箱の外に出ている(帯が1本増える)');
    const exp = elementSlice('data-band="proc-export"', code);
    has(exp, '出力:', '出力の札');
    for (const s of ['PDF(A4 1枚)', 'PDF(詳細)', 'Excel(グラフ入り)']) has(exp, s, '出力の札');
    assert.equal((exp.match(/<button /g) || []).length, 3, '出力のボタンが3つでない');
    // 出力だけの帯(w-full で2行目を丸ごと専有する形)へ戻していない
    assert.ok(!code.includes('flex items-center gap-1.5 w-full justify-end border-t border-blue-100 pt-2'),
      '「出力:」だけの専用の帯(w-full)が戻っている');
    const expCls = (exp.match(/className="([^"]*)"/) || [])[1] || '';
    assert.ok(!/\bw-full\b/.test(expCls), '出力の一群がまた w-full で行を丸ごと使っている');
  },

  // ── Q3 狭い画面でも、完了履歴へ行く道・戻る道を切らない ──
  Q3: (code) => {
    assert.equal(bands('inspection-tabs-narrow', code), 1, '狭い画面用の親タブの置き場が1つでない');
    // 畳む入れ物(NarrowFold)より **前** に出す。中へ入れると、閉じている間 押せなくなる。
    const narrowAt = code.indexOf('data-band="inspection-tabs-narrow"');
    const foldAt = code.indexOf('<NarrowFold', code.indexOf('const InspectionListView'));
    assert.ok(narrowAt > 0 && foldAt > 0, '狭い画面用の置き場か NarrowFold が見つからない');
    assert.ok(narrowAt < foldAt, '狭い画面の親タブが <details> の中に入っている(閉じている間 完了履歴へ行けない)');
    // 広い時と狭い時で、必ずどちらか一方が出る(両方消える書き方にしない)
    has(code, '{narrow && parentTabsEl &&', '狭い画面で親タブを出す条件が無い');
    has(code, '{!narrow && parentTabsEl &&', '広い画面で親タブを出す条件が無い');
    // 完了履歴の画面では 今までどおり上の帯を出す(戻る道)
    assert.ok(!code.includes("if (activeTab === 'history') return null;"),
      '完了履歴でも上の帯を返さなくしている(検査リストへ戻る道が消える)');
    has(code, "const TAB_PARENT = { inspection: 'inspection', history: 'inspection'", '完了履歴が検査リストの親タブに紐付いていない');
  },

  // ── Q4 押した時の行き先が1つも変わっていない ──
  Q4: (code) => {
    const exp = elementSlice('data-band="proc-export"', code);
    has(exp, 'onClick={() => printReport(false)}', 'PDF(A4 1枚) の行き先');
    has(exp, 'onClick={() => printReport(true)}', 'PDF(詳細) の行き先');
    has(exp, 'onClick={exportExcel}', 'Excel(グラフ入り) の行き先');
    // 親タブの行き先は renderTabGroupButtons の中の setActiveTab 1か所
    const mk = code.slice(code.indexOf('const renderTabGroupButtons ='), code.indexOf('const renderTabGroupButtons =') + 600);
    has(mk, 'onClick={() => setActiveTab(s.id)}', '親タブの行き先(setActiveTab)');
    // 札の順番(検査リスト → 完了履歴)を入れ替えていない
    const grp = code.slice(code.indexOf('const TAB_GROUPS = {'), code.indexOf('const TAB_PARENT = '));
    assert.ok(grp.indexOf("label: '検査リスト'") < grp.indexOf("label: '完了履歴'"), '親タブの順番が入れ替わっている');
  },

  // ── Q5 文言・文字の大きさ ──
  Q5: (code) => {
    const gone = KEEP.filter((s) => !code.includes(s));
    assert.deepEqual(gone, [], `消えた文言がある: ${gone.join(' / ')}`);
    // 合流させた親タブは、区画の文字サイズ(data-fs="tables" 70〜160%)で伸び縮みさせない。
    //   打ち消さないと 70% で 14px → 9.8px になり 決まり7(文字 12px 以上)を割る。
    const el = code.slice(code.indexOf('const parentTabsEl = '), code.indexOf('const parentTabsEl = ') + 200);
    has(el, 'data-fs-reset="1"', '合流させた親タブに、区画の文字サイズを打ち消す印(data-fs-reset)が無い');
    has(el, '{parentTabs}', '親タブの中身が入っていない');
    const slices = {
      '絞り込みの行': elementSlice('data-band="inspection-filter"', code),
      '工程分析の見出しの箱': elementSlice('data-band="proc-analysis-head"', code),
      '出力の一群': elementSlice('data-band="proc-export"', code),
    };
    for (const [name, s] of Object.entries(slices)) {
      const px = [...s.matchAll(/text-\[(\d+)px\]/g)].map((m) => Number(m[1]));
      assert.deepEqual(px.filter((n) => n < 12).sort((a, b) => a - b), Q5_SMALL[name],
        `${name} の 12px 未満の文字が変わっている(小さくした・新しく足した)`);
      assert.deepEqual(px.filter((n) => n >= 26), [], `${name} に 26px 以上の直書きがある`);
      const big = [...s.matchAll(/text-(3xl|4xl|5xl|6xl)\b/g)].map((m) => m[0]);
      assert.deepEqual(big, [], `${name} に大きすぎる文字がある: ${big.join(', ')}`);
    }
  },
};

const TITLES = {
  Q1: '親タブ(検査リスト|完了履歴)は 絞り込みの行の左端に在る(親タブだけの帯を作らない)',
  Q2: '出力の3つのボタンは 工程分析の見出しの箱の中に在る(2行目を専有する帯へ戻さない)',
  Q3: '狭い画面でも 完了履歴へ行く道・戻る道を切らない',
  Q4: '移した押す物の行き先(関数)と順番が1つも変わっていない',
  Q5: '移した文言が1つも消えていない・文字を小さくも大きくもしていない',
};

// ---------------------------------------------------------------------------
// Q0 見張り自身の試験。**本物の App.jsx の控え** をわざと壊して、赤になるか数える。
//   壊し方は3通り: ①行を消す(＝コメント化と同じ形) ②値を変える ③直す前の形へ戻す
//   🚨 ソースには1バイトも書かない。控え(文字列)の上だけで壊す。
// ---------------------------------------------------------------------------
export const BREAKS_FOR_PROOF = [
  ['Q1', '③ 上の帯を検査リストでも出す(帯が2本に戻る)', (s) =>
    s.replace("if (activeTab === 'inspection') return null;", '')],
  ['Q1', '① 絞り込みの行から親タブを外す', (s) =>
    s.replace('{!narrow && parentTabsEl && (<>{parentTabsEl}<div className="h-7 w-px bg-slate-300 shrink-0" /></>)}', '')],
  ['Q1', '① 検査リストへ親タブを渡すのをやめる', (s) =>
    s.replace(' parentTabs={renderTabGroupButtons(TAB_GROUPS.inspection)}', '')],
  ['Q1', '② 絞り込みの行の目印の名前を変える(合体先が分からなくなる)', (s) =>
    s.replace('<div data-band="inspection-filter"', '<div data-band="inspection-filter-2"')],
  ['Q2', '③ 出力を w-full の2行目の帯へ戻す', (s) =>
    s.replace('<div data-band="proc-export" className="flex items-center gap-1.5 flex-wrap">',
      '<div data-band="proc-export" className="flex items-center gap-1.5 w-full justify-end border-t border-blue-100 pt-2">')],
  ['Q2', '① 出力のボタンを1つ消す', (s) =>
    s.replace('<button onClick={() => printReport(true)} className="px-2.5 py-1 text-xs font-bold rounded border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 flex items-center gap-1"><Printer className="w-3.5 h-3.5" /> PDF(詳細)</button>', '')],
  ['Q2', '② 出力を見出しの箱の外へ出す', (s) =>
    s.replace('<div data-band="proc-export"', '<div data-band="proc-export-2"')],
  ['Q3', '① 狭い画面用の置き場を消す(畳んだ中でしか押せなくなる)', (s) =>
    s.replace('{narrow && parentTabsEl && <div data-band="inspection-tabs-narrow" className="shrink-0 flex items-center gap-1">{parentTabsEl}</div>}', '')],
  ['Q3', '③ 完了履歴でも上の帯を返さなくする(戻る道が消える)', (s) =>
    s.replace("if (activeTab === 'inspection') return null;",
      "if (activeTab === 'inspection') return null;\n           if (activeTab === 'history') return null;")],
  ['Q4', '② PDF(A4 1枚) の行き先を差し替える', (s) =>
    s.replace('onClick={() => printReport(false)}', 'onClick={() => printReport(true)}')],
  ['Q4', '② 親タブの順番を入れ替える', (s) =>
    s.replace("{ id: 'inspection', label: '検査リスト', icon: ListChecks },\n       { id: 'history', label: '完了履歴', icon: CheckSquare },",
      "{ id: 'history', label: '完了履歴', icon: CheckSquare },\n       { id: 'inspection', label: '検査リスト', icon: ListChecks },")],
  ['Q5', '① 「Excel(グラフ入り)」の文言を消す', (s) => s.replace("'Excel(グラフ入り)'", "''")],
  ['Q5', '① 合流させた親タブから 文字サイズの打ち消しの印を外す', (s) =>
    s.replace('<div data-fs-reset="1" className="flex items-center gap-1 shrink-0">{parentTabs}</div>',
      '<div className="flex items-center gap-1 shrink-0">{parentTabs}</div>')],
  ['Q5', '② 出力の一群に 9px の字を新しく足す(決まり7 の 12px 割れ)', (s) =>
    s.replace('<div data-band="proc-export" className="flex items-center gap-1.5 flex-wrap">',
      '<div data-band="proc-export" className="text-[9px] flex items-center gap-1.5 flex-wrap">')],
  ['Q5', '② 見出しの箱に 30px の字を入れる', (s) =>
    s.replace('<div data-band="proc-analysis-head" className="bg-blue-50',
      '<div data-band="proc-analysis-head" className="text-[30px] bg-blue-50')],
];

test('Q0 🚨 見張り自身の試験: 本物のコードをわざと壊すと、その場で赤になる', () => {
  for (const [id, why, mutate] of BREAKS_FOR_PROOF) {
    const broken = mutate(app);
    assert.notEqual(broken, app, `見本を壊せていない(壊し方が古い): ${id} ${why}`);
    CHECKS[id](app);                                   // 壊す前は緑
    assert.throws(() => CHECKS[id](broken), `${id} は「${why}」を入れても緑のまま = 何も見ていない`);
  }
  assert.equal(BREAKS_FOR_PROOF.length, 15, '壊し方の数が変わっている(減らさない)');
});

for (const [id, fn] of Object.entries(CHECKS)) test(`${id} ${TITLES[id]}`, () => fn(app));
