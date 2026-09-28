// 🖼 2026-09-27 並列シミュの結果の絵(pairPicture.mjs)の見張り: 数字は計算の結果そのまま・止めた工程に印が付く
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stepStripsOf, problemsOf, ganttRowsOf, tickStepOf } from './pairPicture.mjs';
import { fullPairInputOf } from '../../domain/parallelLab/fullPairInput.js';
import { compareFullPair } from '../../domain/fullPair/scheduler.mjs';

const T = (id, idx, title, min, o = {}) => ({ id, idx, title, auto: !!o.auto, lotOnce: !!o.lotOnce, machine: !!(o.auto || o.machine), machineConfirmed: true, sec: min == null ? null : min * 60, why: '試験の値' });
const lotOf = (id, quantity, times, tasks = {}) => ({ id, quantity, steps: times.map((t) => ({ id: t.id, title: t.title, lotOnce: t.lotOnce })), tasks });
const tA = [T('load', 0, '測定準備', 4, { machine: true }), T('measure', 1, '自動測定', 30, { auto: true }), T('unload', 2, '取外し', 2, { machine: true })];
const tB = [T('look', 0, '外観', 5), T('volt', 1, '耐圧試験', 12, { auto: true }), T('off', 2, '取外し', 2, { machine: true })];
const A = { id: 'a', lot: lotOf('a', 3, tA), times: tA, zoneId: 'z1', label: 'A型 ×3台' };
const B = { id: 'b', lot: lotOf('b', 2, tB), times: tB, zoneId: 'z2', label: 'B型 ×2台' };

test('PIC-1 帯の行は 作業者・Aの機械・Bの機械。区切りは計算の結果の時刻そのまま(丸めない・足さない)', () => {
  const p = fullPairInputOf({ A, B, travelMin: 1 });
  assert.equal(p.ok, true, p.errors.join());
  const r = compareFullPair(p.input, p.options);
  assert.equal(r.status, 'ok');
  for (const plan of [r.baseline, r.paired]) {
    const g = ganttRowsOf(plan, p.input);
    assert.deepEqual(g.rows.map((x) => x.label), ['作業者', 'Aの機械', 'Bの機械']);
    assert.equal(g.total, plan.metrics.totalMin);
    assert.deepEqual(g.lotEnds, plan.metrics.lotEnds);
    const machineJobs = plan.jobs.filter((j) => j.resourceId);
    const segs = g.rows.slice(1).flatMap((x) => x.segs.filter((s) => s.kind !== 'hold'));
    assert.equal(segs.length, machineJobs.length, '機械を使う工程は全部 機械の行に出る');
    for (const j of machineJobs) assert.ok(segs.some((s) => s.start === j.start && s.end === j.end));
    const holds = g.rows.slice(1).flatMap((x) => x.segs.filter((s) => s.kind === 'hold'));
    assert.equal(holds.reduce((n, s) => n + s.end - s.start, 0).toFixed(6), plan.resourceWait.reduce((n, s) => n + s.end - s.start, 0).toFixed(6), '機械が人を待つ時間 = 計算の値');
    const kinds = new Set(g.rows[0].segs.map((s) => s.kind));
    for (const k of kinds) assert.ok(['manual', 'monitor', 'travel', 'idle', 'launch'].includes(k), k);
  }
});

test('PIC-2 止まった時: 時間の無い工程・途中/不良の工程・機械が未確認の工程に 赤い印。場所と片道は移動の所へ', () => {
  const tC = [T('look', 0, '外観', 5), T('size', 1, '寸法', null), T('volt', 2, '耐圧試験', 12, { auto: true }), T('off', 3, '取外し', 2, { machine: true })];
  const C = { id: 'c', lot: lotOf('c', 2, tC, { 'look-0': { status: 'ng' } }), times: tC, zoneId: '', label: 'C型' };
  const p = fullPairInputOf({ A, B: C, travelMin: null, conditions: { inProgressAsWhole: false } }); // 途中を止める側の印を確かめる(既定は止めない)
  assert.equal(p.ok, false);
  const strips = stepStripsOf(A, C);
  const x = problemsOf(p.errors, strips);
  assert.deepEqual(x.steps.B[1], ['時間が分からない']);
  assert.deepEqual(x.steps.B[0], ['途中か不良']);
  assert.ok(x.travel.length >= 1, '場所・片道の文は移動の所へ');
  assert.deepEqual(x.general, []);
  const y = problemsOf(['B: 自動終了後の「取外し」の機械使用が未確認です。取外しを含むなら機械使用に設定してください'], strips);
  assert.deepEqual(y.steps.B[3], ['機械を使うか未確認']);
  assert.equal(strips.B.steps[0].running, 1); assert.equal(strips.B.steps[0].todo, 1);
});

test('PIC-3 目盛りは8本以下', () => {
  for (const h of [3, 40, 140.5, 600, 2000, 20000]) assert.ok(h / tickStepOf(h) <= 8, String(h));
});

test('PIC-4 画面: 絵を先に・文字は畳む。字は12px以上(text-xs 以上・px 直書きなし)', () => {
  const ui = readFileSync(new URL('./FullPairComparison.jsx', import.meta.url), 'utf8');
  const pic = readFileSync(new URL('./PairPicture.jsx', import.meta.url), 'utf8');
  assert.ok(ui.indexOf('<SavingHero') < ui.indexOf('<WorkerRoute'), '大きな数字と棒が 作業者の順番の文より先');
  assert.ok(ui.indexOf('<Gantt plan={r.baseline}') < ui.indexOf('<WorkerRoute'));
  assert.match(ui, /<StopPicture strips=\{cand\?\.steps\}/);
  for (const src of [ui, pic]) { assert.doesNotMatch(src, /text-\[\d+px\]/); assert.doesNotMatch(src, /fontSize: ?(?:[0-9]|1[01])\b/); }
});
