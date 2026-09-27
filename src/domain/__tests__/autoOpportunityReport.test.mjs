// Phase C: 画面へ出す集計層のテスト。⚠実測と推定を混ぜないこと・低信頼を落とすことを担保する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAutoOpportunityReport, summaryView, rateOf } from '../autoOpportunityReport.js';
import { isAutoStep } from '../workExecution.js';

const T0 = 1784451600000;
const M = 60000;
const isAuto = (s) => isAutoStep(s);
const AUTO = { id: 'a1', title: '回転自動測定開始', executionMode: 'batch', workResource: 'measurement-machine' };
const MANUAL = { id: 'm1', title: '外観検査', executionMode: 'manual', targetTime: 300 };
const done = (s, e, extra = {}) => ({ status: 'completed', firstStartTime: s, endTime: e, startTime: null, duration: Math.round((e - s) / 1000), ...extra });

const lotOf = (id, over = {}) => ({
  id, quantity: 2, model: 'RTT-311', templateId: 'tpl1', workerId: 'w1',
  steps: [MANUAL, AUTO], tasks: {},   // 実際の並び: 手動 → 自動
  ...over,
});

test('実測(sessions有)と推定を合算しない。別々のまとまりで返る', () => {
  const est = lotOf('L1', { tasks: { 'a1-0': done(T0, T0 + 20 * M, { workerName: '尾田' }), 'm1-1': { status: 'waiting' } } });
  // ⚠実測= machineRuns(機械の実稼働)から作られた区間だけ。sessions が付いているだけでは実測にしない
  //   (ChatGPT指摘 2026-07-21 の是正。以前は「実測」と表示しながら開始〜終了の幅で計算していた)
  const mea = lotOf('L2', {
    machineRuns: [{ stepId: 'a1', unitIndices: [0], segments: [{ startTime: T0 + 60 * M, endTime: T0 + 80 * M }] }],
    tasks: {
      'a1-0': done(T0 + 60 * M, T0 + 80 * M, { workerName: '片山', sessions: [{ startTime: T0 + 60 * M, endTime: T0 + 80 * M, quality: 'confirmed' }] }),
      'm1-1': { status: 'waiting' },
    },
  });
  const r = buildAutoOpportunityReport({ lots: [est, mea], isAuto });
  assert.equal(r.区間数.推定, 1);
  assert.equal(r.区間数.実測, 1);
  assert.equal(r.推定.作業者別[0].key, '尾田');
  assert.equal(r.実測.作業者別[0].key, '片山');
  assert.notEqual(r.推定.全体.自動時間ms, r.実測.全体.自動時間ms + r.推定.全体.自動時間ms, '合計を持たない');
});

test('低信頼(完了押し忘れ疑い)は集計から外し、件数だけ返す', () => {
  // duration 60秒に対し 開始〜終了が10時間 = 低信頼
  const lot = lotOf('L1', {
    tasks: {
      'a1-0': { status: 'completed', firstStartTime: T0, endTime: T0 + 600 * M, duration: 60, startTime: null },
      'm1-1': { status: 'waiting' },
    },
  });
  const r = buildAutoOpportunityReport({ lots: [lot], isAuto });
  assert.equal(r.除外.低信頼, 1);
  assert.equal(r.区間数.推定, 0, '低信頼の自動区間は評価に入れない');
});

test('別ロットの手作業も活用として数える(ロットをまたいで重なりを見る)', () => {
  const a = lotOf('L1', { quantity: 1, tasks: { 'a1-0': done(T0, T0 + 20 * M, { workerName: '尾田' }) } });
  const b = lotOf('L2', { tasks: { 'm1-0': done(T0 + 2 * M, T0 + 12 * M, { workerName: '尾田' }) } });
  const r = buildAutoOpportunityReport({ lots: [a, b], isAuto });
  const v = summaryView(r.推定.全体);
  assert.equal(v.自動時間h, 0.33, '20分 = 0.33h(小数2桁に丸める)');
  assert.equal(v.活用h, 0, '1台ロットは取れた上限0なので活用にも計上しない');
  assert.equal(v.候補なしh, 0.33, '別ロットの仕事が要る時間として②へ入る');
  assert.equal(v.率pct, null, '分母0で0%と表示しない');
});

test('率の分母は必ず「取れた上限」。自動時間で割らない', () => {
  const lot = lotOf('L1', {
    tasks: {
      'a1-0': done(T0, T0 + 20 * M, { workerName: '尾田' }),
      'm1-1': done(T0 + 1 * M, T0 + 6 * M, { workerName: '尾田' }),   // 5分の候補を5分やった
    },
  });
  const r = buildAutoOpportunityReport({ lots: [lot], isAuto });
  const v = summaryView(r.推定.全体);
  assert.equal(v.取れた上限h, 0.08, '5分');
  assert.equal(v.率pct, 100, '5分しか無い所で5分やったら100%');
  assert.notEqual(v.率pct, 25, '自動20分で割ってはいけない');
  assert.equal(rateOf(r.推定.全体), 1);
});

test('工程別・台数別のまとまりが出る(取り逃がし+候補なしの大きい順)', () => {
  const big = lotOf('L1', { quantity: 3, tasks: { 'a1-0': done(T0, T0 + 60 * M, { workerName: '尾田' }), 'm1-1': { status: 'waiting' }, 'm1-2': { status: 'waiting' } } });
  const small = lotOf('L2', { quantity: 2, tasks: { 'a1-0': done(T0 + 120 * M, T0 + 125 * M, { workerName: '尾田' }), 'm1-1': { status: 'waiting' } } });
  const r = buildAutoOpportunityReport({ lots: [big, small], isAuto, resolveTemplateName: () => '回転分割' });
  assert.equal(r.推定.工程別[0].key, '回転分割 / 回転自動測定開始');
  assert.deepEqual(r.推定.台数別.map(x => x.key).sort(), ['2-3台']);
  assert.ok(r.推定.全体.取り逃がしms > 0);
});

test('4つの内訳の合計は自動時間に一致する(画面に出す数字が消えたり増えたりしない)', () => {
  const lot = lotOf('L1', {
    quantity: 3,
    tasks: {
      'a1-0': done(T0, T0 + 40 * M, { workerName: '尾田' }),
      'm1-1': done(T0 + 5 * M, T0 + 10 * M, { workerName: '尾田' }),
      'm1-2': { status: 'waiting' },
    },
    interruptions: [{ type: 'break', startTime: T0 + 20 * M, endTime: T0 + 25 * M }],
  });
  const r = buildAutoOpportunityReport({ lots: [lot], isAuto });
  const s = r.推定.全体;
  assert.equal(s.活用ms + s.取り逃がしms + s.候補なしms, s.自動時間ms);
  assert.equal(s.休憩ms, 5 * M, '休憩は窓から抜いて別枠で持つ');
});

// ===== 是正 第2弾 (ChatGPT指摘 2026-07-21) =====
// 「実測」と表示する数字に、打刻されていない手作業が混ざっていた件。

const withSessions = (s, e, quality) => done(s, e, { sessions: [{ startTime: s, endTime: e, quality }] });

test('実測の窓に、打刻されていない(推定の)手作業を混ぜない', () => {
  // 機械は実測(machineRuns)。重なる手作業は sessions が無く 開始〜終了の幅しかない = 推定
  const mea = lotOf('L1', {
    quantity: 2,
    machineRuns: [{ stepId: 'a1', unitIndices: [0], segments: [{ startTime: T0, endTime: T0 + 20 * M }] }],
    tasks: { 'a1-0': done(T0, T0 + 20 * M, { workerName: '片山' }), 'm1-1': done(T0 + 2 * M, T0 + 7 * M, { workerName: '片山' }) },
  });
  const r = buildAutoOpportunityReport({ lots: [mea], isAuto });
  assert.equal(r.区間数.実測, 1);
  assert.equal(r.実測.全体.活用ms, 0, '打刻が無い手作業を実測の活用にしない');
  assert.ok(r.除外.実測窓に重なった未確認手作業ms > 0, '黙って捨てず件数・時間を残す');
  assert.equal(r.実測.全体.率, 0, '候補はあったが、打刻で確認できた活用は0なので率は0');
});

test('打刻(quality=confirmed)された手作業は実測の活用に入る', () => {
  const mea = lotOf('L1', {
    quantity: 2,
    machineRuns: [{ stepId: 'a1', unitIndices: [0], segments: [{ startTime: T0, endTime: T0 + 20 * M }] }],
    tasks: {
      'a1-0': done(T0, T0 + 20 * M, { workerName: '片山' }),
      'm1-1': withSessions(T0 + 2 * M, T0 + 7 * M, 'confirmed'),
    },
  });
  const r = buildAutoOpportunityReport({ lots: [mea], isAuto });
  assert.equal(r.実測.全体.活用ms, 5 * M);
  assert.equal(r.除外.実測窓に重なった未確認手作業ms, 0);
});

test('手入力・畳み込みの区間(quality≠confirmed)は打刻として扱わない', () => {
  const mea = lotOf('L1', {
    quantity: 2,
    machineRuns: [{ stepId: 'a1', unitIndices: [0], segments: [{ startTime: T0, endTime: T0 + 20 * M }] }],
    tasks: {
      'a1-0': done(T0, T0 + 20 * M, { workerName: '片山' }),
      'm1-1': withSessions(T0 + 2 * M, T0 + 7 * M, 'manual-entry'),
    },
  });
  const r = buildAutoOpportunityReport({ lots: [mea], isAuto });
  assert.equal(r.実測.全体.活用ms, 0, '手入力を実測にしない');
});

test('文言と実際の判定が一致している(実測=機械の運転記録がある区間)', () => {
  const r = buildAutoOpportunityReport({ lots: [lotOf('L1')], isAuto });
  assert.match(r.合算しない理由, /機械の運転記録/, 'sessions の有無で説明しない');
});
