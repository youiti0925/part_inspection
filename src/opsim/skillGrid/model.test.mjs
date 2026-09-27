import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { normalizeRequiredSkills } from '../../domain/skillRegistry.js';
import { buildSkillGrid, SKILL_GRID_STATES } from './model.js';

const workers = [{ id: 'a', name: '作業者A' }, { id: 'b', name: '作業者B' }, { id: 'c', name: '作業者C', paused: true }];
const templates = [{ id: 't', name: '検査表A', requiredSkills: ['s'] }, { id: 'u', name: '検査表B', requiredSkills: ['s', 'q'] }];
const completed = (id, extra = {}) => ({ id, model: '型式A', templateId: 't', status: 'completed', tasks: { one: { workerName: '作業者A' } }, ...extra });
const build = (lots, extra = {}) => buildSkillGrid({ lots, templates, workers, workerSkills: {}, ...extra });
const cell = (model, name = '作業者A', row = 0) => model.rows[row].cells.find((entry) => entry.workerName === name);

test('未受領と受領済み0件を区別する', () => {
  assert.equal(buildSkillGrid().ready, false);
  assert.equal(buildSkillGrid({ lots: [], templates: [], workers: [] }).ready, true);
  assert.equal(buildSkillGrid({ lots: [], templates: [], workers: [] }).rows.length, 0);
});

test('完了ロット数で数える。台数・作業数・時間で増やさない', () => {
  const m = build([completed('1', { quantity: 30, tasks: [{ workerName: '作業者A' }, { workerName: '作業者A' }] })]);
  assert.equal(cell(m).count, 1);
  assert.equal(m.audit.completedLotCount, 1);
});

test('statusがcompletedだけを集計。locationだけの完了や未完了を足さない', () => {
  const m = build([completed('1'), completed('2', { status: 'processing' }), completed('3', { status: 'pending', location: 'completed' })]);
  assert.equal(cell(m).count, 1);
  assert.equal(m.rows[0].inputLotCount, 3);
});

test('共同作業は各人1回。人の回数の合計を全体ロット数にしない', () => {
  const m = build([completed('1', { tasks: { a: { workerName: '作業者A' }, b: { workerName: '作業者B' } } })]);
  assert.equal(cell(m, '作業者A').count, 1);
  assert.equal(cell(m, '作業者B').count, 1);
  assert.equal(m.rows[0].completedLotCount, 1);
});

test('tasksが配列でも辞書でも同じ。タスクの完了状態による別の認定はしない', () => {
  const m = build([completed('1', { tasks: [null, { workerName: '作業者A', status: 'pending' }] }), completed('2')]);
  assert.equal(cell(m).count, 2);
});

test('作業者名が無い時だけworkerIdを補完し、その内数と由来を残す', () => {
  const m = build([completed('1', { tasks: {}, workerId: 'b' }), completed('2', { workerId: 'b' })]);
  assert.equal(cell(m, '作業者A').count, 1);
  assert.equal(cell(m, '作業者B').count, 1);
  assert.equal(cell(m, '作業者B').fallbackCount, 1);
  assert.equal(cell(m, '作業者B').references[0].source, 'lot_worker');
  assert.equal(m.audit.fallbackLotCount, 1);
});

test('担当IDから名前が引けなければ人数を作らず作業者不明ロットに残す', () => {
  const m = build([completed('1', { tasks: null, workerId: 'unknown' })]);
  assert.equal(m.audit.unnamedLotCount, 1);
  assert.equal(m.rows[0].completedLotCount, 1);
  assert.equal(m.rows[0].unnamedLotCount, 1);
  assert.equal(cell(m).count, 0);
});

test('同一IDの重複を1回にし、黙って捨てず重複数を返す', () => {
  const lot = completed('1');
  const m = build([lot, lot, { ...lot }]);
  assert.equal(cell(m).count, 1);
  assert.equal(m.audit.duplicateLotCount, 2);
  assert.equal(m.audit.completedLotCount, 1);
});

test('IDなしは入力1要素1ロットで警告。欠落を同一ロットにまとめない', () => {
  const m = build([completed(null), completed(null)]);
  assert.equal(cell(m).count, 2);
  assert.equal(m.audit.missingLotIdCount, 2);
});

test('型式が違う時は別行、テンプレ表示は同じ元ロットを合算', () => {
  const m = build([completed('1'), completed('2', { model: '型式B' })]);
  assert.equal(m.rows.length, 2);
  assert.equal(m.templateRows.find((row) => row.templateId === 't').cells[0].count, 2);
  assert.equal(m.templateRows.find((row) => row.templateId === 't').completedLotCount, 2);
});

test('同名のテンプレでもIDが違えば混ぜない。型式の表記ゆれも勝手に結合しない', () => {
  const m = build([completed('1'), completed('2', { templateId: 'u' }), completed('3', { model: ' 型式A' })], { templates: templates.map((t) => ({ ...t, name: '同じ表示名' })) });
  assert.equal(m.rows.length, 3);
});

test('区切り文字を含む型式とテンプレIDでキーが衝突しない', () => {
  const m = build([completed('1', { templateId: 'a|b', model: 'c' }), completed('2', { templateId: 'a', model: 'b|c' })]);
  assert.equal(m.rows.length, 2);
  assert.notEqual(m.rows[0].key, m.rows[1].key);
});

test('共通スキルがあっても別テンプレの回数を横流ししない', () => {
  const m = build([completed('1'), completed('2', { templateId: 'u', tasks: [{ workerName: '作業者B' }] })]);
  assert.equal(cell(m, '作業者A', 0).count, 1);
  assert.equal(cell(m, '作業者A', 1).count, 0);
});

test('必要スキルの無いテンプレ・見つからないテンプレも実績を落とさない', () => {
  const m = build([completed('1'), completed('2', { templateId: 'missing' })], { templates: [{ id: 't', name: '未設定' }] });
  assert.equal(m.rows.length, 2);
  assert.equal(m.audit.completedLotCount, 2);
  assert.equal(m.audit.missingTemplateLotCount, 1);
  assert.deepEqual(new Set(m.rows.map((row) => row.cells[0].registration.state)), new Set(['not_configured', 'missing_template']));
});

test('登録に使うスキルはnormalizeRequiredSkillsで重複排除。工程別の行を作らない', () => {
  const m = build([completed('1')], { templates: [{ id: 't', requiredSkills: ['s', { skillId: 's', stepIds: ['one'] }, { skillId: 'q', stepIds: ['two'] }] }], workerSkills: { 作業者A: { s: 2 } } });
  assert.equal(m.rows.length, 1);
  assert.equal(cell(m).registration.total, 2);
  assert.equal(cell(m).registration.registeredCount, 1);
  assert.equal(cell(m).registration.state, 'partial');
});

test('教育中は登録ありとして表示するが割付可能とは判定しない', () => {
  const m = build([completed('1')], { workerSkills: { 作業者B: { s: 1 } } });
  assert.equal(cell(m, '作業者B').state, 'registration');
  assert.equal(cell(m, '作業者B').registration.items[0].label, '教育中');
  assert.equal(Object.hasOwn(cell(m, '作業者B'), 'canAssign'), false);
});

test('登録の語彙はSKILL_LEVELS。文字列レベルも共通関数経由で読む', () => {
  const m = build([completed('1')], { workerSkills: { 作業者A: { s: '3' } } });
  assert.equal(cell(m).registration.items[0].label, '教えられる');
  assert.equal(cell(m).state, 'both');
});

test('実績のみ／登録のみ／両方／どちらもなしの4状態と色が異なる', () => {
  const m = build([completed('1', { tasks: [{ workerName: '作業者A' }, { workerName: '作業者D' }] })], { workerSkills: { 作業者A: { s: 2 }, 作業者B: { s: 2 } } });
  assert.equal(cell(m, '作業者A').state, 'both');
  assert.equal(cell(m, '作業者B').state, 'registration');
  assert.equal(cell(m, '作業者C').state, 'neither');
  assert.equal(cell(m, '作業者D').state, 'history');
  assert.equal(new Set(Object.values(SKILL_GRID_STATES).map((state) => state.dot)).size, 4);
});

test('0回・1回・休止中・名簿外・登録だけの人を落とさない', () => {
  const m = build([completed('1', { tasks: [{ workerName: '名簿外' }] })], { workerSkills: { 登録だけ: { s: 2 } } });
  assert.equal(m.people.length, 5);
  assert.equal(m.people.find((person) => person.name === '作業者C').paused, true);
  assert.equal(cell(m, '名簿外').count, 1);
  assert.equal(cell(m, '作業者A').count, 0);
  assert.equal(cell(m, '登録だけ').state, 'registration');
});

test('同姓同名を別人と推測せず注意を返す', () => {
  const m = build([completed('1')], { workers: [{ id: 'a', name: '同名' }, { id: 'b', name: '同名' }] });
  assert.equal(m.audit.ambiguousWorkerNameCount, 1);
  assert.equal(m.people.find((person) => person.name === '同名').ambiguous, true);
});

test('未完了ロットと未使用テンプレも0回のまま表示用の行を残す', () => {
  const m = build([completed('1', { status: 'pending' })]);
  assert.equal(m.rows.length, 1);
  assert.equal(cell(m).count, 0);
  assert.equal(m.templateRows.length, 2);
});

test('登録未受領・0件・履歴全件未確認を区別する', () => {
  const missing = build([completed('1')], { workerSkills: null });
  assert.equal(cell(missing).registration.state, 'not_provided');
  assert.equal(missing.historyComplete, false);
  const given = build([completed('1')], { historyComplete: true, sourceLabel: '確認済みの写し' });
  assert.equal(cell(given).registration.state, 'none');
  assert.equal(given.historyComplete, true);
  assert.equal(given.sourceLabel, '確認済みの写し');
});

test('未知の登録値を強い資格として扱わない', () => {
  const m = build([completed('1')], { workerSkills: { 作業者A: { s: 99 } } });
  assert.equal(cell(m).registration.items[0].invalid, true);
  assert.equal(cell(m).registration.hasRegistration, false);
});

test('入力を書き換えず同じ入力から同じ結果を返す', () => {
  const data = { lots: [completed('1')], templates, workers, workerSkills: { 作業者A: { s: 2 } } };
  const original = structuredClone(data);
  const first = buildSkillGrid(data);
  assert.deepEqual(buildSkillGrid(data), first);
  assert.deepEqual(data, original);
  assert.doesNotThrow(() => JSON.stringify(first));
});

test('既存computeSkillCountsと関与の意味が一致（重複IDなしの正規入力）', () => {
  // 既存画面をimportすると関連UIを全部読むので、既存関数そのものを切り出して比較。
  const existing = fs.readFileSync(new URL('../../SkillMap.jsx', import.meta.url), 'utf8');
  const start = existing.indexOf('export function computeSkillCounts(');
  let end = existing.indexOf('\nconst ScopeChip', start);
  // 部品の SkillMap.jsx は ScopeChip を持たないので、次の関数の手前までを切り出す
  if (end < 0) end = existing.indexOf('\nfunction SkillMapViewBody', start);
  assert.ok(start >= 0 && end > start);
  const compute = vm.runInNewContext(`${existing.slice(start, end).replace('export function', 'function')}\ncomputeSkillCounts`, { normalizeRequiredSkills });
  const lots = [completed('1'), completed('2', { templateId: 'u', tasks: [{ workerName: '作業者A' }, { workerName: '作業者B' }] }), completed('3', { tasks: {}, workerId: 'c' }), completed('4', { status: 'pending' })];
  const model = build(lots);
  const projected = {};
  model.rows.forEach((row) => row.cells.forEach((entry) => {
    if (!entry.count) return;
    entry.registration.items.forEach(({ skillId }) => {
      projected[entry.workerName] ||= {};
      projected[entry.workerName][skillId] = (projected[entry.workerName][skillId] || 0) + entry.count;
    });
  }));
  assert.deepEqual(projected, JSON.parse(JSON.stringify(compute(lots, templates, workers))));
});

test('画面は表示契約のみ。データを数え直す入口・通信・拡大固定値を持たない', () => {
  const ui = fs.readFileSync(new URL('./SkillGrid.jsx', import.meta.url), 'utf8');
  const model = fs.readFileSync(new URL('./model.js', import.meta.url), 'utf8');
  assert.doesNotMatch(ui, /buildSkillGrid\(|computeSkillCounts\(|\.reduce\(/);
  for (const source of [ui, model]) {
    assert.doesNotMatch(source, /from\s*['"]firebase|\bfetch\s*\(|\b(?:localStorage|sessionStorage)\b/);
    assert.doesNotMatch(source, /\d+(?:\.\d+)?px\b|\bzoom\s*:|scale\s*\(/);
    assert.doesNotMatch(source, /Date\.now\s*\(|Math\.random\s*\(/);
  }
});
