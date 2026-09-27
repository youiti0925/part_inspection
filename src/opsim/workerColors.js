// =============================================================================
//  src/opsim/workerColors.js — 作業者ごとの色（盤と右の一覧で必ず同じ色にする）
// -----------------------------------------------------------------------------
//  🚨 色は **名簿の並び** ただ1つで決める。時刻でも、いま持っている仕事でも決めない。
//     時間を進めるたびに人の色が変わると、盤と右の一覧を見比べられなくなる。
//  🚨 札の色とぶつかる色を人に使わない。
//     rose=突破 / amber=遅れます / slate=順番待ち / cyan=迎撃中 はここに入れない。
//  ⚠ class は必ず**文字列そのまま**書く。`bg-${x}` の様に組み立てると Tailwind が拾えず、
//    本番ビルドでその色だけ消える。
//  ⚠ 実データの作業者は4人（2026-08-24 時点: 尾田・村・片山・信濃）。
//    7人目からは色が2人で同じになる。だから **色だけで見分けさせない**（名前を必ず添える）。
// =============================================================================

/** 人の色。上から順に配る。 */
export const WORKER_TONES = Object.freeze([
  { key: 'blue',    dot: 'bg-blue-500',    text: 'text-blue-700',    border: 'border-blue-300',    bg: 'bg-blue-50',    beam: 'from-blue-200 to-blue-500' },
  { key: 'teal',    dot: 'bg-teal-500',    text: 'text-teal-700',    border: 'border-teal-300',    bg: 'bg-teal-50',    beam: 'from-teal-200 to-teal-500' },
  { key: 'violet',  dot: 'bg-violet-500',  text: 'text-violet-700',  border: 'border-violet-300',  bg: 'bg-violet-50',  beam: 'from-violet-200 to-violet-500' },
  { key: 'fuchsia', dot: 'bg-fuchsia-500', text: 'text-fuchsia-700', border: 'border-fuchsia-300', bg: 'bg-fuchsia-50', beam: 'from-fuchsia-200 to-fuchsia-500' },
  { key: 'sky',     dot: 'bg-sky-500',     text: 'text-sky-700',     border: 'border-sky-300',     bg: 'bg-sky-50',     beam: 'from-sky-200 to-sky-500' },
  { key: 'lime',    dot: 'bg-lime-500',    text: 'text-lime-700',    border: 'border-lime-300',    bg: 'bg-lime-50',    beam: 'from-lime-200 to-lime-500' },
]);

/** 名簿に居ない名前が来た時。**他人の色を借りない**（借りると別人が同じ色になる）。 */
export const NEUTRAL_TONE = Object.freeze({
  key: 'neutral', dot: 'bg-slate-400', text: 'text-slate-600', border: 'border-slate-300',
  bg: 'bg-slate-50', beam: 'from-slate-200 to-slate-400',
});

/**
 * 名前 → 色 の対応表を作る。
 * 🚨 並べ替えてから配る。snapshot.workers の並びは名簿の並びで安定しているが、
 *   ここで並べ替えておけば、別の入口（右の一覧）から作っても必ず同じ対応になる。
 * @param {Array<string>} names 作業者名（snapshot.workers の name をそのまま）
 * @returns {Map<string, object>}
 */
export function buildWorkerColors(names) {
  const list = (Array.isArray(names) ? names : [])
    .map((n) => (typeof n === 'string' ? n.trim() : ''))
    .filter(Boolean);
  const uniq = [...new Set(list)].sort((a, b) => a.localeCompare(b, 'ja'));
  const m = new Map();
  uniq.forEach((n, i) => m.set(n, WORKER_TONES[i % WORKER_TONES.length]));
  return m;
}

/** 対応表から1人ぶん。無ければ灰色（落ちない・他人の色にならない）。 */
export function toneOf(colorMap, name) {
  const key = typeof name === 'string' ? name.trim() : '';
  const t = (colorMap instanceof Map && key) ? colorMap.get(key) : null;
  return t || NEUTRAL_TONE;
}

/** snapshot から名前だけ取り出す。盤と一覧で**同じ入口**を使うための道具。 */
export function workerNamesOf(snapshot) {
  const ws = Array.isArray(snapshot && snapshot.workers) ? snapshot.workers : [];
  return ws.map((w) => (w && w.name) || '');
}
