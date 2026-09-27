// ============================================================================
// ⭕ 動画に重ねる「印」— 〇/□/矢印/なぞり書き/番号・色つき。**この1つを全部の画面で使う**
// ----------------------------------------------------------------------------
// ⚠⚠ 2アプリ(製品検査/最終検査) × 2画面(レシピ編集スタジオ/小窓プレイヤー) で
//   同じ描画を4回書くと、**必ず片方だけ直る事故**になる(過去に実害あり。
//   domain/videoRecipe.js の冒頭に同じ理由で判定を純関数化した経緯が書いてある)。
//   → 描画も1つにまとめる。直す時はここだけ。
//
// ⚠⚠ 座標のズレについて:
//   印は「**映像の絵に対する割合(0-1)**」で持っている。
//   ところが <video> を object-contain で置くと、縦横比が違うぶん **黒帯** が入り、
//   「要素の中の%」と「絵の中の%」がズレる(小窓は w-full aspect-video なので必ず起きる)。
//   → videoBox() で絵の実際の範囲を出し、その中に印を置く。
//
// 清水さん(2026-08-13)「〇が小さすぎて使えない。場所によって大きさや形(楕円)が変わる」
//                     「市場比較は一番重要。必要な機能は全部入れて」
// ⚠色は選べるようになった。**白い印には必ず暗いふちを付ける**(白い壁の上で消えるため)。
// ============================================================================

import React from 'react';
import { normalizeMark, markBox } from './domain/videoMarks.js';
// ⚠計算は domain/videoBox.js にある(node --test で確かめられるように分けてある)。写さない。
//   ⚠ここから re-export しない(この部品ファイルはコンポーネントだけを出す)。
//   使う側は './domain/videoBox.js' から直接 import すること。

/** どの色でも見えるように、線の下に敷く影。 */
const SHADOW = 'drop-shadow(0 0 2px rgba(0,0,0,.75))';

/**
 * 印を重ねて描く。
 * @param marks     印の配列(古い形もそのまま渡してよい)
 * @param box       videoBox() の結果。省略時は要素いっぱい
 * @param onGrab    (index, ev) => void  つかんだ時(編集画面のみ)
 * @param selected  選んでいる印の番号(取っ手を出す)
 * @param dim       true = 薄く出す(下書き)
 */
export const RecipeMarks = ({ marks = [], box = null, onGrab = null, selected = -1, dim = false }) => {
  const bx = box || { left: 0, top: 0, width: 1, height: 1 };
  const list = (marks || []).map(normalizeMark).filter(Boolean);
  if (!list.length) return null;
  // 絵の範囲の中に置く入れ物。ここを基準にすれば黒帯があっても合う。
  return (
    <div
      className="absolute pointer-events-none"
      style={{
        left: `${bx.left * 100}%`, top: `${bx.top * 100}%`,
        width: `${bx.width * 100}%`, height: `${bx.height * 100}%`,
        opacity: dim ? 0.55 : 1,
      }}
    >
      {list.map((m, i) => {
        const b = markBox(m);
        if (!b) return null;
        const on = i === selected;
        const col = b.color;
        const sw = b.strokeW === 's' ? 3 : b.strokeW === 'l' ? 7 : 4;   // ⚠b.width は「枠の幅(%)」。太さは strokeW
        const grab = onGrab ? { onPointerDown: (e) => { e.stopPropagation(); onGrab(i, e); }, style: { pointerEvents: 'auto', cursor: 'move' } } : {};
        const pos = { left: `${b.left}%`, top: `${b.top}%`, width: `${b.width}%`, height: `${b.height}%` };

        if (b.shape === 'arrow2') {
          return (
            <span key={i} className="absolute" style={{ ...pos, overflow: 'visible' }}>
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 w-full h-full overflow-visible" style={{ filter: SHADOW }} {...grab}>
                {/* ⚠矢じりだけは縦横に潰れないよう、線とは別に描く */}
                <line x1={b.lx1} y1={b.ly1} x2={b.lx2} y2={b.ly2} stroke={col} strokeWidth={on ? sw + 1 : sw} vectorEffect="non-scaling-stroke" strokeLinecap="round" />
              </svg>
              <span className="absolute" style={{ left: `${b.lx2}%`, top: `${b.ly2}%`, transform: 'translate(-50%,-50%)' }}>
                <span className="block rounded-full" style={{ width: 14, height: 14, background: col, boxShadow: '0 0 0 2px rgba(0,0,0,.6)' }} />
              </span>
              {b.text ? <Label text={b.text} color={col} /> : null}
            </span>
          );
        }
        if (b.shape === 'free') {
          return (
            <span key={i} className="absolute" style={{ ...pos, overflow: 'visible' }}>
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 w-full h-full overflow-visible" style={{ filter: SHADOW }} {...grab}>
                <polyline points={b.poly} fill="none" stroke={col} strokeWidth={on ? sw + 1 : sw} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {b.text ? <Label text={b.text} color={col} /> : null}
            </span>
          );
        }
        if (b.shape === 'num') {
          return (
            <span key={i} className="absolute flex items-center justify-center rounded-full font-black" style={{
              ...pos, background: col, color: (col === '#ffffff' || col === '#ffd400') ? '#111' : '#fff',
              boxShadow: `0 0 0 ${on ? 3 : 2}px rgba(0,0,0,.55)`, fontSize: 'clamp(11px, 2.4vw, 22px)',
            }} {...grab}>
              {b.num}
              {b.text ? <Label text={b.text} color={col} /> : null}
            </span>
          );
        }
        return (
          <span key={i} className="absolute" style={pos} {...grab}>
            <span className={`block w-full h-full ${b.shape === 'rect' ? 'rounded-sm' : 'rounded-[50%]'}`}
              style={{ border: `${on ? sw + 1 : sw}px solid ${col}`, filter: SHADOW }} />
            {b.text ? <Label text={b.text} color={col} /> : null}
          </span>
        );
      })}
    </div>
  );
};

const Label = ({ text, color }) => (
  <span
    className="absolute whitespace-nowrap font-bold rounded px-1.5 py-0.5 shadow pointer-events-none"
    style={{
      left: '50%', top: '100%', transform: 'translate(-50%, 4px)',
      background: 'rgba(0,0,0,.78)', color: color || '#fff', fontSize: 'clamp(10px, 1.6vw, 15px)',
    }}
  >{text}</span>
);

export default RecipeMarks;
