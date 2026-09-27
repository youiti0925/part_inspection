// 🚚 2026-09-18 夕 清水さん「納期の棒あるけど、入荷の棒がないから記載してほしい、仮の棒なのか本当の棒なのかもね」
//   納期一覧の各行に入荷の縦線。本当=青緑の実線／仮=橙の点線／もう手元に在る物は線なし。
// 🚨 2026-09-19 メンテ: この見張りは 画面の if 文を **文字で** 見ていたので、最終検査で線が1本も出ていない事を見逃した
//   (最終のエンジンの種類は entryAt／pendingSplit。製品の言葉だけを見ていた)。決め方を純関数 arrivalLine.js へ出し、値を入れて結果を見る。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { arrivalLineOf, arrivalLineTip, arrivalMsOfLot, ARRIVAL_REAL_KINDS, ARRIVAL_TENTATIVE_KINDS } from '../arrivalLine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(HERE, '..', 'DueCalendar.jsx'), 'utf8').replace(/\r\n/g, '\n');
const DAY = 86400000; const T0 = Date.parse('2026-09-21T00:00:00+09:00');
const COLS = [0, 1, 2, 3, 4].map((i) => ({ ms: T0 + i * DAY, endMs: T0 + (i + 1) * DAY }));
const row = (arrivalMs, arrivalKind) => ({ arrivalMs, arrivalKind });

test('AL-1 本当の入荷日は実線: 製品検査の registered・最終検査の entryAt／pendingSplit', () => {
  for (const k of ['registered', 'entryAt', 'pendingSplit']) {
    const l = arrivalLineOf(row(T0 + DAY + 3600e3, k), COLS);
    assert.ok(l && l.real === true && l.kind === k, `${k} で本当の線が出ない`);
  }
  assert.deepEqual([...ARRIVAL_REAL_KINDS], ['registered', 'entryAt', 'pendingSplit']);
});

test('AL-2 仮の入荷日は点線: derived(取込の逆算)・assumed(計算の仮置き)', () => {
  for (const k of ['derived', 'assumed']) {
    const l = arrivalLineOf(row(T0 + 2 * DAY, k), COLS);
    assert.ok(l && l.real === false, `${k} で仮の線が出ない`);
  }
  assert.deepEqual([...ARRIVAL_TENTATIVE_KINDS], ['derived', 'assumed']);
});

test('AL-3 もう手元に在る物・種類が分からない物 には出さない', () => {
  for (const k of ['inShop', 'entryAtPast', 'noEntryRecord', '', null, undefined, 'なにか']) {
    assert.equal(arrivalLineOf(row(T0 + DAY, k), COLS), null, `${String(k)} で線が出ている`);
  }
});

test('AL-4 日時が無い行(null／0／NaN)に 1970年の線を出さない', () => {
  assert.equal(arrivalMsOfLot({ arrivalMs: null }), null, 'null が 0 になっている');
  assert.equal(arrivalMsOfLot({ arrivalMs: undefined }), null);
  assert.equal(arrivalMsOfLot({ arrivalMs: 0 }), null);
  assert.equal(arrivalMsOfLot({ arrivalMs: 'x' }), null);
  assert.equal(arrivalMsOfLot({ arrivalMs: String(T0) }), T0);
  for (const v of [null, 0, NaN, undefined]) assert.equal(arrivalLineOf(row(v, 'registered'), COLS), null);
});

test('AL-5 軸の外(期間より前／後)の入荷は 端へ貼り付けずに 出さない', () => {
  assert.equal(arrivalLineOf(row(T0 - 1, 'registered'), COLS), null, '期間より前の入荷が出ている');
  assert.equal(arrivalLineOf(row(T0 + 5 * DAY, 'registered'), COLS), null, '期間の終わりちょうど が出ている');
  assert.equal(arrivalLineOf(row(T0 + 21 * DAY, 'derived'), COLS), null, '3週間先の入荷が右端に出ている');
  assert.ok(arrivalLineOf(row(T0, 'registered'), COLS), '期間の最初の瞬間 が出ない');
  assert.equal(arrivalLineOf(row(T0 + DAY, 'registered'), []), null, '列が無いのに出ている');
});

test('AL-6 線の言葉: 本当／まだ来ていない便／取込の逆算／計算の仮置き を言い分ける', () => {
  assert.equal(arrivalLineTip({ real: true, kind: 'registered' }, '9/22 8:30'), '入荷 9/22 8:30（登録された入荷日）');
  assert.equal(arrivalLineTip({ real: true, kind: 'entryAt' }, '9/22 8:30'), '入荷 9/22 8:30（登録された入荷日）');
  assert.ok(arrivalLineTip({ real: true, kind: 'pendingSplit' }, 'x').includes('まだ来ていない便'));
  assert.ok(arrivalLineTip({ real: false, kind: 'derived' }, 'x').includes('取込が納期から逆算して置いた日'));
  assert.ok(arrivalLineTip({ real: false, kind: 'assumed' }, 'x').includes('計算が仮に置いた日です'));
  assert.equal(arrivalLineTip(null, 'x'), '');
});

test('AL-7 画面は 純関数を呼んで描く(自前の if 文で種類を決めない)。本当=実線(青緑)・仮=点線(橙)・凡例', () => {
  assert.ok(SRC.includes("import { arrivalLineOf, arrivalLineTip, arrivalMsOfLot } from './arrivalLine.js';"));
  assert.ok(SRC.includes('arrivalMs: arrivalMsOfLot(l),'), '行の入荷の日時を 純関数で読んでいない');
  assert.ok(SRC.includes('const line = arrivalLineOf(r, cols);'), '線を出すかを 純関数で決めていない');
  assert.ok(!/arrivalKind === '(registered|derived|entryAt|pendingSplit)'/.test(SRC), '画面の中で 入荷の種類を もう一度決めている');
  assert.ok(SRC.includes("real ? 'w-1 rounded-sm bg-teal-600' : 'w-0 border-l-2 border-dashed border-amber-500'"), '本当と仮で線の見た目を分けていない');
  assert.ok(SRC.includes('data-arrival-line={r.arrivalMs}'), '目印が無い');
  assert.ok(SRC.includes('data-arrival-legend="real"') && SRC.includes('data-arrival-legend="assumed"'), '凡例に 入荷／入荷（仮） が無い');
});

test('AL-8 このアプリのエンジンが出す「これから来る」種類は 全部 線が出る(エンジンと画面の言葉が食い違わない)', async () => {
  const golden = path.resolve(HERE, '..', '..', 'domain', 'operationsSimulation', 'goldenArrival.js');
  if (fs.existsSync(golden)) {
    // 最終検査: 本物の resolveGoldenArrival を呼ぶ
    const { resolveGoldenArrival } = await import(`file://${golden.replace(/\\/g, '/')}`);
    const now = T0 + 9 * 3600e3;
    const future = resolveGoldenArrival({ lot: { entryAt: T0 + 2 * DAY }, nowMs: now });
    assert.ok(arrivalLineOf(row(future.arrivalMs, future.kind), COLS), `最終検査の「入荷時間がこれから」(${future.kind})で線が出ない`);
    const past = resolveGoldenArrival({ lot: { entryAt: T0 - 2 * DAY }, nowMs: now });
    assert.equal(arrivalLineOf(row(past.arrivalMs, past.kind), COLS), null, `もう手元に在る物(${past.kind})に線が出ている`);
  } else {
    // 製品検査: normalizeInput が付ける種類の言葉が ソースに在る物と一致
    const norm = fs.readFileSync(path.resolve(HERE, '..', '..', 'domain', 'operationsSimulation', 'normalizeInput.js'), 'utf8');
    for (const k of ['registered', 'derived', 'assumed']) assert.ok(norm.includes(`'${k}'`), `normalizeInput に 種類 ${k} が無い`);
  }
});
