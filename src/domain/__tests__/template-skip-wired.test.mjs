// 🧾 品目×テンプレ単位の抜取／スキップの **配線** の見張り(部品検査・2026-09-06)。純関数の見張りは templateSkip.test.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOf } from './_code.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const app = codeOf(path.resolve(HERE, '..', '..', 'App.jsx'));
const panel = codeOf(path.resolve(HERE, '..', '..', 'TemplateSkipPanel.jsx'));

test('K1 作業最適化に「抜取/スキップ」の札と画面(品目の言い方)。決めるのは管理者', () => {
  assert.ok(app.includes('data-optimize-tab="tskip"'), '札が無い');
  assert.match(app, /optimizeView === 'tskip' && <TemplateSkipPanel unitLabel="品目" lots=\{lots\} templates=\{templates\} settings=\{settings\} saveSettings=\{saveSettings\} canEdit=\{currentUserName === '管理者'\}/, '画面が無い／品目の言い方でない／管理者だけになっていない');
});

test('K2 ロット登録の4つの道(手入力・進捗取込・Excel上書き・Excel新規)の全部で判定し、該当なしの後ろに広げる', () => {
  const sites = [...app.matchAll(/\.\.\.templateSkipPatch\(\{ model[^}]*\}\)/g)];
  assert.equal(sites.length, 4, `判定している登録の道が ${sites.length}か所(4か所のはず)`);
  const helper = app.indexOf('const templateSkipPatch = (');
  assert.ok(helper >= 0, '判定の口(templateSkipPatch)が無い');
  const h = app.slice(helper, helper + 700);
  assert.match(h, /judgeTemplateSkip\(\{ model, templateId, lots, cfg: settings\?\.templateSkip \}\)/, '純関数で判定していない');
  assert.match(h, /tasks: buildTemplateSkippedTasks\(steps, qty, \{ at \}\)/, 'スキップの tasks を作っていない');
  assert.match(h, /templateSkip: \{ skip: true, key: j\.key, streak: j\.streak, need: j\.need, every: j\.every, at, by: 'system' \}/, '根拠をロットに残していない');
  // 各所で 該当なし(buildProfileSkippedTasks)の直後に広げている
  for (const m of sites) {
    const before = app.slice(Math.max(0, m.index - 400), m.index);
    assert.ok(before.includes('buildProfileSkippedTasks('), '該当なしの後ろに広げていない所がある(スキップが該当なしに上書きされる)');
  }
});

test('K3 検査リストに『スキップ』の札(グリッド・指図ごと)。ロットは消さない', () => {
  assert.ok(app.includes('data-lot-template-skip="1"'), 'グリッドのカードに札が無い');
  assert.match(app, /if \(isTemplateSkippedLot\(lot\)\) return \{ key: 'skip', label: 'スキップ（流すだけ）'/, '指図ごとの1枚の状態にスキップが無い');
});

test('K4 画面: 数字は domain の純関数から。時計を描画の中で読まない', () => {
  assert.ok(panel.includes("from './domain/templateSkip.js'"), '純関数を使っていない');
  assert.match(panel, /const nowMs = useMemo\(\(\) => latestCompletedMs\(lots\), \[lots\]\);/, '「今」を時計から読んでいる');
  assert.ok(panel.includes("unitLabel = '型式'"), '品目／型式の言い方を切り替える口が無い');
});
