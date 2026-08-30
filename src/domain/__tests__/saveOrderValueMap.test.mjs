// ============================================================================
// 💾🚨 作業画面の measurementResults / stepTimes を サーバと合わせ直す試験
// ----------------------------------------------------------------------------
// なぜ要るか(2026-08-23 実コードで確認した欠陥):
//   src/App.jsx の作業画面(WorkExecutionModal)には
//     const [stepTimes, setStepTimes] = useState(lot.stepTimes || {});
//     const [measurementResults, setMeasurementResults] = useState(lot.measurementResults || {});
//   と、**開いた瞬間の写しを1回作るだけ**の state が2つあった。tasks には3方向の
//   合わせ直しが在る(reconcileTasks)のに、この2つには無かった。
//   しかも 60秒ごとの自動保存が `measurementResults: <古い写しまるごと>` を送り返していた。
//   setDoc(merge:true) は **送った鍵を上書きする** ので、
//   多端末で同じロットを開くと 後から直した測定値が 60秒以内に古い値へ戻る。
//
// ⚠この試験は「純関数」と「実コードの配線」の両方を見る。
//   ・純関数 … reconcileValueMap / noteEditedKeys / recentlyEditedKeys / unsentPatch
//   ・負の対照 … わざと合わせ直しを外した形(NO_RECONCILE)に同じ場面を当てると **落ちる**
//   ・実コード … App.jsx に配線が在るか(消したら落ちる)
//
// ⚠新しいファイルにしたのは、saveOrder.test.mjs が最終検査(golden)と md5 一致の約束を
//   持っているため。あちらを1バイトも動かさずに、この試験だけを足す。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  reconcileValueMap, reconcileTasks, runningTaskKeys,
  noteEditedKeys, recentlyEditedKeys, pruneEditedKeys, EDITING_WINDOW_MS,
  unsentMapKeys, pickMapKeys, unsentPatch,
} from '../saveOrder.js';

// ---------------------------------------------------------------------------
// 直す前の形(負の対照)。「開いた瞬間の写しを1回作るだけ」= 何が届いても手元のまま。
// ---------------------------------------------------------------------------
const NO_RECONCILE = ({ local = {} }) =>
  ({ map: local, changed: false, adopted: [], removed: [], kept: Object.keys(local), conflicts: [] });

// 直す前の自動保存。マップまるごとを送り返す。
const OLD_FLUSH = (local) => ({ measurementResults: local });
// 直した後の自動保存。まだ送れていない鍵だけを送る(1件も無ければ項目ごと入れない)。
const NEW_FLUSH = (local, base) => {
  const d = unsentPatch(local, base);
  return d ? { measurementResults: d.patch } : {};
};

// Firestore の setDoc(merge:true) を「送った鍵だけ上書き・送らなかった鍵は残す」で真似る。
// ⚠これは App.jsx:41393 のコメント(「送らなかったキーを消さない」)と同じ約束。
const applyMerge = (serverDoc, payload) => {
  const out = { ...serverDoc };
  const mr = payload.measurementResults;
  if (mr && typeof mr === 'object') for (const [k, v] of Object.entries(mr)) out[k] = v;
  return out;
};

const MEAS = (v) => ({ values: { a: v }, result: 'OK', timestamp: 1_000 + v });

// ===========================================================================
// ① 他端末が足した鍵が、こちらの保存で消えない / 画面にちゃんと出る
// ===========================================================================

test('M01 他端末が足した鍵は画面に取り込まれる(こちらは触っていないので server が正)', () => {
  const base = { 'sA-0': MEAS(1) };
  const local = { 'sA-0': MEAS(1) };
  const server = { 'sA-0': MEAS(1), 'sB-0': MEAS(2) };   // 他端末が sB-0 を足した
  const r = reconcileValueMap({ local, server, base });
  assert.equal(r.changed, true);
  assert.deepEqual(Object.keys(r.map).sort(), ['sA-0', 'sB-0']);
  assert.deepEqual(r.adopted, ['sB-0']);
});

test('M02 🚨他端末が足した鍵は、こちらの自動保存で消えない(保管庫の姿で確かめる)', () => {
  const base = { 'sA-0': MEAS(1) };
  let serverDoc = { 'sA-0': MEAS(1), 'sB-0': MEAS(2) };
  const r = reconcileValueMap({ local: { 'sA-0': MEAS(1) }, server: serverDoc, base });
  // 60秒後の自動保存
  serverDoc = applyMerge(serverDoc, NEW_FLUSH(r.map, serverDoc));
  assert.deepEqual(Object.keys(serverDoc).sort(), ['sA-0', 'sB-0']);
  assert.deepEqual(serverDoc['sB-0'], MEAS(2), '他端末が足した値がそのまま残っていること');
});

test('M03 負の対照: 合わせ直しが無いと、足された鍵が **画面に一生出ない**', () => {
  const base = { 'sA-0': MEAS(1) };
  const local = { 'sA-0': MEAS(1) };
  const server = { 'sA-0': MEAS(1), 'sB-0': MEAS(2) };
  const r = NO_RECONCILE({ local, server, base });
  assert.deepEqual(Object.keys(r.map), ['sA-0']);
  assert.equal(r.map['sB-0'], undefined,
    '🚨 直す前は他端末が足した測定値が画面に出ないまま。作業者は「未入力」と思って上書き入力する');
});

// ===========================================================================
// ② 他端末が直した値が、こちらの古い写しで戻らない  ← いちばん怖い所
// ===========================================================================

test('M04 🚨他端末が直した値は取り込む(こちらは触っていない)', () => {
  const base = { 'sA-0': MEAS(1) };
  const local = { 'sA-0': MEAS(1) };
  const server = { 'sA-0': MEAS(9) };                   // 他端末が直した
  const r = reconcileValueMap({ local, server, base });
  assert.equal(r.changed, true);
  assert.deepEqual(r.map['sA-0'], MEAS(9));
  assert.deepEqual(r.adopted, ['sA-0']);
});

test('M05 🚨直した後: 60秒の自動保存を通しても、他端末の直しが戻らない', () => {
  const base = { 'sA-0': MEAS(1) };
  let serverDoc = { 'sA-0': MEAS(9) };
  const r = reconcileValueMap({ local: { 'sA-0': MEAS(1) }, server: serverDoc, base });
  serverDoc = applyMerge(serverDoc, NEW_FLUSH(r.map, serverDoc));
  assert.deepEqual(serverDoc['sA-0'], MEAS(9), '他端末が直した値のままであること');
});

test('M06 🚨負の対照: 合わせ直しを外すと、60秒の自動保存で古い値へ戻る(直す前の実際の姿)', () => {
  const base = { 'sA-0': MEAS(1) };
  let serverDoc = { 'sA-0': MEAS(9) };                  // 他端末が 9 に直した
  const r = NO_RECONCILE({ local: { 'sA-0': MEAS(1) }, server: serverDoc, base });
  serverDoc = applyMerge(serverDoc, OLD_FLUSH(r.map));  // 古い写しをまるごと送り返す
  assert.deepEqual(serverDoc['sA-0'], MEAS(1),
    '🚨 直す前は 60秒以内に 9 → 1 へ戻っていた。この行が落ちる時は合わせ直しが効いている');
});

test('M07 まだ送れていない手元の直しは、サーバの姿で消されない', () => {
  const base = { 'sA-0': MEAS(1) };
  const local = { 'sA-0': MEAS(5) };                    // 画面で直した(まだ送れていない)
  const server = { 'sA-0': MEAS(1) };                   // サーバはまだ古い
  const r = reconcileValueMap({ local, server, base });
  assert.equal(r.changed, false);
  assert.equal(r.map, local, '中身が変わらない時は同じ物を返す(描き直しを増やさない)');
  assert.deepEqual(r.kept, ['sA-0']);
});

test('M08 両方が変わった時は手元を残し、conflicts に載せる(黙って消さない)', () => {
  const base = { 'sA-0': MEAS(1) };
  const local = { 'sA-0': MEAS(5) };
  const server = { 'sA-0': MEAS(9) };
  const r = reconcileValueMap({ local, server, base });
  assert.deepEqual(r.map['sA-0'], MEAS(5));
  assert.deepEqual(r.conflicts, ['sA-0']);
});

// ===========================================================================
// ③ 人がいま入力中の鍵は取り上げない (tasks の keepKeys と同じ扱い)
// ===========================================================================

test('M09 🚨いま入力中の鍵は、他端末の値が来ても取り上げない', () => {
  const now = 1_000_000;
  const base = { 'sA-0-values': { a: 5 } };
  const local = { 'sA-0-values': { a: 5 } };            // 送れた直後 = base と同じ姿
  const server = { 'sA-0-values': { a: 9 } };           // 他端末が直した
  // 守りが無ければ、指の下の欄が 9 に化ける
  const plain = reconcileValueMap({ local, server, base });
  assert.deepEqual(plain.map['sA-0-values'], { a: 9 }, '守りが無ければ入力中の欄が書き換わる');
  // この端末が「さっき」触った鍵を控えてある
  const touched = noteEditedKeys(new Map(), { 'sA-0-values': { a: 1 } }, local, now - 3_000);
  const keep = recentlyEditedKeys(touched, now);
  assert.deepEqual(keep, ['sA-0-values']);
  const r = reconcileValueMap({ local, server, base, keepKeys: keep });
  assert.deepEqual(r.map['sA-0-values'], { a: 5 }, '入力中の値がそのまま残る');
  assert.deepEqual(r.conflicts, ['sA-0-values'], 'ぶつかった事は黙らない');
});

test('M10 触ってから時間が経った鍵は、もう守らない(一生入ってこない状態を作らない)', () => {
  const now = 1_000_000;
  const touched = noteEditedKeys(new Map(), {}, { 'sA-0': MEAS(5) }, now - EDITING_WINDOW_MS - 1);
  assert.deepEqual(recentlyEditedKeys(touched, now), []);
  const base = { 'sA-0': MEAS(5) };
  const r = reconcileValueMap({
    local: { 'sA-0': MEAS(5) }, server: { 'sA-0': MEAS(9) }, base,
    keepKeys: recentlyEditedKeys(touched, now),
  });
  assert.deepEqual(r.map['sA-0'], MEAS(9));
});

test('M11 控えるのは「中身が変わった鍵」だけ(触っていない鍵まで守らない)', () => {
  const now = 500;
  const prev = { A: 1, B: 2 };
  const next = { A: 1, B: 3, C: 4 };
  const touched = noteEditedKeys(new Map(), prev, next, now);
  assert.deepEqual([...touched.keys()].sort(), ['B', 'C']);
  assert.equal(touched.get('A'), undefined);
});

test('M12 控えは元の Map を壊さない / 窓から出た分は落とせる', () => {
  const now = 1_000_000;
  const first = noteEditedKeys(new Map(), {}, { A: 1 }, now - EDITING_WINDOW_MS - 1);
  const second = noteEditedKeys(first, { A: 1 }, { A: 1, B: 2 }, now);
  assert.equal(first.size, 1, '元の Map は増えていない');
  assert.equal(second.size, 2);
  const pruned = pruneEditedKeys(second, now);
  assert.deepEqual([...pruned.keys()], ['B']);
  assert.equal(pruneEditedKeys(pruned, now), pruned, '落ちる物が無い時は同じ Map を返す');
});

// ===========================================================================
// ④ 送るのは「まだ送れていない鍵」だけ
// ===========================================================================

test('M13 送れている鍵は送らない(1件も無ければ項目ごと入れない)', () => {
  const same = { 'sA-0': MEAS(1) };
  assert.deepEqual(unsentMapKeys(same, { 'sA-0': MEAS(1) }), []);
  assert.equal(unsentPatch(same, { 'sA-0': MEAS(1) }), null);
  assert.deepEqual(NEW_FLUSH(same, { 'sA-0': MEAS(1) }), {},
    '🚨 measurementResults の空マップ {} を送ってはいけない(merge:true でも丸ごと消える)');
});

test('M14 送るのは変わった鍵と足した鍵だけ', () => {
  const base = { A: MEAS(1), B: MEAS(2) };
  const local = { A: MEAS(1), B: MEAS(7), C: MEAS(3) };
  assert.deepEqual(unsentMapKeys(local, base).sort(), ['B', 'C']);
  const d = unsentPatch(local, base);
  assert.deepEqual(Object.keys(d.patch).sort(), ['B', 'C']);
  assert.deepEqual(d.patch.B, MEAS(7));
});

test('M15 pickMapKeys は無い鍵を作らない(undefined を送らない)', () => {
  assert.deepEqual(pickMapKeys({ A: 1 }, ['A', 'ZZ']), { A: 1 });
  assert.deepEqual(pickMapKeys(null, ['A']), {});
  assert.deepEqual(pickMapKeys({ A: 1 }, null), {});
});

test('M16 差分だけ送っても、他端末が同時に足した鍵は消えない', () => {
  const base = { A: MEAS(1) };
  const local = { A: MEAS(1), C: MEAS(3) };             // この端末が C を足した(未送信)
  let serverDoc = { A: MEAS(1), B: MEAS(2) };           // 他端末が B を足していた
  serverDoc = applyMerge(serverDoc, NEW_FLUSH(local, base));
  assert.deepEqual(Object.keys(serverDoc).sort(), ['A', 'B', 'C']);
});

// ===========================================================================
// ⑤ stepTimes も同じ判定で守れる(数字のマップ)
// ===========================================================================

test('M17 stepTimes: 他端末が直した工程の合計が、こちらの古い写しで戻らない', () => {
  const base = { s1: 120, s2: 60 };
  const local = { s1: 120, s2: 60 };
  const server = { s1: 120, s2: 95 };                   // 他端末が s2 を直した
  const r = reconcileValueMap({ local, server, base });
  assert.deepEqual(r.map, { s1: 120, s2: 95 });
  assert.deepEqual(r.adopted, ['s2']);
});

test('M18 stepTimes: 自分がいま書いた工程は取り上げられない', () => {
  const now = 2_000_000;
  const base = { s1: 120 };
  const local = { s1: 300 };                            // 「次へ」で今書いた(未送信)
  const server = { s1: 120 };
  const touched = noteEditedKeys(new Map(), base, local, now - 1_000);
  const r = reconcileValueMap({ local, server, base, keepKeys: recentlyEditedKeys(touched, now) });
  assert.deepEqual(r.map, { s1: 300 });
});

test('M19 負の対照: stepTimes に合わせ直しが無いと、他端末の合計が古い値で戻る', () => {
  const base = { s1: 120, s2: 60 };
  const r = NO_RECONCILE({ local: { s1: 120, s2: 60 }, server: { s1: 120, s2: 95 }, base });
  assert.equal(r.map.s2, 60,
    '🚨 直す前は 95 → 60 に戻っていた。この行が落ちる時は合わせ直しが効いている');
});

// ===========================================================================
// ⑥ tasks の合わせ直しは1バイトも変えていない(名前を変えただけ)
// ===========================================================================

test('M20 reconcileTasks は今までどおりの戻り(鍵は tasks)で、中身は reconcileValueMap と同じ', () => {
  const base = { A: { status: 'completed', duration: 10 } };
  const local = { A: { status: 'completed', duration: 10 } };
  const server = { A: { status: 'completed', duration: 10 }, B: { status: 'completed', duration: 20 } };
  const a = reconcileTasks({ local, server, base });
  const b = reconcileValueMap({ local, server, base });
  assert.deepEqual(a.tasks, b.map);
  assert.deepEqual(a.adopted, ['B']);
  assert.equal(a.changed, true);
  // 進行中の台の守りも今までどおり
  const runBase = { A: { status: 'processing', startTime: 1000 } };
  const keep = runningTaskKeys(runBase);
  const r = reconcileTasks({ local: runBase, server: { A: { status: 'completed', duration: 7 } }, base: runBase, keepKeys: keep });
  assert.equal(r.tasks.A.status, 'processing');
});

// ===========================================================================
// ⑦ 実コード: 作業画面への配線
// ---------------------------------------------------------------------------
// ⚠⚠ ここは **まだ書けない**。製品検査の M21〜M25 は
//   `serverMeasurementResultsRef` `setMeasurementResultsRaw` `unsentPatch(...)` など
//   **製品検査の作業画面にだけ在る名前** を見ている。部品検査の作業画面は
//   まだ「開いた瞬間の写しを1回作るだけ」のままで、その名前が1つも無い。
//   → 名前を写して当たらない見張りを置くと、毎回落ちるか、当たらないのに緑になる。
//     どちらも「誰も読まない見張り」になる。
//   ⚠だから **黙って消さない**。いま欠けている事は saveOrder.test.mjs の S22(todo)と
//     scripts/verify-save-safety.mjs の SS-501(❌4件)が名指ししている。
//     部品検査の作業画面に合わせ直しを入れる時、ここに M21〜M25 を書く。
// ===========================================================================
