import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AREAS, NS, GOAL_NS, CONTACT_NS, KNOWN_NAMESPACES, COLLECTION_AREA,
  areaOf, isKnownCollection, dataPath, backendFor, DEFAULT_PROVIDERS, PLANNED_PROVIDERS,
} from '../routes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..');

// ⚠ソースを読むときは NUL バイトを落とす。
//   生の \0 が2個あるだけで、検索が黙って途中で止まる(2026-07-26 に実際にやられた)。
const readSrc = (p) => fs.readFileSync(p, 'utf8').replace(/\0/g, '');

// ============================================================================
// R01-R08 地図そのもの
// ============================================================================

test('R01 機能領域はこの6つだけ', () => {
  assert.deepEqual([...AREAS], ['inspection', 'attachments', 'analytics', 'goals', 'contact', 'push']);
});

test('R02 パスは今までの手書きと1セグメントも変わらない', () => {
  assert.deepEqual(dataPath('final-inspection-v1', 'lots'), ['artifacts', 'final-inspection-v1', 'public', 'data', 'lots']);
  assert.deepEqual(dataPath('final-inspection-v1', 'settings', 'config'),
    ['artifacts', 'final-inspection-v1', 'public', 'data', 'settings', 'config']);
  // 数字のIDも受ける(文字列に直す)
  assert.deepEqual(dataPath(NS.product, 'logs', 12).at(-1), '12');
});

test('R03 壊れたパスは組み立てる前に落とす', () => {
  assert.throws(() => dataPath('', 'lots'), /名前空間/);
  assert.throws(() => dataPath(NS.final, ''), /コレクション/);
  assert.throws(() => dataPath(NS.final, 'lots', ''), /ドキュメントID/);
  assert.throws(() => dataPath(NS.final, 'lots', 'a/b'), /ドキュメントID/);   // 型式名に / が入ると別の場所へ書く
  assert.throws(() => dataPath(NS.final, 'lots', '..'), /ドキュメントID/);
  assert.throws(() => dataPath(NS.final, 'lots', '__id__'), /ドキュメントID/); // Firestoreの予約語
  // ⚠空白は正当なID(型式名・作業者名がIDになる場所がある)。弾いてはいけない。
  assert.deepEqual(dataPath(NS.final, 'lots', 'MB 200').at(-1), 'MB 200');
});

test('R04 settings は名前空間で意味が変わる(コレクション名だけで決めない)', () => {
  assert.equal(areaOf(NS.final, 'settings'), 'inspection');   // 検査の設定
  assert.equal(areaOf(GOAL_NS, 'settings'), 'goals');         // 年間目標
  assert.equal(areaOf(CONTACT_NS, 'settings'), 'contact');    // 宛先グループ
});

test('R05 連絡とプッシュは、名前空間がアプリ側でも connect/push の領域', () => {
  // ⚠連絡の「依頼」はアプリの名前空間にある。棚(contact-shared-v1)は宛先グループだけ。
  assert.equal(areaOf(NS.final, 'contact_requests'), 'contact');
  assert.equal(areaOf(NS.product, 'arrival_times'), 'contact');
  assert.equal(areaOf(NS.product, 'push_tokens'), 'push');
});

test('R06 大きいファイルは attachments', () => {
  for (const c of ['lot_images', 'help_images', 'work_standard_files', 'accessory_scan_images']) {
    assert.equal(areaOf(NS.final, c), 'attachments', c);
  }
});

test('R07 M1の既定は全部 firebase = 今と同じ', () => {
  for (const a of AREAS) assert.equal(DEFAULT_PROVIDERS[a], 'firebase', a);
  assert.equal(backendFor(NS.final, 'lots'), 'firebase');
  assert.equal(backendFor(CONTACT_NS, 'settings'), 'firebase');
});

test('R08 移行後の想定でも、連絡とプッシュは firebase のまま', () => {
  assert.equal(backendFor(NS.final, 'lots', PLANNED_PROVIDERS), 'pocketbase');
  assert.equal(backendFor(NS.final, 'lot_images', PLANNED_PROVIDERS), 'pocketbase');
  assert.equal(backendFor(GOAL_NS, 'settings', PLANNED_PROVIDERS), 'pocketbase');
  // ここが firebase でなくなったら、相手の携帯(4G/5G)から連絡ポータルが開けなくなる
  assert.equal(backendFor(NS.final, 'contact_requests', PLANNED_PROVIDERS), 'firebase');
  assert.equal(backendFor(CONTACT_NS, 'settings', PLANNED_PROVIDERS), 'firebase');
  assert.equal(backendFor(NS.product, 'push_tokens', PLANNED_PROVIDERS), 'firebase');
});

// ============================================================================
// R09-R12 ソースとの突き合わせ(手打ち一覧は必ず漏れる、を機械で潰す)
// ============================================================================

// ⚠ファイル名の手打ち一覧にしない。**src の下を全部歩く**。
//   2026-07-26: 3ファイルだけ見る書き方にしたら、製品検査の RotaryMeasurements.jsx の
//   直パスを1件見落とした(別に作った集計スクリプトが拾って発覚)。
//   「手打ちの一覧は黙って漏れる」の実例をこのテスト自身でやってしまった。
const walkSrc = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'data' && e.name !== 'assets') walkSrc(p, out); }
    else if (/\.(js|jsx)$/.test(e.name)) out.push(p);
  }
  return out;
};
const APP_FILES = walkSrc(SRC);

test('R09 アプリのソースに Firestore の直パスが残っていない', () => {
  const left = [];
  for (const f of APP_FILES) {
    const src = readSrc(f);
    src.split('\n').forEach((line, i) => {
      if (line.includes("'artifacts'") || line.includes('"artifacts"')) left.push(`${path.basename(f)}:${i + 1}`);
    });
  }
  assert.deepEqual(left, [], `直パスが残っています(窓口を通してください):\n${left.join('\n')}`);
});

test('R10 窓口に渡しているコレクション名は全部この地図に載っている', () => {
  // provider.watchCollection(NS_X, 'colname', ...) の 'colname' を集める
  const re = /\b(?:watchCollection|watchDoc|getAll|getOne|save|remove|colRef|docRef|routeOf)\s*\(\s*[A-Za-z_$][\w$.]*\s*,\s*'([a-zA-Z0-9_]+)'/g;
  const found = new Set();
  for (const f of APP_FILES) {
    const src = readSrc(f);
    for (const m of src.matchAll(re)) found.add(m[1]);
  }
  assert.ok(found.size > 0, '窓口の呼び出しが1つも見つかりません(検出の正規表現が壊れています)');
  const missing = [...found].filter((c) => !Object.prototype.hasOwnProperty.call(COLLECTION_AREA, c));
  assert.deepEqual(missing, [], `routes.js の COLLECTION_AREA に無いコレクション: ${missing.join(', ')}`);
});

test('R11 地図に載せた名前空間は Firestore ルールの許可一覧と一致する', () => {
  const rulesPath = path.resolve(SRC, '..', 'firestore.rules');
  if (!fs.existsSync(rulesPath)) return; // ルールを持たないリポジトリでは省略
  const rules = readSrc(rulesPath);
  const m = rules.match(/appId in \[([^\]]+)\]/);
  assert.ok(m, 'firestore.rules に名前空間の許可一覧が見つかりません');
  const inRules = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  assert.deepEqual(inRules, [...KNOWN_NAMESPACES].sort());
});

test('R13 ソースに NUL バイトが混ざっていない', () => {
  // ⚠生の NUL が1個あるだけで grep/ripgrep が黙って途中でやめる。
  //   2026-07-26 に実際にやられ、監査が「該当なし」と嘘をついた。
  const NUL = String.fromCharCode(0);
  const files = [
    path.join(SRC, 'data', 'routes.js'),
    path.join(SRC, 'data', 'provider.js'),
    ...APP_FILES,
  ];
  const dirty = files.filter((f) => fs.readFileSync(f, 'latin1').includes(NUL)).map((f) => path.basename(f));
  assert.deepEqual(dirty, []);
});

test('R12 定数で渡しているコレクションも地図に載っている', () => {
  // WS_FILE_COLLECTION など、名前が定数のもの。定義側の文字列を読んで照合する。
  const wanted = ['work_standard_files', 'accessory_scan_images', 'rotaryCommands', 'rotaryEvents'];
  for (const c of wanted) assert.ok(isKnownCollection(NS.final, c), `${c} が地図にありません`);
});
