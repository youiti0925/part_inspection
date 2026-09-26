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

test('PP3 まとめて開始の時間が消えない4件(開き直しの復元・再開のずらし・中断中の完了止め・続きから/最初から)', () => {
  // ① 開き直した時に起点を tasks から作り直す
  assert.match(app, /const restored = rebuildBatchStartTimes\(tasks\);/, '開き直した時にまとめて開始の起点を作り直していない');
  assert.match(app, /setBatchStartTimes\(prev => mergeRestoredBatchStartTimes\(prev, restored\)\)/, '画面側の起点を上書きしてしまう');
  // ② 再開で batchStartedAt を止まっていた分だけずらす(ヘッダー・個別タップ・音声)
  assert.ok((app.match(/batchStartedAt: t\.batchStartedAt \+ myBreakMs/g) || []).length >= 1, 'ヘッダーの再開でバッチ台の起点をずらしていない');
  assert.ok((app.match(/batchStartedAt: currentTask\.batchStartedAt \+ Math\.max\(0, nowTs - currentTask\.pausedAt\)/g) || []).length >= 1, '個別タップの再開でずらしていない');
  assert.ok((app.match(/batchStartedAt: cur\.batchStartedAt \+ Math\.max\(0, nowTs - cur\.pausedAt\)/g) || []).length >= 1, '音声の再開でずらしていない');
  // ③ 中断中の台があれば まとめて完了させない／完了できる台が0なら起点を消さない
  const hb = bodyOf('const handleBatchClick = (stepIdx) => {', 2500);
  assert.match(hb, /t\.status === 'paused' && t\.batchOwner === stepIdx/, '中断中のバッチ台を見ていない');
  const tb = bodyOf('const toggleBatch = (stepIdx, fromIdx = 0, toIdx = lot.quantity - 1, selectedIndices = null, resetDuration = false) => {', 7000);
  assert.match(tb, /if \(processedCount === 0\) \{/, '完了できる台が0でも起点を消してしまう');
  // ④ 続きからは起点を引き継ぐ。最初からだけ now
  assert.match(tb, /if \(resetDuration \|\| t\.batchStartedAt == null\) return now;/, '続きから開始で起点を今の時刻で上書きしている');
  assert.match(tb, /const belongsToBatch = \(t\) => t && t\.status === 'processing' && \(t\.batchOwner === stepIdx \|\| \(t\.batchOwner == null && t\.startTime === batchStart\)\);/, '所属判定が batchStartedAt の一致を要求している(再開した台が置き去り)');
  assert.match(app, /toggleBatch\(stepIdx, 0, lot\.quantity - 1, selectedUnits, true\)/, '「最初から開始」のボタンが無い');
  // 表示は liveSecOf
  assert.ok((app.match(/liveSecOf\(task\)/g) || []).length >= 2, '表示がバッチ台の起点を見ていない');
});
