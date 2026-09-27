// ============================================================================
// 🎬 動画の書き出しの「段取り」— 計算だけ(ブラウザのAPIは使わない)
// ----------------------------------------------------------------------------
// 清水さん(2026-08-13):
//   「圧縮も失敗するときもあれば成功したり、分割したら片方は6分表示なのに5秒で止まる」
//   「市場と比較して遜色ないぐらいのものにして」
//
// ⚠⚠ いままでの作り(canvas.captureStream + MediaRecorder)の致命傷:
//   MediaRecorder が吐く WebM は **長さ(duration)が Infinity** になる。
//   実測(2026-08-13 scripts/make-sample-video.mjs + verify-video-file.mjs):
//     8秒ぶん録った物 → duration=Infinity / seekable末尾=Infinity / 終わり際のフレームが取れない
//   これが「◯分と表示されるのに途中で止まる」「シークできない」の正体。
//   → 出力は **MP4(H.264/AAC)** にする。長さもシーク情報も正しく入る。
//
// ⚠ここには React も ブラウザAPI も import しない (node --test で回すため)。
// ============================================================================

/** 画質の段。⚠幅は偶数に丸める(H.264は奇数幅を嫌う)。 */
export const QUALITY = {
  high: { key: 'high', label: '高画質', width: 1280, bitrate: 4_000_000, audioBitrate: 128_000 },
  mid: { key: 'mid', label: '標準（おすすめ）', width: 854, bitrate: 1_800_000, audioBitrate: 96_000 },
  // ⚠⚠ 音は 96k より下げない。実測 2026-08-13: AAC は 96000/128000/160000/192000 しか
  //   受け付けない端末があり、64000 を渡すと **音が丸ごと消える**(例外が握り潰されていた)。
  //   軽量で削るのは映像だけにする(音が消えた動画は手本にならない)。
  low: { key: 'low', label: '軽量', width: 640, bitrate: 900_000, audioBitrate: 96_000 },
};
export const qualityOf = (k) => QUALITY[k] || QUALITY.mid;

/** 出力の大きさ。元の縦横比を保ち、指定幅に収める。⚠幅・高さとも偶数。 */
export const outputSize = (srcW, srcH, maxW) => {
  const w0 = Number(srcW) > 0 ? Number(srcW) : maxW;
  const h0 = Number(srcH) > 0 ? Number(srcH) : Math.round(maxW * 9 / 16);
  const scale = Math.min(1, maxW / w0);
  let w = Math.round(w0 * scale), h = Math.round(h0 * scale);
  w -= w % 2; h -= h % 2;
  return { width: Math.max(2, w), height: Math.max(2, h) };
};

/**
 * 区切り位置から、切り出す区間を作る。
 * ⚠短すぎる区間は作らない(0.2秒の欠片ができると「壊れている」と思われる)。
 * @returns [{index, start, end, duration}]
 */
export const segmentsFromCuts = (durationSec, cuts, minSec = 0.5) => {
  const dur = Number(durationSec);
  if (!Number.isFinite(dur) || dur <= 0) return [];
  const pts = [...new Set((cuts || [])
    .map(t => Math.round(Number(t) * 1000) / 1000)
    .filter(t => Number.isFinite(t) && t > 0 && t < dur))]
    .sort((a, b) => a - b);
  const bounds = [0, ...pts, dur];
  const out = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i], end = bounds[i + 1];
    if (end - start < minSec) continue;
    out.push({ index: out.length, start, end, duration: end - start });
  }
  // ⚠全部が短すぎて0本になったら、丸ごと1本として返す(何も出さないより良い)
  if (!out.length) out.push({ index: 0, start: 0, end: dur, duration: dur });
  return out;
};

/** 区切り位置を足せるか。⚠端すぎる位置・すでにある位置は足さない。 */
export const canAddCut = (durationSec, cuts, t, minGap = 0.4) => {
  const dur = Number(durationSec);
  const at = Number(t);
  if (!Number.isFinite(at) || at <= 0) return { ok: false, why: '先頭では区切れません' };
  if (Number.isFinite(dur) && dur > 0) {
    if (at >= dur - minGap) return { ok: false, why: '終わりの近くでは区切れません' };
    if (at < minGap) return { ok: false, why: '先頭の近くでは区切れません' };
  }
  if ((cuts || []).some(c => Math.abs(Number(c) - at) < minGap)) return { ok: false, why: 'すぐ近くに区切りがあります' };
  return { ok: true };
};

/** ファイル名。⚠Windowsで使えない字を必ず落とす。 */
export const outName = (base, index, total, ext = 'mp4') => {
  const b = String(base || '動画').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || '動画';
  const n = total > 1 ? `${b}_${index + 1}` : b;
  return `${n}.${ext}`;
};

/** 何分何秒。 */
export const fmtDur = (sec) => {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
};

/**
 * 進み具合と「あと何分」。
 * ⚠残り時間は **実際の進み方から** 出す。決め打ちの見積りを出さない(外れると信用を失う)。
 */
export const progressInfo = (doneSec, totalSec, elapsedMs) => {
  const total = Math.max(0.001, Number(totalSec) || 0);
  const done = Math.min(total, Math.max(0, Number(doneSec) || 0));
  const ratio = done / total;
  const el = Math.max(0, Number(elapsedMs) || 0);
  let etaMs = null;
  if (ratio > 0.02 && el > 1500) etaMs = Math.round(el / ratio - el);
  return {
    ratio,
    percent: Math.min(99, Math.floor(ratio * 100)),
    etaMs,
    etaText: etaMs == null ? '' : (etaMs < 60000 ? `あと約${Math.max(1, Math.round(etaMs / 1000))}秒` : `あと約${Math.round(etaMs / 60000)}分`),
    speed: el > 0 ? done / (el / 1000) : 0,   // 実時間の何倍で処理できているか
  };
};

/** 出来上がりの大きさの目安(バイト)。⚠あくまで目安と画面に書くこと。 */
export const estimateBytes = (durationSec, q) => {
  const p = qualityOf(q?.key || q);
  const bits = (p.bitrate + p.audioBitrate) * Math.max(0, Number(durationSec) || 0);
  return Math.round(bits / 8 * 1.02);   // コンテナのぶん少し足す
};

export const fmtBytes = (n) => {
  const b = Math.max(0, Number(n) || 0);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
};

/**
 * 書き出したものが「使える動画か」を、数字で判定する。
 * ⚠ここを通らない物は保存させない。壊れた動画を現場に配らないための最後の砦。
 */
export const checkOutput = ({ bytes, durationSec, expectedSec, frames }) => {
  const problems = [];
  const exp = Number(expectedSec) || 0;
  if (!(Number(bytes) > 1024)) problems.push('中身がほとんど空です');
  if (!Number.isFinite(Number(durationSec)) || Number(durationSec) <= 0) problems.push('長さが入っていません');
  else if (exp > 0) {
    const diff = Math.abs(Number(durationSec) - exp);
    if (diff > Math.max(0.7, exp * 0.12)) problems.push(`長さが違います（${Number(durationSec).toFixed(1)}秒 / ${exp.toFixed(1)}秒のはず）`);
  }
  if (frames != null && Number(frames) < 2) problems.push('絵が入っていません');
  return { ok: problems.length === 0, problems };
};

// ============================================================================
// 🗑 いらない区間を消す / 🖼 画像を挟む — 編集の段取り
// ----------------------------------------------------------------------------
// 清水さん(2026-08-13):
//   「動画のいらない区間削除も欲しい」
//   「ある部分には画像を追加したい。カメラだとPC画面の操作が見えないから、
//     部分で画像を挟んで、〇とか→とかコメントとか追加したい」
// ============================================================================

/** 消す区間を整える(重なりは1つにまとめ、範囲外は落とす)。 */
export const mergeRemoveRanges = (durationSec, removes) => {
  const dur = Number(durationSec);
  if (!Number.isFinite(dur) || dur <= 0) return [];
  // ⚠`Number(x)||0` で数に化かさない(MISTAKES.md A6)。数でない物は区間ごと捨てる。
  const rs = (removes || [])
    .filter(r => r && Number.isFinite(Number(r.start)) && Number.isFinite(Number(r.end)))
    .map(r => ({ start: Math.max(0, Number(r.start)), end: Math.min(dur, Number(r.end)) }))
    .filter(r => r.end - r.start > 0.05)
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of rs) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 0.05) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
};

/** 残す区間 = 全体から消す区間を引いた残り。⚠全部消したら空(呼び出し側で止める)。 */
export const keepRangesOf = (durationSec, removes) => {
  const dur = Number(durationSec);
  if (!Number.isFinite(dur) || dur <= 0) return [];
  const rs = mergeRemoveRanges(dur, removes);
  const out = [];
  let at = 0;
  for (const r of rs) {
    if (r.start - at > 0.1) out.push({ start: at, end: r.start });
    at = Math.max(at, r.end);
  }
  if (dur - at > 0.1) out.push({ start: at, end: dur });
  return out;
};

/**
 * 書き出す部品の並びを作る。
 * @param inserts [{ at, durationSec, image, marks }] … at = **元の動画の時刻**。
 *   ⚠消した区間の中に置いた画像も**捨てない**(消した所の代わりに画像で説明する使い方が本命)。
 *     その場合は、消えた場所の切れ目に挟まる。
 * @returns [{type:'video', start, end} | {type:'image', insert}] 順番どおり
 */
export const buildEditPlan = (durationSec, removes, inserts) => {
  const keeps = keepRangesOf(durationSec, removes);
  const ins = (inserts || [])
    .filter(i => i && Number.isFinite(Number(i.at)))
    .map(i => ({ ...i, at: Math.max(0, Number(i.at)) }))
    .sort((a, b) => a.at - b.at);
  const parts = [];
  let ii = 0;
  const flushBefore = (t) => { while (ii < ins.length && ins[ii].at <= t + 0.001) { parts.push({ type: 'image', insert: ins[ii] }); ii++; } };
  for (const k of keeps) {
    flushBefore(k.start);
    // 区間の途中に画像があれば、そこで割って挟む
    let s = k.start;
    while (ii < ins.length && ins[ii].at > s + 0.05 && ins[ii].at < k.end - 0.05) {
      parts.push({ type: 'video', start: s, end: ins[ii].at });
      parts.push({ type: 'image', insert: ins[ii] });
      s = ins[ii].at; ii++;
    }
    if (k.end - s > 0.05) parts.push({ type: 'video', start: s, end: k.end });
  }
  while (ii < ins.length) { parts.push({ type: 'image', insert: ins[ii] }); ii++; }
  return parts;
};

/** 出来上がりの長さ(秒)。 */
export const editPlanDuration = (parts) => (parts || []).reduce((a, p) =>
  a + (p.type === 'image' ? Math.max(0.5, Number(p.insert?.durationSec) || 4) : (p.end - p.start)), 0);
