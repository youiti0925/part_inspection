// Phase B 受入テスト — 仕様書「9. 受入テスト」の T01 / T02 / T15 / T17 / T18 と、多端末・容量の防御。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openSession, closeSession, sessionsDurationMs, hasOpenSession, sessionsOf,
  applySessionTransitions, setEstimatedSession, MAX_SESSIONS_PER_TASK,
} from '../workSessions.js';

const T0 = 1784451600000;   // 10:00
const M = 60000;
const min = (ms) => ms / M;

// 実アプリの遷移をそのまま再現するヘルパー (App.jsx の書き方に合わせる)
const startWrite = (t, now) => ({ ...t, status: 'processing', startTime: now, firstStartTime: t.firstStartTime || now });
const pauseWrite = (t, now) => ({ ...t, status: 'paused', duration: (t.duration || 0) + Math.floor((now - t.startTime) / 1000), startTime: null, pausedAt: now });
const completeWrite = (t, now) => ({ ...t, status: 'completed', duration: (t.duration || 0) + Math.floor((now - t.startTime) / 1000), startTime: null, endTime: now, firstStartTime: t.firstStartTime || t.startTime });

const step1 = (prev, next, now, who = { workerId: 'w1', workerName: '山田' }) =>
  applySessionTransitions({ prev, next, now, ...who });

test('T01 通常完了: 5分作業して完了 → 1セッション・5分・開始と終了が残る', () => {
  const k = 's1-0';
  let prev = { [k]: { status: 'waiting', duration: 0, startTime: null } };
  let next = step1(prev, { [k]: startWrite(prev[k], T0) }, T0);
  assert.equal(sessionsOf(next[k]).length, 1);
  assert.equal(hasOpenSession(next[k]), true);

  prev = next;
  next = step1(prev, { [k]: completeWrite(prev[k], T0 + 5 * M) }, T0 + 5 * M);
  const ss = sessionsOf(next[k]);
  assert.equal(ss.length, 1);
  assert.equal(min(sessionsDurationMs(next[k])), 5);
  assert.equal(ss[0].startTime, T0);
  assert.equal(ss[0].endTime, T0 + 5 * M);
  assert.equal(ss[0].quality, 'confirmed');
  // 互換フィールドを壊していない
  assert.equal(next[k].duration, 300);
  assert.equal(next[k].firstStartTime, T0);
});

test('T02 中断再開: 2分作業→3分停止→4分再開 → 2セッション・実作業6分(25分にしない)', () => {
  const k = 's1-0';
  let cur = { status: 'waiting', duration: 0, startTime: null };
  let prev = { [k]: cur };
  let next = step1(prev, { [k]: startWrite(cur, T0) }, T0);                                  // 10:00 開始
  prev = next; next = step1(prev, { [k]: pauseWrite(prev[k], T0 + 2 * M) }, T0 + 2 * M);      // 10:02 停止
  prev = next; next = step1(prev, { [k]: startWrite(prev[k], T0 + 5 * M) }, T0 + 5 * M);      // 10:05 再開
  prev = next; next = step1(prev, { [k]: completeWrite(prev[k], T0 + 9 * M) }, T0 + 9 * M);   // 10:09 完了

  const ss = sessionsOf(next[k]);
  assert.equal(ss.length, 2, '2セッション');
  assert.equal(min(sessionsDurationMs(next[k])), 6, '実作業6分');
  // firstStartTime〜endTime の単純差は9分。これを確定実績にしてはいけない(仕様書の禁止事項)
  assert.equal(min(next[k].endTime - next[k].firstStartTime), 9);
  assert.notEqual(min(sessionsDurationMs(next[k])), 9);
});

test('T15 担当交代: Aが開始しBが再開・完了 → 各セッションが正しい担当に帰属する', () => {
  const k = 's1-0';
  const A = { workerId: 'wA', workerName: '尾田' };
  const B = { workerId: 'wB', workerName: '片山' };
  let prev = { [k]: { status: 'waiting', duration: 0, startTime: null } };
  let next = step1(prev, { [k]: startWrite(prev[k], T0) }, T0, A);
  prev = next; next = step1(prev, { [k]: pauseWrite(prev[k], T0 + 3 * M) }, T0 + 3 * M, A);
  prev = next; next = step1(prev, { [k]: startWrite(prev[k], T0 + 4 * M) }, T0 + 4 * M, B);
  prev = next; next = step1(prev, { [k]: completeWrite(prev[k], T0 + 9 * M) }, T0 + 9 * M, B);

  const ss = sessionsOf(next[k]);
  assert.equal(ss.length, 2);
  assert.equal(ss[0].workerId, 'wA', '1本目は開始した A');
  assert.equal(ss[1].workerId, 'wB', '2本目は再開した B');
  assert.equal(min(ss[0].endTime - ss[0].startTime), 3);
  assert.equal(min(ss[1].endTime - ss[1].startTime), 5);
  // 旧実装は workerName / lot.workerId が最終担当へ寄っていた。セッション単位なら寄らない
  assert.notEqual(ss[0].workerId, ss[1].workerId);
});

test('T18 手入力の時間は estimated: 打刻がないものを確定と混ぜない', () => {
  const t = setEstimatedSession({ status: 'completed', duration: 600 }, { startTime: T0, durationSec: 600 });
  assert.equal(sessionsOf(t)[0].quality, 'estimated');
  assert.equal(min(sessionsDurationMs(t)), 10);
});

test('T17 打刻なしのタスクはセッションを作らない (0秒の確定値にしない)', () => {
  const k = 's1-0';
  // 開いていない状態で閉じようとしても何も起きない
  const closed = closeSession({ status: 'completed', duration: 300 }, { now: T0 });
  assert.equal(sessionsOf(closed).length, 0);
  // startTime の出入りが無ければ applySessionTransitions も触らない
  const prev = { [k]: { status: 'completed', duration: 300, startTime: null } };
  const next = step1(prev, { [k]: { ...prev[k], duration: 400 } }, T0);
  assert.equal(sessionsOf(next[k]).length, 0);
});

test('冪等性: 同じ開始/終了が二度適用されても二重に増えない (※競合解決ではない。同時操作は不可)', () => {
  const k = 's1-0';
  let t = openSession({ status: 'processing' }, { now: T0, workerId: 'w1' });
  t = openSession(t, { now: T0, workerId: 'w1' });          // 別端末からもう一度
  assert.equal(sessionsOf(t).length, 1);
  t = closeSession(t, { now: T0 + 5 * M });
  t = closeSession(t, { now: T0 + 8 * M });                  // 二度目の完了通知
  assert.equal(min(sessionsDurationMs(t)), 5, '後から来た終了時刻で伸びない');
});

test('時計ずれ: 終了が開始より前でも負の区間を作らない', () => {
  let t = openSession({}, { now: T0 });
  t = closeSession(t, { now: T0 - 10 * M });
  assert.equal(sessionsDurationMs(t), 0);
});

test('容量: 一時停止を繰り返しても上限を超えず、合計時間は失われない', () => {
  let t = { status: 'waiting' };
  let total = 0;
  for (let i = 0; i < MAX_SESSIONS_PER_TASK + 25; i++) {
    t = openSession(t, { now: T0 + i * 10 * M });
    t = closeSession(t, { now: T0 + i * 10 * M + 1 * M });
    total += 1;
  }
  assert.ok(sessionsOf(t).length <= MAX_SESSIONS_PER_TASK, `上限${MAX_SESSIONS_PER_TASK}以内`);
  assert.equal(min(sessionsDurationMs(t)), total, '畳んでも合計時間は保たれる');
  assert.equal(sessionsOf(t)[0].quality, 'estimated', '畳んだ区間は確定にしない');
});

test('一括開始: 5台を同時に開始しても各台に1セッションずつ付く(台別実績は台別のまま)', () => {
  const prev = {}; const next = {};
  for (let u = 0; u < 5; u++) {
    prev[`s1-${u}`] = { status: 'waiting', duration: 0, startTime: null };
    next[`s1-${u}`] = startWrite(prev[`s1-${u}`], T0);
  }
  const out = step1(prev, next, T0);
  for (let u = 0; u < 5; u++) assert.equal(sessionsOf(out[`s1-${u}`]).length, 1);
});
