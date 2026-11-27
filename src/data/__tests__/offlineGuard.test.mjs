// 目的: 端末の未送信を守る A1〜A3(保存を消さないよう頼む・古い未送信の古さ・ファイルへ書き出し)の動きを固定する(設計 §4.3・T20)。
// 入力: src/offline/offlineGuard.js と src/offline/onpremOffline.js(字)・偽の navigator / indexedDB / document。
// 出力: node --test の合否。
// 呼ぶ人: npm test / npm run check(社内版の4アプリで同じ中身)。
// 触る外の物: 無し(本物の IndexedDB・ブラウザ・サーバーは使わない)。
// 確かめ方: persist を頼む行・oldestInfo・buildExport・onpremOffline からの呼び出しを外すとそれぞれ赤になる。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestPersist, oldestInfo, buildExport, readOutboxRows, downloadExport, startOfflineGuard, EXPORT_FORMAT, OLD_WARN_MS, PERSIST_DENIED_TEXT } from '../../offline/offlineGuard.js';

const ROWS = [
  { commandId: 'a', status: 'pending', createdAt: 1000, payload: { x: 1 } },
  { commandId: 'b', status: 'failed', createdAt: 500, payload: { y: [1, 2] } },
  { commandId: 'c', status: 'conflict', createdAt: 2000, payload: null },
];
const fakeIdb = (rows, { hasStore = true } = {}) => ({
  open: () => {
    const req = {};
    const openCursor = () => {
      const g = {}; let i = 0;
      const step = () => setTimeout(() => { g.result = i < rows.length ? { value: rows[i], continue() { i += 1; step(); } } : null; g.onsuccess(); }, 0);
      step();
      return g;
    };
    setTimeout(() => {
      req.result = { objectStoreNames: { contains: () => hasStore }, close() {}, transaction: () => ({ objectStore: () => ({ openCursor }) }) };
      req.onsuccess();
    }, 0);
    return req;
  },
});

test('GU1 A1: 起動の時に persist() を頼む(頼まない・断られた結果が見えないと赤)', async () => {
  let asked = 0;
  assert.equal(await requestPersist({ storage: { persisted: async () => false, persist: async () => { asked += 1; return true; } } }), 'granted');
  assert.equal(asked, 1);
  assert.equal(await requestPersist({ storage: { persisted: async () => false, persist: async () => false } }), 'denied');
  assert.equal(await requestPersist({ storage: { persisted: async () => true, persist: async () => { asked += 1; return true; } } }), 'granted');
  assert.equal(asked, 1, 'もう守られている時は頼み直さない');
  assert.equal(await requestPersist({}), 'unsupported');
  assert.equal(await requestPersist({ storage: { persist: async () => { throw new Error('x'); } } }), 'unsupported');
});

test('GU2 A2: いちばん古い未送信の古さ(○時間前)・24時間を超えたら warn', () => {
  const now = 10 * 3600 * 1000;
  const o = oldestInfo([{ createdAt: now - 3 * 3600 * 1000 }, { createdAt: now - 1000 }], now);
  assert.equal(o.hours, 3); assert.equal(o.text, 'いちばん古い未送信: 3 時間前'); assert.equal(o.warn, false);
  assert.equal(oldestInfo([{ createdAt: 0 }], OLD_WARN_MS).warn, false);
  assert.equal(oldestInfo([{ createdAt: 0 }], OLD_WARN_MS + 1).warn, true);
  assert.equal(oldestInfo([{ createdAt: now - 5 * 60000 }], now).text, 'いちばん古い未送信: 5 分前');
  assert.deepEqual(oldestInfo([], now), { oldestAt: null, ageMs: 0, hours: 0, warn: false, text: '' });
});

test('GU3 A3: 書き出した JSON は箱の中身と同じ(行を1つも変えず・減らさない)', () => {
  const j = JSON.parse(buildExport(ROWS, Date.parse('2026-11-28T00:00:00Z'), 'product'));
  assert.equal(j.format, EXPORT_FORMAT); assert.equal(j.count, 3); assert.equal(j.app, 'product');
  assert.deepEqual(j.commands, ROWS);
  assert.equal(j.exportedAt, '2026-11-28T00:00:00.000Z');
});

test('GU4 箱の全行を読む(読むだけ・箱が無ければ作らず空・開けなければ null)', async () => {
  assert.deepEqual(await readOutboxRows({ idb: fakeIdb(ROWS) }), ROWS);
  assert.deepEqual(await readOutboxRows({ idb: fakeIdb([], { hasStore: false }) }), []);
  assert.equal(await readOutboxRows({ idb: null }), null);
});

test('GU5 A3: ファイルとして保存する(a[download]・JSON の型・名前に日時)', () => {
  const made = []; let clicked = 0; let blobText = null; let blobType = null;
  const doc = { body: { appendChild() {} }, createElement: () => { const a = { click() { clicked += 1; }, remove() {} }; made.push(a); return a; } };
  const win = { URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, Blob: class { constructor(p, o) { blobText = p[0]; blobType = o.type; } } };
  const name = downloadExport('{"a":1}', { doc, win, now: Date.parse('2026-11-28T01:02:03Z') });
  assert.equal(clicked, 1); assert.equal(made[0].download, name); assert.match(name, /^未送信_20261128010203\.json$/);
  assert.equal(blobText, '{"a":1}'); assert.equal(blobType, 'application/json');
});

const fakeDom = () => {
  const mk = () => { const e = { attrs: {}, style: {}, children: [], listeners: {}, textContent: '',
    setAttribute(k, v) { e.attrs[k] = v; }, appendChild(c) { e.children.push(c); }, addEventListener(t, f) { e.listeners[t] = f; }, remove() {} }; return e; };
  const doc = { body: mk(), createElement: mk };
  return { doc, win: { __offlineGuardInstalled: false } };
};
// 条件が整うまで待つ(重い PC でも遅れで落ちない)。⚠札の定期読みの timer が残ると node --test が終わらないので、各試験は必ず stop() する。
const waitFor = async (cond, ms = 3000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 5)); };

test('GU6 札: 断られたら「保存が守られていません」・古い未送信があれば古さと書き出しボタン(24時間超は warn)', async () => {
  const { doc, win } = fakeDom();
  const old = Date.now() - 30 * 3600 * 1000;
  const stop = startOfflineGuard({ doc, win, idb: fakeIdb([{ commandId: 'z', status: 'pending', createdAt: old }]), nav: { storage: { persist: async () => false } }, everyMs: 1e9 });
  try {
    const el = doc.body.children[0];
    await waitFor(() => el.attrs['data-persist'] === 'denied' && el.attrs['data-warn'] === '1');
    assert.equal(el.attrs['data-persist'], 'denied'); assert.equal(el.attrs['data-warn'], '1');
    assert.equal(el.style.display, 'block');
    const [msg, btn] = el.children;
    assert.ok(msg.textContent.includes(PERSIST_DENIED_TEXT)); assert.match(msg.textContent, /いちばん古い未送信: 30 時間前/);
    assert.equal(btn.style.display, 'block');
  } finally { stop(); }
});

test('GU7 札: 守られていて未送信が無ければ何も出さない', async () => {
  const { doc, win } = fakeDom();
  const stop = startOfflineGuard({ doc, win, idb: fakeIdb([]), nav: { storage: { persisted: async () => true, persist: async () => true } }, everyMs: 1e9 });
  try {
    const el = doc.body.children[0];
    await waitFor(() => el.attrs['data-persist'] === 'granted');
    assert.equal(el.attrs['data-persist'], 'granted');
    assert.equal(el.style.display, 'none');
  } finally { stop(); }
});

test('GU8 社内版の起動(onpremOffline.js)が startOfflineGuard を呼ぶ(つなぎ忘れると赤)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', '..', 'offline', 'onpremOffline.js'), 'utf8');
  assert.match(src, /import \{ startOfflineGuard \} from '\.\/offlineGuard\.js'/);
  assert.match(src, /startOfflineGuard\(\)/);
});
