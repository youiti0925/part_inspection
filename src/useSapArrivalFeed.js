// 🔗 操業シミュレーションの画面が「SAP から見込んだ検査の到着」を読む口
// 旗(feature:sapProgress='0' で OFF・既定 ON)が OFF、または SAP の xlsx を読んでいなければ null(=今までと同じ)。
import { useSyncExternalStore } from 'react';
import { getSapArrivals, subscribeSapArrivals, sapFlagOn } from './domain/sapArrivalStore.js';

export function useSapArrivalFeed() {
    const st = useSyncExternalStore(subscribeSapArrivals, getSapArrivals, getSapArrivals);
    return st && st.rows && st.rows.length && sapFlagOn() ? st : null;
}
