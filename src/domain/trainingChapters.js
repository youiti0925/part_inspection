// 🎥 教材の自動チャプター化 — 打刻(marks)を「工程ごとの区間(chapters)」に畳む純関数。
//
// 狙い (仕様書 §4):
//   エースが**普通に1回作業するだけ**で、工程ごとのチャプター付き教材動画ができる。
//   教える側の追加負担は「撮影開始を押す」だけ。打刻は作業画面の既存操作から自動で拾う。
//
// ⚠打刻の相対秒について:
//   相対秒 = (Date.now() - 録画開始 - 一時停止していた合計) / 1000。
//   MediaRecorder を一時停止している間は映像が進まないので、止まっていた分を引かないと
//   後半のチャプターが全部ずれる(録画マネージャ側で引いた値をここへ渡す)。
//
// ⚠チャプターは工程ごとに最大1つ。
//   ・まとめて開始の台数分は同じ工程キーなので自然に1章へ畳まれる。
//   ・同じ工程を後で再開した場合も同じ章の end を伸ばす(章同士が時間的に重なってよい。
//     再生は start..end の区間再生なので重なっていても問題ない)。

/** 打刻1件。kind: 'start' = その工程が動き出した / 'end' = 止まった・完了した */
export const TRAINING_MARK_KINDS = ['start', 'end'];

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const r1 = (v) => Math.round(v * 10) / 10;

/**
 * 打刻 → チャプター。
 * @param marks       [{ stepKey, label, kind:'start'|'end', at:<相対秒> }] 時系列でなくてもよい(中で並べ直す)
 * @param durationSec 実際の動画の長さ(秒)。0 なら打刻の最大値で代用する
 * @param minSec      1章の最短の長さ。押してすぐ止めた等で長さ0の章を作らないための下限
 */
export const buildChapters = ({ marks = [], durationSec = 0, minSec = 1 } = {}) => {
  const list = (Array.isArray(marks) ? marks : [])
    .filter(m => m && m.stepKey && num(m.at) !== null)
    .map(m => ({ stepKey: String(m.stepKey), label: String(m.label || ''), kind: m.kind === 'end' ? 'end' : 'start', at: Math.max(0, num(m.at)) }))
    .sort((a, b) => a.at - b.at);
  if (!list.length) return [];

  const maxAt = list.reduce((mx, m) => Math.max(mx, m.at), 0);
  const dur = durationSec > 0 ? durationSec : maxAt;

  const byStep = new Map();
  list.forEach(m => {
    const cur = byStep.get(m.stepKey) || { stepKey: m.stepKey, label: m.label, start: null, end: null };
    if (m.label && !cur.label) cur.label = m.label;
    if (m.kind === 'start') {
      // 「最初の開始」が章の頭。2回目以降の開始では動かさない。
      if (cur.start === null) cur.start = m.at;
    } else {
      // 「最後の完了」まで章を伸ばす。
      cur.end = cur.end === null ? m.at : Math.max(cur.end, m.at);
      // 録画を始めた時点で既に動いていた工程は 'end' しか来ない。録画の頭からの章にする。
      if (cur.start === null) cur.start = 0;
    }
    byStep.set(m.stepKey, cur);
  });

  const out = [];
  let i = 0;
  byStep.forEach(c => {
    let start = Math.max(0, Math.min(c.start ?? 0, dur > 0 ? dur : (c.start ?? 0)));
    // 開始しか打刻が無い(録画終了まで作業が続いていた)章は、録画の末尾までを章にする。
    let end = c.end === null ? dur : c.end;
    if (dur > 0) end = Math.min(end, dur);
    if (end < start + minSec) end = Math.min(dur > 0 ? dur : start + minSec, start + minSec);
    if (end <= start) { // 長さが取れない(録画のほぼ末尾で打刻された)場合は手前へ寄せる
      start = Math.max(0, end - minSec);
    }
    i += 1;
    out.push({ id: `ch${i}`, stepKey: c.stepKey, label: c.label || '', start: r1(start), end: r1(end), source: 'auto' });
  });
  return out.sort((a, b) => a.start - b.start);
};

/**
 * 中断(休憩)の区間を、既存のレシピ形式の skip イベントとして積む。
 * ⚠新しい種類のイベントを作らない。既存プレイヤーがそのまま「飛ばす」を解釈できる形にする。
 * @param breaks [{ start:<相対秒>, end:<相対秒> }]
 */
export const buildBreakEvents = ({ breaks = [], durationSec = 0, minSec = 2 } = {}) => {
  const dur = durationSec > 0 ? durationSec : 0;
  return (Array.isArray(breaks) ? breaks : [])
    .map(b => ({ start: num(b?.start), end: num(b?.end) }))
    .filter(b => b.start !== null && b.end !== null)
    .map(b => {
      const start = Math.max(0, b.start);
      const end = dur > 0 ? Math.min(b.end, dur) : b.end;
      return { start, end };
    })
    .filter(b => b.end - b.start >= minSec)
    .map((b, i) => ({ id: `brk${i + 1}`, type: 'skip', start: r1(b.start), end: r1(b.end), label: '休憩', source: 'auto' }));
};

/**
 * ⚠stepKeys は chapters の stepKey を uniq した物を**必ず同時に保存する**。
 *   既存の🎬表示4箇所と作業画面の aceFor は stepKeys しか見ないため、
 *   片方だけ保存すると「この工程に動画がある」と認識されない(=既存の🎬が全部消える)。
 */
export const stepKeysOfChapters = (chapters = []) =>
  [...new Set((Array.isArray(chapters) ? chapters : []).map(c => c && c.stepKey).filter(Boolean))];

/** 教材のタイトル。`教材 {型式} {MM/DD} {作業者}` — 後から手で直せる。 */
export const trainingRecipeTitle = ({ model = '', at = Date.now(), workerName = '' } = {}) => {
  const d = new Date(at);
  const md = `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, '0')}`;
  return `教材 ${model || ''} ${md} ${workerName || ''}`.replace(/\s+/g, ' ').trim();
};
