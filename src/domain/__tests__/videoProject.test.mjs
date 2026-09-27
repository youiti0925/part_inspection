// 🎞 編集の中身(タイムライン)の計算。⚠ここがズレると「消したはずの所が残る」「印が別の場面で出る」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clipOutSec, projectOutSec, timelineOf, outToSrc, srcToOut, keptSrcRanges,
  mkId, emptyProject, projectFromSources, splitAt, deleteClip, moveClip, patchClip, trimClip,
  insertImageAt, shiftOverlays, overlaysAt, addOverlay, patchOverlay, removeOverlay,
  outputDims, normCrop, zoomAt, silenceRanges, cutSrcRanges, renderParts, chapterSegments,
  normalizeProject, normSpeed, MIN_CLIP, sliceParts, setClipDuration,
} from '../videoProject.js';

const proj = (clips, overlays = []) => ({ ...emptyProject(), clips, overlays });
const vc = (id, start, end, speed = 1) => ({ id, type: 'video', srcId: 's1', start, end, speed });

test('P01 部品の長さ: 速さで割る(2倍速なら半分)', () => {
  assert.equal(clipOutSec(vc('c1', 0, 10)), 10);
  assert.equal(clipOutSec(vc('c1', 0, 10, 2)), 5);
  assert.equal(clipOutSec(vc('c1', 0, 10, 0.5)), 20);
  assert.equal(clipOutSec({ type: 'image', durationSec: 4 }), 4);
});

test('P02 ⚠速さ0や負の数で長さが無限にならない', () => {
  assert.equal(normSpeed(0), 1);
  assert.equal(normSpeed(-3), 1);
  assert.equal(normSpeed('abc'), 1);
  assert.equal(normSpeed(99), 4);
  assert.equal(normSpeed(0.01), 0.25);
  assert.ok(Number.isFinite(clipOutSec({ ...vc('c1', 0, 10), speed: 0 })));
});

test('P03 タイムライン: out時刻が積み上がる', () => {
  const p = proj([vc('c1', 0, 4), { id: 'c2', type: 'image', durationSec: 3 }, vc('c3', 10, 20, 2)]);
  const rows = timelineOf(p);
  assert.deepEqual(rows.map(r => [r.outStart, r.outEnd]), [[0, 4], [4, 7], [7, 12]]);
  assert.equal(projectOutSec(p), 12);
});

test('P04 ⚠out時刻→src時刻: 倍速の部品でも正しい', () => {
  const p = proj([vc('c1', 0, 4), vc('c2', 100, 120, 2)]);
  assert.equal(outToSrc(p, 2).srcSec, 2);
  const h = outToSrc(p, 5);           // 2本目に入って1秒 → 元では2秒進む
  assert.equal(h.index, 1);
  assert.equal(h.srcSec, 102);
  assert.equal(outToSrc(p, 13.9).srcSec, 119.8);
});

test('P05 src時刻→out時刻。消された所は null', () => {
  const p = proj([vc('c1', 0, 4), vc('c2', 100, 120, 2)]);
  assert.equal(srcToOut(p, 0, 2), 2);
  assert.equal(srcToOut(p, 1, 110), 4 + 5);
  assert.equal(srcToOut(p, 1, 50), null, '部品の外は null');
});

test('P06 分割: 1つの部品が2つになり、合計の長さは変わらない', () => {
  const p = proj([vc('c1', 0, 10)]);
  const q = splitAt(p, 4);
  assert.equal(q.clips.length, 2);
  assert.deepEqual([q.clips[0].start, q.clips[0].end], [0, 4]);
  assert.deepEqual([q.clips[1].start, q.clips[1].end], [4, 10]);
  assert.equal(projectOutSec(q), projectOutSec(p));
  assert.notEqual(q.clips[0].id, q.clips[1].id, 'idがぶつからない');
});

test('P07 ⚠端すぎる所では分割しない(0.1秒の欠片を作らない)', () => {
  const p = proj([vc('c1', 0, 10)]);
  assert.equal(splitAt(p, 0.05).clips.length, 1);
  assert.equal(splitAt(p, 9.95).clips.length, 1);
  assert.equal(splitAt(p, MIN_CLIP + 0.01).clips.length, 2);
});

test('P08 分割: 倍速の部品は src時刻で割れる', () => {
  const p = proj([vc('c1', 0, 20, 2)]);       // 出来上がり10秒
  const q = splitAt(p, 5);                     // 真ん中 → 元の10秒
  assert.deepEqual([q.clips[0].start, q.clips[0].end], [0, 10]);
  assert.deepEqual([q.clips[1].start, q.clips[1].end], [10, 20]);
  assert.equal(projectOutSec(q), 10);
});

test('P09 ⚠部品を消すと、後ろの重ねが前に詰まる(別の場面で印が出ない)', () => {
  const p = proj([vc('c1', 0, 4), vc('c2', 10, 14), vc('c3', 20, 24)],
    [{ id: 'o1', kind: 'mark', from: 1, to: 3 }, { id: 'o2', kind: 'text', from: 9, to: 11 }]);
  const q = deleteClip(p, 1);                  // 4〜8 が消える
  assert.equal(projectOutSec(q), 8);
  assert.deepEqual(q.overlays.map(o => [o.id, o.from, o.to]), [['o1', 1, 3], ['o2', 5, 7]]);
});

test('P10 ⚠消した区間の中にあった重ねは消える(見えない印が残らない)', () => {
  const p = proj([vc('c1', 0, 4), vc('c2', 10, 14)],
    [{ id: 'o1', kind: 'mark', from: 5, to: 6 }]);
  const q = deleteClip(p, 1);
  assert.equal(q.overlays.length, 0);
});

test('P11 並べ替え', () => {
  const p = proj([vc('a', 0, 1), vc('b', 1, 2), vc('c', 2, 3)]);
  assert.deepEqual(moveClip(p, 2, 0).clips.map(c => c.id), ['c', 'a', 'b']);
  assert.deepEqual(moveClip(p, 0, 9).clips.map(c => c.id), ['b', 'c', 'a'], '範囲外は端に寄せる');
  assert.deepEqual(moveClip(p, 5, 0).clips.map(c => c.id), ['a', 'b', 'c'], '存在しない番号は何もしない');
});

test('P12 トリム: 元動画の外に出ない・つまみすぎても消えない', () => {
  const p = proj([vc('c1', 2, 8)]);
  assert.equal(trimClip(p, 0, { start: -5 }).clips[0].start, 0);
  assert.equal(trimClip(p, 0, { end: 999 }, 10).clips[0].end, 10);
  const tight = trimClip(p, 0, { start: 7.99 });
  assert.ok(tight.clips[0].end - tight.clips[0].start >= MIN_CLIP - 1e-9, '最低の長さは残る');
});

test('P13 画像を挟む: 途中なら割ってから挟み、後ろの重ねがずれる', () => {
  const p = proj([vc('c1', 0, 10)], [{ id: 'o1', kind: 'text', from: 6, to: 8 }]);
  const q = insertImageAt(p, 4, { imageId: 'i1', durationSec: 3 });
  assert.deepEqual(q.clips.map(c => c.type), ['video', 'image', 'video']);
  assert.equal(projectOutSec(q), 13);
  assert.deepEqual(q.overlays.map(o => [o.from, o.to]), [[9, 11]]);
});

test('P14 画像を先頭/末尾に挟める', () => {
  const p = proj([vc('c1', 0, 10)]);
  assert.equal(insertImageAt(p, 0, { imageId: 'i', durationSec: 2 }).clips[0].type, 'image');
  const tail = insertImageAt(p, 10, { imageId: 'i', durationSec: 2 });
  assert.equal(tail.clips[tail.clips.length - 1].type, 'image');
  assert.equal(projectOutSec(tail), 12);
});

test('P15 重ね: 足す/直す/消す。長さ0にならない', () => {
  let p = emptyProject();
  p = addOverlay(p, { kind: 'text', from: 1, text: 'あ' });
  assert.equal(p.overlays[0].to, 4, '既定は3秒');
  p = patchOverlay(p, p.overlays[0].id, { to: 0 });
  assert.ok(p.overlays[0].to > p.overlays[0].from);
  p = removeOverlay(p, p.overlays[0].id);
  assert.equal(p.overlays.length, 0);
});

test('P16 その時刻に出ている重ねだけ返す(終わりの瞬間は出さない)', () => {
  const p = proj([vc('c1', 0, 10)], [
    { id: 'o1', kind: 'mark', from: 1, to: 3 },
    { id: 'o2', kind: 'text', from: 2, to: 5 },
  ]);
  assert.deepEqual(overlaysAt(p, 0.5).map(o => o.id), []);
  assert.deepEqual(overlaysAt(p, 2.5).map(o => o.id), ['o1', 'o2']);
  assert.deepEqual(overlaysAt(p, 3).map(o => o.id), ['o2']);
});

test('P17 出来上がりの縦横: 回転で入れ替わり、切り抜きで縮む。必ず偶数', () => {
  assert.deepEqual(outputDims(1920, 1080, 0, null, 854), { width: 854, height: 480 });
  const rot = outputDims(1920, 1080, 90, null, 854);
  assert.ok(rot.height > rot.width, '縦長になる');
  assert.equal(rot.width % 2, 0); assert.equal(rot.height % 2, 0);
  const cr = outputDims(1920, 1080, 0, { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, 854);
  assert.ok(cr.width <= 854 && cr.width % 2 === 0);
  assert.deepEqual(outputDims(640, 480, 0, null, 854), { width: 640, height: 480 }, '元より大きくしない');
});

test('P18 切り抜きの枠: 絵の外に出ない・小さすぎない・全面はnull', () => {
  assert.equal(normCrop(null), null);
  assert.equal(normCrop({ x: 0, y: 0, w: 1, h: 1 }), null);
  const c = normCrop({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 });
  assert.ok(c.x + c.w <= 1.0001 && c.y + c.h <= 1.0001);
  const tiny = normCrop({ x: 0.1, y: 0.1, w: 0.001, h: 0.001 });
  assert.ok(tiny.w >= 0.08 && tiny.h >= 0.08);
});

test('P19 ズーム: 途中の値を出す。1より小さくしない(黒帯が出る)', () => {
  const z = { from: { scale: 1, cx: 0.5, cy: 0.5 }, to: { scale: 2, cx: 0.2, cy: 0.8 } };
  assert.deepEqual(zoomAt(z, 0), { scale: 1, cx: 0.5, cy: 0.5 });
  assert.deepEqual(zoomAt(z, 1), { scale: 2, cx: 0.2, cy: 0.8 });
  const mid = zoomAt(z, 0.5);
  assert.ok(Math.abs(mid.scale - 1.5) < 1e-9 && Math.abs(mid.cx - 0.35) < 1e-9);
  assert.equal(zoomAt(null, 0.5).scale, 1);
  assert.equal(zoomAt({ from: { scale: 0.2 }, to: { scale: 0.2 } }, 0.5).scale, 1);
});

test('P20 無音さがし: 短い息継ぎでは切らず、前後に余白を残す', () => {
  // 10秒ぶん・1秒ごとの山。3〜7秒が無音
  const peaks = [0.5, 0.4, 0.6, 0.01, 0.0, 0.02, 0.01, 0.5, 0.6, 0.4];
  const rs = silenceRanges(peaks, 10, { threshold: 0.06, minSec: 1.2, padSec: 0.25 });
  assert.equal(rs.length, 1);
  assert.ok(rs[0].start > 3 && rs[0].end < 7, `余白ぶん内側 ${JSON.stringify(rs[0])}`);
  // 1秒だけの静かな所は切らない
  assert.equal(silenceRanges([0.5, 0.0, 0.5], 3, { minSec: 1.2 }).length, 0);
  assert.deepEqual(silenceRanges([], 10), []);
  assert.deepEqual(silenceRanges([0.1], 0), []);
});

test('P21 ⚠src時刻の区間を消す: 部品が割れて、消した所が消える', () => {
  const p = proj([vc('c1', 0, 10)]);
  const q = cutSrcRanges(p, 's1', [{ start: 3, end: 5 }]);
  assert.deepEqual(q.clips.map(c => [c.start, c.end]), [[0, 3], [5, 10]]);
  assert.equal(projectOutSec(q), 8);
});

test('P22 ⚠消す区間が複数・重なっていても正しい', () => {
  const p = proj([vc('c1', 0, 20)]);
  const q = cutSrcRanges(p, 's1', [{ start: 2, end: 5 }, { start: 4, end: 7 }, { start: 15, end: 30 }]);
  assert.deepEqual(q.clips.map(c => [c.start, c.end]), [[0, 2], [7, 15]]);
});

test('P23 ⚠消す指定は「その元動画」だけに効く(つないだ別の動画を消さない)', () => {
  const p = proj([vc('c1', 0, 10), { id: 'c2', type: 'video', srcId: 's2', start: 0, end: 10, speed: 1 }]);
  const q = cutSrcRanges(p, 's1', [{ start: 3, end: 5 }]);
  assert.equal(q.clips.filter(c => c.srcId === 's2').length, 1);
  assert.deepEqual(q.clips.filter(c => c.srcId === 's2')[0], p.clips[1]);
});

test('P24 ⚠割った部品のidが重複しない(画面の並びが入れ替わる事故)', () => {
  const p = proj([vc('c1', 0, 20), vc('c2', 0, 20)]);
  const q = cutSrcRanges(p, 's1', [{ start: 5, end: 6 }, { start: 10, end: 11 }]);
  const ids = q.clips.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length, `重複: ${ids}`);
});

test('P25 mkId は既にある物とぶつからない', () => {
  assert.equal(mkId('c', [{ id: 'c1' }, { id: 'c2' }]), 'c3');
  assert.equal(mkId('o', []), 'o1');
  assert.equal(mkId('c', ['c1', 'c3']), 'c2');
});

test('P26 元動画から作る: 長さ0の物は入れない', () => {
  const p = projectFromSources([{ id: 'a', durationSec: 5 }, { id: 'b', durationSec: 0 }, null]);
  assert.equal(p.clips.length, 1);
  assert.deepEqual([p.clips[0].start, p.clips[0].end, p.clips[0].srcId], [0, 5, 'a']);
});

test('P27 書き出しの並び: out時刻つきで、速さも渡る', () => {
  const p = proj([vc('c1', 0, 10, 2), { id: 'c2', type: 'image', imageId: 'i1', durationSec: 3, caption: 'あ' }]);
  const parts = renderParts(p);
  assert.deepEqual(parts.map(x => x.type), ['video', 'image']);
  assert.equal(parts[0].speed, 2);
  assert.deepEqual([parts[0].outStart, parts[0].outEnd], [0, 5]);
  assert.deepEqual([parts[1].outStart, parts[1].outEnd], [5, 8]);
  assert.equal(parts[1].durationSec, 3);
});

test('P28 章で分ける: 区切りの前後で名前つきの区間になる', () => {
  const p = proj([vc('c1', 0, 30)]);
  const segs = chapterSegments(p, [{ name: '準備', atOut: 0 }, { name: '取付', atOut: 10 }, { name: '検査', atOut: 20 }]);
  assert.deepEqual(segs.map(s => [s.name, s.from, s.to]), [['準備', 0, 10], ['取付', 10, 20], ['検査', 20, 30]]);
});

test('P29 ⚠章の区切りが端すぎる/範囲外なら捨てる', () => {
  const p = proj([vc('c1', 0, 30)]);
  const segs = chapterSegments(p, [{ name: 'A', atOut: 0.01 }, { name: 'B', atOut: 99 }, { name: 'C', atOut: 15 }]);
  assert.deepEqual(segs.map(s => s.name), ['区間1', 'C']);
  assert.deepEqual(chapterSegments(proj([]), [{ name: 'A', atOut: 1 }]), []);
});

test('P30 読み込みの整え: 壊れた値でも落ちない', () => {
  const p = normalizeProject({
    clips: [null, { type: 'video', start: 5, end: 3 }, { type: 'video', srcId: 's', start: -1, end: 4, speed: 0 }, 'x'],
    overlays: [{ kind: 'nope', from: 0, to: 1 }, { kind: 'text', from: 2, to: 1 }, { kind: 'mark', from: 1, to: 3 }],
    rotate: 45, crop: { x: 2, y: 2, w: 2, h: 2 }, fps: 999, audio: { volume: 'x' },
  });
  assert.equal(p.clips.length, 1);
  assert.equal(p.clips[0].speed, 1);
  assert.equal(p.clips[0].start, 0);
  assert.equal(p.overlays.length, 1);
  assert.equal(p.rotate, 0);
  assert.equal(p.fps, 30);
  assert.equal(p.audio.volume, 1);
  assert.deepEqual(normalizeProject(null).clips, []);
  assert.deepEqual(normalizeProject('x').clips, []);
});

test('P31 残っている元の区間(消した所を帯で見せる用)', () => {
  const p = proj([vc('c1', 0, 3), vc('c2', 5, 10), { id: 'c3', type: 'image', durationSec: 2 }]);
  assert.deepEqual(keptSrcRanges(p, 's1'), [{ start: 0, end: 3 }, { start: 5, end: 10 }]);
});

test('P32 ⚠重ねをずらす計算: 前・またぐ・後ろ の3通り', () => {
  const os = [
    { id: 'a', kind: 'text', from: 0, to: 2 },     // 前 → 動かない
    { id: 'b', kind: 'text', from: 1, to: 6 },     // またぐ → 終わりだけ伸びる
    { id: 'c', kind: 'text', from: 5, to: 7 },     // 後ろ → まるごと動く
  ];
  assert.deepEqual(shiftOverlays(os, 4, 3).map(o => [o.id, o.from, o.to]),
    [['a', 0, 2], ['b', 1, 9], ['c', 8, 10]]);
});

test('P34 章の切り出し: またがる部品が正しく切れる', () => {
  const p = proj([vc('c1', 0, 10), { id: 'c2', type: 'image', durationSec: 4 }, vc('c3', 100, 106)]);
  const parts = renderParts(p);                       // 0-10 / 10-14 / 14-20
  const seg = sliceParts(parts, 8, 16);
  assert.deepEqual(seg.map(x => x.type), ['video', 'image', 'video']);
  assert.deepEqual([seg[0].start, seg[0].end], [8, 10], '前の部品は後ろ2秒だけ');
  assert.equal(seg[1].durationSec, 4, '画像は丸ごと入る');
  assert.deepEqual([seg[2].start, seg[2].end], [100, 102], '後ろの部品は頭2秒だけ');
  assert.deepEqual([seg[0].outStart, seg[2].outEnd], [0, 8], 'out時刻は0から振り直す');
});

test('P35 ⚠倍速の部品を途中で切ると、src時刻は速さぶん進む', () => {
  const p = proj([vc('c1', 0, 20, 2)]);               // 出来上がり10秒
  const seg = sliceParts(renderParts(p), 2, 4);       // 出来上がりの2〜4秒
  assert.deepEqual([seg[0].start, seg[0].end], [4, 8], '元では4〜8秒');
  assert.equal(seg[0].outSec, 2);
});

test('P36 章の切り出し: 範囲外・逆順は空', () => {
  const parts = renderParts(proj([vc('c1', 0, 10)]));
  assert.deepEqual(sliceParts(parts, 5, 5), []);
  assert.deepEqual(sliceParts(parts, 8, 3), []);
  assert.deepEqual(sliceParts(parts, 20, 30), []);
  assert.deepEqual(sliceParts([], 0, 5), []);
});

test('P33 patchClip: 画像の秒数も速さも安全な値に丸まる', () => {
  const p = proj([vc('c1', 0, 10), { id: 'c2', type: 'image', durationSec: 4 }]);
  assert.equal(patchClip(p, 0, { speed: 99 }).clips[0].speed, 4);
  assert.equal(patchClip(p, 1, { durationSec: -5 }).clips[1].durationSec, 0.2);
  assert.equal(patchClip(p, 0, { end: 0 }).clips[0].end, 0.05, '終わりは始まりより後');
});

// ---- ⏸ 止め絵(freeze) — 印がズレない唯一の確実な方法 -----------------------
import { insertFreezeAt } from '../videoProject.js';

test('P37 ⏸ 止め絵を差し込むと、その長さぶん出来上がりが伸びる', () => {
  const p = proj([vc('c1', 0, 10)]);
  const q = insertFreezeAt(p, 4, { durationSec: 3, marks: [{ x: 0.5, y: 0.5 }], caption: 'ここを見る' });
  assert.deepEqual(q.clips.map(c => c.type), ['video', 'freeze', 'video']);
  assert.equal(projectOutSec(q), 13);
  const f = q.clips[1];
  assert.equal(f.atSec, 4, '⚠止める位置は元の動画の秒');
  assert.equal(f.durationSec, 3);
  assert.equal(f.caption, 'ここを見る');
  assert.equal((f.marks || []).length, 1);
});

test('P38 ⚠倍速の部品の途中で止めると、元の秒に直して止める', () => {
  const p = proj([vc('c1', 0, 20, 2)]);          // 出来上がり10秒
  const q = insertFreezeAt(p, 3, { durationSec: 2 });
  const f = q.clips.find(c => c.type === 'freeze');
  assert.equal(f.atSec, 6, '出来上がり3秒 = 元の6秒');
});

test('P39 ⚠画像の上や、部品の無い所では止め絵を作らない', () => {
  const img = proj([{ id: 'c1', type: 'image', durationSec: 4 }]);
  assert.equal(insertFreezeAt(img, 2, { durationSec: 2 }).clips.length, 1, '画像の上では作らない');
  assert.equal(insertFreezeAt(proj([]), 0, {}).clips.length, 0);
});

test('P40 止め絵は out時刻→src時刻 で「その1枚」を指し続ける', () => {
  const p = proj([vc('c1', 0, 10)]);
  const q = insertFreezeAt(p, 4, { durationSec: 3 });
  // 止め絵の中はどこを見ても元の4秒
  assert.equal(outToSrc(q, 4.1).srcSec, 4);
  assert.equal(outToSrc(q, 6.5).srcSec, 4);
  // 止め絵の後ろは、元の4秒から続く
  assert.equal(Math.round(outToSrc(q, 8).srcSec * 10) / 10, 5);
});

test('P41 止め絵も切れる / 書き出しの並びに出る / 読み込みで壊れない', () => {
  const p = insertFreezeAt(proj([vc('c1', 0, 10)]), 4, { durationSec: 4 });
  const cut = splitAt(p, 6);
  assert.equal(cut.clips.filter(c => c.type === 'freeze').length, 2, '止め絵を2つに割れる');
  const parts = renderParts(p);
  const fp = parts.find(x => x.type === 'freeze');
  assert.equal(fp.atSec, 4);
  assert.equal(fp.durationSec, 4);
  const n = normalizeProject(JSON.parse(JSON.stringify(p)));
  assert.equal(n.clips.filter(c => c.type === 'freeze').length, 1, '保存して読み直しても残る');
  assert.equal(n.clips.find(c => c.type === 'freeze').atSec, 4);
});

test('P42 ⚠止め絵の中の重ねは、止めた長さぶん後ろへずれる', () => {
  const p = proj([vc('c1', 0, 10)], [{ id: 'o1', kind: 'text', from: 6, to: 8 }]);
  const q = insertFreezeAt(p, 4, { durationSec: 3 });
  assert.deepEqual(q.overlays.map(o => [o.from, o.to]), [[9, 11]]);
});

// 清水さん(2026-08-14)「挟んだ画像を何秒出しているかも選択できるように」
test('P43 ⚠⚠画像/止め絵の秒数を後から変えると、後ろの重ねも一緒にずれる（別の場面で字幕が出ない）', () => {
  const p = proj(
    [vc('c1', 0, 4), { id: 'c2', type: 'image', durationSec: 4 }, vc('c3', 0, 6)],
    [{ id: 'o1', kind: 'text', from: 1, to: 2 }, { id: 'o2', kind: 'text', from: 9, to: 11 }],
  );
  assert.equal(projectOutSec(p), 14);
  const long = setClipDuration(p, 1, 8);
  assert.equal(projectOutSec(long), 18, '4秒→8秒で全体も4秒のびる');
  assert.deepEqual(long.overlays.map(o => [o.from, o.to]), [[1, 2], [13, 15]], '前の重ねは動かない / 後ろは4秒ずれる');
  const back = setClipDuration(long, 1, 4);
  assert.deepEqual(back.overlays.map(o => [o.from, o.to]), [[1, 2], [9, 11]], '縮めれば戻る');
  assert.equal(projectOutSec(back), 14);
});

test('P44 秒数の変更: 短すぎる値・変な値・映像の部品では壊れない', () => {
  const p = proj([vc('c1', 0, 4), { id: 'c2', type: 'freeze', srcId: 's1', atSec: 2, durationSec: 3 }]);
  assert.equal(clipOutSec(setClipDuration(p, 1, 0).clips[1]), 0.2, '0秒は作らない');
  assert.equal(clipOutSec(setClipDuration(p, 1, 'あ').clips[1]), 3, '数でなければ そのまま');
  assert.equal(setClipDuration(p, 0, 9), p, '⚠映像の部品は変えない(あれは端をつまむ)');
  assert.equal(setClipDuration(p, 9, 5), p, '無い番号でも落ちない');
  assert.equal(setClipDuration(p, 1, 3), p, '同じ秒数なら何もしない(履歴を汚さない)');
});

// ---------------------------------------------------------------------------
// 🎙 あとから吹き込んだ言葉(notes) — 「言葉で探す」の材料
// ⚠⚠ **鍵つきの入れ物(map)** で持つ。配列にすると多端末で後勝ちで消える。
// ---------------------------------------------------------------------------
test('P45 空のプロジェクトに「言葉」の入れ物がある(配列ではない)', () => {
  const p = emptyProject();
  assert.equal(typeof p.notes, 'object');
  assert.equal(Array.isArray(p.notes), false);
  assert.deepEqual(p.notes, {});
});

test('P46 読み込みで「言葉」が落ちない(閉じても続きからやれる)', () => {
  const p = normalizeProject({
    clips: [vc('c1', 0, 10)],
    notes: { v50_1: { at: 5, text: '面取りを忘れない', kind: 'voice', by: '山田' } },
  });
  assert.deepEqual(p.notes, { v50_1: { at: 5, text: '面取りを忘れない', kind: 'voice', by: '山田' } });
});

test('P47 ⚠壊れた「言葉」は捨てる(空文字・数でない秒・配列で来た物)', () => {
  const p = normalizeProject({
    clips: [vc('c1', 0, 10)],
    notes: { a: { at: 1, text: '  ' }, b: { at: 'x', text: 'あ' }, c: null, d: { at: -3, text: 'よい' } },
  });
  assert.deepEqual(Object.keys(p.notes), ['d']);
  assert.equal(p.notes.d.at, 0, 'マイナスの秒は0に寄せる');
  assert.deepEqual(normalizeProject({ clips: [vc('c1', 0, 10)], notes: [1, 2] }).notes, {});
  assert.deepEqual(normalizeProject({ clips: [vc('c1', 0, 10)], notes: 'x' }).notes, {});
});

// ---------------------------------------------------------------------------
// 🔄 回転しても「標準」は標準のまま (2026-08-15)
// ⚠⚠ 前は 縦横を入れ替えた **後** の幅に上限を掛けていたので、90°回すと
//   854x480(41万画素) → 854x1518(130万画素) = **3.16倍** になっていた。
//   ビットレートは同じなので 1画素あたりの情報が 1/3.2 に落ちる
//   = 同じ「標準(おすすめ)」を選んだのに、回した時だけ黙って粗くなる。
//   pickVideoCodec は Level 4.0 まで試すので **エラーにもならない**。
// ---------------------------------------------------------------------------
test('P17b ⚠⚠回しても画素数が変わらない（同じ画質設定なら同じ量の絵）', () => {
  const px = (o) => o.width * o.height;
  const a = outputDims(1920, 1080, 0, null, 854);
  const b = outputDims(1920, 1080, 90, null, 854);
  const c = outputDims(1920, 1080, 270, null, 854);
  const d = outputDims(1920, 1080, 180, null, 854);
  const diff = Math.abs(px(b) - px(a)) / px(a);
  assert.ok(diff <= 0.02, `90°で画素数が ${(diff * 100).toFixed(1)}% 変わった (${a.width}x${a.height} → ${b.width}x${b.height})`);
  assert.deepEqual(b, c, '90°と270°は同じ大きさになるはず');
  assert.deepEqual(d, a, '180°は回さない時と同じ大きさになるはず');
});

test('P17c 90°回すと縦長になる。幅・高さとも偶数', () => {
  const b = outputDims(1920, 1080, 90, null, 854);
  assert.ok(b.height > b.width, `縦長になるはず ${b.width}x${b.height}`);
  assert.equal(b.width % 2, 0); assert.equal(b.height % 2, 0);
});

test('P17d ⚠元から縦の動画も、横の動画と同じ量の絵になる', () => {
  const yoko = outputDims(1920, 1080, 0, null, 854);
  const tate = outputDims(1080, 1920, 0, null, 854);
  const diff = Math.abs(yoko.width * yoko.height - tate.width * tate.height) / (yoko.width * yoko.height);
  assert.ok(diff <= 0.02, `縦と横で画素数が ${(diff * 100).toFixed(1)}% 違う (${yoko.width}x${yoko.height} / ${tate.width}x${tate.height})`);
});

test('P17e ⚠小さい元動画を引き伸ばさない（荒くするだけなので）', () => {
  assert.deepEqual(outputDims(640, 360, 0, null, 854), { width: 640, height: 360 });
  assert.deepEqual(outputDims(320, 240, 0, null, 1280), { width: 320, height: 240 });
});

test('P30b 回転は 0/90/180/270 だけ。半端な角度は 0 に落とす', () => {
  const rot = (r) => normalizeProject({ clips: [], rotate: r }).rotate;
  assert.equal(rot(0), 0); assert.equal(rot(90), 90);
  assert.equal(rot(180), 180); assert.equal(rot(270), 270);
  assert.equal(rot(-90), 270, '-90 は 270 と同じ');
  assert.equal(rot(45), 0, '半端な角度は回さない');
  assert.equal(rot(360), 0);
});
