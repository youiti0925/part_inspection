// ============================================================================
// 🔁 2026-10-31 verify14: 製品・最終・部品で「起動して最初の購読の流れ」に見張り(心拍)が付いていなかった試験
// ----------------------------------------------------------------------------
//   各アプリと同じ順に組む: 窓口(pbClient)を作る → 札を入れる(ログインを待つ約束 setReady は無い)
//   → 保管庫を作る(autoRealtime でその場で GET /api/realtime) → DATA(db) の後で読み直しの係を付ける。
//     W1 … 製品と同じ(connectPocketbase の札の道: setToken・setReady なし・ブラウザの fetch)
//     W2 … 最終と同じ(onpremPbFactory: client.fetchHost → 札の係・setReady なし)
//     W3 … 部品と同じ(最初の GET に札が無い・後で札を入れる・ブラウザの fetch を札の係が包む)
//     W4 … ③と同じ(ログインを待つ約束がある)は、今までどおり開き直さない(起動の読みも増やさない)
//   どれも: 最初の流れも見張られ(心拍が /api/health を突く)、黙って死んだら切って張り直し、切れていた間の変更を読み直す。
// ⚠このファイルは4アプリで同じ中身。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPbClient } from '../pbClient.js';
import { createPocketbaseBackend } from '../pocketbaseBackend.js';
import { createMemoryStore } from '../outbox.js';
import { installReadRetry } from '../readRetry.js';

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
const authOf = (opts) => {
  const h = (opts && opts.headers) || {};
  return typeof h.get === 'function' ? h.get('Authorization') : (h.Authorization || null);
};

/** 小さな試験用サーバ(購読・申し込み・health・一覧)。 */
const mkServer = () => {
  const rows = new Map();
  let seq = 0;
  const st = { healthDown: false, healthGets: 0, realtimeGets: [], subscribePosts: 0, streams: [] };
  const put = (col, docId, data) => { rows.set(`${col}/${docId}`, { id: `r${String(rows.size + 1).padStart(14, '0')}`, ns: NS, col, docId, data, rev: 1, updated: '' }); };
  const forget = () => { st.streams.splice(0); };   // 黙った死: サーバは忘れたが流れは閉じない
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    const method = (opts.method || 'GET').toUpperCase();
    if (u.pathname === '/api/realtime' && method === 'GET') {
      st.realtimeGets.push({ auth: authOf(opts) });
      let ctl;
      const stream = new ReadableStream({ start: (c) => { ctl = c; } });
      st.streams.push(ctl);
      if (opts.signal) opts.signal.addEventListener('abort', () => { const i = st.streams.indexOf(ctl); if (i >= 0) st.streams.splice(i, 1); try { ctl.error(new DOMException('aborted', 'AbortError')); } catch { /* */ } });
      ctl.enqueue(enc.encode(`id:${++seq}\nevent:PB_CONNECT\ndata:${JSON.stringify({ clientId: `c${st.realtimeGets.length}` })}\n\n`));
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (u.pathname === '/api/realtime' && method === 'POST') { st.subscribePosts += 1; return new Response(null, { status: 204 }); }
    if (u.pathname === '/api/health') { st.healthGets += 1; if (st.healthDown) throw new TypeError('fetch failed'); return json({ code: 200 }); }
    if (u.pathname === '/api/collections/docs/records') {
      const f = String(u.searchParams.get('filter') || '');
      const col = (f.match(/col="([^"]*)"/) || [])[1];
      const items = [...rows.values()].filter((r) => r.col === col).map((r) => JSON.parse(JSON.stringify(r)));
      return json({ items, page: 1, perPage: 200, totalItems: items.length, totalPages: 1 });
    }
    return json({ message: 'not found' }, 404);
  };
  return { st, put, forget, fetchImpl };
};
const fakeWin = () => ({ addEventListener: () => {}, removeEventListener: () => {} });
const fakeTimers = () => {
  const tm = new Map(); let seq = 0;
  return {
    setTimeout: (f, ms) => { seq += 1; tm.set(seq, { f, ms }); return seq; },
    clearTimeout: (h) => { tm.delete(h); },
    pending: (ms) => [...tm.values()].filter((x) => ms == null || x.ms === ms).length,
    fire: () => { const xs = [...tm.entries()]; xs.forEach(([h]) => tm.delete(h)); xs.forEach(([, x]) => x.f()); },
  };
};
const quiet = async (fn) => {
  const w = console.warn; const e = console.error;
  console.warn = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.warn = w; console.error = e; }
};

/**
 * アプリと同じ順で組む。
 * @param wiring 'product' | 'final' | 'parts' | 'overview'
 */
const mkApp = async (srv, wiring, fn) => {
  const prevFetch = globalThis.fetch;
  let c;
  if (wiring === 'final') {
    // 最終: 札の係(session.pbFetch)を呼ぶ時に引く入れ物。ブラウザの fetch は通らない。
    globalThis.fetch = async () => { throw new Error('ブラウザの fetch は通らないはず'); };
    const pbFetch = (input, init = {}) => srv.fetchImpl(input, Object.assign({}, init, { headers: Object.assign({}, init.headers || {}, { Authorization: 'tok' }) }));
    const fetchHost = { fetch: (input, init) => pbFetch(input, init) };
    c = createPbClient({ url: BASE, fetchImpl: (input, init) => fetchHost.fetch(input, init) });
    c.fetchHost = fetchHost;
    c.setToken('tok');
  } else if (wiring === 'parts') {
    // 部品: ブラウザの fetch を札の係が包む(今の札を足す)。窓口に札が入るのは保管庫を作った後。
    globalThis.fetch = (input, init = {}) => srv.fetchImpl(input, Object.assign({}, init, { headers: Object.assign({}, init.headers || {}, { Authorization: 'tok' }) }));
    c = createPbClient({ url: BASE });
  } else {
    globalThis.fetch = srv.fetchImpl;
    c = createPbClient({ url: BASE });
    c.setToken('tok');
    if (wiring === 'overview') c.setReady(Promise.resolve());   // ③: 端末のログインを待つ約束がある
  }
  const be = createPocketbaseBackend(c, { outboxStore: createMemoryStore() });   // ← ここで最初の GET(③以外はその場で)
  if (wiring === 'parts') c.setToken('tok');                                     // 部品: attachSessionToPbClient
  const RT = fakeTimers(); const RS = fakeTimers();
  const ctl = installReadRetry(be, { win: fakeWin(), timers: RT, resyncTimers: RS });   // ← DATA(db) が付ける(保管庫を作った後)
  try {
    await quiet(() => fn({ c, be, rs: ctl.resync, RS }));
  } finally {
    ctl.dispose();
    be.close();
    globalThis.fetch = prevFetch;
  }
};

const firstStreamWatched = (wiring) => async () => {
  const srv = mkServer();
  srv.put('lots', 'L1', { name: 'one' });
  await mkApp(srv, wiring, async ({ be, rs, RS }) => {
    let rows = null;
    be.watchCollection(NS, 'lots', (r) => { rows = r; });
    await until(() => rows && rows.length === 1 && rs.stats().opens === 1, 4000, '最初の購読が係に見えた');
    // 最初の流れも見張られている: 心拍の時計が掛かっていて、動かすと /api/health を突く
    assert.equal(RS.pending(20000), 1, '心拍の時計が1つ掛かっている');
    const h0 = srv.st.healthGets;
    RS.fire();
    await until(() => rs.stats().pings === 1 && srv.st.healthGets === h0 + 1, 2000, '心拍が health を突いた');
    assert.equal(rs.stats().kicks, 0, '生きている流れは切らない');
    // 黙って死ぬ → 心拍が見つけて切る → 張り直し → 切れていた間の変更を読み直す
    const posts = srv.st.subscribePosts;
    srv.forget();
    srv.put('lots', 'L2', { name: 'two' });
    srv.st.healthDown = true;
    RS.fire();
    await until(() => rs.stats().pingFails === 1, 2000, '届かなかった');
    assert.equal(rs.stats().kicks, 1, '黙った最初の流れを切った');
    srv.st.healthDown = false;
    await until(() => srv.st.subscribePosts === posts + 1, 4000, '張り直し');
    await until(() => rows.length === 2, 3000, '切れていた間の変更が画面へ');
  });
  return srv;
};

test('W1 製品と同じ組み方(札の道・ログインを待つ約束なし): 起動して最初の流れも見張られる', async () => {
  const srv = await firstStreamWatched('product')();
  assert.ok(srv.st.realtimeGets.length >= 2, '係を付ける前に開いた流れは、1回だけ開き直させた');
});

test('W2 最終と同じ組み方(client.fetchHost・ログインを待つ約束なし): 起動して最初の流れも見張られる', async () => {
  await firstStreamWatched('final')();
});

test('W3 部品と同じ組み方(最初の GET に札が無い・後で札): 起動して最初の流れも見張られる', async () => {
  const srv = await firstStreamWatched('parts')();
  assert.equal(srv.st.realtimeGets[0].auth, 'tok', '試験の札の係が札を足している(窓口の札は無いまま送った)');
});

test('W4 ③と同じ組み方(ログインを待つ約束あり)は開き直さない・起動の読み直しもしない', async () => {
  const srv = await firstStreamWatched('overview')();
  assert.equal(srv.st.realtimeGets.length, 2, '最初の GET と、黙って死んだ後の張り直しの1回だけ');
});

test('W5 開き直させた時は「張り直せた」と同じに読み直す・続けて断るのは上限まで', async () => {
  const srv = mkServer();
  srv.put('lots', 'L1', { name: 'one' });
  await mkApp(srv, 'product', async ({ be, rs }) => {
    let rows = null;
    be.watchCollection(NS, 'lots', (r) => { rows = r; });
    await until(() => rows && rs.stats().opens === 1, 4000, '最初');
    assert.equal(rs.stats().adopts, 1, '見ていない流れの申し込みを1回だけ断った');
    assert.equal(srv.st.subscribePosts, 1, 'サーバへ届いた申し込みは係を通る流れの1回だけ');
    assert.equal(rs.stats().resyncs, 1, '開き直した間の変更を落とさないよう、1回読み直した');
  });
});
