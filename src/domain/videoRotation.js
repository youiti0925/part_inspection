// ============================================================================
// 🔄 元動画の「向き」を立て直す
//
// ⚠⚠ これが無いと、スマホを縦に持って撮った動画が **書き出した瞬間に横へ倒れ、
//   上下に巨大な黒帯が付いて絵が小さくなる**(2026-08-15 清水さん報告)。
//
// なぜ起きるか:
//   スマホのMP4は「コマは横(1920x1080)のまま入れておいて、再生する側で90度
//   回してね」という**回転の指示**(tkhd の matrix)を箱に書いている。
//   ・<video> 要素   … ブラウザが指示を読んで回す → videoWidth=1080, Height=1920(縦)
//   ・WebCodecs の VideoDecoder … **指示を読まない** → コマは 1920x1080(横)のまま
//   アプリは大きさを <video> から取り(縦)、絵を VideoDecoder から取っていた(横)。
//   縦の枠に横の絵を収めるので、倒れた上に上下が真っ黒になる。
//
// 直し方の方針:
//   **絵を受け取った直後に立て直して、<video> で見えるのと同じ向き・同じ寸法にする。**
//   ここで揃えておけば、切り抜き(crop)・寄り(zoom)・印(marks)は全部
//   「編集画面で見えていた向き」の割合のまま通じる。
//   ⚠paintFrame の rotate に足し込む方法は採らない。crop/zoom は回転**後**の
//     割合なので、足し込むと切り抜きと印が全部ズレる。
// ============================================================================

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** 0/90/180/270 に丸めて 0〜359 に収める。 */
export const normDeg = (deg) => {
  const d = Math.round(num(deg, 0) / 90) * 90;
  return ((d % 360) + 360) % 360;
};

/**
 * MP4 の変換行列から回転角(度・時計回り)を出す。
 *
 * 行列は9個 [a, b, u, c, d, v, x, y, w]。回転だけを見るなら a(=cosθ) と b(=sinθ)。
 * 値は 16.16 の固定小数(1.0 = 65536)だが、atan2 は倍率に左右されないのでそのまま使える。
 *   0度 …… [ 1, 0, …]   90度 …… [0,  1, …]
 * 180度 …… [-1, 0, …]  270度 …… [0, -1, …]
 *
 * ⚠行列が無い・つぶれている(a も b も 0)動画は 0 を返す。勝手に回さない。
 */
export const degFromMatrix = (matrix) => {
  if (!matrix) return 0;
  const a = num(matrix[0], 0), b = num(matrix[1], 0);
  if (a === 0 && b === 0) return 0;
  return normDeg((Math.atan2(b, a) * 180) / Math.PI);
};

/**
 * 「いま受け取った絵を、何度回せば <video> と同じ向きになるか」。
 *
 * ⚠⚠ 行列を鵜呑みにして回さない。**寸法で答え合わせをしてから**回す。
 *   将来ブラウザ側が回転を適用するようになった時に、こちらでも回すと
 *   **二重に回って倒れる**。しかも「直したはずなのに倒れている」ので原因が読めない。
 *   90/270 は縦横が入れ替わるので、入れ替わっていなければ「もう立っている」と分かる。
 *
 * @param deg    行列から読んだ角度
 * @param frameW/frameH 受け取った絵の実寸(VideoDecoder のコマ)
 * @param dispW/dispH   <video> が言う寸法(= 見えるべき向き)。分からない時は 0
 * @returns 0 | 90 | 180 | 270
 */
export const sourceRotateNeeded = (deg, frameW, frameH, dispW, dispH) => {
  const d = normDeg(deg);
  if (!d) return 0;
  const fw = num(frameW, 0), fh = num(frameH, 0);
  const dw = num(dispW, 0), dh = num(dispH, 0);
  if (d === 180) return 180;                      // 縦横が変わらないので寸法では見分けられない
  if (!(fw > 0 && fh > 0 && dw > 0 && dh > 0)) return d;   // 答え合わせができない → 行列を信じる
  if (fw === fh) return d;                        // 正方形も見分けられない → 行列を信じる
  if (fw === dw && fh === dh) return 0;           // もう立っている(誰かが回した後) → 回さない
  return d;
};

/** 立て直した後の大きさ。 */
export const rotatedSize = (w, h, deg) => {
  const d = normDeg(deg);
  const ww = Math.max(1, Math.round(num(w, 1))), hh = Math.max(1, Math.round(num(h, 1)));
  return (d === 90 || d === 270) ? { width: hh, height: ww } : { width: ww, height: hh };
};

/**
 * 立て直して描くための、置き場所と回し方。(純関数・試験用)
 * 出来上がりの左上が (0,0) に来るように、先に translate してから rotate する。
 */
export const uprightTransform = (srcW, srcH, deg) => {
  const d = normDeg(deg);
  const sw = Math.max(1, Math.round(num(srcW, 1))), sh = Math.max(1, Math.round(num(srcH, 1)));
  const { width, height } = rotatedSize(sw, sh, d);
  if (d === 90) return { width, height, tx: sh, ty: 0, rad: Math.PI / 2 };
  if (d === 180) return { width, height, tx: sw, ty: sh, rad: Math.PI };
  if (d === 270) return { width, height, tx: 0, ty: sw, rad: -Math.PI / 2 };
  return { width, height, tx: 0, ty: 0, rad: 0 };
};

/**
 * 絵を「立てた状態」で canvas に描く。
 * ⚠キャンバスは rotatedSize の大きさで用意しておくこと。
 */
export const drawUpright = (ctx, src, srcW, srcH, deg) => {
  const t = uprightTransform(srcW, srcH, deg);
  if (!t.rad) { ctx.drawImage(src, 0, 0, t.width, t.height); return t; }
  ctx.save();
  ctx.translate(t.tx, t.ty);
  ctx.rotate(t.rad);
  ctx.drawImage(src, 0, 0, Math.max(1, Math.round(num(srcW, 1))), Math.max(1, Math.round(num(srcH, 1))));
  ctx.restore();
  return t;
};
