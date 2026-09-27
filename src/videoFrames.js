// ============================================================================
// 🖼 タイムラインの材料 — 帯サムネイル と 音の波形
// ----------------------------------------------------------------------------
// 清水さん(2026-08-13)「市場比較は一番重要」
//
// ⚠市場の編集道具が例外なく持っていて、うちに無かった物の筆頭がこれ:
//   **時間の帯に小さい絵が並んでいて、どこに何が写っているか目で分かる**。
//   これが無いと「再生して探す」しかなく、6分の動画から1か所を切るだけで
//   6分かかる。編集にかかる時間が桁で変わる。
//   波形も同じ理由: **しゃべっている所が目で分かる** = 無言の所を落とせる。
//
// ⚠1枚ずつ返す(全部そろってから出さない)。長い動画で画面が固まって見えるため。
// ============================================================================

/** 帯に並べる小さい絵の高さ(px)。⚠大きくすると作るのが遅くなる。 */
export const THUMB_H = 48;

const openVideo = (fileOrUrl) => {
  const url = typeof fileOrUrl === 'string' ? fileOrUrl : URL.createObjectURL(fileOrUrl);
  const own = typeof fileOrUrl !== 'string';
  const v = document.createElement('video');
  v.preload = 'auto'; v.muted = true; v.playsInline = true;
  if (typeof fileOrUrl === 'string') v.crossOrigin = 'anonymous';
  v.src = url;
  return {
    v,
    close: () => {
      try { v.pause(); v.src = ''; v.load(); } catch { /* noop */ }
      if (own) { try { URL.revokeObjectURL(url); } catch { /* noop */ } }
    },
  };
};

const seekTo = (v, t) => new Promise((res) => {
  let done = false;
  const h = () => { if (done) return; done = true; v.removeEventListener('seeked', h); res(); };
  v.addEventListener('seeked', h);
  try { v.currentTime = t; } catch { h(); return; }
  // ⚠シークが返ってこない動画がある(壊れたWebM)。待ち続けない。
  setTimeout(h, 4000);
});

/**
 * 帯サムネイルを作る。1枚できるたび onThumb を呼ぶ。
 * @param fileOrUrl File か URL
 * @param count     枚数(帯の幅から決める)
 * @param opts.durationSec 分かっていれば渡す(壊れた動画で測り直さない)
 * @param opts.onThumb ({index, t, url}) => void
 * @param opts.signal  AbortSignal
 * @returns [{index, t, url}]
 */
export const thumbStrip = async (fileOrUrl, count = 12, opts = {}) => {
  const { onThumb = null, signal = null } = opts;
  const n = Math.max(1, Math.min(60, Math.round(count)));
  const { v, close } = openVideo(fileOrUrl);
  const out = [];
  try {
    await new Promise((res, rej) => {
      v.onloadeddata = res;
      v.onerror = () => rej(new Error('動画を読み込めません'));
      setTimeout(() => rej(new Error('読み込みに時間がかかりすぎました')), 30000);
    });
    let dur = Number(opts.durationSec) > 0 ? Number(opts.durationSec) : v.duration;
    if (!Number.isFinite(dur) || dur <= 0) {
      // ⚠前のアプリが吐いた WebM は長さが Infinity。終端へ飛ばして実測する。
      await seekTo(v, 1e7);
      dur = Number.isFinite(v.currentTime) ? v.currentTime : 0;
    }
    if (!(dur > 0)) return out;
    const w = Math.max(16, Math.round(THUMB_H * ((v.videoWidth || 16) / (v.videoHeight || 9))));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = THUMB_H;
    const ctx = cv.getContext('2d');
    for (let i = 0; i < n; i++) {
      if (signal && signal.aborted) break;
      // ⚠端ちょうどは真っ黒になりやすい。少し内側を撮る。
      const t = Math.min(dur - 0.05, Math.max(0, ((i + 0.5) / n) * dur));
      await seekTo(v, t);
      if (signal && signal.aborted) break;
      try { ctx.drawImage(v, 0, 0, w, THUMB_H); } catch { continue; }
      const url = cv.toDataURL('image/jpeg', 0.55);
      const item = { index: i, t, url };
      out.push(item);
      if (onThumb) { try { onThumb(item); } catch { /* 呼び出し側の都合で落とさない */ } }
    }
  } catch (e) {
    console.info('[動画] 帯の絵を作れませんでした:', e?.message || e);
  } finally { close(); }
  return out;
};

/**
 * 音の波形(0-1の山)を作る。
 * ⚠丸ごとデコードする。長い動画では時間がかかるので、呼び出し側で「作っています」を出すこと。
 * @returns {peaks: number[], durationSec, hasAudio}
 */
export const waveformPeaks = async (file, buckets = 400, opts = {}) => {
  const { signal = null } = opts;
  const n = Math.max(20, Math.min(4000, Math.round(buckets)));
  if (!file || typeof file.arrayBuffer !== 'function') return { peaks: [], durationSec: 0, hasAudio: false };
  let decoded = null;
  try {
    const buf = await file.arrayBuffer();
    if (signal && signal.aborted) return { peaks: [], durationSec: 0, hasAudio: false };
    const tmp = new (window.AudioContext || window.webkitAudioContext)();
    try { decoded = await tmp.decodeAudioData(buf); }
    finally { try { tmp.close(); } catch { /* noop */ } }
  } catch {
    // 音が入っていない動画はここに来る(ふつうのこと)
    return { peaks: [], durationSec: 0, hasAudio: false };
  }
  if (!decoded || !decoded.length) return { peaks: [], durationSec: 0, hasAudio: false };
  const ch = decoded.getChannelData(0);
  const per = Math.max(1, Math.floor(ch.length / n));
  const peaks = new Array(n).fill(0);
  let max = 0;
  for (let i = 0; i < n; i++) {
    const s = i * per, e = Math.min(ch.length, s + per);
    let m = 0;
    // ⚠全部の点を見ない(長い動画で固まる)。間引いて見る。
    const step = Math.max(1, Math.floor((e - s) / 400));
    for (let j = s; j < e; j += step) { const a = Math.abs(ch[j]); if (a > m) m = a; }
    peaks[i] = m;
    if (m > max) max = m;
  }
  // ⚠一番大きい所を1にそろえる(小さい声で録れた動画でも山が見える)
  if (max > 0.0001) for (let i = 0; i < n; i++) peaks[i] = Math.min(1, peaks[i] / max);
  return { peaks, durationSec: decoded.duration, hasAudio: true };
};
