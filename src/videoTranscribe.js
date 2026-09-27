// ============================================================================
// 🤖 動画の音声から「字幕の下書き」を作る
// ----------------------------------------------------------------------------
// 清水さん(2026-08-13):「AI自動作成っていらないってなってるけど、どういう意味？
//   できないのやらないの？ 正直自動で作られたらすごい現場楽じゃない？」
//
// ⚠⚠ ここが作るのは **下書き** だけ:
//   ・字幕(誰が何秒に何をしゃべったか)
//   ・作業の区切りの「案」
//   ・題名と説明の下書き
//   **「どこを消すか」はAIに決めさせない。** 何を残すかがエースの技で、そこを
//   自動化したら手本動画である意味が無くなる。消すのは必ず人。
//
// ⚠現場の条件: 工場は騒音でイヤホンを付けられない。音の説明は届かない。
//   字幕は装飾ではなく、伝わるかどうかの生命線。
//
// 仕組み:
//   ① 動画から音だけ取り出し、**16kHz モノラル**に落とす(送る量を1/12以下にする)
//   ② 1回に送れる大きさに上限があるので **数分ずつ**に分ける(切れ目で言葉が
//      途切れないよう、少し重ねて送る)
//   ③ Worker の /transcribe へ投げる(Geminiのキーはサーバ側にあり、画面には出ない)
//   ④ 返ってきた秒つきの文を、重なりを外して整える
//
// ⚠実測 2026-08-13: 日本語の音声15秒 → 秒までほぼ正確に返る(2秒の間もそのまま)。
// ============================================================================

import { audioChunks, mergeSegments, tidySegments, tidyChapters } from './domain/subtitles.js';

/** 送る音の細かさ。⚠人の声はこれで十分。上げても文字起こしは良くならず、量だけ増える。 */
export const STT_RATE = 16000;
/** 1回に送る長さ(秒)。⚠16kHz 16bit モノラルで 180秒 ≒ 5.8MB。 */
export const STT_CHUNK_SEC = 180;

/** 動画/音声のファイルから、16kHzモノラルの音を取り出す。 */
export const extractMono16k = async (file, signal = null) => {
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('元の動画がありません');
  const AC = window.AudioContext || window.webkitAudioContext;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!AC || !OAC) throw new Error('この端末では音を取り出せません');
  let decoded;
  const tmp = new AC();
  try { decoded = await tmp.decodeAudioData(await file.arrayBuffer()); }
  catch { throw new Error('この動画から音を取り出せません（音が入っていないかもしれません）'); }
  finally { try { tmp.close(); } catch { /* noop */ } }
  if (signal && signal.aborted) throw new DOMException('やめました', 'AbortError');
  if (!decoded || !decoded.length) throw new Error('この動画には音が入っていません');
  // ⚠モノラル1本に落とす(左右で別々に送る意味は無い)
  const off = new OAC(1, Math.max(1, Math.ceil(decoded.duration * STT_RATE)), STT_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  return out;
};

/**
 * 16bit の WAV にする。⚠Gemini が確実に読める形(audio/wav)。
 * @param buffer AudioBuffer(モノラル)
 * @param from/to 秒
 */
export const wavOf = (buffer, from = 0, to = null) => {
  const sr = buffer.sampleRate;
  const ch = buffer.getChannelData(0);
  const s0 = Math.max(0, Math.floor(from * sr));
  const s1 = Math.min(ch.length, to == null ? ch.length : Math.ceil(to * sr));
  const n = Math.max(0, s1 - s0);
  const bytes = new ArrayBuffer(44 + n * 2);
  const v = new DataView(bytes);
  const str = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    // ⚠1を超える値をそのまま16bitに入れると、折り返して **バリバリ音** になる。必ず挟む。
    const x = Math.max(-1, Math.min(1, ch[s0 + i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Uint8Array(bytes);
};

const toB64 = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
  return btoa(s);
};

/**
 * 字幕の下書きを作る。
 * @param file      元の動画(File)
 * @param opts.proxyUrl Worker の URL(VITE_GEMINI_PROXY_URL)
 * @param opts.hint  この動画の工程名など(読み取りの手がかり)
 * @param opts.totalSec 出来上がりの長さ(字幕をはみ出させない)
 * @param opts.onProgress ({done, total, phase}) => void
 * @returns {{segments, chapters, title, summary, notes}}
 */
export const transcribeVideo = async (file, opts = {}) => {
  const { proxyUrl = '', hint = '', totalSec = 0, onProgress = null, signal = null } = opts;
  const base = String(proxyUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('AIサーバーが未設定です（管理者: .env の VITE_GEMINI_PROXY_URL）');
  if (onProgress) onProgress({ done: 0, total: 1, phase: '音を取り出しています…' });
  const buf = await extractMono16k(file, signal);
  const chunks = audioChunks(buf.duration, STT_CHUNK_SEC, 3);
  if (!chunks.length) throw new Error('この動画には音が入っていません');

  const lists = [], chapLists = [], notes = [];
  let title = '', summary = '';
  for (const c of chunks) {
    if (signal && signal.aborted) throw new DOMException('やめました', 'AbortError');
    if (onProgress) onProgress({ done: c.index, total: chunks.length, phase: `音を聞いています… (${c.index + 1}/${chunks.length})` });
    const wav = wavOf(buf, c.from, c.to);
    const res = await fetch(`${base}/transcribe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ audioBase64: toB64(wav), mimeType: 'audio/wav', offsetSec: c.offsetSec, hint }),
    });
    const j = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    // ⚠1か所こけても、そこまでの結果は捨てない(長い動画で最後だけ失敗すると全部無駄になる)
    if (!j.ok) { notes.push(`${Math.round(c.from)}秒〜: ${j.error || '聞き取れませんでした'}`); continue; }
    // ⚠継ぎ目は3秒重ねて送っている。重なった所は **前の塊の物を正**とする。
    //   文字が1字でも違うと重複が残るので、**時刻で切る**(文字の一致に頼らない)。
    const cut = c.index === 0 ? -1 : c.offsetSec + 3;
    lists.push((j.segments || []).filter(x => c.index === 0 || Number(x?.start) >= cut - 0.01));
    chapLists.push(j.chapters || []);
    if (!title && j.title) title = j.title;
    if (!summary && j.summary) summary = j.summary;
    if (j.note) notes.push(j.note);
  }
  if (onProgress) onProgress({ done: chunks.length, total: chunks.length, phase: '字幕に整えています…' });
  const merged = mergeSegments(lists);
  const segments = tidySegments(merged, totalSec || buf.duration);
  const chapters = tidyChapters(chapLists.flat(), totalSec || buf.duration, 5);
  if (!segments.length && !notes.length) notes.push('しゃべっている所が見つかりませんでした（機械音だけの動画かもしれません）');
  return { segments, chapters, title, summary, notes };
};
