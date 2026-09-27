// 🎙 あとから声を入れる(アフレコ) — 静かな所で、動画を見ながら喋る。
//
// ⚠⚠ なぜ「撮りながら喋る」を前提にしないか:
//   清水さん(2026-08-14)「現場で本当にしゃべりながら仕事する事って本当に可能で、やってるの？」
//   市場も認めている。tebiki は「製造現場の機械音のように撮影時の周辺環境が音声収録を
//   難しくするケース」を名指しして、**後から声を吹き込む**機能を持っている。
//
// ⚠⚠ ここで作る物の出口は **文字**(字幕・探せる言葉)であって、音ではない:
//   工場は騒音でイヤホンを付けられない。音の説明は現場に届かない。
//   → 録った声は「字幕を作るための材料」。**動画に焼き込まない**。
//     焼き込むと元に戻せないうえ、音を足す実装は過去に2回事故を出している
//     (①軽量画質で音が丸ごと消えた ②合体だけ音声トラック無し)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VOICE_MIMES, BURN_IN_VOICE, MAX_TAKE_SEC,
  pickRecorderMime, voiceSupport, mapRecSecToOut, takeToNotes, notesToSegments, mkNoteId,
} from '../voiceOver.js';

const env = (over = {}) => ({
  secureContext: true,
  getUserMedia: true,
  mediaRecorder: (m) => m === 'audio/webm;codecs=opus',
  audioContext: true,
  audioEncoder: true,
  ...over,
});

// ---------------------------------------------------------------------------
// 端末が対応しているか(対応していないなら、その機能を出さない)
// ---------------------------------------------------------------------------
test('V01 ふつうのPC/Androidでは使える', () => {
  const s = voiceSupport(env());
  assert.equal(s.ok, true);
  assert.equal(s.mime, 'audio/webm;codecs=opus');
  assert.deepEqual(s.reasons, []);
});

test('V02 ⚠マイクが使えない端末では機能を出さない。理由が日本語で分かる', () => {
  const s = voiceSupport(env({ getUserMedia: false }));
  assert.equal(s.ok, false);
  assert.ok(s.reasons.length >= 1);
  assert.ok(s.reasons.every(r => /[ぁ-んァ-ヶ一-龥]/.test(r)), s.reasons.join('/'));
  assert.ok(s.why.includes('マイク'), s.why);
});

test('V03 ⚠録れる形式が1つも無い端末では出さない', () => {
  const s = voiceSupport(env({ mediaRecorder: () => false }));
  assert.equal(s.ok, false);
  assert.equal(s.mime, '');
});

test('V04 ⚠httpsでない所では出さない(マイクは安全な所でしか開かない)', () => {
  const s = voiceSupport(env({ secureContext: false }));
  assert.equal(s.ok, false);
});

test('V05 ⚠⚠iOSの古い版(AudioEncoderが無い)でも「録って字幕にする」は使える', () => {
  // Safari 26 で初めて AudioEncoder が入った。それ以前は音を作れない。
  // ⚠だからといって この機能を丸ごと消さない。**焼き込まない**作りなので、録るのは出来る。
  const s = voiceSupport(env({ audioEncoder: false }));
  assert.equal(s.ok, true, '録れないと判定してはいけない');
  assert.equal(s.canBurnIn, false);
});

test('V06 ⚠音を取り出せない端末では「字幕にする」だけ出さない(録るのは出せる)', () => {
  const s = voiceSupport(env({ audioContext: false }));
  assert.equal(s.canMakeSubtitles, false);
  assert.ok(s.why.includes('字幕'), s.why);
});

test('V07 ⚠⚠焼き込みは「しない」と決めた。値で分かる形にしておく', () => {
  // ここを true にする時は、必ず AudioEncoder の対応確認と
  // exportProject の音の道(1本)を壊さない設計をやり直すこと。
  assert.equal(BURN_IN_VOICE, false);
  // 対応している端末でも、焼き込みの「予定」は無い
  assert.equal(voiceSupport(env()).willBurnIn, false);
});

test('V08 使える形式を上から選ぶ(webm/opus が第一)', () => {
  assert.equal(pickRecorderMime(() => true), VOICE_MIMES[0]);
  assert.equal(pickRecorderMime((m) => m.startsWith('audio/mp4')), 'audio/mp4;codecs=mp4a.40.2');
  assert.equal(pickRecorderMime(() => false), '');
  assert.equal(pickRecorderMime(null), '');
});

test('V09 ⚠録りっぱなしを止める上限がある', () => {
  assert.ok(MAX_TAKE_SEC >= 60);
  assert.ok(MAX_TAKE_SEC <= 900, '長すぎるとAIに送る量も端末の memory も持たない');
});

// ---------------------------------------------------------------------------
// 「喋った秒」→「動画の中の秒」
// ---------------------------------------------------------------------------
test('V10 見ながら喋った秒が、動画の中の秒に直る', () => {
  const samples = [{ recSec: 0, outSec: 10 }, { recSec: 5, outSec: 15 }];
  assert.equal(mapRecSecToOut(samples, 0), 10);
  assert.equal(mapRecSecToOut(samples, 2.5), 12.5);
  assert.equal(mapRecSecToOut(samples, 5), 15);
});

test('V11 ⚠⚠途中で動画を止めて喋った言葉は、止めた場所に付く', () => {
  // 0-2秒は再生、2-6秒は一時停止(outSecが動かない)、6-8秒でまた再生
  const samples = [
    { recSec: 0, outSec: 10 }, { recSec: 2, outSec: 12 },
    { recSec: 4, outSec: 12 }, { recSec: 6, outSec: 12 }, { recSec: 8, outSec: 14 },
  ];
  assert.equal(mapRecSecToOut(samples, 4.5), 12, '止めている間の言葉が先に飛んでいる');
});

test('V12 ⚠戻って喋り直しても、その時見ていた場所に付く(秒が戻ってもよい)', () => {
  // 50秒あたりを見ながら3秒喋り → 10秒へ戻して喋り直し
  const samples = [{ recSec: 0, outSec: 50 }, { recSec: 3, outSec: 53 }, { recSec: 3.1, outSec: 10 }, { recSec: 6, outSec: 13 }];
  const v = mapRecSecToOut(samples, 5);
  // ⚠ここが「戻る前の50秒台」になっていたら、喋り直しが全部よその場面に付く
  assert.ok(v > 11 && v < 13, `戻って喋り直した所に付いていない: ${v}`);
});

test('V13 ⚠標本の外・空・壊れた値でも落ちない', () => {
  assert.equal(mapRecSecToOut([], 3), null);
  assert.equal(mapRecSecToOut(null, 3), null);
  const s = [{ recSec: 1, outSec: 20 }, { recSec: 4, outSec: 23 }];
  assert.equal(mapRecSecToOut(s, 0), 20, '始まる前は最初の場所');
  assert.equal(mapRecSecToOut(s, 99), 23, '終わった後は最後の場所');
  assert.equal(mapRecSecToOut([{ recSec: 'x', outSec: 'y' }], 1), null);
});

// ---------------------------------------------------------------------------
// 喋った物を「言葉」にする
// ---------------------------------------------------------------------------
const samples = [{ recSec: 0, outSec: 0 }, { recSec: 10, outSec: 10 }];

test('V14 喋った文が、その場面の言葉になる', () => {
  const r = takeToNotes({
    samples,
    segments: [{ start: 1, end: 2.5, text: '面取りを忘れない' }, { start: 4, end: 5, text: 'ここで一度止める' }],
    totalOutSec: 30, by: '山田',
  });
  assert.equal(r.count, 2);
  const list = Object.values(r.added);
  assert.deepEqual(list.map(n => [n.at, n.text, n.kind, n.by]), [[1, '面取りを忘れない', 'voice', '山田'], [4, 'ここで一度止める', 'voice', '山田']]);
});

test('V15 ⚠鍵つきの入れ物で返す(配列で足すと多端末で後勝ちで消える)', () => {
  const r = takeToNotes({ samples, segments: [{ start: 1, end: 2, text: 'あ' }], totalOutSec: 30 });
  assert.equal(Array.isArray(r.added), false);
  assert.equal(typeof r.added, 'object');
  assert.equal(Object.keys(r.added).length, 1);
});

test('V16 ⚠すでにある言葉と鍵がぶつからない', () => {
  const existing = { v10_1: { at: 1, text: '古い', kind: 'voice' } };
  const r = takeToNotes({ samples, segments: [{ start: 1, end: 2, text: '新しい' }], totalOutSec: 30, existing });
  const k = Object.keys(r.added)[0];
  assert.equal(Object.prototype.hasOwnProperty.call(existing, k), false, `鍵がぶつかった: ${k}`);
});

test('V17 ⚠空の文・時間の外は捨てる。捨てた数を返す', () => {
  const r = takeToNotes({
    samples,
    segments: [{ start: 1, end: 2, text: '  ' }, { start: 2, end: 3, text: 'よい' }, { start: 'x', end: 3, text: 'だめ' }],
    totalOutSec: 30,
  });
  assert.equal(r.count, 1);
  assert.equal(r.skipped, 2);
});

test('V18 ⚠出来上がりの長さより後ろには置かない', () => {
  const r = takeToNotes({
    samples: [{ recSec: 0, outSec: 0 }, { recSec: 100, outSec: 100 }],
    segments: [{ start: 90, end: 91, text: 'はみ出す' }], totalOutSec: 20,
  });
  assert.equal(r.count, 0);
  assert.equal(r.skipped, 1);
});

test('V19 ⚠録った声そのものは返さない(音は保存しない)', () => {
  const r = takeToNotes({ samples, segments: [{ start: 1, end: 2, text: 'あ' }], totalOutSec: 30, blob: { size: 999 } });
  const s = JSON.stringify(r);
  assert.equal(/blob|audio|base64|data:/i.test(s), false, `音が混ざっている: ${s.slice(0, 200)}`);
  for (const n of Object.values(r.added)) assert.deepEqual(Object.keys(n).sort(), ['at', 'by', 'kind', 'text']);
});

test('V20 鍵は決め打ちで作れる(同じ入力なら同じ鍵。Math.randomを使わない)', () => {
  assert.equal(mkNoteId(3.14, {}), mkNoteId(3.14, {}));
  assert.notEqual(mkNoteId(3.14, { [mkNoteId(3.14, {})]: 1 }), mkNoteId(3.14, {}));
});

// ---------------------------------------------------------------------------
// 言葉を字幕にする
// ---------------------------------------------------------------------------
test('V21 言葉を字幕の形にすると、読める長さが付く', () => {
  const segs = notesToSegments({
    a: { at: 5, text: '面取りを忘れない', kind: 'voice' },
    b: { at: 1, text: 'ここでノギスを当てて、まっすぐかどうかを必ず確認してください', kind: 'voice' },
    c: { at: 9, text: '', kind: 'voice' },
  });
  assert.deepEqual(segs.map(s => s.start), [1, 5], '秒の順に並んでいない');
  assert.ok(segs.every(s => s.end - s.start >= 1.2), '一瞬で消える字幕を作っている');
  assert.ok(segs.every(s => s.end - s.start <= 8), '出っぱなしの字幕を作っている');
  assert.ok(segs[1].end - segs[1].start < segs[0].end - segs[0].start, '長い文ほど長く出すべき');
});

test('V22 ⚠AIが聞き取った物は字幕にしない(吹き込んだ言葉だけ)', () => {
  const segs = notesToSegments({ a: { at: 1, text: 'AIの聞き取り', kind: 'ai' }, b: { at: 2, text: '吹き込み', kind: 'voice' } });
  assert.deepEqual(segs.map(s => s.text), ['吹き込み']);
});

test('V23 ⚠壊れた入力でも落ちない', () => {
  assert.deepEqual(notesToSegments(null), []);
  assert.deepEqual(notesToSegments([1, 2]), []);
  assert.deepEqual(takeToNotes({}).added, {});
  assert.deepEqual(takeToNotes(null).added, {});
});
