// 🎬 レシピ/チャプター解釈の共通ロジック (仕様書 §5) のテスト。
//   スタジオ(全画面)と小窓プレイヤーが**同じ判定**を使うことが要件。片方だけ直る事故の前科あり。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recipeActionAt, clampChapter, findChapterVideos, pickChapterVideo, chaptersOf } from '../videoRecipe.js';

const EVENTS = [
  { id: 'sk1', type: 'skip', start: 10, end: 20 },
  { id: 'pa1', type: 'pause', start: 30, text: '端子の締付け' },
  { id: 'sp1', type: 'speed', start: 40, end: 50, speed: 2 },
];

test('スキップ区間に入ったら skip を返す(呼び出し側はそこで seek して終わり)', () => {
  const r = recipeActionAt({ events: EVENTS, t: 12, prev: 11 });
  assert.equal(r.skip?.id, 'sk1');
});

test('「戻って見る」で無効化したスキップは二度と発火しない', () => {
  const r = recipeActionAt({ events: EVENTS, t: 12, prev: 11, undoneSkipIds: new Set(['sk1']) });
  assert.equal(r.skip, null);
});

test('スキップ区間の最後の1フレームでは発火しない(無限スキップ防止の遊び)', () => {
  assert.equal(recipeActionAt({ events: EVENTS, t: 19.99, prev: 19.9 }).skip, null);
});

test('停止ポイントは「またいだ」時だけ発火する', () => {
  assert.equal(recipeActionAt({ events: EVENTS, t: 30.2, prev: 29.8 }).pause?.id, 'pa1');
  assert.equal(recipeActionAt({ events: EVENTS, t: 30.5, prev: 30.2 }).pause, null); // 既にまたいだ後
});

test('発火済みの停止ポイントは再発火しない', () => {
  assert.equal(recipeActionAt({ events: EVENTS, t: 30.2, prev: 29.8, firedPauseIds: new Set(['pa1']) }).pause, null);
});

test('applyJumps=false (打刻中/オーバーレイ表示中) はスキップも停止も判定しない', () => {
  const r = recipeActionAt({ events: EVENTS, t: 12, prev: 11, applyJumps: false });
  assert.equal(r.skip, null);
  assert.equal(r.pause, null);
});

test('倍速は applyJumps=false でも常に効く(既存 onTime と同じ)', () => {
  assert.equal(recipeActionAt({ events: EVENTS, t: 45, prev: 44, applyJumps: false }).rate, 2);
});

test('区間倍速 × 視聴者の速度 の積が再生レート', () => {
  assert.equal(recipeActionAt({ events: EVENTS, t: 45, prev: 44, userSpeed: 0.5 }).rate, 1);
  assert.equal(recipeActionAt({ events: EVENTS, t: 5, prev: 4, userSpeed: 0.75 }).rate, 0.75);
});

test('イベントが無いレシピでも落ちない(等倍で返す)', () => {
  assert.equal(recipeActionAt({ events: null, t: 5, prev: 4 }).rate, 1);
  assert.equal(recipeActionAt({}).rate, 1);
});

test('チャプターは動画の長さで clamp する(はみ出すと即終了して「動かない」に見える)', () => {
  const c = clampChapter({ start: 10, end: 999 }, 100);
  assert.equal(c.start, 10);
  assert.equal(c.end, 100);
});

test('長さの分からない動画(duration=0)ではそのまま通す', () => {
  const c = clampChapter({ start: 10, end: 40 }, 0);
  assert.equal(c.start, 10);
  assert.equal(c.end, 40);
});

test('start>=end の壊れた章でも再生できる長さを必ず残す', () => {
  const c = clampChapter({ start: 30, end: 30 }, 100);
  assert.ok(c.end > c.start);
});

const RECIPES = [
  { fileId: 'f1', stepKeys: ['s1'], model: '', chapters: [{ id: 'c1', stepKey: 's1', start: 5, end: 40 }] },
  { fileId: 'f2', stepKeys: ['s1', 's2'], model: '', chapters: [] },              // 従来の紐付けだけ
  { fileId: 'f3', stepKeys: ['s1'], model: 'OTHER', chapters: [{ id: 'c9', stepKey: 's1', start: 0, end: 5 }] },
];

test('チャプター付きの動画を先に出す(従来の紐付けだけの動画は後ろ)', () => {
  const list = findChapterVideos({ recipes: RECIPES, stepKey: 's1', model: 'ABC' });
  assert.deepEqual(list.map(x => x.recipe.fileId), ['f1', 'f2']); // f3 は型式違いで除外
  assert.equal(list[0].chapter.id, 'c1');
  assert.equal(list[1].chapter, null);
});

test('型式が指定されたレシピは同じ型式のロットにしか出ない(既存 aceFor と同じ条件)', () => {
  // model:'OTHER' のロットでは f3 も対象に入る。チャプター付き(f1,f3)が先、紐付けだけ(f2)が後。
  assert.deepEqual(findChapterVideos({ recipes: RECIPES, stepKey: 's1', model: 'OTHER' }).map(x => x.recipe.fileId), ['f1', 'f3', 'f2']);
  // model:'ABC' のロットには f3 は出ない
  assert.ok(!findChapterVideos({ recipes: RECIPES, stepKey: 's1', model: 'ABC' }).some(x => x.recipe.fileId === 'f3'));
});

test('チャプターが無く従来の紐付けだけの動画は chapter=null(頭から再生の合図)', () => {
  const p = pickChapterVideo({ recipes: [RECIPES[1]], stepKey: 's2', model: 'ABC' });
  assert.equal(p.recipe.fileId, 'f2');
  assert.equal(p.chapter, null);
});

test('該当が無ければ null(自動再生しない)', () => {
  assert.equal(pickChapterVideo({ recipes: RECIPES, stepKey: 'zzz', model: 'ABC' }), null);
  assert.equal(pickChapterVideo({ recipes: RECIPES, stepKey: '', model: 'ABC' }), null);
});

test('chaptersOf は配列でない値を必ず空配列にする', () => {
  assert.deepEqual(chaptersOf({ chapters: null }), []);
  assert.deepEqual(chaptersOf(null), []);
  assert.deepEqual(chaptersOf({ chapters: [{ id: 'x' }] }).length, 1);
});
