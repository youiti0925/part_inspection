// ============================================================================
// 🖍 重ね(overlay)を絵に焼き込む — 〇/矢印・テロップ・モザイク・スポットライト
// ----------------------------------------------------------------------------
// 清水さん(2026-08-13):「市場と比較して遜色ないぐらいのものにして」
//
// ⚠なぜ「焼き込み」なのか:
//   アプリの中でだけ見える印は、Driveで開いた人・他部署に渡した人には **消える**。
//   手本動画は配られる物なので、動画そのものに入っていないと意味が無い。
//
// ⚠現場の条件(ここを外すと使えない):
//   ・**騒音でイヤホン無し**。音声の説明だけでは伝わらない → テロップが本命。
//   ・タブレットの小さい画面で見る → 文字は絵の高さに比例させる。固定pxにしない。
//   ・**人の顔・他社名・PCの個人情報** が映り込む → モザイクが無いと外に出せない。
//
// ⚠ここには React も ブラウザAPI も import しない。ctx は呼び出し側の物を使う
//   (node --test では「呼ばれた命令を記録するニセのctx」で確かめる)。
// ============================================================================

import { drawMarksOnCanvas } from './videoMarks.js';

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp01 = (v) => Math.min(1, Math.max(0, num(v, 0)));

/** テロップの置き場所。 */
export const TEXT_POS = ['bottom', 'top', 'center'];
/** テロップの大きさの段(絵の高さに対する割合)。 */
export const TEXT_SIZES = { s: 0.045, m: 0.06, l: 0.085 };
/** 文字色の選べる色。⚠現場の動画は暗い/明るいが混ざる。白と黄だけでは足りない。 */
export const TEXT_COLORS = {
  white: { fg: '#ffffff', bg: 'rgba(0,0,0,.66)', label: '白' },
  yellow: { fg: '#ffe14d', bg: 'rgba(0,0,0,.72)', label: '黄' },
  red: { fg: '#ffffff', bg: 'rgba(200,20,20,.85)', label: '赤（注意）' },
  green: { fg: '#ffffff', bg: 'rgba(10,130,70,.85)', label: '緑（OK）' },
};

/**
 * 日本語の折り返し。⚠英語のように空白で割れない。1文字ずつ測って詰める。
 * @param measure (文字列) => 幅(px)
 */
export const wrapText = (text, maxWidth, measure) => {
  const s = String(text == null ? '' : text);
  if (!s) return [];
  const lines = [];
  for (const raw of s.split('\n')) {
    if (!raw) { lines.push(''); continue; }
    let cur = '';
    for (const ch of [...raw]) {
      const next = cur + ch;
      if (cur && measure(next) > maxWidth) { lines.push(cur); cur = ch; }
      else cur = next;
    }
    if (cur) lines.push(cur);
  }
  return lines;
};

/** モザイクの目の大きさ(絵の短い辺に対する割合)。 */
export const MOSAIC_CELLS = { s: 0.012, m: 0.022, l: 0.04 };

/**
 * 四角(0-1の割合)を px にする。⚠負の幅・絵の外へ出た枠をそのまま返さない。
 */
export const rectPx = (rect, w, h) => {
  const x0 = clamp01(rect?.x), y0 = clamp01(rect?.y);
  const w0 = clamp01(rect?.w), h0 = clamp01(rect?.h);
  const x = Math.round(x0 * w), y = Math.round(y0 * h);
  const ww = Math.max(2, Math.round(Math.min(1 - x0, w0) * w));
  const hh = Math.max(2, Math.round(Math.min(1 - y0, h0) * h));
  return { x, y, w: ww, h: hh };
};

/**
 * 🎨 その時刻の重ねを全部描く。
 * @param ctx      2Dコンテキスト(出来上がりの絵が既に描かれている状態)
 * @param w,h      絵の大きさ(px)
 * @param overlays その時刻に出ている重ね
 * @param opts.scratch () => canvas   モザイクに使う下書き用。無ければモザイクは飛ばす
 *
 * ⚠描く順は決め打ち: モザイク → スポットライト → 〇/矢印 → テロップ。
 *   (モザイクの上に印を描く。逆にすると隠したい所に付けた印まで潰れる)
 */
export const drawOverlays = (ctx, w, h, overlays, opts = {}) => {
  const list = (overlays || []).filter(Boolean);
  const order = { mosaic: 0, spot: 1, mark: 2, text: 3 };
  const sorted = [...list].sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
  for (const o of sorted) {
    if (o.kind === 'mosaic') drawMosaic(ctx, w, h, o, opts);
    else if (o.kind === 'spot') drawSpot(ctx, w, h, o);
    else if (o.kind === 'mark') drawMarksOnCanvas(ctx, w, h, [o.mark]);
    else if (o.kind === 'text') drawTelop(ctx, w, h, o);
  }
};

/**
 * 🎯 「絵が乗っている所」に合わせて重ねを描く。
 * ----------------------------------------------------------------------------
 * ⚠⚠ 印の座標には **2つの意味** がある。
 *   ・枠全体の割合   … 編集室(タイムライン)の印。canvas の上で付けるのでこちら。
 *   ・絵の中の割合   … 写真の上で付けた印(「🖼 画像を挟む」の画面)。黒帯は含まない。
 *   後者を枠全体として描くと、4:3の写真を16:9の動画に挟んだ時に
 *   **印が黒帯の上へ 12%ぶんズレる**(2026-08-15 実測: 絵の右端の印が絵の外に出た)。
 * @param box paintFrame の戻り値 {dx,dy,dw,dh}
 */
export const drawOverlaysInBox = (ctx, w, h, overlays, box, opts = {}) => {
  const b = box || {};
  const dw = num(b.dw, 0), dh = num(b.dh, 0);
  // 黒帯が無い(絵が枠いっぱい)なら、そのまま描くのと同じ。写す必要は無い。
  if (!(dw > 0 && dh > 0) || (dw === w && dh === h)) return drawOverlays(ctx, w, h, overlays, opts);
  ctx.save();
  ctx.translate(num(b.dx, 0), num(b.dy, 0));
  ctx.scale(dw / w, dh / h);
  drawOverlays(ctx, w, h, overlays, opts);
  ctx.restore();
  return undefined;
};

/** ▩ モザイク(目隠し)。⚠scratch が無い環境では何もしない(絵を壊すより出さない)。 */
export const drawMosaic = (ctx, w, h, o, opts = {}) => {
  const mk = opts.scratch;
  if (typeof mk !== 'function') return false;
  const r = rectPx(o.rect, w, h);
  const cell = Math.max(0.004, num(MOSAIC_CELLS[o.cell] ?? o.cell, MOSAIC_CELLS.m));
  const px = Math.max(2, Math.round(Math.min(w, h) * cell));
  const sw = Math.max(1, Math.round(r.w / px));
  const sh = Math.max(1, Math.round(r.h / px));
  const c = mk(sw, sh);
  if (!c) return false;
  const cc = c.getContext('2d');
  if (!cc) return false;
  // ① 隠したい所を小さく縮めて写す ② それを引き伸ばして戻す(なめらかにしない)
  cc.imageSmoothingEnabled = true;
  cc.drawImage(ctx.canvas, r.x, r.y, r.w, r.h, 0, 0, sw, sh);
  const before = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(c, 0, 0, sw, sh, r.x, r.y, r.w, r.h);
  ctx.imageSmoothingEnabled = before;
  return true;
};

/** 🔦 スポットライト: そこ以外を暗くする。「ここを見て」が一番強く伝わる。 */
export const drawSpot = (ctx, w, h, o) => {
  const r = rectPx(o.rect, w, h);
  const dim = Math.min(0.92, Math.max(0.15, num(o.dim, 0.62)));
  ctx.save();
  ctx.fillStyle = `rgba(0,0,0,${dim})`;
  // ⚠1枚の暗幕をかけて穴を開ける、ではなく **周り4枚** を塗る。
  //   globalCompositeOperation を使うと、この後に描く物まで抜ける端末がある。
  ctx.fillRect(0, 0, w, r.y);                                   // 上
  ctx.fillRect(0, r.y + r.h, w, Math.max(0, h - r.y - r.h));    // 下
  ctx.fillRect(0, r.y, r.x, r.h);                               // 左
  ctx.fillRect(r.x + r.w, r.y, Math.max(0, w - r.x - r.w), r.h);// 右
  ctx.strokeStyle = '#ffd166';
  ctx.lineWidth = Math.max(2, Math.round(Math.min(w, h) * 0.006));
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.restore();
};

/** 💬 テロップ(字幕)。⚠騒音の現場では、これが一番読まれる。 */
export const drawTelop = (ctx, w, h, o) => {
  const text = String(o.text == null ? '' : o.text);
  if (!text.trim()) return false;
  const col = TEXT_COLORS[o.color] || TEXT_COLORS.white;
  const fs = Math.max(12, Math.round(h * (TEXT_SIZES[o.size] || num(o.size, TEXT_SIZES.m))));
  ctx.save();
  ctx.font = `bold ${fs}px sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const pad = Math.round(fs * 0.42);
  const maxW = w - pad * 4;
  const lines = wrapText(text, maxW, (s) => ctx.measureText(s).width).slice(0, 4);
  const lh = Math.round(fs * 1.32);
  const boxH = lines.length * lh + pad * 2 - Math.round(fs * 0.3);
  const pos = TEXT_POS.includes(o.pos) ? o.pos : 'bottom';
  const boxY = pos === 'top' ? Math.round(h * 0.04)
    : pos === 'center' ? Math.round((h - boxH) / 2)
      : h - boxH - Math.round(h * 0.04);
  let widest = 0;
  for (const l of lines) widest = Math.max(widest, ctx.measureText(l).width);
  const boxW = Math.min(w - pad * 2, Math.round(widest + pad * 2));
  const boxX = Math.round((w - boxW) / 2);
  ctx.fillStyle = col.bg;
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.fillStyle = col.fg;
  lines.forEach((l, i) => {
    const lw = ctx.measureText(l).width;
    ctx.fillText(l, Math.round(boxX + (boxW - lw) / 2), boxY + pad + lh * i + Math.round(fs * 0.85));
  });
  ctx.restore();
  return true;
};

/**
 * 元の絵を、回転・切り抜き・ズームを効かせて枠に描く。
 * @returns {dx,dy,dw,dh} 実際に絵が乗った場所(印の座標をここに合わせる)
 *
 * ⚠印(〇)の座標は「見えている絵に対する割合」。切り抜き/ズームをすると
 *   見えている範囲が変わるので、**印もその範囲に合わせて描く**(枠全面ではない)。
 */
export const paintFrame = (ctx, w, h, src, srcW, srcH, opts = {}) => {
  const rot = ((num(opts.rotate, 0) % 360) + 360) % 360;
  const crop = opts.crop || null;
  const zoom = opts.zoom || { scale: 1, cx: 0.5, cy: 0.5 };
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);

  // 回転後の元の大きさ
  // ⚠⚠ `num(x, 既定)` は **0 を通してしまう**(0は「数として正しい」ので既定に落ちない)。
  //   まだ大きさが分かっていない瞬間の 0 をそのまま使うと、比が 0 になって
  //   出来上がりの高さが **無限大** になる。0 は「未定」として扱う。
  const sW = num(srcW, 0) > 0 ? num(srcW, 0) : w;
  const sH = num(srcH, 0) > 0 ? num(srcH, 0) : h;
  const rw = (rot === 90 || rot === 270) ? sH : sW;
  const rh = (rot === 90 || rot === 270) ? sW : sH;

  // 切り抜き(回転後の絵に対する割合) → 元の絵の中の範囲へ
  const cx0 = crop ? clamp01(crop.x) : 0, cy0 = crop ? clamp01(crop.y) : 0;
  const cw0 = crop ? clamp01(crop.w) : 1, ch0 = crop ? clamp01(crop.h) : 1;

  // ズーム(切り抜き後の絵をさらに寄る)
  const z = Math.max(1, num(zoom.scale, 1));
  const zw = cw0 / z, zh = ch0 / z;
  const zx = cx0 + (cw0 - zw) * clamp01(zoom.cx);
  const zy = cy0 + (ch0 - zh) * clamp01(zoom.cy);

  // 見えている範囲(回転後の割合) → 枠に収める
  const visW = rw * zw, visH = rh * zh;
  const ratio = visW / Math.max(1, visH);
  let dw = w, dh = Math.round(w / ratio), dx = 0, dy = 0;
  if (dh > h) { dh = h; dw = Math.round(h * ratio); }
  dx = Math.round((w - dw) / 2); dy = Math.round((h - dh) / 2);

  ctx.save();
  // 🔆 明るさ・くっきり・鮮やかさ。⚠工場は逆光と暗所が多く、撮ったままだと何も見えない。
  //   ⚠filter は save/restore の中だけで効かせる(次に描く物まで色が変わる)。
  const adj = opts.adjust || null;
  if (adj) {
    const b = Math.min(3, Math.max(0.2, num(adj.brightness, 1)));
    const c = Math.min(3, Math.max(0.2, num(adj.contrast, 1)));
    const st = Math.min(3, Math.max(0, num(adj.saturate, 1)));
    if (b !== 1 || c !== 1 || st !== 1) ctx.filter = `brightness(${b}) contrast(${c}) saturate(${st})`;
  }
  // 枠の中の「絵の場所」へ移し、そこで回転して描く
  ctx.translate(dx + dw / 2, dy + dh / 2);
  if (rot) ctx.rotate((rot * Math.PI) / 180);
  const drawW = (rot === 90 || rot === 270) ? dh : dw;
  const drawH = (rot === 90 || rot === 270) ? dw : dh;
  // 元の絵の中で切り出す範囲(回転前の座標に戻す)
  // ⚠⚠ 縦横を入れ替えるだけでは足りない。**裏返しの分**を引かないと、
  //   回して切り抜いた時に **元の絵の反対側** を切ってしまう(2026-08-15 実測で判明)。
  //   人は「回した後の絵」を見てなぞるので、なぞった所と切られる所が食い違う。
  //   しかも 90°と270°が同じ場所を、180°は「回さない」と同じ場所を切っていた。
  //
  //   出来上がりの座標(u,v) と 元の座標(x,y) の関係(90°=時計回り):
  //     u = 1-y, v = x   →  逆に  x = v, y = 1-u
  //   これを なぞった範囲 u∈[zx,zx+zw], v∈[zy,zy+zh] に当てはめると下の式になる。
  //   ⚠rot=0 では式が一切変わらないので、**回転を使っていない今までの動画は無傷**。
  const rotQ = (rot === 90 || rot === 270);
  const sx = rot === 90 ? zy : rot === 180 ? (1 - zx - zw) : rot === 270 ? (1 - zy - zh) : zx;
  const sy = rot === 90 ? (1 - zx - zw) : rot === 180 ? (1 - zy - zh) : rot === 270 ? zx : zy;
  const sw = rotQ ? zh : zw;
  const sh = rotQ ? zw : zh;
  try {
    ctx.drawImage(src,
      Math.round(sx * sW), Math.round(sy * sH),
      Math.max(1, Math.round(sw * sW)), Math.max(1, Math.round(sh * sH)),
      -drawW / 2, -drawH / 2, drawW, drawH);
  } catch {
    // ⚠まだ絵が来ていない瞬間に来ることがある。黒のままにして落とさない。
  }
  ctx.restore();
  return { dx, dy, dw, dh };
};
