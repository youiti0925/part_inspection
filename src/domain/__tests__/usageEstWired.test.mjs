// 🧮 P-L1・P-L2(2026-09-27 製品と同じ直し): 課金の見込みの帳面が App に配線されていて、**画面の数字には入っていない** 事を見張る。
//   部品は画面の帳面(readTally)を購読ごとの countReads で数えるので、推定は Firestore の関数に着せる覆い(FS_EST)で数える。
//   壊し方: 窓口へ覆いの無い FS_API を渡す → UW-4 赤 / 送り直しを merge:false にする → UW-2 赤 /
//           写しの上の段に推定の数を入れる → UW-1 赤 / 画面の帳面に推定を足す → UW-3 赤。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOf } from './_code.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const app = codeOf(path.join(path.resolve(HERE, '..', '..', '..'), 'src', 'App.jsx'));

test('UW-1 その日の写し(90秒後)は今までどおり。推定は入れ子の est にだけ添える', () => {
  assert.ok(app.includes('if (estLog && estLog.key === built.data.dayKey) data = { ...built.data, est: estSummary(estLog) };'), '推定を est 以外に入れている');
  assert.ok(app.includes('DATA(db).save(APP_DATA_ID, USAGE_COL, built.docId, data, { merge: false })'), '写しの書き方が変わった');
  assert.ok(app.includes('const snap = { key: quotaWindowKey(now), total: t.total, byCol: { ...(t.byCol || {}) } };'), '写しの上の段を画面の帳面から作っていない');
  assert.ok(app.includes('const built = buildUsageDoc({ appId: APP_DATA_ID, deviceId, readLog: snap, writeLog: null, nowMs: now });'), '写しの上の段が変わった');
});

test('UW-2 締まった日は同じ書類へ入れ子の full だけを merge:true で送り直す(先に「送った」と覚える)', () => {
  const i = app.indexOf('const sendPrevUsage = () => {');
  const body = app.slice(i, app.indexOf('const schedulePrevUsage', i));
  assert.ok(i > 0, '送り直しが無い');
  assert.ok(body.includes('buildPrevUsageDoc({ appId: APP_DATA_ID, deviceId, prev, nowMs: Date.now() })'));
  assert.ok(body.includes('DATA(db).save(APP_DATA_ID, USAGE_COL, built.docId, built.data, { merge: true })'), '写しを消す書き方(merge:false)になっている');
  const iMark = body.indexOf('markPrevSent(list, prev.key, true)');
  const iSave = body.indexOf('DATA(db).save(');
  assert.ok(iMark > 0 && iMark < iSave, '書く前に「送った」と覚えていない(枠切れの日に書き込みが重なる)');
});

test('UW-3 画面の読みメーターは今までの帳面だけを見る(推定の帳面は画面に出さない)', () => {
  const i = app.indexOf('const countReads = useCallback(');
  const body = app.slice(i, app.indexOf('}, []);', i));
  assert.ok(i > 0, '画面の帳面(countReads)が見つからない');
  assert.ok(!/\best[A-Z]\w*\(|\bEST\./.test(body), '画面の帳面の数えに推定の帳面が混ざっている');
  assert.ok(body.includes('readTallyRef.current = tallyAdd(readTallyRef.current, dayNow, col, add,'), '画面の帳面の足し方が変わった');
  // 推定の帳面(EST)を画面の state に入れていない
  assert.ok(!/set[A-Z]\w*\(\s*EST\./.test(app), '推定の帳面を画面の state に入れている');
  assert.ok(!/setReadTally\([^)]*est/i.test(app), '画面の帳面に推定を渡している');
});

test('UW-4 窓口(DATA)は数えるだけの覆い(FS_EST)を使う。覆いは同じ関数を呼ぶだけ', () => {
  assert.ok(app.includes('const FS_EST = estMeter(FS_API);'));
  assert.ok(app.includes('return providerFor(db, FS_EST, _routeProviders, _routePbConfig);'), '窓口へ覆いの無い FS_API を渡している(推定が数えられない)');
  const i = app.indexOf('const estMeter = (api) => {');
  const body = app.slice(i, app.indexOf('const FS_EST', i));
  // 画面の帳面(countReads)を覆いの中で呼ばない = 画面の数字を二重に数えない
  assert.ok(!body.includes('countReads'), '覆いが画面の帳面を数えている(画面の数字が変わる)');
  // エラー用の関数は渡された時だけ着ける(渡されていない購読の Firestore の動きを変えない)
  assert.ok(body.includes("typeof onErr === 'function' ? [(e) => { estSubEnd(estSub); return onErr(e); }] : []"));
});
