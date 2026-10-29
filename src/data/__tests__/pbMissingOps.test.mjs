// ============================================================================
// PocketBase 版に足した操作の試験(2026-10-29・社内サーバ移行の点検 G3/G4)
// ----------------------------------------------------------------------------
// 前は Firebase 版にだけあって、PocketBase に切り替えると「対応していません」で止まっていた:
//   getPageFields / countQuery / createOnce / commitVersion(操業シミュの保存計画)/ uploadFile(写真・資料)
// ⚠本物のサーバは使わない(通信なし)。偽サーバは UNIQUE と /api/batch(全部通るか全部戻る)を本物と同じように効かせる。
// ⚠本物の PocketBase での確かめはまだ(まとめ書き /api/batch はサーバの設定で有効にする必要がある)。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPocketbaseBackend } from '../pocketbaseBackend.js';
import { createMemoryStore } from '../outbox.js';
import { PbNetworkError, PbHttpError } from '../pbClient.js';
import { GATES_COL } from '../pbDocStore.js';
import { createProvider, createFirebaseBackend } from '../provider.js';
import { isSentinel } from '../sentinels.js';

const NS = 'capacity-shared-v1';

const makeServer = () => {
  const docs = new Map(); const gates = new Map(); const blobs = new Map();
  let n = 0; const failures = [];
  let batchEnabled = true;
  const parse = (f = '') => Object.fromEntries([...String(f).matchAll(/(\w+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const tableOf = (c) => (c === GATES_COL ? gates : c === 'blobs' ? blobs : docs);
  const maybeFail = (col, method) => {
    const i = failures.findIndex((f) => f.col === col && f.method === method);
    if (i < 0) return; const [f] = failures.splice(i, 1); throw f.error;
  };
  const uniqueErr = () => new PbHttpError(400, { data: { docId: { code: 'validation_not_unique' } } }, '/x');
  const checkUnique = (t, col, data) => {
    const key = col === GATES_COL ? ['scope', 'claimId'] : ['ns', 'col', 'docId'];
    if ([...t.values()].some((r) => key.every((k) => String(r[k] ?? '') === String(data[k] ?? '')))) throw uniqueErr();
  };
  const srv = {
    docs, gates, blobs, calls: [],
    failNext: (col, method, error) => failures.push({ col, method, error }),
    setBatch: (v) => { batchEnabled = v; },
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
      if (typeof FormData !== 'undefined' && data instanceof FormData) {
        srv.calls.push({ op: 'createForm', col, fields: Object.fromEntries([...data.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `blob:${v.size}:${v.type}`])) });
        const rec = { id: `b${++n}`, collectionName: col, file: `${data.get('filename')}` };
        tableOf(col).set(rec.id, rec); return rec;
      }
      const t = tableOf(col);
      checkUnique(t, col, data);
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
    // /api/batch: 全部通るか、1つでも駄目なら何も残さない(本物のまとめ書きと同じ約束)
    batch: async (requests) => {
      srv.calls.push({ op: 'batch', n: requests.length });
      maybeFail('batch', 'batch');
      if (!batchEnabled) throw new PbHttpError(404, { message: 'Batch requests are not allowed.' }, '/api/batch');
      const snapshot = new Map([...docs].map(([k, v]) => [k, { ...v }]));
      try {
        for (const r of requests) {
          const m = /^\/api\/collections\/([^/]+)\/records(?:\/(.+))?$/.exec(r.url);
          const col = decodeURIComponent(m[1]);
          if (r.method === 'POST') { checkUnique(docs, col, r.body); const rec = { id: `r${++n}`, ...r.body }; docs.set(rec.id, rec); }
          else if (r.method === 'PATCH') { const id = decodeURIComponent(m[2]); const cur = docs.get(id); if (!cur) throw new PbHttpError(404, 'nf', r.url); docs.set(id, { ...cur, ...r.body }); }
        }
      } catch (e) { docs.clear(); for (const [k, v] of snapshot) docs.set(k, v); throw e; }
      return requests.map(() => ({ status: 200 }));
    },
    fileUrl: (col, id, name) => `http://pb.local/api/files/${col}/${id}/${name}`,
    openRealtime: () => () => {},
  };
  return srv;
};
const mk = (srv) => createPocketbaseBackend(srv, { outboxStore: createMemoryStore(), autoRealtime: false });
const docOf = (srv, col, docId) => [...srv.docs.values()].find((r) => r.ns === NS && r.col === col && r.docId === docId) || null;

// ----------------------------------------------------------------------------
test('P01 createOnce: 無い時だけ作る・在れば taken・通信の失敗は taken と混ぜない', async () => {
  const srv = makeServer(); const be = mk(srv);
  const a = await be.createOnce(NS, 'route_drafts', 'D1', { name: 'A' });
  assert.equal(a.acquired, true);
  const b = await be.createOnce(NS, 'route_drafts', 'D1', { name: 'B' });
  assert.deepEqual([b.acquired, b.reason], [false, 'taken']);
  assert.equal(docOf(srv, 'route_drafts', 'D1').data.name, 'A', '後から来た方は書かない');
  assert.ok(isSentinel(docOf(srv, 'route_drafts', 'D1').data.updatedAt), 'updatedAt はサーバ時刻の印のまま(サーバ側で埋める)');
  srv.failNext('docs', 'list', new PbNetworkError(new Error('切れた'), '/x'));
  const c = await be.createOnce(NS, 'route_drafts', 'D2', { name: 'C' });
  assert.deepEqual([c.acquired, c.reason], [false, 'error']);
  assert.equal(await be.getOne(NS, 'route_drafts', 'D1').then((d) => d.name), 'A', '作った後は手元の一覧にも出る');
});

test('P02 commitVersion: 版と head をまとめて書く・revision が違えば stale・版が在れば exists', async () => {
  const srv = makeServer(); const be = mk(srv);
  const r1 = await be.commitVersion(NS, { headCol: 'plan_control', headId: 'parts', versionCol: 'plan_versions', versionId: 'v1',
    expectRevision: 0, versionDoc: { app: 'parts', no: 1 }, headDoc: { revision: 1, current: 'v1' } });
  assert.deepEqual(r1, { ok: true, headRevision: 1 });
  assert.equal(docOf(srv, 'plan_versions', 'v1').data.no, 1);
  assert.equal(docOf(srv, 'plan_control', 'parts').data.current, 'v1');

  const stale = await be.commitVersion(NS, { headCol: 'plan_control', headId: 'parts', versionCol: 'plan_versions', versionId: 'v2',
    expectRevision: 0, versionDoc: { no: 2 }, headDoc: { revision: 1, current: 'v2' } });
  assert.deepEqual([stale.ok, stale.reason, stale.headRevision], [false, 'stale', 1]);
  assert.equal(docOf(srv, 'plan_versions', 'v2'), null, 'stale の時は版も書かない');

  const exists = await be.commitVersion(NS, { headCol: 'plan_control', headId: 'parts', versionCol: 'plan_versions', versionId: 'v1',
    expectRevision: 1, versionDoc: { no: 9 }, headDoc: { revision: 2, current: 'v1' } });
  assert.deepEqual([exists.ok, exists.reason], [false, 'exists']);
  assert.equal(docOf(srv, 'plan_control', 'parts').data.revision, 1, 'exists の時は head を進めない');

  const r2 = await be.commitVersion(NS, { headCol: 'plan_control', headId: 'parts', versionCol: 'plan_versions', versionId: 'v2',
    expectRevision: 1, versionDoc: { no: 2 }, headDoc: { revision: 2, current: 'v2' }, chunks: [{ id: 'v2__c0', doc: { part: 0 } }],
    preserveOld: (cur) => ({ col: 'plan_versions', id: 'legacy', doc: { from: cur.current } }) });
  assert.deepEqual(r2, { ok: true, headRevision: 2 });
  assert.equal(docOf(srv, 'plan_versions', 'v2__c0').data.part, 0, '欠片も同じまとめ書きで入る');
  assert.equal(docOf(srv, 'plan_versions', 'legacy').data.from, 'v1', 'preserveOld も同じまとめ書きで入る');
  assert.equal(srv.gates.size, 1, 'head を進めた時は門を1つ取った(返さない = その rev は二度と取れない)');
});

test('P03 commitVersion: まとめ書きが無効(404)なら何も書かず、理由を言って止まる・門は返す', async () => {
  const srv = makeServer(); const be = mk(srv);
  await be.commitVersion(NS, { headCol: 'plan_control', headId: 'parts', versionCol: 'plan_versions', versionId: 'v1',
    expectRevision: 0, versionDoc: { no: 1 }, headDoc: { revision: 1 } });
  srv.setBatch(false);
  const before = srv.docs.size;
  await assert.rejects(() => be.commitVersion(NS, { headCol: 'plan_control', headId: 'parts', versionCol: 'plan_versions', versionId: 'v2',
    expectRevision: 1, versionDoc: { no: 2 }, headDoc: { revision: 2 } }), /まとめ書き/);
  assert.equal(srv.docs.size, before, '片方だけ残らない');
  assert.equal(srv.gates.size, 0, '取った門は返した(返さないと head が二度と保存できない)');
});

test('P04 commitVersion: まとめ書きの途中で別の端末に同じ版を作られたら、何も残さず exists を返す', async () => {
  const srv = makeServer(); const be = mk(srv);
  await be.commitVersion(NS, { headCol: 'plan_control', headId: 'parts', versionCol: 'plan_versions', versionId: 'v1',
    expectRevision: 0, versionDoc: { no: 1 }, headDoc: { revision: 1 } });
  // 版の在る/無いを見た直後に、別の端末が v2 を作った事にする
  const realBatch = srv.batch;
  srv.batch = async (reqs) => { await srv.create('docs', { ns: NS, col: 'plan_versions', docId: 'v2', data: { by: 'other' }, rev: 1 }); srv.batch = realBatch; return realBatch(reqs); };
  const r = await be.commitVersion(NS, { headCol: 'plan_control', headId: 'parts', versionCol: 'plan_versions', versionId: 'v2',
    expectRevision: 1, versionDoc: { no: 2 }, headDoc: { revision: 2 } });
  assert.deepEqual([r.ok, r.reason], [false, 'exists']);
  assert.equal(docOf(srv, 'plan_control', 'parts').data.revision, 1, 'head は進んでいない');
  assert.equal(docOf(srv, 'plan_versions', 'v2').data.by, 'other', '相手の版を消していない');
});

test('P05 getPageFields: 項目を絞って返す・読めなかった時は fromCache:true(「全部そろった」と言わない)', async () => {
  const srv = makeServer();
  await srv.create('docs', { ns: NS, col: 'plan_versions', docId: 'a', data: { app: 'parts', at: 1, body: 'x'.repeat(100) }, rev: 1 });
  await srv.create('docs', { ns: NS, col: 'plan_versions', docId: 'b', data: { app: 'final', at: 2, body: 'y' }, rev: 1 });
  const be = mk(srv);
  const r = await be.getPageFields(NS, 'plan_versions', ['app', 'at'], { where: [['app', '==', 'parts']] });
  assert.deepEqual(r.rows, [{ app: 'parts', at: 1, id: 'a' }]);
  assert.equal(r.projected, true); assert.equal(r.fromCache, false);

  const srv2 = makeServer(); const be2 = mk(srv2);
  srv2.failNext('docs', 'list', new PbNetworkError(new Error('切れた'), '/x'));
  const r2 = await be2.getPageFields(NS, 'plan_versions', ['app']);
  assert.equal(r2.fromCache, true, '読めなかった事を言う');
});

test('P06 countQuery: 条件で数える・読めない時は 0 ではなく投げる', async () => {
  const srv = makeServer();
  for (let i = 0; i < 5; i++) await srv.create('docs', { ns: NS, col: 'lots', docId: `L${i}`, data: { done: i % 2 === 0 }, rev: 1 });
  const be = mk(srv);
  assert.equal(await be.countQuery(NS, 'lots', { where: [['done', '==', true]] }), 3);
  const srv2 = makeServer(); const be2 = mk(srv2);
  srv2.failNext('docs', 'list', new PbNetworkError(new Error('切れた'), '/x'));
  await assert.rejects(() => be2.countQuery(NS, 'lots', {}));
});

test('P07 uploadFile: data URL を blobs へ上げ、表示用の URL を返す', async () => {
  const srv = makeServer(); const be = mk(srv);
  const png = 'data:image/png;base64,' + Buffer.from('hello-image').toString('base64');
  const url = await be.uploadFile('parts-inspection-v1', 'work_standard_files', 'template-images', png, { ext: 'png' });
  assert.match(url, /^http:\/\/pb\.local\/api\/files\/blobs\/b\d+\/\d+_[a-z0-9]+\.png$/);
  const call = srv.calls.find((c) => c.op === 'createForm');
  assert.equal(call.col, 'blobs');
  assert.equal(call.fields.ns, 'parts-inspection-v1');
  assert.equal(call.fields.col, 'work_standard_files');
  assert.match(call.fields.docId, /^template-images\//);
  assert.equal(call.fields.mime, 'image/png');
  assert.equal(call.fields.bytes, String('hello-image'.length));
  assert.equal(call.fields.file, `blob:${'hello-image'.length}:image/png`);
  await assert.rejects(() => be.uploadFile('n', 'c', 'p', 'not-a-data-url'), /data URL/);
});

test('P08 窓口: uploadFile は置き場の領域で振り分ける・Firebase 側は uploadDataUrl が渡されていなければ名指しで落ちる', async () => {
  const calls = [];
  const fakePb = { kind: 'pocketbase', uploadFile: async (...a) => { calls.push(a); return 'pb-url'; } };
  const fsMin = Object.fromEntries(['collection', 'doc', 'onSnapshot', 'setDoc', 'deleteDoc', 'getDocs', 'getDoc',
    'serverTimestamp', 'deleteField', 'updateDoc', 'runTransaction'].map((k) => [k, () => {}]));
  const fb = createFirebaseBackend({}, fsMin);
  const all = { inspection: 'pocketbase', attachments: 'pocketbase', analytics: 'pocketbase', goals: 'pocketbase', contact: 'pocketbase', push: 'pocketbase' };
  const P = createProvider({ backends: { firebase: fb, pocketbase: fakePb }, providers: all });
  assert.equal(await P.uploadFile('parts-inspection-v1', 'work_standard_files', 'x', 'data:,a'), 'pb-url');
  assert.equal(calls.length, 1);
  const Pf = createProvider({ backends: { firebase: fb }, providers: { ...all, attachments: 'firebase', inspection: 'firebase' } });
  await assert.rejects(() => Pf.uploadFile('parts-inspection-v1', 'work_standard_files', 'x', 'data:,a'), /uploadDataUrl/);
  const fb2 = createFirebaseBackend({}, { ...fsMin, uploadDataUrl: async (ns, hint) => `fb:${ns}:${hint}` });
  const Pf2 = createProvider({ backends: { firebase: fb2 }, providers: { ...all, attachments: 'firebase', inspection: 'firebase' } });
  assert.equal(await Pf2.uploadFile('parts-inspection-v1', 'work_standard_files', 'hint', 'data:,a'), 'fb:parts-inspection-v1:hint');
});
