// ============================================================================
// 🧪 2026-10-31 清水さんの決定(2): 部品は「サーバから読めない時(ネットが切れている等)、前と同じく端末の控えを出す」
// ----------------------------------------------------------------------------
// 操業シミュの「計画の保存」が読む4か所(App.jsx の planShelf の readHead・readReview・readHeadOf・readRoute)を
// **App.jsx に書いてある呼び方そのもの** で動かし、サーバに届かない時に控えの中身が返る事を確かめる。
//   ・Firebase(いつものビルド): 偽の Firestore を「切れている」にする = getDocFromServer は Firestore と同じ文で失敗し、
//     getDoc は端末の控え(metadata.fromCache: true)を返す。src/data を揃える前の部品(基点 fff526a)と同じ答えになる事。
//   ・PocketBase(社内サーバー版): 一度読めた後にサーバに届かなくなっても、手元の控えが返る事。
// 見張りの見張り: 揃える前に入れていた呼び方({ source: 'server' })なら、同じ偽の Firestore で失敗する事も確かめる
// (= この試験は「控えを返さない」形を見分けられる)。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerFor } from '../../data/provider.js';
import { createPocketbaseBackend } from '../../data/pocketbaseBackend.js';
import { createMemoryStore } from '../../data/outbox.js';
import { PbNetworkError } from '../../data/pbClient.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const APP = readFileSync(join(ROOT, 'src', 'App.jsx'), 'utf8');
const NS = 'capacity-shared-v1';

// App.jsx の planShelf から4つの読み方の式を取り出す(書き換えたら試験もそのまま追いかける)
const NAMES = ['readHead', 'readReview', 'readHeadOf', 'readRoute'];
const shelfFrom = (DATA, db) => {
  const out = {};
  for (const name of NAMES) {
    const m = new RegExp(`^\\s*${name}: (\\([^)]*\\) => DATA\\(db\\)\\.getOne\\([^\\n]*\\)),\\s*$`, 'm').exec(APP);
    assert.ok(m, `App.jsx に ${name} の読み方が見つからない`);
    // eslint-disable-next-line no-new-func
    out[name] = new Function('DATA', 'db', 'OPSIM_SHELF_NS', `return ${m[1]};`)(DATA, db, NS);
    out[`${name}Src`] = m[1];
  }
  return out;
};

// 端末の控え(前に読んだ時のまま)
const CACHED = {
  [`artifacts/${NS}/public/data/plan_control/parts`]: { revision: 3, versionId: 'v3', app: 'parts' },
  [`artifacts/${NS}/public/data/plan_reviews/v3`]: { status: 'approved', history: [{ at: 1 }] },
  [`artifacts/${NS}/public/data/plan_control/product`]: { revision: 7, versionId: 'p7', app: 'product' },
  [`artifacts/${NS}/public/data/route_drafts/r1`]: { revision: 1, moves: [] },
};

/** 偽の Firestore。offline の時、getDocFromServer は Firestore と同じ文で失敗し、getDoc は控えを返す。 */
const mkFirestore = ({ offline }) => {
  const calls = [];
  const snap = (path, fromCache) => {
    const d = CACHED[path];
    return { id: path.split('/').pop(), exists: () => d !== undefined, data: () => (d === undefined ? undefined : structuredClone(d)), metadata: { fromCache, hasPendingWrites: false } };
  };
  const fn = (name) => (...a) => { calls.push(name); return { __ref: name, a }; };
  const fs = {
    collection: (db, ...p) => ({ path: p.join('/') }),
    doc: (db, ...p) => ({ path: p.join('/') }),
    onSnapshot: () => () => {},
    setDoc: async () => { throw new Error('書かない試験'); },
    deleteDoc: async () => { throw new Error('書かない試験'); },
    getDocs: async () => ({ docs: [], size: 0, metadata: { fromCache: offline } }),
    getDoc: async (ref) => { calls.push('getDoc'); return snap(ref.path, offline); },
    getDocFromServer: async (ref) => {
      calls.push('getDocFromServer');
      if (offline) {
        throw Object.assign(new Error('Failed to get document from server. (However, this document does exist in the local cache. Run again without setting source to "server" to retrieve the cached document.)'), { code: 'unavailable' });
      }
      return snap(ref.path, false);
    },
    serverTimestamp: fn('serverTimestamp'), deleteField: fn('deleteField'),
    updateDoc: async () => { throw new Error('書かない試験'); },
    runTransaction: async () => { throw new Error('書かない試験'); },
    query: fn('query'), where: fn('where'), orderBy: fn('orderBy'), limit: fn('limit'),
  };
  return { fs, calls };
};

test('P-OFF1 Firebase: サーバに届かない時、計画の保存の4つの読みは端末の控えを返す(失敗にしない)', async () => {
  const { fs, calls } = mkFirestore({ offline: true });
  const db = { __db: 1 };
  const s = shelfFrom(() => providerFor(db, fs), db);
  for (const name of NAMES) assert.doesNotMatch(s[`${name}Src`], /source:\s*'server'/, `${name} が「サーバからだけ」を頼んでいる(控えを返さない)`);
  assert.deepEqual(await s.readHead(), CACHED[`artifacts/${NS}/public/data/plan_control/parts`]);
  assert.deepEqual(await s.readReview('v3'), CACHED[`artifacts/${NS}/public/data/plan_reviews/v3`]);
  assert.deepEqual(await s.readHeadOf('product'), CACHED[`artifacts/${NS}/public/data/plan_control/product`]);
  assert.deepEqual(await s.readRoute('r1'), CACHED[`artifacts/${NS}/public/data/route_drafts/r1`]);
  assert.equal(await s.readReview('none'), null, '控えにも無い時は「無い」(前と同じ)');
  // 読んだのは普通の読み(控えがあれば控えを返す getDoc)だけ。サーバだけの読みは使っていない。
  assert.deepEqual([...new Set(calls)], ['getDoc']);
});

test('P-OFF2 Firebase: つながっている時は同じ4つの読みがサーバの答えを返す(読みは1件1回)', async () => {
  const { fs, calls } = mkFirestore({ offline: false });
  const db = { __db: 1 };
  const s = shelfFrom(() => providerFor(db, fs), db);
  assert.deepEqual(await s.readHead(), CACHED[`artifacts/${NS}/public/data/plan_control/parts`]);
  assert.deepEqual(await s.readRoute('r1'), CACHED[`artifacts/${NS}/public/data/route_drafts/r1`]);
  assert.deepEqual(calls, ['getDoc', 'getDoc']);
});

test('P-OFF3 見張りの見張り: 揃えた後の窓口に { source: \'server\' } で頼むと、同じ「切れている」で失敗する(=上の試験は控えを返さない形を見分けられる)', async () => {
  const { fs } = mkFirestore({ offline: true });
  const p = providerFor({ __db: 1 }, fs);
  await assert.rejects(p.getOne(NS, 'plan_control', 'parts', { source: 'server' }), /Failed to get document from server/);
  // 同じ窓口で source を渡さなければ控え
  assert.deepEqual(await p.getOne(NS, 'plan_control', 'parts'), CACHED[`artifacts/${NS}/public/data/plan_control/parts`]);
});

test('P-OFF4 PocketBase(社内サーバー版): 一度読めた後にサーバに届かなくなっても、同じ4つの読みは手元の控えを返す', async () => {
  const rows = [
    { id: 'r1', ns: NS, col: 'plan_control', docId: 'parts', data: { revision: 3, versionId: 'v3' }, rev: 3 },
    { id: 'r2', ns: NS, col: 'plan_reviews', docId: 'v3', data: { status: 'approved' }, rev: 1 },
    { id: 'r3', ns: NS, col: 'plan_control', docId: 'product', data: { revision: 7 }, rev: 7 },
    { id: 'r4', ns: NS, col: 'route_drafts', docId: 'r1', data: { revision: 1 }, rev: 1 },
  ];
  let reachable = true;
  const parse = (f = '') => Object.fromEntries([...String(f).matchAll(/(\w+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const down = () => { throw new PbNetworkError(new Error('サーバに届きません'), '/x'); };
  const client = {
    isAuthed: () => true,
    listPage: async (col, { filter } = {}) => {
      if (!reachable) down();
      const want = parse(filter);
      const items = rows.filter((r) => Object.entries(want).every(([k, v]) => String(r[k] ?? '') === v));
      return { items, totalItems: items.length, totalPages: 1 };
    },
    listAll: async (col, opts) => (await client.listPage(col, opts)).items,
    create: async () => down(), update: async () => down(), remove: async () => down(),
    openRealtime: () => () => {},
  };
  const be = createPocketbaseBackend(client, { outboxStore: createMemoryStore(), autoRealtime: false });
  try {
    const s = shelfFrom(() => be, {});
    // つながっている間に一度開いた(読めた)
    assert.deepEqual(await s.readHead(), { revision: 3, versionId: 'v3' });
    await s.readReview('v3'); await s.readRoute('r1');
    reachable = false;
    assert.deepEqual(await s.readHead(), { revision: 3, versionId: 'v3' }, '切れた後も控えの計画');
    assert.deepEqual(await s.readReview('v3'), { status: 'approved' });
    assert.deepEqual(await s.readRoute('r1'), { revision: 1 });
    // 同じ plan_control の控え(上で読めた)から他のエリアも返る
    assert.deepEqual(await s.readHeadOf('product'), { revision: 7 });
  } finally { be.close(); }
});
