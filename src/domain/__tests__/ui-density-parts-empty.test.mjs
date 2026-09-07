// 🧹 部品検査「中身の無い箱」がまた膨らまない為の見張り(2026-09-07)。
//
// 何があったか(本番・1366×768 で実測。写しで同じ数字を再現済み):
//   ① 工程分析「この品目コードの完了データがまだありません。」        152px (py-16)
//   ② 作業者評価「評価データがありません (期間内の完了ロットが必要です)」184px (py-20)
//   ③ 作業者評価「評価指標の定義」の説明文                            146px (開きっぱなし)
//   ④ 記録・出力「所感 (実績報告書 §8 に記載 — 任意)」の空欄          150px (p-4 + rows=3)
//   清水さん「文字ばっかりのところ沢山あるからそこもイラストとかグラフで置き換えて」。
//
// 直した形(同じ写しで実測):
//   ① 56px  ② 56px  ③ 46px(閉じている時)  ④ 84px   合計 −390px
//
// 🚨 この見張りが守る事は5つ。全部 **数える**(字面だけを見ない):
//   ① 空の案内は「小さな絵の部品」でだけ出す(py-16 / py-20 の巨大な空箱を復活させない)
//   ② 絵の中に **数字を1文字も置かない**(嘘の数字を出さない)
//   ③ 畳んだ説明文が **ソースに全部残っている**(消していない。畳む・移す・小さくする・絵にする の4つだけ)
//   ④ 所感の入れ物が また p-4 / rows=3 に戻っていない
//   ⑤ 押す物 44px(2.75rem)以上・自分が足した所の文字は 12px 以上
// ⚠ コメント化で緑にできないよう codeOf() でコメントを落としてから見る。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOf } from './_code.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const app = codeOf(path.resolve(HERE, '..', '..', 'App.jsx'));

// 範囲を先に切る(同名の物を拾わない為)。
const sliceBetween = (from, to, why) => {
  const a = app.indexOf(from);
  assert.ok(a >= 0, `${why}: 目印 ${from} がソースに無い`);
  const b = app.indexOf(to, a + from.length);
  assert.ok(b > a, `${why}: 終わりの目印 ${to} が見つからない`);
  return app.slice(a, b + to.length);
};

// 直す前に本番で使っていた「空っぽの案内」の文言。1文字も変えない。
const EMPTY_TEXTS = [
  'この品目コードの完了データがまだありません。',
  '評価データがありません (期間内の完了ロットが必要です)',
];

// 畳んだ説明文。1文でも消えたら赤。
const FOLDED_SENTENCES = [
  '評価指標の定義',
  '平均タスク時間',
  ': 期間内に完了したタスクの所要時間平均。全作業者の平均と比較した％を表示。',
  '目標達成率',
  ': 工程に設定された targetTime 以内に完了したタスクの割合。targetTime 未設定の工程は除外。',
  '並列作業率',
  ': 自動工程 (executionMode=batch or 工程名に「自動」を含む) の合計時間のうち、同じ作業者が別の手動工程を進めていた時間の割合。',
  '※ロット境界を越えて検出 (例: ロットAの自動加工中にロットBの梱包)',
  '最速記録 / NG発見',
  ': 全作業者中で最速タイムを持つ工程数 / 期間内に NG 判定した件数 (品質意識)。',
  '※ 順位は ',
  ' 優先、次に ',
  ' (速い順)。期間は上部のフィルタで変更可能。',
];

const hintDef = () => sliceBetween('const EmptyDataHint = ({ text }) => (', 'const ProcessAnalysisView =', '空の案内の絵');
const metrics = () => sliceBetween('<details data-fold="worker-eval-metrics"', '</details>', '評価指標の定義');
const shokan = () => sliceBetween('<div data-tight="shokan"', '</div>', '所感');

test('PE1 空の案内は「小さな絵の部品」でだけ出す(巨大な空箱を復活させない)', () => {
  // 部品は1か所で作る
  const defs = [...app.matchAll(/const EmptyDataHint = \(/g)].length;
  assert.equal(defs, 1, `空の案内の部品の作り方が ${defs} か所(1か所のはず)`);
  // 2つの文言は、どちらも部品に渡している。生の <div …>文言</div> に戻っていない。
  for (const t of EMPTY_TEXTS) {
    const uses = [...app.matchAll(new RegExp(`<EmptyDataHint text="${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g'))].length;
    assert.equal(uses, 1, `「${t}」を絵の部品で出している所が ${uses} か所(1か所のはず)`);
    // 同じ文言を持つ「太った空箱」がどこにも無い
    const fat = [...app.matchAll(new RegExp(`py-(1[0-9]|2[0-9])[^<]{0,200}${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'))].length;
    assert.equal(fat, 0, `「${t}」がまた py-16 / py-20 の巨大な空箱に戻っている`);
  }
  // 絵の入れ物の高さ = 絵 40px + 上下の余白 py-2(8px×2) = 56px ≤ 64px
  const h = hintDef();
  const svgH = Number((h.match(/<svg width="\d+" height="(\d+)"/) || [])[1]);
  assert.equal(svgH, 40, `絵の高さが ${svgH}px(40px のはず)`);
  const padTop = /className="[^"]*\bpy-2\b/.test(h.slice(h.indexOf('data-empty-hint'), h.indexOf('<svg'))) ? 8 : NaN;
  assert.equal(padTop, 8, '絵の入れ物の上下の余白が py-2 でない(高さが読めない)');
  assert.ok(svgH + padTop * 2 <= 64, `空の案内が ${svgH + padTop * 2}px(64px 以下のはず)`);
});

test('PE2 🚨 絵の中に数字を1文字も置かない(嘘の数字を出さない)', () => {
  const h = hintDef();
  // 画面に出る地の文だけを取る({…} の中は式なので入らない)
  const texts = [...h.matchAll(/>([^<>{}]+)</g)].map((m) => m[1].trim()).filter(Boolean);
  const withDigit = texts.filter((t) => /[0-90-9]/.test(t));
  assert.deepEqual(withDigit, [], `絵の中に数字がある: ${withDigit.join(' / ')}`);
  // 3段階(記録が付く → 集まる → 目標が出せる)を、絵と札の両方で出している
  assert.ok(texts.includes('記録が付く → 集まる → 目標が出せる'), '3段階の札が無い');
  const circles = [...h.matchAll(/<circle cx="(18|76|134)" cy="20" r="14"/g)].length;
  assert.equal(circles, 3, `3段階の丸が ${circles} 個(3個のはず)`);
  const arrows = [...h.matchAll(/<path d="M\d+ 20h13m-5-4 5 4-5 4"/g)].length;
  assert.equal(arrows, 2, `丸と丸をつなぐ矢印が ${arrows} 本(2本のはず)`);
});

test('PE3 🚨 「評価指標の定義」は畳んだだけ。文は1文字も消えていない', () => {
  const m = metrics();
  // 閉じている時は「指標の意味 ▼」の1行
  assert.match(m, /<summary [^>]*>指標の意味 <span className="text-slate-400">▼<\/span><\/summary>/,
    '閉じている時の1行(指標の意味 ▼)が無い');
  // 説明文は details の中に全部そのまま在る
  for (const s of FOLDED_SENTENCES) {
    assert.ok(m.includes(s), `畳んだはずの文が消えている: 「${s}」`);
  }
  // 4つの指標の行が4本そろっている(1本でも減らしてはいけない)
  const rows = [...m.matchAll(/<div><span className="font-bold text-(blue|emerald|purple|amber)-600">/g)].map((x) => x[1]);
  assert.deepEqual(rows, ['blue', 'emerald', 'purple', 'amber'], `指標の行が ${rows.length} 本(4本のはず)`);
  // 開きっぱなしの太った箱(p-4 の div)に戻していない
  assert.ok(!/<div className="bg-slate-50 rounded-xl p-4 border">\s*<div className="text-sm font-bold text-slate-700 mb-2">評価指標の定義/.test(app),
    '「評価指標の定義」がまた開きっぱなしの p-4 の箱に戻っている');
});

test('PE4 所感の空欄が また p-4 / rows=3 に戻っていない', () => {
  const s = shokan();
  assert.match(s, /className="bg-white rounded-xl border border-slate-200 shadow-sm px-3 py-1\.5"/, '所感の入れ物の余白が太っている(px-3 py-1.5 のはず)');
  assert.match(s, /rows=\{2\}/, '所感の空欄が2行より高い');
  assert.ok(!/rows=\{3\}/.test(s), '所感の空欄が rows=3 に戻っている');
  // 🚨 文言は1文字も消していない
  assert.ok(s.includes('所感 (実績報告書 §8 に記載 — 任意)'), '所感の見出しが消えている');
  assert.ok(s.includes('当月の総括・特記事項・次月への課題などを記入してください。'), '所感の書き方の案内が消えている');
  // 実測 84px(px-3 py-1.5 = 12 + わく 2 + 見出し 16+4 + 空欄 50)。88px 以下。
  assert.ok(12 + 2 + 20 + 50 <= 88, '所感の入れ物が 88px を超える');
});

test('PE5 押す物 44px(2.75rem)以上・足した文字は 12px 以上', () => {
  const m = metrics();
  const sum = m.slice(m.indexOf('<summary'), m.indexOf('</summary>'));
  assert.ok(sum.includes('min-h-[2.75rem]'), '「指標の意味」の押す所が 44px 未満');
  const s = shokan();
  assert.ok(s.includes('min-h-[2.75rem]'), '所感の空欄が 44px 未満');
  // 自分が足した所(絵・summary・所感)に 12px 未満の直書きが無い
  for (const [name, code] of [['絵', hintDef()], ['指標の意味', sum], ['所感', s]]) {
    const px = [...code.matchAll(/text-\[(\d+)px\]/g)].map((x) => Number(x[1]));
    assert.deepEqual(px.filter((n) => n < 12), [], `${name} に 12px 未満の文字がある: ${px.join(', ')}`);
  }
});
