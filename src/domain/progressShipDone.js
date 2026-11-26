// 📄 進捗管理表の「U 列(出庫完了日)」を読む(部品検査アプリ側の追加)
// 目的: 部品の指図のリミット = 当てられた組立の指図の 出庫完了日(進捗管理表の U 列)の 2 稼働日前(清水さん 11-18)。そのため U 列を読む。
// 🚨 progressSheet.js は製品検査と md5 が対(1バイトも変えない決まり)なので、ここは部品検査だけの追加ファイル。
//    既存の取り込み(DEFAULT_SHEET_MAP・normalizeSheetMap)は触らない。U 列は 「PARTS_SHEET_MAP」(既定の写し+shipDone:'U')で足す。
//    取り込みの行には shipDone(U 列の生の値)を載せるだけ(App.jsx の読み取り)。何にも使われていなければ 今までと1ミリも変わらない。
// 確かめ方: node --test src/domain/__tests__/progressShipDone.test.mjs
import { DEFAULT_SHEET_MAP, parseShipCell } from './progressSheet.js';

/** 出庫完了日の列(清水さん 11-18)。列の字を変えたい時はここ1か所 */
export const SHIP_DONE_COL = 'U';

/** 既定の割付の写し + U 列。normalizeSheetMap(map, PARTS_SHEET_MAP) の base に渡すと shipDone が残る */
export const PARTS_SHEET_MAP = Object.freeze({ ...DEFAULT_SHEET_MAP, cols: Object.freeze({ ...DEFAULT_SHEET_MAP.cols, shipDone: SHIP_DONE_COL }) });

/** U 列の生の値(Date・Excel の文字・M/D)→ 'YYYY-MM-DD' | null。読めなければ null(でっち上げない) */
export const shipDoneYmd = (raw, today) => { const r = parseShipCell(raw, today); return r && r.ymd ? r.ymd : null; };

/** 取り込んだ行(shipDone つき)→ 組立の需要の鍵 { 組立の指図: 出庫完了日 }。U が読めない行は入れない */
export function shipDoneByOrder(rows, today) {
    const m = {};
    for (const r of rows || []) { const y = shipDoneYmd(r && r.shipDone, today); if (y && r.orderNo) m[String(r.orderNo)] = y; }
    return m;
}
