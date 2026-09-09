// ⏱ 日次集計(2026-09-09 清水さん):
//   「製品検査と部品検査はテンプレ名も記載」
//   (部品の日次集計に修正の枠は無いので、ここはテンプレ名だけ)
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOf } from './_code.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const app = codeOf(path.resolve(HERE, '..', '..', 'App.jsx'));
const at = app.indexOf('const DailySummaryModal = (');
assert.ok(at >= 0, 'DailySummaryModal が見つからない');
const modal = app.slice(at, at + 40000);

test('DS1 テンプレ名: 親が templates を渡し、指図の行に 📋テンプレ名 が出る。検索にも掛かる', () => {
  assert.match(app, /<DailySummaryModal [^\n]*templates=\{templates\}/, '親が templates を渡していない(名前が引けない)');
  assert.match(modal, /onClose, templates = \[\] \}\) => \{/, 'templates を受けていない');
  assert.match(modal, /const tplNameOf = \(lot\) =>/, 'テンプレ名を引く関数が無い');
  assert.match(modal, /templateName: tplNameOf\(lot\)/, '明細にテンプレ名を載せていない');
  assert.match(modal, /templateName: d\.templateName \|\| ''/, '指図ごとのまとめにテンプレ名が無い');
  assert.match(modal, /data-daily-template=\{g\.lotId \|\| g\.orderNo\}>📋 \{g\.templateName\}/, '指図の行に 📋テンプレ名 が出ない');
  assert.match(modal, /\$\{detail\.templateName\}`\.includes\(searchText\)/, '検索にテンプレ名が掛からない');
});
