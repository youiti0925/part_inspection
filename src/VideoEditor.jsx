// ============================================================================
// 🎬 編集室 — 市場の動画編集道具に合わせた、1画面で全部できる編集
// ----------------------------------------------------------------------------
// 清水さん(2026-08-13)
//   「市場比較は一番重要。時間かけて編集する上で必要な機能は全部入れて」
//
// ⚠⚠ いままで無くて、市場の道具には例外なくある物 = ここで入れた物:
//   ① **時間の帯(タイムライン)に小さい絵と音の波形**。無いと「再生して探す」しかない
//   ② **端をつまんで前後を詰める**(トリム)。ボタン2回押しの区間指定ではやり直せない
//   ③ **コマ送り**。1コマ単位で合わせられないと切り所が決まらない
//   ④ **速さを動画に焼く**(早送り・スロー)。見る側の操作に頼らない
//   ⑤ **テロップ(字幕)**。現場は騒音でイヤホン無し = 音の説明は届かない
//   ⑥ **モザイク/目隠し**。顔・他社名が映ると外に出せない
//   ⑦ **スポットライト**。「ここを見て」が一番強く伝わる
//   ⑧ **回転・切り抜き・寄り(ズーム)**
//   ⑨ **やり直し(元に戻す/やり直す)**
//   ⑩ **編集中の見た目 = 出来上がり**(同じ描画の道を通す)
//
// ⚠⚠ プレビューは <video> を直接見せず、**書き出しと同じ paintFrame/drawOverlays を
//   通した <canvas>** を見せる。ここを別々に作ると「編集画面では出ていたのに
//   書き出したら消えている」が必ず起きる。
//
// ⚠現場はタブレット(指)。押す物は最低40px、なぞる所は touchAction:'none'。
// ============================================================================

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  projectFromSources, projectOutSec, timelineOf, outToSrc, splitAt,
  deleteClip, moveClip, patchClip, trimClip, insertImageAt, addOverlay, patchOverlay,
  removeOverlay, overlaysAt, normCrop, silenceRanges, cutSrcRanges, chapterSegments, insertFreezeAt,
  zoomAt, normSpeed, SPEEDS, mkId, setClipDuration,
} from './domain/videoProject.js';
import { paintFrame, drawOverlays, TEXT_COLORS, TEXT_SIZES, MOSAIC_CELLS } from './domain/videoOverlay.js';
import { normalizeMark } from './domain/videoMarks.js';
// 📋 編集メモ = 「何秒に何を作ったか」の1本の並び。
// ⚠⚠ これが無い間、作った物が並ぶ場所がどこにも無かった(2026-08-15 清水さん)。
// ▶ 要点だけ見る(keyMoments 以下)は、その並びから「止まる所」だけを取り出して使う。
import {
  editHistory, noNameCount,
  keyMoments, nextMoment, speedAt, normSkipSpeed, momentIndexAt, crossedMoment, SKIP_SPEEDS,
} from './domain/editHistory.js';
import { toPicture } from './domain/videoBox.js';
import { MarkCanvas, MarkList, ShapePicker, ColorPicker, WidthPicker } from './MarkCanvas.jsx';
import { thumbStrip, waveformPeaks } from './videoFrames.js';
// 📄 動画の要点 → 作業標準(Excel / 紙)。
// ⚠中身の組み立ては domain 側(試験あり)。ここでは表を組み直さない。
import { FIELDS as WS_FIELDS, buildWorkStandard, missingNote as wsMissingNote } from './domain/workStandardDoc.js';
import { PER_PAGE as WS_PER_PAGE, PER_PAGE_DEFAULT as WS_PER_PAGE_DEFAULT } from './domain/workStandardPrint.js';
import { buildShots as wsBuildShots, printWorkStandard, exportWorkStandardXlsx } from './workStandardExport.js';
// 📚 作った作業標準を、そのまま「検査中にも開ける資料の棚」へ入れる
import { buildLibraryEntry as wsBuildEntry, rebuildCheck as wsRebuildCheck, entryTooBig as wsTooBig, entryBytes as wsBytes } from './domain/workStandardLibrary.js';
import { grabStill } from './videoExport.js';
import { saveDraft } from './videoDraft.js';
// 🤖 音声から字幕の下書きを作る。⚠作るのは下書きだけ。**消すのは人**(下のコメント参照)
import { transcribeVideo } from './videoTranscribe.js';
import { segmentsToOverlays, tidySegments } from './domain/subtitles.js';
import { fmtDur } from './domain/videoPlan.js';
// 🔎 動画の中を言葉で探す。⚠材料は「もう手で書いてある文字」が主(喋る前提で作らない)。
import { collectWords, searchWords, kindLabel, capWordsForDoc, wordsMap, WORD_KINDS } from './domain/videoWords.js';
// 🎙 あとから声を入れる(アフレコ)。⚠⚠ 録った声は **動画に焼き込まない**(出口は文字)。
import { voiceSupport, takeToNotes, notesToSegments, MAX_TAKE_SEC } from './domain/voiceOver.js';

// 🖼 **画面に出す絵そのものの細かさ**(canvas の中身を何px幅で作るか)。
// ⚠⚠ これは「絵の大きさ」ではない。大きさは下の 枠に合わせて伸ばす所(previewFit)で決まる。
//   ここは **にじみ** を決める。作った絵より大きく映すと、そのぶん だけ ぼやける。
// 実測(2026-08-16 1400×1000の画面): プレビューの枠は 1044×720px。
//   720px幅で作った絵を 1044px幅で映していた = 1.45倍に引き伸ばし = にじむ。
//   → 1080px幅で作れば、枠(1044px)を上回るので **引き伸ばし無し**。
// ⚠1枚あたりの画素は増える: 720×405=291,600px → 1080×608=656,640px = **2.25倍**。
//   タブレットで再生がカクつかないよう、拡大時の上限は下(PREVIEW_ZOOM_MAX)で抑える。
const PREVIEW_MAX_W = 1080;
// 🔍 拡大して見ている間、絵を作り直す倍率の上限。
// ⚠⚠ ここを下げたのは「細かさを落とす為」ではない。**1枚あたりの画素の総量**を抑える為。
//   直す前: 720×2.0 = 1440px幅 (1440×810 = 1,166,400px) が最大だった。
//   直した後: 1080×1.5 = 1620px幅 (1620×911 = 1,475,820px) = 直す前の最大の **1.27倍**。
//   → どの拡大率でも 直す前より細かい(1440→1620)のに、最大の画素は 1.27倍で済む。
//     (1080×2.0 = 2160px幅にすると 2,624,400px = 2.25倍になり、タブレットで危ない)
const PREVIEW_ZOOM_MAX = 1.5;
// 🔍 **見るための拡大** の段。⚠これは画面の見え方だけ。書き出す動画には一切効かない。
//   ⚠⚠ 部品の zoom(「寄り」)とは別物。あちらは動画に焼き込まれる。混ぜると
//     「画面で大きくして見ただけなのに、書き出した動画が寄っていた」という事故になる。
const VIEW_ZOOMS = [1, 1.5, 2, 3, 4];
// ⏸止め絵 / 🖼画像 を何秒出すか。⚠短すぎる値は作らない(0.5秒では読めない)。
const HOLD_SECS = [1, 2, 3, 4, 5, 6, 8, 10];
const IMAGE_SECS = [2, 3, 4, 5, 6, 8, 10, 15, 20];
// 👁 見せ方(動画には焼き込まない指示)。⚠上の HOLD_SECS(=止め絵を何秒焼くか)とは別物。
//   ⚠言葉は video_recipes の画面と1つに揃える(⏸=止めて見せる / ⏭=とばす / ⚡=区間倍速)。
const SHOW_META = {
  pause: { icon: '⏸', label: '止めて見せる', c: '#b45309' },
  skip: { icon: '⏭', label: 'とばす', c: '#475569' },
  speed: { icon: '⚡', label: '区間倍速', c: '#0369a1' },
};
const SHOW_SPEEDS = [1.5, 2, 3, 4];        // ⚡ここから速く
const SHOW_HOLDS = [0, 2, 3, 5, 8];        // ⏸のあと、何秒で自動的に続きへ行くか(0=押すまで待つ)
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
/** 帯の部品に出す「何秒か」。⚠ここは m:ss ではなく「3秒」と出す(現場の言い方)。 */
const fmtSec = (s) => `${Math.round((Number(s) || 0) * 10) / 10}秒`;
const fmtT = (s) => {
  const x = Math.max(0, Number(s) || 0);
  const m = Math.floor(x / 60), sec = Math.floor(x % 60), f = Math.floor((x % 1) * 100);
  return `${m}:${String(sec).padStart(2, '0')}.${String(f).padStart(2, '0')}`;
};

// ---------------------------------------------------------------------------
// 帯(タイムライン)
// ---------------------------------------------------------------------------
/**
 * ⚠ここが編集の中心。押せる/なぞれる物が多いので、当たり判定を層で分ける:
 *   下 = 帯そのもの(タップでその時刻へ) / 上 = 部品の境目・重ねのチップ
 */
const Timeline = ({
  project, tOut, onSeek, thumbs, waves, sel, onSelect, onTrim, onMoveOverlay, zoomX, srcDur,
}) => {
  const total = Math.max(0.001, projectOutSec(project));
  const rows = timelineOf(project);
  const barRef = useRef(null);
  const dragRef = useRef(null);

  const pos = (e) => {
    const el = barRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1) * total;
  };

  const down = (e) => {
    if (!e.isPrimary) return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* noop */ }
    dragRef.current = { mode: 'seek' };
    onSeek(pos(e));
  };
  const move = (e) => {
    const d = dragRef.current;
    if (!d) return;
    e.preventDefault();
    if (d.mode === 'seek') { onSeek(pos(e)); return; }
    if (d.mode === 'trim') { onTrim(d.index, d.side, pos(e)); return; }
    if (d.mode === 'ov') { onMoveOverlay(d.id, pos(e) - d.grab); return; }
  };
  const up = (e) => {
    dragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* noop */ }
  };

  const pct = (t) => `${(t / total) * 100}%`;
  const ovs = project.overlays || [];
  const OV_ICON = { mark: '⭕', text: '💬', mosaic: '▩', spot: '🔦' };
  const OV_COLOR = { mark: 'bg-rose-500', text: 'bg-sky-600', mosaic: 'bg-slate-600', spot: 'bg-amber-500' };

  return (
    <div className="select-none" style={{ touchAction: 'none' }}>
      {/* 目盛り */}
      {/* ⚠目盛りにも帯と同じ幅を付ける。付けないと「🔍＋」で広げた時に秒の位置だけズレる */}
      {/* ⚠文字を1段大きくする度に、箱の高さも1段上げる(9px→11px→12px / h-4→h-5→h-6)。
             上げないと数字の下が箱からはみ出て **黙って切れる**。
         ⚠⚠ 12px にした理由(2026-08-16 清水さん)= 「読んで判断する数字は12px以上」。
             目盛りの秒は「いま帯のどこを見ているか」を読む数字なので、例外にしない。
             ⚠text-2xs は line-height を持たない(index.css)が text-xs は 1.333em を持つ。
               11px(行 約13px) → 12px(行 16px)。箱 h-6=24px なので入る(実測して確かめた)。 */}
      <div className="relative h-6 text-xs text-slate-400" style={{ minWidth: `${100 * zoomX}%` }}>
        {Array.from({ length: Math.min(12, Math.max(2, Math.ceil(total / Math.max(1, Math.round(total / 8))))) }, (_, i) => {
          const step = total / 8;
          const t = i * step;
          if (t > total) return null;
          // ⚠⚠ 数字は真ん中合わせなので、**一番左と一番右だけ箱の外へ半分出て黙って切れる**。
          //   親が overflow-x-auto なので、切れても何も言わずに消えるだけ。
          //   文字を大きくすると切れ方がひどくなるので、両端だけ内側へ寄せる。
          const atLeft = i === 0;
          const atRight = t >= total - 0.001;
          if (atLeft) return <span key={i} className="absolute left-0">{fmtDur(t)}</span>;
          if (atRight) return <span key={i} className="absolute right-0">{fmtDur(t)}</span>;
          return <span key={i} className="absolute -translate-x-1/2" style={{ left: pct(t) }}>{fmtDur(t)}</span>;
        })}
      </div>
      <div
        ref={barRef}
        className="relative bg-slate-900 rounded-lg overflow-hidden cursor-pointer"
        style={{ height: 76, minWidth: `${100 * zoomX}%` }}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      >
        {/* 部品ごとの帯 */}
        {rows.map((r) => {
          const left = (r.outStart / total) * 100;
          const w = Math.max(0.4, (r.outSec / total) * 100);
          const th = r.type === 'video' ? (thumbs[r.srcId] || []) : [];
          const selected = sel?.type === 'clip' && sel.index === r.index;
          return (
            <div key={r.id} className={`absolute inset-y-0 overflow-hidden border-r-2 ${selected ? 'border-amber-300' : 'border-slate-700'}`}
              style={{ left: `${left}%`, width: `${w}%` }}
              onPointerDown={(e) => { e.stopPropagation(); onSelect({ type: 'clip', index: r.index }); onSeek(pos(e)); dragRef.current = { mode: 'seek' }; try { barRef.current.setPointerCapture(e.pointerId); } catch { /* noop */ } }}>
              {r.type === 'image' || r.type === 'freeze' ? (
                /* ⚠「何秒出しているか」は帯を見ただけで分かるようにする(清水さん 2026-08-14)。
                   一覧を開かないと分からないと、結局 全部開いて確かめる事になる。 */
                <div className={`w-full h-full flex flex-col items-center justify-center text-center text-xs font-bold leading-tight ${r.type === 'freeze' ? 'bg-slate-700/80 text-slate-100' : 'bg-violet-800/70 text-violet-100'}`}>
                  <span className="truncate max-w-full">{r.type === 'freeze' ? '⏸ 止め絵' : '🖼 画像'}</span>
                  <span className="truncate max-w-full opacity-90">{fmtSec(r.outSec)}</span>
                </div>
              ) : (
                <>
                  {/* 小さい絵。⚠この部品が使っている範囲だけを切って並べる */}
                  <div className="absolute inset-x-0 top-0 h-[46px] flex">
                    {th.length === 0
                      ? <div className="w-full h-full bg-slate-700/60" />
                      // ⚠⚠ Array.from の第2引数(map)は **(値, 番号) の2つしか受け取らない**。
                      //   3つ目に配列が来ると思って arr.length を読むと undefined で落ちる
                      //   (実測 2026-08-13: 編集室が開いた瞬間に白画面になった)。枚数は先に出す。
                      : (() => {
                        const n = Math.max(1, Math.round(w / 3));
                        return Array.from({ length: n }, (_, i) => {
                          const at = r.start + (r.end - r.start) * ((i + 0.5) / n);
                          let best = th[0];
                          for (const x of th) if (Math.abs(x.t - at) < Math.abs(best.t - at)) best = x;
                          return <img key={i} src={best.url} alt="" className="h-full flex-1 min-w-0 object-cover opacity-90" draggable={false} />;
                        });
                      })()}
                  </div>
                  {/* 音の波形 */}
                  <div className="absolute inset-x-0 bottom-0 h-[30px] flex items-end gap-px px-px">
                    {(() => {
                      const pk = waves[r.srcId] || [];
                      if (!pk.length || !(srcDur[r.srcId] > 0)) return null;
                      const n = Math.max(4, Math.round(w * 2));
                      return Array.from({ length: n }, (_, i) => {
                        const at = r.start + (r.end - r.start) * ((i + 0.5) / n);
                        const idx = clamp(Math.floor((at / srcDur[r.srcId]) * pk.length), 0, pk.length - 1);
                        return <span key={i} className="flex-1 bg-emerald-400/70 rounded-t" style={{ height: `${Math.max(4, pk[idx] * 100)}%` }} />;
                      });
                    })()}
                  </div>
                  {normSpeed(r.speed) !== 1 && (
                    <span className="absolute left-0.5 top-0.5 bg-amber-400 text-slate-900 text-4xs font-black rounded px-1">{normSpeed(r.speed)}×</span>
                  )}
                  {r.mute && <span className="absolute right-0.5 top-0.5 text-3xs">🔇</span>}
                </>
              )}
              {/* 端をつまんで詰める(トリム)。⚠指で押せる幅 */}
              {r.type === 'video' && (
                <>
                  <span className="absolute left-0 inset-y-0 w-3 bg-amber-300/0 hover:bg-amber-300/40"
                    style={{ touchAction: 'none', cursor: 'ew-resize' }}
                    onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); onSelect({ type: 'clip', index: r.index }); dragRef.current = { mode: 'trim', index: r.index, side: 'start' }; try { barRef.current.setPointerCapture(e.pointerId); } catch { /* noop */ } }} />
                  <span className="absolute right-0 inset-y-0 w-3 bg-amber-300/0 hover:bg-amber-300/40"
                    style={{ touchAction: 'none', cursor: 'ew-resize' }}
                    onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); onSelect({ type: 'clip', index: r.index }); dragRef.current = { mode: 'trim', index: r.index, side: 'end' }; try { barRef.current.setPointerCapture(e.pointerId); } catch { /* noop */ } }} />
                </>
              )}
            </div>
          );
        })}
        {/* いまの位置 */}
        <span className="absolute inset-y-0 w-0.5 bg-rose-500 pointer-events-none z-20" style={{ left: pct(tOut) }} />
        <span className="absolute -top-0.5 w-3 h-3 -translate-x-1/2 rounded-full bg-rose-500 pointer-events-none z-20" style={{ left: pct(tOut) }} />
      </div>
      {/* 重ねの段。
          ⚠⚠ 中のボタンを 11px→12px(行 16px) に上げたので、段の高さも上げる。
          ⚠⚠ 高さは **px 直書き(height:26)をやめて h-7 に**した。px 直書きだと
             文字サイズを160%にした時に **文字だけ 25.6px に伸びて段は 26px のまま** で、
             上下が黙って切れていた(実測)。h-7 は rem なので文字と一緒に伸びる。
             100%: 箱28px / 中のボタン24px / 行16px、160%: 箱44.8px / ボタン38.4px / 行25.6px。
             ⚠h-8 でも入るが、この段は **絵の下** なので伸ばした分だけ絵が縮む。
               入る一番小さい段(h-7)にする。100%で +2px しか食わない。
          ⚠⚠ JSXコメントは `cond && (` の直後に置けない(構文エラー＝白画面)。ここに書く。 */}
      {ovs.length > 0 && (
        <div className="relative mt-1 h-7 rounded bg-slate-100" style={{ minWidth: `${100 * zoomX}%` }}>
          {ovs.map(o => {
            const left = (o.from / total) * 100;
            const w = Math.max(1.5, ((o.to - o.from) / total) * 100);
            const selected = sel?.type === 'overlay' && sel.id === o.id;
            return (
              <button key={o.id} type="button"
                className={`absolute top-0.5 bottom-0.5 rounded text-xs text-white font-bold px-1 truncate ${OV_COLOR[o.kind]} ${selected ? 'ring-2 ring-slate-900' : ''}`}
                style={{ left: `${left}%`, width: `${w}%`, touchAction: 'none' }}
                onPointerDown={(e) => {
                  e.stopPropagation(); e.preventDefault();
                  onSelect({ type: 'overlay', id: o.id });
                  const el = barRef.current;
                  const r = el.getBoundingClientRect();
                  const at = clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1) * total;
                  dragRef.current = { mode: 'ov', id: o.id, grab: at - o.from };
                  try { el.setPointerCapture(e.pointerId); } catch { /* noop */ }
                }}
                /* ⚠ここに onPointerMove / onPointerUp を書いても **一生発火しない**。
                   下の barRef に setPointerCapture しているので、以後の指の動きは親が受け取る。
                   同じ処理が2か所にあると、片方だけ直す事故になる。動かすのは親(:88)。 */
              >{OV_ICON[o.kind]}{o.kind === 'text' ? ` ${String(o.text || '').slice(0, 8)}` : ''}</button>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 絵の上で四角をなぞる(モザイク・スポットライト・切り抜き)
// ---------------------------------------------------------------------------
const RectPicker = ({ targetRef, rect, onChange, label }) => {
  const ref = useRef(null);
  const dragRef = useRef(null);
  const [draft, setDraft] = useState(null);
  const pt = (e) => toPicture(targetRef?.current || ref.current, e.clientX, e.clientY);
  const down = (e) => {
    if (!e.isPrimary) return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* noop */ }
    const p = pt(e);
    dragRef.current = { from: p };
    setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
  };
  const move = (e) => {
    const d = dragRef.current;
    if (!d) return;
    e.preventDefault();
    const p = pt(e);
    setDraft({ x: Math.min(d.from.x, p.x), y: Math.min(d.from.y, p.y), w: Math.abs(p.x - d.from.x), h: Math.abs(p.y - d.from.y) });
  };
  const up = (e, cancelled) => {
    const d = dragRef.current;
    dragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    const dr = draft;
    setDraft(null);
    if (!d || cancelled || !dr) return;
    if (dr.w < 0.03 || dr.h < 0.03) return;   // ⚠つまみそこねの点は作らない
    onChange(normCrop(dr) || dr);
  };
  const show = draft || rect;
  return (
    <div ref={ref} className="absolute inset-0" style={{ touchAction: 'none', cursor: 'crosshair' }}
      onPointerDown={down} onPointerMove={move} onPointerUp={(e) => up(e, false)} onPointerCancel={(e) => up(e, true)}>
      {show && (
        <span className="absolute border-2 border-amber-300 bg-amber-300/10"
          style={{ left: `${show.x * 100}%`, top: `${show.y * 100}%`, width: `${show.w * 100}%`, height: `${show.h * 100}%` }} />
      )}
      <div className="absolute inset-x-0 top-0 flex justify-center pointer-events-none">
        <span className="mt-1 rounded-full bg-black/70 text-white text-2xs font-bold px-3 py-1">{label}</span>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 🔎 動画の中を言葉で探す
// ---------------------------------------------------------------------------
/**
 * 打った言葉で、動画の中の要点を探す。押すとその秒から再生する。
 *
 * ⚠⚠ この機能の前提は一度ひっくり返っている(domain/videoWords.js の頭を読むこと)。
 *   本番を数えたら **手本動画に字幕も章も1件も入っていなかった**。
 *   だから「AIが聞き取った字幕を探す」ではなく、**手で書いた急所・作業手順・章の名前**が主役。
 *
 * ⚠⚠ AIが聞き取った物は **必ず「AIが聞き取った言葉」と分かる形**で出す。
 *   根拠は映像。押したらその秒へ飛ぶ(文だけを信じさせない)。
 *
 * ⚠この部品は 編集室 と 見る画面(App側) の両方から使える形にしてある。
 *   使う側は words と onJump だけ渡せばよい。
 *
 * @param words   collectWords(...) / wordsFromMap(...) の結果
 * @param onJump  (atOut) => void   その秒から再生する
 * @param note    容量で切った時の一言(空なら出さない)
 */
export const VideoWordFinder = ({ words = [], onJump, note = '', autoFocus = false, compact = false }) => {
  const [q, setQ] = useState('');
  const [withAi, setWithAi] = useState(true);
  const nonAi = useMemo(() => WORD_KINDS.map(k => k.key).filter(k => k !== 'ai'), []);
  const aiCount = useMemo(() => words.filter(w => w.kind === 'ai').length, [words]);
  const hits = useMemo(
    () => searchWords(words, q, withAi ? {} : { kinds: nonAi }),
    [words, q, withAi, nonAi],
  );
  const typed = q.trim().length > 0;
  return (
    <div className="space-y-1.5" data-find-root="1">
      <div className="text-2xs text-slate-500">
        探したい言葉を打つと、当てはまる要点が出ます。<b>押すとその場面から再生</b>します。
        30分の動画を頭から見なくてすみます。
      </div>
      <input
        type="search" value={q} autoFocus={autoFocus} data-find-input="1"
        onChange={(e) => setQ(e.target.value)}
        placeholder="例: ノギスの当て方 / 締め付け / 銘板"
        className="w-full border-2 border-slate-300 rounded-lg px-3 py-2.5 min-h-[44px] text-sm"
      />
      {/* ⚠AIの聞き取りは間違える。外して見られるようにしておく。 */}
      {aiCount > 0 && (
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" checked={withAi} onChange={(e) => setWithAi(e.target.checked)} className="w-4 h-4" data-find-ai="1" />
          AIが聞き取った言葉も探す（{aiCount}件・聞き間違いがあります）
        </label>
      )}
      {note ? <div className="text-3xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-1.5" data-find-note="1">{note}</div> : null}
      <div className={`${compact ? 'max-h-52' : 'max-h-72'} overflow-y-auto space-y-1`} data-find-hits="1">
        {!typed && (
          <div className="text-2xs text-slate-400">
            探せる言葉 {words.length}件
            {words.length === 0 ? '（⏸止め絵に「急所」を書く・📍章に名前を付けると、ここから探せるようになります）' : ''}
          </div>
        )}
        {typed && !hits.length && (
          <div className="text-2xs text-slate-500" data-find-empty="1">
            見つかりませんでした。別の言い方でも試してください（この機能は書いてある言葉をそのまま探します）。
          </div>
        )}
        {hits.map(h => (
          <button key={h.id} data-find-hit="1" onClick={() => onJump && onJump(h.atOut)}
            className="w-full text-left flex gap-1.5 items-start rounded-lg border border-slate-200 hover:border-sky-400 bg-white px-2 py-2 min-h-[44px]">
            <span className="shrink-0 font-bold text-sky-700 tabular-nums text-xs pt-0.5">{fmtDur(h.atOut)}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-xs text-slate-800 break-words">{h.text}</span>
              {/* ⚠⚠ 何から出てきた言葉かを必ず出す。AIの聞き取りをここで隠すと、
                     間違った文を人が「動画にそう書いてある」と信じてしまう。 */}
              <span className={`block text-3xs ${h.kind === 'ai' ? 'text-amber-700 font-bold' : 'text-slate-400'}`}>
                {h.kind === 'ai' ? '🤖 ' : ''}{kindLabel(h.kind)}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
};

/**
 * ▶ 要点だけ見る の **設定**（要点以外の速さ・次の要点・但し書き）。
 * ----------------------------------------------------------------------------
 * ⚠⚠ 入切と「▶ 続き」は **操作** なので、絵のすぐ下(左列)に残してある。
 *   ここに在るのは設定だけ。置き場所は「👁 見せ方」タブ。
 * ⚠⚠ 見せ方タブが出ない時(端末の動画を編集している時)は、設定の行き場が無くなるので
 *   左列にそのまま出す。部品は **1つだけ** 作って、色だけ差し替える。
 * @param tone 'dark' = 黒地の左列 / 'light' = 白地の右列
 *   ⚠色を渡し違えると **白地に白文字** で読めなくなる。
 */
const KeyOnlySettings = ({
  tone = 'light', moments = [], momentNow = -1, momentNext = null,
  playing = false, viewRate = 1, skipSpeed = 2, onSkipSpeed, onSeek,
}) => {
  const dark = tone === 'dark';
  const box = dark ? 'text-white' : 'text-slate-700';
  const sub = dark ? 'text-white/70' : 'text-slate-500';
  const btn = dark ? 'bg-white/15 text-white' : 'bg-slate-100 text-slate-600';
  const btnOn = dark ? 'bg-white text-slate-900' : 'bg-slate-800 text-white';
  return (
    <div className={`space-y-1.5 ${box}`} data-keyonly-settings={dark ? 'dark' : 'light'}>
      <div className="flex items-center gap-1 flex-wrap">
        <span className="text-sm font-bold shrink-0">要点以外の速さ</span>
        {SKIP_SPEEDS.map(s => (
          <button key={s} onClick={() => onSkipSpeed && onSkipSpeed(s)} data-skip-speed={s}
            className={`px-3 py-2 min-h-[40px] rounded-lg font-bold text-sm ${normSkipSpeed(skipSpeed) === s ? btnOn : btn}`}>
            {s === 1 ? '等速' : `${s}×`}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap text-sm">
        <span className="shrink-0 font-bold tabular-nums">要点 {momentNow >= 0 ? momentNow + 1 : 0} / {moments.length}</span>
        <span className={`shrink-0 ${sub}`}>{playing ? `いま ${viewRate === 1 ? '等速' : `${viewRate}×`}` : '止まっています'}</span>
        {momentNext
          ? <span className="flex-1 min-w-0 truncate">次は <b className="tabular-nums">{momentNext.atText}</b> {momentNext.icon} {momentNext.title}</span>
          : <span className={`flex-1 min-w-0 truncate ${sub}`}>この先に要点はありません（最後まで流します）</span>}
        {momentNext && (
          <button onClick={() => onSeek && onSeek(momentNext.at)} title="次の要点まで飛ぶ"
            className={`shrink-0 px-3 py-2 min-h-[40px] rounded-lg font-bold text-sm ${btn}`}>⏭ 次の要点へ</button>
        )}
      </div>
      <div className={`text-2xs ${sub}`}>
        ※ 画面の見え方だけを変えています。<b className={dark ? 'text-white' : 'text-slate-700'}>書き出す動画は変わりません</b>（⏸止め絵・🖼画像は決めた秒数のまま等速で出ます）。
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------
/**
 * @param sources [{ id, name, file(File), url(表示用), durationSec, driveId }]
 * @param onRun   ({project, images, chapters}) => void  書き出しは呼び出し側が持つ
 * @param onSaveWorkStandard (entry) => Promise  📚資料の棚へ入れる係(App が持っている)。
 *        ⚠渡されない時はボタンを出さない(押せるのに何も起きない、を作らない)。
 * @param userName 入れた人の名前(棚に残す)
 *
 * ---- 👁 見せ方（清水さん 2026-08-16「編集室に統一しろって言ったよね？」）-------------
 * @param recipe         いまこの動画に付いている「見せ方」(video_recipes の1件)。無ければ null
 * @param onSaveRecipe   ({fileId, fileName, title, stepKeys, events, chapters}) => Promise
 *        ⚠渡されない時は「👁 見せ方」タブを **出さない**(付ける相手が居ないので)。
 * @param steps          [{key, label}] この動画を出せる工程
 * @param recipeFileId   Drive の fileId(= video_recipes の docId)
 * @param recipeFileName Drive のファイル名
 */
export const VideoEditor = ({ sources = [], onRun, onClose, busy = false, initial = null, proxyUrl = '', hint = '', onSaveWorkStandard = null, userName = '',
  recipe = null, onSaveRecipe = null, steps = [], recipeFileId = '', recipeFileName = '' }) => {
  const [project, setProject] = useState(() => (initial?.project ? initial.project : projectFromSources(sources)));
  const [past, setPast] = useState([]);
  const [future, setFuture] = useState([]);
  const [tOut, setTOut] = useState(0);
  const [playing, setPlaying] = useState(false);
  // ⚠⚠ 選んでいる部品は **id** で覚える(番号ではない)。
  //   番号(index)で覚えていた時、✕削除・✂分割で番号がずれて **別の部品に編集が入っていた**
  //   (2026-08-16 実測)。id なら、消しても割っても並べ替えても、選びは同じ物に付いたまま。
  //   ⚠id が空 = 「まだ選んでいない」→ 先頭の部品にそろえる(下の useEffect)。
  const [sel, setSel] = useState({ type: 'clip', id: '' });
  const [tool, setTool] = useState('cut');
  // 📋 編集メモで 開いている1件。⚠開くのは1つだけ(増えても下に溜まらない)。
  const [openMemo, setOpenMemo] = useState('');
  const [shape, setShape] = useState('ellipse');
  // ⭕ 選んでいる印の番号。⚠色・太さ・大きさを **もう入っている印** に効かせる為に親が持つ。
  const [markSel, setMarkSel] = useState(-1);
  const [rectMode, setRectMode] = useState(null);       // 'mosaic'|'spot'|'crop'
  // ▩🔦「場所をやり直す」で なぞり直している重ねの id。
  // ⚠⚠ 空のまま なぞると **新しくもう1個増える**(2026-08-16 実測の欠陥)。
  //   ここに id が入っている間は、増やさずに その重ねの場所だけ置き換える。
  const [rectEdit, setRectEdit] = useState('');
  const [thumbs, setThumbs] = useState({});
  const [waves, setWaves] = useState({});
  const [srcDur, setSrcDur] = useState({});
  const [images, setImages] = useState(() => initial?.images || {});   // imageId → File
  const [imgUrls, setImgUrls] = useState(() => {
    const m = {};
    Object.entries(initial?.images || {}).forEach(([k, f]) => { try { m[k] = URL.createObjectURL(f); } catch { /* noop */ } });
    return m;
  });
  const [markColor, setMarkColor] = useState('red');
  // ⏸/▶ 印の出し方。
  // ⚠⚠ 既定は **止めて出す**。画面の位置に固定した印は、映像が流れている限りズレる。
  //   カメラを固定しても関係ない(動くのは手・部品・工具・人の方だから)。
  //   止めれば原理的にズレない。流したまま出すのは「動かない物を指す時」だけ。
  const [markMode, setMarkMode] = useState('freeze');   // 'freeze' | 'flow'
  const [markHold, setMarkHold] = useState(3);          // 何秒止めるか
  const [markWidth, setMarkWidth] = useState('m');
  const [loop, setLoop] = useState(false);
  const [stillUrl, setStillUrl] = useState('');
  // 🖼 切り出した1コマを「画面いっぱい」で確かめる。⚠帯を高くし過ぎると上のプレビューが縮むので
  //    帯は 96px 止まり(h-24)にして、大きく見るのはこの全画面へ逃がす。
  const [stillBig, setStillBig] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  // 📄 作業標準。⚠開くまで絵は作らない(要点が多いと重い)。
  const [wsOpen, setWsOpen] = useState(false);
  const [wsPerPage, setWsPerPage] = useState(WS_PER_PAGE_DEFAULT);
  const [wsBusy, setWsBusy] = useState('');
  const [wsSaved, setWsSaved] = useState('');   // 📚棚へ入れ終わった時の一言
  const [ai, setAi] = useState(null);        // { phase, done, total } 字幕を作っている最中
  const [aiOut, setAiOut] = useState(null);  // { segments, chapters, title, summary, notes }
  const aiAbort = useRef(null);
  const [zoomX, setZoomX] = useState(1);                // 帯(時間)を横に広げる
  // 🔍 **画面だけ** の拡大(清水さん 2026-08-14「編集中に細かい所を見たい・等倍に戻せること」)。
  // ⚠⚠ 書き出す動画は1ミリも変わらない。焼き込む拡大は「⤢画づくり」の中の「寄り」。
  const [viewZoom, setViewZoom] = useState(1);
  const [viewPan, setViewPan] = useState({ x: 0, y: 0 });   // 見る場所。絵の大きさに対する割合
  const [panMode, setPanMode] = useState(false);            // 拡大中: 描く(false) / 見る場所を動かす(true)
  const [imgHold, setImgHold] = useState(5);                // これから挟む画像を何秒出すか
  const [chapters, setChapters] = useState(() => initial?.chapters || []);   // [{name, atOut}]
  const [msg, setMsg] = useState('');
  const [waveBusy, setWaveBusy] = useState(false);
  // ▶ 要点だけ見る(清水さん)
  //   「要点で何秒映すってあるのはいいけど、誰かに見せるときは何秒止めるのもいいけど、
  //     **そこで一旦停止で押したら続く**と、**要点だけ見せる専用モードでそれ以外は倍速
  //     (自分で決めれる)** が必要かな」
  // ⚠⚠ **見せ方だけ**。書き出す動画は1ミリも変わらない(速さを焼き込むのは「⏩速さ」タブ)。
  const [keyOnly, setKeyOnly] = useState(false);
  const [skipSpeed, setSkipSpeed] = useState(2);   // 要点以外を何倍で流すか
  const [stopAt, setStopAt] = useState(null);      // 自動で止まった要点(押したら続く)
  // 💾 作りかけを覚えられなかった時の一言。⚠黙って落とすと「保存されている筈」で消える。
  const [draftErr, setDraftErr] = useState('');
  // ---- 👁 見せ方（動画には焼き込まない。見る時だけ効く指示）--------------------
  // ⚠⚠ 編集室が前から持っている ⏸止め絵 / ⏩速さ / ⭕印 は **動画に焼き込む** 物。
  //   ここの ⏸止めて見せる / ⏭とばす / ⚡区間倍速 は **1バイトも焼き込まない**。
  //   まったくの別物なので、画面の言葉で必ず区別する(取り違えると事故になる)。
  // ⚠⚠ 秒は **元の動画の秒**(video_recipes の形をそのまま使う)。編集室の帯は
  //   「出来上がりの秒」なので、必ず outToSrc / srcSecToOut で行き来する。
  // ⚠既にある見せ方は、開いた時の1回だけ読み込む(あとから親が差し替えても、
  //   打ち込み中の物を上書きしない)。
  const [showTitle, setShowTitle] = useState(() => (recipe && recipe.title) || '');
  const [showEvents, setShowEvents] = useState(() => ((recipe && recipe.events) || []).map(e => ({ ...e })));
  const [showChapters, setShowChapters] = useState(() => (Array.isArray(recipe && recipe.chapters) ? recipe.chapters : []).map(c => ({ ...c })));
  const [showStepKeys, setShowStepKeys] = useState(() => [...((recipe && recipe.stepKeys) || [])]);
  const [showOpen, setShowOpen] = useState('');       // 開いている1件(増えても下に溜まらない)
  const [showPending, setShowPending] = useState(null); // ⏭/⚡ の「ここから」を押した所
  const [showSaving, setShowSaving] = useState(false);
  const [showSaved, setShowSaved] = useState('');
  // 🎙 あとから声を入れる(アフレコ)。⚠⚠ 録った声は動画に焼き込まない(出口は文字)。
  const [rec, setRec] = useState(null);          // 録っている最中 { sec }
  const [take, setTake] = useState(null);        // 録り終わった物 { url, blob, sec, samples } ⚠保存しない
  const [voiceBusy, setVoiceBusy] = useState('');
  const [handText, setHandText] = useState(''); // 手で打つ言葉
  const recRef = useRef(null);                   // MediaRecorder
  const recStreamRef = useRef(null);
  const recTimerRef = useRef(0);
  const recSamplesRef = useRef([]);              // [{recSec, outSec}] ⚠見ていた場所の控え
  const recT0Ref = useRef(0);
  const takeUrlRef = useRef('');

  const canvasRef = useRef(null);
  const vidRefs = useRef({});
  const imgRefs = useRef({});
  const tRef = useRef(0);
  const pRef = useRef(project);
  const playRef = useRef(false);
  const rectModeRef = useRef(null);
  // 📍章は project の外に居る。↩戻す で一緒に戻す為、いまの中身を控えておく。
  const chRef = useRef(chapters);
  useEffect(() => { chRef.current = chapters; }, [chapters]);
  useEffect(() => { tRef.current = tOut; }, [tOut]);
  useEffect(() => { pRef.current = project; }, [project]);
  useEffect(() => { playRef.current = playing; }, [playing]);
  useEffect(() => { rectModeRef.current = rectMode; }, [rectMode]);
  const loopRef = useRef(false);
  useEffect(() => { loopRef.current = loop; }, [loop]);
  // ▶要点だけ見る の材料。⚠再生の輪(requestAnimationFrame)は毎コマ回るので、
  //   state を直に見ずに **控え(ref)** を見る(見ると輪が作り直しになって送りがガタつく)。
  const momentsRef = useRef([]);
  const keyOnlyRef = useRef(false);
  const skipSpeedRef = useRef(2);
  // ⚠⚠ さっき自動で止まった所。<video> の時刻はわずかに戻る事があり、これが無いと
  //   同じ要点で **押しても押しても止まり続ける**。0.35秒 離れたら忘れる(🔁で戻った時は
  //   もう一度止まってほしいので、いつまでも覚えていてはいけない)。
  const doneAtRef = useRef(null);

  const total = projectOutSec(project);
  const rows = timelineOf(project);
  // 📋 編集メモ: 作った物ぜんぶを「何秒に何を」で1本に。⚠中身は書き換えない(見る為の並び)。
  // ⚠⚠ ここは **再生より先**に置く。▶要点だけ見る が「止まる所」をここから取るので、
  //   後ろに置くと再生の輪から見えない(この画面は no-use-before-define を厳しくしてある)。
  const memoRows = useMemo(() => editHistory({ project, chapters }), [project, chapters]);
  const memoNoName = useMemo(() => noNameCount(memoRows), [memoRows]);
  /** ▶要点だけ見る で **止まる所**。⏸止め絵 / 🖼画像 / 📍章 だけ(流れている印では止めない)。 */
  const moments = useMemo(() => keyMoments(memoRows), [memoRows]);
  useEffect(() => { momentsRef.current = moments; }, [moments]);
  useEffect(() => { keyOnlyRef.current = keyOnly; }, [keyOnly]);
  useEffect(() => { skipSpeedRef.current = skipSpeed; }, [skipSpeed]);
  /** いま何番目の要点まで来たか / 次はどれか(画面に出す)。 */
  const momentNow = useMemo(() => momentIndexAt(moments, tOut), [moments, tOut]);
  const momentNext = useMemo(() => nextMoment(moments, tOut), [moments, tOut]);
  /** ▶要点だけ見る の時、いま何倍で流れているか(要点の手前は等速に戻る)。 */
  const viewRate = keyOnly ? speedAt(moments, tOut, skipSpeed) : 1;
  // 📄 作業標準の中身。⚠ここでは**組み立てるだけ**(絵は開いた時に作る)。
  const wsDoc = useMemo(() => buildWorkStandard(project, {
    timeline: timelineOf(project), chapters,
    meta: { title: '作業標準（原案）', madeAt: Date.now(), madeBy: userName, videoName: (sources[0] && sources[0].name) || '' },
  }), [project, chapters, sources, userName]);
  const wsRows = wsDoc.rows;
  // 📚 棚に入れた後で写真を作り直せるか。⚠**入れる前に**言う(あとで気づくのが一番まずい)。
  const wsRebuild = useMemo(() => wsRebuildCheck(wsDoc, sources), [wsDoc, sources]);
  // ⚠同じ物を2回押すと、棚に **同じ標準が2件** 並ぶ(どちらが本物か分からなくなる)。
  //   → 入れたら押せなくする。ただし **中身を直したら押せるように戻す**(直した版も入れたいので)。
  useEffect(() => { setWsSaved(''); }, [wsDoc]);
  const hit = outToSrc(project, tOut);
  const curClip = hit ? project.clips[hit.index] : null;
  // ⚠⚠ 選んでいる部品は id で引き直す。番号で持つと ✕削除/✂分割の後に別の部品へ編集が入る。
  const selIndex = useMemo(() => {
    if (sel?.type !== 'clip') return -1;
    const cs = project.clips || [];
    if (!sel.id) return cs.length ? 0 : -1;
    return cs.findIndex(c => c && c.id === sel.id);
  }, [sel, project.clips]);
  const selClip = selIndex >= 0 ? project.clips[selIndex] : null;
  const selOv = sel?.type === 'overlay' ? (project.overlays || []).find(o => o.id === sel.id) : null;
  // 帯(Timeline)は番号で描いているので、番号に直してから渡す。
  const selForBar = sel?.type === 'clip' ? { type: 'clip', index: selIndex } : sel;
  // まだ選んでいない(id が空) → 先頭の部品を実際の id で選んでおく。
  // ⚠「空 = 先頭」のままにしておくと、先頭を消した時に **別の部品が選ばれた事になる**。
  useEffect(() => {
    if (sel?.type !== 'clip' || sel.id) return;
    const c = (project.clips || [])[0];
    if (c) setSel({ type: 'clip', id: c.id });
  }, [sel, project.clips]);

  /** 部品を番号で選ぶ(その時の project から id を取り出して覚える)。 */
  const selectClipAt = useCallback((p, i) => {
    const cs = (p && p.clips) || [];
    const c = cs[Math.max(0, Math.min(cs.length - 1, i))];
    setSel({ type: 'clip', id: (c && c.id) || '' });
  }, []);

  // ⚠⚠ 「↩戻す」は **project と 📍章 の両方** を戻す。
  //   章だけ別の入れ物に入れていたので、章を入れても消しても ↩戻す で戻らなかった
  //   (2026-08-16 実測)。控えるのも戻すのも、必ずこの2つを一緒に扱う。
  const snap = useCallback(() => ({ project: pRef.current, chapters: chRef.current }), []);
  const push = useCallback((next, nextChapters) => {
    setPast(p => [...p.slice(-40), snap()]);
    setFuture([]);
    setProject(next);
    if (nextChapters !== undefined) setChapters(nextChapters);
  }, [snap]);
  /** 📍章だけを書き換える(履歴に残す)。 */
  const pushChapters = useCallback((nextChapters) => {
    setPast(p => [...p.slice(-40), snap()]);
    setFuture([]);
    setChapters(nextChapters);
  }, [snap]);
  // ⚠⚠ 「↩戻す」に入っていない操作が山ほどあった(端をつまむ・重ねを動かす・文字を打つ・
  //   色や大きさを選ぶ・明るさ…)。どれも setProject を直に呼んでいたため、履歴に何も残らない。
  //   → **ひと続きの操作の最初に1回だけ**、いまの状態を控える。
  //   (毎回控えると、スライダーを動かしただけで履歴が20件埋まる)
  const editing = useRef(false);
  const editTimer = useRef(0);
  const beginEdit = useCallback(() => {
    if (!editing.current) {
      editing.current = true;
      setPast(p => [...p.slice(-40), snap()]);
      setFuture([]);
    }
    clearTimeout(editTimer.current);
    editTimer.current = setTimeout(() => { editing.current = false; }, 700);
  }, [snap]);
  /** 履歴に入る形で書き換える(ひと続きの操作は1手にまとまる)。 */
  const editProject = useCallback((next) => { beginEdit(); setProject(next); }, [beginEdit]);
  /** 📍章を、ひと続きの操作としてまとめて書き換える(名前を打っている間など)。 */
  const editChapters = useCallback((next) => { beginEdit(); setChapters(next); }, [beginEdit]);

  const undo = () => {
    if (!past.length) return;
    const prev = past[past.length - 1];
    setFuture(f => [snap(), ...f].slice(0, 40));
    setProject(prev.project);
    setChapters(prev.chapters || []);
    setPast(p => p.slice(0, -1));
  };
  const redo = () => {
    if (!future.length) return;
    const nx = future[0];
    setPast(p => [...p, snap()]);
    setProject(nx.project);
    setChapters(nx.chapters || []);
    setFuture(f => f.slice(1));
  };

  // ---- 元動画の下ごしらえ(帯の絵・波形) -----------------------------------
  useEffect(() => {
    let dead = false;
    const ac = new AbortController();
    (async () => {
      for (const s of sources) {
        if (dead) return;
        setSrcDur(d => ({ ...d, [s.id]: s.durationSec || 0 }));
        thumbStrip(s.file || s.url, 24, {
          durationSec: s.durationSec, signal: ac.signal,
          onThumb: (t) => { if (!dead) setThumbs(prev => ({ ...prev, [s.id]: [...(prev[s.id] || []), t] })); },
        });
      }
      // ⚠波形は丸ごとデコードするので時間がかかる。1本ずつ、絵の後で。
      setWaveBusy(true);
      for (const s of sources) {
        if (dead || !s.file) continue;
        const w = await waveformPeaks(s.file, 600, { signal: ac.signal });
        if (dead) return;
        if (w.peaks.length) {
          setWaves(prev => ({ ...prev, [s.id]: w.peaks }));
          if (w.durationSec > 0) setSrcDur(d => ({ ...d, [s.id]: d[s.id] || w.durationSec }));
        }
      }
      if (!dead) setWaveBusy(false);
    })();
    return () => { dead = true; ac.abort(); };
  }, [sources]);

  // ---- プレビューの大きさ --------------------------------------------------
  const previewDims = useMemo(() => {
    // ⚠1本目固定にしない。1本目の部品を全部消すと、書き出しは「並びの先頭の映像」に
    //   合わせるので、編集室の絵の形と出来上がりの形が食い違う。
    const firstVid = (project.clips || []).find(c => c.type === 'video');
    const first = sources.find(s2 => s2.id === firstVid?.srcId) || sources[0];
    let w = first?.width || 1280, h = first?.height || 720;
    const rot = project.rotate;
    if (rot === 90 || rot === 270) { const t = w; w = h; h = t; }
    if (project.crop && rectMode !== 'crop') { w *= project.crop.w; h *= project.crop.h; }
    // 🔍 見るために拡大している間は、**絵そのものを作り直して** 細かく見せる。
    // ⚠⚠ ただ引き伸ばすだけだと、大きくなっても **にじむだけ** で細かい所は見えない
    //   (画面用の絵は PREVIEW_MAX_W px幅で作っている＝スマホの1080pなら間引いた絵。
    //    それを4倍に伸ばしても、間引いて捨てた細かさは戻らない)。
    // ⚠元の絵より細かくはしない(min(1,…)のまま。無い物は見えない)。
    // ⚠上限は PREVIEW_ZOOM_MAX。理由と画素の数え直しは 63行あたりに書いた。
    const zoomForRender = Math.min(PREVIEW_ZOOM_MAX, Math.max(1, viewZoom));
    const scale = Math.min(1, (PREVIEW_MAX_W * zoomForRender) / Math.max(1, w));
    return { width: Math.max(2, Math.round(w * scale)), height: Math.max(2, Math.round(h * scale)) };
  }, [sources, project.clips, project.rotate, project.crop, rectMode, viewZoom]);

  // ---- プレビューを「枠いっぱい」に伸ばす ----------------------------------
  // 🚨🚨 清水さんが何度も言っている「編集の絵が小さい」の正体(2026-08-16 実測):
  //   枠 1044×720px に対して 絵 640×360px = **面積で31%**。倍率 1.00倍。
  //   原因は入れ物が `max-w-full max-h-full` だった事。
  //   **max-* は「縮む」だけで「伸びない」**。枠が余っていても元の大きさのまま座っていた。
  //
  // ⚠⚠ 私(Claude)の過去の間違い: 以前このアプリで
  //   「max-h-[X] を h-[X] に書き換えれば大きくなる」と説明したが **1pxも変わらなかった**。
  //   絵の大きさは **枠の幅と高さ** だけで決まる。だからここでは
  //   **枠を実際に測って(ResizeObserver)、入れ物の width/height を px で決める**。
  //
  // ⚠⚠ 縦横比は絶対に崩さない。崩すと印(○や矢印)の位置がズレる
  //   (MarkCanvas targetRef={canvasRef} が canvas の実寸を見ている)。
  //   だから 幅・高さの **両方** を同じ倍率 k で決める(k = min(枠幅/絵幅, 枠高/絵高))。
  //   9:16の縦動画なら k は「高さ側」で決まるので、枠から横にはみ出さない。
  const frameRef = useRef(null);
  const [frameBox, setFrameBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return undefined;
    const read = () => {
      const r = el.getBoundingClientRect();
      setFrameBox(prev => (Math.abs(prev.w - r.width) < 0.5 && Math.abs(prev.h - r.height) < 0.5)
        ? prev : { w: r.width, h: r.height });   // ⚠同じ値なら同じ物を返す(観測の無限ループ避け)
    };
    read();
    if (typeof ResizeObserver !== 'function') { window.addEventListener('resize', read); return () => window.removeEventListener('resize', read); }
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  /**
   * 入れ物(canvas を入れる箱)の実寸。⚠ここで決めるのは **見せる大きさ** だけ。
   * 🔍見る為の拡大(viewZoom)は transform で **この上に掛ける**(二重に効かせない)。
   * ⚠まだ枠を測れていない間は null を返し、今まで通り(縮むだけ)にしておく。
   */
  const previewFit = useMemo(() => {
    const { w: fw, h: fh } = frameBox;
    const aw = previewDims.width, ah = previewDims.height;
    if (!(fw > 1 && fh > 1 && aw > 0 && ah > 0)) return null;
    const k = Math.min(fw / aw, fh / ah);
    // ⚠floor。round だと丸めで1px はみ出して、枠の overflow-hidden に食われる事がある。
    return { width: Math.max(2, Math.floor(aw * k)), height: Math.max(2, Math.floor(ah * k)) };
  }, [frameBox, previewDims]);

  // ---- 描く(書き出しと同じ道) ---------------------------------------------
  const draw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const p = pRef.current;
    const t = tRef.current;
    const h = outToSrc(p, t);
    if (!h) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height); return; }
    const c = h.clip;
    // ⏸止め絵は元の動画の1枚。<video> をその時刻で止めて使う(下のそろえる所で止めている)
    const el = c.type === 'image' ? imgRefs.current[c.imageId] : vidRefs.current[c.srcId];
    const sw = c.type === 'image' ? (el?.naturalWidth || 0) : (el?.videoWidth || 0);
    const sh = c.type === 'image' ? (el?.naturalHeight || 0) : (el?.videoHeight || 0);
    const rowDur = (c.type === 'image' || c.type === 'freeze') ? Math.max(0.2, c.durationSec) : (c.end - c.start) / normSpeed(c.speed);
    const row = rows.find(r => r.index === h.index);
    const prog = rowDur > 0 && row ? clamp((t - row.outStart) / rowDur, 0, 1) : 0;
    // ⚠切り抜きを決めている間は「切る前の全部」を見せる(どこを切るか決められない)
    const cropNow = rectModeRef.current === 'crop' ? null : p.crop;
    if (el) paintFrame(ctx, cv.width, cv.height, el, sw, sh, { rotate: p.rotate, crop: cropNow, adjust: p.adjust, zoom: zoomAt(c.zoom, prog) });
    else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height); }
    const scratch = (w2, h2) => { const s = document.createElement('canvas'); s.width = Math.max(1, w2); s.height = Math.max(1, h2); return s; };
    if ((c.type === 'image' || c.type === 'freeze') && ((c.marks || []).length || c.caption)) {
      const ov = [];
      for (const m of (c.marks || [])) ov.push({ kind: 'mark', mark: m });
      if (c.caption) ov.push({ kind: 'text', text: c.caption, pos: 'bottom', color: 'white' });
      drawOverlays(ctx, cv.width, cv.height, ov, { scratch });
    }
    const act = overlaysAt(p, t);
    if (act.length) drawOverlays(ctx, cv.width, cv.height, act, { scratch });
  }, [rows]);

  // ---- 再生 ---------------------------------------------------------------
  useEffect(() => {
    let raf = 0, last = performance.now();
    const tick = (now) => {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      if (playRef.current) {
        const p = pRef.current;
        // ▶要点だけ見る: 「跨いだかどうか」を測る為に、進める **前** の位置を控える。
        const wasAt = tRef.current;
        const h = outToSrc(p, tRef.current);
        if (!h) { setPlaying(false); }
        else if (h.clip.type === 'video') {
          const v = vidRefs.current[h.clip.srcId];
          if (v) {
            if (v.currentTime >= h.clip.end - 0.03) {
              const rw = timelineOf(p)[h.index];
              const nt = rw ? rw.outEnd + 0.005 : tRef.current + dt;
              tRef.current = nt; setTOut(nt);
            } else {
              const rw = timelineOf(p)[h.index];
              const nt = rw ? rw.outStart + (v.currentTime - h.clip.start) / normSpeed(h.clip.speed) : tRef.current;
              tRef.current = nt; setTOut(nt);
            }
          }
        } else {
          // ⏸止め絵 / 🖼画像 は **要点そのもの**。▶要点だけ見る でも早送りしない
          //   (ここを倍速にすると「3秒見せる」と決めた止め絵が1秒で流れて読めない)。
          const nt = tRef.current + dt;
          tRef.current = nt; setTOut(nt);
        }
        // ▶要点だけ見る: 止まる所を跨いだら **その位置ぴったりで止める**(押したら続く)。
        if (keyOnlyRef.current) {
          if (doneAtRef.current !== null && Math.abs(tRef.current - doneAtRef.current) > 0.35) doneAtRef.current = null;
          const m = crossedMoment(momentsRef.current, wasAt, tRef.current, doneAtRef.current);
          if (m) {
            doneAtRef.current = m.at;
            tRef.current = m.at; setTOut(m.at);
            setPlaying(false);
            setStopAt(m);
            // ⚠<video> もその位置へ寄せる。寄せないと、次に押した時に少し飛ぶ。
            const hh = outToSrc(p, m.at);
            if (hh && hh.clip.type === 'video') {
              const v2 = vidRefs.current[hh.clip.srcId];
              if (v2) { try { v2.currentTime = hh.srcSec; } catch { /* noop */ } }
            }
          }
        }
        if (tRef.current >= projectOutSec(pRef.current) - 0.02) {
          // 🔁 くり返し。⚠手が塞がっている現場では「もう一回」を押せない。
          if (loopRef.current) { tRef.current = 0; setTOut(0); }
          else { tRef.current = projectOutSec(pRef.current); setTOut(tRef.current); setPlaying(false); }
        }
      }
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [draw]);

  // いまの部品に合わせて <video> をそろえる
  useEffect(() => {
    const h = outToSrc(project, tOut);
    Object.entries(vidRefs.current).forEach(([id, v]) => {
      if (!v) return;
      // ⏸止め絵の間は、その動画を **その1枚で止めておく**(絵が動くと印がズレる)
      if (h && h.clip.type === 'freeze' && h.clip.srcId === id) {
        try { v.pause(); } catch { /* noop */ }
        if (Math.abs(v.currentTime - h.srcSec) > 0.05) { try { v.currentTime = h.srcSec; } catch { /* noop */ } }
        return;
      }
      const active = h && h.clip.type === 'video' && h.clip.srcId === id;
      if (!active) { try { v.pause(); } catch { /* noop */ } return; }
      // ⚠⚠ 焼き込む速さ(clip.speed) × **見る時だけの早送り**(viewRate)。
      //   viewRate は ▶要点だけ見る の時だけ 1 以外になる。書き出す動画には一切効かない。
      //   ⚠ブラウザが受け付ける上限は16倍。超える値を入れると例外で再生が止まる。
      v.playbackRate = clamp(normSpeed(h.clip.speed) * viewRate, 0.0625, 16);
      v.muted = !!h.clip.mute || !!project.mute;
      v.volume = clamp(Number(h.clip.volume ?? 1) * Number(project.audio?.volume ?? 1), 0, 1);
      // ⚠ずれた時だけ合わせる(毎回入れると再生が止まる)
      if (Math.abs(v.currentTime - h.srcSec) > 0.25) { try { v.currentTime = h.srcSec; } catch { /* noop */ } }
      if (playing && v.paused) v.play().catch(() => {});
      if (!playing && !v.paused) v.pause();
    });
  }, [tOut, playing, project, viewRate]);

  // ---- 🔍 画面だけの拡大 ---------------------------------------------------
  // ⚠⚠ 拡大は **canvas と 印を描く層を まとめて入れている箱ごと** 大きくする。
  //   層だけを大きくすると、絵と印が別々に動いて **印が全部ズレる**。
  //   箱ごとなら、印の座標を出す toPicture(=画面上の位置を測る)も自動で合う。
  // ⚠寄れる量: 真ん中を基準に (倍率-1)/2 まで。これ以上動かすと絵の外(黒)しか見えない。
  const panLimit = (z) => Math.max(0, (z - 1) / 2);
  const setZoom = useCallback((z) => {
    const nz = clamp(z, VIEW_ZOOMS[0], VIEW_ZOOMS[VIEW_ZOOMS.length - 1]);
    setViewZoom(nz);
    if (nz <= 1) {
      // 等倍に戻す = 見る場所も真ん中へ。⚠戻したのに端が見えていると「戻っていない」と言われる。
      setViewPan({ x: 0, y: 0 });
      setPanMode(false);
      return;
    }
    const lim = (nz - 1) / 2;
    setViewPan(v => ({ x: clamp(v.x, -lim, lim), y: clamp(v.y, -lim, lim) }));
  }, []);
  const zoomStep = (dir) => {
    let i = 0;
    for (let k = 0; k < VIEW_ZOOMS.length; k++) {
      if (Math.abs(VIEW_ZOOMS[k] - viewZoom) < Math.abs(VIEW_ZOOMS[i] - viewZoom)) i = k;
    }
    setZoom(VIEW_ZOOMS[clamp(i + dir, 0, VIEW_ZOOMS.length - 1)]);
  };
  const panRef = useRef(null);
  const panDown = (e) => {
    if (!e.isPrimary) return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* noop */ }
    panRef.current = { cx: e.clientX, cy: e.clientY, from: viewPan };
  };
  const panMove = (e) => {
    const d = panRef.current;
    if (!d) return;
    e.preventDefault();
    // ⚠割る相手は **拡大前の大きさ**(clientWidth は拡大の影響を受けない)。
    //   拡大後の幅で割ると、倍率を上げるほど指の動きに付いてこなくなる。
    const el = canvasRef.current;
    const w = el?.clientWidth || 1;
    const h = el?.clientHeight || 1;
    const lim = panLimit(viewZoom);
    setViewPan({
      x: clamp(d.from.x + (e.clientX - d.cx) / w, -lim, lim),
      y: clamp(d.from.y + (e.clientY - d.cy) / h, -lim, lim),
    });
  };
  const panUp = (e) => {
    panRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* noop */ }
  };
  // 描く層(印・なぞって四角)が出ているか。⚠出ている間は、動かす層を上に出さないと描けなくなる。
  const drawLayerOn = (tool === 'mark' && !rectMode) || !!rectMode;
  const panLayerOn = viewZoom > 1 && (!drawLayerOn || panMode);

  const seek = useCallback((t) => {
    const tt = clamp(t, 0, Math.max(0, projectOutSec(pRef.current)));
    // ⚠自分で場所を変えたら「ここで止まりました」は消す(古い要点の名前が残ると嘘になる)。
    setStopAt(null);
    tRef.current = tt; setTOut(tt);
    const h = outToSrc(pRef.current, tt);
    if (h && h.clip.type === 'video') {
      const v = vidRefs.current[h.clip.srcId];
      if (v) { try { v.currentTime = h.srcSec; } catch { /* noop */ } }
    }
  }, []);
  const step = (frames) => { setPlaying(false); seek(tOut + frames / (project.fps || 30)); };
  /** ▶/⏸(押す所は1つ)。⚠止まった要点の札は、押した時点で消す。 */
  const togglePlay = () => { setStopAt(null); setPlaying(p => !p); };
  /** ⏸止まった所から **続ける**(清水さん「そこで一旦停止で押したら続く」)。 */
  const goOn = () => { setStopAt(null); setPlaying(true); };
  /** ▶要点だけ見る の 入り／切り。⚠状態を書き換える関数の中で他の物を触らない(2度動く)。 */
  const toggleKeyOnly = () => {
    const next = !keyOnly;
    setStopAt(null);
    setPlaying(false);
    setKeyOnly(next);
    // ⚠⚠ ここに倍数を書き込まない。後で速さを変えると **画面に古い数字が残って嘘になる**
    //   (いま何倍かは、右の速さの選び と 「いま 3×」の所が本当の値を出している)。
    setMsg(next
      ? '▶ 要点だけ見るモードにしました。要点（⏸止め絵・🖼画像・📍章）で自動的に止まります。「▶ 続き」で次へ進みます。それ以外は右で選んだ速さで流します。⚠見せ方だけです。書き出す動画は変わりません。'
      : 'ふつうの再生に戻しました。');
  };

  // ---- 操作 ---------------------------------------------------------------
  const doSplit = () => {
    const before = project.clips.length;
    const next = splitAt(project, tOut);
    if (next.clips.length === before) { setMsg('その位置では切れません（端に近すぎます）'); return; }
    push(next); setMsg('');
  };
  // ---- キーボード(PCで編集する人向け。市場の道具と同じ割り当て) -----------
  useEffect(() => {
    const on = (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target?.tagName)) return;
      if (e.key === ' ') { e.preventDefault(); setStopAt(null); setPlaying(x => !x); }
      // ⚠市場の道具は「,」「.」でコマ送り(Camtasia)。矢印と両方効かせる。
      else if (e.key === 'ArrowRight' || e.key === '.') { e.preventDefault(); step(e.shiftKey ? 30 : 1); }
      else if (e.key === 'ArrowLeft' || e.key === ',') { e.preventDefault(); step(e.shiftKey ? -30 : -1); }
      else if (e.key === 's' || e.key === 'S') { e.preventDefault(); doSplit(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  });

  /** メモの行を押した → その物を選んで、その場面へ飛ぶ。 */
  const pickMemo = useCallback((r) => {
    if (!r || !r.ref) return;
    if (r.ref.type === 'clip' || r.ref.type === 'mark') {
      setSel({ type: 'clip', id: r.ref.clipId || r.ref.id });
    } else if (r.ref.type === 'overlay') {
      setSel({ type: 'overlay', id: r.ref.id });
    }
    seek(r.at);
  }, [seek]);

  /** 📋メモの「✎ ここを直す」で開く道具。⚠行の種類と道具がずれると、押しても直せない。 */
  const memoTool = (kind) => {
    if (kind === 'chapter') return 'chapter';
    if (kind === 'overlay:text') return 'text';
    if (kind === 'overlay:mosaic') return 'hide';
    if (kind === 'overlay:spot') return 'spot';
    if (kind === 'image') return 'image';
    return 'mark';   // ⏸止め絵 / その印 / 流したままの印
  };

  /** メモの行から1個だけ消す。⚠章は project の外に居るので別扱い。 */
  const delMemo = useCallback((r) => {
    if (!r || !r.ref) return;
    const t = r.ref.type;
    if (t === 'overlay') { push(removeOverlay(pRef.current, r.ref.id)); }
    else if (t === 'chapter') { pushChapters((chRef.current || []).filter((_, i) => i !== r.ref.index)); }
    else if (t === 'mark') {
      const c = (pRef.current.clips || []).find(x => x && x.id === r.ref.clipId);
      if (c) push(patchClip(pRef.current, (pRef.current.clips || []).indexOf(c),
        { marks: (c.marks || []).filter((_, i) => i !== r.ref.markIndex) }));
    } else if (t === 'clip') {
      const i = (pRef.current.clips || []).findIndex(x => x && x.id === r.ref.id);
      // ⚠最後の1つは消せない(部品が0本になると書き出せない)
      if (i >= 0 && (pRef.current.clips || []).length > 1) {
        const np = deleteClip(pRef.current, i);
        push(np);
        selectClipAt(np, Math.max(0, i - 1));
      } else if (i >= 0) setMsg('最後の1つは消せません');
    }
    setOpenMemo('');
  }, [push, pushChapters, selectClipAt]);

  /**
   * 部品を1つ消す。
   * ⚠⚠ 選び直すのは「消したのが自分だった時」だけ。選びは id で持っているので、
   *   他の部品を消しても選びは同じ物に付いたまま = 別の部品に編集が入らない。
   */
  const removeClipAt = useCallback((i) => {
    const p = pRef.current;
    if ((p.clips || []).length <= 1) { setMsg('最後の1つは消せません'); return; }
    const gone = (p.clips || [])[i];
    if (!gone) return;
    const wasSelected = gone.id === (p.clips[selIndex] || {}).id;
    const np = deleteClip(p, i);
    push(np);
    if (wasSelected) selectClipAt(np, Math.max(0, i - 1));
    setMsg('');
  }, [push, selectClipAt, selIndex]);

  const doDelete = () => {
    if (sel?.type === 'overlay') { push(removeOverlay(project, sel.id)); setSel({ type: 'clip', id: '' }); return; }
    if (selIndex < 0) { setMsg('先に部品を選んでください（帯をタップ）'); return; }
    removeClipAt(selIndex);
  };
  const onTrim = (index, side, tAt) => {
    const rw = timelineOf(pRef.current)[index];
    const c = pRef.current.clips[index];
    if (!rw || !c || c.type !== 'video') return;
    const sp = normSpeed(c.speed);
    const srcAt = c.start + (tAt - rw.outStart) * sp;
    const dur = srcDur[c.srcId] || undefined;
    editProject(prev => (side === 'start' ? trimClip(prev, index, { start: srcAt }, dur) : trimClip(prev, index, { end: srcAt }, dur)));
  };
  const onMoveOverlay = (id, from) => {
    const o = (pRef.current.overlays || []).find(x => x.id === id);
    if (!o) return;
    const len = o.to - o.from;
    const f = clamp(from, 0, Math.max(0, projectOutSec(pRef.current) - len));
    editProject(prev => patchOverlay(prev, id, { from: f, to: f + len }));
  };

  // ==========================================================================
  // ⭕ 印 — 「描いた＝入った」
  // --------------------------------------------------------------------------
  // ⚠⚠ 清水さん(2026-08-15)
  //   「さっき試しに編集して〇とかつけて保存したけど、そのデータ見ても〇とかついてなかった」
  //
  //   原因(2026-08-16 実測): 描いた印は `drawMarks` という **画面だけの控え** に入り、
  //   下の確定ボタンを押した時にしか project へ入らなかった。押さずに ▶書き出す と
  //   **印ゼロで書き出される**。画面には赤い〇が出ているのに、である。
  //   自動で覚える「💾作りかけ」にも入っていなかった(project しか渡していない)。
  //
  //   → **控えを無くした**。指を離した時点で project に入る。
  //     入っていない印は、もうこの画面のどこにも存在しない = 黙って消えようがない。
  //
  // ⚠⚠ ここから先「印を編集する」= **もう入っている印を直す**。
  //   画面に出ている印は 書き出しと同じ paintFrame/drawOverlays が描いている物そのもの。
  // ==========================================================================
  /**
   * いま画面に出ていて、掴んで直せる印。
   *   ⏸止め絵 / 🖼画像 の上 → その部品の marks
   *   映像の上               → その時刻に出ている「流したまま」の印(重ね)
   * ⚠⚠ 訂正(2026-08-16): 「映像の部品の marks は書き出しが運ばない」は **もう当てはまらない**。
   *   書き出しの3つの分岐が `partOverlayInfo()` 1本だけを見るようになり、
   *   映像の部品に付けた印も焼き込まれる(実測: 書き出したMP4の赤い画素 2056)。
   *   ただし **ここで映像に印を足す必要は無い**。映像の上でなぞった印は「流したまま(重ね)」
   *   として持つ方が、出す時刻と長さを後から直せて筋が良い。この関数はその振り分け役。
   */
  const markEdit = useMemo(() => {
    const h2 = outToSrc(project, tOut);
    if (h2 && (h2.clip.type === 'freeze' || h2.clip.type === 'image')) {
      const c = project.clips[h2.index] || {};
      const ms = Array.isArray(c.marks) ? c.marks : [];
      return { where: 'clip', index: h2.index, clipId: c.id || '', marks: ms, refs: ms.map(() => '') };
    }
    const ovs = overlaysAt(project, tOut).filter(o => o.kind === 'mark');
    return { where: 'flow', index: -1, clipId: '', marks: ovs.map(o => o.mark), refs: ovs.map(o => o.id) };
  }, [project, tOut]);

  // 選んでいた印が消えた/場面が変わった → 選びを外す(無い物の色を変えに行かない)
  useEffect(() => { setMarkSel(s => (s >= markEdit.marks.length ? -1 : s)); }, [markEdit.marks.length]);

  /**
   * 印の増減・移動・書き換えを、そのまま project に反映する。
   * @param next 次の印の配列(MarkCanvas / MarkList が作る)
   * @param live true = 指を離す前の途中経過(履歴は1手にまとめる)
   */
  const applyMarks = useCallback((next, live = false) => {
    const p = pRef.current;
    const cur = markEdit.marks;
    const list = (next || []).map(normalizeMark).filter(Boolean);
    const put = (np) => { if (live) { beginEdit(); setProject(np); } else editProject(np); };

    // ── ① 直した(数は同じ): 動かした・大きさ・色・太さ・ひと言 ──
    if (list.length === cur.length) {
      if (markEdit.where === 'clip') { put(patchClip(p, markEdit.index, { marks: list })); return; }
      let np = p;
      list.forEach((m, i) => { const id = markEdit.refs[i]; if (id) np = patchOverlay(np, id, { mark: m }); });
      put(np);
      return;
    }

    // ── ② 消した ──
    if (list.length < cur.length) {
      if (markEdit.where === 'clip') { push(patchClip(p, markEdit.index, { marks: list })); return; }
      let rm = cur.length - 1;
      for (let i = 0; i < list.length; i++) if (cur[i] !== next[i]) { rm = i; break; }
      const id = markEdit.refs[rm];
      if (id) push(removeOverlay(p, id));
      setMarkSel(-1);
      return;
    }

    // ── ③ 描いた(増えた) ──
    const added = list.slice(cur.length);
    if (markEdit.where === 'clip') {
      const kind = ((p.clips[markEdit.index] || {}).type === 'freeze') ? 'この止め絵' : 'この画像';
      push(patchClip(p, markEdit.index, { marks: list }));
      setMarkSel(list.length - 1);
      setMsg(`⭕ 印を${kind}に入れました。もう入っています（書き出しにも💾作りかけにも乗ります）。`);
      return;
    }
    const h2 = outToSrc(p, tOut);
    if (!h2 || h2.clip.type !== 'video') { setMsg('ここには印を入れられません。映像が出ている所でなぞってください。'); return; }
    if (markMode === 'freeze') {
      // ⏸ その1枚で止めて、そこに印を焼く。**ズレようがない**。
      const before = p.clips.length;
      const oldIds = new Set(p.clips.map(c => c.id));
      const np = insertFreezeAt(p, tOut, { durationSec: markHold, marks: added, caption: '' });
      if (np.clips.length === before) { setMsg('ここでは止められません（映像の上でなぞってください）'); return; }
      // ⚠出した直後に **その止め絵を選んでおく**。選ばれていないと秒数を直す所が出ず、
      //   「やっぱり3秒」のためだけに帯から探し直す事になる(挟み直しの元)。
      const at = np.clips.findIndex(c => c.type === 'freeze' && !oldIds.has(c.id));
      push(np);
      if (at >= 0) setSel({ type: 'clip', id: np.clips[at].id });
      // ⚠⚠ **見ている位置も、その止め絵の中へ入れる**。
      //   切る位置は小数3桁に丸めるので、止め絵は「いま見ている秒より ほんの少し後ろ」から
      //   始まる事がある(実測: 見ている 0.46666秒 / 止め絵の頭 0.467秒)。
      //   そのままだと **止め絵の1コマ手前に立ったまま** になり、
      //     ・入れたばかりの印が一覧に出ない（入っているのに「無い」に見える）
      //     ・2個目をなぞると **もう1枚 別の止め絵が増える**
      //   → 頭から少し中へ入れる。
      if (at >= 0) {
        const rw = timelineOf(np)[at];
        if (rw) seek(rw.outStart + Math.min(0.05, rw.outSec / 4));
      }
      setMarkSel(added.length - 1);
      setMsg(`⭕ 印を入れました（もう入っています）。${markHold}秒 止めて出します。ここは絵が動かないので印がズレません。秒数は下でいつでも変えられます。`);
      return;
    }
    // ▶ 流したまま出す。⚠動く物に付けるとズレる(画面にも書いてある)
    let np = p;
    for (const m of added) np = addOverlay(np, { kind: 'mark', mark: m, from: tOut, to: tOut + 3 });
    push(np);
    setMarkSel(list.length - 1);
    setMsg('⭕ 印を入れました（もう入っています）。ここから3秒 流したまま出します。⚠動く物を指すとズレます。動く物なら「⏸止めて出す」にしてください。');
  }, [markEdit, tOut, markMode, markHold, push, editProject, beginEdit, seek]);

  /** 選んでいる1つの印だけ、色・太さ・形を変える。 */
  const RESHAPE_OK = ['ellipse', 'rect', 'num'];
  const patchSelMark = (patch) => {
    if (markSel < 0 || markSel >= markEdit.marks.length) return false;
    const cur = normalizeMark(markEdit.marks[markSel]);
    if (!cur) return false;
    // ⚠形を変えられるのは 〇⇄□⇄① だけ。矢印・なぞり書きは持っている座標が違うので、
    //   無理に変えると **画面の端に飛ぶ**。変えられない時は黙らずに理由を出す。
    if (patch.shape && patch.shape !== cur.shape
      && !(RESHAPE_OK.includes(cur.shape) && RESHAPE_OK.includes(patch.shape))) {
      setMsg('選んでいる印は、その形には変えられません（⭕〇と⬜四角と①番号の間だけ変えられます）。描き直してください。');
      return false;
    }
    applyMarks(markEdit.marks.map((m, i) => (i === markSel ? { ...normalizeMark(m), ...patch } : m)));
    return true;
  };
  const addTextOverlay = () => {
    const next = addOverlay(project, { kind: 'text', text: '', pos: 'bottom', size: 'm', color: 'white', from: tOut, to: tOut + 3 });
    push(next);
    setSel({ type: 'overlay', id: next.overlays[next.overlays.length - 1].id });
    setTool('text');
  };
  const addRectOverlay = (kind, rect) => {
    const next = addOverlay(project, kind === 'mosaic'
      ? { kind: 'mosaic', rect, cell: 'm', from: tOut, to: Math.min(total, tOut + 5) }
      : { kind: 'spot', rect, dim: 0.62, from: tOut, to: Math.min(total, tOut + 5) });
    push(next);
    setSel({ type: 'overlay', id: next.overlays[next.overlays.length - 1].id });
    setRectMode(null);
  };
  const addImage = (file) => {
    const id = mkId('img', Object.keys(images).map(k => ({ id: k })));
    setImages(m => ({ ...m, [id]: file }));
    const u = URL.createObjectURL(file);
    setImgUrls(m => ({ ...m, [id]: u }));
    // ⚠5秒の決め打ちをやめた(清水さん 2026-08-14)。挟む前に選んだ秒数で入る。
    const next = insertImageAt(project, tOut, { imageId: id, durationSec: imgHold, marks: [], caption: '' });
    push(next);
    // ⚠挟んだ物をそのまま選んでおく(秒数・説明・印を、その場で直せるように)
    const at = next.clips.findIndex(c => c.type === 'image' && c.imageId === id);
    if (at >= 0) setSel({ type: 'clip', id: next.clips[at].id });
    // ⚠⚠ 見ている位置も画像の中へ入れる(止め絵と同じ理由。丸めのせいで1コマ手前に立つと、
    //   その画像に印を描けず、なぞると **別の物が増える**)。
    if (at >= 0) {
      const rw = timelineOf(next)[at];
      if (rw) seek(rw.outStart + Math.min(0.05, rw.outSec / 4));
    }
    setMsg(`画像を挟みました（${imgHold}秒 出します）。秒数はこの下でいつでも変えられます。`);
  };
  const doSilenceCut = () => {
    const srcId = curClip?.srcId || sources[0]?.id;
    const pk = waves[srcId];
    const d = srcDur[srcId];
    if (!pk || !d) { setMsg('音の波形がまだ出来ていません（少し待ってください）'); return; }
    const rs = silenceRanges(pk, d, { threshold: 0.06, minSec: 1.2, padSec: 0.25 });
    if (!rs.length) { setMsg('黙っている所は見つかりませんでした'); return; }
    const cut = rs.reduce((a, r) => a + (r.end - r.start), 0);
    push(cutSrcRanges(project, srcId, rs));
    setMsg(`黙っている所 ${rs.length}か所（合計 ${fmtDur(cut)}）を消しました。「↩戻す」で元に戻せます。`);
  };

  // ⚠⚠ 片付けは **最新の一覧** を見る。`[]` で作った片付けは
  //   「マウントした時の imgUrls」しか掴めず、あとから挟んだ画像のURLが永久に残る。
  const imgUrlsRef = useRef(imgUrls);
  useEffect(() => { imgUrlsRef.current = imgUrls; }, [imgUrls]);
  useEffect(() => () => {
    Object.values(imgUrlsRef.current || {}).forEach(u => { try { URL.revokeObjectURL(u); } catch { /* noop */ } });
  }, []);

  // 💾 作りかけを自動で覚える。
  // ⚠市場調査(2026-08-13)で「無いと即バレる機能」の1位。現場のタブレットは必ず落ちる。
  // ⚠触るたびに書かない(1.5秒まとめて)。⚠元動画の本体は覚えない(100MB超を毎回書くと固まる)。
  //
  // ⚠⚠ 書く中身は **控え(ref)から取る**。1.5秒待っている間に また触られるので、
  //   タイマーを仕掛けた時の古い中身を書くと1手ぶん古い物が残る。
  const draftRef = useRef(null);
  useEffect(() => {
    draftRef.current = {
      project, images, chapters,
      sources: sources.map(s2 => ({ id: s2.id, name: s2.name, size: s2.size, durationSec: s2.durationSec, driveId: s2.driveId || '' })),
      label: sources[0]?.name || '',
    };
  }, [project, images, chapters, sources]);
  const draftTimer = useRef(0);
  /** いまの中身を1回書く。⚠鍵は元動画から決まる(動画ごとに別の枠へ入る)。 */
  const writeDraft = useCallback(async () => {
    const d = draftRef.current;
    if (!d || !(d.project?.clips || []).length) return 0;
    const at = await saveDraft(d);
    setSavedAt(at);
    setDraftErr('');
    return at;
  }, []);
  useEffect(() => {
    if (!project.clips.length) return undefined;
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      // ⚠覚えられない端末でも編集は続けられる。ただし **黙らない**(下に赤で出す)。
      writeDraft().catch((e) => setDraftErr(String(e?.message || e)));
    }, 1500);
    return () => clearTimeout(draftTimer.current);
  }, [project, images, chapters, sources, writeDraft]);
  /**
   * 🚨 書き出す直前に **必ず1回書く**。
   * ⚠⚠ 自動保存は1.5秒まとめなので、帯を切った直後(0.6秒以内)に ▶書き出す を押すと
   *   作りかけが **1手ぶん古いまま** 残っていた(2026-08-16 の残件)。待っている物を
   *   取り消して、その場で書いてから書き出す。ここを飛ばすと、書き出した後に
   *   「続きから」で戻った時に最後の1手が消えている。
   */
  const flushDraft = useCallback(async () => {
    clearTimeout(draftTimer.current);
    try { await writeDraft(); }
    catch (e) { setDraftErr(String(e?.message || e)); }
  }, [writeDraft]);

  // 🤖 音声から字幕の下書きを作る。
  // ⚠⚠ **AIに「どこを消すか」は決めさせない**。ここで作るのは
  //   字幕・区切りの案・題名の下書きだけ。何を残すかはエースの技なので触らない。
  // ⚠字幕の秒は **元の動画の時刻**。切ったり倍速にしたりした後は
  //   出来上がりの時刻に置き直さないと、**別の場面で字幕が出る**。
  // ⚠⚠ 見るのは **いま描いている project**(控えの pRef ではない)。
  //   pRef は描き終わった後に入るので、切った直後の1回だけ1手ぶん古い並びを見てしまい、
  //   👁見せ方の一覧が「切り取った所です」を出したり消したりする(2026-08-16)。
  const srcSecToOut = useCallback((srcId, sec) => {
    for (const r of timelineOf(project)) {
      if (r.type !== 'video' || r.srcId !== srcId) continue;
      if (sec >= r.start - 1e-6 && sec < r.end) return r.outStart + (sec - r.start) / normSpeed(r.speed);
    }
    return null;   // 消した所 → 字幕も出さない
  }, [project]);

  const runAi = async () => {
    // ⚠つないだ動画は **全部** 聞く。1本目だけ聞いて黙っていると、
    //   2本目以降の声が丸ごと落ちたことに誰も気づけない。
    const list = (sources || []).filter(x => x?.file);
    if (!list.length) { setMsg('元の動画が見つかりません'); return; }
    if (!proxyUrl) { setMsg('AIサーバーが未設定です（管理者: .env の VITE_GEMINI_PROXY_URL）'); return; }
    const ac = new AbortController();
    aiAbort.current = ac;
    setAi({ phase: '音を取り出しています…', done: 0, total: 1 });
    setMsg('');
    try {
      const segs = [], chs = [], notes = [];
      let title = '', summary = '';
      for (let i = 0; i < list.length; i++) {
        const src = list[i];
        const out = await transcribeVideo(src.file, {
          proxyUrl, hint, totalSec: src.durationSec, signal: ac.signal,
          onProgress: (x) => setAi({ ...x, phase: list.length > 1 ? `${x.phase}（動画 ${i + 1}/${list.length}）` : x.phase }),
        });
        for (const sg of out.segments) segs.push({ ...sg, srcId: src.id });
        for (const c of out.chapters) chs.push({ ...c, srcId: src.id });
        if (!title && out.title) title = out.title;
        if (!summary && out.summary) summary = out.summary;
        for (const n of (out.notes || [])) notes.push(list.length > 1 ? `${src.name}: ${n}` : n);
      }
      setAiOut({ segments: segs, chapters: chs, title, summary, notes });
      setMsg(segs.length
        ? `字幕の下書きを ${segs.length}枚 作りました。下の「まとめて入れる」で入ります（1枚ずつ直せます）。`
        : '聞き取れる声がありませんでした。');
    } catch (e) {
      if (e?.name === 'AbortError') setMsg('やめました');
      else setMsg('字幕を作れませんでした: ' + (e?.message || e));
    } finally { setAi(null); aiAbort.current = null; }
  };

  /** 下書きを本物の字幕として入れる。⚠消した所にかかる分は落とす。 */
  const applyAiSubs = () => {
    if (!aiOut?.segments?.length) return;
    const mapped = [];
    for (const sg of aiOut.segments) {
      const sid = sg.srcId || sources[0]?.id;
      const from = srcSecToOut(sid, sg.start);
      if (from == null) continue;                       // 消した区間の字幕は入れない
      const toRaw = srcSecToOut(sid, Math.max(sg.start + 0.1, sg.end - 0.05));
      const to = toRaw == null ? from + 1.5 : Math.max(from + 0.6, toRaw);
      mapped.push({ start: from, end: to, text: sg.text });
    }
    if (!mapped.length) { setMsg('入れられる字幕がありませんでした（消した所ばかりでした）'); return; }
    const dropped = aiOut.segments.length - mapped.length;
    // ⚠⚠ 出来上がりの時刻へ置き直すと、切った所の前後で **間が詰まって字幕が重なる**。
    //   （元の動画の時刻では重なっていなくても、消した分だけ寄るため）
    //   → 置き直した **後に** もう一度そろえる。ここを飛ばすと下の字幕が読めなくなる。
    const tidy = tidySegments(mapped, total);
    let next = project;
    for (const o of segmentsToOverlays(tidy)) {
      next = addOverlay(next, { kind: 'text', text: o.text, from: o.from, to: o.to, pos: 'bottom', size: 'm', color: 'white' });
    }
    push(next);
    setMsg(`字幕を ${tidy.length}枚 入れました${dropped > 0 ? `（消した所にかかる ${dropped}枚は入れていません）` : ''}。1枚ずつ直せます。`);
  };

  /** 区切りの案を章として入れる。 */
  const applyAiChapters = () => {
    if (!aiOut?.chapters?.length) return;
    const cs = [];
    for (const c of aiOut.chapters) {
      // ⚠AIが返すのは **元の動画の秒(atSrc)**。画面の章は **出来上がりの秒(atOut)**。
      const at = srcSecToOut(c.srcId || sources[0]?.id, c.atSrc);
      if (at == null) continue;
      cs.push({ name: c.name, atOut: Math.round(at * 100) / 100 });
    }
    if (!cs.length) { setMsg('入れられる区切りがありませんでした'); return; }
    // ⚠履歴に残す(↩戻す で章も一緒に戻る)
    pushChapters([...(chRef.current || []), ...cs]);
    setMsg(`区切りの案を ${cs.length}個 入れました。名前は直せます。「↩ 操作を戻す」で消せます。`);
  };

  // 🖼 いまの1枚を写真に(手順書・掲示物に貼る)。⚠元の大きさのまま出す(帯の絵ではない)。
  const doStill = async () => {
    const h = outToSrc(project, tOut);
    if (!h) return;
    setMsg('写真を作っています…');
    try {
      let blob;
      if (h.clip.type === 'image') {
        // 挟んだ画像は元のファイルをそのまま渡す(印つきは下の canvas から作る)
        const cv = canvasRef.current;
        blob = await new Promise(res => cv.toBlob(res, 'image/jpeg', 0.92));
      } else {
        const src = sources.find(x => x.id === h.clip.srcId);
        // ⚠寄り(ズーム)も渡す。渡さないと **画面で見ている絵と違う写真** が出る。
        const rw = timelineOf(project)[h.index];
        const prog = rw && rw.outSec > 0 ? clamp((tOut - rw.outStart) / rw.outSec, 0, 1) : 0;
        blob = await grabStill(src?.file || src?.url, h.srcSec, {
          rotate: project.rotate, crop: project.crop, adjust: project.adjust,
          zoom: zoomAt(h.clip.zoom, prog),
          overlays: overlaysAt(project, tOut),
        });
      }
      if (stillUrl) { try { URL.revokeObjectURL(stillUrl); } catch { /* noop */ } }
      const u = URL.createObjectURL(blob);
      setStillUrl(u);
      setMsg('写真ができました。下の「⬇ 写真を保存」で端末に入ります。');
    } catch (e) { setMsg('写真を作れませんでした: ' + (e?.message || e)); }
  };

  // ==========================================================================
  // 🔎 動画の中を言葉で探す
  // ⚠⚠ 材料は「いま在る文字」だけ。喋る前提で作らない(本番の手本動画は字幕0件だった)。
  // ==========================================================================
  /** AIの聞き取りは **出来上がりの秒に直してから** 材料にする(消した所の分は落ちる)。 */
  const aiTranscript = useMemo(() => {
    if (!aiOut?.segments?.length) return [];
    const out = [];
    for (const sg of aiOut.segments) {
      const at = srcSecToOut(sg.srcId || sources[0]?.id, sg.start);
      if (at == null) continue;
      out.push({ at, text: sg.text });
    }
    return out;
  }, [aiOut, srcSecToOut, sources]);

  const words = useMemo(
    () => collectWords({ project, timeline: timelineOf(project), chapters, transcript: aiTranscript }),
    [project, chapters, aiTranscript],
  );
  /** ⚠⚠ Firestore は1ドキュメント1MB。**文字数で数えて**上限で切り、切ったら画面に出す。 */
  const wordsCap = useMemo(() => capWordsForDoc(words), [words]);

  // ==========================================================================
  // 🎙 あとから声を入れる(アフレコ)
  // ⚠⚠ 焼き込まない。録った声は「その場面の言葉」にして、音そのものは捨てる。
  //   ・現場は騒音でイヤホンを付けられない = 音の説明は届かない。届くのは文字。
  //   ・音を足す実装は過去に2回事故を出している(軽量画質で音が消えた / 合体だけ音が無い)。
  //     いまは exportProject 1本。**そこを分岐させない。**
  //   ・iOS は Safari 26 で初めて AudioEncoder が入った。焼き込む道を作ると古い端末で黙って消える。
  // ==========================================================================
  const voiceCap = useMemo(() => voiceSupport({
    secureContext: typeof window !== 'undefined' && !!window.isSecureContext,
    getUserMedia: typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia,
    mediaRecorder: typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined'
      ? (m) => window.MediaRecorder.isTypeSupported(m) : null,
    audioContext: typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext),
    audioEncoder: typeof window !== 'undefined' && typeof window.AudioEncoder !== 'undefined',
  }), []);

  const clearTake = useCallback(() => {
    if (takeUrlRef.current) { try { URL.revokeObjectURL(takeUrlRef.current); } catch { /* noop */ } }
    takeUrlRef.current = '';
    setTake(null);
  }, []);

  const stopRec = useCallback(() => {
    clearInterval(recTimerRef.current);
    recTimerRef.current = 0;
    try { recRef.current?.stop(); } catch { /* noop */ }
    recRef.current = null;
    setRec(null);
    setPlaying(false);
  }, []);

  const startRec = async () => {
    if (!voiceCap.ok) { setMsg(voiceCap.why || 'この端末では声を入れられません'); return; }
    clearTake();
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      setMsg('マイクを使えませんでした（許可されていないかもしれません）: ' + (e?.message || e));
      return;
    }
    recStreamRef.current = stream;
    let mr;
    try { mr = new MediaRecorder(stream, voiceCap.mime ? { mimeType: voiceCap.mime } : undefined); }
    catch (e) {
      try { stream.getTracks().forEach(t => t.stop()); } catch { /* noop */ }
      setMsg('この端末では声を録れませんでした: ' + (e?.message || e));
      return;
    }
    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstop = () => {
      try { recStreamRef.current?.getTracks().forEach(t => t.stop()); } catch { /* noop */ }
      recStreamRef.current = null;
      const samples = recSamplesRef.current.slice();
      const sec = samples.length ? samples[samples.length - 1].recSec : 0;
      const blob = new Blob(chunks, { type: voiceCap.mime || 'audio/webm' });
      if (!blob.size || sec < 0.5) { setMsg('録れていませんでした（短すぎるかマイクが拾えていません）'); return; }
      const url = URL.createObjectURL(blob);
      takeUrlRef.current = url;
      setTake({ url, blob, sec, samples });
      setMsg(`${Math.round(sec)}秒ぶん録れました。下の「言葉にする」で、その場面の言葉になります。`);
    };
    recSamplesRef.current = [{ recSec: 0, outSec: tRef.current }];
    recT0Ref.current = Date.now();
    recRef.current = mr;
    mr.start();
    setPlaying(true);                       // 見ながら喋る
    setRec({ sec: 0 });
    // ⚠⚠ 経過時間で割り算しない。一時停止・戻して喋り直し・倍速の部品があるので、
    //   **いま何秒を見ていたか** を控え続ける。この控えが無いと言葉が別の場面に付く。
    recTimerRef.current = setInterval(() => {
      const s = (Date.now() - recT0Ref.current) / 1000;
      recSamplesRef.current.push({ recSec: s, outSec: tRef.current });
      setRec({ sec: s });
      if (s >= MAX_TAKE_SEC) { stopRec(); setMsg(`${Math.round(MAX_TAKE_SEC / 60)}分で止めました。何回かに分けて入れてください。`); }
    }, 200);
  };

  /** 録った声 → その場面の言葉。⚠音そのものは保存しない。 */
  const takeToWords = async () => {
    if (!take) return;
    if (!proxyUrl) { setMsg('AIサーバーが未設定です（管理者: .env の VITE_GEMINI_PROXY_URL）。下の「手で打つ」は使えます。'); return; }
    if (!voiceCap.canMakeSubtitles) { setMsg(voiceCap.why || 'この端末では声から言葉を作れません'); return; }
    setVoiceBusy('音を聞いています…');
    try {
      const out = await transcribeVideo(take.blob, {
        proxyUrl, hint, totalSec: take.sec,
        onProgress: (x) => setVoiceBusy(x.phase || '音を聞いています…'),
      });
      const r = takeToNotes({
        samples: take.samples, segments: out.segments,
        totalOutSec: total, existing: project.notes || {},
      });
      if (!r.count) { setMsg('言葉になる所がありませんでした（聞き取れなかったか、動画の外でした）'); return; }
      push({ ...project, notes: { ...(project.notes || {}), ...r.added } });
      clearTake();
      setMsg(`${r.count}件の言葉を入れました${r.skipped ? `（${r.skipped}件は空か動画の外だったので入れていません）` : ''}。🔎探すで出てきます。⚠聞き間違いがあるので読み直してください。`);
    } catch (e) {
      setMsg('言葉にできませんでした: ' + (e?.message || e));
    } finally { setVoiceBusy(''); }
  };

  /** 手で打つ。⚠AIサーバーが無い所でも、この機能だけで成り立つようにしておく。 */
  const addHandNote = () => {
    const t = handText.trim();
    if (!t) return;
    const r = takeToNotes({
      samples: [{ recSec: 0, outSec: tOut }], segments: [{ start: 0, end: 1, text: t }],
      totalOutSec: total, existing: project.notes || {},
    });
    if (!r.count) { setMsg('この場面には入れられませんでした'); return; }
    push({ ...project, notes: { ...(project.notes || {}), ...r.added } });
    setHandText('');
    setMsg(`${fmtDur(tOut)} に言葉を足しました。🔎探すで出てきます。`);
  };

  const delNote = (id) => {
    const n = { ...(project.notes || {}) };
    delete n[id];
    push({ ...project, notes: n });
  };

  /** 吹き込んだ言葉を、そのまま焼き込む字幕にする。⚠通る道は今までの字幕と同じ1本。 */
  const notesToSubs = () => {
    const segs = notesToSegments(project.notes || {});
    if (!segs.length) { setMsg('字幕にできる言葉がありません'); return; }
    const tidy = tidySegments(segs, total);
    let next = project;
    for (const o of segmentsToOverlays(tidy)) {
      next = addOverlay(next, { kind: 'text', text: o.text, from: o.from, to: o.to, pos: 'bottom', size: 'm', color: 'white' });
    }
    push(next);
    setMsg(`吹き込んだ言葉から字幕を ${tidy.length}枚 入れました。1枚ずつ直せます。`);
  };

  // ⚠画面を閉じる時に、マイクと録音を必ず止める(点いたままだと録り続ける)。
  useEffect(() => () => {
    clearInterval(recTimerRef.current);
    try { recRef.current?.stop(); } catch { /* noop */ }
    try { recStreamRef.current?.getTracks().forEach(t => t.stop()); } catch { /* noop */ }
    if (takeUrlRef.current) { try { URL.revokeObjectURL(takeUrlRef.current); } catch { /* noop */ } }
  }, []);

  // ---- 👁 見せ方（レシピ編集を編集室へ引き取った所）---------------------------
  // ⚠⚠ ここで作る物は **動画に入らない**。この画面と、検査画面の🎬で見る時だけ効く。
  //   焼き込む方(⏸止め絵・⏩速さ・⭕印)と取り違えると事故になるので、言葉を必ず分ける。

  /** 見せ方を付けられるか。⚠付ける相手(Driveの動画)が居ない時はタブごと出さない。 */
  const showOn = !!(onSaveRecipe && recipeFileId);
  /** 見せ方が付く元動画。⚠複数つないだ時に別の動画の秒を書かない為、ここで1本に決める。 */
  const showSrcId = (((sources || []).find(s => s && recipeFileId && s.driveId === recipeFileId) || sources[0] || {}).id) || '';
  const showSrcTotal = Number(srcDur[showSrcId] || ((sources || []).find(s => s && s.id === showSrcId) || {}).durationSec || 0);
  /**
   * いまの場面は、**元の動画の何秒** か。付けられない場所では null。
   * ⚠⚠ 編集室の時計(tOut)は「出来上がりの秒」。切ったり画像を挟んだりすると
   *   元の動画とはズレる。レシピは元の動画の秒で持つので、必ずここを通す。
   */
  const showSrcNow = (hit && hit.clip.type !== 'image' && hit.clip.srcId === showSrcId)
    ? Math.round(hit.srcSec * 10) / 10
    : null;
  /** 付けられない時、その理由。⚠押せるのに何も起きない、を作らない。 */
  const showWhyNo = showSrcNow != null ? ''
    : !hit ? '場面がありません。'
      : hit.clip.type === 'image' ? '🖼 挟んだ画像の上では付けられません（元の動画が映っている場面へ動かしてください）。'
        : `いまの場面は別の動画です。見せ方は「${recipeFileName || 'この動画'}」の場面にだけ付けられます。`;
  /** 元の動画の秒 → いまの出来上がりの何秒か。切り取った所は null。 */
  const showOutOf = (srcSec) => srcSecToOut(showSrcId, Number(srcSec) || 0);
  /** その場面へ飛ぶ。⚠切り取った所は飛べないので、黙らずに理由を出す。 */
  const showSeekSrc = (srcSec) => {
    const at = showOutOf(srcSec);
    if (at == null) { setMsg('その場面は、いまの編集で切り取られています（見せ方は元の動画に付いているので消えてはいません）。'); return; }
    setPlaying(false);
    seek(at);
  };
  const showNewId = () => `sv${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  // ⚠state をレンダー中に並べ替えない(写してから並べる)。
  const showSorted = [...showEvents].sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0));
  const patchShowEvt = (id, patch) => { setShowSaved(''); setShowEvents(prev => prev.map(e => (e.id === id ? { ...e, ...patch } : e))); };
  const delShowEvt = (id) => { setShowSaved(''); setShowEvents(prev => prev.filter(e => e.id !== id)); if (showOpen === id) setShowOpen(''); };
  /** 時刻を ±する。⚠始まり<終わり を必ず保つ(逆になると一生効かない指示ができる)。 */
  const adjShowTime = (id, field, delta) => {
    setShowSaved('');
    setShowEvents(prev => prev.map(e => {
      if (e.id !== id) return e;
      const base = field === 'start' ? (Number(e.start) || 0) : (e.end == null ? (Number(e.start) || 0) : Number(e.end));
      let v = Math.round((base + delta) * 10) / 10;
      v = Math.max(0, showSrcTotal > 0 ? Math.min(showSrcTotal, v) : v);
      if (field === 'start' && e.end != null) v = Math.min(v, Number(e.end) - 0.2);
      if (field === 'end') v = Math.max(v, (Number(e.start) || 0) + 0.2);
      return { ...e, [field]: Math.max(0, Math.round(v * 10) / 10) };
    }));
  };
  /** いま見ている場面を、その指示の 始まり／終わり にする。 */
  const showTimeHere = (id, field) => {
    if (showSrcNow == null) { setMsg(showWhyNo); return; }
    setShowSaved('');
    setShowEvents(prev => prev.map(e => {
      if (e.id !== id) return e;
      let v = showSrcNow;
      if (field === 'start' && e.end != null) v = Math.min(v, Number(e.end) - 0.2);
      if (field === 'end') v = Math.max(v, (Number(e.start) || 0) + 0.2);
      return { ...e, [field]: Math.max(0, Math.round(v * 10) / 10) };
    }));
  };
  /** ⏸ いまの場面で止めて見せる。 */
  const addShowPause = () => {
    if (showSrcNow == null) { setMsg(showWhyNo); return; }
    setPlaying(false);
    const ev = { id: showNewId(), type: 'pause', start: showSrcNow, label: '', text: '', hold: 0, marks: [] };
    setShowEvents(prev => [...prev, ev]);
    setShowOpen(ev.id);
    setShowSaved('');
    setMsg(`⏸ 元の動画の ${fmtDur(showSrcNow)} で止めて見せる所を作りました。名前とひとことを入れてください。`);
  };
  /** ⏭とばす / ⚡区間倍速 の「ここから」。 */
  const startShowRange = (type, speed) => {
    if (showSrcNow == null) { setMsg(showWhyNo); return; }
    // ⚠ speed:undefined を混ぜない(そのまま保存すると弾かれる)。
    setShowPending(type === 'speed' ? { type, speed, start: showSrcNow } : { type, start: showSrcNow });
  };
  /** 「ここまで」。 */
  const endShowRange = () => {
    if (!showPending) return;
    if (showSrcNow == null) { setMsg(showWhyNo); return; }
    if (showSrcNow <= showPending.start + 0.2) { setMsg('「ここまで」は「ここから」より後にしてください（少し進めてから、もう一度押してください）。'); return; }
    const ev = { id: showNewId(), ...showPending, end: showSrcNow };
    setShowEvents(prev => [...prev, ev]);
    setShowOpen(ev.id);
    setShowPending(null);
    setShowSaved('');
  };
  /** 📍工程の頭出し。⚠動画は分けない。「その工程はここから見る」という目印だけ。 */
  const addShowChapter = (stepKey) => {
    if (showSrcNow == null) { setMsg(showWhyNo); return; }
    const st = (steps || []).find(x => x && x.key === stepKey);
    const start = showSrcNow;
    const end = showSrcTotal > 0 ? Math.min(showSrcTotal, start + 30) : start + 30;
    setShowChapters(prev => [...prev, {
      id: `ch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      stepKey, label: (st && st.label) || '', start, end, source: 'manual',
    }]);
    setShowStepKeys(prev => (prev.includes(stepKey) ? prev : [...prev, stepKey]));
    setShowSaved('');
  };
  const delShowChapter = (id) => { setShowSaved(''); setShowChapters(prev => prev.filter(c => c.id !== id)); };
  const toggleShowStep = (key) => {
    setShowSaved('');
    setShowStepKeys(prev => (prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]));
  };
  /**
   * 💾 見せ方を保存する。
   * ⚠⚠ **model は書かない。** 保存は merge なので、書かなければ元の値が残る。
   *   書いていたせいで、全型式共通の手本が その型式専用に化けた事がある。
   * ⚠頭出しのある工程は、チップを外していても足し戻す(頭出しと🎬表示は必ずセット)。
   */
  const saveShow = async () => {
    if (!onSaveRecipe || !recipeFileId) return;
    setShowSaving(true);
    setShowSaved('');
    try {
      const outStepKeys = [...new Set([...showStepKeys, ...showChapters.map(c => c.stepKey).filter(Boolean)])];
      await onSaveRecipe({
        fileId: recipeFileId, fileName: recipeFileName || '',
        title: showTitle.trim(), stepKeys: outStepKeys, events: showEvents, chapters: showChapters,
      });
      setShowSaved(`💾 見せ方を保存しました（止める/とばす/倍速 ${showEvents.length}件・頭出し ${showChapters.length}件）。`);
    } catch (e) {
      setMsg('見せ方を保存できませんでした: ' + ((e && e.message) || e));
    } finally { setShowSaving(false); }
  };

  // ---- 画面 ---------------------------------------------------------------
  const TOOLS = [
    ['cut', '✂ 切る・消す'],
    ['speed', '⏩ 速さ'],
    // ⚠⚠ **焼き込む速さの隣**に置く。離すと必ず取り違える(片方は動画に入り、片方は入らない)。
    ...(showOn ? [['show', '👁 見せ方']] : []),
    ['mark', '⭕ 印'],
    ['memo', '📋 メモ'],
    ['text', '💬 文字'],
    ['hide', '▩ 隠す'],
    ['spot', '🔦 ここを見て'],
    ['image', '🖼 画像'],
    ['frame', '⤢ 画づくり'],
    ['audio', '🔊 音'],
    ['chapter', '📍 章'],
    ['find', '🔎 探す'],
    // ⚠⚠ 使えない端末には **出さない**。押せるのに何も起きないボタンは「壊れている」と思われる。
    ...(voiceCap.ok ? [['voice', '🎙 あとから声']] : []),
  ];

  // ⏸止め絵 / 🖼画像 の「何秒出すか・下に出す説明・印」。
  // ⚠「⭕印」タブと「🖼画像」タブの **両方** に同じ物を出す(片方にしか無いと探しに行く事になる)。
  // ⚠showMarks=false … ⭕印タブは自分で印の一覧を出す(2つ並ぶと、どちらを直したのか分からない)。
  const mkStillEditor = (showMarks) => (selClip && (selClip.type === 'freeze' || selClip.type === 'image') ? (
    <StillClipEditor
      clip={selClip}
      showMarks={showMarks}
      onSeconds={(n) => push(setClipDuration(project, selIndex, n))}
      onCaption={(v) => editProject(patchClip(project, selIndex, { caption: v }))}
      onWsField={(k, v) => editProject(patchClip(project, selIndex, { [k]: v }))}
      onSeek={() => { const rw = timelineOf(project)[selIndex]; if (rw) seek(rw.outStart + 0.05); }}
      onMarks={(n) => editProject(patchClip(project, selIndex, { marks: n }))}
    />
  ) : null);

  return (
    <div className="fixed inset-0 z-[600] bg-slate-900 flex flex-col" onClick={e => e.stopPropagation()}>
      {/* 上のバー */}
      <div className="shrink-0 px-2 py-1.5 flex items-center gap-1.5 bg-slate-800 text-white">
        <span className="font-bold text-sm">🎬 編集室</span>
        {/* ⚠⚠ 「戻す」が2つある(操作を取り消す / 画面の拡大を等倍に戻す)。
            どちらか分からないと必ず事故るので、名前に **何を戻すのか** を入れる。 */}
        <button onClick={undo} disabled={!past.length} className="px-2 py-1.5 min-h-[36px] rounded bg-white/10 disabled:opacity-30 text-sm font-bold" title="いまの操作を取り消す (Ctrl+Z)">↩ 操作を戻す</button>
        <button onClick={redo} disabled={!future.length} className="px-2 py-1.5 min-h-[36px] rounded bg-white/10 disabled:opacity-30 text-sm font-bold" title="取り消した操作をやり直す (Ctrl+Shift+Z)">↪ 操作を進む</button>
        {/* ⚠⚠ ここには **出来上がりの長さ(0:12)** が出る = 読んで判断する数字なので 12px 以上。
               11px だと上のバーの黒地で読めない(2026-08-16 実測で不合格になった所)。
            ⚠min-w-0 truncate を付けて、上のバーの押す物(📄/▶/閉じる)を押し出さないようにする。 */}
        <span className="ml-auto min-w-0 truncate text-xs text-white/70">
          {/* ⚠覚えられなかった時は **黙らない**。「保存されている筈」で消えるのが一番まずい。 */}
          {draftErr
            ? <span className="mr-2 text-rose-300 font-bold">⚠ 作りかけを覚えられません（{draftErr}）— 書き出すまで閉じないでください</span>
            : savedAt ? <span className="mr-2 text-emerald-300">💾 作りかけを覚えました</span> : null}
          出来上がり <b className="text-white">{fmtDur(total)}</b>／{project.clips.length}部品
        </span>
        {/* 📄 動画の要点 → 作業標準。⚠止め絵・挟んだ画像が1つも無いと作れないので、
               その時は押せなくして「どうすれば作れるか」を出す。 */}
        <button onClick={() => setWsOpen(true)} disabled={!wsRows.length}
          title={wsRows.length ? `要点 ${wsRows.length}件 から作業標準を作ります` : '⏸止め絵か🖼画像を入れると作れます'}
          className="px-3 py-1.5 min-h-[36px] rounded-lg bg-sky-500 hover:bg-sky-400 disabled:bg-slate-600 disabled:opacity-50 font-bold text-sm">
          📄 作業標準{wsRows.length ? `（${wsRows.length}）` : ''}
        </button>
        {/* ⚠⚠ words = 「言葉で探す」の索引。**鍵つきの入れ物(map)** で渡す。
               配列で渡して読み書きすると、多端末で後から保存した端末が相手の分を消す。
               ⚠1MBに当たらないよう、ここで文字数を数えて切ってある(切った件数は🔎探すに出る)。 */}
        {/* ⚠⚠ 書き出す前に、待っている自動保存を **その場で書き切る**(flushDraft)。
               切った直後に押すと1手ぶん古い作りかけが残っていた欠陥の直し。 */}
        <button onClick={async () => { await flushDraft(); onRun({ project, images, chapters, words: wordsMap(wordsCap.kept) }); }} disabled={busy || !project.clips.length}
          className="px-3 py-1.5 min-h-[36px] rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-600 font-bold text-sm">▶ 書き出す</button>
        <button onClick={onClose} className="px-2 py-1.5 min-h-[36px] rounded bg-white/10 font-bold text-sm">閉じる</button>
      </div>

      <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
        {/* 左: プレビュー + 帯 */}
        <div className="flex-1 min-h-0 flex flex-col p-2 gap-2">
          <div ref={frameRef} className="flex-1 min-h-0 flex items-center justify-center bg-black rounded-lg relative overflow-hidden">
            {/* ⚠⚠ 拡大は **この箱ごと**。canvas と 描く層が一緒に大きくなるので、印の位置は勝手に合う。
                ⚠⚠ 大きさは previewFit(枠を測って出した実寸)で決める。
                  max-w/max-h は **はみ出し止め** としてだけ残す(これだけでは伸びない)。 */}
            <div className="relative max-w-full max-h-full"
              style={{
                width: previewFit ? `${previewFit.width}px` : undefined,
                height: previewFit ? `${previewFit.height}px` : undefined,
                aspectRatio: `${previewDims.width} / ${previewDims.height}`,
                transform: `translate(${viewPan.x * 100}%, ${viewPan.y * 100}%) scale(${viewZoom})`,
                transformOrigin: 'center center',
              }}>
              <canvas ref={canvasRef} width={previewDims.width} height={previewDims.height} className="w-full h-full object-contain block" />
              {/* ✋ 見る場所を動かす層。⚠描く層より **下**。描いている時は上の「✋動かす」で入れ替える */}
              {panLayerOn && (
                <div className="absolute inset-0" style={{ touchAction: 'none', cursor: 'grab' }}
                  onPointerDown={panDown} onPointerMove={panMove} onPointerUp={panUp} onPointerCancel={panUp} />
              )}
              {/* 印を描く層。
                  ⚠⚠ ここに出るのは **もう project に入っている印**。なぞって指を離した時点で入る。
                    「描いただけでどこにも入っていない印」は作らない(黙って消える元)。
                  ⚠paintedBelow: 下の canvas が同じ印を書き出しと同じ道で描いているので、
                    この層では描かない(描くと二重になる)。動かす途中は onPreview で下が付いてくる。 */}
              {tool === 'mark' && !rectMode && !panLayerOn && (
                <MarkCanvas targetRef={canvasRef} marks={markEdit.marks}
                  onChange={(n) => applyMarks(n, false)} onPreview={(n) => applyMarks(n, true)}
                  paintedBelow selected={markSel} onSelect={setMarkSel}
                  shape={shape} color={markColor} width={markWidth} max={8} />
              )}
              {rectMode && !panLayerOn && (
                <RectPicker targetRef={canvasRef}
                  rect={rectMode === 'crop' ? project.crop : null}
                  label={rectMode === 'crop' ? '残したい所をなぞる'
                    : rectEdit ? '場所を置き直します（増えません）— なぞってください'
                      : rectMode === 'mosaic' ? '隠したい所をなぞる' : '見せたい所をなぞる'}
                  onChange={(r) => {
                    if (rectMode === 'crop') { push({ ...project, crop: normCrop(r) }); setRectMode(null); return; }
                    // ⚠⚠ 「場所をやり直す」から来た時は **置き換える**。
                    //   ここで addOverlay を呼んでいたので、やり直すたびに1個ずつ増えていた。
                    if (rectEdit) {
                      push(patchOverlay(project, rectEdit, { rect: r }));
                      setMsg('場所を置き直しました（新しくは増えていません）。');
                      setRectEdit(''); setRectMode(null); return;
                    }
                    addRectOverlay(rectMode, r);
                  }} />
              )}
            </div>
            {/* 🔍 画面だけの拡大。⚠拡大する箱の **外** に置く(中に入れると操作ボタンまで一緒に大きくなる) */}
            <div className="absolute top-1 right-1 z-30 flex flex-col items-end gap-1">
              <div className="flex items-center gap-1 bg-black/65 rounded-lg p-1">
                <span className="text-xs font-bold text-white px-1 tabular-nums">画面 {Math.round(viewZoom * 100)}%</span>
                <button onClick={() => zoomStep(-1)} disabled={viewZoom <= VIEW_ZOOMS[0]} title="画面だけ小さく見る"
                  className="px-2 py-2 min-h-[40px] rounded bg-white/15 hover:bg-white/25 disabled:opacity-30 text-white font-bold text-sm">🔍－</button>
                <button onClick={() => zoomStep(1)} disabled={viewZoom >= VIEW_ZOOMS[VIEW_ZOOMS.length - 1]} title="画面だけ大きく見る（細かい所を見る）"
                  className="px-2 py-2 min-h-[40px] rounded bg-white/15 hover:bg-white/25 disabled:opacity-30 text-white font-bold text-sm">🔍＋</button>
                <button onClick={() => setZoom(1)} title="画面の拡大を等倍(100%)に戻す"
                  className="px-2 py-2 min-h-[40px] rounded bg-white/15 hover:bg-white/25 text-white font-bold text-sm">⤢ 等倍に戻す</button>
              </div>
              {viewZoom > 1 && (
                <>
                  {drawLayerOn && (
                    <button onClick={() => setPanMode(m => !m)}
                      className={`px-2 py-2 min-h-[40px] rounded-lg font-bold text-sm ${panMode ? 'bg-amber-400 text-slate-900' : 'bg-black/65 text-white'}`}
                      title={panMode ? '描くのに戻す' : '見る場所をずらす（指でつまんで動かす）'}>
                      {panMode ? '✍ 描く' : '✋ 動かす'}
                    </button>
                  )}
                  <span className="bg-black/65 text-white text-3xs font-bold rounded px-1.5 py-0.5">
                    ※大きく見ているだけです。書き出す動画は変わりません
                  </span>
                </>
              )}
            </div>
          </div>

          {/* 送り */}
          <div className="shrink-0 flex items-center gap-1 flex-wrap">
            <button onClick={togglePlay} className="px-3 py-2 min-h-[40px] rounded-lg bg-white text-slate-800 font-bold text-sm">{playing ? '⏸' : '▶'}</button>
            <button onClick={() => step(-30)} className="px-2 py-2 min-h-[40px] rounded bg-slate-700 text-white font-bold text-sm" title="1秒もどる">⏪1秒</button>
            <button onClick={() => step(-1)} className="px-2 py-2 min-h-[40px] rounded bg-slate-700 text-white font-bold text-sm" title="1コマもどる">◀1コマ</button>
            <button onClick={() => step(1)} className="px-2 py-2 min-h-[40px] rounded bg-slate-700 text-white font-bold text-sm" title="1コマすすむ">1コマ▶</button>
            <button onClick={() => step(30)} className="px-2 py-2 min-h-[40px] rounded bg-slate-700 text-white font-bold text-sm" title="1秒すすむ">1秒⏩</button>
            <span className="ml-1 text-sm text-white font-mono tabular-nums">{fmtT(tOut)} / {fmtT(total)}</span>
            <button onClick={() => setLoop(l => !l)} className={`px-2 py-2 min-h-[40px] rounded font-bold text-sm ${loop ? 'bg-emerald-500 text-white' : 'bg-slate-700 text-white'}`} title="終わりまで行ったら頭から">🔁</button>
            <button onClick={doStill} className="px-2 py-2 min-h-[40px] rounded bg-slate-700 text-white font-bold text-sm" title="いまの1枚を写真にする">🖼 写真</button>
            {/* ⚠横の余白だけ px-3→px-2 に詰めてある。文字を12px→14pxに上げた分、この1行が
                   **1024px幅の画面(iPad 横)で2行に折り返して、絵がその分縮んでいた**(実測 672px必要／
                   使えるのは668px)。詰めると664pxで収まる。文字と押せる高さ(40px)は下げていない。 */}
            <button onClick={doSplit} className="ml-auto px-2 py-2 min-h-[40px] rounded-lg bg-amber-500 text-slate-900 font-bold text-sm" title="いまの位置で切る (S)">✂ ここで切る</button>
            {/* ⚠⚠ ここは **時間の帯** を横に広げる方。絵を大きく見るのは絵の右上の「🔍」。
                同じ「🔍＋」を両方に付けていたので、押しても絵が大きくならず混乱していた。 */}
            <div className="flex items-center gap-1">
              <button onClick={() => setZoomX(z => clamp(z / 1.6, 1, 12))} className="px-2 py-2 min-h-[40px] rounded bg-slate-700 text-white font-bold text-sm" title="時間の帯を縮める">帯－</button>
              <button onClick={() => setZoomX(z => clamp(z * 1.6, 1, 12))} className="px-2 py-2 min-h-[40px] rounded bg-slate-700 text-white font-bold text-sm" title="時間の帯を広げる（切る所を細かく決める）">帯＋</button>
            </div>
          </div>

          {/* ▶ 要点だけ見る（清水さん 2026-08-16）
              「要点だけ見せる専用モードでそれ以外は倍速(自分で決めれる)が必要かな」
              「そこで一旦停止で押したら続くと」
              ⚠⚠ **見せ方だけ**。動画は作り変えない(書き出した動画は今までどおり)。
              ⚠止まる所 = ⏸止め絵 / 🖼画像 / 📍章。流したままの印や文字では止めない
                (数が多く、止まってばかりで見ていられない)。
              ⚠⚠ ここに残すのは **操作**(入切と「▶ 続き」)だけ。
                設定(要点以外の速さ・次の要点・但し書き)は「👁 見せ方」タブへ移した。
                絵のすぐ下が設定で埋まると、肝心の帯と絵が押し下げられる為。 */}
          <div className="shrink-0 rounded-lg bg-slate-800 p-1.5 space-y-1" data-keyonly={keyOnly ? '1' : '0'}>
            <div className="flex items-center gap-1.5 flex-wrap">
              <button onClick={toggleKeyOnly} disabled={!moments.length}
                title={moments.length ? '要点で自動的に止まり、それ以外は倍速で流します（画面の見え方だけ）' : '⏸止め絵・🖼画像・📍章 を作ると使えます'}
                className={`px-3 py-2 min-h-[40px] rounded-lg font-bold text-sm ${keyOnly ? 'bg-amber-400 text-slate-900' : 'bg-white/15 text-white'} disabled:bg-slate-700 disabled:text-white/40`}>
                {keyOnly ? '✓ 要点だけ見る（切る）' : '▶ 要点だけ見る'}
              </button>
              <span className="text-xs text-white/70">
                {moments.length ? `要点 ${moments.length}か所（⏸止め絵・🖼画像・📍章）` : '要点（⏸止め絵・🖼画像・📍章）がまだありません'}
              </span>
              {keyOnly && showOn && (
                <span className="ml-auto text-2xs text-white/60">速さ・次の要点は「👁 見せ方」タブ</span>
              )}
            </div>
            {/* ⏸ 止まった所と「▶ 続き」= 操作。⚠ここは左に残す(見ている絵のすぐ下で押せる事が肝)。 */}
            {keyOnly && stopAt && (
              <div className="flex items-center gap-1.5 flex-wrap text-xs text-white">
                <span className="shrink-0 bg-amber-400 text-slate-900 font-bold rounded px-1.5 py-0.5">⏸ ここで止まりました</span>
                <span className="flex-1 min-w-0 truncate font-bold">{stopAt.icon} {stopAt.title}（{stopAt.atText}）</span>
                <button onClick={goOn} className="shrink-0 px-3 py-2 min-h-[40px] rounded-lg bg-emerald-500 text-white font-bold text-sm">▶ 続き</button>
              </div>
            )}
            {/* ⚠⚠ 「👁 見せ方」タブが出ない時(端末の動画を編集している時)は、
                設定の行き場が無くなる。その時だけ、ここに出す(部品は同じ物1つ)。 */}
            {keyOnly && !showOn && (
              <KeyOnlySettings tone="dark"
                moments={moments} momentNow={momentNow} momentNext={momentNext}
                playing={playing} viewRate={viewRate}
                skipSpeed={skipSpeed} onSkipSpeed={setSkipSpeed} onSeek={seek} />
            )}
          </div>

          {/* 帯 */}
          <div className="shrink-0 overflow-x-auto pb-1">
            {/* ⚠帯は番号で描いている。選びは id で持っているので、渡す時だけ番号に直す。 */}
            <Timeline project={project} tOut={tOut} onSeek={seek} thumbs={thumbs} waves={waves} srcDur={srcDur}
              sel={selForBar}
              onSelect={(s) => (s?.type === 'clip' ? selectClipAt(project, s.index) : setSel(s))}
              onTrim={onTrim} onMoveOverlay={onMoveOverlay} zoomX={zoomX} />
          </div>
          {waveBusy && <div className="shrink-0 text-3xs text-white/60">音の波形を作っています…（できると、しゃべっている所が緑の山で見えます）</div>}
          {msg && <div className="shrink-0 text-2xs bg-amber-100 text-amber-800 rounded px-2 py-1">{msg}</div>}
          {stillUrl && (
            <div className="shrink-0 flex items-center gap-2 flex-wrap bg-white rounded-lg p-1.5">
              <button type="button" onClick={() => setStillBig(true)} title="押すと画面いっぱいで確かめられます"
                className="h-24 shrink-0 rounded border border-slate-200 overflow-hidden bg-slate-100">
                <img src={stillUrl} alt="" className="h-full w-auto object-contain block" />
              </button>
              <a href={stillUrl} download={`写真_${Math.round(tOut)}秒.jpg`} className="px-3 py-2 min-h-[40px] rounded-lg bg-slate-800 text-white font-bold text-xs">⬇ 写真を保存</a>
              <button onClick={() => { try { URL.revokeObjectURL(stillUrl); } catch { /* noop */ } setStillUrl(''); setStillBig(false); }} className="px-2 py-2 min-h-[40px] rounded bg-slate-100 text-slate-600 font-bold text-xs">✕</button>
            </div>
          )}
          {/* 🖼 1コマの全画面。⚠編集室が z-[600]・📄作業標準が z-[640] なので 650 以上でないと
              閉じるボタンが押せない(下に潜って反応しない)。 */}
          {stillBig && stillUrl && (
            <div className="fixed inset-0 bg-black/95 flex flex-col" style={{ zIndex: 650 }}>
              <div className="shrink-0 flex items-center gap-2 p-2">
                <div className="text-white text-xs font-bold">🖼 切り出した1コマ（作業標準に載せる前に、ここで大きく確かめる）</div>
                <a href={stillUrl} download={`写真_${Math.round(tOut)}秒.jpg`} className="ml-auto px-3 py-2 min-h-[40px] rounded-lg bg-white text-slate-900 font-bold text-xs">⬇ 写真を保存</a>
                <button onClick={() => setStillBig(false)} className="px-3 py-2 min-h-[40px] rounded-lg bg-white/20 text-white font-bold text-xs">✕ 閉じる</button>
              </div>
              <div className="flex-1 min-h-0 p-2">
                <img src={stillUrl} alt="" className="w-full h-full object-contain" />
              </div>
            </div>
          )}
        </div>

        {/* 右: 道具 */}
        <div className="lg:w-[340px] shrink-0 bg-white lg:h-full overflow-y-auto p-2 space-y-2">
          {/* ⚠道具の名札は **一番よく押す所** なので、他より1段大きくする(10px→12px)。
                 4列のまま。名前が長い物(🔦 ここを見て 等)は2行に折り返して収まる
                 (min-h-[44px] の中に2行が入る)。列は増やさない＝押す場所が動かない。 */}
          <div className="grid grid-cols-4 gap-1">
            {TOOLS.map(([k, label]) => (
              <button key={k} onClick={() => { setTool(k); setRectMode(null); setRectEdit(''); }}
                className={`px-0.5 py-2 min-h-[44px] rounded-lg text-xs font-bold leading-tight ${tool === k ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'}`}>{label}</button>
            ))}
          </div>

          {/* ✂ 切る・消す */}
          {tool === 'cut' && (
            <div className="space-y-1.5">
              <div className="text-2xs text-slate-500">▶ 帯の上をタップして位置を決め、「✂ここで切る」。いらない部品を選んで「🗑この部品を消す」。</div>
              <button onClick={doSplit} className="w-full py-2.5 rounded-lg bg-amber-500 text-slate-900 font-bold text-sm">✂ いまの位置で切る</button>
              {/* ⚠「選んだ物」が何なのかを名前で出す。番号だけだと、消してから違う物だったと気づく。 */}
              <button onClick={doDelete} disabled={project.clips.length <= 1 && sel?.type !== 'overlay'} className="w-full py-2.5 rounded-lg bg-rose-600 disabled:bg-slate-200 text-white font-bold text-sm">
                🗑 選んだ物を消す
                <span className="block text-3xs font-normal opacity-90">
                  {sel?.type === 'overlay' ? 'いま選んでいるのは 重ね（文字・印・目隠し）です'
                    : selIndex >= 0 ? `いま選んでいるのは 部品 ${selIndex + 1}（${selClip?.type === 'freeze' ? '⏸止め絵' : selClip?.type === 'image' ? '🖼画像' : '映像'}）です`
                      : '部品を選んでください'}
                </span>
              </button>
              <button onClick={doSilenceCut} className="w-full py-2.5 rounded-lg bg-emerald-600 text-white font-bold text-sm">🤫 黙っている所をまとめて消す</button>
              <div className="text-3xs text-slate-400">※「黙っている所」は音の波形から自動で見つけます。消した後は必ず見直してください。</div>
              <div className="pt-1 space-y-1">
                {rows.map(r => (
                  /* ⚠この行は押せる(押すとその部品を選ぶ)+ 中に 0:00〜0:12 の時刻が出る
                     → 押す物・読んで判断する数字 なので 12px 以上。中の↑↓✕もここから継ぐ。 */
                  <div key={r.id} className={`flex items-center gap-1 rounded border px-1.5 py-1 text-xs ${r.index === selIndex ? 'border-amber-500 bg-amber-50' : 'border-slate-200'}`}
                    onClick={() => { setSel({ type: 'clip', id: r.id }); seek(r.outStart + 0.05); }}>
                    <span className="shrink-0 font-bold w-6 text-center">{r.type === 'image' ? '🖼' : r.type === 'freeze' ? '⏸' : r.index + 1}</span>
                    <span className="flex-1 min-w-0 truncate">{fmtDur(r.outStart)}〜{fmtDur(r.outEnd)}（{fmtDur(r.outSec)}）{normSpeed(r.speed) !== 1 ? ` ${normSpeed(r.speed)}×` : ''}</span>
                    {/* ⚠並べ替え・削除で **選びがずれない**。選びは番号ではなく id で持っている。 */}
                    <button onClick={(e) => { e.stopPropagation(); push(moveClip(project, r.index, r.index - 1)); }} disabled={r.index === 0} className="px-1.5 py-1 min-h-[30px] bg-slate-100 rounded disabled:opacity-30">↑</button>
                    <button onClick={(e) => { e.stopPropagation(); push(moveClip(project, r.index, r.index + 1)); }} disabled={r.index === rows.length - 1} className="px-1.5 py-1 min-h-[30px] bg-slate-100 rounded disabled:opacity-30">↓</button>
                    <button onClick={(e) => { e.stopPropagation(); removeClipAt(r.index); }} className="px-1.5 py-1 min-h-[30px] bg-rose-100 text-rose-600 rounded font-bold">✕</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ⏩ 速さ */}
          {tool === 'speed' && (
            <div className="space-y-1.5">
              <div className="text-2xs text-slate-500">選んだ部品の速さを変えます。<b>動画そのものに焼き込む</b>ので、見る人の操作は要りません。</div>
              {!selClip || selClip.type !== 'video'
                ? <div className="text-xs text-slate-400">映像の部品を選んでください（帯をタップ）。</div>
                : (
                  <>
                    {/* ⚠いまの速さ = 読んで判断する数字。12px 以上。 */}
                    <div className="text-xs font-bold text-slate-700">部品 {selIndex + 1}：いま {normSpeed(selClip.speed)}×</div>
                    <div className="grid grid-cols-3 gap-1">
                      {SPEEDS.map(s => (
                        <button key={s} onClick={() => push(patchClip(project, selIndex, { speed: s }))}
                          className={`py-2 min-h-[40px] rounded font-bold text-xs ${normSpeed(selClip.speed) === s ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'}`}>{s}×</button>
                      ))}
                    </div>
                    <div className="text-3xs text-slate-400">※ 1より小さい＝スロー。音は早送り/スローに合わせて上がり下がりします（テープと同じ）。</div>
                  </>
                )}
            </div>
          )}

          {/* 👁 見せ方（レシピ編集を編集室へ引き取った所。清水さん 2026-08-16「編集室に統一しろ」）
              ⚠⚠ ここで作る物は **動画に焼き込まれない**。すぐ上の「⏩ 速さ」は焼き込む方。
                隣に並べてあるのはわざと(離すと必ず取り違える)。言葉で必ず区別する。
              ⚠⚠ 秒は **元の動画の秒**。編集室の時計は「出来上がりの秒」なので必ず変換する。 */}
          {tool === 'show' && showOn && (
            <div className="space-y-2">
              <div className="text-xs font-bold text-amber-900 bg-amber-50 border-2 border-amber-400 rounded-lg p-2 leading-snug" data-show-policy="1">
                ⚠ ここで付ける <b>⏸ 止めて見せる・⏭ とばす・⚡ 区間倍速</b> は、
                <b>動画そのものには入りません</b>。<b>見せる時だけ</b>効きます。
                <span className="block mt-1 font-normal text-slate-700">
                  動画に焼き込みたい時は「⏸ 止め絵（⭕印）」「⏩ 速さ」を使ってください。
                </span>
              </div>
              <div className="text-xs text-slate-600">
                付ける相手：<b className="break-all">{recipeFileName || recipeFileId}</b>
              </div>
              <div>
                <div className="text-xs font-bold text-slate-700">この動画の題名</div>
                <input value={showTitle} onChange={(e) => { setShowTitle(e.target.value.slice(0, 60)); setShowSaved(''); }}
                  data-show-title="1" placeholder="例: 端子台の締め付け（3号機）"
                  className="w-full border-2 border-slate-300 rounded-lg px-2 py-2 min-h-[44px] text-sm" />
              </div>

              {/* いまどの場面か。⚠付けられない時は、押す前に理由を出す。 */}
              <div className={`rounded-lg p-2 text-xs ${showSrcNow == null ? 'bg-rose-50 border border-rose-300 text-rose-800' : 'bg-slate-100 text-slate-700'}`} data-show-now="1">
                {showSrcNow == null
                  ? <span><b>ここには付けられません。</b>{showWhyNo}</span>
                  : <span>いま見ている場面 ＝ <b>元の動画の {fmtDur(showSrcNow)}</b>（編集室の帯では {fmtDur(tOut)}）</span>}
              </div>

              <button onClick={addShowPause} disabled={showSrcNow == null} data-show-addpause="1"
                className="w-full py-3 min-h-[52px] rounded-xl bg-amber-500 disabled:bg-slate-200 disabled:text-slate-400 text-white font-black text-sm">
                ⏸ ここで止めて見せる
                <span className="block text-2xs font-normal opacity-90">見る人はここで止まり、ひとことを読んでから続きへ進みます</span>
              </button>
              {!showPending ? (
                /* ⚠4つの速さを半分の幅に詰めると、タブレットで文字がはみ出て潰れる。
                   ⏭は1行、⚡は4つで1行に分ける(押す所は指の幅を確保する)。 */
                <div className="space-y-1.5">
                  <button onClick={() => startShowRange('skip')} disabled={showSrcNow == null} data-show-skip="1"
                    title="動画は消えません。見る時に飛ばすだけです"
                    className="w-full py-2.5 min-h-[48px] rounded-xl bg-slate-600 disabled:bg-slate-200 disabled:text-slate-400 text-white font-bold text-sm">
                    ⏭ ここから飛ばす
                  </button>
                  <div className="grid grid-cols-4 gap-1">
                    {SHOW_SPEEDS.map(s => (
                      <button key={s} onClick={() => startShowRange('speed', s)} disabled={showSrcNow == null}
                        title={`ここから ${s}倍速で流す（終わりはもう一度押して決めます）`}
                        className="py-2.5 min-h-[48px] rounded-xl bg-sky-700 disabled:bg-slate-200 disabled:text-slate-400 text-white font-bold text-xs">⚡{s}×</button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex gap-1.5">
                  <button onClick={endShowRange} data-show-end="1"
                    className="flex-[2] py-2.5 min-h-[48px] rounded-xl bg-emerald-600 text-white font-bold text-xs">
                    ✅ ここまで（{SHOW_META[showPending.type].icon}{showPending.speed ? `${showPending.speed}×` : ''} {fmtDur(showPending.start)}〜）
                  </button>
                  <button onClick={() => setShowPending(null)} className="flex-1 py-2.5 min-h-[48px] rounded-xl bg-slate-100 text-slate-600 font-bold text-xs">やめる</button>
                </div>
              )}

              {/* 作った物の一覧。⚠⚠ 清水さん「一回作ったら消すことも編集もできない」
                  → 1件ずつ **消せる・直せる・その場面へ飛べる**。ここは必ず在ること。 */}
              <div className="space-y-1.5">
                <div className="text-xs font-bold text-slate-700">この動画に付けた見せ方（{showSorted.length}件）</div>
                {showSorted.length === 0 && (
                  <div className="text-xs text-slate-400 border border-dashed border-slate-300 rounded-lg p-3 text-center">
                    まだありません。再生して、止めて見せたい場面で上のボタンを押してください。
                  </div>
                )}
                <div className="space-y-1 max-h-[40vh] overflow-y-auto pr-0.5" data-show-list="1">
                  {showSorted.map(e => {
                    const meta = SHOW_META[e.type] || SHOW_META.pause;
                    const cut = showOutOf(e.start) == null;
                    const open = showOpen === e.id;
                    return (
                      <div key={e.id} className={`rounded-lg border ${open ? 'border-slate-800 bg-slate-50' : 'border-slate-200 bg-white'}`}>
                        {/* ⚠⚠ 1行に詰め込まない。右の列は狭く、詰めると名前が0幅になって
                               どれがどれか分からなくなる。上=何を、下=どうする、で2段に分ける。 */}
                        <div className="px-1.5 py-1.5 space-y-1">
                          <div className="flex items-center gap-1">
                            <span className="shrink-0 text-xs font-black tabular-nums" style={{ color: meta.c }}>
                              {meta.icon} {fmtDur(e.start)}{e.end != null ? `〜${fmtDur(e.end)}` : ''}
                            </span>
                            <span className="flex-1 min-w-0 truncate text-xs text-slate-700">
                              {e.type === 'pause' ? (e.label || e.text || '(名前なし)') : meta.label}
                              {e.type === 'speed' ? ` ${e.speed || 1.5}×` : ''}
                              {(e.marks || []).length > 0 ? <span className="ml-1 font-bold text-rose-600">⭕{e.marks.length}</span> : null}
                            </span>
                          </div>
                          {/* ⚠切り取った所は「飛べない」。押す前に理由が見えるように、ここに出す。 */}
                          {cut && (
                            <div className="text-2xs font-bold text-amber-900 bg-amber-100 rounded px-1.5 py-1">
                              ⚠ この場面は、いまの編集で<b>切り取られています</b>（見せ方そのものは残っています）
                            </div>
                          )}
                          <div className="flex items-center gap-1">
                            {/* ⚠⚠ 押す物は 12px 以上(2026-08-16)。現場はタブレット+手袋で 11px は読めない。
                                   3つとも 340px の列に1行で収まる(実測: 一番長い「▶ この場面へ」で 12px でも折り返さない)。 */}
                            <button onClick={() => showSeekSrc(e.start)} title="その場面へ飛ぶ"
                              className="flex-1 py-2 min-h-[40px] rounded-lg bg-emerald-100 text-emerald-800 font-bold text-xs">▶ この場面へ</button>
                            <button onClick={() => setShowOpen(open ? '' : e.id)}
                              title={open ? 'この行を畳む（保存ではありません）' : 'この行を開いて直す'}
                              className={`flex-1 py-2 min-h-[40px] rounded-lg font-bold text-xs ${open ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'}`}>
                              {open ? '✓ 閉じる' : '✎ 直す'}
                            </button>
                            <button onClick={() => delShowEvt(e.id)}
                              className="px-3 py-2 min-h-[40px] rounded-lg bg-rose-100 text-rose-700 font-bold text-xs">✕ 消す</button>
                          </div>
                        </div>
                        {open && (
                          <div className="px-1.5 pb-2 space-y-1.5">
                            {/* ⚠中身は全部 押す物(−0.5/+0.5/⇤ いまここ)。12px 以上。flex-wrap なので溢れない。 */}
                            <div className="flex flex-wrap items-center gap-1 text-xs">
                              <span className="font-bold text-slate-500">始まり</span>
                              <button onClick={() => adjShowTime(e.id, 'start', -0.5)} className="px-2 py-1.5 min-h-[34px] rounded bg-slate-100 text-slate-600 font-bold">−0.5</button>
                              <button onClick={() => adjShowTime(e.id, 'start', 0.5)} className="px-2 py-1.5 min-h-[34px] rounded bg-slate-100 text-slate-600 font-bold">+0.5</button>
                              <button onClick={() => showTimeHere(e.id, 'start')} disabled={showSrcNow == null} className="px-2 py-1.5 min-h-[34px] rounded bg-sky-100 text-sky-800 disabled:bg-slate-100 disabled:text-slate-400 font-bold">⇤ いまここ</button>
                            </div>
                            {e.end != null && (
                              <div className="flex flex-wrap items-center gap-1 text-xs">
                                <span className="font-bold text-slate-500">終わり</span>
                                <button onClick={() => adjShowTime(e.id, 'end', -0.5)} className="px-2 py-1.5 min-h-[34px] rounded bg-slate-100 text-slate-600 font-bold">−0.5</button>
                                <button onClick={() => adjShowTime(e.id, 'end', 0.5)} className="px-2 py-1.5 min-h-[34px] rounded bg-slate-100 text-slate-600 font-bold">+0.5</button>
                                <button onClick={() => showTimeHere(e.id, 'end')} disabled={showSrcNow == null} className="px-2 py-1.5 min-h-[34px] rounded bg-sky-100 text-sky-800 disabled:bg-slate-100 disabled:text-slate-400 font-bold">いまここ ⇥</button>
                              </div>
                            )}
                            {e.type === 'pause' && (
                              <div className="space-y-1.5">
                                <input value={e.label || ''} onChange={(ev) => patchShowEvt(e.id, { label: ev.target.value.slice(0, 40) })}
                                  placeholder="ここで見せる事の名前（例: 端子の締付け）"
                                  className="w-full border-2 border-amber-300 bg-amber-50 rounded-lg px-2 py-2 min-h-[44px] text-sm font-bold" />
                                <input value={e.text || ''} onChange={(ev) => patchShowEvt(e.id, { text: ev.target.value.slice(0, 120) })}
                                  placeholder="ひとこと（例: 左手で押さえながら締める）"
                                  className="w-full border border-slate-300 rounded-lg px-2 py-2 min-h-[44px] text-sm" />
                                <div className="flex items-center gap-1.5 text-xs">
                                  <span className="font-bold text-slate-600 shrink-0">自動で続き</span>
                                  <select value={Number(e.hold) || 0} onChange={(ev) => patchShowEvt(e.id, { hold: Number(ev.target.value) })}
                                    aria-label="止めたあと、何秒で自動的に続きへ行くか"
                                    className="border border-slate-300 rounded-lg px-2 py-2 min-h-[40px] font-bold">
                                    {SHOW_HOLDS.map(n => <option key={n} value={n}>{n === 0 ? '押すまで待つ' : `${n}秒後`}</option>)}
                                  </select>
                                </div>
                                {/* ⚠⚠ ⭕印は消さずに残す。ここで置き直せない事を **黙らずに** 書く
                                       (回転・切り抜きをしていると、編集室の絵と元の動画で場所がズレる為)。 */}
                                <div className="text-2xs text-slate-600 bg-slate-100 rounded p-1.5">
                                  ⭕印 {(e.marks || []).length}個 ＝ そのまま残ります。
                                  <b>印の置き直しは、この動画を 🎬 で開いた時にできます</b>（編集室の絵は回転・切り抜きが入っている事があり、ここで置くと場所がズレる為）。
                                </div>
                              </div>
                            )}
                            {e.type === 'speed' && (
                              <div className="flex items-center gap-1 flex-wrap">
                                <span className="text-xs font-bold text-slate-600 shrink-0">速さ</span>
                                {SHOW_SPEEDS.map(s => (
                                  <button key={s} onClick={() => patchShowEvt(e.id, { speed: s })}
                                    className={`px-3 py-2 min-h-[40px] rounded-lg font-bold text-xs ${(Number(e.speed) || 1.5) === s ? 'bg-sky-700 text-white' : 'bg-slate-100 text-slate-600'}`}>{s}×</button>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 📍 工程の頭出し。⚠「章」とは呼ばない — 動画は分けず、飛ぶだけだから。
                  ⚠⚠ 編集室の「📍 章」タブとは別物(あちらは書き出しでファイルを分ける)。 */}
              <div className="space-y-1.5 border-t border-slate-200 pt-2">
                <div className="text-xs font-bold text-slate-700">📍 工程の頭出し（{showChapters.length}）</div>
                <div className="text-2xs text-emerald-900 bg-emerald-50 border border-emerald-300 rounded p-1.5 leading-snug">
                  検査画面でその工程の 🎬 を押すと、<b>ここまで飛びます</b>。
                  <b className="block">動画は分けていません（1本のままです）。</b>
                </div>
                {(steps || []).length === 0 ? (
                  <div className="text-2xs text-slate-400">工程が分かりません（検査画面から開くと選べます）。</div>
                ) : (
                  <select value="" disabled={showSrcNow == null} data-show-addchapter="1"
                    onChange={(ev) => { if (ev.target.value) addShowChapter(ev.target.value); ev.target.value = ''; }}
                    className="w-full border-2 border-slate-300 rounded-lg px-2 py-2 min-h-[44px] text-sm disabled:bg-slate-100">
                    <option value="">いまの場面（{showSrcNow == null ? '—' : fmtDur(showSrcNow)}）を頭出しにする工程を選ぶ…</option>
                    {steps.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                )}
                {/* ⚠state をレンダー中に並べ替えない(写してから並べる)。消すのは id なので番号はずれない。 */}
                {[...showChapters].sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0)).map(c => (
                  <div key={c.id} className="flex items-center gap-1 border border-slate-200 rounded-lg px-1.5 py-1.5">
                    <button onClick={() => showSeekSrc(c.start)} className="shrink-0 text-xs font-bold text-emerald-800 tabular-nums">{fmtDur(c.start)}</button>
                    <span className="flex-1 min-w-0 truncate text-xs text-slate-700">{c.label || c.stepKey}</span>
                    <button onClick={() => delShowChapter(c.id)} className="shrink-0 px-2 py-2 min-h-[36px] rounded bg-rose-100 text-rose-700 font-bold text-xs">✕</button>
                  </div>
                ))}
              </div>

              {/* この動画を出す工程 */}
              <div className="space-y-1.5 border-t border-slate-200 pt-2">
                <div className="text-xs font-bold text-slate-700">この動画を出す工程（押して付け外し）</div>
                <div className="text-2xs text-slate-500">選んだ工程の検査画面に 🎬 が出ます。</div>
                {(steps || []).length === 0 ? (
                  <div className="text-2xs text-slate-400">工程が分かりません（検査画面から開くと選べます）。</div>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {steps.map(s => (
                      <button key={s.key} onClick={() => toggleShowStep(s.key)} data-show-step={s.key}
                        className={`px-2 py-2 min-h-[40px] rounded-lg border-2 font-bold text-xs ${showStepKeys.includes(s.key) ? 'bg-sky-600 text-white border-sky-600' : 'bg-white text-slate-600 border-slate-300'}`}>
                        {s.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* ▶ 要点だけ見る の設定（絵のすぐ下から移してきた分）。
                  ⚠入切と「▶ 続き」は左の絵の下のまま(押す物は絵の近くに置く)。 */}
              <div className="space-y-1.5 border-t border-slate-200 pt-2">
                <div className="text-xs font-bold text-slate-700">▶ 要点だけ見る（編集室での見え方）</div>
                {keyOnly ? (
                  <KeyOnlySettings tone="light"
                    moments={moments} momentNow={momentNow} momentNext={momentNext}
                    playing={playing} viewRate={viewRate}
                    skipSpeed={skipSpeed} onSkipSpeed={setSkipSpeed} onSeek={seek} />
                ) : (
                  <div className="text-2xs text-slate-500">
                    絵の下の <b>「▶ 要点だけ見る」</b>を入れると、要点（⏸止め絵・🖼画像・📍章）で自動的に止まります。
                    要点以外の速さは、入れた後にここで選べます。
                  </div>
                )}
              </div>

              {/* 💾 保存。⚠⚠ ここを押すまで、直した事はこの動画に残らない。必ず本文で言う。 */}
              <div className="border-t border-slate-200 pt-2 space-y-1.5">
                <div className="text-2xs text-slate-600">
                  直した事は <b>この下の「💾 見せ方を保存」を押すまで残りません</b>。各行の「✓ 閉じる」は畳むだけです。
                </div>
                <button onClick={saveShow} disabled={showSaving} data-show-save="1"
                  className="w-full py-3 min-h-[52px] rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-400 text-white font-black text-sm">
                  {showSaving ? '保存しています…' : '💾 見せ方を保存'}
                </button>
                {showSaved && <div className="text-xs font-bold text-emerald-700">{showSaved}</div>}
              </div>
            </div>
          )}

          {/* 📋 編集メモ: 作った物が「何秒に何を」で1本に並ぶ。
              ⚠⚠ ここが無かったせいで「要点履歴作っていったのにない」になった(2026-08-15)。
              ⚠開くのは1つだけ。増えても下に溜まって伸びない(レシピ編集と同じ形・同じ言葉)。 */}
          {tool === 'memo' && (
            <div className="space-y-1.5">
              <div className="text-2xs text-slate-500">作った物ぜんぶが、時刻の順に並びます。押すとその物を選んで、その場面へ飛びます。</div>
              {memoRows.length === 0 ? (
                <div className="text-xs text-slate-400 border border-dashed border-slate-300 rounded-lg p-3 text-center">
                  まだ何も作っていません。<br />⭕印・💬文字・⏸止め絵・🖼画像・📍章 を作ると、ここに溜まります。
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2 text-2xs flex-wrap">
                    {/* ⚠件数は読んで判断する数字 → 12px。隣の注意書きは説明なので 11px のまま
                           (注意書きまで上げると場所を食って、絵が縮む)。 */}
                    <span className="text-xs font-bold text-slate-600">{memoRows.length}件</span>
                    {memoNoName > 0 && (
                      <span className="text-amber-800 bg-amber-50 border border-amber-300 rounded px-1.5 py-0.5">
                        ⚠ 名前なし {memoNoName}件（名前が空だと🔎探すにも📄作業標準にも出ません）
                      </span>
                    )}
                  </div>
                  <div className="space-y-1 max-h-[46vh] overflow-y-auto pr-0.5">
                    {memoRows.map(r => (
                      <div key={r.key} className={`rounded-lg border ${openMemo === r.key ? 'border-slate-800 bg-slate-50' : 'border-slate-200 bg-white'}`}>
                        <button data-memo-row={r.kind} onClick={() => { setOpenMemo(openMemo === r.key ? '' : r.key); pickMemo(r); }}
                          className="w-full flex items-center gap-1.5 px-2 py-2 min-h-[44px] text-left">
                          {/* ⚠時刻 → 12px。w-12(48px) に 12px の "12:34" は 36px で入る(実測)。 */}
                          <span className="tabular-nums text-xs font-black text-slate-500 shrink-0 w-12">{r.atText}</span>
                          <span className="shrink-0">{r.icon}</span>
                          <span className={`flex-1 min-w-0 truncate text-xs font-bold ${r.noName ? 'text-amber-700' : 'text-slate-800'}`}>{r.title}</span>
                          {r.marks > 0 && <span className="shrink-0 text-3xs text-slate-500">印{r.marks}</span>}
                        </button>
                        {openMemo === r.key && (
                          <div className="px-2 pb-2 space-y-1.5">
                            <div className="text-2xs text-slate-600 break-words">{r.sub}</div>
                            <div className="flex gap-1.5">
                              {/* ⚠⚠ 行の種類ごとに **直せる道具** を開く。
                                  前は 重ねを全部「💬文字」に送っていたので、▩隠す・🔦ここを見て を
                                  押しても直す所が出なかった(押せるのに直せない=壊れて見える)。 */}
                              <button data-memo-edit={r.kind} onClick={() => { pickMemo(r); setTool(memoTool(r.kind)); }}
                                className="flex-1 py-2 min-h-[40px] rounded bg-slate-700 text-white font-bold text-xs">✎ ここを直す</button>
                              <button onClick={() => delMemo(r)}
                                className="px-3 py-2 min-h-[40px] rounded bg-rose-100 text-rose-700 font-bold text-xs">✕ 消す</button>
                            </div>
                            <button onClick={() => setOpenMemo('')}
                              className="w-full py-2 min-h-[40px] rounded bg-slate-100 text-slate-600 font-bold text-xs"
                              title="編集は自動で覚えています。畳んで一覧に戻ります">
                              ✓ 要点を保存して閉じる
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  {/* ⚠「▶書き出す を押した時にも必ず1回書く」= 切った直後に押しても1手ぶん古くならない。 */}
                  <div className="text-3xs text-slate-400">編集は<b>1.5秒ごとに自動で覚えています</b>（閉じても落ちても続きからやれます）。<b>▶書き出す を押した時にも、その場でもう一度覚えます</b>（切った直後に押しても取りこぼしません）。作りかけは<b>動画ごとに別々</b>に残ります。動画に焼き込まれるのは ▶ 書き出し の時です。</div>
                </>
              )}
            </div>
          )}

          {/* ⭕ 印 */}
          {tool === 'mark' && (
            <div className="space-y-1.5">
              <div className="text-2xs text-slate-500">絵の上を<b>なぞって</b>〇や矢印を描きます。<b>動画に焼き込まれる</b>ので、Driveで開いた人にも見えます。</div>
              {/* ⚠⚠ 清水さん(2026-08-15)「〇とかつけて保存したけど、そのデータ見ても〇とかついてなかった」
                  → **なぞって指を離した時点で入る**。押し忘れて消える確定ボタンは無くした。 */}
              <div className="text-2xs font-bold text-emerald-800 bg-emerald-50 border border-emerald-300 rounded-lg px-2 py-1.5" data-mark-policy="1">
                ✅ <b>なぞって指を離した時点で、その印は入ります。</b>別に「確定」を押す必要はありません。<br />
                <span className="font-normal text-slate-600">入った印は 💾作りかけにも ▶書き出しにも そのまま乗ります。まちがえたら「↩ 操作を戻す」。</span>
              </div>
              {/* ⏸/▶ 出し方。⚠ここが今回いちばん大事な選択。
                  ⚠⚠ ⏸止め絵／🖼画像 の上にいる時は、この選択は **効かない**(その絵に直接入る)。
                    効かないのに押せる形で出しておくと「▶を選んだのに止め絵に入った」になる。 */}
              <div className={`rounded-lg border-2 border-slate-300 p-1.5 space-y-1 ${markEdit.where === 'clip' ? 'opacity-60' : ''}`}>
                {markEdit.where === 'clip' && (
                  <div className="text-3xs font-bold text-slate-600 bg-slate-100 rounded px-1.5 py-1">
                    いまは ⏸止め絵／🖼画像 の上にいます。下の ⏸／▶ は<b>効きません</b>（その絵にそのまま入ります）。
                    映像の上へ戻ると効きます。
                  </div>
                )}
                <div className="grid grid-cols-2 gap-1">
                  <button onClick={() => setMarkMode('freeze')}
                    className={`py-2 min-h-[46px] rounded-lg text-xs font-bold leading-tight ${markMode === 'freeze' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'}`}>
                    ⏸ 止めて出す<span className="block text-4xs font-normal opacity-80">おすすめ・ズレない</span>
                  </button>
                  <button onClick={() => setMarkMode('flow')}
                    className={`py-2 min-h-[46px] rounded-lg text-xs font-bold leading-tight ${markMode === 'flow' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'}`}>
                    ▶ 流したまま出す<span className="block text-4xs font-normal opacity-80">動かない物だけ</span>
                  </button>
                </div>
                {markMode === 'freeze' ? (
                  <div className="flex items-center gap-1.5 text-2xs">
                    <span className="font-bold text-slate-600">止める長さ</span>
                    {/* ⚠選ぶ物(押す物)+秒数 → 12px。まわりの説明は 11px のまま。 */}
                    <select aria-label="これから止める長さ（秒）" value={markHold} onChange={(e) => setMarkHold(Number(e.target.value))}
                      className="border border-slate-300 rounded px-1.5 py-1.5 min-h-[36px] text-xs font-bold">
                      {HOLD_SECS.map(n => <option key={n} value={n}>{n}秒</option>)}
                    </select>
                    <span className="text-slate-500">出したあとでも変えられます</span>
                  </div>
                ) : (
                  <div className="text-3xs text-amber-700 bg-amber-50 rounded px-1.5 py-1">
                    ⚠ 映像が流れている間に出るので、<b>動く物（手・部品・工具・人）を指すとズレます</b>。
                    銘板・掲示物・止まっている部品など、<b>動かない物</b>にだけ使ってください。
                  </div>
                )}
                {/* ⚠「これからなぞると何が起きるか」を、なぞる前に1行で言い切る。 */}
                <div className="text-3xs font-bold text-slate-700 bg-slate-100 rounded px-1.5 py-1" data-mark-next="1">
                  {markEdit.where === 'clip'
                    ? 'いまなぞると → 出ている ⏸止め絵／🖼画像 に、そのまま印が入ります'
                    : markMode === 'freeze'
                      ? `いまなぞると → ${fmtDur(tOut)} で ${markHold}秒 止めて、その1枚に印が入ります`
                      : `いまなぞると → ${fmtDur(tOut)} から3秒、流したまま印が出ます`}
                </div>
              </div>
              {/* ⚠⚠ 形・色・太さ は「これから描く印」の物。
                  印を1つ選んでいる時は、**その印にも効く**(掴んで直せる、と同じ話)。
                  選んでいるかどうかを画面に出さないと、どちらに効いたのか分からなくなる。 */}
              <div className="text-3xs text-slate-500" data-mark-sel="1">
                {markSel >= 0 && markSel < markEdit.marks.length
                  ? <span className="font-bold text-rose-700">印 {markSel + 1} を選んでいます。下の色・太さ・形は、この印にも効きます。</span>
                  : '印をタップすると選べます（選ぶと 動かす・大きさを変える 取っ手が出ます）。'}
              </div>
              <ShapePicker shape={shape} onChange={(v) => { setShape(v); patchSelMark({ shape: v }); }} />
              <ColorPicker color={markColor} onChange={(v) => { setMarkColor(v); patchSelMark({ color: v }); }} />
              <WidthPicker width={markWidth} onChange={(v) => { setMarkWidth(v); patchSelMark({ width: v }); }} />
              {/* ⚠⚠ ここに出るのは **もう入っている印**。「描いただけの控え」はもう無い。 */}
              <div className="text-2xs font-bold text-slate-700" data-mark-count="1">
                {markEdit.marks.length > 0
                  ? `${markEdit.where === 'clip' ? 'この止め絵／画像' : 'いまの場面'}に入っている印：${markEdit.marks.length}個`
                  : 'この場面には まだ印がありません（絵の上をなぞってください）'}
              </div>
              <MarkList marks={markEdit.marks} onChange={(n) => applyMarks(n, false)} selected={markSel} onSelect={setMarkSel} />
              {/* ⚠⚠ 出した止め絵の秒数を直す所を、**この場に** 置く。
                  前は「🖼画像」タブの中にしか無く、印から出した人は永久に見つけられなかった。
                  ⚠印の一覧は上に出しているので、ここでは出さない(2つ並べない)。 */}
              {mkStillEditor(false)}
              {selOv?.kind === 'mark' && <OverlayTiming o={selOv} total={total} onChange={(pt2) => editProject(patchOverlay(project, selOv.id, pt2))} onDelete={() => { push(removeOverlay(project, selOv.id)); setSel({ type: 'clip', id: '' }); }} onSeek={seek} />}
            </div>
          )}

          {/* 💬 文字(テロップ) */}
          {tool === 'text' && (
            <div className="space-y-1.5">
              <div className="text-2xs text-slate-500">現場は騒音でイヤホンを付けられません。<b>大事な所は必ず文字で</b>出してください。</div>
              {/* 🤖 しゃべった内容から字幕の下書きを作る。⚠作るのは下書きだけ。消すのは人。 */}
              {ai ? (
                <div className="rounded-lg border-2 border-sky-300 bg-sky-50 p-2 space-y-1.5">
                  <div className="text-xs font-bold text-sky-800">{ai.phase}</div>
                  <div className="h-2 bg-white rounded-full overflow-hidden"><div className="h-full bg-sky-500 transition-all" style={{ width: `${Math.round(((ai.done || 0) / Math.max(1, ai.total || 1)) * 100)}%` }} /></div>
                  <button onClick={() => { try { aiAbort.current?.abort(); } catch { /* noop */ } }} className="w-full py-1.5 rounded bg-white border border-slate-300 text-slate-600 font-bold text-xs">やめる</button>
                </div>
              ) : (
                <button onClick={runAi} disabled={!proxyUrl} className="w-full py-2.5 rounded-lg bg-indigo-600 disabled:bg-slate-200 text-white font-bold text-sm">
                  🤖 しゃべった内容から字幕を作る
                  <span className="block text-3xs font-normal opacity-80">下書きを作ります。<b>消す所は決めません</b>（そこは人が決める所です）</span>
                </button>
              )}
              {aiOut && (
                <div className="rounded-lg border-2 border-indigo-300 bg-indigo-50/70 p-2 space-y-1.5">
                  {aiOut.title && <div className="text-2xs"><b className="text-indigo-800">題名の案:</b> {aiOut.title}</div>}
                  {aiOut.summary && <div className="text-2xs text-slate-600">{aiOut.summary}</div>}
                  <div className="max-h-40 overflow-y-auto space-y-0.5 bg-white rounded p-1">
                    {aiOut.segments.map((sg, i) => (
                      <div key={i} className="flex gap-1 text-2xs">
                        <button onClick={() => seek(srcSecToOut(sg.srcId || sources[0]?.id, sg.start) ?? 0)} className="shrink-0 text-xs font-bold text-indigo-700 tabular-nums">{fmtDur(sg.start)}</button>
                        <span className="min-w-0 break-words">{sg.text}</span>
                      </div>
                    ))}
                    {!aiOut.segments.length && <div className="text-2xs text-slate-400">聞き取れる声はありませんでした</div>}
                  </div>
                  {aiOut.notes?.length > 0 && <div className="text-3xs text-amber-700">⚠ {aiOut.notes.join(' / ')}</div>}
                  <div className="flex gap-1.5">
                    <button onClick={applyAiSubs} disabled={!aiOut.segments.length} className="flex-[2] py-2 min-h-[38px] rounded-lg bg-indigo-600 disabled:bg-slate-200 text-white font-bold text-xs">💬 まとめて入れる（{aiOut.segments.length}枚）</button>
                    <button onClick={applyAiChapters} disabled={!aiOut.chapters.length} className="flex-1 py-2 min-h-[38px] rounded-lg bg-white border border-indigo-300 text-indigo-700 font-bold text-xs">📍 区切りも（{aiOut.chapters.length}）</button>
                    <button onClick={() => setAiOut(null)} className="px-2 py-2 min-h-[38px] rounded-lg bg-white border border-slate-300 text-slate-500 font-bold text-xs">✕</button>
                  </div>
                  <div className="text-3xs text-slate-500">⚠ 聞き間違いは必ずあります。<b>入れたあとに必ず読み直してください。</b></div>
                </div>
              )}
              <button onClick={addTextOverlay} className="w-full py-2.5 rounded-lg bg-sky-600 text-white font-bold text-sm">💬 {fmtDur(tOut)} に文字を出す</button>
              {selOv?.kind === 'text' ? (
                <div className="space-y-1.5 border border-sky-300 rounded-lg p-2">
                  <textarea value={selOv.text || ''} onChange={(e) => editProject(patchOverlay(project, selOv.id, { text: e.target.value.slice(0, 120) }))}
                    rows={2} placeholder="例: ここは指を入れない。工具は必ず両手で持つ。" className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" />
                  <div className="flex gap-1">
                    {[['bottom', '下'], ['center', '真ん中'], ['top', '上']].map(([v, l]) => (
                      <button key={v} onClick={() => editProject(patchOverlay(project, selOv.id, { pos: v }))}
                        className={`flex-1 py-2 min-h-[36px] rounded text-xs font-bold ${(selOv.pos || 'bottom') === v ? 'bg-sky-600 text-white' : 'bg-slate-100 text-slate-600'}`}>{l}</button>
                    ))}
                  </div>
                  <div className="flex gap-1">
                    {Object.keys(TEXT_SIZES).map(v => (
                      <button key={v} onClick={() => editProject(patchOverlay(project, selOv.id, { size: v }))}
                        className={`flex-1 py-2 min-h-[36px] rounded text-xs font-bold ${(selOv.size || 'm') === v ? 'bg-sky-600 text-white' : 'bg-slate-100 text-slate-600'}`}>{v === 's' ? '小' : v === 'm' ? '中' : '大'}</button>
                    ))}
                  </div>
                  <div className="flex gap-1">
                    {Object.entries(TEXT_COLORS).map(([v, c]) => (
                      <button key={v} onClick={() => editProject(patchOverlay(project, selOv.id, { color: v }))}
                        className={`flex-1 py-2 min-h-[36px] rounded text-xs font-bold border-2 ${(selOv.color || 'white') === v ? 'border-slate-800' : 'border-transparent'}`}
                        style={{ background: c.bg, color: c.fg }}>{c.label}</button>
                    ))}
                  </div>
                  <OverlayTiming o={selOv} total={total} onChange={(pt2) => editProject(patchOverlay(project, selOv.id, pt2))} onDelete={() => { push(removeOverlay(project, selOv.id)); setSel({ type: 'clip', id: '' }); }} onSeek={seek} />
                </div>
              ) : <div className="text-xs text-slate-400">帯の💬をタップすると直せます。</div>}
            </div>
          )}

          {/* ▩ 隠す(モザイク) */}
          {tool === 'hide' && (
            <div className="space-y-1.5">
              <div className="text-2xs text-slate-500">人の顔・他社名・PCの画面など、<b>外に出せない所</b>を隠します。</div>
              <button onClick={() => { setRectEdit(''); setRectMode(rectMode === 'mosaic' ? null : 'mosaic'); }}
                className={`w-full py-2.5 rounded-lg font-bold text-sm ${rectMode === 'mosaic' ? 'bg-slate-800 text-white' : 'bg-slate-600 text-white'}`}>
                {rectMode === 'mosaic' ? '✓ 絵の上をなぞってください' : '▩ 隠す所をなぞる'}
              </button>
              {selOv?.kind === 'mosaic' && (
                <div className="space-y-1.5 border border-slate-300 rounded-lg p-2">
                  <div className="flex gap-1">
                    {Object.keys(MOSAIC_CELLS).map(v => (
                      <button key={v} onClick={() => editProject(patchOverlay(project, selOv.id, { cell: v }))}
                        className={`flex-1 py-2 min-h-[36px] rounded text-xs font-bold ${(selOv.cell || 'm') === v ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'}`}>{v === 's' ? '細かい' : v === 'm' ? 'ふつう' : '粗い'}</button>
                    ))}
                  </div>
                  {/* ⚠⚠ 「やり直す」= 置き換える。id を渡さないと **もう1個増える**(実測の欠陥)。 */}
                  <button onClick={() => { setRectEdit(selOv.id); setRectMode('mosaic'); }} className="w-full py-2 min-h-[36px] rounded bg-slate-100 text-slate-600 font-bold text-xs">場所をやり直す（増やしません）</button>
                  <OverlayTiming o={selOv} total={total} onChange={(pt2) => editProject(patchOverlay(project, selOv.id, pt2))} onDelete={() => { push(removeOverlay(project, selOv.id)); setSel({ type: 'clip', id: '' }); }} onSeek={seek} />
                </div>
              )}
              <div className="text-3xs text-slate-400">※ 追いかけ(自動追尾)はありません。動く物は時間を分けて何回か置いてください。</div>
            </div>
          )}

          {/* 🔦 スポットライト */}
          {tool === 'spot' && (
            <div className="space-y-1.5">
              <div className="text-2xs text-slate-500">見せたい所<b>以外</b>を暗くします。「どこを見ればいいか」が一番強く伝わります。</div>
              <button onClick={() => { setRectEdit(''); setRectMode(rectMode === 'spot' ? null : 'spot'); }}
                className={`w-full py-2.5 rounded-lg font-bold text-sm ${rectMode === 'spot' ? 'bg-amber-600 text-white' : 'bg-amber-500 text-slate-900'}`}>
                {rectMode === 'spot' ? '✓ 絵の上をなぞってください' : '🔦 見せたい所をなぞる'}
              </button>
              {selOv?.kind === 'spot' && (
                <div className="space-y-1.5 border border-amber-300 rounded-lg p-2">
                  <label className="text-xs font-bold text-slate-600">まわりの暗さ
                    <input type="range" min="0.2" max="0.9" step="0.05" value={selOv.dim ?? 0.62}
                      onChange={(e) => editProject(patchOverlay(project, selOv.id, { dim: Number(e.target.value) }))} className="w-full" />
                  </label>
                  {/* ⚠⚠ 「やり直す」= 置き換える。id を渡さないと **もう1個増える**(実測の欠陥)。 */}
                  <button onClick={() => { setRectEdit(selOv.id); setRectMode('spot'); }} className="w-full py-2 min-h-[36px] rounded bg-slate-100 text-slate-600 font-bold text-xs">場所をやり直す（増やしません）</button>
                  <OverlayTiming o={selOv} total={total} onChange={(pt2) => editProject(patchOverlay(project, selOv.id, pt2))} onDelete={() => { push(removeOverlay(project, selOv.id)); setSel({ type: 'clip', id: '' }); }} onSeek={seek} />
                </div>
              )}
            </div>
          )}

          {/* 🖼 画像を挟む */}
          {tool === 'image' && (
            <div className="space-y-1.5">
              <div className="text-2xs text-slate-500">カメラでは写せないPC画面などを、<b>写真で挟んで</b>説明できます。挟んだ写真にも〇や説明を付けられます。</div>
              {/* ⚠挟む **前に** 何秒出すか決められる(前は5秒の決め打ちだった) */}
              <div className="flex items-center gap-1.5 text-2xs">
                <span className="font-bold text-violet-700">何秒 出すか</span>
                <select aria-label="これから挟む画像の長さ（秒）" value={imgHold} onChange={(e) => setImgHold(Number(e.target.value))}
                  className="border border-slate-300 rounded px-1.5 py-1.5 min-h-[36px] text-xs font-bold">
                  {IMAGE_SECS.map(n => <option key={n} value={n}>{n}秒</option>)}
                </select>
                <span className="text-slate-500">挟んだあとでも変えられます</span>
              </div>
              <label className="block w-full text-center py-2.5 rounded-lg bg-violet-600 text-white font-bold text-sm cursor-pointer">
                🖼 {fmtDur(tOut)} に画像を挟む（{imgHold}秒）
                <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = (e.target.files || [])[0]; e.target.value = ''; if (f) addImage(f); }} />
              </label>
              {mkStillEditor(true)}
            </div>
          )}

          {/* ⤢ 画づくり(回転・切り抜き・寄り) */}
          {tool === 'frame' && (
            <div className="space-y-1.5">
              <div className="text-2xs font-bold text-slate-600">向き（横になって撮れてしまった動画を立てる）</div>
              {/* ⚠⚠ 押す度に90度ずつ回す1ボタンにする。言葉と操作は
                  📱スマホ中継の「🔄 回す（{deg}°）」「元に戻す」と揃える
                  (現場に2つの違う回し方を覚えさせない)。 */}
              <div className="flex gap-1">
                <button onClick={() => push({ ...project, rotate: ((project.rotate || 0) + 90) % 360 })}
                  title="押す度に90度ずつ回ります（0→90→180→270→0）"
                  className="flex-[2] py-2.5 min-h-[44px] rounded-lg font-bold text-sm bg-slate-700 hover:bg-slate-600 text-white">
                  🔄 回す（{((project.rotate || 0) + 90) % 360}°）
                </button>
                <button onClick={() => push({ ...project, rotate: 0 })} disabled={!project.rotate}
                  className="flex-1 py-2.5 min-h-[44px] rounded-lg font-bold text-xs bg-slate-100 disabled:opacity-40 text-slate-600">元に戻す</button>
              </div>
              {!!project.rotate && (
                <div className="text-3xs text-amber-800 bg-amber-50 rounded px-1.5 py-1">
                  いま <b>{project.rotate}°</b> 回しています。⚠ これは<b>書き出す動画に焼き込まれる</b>向きです。
                  見る人にもこの向きで見えます。自分が見たいだけなら「元に戻す」を押してください。
                </div>
              )}
              <div className="text-2xs font-bold text-slate-600 pt-1">切り抜き（いらない周りを落とす）</div>
              <button onClick={() => { setRectEdit(''); setRectMode(rectMode === 'crop' ? null : 'crop'); }}
                className={`w-full py-2.5 rounded-lg font-bold text-sm ${rectMode === 'crop' ? 'bg-slate-800 text-white' : 'bg-slate-600 text-white'}`}>
                {rectMode === 'crop' ? '✓ 残したい所をなぞってください' : '⤢ 残す所をなぞる'}
              </button>
              {project.crop && <button onClick={() => push({ ...project, crop: null })} className="w-full py-2 min-h-[36px] rounded bg-slate-100 text-slate-600 font-bold text-xs">切り抜きをやめる（全部に戻す）</button>}
              <div className="text-2xs font-bold text-slate-600 pt-1">明るさ・くっきり（逆光や暗い所で撮った時）</div>
              {[['brightness', '明るさ'], ['contrast', 'くっきり'], ['saturate', '色の濃さ']].map(([k, label]) => (
                <label key={k} className="block text-xs text-slate-600">{label}（{Math.round((project.adjust?.[k] ?? 1) * 100)}%）
                  <input type="range" min="0.4" max="2" step="0.05" value={project.adjust?.[k] ?? 1}
                    onChange={(e) => editProject({ ...project, adjust: { ...project.adjust, [k]: Number(e.target.value) } })}
                    className="w-full" />
                </label>
              ))}
              {(project.adjust?.brightness !== 1 || project.adjust?.contrast !== 1 || project.adjust?.saturate !== 1) && (
                <button onClick={() => push({ ...project, adjust: { brightness: 1, contrast: 1, saturate: 1 } })}
                  className="w-full py-2 min-h-[36px] rounded bg-slate-100 text-slate-600 font-bold text-xs">明るさを元に戻す</button>
              )}
              <div className="text-2xs font-bold text-slate-600 pt-1">寄り（この部品の中でゆっくり拡大）</div>
              {/* ⚠⚠ 「画面だけの拡大(🔍)」と間違えられると、書き出した動画が勝手に寄ってしまう。
                  どちらが焼き込まれる方なのか、画面にはっきり書いておく。 */}
              <div className="text-3xs text-amber-800 bg-amber-50 rounded px-1.5 py-1">
                ⚠ これは<b>書き出す動画に焼き込まれる</b>拡大です。見る人にもそのまま寄って見えます。<br />
                自分が細かい所を見たいだけなら、絵の右上の <b>🔍（画面だけの拡大）</b>を使ってください。
              </div>
              {!selClip ? <div className="text-xs text-slate-400">部品を選んでください。</div> : (
                <>
                  <div className="flex gap-1">
                    {[['なし', null], ['ゆっくり寄る', { from: { scale: 1, cx: 0.5, cy: 0.5 }, to: { scale: 1.6, cx: 0.5, cy: 0.5 } }], ['ずっと寄り', { from: { scale: 1.6, cx: 0.5, cy: 0.5 }, to: { scale: 1.6, cx: 0.5, cy: 0.5 } }]].map(([l, z]) => (
                      <button key={l} onClick={() => push(patchClip(project, selIndex, { zoom: z }))}
                        className={`flex-1 py-2 min-h-[40px] rounded font-bold text-xs leading-tight ${JSON.stringify(selClip.zoom || null) === JSON.stringify(z) ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'}`}>{l}</button>
                    ))}
                  </div>
                  {selClip.zoom && (
                    <label className="text-xs font-bold text-slate-600">どこに寄るか（左右）
                      <input type="range" min="0" max="1" step="0.05" value={selClip.zoom.to?.cx ?? 0.5}
                        onChange={(e) => { const v = Number(e.target.value); editProject(patchClip(project, selIndex, { zoom: { from: { ...selClip.zoom.from, cx: v }, to: { ...selClip.zoom.to, cx: v } } })); }} className="w-full" />
                    </label>
                  )}
                </>
              )}
            </div>
          )}

          {/* 🔊 音 */}
          {tool === 'audio' && (
            <div className="space-y-1.5">
              <label className="flex items-center gap-2 text-sm font-bold text-slate-700">
                <input type="checkbox" checked={!!project.mute} onChange={(e) => push({ ...project, mute: e.target.checked })} className="w-5 h-5 accent-slate-700" />
                音を全部消して書き出す
              </label>
              <label className="text-xs font-bold text-slate-600">全体の音量（{Math.round((project.audio?.volume ?? 1) * 100)}%）
                {/* ⚠上限は1.0。1を超える指定は **プレビューでは確かめられない**(HTMLの音量は1が上限)。
                    「編集室では小さいのに書き出したら割れていた」を作らないため、聞ける範囲に収める。 */}
                <input type="range" min="0" max="1" step="0.05" value={Math.min(1, project.audio?.volume ?? 1)}
                  onChange={(e) => editProject({ ...project, audio: { ...project.audio, volume: Number(e.target.value) } })} className="w-full" />
              </label>
              <div className="flex gap-2">
                <label className="flex-1 text-xs font-bold text-slate-600">頭のフェード
                  <select value={project.audio?.fadeIn ?? 0} onChange={(e) => push({ ...project, audio: { ...project.audio, fadeIn: Number(e.target.value) } })} className="w-full border border-slate-300 rounded px-1.5 py-1.5">
                    {[0, 0.5, 1, 2].map(n => <option key={n} value={n}>{n === 0 ? 'なし' : `${n}秒`}</option>)}
                  </select>
                </label>
                <label className="flex-1 text-xs font-bold text-slate-600">お尻のフェード
                  <select value={project.audio?.fadeOut ?? 0} onChange={(e) => push({ ...project, audio: { ...project.audio, fadeOut: Number(e.target.value) } })} className="w-full border border-slate-300 rounded px-1.5 py-1.5">
                    {[0, 0.5, 1, 2].map(n => <option key={n} value={n}>{n === 0 ? 'なし' : `${n}秒`}</option>)}
                  </select>
                </label>
              </div>
              {selClip?.type === 'video' && (
                <label className="flex items-center gap-2 text-sm font-bold text-slate-700 pt-1">
                  <input type="checkbox" checked={!!selClip.mute} onChange={(e) => push(patchClip(project, selIndex, { mute: e.target.checked }))} className="w-5 h-5 accent-slate-700" />
                  この部品（{selIndex + 1}）だけ音を消す
                </label>
              )}
            </div>
          )}

          {/* 📍 章 */}
          {tool === 'chapter' && (
            <div className="space-y-1.5">
              <div className="text-2xs text-slate-500">工程の区切りを入れると、<b>書き出す時に工程ごとの別ファイルに分けられます</b>。</div>
              <div className="text-3xs text-indigo-700">🤖 区切りの<b>案</b>は「💬 文字」の「しゃべった内容から字幕を作る」で一緒に出ます。</div>
              {/* ⚠⚠ 章も「↩ 操作を戻す」で戻る(pushChapters / editChapters を通す)。
                  前は setChapters を直に呼んでいたので、章を入れても消しても ↩ で戻らなかった。 */}
              <button onClick={() => pushChapters([...chapters, { name: '', atOut: Math.round(tOut * 100) / 100 }])}
                className="w-full py-2.5 rounded-lg bg-indigo-600 text-white font-bold text-sm">📍 {fmtDur(tOut)} に区切りを入れる</button>
              <div className="text-3xs text-slate-400">※ 入れた区切りは「↩ 操作を戻す」で消せます。</div>
              {/* ⚠⚠ sort は元の配列を壊す。state をレンダー中に並べ替えない(写してから並べる)。
                  ⚠⚠ 並べ替えた後の番号で setChapters すると **別の章の名前が変わる**。
                    元の番号(i)を一緒に持って回る。 */}
              {chapters.map((c, i) => ({ c, i })).sort((a, b) => a.c.atOut - b.c.atOut).map(({ c, i }) => (
                <div key={i} className="flex items-center gap-1 border border-slate-200 rounded px-1.5 py-1">
                  <button onClick={() => seek(c.atOut)} className="text-xs font-bold text-indigo-700 shrink-0">{fmtDur(c.atOut)}</button>
                  <input value={c.name} onChange={(e) => editChapters(chapters.map((x, j) => (j === i ? { ...x, name: e.target.value.slice(0, 30) } : x)))}
                    placeholder="工程の名前" className="flex-1 min-w-0 border border-slate-200 rounded px-1.5 py-1 text-xs" />
                  <button onClick={() => pushChapters(chapters.filter((_, j) => j !== i))} className="px-2 py-1 min-h-[30px] bg-rose-100 text-rose-600 rounded font-bold text-xs">✕</button>
                </div>
              ))}
              {chapters.length > 0 && (
                <div className="text-3xs text-slate-500">
                  {chapterSegments(project, chapters).map((s, i) => <div key={i}>{i + 1}. {s.name}（{fmtDur(s.from)}〜{fmtDur(s.to)}）</div>)}
                </div>
              )}
            </div>
          )}

          {/* 🔎 言葉で探す */}
          {tool === 'find' && (
            <div className="space-y-2">
              <VideoWordFinder words={words} onJump={(at) => { seek(at); setPlaying(true); }} note={wordsCap.note} compact />
              {/* ⚠⚠ 何から探せるのかを、数で見せる。0件のまま黙っていると「壊れている」と思われる。 */}
              <div className="border-t border-slate-200 pt-1.5 text-3xs text-slate-500 space-y-0.5">
                <div className="font-bold text-slate-600">探せる材料（{words.length}件）</div>
                {WORD_KINDS.map(k => {
                  const n = words.filter(w => w.kind === k.key).length;
                  return n ? <div key={k.key}>・{kindLabel(k.key)} {n}件</div> : null;
                })}
                {!words.length && (
                  <div className="text-amber-700">
                    まだ1件もありません。⏸止め絵に<b>「急所」</b>を書く／📍章に名前を付ける／🎙あとから声を入れる、のどれかで増えます。
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 🎙 あとから声を入れる(アフレコ) */}
          {tool === 'voice' && (
            <div className="space-y-1.5">
              <div className="text-2xs text-slate-500">
                撮る時に喋らなくて構いません。<b>静かな所で、動画を見ながら喋ってください。</b>
                騒音もマスクも関係ありません。
              </div>
              {/* ⚠⚠ ここを黙っていると「音が入っていない」と欠陥報告される。先に言い切る。 */}
              <div className="text-3xs text-slate-700 bg-slate-100 rounded-lg p-2 leading-relaxed" data-voice-policy="1">
                ⚠ 録った声は<b>動画に焼き込みません</b>。声は<b>その場面の言葉（＝字幕・探せる言葉）</b>にして、
                <b>音そのものは残しません</b>。<br />
                現場は騒音でイヤホンを付けられないので、<b>音では伝わらず、文字なら伝わる</b>ためです。
              </div>
              {rec ? (
                <div className="rounded-lg border-2 border-rose-400 bg-rose-50 p-2 space-y-1.5">
                  <div className="text-sm font-black text-rose-700">🔴 録っています {Math.floor(rec.sec)}秒 / {Math.round(MAX_TAKE_SEC / 60)}分まで</div>
                  <div className="text-2xs text-rose-800">いま <b>{fmtDur(tOut)}</b> を見ています。止めたり戻したりして構いません（見ていた場面に付きます）。</div>
                  <button onClick={stopRec} data-voice-stop="1" className="w-full py-2.5 min-h-[44px] rounded-lg bg-rose-600 text-white font-bold text-sm">■ 録り終わる</button>
                </div>
              ) : (
                <button onClick={startRec} disabled={!!voiceBusy} data-voice-start="1"
                  className="w-full py-3 min-h-[48px] rounded-lg bg-rose-600 disabled:bg-slate-300 text-white font-bold text-sm">
                  🎙 いまの場面から喋る
                  <span className="block text-3xs font-normal opacity-90">押すと再生が始まります。見ながら喋ってください。</span>
                </button>
              )}
              {take && !rec && (
                <div className="rounded-lg border-2 border-indigo-300 bg-indigo-50/70 p-2 space-y-1.5">
                  <div className="text-2xs font-bold text-indigo-800">録れた声（{Math.round(take.sec)}秒）— 聞き直せます</div>
                  <audio src={take.url} controls className="w-full" />
                  <button onClick={takeToWords} disabled={!!voiceBusy || !proxyUrl || !voiceCap.canMakeSubtitles} data-voice-towords="1"
                    className="w-full py-2.5 min-h-[44px] rounded-lg bg-indigo-600 disabled:bg-slate-300 text-white font-bold text-sm">
                    {voiceBusy || '📝 喋った内容を、その場面の言葉にする'}
                  </button>
                  {!proxyUrl && <div className="text-3xs text-amber-700">AIサーバーが未設定です（管理者: .env の VITE_GEMINI_PROXY_URL）。下の「手で打つ」は使えます。</div>}
                  <button onClick={clearTake} className="w-full py-2 min-h-[36px] rounded bg-white border border-slate-300 text-slate-600 font-bold text-xs">この録音を捨てる</button>
                </div>
              )}
              {/* ⚠AIサーバーが無くても、この機能だけで成り立つ道を必ず残す。 */}
              <div className="border-t border-slate-200 pt-1.5 space-y-1">
                <div className="text-2xs font-bold text-slate-600">🖊 手で打つ（喋らなくてよい人はこちら）</div>
                <textarea value={handText} onChange={(e) => setHandText(e.target.value.slice(0, 120))} rows={2}
                  data-voice-hand="1" placeholder="例: ここでノギスを軸にまっすぐ当てる"
                  className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" />
                <button onClick={addHandNote} disabled={!handText.trim()} data-voice-handadd="1"
                  className="w-full py-2.5 min-h-[44px] rounded-lg bg-sky-600 disabled:bg-slate-200 text-white font-bold text-sm">＋ {fmtDur(tOut)} に足す</button>
              </div>
              {/* 入れた言葉の一覧 */}
              {Object.keys(project.notes || {}).length > 0 && (
                <div className="border-t border-slate-200 pt-1.5 space-y-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-2xs font-bold text-slate-600 flex-1">入れた言葉（{Object.keys(project.notes || {}).length}件）</span>
                    <button onClick={notesToSubs} data-voice-tosubs="1" className="shrink-0 px-2 py-1.5 min-h-[34px] rounded bg-slate-800 text-white font-bold text-xs">💬 字幕にする</button>
                  </div>
                  <div className="max-h-40 overflow-y-auto space-y-0.5" data-voice-list="1">
                    {Object.entries(project.notes || {})
                      .sort((a, b) => (a[1].at || 0) - (b[1].at || 0))
                      .map(([id, n]) => (
                        <div key={id} className="flex items-start gap-1 border border-slate-200 rounded px-1.5 py-1 text-xs">
                          <button onClick={() => seek(n.at)} className="shrink-0 font-bold text-sky-700 tabular-nums">{fmtDur(n.at)}</button>
                          <span className="flex-1 min-w-0 break-words">{n.text}</span>
                          <button onClick={() => delNote(id)} className="px-1.5 py-1 min-h-[30px] bg-rose-100 text-rose-600 rounded font-bold">✕</button>
                        </div>
                      ))}
                  </div>
                  <div className="text-3xs text-slate-500">⚠ 聞き間違いはあります。<b>入れたあとに必ず読み直してください。</b></div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 📄 作業標準（動画の要点だけを紙とExcelにする） */}
      {wsOpen && (
        <div className="fixed inset-0 z-[640] bg-black/60 flex items-center justify-center p-4" onClick={() => !wsBusy && setWsOpen(false)}>
          <div className="bg-white rounded-2xl w-full max-w-lg p-4 space-y-3" onClick={e => e.stopPropagation()}>
            <div className="font-black text-lg">📄 作業標準を作る</div>
            {/* ⚠「できました」で終わらせず、**空欄を名指しで**言う。空のまま配られないため。 */}
            <div className={`text-xs rounded-lg p-2 ${wsDoc.missing.step + wsDoc.missing.point + wsDoc.missing.why > 0 ? 'bg-amber-50 text-amber-900 border border-amber-300' : 'bg-emerald-50 text-emerald-800'}`}>
              {wsMissingNote(wsDoc)}
            </div>
            <div className="text-2xs text-slate-600">
              ⏸止め絵と🖼画像が1つずつ「1つの要点」になります。写真は<b>印を付けたまま</b>入ります。
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="font-bold text-slate-600 shrink-0">紙の並べ方</span>
              <select value={wsPerPage} onChange={(e) => setWsPerPage(Number(e.target.value))}
                className="flex-1 border border-slate-300 rounded px-2 py-2 min-h-[40px]">
                {WS_PER_PAGE.map(p2 => <option key={p2.n} value={p2.n}>{p2.label}（写真 {p2.photoMm}mm）</option>)}
              </select>
            </div>
            {/* ⚠押した瞬間に絵を作る。要点が多いと数秒かかるので、必ず「作っています」を出す。 */}
            <div className="grid grid-cols-2 gap-2">
              <button disabled={!!wsBusy}
                onClick={async () => {
                  setWsBusy('紙を作っています…（写真を切り出しています）');
                  try {
                    // ⚠⚠ 渡すのは **書類まるごと**(rows だけではない)。回転・切り抜き・目隠しは
                    //   書類の側に付いているので、rows だけ渡すと紙の写真だけ素の絵になる。
                    const shots = await wsBuildShots(wsDoc, { getVideo: (id) => vidRefs.current[id], getImage: (id) => imgRefs.current[id] });
                    printWorkStandard({ ...wsDoc, madeAt: Date.now() }, shots, { perPage: wsPerPage });
                  } catch (e) { alert('作業標準を作れませんでした: ' + ((e && e.message) || e)); }
                  finally { setWsBusy(''); }
                }}
                className="py-3 min-h-[52px] rounded-xl bg-slate-800 disabled:bg-slate-400 text-white font-black text-sm">🖨 紙にする（PDF）</button>
              <button disabled={!!wsBusy}
                onClick={async () => {
                  setWsBusy('Excelを作っています…（写真を切り出しています）');
                  try {
                    const shots = await wsBuildShots(wsDoc, { getVideo: (id) => vidRefs.current[id], getImage: (id) => imgRefs.current[id] });
                    const name = await exportWorkStandardXlsx({ ...wsDoc, madeAt: Date.now() }, shots, () => import('exceljs').then(m => m.default || m));
                    setMsg(`📄 ${name} を保存しました。`);
                    setWsOpen(false);
                  } catch (e) { alert('Excelを作れませんでした: ' + ((e && e.message) || e)); }
                  finally { setWsBusy(''); }
                }}
                className="py-3 min-h-[52px] rounded-xl bg-emerald-600 disabled:bg-slate-400 text-white font-black text-sm">📊 Excelにする</button>
            </div>

            {/* 📚 1タップで資料の棚へ。
                ⚠⚠ いままでは 印刷 → PDFで保存 → 資料ライブラリで新規登録 と **手が3つ**。
                  忙しい現場では使われずに死ぬ。ここは押したら終わりにする(名前も分類も後で直せる)。
                ⚠⚠ **PDFは保存しない**(このアプリはPDFの中身を持っていない)。棚に入れるのは
                  「どの動画の・どの要点か」だけ。開いた時にその動画から写真を作り直す。
                  → 保存が軽い / 動画を直したら書類も直る。
                ⚠その代わり **元の動画が消えたら作り直せない**。だから作り直せない物を先に言う。 */}
            {onSaveWorkStandard && (
              <div className="rounded-xl border-2 border-sky-300 bg-sky-50 p-2 space-y-1.5">
                <div className="text-2xs font-bold text-sky-900">📚 検査中にも開ける「作業標準ライブラリ」へ入れる</div>
                <div className={`text-2xs whitespace-pre-wrap rounded p-1.5 ${wsRebuild.ok ? 'text-slate-600' : 'bg-amber-100 text-amber-900'}`}>
                  {wsRebuild.note}
                </div>
                <button disabled={!!wsBusy || !wsRows.length || !!wsSaved}
                  onClick={async () => {
                    setWsBusy('棚へ入れています…'); setWsSaved('');
                    try {
                      // ⚠写真もPDFも持たせない。持たせると設定の箱(1MB)ごと保存できなくなる。
                      const entry = wsBuildEntry({ ...wsDoc, madeAt: Date.now() }, {
                        sources, by: userName, at: Date.now(), perPage: wsPerPage,
                      });
                      if (wsTooBig(entry)) throw new Error(`この作業標準は大きすぎます（${Math.round(wsBytes(entry) / 1024)}KB）。要点を分けてください。`);
                      await onSaveWorkStandard(entry);
                      setWsSaved(`📚「${entry.name}」を作業標準ライブラリに入れました。原案のままです（承認は資料の棚で行います）。`);
                    } catch (e) { alert('棚へ入れられませんでした: ' + ((e && e.message) || e)); }
                    finally { setWsBusy(''); }
                  }}
                  className="w-full py-3 min-h-[52px] rounded-xl bg-sky-600 hover:bg-sky-500 disabled:bg-slate-400 text-white font-black text-sm">
                  {wsSaved ? '✓ 入れました' : '📚 作業標準ライブラリへ入れる（1タップ）'}
                </button>
                {wsSaved && <div className="text-2xs font-bold text-emerald-700">{wsSaved}</div>}
              </div>
            )}

            {wsBusy && <div className="text-xs text-slate-600">{wsBusy}</div>}
            <div className="text-3xs text-slate-500">
              ⚠ 文書番号・版・制定日は<b>空欄で出ます</b>。発行する時に人が入れてください（勝手に番号を付けると偽の社内文書になります）。<br />
              ⚠ 承認は資料の棚で行います。承認するまで紙には大きく<b>原案</b>と出ます。承認したあとに中身を直すと、承認は<b>自動で外れます</b>。
            </div>
            <button onClick={() => !wsBusy && setWsOpen(false)} className="w-full py-2 rounded-lg bg-slate-100 font-bold text-sm">閉じる</button>
          </div>
        </div>
      )}

      {/* 元動画・画像は隠して持っておく(切り替えの読み込み待ちを無くす) */}
      <div className="hidden">
        {sources.map(s => (
          <video key={s.id} ref={el => { vidRefs.current[s.id] = el; }} src={s.url} crossOrigin="anonymous" playsInline preload="auto" />
        ))}
        {Object.entries(imgUrls).map(([id, u]) => (
          <img key={id} ref={el => { imgRefs.current[id] = el; }} src={u} alt="" />
        ))}
      </div>
    </div>
  );
};

/**
 * ⏸止め絵 / 🖼画像 の設定（何秒出すか・下に出す説明・印）。
 * ----------------------------------------------------------------------------
 * 清水さん(2026-08-14)「要点がどれぐらい停止するかも決められたら」
 *                     「挟んだ画像を何秒出しているかも選択できるように」
 * ⚠⚠ **出したあとに変えられる**事が肝。変えられないと、秒数を直すだけで
 *   消して挟み直し(印も説明も付け直し)になる。
 * ⚠いま何秒なのかを **選択欄そのものが** 示す(別に文字で書くと必ず食い違う)。
 *
 * ⚠⚠ 2026-08-16: 「✍ 描いた印をこの止め絵に付ける」ボタンは **無くした**。
 *   描いた印はもう入っている(押し忘れて消える物が存在しない)。
 *   代わりに「この場面へ飛ぶ」を置く — 印を直すには、その止め絵が出ている必要があるため。
 * @param showMarks false = 印の一覧を出さない(呼ぶ側が既に出している時)
 */
const StillClipEditor = ({ clip, showMarks = true, onSeconds, onCaption, onWsField, onSeek, onMarks }) => {
  const freeze = clip.type === 'freeze';
  const now = Math.round((Number(clip.durationSec) || 0) * 10) / 10;
  // ⚠切って半端な秒数(1.4秒など)になった物も、いまの値として必ず出す。
  //   出さないと選択欄が空になり「何秒か分からない」になる。
  const opts = [...new Set([...(freeze ? HOLD_SECS : IMAGE_SECS), now])].sort((a, b) => a - b);
  return (
    <div className={`space-y-1.5 rounded-lg p-2 border-2 ${freeze ? 'border-slate-400 bg-slate-50' : 'border-violet-300 bg-violet-50/60'}`}>
      <div className="text-2xs font-bold text-slate-700">
        {freeze ? `⏸ いま選んでいる止め絵（元の ${fmtDur(clip.atSec)} の1枚）` : '🖼 いま選んでいる画像'}
      </div>
      <div className="flex items-center gap-1.5 text-2xs">
        <span className="font-bold text-slate-600">{freeze ? '止めている長さ' : '出している長さ'}</span>
        <select
          aria-label={freeze ? 'この止め絵の長さ（秒）' : 'この画像の長さ（秒）'}
          value={String(now)} onChange={(e) => onSeconds(Number(e.target.value))}
          className="border border-slate-300 rounded px-1.5 py-1.5 min-h-[36px] text-xs font-bold"
        >
          {opts.map(n => <option key={n} value={n}>{n}秒</option>)}
        </select>
        <span className="text-slate-500">いつでも変えられます</span>
      </div>
      <input value={clip.caption || ''} onChange={(e) => onCaption(e.target.value.slice(0, 60))}
        placeholder={freeze ? '画面の下に出す説明（任意）' : '画面の下に出す説明（例: 測定ソフトで「開始」を押す）'}
        className="w-full border border-slate-300 rounded px-2 py-1.5 text-xs" />

      {/* 📄 作業標準に出す3つの欄。
          ⚠⚠ 上の「画面の下に出す説明」は **映像に焼き込まれる字幕**。ここは書類用で別物。
            混ぜると「書類を直したら動画の見た目が変わった」が起きる。
          ⚠⚠ 空でも構わないが、**空のまま配られないように**書類の側で名指しで警告する。
            こちらで推測して埋めることは絶対にしない(現場が嘘の標準に従うことになる)。 */}
      <div className="rounded-lg border border-emerald-300 bg-emerald-50/60 p-2 space-y-1.5">
        <div className="text-2xs font-bold text-emerald-800">📄 作業標準に出す（動画には出ません）</div>
        {WS_FIELDS.map((f) => (
          <div key={f.key}>
            <div className="text-3xs font-bold text-slate-600">{f.label}</div>
            <input value={clip[f.key] || ''} onChange={(e) => onWsField(f.key, e.target.value.slice(0, f.max))}
              placeholder={f.hint} className="w-full border border-slate-300 rounded px-2 py-1.5 text-xs" />
          </div>
        ))}
        <div className="text-3xs text-slate-500">
          空のままでも作れますが、書類に「未記入」と出ます。
          {!clip.step && clip.caption ? <> いまは上の説明「{clip.caption}」を作業手順として使います。</> : null}
        </div>
      </div>
      <div className="text-3xs text-slate-500">
        印を描く: 「⭕ 印」に切り替えて、{freeze ? 'この止め絵' : 'この画像'}が<b>画面に出ている状態</b>で絵の上をなぞってください。
        <b>なぞった時点で入ります</b>（付けるボタンはもうありません）。
      </div>
      <button onClick={onSeek}
        className={`w-full py-2 min-h-[36px] rounded font-bold text-xs ${freeze ? 'bg-slate-200 text-slate-700' : 'bg-violet-100 text-violet-700'}`}>
        ▶ {freeze ? 'この止め絵' : 'この画像'}の場面へ飛ぶ（ここで印を描く・直す）
      </button>
      {showMarks && (clip.marks || []).length > 0 && <MarkList marks={clip.marks} onChange={onMarks} />}
    </div>
  );
};

/** 重ねの「いつからいつまで」。⚠ここが無いと、置いた後に直せない。 */
const OverlayTiming = ({ o, total, onChange, onDelete, onSeek }) => (
  <div className="space-y-1 pt-1 border-t border-slate-200">
    {/* ⚠この行は 時刻の表示 と 押す物 しかない → 12px 以上(2026-08-16)。 */}
    <div className="flex items-center gap-1 text-xs">
      <button onClick={() => onSeek(o.from)} className="font-bold text-slate-700">{fmtDur(o.from)}</button>
      <span className="text-slate-400">〜</span>
      <button onClick={() => onSeek(Math.max(0, o.to - 0.1))} className="font-bold text-slate-700">{fmtDur(o.to)}</button>
      <span className="text-slate-400 ml-1">（{(o.to - o.from).toFixed(1)}秒）</span>
      <button onClick={onDelete} className="ml-auto px-2 py-1 min-h-[30px] bg-rose-100 text-rose-600 rounded font-bold">🗑</button>
    </div>
    {/* ⚠⚠ 押す物を 11px→12px に上げた。4つ横並びのままだと 340px の列で
           「始まり −0.5秒」が1行に入りきらず **折り返して縦に伸びる**(実測)。
           2列×2段にすると 1つ約150px 取れて折り返さない。押す面積も倍になる(手袋対策)。 */}
    <div className="grid grid-cols-2 gap-1">
      {[-0.5, +0.5].map(d => (
        <button key={`f${d}`} onClick={() => onChange({ from: Math.max(0, o.from + d) })} className="py-1.5 min-h-[34px] bg-slate-100 rounded text-xs font-bold">始まり {d > 0 ? '+' : ''}{d}秒</button>
      ))}
      {[-0.5, +0.5].map(d => (
        <button key={`t${d}`} onClick={() => onChange({ to: Math.min(total, o.to + d) })} className="py-1.5 min-h-[34px] bg-slate-100 rounded text-xs font-bold">終わり {d > 0 ? '+' : ''}{d}秒</button>
      ))}
    </div>
  </div>
);

export default VideoEditor;
