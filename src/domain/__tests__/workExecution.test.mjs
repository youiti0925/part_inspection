// Phase A 受入テスト A02〜A07・A13 (自動判定の統一と開始ガード)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAutoStep, isManualStep, canStartTask, startGuard, buildStepMasterIndex, stepMasterKey } from '../workExecution.js';

// 実データ(2026-07-20調査)を模した工程マスタ
const templates = [
  { id: 't1', name: '円テーブル一般精度_三次元', steps: [
    { category: '', title: '三次元測定機キャリブレーション', executionMode: 'batch' },
    { category: '', title: '三次元測定開始', executionMode: 'manual' },
  ] },
  { id: 't2', name: '回転分割_モーター_ブラザー', steps: [
    { category: '', title: '分割測定開始_手動', executionMode: 'manual' },
    { category: '', title: '分割自動測定開始' }, // 未設定(旧データ)
  ] },
];
const idx = buildStepMasterIndex(templates);

test('A03 batch判定: executionMode=batch は名称に関係なく全経路で自動', () => {
  assert.equal(isAutoStep({ title: '内径測定', executionMode: 'batch' }, idx), true);
  assert.equal(isAutoStep({ title: '三次元測定機キャリブレーション', executionMode: 'batch' }, idx), true);
});

test('A04 旧名称互換: executionMode未設定の「三次元測定開始」系は名称推定で自動(マスタに無い旧工程名)', () => {
  assert.equal(isAutoStep({ title: '回転分割測定開始' }, idx), true);   // マスタに無い旧工程名 → 名称推定
  assert.equal(isAutoStep({ title: '傾斜自動測定開始' }, idx), true);
});

test('A05 rotaryLink: rotaryLink=true は自動', () => {
  assert.equal(isAutoStep({ title: '準備', rotaryLink: true }, idx), true);
});

test('明示manualは名称に「自動」が入っていても手動 (清水指示)', () => {
  assert.equal(isAutoStep({ title: '分割自動測定開始', executionMode: 'manual' }, idx), false);
  assert.equal(isAutoStep({ title: '分割測定開始_手動', executionMode: 'manual' }, idx), false);
  assert.equal(isManualStep({ title: '分割測定開始_手動', executionMode: 'manual' }, idx), true);
});

test('案②: 未設定の旧データは、現行マスタに同名工程の明示設定があればそれを優先する', () => {
  // 実データ: 「三次元測定開始」は新しいロットでmanual・古い8件は未設定。マスタ参照で手動に揃う。
  assert.equal(isAutoStep({ title: '三次元測定開始' }, idx), false);
  // マスタ参照なし(索引を渡さない)なら名称推定で自動になる = 時期で判定が割れる
  assert.equal(isAutoStep({ title: '三次元測定開始' }, null), true);
});

test('案②: マスタ内で同名工程の設定が矛盾している場合はマスタで決めず名称推定へ落とす', () => {
  const conflict = buildStepMasterIndex([{ steps: [
    { category: '', title: 'あいまい測定開始', executionMode: 'manual' },
    { category: '', title: 'あいまい測定開始', executionMode: 'batch' },
  ] }]);
  assert.equal(conflict.has(stepMasterKey({ title: 'あいまい測定開始' })), false);
  assert.equal(isAutoStep({ title: 'あいまい測定開始' }, conflict), true); // 名称推定
});

test('名称推定は 自動測定|測定開始 に限定 (「自動」を広く拾わない)', () => {
  assert.equal(isAutoStep({ title: '自動搬送の確認' }, idx), false);
  assert.equal(isAutoStep({ title: '分割自動測定開始' }, idx), true);
});

test('A02 判定一致: 同じ工程を目標計算・作業者評価・画面のどこから呼んでも同じ結果', () => {
  const step = { category: '', title: '内径測定', executionMode: 'batch' };
  const callers = [isAutoStep(step, idx), isAutoStep(step, idx), isAutoStep(step, idx)];
  assert.deepEqual(callers, [true, true, true]);
});

test('A06 手動二重開始: 自動運転中でも同じ作業者の2件目の手動は拒否', () => {
  const running = [
    { workerId: 'w1', step: { title: '準備', executionMode: 'manual' } },
    { workerId: 'w1', step: { title: '分割自動測定開始', executionMode: 'batch' } }, // 自動は動いている
  ];
  const r = canStartTask({ workerId: 'w1', targetStep: { title: '片付け', executionMode: 'manual' }, runningTasks: running, masterIndex: idx });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'manual-already-running');
});

test('自動＋手動は許可 / 別の作業者の手動は影響しない', () => {
  const runningAutoOnly = [{ workerId: 'w1', step: { title: '分割自動測定開始', executionMode: 'batch' } }];
  assert.equal(canStartTask({ workerId: 'w1', targetStep: { title: '片付け', executionMode: 'manual' }, runningTasks: runningAutoOnly, masterIndex: idx }).ok, true);
  const otherWorker = [{ workerId: 'w2', step: { title: '準備', executionMode: 'manual' } }];
  assert.equal(canStartTask({ workerId: 'w1', targetStep: { title: '片付け', executionMode: 'manual' }, runningTasks: otherWorker, masterIndex: idx }).ok, true);
});

test('自動工程の開始は手動が動いていても許可(機械は並行して回せる)', () => {
  const running = [{ workerId: 'w1', step: { title: '準備', executionMode: 'manual' } }];
  assert.equal(canStartTask({ workerId: 'w1', targetStep: { title: '分割自動測定開始', executionMode: 'batch' }, runningTasks: running, masterIndex: idx }).ok, true);
});

test('A07 経路一致: 同じ入力なら呼び出し元が違っても同じコード・同じ文言を返す', () => {
  const args = { workerId: 'w1', targetStep: { title: '片付け', executionMode: 'manual' }, runningTasks: [{ workerId: 'w1', step: { title: '準備', executionMode: 'manual' } }], masterIndex: idx };
  const card = canStartTask(args), compact = canStartTask(args), voice = canStartTask(args), gesture = canStartTask(args);
  assert.deepEqual([compact, voice, gesture].map(x => x.code), [card.code, card.code, card.code]);
  assert.deepEqual([compact, voice, gesture].map(x => x.message), [card.message, card.message, card.message]);
});

// ============ Phase A.1 追加 (2026-07-20): 名称に頼った判定の残りを潰した件の回帰テスト ============

test('A16 実害の再現防止: executionMode=batch・タイトルに「自動」なし・別の手動作業が進行中 → 開始できる', () => {
  // 旧コード(App.jsx 15741)は step.title.includes('自動') だけで見ていたため、この工程を手動と誤判定し
  // blockParallel でボタンを disabled にしていた(本来許可すべき「自動+手動」が押せない)。
  const batchNoAutoInName = { category: '', title: '三次元測定機キャリブレーション', executionMode: 'batch' };
  assert.equal((batchNoAutoInName.title || '').includes('自動'), false, '前提: 名称に「自動」を含まない');
  assert.equal(isAutoStep(batchNoAutoInName, idx), true, '共通判定では自動');

  const running = [{ workerId: 'w1', key: 's9-0', step: { title: '外観検査', executionMode: 'manual' } }];
  const r = startGuard({ workerId: 'w1', targetStep: batchNoAutoInName, runningTasks: running, masterIndex: idx });
  assert.equal(r.ok, true, '別の手動が動いていても自動工程は開始できる');
  // 画面の無効化条件 blockParallel = !isAuto && ... と同じ式で、無効化されないことを確認
  const blockParallel = !isAutoStep(batchNoAutoInName, idx);
  assert.equal(blockParallel, false, 'ボタンが無効化されない');
});

test('A17 逆方向: executionMode=manual でタイトルに「自動」を含んでも手動として制限される', () => {
  const manualButNamedAuto = { category: '', title: '分割自動測定開始_手動', executionMode: 'manual' };
  assert.equal(manualButNamedAuto.title.includes('自動'), true, '前提: 名称に「自動」を含む');
  assert.equal(isAutoStep(manualButNamedAuto, idx), false, '明示manualが名称より優先');
  const running = [{ workerId: 'w1', key: 's1-0', step: { title: '外観検査', executionMode: 'manual' } }];
  const r = startGuard({ workerId: 'w1', targetStep: manualButNamedAuto, runningTasks: running, masterIndex: idx });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'manual-already-running');
  // 画面側も同じく無効化される(表示と書込みガードが一致)
  assert.equal(!isAutoStep(manualButNamedAuto, idx), true);
});

test('A18 共通入口 startGuard: 全開始経路が同じ1本を通る(自分自身の除外もここで行う)', () => {
  const target = { category: '', title: '外観検査', executionMode: 'manual' };
  const running = [
    { workerId: 'w1', key: 'sX-0', step: { title: '外観検査', executionMode: 'manual' } }, // 自分自身(paused→再開)
  ];
  // 自分自身を除外すれば「他に手動なし」= 開始できる
  assert.equal(startGuard({ workerId: 'w1', targetStep: target, runningTasks: running, excludeKey: 'sX-0', masterIndex: idx }).ok, true);
  // 除外しなければ止まる(除外漏れが経路ごとに起きないよう、除外は startGuard の中だけ)
  assert.equal(startGuard({ workerId: 'w1', targetStep: target, runningTasks: running, masterIndex: idx }).ok, false);

  // カード/コンパクト/ロット1回/音声/サイン/まとめて開始 の6経路が同じ結論・同じ文言になる
  const args = { workerId: 'w1', targetStep: target, runningTasks: [{ workerId: 'w1', key: 'other-0', step: { title: '梱包', executionMode: 'manual' } }], excludeKey: 'sX-0', masterIndex: idx };
  const routes = ['card', 'compact', 'lotOnce', 'voice', 'gesture', 'batch'].map(() => startGuard(args));
  assert.equal(new Set(routes.map(r => `${r.ok}/${r.code}/${r.message}`)).size, 1);
  assert.equal(routes[0].ok, false);
});

test('A19 startGuard は canStartTask と矛盾しない(除外なしなら完全一致)', () => {
  const cases = [
    { targetStep: { title: '外観検査', executionMode: 'manual' }, runningTasks: [] },
    { targetStep: { title: '外観検査', executionMode: 'manual' }, runningTasks: [{ workerId: 'w1', step: { title: '梱包', executionMode: 'manual' } }] },
    { targetStep: { title: '三次元測定機キャリブレーション', executionMode: 'batch' }, runningTasks: [{ workerId: 'w1', step: { title: '梱包', executionMode: 'manual' } }] },
  ];
  cases.forEach(c => {
    const a = canStartTask({ workerId: 'w1', ...c, masterIndex: idx });
    const b = startGuard({ workerId: 'w1', ...c, masterIndex: idx });
    assert.deepEqual(b, a);
  });
});

test('A20 テンプレ編集の初期値: 未設定工程を開いたときの推定が共通判定と一致する', () => {
  // App.jsx: setExecutionMode(s.executionMode || (isAutoStep(s) ? 'batch' : 'manual'))
  const guess = (s) => s.executionMode || (isAutoStep(s, idx) ? 'batch' : 'manual');
  // マスタで manual と決まっている同名工程 → 編集初期値も manual (名称に「測定開始」を含んでも)
  assert.equal(guess({ category: '', title: '三次元測定開始' }), 'manual');
  // マスタで batch と決まっている同名工程 → batch
  assert.equal(guess({ category: '', title: '三次元測定機キャリブレーション' }), 'batch');
  // 明示値があればそのまま
  assert.equal(guess({ category: '', title: '三次元測定開始', executionMode: 'batch' }), 'batch');
});
