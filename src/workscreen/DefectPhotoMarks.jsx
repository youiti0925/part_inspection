// ✍ P112 不具合写真に 〇/□/矢印/なぞり書き/番号 を指で描く(部品検査)
// ----------------------------------------------------------------------------
// 描く道具・描き方は製品検査と1バイト同じ写し(MarkCanvas.jsx・RecipeMarks.jsx・domain/videoMarks.js・domain/videoBox.js)。
// ここは部品の不具合写真に合わせた「枠」だけ(描く窓と、印を重ねて見せる写真)。
// 既定: 印を付ける先は 不具合写真だけ(作業標準の参考画像には付けない)。
// ⚠印は「絵に対する割合(0-1)」で持つ。だから絵と箱をぴったり同じ大きさにする(inline-block で絵に沿わせる)。
// ⚠現場はタブレット(指)。取っ手44px・touchAction は MarkCanvas の側が守っている。崩さない。
import React, { useRef, useState } from 'react';
import { MarkCanvas, MarkList, ShapePicker } from '../MarkCanvas.jsx';
import { RecipeMarks } from '../RecipeMarks.jsx';

/** 写真に印を重ねて見せる。印が無ければ写真だけ。 */
export const MarkedPhoto = ({ src, marks = [], imgClassName = '', onClick = null }) => (
  <div className="relative inline-block max-w-full" onClick={onClick || undefined}>
    <img src={src} alt="" className={`block ${imgClassName}`} />
    {Array.isArray(marks) && marks.length > 0 && <RecipeMarks marks={marks} />}
  </div>
);

/** 写真1枚に印を描く窓(画面いっぱい)。onDone(marks) で閉じる。 */
export const DefectPhotoMarkEditor = ({ src, marks = [], onDone, onCancel }) => {
  const imgRef = useRef(null);
  const [draft, setDraft] = useState(Array.isArray(marks) ? marks : []);
  const [shape, setShape] = useState('ellipse');
  if (!src) return null;
  return (
    <div className="fixed inset-0 z-[1260] bg-black/90 flex flex-col" style={{ height: '100dvh' }}>
      <div className="shrink-0 px-4 py-2 text-white flex items-center gap-2 flex-wrap">
        <span className="font-bold">✍ 写真に印を描く</span>
        <span className="text-xs text-white/70">なぞると印・印をタップで選ぶ・取っ手で動かす</span>
        <div className="ml-auto flex gap-2">
          <button onClick={() => onCancel && onCancel()} className="px-4 min-h-[44px] rounded-lg bg-white/15 font-bold">やめる</button>
          <button onClick={() => onDone && onDone(draft)} className="px-4 min-h-[44px] rounded-lg bg-violet-600 font-bold">✓ 描き終わり</button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-2">
        <div className="relative inline-block max-w-full">
          <img ref={imgRef} src={src} alt="" className="block max-w-full max-h-[70vh]" />
          <MarkCanvas targetRef={imgRef} marks={draft} shape={shape} max={8} onChange={setDraft} />
        </div>
      </div>
      <div className="shrink-0 bg-white p-2 space-y-2 max-h-[30vh] overflow-auto">
        <ShapePicker shape={shape} onChange={setShape} />
        <MarkList marks={draft} onChange={setDraft} />
      </div>
    </div>
  );
};

export default DefectPhotoMarkEditor;
