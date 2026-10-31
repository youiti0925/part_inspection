// ============================================================================
// 🔁 2026-10-31 verify14: ③の「更新」(作業者マップ・アラート・人・納期・人手)で、届かずに読めなかった物が帯に出なかった試験
// ----------------------------------------------------------------------------
//   ③の「更新」は、購読中(手元に控えがある)の一覧を refresh でサーバから読み直してから、getAll で画面を作り直す。
//   直す前: refresh の失敗は「読めていない物」に入るが、続く getAll が手元の控えを返して(fromCache:false)すぐ下ろしていた
//   → 帯が一瞬も残らず、戻った後の読み直し・読み直せた合図(onRecovered)も起きなかった。
//     RF1 … refresh が届かない → getAll(控え)・購読の最初の知らせ(控え)では下ろさない → 帯に残る
//          → つながった合図で読み直し、読めたら下ろし、onRecovered で知らせる
//     RF2 … 読めていなかった(控えの無い)一覧は、今までどおり getAll が読めた時点で下ろす
// ⚠このファイルは4アプリで同じ中身。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRetryOfProvider } from '../readRetry.js';
import { createPocketbaseBackend } from '../pocketbaseBackend.js';
import { createProvider } from '../provider.js';
import { DEFAULT_PROVIDERS } from '../routes.js';
import { createMemoryStore } from '../outbox.js';
import { PbNetworkError } from '../pbClient.js';

const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const ALL_PB = Object.freeze(Object.fromEntries(Object.keys(DEFAULT_PROVIDERS).map((k) => [k, 'pocketbase'])));
const NS_A = 'product-inspection-v1';
const NS_CAP = 'capacity-shared-v1';

const fakeTimers = () => {
  const tm = new Map(); let seq = 0;
  return {
    setTimeout: (f, ms) => { seq += 1; tm.set(seq, { f, ms }); return seq; },
    clearTimeout: (h) => { tm.delete(h); },
    fire: () => { const xs = [...tm.entries()]; xs.forEach(([h]) => tm.delete(h)); xs.forEach(([, x]) => x.f()); },
  };
};
const fakeWin = () => {
  const ls = new Map();
  return {
    addEventListener: (t, f) => { if (!ls.has(t)) ls.set(t, new Set()); ls.get(t).add(f); },
    removeEventListener: (t, f) => { if (ls.has(t)) ls.get(t).delete(f); },
    fire: (t) => { [...(ls.get(t) || [])].forEach((f) => f()); },
  };
};
const mk = () => {
  const rows = [
    { id: 'r1', ns: NS_A, col: 'workers', docId: 'w1', data: { name: '一郎' }, rev: 1 },
    { id: 'r2', ns: NS_CAP, col: 'daily_load', docId: 'd1', data: { n: 1 }, rev: 1 },
    { id: 'r3', ns: NS_A, col: 'settings', docId: 'config', data: { a: 1 }, rev: 1 },
  ];
  const st = { reachable: true };
  const err = () => new PbNetworkError(new Error('Failed to fetch'), 'http://127.0.0.1:1/api/collections/docs/records');
  const parse = (f = '') => Object.fromEntries([...String(f).matchAll(/(\w+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const client = {
    isAuthed: () => true,
    listPage: async (col, { filter } = {}) => {
      if (!st.reachable) throw err();
      const want = parse(filter);
      const items = rows.filter((r) => Object.entries(want).every(([k, v]) => String(r[k] == null ? '' : r[k]) === v)).map((r) => JSON.parse(JSON.stringify(r)));
      return { items, totalItems: items.length, totalPages: 1 };
    },
    listAll: async (col, opts) => (await client.listPage(col, opts)).items,
    getOne: async () => { if (!st.reachable) throw err(); return {}; },
    create: async () => { if (!st.reachable) throw err(); return {}; },
    update: async () => { if (!st.reachable) throw err(); return {}; },
    remove: async () => { if (!st.reachable) throw err(); return {}; },
    openRealtime: () => () => {},
  };
  const be = createPocketbaseBackend(client, { outboxStore: createMemoryStore(), autoRealtime: false });
  const P = createProvider({ backends: { firebase: {}, pocketbase: be }, providers: ALL_PB });
  const T = fakeTimers(); const W = fakeWin();
  const ctl = readRetryOfProvider(P, { win: W, timers: T });
  return { st, rows, be, P, T, W, ctl };
};
const quiet = async (fn) => { const e = console.error; const w = console.warn; console.error = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; } };
/** ③の「更新」と同じ順: 購読中の一覧を refresh(失敗は飲み込む) → getAll で画面を作り直す。 */
const pressRefresh = async (P, be, pairs) => {
  await Promise.all(pairs.map(([ns, col]) => Promise.resolve().then(() => be.refresh(ns, col)).then(() => null, () => null)));
  return Promise.all(pairs.map(([ns, col]) => P.getAll(ns, col)));
};

test('RF1 購読中の一覧の読み直しが届かない時は、控えを返す読み(getAll・購読の最初の知らせ)では下ろさず帯に残し、戻ったら読み直して知らせる', async () => {
  const { st, rows, be, P, W, ctl } = mk();
  try {
    const pairs = [[NS_A, 'workers'], [NS_CAP, 'daily_load']];
    // 起動: 購読して読めている(手元に控え)
    let workers = null;
    P.watchCollection(NS_A, 'workers', (r) => { workers = r; });
    P.watchCollection(NS_CAP, 'daily_load', () => {});
    await flush();
    assert.equal(workers.length, 1);
    assert.deepEqual(ctl.unread(), []);
    const recovered = [];
    ctl.onRecovered((keys) => recovered.push(...keys));

    // 回線が切れた → 「更新」
    st.reachable = false;
    let got = null;
    await quiet(async () => { got = await pressRefresh(P, be, pairs); await flush(); });
    assert.deepEqual(got.map((x) => x.length), [1, 1], '画面は控えで出し続ける(落とさない)');
    assert.deepEqual(ctl.unread().map((u) => u.key).sort(), [`${NS_CAP}/daily_load`, `${NS_A}/workers`], '読めなかった物が帯に残る(getAll の控えでは下ろさない)');
    // 同じ一覧をもう一度購読しても(最初の知らせは控え・fromCache:false)下ろさない
    P.watchCollection(NS_A, 'workers', () => {});
    await flush();
    assert.equal(ctl.unread().length, 2, '購読の最初の知らせ(控え)でも下ろさない');

    // その間にサーバ側で変わった → つながった
    rows[0].data = { name: '一郎(変更後)' }; rows[0].rev = 2;
    st.reachable = true;
    W.fire('online'); await flush();
    assert.deepEqual(ctl.unread(), [], '読み直せたら下ろす(帯が消える)');
    assert.deepEqual(recovered.sort(), [`${NS_CAP}/daily_load`, `${NS_A}/workers`], '読み直せた合図で画面も読み直せる');
    assert.equal(workers[0].name, '一郎(変更後)', '購読の画面にサーバの今の姿が届いた');
  } finally { ctl.dispose(); be.close(); }
});

test('RF2 読めていなかった(控えの無い)一覧は、今までどおり getAll が読めた時点で下ろす', async () => {
  const { st, be, P, ctl } = mk();
  try {
    st.reachable = false;
    await quiet(async () => { await P.getAll(NS_A, 'settings'); await flush(); });
    assert.deepEqual(ctl.unread().map((u) => u.key), [`${NS_A}/settings`]);
    st.reachable = true;
    const r = await P.getAll(NS_A, 'settings');
    assert.equal(r.length, 1);
    await flush();
    assert.deepEqual(ctl.unread(), [], 'サーバから読めたので下ろした');
  } finally { ctl.dispose(); be.close(); }
});
