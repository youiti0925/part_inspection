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

test('PP4 完了確定: 保存は最大3秒だけ待つ(電波なしで固まらない)・拒否なら閉じない・interruptions を書き戻さない', () => {
  const h = bodyOf('const finalizeComplete = async (overrideMeta = null) => {', 7000);
  assert.match(h, /const saved = await settleSaveBriefly\(onSave\(\{/, '保存を settleSaveBriefly で待っていない(電波が無いと画面が固まる)');
  assert.match(h, /if \(saved === 'error'\) \{/, '拒否を見ていない');
  const payload = h.slice(h.indexOf('settleSaveBriefly(onSave({'), h.indexOf("if (saved === 'error')"));
  assert.doesNotMatch(payload, /\binterruptions\b/, '完了確定で interruptions を丸ごと書き戻している(他端末の記録を消す)');
});

test('PP5 自動終了: autoCatchUp 1本(開始+自動終了の秒で遡る・ロット1回の鍵も・一時停止中に processing を書かない)', () => {
  assert.match(app, /const r = autoCatchUp\(\{ lot: \{ steps, tasks: cur, quantity: qty, status: lotStatusRefAE\.current \}, tplSteps, now, isAuto: isAutoStep, inspectorName: inspectorNameRefAE\.current \}\);/, '自動終了が autoCatchUp を通っていない');
  assert.match(app, /onSaveRefAE\.current\?\.\(\{ tasks: r\.tasks, \.\.\.\(lotStatusRefAE\.current === 'paused' \? \{\} : \{ status: 'processing' \}\) \}\)/, '一時停止中のロットにも status:processing を書いている');
  assert.doesNotMatch(app, /autoEnded: true, workerName: t\.workerName \|\| inspectorNameRefAE\.current/, '古い自動終了(終わり=気づいた時刻)が残っている');
  assert.doesNotMatch(app, /__at:/, '部品の onSave が知らない __at を渡している(保存データに混ざる)');
});

test('PP6 完了前の確認チェック: ロット1回は画面が書く鍵(id-k-checklist)も読み、記録は id-lot-k を見る', () => {
  const h = bodyOf('const findIncompleteChecklists = () => {', 2500);
  assert.match(h, /mrNow\[chkKey\] \|\| \(step\.lotOnce \? mrNow\[`\$\{step\.id\}-\$\{u\}-checklist`\] : null\)/, 'ロット1回のチェックを画面が書く鍵で読んでいない(完了がいつまでも止まる)');
  assert.match(h, /step\.lotOnce && step\.id \? `\$\{step\.id\}-lot-\$\{u\}`/, 'ロット1回の記録の鍵を見ていない');
});

test('PP7 音声: 「全作業完了」が弾かれても聞き取りを止めない・取り消しは最新の控え・止まっている時の「中断」は二重に止めない', () => {
  // 音声から handleCompleteTrigger を直に呼んで return する所が残っていない
  const voiceArea = app.slice(app.indexOf('const runMicTest = async () => {'), app.indexOf('const handleCompleteTrigger = (skipTimeCheck = false) => {'));
  assert.ok(voiceArea.length > 1000, '音声の範囲が見つからない');
  assert.doesNotMatch(voiceArea, /handleCompleteTrigger\(\)/, '音声から handleCompleteTrigger を直に呼んでいる(弾かれると音声が死ぬ)');
  assert.ok((voiceArea.match(/\(voiceLatestRef\.current\.voiceTryCompleteAll \|\| voiceTryCompleteAll\)\(\)/g) || []).length >= 7, '音声の「全作業完了」が voiceTryCompleteAll の最新を通っていない');
  assert.match(voiceArea, /if \(lu\.pendingUndo \?\? pendingUndo\) \{ \(lu\.handleUndo \|\| handleUndo\)\(\);/, '音声の取り消しが古い控えを読んでいる');
  const hc = bodyOf('const handleCompleteTrigger = (skipTimeCheck = false) => {', 3500);
  assert.match(hc, /completeBlockReasonRef\.current = 'checklist';\s*return false;/, '確認チェックで弾いた時に false を返していない');
  assert.match(hc, /completeBlockReasonRef\.current = 'timecheck'; return false;/, '時間の確認で弾いた時に false を返していない');
  assert.match(hc, /setIsConfirming\(true\);\s*return true;/, '進めた時に true を返していない');
  assert.match(app, /voiceLatestRef\.current = \{ voiceTryCompleteAll, handleUndo, pendingUndo \};/, '最新の控えを ref に写していない');
  const hp = bodyOf('const handlePause = () => {', 300);
  assert.match(hp, /if \(!isTimerRunning\) return false;/, '止まっている時の中断で二重に止める');
  assert.doesNotMatch(app, /onClick=\{handleCompleteTrigger\}/, 'クリックイベントが skipTimeCheck に入って時間の確認を素通りする');
});

test('PP8 作業画面に品名を出す(品目コード｜品名・名簿からも引く)', () => {
  assert.match(app, /const WorkExecutionModal = \(\{ lot: _lotProp, itemMaster = null,/, '作業画面が品目名簿を受け取っていない');
  assert.match(app, /const itemName = resolveItemName\(lot\.model, lot\.modelText, itemMaster\);/, '品名を resolveItemName で引いていない');
  assert.match(app, /itemMaster=\{settings\?\.itemMaster \|\| null\}/, '親が品目名簿を渡していない');
  assert.ok((app.match(/data-exec-item-label>\{itemLabel\}/g) || []).length >= 2, 'カスタム・順序実行の見出しに品名が出ていない');
});
