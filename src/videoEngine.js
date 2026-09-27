// ============================================================================
// 🎬 動画の書き出し(切り出し・圧縮・つなぎ・焼き込み) — WebCodecs + MP4
// ----------------------------------------------------------------------------
// 清水さん(2026-08-13):
//   「圧縮も失敗するときもあれば成功したり、分割したら片方は6分表示なのに5秒で止まる」
//   「〇やコメントを付けて編集完了して最初から再生したら、なぜか途中で止まる」
//   「市場と比較して遜色ないぐらいのものにして」
//
// ⚠⚠ 前の作り(canvas.captureStream + MediaRecorder)の何が致命傷だったか:
//   ① MediaRecorder の WebM は **長さ(duration)が Infinity**。
//      実測 2026-08-13: 8秒録った物 → duration=Infinity / シークできない / 終わり際の絵が取れない。
//      これが「◯分と表示されるのに途中で止まる」「シークできない」の正体。
//   ② **実時間かかる**。6分の動画は6分。裏に回すと requestAnimationFrame が止まって固まる。
//   ③ 分割で **1本のMediaStreamを複数のMediaRecorderで使い回していた** → 2本目以降が壊れる。
//   ④ 途中で失敗すると、途中までの壊れたファイルが残る。
//
// これから:
//   ・出力は **MP4 (H.264 + AAC)**。長さもシーク情報も正しく入り、どの端末でも再生できる。
//   ・元がMP4なら **demux → VideoDecoder** で読む＝**実時間より速い**・フレーム単位で正確。
//   ・それ以外(WebMなど)は `<video>` を流して読む道に落ちる(遅いが確実)。落ちたことは呼び出し元に返す。
//   ・書き出したものは **必ず自分で検算**してから返す(長さ・フレーム数)。だめなら投げる。
//   ・途中でやめられる(AbortSignal)。
//
// ⚠WebCodecs は **安全なコンテキスト(https / localhost)** でしか使えない。
//   実測 2026-08-13: about:blank では VideoEncoder が生えない。
// ============================================================================

// ⚠ここで読む物は「この file が実際に使う物」だけにする。
//   ✂切り出し/🗑カットの段取り(buildEditPlan)と 印の描画(drawMarksOnCanvas)は
//   **src/videoExport.js へ移した**ので、ここからは読まない。
//   読んだままにすると「まだここにも道がある」と見えて、また2本目の実装が生える。
import { qualityOf, checkOutput } from './domain/videoPlan.js';
export { qualityOf, checkOutput };
import { degFromMatrix } from './domain/videoRotation.js';

// 重い部品は使うときだけ読む(初回バンドルに載せない。ExcelJS/JSZip と同じ方針)
let _Muxer = null, _MP4Box = null;
export const loadMuxer = async () => (_Muxer ||= await import('mp4-muxer'));
const loadMP4Box = async () => {
  if (_MP4Box) return _MP4Box;
  const m = await import('mp4box');
  // ⚠まとめ方によって createFile が default にあったり直下にあったりする。両方みる。
  _MP4Box = (m && typeof m.createFile === 'function') ? m
    : (m && m.default && typeof m.default.createFile === 'function') ? m.default
      : m.default || m;
  if (typeof _MP4Box.createFile !== 'function') throw new Error('動画の読み解き部品を読み込めません');
  return _MP4Box;
};

export const hasWebCodecs = () =>
  typeof window !== 'undefined' &&
  typeof window.VideoEncoder === 'function' &&
  typeof window.VideoDecoder === 'function' &&
  typeof window.VideoFrame === 'function';

/** 使える H.264 のプロファイルを選ぶ。⚠端末によって通る物が違うので必ず聞いてから使う。 */
export const pickVideoCodec = async (width, height, bitrate) => {
  const cands = ['avc1.4d0028', 'avc1.42001f', 'avc1.640028', 'avc1.42e01e'];
  for (const codec of cands) {
    try {
      const s = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate, framerate: 30 });
      if (s.supported) return codec;
    } catch (e) { /* 次を試す */ }
  }
  return null;
};

export const pickAudioCodec = async () => {
  const c = await pickAudioConfig({ sampleRate: 48000, channels: 2, bitrate: 96000 });
  return c ? c.codec : null;
};

/**
 * 🔊 使える音の設定(コーデックとビットレート)を **端末に聞いてから** 決める。
 *
 * ⚠⚠ 実測 2026-08-13(scripts/debug-audio.mjs):
 *   AAC は **96000 / 128000 / 160000 / 192000 しか受け付けない**端末がある。
 *   「軽量」画質の 64000 を渡すと configure が例外を投げ、それを握り潰していたため
 *   **軽量で書き出すと音が丸ごと消えていた**(画面には何も出ない)。
 *   → 欲しい値が通らなければ、通る値へ **黙って落とさず、上げて**使う。
 *
 * @returns {{codec, bitrate}} | null
 */
export const pickAudioConfig = async ({ sampleRate = 48000, channels = 2, bitrate = 96000 } = {}) => {
  const sr = Number(sampleRate) > 0 ? Math.round(Number(sampleRate)) : 48000;
  const ch = Math.min(2, Math.max(1, Math.round(Number(channels) || 2)));
  // 欲しい値 → 標準的に通る値、の順に聞く
  const rates = [...new Set([Math.round(Number(bitrate) || 96000), 96000, 128000, 160000, 192000, 64000])];
  for (const codec of ['mp4a.40.2', 'mp4a.40.5']) {
    for (const br of rates) {
      try {
        const r = await AudioEncoder.isConfigSupported({ codec, sampleRate: sr, numberOfChannels: ch, bitrate: br });
        if (r && r.supported) return { codec, bitrate: br };
      } catch (e) { /* 次を試す */ }
    }
  }
  return null;
};

export const abortIf = (signal) => { if (signal && signal.aborted) throw new DOMException('やめました', 'AbortError'); };

// ---------------------------------------------------------------------------
// 元の動画を調べる
// ---------------------------------------------------------------------------
/**
 * @returns {{durationSec, width, height, hasAudio, canFastPath, fileType, error}}
 * ⚠長さが取れない元動画(前のアプリが吐いたWebM)もここで分かる。分かった上で扱う。
 */
export const probeSource = async (fileOrUrl) => {
  const url = typeof fileOrUrl === 'string' ? fileOrUrl : URL.createObjectURL(fileOrUrl);
  const own = typeof fileOrUrl !== 'string';
  const v = document.createElement('video');
  v.preload = 'metadata'; v.muted = true; v.playsInline = true;
  if (typeof fileOrUrl === 'string') v.crossOrigin = 'anonymous';
  v.src = url;
  const info = { durationSec: 0, width: 0, height: 0, hasAudio: false, canFastPath: false, fileType: '', error: '' };
  try {
    await new Promise((res, rej) => {
      v.onloadedmetadata = res;
      v.onerror = () => rej(new Error('動画を読み込めません（対応していない形式か、壊れています）'));
      setTimeout(() => rej(new Error('動画の読み込みに時間がかかりすぎました')), 30000);
    });
    info.width = v.videoWidth; info.height = v.videoHeight;
    let d = v.duration;
    if (!Number.isFinite(d) || d <= 0) {
      // ⚠前のアプリが吐いた WebM は duration=Infinity。終端へシークして実測する。
      d = await new Promise(res => {
        const h = () => { v.removeEventListener('seeked', h); res(Number.isFinite(v.currentTime) ? v.currentTime : 0); };
        v.addEventListener('seeked', h);
        v.currentTime = 1e7;
        setTimeout(() => { v.removeEventListener('seeked', h); res(Number.isFinite(v.currentTime) ? v.currentTime : 0); }, 8000);
      });
      info.durationWasBroken = true;
    }
    info.durationSec = Number.isFinite(d) && d > 0 ? d : 0;
    if (!info.durationSec) info.error = 'この動画は長さを取り出せません（壊れている可能性があります）';
    const t = (typeof fileOrUrl === 'string' ? '' : (fileOrUrl.type || '')) || '';
    const nm = (typeof fileOrUrl === 'string' ? fileOrUrl : (fileOrUrl.name || '')).toLowerCase();
    info.fileType = t || (nm.endsWith('.mp4') ? 'video/mp4' : nm.endsWith('.webm') ? 'video/webm' : '');
    info.canFastPath = /mp4|quicktime|m4v/.test(info.fileType) || /\.(mp4|m4v|mov)$/.test(nm);
  } catch (e) {
    info.error = String(e?.message || e);
  } finally {
    try { v.src = ''; v.load(); } catch (e) { /* noop */ }
    if (own) { try { URL.revokeObjectURL(url); } catch (e) { /* noop */ } }
  }
  return info;
};

// ---------------------------------------------------------------------------
// 音声: ファイル全体をデコードして、必要な区間だけ切り出す
//   ⚠実時間で録らない。decodeAudioData は一気に読める。
// ---------------------------------------------------------------------------
const decodeAudioSlice = async (file, start, end, signal) => {
  if (!file || typeof file.arrayBuffer !== 'function') return null;
  try {
    const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const buf = await file.arrayBuffer();
    abortIf(signal);
    const tmp = new (window.AudioContext || window.webkitAudioContext)();
    let decoded;
    try { decoded = await tmp.decodeAudioData(buf.slice(0)); }
    finally { try { tmp.close(); } catch (e) { /* noop */ } }
    if (!decoded || !decoded.length) return null;
    const sr = decoded.sampleRate;
    const s0 = Math.max(0, Math.floor(start * sr));
    const s1 = Math.min(decoded.length, Math.ceil(end * sr));
    if (s1 <= s0) return null;
    const ch = Math.min(2, decoded.numberOfChannels);
    const off = new AC(ch, s1 - s0, sr);
    const src = off.createBufferSource();
    const cut = off.createBuffer(ch, s1 - s0, sr);
    for (let c = 0; c < ch; c++) cut.copyToChannel(decoded.getChannelData(c).subarray(s0, s1), c);
    src.buffer = cut; src.connect(off.destination); src.start();
    const rendered = await off.startRendering();
    return { buffer: rendered, sampleRate: sr, channels: ch };
  } catch (e) {
    // 音が入っていない動画はここに来る(ふつうのこと)。
    // ⚠本当に音があるのに取れなかった場合と見分けるため、内容を残す。
    console.info('[動画] 音声なし、または取り出せませんでした:', e?.message || e);
    return null;
  }
};

// ---------------------------------------------------------------------------
// 速い道: MP4 を demux して VideoDecoder で読む
// ---------------------------------------------------------------------------
/**
 * @param onFrame (frame, tRel, srcDeg) => void
 *   ⚠⚠ 第3引数 srcDeg は **この動画に書いてある回転の指示**(0/90/180/270)。
 *   VideoDecoder は指示を読まないので、コマは倒れたまま出てくる。受け取った側が
 *   立て直さないと、スマホの縦動画が横に倒れて黒帯だらけになる(videoRotation.js 参照)。
 */
export const fastFrames = async (file, start, end, onFrame, signal) => {
  const MP4Box = await loadMP4Box();
  const buf = await file.arrayBuffer();
  abortIf(signal);
  const mp4 = MP4Box.createFile();

  // ⚠⚠ 順番が命。mp4box は
  //     createFile → onReady で setExtractionOptions → start → appendBuffer → flush
  //   の順でないと、サンプル(中身)を1つも渡してくれない。
  //   (先に flush してしまうと、取り出す設定が無いので中身が捨てられ、**0フレーム**になる)
  let track = null;
  const samples = [];
  const ready = new Promise((res, rej) => {
    mp4.onReady = (info) => {
      track = (info.videoTracks || [])[0];
      if (!track) { rej(new Error('この動画には映像が入っていません')); return; }
      mp4.setExtractionOptions(track.id, null, { nbSamples: 1000 });
      mp4.start();
      res(info);
    };
    mp4.onError = (e) => rej(new Error('動画を読み解けません: ' + e));
    setTimeout(() => rej(new Error('動画の読み解きに時間がかかりすぎました')), 60000);
  });
  mp4.onSamples = (id, user, list) => { for (const s of list) samples.push(s); };

  const ab = buf.slice(0);
  ab.fileStart = 0;
  mp4.appendBuffer(ab);
  await ready;
  mp4.flush();
  abortIf(signal);
  if (!samples.length) throw new Error('動画の中身を取り出せませんでした');

  // デコーダの設定に要る description(avcC など)を取り出す
  const descOf = () => {
    const trak = mp4.getTrackById(track.id);
    for (const entry of (trak.mdia.minf.stbl.stsd.entries || [])) {
      const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
      if (!box) continue;
      const DataStream = MP4Box.DataStream;
      const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8);   // 先頭のボックスヘッダ8バイトを外す
    }
    return null;
  };

  // ⚠区間の頭より前の **直近のキーフレーム** から読む。そこより後ろから読むと絵が出ない。
  const secOf = (s) => s.cts / s.timescale;
  let from = 0;
  for (let i = 0; i < samples.length; i++) {
    if (secOf(samples[i]) > start) break;
    if (samples[i].is_sync) from = i;
  }
  let to = samples.length;
  for (let i = from; i < samples.length; i++) { if (secOf(samples[i]) >= end) { to = i; break; } }

  // 🔄 この動画の「回転の指示」。⚠ここで読んでおかないと誰も読まない。
  //   <video> は読んで回すが、VideoDecoder は読まない。両者の寸法が食い違う元。
  const srcDeg = degFromMatrix(track.matrix);

  let decoded = 0, emitted = 0;
  let failed = null;
  const decoder = new VideoDecoder({
    output: (frame) => {
      const t = frame.timestamp / 1e6;
      // ⚠キーフレームの都合で start より前のフレームも来る。捨てる。
      if (t < start - 0.001 || t >= end - 0.0005) { frame.close(); return; }
      emitted++;
      try { onFrame(frame, t - start, srcDeg); } catch (e) { failed = e; } finally { frame.close(); }
    },
    error: (e) => { failed = new Error('映像を読み解けません: ' + (e?.message || e)); },
  });
  decoder.configure({
    codec: track.codec,
    codedWidth: track.video?.width || track.track_width,
    codedHeight: track.video?.height || track.track_height,
    description: descOf() || undefined,
    hardwareAcceleration: 'prefer-hardware',
  });

  for (let i = from; i < to; i++) {
    if (failed) break;
    abortIf(signal);
    const s = samples[i];
    decoder.decode(new EncodedVideoChunk({
      type: s.is_sync ? 'key' : 'delta',
      timestamp: Math.round(s.cts / s.timescale * 1e6),
      duration: Math.round(s.duration / s.timescale * 1e6),
      data: s.data,
    }));
    decoded++;
    // ⚠溜め込みすぎない。大きい動画でメモリが尽きる。
    if (decoder.decodeQueueSize > 30) {
      await new Promise(r => setTimeout(r, 0));
      while (decoder.decodeQueueSize > 10 && !failed) await new Promise(r => setTimeout(r, 4));
    }
  }
  await decoder.flush();
  decoder.close();
  if (failed) throw failed;
  if (!emitted) throw new Error('この区間から絵を取り出せませんでした');
  return { decoded, emitted };
};

// ---------------------------------------------------------------------------
// 確実な道: <video> を流してフレームを取る(実時間)
//   ⚠requestVideoFrameCallback があればそれを使う(rAFより取りこぼさない)。
// ---------------------------------------------------------------------------
export const slowFrames = async (fileOrUrl, start, end, onFrame, signal, onTick) => {
  const url = typeof fileOrUrl === 'string' ? fileOrUrl : URL.createObjectURL(fileOrUrl);
  const own = typeof fileOrUrl !== 'string';
  const v = document.createElement('video');
  v.preload = 'auto'; v.muted = true; v.playsInline = true;
  if (typeof fileOrUrl === 'string') v.crossOrigin = 'anonymous';
  v.src = url;
  let emitted = 0;
  try {
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('動画を読み込めません')); setTimeout(() => rej(new Error('読み込みに時間がかかりすぎました')), 30000); });
    await new Promise(res => { const h = () => { v.removeEventListener('seeked', h); res(); }; v.addEventListener('seeked', h); v.currentTime = start; setTimeout(res, 5000); });
    abortIf(signal);
    await v.play().catch(() => {});
    await new Promise((res, rej) => {
      const useRVFC = typeof v.requestVideoFrameCallback === 'function';
      // ⚠⚠ **絵が届かなくなった時に「できました」で終わらせない。**
      //   この読み方は動画を実際に再生しながら1枚ずつ取る。書き出しの途中で
      //   別の画面へ行く・画面を消す・端末が重い、で絵が来なくなることがある。
      //   前は保険の時間切れで **成功として** 返していたので、書き出し側が
      //   「いま置いてある絵」で残りを埋め、**途中から止まったままの動画**が
      //   長さも枚数も正しい顔で出来上がっていた(2026-08-15 実測: 1枚だけで成功)。
      //   検算も読み直しも通るので、再生してみるまで誰も気づけない。
      const STALL_MS = 15000;
      let last = Date.now();
      let done = false;
      const watch = setInterval(() => {
        if (done) return;
        if (Date.now() - last > STALL_MS) {
          end2(rej, new Error('動画の絵が届かなくなりました（書き出しの間は、この画面を開いたままにしてください）'));
        }
      }, 1000);
      function end2(fn, arg) {
        if (done) return;
        done = true;
        clearInterval(watch);
        fn(arg);
      }
      const step = () => {
        if (done) return;
        if (signal && signal.aborted) { end2(rej, new DOMException('やめました', 'AbortError')); return; }
        const t = v.currentTime;
        if (t >= end - 0.001 || v.ended) { end2(res); return; }
        try { onFrame(v, t - start); emitted++; last = Date.now(); } catch (e) { end2(rej, e); return; }
        if (onTick) onTick(t - start);
        if (useRVFC) v.requestVideoFrameCallback(() => step());
        else requestAnimationFrame(step);
      };
      if (useRVFC) v.requestVideoFrameCallback(() => step()); else requestAnimationFrame(step);
      // ⚠最後の保険も **失敗として** 返す(黙って途中で切り上げない)
      setTimeout(() => end2(rej, new Error('動画から絵を取り切れませんでした（もう一度お試しください）')),
        (end - start) * 1000 * 3 + 60000);
    });
  } finally {
    try { v.pause(); v.src = ''; v.load(); } catch (e) { /* noop */ }
    if (own) { try { URL.revokeObjectURL(url); } catch (e) { /* noop */ } }
  }
  if (!emitted) throw new Error('この区間から絵を取り出せませんでした');
  return { emitted, decoded: emitted };
};

// ---------------------------------------------------------------------------
// 本体: 1区間を MP4 に書き出す
// ---------------------------------------------------------------------------
/**
 * @param opts.source   File(端末の動画) か URL(Driveなど)
 * @param opts.start/end 秒
 * @param opts.quality  'high'|'mid'|'low'
 * @param opts.draw     (ctx, w, h, tSec) => void  焼き込み(〇・文字)。省略可
 * @param opts.fps      出力のフレームレート(既定30)
 * @param opts.mute     音を消すか
 * @param opts.onProgress (0..1, {stage}) => void
 * @param opts.signal   AbortSignal
 * @returns {{blob, durationSec, frames, width, height, path:'fast'|'slow', audio:boolean}}
 */
/**
 * URL で渡された動画を、まず手元に取ってくる。
 * ⚠⚠ これをしないと (a)音が必ず消える (b)必ず遅い道に落ちる (c)canvasが汚れる を同時に踏む。
 *   現場の元動画はほとんど Drive にあるので、ここを飛ばすと速さの利点がゼロになる。
 */
export const fetchToFile = async (url, name = 'video.mp4', signal = null) => {
  const res = await fetch(url, { signal, credentials: 'omit' });
  if (!res.ok) throw new Error(`動画を取ってこられません（${res.status}）`);
  const blob = await res.blob();
  const type = blob.type || 'video/mp4';
  return new File([blob], name, { type });
};

// ⚠✂切り出し(exportSegment) は **src/videoExport.js へ移した**。
//   ここに別実装を置いていたせいで、あちらに入れた直し(回転・切り抜き・明るさ・
//   重ねの焼き込み・音のまとめ方)が **圧縮と分割には入っていなかった**。道は1本だけにする。

// ---------------------------------------------------------------------------
// [cut+image] カット(いらない区間を消す) + 画像を挟む — 1本の MP4 に書き出す
// ---------------------------------------------------------------------------
/** 音声をファイル1回だけデコードする(区間ごとに全体をデコードし直さない)。 */
export const decodeAudioFull = async (file) => {
  if (!file || typeof file.arrayBuffer !== 'function') return null;
  try {
    const buf = await file.arrayBuffer();
    const tmp = new (window.AudioContext || window.webkitAudioContext)();
    let decoded;
    try { decoded = await tmp.decodeAudioData(buf); }
    finally { try { tmp.close(); } catch (e) { /* noop */ } }
    if (!decoded || !decoded.length) return null;
    return decoded;
  } catch (e) {
    console.info('[動画] 音声なし、または取り出せませんでした:', e?.message || e);
    return null;
  }
};

// ⚠🗑カット/🖼画像挟み(exportEdit) も **src/videoExport.js へ移した**(理由は上と同じ)。
