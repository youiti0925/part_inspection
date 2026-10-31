// 🔁 R39 社内版: 「読めていません」の帯を、つながったら自動で読み直して消す(domain/readRecovery.js)
//   RR1〜RR5 … 決まり(理由の見分け・帯の種類・間隔・重ねない・止める)
//   RR6〜RR8 … 本物の PocketBase の保管庫(pocketbaseBackend)を、届かない→届くに切り替えて、
//               「まだ一度も読めていない一覧」が失敗 → つながった後に自動の読み直しで読め、帯の名札が下りる事を確かめる。
//               (画面と同じ受け口: 控えだけの答えでは帯を下ろさず、ロットの保存の門も開けない)
// ⚠このファイルは4アプリで同じ中身。各アプリの画面の配線は readRecoveryWiring.test.mjs(アプリごと)で見る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isConnectionLost, readBandKind, startReadRecovery, probeServerRead, readTargetOf, isLocalOnlySnap,
  offlineBandDetail, READ_RETRY_INTERVAL_MS,
} from '../readRecovery.js';
import { createPocketbaseBackend } from '../../data/pocketbaseBackend.js';
import { createMemoryStore } from '../../data/outbox.js';
import { PbNetworkError, PbHttpError } from '../../data/pbClient.js';

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

const fakeTimers = () => {
  const iv = new Map(); let seq = 0;
  return {
    setInterval: (f, ms) => { seq += 1; iv.set(seq, { f, ms }); return seq; },
    clearInterval: (h) => { iv.delete(h); },
    tick: () => { [...iv.values()].forEach((x) => x.f()); },
    count: () => iv.size,
    ms: () => [...iv.values()].map((x) => x.ms),
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

test('RR1 理由の見分け: 通信の失敗・入口の 502/503/504 は「つながらない」、権限・ログイン・形の誤りは違う', () => {
  assert.equal(isConnectionLost(new PbNetworkError(new Error('fetch failed'), 'http://x/api')), true);
  assert.equal(isConnectionLost(String(new PbNetworkError(new Error('Failed to fetch'), 'http://x/api').message)), true);
  assert.equal(isConnectionLost(new PbHttpError(502, 'bad gateway', 'http://x/api')), true);
  assert.equal(isConnectionLost('PocketBase 503 http://x/api: x'), true);
  assert.equal(isConnectionLost('TypeError: Failed to fetch'), true);
  assert.equal(isConnectionLost('unavailable'), true, 'Firestore の unavailable');
  assert.equal(isConnectionLost(new PbHttpError(403, 'forbidden', 'http://x/api')), false);
  assert.equal(isConnectionLost('PocketBase 400 http://x/api: bad'), false);
  assert.equal(isConnectionLost('まだログインできていません(この0件はデータが無い意味ではありません)'), false);
  assert.equal(isConnectionLost('permission-denied'), false);
  assert.equal(isConnectionLost(null), false);
});

test('RR2 帯の種類: 無ければ none / 全部つながらないなら offline(穏やか) / 1つでも別の理由なら error(赤) / ブラウザが切れていれば offline', () => {
  assert.equal(readBandKind({}), 'none');
  assert.equal(readBandKind(null), 'none');
  assert.equal(readBandKind({ education_events: 'PocketBase 通信失敗 http://x: fetch failed' }), 'offline');
  assert.equal(readBandKind({ education_events: 'PocketBase 通信失敗 http://x: fetch failed', settings: 'PocketBase 403 x' }), 'error');
  assert.equal(readBandKind({ settings: 'PocketBase 403 x' }, { online: false }), 'offline');
  // 文: 保存を止めていない時に「止めています」と書かない
  assert.doesNotMatch(offlineBandDetail({ saveStopped: false }), /止めています/);
  assert.match(offlineBandDetail({ saveStopped: true }), /止めています/);
});

test('RR3 自動の読み直し: online の合図ですぐ・既定15秒ごと。読めていない物が無い/枠切れの間(isActive=false)は何もしない。止めたら外す', () => {
  const T = fakeTimers(); const W = fakeWin();
  let active = true; const calls = [];
  const stop = startReadRecovery({ win: W, timers: T, isActive: () => active, onRetry: (why) => { calls.push(why); } });
  assert.deepEqual(T.ms(), [READ_RETRY_INTERVAL_MS]);
  assert.equal(READ_RETRY_INTERVAL_MS, 15000);
  W.fire('online');
  T.tick();
  assert.deepEqual(calls, ['online', 'interval']);
  active = false;
  W.fire('online'); T.tick();
  assert.deepEqual(calls, ['online', 'interval'], 'isActive=false の間は呼ばない');
  stop();
  assert.equal(T.count(), 0); assert.equal(W.n('online'), 0);
  active = true; W.fire('online');
  assert.equal(calls.length, 2, '止めた後は呼ばない');
});

test('RR4 前の読み直しが終わるまで次を重ねない(遅いサーバに同じ問い合わせを積まない)', async () => {
  const T = fakeTimers(); const W = fakeWin();
  let n = 0; let release;
  startReadRecovery({ win: W, timers: T, onRetry: () => { n += 1; return new Promise((r) => { release = r; }); } });
  W.fire('online'); T.tick(); W.fire('online');
  assert.equal(n, 1);
  release(); await flush(2);
  T.tick();
  assert.equal(n, 2);
});

test('RR5 名札 → 置き場所: (…) の付いた窓の名札は元の置き場所・別の領域は aliases', () => {
  assert.deepEqual(readTargetOf('education_events', 'parts-v1'), ['parts-v1', 'education_events']);
  assert.deepEqual(readTargetOf('lots(過去)', 'parts-v1'), ['parts-v1', 'lots']);
  assert.deepEqual(readTargetOf('lots(未完了)', 'parts-v1'), ['parts-v1', 'lots']);
  assert.deepEqual(readTargetOf('contact_shared/settings', 'parts-v1', { 'contact_shared/settings': ['cs', 'settings'] }), ['cs', 'settings']);
});

// --- 本物の保管庫で: 届かない → 届く ------------------------------------------------
const NS = 'parts-inspection-v1';
const mkServer = () => {
  const rows = [
    { id: 'a1', ns: NS, col: 'education_events', docId: 'e1', data: { kind: 'signoff', worker: '山田' }, rev: 1 },
    { id: 'a2', ns: NS, col: 'lots', docId: 'L1', data: { id: 'L1', status: 'in_progress', createdAt: 1 }, rev: 4 },
    { id: 'a3', ns: NS, col: 'templates', docId: 't1', data: { name: 'T' }, rev: 1 },
  ];
  const st = { reachable: true, listCalls: 0 };
  const parse = (f = '') => Object.fromEntries([...String(f).matchAll(/(\w+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const down = () => { throw new PbNetworkError(new Error('fetch failed'), 'http://127.0.0.1:8120/api/collections/docs/records'); };
  const client = {
    isAuthed: () => true,
    listPage: async (col, { filter } = {}) => {
      st.listCalls += 1;
      if (!st.reachable) down();
      const want = parse(filter);
      const items = rows.filter((r) => Object.entries(want).every(([k, v]) => String(r[k] ?? '') === v));
      return { items, totalItems: items.length, totalPages: 1 };
    },
    listAll: async (col, opts) => (await client.listPage(col, opts)).items,
    create: async () => down(), update: async () => down(), remove: async () => down(),
    openRealtime: () => () => {},
  };
  return { st, client };
};

// 画面(部品 App.jsx)と同じ受け口の写し: 帯の名札 readErrors・ロットの保存の門 lotsLoaded。
const mkScreen = (be) => {
  const scr = { readErrors: {}, lotsLoaded: false, lots: null, edu: null };
  const noteReadError = (k, e) => { scr.readErrors = { ...scr.readErrors, [k]: String((e && e.code) || (e && e.message) || e) }; };
  const clear = (k) => { if (scr.readErrors[k]) { const n = { ...scr.readErrors }; delete n[k]; scr.readErrors = n; } };
  // ロットの購読(普段の窓): 控えだけの答えでは「読めた」にしない(R39 の守り)
  be.watchCollection(NS, 'lots', (rows, snap) => {
    scr.lots = rows;
    if (!isLocalOnlySnap(snap)) { clear('lots'); scr.lotsLoaded = true; }
  }, { onError: (e) => { noteReadError('lots', e); scr.lotsLoaded = false; } });
  // 開いた時だけ読む一覧(education_events)
  be.watchCollection(NS, 'education_events', (rows) => { scr.edu = rows; }, { onError: (e) => noteReadError('education_events', e) });
  const retry = (errs) => Promise.all(Object.keys(errs).map(async (key) => {
    const [ns, col] = readTargetOf(key, NS);
    const r = await probeServerRead(be, ns, col, { timeoutMs: 2000 });
    if (r.ok) clear(key);
  }));
  return { scr, retry };
};

test('RR6 失敗 → 回復: 届かない間に開いた一覧は帯に出て、つながった後の自動の読み直しで読め、帯の名札が下りる(ロットの保存の門も開く)', async () => {
  const { st, client } = mkServer();
  st.reachable = false;
  const be = createPocketbaseBackend(client, { outboxStore: createMemoryStore(), autoRealtime: false });
  try {
    const { scr, retry } = mkScreen(be);
    await flush();
    assert.deepEqual(Object.keys(scr.readErrors).sort(), ['education_events', 'lots']);
    assert.equal(readBandKind(scr.readErrors), 'offline', '理由は通信の失敗だけ = 穏やかな帯');
    assert.equal(scr.lotsLoaded, false, '読めていない間は保存の門は閉じたまま');

    const T = fakeTimers(); const W = fakeWin();
    const stop = startReadRecovery({ win: W, timers: T, isActive: () => Object.keys(scr.readErrors).length > 0, onRetry: () => retry(scr.readErrors) });
    // まだ届かない: 15秒の読み直しは失敗 → 帯は下りない・門も開かない(控えだけの答えが受け口に届いても)
    const before = st.listCalls;
    T.tick(); await flush(10);
    assert.ok(st.listCalls > before, '読み直しに行った');
    assert.deepEqual(Object.keys(scr.readErrors).sort(), ['education_events', 'lots'], '失敗では下ろさない');
    assert.equal(scr.lotsLoaded, false, '控えだけの答えでは保存の門を開けない');

    // つながった
    st.reachable = true;
    W.fire('online'); await flush(10);
    assert.deepEqual(scr.readErrors, {}, '読めた名札は全部下りた');
    assert.equal(readBandKind(scr.readErrors), 'none');
    assert.equal(scr.lotsLoaded, true, 'ロットの保存の門が開いた');
    assert.deepEqual(scr.edu.map((r) => r.id), ['e1'], '画面の購読にもサーバの答えが届いた(張り直していない)');
    assert.deepEqual(scr.lots.map((r) => r.id), ['L1']);
    // 名札が無くなったら読み直しは何もしない
    const calls = st.listCalls;
    T.tick(); W.fire('online'); await flush(4);
    assert.equal(st.listCalls, calls);
    stop();
  } finally { be.close(); }
});

test('RR7 一度読めた一覧は、その後に届かなくなっても読み直しで「読めた」と分かる(控えを表示・帯を出し直さない)', async () => {
  const { st, client } = mkServer();
  const be = createPocketbaseBackend(client, { outboxStore: createMemoryStore(), autoRealtime: false });
  try {
    await be.getAll(NS, 'templates');
    st.reachable = false;
    const r = await probeServerRead(be, NS, 'templates', { timeoutMs: 1000 });
    assert.equal(r.ok, true);
    const r2 = await probeServerRead(be, NS, 'never_loaded', { timeoutMs: 1000 });
    assert.equal(r2.ok, false);
    assert.ok(isConnectionLost(r2.why));
  } finally { be.close(); }
});
