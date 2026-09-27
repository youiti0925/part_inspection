// 📊 進捗管理表 取込プレビューの追加の欄(製品 51478-51611 を部品へ。文言の「型式」は「品目コード」に)。
//   P152 元表の食い違い(数えるだけ・取込は止めない。文は純関数 progressSheetAudit.js)
//   P095 表では終わっているのに検査リストに残っている物(作業記録の無い物だけ消す・3割の安全弁・確定の前にもう一度確認)
//   ほか: 選び口(仮取込 / 納期を合わせる / 消す)・アプリではもう検査が終わっている指図(既定は作らない)
//   🚨 数える・決めるのは純関数(planProgressImport / auditProgressRows)。ここは見せて、押された選び口を返すだけ。
import React from 'react';
import { auditSummaryText } from './domain/progressSheetAudit.js';

const TAP = { minHeight: 'max(2.75rem, 44px)' };

const ProgressImportExtras = ({ preview, templates = [], onSetOpt }) => {
  if (!preview) return null;
  const opts = preview.opts || {};
  const counts = preview.counts || {};
  const stale = preview.stale || [];
  const alreadyDone = preview.alreadyDone || [];
  const set = (patch) => { if (typeof onSetOpt === 'function') onSetOpt(patch); };
  return (
    <>
      {preview.audit && preview.audit.issues && preview.audit.issues.length > 0 ? (
        <details className="rounded-lg border-2 border-amber-400 bg-amber-50 p-3" data-progress-audit={preview.audit.issues.length}>
          <summary className="text-sm cursor-pointer font-black text-amber-900" style={{ ...TAP, display: 'flex', alignItems: 'center' }}>
            🔎 {auditSummaryText(preview.audit)} — 表を直す時の手掛かりです。取込は止めません
          </summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead><tr className="text-left text-amber-900 border-b border-amber-300"><th className="py-1 pr-2">行</th><th className="py-1 pr-2">指図</th><th className="py-1 pr-2">品目コード</th><th className="py-1 pr-2">何が</th><th className="py-1 pr-2">元のセル</th><th className="py-1">中身</th></tr></thead>
              <tbody>
                {preview.audit.issues.slice(0, 60).map((it, i) => (
                  <tr key={`${it.row}-${it.code}-${i}`} className="border-b border-amber-100 align-top">
                    <td className="py-1 pr-2 tabular-nums">{it.row}</td><td className="py-1 pr-2 tabular-nums">{it.orderNo}</td><td className="py-1 pr-2">{it.model}</td>
                    <td className="py-1 pr-2 font-bold" title={((preview.audit.codes || {})[it.code] || {}).hint || ''}>{it.label}</td>
                    <td className="py-1 pr-2">{(it.cells || []).map((c) => `${c.col}「${c.text}」`).join(' / ')}</td>
                    <td className="py-1 text-slate-700">{it.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.audit.issues.length > 60 ? <div className="mt-1 text-xs text-amber-900">…他 {preview.audit.issues.length - 60}件（上の60件だけ出しています）</div> : null}
          </div>
        </details>
      ) : null}

      {preview.staleGuard && (
        <div data-progress-import-staleguard="1" className="bg-rose-50 border-2 border-rose-400 rounded-lg p-3">
          <div className="text-sm font-black text-rose-800 mb-1">⚠ 消す対象が多すぎるので「表では終わっている物を消す」を 一旦 OFF にしました</div>
          <div className="text-xs text-rose-700 leading-relaxed">
            消す候補が <b>{preview.staleGuard.deletable}件（{preview.staleGuard.deletableOrders || 0}指図）</b>（検査リストの未完了 {preview.staleGuard.openLotCount}件 のうち。
            1回で消してよい上限は {preview.staleGuard.pct}% = {preview.staleGuard.limit}件）。
            <b>表のシート名・列が今の表と合っているか確かめてください。</b>
            合っていないと、表に載っている行がごっそり「終わっている」に見えます。
            確かめた上で消すなら、下の赤いチェックを自分で ON にしてください。
          </div>
        </div>
      )}

      <div data-progress-import-opts="1" className="bg-indigo-50 border border-indigo-200 rounded-lg p-3 flex flex-col gap-2 text-sm">
        <label className="flex items-start gap-2 min-h-11 cursor-pointer">
          <input type="checkbox" className="mt-1 w-5 h-5 accent-indigo-600 shrink-0" checked={!!opts.includeProvisional} onChange={(e) => set({ includeProvisional: e.target.checked })} />
          <span><b>納期の日付がまだ無い行も取り込む</b> — 入荷の日などから<b className="text-amber-700">仮の納期</b>を付けます。
            {opts.includeProvisional
              ? <span className="ml-1 text-amber-700 font-bold">いま仮の納期 {counts.provisional || 0}件</span>
              : <span className="ml-1 text-slate-500">（OFF: 日付の入った行だけ）</span>}
          </span>
        </label>
        <label className="flex items-start gap-2 min-h-11 cursor-pointer">
          <input type="checkbox" className="mt-1 w-5 h-5 accent-indigo-600 shrink-0" checked={opts.updateDue !== false} onChange={(e) => set({ updateDue: e.target.checked })} />
          <span><b>検査リストにあるロットの納期・入庫・台数を表に合わせる</b>（更新 {(preview.updateLots || []).length}件。うち<b className="text-amber-700">入庫が変わる {counts.entryChange || 0}件</b>。作業記録のあるロットの台数と入庫は変えません）</span>
        </label>
        <label className="flex items-start gap-2 min-h-11 cursor-pointer">
          <input type="checkbox" className="mt-1 w-5 h-5 accent-rose-600 shrink-0" checked={!!opts.deleteStale} onChange={(e) => set({ deleteStale: e.target.checked })} />
          <span><b className="text-rose-700">表では終わっている（出荷済・検査終了）のに検査リストに残っている物を消す</b> — 作業記録の無い {counts.staleDeletable || 0}件（{counts.staleDeletableOrders || 0}指図）だけ。作業記録のある {stale.length - (counts.staleDeletable || 0)}件は消しません（下の表で ⚠）。確定の前にもう一度確認します。</span>
        </label>
      </div>

      {alreadyDone.length > 0 && (
        <div data-progress-import-alreadydone="1" className="bg-amber-50 border-2 border-amber-400 rounded-lg p-3">
          <div className="text-sm font-black text-amber-900 mb-1">🏁 アプリでは もう検査が終わっている指図（{alreadyDone.length}件）— 既定では作りません</div>
          <div className="text-xs text-amber-800 leading-relaxed mb-2">
            進捗管理表は 1日ぶん古いので、今日 検査が終わった指図がまだ「未完」で載っています。
            このまま作ると <b>同じ指図のロットが2つ並びます</b>。作る必要があるときだけ、下のチェックを ON にしてください。
          </div>
          <div className="flex flex-wrap gap-1 text-xs mb-2 max-h-32 overflow-y-auto">
            {alreadyDone.map((c, i) => (
              <span key={i} className="bg-white border border-amber-300 rounded px-1.5 py-0.5">
                <span className="font-mono font-bold">{c.orderNo}</span> {c.model} <span className="text-indigo-700">{c.templateName}</span> {c.quantity}台 納期{c.dueDate}
              </span>
            ))}
          </div>
          <label className="flex items-start gap-2 cursor-pointer" style={TAP}>
            <input type="checkbox" className="mt-1 w-5 h-5 accent-amber-600 shrink-0" checked={!!opts.createDone} onChange={(e) => set({ createDone: e.target.checked })} />
            <span className="text-sm text-amber-900">それでも <b>{alreadyDone.length}件</b> を新しく作る（同じ指図が2つ並ぶことを承知の上で）</span>
          </label>
        </div>
      )}

      {stale.length > 0 && (
        <div data-progress-import-stale="1" className="border border-rose-200 rounded-lg overflow-hidden">
          <div className="bg-rose-50 px-3 py-2 font-bold text-rose-800 text-sm border-b border-rose-200">
            🚫 表では終わっているのに検査リストに残っている ({stale.length}件)
          </div>
          <div className="overflow-x-auto max-h-64">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="p-2 text-left">指図</th>
                  <th className="p-2 text-left">品目コード</th>
                  <th className="p-2 text-left">テンプレ</th>
                  <th className="p-2 text-left">表の状態</th>
                  <th className="p-2 text-left">アプリの記録</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {stale.map((x, i) => (
                  <tr key={i} className={x.hasTasks ? 'bg-amber-50/60' : ''}>
                    <td className="p-2 font-mono font-bold">{x.orderNo}</td>
                    <td className="p-2 font-bold">{x.model}</td>
                    <td className="p-2 text-indigo-700 truncate max-w-[12rem]">{(templates.find((t) => t.id === x.templateId) || {}).name || x.templateId}</td>
                    <td className="p-2 text-slate-600">{x.reason}</td>
                    <td className="p-2">{x.hasTasks ? <span className="text-amber-700 font-bold">⚠ 作業記録あり（消しません・手で確かめてください）</span> : <span className="text-slate-500">記録なし{opts.deleteStale ? <b className="ml-1 text-rose-700">→ 消す</b> : ''}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
};

export default ProgressImportExtras;
