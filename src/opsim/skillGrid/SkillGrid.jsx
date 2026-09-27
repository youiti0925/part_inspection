import React, { useId, useState } from 'react';
import { SKILL_GRID_STATES } from './model.js';

function CellDetail({ row, cell, onClose }) {
  return (
    <section aria-label={`${row.templateName}・${cell.workerName}の根拠`} className="rounded-lg border border-slate-300 bg-white p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-bold text-slate-800 flex-1">{cell.workerName} ／ {row.model || '品目コードをまとめて'} ／ {row.templateName}</h3>
        <button type="button" onClick={onClose} className="rounded border border-slate-300 px-3 py-1 text-sm text-slate-700 hover:bg-slate-100">根拠を閉じる</button>
      </div>
      <div className="grid gap-3 md:grid-cols-2 text-sm">
        <div className="space-y-2">
          <p className="text-slate-800"><b className="text-lg tabular-nums">{cell.count}回</b> の完了ロットへの関与。うち担当欄からの補完 {cell.fallbackCount}回。</p>
          {cell.count === 0 ? <p className="text-slate-700">この入力範囲には実績がありません。力量は分かりません。</p> : (
            <details className="rounded border border-slate-200 p-2">
              <summary className="cursor-pointer font-bold text-slate-700">数えたロットを見る</summary>
              <ul className="mt-2 max-h-48 overflow-auto divide-y divide-slate-200">
                {cell.references.map((ref) => <li key={ref.key} className="py-1 flex flex-wrap gap-x-2">
                  <span className="font-medium">{ref.label}</span><span>{ref.model}</span>
                  <span className="text-slate-700">{ref.source === 'lot_worker' ? '担当欄から補完（作業者の記録ではない）' : '作業者名の記録'}</span>
                </li>)}
              </ul>
            </details>
          )}
        </div>
        <div className="space-y-2">
          <p className="font-bold text-slate-800">{cell.registration.summary}（現在の登録）</p>
          {cell.registration.items.length > 0 && <dl className="space-y-1">
            {cell.registration.items.map((item) => <div key={item.skillId} className="flex flex-wrap justify-between gap-x-3 border-b border-slate-100 py-1">
              <dt className="text-slate-700">{item.name}</dt>
              <dd className="font-bold text-slate-800">{item.invalid ? '登録値を確認' : item.label}</dd>
            </div>)}
          </dl>}
          <p className="text-slate-700">工程を絞ったスキルも、このテンプレに付いている物を並べています。全工程を任せられる判定ではありません。</p>
        </div>
      </div>
    </section>
  );
}

/** model は buildSkillGrid の結果だけ。lots/settings を読まず、数え直さない。 */
export function SkillGrid({ model = null }) {
  const id = useId();
  const [grouping, setGrouping] = useState('model');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const sourceRows = grouping === 'template' ? model?.templateRows : model?.rows;
  const search = query.trim().toLocaleLowerCase('ja');
  const rows = (sourceRows || []).filter((row) => !search || [row.templateName, row.model, ...row.models].join(' ').toLocaleLowerCase('ja').includes(search));
  const selectedRow = selected && rows.find((row) => row.key === selected.rowKey);
  const selectedCell = selectedRow?.cells.find((cell) => cell.workerName === selected.workerName);
  const selectCell = (row, cell) => setSelected((current) => current?.rowKey === row.key && current.workerName === cell.workerName ? null : { rowKey: row.key, workerName: cell.workerName });

  if (!model?.ready) return <div role="status" className="rounded-lg border border-slate-300 bg-slate-50 p-4 text-slate-700">実績の元データをまだ受け取っていません。ロット・テンプレ・作業者が揃ってから表示します。</div>;

  return (
    <section aria-labelledby={`${id}-title`} data-skill-grid="root" className="min-w-0 space-y-3 text-slate-800">
      <header className="space-y-1">
        <h2 id={`${id}-title`} className="text-lg font-bold">誰が、何ロットやったか</h2>
        <p className="text-sm text-slate-700">完了ロットへの関与回数と、現在の登録スキル。セルを押すと根拠を確認できます。</p>
      </header>
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-sm font-bold">
          <span className="block">まとめ方</span>
          <select value={grouping} onChange={(event) => { setGrouping(event.target.value); setSelected(null); }} className="rounded border border-slate-300 bg-white px-3 py-2">
            <option value="model">品目コード × テンプレ</option><option value="template">テンプレごと（品目コードを合算）</option>
          </select>
        </label>
        <label className="space-y-1 text-sm font-bold flex-1 min-w-48">
          <span className="block">品目コード・テンプレを探す</span>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="品目コードまたはテンプレ名" className="w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" />
        </label>
        <p className="text-sm text-slate-700 pb-2">完了ロット <b className="tabular-nums">{model.audit.completedLotCount}</b>件 ／ 人ごとの回数は重複します</p>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="実績と登録の凡例">
        {Object.entries(SKILL_GRID_STATES).map(([key, tone]) => <span key={key} className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className={`inline-block h-3 w-3 ${tone.dot}`} /><span>{tone.label}</span>
        </span>)}
      </div>
      <p className="text-sm text-slate-700">登録ありは「教育中」を含みます。色は記録の有無で、力量・割付の判定ではありません。</p>
      {!model.historyComplete && <p role="status" className="border-l-4 border-slate-400 bg-slate-100 px-3 py-2 text-sm text-slate-800">履歴を全部受け取れたか未確認です。0回は、この入力範囲での0回です。</p>}
      {model.sourceLabel && <p className="text-sm text-slate-700">データの範囲：{model.sourceLabel}</p>}
      {selectedCell && <CellDetail row={selectedRow} cell={selectedCell} onClose={() => setSelected(null)} />}

      <div tabIndex={0} role="region" aria-label="実績と登録の表。横にスクロールできます" className="overflow-auto rounded-lg border border-slate-300 max-h-[65vh] focus-visible:outline focus-visible:outline-sky-700">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <caption className="sr-only">品目コードとテンプレごとの、作業者別完了ロット関与回数と登録スキル。回数は能力認定ではありません。</caption>
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 top-0 z-30 min-w-64 border-b border-slate-300 bg-slate-100 p-3 text-left">{grouping === 'template' ? 'テンプレ' : '品目コード × テンプレ'}</th>
              {model.people.map((person) => <th scope="col" key={person.name} className="sticky top-0 z-20 min-w-48 border-b border-l border-slate-300 bg-slate-100 px-2 py-3 text-center">
                <span className="font-bold">{person.name}</span>
                {person.paused && <span className="ml-1 font-normal text-slate-700">休止中</span>}
                {!person.inRoster && <span className="ml-1 font-normal text-slate-700">名簿外</span>}
                {person.ambiguous && <span className="ml-1 font-normal text-slate-700">同名を確認</span>}
                <span className="block mt-1 font-normal text-slate-700">関与回数 ／ 登録スキル</span>
              </th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => <tr key={row.key} data-skill-grid-row={row.key}>
              <th scope="row" className="sticky left-0 z-10 border-b border-slate-200 bg-white px-3 py-2 text-left font-normal">
                {grouping === 'model' && <span className="block font-bold text-base">{row.model || '品目コード未記入'}</span>}
                <span className="block text-slate-800">{row.templateName}</span>
                <span className="block text-slate-700 mt-1">完了 {row.completedLotCount}ロット{row.unnamedLotCount > 0 ? ` ／ 作業者不明 ${row.unnamedLotCount}` : ''}</span>
                {grouping === 'template' && <span className="block text-slate-700 break-words">{row.models.join('・') || 'ロット未登録'}</span>}
              </th>
              {row.cells.map((cell) => {
                const tone = SKILL_GRID_STATES[cell.state];
                const expanded = selectedRow?.key === row.key && selectedCell?.workerName === cell.workerName;
                return <td key={cell.workerName} data-skill-grid-state={cell.state} className={`border-b border-l p-1 ${tone.cell}`}>
                  <button type="button" onClick={() => selectCell(row, cell)} aria-expanded={expanded}
                    aria-label={`${row.model || '品目コード合算'}・${row.templateName}・${cell.workerName}：関与 ${cell.count}回、${cell.registration.summary}。根拠を見る`}
                    className={`w-full rounded p-2 text-left focus-visible:outline focus-visible:outline-sky-700 ${expanded ? 'ring-2 ring-inset ring-slate-700' : 'hover:bg-white/60'}`}>
                    <span className="flex items-center justify-between gap-3">
                      <span className={`whitespace-nowrap font-bold text-lg tabular-nums ${tone.ink}`}><span aria-hidden="true" className="text-sm mr-1">{tone.mark}</span>{cell.count}<span className="text-sm font-normal">回</span></span>
                      <span className="text-slate-800">{cell.registration.summary}</span>
                    </span>
                    {cell.fallbackCount > 0 && <span className="block mt-1 text-slate-700">うち担当補完 {cell.fallbackCount}回</span>}
                    {cell.registration.items.length === 1 && cell.registration.hasRegistration && <span className="block mt-1 text-right text-slate-700">{cell.registration.items[0].label}</span>}
                  </button>
                </td>;
              })}
            </tr>)}
            {rows.length === 0 && <tr><td colSpan={model.people.length + 1} className="p-6 text-center text-slate-700">{query ? '該当する品目コード・テンプレはありません。検索を空にすると戻ります。' : 'この入力範囲に品目コードとテンプレの組み合わせがありません。'}</td></tr>}
          </tbody>
        </table>
      </div>
      {model.people.length === 0 && <p role="status" className="text-sm text-slate-700">作業者の名前がありません。名簿と完了ロットの作業者記録を確認してください。</p>}
      <details className="rounded border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700">
        <summary className="cursor-pointer font-bold">数え方・データの不足を見る</summary>
        <div className="mt-2 space-y-2">
          <p>完了した1ロットに同じ人の名前が何工程あっても1回。台数では数えません。未完了ロットの作業は含めません。</p>
          <p>作業者名が無いロットは担当者IDを名簿で補完し、内数を明示します。担当欄の名前だけでは、実際に作業したかは分かりません。</p>
          <p>実績なしは「分かりません」。回数で候補を外しません。この表では割付・教育対象を決めません。</p>
          <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
            <div>作業者不明の完了ロット：{model.audit.unnamedLotCount}件</div>
            <div>担当欄から補完した完了ロット：{model.audit.fallbackLotCount}件</div>
            <div>品目コード未記入：{model.audit.missingModelLotCount}件</div>
            <div>テンプレが見つからないロット：{model.audit.missingTemplateLotCount}件</div>
            <div>同じIDの重複（先の1件だけ採用）：{model.audit.duplicateLotCount}件</div>
            <div>IDなし（入力1件を1ロットと計数）：{model.audit.missingLotIdCount}件</div>
            <div>同名の作業者：{model.audit.ambiguousWorkerNameCount}組</div>
            <div>登録データ：{model.registrationProvided ? '受領済み' : '未受領'}</div>
          </div>
        </div>
      </details>
    </section>
  );
}
