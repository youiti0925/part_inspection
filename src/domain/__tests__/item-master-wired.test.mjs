// 🏷 品目名簿 (品目コード → 品名) の **配線** の見張り(部品検査・2026-09-21)。純関数の見張りは itemMaster.test.mjs。
//   🚨 直す前は settings.itemMaster を読む所が3箇所あるのに **書く所が1つも無かった**。
//      名簿が「在るのに永久に空」に戻らないよう、書く画面が在る事をここで固定する。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOf } from './_code.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '..', 'App.jsx');
const app = codeOf(APP);

// 画面の本体だけを切り出す (後ろの別の部品を巻き込まないため)
const panelStart = app.indexOf('const ItemMasterPanel = (');
const panel = panelStart < 0 ? '' : app.slice(panelStart, app.indexOf('\nconst ModelGroupManager = (', panelStart));

// 画面の中で使っている class のまとめ(const BTN = '…')を、実際の中身へ広げてから見る。
// ⚠ ここを広げずに文字で見ると、まとめの中身を空にしても緑のままになる
//   (2026-09-19 に「見張りが if 文を文字で見ていて 0本でも緑」の事故が在った)。
const classConsts = {};
for (const m of panel.matchAll(/const ([A-Z][A-Z0-9_]*) = '([^']*)';/g)) classConsts[m[1]] = m[2];
const expanded = panel.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (all, k) => (k in classConsts ? classConsts[k] : all));

// 開始タグを丸ごと切り出す。
// ⚠ /<button[\s\S]*?>/ は使えない。onClick={() => …} の矢印の > で切れてしまう
//   (2026-09-19 に同じ形の見張りが空振りした)。{} の深さが0の > だけをタグの終わりと見る。
function openTags(src, name) {
  const out = [];
  let i = 0;
  for (;;) {
    const s = src.indexOf('<' + name, i);
    if (s < 0) break;
    let depth = 0;
    let j = s;
    for (; j < src.length; j += 1) {
      const c = src[j];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '>' && depth === 0) break;
    }
    out.push(src.slice(s, j + 1));
    i = j + 1;
  }
  return out;
}

test('IW-1 名簿を書く画面が在り、マスタ設定から実際に描かれている', () => {
  assert.ok(panelStart >= 0, '品目名簿の画面(ItemMasterPanel)が無い');
  assert.match(
    app,
    /<ItemMasterPanel lots=\{lots\} itemMaster=\{settings\.itemMaster \|\| \{\}\} saveSettings=\{saveSettings\} \/>/,
    'マスタ設定に描かれていない(定義しただけでは「在るのに永久に空」のまま)',
  );
});

test('IW-2 名簿に書く道が3つある(手で追加・未登録から入れる・名簿をロットに合わせる)', () => {
  const writes = [...panel.matchAll(/\bput\(/g)];
  assert.ok(writes.length >= 4, `名簿へ書く呼び出しが ${writes.length}か所しか無い(定義1 + 使う所3 のはず)`);
  assert.match(panel, /saveSettings\(\{ itemMaster: next \}\)/, '名簿を保存していない');
  assert.ok(panel.includes('unregisteredItems'), '名簿に無い品目コードの一覧が無い');
  assert.ok(panel.includes('itemNameConflicts'), '名簿と食い違う品名の一覧が無い');
});

test('IW-3 消す時は配列パス。ドット区切りの文字列では何も消えない', () => {
  assert.match(
    panel,
    /__deleteMapKeys: \[\['itemMaster', String\(code\)\]\]/,
    "消す印が配列パスでない('itemMaster.MB-200.5' では 品目コードのドットで何も消えない)",
  );
  assert.ok(!/deleteSettingsFields\(\[`itemMaster\./.test(panel), 'ドット区切りの文字列で消そうとしている');
});

test('IW-4 保存の失敗を握り潰さない(消えた前提で画面だけ進めない)', () => {
  assert.match(panel, /catch \(e\) \{\s*setErr\(/g, '保存の失敗を人に見せていない');
  const catches = [...panel.matchAll(/catch \(e\) \{/g)];
  assert.ok(catches.length >= 2, `失敗を受ける所が ${catches.length}か所(保存と削除の2つのはず)`);
});

test('IW-5 品名の決め方は純関数1本。読む所3箇所が勝手な順序を持たない', () => {
  const inline = [...app.matchAll(/\(settings\?\.itemMaster \|\| \{\}\)\[/g)];
  assert.equal(inline.length, 0, `名簿を直に引いている所が ${inline.length}か所ある(resolveItemName を通すこと)`);
  const uses = [...app.matchAll(/resolveItemName\(/g)];
  assert.ok(uses.length >= 3, `resolveItemName を呼ぶ所が ${uses.length}か所(3か所のはず)`);
  assert.ok(app.includes("from './domain/itemMaster.js'"), '純関数を読み込んでいない');
});

test('IW-6 押す物は44px以上・文字は12px以上', () => {
  // まとめ(BTN)の中身そのものにも 44px が入っている事を先に確かめる
  assert.ok(Object.keys(classConsts).length > 0, 'class のまとめが読めていない(見張りが空振りする)');
  for (const [k, v] of Object.entries(classConsts)) {
    assert.ok(/min-h-11/.test(v), `class のまとめ ${k} に 44px が無い: ${v}`);
  }
  // 画面の中のボタンは全部 min-h-11 (2.75rem = 44px) を持つ
  const btns = openTags(expanded, 'button');
  assert.ok(btns.length >= 5, `ボタンが ${btns.length}個しか無い`);
  for (const b of btns) {
    assert.ok(/min-h-11/.test(b), `44px 未満のボタンがある: ${b.replace(/\s+/g, ' ').slice(0, 110)}`);
  }
  // 打ち込む欄も44px以上
  const inputs = openTags(expanded, 'input');
  assert.ok(inputs.length >= 4, `打ち込む欄が ${inputs.length}個しか無い`);
  for (const i of inputs) {
    assert.ok(/min-h-11/.test(i), `44px 未満の入力欄がある: ${i.replace(/\s+/g, ' ').slice(0, 110)}`);
  }
  // 12px 未満の文字(text-[10px]/text-[11px])を新しく持ち込まない
  const tiny = [...expanded.matchAll(/text-\[(\d+)px\]/g)].filter((m) => Number(m[1]) < 12);
  assert.equal(tiny.length, 0, `12px 未満の文字が ${tiny.length}か所ある`);
});

test('IW-8 検査リストの4つの面に 品名 が出ている(画面によって見える物が違わない)', () => {
  // 🚨 直す前は 品目コード1本だけで、何の部品か分からなかった(エリアマップのカードにだけ品名が出ていた)。
  const faces = [
    ['大きいロットカード', /title=\{lot\.modelText \? `\$\{lot\.model\}\\u3000\$\{lot\.modelText\}` : lot\.model\}/],
    ['検査リストのカード', /data-list-grid-model-text/],
    ['押した時の小窓', /data-lot-action-model-text/],
    ['一覧の表', /data-list-table-model-text/],
    ['指図ごとのまとめ', /data-order-group-model-text/],
    ['完了履歴(カード)', /data-history-card-model-text/],
    ['完了履歴(表)', /data-history-table-model-text/],
  ];
  for (const [name, re] of faces) {
    assert.ok(re.test(app), `${name} に品名が出ていない`);
  }
  // 完了履歴は名簿を引くために settings を受け取っている必要がある
  assert.match(app, /const HistoryView = \(\{ lots, workers, templates, settings = null,/, '完了履歴が品目名簿を受け取っていない');
  assert.match(app, /<HistoryView lots=\{lots\} workers=\{workers\} templates=\{templates\} settings=\{settings\}/, '完了履歴に品目名簿を渡していない');
});

test('IW-7 ロットの品名を勝手に書き換えない(人が決める)', () => {
  assert.ok(
    /どちらが正しいかは人が決めてください/.test(panel),
    '食い違いの説明が無い',
  );
  assert.ok(
    !/saveData\('lots'|setLots\(/.test(panel),
    '名簿の画面からロットを書き換えている(勝手に直してはいけない)',
  );
});
