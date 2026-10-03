// ============================================================================
// 📉 ロットの「前回の続きだけ読む」(部品): 全部読みと差分読みで **画面のロットが1件も違わない** か
// ----------------------------------------------------------------------------
// 写し(にせのサーバ + にせの端末の控え)の上に **全部読みの端末 A** と **差分読みの端末 B** を置き、
// App.jsx と同じ決まり(planLotSubscriptions・mergeLotsById・①②③の購読の張り方)で動かす。
// 何日分もの 作成・一括取込(同じ時刻で何十件)・更新・完了・再開・削除(墓標あり)・古い版の削除(墓標なし)・
// 窓の上の方をまとめて消す・控えの掃除(LRU)・過去が要る画面を開く・眠って戻る を回し、
// 開くたび・操作のたびに A と B の lotsRaw(App の合体と同じ式)を id・並び・版・状態まで比べる。
// 🚨 1件でも違えば落ちる(画面の数字が変わる = やってはいけない)。
// 負の対照: 墓標を読まない・控えの突き合わせを嘘にする・件数を確かめない、で写しが食い違いを見つける事も確かめる。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOTS_TOMB_COL, DELTA_LIMIT, TOMB_LIMIT, DELTA_MARGIN_MS, DELTA_WAKE_GAP_MS,
  TOMB_RETENTION_MS, TOMB_RETENTION_MARGIN_MS, tombsCover,
  deltaStateKey, tsMs, isServerStamp, isOpenLot, deltaLotsSpec, tombLotsSpec, tombDocOf, maxServerMs,
  plainDocId, inCoveredRange, manifestEntryOf, normalizeDeltaState, planLotsSync, checkCachedLots,
  liveWindowInRange, buildDeltaState, fullWatermarkOf, reanchorSince, countChecksOf,
} from '../lotsDeltaSync.js';
import { createLotsDeltaSync } from '../lotsDeltaController.js';
import {
  mergeLotsById, windowIsWholeCollection, planLotSubscriptions,
  LOTS_LIVE_LIMIT, LOTS_HISTORY_LIMIT, OPEN_LOTS_LIMIT,
} from '../readBudget.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8').replace(/\r\n/g, '\n');
const NS = 'parts-inspection-v1';
const DAY = 86400000;
const stamp = (ms) => ({ seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6 });

// ─── 純関数 ──────────────────────────────────────────────────────────────
test('DS01 墓標の置き場所と形は製品・最終と同じ(lots_deleted / {lotId, deletedAt})・控え帳の鍵は部品だけの名前', () => {
  assert.equal(LOTS_TOMB_COL, 'lots_deleted');
  const mark = { __dataSentinel: 'serverNow' };
  assert.deepEqual(tombDocOf('L1', mark), { lotId: 'L1', deletedAt: mark });
  assert.equal(tombDocOf(12, mark).lotId, '12');
  assert.equal(deltaStateKey(NS), 'parts.lotsDelta.v1.parts-inspection-v1');
});

test('DS02 差分と墓標の指定: updatedAt/deletedAt より後・古い順・上限つき(製品と同じ)', () => {
  const d = deltaLotsSpec(1000);
  assert.deepEqual(d.where[0].slice(0, 2), ['updatedAt', '>']);
  assert.equal(d.where[0][2].getTime(), 1000);
  assert.deepEqual(d.orderBy, [['updatedAt', 'asc']]);
  assert.equal(d.limit, DELTA_LIMIT);
  const t = tombLotsSpec(2000);
  assert.deepEqual(t.where[0].slice(0, 2), ['deletedAt', '>']);
  assert.deepEqual(t.orderBy, [['deletedAt', 'asc']]);
  assert.equal(t.limit, TOMB_LIMIT);
  assert.equal(DELTA_MARGIN_MS, 5 * 60 * 1000);
  assert.equal(TOMB_RETENTION_MS, Infinity, '墓標は消さない(2026-10-03 に「7日」をやめた)');
});

test('DS03 時刻の読み方(Timestamp・数・Date・秒/ナノ秒)。送信待ち(null)と数の updatedAt は目印にしない', () => {
  assert.equal(tsMs({ toMillis: () => 5 }), 5);
  assert.equal(tsMs(7), 7);
  assert.equal(tsMs(new Date(9)), 9);
  assert.equal(tsMs({ seconds: 2, nanoseconds: 3000000 }), 2003);
  assert.equal(tsMs(null), null);
  assert.equal(isServerStamp({ seconds: 1, nanoseconds: 0 }), true);
  assert.equal(isServerStamp(123), false);
  assert.equal(maxServerMs([{ id: 'a', u: 5 }, { id: 'b', u: 9, pending: true }, { id: 'c', u: null }]), 5);
  assert.equal(fullWatermarkOf([{ updatedAt: stamp(5000) }, { updatedAt: 99999 }], [{ updatedAt: null }]), 5000);
});

test('DS04 未完了の決まりは Firestore の != と同じ(項目が無い物は入らない・null は入る)', () => {
  assert.equal(isOpenLot({ status: 'waiting' }), true);
  assert.equal(isOpenLot({ status: 'completed' }), false);
  assert.equal(isOpenLot({}), false);
  assert.equal(isOpenLot({ status: null }), true);
});

test('DS05 開く時の決め方: 控え帳が無い・墓標の保持期間を超えた・時計が戻った・名前空間/版が違う・保管庫が違う → 全部読み', () => {
  const now = 100 * DAY;
  const s = buildDeltaState({ ns: NS, nowMs: now - DAY, liveRows: [], openRows: [], openOn: false, watermarkMs: now - DAY });
  assert.equal(s.whole, true);
  assert.equal(planLotsSync(null, { nowMs: now, ns: NS }).mode, 'full');
  assert.equal(planLotsSync(s, { nowMs: now, ns: NS, enabled: false }).mode, 'full');
  assert.equal(planLotsSync(s, { nowMs: now - 2 * DAY, ns: NS }).reason, '端末の時計が戻った');
  // 🪦 2026-10-03: 「前回から7日以上は全部」はやめた。墓標は消さない(無期限)ので、何日休んでも差分
  for (const days of [7, 8, 30, 365]) assert.equal(planLotsSync(s, { nowMs: now - DAY + days * DAY, ns: NS }).mode, 'delta', `${days}日 休んでも差分`);
  const R = 10 * DAY;
  assert.equal(planLotsSync(s, { nowMs: now - DAY + R - TOMB_RETENTION_MARGIN_MS - 1, ns: NS, tombRetentionMs: R }).mode, 'delta');
  assert.equal(planLotsSync(s, { nowMs: now - DAY + R - TOMB_RETENTION_MARGIN_MS, ns: NS, tombRetentionMs: R }).reason, '前回から墓標の保持期間より長くたった');
  assert.equal(planLotsSync(s, { nowMs: now, ns: 'other' }).mode, 'full');
  assert.equal(normalizeDeltaState({ ...s, v: 99 }, NS), null);
  assert.equal(normalizeDeltaState({ ...s, whole: false, edge: null }, NS), null, '上位N件なのに境目が無い控え帳は使わない');
  const p = planLotsSync(s, { nowMs: now, ns: NS });
  assert.equal(p.mode, 'delta');
  assert.equal(p.sinceMs, now - DAY - DELTA_MARGIN_MS);
});

const lot = (id, createdAt, status, u) => ({ id, createdAt, status, updatedAt: stamp(u) });
const liveOf = (n, base = 10 * DAY) => Array.from({ length: n }, (_, i) => lot(`L${String(1000 - i).padStart(4, '0')}`, base - i * 1000, 'completed', base + i));

test('DS06 控え帳の作り方: 120件に届かない = ロット全部。届いた = 120件目が境目(同じ時刻は id の並び)+未完了が要る', () => {
  const small = liveOf(5);
  const w = buildDeltaState({ ns: NS, nowMs: 20 * DAY, liveRows: small, openRows: [], openOn: false, watermarkMs: 11 * DAY });
  assert.equal(w.whole, true);
  assert.equal(Object.keys(w.manifest).length, 5);
  const full = liveOf(LOTS_LIVE_LIMIT);
  assert.equal(buildDeltaState({ ns: NS, nowMs: 20 * DAY, liveRows: full, openRows: [], openOn: false, watermarkMs: 11 * DAY }), null, '未完了の答えが無いのに上位N件の控え帳を作った');
  const c = buildDeltaState({ ns: NS, nowMs: 20 * DAY, liveRows: full, openRows: [lot('OLD', 1, 'waiting', 5)], openOn: true, watermarkMs: 11 * DAY });
  assert.equal(c.whole, false);
  assert.deepEqual(c.edge, { c: full[full.length - 1].createdAt, id: full[full.length - 1].id });
  assert.deepEqual(c.manifest.OLD, [5, 1, 1]);
  assert.equal(buildDeltaState({ ns: NS, nowMs: 20 * DAY, liveRows: full, openRows: Array.from({ length: OPEN_LOTS_LIMIT }, (_, i) => lot(`o${i}`, 1, 'waiting', 1)), openOn: true, watermarkMs: 11 * DAY }), null, '未完了が上限で切れたのに作った');
  assert.equal(buildDeltaState({ ns: NS, nowMs: 1, liveRows: small, openRows: [], openOn: false, watermarkMs: 11 * DAY }), null, '目印が端末の今より未来');
  const oddId = full.slice(0, -1).concat([{ ...full[full.length - 1], id: '日本語' }]);
  assert.equal(buildDeltaState({ ns: NS, nowMs: 20 * DAY, liveRows: oddId, openRows: [], openOn: true, watermarkMs: 11 * DAY }), null, '境目の id が半角でないのに作った');
  assert.equal(plainDocId('__id12__'), false);
  // 範囲: 境目より上・同じ時刻なら id が境目以上・未完了
  const e = c.edge;
  assert.equal(inCoveredRange({ id: 'x', createdAt: e.c + 1, status: 'completed' }, c), true);
  assert.equal(inCoveredRange({ id: e.id, createdAt: e.c, status: 'completed' }, c), true);
  assert.equal(inCoveredRange({ id: 'A', createdAt: e.c, status: 'completed' }, c), false, '同じ時刻で id が小さい = 窓の外');
  assert.equal(inCoveredRange({ id: 'y', createdAt: e.c - 1, status: 'waiting' }, c), true);
  assert.equal(inCoveredRange({ id: 'y', createdAt: e.c - 1, status: 'completed' }, c), false);
  assert.deepEqual(manifestEntryOf({ updatedAt: stamp(3), createdAt: 'x', status: 'completed' }), [3, null, 0]);
});

test('DS07 控えの突き合わせ: 版が違う・控え帳に無い範囲のロット・控えから消えた → だめ。前回より新しい物と送信待ちは差分に任せる', () => {
  const full = liveOf(LOTS_LIVE_LIMIT);
  const st = normalizeDeltaState(buildDeltaState({ ns: NS, nowMs: 20 * DAY, liveRows: full, openRows: [], openOn: true, watermarkMs: 11 * DAY }), NS);
  const row = (l) => ({ id: l.id, createdAt: l.createdAt, status: l.status, u: tsMs(l.updatedAt), stamp: true, pending: false });
  const cached = full.map(row);
  const since = 11 * DAY - DELTA_MARGIN_MS;
  assert.equal(checkCachedLots(st, cached, { sinceMs: since }).ok, true);
  assert.equal(checkCachedLots(st, cached.map((r, i) => (i === 3 ? { ...r, u: r.u + 1 } : r)), { sinceMs: since }).ok, false);
  assert.equal(checkCachedLots(st, cached.slice(1), { sinceMs: since }).ok, false, '控えの掃除で消えた');
  assert.equal(checkCachedLots(st, [...cached, { id: 'stale', createdAt: 1, status: 'waiting', u: 3, stamp: true }], { sinceMs: since }).ok, false, '控え帳に無い古い未完了');
  assert.equal(checkCachedLots(st, [...cached, { id: 'below', createdAt: 1, status: 'completed', u: 3, stamp: true }], { sinceMs: since }).ok, true, '範囲の外の古い完了は見ない');
  assert.equal(checkCachedLots(st, [...cached, { id: 'new', createdAt: 12 * DAY, status: 'waiting', u: 12 * DAY, stamp: true }], { sinceMs: since }).ok, true, '前回より新しい物は差分が読む');
  assert.equal(checkCachedLots(st, [...cached, { id: 'numU', createdAt: 12 * DAY, status: 'waiting', u: 12 * DAY, stamp: false }], { sinceMs: since }).ok, false, '数の updatedAt は差分に当たらない');
  assert.equal(checkCachedLots(st, [...cached, { id: 'p', createdAt: 12 * DAY, status: 'waiting', u: null, pending: true }], { sinceMs: since }).ok, true);
  assert.equal(checkCachedLots(st, [...cached, { id: 's', createdAt: 'abc', status: 'completed', u: 1, stamp: true }], { sinceMs: since }).ok, false, '作った時刻が文字');
});

test('DS08 開いている間の見張り: 120件目が範囲の下へ伸びたら・120件に届かなくなったら だめ(ロット全部の時は見ない)', () => {
  const full = liveOf(LOTS_LIVE_LIMIT);
  const st = normalizeDeltaState(buildDeltaState({ ns: NS, nowMs: 20 * DAY, liveRows: full, openRows: [], openOn: true, watermarkMs: 11 * DAY }), NS);
  assert.equal(liveWindowInRange(st, full).ok, true);
  const newer = [lot('N1', 11 * DAY, 'waiting', 11 * DAY), ...full.slice(0, -1)];
  assert.equal(liveWindowInRange(st, newer).ok, true);
  assert.equal(liveWindowInRange(st, full.slice(0, -1)).ok, false);
  assert.equal(liveWindowInRange(st, [...full.slice(1), lot('B', full[full.length - 1].createdAt - 1, 'completed', 1)]).ok, false);
  assert.equal(liveWindowInRange({ ...st, whole: true }, full.slice(0, 3)).ok, true);
});

test('DS09 張り直しの時刻・件数の確かめの中身', () => {
  assert.equal(reanchorSince(10000000, 1), 10000000 - DELTA_MARGIN_MS);
  assert.equal(reanchorSince(10000000, 10000000 - DELTA_MARGIN_MS), null);
  assert.equal(DELTA_WAKE_GAP_MS, 25 * 60 * 1000);
  const whole = { whole: true };
  assert.deepEqual(countChecksOf(whole, [{ id: 'a' }, { id: 'b' }]).map((c) => [c.spec, c.cached]), [[{}, 2]]);
  const capped = { whole: false, edge: { c: 100, id: 'm' } };
  const cc = countChecksOf(capped, [{ id: 'a', createdAt: 101, status: 'completed' }, { id: 'b', createdAt: 100, status: 'waiting' }, { id: 'c', createdAt: 5, status: 'processing' }]);
  assert.deepEqual(cc.map((c) => [c.spec, c.cached]), [[{ where: [['createdAt', '>', 100]] }, 1], [{ where: [['status', '!=', 'completed']] }, 2]]);
});

// ─── 写し(にせのサーバ + にせの端末の控え) ─────────────────────────────────
// ⚠ 本物の SDK と同じ所だけを真似る:
//   ・問い合わせの並び: createdAt 降順 → 同じ時刻は書類ID 降順(①③)/ status 昇順 → 書類ID 昇順(②の !=)
//   ・サーバに張った購読は、まず控えから作った答え(fromCache)を出し、次にサーバの答え。答えの書類を控えへ書く。
//     答えから外れた書類・最初の答えで控えにしか無い物(limbo)は、今のサーバの版で控えを直す(消えていれば控えからも消える)
//   ・控えに張った購読は、控えの中身から同じ問い合わせで答えを作る(サーバへは行かない)
//   ・1件の読み直し(refetch)は、無ければ控えから消す
//   ・墓標を残さない古い版の削除は、サーバからだけ消える(その時に張っていなかった端末の控えには残る)
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const cmpId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const liveQ = (limit) => (docs) => [...docs.values()].filter((d) => d.createdAt !== undefined)
  .sort((a, b) => (b.createdAt - a.createdAt) || cmpId(b.id, a.id)).slice(0, limit);
const openQ = (docs) => [...docs.values()].filter(isOpenLot)
  .sort((a, b) => cmpId(a.status, b.status) || cmpId(a.id, b.id)).slice(0, OPEN_LOTS_LIMIT);
const deltaQ = (since) => (docs) => [...docs.values()].filter((d) => tsMs(d.updatedAt) > since)
  .sort((a, b) => (tsMs(a.updatedAt) - tsMs(b.updatedAt)) || cmpId(a.id, b.id)).slice(0, DELTA_LIMIT);
const tombQ = (since) => (tombs) => [...tombs.values()].filter((t) => tsMs(t.deletedAt) > since)
  .sort((a, b) => tsMs(a.deletedAt) - tsMs(b.deletedAt)).slice(0, TOMB_LIMIT);
const countOf = (docs, spec) => {
  const all = [...docs.values()];
  const w = (spec && spec.where && spec.where[0]) || null;
  if (!w) return all.length;
  if (w[0] === 'createdAt' && w[1] === '>') return all.filter((d) => typeof d.createdAt === 'number' && d.createdAt > w[2]).length;
  if (w[0] === 'status' && w[1] === '!=') return all.filter(isOpenLot).length;
  throw new Error(`写しが知らない件数の問い合わせ: ${JSON.stringify(spec)}`);
};

const makeWorld = (seed) => {
  let rnd = (seed * 2654435761) >>> 0 || 1;
  const rand = () => { rnd ^= rnd << 13; rnd >>>= 0; rnd ^= rnd >>> 17; rnd ^= rnd << 5; rnd >>>= 0; return rnd / 4294967296; };
  let clock = Date.UTC(2026, 8, 1, 0, 0, 0);
  const server = new Map();
  const tombs = new Map();
  const subs = new Set();
  let n = 0;
  const w = {
    rand, server, tombs,
    now: () => clock,
    tick: (ms = 1000) => { clock += ms; return clock; },
    newId: () => `${(clock % 1e9).toString(36)}${(n++).toString(36)}${Math.floor(rand() * 1e6).toString(36)}`,
    notify() { for (const f of [...subs]) f(); },
    onChange(f) { subs.add(f); return () => subs.delete(f); },
    put(id, patch) {
      const t = w.tick(1000);
      server.set(id, { ...(server.get(id) || {}), ...patch, id, updatedAt: stamp(t) });
    },
    del(id, { withTomb = true } = {}) {
      if (withTomb) tombs.set(id, { id, lotId: id, deletedAt: stamp(w.tick(1000)) });   // id = 書類ID(窓口の ROW_DOCID_WINS と同じ)
      server.delete(id);
      w.tick(1000);
    },
    pick() { const ids = [...server.keys()]; return ids.length ? ids[Math.floor(rand() * ids.length)] : null; },
  };
  return w;
};

const makeDevice = () => {
  const cache = new Map();
  const store = new Map();
  const subs = new Set();
  return {
    cache, store, reads: 0,
    notify() { for (const f of [...subs]) f(); },
    onChange(f) { subs.add(f); return () => subs.delete(f); },
    storage: { get: (k) => (store.has(k) ? store.get(k) : null), set: (k, v) => store.set(k, v), remove: (k) => store.delete(k) },
    gc(rand, ratio) { let n = 0; for (const id of [...cache.keys()]) if (rand() < ratio) { cache.delete(id); n++; } return n; },
  };
};

const snapOf = (rows, fromCache, changes) => ({
  metadata: { fromCache, hasPendingWrites: false },
  docChanges: () => new Array(changes),
  docs: rows,
});
const resolveDoc = (world, dev, id) => { if (world.server.has(id)) dev.cache.set(id, clone(world.server.get(id))); else dev.cache.delete(id); };

const listenServer = (world, dev, q, next, { map = (d) => d, lots = true } = {}) => {
  let active = true;
  let lastIds = null;
  let lastKey = null;
  const fire = () => {
    if (!active) return;
    const rows = q(lots ? world.server : world.tombs).map(clone);
    if (lots) {
      const ids = new Set(rows.map((r) => r.id));
      if (lastIds === null) {
        for (const r of q(dev.cache)) if (!ids.has(r.id)) { dev.reads += 1; resolveDoc(world, dev, r.id); }
      }
      for (const r of rows) dev.cache.set(r.id, clone(r));
      if (lastIds) for (const id of lastIds) if (!ids.has(id)) resolveDoc(world, dev, id);
      lastIds = ids;
    }
    const k = JSON.stringify(rows);
    if (k === lastKey) { if (lots) dev.notify(); return; }
    const prev = lastKey === null ? null : new Set(JSON.parse(lastKey).map((r) => JSON.stringify(r)));
    const changed = prev === null ? rows.length : rows.filter((r) => !prev.has(JSON.stringify(r))).length;
    dev.reads += prev === null ? Math.max(1, rows.length) : changed;
    lastKey = k;
    if (lots) dev.notify();
    next(rows.map(map), snapOf(rows, false, changed));
  };
  const un = world.onChange(fire);
  queueMicrotask(() => {
    if (!active) return;
    if (lots) { const c = q(dev.cache).map(clone); next(c.map(map), snapOf(c, true, c.length)); }
    fire();
  });
  return () => { active = false; un(); };
};
const listenCache = (dev, q, next) => {
  let active = true;
  let lastKey = null;
  const fire = () => {
    if (!active) return;
    const rows = q(dev.cache).map(clone);
    const k = JSON.stringify(rows);
    if (k === lastKey) return;
    lastKey = k;
    next(rows, snapOf(rows, true, 0));
  };
  const un = dev.onChange(fire);
  queueMicrotask(fire);
  return () => { active = false; un(); };
};
const cachedRowOf = (d) => ({ id: d.id, createdAt: d.createdAt, status: d.status, u: tsMs(d.updatedAt), stamp: isServerStamp(d.updatedAt), pending: false });

/** App.jsx と同じ合体(lotsRaw)。 */
const lotsRawOf = (app) => {
  if (app.whole) return app.live;
  if (app.history !== null) return mergeLotsById(app.history, [], app.open);
  return mergeLotsById(app.live, app.open);
};
const keyOf = (rows) => rows.map((r) => `${r.id}:${tsMs(r.updatedAt)}:${r.status}:${r.createdAt}`).join(',');

/**
 * 1回「開く」。App.jsx の ①②③の useEffect と同じ決まり(依存 = 計画の真偽 + どこに張るか)。
 * ⚠ ③過去の取り寄せ(getPage 1回)は差分読みで変えていないので写しに入れない。
 */
const openApp = (world, dev, { enabled = true, overrides = {} } = {}) => {
  const app = { src: null, live: [], open: [], history: null, whole: false, historyWanted: false, logs: [] };
  const timers = [];
  const subs = {};
  let closed = false;
  let scheduled = false;
  const schedule = () => { if (scheduled || closed) return; scheduled = true; queueMicrotask(() => { scheduled = false; reconcile(); }); };
  const plan = () => planLotSubscriptions({
    windowWhole: app.whole, historyLoaded: app.history !== null, historyWanted: app.historyWanted,
    historyWhole: app.history !== null && windowIsWholeCollection(app.history.length, LOTS_HISTORY_LIMIT),
  });
  const effect = (name, key, body) => {
    const cur = subs[name];
    if (cur && cur.key === key) return;
    if (cur && cur.cleanup) cur.cleanup();
    subs[name] = { key, cleanup: body() || null };
  };
  let ctl = null;
  const reconcile = () => {
    if (closed) return;
    const p = plan();
    const src = app.src;
    effect('live', `${p.live}|${src}`, () => {
      if (!src || src === 'stopped' || !p.live) return null;
      const s = src;
      const cb = (rows, snap) => {
        app.live = rows;
        app.whole = windowIsWholeCollection(rows.length, LOTS_LIVE_LIMIT);
        ctl.onWindow('live', rows, snap, s);
        schedule();
      };
      const un = s === 'cache' ? listenCache(dev, liveQ(LOTS_LIVE_LIMIT), cb) : listenServer(world, dev, liveQ(LOTS_LIVE_LIMIT), cb);
      return () => { un(); ctl.windowOff('live', s); };
    });
    effect('open', `${p.open}|${src}`, () => {
      if (src === 'stopped') return null;
      if (!p.open || !src) { app.open = []; return null; }
      const s = src;
      const cb = (rows, snap) => { app.open = rows; ctl.onWindow('open', rows, snap, s); schedule(); };
      const un = s === 'cache' ? listenCache(dev, openQ, cb) : listenServer(world, dev, openQ, cb);
      return () => { un(); ctl.windowOff('open', s); };
    });
    effect('history', `${p.history}`, () => {
      if (!p.history) return null;
      const un = listenServer(world, dev, liveQ(LOTS_HISTORY_LIMIT), (rows, snap) => { app.history = rows; ctl.onWindow('history', rows, snap, 'server'); schedule(); });
      return () => { un(); ctl.windowOff('history', 'server'); };
    });
  };
  ctl = createLotsDeltaSync({
    ns: NS, enabled, storage: dev.storage, now: world.now,
    getCachedLots: async () => [...dev.cache.values()].map(cachedRowOf),
    openDelta: (since, next, onErr) => listenServer(world, dev, deltaQ(since), next, { map: (d) => ({ id: d.id, u: tsMs(d.updatedAt), pending: false }) }),
    openTombs: (since, next) => listenServer(world, dev, tombQ(since), next, { lots: false }),
    refetch: async (id) => { dev.reads += 1; resolveDoc(world, dev, id); dev.notify(); return world.server.has(id); },
    count: async (spec) => { dev.reads += 1; return countOf(world.server, spec); },
    setSource: (s) => { app.src = s; schedule(); },
    onQuota: (e) => { throw e; },
    setTimer: (f) => { timers.push(f); return f; },
    clearTimer: (f) => { const i = timers.indexOf(f); if (i >= 0) timers.splice(i, 1); },
    log: (m) => app.logs.push(m),
    ...overrides,
  });
  ctl.start();
  return {
    app, ctl, timers,
    rows: () => lotsRawOf(app),
    wantHistory() { app.historyWanted = true; schedule(); },
    close() { closed = true; ctl.stop(); for (const k of Object.keys(subs)) if (subs[k] && subs[k].cleanup) subs[k].cleanup(); },
  };
};
const settle = async (...sessions) => {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setImmediate(r));
    for (const s of sessions) while (s.timers.length) s.timers.shift()();
  }
};

/** 他の端末がする操作を1つ。 */
const randomOp = (world, { tombless = 0 } = {}) => {
  const r = world.rand();
  if (r < 0.25) {
    world.put(world.newId(), { createdAt: world.now(), status: 'waiting', model: `M${Math.floor(world.rand() * 9)}` });
  } else if (r < 0.31) {
    // 一括取込: 同じ時刻で何十件(120件目の境目に同じ時刻が並ぶ形)
    const at = world.now();
    const n = 5 + Math.floor(world.rand() * 40);
    for (let i = 0; i < n; i++) world.put(world.newId(), { createdAt: at, status: world.rand() < 0.5 ? 'waiting' : 'completed' });
  } else if (r < 0.55) {
    const id = world.pick(); if (id) world.put(id, { memo: `m${Math.floor(world.rand() * 1e6)}` });
  } else if (r < 0.68) {
    const id = world.pick(); if (id) world.put(id, { status: 'completed', completedAt: world.now() });
  } else if (r < 0.76) {
    const id = world.pick(); if (id) world.put(id, { status: 'processing' });   // 再開(完了から戻す)
  } else if (r < 0.92) {
    const id = world.pick(); if (id) world.del(id, { withTomb: world.rand() >= tombless });
  } else {
    // 窓の上の方をまとめて消す(①の120件目が前回の範囲の下へ伸びる形)
    const top = liveQ(LOTS_LIVE_LIMIT)(world.server);
    const n = 1 + Math.floor(world.rand() * 6);
    for (let i = 0; i < n && top.length; i++) {
      const j = Math.floor(world.rand() * top.length);
      world.del(top.splice(j, 1)[0].id, { withTomb: world.rand() >= tombless });
    }
  }
};

const seedLots = (world, n) => {
  for (let i = 0; i < n; i++) {
    const r = world.rand();
    world.put(world.newId(), { createdAt: world.now(), status: r < 0.3 ? 'waiting' : 'completed' });
    if (world.rand() < 0.1) world.tick(0); else world.tick(60000);
  }
};

/**
 * 何日分も開き直して、全部読みの端末 A と差分読みの端末 B の画面のロットを比べる。
 * @returns {{ mismatches, deltaOpens, opens, readsA, readsB, logs }}
 */
const runScenario = async (seed, { initial = 200, days = 12, opsClosed = 8, opsOpen = 10, tombless = 0, tomblessOpen = 0, gc = 0.15, overridesB = {}, strict = true } = {}) => {
  const world = makeWorld(seed);
  const devA = makeDevice();
  const devB = makeDevice();
  seedLots(world, initial);
  let mismatches = 0;
  let openReadsA = 0;
  let openReadsB = 0;
  let deltaOpens = 0;
  let opens = 0;
  const logs = [];
  const compare = (A, B, where) => {
    const a = keyOf(A.rows());
    const b = keyOf(B.rows());
    if (a === b) return;
    mismatches++;
    if (!strict) return;
    // 食い違いを短く言う(どの id が 多い/少ない/版が違う/並びが違う)
    const ma = new Map(A.rows().map((r) => [r.id, `${tsMs(r.updatedAt)}:${r.status}`]));
    const mb = new Map(B.rows().map((r) => [r.id, `${tsMs(r.updatedAt)}:${r.status}`]));
    const missing = [...ma.keys()].filter((id) => !mb.has(id));
    const extra = [...mb.keys()].filter((id) => !ma.has(id));
    const ver = [...ma.keys()].filter((id) => mb.has(id) && ma.get(id) !== mb.get(id)).map((id) => `${id}(${mb.get(id)}→${ma.get(id)})`);
    const inServer = (id) => (world.server.has(id) ? 'サーバに在る' : 'サーバに無い');
    assert.fail(`seed ${seed} ${where}: 差分読みの画面のロットが全部読みと違う 足りない[${missing.map((id) => `${id}:${inServer(id)}`).join(' ')}] 多い[${extra.map((id) => `${id}:${inServer(id)}`).join(' ')}] 版[${ver.join(' ')}] 並び${missing.length + extra.length + ver.length ? '' : 'だけ違う'} 件数 A${ma.size}/B${mb.size} A:${JSON.stringify({ whole: A.app.whole, hist: A.app.history && A.app.history.length, open: A.app.open.length })} B:${JSON.stringify({ whole: B.app.whole, hist: B.app.history && B.app.history.length, open: B.app.open.length, ...B.ctl.info() })} / ${B.app.logs.join(' / ')}`);
  };
  for (let day = 0; day < days; day++) {
    // 閉じている間: 時間が進み、他の端末が書く。控えの掃除(LRU)も起きる
    world.tick((day % 5 === 4 ? 8 * DAY : Math.floor((1 + world.rand() * 20) * 3600000)));
    for (let k = 0; k < opsClosed; k++) randomOp(world, { tombless });   // 墓標を残さない古い版の端末は、閉じている間に書く
    world.notify();
    if (gc && world.rand() < 0.3) devB.gc(world.rand, gc);
    const r0A = devA.reads; const r0B = devB.reads;
    const A = openApp(world, devA, { enabled: false });
    const B = openApp(world, devB, { overrides: typeof overridesB === 'function' ? overridesB(devB) : overridesB });
    await settle(A, B);
    openReadsA += devA.reads - r0A; openReadsB += devB.reads - r0B;
    opens++;
    if (B.ctl.info().mode === 'delta') deltaOpens++;
    compare(A, B, `day ${day} 開いた直後`);
    const historyAt = world.rand() < 0.35 ? Math.floor(world.rand() * opsOpen) : -1;
    for (let k = 0; k < opsOpen; k++) {
      if (k === historyAt) { A.wantHistory(); B.wantHistory(); }
      if (world.rand() < 0.1) { world.tick(DELTA_WAKE_GAP_MS + 60000); B.ctl.wake(DELTA_WAKE_GAP_MS + 60000); }
      randomOp(world, { tombless: tomblessOpen });
      world.notify();
      await settle(A, B);
      if (tomblessOpen) { B.ctl.recheck(); await settle(A, B); }   // 30分ごとの確かめ直しが来た所
      compare(A, B, `day ${day} 操作 ${k}`);
    }
    logs.push(`day${day}: ${B.ctl.info().mode} ${B.app.logs.join(' / ')}`);
    A.close();
    B.close();
    await settle(A, B);
  }
  return { mismatches, deltaOpens, opens, readsA: devA.reads, readsB: devB.reads, openReadsA, openReadsB, logs };
};

test('DS10 🚨 上位N件の範囲(ロット200件〜): 何日分 開き直しても、差分読みの画面のロットは全部読みと1件も違わない', async () => {
  let delta = 0; let opens = 0; let oA = 0; let oB = 0;
  const logs = [];
  for (const seed of [1, 2, 3, 5, 8, 13, 21, 34]) {
    const r = await runScenario(seed, { initial: 200 + seed * 7 });
    delta += r.deltaOpens; opens += r.opens; oA += r.openReadsA; oB += r.openReadsB; logs.push(...r.logs);
  }
  // 差分読みが本当に使われている事(全部読みへ逃げてばかりなら試験の意味が無い)
  assert.ok(delta >= opens * 0.3, `差分読みで開けたのが ${delta}/${opens} 回しかない`);
  // 見張り(①の窓が前回の範囲の下へ伸びた)と墓標の読み直しの道を、写しが本当に通っている事
  assert.ok(logs.some((l) => /範囲より下へ伸びた|件に届かない/.test(l)), '①の窓が範囲の下へ伸びる形を写しが一度も作っていない');
  console.log(`   [DS10] 開いた ${opens}回のうち差分読み ${delta}回・開いた時の読み(写しの数え方) 全部読み ${oA} / 差分読み ${oB}`);
});

test('DS11 🚨 ロット全部の範囲(120件未満から始めて120件を超えて育つ): 全部読みと1件も違わない', async () => {
  let delta = 0; let opens = 0; let oA = 0; let oB = 0;
  for (const seed of [4, 6, 9, 11, 17, 29]) {
    const r = await runScenario(seed, { initial: 30 + seed * 3, days: 14 });
    delta += r.deltaOpens; opens += r.opens; oA += r.openReadsA; oB += r.openReadsB;
  }
  assert.ok(delta >= opens * 0.3, `差分読みで開けたのが ${delta}/${opens} 回しかない`);
  console.log(`   [DS11] 開いた ${opens}回のうち差分読み ${delta}回・開いた時の読み(写しの数え方) 全部読み ${oA} / 差分読み ${oB}`);
});

test('DS12 🚨 墓標を残さない古い版の削除が混ざっても(件数の確かめで全部読みへ戻る)、全部読みと1件も違わない', async () => {
  const logs = [];
  for (const seed of [7, 19, 23, 31]) logs.push(...(await runScenario(seed, { initial: seed % 2 ? 60 : 220, tombless: 0.5 })).logs);
  assert.ok(logs.some((l) => l.includes('件数が合わない')), '件数の確かめで全部読みへ戻る道を写しが一度も通っていない');
});

test('DS13 🚨 控えの掃除が多い端末(毎回4割が消える)でも、全部読みと1件も違わない', async () => {
  for (const seed of [37, 41, 43]) await runScenario(seed, { initial: seed % 2 ? 80 : 240, gc: 0.4 });
});

test('DS14 🚨 ロット0件(部品の本番の今)から始めても、全部読みと1件も違わない', async () => {
  for (const seed of [47, 53]) await runScenario(seed, { initial: 0, days: 10 });
});

test('DS18 開いている間に古い版の端末が墓標なしで消しても、30分ごとの件数の確かめ直しで全部読みへ戻り、全部読みと同じになる', async () => {
  for (const seed of [59, 61]) await runScenario(seed, { initial: seed % 2 ? 70 : 210, tomblessOpen: 0.5, days: 6 });
});

// ─── 負の対照: 写しが本当に食い違いを見つけるか ─────────────────────────────
test('DS15 負の対照: 墓標を読まない(かつ件数を確かめない)と、写しが食い違いを見つける', async () => {
  let found = 0;
  for (const seed of [1, 4, 9, 13]) {
    const r = await runScenario(seed, { initial: seed % 2 ? 60 : 200, strict: false, overridesB: {
      openTombs: (since, next) => { queueMicrotask(() => next([], snapOf([], false, 0))); return () => {}; },
      count: undefined,
    } });
    found += r.mismatches;
  }
  assert.ok(found > 0, '墓標を読まなくても食い違いが見つからない = 写しが削除を試していない');
});

test('DS16 負の対照: 控えの突き合わせを嘘にする(控え帳どおりの控えが在ると言う)と、控えの掃除で写しが食い違いを見つける', async () => {
  let found = 0;
  for (const seed of [4, 6, 9]) {
    // 控え帳に書いてある版のロットが全部そろっている、と嘘をつく(実際の控えは掃除で欠けている)
    const lieOf = (dev) => async () => {
      const raw = dev.storage.get(deltaStateKey(NS));
      const st = raw ? JSON.parse(raw) : { manifest: {} };
      return Object.entries(st.manifest || {}).map(([id, m]) => ({ id, createdAt: m[1], status: m[2] ? 'waiting' : 'completed', u: m[0], stamp: true, pending: false }));
    };
    const r = await runScenario(seed, { initial: 40, gc: 0.5, strict: false, overridesB: (dev) => ({ getCachedLots: lieOf(dev), count: undefined }) });
    found += r.mismatches;
  }
  assert.ok(found > 0, '突き合わせを嘘にしても食い違いが見つからない = 写しが控えの掃除を試していない');
});

test('DS17 負の対照: 件数を確かめないと、墓標を残さない古い版の削除で写しが食い違いを見つける', async () => {
  let found = 0;
  for (const seed of [7, 19, 23]) {
    const r = await runScenario(seed, { initial: 60, tombless: 1, strict: false, gc: 0, overridesB: { count: undefined } });
    found += r.mismatches;
  }
  assert.ok(found > 0, '件数を確かめなくても食い違いが見つからない = 写しが古い版の削除を試していない');
});

// ─── 配線(App.jsx・窓口・地図) ────────────────────────────────────────────
test('DS20 lots を書く道は全部 updatedAt(サーバの時刻)を付ける: saveData・札の戻し・該当なしの掃除(setFields)', () => {
  const app = read('App.jsx');
  assert.ok(app.includes("write: (w) => DATA(db).save(APP_DATA_ID, w.col, w.id, { ...w.body, updatedAt: DATA_SERVER_NOW }, w.opts),"), 'saveData が updatedAt を付けていない');
  assert.ok(app.includes('DATA(db).save(APP_DATA_ID, col, id, { steps: restored, updatedAt: DATA_SERVER_NOW })'), '札の戻しが updatedAt を付けていない');
  const setFieldsLots = app.split('\n').filter((l) => /setFields\(APP_DATA_ID, 'lots'/.test(l));
  assert.ok(setFieldsLots.length >= 3, '該当なしの掃除(setFields)が見つからない');
  for (const l of setFieldsLots) assert.ok(l.includes('updatedAt: DATA_SERVER_NOW'), `setFields が updatedAt を付けていない: ${l.trim()}`);
  // ロットを直に書く道(saveData 以外)を増やしていない
  const direct = app.split('\n').filter((l) => /DATA\(db\)\.(save|setFields|claimOnce|createOnce|commitVersion|appendCapped)\(APP_DATA_ID, 'lots'/.test(l));
  assert.deepEqual(direct.filter((l) => !l.includes('setFields')), [], 'ロットを saveData を通さずに書く道が増えた');
});

test('DS21 ロットを消す道(deleteData)は、消す前に墓標 lots_deleted/{id} = {lotId, deletedAt:サーバの時刻} を置く', () => {
  const app = read('App.jsx');
  const at = app.indexOf('const deleteData = async (col, id) => {');
  assert.ok(at > 0);
  const body = app.slice(at, at + 4000);
  const tomb = body.indexOf('DATA(db).save(APP_DATA_ID, LOTS_TOMB_COL, id, tombDocOf(id, DATA_SERVER_NOW), { merge: false })');
  const rm = body.indexOf('await DATA(db).remove(APP_DATA_ID, col, id);');
  assert.ok(tomb > 0 && rm > 0 && tomb < rm, '墓標を消す前に置いていない');
  assert.ok(body.slice(0, tomb).includes("if (col === 'lots') {"), '墓標をロット以外にも置いている');
  // ロットを消すのは deleteData だけ(窓口の remove を直に呼ばない)
  const directRemove = app.split('\n').filter((l) => /\.remove\(APP_DATA_ID, 'lots'/.test(l));
  assert.deepEqual(directRemove, [], 'ロットを deleteData を通さずに消す道がある(墓標が置かれない)');
});

test('DS22 ①②は差分読みの時だけ端末の控えに張る(問い合わせの字面は今までと同じ)・③過去はサーバのまま', () => {
  const app = read('App.jsx');
  assert.ok(app.includes("}, { orderBy: [['createdAt', 'desc']], limit: LOTS_LIVE_LIMIT, includeMetadataChanges: true, ...(src === 'cache' ? { source: 'cache' } : {}), onError:"), '①に控えの張り方が無い');
  assert.ok(app.includes("}, { where: [['status', '!=', 'completed']], limit: OPEN_LOTS_LIMIT, includeMetadataChanges: true, ...(src === 'cache' ? { source: 'cache' } : {}), onError:"), '②に控えの張り方が無い');
  assert.ok(app.includes("}, { orderBy: [['createdAt', 'desc']], limit: LOTS_HISTORY_LIMIT, includeMetadataChanges: true, onError:"), '③過去の字面が変わった');
  assert.ok(app.includes("lotsDeltaRef.current.onWindow('live', rows, snap, src);"));
  assert.ok(app.includes("lotsDeltaRef.current.onWindow('open', rows, snap, src);"));
  // 2026-10-01: 枠切れの後の張り直しの合図(readRetryToken)を依存に足した
  assert.ok(app.includes("}, [user, db, lotSubPlan.live, lotsSrc, countReads, noteReadError, readRetryToken]);"), '①が張る所の変化で張り直さない');
  assert.ok(app.includes("}, [lotSubPlan.open, lotsSrc, user, db, countReads, noteReadError, readRetryToken]);"), '②が張る所の変化で張り直さない');
  assert.ok(app.includes("if (!lotsSrc || lotsSrc === 'stopped') return;"), '①が張る所を決める前に張っている');
  assert.ok(app.includes('LOTS_CACHE.persistent = true;'), '端末の控えを作れた印が無い');
  assert.ok(app.includes("const enabled = !!(LOTS_CACHE.persistent && backendOf('lots') === 'firebase' && backendOf(LOTS_TOMB_COL) === 'firebase');"));
  assert.ok(/const FS_API = \{[^}]*getDocsFromCache[^}]*getDocFromServer[^}]*getCountFromServer/.test(app), 'FS_API に控えだけ読む・1件読み直す・件数だけ が無い');
  assert.ok(app.includes("const cacheOnly = !!(hasOpts && rest[0] && rest[0].source === 'cache');"), '控えだけの購読を課金の見込みに載せている');
});

test('DS25 🚨 ②と墓標も「サーバで確かめた」合図を受ける(includeMetadataChanges)。前の版の控えを持つ端末で控え帳が1度も書かれなかった(製品の写しで再現 2026-09-28)', () => {
  // 最初の答えが控えから(fromCache)来て、サーバは「変わり無し」と確かめるだけの時、includeMetadataChanges の無い購読には
  //   その合図が来ない → ②の server が立たず(①が上限の日は)控え帳が書けない・墓標の tombServer が立たず差分読みの控え帳が書けない。
  const app = read('App.jsx');
  assert.ok(app.includes("}, { where: [['status', '!=', 'completed']], limit: OPEN_LOTS_LIMIT, includeMetadataChanges: true, ...(src === 'cache' ? { source: 'cache' } : {}), onError:"), '②が「サーバで確かめた」合図を受けない');
  assert.ok(/openTombs: \(sinceMs, next, onErr\) => P\.watchQuery\(APP_DATA_ID, LOTS_TOMB_COL, \{ where: \[\['deletedAt', '>', new Date\(sinceMs\)\]\], orderBy: \[\['deletedAt', 'asc'\]\], limit: TOMB_LIMIT \}, metered\('lots_deleted\(墓標\)', next\),\s*\{ includeMetadataChanges: true, onError: onErr \}\)/.test(app), '墓標が「サーバで確かめた」合図を受けない');
  // ⚠ 合図だけの答えは画面(setOpenLots・読みの数え)へ流さない = 再描画と読みメーターは今までと同じ
  assert.ok(app.includes("if (openMetaOnly) { if (lotsDeltaRef.current) lotsDeltaRef.current.onWindow('open', rows, snap, src); return; }"), '合図だけの答えで ②の画面を描き直している');
});

test('DS26 差分・墓標・指図の取り寄せの口は絞り込みを字面で書き、中身は決まりの関数と同じ(読み取りの枠の見張りが where を静的に読める・2026-09-30)', async () => {
  const app = read('App.jsx');
  // 差分: deltaLotsSpec と同じ where / orderBy / limit
  assert.ok(app.includes("P.watchQuery(APP_DATA_ID, 'lots', { where: [['updatedAt', '>', new Date(sinceMs)]], orderBy: [['updatedAt', 'asc']], limit: DELTA_LIMIT }, metered('lots(差分)', next),"), '差分の口の字面が変わった');
  assert.deepEqual(deltaLotsSpec(1000), { where: [['updatedAt', '>', new Date(1000)]], orderBy: [['updatedAt', 'asc']], limit: DELTA_LIMIT });
  // 墓標: tombLotsSpec と同じ
  assert.ok(app.includes("P.watchQuery(APP_DATA_ID, LOTS_TOMB_COL, { where: [['deletedAt', '>', new Date(sinceMs)]], orderBy: [['deletedAt', 'asc']], limit: TOMB_LIMIT }, metered('lots_deleted(墓標)', next),"), '墓標の口の字面が変わった');
  assert.deepEqual(tombLotsSpec(1000), { where: [['deletedAt', '>', new Date(1000)]], orderBy: [['deletedAt', 'asc']], limit: TOMB_LIMIT });
  // 指図の取り寄せ(進捗表の取込・30指図ずつ): orderNoLotsSpec と同じ
  const { orderNoLotsSpec } = await import('../importExistingCheck.js');
  assert.ok(app.includes("DATA(db).getPage(APP_DATA_ID, 'lots', { where: [['orderNo', 'in', [...chunk]]] }, { source: 'server' });"), '指図の取り寄せの字面が変わった');
  assert.deepEqual(orderNoLotsSpec(['A', 'B']), { where: [['orderNo', 'in', ['A', 'B']]] });
  // 過去の取り寄せは製品と同じ形(決まりの関数を変数に入れて渡す)
  assert.ok(app.includes("const LOTS_ARCHIVE_SPEC = archiveLotsSpec(before);"));
  assert.ok(app.includes("DATA(db).getPage(APP_DATA_ID, 'lots', LOTS_ARCHIVE_SPEC, {});"));
});

test('DS23 窓口: source を渡さない時の Firestore の呼び方は今までと同じ・控えだけ読む/1件読み直す/件数だけ が在る', async () => {
  const { createFirebaseBackend } = await import('../../data/provider.js');
  const calls = [];
  const fsApi = {
    collection: (...a) => ({ path: a.slice(1).join('/') }), doc: (...a) => ({ path: a.slice(1).join('/') }),
    onSnapshot: (...a) => { calls.push(a.length === 4 || (a.length === 3 && typeof a[1] === 'object') ? a[1] : null); return () => {}; },
    setDoc: async () => {}, deleteDoc: async () => {}, getDocs: async () => ({ docs: [] }), getDoc: async () => ({}),
    serverTimestamp: () => 'ST', deleteField: () => 'DF', updateDoc: async () => {}, runTransaction: async () => {},
    query: (b, ...p) => ({ b, p }), where: (...a) => ['where', ...a], orderBy: (...a) => ['orderBy', ...a], limit: (n) => ['limit', n],
    getDocsFromCache: async () => ({ docs: [{ id: 'a', data: () => ({ x: 1 }) }] }),
    getDocFromServer: async () => ({ exists: () => false }),
    getCountFromServer: async () => ({ data: () => ({ count: 7 }) }),
  };
  const be = createFirebaseBackend({}, fsApi);
  be.watchCollection('ns', 'lots', () => {}, { orderBy: [['createdAt', 'desc']], limit: 1 });
  be.watchCollection('ns', 'lots', () => {}, { includeMetadataChanges: true, onError: () => {} });
  be.watchCollection('ns', 'lots', () => {}, { includeMetadataChanges: true, source: 'cache', onError: () => {} });
  be.watchQuery('ns', 'lots', { limit: 1 }, () => {}, { source: 'cache' });
  assert.deepEqual(calls, [null, { includeMetadataChanges: true }, { includeMetadataChanges: true, source: 'cache' }, { source: 'cache' }]);
  assert.deepEqual(await be.getCachedDocs('ns', 'lots', {}), [{ x: 1, id: 'a' }]);
  assert.equal(await be.refreshDocFromServer('ns', 'lots', 'a'), false);
  assert.equal(await be.countQuery('ns', 'lots', { where: [['status', '!=', 'completed']] }), 7);
});

test('DS24 地図: lots_deleted は検査本体の棚・部品も使う', async () => {
  const { COLLECTION_AREA, COLLECTION_APPS } = await import('../../data/routes.js');
  assert.equal(COLLECTION_AREA.lots_deleted, 'inspection');
  assert.ok(COLLECTION_APPS.lots_deleted.includes('parts'));
});

// ─── 🪦 連休明け(2026-10-03): 日数では全部読みに戻さない。上限は墓標の保持期間 ─────────────
test('DS27 tombsCover: 無期限なら何日でも拾える・有限なら保持期間 − 糊しろ1日 まで・時刻が読めなければ拾えない扱い', () => {
  assert.equal(TOMB_RETENTION_MS, Infinity, '墓標を消す処理を足したら、ここと DS30 を一緒に直す');
  assert.equal(tombsCover(0, 3650 * DAY), true);
  assert.equal(tombsCover(0, 8 * DAY, 10 * DAY), true);
  assert.equal(tombsCover(0, 9 * DAY, 10 * DAY), false);
  assert.equal(tombsCover(0, 9 * DAY, 0), false);
  assert.equal(tombsCover(NaN, DAY), false);
  assert.equal(tombsCover(0, NaN), false);
});

/** 1回目: 全部読みの端末 A と差分読みの端末 B を開いて閉じる。休みの days 日(毎日 ops 件・pruneMs を超えた墓標は消す)。2回目を開いて比べる。 */
const holidayScenario = async (seed, { initial = 220, days = 30, ops = 2, tombless = 0, pruneMs = null, overridesB = {} } = {}) => {
  const world = makeWorld(seed);
  const devA = makeDevice(); const devB = makeDevice();
  seedLots(world, initial);
  let A = openApp(world, devA, { enabled: false });
  let B = openApp(world, devB, { overrides: overridesB });
  await settle(A, B); A.close(); B.close(); await settle(A, B);
  for (let d = 0; d < days; d++) {
    world.tick(DAY);
    for (let k = 0; k < ops; k++) randomOp(world, { tombless });
    if (pruneMs != null) for (const [id, t] of [...world.tombs]) if (tsMs(t.deletedAt) < world.now() - pruneMs) world.tombs.delete(id);
  }
  world.notify();
  const r0A = devA.reads; const r0B = devB.reads;
  A = openApp(world, devA, { enabled: false });
  B = openApp(world, devB, { overrides: overridesB });
  await settle(A, B);
  const out = { A, B, world, readsA: devA.reads - r0A, readsB: devB.reads - r0B, same: keyOf(A.rows()) === keyOf(B.rows()) };
  A.close(); B.close(); await settle(A, B);
  return out;
};

test('DS28 🚨 30日 開かなかった端末(連休明け)でも差分で開き、全部読みと1件も違わない', async () => {
  for (const seed of [3, 11, 27]) {
    const r = await holidayScenario(seed, { initial: seed % 2 ? 220 : 80 });
    assert.ok(r.same, `seed ${seed}: 30日ぶりの画面が全部読みと違う / ${r.B.app.logs.join(' / ')}`);
    assert.ok(!r.B.app.logs.some((l) => l.includes('全部読み')), `seed ${seed}: 30日ぶりでも全部読みしない: ${r.B.app.logs.join(' / ')}`);
    assert.ok(r.B.app.logs.some((l) => l.includes('前回の続きだけ読みます')), `seed ${seed}: 30日ぶりに差分で開いていない: ${r.B.app.logs.join(' / ')}`);
    assert.ok(r.readsB < r.readsA, `seed ${seed}: 30日ぶりの読み 差分 ${r.readsB} は全部読み ${r.readsA} より少ない`);
  }
  // 墓標を残さない古い版の削除が混ざると、件数の確かめで全部読みへ戻り、画面は全部読みと同じ
  const g = await holidayScenario(5, { tombless: 1, ops: 6 });
  assert.ok(g.same, `墓標なしの削除の後の画面が全部読みと違う / ${g.B.app.logs.join(' / ')}`);
});

test('DS29 🚨 墓標の保持期間(有限にした時)より長く休んだ端末は全部読み(墓標が消えていて差分では拾えない)。保持期間の内なら差分', async () => {
  const R = 10 * DAY;
  const over = await holidayScenario(13, { days: 12, ops: 3, pruneMs: R, overridesB: { tombRetentionMs: R } });
  assert.ok(over.B.app.logs.some((l) => l.includes('墓標の保持期間')), over.B.app.logs.join(' / '));
  assert.ok(over.same, `保持期間を超えた後の画面が全部読みと違う / ${over.B.app.logs.join(' / ')}`);
  const within = await holidayScenario(17, { days: 7, ops: 3, pruneMs: R, overridesB: { tombRetentionMs: R } });
  assert.ok(!within.B.app.logs.some((l) => l.includes('全部読み')), within.B.app.logs.join(' / '));
  assert.ok(within.same, `保持期間の内の画面が全部読みと違う / ${within.B.app.logs.join(' / ')}`);
});

/** 消す呼び出し remove( / delete( / deleteDoc( / deleteData( / purge…( / clear…( の括弧の中身(入れ子ごと)に name が在るか。 */
const deleteCallsNaming = (text, name) => {
  const re = /\b(remove|deleteDoc|deleteData|delete|purge\w*|clear\w*)\s*\(/g;
  let m;
  while ((m = re.exec(text))) {
    let depth = 1; let i = re.lastIndex;
    while (i < text.length && depth > 0) { const c = text[i]; if (c === '(') depth++; else if (c === ')') depth--; i++; }
    if (name.test(text.slice(re.lastIndex, i))) return true;
  }
  return false;
};

test('DS30a 墓標を消す道の見張りは、本当に消す呼び出しを見つける(壊して赤を見る)', () => {
  const N = /lots_deleted|LOTS_TOMB_COL/;
  assert.equal(deleteCallsNaming('DATA(db).remove(APP_DATA_ID, LOTS_TOMB_COL, id)', N), true);
  assert.equal(deleteCallsNaming("batch.delete(doc(db, base(ns), 'lots_deleted', id))", N), true);
  assert.equal(deleteCallsNaming("deleteDoc(doc(db, 'artifacts', ns, 'public', 'data', LOTS_TOMB_COL, id))", N), true);
  assert.equal(deleteCallsNaming('DATA(db).save(APP_DATA_ID, LOTS_TOMB_COL, id, tombDocOf(id, DATA_SERVER_NOW), { merge: false })', N), false, '書くのは消すではない');
  assert.equal(deleteCallsNaming('deleteData(col, id); const x = LOTS_TOMB_COL;', N), false);
});

test('DS30 🚨 墓標(lots_deleted)を消す道・TTL が無い(= 保持期間は無期限)。足したら TOMB_RETENTION_MS をその長さにする', () => {
  const root = new URL('../../../', import.meta.url);
  const files = [];
  const walk = (u) => {
    for (const e of fs.readdirSync(u, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '__tests__' || e.name.startsWith('.')) continue;
      const c = new URL(e.name + (e.isDirectory() ? '/' : ''), u);
      if (e.isDirectory()) walk(c);
      else if (/\.(m?js|cjs|jsx|ts)$/.test(e.name)) files.push(c);
    }
  };
  for (const d of ['src/', 'scripts/']) { const u = new URL(d, root); if (fs.existsSync(u)) walk(u); }
  assert.ok(files.length > 20, '見る物が少なすぎる(道を間違えている)');
  const N = /lots_deleted|LOTS_TOMB_COL/;
  const bad = [];
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    if (!N.test(t)) continue;
    if (deleteCallsNaming(t, N)) bad.push(decodeURIComponent(f.pathname));
  }
  assert.deepEqual(bad, [], '墓標を消す道が在る → TOMB_RETENTION_MS を保持期間に合わせ、DS27 を直す');
  for (const name of ['firestore.indexes.json', 'firebase.json']) {
    const u = new URL(name, root);
    if (!fs.existsSync(u)) continue;
    const j = fs.readFileSync(u, 'utf8');
    assert.ok(!/"ttl"\s*:\s*true/i.test(j), `${name} に TTL が在る → 墓標の保持期間が有限になる`);
  }
});
