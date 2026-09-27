// 「状況→対処→判断」記載ガイド(製品 App.jsx の SJH_TEMPLATE・sjhInsert・SjhGuide をそのまま写した物)。
//   内容欄が自由記述で「最後どうなったか」が分からない問題への対策: 3点セットの型+記入例を見せて記載を促す。
import React from 'react';

export const SJH_TEMPLATE = '状況: \n対処: \n判断: ';
export const sjhInsert = (v) => (v && v.includes('状況:')) ? v : (SJH_TEMPLATE.slice(0, 4) + (v || '') + SJH_TEMPLATE.slice(4));
export const SjhGuide = ({ onInsert = null }) => (
  <div className="fi-tap-text bg-indigo-50/70 border border-indigo-100 rounded-lg p-2 leading-relaxed text-slate-600 mt-1">
    <div className="flex items-center justify-between gap-2 flex-wrap">
      <span>💡 <b>状況→対処→判断</b> の3つを書くと、後から見て「最後どうなったか」が分かります。</span>
      {onInsert && <button type="button" onClick={onInsert} className="shrink-0 fi-tap-text px-2 py-0.5 bg-white border border-indigo-200 rounded font-bold text-indigo-700 hover:bg-indigo-100">✏ 型を挿入</button>}
    </div>
    <details className="mt-1">
      <summary className="cursor-pointer text-slate-500">記入例を見る</summary>
      <div className="mt-1 bg-white border border-slate-200 rounded p-1.5 whitespace-pre-wrap">状況: 2台目の外観にキズ発見(約2mm・カバー右上)。{'\n'}対処: バフ研磨で除去し、再検査で確認。{'\n'}判断: 合格(手直しで対応済み。持ち方を朝礼で周知)</div>
      <div className="mt-1 text-slate-400">「判断」の書き方例: 合格(手直し済) / NG→修正待ち / 様子見(次ロットで再確認) / 上長へ相談中</div>
    </details>
  </div>
);
// 台帳の出所: minor=いつでも登録した単独記録 / interruption=検査中に付けた軽微不良・改善 / ng=カスタムのNG判定理由
export const MINOR_SRC_BADGE = { minor: ['台帳', 'bg-purple-100 text-purple-700'], interruption: ['検査中', 'bg-emerald-100 text-emerald-700'], ng: ['NG判定', 'bg-rose-100 text-rose-700'] };
