// 🧭 2026-09-23 ChatGPT/Codex の枝 codex/opsim-visual-monthly-20260902 の src/domain/opsimPresentation.test.mjs を合流。
//   枝の buildCompletedLateRows（遅れて完了の日数を自分で数える）は持ち込まず、lateDone.js の rows をそのまま置く。
//   「+N日」は lateDone.lateDays ただ1本（製品・最終で同じ中身＝md5 の対）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDelayLanes, workLabelOf, daysPastDueLineAt, isPastDueLineAt } from '../opsimPresentation.js';
import { buildLateDone, lateDays, dueEndMsOf } from '../../domain/operationsSimulation/lateDone.js';

const D = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi, 0, 0).getTime();

test('OP-1 遅れを「これから」「いま」「遅れて完了」へ混ぜずに分ける（間に合う・判定がつかない は数だけ残す）', () => {
  const now = D(2026, 9, 23, 10, 0);
  const lanes = buildDelayLanes({
    nowMs: now,
    lots: [
      { lotId: 'future', model: 'A', tplName: '甲' },
      { lotId: 'current', model: 'B', tplName: '乙' },
      { lotId: 'finished', model: 'B2', tplName: '乙2' },
      { lotId: 'safe', model: 'C', tplName: '丙' },
      { lotId: 'unknown', model: 'D', tplName: '丁' },
      { lotId: 'lateNoFinish', model: 'E', tplName: '戊' },
    ],
    lotResults: [
      { lotId: 'future', dueLineMs: D(2026, 9, 25, 17), finishMs: D(2026, 9, 27, 12), lateMs: 155 * 60000, late: true, judgeable: true },
      { lotId: 'current', dueLineMs: D(2026, 9, 21, 17), finishMs: D(2026, 9, 24, 12), lateMs: 1, late: true, judgeable: true },
      { lotId: 'finished', dueLineMs: D(2026, 9, 21, 17), finishMs: D(2026, 9, 22, 12), lateMs: 1, late: true, judgeable: true },
      { lotId: 'safe', dueLineMs: D(2026, 9, 25, 17), finishMs: D(2026, 9, 24, 12), lateMs: 0, late: false, judgeable: true },
      { lotId: 'unknown', dueLineMs: null, late: false, judgeable: false },
      { lotId: 'lateNoFinish', dueLineMs: D(2026, 9, 25, 17), finishMs: null, late: true, judgeable: true },
    ],
    lateDoneRows: [{ lotId: 'done', model: 'Z', orderNo: '9', dueEndMs: dueEndMsOf(D(2026, 9, 1)), completedMs: D(2026, 9, 3), daysLate: 2, tplName: '己' }],
  });
  // 🚨 2026-09-24 late だが期間の中で終わらない(finishMs 無し)は「これから遅れる」へ（結論の帯と同じ数）。先頭に来る。
  assert.deepEqual(lanes.future.map((r) => r.lotId), ['lateNoFinish', 'future']);
  assert.deepEqual(lanes.current.map((r) => r.lotId).sort(), ['current', 'finished']);
  assert.deepEqual(lanes.completed.map((r) => r.lotId), ['done']);
  assert.equal(lanes.safeCount, 1);
  assert.equal(lanes.unknownCount, 1, '納期が無い(judgeable=false) だけが列に出ず数に残る');
  assert.equal(lanes.unknownNoDueCount, 1, 'そのうち納期の記録が無い物');
  assert.equal(lanes.futureBeyondHorizonCount, 1);
  const beyond = lanes.future[0];
  assert.equal(beyond.finishBeyondHorizon, true);
  assert.equal(beyond.finishMs, null);
  assert.equal(beyond.lateMs, null, '「期間の終わり − 納期線」を量にしない（simulate.js が禁じた数）');
  assert.equal(beyond.daysLate, null);
  assert.equal(beyond.workLabel, 'テンプレ：戊');
  assert.equal(lanes.future[1].finishBeyondHorizon, false);
  assert.equal(lanes.currentFinishedCount, 1, '「いま遅れている」のうち計算の上では終わった物の数を別に持つ');
  // 🚨 いま遅れている の棒の長さは いま − 納期線（見立ての lateMs ではない）
  const cur = lanes.current.find((r) => r.lotId === 'current');
  assert.equal(cur.lateMs, now - D(2026, 9, 21, 17));
  assert.equal(cur.finishedInCalc, false);
  assert.equal(lanes.current.find((r) => r.lotId === 'finished').finishedInCalc, true);
  // 🚨 +N日 は lateDays ただ1本（納期の日の終わりを境に ceil）
  assert.equal(cur.daysLate, lateDays(now, dueEndMsOf(D(2026, 9, 21))));
  assert.equal(cur.daysLate, 2);
  const fut = lanes.future.find((r) => r.lotId === 'future');
  assert.equal(fut.daysLate, lateDays(D(2026, 9, 27, 12), dueEndMsOf(D(2026, 9, 25))));
  assert.equal(fut.daysLate, 2);
  // 遅れて完了 は渡された daysLate をそのまま（数え直さない）・棒の長さは 完了 − 納期の日の終わり
  assert.equal(lanes.completed[0].daysLate, 2);
  assert.equal(lanes.completed[0].lateMs, D(2026, 9, 3) - dueEndMsOf(D(2026, 9, 1)));
  assert.equal(lanes.completed[0].workLabel, 'テンプレ：己');
  assert.equal(lanes.completed[0].orderNo, '9');
});

test('OP-2 遅れて完了の rows は lateDone.buildLateDone の戻りをそのまま置ける（日数の式は1本）', () => {
  const r = buildLateDone({ lots: [
    { id: 'L1', status: 'completed', model: 'RTT-130', orderNo: '100', templateId: 'T1', dueDate: '2026-09-01', completedAt: D(2026, 9, 3) },
    { id: 'L2', status: 'completed', model: 'RTT-131', dueDate: '2026-09-05', completedAt: D(2026, 9, 5, 15) },  // 間に合った
  ] });
  assert.equal(r.rows.length, 1);
  const lanes = buildDelayLanes({ lateDoneRows: r.rows, subOf: (x) => (x.templateId === 'T1' ? '標準検査' : ''), subName: 'テンプレ' });
  assert.equal(lanes.completed.length, 1);
  assert.equal(lanes.completed[0].daysLate, r.rows[0].daysLate);
  assert.equal(lanes.completed[0].daysLate, 2);
  assert.equal(lanes.completed[0].workLabel, 'テンプレ：標準検査');
  assert.equal(lanes.completed[0].model, 'RTT-130');
});

test('OP-3 型式に添える札。製品はテンプレ名、最終検査は特注仕様（表示の元は呼び手の subOf）', () => {
  assert.equal(workLabelOf({ tplName: '通電検査' }), 'テンプレ：通電検査');
  assert.equal(workLabelOf({ special: '外観A' }, { subName: '特注仕様' }), '特注仕様：外観A');
  assert.equal(workLabelOf({ lotId: 'F' }, { subOf: () => '外観B', subName: '特注仕様' }), '特注仕様：外観B');
  assert.equal(workLabelOf({}), 'テンプレの記録なし');
  assert.equal(workLabelOf({}, { subName: '特注仕様' }), '特注仕様の記録なし');
  // subOf が優先（行の tplName より）
  assert.equal(workLabelOf({ tplName: 'x' }, { subOf: () => 'y' }), 'テンプレ：y');
});

test('OP-4 納期線の向きと +N日。線ちょうどは過ぎていない・当日中は null（今日）', () => {
  const line = D(2026, 9, 21, 17);
  assert.equal(isPastDueLineAt(line, line), false);
  assert.equal(isPastDueLineAt(line, line + 1), true);
  assert.equal(isPastDueLineAt(null, line), false);
  assert.equal(daysPastDueLineAt(D(2026, 9, 21, 20), line), null, '当日中は null（画面は「今日のうち」）');
  assert.equal(daysPastDueLineAt(D(2026, 9, 22, 0, 1), line), 1);
  assert.equal(daysPastDueLineAt(D(2026, 9, 23, 10), line), 2);
  assert.deepEqual(buildDelayLanes({}), {
    future: [], current: [], completed: [], safeCount: 0, unknownCount: 0, unknownNoDueCount: 0, currentFinishedCount: 0, futureBeyondHorizonCount: 0,
  });
});

test('OP-5 並びは遅れが大きい順（同じなら納期が古い順）', () => {
  const lanes = buildDelayLanes({
    nowMs: D(2026, 9, 30),
    lotResults: [
      { lotId: 'a', dueLineMs: D(2026, 9, 28, 17), finishMs: D(2026, 9, 29), lateMs: 1, late: true },
      { lotId: 'b', dueLineMs: D(2026, 9, 20, 17), finishMs: D(2026, 9, 29), lateMs: 1, late: true },
    ],
  });
  assert.deepEqual(lanes.current.map((r) => r.lotId), ['b', 'a']);
});

test('OP-6 期間の中で終わらない物は「ほか N件」(先頭10件の外)に隠れない・納期の古い順', () => {
  const now = D(2026, 9, 24, 9, 30);
  const lotResults = [];
  for (let i = 0; i < 12; i += 1) {
    lotResults.push({ lotId: `big${String(i).padStart(2, '0')}`, dueLineMs: D(2026, 9, 25, 17), finishMs: D(2026, 9, 26, 10 + i), lateMs: (i + 1) * 3600000, late: true, judgeable: true });
  }
  lotResults.push({ lotId: 'nf-late-due', dueLineMs: D(2026, 9, 29, 17), finishMs: null, lateMs: null, late: true, judgeable: true });
  lotResults.push({ lotId: 'nf-early-due', dueLineMs: D(2026, 9, 26, 17), finishMs: null, lateMs: null, late: true, judgeable: true });
  const lanes = buildDelayLanes({ nowMs: now, lotResults });
  assert.deepEqual(lanes.future.slice(0, 2).map((r) => r.lotId), ['nf-early-due', 'nf-late-due']);
  assert.equal(lanes.future[2].lotId, 'big11', 'その後ろは遅れが大きい順のまま');
  assert.equal(lanes.futureBeyondHorizonCount, 2);
});

test('OP-7 結論の帯と同じ数: 「これから遅れる」＝ late===true かつ まだ納期線の手前（判定がつかない物は入らない）', () => {
  const now = D(2026, 9, 24, 9, 30);
  const lotResults = [
    { lotId: 'a', dueLineMs: D(2026, 9, 25, 17), finishMs: D(2026, 9, 26, 10), lateMs: 1, late: true, judgeable: true },
    { lotId: 'b', dueLineMs: D(2026, 9, 25, 17), finishMs: null, lateMs: null, late: true, judgeable: true },
    { lotId: 'c', dueLineMs: D(2026, 9, 22, 17), finishMs: null, lateMs: null, late: true, judgeable: true },
    { lotId: 'd', dueLineMs: D(2026, 9, 25, 17), finishMs: null, late: false, judgeable: false },
    { lotId: 'e', dueLineMs: null, finishMs: null, late: false, judgeable: false },
    { lotId: 'f', dueLineMs: D(2026, 10, 9, 17), finishMs: null, late: false, judgeable: true },
  ].map((r) => ({ ...r, alreadyPastDue: r.dueLineMs != null && r.dueLineMs < now }));
  const band = lotResults.filter((r) => r.late && !r.alreadyPastDue).length;
  const lanes = buildDelayLanes({ nowMs: now, lotResults });
  assert.equal(lanes.future.length, band);
  assert.deepEqual(lanes.future.map((r) => r.lotId), ['b', 'a']);
  assert.deepEqual(lanes.current.map((r) => r.lotId), ['c']);
  assert.equal(lanes.unknownCount, 2, '判定がつかない(納期あり・入力が足りない)と 納期の記録なし');
  assert.equal(lanes.unknownNoDueCount, 1, '納期の記録なし は e だけ（d は納期が在るので名乗らない）');
  assert.equal(lanes.safeCount, 1);
});
