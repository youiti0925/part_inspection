// ============================================================================
// 🎞 本命の書き出し: 編集の中身(プロジェクト)を、そのまま1本のMP4にする
// ----------------------------------------------------------------------------
// 清水さん(2026-08-13)「市場比較は一番重要。編集する上で必要な機能は全部入れて」
//
// ⚠⚠ ここに1本化した理由:
//   前は用途ごとに別の関数(切り出し / つなぎ / 消す+画像)が並んでいて、
//   **つなぎ(exportJoin)だけ音を入れる作りになっていなかった**。
//   実測 2026-08-13: 合体した動画は返り値が `audio:false` 固定、muxer に音の枠すら無い
//   = 合体すると **音が丸ごと消えていた**。
//   道が3本あると、直したつもりが1本にしか入らない。→ これから全部この関数を通す。
//
// 出来ること(市場の道具に合わせた):
//   ・部品を並べる(切る/消す/並べ替え/つなぐ)   ・部品ごとの速さ(0.25〜4倍)
//   ・画像を挟む(印・説明つき)                   ・回転 / 切り抜き / 寄り(ズーム)
//   ・〇/矢印・テロップ・モザイク・スポットライトの焼き込み
//   ・音量 / 部品ごとの消音 / 頭とお尻のフェード ・章ごとに別ファイル(range)
//
// ⚠出す枚数は **必ず fps ちょうど** に整える。
//   倍速は間引き、スローは同じ絵を重ねる。ここをしないと
//   「2倍速にしたら60fpsの動画になる」「スローにしたらカクカク」になる。
// ============================================================================

import {
  hasWebCodecs, probeSource, fetchToFile, pickVideoCodec, pickAudioConfig,
  fastFrames, slowFrames, decodeAudioFull, abortIf, loadMuxer, qualityOf, checkOutput,
} from './videoEngine.js';
import {
  normalizeProject, renderParts, sliceParts, outputDims, zoomAt, normSpeed, emptyProject,
  // ⭕ 印・字幕・印の座標の意味。⚠3つの分岐(🖼画像/⏸止め絵/🎞映像)がこれ1本を通る。
  partOverlayInfo,
} from './domain/videoProject.js';
// 🔄 元動画の「回転の指示」を絵に反映する。⚠これが無いと縦動画が横に倒れる。
import { sourceRotateNeeded, rotatedSize, drawUpright } from './domain/videoRotation.js';
import { buildEditPlan } from './domain/videoPlan.js';
import { drawOverlays, drawOverlaysInBox, paintFrame } from './domain/videoOverlay.js';

const OAC = () => (typeof window !== 'undefined' && (window.OfflineAudioContext || window.webkitOfflineAudioContext)) || null;

/** 音を1本にまとめる。⚠速さは playbackRate で効かせる(市場の「早送り」と同じ聞こえ方)。 */
const renderProjectAudio = async (parts, buffers, p, totalOut, signal) => {
  const AC = OAC();
  if (!AC || !(totalOut > 0)) return null;
  // ⚠止め絵(freeze)と画像の間は **無音**。絵が止まっているのに音だけ進むと、
  //   見ている人は「固まった」と思う。音は動画の部品の間だけ流す。
  const usable = parts.filter(x => x.type === 'video' && !x.mute && buffers[x.srcId]);
  if (!usable.length) return null;
  const SR = 48000;
  const ctx = new AC(2, Math.max(1, Math.ceil(totalOut * SR)), SR);
  const master = ctx.createGain();
  const vol = Math.max(0, Number(p.audio?.volume) || 0);
  master.gain.value = vol;
  master.connect(ctx.destination);
  // 頭とお尻のフェード。⚠ぶつ切りで始まる/終わる動画は「壊れている」と思われる。
  const fi = Math.min(totalOut / 2, Math.max(0, Number(p.audio?.fadeIn) || 0));
  const fo = Math.min(totalOut / 2, Math.max(0, Number(p.audio?.fadeOut) || 0));
  if (fi > 0) { master.gain.setValueAtTime(0, 0); master.gain.linearRampToValueAtTime(vol, fi); }
  if (fo > 0) { master.gain.setValueAtTime(vol, Math.max(fi, totalOut - fo)); master.gain.linearRampToValueAtTime(0, totalOut); }
  for (const part of usable) {
    abortIf(signal);
    const s = ctx.createBufferSource();
    s.buffer = buffers[part.srcId];
    s.playbackRate.value = normSpeed(part.speed);
    const g = ctx.createGain();
    g.gain.value = Math.max(0, Number(part.volume ?? 1) || 0);
    s.connect(g); g.connect(master);
    // ⚠切るのは stop の時刻で。start の3つ目の引数(長さ)は、速さを掛けた時の
    //   解釈が端末によって割れる(音だけ途中で切れる事故になる)。
    try {
      s.start(part.outStart, Math.max(0, part.start));
      s.stop(Math.max(part.outStart + 0.01, part.outEnd));
    } catch (e) { console.warn('[動画] 音の並べ方で1つ落としました:', e?.message || e); }
  }
  return await ctx.startRendering();
};

/** 出来上がった音を AAC にして入れ物へ渡す。 */
const encodeAudioBuffer = async (muxer, buffer, audioCodec, bitrate, signal) => {
  const SR = buffer.sampleRate;
  const CH = Math.min(2, buffer.numberOfChannels);
  const aenc = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => console.warn('[動画] 音の書き出しに失敗:', e?.message || e),
  });
  aenc.configure({ codec: audioCodec, sampleRate: SR, numberOfChannels: CH, bitrate });
  const CHUNK = 1024;
  const inter = new Float32Array(CHUNK * CH);
  const chans = [];
  for (let c = 0; c < CH; c++) chans.push(buffer.getChannelData(c));
  for (let off = 0; off < buffer.length; off += CHUNK) {
    abortIf(signal);
    const n = Math.min(CHUNK, buffer.length - off);
    for (let i = 0; i < n; i++) for (let c = 0; c < CH; c++) inter[i * CH + c] = chans[c][off + i];
    aenc.encode(new AudioData({
      format: 'f32', sampleRate: SR, numberOfFrames: n, numberOfChannels: CH,
      timestamp: Math.round(off / SR * 1e6), data: inter.subarray(0, n * CH),
    }));
  }
  await aenc.flush(); aenc.close();
};

/**
 * @param project domain/videoProject.js の形
 * @param opts.sources { srcId: File | URL文字列 }
 * @param opts.images  { imageId: File | Blob }
 * @param opts.range   {from, to} 出来上がりの一部だけ(章ごとに別ファイルにする時)
 * @returns {{blob, durationSec, frames, width, height, audio, path, parts, elapsedMs}}
 */
export const exportProject = async (project, opts = {}) => {
  const {
    sources = {}, images = {}, quality = 'mid', fps: fpsIn = null,
    onProgress = null, signal = null, range = null,
    // ⚠自前で1枚ずつ描き足したい時の口(検証用・古い呼び出しの受け皿)。
    draw = null,
  } = opts;
  if (!hasWebCodecs()) throw new Error('このブラウザでは動画を書き出せません（Chrome か Edge の新しい版でお試しください）');
  const p = normalizeProject(project);
  if (!p.clips.length) throw new Error('編集する物がありません');
  const fps = [24, 30, 60].includes(Number(fpsIn)) ? Number(fpsIn) : p.fps;
  const q = qualityOf(quality);
  const t0 = Date.now();

  // ---- 元動画を手元に取ってきて下調べ -------------------------------------
  const files = {}, probes = {};
  // ⚠⚠ 止め絵(freeze)も **元の動画から1枚取り出す** ので、ここに入れないと落ちる。
  //   実害: 止め絵を残したまま、その元動画の映像部品を全部消すと
  //   `probes[part.srcId].durationSec` が undefined で書き出しが落ちる(普通の編集で踏む)。
  for (const id of [...new Set(p.clips.filter(c => (c.type === 'video' || c.type === 'freeze') && c.srcId).map(c => c.srcId))]) {
    abortIf(signal);
    let f = sources[id];
    if (!f) throw new Error('元の動画が見つかりません（選び直してください）');
    // ⚠URL(Drive)のままだと音が消え、速い読み方にも乗れない。先に手元へ。
    if (typeof f === 'string') f = await fetchToFile(f, 'drive-video.mp4', signal);
    files[id] = f;
    probes[id] = await probeSource(f);
    if (!probes[id].durationSec) throw new Error(probes[id].error || 'この動画の長さを取り出せません');
  }

  // ---- 書き出す並び --------------------------------------------------------
  let parts = renderParts(p);
  let overlays = p.overlays;
  if (range && Number.isFinite(Number(range.from)) && Number.isFinite(Number(range.to))) {
    const from = Number(range.from), to = Number(range.to);
    parts = sliceParts(parts, from, to);
    overlays = (p.overlays || [])
      .map(o => ({ ...o, from: Math.max(0, o.from - from), to: Math.min(to - from, o.to - from) }))
      .filter(o => o.to - o.from > 0.05);
  }
  if (!parts.length) throw new Error('残る部分がありません（全部消してしまっています）');
  const totalOut = parts.reduce((a, x) => a + (x.outEnd - x.outStart), 0);

  // ---- 出来上がりの大きさ(1本目の映像に合わせる) --------------------------
  const firstVid = parts.find(x => x.type === 'video');
  const bw = firstVid ? probes[firstVid.srcId].width : 1280;
  const bh = firstVid ? probes[firstVid.srcId].height : 720;
  const { width, height } = outputDims(bw, bh, p.rotate, p.crop, q.width);
  const codec = await pickVideoCodec(width, height, q.bitrate);
  if (!codec) throw new Error('この端末では動画を書き出せません（H.264に対応していません）');

  // ---- 音 ------------------------------------------------------------------
  let audioBuf = null, audioCodec = null;
  if (!p.mute) {
    const buffers = {};
    for (const id of Object.keys(files)) {
      abortIf(signal);
      const b = await decodeAudioFull(files[id]);
      if (b) buffers[id] = b;
    }
    if (Object.keys(buffers).length) {
      try { audioBuf = await renderProjectAudio(parts, buffers, p, totalOut, signal); }
      catch (e) { if (e?.name === 'AbortError') throw e; console.warn('[動画] 音をまとめられませんでした:', e?.message || e); }
      if (audioBuf) audioCodec = await pickAudioConfig({ sampleRate: audioBuf.sampleRate, channels: Math.min(2, audioBuf.numberOfChannels), bitrate: q.audioBitrate });
    }
  }

  // ---- 入れ物 --------------------------------------------------------------
  const { Muxer, ArrayBufferTarget } = await loadMuxer();
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target, fastStart: 'in-memory',
    video: { codec: 'avc', width, height },
    ...(audioBuf && audioCodec ? { audio: { codec: 'aac', sampleRate: audioBuf.sampleRate, numberOfChannels: Math.min(2, audioBuf.numberOfChannels) } } : {}),
  });
  let encFailed = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => { try { muxer.addVideoChunk(chunk, meta); } catch (e) { encFailed = encFailed || e; } },
    error: (e) => { encFailed = encFailed || new Error('書き出しに失敗しました: ' + (e?.message || e)); },
  });
  encoder.configure({ codec, width, height, bitrate: q.bitrate, framerate: fps, latencyMode: 'quality' });

  // 出す絵(out) / 元の絵をそのまま置く所(raw) / モザイクの下書き(scratch)
  const outCv = new OffscreenCanvas(width, height);
  const octx = outCv.getContext('2d', { alpha: false });
  let rawCv = null, rctx = null;
  const ensureRaw = (w, h) => {
    const ww = Math.max(2, w || 2), hh = Math.max(2, h || 2);
    if (!rawCv || rawCv.width !== ww || rawCv.height !== hh) {
      rawCv = new OffscreenCanvas(ww, hh);
      rctx = rawCv.getContext('2d', { alpha: false });
    }
    return rctx;
  };
  const scratch = (w, h) => new OffscreenCanvas(Math.max(1, w), Math.max(1, h));

  /**
   * 🔄 受け取った絵を **<video> で見えるのと同じ向き** に立て直して置く。
   *
   * ⚠⚠ WebCodecs の VideoDecoder は MP4 の回転の指示(tkhd matrix)を読まない。
   *   一方 出来上がりの寸法は probeSource(=<video>、指示を読んだ後)から決めている。
   *   ここで立て直さないと、スマホの縦動画が **横に倒れたまま縦の枠に押し込まれ**、
   *   上下に巨大な黒帯が付いて絵が半分以下の大きさになる(2026-08-15 清水さん報告)。
   * ⚠回す前に **寸法で答え合わせ** する(sourceRotateNeeded)。将来ブラウザ側が
   *   回すようになった時に二重に回して倒れるのを防ぐ。
   *
   * @param deg   fastFrames が渡してくる回転の指示。<video>から取った絵は 0
   * @param dispW/dispH probeSource が言う寸法(= 見えるべき向き)
   */
  const putRaw = (srcObj, sw, sh, deg, dispW, dispH) => {
    const w0 = sw || dispW || 2, h0 = sh || dispH || 2;
    const need = sourceRotateNeeded(deg, w0, h0, dispW, dispH);
    const size = rotatedSize(w0, h0, need);
    drawUpright(ensureRaw(size.width, size.height), srcObj, w0, h0, need);
  };

  // ---- 1枚ずつ出す ---------------------------------------------------------
  const frameUs = Math.round(1e6 / fps);
  const KEY_EVERY_US = 2_000_000;   // ⚠2秒ごとにキーフレーム。入れないとシークが効かない
  let slot = 0, nextKeyUs = 0, painted = false;
  let cur = null;   // いま置いてある絵の素性 { srcW, srcH, zoom, outStart, outSec, marks, caption }
  const expected = Math.max(1, Math.round(totalOut * fps));

  const encodeSlot = () => {
    if (encFailed) throw encFailed;
    abortIf(signal);
    const tOut = slot / fps;
    const prog = cur && cur.outSec > 0 ? Math.min(1, Math.max(0, (tOut - cur.outStart) / cur.outSec)) : 0;
    const box = paintFrame(octx, width, height, rawCv, cur?.srcW || width, cur?.srcH || height, {
      rotate: p.rotate, crop: p.crop, adjust: p.adjust, zoom: zoomAt(cur?.zoom, prog),
    });
    // 挟んだ画像に付けた印・説明は、その画像が出ている間ずっと出す
    if ((cur?.marks || []).length || cur?.caption) {
      const ov = [];
      for (const m of (cur.marks || [])) ov.push({ kind: 'mark', mark: m });
      // ⚠⚠ 「🖼 画像を挟む」の画面で付けた印は **絵の中の割合**(黒帯を除いた中で0〜1)。
      //   枠全体の割合として描くと、4:3の写真を16:9の動画に挟んだ時に
      //   **印が黒帯の上へ 12%ぶんズレる**(実測: 絵の右端の印が絵の外に出た)。
      //   編集画面では合って見えるので、出来上がりを見るまで気づけない。
      //   → 絵が乗っている所(box)へ写してから描く。
      if (ov.length) {
        if (cur.marksInPicture) drawOverlaysInBox(octx, width, height, ov, box, { scratch });
        else drawOverlays(octx, width, height, ov, { scratch });
      }
      // ⚠字幕は画面の下に出す物。絵の中に押し込めない(黒帯があっても下端に出す)。
      if (cur.caption) drawOverlays(octx, width, height, [{ kind: 'text', text: cur.caption, pos: 'bottom', color: 'white' }], { scratch });
    }
    const act = (overlays || []).filter(o => tOut >= o.from - 1e-6 && tOut < o.to - 1e-6);
    if (act.length) drawOverlays(octx, width, height, act, { scratch });
    if (draw) { try { draw(octx, width, height, tOut); } catch (e) { console.warn('[動画] 焼き込みで失敗:', e); } }

    const us = Math.round(slot * 1e6 / fps);
    const key = slot === 0 || us >= nextKeyUs;
    if (key) nextKeyUs = us + KEY_EVERY_US;
    const vf = new VideoFrame(outCv, { timestamp: us, duration: frameUs });
    encoder.encode(vf, { keyFrame: key });
    vf.close();
    slot++;
    if (onProgress && slot % 5 === 0) onProgress(Math.min(0.98, slot / expected), { stage: 'encode', frames: slot, elapsedMs: Date.now() - t0 });
  };

  /** その時刻より前の枚数を、いま置いてある絵で埋める。⚠倍速なら間引き、スローなら重ねる。 */
  const flushUntil = (untilOutSec) => { while (painted && (slot / fps) < untilOutSec - 1e-9) encodeSlot(); };

  let usedSlow = false;
  for (const part of parts) {
    abortIf(signal);
    if (part.type === 'image') {
      const img = images[part.imageId];
      if (!img) throw new Error('挟む画像が見つかりません（選び直してください）');
      let bmp;
      try { bmp = await createImageBitmap(img); }
      catch { throw new Error('画像を読み込めません（' + (img.name || '画像') + '）'); }
      ensureRaw(bmp.width, bmp.height).drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
      cur = {
        srcW: rawCv.width, srcH: rawCv.height, zoom: part.zoom,
        outStart: part.outStart, outSec: part.outEnd - part.outStart,
        ...partOverlayInfo(part),
      };
      painted = true;
      flushUntil(part.outEnd);
      continue;
    }
    if (part.type === 'freeze') {
      // ⏸ 止め絵: 元の動画の「その1枚」を取り出して、その絵のまま指定秒ぶん出す。
      // ⚠印が **ズレない唯一の確実な方法**(追尾が要らない)。動くのは手や部品なので、
      //   カメラを固定しても流したままではズレる。
      const file0 = files[part.srcId];
      const pr0 = probes[part.srcId];
      // ⚠それでも見つからない時は、黙って落ちずに何が足りないかを言う
      if (!file0 || !pr0) throw new Error('止め絵の元になる動画が見つかりません（選び直してください）');
      let got = false;
      // ⚠<video> から取った絵(slowFrames)はブラウザが既に立てている → deg は 0
      const take = (srcObj, sw, sh, deg = 0) => {
        if (got) return;                    // 最初の1枚だけ使う
        putRaw(srcObj, sw, sh, deg, pr0.width, pr0.height);
        got = true;
      };
      const win = Math.min(1.0, Math.max(0.2, (pr0.durationSec || 1) - part.atSec));
      try {
        if (pr0.canFastPath) await fastFrames(file0, part.atSec, part.atSec + win, (f2, _t2, deg) => take(f2, f2.displayWidth, f2.displayHeight, deg), signal);
        else { usedSlow = true; await slowFrames(file0, part.atSec, part.atSec + win, (v2) => take(v2, v2.videoWidth, v2.videoHeight, 0), signal); }
      } catch (e) {
        if (e && e.name === 'AbortError') { try { encoder.close(); } catch (e2) { /* noop */ } throw e; }
        usedSlow = true;
        await slowFrames(file0, part.atSec, part.atSec + win, (v2) => take(v2, v2.videoWidth, v2.videoHeight, 0), signal);
      }
      if (!got) throw new Error('止めたい所の絵を取り出せませんでした');
      cur = {
        srcW: rawCv.width, srcH: rawCv.height, zoom: part.zoom,
        outStart: part.outStart, outSec: part.outEnd - part.outStart,
        ...partOverlayInfo(part),
      };
      painted = true;
      flushUntil(part.outEnd);
      continue;
    }
    const file = files[part.srcId];
    const pr = probes[part.srcId];
    const sp = normSpeed(part.speed);
    // ⚠⚠ ここは前 `marks: [], caption: ''` と手で書いてあった。
    //   そのせいで **映像の部品に付けた印が、この1行で空に上書きされていた**
    //   (実測 2026-08-16: 書き出したMP4の赤い画素が 0。止め絵・画像は2000超)。
    //   3つの分岐を partOverlayInfo 1本に寄せて、片方だけ直る事故を潰す。
    // ⚠映像は流れているので、固定の印は場面が進むほどズレる。
    //   ズレない確実な出し方は ⏸止め絵(insertFreezeAt)。既定はそちらのまま。
    cur = {
      srcW: pr.width, srcH: pr.height, zoom: part.zoom,
      outStart: part.outStart, outSec: part.outEnd - part.outStart,
      ...partOverlayInfo(part),
    };
    // ⚠<video> から取った絵(slowFrames)はブラウザが既に立てている → deg は 0
    const onFrame = (srcObj, tRel, sw, sh, deg = 0) => {
      // ⚠新しい絵を置く **前** に、前の絵で埋めるべき枚数を出し切る
      flushUntil(part.outStart + tRel / sp);
      putRaw(srcObj, sw, sh, deg, pr.width, pr.height);
      cur.srcW = rawCv.width; cur.srcH = rawCv.height;
      painted = true;
    };
    try {
      if (pr.canFastPath) await fastFrames(file, part.start, part.end, (f, tRel, deg) => onFrame(f, tRel, f.displayWidth, f.displayHeight, deg), signal);
      else { usedSlow = true; await slowFrames(file, part.start, part.end, (v, tRel) => onFrame(v, tRel, v.videoWidth, v.videoHeight, 0), signal); }
    } catch (e) {
      if (e && e.name === 'AbortError') { try { encoder.close(); } catch { /* noop */ } throw e; }
      console.warn('[動画] 速い読み方に失敗。確実な読み方に切り替えます:', e?.message || e);
      usedSlow = true;
      await slowFrames(file, part.start, part.end, (v, tRel) => onFrame(v, tRel, v.videoWidth, v.videoHeight, 0), signal);
    }
    flushUntil(part.outEnd);
  }
  if (painted && slot === 0) encodeSlot();   // 極端に短くても1枚は入れる
  if (!slot) throw new Error('絵を1枚も取り出せませんでした（この動画は扱えません）');

  let audioOk = false;
  if (audioBuf && audioCodec) {
    try { await encodeAudioBuffer(muxer, audioBuf, audioCodec.codec, audioCodec.bitrate, signal); audioOk = true; }
    catch (e) { if (e?.name === 'AbortError') throw e; console.warn('[動画] 音を入れられませんでした:', e?.message || e); }
  }

  await encoder.flush();
  encoder.close();
  if (encFailed) throw encFailed;   // ⚠握り潰さない
  muxer.finalize();
  const blob = new Blob([target.buffer], { type: 'video/mp4' });
  const durationSec = slot / fps;
  // ⚠⚠ 出来上がりを必ず検算する。壊れた物を現場に配らないための最後の砦。
  const chk = checkOutput({ bytes: blob.size, durationSec, expectedSec: totalOut, frames: slot });
  if (!chk.ok) throw new Error('書き出したものがおかしいので保存しませんでした：' + chk.problems.join(' / '));

  // ⚠⚠ ここまでの検算は **自分が数えた枚数を、自分で確かめている** だけだった。
  //   それでは「出来上がったファイルが本当に再生できるか」は分からない。
  //   → 出来たものを **読み直して長さを実測** する。ここを通らない物は現場に配らない。
  let realSec = 0;
  try {
    const back = await probeSource(new File([blob], 'out.mp4', { type: 'video/mp4' }));
    realSec = back.durationSec || 0;
  } catch (e) { console.warn('[動画] 出来上がりを読み直せませんでした:', e?.message || e); }
  if (realSec > 0) {
    const diff = Math.abs(realSec - totalOut);
    if (diff > Math.max(0.8, totalOut * 0.15)) {
      throw new Error(`書き出したものの長さが合いません（${realSec.toFixed(1)}秒 / ${totalOut.toFixed(1)}秒のはず）。保存しませんでした。`);
    }
  }
  if (onProgress) onProgress(1, { stage: 'done', frames: slot, elapsedMs: Date.now() - t0 });
  return {
    blob, durationSec, frames: slot, width, height,
    audio: audioOk, path: usedSlow ? 'slow' : 'fast', parts: parts.length, elapsedMs: Date.now() - t0,
  };
};

/**
 * 🖼 いまの1枚を写真として取り出す(市場の道具の「フレームを書き出し」)。
 * ⚠現場では「この瞬間の写真がほしい」が多い。動画から切り出せると手順書がすぐ作れる。
 */
export const grabStill = async (source, atSec, opts = {}) => {
  const { type = 'image/jpeg', quality = 0.92, maxWidth = 1920, overlays = null, rotate = 0, crop = null, adjust = null, zoom = null } = opts;
  let src = source;
  if (typeof src === 'string') src = await fetchToFile(src, 'drive-video.mp4', null);
  const url = URL.createObjectURL(src);
  const v = document.createElement('video');
  v.preload = 'auto'; v.muted = true; v.playsInline = true; v.src = url;
  try {
    await new Promise((res, rej) => {
      v.onloadeddata = res;
      v.onerror = () => rej(new Error('動画を読み込めません'));
      setTimeout(() => rej(new Error('読み込みに時間がかかりすぎました')), 30000);
    });
    await new Promise(res => {
      const h = () => { v.removeEventListener('seeked', h); res(); };
      v.addEventListener('seeked', h);
      v.currentTime = Math.max(0, Number(atSec) || 0);
      setTimeout(res, 6000);
    });
    const { width, height } = outputDims(v.videoWidth, v.videoHeight, rotate, crop, maxWidth);
    const cv = document.createElement('canvas');
    cv.width = width; cv.height = height;
    const ctx = cv.getContext('2d');
    paintFrame(ctx, width, height, v, v.videoWidth, v.videoHeight, { rotate, crop, adjust, zoom });
    if (overlays && overlays.length) {
      drawOverlays(ctx, width, height, overlays, {
        scratch: (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, w); c.height = Math.max(1, h); return c; },
      });
    }
    return await new Promise((res, rej) => cv.toBlob(b => (b ? res(b) : rej(new Error('写真を作れませんでした'))), type, quality));
  } finally {
    try { v.pause(); v.src = ''; v.load(); } catch { /* noop */ }
    try { URL.revokeObjectURL(url); } catch { /* noop */ }
  }
};

/**
 * 🔗 つなぎ合わせ(複数の動画を1本に)。
 *
 * ⚠⚠ 前は videoEngine.js に別の実装があり、**そこだけ音を入れる作りになっていなかった**。
 *   実測 2026-08-13: 合体した動画は音の枠すら無く、返り値も `audio:false` 固定 =
 *   **合体すると音が丸ごと消えていた**。道を1本にして、二度と片方だけ直らないようにする。
 *
 * @param sources [{ source(File|URL), start?, end? }]
 */
export const exportJoin = async (sources, opts = {}) => {
  const { quality = 'mid', mute = false, fps = 30, onProgress = null, signal = null, rotate = 0 } = opts;
  const list = (sources || []).filter(Boolean);
  if (!list.length) throw new Error('つなぐ動画がありません');
  const map = {};
  const clips = [];
  for (let i = 0; i < list.length; i++) {
    abortIf(signal);
    const id = `s${i + 1}`;
    let f = list[i].source;
    if (typeof f === 'string') f = await fetchToFile(f, 'drive-video.mp4', signal);
    const pr = await probeSource(f);
    if (!pr.durationSec) throw new Error(`「${f?.name || '動画'}」の長さを取り出せません`);
    map[id] = f;
    clips.push({
      id: `c${i + 1}`, type: 'video', srcId: id,
      start: Math.max(0, Number(list[i].start) || 0),
      end: Number.isFinite(Number(list[i].end)) && Number(list[i].end) > 0 ? Number(list[i].end) : pr.durationSec,
      speed: 1, mute: false, volume: 1, zoom: null,
    });
  }
  // 🔄 回転。⚠既定0＝今までと同じ。▶編集室を通らない道(圧縮/分割/つなげる)は
  //   ここを通さないと **絶対に回せない**(emptyProject は rotate:0 固定)。
  const project = { ...emptyProject(), clips, fps, mute: !!mute, rotate };
  return exportProject(project, { sources: map, quality, fps, onProgress, signal });
};

/**
 * ✂ 1区間を切り出す（圧縮・分割はこれ）。
 *
 * ⚠⚠ 前は videoEngine.js に別の実装があった。そのせいで、こちらに入れた直し
 *   （回転・切り抜き・明るさ・重ねの焼き込み・音のまとめ方）が **圧縮と分割には
 *   一切入っていなかった**。「これから全部この関数を通す」と書いておきながら
 *   通っていない、という一番たちの悪い形だったので、包みにして1本へ寄せる。
 */
export const exportSegment = async (opts = {}) => {
  const {
    source, start = 0, end, quality = 'mid', draw = null, fps = 30,
    mute = false, onProgress = null, signal = null, rotate = 0,
  } = opts;
  if (!(end > start)) throw new Error('区間の指定がおかしいです');
  // ⚠URLのままだと音が消える。ここで失敗したら **黙って進まない**(前は空のcatchで捨てていた)。
  let f = source;
  if (typeof f === 'string') f = await fetchToFile(f, 'drive-video.mp4', signal);
  // 🔄 回転。⚠既定0＝今までと同じ。▶編集室を通らない道(圧縮/分割/つなげる)は
  //   ここを通さないと **絶対に回せない**(emptyProject は rotate:0 固定)。
  const project = {
    ...emptyProject(), fps, mute: !!mute, rotate,
    clips: [{ id: 'c1', type: 'video', srcId: 's1', start, end, speed: 1, mute: false, volume: 1, zoom: null }],
  };
  return exportProject(project, { sources: { s1: f }, quality, fps, draw, onProgress, signal });
};

/**
 * 🗑 いらない区間を消す / 🖼 画像を挟む。
 * ⚠これも上と同じ理由で1本へ寄せた。
 * @param opts.removes [{start,end}]  @param opts.inserts [{at,durationSec,image,marks,caption}]
 */
export const exportEdit = async (opts = {}) => {
  const {
    source, removes = [], inserts = [], quality = 'mid', fps = 30,
    mute = false, onProgress = null, signal = null, rotate = 0,
  } = opts;
  let f = source;
  if (typeof f === 'string') f = await fetchToFile(f, 'drive-video.mp4', signal);
  const pr = await probeSource(f);
  if (!pr.durationSec) throw new Error(pr.error || 'この動画の長さを取り出せません');
  const plan = buildEditPlan(pr.durationSec, removes, inserts);
  if (!plan.length) throw new Error('残る部分がありません（全部消してしまっています）');
  const images = {};
  const clips = plan.map((part, i) => {
    if (part.type === 'image') {
      const id = `i${i + 1}`;
      images[id] = part.insert?.image;
      return {
        id: `c${i + 1}`, type: 'image', imageId: id,
        durationSec: Math.max(0.5, Number(part.insert?.durationSec) || 4),
        marks: part.insert?.marks || [], caption: part.insert?.caption || '', zoom: null,
        // ⚠⚠ この道(「🖼 画像を挟む」の画面)の印は、写真の上で付けるので
        //   **絵の中の割合**(黒帯を除いた中で0〜1)で覚えている。
        //   編集室(タイムライン)の印は枠全体の割合なので、区別が要る。
        marksInPicture: true,
      };
    }
    return { id: `c${i + 1}`, type: 'video', srcId: 's1', start: part.start, end: part.end, speed: 1, mute: false, volume: 1, zoom: null };
  });
  // 🔄 回転。⚠既定0＝今までと同じ。▶編集室を通らない道(圧縮/分割/つなげる)は
  //   ここを通さないと **絶対に回せない**(emptyProject は rotate:0 固定)。
  const project = { ...emptyProject(), fps, mute: !!mute, clips, rotate };
  return exportProject(project, { sources: { s1: f }, images, quality, fps, onProgress, signal });
};
