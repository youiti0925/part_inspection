// 💬 AIが作った字幕の下書きを整える計算。
// ⚠ここがズレると「字幕が重なって前が消える」「一瞬で消えて読めない」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitText, tidySegments, segmentsToOverlays, tidyChapters, audioChunks, mergeSegments,
  MAX_CHARS, MIN_SEC, MAX_SEC,
} from '../subtitles.js';

test('S01 長い文は句読点で切る(日本語は空白で切れない)', () => {
  const out = splitText('まずカバーのボルトを4本外します。次にモーターの端子の緩みを確認します。', 20);
  assert.ok(out.length >= 2, `${out.length}枚`);
  assert.ok(out[0].endsWith('。'), `句点で切れていない: ${out[0]}`);
  for (const l of out) assert.ok([...l].length <= 20 + 2, `長すぎる: ${l}`);
});

test('S02 句読点が無ければ文字数で切る。⚠無限ループしない', () => {
  const out = splitText('あ'.repeat(95), 20);
  assert.equal(out.length, 5);
  assert.equal(out.join('').length, 95);
});

test('S03 短い文はそのまま。空は空', () => {
  assert.deepEqual(splitText('短い', 30), ['短い']);
  assert.deepEqual(splitText('', 30), []);
  assert.deepEqual(splitText(null, 30), []);
  assert.deepEqual(splitText('   ', 30), []);
});

test('S04 ⚠字幕どうしが重ならない(後の物が前を消さない)', () => {
  const out = tidySegments([
    { start: 0, end: 5, text: 'あああ' },
    { start: 3, end: 8, text: 'いいい' },   // 重なっている
    { start: 4, end: 9, text: 'ううう' },
  ]);
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].start >= out[i - 1].end, `${i}番目が重なっている ${JSON.stringify(out)}`);
  }
});

test('S05 ⚠短すぎる字幕は読める長さまで伸ばす', () => {
  const out = tidySegments([{ start: 1, end: 1.1, text: 'あ' }]);
  assert.ok(out[0].end - out[0].start >= MIN_SEC - 0.01, `${out[0].end - out[0].start}秒`);
});

test('S06 ⚠長すぎる字幕は切る(出っぱなしにしない)', () => {
  const out = tidySegments([{ start: 0, end: 60, text: 'あ' }]);
  assert.ok(out[0].end - out[0].start <= MAX_SEC + 0.01, `${out[0].end - out[0].start}秒`);
});

test('S07 長い文は複数枚に分かれ、時間も分かれる', () => {
  const out = tidySegments([{ start: 0, end: 8, text: 'あ'.repeat(90) }], 0, { maxChars: 30 });
  assert.equal(out.length, 3);
  assert.ok(out[0].start < out[1].start && out[1].start < out[2].start);
  assert.ok(out[2].end <= 8 + 0.2, `はみ出した ${out[2].end}`);
});

test('S08 ⚠出来上がりの長さを超える字幕は出さない/縮める', () => {
  const out = tidySegments([
    { start: 1, end: 3, text: 'あ' },
    { start: 9, end: 12, text: 'い' },     // 全体10秒なら縮む
    { start: 20, end: 22, text: 'う' },    // 全体より後ろ → 捨てる
  ], 10);
  assert.equal(out.length, 2);
  assert.ok(out[1].end <= 10.001, `${out[1].end}`);
});

test('S09 空の文・おかしな時刻は捨てる', () => {
  const out = tidySegments([
    { start: 0, end: 2, text: '   ' },
    { start: -5, end: 2, text: 'あ' },
    { start: 'x', end: 2, text: 'い' },
    null,
    { start: 3, end: 5, text: 'う' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'う');
  assert.deepEqual(tidySegments(null), []);
});

test('S10 重ねの形にする(そのまま焼ける)', () => {
  const ov = segmentsToOverlays([{ start: 1, end: 3, text: 'あ' }], { mkId: (i) => `x${i}` });
  assert.deepEqual(ov, [{ id: 'x0', kind: 'text', text: 'あ', from: 1, to: 3, pos: 'bottom', size: 'm', color: 'white' }]);
});

test('S11 区切りの案: 近すぎる物はまとめ、名無しは捨てる', () => {
  const out = tidyChapters([
    { at: 0, name: '準備' },
    { at: 2, name: '近すぎる' },
    { at: 30, name: '' },
    { at: 40, name: '測定' },
    { at: 999, name: '範囲外' },
  ], 100, 5);
  assert.deepEqual(out.map(c => c.name), ['準備', '測定']);
  assert.deepEqual(out.map(c => c.atSrc), [0, 40], '⚠返すのは元の動画の秒(atSrc)。出来上がりの秒(atOut)ではない');
});

test('S12 音声の塊: 長い動画は分けて送る。⚠切れ目で言葉が途切れないよう重ねる', () => {
  const cs = audioChunks(500, 180, 3);
  assert.equal(cs.length, 3);
  assert.deepEqual([cs[0].from, cs[0].to], [0, 180]);
  assert.equal(cs[1].from, 177, '前の終わりより少し前から');
  assert.equal(cs[1].offsetSec, 177, '戻す時の頭の位置');
  assert.equal(cs[2].to, 500);
  assert.deepEqual(audioChunks(0), []);
  assert.equal(audioChunks(60, 180).length, 1, '短い動画は1回で送る');
});

test('S13 ⚠重ねて送った所の重複を落とす', () => {
  const merged = mergeSegments([
    [{ start: 170, end: 172, text: 'あ' }, { start: 178, end: 180, text: 'い' }],
    [{ start: 178.2, end: 180, text: 'い' }, { start: 185, end: 187, text: 'う' }],
  ]);
  assert.deepEqual(merged.map(s => s.text), ['あ', 'い', 'う']);
});

test('S14 ⚠同じ時刻でも文が違えば残す(消しすぎない)', () => {
  const merged = mergeSegments([
    [{ start: 10, end: 12, text: 'あ' }],
    [{ start: 10.1, end: 12, text: 'い' }],
  ]);
  assert.equal(merged.length, 2);
});

test('S15 既定値が現場向きになっている', () => {
  assert.ok(MAX_CHARS <= 32, '1枚が長すぎると小さい画面で読めない');
  assert.ok(MIN_SEC >= 1, '一瞬で消えると読めない');
  assert.ok(MAX_SEC <= 10, '出っぱなしは邪魔');
});
