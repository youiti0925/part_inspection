// 🔌 製品検査から移した直しの **配線** の見張り(部品検査・2026-09-26)。
//   純関数は product-pairs.test.mjs で md5 の対を見る。ここは App.jsx の呼び出し側が戻っていないかを見る。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOf } from './_code.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const app = codeOf(path.resolve(HERE, '..', '..', 'App.jsx'));

const bodyOf = (head, len = 4000) => {
  const i = app.indexOf(head);
  assert.ok(i >= 0, `見つからない: ${head}`);
  return app.slice(i, i + len);
};

test('PP1 該当なしの tasks を空のまま送らない(tasks: {} は merge で検査記録を丸ごと消す)', () => {
  assert.equal((app.match(/tasks: buildProfileSkippedTasks\(/g) || []).length, 0, '該当なしの tasks を直に送っている所がある(空なら tasks:{} になる)');
  const helper = bodyOf('const profileSkippedPatch = (', 300);
  assert.match(helper, /return Object\.keys\(tasks\)\.length \? \{ tasks \} : \{\};/, '空なら tasks のキーごと送らない形になっていない');
  assert.ok((app.match(/\.\.\.profileSkippedPatch\(/g) || []).length >= 5, '登録・取込・再焼付の道で profileSkippedPatch を通していない');
});

test('PP2 テンプレ保存: 本体の保存を待ち、再焼付は見届けてから「反映しました」と言う', () => {
  const h = bodyOf('const handleSaveTemplate = async (templateData) => {', 5000);
  assert.match(h, /await saveData\('templates', id,/, 'テンプレ本体の保存を待っていない');
  assert.match(h, /await settleSaveBriefly\(Promise\.all\(saves\)\)/, '再焼付の保存を見届けていない');
  assert.match(h, /if \(!mayCloseAfterSave\(r\)\)/, '拒否を見ていない');
});
