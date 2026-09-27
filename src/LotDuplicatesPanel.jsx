import React, { useMemo } from 'react';
import { duplicateOpenLotsOf, duplicateSummaryText } from './domain/lotDuplicates.js';

// 🧯 重複ロット(同じ 指図×品目コード×テンプレ×特注仕様 の未完了ロットが2件以上)。製品 App.jsx の札を部品へ写した物。
//   数えるのは純関数 lotDuplicates.js(製品と1バイト同じ)。消すのは人が押した時だけ(deleteData('lots') ただ1つ)。
//   残す1件は 記録がある物(無ければ一番古い物)。記録が両方に在る組・要確認の組は消す口を出さない。
//   🚨 製品は消せなかった分を console へ捨てていた。部品では何件消せなかったかを alert で出す(黙って捨てない)。
//   文言: 純関数の「型式」は部品の画面では「品目コード」に言い換える。
const ymd = (ms) => {
  const x = new Date(ms);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

const LotDuplicatesPanel = ({ lots = [], templates = [], deleteData = null }) => {
  const groups = useMemo(() => duplicateOpenLotsOf(lots), [lots]);
  if (!Array.isArray(groups) || groups.length === 0) return null;
  const canDelete = typeof deleteData === 'function';

  const onDeleteLots = async (ids) => {
    const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
    if (!list.length || !canDelete) return;
    if (!window.confirm(`重複しているロット ${list.length}件を検査リストから消します（作業の記録が無い方だけ）。よろしいですか？`)) return;
    const failed = [];
    for (const id of list) {
      try { await deleteData('lots', id); } catch (e) { console.error('重複の削除に失敗', id, e); failed.push(id); }
    }
    if (failed.length) window.alert(`${list.length}件のうち ${failed.length}件を消せませんでした。通信を確かめてから、もう一度押してください。`);
  };

  const removable = groups.reduce((n, g) => n + g.removeIds.length, 0);
  return (
    <div data-lot-duplicates={groups.length} className="mb-4 rounded-lg border-2 border-rose-300 bg-rose-50 p-3">
      <div className="text-sm font-bold text-rose-900">🧯 重複しているロット — {duplicateSummaryText(groups).replace(/型式/g, '品目コード')}</div>
      <div className="text-xs text-rose-800 mt-1">残す1件＝作業の記録がある物、無ければ一番古い物。記録が両方に在る組は、人が見て決めてください。</div>
      <div className="mt-2 flex flex-col gap-1">
        {groups.slice(0, 60).map((g) => (
          <div key={g.key} data-lot-duplicate-group={g.key} className="flex flex-wrap items-center gap-2 rounded border border-rose-200 bg-white px-2 py-1">
            <span className="text-xs font-bold text-slate-800">指図 {g.orderNo} {g.model}｜{(templates.find((t) => t.id === g.templateId) || {}).name || g.templateId}</span>
            <span className="text-xs text-slate-600">{g.needsReview ? `要確認（${g.differs.map((d) => d.label).join('・').replace(/型式/g, '品目コード')}が違う。同じ物と決められないので一括削除に入れません） ` : ''}{g.lots.map((r) => `${r.id === g.keepId ? '残す' : (r.hasWork ? '記録あり' : '消せる')}: ${r.createdAt ? ymd(r.createdAt) : '日付なし'} ${r.importSource || '手'} 納期${r.dueDate || '—'}`).join(' ／ ')}</span>
            {g.removeIds.length > 0 && canDelete
              ? <button type="button" data-lot-duplicates-remove={g.removeIds.length} onClick={() => onDeleteLots(g.removeIds)} className="min-h-11 px-3 rounded-lg border-2 border-rose-400 bg-white text-rose-700 font-black text-xs ml-auto">記録の無い {g.removeIds.length}件を消す</button>
              : <span className="text-xs text-slate-500 ml-auto">記録が両方に在るので、人が見て決めてください</span>}
          </div>
        ))}
        {removable > 0 && canDelete ? (
          <button type="button" data-lot-duplicates-remove="all" onClick={() => onDeleteLots(groups.flatMap((g) => g.removeIds))} className="min-h-11 self-start px-3 rounded-lg bg-rose-600 text-white font-black text-xs">記録の無い重複を全部消す（{removable}件）</button>
        ) : null}
      </div>
    </div>
  );
};

export default LotDuplicatesPanel;
