// ============================================================================
// PocketBase 版の保管庫に足した5つの操作の試験(2026-10-29 社内サーバ移行の準備 G2)
// ----------------------------------------------------------------------------
// getPageFields / countQuery / createOnce / applyWithMark / commitVersion。
// 無いと窓口が「保管庫 pocketbase は … に対応していません」で投げ、画面の機能が止まっていた。
// 通信はしない(偽サーバ。UNIQUE は本物と同じように効く)。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPocketbaseBackend } from '../pocketbaseBackend.js';
import { createProvider } from '../provider.js';
import { createMemoryStore } from '../outbox.js';
import { PbHttpError } from '../pbClient.js';
import { GATES_COL } from '../pbDocStore.js';
import { isSentinel } from '../sentinels.js';

const NS = 'capacity-shared-v1';

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
  srv.find = (col, docId) => [...docs.values()].find((r) => r.ns === NS && r.col === col && r.docId === docId) || null;
  return srv;
};
const mk = (srv) => createPocketbaseBackend(srv, { outboxStore: createMemoryStore(), autoRealtime: false });
const seed = (srv, col, docId, data) => srv.create('docs', { ns: NS, col, docId, data, rev: 1 });

test('G2-01 窓口を通しても5つとも「対応していません」で落ちない', async () => {
  const srv = makeServer();
  const be = mk(srv);
  const P = createProvider({ backends: { pocketbase: be }, providers: { inspection: 'pocketbase', attachments: 'pocketbase', analytics: 'pocketbase', goals: 'pocketbase', contact: 'pocketbase', push: 'pocketbase' } });
  for (const fn of ['getPageFields', 'countQuery', 'createOnce', 'applyWithMark', 'commitVersion']) {
    assert.equal(typeof be[fn], 'function', `${fn} が保管庫に在る`);
    assert.equal(typeof P[fn], 'function', `${fn} が窓口に在る`);
  }
  await P.getPageFields(NS, 'plan_versions', ['app'], {});
  await P.countQuery(NS, 'plan_versions', {});
});

test('G2-02 getPageFields: 絞り込み・並び・件数・続き(書類ID)が効き、項目を選んでいない事を言う。getToken は呼ばない', async () => {
  const srv = makeServer();
  await seed(srv, 'plan_versions', 'v1', { app: 'final', revision: 1, body: 'x'.repeat(10) });
  await seed(srv, 'plan_versions', 'v2', { app: 'product', revision: 2 });
  await seed(srv, 'plan_versions', 'v3', { app: 'final', revision: 3 });
  await seed(srv, 'plan_versions', 'v4', { app: 'final', revision: 4 });
  const be = mk(srv);
  let called = 0;
  const r = await be.getPageFields(NS, 'plan_versions', ['app', 'revision'], { where: [['app', '==', 'final']], getToken: () => { called++; return 't'; } });
  assert.deepEqual(r.rows.map((x) => x.id), ['v1', 'v3', 'v4']);
  assert.equal(r.projected, false, '項目は選んでいない(全項目)と言う');
  assert.ok(r.fellBack, '理由を言う');
  assert.equal(r.fromCache, false, 'サーバから読めた');
  assert.equal(r.rows[0].body, 'x'.repeat(10), '全項目が入っている');
  assert.equal(called, 0, 'getToken(Firebase の合言葉)は呼ばない');
  const p = await be.getPageFields(NS, 'plan_versions', ['app'], { orderBy: [['__name__', 'asc']], limit: 2, after: 'v1' });
  assert.deepEqual(p.rows.map((x) => x.id), ['v2', 'v3'], 'after は前のページの最後の書類ID');
});

test('G2-03 countQuery: 絞り込んだ件数。サーバから読めない時は0と答えず投げる', async () => {
  const srv = makeServer();
  await seed(srv, 'lots', 'L1', { done: true });
  await seed(srv, 'lots', 'L2', { done: false });
  await seed(srv, 'lots', 'L3', { done: true });
  const be = mk(srv);
  assert.equal(await be.countQuery(NS, 'lots', { where: [['done', '==', true]] }), 2);
  const srv2 = makeServer();
  const be2 = mk(srv2);
  srv2.failNext('docs', 'list', new Error('電波なし'));
  await assert.rejects(() => be2.countQuery(NS, 'lots', {}), /電波なし/);
});

test('G2-04 createOnce: 無ければ作る・在れば taken・2台同時でも1台だけ', async () => {
  const srv = makeServer();
  const a = mk(srv); const b = mk(srv);
  const [ra, rb] = await Promise.all([
    a.createOnce(NS, 'route_drafts', 'R1', { by: 'a' }),
    b.createOnce(NS, 'route_drafts', 'R1', { by: 'b' }),
  ]);
  assert.equal([ra, rb].filter((r) => r.acquired).length, 1, '勝つのは1台だけ');
  assert.equal([ra, rb].find((r) => !r.acquired).reason, 'taken');
  const rec = srv.find('route_drafts', 'R1');
  assert.ok(rec, '作られた');
  assert.ok(isSentinel(rec.data.updatedAt), 'updatedAt はサーバ時刻の印(サーバ側で埋める)');
  // 通信の失敗は taken と混ぜない
  srv.failNext('docs', 'create', new Error('電波なし'));
  const rc = await a.createOnce(NS, 'route_drafts', 'R2', { by: 'a' });
  assert.equal(rc.acquired, false);
  assert.equal(rc.reason, 'error');
});

test('G2-05 applyWithMark: 印が無ければ本体→印の順に書く・済みなら何も書かない・本体が無ければ投げる', async () => {
  const srv = makeServer();
  await seed(srv, 'lots', 'A1', { entryAt: 0, name: 'ロット' });
  const be = mk(srv);
  const r1 = await be.applyWithMark(NS, 'arrival_times', 'A1', {
    done: (cur) => !!(cur && cur.applied), markPatch: { applied: { at: 1 } },
    targetCol: 'lots', targetId: 'A1', targetPatch: { entryAt: 123 },
  });
  assert.deepEqual(r1, { applied: true, reason: 'ok' });
  assert.equal(srv.find('lots', 'A1').data.entryAt, 123);
  assert.equal(srv.find('lots', 'A1').data.name, 'ロット', '本体の他の項目は残る');
  assert.deepEqual(srv.find('arrival_times', 'A1').data.applied, { at: 1 });
  const r2 = await be.applyWithMark(NS, 'arrival_times', 'A1', {
    done: (cur) => !!(cur && cur.applied), markPatch: { applied: { at: 2 } },
    targetCol: 'lots', targetId: 'A1', targetPatch: { entryAt: 999 },
  });
  assert.deepEqual(r2, { applied: false, reason: 'done' });
  assert.equal(srv.find('lots', 'A1').data.entryAt, 123, '済みなら本体を書かない');
  await assert.rejects(() => be.applyWithMark(NS, 'arrival_times', 'NOPE', {
    done: () => false, markPatch: { applied: { at: 3 } }, targetCol: 'lots', targetId: 'NOPE', targetPatch: { entryAt: 1 },
  }));
  assert.equal(srv.find('arrival_times', 'NOPE'), null, '本体が無くて失敗した時は印を書かない');
});

const commitArgs = (versionId, expectRevision, extra = {}) => ({
  headCol: 'plan_control', headId: 'final', versionCol: 'plan_versions', versionId, expectRevision,
  versionDoc: { app: 'final', revision: expectRevision + 1 }, headDoc: { revision: expectRevision + 1, adopted: versionId }, ...extra,
});

test('G2-06 commitVersion: 最初の版・次の版・古い revision は stale・同じ版は exists', async () => {
  const srv = makeServer();
  const be = mk(srv);
  const r1 = await be.commitVersion(NS, commitArgs('v1', 0, { chunks: [{ id: 'v1__c0', doc: { part: 0 } }] }));
  assert.deepEqual(r1, { ok: true, headRevision: 1 });
  assert.equal(srv.find('plan_control', 'final').data.adopted, 'v1');
  assert.ok(srv.find('plan_versions', 'v1__c0'), '欠片も書かれる');
  const r2 = await be.commitVersion(NS, commitArgs('v2', 1));
  assert.deepEqual(r2, { ok: true, headRevision: 2 });
  assert.equal(srv.find('plan_control', 'final').data.adopted, 'v2');
  const stale = await be.commitVersion(NS, commitArgs('v9', 1));
  assert.equal(stale.ok, false); assert.equal(stale.reason, 'stale'); assert.equal(stale.headRevision, 2);
  assert.equal(srv.find('plan_versions', 'v9'), null, 'stale の時は版を書かない');
  const ex = await be.commitVersion(NS, commitArgs('v2', 2));
  assert.equal(ex.reason, 'exists');
  assert.equal(srv.find('plan_control', 'final').data.revision, 2, 'exists の時は head を進めない');
});

test('G2-07 commitVersion: 2台が同じ revision から同時に保存しても、通るのは1台だけ(後勝ちで消えない)', async () => {
  const srv = makeServer();
  const be0 = mk(srv);
  await be0.commitVersion(NS, commitArgs('v1', 0));
  const a = mk(srv); const b = mk(srv);
  const [ra, rb] = await Promise.all([a.commitVersion(NS, commitArgs('va', 1)), b.commitVersion(NS, commitArgs('vb', 1))]);
  const wins = [ra, rb].filter((r) => r.ok);
  assert.equal(wins.length, 1, '通るのは1台だけ');
  const loser = ra.ok ? rb : ra;
  assert.equal(loser.reason, 'stale');
  const head = srv.find('plan_control', 'final').data;
  assert.equal(head.revision, 2);
  assert.equal(head.adopted, ra.ok ? 'va' : 'vb', 'head は勝った方の版を指す');
});

test('G2-08 commitVersion: 途中で失敗したら自分の版を片付け、門を返す(再試行が exists で詰まらない)', async () => {
  const srv = makeServer();
  const be = mk(srv);
  await be.commitVersion(NS, commitArgs('v1', 0));
  srv.failNext('docs', 'update', new Error('電波なし'));   // head の更新で落ちる
  await assert.rejects(() => be.commitVersion(NS, commitArgs('v2', 1)), /電波なし/);
  assert.equal(srv.find('plan_versions', 'v2'), null, '版は片付けられている');
  assert.equal(srv.gates.size, 0, '門は返されている');
  const again = await be.commitVersion(NS, commitArgs('v2', 1));
  assert.deepEqual(again, { ok: true, headRevision: 2 }, '同じ版でやり直せる');
});

test('G2-09 commitVersion: preserveOld が返した古い形も書く', async () => {
  const srv = makeServer();
  await seed(srv, 'plan_control', 'final', { revision: 0, plan: { old: true } });
  const be = mk(srv);
  const r = await be.commitVersion(NS, commitArgs('v1', 0, { preserveOld: (cur) => ({ col: 'plan_versions', id: 'legacy', doc: { plan: cur.plan } }) }));
  assert.equal(r.ok, true);
  assert.deepEqual(srv.find('plan_versions', 'legacy').data.plan, { old: true });
});
