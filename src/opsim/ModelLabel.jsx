// =============================================================================
//  src/opsim/ModelLabel.jsx — 札の「品目コード｜添え書き」(画面の部品)
// -----------------------------------------------------------------------------
//  🚨 操業シミュレーションで品目コードを出す札は **必ずこれを通す**(決まり12: 品目コードだけでは意味が無い)。
//   最終検査の添え書き=特注仕様(specialConditions)。製品検査なら=テンプレ名。
//   何を添えるかは呼ぶ側(最終検査: src/opsimfi/assignView.js の specialByLotOf)が決め、
//   ここは受け取った文字を畳んで出すだけ。畳み方は subLabel.js(理由もそこに)。
//  見張り: scripts/verify-opsimfi.mjs 約束H
//   ・品目コードを素で出す札(>{x.model}<)が有れば赤
//   ・<ModelLabel に sub= が無ければ赤
//  🚨 sub が空の時は添え書きを **出さない**(「(特注なし)」の空の札を作らない)。品目コードだけ。
//  🚨 px を直書きしない(文字の大きさは呼ぶ側の Tailwind 段)。
// =============================================================================
import React from 'react';
import { foldSub, fullLabelOf } from './subLabel.js';

const clean = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * @param {string}  model      品目コード
 * @param {string}  sub        添え書き(特注仕様／テンプレ名)。空なら品目コードだけ
 * @param {boolean} stack      true=2段(上に品目コード・下に添え書き)。狭い列(納期一覧・ロットの流れ)用
 * @param {string}  modelClass 品目コードの文字の段(Tailwind)
 * @param {string}  subClass   添え書きの文字の段(Tailwind)
 * @param {string}  className  外枠に足す class(min-w-0 flex-1 等)
 */
export function ModelLabel({ model, sub = '', stack = false, modelClass = '', subClass = '', className = '', sep = '｜' }) {
  const m = clean(model) || '(品目コードなし)';
  const f = foldSub(sub);
  const title = f.full ? fullLabelOf(m, f.full, sep) : undefined;
  if (stack) {
    return (
      <span className={`block min-w-0 ${className}`} title={title} data-model={m} data-sub={f.full || undefined}>
        <span className={`block truncate ${modelClass}`}>{m}</span>
        {f.short ? <span className={`block truncate ${subClass}`}>{f.short}</span> : null}
      </span>
    );
  }
  return (
    <span className={`flex min-w-0 items-baseline gap-1 ${className}`} title={title} data-model={m} data-sub={f.full || undefined}>
      {/* 品目コードは切らない(shrink-0)。狭い時に縮むのは添え書きの側(実画面 2026-09-03: 11rem の列で品目コードが「RD…」に切れた)。 */}
      <span className={`shrink-0 ${modelClass}`}>{m}</span>
      {f.short ? <span className="shrink-0 font-normal text-slate-400">{sep}</span> : null}
      {f.short ? <span className={`min-w-0 truncate ${subClass}`}>{f.short}</span> : null}
    </span>
  );
}

export default ModelLabel;
