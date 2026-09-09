// 🛠 現場マップ等の LotCard の ✏編集／🗑削除(2026-09-09 清水さん「現場マップとかで編集とか削除するところが
//    ボタン隠れてて見えないところが沢山あるよ」)の見張り。
//   実測(写し・1366×768・現場マップ): カード9枚のうち ⋮ が在ったのは 0枚(ダッシュボードのエリアは全部コンパクト版)。
//   通常版の ⋮ は 24×24px で、押して開く <details> の窓はカードの overflow-hidden に切られていた。
//   → 3つの版すべてに 44px の ⋮。窓は createPortal で body へ(切られない)。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOf } from './_code.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const app = codeOf(path.resolve(HERE, '..', '..', 'App.jsx'));
const cardAt = app.indexOf('const LotCard = ({ lot, workers, templates, mapZones, onOpenExecution');
assert.ok(cardAt >= 0, 'LotCard が見つからない');
const sheetAt = app.indexOf('const LotActionSheet = (');
assert.ok(sheetAt >= 0 && sheetAt < cardAt, 'LotActionSheet が LotCard の前に無い');
const sheet = app.slice(sheetAt, cardAt);
// LotCard の終わり = 次の module 階の const 定義
const cardEnd = (() => { const m = /\n(?:const|function|export) [A-Za-z_]/g; m.lastIndex = cardAt + 10; const r = m.exec(app); return r ? r.index : app.length; })();
const card = app.slice(cardAt, cardEnd);

test('LA1 窓は body へ描く(createPortal)。カードやエリアの overflow-hidden に切られない', () => {
  assert.match(app.slice(0, 2000), /import \{ createPortal \} from 'react-dom';/, 'createPortal を import していない');
  assert.match(sheet, /createPortal\(/, '窓が createPortal で描かれていない');
  assert.match(sheet, /document\.body/, '窓の描き先が body でない');
  assert.match(sheet, /data-lot-action-sheet=\{lot\.id\}/, '窓の印が無い');
});

test('LA2 窓の中に 編集／削除／閉じる が 44px の押す物で在る。削除の確認文は前と同じ', () => {
  for (const a of ['data-lot-action="edit"', 'data-lot-action="delete"', 'data-lot-action="close"']) assert.ok(sheet.includes(a), `${a} が無い`);
  assert.match(sheet, /const TAP = \{ minHeight: 'max\(2\.75rem, 44px\)' \}/, '44px の床が無い');
  assert.equal((sheet.match(/style=\{TAP\}/g) || []).length, 3, '3つの押す物すべてに 44px の床が付いていない');
  assert.ok(sheet.includes('以下のロットを削除しますか？'), '削除の確認文が変わっている');
  assert.ok(sheet.includes('※ この操作は取り消せません。完了済みデータを残したい場合は履歴タブから個別に削除してください。'), '削除の確認文の後半が変わっている');
  assert.match(sheet, /if \(!confirm\(confirmMsg\)\) return;/, '削除が確認なしで走る');
});

test('LA3 背景を押したら閉じるだけ(確定しない)。カードの押下・長押しドラッグへ伝えない', () => {
  const back = sheet.slice(sheet.indexOf('data-lot-action-sheet={lot.id}'), sheet.indexOf('onTouchStart={stop}'));
  assert.match(back, /onClick=\{\(e\) => \{ e\.stopPropagation\(\); onClose\(\); \}\}/, '背景で閉じていない');
  assert.doesNotMatch(back, /onDelete\(|onEdit\(|del\(/, '背景の押下で編集／削除が走る形になっている');
  for (const h of ['onTouchStart={stop}', 'onTouchMove={stop}', 'onTouchEnd={stop}', 'onDragStart={stop}']) assert.ok(sheet.includes(h), `${h} が無い(長押しドラッグへ伝わる)`);
});

test('LA4 ⋮ は 44px。state(actionOpen)は hooks の並び(版ごとの return より上)に在る', () => {
  const st = card.indexOf('const [actionOpen, setActionOpen] = useState(false);');
  const firstReturn = card.indexOf("if (variant === 'dashboard-arrival')");
  assert.ok(st >= 0, 'actionOpen の state が無い');
  assert.ok(st < firstReturn, 'state が版ごとの return より後ろ(hooks の順が崩れる)');
  assert.match(card, /data-lot-action-open=\{lot\.id\}/, '⋮ の印が無い');
  assert.match(card, /style=\{\{ minWidth: 'max\(2\.75rem, 44px\)', minHeight: 'max\(2\.75rem, 44px\)' \}\}/, '⋮ が 44px でない');
  assert.match(card, /const actionBtn = \(onEdit \|\| onDelete\) \? \(/, '渡されていない所にも ⋮ が出る形');
  assert.match(card, /onTouchStart=\{\(e\) => e\.stopPropagation\(\)\}/, '⋮ を押すと長押しドラッグが始まる');
});

test('LA5 3つの版(通常／コンパクト／横長)すべてに ⋮ と窓が在る。<details> の窓は残っていない', () => {
  const full = card.slice(card.lastIndexOf('  return (\n    <div ref={cardRef}'));
  const dm = card.slice(card.indexOf("if (variant === 'dashboard-map')"), card.lastIndexOf('  return (\n    <div ref={cardRef}'));
  const ms = card.slice(card.indexOf("if (variant === 'map-strip')"), card.indexOf("if (variant === 'dashboard-map')"));
  for (const [name, part] of [['通常版', full], ['コンパクト版', dm], ['横長版', ms]]) {
    assert.ok(part.includes('{actionBtn}'), `${name}に ⋮ が無い`);
    assert.ok(part.includes('{actionSheet}'), `${name}に窓が無い`);
  }
  assert.doesNotMatch(card, /<details className="relative"/, 'カードの中に <details> の窓が残っている(overflow-hidden に切られる)');
  assert.doesNotMatch(card, /min-w-\[24px\] min-h-\[24px\]/, '24px の ⋮ が残っている');
  assert.match(full, /className="px-1\.5 py-1 pr-12"/, '通常版の中身が 44px の ⋮ を避けていない(pr-12)');
  assert.match(dm, /flex flex-col gap-1 leading-tight pr-12/, 'コンパクト版の中身が ⋮ を避けていない(pr-12)');
});

test('LA6 現場マップの3か所(エリアの中／到着予定の棚／未該当)は onEdit・onDelete を渡している(渡さないと ⋮ が出ない)', () => {
  const mapAt = app.indexOf('const InteractiveMap = (');
  const map = app.slice(mapAt, mapAt + 60000);
  const n = (map.match(/onEdit=\{onEditLot\} onDelete=\{onDeleteLot\}/g) || []).length;
  // 製品は エリア／到着予定の棚／未該当 の3か所。部品には到着予定の棚が無いので2か所
  const want = map.includes('data-band="map-arrival-strip"') ? 3 : 2;
  assert.ok(n >= want, `現場マップで onEdit/onDelete を渡している所が ${n}か所(${want}か所のはず)`);
});
