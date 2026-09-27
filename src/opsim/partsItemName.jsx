// =============================================================================
//  src/opsim/partsItemName.jsx — 部品だけ: 操業シミュの札で品目コードの横に品名を出す
// -----------------------------------------------------------------------------
//  部品は 型式=品目コード(lot.model)・品名=lot.modelText(無ければ品目名簿 settings.itemMaster)。
//  品名の決め方は resolveItemName 1本(domain/itemMaster.js)。ここは受け取って出すだけ。
//  品名が無ければ何も出さない(空の札を作らない)。
// =============================================================================
import React, { createContext, useContext, useMemo } from 'react';
import { resolveItemName } from '../domain/itemMaster.js';

const ItemNameCtx = createContext(null);

export function ItemNameProvider({ lots, itemMaster, children }) {
  const value = useMemo(() => {
    const textByModel = {};
    for (const l of (Array.isArray(lots) ? lots : Object.values(lots || {}))) {
      if (!l || !l.model || !l.modelText) continue;
      const k = String(l.model);
      if (!textByModel[k]) textByModel[k] = l.modelText;
    }
    return { textByModel, itemMaster: itemMaster || {} };
  }, [lots, itemMaster]);
  return <ItemNameCtx.Provider value={value}>{children}</ItemNameCtx.Provider>;
}

/** 品名の文字だけ(無ければ '')。modelText が渡ればそれが最優先。 */
export function useItemNameOf() {
  const ctx = useContext(ItemNameCtx);
  return (model, modelText = '') => {
    if (!model && !modelText) return '';
    const own = modelText || (ctx && model ? ctx.textByModel[String(model)] : '') || '';
    return resolveItemName(model, own, ctx ? ctx.itemMaster : null);
  };
}

/** 品目コードの横に置く品名の札。品名が無ければ何も出さない。 */
export function ItemNameTag({ model, modelText = '', className = 'font-bold text-slate-600' }) {
  const nameOf = useItemNameOf();
  const nm = nameOf(model, modelText);
  if (!nm) return null;
  return <span className={`ml-1 ${className}`} data-opsim-item-name="1">{nm}</span>;
}
