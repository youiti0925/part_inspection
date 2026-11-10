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
    // ⚠⚠ 2026-10-03 **空のマップ {} は「丸ごと {} に置き換える」**(Firestore の merge:true と同じ)。
    //   Firestore は merge の項目一覧(field mask)に「空のマップの場所」をそのまま入れるので、
    //   { tasks: {} } を merge で送ると tasks が空になる(domain/workTimeGuard.js EMPTY_MAP_REPLACES_ON_MERGE・
    //   domain/lotPatchScope.js narrowLotSave が当てにしている決まり)。前はここで再帰して何も消えず、
    //   Firebase と PocketBase で同じ保存の結果が違っていた。
    //   (2026-11-10 社内版へ移植: 最終の作業画面の保存が PocketBase で消えていた件と同じ「Firestore と違う重ね方」)
    if (isPlainMap(v) && Object.keys(v).length === 0) out[k] = {};
    else if (isPlainMap(v)) out[k] = mergeDoc(out[k], v);     // ① 入れ子は再帰
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
 *
 * ⚠⚠ 2026-10-03 **鍵の「.」は道の区切り**(Firestore の updateDoc と同じ)。
 *   ロットの保存は「押した所だけ」を { 'tasks.a-0.status': 値 } の形で送る(domain/lotPatchScope.js toUpdateFields)。
 *   前はこの鍵をそのまま1つの名前として書いていたので、PocketBase では
 *     ・本当の tasks['a-0'] は変わらない(押した記録が入らない)
 *     ・'tasks.a-0.status' という名前のゴミの項目が増える
 *   になっていた。Firestore と同じく、道をたどって **その末端だけ** を差し替える(他の台は触らない)。
 *   ・途中の段が無い/マップでない時は、空のマップを作って降りる(Firestore と同じ)
 *   ・消す印は、その末端の鍵だけを消す。途中の段が無ければ何もしない(作らない)
 *   ・元のオブジェクトは書き換えない(降りる段ごとに写す)
 * ⚠「.」を名前に含む鍵(型式名「MB-200.5」など)は、呼び出し側が点区切りにしない
 *   (toUpdateFields は断る・設定の削除は配列の道で save へ回す)。ここも Firestore と同じ前提。
 * (2026-11-10 社内版へ移植: 最終・製品の作業画面で押した工程が PocketBase に 'tasks.x-0.status' の平たい鍵で書かれ、
 *  読み直すと進捗 0% に戻っていた。golden-pb の同じ直しを持ってきた)
 */
export const setFieldsDoc = (current, fields) => {
  const out = isPlainMap(current) ? { ...current } : {};
  for (const [rawKey, v] of Object.entries(fields || {})) {
    const path = String(rawKey).split('.');
    const del = isSentinel(v) && sentinelKind(v) === 'delete';
    let node = out;
    let ok = true;
    for (let i = 0; i < path.length - 1; i++) {
      const k = path[i];
      if (isPlainMap(node[k])) node[k] = { ...node[k] };   // 段ごとに写す(元を書き換えない)
      else if (del) { ok = false; break; }                  // 消す先が無い → 何もしない
      else node[k] = {};                                    // 無い/マップでない段は作る
      node = node[k];
    }
    if (!ok) continue;
    const leaf = path[path.length - 1];
    if (del) { delete node[leaf]; continue; }
    node[leaf] = v;
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
