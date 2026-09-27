// Phase A 受入テスト A01・A13・A14 (完了データの取りこぼし防止と品質表示)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskTimeQualityOf, hasUsableInterval, autoLaborPctIsMeasured, autoLaborPctLabel } from '../taskTimeQuality.js';

const T0 = 1784451600000;

test('A01 完了データ消失防止: startTime=null でも firstStartTime/endTime があれば評価に使える(0秒の確定値にしない)', () => {
  // 実際の完了保存形式 (App.jsx 12336付近)
  const completed = { status: 'completed', duration: 300, startTime: null, firstStartTime: T0, endTime: T0 + 300000, workerName: '山田' };
  const q = taskTimeQualityOf(completed);
  assert.notEqual(q.quality, 'missing');
  assert.equal(q.ms, 300000);
  assert.equal(hasUsableInterval(completed), true);
});

test('A14 旧データ品質: firstStartTime/endTime だけなら estimated (確定と混ぜない)', () => {
  const t = { status: 'completed', duration: 300, startTime: null, firstStartTime: T0, endTime: T0 + 300000 };
  assert.equal(taskTimeQualityOf(t).quality, 'estimated');
});

test('sessions があれば confirmed で、セッション合計を返す', () => {
  const t = { status: 'completed', duration: 360, sessions: [
    { startTime: T0, endTime: T0 + 120000 },              // 2分
    { startTime: T0 + 300000, endTime: T0 + 540000 },     // 4分 (間の3分停止は含まない)
  ] };
  const q = taskTimeQualityOf(t);
  assert.equal(q.quality, 'confirmed');
  assert.equal(q.ms, 360000); // 6分
});

test('開始〜終了が duration より大きく開いていれば 低信頼 (中断・休憩の混入疑い)', () => {
  const t = { status: 'completed', duration: 600, startTime: null, firstStartTime: T0, endTime: T0 + 1500000 }; // 実10分/幅25分
  const q = taskTimeQualityOf(t);
  assert.equal(q.quality, 'unreliable');
});

test('時刻が無いタスクは 記録不足 (0秒として評価しない)', () => {
  assert.equal(taskTimeQualityOf({ status: 'completed', duration: 300 }).quality, 'missing');
  assert.equal(hasUsableInterval({ status: 'completed', duration: 300 }), false);
  assert.equal(taskTimeQualityOf(null).quality, 'missing');
});

// ---- B.1 #2: セッションが「有る」だけで確定にしない ----

test('B.1 #2 手入力(manual-entry)のセッションを「確定」と表示しない', () => {
  const t = { status: 'completed', duration: 600, sessions: [
    { id: 'est1', startTime: T0, endTime: T0 + 600000, source: 'manual-entry', quality: 'estimated' },
  ] };
  const q = taskTimeQualityOf(t);
  assert.equal(q.quality, 'estimated');
  assert.equal(q.ms, 600000, '時間そのものは出す(捨てない)');
  assert.match(q.reason, /打刻ではない/);
});

test('B.1 #2 確定と推定が混在するタスクは「確定」にしない', () => {
  const t = { status: 'completed', duration: 900, sessions: [
    { id: 'a', startTime: T0, endTime: T0 + 300000, quality: 'confirmed' },
    { id: 'b', startTime: T0 + 600000, endTime: T0 + 1200000, source: 'folded', quality: 'estimated' },
  ] };
  const q = taskTimeQualityOf(t);
  assert.equal(q.quality, 'estimated', '1本でも推定が混ざれば確定にしない');
  assert.equal(q.sessionCount, 2);
  assert.equal(q.estimatedSessionCount, 1);
  assert.match(q.reason, /混在/);
});

test('B.1 #2 全部が打刻済みなら従来どおり確定', () => {
  const t = { status: 'completed', duration: 360, sessions: [
    { id: 'a', startTime: T0, endTime: T0 + 120000, quality: 'confirmed' },
    { id: 'b', startTime: T0 + 300000, endTime: T0 + 540000, quality: 'confirmed' },
  ] };
  const q = taskTimeQualityOf(t);
  assert.equal(q.quality, 'confirmed');
  assert.equal(q.estimatedSessionCount, 0);
  assert.equal(q.ms, 360000);
});

test('B.1 #2 quality 未設定の古いセッションは確定として扱う(既存挙動を壊さない)', () => {
  const t = { status: 'completed', duration: 120, sessions: [{ id: 'a', startTime: T0, endTime: T0 + 120000 }] };
  assert.equal(taskTimeQualityOf(t).quality, 'confirmed');
});

test('A13 autoLaborPct分離: 手動設定値を実測活用率として扱わない', () => {
  assert.equal(autoLaborPctIsMeasured(), false);
  assert.match(autoLaborPctLabel(30), /設定値 30%/);
  assert.match(autoLaborPctLabel(30), /計測した拘束率ではありません/);
});
