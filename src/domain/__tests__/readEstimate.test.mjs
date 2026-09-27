// 🧮 P-L1・P-L2(2026-09-27): 課金の見込みの帳面(画面には出さない・usage_daily の est / full にだけ載せる)。
//   所見 P-L1: 開きっぱなしのPCが約1時間ごとの短いつながり直しのたびに「全部読み直した」と数えられ、
//              1台で1日 約1.1〜1.2万を多めに出していた(課金は変わった分だけのはず)。
//   所見 P-L2: usage_daily は「開いて90秒後の写し」だけで昼の分を捨てる/FromServer・REST を数えない/
//              置き場所の名前が最後の区切りだけ/タブ同士で帳面を上書きする。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pathColName, emptyEstLog, emptyEstDelta, estDeltaAdd, estDeltaEmpty, mergeEstDelta,
  pushPrevLog, nextPrevToSend, markPrevSent, estSummary, buildPrevUsageDoc,
  listenerEstimate, oneShotEstimate, isLongGap, LONG_GAP_MS, PREV_KEEP,
} from '../readEstimate.js';
import { quotaWindowKey } from '../readBudget.js';
import { summarizeUsage, buildUsageDoc } from '../usageRollup.js';

const T = Date.UTC(2026, 8, 27, 3, 0, 0);   // 日本 12:00(米国西部 9/26 20:00)
const DAY = 86400000;

test('RE-1 置き場所ごとの名前(最終の lots と製品の lots を混ぜない)', () => {
  assert.equal(pathColName(['artifacts', 'final-inspection-v1', 'public', 'data', 'lots']), 'final-inspection-v1/lots');
  assert.equal(pathColName(['artifacts', 'product-inspection-v1', 'public', 'data', 'settings', 'config'], true), 'product-inspection-v1/settings');
  assert.equal(pathColName(['something', 'col']), 'col');
  assert.equal(pathColName([]), '(不明)');
});

test('RE-2 足し算で書く: 2つのタブの差分が両方残る。日が変わったら前の日を締めて返す(捨てない)', () => {
  let stored = null;
  const tabA = estDeltaAdd(estDeltaAdd(emptyEstDelta(), 'p/lots', 470), 'p/templates', 34);
  const tabB = estDeltaAdd(emptyEstDelta(), 'p/lots', 5);
  ({ log: stored } = mergeEstDelta(stored, tabA, T, { openKey: quotaWindowKey(T) }));
  ({ log: stored } = mergeEstDelta(stored, tabB, T + 1000, { openKey: quotaWindowKey(T) }));
  assert.equal(stored.total, 509);
  assert.deepEqual(stored.byCol, { 'p/lots': 475, 'p/templates': 34 });
  assert.equal(stored.carriedOver, false);
  // 米国西部の0時(日本16:00)をまたぐ: 前の日が prev で返り、新しい日に差分が入る。開いたまま = carriedOver
  const later = Date.UTC(2026, 8, 27, 8, 0, 0);   // 日本 17:00
  const { log, prev } = mergeEstDelta(stored, { ...estDeltaAdd(emptyEstDelta(), 'p/lots', 3), aliveAt: later }, later, { openKey: quotaWindowKey(T) });
  assert.equal(prev.total, 509);
  assert.equal(prev.key, quotaWindowKey(T));
  assert.equal(log.total, 3);
  assert.notEqual(log.key, prev.key);
  assert.equal(log.carriedOver, true, '開いたまま日をまたいだ印');
  assert.equal(log.aliveAt, later);
  // 壊れた帳面でも落ちない
  assert.equal(mergeEstDelta('x', null, T).log.total, 0);
  assert.equal(estDeltaEmpty(emptyEstDelta()), true);
  assert.equal(estDeltaEmpty(estDeltaAdd(emptyEstDelta(), 'a', 1)), false);
});

test('RE-3 購読の数え方: 短いつながり直しは変わった分だけ・30分以上や控えが使えない時は全件', () => {
  // 開きっぱなしのPCの ①′(470件・includeMetadataChanges あり)。約1時間ごとに短く切れて戻る(控え→サーバ)。
  let est = 0, meterOld = 0;
  let r = listenerEstimate({ first: true, fresh: true, fromCache: false, size: 470, changes: 470, skip: false });
  est += r.add; meterOld += 470;
  for (let i = 0; i < 23; i++) {
    r = listenerEstimate({ first: false, fresh: true, fromCache: true, size: 470, changes: 0, skip: r.skipNext });
    est += r.add;
    r = listenerEstimate({ first: false, fresh: true, fromCache: false, size: 470, changes: 2, skip: r.skipNext });
    est += r.add; meterOld += 470;   // 今までの画面の帳面は、控えの後のサーバの答えを全件と数えていた
  }
  assert.equal(meterOld, 470 * 24);
  assert.equal(est, 470 + 23 * 2, '短いつながり直しは変わった書類の分だけ');
  // 30分以上の空白の後(estBillAll が全件を数えて skip を立てる)→ 次のサーバの合図は数えない
  r = listenerEstimate({ first: false, fresh: true, fromCache: false, size: 470, changes: 3, skip: true });
  assert.equal(r.add, 0);
  // 開いた時: 30分以内に開いていた端末(控えの続き) → 控えの1回目は0・サーバは変わった分
  r = listenerEstimate({ first: true, fresh: false, fromCache: true, size: 470, changes: 0, skip: false });
  assert.deepEqual(r, { add: 0, skipNext: false });
  r = listenerEstimate({ first: false, fresh: false, fromCache: false, size: 471, changes: 1, skip: r.skipNext });
  assert.equal(r.add, 1);
  // 開いた時: 30分以上だれも開いていない(控えが使えない)→ 控えから出た1回目でも全件、次のサーバは数えない
  r = listenerEstimate({ first: true, fresh: true, fromCache: true, size: 470, changes: 0, skip: false });
  assert.deepEqual(r, { add: 470, skipNext: true });
  r = listenerEstimate({ first: false, fresh: true, fromCache: false, size: 470, changes: 4, skip: r.skipNext });
  assert.equal(r.add, 0);
  // 0件の問い合わせも1件ぶん
  assert.equal(listenerEstimate({ first: true, fresh: true, fromCache: false, size: 0, changes: 0 }).add, 1);
  assert.equal(oneShotEstimate(0), 1);
  assert.equal(oneShotEstimate(393), 393);
  assert.equal(isLongGap(0, LONG_GAP_MS), true);
  assert.equal(isLongGap(0, LONG_GAP_MS - 1), false);
});

test('RE-4 締まった日の並び: 空の日は入れない・同じ日は差し替え・7日まで・今の日は選ばない', () => {
  const day = (k, n) => ({ ...emptyEstLog(T), key: k, total: n });
  let list = [];
  list = pushPrevLog(list, day('2026-09-20', 0));
  assert.equal(list.length, 0, '中身の無い日は送らない');
  list = pushPrevLog(list, day('2026-09-21', 10), { key: '2026-09-21', total: 99, opens: 2, byCol: { lots: 99 } });
  list = pushPrevLog(list, day('2026-09-21', 12));
  assert.equal(list.length, 1);
  assert.equal(list[0].total, 12);
  for (let i = 22; i <= 30; i++) list = pushPrevLog(list, day(`2026-09-${i}`, i));
  assert.equal(list.length, PREV_KEEP);
  assert.equal(nextPrevToSend(list, '2026-09-24').key, '2026-09-25', '今の日は選ばず、古い順');
  list = markPrevSent(list, '2026-09-25', true);
  assert.equal(nextPrevToSend(list, '2026-09-24').key, '2026-09-26');
  assert.equal(nextPrevToSend([], 'x'), null);
  const withOld = pushPrevLog([], day('2026-09-21', 10), { key: '2026-09-21', total: 99, opens: 2, byCol: { lots: 99 } });
  assert.deepEqual(withOld[0].old, { reads: 99, opens: 2, byCol: { lots: 99 } });
});

test('RE-5 🚨 送り直す中身は入れ子の full だけ(上の段の reads・opens・byCol・dayKey は書かない)', () => {
  const prev = { ...emptyEstLog(T), key: '2026-09-26', total: 1234, opens: 3, byCol: { 'final-inspection-v1/lots': 393, 'product-inspection-v1/lots': 841 }, old: { reads: 14668, opens: 1, byCol: { lots: 13787 } } };
  const built = buildPrevUsageDoc({ appId: 'product-inspection-v1', deviceId: '6b1375cf00000000', prev, nowMs: T });
  assert.equal(built.docId, '2026-09-26__6b1375cf00000000');
  assert.deepEqual(Object.keys(built.data), ['full']);
  assert.equal(built.data.full.est.reads, 1234);
  assert.equal(built.data.full.old.reads, 14668);
  assert.equal(built.data.full.dayKey, '2026-09-26');
  assert.equal(buildPrevUsageDoc({ appId: 'product-inspection-v1', deviceId: 'bad', prev, nowMs: T }), null);
  assert.equal(buildPrevUsageDoc({ appId: 'product-inspection-v1', deviceId: '6b1375cf00000000', prev: { key: 'x' } }), null);
});

test('RE-6 🚨 ③の使用量の画面(summarizeUsage)は、写しに est / full を足しても同じ数字', () => {
  const readLog = { key: '2026-09-26', total: 700, opens: 1, byCol: { lots: 527, templates: 34 } };
  const snap = buildUsageDoc({ appId: 'product-inspection-v1', deviceId: '6852d70000000000', readLog, nowMs: T });
  const est = estSummary({ ...emptyEstLog(T), total: 600, byCol: { 'product-inspection-v1/lots': 527 } });
  const full = buildPrevUsageDoc({ appId: 'product-inspection-v1', deviceId: '6852d70000000000', prev: { ...emptyEstLog(T), key: '2026-09-26', total: 2000 }, nowMs: T }).data.full;
  const before = summarizeUsage([snap.data]);
  const after = summarizeUsage([{ ...snap.data, est, full }]);   // merge:true で入れ子が足された書類
  assert.deepEqual(after, before);
});

test('RE-7 usage_daily に載せる形: 数えていない物は載せない・キーは並べ替える', () => {
  const s = estSummary({ ...emptyEstLog(T), total: 5, byCol: { b: 2, a: 3, z: 0 }, reconnects: { short: 4, long: 1 }, longGapsMin: [42] });
  assert.deepEqual(Object.keys(s.byCol), ['a', 'b']);
  assert.deepEqual(s.reconnects, { short: 4, long: 1 });
  assert.deepEqual(s.longGapsMin, [42]);
  assert.equal(estSummary(null), null);
  assert.ok(DAY > 0);
});
