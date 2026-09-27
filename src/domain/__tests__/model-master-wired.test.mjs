// 📋 品目マスタ(P064/P130/P104/P106/P144/P032)の **配線** の見張り(部品検査・2026-09-27)。
//   純関数(modelMaster / templateSync / modelMasterPropagate)は製品と1バイト同じ(product-pairs.test.mjs)。
//   ここは「画面で入れた品目マスタが ロットを作る計算へ届くか」を、コメントを落とした実コードで見る。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOf } from './_code.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..');
const app = codeOf(path.join(SRC, 'App.jsx'));
const panel = codeOf(path.join(SRC, 'ModelMasterPanel.jsx'));
const routes = codeOf(path.join(SRC, 'data', 'routes.js'));

const bodyOf = (src, head) => {
  const s = src.indexOf(head);
  assert.ok(s >= 0, `見つからない: ${head}`);
  return src.slice(s, src.indexOf('\n};', s));
};

test('M1: 焼き付け(applyQualityStandardToSteps)は 品目マスタ(resolveModelEntry)を旧・品質規格より先に見る', () => {
  const f = bodyOf(app, 'const applyQualityStandardToSteps = (');
  const mm = f.indexOf('resolveModelEntry(settings, model, templateId)');
  const qs = f.indexOf('settings?.modelStandardMap?.[model]');
  assert.ok(mm > 0 && qs > mm, '品目マスタ → 旧・品質規格 の順');
  assert.match(f, /mmResolved \? 'modelMaster' : 'qualityStandard'/);
});

test('M2: 進捗管理表・入荷登録Excel の取込は settings.modelMasters を渡す({} の直書きに戻さない)', () => {
  const n = (app.match(/modelMasters: settings\.modelMasters \|\| \{\}/g) || []).length;
  assert.ok(n >= 2, `2か所以上(いま ${n})`);
  assert.doesNotMatch(app, /modelMasters: \{\},/);
  assert.match(app, /modelMasters: data\.modelMasters \|\| \{\}/);
});

test('M3: ロットを作る3つの道と共通テンプレの再焼付が 品目コード専用テンプレ(findModelTemplate)を見る', () => {
  const n = (app.match(/findModelTemplate\(modelTemplates, (model|c\.model|row\.model), (templateId|c\.templateId|row\.templateId)\)/g) || []).length;
  assert.ok(n >= 3, `ロットを作る道(いま ${n})`);
  assert.match(bodyOf(app, 'const handleSaveTemplate = async'), /!findModelTemplate\(modelTemplates, l\.model, id\)/);
  assert.match(app, /watch\('model_templates', \(rows\) => setModelTemplates\(rows\)\)/);
  assert.match(routes, /model_templates: 'inspection'/);
  assert.match(routes, /model_templates: \[[^\]]*'parts'/);
});

test('M4: 品目マスタのタブと画面・編集の窓・差分パネル・日数の波及の窓が在る', () => {
  assert.match(app, /\{ id: 'quality-standards', label: '品目マスタ'/);
  assert.match(app, /'quality-standards': 'templates'/);
  assert.match(app, /activeTab === 'quality-standards' && [\s\S]{0,400}<ModelMasterPanel /);
  assert.match(app, /onEntryDaysChanged=\{openMasterPropagate\}/);
  assert.match(app, /<TemplateSyncPanel[\s\S]{0,400}onApply=\{applyTemplateSync\}/);
  assert.match(app, /scopeLabel=\{`品目コード \$\{modelTplEditing\.model\} 専用`\}/);
  assert.match(app, /<MasterPropagateModal plan=\{masterPropagate\} onApply=\{applyMasterPropagate\}/);
  // 旧・品質規格マスタの画面は残す(既定: 消さず足すだけ)
  assert.match(app, /<QualityStandardsPanel/);
});

test('M5: 画面は日数4つ・旧・品質規格からの取り込み・品名の表示を持つ', () => {
  for (const k of ['shipDaysBefore', 'dueDaysBefore', 'entryDaysBefore', 'daysBefore']) {
    assert.match(panel, new RegExp(`onChange=\\{e => setEntryField\\(entryIdx, \\{ ${k}:`), k);
  }
  assert.match(panel, /onClick=\{\(\) => importQs\(qs\)\}/);
  assert.match(panel, /resolveItemName\(m, '', itemMaster\)/);
  assert.doesNotMatch(panel.replace(/\/\/.*$/gm, ''), /型式/);
});
