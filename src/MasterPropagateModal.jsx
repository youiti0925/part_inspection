// 📅 P106 品目マスタの日数を打ち替えた → 検査リストの関係するロットも直すかの窓(製品 App.jsx の窓を写し、「型式」を「品目コード」に)。
//   判定は純関数 planMasterChangeUpdates(製品と1バイト同じ)。純関数の理由の文言に出る「型式マスタ」は、ここで「品目マスタ」に読み替えて出す。
//   🚨 品目マスタの保存はもう済んでいる。ここで押さなくてもマスタは新しい値のまま。0件なら呼ぶ側が窓を出さない。
import React from 'react';
import { X, Check, Loader2 } from 'lucide-react';

const TAP = { minHeight: 'max(2.75rem, 44px)' };
const partsWords = (s) => String(s == null ? '' : s).replace(/型式マスタ/g, '品目マスタ').replace(/型式/g, '品目コード');

export const MasterPropagateBusy = ({ text }) => (text ? (
  <div data-master-propagate-busy="1" className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[80] bg-teal-700 text-white px-4 py-3 rounded-xl shadow-xl text-sm font-bold flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> {text}</div>
) : null);

const MasterPropagateModal = ({ plan, onApply, onClose }) => {
  if (!plan) return null;
  const updates = plan.updates || [];
  const skipped = plan.skipped || [];
  return (
    <div className="fixed inset-0 z-[70] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
      <div data-master-propagate="1" className="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden">
        <div className="bg-teal-600 text-white p-4 flex justify-between items-center gap-2 shrink-0">
          <div className="min-w-0">
            <h2 className="text-lg font-bold">📋➡📅 品目マスタの日数を変えました</h2>
            <div className="text-base font-black">この変更で 検査リストの {updates.length}件 の納期／入庫が変わります</div>
            <div className="text-xs opacity-90">
              品目コード <b>{plan.model}</b>
              {' / 納期が変わる '}{plan.counts?.dueChange || 0}件
              {' / 入庫が変わる '}{plan.counts?.entryChange || 0}件
              {skipped.length ? ` / 直さない ${skipped.length}件` : ''}
              {plan.counts?.completedIgnored ? ` / 検査が終わったロット ${plan.counts.completedIgnored}件は触りません` : ''}
            </div>
          </div>
          <button onClick={onClose} style={{ ...TAP, minWidth: 'max(2.75rem, 44px)' }}
            className="hover:bg-white/10 p-2 rounded-full shrink-0 flex items-center justify-center"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <div className="text-xs text-slate-600 bg-teal-50 border border-teal-200 rounded p-2">
            品目マスタの設定は<b>もう保存してあります</b>。ここで直すのは<b>検査リストに今あるロット</b>だけです。
            検査が終わったロットと、手で登録したロットの納期は動かしません。
          </div>
          <div className="border border-teal-200 rounded-lg overflow-hidden">
            <div className="overflow-x-auto max-h-[46vh]">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-600 sticky top-0">
                  <tr>
                    <th className="p-2 text-left">指図</th>
                    <th className="p-2 text-left">品目コード</th>
                    <th className="p-2 text-center">旧納期 → 新納期</th>
                    <th className="p-2 text-center">旧入庫 → 新入庫</th>
                    <th className="p-2 text-left">理由</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {updates.map((u, i) => (
                    <tr key={i}>
                      <td className="p-2 font-mono font-bold">{u.orderNo}</td>
                      <td className="p-2 font-bold">{u.model}</td>
                      <td className="p-2 text-center font-mono">
                        {u.dueChange
                          ? <span><span className="text-slate-400">{u.oldDueDate}</span><span className="mx-1 text-slate-400">→</span><b className="text-blue-700">{u.newDueDate}</b></span>
                          : <span className="text-slate-300">変わりません</span>}
                      </td>
                      <td className="p-2 text-center font-mono">
                        {u.entryChange
                          ? <span><span className="text-slate-400">{u.oldEntryYMD || '—'}</span><span className="mx-1 text-slate-400">→</span><b className="text-amber-700">{u.newEntryYMD}</b></span>
                          : <span className="text-slate-300">変わりません</span>}
                      </td>
                      <td className="p-2 text-slate-600">{(u.why || []).map(partsWords).join(' / ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {skipped.length > 0 && (
            <details data-master-propagate-skipped="1" className="border border-slate-200 rounded-lg overflow-hidden">
              <summary className="bg-slate-50 px-3 py-2 font-bold text-slate-700 text-sm cursor-pointer flex items-center gap-2" style={TAP}>
                直さないロット ({skipped.length}件) — クリックで理由を見る
              </summary>
              <div className="p-2 flex flex-wrap gap-1 text-xs">
                {skipped.map((s, i) => (
                  <span key={i} className="bg-white border border-slate-300 rounded px-1.5 py-0.5">
                    <span className="font-mono font-bold">{s.orderNo}</span> <span className="text-slate-500">{partsWords(s.reason)}</span>
                  </span>
                ))}
              </div>
            </details>
          )}
        </div>
        <div className="border-t bg-slate-50 p-3 flex justify-end gap-2 shrink-0 flex-wrap">
          <div data-master-propagate-irreversible="1" className="w-full text-sm font-bold text-rose-700 mb-1">
            押すと 検査リストの {updates.length}件 の納期・入庫を書き換えます。<b>取り消せません</b>（元の日付はこの表にしか残りません）。
          </div>
          <button onClick={onClose} style={TAP} className="px-4 border rounded font-bold text-slate-600 bg-white hover:bg-slate-100 text-sm">今はしない</button>
          <button onClick={onApply} style={TAP} className="px-6 bg-teal-600 hover:bg-teal-700 text-white rounded font-bold shadow flex items-center gap-2 text-sm">
            <Check className="w-4 h-4" /> はい、検査リストも直す（{updates.length}件）
          </button>
        </div>
      </div>
    </div>
  );
};

export default MasterPropagateModal;
