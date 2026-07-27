// ============================================================================
// 「書けなかった時の後始末」の回帰試験
// ----------------------------------------------------------------------------
// 2026-07-27 の点検で、電波が1回切れただけで次の2つが同時に起きることを実測した。
//   ・門を取ったまま返さない → **その書類は以後どの端末からも保存できない**
//   ・送信待ちの箱が「受け付け済み」と判断して消す → **保存が黙って消える**
// ここはその2つが二度と戻ってこないようにするための試験。
//
// ⚠本物のサーバは使わない(この試験は毎回走る)。サーバでの実証は
//   scripts/verify-pb-recovery.mjs が別に行う。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDocStore, GATES_COL } from '../pbDocStore.js';
import { PbNetworkError, PbHttpError } from '../pbClient.js';

// ----------------------------------------------------------------------------
// 偽サーバ: docs と doc_gates だけを持ち、UNIQUE も本物と同じように効かせる
// ----------------------------------------------------------------------------
/** PocketBase の時刻表記(空白区切り・末尾Z)を Date.parse できる形に直す。 */
const pbTime = (s) => { const v = String(s || '').replace(' ', 'T'); return v.endsWith('Z') ? v : `${v}Z`; };

const makeServer = ({ now = () => Date.now() } = {}) => {
  const docs = new Map();   // recId -> {id, ns, col, docId, data, rev, lastCmd}
  const gates = new Map();  // recId -> {id, scope, claimId, owner, created}
  let n = 0;
  const failures = [];      // (col, method) => Error を投げる指示
  const parse = (f = '') => Object.fromEntries([...String(f).matchAll(/(\w+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
  // 掃除は `created < "..."` を使う。本物と同じように効かせないと試験が嘘になる。
  const parseBefore = (f = '') => (String(f).match(/created\s*<\s*"([^"]*)"/) || [])[1];
  const tableOf = (col) => (col === GATES_COL ? gates : docs);

  const maybeFail = (col, method) => {
    const i = failures.findIndex((f) => f.col === col && f.method === method);
    if (i < 0) return;
    const [f] = failures.splice(i, 1);
    throw f.error;
  };

  const srv = {
    docs, gates, failures,
    failNext: (col, method, error) => failures.push({ col, method, error }),
    isAuthed: () => true,
    listPage: async (col, { filter } = {}) => {
      const want = parse(filter);
      const before = parseBefore(filter);
      const items = [...tableOf(col).values()]
        .filter((r) => Object.entries(want).every(([k, v]) => String(r[k] ?? '') === v))
        // ⚠PocketBase の時刻は `2026-07-27 13:00:00.000Z`(空白区切り・末尾Z)。
        //   素直に 'Z' を足すと ZZ になって NaN。実際にここで一度落ちた。
        .filter((r) => (before === undefined ? true : Date.parse(pbTime(r.created)) < Date.parse(pbTime(before))));
      return { items, totalItems: items.length, totalPages: 1 };
    },
    listAll: async (col, opts) => (await srv.listPage(col, opts)).items,
    create: async (col, data) => {
      maybeFail(col, 'create');
      const t = tableOf(col);
      const key = col === GATES_COL ? ['scope', 'claimId'] : ['ns', 'col', 'docId'];
      const dup = [...t.values()].some((r) => key.every((k) => String(r[k] ?? '') === String(data[k] ?? '')));
      // ⚠本物と同じ型で投げる。中身だけ似せると instanceof が効かず、
      //   「取られた」が「通信の失敗」に化けて試験が通らない(実際にここで踏んだ)。
      if (dup) throw new PbHttpError(400, { data: { claimId: { code: 'validation_not_unique' } } }, `/api/collections/${col}/records`);
      const rec = { id: `r${++n}`, created: new Date(now()).toISOString(), ...data };
      t.set(rec.id, rec);
      return rec;
    },
    update: async (col, id, patch) => {
      maybeFail(col, 'update');
      const t = tableOf(col);
      const cur = t.get(id);
      if (!cur) { const e = new Error('not found'); e.status = 404; throw e; }
      t.set(id, { ...cur, ...patch });
      return t.get(id);
    },
    remove: async (col, id) => { maybeFail(col, 'remove'); tableOf(col).delete(id); return {}; },
  };
  return srv;
};

const NS = 'final-inspection-v1';
const cut = () => new PbNetworkError(new Error('ECONNRESET'), '/api/collections/docs/records/x');

// ----------------------------------------------------------------------------
test('G01 電波が切れて書けなかった後も、その書類はちゃんと保存できる(門を返している)', async () => {
  const srv = makeServer();
  const store = createDocStore(srv, { owner: 'tabletA' });
  await store.save(NS, 'lots', 'L1', { name: '大事なロット', 台数: 5 }, { merge: false });

  srv.failNext('docs', 'update', cut());
  await assert.rejects(() => store.save(NS, 'lots', 'L1', { 台数: 6 }), /通信失敗|ECONNRESET/);

  // ⚠ここが本題。直す前は「保存が12回やり直しても通りませんでした」で永久に詰まっていた。
  const r = await store.save(NS, 'lots', 'L1', { 台数: 6 });
  assert.equal(r.rev, 2);
  assert.deepEqual(await store.getOne(NS, 'lots', 'L1'), { name: '大事なロット', 台数: 6 });
  assert.equal(srv.gates.size, 1, '返しそこねた門が残っていない(今取った1つだけ)');
});

test('G02 別の端末からも、詰まらずに保存できる', async () => {
  const srv = makeServer();
  const a = createDocStore(srv, { owner: 'tabletA' });
  const b = createDocStore(srv, { owner: 'tabletB' });
  await a.save(NS, 'lots', 'L1', { 台数: 5 }, { merge: false });
  srv.failNext('docs', 'update', cut());
  await assert.rejects(() => a.save(NS, 'lots', 'L1', { 台数: 6 }));
  const r = await b.save(NS, 'lots', 'L1', { 台数: 7 });
  assert.equal(r.rev, 2);
  assert.equal((await b.getOne(NS, 'lots', 'L1')).台数, 7);
});

test('G03 端末ごと落ちて門を返せなかった場合も、古くなれば自動で外れる', async () => {
  let t = 1_700_000_000_000;
  const srv = makeServer({ now: () => t });
  const store = createDocStore(srv, { owner: 'tabletA', now: () => t, staleGateMs: 60_000 });
  await store.save(NS, 'lots', 'L1', { 台数: 5 }, { merge: false });

  // 端末が門を取ったまま消えた(返す処理すら走らなかった)状態を作る
  await srv.create(GATES_COL, { scope: `doc:${NS}/lots/L1`, claimId: 'rev:1', owner: '死んだ端末' });

  // まだ新しい門は外さない(書いている最中かもしれないため)
  await assert.rejects(() => store.save(NS, 'lots', 'L1', { 台数: 6 }), /やり直しても通りませんでした/);

  t += 61_000;  // 60秒より古くなった
  const r = await store.save(NS, 'lots', 'L1', { 台数: 6 });
  assert.equal(r.rev, 2);
  assert.equal((await store.getOne(NS, 'lots', 'L1')).台数, 6);
});

test('G04 同じ命令を二度送っても二度は効かない(追記が2件にならない)', async () => {
  const srv = makeServer();
  const store = createDocStore(srv, { owner: 'tabletA' });
  await store.save(NS, 'settings', 'config', { logs: [] }, { merge: false });
  const cmd = 'devA-abc-1-xyz';
  await store.appendCapped(NS, 'settings', 'config', 'logs', { v: 1 }, { cmdId: cmd });
  const again = await store.appendCapped(NS, 'settings', 'config', 'logs', { v: 1 }, { cmdId: cmd });
  assert.equal(again.alreadyApplied, true);
  assert.equal((await store.getOne(NS, 'settings', 'config')).logs.length, 1);
});

test('G05 返事が届かなかっただけの時、二度書きしない(印が押されている)', async () => {
  const srv = makeServer();
  const store = createDocStore(srv, { owner: 'tabletA' });
  await store.save(NS, 'lots', 'L1', { 台数: 5 }, { merge: false });
  const cmd = 'devA-def-2-uvw';
  await store.save(NS, 'lots', 'L1', { 台数: 6 }, { cmdId: cmd });
  const again = await store.save(NS, 'lots', 'L1', { 台数: 6 }, { cmdId: cmd });
  assert.equal(again.alreadyApplied, true, '同じ命令は二度効かない');
  assert.equal([...srv.docs.values()][0].rev, 2, 'rev が余計に進んでいない');
});

test('G06 2台が同時に保存しても、どちらの変更も消えない', async () => {
  const srv = makeServer();
  const a = createDocStore(srv, { owner: 'tabletA' });
  const b = createDocStore(srv, { owner: 'tabletB' });
  await a.save(NS, 'lots', 'L1', { 名前: 'ロット', 担当: '' }, { merge: false });
  await Promise.all([
    a.save(NS, 'lots', 'L1', { 担当: '佐藤' }),
    b.save(NS, 'lots', 'L1', { 備考: '至急' }),
  ]);
  const got = await a.getOne(NS, 'lots', 'L1');
  assert.equal(got.担当, '佐藤');
  assert.equal(got.備考, '至急');
  assert.equal([...srv.docs.values()][0].rev, 3);
});

test('G07 項目の差し替えも、書けなかった後に詰まらない', async () => {
  const srv = makeServer();
  const store = createDocStore(srv, { owner: 'tabletA' });
  await store.save(NS, 'settings', 'config', { skip: { on: true, why: 'x' } }, { merge: false });
  srv.failNext('docs', 'update', cut());
  await assert.rejects(() => store.setFields(NS, 'settings', 'config', { skip: { on: false } }));
  await store.setFields(NS, 'settings', 'config', { skip: { on: false } });
  assert.deepEqual((await store.getOne(NS, 'settings', 'config')).skip, { on: false });
});

test('G09 ⚠命令IDがかぶっても、中身が違えば「もう効いた」と誤認しない', async () => {
  const srv = makeServer();
  const store = createDocStore(srv, { owner: 'tabletA' });
  await store.save(NS, 'lots', 'L1', { 台数: 5 }, { merge: false });
  const cmd = 'devA-同じID';
  await store.save(NS, 'lots', 'L1', { 台数: 6 }, { cmdId: cmd });
  // 端末を開き直した直後などに、同じIDで **別の中身** が送られてくる場合
  await assert.rejects(
    () => store.save(NS, 'lots', 'L1', { 台数: 8 }, { cmdId: cmd }),
    /同じ命令ID.*中身が違います/,
    '⚠ここを「効いた」と扱うと、8台への修正が黙って消える'
  );
  assert.equal((await store.getOne(NS, 'lots', 'L1')).台数, 6, '前の保存は壊れていない');
});

test('G10 権利・中身・適用済みの記録が「1回の書き込み」で入る(ばらけない)', async () => {
  const srv = makeServer();
  const store = createDocStore(srv, { owner: 'tabletA' });
  await store.save(NS, 'lots', 'L1', { 台数: 5 }, { merge: false });
  const before = srv.docs.size;
  await store.save(NS, 'lots', 'L1', { 台数: 6 }, { cmdId: 'c1' });
  const rec = [...srv.docs.values()][0];
  assert.equal(srv.docs.size, before, '書類が増えていない');
  assert.equal(rec.data.台数, 6);
  assert.equal(rec.lastCmd, 'c1');
  assert.ok(rec.lastCmdHash, '中身の指紋も同じ書き込みで入っている');
  assert.ok(rec.lastCmdAt, 'いつ効いたかも入っている');
});

test('G11 通信が切れた保存を送り直しても、二度は効かない(追記が2件にならない)', async () => {
  const srv = makeServer();
  const store = createDocStore(srv, { owner: 'tabletA' });
  await store.save(NS, 'settings', 'config', { logs: [] }, { merge: false });
  const cmd = 'devA-append-1';
  // 1回目: サーバには入るが、返事が届かない状況を作る
  await store.appendCapped(NS, 'settings', 'config', 'logs', { v: 1 }, { cmdId: cmd });
  // 返事が届かなかったと思って、まったく同じ命令をもう一度送る
  const again = await store.appendCapped(NS, 'settings', 'config', 'logs', { v: 1 }, { cmdId: cmd });
  assert.equal(again.alreadyApplied, true);
  assert.equal((await store.getOne(NS, 'settings', 'config')).logs.length, 1);
});

test('G08 掃除は古い門だけを外す(書いている最中の門を外さない)', async () => {
  let t = 1_700_000_000_000;
  const srv = makeServer({ now: () => t });
  const store = createDocStore(srv, { owner: 'tabletA', now: () => t });
  await srv.create(GATES_COL, { scope: 'doc:a/b/c', claimId: 'rev:1' });
  t += 30 * 60 * 1000;                       // 30分後
  await srv.create(GATES_COL, { scope: 'doc:a/b/c', claimId: 'rev:2' });
  t += 40 * 60 * 1000;                       // さらに40分後(最初のは70分前・次のは40分前)
  const r = await store.pruneGates({ olderThanMs: 60 * 60 * 1000 });
  assert.equal(r.removed, 1);
  assert.equal(srv.gates.size, 1);
  assert.equal([...srv.gates.values()][0].claimId, 'rev:2');
});
