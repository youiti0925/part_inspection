// 🧾➡📋 P109 品質規格の日数(K33・出荷日の何日前・入荷は納期の何日前)を直した時、検査リストに在るロットの納期・入庫も直す窓。
//   製品 App.jsx 48686-48721(openMasterPropagate・applyMasterPropagate)と窓 51798-51904 を部品の言葉で写した物。
//   判定は製品と対の純関数 planMasterChangeUpdates だけ(ここでは数えない)。
//   🚨 部品の品質規格は1つの規格を複数の品目コードで共有するので、その規格を指す品目コードごとに呼んで1つの窓にまとめる。
//   🚨 何件・どのロットがどう変わるかを押す前に全部見せる。0件なら窓を出さない。
import React from 'react';
import { X } from 'lucide-react';


const fmtMs = (ms) => {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms); const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function QsDaysPropagateModal({ plan, busy, onApply, onCancel }) {
  if (!plan) return null;
  return (
    <div className="fixed inset-0 bg-black/50 z-[70] flex items-center justify-center p-4" data-qs-propagate>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden">
        <div className="bg-teal-700 text-white px-4 py-3 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-lg font-bold">🧾➡📋 品質規格の日数を変えました</h2>
            <div className="text-base font-black">この変更で 検査リストの {plan.updates.length}件 の納期／入庫が変わります</div>
            <div className="text-xs opacity-90">
              規格 <b>{plan.standardNo || '?'}</b>（品目コード {plan.models.length}件）
              {' / 納期が変わる '}{plan.counts.dueChange}件{' / 入庫が変わる '}{plan.counts.entryChange}件
              {plan.skipped.length ? ` / 直さない ${plan.skipped.length}件` : ''}
              {plan.counts.completedIgnored ? ` / 検査が終わったロット ${plan.counts.completedIgnored}件は触りません` : ''}
            </div>
          </div>
          <button onClick={onCancel} disabled={busy} className="min-h-[44px] min-w-[44px] rounded-full hover:bg-white/10 flex items-center justify-center" aria-label="閉じる"><X className="w-5 h-5"/></button>
        </div>
        <div className="p-4 overflow-y-auto space-y-3">
          <div className="text-xs text-slate-600">品質規格の保存はもう済んでいます。ここで「直さない」を押しても規格の日数はそのままで、検査リストのロットだけ今のままになります。</div>
          <div className="overflow-x-auto border rounded">
            <table className="w-full text-xs">
              <thead className="bg-slate-100 text-slate-600"><tr>
                <th className="p-1.5 text-left">指図</th><th className="p-1.5 text-left">品目コード</th><th className="p-1.5 text-left">納期</th><th className="p-1.5 text-left">入庫</th><th className="p-1.5 text-left">メモ</th>
              </tr></thead>
              <tbody>
                {plan.updates.map(u => (
                  <tr key={u.lotId} className="border-t">
                    <td className="p-1.5 font-mono">{u.orderNo}</td>
                    <td className="p-1.5 font-mono">{u.model}</td>
                    <td className="p-1.5">{u.dueChange ? <><span className="line-through text-slate-400">{u.oldDueDate}</span> → <b>{u.newDueDate}</b></> : (u.oldDueDate || '—')}</td>
                    <td className="p-1.5">{u.entryChange ? <><span className="line-through text-slate-400">{fmtMs(u.oldEntryAt)}</span> → <b>{fmtMs(u.newEntryAt)}</b></> : fmtMs(u.oldEntryAt)}</td>
                    <td className="p-1.5 text-slate-500">{(u.why || []).join(' / ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {plan.skipped.length > 0 && (
            <details className="border rounded">
              <summary className="cursor-pointer px-2 min-h-[44px] flex items-center text-xs font-bold text-slate-600">直さないロット {plan.skipped.length}件（理由つき）</summary>
              <ul className="text-xs text-slate-600 p-2 space-y-0.5 max-h-48 overflow-y-auto">
                {plan.skipped.map(s => <li key={s.lotId}><span className="font-mono">{s.orderNo}</span> {s.model} — {s.reason}</li>)}
              </ul>
            </details>
          )}
        </div>
        <div className="border-t p-3 flex justify-end gap-2 bg-slate-50">
          <button onClick={onCancel} disabled={busy} className="px-4 min-h-[44px] rounded-lg border bg-white font-bold text-slate-700">直さない</button>
          <button onClick={onApply} disabled={busy || plan.updates.length === 0} className="px-5 min-h-[44px] rounded-lg bg-teal-700 hover:bg-teal-800 text-white font-black disabled:opacity-40">{busy || `${plan.updates.length}件を直す`}</button>
        </div>
      </div>
    </div>
  );
}
