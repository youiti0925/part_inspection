// 📥 入荷登録Excel 取込の「自動化スイッチ」と「押す前に見せる」窓(製品 App.jsx 51121-51183・51919-52073 を部品の言葉で写した物)。
//   P034: confirm() の文字だけで見せていたのを、表の窓にして「取込み確定」を押すまで何も書かない。
//   P035: 品目コードだけの行を品質規格のテンプレで展開する／納期◯日前／入荷◯日前／入荷の既定日数 を取込の時に ON/OFF できる。
//   🚨 外した時に「何が起きるか」を1行で書く(外した人が結果を予想できるように)。
import React from 'react';
import { Upload, X, Plus } from 'lucide-react';

export function LotImportOptionsPanel({ opts, setOpts }) {
  const set = (k, v) => setOpts(o => ({ ...o, [k]: v }));
  return (
    <details className="mb-4 rounded-lg border-2 border-amber-300 bg-amber-50/70">
      <summary className="list-none cursor-pointer select-none px-3 min-h-[44px] flex items-center gap-1.5 text-xs font-black text-amber-900">
        <Upload className="w-3.5 h-3.5"/> Excel取込の自動化（上の「Excel取込」ボタンに効きます・確定前に内容を見せます）
      </summary>
      <div className="px-3 pb-3">
        <label className="flex items-start gap-2 py-1 cursor-pointer">
          <input type="checkbox" className="mt-0.5 w-4 h-4 shrink-0" checked={opts.useModelTemplates} onChange={e => set('useModelTemplates', e.target.checked)}/>
          <span className="text-xs text-slate-800 leading-snug">
            <span className="font-bold">品目コードだけの行を、品質規格のテンプレで展開する</span>
            <span className="block text-xs text-slate-600">
              <span className="font-bold text-rose-700">外すと：</span>テンプレートID列が空の行は<span className="font-bold">1件も登録されず</span>、確認の窓に「テンプレートID列が空です」として出ます。
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 py-1 cursor-pointer">
          <input type="checkbox" className="mt-0.5 w-4 h-4 shrink-0" checked={opts.useDueOffset} onChange={e => set('useDueOffset', e.target.checked)}/>
          <span className="text-xs text-slate-800 leading-snug">
            <span className="font-bold">品質規格の「🗓 納期◯日前」を効かせる</span>
            <span className="block text-xs text-slate-600"><span className="font-bold text-rose-700">外すと：</span>どのロットも納期は<span className="font-bold">Excelに書いてある納期そのまま</span>になります。</span>
          </span>
        </label>
        <label className="flex items-start gap-2 py-1 cursor-pointer">
          <input type="checkbox" className="mt-0.5 w-4 h-4 shrink-0" checked={opts.useEntryOffset} onChange={e => set('useEntryOffset', e.target.checked)}/>
          <span className="text-xs text-slate-800 leading-snug">
            <span className="font-bold">品質規格の「🚚 入荷は納期の◯日前」を効かせる</span>
            <span className="block text-xs text-slate-600"><span className="font-bold text-rose-700">外すと：</span>品質規格の登録を無視して、<span className="font-bold">下の既定値だけ</span>で入荷を決めます。</span>
          </span>
        </label>
        <div className="flex items-center gap-2 flex-wrap pt-2 mt-1.5 border-t border-amber-300">
          <span className="text-xs text-slate-700">入荷の既定は納期の</span>
          <input type="number" value={opts.defaultEntryDaysBefore}
            onChange={e => { const v = parseInt(e.target.value, 10); set('defaultEntryDaysBefore', Number.isFinite(v) ? v : 0); }}
            className="w-16 border rounded p-1 text-xs text-center font-mono bg-white min-h-[36px]"/>
          <span className="text-xs text-slate-700">日前</span>
          <span className="text-xs text-slate-500">（入庫日時が空で、品質規格にも「入荷◯日前」が無いとき。土日・工場の休みは前の営業日へ寄せます）</span>
        </div>
        <div className="text-xs text-slate-500 mt-1.5">※ Excelの<span className="font-bold">テンプレートID列</span>と<span className="font-bold">入庫日時</span>に書いた値は、いつでもこの設定より優先されます。</div>
      </div>
    </details>
  );
}

const fmtMs = (ms) => {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms); const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function LotImportPreviewModal({ preview, templates, busy, onCancel, onConfirm }) {
  if (!preview) return null;
  const tplName = (id) => (templates || []).find(t => t.id === id)?.name || id;
  const o = preview.options || {};
  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" data-lot-import-preview>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden">
        <div className="bg-amber-600 text-white px-4 py-3 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-black text-lg">入荷登録Excel: {preview.dataRowCount}行 → {preview.plan.length}ロットになります</div>
            {preview.fileName && <div className="text-xs opacity-90 truncate">{preview.fileName}</div>}
          </div>
          <button onClick={onCancel} disabled={busy} className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded hover:bg-amber-700" aria-label="閉じる"><X className="w-5 h-5"/></button>
        </div>
        <div className="p-4 overflow-y-auto space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2"><div className="text-xs font-bold text-emerald-700">新規</div><div className="text-xl font-black text-emerald-800">{preview.newCount}<span className="text-xs"> 件</span></div></div>
            <div className="rounded-lg border border-sky-200 bg-sky-50 p-2"><div className="text-xs font-bold text-sky-700">上書き</div><div className="text-xl font-black text-sky-800">{preview.updateCount}<span className="text-xs"> 件</span></div></div>
            <div className={`rounded-lg border p-2 ${preview.skipCount > 0 ? 'border-rose-300 bg-rose-50' : 'border-slate-200 bg-slate-50'}`}><div className="text-xs font-bold text-slate-600">作らない行</div><div className="text-xl font-black">{preview.skipCount}<span className="text-xs"> 件</span></div></div>
            <div className={`rounded-lg border p-2 ${preview.weekendCount > 0 ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-slate-50'}`}><div className="text-xs font-bold text-slate-600">入荷を休みから前の営業日へ寄せた</div><div className="text-xl font-black">{preview.weekendCount}<span className="text-xs"> 件</span></div></div>
          </div>
          <div className="text-xs flex flex-wrap gap-x-3 gap-y-1 bg-slate-50 border rounded p-2">
            <span className={o.useModelTemplates ? 'font-bold text-emerald-700' : 'font-bold text-rose-700'}>品質規格テンプレ展開 {o.useModelTemplates ? 'ON' : 'OFF'}</span>
            <span className={o.useDueOffset ? 'font-bold text-emerald-700' : 'font-bold text-rose-700'}>🗓納期ずらし {o.useDueOffset ? 'ON' : 'OFF'}</span>
            <span className={o.useEntryOffset ? 'font-bold text-emerald-700' : 'font-bold text-rose-700'}>🚚入荷ずらし {o.useEntryOffset ? 'ON' : 'OFF'}</span>
            <span className="font-bold text-slate-700">入荷の既定 = 納期の {o.defaultEntryDaysBefore} 日前</span>
          </div>
          {preview.plan.length > 0 && (
            <div>
              <div className="text-sm font-black text-slate-800 flex items-center gap-1 mb-1"><Plus className="w-4 h-4"/> 作成・更新するロット</div>
              <div className="overflow-x-auto border rounded">
                <table className="w-full text-xs">
                  <thead className="bg-slate-100 text-slate-600"><tr>
                    <th className="p-1.5 text-left">種類</th><th className="p-1.5 text-left">指図</th><th className="p-1.5 text-left">品目コード</th><th className="p-1.5 text-left">品名</th><th className="p-1.5 text-left">テンプレ</th><th className="p-1.5 text-right">台数</th><th className="p-1.5 text-left">納期</th><th className="p-1.5 text-left">入荷</th>
                  </tr></thead>
                  <tbody>
                    {preview.plan.map((p, i) => (
                      <tr key={i} className="border-t">
                        <td className={`p-1.5 font-bold ${p.type === 'new' ? 'text-emerald-700' : 'text-sky-700'}`}>{p.type === 'new' ? '新規' : (p.isUntouched ? '上書き' : '納期/優先度のみ')}</td>
                        <td className="p-1.5 font-mono">{p.row.orderNo}</td>
                        <td className="p-1.5 font-mono">{p.row.model}</td>
                        <td className="p-1.5">{p.row.modelText || '—'}</td>
                        <td className="p-1.5">{tplName(p.row.templateId)}</td>
                        <td className="p-1.5 text-right">{p.row.qty}</td>
                        <td className="p-1.5">{p.row.dueDate || '—'}</td>
                        <td className="p-1.5">{fmtMs(p.row.entryAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {preview.skipRows.length > 0 && (
            <div>
              <div className="text-sm font-black text-rose-700 mb-1">作らない行（{preview.skipRows.length}件）</div>
              <ul className="text-xs text-slate-700 border rounded p-2 bg-rose-50/40 space-y-0.5 max-h-48 overflow-y-auto">
                {preview.skipRows.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          )}
        </div>
        <div className="border-t p-3 flex justify-end gap-2 bg-slate-50">
          <button onClick={onCancel} disabled={busy} className="px-4 min-h-[44px] rounded-lg border bg-white font-bold text-slate-700">キャンセル（何も変えない）</button>
          <button onClick={onConfirm} disabled={busy || preview.plan.length === 0} className="px-5 min-h-[44px] rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-black disabled:opacity-40">{busy ? '書き込み中…' : '取込み確定'}</button>
        </div>
      </div>
    </div>
  );
}
