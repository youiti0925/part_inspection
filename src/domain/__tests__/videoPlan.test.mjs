// 🎬 動画書き出しの段取り。⚠壊れた動画を現場に配らないための計算。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUALITY, qualityOf, outputSize, segmentsFromCuts, canAddCut,
  outName, fmtDur, progressInfo, estimateBytes, fmtBytes, checkOutput,
} from '../videoPlan.js';

test('V01 画質の段。知らない名前は標準に落とす', () => {
  assert.equal(qualityOf('high').width, 1280);
  assert.equal(qualityOf('なにこれ').key, 'mid');
  assert.equal(qualityOf(undefined).key, 'mid');
  Object.values(QUALITY).forEach(q => {
    assert.equal(q.width % 2, 0, '幅は偶数');
    assert.ok(q.bitrate > 0 && q.audioBitrate > 0);
  });
});

test('V02 ⚠出力の幅・高さは必ず偶数（H.264が奇数を嫌う）', () => {
  const a = outputSize(1921, 1081, 854);
  assert.equal(a.width % 2, 0); assert.equal(a.height % 2, 0);
  assert.ok(a.width <= 854);
  const b = outputSize(640, 480, 854);
  assert.deepEqual(b, { width: 640, height: 480 }, '元が小さければ引き伸ばさない');
  const c = outputSize(0, 0, 640);
  assert.equal(c.width % 2, 0); assert.ok(c.width > 0 && c.height > 0);
  assert.equal(outputSize(3, 3, 854).width, 2, '極端に小さくても2以上・偶数');
});

test('V03 区切り位置から区間を作る', () => {
  const s = segmentsFromCuts(30, [10, 20]);
  assert.deepEqual(s.map(x => [x.start, x.end]), [[0, 10], [10, 20], [20, 30]]);
  assert.equal(s[1].duration, 10);
  assert.deepEqual(s.map(x => x.index), [0, 1, 2]);
});

test('V04 ⚠短すぎる欠片は作らない／重複・範囲外の区切りは捨てる', () => {
  assert.deepEqual(segmentsFromCuts(30, [10, 10, 10]).map(x => x.start), [0, 10], '重複はまとめる');
  assert.deepEqual(segmentsFromCuts(30, [0, 30, -5, 99]).map(x => [x.start, x.end]), [[0, 30]], '範囲外は捨てる');
  const s = segmentsFromCuts(10, [9.8]);
  assert.deepEqual(s.map(x => [x.start, x.end]), [[0, 9.8]], '0.2秒の欠片は作らない');
});

test('V05 ⚠長さが取れない動画では区間を作らない(壊れた物を量産しない)', () => {
  assert.deepEqual(segmentsFromCuts(Infinity, [5]), []);
  assert.deepEqual(segmentsFromCuts(0, [5]), []);
  assert.deepEqual(segmentsFromCuts(NaN, [5]), []);
  assert.deepEqual(segmentsFromCuts(null, []), []);
});

test('V06 全部短すぎたら、丸ごと1本として返す(何も出さないより良い)', () => {
  const s = segmentsFromCuts(0.6, [0.3]);
  assert.equal(s.length, 1);
  assert.deepEqual([s[0].start, s[0].end], [0, 0.6]);
});

test('V07 区切りを足せるかは理由つきで返す', () => {
  assert.equal(canAddCut(30, [], 15).ok, true);
  assert.equal(canAddCut(30, [], 0).ok, false);
  assert.match(canAddCut(30, [], 29.9).why, /終わり/);
  assert.match(canAddCut(30, [], 0.1).why, /先頭/);
  assert.match(canAddCut(30, [15], 15.2).why, /近く/);
  assert.equal(canAddCut(Infinity, [], 15).ok, true, '長さ不明でも足せる(あとで捨てる)');
});

test('V08 ファイル名にWindowsで使えない字を入れない', () => {
  assert.equal(outName('A/B:C*D?E"F<G>H|I', 0, 1), 'A_B_C_D_E_F_G_H_I.mp4');
  assert.equal(outName('手本', 0, 1), '手本.mp4');
  assert.equal(outName('手本', 0, 3), '手本_1.mp4');
  assert.equal(outName('手本', 2, 3), '手本_3.mp4');
  assert.equal(outName('   ', 0, 1), '動画.mp4');
});

test('V09 時間の書き方', () => {
  assert.equal(fmtDur(0), '0:00');
  assert.equal(fmtDur(75), '1:15');
  assert.equal(fmtDur(3725), '1:02:05');
  assert.equal(fmtDur(-5), '0:00');
});

test('V10 ⚠残り時間は実際の進み方から出す(決め打ちの見積りを出さない)', () => {
  const a = progressInfo(0, 100, 0);
  assert.equal(a.etaMs, null, '始まったばかりでは出さない');
  assert.equal(a.etaText, '');
  const b = progressInfo(50, 100, 10000);   // 半分を10秒で
  assert.equal(b.percent, 50);
  assert.equal(b.etaMs, 10000);
  assert.match(b.etaText, /あと約10秒/);
  assert.ok(Math.abs(b.speed - 5) < 0.01, '実時間の5倍で処理できている');
  const c = progressInfo(100, 100, 10000);
  assert.equal(c.percent, 99, '終わるまで100%にしない');
  const d = progressInfo(10, 100, 600000);
  assert.match(d.etaText, /あと約90分/);
});

test('V11 出来上がりの大きさの目安', () => {
  const e = estimateBytes(60, 'mid');
  assert.ok(e > 10 * 1024 * 1024 && e < 20 * 1024 * 1024, `60秒/標準で ${fmtBytes(e)}`);
  assert.equal(estimateBytes(0, 'mid'), 0);
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(2048), '2 KB');
  assert.equal(fmtBytes(3 * 1024 * 1024), '3.0 MB');
});

test('V12 ⚠⚠出来上がりの検査 — ここを通らない物は保存させない', () => {
  assert.equal(checkOutput({ bytes: 500000, durationSec: 10, expectedSec: 10, frames: 300 }).ok, true);

  // 今までの MediaRecorder の WebM がまさにこれ(実測: duration=Infinity)
  const inf = checkOutput({ bytes: 500000, durationSec: Infinity, expectedSec: 10 });
  assert.equal(inf.ok, false);
  assert.ok(inf.problems.some(p => p.includes('長さが入っていません')));

  const short = checkOutput({ bytes: 500000, durationSec: 5, expectedSec: 360 });
  assert.equal(short.ok, false);
  assert.ok(short.problems.some(p => p.includes('長さが違います')), '「6分のはずが5秒」を捕まえる');

  assert.equal(checkOutput({ bytes: 10, durationSec: 10, expectedSec: 10 }).ok, false, '空っぽ');
  assert.equal(checkOutput({ bytes: 500000, durationSec: 10, expectedSec: 10, frames: 0 }).ok, false, '絵が無い');
  assert.equal(checkOutput({ bytes: 500000, durationSec: 10.5, expectedSec: 10 }).ok, true, '少しのズレは許す');
});
