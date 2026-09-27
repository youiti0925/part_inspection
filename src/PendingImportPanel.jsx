// 🗂 P057 未登録リスト(製品の「型式マスタ 未登録リスト」を部品へ)。
//   進捗管理表の取込で「品質規格マスタに品目コードの紐付けが無い」ために落ちた行を settings.progressImportPending に残し、
//   品質規格マスタで品目コードに規格(テンプレ)を割り当てたら、ここから Excel を取り込み直さずに検査リストへ登録できる。
//   🚨 まとめる・登録できるかの判定は純関数 pendingGroupsOf(製品と同じ・部品は modelMasters を {} で渡す)。
//   品名は品目名簿から引く(resolveItemName。純関数は変えない)。
import React, { useMemo } from 'react';
import { pendingGroupsOf } from './domain/progressSheet.js';
import { resolveItemName } from './domain/itemMaster.js';

const ymdOf = (ms) => {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const PendingImportPanel = ({ settings = {}, onRegisterPending = null, onRemovePending = null }) => {
  const pend = settings && settings.progressImportPending;
  const rows = useMemo(() => (pend && Array.isArray(pend.rows) ? pend.rows : []), [pend]);
  const groups = useMemo(() => pendingGroupsOf(rows, {
    modelMasters: {},
    qualityStandards: settings.qualityStandards || {},
    modelStandardMap: settings.modelStandardMap || {},
  }), [rows, settings.qualityStandards, settings.modelStandardMap]);
  if (!groups.length) return null;
  return (
    <div data-parts-import-pending={rows.length} className="rounded-lg border-2 border-amber-300 bg-amber-50 p-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-sm font-bold text-amber-900">🗂 未登録リスト — 進捗管理表に在るのに 品質規格マスタに紐付けの無い品目コード（{groups.length}種 / {rows.length}行）</div>
        <div className="text-xs text-amber-800">{pend && pend.fileName ? `取込: ${pend.fileName}` : ''}{pend && pend.at ? ` ${ymdOf(pend.at)}` : ''}</div>
      </div>
      <div className="text-xs text-amber-800 mt-1">
        下の <b>品質規格マスタ</b> で品目コードに規格（使うテンプレート）を割り当てると、その品目コードの行を <b>検査リストへ登録</b> できます（Excel を取り込み直す必要はありません）。
      </div>
      <div className="mt-2 grid gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(20rem, 1fr))' }}>
        {groups.map((g) => {
          const name = resolveItemName(g.model, '', settings.itemMaster);
          return (
            <div key={g.model} data-pending-model={g.model} data-pending-ready={g.ready ? '1' : '0'} className="rounded-lg border border-amber-200 bg-white px-2.5 py-2 flex items-center gap-2 flex-wrap">
              <div className="min-w-0 flex-1">
                <div className="font-mono font-bold text-slate-800 truncate">{g.model}{name ? <span className="font-sans font-normal text-xs text-slate-600 ml-1">{name}</span> : null} <span className="font-sans font-normal text-xs text-slate-500">{g.rows.length}行 / {g.orders}指図</span></div>
                <div className="text-xs text-slate-500 truncate">{g.rows.slice(0, 4).map((r) => r.orderNo).join('・')}{g.rows.length > 4 ? ' …' : ''}</div>
                <div className="text-xs font-bold">{g.ready ? <span className="text-emerald-700">✓ 規格(テンプレ)割当済み — 登録できます</span> : <span className="text-rose-700">品質規格マスタに紐付けが無い</span>}</div>
              </div>
              {g.ready && typeof onRegisterPending === 'function'
                ? <button type="button" onClick={() => onRegisterPending(g.model)} className="min-h-11 px-3 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold shadow">検査リストへ登録</button>
                : null}
              {typeof onRemovePending === 'function'
                ? <button type="button" onClick={() => onRemovePending(g.model)} title="登録せずにリストから外す" className="min-h-11 px-2 rounded border border-slate-200 text-slate-500 hover:bg-slate-50 text-xs">外す</button>
                : null}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default PendingImportPanel;
