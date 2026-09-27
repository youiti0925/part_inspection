// ============================================================================
// 🎙 あとから声を入れる(アフレコ) — 静かな所で、動画を見ながら喋る
// ----------------------------------------------------------------------------
// 作業者から見て何が起きるか:
//   撮る時に喋らなくてよい。**あとで、静かな所で、動画を見ながら喋る**。
//   騒音もマスクも関係ない。喋りたい人だけが使う逃げ道。
//
// 清水さん(2026-08-14)「動画でしゃべる前提なの？ 現場で本当にしゃべりながら
//   仕事する事って本当に可能で、やってるの？」
// 市場も「現場で喋りながら」は難しいと認めている。tebiki は
// 「製造現場の機械音のように撮影時の周辺環境が音声収録を難しくするケース」を
// 名指しして、後から声を吹き込む機能を持っている。
//
// ============================================================================
// ⚠⚠⚠ ここが この機能の一番大事な決めごと ⚠⚠⚠
//
//   **録った声は、動画に焼き込まない。** 出口は「文字」。
//
//   理由①（現場）: 工場は騒音でイヤホンを付けられない。**音の説明は現場に届かない。**
//                  焼き込んでも、見る人には何も伝わらない。伝わるのは字幕の文字。
//   理由②（事故）: 音を足す実装は過去に2回事故を出している。
//                  ・軽量画質で音が丸ごと消えた（AACは96k以上しか通らない端末がある）
//                  ・合体だけ音声トラック無し（実装が2本あった）
//                  いまは `exportProject` 1本に統一済み。**そこを分岐させない。**
//   理由③（端末）: iOS は Safari 26 で初めて `AudioEncoder` が入った。それ以前は
//                  音を原理的にエンコードできない。焼き込む道を作ると、
//                  古いiPhoneで「黙って音が消えた動画」が量産される。
//   理由④（後戻り）: 焼き込むと元に戻せない。
//
//   → 録った声は **その場で字幕にして、音そのものは捨てる**。
//     字幕は ①動画に焼ける ②「言葉で探す」の材料になる ③紙の作業標準にも行く。
//     声を残したい要望が出たら、まず「何に使うのか」を聞くこと。
//     ここを true にする時は、AudioEncoder の対応確認と exportProject の
//     音の道(1本)を壊さない設計を、ゼロからやり直すこと。
// ============================================================================
//
// ⚠ここには React も ブラウザAPI も import しない (node --test で回すため)。
//   端末が何に対応しているかは **呼び出し側が調べて渡す**(voiceSupport の env)。

/** ⚠⚠ 焼き込みは「しない」。コメントではなく値で分かる形にしておく。 */
export const BURN_IN_VOICE = false;

/** 1回に録る長さの上限(秒)。⚠長すぎるとAIに送る量も端末のmemoryも持たない。 */
export const MAX_TAKE_SEC = 300;

/**
 * 録れる形式。上から順に試す。
 * ⚠webm/opus が第一(声がいちばん小さく入る)。iOS/Safari は mp4 しか出せない事がある。
 */
export const VOICE_MIMES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const r2 = (v) => Math.round(num(v, 0) * 100) / 100;
const r1 = (v) => Math.round(num(v, 0) * 10) / 10;

/** @param isSupported (mime) => boolean  … MediaRecorder.isTypeSupported を渡す */
export const pickRecorderMime = (isSupported) => {
  if (typeof isSupported !== 'function') return '';
  for (const m of VOICE_MIMES) {
    try { if (isSupported(m)) return m; } catch { /* この形式は使えない扱い */ }
  }
  return '';
};

/**
 * この端末で使えるか。⚠⚠ **使えないなら、その機能を画面に出さない。**
 *   押せるのに何も起きないボタンは「壊れている」と思われる。
 *
 * @param env.secureContext  https か localhost か(マイクは安全な所でしか開かない)
 * @param env.getUserMedia   マイクを開ける口があるか
 * @param env.mediaRecorder  (mime)=>bool
 * @param env.audioContext   録った音を取り出せるか(字幕にするのに要る)
 * @param env.audioEncoder   AudioEncoder があるか（**焼き込みには使わない**。表示用）
 */
export const voiceSupport = (env = {}) => {
  const e = env && typeof env === 'object' ? env : {};
  const reasons = [];
  const mime = pickRecorderMime(typeof e.mediaRecorder === 'function' ? e.mediaRecorder : null);
  if (!e.secureContext) reasons.push('この画面ではマイクを開けません（安全な接続=https ではありません）');
  if (!e.getUserMedia) reasons.push('この端末ではマイクを使えません');
  if (!mime) reasons.push('この端末では声を録れる形式がありません');
  const canMakeSubtitles = !!e.audioContext;
  const ok = reasons.length === 0;
  return {
    ok,
    mime: ok ? mime : (mime || ''),
    canMakeSubtitles,
    // ⚠ここが false でも「録る」は出来る(焼き込まない作りだから)。機能ごと消さないこと。
    canBurnIn: !!e.audioEncoder,
    willBurnIn: BURN_IN_VOICE,
    reasons,
    why: ok
      ? (canMakeSubtitles ? '' : 'この端末では録った声から字幕を作れません（録って自分で打つことはできます）')
      : reasons[0],
  };
};

// ---------------------------------------------------------------------------
// 「喋った秒」→「動画の中の秒」
// ---------------------------------------------------------------------------
/**
 * ⚠⚠ 経過時間で割り算しない。
 *   喋っている間に 一時停止したり・戻して喋り直したり・倍速の部品を通ったりする。
 *   だから **録っている間じゅう「いま何秒を見ていたか」を控えておいて**、その控えから引く。
 * @param samples [{recSec, outSec}] 録り始めからの秒 と その時見ていた動画の秒
 */
export const mapRecSecToOut = (samples, recSec) => {
  const list = (Array.isArray(samples) ? samples : [])
    .filter(s => s && Number.isFinite(Number(s.recSec)) && Number.isFinite(Number(s.outSec)))
    .map(s => ({ recSec: Number(s.recSec), outSec: Number(s.outSec) }))
    .sort((a, b) => a.recSec - b.recSec);
  if (!list.length) return null;
  const t = Number(recSec);
  if (!Number.isFinite(t)) return null;
  if (t <= list[0].recSec) return r2(list[0].outSec);
  const last = list[list.length - 1];
  if (t >= last.recSec) return r2(last.outSec);
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1], b = list[i];
    if (t <= b.recSec) {
      const span = b.recSec - a.recSec;
      if (!(span > 0)) return r2(b.outSec);
      return r2(a.outSec + (b.outSec - a.outSec) * ((t - a.recSec) / span));
    }
  }
  return r2(last.outSec);
};

// ---------------------------------------------------------------------------
// 喋った物を「言葉」にする
// ---------------------------------------------------------------------------
/** 鍵を作る。⚠Math.random を使わない(同じ入力なら同じ鍵)。 */
export const mkNoteId = (at, existing = {}) => {
  const base = `v${Math.round(Math.max(0, num(at, 0)) * 10)}`;
  const used = existing && typeof existing === 'object' ? existing : {};
  let n = 1;
  while (Object.prototype.hasOwnProperty.call(used, `${base}_${n}`)) n++;
  return `${base}_${n}`;
};

/**
 * 1回ぶんの吹き込みを「言葉」に直す。
 * ⚠⚠ 返すのは **鍵つきの入れ物(map)** だけ。配列で足す作りにしない
 *   (多端末で同じ動画を触ると、後から保存した端末が相手の分を消す)。
 * ⚠⚠ 録った音そのものは返さない。**音は保存しない。**
 *
 * @param input.samples   [{recSec, outSec}]
 * @param input.segments  [{start,end,text}] … 録った音の中の秒。videoTranscribe の返り値
 * @param input.totalOutSec 出来上がりの長さ(これより後ろには置かない)
 * @param input.existing  すでにある言葉(鍵をぶつけないため)
 * @returns {{added, count, skipped}}
 */
export const takeToNotes = (input) => {
  const src = input && typeof input === 'object' ? input : {};
  const segs = Array.isArray(src.segments) ? src.segments : [];
  const total = Number(src.totalOutSec);
  const by = String(src.by == null ? '' : src.by);
  const taken = { ...(src.existing && typeof src.existing === 'object' && !Array.isArray(src.existing) ? src.existing : {}) };
  const added = {};
  let skipped = 0;
  for (const s of segs) {
    const text = String(s && s.text != null ? s.text : '').replace(/\s+/g, ' ').trim();
    const at = mapRecSecToOut(src.samples, s && s.start);
    if (!text || at == null || !Number.isFinite(at)) { skipped++; continue; }
    // ⚠出来上がりの長さを超える所には置かない(押しても飛べない言葉になる)
    if (Number.isFinite(total) && total > 0 && at > total - 0.2) { skipped++; continue; }
    const id = mkNoteId(at, taken);
    const note = { at: r2(Math.max(0, at)), text: text.slice(0, 120), kind: 'voice', by };
    added[id] = note;
    taken[id] = note;
  }
  return { added, count: Object.keys(added).length, skipped };
};

/** 読むのにかかる秒。⚠一瞬で消える字幕・出っぱなしの字幕を作らない。 */
export const READ_MIN_SEC = 1.2;
export const READ_MAX_SEC = 8;
export const READ_CHARS_PER_SEC = 8;

/**
 * 吹き込んだ言葉を「字幕の下ごしらえ」の形にする。
 * ⚠この後 subtitles.tidySegments に通すこと(重なりを外し、長い文を切る)。
 * ⚠⚠ AIが聞き取った言葉は入れない。**人が吹き込んだ物だけ** を字幕にする
 *   (AIの聞き間違いをそのまま動画に焼くと、嘘の手本になる)。
 */
export const notesToSegments = (notes) => {
  const src = notes && typeof notes === 'object' && !Array.isArray(notes) ? notes : {};
  const out = [];
  for (const n of Object.values(src)) {
    if (!n || typeof n !== 'object') continue;
    if ((n.kind || 'voice') !== 'voice') continue;
    const text = String(n.text == null ? '' : n.text).replace(/\s+/g, ' ').trim();
    const at = Number(n.at);
    if (!text || !Number.isFinite(at) || at < 0) continue;
    const dur = Math.min(READ_MAX_SEC, Math.max(READ_MIN_SEC, [...text].length / READ_CHARS_PER_SEC));
    out.push({ start: r1(at), end: r1(at + dur), text });
  }
  return out.sort((a, b) => a.start - b.start);
};
