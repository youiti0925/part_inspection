// ============================================================================
// 📐 <video> の中で「絵」が実際に描かれている範囲(レターボックス=黒帯の計算)
// ----------------------------------------------------------------------------
// ⚠⚠ 印(〇/→)は「**絵に対する割合(0-1)**」で持っている。
//   ところが object-contain で置いた <video> は、縦横比が違うぶん黒帯が入るので
//   「要素の中の%」と「絵の中の%」がズレる。
//   小窓プレイヤーは `w-full aspect-video`(16:9固定)なので、
//   4:3や縦撮りの動画では **必ず** 起きる。
//   → ここで絵の範囲を出し、その中で印を置く / 拾う。
//
// ⚠ここには React も import しない (node --test で回すため)。
//   描画は RecipeMarks.jsx。計算はここ。両方から同じ物を使う(写さない)。
// ============================================================================

/**
 * 要素の中で絵が描かれている範囲。要素に対する割合(0-1)。
 * ⚠まだ読み込めていない(大きさ0)なら「全面」として返す。0で割らない。
 */
export const videoBox = (el) => {
  if (!el) return { left: 0, top: 0, width: 1, height: 1 };
  const cw = el.clientWidth || el.offsetWidth || 0;
  const ch = el.clientHeight || el.offsetHeight || 0;
  // ⚠⚠ <video> は videoWidth、<img> は naturalWidth、<canvas> は width。
  //   ここを video だけにすると、**画像に印を描いた時だけ黒帯ぶんズレる**
  //   (2026-08-13 実測: 4:3の画像を16:9の枠に置くと座標が合わなかった)。
  const vw = el.videoWidth || el.naturalWidth || (typeof el.width === 'number' ? el.width : 0) || 0;
  const vh = el.videoHeight || el.naturalHeight || (typeof el.height === 'number' ? el.height : 0) || 0;
  if (!cw || !ch || !vw || !vh) return { left: 0, top: 0, width: 1, height: 1 };
  const scale = Math.min(cw / vw, ch / vh);
  const dw = vw * scale, dh = vh * scale;
  return { left: ((cw - dw) / 2) / cw, top: ((ch - dh) / 2) / ch, width: dw / cw, height: dh / ch };
};

/**
 * 画面の位置(clientX/Y) → 絵の中の割合(0-1)。なぞって描く時に使う。
 * ⚠黒帯の上をなぞっても 0〜1 に収める(枠の外に印を作らない)。
 */
export const toPicture = (el, clientX, clientY) => {
  const r = el.getBoundingClientRect();
  const bx = videoBox(el);
  const ex = (clientX - r.left) / (r.width || 1);
  const ey = (clientY - r.top) / (r.height || 1);
  const x = bx.width > 0 ? (ex - bx.left) / bx.width : ex;
  const y = bx.height > 0 ? (ey - bx.top) / bx.height : ey;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
};

/** 画像でも同じ。⚠videoBox が naturalWidth も見るようにしたので、分けない(分けると片方だけ直る)。 */
export const imageBox = videoBox;
