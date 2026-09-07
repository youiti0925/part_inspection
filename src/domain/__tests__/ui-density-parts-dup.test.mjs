// 🧹 部品検査 分析>人・配分 の帯に「作業者評価」が **2回** 出ていた件の見張り(2026-09-08 / Q2)。
//
// 何があったか(写しを 1366×768 で実測):
//   帯2(data-band="analysis-sub")は
//     [見出しの文字「作業者評価」] [小分類の押せる札「作業者評価」] [小分類の押せる札「直間分析」] [月単位/期間指定]
//   と並んでいた。実測で `作業者評価 / 作業者評価 / 直間分析 / 月単位` の帯が **中身50% / 高さ50px**。
//   同じ言葉が横に2つ並んでいるだけで、押せるのは右の1つだけ。左は飾り。
//
// 直した形(設計 §1 決まり3「1つの物のために行を作らない」/ 清水さん「無駄が多い」):
//   ・残すのは **押せる札の方**(押すと今までどおり作業者評価の中身が出る)。
//   ・見出しは **人のアイコン(絵札)だけ** を残す。絵は消さない。
//   ・文言「作業者評価」は 小分類の札(ANALYSIS_GROUPS の l) と PDF 出力の見出し(title) に在るので
//     ソースから1文字も失っていない。_guard_strings.mjs では **3回→2回** の1件だけが出る(狙いどおり)。
//   ・「直間分析」の札とその行き先(direct-indirect)は **1つも変えていない**。
//
// 🚨 この見張りが守る事:
//   UD1 帯2の worker-eval の見出しに「作業者評価」の文字を戻していない・人のアイコンは残っている
//   UD2 残った方が **押せる札** である(ANALYSIS_GROUPS に l:'作業者評価' が在り、小分類は button で
//       onClick={() => setActiveMode(t.k)} = 行き先が生きている)
//   UD3 「直間分析」の札(l:'直間分析')と行き先(k:'direct-indirect')・その見出しを1つも変えていない
//   UD4 文言を消していない(PDF 出力の title と本文・worker-eval の中身の描画が在る)
//   UD5 帯2の字面に「作業者評価」が **0回**(札は ANALYSIS_GROUPS から出るので、ここに字で書いたら重複が戻る)
// ⚠ コメントは codeOf が落とすので、コメント化で緑にはできない。
// ⚠ UD0 で **本物の App.jsx の控え** をわざと壊し、赤になる事を毎回走らせて確かめる(ソースには1バイトも書かない)。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOf } from './_code.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const app = codeOf(path.resolve(HERE, '..', '..', 'App.jsx'));

// 目印から、その中身(長さを切って)を取り出す。範囲を先に切らないと同名の物を拾う。
const from = (code, marker, len, why) => {
  const at = code.indexOf(marker);
  assert.ok(at > 0, `${why}: 目印 ${marker} がソースに無い`);
  return code.slice(at, at + len);
};

// 出てくる回数を **数える**(在る/無いだけでは「2回出ている」を捕まえられない)。
const times = (hay, needle) => hay.split(needle).length - 1;

// ANALYSIS_GROUPS の「人・配分」の中だけを切り出す。
const peopleGroup = (code) => {
  const at = code.indexOf("{ key: 'people', label: '人・配分', tabs: [");
  assert.ok(at > 0, 'UD2/UD3: ANALYSIS_GROUPS の 人・配分 の組が無い');
  const end = code.indexOf('] },', at);
  assert.ok(end > at, 'UD2/UD3: 人・配分 の組の終わりが読めない');
  return code.slice(at, end);
};

// 帯2(見出し + 小分類 + 絞り込み)の字面。
const band2 = (code) => from(code, 'data-band="analysis-sub"', 4200, 'UD1/UD5');

const CHECKS = {
  UD1: (code) => {
    const band = band2(code);
    const at = band.indexOf("{activeMode === 'worker-eval' &&");
    assert.ok(at > 0, 'UD1: 帯2に worker-eval の見出しの分岐が無い(画面から絵札ごと消えている)');
    const branch = band.slice(at, band.indexOf('}\n', at) + 1);
    // 絵札(人のアイコン)は残す
    assert.ok(/<Users\b/.test(branch), 'UD1: worker-eval の見出しから 人のアイコン(Users)が消えている。絵札は残す');
    // 文字は戻さない(戻すと帯に「作業者評価」が2回並ぶ)
    assert.equal(times(branch, '作業者評価'), 0,
      'UD1: worker-eval の見出しに「作業者評価」の文字が戻っている。帯に2回並ぶので、押せる札の方だけを残す');
  },
  UD2: (code) => {
    const g = peopleGroup(code);
    assert.ok(/\{ k: 'worker-eval', l: '作業者評価',/.test(g),
      'UD2: 押せる札「作業者評価」(ANALYSIS_GROUPS の l)が消えている。残すのは押せる方');
    // 小分類の札が本当に押せる(行き先が生きている)
    const band = band2(code);
    assert.ok(band.includes('activeGroup.tabs.filter('), 'UD2: 帯2に小分類の札の描画が無い');
    assert.ok(/<button key=\{t\.k\} onClick=\{\(\) => setActiveMode\(t\.k\)\}/.test(band),
      'UD2: 小分類の札が button + onClick(setActiveMode) でない = 押しても行き先が無い');
    assert.ok(band.includes('>{t.l}</button>'), 'UD2: 小分類の札に文言(t.l)が出ていない');
    // 管理者だけに出す条件は今までどおり
    assert.ok(/admin: true/.test(g), 'UD2: 作業者評価の「管理者だけ」の印(admin: true)が消えている');
  },
  UD3: (code) => {
    const g = peopleGroup(code);
    assert.ok(/\{ k: 'direct-indirect', l: '直間分析', color: 'text-teal-600' \}/.test(g),
      'UD3: 「直間分析」の札か行き先(direct-indirect)が変わっている。ここは1つも変えない');
    const band = band2(code);
    assert.ok(band.includes("{activeMode === 'direct-indirect' && (<><Activity className=\"w-5 h-5 text-teal-600\"/> 直間分析</>)}"),
      'UD3: 直間分析の見出しが変わっている。今回の直しは worker-eval だけ');
  },
  UD4: (code) => {
    // PDF 出力(文言はここに残っている = 消していない)
    const pdf = from(code, "} else if (activeMode === 'worker-eval') {", 320, 'UD4');
    assert.ok(pdf.includes("title = '作業者評価';"), 'UD4: PDF 出力の見出し「作業者評価」が消えている');
    assert.ok(pdf.includes('作業者評価の詳細レポート出力は現在対応中です。画面を印刷してください。'),
      'UD4: PDF 出力の本文が消えている');
    // 押した先の中身が実在する(押せる札の行き先が真っ白にならない)
    assert.ok(code.includes("{activeMode === 'worker-eval' && (() => {"),
      'UD4: 作業者評価の中身の描画が無い。札を押すと真っ白になる');
  },
  UD5: (code) => {
    assert.equal(times(band2(code), '作業者評価'), 0,
      'UD5: 帯2の字面に「作業者評価」が書かれている。札は ANALYSIS_GROUPS から出るので、ここに書くと重複が戻る');
  },
};

const TITLES = {
  UD1: '見出しは 人のアイコンだけ(「作業者評価」の文字を戻さない)',
  UD2: '残した「作業者評価」は押せる札で、行き先が生きている',
  UD3: '「直間分析」の札と行き先は1つも変えていない',
  UD4: '文言を消していない(PDF 出力の見出し・本文・押した先の中身)',
  UD5: '帯2に「作業者評価」の字が0回(重複が戻っていない)',
};

// ---------------------------------------------------------------------------
// UD0 見張り自身の試験。**本物の App.jsx の控え** をわざと壊して、赤になるか数える。
//   壊し方は3通り: ①直す前の形へ戻す ②行を消す(コメント化と同じ形) ③値を変える
//   🚨 ソースには1バイトも書かない。控え(文字列)の上だけで壊す。
// ---------------------------------------------------------------------------
export const BREAKS_FOR_PROOF = [
  ['UD1', '① 見出しに「作業者評価」の文字を戻す(重複が復活)', (s) =>
    s.replace("{activeMode === 'worker-eval' && (<><Users className=\"w-5 h-5 text-amber-600\"/></>)}",
      "{activeMode === 'worker-eval' && (<><Users className=\"w-5 h-5 text-amber-600\"/> 作業者評価</>)}")],
  ['UD1', '② 見出しの 人のアイコン(絵札)ごと消す', (s) =>
    s.replace("              {activeMode === 'worker-eval' && (<><Users className=\"w-5 h-5 text-amber-600\"/></>)}\n", '')],
  ['UD5', '① 帯2に「作業者評価」を字で書き足す(重複が復活)', (s) =>
    s.replace("{activeMode === 'worker-eval' && (<><Users className=\"w-5 h-5 text-amber-600\"/></>)}",
      "{activeMode === 'worker-eval' && (<><Users className=\"w-5 h-5 text-amber-600\"/> 作業者評価</>)}")],
  ['UD2', '③ 押せる札の方の文言を消す(飾りだけが残る)', (s) =>
    s.replace("{ k: 'worker-eval', l: '作業者評価', color: 'text-amber-600', admin: true },",
      "{ k: 'worker-eval', l: '', color: 'text-amber-600', admin: true },")],
  ['UD2', '② 小分類の札の行き先(onClick)を外す(押しても何も起きない)', (s) =>
    s.replace('<button key={t.k} onClick={() => setActiveMode(t.k)} className=',
      '<button key={t.k} className=')],
  ['UD3', '③ 直間分析の行き先を変える', (s) =>
    s.replace("{ k: 'direct-indirect', l: '直間分析', color: 'text-teal-600' },",
      "{ k: 'di', l: '直間分析', color: 'text-teal-600' },")],
  ['UD3', '② 直間分析の見出しを消す', (s) =>
    s.replace("              {activeMode === 'direct-indirect' && (<><Activity className=\"w-5 h-5 text-teal-600\"/> 直間分析</>)}\n", '')],
  ['UD4', '② PDF 出力の見出しの行を消す', (s) =>
    s.replace("                    title = '作業者評価';\n", '')],
  ['UD4', '② 押した先の中身の描画を消す', (s) =>
    s.replace("{activeMode === 'worker-eval' && (() => {", "{activeMode === 'worker-eval-DELETED' && (() => {")],
];

test('UD0 🚨 見張り自身の試験: 本物のコードをわざと壊すと、その場で赤になる', () => {
  for (const [id, why, mutate] of BREAKS_FOR_PROOF) {
    const broken = mutate(app);
    assert.notEqual(broken, app, `見本を壊せていない(壊し方が古い): ${id} ${why}`);
    CHECKS[id](app);                                   // 壊す前は緑
    assert.throws(() => CHECKS[id](broken), `${id} は「${why}」を入れても緑のまま = 何も見ていない`);
  }
  assert.equal(BREAKS_FOR_PROOF.length, 9, '壊し方の数が変わっている(減らさない)');
});

for (const [id, fn] of Object.entries(CHECKS)) test(`${id} ${TITLES[id]}`, () => fn(app));
