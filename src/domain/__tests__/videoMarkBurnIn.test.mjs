// ============================================================================
// ⭕ 「印をつけて保存したのに、動画に印がついていない」を二度と起こさない為の試験
// ----------------------------------------------------------------------------
// 清水さん(2026-08-15):
//   「さっき試しに編集して〇とかつけて保存したけど、そのデータ見ても〇とかついてなかった」
//
// ⚠⚠ 実測(2026-08-16, scripts/verify-mark-burnin.mjs)で分かった事:
//   ⏸止め絵・🖼画像・▶流したままの印は **書き出しに入っていた**(赤い画素2000超)。
//   ところが 🎞映像の部品(clips[].marks)に付けた印だけ **赤い画素 0**。
//   原因は1箇所ではなく2箇所:
//     ① src/domain/videoProject.js normalizeProject の video 分岐に marks キーが無い
//        → 書き出しの入口(videoExport.js が normalizeProject を通す)で **黙って消える**
//     ② src/videoExport.js の映像の分岐だけ `marks: [], caption: ''` と手で書いてあった
//        → ①をすり抜けても、ここで空に上書きされる
//   どちらか一方だけ直しても印は出ない。**両方**を試験で固定する。
//
// ⚠ここは domain の純関数の試験。ブラウザは要らない(node --test で回る)。
//   ②だけは実ファイルの中身を読んで確かめる(純関数にできない為)。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  emptyProject, normalizeProject, renderParts, timelineOf,
  partOverlayInfo, normChapter, normChapters, chapterSegments,
} from '../videoProject.js';
import { collectWords } from '../videoWords.js';
import { buildWorkStandard, chapterAt } from '../workStandardDoc.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..');

const MARK = { x: 0.75, y: 0.25, rx: 0.1, ry: 0.16, color: '#ff2d2d', width: 'l' };

// ---------------------------------------------------------------------------
// ⭕ 印が書き出しまで届くか
// ---------------------------------------------------------------------------

test('MB01 ⚠⚠映像の部品に付けた印が normalizeProject で消えない', () => {
  const p = normalizeProject({
    ...emptyProject(),
    clips: [{
      id: 'c1', type: 'video', srcId: 's1', start: 0, end: 4, speed: 1,
      marks: [MARK], caption: 'ここを見る', marksInPicture: true,
    }],
  });
  const c = p.clips[0];
  assert.equal(c.type, 'video');
  assert.deepEqual(c.marks, [MARK], '映像の部品の印が落ちている（これが「〇が付いていない」の正体その1）');
  assert.equal(c.caption, 'ここを見る', '映像の部品の字幕が落ちている');
  assert.equal(c.marksInPicture, true, '印の座標の意味（絵の中か枠全体か）が落ちている＝黒帯ぶんズレる');
});

test('MB02 ⚠映像の部品の印が renderParts で書き出しの並びへ渡る', () => {
  const p = normalizeProject({
    ...emptyProject(),
    clips: [{ id: 'c1', type: 'video', srcId: 's1', start: 0, end: 4, marks: [MARK], caption: 'あ' }],
  });
  const parts = renderParts(p);
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0].marks, [MARK]);
  assert.equal(parts[0].caption, 'あ');
});

test('MB03 partOverlayInfo: 映像・止め絵・画像を同じ扱いにする', () => {
  assert.deepEqual(
    partOverlayInfo({ type: 'video', marks: [MARK], caption: 'x', marksInPicture: true }),
    { marks: [MARK], caption: 'x', marksInPicture: true });
  assert.deepEqual(
    partOverlayInfo({ type: 'freeze', marks: [MARK] }),
    { marks: [MARK], caption: '', marksInPicture: false });
  assert.deepEqual(
    partOverlayInfo({ type: 'image', caption: 'y' }),
    { marks: [], caption: 'y', marksInPicture: false });
  // ⚠壊れた値で落ちない
  assert.deepEqual(partOverlayInfo(null), { marks: [], caption: '', marksInPicture: false });
  assert.deepEqual(partOverlayInfo({ marks: 'こわれた', caption: 5 }), { marks: [], caption: '', marksInPicture: false });
  assert.deepEqual(partOverlayInfo({ marks: [MARK, null, undefined] }).marks, [MARK], '空の印は捨てる');
});

test('MB04 ⚠⚠ videoExport.js の3つの分岐が partOverlayInfo 1本を通る（marks:[] の手書きが無い）', () => {
  const raw = fs.readFileSync(path.join(SRC, 'videoExport.js'), 'utf8');
  // ⚠**書いてある説明** ではなく **動くコード** を見る。
  //   注釈にこの失敗の説明が書いてあるので、注釈ごと数えると自分の説明に引っかかる。
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  // 「いま置いてある絵の素性」を組み立てている所は3つ(🖼画像 / ⏸止め絵 / 🎞映像)
  const curs = code.match(/cur = \{/g) || [];
  assert.equal(curs.length, 3, `cur を組み立てる所が3つのはず（実測 ${curs.length}）`);
  const uses = code.match(/\.\.\.partOverlayInfo\(part\)/g) || [];
  assert.equal(uses.length, 3,
    `3つとも partOverlayInfo(part) を使うはず（実測 ${uses.length}）。1つでも手書きだと、そこの印だけ黙って消える`);
  assert.equal(/marks: \[\], caption: ''/.test(code), false,
    "映像の分岐に `marks: [], caption: ''` の手書きが残っている（印が空で上書きされる）");
});

// ---------------------------------------------------------------------------
// 📄 作業標準の3欄(step/point/why)が書き出しの入口で消えないか
// ---------------------------------------------------------------------------

test('MB05 ⚠作業標準の3欄(step/point/why)が normalizeProject で消えない', () => {
  const p = normalizeProject({
    ...emptyProject(),
    clips: [{
      id: 'c1', type: 'freeze', srcId: 's1', atSec: 2, durationSec: 3,
      step: '銘板を貼る', point: '上端を筐体の線に合わせる', why: 'ずれると出荷検査で戻る',
      caption: '銘板', marks: [MARK],
    }],
  });
  const c = p.clips[0];
  assert.equal(c.step, '銘板を貼る');
  assert.equal(c.point, '上端を筐体の線に合わせる');
  assert.equal(c.why, 'ずれると出荷検査で戻る');
});

test('MB06 normalizeProject を通した後でも 作業標準に急所が残る', () => {
  const raw = {
    ...emptyProject(),
    clips: [{
      id: 'c1', type: 'freeze', srcId: 's1', atSec: 2, durationSec: 3,
      step: '銘板を貼る', point: '上端を合わせる', why: '戻るから',
    }],
  };
  const p = normalizeProject(raw);
  const doc = buildWorkStandard(p, { timeline: timelineOf(p) });
  assert.equal(doc.rows.length, 1);
  assert.equal(doc.rows[0].point, '上端を合わせる', '急所が空になっている＝書類が「空欄」で出る');
  assert.equal(doc.missing.point, 0);
  assert.equal(doc.missing.why, 0);
});

test('MB07 normalizeProject を通した後でも 🔎索引に急所が残る', () => {
  const p = normalizeProject({
    ...emptyProject(),
    clips: [{ id: 'c1', type: 'freeze', srcId: 's1', atSec: 2, durationSec: 3, point: 'ノギスの当て方' }],
  });
  const words = collectWords({ project: p, timeline: timelineOf(p) });
  assert.ok(words.some(w => w.kind === 'point' && w.text === 'ノギスの当て方'),
    '急所が索引に入っていない＝「言葉で探す」で一生出てこない');
});

// ---------------------------------------------------------------------------
// 📍 章の形が2つある問題 — 読む側を1本にする
//   ・編集室     {name, atOut}
//   ・手本レシピ {id, stepKey, label, start, end, source}
// ⚠形そのものは変えない(既存のレシピが読めなくなる)。読み替えだけを1本にする。
// ---------------------------------------------------------------------------

test('CH01 normChapter: 編集室の形 {name, atOut} をそのまま読む', () => {
  assert.deepEqual(normChapter({ name: '外観', atOut: 12.5 }), { name: '外観', atOut: 12.5 });
  assert.deepEqual(normChapter({ name: '頭', atOut: 0 }), { name: '頭', atOut: 0 }, '0秒の章を捨てない');
});

test('CH02 normChapter: 手本レシピの形 {label, start} も読める', () => {
  assert.deepEqual(normChapter({ id: 'k1', stepKey: '外観__キズ', label: '外観検査', start: 12.5, end: 30, source: 'x' }),
    { name: '外観検査', atOut: 12.5 });
  assert.deepEqual(normChapter(null), null);
  assert.deepEqual(normChapter({ name: '名前だけ' }), { name: '名前だけ', atOut: 0 });
});

test('CH03 ⚠chapterSegments が手本レシピの形の章でも区切れる', () => {
  const p = { ...emptyProject(), clips: [{ id: 'c1', type: 'video', srcId: 's1', start: 0, end: 30, speed: 1 }] };
  const editor = chapterSegments(p, [{ name: '外観', atOut: 10 }, { name: '寸法', atOut: 20 }]);
  const recipe = chapterSegments(p, [{ label: '外観', start: 10 }, { label: '寸法', start: 20 }]);
  assert.equal(editor.length, 3, '編集室の形: 0-10 / 10-20 / 20-30');
  assert.deepEqual(recipe, editor, '手本レシピの形でも同じ区切りになるはず（今は区間1本にしかならない）');
});

test('CH04 ⚠collectWords が手本レシピの形の章も索引に入れる', () => {
  const p = { ...emptyProject(), clips: [{ id: 'c1', type: 'video', srcId: 's1', start: 0, end: 30, speed: 1 }] };
  const w = collectWords({ project: p, timeline: timelineOf(p), chapters: [{ label: '外観検査', start: 10 }] });
  const hit = w.find(x => x.kind === 'chapter');
  assert.ok(hit, '手本レシピの形の章が索引に入っていない');
  assert.equal(hit.text, '外観検査');
  assert.equal(hit.atOut, 10);
});

test('CH05 ⚠chapterAt(作業標準の工程名) が手本レシピの形でも出る', () => {
  const recipe = [{ label: '外観検査', start: 0 }, { label: '寸法検査', start: 10 }];
  assert.equal(chapterAt(recipe, 3), '外観検査');
  assert.equal(chapterAt(recipe, 12), '寸法検査');
  // 編集室の形は今まで通り
  assert.equal(chapterAt([{ name: 'A', atOut: 0 }, { name: 'B', atOut: 10 }], 12), 'B');
});

test('CH06 ⚠編集室の形の章は索引の鍵(id)が今までと変わらない', () => {
  const p = { ...emptyProject(), clips: [{ id: 'c1', type: 'video', srcId: 's1', start: 0, end: 30, speed: 1 }] };
  // ⚠2件目だけが名前を持つ形。normChapters で詰めてしまうと ch1 → ch0 に化けて
  //   保存済みの索引と鍵が食い違う(押しても飛べない行が残る)。
  const w = collectWords({
    project: p, timeline: timelineOf(p),
    chapters: [{ name: '', atOut: 0 }, { name: '寸法', atOut: 10 }],
  });
  const hit = w.find(x => x.kind === 'chapter');
  assert.equal(hit.id, 'chapter:ch1', '章の鍵は元の並びの番号のまま');
});

test('CH07 normChapters: 読めない物は落とす。並びは元のまま', () => {
  assert.deepEqual(normChapters([{ name: 'A', atOut: 5 }, null, { label: 'B', start: 9 }]),
    [{ name: 'A', atOut: 5 }, { name: 'B', atOut: 9 }]);
  assert.deepEqual(normChapters(null), []);
});
