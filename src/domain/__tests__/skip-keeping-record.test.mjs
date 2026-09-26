// 🚨⏱ 2026-09-19 作業者の立場での確かめで見つかった穴:
//   製品検査の「未完了のまま完了」が、終わっていない工程を { status:'skipped', duration: 0 } で **丸ごと差し替え** ていた。
//   最後の1台の「完了」を押し忘れた(計測中の)まま押すと、**かけた時間が消え**、NG の判定も該当なしに化けていた。
//   ロットは完了扱いなので後から直せない。
//   🚨 同じアプリの中に正しい形が在った(現場マップの「ロット完了時の自動整理」)。純関数1本にして両方から呼ぶ。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skipTaskKeepingRecord, elapsedSecOfRunningTask } from '../skipKeepingRecord.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = fs.readFileSync(path.resolve(HERE, '..', '..', 'App.jsx'), 'utf8').replace(/\r\n/g, '\n');
const NOW = Date.parse('2026-09-19T17:00:00+09:00');
const MIN = 60000;

test('SK-1 🚨 計測中だった工程の時間を落とさない(押し忘れた人の時間が消えない)', () => {
  const t = { status: 'processing', duration: 120, startTime: NOW - 5 * MIN, workerName: '尾田' };
  const out = skipTaskKeepingRecord(t, { nowMs: NOW, reason: '欠品', by: '村' });
  assert.equal(out.duration, 120 + 300, 'かけた時間が足されていない');
  assert.equal(out.status, 'skipped');
  assert.equal(out.workerName, '尾田', '誰がやったかが消えている');
  assert.equal(out.skipReason, '欠品');
  assert.equal(out.skipBy, '村');
});

test('SK-2 まとめて開始の台は batchStartedAt が起点(休憩分シフト済み)', () => {
  const t = { status: 'processing', duration: 0, startTime: NOW - 60 * MIN, batchStartedAt: NOW - 3 * MIN };
  assert.equal(elapsedSecOfRunningTask(t, NOW), 180);
  assert.equal(skipTaskKeepingRecord(t, { nowMs: NOW }).duration, 180);
});

test('SK-3 NG の判定・写真・記録を1つも落とさない(該当なしに化けない)', () => {
  const t = { status: 'paused', duration: 600, result: 'NG', ngReason: '傷', photos: ['a'], values: { p1: 12.5 }, firstStartTime: NOW - 30 * MIN };
  const out = skipTaskKeepingRecord(t, { nowMs: NOW, reason: '時間切れ' });
  assert.equal(out.result, 'NG', 'NG の判定が消えている');
  assert.equal(out.ngReason, '傷');
  assert.deepEqual(out.photos, ['a']);
  assert.deepEqual(out.values, { p1: 12.5 });
  assert.equal(out.duration, 600, '止まっていた工程に勝手な時間を足している');
  assert.equal(out.firstStartTime, NOW - 30 * MIN, 'いつ始めたかが書き換わっている');
});

test('SK-4 記録が無い工程は今までどおり(0秒・時刻は閉じた時刻)', () => {
  const out = skipTaskKeepingRecord(null, { nowMs: NOW, reason: 'r' });
  assert.equal(out.duration, 0);
  assert.equal(out.firstStartTime, NOW);
  assert.equal(out.endTime, NOW);
  assert.equal(out.status, 'skipped');
  assert.equal(out.skipBy, undefined, '責任者を渡していないのに作っている');
});

test('SK-5 時計を中で読まない・起点が無ければ0秒を作らない', () => {
  assert.equal(elapsedSecOfRunningTask({ status: 'processing' }, NOW), 0, '起点が無いのに秒を作っている');
  assert.equal(elapsedSecOfRunningTask({ status: 'processing', startTime: NOW + 60000 }, NOW), 0, '時計が戻った端末で負の秒を作っている');
  assert.equal(skipTaskKeepingRecord({ status: 'processing', startTime: NOW - MIN }, {}).duration, 0, 'nowMs を渡さないのに数えている');
});

test('SK-6 画面の2か所(未完了のまま完了・ロット完了時の自動整理)が 同じ純関数を呼ぶ', () => {
  assert.ok(APP.includes("import { skipTaskKeepingRecord } from './domain/skipKeepingRecord.js';"), '純関数を読んでいない');
  assert.equal((APP.match(/skipTaskKeepingRecord\(/g) || []).length, 2, '呼ぶ所が2か所でない＝どこかが自前で計算している');
  assert.ok(!/status: 'skipped', duration: 0, skipReason/.test(APP), '時間を0で潰す古い形が残っている');
  assert.ok(!/const addSec = t\.status === 'processing'/.test(APP), '同じ計算が画面の中にもう1つ在る');
});
