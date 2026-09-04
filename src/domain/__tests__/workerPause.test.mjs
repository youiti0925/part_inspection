// ============================================================================
// 🛌 作業者の「休止 / 復帰」の見張り（部品検査）
// ----------------------------------------------------------------------------
// なぜ新しく作ったか（実測 2026-09-04）:
//   src/domain/workerPause.js は4アプリとも **同じファイル**(md5 602fd15c…)なのに、
//   試験が在ったのは 最終検査 と 司令塔③ の2つだけだった。
//   部品検査で 14通り わざと壊した所、**14通りとも緑**（＝この蔵の門は
//   1行直しても・1行壊しても、何も言わない）。清水さんが 2026-08-31 に頼んだ
//   「休止中の人を一旦画面から消す／復帰したら使える」の本体がこれ。
//
// 🚨 この見張りが守っている線引き:
//   ①「画面から消す」のは **これから割り当てる先** の話だけ
//   ② 休止は **削除ではない**（書類は残す。印を1つ足すだけ）
//   ③ 復帰は paused を **消さずに false を書く**（merge:true では消えた事にならない）
//   ④ 仕事が残っている休止中の人は **盤に残す**（外すと「不明」レーンへ落ちて行方不明）
//   ⑤ 過去の記録の名前を引く所（WorkerBadge など）には **絶対に使わない**
//
// 🚨 ⑤ は純関数の中に無い（画面の中に在る）ので、この見張りは
//   **実際の src/App.jsx を読んで** 判定します。作り物のスタブは食いません
//   (2026-08-23「見張りが作り物を食っていて緑のまま本番だけ壊れていた」の再発防止)。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isPaused, isActiveWorker, activeWorkersOf, pausedWorkersOf, pausedNamesOf,
  withoutPausedNames, pausePatch, resumePatch, laneWorkersOf, laneNameRowsOf,
  workerDocIdOfName, laneNameOf, remainingWorkOf, pauseConfirmText, resumeConfirmText,
  pausedSummaryLabel, pausedSinceLabel,
  buildNameRoster, remainingOfRosterRow, activeRosterOf, pausedRosterOf,
} from '../workerPause.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPJSX = path.resolve(HERE, '..', '..', 'App.jsx');
const readApp = () => {
  const t = fs.readFileSync(APPJSX, 'utf8');
  assert.ok(t.length > 100000, '部品検査の App.jsx が読めていない。この見張りは実コードを読む前提です');
  return t;
};

// ---------------------------------------------------------------------------
// 1) 印の読み方 — 「true が入っている時だけ休止」
// ---------------------------------------------------------------------------
test('PWP01 休止は paused===true の時だけ。未設定・null・文字の"false"は在籍あつかい', () => {
  assert.equal(isPaused({ paused: true }), true);
  assert.equal(isPaused({ paused: false }), false);
  assert.equal(isPaused({}), false, '印が無い人を休止にしてはいけない(全員が消える)');
  assert.equal(isPaused({ paused: null }), false);
  assert.equal(isPaused({ paused: 'false' }), false, '文字の"false"を真と読むと在籍者が消える');
  assert.equal(isPaused({ paused: 1 }), false, '1 は true ではない');
  assert.equal(isPaused(null), false);
  assert.equal(isActiveWorker({ paused: true }), false);
  assert.equal(isActiveWorker({}), true);
});

test('PWP02 🚨休止は「削除」ではない。書く物は印だけで、消す指示を1つも含まない', () => {
  const p = pausePatch(1756600000000, '尾田');
  assert.equal(p.paused, true);
  assert.equal(p.pausedAt, 1756600000000);
  assert.equal(p.pausedBy, '尾田');
  const keys = Object.keys(p).sort();
  assert.deepEqual(keys, ['paused', 'pausedAt', 'pausedBy'],
    '休止で書くのはこの3つだけ。ここが増えたら「何を書いているのか」を確かめる事');
  const j = JSON.stringify(p);
  for (const bad of ['deleteField', '__deleteMapKeys', 'delete']) {
    assert.ok(!j.includes(bad), `休止の書き込みに「${bad}」が混ざっている＝消しにかかっている`);
  }
});

test('PWP03 🚨復帰は paused を **消さずに false を書く**(merge:true では消えた事にならない)', () => {
  const r = resumePatch(1756700000000);
  assert.ok('paused' in r, '復帰で paused を送っていない＝次の同期で休止に戻る');
  assert.equal(r.paused, false, 'paused は false を **書く**。キーを消すやり方だと戻らない');
  assert.equal(r.resumedAt, 1756700000000);
  assert.ok(!('pausedAt' in r), '休止した日は残す(いつ休んで いつ戻ったかは記録)');
});

// ---------------------------------------------------------------------------
// 2) 誰を「これから割り当てられる人」に出すか
// ---------------------------------------------------------------------------
const WORKERS = [
  { id: 'w1', name: '尾田' },
  { id: 'w2', name: '片山', paused: true, pausedAt: 1756600000000 },
  { id: 'w3', name: '村', paused: false },
];

test('PWP10 🚨休止中の人は「これから割り当てられる人」に混ざらない', () => {
  assert.deepEqual(activeWorkersOf(WORKERS).map((w) => w.name), ['尾田', '村']);
  assert.deepEqual(pausedWorkersOf(WORKERS).map((w) => w.name), ['片山']);
  assert.deepEqual([...pausedNamesOf(WORKERS)], ['片山']);
  assert.deepEqual(withoutPausedNames(['尾田', '片山', '村'], WORKERS), ['尾田', '村']);
});

test('PWP11 🚨まだ仕事が残っている休止中の人は盤に残す(外すと「不明」レーンへ落ちて行方不明になる)', () => {
  const lots = [{ id: 'L1', workerId: 'w2', status: 'processing' }];
  assert.deepEqual(laneWorkersOf(WORKERS, lots).map((w) => w.name), ['尾田', '片山', '村'],
    '仕事が残っている休止中の人をレーンから外してはいけない');
  assert.deepEqual(laneWorkersOf(WORKERS, []).map((w) => w.name), ['尾田', '村'],
    '仕事が終わっていれば、次の描き直しで自然に消える');
  const done = [{ id: 'L1', workerId: 'w2', status: 'completed' }];
  assert.deepEqual(laneWorkersOf(WORKERS, done).map((w) => w.name), ['尾田', '村']);
  // 画面がいま名指ししている人(担当の切替えセレクト)は必ず残す
  assert.deepEqual(laneWorkersOf(WORKERS, [], { keepIds: ['w2'] }).map((w) => w.name),
    ['尾田', '片山', '村']);
});

test('PWP12 名前でしか繋がっていない一覧でも、仕事が残っている人は残す', () => {
  const rows = [{ name: '尾田' }, { name: '片山' }, { name: '村' }];
  assert.deepEqual(laneNameRowsOf(rows, WORKERS, ['片山']).map((r) => r.name), ['尾田', '片山', '村']);
  assert.deepEqual(laneNameRowsOf(rows, WORKERS, []).map((r) => r.name), ['尾田', '村']);
});

test('PWP13 🚨誰も休止していない時は 1つも減らない', () => {
  const all = [{ id: 'a', name: 'あ' }, { id: 'b', name: 'い' }];
  assert.equal(activeWorkersOf(all).length, 2);
  assert.equal(laneWorkersOf(all, []).length, 2);
  assert.equal(laneNameRowsOf([{ name: 'あ' }], all, []).length, 1);
  assert.equal(pausedWorkersOf(all).length, 0);
});

test('PWP14 休止の前に「まだ残っている作業」を数えて、先に件数を言う', () => {
  const lots = [
    { id: 'L1', workerId: 'w2', status: 'processing' },
    { id: 'L2', workerId: 'w2', status: 'completed' },
    { id: 'L3', workerId: 'w2', location: 'completed' },
    { id: 'L4', workerId: 'w1', status: 'processing' },
  ];
  const r = remainingWorkOf(lots, 'w2');
  assert.equal(r.count, 1, '終わった物・完了置き場の物を「残り」に数えてはいけない');
  assert.equal(remainingWorkOf(lots, '').count, 0);
  const text = pauseConfirmText('片山', r.count);
  assert.ok(text.includes('1件'), '残り件数を先に言っていない');
  assert.ok(text.includes('1つも変わりません'), '過去の記録が変わらない事を言っていない');
  assert.ok(pauseConfirmText('片山', 0).includes('休止'), '残り0件の時の文が出ない');
  assert.ok(resumeConfirmText('片山').includes('片山'), '復帰の確認文に名前が入っていない');
});

test('PWP15 札の名前・見出し・休止日の表示', () => {
  assert.equal(laneNameOf({ paused: true, name: '片山' }, '片山'), '🛌片山',
    '休止中と分かる印が付かないと「なぜ普段と違うのか」が読めない');
  assert.equal(laneNameOf({ name: '尾田' }, '尾田'), '尾田');
  assert.equal(pausedSummaryLabel(WORKERS), '🛌 休止中 1人');
  assert.equal(pausedSummaryLabel([]), '🛌 休止中 0人', '0人の時も存在が分かる形で出す');
  assert.equal(pausedSinceLabel({}), '休止した日は記録がありません', '数字を作らない');
  assert.ok(pausedSinceLabel({ pausedAt: 1756600000000 }).includes('から休止'));
});

test('PWP16 名前から作る書類のidは、同じ名前なら必ず同じ(二度押しても書類が2つに増えない)', () => {
  assert.equal(workerDocIdOfName('片山'), workerDocIdOfName('片山'));
  assert.equal(workerDocIdOfName('a/b.c#d$e[f]g'), 'a_b_c_d_e_f_g');
  assert.equal(workerDocIdOfName(''), '_');
  assert.equal(workerDocIdOfName(null), '_');
});

// ---------------------------------------------------------------------------
// 2-b) 名前で人を持つアプリ向けの半分。
//   🚨 部品検査はこの半分を **今は使っていない** が、workerPause.js は4アプリ共通の
//     1ファイル(md5 が同じ)なので、ここが壊れたら部品検査の門も赤にする。
//     「使っていないから見張らない」にすると、4アプリのうち1つだけ直る形に戻る。
// ---------------------------------------------------------------------------
const ZONES = [
  { id: 'z1', name: '尾田', isPersonal: true },
  { id: 'z2', name: '片山', isPersonal: true },
  { id: 'z3', name: '荷受け', isPersonal: false },
];

test('PWP20 名簿は 個人エリア ∪ workers。同じ名前は1行に束ねる', () => {
  const rows = buildNameRoster(ZONES, WORKERS);
  assert.deepEqual(rows.map((r) => r.name), ['尾田', '片山', '村'],
    '個人エリアでない所(荷受け)を人として数えてはいけない');
  const kata = rows.find((r) => r.name === '片山');
  assert.equal(kata.zoneId, 'z2');
  assert.equal(kata.workerId, 'w2', '同じ名前のエリアと書類が1行に束ねられていない');
  assert.equal(rows.find((r) => r.name === '村').zoneId, null,
    'エリアが無い人は workers だけから来る');
});

test('PWP21 🚨残り作業は「エリア」と「書類」の両方で数える(片方だけだと嘘の0件で黙って休止させる)', () => {
  const rows = buildNameRoster(ZONES, WORKERS);
  const kata = rows.find((r) => r.name === '片山');
  assert.equal(remainingOfRosterRow([{ id: 'L1', mapZoneId: 'z2', status: 'processing' }], kata), 1,
    'エリアで割り当たっている仕事を数えていない');
  assert.equal(remainingOfRosterRow([{ id: 'L2', workerId: 'w2', status: 'processing' }], kata), 1,
    '書類で割り当たっている仕事を数えていない');
  assert.equal(remainingOfRosterRow([{ id: 'L3', workerId: 'w2', status: 'completed' }], kata), 0,
    '終わった仕事を「残り」に数えている');
  assert.equal(remainingOfRosterRow([{ id: 'L4', workerId: 'w2', location: 'completed' }], kata), 0);
  assert.equal(remainingOfRosterRow([{ id: 'L5', workerId: 'w1', status: 'processing' }], kata), 0,
    '別の人の仕事を数えている');
  assert.equal(remainingOfRosterRow([], null), 0);
});

test('PWP22 名簿の在籍中／休止中も、印は書類(doc)から読む', () => {
  const rows = buildNameRoster(ZONES, WORKERS);
  assert.deepEqual(activeRosterOf(rows).map((r) => r.name), ['尾田', '村']);
  assert.deepEqual(pausedRosterOf(rows).map((r) => r.name), ['片山']);
  assert.equal(activeRosterOf([]).length, 0);
});

// ---------------------------------------------------------------------------
// 3) 🚨 実コード（src/App.jsx）を読む — 使ってよい所・使ってはいけない所
// ---------------------------------------------------------------------------
test('PWP30 🚨「これから割り当てる先」には、休止の絞り込みが**入っている**', () => {
  const src = readApp();
  assert.ok(src.includes("from './domain/workerPause.js'"),
    '休止の道具を1つも取り込んでいない＝画面に休止の考えが入っていない');
  assert.ok(src.includes('activeWorkersOf(workers)'),
    '作業者マスタ／担当を選ぶ所が activeWorkersOf を通っていない（休止中の人が出る）');
  assert.ok(src.includes('laneWorkersOf(workers, lots)'),
    '現場マップのレーンが laneWorkersOf を通っていない');
  assert.ok(src.includes('pausedSummaryLabel(workers)'),
    '「休止中 ◯人」の見出しが画面に無い（黙って消えている＝2026-09-02 の決まり違反）');
  assert.ok(src.includes('pausedWorkersOf(workers)'),
    '休止中の一覧が画面に無い（戻す道が見えない）');
  assert.ok(src.includes('pausePatch(') && src.includes('resumePatch('),
    '休止／復帰のどちらかのボタンが配線されていない');
});

test('PWP31 🚨休止は削除ではない。休止のボタンが workers の書類を消していない', () => {
  const src = readApp();
  // 休止を実行する所の前後 800文字に deleteData('workers' が混ざっていないか
  const at = src.indexOf('pausePatch(');
  assert.ok(at > 0, 'pausePatch を呼んでいる所が見つからない');
  const around = src.slice(Math.max(0, at - 800), at + 800);
  assert.ok(!/deleteData\(\s*['"]workers['"]/.test(around),
    '休止の処理の近くで workers の書類を消している＝休止が削除になっている');
  assert.ok(!/deleteField|__deleteMapKeys/.test(around),
    '休止の処理の近くで「消す指示」を作っている');
});

test('PWP32 🚨過去の記録の名前を引く所に、休止の絞り込みが入っていない', () => {
  const src = readApp();
  // WorkerBadge（ロットの札に出る担当者名）は **全員** から引く。
  const at = src.indexOf('const WorkerBadge');
  assert.ok(at > 0, 'WorkerBadge が見つからない（名前を変えたなら、この見張りも直す事）');
  const body = src.slice(at, at + 600);
  assert.ok(!/activeWorkersOf|pausedWorkersOf|withoutPausedNames|laneNameRowsOf/.test(body),
    '🚨 過去の記録の名前を引く WorkerBadge に休止の絞り込みが入っている'
    + '＝休止した人の名前が「未割当」になり、済んだ作業の担当が消える');
  assert.ok(body.includes('workers.find'),
    'WorkerBadge が workers 全体から引いていない');
});

test('PWP33 🚨休止の道具を、過去の集計に持ち込んでいない', () => {
  const src = readApp();
  // 「実績」「達成率」「日次」を作る所の近くで休止の絞り込みを使っていないか、
  // 使っている箇所を全部数えて、想定している所(下の ALLOWED)だけかを見る。
  const uses = [...src.matchAll(/activeWorkersOf\s*\(/g)].length;
  assert.ok(uses >= 2 && uses <= 6,
    `activeWorkersOf の使い所が ${uses}箇所。増えていたら「過去の集計に持ち込んでいないか」を人の目で確かめる事`);
});
