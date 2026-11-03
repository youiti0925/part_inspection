// ============================================================================
// 📊 生産達成率の共有棚(domain/achieveShelf.js)の試験(2026-10-04)
// ----------------------------------------------------------------------------
// 作り物の行だけを使う(本物のロットは使わない)。
//   ・較正済みだけを標準時間に数え、既定値の作業は「未設定の実績秒」へ分ける
//   ・月×人で足す・行の形・壊れた行を飛ばす
//   ・同じ中身なら書かない(端末の控え・この画面の控え・同時に2回)
//   ・③ の側(読み・月の系列・人ごと・未設定の割合)
//   ・🚨 4アプリで同じ物(md5)
// ⚠ このファイルも 最終・製品・部品・③ で同じ物。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  ACHIEVE_NS, ACHIEVE_COL, ACHIEVE_APPS, ACHIEVE_DEFAULT_TARGET, achieveSigKey, ymOfMs, cleanWorker,
  sumAchieveCells, countCalibrated, sigOf, buildAchieveDoc, makeAchievePublisher, parseAchieveDoc,
  filterAchieveCells, achieveRateOf, unsetShareOf, achieveMonthly, achieveTotal, achievePerWorker,
  achieveMonthBounds, fmtHours2, fmtPct0, achieveAppLabel,
} from '../achieveShelf.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const at = (y, m, d = 10, h = 10) => new Date(y, m - 1, d, h, 0, 0).getTime();

// 作り物: 9月 山田 較正済み 2件(標準 60+60 / 実績 80+70)・未設定 1件(実績 50)
//         9月 鈴木 未設定だけ 1件(実績 100)
//         10月 山田 較正済み 1件(標準 30 / 実績 20)
const ROWS = [
  { ms: at(2026, 9, 1), worker: '山田', act: 80, cal: 60 },
  { ms: at(2026, 9, 2), worker: '山田', act: 70, cal: 60 },
  { ms: at(2026, 9, 3), worker: '山田', act: 50, cal: 0 },
  { ms: at(2026, 9, 4), worker: '鈴木', act: 100, cal: 0 },
  { ms: at(2026, 10, 1), worker: '山田', act: 20, cal: 30 },
];

test('AS01 置き場は共有棚 capacity-shared-v1/achieve_rate・3工程の並び・目標の既定 80%', () => {
  assert.equal(ACHIEVE_NS, 'capacity-shared-v1');
  assert.equal(ACHIEVE_COL, 'achieve_rate');
  assert.deepEqual(ACHIEVE_APPS.map((a) => a.key), ['product', 'parts', 'final']);
  assert.equal(ACHIEVE_DEFAULT_TARGET, 80);
  assert.equal(achieveAppLabel('all'), '全体');
  assert.equal(achieveAppLabel('final'), '最終');
  assert.equal(achieveSigKey('final'), 'achieve_shelf_sig_v1_final');
});

test('AS02 月×人で足す。標準時間は較正済みだけ・既定値の作業は未設定の実績秒へ', () => {
  const m = sumAchieveCells(ROWS);
  assert.deepEqual(m.get('2026-09|山田'), { std: 120, act: 150, unset: 50, n: 3, nCal: 2 });
  assert.deepEqual(m.get('2026-09|鈴木'), { std: 0, act: 0, unset: 100, n: 1, nCal: 0 });
  assert.deepEqual(m.get('2026-10|山田'), { std: 30, act: 20, unset: 0, n: 1, nCal: 1 });
  assert.equal(m.size, 3);
});

test('AS03 壊れた行・実績0秒・時刻なしは数えない。名前の「|」は全角へ・空は(名前なし)', () => {
  const m = sumAchieveCells([
    null, { ms: NaN, worker: 'a', act: 10, cal: 5 }, { ms: at(2026, 9), worker: 'a', act: 0, cal: 5 },
    { ms: at(2026, 9), worker: 'a|b', act: 10, cal: 5 }, { ms: at(2026, 9), worker: '  ', act: 10, cal: 0 },
  ]);
  assert.deepEqual([...m.keys()].sort(), ['2026-09|(名前なし)', '2026-09|a｜b']);
  assert.equal(cleanWorker(null), '(名前なし)');
  assert.equal(ymOfMs(at(2026, 1, 31, 23)), '2026-01');
});

test('AS04 較正の数: 型式ごとの 0 より大きい数だけ', () => {
  assert.deepEqual(countCalibrated({}), { models: 0, keys: 0 });
  assert.deepEqual(countCalibrated({ model_A: { '外観_傷': 30, '外観_汚れ': 0 }, model_B: {}, model_C: { x: 12, y: 8 } }), { models: 2, keys: 3 });
  assert.deepEqual(countCalibrated(null), { models: 0, keys: 0 });
});

test('AS05 共有棚の1件の形(行は文字・並びは月→人・印は書いた時刻で変わらない)', () => {
  const a = buildAchieveDoc({ app: 'final', rows: ROWS, calibrated: { models: 1, keys: 2 }, writtenAt: 1, reason: 'open' });
  const b = buildAchieveDoc({ app: 'final', rows: [...ROWS].reverse(), calibrated: { models: 1, keys: 2 }, writtenAt: 999, reason: 'calibrate' });
  assert.deepEqual(a.cells, ['2026-09|山田|120|150|50|3|2', '2026-09|鈴木|0|0|100|1|0', '2026-10|山田|30|20|0|1|1']);
  assert.equal(a.v, 1); assert.equal(a.app, 'final'); assert.equal(a.complete, true);
  assert.equal(a.sig, b.sig, '書いた時刻・理由・行の順では印が変わらない');
  const c = buildAchieveDoc({ app: 'final', rows: ROWS.slice(1), calibrated: { models: 1, keys: 2 }, writtenAt: 1 });
  assert.notEqual(a.sig, c.sig);
  const d = buildAchieveDoc({ app: 'final', rows: ROWS, calibrated: { models: 2, keys: 2 }, writtenAt: 1 });
  assert.notEqual(a.sig, d.sig, '較正の数が変わったら書く');
  assert.notEqual(a.sig, buildAchieveDoc({ app: 'product', rows: ROWS, calibrated: { models: 1, keys: 2 }, writtenAt: 1 }).sig);
  assert.throws(() => buildAchieveDoc({ app: 'xx', rows: [], writtenAt: 1 }), /知らないアプリ/);
  assert.equal(sigOf('abc'), sigOf('abc'));
  assert.notEqual(sigOf('abc'), sigOf('abd'));
});

test('AS06 大きすぎる時は保存しない(黙って切らない)', () => {
  const rows = [];
  for (let i = 0; i < 40000; i++) rows.push({ ms: at(2026, 1 + (i % 12)), worker: `人${i}`, act: 10, cal: 5 });
  assert.throws(() => buildAchieveDoc({ app: 'parts', rows, writtenAt: 1 }), /大きすぎて/);
});

test('AS07 書く係: 同じ中身なら書かない(この画面・端末の控え・同時の2回)・失敗は投げる', async () => {
  const store = new Map();
  const storage = { get: (k) => (store.has(k) ? store.get(k) : null), set: (k, v) => store.set(k, v) };
  const saved = [];
  let t = 100;
  const pub = makeAchievePublisher({ app: 'product', save: async (doc) => { saved.push(doc); }, storage, clock: () => t++ });
  const r1 = await pub.publish({ rows: ROWS, calibrated: { models: 1, keys: 2 }, reason: 'open' });
  assert.equal(r1.written, true); assert.equal(saved.length, 1);
  assert.equal(saved[0].writtenAt, 100); assert.equal(saved[0].reason, 'open');
  const r2 = await pub.publish({ rows: ROWS, calibrated: { models: 1, keys: 2 }, reason: 'open' });
  assert.equal(r2.written, false); assert.equal(saved.length, 1, '同じ中身は2回目を書かない');
  // 開き直し(新しい係)でも端末の控えで書かない
  const pub2 = makeAchievePublisher({ app: 'product', save: async (doc) => { saved.push(doc); }, storage });
  assert.equal((await pub2.publish({ rows: ROWS, calibrated: { models: 1, keys: 2 } })).written, false);
  // 較正が増えた = 中身が変わった → 書く
  assert.equal((await pub2.publish({ rows: ROWS, calibrated: { models: 2, keys: 3 }, reason: 'calibrate' })).written, true);
  assert.equal(saved.length, 2);
  // 同時に2回(1回目の保存が終わる前)でも書くのは1回
  let release; const gate = new Promise((ok) => { release = ok; });
  const slow = []; const pub3 = makeAchievePublisher({ app: 'parts', save: async (doc) => { slow.push(doc); await gate; } });
  const pA = pub3.publish({ rows: ROWS }); const pB = pub3.publish({ rows: ROWS });
  release();
  const [a, b] = await Promise.all([pA, pB]);
  assert.equal(slow.length, 1); assert.equal(a.written, true); assert.equal(b.written, false);
  // 失敗は投げる・控えは書き換えない(次にまた試す)
  const store4 = new Map(); const st4 = { get: (k) => store4.get(k) ?? null, set: (k, v) => store4.set(k, v) };
  let fail = true; const ok4 = [];
  const pub4 = makeAchievePublisher({ app: 'final', save: async (doc) => { if (fail) throw new Error('429'); ok4.push(doc); }, storage: st4 });
  await assert.rejects(() => pub4.publish({ rows: ROWS }), /429/);
  assert.equal(store4.size, 0);
  fail = false;
  assert.equal((await pub4.publish({ rows: ROWS })).written, true);
  assert.equal(ok4.length, 1);
  // 控えが壊れていても止めない
  const bad = { get: () => { throw new Error('blocked'); }, set: () => { throw new Error('blocked'); } };
  const pub5 = makeAchievePublisher({ app: 'final', save: async () => {}, storage: bad });
  assert.equal((await pub5.publish({ rows: ROWS })).written, true);
});

test('AS08 ③ の読み: 行を戻す・壊れた行は飛ばす・知らないアプリは null', () => {
  const doc = buildAchieveDoc({ app: 'final', rows: ROWS, calibrated: { models: 1, keys: 2 }, writtenAt: 1700000000000, reason: 'open', complete: false, note: '新しい順500件' });
  doc.cells.push('壊れた行', '2026-9|x|1|1|1|1|1');
  const p = parseAchieveDoc(doc);
  assert.equal(p.cells.length, 3);
  assert.deepEqual(p.cells[0], { app: 'final', ym: '2026-09', worker: '山田', std: 120, act: 150, unset: 50, n: 3, nCal: 2 });
  assert.equal(p.writtenAt, 1700000000000); assert.equal(p.complete, false); assert.equal(p.note, '新しい順500件');
  assert.deepEqual(p.calibrated, { models: 1, keys: 2 });
  assert.equal(parseAchieveDoc({ app: 'nope', cells: [] }), null);
  assert.equal(parseAchieveDoc(null), null);
});

test('AS09 ③ の数え方: 達成率 = Σ標準 ÷ Σ実績(較正済みだけ)・未設定は時間比', () => {
  const cells = [
    ...parseAchieveDoc(buildAchieveDoc({ app: 'final', rows: ROWS, writtenAt: 1 })).cells,
    ...parseAchieveDoc(buildAchieveDoc({ app: 'product', rows: [{ ms: at(2026, 9, 5), worker: '山田', act: 50, cal: 40 }], writtenAt: 1 })).cells,
  ];
  const months = ['2026-08', '2026-09', '2026-10'];
  const all = achieveMonthly(cells, months);
  assert.equal(all[0].rate, null); assert.equal(all[0].unsetPct, null);
  // 9月: 標準 120+40=160 / 実績 150+50=200 → 80% ・ 未設定 150 / (200+150) = 42.857%
  assert.equal(all[1].std, 160); assert.equal(all[1].act, 200);
  assert.equal(Math.round(all[1].rate * 1000) / 1000, 80);
  assert.equal(Math.round(all[1].unsetPct * 1000) / 1000, 42.857);
  assert.equal(all[2].rate, 150);
  const tot = achieveTotal(all);
  assert.equal(tot.std, 190); assert.equal(tot.act, 220); assert.equal(Math.round(tot.rate * 100) / 100, 86.36);
  // 工程の切替・班(名簿)・人
  assert.equal(achieveTotal(achieveMonthly(filterAchieveCells(cells, { app: 'product' }), months)).std, 40);
  assert.equal(achieveTotal(achieveMonthly(filterAchieveCells(cells, { members: ['鈴木'] }), months)).rate, null);
  assert.equal(achieveTotal(achieveMonthly(filterAchieveCells(cells, { members: ['鈴木'] }), months)).unsetPct, 100);
  // 人ごと: 較正済みの実績が無い人(鈴木)は出さない
  const per = achievePerWorker(cells, months);
  assert.deepEqual(per.map((p) => p.worker), ['山田']);
  assert.equal(per[0].total.std, 190);
  assert.equal(achieveRateOf({ std: 1, act: 0 }), null);
  assert.equal(unsetShareOf({ act: 0, unset: 0 }), null);
  assert.deepEqual(achieveMonthBounds(cells), { first: '2026-09', last: '2026-10' });
  assert.deepEqual(achieveMonthBounds([]), { first: null, last: null });
  assert.equal(fmtHours2(3600 * 1.234), '1.23'); assert.equal(fmtPct0(85.4), '85%'); assert.equal(fmtPct0(null), '—');
});

// 🚨 4アプリで同じ物。近所(作業の写し・本物のリポ)に在る時だけ見る(CI では見ない)。
test('AS10 achieveShelf.js と この試験は 最終・製品・部品・③ で md5 が同じ', () => {
  const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p).toString('utf8').replace(/\r\n/g, '\n')).digest('hex');
  const mine = path.resolve(HERE, '..', 'achieveShelf.js');
  const myTest = path.resolve(HERE, 'achieveShelf.test.mjs');
  const root = path.resolve(HERE, '..', '..', '..');
  const parent = path.dirname(root);
  const names = ['golden-ach', 'product-ach', 'parts-ach', 'overview-ach',
    'golden-meteoroid', 'product-inspection-app', 'parts-inspection-app', 'factory-overview-app'];
  const extra = ['C:/Users/anrw3/.gemini/antigravity/playground/golden-meteoroid', 'C:/Users/anrw3/product-inspection-app',
    'C:/Users/anrw3/parts-inspection-app', 'C:/Users/anrw3/factory-overview-app'];
  const roots = [...new Set([...names.map((n) => path.join(parent, n)), ...extra].map((p) => path.resolve(p)))].filter((p) => p !== root);
  let seen = 0;
  for (const r of roots) {
    const other = path.join(r, 'src', 'domain', 'achieveShelf.js');
    const otherTest = path.join(r, 'src', 'domain', '__tests__', 'achieveShelf.test.mjs');
    if (!fs.existsSync(other)) continue;
    seen += 1;
    assert.equal(md5(other), md5(mine), `achieveShelf.js が違う: ${other}`);
    if (fs.existsSync(otherTest)) assert.equal(md5(otherTest), md5(myTest), `achieveShelf.test.mjs が違う: ${otherTest}`);
  }
  assert.ok(seen >= 0);
});
