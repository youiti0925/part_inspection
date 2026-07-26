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

// 未実測の扱いは「仕組み」として確かめる(実測が進むたびにテストが壊れないように、
// 本物の表ではなく、わざと空にした表で見る)。
const 未実測の表 = Object.freeze({
  provider: 'test', realtime: true, offlineWrites: false, atomicWrite: UNVERIFIED,
  fileStorage: true, serverTimestamp: true, mapKeyDelete: false, nestedArrays: true,
  docSizeLimit: UNVERIFIED,
  atomicPrimitives: Object.freeze({ claimOnce: UNVERIFIED, compareAndSet: UNVERIFIED, increment: UNVERIFIED, multiRecordTransaction: UNVERIFIED }),
});

test('C04 実測していない項目は null のまま(推測で埋めない)', () => {
  const left = unverifiedCapabilities(未実測の表);
  assert.ok(left.includes('atomicWrite'), left.join(','));
  assert.ok(left.includes('docSizeLimit'), left.join(','));
  for (const k of ATOMIC_PRIMITIVE_KEYS) assert.ok(left.includes(`atomicPrimitives.${k}`), k);
});

test('C05 未実測は「使える」と扱わない。ただし「使えないと確定」でもない', () => {
  assert.equal(can(未実測の表, 'atomicWrite'), false);   // 安全側に倒す
  assert.equal(未実測の表.atomicWrite, UNVERIFIED);      // 値は null のまま
  assert.ok(unverifiedCapabilities(未実測の表).includes('atomicWrite')); // 報告に載る
});

test('C06 docLimitOf は未実測なら null(0 や Infinity で埋めない)', () => {
  assert.equal(docLimitOf(FIREBASE_CAPABILITIES), 1_048_576);
  assert.equal(docLimitOf(未実測の表), null);
});

test('C07 移行で失う能力を並べられる', () => {
  const gaps = capabilityGaps(FIREBASE_CAPABILITIES, 未実測の表);
  const keys = gaps.map((g) => g.key);
  assert.ok(keys.includes('offlineWrites'), '一番大きい穴が出ていない');
  assert.ok(keys.includes('mapKeyDelete'));
  assert.ok(keys.includes('atomicWrite'));
  // 実測済みかどうかが分かる(未実測を「失う」と断定しない材料)
  assert.equal(gaps.find((g) => g.key === 'offlineWrites').measured, true);
  assert.equal(gaps.find((g) => g.key === 'atomicWrite').measured, false);
});

test('C08 実測結果を取り込むと表が更新される(元の表は書き換えない)', () => {
  const after = applyEvidence(未実測の表, {
    docSizeLimit: 5_000_000,
    atomicPrimitives: { claimOnce: true, compareAndSet: true },
  });
  assert.equal(after.docSizeLimit, 5_000_000);
  assert.equal(after.atomicPrimitives.claimOnce, true);
  assert.equal(after.atomicWrite, true, 'claimOnce と compareAndSet が実測 true なら atomicWrite も true');
  assert.equal(未実測の表.atomicWrite, UNVERIFIED, '元の表を書き換えてはいけない');
});

// ---------------------------------------------------------------------------
// ここから下は「2026-07-27 に実際に測った結果」の記録。
// ⚠数字を変えるときは **測り直してから** 変えること(推測で書き換えない)。
//   測り方: tools/migration/measure-pb.mjs / 証拠: C:\AI-Work\pb-claim-spike\evidence-*.json
// ---------------------------------------------------------------------------
test('C11 PocketBase v0.39.9 の実測結果が表に入っている', () => {
  const c = POCKETBASE_CAPABILITIES;
  assert.equal(c.serverVersion, '0.39.9');
  assert.equal(c.measuredAt, '2026-07-27');
  assert.equal(unverifiedCapabilities(c).length, 0, `まだ未実測の項目がある: ${unverifiedCapabilities(c).join(', ')}`);
});

test('C12 割り込まれない書き込みは4種とも実測で合格している', () => {
  // ⚠ただし **作り方による**。UNIQUE インデックスへの create なら合格。
  //   サーバ側フックで rev を見比べる方式は 100回中98回で両方通った(不合格)。
  for (const k of ATOMIC_PRIMITIVE_KEYS) {
    assert.equal(can(POCKETBASE_CAPABILITIES, `atomicPrimitives.${k}`), true, k);
  }
  assert.equal(POCKETBASE_CAPABILITIES.atomicWrite, true);
});

test('C13 1件の上限は Firestore より広い(1MB問題が消える根拠)', () => {
  assert.ok(docLimitOf(POCKETBASE_CAPABILITIES) > docLimitOf(FIREBASE_CAPABILITIES),
    `PB ${docLimitOf(POCKETBASE_CAPABILITIES)} / FB ${docLimitOf(FIREBASE_CAPABILITIES)}`);
});

test('C14 実測後も「失うもの」は残っている(オフライン書き込みと入れ子キー削除)', () => {
  const gaps = capabilityGaps(FIREBASE_CAPABILITIES, POCKETBASE_CAPABILITIES).map((g) => g.key);
  // ⚠これが移行の代償。どちらも自前で作った(outbox.js / docMerge.js)。
  assert.deepEqual(gaps.sort(), ['mapKeyDelete', 'offlineWrites']);
});

test('C09 実測で false が出たら atomicWrite も false になる', () => {
  const after = applyEvidence(POCKETBASE_CAPABILITIES, { atomicPrimitives: { claimOnce: false } });
  assert.equal(after.atomicWrite, false);
});

test('C10 一部だけ実測しても、残りは null のまま', () => {
  const after = applyEvidence(未実測の表, { atomicPrimitives: { increment: true } });
  assert.equal(after.atomicPrimitives.claimOnce, UNVERIFIED);
  assert.equal(after.atomicWrite, UNVERIFIED);
  assert.ok(unverifiedCapabilities(after).includes('atomicPrimitives.claimOnce'));
});
