// ============================================================================
// 🔁 購読(SSE)が切れた後の張り直しと、切れていた間の取りこぼしの読み直し(src/data/realtimeResync.js・2026-10-31)
// ----------------------------------------------------------------------------
//   本物の pbClient(fetch で SSE を読む・張り直しの輪は今までのまま)と本物の pocketbaseBackend に、
//   社内版の読み直しの係(installReadRetry → installRealtimeResync)を付け、試験用の小さなサーバ(globalThis.fetch の差し替え)につなぐ。
//   サーバの再起動(流れが閉じる → しばらく届かない → 戻る)・回線が落ちた(流れが黙ったまま → online)を作り、
//     RC1 … 流れが閉じたら張り直す(購読の申し込みをもう一度送る)・届かない間も pbClient の待ちを延ばさない・「張り直せた」を言う
//     RC2 … 切れていた間のサーバの変更(足した・消した・直した)が、張り直した後に購読の画面へ届く(知らせ無しで・1回だけ読み直す)
//     RC3 … 購読していない一覧(1回だけ読んだ物)は、次に読む時にサーバから読み直してから返す
//     RC4 … online の合図: 届かずに待っている間はすぐ張り直す・つながっているつもりの黙った流れは切って張り直す
//     RC5 … 読み直しの最中にその一覧の知らせが届いたら、もう1回だけ読み直す(古い答えで新しい変更を消さない)
//     RC6 … 張り直した後の読み直しが失敗したら、読み直しの係の「読み直す物」に入り、読めたら下りる
//     RC7 … 起動して1回目に素直につながった時は読み直さない・外すと fetch が元に戻る・ほかの要求は素通し
// ⚠pbClient.js / pocketbaseBackend.js は触っていない(いつものビルドの出力に入っているため)。係は社内版だけが付ける。
// ⚠このファイルは4アプリで同じ中身。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPbClient } from '../pbClient.js';
import { createPocketbaseBackend } from '../pocketbaseBackend.js';
import { createMemoryStore } from '../outbox.js';
import { installReadRetry } from '../readRetry.js';
import { installRealtimeResync } from '../realtimeResync.js';

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

/** 試験用のサーバ。docs だけを持ち、SSE の流れを出す。 */
const mkServer = () => {
  const rows = new Map();   // id -> { id, ns, col, docId, data, rev }
  let seq = 0;
  const st = {
    down: false,            // true = 届かない(fetch が失敗する)
    listFail: 0,            // >0 の間、一覧の読みが 503 で失敗する(回数)
    listGate: null,         // Promise: これが解けるまで一覧の答えを返さない
    listCalls: [],          // 読んだ一覧(ns/col)
    subscribePosts: 0,
    sseOpens: 0,
    streams: [],            // 開いている流れ(controller)
  };
  const put = (col, docId, data, ns = NS) => {
    const id = `${ns}|${col}|${docId}`;
    const had = rows.get(id);
    const rec = { id, ns, col, docId, data, rev: had ? had.rev + 1 : 1, collectionName: 'docs' };
    rows.set(id, rec);
    return rec;
  };
  const del = (col, docId, ns = NS) => {
    const id = `${ns}|${col}|${docId}`;
    const had = rows.get(id);
    rows.delete(id);
    return had;
  };
  const push = (action, record) => {
    const line = `id:${++seq}\nevent:docs\ndata:${JSON.stringify({ action, record })}\n\n`;
    st.streams.forEach((c) => { try { c.enqueue(enc.encode(line)); } catch { /* 閉じている */ } });
  };
  /** サーバの再起動: 流れを全部閉じる。 */
  const restart = () => { const xs = st.streams.splice(0); xs.forEach((c) => { try { c.close(); } catch { /* */ } }); };
  const parse = (f = '') => Object.fromEntries([...String(f).matchAll(/(\w+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const json = (body, status = 200) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const fetchImpl = async (url, opts = {}) => {
    if (st.down) throw new TypeError('fetch failed');
    const u = new URL(url);
    const method = (opts.method || 'GET').toUpperCase();
    if (u.pathname === '/api/realtime' && method === 'GET') {
      st.sseOpens += 1;
      let ctl;
      const stream = new ReadableStream({ start: (c) => { ctl = c; } });
      st.streams.push(ctl);
      if (opts.signal) {
        opts.signal.addEventListener('abort', () => {
          const i = st.streams.indexOf(ctl); if (i >= 0) st.streams.splice(i, 1);
          try { ctl.error(new DOMException('aborted', 'AbortError')); } catch { /* */ }
        });
      }
      ctl.enqueue(enc.encode(`id:${++seq}\nevent:PB_CONNECT\ndata:${JSON.stringify({ clientId: `c${st.sseOpens}` })}\n\n`));
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (u.pathname === '/api/realtime' && method === 'POST') { st.subscribePosts += 1; return new Response(null, { status: 204 }); }
    if (u.pathname === '/api/collections/docs/records' && method === 'GET') {
      const want = parse(u.searchParams.get('filter'));
      st.listCalls.push(`${want.ns}/${want.col}`);
      if (st.listFail > 0) { st.listFail -= 1; return json({ message: 'unavailable' }, 503); }
      // ⚠答えは「読んだ瞬間の姿」(答えが届く前に変わっても、答えは古いまま = 本物と同じ)
      const items = [...rows.values()].filter((r) => Object.entries(want).every(([k, v]) => String(r[k] ?? '') === v))
        .sort((a, b) => String(a.docId).localeCompare(String(b.docId))).map((r) => Object.assign({}, r));
      if (st.listGate) await st.listGate;
      if (st.down) throw new TypeError('fetch failed');
      return json({ items, totalItems: items.length, totalPages: 1, page: 1 });
    }
    return json({ message: 'not found' }, 404);
  };
  return { st, rows, put, del, push, restart, fetchImpl };
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
const idsOf = (rows) => rows.map((r) => r.id).sort();
const BASE = 'http://127.0.0.1:1';

/**
 * 社内版と同じ組み立て: pbClient(fetch は呼ぶ時に globalThis.fetch を引く)→ ログインの約束 → 保管庫 → 読み直しの係。
 * ⚠pbClient の張り直しの輪は今までのまま(この試験は係が外から助ける事を確かめる)。
 */
const mk = async (srv, fn) => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = srv.fetchImpl;
  const W = fakeWin(); const RT = fakeTimers();
  const c = createPbClient({ url: BASE });
  c.setToken('test-token');
  c.setReady(Promise.resolve());   // 社内版はログイン(端末の札)の約束を先に並べる
  const be = createPocketbaseBackend(c, { outboxStore: createMemoryStore() });
  const ctl = installReadRetry(be, { win: W, timers: RT });
  try {
    await quiet(() => fn({ c, be, ctl, rs: ctl.resync, W, RT }));
  } finally {
    ctl.dispose();
    be.close();
    globalThis.fetch = prevFetch;
  }
};

test('RC1 流れが閉じたら(サーバの再起動)張り直して申し込みをもう一度送る・届かない間も pbClient の待ちを延ばさない・「張り直せた」を言う', async () => {
  const srv = mkServer();
  await mk(srv, async ({ be, ctl, rs }) => {
    const opens = [];
    rs.onOpen((x) => opens.push(x.reconnect));
    be.watchCollection(NS, 'lots', () => {});
    await until(() => srv.st.subscribePosts === 1, 2000, '1回目の申し込み');
    assert.deepEqual(opens, [false], '1回目は張り直しではない');
    assert.equal(rs.isLive(), true);
    srv.st.down = true;
    srv.restart();
    await until(() => rs.isLive() === false, 2000, '切れた');
    await sleep(2500);   // pbClient だけなら 0.5→1→2秒…と待ちが延びる長さ
    assert.equal(srv.st.subscribePosts, 1, '届かない間は申し込めない');
    srv.st.down = false;
    const t0 = Date.now();
    await until(() => srv.st.subscribePosts === 2, 6000, '張り直しの申し込み');
    assert.ok(Date.now() - t0 < 2500, `戻ってから張り直すまで ${Date.now() - t0}ms(係が待ちを持つので pbClient の待ちは延びない)`);
    assert.deepEqual(opens, [false, true], '2回目は「張り直せた」');
    assert.equal(ctl.unread().length, 0);
  });
});

test('RC2+RC3 切れていた間の変更が、張り直した後に購読の画面へ届く(知らせ無しで・1回だけ読み直す)・購読していない一覧は次に読む時にサーバから', async () => {
  const srv = mkServer();
  srv.put('lots', 'L1', { name: 'one' });
  srv.put('lots', 'L2', { name: 'two' });
  srv.put('settings', 'config', { v: 1 });
  await mk(srv, async ({ be, rs }) => {
    const scr = { rows: null };
    const un = be.watchCollection(NS, 'lots', (rows) => { scr.rows = rows; });
    await until(() => scr.rows && scr.rows.length === 2 && srv.st.subscribePosts === 1, 2000, '最初の読み');
    assert.equal((await be.getAll(NS, 'settings'))[0].v, 1);
    const reads0 = srv.st.listCalls.length;
    // ふだんの知らせは届く(読み直さない)
    srv.push('update', srv.put('lots', 'L1', { name: 'one-b' }));
    await until(() => scr.rows.find((r) => r.id === 'L1')?.name === 'one-b', 2000, '知らせ');
    assert.equal(srv.st.listCalls.length, reads0, '知らせだけでは読み直さない');
    // --- サーバの再起動: 流れが閉じ、しばらく届かない。その間にサーバの中身が変わる(知らせは誰にも届かない)
    srv.st.down = true;
    srv.restart();
    await until(() => rs.isLive() === false, 2000, '切れた');
    srv.put('lots', 'L3', { name: 'three' });   // 足した
    srv.del('lots', 'L2');                       // 消した
    srv.put('lots', 'L1', { name: 'one-c' });    // 直した
    srv.put('settings', 'config', { v: 2 });
    await sleep(50);
    assert.deepEqual(idsOf(scr.rows), ['L1', 'L2'], '切れている間は古いまま(届いていない)');
    assert.equal((await be.getAll(NS, 'settings'))[0].v, 1, '切れている間の1回だけの読みは控え');
    srv.st.down = false;
    await until(() => srv.st.subscribePosts === 2, 6000, '張り直し');
    await until(() => idsOf(scr.rows).join() === 'L1,L3', 2000, '取りこぼしの読み直し');
    assert.equal(scr.rows.find((r) => r.id === 'L1').name, 'one-c');
    await sleep(50);
    const after = srv.st.listCalls.slice(reads0);
    assert.equal(after.filter((k) => k === `${NS}/lots`).length, 1, '購読中の一覧は1回だけ読み直す');
    assert.equal(after.filter((k) => k === `${NS}/settings`).length, 0, '購読していない一覧はその場では読まない');
    assert.deepEqual(rs.stats().stale, [`${NS}/settings`]);
    // RC3: 次に読む時はサーバから(古い控えのまま「読めた」にしない)
    assert.equal((await be.getAll(NS, 'settings'))[0].v, 2, '次に読んだ時はサーバの今の姿');
    assert.deepEqual(rs.stats().stale, []);
    assert.equal((await be.getAll(NS, 'settings'))[0].v, 2);
    assert.equal(srv.st.listCalls.slice(reads0).filter((k) => k === `${NS}/settings`).length, 1, '読み直すのは1回だけ');
    un();
  });
});

test('RC4 online: 届かずに待っている間はすぐ張り直す・黙った流れは切って張り直す(どちらも取りこぼしを読み直す)', async () => {
  const srv = mkServer();
  srv.put('lots', 'L1', { name: 'one' });
  await mk(srv, async ({ be, W }) => {
    let rows = null;
    be.watchCollection(NS, 'lots', (r) => { rows = r; });
    await until(() => rows && srv.st.subscribePosts === 1, 2000, '最初');
    // (a) 届かない間: 試し直しの待ちが延びた所で戻る → online
    srv.st.down = true; srv.restart();
    await sleep(2200);   // 0.5 + 0.5 + 1 秒の後、次は 2 秒待ち
    srv.st.down = false;
    srv.put('lots', 'L2', { name: 'two' });
    const t0 = Date.now();
    W.fire('online');
    await until(() => rows.length === 2, 1500, 'online ですぐ張り直して読み直す');
    assert.ok(Date.now() - t0 < 1500, `待ちの残りを待たない(${Date.now() - t0}ms)`);
    const posts = srv.st.subscribePosts;
    // (b) 回線が落ちて、流れは閉じないまま黙った(知らせが届かない)→ online で切って張り直す
    srv.st.streams.splice(0);   // サーバ側ではもう届けない(流れは開いたまま)
    srv.put('lots', 'L3', { name: 'three' });
    await sleep(50);
    assert.equal(rows.length, 2, '黙った流れには何も届かない');
    W.fire('online');
    await until(() => srv.st.subscribePosts === posts + 1, 3000, '切って張り直し');
    await until(() => rows.length === 3, 2000, '読み直し');
  });
});

test('RC5 読み直しの最中にその一覧の知らせが届いたら、もう1回だけ読み直す(古い答えで新しい変更を消さない)', async () => {
  const srv = mkServer();
  srv.put('lots', 'L1', { name: 'one' });
  srv.put('lots', 'L2', { name: 'two' });
  await mk(srv, async ({ be }) => {
    let rows = null;
    be.watchCollection(NS, 'lots', (r) => { rows = r; });
    await until(() => rows && rows.length === 2 && srv.st.subscribePosts === 1, 2000, '最初');
    let open; srv.st.listGate = new Promise((r) => { open = r; });
    const n0 = srv.st.listCalls.length;
    srv.restart();   // 再起動(すぐ戻る)
    await until(() => srv.st.listCalls.length === n0 + 1 && srv.st.subscribePosts === 2, 4000, '読み直しが出た(答えは止めてある)');
    // 答えが届く前に、L1 を直して L2 を消した知らせが届く(答えは古い姿のまま)
    srv.push('update', srv.put('lots', 'L1', { name: 'one-new' }));
    const gone = srv.del('lots', 'L2');
    srv.push('delete', gone);
    await sleep(30);
    srv.st.listGate = null; open();
    await until(() => srv.st.listCalls.slice(n0).length === 2, 3000, '最中に知らせが来たので、もう1回読み直す');
    await sleep(50);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'one-new', '新しい変更が残る(古い答えで消えない)');
    assert.equal(srv.st.listCalls.slice(n0).length, 2, 'もう1回だけ(3回目は無い)');
  });
});

test('RC6 張り直した後の読み直しが失敗したら、読み直しの係の「読み直す物」に入り、読めたら下りる', async () => {
  const srv = mkServer();
  srv.put('lots', 'L1', { name: 'one' });
  await mk(srv, async ({ be, ctl, RT }) => {
    let rows = null;
    be.watchCollection(NS, 'lots', (r) => { rows = r; });
    await until(() => rows && srv.st.subscribePosts === 1, 2000, '最初');
    assert.deepEqual(ctl.unread(), []);
    srv.st.listFail = 1;            // 張り直した後の1回目の読みは 503
    srv.put('lots', 'L2', { name: 'two' });
    srv.restart();
    await until(() => ctl.unread().length === 1, 4000, '読み直す物に入る');
    assert.equal(ctl.unread()[0].key, `${NS}/lots`);
    assert.equal(rows.length, 1, 'まだ古い');
    RT.fire();                       // 係の間隔の読み直し(もう 503 ではない)
    await until(() => ctl.unread().length === 0 && rows.length === 2, 2000, '読めたら下りる');
  });
});

test('RC7 起動して1回目に素直につながった時は読み直さない・外すと fetch が元に戻る・ほかの要求は素通し', async () => {
  const srv = mkServer();
  srv.put('lots', 'L1', { name: 'one' });
  const prevFetch = globalThis.fetch;
  await mk(srv, async ({ be, rs }) => {
    assert.notEqual(globalThis.fetch, srv.fetchImpl, 'fetch を包んでいる');
    let rows = null;
    be.watchCollection(NS, 'lots', (r) => { rows = r; });
    await until(() => rows && srv.st.subscribePosts === 1, 2000, '最初');
    await sleep(100);
    assert.equal(srv.st.listCalls.filter((k) => k === `${NS}/lots`).length, 1, '起動の読みは1回だけ');
    assert.equal(rs.stats().resyncs, 0);
    // ほかの住所・ほかの道は素通し
    const r = await globalThis.fetch(`${BASE}/api/nothing`);
    assert.equal(r.status, 404);
  });
  assert.equal(globalThis.fetch, prevFetch, '外したら fetch は元のまま');
  // 係だけを外した時も元に戻る・2回付けない
  const srv2 = mkServer();
  const host = { fetch: srv2.fetchImpl };
  const be2 = { raw: { url: BASE }, refresh: async () => 0 };
  const rs2 = installRealtimeResync(be2, { win: null, host });
  assert.notEqual(host.fetch, srv2.fetchImpl);
  assert.equal(installRealtimeResync(be2, { win: null, host }), rs2, '2回付けない');
  rs2.dispose();
  assert.equal(host.fetch, srv2.fetchImpl);
});
