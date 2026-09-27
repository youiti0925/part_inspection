// 👀 手本を見た記録
//
// ⚠⚠ この試験の主役は3つ:
//   ① **「開いた」を「見た」にしない**（display:none の iframe で既読が付いた前例がある）
//   ② **多端末で相手の記録を消さない**（配列に足す形は後勝ちで消える）
//   ③ **人を追い立てる言葉を出さない**（見張られていると感じたら現場は開かなくなる）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WATCHED_MIN_SEC, isWatched, watcherKey, watchPatch, watchers,
  watchNote, hasWatched, watchDeletePatch, addPlayed, MAX_STEP_SEC,
} from '../videoWatchLog.js';

// ⚠Firestore の merge:true と同じ「深い」混ぜ方。浅く書くと、正しい実装が落ちて
//   壊れた実装(相手の記録を消す)が通ってしまう。
const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v);
const deepMerge = (a, b) => {
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) out[k] = isMap(v) && isMap(out[k]) ? deepMerge(out[k], v) : v;
  return out;
};
const T0 = 1_800_000_000_000;

test('V01 ⚠⚠開いただけ・止めたままは「見た」にしない', () => {
  assert.equal(isWatched(0, 300), false, '開いただけ');
  assert.equal(isWatched(3, 300), false, '3秒では見たとは言えない');
  assert.equal(isWatched(WATCHED_MIN_SEC, 300), true);
  assert.equal(isWatched(60, 300), true);
});

test('V02 短い手本は割合で見る(15秒の手本に10秒は厳しすぎる)', () => {
  assert.equal(isWatched(8, 15), true, '15秒の半分を超えている');
  assert.equal(isWatched(6, 15), false);
  // 長さが分からない時は10秒
  assert.equal(isWatched(9, 0), false);
  assert.equal(isWatched(11, 0), true);
});

test('V03 ⚠⚠再生が進んだ分だけ数える(飛ばし・早送りを足さない)', () => {
  let p = 0;
  p = addPlayed(p, 0, 0.5); p = addPlayed(p, 0.5, 1.0);      // ふつうに再生
  assert.equal(Math.round(p * 10) / 10, 1);
  p = addPlayed(p, 1.0, 31.0);                                // 30秒飛ばした
  assert.equal(Math.round(p * 10) / 10, 1, '⚠飛ばした分を足すと、送るだけで既読になる');
  p = addPlayed(p, 31.0, 20.0);                               // 巻き戻し
  assert.equal(Math.round(p * 10) / 10, 1, '巻き戻しは0扱い');
  p = addPlayed(p, 20.0, 20.0 + MAX_STEP_SEC);                // 境目はまだ足す
  assert.equal(Math.round(p * 10) / 10, 1 + MAX_STEP_SEC);
});

test('V04 ⚠⚠多端末で同時に見ても、相手の記録を消さない', () => {
  let log = {};
  // 2人が同時に見終わった
  const a = watchPatch(log, '坂井', { playedSec: 60, durationSec: 300, nowMs: T0 });
  const b = watchPatch(log, '平野', { playedSec: 60, durationSec: 300, nowMs: T0 + 1000 });
  log = deepMerge(deepMerge({ watch: log }, a), b).watch;
  assert.deepEqual(watchers(log).map(w => w.name).sort(), ['坂井', '平野']);
});

test('V05 同じ人が何度見ても1件のまま(回数と最後に見た日が増える)', () => {
  let log = {};
  log = deepMerge({ watch: log }, watchPatch(log, '坂井', { playedSec: 60, durationSec: 300, nowMs: T0 })).watch;
  log = deepMerge({ watch: log }, watchPatch(log, '坂井', { playedSec: 90, durationSec: 300, nowMs: T0 + 86400000 })).watch;
  const w = watchers(log);
  assert.equal(w.length, 1, '⚠毎回足すと、いずれ1MBに当たる');
  assert.equal(w[0].times, 2);
  assert.equal(w[0].firstAt, T0, '⚠初めて見た日は上書きしない(いつ教えたかの記録)');
  assert.equal(w[0].lastAt, T0 + 86400000);
  assert.equal(w[0].maxSec, 90, '見た秒は最長の1回だけ(足すと現実離れする)');
});

test('V06 ⚠名前が無い / 見たと言えない時は書かない', () => {
  assert.equal(watchPatch({}, '', { playedSec: 60, durationSec: 300 }), null, '誰の記録か分からない物を残さない');
  assert.equal(watchPatch({}, '   ', { playedSec: 60, durationSec: 300 }), null);
  assert.equal(watchPatch({}, '坂井', { playedSec: 2, durationSec: 300 }), null, '開いただけでは書かない');
});

test('V07 ⚠鍵に使えない字で壊れない', () => {
  assert.equal(/[.[\]#$/\s]/.test(watcherKey('坂 井/A.B')), false, watcherKey('坂 井/A.B'));
  assert.ok(watcherKey('坂井').startsWith('w_'));
  assert.equal(watcherKey(null), '');
});

test('V08 ⚠⚠追い立てる言葉を出さない(見ていない人を名指ししない)', () => {
  const note0 = watchNote({});
  assert.ok(/まだ見た記録がありません/.test(note0), note0);
  assert.equal(/誰も見ていない/.test(note0), false, '⚠「誰も見ていない」は見ていない証明ではない');
  let log = {};
  for (const n of ['坂井', '平野', '村', '片山']) {
    log = deepMerge({ watch: log }, watchPatch(log, n, { playedSec: 60, durationSec: 300, nowMs: T0 })).watch;
  }
  const note = watchNote(log);
  assert.ok(/4人が見ました/.test(note), note);
  assert.equal(/未受講|見ていない|まだの人/.test(note), false, '⚠追い立てる言葉が入っている');
});

test('V09 ⚠⚠点数も合否も入れない(人の評価に使えない形にしておく)', () => {
  const p = watchPatch({}, '坂井', { playedSec: 60, durationSec: 300, nowMs: T0 });
  const v = p.watch[watcherKey('坂井')];
  for (const bad of ['score', 'level', 'pass', 'grade', 'rank', 'ok', 'ng']) {
    assert.equal(bad in v, false, `⚠${bad} が入っている = 査定に使われる`);
  }
  assert.deepEqual(Object.keys(v).sort(), ['firstAt', 'lastAt', 'maxSec', 'name', 'times']);
});

test('V10 間違えて別の人の名前で見た時に消せる(鍵は消せないので消した印)', () => {
  let log = deepMerge({ watch: {} }, watchPatch({}, '坂井', { playedSec: 60, durationSec: 300, nowMs: T0 })).watch;
  assert.equal(hasWatched(log, '坂井'), true);
  log = deepMerge({ watch: log }, watchDeletePatch('坂井')).watch;
  assert.equal(hasWatched(log, '坂井'), false);
  assert.equal(watchers(log).length, 0);
  assert.equal(log[watcherKey('坂井')].deleted, true, '鍵は消せない(merge:true)ので印を置く');
});

test('V11 見た人は新しい順に並ぶ', () => {
  let log = {};
  log = deepMerge({ watch: log }, watchPatch(log, '古い人', { playedSec: 60, durationSec: 300, nowMs: T0 })).watch;
  log = deepMerge({ watch: log }, watchPatch(log, '新しい人', { playedSec: 60, durationSec: 300, nowMs: T0 + 999 })).watch;
  assert.deepEqual(watchers(log).map(w => w.name), ['新しい人', '古い人']);
});

test('V12 壊れた入力でも落ちない', () => {
  for (const bad of [null, undefined, 'x', 5, { a: null }, { a: { name: '' } }]) {
    assert.equal(Array.isArray(watchers(bad)), true);
    assert.equal(typeof watchNote(bad), 'string');
    assert.equal(typeof hasWatched(bad, '坂井'), 'boolean');
  }
});
