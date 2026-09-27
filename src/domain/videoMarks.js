// ============================================================================
// ⭕ 動画・画像に重ねる「印」の形の計算 — 〇/□/矢印/なぞり書き/番号、色と太さ
// ----------------------------------------------------------------------------
// 清水さん(2026-08-13):
//   「〇が小さすぎて使えない。その場所によって〇の大きさや形（楕円）変わるから
//     そこも追加してほしい」
//   「市場比較は一番重要。編集する上で必要な機能は全部入れて」
//
// いままで: 印は `{x, y, shape, text}` だけ。タップした点に **固定サイズ(3.5rem)** の丸。
//   しかも **色は赤の1色・太さも固定**。市場の道具(Camtasia / Snagit / ScreenPal)は
//   例外なく「形・色・太さ」を選べる。暗い機械の上では赤い線が沈んで見えない。
//
// これから: **なぞって描く**。形は5つ。色5色・太さ3段。
//   楕円     = { shape:'ellipse', x, y, rx, ry }        中心と半径(全部 0-1 の割合)
//   四角     = { shape:'rect',    x, y, rx, ry }        中心と半幅・半高
//   矢印     = { shape:'arrow2',  x, y, x2, y2 }        しっぽ → 先端
//   なぞり書き= { shape:'free',    pts:[{x,y}...] }       指でなぞった線そのまま
//   番号     = { shape:'num',     x, y, num }           ①②③ 手順の順番(Snagitの Step Tool)
//   共通     = { color:'red'|…, width:'s'|'m'|'l', text }
//
//   古い印(rx が無い丸 / 'arrow' / 色なし)もそのまま読める(壊さない)。
//
// ⚠座標は全部「動画の枠に対する割合(0-1)」。px で持つと画面の大きさで意味が変わる。
// ⚠ここには React も canvas も import しない (node --test で回すため)。
//   描くのは呼び出し側。ここは「どこに何を描くか」の数字だけを返す。
// ============================================================================

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));
const round3 = (v) => Math.round(v * 1000) / 1000;
const pct = (v) => Math.round(v * 100000) / 1000;   // 0-1 → % (小数3桁)

/** 古い印の見なしサイズ。旧描画は 3.5rem 固定だった → 画面幅の約8%相当を既定にする。 */
export const LEGACY_R = 0.045;
/** これより小さい印は「なぞったつもりが点になった」= タップとみなして既定サイズにする。 */
export const MIN_DRAG = 0.02;
/** 番号の印の大きさ(絵の短い辺に対する割合)。 */
export const NUM_R = 0.038;

/** 選べる形。⚠画面の選択肢と必ずそろえる。 */
export const SHAPES = ['ellipse', 'rect', 'arrow2', 'free', 'num'];

/**
 * 選べる色。⚠赤だけでは足りない:
 *   赤い機械・赤いケーブルの上では赤い印が沈む。暗い所では黄色が一番読める。
 */
export const MARK_COLORS = {
  red: { hex: '#ff2d2d', label: '赤' },
  yellow: { hex: '#ffd400', label: '黄' },
  green: { hex: '#12b76a', label: '緑' },
  blue: { hex: '#2e90fa', label: '青' },
  white: { hex: '#ffffff', label: '白' },
};
/** 線の太さ(絵の短い辺に対する割合)。 */
export const MARK_WIDTHS = { s: 0.005, m: 0.009, l: 0.016 };

export const colorOf = (m) => (MARK_COLORS[m?.color] || MARK_COLORS.red).hex;
export const widthOf = (m, w, h) => Math.max(2, Math.round(Math.min(w, h) * (MARK_WIDTHS[m?.width] || MARK_WIDTHS.m)));

/**
 * どんな形の印でも、描ける形に整える(古いデータもここを通せば新しい描き方で描ける)。
 */
export const normalizeMark = (m) => {
  if (!m) return null;
  const text = typeof m.text === 'string' ? m.text : '';
  const color = MARK_COLORS[m.color] ? m.color : 'red';
  const width = MARK_WIDTHS[m.width] ? m.width : 'm';
  const base = { text, color, width };
  // 新しい矢印(始点→終点)
  if (m.shape === 'arrow2') {
    return { ...base, shape: 'arrow2', x: clamp01(m.x), y: clamp01(m.y), x2: clamp01(m.x2), y2: clamp01(m.y2) };
  }
  // 古い矢印(点に⬇) → 真上からその点へ降りる矢印として読み替える
  if (m.shape === 'arrow') {
    const x = clamp01(m.x), y = clamp01(m.y);
    return { ...base, shape: 'arrow2', x, y: clamp01(y - 0.12), x2: x, y2: y };
  }
  if (m.shape === 'free') {
    const pts = (Array.isArray(m.pts) ? m.pts : [])
      .filter(p => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
      .map(p => ({ x: clamp01(p.x), y: clamp01(p.y) }));
    // ⚠点が1つ以下のなぞり書きは線にならない。捨てずに小さい丸として扱う。
    if (pts.length < 2) {
      const p0 = pts[0] || { x: 0.5, y: 0.5 };
      return { ...base, shape: 'ellipse', x: p0.x, y: p0.y, rx: LEGACY_R, ry: LEGACY_R };
    }
    return { ...base, shape: 'free', pts };
  }
  if (m.shape === 'num') {
    const n = Math.max(1, Math.min(99, Math.round(Number(m.num) || 1)));
    return { ...base, shape: 'num', x: clamp01(m.x), y: clamp01(m.y), num: n, rx: NUM_R, ry: NUM_R };
  }
  if (m.shape === 'rect') {
    return {
      ...base, shape: 'rect', x: clamp01(m.x), y: clamp01(m.y),
      rx: m.rx != null ? Math.max(0.008, clamp01(m.rx)) : LEGACY_R,
      ry: m.ry != null ? Math.max(0.008, clamp01(m.ry)) : LEGACY_R,
    };
  }
  // 楕円(新)/丸(旧)。旧データは rx が無い → 見なしサイズ。
  return {
    ...base, shape: 'ellipse',
    x: clamp01(m.x), y: clamp01(m.y),
    rx: m.rx != null ? Math.max(0.008, clamp01(m.rx)) : LEGACY_R,
    ry: m.ry != null ? Math.max(0.008, clamp01(m.ry)) : LEGACY_R,
  };
};

/**
 * なぞった始点→終点から印を作る。
 * ⚠楕円/四角は「なぞった枠」= 端から端まで囲んだつもりの通りになる。
 * ⚠ほんの少ししか動かなかったら(タップ)、既定サイズにする(今までの操作感を残す)。
 */
export const markFromDrag = (x0, y0, x1, y1, shape = 'ellipse', opts = {}) => {
  const ax = clamp01(x0), ay = clamp01(y0), bx = clamp01(x1), by = clamp01(y1);
  const w = Math.abs(bx - ax), h = Math.abs(by - ay);
  const style = { color: MARK_COLORS[opts.color] ? opts.color : 'red', width: MARK_WIDTHS[opts.width] ? opts.width : 'm', text: '' };
  if (shape === 'num') {
    return { ...style, shape: 'num', x: round3(bx), y: round3(by), num: Math.max(1, Math.min(99, Math.round(Number(opts.num) || 1))) };
  }
  if (shape === 'arrow2' || shape === 'arrow') {
    if (w < MIN_DRAG && h < MIN_DRAG) {
      // タップ: 真上から降りる矢印
      return { ...style, shape: 'arrow2', x: round3(bx), y: round3(clamp01(by - 0.12)), x2: round3(bx), y2: round3(by) };
    }
    return { ...style, shape: 'arrow2', x: round3(ax), y: round3(ay), x2: round3(bx), y2: round3(by) };
  }
  const kind = shape === 'rect' ? 'rect' : 'ellipse';
  if (w < MIN_DRAG && h < MIN_DRAG) {
    return { ...style, shape: kind, x: round3(bx), y: round3(by), rx: LEGACY_R, ry: LEGACY_R };
  }
  return {
    ...style, shape: kind,
    x: round3((ax + bx) / 2), y: round3((ay + by) / 2),
    rx: round3(Math.max(0.008, w / 2)), ry: round3(Math.max(0.008, h / 2)),
  };
};

/**
 * なぞった線そのままの印を作る。
 * ⚠点を全部持つと保存が膨れる(1MB上限にぶつかる)。**間引いて最大60点**にする。
 */
export const markFromPath = (points, opts = {}) => {
  const pts = (points || [])
    .filter(p => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
    .map(p => ({ x: clamp01(p.x), y: clamp01(p.y) }));
  if (pts.length < 2) return null;
  const MAX = 60;
  let out = pts;
  if (pts.length > MAX) {
    out = [];
    const step = (pts.length - 1) / (MAX - 1);
    for (let i = 0; i < MAX; i++) out.push(pts[Math.round(i * step)]);
  }
  return {
    shape: 'free',
    pts: out.map(p => ({ x: round3(p.x), y: round3(p.y) })),
    color: MARK_COLORS[opts.color] ? opts.color : 'red',
    width: MARK_WIDTHS[opts.width] ? opts.width : 'm',
    text: '',
  };
};

/** 印を動かす(移動量も 0-1 の割合)。 */
export const moveMark = (m, dx, dy) => {
  const n = normalizeMark(m);
  if (!n) return m;
  if (n.shape === 'arrow2') {
    return { ...n, x: round3(clamp01(n.x + dx)), y: round3(clamp01(n.y + dy)), x2: round3(clamp01(n.x2 + dx)), y2: round3(clamp01(n.y2 + dy)) };
  }
  if (n.shape === 'free') {
    return { ...n, pts: n.pts.map(p => ({ x: round3(clamp01(p.x + dx)), y: round3(clamp01(p.y + dy)) })) };
  }
  return { ...n, x: round3(clamp01(n.x + dx)), y: round3(clamp01(n.y + dy)) };
};

/** その点はどの印の上か(上に描かれている物=あとの物 を優先)。無ければ -1。 */
export const hitMark = (marks, x, y) => {
  const list = (marks || []).map(normalizeMark);
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m) continue;
    if (m.shape === 'arrow2') {
      if (distToSegment(x, y, m.x, m.y, m.x2, m.y2) < 0.025) return i;
    } else if (m.shape === 'free') {
      for (let j = 0; j < m.pts.length - 1; j++) {
        if (distToSegment(x, y, m.pts[j].x, m.pts[j].y, m.pts[j + 1].x, m.pts[j + 1].y) < 0.025) return i;
      }
    } else if (m.shape === 'rect') {
      const pad = 0.012;
      if (x >= m.x - m.rx - pad && x <= m.x + m.rx + pad && y >= m.y - m.ry - pad && y <= m.y + m.ry + pad) return i;
    } else {
      const nx = (x - m.x) / (m.rx || LEGACY_R), ny = (y - m.y) / (m.ry || LEGACY_R);
      if (nx * nx + ny * ny <= 1.25) return i;   // 少し外側でもつかめる(1.25 = ふち込み)
    }
  }
  return -1;
};

const distToSegment = (px, py, x1, y1, x2, y2) => {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
};

/** なぞり書きの外枠(0-1)。⚠1本の直線(幅0)でも潰れない。 */
export const pathBounds = (pts) => {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of (pts || [])) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  if (!(x1 >= x0)) return { left: 0, top: 0, width: 1, height: 1 };
  return { left: x0, top: y0, width: Math.max(0.01, x1 - x0), height: Math.max(0.01, y1 - y0) };
};

/**
 * 画面(HTML)に重ねるときの位置。left/top/width/height は%の数値。
 */
export const markBox = (m) => {
  const n = normalizeMark(m);
  if (!n) return null;
  // ⚠⚠ ここで `width` という名前を使ってはいけない。
  //   下で枠の幅を `width: pct(...)` で入れるので **線の太さが上書きされて消える**。
  //   実測 2026-08-13: 太さを選んでも編集画面の線が変わらない(書き出しだけ変わる)
  //   = 画面と出来上がりが違う、という一番まずい形になっていた。
  const style = { color: colorOf(n), strokeW: n.width, text: n.text };
  if (n.shape === 'arrow2') {
    const left = Math.min(n.x, n.x2), top = Math.min(n.y, n.y2);
    const w = Math.max(0.02, Math.abs(n.x2 - n.x)), h = Math.max(0.02, Math.abs(n.y2 - n.y));
    return {
      ...style, shape: 'arrow2', left: pct(left), top: pct(top), width: pct(w), height: pct(h),
      lx1: Math.round(((n.x - left) / w) * 100), ly1: Math.round(((n.y - top) / h) * 100),
      lx2: Math.round(((n.x2 - left) / w) * 100), ly2: Math.round(((n.y2 - top) / h) * 100),
      labelX: pct(n.x2), labelY: pct(n.y2),
    };
  }
  if (n.shape === 'free') {
    const b = pathBounds(n.pts);
    return {
      ...style, shape: 'free',
      left: pct(b.left), top: pct(b.top), width: pct(b.width), height: pct(b.height),
      // 枠の中での線(0-100 の viewBox 座標)
      poly: n.pts.map(p => `${Math.round(((p.x - b.left) / b.width) * 100)},${Math.round(((p.y - b.top) / b.height) * 100)}`).join(' '),
      labelX: pct(b.left + b.width / 2), labelY: pct(b.top + b.height),
    };
  }
  if (n.shape === 'num') {
    return {
      ...style, shape: 'num', num: n.num,
      left: pct(n.x - NUM_R), top: pct(n.y - NUM_R), width: pct(NUM_R * 2), height: pct(NUM_R * 2),
      labelX: pct(n.x), labelY: pct(n.y + NUM_R),
    };
  }
  return {
    ...style, shape: n.shape === 'rect' ? 'rect' : 'ellipse',
    left: pct(n.x - n.rx), top: pct(n.y - n.ry),
    width: pct(n.rx * 2), height: pct(n.ry * 2),
    labelX: pct(n.x), labelY: pct(n.y + n.ry),
  };
};

/**
 * 🎨 canvas に焼き込む(書き出し用)。ctx は呼び出し側の物を使う。
 * ⚠線の太さ・文字の大きさは **画面の大きさに比例** させる(小さい動画で線だけ太いと不格好)。
 * ⚠色は選べるが、**白い線には必ず暗いふちを付ける**(白い壁の上で消えるため)。
 */
export const drawMarksOnCanvas = (ctx, w, h, marks) => {
  const list = (marks || []).map(normalizeMark).filter(Boolean);
  const font = Math.max(11, Math.round(h * 0.045));
  for (const m of list) {
    const col = colorOf(m);
    const lw = widthOf(m, w, h);
    // ⚠どんな色でも見えるように、下に暗いふちを1枚敷く
    const outline = (fn) => {
      ctx.save();
      ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.lineWidth = lw + Math.max(2, Math.round(lw * 0.8));
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      fn();
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = col; ctx.fillStyle = col;
      ctx.lineWidth = lw;
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      fn();
      ctx.restore();
    };
    if (m.shape === 'arrow2') {
      const x1 = m.x * w, y1 = m.y * h, x2 = m.x2 * w, y2 = m.y2 * h;
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const hd = Math.max(8, lw * 4);
      outline(() => {
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - hd * Math.cos(ang - 0.45), y2 - hd * Math.sin(ang - 0.45));
        ctx.lineTo(x2 - hd * Math.cos(ang + 0.45), y2 - hd * Math.sin(ang + 0.45));
        ctx.closePath(); ctx.fill(); ctx.stroke();
      });
    } else if (m.shape === 'free') {
      outline(() => {
        ctx.beginPath();
        m.pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x * w, p.y * h) : ctx.lineTo(p.x * w, p.y * h)));
        ctx.stroke();
      });
    } else if (m.shape === 'rect') {
      outline(() => { ctx.beginPath(); ctx.rect((m.x - m.rx) * w, (m.y - m.ry) * h, m.rx * 2 * w, m.ry * 2 * h); ctx.stroke(); });
    } else if (m.shape === 'num') {
      const r = Math.max(10, NUM_R * Math.min(w, h));
      ctx.save();
      ctx.beginPath(); ctx.arc(m.x * w, m.y * h, r, 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.fill();
      ctx.lineWidth = Math.max(2, Math.round(r * 0.14)); ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.stroke();
      ctx.fillStyle = (m.color === 'white' || m.color === 'yellow') ? '#111' : '#fff';
      ctx.font = `bold ${Math.round(r * 1.25)}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(m.num), m.x * w, m.y * h + r * 0.04);
      ctx.restore();
    } else {
      outline(() => {
        ctx.beginPath();
        ctx.ellipse(m.x * w, m.y * h, Math.max(3, m.rx * w), Math.max(3, m.ry * h), 0, 0, Math.PI * 2);
        ctx.stroke();
      });
    }
    if (m.text) {
      ctx.save();
      ctx.font = `bold ${font}px sans-serif`;
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      const anchor = m.shape === 'arrow2' ? { x: m.x2, y: m.y2 }
        : m.shape === 'free' ? (() => { const b = pathBounds(m.pts); return { x: b.left + b.width / 2, y: b.top + b.height }; })()
          : { x: m.x, y: m.y + (m.ry || NUM_R) };
      const tx = anchor.x * w;
      const ty = anchor.y * h + font * 1.1;
      const tw = ctx.measureText(m.text).width;
      const bx = Math.min(Math.max(2, tx - tw / 2 - 6), Math.max(2, w - tw - 14));
      const by = Math.min(ty, h - font - 6);
      ctx.fillStyle = 'rgba(0,0,0,.72)';
      ctx.fillRect(bx, by - font, tw + 12, font + 10);
      ctx.fillStyle = col === '#ffffff' ? '#fff' : col;
      ctx.fillText(m.text, bx + 6, by + 4);
      ctx.restore();
    }
  }
};
