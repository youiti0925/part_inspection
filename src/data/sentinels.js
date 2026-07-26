// ============================================================================
// 保管庫に依存しない「印(番兵)」
// ----------------------------------------------------------------------------
// PocketBase移行 Phase M1 の仕上げ。
//
// これまで画面のコードは Firestore の deleteField() / serverTimestamp() を
// 直接呼んでいた。この2つは **Firebase 固有のオブジェクト** なので、
// 画面が持っていると保管庫を差し替えられない。
//
// ⚠さらに大きい理由が2つある。
//   ① Firestore の FieldValue は **IndexedDB に保存できない**(構造化複製できない)。
//      M2 のオフライン再送(送信待ちの保存を端末に貯める)で必ず詰まる。
//   ② JSON にすると中身が消えるので、送信待ちの内容を人が見て確認できない。
//
// → 印は「ただのオブジェクト」にする。JSON にしても IndexedDB に入れても壊れない。
//   Firestore 固有の値への変換は、窓口(provider.js)が保存の直前に1回だけ行う。
// ============================================================================

/** 印であることを示す目印のキー。データ側にこの名前のキーは存在しない。 */
export const SENTINEL_KEY = '__dataSentinel';

/** このキーを消す(Firestore の deleteField() 相当)。 */
export const DATA_DELETE = Object.freeze({ [SENTINEL_KEY]: 'delete' });

/** サーバ側の時刻を入れる(Firestore の serverTimestamp() 相当)。
 *  ⚠クライアントPCの Date.now() で代用しない。端末の時計は実際にずれている
 *    (この工場の開発PCは実時間より進んでいた実績がある)。 */
export const DATA_SERVER_NOW = Object.freeze({ [SENTINEL_KEY]: 'serverNow' });

/** 値が印かどうか。 */
export const isSentinel = (v) =>
  !!v && typeof v === 'object' && !Array.isArray(v) && typeof v[SENTINEL_KEY] === 'string';

/** 印の種類('delete' | 'serverNow')。印でなければ null。 */
export const sentinelKind = (v) => (isSentinel(v) ? v[SENTINEL_KEY] : null);

/**
 * 保存データの中の印を、保管庫が分かる形へ変換する。
 * @param data  保存する中身
 * @param conv  { delete: () => 任意, serverNow: () => 任意 }
 * @returns 変換後の新しいオブジェクト(元は書き換えない)
 *
 * ⚠配列の中に印があったら **その場で落とす**。Firestore は配列の要素に deleteField() を
 *   許さないし、許されたとしても「配列の何番目を消す」は意味が定まらない。
 *   素通しすると `{__dataSentinel:'delete'}` という**ただのオブジェクトが保存されて**しまい、
 *   誰も気づかないまま壊れたデータが残る。黙って別の意味にしない。
 */
export const materialize = (data, conv) => {
  const kind = sentinelKind(data);
  if (kind) {
    const f = conv && conv[kind];
    if (typeof f !== 'function') throw new Error(`materialize: 印「${kind}」の変換方法が渡されていません`);
    return f();
  }
  if (Array.isArray(data)) {
    return data.map((v, i) => {
      if (isSentinel(v)) throw new Error(`materialize: 配列の中に印は置けません(${i}番目が「${sentinelKind(v)}」)。配列は丸ごと書き換えてください。`);
      return materialize(v, conv);
    });
  }
  if (data && typeof data === 'object' && data.constructor === Object) {
    const out = {};
    for (const [k, v] of Object.entries(data)) out[k] = materialize(v, conv);
    return out;
  }
  return data;
};

/** 中身に印が1つでも入っているか(保管庫の能力チェックに使う)。 */
export const hasSentinel = (data) => {
  if (isSentinel(data)) return true;
  if (Array.isArray(data)) return data.some(hasSentinel);
  if (data && typeof data === 'object' && data.constructor === Object) {
    return Object.values(data).some(hasSentinel);
  }
  return false;
};

// ----------------------------------------------------------------------------
// 「消したキー」の受け渡し
// ----------------------------------------------------------------------------
// ⚠⚠ setDoc(merge:true) は「送らなかったキー」を消さない。
//   特注工程の削除・ロスターの出勤戻し・プリセット削除・該当なし解除は
//   全部これで、次の同期で復活していた(2026-07-26 監査確定・両本番で是正済み)。
//
// 画面は `__deleteMapKeys` に「消したキー」を書いて渡す。書き方は2通り。
//   ① 直下のキー: save('lots', id, { tasks, __deleteMapKeys: { tasks: ['s_a-0'] } })
//   ② 深い場所  : save('settings','config',{ __deleteMapKeys: [['workerRoster','2026-07-27','田中']] })
//
// ⚠パスは **配列** で扱う。ドット区切りにすると型式名(「MB-200.5」など)で壊れる。

/** 印の入れ物のキー名。 */
export const DELETE_KEYS = '__deleteMapKeys';

/**
 * `__deleteMapKeys` を本体から切り離して、消す場所のパス一覧にする。
 * @returns { body, deletePaths } deletePaths は string[][]
 */
export const splitDeletions = (raw) => {
  if (!raw || typeof raw !== 'object') return { body: raw, deletePaths: [] };
  const del = raw[DELETE_KEYS];
  if (!del || typeof del !== 'object') return { body: raw, deletePaths: [] };
  const body = { ...raw };
  delete body[DELETE_KEYS];
  const deletePaths = [];
  if (Array.isArray(del)) {
    del.forEach((p) => { if (Array.isArray(p) && p.length && p.every((s) => s !== undefined && s !== null && s !== '')) deletePaths.push(p.map(String)); });
  } else {
    Object.entries(del).forEach(([field, keys]) => {
      if (!Array.isArray(keys)) return;
      keys.forEach((k) => { if (k) deletePaths.push([String(field), String(k)]); });
    });
  }
  return { body, deletePaths };
};

/**
 * 消す場所へ印を置く。元のオブジェクトは書き換えない。
 * @param body        本体
 * @param deletePaths string[][]
 * @param sentinel    置く印(既定 DATA_DELETE)
 */
export const applyDeletePaths = (body, deletePaths, sentinel = DATA_DELETE) => {
  if (!deletePaths || !deletePaths.length) return body;
  const out = (body && typeof body === 'object' && !Array.isArray(body)) ? { ...body } : {};
  for (const path of deletePaths) {
    if (!Array.isArray(path) || !path.length) continue;
    let node = out;
    for (let i = 0; i < path.length - 1; i++) {
      const k = path[i];
      node[k] = (node[k] && typeof node[k] === 'object' && !Array.isArray(node[k])) ? { ...node[k] } : {};
      node = node[k];
    }
    node[path[path.length - 1]] = sentinel;
  }
  return out;
};

/** 画面から渡ってきた生データを「本体＋印つき」に直す(窓口の入口で1回だけ通す)。 */
export const withDeletions = (raw) => {
  const { body, deletePaths } = splitDeletions(raw);
  return applyDeletePaths(body, deletePaths);
};

// ----------------------------------------------------------------------------
// undefined の掃除
// ----------------------------------------------------------------------------
/** Firestore は undefined を保存できない。null に直す。
 *  ⚠constructor === Object の時だけ再帰する。印(凍結した素のオブジェクト)は
 *    中身がそのままコピーされるので壊れない。 */
export const cleanUndefined = (obj) => {
  if (obj === null || obj === undefined) return null;
  if (Array.isArray(obj)) return obj.map(cleanUndefined);
  if (typeof obj === 'object' && obj.constructor === Object) {
    const cleaned = {};
    for (const [k, v] of Object.entries(obj)) { if (v !== undefined) cleaned[k] = cleanUndefined(v); }
    return cleaned;
  }
  return obj;
};
