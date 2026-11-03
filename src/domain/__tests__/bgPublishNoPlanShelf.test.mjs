// 📉 2026-10-03 A6(部品): 裏の daily_load の書き直し(publishOnly)には保存計画の棚(planShelf)を渡さない。
//   なぜ: publishOnly は画面を1つも描かない。採った計画(useAdoptedPlan)は描く所でしか使わないのに、
//     渡すと head の購読・readHead・版の本体(plan_control / plan_versions)を書き直しのたびにサーバから読んでいた。
//   写し(エミュレータ・時計を止めた同じ手順)で確かめた事: 指紋(data-opsim-load-fp)は直す前と同じ・plan_control/plan_versions への問い合わせは 1回ずつ → 0回。
//   ここで見張る事:
//     BG-1 裏の書き直しの <OperationsSimulationPanel publishOnly …> は planShelf={null} を渡している
//     BG-2 本体(OperationsSimulationBody)の中で、publishOnly で返る所より前に 採った計画(adoptedPlan / useAdoptedForField / planShelf)を
//          使う所が無い(= daily_load の計算に計画が入っていない)。使い始めたら赤 = 渡すのを戻すか、指紋を比べ直す合図。
//     BG-3 書く中身(hereDailyLoad)の計算が 採った計画を見ていない
//   壊し方: planShelf={planShelf} に戻す → BG-1 赤 / hereDailyLoad の中で adoptedPlan.plan を読む → BG-2・BG-3 赤。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOf } from './_code.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const app = codeOf(path.join(ROOT, 'src', 'App.jsx'));
const panel = codeOf(path.join(ROOT, 'src', 'OperationsSimulationPanel.jsx'));

test('BG-1 裏の書き直しには planShelf を渡さない(null)', () => {
  const at = app.indexOf('<OperationsSimulationPanel publishOnly');
  assert.ok(at > 0, '裏の書き直し(publishOnly)の所が見つからない');
  assert.equal(app.indexOf('<OperationsSimulationPanel publishOnly', at + 1), -1, '裏の書き直しが2か所ある(どちらも確かめること)');
  const tag = app.slice(at, app.indexOf('/>', at));
  assert.match(tag, /\bplanShelf=\{null\}/, '裏の書き直しへ planShelf を渡している(保存計画の棚を毎回読む)');
  // 画面の方(操業シミュを開いた時)は今までどおり棚を渡す(計画の帯・審査が出る)
  const screen = app.indexOf("optimizeView === 'opsim' && <OperationsSimulationPanel");
  assert.ok(screen > 0, '操業シミュの画面の所が見つからない');
  assert.match(app.slice(screen, app.indexOf('/>', screen)), /\bplanShelf=\{planShelf\}/, '画面の方から棚を外している(計画の帯が出なくなる)');
});

test('BG-2 publishOnly で返る前に 採った計画を使っていない', () => {
  const start = panel.indexOf('function OperationsSimulationBody(');
  const ret = panel.indexOf('if (publishOnly) return', start);
  assert.ok(start > 0 && ret > start, '本体か publishOnly の返り口が見つからない');
  // 引数の並び(planShelf = null)の後ろから見る
  const bodyOpen = panel.indexOf('{', panel.indexOf(')', panel.indexOf('onChangeLotPriority', start)));
  let pre = panel.slice(bodyOpen, ret);
  // 決まった宣言だけは在ってよい(描く所のために作るだけ)
  const ALLOWED = [
    "const adoptedPlan = useAdoptedPlan({ planShelf, app: 'parts' });",
    'const useAdoptedForField = !!adoptedPlan.plan && !fieldSourceTrial;',
  ];
  for (const a of ALLOWED) {
    assert.ok(pre.includes(a), `宣言の形が変わった: ${a}(見張りを直すこと)`);
    pre = pre.split(a).join('');
  }
  const hits = pre.split('\n').map((l, i) => [i, l]).filter(([, l]) => /\b(adoptedPlan|useAdoptedForField|planShelf)\b/.test(l));
  assert.deepEqual(hits.map(([, l]) => l.trim()), [], '描く前の計算で 採った計画を使っている → 裏の書き直しへ planShelf を渡さない直し(A6)の前提が崩れた');
});

test('BG-3 書く中身(hereDailyLoad)は採った計画を見ていない', () => {
  const at = panel.indexOf('const hereDailyLoad = useMemo(');
  assert.ok(at > 0, 'hereDailyLoad が見つからない');
  const end = panel.indexOf(']);', at);
  const memo = panel.slice(at, end + 3);
  assert.ok(memo.includes('buildDailyLoadDoc('), 'hereDailyLoad の形が変わった(見張りを直すこと)');
  assert.ok(!/\b(adoptedPlan|useAdoptedForField|planShelf)\b/.test(memo), 'hereDailyLoad が採った計画を見ている');
});
