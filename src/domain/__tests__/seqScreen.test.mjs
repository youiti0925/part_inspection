// 🖐 2026-09-24 作業画面(順序実行)の作り直し — 並び・状態・次の一手の純関数 seqScreen.js の試験。
//   清水さん「時間・目標時間・今の作業(次の作業やテンプレの順番を一瞬で)・作業詳細・画像・測定を1画面で」→ Claude Design の案を「このまま進めて」
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  seqTaskKeyOf, seqTaskOf, seqMovesOf, seqStatusGridOf, seqNextOf, seqWhileAutoOf, seqRemainingOf, seqAreasOf, seqPresetOf, unitsOfStep,
} from '../seqScreen.js';

const S = (id, title, extra = {}) => ({ id, title, ...extra });
const isAuto = (s) => s && s.executionMode === 'batch';
// 初回準備(1回) → 準備 → 自動(機械) → 外観 → 片付け(1回)
const STEPS = [S('o1', '初回準備', { lotOnce: true }), S('p', '準備'), S('a', '回転精度測定', { executionMode: 'batch' }), S('v', '外観確認'), S('o2', '片付け', { lotOnce: true })];
const done = { status: 'completed' };
const run = (startTime = 0) => ({ status: 'processing', startTime });

test('SEQ-1 鍵はアプリと同じ: 台の工程 `${id}-${台}`・ロット1回 `${id}-lot-0`・id が無い旧データは `${番号}-${台}`', () => {
  assert.equal(seqTaskKeyOf(STEPS[0], 0, 3), 'o1-lot-0');
  assert.equal(seqTaskKeyOf(STEPS[1], 1, 2), 'p-2');
  assert.equal(seqTaskKeyOf({ title: 'x' }, 4, 1), '4-1');
  assert.equal(seqTaskOf({ '1-0': done }, STEPS[1], 1, 0), done, '旧い鍵も読む');
  assert.equal(unitsOfStep(STEPS[0], 4), 1);
  assert.equal(unitsOfStep(STEPS[1], 4), 4);
});

test('SEQ-2 並びは工程が先。ロット1回は1回だけ', () => {
  const m = seqMovesOf(STEPS, 2);
  assert.deepEqual(m.map((x) => `${x.s}-${x.u}`), ['0-0', '1-0', '1-1', '2-0', '2-1', '3-0', '3-1', '4-0']);
});

test('SEQ-3 次にやる作業は 頭から「済でも動いてもいない」最初の物(待ち時間に先へ移った後も 前の台の残りを飛ばさない)', () => {
  const tasks = { 'o1-lot-0': done, 'p-0': done, 'p-1': done, 'a-0': done, 'v-0': done };
  // 1台目の外観を先に済ませても、次は 2台目の自動
  assert.deepEqual(seqNextOf(STEPS, tasks, 2), { s: 2, u: 1, waiting: false });
  // 動いている物(自動)は飛ばす。その台の後ろ(2台目の外観)は 自動が済むまで出さない → 待つ
  assert.deepEqual(seqNextOf(STEPS, { ...tasks, 'a-1': run() }, 2), { s: 2, u: 1, waiting: true });
  // 同じ工程の自動が別の台で動いている間は 次の台の自動を出さない(機械は1台ずつ)。isAuto を渡した時だけ
  const busy = { 'o1-lot-0': done, 'p-0': done, 'p-1': done, 'p-2': done, 'a-0': run() };
  assert.deepEqual(seqNextOf(STEPS, busy, 3), { s: 2, u: 1, waiting: false }, 'isAuto 無しは前の形');
  assert.deepEqual(seqNextOf(STEPS, busy, 3, isAuto), { s: 2, u: 0, waiting: true }, '機械が空くまで待つ(1台目の外観も 自動が済むまで出さない)');
  const busy2 = { ...busy, 'a-0': done, 'a-1': run() };
  assert.deepEqual(seqNextOf(STEPS, busy2, 3, isAuto), { s: 3, u: 0, waiting: false }, '1台目の外観へ(3台目の自動は 2台目が機械を空けるまで出さない)');
  // 残りが動いている物だけ → その物を待つ
  const rest = { 'o1-lot-0': done, 'p-0': done, 'p-1': done, 'a-0': done, 'a-1': run(), 'v-0': done };
  assert.deepEqual(seqNextOf(STEPS.slice(0, 3), rest, 2), { s: 2, u: 1, waiting: true });
  // 全部済 → null
  assert.equal(seqNextOf([STEPS[1]], { 'p-0': done, 'p-1': done }, 2), null);
});

test('SEQ-4 自動運転を待つ間の手作業: 手作業で・その台の前の工程が全部済の物だけ(機械に載っている台の後ろは出さない)', () => {
  // 1台目の自動が動いている。2台目は まだ自動の前 → 2台目の自動は機械 → 手作業の候補は無い
  const t1 = { 'o1-lot-0': done, 'p-0': done, 'p-1': done, 'a-0': run() };
  assert.equal(seqWhileAutoOf(STEPS, t1, 2, isAuto), null, '機械に載っている1台目の外観を出した / 自動を手作業と数えた');
  // 1台目の自動が済み、2台目の自動が動いている → 1台目の外観ができる
  const t2 = { 'o1-lot-0': done, 'p-0': done, 'p-1': done, 'a-0': done, 'a-1': run() };
  assert.deepEqual(seqWhileAutoOf(STEPS, t2, 2, isAuto), { s: 3, u: 0 });
  // ロット1回(片付け)は 全台の前の工程が済むまで出さない
  const t3 = { ...t2, 'v-0': done };
  assert.equal(seqWhileAutoOf(STEPS, t3, 2, isAuto), null, '2台目の自動が済む前に 片付けを出した');
});

test('SEQ-5 順番の帯の状態: 済・動いている・いまここ・まだ(ロット1回は1つ)', () => {
  const tasks = { 'o1-lot-0': done, 'p-0': done, 'a-0': run() };
  const g = seqStatusGridOf(STEPS, tasks, 2, { s: 1, u: 1 });
  assert.deepEqual(g[0].units.map((x) => x.status), ['done']);
  assert.deepEqual(g[1].units.map((x) => x.status), ['done', 'cur']);
  assert.deepEqual(g[2].units.map((x) => x.status), ['run', 'todo']);
  assert.equal(g[0].allDone, true);
  assert.equal(g[1].allDone, false);
});

test('SEQ-6 残りの見込み: 目標を足す・今の作業は経過を引く・動いている自動は始めてからを引く・目標の無い工程は数えず「分からない」に数える(0分と言わない)', () => {
  const steps = [S('p', '準備'), S('a', '自動', { executionMode: 'batch' }), S('x', '目標なし')];
  const targetOf = (s) => [600, 1200, 0][s];
  const tasks = { 'p-0': done, 'a-0': run(1000) };
  const r = seqRemainingOf(steps, tasks, 2, { targetOf, cur: { s: 0, u: 1 }, curElapsedSec: 100, nowMs: 1000 + 300 * 1000 });
  // p-1: 600-100=500 / a-0: 1200-300=900 / a-1: 1200 / x: 分からない ×2
  assert.equal(r.sec, 500 + 900 + 1200);
  assert.equal(r.unknown, 2);
  assert.equal(r.left, 5);
});

test('SEQ-7 画面の型: 図が無い工程は図の枠を取らない(本番は工程の画像 0/6,995)。型は3つだけ・知らない値は説明重視', () => {
  assert.deepEqual(seqAreasOf({ preset: 'desc', hasFig: false, hasInput: false }).panels, ['d', 'n']);
  assert.deepEqual(seqAreasOf({ preset: 'measure', hasFig: false, hasInput: true }).areas, "'m d'");
  assert.deepEqual(seqAreasOf({ preset: 'desc', hasFig: false, hasInput: true }).areas, "'d m'");
  assert.deepEqual(seqAreasOf({ preset: 'fig', hasFig: true, hasInput: true }).areas, "'f d' 'f m'");
  assert.deepEqual(seqAreasOf({ preset: 'desc', hasFig: true, hasInput: true }).panels, ['d', 'f', 'm']);
  assert.equal(seqPresetOf('?'), 'desc');
  assert.equal(seqPresetOf('fig'), 'fig');
});

// 🚨 2026-09-24 第三者の確かめ(独立の確かめ役)で見つかった穴の試験
test('SEQ-8 該当なし・NG・修正済みは 済(順序実行では触らない)。修正作業中は 動いている。一時停止は 続きをやる物', () => {
  const steps = [S('a', '準備'), S('b', '外観'), S('c', '片付け')];
  const base = { 'a-0': done, 'a-1': done };
  assert.deepEqual(seqNextOf(steps, { ...base, 'b-0': { status: 'skipped' }, 'b-1': { status: 'skipped' } }, 2), { s: 2, u: 0, waiting: false }, '該当なしで止まった(前は {s:1,u:0})');
  assert.deepEqual(seqNextOf(steps, { ...base, 'b-0': done, 'b-1': { status: 'ng' }, 'c-0': done }, 2), { s: 2, u: 1, waiting: false }, 'NG で止まった');
  assert.deepEqual(seqNextOf(steps, { ...base, 'b-0': { status: 'rework-done' } }, 2), { s: 1, u: 1, waiting: false });
  assert.deepEqual(seqNextOf(steps, { ...base, 'b-0': { status: 'reworking' }, 'b-1': done, 'c-1': done }, 2), { s: 1, u: 0, waiting: true }, '修正作業中は 待つ(上書きしない)');
  assert.deepEqual(seqNextOf(steps, { ...base, 'b-0': { status: 'paused', duration: 90 } }, 2), { s: 1, u: 0, waiting: false }, '一時停止は 続き');
  const g = seqStatusGridOf(steps, { ...base, 'b-0': { status: 'skipped' } }, 2, { s: 1, u: 1 });
  assert.deepEqual(g[1].units.map((x) => x.status), ['skip', 'cur'], '該当なしを済の緑と同じにした');
  const g2 = seqStatusGridOf(steps, { ...base, 'b-0': { status: 'ng' }, 'b-1': { status: 'skipped' } }, 2, null);
  assert.deepEqual(g2[1].units.map((x) => x.status), ['ng', 'skip']);
  assert.equal(g2[1].allDone, true, 'NG・該当なしは 済の並び');
  const g3 = seqStatusGridOf(steps, { 'a-0': { status: 'processing' }, 'a-1': { status: 'reworking' } }, 2, null, isAuto);
  assert.deepEqual(g3[0].units.map((x) => x.status), ['active', 'rework'], '手作業の作業中を 自動運転中と出した');
  const r = seqRemainingOf(steps, { ...base, 'b-0': { status: 'skipped' }, 'b-1': { status: 'ng' } }, 2, { targetOf: () => 60, nowMs: 0 });
  assert.equal(r.left, 2, '該当なし・NG を残りに数えた');
});

test('SEQ-9 自動運転の工程に 入力(測定/確認チェック)が要るのに無い時は 自動が済んでも そこへ戻る(待ちの間に入れ忘れない)', () => {
  const steps = [S('a', '自動測定', { executionMode: 'batch' }), S('b', '片付け')];
  const tasks = { 'a-0': done, 'a-1': done, 'b-0': done };
  const need = (s, u) => s === 0 && u === 1;
  assert.deepEqual(seqNextOf(steps, tasks, 2, isAuto, { needsInput: need }), { s: 0, u: 1, waiting: false, inputOnly: true });
  assert.deepEqual(seqNextOf(steps, tasks, 2, isAuto), { s: 1, u: 1, waiting: false }, '入力を見ない時は前の形');
  // 手作業の工程は 戻さない(順序実行では 入力の枠を出したまま完了するので)
  const steps2 = [S('a', '手の測定'), S('b', '片付け')];
  assert.deepEqual(seqNextOf(steps2, tasks, 2, isAuto, { needsInput: () => true }), { s: 1, u: 1, waiting: false });
});

test('SEQ-10 機械に載っている台の作業は 次にも 待ちの間の案内にも出さない(カスタムで順番を飛ばした時)', () => {
  // 1台目: 準備 未 → 自動 動いている(カスタムで順番を飛ばした)。2台目: 準備 済
  const steps = [S('p', '準備'), S('a', '自動', { executionMode: 'batch' }), S('v', '外観')];
  const tasks = { 'a-0': run(), 'p-1': done };
  assert.deepEqual(seqNextOf(steps, tasks, 2), { s: 0, u: 0, waiting: false }, 'isAuto 無しは前の形');
  // 1台目の準備は 1台目が機械の上なので出さない。2台目の自動も 機械が空いていないので出さない → 1台目の自動を待つ
  assert.deepEqual(seqNextOf(steps, tasks, 2, isAuto), { s: 1, u: 0, waiting: true }, '機械に載っている1台目の準備を出した');
  assert.equal(seqWhileAutoOf(steps, tasks, 2, isAuto), null, '待ちの案内に 機械の上の台を出した');
  // ロット1回の自動が動いている間は 全台を出さない
  const steps2 = [S('c', '校正', { executionMode: 'batch', lotOnce: true }), S('p', '準備')];
  assert.deepEqual(seqNextOf(steps2, { 'c-lot-0': run() }, 2, isAuto), { s: 0, u: 0, waiting: true });
});

test('SEQ-11 「別の台も今始める」(sameStepAuto)は 同じ工程の自動の待ちを飛ばすが 別の機械に載っている台は出さない', () => {
  const steps = [S('a', '自動A', { executionMode: 'batch' }), S('b', '自動B', { executionMode: 'batch' })];
  // 1台目は自動A が動いている。2台目は カスタムで順番を飛ばして 自動B が動いている(別の機械)
  const t1 = { 'a-0': run(), 'b-1': run() };
  assert.deepEqual(seqNextOf(steps, t1, 2, isAuto, { sameStepAuto: true }), { s: 0, u: 0, waiting: true }, '別の機械に載っている2台目を出した');
  // 2台目が空いていれば 同じ工程の自動を 2台目でも始められる
  const t2 = { 'a-0': run() };
  assert.deepEqual(seqNextOf(steps, t2, 2, isAuto, { sameStepAuto: true }), { s: 0, u: 1, waiting: false });
  assert.deepEqual(seqNextOf(steps, t2, 2, isAuto), { s: 0, u: 0, waiting: true }, '既定は1台ずつ');
});
