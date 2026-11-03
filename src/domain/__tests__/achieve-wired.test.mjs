// ============================================================================
// 📊 生産達成率を ③ へ渡す配線(本物の src/App.jsx を読む)(2026-10-04)
//   ・このアプリは共有棚 capacity-shared-v1/achieve_rate/parts へ **書くだけ**(読みは1口も足さない)
//   ・書くのは「分析を開いて過去のロットがそろった時」と「目標時間(customTargetTimes)を保存した直後」だけ
//   ・行は達成率の画面と同じ係(achieveRowsOf)を使う(数える作業の決まりを2か所に書かない)
//   ・中身が同じなら書かない(domain/achieveShelf.js の makeAchievePublisher)
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const app = fs.readFileSync(path.join(ROOT, ...'src/App.jsx'.split('/')), 'utf8').replace(/\r\n/g, '\n');

test('AW-parts-01 書く口は1つ(丸ごと置き換え・docId=parts)・読む口は無い', async () => {
  const saves = app.match(/DATA\(db\)\.save\(ACHIEVE_NS, ACHIEVE_COL, 'parts', doc, \{ merge: false \}\)/g) || [];
  assert.equal(saves.length, 1, '共有棚へ書く口が1つではない');
  assert.ok(!/\b(getOne|getAll|getPage\w*|watch\w*)\([^)]*ACHIEVE_COL/.test(app), '達成率の棚を読んでいる(読みが増える)');
  assert.ok(app.includes("makeAchievePublisher({\n"), '同じ中身なら書かない係を通していない');
  // 読みの見張り(verify-read-budget)の目でも、このアプリの achieve_rate の読みは0口
  const m = await import(pathToFileURL(path.join(ROOT, 'scripts', 'verify-read-budget.mjs')).href);
  const me = m.resolveApps({ selfRoot: ROOT }).find((a) => a.self);
  const sites = m.scanApp(me).sites.filter((s) => s.col === 'achieve_rate');
  assert.equal(sites.length, 0, `達成率の棚を読む口がある: ${JSON.stringify(sites.map((s) => `${s.file}:${s.line}`))}`);
});

test('AW-parts-02 書くのは「分析を開いて過去がそろった時」と「目標時間の保存の後」だけ', () => {
  assert.ok(/useEffect\(\(\) => \{\n\s*if \(analysisOpenForAchieve && lotsHistoryReady\) publishAchieve\('open'\);\n\s*\}, \[analysisOpenForAchieve, lotsHistoryReady, publishAchieve\]\);/.test(app), '分析を開いた時の1回になっていない');
  assert.ok(/if \(!achieveCalibRef\.current \|\| !lotsHistoryReady\) return;\n\s*achieveCalibRef\.current = false;\n\s*publishAchieve\('calibrate'\);/.test(app), '目標時間の保存の後の1回になっていない');
  assert.ok(/if \(newSettings && newSettings\.customTargetTimes !== undefined\) achieveCalibRef\.current = true;/.test(app), '設定の保存で目標時間の印を立てていない');
  // publishAchieve を呼ぶのはこの2か所だけ(ロットが変わるたびに書かない)
  assert.equal((app.match(/publishAchieve\('/g) || []).length, 2);
});

test('AW-parts-03 行は達成率の画面と同じ係', () => {
  assert.ok(app.includes('const rows = useMemo(() => achieveRowsOf('), '達成率の画面が同じ係を使っていない');
  assert.ok(/rows = achieveRowsOf\(cur\.lots,/.test(app), '③へ渡す集計が同じ係を使っていない');
});
