// ============================================================================
// 🧪 R2(2026-10-31): いつもの(Firebase の)ビルドで、src/data を4アプリで揃えた変更が「動きを変えていない」事を確かめる
// ----------------------------------------------------------------------------
// 社内サーバー版の枝では src/data(保管庫の窓口)を4アプリで同じ中身に揃えた。そのため、いつものビルドの出力(dist)は
// 枝分かれの前(基点)と1バイト同じにはならない(画面の他の違いは全部ビルドの時の定数で畳み、出力で確かめた)。
// ここでは、基点の src/data(git の記録から取り出す)と、今の src/data を **同じ入力** で動かし、
//   ・Firestore の関数をどの順で・どの引数で呼んだか(偽の Firestore が全部書き留める)
//   ・返した値・画面へ渡した値
// が1つも違わない事を確かめる。入力は Firebase の時の物だけ(保存先は全部 Firebase・PocketBase の設定なし)。
//   ①いつもの入力(基点の画面が使う形): 全部同じでなければならない
//   ②新しく足した使い方(source:'server' など): 違ってよいのは「基点の画面のコードが1回も使っていない」か、
//     「基点の画面は使っていたが、今の画面はもう使っていない」(=今の画面は①の形で呼ぶので①で同じと確かめ済み)時だけ
// 基点の記録が無い取り出し(浅い clone など)では飛ばす(理由を出す)。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
// 4アプリの基点(社内サーバー版の枝を作る前の、その時の作業の枝の先)。そのリポジトリにある物だけが使われる。
const BASES = {
  'factory-overview-app': '057d01cd5487d185c01b8d403c0de94f0aaf202d',
  'product-inspection-app': '0136a5a7c5b73522500079b1c55f0f23cc04f7f6',
  'final-inspection-app': 'ad820c318a51dd92102061861a63e9cedab3d88f',
  'parts-inspection-app': 'fff526a615be5de4145f173fd675416d973b4429',
};
const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
const findBase = () => {
  for (const sha of Object.values(BASES)) { try { git('cat-file', '-e', `${sha}^{commit}`); return sha; } catch { /* このリポジトリには無い */ } }
  return null;
};
const BASE = findBase();
const APP_OF = Object.fromEntries(Object.entries(BASES).map(([k, v]) => [v, k]));
const MAIN = ['src/App.firebase.jsx', 'src/App.jsx'].find((p) => { try { statSync(join(ROOT, p)); return true; } catch { return false; } });
const HAS_PRODUCT_OPS = (() => { try { statSync(join(ROOT, 'src', 'data', 'productOps.js')); return true; } catch { return false; } })();
const fsKeysOfApp = () => {
  const src = readFileSync(join(ROOT, MAIN), 'utf8');
  const m = /^const FS_API = \{([^}]*)\};/m.exec(src);
  if (!m) return null;
  return m[1].split(',').map((x) => x.trim().split(':')[0].trim()).filter(Boolean);
};

// ---- 偽の Firestore: 呼ばれた事を全部書き留める --------------------------------------------
const ser = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'function' ? '[fn]' : x instanceof Date ? `Date(${x.toISOString()})` : x === undefined ? '[undefined]' : x)));
const mkWorld = ({ keys = null, offline = false } = {}) => {
  const log = [];
  const store = {
    'artifacts/NS/public/data/lots/a': { name: 'A', n: 1, log: [{ t: 0 }], owner: null, revision: 2 },
    'artifacts/NS/public/data/lots/b': { name: 'B', n: 2 },
    'artifacts/NS/public/data/settings/main': { theme: 'x' },
  };
  const rec = (name, ...args) => { log.push([name, ser(args)]); };
  const ref = (kind, p) => ({ __ref: kind, path: p.join('/') });
  const snapDoc = (path, fromCache = offline) => {
    const d = store[path];
    return { id: path.split('/').pop(), exists: () => d !== undefined, data: () => (d === undefined ? undefined : JSON.parse(JSON.stringify(d))), metadata: { fromCache }, ref: { path } };
  };
  const qsnap = (r, fromCache = offline) => {
    const base = r.__ref === 'query' ? r.base.path : r.path;
    const docs = Object.keys(store).filter((p) => p.startsWith(base + '/') && !p.slice(base.length + 1).includes('/')).sort().map((p) => snapDoc(p, fromCache));
    return { docs, size: docs.length, empty: !docs.length, metadata: { fromCache }, docChanges: () => [] };
  };
  const fs = {
    collection: (db, ...p) => (rec('collection', ...p), ref('col', p)),
    doc: (db, ...p) => (rec('doc', ...p), ref('doc', p)),
    where: (...a) => (rec('where', ...a), { w: a }),
    orderBy: (...a) => (rec('orderBy', ...a), { o: a }),
    limit: (n) => (rec('limit', n), { l: n }),
    startAfter: (c) => (rec('startAfter', c && c.id ? `doc:${c.id}` : c), { s: c && c.id ? c.id : c }),
    query: (base, ...parts) => (rec('query', base, ...parts), { __ref: 'query', base, parts }),
    onSnapshot: (r, ...rest) => {
      rec('onSnapshot', r, ...rest);
      const next = rest.find((x) => typeof x === 'function');
      next(r.__ref === 'doc' ? snapDoc(r.path) : qsnap(r));
      return () => rec('unsubscribe', r);
    },
    getDocs: async (q) => (rec('getDocs', q), qsnap(q)),
    getDocsFromServer: async (q) => (rec('getDocsFromServer', q), qsnap(q)),
    getDocsFromCache: async (q) => (rec('getDocsFromCache', q), qsnap(q, true)),
    getDoc: async (r) => (rec('getDoc', r), snapDoc(r.path)),
    getDocFromServer: async (r) => (rec('getDocFromServer', r), snapDoc(r.path)),
    getDocFromCache: async (r) => (rec('getDocFromCache', r), snapDoc(r.path, true)),
    getCountFromServer: async (q) => (rec('getCountFromServer', q), { data: () => ({ count: qsnap(q).size }) }),
    setDoc: async (r, d, o) => { rec('setDoc', r, d, o); },
    updateDoc: async (r, d) => { rec('updateDoc', r, d); },
    deleteDoc: async (r) => { rec('deleteDoc', r); },
    serverTimestamp: () => ({ __fv: 'serverTimestamp' }),
    deleteField: () => ({ __fv: 'deleteField' }),
    runTransaction: async (db, fn) => {
      rec('runTransaction');
      const tx = {
        get: async (r) => (rec('tx.get', r), snapDoc(r.path)),
        set: (r, d, o) => { rec('tx.set', r, d, o); return tx; },
        update: (r, d) => { rec('tx.update', r, d); return tx; },
        delete: (r) => { rec('tx.delete', r); return tx; },
      };
      return fn(tx);
    },
  };
  if (keys) for (const k of Object.keys(fs)) if (!keys.includes(k)) delete fs[k];
  const db = { app: { options: { projectId: 'demo-project' } }, _settings: {} };
  return { log, fs, db };
};

// ---- REST(項目だけ読む)用の偽の fetch ----
const withFetch = async (log, fn) => {
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    log.push(['fetch', ser([url, init && init.method, init && init.headers, init && JSON.parse(init.body)])]);
    return { ok: true, status: 200, json: async () => [{ document: { name: 'projects/demo-project/databases/(default)/documents/artifacts/NS/public/data/lots/a', fields: { name: { stringValue: 'A' }, n: { integerValue: '1' } } } }, { readTime: 'x' }] };
  };
  try { return await fn(); } finally { globalThis.fetch = saved; }
};

// ---- 1つの使い方を、基点と今の両方で動かし、書き留めた物を返す ----
const run = async (mod, ns, kase, world = {}) => {
  const { log, fs, db } = mkWorld(world);
  const p = mod.providerFor(db, fs);
  const out = [];
  const cb = (...a) => { out.push(['cb', ser(a.map((x) => (x && x.docs ? { docs: x.docs.map((d) => d.id) } : x && typeof x.exists === 'function' ? { exists: x.exists() } : x)))]); };
  let result; let error = null;
  try {
    result = await kase({ p, ns, cb, mod, log });
    if (typeof result === 'function') { result(); result = '[unsubscribe]'; }
  } catch (e) { error = String(e && e.message || e); }
  return ser({ log, out, result: result && result.cursor ? { ...result, cursor: result.cursor.id } : result, error });
};

const ROWMAP = (d) => ({ id: d.id, nm: (d.data() || {}).name });
// ①いつもの入力(Firebase の時・基点の画面が使う形)
const CORE = {
  'watchCollection 素': ({ p, ns, cb }) => p.watchCollection(ns, 'lots', cb),
  'watchCollection 絞り込み+metadata+onError+map': ({ p, ns, cb }) => p.watchCollection(ns, 'lots', cb, { where: [['n', '>=', 1]], orderBy: [['n', 'desc']], limit: 5, includeMetadataChanges: true, onError: () => {}, map: ROWMAP }),
  'watchDoc': ({ p, ns, cb }) => p.watchDoc(ns, 'settings', 'main', cb),
  'watchDoc 無い書類+metadata': ({ p, ns, cb }) => p.watchDoc(ns, 'settings', 'zzz', cb, { includeMetadataChanges: true, onError: () => {} }),
  'getAll': ({ p, ns }) => p.getAll(ns, 'lots'),
  'getAll 絞り込み': ({ p, ns }) => p.getAll(ns, 'lots', { where: [['name', '==', 'A']], orderBy: ['name'], limit: 1, map: ROWMAP }),
  'getOne 在る': ({ p, ns }) => p.getOne(ns, 'lots', 'a'),
  'getOne 無い': ({ p, ns }) => p.getOne(ns, 'lots', 'zzz'),
  'watchQuery': ({ p, ns, cb }) => p.watchQuery(ns, 'lots', { where: [['n', '==', 2]], orderBy: [['n', 'asc']], limit: 10 }, cb, { includeMetadataChanges: true, onError: () => {} }),
  'watchQuery opts なし': ({ p, ns, cb }) => p.watchQuery(ns, 'lots', { limit: 3 }, cb),
  'getPage 1枚目': ({ p, ns }) => p.getPage(ns, 'lots', { orderBy: [['__name__']], limit: 1 }),
  'getPage 続き': ({ p, ns }) => p.getPage(ns, 'lots', { orderBy: [['__name__']], limit: 1, after: { id: 'a' } }, { map: ROWMAP }),
  'getPageFields REST(== と >=・文字と数)': ({ p, ns, log }) => withFetch(log, () => p.getPageFields(ns, 'lots', ['name', 'n'], { where: [['name', '==', 'A'], ['n', '>=', 1]], getToken: async () => 'tok' })),
  'getPageFields REST(1条件)': ({ p, ns, log }) => withFetch(log, () => p.getPageFields(ns, 'lots', ['name'], { where: [['n', '<', 5]], getToken: async () => 'tok' })),
  'getPageFields 合言葉なし→全部読む': ({ p, ns }) => p.getPageFields(ns, 'lots', ['name'], { where: [['n', '==', 1]] }),
  'getPageFields 項目なし→全部読む': ({ p, ns }) => p.getPageFields(ns, 'lots', [], {}),
  'save 合わせ書き(消す印・時刻の印)': ({ p, ns, mod }) => p.save(ns, 'lots', 'a', { name: 'A2', gone: mod.DATA_DELETE, at: mod.DATA_SERVER_NOW, nested: { k: 1 } }),
  'save 上書き': ({ p, ns }) => p.save(ns, 'lots', 'c', { name: 'C' }, { merge: false }),
  'remove': ({ p, ns }) => p.remove(ns, 'lots', 'b'),
  'setFields': ({ p, ns, mod }) => p.setFields(ns, 'lots', 'a', { 'x.y': 1, at: mod.DATA_SERVER_NOW, gone: mod.DATA_DELETE }),
  'claimOnce 取れる': ({ p, ns }) => p.claimOnce(ns, 'lots', 'a', { owner: null }, { owner: 'me' }),
  'claimOnce 取られている': ({ p, ns }) => p.claimOnce(ns, 'lots', 'a', { owner: 'other' }, { owner: 'me' }),
  'claimOnce 無い': ({ p, ns }) => p.claimOnce(ns, 'lots', 'zzz', { owner: null }, { owner: 'me' }),
  'appendCapped 足す': ({ p, ns }) => p.appendCapped(ns, 'lots', 'a', 'log', { t: 1 }),
  'appendCapped 上限で古い物を落とす': ({ p, ns }) => p.appendCapped(ns, 'lots', 'a', 'log', { t: 2, pad: 'x'.repeat(40) }, { maxBytes: 60 }),
  'appendCapped 無い書類(既定の形)': ({ p, ns }) => p.appendCapped(ns, 'lots', 'zzz', 'log', { t: 3 }, { fallback: { kind: 'k' } }),
  'commitVersion 進む': ({ p, ns }) => p.commitVersion && p.commitVersion(ns, { headCol: 'lots', headId: 'a', versionCol: 'settings', versionId: 'v3', expectRevision: 2, versionDoc: { v: 3 }, headDoc: { revision: 3 }, preserveOld: (cur) => ({ col: 'settings', id: 'old', doc: { was: cur.revision } }), chunks: [{ id: 'c1', doc: { part: 1 } }] }),
  'commitVersion 古い': ({ p, ns }) => p.commitVersion && p.commitVersion(ns, { headCol: 'lots', headId: 'a', versionCol: 'settings', versionId: 'v3', expectRevision: 1, versionDoc: { v: 3 }, headDoc: { revision: 3 } }),
  'createOnce 無い→作る': ({ p, ns }) => p.createOnce && p.createOnce(ns, 'lots', 'new1', { name: 'N' }),
  'createOnce 在る': ({ p, ns }) => p.createOnce && p.createOnce(ns, 'lots', 'a', { name: 'N' }),
  'applyWithMark': ({ p, ns }) => p.applyWithMark && p.applyWithMark(ns, 'settings', 'main', { done: (cur) => !!(cur && cur.done), markPatch: { done: true }, targetCol: 'lots', targetId: 'a', targetPatch: { n: 9 } }),
  'countQuery': ({ p, ns }) => p.countQuery && p.countQuery(ns, 'lots', { where: [['n', '>=', 0]] }),
  'getCachedDocs': ({ p, ns }) => p.getCachedDocs && p.getCachedDocs(ns, 'lots', { limit: 5 }),
  'refreshDocFromServer': ({ p, ns }) => p.refreshDocFromServer && p.refreshDocFromServer(ns, 'lots', 'a'),
  'routeOf・capabilitiesOf': ({ p, ns }) => [p.routeOf(ns, 'lots'), p.capabilitiesOf(ns, 'lots')],
};
// ②新しく足した使い方。違ってよいのは、基点の画面のコードが使っていない時だけ(使っていれば①と同じく同じでなければならない)。
const near = (method, re) => (code) => {
  const lines = code.split('\n');
  // 製品だけ: OPS(db) と Q(= OPS(db)) の watchQuery・getPage は productOps.js(基点から1バイトも変えていない)が
  //   Firebase の時は自分で読む(窓口のその口を通らない・productOps.js の b.kind !== 'firebase' の所)ので数えない。
  const viaOps = (l) => HAS_PRODUCT_OPS && ['watchQuery', 'getPage'].includes(method) && (l.includes('OPS(') || l.includes('Q.' + method + '('));
  // 注釈の行(// や * で始まる行)は数えない(説明の文に source:'cache' と書いてあるだけの所を拾わない)
  const isNote = (x) => /^\s*(\/\/|\*|\/\*)/.test(x);
  return lines.some((l, i) => !isNote(l) && l.includes('.' + method + '(') && !viaOps(l)
    && re.test(lines.slice(i, i + 40).filter((x) => !isNote(x)).join('\n')));
};
const EXTRA = {
  "getOne source:'server'": { use: near('getOne', /source:\s*'server'/), call: ({ p, ns }) => p.getOne(ns, 'lots', 'a', { source: 'server' }) },
  "getOne source:'cache'": { use: near('getOne', /source:\s*'cache'/), call: ({ p, ns }) => p.getOne(ns, 'lots', 'a', { source: 'cache' }) },
  "watchQuery source:'cache'": { use: near('watchQuery', /source:\s*'cache'/), call: ({ p, ns, cb }) => p.watchQuery(ns, 'lots', { limit: 2 }, cb, { source: 'cache', includeMetadataChanges: true }) },
  "watchCollection source:'cache'": { use: near('watchCollection', /source:\s*'cache'/), call: ({ p, ns, cb }) => p.watchCollection(ns, 'lots', cb, { source: 'cache', where: [['n', '>=', 0]] }) },
  "getPage source:'server'": { use: near('getPage', /source:\s*'server'/), call: ({ p, ns }) => p.getPage(ns, 'lots', { limit: 1 }, { source: 'server' }) },
  'appendCapped expectLength': { use: (code) => code.includes('expectLength') && code.includes('.appendCapped('), call: ({ p, ns }) => p.appendCapped(ns, 'lots', 'a', 'log', { t: 4 }, { expectLength: 5 }) },
  'getPageFields 並び・件数(REST)': { use: near('getPageFields', /orderBy|limit:/), call: ({ p, ns, log }) => withFetch(log, () => p.getPageFields(ns, 'lots', ['name'], { orderBy: [['__name__']], limit: 2, after: 'a', getToken: async () => 'tok' })) },
  'getPageFields 日付の条件(REST)': { use: near('getPageFields', /new Date|Date\(/), call: ({ p, ns, log }) => withFetch(log, () => p.getPageFields(ns, 'lots', ['name'], { where: [['at', '>=', new Date('2026-10-01T00:00:00Z')]], getToken: async () => 'tok' })) },
};
// ②のうち「基点の画面も今の画面も使っていて、動きが変わる」と分かっている物(アプリごと)。ここに無い違いが出たら落ちる。
//   中身と理由は docs/設計書_情報課_2026-10-29/20_セキュリティ評価報告書_社内サーバー版_2026-10-30.md の R2 の節。
const KNOWN = {
  'factory-overview-app': [],
  'product-inspection-app': [],
  'final-inspection-app': [],
  // 部品: 2026-10-31 清水さんの決定(2)「サーバから読めない時は、前と同じく端末の控えを出す」で、
  //   App.jsx の readHead・readReview・readHeadOf・readRoute は { source: 'server' } を渡すのをやめた(基点の部品の窓口は
  //   source を見ずに getDoc で読んでいた)。今の画面の呼び方は①の「getOne 在る/無い」と同じ入力 = 控えしか無い時も基点と同じ。
  //   ⚠ 揃えた窓口の getOne(source:'server') の動き(getDocFromServer)は製品・最終が基点の時点で既に持っていた物のまま。
  'parts-inspection-app': [],
};

// 基点の画面のコード(src の下で、src/data と試験を除く)
const isScreenFile = (f) => /\.(jsx?|mjs)$/.test(f) && !f.startsWith('src/data/') && !f.includes('__tests__') && !/\.test\.m?js$/.test(f);
const baseScreenCode = () => {
  const files = git('ls-tree', '-r', '--name-only', BASE, 'src').split('\n').filter(isScreenFile);
  return files.map((f) => git('show', `${BASE}:${f}`)).join('\n');
};
// 今の画面のコード(作業中のファイル・同じ決まりで選ぶ)
const nowScreenCode = () => {
  const files = git('ls-files', '-co', '--exclude-standard', 'src').split('\n').filter(isScreenFile);
  return files.map((f) => { try { return readFileSync(join(ROOT, f), 'utf8'); } catch { return ''; } }).join('\n');
};

test('R2-EQ 基点の src/data と今の src/data は、Firebase の時の入力で同じ動きをする', { skip: !BASE && '基点の記録がこのリポジトリに無い(浅い clone など)' }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'r2eq-'));
  try {
    // 基点の src/data を取り出す(中で読み合う相対の import がそのまま効くよう、同じ並びで置く)
    const oldFiles = git('ls-tree', '--name-only', `${BASE}:src/data`).split('\n').filter((f) => f.endsWith('.js'));
    for (const f of oldFiles) writeFileSync(join(tmp, f), git('show', `${BASE}:src/data/${f}`));
    const OLD = await import(pathToFileURL(join(tmp, 'provider.js')).href);
    const NEW = await import(pathToFileURL(join(ROOT, 'src', 'data', 'provider.js')).href);
    const nsOld = 'NS'; // dataPath は ns をそのまま使う(偽の書類の置き場所と合わせる)
    let checked = 0, calls = 0, errors = 0;
    const skipped = [], stripped = [];
    const keys = fsKeysOfApp();
    assert.ok(keys && keys.length >= 10, `${MAIN} の FS_API が読めない`);
    const WORLDS = [{ keys, offline: false }, { keys, offline: true }];
    const oldApi = OLD.providerFor(mkWorld().db, mkWorld().fs);
    const OPTIONAL = ['commitVersion', 'createOnce', 'applyWithMark', 'countQuery', 'getCachedDocs', 'refreshDocFromServer'];
    for (const [name, kase] of Object.entries(CORE)) {
      const needs = OPTIONAL.find((m) => name.startsWith(m));
      // 基点に無い口は、基点の画面からは呼べない(呼べば undefined で落ちる)ので比べない
      if (needs && typeof oldApi[needs] !== 'function') { skipped.push(needs); continue; }
      for (const world of WORLDS) {
      const a = await run(OLD, nsOld, kase, world), b = await run(NEW, nsOld, kase, world);
      // getPage の答えに足した鍵 fromCache(控えからの答えか)だけは、基点に無ければ外して比べる。
      //   その代わり、基点の画面が窓口(DATA)の getPage の答えの fromCache を読んでいない事を下で確かめる。
      if (/^getPage /.test(name) && a.result && typeof a.result === 'object' && b.result && typeof b.result === 'object' && !('fromCache' in a.result) && 'fromCache' in b.result) {
        const { fromCache, ...rest } = b.result; b.result = rest; stripped.push(`${name}(fromCache=${fromCache})`);
      }
      assert.deepEqual(b, a, `①いつもの入力「${name}」(${world.offline ? '控えしか無い時' : 'つながっている時'})で、基点と今の動きが違う`);
      checked++; calls += a.log.length; if (a.error) errors++;
      }
    }
    // 見張りの見張り: この比べ方が違いを見分けられる事(在る/無い の答えは違うはず・Firestore を呼んでいる事)
    const yes = await run(NEW, nsOld, CORE['getOne 在る']), no = await run(NEW, nsOld, CORE['getOne 無い']);
    assert.notDeepEqual(yes, no, '比べ方が違いを見分けられない');
    assert.ok(calls > 50, `偽の Firestore が呼ばれていない(${calls} 回)`);
    const screen = baseScreenCode();
    if (stripped.length) {
      // 窓口(DATA(…))の getPage を呼ぶ所の前後 12 行に fromCache が出てこない事(=足した鍵を読む画面が無い)
      const lines = screen.split('\n'); const hits = [];
      lines.forEach((l, i) => { if (/DATA\([^)]*\)\.getPage\(/.test(l) && lines.slice(i, i + 12).join('\n').includes('fromCache')) hits.push(l.trim().slice(0, 80)); });
      assert.deepEqual(hits, [], '基点の画面が窓口の getPage の答えの fromCache を読んでいる(足した鍵で動きが変わる)');
    }
    const extra = [];
    const usedAndDiffer = [];
    const now = nowScreenCode();
    // getPage の答えの fromCache は①と同じ扱い(基点に無ければ外して比べる・読む画面が無い事は上で確かめた)
    const dropAdded = (name, a, b) => {
      if (/^getPage /.test(name) && a.result && typeof a.result === 'object' && b.result && typeof b.result === 'object' && !('fromCache' in a.result) && 'fromCache' in b.result) {
        const { fromCache, ...rest } = b.result; return { ...b, result: rest };
      }
      return b;
    };
    for (const [name, { use, call }] of Object.entries(EXTRA)) {
      const how = [];
      for (const world of WORLDS) {
        const a = await run(OLD, nsOld, call, world), b = dropAdded(name, a, await run(NEW, nsOld, call, world));
        const same = JSON.stringify(a) === JSON.stringify(b);
        how.push(`${world.offline ? '控え' : 'つながり'}=${same ? '同じ' : '違う'}`);
        if (!same) {
          // 落とすのは「基点の画面が使っていて、今の画面もまだ使っている」時(今の画面がやめた使い方は、今は呼ばれない)
          const used = use(screen) && use(now);
          if (used && !usedAndDiffer.includes(name)) usedAndDiffer.push(name);
        }
      }
      extra.push(`${name}: ${how.join('・')}${use(screen) ? '(基点の画面が使う)' : '(基点の画面は使わない)'}${use(screen) && !use(now) ? '(今の画面は使わない)' : ''}`);
    }
    console.log(`[R2-EQ] ②で基点の画面も今の画面も使っていて動きが変わる物: [${usedAndDiffer.join(', ')}]`);
    assert.deepEqual(usedAndDiffer, KNOWN[APP_OF[BASE]], '②: 基点の画面が使っている使い方で、知らない動きの違いがある');
    console.log(`[R2-EQ] 基点 ${BASE.slice(0, 7)}: ①いつもの入力 ${checked} 通り 全部同じ(Firestore の呼び出し ${calls} 回・失敗で終わる使い方 ${errors} 通り・基点に無い口 [${[...new Set(skipped)].join(', ')}]・外して比べた鍵 [${stripped.join(', ')}]) / ② ${extra.join(' / ')}`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ============================================================================
// D3(清水さんの決定 2026-10-30「いつものビルドは保存先が必ず Firebase」)で消した「保存先の切替」も、
// Firebase の時の入力(共有の設定に pocketbase が無い・enabled が true でない・接続先が無い / 端末の記憶 data.route.v1 が無い)では
// 基点も今も「全部 Firebase・PocketBase の接続なし」で同じ事を確かめる。
//   基点の切替は「providersFromSettings(設定) が DEFAULT_PROVIDERS 以外を返した時だけ」切り替わる作り(画面の本体の中)。
// ============================================================================
test('R2-D3 Firebase の時の入力では、基点の保存先の切替も今の行き先も全部 Firebase', { skip: !BASE && '基点の記録がこのリポジトリに無い' }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'r2d3-'));
  try {
    const oldFiles = git('ls-tree', '--name-only', `${BASE}:src/data`).split('\n').filter((f) => f.endsWith('.js'));
    for (const f of oldFiles) writeFileSync(join(tmp, f), git('show', `${BASE}:src/data/${f}`));
    const OLDR = await import(pathToFileURL(join(tmp, 'routes.js')).href);
    const INPUTS = [undefined, null, {}, { enabled: false }, { enabled: false, url: 'http://x' }, { enabled: true }, { enabled: 'true', url: 'http://x' }];
    let n = 0;
    if (typeof OLDR.providersFromSettings === 'function') {
      for (const x of INPUTS) { assert.deepEqual(OLDR.providersFromSettings(x), OLDR.DEFAULT_PROVIDERS, `基点: ${JSON.stringify(x)} で Firebase 以外を選んだ`); n++; }
    }
    // 今: 行き先の入口(src/dataRoute.js)があるアプリは、いつものビルド(試験の中)で全部 Firebase・接続なし
    let now = 'なし';
    try {
      statSync(join(ROOT, 'src', 'dataRoute.js'));
      const R = await import(pathToFileURL(join(ROOT, 'src', 'dataRoute.js')).href);
      const NEWR = await import(pathToFileURL(join(ROOT, 'src', 'data', 'routes.js')).href);
      if (R.__resetDataRouteForTest) R.__resetDataRouteForTest();
      const prov = typeof R.currentProviders === 'function' ? R.currentProviders() : null;
      assert.deepEqual(prov, NEWR.DEFAULT_PROVIDERS, '今: いつものビルドの行き先が全部 Firebase でない');
      assert.deepEqual(NEWR.DEFAULT_PROVIDERS, OLDR.DEFAULT_PROVIDERS, '「全部 Firebase」の中身が基点と違う');
      if (typeof R.currentPbConfig === 'function') assert.equal(R.currentPbConfig(), null);
      now = '全部 Firebase';
    } catch (e) { if (e && e.code !== 'ENOENT') throw e; }
    console.log(`[R2-D3] 基点 ${BASE.slice(0, 7)}: 基点の切替は Firebase の時の入力 ${n} 通りで全部 Firebase / 今の行き先: ${now}`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
