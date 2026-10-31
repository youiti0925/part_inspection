// ============================================================================
// 🔁 2026-10-31 verify10(本当の切断の試験)で見つかった3つの直しの試験(src/data/realtimeResync.js・4アプリ同じ中身)
// ----------------------------------------------------------------------------
//   本物の pbClient と本物の pocketbaseBackend に、社内版の読み直しの係(installReadRetry → installRealtimeResync)を付け、
//   試験用の小さなサーバ(ページ分け・項目の選択・番号の絞り込み・更新時刻あり)につなぐ。
//     F1 … 窓口が「札の係」を通して送る(最終: client.fetchHost)時も、張り直しを見て切れていた間の変更を読み直す
//          (ブラウザの fetch は包まない)
//     F2 … 入口が 502 を返す間(PocketBase が落ちている)は、届かない時と同じにここで速く試し直す
//          (pbClient の待ちを延ばさない)・401 は今までどおり pbClient へそのまま
//     F3 … 同じ一覧の読みが同時に2つ来ても、ページは1回ずつしか読まない
//     F4 … 前に全部読めた一覧は、番号と更新時刻だけを読み、変わった物だけを読む(足した・直した・消したが正しく揃う・
//          答えは全部を順に読んだ時と同じ)
//     F5 … 全部読む時はページを並べて読み、答えの並びは順に読んだ時と同じ
//     F6 … 全部読む途中で届かなくなった一覧は、戻ったらすぐ全部をページで並べて読み直す(番号の一覧を作らない・答えはサーバの今の姿)
//     F7 … 見張り: 流れが黙って死んだ(閉じた知らせが来ない・何も届かない)のを見つけて切り、張り直して読み直す
//     F8 … 見張り: サーバの /api/health へ届かない時も流れを切り、張り直して読み直す
//     F9 … 見張り: 生きている流れ(届いている・health も届く)は切らない(空振りしない)
// ⚠pbClient.js / pocketbaseBackend.js は触っていない。このファイルは4アプリで同じ中身。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPbClient } from '../pbClient.js';
import { createPocketbaseBackend } from '../pocketbaseBackend.js';
import { createMemoryStore } from '../outbox.js';
import { installReadRetry } from '../readRetry.js';
import { isRetryableRealtimeStatus, installRealtimeResync, LIST_FULL_PER_PAGE, REALTIME_IDLE_MS } from '../realtimeResync.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000, what = '') => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`待ちきれませんでした: ${what}`);
    await sleep(10);
  }
};
const enc = new TextEncoder();
const NS = 'test-app-v1';
const BASE = 'http://127.0.0.1:1';

/** 試験用のサーバ。ページ分け(perPage)・fields・id の絞り込み・更新時刻(updated)を持つ。 */
const mkServer = () => {
  const rows = new Map();   // id -> rec
  let seq = 0; let clock = Date.parse('2026-10-31T00:00:00Z');
  const st = {
    down: false, realtimeStatus: 0, healthDown: false, healthGets: 0,   // realtimeStatus>0 の間、GET /api/realtime はその番号で答える(入口の 502 など)
    lists: [], realtimeGets: [], subscribePosts: 0, streams: [], inflightLists: 0, maxInflightLists: 0, listDelayMs: 0, okListsLeft: -1,
  };
  const recId = (docId) => `r${docId.toLowerCase().replace(/[^a-z0-9]/g, '')}`.padEnd(15, '0').slice(0, 15);
  const put = (col, docId, data, ns = NS) => {
    const id = recId(`${col}${docId}`);
    const had = rows.get(id);
    clock += 7;
    const rec = { id, ns, col, docId, data, rev: had ? had.rev + 1 : 1, updated: new Date(clock).toISOString().replace('T', ' '), collectionName: 'docs' };
    rows.set(id, rec);
    return rec;
  };
  const del = (col, docId) => { const id = recId(`${col}${docId}`); const had = rows.get(id); rows.delete(id); return had; };
  const push = (action, record) => {
    const line = `id:${++seq}\nevent:docs\ndata:${JSON.stringify({ action, record })}\n\n`;
    st.streams.forEach((c) => { try { c.enqueue(enc.encode(line)); } catch { /* 閉じている */ } });
  };
  const restart = () => { const xs = st.streams.splice(0); xs.forEach((c) => { try { c.close(); } catch { /* */ } }); };
  /** 黙った死: サーバは購読を忘れたが、流れは閉じない(閉じた知らせが端末へ届かない・TCP の片側だけ残る)。 */
  const forget = () => { st.streams.splice(0); };
  const json = (body, status = 200) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const match = (filter, r) => {
    const f = String(filter || '');
    const ns = (f.match(/(?:^|[\s(])ns="([^"]*)"/) || [])[1];
    const col = (f.match(/(?:^|[\s(])col="([^"]*)"/) || [])[1];
    const ids = [...f.matchAll(/(?:^|[\s(])id="([^"]*)"/g)].map((m) => m[1]);
    return (ns == null || r.ns === ns) && (col == null || r.col === col) && (!ids.length || ids.includes(r.id));
  };
  const fetchImpl = async (url, opts = {}) => {
    if (st.down) throw new TypeError('fetch failed');
    const u = new URL(url);
    const method = (opts.method || 'GET').toUpperCase();
    if (u.pathname === '/api/realtime' && method === 'GET') {
      st.realtimeGets.push({ at: Date.now(), status: st.realtimeStatus || 200, auth: (opts.headers || {}).Authorization || null });
      if (st.realtimeStatus) return json({ message: 'bad gateway' }, st.realtimeStatus);
      let ctl;
      const stream = new ReadableStream({ start: (c) => { ctl = c; } });
      st.streams.push(ctl);
      if (opts.signal) opts.signal.addEventListener('abort', () => { const i = st.streams.indexOf(ctl); if (i >= 0) st.streams.splice(i, 1); try { ctl.error(new DOMException('aborted', 'AbortError')); } catch { /* */ } });
      ctl.enqueue(enc.encode(`id:${++seq}\nevent:PB_CONNECT\ndata:${JSON.stringify({ clientId: `c${st.realtimeGets.length}` })}\n\n`));
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (u.pathname === '/api/health') { st.healthGets += 1; if (st.healthDown) throw new TypeError('fetch failed'); return json({ code: 200, message: 'API is healthy.' }); }
    if (u.pathname === '/api/realtime' && method === 'POST') { st.subscribePosts += 1; return new Response(null, { status: 204 }); }
    if (u.pathname === '/api/collections/docs/records' && method === 'GET') {
      const filter = u.searchParams.get('filter');
      const fields = u.searchParams.get('fields');
      const page = Number(u.searchParams.get('page') || 1);
      const perPage = Math.min(1000, Number(u.searchParams.get('perPage') || 30));
      st.inflightLists += 1; st.maxInflightLists = Math.max(st.maxInflightLists, st.inflightLists);
      try {
        const all = [...rows.values()].filter((r) => match(filter, r)).sort((a, b) => String(a.docId).localeCompare(String(b.docId)));
        if (st.listDelayMs) await sleep(st.listDelayMs);
        if (st.down) throw new TypeError('fetch failed');
        if (st.okListsLeft === 0) throw new TypeError('fetch failed');
        if (st.okListsLeft > 0) st.okListsLeft -= 1;
        const totalPages = Math.max(1, Math.ceil(all.length / perPage));
        const items = all.slice((page - 1) * perPage, page * perPage)
          .map((r) => (fields ? Object.fromEntries(fields.split(',').map((k) => [k, r[k]])) : JSON.parse(JSON.stringify(r))));
        st.lists.push({ filter, fields, page, perPage, n: items.length });
        return json({ items, page, perPage, totalItems: all.length, totalPages });
      } finally { st.inflightLists -= 1; }
    }
    return json({ message: 'not found' }, 404);
  };
  return { st, rows, put, del, push, restart, forget, fetchImpl };
};

const fakeWin = () => {
  const ls = new Map();
  return {
    addEventListener: (t, f) => { if (!ls.has(t)) ls.set(t, new Set()); ls.get(t).add(f); },
    removeEventListener: (t, f) => { ls.get(t)?.delete(f); },
    fire: (t) => { [...(ls.get(t) || [])].forEach((f) => f()); },
  };
};
const fakeTimers = () => {
  const tm = new Map(); let seq = 0;
  return {
    setTimeout: (f, ms) => { seq += 1; tm.set(seq, { f, ms }); return seq; },
    clearTimeout: (h) => { tm.delete(h); },
    fire: () => { const xs = [...tm.entries()]; xs.forEach(([h]) => tm.delete(h)); xs.forEach(([, x]) => x.f()); },
  };
};
const quiet = async (fn) => {
  const w = console.warn; const e = console.error;
  console.warn = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.warn = w; console.error = e; }
};

/**
 * 組み立て。viaHost=true は最終と同じ(pbClient → fetchHost.fetch → 札の係 → サーバ。ブラウザの fetch は通らない)。
 */
const mk = async (srv, fn, { viaHost = false } = {}) => {
  const prevFetch = globalThis.fetch;
  const W = fakeWin(); const RT = fakeTimers();
  let c; let host = null; const seenByHost = [];
  if (viaHost) {
    globalThis.fetch = async () => { throw new Error('ブラウザの fetch は通らないはず'); };
    // 札の係(session.pbFetch)の代わり: 今の札を付けて、起動の時に握った fetch(= サーバ)で送る
    const pbFetch = (input, init = {}) => { seenByHost.push(String(input)); return srv.fetchImpl(input, Object.assign({}, init, { headers: Object.assign({}, init.headers || {}, { Authorization: 'test-token' }) })); };
    host = { fetch: (input, init) => pbFetch(input, init) };
    c = createPbClient({ url: BASE, fetchImpl: (input, init) => host.fetch(input, init) });
    c.fetchHost = host;
  } else {
    globalThis.fetch = srv.fetchImpl;
    c = createPbClient({ url: BASE });
  }
  c.setToken('test-token');
  c.setReady(Promise.resolve());
  const be = createPocketbaseBackend(c, { outboxStore: createMemoryStore() });
  const ctl = installReadRetry(be, { win: W, timers: RT });
  try {
    await quiet(() => fn({ c, be, ctl, rs: ctl.resync, W, RT, host, seenByHost }));
  } finally {
    ctl.dispose();
    be.close();
    globalThis.fetch = prevFetch;
  }
};
const idsOf = (rows) => rows.map((r) => r.id).sort();

test('F1 札の係を通す窓口(client.fetchHost・最終と同じ)でも、張り直しを見て切れていた間の変更を読み直す・ブラウザの fetch は包まない', async () => {
  const srv = mkServer();
  srv.put('lots', 'L1', { name: 'one' });
  srv.put('lots', 'L2', { name: 'two' });
  const prevFetch = globalThis.fetch;
  await mk(srv, async ({ be, rs, host, seenByHost }) => {
    assert.ok(host.fetch.__inspectionRealtimeFetch, '係は fetchHost を包む');
    assert.equal(globalThis.fetch.__inspectionRealtimeFetch, undefined, 'ブラウザの fetch は包まない');
    let rows = null;
    be.watchCollection(NS, 'lots', (r) => { rows = r; });
    await until(() => rows && rows.length === 2 && srv.st.subscribePosts === 1, 2000, '最初');
    assert.ok(seenByHost.some((u) => u.endsWith('/api/realtime')), '購読の要求は札の係を通っている');
    assert.equal(rs.stats().opens, 1, '係が申し込みを見た');
    srv.st.down = true; srv.restart();
    await until(() => rs.isLive() === false, 2000, '切れた');
    srv.put('lots', 'L1', { name: 'one-after' });
    srv.put('lots', 'L3', { name: 'three' });
    srv.st.down = false;
    await until(() => srv.st.subscribePosts === 2, 6000, '張り直し');
    await until(() => idsOf(rows).join() === 'L1,L2,L3' && rows.find((r) => r.id === 'L1').name === 'one-after', 3000, '切れていた間の変更が画面へ');
    assert.equal(rs.stats().resyncs, 1);
    assert.deepEqual(rs.stats().subscribed, [`${NS}/lots`], '購読が数えられている');
  }, { viaHost: true });
  assert.equal(globalThis.fetch, prevFetch);
});

test('F2 入口が 502 を返す間は、届かない時と同じにここで速く試し直す(pbClient の待ちを延ばさない)・401 は pbClient へ', async () => {
  assert.equal(isRetryableRealtimeStatus(502), true);
  assert.equal(isRetryableRealtimeStatus(503), true);
  assert.equal(isRetryableRealtimeStatus(504), true);
  assert.equal(isRetryableRealtimeStatus(429), true);
  assert.equal(isRetryableRealtimeStatus(401), false);
  assert.equal(isRetryableRealtimeStatus(403), false);
  assert.equal(isRetryableRealtimeStatus(200), false);
  for (const viaHost of [false, true]) {
    const srv = mkServer();
    srv.put('lots', 'L1', { name: 'one' });
    await mk(srv, async ({ be, rs }) => {
      let rows = null;
      be.watchCollection(NS, 'lots', (r) => { rows = r; });
      await until(() => rows && srv.st.subscribePosts === 1, 2000, '最初');
      // PocketBase が落ちた: 流れが閉じ、入口は 502 を返し続ける
      srv.st.realtimeStatus = 502; srv.restart();
      await until(() => rs.isLive() === false, 2000, '切れた');
      await sleep(3200);   // 0.5 → 1 → 2 秒(pbClient だけなら 0.5→1→2→4…と延び、しかも pbClient の待ちが倍々に残る)
      const n502 = srv.st.realtimeGets.filter((g) => g.status === 502).length;
      assert.ok(n502 >= 3 && n502 <= 5, `502 の間は係が 0.5 秒から倍々で試し直す(${n502}回)`);
      srv.put('lots', 'L2', { name: 'two' });
      srv.st.realtimeStatus = 0;   // 戻った
      const t0 = Date.now();
      await until(() => srv.st.subscribePosts === 2, 6000, '張り直し');
      assert.ok(Date.now() - t0 < 4200, `戻ってから張り直すまで ${Date.now() - t0}ms(係の待ちは最大でも次の1回分)`);
      await until(() => rows.length === 2, 2000, '読み直し');
      // 401 は係が抱えずに pbClient へ渡す(pbClient が今までどおり待って張り直す)
      const gets = srv.st.realtimeGets.length;
      srv.st.realtimeStatus = 401; srv.restart();
      await sleep(900);
      const n401 = srv.st.realtimeGets.length - gets;
      assert.ok(n401 >= 1 && n401 <= 2, `401 はその場で試し直さない(${n401}回)`);
      srv.st.realtimeStatus = 0;
    }, { viaHost });
  }
});

test('F3 同じ一覧の読みが同時に2つ来ても(張り直しの読み直し + 読み直しの係)、ページは1回ずつしか読まない', async () => {
  const srv = mkServer();
  for (let i = 0; i < 1200; i++) srv.put('lot_images', `I${String(i).padStart(4, '0')}`, { n: i });
  await mk(srv, async ({ be, c }) => {
    srv.st.listDelayMs = 20;
    const n0 = srv.st.lists.length;
    const [a, b] = await Promise.all([be.refresh(NS, 'lot_images'), be.refresh(NS, 'lot_images')]);
    assert.equal(a, 1200); assert.equal(b, 1200);
    const pages = srv.st.lists.slice(n0).map((x) => x.page);
    assert.deepEqual(pages.slice().sort((x, y) => x - y), [1, 2, 3], `同じページを2回読まない(${pages.join(',')})`);
    assert.equal(typeof c.listAll, 'function');
  });
});

test('F4 前に全部読めた一覧は、番号と更新時刻だけを読み、変わった物だけを読む(足した・直した・消したが揃い、答えは全部読んだ時と同じ)', async () => {
  const srv = mkServer();
  for (let i = 0; i < 450; i++) srv.put('lot_images', `I${String(i).padStart(4, '0')}`, { n: i, big: 'x'.repeat(50) });
  await mk(srv, async ({ be, rs, c }) => {
    let rows = null;
    be.watchQuery(NS, 'lot_images', {}, (r) => { rows = r; });
    await until(() => rows && rows.length === 450 && srv.st.subscribePosts === 1, 3000, '最初(全部)');
    const full0 = srv.st.lists.filter((x) => !x.fields).length;
    assert.equal(full0, 1, `最初は全部(${LIST_FULL_PER_PAGE}件ずつ = 1ページ)`);
    // 切れている間に: 2件直す・1件消す・1件足す
    srv.st.down = true; srv.restart();
    await until(() => rs.isLive() === false, 2000, '切れた');
    srv.put('lot_images', 'I0007', { n: 7, big: 'changed' });
    srv.put('lot_images', 'I0300', { n: 300, big: 'changed' });
    srv.del('lot_images', 'I0100');
    srv.put('lot_images', 'I9999', { n: 9999, big: 'new' });
    const n0 = srv.st.lists.length;
    srv.st.down = false;
    await until(() => srv.st.subscribePosts === 2, 6000, '張り直し');
    await until(() => rows.length === 450 && rows.some((r) => r.id === 'I9999') && rows.find((r) => r.id === 'I0007').big === 'changed', 3000, '変更が揃う');
    await sleep(50);
    assert.equal(rows.some((r) => r.id === 'I0100'), false, '消えた物は落ちる');
    assert.equal(rows.find((r) => r.id === 'I0300').big, 'changed');
    const after = srv.st.lists.slice(n0);
    assert.equal(after.filter((x) => !x.fields && !/id="/.test(x.filter)).length, 0, '全部は読まない');
    assert.equal(after.filter((x) => x.fields === 'id,updated').length, 1, '番号と更新時刻だけを1ページ(1000件まで)');
    const changedRead = after.filter((x) => /id="/.test(x.filter)).reduce((s, x) => s + x.n, 0);
    assert.equal(changedRead, 3, '変わった物(直した2件・足した1件)だけを読む');
    assert.equal(rs.stats().lists.delta >= 1, true);
    // 答えは全部を順に読んだ時と同じ(中身・並び)
    const viaDelta = await c.listAll('docs', { filter: `ns="${NS}" && col="lot_images"`, sort: 'docId' });
    const r = await srv.fetchImpl(`${BASE}/api/collections/docs/records?page=1&perPage=1000&filter=${encodeURIComponent(`ns="${NS}" && col="lot_images"`)}&sort=docId`);
    const truth = (await r.json()).items;
    assert.deepEqual(viaDelta.map((x) => [x.id, x.updated, x.data.n]), truth.map((x) => [x.id, x.updated, x.data.n]));
  });
});

test('F5 全部読む時はページを並べて読み、答えの並びは順に読んだ時と同じ・項目を選ぶ読みは今までどおり', async () => {
  const srv = mkServer();
  for (let i = 0; i < 1300; i++) srv.put('lots', `D${String(i).padStart(5, '0')}`, { n: i });
  await mk(srv, async ({ c }) => {
    srv.st.listDelayMs = 15;
    const got = await c.listAll('docs', { filter: `ns="${NS}" && col="lots"`, sort: 'docId' });
    assert.equal(got.length, 1300);
    assert.deepEqual(got.map((x) => x.data.n), Array.from({ length: 1300 }, (_, i) => i), '並びは順に読んだ時と同じ');
    assert.ok(srv.st.maxInflightLists >= 2 && srv.st.maxInflightLists <= 4, `並べて読む(同時 ${srv.st.maxInflightLists})`);
    const n0 = srv.st.lists.length;
    const sel = await c.listAll('docs', { filter: `ns="${NS}" && col="lots"`, sort: 'docId', fields: 'id' });
    assert.equal(sel.length, 1300);
    assert.ok(srv.st.lists.slice(n0).every((x) => x.fields === 'id'), '項目を選ぶ読みは元の listAll');
  });
});

test('F6 全部読む途中で届かなくなった一覧は、戻ったらすぐ全部をページで並べて読み直す(番号の一覧を作らない・答えはサーバの今の姿)', async () => {
  const srv = mkServer();
  for (let i = 0; i < 2500; i++) srv.put('lot_images', `I${String(i).padStart(4, '0')}`, { n: i });
  await mk(srv, async ({ c, rs }) => {
    const opts = { filter: `ns="${NS}" && col="lot_images"`, sort: 'docId' };
    srv.st.okListsLeft = 3;   // 5ページのうち3ページだけ読めて、そこで落ちる
    await assert.rejects(c.listAll('docs', opts));
    srv.st.okListsLeft = -1;
    srv.put('lot_images', 'I0001', { n: 1, changed: true });
    srv.del('lot_images', 'I0002');
    const n0 = srv.st.lists.length;
    const got = await c.listAll('docs', opts);
    const after = srv.st.lists.slice(n0);
    assert.equal(after.filter((x) => x.fields || /id="/.test(x.filter)).length, 0, '番号の一覧・番号での読みはしない');
    assert.deepEqual(after.map((x) => x.page).sort((a, b) => a - b), [1, 2, 3, 4, 5], '全部を1回ずつ');
    assert.ok(after.every((x) => x.perPage === LIST_FULL_PER_PAGE), `1ページ ${LIST_FULL_PER_PAGE} 件`);
    assert.equal(got.length, 2499);
    assert.deepEqual(got.map((x) => x.data.n), Array.from({ length: 2500 }, (_, i) => i).filter((i) => i !== 2), '並びも中身もサーバの今の姿');
    assert.equal(got.find((x) => x.data.n === 1).data.changed, true);
    assert.equal(rs.stats().lists.delta, 0, '途中で切れた物は控えにしない');
  });
});

/** 見張りの試験の組み立て: 本物の pbClient・保管庫に、購読の係を時計と時間を差し替えて付ける。 */
const mkWatch = async (srv, fn) => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = srv.fetchImpl;
  const W = fakeWin(); const RT = fakeTimers();
  const docLs = new Set();
  const D = {
    visibilityState: 'visible',
    addEventListener: (t, f) => { if (t === 'visibilitychange') docLs.add(f); },
    removeEventListener: (t, f) => { docLs.delete(f); },
    fire: () => { [...docLs].forEach((f) => f()); },
  };
  let clock = 1000000;
  const c = createPbClient({ url: BASE });
  c.setToken('test-token');
  c.setReady(Promise.resolve());
  const be = createPocketbaseBackend(c, { outboxStore: createMemoryStore() });
  const rs = installRealtimeResync(be, { win: W, doc: D, timers: RT, now: () => clock });
  try {
    await quiet(() => fn({ be, rs, RT, D, tick: (ms) => { clock += ms; } }));
  } finally {
    rs.dispose();
    be.close();
    globalThis.fetch = prevFetch;
  }
};

test('F7 見張り: 流れが黙って死んだ(閉じた知らせが来ない)時は、何も届かない時間で見つけて切り、張り直して読み直す', async () => {
  const srv = mkServer();
  srv.put('lots', 'L1', { name: 'one' });
  await mkWatch(srv, async ({ be, rs, tick }) => {
    let rows = null;
    be.watchCollection(NS, 'lots', (r) => { rows = r; });
    await until(() => rows && rows.length === 1 && srv.st.subscribePosts === 1, 2000, '最初');
    srv.forget();                                   // サーバは忘れた・流れは閉じない
    srv.put('lots', 'L2', { name: 'two' });         // 知らせは届かない
    tick(REALTIME_IDLE_MS - 1000);
    await rs.checkNow();
    assert.equal(rs.stats().kicks, 0, 'まだ切らない(5分は普通に黙る事がある)');
    assert.equal(rs.isLive(), true);
    tick(2000);
    await rs.checkNow();
    assert.equal(rs.stats().kicks, 1, '何も届かない時間が過ぎたら切る');
    await until(() => srv.st.subscribePosts === 2, 4000, '張り直し');
    await until(() => rows.length === 2, 3000, '切れていた間の変更が画面へ');
    assert.equal(rs.stats().resyncs, 1);
  });
});

test('F8 見張り: サーバの /api/health へ届かない時は流れを切り、届くようになったら張り直して読み直す', async () => {
  const srv = mkServer();
  srv.put('lots', 'L1', { name: 'one' });
  await mkWatch(srv, async ({ be, rs, RT }) => {
    let rows = null;
    be.watchCollection(NS, 'lots', (r) => { rows = r; });
    await until(() => rows && rows.length === 1 && srv.st.subscribePosts === 1, 2000, '最初');
    srv.forget();
    srv.put('lots', 'L2', { name: 'two' });
    srv.st.healthDown = true;
    RT.fire();   // 間隔の見張り(時計は進めない = 何も届かない時間では切らない)
    await until(() => rs.stats().pingFails === 1, 2000, '届かなかった');
    assert.equal(rs.stats().kicks, 1, '流れを切った');
    srv.st.healthDown = false;
    await until(() => srv.st.subscribePosts === 2, 4000, '張り直し');
    await until(() => rows.length === 2, 3000, '読み直し');
  });
});

test('F9 見張り: 生きている流れ(届いている・health も届く)は切らない。前に出た時はすぐ1回確かめる', async () => {
  const srv = mkServer();
  srv.put('lots', 'L1', { name: 'one' });
  await mkWatch(srv, async ({ be, rs, D, tick }) => {
    let rows = null;
    be.watchCollection(NS, 'lots', (r) => { rows = r; });
    await until(() => rows && srv.st.subscribePosts === 1, 2000, '最初');
    for (let i = 0; i < 5; i++) {
      tick(REALTIME_IDLE_MS - 1000);   // 毎回、切る手前まで黙る → 知らせが届く
      srv.push('update', srv.put('lots', 'L1', { name: `n${i}` }));
      await until(() => rows[0].name === `n${i}`, 2000, '知らせ');
      await rs.checkNow();
    }
    assert.equal(rs.stats().kicks, 0, '空振りしない');
    assert.equal(rs.stats().pings, 5);
    const h0 = srv.st.healthGets;
    D.fire();
    await until(() => srv.st.healthGets === h0 + 1, 2000, '前に出た時に1回');
    assert.equal(srv.st.subscribePosts, 1, '張り直していない');
  });
});
