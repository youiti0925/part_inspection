// ============================================================================
// 💬 字幕(テロップ)の下ごしらえ — AIが作った下書きを、そのまま出せる形に整える
// ----------------------------------------------------------------------------
// 清水さん(2026-08-13):「自動で作られたらすごい現場楽じゃない？」
//
// ⚠⚠ ここでやるのは **下書きを整えること** だけ。
//   **AIに「どこを消すか」は決めさせない**(何を残すかがエースの技。そこを自動化したら
//   手本動画である意味が無くなる)。人が直す前提で、直しやすい形にする。
//
// ⚠現場の条件:
//   ・騒音でイヤホンを付けられない → 字幕は装飾ではなく、伝わるかどうかの生命線
//   ・タブレットの小さい画面 → **1枚に出す文字は短く**。長い文は切って続けて出す
//   ・字幕どうしが重なると、後の物が前を消す → **重なりは必ず外す**
//
// ⚠ここには React も ブラウザAPI も import しない (node --test で回すため)。
// ============================================================================

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const r1 = (v) => Math.round(num(v, 0) * 10) / 10;

/** 1枚に出す文字数の目安。⚠これを超えたら切って続けて出す。 */
export const MAX_CHARS = 30;
/** 字幕の最短/最長の長さ(秒)。⚠一瞬で消える字幕・出っぱなしの字幕を作らない。 */
export const MIN_SEC = 1.2;
export const MAX_SEC = 8;
/** 字幕どうしの間に空ける最小の間(秒)。 */
export const GAP = 0.08;

/**
 * 長い文を、読める長さに切る。
 * ⚠日本語は空白で切れないので、**句読点を優先**して切る。無ければ文字数で切る。
 */
export const splitText = (text, maxChars = MAX_CHARS) => {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!s) return [];
  const max = Math.max(6, Math.round(maxChars));
  if ([...s].length <= max) return [s];
  const out = [];
  let rest = s;
  while ([...rest].length > max) {
    const head = [...rest].slice(0, max).join('');
    // 句読点で切れる所を後ろから探す
    let cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('、'), head.lastIndexOf('，'), head.lastIndexOf('．'));
    if (cut < Math.floor(max * 0.4)) cut = -1;    // 頭すぎる所では切らない
    const n = cut >= 0 ? cut + 1 : max;
    out.push([...rest].slice(0, n).join('').trim());
    rest = [...rest].slice(n).join('').trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
};

/**
 * AIの下書きを整える。
 *  ・空の物を捨てる ・順に並べる ・重なりを外す
 *  ・短すぎる/長すぎるを直す ・長い文を切って続けて出す
 * @param segments [{start,end,text}]
 * @param totalSec 出来上がりの長さ(これを超える字幕は縮める)。0なら見ない
 */
export const tidySegments = (segments, totalSec = 0, opts = {}) => {
  const { maxChars = MAX_CHARS, minSec = MIN_SEC, maxSec = MAX_SEC, gap = GAP } = opts;
  const total = num(totalSec, 0);
  const src = (Array.isArray(segments) ? segments : [])
    .map(s => ({
      start: num(s?.start, NaN),
      end: num(s?.end, NaN),
      text: typeof s?.text === 'string' ? s.text.trim() : '',
    }))
    .filter(s => Number.isFinite(s.start) && s.start >= 0 && s.text)
    .sort((a, b) => a.start - b.start);

  // ① 長い文を切って、複数枚に分ける(時間は文字数で割る)
  const parts = [];
  for (const s of src) {
    const end = Number.isFinite(s.end) && s.end > s.start ? s.end : s.start + minSec;
    const lines = splitText(s.text, maxChars);
    if (lines.length <= 1) { parts.push({ start: s.start, end, text: lines[0] || s.text }); continue; }
    const chars = lines.reduce((a, l) => a + [...l].length, 0) || 1;
    let at = s.start;
    for (const l of lines) {
      const d = (end - s.start) * ([...l].length / chars);
      parts.push({ start: at, end: at + d, text: l });
      at += d;
    }
  }

  // ② 重なりを外し、短すぎ/長すぎを直す
  const out = [];
  for (const p of parts) {
    let start = p.start;
    const prev = out[out.length - 1];
    // ⚠前の字幕と重なるなら、後ろへずらす(前を消さない)
    if (prev && start < prev.end + gap) start = prev.end + gap;
    let end = Math.max(p.end, start + minSec);
    if (end - start > maxSec) end = start + maxSec;
    if (total > 0) {
      if (start >= total - 0.2) break;              // 出来上がりより後ろの字幕は捨てる
      if (end > total) end = total;
    }
    if (end - start < 0.3) continue;                 // 潰れた物は出さない
    out.push({ start: r1(start), end: r1(end), text: p.text });
  }
  return out;
};

/**
 * 整えた字幕を、動画に焼く「重ね」の形にする。
 * @param mkId (i) => id   id の作り方(呼び出し側の決まりに合わせる)
 */
export const segmentsToOverlays = (segments, opts = {}) => {
  const { pos = 'bottom', size = 'm', color = 'white', mkId = (i) => `sub${i + 1}` } = opts;
  return (segments || []).map((s, i) => ({
    id: mkId(i), kind: 'text', text: s.text,
    from: r1(s.start), to: r1(s.end), pos, size, color,
  }));
};

/**
 * AIが出した「区切りの案」を、章の形にする。
 * ⚠近すぎる区切りはまとめる(1秒に何個も章があっても使えない)。
 * ⚠名前が空の物は捨てる(名無しの章は現場で意味を持たない)。
 */
export const tidyChapters = (chapters, totalSec = 0, minGap = 5) => {
  const total = num(totalSec, 0);
  const out = [];
  for (const c of (Array.isArray(chapters) ? chapters : [])
    .map(c => ({ at: num(c?.at, NaN), name: typeof c?.name === 'string' ? c.name.trim() : '' }))
    .filter(c => Number.isFinite(c.at) && c.at >= 0 && c.name)
    .sort((a, b) => a.at - b.at)) {
    if (total > 0 && c.at > total - 0.5) continue;
    const prev = out[out.length - 1];
    // ⚠押し込む形は {atOut,...} なので、読む側も atOut を見る。
    //   prev.at だと undefined → NaN 比較になり **判定が丸ごと効かない**(近すぎる章が残る)。
    if (prev && c.at - prev.atSrc < minGap) continue;
    // ⚠名前は atSrc(=元の動画の秒)。画面の chapters は atOut(=出来上がりの秒)で、
    //   意味が逆。同じ名前にすると必ずどこかで取り違える。
    out.push({ atSrc: r1(c.at), name: c.name.slice(0, 30) });
  }
  return out;
};

/**
 * 音声を送る塊の分け方。
 * ⚠1回に送れる大きさに上限があるので、長い動画は数分ずつに分けて送る。
 * ⚠**切れ目で言葉が途切れる**ので、少し重ねて送る(overlapSec)。重なった分は
 *   呼び出し側で「前の塊の終わりより後ろの字幕だけ採る」で落とす。
 * @returns [{index, from, to, offsetSec}]
 */
export const audioChunks = (totalSec, chunkSec = 180, overlapSec = 3) => {
  const total = num(totalSec, 0);
  if (!(total > 0)) return [];
  const step = Math.max(10, num(chunkSec, 180));
  const ov = Math.max(0, Math.min(step / 4, num(overlapSec, 3)));
  const out = [];
  let at = 0;
  while (at < total - 0.05) {
    const from = at === 0 ? 0 : at - ov;
    const to = Math.min(total, at + step);
    out.push({ index: out.length, from: r1(from), to: r1(to), offsetSec: r1(from) });
    if (to >= total) break;
    at = to;
  }
  return out;
};

/** 塊ごとの結果をつなぐ。⚠重ねて送った分の重複を落とす。 */
export const mergeSegments = (lists, opts = {}) => {
  const { sameSec = 1.2 } = opts;
  const all = [];
  for (const list of (lists || [])) for (const s of (list || [])) all.push(s);
  all.sort((a, b) => num(a.start, 0) - num(b.start, 0));
  const out = [];
  for (const s of all) {
    const prev = out[out.length - 1];
    // ⚠同じ言葉が、ほぼ同じ時刻に2回出ていたら重複(重ねて送った所)
    if (prev && Math.abs(num(s.start, 0) - num(prev.start, 0)) < sameSec && String(s.text).trim() === String(prev.text).trim()) continue;
    out.push(s);
  }
  return out;
};
