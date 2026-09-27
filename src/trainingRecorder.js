// 🎥 教材の録画マネージャ (仕様書 §4-2)。
//
// なぜ React の外(module-level)に置くか:
//   既存の VideoRecordModal は全画面モーダルで、閉じるとカメラが止まる(useEffect のクリーンアップ)。
//   教材は「作業しながら」録るので、画面のどこを開いても・工程を切り替えても録り続ける必要がある。
//   stream / MediaRecorder / chunks / 打刻 は React の再描画とは無関係の実体なので、
//   module-level に1つだけ置き、UI は subscribe して見るだけにする。
//
// ⚠この端末で同時に1本だけ。2本目を start しようとしたら明示エラーにする(黙って上書きしない)。
// ⚠✋サイン操作(前面カメラ)との同時使用は保証しない。呼び出し側でONなら止めてもらう。
// ⚠getUserMedia が失敗したら**必ずメッセージを返して開始しない**。黙って動かないのは禁止。
//
// 打刻の相対秒:
//   rel = (now - startedAt - pausedTotalMs) / 1000
//   一時停止(⏸)中は MediaRecorder も止まっていて映像が進まないため、止まっていた分を必ず引く。
//   ※「中断(休憩)」は録画を止めない。休憩区間は skip イベントとして積み、見る人が飛ばせるようにする。

import { buildChapters, buildBreakEvents, stepKeysOfChapters } from './domain/trainingChapters.js';

// 長回し前提。既存の撮影モーダル(5Mbps)は 30分で 1GB を超えて実用にならない。
export const TRAINING_VIDEO_BPS = 2500000;
export const TRAINING_WARN_SEC = 15 * 60;   // 黄色警告
export const TRAINING_DANGER_SEC = 30 * 60; // 赤警告 (⚠強制停止はしない。作業の邪魔をしない)

const listeners = new Set();

const S = {
  phase: 'idle',      // idle | starting | recording | paused | finishing | uploading | failed
  error: '',
  startedAt: 0,
  pausedAt: 0,
  pausedTotalMs: 0,
  bytes: 0,
  progress: 0,
  meta: null,         // { lotId, model, templateId, templateName, workerName, withAudio }
  marks: [],          // [{ stepKey, label, kind, at }]
  breaks: [],         // [{ start, end }]
  openBreakAt: null,
  pending: null,      // アップロード待ち/失敗して手元に残っている物
};

let stream = null;
let recorder = null;
let chunks = [];
let previewEl = null;
let performRef = null;
let unloadGuard = null;

const notify = () => { listeners.forEach(fn => { try { fn(); } catch (e) { console.error('[🎥] 通知に失敗', e); } }); };

export const subscribeTrainingRecorder = (fn) => {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
};

const relNow = () => {
  if (!S.startedAt) return 0;
  const base = S.phase === 'paused' && S.pausedAt ? S.pausedAt : Date.now();
  return Math.max(0, (base - S.startedAt - S.pausedTotalMs) / 1000);
};

export const trainingRecorderState = () => ({
  phase: S.phase,
  error: S.error,
  active: S.phase === 'recording' || S.phase === 'paused',
  busy: S.phase !== 'idle',
  elapsedSec: Math.floor(relNow()),
  bytes: S.bytes,
  progress: S.progress,
  meta: S.meta,
  markCount: S.marks.length,
  stepCount: new Set(S.marks.map(m => m.stepKey)).size,
  breakCount: S.breaks.length,
  hasPending: !!S.pending,
  pendingName: S.pending?.fileName || '',
});

const setPhase = (phase, error = '') => { S.phase = phase; S.error = error; notify(); };

const stopTracks = () => {
  try { stream?.getTracks().forEach(t => t.stop()); } catch { /* noop */ }
  stream = null;
  if (previewEl) { try { previewEl.srcObject = null; } catch { /* noop */ } }
};

const guardUnload = (on) => {
  if (typeof window === 'undefined') return;
  if (on && !unloadGuard) {
    unloadGuard = (e) => { e.preventDefault(); e.returnValue = ''; return ''; };
    window.addEventListener('beforeunload', unloadGuard);
  } else if (!on && unloadGuard) {
    window.removeEventListener('beforeunload', unloadGuard);
    unloadGuard = null;
  }
};

/** 録画中の映像を小さく出す(カメラの向きを確かめるため)。要素が消えたら null を渡す。 */
export const attachTrainingPreview = (el) => {
  previewEl = el || null;
  if (previewEl && stream) {
    try { previewEl.srcObject = stream; previewEl.muted = true; previewEl.play().catch(() => {}); } catch { /* noop */ }
  }
};

/**
 * 録画開始。成功で true、失敗は throw(呼び出し側が必ずメッセージを出すこと)。
 * @param withAudio 「コツを喋りながら」録るなら true
 */
export const startTrainingRecording = async ({ lotId = '', model = '', templateId = '', templateName = '', workerName = '', withAudio = true } = {}) => {
  if (S.phase !== 'idle') throw new Error(S.pending ? 'まだ保存できていない教材が残っています。先に保存かリトライを終わらせてください。' : 'すでに撮影中です。');
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) throw new Error('この端末/ブラウザではカメラを使えません(HTTPSでない可能性があります)。');
  if (typeof window === 'undefined' || !window.MediaRecorder) throw new Error('この端末/ブラウザは動画録画に対応していません。');
  setPhase('starting');
  let st;
  try {
    st = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: !!withAudio,
    });
  } catch (e) {
    setPhase('idle', '');
    throw new Error('カメラ' + (withAudio ? '/マイク' : '') + 'を起動できません: ' + (e?.message || e));
  }
  const cands = withAudio
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  const mt = cands.find(c => window.MediaRecorder.isTypeSupported(c)) || '';
  let mr;
  try {
    mr = new window.MediaRecorder(st, mt ? { mimeType: mt, videoBitsPerSecond: TRAINING_VIDEO_BPS } : undefined);
  } catch (e) {
    try { st.getTracks().forEach(t => t.stop()); } catch { /* noop */ }
    setPhase('idle', '');
    throw new Error('この端末は動画録画に対応していません: ' + (e?.message || e));
  }
  stream = st;
  recorder = mr;
  chunks = [];
  S.bytes = 0;
  S.marks = [];
  S.breaks = [];
  S.openBreakAt = null;
  S.pausedAt = 0;
  S.pausedTotalMs = 0;
  S.progress = 0;
  S.pending = null;
  S.meta = { lotId, model, templateId, templateName, workerName, withAudio: !!withAudio, startedAt: Date.now() };
  mr.ondataavailable = (e) => { if (e.data && e.data.size) { chunks.push(e.data); S.bytes += e.data.size; } };
  mr.start(1000);
  S.startedAt = Date.now();
  attachTrainingPreview(previewEl);
  guardUnload(true);
  setPhase('recording');
  return true;
};

/** ⏸ 一時停止 (映像も止める)。対応していない端末では false を返す。 */
export const pauseTrainingRecording = () => {
  if (S.phase !== 'recording' || !recorder || typeof recorder.pause !== 'function') return false;
  try { recorder.pause(); } catch { return false; }
  S.pausedAt = Date.now();
  setPhase('paused');
  return true;
};

export const resumeTrainingRecording = () => {
  if (S.phase !== 'paused' || !recorder || typeof recorder.resume !== 'function') return false;
  try { recorder.resume(); } catch { return false; }
  S.pausedTotalMs += Math.max(0, Date.now() - (S.pausedAt || Date.now()));
  S.pausedAt = 0;
  setPhase('recording');
  return true;
};

/**
 * 工程の打刻。作業画面の**状態遷移**から呼ぶ(タップ/音声/サイン/まとめて開始 の全経路が1本に通る)。
 * @param kind 'start' = 動き出した / 'end' = 止まった・完了した
 */
export const markTrainingStep = (stepKey, label = '', kind = 'start') => {
  if (!stepKey) return false;
  if (S.phase !== 'recording' && S.phase !== 'paused') return false;
  S.marks.push({ stepKey: String(stepKey), label: String(label || ''), kind: kind === 'end' ? 'end' : 'start', at: relNow() });
  notify();
  return true;
};

/** 中断(休憩)の開始/終了。⚠録画は止めない。見る人が飛ばせるよう skip 区間として積む。 */
export const markTrainingBreak = (isStart) => {
  if (S.phase !== 'recording' && S.phase !== 'paused') return false;
  if (isStart) {
    if (S.openBreakAt !== null) return false;
    S.openBreakAt = relNow();
  } else {
    if (S.openBreakAt === null) return false;
    S.breaks.push({ start: S.openBreakAt, end: relNow() });
    S.openBreakAt = null;
  }
  notify();
  return true;
};

// MediaRecorder の webm は duration が Infinity で来る端末がある。末尾へ飛ばすと確定する
// (既存の VideoRecipeStudio が onLoadedMetadata で使っているのと同じ手)。
const probeDurationSec = (blob) => new Promise((resolve) => {
  let done = false;
  let url = '';
  const finish = (d) => {
    if (done) return;
    done = true;
    try { if (url) URL.revokeObjectURL(url); } catch { /* noop */ }
    resolve(Number.isFinite(d) && d > 0 ? d : 0);
  };
  try {
    url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.onerror = () => finish(0);
    v.onloadedmetadata = () => {
      if (Number.isFinite(v.duration) && v.duration > 0) { finish(v.duration); return; }
      const fix = () => { if (Number.isFinite(v.duration) && v.duration > 0) { v.removeEventListener('timeupdate', fix); finish(v.duration); } };
      v.addEventListener('timeupdate', fix);
      try { v.currentTime = 1e7; } catch { /* noop */ }
    };
    setTimeout(() => finish(0), 8000); // 端末によっては確定しない。相対秒で代用する
    v.src = url;
  } catch { finish(0); }
});

const stopRecorder = () => new Promise((resolve) => {
  const mr = recorder;
  if (!mr || mr.state === 'inactive') { resolve(new Blob(chunks, { type: 'video/webm' })); return; }
  mr.onstop = () => resolve(new Blob(chunks, { type: mr.mimeType || 'video/webm' }));
  try { mr.stop(); } catch { resolve(new Blob(chunks, { type: mr.mimeType || 'video/webm' })); }
});

const fileNameFor = (meta, ext) => {
  const d = new Date();
  const base = `教材_${meta?.model || ''}_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  return `${base.replace(/[\\/:*?"<>|]/g, '_')}.${ext}`;
};

const extOf = (blob) => {
  const t = blob?.type || '';
  if (t.includes('mp4')) return 'mp4';
  if (t.includes('quicktime')) return 'mov';
  return 'webm';
};

const runPerform = async () => {
  const p = S.pending;
  if (!p || typeof performRef !== 'function') return false;
  S.progress = 0;
  setPhase('uploading');
  try {
    await performRef({ ...p, onProgress: (v) => { S.progress = Math.max(0, Math.min(1, Number(v) || 0)); notify(); } });
  } catch (e) {
    setPhase('failed', 'アップロード/保存に失敗しました: ' + (e?.message || e));
    return false; // ⚠blob は捨てない。バーのリトライボタンから同じ物をもう一度送れる
  }
  S.pending = null;
  performRef = null;
  S.marks = [];
  S.breaks = [];
  S.openBreakAt = null;
  S.startedAt = 0;
  S.bytes = 0;
  S.meta = null;
  guardUnload(false); // ⚠ここで初めて外す。送り終わるまでは「閉じますか?」を出し続ける
  setPhase('idle');
  return true;
};

/**
 * ⏹ 終了 → チャプター化 → 呼び出し側の perform でアップロード+保存。
 * @param perform async ({ blob, fileName, chapters, events, stepKeys, durationSec, meta, onProgress }) => void
 *                Drive と Firestore は App.jsx 側の関数を使う(このモジュールは通信しない)。
 */
export const finishTrainingRecording = async (perform) => {
  if (S.phase !== 'recording' && S.phase !== 'paused') return false;
  performRef = typeof perform === 'function' ? perform : null;
  // ⚠⏸一時停止のまま⏹を押された場合、ここで「止まっていた分」を締めてから phase を変える。
  //   relNow() は phase==='paused' の間だけ pausedAt を基準にするので、先に 'finishing' へ変えると
  //   基準が Date.now() に戻り、今回止まっていた時間が丸ごと録画長と休憩区間に足される
  //   (15分撮って10分放置 → 録画長 1500秒・実尺 900秒。章が実尺の1.6倍に伸びる)。
  if (S.phase === 'paused' && S.pausedAt) { S.pausedTotalMs += Math.max(0, Date.now() - S.pausedAt); S.pausedAt = 0; }
  setPhase('finishing');
  if (S.openBreakAt !== null) { S.breaks.push({ start: S.openBreakAt, end: relNow() }); S.openBreakAt = null; }
  const recordedSec = relNow();
  const blob = await stopRecorder();
  stopTracks();
  // ⚠guardUnload はここで外さない。この後 Drive へ数百MBを送る間にタブを閉じられると教材が消える。
  //   外すのは runPerform の成功時 / discard / cancel。
  recorder = null;
  chunks = [];
  // ⚠実際の動画の長さで末尾を clamp する。打刻の相対秒は端末の時計、動画は端末のエンコーダなので必ず一致しない。
  const probed = await probeDurationSec(blob);
  const durationSec = probed > 0 ? probed : recordedSec;
  const chapters = buildChapters({ marks: S.marks, durationSec });
  const events = buildBreakEvents({ breaks: S.breaks, durationSec });
  S.pending = {
    blob,
    fileName: fileNameFor(S.meta, extOf(blob)),
    chapters,
    events,
    stepKeys: stepKeysOfChapters(chapters),
    durationSec,
    meta: S.meta,
  };
  return runPerform();
};

/** 失敗した保存をもう一度。blob は手元に残っている。 */
export const retryTrainingUpload = () => runPerform();

/** 保存をあきらめて手元の動画を捨てる(確認は呼び出し側で取ること)。 */
export const discardTrainingRecording = () => {
  S.pending = null;
  performRef = null;
  S.marks = [];
  S.breaks = [];
  S.openBreakAt = null;
  S.startedAt = 0;
  S.bytes = 0;
  S.meta = null;
  guardUnload(false);
  setPhase('idle');
};

/** 撮影そのものを中止(保存しない)。確認は呼び出し側で取ること。 */
export const cancelTrainingRecording = async () => {
  if (S.phase !== 'recording' && S.phase !== 'paused') return false;
  setPhase('finishing');
  await stopRecorder();
  stopTracks();
  guardUnload(false);
  recorder = null;
  chunks = [];
  discardTrainingRecording();
  return true;
};
