// 🔁 設定: 軽微不良マスタの項目ごとの「種別」と、種別の語彙を決める欄(製品 App.jsx の設定画面の同じ箱を写した物)。
//   ⚠決めるのは現場。既定は必ず「未分類」で、中身から推測して付けない。保存は親の保存ボタン。
import React from 'react';
import { UNKNOWN_CAUSE, UNKNOWN_KIND } from './domain/reworkAnalysis.js';
import { DEFAULT_REWORK_KIND_OPTIONS, reworkKindOptions } from './reworkKinds.js';

export default function ReworkKindEditor({ complaintOptionsText, reworkKindOptionsText, setReworkKindOptionsText, localComplaintKinds, setLocalComplaintKinds }) {
  // いま入力中の語彙(保存前でも下の選択肢に反映する)
  const editingKindOptions = reworkKindOptions({ reworkKindOptions: reworkKindOptionsText.split('\n').map(s => s.trim()).filter(Boolean) });
  return (
             <div className="mt-4 border-t pt-4">
               <div className="font-bold text-sm text-slate-700 mb-1">項目ごとの「種別」（やり直しの分析で使います）</div>
               <p className="text-xs text-slate-500 mb-3">
                 NGの理由に使われた項目が、<b>直しが要った</b>のか、<b>測り直しだけ</b>で済んだのか、<b>作業環境</b>の話なのかを決めます。
                 分析→不具合分析の「やり直し(再作業)の中身」で、この種別ごとに分けて出します（1つの合計には混ぜません）。
                 決めていない物は「{UNKNOWN_KIND}」のままで構いません。<b>こちらで勝手に分けることはしません。</b>
                 <br/>下で選んだあと、この画面の下にある保存ボタンを押すと反映されます。
               </p>
  
               {/* 🔁 種別の語彙そのものも現場が決める。項目マスタと同じ「1行1項目」で書けるようにしてある。
                   ⚠4つ目の種別が要る時にコードを直さなくて済むようにするための欄。 */}
               <div className="mb-3">
                 <div className="font-bold text-xs text-slate-600 mb-1">種別として選べる言葉（1行1項目）</div>
                 <textarea
                   value={reworkKindOptionsText}
                   onChange={e => setReworkKindOptionsText(e.target.value)}
                   className="w-full border rounded p-2 text-sm h-24"
                   placeholder={DEFAULT_REWORK_KIND_OPTIONS.join('\n')}
                 />
                 <p className="fi-tap-text text-slate-500 mt-1">
                   空にすると既定（{DEFAULT_REWORK_KIND_OPTIONS.join('・')}）に戻ります。
                   「{UNKNOWN_KIND}」は決めていない物の置き場所なので、書かなくても必ず最後に付きます。
                   「{UNKNOWN_CAUSE}」は種別ではない（原因そのものが引けなかった分の別枠）ので、ここには書けません。
                 </p>
               </div>
  
               <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
                 {complaintOptionsText.split('\n').map(s => s.trim()).filter(Boolean).map((opt, idx) => (
                   <div key={`${opt}-${idx}`} className="flex items-center gap-2">
                     <span className="flex-1 text-sm text-slate-700 truncate" title={opt}>{opt}</span>
                     <select
                       value={localComplaintKinds[opt] || UNKNOWN_KIND}
                       onChange={e => setLocalComplaintKinds(prev => ({ ...prev, [opt]: e.target.value }))}
                       className="border rounded px-2 py-1 text-xs font-bold bg-white text-slate-700 w-40"
                     >
                       {/* ⚠選んだ後に語彙から消された種別も、消えた事が分かるように残して出す(黙って別の物に化けさせない) */}
                       {[...new Set([...editingKindOptions, ...(localComplaintKinds[opt] ? [localComplaintKinds[opt]] : [])])].map(k => <option key={k} value={k}>{k}</option>)}
                     </select>
                   </div>
                 ))}
                 {complaintOptionsText.split('\n').map(s => s.trim()).filter(Boolean).length === 0 && (
                   <div className="text-xs text-slate-400 py-3 text-center">上の欄に項目を書くと、ここに種別を選ぶ欄が出ます</div>
                 )}
               </div>
             </div>
  );
}
