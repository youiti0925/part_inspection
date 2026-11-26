// 目的: 「社内版の読んだ一覧の端末の控え」 サーバに届かない間に画面を開き直しても、前に読めた一覧(検査リスト・設定・作業者)が空にならないよう端末に残す。
// 入力: 保管庫が読めた書類(ns/col と docId・中身・版)。
// 出力: 端末の控え(IndexedDB。試験用はメモリ)から返す書類の一覧。開けない端末では null。
// 呼ぶ人: src/data/pocketbaseBackend.js。
// 触る外の物: ブラウザの IndexedDB(inspection-readcache)だけ。書き込みの失敗は画面を止めず console に1回出す。
// 確かめ方: npm test(src/data/__tests__/offlinePb.test.mjs)・社内版でサーバを切って画面を開き直し、前の一覧が出る事。
// ============================================================================
// 📴 社内版(PocketBase): 読んだ一覧の端末の控え(2026-11-02・4アプリで同じ中身)
// ----------------------------------------------------------------------------
// 何が困っていたか:
//   PocketBase の保管庫(pocketbaseBackend.js)は、読んだ中身をメモリにしか持っていなかった。
//   サーバー(社内 LAN)に届かない間に画面を開き直すと、送信待ちの箱の分しか無く、**検査リスト・設定・作業者が空**になった
//   (Firebase 版は Firestore の端末の控え persistentLocalCache があるので、切れていても前の中身が出る)。
// 形:
//   ・書類1件 = 1行(key = "ns/col|docId")。一覧を全部読めた時は、その一覧の行を全部入れ替える。
//     購読の知らせ(1件の変化)は、その1件だけ書く(大きい一覧を毎回まるごと書き直さない = タブレットを重くしない)。
//   ・開いた時は、サーバーより先にこの控えを画面へ出す(Firestore と同じ「控え → サーバー」の順)。控えは fromCache:true。
//   ⚠控えは「サーバーから読めた中身」だけ。送れていない保存(見込みの値)は入れない(それは送信待ちの箱が持つ)。
//   ⚠書き込みの失敗(容量いっぱい等)は画面を止めない。console に1回だけ出す。
// ⚠DOM も firebase も import しない(Node の試験で読めるように)。
// ============================================================================

export const READ_CACHE_DB = 'inspection-readcache';
export const READ_CACHE_STORE = 'docs';
const SEP = '|';

/** 試験用(メモリ)。 */
export const createMemoryReadCache = () => {
  const m = new Map();   // key -> { k, docId, data, rev }
  return {
    kind: 'memory',
    replaceAll: async (k, entries) => {
      for (const key of [...m.keys()]) if (key.startsWith(k + SEP)) m.delete(key);
      for (const [docId, data, rev] of entries) m.set(k + SEP + docId, { k, docId, data, rev });
    },
    putDoc: async (k, docId, data, rev) => { m.set(k + SEP + docId, { k, docId, data, rev }); },
    delDoc: async (k, docId) => { m.delete(k + SEP + docId); },
    getAll: async (k) => [...m.values()].filter((r) => r.k === k).map((r) => [r.docId, r.data, r.rev]),
    _size: () => m.size,
  };
};

/** IndexedDB の控え。⚠開けない端末(使えない・壊れた)は null を返す物になる(呼ぶ側は「控え無し」で進む)。 */
export const createIdbReadCache = ({ dbName = READ_CACHE_DB, idb = (typeof indexedDB !== 'undefined' ? indexedDB : null) } = {}) => {
  if (!idb) return null;
  let dbp = null;
  let warned = false;
  const warn = (e) => { if (!warned) { warned = true; console.warn('[pb] 端末の控えに書けません(画面は動きます)', (e && e.message) || e); } };
  const open = () => {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = idb.open(dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(READ_CACHE_STORE)) {
          const os = db.createObjectStore(READ_CACHE_STORE, { keyPath: 'key' });
          os.createIndex('k', 'k');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbp.catch(() => { dbp = null; });
    return dbp;
  };
  const tx = (mode, fn) => open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(READ_CACHE_STORE, mode);
    const os = t.objectStore(READ_CACHE_STORE);
    let out;
    try { out = fn(os); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
  return {
    kind: 'indexeddb',
    replaceAll: (k, entries) => tx('readwrite', (os) => {
      os.delete(IDBKeyRange.bound(k + SEP, k + SEP + '￿'));
      for (const [docId, data, rev] of entries) os.put({ key: k + SEP + docId, k, docId, data, rev });
    }).catch(warn),
    putDoc: (k, docId, data, rev) => tx('readwrite', (os) => { os.put({ key: k + SEP + docId, k, docId, data, rev }); }).catch(warn),
    delDoc: (k, docId) => tx('readwrite', (os) => { os.delete(k + SEP + docId); }).catch(warn),
    getAll: (k) => tx('readonly', (os) => os.index('k').getAll(k))
      .then((rows) => (rows || []).map((r) => [r.docId, r.data, r.rev]), () => []),
  };
};
