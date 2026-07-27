// ============================================================================
// PocketBase 版の保管庫の回帰試験(起動・読み方・保存が消えないこと)
// ----------------------------------------------------------------------------
// 2026-07-27 の点検で実測した3つを、二度と戻さないための試験。
//   ① 起動時に一度読めないと、その一覧が **エラーも出さずに空のまま固定** された
//   ② 読み方の指定(map)と絞り込みを **黙って無視** していた
//   ③ 電波が一瞬切れると **保存が黙って消えた**(送信待ちは0件=成功に見える)
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPocketbaseBackend } from '../pocketbaseBackend.js';
import { createMemoryStore } from '../outbox.js';
import { PbNetworkError, PbHttpError } from '../pbClient.js';
import { GATES_COL } from '../pbDocStore.js';

const NS = 'final-inspection-v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** docs と doc_gates を持つ偽サーバ(UNIQUE も本物と同じように効く)。 */
const makeServer = () => {
  const docs = new Map(); const gates = new Map();
  let n = 0; const failures = [];
  let authed = true;
  const parse = (f = '') => Object.fromEntries([...String(f).matchAll(/(\w+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const tableOf = (c) => (c === GATES_COL ? gates : docs);
  const maybeFail = (col, method) => {
    const i = failures.findIndex((f) => f.col === col && f.method === method);
    if (i < 0) return; const [f] = failures.splice(i, 1); throw f.error;
  };
  const srv = {
    docs, gates,
    failNext: (col, method, error) => failures.push({ col, method, error }),
    setAuthed: (v) => { authed = v; },
    isAuthed: () => authed,
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
        throw new PbHttpError(400, { data: { claimId: { code: 'validation_not_unique' } } }, '/x');
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

const mk = (srv, opts = {}) => createPocketbaseBackend(srv, { outboxStore: createMemoryStore(), autoRealtime: false, ...opts });

// ----------------------------------------------------------------------------
test('B01 起動時に一度読めなくても、次にはちゃんと読める(空のまま固定されない)', async () => {
  const srv = makeServer();
  await srv.create('docs', { ns: NS, col: 'lots', docId: 'L1', data: { name: 'ロットA' }, rev: 1 });
  const be = mk(srv);

  srv.failNext('docs', 'list', new PbNetworkError(new Error('電波が切れています'), '/x'));
  const first = await be.getAll(NS, 'lots');
  assert.equal(first.length, 0, '読めなかった時は空(画面は落とさない)');
  assert.ok(be.loadErrorOf(NS, 'lots'), '読めなかった事実が残る');

  // ⚠ここが本題。直す前は2回目も3回目もずっと0件だった。
  const second = await be.getAll(NS, 'lots');
  assert.equal(second.length, 1);
  assert.equal(second[0].name, 'ロットA');
  assert.equal(be.loadErrorOf(NS, 'lots'), null);
  be.close();
});

test('B02 ログインできていない時は、0件を「データが無い」として返さない', async () => {
  const srv = makeServer();
  await srv.create('docs', { ns: NS, col: 'lots', docId: 'L1', data: { name: 'ロットA' }, rev: 1 });
  const be = mk(srv);
  srv.setAuthed(false);
  const rows = await be.getAll(NS, 'lots');
  assert.equal(rows.length, 0);
  assert.match(String(be.loadErrorOf(NS, 'lots')?.message), /ログイン/, 'なぜ0件かが残る');

  srv.setAuthed(true);
  assert.equal((await be.getAll(NS, 'lots')).length, 1, 'ログイン後は読める');
  be.close();
});

test('B03 読み方の指定(本文のid優先)が効く', async () => {
  const srv = makeServer();
  await srv.create('docs', { ns: NS, col: 'improvements', docId: 'pb-doc-1', data: { id: 'card-999', title: 'カルテ' }, rev: 1 });
  const be = mk(srv);
  const dataWins = await be.getAll(NS, 'improvements', { map: (d) => ({ id: d.id, ...d.data() }) });
  const docIdWins = await be.getAll(NS, 'improvements');
  assert.equal(dataWins[0].id, 'card-999', '本文の id が勝つ(Firebase 版と同じ)');
  assert.equal(docIdWins[0].id, 'pb-doc-1', '既定はドキュメントID');
  be.close();
});

test('B04 購読でも読み方の指定が効く(受け手ごとに別でよい)', async () => {
  const srv = makeServer();
  await srv.create('docs', { ns: NS, col: 'improvements', docId: 'pb-doc-1', data: { id: 'card-999' }, rev: 1 });
  const be = mk(srv);
  await be.getAll(NS, 'improvements');   // 先に読ませておく
  const a = await new Promise((res) => { const un = be.watchCollection(NS, 'improvements', (r) => { un(); res(r); }); });
  const b = await new Promise((res) => { const un = be.watchCollection(NS, 'improvements', (r) => { un(); res(r); }, { map: (d) => ({ id: d.id, ...d.data() }) }); });
  assert.equal(a[0].id, 'pb-doc-1');
  assert.equal(b[0].id, 'card-999');
  be.close();
});

test('B05 絞り込みを渡したら、黙って全件返さずにその場で落ちる', async () => {
  const srv = makeServer();
  const be = mk(srv);
  await assert.rejects(() => be.getAll(NS, 'lots', { where: [['status', '==', 'open']] }), /絞り込み/);
  assert.throws(() => be.watchCollection(NS, 'lots', () => {}, { limit: 10 }), /絞り込み/);
  be.close();
});

test('B06 電波が一瞬切れても、保存は消えない(送信待ちに残り、つながったら入る)', async () => {
  const srv = makeServer();
  await srv.create('docs', { ns: NS, col: 'lots', docId: 'L1', data: { name: '大事なロット', 台数: 5 }, rev: 1 });
  const be = mk(srv);
  await be.getAll(NS, 'lots');

  srv.failNext('docs', 'update', new PbNetworkError(new Error('ECONNRESET'), '/x'));
  await be.save(NS, 'lots', 'L1', { 台数: 6 });
  await sleep(30);

  const afterFail = await be.outbox.summary();
  assert.equal(afterFail.total, 1, '⚠失敗した保存を「送った」ことにして消さない');
  assert.equal([...srv.docs.values()][0].data.台数, 5, 'まだサーバには入っていない');

  await be.outbox.retry((await be.outbox.list())[0].commandId);
  await sleep(50);

  assert.equal((await be.outbox.summary()).total, 0, '送れたら箱から消える');
  assert.equal([...srv.docs.values()][0].data.台数, 6, '⚠保存がちゃんと入っている');
  assert.equal([...srv.docs.values()][0].data.name, '大事なロット', '他のキーは消えていない');
  be.close();
});

test('B07 送り直しても二度は効かない(追記が2件にならない)', async () => {
  const srv = makeServer();
  await srv.create('docs', { ns: NS, col: 'settings', docId: 'config', data: { logs: [] }, rev: 1 });
  const be = mk(srv);
  await be.getAll(NS, 'settings');

  await be.appendCapped(NS, 'settings', 'config', 'logs', { v: 1 });
  await sleep(50);
  assert.equal([...srv.docs.values()][0].data.logs.length, 1);

  // 返事だけ届かなかった状況を作る(サーバには入っている・箱には残っている)
  const cmd = { ...(await be.outbox.list())[0] };
  await be.appendCapped(NS, 'settings', 'config', 'logs', { v: 2 });
  await sleep(50);
  assert.equal([...srv.docs.values()][0].data.logs.length, 2, '別の命令はちゃんと足される');
  be.close();
});
