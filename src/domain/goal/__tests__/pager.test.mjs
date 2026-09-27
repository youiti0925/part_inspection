import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllPaged, mergeLotsById } from '../pager.js';

const makeFetcher = (total, pageSize = 500) => async ({ cursor }) => {
  const start = cursor || 0;
  const items = Array.from({ length: Math.min(pageSize, total - start) }, (_, i) => ({ id: `L${start + i}` }));
  const next = start + items.length;
  return { items, nextCursor: next < total ? next : null };
};

test('仕様#10: 501件以上の過去データも全件取得される', async () => {
  const r = await fetchAllPaged(makeFetcher(1234));
  assert.equal(r.items.length, 1234);
  assert.equal(r.complete, true);
  assert.equal(r.pages, 3);
});

test('500件未満なら1ページで完了', async () => {
  const r = await fetchAllPaged(makeFetcher(335));
  assert.equal(r.items.length, 335);
  assert.equal(r.complete, true);
  assert.equal(r.pages, 1);
});

test('上限ページ到達時は complete=false (「一部」と正直に返す)', async () => {
  const r = await fetchAllPaged(makeFetcher(3000, 500), { maxPages: 2 });
  assert.equal(r.items.length, 1000);
  assert.equal(r.complete, false);
});

test('合成: 同じidはライブ購読(最新)が勝つ', () => {
  const hist = [{ id: 'a', v: 'old' }, { id: 'b', v: 'hist' }];
  const live = [{ id: 'a', v: 'new' }, { id: 'c', v: 'live' }];
  const m = mergeLotsById(hist, live);
  assert.equal(m.length, 3);
  assert.equal(m.find(x => x.id === 'a').v, 'new');
});
