// ============================================================================
// Firestore と同じ「重ね方(merge)」を、保管庫の外で自分で行う
// ----------------------------------------------------------------------------
// Firestore の setDoc(merge:true) は次のように動く。**1つでも違うと現場のデータが壊れる。**
//   ① 入れ子の map は **再帰的に** 重ねる(送らなかったキーは残る)
//   ② 配列は **丸ごと差し替える**(要素ごとの合体はしない)
//   ③ map 以外の値は差し替える
//   ④ deleteField() が置かれたキーだけを消す
//
// PocketBase は中身を JSON 列に丸ごと持つので、**この重ね方を端末側で計算してから**
// 1回で書く。だから Firestore と同じ規則をここに1本だけ持つ。
//
// ⚠ここが間違うと「消したはずの特注工程が翌日復活する」類の不具合が全部戻ってくる。
//   2026-07-26 に本番で直したばかりの不具合(該当なし解除・特注削除・ロスター出勤戻し・
//   プリセット削除)は、全部この規則の取り違えが原因だった。
// ============================================================================

import { isSentinel, sentinelKind, DATA_SERVER_NOW } from './sentinels.js';

const isPlainMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && v.constructor === Object && !isSentinel(v);

/**
 * Firestore の merge:true と同じ結果を作る。
 * @param current 今サーバにある中身(無ければ null)
 * @param patch   送る差分(印を含んでよい)
 * @returns 新しいオブジェクト(元は書き換えない)
 */
export const mergeDoc = (current, patch) => {
  if (!isPlainMap(patch)) return patch;
  const out = isPlainMap(current) ? { ...current } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (isSentinel(v)) {
      if (sentinelKind(v) === 'delete') delete out[k];       // ④ そのキーだけ消す
      else out[k] = v;                                        // サーバ時刻の印はそのまま残す(サーバ側で埋める)
      continue;
    }
    if (isPlainMap(v)) out[k] = mergeDoc(out[k], v);          // ① 入れ子は再帰
    else out[k] = v;                                          // ②③ 配列とそれ以外は差し替え
  }
  return out;
};

/**
 * merge:false(全上書き)の中身を作る。
 * ⚠消す印が混ざっていたら、そのキーは最初から無いものとして書く。
 */
export const overwriteDoc = (patch) => {
  if (!isPlainMap(patch)) return patch;
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    if (isSentinel(v)) { if (sentinelKind(v) === 'delete') continue; out[k] = v; continue; }
    out[k] = isPlainMap(v) ? overwriteDoc(v) : v;
  }
  return out;
};

/**
 * Firestore の updateDoc と同じ「指定した項目を丸ごと差し替える」。
 * ⚠入れ子の合体をしない。ここが merge との違い。
 */
export const setFieldsDoc = (current, fields) => {
  const out = isPlainMap(current) ? { ...current } : {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (isSentinel(v) && sentinelKind(v) === 'delete') { delete out[k]; continue; }
    out[k] = v;
  }
  return out;
};

/**
 * サーバ時刻の印が残っている場所をすべて拾う。
 * PocketBase 側のフックが埋めるので、端末では埋めない。
 * ⚠クライアントPCの Date.now() で代用しないこと。端末の時計は実際にずれている。
 */
export const serverNowPaths = (obj, base = [], out = []) => {
  if (isSentinel(obj)) { if (sentinelKind(obj) === 'serverNow') out.push([...base]); return out; }
  if (Array.isArray(obj)) { obj.forEach((v, i) => serverNowPaths(v, [...base, String(i)], out)); return out; }
  if (isPlainMap(obj)) { for (const [k, v] of Object.entries(obj)) serverNowPaths(v, [...base, k], out); }
  return out;
};

/** 印がまだ残っているか(サーバへ送る前の確認に使う)。 */
export const hasServerNow = (obj) => serverNowPaths(obj).length > 0;

/** 見た目の確認用: 印を実際の時刻で埋めた姿を作る(**保存には使わない**)。 */
export const previewServerNow = (obj, iso) => {
  if (isSentinel(obj)) return sentinelKind(obj) === 'serverNow' ? iso : obj;
  if (Array.isArray(obj)) return obj.map((v) => previewServerNow(v, iso));
  if (isPlainMap(obj)) {
    const o = {}; for (const [k, v] of Object.entries(obj)) o[k] = previewServerNow(v, iso); return o;
  }
  return obj;
};

export { DATA_SERVER_NOW };
