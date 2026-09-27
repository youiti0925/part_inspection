// P062 / P114 上限に届いた時の札と、過去の取り寄せの指定の試験。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  lotsOverflowOf, archiveLotsSpec, oldestCreatedAt, ARCHIVE_LIMIT,
  LOTS_HISTORY_LIMIT, OPEN_LOTS_LIMIT, mergeLotsById,
} from '../readBudget.js';

test('OV1 窓が全部なら何も溢れていない', () => {
  assert.deepEqual(lotsOverflowOf({ windowWhole: true, historyLoaded: true, historyLen: 999, openLen: 999 }),
    { openCapped: false, historyCapped: false, olderMissing: false, archiveCapped: false });
});
test('OV2 未完了が上限ちょうどで openCapped(等号で立つ)', () => {
  assert.equal(lotsOverflowOf({ openLen: OPEN_LOTS_LIMIT }).openCapped, true);
  assert.equal(lotsOverflowOf({ openLen: OPEN_LOTS_LIMIT - 1 }).openCapped, false);
});
test('OV3 過去が500に届いたら historyCapped、届く前・読む前は立たない', () => {
  assert.equal(lotsOverflowOf({ historyLoaded: true, historyLen: LOTS_HISTORY_LIMIT }).historyCapped, true);
  assert.equal(lotsOverflowOf({ historyLoaded: true, historyLen: LOTS_HISTORY_LIMIT - 1 }).historyCapped, false);
  assert.equal(lotsOverflowOf({ historyLoaded: false, historyLen: 0 }).historyCapped, false);
});
test('OV4 取り寄せが全部揃えば olderMissing は消え、上限に届けば残る', () => {
  const base = { historyLoaded: true, historyLen: LOTS_HISTORY_LIMIT };
  assert.equal(lotsOverflowOf({ ...base, archiveState: 'idle' }).olderMissing, true);
  assert.equal(lotsOverflowOf({ ...base, archiveState: 'failed' }).olderMissing, true);
  assert.equal(lotsOverflowOf({ ...base, archiveState: 'loaded', archiveLen: 10 }).olderMissing, false);
  const c = lotsOverflowOf({ ...base, archiveState: 'loaded', archiveLen: ARCHIVE_LIMIT });
  assert.equal(c.olderMissing, true); assert.equal(c.archiveCapped, true);
});
test('AR1 取り寄せ指定は 境目より古い/新しい順/2000件', () => {
  assert.deepEqual(archiveLotsSpec(1000), { where: [['createdAt', '<', 1000]], orderBy: [['createdAt', 'desc']], limit: ARCHIVE_LIMIT });
  assert.throws(() => archiveLotsSpec(undefined));
  assert.throws(() => archiveLotsSpec(0));
});
test('AR2 oldestCreatedAt は数の createdAt だけを見る', () => {
  assert.equal(oldestCreatedAt([{ createdAt: 5 }, { createdAt: 3 }, { createdAt: null }, {}, { createdAt: 'x' }]), 3);
  assert.equal(oldestCreatedAt([]), null);
});
test('AR3 合体は 過去→取り寄せ→未完了 の順で、未完了(生きた方)が勝つ', () => {
  const hist = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }];
  const arch = [{ id: 'c', v: 1 }, { id: 'd', v: 1 }];
  const open = [{ id: 'd', v: 2 }];
  assert.deepEqual(mergeLotsById(hist, arch, open), [{ id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'c', v: 1 }, { id: 'd', v: 2 }]);
});
test('AR4 App.jsx が取り寄せと札を本当に使っている', () => {
  const app = readFileSync(new URL('../../App.jsx', import.meta.url), 'utf8');
  assert.match(app, /archiveLotsSpec\(/);
  assert.match(app, /lotsOverflowOf\(/);
  assert.match(app, /mergeLotsById\(historyLots, archiveLots, openLots\)/);
  assert.match(app, /<LotsReadNotice/);
  assert.doesNotMatch(app, /console\.warn\(`⚠ 未完了ロットが/);
});
