import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createFirebaseBackend, createProvider, providerFor, ROW_DOCID_WINS, ROW_DATA_WINS,
} from '../provider.js';
import { NS, GOAL_NS, CONTACT_NS, DEFAULT_PROVIDERS, PLANNED_PROVIDERS } from '../routes.js';

// ----------------------------------------------------------------------------
// Firestore の代わり。何をどう呼んだかを記録するだけ。
// ----------------------------------------------------------------------------
const makeFs = () => {
  const calls = [];
  const snapOf = (docs) => ({
    docs: docs.map((d) => ({ id: d.id, data: () => d.data })),
    exists: () => docs.length > 0,
    data: () => (docs[0] ? docs[0].data : undefined),
  });
  return {
    calls,
    fs: {
      collection: (db, ...segs) => ({ __kind: 'col', db, segs }),
      doc: (db, ...segs) => ({ __kind: 'doc', db, segs }),
      onSnapshot: (ref, next, onErr) => {
        calls.push({ op: 'onSnapshot', ref, hasErr: onErr !== undefined });
        next.__ref = ref;
        (ref.__emit || []).forEach((x) => next(x));
        return () => calls.push({ op: 'unsub', ref });
      },
      setDoc: (ref, data, opts) => { calls.push({ op: 'setDoc', ref, data, opts }); return Promise.resolve(); },
      deleteDoc: (ref) => { calls.push({ op: 'deleteDoc', ref }); return Promise.resolve(); },
      getDocs: (ref) => { calls.push({ op: 'getDocs', ref }); return Promise.resolve(snapOf(ref.__rows || [])); },
      getDoc: (ref) => { calls.push({ op: 'getDoc', ref }); return Promise.resolve(snapOf(ref.__rows || [])); },
      serverTimestamp: () => '<<serverTimestamp>>',
    },
    snapOf,
  };
};

const build = (providers = DEFAULT_PROVIDERS) => {
  const { fs, calls, snapOf } = makeFs();
  const db = { id: 'fake-db' };
  const p = createProvider({ backends: { firebase: createFirebaseBackend(db, fs) }, providers });
  return { p, calls, db, snapOf, fs };
};

// ============================================================================
// P01-P05 パスと振り分け
// ============================================================================

test('P01 書き込みは今までと同じパス・同じ merge:true', async () => {
  const { p, calls } = build();
  await p.save(NS.final, 'lots', 'lot-1', { a: 1 });
  const c = calls.find((x) => x.op === 'setDoc');
  assert.deepEqual(c.ref.segs, ['artifacts', 'final-inspection-v1', 'public', 'data', 'lots', 'lot-1']);
  assert.deepEqual(c.data, { a: 1 });
  assert.deepEqual(c.opts, { merge: true });
});

test('P02 merge:false を明示したときだけ上書きになる', async () => {
  const { p, calls } = build();
  await p.save(NS.final, 'lots', 'x', {}, { merge: false });
  assert.deepEqual(calls.at(-1).opts, { merge: false });
});

test('P03 共有の棚も同じ窓口から引ける', () => {
  const { p } = build();
  assert.deepEqual(p.docRef(GOAL_NS, 'settings', 'config').segs,
    ['artifacts', 'goal-shared-v1', 'public', 'data', 'settings', 'config']);
  assert.deepEqual(p.docRef(CONTACT_NS, 'settings', 'config').segs,
    ['artifacts', 'contact-shared-v1', 'public', 'data', 'settings', 'config']);
});

test('P04 routeOf で「どこがまだ Firebase か」を数えられる', () => {
  const { p } = build(PLANNED_PROVIDERS);
  assert.deepEqual(p.routeOf(NS.final, 'lots'), { area: 'inspection', backend: 'pocketbase', known: true });
  assert.deepEqual(p.routeOf(NS.final, 'contact_requests'), { area: 'contact', backend: 'firebase', known: true });
});

test('P05 用意していない保管庫を指すと、黙って動かず理由が出る', () => {
  const { fs } = makeFs();
  const p = createProvider({ backends: { firebase: createFirebaseBackend({}, fs) }, providers: PLANNED_PROVIDERS });
  assert.throws(() => p.docRef(NS.final, 'lots'), /pocketbase.*用意されていません|用意されていません/);
  // 連絡は firebase のままなので通る
  assert.doesNotThrow(() => p.docRef(NS.final, 'contact_requests', 'r1'));
});

// ============================================================================
// P06-P09 読み出しの作法(既存の挙動をそのまま保つ)
// ============================================================================

test('P06 本文に id があるとき、2つの読み方は結果が変わる(既定はドキュメントID優先)', () => {
  const d = { id: 'doc-1', data: () => ({ id: 'body-9', name: 'A' }) };
  assert.deepEqual(ROW_DOCID_WINS(d), { id: 'doc-1', name: 'A' });
  assert.deepEqual(ROW_DATA_WINS(d), { id: 'body-9', name: 'A' });
});

test('P07 購読は既定でドキュメントID優先に直す', () => {
  const { p, db, fs } = build();
  const ref = fs.collection(db, 'artifacts', NS.final, 'public', 'data', 'lots');
  ref.__emit = [{ docs: [{ id: 'L1', data: () => ({ id: 'zzz', q: 1 }) }] }];
  let got = null;
  // colRef は毎回新しいオブジェクトを返すので、fs を直接使って emit 済みの ref を通す
  const backend = createFirebaseBackend(db, { ...fs, collection: () => ref });
  backend.watchCollection(NS.final, 'lots', (rows) => { got = rows; });
  assert.deepEqual(got, [{ id: 'L1', q: 1 }]);
});

test('P08 map を渡せば本文の id を優先する読み方にできる', () => {
  const { db, fs } = build();
  const ref = fs.collection(db, 'x');
  ref.__emit = [{ docs: [{ id: 'L1', data: () => ({ id: 'zzz', q: 1 }) }] }];
  let got = null;
  const backend = createFirebaseBackend(db, { ...fs, collection: () => ref });
  backend.watchCollection(NS.final, 'improvements', (rows) => { got = rows; }, { map: ROW_DATA_WINS });
  assert.deepEqual(got, [{ id: 'zzz', q: 1 }]);
});

test('P09 エラー用の関数は、渡された時だけ Firestore へ渡す', () => {
  // ⚠空関数を勝手に足すと、今まで console に出ていた購読エラーが黙って消える
  const { p, calls } = build();
  p.watchCollection(NS.final, 'lots', () => {});
  assert.equal(calls.at(-1).hasErr, false);
  p.watchCollection(NS.final, 'lots', () => {}, { onError: () => {} });
  assert.equal(calls.at(-1).hasErr, true);
});

// ============================================================================
// P10-P12 その他
// ============================================================================

test('P10 now() は Firebase では serverTimestamp と同じもの', () => {
  const { p } = build();
  assert.equal(p.now(NS.final, 'lots'), '<<serverTimestamp>>');
});

test('P11 fs の関数が足りなければ、使う前に落ちる', () => {
  assert.throws(() => createFirebaseBackend({}, { collection: () => {} }), /fs\.doc/);
});

test('P12 同じ db なら同じ窓口を返す(購読が張り直されない)', () => {
  const { fs } = makeFs();
  const db = {};
  const a = providerFor(db, fs);
  const b = providerFor(db, fs);
  assert.equal(a, b);
  assert.equal(providerFor(null, fs), null);
  assert.notEqual(providerFor({}, fs), a);
});
