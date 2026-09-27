// 🗂 P067 / P119 / P157 品目コードマスタ・品目コード専用テンプレ・日数の波及の **配線** の見張り(部品検査・2026-09-27)。
//   純関数(modelMaster / templateSync / modelMasterPropagate)は product-pairs で製品と1バイト同じ事を見ている。
//   ここは「画面から届くか」「ロットを作る所が専用テンプレと品目コードマスタを先に引くか」をコメントを落とした実コードで見る。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOf } from './_code.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..');
const app = codeOf(path.join(SRC, 'App.jsx'));
const panel = codeOf(path.join(SRC, 'ModelMasterPanel.jsx'));
const actions = codeOf(path.join(SRC, 'modelTemplateActions.js'));

const between = (src, a, b) => { const i = src.indexOf(a); if (i < 0) return ''; const j = src.indexOf(b, i + a.length); return src.slice(i, j < 0 ? undefined : j); };

test('M1 applyQualityStandardToSteps は品目コードマスタ(resolveModelEntry)を品質規格マスタより先に引く', () => {
  const fn = between(app, 'const applyQualityStandardToSteps = (', '\nconst ');
  assert.ok(fn, 'applyQualityStandardToSteps が見つからない');
  const mm = fn.indexOf('resolveModelEntry(settings, model, templateId)');
  const qs = fn.indexOf('settings?.modelStandardMap?.[model]');
  assert.ok(mm > 0, '品目コードマスタを引いていない');
  assert.ok(qs > mm, '品質規格マスタより先に引いていない');
});

test('M2 ロットを作る3か所(登録・進捗管理表の取込・Excel)は専用テンプレを先に引く', () => {
  const n = (app.match(/findModelTemplate\(modelTemplates, (model|c\.model|row\.model), (templateId|c\.templateId|row\.templateId)\)/g) || []).length;
  assert.ok(n >= 3, `専用テンプレを引く所が ${n} か所しかない`);
});

test('M3 マスタ設定に品目コードマスタが在り、日数の波及と差分の口が繋がっている', () => {
  const tv = between(app, 'const TemplatesView = ({ editingTemplate', 'const WorkOrderOptimizerModal = (');
  assert.match(tv, /<ModelMasterPanel[\s\S]*?onEntryDaysChanged=\{itemMasterHost\.openMasterPropagate\}/);
  assert.match(tv, /onOpenSync=\{itemMasterHost\.openTemplateSyncFor\}/);
  assert.match(app, /<MasterPropagateModal masterPropagate=\{masterPropagate\}/);
  assert.match(app, /<TemplateSyncPanel templateName=/);
  assert.match(app, /'model_templates'/);
});

test('M4 共通テンプレの保存: 専用を持つロットは焼き直しの対象外・差分は知らせるだけ', () => {
  const fn = between(app, 'const handleSaveTemplate = async (templateData) => {', 'const onEditLot = (lot)');
  assert.match(fn, /!findModelTemplate\(modelTemplates, l\.model, id\)/);
  assert.match(fn, /setTplSync\(/);
});

test('M5 画面の言葉は品目コード(型式と書かない)・純関数を写した式を使う', () => {
  assert.ok(!/型式/.test(panel.replace(/\/\/.*$/gm, '')), 'ModelMasterPanel に「型式」が残っている');
  assert.match(actions, /planMasterChangeUpdates\(/);
  assert.match(actions, /prevSteps: before/);
});
