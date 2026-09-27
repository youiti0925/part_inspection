import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { partsVideoFolder } from '../partsVideoFolder.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('置き場所は 部品/テンプレ/<テンプレ名>・空なら テンプレ', () => {
  assert.deepEqual(partsVideoFolder('A型'), ['部品', 'テンプレ', 'A型']);
  assert.deepEqual(partsVideoFolder('  '), ['部品', 'テンプレ', 'テンプレ']);
  assert.deepEqual(partsVideoFolder(null), ['部品', 'テンプレ', 'テンプレ']);
});

test('入れる側と読む側が同じ partsVideoFolder を通っている(本物のコードを読む)', () => {
  const hub = fs.readFileSync(path.join(SRC, 'PartsVideoHub.jsx'), 'utf8');
  assert.match(hub, /recordFolderPath\(\{[^}]*base: partsVideoFolder\(/);
  assert.match(hub, /add\(`テンプレ「\$\{n\}」`, partsVideoFolder\(n\)\)/);
  assert.ok(!/'製品', 'テンプレ'/.test(hub), '部品の棚に製品の道を書かない');
});

test('App.jsx に動画タブ・スマホ撮影の門・作業標準(動画版)が繋がっている', () => {
  const app = fs.readFileSync(path.join(SRC, 'App.jsx'), 'utf8');
  assert.match(app, /<PartsVideoHub[\s\S]{0,200}active=\{activeTab === 'videos'\}/);
  assert.match(app, /id: 'videos', label: '動画'/);
  assert.match(app, /if \(LIVE_CODE\) \{/);
  assert.match(app, /watch\('video_recipes'/);
  assert.match(app, /<WorkStandardsLibraryModalV\b/);
});
