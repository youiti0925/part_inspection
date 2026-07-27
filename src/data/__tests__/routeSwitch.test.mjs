// ============================================================================
// 保存先の切替(設定 → どの保管庫を使うか)
// ----------------------------------------------------------------------------
// ⚠⚠ここが緩むと、**設定の読み違いで本番のデータが別の場所へ書かれる**。
//   既定は必ず Firebase。はっきり有効にした時だけ切り替わること。
//   連絡と通知は指定されても動かないこと(相手の携帯が4G/5Gで、社内LANのPocketBaseには届かない)。
//
// ⚠この試験は4アプリすべて同一。routes.test.mjs はアプリごとに中身が違うので、
//   共通の試験をあちらに書き足さないこと(2026-07-28 に上書きして1つ壊した)。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { AREAS, DEFAULT_PROVIDERS, providersFromSettings, providersSummary } from '../routes.js';

test('RS01 設定が無い/不完全なら、必ず今までどおり Firebase のまま', () => {
  for (const cfg of [undefined, null, {}, { enabled: true }, { url: 'http://x' },
    { enabled: 'true', url: 'http://x' }, { enabled: 1, url: 'http://x' },
    { enabled: true, url: '' }, { enabled: true, url: 123 }, { enabled: false, url: 'http://x' }]) {
    assert.deepEqual(providersFromSettings(cfg), DEFAULT_PROVIDERS, JSON.stringify(cfg));
  }
});

test('RS02 はっきり有効にした時だけ切り替わる。⚠連絡と通知は動かさない', () => {
  const p = providersFromSettings({ enabled: true, url: 'http://192.168.1.50:8090' });
  assert.equal(p.inspection, 'pocketbase');
  assert.equal(p.attachments, 'pocketbase');
  assert.equal(p.analytics, 'pocketbase');
  assert.equal(p.goals, 'pocketbase');
  assert.equal(p.contact, 'firebase', '⚠連絡は Firebase のまま(相手の携帯が4G/5G)');
  assert.equal(p.push, 'firebase', '⚠通知も Firebase のまま');
});

test('RS03 領域ごとに段階的に移せる。⚠連絡・通知は指定されても動かない', () => {
  const p = providersFromSettings({
    enabled: true, url: 'http://x',
    areas: { inspection: 'pocketbase', attachments: 'firebase', analytics: 'firebase', goals: 'firebase', contact: 'pocketbase', push: 'pocketbase' },
  });
  assert.equal(p.inspection, 'pocketbase');
  assert.equal(p.attachments, 'firebase');
  assert.equal(p.contact, 'firebase', '⚠指定されても連絡は移さない');
  assert.equal(p.push, 'firebase', '⚠指定されても通知は移さない');
});

test('RS04 今どこへ書いているかを人が読める形で出せる', () => {
  const rows = providersSummary(providersFromSettings({ enabled: true, url: 'http://x' }));
  assert.equal(rows.length, AREAS.length);
  assert.deepEqual(rows.find((r) => r.area === 'contact'), { area: 'contact', backend: 'firebase', label: '連絡' });
  assert.equal(rows.find((r) => r.area === 'inspection').backend, 'pocketbase');
  assert.ok(rows.every((r) => r.label && r.backend));
});

test('RS05 返ってくる設定は書き換えられない(あとから誰かが差し替えられない)', () => {
  const p = providersFromSettings({ enabled: true, url: 'http://x' });
  assert.throws(() => { p.contact = 'pocketbase'; }, TypeError);
});
