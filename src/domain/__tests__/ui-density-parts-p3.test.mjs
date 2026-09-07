// 🧹 部品検査「残っていた 中身60%未満の帯 3本」を、また作らない為の見張り(2026-09-08 P3)。
//
// 何があったか(写し・1366×768 の実測。数は全部この目盛りで測った物):
//   ① 作業最適化「品目コード / 品目コードを選択... / 集計 / 過去3ヶ月」  中身36% / 35px
//      帯の幅 1068px に対して 中身は 388px。右に 531px が丸ごと空いていた。
//   ② 分析>人・配分「作業者評価 / 直間分析 / 月単位 / 期間指定」         中身43% / 50px
//      帯の幅 1283px に対して 中身は 552px(41→593px)。右に 732px が丸ごと空いていた。
//   ③ 分析>人・配分「評価データがありません…」                          中身37% / 63px
//      ⚠ これは **直していない**。中身 480px の左に 402px・右に 401px。**左右が同じだけ空いている**
//        = 中央揃えの空の案内で、右だけが余っている「無駄な帯」ではない。
//        測り方(_ui01_survey.mjs)の側に data-centered="1" の印を足して、次から誤って数えないようにした。
//
// 直した形(同じ写しで実測):
//   ① 見出しの2行の説明を ？ へ畳み、「品目コード / 集計」を **見出しと同じ1行の中へ**入れた。
//      見出しの箱 132px → 60px。35px の帯は無くなった。
//   ② 出力(Excel / PDF)を 帯1 の右端(ml-auto)から **帯2 の中へ移し**、
//      中身の一番下に1行だけ在った「指標の意味」も 帯2 の中へ移した。帯2 の中身 43% → 64%。
//      中身の一番下からは 46px の行が1本消えた。
//
// 🚨 この見張りが守る事:
//   P3A 出力(Excel / PDF)は 帯2 の中に在り、ml-auto で右端へ飛ばしていない。押す物・出す条件は元のまま
//   P3B 「指標の意味」は 帯2 の中に在り、畳んだ文は1文字も消えていない。吹き出しは画面の外へ出ない
//   P3C 「品目コード / 集計」は 見出しの1行の中に在り、w-full(専用の1行)に戻っていない
//   P3D 作業最適化の見出しに足した ？ の当たりは 44px 以上(字面ではなく数で出す)
//   P3E 中央揃えの空の案内に data-centered の印が在る(測り方が中央揃えを無駄と数えない為)
// ⚠ コメントは codeOf が落とすので、コメント化で緑にはできない。
// ⚠ P30 で **本物の App.jsx の控え** をわざと壊し、赤になる事を毎回確かめる(ソースには1バイトも書かない)。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOf } from './_code.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const app = codeOf(path.resolve(HERE, '..', '..', 'App.jsx'));

// 範囲を先に切る(同名の物を拾わない為)。
const between = (code, from, to, why) => {
  const a = code.indexOf(from);
  assert.ok(a >= 0, `${why}: 目印 ${from} がソースに無い`);
  const b = code.indexOf(to, a + from.length);
  assert.ok(b > a, `${why}: 終わりの目印 ${to} が見つからない`);
  return code.slice(a, b);
};

// 分析画面のヘッダー(帯1 + 帯2)。
const header = (code) => between(code, '<div data-band="analysis-header"', '<div className="flex-1 overflow-y-auto p-6">', '分析画面のヘッダー');
const band1 = (code) => between(header(code), 'data-band="analysis-top"', 'data-band="analysis-sub"', '帯1');
const band2 = (code) => header(code).slice(header(code).indexOf('data-band="analysis-sub"'));

// ？ の当たり判定(px)を **数で** 出す。
//   box-sizing:border-box。札 w-N h-N = N×4px、わく 1px×2 を引いた内側(padding box)に ::after が乗る。
const hitBox = (summary, why) => {
  const box = Number((summary.match(/\bw-(\d+) h-\1\b/) || [])[1]);
  assert.ok(Number.isFinite(box), `${why}: ？ の札の大きさ(w-N h-N)が読めない`);
  assert.ok(/\bborder(?![-\w])/.test(summary), `${why}: ？ に 1px のわくが無い(内側の大きさが読めない)`);
  const inner = box * 4 - 2;
  const grow = (side) => {
    const m = summary.match(new RegExp(`after:${side}-\\[(-?\\d+)px\\]`));
    assert.ok(m, `${why}: ？ の当たり判定 after:${side}-[…px] が無い`);
    const v = -Number(m[1]);
    assert.ok(v > 0, `${why}: ？ の当たり判定 after:${side} が外へ広がっていない(${m[1]}px)`);
    return v;
  };
  return { w: inner + grow('left') + grow('right'), h: inner + grow('top') + grow('bottom') };
};

// 「指標の意味」の中へ畳んである文。1文でも消えたら赤。
const FOLDED = [
  '評価指標の定義',
  ': 期間内に完了したタスクの所要時間平均。全作業者の平均と比較した％を表示。',
  ': 工程に設定された targetTime 以内に完了したタスクの割合。targetTime 未設定の工程は除外。',
  ': 自動工程 (executionMode=batch or 工程名に「自動」を含む) の合計時間のうち、同じ作業者が別の手動工程を進めていた時間の割合。',
  '※ロット境界を越えて検出 (例: ロットAの自動加工中にロットBの梱包)',
  ': 全作業者中で最速タイムを持つ工程数 / 期間内に NG 判定した件数 (品質意識)。',
  '※ 順位は ',
  ' (速い順)。期間は上部のフィルタで変更可能。',
];

export const CHECKS = {
  // ── P3A 出力(Excel / PDF)は 帯2 の中。右端へ飛ばさない ──
  P3A: (code) => {
    const b1 = band1(code);
    const b2 = band2(code);
    assert.ok(!b1.includes('flex gap-1 border rounded-lg overflow-hidden'),
      '出力(Excel / PDF)が帯1へ戻っている(帯2の右が 732px 空く)');
    assert.ok(b2.includes('<div className="flex gap-1 border rounded-lg overflow-hidden">'),
      '帯2に出力(Excel / PDF)が入っていない');
    assert.ok(!b2.includes('ml-auto flex gap-1 border rounded-lg overflow-hidden'),
      '帯2の出力が ml-auto で右端へ飛んでいる(左に詰めた中身との間が空く)');
    // 押す物と行き先は1つも変えていない
    assert.ok(b2.includes('<FileSpreadsheet className="w-3 h-3"/> Excel</button>'), '帯2から Excel の札が消えている');
    assert.ok(b2.includes('<Printer className="w-3 h-3"/> PDF</button>'), '帯2から PDF の札が消えている');
    assert.ok(b2.includes('setTimeout(() => pw.print(), 500)'), 'PDF の行き先(印刷)が消えている');
    assert.ok(b2.includes('const ExcelJS = await loadExcelJS();'), 'Excel の行き先が消えている');
    // 出す条件(この11個のタブでは出さない)も元のまま
    assert.ok(b2.includes(`{!['monthly', 'dashboard', 'export', 'kpi', 'audit', 'achievement', 'rotary', 'pdca', 'process-analysis', 'anomaly', 'standardize'].includes(activeMode) && (`),
      '出力を出す条件(タブの一覧)が変わっている');
    // 絞り込み(月単位/期間指定)の **すぐ後ろ** に居る = 詰めて置いてある
    const iFilt = b2.indexOf('{renderDefectFilterUI()}');
    const iExp = b2.indexOf('flex gap-1 border rounded-lg overflow-hidden');
    assert.ok(iFilt > 0 && iExp > iFilt, '出力が絞り込みより前に出ている(並びが変わっている)');
  },

  // ── P3B 「指標の意味」は 帯2 の中。文は1文字も消えていない ──
  P3B: (code) => {
    const b2 = band2(code);
    assert.ok(b2.includes('<details data-fold="worker-eval-metrics"'), '「指標の意味」が帯2の中に無い');
    assert.ok(b2.includes(`{activeMode === 'worker-eval' && (`), '「指標の意味」を出す条件(作業者評価の時だけ)が無い');
    // 部品は1つだけ(中身の一番下にも置いて二重に出していない)
    const n = [...code.matchAll(/<details data-fold="worker-eval-metrics"/g)].length;
    assert.equal(n, 1, `「指標の意味」が ${n} か所(1か所のはず)`);
    const det = between(code, '<details data-fold="worker-eval-metrics"', '</details>', '指標の意味');
    for (const s of FOLDED) assert.ok(det.includes(s), `畳んだはずの文が消えている: 「${s}」`);
    // 4つの指標の行が4本そろっている
    const rows = [...det.matchAll(/<div><span className="font-bold text-(blue|emerald|purple|amber)-600">/g)].map((x) => x[1]);
    assert.deepEqual(rows, ['blue', 'emerald', 'purple', 'amber'], `指標の行が ${rows.length} 本(4本のはず)`);
    // 押す所は 44px 以上
    const sum = det.slice(det.indexOf('<summary'), det.indexOf('</summary>'));
    assert.ok(sum.includes('min-h-[2.75rem]'), '「指標の意味」の押す所が 44px 未満');
    // 吹き出しは右端から左へ出す(1366px で画面の外へ出さない)・帯を縦に伸ばさない(absolute)
    const pop = det.slice(det.indexOf('<div className="absolute'), det.indexOf('<div className="absolute') + 220);
    assert.ok(/\bright-0\b/.test(pop), '吹き出しが left-0(左端から右へ)。帯の右端に居るので画面の外へ出る');
    // 🚨 2026-09-08 P4: 上限は max-w-full(= 土台の帯の幅)。calc(100vw-…) へ戻さない。
    //   実測: この画面は data-fs="tables" の中で、文字サイズの設定は zoom で効く。
    //   zoom:1.15 の中では 100vh が 512px の画面で 589px と出た(100% は 512px)。
    //   つまり vw / vh は zoom で一緒に伸びるので「画面より広くしない上限」にならない。
    assert.ok(/\bmax-w-full\b/.test(pop), '吹き出しの幅の上限が max-w-full でない(vw の上限は zoom で伸びて上限にならない)');
    assert.ok(!/max-w-\[calc\(100vw-/.test(pop), '吹き出しの上限が calc(100vw-…) に戻っている(zoom の中では画面より広くなる)');
    assert.ok(/\babsolute\b/.test(pop), '吹き出しが absolute でない(開くと帯が縦に伸びて中身を押し下げる)');
    // 帯の中に 12px 未満の字を作っていない(決まり7)。移す時に 10px → 12px へ大きくした。
    const px = [...b2.matchAll(/text-\[(\d+)px\]/g)].map((x) => Number(x[1]));
    assert.deepEqual(px.filter((v) => v < 12), [], `帯2に 12px 未満の文字がある: ${px.join(', ')}`);
  },

  // ── P3C 「品目コード / 集計」は 見出しと同じ1行の中。専用の1行に戻さない ──
  P3C: (code) => {
    const head = between(code, '<div data-band="optimize-head"', '{!showHistory ? (', '作業最適化の見出しの箱');
    assert.ok(head.includes('data-band="optimize-filter"'), '「品目コード / 集計」が見出しの箱の外に出ている');
    const filt = head.slice(head.indexOf('<div data-band="optimize-filter"'));
    const cls = (filt.match(/className="([^"]*)"/) || [])[1] || '';
    assert.ok(!/\bw-full\b/.test(cls), '「品目コード / 集計」に w-full が戻っている(また専用の1行になり、右が 531px 空く)');
    // 見出し・品目コード・出力の3つが **1つの行の中** に並んでいる
    const row = head.slice(head.indexOf('<div className="flex flex-wrap gap-3 items-center justify-between">'));
    for (const s of ['工程改善・目標時間最適化', 'data-band="optimize-filter"', '最適化提案', '変更履歴']) {
      assert.ok(row.includes(s), `見出しの1行の中に「${s}」が無い(行が分かれている)`);
    }
    // 押す物・文言・順番はそのまま
    for (const s of ['品目コード', '品目コードを選択...', '集計', '過去1ヶ月', '過去3ヶ月', '過去6ヶ月', '全期間', '期間指定', '全工程に一括:']) {
      assert.ok(filt.includes(s), `「${s}」が消えている`);
    }
  },

  // ── P3D 見出しに足した ？ の当たりは 44px 以上。畳んだ説明文は残っている ──
  P3D: (code) => {
    const head = between(code, '<div data-band="optimize-head"', 'data-band="optimize-filter"', '作業最適化の見出しの箱');
    const s = head.indexOf('<summary');
    assert.ok(s > 0, '作業最適化の見出しの ？ が無い(説明文を畳む口が消えている)');
    const sum = head.slice(s, head.indexOf('</summary>', s));
    assert.ok(sum.includes('？'), '？ の札が変わっている');
    const { w, h } = hitBox(sum, '作業最適化の見出しの ？');
    assert.ok(w >= 44 && h >= 44, `？ の当たりが ${w}x${h}px(決まり7 の 44x44px 以上のはず)`);
    // 上へ広げた分が箱に切られない(箱のわく1px + 上の余白 py-N×4px ≥ 上へ広げた px)
    const boxCls = (code.slice(code.indexOf('<div data-band="optimize-head"'), code.indexOf('<div data-band="optimize-head"') + 260).match(/className="([^"]*)"/) || [])[1] || '';
    const pad = Number((boxCls.match(/\bpy-(\d+(?:\.\d+)?)\b/) || [])[1]);
    assert.ok(Number.isFinite(pad), '見出しの箱の上下の余白(py-…)が読めない');
    const up = -Number((sum.match(/after:top-\[(-?\d+)px\]/) || [])[1]);
    assert.ok(1 + pad * 4 >= up, `？ の当たりの上 ${up}px が箱に切られる(わく1px + 余白 ${pad * 4}px しか無い)`);
    // 畳んだ説明2文は1文字も消えていない
    assert.ok(code.includes('実績データからエビデンスを算出し、状況に応じた最適な目標時間を提案します。'), '作業最適化の説明文が消えている');
    assert.ok(code.includes('適用先: 較正した目標時間は<b>新規ロット作成時に自動反映</b>され、ETA・進捗・オススメ順・ガントすべてに使われます'), '「適用先:」の説明文が消えている');
    assert.ok(code.includes('data-fold="optimize-head-howto"'), '説明文を畳む入れ物(？ の吹き出し)が無い');
  },

  // ── P3E 中央揃えの空の案内に印が在る ──
  P3E: (code) => {
    const hint = between(code, 'const EmptyDataHint = ', 'const ProcessAnalysisView =', '空の案内の絵');
    assert.ok(hint.includes('data-centered="1"'),
      '空の案内に data-centered の印が無い(測り方が「中央揃え」を「右が空いた無駄な帯」と数え間違える)');
    assert.ok(/justify-center/.test(hint), '空の案内が中央揃えでない(印と食い違う)');
    // 印だけ付けて中身を太らせていない
    assert.ok(/\bpy-2\b/.test(hint), '空の案内の上下の余白が py-2 でない(また太っている)');
  },
};

const TITLES = {
  P3A: '出力(Excel / PDF)は 帯2 の中・右端へ飛ばさない(押す物と出す条件はそのまま)',
  P3B: '「指標の意味」は 帯2 の中・畳んだ文は1文字も消えていない・吹き出しは画面の外へ出ない',
  P3C: '「品目コード / 集計」は 見出しと同じ1行の中(w-full の専用の行に戻さない)',
  P3D: '作業最適化の見出しの ？ の当たりは 44px 以上(数で出す)',
  P3E: '中央揃えの空の案内には data-centered の印が在る',
};

// ---------------------------------------------------------------------------
// P30 見張り自身の試験。**本物の App.jsx の控え** をわざと壊して、赤になるか数える。
//   壊し方は3通り: ①行を消す(コメント化と同じ形) ②値を変える ③直す前の形へ戻す
//   🚨 ソースには1バイトも書かない。控え(文字列)の上だけで壊す。
// ---------------------------------------------------------------------------
export const BREAKS_FOR_PROOF = [
  ['P3A', '③ 出力を帯1の右端(ml-auto)へ戻す', (s) => {
    const open = '<div className="flex gap-1 border rounded-lg overflow-hidden">';
    const i = s.indexOf(open);
    const j = s.indexOf('</div>\n              )}\n', i);
    const block = s.slice(i, j);
    const anchor = '<div className="flex bg-slate-200 p-1 rounded-lg flex-wrap">';
    return s.slice(0, i) + s.slice(j)
      .replace(anchor, `${block.replace(open, '<div className="ml-auto flex gap-1 border rounded-lg overflow-hidden">')}</div>\n${anchor}`);
  }],
  ['P3A', '② 出力を ml-auto で右端へ飛ばす', (s) =>
    s.replace('<div className="flex gap-1 border rounded-lg overflow-hidden">',
      '<div className="ml-auto flex gap-1 border rounded-lg overflow-hidden">')],
  ['P3A', '① PDF の札を消す', (s) => s.replace('<Printer className="w-3 h-3"/> PDF</button>', '</button>')],
  ['P3B', '① 「指標の意味」を帯2から消す', (s) => {
    const i = s.indexOf('<details data-fold="worker-eval-metrics"');
    const j = s.indexOf('</details>', i) + '</details>'.length;
    return s.slice(0, i) + s.slice(j);
  }],
  ['P3B', '① 畳んだ説明文を1文消す', (s) =>
    s.replace('※ロット境界を越えて検出 (例: ロットAの自動加工中にロットBの梱包)', '')],
  ['P3B', '③ 吹き出しを left-0 へ戻す(画面の外へ出る)', (s) =>
    s.replace('<div className="absolute right-0 top-full mt-1 z-30 w-[420px] max-w-full',
      '<div className="absolute left-0 top-full mt-1 z-30 w-[420px]')],
  ['P3B', '③ 幅の上限を calc(100vw-3rem) へ戻す(zoom の中では画面より広くなる)', (s) =>
    s.replace('w-[420px] max-w-full', 'w-[420px] max-w-[calc(100vw-3rem)]')],
  ['P3B', '② 帯2に 10px の字を戻す(決まり7 の 12px 割れ)', (s) =>
    s.replace('<div className="text-xs text-slate-400 mt-2">※ 順位は ',
      '<div className="text-[10px] text-slate-400 mt-2">※ 順位は ')],
  ['P3C', '③ 「品目コード / 集計」を w-full の専用の行へ戻す', (s) =>
    s.replace('<div data-band="optimize-filter" className="flex flex-wrap items-center gap-2">',
      '<div data-band="optimize-filter" className="flex flex-wrap items-center gap-2 w-full">')],
  ['P3C', '① 「集計」の札を消す', (s) =>
    s.replace('<span className="text-xs font-bold text-slate-500 ml-1">集計</span>', '')],
  ['P3D', '① 見出しの ？ の当たり判定の指定を消す', (s) =>
    s.replace('after:top-[-12px] after:bottom-[-12px] after:left-[-12px] after:right-[-12px]', '')],
  ['P3D', '② 見出しの ？ の当たりを 前後 10px(=42px) へ小さくする', (s) =>
    s.replace('after:top-[-12px] after:bottom-[-12px] after:left-[-12px] after:right-[-12px]',
      'after:top-[-10px] after:bottom-[-10px] after:left-[-10px] after:right-[-10px]')],
  ['P3D', '② 見出しの箱の上の余白を py-1 へ削る(？ の当たりの上が箱に切られる)', (s) =>
    s.replace('<div data-band="optimize-head" className="bg-white px-4 py-3',
      '<div data-band="optimize-head" className="bg-white px-4 py-1')],
  ['P3D', '① 畳んだ「適用先:」の説明文を消す', (s) =>
    s.replace('適用先: 較正した目標時間は<b>新規ロット作成時に自動反映</b>され、ETA・進捗・オススメ順・ガントすべてに使われます', '')],
  ['P3E', '① 中央揃えの印を消す', (s) => s.replace(' data-centered="1"', '')],
];

test('P30 🚨 見張り自身の試験: 本物のコードをわざと壊すと、その場で赤になる', () => {
  for (const [id, why, mutate] of BREAKS_FOR_PROOF) {
    const broken = mutate(app);
    assert.notEqual(broken, app, `見本を壊せていない(壊し方が古い): ${id} ${why}`);
    CHECKS[id](app);                                   // 壊す前は緑
    assert.throws(() => CHECKS[id](broken), `${id} は「${why}」を入れても緑のまま = 何も見ていない`);
  }
  assert.equal(BREAKS_FOR_PROOF.length, 15, '壊し方の数が変わっている(減らさない)');
});

for (const [id, fn] of Object.entries(CHECKS)) test(`${id} ${TITLES[id]}`, () => fn(app));
