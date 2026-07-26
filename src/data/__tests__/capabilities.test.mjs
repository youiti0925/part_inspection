import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPABILITY_KEYS, ATOMIC_PRIMITIVE_KEYS, UNVERIFIED,
  FIREBASE_CAPABILITIES, POCKETBASE_CAPABILITIES,
  unverifiedCapabilities, can, docLimitOf, capabilityGaps, applyEvidence,
} from '../capabilities.js';

test('C01 能力表の項目は決め打ちの8つ', () => {
  assert.deepEqual([...CAPABILITY_KEYS], [
    'realtime', 'offlineWrites', 'atomicWrite', 'fileStorage',
    'serverTimestamp', 'mapKeyDelete', 'nestedArrays', 'docSizeLimit',
  ]);
  assert.deepEqual([...ATOMIC_PRIMITIVE_KEYS], ['claimOnce', 'compareAndSet', 'increment', 'multiRecordTransaction']);
});

test('C02 ⚠移行の分かれ目: オフライン書き込みは PocketBase に無い', () => {
  // Firestore は persistentLocalCache で電波が切れても保存が貯まる。現場の Wi-Fi は切れる。
  // PocketBase は貯まらない = 自前で作らないと「保存したのに消える」。
  assert.equal(FIREBASE_CAPABILITIES.offlineWrites, true);
  assert.equal(POCKETBASE_CAPABILITIES.offlineWrites, false);
});

test('C03 ⚠Firestore は配列の中に配列を入れられない', () => {
  // 自動回転が本番で1度も保存できていなかった原因。
  assert.equal(FIREBASE_CAPABILITIES.nestedArrays, false);
  assert.equal(POCKETBASE_CAPABILITIES.nestedArrays, true);
});

test('C04 実測していない項目は null のまま(推測で埋めない)', () => {
  const left = unverifiedCapabilities(POCKETBASE_CAPABILITIES);
  // 実測前は atomicWrite と docSizeLimit、および割り込み系の4つが未実測
  assert.ok(left.includes('atomicWrite'), left.join(','));
  assert.ok(left.includes('docSizeLimit'), left.join(','));
  for (const k of ATOMIC_PRIMITIVE_KEYS) assert.ok(left.includes(`atomicPrimitives.${k}`), k);
});

test('C05 未実測は「使える」と扱わない。ただし「使えないと確定」でもない', () => {
  assert.equal(can(POCKETBASE_CAPABILITIES, 'atomicWrite'), false);   // 安全側に倒す
  assert.equal(POCKETBASE_CAPABILITIES.atomicWrite, UNVERIFIED);      // 値は null のまま
  assert.ok(unverifiedCapabilities(POCKETBASE_CAPABILITIES).includes('atomicWrite')); // 報告に載る
});

test('C06 docLimitOf は未実測なら null(0 や Infinity で埋めない)', () => {
  assert.equal(docLimitOf(FIREBASE_CAPABILITIES), 1_048_576);
  assert.equal(docLimitOf(POCKETBASE_CAPABILITIES), null);
});

test('C07 移行で失う能力を並べられる', () => {
  const gaps = capabilityGaps(FIREBASE_CAPABILITIES, POCKETBASE_CAPABILITIES);
  const keys = gaps.map((g) => g.key);
  assert.ok(keys.includes('offlineWrites'), '一番大きい穴が出ていない');
  assert.ok(keys.includes('mapKeyDelete'));
  assert.ok(keys.includes('atomicWrite'));
  // 実測済みかどうかが分かる(未実測を「失う」と断定しない材料)
  assert.equal(gaps.find((g) => g.key === 'offlineWrites').measured, true);
  assert.equal(gaps.find((g) => g.key === 'atomicWrite').measured, false);
});

test('C08 実測結果を取り込むと表が更新される', () => {
  const after = applyEvidence(POCKETBASE_CAPABILITIES, {
    docSizeLimit: 5_000_000,
    atomicPrimitives: { claimOnce: true, compareAndSet: true },
  });
  assert.equal(after.docSizeLimit, 5_000_000);
  assert.equal(after.atomicPrimitives.claimOnce, true);
  assert.equal(after.atomicWrite, true, 'claimOnce と compareAndSet が実測 true なら atomicWrite も true');
  assert.equal(POCKETBASE_CAPABILITIES.atomicWrite, UNVERIFIED, '元の表を書き換えてはいけない');
});

test('C09 実測で false が出たら atomicWrite も false になる', () => {
  const after = applyEvidence(POCKETBASE_CAPABILITIES, { atomicPrimitives: { claimOnce: false } });
  assert.equal(after.atomicWrite, false);
});

test('C10 一部だけ実測しても、残りは null のまま', () => {
  const after = applyEvidence(POCKETBASE_CAPABILITIES, { atomicPrimitives: { increment: true } });
  assert.equal(after.atomicPrimitives.claimOnce, UNVERIFIED);
  assert.equal(after.atomicWrite, UNVERIFIED);
  assert.ok(unverifiedCapabilities(after).includes('atomicPrimitives.claimOnce'));
});
