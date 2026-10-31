// ============================================================================
// 🔁 2026-10-31 verify16 の直しの試験: 返事の頭(ヘッダ)がまだ来ない GET /api/realtime も見張る
//   (src/data/realtimeResync.js ⑦・4アプリ同じ中身)
//   O1 … 返事の頭が来ない GET は REALTIME_OPEN_TIMEOUT_MS で切って、試し直す(GET を実際に2回以上出す)
//   O2 … 返事の頭を待っている間も、心拍(/api/health)は pingMs ごとに動き、届かなければ GET を切って試し直す
//   O3 … online の合図で、返事の頭を待っている GET を切って試し直す
//   O4 … 返事の頭が時間内に来た GET は切らない(空振りしない)
// 時計は偽物(仮想時間)。外には何も出さない。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as RS from '../realtimeResync.js';
const { installRealtimeResync } = RS;

const BASE = 'http://127.0.0.1:1';
const URL_RT = `${BASE}/api/realtime`;
const enc = new TextEncoder();
const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r)); };

const mkClock = () => {
  let t = 0; let seq = 0; const tm = new Map();
  const T = {
    setTimeout: (f, ms) => { seq += 1; tm.set(seq, { f, at: t + ms }); return seq; },
    clearTimeout: (h) => { tm.delete(h); },
  };
  const advance = async (ms) => {
    const end = t + ms;
    for (;;) {
      await flush();
      let best = null;
      tm.forEach((v, h) => { if (v.at <= end && (!best || v.at < best.v.at)) best = { h, v }; });
      if (!best) break;
      tm.delete(best.h); t = Math.max(t, best.v.at); best.v.f();
    }
    t = end; await flush();
  };
  return { T, advance, now: () => t };
};

/** 組み立て。hang(n) = n 回目の GET は返事の頭が来ないまま(abort で失敗する)。 */
const mk = (hangFirst) => {
  const clock = mkClock();
  const st = { gets: 0, aborted: 0, health: 0, healthDown: false };
  const host = {
    fetch: (url, init = {}) => {
      if (String(url).endsWith('/api/health')) {
        st.health += 1;
        return st.healthDown ? Promise.reject(new TypeError('fetch failed')) : Promise.resolve(new Response('{}', { status: 200 }));
      }
      if (String(url) === URL_RT && (init.method || 'GET') === 'GET') {
        st.gets += 1;
        if (st.gets <= hangFirst) {
          return new Promise((_, rej) => {
            if (init.signal) init.signal.addEventListener('abort', () => { st.aborted += 1; const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
          });
        }
        const body = new ReadableStream({ start: (c) => { c.enqueue(enc.encode('event:PB_CONNECT\ndata:{}\n\n')); } });
        return Promise.resolve(new Response(body, { status: 200 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    },
  };
  const win = {
    ls: new Set(),
    addEventListener: (t, f) => { if (t === 'online') win.ls.add(f); },
    removeEventListener: (t, f) => { win.ls.delete(f); },
    fire: () => [...win.ls].forEach((f) => f()),
  };
  const backend = { raw: { url: BASE, token: 'tok', fetchHost: host } };
  const ctl = installRealtimeResync(backend, { win, doc: null, host, timers: clock.T, now: clock.now, listAll: false });
  const open = () => host.fetch(URL_RT, { method: 'GET', headers: { Authorization: 'tok' } });
  return { clock, st, host, win, ctl, open };
};

test('O1 返事の頭が来ない GET は REALTIME_OPEN_TIMEOUT_MS で切って試し直す(GET を実際に2回以上出す)', async () => {
  assert.equal(RS.REALTIME_OPEN_TIMEOUT_MS, 10000);
  const m = mk(1);
  let res = null;
  m.open().then((r) => { res = r; });
  await m.clock.advance(9000);
  assert.equal(m.st.gets, 1, '10秒たつ前は切らない');
  assert.equal(res, null);
  await m.clock.advance(2000);   // 合計11秒
  assert.ok(m.st.gets >= 2, `11秒以内に GET を出し直す(実際 ${m.st.gets} 回)`);
  assert.equal(m.st.aborted, 1, '最初の GET は切った');
  assert.ok(res && res.ok, '2回目の GET の流れが呼んだ側へ返る');
  m.ctl.dispose();
});

test('O2 返事の頭を待っている間も心拍が動き、サーバへ届かなければ GET を切って試し直す', async () => {
  const m = mk(1);
  m.ctl.dispose();   // 時間切れだけを外した形で確かめるため、組み直す
  const clock = mkClock();
  const st = { gets: 0, aborted: 0, health: 0, healthDown: true };
  const host = {
    fetch: (url, init = {}) => {
      if (String(url).endsWith('/api/health')) { st.health += 1; return Promise.reject(new TypeError('fetch failed')); }
      st.gets += 1;
      if (st.gets === 1) return new Promise((_, rej) => { init.signal.addEventListener('abort', () => { st.aborted += 1; const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }); });
      return Promise.resolve(new Response(new ReadableStream({ start: (c) => c.enqueue(enc.encode('event:PB_CONNECT\ndata:{}\n\n')) }), { status: 200 }));
    },
  };
  const ctl = installRealtimeResync({ raw: { url: BASE, token: 'tok', fetchHost: host } }, { win: null, doc: null, host, timers: clock.T, now: clock.now, listAll: false, openMs: 0 });
  host.fetch(URL_RT, { method: 'GET', headers: { Authorization: 'tok' } });
  await clock.advance(19000);
  assert.equal(st.health, 0, '心拍は pingMs(20秒)ごと');
  await clock.advance(2000);
  assert.ok(st.health >= 1, `返事の頭を待っている間も心拍が動く(health ${st.health} 回)`);
  assert.equal(st.aborted, 1, '届かないので待っている GET を切る');
  assert.ok(st.gets >= 2, 'GET を出し直す');
  ctl.dispose();
});

test('O3 online の合図で、返事の頭を待っている GET を切って試し直す', async () => {
  const m = mk(1);
  m.open();
  await m.clock.advance(1000);
  assert.equal(m.st.gets, 1);
  m.win.fire();
  await m.clock.advance(1000);   // 試し直しの待ち(0.5秒)
  assert.equal(m.st.aborted, 1);
  assert.ok(m.st.gets >= 2, `online で GET を出し直す(${m.st.gets} 回)`);
  m.ctl.dispose();
});

test('O4 返事の頭が時間内に来た GET は切らない', async () => {
  const m = mk(0);
  let res = null;
  m.open().then((r) => { res = r; });
  await m.clock.advance(15000);
  assert.ok(res && res.ok);
  assert.equal(m.st.gets, 1);
  assert.equal(m.st.aborted, 0);
  m.ctl.dispose();
});
