// 🚨 部品検査 ロット保存の線引きの試験。
// ⚠見張り自身を試験する。**実際の画面の書き方そのままの payload** で確かめる
//   (作り物の payload だけで合格させると、本番で通ってしまう形を見落とす)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { wouldLoseWorkTime } from '../workTimeGuard.js';
import { decideLotSave, wipeConfirmMessage } from '../lotSavePolicy.js';

// 記録1件だけのロット(部品検査の小ロットで普通に在る形)
const ONE = () => ({ id: 'pt-x', tasks: {
  's1-0': { status: 'completed', duration: 259, firstStartTime: 1786523000000, endTime: 1786523259000 },
} });
// 記録2件のロット
const TWO = () => ({ id: 'pt-x', tasks: {
  's1-0': { status: 'completed', duration: 259, firstStartTime: 1786523000000, endTime: 1786523259000 },
  's1-1': { status: 'completed', duration: 100, firstStartTime: 1786523000000, endTime: 1786523100000 },
} });

// src/App.jsx handleTaskMenuAction 'restart' が実際に書く形(控えの印つき)
const restartWithMark = (cur) => ({
  status: 'waiting', duration: 0, startTime: null, firstStartTime: null, endTime: null, reworks: cur.reworks,
  redoReset: { at: 1786930000000, why: 'restart', before: Number(cur.duration) || 0, firstStartTime: cur.firstStartTime || null },
});
// 印を外した形(=昔の書き方。黙って秒数が消えるのと同じ)
const restartNoMark = () => ({ status: 'waiting', duration: 0, startTime: null, firstStartTime: null, endTime: null });

const decideFor = (before, patch) => decideLotSave(wouldLoseWorkTime(before, patch));

test('A01 普通の完了保存はそのまま通す(現場を止めない)', () => {
  const lot = TWO();
  const d = decideFor(lot, { tasks: { 's1-2': { status: 'completed', duration: 30, firstStartTime: 1, endTime: 2 } }, status: 'processing' });
  assert.equal(d.action, 'pass');
  assert.equal(d.allow, 'erase');
});

test('A02 記録が2件以上あるうちの1件のやり直しは、確認も出さずに通る', () => {
  const lot = TWO();
  const d = decideFor(lot, { tasks: { 's1-0': restartWithMark(lot.tasks['s1-0']) } });
  assert.equal(d.action, 'pass');
});

test('B01 🚨🚨 tasks を空マップで送る形(2026-08-17に本番で起きた形)は問答無用で止める', () => {
  const d = decideFor(ONE(), { location: 'zone_touchup', status: 'paused', tasks: {} });
  assert.equal(d.action, 'block', '🚨これを通したら8/12の事故がそのまま再現する');
  const d2 = decideFor(TWO(), { location: 'zone_touchup', status: 'paused', tasks: {} });
  assert.equal(d2.action, 'block');
});

test('B02 🚨 tasks に null / 配列 / 文字列 を送る形も止める', () => {
  for (const bad of [null, [], 'x', 0]) {
    const d = decideFor(ONE(), { tasks: bad });
    assert.equal(d.action, 'block', `tasks=${JSON.stringify(bad)} は止める`);
  }
});

test('C01 ⚠ 記録1件のロットで「最初から作業」= 控えの印つきなら **人に確認して通す**', () => {
  const lot = ONE();
  const d = decideFor(lot, { tasks: { 's1-0': restartWithMark(lot.tasks['s1-0']) } });
  assert.equal(d.action, 'confirm', '止め切ると現場が使えず、見張りごと外される');
  assert.equal(d.allow, 'wipe');
});

test('C02 🚨 同じ形でも「控えの印が無い」なら確認も出さずに止める', () => {
  const d = decideFor(ONE(), { tasks: { 's1-0': restartNoMark() } });
  assert.equal(d.action, 'block', '印が無い=元に戻せない=黙って消えるのと同じ');
});

test('C03 確認の文には「何件が0件になるか」が入っている(件数の無い警告は判断できない)', () => {
  const lot = ONE();
  const res = wouldLoseWorkTime(lot, { tasks: { 's1-0': restartWithMark(lot.tasks['s1-0']) } });
  const msg = wipeConfirmMessage(res);
  assert.match(msg, /残っているのは 1件 だけ/);
  assert.match(msg, /0件 になります/);
  assert.match(msg, /最初から作業/);
});

test('D01 該当なし解除(unskip)も控えの印つきなら確認して通す', () => {
  const lot = ONE();
  const unskip = { status: 'waiting', duration: 0, startTime: null, firstStartTime: null, endTime: null,
    redoReset: { at: 1786930000000, why: 'unskip', before: 259, firstStartTime: 1786523000000 } };
  assert.equal(decideFor(lot, { tasks: { 's1-0': unskip } }).action, 'confirm');
});

test('D02 取り消し(undo)も控えの印つきなら確認して通す', () => {
  const lot = ONE();
  const undo = { status: 'waiting', duration: 0, firstStartTime: null, endTime: null,
    redoReset: { at: 1786930000000, why: 'undo', before: 259, firstStartTime: 1786523000000 } };
  assert.equal(decideFor(lot, { tasks: { 's1-0': undo } }).action, 'confirm');
});

test('E01 「いつ始めたか」だけが消える保存(異常値の修正)は通す。ただし呼び元が画面に出す', () => {
  const lot = TWO();
  const patch = { tasks: { 's1-0': { ...lot.tasks['s1-0'], firstStartTime: null, endTime: null } } };
  const res = wouldLoseWorkTime(lot, patch);
  assert.equal(res.lost, true);
  assert.equal(res.level, 'erase');
  const d = decideLotSave(res);
  assert.equal(d.action, 'pass');
  assert.notEqual(d.why, '', '通す時も理由を持ち帰る(黙って通さない)');
});

test('E02 🚨 時間を持つ記録が名指しで消される保存は止める', () => {
  const lot = TWO();
  const d = decideFor(lot, { __deleteMapKeys: { tasks: ['s1-0'] } });
  assert.equal(d.action, 'pass', 'drop は allow=erase では通らない → assertSafeLotSave 側が投げる');
  // ⚠ここが線引きの要: decide は wipe/blank だけを扱い、drop は共通の見張りに任せる。
  const res = wouldLoseWorkTime(lot, { __deleteMapKeys: { tasks: ['s1-0'] } });
  assert.equal(res.level, 'drop');
  assert.equal(decideLotSave(res).allow, 'erase', "allow='erase' なので drop(rank3) は投げられる");
});

test('F01 前の姿を知らない/失う物が無い時は通す(新規登録を止めない)', () => {
  assert.equal(decideLotSave(null).action, 'pass');
  assert.equal(decideLotSave({ lost: false }).action, 'pass');
  assert.equal(decideFor(null, { tasks: {} }).action, 'pass', '新しいロットは前の姿が無い');
  assert.equal(decideFor({ id: 'x', tasks: {} }, { tasks: {} }).action, 'pass', '元から空なら失う物が無い');
});
