// 🧾 中断(軽微不良・気づき・不具合・張り付き)の記録が、多端末で壊れないこと。
//
// ⚠⚠ 事故の形(2026-08-14 の点検で両アプリ成立):
//   lot.interruptions は配列で、書く側は毎回「開いた瞬間の配列＋1件」を丸ごと書き戻していた。
//   Firestore の merge:true が再帰マージするのは **入れ子のマップだけ**。**配列は丸ごと置換**。
//   → ①台帳で消した記録が、作業画面の古い配列で **復活する**
//     ②作業画面が「完了確定」を押すと、開いてからの他端末の追加が **まとめて消える**
//
// ⚠この試験は「合流できること」だけでなく、**古い記録が1件も失われないこと** を見る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INT_MAP_FIELD, intKeyOf, intWritePatch, intDeletePatch, isIntTombstone,
  mergeInterruptionLog, withInterruptionLog, stopIntEntry,
} from '../interruptionLog.js';

const ent = (id, type, extra = {}) => ({ id, type, label: `${type}-${id}`, timestamp: 1000, ...extra });

test('I01 鍵は記録ごとに1つ。別の記録は別の鍵', () => {
  assert.notEqual(intKeyOf(ent('a', 'complaint')), intKeyOf(ent('b', 'complaint')));
  assert.equal(intKeyOf(ent('a', 'complaint')), intKeyOf(ent('a', 'complaint')), '同じ記録は同じ鍵');
});

test('I02 ⚠⚠2台が別々の記録を同時に足しても、両方残る（これが本題）', () => {
  const lot = { interruptions: [ent('old', 'complaint')] };
  // A端末とB端末が、それぞれ自分の1件だけを書く（Firestore の merge は鍵ごとに合体する）
  const pA = intWritePatch(null, ent('a', 'complaint'));
  const pB = intWritePatch(null, ent('b', 'improvement'));
  // Firestore の merge:true は鍵つきの入れ物を合体する
  const map = { ...pA[INT_MAP_FIELD], ...pB[INT_MAP_FIELD] };
  const out = mergeInterruptionLog(lot.interruptions, map);
  const ids = out.map((x) => x.id).sort();
  assert.deepEqual(ids, ['a', 'b', 'old'], '古い記録も、2台ぶんの新しい記録も、全部残る');
});

test('I03 ⚠古い配列(interruptions)の記録は1件も失わない（移行しないで読める）', () => {
  const lot = { interruptions: [ent('x', 'defect'), ent('y', 'complaint')] };
  const out = mergeInterruptionLog(lot.interruptions, undefined);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((x) => x.id).sort(), ['x', 'y']);
  // 何も無いロットでも落ちない
  assert.deepEqual(mergeInterruptionLog(undefined, undefined), []);
  assert.deepEqual(mergeInterruptionLog(null, null), []);
});

test('I04 ⚠⚠削除は「墓標」。古い配列に居る記録も確実に消える', () => {
  // 鍵を消すだけだと、古い配列側の記録が残って **復活する**
  const lot = { interruptions: [ent('x', 'complaint'), ent('y', 'complaint')] };
  const del = intDeletePatch(ent('x', 'complaint'), '村');
  const map = del[INT_MAP_FIELD];
  const out = mergeInterruptionLog(lot.interruptions, map);
  assert.deepEqual(out.map((x) => x.id), ['y'], '消したxは出てこない');
  assert.equal(isIntTombstone(map[intKeyOf(ent('x', 'complaint'))]), true);
});

test('I05 ⚠新しい方が正（台帳で直した内容が、作業画面の古い配列に負けない）', () => {
  const lot = { interruptions: [ent('x', 'complaint', { label: '古い文言' })] };
  const fixed = intWritePatch(null, ent('x', 'complaint', { label: '直した文言' }));
  const out = mergeInterruptionLog(lot.interruptions, fixed[INT_MAP_FIELD]);
  assert.equal(out.length, 1, '同じ記録が2件に増えない');
  assert.equal(out[0].label, '直した文言');
});

test('I06 画面へ渡す形は今までどおり lot.interruptions（読み手を1行も直さない）', () => {
  const lot = { id: 'L1', interruptions: [ent('x', 'complaint')], [INT_MAP_FIELD]: intWritePatch(null, ent('y', 'defect'))[INT_MAP_FIELD] };
  const view = withInterruptionLog(lot);
  assert.equal(Array.isArray(view.interruptions), true);
  assert.deepEqual(view.interruptions.map((x) => x.id).sort(), ['x', 'y']);
  assert.equal(view.id, 'L1', '他の項目はそのまま');
});

test('I07 計測中の記録を止めると、経過が入って完了になる', () => {
  const started = ent('t', 'complaint', { status: 'active', startTime: 1_000_000 });
  const out = stopIntEntry(started, 1_000_000 + 65_000);
  assert.equal(out.status, 'completed');
  assert.equal(out.duration, 65, '実時刻から出す(1秒タイマーの最後の刻みに頼らない)');
  assert.equal(out.endTime, 1_000_000 + 65_000);
});

test('I08 壊れた入力でも落ちない', () => {
  assert.deepEqual(mergeInterruptionLog('x', 'y'), []);
  assert.deepEqual(mergeInterruptionLog([null, ent('a', 'complaint')], null).map((x) => x.id), ['a']);
  assert.equal(typeof intKeyOf({}), 'string');
});

test('I09 ⚠⚠idの無い古い記録を台帳で直しても、2件に増えない', () => {
  // 古い記録は id を持たないことがあり、鍵は「時刻|種類|文言|担当」から作る。
  // 文言を直すと鍵が変わるので、next から鍵を採ると **別の記録として足され、一覧が2行になる**
  // (2026-08-14 実測で再現。点検役が見つけた)。
  const before = { timestamp: 1_700_000_000_000, type: 'complaint', label: 'ボルト緩み', workerName: '村' };
  const after = { ...before, label: 'ボルト緩み(修正)' };
  assert.notEqual(intKeyOf(before), intKeyOf(after), '文言が変われば鍵は変わる(前提)');
  const out = mergeInterruptionLog([before], intWritePatch(before, after)[INT_MAP_FIELD]);
  assert.equal(out.length, 1, '同じ記録が2件に増えてはいけない');
  assert.equal(out[0].label, 'ボルト緩み(修正)', '直した内容が正');
});

test('I10 新規追加(直す前が無い)は、そのまま自分の鍵で入る', () => {
  const e = { id: 'new-1', type: 'defect', label: '新しい不具合' };
  const p = intWritePatch(null, e);
  assert.deepEqual(Object.keys(p[INT_MAP_FIELD]), [intKeyOf(e)]);
});
