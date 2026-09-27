// 🧯 P098 同じ指図×品目コード×テンプレ(×特注)の未完了ロットの重複(製品 26405-26426 を部品へ)。
//   数えるのは純関数 domain/lotDuplicates.js(製品と1バイト同じ)。消すのは人が押した時だけ(deleteData('lots', id))。
//   残す1件 = 作業の記録がある物、無ければ一番古い物。数量・工程などが違う組は一括削除に入れない。
//   ⚠ duplicateSummaryText は「型式」と言うので使わない。部品の言葉(品目コード)で自前の1文にする。
import React, { useMemo } from 'react';
import { duplicateOpenLotsOf } from './domain/lotDuplicates.js';

const ymdOf = (ms) => {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '日付なし';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const duplicateSummaryTextParts = (groups = []) => {
  const g = Array.isArray(groups) ? groups : [];
  if (!g.length) return '';
  const lots = g.reduce((n, x) => n + x.lots.length, 0);
  const removable = g.reduce((n, x) => n + x.removeIds.length, 0);
  return `同じ指図×品目コード×テンプレの未完了ロットが ${g.length}組（${lots}件）あります。記録の無い ${removable}件は消せます`;
};

const DuplicateLotsPanel = ({ lots = [], templates = [], deleteData = null }) => {
  const groups = useMemo(() => duplicateOpenLotsOf(lots), [lots]);
  if (!groups.length) return null;
  const canDelete = typeof deleteData === 'function';
  const onDeleteLots = async (ids) => {
    const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
    if (!list.length || !canDelete) return;
    if (!window.confirm(`重複しているロット ${list.length}件を検査リストから消します（作業の記録が無い方だけ）。よろしいですか？`)) return;
    for (const id of list) {
      try { await deleteData('lots', id); } catch (e) { console.error('重複の削除に失敗', id, e); }
    }
  };
  const removableAll = groups.flatMap((g) => g.removeIds);
  return (
    <div data-lot-duplicates={groups.length} className="rounded-lg border-2 border-rose-300 bg-rose-50 p-3">
      <div className="text-sm font-bold text-rose-900">🧯 重複しているロット — {duplicateSummaryTextParts(groups)}</div>
      <div className="text-xs text-rose-800 mt-1">残す1件＝作業の記録がある物、無ければ一番古い物。数量や工程などが違う組は「要確認」として一括削除に入れません。</div>
      <div className="mt-2 flex flex-col gap-1">
        {groups.slice(0, 60).map((g) => (
          <div key={g.key} data-lot-duplicate-group={g.key} className="flex flex-wrap items-center gap-2 rounded border border-rose-200 bg-white px-2 py-1">
            <span className="text-xs font-bold text-slate-800">指図 {g.orderNo} 品目コード {g.model}｜{(templates.find((t) => t.id === g.templateId) || {}).name || g.templateId}</span>
            <span className="text-xs text-slate-600">{g.needsReview ? `要確認（${g.differs.map((d) => d.label).join('・')}が違う。同じ物と決められないので一括削除に入れません） ` : ''}{g.lots.map((r) => `${r.id === g.keepId ? '残す' : (r.hasWork ? '記録あり' : '消せる')}: ${r.createdAt ? ymdOf(r.createdAt) : '日付なし'} ${r.importSource || '手'} 納期${r.dueDate || '—'}`).join(' ／ ')}</span>
            {g.removeIds.length > 0 && canDelete
              ? <button type="button" data-lot-duplicates-remove={g.removeIds.length} onClick={() => onDeleteLots(g.removeIds)} className="min-h-11 px-3 rounded-lg border-2 border-rose-400 bg-white text-rose-700 font-black text-xs ml-auto">記録の無い {g.removeIds.length}件を消す</button>
              : <span className="text-xs text-slate-500 ml-auto">{g.needsReview ? '人が見て決めてください' : '記録が両方に在るので、人が見て決めてください'}</span>}
          </div>
        ))}
        {removableAll.length > 0 && canDelete ? (
          <button type="button" data-lot-duplicates-remove="all" onClick={() => onDeleteLots(removableAll)} className="min-h-11 self-start px-3 rounded-lg bg-rose-600 text-white font-black text-xs">記録の無い重複を全部消す（{removableAll.length}件）</button>
        ) : null}
      </div>
    </div>
  );
};

export default DuplicateLotsPanel;
