// 🧹 部品検査 分析>③④改善 の カンバン(計画/実施中/効果測定中/完了)が
//    また「中身に関係なく同じ高さ」に戻らない為の見張り(2026-09-08)。
//
// 何があったか(本番・写しの両方で 1366×768 実測):
//   実施中      / 1 / TWA-200 / 片付け / 工程時間(中央値)   … 306px
//   効果測定中  / 0 / なし                                  … 306px  ← 数字1つと「なし」だけ
//   完了        / 0 / なし                                  … 306px  ← 同上
//   計画        / 3 枚                                      … 306px
//   原因は grid の既定 align-items:stretch。**一番多い列の高さに残り3列が引き伸ばされていた**。
//   清水さん「なんで無駄に文字大きくしてスペース使って楽しいの？…無駄にスクロールする」。
//
// 直した形(同じ写しで実測):
//   0枚=74px / 1枚=116px / 3枚=273px。4列は今までどおり横1行(top が4つとも同じ)。
//   カード1枚=72px(押す所は 44px 以上)。−306px×2(空の2列) と −190px(1枚の列)。
//
// 🚨 この見張りが守る事は5つ。全部 **数える**(字面だけを見ない):
//   ① 高さが **件数で変わる** 作りである事(items-start が在る = stretch に戻っていない)
//   ② 空の列の下限(min-h)が 96px 以下である事
//   ③ 1枚あたりの余白が また太っていない事(p-2 / mt-1 / mb-0.5 に戻していない)
//   ④ 列・見出し・件数・「なし」・カードの4つの中身を **1つも消していない** 事(数える)
//   ⑤ 押す物(カード)が 44px 以上で、足した文字が 12px 未満になっていない事
// ⚠ コメント化で緑にできないよう codeOf() でコメントを落としてから見る。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOf } from './_code.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const app = codeOf(path.resolve(HERE, '..', '..', 'App.jsx'));

// 範囲を先に切る(同名の物を拾わない為)。
const board = () => {
  const a = app.indexOf('<div data-band="pdca-kanban"');
  assert.ok(a >= 0, 'カンバンの目印 data-band="pdca-kanban" がソースに無い(画面ごと消えた?)');
  const b = app.indexOf('{openCard &&', a);
  assert.ok(b > a, 'カンバンの終わりが見つからない');
  return app.slice(a, b);
};

test('PK1 🚨 高さが「件数で」変わる作りである(stretch に戻っていない)', () => {
  const b = board();
  // grid は 4列のまま・items-start が在る。これが無いと一番多い列の高さに全列が伸びる。
  assert.match(b, /className="grid grid-cols-1 md:grid-cols-4 gap-2 items-start"/,
    'カンバンの grid が items-start でない = また全列が同じ高さ(306px)に伸びる');
  // 高さを固定する書き方(h-[…] / min-h が中身より高い)を入れていない
  const fixedH = [...b.matchAll(/(?<!min-)(?<!max-)\bh-\[(\d+)px\]/g)].map((x) => Number(x[1]));
  assert.deepEqual(fixedH, [], `列に高さの直書きがある: ${fixedH.join(', ')}(件数で変わらなくなる)`);
  // 列は PDCA_COLS(4つ)から作る = 列を1つも減らしていない
  assert.match(b, /\{PDCA_COLS\.map\(col => \(/, '列を PDCA_COLS から作っていない(列が減った可能性)');
  const cols = (app.match(/const PDCA_COLS = \[([^\]]*)\]/) || [])[1] || '';
  const names = [...cols.matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.deepEqual(names, ['計画', '実施中', '効果測定中', '完了'], `列が ${names.length} 本(4本のはず): ${names.join('/')}`);
});

test('PK2 空の列の下限は 96px 以下(「0」と「なし」の為に 306px を使わない)', () => {
  const b = board();
  const m = b.match(/data-kanban-col=\{col\} className="[^"]*min-h-\[(\d+)px\]/);
  assert.ok(m, '列の min-h が読めない(消したか書き方を変えた)');
  const minH = Number(m[1]);
  assert.ok(minH <= 96, `空の列の下限が ${minH}px(96px 以下のはず)`);
  // 直す前の 120px に戻していない
  assert.ok(!/data-kanban-col=\{col\} className="[^"]*min-h-\[120px\]/.test(b), '列の下限が min-h-[120px] に戻っている');
});

test('PK3 1枚あたりの余白がまた太っていない(必要な高さだけ)', () => {
  const b = board();
  const card = b.slice(b.indexOf('<button key={c.id}'), b.indexOf('</button>'));
  assert.ok(card.length > 0, 'カードの本体が見つからない');
  assert.match(card, /rounded-lg p-1\.5 hover:border-indigo-300/, 'カードの内側の余白が p-1.5 でない(太らせた)');
  assert.ok(!/rounded-lg p-2 hover:border-indigo-300/.test(card), 'カードの余白が p-2 に戻っている');
  // 行の高さを leading-4 で固定している(2行 = 品目コード・工程)
  const leads = [...card.matchAll(/text-xs leading-4/g)].length;
  assert.equal(leads, 2, `カードの中で行の高さを固定している所が ${leads} か所(2か所のはず)`);
  // 判定の行の上の空きは mt-0.5(mt-1 に戻していない)
  assert.match(card, /className="flex items-center gap-1 mt-0\.5 flex-wrap"/, '判定の行の上の空きが mt-0.5 でない');
  assert.ok(!/gap-1\.5 mb-0\.5"><span className=\{`w-2 h-2/.test(card), '1行目の下に mb-0.5 が戻っている');
  // 列の見出しの下も mb-1.5(mb-2 に戻していない)
  assert.match(b, /className="text-xs leading-4 font-bold text-slate-600 mb-1\.5 px-1 flex items-center justify-between"/,
    '列の見出しの余白が mb-1.5 でない');
});

test('PK4 🚨 列・見出し・件数・「なし」・カードの中身を1つも消していない', () => {
  const b = board();
  // 列の名前(見出し)は {col} をそのまま出している
  assert.match(b, /justify-between"\>\{col\}\<span className="text-slate-400"\>\{\(byCol\[col\] \|\| \[\]\)\.length\}/,
    '列の見出し または 件数の数字が消えている');
  // 「なし」の1行(0件の時)は残っている。1回だけ。
  const nashi = [...b.matchAll(/\>なし\</g)].length;
  assert.equal(nashi, 1, `「なし」が ${nashi} か所(1か所のはず)`);
  assert.match(b, /\(byCol\[col\] \|\| \[\]\)\.length === 0 && <div className="text-center text-slate-300 text-xs leading-4 py-1">なし<\/div>/,
    '「なし」の出し方が変わっている(消した/条件を変えた)');
  // カードの4つの中身が全部そろっている
  const card = b.slice(b.indexOf('<button key={c.id}'), b.indexOf('</button>'));
  for (const [why, re] of [
    ['状態の色の丸', /\$\{meta\.dot\}/],
    ['品目コード', /\{c\.model\}/],
    ['工程', /\{c\.stepTitle \|\| c\.stepKey\}/],
    ['主指標', /\{PDCA_KPIS\[c\.kpi\] \|\| PDCA_KPIS\.time\}/],
    ['効果の判定', /\{v && <PdcaVerdictBadge v=\{v\} \/>\}/],
  ]) assert.match(card, re, `カードから「${why}」が消えている`);
  // カードを押すと中身が開く(行き先を切っていない)
  assert.match(card, /onClick=\{\(\) => setOpenId\(c\.id\)\}/, 'カードを押した時の行き先が切れている');
  assert.match(app, /const openCard = \(improvements \|\| \[\]\)\.find\(c => c\.id === openId\)/, 'カードを開く繋ぎが消えている');
});

test('PK5 押す物 44px 以上・足した文字を 12px 未満にしていない', () => {
  const b = board();
  const card = b.slice(b.indexOf('<button key={c.id}'), b.indexOf('</button>'));
  // 実測 72px。字で見張れる下限は「余白 p-1.5(6px×2) + 3行(16+16+14) + わく2」= 60px ≥ 44px。
  const pad = /rounded-lg p-1\.5 /.test(card) ? 6 : NaN;
  const rows = [...card.matchAll(/text-xs leading-4/g)].length;   // 16px の行
  assert.equal(pad, 6, 'カードの余白が読めない(p-1.5 のはず)');
  assert.equal(rows, 2, '16px の行が2本でない');
  const h = pad * 2 + rows * 16 + 14 + 2;                          // 14 = 判定の行, 2 = わく
  assert.ok(h >= 44, `カードの高さの下限が ${h}px(44px 以上のはず)`);
  // 自分が触った所に 12px 未満の直書きを **増やしていない**。
  // ⚠ text-[9px] の札1つは直す前から在る物(アプリ全体で151か所の共通の大きさ)。増やしも減らしもしない。
  const tiny = [...b.matchAll(/text-\[(\d+)px\]/g)].map((x) => Number(x[1])).filter((n) => n < 12);
  // 📏 2026-09-23 9px の札も text-xs(12px)へ大きくした(部品の 12px 未満 900か所を一括で)。0個のまま
  assert.deepEqual(tiny, [], `カンバンの中の 12px 未満の文字が ${tiny.join(', ')}(0個のはず)`);
  // 直す前に在った 11px の2か所は text-xs(12px)へ **大きく** した(小さく戻していない)
  assert.ok(!/text-\[11px\] text-slate-600 truncate/.test(b), 'カードの工程名が 11px に戻っている');
  assert.ok(!/text-slate-300 text-\[11px\] py-2/.test(b), '「なし」が 11px に戻っている');
});
