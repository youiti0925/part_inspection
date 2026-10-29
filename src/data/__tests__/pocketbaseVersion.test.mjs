// ============================================================================
// PocketBase 版の保管庫: createOnce / commitVersion / getPageFields (2026-10-29 追加)
// ----------------------------------------------------------------------------
// 足す前は窓口が「保管庫 pocketbase は commitVersion に対応していません」と投げ、
// 計画の版の一覧・保存(App.jsx の planShelf)が PocketBase では必ず落ちていた。
// Firebase 版の試験(provider.test.mjs P24a-P24d / P36)と **同じ返事** になる事を見る。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPocketbaseBackend } from '../pocketbaseBackend.js';
import { createMemoryStore } from '../outbox.js';
import { PbHttpError } from '../pbClient.js';
import { GATES_COL } from '../pbDocStore.js';
import { createProvider } from '../provider.js';

const NS = 'capacity-shared-v1';

/** docs と doc_gates を持つ偽サーバ(UNIQUE も本物と同じように効く)。 */
const makeServer = () => {
  const docs = new Map(); const gates = new Map();
  let n = 0; const failures = [];
  const parse = (f = '') => Object.fromEntries([...String(f).matchAll(/(\w+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const tableOf = (c) => (c === GATES_COL ? gates : docs);
  const maybeFail = (col, method) => {
    const i = failures.findIndex((f) => f.col === col && f.method === method);
    if (i < 0) return; const [f] = failures.splice(i, 1); throw f.error;
  };
  const srv = {
    docs, gates,
    failNext: (col, method, error) => failures.push({ col, method, error }),
    isAuthed: () => true,
    whenReady: () => Promise.resolve(),
    listPage: async (col, { filter } = {}) => {
      maybeFail(col, 'list');
      const want = parse(filter);
      const items = [...tableOf(col).values()].filter((r) => Object.entries(want).every(([k, v]) => String(r[k] ?? '') === v));
      return { items, totalItems: items.length, totalPages: 1 };
    },
    listAll: async (col, opts) => (await srv.listPage(col, opts)).items,
    create: async (col, data) => {
      maybeFail(col, 'create');
      const t = tableOf(col);
      const key = col === GATES_COL ? ['scope', 'claimId'] : ['ns', 'col', 'docId'];
      if ([...t.values()].some((r) => key.every((k) => String(r[k] ?? '') === String(data[k] ?? '')))) {
        throw new PbHttpError(400, { data: { docId: { code: 'validation_not_unique' } } }, '/x');
      }
      const rec = { id: `r${++n}`, created: new Date().toISOString(), ...data };
      t.set(rec.id, rec); return rec;
    },
    update: async (col, id, patch) => {
      maybeFail(col, 'update');
      const t = tableOf(col); const cur = t.get(id);
      if (!cur) throw new PbHttpError(404, 'not found', '/x');
      t.set(id, { ...cur, ...patch }); return t.get(id);
    },
    remove: async (col, id) => { maybeFail(col, 'remove'); tableOf(col).delete(id); return {}; },
    openRealtime: () => () => {},
  };
  return srv;
};
const mk = (srv) => createPocketbaseBackend(srv, { outboxStore: createMemoryStore(), autoRealtime: false });
const find = (srv, col, docId) => [...srv.docs.values()].find((r) => r.ns === NS && r.col === col && r.docId === docId) || null;
const seed = (srv, col, docId, data, rev = 1) => srv.create('docs', { ns: NS, col, docId, data, rev });

const cvArgs = (over = {}) => ({
  headCol: 'plan_control', headId: 'product', versionCol: 'plan_versions',
  versionId: 'product__v1', expectRevision: 0,
  versionDoc: { app: 'product', revision: 1, body: 'x' }, headDoc: { kind: 'head', revision: 1, versionId: 'product__v1' },
  ...over,
});

test('PV1 commitVersion: head が無く期待 0 なら 版と head を書いて ok', async () => {
  const srv = makeServer(); const b = mk(srv);
  const r = await b.commitVersion(NS, cvArgs());
  assert.deepEqual(r, { ok: true, headRevision: 1 });
  assert.equal(find(srv, 'plan_versions', 'product__v1').data.body, 'x');
  assert.equal(find(srv, 'plan_control', 'product').data.revision, 1);
});

test('PV2 commitVersion: 🚨 head の版が動いていたら 何も書かず stale', async () => {
  const srv = makeServer(); const b = mk(srv);
  await seed(srv, 'plan_control', 'product', { revision: 3 });
  const r = await b.commitVersion(NS, cvArgs({ expectRevision: 2 }));
  assert.deepEqual(r, { ok: false, reason: 'stale', headRevision: 3 });
  assert.equal(find(srv, 'plan_versions', 'product__v1'), null);
});

test('PV3 commitVersion: 同じ版の書類が既に在れば 何も書かず exists', async () => {
  const srv = makeServer(); const b = mk(srv);
  await seed(srv, 'plan_versions', 'product__v1', { old: true });
  const r = await b.commitVersion(NS, cvArgs());
  assert.equal(r.ok, false); assert.equal(r.reason, 'exists');
  assert.equal(find(srv, 'plan_control', 'product'), null);
  assert.equal(find(srv, 'plan_versions', 'product__v1').data.old, true);
});

test('PV4 commitVersion: head が在る時は rev を進め、preserveOld と欠片も書く', async () => {
  const srv = makeServer(); const b = mk(srv);
  await seed(srv, 'plan_control', 'product', { revision: 1, legacyBody: 'L' }, 5);
  const r = await b.commitVersion(NS, cvArgs({
    expectRevision: 1, versionId: 'product__v2', versionDoc: { revision: 2 }, headDoc: { kind: 'head', revision: 2 },
    preserveOld: (cur) => (cur.legacyBody ? { col: 'plan_versions', id: 'product__v1', doc: { body: cur.legacyBody } } : null),
    chunks: [{ id: 'product__v2__c0', doc: { part: 0 } }],
  }));
  assert.deepEqual(r, { ok: true, headRevision: 2 });
  const head = find(srv, 'plan_control', 'product');
  assert.equal(head.rev, 6); assert.equal(head.data.revision, 2);
  assert.equal(find(srv, 'plan_versions', 'product__v1').data.body, 'L');
  assert.equal(find(srv, 'plan_versions', 'product__v2__c0').data.part, 0);
});

test('PV5 commitVersion: 🚨 head を書けなかったら 作った版と欠片を消し、門を返して投げる(片方だけ残さない)', async () => {
  const srv = makeServer(); const b = mk(srv);
  await seed(srv, 'plan_control', 'product', { revision: 1 });
  srv.failNext('docs', 'update', new Error('通信が切れた'));
  await assert.rejects(() => b.commitVersion(NS, cvArgs({ expectRevision: 1, versionId: 'product__v2', chunks: [{ id: 'product__v2__c0', doc: {} }] })), /通信が切れた/);
  assert.equal(find(srv, 'plan_versions', 'product__v2'), null);
  assert.equal(find(srv, 'plan_versions', 'product__v2__c0'), null);
  assert.equal(srv.gates.size, 0, '門は返されている(次の保存が詰まらない)');
  // 返した後はもう一度通る
  const r = await b.commitVersion(NS, cvArgs({ expectRevision: 1, versionId: 'product__v2' }));
  assert.equal(r.ok, true);
});

test('PV6 commitVersion: 2台が同じ版から同時に保存 → 通るのは1台だけ(もう1台は stale)', async () => {
  const srv = makeServer(); const a = mk(srv); const c = mk(srv);
  await seed(srv, 'plan_control', 'product', { revision: 1 });
  const [r1, r2] = await Promise.all([
    a.commitVersion(NS, cvArgs({ expectRevision: 1, versionId: 'product__v2a' })),
    c.commitVersion(NS, cvArgs({ expectRevision: 1, versionId: 'product__v2b' })),
  ]);
  assert.equal([r1, r2].filter((x) => x.ok).length, 1);
  assert.equal([r1, r2].find((x) => !x.ok).reason, 'stale');
  // 負けた側の版は残っていない
  const loser = r1.ok ? 'product__v2b' : 'product__v2a';
  assert.equal(find(srv, 'plan_versions', loser), null);
});

test('PV7 createOnce: 無い時だけ作る。在れば taken。通信の失敗は error(taken と混ぜない)', async () => {
  const srv = makeServer(); const b = mk(srv);
  assert.deepEqual(await b.createOnce(NS, 'route_drafts', 'd1', { a: 1 }), { acquired: true, reason: 'ok' });
  assert.deepEqual(await b.createOnce(NS, 'route_drafts', 'd1', { a: 2 }), { acquired: false, reason: 'taken' });
  assert.equal(find(srv, 'route_drafts', 'd1').data.a, 1);
  srv.failNext('docs', 'create', new Error('切れた'));
  const r = await b.createOnce(NS, 'route_drafts', 'd2', {});
  assert.equal(r.acquired, false); assert.equal(r.reason, 'error');
});

test('PV8 getPageFields: 絞り込みを当てた全件を projected:false と理由付きで返す(黙らない)', async () => {
  const srv = makeServer(); const b = mk(srv);
  await seed(srv, 'plan_versions', 'p1', { app: 'product', revision: 1 });
  await seed(srv, 'plan_versions', 'f1', { app: 'final', revision: 1 });
  const r = await b.getPageFields(NS, 'plan_versions', ['app', 'revision'], { where: [['app', '==', 'product']] });
  assert.equal(r.projected, false);
  assert.ok(r.fellBack);
  assert.deepEqual(r.rows.map((x) => x.id), ['p1']);
});

// ⚠2026-10-29 4アプリで揃えた時に決めた形: 読めなかった時は投げずに fromCache:true で「読めなかった」と言う
//   (Firebase 版の getPageFields と同じ約束。呼び元は fromCache:true を「読めなかった」として扱う決まり)。
//   0件を「全部そろった」と混ぜない点は同じ。
test('PV9 getPageFields: 読めなかった時は fromCache:true で読めなかった事を言う(0件を「全部そろった」と言わない)', async () => {
  const srv = makeServer(); const b = mk(srv);
  srv.failNext('docs', 'list', new Error('サーバに届かない'));
  const r = await b.getPageFields(NS, 'plan_versions', ['app']);
  assert.equal(r.fromCache, true);
  assert.equal(r.projected, false);
});

test('PV10 窓口(createProvider)経由でも 3つとも PocketBase へ届く(「対応していません」で落ちない)', async () => {
  const srv = makeServer(); const pb = mk(srv);
  const all = { inspection: 'pocketbase', attachments: 'pocketbase', analytics: 'pocketbase', goals: 'pocketbase', contact: 'pocketbase', push: 'pocketbase' };
  const p = createProvider({ backends: { pocketbase: pb }, providers: all });
  assert.equal((await p.commitVersion(NS, cvArgs())).ok, true);
  assert.equal((await p.createOnce(NS, 'route_drafts', 'x', {})).acquired, true);
  assert.equal((await p.getPageFields(NS, 'plan_versions', ['app'])).rows.length, 1);
});
