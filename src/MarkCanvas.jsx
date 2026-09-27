// ============================================================================
// ✍ 「なぞって描く」— 動画や画像の上に、〇/□/矢印/なぞり書き/番号 を指で描く
// ----------------------------------------------------------------------------
// 清水さん(2026-08-13):
//   「〇が小さすぎて使えない。その場所によって〇の大きさや形（楕円）変わるから
//     そこも追加してほしい」
//   「市場比較は一番重要。編集する上で必要な機能は全部入れて」
//
// いままで: タップ → 固定サイズ(3.5rem)の赤い丸が出るだけ。大きさも形も色も変えられない。
// これから: **なぞった範囲がそのまま印**。形5つ・色5色・太さ3段。あとから大きさも変えられる。
//
// ⚠⚠ 現場は **タブレット(指)**。ここを外すと使えない:
//   ① 指でなぞると **ページがスクロールする** → touchAction:'none'(CSSで止める。
//      React の touchmove は passive なので preventDefault では止まらない)
//   ② 途中で指が枠の外へ出ると座標が来なくなる → setPointerCapture で追い続ける
//   ③ もともと「映像をタップ＝再生/停止」なので、**描くモードの間だけ**この層を出す
//   ④ 取っ手は指で押せる大きさ(44px)。印が小さくても取っ手は縮めない
//
// ⚠⚠ 決めごと(ここを間違えると使えない。全部ハーネスで毎回確かめている):
//   ・**なぞる = いつでも新しい印**。
//     ⚠大きく囲んだ印の内側でも新しく描ける。
//     (「印の上ならつかむ」にすると、大きく囲んだ瞬間に画面のほとんどが
//      『つかむ場所』になり、**2個目が永久に描けなくなる**)
//   ・**印をタップ = その印を選ぶ**。選ぶと取っ手が出る。
//   ・**取っ手をなぞる = 動かす / 大きさを変える**。
//   ⚠ドラッグ中は既定では親へ知らせない。指を離した時に **1回だけ** 知らせる
//     (毎フレーム知らせると、1回のドラッグで「ひとつ戻す」の履歴が全部埋まって過去が消える)。
//     ⚠ただし onPreview を渡した時だけは、動かしている間も知らせる(下を読むこと)。
//   ⚠pointercancel(手のひら誤爆・OSのジェスチャ)は **何も残さず捨てる**。
//
// ⚠座標は必ず domain/videoBox.js の toPicture を通す(黒帯のズレを吸収)。
//
// ----------------------------------------------------------------------------
// 2026-08-16 追加(清水さん「編集して〇とかつけて保存したけど、そのデータ見ても
//   〇とかついてなかった」への対応で、編集室が **もう入っている印** を掴めるように
//   なったため):
//
//   paintedBelow … **下の絵に、その印がもう描かれている**時に true。
//     編集室のプレビューは 書き出しと同じ paintFrame/drawOverlays を通した canvas なので、
//     入った印は canvas 側に描かれている。ここでもう一度 DOM で描くと **二重に見える**。
//     → true の時、この層は「描いている途中の下書き」と「取っ手」だけを出す。
//     ⚠既定は false。レシピ編集(App側)は下に印が描かれていないので、今までどおり全部描く。
//
//   onPreview(next) … 動かしている **最中** に呼ぶ(指を離す前)。
//     paintedBelow の時、これが無いと「動かしている間だけ印が消える」ように見える
//     (下の canvas は古い場所のまま・この層は描かない)ため。
//     ⚠履歴が埋まらないように、受け取る側が「ひと続きの操作を1手にまとめる」こと
//       (編集室は beginEdit() が 700ms でまとめている)。
//
//   selected / onSelect … 選んでいる印の番号を **親に持たせる**(色や太さを
//     「選んだ印」に効かせる為)。両方渡した時だけ親が主。片方だけならこの中で持つ。
// ============================================================================

import React, { useRef, useState, useCallback, useEffect } from 'react';
import {
  markFromDrag, markFromPath, moveMark, hitMark, normalizeMark,
  MARK_COLORS, MARK_WIDTHS,
} from './domain/videoMarks.js';
import { videoBox, toPicture } from './domain/videoBox.js';
import { RecipeMarks } from './RecipeMarks.jsx';

/** 印は何個まで。⚠画面(一覧)と同じ数にする。食い違うと「押しても増えない」になる。 */
export const MARK_MAX = 8;
const TAP = 0.02;          // これ未満の動き = タップ(なぞりではない)
const HANDLE_PX = 44;      // 取っ手の大きさ(指で押せる最小)

/**
 * @param targetRef  下にある <video> / <img> / <canvas> の ref(絵の範囲を測るのに使う)
 * @param marks      いまの印
 * @param onChange   (次の印の配列) => void   ⚠指を離した時に1回だけ呼ぶ
 * @param onBeforeChange  変更の直前に1回だけ呼ぶ(親の「ひとつ戻す」用)
 * @param onPreview  (次の印の配列) => void   動かしている最中(指を離す前)。省略可
 * @param paintedBelow true = 下の絵にもう印が描かれている(二重に描かない)
 * @param selected/onSelect 選んでいる印の番号を親に持たせる(両方渡した時だけ)
 * @param shape      'ellipse' | 'rect' | 'arrow2' | 'free' | 'num'
 * @param color/width 印の色・線の太さ
 */
export const MarkCanvas = ({
  targetRef, marks = [], onChange, onBeforeChange = null, onPreview = null,
  paintedBelow = false, selected = null, onSelect = null,
  shape = 'ellipse', color = 'red', width = 'm', max = MARK_MAX, hint = true,
}) => {
  const layerRef = useRef(null);
  const dragRef = useRef(null);   // { mode:'draw'|'move'|'resize'|'tip'|'tail', from, idx, orig, moved, pts }
  const [draft, setDraft] = useState(null);      // 描いている途中の印
  const [live, setLive] = useState(null);        // 動かしている途中の印 { idx, mark }
  // ⚠選んでいる番号は「親が持つ」か「ここが持つ」かのどちらか。
  //   混ぜると、色を変えた瞬間に選びが外れる/戻る、という直しにくい事故になる。
  const [selIn, setSelIn] = useState(-1);
  const ctl = typeof selected === 'number' && typeof onSelect === 'function';
  const sel = ctl ? selected : selIn;
  const setSel = ctl ? onSelect : setSelIn;

  // ⚠⚠ 絵の範囲は **描画のたびに ref を読む** のではなく、状態として持つ。
  //   ref を描画中に読むと、動画の大きさが分かった時(loadedmetadata)に描き直されず、
  //   **印が黒帯ぶんズレたまま**になる。
  const [box, setBox] = useState({ left: 0, top: 0, width: 1, height: 1 });
  useEffect(() => {
    const el = targetRef?.current;
    if (!el) return undefined;
    const recalc = () => setBox(prev => {
      const n = videoBox(el);
      // ⚠同じ値なら同じ物を返す(ResizeObserver の無限ループ警告を避ける)
      const same = Math.abs(prev.left - n.left) < 1e-4 && Math.abs(prev.top - n.top) < 1e-4
        && Math.abs(prev.width - n.width) < 1e-4 && Math.abs(prev.height - n.height) < 1e-4;
      return same ? prev : n;
    });
    recalc();
    const evs = ['loadedmetadata', 'loadeddata', 'resize', 'load'];
    evs.forEach(ev => el.addEventListener(ev, recalc));
    let ro = null;
    if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(recalc); ro.observe(el); }
    window.addEventListener('resize', recalc);
    window.addEventListener('orientationchange', recalc);   // タブレットの向き変更
    return () => {
      evs.forEach(ev => el.removeEventListener(ev, recalc));
      if (ro) ro.disconnect();
      window.removeEventListener('resize', recalc);
      window.removeEventListener('orientationchange', recalc);
    };
  }, [targetRef]);

  // 画面の位置 → 絵の中の割合。⚠測るのは **下の映像/画像** の要素(この層ではない)。
  const pt = useCallback((e) => {
    const el = targetRef?.current || layerRef.current;
    return toPicture(el, e.clientX, e.clientY);
  }, [targetRef]);

  const commit = useCallback((next) => {
    if (onBeforeChange) onBeforeChange();
    onChange(next.slice(0, max));
  }, [onBeforeChange, onChange, max]);

  /** ①②③ の次の番号。⚠すでに置いた番号の最大+1(消した番号は詰めない)。 */
  const nextNum = () => {
    const ns = (marks || []).map(normalizeMark).filter(m => m && m.shape === 'num').map(m => m.num);
    return Math.min(99, (ns.length ? Math.max(...ns) : 0) + 1);
  };
  const style = { color, width, num: nextNum() };

  // ---- 取っ手からの操作 ----------------------------------------------------
  const grabHandle = (kind, e) => {
    e.preventDefault(); e.stopPropagation();
    if (sel < 0) return;
    try { layerRef.current.setPointerCapture(e.pointerId); } catch { /* 対応していない端末では何もしない */ }
    dragRef.current = { mode: kind, idx: sel, from: pt(e), orig: normalizeMark(marks[sel]), moved: false };
  };

  const down = (e) => {
    if (!e.isPrimary) return;                                  // 2本目の指(拡大しようとした指)で線を引かない
    if (e.pointerType === 'mouse' && e.button !== 0) return;    // 右クリック
    e.preventDefault();
    e.stopPropagation();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 対応していない端末では何もしない */ }
    const p = pt(e);
    // ⚠ここで「印の上ならつかむ」にしない。大きく囲んだ印の内側が全部つかむ場所になり、
    //   2個目が描けなくなる。**なぞりは常に新しい印**。選ぶのは離した時に判断する。
    dragRef.current = { mode: 'draw', from: p, moved: false, wasOn: hitMark(marks, p.x, p.y), pts: [p] };
    setDraft(shape === 'free' ? null : markFromDrag(p.x, p.y, p.x, p.y, shape, style));
  };

  /** 動かしている途中の姿。⚠onPreview があれば親にも渡す(下の絵が付いてくる)。 */
  const preview = (idx, mark) => {
    setLive({ idx, mark });
    if (onPreview) onPreview((marks || []).map((m, i) => (i === idx ? mark : m)));
  };

  const move = (e) => {
    const d = dragRef.current;
    if (!d) return;
    e.preventDefault();
    const p = pt(e);
    if (Math.abs(p.x - d.from.x) > TAP || Math.abs(p.y - d.from.y) > TAP) d.moved = true;
    if (d.mode === 'draw') {
      if (shape === 'free') {
        d.pts.push(p);
        setDraft(markFromPath(d.pts, style));
      } else {
        setDraft(markFromDrag(d.from.x, d.from.y, p.x, p.y, shape, style));
      }
      return;
    }
    // ⚠動かしている間は「見た目だけ」動かす(既定では親に知らせない=履歴が埋まる)。
    //   onPreview を渡された時だけ、動かしている間も親に知らせる。
    const o = d.orig;
    if (!o) return;
    if (d.mode === 'move') { preview(d.idx, moveMark(o, p.x - d.from.x, p.y - d.from.y)); return; }
    if (d.mode === 'resize' && (o.shape === 'ellipse' || o.shape === 'rect')) {
      preview(d.idx, { ...o, rx: Math.max(0.008, Math.abs(p.x - o.x)), ry: Math.max(0.008, Math.abs(p.y - o.y)) });
      return;
    }
    if (d.mode === 'tip' && o.shape === 'arrow2') { preview(d.idx, { ...o, x2: p.x, y2: p.y }); return; }
    if (d.mode === 'tail' && o.shape === 'arrow2') { preview(d.idx, { ...o, x: p.x, y: p.y }); return; }
  };

  const finish = (e, cancelled) => {
    const d = dragRef.current;
    dragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* 対応していない端末では何もしない */ }
    setDraft(null); setLive(null);
    if (!d) return;
    // ⚠手のひら誤爆・OSのジェスチャで中断 → 何も残さない
    if (cancelled) return;

    if (d.mode === 'draw') {
      if (!d.moved) {
        // タップ: 印の上なら「選ぶ」。何も無い所なら既定サイズの印を置く(今までの操作感)
        if (d.wasOn >= 0) { setSel(d.wasOn); return; }
        if ((marks || []).length >= max) return;
        // ⚠なぞり書きは点1つでは線にならない → タップでは置かない
        if (shape === 'free') return;
        commit([...(marks || []), markFromDrag(d.from.x, d.from.y, d.from.x, d.from.y, shape, style)]);
        setSel((marks || []).length);
        return;
      }
      if ((marks || []).length >= max) return;
      const p = pt(e);
      const made = shape === 'free' ? markFromPath([...d.pts, p], style) : markFromDrag(d.from.x, d.from.y, p.x, p.y, shape, style);
      if (!made) return;
      commit([...(marks || []), made]);
      setSel((marks || []).length);
      return;
    }
    // 取っ手の操作は、離した時に1回だけ確定
    if (live && live.idx === d.idx) commit((marks || []).map((m, i) => (i === d.idx ? live.mark : m)));
  };

  // 表示用: 動かし中はその印だけ差し替える
  const shown = (marks || []).map((m, i) => (live && live.idx === i ? live.mark : m));
  const sm = sel >= 0 && sel < shown.length ? normalizeMark(shown[sel]) : null;
  const full = (marks || []).length >= max;
  // ⚠⚠ 下の絵にもう描かれている印を、この層でもう一度描かない(二重に見える)。
  //   onPreview が無い時だけは、動かしている1つを出す(でないと動かす間だけ消える)。
  const domMarks = paintedBelow ? (onPreview ? [] : (live ? [live.mark] : [])) : shown;

  // 取っ手の位置(絵の中の割合 → この層の中の%)。⚠層は「絵の範囲」に置いてある。
  const hp = (x, y) => ({ left: `${x * 100}%`, top: `${y * 100}%` });
  const handleStyle = { width: HANDLE_PX, height: HANDLE_PX, marginLeft: -HANDLE_PX / 2, marginTop: -HANDLE_PX / 2, touchAction: 'none' };

  const HINT = {
    ellipse: '囲みたい所を なぞる = その大きさの〇（楕円）',
    rect: '囲みたい所を なぞる = 四角',
    arrow2: 'しっぽ→先へ なぞる = 矢印',
    free: '指でそのまま なぞる = なぞり書き',
    num: 'タップ = ①②③ の番号（手順の順番）',
  };

  return (
    <div
      ref={layerRef}
      className="absolute inset-0"
      // ⚠touchAction:'none' が無いと、指でなぞった時にページがスクロールして描けない。
      //   長押しメニュー(iPadの「動画を保存」)も止める。
      style={{ touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none', cursor: full ? 'not-allowed' : 'crosshair' }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={(e) => finish(e, false)}
      onPointerCancel={(e) => finish(e, true)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 置いてある印。⚠paintedBelow の時は下の絵が描いているので、ここでは描かない */}
      <RecipeMarks marks={domMarks} box={box} selected={paintedBelow ? -1 : sel} />
      {/* いま描いている途中の印(薄く) */}
      {draft && <RecipeMarks marks={[draft]} box={box} dim />}

      {/* 取っ手。⚠指で押せる大きさ(44px)。印が小さくても縮めない */}
      {sm && (
        <div className="absolute" style={{ left: `${box.left * 100}%`, top: `${box.top * 100}%`, width: `${box.width * 100}%`, height: `${box.height * 100}%` }}>
          {sm.shape === 'arrow2' ? (
            <>
              <Handle title="しっぽを動かす" mark="●" pos={hp(sm.x, sm.y)} style={handleStyle} onDown={(e) => grabHandle('tail', e)} />
              <Handle title="先を動かす" mark="➤" pos={hp(sm.x2, sm.y2)} style={handleStyle} onDown={(e) => grabHandle('tip', e)} />
            </>
          ) : sm.shape === 'free' ? (
            <Handle title="動かす" mark="✥" pos={hp(sm.pts[0].x, sm.pts[0].y)} style={handleStyle} onDown={(e) => grabHandle('move', e)} />
          ) : sm.shape === 'num' ? (
            <Handle title="動かす" mark="✥" pos={hp(sm.x, sm.y)} style={handleStyle} onDown={(e) => grabHandle('move', e)} />
          ) : (
            <>
              <Handle title="動かす" mark="✥" pos={hp(sm.x, sm.y)} style={handleStyle} onDown={(e) => grabHandle('move', e)} />
              <Handle title="大きさを変える" mark="⤡" pos={hp(sm.x + sm.rx, sm.y + sm.ry)} style={handleStyle} onDown={(e) => grabHandle('resize', e)} />
            </>
          )}
        </div>
      )}

      {hint && (
        <div className="absolute inset-x-0 top-0 flex justify-center pointer-events-none">
          <span className="mt-1 rounded-full bg-black/70 text-white fi-tap-text font-bold px-3 py-1">
            {full ? `印は${max}個までです（消してから足してください）` : `${HINT[shape] || HINT.ellipse}。印をタップすると取っ手が出ます`}
          </span>
        </div>
      )}
    </div>
  );
};

const Handle = ({ mark, pos, style, onDown, title }) => (
  <button
    type="button" title={title} aria-label={title}
    onPointerDown={onDown}
    className="absolute rounded-full bg-white/95 border-2 border-rose-500 text-rose-600 font-black flex items-center justify-center shadow"
    style={{ ...pos, ...style, fontSize: 16, lineHeight: 1 }}
  >{mark}</button>
);

/** 印の一覧(ひとこと・大きさ・削除)。編集画面の下に置く。 */
export const MarkList = ({ marks = [], onChange, onSelect = null, selected = -1 }) => {
  if (!(marks || []).length) return null;
  const scale = (i, k) => onChange(marks.map((mm, j) => {
    if (j !== i) return mm;
    const n = normalizeMark(mm);
    if (n.shape !== 'ellipse' && n.shape !== 'rect') return n;
    return { ...n, rx: Math.min(0.5, Math.max(0.01, n.rx * k)), ry: Math.min(0.5, Math.max(0.01, n.ry * k)) };
  }));
  const ICON = { arrow2: '↗', free: '✎', num: '①', rect: '▭', ellipse: '⬭' };
  return (
    <div className="space-y-1">
      {marks.map((m, i) => {
        const n = normalizeMark(m) || {};
        return (
          <div key={i} data-mark-row="1" className={`flex items-center gap-1 rounded-lg border px-1.5 py-1 ${i === selected ? 'border-rose-400 bg-rose-50' : 'border-slate-200 bg-white'}`}
            onClick={() => onSelect && onSelect(i)}>
            <span className="text-sm shrink-0 w-5 text-center" style={{ color: (MARK_COLORS[n.color] || MARK_COLORS.red).hex }}>{ICON[n.shape] || '⬭'}</span>
            <input
              value={n.text || ''}
              onChange={(e) => onChange(marks.map((mm, j) => (j === i ? { ...normalizeMark(mm), text: e.target.value.slice(0, 24) } : mm)))}
              placeholder="この印のひと言(任意)"
              className="flex-1 min-w-0 border border-slate-200 rounded px-1.5 py-1 text-[12px]"
            />
            {(n.shape === 'ellipse' || n.shape === 'rect') && (
              <>
                <button onClick={(e) => { e.stopPropagation(); scale(i, 1.25); }} className="px-2 py-1 min-h-[32px] bg-slate-100 rounded font-bold shrink-0 text-xs" title="大きく">＋</button>
                <button onClick={(e) => { e.stopPropagation(); scale(i, 0.8); }} className="px-2 py-1 min-h-[32px] bg-slate-100 rounded font-bold shrink-0 text-xs" title="小さく">−</button>
              </>
            )}
            <button data-mark-del="1" onClick={(e) => { e.stopPropagation(); onChange(marks.filter((_, j) => j !== i)); }}
              className="px-2 py-1 min-h-[32px] bg-rose-100 text-rose-600 rounded font-bold shrink-0 text-xs" title="この印を消す">✕</button>
          </div>
        );
      })}
    </div>
  );
};

/** 形の選び方。⚠指で押せる大きさにする。 */
export const ShapePicker = ({ shape, onChange }) => (
  <div className="grid grid-cols-5 gap-1">
    {[['ellipse', '⬭', '〇で囲む'], ['rect', '▭', '四角で囲む'], ['arrow2', '↗', '矢印で指す'], ['free', '✎', 'なぞり書き'], ['num', '①', '番号']].map(([v, icon, label]) => (
      <button key={v} type="button" onClick={() => onChange(v)} title={label}
        className={`py-2 min-h-[44px] rounded-lg fi-tap-text font-bold border-2 leading-tight ${shape === v ? 'bg-rose-600 text-white border-rose-600' : 'bg-white text-slate-600 border-slate-300'}`}>
        <span className="block text-base">{icon}</span>{label}
      </button>
    ))}
  </div>
);

/** 色の選び方。⚠赤だけだと、赤い機械やケーブルの上で印が沈んで見えない。 */
export const ColorPicker = ({ color, onChange }) => (
  <div className="grid grid-cols-5 gap-1">
    {Object.entries(MARK_COLORS).map(([v, c]) => (
      <button key={v} type="button" onClick={() => onChange(v)} title={c.label}
        className={`py-2 min-h-[40px] rounded-lg border-2 fi-tap-text font-bold ${color === v ? 'border-slate-900' : 'border-slate-200'}`}
        style={{ background: c.hex, color: (v === 'white' || v === 'yellow') ? '#111' : '#fff' }}>{c.label}</button>
    ))}
  </div>
);

/** 線の太さ。⚠小さい画面で見るので、細いと消える。 */
export const WidthPicker = ({ width, onChange }) => (
  <div className="grid grid-cols-3 gap-1">
    {Object.keys(MARK_WIDTHS).map(v => (
      <button key={v} type="button" onClick={() => onChange(v)}
        className={`py-2 min-h-[40px] rounded-lg fi-tap-text font-bold ${width === v ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'}`}>
        {v === 's' ? '細い' : v === 'm' ? 'ふつう' : '太い'}
      </button>
    ))}
  </div>
);

export default MarkCanvas;
