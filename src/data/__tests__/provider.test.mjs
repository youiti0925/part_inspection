import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createFirebaseBackend, createProvider, providerFor, ROW_DOCID_WINS, ROW_DATA_WINS, CLAIM,
} from '../provider.js';
import { NS, GOAL_NS, CONTACT_NS, DEFAULT_PROVIDERS, PLANNED_PROVIDERS } from '../routes.js';
import { DATA_DELETE, DATA_SERVER_NOW } from '../sentinels.js';

// ----------------------------------------------------------------------------
// Firestore の代わり。何をどう呼んだかを記録するだけ。
// ----------------------------------------------------------------------------
const makeFs = (docs = {}) => {
  const calls = [];
  const store = { ...docs }; // key = segs.join('/')
  const key = (ref) => ref.segs.join('/');
  const snapOf = (rows) => ({
    docs: rows.map((d) => ({ id: d.id, data: () => d.data })),
    exists: () => rows.length > 0,
    data: () => (rows[0] ? rows[0].data : undefined),
  });
  const docSnap = (ref) => {
    const has = Object.prototype.hasOwnProperty.call(store, key(ref));
    return { exists: () => has, data: () => store[key(ref)] };
  };
  return {
    calls, store,
    fs: {
      collection: (db, ...segs) => ({ __kind: 'col', db, segs }),
      doc: (db, ...segs) => ({ __kind: 'doc', db, segs }),
      // Firestore の本物と同じで、第2引数の型で意味が変わる:
      //   onSnapshot(ref, next, onError) / onSnapshot(ref, options, next, onError)
      onSnapshot: (ref, a, b, c) => {
        const withOpts = typeof a !== 'function';
        const snapOpts = withOpts ? a : undefined;
        const next = withOpts ? b : a;
        const onErr = withOpts ? c : b;
        calls.push({ op: 'onSnapshot', ref, snapOpts, hasErr: onErr !== undefined });
        next.__ref = ref;
        (ref.__emit || []).forEach((x) => next(x));
        return () => calls.push({ op: 'unsub', ref });
      },
      setDoc: (ref, data, opts) => { calls.push({ op: 'setDoc', ref, data, opts }); return Promise.resolve(); },
      deleteDoc: (ref) => { calls.push({ op: 'deleteDoc', ref }); return Promise.resolve(); },
      getDocs: (ref) => { calls.push({ op: 'getDocs', ref }); return Promise.resolve(snapOf(ref.__rows || [])); },
      getDoc: (ref) => { calls.push({ op: 'getDoc', ref }); return Promise.resolve(snapOf(ref.__rows || [])); },
      serverTimestamp: () => '<<serverTimestamp>>',
      deleteField: () => '<<deleteField>>',
      updateDoc: (ref, fields) => { calls.push({ op: 'updateDoc', ref, fields }); return Promise.resolve(); },
      runTransaction: async (db, fn) => {
        calls.push({ op: 'runTransaction' });
        const tx = {
          get: async (ref) => docSnap(ref),
          set: (ref, data, opts) => { calls.push({ op: 'tx.set', ref, data, opts }); },
        };
        return await fn(tx);
      },
      // --- 絞り込み(部品検査で使う) ---
      query: (base, ...parts) => ({ __kind: 'query', base, parts, segs: base.segs }),
      where: (f, op, v) => ({ __c: 'where', f, op, v }),
      orderBy: (f, dir) => ({ __c: 'orderBy', f, dir }),
      limit: (n) => ({ __c: 'limit', n }),
    },
    snapOf,
  };
};

const build = (providers = DEFAULT_PROVIDERS, docs = {}) => {
  const { fs, calls, snapOf, store } = makeFs(docs);
  const db = { id: 'fake-db' };
  const p = createProvider({ backends: { firebase: createFirebaseBackend(db, fs) }, providers });
  return { p, calls, db, snapOf, fs, store };
};

const lastSet = (calls) => calls.filter((c) => c.op === 'setDoc' || c.op === 'tx.set').at(-1);

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

test('P03 共有の棚も同じ窓口から引ける', async () => {
  const { p, calls } = build();
  await p.save(GOAL_NS, 'settings', 'config', { g: 1 });
  assert.deepEqual(calls.at(-1).ref.segs, ['artifacts', 'goal-shared-v1', 'public', 'data', 'settings', 'config']);
  await p.save(CONTACT_NS, 'settings', 'config', { c: 1 });
  assert.deepEqual(calls.at(-1).ref.segs, ['artifacts', 'contact-shared-v1', 'public', 'data', 'settings', 'config']);
});

test('P04 routeOf で「どこがまだ Firebase か」を数えられる', () => {
  const { p } = build(PLANNED_PROVIDERS);
  assert.deepEqual(p.routeOf(NS.final, 'lots'), { area: 'inspection', backend: 'pocketbase', known: true });
  assert.deepEqual(p.routeOf(NS.final, 'contact_requests'), { area: 'contact', backend: 'firebase', known: true });
});

test('P05 用意していない保管庫を指すと、黙って動かず理由が出る', async () => {
  const { fs } = makeFs();
  const p = createProvider({ backends: { firebase: createFirebaseBackend({}, fs) }, providers: PLANNED_PROVIDERS });
  await assert.rejects(() => p.save(NS.final, 'lots', 'x', {}), /用意されていません/);
  // 連絡は firebase のままなので通る
  await assert.doesNotReject(() => p.save(NS.final, 'contact_requests', 'r1', {}));
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
  const { db, fs } = build();
  const ref = fs.collection(db, 'artifacts', NS.final, 'public', 'data', 'lots');
  ref.__emit = [{ docs: [{ id: 'L1', data: () => ({ id: 'zzz', q: 1 }) }] }];
  let got = null;
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
// P10-P16 印(番兵)が窓口の中でだけ Firestore の値になる
// ============================================================================

test('P10 サーバ時刻の印は、保存の直前に serverTimestamp() へ変わる', async () => {
  const { p, calls } = build();
  await p.save(NS.final, 'lots', 'x', { updatedAt: DATA_SERVER_NOW, a: 1 });
  assert.deepEqual(calls.at(-1).data, { updatedAt: '<<serverTimestamp>>', a: 1 });
});

test('P11 消す印は、保存の直前に deleteField() へ変わる(入れ子でも)', async () => {
  const { p, calls } = build();
  await p.save(NS.final, 'lots', 'x', { tasks: { 's_a-0': DATA_DELETE, keep: { v: 1 } } });
  assert.deepEqual(calls.at(-1).data, { tasks: { 's_a-0': '<<deleteField>>', keep: { v: 1 } } });
});

test('P12 __deleteMapKeys は窓口が印に直す(直下のキー)', async () => {
  const { p, calls } = build();
  await p.save(NS.final, 'lots', 'x', { tasks: { keep: 1 }, __deleteMapKeys: { tasks: ['s_a-0'] } });
  assert.deepEqual(calls.at(-1).data, { tasks: { keep: 1, 's_a-0': '<<deleteField>>' } });
  assert.ok(!('__deleteMapKeys' in calls.at(-1).data), '印の入れ物がそのまま保存されている');
});

test('P13 __deleteMapKeys は深い場所も指せる(パスは配列)', async () => {
  const { p, calls } = build();
  // ⚠ドット区切りにすると型式名「MB-200.5」で壊れる。配列で扱うこと。
  await p.save(NS.final, 'settings', 'config', { __deleteMapKeys: [['workerRoster', '2026-07-27', '田中']] });
  assert.deepEqual(calls.at(-1).data, { workerRoster: { '2026-07-27': { 田中: '<<deleteField>>' } } });
});

test('P14 消す印は「消したまま」= 同期後に復活しない', async () => {
  // 2026-07-26 の本番不具合の再発防止。merge:true は送らなかったキーを消さないので、
  // 「消した」を明示しないとサーバに残り、次の購読で画面へ戻ってくる。
  const { p, calls } = build();
  await p.save(NS.final, 'settings', 'config', {
    customSteps: { A: { on: true } },
    __deleteMapKeys: { customSteps: ['B'] },
  });
  const sent = calls.at(-1);
  assert.deepEqual(sent.opts, { merge: true });               // merge のまま(全上書きにしない)
  assert.equal(sent.data.customSteps.B, '<<deleteField>>');   // 消す指示が確かに届いている
  assert.deepEqual(sent.data.customSteps.A, { on: true });    // 残すものは残る
});

test('P15 配列の中に印を置いた保存は、黙って通さず落ちる', async () => {
  const { p } = build();
  await assert.rejects(() => p.save(NS.final, 'lots', 'x', { arr: [DATA_DELETE] }), /配列の中に印は置けません/);
});

test('P16 setFields は項目を丸ごと差し替える(入れ子マージをしない)', async () => {
  const { p, calls } = build();
  await p.setFields(NS.final, 'settings', 'config', { skipInspection: { on: false } });
  const c = calls.at(-1);
  assert.equal(c.op, 'updateDoc');
  assert.deepEqual(c.fields, { skipInspection: { on: false } });
  assert.deepEqual(c.ref.segs.at(-1), 'config');
});

// ============================================================================
// P17-P21 割り込まれない書き込み(意図の名前で呼ぶ)
// ============================================================================

const REQ = 'artifacts/final-inspection-v1/public/data/contact_requests/r1';

test('P17 claimOnce: 期待どおりなら取れる', async () => {
  const { p, calls } = build(DEFAULT_PROVIDERS, { [REQ]: { reminds: 0 } });
  const r = await p.claimOnce(NS.final, 'contact_requests', 'r1', { reminds: 0 }, { reminds: 1 });
  assert.deepEqual({ acquired: r.acquired, reason: r.reason }, { acquired: true, reason: CLAIM.OK });
  assert.deepEqual(lastSet(calls).data, { reminds: 1, updatedAt: '<<serverTimestamp>>' });
});

test('P18 claimOnce: 先を越されていたら取れない', async () => {
  const { p } = build(DEFAULT_PROVIDERS, { [REQ]: { reminds: 1 } });
  const r = await p.claimOnce(NS.final, 'contact_requests', 'r1', { reminds: 0 }, { reminds: 1 });
  assert.deepEqual({ acquired: r.acquired, reason: r.reason }, { acquired: false, reason: CLAIM.TAKEN });
});

test('P19 claimOnce: 0 を null に潰さない(reminds:0 が実在しても永久ロックしない)', async () => {
  // ⚠期待値は「数」で比べる。欠落を0とみなすが、0 を null 扱いにしてはいけない。
  const { p } = build(DEFAULT_PROVIDERS, { [REQ]: {} }); // reminds が欠落
  const r = await p.claimOnce(NS.final, 'contact_requests', 'r1', { reminds: 0 }, { reminds: 1 });
  assert.equal(r.acquired, true, '欠落は0とみなす');
});

test('P20 claimOnce: 通信/認証/サーバーの失敗を「取られた」と同じ扱いにしない', async () => {
  const { fs } = makeFs();
  const boom = new Error('network down');
  const db = {};
  const p = createProvider({
    backends: { firebase: createFirebaseBackend(db, { ...fs, runTransaction: () => Promise.reject(boom) }) },
  });
  const r = await p.claimOnce(NS.final, 'contact_requests', 'r1', {}, {});
  assert.equal(r.acquired, false);
  assert.equal(r.reason, CLAIM.ERROR);   // ← TAKEN ではない
  assert.equal(r.error, boom);           // 原因が呼び出し側に届く
});

test('P21 claimOnce: 対象が無いときは missing(存在しないと取られたは別)', async () => {
  const { p } = build();
  const r = await p.claimOnce(NS.final, 'contact_requests', 'nope', {}, {});
  assert.deepEqual({ acquired: r.acquired, reason: r.reason }, { acquired: false, reason: CLAIM.MISSING });
});

test('P22 appendCapped: 書く直前に読み直して足す(相手の1件を消さない)', async () => {
  const REF = 'artifacts/final-inspection-v1/public/data/accessory_refs/a1';
  const { p, calls } = build(DEFAULT_PROVIDERS, { [REF]: { name: 'ボルト', shots: ['old'] } });
  const r = await p.appendCapped(NS.final, 'accessory_refs', 'a1', 'shots', 'new', { maxBytes: 900 * 1024, fallback: { name: 'ボルト' } });
  assert.deepEqual(r, { count: 2, dropped: 0 });
  assert.deepEqual(lastSet(calls).data.shots, ['old', 'new']);
  assert.deepEqual(lastSet(calls).opts, { merge: true });
});

test('P23 appendCapped: 上限を超えたら古い方から落とす', async () => {
  const REF = 'artifacts/final-inspection-v1/public/data/accessory_refs/a1';
  const big = 'x'.repeat(200);
  const { p, calls } = build(DEFAULT_PROVIDERS, { [REF]: { name: 'A', shots: [big, big, big] } });
  const r = await p.appendCapped(NS.final, 'accessory_refs', 'a1', 'shots', big, { maxBytes: 500 });
  assert.ok(r.dropped > 0, '落ちていない');
  assert.equal(lastSet(calls).data.shots.at(-1), big, '足した新しいものが残っていない');
});

test('P24 appendCapped: 消えていたら名前ごと作り直す(幽霊にしない)', async () => {
  const { p, calls } = build(); // ドキュメント無し
  await p.appendCapped(NS.final, 'accessory_refs', 'a1', 'shots', 's1', { fallback: { name: 'ボルト', model: 'MB' } });
  const c = lastSet(calls);
  assert.equal(c.data.name, 'ボルト');
  assert.equal(c.data.model, 'MB');
  assert.deepEqual(c.data.shots, ['s1']);
  assert.equal(c.opts, undefined, '存在しない時は全体を書く(merge ではない)');
});

// ============================================================================
// P25-P28 その他
// ============================================================================

test('P25 fs の関数が足りなければ、使う前に落ちる', () => {
  assert.throws(() => createFirebaseBackend({}, { collection: () => {} }), /fs\.doc/);
  // ⚠新しく要るようになった3つも、渡し忘れたらその場で分かる
  const ok = makeFs().fs;
  for (const k of ['deleteField', 'updateDoc', 'runTransaction']) {
    const partial = { ...ok }; delete partial[k];
    assert.throws(() => createFirebaseBackend({}, partial), new RegExp(`fs\\.${k}`), k);
  }
});

test('P26 同じ db なら同じ窓口を返す(購読が張り直されない)', () => {
  const { fs } = makeFs();
  const db = {};
  const a = providerFor(db, fs);
  const b = providerFor(db, fs);
  assert.equal(a, b);
  assert.equal(providerFor(null, fs), null);
  assert.notEqual(providerFor({}, fs), a);
});

test('P27 docRef / colRef は窓口の外に出ていない(逃げ道を残さない)', () => {
  const { p } = build();
  assert.equal(typeof p.docRef, 'undefined', 'docRef が公開されたままです');
  assert.equal(typeof p.colRef, 'undefined', 'colRef が公開されたままです');
  assert.equal(typeof p.now, 'undefined', 'now() が公開されたままです(印を使うこと)');
});

test('P28 実行時のルート監査: 実際に通った置き場所を記録する', async () => {
  // ⚠コレクション名は変数でも渡る。ソースを読むだけでは網羅を証明できないので、
  //   画面を触った後にこの一覧を地図と突き合わせる。
  const { p } = build();
  await p.save(NS.final, 'lots', 'x', {});
  p.watchCollection(NS.final, 'lots', () => {});
  await p.save(CONTACT_NS, 'settings', 'config', {});
  const audit = p.routeAudit();
  const lots = audit.find((a) => a.col === 'lots');
  assert.deepEqual(lots.ops, { save: 1, watchCollection: 1 });
  assert.deepEqual({ area: lots.area, backend: lots.backend, known: lots.known }, { area: 'inspection', backend: 'firebase', known: true });
  assert.ok(audit.some((a) => a.ns === CONTACT_NS && a.area === 'contact'));
  p.resetRouteAudit();
  assert.deepEqual(p.routeAudit(), []);
});

// ============================================================================
// P29-P34 絞り込み(並び順・件数・条件)
// ----------------------------------------------------------------------------
// ⚠部品検査は lots を orderBy+limit、rotaryEvents を where、rotaryMeasurements を
//   orderBy+limit で購読している。これを画面で組み立てると Firestore 固有の
//   オブジェクトが窓口の外に出る(deleteField と同じ問題)。
//   → 画面は「ただの配列/数」で渡し、Firestore の形にするのは窓口の中だけ。
// ============================================================================

const lastWatch = (calls) => calls.filter((c) => c.op === 'onSnapshot').at(-1);

test('P29 絞り込みが無ければ、今までどおりコレクションをそのまま購読する', () => {
  const { p, calls } = build();
  p.watchCollection(NS.parts, 'notes', () => {});
  const c = lastWatch(calls);
  assert.equal(c.ref.__kind, 'col', '絞り込みが無いのに query() を通している');
  assert.equal(c.snapOpts, undefined, '第2引数を勝手に足している(引数の意味が変わる)');
});

test('P30 orderBy / limit は窓口の中で Firestore の形になる(中身も並びも同じ)', () => {
  const { p, calls } = build();
  p.watchCollection(NS.parts, 'lots', () => {}, { orderBy: [['createdAt', 'desc']], limit: 500 });
  const c = lastWatch(calls);
  assert.equal(c.ref.__kind, 'query');
  assert.deepEqual(c.ref.base.segs, ['artifacts', 'parts-inspection-v1', 'public', 'data', 'lots']);
  // 今までの手書き: query(col, orderBy('createdAt','desc'), limit(500)) と1つも違わない
  assert.deepEqual(c.ref.parts, [{ __c: 'orderBy', f: 'createdAt', dir: 'desc' }, { __c: 'limit', n: 500 }]);
});

test('P31 where も同じ(順番は where → orderBy → limit のまま)', () => {
  const { p, calls } = build();
  p.watchCollection(NS.parts, 'rotaryEvents', () => {}, {
    where: [['type', '==', 'done']], orderBy: [['createdAt', 'asc']], limit: 3,
  });
  assert.deepEqual(lastWatch(calls).ref.parts.map((x) => x.__c), ['where', 'orderBy', 'limit']);
  assert.deepEqual(lastWatch(calls).ref.parts[0], { __c: 'where', f: 'type', op: '==', v: 'done' });
});

test('P32 includeMetadataChanges は渡された時だけ第2引数に入る', () => {
  // ⚠Firestore は onSnapshot(ref, next, onError) と onSnapshot(ref, options, next, onError) で
  //   引数の意味が変わる。既定で {} を入れると今までと呼び方が変わってしまう。
  const { p, calls } = build();
  p.watchCollection(NS.parts, 'templates', () => {});
  assert.equal(lastWatch(calls).snapOpts, undefined);
  p.watchCollection(NS.parts, 'templates', () => {}, { includeMetadataChanges: true });
  assert.deepEqual(lastWatch(calls).snapOpts, { includeMetadataChanges: true });
  // エラー用の関数と併用しても、両方ちゃんと届く
  p.watchCollection(NS.parts, 'templates', () => {}, { includeMetadataChanges: true, onError: () => {} });
  assert.equal(lastWatch(calls).hasErr, true);
  assert.deepEqual(lastWatch(calls).snapOpts, { includeMetadataChanges: true });
});

test('P33 絞り込みを使うのに fs が渡されていなければ、その場で名指しで落ちる', () => {
  // ⚠黙って絞り込み無しで全部読む、をやらない(課金と表示件数が変わる)。
  const { fs } = makeFs();
  const bare = { ...fs };
  delete bare.query; delete bare.orderBy; delete bare.limit; delete bare.where;
  const backend = createFirebaseBackend({}, bare); // 絞り込みを使わない限り作れる(最終検査はこれ)
  assert.equal(typeof backend.watchCollection, 'function');
  assert.throws(() => backend.watchCollection(NS.parts, 'lots', () => {}, { orderBy: [['createdAt', 'desc']] }), /fs\.orderBy/);
  assert.throws(() => backend.watchCollection(NS.parts, 'lots', () => {}, { limit: 10 }), /fs\.limit/);
  assert.throws(() => backend.watchCollection(NS.parts, 'x', () => {}, { where: [['a', '==', 1]] }), /fs\.where/);
});

test('P34 getAll にも同じ絞り込みが効く', async () => {
  const { p, calls } = build();
  await p.getAll(NS.parts, 'lots', { orderBy: [['createdAt', 'desc']], limit: 5 });
  const c = calls.filter((x) => x.op === 'getDocs').at(-1);
  assert.equal(c.ref.__kind, 'query');
  assert.deepEqual(c.ref.parts.at(-1), { __c: 'limit', n: 5 });
});
