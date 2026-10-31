// ============================================================================
// 🔁 R39 の残り: 届かない間に読めなかった一覧を、つながったら全部読み直す(src/data/readRetry.js)
// ----------------------------------------------------------------------------
//   RT1 … 理由の見分け(通信の失敗だけを読み直す物にする)
//   RT2〜RT4 … 本物の PocketBase の保管庫(pocketbaseBackend)を窓口(createProvider)越しに使い、
//         届かない → 届くに切り替えて、各アプリの代表の一覧が「失敗 → 登録 → つながった合図で読み直し → 画面の購読にサーバの答え」
//         になる事を確かめる。
//           製品: logs(watchCollection)・年間目標の設定(watchDoc)・最終/部品のロット(getAll = 1回だけ読む)
//           最終: lot_images(watchQuery)
//           部品: 共有棚の plan_control(watchDoc)
//         合図は3つ: ブラウザの online / サーバへの要求が通った / 間隔(倍々で空ける)。
//   RT5 … 権限・ログインの失敗は登録しない・ログインできていない間は読み直さない(0件で確定させない)。
//   RT6 … 外すと元に戻る・2回取り付けない。
// ⚠このファイルは4アプリで同じ中身。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installReadRetry, readRetryOfProvider, isRetryableReadError, unreadLabel, READ_RETRY_FIRST_MS, READ_RETRY_MAX_MS } from '../readRetry.js';
import { createPocketbaseBackend } from '../pocketbaseBackend.js';
import { createProvider } from '../provider.js';
import { DEFAULT_PROVIDERS, NS } from '../routes.js';
import { createMemoryStore } from '../outbox.js';
import { PbNetworkError, PbHttpError } from '../pbClient.js';

const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const ALL_PB = Object.freeze(Object.fromEntries(Object.keys(DEFAULT_PROVIDERS).map((k) => [k, 'pocketbase'])));

const fakeTimers = () => {
  const tm = new Map(); let seq = 0;
  return {
    setTimeout: (f, ms) => { seq += 1; tm.set(seq, { f, ms }); return seq; },
    clearTimeout: (h) => { tm.delete(h); },
    fire: () => { const xs = [...tm.entries()]; xs.forEach(([h]) => tm.delete(h)); xs.forEach(([, x]) => x.f()); },
    ms: () => [...tm.values()].map((x) => x.ms),
  };
};
const fakeWin = () => {
  const ls = new Map();
  return {
    addEventListener: (t, f) => { if (!ls.has(t)) ls.set(t, new Set()); ls.get(t).add(f); },
    removeEventListener: (t, f) => { ls.get(t)?.delete(f); },
    fire: (t) => { [...(ls.get(t) || [])].forEach((f) => f()); },
    n: (t) => (ls.get(t)?.size || 0),
  };
};

const mkServer = () => {
  const rows = [
    { ns: NS.product, col: 'logs', docId: 'g1', data: { msg: '検査開始' } },
    { ns: NS.goals, col: 'settings', docId: 'config', data: { fiscalStartMonth: 12 } },
    { ns: NS.final, col: 'lots', docId: 'F1', data: { id: 'F1', status: 'completed' } },
    { ns: NS.parts, col: 'lots', docId: 'P1', data: { id: 'P1', status: 'completed' } },
    { ns: NS.final, col: 'lot_images', docId: 'i1', data: { lotId: 'F1', kind: 'defect' } },
    { ns: NS.final, col: 'lot_images', docId: 'i2', data: { lotId: 'F1', kind: 'normal' } },
    { ns: NS.capacity, col: 'plan_control', docId: 'parts', data: { head: 'v3' } },
  ].map((r, i) => ({ id: `r${i}`, rev: 1, ...r }));
  const st = { reachable: true, authed: true, listCalls: 0, err: () => new PbNetworkError(new Error('Failed to fetch'), 'http://127.0.0.1:8120/api/collections/docs/records') };
  const parse = (f = '') => Object.fromEntries([...String(f).matchAll(/(\w+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const client = {
    isAuthed: () => st.authed,
    listPage: async (col, { filter } = {}) => {
      st.listCalls += 1;
      if (!st.reachable) throw st.err();
      const want = parse(filter);
      const items = rows.filter((r) => Object.entries(want).every(([k, v]) => String(r[k] ?? '') === v));
      return { items, totalItems: items.length, totalPages: 1 };
    },
    listAll: async (col, opts) => (await client.listPage(col, opts)).items,
    getOne: async () => { if (!st.reachable) throw st.err(); return {}; },
    create: async () => { if (!st.reachable) throw st.err(); return {}; },
    update: async () => { if (!st.reachable) throw st.err(); return {}; },
    remove: async () => { if (!st.reachable) throw st.err(); return {}; },
    openRealtime: () => () => {},
  };
  return { st, client };
};
const mk = (opts = {}) => {
  const { st, client } = mkServer();
  const be = createPocketbaseBackend(client, { outboxStore: createMemoryStore(), autoRealtime: false });
  const P = createProvider({ backends: { firebase: {}, pocketbase: be }, providers: ALL_PB });
  const T = fakeTimers(); const W = fakeWin();
  const ctl = readRetryOfProvider(P, { win: W, timers: T, ...opts });
  return { st, client, be, P, T, W, ctl };
};
const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };

test('RT1 理由の見分け: 通信の失敗・入口の 502/503/504 だけを読み直す。権限・ログイン・形の誤りは読み直さない', () => {
  assert.equal(isRetryableReadError(new PbNetworkError(new Error('fetch failed'), 'http://x')), true);
  assert.equal(isRetryableReadError(new PbHttpError(503, 'x', 'http://x')), true);
  assert.equal(isRetryableReadError('TypeError: Failed to fetch'), true);
  assert.equal(isRetryableReadError(new PbHttpError(403, 'forbidden', 'http://x')), false);
  assert.equal(isRetryableReadError(new Error('まだログインできていません(この0件はデータが無い意味ではありません)')), false);
  assert.equal(isRetryableReadError(null), false);
  assert.equal(unreadLabel({ ns: NS.product, col: 'logs' }, NS.product), 'logs');
  assert.equal(unreadLabel({ ns: NS.goals, col: 'settings' }, NS.product), `${NS.goals}/settings`);
  assert.ok(READ_RETRY_FIRST_MS < READ_RETRY_MAX_MS);
});

test('RT2 製品の代表: logs・年間目標の設定(購読)と、最終/部品のロット(1回だけ読む)が、つながった合図(online)で全部読み直される', async () => {
  const { st, P, T, W, ctl, be } = mk();
  try {
    st.reachable = false;
    const scr = { logs: null, goal: undefined, errs: [] };
    const seen = [];
    ctl.subscribe((list) => seen.push(list.map((u) => u.key).sort()));
    const recovered = [];
    ctl.onRecovered((keys) => recovered.push(...keys));
    await quiet(async () => {
      P.watchCollection(NS.product, 'logs', (rows, snap) => { scr.logs = { rows, fromCache: snap.metadata.fromCache }; }, { onError: (e) => scr.errs.push(['logs', e.name]) });
      P.watchDoc(NS.goals, 'settings', 'config', (d) => { scr.goal = d; }, { onError: () => scr.errs.push(['goal', 'x']) });
      // 1回だけ読む(製品の年間目標の横断読み): 届かない間は控え(空)が返る = 落とさない
      const fl = await P.getAll(NS.final, 'lots'); const pl = await P.getAll(NS.parts, 'lots');
      assert.deepEqual([fl.length, pl.length], [0, 0]);
      await flush();
    });
    assert.deepEqual(ctl.unread().map((u) => u.key).sort(), [`${NS.final}/lots`, `${NS.goals}/settings`, `${NS.parts}/lots`, `${NS.product}/logs`]);
    assert.ok(scr.errs.some(([k]) => k === 'logs'), '画面の onError も今までどおり呼ばれる');
    assert.deepEqual(T.ms(), [READ_RETRY_FIRST_MS], '間隔の読み直しが1つだけ待っている');

    // まだ届かない: 間隔の読み直しは失敗 → 登録は残り、間隔は倍に
    T.fire(); await flush();
    assert.equal(ctl.unread().length, 4);
    assert.deepEqual(T.ms(), [READ_RETRY_FIRST_MS * 2]);

    // つながった(online の合図)
    st.reachable = true;
    W.fire('online'); await flush();
    assert.deepEqual(ctl.unread(), [], '全部読めた');
    assert.deepEqual(scr.logs.rows.map((r) => r.id), ['g1'], '画面の logs の購読にサーバの答えが届いた(張り直していない)');
    assert.equal(scr.logs.fromCache, false);
    assert.deepEqual(scr.goal, { fiscalStartMonth: 12 }, '年間目標の設定の購読にも届いた');
    assert.deepEqual(recovered.sort(), [`${NS.final}/lots`, `${NS.goals}/settings`, `${NS.parts}/lots`, `${NS.product}/logs`]);
    // 1回だけ読む画面は onRecovered の合図でやり直せば、今度はサーバの中身
    assert.deepEqual((await P.getAll(NS.final, 'lots')).map((r) => r.id), ['F1']);
    assert.deepEqual((await P.getAll(NS.parts, 'lots')).map((r) => r.id), ['P1']);
    assert.deepEqual(seen.at(-1), [], '画面へ「読めていない物は無い」と知らせた');
    assert.deepEqual(T.ms(), [], '読む物が無くなったら待ちも無い');
  } finally { ctl.dispose(); be.close(); }
});

test('RT3 最終の代表: lot_images(絞り込みの購読)が、他の要求が通った合図で読み直され、絞り込んだ答えが届く', async () => {
  const { st, P, T, ctl, be, client } = mk();
  try {
    st.reachable = false;
    let got = null; let err = null;
    await quiet(async () => {
      P.watchQuery(NS.final, 'lot_images', { where: [['kind', '==', 'defect']] }, (rows, snap) => { got = { ids: rows.map((r) => r.id), fromCache: snap.metadata.fromCache }; }, { onError: (e) => { err = e; } });
      await flush();
    });
    assert.ok(err, '画面へは今までどおり失敗が届く');
    assert.deepEqual(ctl.unread().map((u) => u.key), [`${NS.final}/lot_images`]);
    // つながった: ブラウザの online は来ない(サーバだけ落ちていた)が、別の要求(送信など)が通った
    st.reachable = true;
    await client.create('docs', {});
    await flush();
    assert.deepEqual(ctl.unread(), []);
    assert.deepEqual(got, { ids: ['i1'], fromCache: false });
    assert.deepEqual(T.ms(), []);
  } finally { ctl.dispose(); be.close(); }
});

test('RT4 部品の代表: 共有棚の plan_control(1件の購読)が、合図が無くても間隔の読み直し(倍々・上限あり)で読み直される', async () => {
  const { st, P, T, ctl, be } = mk({ firstMs: 1000, maxMs: 4000 });
  try {
    st.reachable = false;
    let head = null;
    await quiet(async () => { P.watchDoc(NS.capacity, 'plan_control', 'parts', (d) => { head = d; }, {}); await flush(); });
    assert.equal(head, null);
    assert.deepEqual(ctl.unread().map((u) => u.key), [`${NS.capacity}/plan_control`]);
    assert.deepEqual(T.ms(), [1000]);
    T.fire(); await flush(); assert.deepEqual(T.ms(), [2000]);
    T.fire(); await flush(); assert.deepEqual(T.ms(), [4000]);
    T.fire(); await flush(); assert.deepEqual(T.ms(), [4000], '上限で止まる');
    st.reachable = true;
    T.fire(); await flush();
    assert.deepEqual(head, { head: 'v3' });
    assert.deepEqual(ctl.unread(), []);
    assert.deepEqual(T.ms(), []);
  } finally { ctl.dispose(); be.close(); }
});

test('RT5 権限の失敗は登録しない・ログインできていない間は読み直さない(0件で「読めた」にしない)', async () => {
  const { st, P, T, W, ctl, be } = mk();
  try {
    st.reachable = false;
    let logs = null;
    await quiet(async () => { P.watchCollection(NS.product, 'logs', (rows, snap) => { logs = { n: rows.length, fromCache: snap.metadata.fromCache }; }, {}); await flush(); });
    assert.equal(ctl.unread().length, 1);
    // サーバは戻ったが、ログインが外れている → 読みに行かない・登録は残る
    st.reachable = true; st.authed = false;
    const before = st.listCalls;
    W.fire('online'); await flush();
    assert.equal(st.listCalls, before, '未ログインでは一覧を取りに行かない');
    assert.equal(ctl.unread().length, 1);
    assert.equal(logs.fromCache, true, '空の控えを「サーバの答え」にしていない');
    st.authed = true;
    W.fire('online'); await flush();
    assert.deepEqual(ctl.unread(), []);
    assert.deepEqual(logs, { n: 1, fromCache: false });
    // 権限の失敗(403)は登録しない
    st.reachable = false; st.err = () => new PbHttpError(403, 'forbidden', 'http://x');
    await quiet(async () => { P.watchCollection(NS.product, 'workers', () => {}, {}); await flush(); });
    assert.deepEqual(ctl.unread(), []);
    assert.deepEqual(T.ms(), []);
  } finally { ctl.dispose(); be.close(); }
});

test('RT6 2回取り付けない・外すと元の口に戻り、online の合図も外れる', () => {
  const { be, W, ctl, client } = mk();
  const again = installReadRetry(be, { win: W });
  assert.equal(again, ctl);
  assert.equal(W.n('online'), 1);
  ctl.dispose();
  assert.equal(W.n('online'), 0);
  assert.equal(client.listPage.name, 'listPage');
  const ctl2 = installReadRetry(be, { win: W });
  assert.notEqual(ctl2, ctl, '外した後はもう一度付けられる');
  ctl2.dispose();
  be.close();
});
