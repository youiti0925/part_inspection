// 🎥 教材の自動チャプター化 (仕様書 §4-3) のテスト。
//   「エースが普通に1回作業するだけで工程ごとの章ができる」= 打刻の畳み方が全て。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChapters, buildBreakEvents, stepKeysOfChapters, trainingRecipeTitle } from '../trainingChapters.js';

const mk = (stepKey, kind, at, label = '') => ({ stepKey, kind, at, label });

test('工程の「最初の開始」→「最後の完了」で1章', () => {
  const ch = buildChapters({ marks: [mk('s1', 'start', 10, '面板取付'), mk('s1', 'end', 70)], durationSec: 120 });
  assert.equal(ch.length, 1);
  assert.equal(ch[0].stepKey, 's1');
  assert.equal(ch[0].start, 10);
  assert.equal(ch[0].end, 70);
  assert.equal(ch[0].label, '面板取付');
  assert.equal(ch[0].source, 'auto');
});

test('まとめて開始(台数分の打刻)は1章に畳む — 開始は最初・完了は最後', () => {
  const ch = buildChapters({
    marks: [
      mk('s1', 'start', 10), mk('s1', 'start', 10.2), mk('s1', 'start', 10.4), // 4台まとめて開始
      mk('s1', 'end', 60), mk('s1', 'end', 62), mk('s1', 'end', 65),
    ],
    durationSec: 120,
  });
  assert.equal(ch.length, 1);
  assert.equal(ch[0].start, 10);
  assert.equal(ch[0].end, 65);
});

test('同じ工程を後で再開したら同じ章の end を伸ばす(章は工程ごとに最大1つ)', () => {
  const ch = buildChapters({
    marks: [mk('s1', 'start', 5), mk('s1', 'end', 20), mk('s2', 'start', 21), mk('s2', 'end', 40), mk('s1', 'start', 41), mk('s1', 'end', 55)],
    durationSec: 120,
  });
  assert.equal(ch.length, 2);
  const s1 = ch.find(c => c.stepKey === 's1');
  const s2 = ch.find(c => c.stepKey === 's2');
  assert.equal(s1.start, 5);
  assert.equal(s1.end, 55);   // 伸びる
  // 章同士が時間的に重なってよい(区間再生なので問題にならない)
  assert.ok(s2.start > s1.start && s2.end < s1.end);
});

test('開始しか打刻が無い(録画終了まで作業していた)章は動画の末尾まで', () => {
  const ch = buildChapters({ marks: [mk('s9', 'start', 30)], durationSec: 200 });
  assert.equal(ch[0].start, 30);
  assert.equal(ch[0].end, 200);
});

test('録画開始時に既に動いていた工程(endしか来ない)は頭からの章になる', () => {
  const ch = buildChapters({ marks: [mk('s9', 'end', 45)], durationSec: 200 });
  assert.equal(ch[0].start, 0);
  assert.equal(ch[0].end, 45);
});

test('末尾は実際の動画の長さで clamp する(打刻の相対秒がはみ出しても壊れない)', () => {
  const ch = buildChapters({ marks: [mk('s1', 'start', 10), mk('s1', 'end', 999)], durationSec: 100 });
  assert.equal(ch[0].end, 100);
  assert.ok(ch[0].start < ch[0].end);
});

test('長さ0の章は作らない(押してすぐ止めても最低1秒の区間になる)', () => {
  const ch = buildChapters({ marks: [mk('s1', 'start', 10), mk('s1', 'end', 10)], durationSec: 100 });
  assert.ok(ch[0].end - ch[0].start >= 1);
});

test('動画のほぼ末尾で打刻された章は手前へ寄せる(start<end を必ず保つ)', () => {
  const ch = buildChapters({ marks: [mk('s1', 'start', 100), mk('s1', 'end', 100)], durationSec: 100 });
  assert.ok(ch[0].start < ch[0].end);
  assert.ok(ch[0].end <= 100);
});

test('打刻が順不同で来ても並べ直して正しく畳む', () => {
  const ch = buildChapters({ marks: [mk('s1', 'end', 70), mk('s1', 'start', 10)], durationSec: 120 });
  assert.equal(ch[0].start, 10);
  assert.equal(ch[0].end, 70);
});

test('章は開始の早い順に並ぶ', () => {
  const ch = buildChapters({
    marks: [mk('b', 'start', 50), mk('b', 'end', 60), mk('a', 'start', 5), mk('a', 'end', 9)],
    durationSec: 120,
  });
  assert.deepEqual(ch.map(c => c.stepKey), ['a', 'b']);
});

test('打刻が無ければ章も無い(空の教材を作らない)', () => {
  assert.deepEqual(buildChapters({ marks: [], durationSec: 100 }), []);
});

test('休憩は既存のレシピ形式(skip)で積む — 新しい種類のイベントを作らない', () => {
  const ev = buildBreakEvents({ breaks: [{ start: 30, end: 90 }], durationSec: 200 });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'skip');
  assert.equal(ev[0].start, 30);
  assert.equal(ev[0].end, 90);
  assert.equal(ev[0].label, '休憩');
});

test('ごく短い中断(数秒)は skip にしない(見る人が置いていかれる)', () => {
  assert.equal(buildBreakEvents({ breaks: [{ start: 30, end: 31 }], durationSec: 200 }).length, 0);
});

test('休憩も動画の長さで clamp する', () => {
  const ev = buildBreakEvents({ breaks: [{ start: 30, end: 999 }], durationSec: 100 });
  assert.equal(ev[0].end, 100);
});

test('stepKeys は章の stepKey を uniq した物(既存の🎬表示の互換に必須)', () => {
  const ch = [{ stepKey: 's1' }, { stepKey: 's2' }, { stepKey: 's1' }, { stepKey: '' }];
  assert.deepEqual(stepKeysOfChapters(ch), ['s1', 's2']);
  assert.deepEqual(stepKeysOfChapters(null), []);
});

test('タイトルは 教材 {型式} {M/DD} {作業者}', () => {
  const t = trainingRecipeTitle({ model: 'ABC-1', at: new Date(2026, 7, 8, 10, 0).getTime(), workerName: '山田' });
  assert.equal(t, '教材 ABC-1 8/08 山田');
});
