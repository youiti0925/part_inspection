// 🔁 R39 部品の画面の配線(社内版だけ・domain/readRecovery.js を使う所)。決まりそのものは readRecovery.test.mjs(4アプリ同じ中身)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const src = readFileSync(join(ROOT, 'src', 'App.jsx'), 'utf8');

test('RW1 部品: 自動の読み直しは社内版のビルドだけ(いつものビルドは true に畳まれる)', () => {
  assert.match(src, /const onpremOnline = IS_ONPREM_BUILD \? useOnpremReadRecovery\(\{/);
  assert.match(src, /blocked: !!quotaBlock,/, '枠切れ(429)の間は読みに行かない');
  assert.match(src, /const r = await probeServerRead\(P, ns, col\);\s*\n\s*if \(r\.ok\) setReadErrors/, 'サーバの答えが届いた名札だけ下ろす');
});

test('RW2 部品: 控えだけの答え(fromCache)では帯を下ろさず、ロットの保存の門も開けない(社内版だけ)', () => {
  assert.match(src, /if \(!IS_ONPREM_BUILD \|\| !isLocalOnlySnap\(snap\)\) readOk\(colName\)/);
  assert.match(src, /if \(!IS_ONPREM_BUILD \|\| !isLocalOnlySnap\(snap\)\) readOk\('templates'\)/);
  assert.match(src, /if \(!IS_ONPREM_BUILD \|\| !isLocalOnlySnap\(snap\)\) readOk\('workers'\)/);
  assert.equal((src.match(/if \(!IS_ONPREM_BUILD \|\| !cached\) \{\n\s*setReadErrors\(prev => \(prev\.lots/g) || []).length, 2, 'ロットの窓2本(普段・過去)');
  assert.doesNotMatch(src, /\{ meter\(colName, snap\); readOk\(colName\);/, '守りの無い形が残っていない');
});

test('RW3 部品: つながらないだけなら穏やかな帯(控えを表示中)・それ以外は今までの赤い帯', () => {
  assert.match(src, /IS_ONPREM_BUILD && readBandKind\(readErrors, \{ online: onpremOnline \}\) === 'offline' \? \(/);
  assert.match(src, /data-read-band="offline"/);
  assert.match(src, /offlineBandDetail\(\{ saveStopped: !lotsLoaded \}\)/);
  assert.match(src, /🚨 データが読めていません（画面の件数は当てになりません）/, '赤い帯はそのまま残る');
});
