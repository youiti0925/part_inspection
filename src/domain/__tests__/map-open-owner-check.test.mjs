// 🚨👤 2026-09-19 作業者の立場での確かめで見つかった穴:
//   現場マップのカードを1回タップすると、確認も担当の割当も無しに作業画面が開き、
//   工程を完了していくと **そのロットの担当(前の人)の名前** で記録が残っていた(自分の本日実績は0のまま)。
//   検査リストから入る道は割当の確認(LotAssignmentModal)を通るのに、マップから入る道だけ素通りだった。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = fs.readFileSync(path.resolve(HERE, '..', '..', 'App.jsx'), 'utf8').replace(/\r\n/g, '\n');

/** App.jsx の openExecutionFromMap と同じ決め方(ここを直したら向こうも直す)。 */
function asks({ ownerName, me }) {
  const m = String(me || '').trim();
  return !!(m && ownerName && ownerName !== m && !['フリー', '管理者'].includes(m));
}

test('MO-1 担当が自分と違う時は 開く前に必ず聞く', () => {
  assert.equal(asks({ ownerName: '片山', me: '尾田' }), true);
});

test('MO-2 自分のロット・担当が空 の時は今までどおり何も聞かない', () => {
  assert.equal(asks({ ownerName: '尾田', me: '尾田' }), false);
  assert.equal(asks({ ownerName: '', me: '尾田' }), false);
});

test('MO-3 見ているだけの時(使用者を選んでいない・フリー・管理者)は 1ミリも変えない', () => {
  for (const me of ['', null, undefined, ' ', 'フリー', '管理者']) {
    assert.equal(asks({ ownerName: '片山', me }), false, `${String(me)} で聞いている`);
  }
});

test('MO-4 マップの3画面だけが この口を通る(検査リストは今までどおり割当の確認を通る)', () => {
  assert.equal((APP.match(/setExecutionLotId=\{openExecutionFromMap\}/g) || []).length, 3, 'マップの3画面が この口を通っていない');
  const list = APP.slice(APP.indexOf('<InspectionListView'), APP.indexOf('<InspectionListView') + 600);
  assert.ok(/setExecutionLotId=\{setExecutionLotId\}/.test(list), '検査リストの道まで変えている(そちらは割当の確認が既に在る)');
});

test('MO-5 聞いた答えが「替える」なら 担当を自分にしてから開く。答えが無くても必ず開く', () => {
  const i = APP.indexOf('const openExecutionFromMap = useCallback(');
  assert.ok(i > 0, 'マップから開く口が無い');
  const fn = APP.slice(i, i + 1600);
  assert.ok(/window\.confirm\(/.test(fn), '聞いていない(黙って別人の名前で記録する形に戻っている)');
  /* ⚠ 2026-09-21: 保存の口は 置き場(ref)越しに呼ぶ形へ変えた。
     材料(deps)に saveData を入れると、毎回の描画でこの口が作り直されて
     受け取る3つの画面が毎回描き直され、eslint の「毎回変わる」も1件 増えていた。
     呼ぶ中身('lots', id, { workerId: mine.id })は1文字も変えていない。 */
  assert.ok(/saveDataRef\.current\('lots', id, \{ workerId: mine\.id \}\)/.test(fn), '「替える」と答えても担当を替えていない');
  assert.ok(!/\}, \[[^\]]*\bsaveData\b[^\]]*\]\);/.test(fn), '保存の口を材料に入れている(この口が毎回作り直される)');
  assert.ok(/setExecutionLotId\(id\);/.test(fn), '作業画面を開いていない');
  assert.ok(/\['フリー', '管理者'\]\.includes\(me\)/.test(fn), '見ているだけの人にも聞いている');
});
