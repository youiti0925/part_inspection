// 🔗 SAP の到着見込みの受け渡し(この端末の メモリの中だけ・保存しない・Firebase に触れない)
// 目的: 設定画面の「SAP 工程の進み」(xlsx を読んだ側)と 操業シミュレーションの画面(ロットを持つ側)の間で、検査の到着見込みを渡す。
// 旗(feature:sapProgress=1)が ON の時だけ 読む側が使う。xlsx を選ばなければ null のまま=今までと同じ。
// 確かめ方: node --test src/domain/__tests__/sapArrival.test.mjs
let state = null;            // { rows: sapRowsWithMs の結果, baseMs, label } | null
const subs = new Set();

export const getSapArrivals = () => state;
export function setSapArrivals(next) { state = next || null; subs.forEach((f) => { try { f(); } catch { /* 1つの購読者の失敗で他を止めない */ } }); }
export function subscribeSapArrivals(f) { subs.add(f); return () => subs.delete(f); }

const FLAG_KEY = 'feature:sapProgress';
/** 旗: localStorage の feature:sapProgress が '1' の時だけ ON(既定 OFF) */
export function sapFlagOn() {
    try { return typeof localStorage !== 'undefined' && localStorage.getItem(FLAG_KEY) === '1'; } catch { return false; }
}
