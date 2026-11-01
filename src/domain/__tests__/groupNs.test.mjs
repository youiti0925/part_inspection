// 実行: node --test src/domain/__tests__/groupNs.test.mjs   (最終・製品・部品の3アプリで同じ中身)
// 🏯 2026-11-01 最上位の司令塔 段2: アプリが `group`(入口が口ごとに足す)から名前空間を決める部分の試験
//   N01 group が無い口(今の4つ)は今の名前のまま
//   N02 group の形が悪い時は bad(今の名前へ落とさない): 種類違い・ns が <種類>-g-<key>-v1 でない・invalid の印・key/state の形
//   N03 同期の読み: 200 + group → ok / 200 + group 無し → none / 404 → none(開発用) / 500・ネットワークの失敗・壊れた JSON → bad(止める)
//   N04 resolveAppNs: ok → グループの ns / none → 今の名前 / bad → 止める画面を出して投げる(起動しない)
//   N05 2つの最終検査系グループの名前空間は互いに・元の最終とも違う(ロットが混ざらない根)
//   N06 共有の棚(capacity)はグループ自身の名前空間の中に置く(元の 'final' の書類を上書きしない)
//   N07 boot の突き合わせ(assertGroupMatches / verifyGroupAsync): 起動の最初と違えば止める
//   N08 配線(ソースを読む): APP_DATA_ID は社内版でだけ resolveAppNs・いつものビルドは今の字面のまま・DATA_NS の共有の棚もグループ対応
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseGroup, readGroupSync, earlyGroup, _resetEarlyGroup, resolveAppNs, withGroupCapacity, archivedGroupOf, assertGroupMatches, verifyGroupAsync, showArchivedBand, stopMessage, INVALID_NS,
} from '../../onprem/groupNs.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const IS_FINAL = fs.existsSync(path.join(SRC, 'App.firebase.jsx'));
const TYPE = IS_FINAL ? 'final' : (fs.readFileSync(path.join(SRC, 'App.jsx'), 'utf8').includes('"product-inspection-v1"') ? 'product' : 'parts');
const DEFAULT_NS = { final: 'final-inspection-v1', product: 'product-inspection-v1', parts: 'parts-inspection-v1' }[TYPE];
const okRaw = (o = {}) => ({ url: '', group: { key: 'machine_a', type: TYPE, ns: `${TYPE}-g-machine_a-v1`, commander: 'machine', state: 'active', ...o } });
const xhr = (status, body, { throws = false } = {}) => () => ({ open() {}, send() { if (throws) throw new Error('net'); }, status, responseText: typeof body === 'string' ? body : JSON.stringify(body) });
const BASE = 'https://kensa.local:8445/';

test('N01 group が無い口は今の名前のまま', () => {
  for (const raw of [null, {}, { url: '', appUrls: {} }, { group: undefined }, 'x', []]) assert.deepEqual(parseGroup(raw, TYPE), { state: 'none' }, JSON.stringify(raw));
});

test('N02 group の形が悪い時は bad(今の名前へ落とさない)', () => {
  const other = TYPE === 'final' ? 'product' : 'final';
  const bads = [
    okRaw({ type: other, ns: `${other}-g-machine_a-v1` }),   // このアプリと違う種類のアプリで開いた
    okRaw({ ns: DEFAULT_NS }),                                // 🔒 今の棚を指す
    okRaw({ ns: `${TYPE}-g-other-v1` }), okRaw({ type: 'overview', ns: 'overview-g-machine_a-v1' }), okRaw({ key: 'a b', ns: `${TYPE}-g-a b-v1` }), okRaw({ key: '', ns: `${TYPE}-g--v1` }),
    okRaw({ commander: 'a b' }), okRaw({ state: 'gone' }), { group: { invalid: true } }, { group: null }, { group: 'x' }, { group: [] }, { group: {} },
  ];
  for (const raw of bads) { const r = parseGroup(raw, TYPE); assert.equal(r.state, 'bad', JSON.stringify(raw)); assert.ok(r.reason); }
  const ok = parseGroup(okRaw(), TYPE);
  assert.equal(ok.state, 'ok'); assert.equal(ok.group.ns, `${TYPE}-g-machine_a-v1`); assert.equal(ok.group.state, 'active');
  assert.equal(parseGroup(okRaw({ state: undefined }), TYPE).group.state, 'active');
  assert.equal(parseGroup(okRaw({ state: 'archived' }), TYPE).group.state, 'archived');
});

test('N03 同期の読み', () => {
  assert.equal(readGroupSync(TYPE, { xhrFactory: xhr(200, okRaw()), baseUrl: BASE }).state, 'ok');
  assert.equal(readGroupSync(TYPE, { xhrFactory: xhr(200, { url: '' }), baseUrl: BASE }).state, 'none');
  assert.equal(readGroupSync(TYPE, { xhrFactory: xhr(404, ''), baseUrl: BASE }).state, 'none', '設定ファイルが無い(開発用)');
  for (const f of [xhr(500, ''), xhr(503, ''), xhr(0, ''), xhr(200, '{ not json'), xhr(200, '', { throws: true }), xhr(200, { group: { invalid: true } })]) {
    const r = readGroupSync(TYPE, { xhrFactory: f, baseUrl: BASE });
    assert.equal(r.state, 'bad', '読めない/壊れた時は今の棚へ落とさず止める');
  }
  assert.equal(readGroupSync(TYPE, { baseUrl: BASE }).state, 'none', 'XHR が無い所(node の試験)');
  assert.equal(readGroupSync(TYPE, { xhrFactory: xhr(200, okRaw()) }).state, 'none', '画面の場所が分からない所');
  let asked = ''; readGroupSync(TYPE, { xhrFactory: () => ({ open(m, u, a) { asked = `${m} ${u} ${a}`; }, send() {}, status: 404, responseText: '' }), baseUrl: 'https://kensa.local:8445/final/?renraku=1#x' });
  assert.equal(asked, 'GET https://kensa.local:8445/final/onprem-config.json false', '同じ口・index.html の隣の設定を同期で読む');
});

const fakeDoc = () => {
  const root = { children: [], innerHTML: 'x', appendChild(c) { this.children.push(c); } };
  const doc = { getElementById: () => root, body: root, createElement: () => ({ style: {}, setAttribute(k, v) { this[k] = v; } }) };
  return { doc, root };
};

test('N04 resolveAppNs: ok → グループの ns / none → 今の名前 / bad → 止める画面を出して投げる', () => {
  _resetEarlyGroup();
  assert.equal(resolveAppNs(DEFAULT_NS, TYPE, { xhrFactory: xhr(200, okRaw()), baseUrl: BASE }), `${TYPE}-g-machine_a-v1`);
  _resetEarlyGroup();
  assert.equal(resolveAppNs(DEFAULT_NS, TYPE, { xhrFactory: xhr(200, {}), baseUrl: BASE }), DEFAULT_NS);
  _resetEarlyGroup();
  const { doc, root } = fakeDoc();
  const prev = globalThis.document; globalThis.document = doc;
  try {
    assert.throws(() => resolveAppNs(DEFAULT_NS, TYPE, { xhrFactory: xhr(200, okRaw({ ns: DEFAULT_NS })), baseUrl: BASE }), /グループの設定が正しくありません/);
    assert.equal(root.children.length, 1, '止める画面を出した'); assert.match(root.children[0].textContent, /データには何も書いていません/);
    assert.equal(root.children[0]['data-group-stop'], '1');
  } finally { globalThis.document = prev; }
  assert.match(stopMessage('理由X'), /理由: 理由X/);
  assert.equal(INVALID_NS, '__group_invalid__');
  _resetEarlyGroup();
  assert.equal(earlyGroup(TYPE, { xhrFactory: xhr(200, okRaw()), baseUrl: BASE }).state, 'ok');
  assert.equal(earlyGroup(TYPE, { xhrFactory: xhr(500, ''), baseUrl: BASE }).state, 'ok', '最初の1回の結果を覚える(途中で変わらない)');
  _resetEarlyGroup();
});

test('N05 2つの同じ種類のグループの名前空間は互いに・元の棚とも違う', () => {
  _resetEarlyGroup();
  const a = resolveAppNs(DEFAULT_NS, TYPE, { xhrFactory: xhr(200, okRaw({ key: 'ma', ns: `${TYPE}-g-ma-v1` })), baseUrl: BASE });
  _resetEarlyGroup();
  const b = resolveAppNs(DEFAULT_NS, TYPE, { xhrFactory: xhr(200, okRaw({ key: 'mb', ns: `${TYPE}-g-mb-v1` })), baseUrl: BASE });
  _resetEarlyGroup();
  assert.notEqual(a, b); assert.notEqual(a, DEFAULT_NS); assert.notEqual(b, DEFAULT_NS);
});

test('N06 共有の棚はグループ自身の名前空間の中(元の書類を上書きしない)', () => {
  const NSMAP = { capacity: 'capacity-shared-v1', contact: 'contact-shared-v1', goals: 'goal-shared-v1' };
  _resetEarlyGroup();
  assert.deepEqual(withGroupCapacity(NSMAP, TYPE, { xhrFactory: xhr(200, okRaw()), baseUrl: BASE }), { ...NSMAP, capacity: `${TYPE}-g-machine_a-v1` }, '連絡・目標の棚は工場で1つのまま');
  _resetEarlyGroup();
  assert.strictEqual(withGroupCapacity(NSMAP, TYPE, { xhrFactory: xhr(200, {}), baseUrl: BASE }), NSMAP, '今の口は同じ物');
  _resetEarlyGroup();
  assert.strictEqual(withGroupCapacity(NSMAP, TYPE, { xhrFactory: xhr(200, okRaw({ ns: DEFAULT_NS })), baseUrl: BASE }), NSMAP, 'bad の時は何も変えない(App の名前空間の側が投げて止める)');
  _resetEarlyGroup();
  assert.equal(archivedGroupOf(TYPE, { xhrFactory: xhr(200, okRaw({ state: 'archived' })), baseUrl: BASE }).key, 'machine_a');
  _resetEarlyGroup();
  assert.equal(archivedGroupOf(TYPE, { xhrFactory: xhr(200, okRaw()), baseUrl: BASE }), null);
  _resetEarlyGroup();
});

test('N07 boot の突き合わせ', async () => {
  _resetEarlyGroup();
  const opts = { xhrFactory: xhr(200, okRaw()), baseUrl: BASE };
  assert.deepEqual(assertGroupMatches(okRaw(), TYPE, opts), { ok: true, reason: '' });
  assert.equal(assertGroupMatches(okRaw({ key: 'mb', ns: `${TYPE}-g-mb-v1` }), TYPE, opts).ok, false, '途中で別のグループに変わった');
  assert.equal(assertGroupMatches({}, TYPE, opts).ok, false, '途中で group が消えた(今の棚へ落ちる)');
  assert.equal(assertGroupMatches(okRaw({ ns: DEFAULT_NS }), TYPE, opts).ok, false, '形が悪い');
  _resetEarlyGroup();
  const none = { xhrFactory: xhr(200, {}), baseUrl: BASE };
  assert.equal(assertGroupMatches({}, TYPE, none).ok, true);
  assert.equal(assertGroupMatches(okRaw(), TYPE, none).ok, false, '途中で group が現れた');
  _resetEarlyGroup();
  const good = await verifyGroupAsync(TYPE, { baseUrl: BASE, opts, fetchImpl: async () => ({ ok: true, status: 200, json: async () => okRaw() }) });
  assert.equal(good.ok, true);
  const neterr = await verifyGroupAsync(TYPE, { baseUrl: BASE, opts, fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(neterr.ok, false); assert.match(neterr.reason, /読めません/);
  const five = await verifyGroupAsync(TYPE, { baseUrl: BASE, opts, fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) }) });
  assert.equal(five.ok, false);
  _resetEarlyGroup();
  const nf = await verifyGroupAsync(TYPE, { baseUrl: BASE, opts: none, fetchImpl: async () => ({ ok: false, status: 404 }) });
  assert.equal(nf.ok, true, '設定ファイルが無い(404)は最初も無ければ一致');
  _resetEarlyGroup();
  const el = showArchivedBand(fakeDoc().doc, { key: 'machine_a' });
  assert.match(el.textContent, /しまってあります/); assert.equal(el['data-archived-band'], '1');
});

test('N08 配線(ソースを読む)', () => {
  const file = IS_FINAL ? 'App.firebase.jsx' : 'App.jsx';
  const app = fs.readFileSync(path.join(SRC, file), 'utf8');
  const ns = { final: 'final-inspection-v1', product: 'product-inspection-v1', parts: 'parts-inspection-v1' }[TYPE];
  const cond = IS_FINAL ? '__ONPREM__' : (TYPE === 'product' ? 'ONPREM_BUILD' : 'IS_ONPREM_BUILD');
  assert.ok(app.includes(`const APP_DATA_ID = ${cond} ? resolveAppNs("${ns}", "${TYPE}") : "${ns}";`), '社内版でだけグループの名前空間・いつものビルドは今の字面');
  assert.match(app, /import \{ resolveAppNs, withGroupCapacity \} from '\.\/onprem\/groupNs\.js';/);
  if (TYPE !== 'parts') assert.match(app, new RegExp(`const DATA_NS = ${cond} \\? withGroupCapacity\\(DATA_NS_BASE, '${TYPE}'\\) : DATA_NS_BASE;`));
  else assert.match(app, /OPSIM_SHELF_NS = IS_ONPREM_BUILD \? withGroupCapacity\(\{ capacity: 'capacity-shared-v1' \}, 'parts'\)\.capacity : 'capacity-shared-v1';/);
  // 今の名前への「落とし先」を作っていない: resolveAppNs 以外で APP_DATA_ID に名前を入れる行が無い
  assert.equal((app.match(/const APP_DATA_ID =/g) || []).length, 1);
  const gs = fs.readFileSync(path.join(SRC, 'onprem', 'groupNs.js'), 'utf8');
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(gs.replace(/\/\/.*$/gm, '')), '前に覚えた名前空間へ落ちる道が無い(毎回、口の設定から決める)');
  // 起動の突き合わせ
  const bootFile = IS_FINAL ? path.join(SRC, 'onprem', 'boot.jsx') : path.join(SRC, 'main.jsx');
  const boot = fs.readFileSync(bootFile, 'utf8');
  assert.ok(/assertGroupMatches|verifyGroupAsync/.test(boot), '起動の時に、設定のグループが起動の最初と同じか確かめる');
});
