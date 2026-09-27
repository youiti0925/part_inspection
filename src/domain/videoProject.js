// ============================================================================
// 🎞 編集の中身(プロジェクト) — 「どの区間を・どの速さで・何を重ねて」を1つの型に
// ----------------------------------------------------------------------------
// 清水さん(2026-08-13):
//   「市場比較は一番重要。時間かけて編集する上で必要な機能は全部入れて」
//
// ⚠⚠ なぜ作り直すのか(前の作りの限界):
//   前は 画面(モード)ごとに別の入れ物を持っていた。
//     ・分ける  → splitPoints[]
//     ・消す    → removes[]
//     ・画像挟む → inserts[]
//   これだと **組み合わせられない**。「いらない所を消して、そこに画像を挟んで、
//   さらにその区間だけ倍速」が原理的に作れない。市場の道具が必ず持っている
//   「タイムライン(部品を並べた1本の帯)」が無いのが、遜色の正体。
//
//   → ここでは **部品(clip)を並べた1本** として持つ。
//     ・切る/消す = 部品を割って捨てる
//     ・並べ替え  = 部品の順を入れ替える
//     ・倍速      = 部品ごとの speed
//     ・画像を挟む = 画像の部品を差し込む
//     ・〇/文字/モザイク = 「出来上がりの時刻」に対する重ね(overlay)
//
// ⚠ここには React も ブラウザAPI も import しない (node --test で回すため)。
// ⚠時刻の言葉を混ぜない:
//     src時刻 = 元の動画の中の秒
//     out時刻 = 出来上がりの動画の中の秒
//   speed が 1 でない部品があると **この2つは一致しない**。関数名に必ず src/out を書く。
// ============================================================================

/** 部品ごとに選べる速さ。⚠市場の道具はどれも0.25〜4倍。ここを狭めない。 */
export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
/** 重ねられる物の種類。 */
export const OVERLAY_KINDS = ['mark', 'text', 'mosaic', 'spot'];
/** 短すぎる部品は作らない(0.1秒の欠片ができると「壊れている」と思われる)。 */
export const MIN_CLIP = 0.2;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp01 = (v) => Math.min(1, Math.max(0, num(v, 0)));
const r3 = (v) => Math.round(num(v, 0) * 1000) / 1000;
/** ⚠数や配列が入っていても文字として扱わない(画面に "[object Object]" が出る)。 */
const str = (v) => (typeof v === 'string' ? v : '');

/**
 * ⭕ その部品に **焼き込む物** — 印・字幕・印の座標の意味。
 * ----------------------------------------------------------------------------
 * ⚠⚠ 書き出し(videoExport.js)の3つの分岐(🖼画像を挟む / ⏸止め絵 / 🎞映像)が
 *   **ここ1つだけ** を見るようにする。前は映像の分岐だけ `marks: [], caption: ''` と
 *   手で書いてあり、映像の部品に付けた印が **そこで空に上書きされていた**。
 *   実測 2026-08-16(scripts/verify-mark-burnin.mjs): 印を付けて書き出したMP4の
 *   赤い画素が **0**(⏸止め絵・🖼画像・▶流したままは 2000超で出ていた)。
 *   分岐ごとに手で書くと、また片方だけ直る。だから1本にする。
 *
 * ⚠ marksInPicture = 印の座標が「絵の中の割合(黒帯を除く)」か「枠全体の割合」か。
 *   落とすと黒帯のぶんズレる。true は「🖼画像を挟む」の画面で付けた印だけ。
 */
export const partOverlayInfo = (part) => ({
  marks: (Array.isArray(part?.marks) ? part.marks : []).filter(Boolean),
  caption: str(part?.caption),
  marksInPicture: !!part?.marksInPicture,
});

/** 速さを許す値に丸める。⚠0や負の数を通すと長さが無限になる。 */
export const normSpeed = (v) => {
  const s = num(v, 1);
  if (!(s > 0)) return 1;
  return Math.min(4, Math.max(0.25, s));
};

// ---------------------------------------------------------------------------
// 部品(clip)
// ---------------------------------------------------------------------------
/**
 * 映像の部品: { id, type:'video',  srcId, start, end, speed, mute, volume, zoom }
 * 画像の部品: { id, type:'image',  imageId, durationSec, marks, caption, zoom }
 * 止め絵の部品: { id, type:'freeze', srcId, atSec, durationSec, marks, caption, zoom }
 *
 * ⚠⚠ 止め絵(freeze)= 元の動画の「その1枚」で止めて、印や説明を出すための部品。
 *   画面の位置に固定した印は **映像が流れている限りズレる**(カメラを固定しても、
 *   手・部品・工具・人が動くのでズレる)。止めれば原理的にズレない。
 *   画像の部品とほぼ同じ扱いだが、絵は **元の動画から取ってくる**(imageId ではなく atSec)。
 *
 * ⚠画像の File 本体はここに入れない(idで引く)。JSONにできる形に保つ。
 */
export const clipOutSec = (clip) => {
  if (!clip) return 0;
  if (clip.type === 'image' || clip.type === 'freeze') return Math.max(0.2, num(clip.durationSec, 4));
  const span = num(clip.end, 0) - num(clip.start, 0);
  if (!(span > 0)) return 0;
  return span / normSpeed(clip.speed);
};

/** 出来上がりの長さ(秒)。 */
export const projectOutSec = (project) =>
  (project?.clips || []).reduce((a, c) => a + clipOutSec(c), 0);

/** 部品の並びに out時刻 を付けたもの。画面のタイムラインはこれを描く。 */
export const timelineOf = (project) => {
  let at = 0;
  return (project?.clips || []).map((c, i) => {
    const dur = clipOutSec(c);
    const row = { ...c, index: i, outStart: at, outEnd: at + dur, outSec: dur };
    at += dur;
    return row;
  });
};

/**
 * out時刻 → どの部品の・元の何秒か。
 * ⚠部品の境目ぴったりは **次の部品の頭** とみなす(境目で1フレーム重なると音がプツる)。
 * @returns {{index, clip, srcSec, offsetSec}} | null
 */
export const outToSrc = (project, tOut) => {
  const t = num(tOut, 0);
  const rows = timelineOf(project);
  if (!rows.length) return null;
  for (const r of rows) {
    if (t < r.outEnd - 1e-6 || r === rows[rows.length - 1]) {
      const off = Math.max(0, Math.min(r.outSec, t - r.outStart));
      if (r.type === 'image') return { index: r.index, clip: r, srcSec: 0, offsetSec: off };
      // ⚠止め絵は「元の動画のその1枚」。中でどれだけ進んでも src の時刻は動かない。
      if (r.type === 'freeze') return { index: r.index, clip: r, srcSec: num(r.atSec, 0), offsetSec: off };
      return { index: r.index, clip: r, srcSec: num(r.start, 0) + off * normSpeed(r.speed), offsetSec: off };
    }
  }
  return null;
};

/** その部品の src時刻 → out時刻。無ければ null(消された区間)。 */
export const srcToOut = (project, clipIndex, srcSec) => {
  const rows = timelineOf(project);
  const r = rows[clipIndex];
  if (!r || r.type === 'image') return null;
  const s = num(srcSec, 0);
  if (s < num(r.start, 0) - 1e-6 || s > num(r.end, 0) + 1e-6) return null;
  return r.outStart + (s - num(r.start, 0)) / normSpeed(r.speed);
};

/** 元の動画のどこが残っているか(src時刻の区間)。「消した所」を帯で見せるのに使う。 */
export const keptSrcRanges = (project, srcId = null) =>
  (project?.clips || [])
    .filter(c => c.type === 'video' && (srcId == null || c.srcId === srcId))
    .map(c => ({ start: num(c.start, 0), end: num(c.end, 0) }))
    .sort((a, b) => a.start - b.start);

// ---------------------------------------------------------------------------
// id
// ---------------------------------------------------------------------------
/** 既にある物とぶつからない id。⚠Math.random を使わない(同じ入力なら同じ結果)。 */
export const mkId = (prefix, existing = []) => {
  let n = 1;
  const used = new Set((existing || []).map(x => (typeof x === 'string' ? x : x?.id)));
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
};

// ---------------------------------------------------------------------------
// 編集操作(どれも新しい project を返す。元は変えない)
// ---------------------------------------------------------------------------

/** 空のプロジェクト。 */
export const emptyProject = () => ({
  clips: [], overlays: [], notes: {}, rotate: 0, crop: null,
  // 🔆 明るさ/くっきり/鮮やかさ。⚠1 = そのまま
  adjust: { brightness: 1, contrast: 1, saturate: 1 },
  audio: { volume: 1, fadeIn: 0, fadeOut: 0 },
  quality: 'mid', fps: 30, mute: false,
});

/** 元動画たちから作る。 @param sources [{id, durationSec}] */
export const projectFromSources = (sources = []) => {
  const p = emptyProject();
  p.clips = (sources || [])
    .filter(s => s && num(s.durationSec, 0) > 0)
    .map((s, i) => ({
      id: `c${i + 1}`, type: 'video', srcId: s.id,
      start: 0, end: r3(num(s.durationSec, 0)), speed: 1, mute: false, volume: 1, zoom: null,
    }));
  return p;
};

/**
 * out時刻で切る(部品を2つに割る)。市場の道具の「分割」。
 * ⚠切った所より後ろの重ね(overlay)は動かさない。切るだけでは長さが変わらないため。
 */
export const splitAt = (project, tOut) => {
  const rows = timelineOf(project);
  const hit = outToSrc(project, tOut);
  if (!hit) return project;
  const r = rows[hit.index];
  // 端すぎる所では割らない(0.2秒未満の欠片を作らない)
  if (hit.offsetSec < MIN_CLIP || r.outSec - hit.offsetSec < MIN_CLIP) return project;
  const clips = [...project.clips];
  const c = clips[hit.index];
  const ids = clips.map(x => x.id);
  if (c.type === 'image' || c.type === 'freeze') {
    const a = { ...c, durationSec: r3(hit.offsetSec) };
    const b = { ...c, id: mkId('c', ids), durationSec: r3(r.outSec - hit.offsetSec) };
    clips.splice(hit.index, 1, a, b);
  } else {
    const cut = r3(hit.srcSec);
    const a = { ...c, end: cut };
    const b = { ...c, id: mkId('c', ids), start: cut };
    clips.splice(hit.index, 1, a, b);
  }
  return { ...project, clips };
};

/** 部品を消す。⚠後ろの重ねは、消えた長さぶん前へ詰める(市場でいうリップル削除)。 */
export const deleteClip = (project, index) => {
  const rows = timelineOf(project);
  const r = rows[index];
  if (!r) return project;
  const clips = project.clips.filter((_, i) => i !== index);
  const overlays = shiftOverlays(project.overlays, r.outStart, -r.outSec, r.outEnd);
  return { ...project, clips, overlays };
};

/** 部品を並べ替える。 */
export const moveClip = (project, from, to) => {
  const clips = [...(project?.clips || [])];
  if (from < 0 || from >= clips.length) return project;
  const t = Math.min(clips.length - 1, Math.max(0, to));
  const [c] = clips.splice(from, 1);
  clips.splice(t, 0, c);
  return { ...project, clips };
};

/** 部品の中身を書き換える(速さ・音・ズーム・画像の秒数など)。 */
export const patchClip = (project, index, patch) => {
  const clips = (project?.clips || []).map((c, i) => {
    if (i !== index) return c;
    const n = { ...c, ...patch };
    if (n.type === 'video') {
      n.speed = normSpeed(n.speed);
      n.start = Math.max(0, r3(num(n.start, 0)));
      n.end = Math.max(n.start + 0.05, r3(num(n.end, 0)));
    } else {
      n.durationSec = Math.max(0.2, r3(num(n.durationSec, 4)));
      if (n.type === 'freeze') n.atSec = Math.max(0, r3(num(n.atSec, 0)));
    }
    return n;
  });
  return { ...project, clips };
};

/** 部品の端をつまんで伸ばす/縮める(トリム)。⚠元動画の外へは出せない。 */
export const trimClip = (project, index, { start, end }, srcDurationSec = null) => {
  const c = (project?.clips || [])[index];
  if (!c || c.type !== 'video') return project;
  let s = start == null ? num(c.start, 0) : num(start, 0);
  let e = end == null ? num(c.end, 0) : num(end, 0);
  s = Math.max(0, s);
  if (srcDurationSec != null) e = Math.min(num(srcDurationSec, e), e);
  if (e - s < MIN_CLIP) {
    // ⚠つまみすぎて消えるのを防ぐ。動かした側を戻す。
    if (start != null) s = e - MIN_CLIP;
    else e = s + MIN_CLIP;
    if (s < 0) { s = 0; e = MIN_CLIP; }
  }
  return patchClip(project, index, { start: r3(s), end: r3(e) });
};

/**
 * 🖼画像 / ⏸止め絵 を「何秒出すか」を後から変える。
 * ----------------------------------------------------------------------------
 * 清水さん(2026-08-14)「挟んだ画像を何秒出しているかも選択できるように」
 *
 * ⚠⚠ patchClip で秒数だけ変えてはいけない。
 *   3秒の画像を10秒にすると、**その後ろの字幕・目隠しはその場に残る** ので、
 *   7秒ぶん早く出る = 全部 別の場面で出るようになる。
 *   (挟む時=insertImageAt は ちゃんとずらしている。直す時だけ抜けていた)
 *   → 伸び縮みした分だけ、後ろの重ねを一緒にずらす。
 */
export const setClipDuration = (project, index, durationSec) => {
  const rows = timelineOf(project);
  const r = rows[index];
  if (!r || (r.type !== 'image' && r.type !== 'freeze')) return project;   // 映像の部品には効かない(あれは端をつまむ)
  const next = Math.max(0.2, r3(num(durationSec, r.outSec)));
  const delta = r3(next - r.outSec);
  if (Math.abs(delta) < 1e-6) return project;
  const p = patchClip(project, index, { durationSec: next });
  return { ...p, overlays: shiftOverlays(p.overlays, r.outEnd, delta) };
};

/** out時刻の所に画像の部品を差し込む。⚠そこが部品の途中なら割ってから挟む。 */
/**
 * ⏸ その位置で映像を止めて、印や説明を出す部品を差し込む。
 * ⚠印がズレない唯一の確実な方法。追尾が要らない。
 * @param opts.durationSec 何秒止めるか / opts.marks 印 / opts.caption 下に出す説明
 */
export const insertFreezeAt = (project, tOut, opts = {}) => {
  const hit = outToSrc(project, tOut);
  if (!hit || hit.clip.type !== 'video') return project;   // 映像の上でしか止められない
  const srcId = hit.clip.srcId;
  const atSec = r3(hit.srcSec);
  const p = splitAt(project, tOut);
  const rows = timelineOf(p);
  let at = rows.findIndex(r => r.outStart >= num(tOut, 0) - 1e-6);
  if (at < 0) at = rows.length;
  const clips = [...p.clips];
  const clip = {
    id: mkId('c', clips), type: 'freeze', srcId, atSec,
    durationSec: Math.max(0.2, num(opts.durationSec, 3)),
    marks: opts.marks || [], caption: opts.caption || '', zoom: opts.zoom || null,
  };
  clips.splice(at, 0, clip);
  const overlays = shiftOverlays(p.overlays, num(tOut, 0), clip.durationSec);
  return { ...p, clips, overlays };
};

export const insertImageAt = (project, tOut, image) => {
  const p = splitAt(project, tOut);
  const rows = timelineOf(p);
  // 差し込む位置 = tOut 以上で最初に始まる部品の前
  let at = rows.findIndex(r => r.outStart >= num(tOut, 0) - 1e-6);
  if (at < 0) at = rows.length;
  const clips = [...p.clips];
  const clip = {
    id: mkId('c', clips), type: 'image',
    imageId: image?.imageId || image?.id || '',
    durationSec: Math.max(0.2, num(image?.durationSec, 4)),
    marks: image?.marks || [], caption: image?.caption || '', zoom: image?.zoom || null,
  };
  clips.splice(at, 0, clip);
  const overlays = shiftOverlays(p.overlays, num(tOut, 0), clip.durationSec);
  return { ...p, clips, overlays };
};

// ---------------------------------------------------------------------------
// 重ね(overlay) — 出来上がりの時刻に対して出す
// ---------------------------------------------------------------------------
/** at 以降の重ねを delta 秒ずらす。@param dropFrom..dropTo に丸ごと入る物は消す。 */
export const shiftOverlays = (overlays, at, delta, dropTo = null) => {
  const a = num(at, 0), d = num(delta, 0);
  const out = [];
  for (const o of (overlays || [])) {
    const from = num(o.from, 0), to = num(o.to, 0);
    if (dropTo != null && from >= a - 1e-6 && to <= num(dropTo, 0) + 1e-6) continue;   // 消えた区間の中の物
    if (to <= a + 1e-6) { out.push(o); continue; }                                     // 前にある物は動かさない
    out.push({ ...o, from: r3(Math.max(0, from >= a ? from + d : from)), to: r3(Math.max(0.1, to + d)) });
  }
  return out.filter(o => num(o.to, 0) - num(o.from, 0) > 0.05);
};

/** その時刻に出ている重ね。 */
export const overlaysAt = (project, tOut) => {
  const t = num(tOut, 0);
  return (project?.overlays || []).filter(o => t >= num(o.from, 0) - 1e-6 && t < num(o.to, 0) - 1e-6);
};

/** 重ねを足す。⚠既定の長さは3秒(市場の道具の既定と同じ)。0秒の重ねは作らない。 */
export const addOverlay = (project, o) => {
  const kind = OVERLAY_KINDS.includes(o?.kind) ? o.kind : 'mark';
  const from = Math.max(0, num(o?.from, 0));
  const to = Math.max(from + 0.2, num(o?.to, from + 3));
  const overlays = [...(project?.overlays || []), { ...o, kind, id: mkId('o', project?.overlays || []), from: r3(from), to: r3(to) }];
  return { ...project, overlays };
};

export const patchOverlay = (project, id, patch) => ({
  ...project,
  overlays: (project?.overlays || []).map(o => {
    if (o.id !== id) return o;
    const n = { ...o, ...patch };
    n.from = Math.max(0, r3(num(n.from, 0)));
    n.to = Math.max(n.from + 0.2, r3(num(n.to, n.from + 1)));
    return n;
  }),
});

export const removeOverlay = (project, id) => ({
  ...project, overlays: (project?.overlays || []).filter(o => o.id !== id),
});

// ---------------------------------------------------------------------------
// 画づくり(回転・切り抜き)
// ---------------------------------------------------------------------------
/**
 * 出来上がりの縦横。⚠回転で縦横が入れ替わる。切り抜きは回転後の絵に対する割合。
 * ⚠幅・高さとも偶数に丸める(H.264が奇数を嫌う)。
 */
export const outputDims = (srcW, srcH, rotate = 0, crop = null, maxW = 854) => {
  let w = Math.max(1, num(srcW, 16)), h = Math.max(1, num(srcH, 9));
  const rot = ((num(rotate, 0) % 360) + 360) % 360;
  if (rot === 90 || rot === 270) { const t = w; w = h; h = t; }
  if (crop && num(crop.w, 0) > 0 && num(crop.h, 0) > 0) {
    w = w * clamp01(crop.w); h = h * clamp01(crop.h);
  }
  // ⚠⚠ 上限は「幅」ではなく **画素の数** で掛ける。
  //   前は 縦横を入れ替えた後の幅に maxW を掛けていたので、90°回した瞬間に
  //   854x480(41万画素) → 854x1518(130万画素) = **3.16倍** に膨らんでいた。
  //   ビットレートは画質設定のまま(標準1.8Mbps)なので、1画素あたりの情報が
  //   1/3.2 に落ちる = **同じ「標準」を選んだのに、回した時だけ黙って粗くなる**。
  //   pickVideoCodec は Level 4.0 まで試すので エラーにもならず気づけない。
  //   → 「標準」は向きに関わらず同じ量の絵、に揃える(横 854x480 / 縦 480x854)。
  //   ⚠元が小さい動画は引き伸ばさない(荒くするだけ)。Math.min(1, …) を外さない事。
  const mw = num(maxW, 854);
  const budget = mw * mw * 9 / 16;                 // 854 → 409,920画素(=854x480)
  const scale = Math.min(1, Math.sqrt(budget / Math.max(1, w * h)));
  let ow = Math.round(w * scale), oh = Math.round(h * scale);
  ow -= ow % 2; oh -= oh % 2;
  return { width: Math.max(2, ow), height: Math.max(2, oh) };
};

/** 切り抜きの枠を整える(絵の外に出さない・小さすぎる枠にしない)。 */
export const normCrop = (crop) => {
  if (!crop) return null;
  let x = clamp01(crop.x), y = clamp01(crop.y);
  let w = clamp01(crop.w), h = clamp01(crop.h);
  if (w < 0.08) w = 0.08;
  if (h < 0.08) h = 0.08;
  if (x + w > 1) x = 1 - w;
  if (y + h > 1) y = 1 - h;
  if (x === 0 && y === 0 && w >= 0.999 && h >= 0.999) return null;   // 全面 = 切り抜き無し
  return { x: r3(x), y: r3(y), w: r3(w), h: r3(h) };
};

// ---------------------------------------------------------------------------
// ズーム(拡大して見せる) — 部品の中で少しずつ寄る
// ---------------------------------------------------------------------------
/**
 * @param zoom {from:{scale,cx,cy}, to:{scale,cx,cy}} … cx/cy は絵の中の中心(0-1)
 * @param p    その部品の中の進み具合 0-1
 * @returns {scale, cx, cy}
 */
export const zoomAt = (zoom, p) => {
  if (!zoom) return { scale: 1, cx: 0.5, cy: 0.5 };
  const t = Math.min(1, Math.max(0, num(p, 0)));
  const a = zoom.from || {}, b = zoom.to || zoom.from || {};
  const lerp = (x, y, d) => num(x, d) + (num(y, num(x, d)) - num(x, d)) * t;
  const scale = Math.max(1, lerp(a.scale, b.scale, 1));
  return { scale, cx: clamp01(lerp(a.cx, b.cx, 0.5)), cy: clamp01(lerp(a.cy, b.cy, 0.5)) };
};

// ---------------------------------------------------------------------------
// 無音カット(しゃべっていない所を自動で見つける)
// ---------------------------------------------------------------------------
/**
 * 波形の山(0-1の配列)から「音が小さい区間」を探す。
 * 清水さん用途では「機械が回っているだけの間」「無言で歩いている間」を落とす。
 * ⚠短い息継ぎで切らない(minSec)。⚠前後に少し余白を残す(padSec)。切り詰めすぎると言葉が欠ける。
 * @param peaks   0-1 の配列(先頭が0秒)
 * @param totalSec 全体の秒数
 * @returns [{start,end}] 消してよい区間(src時刻)
 */
export const silenceRanges = (peaks, totalSec, opts = {}) => {
  const list = (peaks || []).map(v => num(v, 0));
  const dur = num(totalSec, 0);
  if (!list.length || !(dur > 0)) return [];
  const { threshold = 0.06, minSec = 1.2, padSec = 0.25 } = opts;
  const per = dur / list.length;
  const out = [];
  let run = -1;
  for (let i = 0; i <= list.length; i++) {
    const quiet = i < list.length && list[i] <= threshold;
    if (quiet && run < 0) run = i;
    if (!quiet && run >= 0) {
      const s = run * per, e = i * per;
      if (e - s >= minSec) out.push({ start: r3(s + padSec), end: r3(Math.max(s + padSec + 0.1, e - padSec)) });
      run = -1;
    }
  }
  return out.filter(r => r.end - r.start > 0.2);
};

/**
 * src時刻の「消す区間」を、いまの部品の並びに反映する(部品を割って捨てる)。
 * ⚠ひとつの元動画に対してだけ効かせる(つないだ別の動画まで消さない)。
 */
export const cutSrcRanges = (project, srcId, ranges) => {
  const rs = (ranges || [])
    .filter(r => r && Number.isFinite(Number(r.start)) && Number.isFinite(Number(r.end)))
    .map(r => ({ start: num(r.start, 0), end: num(r.end, 0) }))
    .filter(r => r.end - r.start > 0.05)
    .sort((a, b) => a.start - b.start);
  if (!rs.length) return project;
  const clips = [];
  let seq = 0;
  const nextId = () => `k${++seq}`;
  for (const c of (project?.clips || [])) {
    if (c.type !== 'video' || (srcId != null && c.srcId !== srcId)) { clips.push(c); continue; }
    let pieces = [{ ...c }];
    for (const r of rs) {
      const nx = [];
      for (const p of pieces) {
        const s = num(p.start, 0), e = num(p.end, 0);
        if (r.end <= s || r.start >= e) { nx.push(p); continue; }          // 重ならない
        if (r.start > s) nx.push({ ...p, id: nextId(), start: s, end: r3(r.start) });
        if (r.end < e) nx.push({ ...p, id: nextId(), start: r3(r.end), end: e });
      }
      pieces = nx;
    }
    for (const p of pieces) if (num(p.end, 0) - num(p.start, 0) >= MIN_CLIP) clips.push(p);
  }
  // ⚠idの重複を残さない(Reactのkeyが壊れて画面が入れ替わる)
  const seen = new Set();
  const fixed = clips.map(c => {
    if (!seen.has(c.id)) { seen.add(c.id); return c; }
    const id = mkId('c', [...seen].map(x => ({ id: x })));
    seen.add(id);
    return { ...c, id };
  });
  return { ...project, clips: fixed };
};

// ---------------------------------------------------------------------------
// 書き出しの段取り
// ---------------------------------------------------------------------------
/**
 * 書き出しエンジンに渡す並び。out時刻つき。
 * @returns [{type, outStart, outEnd, ...}]
 */
export const renderParts = (project) => timelineOf(project).map(r => ({
  type: r.type, clipId: r.id, srcId: r.srcId, imageId: r.imageId, atSec: num(r.atSec, 0),
  start: num(r.start, 0), end: num(r.end, 0), speed: normSpeed(r.speed),
  mute: !!r.mute, volume: num(r.volume, 1), zoom: r.zoom || null,
  durationSec: (r.type === 'image' || r.type === 'freeze') ? clipOutSec(r) : undefined,
  marks: r.marks || undefined, caption: r.caption || undefined,
  // ⚠印を「絵の中の割合」で覚えている道(古い『🖼画像を挟む』の画面)は、その旨を運ぶ。
  //   運ばないと、黒帯のぶん印がズレたまま焼き込まれる。
  marksInPicture: r.marksInPicture || undefined,
  outStart: r3(r.outStart), outEnd: r3(r.outEnd), outSec: r3(r.outSec),
}));

/**
 * 並びの一部だけを取り出す(章ごとに別ファイルへ書き出す時)。
 * ⚠out時刻で切って、映像の部品は **速さを掛けて src時刻へ戻す**。
 *   ここを間違えると、倍速の部品を含む章だけ中身がズレる。
 * @returns 切り出した parts(outStart は 0 から振り直す)
 */
export const sliceParts = (parts, from, to) => {
  const f = num(from, 0), t = num(to, 0);
  if (!(t > f)) return [];
  const out = [];
  for (const p of (parts || [])) {
    const s = Math.max(num(p.outStart, 0), f);
    const e = Math.min(num(p.outEnd, 0), t);
    if (e - s <= 0.02) continue;
    const head = s - num(p.outStart, 0);
    const span = e - s;
    if (p.type === 'image' || p.type === 'freeze') {
      out.push({ ...p, durationSec: r3(span), outStart: r3(s - f), outEnd: r3(e - f), outSec: r3(span) });
    } else {
      const sp = normSpeed(p.speed);
      out.push({
        ...p,
        start: r3(num(p.start, 0) + head * sp),
        end: r3(num(p.start, 0) + (head + span) * sp),
        outStart: r3(s - f), outEnd: r3(e - f), outSec: r3(span),
      });
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// 📍 章(区切り) — 形が2つある。読む側を1本にする
// ---------------------------------------------------------------------------
/**
 * 📍章の形は **2つ在る**。どちらで来ても同じに読めるようにする。
 *
 *   ・✨編集室      `{name, atOut}`
 *   ・✏️手本レシピ  `{id, stepKey, label, start, end, source}`
 *
 * ⚠⚠ **形そのものは変えない。** 本番の `video_recipes` に入っている実データが
 *   後者の形なので、形を揃えに行くとデータ移行が要る(既存のレシピが読めなくなる)。
 *   → 読み替えを1本にして、両方受けられる側を直す。
 *
 * ⚠ `start` は「元の動画の秒」、`atOut` は「出来上がりの秒」。
 *   手本レシピは動画を作り直さない(元動画をそのまま再生する)ので、その道では
 *   この2つは同じ物を指す。編集して書き出す道(編集室)だけが両者を分ける。
 *
 * @returns {{name, atOut}} | null … 読めない物は null
 */
export const normChapter = (c) => {
  if (!c || typeof c !== 'object') return null;
  const name = String(c.name == null || c.name === '' ? (c.label == null ? '' : c.label) : c.name);
  const at = Number.isFinite(Number(c.atOut)) ? Number(c.atOut)
    : Number.isFinite(Number(c.start)) ? Number(c.start) : 0;
  return { name, atOut: Math.max(0, r3(at)) };
};

/** 章の一覧を1つの形に。⚠読めない物は落とすが、**並びは元のまま**(番号で鍵を作る側がズレる)。 */
export const normChapters = (chapters) =>
  (Array.isArray(chapters) ? chapters : []).map(normChapter).filter(Boolean);

/**
 * 章(工程)ごとに別ファイルへ分ける時の区切り。
 * @param chapters [{name, atOut}] または [{label, start}](手本レシピの形)
 * @returns [{name, from, to}]
 */
export const chapterSegments = (project, chapters = []) => {
  const total = projectOutSec(project);
  if (!(total > 0)) return [];
  const list = normChapters(chapters);
  const pts = [...new Set(list
    .map(c => ({ name: c.name, at: c.atOut }))
    .filter(c => c.at > 0.05 && c.at < total - 0.05)
    .map(c => `${c.at}|${c.name}`))]
    .map(s => { const [a, ...n] = s.split('|'); return { at: Number(a), name: n.join('|') }; })
    .sort((a, b) => a.at - b.at);
  const bounds = [{ at: 0, name: list.find(c => c.atOut === 0)?.name || '' }, ...pts];
  const out = [];
  for (let i = 0; i < bounds.length; i++) {
    const from = bounds[i].at;
    const to = i + 1 < bounds.length ? bounds[i + 1].at : total;
    if (to - from < 0.2) continue;
    out.push({ name: bounds[i].name || `区間${out.length + 1}`, from: r3(from), to: r3(to) });
  }
  return out;
};

/** 読み込んだ物を安全な形に整える(古い保存や壊れた値でも落ちないように)。 */
export const normalizeProject = (p) => {
  const base = emptyProject();
  if (!p || typeof p !== 'object') return base;
  const clips = (Array.isArray(p.clips) ? p.clips : [])
    .map((c, i) => {
      if (!c || typeof c !== 'object') return null;
      if (c.type === 'image' || c.type === 'freeze') {
        const base = {
          id: c.id || `c${i + 1}`, type: c.type,
          durationSec: Math.max(0.2, num(c.durationSec, 4)),
          ...partOverlayInfo(c),
          zoom: c.zoom || null,
          // 📄作業標準の3欄。⚠⚠ ここに書かないと **書き出しの入口で黙って消える**。
          //   normalizeProject は videoExport.js が必ず通す。落とすと、書き出した後に
          //   作業標準を作った人には 急所も理由も空欄で出る(2026-08-16 実測: missing.point=1)。
          step: str(c.step), point: str(c.point), why: str(c.why),
        };
        if (c.type === 'freeze') return { ...base, srcId: c.srcId || '', atSec: Math.max(0, r3(num(c.atSec, 0))) };
        return { ...base, imageId: c.imageId || '' };
      }
      const start = Math.max(0, num(c.start, 0));
      const end = num(c.end, 0);
      if (!(end - start > 0.02)) return null;
      // ⚠⚠ 映像の部品にも marks / caption を残す。
      //   前はここに marks キーが無く、映像の部品に付けた印が **この一行で消えていた**。
      //   実測 2026-08-16: 印を付けて書き出した動画の赤い画素が **0**(止め絵・画像は2000超)。
      return { id: c.id || `c${i + 1}`, type: 'video', srcId: c.srcId || '', start: r3(start), end: r3(end), speed: normSpeed(c.speed), mute: !!c.mute, volume: num(c.volume, 1), zoom: c.zoom || null, ...partOverlayInfo(c) };
    })
    .filter(Boolean);
  const overlays = (Array.isArray(p.overlays) ? p.overlays : [])
    .filter(o => o && OVERLAY_KINDS.includes(o.kind))
    .map((o, i) => ({ ...o, id: o.id || `o${i + 1}`, from: Math.max(0, r3(num(o.from, 0))), to: r3(num(o.to, 0)) }))
    .filter(o => o.to - o.from > 0.05);
  // 🎙 あとから吹き込んだ言葉 / 手で足したメモ。
  // ⚠⚠ **鍵つきの入れ物(map)** で持つ。配列にして「読んで足して書く」をやると、
  //   多端末で同じ動画を触った時に、後から保存した端末が相手の分を丸ごと消す(後勝ち)。
  //   map なら 1件 = 1つの欄として書けるので、混ざっても消えない。
  const notesIn = p.notes && typeof p.notes === 'object' && !Array.isArray(p.notes) ? p.notes : {};
  const notes = {};
  for (const [k, v] of Object.entries(notesIn)) {
    if (!v || typeof v !== 'object') continue;
    const text = String(v.text == null ? '' : v.text).replace(/\s+/g, ' ').trim();
    if (!text) continue;                                   // ⚠空の言葉は残さない
    if (!Number.isFinite(Number(v.at))) continue;          // ⚠押しても飛べない言葉は残さない
    notes[k] = {
      at: Math.max(0, r3(num(v.at, 0))), text,
      kind: v.kind === 'ai' ? 'ai' : 'voice',
      by: String(v.by == null ? '' : v.by),
    };
  }
  const rot = ((num(p.rotate, 0) % 360) + 360) % 360;
  return {
    ...base, ...p, clips, overlays, notes,
    rotate: [0, 90, 180, 270].includes(rot) ? rot : 0,
    crop: normCrop(p.crop),
    audio: { volume: num(p.audio?.volume, 1), fadeIn: Math.max(0, num(p.audio?.fadeIn, 0)), fadeOut: Math.max(0, num(p.audio?.fadeOut, 0)) },
    adjust: {
      brightness: Math.min(3, Math.max(0.2, num(p.adjust?.brightness, 1))),
      contrast: Math.min(3, Math.max(0.2, num(p.adjust?.contrast, 1))),
      saturate: Math.min(3, Math.max(0, num(p.adjust?.saturate, 1))),
    },
    fps: [24, 30, 60].includes(num(p.fps, 30)) ? num(p.fps, 30) : 30,
    mute: !!p.mute,
  };
};
