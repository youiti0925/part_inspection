// 目的: 「登録の受け取りページが端末に書く札」の鍵と形を4アプリで固定する(設計 §6・T12)。鍵や形を変えたら赤。
// 入力: このアプリの札の読み手(readSession)と、受け取りページが書く見本(鍵 onprem.deviceSession.v1・形 {v:1, collection, token, recordId, email, label, savedAt, refreshedAt})。
// 出力: node --test の合否。
// 呼ぶ人: npm test / npm run check。
// 触る外の物: 無し(見本の保管場所は試験の中の Map)。
// 確かめ方: SESSION_KEY の文字を変える/形の判定(v・token)を変えると赤になる。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readDeviceSession as readSession, DEVICE_SESSION_KEY as SESSION_KEY } from '../../onpremDevice.js';

// 受け取りページ(サーバー側 /__join/v1/enter)が書く見本。4つの枝の試験で同じ物を使う。
const SAMPLE = Object.freeze({ v: 1, collection: 'device_users', token: 'tok.en.sample', recordId: 'rec1', email: 'dev@example.invalid', label: '現場PC1', savedAt: '2026-11-27T00:00:00.000Z', refreshedAt: '2026-11-27T00:00:00.000Z' });
const mem = (init = {}) => { const m = new Map(Object.entries(init)); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

test('JC1 札の鍵は onprem.deviceSession.v1(受け取りページと同じ・変えたら赤)', () => {
  assert.equal(SESSION_KEY, 'onprem.deviceSession.v1');
});

test('JC2 受け取りページが書いた形を readSession が読める(そのまま・欄を落とさない)', () => {
  const s = readSession(mem({ 'onprem.deviceSession.v1': JSON.stringify(SAMPLE) }));
  assert.deepEqual(s, SAMPLE);
});

test('JC3 形が違う札・token が空・別の鍵に書いた札は読まない(null)', () => {
  assert.equal(readSession(mem({ 'onprem.deviceSession.v1': JSON.stringify({ ...SAMPLE, v: 2 }) })), null);
  assert.equal(readSession(mem({ 'onprem.deviceSession.v1': JSON.stringify({ ...SAMPLE, token: '' }) })), null);
  assert.equal(readSession(mem({ 'onprem.deviceSession.v2': JSON.stringify(SAMPLE) })), null);
  assert.equal(readSession(mem({ 'onprem.deviceSession.v1': '{壊れた' })), null);
});
